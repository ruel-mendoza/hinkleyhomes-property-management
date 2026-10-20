import { clerkClient, getAuth } from "@clerk/express";
import type { RequestHandler } from "express";
import {
  isAllowedStaffEmail,
  RESTRICTED_EMAIL_MESSAGE,
} from "../lib/staff-email";

export const requireStaffAccess: RequestHandler = async (
  req,
  res,
  next,
): Promise<void> => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const user = await clerkClient.users.getUser(userId);
    const email = user.primaryEmailAddress?.emailAddress ?? "";
    if (!isAllowedStaffEmail(email)) {
      res.status(403).json({ error: RESTRICTED_EMAIL_MESSAGE });
      return;
    }
    next();
  } catch {
    res.status(503).json({ error: "Could not verify account access." });
  }
};
