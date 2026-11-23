"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Card, Empty, Modal, PageHeader, Skeleton, Thumb } from "@/components/ui";
import {fmtDate, get, post } from "@/lib/client";

export function UnmergePage({ categories, onChanged }: { categories: Array<{ id: string; name: string }>; onChanged: () => void }) {
  const [cat, setCat] = useState<string>("all");
  const [q, setQ] = useState("");
  const [qd, setQd] = useState("");
  const [items, setItems] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<any>(null);
  const [impact, setImpact] = useState<any>(null);
  const [impactErr, setImpactErr] = useState("");
  const [busy, setBusy] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  useEffect(() => { const t = setTimeout(() => setQd(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async (append: boolean, cur: string | null) => {
    const id = ++reqId.current;
    setLoading(!append); setError("");
    try {
      const r = await get("merges", { category: cat, q: qd || undefined, cursor: append ? cur : undefined });
      if (id !== reqId.current) return;
      setItems((p) => (append ? [...p, ...r.items] : r.items));
      setCursor(r.nextCursor);
    } catch (e: any) { if (id === reqId.current) setError(e.message); } finally { if (id === reqId.current) setLoading(false); }
  }, [cat, qd]);
  useEffect(() => { void load(false, null); }, [load]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && void load(true, cursor), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, load]);

  async function openUndo(ev: any) {
    setTarget(ev); setImpact(null); setImpactErr("");
    try { setImpact(await get(`merges/${ev.id}/undo-impact`)); } catch (e) { setImpactErr((e as Error).message); }
  }
  async function confirmUndo() {
    setBusy(true); setImpactErr("");
    try {
      const r = await post("unmerge", { mergeEventId: target.id, token: impact.token });
      toast.success(`Merge undone. ${r.restoredProductIds.length} products restored.`);
      setTarget(null); onChanged(); void load(false, null);
    } catch (e) { setImpactErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Unmerge" subtitle="Every merge is recorded. Undoing a merge restores the original products with their names and images." />
      <div className="mb-3 flex flex-wrap gap-2">
        <select className="input w-56" aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input className="input w-64" placeholder="Search merged or source name" aria-label="Search merges" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <Alert>{error} <button className="ml-2 underline" onClick={() => load(false, null)}>Retry</button></Alert>}
      {loading && <Skeleton className="h-40" />}
      {!loading && !error && items.length === 0 && (cat !== "all" || qd ? <Empty title="No merges match these filters"><button className="underline" onClick={() => { setCat("all"); setQ(""); }}>Show all merges</button></Empty> : <Empty title="No merges yet. Select two or more products in All Products to merge them." />)}
      {items.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>{["Date", "Merged product", "Category", "Source products", "Listings", "Note", "Status", ""].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody className="divide-y">
              {items.map((m) => (
                <tr key={m.id} className={m.undoneAt ? "bg-gray-50 text-gray-400" : ""}>
                  <td className="td whitespace-nowrap">{fmtDate(m.created)}</td>
                  <td className="td"><div className="flex items-center gap-2"><Thumb src={m.result.image} size={36} alt={m.result.name} zoom /><span className="font-medium">{m.result.name}</span></div></td>
                  <td className="td">{m.category.name}</td>
                  <td className="td max-w-xs"><Sources sources={m.sources} /></td>
                  <td className="td text-right">{m.listingCount}</td>
                  <td className="td max-w-[200px]">{m.note ?? "—"}</td>
                  <td className="td whitespace-nowrap">{m.undoneAt ? `Undone on ${new Date(m.undoneAt).toLocaleDateString("en-IN")}` : <Badge tone="green">Active</Badge>}</td>
                  <td className="td">{!m.undoneAt && <Button size="sm" variant="outline" onClick={() => openUndo(m)}>Undo merge</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <div ref={sentinel} className="h-1" />

      <Modal open={!!target} onClose={() => !busy && setTarget(null)} wide title={`Undo merge of '${target?.result.name ?? ""}'?`}
        footer={<><Button variant="outline" onClick={() => setTarget(null)} disabled={busy}>Cancel</Button><Button variant="danger" disabled={!impact} loading={busy} onClick={confirmUndo}>{busy ? "Undoing…" : `Undo ${impact ? 1 + impact.dependents.length : 1} merge${impact && impact.dependents.length ? "s" : ""}`}</Button></>}>
        {!impact && !impactErr && <p className="text-sm text-gray-500">Checking related merges…</p>}
        {impactErr && <Alert>{impactErr}</Alert>}
        {impact && (
          <div className="space-y-4">
            {impact.dependents.length > 0 && (
              <Alert tone="amber">
                <p className="font-medium">This will also undo {impact.dependents.length} later merge{impact.dependents.length > 1 ? "s" : ""}:</p>
                <ul className="mt-1 list-disc pl-5">{impact.dependents.map((d: any) => <li key={d.id}>{fmtDate(d.created)} — {d.name}{d.note ? ` (“${d.note}”)` : ""}</li>)}</ul>
              </Alert>
            )}
            <div>
              <p className="mb-2 text-sm font-medium">These products will be restored:</p>
              <ul className="space-y-1.5">{impact.restoredProducts.map((p: any) => <li key={p.id} className="flex items-center gap-2"><Thumb src={p.image} size={32} alt={p.name} zoom />{p.name}</li>)}</ul>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function Sources({ sources }: { sources: Array<{ id: string; name: string }> }) {
  const [open, setOpen] = useState(false);
  const shown = open ? sources : sources.slice(0, 3);
  return (
    <div>
      <ul className="list-disc pl-4">{shown.map((s) => <li key={s.id}>{s.name}</li>)}</ul>
      {sources.length > 3 && <button className="text-xs text-indigo-600 hover:underline" onClick={() => setOpen(!open)}>{open ? "Show less" : `+${sources.length - 3} more`}</button>}
    </div>
  );
}
