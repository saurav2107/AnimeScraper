"use client";
import { useState } from "react";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { fmtDate } from "@/lib/client";

const tone = (s: string) => (s === "Completed" ? "green" : s === "Running" ? "blue" : s === "Failed" ? "red" : "amber");

export function HistoryPage({ jobs }: { jobs: any[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Scraping History" />
      {jobs.length === 0 ? <Empty title="No scraping runs yet" /> : (
        <div className="space-y-2">
          {jobs.map((j) => {
            const entries = j.log.filter((l: any) => l.supplier);
            const ret = j.log.find((l: any) => l.retention)?.retention;
            return (
              <Card key={j.id} className="p-3">
                <button className="flex w-full items-center justify-between text-left" onClick={() => setOpen(open === j.id ? null : j.id)}>
                  <span className="flex items-center gap-3"><Badge tone={tone(j.status) as any}>{j.status}</Badge><span className="font-medium">{j.kind} run</span><span className="text-gray-500">{fmtDate(j.started)}</span></span>
                  <span className="text-xs text-gray-500">{entries.length} supplier(s)</span>
                </button>
                {open === j.id && (
                  <div className="mt-3 space-y-2 border-t pt-3">
                    {entries.map((e: any) => (
                      <div key={e.supplierId} className="rounded-md bg-gray-50 p-2 text-sm">
                        <div className="flex items-center justify-between"><b>{e.supplier}</b><Badge tone={tone(e.status) as any}>{e.status}</Badge></div>
                        <p className="text-gray-600">Discovered {e.discovered} · Added {e.added} · Updated {e.updated} · Removed {e.removed}</p>
                        {e.skippedDuplicates > 0 && <p className="text-amber-800">{e.skippedDuplicates} products skipped — already tracked under {[...new Set(e.skippedExamples.map((x: any) => x.owner))].join(", ")}</p>}
                        {e.errors.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-red-700">{e.errors.map((m: string, i: number) => <li key={i}>{m}</li>)}</ul>}
                      </div>
                    ))}
                    {ret && <p className="text-xs text-gray-500">Retention: removed {ret.priceHistoryDeleted} price rows and {ret.historyDeleted} event rows older than 30 days.</p>}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
