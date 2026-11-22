import fs from "node:fs";
import type { Crawler } from "./crawler";
import { normalize, type CrawlResult, type ScrapedProduct } from "./adapters";
import type { SizeKind } from "./categories";
import type { SupplierConfig } from "./suppliers";

/** One product card read from a rendered page. */
export interface RawCard {
  url: string;
  name: string;
  image: string | null;
  priceText: string;
  text: string;
}

/**
 * Runs inside the page (self-contained: no outside references). Finds product links, walks up to the card
 * that holds the price, and returns plain data. Heuristic on purpose so it works for any storefront whose
 * product links look like /product/<slug>, /products/<slug>, /p/<slug> or /item/<slug>.
 */
export function extractCards(origin: string): RawCard[] {
  const linkRe = /^\/(?:product|products|p|item|shop\/product)\/[^/?#]+\/?$/i;
  const priceRe = /(?:₹|Rs\.?\s?|INR\s?)\s*[\d,]+(?:\.\d+)?/i;
  const byUrl = new Map<string, RawCard>();
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    let u: URL;
    try {
      u = new URL(a.getAttribute("href") || "", document.baseURI);
    } catch {
      continue;
    }
    if (u.origin !== origin || !linkRe.test(u.pathname)) continue;
    const url = u.origin + u.pathname.replace(/\/$/, "");
    if (byUrl.has(url)) continue;
    // climb to the smallest ancestor that contains a price and at most 2 distinct product links
    let card: HTMLElement = a;
    for (let i = 0; i < 7 && card.parentElement; i++) {
      card = card.parentElement;
      if (priceRe.test(card.innerText || "")) {
        const links = new Set(Array.from(card.querySelectorAll<HTMLAnchorElement>("a[href]")).filter((x) => linkRe.test(new URL(x.getAttribute("href") || "", document.baseURI).pathname)).map((x) => x.getAttribute("href")));
        if (links.size <= 2) break;
      }
    }
    const text = (card.innerText || "").replace(/\s+/g, " ").trim();
    const m = priceRe.exec(text);
    const img = card.querySelector("img");
    const name =
      Array.from(card.querySelectorAll<HTMLAnchorElement>(`a[href]`)).map((x) => (x.innerText || "").trim()).find((t) => t.length > 3) ||
      img?.getAttribute("alt") ||
      "";
    byUrl.set(url, { url, name, image: img ? new URL(img.getAttribute("src") || img.getAttribute("data-src") || "", document.baseURI).toString() : null, priceText: m ? m[0] : "", text });
  }
  return Array.from(byUrl.values());
}

/** Convert raw cards to products (shared by the browser adapter and tests). */
export function cardsToProducts(cards: RawCard[], kind: SizeKind, textFilter?: string): ScrapedProduct[] {
  const needle = textFilter?.trim().toLowerCase();
  const out: ScrapedProduct[] = [];
  for (const c of cards) {
    if (needle && !c.text.toLowerCase().includes(needle)) continue;
    const price = /[\d,]+(?:\.\d+)?/.exec(c.priceText)?.[0].replace(/,/g, "");
    const t = c.text.toLowerCase();
    const stock = /out of stock|sold out|outofstock|unavailable/.test(t) ? "outofstock" : /in ?stock|available|add to cart|\badd\b/.test(t) ? "instock" : "";
    const p = normalize(kind, { url: c.url, name: c.name, image: c.image, price, currency: "INR", stock, description: c.text, raw: { text: c.text } });
    if (p) out.push(p);
  }
  return out;
}

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
export function findChrome(): string | null {
  return CHROME_PATHS.find((p) => p && fs.existsSync(p)) ?? null;
}

const LOAD_MORE = /load more|show more|view more/i;

/**
 * "Rendered pages" adapter: opens the listing like a normal visitor would (only pages robots.txt allows),
 * presses the site's own "Load more" button until it disappears, and reads the product cards.
 * Needs Google Chrome/Chromium installed locally (or CHROME_PATH). Images/fonts/media are not downloaded.
 */
export async function renderedList(c: Crawler, startUrl: string, cfg: SupplierConfig, kind: SizeKind): Promise<CrawlResult> {
  const exe = findChrome();
  if (!exe) return { products: [], complete: false, errors: ["Google Chrome or Chromium isn't installed on the server (set CHROME_PATH to its executable)."] };
  if (!(await c.allowed(startUrl))) return { products: [], complete: false, errors: [`Blocked by robots.txt: ${startUrl}`] };
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const errors: string[] = [];
  let complete = true;
  try {
    const page = await (await browser.newContext({ userAgent: "AnimeCartelSupplierIntelligence/1.0 (internal price comparison)" })).newPage();
    await page.route("**/*", (r) => (["image", "font", "media"].includes(r.request().resourceType()) ? r.abort() : r.continue()));
    page.setDefaultTimeout(20000);
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll('a[href*="/product"], a[href*="/p/"], a[href*="/item/"]').length > 0, undefined, { timeout: 20000 }).catch(() => {
      errors.push("No product links appeared after the page loaded (the site may need a login or use a different layout).");
      complete = false;
    });
    for (let i = 0; i < 100 && complete; i++) {
      const btn = page.getByRole("button", { name: LOAD_MORE }).first();
      if (!(await btn.isVisible().catch(() => false))) break;
      const before = await page.evaluate(() => document.querySelectorAll('a[href*="/product"], a[href*="/p/"], a[href*="/item/"]').length);
      await btn.click();
      await page.waitForFunction((n) => document.querySelectorAll('a[href*="/product"], a[href*="/p/"], a[href*="/item/"]').length > n, before, { timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout(1000); // same politeness delay as every other adapter
    }
    if (await page.getByRole("button", { name: LOAD_MORE }).first().isVisible().catch(() => false)) {
      complete = false;
      errors.push("Stopped before the end of the list ('Load more' was still showing).");
    }
    const cards = (await page.evaluate(extractCards, new URL(startUrl).origin)) as RawCard[];
    return { products: cardsToProducts(cards, kind, cfg.textFilter), complete, errors };
  } catch (e) {
    return { products: [], complete: false, errors: [`Rendered page: ${(e as Error).message.split("\n")[0]}`] };
  } finally {
    await browser.close();
  }
}
