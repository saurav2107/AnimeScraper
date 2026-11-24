import type { DB } from "@/db";
import { listCategories } from "./categories";
import { listSuppliers } from "./suppliers";
import { nextRun, scheduleSettings } from "./scrape";

const VISIBLE = `EXISTS (SELECT 1 FROM listings l JOIN suppliers s ON s.id = l.supplier_id AND s.status != 'Deleted' WHERE l.group_id = g.id`;

export function dashboard(db: DB) {
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  const byCategory = db.prepare(
    `SELECT c.id, c.name,
       (SELECT COUNT(*) FROM suppliers s WHERE s.category_id = c.id AND s.status != 'Deleted') AS suppliers,
       (SELECT COUNT(*) FROM suppliers s WHERE s.category_id = c.id AND s.status = 'Active') AS activeSuppliers,
       (SELECT COUNT(*) FROM groups g WHERE g.category_id = c.id AND g.status='Active' AND ${VISIBLE})) AS products,
       (SELECT COUNT(*) FROM groups g WHERE g.category_id = c.id AND g.status='Active' AND ${VISIBLE} AND l.status='NEW')) AS newProducts,
       (SELECT COUNT(*) FROM groups g WHERE g.category_id = c.id AND g.status='Active' AND ${VISIBLE} AND l.status='PRICE UPDATED')) AS priceChanges,
       (SELECT COUNT(*) FROM groups g WHERE g.category_id = c.id AND g.status='Active' AND ${VISIBLE}) AND NOT EXISTS (SELECT 1 FROM listings l2 JOIN suppliers s2 ON s2.id=l2.supplier_id AND s2.status!='Deleted' WHERE l2.group_id=g.id AND l2.stock!='Out of stock' AND l2.status!='REMOVED')) AS outOfStock
     FROM categories c WHERE c.deleted_at IS NULL ORDER BY lower(c.name)`,
  ).all();
  const last = db.prepare("SELECT id, kind, status, started, finished FROM jobs ORDER BY started DESC LIMIT 1").get() ?? null;
  // Biggest recent drops (by %), one row per listing, visible products only
  const topDrops = db.prepare(
    `SELECT g.id AS productId, g.name, COALESCE(g.image, l.image) AS image, g.category_id AS categoryId, c.name AS category, s.name AS supplier, l.url,
            l.previous_price AS previous, l.price, l.currency, l.price_changed_at AS changedAt,
            ROUND((l.previous_price - l.price) * 100.0 / l.previous_price, 1) AS pct
     FROM listings l
     JOIN groups g ON g.id = l.group_id AND g.status = 'Active'
     JOIN categories c ON c.id = g.category_id AND c.deleted_at IS NULL
     JOIN suppliers s ON s.id = l.supplier_id AND s.status != 'Deleted'
     WHERE l.status = 'PRICE UPDATED' AND l.previous_price > 0 AND l.price IS NOT NULL AND l.price < l.previous_price AND l.stock != 'Out of stock'
     ORDER BY pct DESC, l.price_changed_at DESC LIMIT 6`,
  ).all();
  return {
    topDrops,
    activeSuppliers: one("SELECT COUNT(*) AS c FROM suppliers WHERE status = 'Active'"),
    products: one(`SELECT COUNT(*) AS c FROM groups g WHERE g.status='Active' AND ${VISIBLE})`),
    newArrivals: one(`SELECT COUNT(*) AS c FROM groups g WHERE g.status='Active' AND ${VISIBLE} AND l.status='NEW')`),
    priceChanges: one(`SELECT COUNT(*) AS c FROM groups g WHERE g.status='Active' AND ${VISIBLE} AND l.status='PRICE UPDATED')`),
    activeMerges: one("SELECT COUNT(*) AS c FROM merge_events WHERE undone_at IS NULL"),
    lastRun: last,
    byCategory,
  };
}

export function appState(db: DB) {
  // Which category each supplier belongs to (deleted suppliers included, so old runs keep their label).
  const catOf = new Map((db.prepare("SELECT s.id, c.name FROM suppliers s JOIN categories c ON c.id = s.category_id").all() as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));
  const jobs = (db.prepare("SELECT id, kind, status, started, finished, selected, log FROM jobs ORDER BY started DESC LIMIT 50").all() as any[]).map((j) => {
    const selected: string[] = JSON.parse(j.selected);
    const log: any[] = JSON.parse(j.log).map((e: any) => (e.supplierId ? { ...e, category: catOf.get(e.supplierId) ?? null } : e));
    const categories = [...new Set([...selected.map((id) => catOf.get(id)), ...log.map((e) => e.category)].filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));
    return { ...j, selected, log, categories };
  });
  return {
    categories: listCategories(db),
    suppliers: listSuppliers(db),
    deletedSuppliers: listSuppliers(db, true).map((s) => ({ id: s.id, name: s.name, url: s.url, category: s.category, deletedAt: s.deletedAt })),
    jobs,
    settings: scheduleSettings(db),
    nextRun: nextRun(db),
    summary: dashboard(db),
  };
}
