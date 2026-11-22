import { describe, expect, it } from "vitest";
import { Crawler, describeNetworkError } from "@/lib/crawler";
import { nextRun, onAutomaticEnabled, recoverOrphans, scheduleSettings } from "@/lib/scrape";
import { extractSize } from "@/lib/size";
import { isPublicHost, originOf } from "@/lib/util";
import { call, fakeCrawl, mkDb, prod, setup } from "./helpers";

describe("SSRF guard & site identity", () => {
  it("classifies hosts", () => {
    for (const h of ["localhost", "foo.localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.5", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "intranet", "printer.local", "2130706433", "0x7f000001"]) expect(isPublicHost(h), h).toBe(false);
    for (const h of ["example.com", "shop.example.co.in", "8.8.8.8", "172.32.0.1"]) expect(isPublicHost(h), h).toBe(true);
  });
  it("rejects non-public supplier URLs and sitemap/product URLs are filtered", async () => {
    const db = mkDb();
    const { cat } = await setup(db);
    const base = { categoryId: cat, adapter: "jsonld", termsAcknowledged: true };
    await expect(call(db, "POST", "suppliers", { ...base, name: "L", url: "https://localhost:8080/x" })).rejects.toMatchObject({ extra: { field: "url" } });
    await expect(call(db, "POST", "suppliers", { ...base, name: "M", url: "https://169.254.169.254/latest" })).rejects.toThrow("public website");
    const ok = await call(db, "POST", "suppliers", { ...base, name: "P", url: "https://shop.example/x", productUrls: ["https://127.0.0.1/a", "https://shop.example/p1"] });
    expect(JSON.parse((db.prepare("SELECT config FROM suppliers WHERE id=?").get(ok.id) as any).config).productUrls).toEqual(["https://shop.example/p1"]);
  });
  it("treats www. and bare domain as one website", async () => {
    const db = mkDb();
    const { cat, mk } = await setup(db);
    await mk("A", "https://otakumart.example/a");
    expect(originOf("https://WWW.otakumart.example/x")).toBe(originOf("https://otakumart.example/y"));
    await expect(call(db, "POST", "suppliers", { categoryId: cat, name: "B", url: "https://www.otakumart.example/b", adapter: "jsonld", termsAcknowledged: true })).rejects.toThrow("already registered");
  });
});

describe("crawler hardening", () => {
  it("times out hung requests and reports a readable reason", async () => {
    const hang = ((_u: any, init: any) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    const c = new Crawler("https://slow.example", { fetchImpl: hang, timeoutMs: 30, delayMs: 0, retries: 0 });
    await expect(c.get("https://slow.example/p")).rejects.toThrow("request timed out");
  });
  it("blocks redirects that leave the origin and describes network errors", async () => {
    const redir = (async (u: any) => (String(u).endsWith("robots.txt") ? new Response("", { status: 404 }) : new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }))) as unknown as typeof fetch;
    const c = new Crawler("https://shop.example", { fetchImpl: redir, delayMs: 0, retries: 0 });
    await expect(c.get("https://shop.example/p")).rejects.toThrow("Blocked request to evil.example");
    expect(describeNetworkError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }), "https://a.example/x")).toBe("a.example: connection refused");
    expect(describeNetworkError(new Error("fetch failed"), "https://a.example/x")).toBe("a.example: network error");
  });
});

describe("size extraction fixes", () => {
  it("no longer reads 'in' inside words or '5 in 1'; understands metres when anchored", () => {
    expect(extractSize("length", ["Katana with 3 interchangeable blades"])).toBeNull();
    expect(extractSize("length", ["Katana 5 in 1 set"])).toBeNull();
    expect(extractSize("length", ["Katana, 1.5 m long"])).toBe("150");
    expect(extractSize("height", ["Goku 12 in tall"])).toBe("30.5");
  });
});

describe("supplier editing", () => {
  it("rename keeps Active; changing the source pauses; website is locked after import", async () => {
    const db = mkDb();
    const { cat, mk } = await setup(db);
    const id = await mk("A", "https://a.example/f");
    const form = (o: object) => ({ id, categoryId: cat, name: "A", url: "https://a.example/f", adapter: "jsonld", termsAcknowledged: true, ...o });
    expect((await call(db, "POST", "suppliers", form({ name: "A renamed" }))).status).toBe("Active");
    expect((await call(db, "POST", "suppliers", form({ name: "A renamed", url: "https://a.example/g" }))).status).toBe("Paused");
    db.prepare("UPDATE suppliers SET status='Active' WHERE id=?").run(id);
    await call(db, "POST", "run", { selected: [id], wait: true }, {}, fakeCrawl({ "https://a.example/g": [prod("https://a.example/p/1", "One", 10)] }));
    await expect(call(db, "POST", "suppliers", form({ url: "https://other.example/f" }))).rejects.toThrow("website can't be changed");
    expect((await call(db, "POST", "suppliers", form({ url: "https://a.example/h" }))).sourceChanged).toBe(true);
  });
});

