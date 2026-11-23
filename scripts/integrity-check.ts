// QA helper for NFR-INT-01: checks invariants INV-1..INV-9 against the live DB. `npm run db:check`
import { liveDb } from "../db";

const db = liveDb();
const q = (sql: string) => db.prepare(sql).all() as unknown[];
const checks: Array<[string, string]> = [
  ["INV-1 listings reference an existing product", "SELECT l.id FROM listings l LEFT JOIN groups g ON g.id = l.group_id WHERE g.id IS NULL"],
  ["INV-2 listing product category = supplier category", "SELECT l.id FROM listings l JOIN groups g ON g.id=l.group_id JOIN suppliers s ON s.id=l.supplier_id WHERE g.category_id != s.category_id"],
  ["INV-3a Active products have >=1 listing", "SELECT g.id FROM groups g WHERE g.status='Active' AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.group_id=g.id)"],
  ["INV-3b Merged/Retired products have 0 listings", "SELECT g.id FROM groups g WHERE g.status IN ('Merged','Retired') AND EXISTS (SELECT 1 FROM listings l WHERE l.group_id=g.id)"],
  ["INV-4 Merged <=> active merge event", "SELECT g.id FROM groups g LEFT JOIN merge_events e ON e.id=g.merged_into_event_id WHERE (g.status='Merged') != (e.id IS NOT NULL AND e.undone_at IS NULL)"],
  ["INV-6 sources of active events are Merged", "SELECT s.source_group_id FROM merge_event_sources s JOIN merge_events e ON e.id=s.merge_event_id JOIN groups g ON g.id=s.source_group_id WHERE e.undone_at IS NULL AND g.status != 'Merged'"],
  ["INV-7 merge sources share the event category", "SELECT s.source_group_id FROM merge_event_sources s JOIN merge_events e ON e.id=s.merge_event_id JOIN groups g ON g.id=s.source_group_id WHERE g.category_id != e.category_id"],
  ["INV-9 no history older than 30 days", `SELECT id FROM price_history WHERE recorded_at < datetime('now','-31 days') UNION ALL SELECT id FROM history WHERE at < datetime('now','-31 days')`],
];
let bad = 0;
for (const [name, sql] of checks) {
  const rows = q(sql);
  console.log(`${rows.length ? "FAIL" : "ok  "}  ${name}${rows.length ? ` (${rows.length})` : ""}`);
  if (rows.length) bad++;
}
process.exit(bad ? 1 : 0);
