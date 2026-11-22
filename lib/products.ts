import { z } from "zod";
import type { DB } from "@/db";
import { getCategory } from "./categories";
import { badRequest, conflict, notFound, zodError } from "./errors";
import { httpUrl, placeholders } from "./util";

export type CellState = "none" | "removed" | "oos" | "no_price" | "price";
export interface Cell {
  state: CellState;
  listingId?: string;
  price?: number | null;
  currency?: string | null;
  previousPrice?: number | null;
  direction?: "up" | "down" | null;
  url?: string;
  more?: number;
}

const querySchema = z.object({
  category: z.string().min(1, "Missing category."),
  q: z.string().max(100, "Search is limited to 100 characters.").optional(),
  sort: z.string().optional(),
  inStock: z.string().optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  new: z.string().optional(),
  priceChanged: z.string().optional(),
  ids: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});
export type ProductQuery = z.infer<typeof querySchema>;

/** Images from a listing: main image plus extra images in the raw payload. http(s) only. */
export function listingImages(image: string | null, rawJson: string | null): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") {
      const u = httpUrl(v);
      if (u) out.push(u);
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      push(o.src ?? o.url);
    }
  };
  push(image);
  try {
    const raw = rawJson ? JSON.parse(rawJson) : null;
    if (raw && typeof raw === "object") {
      for (const key of ["images", "image"]) {
        const v = (raw as Record<string, unknown>)[key];
        if (Array.isArray(v)) v.forEach(push);
        else push(v);
      }
    }
  } catch {
    /* ignore */
  }
  return [...new Set(out)];
}

const esc = (s: string) => s.replace(/[\\%_]/g, (m) => "\\" + m);
const SIZE_KEY = `CASE WHEN size_value IS NULL THEN NULL WHEN size_value LIKE '1:%' THEN CAST(substr(size_value,3) AS INTEGER) ELSE CAST(size_value AS REAL) END`;

