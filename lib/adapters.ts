import * as cheerio from "cheerio";
import type { Crawler } from "./crawler";
import type { SupplierConfig } from "./suppliers";
import type { SizeKind } from "./categories";
import { extractSize } from "./size";
import { httpUrl } from "./util";
import { renderedList } from "./browser-adapter";

export interface ScrapedProduct {
  url: string;
  name: string;
  image: string | null;
  images: string[];
  price: number | null;
  currency: string | null;
  stock: "In stock" | "Out of stock" | "Unknown";
  material: string | null;
  sizeValue: string | null;
  raw: unknown;
}

export interface CrawlResult {
  products: ScrapedProduct[];
  complete: boolean; // false => partial crawl: no removal checks
  errors: string[];
}

const MAX_PRODUCTS = 1500;

function priceNum(v: unknown): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function stockOf(v: unknown): ScrapedProduct["stock"] {
  const s = String(v ?? "").toLowerCase();
  if (!s) return "Unknown";
  if (/out.?of.?stock|soldout|sold.?out|discontinued/.test(s)) return "Out of stock";
  if (/in.?stock|instock|limitedavailability|preorder|onlineonly/.test(s)) return "In stock";
  return "Unknown";
}
const text = (s: string | undefined | null) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();

export function normalize(
  kind: SizeKind,
  p: { url: string; name: string; image?: string | null; images?: string[]; price?: unknown; currency?: string | null; stock?: unknown; material?: string | null; description?: string; attributes?: string; raw?: unknown },
): ScrapedProduct | null {
  const url = httpUrl(p.url);
  const name = text(p.name);
  if (!url || !name) return null;
  const images = [...new Set([p.image, ...(p.images ?? [])].map((i) => httpUrl(i)).filter((i): i is string => !!i))];
  return {
    url: url.replace(/#.*$/, ""),
    name,
    image: images[0] ?? null,
    images,
    price: priceNum(p.price),
    currency: priceNum(p.price) != null ? (p.currency || "INR").toUpperCase() : null,
    stock: stockOf(p.stock),
    material: p.material ?? null,
    sizeValue: extractSize(kind, [name, text(p.description), text(p.attributes)]),
    raw: p.raw ?? null,
  };
}

// ---------- JSON-LD ----------
function findProducts(node: unknown, out: Record<string, unknown>[]) {
  if (Array.isArray(node)) return node.forEach((n) => findProducts(n, out));
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    const t = o["@type"];
    if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) out.push(o);
    if (o["@graph"]) findProducts(o["@graph"], out);
  }
}

export function parseJsonLdProduct(html: string, pageUrl: string, kind: SizeKind): ScrapedProduct | null {
  const $ = cheerio.load(html);
  const found: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      findProducts(JSON.parse($(el).contents().text()), found);
    } catch {
      /* ignore bad JSON-LD */
    }
  });
  const p = found[0];
  if (!p) return null;
  const offerRaw = p.offers as unknown;
  const offers = (Array.isArray(offerRaw) ? offerRaw : [offerRaw]).filter(Boolean) as Record<string, unknown>[];
  const offer = offers[0] ?? {};
  const spec = (offer.priceSpecification ?? {}) as Record<string, unknown>;
  const img = p.image;
  const images = (Array.isArray(img) ? img : [img]).map((i) => (typeof i === "string" ? i : (i as { url?: string })?.url)).filter(Boolean) as string[];
  return normalize(kind, {
    url: (typeof p.url === "string" ? p.url : null) ?? pageUrl,
    name: String(p.name ?? ""),
    image: images[0],
    images,
    price: offer.price ?? offer.lowPrice ?? spec.price,
    currency: (offer.priceCurrency as string) ?? (spec.priceCurrency as string) ?? "INR",
    stock: offer.availability,
    material: (p.material as string) ?? null,
    description: String(p.description ?? ""),
    raw: p,
  });
}

async function jsonld(c: Crawler, cfg: SupplierConfig, kind: SizeKind): Promise<CrawlResult> {
  const errors: string[] = [];
  let complete = true;
  const urls = new Set<string>(cfg.productUrls.filter((u) => c.sameOrigin(u)));
  const visited = new Set<string>();
  const queue = [...cfg.sitemapUrls.filter((u) => c.sameOrigin(u))];
  while (queue.length && visited.size < 20) {
    const sm = queue.shift()!;
    if (visited.has(sm)) continue;
    visited.add(sm);
    try {
      const { text: xml } = await c.get(sm, "application/xml,text/xml");
      const $ = cheerio.load(xml, { xmlMode: true });
      $("sitemap > loc").each((_, el) => void queue.push($(el).text().trim()));
      $("url > loc").each((_, el) => {
        const u = $(el).text().trim();
        if (c.sameOrigin(u) && !/\.(jpg|jpeg|png|webp|gif)$/i.test(u)) urls.add(u);
      });
    } catch (e) {
      complete = false;
      errors.push(`Sitemap ${sm}: ${(e as Error).message}`);
    }
  }
  const products: ScrapedProduct[] = [];
  for (const u of [...urls].slice(0, MAX_PRODUCTS)) {
    try {
      const { text: html } = await c.get(u);
      const p = parseJsonLdProduct(html, u, kind);
      if (p) products.push(p);
    } catch (e) {
      complete = false;
      errors.push(`${u}: ${(e as Error).message}`);
    }
  }
  if (urls.size > MAX_PRODUCTS) complete = false;
  return { products, complete, errors };
}

