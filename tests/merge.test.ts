import { describe, expect, it } from "vitest";
import { call, fakeCrawl, mkDb, prod, setup } from "./helpers";

async function world() {
  const db = mkDb();
  const { cat, mk } = await setup(db);
  const a = await mk("A", "https://a.example/f");
  const b = await mk("B", "https://b.example/f");
  await call(db, "POST", "run", { selected: [a], wait: true }, {}, fakeCrawl({
    "https://a.example/f": [prod("https://a.example/1", "Luffy A", 1000, { image: "https://img/a.jpg", images: ["https://img/a.jpg"] }), prod("https://a.example/2", "Luffy A box", 1100), prod("https://a.example/3", "Zoro A", 900)],
  }));
  await call(db, "POST", "run", { selected: [b], wait: true }, {}, fakeCrawl({ "https://b.example/f": [prod("https://b.example/1", "Luffy B", 950, { stock: "Out of stock" })] }));
  const g = (url: string) => (db.prepare("SELECT group_id FROM listings WHERE url = ?").get(url) as any).group_id as string;
  return { db, cat, a, b, g, grid: (q: Record<string, string> = {}) => call(db, "GET", "products", undefined, { category: cat, ...q }) };
}
const names = (r: any) => r.items.map((i: any) => i.name);

describe("manual merge & unmerge", () => {
  it("merges, shows lowest price + 'more', hides sources, keeps their names for undo", async () => {
    const { db, g, grid, a } = await world();
    const ids = [g("https://a.example/1"), g("https://a.example/2"), g("https://b.example/1")];
    const prev = await call(db, "GET", "merge-preview", undefined, { ids: ids.join(",") });
    expect(prev.images.map((i: any) => i.url)).toContain("https://img/a.jpg");
    expect(prev.sameSupplierWarnings).toEqual([{ supplierName: "A", count: 2 }]);
    const m = await call(db, "POST", "merge", { productIds: ids, name: "Luffy", image: "https://img/a.jpg", note: "same" });
    const r = await grid();
    expect(names(r)).toEqual(["Luffy", "Zoro A"]);
    const row = r.items[0];
    expect(row.isMerged).toBe(true);
    expect(row.image).toBe("https://img/a.jpg");
    expect(row.cells[a]).toMatchObject({ state: "price", price: 1000, more: 1 });
    const src = db.prepare("SELECT status, name FROM groups WHERE id = ?").get(ids[0]) as any;
    expect(src).toEqual({ status: "Merged", name: "Luffy A" });
    expect(m.mergeEventId).toBeTruthy();
  });

  it("rejects bad input: <2 products, stale products, foreign image, long name", async () => {
    const { db, g } = await world();
    const [x, y] = [g("https://a.example/1"), g("https://a.example/3")];
    await expect(call(db, "POST", "merge", { productIds: [x], name: "n", image: null })).rejects.toThrow();
    await expect(call(db, "POST", "merge", { productIds: [x, y], name: "n", image: "https://evil/x.jpg" })).rejects.toThrow("image");
    await expect(call(db, "POST", "merge", { productIds: [x, y], name: "n".repeat(201), image: null })).rejects.toThrow();
    await call(db, "POST", "merge", { productIds: [x, y], name: "n", image: null });
    await expect(call(db, "POST", "merge", { productIds: [x, g("https://b.example/1")], name: "n", image: null })).rejects.toMatchObject({ status: 409 });
    expect(db).toBeTruthy();
  });

  it("rejects mixed categories", async () => {
    const { db, g } = await world();
    const kat = (await call(db, "POST", "categories", { name: "Katanas", sizeKind: "length", sizeLabel: "Length", sizeUnit: "cm" })).id;
    const k = await call(db, "POST", "suppliers", { categoryId: kat, name: "K", url: "https://k.example/k", adapter: "jsonld", termsAcknowledged: true });
    db.prepare("UPDATE suppliers SET status='Active' WHERE id=?").run(k.id);
    await call(db, "POST", "run", { selected: [k.id], wait: true }, {}, fakeCrawl({ "https://k.example/k": [prod("https://k.example/1", "Katana", 5000)] }));
    const kg = (db.prepare("SELECT group_id FROM listings WHERE url='https://k.example/1'").get() as any).group_id;
    await expect(call(db, "POST", "merge", { productIds: [g("https://a.example/1"), kg], name: "n", image: null })).rejects.toMatchObject({ status: 409 });
  });

  it("cascading undo: M1(A,B->AB), M2(AB,C->ABC); undoing M1 also undoes M2 and restores originals", async () => {
    const { db, g, grid } = await world();
    const [A, B, C] = [g("https://a.example/1"), g("https://a.example/2"), g("https://a.example/3")];
    const m1 = await call(db, "POST", "merge", { productIds: [A, B], name: "AB", image: null });
    const m2 = await call(db, "POST", "merge", { productIds: [m1.productId, C], name: "ABC", image: null, note: "later" });
    expect(names(await grid())).toContain("ABC");

    const impact = await call(db, "GET", `merges/${m1.mergeEventId}/undo-impact`);
    expect(impact.dependents.map((d: any) => d.id)).toEqual([m2.mergeEventId]);
    expect(impact.restoredProducts.map((p: any) => p.name).sort()).toEqual(["Luffy A", "Luffy A box", "Zoro A"]);

    await expect(call(db, "POST", "unmerge", { mergeEventId: m1.mergeEventId, token: "stale" })).rejects.toMatchObject({ status: 409 });
    const out = await call(db, "POST", "unmerge", { mergeEventId: m1.mergeEventId, token: impact.token });
    expect(out.undoneEventIds).toEqual([m2.mergeEventId, m1.mergeEventId]);
    expect(names(await grid())).toEqual(["Luffy A", "Luffy A box", "Luffy B", "Zoro A"]);
    expect(db.prepare("SELECT status FROM groups WHERE id = ?").get(m1.productId)).toEqual({ status: "Retired" });
    await expect(call(db, "GET", `merges/${m1.mergeEventId}/undo-impact`)).rejects.toMatchObject({ status: 409 });
    const list = await call(db, "GET", "merges", undefined, { status: "undone" });
    expect(list.items).toHaveLength(2);
  });

  it("undoing only the dependent merge leaves the earlier merge intact", async () => {
    const { db, g, grid } = await world();
    const [A, B, C] = [g("https://a.example/1"), g("https://a.example/2"), g("https://a.example/3")];
    const m1 = await call(db, "POST", "merge", { productIds: [A, B], name: "AB", image: null });
    const m2 = await call(db, "POST", "merge", { productIds: [m1.productId, C], name: "ABC", image: null });
    const impact = await call(db, "GET", `merges/${m2.mergeEventId}/undo-impact`);
    expect(impact.dependents).toHaveLength(0);
    await call(db, "POST", "unmerge", { mergeEventId: m2.mergeEventId, token: impact.token });
    expect(names(await grid())).toEqual(["AB", "Luffy B", "Zoro A"].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())));
  });
});

