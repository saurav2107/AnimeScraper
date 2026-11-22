import type { DB } from "@/db";
import { deleteCategory, listCategories, saveCategory } from "./categories";
import { exportData } from "./export";
import { HttpError, notFound } from "./errors";
import { listMerges, mergeProducts, undoImpact, unmerge } from "./merge";
import { getProduct, listProducts, mergePreview } from "./products";
import { badRequest } from "./errors";
import { acknowledge, onAutomaticEnabled, recoverLock, runNow, scheduled, scheduleSettings, testSupplier, type RunDeps } from "./scrape";
import { appState } from "./summary";
import { deleteSupplier, pauseSupplier, restoreSupplier, saveSupplier } from "./suppliers";
import { setSetting } from "./util";

export interface ApiRequest {
  method: string;
  path: string[];
  query: Record<string, string | undefined>;
  body: any;
  demo?: boolean;
}

/** Central dispatcher (PRD §9). Returns the JSON body; throws HttpError for 4xx. */
export async function api(db: DB, req: ApiRequest, deps: RunDeps = {}): Promise<unknown> {
  const { method, path, query, body } = req;
  const route = path.join("/");
  const mutating = method !== "GET";
  if (mutating && req.demo) throw new HttpError(403, "Demo mode is read-only.");

  if (method === "GET") {
    if (route === "state") return appState(db);
    if (route === "categories") return { categories: listCategories(db) };
    if (route === "products") return listProducts(db, query);
    if (path[0] === "products" && path.length === 2) return getProduct(db, path[1]);
    if (route === "merge-preview") return mergePreview(db, query.ids);
    if (route === "merges") return listMerges(db, query);
    if (path[0] === "merges" && path[2] === "undo-impact") return undoImpact(db, path[1]);
    if (route === "export-data") return exportData(db, query);
    throw notFound("Unknown operation");
  }

  if (method === "POST") {
    switch (route) {
      case "categories": return saveCategory(db, body);
      case "suppliers": return saveSupplier(db, body);
      case "suppliers/restore": return restoreSupplier(db, body?.id);
      case "test": return testSupplier(db, body?.id, deps);
      case "pause": return pauseSupplier(db, body?.id);
      case "run": return runNow(db, { selected: body?.selected, wait: !!body?.wait }, deps);
      case "scheduled": return scheduled(db, deps);
      case "recover": return recoverLock(db);
      case "acknowledge": return acknowledge(db, body ?? {});
      case "merge": return mergeProducts(db, body);
      case "unmerge": return unmerge(db, body);
      case "settings": {
        if (body?.time !== undefined && !(typeof body.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.time))) throw badRequest("Enter a valid time (HH:MM).", { field: "time" });
        const wasOn = scheduleSettings(db).automatic;
        if (typeof body?.time === "string") setSetting(db, "time", body.time);
        if (typeof body?.automatic === "boolean") {
          setSetting(db, "automatic", body.automatic ? "1" : "0");
          if (body.automatic && !wasOn) onAutomaticEnabled(db);
        }
        if (typeof body?.schedulerLinked === "boolean") setSetting(db, "scheduler_linked", body.schedulerLinked ? "1" : "0");
        return { ok: true };
      }
    }
  }
  if (method === "DELETE") {
    if (route === "suppliers") return deleteSupplier(db, body?.id);
    if (route === "categories") return deleteCategory(db, body?.id);
  }
  throw notFound("Unknown operation");
}
