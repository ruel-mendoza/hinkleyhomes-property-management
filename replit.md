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

- COHO actions mirror: `coho_actions` in Supabase, filled by `syncCohoActions` (artifacts/api-server/src/lib/coho-actions-sync.ts). Runs from the Actions page (Sync now, or automatically when data is >5 min old) and every 15 min from n8n (`n8n/coho-actions-sync.workflow.json` → `POST /api/integrations/coho/actions/sync`, header `X-Hinkley-Sync-Key` = `PMS_SYNC_KEY`). Runs are logged in `integration_sync_runs` with trigger `actions:*`.

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
