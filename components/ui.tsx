"use client";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, Loader2, Maximize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Close a popover on outside click or Escape. */
export function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) cb.current(); };
    const key = (e: KeyboardEvent) => e.key === "Escape" && cb.current();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  return ref;
}

export function FieldError({ id, children }: { id?: string; children?: React.ReactNode }) {
  return children ? <p id={id} role="alert" className="mt-1 text-xs text-red-600">{children}</p> : null;
}

export function Button({ variant = "default", size = "md", className, loading, children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "outline" | "danger" | "ghost"; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      type="button"
      {...p}
      disabled={p.disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "default" && "bg-indigo-600 text-white hover:bg-indigo-700",
        variant === "outline" && "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        variant === "ghost" && "text-gray-700 hover:bg-gray-100",
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function Modal({ open, onClose, title, children, footer, wide, onSubmit }: { open: boolean; onClose: () => void; title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean; onSubmit?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose; // keep the effect below independent of inline onClose callbacks (no refocus on re-render)
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const root = ref.current;
    const focusables = () => Array.from(root?.querySelectorAll<HTMLElement>('input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href]') ?? []).filter((el) => el.offsetParent !== null);
    // focus the first form control, else the dialog itself
    const first = root?.querySelector<HTMLElement>("[data-autofocus], input:not([type=radio]):not([type=checkbox]):not(:disabled), select:not(:disabled), textarea:not(:disabled)");
    (first ?? root)?.focus();
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") return closeRef.current();
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return e.preventDefault();
      const a = document.activeElement as HTMLElement;
      if (e.shiftKey && (a === f[0] || a === root)) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && a === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    window.addEventListener("keydown", h);
    return () => { window.removeEventListener("keydown", h); (opener.current as HTMLElement | null)?.focus?.(); };
  }, [open]);
  if (!open) return null;
  const body = (
    <>
      <div className="overflow-y-auto px-5 py-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t px-5 py-3">{footer}</div>}
    </>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" className={clsx("flex max-h-[90vh] w-full flex-col rounded-xl bg-white shadow-xl outline-none", wide ? "max-w-4xl" : "max-w-lg")}>
        <div className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-gray-500 hover:bg-gray-100"><X className="size-4" /></button>
        </div>
        {onSubmit ? <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>{body}</form> : body}
      </div>
    </div>
  );
}

export function Badge({ children, tone = "gray" }: { children: React.ReactNode; tone?: "gray" | "green" | "red" | "amber" | "blue" | "indigo" }) {
  const t = { gray: "bg-gray-100 text-gray-700", green: "bg-green-100 text-green-800", red: "bg-red-100 text-red-800", amber: "bg-amber-100 text-amber-800", blue: "bg-blue-100 text-blue-800", indigo: "bg-indigo-100 text-indigo-800" }[tone];
  return <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", t)}>{children}</span>;
}

export function Alert({ children, tone = "red" }: { children: React.ReactNode; tone?: "red" | "blue" | "amber" }) {
  const t = { red: "border-red-200 bg-red-50 text-red-800", blue: "border-blue-200 bg-blue-50 text-blue-800", amber: "border-amber-200 bg-amber-50 text-amber-900" }[tone];
  return <div role={tone === "red" ? "alert" : undefined} className={clsx("rounded-md border px-3 py-2 text-sm", t)}>{children}</div>;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={clsx("relative h-5 w-9 rounded-full transition disabled:opacity-50", checked ? "bg-indigo-600" : "bg-gray-300")}>
      <span className={clsx("absolute top-0.5 size-4 rounded-full bg-white transition-all", checked ? "left-4.5" : "left-0.5")} />
    </button>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-white px-6 py-12 text-center">
      <p className="font-medium text-gray-800">{title}</p>
      {children && <div className="text-sm text-gray-500">{children}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded bg-gray-200", className)} />;
}

export const Card = ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={clsx("rounded-lg border bg-white", className)}>{children}</div>;

/** Full-size image viewer. Esc closes only the viewer (not a dialog underneath); ←/→ move through the images. */
export function Lightbox({ images, index, title, onClose }: { images: string[]; index: number; title?: string; onClose: () => void }) {
  const [i, setI] = useState(index);
  const [failed, setFailed] = useState(false);
  const n = images.length;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => setFailed(false), [i]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); closeRef.current(); }
      else if (e.key === "ArrowRight" && n > 1) { e.stopImmediatePropagation(); setI((x) => (x + 1) % n); }
      else if (e.key === "ArrowLeft" && n > 1) { e.stopImmediatePropagation(); setI((x) => (x - 1 + n) % n); }
    };
    window.addEventListener("keydown", h, true); // capture: runs before any dialog's own Escape handler
    return () => window.removeEventListener("keydown", h, true);
  }, [n]);
  const nav = "absolute top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 text-gray-800 shadow hover:bg-white";
  // Portal to <body>: a sticky table cell creates its own stacking context and would otherwise trap the overlay beneath the grid header.
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label={title ? `Image preview: ${title}` : "Image preview"} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <button type="button" aria-label="Close preview" autoFocus onClick={onClose} className="absolute right-4 top-4 rounded-full bg-white/90 p-2 text-gray-800 shadow hover:bg-white"><X className="size-5" /></button>
      {n > 1 && <button type="button" aria-label="Previous image" onClick={() => setI((x) => (x - 1 + n) % n)} className={clsx(nav, "left-4")}><ChevronLeft className="size-5" /></button>}
      {n > 1 && <button type="button" aria-label="Next image" onClick={() => setI((x) => (x + 1) % n)} className={clsx(nav, "right-4")}><ChevronRight className="size-5" /></button>}
      <figure className="flex max-h-full max-w-full flex-col items-center gap-2" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {failed ? (
          <div className="flex h-64 w-80 items-center justify-center rounded bg-white/10 text-sm text-white">Image unavailable</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={images[i]} alt={title ?? ""} onError={() => setFailed(true)} className="max-h-[82vh] max-w-[92vw] rounded bg-white object-contain shadow-2xl" />
        )}
        <figcaption className="max-w-[90vw] text-center text-sm text-white">{title}{n > 1 && <span className="ml-2 text-white/70">{i + 1} / {n}</span>}</figcaption>
      </figure>
    </div>,
    document.body,
  );
}

/** Thumbnail. With `zoom`, clicking it opens a full-size preview (zoom = list of images to browse, or true for just this one). */
export function Thumb({ src, size = 48, alt = "", zoom }: { src?: string | null; size?: number; alt?: string; zoom?: string[] | true }) {
  const [open, setOpen] = useState(false);
  const style = { width: size, height: size };
  if (!src) return <div style={style} className="flex shrink-0 items-center justify-center rounded bg-gray-100 text-[10px] text-gray-400">No img</div>;
  // eslint-disable-next-line @next/next/no-img-element
  const img = <img src={src} alt={alt} style={style} className="shrink-0 rounded bg-gray-100 object-cover" loading="lazy" onError={(e) => ((e.currentTarget.style.visibility = "hidden"), undefined)} />;
  if (!zoom) return img;
  const list = zoom === true || !zoom.length ? [src] : zoom;
  return (
    <>
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(true); }} aria-label={`Preview image${alt ? `: ${alt}` : ""}`} className="shrink-0 cursor-zoom-in rounded outline-offset-2 hover:ring-2 hover:ring-indigo-300 focus-visible:ring-2 focus-visible:ring-indigo-500">{img}</button>
      {open && <Lightbox images={list} index={Math.max(0, list.indexOf(src))} title={alt} onClose={() => setOpen(false)} />}
    </>
  );
}

export { Maximize2 };
