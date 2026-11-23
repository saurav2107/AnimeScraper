"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, Button, FieldError, Modal } from "@/components/ui";
import { ApiError, post } from "@/lib/client";

export interface SizeTarget {
  id: string;
  name: string;
  size: string | null;
  sizeManual: boolean;
}
export interface SizeCategory {
  sizeKind: "height" | "length" | "scale" | "other";
  sizeLabel: string;
  sizeUnit: string | null;
}

const HINT: Record<string, string> = {
  height: "Enter the height as a number in cm, for example 30 or 24.5.",
  length: "Enter the length as a number in cm, for example 104.",
  scale: "Enter the scale as 1:18, 1/18, or just 18.",
  other: "Up to 30 characters.",
};

/** Type in (or clear) a product's size by hand. A manual size wins over scraped ones and survives re-scrapes. */
export function SizeDialog({ target, category, onClose, onSaved }: { target: SizeTarget | null; category: SizeCategory | null; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!target) return;
    setValue(target.size ?? "");
    setErr("");
  }, [target]);
  if (!target || !category) return null;
  const label = `${category.sizeLabel}${category.sizeUnit && category.sizeKind !== "scale" ? ` (${category.sizeUnit})` : ""}`;

  async function save(next: string) {
    setBusy(true);
    setErr("");
    try {
      const r = await post("product-size", { productId: target!.id, value: next });
      toast.success(r.size ? `${category!.sizeLabel} set to ${r.size}` : "Manual size cleared");
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      onSubmit={() => save(value)}
      title={`${category.sizeLabel} for “${target.name.length > 48 ? target.name.slice(0, 47) + "…" : target.name}”`}
      footer={
        <>
          {target.sizeManual && <Button variant="outline" className="mr-auto" disabled={busy} onClick={() => save("")}>Clear manual value</Button>}
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" loading={busy}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="size-input">{label}</label>
          <input id="size-input" className={err ? "input border-red-500" : "input"} aria-invalid={!!err} inputMode={category.sizeKind === "other" ? "text" : "decimal"} placeholder={category.sizeKind === "scale" ? "1:18" : category.sizeKind === "other" ? "" : "e.g. 30"} value={value} maxLength={30} onChange={(e) => { setValue(e.target.value); setErr(""); }} />
          <FieldError>{err}</FieldError>
          <p className="mt-1 text-xs text-gray-500">{HINT[category.sizeKind]}</p>
        </div>
        <Alert tone="blue">
          {target.sizeManual ? "This size was entered manually." : target.size ? `Currently ${target.size}, read from the supplier's listing.` : "No size could be read from the supplier listings."}{" "}
          A size you enter is kept when suppliers are scraped again. Leave the box empty and save, or use “Clear manual value”, to go back to the scraped size.
        </Alert>
      </div>
    </Modal>
  );
}
