import { createHash } from "node:crypto";
import { z } from "zod";
import type { DB } from "@/db";
import { badRequest, conflict, notFound, zodError } from "./errors";
import { listingImages } from "./products";
import { audit, httpUrl, now, placeholders, uid } from "./util";

const mergeBody = z.object({
  productIds: z.array(z.string()).min(2, "Select at least two products to merge."),
  name: z.string().transform((s) => s.trim()).pipe(z.string().min(1, "Enter a name.").max(200, "Name must be 200 characters or fewer.")),
  image: z.string().nullable(),
  note: z.string().max(500, "Note must be 500 characters or fewer.").optional(),
});

export function mergeProducts(db: DB, input: unknown): { mergeEventId: string; productId: string } {
  const parsed = mergeBody.safeParse(input);
  if (!parsed.success) throw zodError(parsed.error);
  const v = parsed.data;
  const ids = [...new Set(v.productIds)];
  if (ids.length < 2) throw badRequest("Select at least two distinct products to merge.");

  return db.transaction(() => {
    const groups = db.prepare(`SELECT id, status, category_id AS categoryId, image, size_value AS sizeValue FROM groups WHERE id IN (${placeholders(ids.length)})`).all(...ids) as any[];
    if (groups.length !== ids.length) throw notFound("One or more products were not found.");
    if (new Set(groups.map((g) => g.categoryId)).size > 1) throw conflict("Products from different categories can't be merged.");
    if (groups.some((g) => g.status !== "Active")) throw conflict("One or more selected products have changed. Refresh and try again.");
    const categoryId = groups[0].categoryId as string;

    const ls = db.prepare(`SELECT id, group_id, image, raw FROM listings WHERE group_id IN (${placeholders(ids.length)})`).all(...ids) as any[];
    if (v.image !== null) {
      const allowed = new Set<string>();
      for (const g of groups) if (httpUrl(g.image)) allowed.add(httpUrl(g.image)!);
      for (const l of ls) listingImages(l.image, l.raw).forEach((u) => allowed.add(u));
      const img = httpUrl(v.image);
      if (!img || !allowed.has(img)) throw badRequest("The chosen image isn't one of the selected products' images.");
      v.image = img;
    }

    const t = now();
    const resultId = uid();
    const eventId = uid();
    // a size typed in on any selected product carries over to the merged one (first selected wins)
    const carriedSize = ids.map((id) => groups.find((g) => g.id === id)?.sizeValue).find((x) => x) ?? null;
    db.prepare("INSERT INTO groups (id, category_id, name, image, size_value, status, created) VALUES (?,?,?,?,?,?,?)").run(resultId, categoryId, v.name, v.image, carriedSize, "Active", t);
    db.prepare("INSERT INTO merge_events (id, category_id, result_group_id, name, image, note, created) VALUES (?,?,?,?,?,?,?)").run(eventId, categoryId, resultId, v.name, v.image, v.note?.trim() || null, t);
    const insSrc = db.prepare("INSERT INTO merge_event_sources (merge_event_id, source_group_id) VALUES (?,?)");
    ids.forEach((id) => insSrc.run(eventId, id));
    const insL = db.prepare("INSERT INTO merge_event_listings (merge_event_id, listing_id, from_group_id) VALUES (?,?,?)");
    ls.forEach((l) => insL.run(eventId, l.id, l.group_id));
    db.prepare(`UPDATE listings SET group_id = ? WHERE group_id IN (${placeholders(ids.length)})`).run(resultId, ...ids);
    db.prepare(`UPDATE groups SET status = 'Merged', merged_into_event_id = ? WHERE id IN (${placeholders(ids.length)})`).run(eventId, ...ids);
    audit(db, "Merge products", { mergeEventId: eventId, resultProductId: resultId, sourceProductIds: ids, name: v.name, listingIds: ls.map((l) => l.id) });
    return { mergeEventId: eventId, productId: resultId };
  })();
}

interface EventRow {
  rid: number;
  id: string;
  name: string;
  note: string | null;
  created: string;
  resultGroupId: string;
}

/** The target plus every active merge that consumed (transitively) its result, newest first. */
function undoSet(db: DB, eventId: string): EventRow[] {
  const get = db.prepare("SELECT rowid AS rid, id, name, note, created, result_group_id AS resultGroupId, undone_at AS undoneAt FROM merge_events WHERE id = ?");
  const target = get.get(eventId) as (EventRow & { undoneAt: string | null }) | undefined;
  if (!target) throw notFound("Merge not found.");
  if (target.undoneAt) throw conflict("This merge was already undone.");
  const dep = db.prepare(
    `SELECT e.rowid AS rid, e.id, e.name, e.note, e.created, e.result_group_id AS resultGroupId FROM merge_events e
     JOIN merge_event_sources s ON s.merge_event_id = e.id WHERE s.source_group_id = ? AND e.undone_at IS NULL`,
  );
  const all = new Map<string, EventRow>([[target.id, target]]);
  const queue: EventRow[] = [target];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const d of dep.all(cur.resultGroupId) as EventRow[]) {
      if (!all.has(d.id)) (all.set(d.id, d), queue.push(d));
    }
  }
  return [...all.values()].sort((a, b) => b.rid - a.rid);
}

const tokenOf = (set: EventRow[]) => createHash("sha1").update(set.map((e) => e.id).sort().join(",")).digest("hex");

