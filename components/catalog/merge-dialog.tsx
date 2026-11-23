"use client";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";
import { Alert, Button, Lightbox, Modal, Skeleton, Thumb } from "@/components/ui";
import {get, post } from "@/lib/client";

export function MergeDialog({ open, ids, onClose, onMerged }: { open: boolean; ids: string[]; onClose: () => void; onMerged: (name: string, n: number) => void }) {
  const [prev, setPrev] = useState<any>(null);
  const [err, setErr] = useState("");
  const [nameChoice, setNameChoice] = useState<string>("");
  const [custom, setCustom] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState("");
  const [peek, setPeek] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setPrev(null); setErr(""); setCustom(""); setNote(""); setFormErr("");
    get("merge-preview", { ids: ids.join(",") })
      .then((p) => {
        setPrev(p);
        setNameChoice(p.products[0].id);
        setImage(p.products[0].image ?? p.images[0]?.url ?? null);
      })
      .catch((e) => setErr(e.message));
  }, [open, ids]);

  const finalName = nameChoice === "__custom" ? custom.trim() : prev?.products.find((p: any) => p.id === nameChoice)?.name ?? "";
  const totalListings = prev?.products.reduce((a: number, p: any) => a + p.listingCount, 0) ?? 0;

  async function submit() {
    if (!finalName) return setFormErr("Enter a name.");
    if (finalName.length > 200) return setFormErr("Name must be 200 characters or fewer.");
    setBusy(true); setFormErr("");
    try {
      await post("merge", { productIds: ids, name: finalName, image, note: note.trim() || undefined });
      onMerged(finalName, ids.length);
    } catch (e) {
      setFormErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()} onSubmit={submit} wide title={`Merge ${ids.length} products`}
      footer={<><Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" loading={busy} disabled={!prev}>{busy ? "Merging…" : `Merge ${ids.length} products`}</Button></>}>
      {err && <Alert>{err}</Alert>}
      {!prev && !err && <Skeleton className="h-40" />}
      {prev && (
        <fieldset disabled={busy} className="space-y-5">
          <section>
            <h3 className="mb-2 text-sm font-semibold">1. Name</h3>
            <div className="space-y-1.5">
              {prev.products.map((p: any, idx: number) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-md border p-2 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50">
                  <input type="radio" name="name" data-autofocus={idx === 0 ? "" : undefined} checked={nameChoice === p.id} onChange={() => setNameChoice(p.id)} />
                  <Thumb src={p.image} size={36} alt={p.name} zoom />
                  <span className="flex-1">{p.name}</span>
                  <span className="text-xs text-gray-500">{p.supplierCount} supplier{p.supplierCount === 1 ? "" : "s"}</span>
                </label>
              ))}
              <label className="flex cursor-pointer items-center gap-3 rounded-md border p-2 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50">
                <input type="radio" name="name" checked={nameChoice === "__custom"} onChange={() => setNameChoice("__custom")} />
                <span className="text-sm">Custom name</span>
                <div className="flex-1"><input className="input" placeholder="Type a name" value={custom} onFocus={() => setNameChoice("__custom")} onChange={(e) => { setCustom(e.target.value); setFormErr(""); }} maxLength={220} aria-label="Custom name" />{custom.length > 0 && <p className={`mt-0.5 text-right text-xs ${custom.trim().length > 200 ? "text-red-600" : "text-gray-400"}`}>{custom.trim().length}/200</p>}</div>
              </label>
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">2. Image</h3>
            <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
              {prev.images.length === 0 && <p className="text-sm text-gray-500">No images available. The merged product will use the placeholder.</p>}
              {prev.images.map((im: any, n: number) => (
                <div key={im.url} className="relative">
                  <button type="button" onClick={() => setImage(im.url)} title={im.supplierName} aria-pressed={image === im.url} className={clsx("rounded-md border-2 p-0.5", image === im.url ? "border-indigo-600" : "border-transparent hover:border-gray-300")}>
                    <Thumb src={im.url} size={72} />
                    <span className="block max-w-[72px] truncate text-[10px] text-gray-500">{im.supplierName}</span>
                  </button>
                  <button type="button" aria-label="Preview full size" title="Preview full size" onClick={() => setPeek(n)} className="absolute right-1 top-1 rounded bg-white/90 p-0.5 text-gray-700 shadow hover:bg-white"><Maximize2 className="size-3" /></button>
                </div>
              ))}
              {prev.images.length > 0 && (
                <button type="button" onClick={() => setImage(null)} aria-pressed={image === null} className={clsx("flex size-[72px] items-center justify-center rounded-md border-2 text-xs text-gray-500", image === null ? "border-indigo-600" : "border-dashed")}>No image</button>
              )}
            </div>
          </section>
          <section>
            <h3 className="mb-1 text-sm font-semibold">3. Note <span className="font-normal text-gray-400">(optional)</span></h3>
            <textarea className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why are these the same product?" />
            <p className="text-right text-xs text-gray-400">{note.length}/500</p>
          </section>
          <section className="space-y-2">
            <p className="text-sm text-gray-600">{ids.length} products · {totalListings} listings will be combined. Merging can be undone from the Unmerge page.</p>
            {prev.sameSupplierWarnings.map((w: any) => (
              <Alert key={w.supplierName} tone="blue">{w.supplierName} will have {w.count} listings in this product; the lowest price will be shown.</Alert>
            ))}
            {formErr && <Alert>{formErr}</Alert>}
          </section>
        </fieldset>
      )}
      {peek !== null && prev && <Lightbox images={prev.images.map((x: any) => x.url)} index={peek} title="Choose this image by clicking its tile" onClose={() => setPeek(null)} />}
    </Modal>
  );
}
