<!-- Written by: implementation-planning stage (module list) and appended to by spec-implementer (progress log). Read by: system-design, low-level-design, spec-implementer. -->

# Implementation Plan: Module Breakdown and Build Order

> **Scope:** the list of modules to build, in the order to build them, with a short description, the modules each depends on, and the `REQ-` IDs from `docs/design.md` each one satisfies. It does not cover high-level design (see `docs/architecture.md`) or low-level specs such as schemas, APIs and algorithms (that is low-level-design's job).
>
> **Inputs:** `docs/design.md` (REQ-001…REQ-066) and `docs/architecture.md`.
>
> **Conventions**
> - Module IDs (`M01`…) are for this plan only. Build them in number order unless a dependency note says otherwise.
> - "Deps" lists only direct dependencies on other modules.
> - "Enabling" means the module is infrastructure. It serves the listed REQs indirectly, and the REQ is finished by a later module.
> - Each phase ends in a state that can be verified and committed, following the author's preference for phased builds.
> - **Serving plane** = TypeScript web app + API (modular monolith). **Knowledge plane** = Python workers. Both use one Postgres cluster (architecture §2, §5).

---

## Phase overview

| Phase | Goal | Modules | Verifiable end state |
|---|---|---|---|
| 0 | Foundations | M01–M04 | Empty app deploys to the India region; jobs run; LLM adapter works; mobile shell renders |
| 1 | Accounts and workspaces | M05–M07 | A user can sign up with OTP, give consent, onboard and create product workspaces |
| 2 | Knowledge core and governance | M08–M11 | Assertions can be stored with provenance and licence flags; the policy layer filters reads; the review queue exists |
| 3 | Product and markets slice | M12–M16 | An anonymous visitor goes from "handmade cotton bedsheets" to HS code to ranked countries with coverage labels (Flow 1, steps 1–3) |
| 4 | Buyer knowledge acquisition | M17–M25 | Launch countries are pre-warmed with buyers that have evidence, contact types, trust checks and sanctions screening |
| 5 | Buyer serving, credits and trust | M26–M32 | Search → profile → paid reveal → report/refund works; public removal and Check a buyer work |
| 6 | Outreach and pipeline | M33–M35 | Shortlist, status, draft and export work (Flows 1, 2 and 4 end to end) |
| 7 | Commerce, content, compliance and launch | M36–M39 | **MVP launch: every Must requirement is met** |
| 8 | Should follow-ups | M40–M43 | Reminders, dashboard, follow-ups, HS re-confirmation, money-back |
| 9 | Could / later extensions | M44–M53 | Post-launch roadmap |

---

## Phase 0: Foundations

### M01: Platform foundation
Repository layout (TS serving app, Python worker package, shared migration tooling). Managed Postgres with `serving`, `knowledge`, `ledger` and `analytics` schemas, plus pgvector. Redis. Versioned S3 object storage. Secrets manager, TLS, CI/CD, environments, all in one India region. Structured logging, tracing and a **per-vendor cost metrics** library (spend per job type, per user, per credit) with budget alerts. Tenant-scoped data-access helper (account/workspace ID checks).
- **Deps:** none
- **REQs:** enabling for all. Directly supports REQ-057 (India-region latency), REQ-061/REQ-062 (India hosting for DPDP), REQ-008 and REQ-063 (tenant-scoped data access).

### M02: Job queue and scheduler
A durable job queue shared by both planes, with cron-style schedules, per-vendor concurrency and rate limits, retries, dead-letter queue and idempotency keys.
- **Deps:** M01
- **REQs:** enabling for REQ-026, REQ-034, REQ-047 and REQ-061 (durable async work), and for all knowledge-plane pipelines.

### M03: LLM adapter
A provider-agnostic interface used by both planes. It picks a model tier (a cheap classifier model or a stronger drafting model), caches responses, streams output, logs prompts and outputs with no personal data, and records cost through M01.
- **Deps:** M01
- **REQs:** enabling for REQ-005, REQ-013, REQ-038 and web-discovery classification (REQ-015, REQ-016, REQ-024).

### M04: Web front-end shell and design system
A mobile-first SSR app shell with navigation that follows the design's information architecture (§3.2). Includes the component library, **i18n framework with all strings externalised** (English only at launch), a reusable "cost badge" component that reads prices from the price catalogue (wired up in M28), disclaimer and label components, and performance budgets for mid-range Android on 4G.
- **Deps:** M01
- **REQs:** REQ-057 (foundation), REQ-058 (i18n readiness), REQ-054 (cost display component).

---

## Phase 1: Accounts and workspaces

### M05: Identity and sessions
Passwordless OTP by SMS (DLT-registered provider) and by email (transactional ESP). Sessions. **Anonymous visitor sessions** with rate limits per IP and device and bot protection. Role model for users and admins, and MFA for admins.
- **Deps:** M01, M04
- **REQs:** REQ-001, REQ-004 (anonymous access and throttling).

### M06: Consent and privacy notice ledger
Versioned privacy notices. Consent capture at signup. An append-only consent and withdrawal ledger with notice version and timestamp. Includes a hook for a future DPDP Consent Manager.
- **Deps:** M05
- **REQs:** REQ-062; enabling for REQ-061 (consent withdrawal).

### M07: Tenancy, business profile and onboarding
The `Account → Members → Workspaces (Products)` model, with one member per account in the MVP. The onboarding flow captures business name, city/state, what they make, export experience, optional IEC and optional target markets. All fields can be edited. Product workspace create, list, rename and delete. The workspace holds HS code, chosen markets, searches and shortlists, which later modules fill in.
- **Deps:** M05, M06
- **REQs:** REQ-002, REQ-008; groundwork for REQ-063 and REQ-003 (stores the IEC).

---

## Phase 2: Knowledge core and governance

### M08: Source licence register and connector framework
Register entries per source: `can_store`, `can_display`, `can_export`, `retention_days`, `attribution_text`, `personal_data_class` and `allowed_regions`. A connector base class **refuses to run for any source without a register entry**. LinkedIn and sources that forbid scraping are excluded. Raw landing to dated, immutable object storage with lifecycle rules set from `retention_days`.
- **Deps:** M01, M02
- **REQs:** REQ-036; enabling for REQ-033 (source attribution) and REQ-048 (export rights).

### M09: Evidence store (assertion model and projections)
Assertions with subject, attribute, value, `source_id`, `source_type`, `observed_at`, `checked_at`, confidence, inherited licence flags and `personal_data_class`. Supports negative assertions (invalid or bounced). Canonical Company entities. A projection builder that produces buyer profile and search documents from assertions. The `named_person` class exists in the model but is **disabled**.
- **Deps:** M01, M08
- **REQs:** REQ-017, REQ-024 (source type and confidence), REQ-033 (source and last-checked for every fact); enabling for REQ-021 and REQ-032.

### M10: Global suppression list and Visibility & Policy layer
A single enforcement library that every read path must use: search, profile, export, drafts, notifications and alerts. Rules run in order: global suppression → sanctions block (show with warning, deny reveal/draft) → licence flags → region and personal-data gating → default hiding of logistics entities → per-user hides → plan entitlements. The suppression list stores normalised, hashed identifiers, and **ingestion checks it too**. A suppression triggers immediate reindex or delete. The sanctions, logistics and entitlement inputs are interfaces here and are filled by M17, M19 and M28/M36.
- **Deps:** M09
- **REQs:** REQ-037 (suppression across all surfaces), REQ-020 (default hide + toggle), REQ-025 (per-user hide), REQ-029 (enforcement), REQ-036, REQ-048 (export filtering), REQ-051 (entitlement hook).

### M11: Review queue and admin console (core)
Typed review items with SLA timestamps, outcome and audit trail. The console runs behind RBAC and MFA. Outcome handlers write assertions or suppressions back through the M09/M10 paths. Item types are registered by later modules: buyer/contact reports, removal requests, possible sanctions matches, low-confidence entity merges, refund-cap exceptions and money-back requests.
- **Deps:** M05, M09, M10
- **REQs:** REQ-064; enabling for REQ-025, REQ-029, REQ-037 and REQ-055.

---

## Phase 3: Product and markets slice

### M12: HS nomenclature store and loaders
Loaders for WCO HS 2022 and HS 2027 tables, the correlation tables between them, and the DGFT ITC-HS 8-digit schedules with export-policy status and source links. Every code is versioned by nomenclature. Embeddings of descriptions are stored in pgvector.
- **Deps:** M01, M02, M03, M08
- **REQs:** data for REQ-005, REQ-006, REQ-007 and REQ-009.

### M13: HS helper (API + UI)
Free text → vector search → LLM rerank with explanation → candidates at 6-digit and 8-digit level with confidence. Hierarchy browsing (chapter → heading → subheading → ITC-HS line) and direct code entry. Shows export-policy status with the official link and a "confirm with DGFT/CHA" disclaimer. Saves the chosen code **with its nomenclature version** to the workspace. Works for anonymous visitors, within rate limits.
- **Deps:** M03, M04, M05, M07, M12
- **REQs:** REQ-005, REQ-006, REQ-007, REQ-004 (anonymous try).

### M14: Market analytics builder (knowledge plane)
UN Comtrade batch ingestion (monthly and annual) into country × HS6 tables of import value, CAGR, India's share and top supplier countries. A curated FTA/CEPA table. Batch ranking. **Cached LLM "why this market" summaries per country × HS6**, generated from the numbers.
- **Deps:** M02, M03, M08, M12
- **REQs:** REQ-010, REQ-011, REQ-013 (data side).

### M15: Coverage matrix builder
Computes Strong / Partial / Limited per country × HS heading, with a country-level fallback, from source-type availability, company counts and freshness in the evidence store. Uses a template explanation. Runs again after each pipeline run. Until Phase 4 fills the store, every country is Limited, which is honest.
- **Deps:** M02, M09
- **REQs:** REQ-012 (data side).

### M16: Market Finder (API + UI)
A ranked country list for the workspace's HS code: import value, growth, India's share, competitor supplier countries, FTA advantage, "why" summary and **coverage label with explanation**. The user can shortlist countries, which are saved as workspace defaults for buyer search. Works for anonymous visitors. Flow 1 step 4 (preview + signup gate) is completed in M26.
- **Deps:** M04, M05, M07, M13, M14, M15
- **REQs:** REQ-010, REQ-011, REQ-012, REQ-013, REQ-014, REQ-004.

---

## Phase 4: Buyer knowledge acquisition (knowledge plane)

### M17: Sanctions list ingestion and screener
Daily ingestion of OFAC SDN and consolidated lists, UN, EU consolidated and UK OFSI lists. Fuzzy name matching with transliteration handling. Screening runs at ingestion, again for all entities when a list changes, and as a **synchronous screening API** for reveal and draft. Writes the `sanctions_block` flag used by M10. Possible matches go to M11.
- **Deps:** M02, M08, M09, M10, M11
- **REQs:** REQ-029; feeds the sanctions check in REQ-027.

### M18: Normalisation and entity resolution
Name and address normalisation. Deterministic anchors (registry ID, LEI, VAT, domain), then fuzzy matching with confidence. Merges below the threshold go to M11. Checks the suppression list before any write.
- **Deps:** M09, M10, M11
- **REQs:** enabling for REQ-021 (one coherent profile per company) and REQ-037 (no resurrection of removed data); REQ-064 (merge review items).

### M19: Buyer classifiers (non-buyer filter + buyer type)
Rules, a curated list of forwarders and logistics firms, and an LLM fallback to flag logistics entities (hidden via M10, not deleted). Classifies buyer type (importer, distributor, wholesaler, retailer, manufacturer) with confidence and evidence.
- **Deps:** M03, M09, M18
- **REQs:** REQ-020, REQ-016 (buyer type), REQ-018 (type filter data).

### M20: Web discovery path
Search-API queries per product × country. Crawls candidate sites. LLM classification of "buyer of this product?" and extraction of **evidence snippets stored as assertions that point to the URL and capture date**. The LLM is never the source of a fact. Pre-warm schedules for launch countries (UK, DE, NL, UAE, plus US) × the most-searched headings. **On-demand discovery jobs** for cold combinations, with completion events. Built before the customs path, because architecture §8 allows a web-only launch.
- **Deps:** M02, M03, M08, M09, M18, M19
- **REQs:** REQ-015, REQ-016, REQ-017, REQ-024.

### M21: US customs batch connector and aggregates
Weekly licensed bill-of-lading ingestion to raw landing, then Parquet with DuckDB/Athena-style queries. Consignee resolution. Aggregates per company × HS heading: frequency, volumes, origin countries (including India), main suppliers, last-seen date. **Only aggregates** are written as assertions. The vendor is chosen per architecture open question 1.
- **Deps:** M02, M08, M09, M18, M19
- **REQs:** REQ-015, REQ-016, REQ-018 (shipment frequency, origin filters), REQ-019 (volume sort data), REQ-021 (activity summary), REQ-022 (India/competitor origin for US buyers).

### M22: Enrichment waterfall: discovery-time contacts
Resolves domains. Crawls company websites to extract company and role-level contacts (website, main phone, address, role emails, contact-form URL), each as an assertion with source and date. Records which **contact types exist** for search rows. Own MX and DNS checks. Google Places is not used (architecture §3.3).
- **Deps:** M02, M08, M09, M20
- **REQs:** REQ-032, REQ-033 (source and last-checked per contact), REQ-016 (contact availability).

### M23: Registry and domain-signal connectors
GLEIF, UK Companies House, EU VIES, optional OpenCorporates, RDAP/WHOIS domain age and a maintained free-mail domain list. On-demand with caching, and rate-limited per vendor.
- **Deps:** M02, M08, M09
- **REQs:** enabling for REQ-027, REQ-030 and entity anchors in M18.

### M24: Trust engine
Pluggable checks, each returning pass/fail/unknown with `checked_at` and a supporting assertion: registered entity, website present and consistent, domain age, corporate vs free-mail, recent trade activity, sanctions. A **deterministic, versioned rollup** to High/Medium/Low/Unknown, with the rule version stored. Wording comes from reviewed copy. Never "verified genuine". The checks can also be called on free-text input, which M32 uses.
- **Deps:** M09, M17, M21 (activity check; returns unknown without it), M22, M23
- **REQs:** REQ-027, REQ-028.

### M25: Freshness and re-verification scheduler
Finds stale assertions using tunable thresholds (about 90 days for contacts, about 6 months for re-crawl). Schedules re-checks. Provides a re-verification job API used at reveal (M29) and after reports (M30). An email-verification vendor is the fallback.
- **Deps:** M02, M09, M20, M22
- **REQs:** REQ-033 (stale detection and re-check), enabling for REQ-034.

---

## Phase 5: Buyer serving, credits and trust

### M26: Buyer search (index, API + UI)
A Postgres full-text and filtered-index search projection. Search by HS/keyword and one or more countries, defaulting to the workspace's shortlisted countries. Result rows show name, city and country, buyer type, evidence summary, latest activity, trust level and contact types. Filters: country, type, recency, shipment frequency, trust, contact availability, India/competitor sourcing. Sorts: relevance, recency, volume, trust. Logistics toggle. Coverage label per country. A "finding more buyers…" state that starts M20 on-demand jobs. **All results pass through M10**, including free-tier result limits. Anonymous preview of the count and first names, then the signup gate (Flow 1 step 4).
- **Deps:** M04, M05, M07, M10, M15, M16, M19, M20, M24
- **REQs:** REQ-015, REQ-016, REQ-018, REQ-019, REQ-020, REQ-012, REQ-024 (lower-confidence label in rows), REQ-004 (preview + gate), REQ-051 (limited visible results).

### M27: Buyer profile (API + UI)
The profile projection: overview, "why this buyer" evidence with source type and dates, activity and shipment summary, India/competitor sourcing where data exists, website, trust checklist with rollup and disclaimer, a prominent sanctions warning, contact *types* (values after reveal), and placeholders for drafts, notes and status (filled by M33/M34). Goes through M10.
- **Deps:** M10, M24, M26
- **REQs:** REQ-021, REQ-017, REQ-022 (display), REQ-024, REQ-027, REQ-028, REQ-029 (warning).

### M28: Credits ledger and price catalogue
An append-only double-entry ledger in the `ledger` schema: grants, debits, holds, commits, refunds referencing debits, and top-ups, all with idempotency keys. Derived, cached balance. Usage history UI. A **price catalogue as configuration** (credits per action and any per-country multipliers) that feeds the M04 cost badge and public pages. Free-tier monthly allowances (reveals, checks). Plan grants are wired to billing in M36.
- **Deps:** M01, M02, M04, M07
- **REQs:** REQ-054, REQ-034 (refund mechanics), REQ-051 (free allowances).

### M29: Contact reveal
Price shown → confirmation → ledger hold → **synchronous sanctions re-check** → staleness check (re-verify via M25 or mark stale) → deliverability status (valid/risky/unknown) → show contacts → commit debit. Single and bulk reveal with a bulk credit confirmation. Revealed-contact records per user (used by export).
- **Deps:** M10, M17, M22, M25, M27, M28
- **REQs:** REQ-032, REQ-033, REQ-034, REQ-029 (blocked reveal), REQ-054.

### M30: Reports and automatic invalid-contact refunds
Report buyer or contact as wrong product, not a buyer, closed, invalid contact or suspicious. Per-user hide takes effect immediately via M10. A negative assertion and a re-verification job. Confirmed invalid contacts lead to global exclusion and an **automatic refund** entry. Unconfirmed refunds are capped per user per month, and anything over the cap goes to M11. Content reports go to M11. The user sees confirmation.
- **Deps:** M10, M11, M25, M28, M29
- **REQs:** REQ-025, REQ-034, REQ-064.

### M31: Public removal and correction page
A no-login public form with requester email verification. Creates M11 review items. On approval: suppression list entry, immediate index removal, future ingestion blocked, and a confirmation email to the requester. Corrections write assertions.
- **Deps:** M04, M10, M11
- **REQs:** REQ-037, REQ-064.

### M32: Check a buyer
A standalone tool. Input: name, email, website and/or country. Runs the M24 checks on the free-text input and a **scam red-flag rules engine** (advance or registration fee, certification-fee traps, free-mail, new domain, name/domain mismatch, urgent large orders, sample-only). Gives advice on next steps. Metered by the M28 free allowance. Inputs are not added to the catalogue unless they resolve to an existing entity. Red flags also appear in context on trust checklists.
- **Deps:** M05, M24, M28
- **REQs:** REQ-030, REQ-031 (contextual part), REQ-051 (limited free use).

---

## Phase 6: Outreach and pipeline

### M33: Pipeline: shortlists, statuses and notes
Save buyers to a workspace shortlist, one at a time or in bulk. Statuses: To contact, Contacted, Replied, In discussion, Sample sent, Order won, Not interested. Free-text notes. The "My buyers" cross-product view. Status automatically set to Contacted after a draft leaves (hook from M34).
- **Deps:** M07, M26, M27
- **REQs:** REQ-045, REQ-046, REQ-008 (shortlists in workspaces), REQ-047 (notes part).

### M34: Outreach drafting: first contact
The LLM gets the product and business profile plus **company-level** buyer evidence, tone and language (English or the buyer's language), and returns an editable streamed draft. A **compliance footer assembled in code**: sender identity, business details, opt-out line, and a source-disclosure note for EU/UK built from assertion source types. Refused when M10 reports a sanctions block or suppression. Leaves the product only by copy or `mailto:`. Drafts are stored in the workspace.
- **Deps:** M03, M07, M10, M27, M33
- **REQs:** REQ-038, REQ-039, REQ-040, REQ-029 (draft block).

### M35: Export to Excel/CSV
An export job that goes **through M10**. It includes only contacts the user has revealed (M29) and fields whose licence allows export. Limited by plan, with watermarks or canaries. Exports shortlists or search results.
- **Deps:** M02, M10, M26, M29, M33
- **REQs:** REQ-048.

---

## Phase 7: Commerce, content, compliance and launch (MVP complete)

### M36: Plans, subscriptions and billing (Razorpay)
Plan definitions (Free, Starter, Growth, annual with discount) with credit allowances. Razorpay Subscriptions with UPI AutoPay, cards and net banking. Entitlements change **only from verified, idempotent webhooks**, with a daily reconciliation job. GSTIN capture and GST-compliant invoices stored as PDFs. Self-service payment-method update and cancellation. Plan-comparison page in INR. Wires plan grants into M28 and plan entitlements into M10.
- **Deps:** M02, M05, M07, M10, M28
- **REQs:** REQ-052, REQ-053, REQ-051 (free plan definition and limits), REQ-054 (plan allowances visible).

### M37: Content, Learn and promise pages
Operator-managed Markdown or headless CMS, versioned and localisable. Glossary and in-context tooltips (HS/ITC-HS, IEC, Incoterms, FOB/CIF, MOQ). Scam red-flag guide. First-export checklist and outreach guidance (first email, sample requests, Incoterms). Links to Trade Connect, EPCs and missions mapped by HS chapter. **Public "what we promise / don't promise", coverage and refund-policy pages**, with prices taken from the M28 catalogue.
- **Deps:** M04, M12 (HS chapter mapping), M28
- **REQs:** REQ-059, REQ-031 (Learn part), REQ-044, REQ-065, REQ-066.

### M38: User data rights
Account-settings actions to view, download (async export across every user-data schema, including notes and drafts), delete (with retention exceptions for ledger and invoices, with personal fields minimised) and withdraw consent (via M06). Grievance contact.
- **Deps:** M02, M06, M07, M28, M33, M34, M36
- **REQs:** REQ-061.

### M39: Launch hardening
End-to-end mobile QA of all core flows against performance budgets (architecture §7). Anti-scrape controls (per-plan result and export caps, bot detection). Degraded-mode behaviour when vendors are down (stale labels, "unknown" deliverability). Cost-per-credit dashboard. Activation-metric instrumentation (≥5 saved, ≥1 draft). A final audit that no "verified genuine" wording exists.
- **Deps:** all Phase 0–7 modules
- **REQs:** REQ-057 (acceptance), REQ-028 (wording audit), REQ-066 (promise audit), REQ-004 and REQ-051 (abuse limits).

---

## Phase 8: Should follow-ups

### M40: HS version change re-confirmation
When a new nomenclature version is loaded, the correlation tables flag affected workspaces and the user is prompted to re-confirm their code (M13 UI).
- **Deps:** M07, M12, M13
- **REQs:** REQ-009.

### M41: Reminders, notifications and dashboard
Next-action reminders on shortlisted buyers, fired by the scheduler. A notification service: in-app always, plus transactional email on a separate authenticated subdomain for opted-in users. A dashboard read model: pipeline by status, follow-ups due, new saved-search hits (once M45 exists) and credit balance. Notification content goes through M10.
- **Deps:** M02, M10, M28, M33
- **REQs:** REQ-047, REQ-049.

### M42: Follow-up drafts
Second and third touch drafts that reuse the stored thread context, with suggested timing, and create reminders in M41. Same compliance footer and policy checks as M34.
- **Deps:** M34, M41
- **REQs:** REQ-041.

### M43: Money-back requests
An account action within the published window. Creates an M11 review item. On approval, issues a Razorpay refund and adjusts the plan and ledger.
- **Deps:** M11, M28, M36, M37 (published policy)
- **REQs:** REQ-055.

---

## Phase 9: Could / later extensions

### M44: Outcome events
Status changes to Replied, In discussion or Order won emit outcome events to the analytics schema for success metrics and relevance tuning. Small; can be folded into M33 if time allows.
- **Deps:** M33
- **REQs:** REQ-050.

### M45: Saved searches and alerts
Save a search. A scheduled comparison of new assertions against saved queries **through M10**. Alerts in-app and by email (and WhatsApp once M50 exists). Hits appear on the dashboard.
- **Deps:** M26, M41
- **REQs:** REQ-026.

### M46: Credit top-up packs
One-off Razorpay orders that write top-up entries to the ledger, without a plan change.
- **Deps:** M28, M36
- **REQs:** REQ-056.

### M47: IEC verification and "Verified exporter" badge
Checks the stored IEC against a DGFT lookup if one is available, otherwise through an M11 manual review item. Shows the badge on the user's profile and in drafts.
- **Deps:** M07, M11, M34
- **REQs:** REQ-003.

### M48: Similar buyers
pgvector similarity on buyer projections (same product, country and type), shown on the profile through M10.
- **Deps:** M10, M27
- **REQs:** REQ-023.

### M49: Outreach extras: WhatsApp click-to-chat and company one-pager
`wa.me` click-to-chat with a ready-made intro, for buyers with a business WhatsApp number. A reusable company/product intro (products, MOQ, certifications, Incoterms) that drafts use.
- **Deps:** M22, M34
- **REQs:** REQ-042, REQ-043.

### M50: WhatsApp notifications and support (opt-in)
WhatsApp Business Solution Provider integration with approved templates, opt-in consent recorded in M06, used for reminders and saved-search alerts, plus a support entry point.
- **Deps:** M06, M41 (M45 for alerts)
- **REQs:** REQ-060.

### M51: Hindi localisation
Hindi translations of UI strings and core Learn content, and a locale switcher. Draft language is handled separately in M34.
- **Deps:** M04, M37
- **REQs:** REQ-058.

### M52: Teams and consultant workspaces
Several members per account with roles, invitations, and a consultant view of several client workspaces, each with its own products, pipelines and credits. Builds on the M07 tenancy model; no data migration.
- **Deps:** M07, M28, M33, M36
- **REQs:** REQ-063.

### M53: Additional licensed buyer sources (phase-2 data)
A connector for Indian shipping-bill buyer data (only if its provenance is confirmed) and a LATAM customs connector. Both feed the existing M18/M19 pipeline, and "sources from India" coverage extends beyond US buyers.
- **Deps:** M08, M18, M19, M21 (pattern)
- **REQs:** REQ-022 (full), REQ-015 and REQ-018 (wider coverage).

---

## Dependency summary (critical path to MVP)

```
M01 → M02/M03/M04 → M05 → M06 → M07
M01 → M08 → M09 → M10 → M11
M12 → M13 ─┐
M14 ───────┼→ M16
M15 ───────┘
M17, M18 → M19 → M20 (→ M21) → M22 → M23 → M24 → M25
M24 + M15 + M16 → M26 → M27 → M28 → M29 → M30 ; M31 ; M32
M26/M27 → M33 → M34 → M35
M36 → M37 → M38 → M39  == MVP launch ==
```

Phases 3 and 4 can run in parallel if there is more than one engineer. The only hard link is that M26 needs both M16 and M24.

---

## Requirement traceability

| REQ | Priority | Module(s) |
|---|---|---|
| REQ-001 | Must | M05 |
| REQ-002 | Must | M07 |
| REQ-003 | Could | M47 (M07 stores IEC) |
| REQ-004 | Must | M05, M13, M16, M26, M39 |
| REQ-005 | Must | M12, M13 |
| REQ-006 | Must | M12, M13 |
| REQ-007 | Should | M12, M13 |
| REQ-008 | Must | M07, M33 |
| REQ-009 | Should | M12, M40 |
| REQ-010 | Must | M14, M16 |
| REQ-011 | Should | M14, M16 |
| REQ-012 | Must | M15, M16, M26 |
| REQ-013 | Should | M14, M16 |
| REQ-014 | Must | M16 |
| REQ-015 | Must | M20, M21, M26 (M53 widens) |
| REQ-016 | Must | M19, M20, M22, M26 |
| REQ-017 | Must | M09, M20, M27 |
| REQ-018 | Must | M19, M21, M26 |
| REQ-019 | Should | M21, M26 |
| REQ-020 | Must | M10, M19, M26 |
| REQ-021 | Must | M21, M27 |
| REQ-022 | Should | M21 (US buyers), M27, M53 (full) |
| REQ-023 | Could | M48 |
| REQ-024 | Must | M09, M20, M26, M27 |
| REQ-025 | Must | M10, M30 |
| REQ-026 | Could | M45 |
| REQ-027 | Must | M23, M24, M27 |
| REQ-028 | Must | M24, M27, M39 |
| REQ-029 | Must | M10, M17, M27, M29, M34 |
| REQ-030 | Should | M32 |
| REQ-031 | Should | M32, M37 |
| REQ-032 | Must | M22, M29 |
| REQ-033 | Must | M09, M22, M25, M29 |
| REQ-034 | Must | M28, M29, M30 |
| REQ-035 | Could | **Not covered** (see below) |
| REQ-036 | Must | M08, M10 |
| REQ-037 | Must | M10, M31 |
| REQ-038 | Must | M34 |
| REQ-039 | Must | M34 |
| REQ-040 | Must | M34 |
| REQ-041 | Should | M42 |
| REQ-042 | Could | M49 |
| REQ-043 | Could | M49 |
| REQ-044 | Should | M37 |
| REQ-045 | Must | M33 |
| REQ-046 | Must | M33 |
| REQ-047 | Should | M33 (notes), M41 |
| REQ-048 | Must | M35 |
| REQ-049 | Should | M41 |
| REQ-050 | Could | M44 |
| REQ-051 | Must | M10, M26, M28, M32, M36 |
| REQ-052 | Must | M36 |
| REQ-053 | Must | M36 |
| REQ-054 | Must | M04, M28, M29, M36 |
| REQ-055 | Should | M43 |
| REQ-056 | Could | M46 |
| REQ-057 | Must | M04, M39 |
| REQ-058 | Could | M04 (framework), M51 |
| REQ-059 | Should | M37 |
| REQ-060 | Could | M50 |
| REQ-061 | Must | M38 |
| REQ-062 | Must | M06 |
| REQ-063 | Could | M52 (M07 groundwork) |
| REQ-064 | Must | M11, M30, M31 |
| REQ-065 | Could | M37 |
| REQ-066 | Must | M37, M39 |

---

## Assumptions and open questions (for this plan)

1. **Commercial SaaS** (design assumption 1). If the product is only for the author's own use, drop M28, M36, M43, M46 and M52, and simplify M05 and M07 to a single user.
2. **Web-first data strategy.** M20 comes before M21 so that the product can launch web-only (every country Partial) if the US customs licence is not bought (architecture §8). M21 can then be skipped or delayed without blocking any other module. M24's activity check returns "unknown" without it.
3. **Should items inside the MVP.** REQ-007, 011, 013, 019, 030, 031, 044 and 059 are built into Phase 3–7 modules because they cost little extra there. REQ-009, 041, 047, 049 and 055 are in Phase 8 and can move into Phase 7 if time allows.
4. **Admin console before the flows that need it.** M11 is built in Phase 2 so that sanctions, entity-merge, report and removal flows can file review items from the start.
5. **Open questions carried over:** US customs vendor (affects M21), Indian shipping-bill provenance (M53), Trade Map / Market Access Map terms (M14), GST invoicing route (M36), refund-abuse caps and freshness thresholds (M30, M25), trust-wording legal review (M24, M37), and a web-discovery precision bar per launch country (M20). An evaluation set is needed before M26 shows web-found buyers.

---

## Requirements not yet covered

- **REQ-035** (Could: named decision-maker contacts, opt-in after compliance review, off for EU/UK): no module builds this feature on purpose. Architecture §3.6 says it is "not built" until the DPDP and GDPR legal review is done (architecture open question 5). The only groundwork is the disabled `named_person` data class and region gating in M09/M10. Add a module for it once legal clears it.

Every other requirement from REQ-001 to REQ-066 is covered by at least one module above. REQ-022 is only partly covered in the MVP: M21 covers US buyers, and full coverage in M53 depends on licensing.
