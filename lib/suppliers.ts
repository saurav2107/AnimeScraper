import { z } from "zod";
import type { DB } from "@/db";
import { badRequest, conflict, notFound, zodError } from "./errors";
import { audit, httpUrl, isPublicHost, now, originOf, uid } from "./util";

export const ADAPTERS = ["jsonld", "jsonld-list", "woocommerce", "woocommerce-api", "shopify", "rendered"] as const;
export type Adapter = (typeof ADAPTERS)[number];

export interface SupplierConfig {
  adapter: Adapter;
  productUrls: string[];
  sitemapUrls: string[];
  termsAcknowledged: boolean;
  /** Optional: keep only product cards whose text contains this (e.g. "Action Figures"). Used by the rendered adapter. */
  textFilter?: string;
}

const urlList = z.array(z.string()).max(50).optional().default([]);
const body = z.object({
  id: z.string().optional(),
  categoryId: z.string({ message: "Choose a category." }).min(1, "Choose a category."),
  name: z.string().transform((s) => s.trim()).pipe(z.string().min(1, "Enter a supplier name.").max(80)),
  url: z.string().min(1, "Enter the supplier URL."),
  adapter: z.enum(ADAPTERS),
  productUrls: urlList,
  sitemapUrls: urlList,
  termsAcknowledged: z.boolean().optional().default(false),
  textFilter: z.string().max(80).optional().default(""),
});

export function parseConfig(raw: string): SupplierConfig {
  try {
    const c = JSON.parse(raw || "{}");
    return { adapter: c.adapter ?? "jsonld", productUrls: c.productUrls ?? [], sitemapUrls: c.sitemapUrls ?? [], termsAcknowledged: !!c.termsAcknowledged, textFilter: c.textFilter ?? "" };
  } catch {
    return { adapter: "jsonld", productUrls: [], sitemapUrls: [], termsAcknowledged: false };
  }
}

export interface SupplierRow {
  id: string;
  name: string;
  url: string;
  status: "Active" | "Paused" | "Deleted";
  categoryId: string;
  category: string;
  config: SupplierConfig;
  lastSuccess: string | null;
  deletedAt: string | null;
  listingCount: number;
}

export function listSuppliers(db: DB, deleted = false): SupplierRow[] {
  const rows = db.prepare(
    `SELECT s.id, s.name, s.url, s.status, s.category_id AS categoryId, c.name AS category, s.config, s.last_success AS lastSuccess, s.deleted_at AS deletedAt,
       (SELECT COUNT(*) FROM listings l WHERE l.supplier_id = s.id) AS listingCount
     FROM suppliers s JOIN categories c ON c.id = s.category_id
     WHERE ${deleted ? "s.status = 'Deleted'" : "s.status != 'Deleted'"} ORDER BY lower(c.name), lower(s.name)`,
  ).all() as Array<Omit<SupplierRow, "config"> & { config: string }>;
  return rows.map((r) => ({ ...r, config: parseConfig(r.config) }));
}

export function getSupplier(db: DB, id: string) {
  const r = db.prepare("SELECT id, name, url, status, category_id AS categoryId, config, last_success AS lastSuccess FROM suppliers WHERE id = ?").get(id) as
    | { id: string; name: string; url: string; status: string; categoryId: string; config: string; lastSuccess: string | null }
    | undefined;
  return r ? { ...r, config: parseConfig(r.config) } : undefined;
}

function checkUnique(db: DB, categoryId: string, url: string, excludeId: string) {
  const same = db.prepare("SELECT s.name FROM suppliers s WHERE s.status != 'Deleted' AND s.url = ? AND s.id != ?").get(url, excludeId) as { name: string } | undefined;
  if (same) throw badRequest(`This URL is already registered as ${same.name}.`, { field: "url" });
  const origin = originOf(url);
  const rows = db.prepare("SELECT s.url FROM suppliers s WHERE s.status != 'Deleted' AND s.category_id = ? AND s.id != ?").all(categoryId, excludeId) as Array<{ url: string }>;
  if (rows.some((r) => originOf(r.url) === origin)) {
    const cat = db.prepare("SELECT name FROM categories WHERE id = ?").get(categoryId) as { name: string };
    throw badRequest(`This website is already registered in ${cat.name}.`, { field: "url" });
  }
}

