"use client";
import { Card, PageHeader, Thumb } from "@/components/ui";
import { fmtDate, fmtPrice } from "@/lib/client";

/** A summary card. With `to`, the whole card is a button that opens the related page. */
const Tile = ({ label, value, sub, to, go }: { label: string; value: React.ReactNode; sub?: string; to?: string; go?: (tab: string) => void }) => {
  const body = (<><p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p>{sub && <p className="text-xs text-gray-500">{sub}</p>}</>);
  if (!to || !go) return <Card className="p-4">{body}</Card>;
  return (
    <button type="button" onClick={() => go(to)} aria-label={`${label}: open ${to === "history" ? "scraping history" : to === "products" ? "all products" : to === "new" ? "new arrivals" : to === "price" ? "price changes" : to}`} className="rounded-lg border bg-white p-4 text-left transition hover:border-indigo-300 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-indigo-500">
      {body}
    </button>
  );
};

export function Dashboard({ state, go }: { state: any; go: (tab: string) => void }) {
  const s = state.summary;
  return (
    <>
      <PageHeader title="Dashboard" subtitle="Supplier price comparison at a glance" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Active suppliers" value={s.activeSuppliers} sub={`${s.byCategory.reduce((a: number, c: any) => a + c.suppliers, 0)} registered`} to="suppliers" go={go} />
        <Tile label="Products" value={s.products.toLocaleString()} sub="all categories" to="products" go={go} />
        <Tile label="New arrivals" value={s.newArrivals} to="new" go={go} />
        <Tile label="Price changes" value={s.priceChanges} sub="latest scrape" to="price" go={go} />
        <Tile label="Active merges" value={s.activeMerges} to="unmerge" go={go} />
        <Tile label="Next scheduled run" value={<span className="text-base">{state.nextRun ? (Date.parse(state.nextRun) < Date.now() ? "Due" : fmtDate(state.nextRun)) : "Off"}</span>} sub={state.nextRun && Date.parse(state.nextRun) < Date.now() ? "Runs on the next scheduler call" : undefined} />
      </div>
      <div className="mb-2 mt-6 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Biggest price drops</h2>
        <button type="button" onClick={() => go("price")} className="text-xs text-indigo-600 hover:underline">View all price changes</button>
      </div>
      {(s.topDrops ?? []).length === 0 ? (
        <Card className="p-4 text-sm text-gray-500">No price drops in the latest scrapes.</Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {s.topDrops.map((d: any) => (
            <a key={d.productId + d.supplier} href={d.url} target="_blank" rel="noreferrer" title={`Open on ${d.supplier}`} className="flex items-center gap-3 rounded-lg border bg-white p-3 transition hover:border-indigo-300 hover:shadow-sm">
              <Thumb src={d.image} size={64} alt={d.name} />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm font-medium leading-snug">{d.name}</p>
                <p className="mt-0.5 truncate text-xs text-gray-500">{d.supplier} · {d.category}</p>
                <p className="mt-1 flex items-baseline gap-2">
                  <span className="font-semibold text-gray-900">{fmtPrice(d.price, d.currency)}</span>
                  <span className="text-xs text-gray-400 line-through">{fmtPrice(d.previous, d.currency)}</span>
                  <span className="rounded bg-green-50 px-1.5 py-0.5 text-xs font-semibold text-green-700">▼ {d.pct}%</span>
                </p>
              </div>
            </a>
          ))}
        </div>
      )}
      <h2 className="mb-2 mt-6 text-sm font-semibold">By category</h2>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr>{["Category", "Suppliers (active / total)", "Products", "New", "Price changes", "Out of stock"].map((h, i) => <th key={h} className={`th ${i ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">
            {s.byCategory.length === 0 && <tr><td className="td text-gray-500" colSpan={6}>No categories yet.</td></tr>}
            {s.byCategory.map((c: any) => (
              <tr key={c.id}><td className="td font-medium">{c.name}</td><td className="td text-right">{c.activeSuppliers} / {c.suppliers}</td><td className="td text-right">{c.products}</td><td className="td text-right">{c.newProducts}</td><td className="td text-right">{c.priceChanges}</td><td className="td text-right">{c.outOfStock}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
