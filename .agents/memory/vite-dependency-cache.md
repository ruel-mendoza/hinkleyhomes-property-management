---
name: Vite dependency cache
description: Stale optimized dependencies can outlive app-local React version changes.
---

After updating an app's React and React DOM versions, Vite can keep serving an optimized dependency bundle built against the old versions even when pnpm resolves both packages consistently. This can appear as a React/renderer version mismatch or invalid hook call.

**Why:** The preview reported React 19.1.4 versus React DOM 19.1.0 while the active package links and pnpm dependency tree both resolved to 19.1.4; clearing Vite's optimized cache resolved the mismatch.

**How to apply:** After changing React or React DOM versions in an app, clear that app's Vite optimized dependency cache and restart its managed dev workflow before troubleshooting runtime hook errors.
