import { describe, expect, it } from "vitest";
import { crawlSupplier } from "@/lib/adapters";
import { Crawler } from "@/lib/crawler";

const cfg = (adapter: any) => ({ adapter, productUrls: [], sitemapUrls: [], termsAcknowledged: true });
const mk = (origin: string, routes: Record<string, string | { status?: number; body: string }>) =>
  new Crawler(origin, {
    delayMs: 0,
    retries: 0,
    fetchImpl: (async (u: any, init: any) => {
      const url = new URL(String(u));
      const key = url.pathname + url.search;
      const hit = routes[key] ?? routes[url.pathname];
      if (hit === undefined) return new Response("not found", { status: 404 });
      const r = typeof hit === "string" ? { body: hit } : hit;
      return new Response(init?.method === "HEAD" ? null : r.body, { status: r.status ?? 200 });
    }) as unknown as typeof fetch,
  });

describe("robots.txt matching", () => {
  const robots = "User-agent: *\nDisallow: /collections/*sort_by*\nDisallow: /collections/*+*\nDisallow: /cart\nDisallow: /*?*search=\nAllow: /cart/public\nDisallow: /exact$\n";
  it("handles wildcards, $, and longest-match Allow", async () => {
    const c = mk("https://s.example", { "/robots.txt": robots });
    expect(await c.allowed("https://s.example/collections/a/products.json?limit=250&page=1")).toBe(true);
    expect(await c.allowed("https://s.example/collections/a?sort_by=price")).toBe(false);
    expect(await c.allowed("https://s.example/collections/a+b")).toBe(false);
    expect(await c.allowed("https://s.example/cart")).toBe(false);
    expect(await c.allowed("https://s.example/cart/public")).toBe(true);
    expect(await c.allowed("https://s.example/products?x=1&search=a")).toBe(false);
    expect(await c.allowed("https://s.example/exact")).toBe(false);
    expect(await c.allowed("https://s.example/exact/more")).toBe(true);
  });
  it("shares one rule group across consecutive User-agent lines", async () => {
    const c = mk("https://s.example", { "/robots.txt": "User-agent: SomeBot\nUser-agent: *\nDisallow: /private\n\nUser-agent: Other\nDisallow: /all" });
    expect(await c.allowed("https://s.example/private")).toBe(false);
    expect(await c.allowed("https://s.example/all")).toBe(true);
  });
});

describe("shopify adapter", () => {
  const p = (n: number, o: object = {}) => ({ id: n, title: `Figure ${n} 30cm tall`, handle: `fig-${n}`, body_html: "<p>Height: 30 cm</p>", tags: [], options: [], images: [{ src: `https://cdn.example/${n}.jpg` }], variants: [{ price: "1299.00", available: true }, { price: "999.50", available: true }], ...o });
  it("reads a collection feed: lowest available price, stock, canonical URL, size", async () => {
    const c = mk("https://shop.example", {
      "/robots.txt": "User-agent: *\nDisallow: /cart",
      "/collections/figs/products.json?limit=250&page=1": JSON.stringify({ products: [p(1), p(2, { variants: [{ price: "500", available: false }, { price: "700", available: false }] }), p(3, { variants: [{ price: "400", available: false }, { price: "900", available: true }] })] }),
    });
    const r = await crawlSupplier(c, "https://shop.example/collections/figs", cfg("shopify"), "height");
    expect(r.complete).toBe(true);
    expect(r.products.map((x) => [x.url, x.price, x.stock, x.sizeValue])).toEqual([
      ["https://shop.example/products/fig-1", 999.5, "In stock", "30"],
      ["https://shop.example/products/fig-2", 500, "Out of stock", "30"],
      ["https://shop.example/products/fig-3", 900, "In stock", "30"],
    ]);
    expect(r.products[0].image).toBe("https://cdn.example/1.jpg");
  });
  it("pages through full 250-item pages and flags a failing page as incomplete", async () => {
    const full = JSON.stringify({ products: Array.from({ length: 250 }, (_, i) => p(i)) });
    const c = mk("https://shop.example", { "/products.json?limit=250&page=1": full, "/products.json?limit=250&page=2": { status: 500, body: "x" } });
    const r = await crawlSupplier(c, "https://shop.example/", cfg("shopify"), "height");
    expect(r.products).toHaveLength(250);
    expect(r.complete).toBe(false);
    expect(r.errors[0]).toContain("Shopify page 2");
  });
});

