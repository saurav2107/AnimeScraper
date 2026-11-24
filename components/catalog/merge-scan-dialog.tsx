"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2, ScanSearch } from "lucide-react";
import { Alert, Badge, Button, Modal, Thumb } from "@/components/ui";
import { fmtPrice, post } from "@/lib/client";

const tone = { High: "green", Medium: "amber", Low: "gray" } as const;
const chip = { good: "bg-green-50 text-green-800 ring-green-200", warn: "bg-amber-50 text-amber-900 ring-amber-200", neutral: "bg-gray-50 text-gray-700 ring-gray-200" } as const;

/**
 * Merge scan results. Suggestions only: nothing here merges. "Review & merge" hands the ids to the normal
 * Merge dialog, where the operator picks the name/image and confirms.
 */
export function MergeScanDialog({ open, categoryId, categoryName, mergedIds, onClose, onReview }: {
  open: boolean; categoryId: string | null; categoryName?: string; mergedIds: number;
  onClose: () => void; onReview: (ids: string[]) => void;
}) {
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Record<string, Set<string>>>({});
  const [minConf, setMinConf] = useState<"Low" | "Medium" | "High">("Low");
  const seq = useRef(0);

  /** keep=true is the automatic refresh after a merge: dismissed suggestions and removed items stay hidden. A manual Rescan starts fresh. */
  async function run(keep = false) {
    if (!categoryId) return;
    const my = ++seq.current;
    setBusy(true); setErr("");
    if (!keep) { setDismissed(new Set()); setRemoved({}); }
    try {
      const r = await post("merge-scan", { categoryId });
      if (my === seq.current) setRes(r);
    } catch (e) {
      if (my === seq.current) setErr((e as Error).message);
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }

  // a different category invalidates old results
  useEffect(() => { seq.current++; setRes(null); setErr(""); setBusy(false); setDismissed(new Set()); setRemoved({}); }, [categoryId]);
  // first open for this category starts the scan; later opens keep the results (use Rescan to refresh)
  useEffect(() => { if (open && !res && !busy && !err) void run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, categoryId]);
  // after a merge the old suggestions are stale (they may include merged products): rescan
  useEffect(() => { if (mergedIds > 0) { setRes(null); void run(true); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [mergedIds]);

  const toggle = (sid: string, pid: string) => setRemoved((m) => { const n = new Set(m[sid] ?? []); n.has(pid) ? n.delete(pid) : n.add(pid); return { ...m, [sid]: n }; });
  const rank = { Low: 0, Medium: 1, High: 2 } as const;
  const all: any[] = res?.suggestions ?? [];
  const shown = all.filter((s) => !dismissed.has(s.id) && rank[s.confidence as keyof typeof rank] >= rank[minConf]);

  return (
    <Modal open={open} onClose={onClose} wide title={<span className="flex items-center gap-2"><ScanSearch className="size-5 text-indigo-600" />Possible merges{categoryName ? ` · ${categoryName}` : ""}</span>}
      footer={<><Button variant="outline" onClick={() => void run(false)} disabled={busy}>{busy ? "Scanning…" : "Rescan"}</Button><Button onClick={onClose}>Close</Button></>}>
      <div className="space-y-3">
        <Alert tone="blue">Nothing is merged automatically. Each suggestion opens the normal Merge dialog so you can confirm the name and image, and you can undo any merge later.</Alert>
        {busy && (
          <div className="flex items-center gap-2 rounded-md border p-4 text-sm text-gray-600" role="status"><Loader2 className="size-4 animate-spin" />Comparing names, sizes and photos. The first scan downloads product images and can take a minute…</div>
        )}
        {err && <Alert>{err}</Alert>}
        {res && !busy && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
              <span>Scanned {res.scanned.toLocaleString()} products · found <b>{all.length}</b> possible merge{all.length === 1 ? "" : "s"}{dismissed.size > 0 && ` (${dismissed.size} dismissed)`}</span>
              <label className="flex items-center gap-1.5 text-xs">Show
                <select className="input w-32" aria-label="Minimum confidence" value={minConf} onChange={(e) => setMinConf(e.target.value as any)}>
                  <option value="Low">All matches</option><option value="Medium">Medium and up</option><option value="High">High only</option>
                </select>
              </label>
            </div>
            {res.imageAnalysis === "off" && <Alert tone="amber">Image comparison is unavailable on this server, so only names and sizes were compared.</Alert>}
            {res.imageAnalysis === "partial" && <Alert tone="amber">Only {res.imagesChecked} of {res.imagesTotal} photos were analysed before the time limit. Press Rescan to continue; analysed photos are remembered.</Alert>}
            {shown.length === 0 && <p className="rounded-md border border-dashed p-6 text-center text-sm text-gray-500">{all.length ? "No suggestions at this confidence level." : "No likely duplicates found in this category."}</p>}
            <ul className="space-y-3">
              {shown.map((s) => {
                const gone = removed[s.id] ?? new Set<string>();
                const keep = s.products.filter((p: any) => !gone.has(p.id));
                return (
                <li key={s.id} className="rounded-lg border bg-white p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-medium"><Badge tone={tone[s.confidence as keyof typeof tone]}>{s.confidence} confidence</Badge>{keep.length} of {s.products.length} products · {Math.round(s.score * 100)}% match</span>
                    <span className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setDismissed((d) => new Set(d).add(s.id))}>Dismiss</Button>
                      <Button size="sm" disabled={keep.length < 2} onClick={() => onReview(keep.map((p: any) => p.id))}>Review &amp; merge {keep.length}</Button>
                    </span>
                  </div>
                  <ul className="divide-y rounded-md border">
                    {s.products.map((p: any) => {
                      const out = gone.has(p.id);
                      return (
                      <li key={p.id} className="flex items-center gap-3 p-2">
                        <div className={out ? "opacity-40" : ""}><Thumb src={p.image} size={64} alt={p.name} zoom /></div>
                        <div className={`min-w-0 flex-1 ${out ? "opacity-50" : ""}`}>
                          <p className={`line-clamp-2 text-sm font-medium leading-snug ${out ? "line-through" : ""}`}>{p.name}</p>
                          <p className="truncate text-xs text-gray-500">{out ? "Won't be merged" : `${p.suppliers.join(", ") || "No supplier"}${p.size ? ` · ${p.size}` : ""}`}</p>
                        </div>
                        <span className={`text-sm font-semibold text-gray-800 ${out ? "opacity-50" : ""}`}>{p.price != null ? fmtPrice(p.price, p.currency) : "—"}</span>
                        {out
                          ? <Button size="sm" variant="ghost" onClick={() => toggle(s.id, p.id)}>Add back</Button>
                          : <Button size="sm" variant="ghost" disabled={keep.length <= 2} title={keep.length <= 2 ? "A merge needs at least two products. Dismiss the suggestion instead." : "Leave this product out of the merge"} aria-label={`Remove ${p.name} from this merge`} onClick={() => toggle(s.id, p.id)}>Remove</Button>}
                      </li>
                      );
                    })}
                  </ul>
                  <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Why these look alike">
                    {s.reasons.map((r: any, i: number) => <li key={i} className={`rounded-full px-2 py-0.5 text-xs ring-1 ${chip[r.level as keyof typeof chip]}`}><b>{r.label}:</b> {r.detail}</li>)}
                  </ul>
                </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