// ---------- WooCommerce HTML cards ----------
/** Parse "Showing 1–24 of 163 results" / "Showing all 12 results" => the total the site says this listing has. */
export function expectedResultCount($: cheerio.CheerioAPI): number | null {
  const t = $(".woocommerce-result-count").first().text().replace(/\s+/g, " ");
  const m = /of\s+([\d,]+)\s+(?:results?|products?)/i.exec(t) ?? /all\s+([\d,]+)\s+(?:results?|products?)/i.exec(t) ?? /^\s*Showing the single result/i.exec(t);
  if (!m) return null;
  return m[1] ? parseInt(m[1].replace(/,/g, ""), 10) : 1;
}

/** Product cards of the MAIN listing only (not related/upsell/widget/carousel blocks, not category tiles); deduped by URL. */
export function wooCards($: cheerio.CheerioAPI, pageUrl: string, kind: SizeKind): ScrapedProduct[] {
  const out = new Map<string, ScrapedProduct>();
  $(".type-product, li.product:not(.product-category)").each((_, el) => {
    const $el = $(el);
    if ($el.hasClass("product-category") || $el.closest(".related, .upsells, .up-sells, .cross-sells, .widget, .wd-carousel, .owl-carousel, .swiper, .elementor-widget-wd_products").length) return;
    const link = $el.find("a[href*='/product/']").not("[href*='/product-category/']").first().attr("href") ?? $el.find("a.woocommerce-LoopProduct-link").first().attr("href");
    if (!link) return;
    const url = new URL(link, pageUrl).toString().replace(/#.*$/, "");
    if (out.has(url)) return;
    // on sale: <del> holds the old price and <ins> the current one (a combined selector would return the old price first)
    const sale = $el.find(".price ins .amount").first();
    const priceEl = sale.length ? sale : $el.find(".price .amount").first();
    const img = $el.find("img").first();
    const src = [img.attr("data-src"), img.attr("data-lazy-src"), img.attr("src")].find((v) => v && !v.startsWith("data:"));
    const classes = ($el.attr("class") ?? "").split(/\s+/);
    const n = normalize(kind, {
      url,
      name: $el.find(".wd-entities-title, .woocommerce-loop-product__title, h2, h3").first().text() || $el.find("a[aria-label]").first().attr("aria-label") || img.attr("alt") || "",
      image: src ? new URL(src, pageUrl).toString() : null,
      price: priceEl.text(),
      currency: "INR",
      stock: classes.includes("outofstock") ? "outofstock" : classes.includes("instock") || classes.includes("onbackorder") ? "instock" : "",
      raw: { categories: classes.filter((c) => c.startsWith("product_cat-")).map((c) => c.slice(12)), classes: classes.slice(0, 30) },
    });
    if (n) out.set(url, n);
  });
  return [...out.values()];
}

async function woocommerce(c: Crawler, startUrl: string, kind: SizeKind): Promise<CrawlResult> {
  const products = new Map<string, ScrapedProduct>();
  const errors: string[] = [];
  let complete = true;
  let next: string | null = startUrl;
  let expected: number | null = null;
  const seen = new Set<string>();
  for (let page = 0; next && page < 100 && !seen.has(next); page++) {
    seen.add(next);
    try {
      const { text: html } = await c.get(next);
      const $ = cheerio.load(html);
      expected ??= expectedResultCount($);
      for (const p of wooCards($, next, kind)) products.set(p.url, p);
      const nx = $("a.next.page-numbers, a.next, link[rel=next]").first().attr("href");
      next = nx ? new URL(nx, next).toString() : null;
      if (next && !c.sameOrigin(next)) next = null;
    } catch (e) {
      complete = false;
      errors.push(`${next}: ${(e as Error).message}`);
      break;
    }
  }
  // The site states how many products this listing has. MORE than stated means we picked up cards from elsewhere on the page,
  // so refuse to trust the run. FEWER is normal when the shop hides some items (e.g. out of stock), so only note it.
  if (complete && expected != null) {
    if (products.size > expected) {
      complete = false;
      errors.push(`The page says ${expected} products but ${products.size} were read. Nothing was removed; check the adapter or URL.`);
    } else if (products.size < expected) {
      errors.push(`Note: the page counts ${expected} products but shows ${products.size}; the shop hides the rest.`);
    }
  }
  return { products: [...products.values()], complete, errors };
}

// ---------- WooCommerce Store API ----------
interface WooCat { id: number; slug: string; parent: number }

/** Every category on the site (the Store API ignores ?slug= on some sites, so we match the slug ourselves). */
async function wooCategories(c: Crawler, origin: string): Promise<WooCat[]> {
  const all: WooCat[] = [];
  for (let page = 1; page <= 20; page++) {
    const { text } = await c.get(`${origin}/wp-json/wc/store/v1/products/categories?per_page=100&page=${page}`, "application/json");
    const items = JSON.parse(text) as WooCat[];
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

async function woocommerceApi(c: Crawler, startUrl: string, kind: SizeKind): Promise<CrawlResult> {
  const products: ScrapedProduct[] = [];
  const errors: string[] = [];
  let complete = true;
  const origin = new URL(startUrl).origin;
  // /product-category/<a>/<b>/ => the registered scope is category path "a/b"
  const pathSlugs = /\/product-category\/([^?#]+)/.exec(startUrl)?.[1]?.split("/").filter(Boolean);
  let catId: number | null = null;
  let scope = new Set<number>(); // the category plus all its sub-categories (what the site's own category page shows)
  if (pathSlugs?.length) {
    try {
      const cats = await wooCategories(c, origin);
      const byId = new Map(cats.map((x) => [x.id, x]));
      const pathOf = (x: WooCat) => { const parts: string[] = []; for (let cur: WooCat | undefined = x; cur; cur = cur.parent ? byId.get(cur.parent) : undefined) parts.unshift(cur.slug); return parts.join("/"); };
      const want = pathSlugs.join("/");
      const hit = cats.find((x) => pathOf(x) === want) ?? cats.find((x) => x.slug === pathSlugs[pathSlugs.length - 1]);
      if (!hit) return { products: [], complete: false, errors: [`Category "${want}" wasn't found on this site, so nothing was imported. Check the URL.`] };
      catId = hit.id;
      scope = new Set([hit.id]);
      for (let grew = true; grew; ) { grew = false; for (const x of cats) if (!scope.has(x.id) && scope.has(x.parent)) (scope.add(x.id), (grew = true)); }
    } catch (e) {
      return { products: [], complete: false, errors: [`Couldn't read the site's categories: ${(e as Error).message}`] };
    }
  }
  const catParam = catId ? `&category=${catId}` : "";
  let total: number | null = null;
  let outOfScope = 0;
  for (let page = 1; page <= 50; page++) {
    try {
      const { text, headers } = await c.get(`${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}${catParam}`, "application/json");
      const items = JSON.parse(text) as Array<Record<string, any>>;
      total = Number(headers.get("x-wp-total")) || total;
      for (const it of items) {
        // belt and braces: only keep products that really sit under the registered category
        if (catId && !(it.categories ?? []).some((k: any) => scope.has(k.id))) { outOfScope++; continue; }
        const minor = Number(it.prices?.currency_minor_unit ?? 2);
        const priceRaw = it.prices?.price;
        const price = priceRaw != null && priceRaw !== "" ? Number(priceRaw) / Math.pow(10, minor) : null;
        const attrs = (it.attributes ?? []).map((a: any) => `${a.name}: ${(a.terms ?? []).map((t: any) => t.name).join(", ")}`).join("; ");
        const n = normalize(kind, {
          url: it.permalink,
          name: it.name,
          image: it.images?.[0]?.src,
          images: (it.images ?? []).map((i: any) => i.src),
          price,
          currency: it.prices?.currency_code ?? "INR",
          stock: it.is_in_stock === false ? "outofstock" : it.is_in_stock ? "instock" : "",
          description: `${it.short_description ?? ""} ${it.description ?? ""}`,
          attributes: attrs,
          raw: it,
        });
        if (n) products.push(n);
      }
      if (items.length < 100) break;
    } catch (e) {
      complete = false;
      errors.push(`Store API page ${page}: ${(e as Error).message}`);
      break;
    }
  }
  if (outOfScope) errors.push(`Ignored ${outOfScope} product(s) outside the registered category.`);
  if (catId && outOfScope && !products.length) {
    complete = false;
    errors.push("This site's API doesn't filter by category reliably. Use the “WooCommerce pages” adapter for this supplier instead.");
  }
  if (complete && total != null && !catParam && products.length < total) complete = false;
  return { products, complete, errors };
}

// ---------- Shopify (/products.json) ----------
async function shopify(c: Crawler, startUrl: string, kind: SizeKind): Promise<CrawlResult> {
  const products: ScrapedProduct[] = [];
  const errors: string[] = [];
  let complete = true;
  const u = new URL(startUrl);
  const coll = /^\/collections\/([^/]+)/.exec(u.pathname)?.[1];
  const base = `${u.origin}${coll ? `/collections/${coll}` : ""}/products.json`;
  for (let page = 1; page <= 100; page++) {
    try {
      const { text } = await c.get(`${base}?limit=250&page=${page}`, "application/json");
      const items = (JSON.parse(text).products ?? []) as Array<Record<string, any>>;
      for (const it of items) {
        const variants = (it.variants ?? []) as Array<Record<string, any>>;
        const open = variants.filter((v) => v.available);
        const pool = open.length ? open : variants;
        const prices = pool.map((v) => parseFloat(v.price)).filter((n) => Number.isFinite(n) && n > 0);
        const opts = (it.options ?? []).map((o: any) => `${o.name}: ${(o.values ?? []).join(", ")}`).join("; ");
        const n = normalize(kind, {
          url: `${u.origin}/products/${it.handle}`,
          name: it.title,
          image: it.images?.[0]?.src ?? it.image?.src,
          images: (it.images ?? []).map((i: any) => i.src),
          price: prices.length ? Math.min(...prices) : null,
          currency: "INR", // products.json carries no currency; the supplier sells in INR (same assumption as other adapters)
          stock: variants.length ? (open.length ? "instock" : "outofstock") : "",
          description: it.body_html,
          attributes: `${opts} ${(it.tags ?? []).join(", ")}`,
          raw: it,
        });
        if (n) products.push(n);
      }
      if (items.length < 250) break;
    } catch (e) {
      complete = false;
      errors.push(`Shopify page ${page}: ${(e as Error).message}`);
      break;
    }
  }
  return { products, complete, errors };
}

// ---------- JSON-LD listing pages (schema.org ItemList with offers) ----------
function itemListOf(html: string): Array<Record<string, any>> {
  const $ = cheerio.load(html);
  const out: Array<Record<string, any>> = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (n: any) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== "object") return;
        if (n["@type"] === "ItemList" && Array.isArray(n.itemListElement)) out.push(...n.itemListElement);
        if (n["@graph"]) walk(n["@graph"]);
      };
      walk(JSON.parse($(el).contents().text()));
    } catch {
      /* ignore */
    }
  });
  return out;
}

