---
name: Artifact dependency startup timing
description: Diagnose missing Vite during the first launch of a newly scaffolded web artifact.
---

A freshly created artifact may start its workflow before pnpm finishes wiring package-local executable links. In this session, the first launch reported `vite: not found`; the Vite symlink appeared shortly afterward without code or manifest changes, and restarting the managed workflow succeeded.

**Why:** Artifact creation and package installation can overlap, so a missing executable on the first launch may be a timing issue rather than a broken dependency declaration.

**How to apply:** For an initial `vite: not found`, inspect the artifact's `node_modules/.bin/vite` and lockfile importer. Once the local link exists, restart the existing managed workflow instead of changing package files.