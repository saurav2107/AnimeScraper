"use client";
import { useState } from "react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { Button, Card, PageHeader } from "@/components/ui";
import {get } from "@/lib/client";

const SCOPES = [
  ["all", "All products"], ["new", "New products"], ["price_changes", "Price changes"], ["merged", "Merged products"], ["current", "Current results (grid search & filters)"],
] as const;

/** Builds the 6-sheet workbook client-side. Cells are written as inline strings so formulas can't execute. */
export async function buildWorkbook(query: Record<string, string | undefined>) {
  const d = await get("export-data", query);
  const wb = XLSX.utils.book_new();
  const sheets: Array<[string, any[], string[]]> = [
    ["Product Master", d.products, d.headers.products], ["Supplier Listings", d.listings, d.headers.listings], ["New Products", d.listings.filter((l: any) => l.Status === "NEW"), d.headers.listings],
    ["Price Changes", d.priceChanges, d.headers.priceChanges], ["Merge History", d.merges, d.headers.merges], ["Removed – Unavailable", d.removed, d.headers.removed],
  ];
  for (const [name, rows, headers] of sheets) {
    // json_to_sheet with an explicit header keeps column order and still writes headers when there are no rows.
    const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
    for (const addr of Object.keys(ws)) {
      if (addr.startsWith("!")) continue;
      const c = ws[addr];
      if (typeof c.v === "string") { c.t = "s"; delete c.f; }
    }
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const empty = d.products.length === 0;
  return { wb, empty };
}

export async function downloadWorkbook(query: Record<string, string | undefined>) {
  const { wb, empty } = await buildWorkbook(query);
  XLSX.writeFile(wb, `animecartel-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
  if (empty) toast.message("No rows matched; the workbook contains headers only.");
  else toast.success("Export downloaded");
}

export function ExportPage({ categories, categoryId, gridQuery }: { categories: any[]; categoryId: string | null; gridQuery: Record<string, string | undefined> }) {
  const [scope, setScope] = useState("all");
  const [catScope, setCatScope] = useState<"current" | "all">("current");
  const [busy, setBusy] = useState(false);
  const catName = categories.find((c) => c.id === categoryId)?.name ?? "—";
  async function go() {
    setBusy(true);
    try {
      const category = catScope === "all" ? "all" : categoryId ?? "all";
      await downloadWorkbook(scope === "current" ? { ...gridQuery, category, scope } : { category, scope });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader title="Export Reports" subtitle="Excel workbook with Product Master, Supplier Listings, New Products, Price Changes, Merge History and Removed sheets." />
      <Card className="max-w-xl space-y-5 p-5">
        <fieldset><legend className="label">Category</legend>
          <label className="mr-5 text-sm"><input type="radio" checked={catScope === "current"} onChange={() => setCatScope("current")} /> Current category ({catName})</label>
          <label className="text-sm"><input type="radio" checked={catScope === "all"} onChange={() => setCatScope("all")} /> All categories</label>
        </fieldset>
        <fieldset><legend className="label">Content</legend>
          {SCOPES.map(([v, l]) => (
            <label key={v} className="block py-0.5 text-sm"><input type="radio" checked={scope === v} disabled={v === "current" && catScope === "all"} onChange={() => setScope(v)} /> {l}</label>
          ))}
          <p className="mt-2 text-xs text-gray-500">To export selected products, tick them in All Products and use “Export selected”.</p>
        </fieldset>
        <Button loading={busy} onClick={go}>Download .xlsx</Button>
      </Card>
    </>
  );
}
