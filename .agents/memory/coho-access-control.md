---
name: COHO access boundary
description: Access-control assumption for live COHO data in Hinkley PMS.
---

The user confirmed that the PMS is restricted to staff by a private deployment or network access controls. The COHO API key authenticates the server to COHO; it is not the PMS access boundary and must remain server-side.

**Why:** The maintenance integration exposes tenant/property data and permits issue changes.

**How to apply:** Keep the COHO page and proxy within the externally protected access boundary. If that boundary changes, add in-app authentication before exposing live COHO data.