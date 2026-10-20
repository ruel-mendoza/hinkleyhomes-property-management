import { Router, type IRouter } from "express";
import {
  ValidateSignupEmailBody,
  ValidateSignupEmailResponse,
} from "@workspace/api-zod";
import {
  isAllowedStaffEmail,
  RESTRICTED_EMAIL_MESSAGE,
} from "../lib/staff-email";

const router: IRouter = Router();

router.post("/auth/validate-signup-email", (req, res): void => {
  const body = ValidateSignupEmailBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter a valid email address." });
    return;
  }

  const allowed = isAllowedStaffEmail(body.data.email);
  res.json(
    ValidateSignupEmailResponse.parse({
      allowed,
      message: allowed ? null : RESTRICTED_EMAIL_MESSAGE,
    }),
  );
});

export default router;
