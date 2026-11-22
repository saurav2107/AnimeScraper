"use client";
import clsx from "clsx";
import { Boxes, FileDown, History, LayoutDashboard, Package, Settings, Sparkles, Store, Tags, TrendingDown, Undo2 } from "lucide-react";
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
import { get, post, setDemo } from "@/lib/client";

type Tab = "dashboard" | "products" | "new" | "price" | "unmerge" | "suppliers" | "categories" | "history" | "export" | "settings";

const NAV: Array<[Tab, string, any]> = [
  ["dashboard", "Dashboard", LayoutDashboard], ["products", "All Products", Package], ["new", "New Arrivals", Sparkles], ["price", "Price Changes", TrendingDown],
  ["unmerge", "Unmerge", Undo2], ["suppliers", "Suppliers", Store], ["categories", "Categories", Tags], ["history", "Scraping History", History], ["export", "Export Reports", FileDown], ["settings", "Settings", Settings],
];

const ls = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export function App() {
  const [tab, setTab] = useState<Tab>("products");
  const [demo, setDemoState] = useState(false);
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
  useEffect(() => { if (ls.get("workspace") === "demo") { setDemo(true); setDemoState(true); } }, []);
  useEffect(() => { setState(null); void refresh(); }, [demo, refresh]);

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

  // Pages read from `state`, so refetch it whenever the user switches page (History/Dashboard were going stale).
  const go = (t: Tab) => { setTab(t); void refresh(); };
  const toggleDemo = (v: boolean) => { setDemo(v); setDemoState(v); ls.set("workspace", v ? "demo" : "live"); setCategoryIdRaw(null); };

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

  const catSummary = (state?.categories ?? []) as any[];
  const gridProps = { categories: catSummary, categoryId, setCategoryId, onChanged: refresh, onExportSelected: exportSelected, onQuery: (p: Record<string, string | undefined>) => { gridQuery.current = p; } };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-14 shrink-0 flex-col border-r bg-white lg:w-56">
        <div className="flex items-center justify-center gap-2 border-b px-2 py-4 lg:justify-start lg:px-4"><Boxes className="size-5 text-indigo-600" /><div className="hidden leading-tight lg:block"><p className="text-sm font-semibold">AnimeCartel</p><p className="text-xs text-gray-500">Supplier Intelligence</p></div></div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Main">
          {NAV.map(([id, label, Icon]) => (
            <button key={id} onClick={() => go(id)} aria-current={tab === id ? "page" : undefined} title={label} className={clsx("flex w-full items-center justify-center gap-2.5 rounded-md px-3 py-2 text-left text-sm lg:justify-start", tab === id ? "bg-indigo-50 font-medium text-indigo-700" : "text-gray-700 hover:bg-gray-100")}>
              <Icon className="size-4 shrink-0" /><span className="hidden lg:inline">{label}</span><span className="sr-only lg:hidden">{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b bg-white px-6 py-2.5">
          <div role="group" aria-label="Workspace" className="flex rounded-md bg-gray-100 p-0.5 text-sm">
            {([["Live catalog", false], ["Demo samples", true]] as const).map(([l, v]) => (
              <button key={l} onClick={() => toggleDemo(v)} aria-pressed={demo === v} className={clsx("rounded px-3 py-1", demo === v ? "bg-white font-medium shadow-sm" : "text-gray-600")}>{l}</button>
            ))}
          </div>
          {demo && <span className="text-xs text-amber-700">Demo mode is read-only. Sample data only.</span>}
          {running && <span className="text-xs text-blue-700">A scraping run is in progress…</span>}
        </header>

        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 sm:p-6">
          {error && <div className="mb-3"><Alert>Data service: {error} <button className="ml-2 underline" onClick={refresh}>Retry</button></Alert></div>}
          {!state && !error && <div className="space-y-3"><Skeleton className="h-10 w-64" /><Skeleton className="h-64" /></div>}
          {state && (
            <>
              {tab === "dashboard" && <Dashboard state={state} onRun={openRun} go={(t) => go(t as Tab)} />}
              {tab === "products" && <><PageHeader title="All Products" subtitle="One product per row, one price column per supplier." /><div className="min-h-0 flex-1"><ProductGrid {...gridProps} /></div></>}
              {tab === "new" && <><PageHeader title="New Arrivals" subtitle="Products with listings first seen in recent scrapes." /><div className="min-h-0 flex-1"><ProductGrid {...gridProps} preset="new" /></div></>}
              {tab === "price" && <><PageHeader title="Price Changes" subtitle="▲ price increased · ▼ price decreased since the previous scrape." /><div className="min-h-0 flex-1"><ProductGrid {...gridProps} preset="priceChanged" /></div></>}
              {tab === "unmerge" && <UnmergePage categories={catSummary} onChanged={refresh} />}
              {tab === "suppliers" && <SuppliersPage state={state} onChanged={refresh} onRun={openRun} goCategories={() => go("categories")} />}
              {tab === "categories" && <CategoriesPage categories={catSummary} suppliers={state.suppliers} onChanged={refresh} goSuppliers={() => go("suppliers")} />}
              {tab === "history" && <HistoryPage jobs={state.jobs} />}
              {tab === "export" && <ExportPage categories={catSummary} categoryId={categoryId} gridQuery={gridQuery.current} />}
              {tab === "settings" && <SettingsPage state={state} onChanged={refresh} />}
            </>
          )}
        </main>
      </div>

      <Modal open={runOpen} onClose={() => setRunOpen(false)} title="Run scraping now" footer={<><Button variant="outline" onClick={() => setRunOpen(false)}>Cancel</Button><Button loading={runBusy} disabled={!runSel.length || demo} onClick={startRun}>Run {runSel.length} supplier{runSel.length === 1 ? "" : "s"}</Button></>}>
        {(state?.suppliers ?? []).filter((s: any) => s.status === "Active").length === 0 ? (
          <p className="text-sm text-gray-600">No active suppliers. Open Suppliers and use Test &amp; activate first.</p>
        ) : (
          <ul className="space-y-1.5">
            {(state?.suppliers ?? []).filter((s: any) => s.status === "Active").map((s: any) => (
              <li key={s.id}><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={runSel.includes(s.id)} onChange={(e) => setRunSel((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))} />{s.name} <span className="text-gray-400">· {s.category}</span></label></li>
            ))}
          </ul>
        )}
      </Modal>
      <Toaster position="bottom-right" richColors />
    </div>
  );
}