describe("jsonld-list adapter", () => {
  const page = (items: Array<[string, string, string]>) =>
    `<html><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "WebSite" }, { "@type": "ItemList", itemListElement: items.map(([url, name, price], i) => ({ "@type": "ListItem", position: i + 1, url, name, image: `https://img.example/${i}.webp`, offers: { "@type": "Offer", price, priceCurrency: "INR" } })) }] })}</script></html>`;
  it("follows ?page=N until a page has no list, de-duplicating", async () => {
    const c = mk("https://inkai.example", {
      "/products": page([["https://inkai.example/products/a", " Luffy ", "2000"], ["https://inkai.example/products/b", "Zoro", "1500"]]),
      "/products?page=2": page([["https://inkai.example/products/b", "Zoro", "1500"], ["/products/c", "Nami", "1700"]]),
      "/products?page=3": "<html>no list</html>",
    });
    const r = await crawlSupplier(c, "https://inkai.example/products", cfg("jsonld-list"), "height");
    expect(r.complete).toBe(true);
    expect(r.products.map((x) => [x.url, x.name, x.price, x.currency, x.stock])).toEqual([
      ["https://inkai.example/products/a", "Luffy", 2000, "INR", "Unknown"],
      ["https://inkai.example/products/b", "Zoro", 1500, "INR", "Unknown"],
      ["https://inkai.example/products/c", "Nami", 1700, "INR", "Unknown"],
    ]);
  });
  it("keeps an existing query string (category filter) when paging, and ignores other origins", async () => {
    const c = mk("https://inkai.example", {
      "/products?category=toys": page([["https://evil.example/x", "Bad", "1"], ["https://inkai.example/products/t1", "Toy", "100"]]),
      "/products?category=toys&page=2": "<html></html>",
    });
    const r = await crawlSupplier(c, "https://inkai.example/products?category=toys", cfg("jsonld-list"), "height");
    expect(r.products.map((x) => x.name)).toEqual(["Toy"]);
  });
});

describe("woocommerce-api stays inside the registered category", () => {
  const cat = (id: number, slug: string, parent = 0) => ({ id, slug, parent, name: slug });
  const prod = (id: number, cats: number[]) => ({ id, name: `P${id}`, permalink: `https://w.example/product/p${id}`, prices: { price: "10000", currency_minor_unit: 2, currency_code: "INR" }, is_in_stock: true, categories: cats.map((i) => ({ id: i })), images: [] });
  // A site whose categories endpoint IGNORES ?slug= (returns everything, "keychains" first) — the real-world failure.
  const routes = (products: any[]) => ({
    "/wp-json/wc/store/v1/products/categories?per_page=100&page=1": JSON.stringify([cat(55, "keychains"), cat(67, "action-figure"), cat(70, "dc", 67), cat(80, "shop-by-series")]),
    "/wp-json/wc/store/v1/products?per_page=100&page=1&category=67": JSON.stringify(products),
  });
  it("resolves the right category id and drops stray products", async () => {
    const c = mk("https://w.example", routes([prod(1, [67]), prod(2, [70]), prod(3, [55, 80])]));
    const r = await crawlSupplier(c, "https://w.example/product-category/action-figure/", cfg("woocommerce-api"), "height");
    expect(r.products.map((p) => p.name)).toEqual(["P1", "P2"]); // P2 is in a sub-category; P3 (keychain) is out
    expect(r.errors).toEqual(["Ignored 1 product(s) outside the registered category."]);
  });
  it("matches a nested category path, and refuses to import everything when the category is unknown", async () => {
    const c = mk("https://w.example", routes([prod(2, [70])]));
    const nested = await crawlSupplier(c, "https://w.example/product-category/action-figure/dc/", cfg("woocommerce-api"), "height");
    expect(nested.products).toEqual([]); // dc (id 70) has no product route in this fixture => failed fetch, nothing imported
    const c2 = mk("https://w.example", routes([]));
    const missing = await crawlSupplier(c2, "https://w.example/product-category/nope/", cfg("woocommerce-api"), "height");
    expect(missing).toMatchObject({ products: [], complete: false });
    expect(missing.errors[0]).toContain('Category "nope" wasn\'t found');
  });
});

