import type { DB } from "@/db";
import { badRequest } from "./errors";
import { listProducts } from "./products";
import { placeholders } from "./util";

const IST = 5.5 * 3600 * 1000;
/** Readable IST timestamp for spreadsheets ("2026-11-22 23:04"). */
const when = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) + IST).toISOString().slice(0, 16).replace("T", " ") : "");

const VIS = `EXISTS (SELECT 1 FROM listings l JOIN suppliers s ON s.id = l.supplier_id AND s.status != 'Deleted' WHERE l.group_id = g.id`;

export function exportData(db: DB, q: Record<string, string | undefined>) {
  const category = q.category || "all";
  const scope = q.scope || "all";
  if (!["all", "new", "price_changes", "merged", "current", "selected"].includes(scope)) throw badRequest("Unknown export scope.");
  const catSql = category === "all" ? "" : " AND g.category_id = ?";
  const catParams = category === "all" ? [] : [category];

  let ids: string[];
  if (scope === "selected") ids = (q.ids ?? "").split(",").filter(Boolean);
  else if (scope === "current") {
    if (category === "all") throw badRequest("Current results need a category.");
    ids = [];
    let cursor: string | undefined;
    do {
      const page = listProducts(db, { ...q, category, limit: "200", cursor });
      ids.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor && ids.length < 20000);
  } else {
    const extra =
      scope === "new" ? ` AND ${VIS} AND l.status='NEW')` :
      scope === "price_changes" ? ` AND ${VIS} AND l.status='PRICE UPDATED')` :
      scope === "merged" ? ` AND EXISTS (SELECT 1 FROM merge_events me WHERE me.result_group_id = g.id AND me.undone_at IS NULL)` : "";
    ids = (db.prepare(`SELECT g.id FROM groups g WHERE g.status='Active' AND ${VIS})${catSql}${extra} ORDER BY lower(g.name)`).all(...catParams) as Array<{ id: string }>).map((r) => r.id);
  }

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));
  const supplierNames = new Set<string>();
  const products: any[] = [], listings: any[] = [], priceChanges: any[] = [], removed: any[] = [];
  for (const part of chunks) {
    const ph = placeholders(part.length);
    const gs = db.prepare(
      `SELECT g.id, g.name, g.image, g.size_value AS manualSize, c.name AS category, c.size_label AS sizeLabel, c.size_unit AS sizeUnit,
         EXISTS (SELECT 1 FROM merge_events me WHERE me.result_group_id = g.id AND me.undone_at IS NULL) AS merged
       FROM groups g JOIN categories c ON c.id = g.category_id WHERE g.id IN (${ph}) AND g.status = 'Active'`,
    ).all(...part) as any[];
    const ls = db.prepare(
      `SELECT l.id, l.group_id AS groupId, s.name AS supplier, l.name, l.url, l.image, l.price, l.previous_price AS previousPrice, l.price_changed_at AS priceChangedAt, l.currency, l.stock, l.status, l.size_value AS sizeValue, l.scraped
       FROM listings l JOIN suppliers s ON s.id = l.supplier_id AND s.status != 'Deleted' WHERE l.group_id IN (${ph}) ORDER BY l.created`,
    ).all(...part) as any[];
    for (const g of gs) {
      const mine = ls.filter((l) => l.groupId === g.id);
      const prices = mine.filter((l) => l.currency === "INR" && l.price != null && l.stock !== "Out of stock" && l.status !== "REMOVED").map((l) => l.price);
      const size = g.manualSize ?? mine.find((l) => l.sizeValue)?.sizeValue ?? null;
      const row: Record<string, unknown> = {
        "Product ID": g.id, Name: g.name, Category: g.category, Image: g.image ?? mine.find((l) => l.image)?.image ?? "",
        "Size Type": g.sizeLabel, Size: size ?? "", "Size Unit": g.sizeUnit ?? "", "Merged (Yes/No)": g.merged ? "Yes" : "No",
        "Lowest Price (INR)": prices.length ? Math.min(...prices) : "", Suppliers: new Set(mine.map((l) => l.supplier)).size, Listings: mine.length,
      };
      // One price column per supplier: lowest purchasable price, else "Out of stock" / "Removed" (PRD comparison view in the workbook).
      for (const sup of new Set(mine.map((l) => l.supplier as string))) {
        supplierNames.add(sup);
        const ls2 = mine.filter((l) => l.supplier === sup);
        const live = ls2.filter((l) => l.status !== "REMOVED");
        const buy = live.filter((l) => l.stock !== "Out of stock" && l.price != null).map((l) => l.price as number);
        row[`Price – ${sup}`] = !live.length ? "Removed" : buy.length ? Math.min(...buy) : live.every((l) => l.stock === "Out of stock") ? "Out of stock" : "";
      }
      products.push(row);
      for (const l of mine) {
        const row = { "Product ID": g.id, Product: g.name, Category: g.category, Supplier: l.supplier, "Listing Name": l.name, URL: l.url, Price: l.price ?? "", Currency: l.currency ?? "", Stock: l.stock, Status: l.status, Size: l.sizeValue ?? "", "Last Scraped": when(l.scraped) };
        listings.push(row);
        if (l.status === "PRICE UPDATED") priceChanges.push({ Product: g.name, Category: g.category, Supplier: l.supplier, "Previous Price": l.previousPrice ?? "", "Current Price": l.price ?? "", Currency: l.currency ?? "", "Changed At": when(l.priceChangedAt), URL: l.url });
        if (l.status === "REMOVED") removed.push({ Product: g.name, Category: g.category, Supplier: l.supplier, "Listing Name": l.name, URL: l.url, "Last Seen": when(l.scraped) });
      }
    }
  }

  const mq = db.prepare(
    `SELECT e.id, e.created, c.name AS category, e.result_group_id AS resultId, e.name, e.image, e.note, e.undone_at AS undoneAt,
       (SELECT group_concat(s.source_group_id, ', ') FROM merge_event_sources s WHERE s.merge_event_id = e.id) AS sourceIds,
       (SELECT group_concat(g.name, ' | ') FROM merge_event_sources s JOIN groups g ON g.id = s.source_group_id WHERE s.merge_event_id = e.id) AS sourceNames,
       (SELECT group_concat(ml.listing_id, ', ') FROM merge_event_listings ml WHERE ml.merge_event_id = e.id) AS listingIds
     FROM merge_events e JOIN categories c ON c.id = e.category_id ${category === "all" ? "" : "WHERE e.category_id = ?"} ORDER BY e.created DESC`,
  ).all(...(category === "all" ? [] : [category])) as any[];
  const merges = mq.map((m) => ({
    "Merge ID": m.id, Date: when(m.created), Category: m.category, "Result Product ID": m.resultId, "Merged Name": m.name, "Image URL": m.image ?? "",
    "Source Product IDs": m.sourceIds ?? "", "Source Product Names": m.sourceNames ?? "", "Listing IDs": m.listingIds ?? "", Note: m.note ?? "",
    Status: m.undoneAt ? "Undone" : "Active", "Undone At": when(m.undoneAt),
  }));
  for (const r of products) for (const n of supplierNames) if (!(`Price – ${n}` in r)) r[`Price – ${n}`] = "";
  const headers = {
    products: ["Product ID", "Name", "Category", "Image", "Size Type", "Size", "Size Unit", "Merged (Yes/No)", "Lowest Price (INR)", "Suppliers", "Listings", ...[...supplierNames].sort().map((n) => `Price – ${n}`)],
    listings: ["Product ID", "Product", "Category", "Supplier", "Listing Name", "URL", "Price", "Currency", "Stock", "Status", "Size", "Last Scraped"],
    priceChanges: ["Product", "Category", "Supplier", "Previous Price", "Current Price", "Currency", "Changed At", "URL"],
    merges: ["Merge ID", "Date", "Category", "Result Product ID", "Merged Name", "Image URL", "Source Product IDs", "Source Product Names", "Listing IDs", "Note", "Status", "Undone At"],
    removed: ["Product", "Category", "Supplier", "Listing Name", "URL", "Last Seen"],
  };
  return { products, listings, priceChanges, merges, removed, headers };
}
