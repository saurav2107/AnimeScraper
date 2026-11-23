import type { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
export const badRequest = (m: string, extra?: Record<string, unknown>) => new HttpError(400, m, extra);
export const notFound = (m: string) => new HttpError(404, m);
export const conflict = (m: string, extra?: Record<string, unknown>) => new HttpError(409, m, extra);

const LABELS: Record<string, string> = {
  name: "name", url: "URL", categoryId: "category", sizeKind: "size type", sizeLabel: "size label", sizeUnit: "size unit", adapter: "adapter",
  productIds: "products", image: "image", note: "note", category: "category", minPrice: "minimum price", maxPrice: "maximum price", limit: "limit",
};

/** First zod issue as a human sentence + the offending field (so the UI can mark it). Never leaks raw zod text. */
export function zodError(err: ZodError): HttpError {
  const issue = err.issues[0];
  const field = String(issue.path[0] ?? "");
  const generic = /^(Invalid|Too small|Too big|Unrecognized|Required)/i.test(issue.message);
  const label = LABELS[field] ?? field;
  const message = generic ? (issue.code === "invalid_type" && /undefined/.test(issue.message) ? `Enter a ${label || "value"}.` : `Invalid ${label || "value"}.`) : issue.message;
  return badRequest(message, field ? { field } : {});
}
