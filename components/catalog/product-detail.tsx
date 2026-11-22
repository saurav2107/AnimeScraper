"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Modal, Skeleton, Thumb } from "@/components/ui";
import { fmtDate, fmtPrice, get, isDemo, post } from "@/lib/client";

const statusTone = (s: string) => (s === "NEW" ? "indigo" : s === "PRICE UPDATED" ? "amber" : s === "OUT OF STOCK" ? "gray" : s === "REMOVED" ? "red" : "green");

function History({ rows }: { rows: Array<{ listingId: string; price: number | null; recordedAt: string }> }) {
  const pts = rows.filter((r) => r.price != null);
  if (pts.length < 2) return <p className="text-sm text-gray-500">Not enough history yet. History is kept for 30 days.</p>;
  const t = pts.map((p) => Date.parse(p.recordedAt));
  const [t0, t1] = [Math.min(...t), Math.max(...t)];
  const v = pts.map((p) => p.price as number);
  const [v0, v1] = [Math.min(...v), Math.max(...v)];
  const W = 560, H = 120, P = 24;
  const x = (ms: number) => P + (t1 === t0 ? 0 : ((ms - t0) / (t1 - t0)) * (W - 2 * P));
  const y = (val: number) => H - P - (v1 === v0 ? (H - 2 * P) / 2 : ((val - v0) / (v1 - v0)) * (H - 2 * P));
  const ids = [...new Set(pts.map((p) => p.listingId))];
  const colors = ["#4f46e5", "#16a34a", "#d97706", "#db2777", "#0891b2"];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Price history, last 30 days">
      <text x={4} y={14} fontSize="10" fill="#6b7280">{fmtPrice(v1)}</text>
      <text x={4} y={H - 8} fontSize="10" fill="#6b7280">{fmtPrice(v0)}</text>
      {ids.map((id, i) => (
        <polyline key={id} fill="none" stroke={colors[i % colors.length]} strokeWidth="2" points={pts.filter((p) => p.listingId === id).map((p) => `${x(Date.parse(p.recordedAt))},${y(p.price as number)}`).join(" ")} />
      ))}
    </svg>
  );
}

export function ProductDetail({ productId, onClose, onChanged }: { productId: string | null; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!productId) return;
    setData(null);
    setErr("");
    get(`products/${productId}`).then(setData).catch((e) => setErr(e.message));
  }, [productId]);

  const images: string[] = data ? [...new Set<string>(data.listings.flatMap((l: any) => l.images))] : [];
  const newOnes = data?.listings.filter((l: any) => l.status === "NEW") ?? [];

  async function acknowledge() {
    try {
      for (const l of newOnes) await post("acknowledge", { id: l.id });
      toast.success("New listings acknowledged");
      onChanged();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Modal open={!!productId} onClose={onClose} wide title={data ? data.name : "Product"} footer={newOnes.length ? <Button disabled={isDemo()} onClick={acknowledge}>Acknowledge new listings</Button> : undefined}>
      {err && <Alert>{err}</Alert>}
      {!data && !err && <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-32" /></div>}
      {data && (
        <div className="space-y-5">
          <div className="flex items-start gap-4">
            <Thumb src={data.image} size={96} alt={data.name} zoom={images.length ? images : true} />
            <div className="space-y-1">
              <div className="flex flex-wrap gap-2"><Badge tone="blue">{data.category.name}</Badge>{data.isMerged && <Badge tone="indigo">Merged</Badge>}</div>
              <p className="text-sm text-gray-600">{data.sizeLabel}{data.sizeUnit ? ` (${data.sizeUnit})` : ""}: <b>{data.size ?? "—"}</b></p>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead><tr><th className="th">Supplier</th><th className="th">Listing</th><th className="th text-right">Price</th><th className="th">Stock</th><th className="th">Status</th></tr></thead>
              <tbody className="divide-y">
                {data.listings.map((l: any) => (
                  <tr key={l.id}>
                    <td className="td">{l.supplier.name}</td>
                    <td className="td max-w-[280px]">{l.url ? <a className="text-indigo-700 hover:underline" href={l.url} target="_blank" rel="noreferrer">{l.name}</a> : l.name}</td>
                    <td className="td text-right">{fmtPrice(l.price, l.currency)}{l.previousPrice != null && l.status === "PRICE UPDATED" && <span className="ml-1 text-xs text-gray-400 line-through">{fmtPrice(l.previousPrice, l.currency)}</span>}</td>
                    <td className="td">{l.stock}</td>
                    <td className="td"><Badge tone={statusTone(l.status) as any}>{l.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <section>
            <h3 className="mb-1 text-sm font-semibold">Price history (last 30 days)</h3>
            <History rows={data.priceHistory} />
          </section>
          {images.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Images</h3>
              <div className="flex flex-wrap gap-2">{images.map((u) => <Thumb key={u} src={u} size={72} alt={data.name} zoom={images} />)}</div>
            </section>
          )}
          <p className="text-xs text-gray-400">Last scraped {fmtDate(data.listings[0]?.scraped)}</p>
        </div>
      )}
    </Modal>
  );
}

/** "+N more": every listing from one supplier inside a product (FR-GRID-04). */
export function SupplierListings({ target, onClose }: { target: { productId: string; supplierId: string; supplierName: string } | null; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    if (!target) return;
    setData(null);
    get(`products/${target.productId}`).then(setData).catch(() => setData({ listings: [] }));
  }, [target]);
  const rows = data?.listings.filter((l: any) => l.supplier.id === target?.supplierId) ?? [];
  return (
    <Modal open={!!target} onClose={onClose} title={`${target?.supplierName ?? ""} listings`}>
      {!data ? <Skeleton className="h-20" /> : (
        <ul className="divide-y">
          {rows.map((l: any) => {
            const dead = l.stock === "Out of stock" || l.status === "REMOVED";
            return (
              <li key={l.id} className="flex items-center justify-between gap-3 py-2">
                <div className={dead ? "opacity-50" : ""}>
                  {dead || !l.url ? <span>{l.name}</span> : <a href={l.url} target="_blank" rel="noreferrer" className="text-indigo-700 hover:underline">{l.name}</a>}
                  <div className="text-xs text-gray-500">{l.stock}</div>
                </div>
                <div className="flex items-center gap-2">
                  {l.status === "REMOVED" ? <Badge tone="red">Removed</Badge> : <span className={dead ? "opacity-50" : "font-medium"}>{fmtPrice(l.price, l.currency)}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
