import { describe, expect, it } from "vitest";
import { parseManualSize } from "@/lib/products";
import { call, fakeCrawl, mkDb, prod, setup } from "./helpers";

describe("manual size parsing", () => {
  it("height/length: cm numbers with optional unit, range-checked, normalised", () => {
    expect(parseManualSize("height", "30")).toBe("30");
    expect(parseManualSize("height", " 24,55 cm ")).toBe("24.6");
    expect(parseManualSize("length", "104CM")).toBe("104");
    expect(() => parseManualSize("height", "250")).toThrow("between 1 and 200");
    expect(() => parseManualSize("length", "3")).toThrow("between 5 and 250");
    expect(() => parseManualSize("height", "tall")).toThrow("number in cm");
    expect(parseManualSize("height", "")).toBeNull();
    expect(parseManualSize("height", null)).toBeNull();
  });
  it("scale: 1:N, 1/N or N", () => {
    for (const v of ["1:18", "1/18", "1 : 18", "18"]) expect(parseManualSize("scale", v)).toBe("1:18");
    expect(() => parseManualSize("scale", "1:1")).toThrow("between 1:2 and 1:500");
    expect(() => parseManualSize("scale", "big")).toThrow("1:18");
  });
  it("other: free text up to 30 chars", () => {
    expect(parseManualSize("other", "Large")).toBe("Large");
    expect(() => parseManualSize("other", "x".repeat(31))).toThrow("30 characters");
  });
});

async function world() {
  const db = mkDb();
  const { cat, mk } = await setup(db);
  const a = await mk("A", "https://a.example/f");
  const b = await mk("B", "https://b.example/f");
  const run = (id: string, url: string, p: any[]) => call(db, "POST", "run", { selected: [id], wait: true }, {}, fakeCrawl({ [url]: p }));
  await run(a, "https://a.example/f", [prod("https://a.example/1", "Goku", 100, { sizeValue: "30" }), prod("https://a.example/2", "Luffy", 200), prod("https://a.example/3", "Zoro", 300, { sizeValue: "22" })]);
  await run(b, "https://b.example/f", [prod("https://b.example/1", "Goku B", 110)]);
  const id = (url: string) => (db.prepare("SELECT group_id FROM listings WHERE url=?").get(url) as any).group_id as string;
  const grid = (q: Record<string, string> = {}) => call(db, "GET", "products", undefined, { category: cat, ...q });
  return { db, cat, a, id, grid, run };
}

describe("setting a product's size by hand", () => {
  it("overrides the scraped size, shows as manual, can be cleared, and is audited", async () => {
    const { db, id, grid } = await world();
    const goku = id("https://a.example/1");
    expect((await call(db, "POST", "product-size", { productId: goku, value: "35 cm" })).size).toBe("35");
    let row = (await grid()).items.find((i: any) => i.name === "Goku");
    expect(row).toMatchObject({ size: "35", sizeManual: true });
    expect((await call(db, "GET", `products/${goku}`))).toMatchObject({ size: "35", sizeManual: true, sizeKind: "height" });
    await call(db, "POST", "product-size", { productId: goku, value: "" }); // clear => back to the scraped 30
    row = (await grid()).items.find((i: any) => i.name === "Goku");
    expect(row).toMatchObject({ size: "30", sizeManual: false });
    expect((db.prepare("SELECT action FROM audit WHERE action LIKE '%product size'").all() as any[]).map((r) => r.action)).toEqual(["Set product size", "Clear product size"]);
  });
  it("fills in a product that had no size, and rejects bad values without changing anything", async () => {
    const { db, id, grid } = await world();
    const luffy = id("https://a.example/2");
    await expect(call(db, "POST", "product-size", { productId: luffy, value: "huge" })).rejects.toMatchObject({ extra: { field: "value" } });
    await expect(call(db, "POST", "product-size", { productId: luffy, value: "999" })).rejects.toThrow("between 1 and 200");
    await expect(call(db, "POST", "product-size", { productId: "nope", value: "10" })).rejects.toMatchObject({ status: 404 });
    expect((await grid()).items.find((i: any) => i.name === "Luffy").size).toBeNull();
    await call(db, "POST", "product-size", { productId: luffy, value: "28" });
    expect((await grid()).items.find((i: any) => i.name === "Luffy")).toMatchObject({ size: "28", sizeManual: true });
  });
  it("survives re-scrapes (which rewrite listing sizes) and sorts by the effective size", async () => {
    const { db, id, grid, run } = await world();
    await call(db, "POST", "product-size", { productId: id("https://a.example/2"), value: "10" }); // Luffy 10, Zoro 22, Goku 30
    await run((db.prepare("SELECT id FROM suppliers WHERE name='A'").get() as any).id, "https://a.example/f", [prod("https://a.example/1", "Goku", 100, { sizeValue: "31" }), prod("https://a.example/2", "Luffy", 200, { sizeValue: "99" }), prod("https://a.example/3", "Zoro", 300, { sizeValue: "22" })]);
    const rows = (await grid({ sort: "size_asc" })).items.map((i: any) => [i.name, i.size]);
    expect(rows).toEqual([["Luffy", "10"], ["Zoro", "22"], ["Goku", "31"], ["Goku B", null]]);
  });
  it("is carried onto a merged product (first selected with a manual size) and kept by the sources on undo; export uses it", async () => {
    const { db, id, grid } = await world();
    const [g1, g2] = [id("https://a.example/1"), id("https://b.example/1")];
    await call(db, "POST", "product-size", { productId: g2, value: "33" });
    const m = await call(db, "POST", "merge", { productIds: [g1, g2], name: "Goku merged", image: null });
    expect((await grid()).items.find((i: any) => i.name === "Goku merged")).toMatchObject({ size: "33", sizeManual: true });
    const impact = await call(db, "GET", `merges/${m.mergeEventId}/undo-impact`);
    await call(db, "POST", "unmerge", { mergeEventId: m.mergeEventId, token: impact.token });
    const after = (await grid()).items;
    expect(after.find((i: any) => i.name === "Goku B")).toMatchObject({ size: "33", sizeManual: true });
    expect(after.find((i: any) => i.name === "Goku")).toMatchObject({ size: "30", sizeManual: false });
    const d = await call(db, "GET", "export-data", undefined, { category: "all", scope: "all" });
    expect(d.products.find((p: any) => p.Name === "Goku B").Size).toBe("33");
  });
});
