# CLAUDE.md

Hinkley Homes PMS: an internal, staff-only property operations app for Hinkley Homes Group. It sits beside COHO (HMO lettings), Xero (the ledger, one org per group company) and n8n (schedules, email intake, writes to Xero). Read `AGENTS.md` for the business rules (single tenant, `entity_id` on properties, Xero owns money). Read `replit.md` for the detailed notes on each feature and integration. Update it when you change how a feature works.

## User preferences (always apply)

- **Clean UI.** Every page should be calm and easy to scan. Use one clear page header, panels with a title and a short caption, a small set of metrics, plain-English labels and UK dates and money (`en-GB`, `£`). Don't add clutter, repeat the same figure, use heavy colour, or show raw API field names. When you add something, look for something to take away or combine.
- **Every section needs a quick-access entry on the Overview** (`/dashboard`, the `Overview` component in `artifacts/hinkley-pms/src/App.tsx`). Each sidebar page, and each new page or tab you add, must be reachable from the Overview through a compact card or strip that shows its key figure, or at least a link. Use the existing pattern: a `*Strip` component exported from the page file (`PerformanceStrip`, `ReceivablesStrip`, `MoneyTrend`) and placed in `Overview`, or a `Link`/`button` in a panel head. The link must work even when there is nothing to report. A link that only appears in Needs attention doesn't count.
  - Current gaps to close as you go: **Properties**, **Property aliases** and **Occupancy** have no Overview entry. **Actions**, **Compliance** and **Finance checks** appear only when Needs attention has items for them.
- Copy should be short and plain, written for office staff rather than developers. Commit messages are a single plain sentence describing the user-visible change.

## Repo layout (pnpm workspace, Node 24, TS 5.9)

| Path | What it is |
| --- | --- |
| `artifacts/hinkley-pms` | React 19 + Vite 7 SPA (wouter routing, TanStack Query, Clerk auth, Tailwind 4 + hand-written CSS, lucide icons, Recharts). |
| `artifacts/api-server` | Express 5 API, bundled with esbuild (`build.mjs`) to `dist/index.mjs`. Routes are in `src/routes`, logic in `src/lib`. |
| `artifacts/mockup-sandbox` | Replit "Canvas" UI mockup sandbox (`/__mockup`). It isn't part of the product. |
| `lib/api-spec/openapi.yaml` | **The source of truth for the API contract.** Orval generates the two packages below from it. |
| `lib/api-client-react` | Generated React Query hooks (`useGetX`, `getGetXQueryKey`) plus `custom-fetch.ts`. Don't edit `src/generated`. |
| `lib/api-zod` | Generated Zod schemas the server uses for validation. Don't edit `src/generated`. |
| `lib/db` | Drizzle schema (`src/schema/*.ts`), seed and import scripts, `sql/n8n-intake-writer.sql`. |
| `n8n/*.json` | Exported n8n workflows (Xero gateway, daily checks, reminders, bill coding / Route A, COHO syncs, intake). Re-paste them into n8n after you edit them. |
| `scripts/` | Workspace scripts and `post-merge.sh`. |
| `import/` | Git-ignored CSV drop folder for `import:route-a`. |

## Commands

```sh
pnpm install                                         # pnpm only (preinstall blocks npm/yarn)
pnpm --filter @workspace/api-server run dev          # API (build + start)
pnpm --filter @workspace/hinkley-pms run dev         # web app (Vite; needs PORT and BASE_PATH env)
pnpm run typecheck                                   # all packages, the main check (there is no test suite)
pnpm run build                                       # typecheck + build everything
pnpm --filter @workspace/api-spec run codegen        # after editing openapi.yaml
pnpm --filter @workspace/db run push                 # apply Drizzle schema to Supabase (dev)
pnpm --filter @workspace/db run seed:entities        # seed the Xero companies into entities
pnpm --filter @workspace/db run import:route-a       # import old Route A CSVs from import/
```

Env names are documented in `.env.example`, and the values go in Replit Secrets. The DB uses `SUPABASE_DATABASE_URL` with the **session pooler** host. `DATABASE_URL` is reserved by Replit and isn't used.

## How a feature is built (follow this order)

1. Add or change the endpoint and schemas in `lib/api-spec/openapi.yaml`, then run codegen.
2. Add a table, if one is needed, in `lib/db/src/schema/<area>.ts` and export it from `schema/index.ts`, then `push`. Follow the `supabase-postgres-best-practices` skill.
3. Write the server logic in `artifacts/api-server/src/lib/*.ts` and a thin route in `src/routes/*.ts` registered in `routes/index.ts`.
4. Build the page in `artifacts/hinkley-pms/src/pages/<area>/` with its own `<area>.css`. Use the generated hooks, never hand-written `fetch`.
5. Register the route **twice** in `App.tsx`: in the `AppShell` `<Switch>` and in the outer `Router` (`component={ProtectedCRM}`). Add the sidebar entry to `navGroups`.
6. **Add its quick-access entry on the Overview** (see User preferences).
7. Run `pnpm run typecheck`. Document the feature in `replit.md`.

