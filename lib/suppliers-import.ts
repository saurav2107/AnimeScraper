import { z } from "zod";
import type { DB } from "@/db";
import { badRequest } from "./errors";
import { saveCategory } from "./categories";
import { saveSupplier } from "./suppliers";
import { audit } from "./util";

// Restore suppliers from a spreadsheet exported by this app (or filled in by hand). Rows go through the same
// validation as the Add supplier form, so private/non-HTTPS URLs and duplicates are rejected the same way.

const MAX_ROWS = 500;
const list = z.union([z.string(), z.array(z.string())]).optional().transform((v) => (Array.isArray(v) ? v : (v ?? "").split(/\r?\n/)).map((x) => x.trim()).filter(Boolean));
const rowSchema = z.object({
  category: z.string().default(""), name: z.string().default(""), url: z.string().default(""), adapter: z.string().default("woocommerce-api"),
  productUrls: list, sitemapUrls: list, textFilter: z.string().optional().default(""), excludeText: z.string().optional().default(""), wasActive: z.boolean().optional().default(false),
});
const catSchema = z.object({ name: z.string(), sizeKind: z.enum(["height", "length", "scale", "other"]).catch("other"), sizeLabel: z.string().catch(""), sizeUnit: z.string().nullish() });
const bodySchema = z.object({ rows: z.array(z.unknown()), categories: z.array(z.unknown()).optional().default([]), acknowledged: z.boolean().optional().default(false), dryRun: z.boolean().optional().default(false) });

export interface ImportRowResult {
  row: number; name: string; category: string; url: string;
  outcome: "add" | "skip" | "error"; message: string; id?: string; wasActive?: boolean;
}

class Rollback extends Error {}

export function importSuppliers(db: DB, input: unknown) {
  const b = bodySchema.safeParse(input);
  if (!b.success) throw badRequest("The import data is not valid.");
  const { rows, dryRun, acknowledged } = b.data;
  if (!rows.length) throw badRequest("The file has no supplier rows.");
  if (rows.length > MAX_ROWS) throw badRequest(`Import at most ${MAX_ROWS} suppliers at a time.`);
  if (!dryRun && !acknowledged) throw badRequest("Confirm that you have reviewed the suppliers' terms before importing.");
  const defs = new Map<string, z.infer<typeof catSchema>>();
  for (const c of b.data.categories) { const p = catSchema.safeParse(c); if (p.success && p.data.name.trim()) defs.set(p.data.name.trim().toLowerCase(), p.data); }

  const results: ImportRowResult[] = [];
  const createdCategories: string[] = [];
  const run = () => {
    const catId = new Map<string, string>();
    const findCat = (n: string) => (db.prepare("SELECT id FROM categories WHERE deleted_at IS NULL AND lower(name) = lower(?)").get(n) as { id: string } | undefined)?.id;
    rows.forEach((raw, i) => {
      const p = rowSchema.safeParse(raw);
      const n = i + 1;
      if (!p.success) return results.push({ row: n, name: "", category: "", url: "", outcome: "error", message: "Row is not valid." });
      const r = p.data;
      const base = { row: n, name: r.name.trim(), category: r.category.trim(), url: r.url.trim() };
      if (!base.name || !base.url || !base.category) return results.push({ ...base, outcome: "error", message: "Category, supplier name and URL are required." });
      let cid = catId.get(base.category.toLowerCase()) ?? findCat(base.category);
      if (!cid) {
        const d = defs.get(base.category.toLowerCase());
        if (!d) return results.push({ ...base, outcome: "error", message: `Category '${base.category}' doesn't exist and isn't defined in the file's Categories sheet.` });
        try {
          cid = saveCategory(db, { name: d.name, sizeKind: d.sizeKind, sizeLabel: d.sizeLabel || "Size", sizeUnit: d.sizeUnit ?? (d.sizeKind === "height" || d.sizeKind === "length" ? "cm" : null) }).id;
          createdCategories.push(d.name.trim());
        } catch (e) { return results.push({ ...base, outcome: "error", message: `Couldn't create category: ${(e as Error).message}` }); }
      }
      catId.set(base.category.toLowerCase(), cid);
      try {
        const s = saveSupplier(db, { categoryId: cid, name: base.name, url: base.url, adapter: r.adapter, productUrls: r.productUrls, sitemapUrls: r.sitemapUrls, textFilter: r.textFilter, excludeText: r.excludeText, termsAcknowledged: true });
        results.push({ ...base, outcome: "add", message: "Added as Paused", id: s.id, wasActive: r.wasActive });
      } catch (e) {
        const msg = (e as Error).message;
        results.push({ ...base, outcome: /already registered/i.test(msg) ? "skip" : "error", message: msg });
      }
    });
    if (dryRun) throw new Rollback();
    audit(db, "Import suppliers", { added: results.filter((x) => x.outcome === "add").length, total: rows.length });
  };
  try { db.transaction(run)(); } catch (e) { if (!(e instanceof Rollback)) throw e; }
  const count = (o: string) => results.filter((x) => x.outcome === o).length;
  return { dryRun, results, createdCategories, counts: { add: count("add"), skip: count("skip"), error: count("error") } };
}
