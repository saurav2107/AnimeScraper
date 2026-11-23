# AnimeCartel Supplier Intelligence

Category-based supplier price comparison: one product per row, one price column per supplier.
Duplicates are combined **only by an explicit manual merge**, and every merge can be undone.
Requirements live in [`docs/ANIMECARTEL_SUPPLIER_INTELLIGENCE_PRD.md`](docs/ANIMECARTEL_SUPPLIER_INTELLIGENCE_PRD.md).

## Stack
Next.js 15 (App Router) · React 19 · Tailwind 4 · SQLite via `better-sqlite3` · Drizzle (schema + migrations) · Zod · Vitest.

## Run
```bash
npm install
npm run dev            # http://localhost:3000, DB at data/animecartel.sqlite (override with DB_PATH)
npm test               # backend + API tests
npm run db:check       # invariant checks INV-1..INV-9 (PRD 8.4)
```

## Layout
- `db/schema.ts`, `drizzle/` – tables from PRD §8 (categories, suppliers, groups = products, listings, merge_events, merge_event_sources, merge_event_listings, price_history, history, jobs, settings, audit).
- `lib/` – `categories`, `suppliers`, `scrape` (run lock, persistence, retention, schedule), `adapters` + `crawler` + `size`, `products` (grid query), `merge`, `export`, `api` (dispatcher).
- `app/api/[...path]/route.ts` – single JSON API with a same-origin check on mutations.
- `components/` – app shell, comparison grid (`catalog/`), pages (`pages/`).

## Notes
- No login (PRD D-21). Keep it on a private network; do not expose publicly.
- Scheduling: an external task must call `POST /api/scheduled` daily; it runs on alternate days at the configured IST time. Set `SCHEDULER_TOKEN` to require `Authorization: Bearer <token>` on that endpoint.
- Safety: supplier URLs must be public HTTPS hosts (localhost/private ranges are rejected); requests time out after 20 s and never follow redirects off the supplier's origin. A running job refreshes its lock every 30 s; jobs left "Running" by a restart are marked Failed on startup.
- Supplier URLs, categories and any new adapters are supplied later (PRD D-30). Adapters: `woocommerce-api`, `woocommerce`, `jsonld`.
