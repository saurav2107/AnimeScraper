"use client";
import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { toast } from "sonner";
import { Alert, Badge, Button, Modal } from "@/components/ui";
import { post } from "@/lib/client";

const SUP_HEADERS = ["Category", "Supplier", "Source URL", "Adapter", "Product URLs", "Sitemap URLs", "Text Filter", "Skip Terms", "Status"];
const CAT_HEADERS = ["Category", "Size Type", "Size Label", "Size Unit"];

const sheetOf = (rows: Array<Record<string, unknown>>, header: string[]) => {
  const ws = XLSX.utils.json_to_sheet(rows, { header });
  for (const a of Object.keys(ws)) { if (a.startsWith("!")) continue; const c = ws[a]; if (typeof c.v === "string") { c.t = "s"; delete c.f; } } // text only, never formulas
  ws["!cols"] = header.map((h) => ({ wch: h.includes("URL") ? 50 : 18 }));
  return ws;
};

/** Writes every registered (non-deleted) supplier, plus the category definitions needed to recreate them. */
export function exportSuppliers(state: any) {
  const sups: any[] = state.suppliers;
  if (!sups.length) return toast.message("No suppliers to export yet.");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheetOf(sups.map((s) => ({
    Category: s.category, Supplier: s.name, "Source URL": s.url, Adapter: s.config.adapter, "Product URLs": s.config.productUrls.join("\n"),
    "Sitemap URLs": s.config.sitemapUrls.join("\n"), "Text Filter": s.config.textFilter ?? "", "Skip Terms": s.config.excludeText ?? "", Status: s.status,
  })), SUP_HEADERS), "Suppliers");
  const used = new Set(sups.map((s) => s.categoryId));
  XLSX.utils.book_append_sheet(wb, sheetOf((state.categories as any[]).filter((c) => used.has(c.id)).map((c) => ({ Category: c.name, "Size Type": c.sizeKind, "Size Label": c.sizeLabel, "Size Unit": c.sizeUnit ?? "" })), CAT_HEADERS), "Categories");
  XLSX.writeFile(wb, `animecartel-suppliers-${new Date().toISOString().slice(0, 10)}.xlsx`);
  toast.success(`Exported ${sups.length} supplier${sups.length === 1 ? "" : "s"}`);
}

const pick = (r: Record<string, unknown>, ...names: string[]) => {
  for (const k of Object.keys(r)) if (names.includes(k.trim().toLowerCase())) return String(r[k] ?? "").trim();
  return "";
};

async function parseFile(file: File) {
  if (file.size > 5 * 1024 * 1024) throw new Error("That file is too large to be a supplier list.");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const find = (n: string) => wb.Sheets[wb.SheetNames.find((x) => x.trim().toLowerCase() === n) ?? ""];
  const supWs = find("suppliers") ?? wb.Sheets[wb.SheetNames[0]];
  if (!supWs) throw new Error("No Suppliers sheet found in this file.");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(supWs, { defval: "", raw: false })
    .map((r) => ({
      category: pick(r, "category"), name: pick(r, "supplier", "supplier name", "name"), url: pick(r, "source url", "url"), adapter: pick(r, "adapter") || "woocommerce-api",
      productUrls: pick(r, "product urls"), sitemapUrls: pick(r, "sitemap urls"), textFilter: pick(r, "text filter"), excludeText: pick(r, "skip terms", "exclude text"),
      wasActive: pick(r, "status").toLowerCase() === "active",
    }))
    .filter((r) => r.name || r.url || r.category);
  const catWs = find("categories");
  const categories = catWs ? XLSX.utils.sheet_to_json<Record<string, unknown>>(catWs, { defval: "", raw: false }).map((r) => ({ name: pick(r, "category", "name"), sizeKind: pick(r, "size type").toLowerCase(), sizeLabel: pick(r, "size label"), sizeUnit: pick(r, "size unit") || null })).filter((c) => c.name) : [];
  if (!rows.length) throw new Error("The Suppliers sheet has no rows.");
  return { rows, categories };
}

const tone = { add: "green", skip: "gray", error: "red" } as const;
const word = { add: "Will add", skip: "Already registered", error: "Can't import" } as const;

