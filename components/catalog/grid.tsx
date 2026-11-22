"use client";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Columns3, Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Empty, Modal, Skeleton, Thumb, useDismiss } from "@/components/ui";
import { get, isDemo, post } from "@/lib/client";
import { MergeDialog } from "./merge-dialog";
import { PriceCell, type Cell } from "./price-cell";
import { ProductDetail, SupplierListings } from "./product-detail";

interface Item { id: string; name: string; image: string | null; size: string | null; lowestPrice: number | null; isMerged: boolean; cells: Record<string, Cell> }
interface Supplier { id: string; name: string; status: string }

const LS = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore (EC-27) */ } },
};

const WIDE = { check: 40, image: 64, name: 260, size: 96, supplier: 140 };
const NARROW = { check: 32, image: 56, name: 150, size: 72, supplier: 120 };

/** Below 900px only the checkbox and name stay pinned; image and size scroll with the prices. */
function useNarrow() {
  const [n, setN] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const f = () => setN(mq.matches);
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return n;
}

export function ProductGrid({
  categories, categoryId, setCategoryId, preset, onExportSelected, onChanged, onQuery,
}: {
  categories: Array<{ id: string; name: string; productCount: number }>;
  categoryId: string | null;
  setCategoryId: (id: string) => void;
  preset?: "new" | "priceChanged";
  onExportSelected?: (ids: string[]) => void;
  onChanged: () => void;
  onQuery?: (p: Record<string, string | undefined>) => void;
}) {
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [sort, setSort] = useState("name_asc");
  const [inStock, setInStock] = useState(false);
  const [minP, setMinP] = useState("");
  const [maxP, setMaxP] = useState("");
  const [fNew, setFNew] = useState(false);
  const [fPc, setFPc] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showCols, setShowCols] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<Item[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [catInfo, setCatInfo] = useState<any>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [detail, setDetail] = useState<string | null>(null);
  const [more, setMore] = useState<{ productId: string; supplierId: string; supplierName: string } | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [ackOpen, setAckOpen] = useState(false);
  const narrow = useNarrow();
  const W = narrow ? NARROW : WIDE;
  const LEFT = narrow ? { check: 0, image: 0, name: W.check, size: 0 } : { check: 0, image: W.check, name: W.check + W.image, size: W.check + W.image + W.name };
  const pin = (k: "check" | "image" | "name" | "size") => (narrow && (k === "image" || k === "size") ? {} : { position: "sticky" as const, left: LEFT[k] });
  const filtersRef = useDismiss(showFilters, () => setShowFilters(false));
  const colsRef = useDismiss(showCols, () => setShowCols(false));
  const reqId = useRef(0);
  const inflight = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const priceErr = minP !== "" && maxP !== "" && Number(minP) > Number(maxP) ? "Minimum can't exceed maximum." : "";
  const priceOk = (v: string) => v === "" || /^\d+$/.test(v);
  const priceInvalid = !priceOk(minP) || !priceOk(maxP) || !!priceErr;
  const newOn = preset === "new" || fNew;
  const pcOn = preset === "priceChanged" || fPc;

  useEffect(() => { const t = setTimeout(() => setQDebounced(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  // Per-category column visibility (FR-GRID-08)
  useEffect(() => {
    if (!categoryId) return;
    try { setHidden(new Set(JSON.parse(LS.get(`cols:${categoryId}`) ?? "[]"))); } catch { setHidden(new Set()); }
    setSelected(new Map()); // selection is cleared on category switch (FR-GRID-01)
  }, [categoryId]);

  const params = useMemo(() => ({
    category: categoryId ?? undefined, q: qDebounced || undefined, sort,
    inStock: inStock ? "1" : undefined, minPrice: priceInvalid ? undefined : minP || undefined, maxPrice: priceInvalid ? undefined : maxP || undefined,
    new: newOn ? "1" : undefined, priceChanged: pcOn ? "1" : undefined,
  }), [categoryId, qDebounced, sort, inStock, minP, maxP, priceInvalid, newOn, pcOn]);

  useEffect(() => { onQuery?.(params as Record<string, string | undefined>); }, [params, onQuery]);

  const load = useCallback(async (append: boolean, cur: string | null) => {
    if (!categoryId || inflight.current && append) return;
    const id = ++reqId.current;
    if (append) { inflight.current = true; setMoreLoading(true); setMoreError(""); } else { setLoading(true); setError(""); }
    try {
      const r = await get("products", { ...params, cursor: append ? cur : undefined });
      if (id !== reqId.current) return; // stale response
      setSuppliers(r.suppliers); setCatInfo(r.category); setTotal(r.total); setCursor(r.nextCursor);
      setItems((prev) => {
        if (!append) return r.items;
        const seen = new Set(prev.map((p) => p.id)); // dedupe by id (EC-22)
        return [...prev, ...r.items.filter((i: Item) => !seen.has(i.id))];
      });
    } catch (e: any) {
      if (id !== reqId.current) return;
      if (e.status === 404) { // category deleted elsewhere (EC-14)
        toast.error("That category no longer exists.");
        onChanged();
      } else if (append) setMoreError(e.message); else setError(e.message);
    } finally {
      if (append) { inflight.current = false; setMoreLoading(false); } else setLoading(false);
    }
  }, [categoryId, params, onChanged]);

  useEffect(() => { void load(false, null); }, [load]);

  // Infinite scroll: load when the sentinel is within 400px of the viewport
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting && !loading) void load(true, cursor); }, { root: scroller.current, rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loading, load]);

  const visibleSuppliers = suppliers.filter((s) => !hidden.has(s.id));
  const fallbackSort = sort.startsWith("supplier:") && !suppliers.some((s) => sort.split(":")[1] === s.id);
  useEffect(() => { if (fallbackSort && suppliers.length) setSort("name_asc"); }, [fallbackSort, suppliers.length]);

  const toggleHidden = (id: string) => {
    const n = new Set(hidden);
    n.has(id) ? n.delete(id) : n.add(id);
    setHidden(n);
    if (categoryId) LS.set(`cols:${categoryId}`, JSON.stringify([...n]));
  };
  const cycleSort = (asc: string, desc: string) => setSort(sort === asc ? desc : asc);
  const arrow = (asc: string, desc: string) => (sort === asc ? <ArrowUp className="size-3" /> : sort === desc ? <ArrowDown className="size-3" /> : null);
  const activeFilters = (inStock ? 1 : 0) + (minP || maxP ? 1 : 0) + (!preset && fNew ? 1 : 0) + (!preset && fPc ? 1 : 0);
  const resetFilters = () => { setInStock(false); setMinP(""); setMaxP(""); setFNew(false); setFPc(false); };
  const toggleSel = (it: Item) => setSelected((m) => { const n = new Map(m); n.has(it.id) ? n.delete(it.id) : n.set(it.id, it.name); return n; });

  const sizeHeader = catInfo ? `${catInfo.sizeLabel}${catInfo.sizeUnit ? ` ${catInfo.sizeUnit}` : ""}` : "Size";
  if (!categories.length) return <Empty title="No categories yet">Create a category before registering suppliers. Open <b>Categories</b> in the sidebar.</Empty>;

  const stickyHead = "sticky top-0 z-20 bg-gray-50";

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Category" className={clsx("flex gap-1", categories.length > 6 && "hidden")}>
          {categories.map((c) => (
            <button key={c.id} role="tab" aria-selected={c.id === categoryId} onClick={() => setCategoryId(c.id)} className={clsx("rounded-md px-3 py-1.5 text-sm font-medium", c.id === categoryId ? "bg-indigo-600 text-white" : "bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50")}>
              {c.name}{!preset && <span className="ml-1 opacity-70">{c.productCount}</span>}
            </button>
          ))}
        </div>
        {categories.length > 6 && (
          <select className="input w-56" aria-label="Category" value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value)}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{preset ? "" : ` (${c.productCount})`}</option>)}
          </select>
        )}
        {preset === "new" && total > 0 && <Button variant="outline" size="sm" disabled={isDemo()} onClick={() => setAckOpen(true)}>Acknowledge all</Button>}
        <span className="text-sm text-gray-500" aria-live="polite">{loading ? "Loading…" : `${total.toLocaleString()} ${total === 1 ? "product" : "products"}`}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-gray-400" />
          <input className="input pl-8 pr-8" placeholder="Search name…" aria-label="Search products" maxLength={100} value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button aria-label="Clear search" onClick={() => setQ("")} className="absolute right-2 top-2.5 text-gray-400 hover:text-gray-700"><X className="size-4" /></button>}
        </div>
        <select className="input w-52" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="name_asc">Name A→Z</option>
          <option value="name_desc">Name Z→A</option>
          <option value="lowest_asc">Lowest price ↑</option>
          <option value="lowest_desc">Lowest price ↓</option>
          <option value="size_asc">{sizeHeader} ↑</option>
          <option value="size_desc">{sizeHeader} ↓</option>
          {suppliers.map((s) => <option key={s.id + "a"} value={`supplier:${s.id}:asc`}>{s.name} price ↑</option>)}
          {suppliers.map((s) => <option key={s.id + "d"} value={`supplier:${s.id}:desc`}>{s.name} price ↓</option>)}
        </select>
        <div className="relative" ref={filtersRef}>
          <Button variant="outline" onClick={() => { setShowFilters((v) => !v); setShowCols(false); }}><SlidersHorizontal className="size-4" />Filters{activeFilters > 0 && <Badge tone="indigo">{activeFilters}</Badge>}</Button>
          {showFilters && (
            <div className="absolute left-0 top-10 z-40 w-72 space-y-3 rounded-lg border bg-white p-4 shadow-lg">
              <label className="flex items-center justify-between text-sm">In stock<input type="checkbox" checked={inStock} onChange={(e) => setInStock(e.target.checked)} /></label>
              <label className="flex items-center justify-between text-sm">New<input type="checkbox" checked={newOn} disabled={preset === "new"} onChange={(e) => setFNew(e.target.checked)} /></label>
              <label className="flex items-center justify-between text-sm">Price changed<input type="checkbox" checked={pcOn} disabled={preset === "priceChanged"} onChange={(e) => setFPc(e.target.checked)} /></label>
              <div>
                <span className="label">Price range (₹)</span>
                <div className="flex gap-2">
                  <input className="input" inputMode="numeric" placeholder="Min" aria-label="Minimum price" value={minP} onChange={(e) => setMinP(e.target.value)} />
                  <input className="input" inputMode="numeric" placeholder="Max" aria-label="Maximum price" value={maxP} onChange={(e) => setMaxP(e.target.value)} />
                </div>
                {priceInvalid && <p className="mt-1 text-xs text-red-600">{priceErr || "Use whole numbers ≥ 0."}</p>}
              </div>
              <Button variant="ghost" size="sm" onClick={resetFilters}>Reset filters</Button>
            </div>
          )}
        </div>
        <div className="relative" ref={colsRef}>
          <Button variant="outline" onClick={() => { setShowCols((v) => !v); setShowFilters(false); }}><Columns3 className="size-4" />Columns</Button>
          {showCols && (
            <div className="absolute left-0 top-10 z-40 w-60 space-y-2 rounded-lg border bg-white p-4 shadow-lg">
              {suppliers.length === 0 && <p className="text-sm text-gray-500">No suppliers.</p>}
              {suppliers.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!hidden.has(s.id)} onChange={() => toggleHidden(s.id)} />{s.name}</label>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <Alert>Couldn&apos;t load products. {error} <button className="ml-2 underline" onClick={() => load(false, null)}>Retry</button></Alert>}

      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto rounded-lg border bg-white">
        <table className="border-separate border-spacing-0 text-sm" style={{ minWidth: W.check + W.image + W.name + W.size + visibleSuppliers.length * W.supplier }}>
          <thead>
            <tr>
              <th className={clsx(stickyHead, "z-30 border-b px-2")} style={{ width: W.check, minWidth: W.check, ...pin("check") }}><span className="sr-only">Select</span></th>
              <th className={clsx(stickyHead, "z-30 border-b text-left th")} style={{ width: W.image, minWidth: W.image, ...pin("image") }}>Image</th>
              <th className={clsx(stickyHead, "z-30 border-b th")} style={{ width: W.name, minWidth: W.name, ...pin("name") }}>
                <button className="inline-flex items-center gap-1 uppercase" onClick={() => cycleSort("name_asc", "name_desc")}>Name {arrow("name_asc", "name_desc")}</button>
              </th>
              <th className={clsx(stickyHead, "z-30 border-b border-r th")} style={{ width: W.size, minWidth: W.size, ...pin("size") }}>
                <button className="inline-flex items-center gap-1 uppercase" onClick={() => cycleSort("size_asc", "size_desc")}>{sizeHeader} {arrow("size_asc", "size_desc")}</button>
              </th>
              {visibleSuppliers.map((s) => (
                <th key={s.id} className={clsx(stickyHead, "border-b th text-right")} style={{ width: W.supplier, minWidth: W.supplier }} title={s.name}>
                  <button className="inline-flex items-center gap-1 uppercase" onClick={() => cycleSort(`supplier:${s.id}:asc`, `supplier:${s.id}:desc`)}>
                    <span className={clsx("size-2 rounded-full", s.status === "Active" ? "bg-green-500" : "bg-gray-400")} />
                    {s.name.length > 18 ? s.name.slice(0, 17) + "…" : s.name}
                    {arrow(`supplier:${s.id}:asc`, `supplier:${s.id}:desc`)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 8 }).map((_, i) => (
              <tr key={i}><td colSpan={4 + Math.max(visibleSuppliers.length, 1)} className="border-b p-2"><Skeleton className="h-12" /></td></tr>
            ))}
            {!loading && items.map((it) => {
              const sel = selected.has(it.id);
              const bg = sel ? "bg-indigo-50" : "bg-white";
              return (
                <tr key={it.id} className="group h-16">
                  <td className={clsx("border-b px-2", bg)} style={{ ...pin("check"), zIndex: 10 }}>
                    <input type="checkbox" aria-label={`Select ${it.name}`} checked={sel} onChange={() => toggleSel(it)} />
                  </td>
                  <td className={clsx("border-b px-2", bg)} style={{ ...pin("image"), zIndex: 10 }}><Thumb src={it.image} size={48} alt={it.name} zoom /></td>
                  <td className={clsx("border-b px-3", bg)} style={{ ...pin("name"), zIndex: 10, maxWidth: W.name }}>
                    <button onClick={() => setDetail(it.id)} title={it.name} className="line-clamp-2 text-left font-medium hover:text-indigo-700 hover:underline">{it.name}</button>
                    {it.isMerged && <Badge tone="indigo">Merged</Badge>}
                  </td>
                  <td className={clsx("border-b border-r px-3 text-gray-700", bg)} style={{ ...pin("size"), zIndex: 10 }}>{it.size ?? "—"}</td>
                  {visibleSuppliers.map((s) => (
                    <td key={s.id} className={clsx("border-b px-3 text-right", bg)}>
                      <PriceCell cell={it.cells[s.id] ?? { state: "none" }} onMore={() => setMore({ productId: it.id, supplierId: s.id, supplierName: s.name })} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>

        {!loading && !error && items.length === 0 && (
          suppliers.length === 0 ? (
            <div className="p-6"><Empty title={`No suppliers registered in ${catInfo?.name ?? "this category"}`}>Add one on the Suppliers page.</Empty></div>
          ) : (
            <div className="p-6">
              {preset && !qDebounced && activeFilters === 0 ? (
                <Empty title={preset === "new" ? `No new arrivals in ${catInfo?.name ?? "this category"}` : `No price changes in ${catInfo?.name ?? "this category"}`}>
                  {preset === "new" ? "New listings appear here after a scrape finds them." : "Changes appear here when a scrape finds a different price."}
                </Empty>
              ) : (
                <Empty title={qDebounced ? `No products match '${qDebounced}'` : "No products match the current filters"}>
                  <Button variant="outline" size="sm" onClick={() => { setQ(""); resetFilters(); }}>{qDebounced ? "Clear search" : "Reset filters"}</Button>
                </Empty>
              )}
            </div>
          )
        )}
        <div ref={sentinel} className="h-1" />
        {moreLoading && <p className="py-3 text-center text-sm text-gray-500">Loading more…</p>}
        {moreError && <p className="py-3 text-center text-sm text-red-600">Couldn&apos;t load more — <button className="underline" onClick={() => load(true, cursor)}>Retry</button></p>}
        {!loading && !cursor && items.length > 0 && <p className="py-3 text-center text-xs text-gray-400">All {total.toLocaleString()} {total === 1 ? "product" : "products"} loaded</p>}
      </div>

      {selected.size > 0 && (
        <div className="sticky bottom-0 flex items-center gap-3 rounded-lg border bg-white px-4 py-2.5 shadow-lg" role="region" aria-label="Selection">
          <b>{selected.size} selected</b>
          <Button disabled={selected.size < 2 || isDemo()} onClick={() => setMergeOpen(true)} title={isDemo() ? "Merging is disabled in demo mode" : selected.size < 2 ? "Select at least two products" : undefined}>Merge</Button>
          {onExportSelected && <Button variant="outline" onClick={() => onExportSelected([...selected.keys()])}>Export selected</Button>}
          <Button variant="ghost" onClick={() => setSelected(new Map())}>Clear</Button>
        </div>
      )}

      <Modal open={ackOpen} onClose={() => setAckOpen(false)} title="Acknowledge all new listings?" footer={<><Button variant="outline" onClick={() => setAckOpen(false)}>Cancel</Button><Button onClick={async () => { try { const r = await post("acknowledge", { categoryId }); toast.success(`${r.count} listing${r.count === 1 ? "" : "s"} acknowledged`); setAckOpen(false); onChanged(); void load(false, null); } catch (e) { toast.error((e as Error).message); } }}>Acknowledge all</Button></>}>
        <p className="text-sm text-gray-600">Every new listing in {catInfo?.name ?? "this category"} will be marked as seen and will leave New Arrivals. Prices and products are not changed.</p>
      </Modal>
      <ProductDetail productId={detail} onClose={() => setDetail(null)} onChanged={() => { onChanged(); void load(false, null); }} />
      <SupplierListings target={more} onClose={() => setMore(null)} />
      <MergeDialog
        open={mergeOpen}
        ids={[...selected.keys()]}
        onClose={() => setMergeOpen(false)}
        onMerged={(name, n) => { setMergeOpen(false); setSelected(new Map()); toast.success(`Merged ${n} products into '${name}'`); onChanged(); void load(false, null); }}
      />
    </div>
  );
}
