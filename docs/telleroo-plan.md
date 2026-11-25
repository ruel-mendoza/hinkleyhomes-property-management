# Telleroo plan: supplier payments

**Status (18 Nov 2026):** bills from all the group's companies go through Telleroo, paid by Hinkley Homes Ltd. On hold until Telleroo sends the production credentials, which Andrew Cookson is sending to Ed. Sandbox works and Telleroo has confirmed it. Start at **Part 1** when the credentials arrive.

## What we're building

Pay the group's approved supplier bills from Xero through Telleroo, in batches. The bills can belong to any company, but the money always comes from the one Telleroo account in Hinkley Homes Ltd:

- **The app** plans which bills to pay and checks them.
- **n8n** talks to Telleroo, because the app server sleeps and n8n is always on.
- **A person approves the pay run in Telleroo.** That is the only step that moves money. The app and n8n can't release a payment.

### Confirmed facts

- The Telleroo account is a **bank account in Hinkley Homes Ltd's Xero**, called "Telleroo - HINKLEY HOMES LTD" (ends 7727). Hinkley Homes tops it up, and supplier payments go out from it, confirmed by Ed and Xero on 18 Nov. Top-ups are transfers into it. The Accounts page treats it as a bank account, not a payment platform like Stripe (`routes/money.ts`, 18 Nov).
- **Hinkley Homes Ltd pays bills for the other companies through Telleroo** (Ed, 18 Nov). So:
  - The Payments page and batches take approved bills from **all the group's Xero companies**, not only Hinkley Homes Ltd's.
  - One pay run can mix companies. Every payment still comes out of the one Telleroo account.
  - The balance warning compares the **whole run, across all companies**, with the one Telleroo balance.
  - **Each payment is recorded in two Xero companies:**
    - **The company that owns the bill:** the bill is marked paid as an amount owed to Hinkley Homes Ltd (intercompany), because that company's own bank never paid it.
    - **Hinkley Homes Ltd:** the payment leaves the Telleroo account as money owed back by that company.
    - For Hinkley Homes Ltd's own bills it's a normal payment from the Telleroo account.
    - **We need to know how this is recorded today before building step 4** (see the questions for Ed).
  - Each Telleroo payment's reference and the batch item record which company the bill belongs to, so it can be traced back.
- Telleroo **doesn't retry failed webhooks**, so the 30-minute pay-run check in n8n must stay as the safety net.
- The webhook token header is **`Authenticity-Token`**.
- The n8n OAuth callback is `https://oauth.n8n.cloud/oauth2/callback` (sandbox and production).
- Telleroo addresses:

  | | Sign-in (authorize) | Token | API |
  | --- | --- | --- | --- |
  | Production | `https://app.telleroo.com/oauth/authorize` (confirmed 25 Nov 2026) | `https://api.telleroo.com/oauth/token` | `https://api.telleroo.com` |
  | Sandbox | `https://sandbox.app.telleroo.com/oauth` | `https://sandbox.telleroo.com/oauth/token` | `https://sandbox.telleroo.com` |

  Scope `create`, client id and secret sent in the body, header `Accept: application/vnd.telleroo.v3`. If production sign-in says "page not found", ask Andrew which authorize host your app uses (the 11 Nov app details showed `app.telleroo.com`).

## Part 1: switch to production (when the credentials arrive)

1. **Get the credentials from Ed.** Keep them only in n8n. Don't put them in the app, `.env` or chat.
2. **In n8n, create two credentials:**
   - **"Telleroo (production)"**, an OAuth2 credential: the production URLs above, scope `create`, Authentication = Body. Connect it and sign in as Hinkley Homes.
   - **"Telleroo webhook token (production)"**, a Header Auth credential: name `Authenticity-Token`, value = the token Telleroo gives you.
3. **Deactivate the sandbox workflow** "Hinkley PMS – Telleroo events". Also check its "Get pay run" step: it uses a credential called "Hinkley Homes Stays Ltd", which looks wrong.
4. **Clear the sandbox rows.** Sandbox and production share the same tables. In the Supabase SQL editor run:
   `delete from telleroo_events; delete from telleroo_pay_runs;`
5. **Import** `n8n/Hinkley PMS – Telleroo events (production).json`, attach the two credentials and **activate** it. Its webhook address is `https://hinkleyhomes.app.n8n.cloud/webhook/telleroo`. Confirm Telleroo has that address for production.
6. **Test:** make a small pay run in Telleroo and **don't approve it**. Check that a row appears in `telleroo_events` and the pay run in `telleroo_pay_runs`.

## Part 2: build the payments feature (in this order)

1. **Payments page, read-only.** *Started 25 Nov 2026:* pay runs are on Supplier bills > Pay runs with an Overview strip (bills to pay were already on Supplier bills > To pay). Still to add: bank-detail status per bill and the Telleroo balance. It shows:
   - Approved Xero bills waiting to be paid, across all the companies, grouped by company.
   - Whether each supplier's bank details are verified (`supplier_bank_details`, last 4 digits only).
   - The status of each pay run.
   - The Telleroo balance against the total to pay, with a warning when a run would be bigger than the balance.
   - Add its strip to the Overview.
2. **Create batch:** `payment_batches` and `payment_batch_items` tables.
   - Re-check the amount owing in Xero before adding a bill.
   - Split by payee type.
   - One batch can hold bills from several companies. Each item keeps its company.
   - Each bill can only be paid once (key `hh-<entity>-<xeroBillId>`).
3. **n8n Telleroo gateway:** create the pay run (`POST /payruns`) and submit it for approval (`PATCH`). Start in test mode.
4. **Record the payment in Xero** when Telleroo reports it as sent. Run it in shadow mode first.
   - For Hinkley Homes Ltd's own bills: pay the bill from the Telleroo account.
   - For other companies' bills: the bill-owning company's Xero and Hinkley Homes Ltd's Xero, both recorded the way Ed confirms (see the questions).
   - A payment that fails after being sent goes on a list to reverse, in both companies.
5. **Overview:** the Payments strip shows the bills waiting and the next pay run.

## Questions still open

**Ed:**
- ~~Does Telleroo pay bills only for Hinkley Homes Ltd?~~ **Answered 18 Nov:** it pays bills for the other companies too.
- **When Telleroo pays another company's bill, how is it recorded in Xero today?** In the company that owns the bill: which account is the bill paid from (an intercompany account, such as "Hinkley Homes Ltd current account")? In Hinkley Homes Ltd: where does the money from Telleroo go? Is the intercompany balance settled later? This needs a screenshot of one real example, ideally checked by the accountant.
- Who tops up the Telleroo account, and how often?
- Who plans the batches, and who approves them in Telleroo?
- Record the payment in Xero when Telleroo says "sent", or when it appears on the bank feed?

**Telleroo (Andrew):**
- Are the `payment_sent` / `payment_failed` / `payment_cancelled` events turned on, as well as the three pay-run events?
- Can the payee type (private or business) be set per payment?
- Are spaces allowed in the 18-character payment reference?
- Does Telleroo's own Xero link post anything for pay runs made through the API? If it does, the app must not record the payments twice.

## Files

- `n8n/Hinkley PMS – Telleroo events.json`: sandbox, path `telleroo-sandbox`.
- `n8n/Hinkley PMS – Telleroo events (production).json`: production, path `telleroo`, inactive until Part 1.
- `lib/db/src/schema/telleroo.ts`: `telleroo_events`, `telleroo_pay_runs`.
- `lib/db/sql/n8n-telleroo-writer.sql`: the database login n8n uses (credential "Postgres (Telleroo)").
