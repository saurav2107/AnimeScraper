import { isPublicHost } from "./util";

// Polite fetching: robots.txt, same-origin, 1s delay, retry/backoff, 3MB cap (PRD §3.3, §10).

export const MAX_BYTES = 3 * 1024 * 1024;
const UA = "AnimeCartelSupplierIntelligence/1.0 (internal price comparison)";

export interface CrawlOptions {
  delayMs?: number;
  retries?: number;
  /** Request budget (used by the bounded Test & activate crawl). */
  maxRequests?: number;
  /** Per-request timeout in ms (default 20s). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Turn undici's opaque "fetch failed" into something actionable (host + reason code). */
export function describeNetworkError(e: unknown, url: string): string {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `${host}: request timed out`;
  const code = err?.cause?.code;
  const map: Record<string, string> = { ENOTFOUND: "host not found", ECONNREFUSED: "connection refused", ECONNRESET: "connection reset", ETIMEDOUT: "connection timed out", CERT_HAS_EXPIRED: "TLS certificate expired" };
  if (code) return `${host}: ${map[code] ?? code}`;
  const msg = err?.message ?? "request failed";
  return /^HTTP \d+|robots|Blocked|redirect|too large|budget|Cross-origin/i.test(msg) ? msg : `${host}: ${msg === "fetch failed" ? "network error" : msg}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Crawler {
  private robots = new Map<string, Array<{ allow: boolean; re: RegExp; len: number }>>();
  private last = 0;
  private delayMs: number;
  private retries: number;
  private f: typeof fetch;
  private budget: number;
  private used = 0;
  private timeoutMs: number;
  constructor(public origin: string, opts: CrawlOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.delayMs = opts.delayMs ?? 1000;
    this.retries = opts.retries ?? 2;
    this.budget = opts.maxRequests ?? Infinity;
    this.f = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  /** One fetch with timeout; redirects are followed manually (max 3) and only within the same public origin. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    let cur = url;
    for (let hop = 0; hop <= 3; hop++) {
      if (!this.sameOrigin(cur) || !isPublicHost(new URL(cur).hostname)) throw new Error(`Blocked request to ${new URL(cur).host}`);
      const res = await this.f(cur, { ...init, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        cur = new URL(res.headers.get("location")!, cur).toString();
        continue;
      }
      return res;
    }
    throw new Error("Too many redirects");
  }

  sameOrigin(url: string) {
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }

  private async loadRobots() {
    if (this.robots.has(this.origin)) return;
    const rules: Array<{ allow: boolean; re: RegExp; len: number }> = [];
    const toRe = (pat: string) => new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    try {
      const res = await this.request(`${this.origin}/robots.txt`, { headers: { "user-agent": UA } });
      if (res.ok) {
        let applies = false;
        let prevWasAgent = false;
        for (const line of (await res.text()).split(/\r?\n/)) {
          const l = line.split("#")[0].trim();
          const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(l);
          if (!m) continue;
          const k = m[1].toLowerCase();
          const v = m[2].trim();
          if (k === "user-agent") {
            const hit = v === "*" || UA.toLowerCase().includes(v.toLowerCase());
            applies = prevWasAgent ? applies || hit : hit; // consecutive User-agent lines share one rule group
            prevWasAgent = true;
            continue;
          }
          prevWasAgent = false;
          if (applies && (k === "disallow" || k === "allow") && v) rules.push({ allow: k === "allow", re: toRe(v), len: v.length });
        }
      }
    } catch {
      /* no robots => allowed */
    }
    this.robots.set(this.origin, rules);
  }

  /** RFC 9309: the longest matching rule wins; Allow beats Disallow on a tie. */
  async allowed(url: string): Promise<boolean> {
    await this.loadRobots();
    const u = new URL(url);
    const path = u.pathname + u.search;
    let best: { allow: boolean; len: number } | null = null;
    for (const r of this.robots.get(this.origin) ?? []) {
      if (r.re.test(path) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
    }
    return !best || best.allow;
  }

  private async throttle() {
    const wait = this.last + this.delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
  }

  /** Returns response text; throws on policy or network failure. */
  async get(url: string, accept?: string): Promise<{ text: string; headers: Headers; status: number }> {
    if (!this.sameOrigin(url)) throw new Error(`Cross-origin request blocked: ${url}`);
    if (!(await this.allowed(url))) throw new Error(`Blocked by robots.txt: ${url}`);
    if (++this.used > this.budget) throw new Error("Request budget reached");
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.throttle();
      try {
        const res = await this.request(url, { headers: { "user-agent": UA, accept: accept ?? "text/html,application/xhtml+xml,application/xml,application/json" } });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}`);
          await sleep(this.delayMs * (attempt + 1) * 2);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        const len = Number(res.headers.get("content-length") ?? 0);
        if (len > MAX_BYTES) throw new Error("Response too large");
        const text = await res.text();
        if (text.length > MAX_BYTES) throw new Error("Response too large");
        return { text, headers: res.headers, status: res.status };
      } catch (e) {
        lastErr = e;
        if (e instanceof Error && /HTTP 4\d\d|robots|Cross-origin|too large|budget|Blocked|redirects/.test(e.message)) throw e;
        await sleep(this.delayMs * (attempt + 1));
      }
    }
    throw new Error(describeNetworkError(lastErr, url));
  }

  /** HEAD check used for conservative removal verification. */
  async head(url: string): Promise<number | null> {
    try {
      if (!this.sameOrigin(url)) return null;
      await this.throttle();
      const res = await this.request(url, { method: "HEAD", headers: { "user-agent": UA } });
      return res.status;
    } catch {
      return null;
    }
  }
}