export function saveSupplier(db: DB, input: unknown): { id: string; status?: string; sourceChanged?: boolean } {
  const parsed = body.safeParse(input);
  if (!parsed.success) throw zodError(parsed.error);
  const v = parsed.data;
  const url = httpUrl(v.url);
  if (!url || new URL(url).protocol !== "https:") throw badRequest("Enter a public HTTPS URL.", { field: "url" });
  if (!isPublicHost(new URL(url).hostname)) throw badRequest("That address isn't a public website. Internal, localhost and private-network addresses aren't allowed.", { field: "url" });
  if (!v.termsAcknowledged) throw badRequest("Acknowledge the supplier's terms before saving.", { field: "termsAcknowledged" });
  const cat = db.prepare("SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL").get(v.categoryId);
  if (!cat) throw badRequest("Category no longer exists.", { field: "categoryId" });
  const pub = (u: string) => { const h = httpUrl(u); return h && isPublicHost(new URL(h).hostname) ? h : null; };
  const productUrls = v.productUrls.map(pub).filter((u): u is string => !!u);
  const sitemapUrls = v.sitemapUrls.map(pub).filter((u): u is string => !!u);
  const config: SupplierConfig = { adapter: v.adapter, productUrls, sitemapUrls, termsAcknowledged: true, textFilter: v.textFilter.trim() };

  if (!v.id) {
    checkUnique(db, v.categoryId, url, "");
    const id = uid();
    db.prepare("INSERT INTO suppliers (id, category_id, name, url, status, config, created) VALUES (?,?,?,?,?,?,?)").run(id, v.categoryId, v.name, url, "Paused", JSON.stringify(config), now());
    audit(db, "Save supplier", { id, name: v.name, url, categoryId: v.categoryId, created: true });
    return { id };
  }
  const cur = getSupplier(db, v.id);
  if (!cur || cur.status === "Deleted") throw notFound("Supplier not found.");
  const hasListings = !!db.prepare("SELECT 1 FROM listings WHERE supplier_id = ? LIMIT 1").get(v.id);
  if (hasListings && cur.categoryId !== v.categoryId) throw badRequest("Category can't be changed after products have been imported. Delete this supplier and register it again.", { field: "categoryId" });
  if (hasListings && originOf(cur.url) !== originOf(url)) throw badRequest("The website can't be changed after products have been imported. Delete this supplier and register it again.", { field: "url" });
  checkUnique(db, v.categoryId, url, v.id);
  // Only changes that affect what gets scraped require a fresh Test & activate (a rename keeps the status).
  const sourceChanged = cur.url !== url || cur.config.adapter !== config.adapter || JSON.stringify(cur.config.productUrls) !== JSON.stringify(productUrls) || JSON.stringify(cur.config.sitemapUrls) !== JSON.stringify(sitemapUrls) || (cur.config.textFilter ?? "") !== config.textFilter || cur.categoryId !== v.categoryId;
  const status = sourceChanged ? "Paused" : cur.status;
  db.prepare("UPDATE suppliers SET category_id=?, name=?, url=?, status=?, config=? WHERE id=?").run(v.categoryId, v.name, url, status, JSON.stringify(config), v.id);
  audit(db, "Save supplier", { id: v.id, name: v.name, url, categoryId: v.categoryId, sourceChanged });
  return { id: v.id, status, sourceChanged };
}

export function pauseSupplier(db: DB, id: unknown) {
  if (typeof id !== "string") throw badRequest("Missing supplier id.");
  const s = getSupplier(db, id);
  if (!s || s.status === "Deleted") throw notFound("Supplier not found.");
  db.prepare("UPDATE suppliers SET status = 'Paused' WHERE id = ?").run(id);
  audit(db, "Pause supplier", { id });
  return { ok: true };
}

export function isInRunningJob(db: DB, id: string): boolean {
  const jobs = db.prepare("SELECT selected FROM jobs WHERE status = 'Running'").all() as Array<{ selected: string }>;
  return jobs.some((j) => {
    try {
      return (JSON.parse(j.selected) as string[]).includes(id);
    } catch {
      return false;
    }
  });
}

export function deleteSupplier(db: DB, id: unknown) {
  if (typeof id !== "string") throw badRequest("Missing supplier id.");
  const s = getSupplier(db, id);
  if (!s || s.status === "Deleted") throw notFound("Supplier not found.");
  if (isInRunningJob(db, id)) throw conflict("A scraping run is using this supplier. Try again after it finishes.");
  db.prepare("UPDATE suppliers SET status = 'Deleted', deleted_at = ? WHERE id = ?").run(now(), id);
  audit(db, "Delete supplier", { id, name: s.name });
  return { ok: true };
}

export function restoreSupplier(db: DB, id: unknown) {
  if (typeof id !== "string") throw badRequest("Missing supplier id.");
  const s = getSupplier(db, id);
  if (!s || s.status !== "Deleted") throw notFound("Deleted supplier not found.");
  const cat = db.prepare("SELECT name FROM categories WHERE id = ? AND deleted_at IS NULL").get(s.categoryId) as { name: string } | undefined;
  if (!cat) {
    const old = db.prepare("SELECT name FROM categories WHERE id = ?").get(s.categoryId) as { name: string } | undefined;
    throw conflict(`Its category '${old?.name ?? "?"}' was deleted. Restore isn't possible.`);
  }
  const sameUrl = db.prepare("SELECT name FROM suppliers WHERE status != 'Deleted' AND url = ? AND id != ?").get(s.url, id) as { name: string } | undefined;
  if (sameUrl) throw conflict(`${sameUrl.name} already uses this URL. Delete it first.`);
  const origin = originOf(s.url);
  const others = db.prepare("SELECT name, url FROM suppliers WHERE status != 'Deleted' AND category_id = ? AND id != ?").all(s.categoryId, id) as Array<{ name: string; url: string }>;
  const clash = others.find((o) => originOf(o.url) === origin);
  if (clash) throw conflict(`${clash.name} already uses this website in ${cat.name}. Delete it first.`);
  db.prepare("UPDATE suppliers SET status = 'Paused', deleted_at = NULL WHERE id = ?").run(id);
  audit(db, "Restore supplier", { id, name: s.name });
  return { ok: true, status: "Paused" };
}
