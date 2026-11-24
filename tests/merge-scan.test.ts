import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { normaliseName, photoSim, sigFromBuffer } from "@/lib/merge-scan";
import { call, fakeCrawl, mkDb, prod, setup } from "./helpers";

async function world(extra: Record<string, ReturnType<typeof prod>[]>) {
  const db = mkDb();
  const { cat, mk } = (await setup(db)) as any;
  const a = await mk("Alpha", "https://a.example/f");
  const b = await mk("Beta", "https://b.example/f");
  const map = { "https://a.example/f": extra.a ?? [], "https://b.example/f": extra.b ?? [] };
  await call(db, "POST", "run", { selected: [a, b], wait: true }, {}, fakeCrawl(map));
  const scan = () => call(db, "POST", "merge-scan", { categoryId: cat }).catch((e) => { throw e; });
  return { db, cat, scan };
}

// scan with image analysis off so tests never touch the network
const scanNoImages = async (db: any, cat: string) => (await import("@/lib/merge-scan")).scanMerges(db, cat, { sharp: null });

describe("name normalisation", () => {
  it("drops filler words and sizes, keeps character words", () => {
    expect(normaliseName("Goku Super Saiyan Action Figure 30cm PVC")).toEqual(["goku", "super", "saiyan"]);
  });
});

describe("photo similarity", () => {
  const img = (fn: (x: number, y: number) => number, rgb = [200, 40, 40]) => {
    const w = 32, h = 32, px = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y); for (let c = 0; c < 3; c++) px[(y * w + x) * 3 + c] = Math.round(rgb[c] * v); }
    return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  };
  it("rates the same picture (even re-scaled) above a different one", async () => {
    const grad = await img((x) => x / 32);
    const same = await sharp(grad).resize(64, 64).png().toBuffer();
    const other = await img((_, y) => (y < 16 ? 1 : 0.1), [20, 60, 200]);
    const [a, b, c] = await Promise.all([grad, same, other].map((x) => sigFromBuffer(x, sharp)));
    expect(photoSim(a, b).sim).toBeGreaterThan(0.85);
    expect(photoSim(a, c).sim).toBeLessThan(0.5);
  });
});

describe("merge scan", () => {
  it("suggests same-figure products from different suppliers and never merges", async () => {
    const { db, cat } = await world({
      a: [prod("https://a.example/1", "Goku Super Saiyan Action Figure 30cm", 100), prod("https://a.example/2", "Luffy Gear 5 Figure", 200)],
      b: [prod("https://b.example/1", "Dragon Ball Goku Super Saiyan Figure - 30 cm", 90), prod("https://b.example/2", "Zoro Three Sword Statue", 300)],
    });
    const r = await scanNoImages(db, cat);
    expect(r.scanned).toBe(4);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0].products.map((p) => p.name).sort()).toEqual(["Dragon Ball Goku Super Saiyan Figure - 30 cm", "Goku Super Saiyan Action Figure 30cm"]);
    expect(r.suggestions[0].products.map((p) => p.suppliers[0]).sort()).toEqual(["Alpha", "Beta"]);
    // read-only: still four active products, no merge events
    expect((db.prepare("SELECT COUNT(*) c FROM groups WHERE status='Active'").get() as any).c).toBe(4);
    expect((db.prepare("SELECT COUNT(*) c FROM merge_events").get() as any).c).toBe(0);
  });
  it("does not suggest different styles or different sizes", async () => {
    const { db, cat } = await world({
      a: [prod("https://a.example/1", "Goku Figure Ultra Instinct", 100), prod("https://a.example/2", "Naruto Sage Mode Figure 15cm", 100)],
      b: [prod("https://b.example/1", "Goku Figure Super Saiyan Blue", 90), prod("https://b.example/2", "Naruto Sage Mode Figure 40cm", 90)],
    });
    const r = await scanNoImages(db, cat);
    expect(r.suggestions).toHaveLength(0);
  });
  it("is reachable through the API, skips hidden products, and rejects unknown categories", async () => {
    const { db, cat, scan } = await world({
      a: [prod("https://a.example/1", "Goku Super Saiyan Figure 30cm", 100)],
      b: [prod("https://b.example/1", "Goku Super Saiyan Figure 30cm", 90)],
    });
    expect((await scan()).suggestions).toHaveLength(1);
    const id = (db.prepare("SELECT group_id g FROM listings WHERE url='https://b.example/1'").get() as any).g;
    await call(db, "POST", "products-hide", { productIds: [id] });
    expect((await scan()).suggestions).toHaveLength(0);
    await expect(call(db, "POST", "merge-scan", { categoryId: "nope" })).rejects.toThrow("not found");
    expect(cat).toBeTruthy();
  });
});