export function ImportSuppliersDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<{ rows: any[]; categories: any[] } | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [activate, setActivate] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [fin, setFin] = useState<any>(null);

  const reset = () => { setData(null); setPreview(null); setErr(""); setAck(false); setProgress(null); setFin(null); if (fileRef.current) fileRef.current.value = ""; };
  const close = () => { if (busy) return; reset(); onClose(); };

  async function choose(f?: File) {
    if (!f) return;
    reset(); setBusy(true);
    try {
      const d = await parseFile(f);
      setData(d);
      setPreview(await post("suppliers-import", { ...d, dryRun: true }));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function runImport() {
    if (!data) return;
    setBusy(true); setErr("");
    try {
      const r = await post("suppliers-import", { ...data, acknowledged: true });
      setFin(r);
      onDone();
      const toActivate = activate ? r.results.filter((x: any) => x.outcome === "add" && x.wasActive) : [];
      let failed = 0;
      if (toActivate.length) {
        setProgress({ done: 0, total: toActivate.length, failed: 0 });
        for (const [i, x] of toActivate.entries()) {
          try { await post("test", { id: x.id }); } catch { failed++; }
          setProgress({ done: i + 1, total: toActivate.length, failed });
        }
        onDone();
      }
      toast.success(`Imported ${r.counts.add} supplier${r.counts.add === 1 ? "" : "s"}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const c = (fin ?? preview)?.counts;
  return (
    <Modal open={open} onClose={close} wide title="Import suppliers from Excel"
      footer={fin ? <Button onClick={close} disabled={busy}>Done</Button> : <><Button variant="outline" onClick={close} disabled={busy}>Cancel</Button><Button onClick={runImport} loading={busy && !!preview} disabled={!preview || !ack || !preview.counts.add || busy}>{preview?.counts.add ? `Import ${preview.counts.add} supplier${preview.counts.add === 1 ? "" : "s"}` : "Import"}</Button></>}>
      <div className="space-y-3">
        {!fin && (
          <div>
            <p className="mb-2 text-sm text-gray-600">Choose a file exported with <b>Export to Excel</b>. Suppliers are registered as Paused; missing categories are created from the file. Nothing already registered is changed.</p>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" aria-label="Supplier spreadsheet" className="text-sm" disabled={busy} onChange={(e) => void choose(e.target.files?.[0])} />
          </div>
        )}
        {err && <Alert>{err}</Alert>}
        {c && (
          <p className="text-sm text-gray-700" role="status">
            {fin ? "Imported" : "Preview"}: <b className="text-green-700">{c.add} {fin ? "added" : "to add"}</b> · {c.skip} already registered · <b className={c.error ? "text-red-700" : ""}>{c.error} can&apos;t be imported</b>
            {(fin ?? preview).createdCategories.length > 0 && <> · {fin ? "created" : "will create"} categories: {(fin ?? preview).createdCategories.join(", ")}</>}
          </p>
        )}
        {progress && <Alert tone="blue">Testing & activating {progress.done} of {progress.total}…{progress.failed > 0 && ` ${progress.failed} failed the test and stay Paused; use Test & activate on them later.`}</Alert>}
        {(fin ?? preview) && (
          <div className="max-h-72 overflow-y-auto rounded-md border">
            <table className="w-full text-sm">
              <thead><tr><th className="th">Supplier</th><th className="th">Category</th><th className="th">Result</th></tr></thead>
              <tbody className="divide-y">
                {(fin ?? preview).results.map((r: any) => (
                  <tr key={r.row}><td className="td"><p className="font-medium">{r.name || "—"}</p><p className="max-w-[260px] truncate text-xs text-gray-500">{r.url}</p></td><td className="td">{r.category}</td><td className="td"><Badge tone={tone[r.outcome as keyof typeof tone]}>{word[r.outcome as keyof typeof word]}</Badge>{r.outcome !== "add" && <p className="mt-0.5 text-xs text-gray-500">{r.message}</p>}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {preview && !fin && preview.counts.add > 0 && (
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={activate} onChange={(e) => setActivate(e.target.checked)} />Test &amp; activate the suppliers that were Active when exported (one request per supplier to its public page)</label>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />I&apos;ve reviewed these suppliers&apos; terms and robots.txt and am allowed to collect their public product data.</label>
          </div>
        )}
      </div>
    </Modal>
  );
}
