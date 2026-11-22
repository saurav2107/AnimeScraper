import { z } from "zod";
import type { DB } from "@/db";
import { badRequest, conflict, notFound, zodError } from "./errors";
import { audit, now, uid } from "./util";

export type SizeKind = "height" | "length" | "scale" | "other";

const body = z.object({
  id: z.string().optional(),
  name: z.string().transform((s) => s.trim()).pipe(z.string().min(1, "Enter a name.").max(60, "Name must be 60 characters or fewer.")),
  sizeKind: z.enum(["height", "length", "scale", "other"]),
  sizeLabel: z.string().transform((s) => s.trim()).pipe(z.string().min(1, "Enter a size label.").max(30, "Size label must be 30 characters or fewer.")),
  sizeUnit: z.string().max(10, "Size unit must be 10 characters or fewer.").optional().nullable(),
});

export function listCategories(db: DB) {
  const rows = db.prepare(
    `SELECT c.id, c.name, c.size_kind AS sizeKind, c.size_label AS sizeLabel, c.size_unit AS sizeUnit,
       (SELECT COUNT(*) FROM suppliers s WHERE s.category_id = c.id AND s.status != 'Deleted') AS supplierCount,
       (SELECT COUNT(*) FROM groups g WHERE g.category_id = c.id AND g.status = 'Active'
          AND EXISTS (SELECT 1 FROM listings l JOIN suppliers s ON s.id = l.supplier_id WHERE l.group_id = g.id AND s.status != 'Deleted')) AS productCount,
       EXISTS (SELECT 1 FROM listings l JOIN suppliers s ON s.id = l.supplier_id WHERE s.category_id = c.id) AS hasListings
     FROM categories c WHERE c.deleted_at IS NULL ORDER BY lower(c.name)`,
  ).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...r, hasListings: !!r.hasListings }));
}

export function getCategory(db: DB, id: string) {
  const c = db.prepare("SELECT id, name, size_kind AS sizeKind, size_label AS sizeLabel, size_unit AS sizeUnit FROM categories WHERE id = ? AND deleted_at IS NULL").get(id) as
    | { id: string; name: string; sizeKind: SizeKind; sizeLabel: string; sizeUnit: string | null }
    | undefined;
  return c;
}

export function saveCategory(db: DB, input: unknown): { id: string } {
  const parsed = body.safeParse(input);
  if (!parsed.success) throw zodError(parsed.error);
  const v = parsed.data;
  const unit = (v.sizeUnit ?? "").trim() || null;
  if ((v.sizeKind === "height" || v.sizeKind === "length") && !unit) throw badRequest("Enter a size unit.", { field: "sizeUnit" });
  const dup = db.prepare("SELECT id FROM categories WHERE deleted_at IS NULL AND lower(name) = lower(?) AND id != ?").get(v.name, v.id ?? "");
  if (dup) throw badRequest("A category with this name already exists.", { field: "name" });
  const t = now();
  if (!v.id) {
    const id = uid();
    db.prepare("INSERT INTO categories (id,name,size_kind,size_label,size_unit,created,updated) VALUES (?,?,?,?,?,?,?)").run(id, v.name, v.sizeKind, v.sizeLabel, unit, t, t);
    audit(db, "Create category", { id, name: v.name, sizeKind: v.sizeKind });
    return { id };
  }
  const before = db.prepare("SELECT * FROM categories WHERE id = ? AND deleted_at IS NULL").get(v.id) as Record<string, unknown> | undefined;
  if (!before) throw notFound("Category not found.");
  if (before.size_kind !== v.sizeKind) {
    const has = db.prepare("SELECT 1 FROM listings l JOIN suppliers s ON s.id = l.supplier_id WHERE s.category_id = ? LIMIT 1").get(v.id);
    if (has) throw badRequest("Size type can't be changed after products have been imported.", { field: "sizeKind" });
  }
  db.prepare("UPDATE categories SET name=?, size_kind=?, size_label=?, size_unit=?, updated=? WHERE id=?").run(v.name, v.sizeKind, v.sizeLabel, unit, t, v.id);
  audit(db, "Update category", { id: v.id, before, after: { name: v.name, sizeKind: v.sizeKind, sizeLabel: v.sizeLabel, sizeUnit: unit } });
  return { id: v.id };
}

export function deleteCategory(db: DB, id: unknown) {
  if (typeof id !== "string") throw badRequest("Missing category id.");
  const c = db.prepare("SELECT id, name FROM categories WHERE id = ? AND deleted_at IS NULL").get(id) as { id: string; name: string } | undefined;
  if (!c) throw notFound("Category not found.");
  const sups = db.prepare("SELECT id, name FROM suppliers WHERE category_id = ? AND status IN ('Active','Paused') ORDER BY name").all(id) as Array<{ id: string; name: string }>;
  if (sups.length) throw conflict(`This category still has ${sups.length} supplier(s). Delete them first.`, { suppliers: sups });
  db.prepare("UPDATE categories SET deleted_at = ?, updated = ? WHERE id = ?").run(now(), now(), id);
  audit(db, "Delete category", { id, name: c.name });
  return { ok: true };
}
