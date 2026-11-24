"use client";
import clsx from "clsx";
import { FileDown, History, LayoutDashboard, Loader2, Package, Play, Settings, Sparkles, Store, Tags, TrendingDown, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { ProductGrid } from "./catalog/grid";
import { CategoriesPage } from "./pages/categories";
import { Dashboard } from "./pages/dashboard";
import { downloadWorkbook, ExportPage } from "./pages/export";
import { HistoryPage } from "./pages/history";
import { SettingsPage } from "./pages/settings";
import { SuppliersPage } from "./pages/suppliers";
import { UnmergePage } from "./pages/unmerge";
import { Alert, Button, Modal, PageHeader, Skeleton } from "./ui";
import { fmtDate, get, post } from "@/lib/client";

type Tab = "dashboard" | "products" | "new" | "price" | "unmerge" | "suppliers" | "categories" | "history" | "export" | "settings";

const NAV: Array<{ group: string | null; items: Array<[Tab, string, any]> }> = [
  { group: null, items: [["dashboard", "Dashboard", LayoutDashboard]] },
  { group: "Catalog", items: [["products", "All Products", Package], ["new", "New Arrivals", Sparkles], ["price", "Price Changes", TrendingDown], ["unmerge", "Merges", Undo2]] },
  { group: "Setup", items: [["suppliers", "Suppliers", Store], ["categories", "Categories", Tags], ["history", "Scraping History", History], ["export", "Export Reports", FileDown], ["settings", "Settings", Settings]] },
];

const ls = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [state, setState] = useState<any>(null);
  const [error, setError] = useState("");
  const [categoryId, setCategoryIdRaw] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [runSel, setRunSel] = useState<string[]>([]);
  const [runBusy, setRunBusy] = useState(false);
  const gridQuery = useRef<Record<string, string | undefined>>({});

  const refresh = useCallback(async () => {
    try {
      const s = await get("state");
      setState(s);
      setError("");
    } catch (e) { setError((e as Error).message); }
  }, []);

  // restore workspace + last category
  useEffect(() => { void refresh(); }, [refresh]);

  // pick a valid category (last used, else first alphabetically) — FR-GRID-01
  useEffect(() => {
    if (!state) return;
    const cats = state.categories as Array<{ id: string }>;
    if (categoryId && cats.some((c) => c.id === categoryId)) return;
    const saved = ls.get("category");
    setCategoryIdRaw(cats.find((c) => c.id === saved)?.id ?? cats[0]?.id ?? null);
  }, [state, categoryId]);
  const setCategoryId = (id: string) => { setCategoryIdRaw(id); ls.set("category", id); };

  // poll while a run is in progress
  const latest = state?.jobs?.[0];
  // stop polling a "Running" job that has shown no sign of life for 30 minutes (it was interrupted)
  const running = latest?.status === "Running" && Date.now() - Date.parse(latest.started) < 30 * 60 * 1000;
  useEffect(() => { if (!running) return; const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [running, refresh]);

  const totalCount = (latest?.selected ?? []).length;
  const doneCount = Math.min(totalCount, (latest?.log ?? []).filter((e: any) => e?.supplierId).length);

  // Pages read from `state`, so refetch it whenever the user switches page (History/Dashboard were going stale).
  const go = (t: Tab) => { setTab(t); void refresh(); };

  function openRun() {
    setRunSel((state?.suppliers ?? []).filter((s: any) => s.status === "Active").map((s: any) => s.id));
    setRunOpen(true);
  }
  async function startRun() {
    setRunBusy(true);
    try { await post("run", { selected: runSel }); toast.success("Scraping started"); setRunOpen(false); go("history"); }
    catch (e) { toast.error((e as Error).message); } finally { setRunBusy(false); }
  }

  const exportSelected = async (ids: string[]) => {
    try { await downloadWorkbook({ category: categoryId ?? "all", scope: "selected", ids: ids.join(",") }); } catch (e) { toast.error((e as Error).message); }
  };

  const runGroups = (() => {
    const out: Array<{ name: string; items: any[] }> = [];
    for (const s of (state?.suppliers ?? []).filter((x: any) => x.status === "Active")) {
      const g = out.find((x) => x.name === s.category);
      g ? g.items.push(s) : out.push({ name: s.category, items: [s] });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  })();
  const catSummary = (state?.categories ?? []) as any[];
  const gridProps = { categories: catSummary, categoryId, setCategoryId, onChanged: refresh, onExportSelected: exportSelected, onQuery: (p: Record<string, string | undefined>) => { gridQuery.current = p; } };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-14 shrink-0 flex-col border-r bg-white md:w-56">
        <div className="flex h-16 shrink-0 items-center justify-center gap-2 border-b px-2 md:justify-start md:px-4"><img src="/logo.png" alt="AnimeCartel" width={32} height={32} className="size-8 shrink-0 object-contain" /><div className="hidden leading-tight md:block"><p className="text-sm font-semibold">AnimeCartel</p><p className="text-xs text-gray-500">Supplier Intelligence</p></div></div>
        <nav className="flex-1 overflow-y-auto p-2" aria-label="Main">
          {NAV.map((sec, i) => (
            <div key={sec.group ?? "top"} className={clsx(i > 0 && "mt-3 border-t pt-3 md:mt-1 md:border-t-0 md:pt-0")}>
              {sec.group && <p className="hidden px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400 md:block">{sec.group}</p>}
              <div className="space-y-0.5">
                {sec.items.map(([id, label, Icon]) => (
                  <button key={id} onClick={() => go(id)} aria-current={tab === id ? "page" : undefined} title={label} className={clsx("flex w-full items-center justify-center gap-2.5 rounded-md px-3 py-2 text-left text-sm md:justify-start", tab === id ? "bg-indigo-50 font-medium text-indigo-700" : "text-gray-700 hover:bg-gray-100")}>
                    <Icon className="size-4 shrink-0" /><span className="hidden md:inline">{label}</span><span className="sr-only md:hidden">{label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b bg-white px-4 sm:px-6">
          {running ? (
            <div role="status" className="flex min-w-0 items-center gap-3 text-sm text-blue-800">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <span className="truncate">Scraping {doneCount} of {totalCount} supplier{totalCount === 1 ? "" : "s"}…</span>
              <span className="hidden h-1.5 w-32 overflow-hidden rounded-full bg-blue-100 sm:block" aria-hidden="true"><span className="block h-full rounded-full bg-blue-600 transition-all" style={{ width: `${totalCount ? Math.max(6, Math.round((doneCount / totalCount) * 100)) : 6}%` }} /></span>
            </div>
          ) : (
            <p className="truncate text-xs text-gray-500">{latest ? <>Last run: <span className="font-medium text-gray-700">{latest.status}</span> · {fmtDate(latest.finished ?? latest.started)}</> : "No scraping runs yet"}</p>
          )}
          <Button size="sm" onClick={openRun} disabled={running} title={running ? "A scraping run is already in progress" : "Choose suppliers and start scraping"}>
            <Play className="size-3.5" />{running ? "Running…" : "Run scrape"}
          </Button>
        </header>

        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 sm:p-6">
          {error && <div className="mb-3"><Alert>Data service: {error} <button className="ml-2 underline" onClick={refresh}>Retry</button></Alert></div>}
          {!state && !error && <div className="space-y-3"><Skeleton className="h-10 w-64" /><Skeleton className="h-64" /></div>}
          {state && (
            <>
              {tab === "dashboard" && <Dashboard state={state} go={(t) => go(t as Tab)} />}
              {tab === "products" && <><PageHeader title="All Products" subtitle="One product per row, one price column per supplier." /><div className="min-h-0 flex-1"><ProductGrid {...gridProps} /></div></>}
              {tab === "new" && <><PageHeader title="New Arrivals" subtitle="Products with listings first seen in recent scrapes." /><div className="min-h-0 flex-1"><ProductGrid {...gridProps} preset="new" /></div></>}
              {tab === "price" && <><PageHeader title="Price Changes" subtitle="▲ price increased · ▼ price decreased since the previous scrape." /><div className="min-h-0 flex-1"><ProductGrid {...gridProps} preset="priceChanged" /></div></>}
              {tab === "unmerge" && <UnmergePage categories={catSummary} onChanged={refresh} />}
              {tab === "suppliers" && <SuppliersPage state={state} onChanged={refresh} goCategories={() => go("categories")} />}
              {tab === "categories" && <CategoriesPage categories={catSummary} suppliers={state.suppliers} onChanged={refresh} goSuppliers={() => go("suppliers")} />}
              {tab === "history" && <HistoryPage jobs={state.jobs} />}
              {tab === "export" && <ExportPage categories={catSummary} categoryId={categoryId} gridQuery={gridQuery.current} />}
              {tab === "settings" && <SettingsPage state={state} onChanged={refresh} />}
            </>
          )}
        </main>
      </div>

      <Modal open={runOpen} onClose={() => setRunOpen(false)} title="Run scraping now" footer={<><Button variant="outline" onClick={() => setRunOpen(false)}>Cancel</Button><Button loading={runBusy} disabled={!runSel.length} onClick={startRun}>Run {runSel.length} supplier{runSel.length === 1 ? "" : "s"}</Button></>}>
        {runGroups.length === 0 ? (
          <p className="text-sm text-gray-600">No active suppliers. Open Suppliers and use Test &amp; activate first.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">Tick suppliers, or run just one category.</span>
              <span className="flex gap-3">
                <button type="button" className="text-indigo-600 hover:underline" onClick={() => setRunSel(runGroups.flatMap((g) => g.items.map((x: any) => x.id)))}>Select all</button>
                <button type="button" className="text-indigo-600 hover:underline" onClick={() => setRunSel([])}>Clear</button>
              </span>
            </div>
            {runGroups.map((g) => {
              const ids = g.items.map((x: any) => x.id);
              const n = ids.filter((id: string) => runSel.includes(id)).length;
              return (
                <section key={g.name}>
                  <div className="mb-1.5 flex items-center justify-between gap-2 border-b pb-1.5">
                    <label className="flex items-center gap-2 text-sm font-semibold">
                      <input type="checkbox" checked={n === ids.length} ref={(el) => { if (el) el.indeterminate = n > 0 && n < ids.length; }} onChange={(e) => setRunSel((p) => (e.target.checked ? [...new Set([...p, ...ids])] : p.filter((x) => !ids.includes(x))))} aria-label={`Select all ${g.name} suppliers`} />
                      {g.name} <span className="text-xs font-normal text-gray-500">{n} of {ids.length}</span>
                    </label>
                    <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => setRunSel(ids)} title={`Select only the ${g.name} suppliers`}>Only this category</button>
                  </div>
                  <ul className="space-y-1.5 pl-6">
                    {g.items.map((s: any) => (
                      <li key={s.id}><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={runSel.includes(s.id)} onChange={(e) => setRunSel((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))} />{s.name}</label></li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </Modal>
      <Toaster position="bottom-right" richColors />
    </div>
  );
}
