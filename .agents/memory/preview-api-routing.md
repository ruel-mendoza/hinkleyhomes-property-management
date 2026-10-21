---
name: Preview API routing
description: Browser requests from the Hinkley PMS Vite preview need an explicit development proxy to the separate API service.
---

In development, proxy `/api` from the PMS Vite server to the API server on port 8080. Keep the production API artifact route in place as well; the Vite proxy is for preview requests.

**Why:** The signup form's server-side domain check returned `Failed to fetch` from the preview, while the API endpoint itself responded correctly. Testing the endpoint through Vite confirmed the proxy path reaches the API.

**How to apply:** For changes to the PMS preview or API artifact routing, test `POST /api/auth/validate-signup-email` through the Vite server as well as directly against the API.
