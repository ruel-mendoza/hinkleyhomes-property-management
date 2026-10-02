# COHO Maintenance API reference

Saved from COHO official documentation on 2026-10-02. The current integration target is Public API 1.1; the v1.0 document in the original link is legacy and is scheduled to sunset on 6 October 2026 UTC.

- Scalar maintenance reference: https://api.coho.life/scalar/#coho-public-api-11/tag/maintenance
- Full OpenAPI contract: https://api.coho.life/openapi/public-1.1.json
- Migration note: https://api.coho.life/docs/public-api/v1.0-to-v1.1
- Machine-readable maintenance subset: coho-maintenance.openapi.json

## Authentication

Use a COHO API-user key in the server-side Authorization: Bearer <api-key> header. Never put the key in browser code or logs.

## Operations
- GET /v1.1/public/maintenance/categories
- GET /v1.1/public/maintenance
- POST /v1.1/public/maintenance
- GET /v1.1/public/maintenance/{guid}
- PATCH /v1.1/public/maintenance/{guid}
- POST /v1.1/public/maintenance/convert-from-conversation
- PATCH /v1.1/public/maintenance/{guid}/complete
- POST /v1.1/public/maintenance/{guid}/files
- POST /v1.1/public/maintenance/{guid}/files/attach-existing
- GET /v1.1/public/maintenance/{guid}/history
- POST /v1.1/public/maintenance/{guid}/history

## Contract notes

- Maintenance routes identify records by GUID; jobNumber is the human-readable identifier.
- List supports property filters, pagination, created/updated timestamps and sorting.
- Creating an issue requires propertyReference, title and severity; room/category and notes are optional. Severity values are unknown, low, medium and high.
- PATCH updates manager notes and/or severity. Completion uses PATCH /v1.1/public/maintenance/{guid}/complete and requires awaitingDecision: complete, awaitingInvoice, or awaitingOther.
- PATCH request bodies are ordinary partial JSON objects, not RFC 6902 operation arrays.
- Category GUIDs come from GET /v1.1/public/maintenance/categories. Disabled categories are omitted.
- History can be read and manual notes added. File uploads require a separate presigned-upload flow.
- Hinkley PMS demo room labels are not COHO property/room references; map records using references returned by COHO before creating issues.
