// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cardsToProducts, extractCards } from "@/lib/browser-adapter";

// jsdom has no layout, so innerText is unavailable; mirror it with textContent for the extraction under test.
Object.defineProperty(HTMLElement.prototype, "innerText", { get() { return this.textContent ?? ""; }, configurable: true });

const html = `
<main>
  <div class="card"><a href="/product/goku-30cm"><img alt="Goku" src="/catalog/1.jpg"></a><small>Dragon Ball • Action Figures</small><a href="/product/goku-30cm">Goku Figure 30cm</a><b>₹1,250</b>/pc <span>1 - 20 instock items</span><button>ADD</button></div>
  <div class="card"><a href="/product/thor-axe"><img alt="Thor" src="/catalog/2.jpg"></a><small>Marvel • Katanas &amp; Weapons</small><a href="/product/thor-axe">Thor Axe 52cm</a><b>₹980</b>/pc <span>Out of stock</span></div>
  <div class="card"><a href="/product/goku-30cm">dup link</a></div>
  <a href="/about">About</a><a href="https://other.example/product/x">elsewhere</a>
</main>`;

describe("rendered adapter extraction", () => {
  it("reads one product per distinct same-origin product link, with price, image and stock", () => {
    document.body.innerHTML = html;
    const cards = extractCards(location.origin);
    expect(cards.map((c) => c.url)).toEqual([`${location.origin}/product/goku-30cm`, `${location.origin}/product/thor-axe`]);
    const products = cardsToProducts(cards, "height");
    expect(products.map((p) => [p.name, p.price, p.currency, p.stock])).toEqual([
      ["Goku Figure 30cm", 1250, "INR", "In stock"],
      ["Thor Axe 52cm", 980, "INR", "Out of stock"],
    ]);
    expect(products[0].image).toBe(`${location.origin}/catalog/1.jpg`);
  });
  it("text filter keeps only matching cards (case-insensitive)", () => {
    document.body.innerHTML = html;
    const products = cardsToProducts(extractCards(location.origin), "height", "action figures");
    expect(products.map((p) => p.name)).toEqual(["Goku Figure 30cm"]);
  });
});
