import { createHash } from "node:crypto";
import type { DB } from "@/db";
import { notFound } from "./errors";
import { getImage } from "./imgproxy";
import { listingImages } from "./products";
import { extractSize, sizeSortKey } from "./size";
import { httpUrl } from "./util";

// Merge scan: READ-ONLY. It compares the active products of one category and proposes groups that look like the same
// figure. It never merges; the operator reviews each suggestion and merges through the normal Merge dialog.
//
// Signals: character/name tokens (idf-weighted), style/edition words, size, and the product photos
// (perceptual hash for shape + coarse colour signature for paint scheme).

const STOP = new Set(("figure figures figurine action anime statue statues pvc scale model collectible collectibles official original authentic new toy toys doll " +
  "with the of and for in a an by from set pack piece pcs pc cm mm inch inches height tall approx approximately free shipping buy online india").split(" "));
/** Words that mark a different edition/pose/paint. Present on only one side => probably a different product. */
const STYLE = new Set(("ssj ssg ssb super saiyan god blue rose ultra instinct mastered awakened awakening ver version v2 v3 dx deluxe special limited exclusive " +
  "battle damage damaged ex evolution bankai hollow gear black white gold golden red silver dark light chrome metallic clear glow glowing " +
  "bust chibi mini sd flat resin 2nd second third final form base normal").split(" "));

export const normaliseName = (name: string): string[] => {
  const cleaned = name.toLowerCase()
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:cm|mm|inch(?:es)?|in)\b/g, " ")
    .replace(/\b1\s*[:/]\s*\d{1,3}\b/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ");
  return [...new Set(cleaned.split(" ").filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t)))];
};

/** Standalone numbers left after sizes are removed: "Gear 5", "No.2", model codes. Different numbers => different item. */
export const nameNumbers = (name: string): Set<string> =>
  new Set(name.toLowerCase().replace(/\b\d+(?:[.,]\d+)?\s*(?:cm|mm|inch(?:es)?|in)\b/g, " ").replace(/\b1\s*[:/]\s*\d{1,3}\b/g, " ").match(/\b\d+\b/g) ?? []);

// ---------- image signatures ----------
export interface ImgSig { hash: bigint; color: number[] }
const sigCache = new Map<string, ImgSig | null>();

export async function loadSharp(): Promise<any | null> {
  try {
    const m: any = await import("sharp");
    return m.default ?? m;
  } catch {
    return null;
  }
}

export async function sigFromBuffer(buf: Buffer, sharp: any): Promise<ImgSig> {
  const base = () => sharp(buf, { failOn: "none" }).flatten({ background: "#ffffff" });
  const g = await base().greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash = (hash << 1n) | (g[y * 9 + x] < g[y * 9 + x + 1] ? 1n : 0n);
  const c = await base().resize(4, 4, { fit: "fill" }).removeAlpha().raw().toBuffer();
  return { hash, color: [...c] };
}

export async function imageSig(url: string, sharp: any): Promise<ImgSig | null> {
  if (sigCache.has(url)) return sigCache.get(url)!;
  let sig: ImgSig | null = null;
  try {
    sig = await sigFromBuffer((await getImage(url)).buf, sharp);
  } catch {
    sig = null;
  }
  sigCache.set(url, sig);
  return sig;
}

const popcount = (x: bigint) => { let n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };
export const hashBits = (a: ImgSig, b: ImgSig) => popcount(a.hash ^ b.hash);
const colorDiff = (a: ImgSig, b: ImgSig) => a.color.reduce((s, v, i) => s + Math.abs(v - b.color[i]), 0) / a.color.length;

/** 0..1 similarity of two photos. */
export function photoSim(a: ImgSig, b: ImgSig): { sim: number; bits: number } {
  const bits = hashBits(a, b);
  const shape = Math.max(0, Math.min(1, (24 - bits) / 18)); // <=6 bits apart => 1, >=24 => 0
  const colour = Math.max(0, Math.min(1, 1 - colorDiff(a, b) / 70));
  return { sim: 0.7 * shape + 0.3 * colour, bits };
}

// ---------- scoring ----------
interface Prod {
  id: string; name: string; image: string | null; sizeValue: string | null;
  tokens: string[]; style: Set<string>; nums: Set<string>; images: string[]; sigs: ImgSig[];
  suppliers: Map<string, string>; listingCount: number; minPrice: number | null; currency: string | null;
}