export function listProducts(db: DB, rawQuery: Record<string, string | undefined>) {
  const parsed = querySchema.safeParse(rawQuery);
  if (!parsed.success) throw zodError(parsed.error);
  const q = parsed.data;
  if (q.minPrice != null && q.maxPrice != null && q.minPrice > q.maxPrice) throw badRequest("Minimum price can't exceed maximum price.");
  const cat = getCategory(db, q.category);
  if (!cat) throw notFound("Category not found.");

  const suppliers = db.prepare("SELECT id, name, status FROM suppliers WHERE category_id = ? AND status != 'Deleted' ORDER BY lower(name)").all(q.category) as Array<{ id: string; name: string; status: string }>;

  // sort
  let sortKey = q.sort ?? "name_asc";
  let supSort: string | null = null;
  const m = /^supplier:([^:]+):(asc|desc)$/.exec(sortKey);
  if (m) {
    if (suppliers.some((s) => s.id === m[1])) supSort = m[1];
    else sortKey = "name_asc";
  } else if (!["name_asc", "name_desc", "lowest_asc", "lowest_desc", "size_asc", "size_desc"].includes(sortKey)) sortKey = "name_asc";

  const params: unknown[] = [];
  const supCol = supSort ? `, MIN(CASE WHEN l.supplier_id = ? AND l.currency = 'INR' AND l.price IS NOT NULL AND l.stock != 'Out of stock' AND l.status != 'REMOVED' THEN l.price END) AS sup_price` : "";
  if (supSort) params.push(supSort);
  const withSql = `WITH agg AS (
    SELECT l.group_id AS gid,
      MIN(CASE WHEN l.currency = 'INR' AND l.price IS NOT NULL AND l.stock != 'Out of stock' AND l.status != 'REMOVED' THEN l.price END) AS lowest,
      MAX(CASE WHEN l.stock != 'Out of stock' AND l.status != 'REMOVED' THEN 1 ELSE 0 END) AS in_stock,
      MAX(CASE WHEN l.status = 'NEW' THEN 1 ELSE 0 END) AS has_new,
      MAX(CASE WHEN l.status = 'PRICE UPDATED' THEN 1 ELSE 0 END) AS has_pc${supCol}
    FROM listings l JOIN suppliers s ON s.id = l.supplier_id AND s.status != 'Deleted'
    GROUP BY l.group_id)`;

  const where: string[] = ["g.category_id = ?", "g.status = 'Active'"];
  params.push(q.category);
  if (q.q?.trim()) {
    const like = `%${esc(q.q.trim().toLowerCase())}%`;
    where.push(`(lower(g.name) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM listings l2 JOIN suppliers s2 ON s2.id = l2.supplier_id AND s2.status != 'Deleted' WHERE l2.group_id = g.id AND lower(l2.name) LIKE ? ESCAPE '\\'))`);
    params.push(like, like);
  }
  if (q.inStock === "1") where.push("agg.in_stock = 1");
  if (q.minPrice != null) (where.push("agg.lowest >= ?"), params.push(q.minPrice));
  if (q.maxPrice != null) (where.push("agg.lowest <= ?"), params.push(q.maxPrice));
  if (q.new === "1") where.push("agg.has_new = 1");
  if (q.priceChanged === "1") where.push("agg.has_pc = 1");
  if (q.ids) {
    const ids = q.ids.split(",").filter(Boolean).slice(0, 500);
    where.push(`g.id IN (${placeholders(ids.length || 1)})`);
    params.push(...(ids.length ? ids : [""]));
  }

  const sizeSub = `(SELECT l3.size_value FROM listings l3 JOIN suppliers s3 ON s3.id = l3.supplier_id AND s3.status != 'Deleted' WHERE l3.group_id = g.id AND l3.size_value IS NOT NULL ORDER BY l3.created, l3.id LIMIT 1)`;
  const dir = sortKey.endsWith("desc") || m?.[2] === "desc" ? "DESC" : "ASC";
  let order: string;
  if (supSort) order = `(sup_price IS NULL), sup_price ${dir}, g.id`;
  else if (sortKey.startsWith("lowest")) order = `(agg.lowest IS NULL), agg.lowest ${dir}, g.id`;
  else if (sortKey.startsWith("size")) order = `(skey IS NULL), skey ${dir}, g.id`;
  else order = `lower(g.name) ${dir}, g.id`;

  const base = `${withSql} SELECT g.id, g.name, g.image AS gimage, ${sizeSub} AS size_value, agg.lowest, agg.has_new, agg.has_pc,
      ${SIZE_KEY.replace(/size_value/g, sizeSub)} AS skey,
      EXISTS (SELECT 1 FROM merge_events me WHERE me.result_group_id = g.id AND me.undone_at IS NULL) AS is_merged
    FROM groups g JOIN agg ON agg.gid = g.id WHERE ${where.join(" AND ")}`;

  const total = (db.prepare(`${withSql} SELECT COUNT(*) AS c FROM groups g JOIN agg ON agg.gid = g.id WHERE ${where.join(" AND ")}`).get(...params) as { c: number }).c;

  const limit = q.limit ?? 50;
  let offset = 0;
  if (q.cursor) {
    offset = parseInt(Buffer.from(q.cursor, "base64url").toString(), 10);
    if (!Number.isFinite(offset) || offset < 0) throw badRequest("Invalid cursor.");
  }
  const rows = db.prepare(`${base} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<Record<string, any>>;

  const ids = rows.map((r) => r.id as string);
  const listingsByGroup = new Map<string, any[]>();
  if (ids.length) {
    const ls = db.prepare(
      `SELECT l.id, l.group_id, l.supplier_id, l.name, l.url, l.image, l.price, l.previous_price, l.price_changed_at, l.currency, l.stock, l.status, l.scraped, l.created
       FROM listings l JOIN suppliers s ON s.id = l.supplier_id AND s.status != 'Deleted' WHERE l.group_id IN (${placeholders(ids.length)}) ORDER BY l.created, l.id`,
    ).all(...ids) as any[];
    for (const l of ls) {
      if (!listingsByGroup.has(l.group_id)) listingsByGroup.set(l.group_id, []);
      listingsByGroup.get(l.group_id)!.push(l);
    }
  }

  const items = rows.map((r) => {
    const ls = listingsByGroup.get(r.id) ?? [];
    const cells: Record<string, Cell> = {};
    for (const s of suppliers) cells[s.id] = computeCell(ls.filter((l) => l.supplier_id === s.id));
    const image = r.gimage ?? ls.find((l) => l.image)?.image ?? null;
    return {
      id: r.id as string,
      name: r.name as string,
      image: httpUrl(image),
      size: r.size_value ?? null,
      lowestPrice: r.lowest ?? null,
      isMerged: !!r.is_merged,
      hasNew: !!r.has_new,
      hasPriceChange: !!r.has_pc,
      cells,
    };
  });

  return {
    category: { id: cat.id, name: cat.name, sizeKind: cat.sizeKind, sizeLabel: cat.sizeLabel, sizeUnit: cat.sizeUnit },
    suppliers,
    total,
    items,
    nextCursor: offset + rows.length < total ? Buffer.from(String(offset + rows.length)).toString("base64url") : null,
  };
}

/** FR-GRID-03 / FR-GRID-04: choose the display listing and derive the cell. */
export function computeCell(ls: Array<Record<string, any>>): Cell {
  if (!ls.length) return { state: "none" };
  const live = ls.filter((l) => l.status !== "REMOVED");
  if (!live.length) return { state: "removed" };
  const rank = (l: any) => {
    const oos = l.stock === "Out of stock" ? 1 : 0;
    const noPrice = l.price == null ? 1 : 0;
    return [oos, noPrice, l.price ?? 0];
  };
  const display = [...live].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return (ra[i] as number) - (rb[i] as number);
    return 0; // stable: earliest-created first (input order)
  })[0];
  const more = live.length - 1;
  const changed = display.previous_price != null && display.price != null && display.price_changed_at && display.price_changed_at === display.scraped;
  const direction: "up" | "down" | null = changed ? (display.price > display.previous_price ? "up" : "down") : null;
  const base = { listingId: display.id, price: display.price, currency: display.currency, more };
  const extra = direction ? { previousPrice: display.previous_price, direction } : {};
  if (display.stock === "Out of stock") return { state: "oos", ...base, ...extra };
  const url = httpUrl(display.url) ?? undefined;
  if (display.price == null) return { state: "no_price", ...base, url };
  return { state: "price", ...base, ...extra, url };
}

export function getProduct(db: DB, id: string) {
  const g = db.prepare("SELECT g.id, g.name, g.image, g.status, g.category_id AS categoryId, c.name AS category, c.size_label AS sizeLabel, c.size_unit AS sizeUnit FROM groups g JOIN categories c ON c.id = g.category_id WHERE g.id = ?").get(id) as any;
  if (!g) throw notFound("Product not found.");
  if (g.status !== "Active") throw notFound("Product not found.");
  const ls = db.prepare(
    `SELECT l.id, l.supplier_id, s.name AS supplierName, s.status AS supplierStatus, l.name, l.url, l.image, l.raw, l.price, l.currency, l.previous_price AS previousPrice,
       l.price_changed_at AS priceChangedAt, l.stock, l.status, l.size_value AS sizeValue, l.scraped
     FROM listings l JOIN suppliers s ON s.id = l.supplier_id AND s.status != 'Deleted' WHERE l.group_id = ? ORDER BY l.created, l.id`,
  ).all(id) as any[];
  if (!ls.length) throw notFound("Product not found.");
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const history = db.prepare(`SELECT listing_id AS listingId, price, currency, stock, recorded_at AS recordedAt FROM price_history WHERE listing_id IN (${placeholders(ls.length)}) AND recorded_at >= ? ORDER BY recorded_at`).all(...ls.map((l) => l.id), cutoff);
  const ev = db.prepare("SELECT id FROM merge_events WHERE result_group_id = ? AND undone_at IS NULL").get(id) as { id: string } | undefined;
  const size = ls.find((l) => l.sizeValue)?.sizeValue ?? null;
  return {
    id: g.id,
    name: g.name,
    image: httpUrl(g.image ?? ls.find((l) => l.image)?.image),
    category: { id: g.categoryId, name: g.category },
    sizeLabel: g.sizeLabel,
    sizeUnit: g.sizeUnit,
    size,
    isMerged: !!ev,
    mergeEventId: ev?.id,
    listings: ls.map((l) => ({
      id: l.id,
      supplier: { id: l.supplier_id, name: l.supplierName, status: l.supplierStatus },
      name: l.name,
      url: httpUrl(l.url),
      image: httpUrl(l.image),
      images: listingImages(l.image, l.raw),
      price: l.price,
      currency: l.currency,
      previousPrice: l.previousPrice,
      priceChangedAt: l.priceChangedAt,
      stock: l.stock,
      status: l.status,
      sizeValue: l.sizeValue,
      scraped: l.scraped,
    })),
    priceHistory: history,
  };
}

export function mergePreview(db: DB, idsParam: string | undefined) {
  const ids = [...new Set((idsParam ?? "").split(",").filter(Boolean))];
  if (ids.length < 2) throw badRequest("Select at least two products to merge.");
  const groups = db.prepare(`SELECT id, name, image, status, category_id AS categoryId FROM groups WHERE id IN (${placeholders(ids.length)})`).all(...ids) as any[];
  if (groups.length !== ids.length) throw notFound("One or more products were not found.");
  if (new Set(groups.map((g) => g.categoryId)).size > 1) throw badRequest("Products from different categories can't be merged.");
  if (groups.some((g) => g.status !== "Active")) throw conflict("One or more selected products have changed. Refresh and try again.");
  const ls = db.prepare(
    `SELECT l.group_id, l.image, l.raw, l.supplier_id, s.name AS supplierName FROM listings l JOIN suppliers s ON s.id = l.supplier_id AND s.status != 'Deleted' WHERE l.group_id IN (${placeholders(ids.length)}) ORDER BY l.created, l.id`,
  ).all(...ids) as any[];
  const seen = new Set<string>();
  const images: Array<{ url: string; productId: string; supplierName: string }> = [];
  const add = (url: string, productId: string, supplierName: string) => {
    if (!seen.has(url)) (seen.add(url), images.push({ url, productId, supplierName }));
  };
  for (const g of groups) if (httpUrl(g.image)) add(httpUrl(g.image)!, g.id, "Selected for earlier merge");
  for (const l of ls) for (const u of listingImages(l.image, l.raw)) add(u, l.group_id, l.supplierName);
  const products = ids.map((id) => {
    const g = groups.find((x) => x.id === id);
    const mine = ls.filter((l) => l.group_id === id);
    const fallback = httpUrl(g.image) ?? mine.map((l) => listingImages(l.image, l.raw)[0]).find(Boolean) ?? null;
    return { id, name: g.name, image: fallback, supplierCount: new Set(mine.map((l) => l.supplier_id)).size, listingCount: mine.length };
  });
  const perSupplier = new Map<string, { name: string; n: number }>();
  for (const l of ls) {
    const e = perSupplier.get(l.supplier_id) ?? { name: l.supplierName, n: 0 };
    e.n++;
    perSupplier.set(l.supplier_id, e);
  }
  const sameSupplierWarnings = [...perSupplier.values()].filter((e) => e.n >= 2).map((e) => ({ supplierName: e.name, count: e.n }));
  return { products, images, sameSupplierWarnings };
}
