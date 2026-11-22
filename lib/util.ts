import type { DB } from "@/db";

export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();

export function audit(db: DB, action: string, data: unknown) {
  db.prepare("INSERT INTO audit (id, action, data, at) VALUES (?,?,?,?)").run(uid(), action, JSON.stringify(data ?? {}), now());
}

export function getSetting(db: DB, key: string): string | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
}
export function setSetting(db: DB, key: string, value: string) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
export function delSetting(db: DB, key: string) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

export function placeholders(n: number) {
  return Array.from({ length: n }, () => "?").join(",");
}

/** http(s) only (NFR-SEC-03). */
export function httpUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:" ? p.toString() : null;
  } catch {
    return null;
  }
}

/** Website identity: origin with a leading "www." ignored, so www.x.com and x.com are the same site. */
export function originOf(u: string): string {
  try {
    const p = new URL(u);
    return `${p.protocol}//${p.hostname.toLowerCase().replace(/^www\./, "")}${p.port ? ":" + p.port : ""}`;
  } catch {
    return u.toLowerCase();
  }
}

/** False for localhost, single-label names, internal TLDs and private/loopback/link-local IPs (SSRF guard). */
export function isPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return false;
  if (h.includes(":")) return !(h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:"));
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return false; // numeric host tricks
  return h.includes(".");
}
