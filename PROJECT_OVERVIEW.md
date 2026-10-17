# Event Management Platform: Technical Architecture & Implementation Plan

Architecture specification · Reusable client template · Astro SSR + TypeScript + PostgreSQL

## 1. Architectural decision

Build a modular monolith: one Astro application containing the public website, organizer dashboard, ticketing engine, payment integration, check-in system and admin functionality.

Each client receives an independently deployed clone with its own database, domain, branding and payment-provider credentials. A single master repository remains the source of truth for shared features.

This is the best starting point for a reusable product maintained by one developer. Microservices, a centralized multi-tenant SaaS and independently maintained client-specific codebases would add complexity without providing immediate value.

Client-facing Astro SSR application

Public event pages · Registration · Checkout · Attendee tickets

Server-side application layer

Authentication · Permissions · Business rules · Validation · API endpoints

PostgreSQL

Events, inventory, orders, tickets, payments, refunds and audit records

Better Auth

Sessions, membership, authentication and role-based access

Payment provider

Checkout, payment verification and refunds

Background worker

Ticket emails, expired reservations and payment reconciliation

Webhook requests from the payment provider enter through a dedicated server endpoint; they do not depend on a customer returning to the website.

### Recommended stack

| Layer              | Technology                                                                            | Responsibility                                        |
| ------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Web framework      | Astro SSR, TypeScript                                                                 | Public pages, dashboard and server endpoints          |
| Server runtime     | Node.js with Astro's Node adapter                                                     | Runtime rendering and request handling                |
| UI                 | Tailwind CSS, Astro components                                                        | Styling and responsive layouts                        |
| Interactive UI     | Small TypeScript components                                                           | Ticket selection, dashboard controls and QR scanning  |
| Authentication     | Better Auth                                                                           | Login, sessions, account management                   |
| Authorization      | Better Auth Organization plugin + custom permissions                                  | Organizer and event-staff roles                       |
| Database           | PostgreSQL                                                                            | All persistent business records                       |
| ORM and migrations | Drizzle ORM + Drizzle Kit                                                             | Type-safe SQL queries and versioned schema migrations |
| Validation         | Zod                                                                                   | Request, form and configuration validation            |
| Payments           | Provider adapter; Razorpay as the initial candidate for an India-focused installation | Paid tickets, payment status and refunds              |
| Email              | Transactional email provider                                                          | Confirmations, tickets, reminders and refunds         |
| QR tickets         | QR-code generation library + browser camera                                           | Ticket generation and event admission                 |
| Testing            | Vitest + Playwright                                                                   | Unit, integration, browser and end-to-end tests       |
| Deployment         | Docker + VPS + Caddy or Nginx                                                         | Runtime, HTTPS and reproducible installations         |

Astro supports on-demand rendering through deployment adapters and server endpoints, making it suitable for pages and APIs that depend on live database state. Better Auth documents both its Astro integration and its organization-level membership and permission capabilities. Drizzle provides a typed schema and migration workflow for PostgreSQL.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://docs.astro.build\&sz=32)

Docs

+4



One important deployment choice: configure Astro for server output rather than a purely static build. Registration availability, account permissions, ticket status and payment webhooks must be handled dynamically.

## 2. System boundaries and application modules

The codebase should be organized by business capability, not simply split into frontend and backend folders.

Events module

Event creation, publishing, categories, venues, online access, sessions, scheduling and cancellation.

Registration and inventory module

Ticket types, capacity, reservations, attendee details, registration limits and waitlists in a later phase.

Commerce module

Orders, payment attempts, receipt records, cancellation policies, refunds and reconciliation.

Ticket and check-in module

QR credentials, scanner authorization, admission validation and duplicate-scan detection.

Organization and access module

Organization profile, users, memberships, staff roles, settings and audit history.

Each module owns its business rules and exposes services to the rest of the application. For example, a page should call `createOrder()` rather than directly modifying ticket inventory and payment rows itself.

This structure keeps the platform reusable while avoiding unnecessary service-to-service infrastructure.

## 3. Database schema

Use PostgreSQL as the source of truth for every event, registration, order, ticket and financial operation. Keep the identity schema generated by Better Auth separate from the business schema.

### Core entity relationships

