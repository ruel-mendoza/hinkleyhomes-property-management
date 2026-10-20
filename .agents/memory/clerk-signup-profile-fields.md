---
name: Clerk signup profile fields
description: Production Clerk can reject optional first and last name fields during password signup.
---

The published Hinkley Homes app returned `first_name is not a valid parameter for this request` when the password sign-up call included first and last name fields.

**Why:** Replit-managed development and production Clerk tenants have separate settings. Clerk only supports these optional name parameters when its first-and-last-name profile fields are enabled; the production error showed that this parameter was not accepted there.

**How to apply:** Avoid sending `firstName` or `lastName` during password sign-up unless the profile fields are enabled in each target Clerk environment. Preserve the required full name in `unsafeMetadata` for display only, and continue basing access control on the verified email.
