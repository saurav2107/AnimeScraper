"use client";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import clsx from "clsx";
import { Alert, Badge, Button, Card, Empty, FieldError, Modal, PageHeader, Switch } from "@/components/ui";
import {ApiError, del, fmtDate, post } from "@/lib/client";
import { exportSuppliers, ImportSuppliersDialog } from "./suppliers-io";

const blank = (categoryId: string) => ({ name: "", url: "", categoryId, adapter: "woocommerce-api", productUrls: "", sitemapUrls: "", textFilter: "", excludeText: "", termsAcknowledged: false });

const COLLAPSE_KEY = "suppliers:collapsed";
const readCollapsed = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]")); } catch { return new Set(); } };

export function SuppliersPage({ state, onChanged, goCategories }: { state: any; onChanged: () => void; goCategories: () => void }) {
  const [showDeleted, setShowDeleted] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const saveCollapsed = (n: Set<string>) => { setCollapsed(n); try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...n])); } catch { /* ignore */ } };
  const toggleGroup = (name: string) => { const n = new Set(collapsed); n.has(name) ? n.delete(name) : n.add(name); saveCollapsed(n); };
  const [importOpen, setImportOpen] = useState(false);
  const [form, setForm] = useState<any>(null);
  const [err, setErr] = useState<{ message: string; field?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testFail, setTestFail] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ kind: "delete" | "restore"; s: any } | null>(null);
  const [confirmErr, setConfirmErr] = useState("");

  const cats = state.categories as any[];
  const locked = (s: any) => s.listingCount > 0;

  /** `copy` pre-fills a new supplier from an existing one (no id, nothing locked, saved as a separate Paused supplier). */
  function openForm(s?: any, copy = false) {
    if (!cats.length) return toast.error("Create a category before registering suppliers.");
    setErr(null);
    setForm(s && copy ? { name: `${s.name} (copy)`, url: s.url, categoryId: s.categoryId, adapter: s.config.adapter, productUrls: s.config.productUrls.join("\n"), textFilter: s.config.textFilter ?? "", excludeText: s.config.excludeText ?? "", sitemapUrls: s.config.sitemapUrls.join("\n"), termsAcknowledged: false, locked: false, copyOf: s.name } : s ? { id: s.id, name: s.name, url: s.url, categoryId: s.categoryId, adapter: s.config.adapter, productUrls: s.config.productUrls.join("\n"), textFilter: s.config.textFilter ?? "", excludeText: s.config.excludeText ?? "", sitemapUrls: s.config.sitemapUrls.join("\n"), termsAcknowledged: s.config.termsAcknowledged, locked: locked(s) } : blank(cats.length === 1 ? cats[0].id : ""));
  }
  const change = (patch: Record<string, unknown>) => { setForm((f: any) => ({ ...f, ...patch })); setErr(null); };
  const fe = (f: string) => (err?.field === f ? err.message : undefined);
  const bad = (f: string) => (err?.field === f ? "border-red-500" : "");
  async function save() {
    setBusy("save"); setErr(null);
    const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
    try {
      const r = await post("suppliers", { id: form.id, name: form.name, url: form.url.trim(), categoryId: form.categoryId, adapter: form.adapter, productUrls: lines(form.productUrls), sitemapUrls: lines(form.sitemapUrls), termsAcknowledged: form.termsAcknowledged, textFilter: form.textFilter, excludeText: form.excludeText });
      toast.success(r.status === "Active" ? "Supplier saved." : "Supplier saved as Paused. Test & activate it to start scraping.");
      setForm(null); onChanged();
    } catch (e) { setErr({ message: (e as Error).message, field: (e as ApiError).data?.field }); } finally { setBusy(null); }
  }
  async function test(s: any) {
    setBusy(s.id);
    setTestFail((m) => { const n = { ...m }; delete n[s.id]; return n; });
    try { const wasActive = s.status === "Active"; const r = await post("test", { id: s.id }); r.empty ? toast.success("Supplier is active, but no products were found on its page yet. A later scrape will pick them up.", { duration: 8000 }) : toast.success(`Test passed: ${r.found} products found.${wasActive ? "" : " Source activated."}`); onChanged(); }
    catch (e) { setTestFail((m) => ({ ...m, [s.id]: (e as Error).message })); toast.error((e as Error).message, { duration: 8000 }); } finally { setBusy(null); }
  }
  async function pause(s: any) {
    try { await post("pause", { id: s.id }); toast.success(`${s.name} paused`); onChanged(); } catch (e) { toast.error((e as Error).message); }
  }
  async function doConfirm() {
    if (!confirm) return;
    setBusy("confirm"); setConfirmErr("");
    try {
      if (confirm.kind === "delete") { await del("suppliers", { id: confirm.s.id }); toast.success(`${confirm.s.name} deleted`); }
      else { await post("suppliers/restore", { id: confirm.s.id }); toast.success(`${confirm.s.name} restored as Paused. Test & activate it to resume scraping.`); }
      if (confirm.kind === "restore" && state.deletedSuppliers.length <= 1) setShowDeleted(false);
      setConfirm(null); onChanged();
    } catch (e) { setConfirmErr((e as ApiError).message); } finally { setBusy(null); }
  }

  const rows = showDeleted ? state.deletedSuppliers : state.suppliers;
  // One section per category, alphabetical (suppliers are already ordered by name within each).
  const groups: Array<{ name: string; items: any[] }> = [];
  for (const r of [...rows].sort((a: any, b: any) => a.category.localeCompare(b.category, undefined, { sensitivity: "base" }))) {
    const g = groups.find((x) => x.name === r.category);
    g ? g.items.push(r) : groups.push({ name: r.category, items: [r] });
  }
  return (
    <>
      <PageHeader title="Suppliers" subtitle="Each registration is one website URL bound to one category." actions={<>
        <label className="flex items-center gap-2 text-sm text-gray-600"><Switch checked={showDeleted} onChange={setShowDeleted} label="Show deleted" />Show deleted</label>
        <Button variant="outline" onClick={() => exportSuppliers(state)} disabled={!state.suppliers.length} title="Download all registered suppliers as an Excel file">Export to Excel</Button>
        <Button variant="outline" onClick={() => setImportOpen(true)} title="Restore suppliers from an exported Excel file">Import from Excel</Button>
        <Button onClick={() => openForm()}>Add supplier</Button>
      </>} />
      {cats.length === 0 && <div className="mb-3"><Alert tone="amber">No categories yet. <button className="underline" onClick={goCategories}>Create a category</button> before adding suppliers.</Alert></div>}
      {rows.length === 0 ? <Empty title={showDeleted ? "No deleted suppliers" : "No suppliers registered yet"} /> : (
        <div className="space-y-5">
        {groups.length > 1 && (
          <div className="flex justify-end gap-3 text-xs">
            <button type="button" className="text-indigo-600 hover:underline" onClick={() => saveCollapsed(new Set())}>Expand all</button>
            <button type="button" className="text-indigo-600 hover:underline" onClick={() => saveCollapsed(new Set(groups.map((g) => g.name)))}>Collapse all</button>
          </div>
        )}
        {groups.map((g) => (
        <Card key={g.name} className="overflow-x-auto">
          <button type="button" onClick={() => toggleGroup(g.name)} aria-expanded={!collapsed.has(g.name)} title={collapsed.has(g.name) ? "Expand" : "Collapse"} className={clsx("flex w-full items-center gap-2 bg-gray-50 px-4 py-2 text-left hover:bg-gray-100", !collapsed.has(g.name) && "border-b")}>
            {collapsed.has(g.name) ? <ChevronRight className="size-4 text-gray-500" /> : <ChevronDown className="size-4 text-gray-500" />}<h2 className="text-sm font-semibold">{g.name}</h2><span className="text-xs text-gray-500">{g.items.length} supplier{g.items.length === 1 ? "" : "s"}{!showDeleted && ` · ${g.items.filter((x: any) => x.status === "Active").length} active`}</span></button>
          {!collapsed.has(g.name) && <table className="w-full min-w-[860px] table-fixed text-sm">
            <colgroup><col className="w-[17%]" /><col className="w-[25%]" />{!showDeleted && <><col className="w-[9%]" /><col className="w-[10%]" /><col className="w-[14%]" /></>}{showDeleted && <col className="w-[20%]" />}<col /></colgroup>
            <thead><tr><th className="th">Supplier</th><th className="th">URL</th><th className="th">Status</th>{!showDeleted && <th className="th">Products found</th>}{!showDeleted && <th className="th">Last success</th>}<th className="th sticky right-0" /></tr></thead>
            <tbody className="divide-y">
              {g.items.map((s: any) => (
                <tr key={s.id}>
                  <td className="td font-medium">{showDeleted ? s.name : <button type="button" onClick={() => openForm(s)} title="Edit this supplier" className="text-left text-indigo-700 hover:underline">{s.name}</button>}</td>
                  <td className="td max-w-[260px] truncate"><a href={s.url} target="_blank" rel="noreferrer" className="text-indigo-700 hover:underline">{s.url}</a></td>
                  <td className="td">{showDeleted ? <Badge tone="red">Deleted</Badge> : <Badge tone={s.status === "Active" ? "green" : "gray"}>{s.status}</Badge>}{testFail[s.id] && <p role="alert" className="mt-1 max-w-[220px] text-xs text-red-600">Test failed: {testFail[s.id].replace(/^Test failed:\s*/, "")}</p>}</td>
                  {!showDeleted && <td className="td">{(s.lastFound ?? (s.listingCount > 0 ? s.listingCount : null)) == null ? <span className="text-gray-400" title="Not tested or scraped yet">—</span> : (s.lastFound ?? s.listingCount) > 0 ? <span className="font-medium text-green-700" title={`${(s.lastFound ?? s.listingCount).toLocaleString()} products at the last test or scrape`}>Yes</span> : <span className="font-medium text-amber-700" title="The page was readable but listed no products">No</span>}</td>}
                  {!showDeleted && <td className="td">{fmtDate(s.lastSuccess)}</td>}
                  <td className="td sticky right-0 bg-white">
                    <div className="flex justify-end gap-2">
                      {showDeleted ? <Button size="sm" variant="outline" onClick={() => { setConfirmErr(""); setConfirm({ kind: "restore", s }); }}>Restore</Button> : (<>
                        {s.status === "Active" && <Button size="sm" variant="outline" onClick={() => pause(s)}>Pause</Button>}
                        {s.status === "Active"
                          ? <Button size="sm" variant="outline" loading={busy === s.id} onClick={() => test(s)} title="Run the test again against the supplier's page">Re-test</Button>
                          : <Button size="sm" loading={busy === s.id} onClick={() => test(s)}>Test &amp; activate</Button>}
                        <Button size="sm" variant="outline" onClick={() => openForm(s, true)} title="Create a new supplier from this one's settings">Copy</Button>
                        <Button size="sm" variant="outline" onClick={() => { setConfirmErr(""); setConfirm({ kind: "delete", s }); }}>Delete</Button>
                      </>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>}
        </Card>
        ))}
        </div>
      )}

      <ImportSuppliersDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={onChanged} />
      <Modal open={!!form} onClose={() => setForm(null)} onSubmit={save} title={form?.id ? "Edit supplier" : form?.copyOf ? "Copy supplier" : "Add supplier"} footer={<><Button variant="outline" onClick={() => setForm(null)}>Cancel</Button><Button type="submit" loading={busy === "save"}>Save</Button></>}>
        {form && (
          <div className="space-y-3">
            {err && !err.field && <Alert>{err.message}</Alert>}
            {form.copyOf && <p className="rounded-md bg-indigo-50 px-3 py-2 text-xs text-indigo-800">Copied from <b>{form.copyOf}</b>. Change whatever differs. A copy needs its own source URL, and a category that doesn&apos;t already have this website. It&apos;s saved as a separate supplier, starts Paused, and you&apos;ll need to confirm the terms again.</p>}
            <div><label className="label" htmlFor="sn">Supplier name</label><input id="sn" className={clsx("input", bad("name"))} aria-invalid={!!fe("name")} value={form.name} onChange={(e) => change({ name: e.target.value })} /><FieldError>{fe("name")}</FieldError></div>
            <div><label className="label" htmlFor="su">Source URL (HTTPS)</label><input id="su" className={clsx("input", bad("url"))} aria-invalid={!!fe("url")} placeholder="https://example.com/product-category/…" value={form.url} onChange={(e) => change({ url: e.target.value })} /><FieldError>{fe("url")}</FieldError></div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="sc">Category</label>
                <select id="sc" className={clsx("input", bad("categoryId"))} value={form.categoryId} disabled={form.locked} onChange={(e) => change({ categoryId: e.target.value })}>
                  <option value="" disabled>Choose a category…</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <FieldError>{fe("categoryId")}</FieldError>{form.locked && <p className="mt-1 text-xs text-gray-500">Locked: products have been imported.</p>}
              </div>
              <div>
                <label className="label" htmlFor="sa">Adapter</label>
                <select id="sa" className="input" value={form.adapter} onChange={(e) => change({ adapter: e.target.value })}>
                  <option value="shopify">Shopify (products.json)</option><option value="woocommerce-api">WooCommerce Store API</option><option value="woocommerce">WooCommerce pages</option><option value="jsonld-list">JSON-LD listing pages</option><option value="rendered">Rendered pages (browser)</option><option value="jsonld">JSON-LD / sitemap</option>
                </select>
                <p className="mt-1 text-xs text-gray-500">{{ rendered: "For sites that load products with JavaScript (price visible without login). Opens the page in Chrome like a visitor and presses “Load more”. Needs Chrome installed on the server.", shopify: "For Shopify stores (URLs like /collections/…). Uses the public /products.json feed; paste the collection or store URL.", "jsonld-list": "For custom sites whose listing pages carry a schema.org product list with prices. Follows ?page=N automatically.", "woocommerce-api": "Fastest. For WooCommerce shops with /wp-json/wc/store enabled.", woocommerce: "Reads product cards on category pages.", jsonld: "Reads schema.org Product data from product pages or a sitemap." }[form.adapter as string]}</p>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="sx">Skip products whose category contains (optional)</label>
              <input id="sx" className={clsx("input", bad("excludeText"))} aria-invalid={!!fe("excludeText")} placeholder="e.g. keychain, keyring" maxLength={200} value={form.excludeText} onChange={(e) => change({ excludeText: e.target.value })} />
              <FieldError>{fe("excludeText")}</FieldError>
              <p className="mt-1 text-xs text-gray-500">Comma-separated. Matches the supplier&apos;s own category label; if the site shows none, it matches the product name. Existing matching items are removed on the next run.</p>
            </div>
            {form.adapter === "rendered" && (
              <div><label className="label" htmlFor="stf">Only keep products whose card contains (optional)</label><input id="stf" className="input" placeholder="e.g. Action Figures" maxLength={80} value={form.textFilter} onChange={(e) => change({ textFilter: e.target.value })} /><p className="mt-1 text-xs text-gray-500">Useful when the listing mixes categories, such as statues and katanas alongside action figures.</p></div>
            )}
            {form.adapter === "jsonld" && (<>
              <div><label className="label" htmlFor="sp">Product URLs (one per line)</label><textarea id="sp" className="input" rows={3} value={form.productUrls} onChange={(e) => change({ productUrls: e.target.value })} /></div>
              <div><label className="label" htmlFor="sm">Sitemap URLs (one per line)</label><textarea id="sm" className="input" rows={2} value={form.sitemapUrls} onChange={(e) => change({ sitemapUrls: e.target.value })} /></div>
            </>)}
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={form.termsAcknowledged} onChange={(e) => change({ termsAcknowledged: e.target.checked })} />I have checked that this supplier&apos;s terms and robots.txt allow automated reading of public product pages.</label><FieldError>{fe("termsAcknowledged")}</FieldError>
            <p className="text-xs text-gray-500">New sources start Paused. Changing the URL or adapter pauses a source again; use Test &amp; activate before scraping.</p>
          </div>
        )}
      </Modal>

      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.kind === "delete" ? `Delete ${confirm.s.name}?` : `Restore ${confirm?.s.name}?`}
        footer={<><Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button variant={confirm?.kind === "delete" ? "danger" : "default"} loading={busy === "confirm"} onClick={doConfirm}>{confirm?.kind === "delete" ? "Delete supplier" : "Restore supplier"}</Button></>}>
        <p className="text-sm text-gray-600">
          {confirm?.kind === "delete"
            ? `${confirm.s.name} will be hidden. Its products and price history are kept but no longer shown. Merges that include its listings can still be undone.`
            : "It will come back as Paused with all its products and history. Test & activate it to resume scraping."}
        </p>
        {confirmErr && <div className="mt-3"><Alert>{confirmErr}</Alert></div>}
      </Modal>
    </>
  );
}
