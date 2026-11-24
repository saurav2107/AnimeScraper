import { describe, expect, it } from "vitest";
import { call, mkDb } from "./helpers";

const cats = [{ name: "Action Figures", sizeKind: "height", sizeLabel: "Height", sizeUnit: "cm" }, { name: "Katanas", sizeKind: "length", sizeLabel: "Length", sizeUnit: "cm" }];
const rows = () => [
  { category: "Action Figures", name: "Alpha", url: "https://alpha.example/figures", adapter: "shopify", productUrls: "https://alpha.example/a\nhttps://alpha.example/b", sitemapUrls: "", textFilter: "Figures", excludeText: "keychain", wasActive: true },
  { category: "Katanas", name: "Beta", url: "https://beta.example/katanas", adapter: "woocommerce-api", productUrls: "", sitemapUrls: "", textFilter: "", excludeText: "", wasActive: false },
  { category: "Action Figures", name: "Bad", url: "http://localhost/x", adapter: "shopify", productUrls: "", sitemapUrls: "", textFilter: "", excludeText: "" },
  { category: "Nope", name: "NoCat", url: "https://nocat.example/", adapter: "shopify", productUrls: "", sitemapUrls: "", textFilter: "", excludeText: "" },
];

describe("supplier import", () => {
  it("previews without writing anything", async () => {
    const db = mkDb();
    const r = await call(db, "POST", "suppliers-import", { rows: rows(), categories: cats, dryRun: true });
    expect(r.counts).toEqual({ add: 2, skip: 0, error: 2 });
    expect(r.createdCategories.sort()).toEqual(["Action Figures", "Katanas"]);
    expect((db.prepare("SELECT COUNT(*) c FROM suppliers").get() as any).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM categories").get() as any).c).toBe(0);
  });
  it("restores categories and suppliers (Paused, with settings) in a fresh database", async () => {
    const db = mkDb();
    await expect(call(db, "POST", "suppliers-import", { rows: rows(), categories: cats })).rejects.toThrow("terms");
    const r = await call(db, "POST", "suppliers-import", { rows: rows(), categories: cats, acknowledged: true });
    expect(r.counts.add).toBe(2);
    const state = await call(db, "GET", "state");
    expect(state.suppliers.map((s: any) => s.name).sort()).toEqual(["Alpha", "Beta"]);
    const alpha = state.suppliers.find((s: any) => s.name === "Alpha");
    expect(alpha.status).toBe("Paused");
    expect(alpha.config).toMatchObject({ adapter: "shopify", productUrls: ["https://alpha.example/a", "https://alpha.example/b"], textFilter: "Figures", excludeText: "keychain", termsAcknowledged: true });
    expect(r.results.find((x: any) => x.name === "Alpha").wasActive).toBe(true);
    expect(r.results.filter((x: any) => x.outcome === "error").map((x: any) => x.name).sort()).toEqual(["Bad", "NoCat"]);
  });
  it("skips suppliers that are already registered, so re-importing is safe", async () => {
    const db = mkDb();
    await call(db, "POST", "suppliers-import", { rows: rows(), categories: cats, acknowledged: true });
    const again = await call(db, "POST", "suppliers-import", { rows: rows(), categories: cats, acknowledged: true });
    expect(again.counts.add).toBe(0);
    expect(again.counts.skip).toBe(2);
    expect((db.prepare("SELECT COUNT(*) c FROM suppliers").get() as any).c).toBe(2);
  });
  it("rejects an empty file", async () => {
    await expect(call(mkDb(), "POST", "suppliers-import", { rows: [] })).rejects.toThrow("no supplier rows");
  });
});
