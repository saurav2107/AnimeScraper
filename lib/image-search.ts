import { z } from "zod";
import type { DB } from "@/db";
import { badRequest, notFound } from "./errors";
import { cachedFeatures, embeddingsAvailable, featuresForUrl, featuresFromBuffer, indexInBackground, indexingBacklog, similarity, toPercent } from "./embeddings";
import { imageSig, loadSharp, photoSim, sigFromBuffer } from "./merge-scan";
import { listingImages } from "./products";
import { httpUrl } from "./util";

// Search by photo: READ-ONLY. Compares an uploaded picture with the product photos of one category and returns the
// closest products. Nothing is stored and no product is changed; dismissing a result is a view-only choice in the browser.

const MAX_BYTES = 6 * 1024 * 1024;
const BUDGET_MS = 45_000;
const MIN_SCORE = 0.5;
const MIN_CLIP_PERCENT = 0.3;
const MAX_RESULTS = 40;

const body = z.object({ categoryId: z.string().min(1, "Missing category."), image: z.string().min(1, "Choose a photo.") });

export interface PhotoMatch { id: string; score: number; bits: number }

export async function searchByPhoto(db: DB, input: unknown, opts: { budgetMs?: number; sharp?: any | null; engine?: "clip" | "basic" } = {}) {
  const t0 = Date.now();
  const parsed = body.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid request.");
  const cat = db.prepare("SELECT id, name FROM categories WHERE id = ? AND deleted_at IS NULL").get(parsed.data.categoryId) as { id: string; name: string } | undefined;
  if (!cat) throw notFound("Category not found.");

  const b64 = parsed.data.image.replace(/^data:[^,]*,/, "");
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw badRequest("That file couldn't be read as an image.");
  if (buf.length > MAX_BYTES) throw badRequest("That photo is too large. Use one under 6 MB.");
  const useClip = opts.engine !== "basic" && (await embeddingsAvailable());
  const sharp = opts.sharp === undefined ? await loadSharp() : opts.sharp;
  let qf: Awaited<ReturnType<typeof featuresFromBuffer>> | null = null;
  let query: Awaited<ReturnType<typeof sigFromBuffer>> | null = null;
  if (useClip) {
    try { qf = await featuresFromBuffer(buf); } catch { throw badRequest("That file isn't a supported image (use JPG, PNG or WebP)."); }
  } else {
    if (!sharp) throw badRequest("Photo search isn't available on this server.");
    try { query = await sigFromBuffer(buf, sharp); } catch { throw badRequest("That file isn't a supported image (use JPG, PNG or WebP)."); }
  }

  const groups = db.prepare("SELECT id, image FROM groups WHERE category_id = ? AND status = 'Active'").all(cat.id) as Array<{ id: string; image: string | null }>;
  const ls = db.prepare(
    `SELECT l.group_id AS gid, l.image, l.raw FROM listings l JOIN suppliers s ON s.id = l.supplier_id AND s.status != 'Deleted'
     WHERE l.status != 'REMOVED' AND l.group_id IN (SELECT id FROM groups WHERE category_id = ? AND status = 'Active') ORDER BY l.created, l.id`,
  ).all(cat.id) as Array<{ gid: string; image: string | null; raw: string | null }>;
  const byGroup = new Map<string, typeof ls>();
  for (const l of ls) (byGroup.get(l.gid) ?? byGroup.set(l.gid, []).get(l.gid)!).push(l);
  const images = new Map<string, string[]>();
  for (const g of groups) {
    const urls: string[] = [];
    const first = httpUrl(g.image);
    if (first) urls.push(first);
    for (const l of byGroup.get(g.id) ?? []) { const u = listingImages(l.image, l.raw)[0]; if (u && !urls.includes(u)) urls.push(u); }
    images.set(g.id, urls.slice(0, useClip ? 2 : 3));
  }

  if (useClip && qf) {
    // Embed product photos not seen before within the time budget; the rest continue in the background.
    const all = [...new Set([...images.values()].flat())];
    const todo = all.filter((u) => cachedFeatures(u) === undefined);
    const queue = [...todo];
    const budget = opts.budgetMs ?? 25_000;
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let u = queue.shift(); u; u = queue.shift()) {
        if (Date.now() - t0 > budget) { queue.unshift(u); return; }
        await featuresForUrl(u);
      }
    }));
    if (queue.length) indexInBackground(queue);
    const found: PhotoMatch[] = [];
    for (const [id, urls] of images) {
      let best = -1;
      for (const u of urls) { const f = cachedFeatures(u); if (f) best = Math.max(best, similarity(qf, f)); }
      const pct = best < 0 ? 0 : toPercent(best);
      if (pct >= MIN_CLIP_PERCENT) found.push({ id, score: Math.round(pct * 100) / 100, bits: 0 });
    }
    found.sort((a, b) => b.score - a.score);
    return { engine: "clip" as const, category: cat, searched: images.size, partial: queue.length > 0, remaining: queue.length + indexingBacklog(), matches: found.slice(0, MAX_RESULTS), tookMs: Date.now() - t0 };
  }
  if (!sharp || !query) throw badRequest("Photo search isn't available on this server.");

  const all = [...new Set([...images.values()].flat())];
  const queue = [...all];
  let cut = false;
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      if (Date.now() - t0 > (opts.budgetMs ?? BUDGET_MS)) { cut = true; queue.length = 0; return; }
      await imageSig(u, sharp);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const matches: PhotoMatch[] = [];
  for (const [id, urls] of images) {
    let best: { sim: number; bits: number } | null = null;
    for (const u of urls) {
      const sig = await imageSig(u, sharp); // cached by now
      if (!sig) continue;
      const r = photoSim(query!, sig);
      if (!best || r.sim > best.sim) best = r;
    }
    if (best && best.sim >= MIN_SCORE) matches.push({ id, score: Math.round(best.sim * 100) / 100, bits: best.bits });
  }
  matches.sort((a, b) => b.score - a.score);
  return { engine: "basic" as const, category: cat, searched: images.size, partial: cut, remaining: 0, matches: matches.slice(0, MAX_RESULTS), tookMs: Date.now() - t0 };
}
