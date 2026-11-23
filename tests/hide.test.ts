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
