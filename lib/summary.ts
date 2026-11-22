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
  return {
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
  const jobs = (db.prepare("SELECT id, kind, status, started, finished, selected, log FROM jobs ORDER BY started DESC LIMIT 50").all() as any[]).map((j) => ({
    ...j,
    selected: JSON.parse(j.selected),
    log: JSON.parse(j.log),
  }));
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