export interface Reason { label: "Name" | "Image" | "Size" | "Style" | "Supplier"; level: "good" | "warn" | "neutral"; detail: string }
export interface PairScore { score: number; name: number; image: number | null; size: number | null; reasons: Reason[] }

export function scorePair(a: Prod, b: Prod, idf: Map<string, number>): PairScore {
  const w = (t: string) => idf.get(t) ?? 1;
  const sa = new Set(a.tokens), sb = new Set(b.tokens);
  const common = a.tokens.filter((t) => sb.has(t));
  const wc = common.reduce((s, t) => s + w(t), 0);
  const wa = a.tokens.reduce((s, t) => s + w(t), 0), wb = b.tokens.reduce((s, t) => s + w(t), 0);
  // dice rewards equal-length names; containment forgives a supplier adding words like a franchise name
  const name = wa + wb > 0 ? 0.5 * ((2 * wc) / (wa + wb)) + 0.5 * (wc / Math.min(wa, wb)) : 0;

  const reasons: Reason[] = [];
  reasons.push({ label: "Name", level: name >= 0.7 ? "good" : name >= 0.45 ? "neutral" : "warn", detail: common.length ? `Shared: ${common.slice(0, 6).join(", ")} (${Math.round(name * 100)}% match)` : "No shared words" });

  let image: number | null = null;
  if (a.sigs.length && b.sigs.length) {
    let best = { sim: 0, bits: 64 };
    for (const x of a.sigs) for (const y of b.sigs) { const r = photoSim(x, y); if (r.sim > best.sim) best = r; }
    image = best.sim;
    reasons.push({ label: "Image", level: image >= 0.8 ? "good" : image >= 0.55 ? "neutral" : "warn", detail: image >= 0.8 ? `Photos look near-identical (${best.bits}/64 bits differ)` : image >= 0.55 ? `Photos look similar (${best.bits}/64 bits differ)` : `Photos look different (${best.bits}/64 bits differ)` });
  }

  let size: number | null = null;
  const ka = sizeSortKey(a.sizeValue), kb = sizeSortKey(b.sizeValue);
  if (ka != null && kb != null && ka > 0 && kb > 0) {
    const ratio = Math.min(ka, kb) / Math.max(ka, kb);
    size = ratio >= 0.95 ? 1 : ratio <= 0.8 ? 0 : (ratio - 0.8) / 0.15;
    reasons.push({ label: "Size", level: size >= 0.95 ? "good" : size > 0 ? "neutral" : "warn", detail: size >= 0.95 ? `Same size (${a.sizeValue})` : `Sizes differ (${a.sizeValue} vs ${b.sizeValue})` });
  }

  let total = (0.5 * name + (image != null ? 0.35 * image : 0) + (size != null ? 0.15 * size : 0)) / (0.5 + (image != null ? 0.35 : 0) + (size != null ? 0.15 : 0));

  // different edition / paint / pose words on only one side
  const onlyA = [...a.style].filter((t) => !b.style.has(t)), onlyB = [...b.style].filter((t) => !a.style.has(t));
  const diff = [...new Set([...onlyA, ...onlyB])];
  if (diff.length) {
    total *= Math.max(0.55, 1 - 0.15 * diff.length);
    reasons.push({ label: "Style", level: "warn", detail: `Only one name mentions: ${diff.slice(0, 5).join(", ")}` });
  }
  // each name has its own distinctive word the other lacks (e.g. two different characters)
  const rare = (t: string) => (idf.get(t) ?? 0) >= 2.2 && !STYLE.has(t);
  const ua = a.tokens.filter((t) => !sb.has(t) && rare(t)), ub = b.tokens.filter((t) => !sa.has(t) && rare(t));
  if (ua.length && ub.length) {
    total *= 0.75;
    reasons.push({ label: "Name", level: "warn", detail: `Different distinctive words: ${ua[0]} vs ${ub[0]}` });
  }
  const numDiff = [...a.nums].filter((n) => !b.nums.has(n)).concat([...b.nums].filter((n) => !a.nums.has(n)));
  if (numDiff.length && a.nums.size && b.nums.size) {
    total *= 0.75;
    reasons.push({ label: "Name", level: "warn", detail: `Different numbers in the names: ${numDiff.slice(0, 4).join(", ")}` });
  }
  if (image == null) total *= 0.9; // names alone are weaker evidence than names plus matching photos
  if (size === 0) total *= 0.5; // clearly different sizes are different products

  const sameOnly = a.suppliers.size === 1 && b.suppliers.size === 1 && [...a.suppliers.keys()][0] === [...b.suppliers.keys()][0];
  if (sameOnly) {
    total *= 0.7;
    reasons.push({ label: "Supplier", level: "warn", detail: `Both only listed by ${[...a.suppliers.values()][0]}, so they may be two distinct items` });
  }
  return { score: Math.max(0, Math.min(1, total)), name, image, size, reasons };
}