describe("woocommerce HTML adapter reads only the main listing", () => {
  const card = (n: number, extra = "") => `<div class="wd-product product type-product instock product_cat-figs ${extra}" data-id="${n}"><a href="https://w.example/product/p${n}/" aria-label="P${n}"><img src="https://w.example/i${n}.jpg"></a><h3 class="wd-entities-title"><a href="https://w.example/product/p${n}/">Figure ${n}</a></h3><span class="price"><del><span class="amount">₹900</span></del><ins><span class="amount">₹${n}00.00</span></ins></span></div>`;
  const grid = (cards: string) => `<div class="products wd-products">${cards}</div>`;
  const page = (cards: string, next = "") => `<html><p class="woocommerce-result-count">Showing 1–2 of 3 results</p>${grid(cards)}${grid(cards)}
    <div class="elementor-widget-wd_products"><div class="wd-carousel"><div class="wd-carousel-item">${card(99)}</div></div></div>
    <ul><li class="product-category product"><a href="https://w.example/product-category/keychains/">Keychains</a></li></ul>${next}</html>`;
  it("skips carousels/category tiles/duplicate grids, follows pagination, checks the stated total", async () => {
    const c = mk("https://w.example", {
      "/product-category/figs/": page(card(1) + card(2), '<a class="next page-numbers" href="/product-category/figs/page/2/">Next</a>'),
      "/product-category/figs/page/2/": page(card(3, "outofstock")),
    });
    const r = await crawlSupplier(c, "https://w.example/product-category/figs/", cfg("woocommerce"), "height");
    expect(r.complete).toBe(true);
    expect(r.products.map((p) => [p.name, p.price, p.stock])).toEqual([["Figure 1", 100, "In stock"], ["Figure 2", 200, "In stock"], ["Figure 3", 300, "Out of stock"]]);
    expect(r.products.every((p) => !p.url.includes("product-category") && !p.url.endsWith("/p99/"))).toBe(true);
  });
  it("refuses to trust a run that read MORE than the page states; only notes when it read fewer (hidden items)", async () => {
    const many = mk("https://w.example", { "/product-category/figs/": page(card(1) + card(2) + card(3)).replace("of 3 results", "of 2 results") });
    const over = await crawlSupplier(many, "https://w.example/product-category/figs/", cfg("woocommerce"), "height");
    expect(over.complete).toBe(false);
    expect(over.errors[0]).toContain("page says 2 products but 3 were read");
    const few = mk("https://w.example", { "/product-category/figs/": page(card(1) + card(2)).replace("of 3 results", "of 357 Products") });
    const under = await crawlSupplier(few, "https://w.example/product-category/figs/", cfg("woocommerce"), "height");
    expect(under.complete).toBe(true);
    expect(under.errors[0]).toContain("Note: the page counts 357 products but shows 2");
  });
  it("store API adapter tells you to switch when its category filter is useless", async () => {
    const cat = (id: number, slug: string) => ({ id, slug, parent: 0 });
    const c = mk("https://w.example", {
      "/wp-json/wc/store/v1/products/categories?per_page=100&page=1": JSON.stringify([cat(1102, "figs")]),
      "/wp-json/wc/store/v1/products?per_page=100&page=1&category=1102": JSON.stringify([{ id: 1, name: "X", permalink: "https://w.example/product/x", prices: { price: "100", currency_minor_unit: 0 }, categories: [{ id: 5 }] }]),
    });
    const r = await crawlSupplier(c, "https://w.example/product-category/figs/", cfg("woocommerce-api"), "height");
    expect(r.complete).toBe(false);
    expect(r.errors.join(" ")).toContain("WooCommerce pages");
  });
});
