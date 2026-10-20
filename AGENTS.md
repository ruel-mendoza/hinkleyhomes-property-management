# Property Management System (Hinkley Homes Group) - System Context & Rules

## 1. System Scope & Multi-Tenancy
- **Single-Tenant Model Only:** The application manages properties, tenants, units, and maintenance strictly for Hinkley Homes Group (6 group entities). Do NOT introduce multi-tenant database schemas, `organization_id` columns, or multi-tenant SaaS abstractions.
- **Entity Architecture:** Track properties across the 6 parent entities via a central `entity_id` foreign key on the property table.

## 2. Core Operational Modules
- **Master Property Register:** Standardize all 102+ property address variations and room allocations (e.g., "51 Bridgwater Rd" vs "51 A") against a canonical alias table.
- **Tenant & Payment Tracking:** Real-time tracking of long-term HMO tenancies (COHO integrations) and short-stay check-outs/allowances (Smoobu & ChargeAutomation integrations).
- **Maintenance & Contractor On-Charges:** Match contractor invoices against maintenance approvals and calculate changeover cleaning allowances automatically before on-charging.

## 3. Data Ingestion & Reconciliation Architecture
- **Xero as Financial Ledger:** Xero owns bank feeds, ledgers, and official bill payment statuses.
- **Replit DB / PostgreSQL:** Operates as the operational source of truth for properties, room mapping, exception queues, and generated client management reports.
- **Zero-API Email Ingestion:** Process unformatted supplier/utility e-receipts (Amazon, Argos, British Gas, Octopus) via n8n IMAP listeners + LLM parsing nodes directly into structured JSON.

## 4. Tech Stack Standards (Replit)
- **Database:** PostgreSQL via `@replit/database` or standard Node.js `pg`/Drizzle ORM.
- **API & Workflows:** Expose clean Webhook endpoints for n8n execution triggers and WhatsApp purchase bot responses.
- **Security:** Standardize environment variables (`process.env`) for Xero, WhatsApp, and n8n credentials. Enforce strict audit logging for supplier bank details and payment batch previews.