import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { call, fakeCrawl, mkDb, prod, setup } from "./helpers";

const png = (fn: (x: number, y: number) => number, rgb: number[]) => {
  const w = 40, h = 40, px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) px[(y * w + x) * 3 + c] = Math.round(rgb[c] * fn(x, y));
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
};

describe("search by photo", () => {
  let dir: string;
  beforeEach(() => { process.env.PHOTO_ENGINE = "basic"; dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgs-")); process.env.IMG_CACHE_DIR = dir; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.IMG_CACHE_DIR; delete process.env.PHOTO_ENGINE; fs.rmSync(dir, { recursive: true, force: true }); });

  it("ranks the visually closest product first, changes nothing, and validates input", async () => {
    const gradient = await png((x) => x / 40, [200, 40, 40]);
    const bands = await png((_, y) => (y < 20 ? 1 : 0.1), [20, 60, 200]);
    vi.stubGlobal("fetch", async (u: string) => new Response(new Uint8Array(u.includes("red") ? gradient : bands), { headers: { "content-type": "image/png" } }));
    const db = mkDb();
    const { cat, mk } = (await setup(db)) as any;
    const a = await mk("Alpha", "https://a.example/f");
    await call(db, "POST", "run", { selected: [a], wait: true }, {}, fakeCrawl({ "https://a.example/f": [prod("https://a.example/1", "Red figure", 10, { image: "https://cdn.example/red.png" }), prod("https://a.example/2", "Blue figure", 20, { image: "https://cdn.example/blue.png" })] }));

    const query = (await sharp(gradient).resize(120, 120).jpeg().toBuffer()).toString("base64");
    const r = await call(db, "POST", "image-search", { categoryId: cat, image: `data:image/jpeg;base64,${query}` });
    expect(r.searched).toBe(2);
    expect(r.matches.length).toBeGreaterThanOrEqual(1);
    const names = r.matches.map((m: any) => (db.prepare("SELECT name FROM groups WHERE id=?").get(m.id) as any).name);
    expect(names[0]).toBe("Red figure");
    expect(r.matches[0].score).toBeGreaterThan(0.85);
    expect(names).not.toContain("Blue figure");
    expect((db.prepare("SELECT COUNT(*) c FROM groups WHERE status='Active'").get() as any).c).toBe(2); // read-only

    await expect(call(db, "POST", "image-search", { categoryId: cat, image: Buffer.from("not an image").toString("base64") })).rejects.toThrow("supported image");
    await expect(call(db, "POST", "image-search", { categoryId: "nope", image: query })).rejects.toThrow("not found");
    await expect(call(db, "POST", "image-search", { categoryId: cat })).rejects.toThrow();
  });
});