\#chatgpt-mermaid-\_r_r9\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(237, 237, 237);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_r9\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_r9\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_r9\_ .error-icon{fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_r9\_ .error-text{fill:rgb(237, 237, 237);stroke:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_r9\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_r9\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_r9\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_r9\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_r9\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_r9\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_r9\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_r9\_ .marker.cross{stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_r9\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_r9\_ p{margin:0;}#chatgpt-mermaid-\_r_r9\_ .entityBox{fill:rgb(36, 22, 63);stroke:rgb(120, 73, 209);}#chatgpt-mermaid-\_r_r9\_ .relationshipLabelBox{fill:rgb(48, 48, 48);opacity:0.7;background-color:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_r9\_ .relationshipLabelBox rect{opacity:0.5;}#chatgpt-mermaid-\_r_r9\_ .labelBkg{background-color:rgba(48, 48, 48, 0.5);}#chatgpt-mermaid-\_r_r9\_ .edgeLabel{background-color:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_r9\_ .edgeLabel .label rect{fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_r9\_ .edgeLabel .label text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_r9\_ .edgeLabel .label{fill:rgb(120, 73, 209);font-size:14px;}#chatgpt-mermaid-\_r_r9\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_r9\_ .edge-pattern-dashed{stroke-dasharray:8,8;}#chatgpt-mermaid-\_r_r9\_ .node rect,#chatgpt-mermaid-\_r_r9\_ .node circle,#chatgpt-mermaid-\_r_r9\_ .node ellipse,#chatgpt-mermaid-\_r_r9\_ .node polygon{fill:rgb(36, 22, 63);stroke:rgb(120, 73, 209);stroke-width:1px;}#chatgpt-mermaid-\_r_r9\_ .relationshipLine{stroke:rgb(175, 175, 175);stroke-width:1px;fill:none;}#chatgpt-mermaid-\_r_r9\_ .marker{fill:none!important;stroke:rgb(175, 175, 175)!important;stroke-width:1;}#chatgpt-mermaid-\_r_r9\_ [data-look=neo].labelBkg{background-color:rgba(48, 48, 48, 0.5);}#chatgpt-mermaid-\_r_r9\_ .node .neo-node{stroke:rgb(120, 73, 209);}#chatgpt-mermaid-\_r_r9\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_r9\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_r9\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_r9\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_r9\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_r9\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_r9\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_r9\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_r9\_ [data-look="neo"].node .neo-line path{stroke:rgb(120, 73, 209);filter:none;}#chatgpt-mermaid-\_r_r9\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_r9\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_r9\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_r9\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_r9\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_r9\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_r9\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_r9\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}ORGANIZATIONEVENTEVENT_SESSIONTICKET_TYPEORDERORDER_ITEMATTENDEETICKETPAYMENTREFUNDCHECK_IN_ATTEMPTUSERMEMBERownscontainsoffersreceivescontainsselectedidentifiesreceivesattemptshasrecordsscanscontainsjoins

### A. Authentication and organization tables

Let Better Auth generate and manage its required user, session, account, verification and organization-membership tables. Use its supported Drizzle integration instead of manually duplicating its authentication schema.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://better-auth.com\&sz=32)

Better Auth

+1



| Table          | Purpose                                                             |
| -------------- | ------------------------------------------------------------------- |
| `user`         | User accounts and identity fields                                   |
| `session`      | Authenticated sessions and expiry                                   |
| `account`      | Login-provider accounts and credentials managed by the auth library |
| `verification` | Verification tokens and related workflows                           |
| `organization` | The client's organization profile                                   |
| `member`       | Organization membership and role                                    |
| `invitation`   | Staff invitation workflow                                           |

Provision one organization during client installation. Prevent arbitrary creation of additional organizations unless the deployment explicitly requires it.

Add an application-owned `organization_settings` table for branding, contact information, currency defaults, timezone and feature configuration. Do not use authentication metadata as a substitute for the actual business settings.

### B. Business tables

