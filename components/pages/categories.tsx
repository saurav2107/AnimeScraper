"use client";
import clsx from "clsx";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, Button, Card, Empty, FieldError, Modal, PageHeader } from "@/components/ui";
import { ApiError, del, isDemo, post } from "@/lib/client";

const DEFAULTS: Record<string, { label: string; unit: string }> = { height: { label: "Height", unit: "cm" }, length: { label: "Length", unit: "cm" }, scale: { label: "Scale", unit: "ratio" }, other: { label: "", unit: "" } };

export function CategoriesPage({ categories, suppliers, onChanged, goSuppliers }: { categories: any[]; suppliers: any[]; onChanged: () => void; goSuppliers: () => void }) {
  const [edit, setEdit] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [err, setErr] = useState<{ message: string; field?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<any>(null);
  const [delErr, setDelErr] = useState<string | null>(null);

  const open = (c?: any) => {
    setErr(null);
    setEdit(c ?? {});
    setForm(c ? { id: c.id, name: c.name, sizeKind: c.sizeKind, sizeLabel: c.sizeLabel, sizeUnit: c.sizeUnit ?? "", locked: c.hasListings } : { name: "", sizeKind: "height", sizeLabel: "Height", sizeUnit: "cm" });
  };
  const change = (patch: Record<string, unknown>) => { setForm((f: any) => ({ ...f, ...patch })); setErr(null); };
  const setKind = (k: string) =>
    setForm((f: any) => {
      const prev = DEFAULTS[f.sizeKind];
      // only replace the label/unit if the user hasn't customised them
      const keepLabel = f.sizeLabel !== prev.label, keepUnit = f.sizeUnit !== prev.unit;
      return { ...f, sizeKind: k, sizeLabel: keepLabel ? f.sizeLabel : DEFAULTS[k].label, sizeUnit: keepUnit ? f.sizeUnit : DEFAULTS[k].unit };
    });
  const fe = (field: string) => (err?.field === field ? err.message : undefined);
  const bad = (field: string) => (err?.field === field ? "border-red-500" : "");

  async function save() {
    setBusy(true); setErr(null);
    try {
      await post("categories", { id: form.id, name: form.name, sizeKind: form.sizeKind, sizeLabel: form.sizeLabel, sizeUnit: form.sizeUnit || null });
      toast.success(form.id ? "Category updated" : "Category created");
      setEdit(null); onChanged();
    } catch (e) { setErr({ message: (e as Error).message, field: (e as ApiError).data?.field }); } finally { setBusy(false); }
  }

  const blockers = removing ? suppliers.filter((s) => s.categoryId === removing.id) : [];
  async function remove() {
    setBusy(true); setDelErr(null);
    try { await del("categories", { id: removing.id }); toast.success("Category deleted"); setRemoving(null); onChanged(); }
    catch (e) { setDelErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Categories" subtitle="A category defines what a supplier registration fetches and what “Size” means." actions={<Button disabled={isDemo()} onClick={() => open()}>Add category</Button>} />
      {categories.length === 0 ? (
        <Empty title="No categories yet">Create a category before registering suppliers.</Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr><th className="th">Name</th><th className="th">Size</th><th className="th text-right">Suppliers</th><th className="th text-right">Products</th><th className="th sticky right-0" /></tr></thead>
            <tbody className="divide-y">
              {categories.map((c) => (
                <tr key={c.id}>
                  <td className="td font-medium">{c.name}</td>
                  <td className="td">{c.sizeLabel}{c.sizeUnit ? ` (${c.sizeUnit})` : ""}</td>
                  <td className="td text-right">{c.supplierCount}</td>
                  <td className="td text-right">{c.productCount}</td>
                  <td className="td sticky right-0 bg-white text-right"><div className="flex justify-end gap-2"><Button size="sm" variant="outline" disabled={isDemo()} onClick={() => open(c)}>Edit</Button><Button size="sm" variant="outline" disabled={isDemo()} onClick={() => { setDelErr(null); setRemoving(c); }}>Delete</Button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Modal open={!!edit} onClose={() => setEdit(null)} onSubmit={save} title={form.id ? "Edit category" : "Add category"} footer={<><Button variant="outline" onClick={() => setEdit(null)}>Cancel</Button><Button type="submit" loading={busy}>Save</Button></>}>
        <div className="space-y-3">
          {err && !err.field && <Alert>{err.message}</Alert>}
          <div>
            <label className="label" htmlFor="cn">Name</label>
            <input id="cn" className={clsx("input", bad("name"))} aria-invalid={!!fe("name")} maxLength={60} value={form.name ?? ""} onChange={(e) => change({ name: e.target.value })} />
            <FieldError>{fe("name")}</FieldError>
          </div>
          <div>
            <label className="label" htmlFor="ck">Size type</label>
            <select id="ck" className={clsx("input", bad("sizeKind"))} value={form.sizeKind} disabled={form.locked} onChange={(e) => { setKind(e.target.value); setErr(null); }}>
              <option value="height">Height (cm)</option><option value="length">Length (cm)</option><option value="scale">Scale (1:N)</option><option value="other">Other</option>
            </select>
            <FieldError>{fe("sizeKind")}</FieldError>
            <p className="mt-1 text-xs text-gray-500">{form.locked ? "Locked: products have been imported into this category." : "Can't be changed once products are imported. Suggested: Action Figures → Height, Katanas → Length, Die-cast Models → Scale."}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="cl">Size label</label><input id="cl" className={clsx("input", bad("sizeLabel"))} aria-invalid={!!fe("sizeLabel")} maxLength={30} value={form.sizeLabel ?? ""} onChange={(e) => change({ sizeLabel: e.target.value })} /><FieldError>{fe("sizeLabel")}</FieldError></div>
            <div><label className="label" htmlFor="cu">Size unit</label><input id="cu" className={clsx("input", bad("sizeUnit"))} aria-invalid={!!fe("sizeUnit")} maxLength={10} value={form.sizeUnit ?? ""} onChange={(e) => change({ sizeUnit: e.target.value })} /><FieldError>{fe("sizeUnit")}</FieldError></div>
          </div>
        </div>
      </Modal>

      <Modal open={!!removing} onClose={() => setRemoving(null)} title={`Delete category '${removing?.name ?? ""}'?`} footer={<><Button variant="outline" onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" loading={busy} disabled={blockers.length > 0} onClick={remove}>Delete category</Button></>}>
        {blockers.length > 0 ? (
          <Alert>
            This category still has {blockers.length} supplier{blockers.length === 1 ? "" : "s"}. Delete {blockers.length === 1 ? "it" : "them"} first:
            <ul className="mt-1 list-disc pl-5">{blockers.map((s) => <li key={s.id}>{s.name} <span className="text-red-600/70">({s.status})</span></li>)}</ul>
            <button type="button" className="mt-2 font-medium underline" onClick={() => { setRemoving(null); goSuppliers(); }}>Go to Suppliers</button>
          </Alert>
        ) : <p className="text-sm text-gray-600">This can&apos;t be undone from the app.</p>}
        {delErr && <div className="mt-3"><Alert>{delErr}</Alert></div>}
      </Modal>
    </>
  );
}
