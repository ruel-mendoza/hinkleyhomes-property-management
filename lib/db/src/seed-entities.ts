// Seeds the group companies that are connected to Xero. Safe to re-run:
// existing rows (matched by Xero tenant id) are left alone.
// Run: pnpm --filter @workspace/db run seed:entities
import { entitiesTable, getDb, getPool } from "./index";

const XERO_ENTITIES = [
  { name: "Hinkley Homes Management", legalName: null, xeroTenantId: "0a290129-b001-4bfb-903d-d27a8ac55738" },
  { name: "Hinkley Homes Holdings", legalName: "Hinkley Homes", xeroTenantId: "3ae8a283-c7e0-4287-9bcd-4c2561295890" },
  { name: "Hinkley Homes Lettings", legalName: "Hinkley Homes Lettings Ltd", xeroTenantId: "47f65b32-d0d7-4417-bb5c-89ff2d93651e" },
  { name: "Hinkley Homes Stays", legalName: "Hinkley Homes Stays Ltd", xeroTenantId: "4c807578-e0a7-49ad-9644-8e705aec0c2a" },
  { name: "Hinkley Homes Ltd", legalName: "Hinkley Homes Ltd", xeroTenantId: "9d1fee42-4203-47d8-87aa-6fa8e8ac0fef" },
];

const inserted = await getDb()
  .insert(entitiesTable)
  .values(XERO_ENTITIES)
  .onConflictDoNothing()
  .returning({ name: entitiesTable.name });
console.log(`Entities added: ${inserted.length} (${inserted.map((row) => row.name).join(", ") || "none, already present"})`);
await getPool().end();