export const THRESHOLD = 0.6;
const MAX_CLUSTER = 8;
const IMAGE_BUDGET_MS = 45_000;
const MAX_PRODUCTS = 6000;

export interface Suggestion {
  id: string;
  confidence: "High" | "Medium" | "Low";
  score: number;
  products: Array<{ id: string; name: string; image: string | null; size: string | null; suppliers: string[]; listings: number; price: number | null; currency: string | null }>;
  reasons: Reason[];
}

export interface ScanResult {
  category: { id: string; name: string };
  scanned: number;
  imagesChecked: number;
  imagesTotal: number;
  imageAnalysis: "full" | "partial" | "off";
  suggestions: Suggestion[];
  tookMs: number;
}

export async function scanMerges(db: DB, categoryId: string | undefined, opts: { budgetMs?: number; sharp?: any | null } = {}): Promise<ScanResult> {
  const t0 = Date.now();
  const cat = db.prepare("SELECT id, name, size_kind AS sizeKind FROM categories WHERE id = ?").get(categoryId ?? "") as { id: string; name: string; sizeKind: any } | undefined;
  if (!cat) throw notFound("Category not found.");

  const groups = db.prepare("SELECT id, name, image, size_value AS sizeValue FROM groups WHERE category_id = ? AND status = 'Active' ORDER BY name LIMIT ?").all(cat.id, MAX_PRODUCTS) as any[];
  const ls = db.prepare(
    `SELECT l.group_id AS gid, l.image, l.raw, l.price, l.currency, l.stock, l.supplier_id AS sid, s.name AS sname, l.size_value AS lsize
     FROM listings l JOIN suppliers s ON s.id = l.supplier_id AND s.status != 'Deleted'
     WHERE l.status != 'REMOVED' AND l.group_id IN (SELECT id FROM groups WHERE category_id = ? AND status = 'Active') ORDER BY l.created, l.id`,
  ).all(cat.id) as any[];
  const byGroup = new Map<string, any[]>();
  for (const l of ls) (byGroup.get(l.gid) ?? byGroup.set(l.gid, []).get(l.gid)!).push(l);

  const prods: Prod[] = groups.map((g) => {
    const mine = byGroup.get(g.id) ?? [];
    const toks = normaliseName(g.name);
    const imgs: string[] = [];
    const first = httpUrl(g.image);
    if (first) imgs.push(first);
    for (const l of mine) { const u = listingImages(l.image, l.raw)[0]; if (u && !imgs.includes(u)) imgs.push(u); }
    const priced = mine.filter((l) => l.price != null && l.stock !== "Out of stock").map((l) => l.price as number);
    return {
      id: g.id, name: g.name, image: imgs[0] ?? null,
      sizeValue: g.sizeValue ?? mine.map((l) => l.lsize).find(Boolean) ?? extractSize(cat.sizeKind, [g.name]) ?? null,
      tokens: toks, nums: nameNumbers(g.name), style: new Set(toks.filter((t) => STYLE.has(t))),
      images: imgs.slice(0, 3), sigs: [],
      suppliers: new Map(mine.map((l) => [l.sid, l.sname])), listingCount: mine.length,
      minPrice: priced.length ? Math.min(...priced) : null, currency: mine.find((l) => l.currency)?.currency ?? null,
    };
  });

  // idf over this category
  const df = new Map<string, number>();
  for (const p of prods) for (const t of new Set(p.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [t, n] of df) idf.set(t, Math.log(1 + prods.length / n));

  // image signatures within a time budget (disk-cached images are fast; first scan may download)
  const sharp = opts.sharp === undefined ? await loadSharp() : opts.sharp;
  const urls = [...new Set(prods.flatMap((p) => p.images))];
  let checked = 0;
  let cut = false;
  if (sharp) {
    const budget = opts.budgetMs ?? IMAGE_BUDGET_MS;
    const queue = [...urls];
    const worker = async () => {
      for (let u = queue.shift(); u; u = queue.shift()) {
        if (Date.now() - t0 > budget) { cut = true; queue.length = 0; return; }
        if (await imageSig(u, sharp)) checked++;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    for (const p of prods) p.sigs = p.images.map((u) => sigCache.get(u)).filter((x): x is ImgSig => !!x);
  }

  // candidate pairs: share a reasonably rare token, or share a perceptual-hash band
  const pairKey = (i: number, j: number) => (i < j ? `${i}|${j}` : `${j}|${i}`);
  const cand = new Set<string>();
  const addBucket = (m: Map<string, number[]>, cap: number) => {
    for (const idx of m.values()) {
      if (idx.length < 2 || idx.length > cap) continue;
      for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) cand.add(pairKey(idx[a], idx[b]));
    }
  };
  const tokIdx = new Map<string, number[]>();
  prods.forEach((p, i) => p.tokens.forEach((t) => (tokIdx.get(t) ?? tokIdx.set(t, []).get(t)!).push(i)));
  addBucket(tokIdx, 60);
  const bandIdx = new Map<string, number[]>();
  prods.forEach((p, i) => p.sigs.forEach((s) => { for (let b = 0; b < 4; b++) { const k = `${b}:${(s.hash >> BigInt(b * 16)) & 0xffffn}`; const arr = bandIdx.get(k) ?? bandIdx.set(k, []).get(k)!; if (arr[arr.length - 1] !== i) arr.push(i); } }));
  addBucket(bandIdx, 40);

  const cache = new Map<string, PairScore>();
  const pair = (i: number, j: number) => {
    const k = pairKey(i, j);
    let r = cache.get(k);
    if (!r) cache.set(k, (r = scorePair(prods[i], prods[j], idf)));
    return r;
  };
  const edges: Array<{ i: number; j: number; s: number }> = [];
  for (const k of cand) {
    const [i, j] = k.split("|").map(Number);
    const r = pair(i, j);
    if (r.score >= THRESHOLD && (r.name >= 0.2 || (r.image ?? 0) >= 0.9)) edges.push({ i, j, s: r.score });
  }
  edges.sort((a, b) => b.s - a.s);

  // complete-linkage clustering so A~B and B~C never drag in an unrelated A/C pair
  const cluster = prods.map((_, i) => [i]);
  const owner = prods.map((_, i) => i);
  for (const e of edges) {
    const ca = owner[e.i], cb = owner[e.j];
    if (ca === cb) continue;
    const A = cluster[ca], B = cluster[cb];
    if (A.length + B.length > MAX_CLUSTER) continue;
    if (!A.every((x) => B.every((y) => pair(x, y).score >= THRESHOLD))) continue;
    for (const y of B) owner[y] = ca;
    cluster[ca] = A.concat(B);
    cluster[cb] = [];
  }

  const suggestions: Suggestion[] = [];
  for (const members of cluster) {
    if (members.length < 2) continue;
    const pairs: Array<[number, number]> = [];
    for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) pairs.push([members[a], members[b]]);
    const scores = pairs.map(([x, y]) => pair(x, y));
    const weakest = Math.min(...scores.map((r) => r.score));
    const avg = scores.reduce((s, r) => s + r.score, 0) / scores.length;
    const lead = scores.reduce((a, b) => (b.score > a.score ? b : a)); // reasons from the strongest pair
    const ids = members.map((m) => prods[m].id).sort();
    suggestions.push({
      id: createHash("sha1").update(ids.join(",")).digest("hex").slice(0, 16),
      confidence: weakest >= 0.8 ? "High" : weakest >= 0.7 ? "Medium" : "Low",
      score: Math.round(avg * 100) / 100,
      products: members.map((m) => {
        const p = prods[m];
        return { id: p.id, name: p.name, image: p.image, size: p.sizeValue, suppliers: [...p.suppliers.values()], listings: p.listingCount, price: p.minPrice, currency: p.currency };
      }),
      reasons: lead.reasons,
    });
  }
  suggestions.sort((a, b) => b.score - a.score || b.products.length - a.products.length);

  return {
    category: { id: cat.id, name: cat.name }, scanned: prods.length, imagesChecked: checked, imagesTotal: urls.length,
    imageAnalysis: !sharp ? "off" : cut ? "partial" : "full",
    suggestions, tookMs: Date.now() - t0,
  };
}