describe("comparison grid queries", () => {
  it("search, filters and sorts (server-side, NULLs last)", async () => {
    const { grid, a, b } = await world();
    expect(names(await grid({ q: "zoro" }))).toEqual(["Zoro A"]);
    expect(names(await grid({ q: "%" }))).toEqual([]);
    expect(names(await grid({ inStock: "1" }))).not.toContain("Luffy B");
    expect(names(await grid({ minPrice: "950", maxPrice: "1000" }))).toEqual(["Luffy A", "Zoro A"].filter((n) => n !== "Zoro A"));
    expect(names(await grid({ new: "1" })).length).toBe(4);
    expect(names(await grid({ priceChanged: "1" }))).toEqual([]);
    expect(names(await grid({ sort: "lowest_asc" }))).toEqual(["Zoro A", "Luffy A", "Luffy A box", "Luffy B"]);
    expect(names(await grid({ sort: `supplier:${b}:asc` }))[3]).toBeDefined();
    expect(names(await grid({ sort: `supplier:${a}:desc` }))).toEqual(["Luffy A box", "Luffy A", "Zoro A", "Luffy B"]);
    expect(names(await grid({ sort: "nonsense" }))).toEqual(["Luffy A", "Luffy A box", "Luffy B", "Zoro A"]);
  });

  it("paginates with a stable cursor and reports total", async () => {
    const { grid } = await world();
    const p1 = await grid({ limit: "3" });
    expect(p1.total).toBe(4);
    expect(p1.items).toHaveLength(3);
    const p2 = await grid({ limit: "3", cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
  });

  it("cell states: oos not linked, deleted supplier hidden", async () => {
    const { db, g, grid, b } = await world();
    const r = await grid();
    const luffyB = r.items.find((i: any) => i.name === "Luffy B");
    expect(luffyB.cells[b]).toMatchObject({ state: "oos", price: 950 });
    expect(luffyB.cells[b].url).toBeUndefined();
    await call(db, "DELETE", "suppliers", { id: b });
    const after = await grid();
    expect(names(after)).not.toContain("Luffy B");
    expect(after.suppliers.map((s: any) => s.name)).toEqual(["A"]);
    expect(g).toBeDefined();
  });

  it("price-changed cell exposes direction and previous price", async () => {
    const { db, grid, a } = await world();
    await call(db, "POST", "run", { selected: [a], wait: true }, {}, fakeCrawl({ "https://a.example/f": [prod("https://a.example/3", "Zoro A", 800)] }));
    const r = await grid({ priceChanged: "1" });
    expect(names(r)).toEqual(["Zoro A"]);
    expect(r.items[0].cells[a]).toMatchObject({ state: "price", direction: "down", previousPrice: 900, price: 800 });
    expect(db).toBeTruthy();
  });
});
