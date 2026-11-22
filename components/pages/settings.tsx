"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button, Card, PageHeader, Switch } from "@/components/ui";
import { isDemo, post } from "@/lib/client";

export function SettingsPage({ state, onChanged }: { state: any; onChanged: () => void }) {
  const s = state.settings;
  const [time, setTime] = useState(s.time);
  async function save(patch: Record<string, unknown>, label = "Settings saved") {
    try { await post("settings", patch); toast.success(label); onChanged(); } catch (e) { toast.error((e as Error).message); setTime(s.time); }
  }
  async function recover() {
    try { const r = await post("recover"); toast.success(r.recovered ? "Run lock released" : "No run lock was held"); onChanged(); } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <>
      <PageHeader title="Settings" />
      <Card className="max-w-xl space-y-5 p-5">
        <div className="flex items-center justify-between"><div><p className="font-medium">Automatic scraping</p><p className="text-sm text-gray-500">Runs on alternate days (Asia/Kolkata).</p></div><Switch label="Automatic scraping" checked={s.automatic} disabled={isDemo()} onChange={(v) => save({ automatic: v }, v ? "Automatic scraping on" : "Automatic scraping off")} /></div>
        <div><label className="label" htmlFor="rt">Run time (IST)</label><input id="rt" type="time" className="input w-40" value={time} disabled={isDemo()} onChange={(e) => setTime(e.target.value)} onBlur={() => time && time !== s.time && save({ time }, `Run time set to ${time} IST`)} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur())} /></div>
        <div className="flex items-center justify-between"><div><p className="font-medium">Scheduler linked</p><p className="text-sm text-gray-500">An external task must call <code>POST /api/scheduled</code> at least once a day. Set <code>SCHEDULER_TOKEN</code> on the server to require <code>Authorization: Bearer …</code>.</p></div><Switch label="Scheduler linked" checked={s.schedulerLinked} disabled={isDemo()} onChange={(v) => save({ schedulerLinked: v }, "Settings saved")} /></div>
        <div className="border-t pt-4"><Button variant="outline" disabled={isDemo()} onClick={recover}>Recover stuck run lock</Button><p className="mt-1 text-xs text-gray-500">Only works if a run has held the lock for more than 10 minutes.</p></div>
      </Card>
    </>
  );
}
