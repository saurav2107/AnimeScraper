import type { DB } from "@/db";
import { crawlSupplier, type CrawlResult, type ScrapedProduct } from "./adapters";
import { Crawler, type CrawlOptions } from "./crawler";
import type { SizeKind } from "./categories";
import { badRequest, conflict, notFound } from "./errors";
import { getSupplier } from "./suppliers";
import { audit, chunk, delSetting, getSetting, now, setSetting, uid } from "./util";

export const RETENTION_DAYS = 30;
export const MAX_REMOVAL_CHECKS = 5;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_HEARTBEAT_MS = Number(process.env.LOCK_HEARTBEAT_MS) || 30 * 1000;

export interface RunLogEntry {
  supplierId: string;
  supplier: string;
  status: "Completed" | "Partial" | "Failed";
  discovered: number;
  added: number;
  updated: number;
  removed: number;
  skippedDuplicates: number;
  skippedExamples: Array<{ url: string; owner: string }>;
  errors: string[];
}

export interface RunDeps extends CrawlOptions {
  crawl?: typeof crawlSupplier;
}

interface ListingRow {
  id: string;
  supplier_id: string;
  group_id: string;
  url: string;
  price: number | null;
  stock: string;
  status: string;
}

/** Persist one registration's crawl. Scraping never touches group_id of existing listings (FR-SCR-03). */
export function persistProducts(db: DB, supplier: { id: string; name: string; categoryId: string }, products: ScrapedProduct[], entry: RunLogEntry, runAt = now()) {
  const getByUrl = db.prepare("SELECT l.id, l.supplier_id, l.group_id, l.url, l.price, l.stock, l.status, s.name AS owner FROM listings l JOIN suppliers s ON s.id = l.supplier_id WHERE l.url = ?");
  const insGroup = db.prepare("INSERT INTO groups (id, category_id, name, status, created) VALUES (?,?,?,?,?)");
  const insListing = db.prepare(
    `INSERT INTO listings (id, supplier_id, group_id, url, name, image, height, material, size_value, price, currency, stock, status, raw, scraped, created)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insHist = db.prepare("INSERT INTO history (id, listing_id, kind, previous, current, at) VALUES (?,?,?,?,?,?)");
  const insPrice = db.prepare("INSERT INTO price_history (id, listing_id, price, currency, stock, recorded_at) VALUES (?,?,?,?,?,?)");
  const upd = db.prepare(
    `UPDATE listings SET name=?, image=?, height=?, material=?, size_value=?, price=?, currency=?, stock=?, status=?, raw=?, scraped=?,
       previous_price = COALESCE(?, previous_price), price_changed_at = COALESCE(?, price_changed_at) WHERE id=?`,
  );

  const seen = new Set<string>();
  for (const batch of chunk(products, 20)) {
    db.transaction(() => {
      for (const p of batch) {
        if (seen.has(p.url)) continue;
        seen.add(p.url);
        const ex = getByUrl.get(p.url) as (ListingRow & { owner: string }) | undefined;
        const raw = JSON.stringify(p.raw ?? null);
        const height = /^\d/.test(p.sizeValue ?? "") ? p.sizeValue : null;
        if (!ex) {
          const gid = uid();
          const lid = uid();
          insGroup.run(gid, supplier.categoryId, p.name, "Active", runAt);
          insListing.run(lid, supplier.id, gid, p.url, p.name, p.image, height, p.material, p.sizeValue, p.price, p.currency, p.stock, "NEW", raw, runAt, runAt);
          insHist.run(uid(), lid, "NEW", null, JSON.stringify({ price: p.price, stock: p.stock }), runAt);
          insPrice.run(uid(), lid, p.price, p.currency, p.stock, runAt);
          entry.added++;
          continue;
        }
        if (ex.supplier_id !== supplier.id) {
          entry.skippedDuplicates++;
          if (entry.skippedExamples.length < 20) entry.skippedExamples.push({ url: p.url, owner: ex.owner });
          continue;
        }
        let status = "Current";
        let prev: number | null = null;
        let changedAt: string | null = null;
        if (ex.price != null && p.price != null && ex.price !== p.price) {
          status = "PRICE UPDATED";
          prev = ex.price;
          changedAt = runAt;
          insHist.run(uid(), ex.id, "PRICE UPDATED", JSON.stringify({ price: ex.price }), JSON.stringify({ price: p.price }), runAt);
        } else if (p.stock === "Out of stock") status = "OUT OF STOCK";
        else if (ex.status === "NEW") status = "NEW"; // stays NEW until acknowledged
        if (ex.stock !== p.stock) {
          insHist.run(uid(), ex.id, p.stock === "Out of stock" ? "OUT OF STOCK" : "STOCK UPDATED", JSON.stringify({ stock: ex.stock }), JSON.stringify({ stock: p.stock }), runAt);
          if (status === "Current" && p.stock === "Out of stock") status = "OUT OF STOCK";
        }
        upd.run(p.name, p.image, height, p.material, p.sizeValue, p.price, p.currency, p.stock, status, raw, runAt, prev, changedAt, ex.id);
        insPrice.run(uid(), ex.id, p.price, p.currency, p.stock, runAt);
        entry.updated++;
      }
    })();
  }
  return seen;
}

/** HEAD-verify at most 5 URLs missing from a complete crawl; only 404/410 => REMOVED (kept in their product). */
export async function verifyRemovals(db: DB, supplierId: string, seen: Set<string>, crawler: Crawler, entry: RunLogEntry) {
  const missing = db.prepare("SELECT id, url FROM listings WHERE supplier_id = ? AND status != 'REMOVED'").all(supplierId) as Array<{ id: string; url: string }>;
  let checks = 0;
  for (const m of missing) {
    if (seen.has(m.url)) continue;
    if (checks++ >= MAX_REMOVAL_CHECKS) break;
    const code = await crawler.head(m.url);
    if (code === 404 || code === 410) {
      const t = now();
      db.prepare("UPDATE listings SET status = 'REMOVED', scraped = ? WHERE id = ?").run(t, m.id);
      db.prepare("INSERT INTO history (id, listing_id, kind, previous, current, at) VALUES (?,?,?,?,?,?)").run(uid(), m.id, "REMOVED", null, JSON.stringify({ http: code }), t);
      entry.removed++;
    }
  }
}

export function pruneHistory(db: DB, days = RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const ph = db.prepare("DELETE FROM price_history WHERE recorded_at < ?").run(cutoff).changes;
  const h = db.prepare("DELETE FROM history WHERE at < ?").run(cutoff).changes;
  return { priceHistoryDeleted: ph, historyDeleted: h, cutoff };
}

// ---------- run lock ----------
function acquireLock(db: DB, jobId: string) {
  const cur = getSetting(db, "run_lock");
  if (cur) {
    const at = Date.parse(JSON.parse(cur).at);
    if (Date.now() - at < LOCK_STALE_MS) throw conflict("A scraping run is already in progress.");
  }
  setSetting(db, "run_lock", JSON.stringify({ jobId, at: now() }));
}
export function recoverLock(db: DB) {
  const cur = getSetting(db, "run_lock");
  if (!cur) return { ok: true, recovered: false };
  const lock = JSON.parse(cur) as { jobId: string; at: string };
  if (Date.now() - Date.parse(lock.at) < LOCK_STALE_MS) throw conflict("The run lock is recent. Wait 10 minutes before recovering it.");
  delSetting(db, "run_lock");
  db.prepare("UPDATE jobs SET status = 'Failed', finished = ? WHERE id = ? AND status = 'Running'").run(now(), lock.jobId);
  audit(db, "Recover run lock", lock);
  return { ok: true, recovered: true };
}

/** Create a job row and take the lock. Throws 409 if busy. */
export function createJob(db: DB, kind: string, selected: string[]): string {
  const ids = selected.length ? selected : (db.prepare("SELECT id FROM suppliers WHERE status = 'Active'").all() as Array<{ id: string }>).map((r) => r.id);
  const active = ids.filter((id) => {
    const s = getSupplier(db, id);
    return s && s.status === "Active";
  });
  if (!active.length) throw badRequest("No active suppliers to run. Test & activate a supplier first.");
  const id = uid();
  acquireLock(db, id);
  db.prepare("INSERT INTO jobs (id, kind, status, started, selected, log) VALUES (?,?,?,?,?,?)").run(id, kind, "Running", now(), JSON.stringify(active), "[]");
  return id;
}

export async function executeJob(db: DB, jobId: string, deps: RunDeps = {}) {
  const job = db.prepare("SELECT selected FROM jobs WHERE id = ?").get(jobId) as { selected: string };
  const ids = JSON.parse(job.selected) as string[];
  const log: Array<RunLogEntry | { retention: ReturnType<typeof pruneHistory> } | { warning: string }> = [];
  let errored = false;
  const crawl = deps.crawl ?? crawlSupplier;
  // Keep the lock fresh while the run is alive, so a long run is never mistaken for a crashed one.
  const heartbeat = setInterval(() => {
    try { setSetting(db, "run_lock", JSON.stringify({ jobId, at: now() })); } catch { /* db closed */ }
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    for (const sid of ids) {
      const s = getSupplier(db, sid);
      if (!s || s.status !== "Active") continue;
      const cat = db.prepare("SELECT size_kind AS kind FROM categories WHERE id = ?").get(s.categoryId) as { kind: SizeKind };
      const entry: RunLogEntry = { supplierId: sid, supplier: s.name, status: "Completed", discovered: 0, added: 0, updated: 0, removed: 0, skippedDuplicates: 0, skippedExamples: [], errors: [] };
      try {
        const crawler = new Crawler(new URL(s.url).origin, deps);
        const res: CrawlResult = await crawl(crawler, s.url, s.config, cat.kind);
        entry.discovered = res.products.length;
        entry.errors = res.errors.slice(0, 10);
        const seen = persistProducts(db, { id: s.id, name: s.name, categoryId: s.categoryId }, res.products, entry);
        if (res.complete) {
          await verifyRemovals(db, sid, seen, crawler, entry);
          db.prepare("UPDATE suppliers SET last_success = ? WHERE id = ?").run(now(), sid);
        } else {
          entry.status = res.products.length ? "Partial" : "Failed"; // nothing imported => a failure, not a partial run
          errored = true;
        }
      } catch (e) {
        entry.status = "Failed";
        entry.errors.push((e as Error).message);
        errored = true;
      }
      log.push(entry);
      db.prepare("UPDATE jobs SET log = ? WHERE id = ?").run(JSON.stringify(log), jobId);
    }
    db.prepare("UPDATE jobs SET status = ?, finished = ?, log = ? WHERE id = ?").run(errored ? "Completed with errors" : "Completed", now(), JSON.stringify(log), jobId);
  } catch (e) {
    db.prepare("UPDATE jobs SET status = 'Failed', finished = ?, log = ? WHERE id = ?").run(now(), JSON.stringify([...log, { warning: (e as Error).message }]), jobId);
  } finally {
    clearInterval(heartbeat);
    delSetting(db, "run_lock");
    try {
      log.push({ retention: pruneHistory(db) });
    } catch (e) {
      log.push({ warning: `Retention failed: ${(e as Error).message}` });
    }
    db.prepare("UPDATE jobs SET log = ? WHERE id = ?").run(JSON.stringify(log), jobId);
  }
}

export async function runNow(db: DB, body: { selected?: string[]; wait?: boolean }, deps: RunDeps = {}, kind = "Manual") {
  const jobId = createJob(db, kind, body.selected ?? []);
  const p = executeJob(db, jobId, deps);
  if (body.wait) await p;
  else p.catch(() => undefined);
  return { jobId };
}

/** Test & activate: bounded crawl; activates when products are found (FR-SUP-02). */
export async function testSupplier(db: DB, id: unknown, deps: RunDeps = {}) {
  if (typeof id !== "string") throw badRequest("Missing supplier id.");
  const s = getSupplier(db, id);
  if (!s || s.status === "Deleted") throw notFound("Supplier not found.");
  if (!s.config.termsAcknowledged) throw badRequest("Acknowledge the supplier's terms first.");
  const cat = db.prepare("SELECT size_kind AS kind FROM categories WHERE id = ?").get(s.categoryId) as { kind: SizeKind };
  const crawler = new Crawler(new URL(s.url).origin, { ...deps, maxRequests: 12, retries: deps.retries ?? 0 });
  const crawl = deps.crawl ?? crawlSupplier;
  const res = await crawl(crawler, s.url, s.config, cat.kind);
  if (!res.products.length) throw badRequest(`Test failed: no products found.${res.errors[0] ? " " + res.errors[0] : ""}`);
  db.prepare("UPDATE suppliers SET status = 'Active' WHERE id = ?").run(id);
  audit(db, "Activate supplier", { id, found: res.products.length });
  return { ok: true, found: res.products.length, status: "Active" };
}

export function acknowledge(db: DB, body: { id?: unknown; categoryId?: unknown }) {
  if (typeof body?.categoryId === "string") {
    const n = db.prepare("UPDATE listings SET status = 'Current' WHERE status = 'NEW' AND supplier_id IN (SELECT id FROM suppliers WHERE category_id = ? AND status != 'Deleted')").run(body.categoryId).changes;
    audit(db, "Acknowledge new listings", { categoryId: body.categoryId, count: n });
    return { ok: true, count: n };
  }
  if (typeof body?.id !== "string") throw badRequest("Missing listing id.");
  db.prepare("UPDATE listings SET status = 'Current' WHERE id = ? AND status = 'NEW'").run(body.id);
  audit(db, "Acknowledge listing", { id: body.id });
  return { ok: true, count: 1 };
}

/** On process start no run can be in flight: fail jobs left "Running" by a crash/restart and free the lock. */
export function recoverOrphans(db: DB) {
  const n = db.prepare("UPDATE jobs SET status = 'Failed', finished = ? WHERE status = 'Running'").run(now()).changes;
  delSetting(db, "run_lock");
  return n;
}

// ---------- scheduling (alternate-day, Asia/Kolkata) ----------
const IST = 5.5 * 3600 * 1000;
const istDate = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const istMinutes = (ms: number) => {
  const d = new Date(ms + IST);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

export function scheduleSettings(db: DB) {
  return {
    automatic: getSetting(db, "automatic") === "1",
    time: getSetting(db, "time") || "09:00",
    schedulerLinked: getSetting(db, "scheduler_linked") === "1",
    lastScheduledDate: getSetting(db, "last_scheduled_date"),
  };
}

/** The next scheduled slot (ISO). If today's slot has passed unserved, it is in the past => "due on the next scheduler call". */
export function nextRun(db: DB, at = Date.now()): string | null {
  const st = scheduleSettings(db);
  if (!st.automatic) return null;
  const [h, m] = st.time.split(":").map(Number);
  const todayStart = Date.parse(istDate(at) + "T00:00:00Z");
  let day = st.lastScheduledDate ? Date.parse(st.lastScheduledDate + "T00:00:00Z") + 2 * 86400000 : todayStart;
  if (day < todayStart) day = todayStart;
  return new Date(day + (h * 60 + m) * 60000 - IST).toISOString();
}

/** Enabling automatic scraping after today's slot has passed must not fire immediately: the first run is tomorrow. */
export function onAutomaticEnabled(db: DB, at = Date.now()) {
  const st = scheduleSettings(db);
  const [h, m] = st.time.split(":").map(Number);
  const today = istDate(at);
  const due = !st.lastScheduledDate || (Date.parse(today) - Date.parse(st.lastScheduledDate)) / 86400000 >= 2;
  if (due && istMinutes(at) >= h * 60 + m) setSetting(db, "last_scheduled_date", istDate(at - 86400000));
}

export async function scheduled(db: DB, deps: RunDeps = {}, at = Date.now()) {
  const s = scheduleSettings(db);
  if (!s.automatic) return { ran: false, reason: "Automatic scraping is off" };
  const today = istDate(at);
  if (s.lastScheduledDate === today) return { ran: false, reason: "Already ran today" };
  if (s.lastScheduledDate) {
    const gap = (Date.parse(today) - Date.parse(s.lastScheduledDate)) / 86400000;
    if (gap < 2) return { ran: false, reason: "Alternate-day schedule: not due" };
  }
  const [h, m] = s.time.split(":").map(Number);
  if (istMinutes(at) < h * 60 + m) return { ran: false, reason: "Before the scheduled time" };
  const r = await runNow(db, { wait: false }, deps, "Scheduled");
  setSetting(db, "last_scheduled_date", today);
  return { ran: true, ...r };
}
