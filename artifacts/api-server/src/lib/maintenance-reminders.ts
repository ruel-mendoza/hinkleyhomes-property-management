import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { cohoActionsTable, getDb, isDatabaseConfigured } from "@workspace/db";

// The open COHO actions ("reminders") for each maintenance job, from the synced
// copy in coho_actions. COHO gives an action no maintenance id field, so an
// action belongs to a job when its stored COHO record (including its links)
// mentions the job's guid, or its title or message names the job number.

export type MaintenanceReminder = { reference: string; title: string; dueDate: string | null; overdue: boolean };
type Job = { guid: string; jobNumber: string | null; propertyReference: string | null };

const OPEN_STATUSES = ["not_set", "new", "in_progress", "on_hold"] as const;

export async function remindersForJobs(jobs: Job[]): Promise<Map<string, MaintenanceReminder[]>> {
  const found = new Map<string, MaintenanceReminder[]>();
  const properties = [...new Set(jobs.map((job) => job.propertyReference).filter((ref): ref is string => Boolean(ref)))];
  if (!jobs.length || !properties.length || !isDatabaseConfigured()) return found;
  const t = cohoActionsTable;
  const rows = await getDb()
    .select({ reference: t.reference, title: t.title, typeName: t.typeName, message: t.message, dueDate: t.dueDate, overdue: t.overdue, property: t.cohoPropertyReference, raw: sql<string>`${t.raw}::text` })
    .from(t)
    .where(and(eq(t.category, "maintenance"), inArray(t.status, [...OPEN_STATUSES]), eq(t.archived, false), isNull(t.removedFromCohoAt), inArray(t.cohoPropertyReference, properties)));
  for (const job of jobs) {
    const guid = job.guid.toLowerCase();
    const number = job.jobNumber?.trim() ? new RegExp(`\\b${job.jobNumber.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null;
    const mine = rows.filter((row) =>
      row.property === job.propertyReference &&
      (row.raw.toLowerCase().includes(guid) || (number !== null && number.test(`${row.title ?? ""} ${row.message ?? ""}`))));
    if (mine.length) {
      found.set(job.guid, mine
        .sort((a, b) => (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity))
        .map((row) => ({ reference: row.reference, title: row.title || row.typeName || "COHO action", dueDate: row.dueDate?.toISOString() ?? null, overdue: row.overdue })));
    }
  }
  return found;
}
