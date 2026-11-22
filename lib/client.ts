"use client";
// Browser-side API wrapper. Demo workspace sends a header so the server uses the read-only sample DB.

let demo = false;
export const setDemo = (v: boolean) => (demo = v);
export const isDemo = () => demo;

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any) {
    super(message);
  }
}

export async function http<T = any>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined | null>): Promise<T> {
  const qs = query
    ? "?" + Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")
    : "";
  const res = await fetch(`/api/${path}${qs === "?" ? "" : qs}`, {
    method,
    headers: { "content-type": "application/json", ...(demo ? { "x-workspace": "demo" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data as T;
}
export const get = <T = any>(path: string, query?: Record<string, any>) => http<T>("GET", path, undefined, query);
export const post = <T = any>(path: string, body?: unknown) => http<T>("POST", path, body ?? {});
export const del = <T = any>(path: string, body?: unknown) => http<T>("DELETE", path, body ?? {});

export const fmtPrice = (p: number | null | undefined, cur?: string | null) => {
  if (p == null) return "—";
  const n = p.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return !cur || cur === "INR" ? `₹${n}` : `${cur} ${n}`;
};
export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");

/** Route a supplier image through the server's cache/proxy (avoids CDN rate limits and hotlink blocks). */
export const imgSrc = (url: string) => (url.startsWith("/") || url.startsWith("data:") ? url : `/api/img?u=${encodeURIComponent(url)}`);