async function jsonldList(c: Crawler, startUrl: string, kind: SizeKind): Promise<CrawlResult> {
  const products: ScrapedProduct[] = [];
  const errors: string[] = [];
  let complete = true;
  const seen = new Set<string>();
  for (let page = 1; page <= 100; page++) {
    const u = new URL(startUrl);
    if (page > 1) u.searchParams.set("page", String(page));
    try {
      const { text } = await c.get(u.toString());
      const els = itemListOf(text);
      let fresh = 0;
      for (const el of els) {
        const item = (el.item && typeof el.item === "object" ? el.item : el) as Record<string, any>;
        const offer = (Array.isArray(item.offers) ? item.offers[0] : item.offers) ?? {};
        const link = typeof el.url === "string" ? el.url : item.url;
        if (!link) continue;
        const abs = new URL(link, u).toString();
        if (seen.has(abs) || !c.sameOrigin(abs)) continue;
        seen.add(abs);
        fresh++;
        const n = normalize(kind, { url: abs, name: String(item.name ?? el.name ?? ""), image: typeof item.image === "string" ? item.image : item.image?.[0], price: offer.price ?? offer.lowPrice, currency: offer.priceCurrency ?? "INR", stock: offer.availability, raw: el });
        if (n) products.push(n);
      }
      if (!els.length || !fresh) break; // an empty or repeated page ends the listing
    } catch (e) {
      complete = false;
      errors.push(`Listing page ${page}: ${(e as Error).message}`);
      break;
    }
  }
  return { products, complete, errors };
}

export async function crawlSupplier(c: Crawler, url: string, cfg: SupplierConfig, kind: SizeKind): Promise<CrawlResult> {
  if (cfg.adapter === "rendered") return renderedList(c, url, cfg, kind);
  if (cfg.adapter === "shopify") return shopify(c, url, kind);
  if (cfg.adapter === "jsonld-list") return jsonldList(c, url, kind);
  if (cfg.adapter === "woocommerce-api") return woocommerceApi(c, url, kind);
  if (cfg.adapter === "woocommerce") return woocommerce(c, url, kind);
  return jsonld(c, { ...cfg, productUrls: cfg.productUrls.length || cfg.sitemapUrls.length ? cfg.productUrls : [url] }, kind);
}
