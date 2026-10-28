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

## 4. Short-Stay Integrations (Hinkley Homes Stays)
- **Smoobu is the source of truth** for serviced accommodation. PriceLabs sets prices and availability through it, and ChargeAutomation, RentalNinja and the OTAs connect to it.
- **Read-only towards Smoobu and ChargeAutomation.** The app never writes bookings, rates, availability or guest messages to Smoobu. It never charges, refunds, releases deposits or creates bookings in ChargeAutomation. Staff reply to guests and act on payments in those systems.
- **Credentials live in n8n.** The app reaches both through n8n gateway webhooks that allow only listed read paths. Smoobu calls are signed with its HMAC API key, since the old key stopped on 31 Oct 2026. The one exception is Smoobu availability and prices, which the app reads directly with the same signed key, read-only.
- **Webhooks are re-read, not trusted.** Events arrive through n8n. The app re-reads the booking from the source before changing anything.
- **Privacy.** Keep only guest names. No guest emails, phone numbers or message history are stored.

## 5. Tech Stack Standards (Replit)
- **Database:** PostgreSQL via `@replit/database` or standard Node.js `pg`/Drizzle ORM.
- **API & Workflows:** Expose clean Webhook endpoints for n8n execution triggers and WhatsApp purchase bot responses.
- **Security:** Standardize environment variables (`process.env`) for Xero, WhatsApp, and n8n credentials. Enforce strict audit logging for supplier bank details and payment batch previews.