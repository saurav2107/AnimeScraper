import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearImageFailures, getImage, ImageError } from "@/lib/imgproxy";

const png = Buffer.from("89504e470d0a1a0a", "hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "img-"));
const noSleep = async () => undefined;
const res = (status: number, body: Buffer | string = png, headers: Record<string, string> = { "content-type": "image/png" }) => new Response(status === 204 ? null : new Uint8Array(Buffer.from(body)), { status, headers });

describe("image proxy", () => {
  it("retries a rate-limited CDN (429) and then caches the image on disk", async () => {
    clearImageFailures();
    let calls = 0;
    const deps = { cacheDir: tmp(), sleep: noSleep, fetchImpl: (async () => (++calls < 3 ? res(429, "slow down", { "retry-after": "1", "content-type": "text/html" }) : res(200))) as unknown as typeof fetch };
    const a = await getImage("https://cdn.example/a.png", deps);
    expect(a.type).toBe("image/png");
    expect(calls).toBe(3);
    const again = await getImage("https://cdn.example/a.png", deps); // served from disk
    expect(again.buf.equals(png)).toBe(true);
    expect(calls).toBe(3);
  });
  it("follows redirects but never to a private host", async () => {
    clearImageFailures();
    const f = (async (u: any) => (String(u).startsWith("https://cdn.example/r") ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/x.png" } }) : res(200))) as unknown as typeof fetch;
    await expect(getImage("https://cdn.example/r.png", { cacheDir: tmp(), sleep: noSleep, fetchImpl: f })).rejects.toMatchObject({ status: 400 });
    const ok = (async (u: any) => (String(u).endsWith("/start.png") ? new Response(null, { status: 301, headers: { location: "/final.png" } }) : res(200))) as unknown as typeof fetch;
    expect((await getImage("https://cdn.example/start.png", { cacheDir: tmp(), sleep: noSleep, fetchImpl: ok })).type).toBe("image/png");
  });
  it("rejects private hosts, non-http, non-images (incl. SVG) and 404s without caching", async () => {
    clearImageFailures();
    const dir = tmp();
    const never = (async () => { throw new Error("should not fetch"); }) as unknown as typeof fetch;
    await expect(getImage("http://localhost:3000/a.png", { cacheDir: dir, fetchImpl: never })).rejects.toBeInstanceOf(ImageError);
    await expect(getImage("file:///etc/passwd", { cacheDir: dir, fetchImpl: never })).rejects.toMatchObject({ status: 400 });
    await expect(getImage("https://cdn.example/x.html", { cacheDir: dir, sleep: noSleep, fetchImpl: (async () => res(200, "<html>", { "content-type": "text/html" })) as unknown as typeof fetch })).rejects.toMatchObject({ status: 415 });
    await expect(getImage("https://cdn.example/x.svg", { cacheDir: dir, sleep: noSleep, fetchImpl: (async () => res(200, "<svg/>", { "content-type": "image/svg+xml" })) as unknown as typeof fetch })).rejects.toMatchObject({ status: 415 });
    await expect(getImage("https://cdn.example/gone.png", { cacheDir: dir, sleep: noSleep, fetchImpl: (async () => res(404, "nope", { "content-type": "application/json" })) as unknown as typeof fetch })).rejects.toMatchObject({ status: 404 });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it("shares one upstream request between simultaneous callers", async () => {
    clearImageFailures();
    let calls = 0;
    const f = (async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return res(200); }) as unknown as typeof fetch;
    const dir = tmp();
    await Promise.all([1, 2, 3, 4, 5].map(() => getImage("https://cdn.example/same.png", { cacheDir: dir, fetchImpl: f })));
    expect(calls).toBe(1);
  });
});
