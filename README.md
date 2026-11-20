# AnimeScraper — AnimeCartel Supplier Intelligence

A private supplier intelligence application built with React 19 / Vinext, TypeScript, Cloudflare Workers and D1. The existing project folder is the source of truth.

## Running locally

Requires Node >=22.13. `npm ci`, `npm run build`, then apply the SQL files in `drizzle/` to the local D1 database before `npm run start`. Use `npm run dev` for frontend changes. Local and hosted databases are independent. Runtime state and validation artifacts should be placed in `/Users/sauravsingh/Documents/Codex`, outside this project.

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to /Users/sauravsingh/Documents/Codex/animecartel/state --file drizzle/0000_pretty_falcon.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev --local --config dist/server/wrangler.json --persist-to /Users/sauravsingh/Documents/Codex/animecartel/state
```

## Implemented

- Responsive dashboard, catalog grid/table, combined search, supplier, material, availability, price and status filters, sorting, supplier comparison.
- Separate illustrative demo workspace; no fabricated catalog or supplier records in the real database. Illustrative character art: https://web.dragonball-api.com/documentation . These are character illustrations, not verified product photographs.
- Persistent supplier configuration. New and edited sources start paused. Terms acknowledgment and successful robots-aware test required before activation. Pause and archive preserve history.
- Bounded HTTP JSON-LD Product adapter and category product-link discovery, explicit URL configuration, extraction normalization and null handling. Public HTTPS only, same-origin discovery, redirects rejected, 1 second delay, bounded retries on 429/503. No login or anti-bot circumvention.
- Manual background runs, source selection, DB overlap lock, per-source logs and progress, preserved raw data and prior prices, new / price / explicit out-of-stock changes.
- Conservative cross-source text, height, material and variant match suggestions; human approval/rejection and split with audit records. No automatic uncertain merging.
- Native .xlsx export with six linked sheets and original source payloads; filters and demo labeling; strings use inline cells to prevent formula execution.
- Hosted owner-private access is enforced by Sites dispatch. Do not make this app public without adding independent authentication and per-operation authorization.

## Verification

`npx tsc --noEmit`, `node --experimental-strip-types --test tests/intelligence.test.mjs`, `npm run build`. Database and API tests use a separate local validation database.

## Operational limits / remaining production work

This is an initial implementation, not acceptance-complete production software.

- The first supplied source is APK A Store (apkastore.in). Its public action-figure category has a dedicated WooCommerce adapter. Robots rules were reviewed; public catalog paths are not disallowed. The site footer links Terms & Conditions to a fragment rather than a published terms page. Further sources still need access and extraction validation. Official feeds, sitemaps, generic selector configuration and browser-rendered sources need additional adapters.
- No vision model provider credentials are configured. Suggestions fall back to explicitly labeled heuristics. An optional multimodal provider adapter uses MATCHING_API_URL, MATCHING_API_TOKEN and MATCHING_MODEL server-side. Its documented request/response contract is in lib/matching.ts. Poses and variants always require review.
- An idempotent unattended update endpoint and alternate-day IST eligibility checks are implemented. See OPERATIONS.md for cloud-task service access and scheduling. Time changes also require updating the linked task.
- Background runs use Workers waitUntil (bounded lifetime), not a durable queue. Large supplier catalogs need a queue/workflow, paginated tasks, per-source checkpoints, timeout recovery, source quotas and resumable locks before production-scale use.
- Removed detection is conservative: absence from a bounded crawl never implies removal. After a successful source crawl, at most five missing known URLs are HEAD-verified. Only explicit 404/410 marks REMOVED; blocked paths, network failures and other status codes preserve the prior record.
- Group approval/rejection, moves, merges and splits are audited. Detail includes price history charts and original additional images. Per-supplier frequency, full category/franchise extraction, and all export options beyond implemented scopes remain work.
- Database backups, retention, run recovery, alerting, rate limiting and end-to-end tests against permitted supplier fixtures remain deployment-hardening work.

## Data model

`suppliers`, `groups`, `listings`, `history`, `jobs`, `reviews`, `settings`, `audit`. Product groups are independent of listings. Listing URLs are unique. Manual decisions are audited. Current data and historical data are separate; failures do not delete supplier records.

## Adding a supplier

Switch from demo to live workspace → Suppliers → Add supplier. Supply a permitted public product or category URL; add explicit product URLs if needed. Review terms, save, then Test & activate. The source must return robots.txt and either Product JSON-LD or supported WooCommerce category cards. Choose the matching adapter. Run scraping now → select source(s), or leave all unchecked for every active supplier. Watch Scraping History.

## Hosting

Sites creates the owner-private deployment and D1 binding from `.openai/hosting.json`; schema-only migrations are applied before deployment. Never commit credentials. Keep the same project ID for updates.

## Provider endpoint contract

Set MATCHING_API_URL, MATCHING_API_TOKEN and optional MATCHING_MODEL as Sites runtime secrets. The HTTPS endpoint receives `{model, task, instructions, listings:[{name,image_url,height_cm,material,description}, ...]}` and must return `{same_variant:boolean, confidence:number, reason:string}`. Only explicit equivalent variants above 0.6 produce visual suggestions. All suggestions require manual approval. API errors fall back to text suggestions with a warning in the run log. Secrets are never sent to the browser.

## Full catalog imports

Choose **WooCommerce public product API (full catalog)** for compatible stores. The importer follows every API page using `per_page=100` and stable ID ordering, obeys robots rules and supplier request delays, converts minor currency units, and checks the retrieved count against `X-WP-Total`. Password-protected records are excluded and counted. Partial coverage is reported as Partial / Completed with errors; it never masquerades as a complete import and never triggers missing-product removal checks.

The JSON-LD adapter now traverses product sitemaps advertised by robots.txt and follows all discovered product URLs. It no longer samples eleven products. WooCommerce category pagination is followed until exhausted. Operational safety limits are explicit incomplete-run errors.

The catalog renders 48 products per page by default. Search, filters and exports still apply to the entire imported catalog. Scraping History shows discovery totals, expected totals, page counts, persistence progress and extraction errors.

Regression checks: `node --experimental-strip-types --test tests/intelligence.test.mjs tests/crawler.test.mjs`; after building, `node tests/scraper.integration.mjs` runs the production Worker against isolated D1 and mocked supplier responses.