export function undoImpact(db: DB, eventId: string) {
  const set = undoSet(db, eventId);
  const results = new Set(set.map((e) => e.resultGroupId));
  const srcRows = db.prepare(`SELECT DISTINCT g.id, g.name, g.image, s.merge_event_id AS eid FROM merge_event_sources s JOIN groups g ON g.id = s.source_group_id WHERE s.merge_event_id IN (${placeholders(set.length)})`).all(...set.map((e) => e.id)) as any[];
  const restored = srcRows.filter((r) => !results.has(r.id));
  const fallbackImg = db.prepare("SELECT image FROM listings WHERE group_id = ? AND image IS NOT NULL ORDER BY created LIMIT 1");
  const target = set.find((e) => e.id === eventId)!;
  return {
    target: { id: target.id, name: target.name, created: target.created },
    dependents: set.filter((e) => e.id !== eventId).sort((a, b) => a.rid - b.rid).map((e) => ({ id: e.id, name: e.name, created: e.created, note: e.note })),
    restoredProducts: restored.map((r) => ({ id: r.id, name: r.name, image: httpUrl(r.image ?? (fallbackImg.get(r.id) as any)?.image) })),
    token: tokenOf(set),
  };
}

export function unmerge(db: DB, input: unknown) {
  const b = z.object({ mergeEventId: z.string(), token: z.string() }).safeParse(input);
  if (!b.success) throw badRequest("Missing merge id or token.");
  return db.transaction(() => {
    const set = undoSet(db, b.data.mergeEventId);
    if (tokenOf(set) !== b.data.token) throw conflict("Merges changed since you opened this dialog. Review again.");
    const results = new Set(set.map((e) => e.resultGroupId));
    const t = now();
    const moveBack = db.prepare("UPDATE listings SET group_id = ? WHERE id = ?");
    const restoredIds: string[] = [];
    for (const e of set) {
      // newest first: dependents before the target
      const ml = db.prepare("SELECT listing_id AS listingId, from_group_id AS fromGroupId FROM merge_event_listings WHERE merge_event_id = ?").all(e.id) as any[];
      ml.forEach((m) => moveBack.run(m.fromGroupId, m.listingId));
      const srcs = (db.prepare("SELECT source_group_id AS id FROM merge_event_sources WHERE merge_event_id = ?").all(e.id) as Array<{ id: string }>).map((r) => r.id);
      db.prepare(`UPDATE groups SET status = 'Active', merged_into_event_id = NULL WHERE id IN (${placeholders(srcs.length)})`).run(...srcs);
      db.prepare("UPDATE groups SET status = 'Retired', merged_into_event_id = NULL WHERE id = ?").run(e.resultGroupId);
      db.prepare("UPDATE merge_events SET undone_at = ? WHERE id = ?").run(t, e.id);
      srcs.filter((s) => !results.has(s)).forEach((s) => restoredIds.push(s));
    }
    // A product restored by one event and retired by a later undo must not be listed as restored.
    const undoneEventIds = set.map((e) => e.id);
    audit(db, "Undo merge", { undoneEventIds, restoredProductIds: restoredIds });
    return { undoneEventIds, restoredProductIds: [...new Set(restoredIds)] };
  })();
}

export function listMerges(db: DB, q: Record<string, string | undefined>) {
  const limit = Math.min(Number(q.limit) || 50, 200);
  let offset = 0;
  if (q.cursor) offset = Math.max(0, parseInt(Buffer.from(q.cursor, "base64url").toString(), 10) || 0);
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.category && q.category !== "all") (where.push("e.category_id = ?"), params.push(q.category));
  if (q.status === "active") where.push("e.undone_at IS NULL");
  if (q.status === "undone") where.push("e.undone_at IS NOT NULL");
  if (q.q?.trim()) {
    const like = `%${q.q.trim().toLowerCase().replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    where.push(`(lower(e.name) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM merge_event_sources s JOIN groups g ON g.id = s.source_group_id WHERE s.merge_event_id = e.id AND lower(g.name) LIKE ? ESCAPE '\\'))`);
    params.push(like, like);
  }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM merge_events e ${w}`).get(...params) as { c: number }).c;
  const rows = db.prepare(
    `SELECT e.id, e.created, e.category_id AS categoryId, c.name AS categoryName, e.result_group_id AS resultId, e.name, e.image, e.note, e.undone_at AS undoneAt,
       (SELECT COUNT(*) FROM merge_event_listings ml WHERE ml.merge_event_id = e.id) AS listingCount
     FROM merge_events e JOIN categories c ON c.id = e.category_id ${w} ORDER BY e.created DESC, e.rowid DESC LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as any[];
  const srcQ = db.prepare("SELECT g.id, g.name, g.image FROM merge_event_sources s JOIN groups g ON g.id = s.source_group_id WHERE s.merge_event_id = ?");
  const imgQ = db.prepare("SELECT image FROM listings WHERE group_id = ? AND image IS NOT NULL ORDER BY created LIMIT 1");
  const items = rows.map((r) => ({
    id: r.id,
    created: r.created,
    category: { id: r.categoryId, name: r.categoryName },
    result: { id: r.resultId, name: r.name, image: httpUrl(r.image) },
    sources: (srcQ.all(r.id) as any[]).map((s) => ({ id: s.id, name: s.name, image: httpUrl(s.image ?? (imgQ.get(s.id) as any)?.image) })),
    listingCount: r.listingCount,
    note: r.note,
    undoneAt: r.undoneAt,
  }));
  return { items, total, nextCursor: offset + rows.length < total ? Buffer.from(String(offset + rows.length)).toString("base64url") : null };
}
