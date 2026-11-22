import { NextRequest, NextResponse } from "next/server";
import { demoDb, liveDb } from "@/db";
import { api } from "@/lib/api";
import { HttpError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  // Same-origin check on mutating requests (NFR-SEC-01). Scheduler calls carry no Origin header.
  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== req.headers.get("host")) return NextResponse.json({ error: "Origin rejected" }, { status: 403 });
  }
  // The scheduler endpoint can be locked with a shared secret: set SCHEDULER_TOKEN and send it as a Bearer token.
  if (path.join("/") === "scheduled" && process.env.SCHEDULER_TOKEN) {
    const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? req.headers.get("x-scheduler-token");
    if (given !== process.env.SCHEDULER_TOKEN) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const demo = req.headers.get("x-workspace") === "demo";
  let body: unknown = {};
  if (req.method !== "GET") {
    try {
      body = await req.json();
    } catch {
      body = {};
    }
  }
  const query = Object.fromEntries(req.nextUrl.searchParams.entries());
  try {
    const db = demo ? await demoDb() : liveDb();
    const out = await api(db, { method: req.method, path, query, body, demo });
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message, ...e.extra }, { status: e.status });
    console.error(e);
    return NextResponse.json({ error: (e as Error).message || "Unexpected error" }, { status: 400 });
  }
}

export { handle as GET, handle as POST, handle as DELETE };
