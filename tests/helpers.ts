import { createDb, type DB } from "@/db";
import { api } from "@/lib/api";
import type { ScrapedProduct } from "@/lib/adapters";
import type { RunDeps } from "@/lib/scrape";

export const mkDb = () => createDb(":memory:");
export const call = (db: DB, method: string, path: string, body?: any, query: Record<string, string | undefined> = {}, deps?: RunDeps) =>
  api(db, { method, path: path.split("/"), body, query }, deps) as Promise<any>;

export const prod = (url: string, name: string, price: number | null, extra: Partial<ScrapedProduct> = {}): ScrapedProduct => ({
  url, name, image: null, images: [], price, currency: price == null ? null : "INR", stock: "In stock", material: null, sizeValue: null, raw: null, ...extra,
});

/** crawl stub: returns products by supplier URL */
export function fakeCrawl(map: Record<string, ScrapedProduct[]>, complete = true): RunDeps {
  return {
    delayMs: 0,
    crawl: async (_c, url) => ({ products: map[url] ?? [], complete, errors: [] }),
    fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
  };
}

export async function setup(db: DB) {
  const cat = await call(db, "POST", "categories", { name: "Action Figures", sizeKind: "height", sizeLabel: "Height", sizeUnit: "cm" });
  const mk = async (name: string, url: string, categoryId = cat.id) => {
    const s = await call(db, "POST", "suppliers", { categoryId, name, url, adapter: "jsonld", termsAcknowledged: true });
    db.prepare("UPDATE suppliers SET status = 'Active' WHERE id = ?").run(s.id);
    return s.id as string;
  };
  return { cat: cat.id as string, mk };
}
