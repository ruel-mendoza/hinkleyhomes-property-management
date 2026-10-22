# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `SUPABASE_DATABASE_URL` — Supabase session pooler connection string (`DATABASE_URL` is reserved by Replit and not used)
- Integration env: `COHO_API_KEY`; Xero `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`, `XERO_TOKEN_ENCRYPTION_KEY` (optional `XERO_SCOPES`, `XERO_WEBHOOK_KEY`). All names and formats are documented in `.env.example`; values go in Replit Secrets. The API server logs which integrations are configured at startup.

- COHO actions mirror: `coho_actions` in Supabase, filled by `syncCohoActions` (artifacts/api-server/src/lib/coho-actions-sync.ts). Runs from the Actions page (Sync now, or automatically when data is >5 min old) and every 15 min from n8n (`n8n/coho-actions-sync.workflow.json` → `POST /api/integrations/coho/actions/sync`, header `X-Hinkley-Sync-Key` = `PMS_SYNC_KEY`). Runs are logged in `integration_sync_runs` with trigger `actions:*`. Changes made on the Actions page (status, assign, snooze, edit/create custom actions) go to COHO first, then the action is re-read into `coho_actions` and written to `audit_log` with the staff email. COHO accepts action statuses only as SCREAMING_SNAKE (`IN_PROGRESS`), although it returns camelCase.

- Properties page (`/properties`): `GET /api/properties` merges live COHO properties, open-action counts from `coho_actions`, and register-only properties from Supabase `properties` (added with New property; COHO has no create-property API, so staff add them in COHO too). Buildings live in `buildings` / `building_properties`. Group companies are in `entities` (5 Xero orgs seeded with `pnpm --filter @workspace/db run seed:entities`).
- Website widget: public page `/widget` (no sign-in) reads `GET /api/public/listings`, which lists only properties with a room free, by street, town and postcode area, never house numbers. Cached 5 min.
- Occupancy page (`/occupancy`): `GET /api/occupancy` joins COHO units (`/properties?includeRooms=true`), current and future tenancies (`/tenancies`) and rent review (`/rent-review/tenancies`, for rent and fixed-term end). Dates are converted to UK dates; only tenant names leave the server. "Becoming periodic" = fixed term ending within 60 days (our choice; COHO doesn't expose its window).
- Operations overview money section: `GET /api/overview/money` (cached 5 min) reads COHO rent collection, credit control, deposits and rent review, and Xero banking per company through the n8n gateway (unreconciled bank transactions; balances from `Reports/BankSummary`). Company notes for Management and Stays (no property money) live in `artifacts/api-server/src/routes/money.ts`. Bank Summary accounts are classed as bank, card (Xero `BankAccountType` CREDITCARD) or payment platform (Stripe, PayPal, GoCardless, Telleroo by name); the bank total counts real bank accounts only, and companies whose summary mixes in cards or platforms (or a platform holding £10k+) get notices shown at the top of the overview for the accounts team.
- n8n Xero gateway reports: report resources (`profitAndLoss`, `balanceSheet`, `agedPayables`, `bankSummary`) go through the "Call Xero (reports)" node, which needs a separate n8n OAuth2 credential "Xero reports" with scope `accounting.reports.read` (the built-in "Xero account" credential lacks it, so reports return 401). Everything else still uses "Xero account".
- Performance page (`/performance`): `GET /api/performance` (COHO data cached 1 h, ~25 COHO calls per load) works out rent roll vs target (sum of advertised unit rents), rent paid on time (`paymentStatus` on per-unit rent due records), days late, tenant satisfaction and occupancy, matching COHO's Rent Roll page. COHO's API returns no ended tenancies, so occupancy history, tenancy length and days to fill voids come from `coho_unit_snapshots` (one row per unit per UK day). A snapshot is saved when the page is opened and daily by n8n (`n8n/coho-unit-snapshot.workflow.json` → `POST /api/integrations/coho/unit-snapshot`, header `X-Hinkley-Sync-Key`). After pulling, run `pnpm --filter @workspace/db run push` to create the table.
- Compliance page (`/compliance`): `GET /api/compliance?status=expired|due_30|due_60|due_90|not_started|not_required|all` (cached 10 min) counts items per type from one COHO `/compliancy/overview?groupByProperty=true` call per bucket, and fills Carried Out / Expiry from each listed property's record overviews (cached 30 min; skipped for "not started"/"not required" rows, which have no record). The sidebar link shows the expired count. COHO dates are UK midnight stored in UTC, so `lib/coho-compliance.ts` reads them in Europe/London time (UTC dates were a day early during BST).

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
