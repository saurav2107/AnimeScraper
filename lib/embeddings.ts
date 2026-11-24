import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getImage } from "./imgproxy";

// Image features for "search by photo": a CLIP embedding (what the picture shows, independent of backdrop and camera)
// plus a hue histogram of the saturated pixels (paint colours). The model runs on this machine; photos never leave it.
// The model weights (~90 MB) are downloaded from Hugging Face the first time and kept under data/models.

const MODEL = "Xenova/clip-vit-base-patch32";
const DIM = 512;
const HUE_BINS = 24;

export interface Features { clip: Float32Array; hue: Float32Array }

const modelDir = () => process.env.MODEL_CACHE_DIR || path.join(process.cwd(), "data", "models");
const featDir = () => process.env.EMB_CACHE_DIR || path.join(process.cwd(), "data", "emb-cache");

let loading: Promise<{ processor: any; model: any; RawImage: any; sharp: any }> | null = null;
function loadModel() {
  loading ??= (async () => {
    const tf: any = await import("@huggingface/transformers");
    const sharp: any = ((await import("sharp")) as any).default ?? (await import("sharp"));
    tf.env.cacheDir = modelDir();
    const processor = await tf.AutoProcessor.from_pretrained(MODEL);
    const model = await tf.CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: "q8" });
    return { processor, model, RawImage: tf.RawImage, sharp };
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

/** True when the CLIP model can be loaded (downloads it on first use). */
export async function embeddingsAvailable(): Promise<boolean> {
  if (process.env.PHOTO_ENGINE === "basic") return false;
  try { await loadModel(); return true; } catch { return false; }
}

export function hueHistogram(rgb: Uint8Array | Buffer, step = 3): Float32Array {
  const bins = new Float32Array(HUE_BINS);
  let total = 0;
  for (let i = 0; i + 2 < rgb.length; i += step) {
    const r = rgb[i] / 255, g = rgb[i + 1] / 255, b = rgb[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (mx < 0.15 || d / (mx || 1) < 0.35) continue;
    let h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    const w = d / (mx || 1);
    bins[Math.floor(h / (360 / HUE_BINS)) % HUE_BINS] += w; total += w;
  }
  if (total) for (let i = 0; i < HUE_BINS; i++) bins[i] /= total;
  return bins;
}

// Serialise model calls: one ONNX session, and it keeps CPU use predictable.
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => undefined); return p; };

export async function featuresFromBuffer(buf: Buffer): Promise<Features> {
  const { processor, model, RawImage, sharp } = await loadModel();
  const small = await sharp(buf, { failOn: "none" }).flatten({ background: "#ffffff" }).removeAlpha();
  const { data, info } = await small.raw().toBuffer({ resolveWithObject: true });
  const hue = hueHistogram(await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).resize(64, 64, { fit: "cover" }).raw().toBuffer());
  const clip = await serial(async () => {
    const out = await model(await processor(new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3)));
    const v = Float32Array.from(out.image_embeds.data as Float32Array);
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  });
  return { clip, hue };
}

const mem = new Map<string, Features | null>();
const keyOf = (url: string) => createHash("sha256").update(url).digest("hex");

function readCached(url: string): Features | null {
  try {
    const b = fs.readFileSync(path.join(featDir(), keyOf(url) + ".f32"));
    if (b.length !== (DIM + HUE_BINS) * 4) return null;
    const all = new Float32Array(b.buffer, b.byteOffset, DIM + HUE_BINS).slice();
    return { clip: all.slice(0, DIM), hue: all.slice(DIM) };
  } catch { return null; }
}

export function cachedFeatures(url: string): Features | null | undefined {
  if (mem.has(url)) return mem.get(url);
  const c = readCached(url);
  if (c) mem.set(url, c);
  return c ?? undefined;
}

/** Features for a supplier image URL (disk-cached). Null if the image can't be fetched or decoded. */
export async function featuresForUrl(url: string): Promise<Features | null> {
  const hit = cachedFeatures(url);
  if (hit !== undefined) return hit;
  let f: Features | null = null;
  try {
    f = await featuresFromBuffer((await getImage(url)).buf);
    try {
      fs.mkdirSync(featDir(), { recursive: true });
      const all = new Float32Array(DIM + HUE_BINS); all.set(f.clip); all.set(f.hue, DIM);
      fs.writeFileSync(path.join(featDir(), keyOf(url) + ".f32"), Buffer.from(all.buffer));
    } catch { /* caching is best-effort */ }
  } catch { f = null; }
  mem.set(url, f);
  return f;
}

/** Combined similarity (higher = closer). Hue breaks ties between figures of the same shape but different paint. */
export function similarity(q: Features, p: Features): number {
  let dot = 0; for (let i = 0; i < DIM; i++) dot += q.clip[i] * p.clip[i];
  let hue = 0; for (let i = 0; i < HUE_BINS; i++) hue += Math.min(q.hue[i], p.hue[i]);
  return dot + 0.4 * hue;
}
/** Map the combined score to a 0..1 "how similar" figure for display. 1.25+ is a near-identical picture. */
export const toPercent = (s: number) => Math.max(0, Math.min(1, (s - 0.85) / 0.4));

// Background indexing: product photos not yet embedded are processed after the search returns, so the next search is complete.
const pending = new Set<string>();
let worker: Promise<void> | null = null;
export function indexInBackground(urls: string[]) {
  for (const u of urls) if (cachedFeatures(u) === undefined) pending.add(u);
  if (worker || !pending.size) return;
  worker = (async () => {
    for (let n = 0; pending.size && n < 20000; n++) {
      const u = pending.values().next().value as string; pending.delete(u);
      await featuresForUrl(u);
    }
  })().finally(() => { worker = null; });
}
export const indexingBacklog = () => pending.size;
