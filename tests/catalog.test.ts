import { describe, expect, it } from "vitest";
import { call, fakeCrawl, mkDb, prod, setup } from "./helpers";

describe("categories & suppliers", () => {
  it("validates names and guards deletion", async () => {
    const db = mkDb();
    const { cat, mk } = await setup(db);
    await expect(call(db, "POST", "categories", { name: " action figures ", sizeKind: "height", sizeLabel: "H", sizeUnit: "cm" })).rejects.toThrow("already exists");
    await expect(call(db, "POST", "categories", { name: "x".repeat(61), sizeKind: "scale", sizeLabel: "Scale" })).rejects.toThrow();
    const s1 = await mk("A", "https://a.example/figures");
    await expect(call(db, "DELETE", "categories", { id: cat })).rejects.toMatchObject({ status: 409 });
    await call(db, "DELETE", "suppliers", { id: s1 });
    await call(db, "DELETE", "categories", { id: cat });
    expect((await call(db, "GET", "categories")).categories).toHaveLength(0);
  });

  it("supplier uniqueness rules and category lock", async () => {
    const db = mkDb();
    const { cat, mk } = await setup(db);
    const kat = (await call(db, "POST", "categories", { name: "Katanas", sizeKind: "length", sizeLabel: "Length", sizeUnit: "cm" })).id;
    await mk("A", "https://site.com/figures");
    await expect(call(db, "POST", "suppliers", { categoryId: cat, name: "A2", url: "https://site.com/other", adapter: "jsonld", termsAcknowledged: true })).rejects.toThrow("already registered in Action Figures");
    await expect(call(db, "POST", "suppliers", { categoryId: cat, name: "A3", url: "https://site.com/figures", adapter: "jsonld", termsAcknowledged: true })).rejects.toThrow("already registered as A");
    const ok = await call(db, "POST", "suppliers", { categoryId: kat, name: "A-kat", url: "https://site.com/katanas", adapter: "jsonld", termsAcknowledged: true });
    expect(ok.id).toBeTruthy();
    await expect(call(db, "POST", "suppliers", { name: "x", url: "https://x.com", adapter: "jsonld", termsAcknowledged: true })).rejects.toThrow("category");
  });

  it("soft delete / restore, and restore conflicts", async () => {
    const db = mkDb();
    const { cat, mk } = await setup(db);
    const s = await mk("A", "https://site.com/figures");
    await call(db, "DELETE", "suppliers", { id: s });
    expect((await call(db, "GET", "state")).deletedSuppliers).toHaveLength(1);
    const s2 = await mk("A again", "https://site.com/figures2");
    await expect(call(db, "POST", "suppliers/restore", { id: s })).rejects.toMatchObject({ status: 409 });
    await call(db, "DELETE", "suppliers", { id: s2 });
    const r = await call(db, "POST", "suppliers/restore", { id: s });
    expect(r.status).toBe("Paused");
    expect(cat).toBeTruthy();
  });

  it("blocks delete while a running job includes the supplier", async () => {
    const db = mkDb();
    const { mk } = await setup(db);
    const s = await mk("A", "https://a.example/f");
    db.prepare("INSERT INTO jobs (id,kind,status,started,selected,log) VALUES ('j','Manual','Running','now',?,'[]')").run(JSON.stringify([s]));
    await expect(call(db, "DELETE", "suppliers", { id: s })).rejects.toMatchObject({ status: 409 });
  });
});