## Architecture and rules

- **Auth.** Clerk on both sides. Only `@hinkleyhomes.co.uk` emails get in (`isAllowedStaffEmail`, which is duplicated in the web app and the API). `requireStaffAccess` sets `res.locals.staff` (`{ userId, email }`) for audit logging.
- **Route order in `routes/index.ts` matters.** Health, auth, `integrationsRouter` (machine endpoints that check the `X-Hinkley-Sync-Key` header against `PMS_SYNC_KEY`) and `publicListingsRouter` (`/widget`) come *before* `requireStaffAccess`. Everything else comes after it.
- **COHO.** Called server-side only (`lib/coho-api.ts`, `COHO_API_KEY`). Most reads are cached in memory for 5–60 min. COHO wants SCREAMING_SNAKE statuses on write but returns camelCase. Its dates are UK midnight, so read them in Europe/London time.
- **Xero.** The app never holds Xero tokens. Every read goes through the n8n gateway webhook (`lib/xero-gateway.ts`, `N8N_XERO_GATEWAY_URL` / `N8N_XERO_GATEWAY_KEY`). Writes (draft bills, reminders, notes) are done by n8n, after the app plans them. Shadow and test modes are on by default. Keep it that way unless the user asks otherwise.
- **Smoobu** (Hinkley Homes Stays) is the source of truth for serviced accommodation; PriceLabs, ChargeAutomation, RentalNinja and the OTAs all connect to it. The app reads it through the n8n Smoobu gateway (like Xero) and is **read-only** towards it (`lib/smoobu-api.ts` only does GETs; the gateway allowlists the paths): never write bookings, rates, availability or guest messages. Webhooks arrive through n8n and are re-read from Smoobu, never trusted.
- **ChargeAutomation** (guest payments, deposits, ID and online check-in for Stays) is also **read-only**: its webhooks come through n8n into `guest_checks` / `payments` (`lib/guest-checks.ts`), and reads go through the n8n ChargeAutomation gateway, which holds the credentials as n8n Variables. Never charge, refund, release deposits or create bookings in it, and don't sync bookings or properties from it (Smoobu feeds it).
- **Postgres (Supabase)** holds operational state: the property register and aliases, `coho_actions` / `coho_unit_snapshots` mirrors, follow-ups, reminders, bill coding reviews, `exception_queue`, `integration_sync_runs`, `audit_log`, `staff_presence`.
- **Audit logging.** Any staff change to follow-ups, aliases, settings, COHO actions or supplier bank details writes to `audit_log` with the staff email.
- **Privacy.** Only send the browser what a page needs. That means tenant names but not contact details, bank account numbers cut to the last 4 digits, and no house numbers on the public widget.
- **Selected property.** The top bar picks a COHO property. Pages take a `selectedPropertyReference` prop and filter by it.

## UI conventions (artifacts/hinkley-pms)

- **The app is dark-only ("Hinkley night desk").** `src/index.css` redefines `:root` and the panel, table and button colours further down the file. Use the existing classes (`panel`, `panel-head`, `panel-title`, `panel-caption`, `metric-small`, `metric-row2`, `button`, `button primary`, `status <state>`, `empty-state`, `table-wrap`) before inventing new ones.
- Fonts are DM Sans for body text and Manrope for the brand. Text is **12px minimum**. Panels are `#192538` and the accent is teal (`#267966` / `#79cdb0`). Chart colours are blue `#3987e5` and orange `#d95926`, through `components/charts/MonthlyBars.tsx`.
- Each page has a header (eyebrow, title, subtitle, actions on the right), metrics, then panels. Every panel handles not-configured, loading, error and empty states with `empty-state`.
- Page CSS lives next to the page and uses a page prefix (e.g. `hh-` on the overview). Check that layouts work at the 1100 / 760 / 460px breakpoints. Wide tables go in `.table-wrap`.
- `components/ui/*` are shadcn primitives. Use them for dialogs, tooltips and popovers.
- Existing files use dense, single-line JSX (see `App.tsx`). Match the style of the file you're editing.

## Gotchas

- `AGENTS.md` says 6 group entities, but the code seeds and reads **5 Xero orgs**. Management and Stays have no property money (see notes in `routes/money.ts`).
- In dev, Vite proxies `/api` to the API server. If an API call fails only in the preview, check the proxy before the endpoint.
- After a React version bump, clear Vite's optimized deps cache before chasing "invalid hook call" errors.
- Xero reports (`profitAndLoss`, `bankSummary`, …) need the separate n8n credential "Xero reports" with `accounting.reports.read`.
- Agent notes from earlier Replit sessions are in `.agents/memory/`.