describe("run outcomes & recovery", () => {
  it("an empty incomplete crawl is Failed, a partial one stays Partial", async () => {
    const db = mkDb();
    const { mk } = await setup(db);
    const a = await mk("A", "https://a.example/f");
    await call(db, "POST", "run", { selected: [a], wait: true }, {}, { ...fakeCrawl({}), crawl: async () => ({ products: [], complete: false, errors: ["a.example: connection refused"] }) });
    const log = JSON.parse((db.prepare("SELECT log FROM jobs").get() as any).log);
    expect(log[0]).toMatchObject({ status: "Failed", errors: ["a.example: connection refused"] });
  });
  it("recoverOrphans fails jobs left Running and frees the lock", async () => {
    const db = mkDb();
    db.prepare("INSERT INTO jobs (id,kind,status,started,selected,log) VALUES ('j','Manual','Running','now','[]','[]')").run();
    db.prepare("INSERT INTO settings (key,value) VALUES ('run_lock','{\"jobId\":\"j\",\"at\":\"2099-01-01T00:00:00Z\"}')").run();
    expect(recoverOrphans(db)).toBe(1);
    expect(db.prepare("SELECT status FROM jobs").get()).toEqual({ status: "Failed" });
    expect(db.prepare("SELECT 1 FROM settings WHERE key='run_lock'").get()).toBeUndefined();
  });
  it("test & activate fails fast with the reason", async () => {
    const db = mkDb();
    const { cat } = await setup(db);
    const s = await call(db, "POST", "suppliers", { categoryId: cat, name: "A", url: "https://a.example/f", adapter: "jsonld", termsAcknowledged: true });
    await expect(call(db, "POST", "test", { id: s.id }, {}, { ...fakeCrawl({}), crawl: async () => ({ products: [], complete: false, errors: ["a.example: host not found"] }) })).rejects.toThrow("no products found. a.example: host not found");
  });
});

describe("schedule", () => {
  const IST = 5.5 * 3600 * 1000;
  const at = (iso: string) => Date.parse(iso) - IST; // an IST wall-clock moment
  it("rejects invalid times", async () => {
    const db = mkDb();
    await expect(call(db, "POST", "settings", { time: "25:99" })).rejects.toThrow("valid time");
    await call(db, "POST", "settings", { time: "07:30" });
    expect(scheduleSettings(db).time).toBe("07:30");
  });
  it("enabling after today's slot defers the first run to tomorrow; before the slot it is today", () => {
    const db = mkDb();
    db.prepare("INSERT INTO settings (key,value) VALUES ('automatic','1'),('time','09:00')").run();
    const late = at("2026-11-22T23:04:00Z");
    onAutomaticEnabled(db, late);
    expect(nextRun(db, late)).toBe(new Date(at("2026-11-23T09:00:00Z")).toISOString());
    const db2 = mkDb();
    db2.prepare("INSERT INTO settings (key,value) VALUES ('automatic','1'),('time','09:00')").run();
    const early = at("2026-11-22T06:00:00Z");
    onAutomaticEnabled(db2, early);
    expect(nextRun(db2, early)).toBe(new Date(at("2026-11-22T09:00:00Z")).toISOString());
  });
});

describe("bulk acknowledge & export", () => {
  it("acknowledges every NEW listing in a category only", async () => {
    const db = mkDb();
    const { cat, mk } = await setup(db);
    const a = await mk("A", "https://a.example/f");
    await call(db, "POST", "run", { selected: [a], wait: true }, {}, fakeCrawl({ "https://a.example/f": [prod("https://a.example/1", "One", 10), prod("https://a.example/2", "Two", 20)] }));
    expect((await call(db, "GET", "products", undefined, { category: cat, new: "1" })).total).toBe(2);
    expect((await call(db, "POST", "acknowledge", { categoryId: cat })).count).toBe(2);
    expect((await call(db, "GET", "products", undefined, { category: cat, new: "1" })).total).toBe(0);
  });
  it("export has fixed headers, per-supplier price columns and readable dates", async () => {
    const db = mkDb();
    const { cat, mk } = await setup(db);
    const a = await mk("A", "https://a.example/f");
    const b = await mk("B", "https://b.example/f");
    await call(db, "POST", "run", { selected: [a], wait: true }, {}, fakeCrawl({ "https://a.example/f": [prod("https://a.example/1", "One", 10)] }));
    await call(db, "POST", "run", { selected: [b], wait: true }, {}, fakeCrawl({ "https://b.example/f": [prod("https://b.example/1", "One B", null, { stock: "Out of stock" })] }));
    const d = await call(db, "GET", "export-data", undefined, { category: cat, scope: "all" });
    expect(d.headers.products).toEqual(expect.arrayContaining(["Size Type", "Size", "Size Unit", "Price – A", "Price – B"]));
    expect(d.products.find((p: any) => p.Name === "One")["Price – A"]).toBe(10);
    expect(d.products.find((p: any) => p.Name === "One")["Price – B"]).toBe("");
    expect(d.listings[0]["Last Scraped"]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    const empty = await call(db, "GET", "export-data", undefined, { category: cat, scope: "merged" });
    expect(empty.products).toEqual([]);
    expect(empty.headers.merges).toContain("Merge ID");
  });
});

describe("friendly validation errors", () => {
  it("never leaks raw zod text and names the field", async () => {
    const db = mkDb();
    await expect(call(db, "POST", "categories", {})).rejects.toMatchObject({ message: expect.not.stringMatching(/Invalid input|expected/), extra: { field: "name" } });
    await expect(call(db, "GET", "products", undefined, { category: "x", limit: "0" })).rejects.toMatchObject({ message: "Invalid limit." });
    await expect(call(db, "GET", "products", undefined, {})).rejects.toMatchObject({ message: "Enter a category." });
  });
});
