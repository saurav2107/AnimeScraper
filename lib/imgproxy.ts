import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPublicHost } from "./util";

// Supplier CDNs rate-limit (HTTP 429) or hotlink-protect when a page asks for dozens of thumbnails at once, which left
// blank cells in the grid. Images are fetched through this server instead: few at a time, retried, and cached on disk.

const MAX_BYTES = 8 * 1024 * 1024;
const CONCURRENCY = 4;
const NEG_TTL_MS = 60_000;
const UA = "AnimeCartelSupplierIntelligence/1.0 (internal price comparison)";

export interface ImgDeps {
  fetchImpl?: typeof fetch;
  cacheDir?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class ImageError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const defaultDir = () => process.env.IMG_CACHE_DIR || path.join(process.cwd(), "data", "img-cache");
const keyOf = (url: string) => createHash("sha256").update(url).digest("hex");

let active = 0;
const waiters: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= CONCURRENCY) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

const inflight = new Map<string, Promise<{ buf: Buffer; type: string }>>();
const failed = new Map<string, { at: number; err: ImageError }>();

export function validateImageUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ImageError(400, "Invalid image URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ImageError(400, "Only http(s) images are supported");
  if (!isPublicHost(u.hostname)) throw new ImageError(400, "Not a public host");
  return u;
}

async function download(url: string, deps: ImgDeps): Promise<{ buf: Buffer; type: string }> {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    let cur = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      validateImageUrl(cur);
      res = await f(cur, { headers: { "user-agent": UA, accept: "image/*" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) { cur = new URL(loc, cur).toString(); continue; }
      break;
    }
    if (!res) throw new ImageError(502, "No response");
    lastStatus = res.status;
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 400 * 2 ** attempt, 5000));
      continue;
    }
    if (!res.ok) throw new ImageError(404, `Upstream returned ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/") || type.includes("svg")) throw new ImageError(415, "Not a supported image");
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) throw new ImageError(413, "Image too large");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new ImageError(413, "Image too large");
    return { buf, type };
  }
  throw new ImageError(lastStatus === 429 ? 429 : 502, `Upstream kept failing (${lastStatus})`);
}

/** Return the image bytes for a supplier image URL, from the disk cache when possible. */
export async function getImage(url: string, deps: ImgDeps = {}): Promise<{ buf: Buffer; type: string }> {
  validateImageUrl(url);
  const dir = deps.cacheDir ?? defaultDir();
  const key = keyOf(url);
  const file = path.join(dir, key);
  try {
    const meta = JSON.parse(fs.readFileSync(file + ".json", "utf8")) as { type: string };
    return { buf: fs.readFileSync(file), type: meta.type };
  } catch {
    /* not cached */
  }
  const bad = failed.get(key);
  if (bad && Date.now() - bad.at < NEG_TTL_MS) throw bad.err;
  let p = inflight.get(key);
  if (!p) {
    p = slot(() => download(url, deps))
      .then((r) => {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(file, r.buf);
          fs.writeFileSync(file + ".json", JSON.stringify({ type: r.type, url }));
        } catch {
          /* caching is best-effort */
        }
        return r;
      })
      .catch((e) => {
        failed.set(key, { at: Date.now(), err: e instanceof ImageError ? e : new ImageError(502, (e as Error).message) });
        throw e;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

export function clearImageFailures() {
  failed.clear();
}
