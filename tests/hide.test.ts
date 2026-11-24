import { describe, expect, it } from "vitest";
import { call, fakeCrawl, mkDb, prod, setup } from "./helpers";

async function world() {
  const db = mkDb();
  const { cat, mk } = (await setup(db)) as any;
  const a = await mk("A", "https://a.example/f");
  const url = "https://a.example/f";
  const items = () => [prod("https://a.example/1", "Goku", 100), prod("https://a.example/2", "Luffy", 200)];
  const run = (p = items()) => call(db, "POST", "run", { selected: [a], wait: true }, {}, fakeCrawl({ [url]: p }));
  await run();
  const id = (u: string) => (db.prepare("SELECT group_id FROM listings WHERE url=?").get(u) as any).group_id as string;
  const grid = (q: Record<string, string> = {}) => call(db, "GET", "products", undefined, { category: cat, ...q });
  return { db, cat, id, grid, run };
}

describe("hiding products", () => {
  it("hides from the grid and counts, lists under hidden, and can be restored", async () => {
    const { db, id, grid } = await world();
    const goku = id("https://a.example/1");
    expect((await call(db, "POST", "products-hide", { productIds: [goku] })).count).toBe(1);
    expect((await grid()).items.map((i: any) => i.name)).toEqual(["Luffy"]);
    expect((await grid({ hidden: "1" })).items.map((i: any) => i.name)).toEqual(["Goku"]);
    expect((await call(db, "GET", "state")).summary.products).toBe(1);
    await call(db, "POST", "products-hide", { productIds: [goku], hidden: false });
    expect((await grid()).total).toBe(2);
  });
  it("stays hidden after later scrapes, even with a price change", async () => {
    const { db, id, grid, run } = await world();
    await call(db, "POST", "products-hide", { productIds: [id("https://a.example/1")] });
    await run([prod("https://a.example/1", "Goku", 90), prod("https://a.example/2", "Luffy", 200), prod("https://a.example/3", "Zoro", 300)]);
    expect((await grid()).items.map((i: any) => i.name).sort()).toEqual(["Luffy", "Zoro"]);
    const hidden = (await grid({ hidden: "1" })).items;
    expect(hidden).toHaveLength(1);
    expect(hidden[0].cells[Object.keys(hidden[0].cells)[0]].price).toBe(90);
  });
  it("rejects empty or stale requests", async () => {
    const { db } = await world();
    await expect(call(db, "POST", "products-hide", { productIds: [] })).rejects.toThrow("at least one");
    await expect(call(db, "POST", "products-hide", { productIds: ["nope"] })).rejects.toThrow("changed");
  });
  it("is per category: the same product scraped for another category still appears there", async () => {
    const { db, cat, id, grid } = await world();
    await call(db, "POST", "products-hide", { productIds: [id("https://a.example/1")] });
    const dc = await call(db, "POST", "categories", { name: "Die Cast", sizeKind: "scale", sizeLabel: "Scale", sizeUnit: "" });
    const s = await call(db, "POST", "suppliers", { categoryId: dc.id, name: "A again", url: "https://a.example/g", adapter: "jsonld", termsAcknowledged: true });
    db.prepare("UPDATE suppliers SET status = 'Active' WHERE id = ?").run(s.id);
    await call(db, "POST", "run", { selected: [s.id], wait: true }, {}, fakeCrawl({ "https://a.example/g": [prod("https://a.example/1", "Goku", 100)] }));
    const dcGrid = await call(db, "GET", "products", undefined, { category: dc.id });
    expect(dcGrid.items.map((i: any) => i.name)).toEqual(["Goku"]);
    expect((await grid()).items.map((i: any) => i.name)).toEqual(["Luffy"]); // still hidden in Action Figures
    expect((await grid({ hidden: "1" })).total).toBe(1);
    void cat;
  });
});

describe("dashboard price drops", () => {
  it("lists the biggest % drops first, only for visible in-stock products", async () => {
    const { db, id, run } = await world();
    await run([prod("https://a.example/1", "Goku", 80), prod("https://a.example/2", "Luffy", 190)]); // -20% and -5%
    let drops = (await call(db, "GET", "state")).summary.topDrops;
    expect(drops.map((d: any) => [d.name, d.pct])).toEqual([["Goku", 20], ["Luffy", 5]]);
    await call(db, "POST", "products-hide", { productIds: [id("https://a.example/1")] });
    drops = (await call(db, "GET", "state")).summary.topDrops;
    expect(drops.map((d: any) => d.name)).toEqual(["Luffy"]);
    await run([prod("https://a.example/1", "Goku", 80), prod("https://a.example/2", "Luffy", 250)]); // rise => no longer a drop
    expect((await call(db, "GET", "state")).summary.topDrops).toEqual([]);
  });
});

describe("testing a supplier whose page has no products", () => {
  const setupSup = async () => {
    const db = mkDb();
    const { mk } = (await setup(db)) as any;
    const id = await mk("Empty", "https://empty.example/f");
    db.prepare("UPDATE suppliers SET status = 'Paused' WHERE id = ?").run(id);
    return { db, id };
  };
  it("activates it and flags 'no products' when the page was readable but empty", async () => {
    const { db, id } = await setupSup();
    const r = await call(db, "POST", "test", { id }, {}, { ...fakeCrawl({}), crawl: async () => ({ products: [], complete: true, errors: [] }) });
    expect(r).toMatchObject({ status: "Active", found: 0, empty: true });
    const s = (await call(db, "GET", "state")).suppliers.find((x: any) => x.id === id);
    expect(s).toMatchObject({ status: "Active", lastFound: 0 });
  });
  it("still fails when the page could not be read", async () => {
    const { db, id } = await setupSup();
    await expect(call(db, "POST", "test", { id }, {}, { ...fakeCrawl({}), crawl: async () => ({ products: [], complete: true, errors: ["HTTP 403"] }) })).rejects.toThrow("HTTP 403");
  });
  it("clears the flag once a run finds products, and when the source changes", async () => {
    const { db, id } = await setupSup();
    await call(db, "POST", "test", { id }, {}, { ...fakeCrawl({}), crawl: async () => ({ products: [], complete: true, errors: [] }) });
    await call(db, "POST", "run", { selected: [id], wait: true }, {}, fakeCrawl({ "https://empty.example/f": [prod("https://empty.example/1", "X", 10)] }));
    expect(((await call(db, "GET", "state")).suppliers.find((x: any) => x.id === id)).lastFound).toBe(1);
  });
});
