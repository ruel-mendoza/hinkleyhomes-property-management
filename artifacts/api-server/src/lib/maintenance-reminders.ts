import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { cohoActionsTable, getDb, isDatabaseConfigured } from "@workspace/db";
import { cohoGet } from "./coho-api";

// Links COHO maintenance jobs to the open COHO actions about the same thing, so
// each page can point at the other. COHO gives an action no maintenance id, so
// an action belongs to a job (same property) when:
// - its stored COHO record (including its links) contains the job's guid, or
// - its title or message names the job number (e.g. M0099), or
// - its title is the last part of the job title: COHO's automatic
//   "Fire Safety Review > Fire Alarm Test Due" job goes with the
//   "Fire Alarm Test Due" fire safety action.

export type MaintenanceReminder = { reference: string; title: string; dueDate: string | null; overdue: boolean };
export type LinkedJob = { guid: string; jobNumber: string | null };
type Job = { guid: string; jobNumber: string | null; title: string | null; propertyReference: string | null; created?: string | null; closed?: boolean };
type ActionRow = { reference: string; title: string | null; message: string | null; property: string | null; raw: string };

const OPEN_STATUSES = ["not_set", "new", "in_progress", "on_hold"] as const;

const lastPart = (title: string | null) => (title ?? "").split(">").pop()!.trim().toLowerCase();

function belongsTo(action: ActionRow, job: Job): boolean {
  if (!job.propertyReference || action.property !== job.propertyReference) return false;
  if (action.raw.toLowerCase().includes(job.guid.toLowerCase())) return true;
  const number = job.jobNumber?.trim();
  if (number && new RegExp(`\\b${number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(`${action.title ?? ""} ${action.message ?? ""}`)) return true;
  const jobTitle = lastPart(job.title);
  return jobTitle !== "" && jobTitle === (action.title ?? "").trim().toLowerCase();
}

// Maintenance page: the open actions for each job on the page.
export async function remindersForJobs(jobs: Job[]): Promise<Map<string, MaintenanceReminder[]>> {
  const found = new Map<string, MaintenanceReminder[]>();
  const properties = [...new Set(jobs.map((job) => job.propertyReference).filter((ref): ref is string => Boolean(ref)))];
  if (!jobs.length || !properties.length || !isDatabaseConfigured()) return found;
  const t = cohoActionsTable;
  const rows = await getDb()
    .select({ reference: t.reference, title: t.title, typeName: t.typeName, message: t.message, dueDate: t.dueDate, overdue: t.overdue, property: t.cohoPropertyReference, raw: sql<string>`${t.raw}::text` })
    .from(t)
    .where(and(inArray(t.status, [...OPEN_STATUSES]), eq(t.archived, false), isNull(t.removedFromCohoAt), inArray(t.cohoPropertyReference, properties)));
  for (const job of jobs) {
    const mine = rows.filter((row) => belongsTo(row, job));
    if (mine.length) {
      found.set(job.guid, mine
        .sort((a, b) => (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity))
        .map((row) => ({ reference: row.reference, title: row.title || row.typeName || "COHO action", dueDate: row.dueDate?.toISOString() ?? null, overdue: row.overdue })));
    }
  }
  return found;
}

// Every maintenance job in COHO (open and closed), kept for 5 minutes.
const JOBS_CACHE_MS = 5 * 60_000;
let jobsCache: { at: number; jobs: Job[] } | null = null;

async function allJobs(): Promise<Job[]> {
  if (jobsCache && Date.now() - jobsCache.at < JOBS_CACHE_MS) return jobsCache.jobs;
  const jobs: Job[] = [];
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  for (let page = 1; page <= 20; page++) {
    const query = new URLSearchParams({ pageSize: "100", sortColumn: "created", sortOrder: "desc", page: String(page) });
    const payload = (await cohoGet(`/maintenance?${query}`)) as { items?: unknown; hasNextPage?: unknown };
    for (const item of Array.isArray(payload.items) ? payload.items : []) {
      const issue = item as Record<string, unknown>;
      const guid = text(issue.guid);
      if (!guid) continue;
      jobs.push({ guid, jobNumber: text(issue.jobNumber), title: text(issue.title), propertyReference: text(issue.propertyReference), created: text(issue.created), closed: Boolean(issue.dateClosed) || /complete|closed/i.test(text(issue.publicStatus) ?? "") });
    }
    if (payload.hasNextPage !== true) break;
  }
  jobsCache = { at: Date.now(), jobs };
  return jobs;
}

// Actions page: the maintenance job each action belongs to, preferring a job
// that is still open, then the newest.
export async function jobsForActions(actions: ActionRow[]): Promise<Map<string, LinkedJob>> {
  const found = new Map<string, LinkedJob>();
  if (!actions.length) return found;
  const jobs = [...(await allJobs())].sort((a, b) => Number(a.closed) - Number(b.closed) || String(b.created ?? "").localeCompare(String(a.created ?? "")));
  for (const action of actions) {
    const job = jobs.find((candidate) => belongsTo(action, candidate));
    if (job) found.set(action.reference, { guid: job.guid, jobNumber: job.jobNumber });
  }
  return found;
}