| Table               | Essential fields and constraints                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events`            | `id`, `organization_id`, `slug`, `title`, `description`, `format`, `visibility`, `status`, `starts_at`, `ends_at`, `timezone`, registration opening and closing timestamps |
| `event_sessions`    | `id`, `event_id`, `title`, `starts_at`, `ends_at`, optional speaker and room information                                                                                   |
| `event_locations`   | `event_id`, venue name, street address, city, region, postal code and optional coordinates                                                                                 |
| `event_access`      | `event_id`, online platform and private joining instructions; accessible only to authorized attendees and staff                                                            |
| `ticket_types`      | `event_id`, name, description, `price_minor`, currency, total inventory, reserved and sold counters, sale dates, per-order limits                                          |
| `orders`            | `id`, `event_id`, buyer details, optional `user_id`, order status, subtotal, tax, discounts, fees, total, currency, expiry and idempotency key                             |
| `order_items`       | `order_id`, `ticket_type_id`, quantity, ticket-name snapshot, unit-price snapshot, discounts and tax snapshots                                                             |
| `attendees`         | `order_item_id`, attendee name, email, optional phone and registration answers                                                                                             |
| `tickets`           | `event_id`, `attendee_id`, `order_item_id`, unique public reference, hashed QR token, ticket status and issue timestamp                                                    |
| `payments`          | `order_id`, provider, provider order ID, provider payment ID, amount, currency, status, capture timestamp and idempotency information                                      |
| `refunds`           | `payment_id`, amount, provider refund ID, reason, requested by, status and timestamps                                                                                      |
| `refund_items`      | `refund_id`, ticket ID or order-item ID, when refunds must be tied to specific tickets                                                                                     |
| `webhook_events`    | Provider event ID, event type, signature-verification result, processing status, receive time, processing time and error metadata                                          |
| `check_in_attempts` | `ticket_id`, `event_id`, scanner user, scan time, outcome and device/session reference                                                                                     |
| `audit_logs`        | Actor, action, affected resource, timestamp and minimal supporting metadata                                                                                                |
| `email_outbox`      | Recipient, notification type, payload, retry count, delivery status and timestamps                                                                                         |

`user_id` for the buyer and attendee account should be nullable if you support guest checkout. Guests must still be able to receive tickets through a secure confirmation flow.

### C. Critical data-model rules

Money and pricing

- Store monetary amounts as integers in the currency's smallest supported unit rather than floating-point values.
- Store the currency code with each order, payment and refund.
- Snapshot ticket names, prices, taxes and fees when an order is created. Editing a ticket's price must not change an existing order.
- Calculate payment amounts on the server from the database. Never trust prices or totals submitted by the browser.

For a price displayed as ₹499.00, the stored INR amount is `49900`. Be explicit about currency precision if you later support currencies with nonstandard minor units.

Inventory

Each ticket type maintains:

\\[ \text{available}=\text{total}-\text{sold}-\text{reserved} \\]

Reserve inventory transactionally when checkout starts, with a short expiry for abandoned checkouts. Lock the relevant ticket-inventory rows while making the reservation and enforce the capacity invariant in the database transaction.

A background worker expires abandoned orders and releases their reservations. If payment succeeds after a reservation has expired, reconcile the payment instead of blindly issuing an additional ticket.

Tickets

Issue one ticket record per attendee admission, even when one order contains five tickets. This makes ticket-specific check-in, cancellation and refunds possible.

Payments and refunds

An order is not a payment, and a payment is not a refund. Keep them as separate records so failed attempts, retries and partial refunds remain auditable.

Recommended status fields:

| Entity  | Suggested lifecycle                                                             |
| ------- | ------------------------------------------------------------------------------- |
| Event   | `draft`, `published`, `cancelled`, `completed`                                  |
| Order   | `pending_payment`, `confirmed`, `expired`, `cancelled`                          |
| Payment | `created`, `authorized`, `captured`, `failed`, `partially_refunded`, `refunded` |
| Refund  | `requested`, `pending`, `succeeded`, `failed`                                   |
| Ticket  | `issued`, `void`                                                                |

Treat check-in as its own recorded operation rather than making it just another ticket status. The ticket may remain valid while having an accepted check-in record.

### D. Important database constraints and indexes

Implement these when the corresponding tables are created:

- Unique event slug per organization, payment-provider order IDs and refund-provider IDs.
- Unique webhook event ID per provider to prevent duplicate processing.
- Unique ticket public reference and QR-token hash.
- Foreign keys connecting every payment, ticket, refund and order to its parent records.
- Indexes on event status/start time, ticket type by event, order by event/status/date, payments by order, and tickets by event.
- A database-enforced mechanism for allowing at most one accepted check-in per ticket.

Drizzle's TypeScript schema and committed migration files should define these constraints. Apply schema changes through reviewed migrations rather than modifying production tables manually.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://orm.drizzle.team\&sz=32)

Schema

+1



## 4. Payment, ticketing and refund workflows

Payment processing is the most sensitive part of this product. Implement it as a discrete business workflow with explicit state transitions, rather than a single checkout callback.

### Payment lifecycle

\#chatgpt-mermaid-\_r_s2\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(237, 237, 237);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_s2\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_s2\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_s2\_ .error-icon{fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_s2\_ .error-text{fill:rgb(237, 237, 237);stroke:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_s2\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_s2\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_s2\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_s2\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_s2\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_s2\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_s2\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_s2\_ .marker.cross{stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_s2\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_s2\_ p{margin:0;}#chatgpt-mermaid-\_r_s2\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_s2\_ .cluster-label text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_s2\_ .cluster-label span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_s2\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_s2\_ .label text,#chatgpt-mermaid-\_r_s2\_ span{fill:rgb(237, 237, 237);color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_s2\_ .node rect,#chatgpt-mermaid-\_r_s2\_ .node circle,#chatgpt-mermaid-\_r_s2\_ .node ellipse,#chatgpt-mermaid-\_r_s2\_ .node polygon,#chatgpt-mermaid-\_r_s2\_ .node path{fill:rgb(36, 22, 63);stroke:rgb(120, 73, 209);stroke-width:1px;}#chatgpt-mermaid-\_r_s2\_ .rough-node .label text,#chatgpt-mermaid-\_r_s2\_ .node .label text,#chatgpt-mermaid-\_r_s2\_ .image-shape .label,#chatgpt-mermaid-\_r_s2\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_s2\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_s2\_ .rough-node .label,#chatgpt-mermaid-\_r_s2\_ .node .label,#chatgpt-mermaid-\_r_s2\_ .image-shape .label,#chatgpt-mermaid-\_r_s2\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_s2\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_s2\_ .root .anchor path{fill:rgb(175, 175, 175)!important;stroke-width:0;stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_s2\_ .arrowheadPath{fill:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_s2\_ .edgePath .path{stroke:rgb(175, 175, 175);stroke-width:1px;}#chatgpt-mermaid-\_r_s2\_ .flowchart-link{stroke:rgb(175, 175, 175);fill:none;}#chatgpt-mermaid-\_r_s2\_ .edgeLabel{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_s2\_ .edgeLabel p{background-color:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_s2\_ .edgeLabel rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_s2\_ .labelBkg{background-color:rgba(0, 0, 0, 0.5);}#chatgpt-mermaid-\_r_s2\_ .cluster rect{fill:rgb(48, 48, 48);stroke:rgba(255, 255, 255, 0.15);stroke-width:1px;}#chatgpt-mermaid-\_r_s2\_ .cluster text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_s2\_ .cluster span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_s2\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgb(48, 48, 48);border:1px solid rgba(255, 255, 255, 0.15);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_s2\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_s2\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_s2\_ .icon-shape,#chatgpt-mermaid-\_r_s2\_ .image-shape{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_s2\_ .icon-shape p,#chatgpt-mermaid-\_r_s2\_ .image-shape p{background-color:rgb(0, 0, 0);padding:2px;}#chatgpt-mermaid-\_r_s2\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_s2\_ .image-shape .label rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_s2\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_s2\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_s2\_ .node .neo-node{stroke:rgb(120, 73, 209);}#chatgpt-mermaid-\_r_s2\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_s2\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_s2\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_s2\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_s2\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_s2\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_s2\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_s2\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_s2\_ [data-look="neo"].node .neo-line path{stroke:rgb(120, 73, 209);filter:none;}#chatgpt-mermaid-\_r_s2\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_s2\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_s2\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_s2\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_s2\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_s2\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_s2\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_s2\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(206, 176, 251);}#chatgpt-mermaid-\_r_s2\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(206, 176, 251);}#chatgpt-mermaid-\_r_s2\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_s2\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_s2\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(23, 12, 38);stroke:rgb(65, 47, 92);stroke-width:1px;}#chatgpt-mermaid-\_r_s2\_ .node rect,#chatgpt-mermaid-\_r_s2\_ .node circle,#chatgpt-mermaid-\_r_s2\_ .node ellipse,#chatgpt-mermaid-\_r_s2\_ .node polygon,#chatgpt-mermaid-\_r_s2\_ .node path{fill:rgb(44, 24, 74);stroke:rgba(255, 255, 255, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_s2\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_s2\_ .node.mermaid-decision .label-container{fill:rgb(23, 12, 38);stroke:rgb(65, 47, 92);stroke-dasharray:2px,2px;}#chatgpt-mermaid-\_r_s2\_ .edgePaths .flowchart-link{stroke:rgb(175, 175, 175);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_s2\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_s2\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}Select ticket and quantityServer validates ticket, priceand capacityReserve inventory and createorderCreate payment-providerorderHosted checkoutCustomer submits paymentProvider sends webhookVerify raw payload signatureDeduplicate and processeventPayment captured andamount matches?Confirm order and convertreservationIssue tickets exactly onceQueue confirmation andticket emailRecord failure or flag forreconciliationYesNo

### Required implementation rules

1\. Create orders server-side. When a customer chooses tickets, the server reads the current ticket prices and validates availability. It creates the internal order and inventory reservation before calling the provider's order API.

2\. Use hosted checkout. The browser receives only the checkout details it needs. The provider processes payment information; the application does not store card numbers or security codes.

3\. Do not trust the browser's success message. A successful client-side callback may trigger a status refresh, but it must not directly mark an order as paid or issue tickets.

4\. Verify payment and webhooks. Validate the provider's payment verification requirements and webhook signature on the server. For Razorpay, webhook signature verification uses the raw request body, and duplicate event IDs must be handled idempotently. Events can arrive out of order, so payment state transitions must account for that.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://razorpay.com\&sz=32)

Razorpay

+1



5\. Issue tickets atomically. Confirm payment, convert the reservation into sold inventory, and create tickets inside a transaction or another carefully designed idempotent workflow. Queue emails only after a successful commit.

6\. Reconcile exceptional cases. Handle provider timeouts, abandoned checkout, failed attempts, duplicate webhooks, delayed payment success and payment amounts that do not match the internal order. Use a reconciliation task to inspect unresolved payments.

### Refund workflow

A refund request should be handled as follows:

1. An authorized organizer or finance user requests a full or partial refund.
2. The server verifies that the payment was captured, the refund is permitted under the configured policy, and sufficient refundable balance remains.
3. The refund amount is reserved against concurrent refund requests by locking or otherwise serializing updates to the payment record.
4. The server submits the refund request to the provider and records the provider refund reference.
5. The refund remains pending until its state is confirmed. Provider responses and webhooks update the final status idempotently.
6. Tickets covered by a confirmed cancellation/refund are voided according to the refund policy. An already checked-in ticket must not silently become an ordinary unused ticket.

For the initial release, support full-order and ticket-specific refunds, with an optional partial amount where the policy permits it. Keep the refund policy configurable per event. Display a pending refund distinctly from a successful refund.

### Payment provider abstraction

Do not embed Razorpay-specific logic throughout the events and orders modules. Define a small provider interface, such as:

```
interface PaymentProvider {
  createOrder(input: CreatePaymentOrderInput): Promise<ProviderOrder>;
  verifyPayment(input: VerifyPaymentInput): Promise<VerifiedPayment>;
  verifyWebhook(
    rawBody: Uint8Array,
    signature: string
  ): Promise<VerifiedWebhook>;
  refund(input: CreateRefundInput): Promise<ProviderRefund>;
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
  getRefund(providerRefundId: string): Promise<ProviderRefund>;
}
```

This is an architectural contract; the actual types and method signatures should reflect the selected provider's SDK.

For an India-focused first deployment, Razorpay is a reasonable starting candidate. Build and test one complete integration first. Keep the provider selection configurable so a later client can use another supported gateway without rewriting the order model.

Each client should connect their own approved merchant account. Their payment credentials, live/test mode, refund responsibilities and settlement records must remain separate from yours. Razorpay's documented flow uses a server-created order and distinguishes the browser checkout from server-side webhook confirmation.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://razorpay.com\&sz=32)

Razorpay

+1



## 5. QR ticket issuance and check-in

QR admission needs its own security model. A QR code must not be equivalent to a publicly accessible ticket URL containing an incremental database ID.

### Ticket issuance

Generate a cryptographically random, high-entropy token for each ticket. Encode the token or a signed opaque equivalent in the QR code, and store a hash of the token server-side. Do not encode the attendee's email, phone number, payment details or other personal data.

The ticket page can show the attendee's name, event information, admission category and current ticket status after appropriate authorization.

### Scanner workflow

\#chatgpt-mermaid-\_r_t2\_{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;fill:rgb(237, 237, 237);}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#chatgpt-mermaid-\_r_t2\_ .edge-animation-slow{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 50s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_t2\_ .edge-animation-fast{stroke-dasharray:9,5!important;stroke-dashoffset:900;animation:dash 20s linear infinite;stroke-linecap:round;}#chatgpt-mermaid-\_r_t2\_ .error-icon{fill:rgb(48, 48, 48);}#chatgpt-mermaid-\_r_t2\_ .error-text{fill:rgb(237, 237, 237);stroke:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_t2\_ .edge-thickness-normal{stroke-width:1px;}#chatgpt-mermaid-\_r_t2\_ .edge-thickness-thick{stroke-width:3.5px;}#chatgpt-mermaid-\_r_t2\_ .edge-pattern-solid{stroke-dasharray:0;}#chatgpt-mermaid-\_r_t2\_ .edge-thickness-invisible{stroke-width:0;fill:none;}#chatgpt-mermaid-\_r_t2\_ .edge-pattern-dashed{stroke-dasharray:3;}#chatgpt-mermaid-\_r_t2\_ .edge-pattern-dotted{stroke-dasharray:2;}#chatgpt-mermaid-\_r_t2\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_t2\_ .marker.cross{stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_t2\_ svg{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:16px;}#chatgpt-mermaid-\_r_t2\_ p{margin:0;}#chatgpt-mermaid-\_r_t2\_ .label{font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_t2\_ .cluster-label text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_t2\_ .cluster-label span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_t2\_ .cluster-label span p{background-color:transparent;}#chatgpt-mermaid-\_r_t2\_ .label text,#chatgpt-mermaid-\_r_t2\_ span{fill:rgb(237, 237, 237);color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_t2\_ .node rect,#chatgpt-mermaid-\_r_t2\_ .node circle,#chatgpt-mermaid-\_r_t2\_ .node ellipse,#chatgpt-mermaid-\_r_t2\_ .node polygon,#chatgpt-mermaid-\_r_t2\_ .node path{fill:rgb(36, 22, 63);stroke:rgb(120, 73, 209);stroke-width:1px;}#chatgpt-mermaid-\_r_t2\_ .rough-node .label text,#chatgpt-mermaid-\_r_t2\_ .node .label text,#chatgpt-mermaid-\_r_t2\_ .image-shape .label,#chatgpt-mermaid-\_r_t2\_ .icon-shape .label{text-anchor:middle;}#chatgpt-mermaid-\_r_t2\_ .node .katex path{fill:#000;stroke:#000;stroke-width:1px;}#chatgpt-mermaid-\_r_t2\_ .rough-node .label,#chatgpt-mermaid-\_r_t2\_ .node .label,#chatgpt-mermaid-\_r_t2\_ .image-shape .label,#chatgpt-mermaid-\_r_t2\_ .icon-shape .label{text-align:center;}#chatgpt-mermaid-\_r_t2\_ .node.clickable{cursor:pointer;}#chatgpt-mermaid-\_r_t2\_ .root .anchor path{fill:rgb(175, 175, 175)!important;stroke-width:0;stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_t2\_ .arrowheadPath{fill:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_t2\_ .edgePath .path{stroke:rgb(175, 175, 175);stroke-width:1px;}#chatgpt-mermaid-\_r_t2\_ .flowchart-link{stroke:rgb(175, 175, 175);fill:none;}#chatgpt-mermaid-\_r_t2\_ .edgeLabel{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_t2\_ .edgeLabel p{background-color:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_t2\_ .edgeLabel rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_t2\_ .labelBkg{background-color:rgba(0, 0, 0, 0.5);}#chatgpt-mermaid-\_r_t2\_ .cluster rect{fill:rgb(48, 48, 48);stroke:rgba(255, 255, 255, 0.15);stroke-width:1px;}#chatgpt-mermaid-\_r_t2\_ .cluster text{fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_t2\_ .cluster span{color:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_t2\_ div.mermaidTooltip{position:absolute;text-align:center;max-width:200px;padding:2px;font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";font-size:12px;background:rgb(48, 48, 48);border:1px solid rgba(255, 255, 255, 0.15);border-radius:2px;pointer-events:none;z-index:100;}#chatgpt-mermaid-\_r_t2\_ .flowchartTitleText{text-anchor:middle;font-size:18px;fill:rgb(237, 237, 237);}#chatgpt-mermaid-\_r_t2\_ rect.text{fill:none;stroke-width:0;}#chatgpt-mermaid-\_r_t2\_ .icon-shape,#chatgpt-mermaid-\_r_t2\_ .image-shape{background-color:rgb(0, 0, 0);text-align:center;}#chatgpt-mermaid-\_r_t2\_ .icon-shape p,#chatgpt-mermaid-\_r_t2\_ .image-shape p{background-color:rgb(0, 0, 0);padding:2px;}#chatgpt-mermaid-\_r_t2\_ .icon-shape .label rect,#chatgpt-mermaid-\_r_t2\_ .image-shape .label rect{opacity:0.5;background-color:rgb(0, 0, 0);fill:rgb(0, 0, 0);}#chatgpt-mermaid-\_r_t2\_ .label-icon{display:inline-block;height:1em;overflow:visible;vertical-align:-0.125em;}#chatgpt-mermaid-\_r_t2\_ .node .label-icon path{fill:currentColor;stroke:revert;stroke-width:revert;}#chatgpt-mermaid-\_r_t2\_ .node .neo-node{stroke:rgb(120, 73, 209);}#chatgpt-mermaid-\_r_t2\_ [data-look="neo"].node rect,#chatgpt-mermaid-\_r_t2\_ [data-look="neo"].cluster rect,#chatgpt-mermaid-\_r_t2\_ [data-look="neo"].node polygon{stroke:url(#chatgpt-mermaid-\_r_t2\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_t2\_ [data-look="neo"].swimlane.cluster rect{filter:none;}#chatgpt-mermaid-\_r_t2\_ [data-look="neo"].node path{stroke:url(#chatgpt-mermaid-\_r_t2\_-gradient);stroke-width:1px;}#chatgpt-mermaid-\_r_t2\_ [data-look="neo"].node .outer-path{filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_t2\_ [data-look="neo"].node .neo-line path{stroke:rgb(120, 73, 209);filter:none;}#chatgpt-mermaid-\_r_t2\_ [data-look="neo"].node circle{stroke:url(#chatgpt-mermaid-\_r_t2\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_t2\_ [data-look="neo"].node circle .state-start{fill:#000000;}#chatgpt-mermaid-\_r_t2\_ [data-look="neo"].icon-shape .icon{fill:url(#chatgpt-mermaid-\_r_t2\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_t2\_ [data-look="neo"].icon-shape .icon-neo path{stroke:url(#chatgpt-mermaid-\_r_t2\_-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}#chatgpt-mermaid-\_r_t2\_ .node text{font-size:14px;font-weight:600;letter-spacing:normal;fill:rgb(206, 176, 251);}#chatgpt-mermaid-\_r_t2\_ .edgeLabels text{font-size:13px;font-weight:600;letter-spacing:-0.08px;fill:rgb(206, 176, 251);}#chatgpt-mermaid-\_r_t2\_ .node tspan[font-weight="normal"],#chatgpt-mermaid-\_r_t2\_ .edgeLabels tspan[font-weight="normal"]{font-weight:600;}#chatgpt-mermaid-\_r_t2\_ .edgeLabel .label rect{opacity:1;rx:13px;ry:13px;fill:rgb(23, 12, 38);stroke:rgb(65, 47, 92);stroke-width:1px;}#chatgpt-mermaid-\_r_t2\_ .node rect,#chatgpt-mermaid-\_r_t2\_ .node circle,#chatgpt-mermaid-\_r_t2\_ .node ellipse,#chatgpt-mermaid-\_r_t2\_ .node polygon,#chatgpt-mermaid-\_r_t2\_ .node path{fill:rgb(44, 24, 74);stroke:rgba(255, 255, 255, 0.1);stroke-width:1px;}#chatgpt-mermaid-\_r_t2\_ .node rect{rx:16px;ry:16px;}#chatgpt-mermaid-\_r_t2\_ .node.mermaid-decision .label-container{fill:rgb(23, 12, 38);stroke:rgb(65, 47, 92);stroke-dasharray:2px,2px;}#chatgpt-mermaid-\_r_t2\_ .edgePaths .flowchart-link{stroke:rgb(175, 175, 175);stroke-width:1px;stroke-linecap:round;stroke-linejoin:round;}#chatgpt-mermaid-\_r_t2\_ .marker{fill:rgb(175, 175, 175);stroke:rgb(175, 175, 175);}#chatgpt-mermaid-\_r_t2\_ :root{--mermaid-font-family:-apple-system-body,ui-sans-serif,-apple-system,system-ui,"Segoe UI","Helvetica","Apple Color Emoji","Arial",sans-serif,"Segoe UI Emoji","Segoe UI Symbol";}Staff signs inOpen assigned eventscannerScan QR codeServer validates tokenTicket valid for this event?Reject: invalid ticketTicket issued and notrefunded?Reject: void or invalid statusAtomic check-in operationPreviously checked in?Record successful admissionReject duplicate scanNoYesNoYesNoYes

The scanner should report a clear result: accepted, already checked in, wrong event, invalid ticket or void ticket.

The database operation that accepts the first check-in must be atomic. If two scanners scan the same ticket simultaneously, only one operation should be accepted. Store attempted scans as well as successful check-ins for auditability.

For the first version, build a responsive scanner page that uses the device camera. You do not need a native mobile app.

## 6. Security boundaries and authorization

Authentication proves who the user is. Authorization determines what that user may do. The server must enforce both on every protected operation, including API requests made directly without the UI. OWASP specifically recommends deny-by-default authorization and checks against the particular resource being accessed.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://cheatsheetseries.owasp.org\&sz=32)

OWASP Cheat Sheet Series



### Role and permission model

Use organization membership plus custom permissions in Better Auth's Organization plugin. The following are application-level roles; the exact role definitions and permission mapping are yours to implement.

| Role            | Principal permissions                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ |
| `owner`         | Full organization control, staff management, events, finance and settings                  |
| `admin`         | Manage events, staff and registrations, subject to protected ownership and billing actions |
| `event_manager` | Create and manage assigned events, tickets, attendee lists and event reports               |
| `finance`       | View financial records, process permitted refunds and export financial reports             |
| `checkin_staff` | Scan tickets and view minimal admission information for assigned events                    |
| `attendee`      | View and manage their own registrations and tickets                                        |

A visitor can browse public events and begin eligible public registrations without receiving organizer permissions. Guest checkout can operate without a full attendee account.

Never let the browser define its own role, organization membership, order total or ownership of a resource.

### Security control matrix

Authentication and sessions

Use secure, HTTP-only session cookies with appropriate same-site and secure settings, session expiry and logout invalidation. Protect state-changing requests against CSRF where applicable, and rate-limit login and sensitive endpoints.

Resource-level access

Every organizer request verifies membership and permission for the specific event, order, ticket or refund. Event staff can be restricted to assigned events; attendees can access only their own records.

Payment secrets and data

Never expose provider secret keys in frontend bundles, HTML or API responses. Do not store payment-card data. Keep webhook secrets and payment credentials in server-side secret configuration.

Audit and operational records

Audit event publication and cancellation, role changes, refund requests, ticket voiding and check-in overrides. Keep logs access-controlled and avoid logging passwords, access tokens or full payment payloads unnecessarily.

Database and isolation

Use parameterized queries, foreign keys, transactions and least-privilege database credentials. Restrict the migration account separately from the application's runtime database account.

### Client separation

Although every client receives a separate deployment, retain `organization_id` on organization-owned records. It creates a consistent data ownership boundary and leaves a migration path to a centrally hosted version later.

For each client deployment:

- Use an independent PostgreSQL database and runtime secrets.
- Use distinct payment-provider credentials and webhook secrets.
- Set a separate domain, sender identity, backup policy and environment configuration.
- Disable demo fixtures and test credentials before going live.
- Apply organization ownership checks in application services even if the database currently contains only one organization.

Do not rely on hard-to-guess UUIDs as access control. Every record lookup must verify that the authenticated actor has permission to access that specific record.

Keep a private online joining link out of public event responses. Expose it only through an authorized server endpoint for confirmed or otherwise eligible registrations.

Use the deployment's secret-management facility to store credentials, and establish rotation and access-revocation procedures. Keep security-sensitive operations logged with enough information to investigate failures without retaining unnecessary sensitive data.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://cheatsheetseries.owasp.org\&sz=32)

OWASP Cheat Sheet Series

+2



## 7. Recommended repository structure

Keep the template in a single Git repository, with the default installation configuration and client-specific customization separated.

```
event-platform/
├── public/
│   ├── images/
│   └── icons/
├── src/
│   ├── components/
│   │   ├── events/
│   │   ├── tickets/
│   │   └── dashboard/
│   ├── layouts/
│   ├── pages/
│   │   ├── index.astro
│   │   ├── events/
│   │   │   ├── index.astro
│   │   │   └── [slug].astro
│   │   ├── register/
│   │   ├── checkout/
│   │   ├── tickets/
│   │   ├── dashboard/
│   │   ├── admin/
│   │   └── api/
│   │       ├── auth/[...all].ts
│   │       ├── checkout/
│   │       ├── payments/
│   │       │   └── webhook.ts
│   │       ├── refunds/
│   │       └── check-in/
│   ├── features/
│   │   ├── organizations/
│   │   ├── events/
│   │   ├── inventory/
│   │   ├── orders/
│   │   ├── payments/
│   │   │   └── providers/
│   │   ├── refunds/
│   │   ├── tickets/
│   │   ├── check-in/
│   │   └── notifications/
│   ├── lib/
│   │   ├── auth/
│   │   ├── db/
│   │   │   ├── schema/
│   │   │   └── client.ts
│   │   ├── permissions/
│   │   ├── validation/
│   │   └── security/
│   └── config/
│       ├── site.ts
│       └── features.ts
├── drizzle/
├── scripts/
│   ├── seed-demo.ts
│   └── provision-client.ts
├── workers/
│   ├── expire-orders.ts
│   ├── process-outbox.ts
│   └── reconcile-payments.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── security/
│   └── e2e/
├── deployment/
├── Dockerfile
├── docker-compose.yml
├── drizzle.config.ts
├── astro.config.mjs
├── .env.example
└── README.md
```

The listed files and directories define an intended organization, not a requirement to create every file before development begins.

### Configuration and cloning strategy

Separate the stable product code from the client's identity.

Customization configuration should contain the logo, site name, colors, contact information, default currency, timezone and enabled features. Client-specific event content should live in the database.

Deployment configuration should contain the database URL, authentication secret, allowed origin, payment keys, webhook secret and email-provider credentials. These values must not be committed to the template repository.

Use `provision-client.ts` or an equivalent deployment script to create the initial organization, apply migrations and seed only the appropriate starting configuration.

When the core template changes, merge those improvements into the client clones using version-controlled changes. Avoid manually patching production code or creating client-specific branches merely to change logos and text.

### Deployment baseline

Use Docker to package the Astro Node server. Run PostgreSQL as a separate service or use managed PostgreSQL, and provide a dedicated worker process for scheduled tasks.

At minimum, deployment must include HTTPS, environment validation, health checks, database migrations, backup and restore procedures, error reporting and log retention.

For the initial implementation, a single codebase and one database are sufficient. Do not introduce Redis, a message broker or a separate payment microservice unless measurable operational requirements justify them.

## 8. Implementation roadmap

Build in seven phases, with each phase leaving the project in a testable state. Payment processing, inventory management and authorization should be implemented before spending substantial time on visual polish.

## 0

Foundation and deployment setup

First milestone

Set up Astro SSR, TypeScript, Tailwind CSS, PostgreSQL, Drizzle migrations, Better Auth, environment validation and Docker.

Exit criterion: the application starts from a clean environment, connects to the database and supports authenticated sessions.

## 1

Public event experience

Build the homepage, event discovery, event detail pages, event categories, filters, venue information and online/hybrid event presentation. Seed realistic fictional events.

Exit criterion: all three event formats render correctly on mobile and desktop, with public/private data properly separated.

## 2

Authentication and organizer operations

Implement organization membership, role permissions, event CRUD, publishing, ticket-type configuration, capacity settings, event cancellation and the attendee-management dashboard.

Exit criterion: an authorized organizer can operate their events without editing application code, and unauthorized users cannot modify them.

## 3

Registration and inventory engine

Implement orders, ticket inventory, capacity locks, registration forms, free tickets, reservation expiry, attendee records, and registration confirmation emails.

Exit criterion: registrations enforce capacity correctly under concurrent requests and do not create duplicate tickets.

## 4

Paid ticket checkout

Implement the first payment-provider adapter, server-created checkout orders, payment verification, webhook verification, retries, idempotent ticket issuance and payment reconciliation.

Exit criterion: a test-mode payment completes end-to-end, and failed or duplicate payment events do not issue duplicate tickets.

## 5

Refunds and QR admission

Implement full and partial refunds, refund status tracking, ticket voiding, QR generation, a browser-based scanner, single-use admission and check-in reporting.

Exit criterion: refunds and ticket validity remain consistent, and the scanner rejects invalid, void and previously accepted tickets.

## 6

Demo readiness and clone automation

Complete responsive styling, realistic sample data, audit logs, automated tests, deployment documentation, backup/restore testing and the client provisioning script.

Exit criterion: a fresh client installation can be configured without code changes to shared business logic, and the end-to-end demo passes the acceptance checklist below.

## 9. Demo acceptance criteria

Treat the following as the release gate before presenting the product as a working event-management system.

## Release checklist

### 0/26

Public event experience

Homepage, event listing and event details work on mobile and desktop.

Physical, digital and hybrid events display the appropriate information.

Draft, private and cancelled events are not incorrectly exposed as available public events.

Registration dates, event timezone, capacity and current ticket availability are displayed correctly.

Organizer dashboard

An authorized organizer can create, edit, publish and cancel events.

Organizers can configure multiple ticket categories, prices, dates and capacity limits.

Attendees and orders can be searched, filtered and exported.

Unauthorized users cannot view or modify protected events, attendee records or financial information.

Registration and inventory

Free registration creates a valid order and issues the correct number of tickets.

Paid checkout calculates the amount from server-side ticket prices.

Concurrent attempts to purchase the final ticket cannot oversell inventory.

Failed, expired and abandoned checkout attempts follow the correct reservation-release rules.

Payments and refunds

A payment completes using the selected provider's test environment.

Webhook signatures are verified and duplicate events do not duplicate financial state changes or tickets.

Payment failures and delayed confirmations are reconciled correctly.

Authorized staff can request full or permitted partial refunds, with pending, success and failure statuses.

Refunds cannot exceed the remaining refundable amount, including under concurrent requests.

Tickets and admission

Each attendee receives the correct ticket and QR code.

A valid ticket can be checked in exactly once.

Duplicate scans, invalid tokens, wrong-event tickets and void tickets are rejected.

Only authorized event staff can scan tickets for their assigned events.

Deployment and security

The template starts from a clean installation using documented configuration.

Client branding, domain, database and payment credentials can be set independently.

No secrets or demo attendee records are accidentally included in a client deployment.

Database migrations, backups and restore procedures have been tested.

Automated tests cover critical business rules, payment idempotency and access control.

Copy checklistReset

A demo is not necessarily production-ready just because the happy path works. Payment verification, failed payments, duplicate webhooks, concurrent registrations and access control need explicit test coverage.

For payment testing, use the selected gateway's sandbox or test mode. If provider credentials are not available yet, use a clearly labelled simulated checkout to demonstrate the UI, but do not claim that it demonstrates a completed real payment integration.

## 10. Operational and legal readiness

Before the first live client deployment, define who operates the event and who owns the commercial relationship.

For the intended separate-deployment model, the event organizer should normally operate their own approved payment account. The organizer should configure their event's cancellation and refund rules, contact information, terms and privacy notices. You provide the technical platform and its agreed maintenance.

Include the following operational controls:

- Privacy, terms, refund and cancellation policy pages that can be customized for each client.
- Secure access to attendee exports and private online joining instructions.
- Retention and deletion procedures for attendee information.
- Transaction logs and refund audit trails.
- Automatic backups and a tested restoration procedure.
- A method for resolving orders with ambiguous or delayed payment outcomes.
- A clearly defined maintenance and incident-response responsibility.

Using a hosted payment checkout reduces direct exposure to sensitive card data, but it does not automatically establish PCI DSS compliance. Applicable requirements depend on the final integration and merchant arrangement.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://www.pcisecuritystandards.org\&sz=32)

PCI Security Standards Council

+1



## 11. Final implementation priorities

The most important decisions to make before writing the bulk of the code are:

1. Treat this as a product template, not a one-off website. Shared features belong in reusable modules; branding and content belong in configuration and the database.
2. Model commerce independently. Orders, payments, refunds and tickets must have separate records and state transitions.
3. Make inventory and ticket issuance transactional and idempotent. This protects against overselling and duplicate payment events.
4. Implement permissions before exposing the organizer dashboard. Every endpoint must independently enforce the appropriate access rules.
5. Integrate one payment provider fully before supporting more. Get checkout, verification, webhooks and refunds working in test mode first.
6. Build clone and deployment automation before your second or third client. Every new installation should become a repeatable configuration and deployment task rather than a fresh development project.

The first deliverable should be the database schema, repository foundation, Better Auth integration and event module, followed by the inventory and payment workflows. Once these are stable, build the polished public experience around actual functionality.

That order gives you a reusable technical foundation capable of supporting general event organizers, developer communities, college festivals, conferences and hybrid events without creating a separate system for each client.