describe("scraping", () => {
  it("creates one product per listing, no matching, history without SNAPSHOT", async () => {
    const db = mkDb();
    const { mk } = await setup(db);
    const a = await mk("A", "https://a.example/f");
    const deps = fakeCrawl({ "https://a.example/f": [prod("https://a.example/p/1", "Goku 30cm", 1499, { sizeValue: "30" }), prod("https://a.example/p/2", "Goku", 1400)] });
    await call(db, "POST", "run", { selected: [a], wait: true }, {}, deps);
    expect((db.prepare("SELECT COUNT(*) c FROM groups").get() as any).c).toBe(2);
    expect((db.prepare("SELECT COUNT(*) c FROM listings").get() as any).c).toBe(2);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'reviews'").get()).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) c FROM history WHERE kind='SNAPSHOT'").get() as any).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM price_history").get() as any).c).toBe(2);
  });

  it("skips URLs owned by another registration and logs them", async () => {
    const db = mkDb();
    const { cat, mk } = await setup(db);
    const kat = (await call(db, "POST", "categories", { name: "Katanas", sizeKind: "length", sizeLabel: "Length", sizeUnit: "cm" })).id;
    const r1 = await mk("R1", "https://site.com/figures", cat);
    const r2 = await mk("R2", "https://site.com/katanas", kat);
    const shared = prod("https://site.com/p/1", "Thing", 100);
    await call(db, "POST", "run", { selected: [r1], wait: true }, {}, fakeCrawl({ "https://site.com/figures": [shared] }));
    await call(db, "POST", "run", { selected: [r2], wait: true }, {}, fakeCrawl({ "https://site.com/katanas": [{ ...shared, price: 5 }] }));
    const l = db.prepare("SELECT supplier_id, price FROM listings").all() as any[];
    expect(l).toEqual([{ supplier_id: r1, price: 100 }]);
    const job = db.prepare("SELECT log FROM jobs ORDER BY started DESC, rowid DESC LIMIT 1").get() as any;
    const entry = JSON.parse(job.log)[0];
    expect(entry.skippedDuplicates).toBe(1);
    expect(entry.skippedExamples[0]).toMatchObject({ url: shared.url, owner: "R1" });
  });

  it("price change sets previous_price; unchanged next run keeps it; merges survive re-scrape", async () => {
    const db = mkDb();
    const { cat, mk } = await setup(db);
    const a = await mk("A", "https://a.example/f");
    const b = await mk("B", "https://b.example/f");
    const run = async (id: string, url: string, price: number) => call(db, "POST", "run", { selected: [id], wait: true }, {}, fakeCrawl({ [url]: [prod(`${url}/p`, "Figure", price)] }));
    await run(a, "https://a.example/f", 1499);
    await run(b, "https://b.example/f", 1500);
    await run(a, "https://a.example/f", 1299);
    const l = db.prepare("SELECT * FROM listings WHERE supplier_id = ?").get(a) as any;
    expect(l.previous_price).toBe(1499);
    expect(l.status).toBe("PRICE UPDATED");
    expect((db.prepare("SELECT COUNT(*) c FROM history WHERE kind='PRICE UPDATED'").get() as any).c).toBe(1);

    const ids = (db.prepare("SELECT group_id FROM listings").all() as any[]).map((r) => r.group_id);
    const m = await call(db, "POST", "merge", { productIds: ids, name: "Figure (merged)", image: null });
    await run(a, "https://a.example/f", 1299);
    const after = db.prepare("SELECT status, previous_price, group_id FROM listings WHERE supplier_id = ?").get(a) as any;
    expect(after.status).toBe("Current");
    expect(after.previous_price).toBe(1499);
    expect(after.group_id).toBe(m.productId);
    const grid = await call(db, "GET", "products", undefined, { category: cat });
    expect(grid.items).toHaveLength(1);
    expect(grid.items[0].name).toBe("Figure (merged)");
  });

  it("removal needs a complete crawl and HEAD 404; removed stays in product", async () => {
    const db = mkDb();
    const { cat, mk } = await setup(db);
    const a = await mk("A", "https://a.example/f");
    await call(db, "POST", "run", { selected: [a], wait: true }, {}, fakeCrawl({ "https://a.example/f": [prod("https://a.example/p/1", "One", 10), prod("https://a.example/p/2", "Two", 20)] }));
    const gone = { ...fakeCrawl({ "https://a.example/f": [prod("https://a.example/p/1", "One", 10)] }), fetchImpl: (async (_u: any, init?: any) => new Response(null, { status: init?.method === "HEAD" ? 404 : 200 })) as typeof fetch };
    // partial crawl: nothing removed
    await call(db, "POST", "run", { selected: [a], wait: true }, {}, { ...gone, crawl: async () => ({ products: [prod("https://a.example/p/1", "One", 10)], complete: false, errors: ["x"] }) });
    expect((db.prepare("SELECT COUNT(*) c FROM listings WHERE status='REMOVED'").get() as any).c).toBe(0);
    await call(db, "POST", "run", { selected: [a], wait: true }, {}, gone);
    expect((db.prepare("SELECT COUNT(*) c FROM listings WHERE status='REMOVED'").get() as any).c).toBe(1);
    const grid = await call(db, "GET", "products", undefined, { category: cat });
    const two = grid.items.find((i: any) => i.name === "Two");
    expect(Object.values(two.cells)[0]).toMatchObject({ state: "removed" });
  });

  it("retention prunes rows older than 30 days after a run", async () => {
    const db = mkDb();
    const { mk } = await setup(db);
    const a = await mk("A", "https://a.example/f");
    await call(db, "POST", "run", { selected: [a], wait: true }, {}, fakeCrawl({ "https://a.example/f": [prod("https://a.example/p/1", "One", 10)] }));
    const lid = (db.prepare("SELECT id FROM listings").get() as any).id;
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    db.prepare("INSERT INTO price_history (id,listing_id,price,currency,stock,recorded_at) VALUES ('old',?,1,'INR','In stock',?)").run(lid, old);
    db.prepare("INSERT INTO history (id,listing_id,kind,at) VALUES ('oldh',?,'STOCK UPDATED',?)").run(lid, old);
    await call(db, "POST", "run", { selected: [a], wait: true }, {}, fakeCrawl({ "https://a.example/f": [prod("https://a.example/p/1", "One", 10)] }));
    expect(db.prepare("SELECT 1 FROM price_history WHERE id='old'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM history WHERE id='oldh'").get()).toBeUndefined();
  });

  it("run lock prevents concurrent runs", async () => {
    const db = mkDb();
    const { mk } = await setup(db);
    const a = await mk("A", "https://a.example/f");
    const slow = { ...fakeCrawl({}), crawl: async () => new Promise<any>((r) => setTimeout(() => r({ products: [], complete: true, errors: [] }), 50)) };
    const first = call(db, "POST", "run", { selected: [a], wait: true }, {}, slow);
    await expect(call(db, "POST", "run", { selected: [a] }, {}, slow)).rejects.toMatchObject({ status: 409 });
    await first;
  });
});
