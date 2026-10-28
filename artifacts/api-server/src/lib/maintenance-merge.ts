import { auditLogTable, getDb } from "@workspace/db";
import { cohoRequest } from "./coho-api";
import { logger } from "./logger";

// COHO has no merge or delete for maintenance issues, so "merging" duplicates
// into one issue means: complete each open duplicate with a "Duplicate of …"
// note, add the same note to its manager notes (so closed ones are marked too),
// and audit-log it. The kept issue isn't changed.

export type MergeDuplicate = { guid: string; jobNumber: string | null; managerNotes: string | null; closed: boolean };
export type MergeActor = { email: string | null; userId: string | null; requestId: string | null; ipAddress: string | null };
export type MergeResult = { merged: number; failed: { jobNumber: string; error: string }[] };

export const DUPLICATE_NOTE = /Duplicate of [^,.\n]+, merged in Hinkley PMS/;

export async function mergeMaintenance(keepGuid: string, keepJobNumber: string | null, duplicates: MergeDuplicate[], actor: MergeActor): Promise<MergeResult> {
  const keepLabel = keepJobNumber || keepGuid;
  const day = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
  const note = `Duplicate of ${keepLabel}, merged in Hinkley PMS on ${day}.`;
  const result: MergeResult = { merged: 0, failed: [] };

  for (const duplicate of duplicates) {
    if (duplicate.guid === keepGuid) continue;
    const label = duplicate.jobNumber || duplicate.guid;
    try {
      if (!duplicate.closed) {
        await cohoRequest("PATCH", `/maintenance/${duplicate.guid}/complete`, { awaitingDecision: "complete", completionNotes: note, dateMaintenanceCarriedOut: new Date().toISOString() });
      }
      const existing = duplicate.managerNotes?.trim() ?? "";
      const managerNotes = DUPLICATE_NOTE.test(existing) ? existing : [existing, note].filter(Boolean).join("\n");
      if (managerNotes !== existing) await cohoRequest("PATCH", `/maintenance/${duplicate.guid}`, { managerNotes: managerNotes.slice(0, 2000) });

      await getDb().insert(auditLogTable).values({
        actorEmail: actor.email,
        actorUserId: actor.userId,
        action: "coho_maintenance.merge",
        tableName: "coho_maintenance",
        recordId: duplicate.guid,
        before: { jobNumber: duplicate.jobNumber, closed: duplicate.closed, managerNotes: duplicate.managerNotes },
        after: { duplicateOf: keepGuid, duplicateOfJob: keepJobNumber, completed: true, managerNotes },
        requestId: actor.requestId,
        ipAddress: actor.ipAddress,
      });
      result.merged += 1;
    } catch (error) {
      logger.warn({ guid: duplicate.guid, err: error }, "Duplicate maintenance issue could not be merged");
      result.failed.push({ jobNumber: label, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
