<!-- Written by: architecture-planning stage. Read by: implementation-planning, system-design. -->

# Architecture: Export Buyer Discovery for Indian Exporters

> **Scope:** the technical architecture: major components, data flow, storage, integrations and non-functional constraints (scale, security, cost, compliance). It does **not** split work into implementation modules or tasks (implementation-planning does that), and it does not define schemas, APIs or algorithms in detail (low-level design does that).
>
> **Inputs:** `docs/design.md` (requirements `REQ-001`…`REQ-066`) and `docs/okf.md` (research, September 2026).
>
> **Convention:** each component and decision cites the `REQ-` IDs it serves. Anything marked **[verify]** depends on an unverified vendor term, legal position or date carried over from the OKF.

---

## 1. Architectural drivers

These are the design and research facts that shape the architecture most. Everything after this section follows from them.

| # | Driver | Source | Architectural consequence |
|---|---|---|---|
| D1 | Every buyer fact and contact fact must show its **source type and last-checked date** | REQ-017, REQ-024, REQ-033 | Store knowledge as **assertions with provenance** rather than as plain columns (§4). |
| D2 | Reports, opt-outs and sanctions hits must apply on **every** surface: search, profile, export, drafts | REQ-020, REQ-025, REQ-029, REQ-037 | Use one **Visibility & Policy layer** that every read path must go through (§3.8). |
| D3 | **Coverage labels** must exist per country × product *before* a search | REQ-012 | Keep a precomputed **coverage matrix** that the knowledge pipeline maintains (§3.5). |
| D4 | Customs data names buyers only in the US, LATAM and Indian export records. The EU/UK/GCC need web and registry signals. | OKF §3.2 | Build **two discovery paths**: a batch path from licensed customs data, and an on-demand web-discovery path with LLM classification. Both write to the same knowledge base (§3.4). |
| D5 | Target price is ₹1.5k–5k/month. One enriched buyer costs about $0.13–0.60 if nothing is reused. | OKF §7.2–7.3, design §8 | Build a **shared, cross-user knowledge cache**: pay to enrich a company once and serve it to many users. Use cheap sources first, a cost-aware waterfall, and keep costly vendor calls to reveal time (§8). |
| D6 | Supplier terms limit what can be stored (Google Places, Trade Map, enrichment vendors), and LinkedIn is excluded | REQ-036, OKF §6 | Keep a **source licence register**. Every assertion carries licence flags (store / display / export / retention), and the policy layer enforces them (§3.3). |
| D7 | Credits are spent before a result is known, and bad contacts must be **refunded automatically** | REQ-034, REQ-054 | Use an **append-only credit ledger** with idempotent debit and refund entries (§3.10). |
| D8 | The product **does not send outreach email** in the MVP | REQ-040 | No outbound bulk-mail infrastructure. Transactional email to our own users only (§3.9). |
| D9 | DPDP applies in full from 13 May 2027. GDPR applies to EU/UK contacts. Two kinds of personal data exist: our **users'** data and **listed contacts'** data. | REQ-037, REQ-061, REQ-062, OKF §6 | Host in India. Keep a separate personal-data inventory, a suppression list that survives re-ingestion, and company/role-level contacts by default (§6). |
| D10 | Small team, mobile-first Indian SME users, and an unknown launch sector | design §2, REQ-057 | **Modular monolith** plus a separate data-pipeline worker tier, managed services, one region. Avoid microservices (§2). |

---

## 2. System shape

### 2.1 Decision: two planes, one database cluster

The system is split into a **Serving plane** (user-facing product) and a **Knowledge plane** (building and maintaining buyer knowledge). They share one managed PostgreSQL cluster in separate schemas, and they talk to each other through a job queue and read models, never through direct cross-writes.

- **Serving plane:** a modular monolith (web app plus API) that handles accounts, workspaces, search, profiles, trust display, reveals, drafts, pipeline, billing and admin. Serves REQ-001–REQ-066 as the user sees them.
- **Knowledge plane:** batch and on-demand workers for ingestion, entity resolution, classification, enrichment, trust checks, coverage computation and re-verification. Serves the data side of REQ-005–REQ-013, REQ-015–REQ-036.

**Why this shape:** the work in the two planes differs a lot. Serving needs low latency and has many small reads. Knowledge work is bursty, slow, rate-limited by vendors and paid per call. Keeping them apart lets pipeline failures or vendor outages degrade freshness without taking down the product. A modular monolith (not microservices) keeps operating costs within an SME price point (D5, D10).

**Rejected alternatives:**
- *Pure live aggregator* (call vendor APIs on every search, store nothing): per-search cost too high for the pricing (D5), latency too high for mobile users (REQ-057), and no way to hold provenance, reports or opt-outs (D1, D2).
- *Microservices from day one*: operating overhead does not fit team size or budget.
- *Reselling a trade-data vendor's UI or API directly*: gives no control over provenance, trust or coverage honesty (REQ-012, REQ-017, REQ-027), and vendor no-resale terms apply [verify].

### 2.2 Component overview

```
                         ┌──────────────────────────── SERVING PLANE ────────────────────────────┐
  Browser (mobile-first) │  Web front end (SSR, i18n-ready)                                      │
  ───────────────────────►  ├─ Public pages / anonymous try (rate-limited)                       │
                         │  └─ App pages                                                          │
                         │  Application API (modular monolith)                                    │
                         │   ├─ Identity & Consent        ├─ Product & HS Helper                  │
                         │   ├─ Market Finder             ├─ Buyer Search & Profile               │
                         │   ├─ Trust View / Check-a-Buyer├─ Contact Reveal                       │
                         │   ├─ Outreach Drafting         ├─ Pipeline & Reminders                 │
                         │   ├─ Credits Ledger & Billing  ├─ Notifications                        │
                         │   └─ Admin & Review Console                                            │
                         │  ── Visibility & Policy layer (every read path goes through this) ──  │
                         └───────────────┬───────────────────────────────▲──────────────────────┘
                                         │ jobs (queue)                  │ read models
                         ┌───────────────▼─────────── KNOWLEDGE PLANE ───┴──────────────────────┐
                         │  Source Connectors → Raw Landing (object store)                        │
                         │  Normalisation → Entity Resolution → Buyer Classification             │
                         │  Evidence Store (assertions + provenance + licence flags)             │
                         │  Enrichment Waterfall (domain, site crawl, role contacts, verify)     │
                         │  Trust Engine (checks + rollup)   Sanctions Screener                  │
                         │  Coverage Matrix builder   Market Analytics builder                   │
                         │  Freshness / re-verification scheduler                                │
                         └───────────────────────────────────────────────────────────────────────┘
  External: trade-data licensors · UN Comtrade · registries (GLEIF, Companies House, VIES, OpenCorporates)
            · sanctions lists · web search/crawl API · email verification · LLM provider
            · Razorpay · SMS/OTP (DLT) · transactional email · WhatsApp BSP (later)
```

---

## 3. Components

For each component: responsibility, key decisions, and the requirements it serves.

### 3.1 Web front end
- **Responsibility:** all user-facing and public pages; the guided journey (design §3.1); the anonymous "try it" flow.
- **Decisions:**
  - **Server-rendered, responsive web app** (for example Next.js/React), mobile-first, with a small JS payload for mid-range Android phones on 4G. Not a native app in the MVP. *(REQ-057)*
  - **i18n built in from day one**: all strings externalised and locale routing in place, even though only English ships at launch. Hindi can then be added without rework. *(REQ-058)*
  - Public marketing, "what we promise", coverage and refund pages are static or SSR for SEO. *(REQ-066)*
  - Every action that costs credits shows its price in credits and ₹, using figures from the Credits service (never hard-coded). *(REQ-054)*
  - Contact links use `mailto:` / "copy" / `wa.me` click-to-chat only. *(REQ-040, REQ-042)*
- **Serves:** REQ-004, REQ-054, REQ-057, REQ-058, REQ-059, REQ-066.

### 3.2 Identity, Consent & Account
- **Responsibility:** OTP sign-in, sessions, business profile, consent records, and user data rights.
- **Decisions:**
  - Passwordless **OTP by SMS or email**. SMS goes through an Indian provider registered for **TRAI DLT** templates (a requirement for Indian transactional SMS [verify provider]). Email OTP goes through the transactional email provider. *(REQ-001)*
  - Anonymous visitors get a session that is limited by rate, device and IP, plus bot protection (CAPTCHA or Turnstile). This protects the HS helper and market ranking from scraping and cost abuse. *(REQ-004, REQ-051)*
  - **Consent ledger**: every consent and withdrawal is stored with the notice version and timestamp. The design leaves room for a later DPDP Consent Manager integration (the consent-manager framework starts November 2026). *(REQ-062, REQ-061)*
  - **Data-rights jobs** (export, delete, withdraw consent) run as async jobs that cover every schema that holds user data, including pipeline notes and drafts. The ledger and invoices are kept for their legal retention period, with personal fields minimised. *(REQ-061)*
  - Optional IEC check: store the IEC, verify it against a DGFT lookup if one is available [verify], else by manual review, and show the "Verified exporter" badge. *(REQ-003)*
  - The **tenancy model** is `Account → Members → Workspaces(Products)` from the start, even though the MVP has one member per account. This lets team and consultant features arrive without migrating data. *(REQ-008, REQ-063)*
- **Serves:** REQ-001, REQ-002, REQ-003, REQ-004, REQ-008, REQ-061, REQ-062, REQ-063.

### 3.3 Source Connectors & Source Licence Register
- **Responsibility:** fetch data from every external source into a **raw landing zone** (object storage, immutable and dated), and record each source's usage rights.
- **Decisions:**
  - Each source has a **licence register entry**: `can_store`, `can_display`, `can_export`, `retention_days`, `attribution_text`, `personal_data_class`, `allowed_regions`. Every assertion derived from the source inherits these flags. *(REQ-036, REQ-048, REQ-033)*
  - **Only sources with a register entry may be connected.** LinkedIn and any source whose terms forbid scraping are excluded at this layer. *(REQ-036)*
  - Sources whose terms forbid persistent storage (such as Google Places content [verify]) are **not used to build the knowledge base**. If they are used at all, they are called at reveal time with results shown for the session only, and only the place ID is stored. The default in the MVP is **not** to use Places and to get phone and address from the company's own website instead. *(REQ-032, REQ-036)*
- **Source plan for the MVP** (from OKF §3):

| Layer | Source (MVP) | Mode | Serves |
|---|---|---|---|
| Market aggregates | **UN Comtrade** (bulk and API, monthly and annual) | Batch, monthly | REQ-010, REQ-013 |
| Tariffs / FTAs | **Curated table** of India's FTAs/CEPAs (UAE CEPA, India–Australia ECTA, India–UK CETA [verify status]) plus ITC Market Access Map where terms allow [verify] | Manual/batch, quarterly | REQ-011 |
| HS nomenclature | WCO HS 2022 + HS 2027 tables and correlation; DGFT **ITC-HS** 8-digit schedules with export policy | Batch, on release | REQ-005, REQ-006, REQ-007, REQ-009 |
| US buyers (Strong) | **Licensed US bill-of-lading feed** (manifest reseller or ImportYeti Enterprise API; to be chosen on price [verify]) | Batch, weekly | REQ-015–REQ-022 |
| LATAM buyers | One commercial LATAM customs licence (**deferred to phase 2**, depends on budget) | Batch | REQ-015, REQ-022 |
| "Buys from India" | Licensed Indian shipping-bill buyer data (**only if** legal provenance is confirmed, OKF Q6) | Batch | REQ-018, REQ-022 |
| EU/UK/GCC buyers (Partial) | **Web search API** (e.g. Exa) + **crawler** (e.g. Firecrawl) + LLM classification | On-demand and scheduled | REQ-015, REQ-016, REQ-017, REQ-024 |
| Entity identity | **GLEIF** (free), **UK Companies House** (free), **EU VIES** (free [verify]), OpenCorporates (paid, optional) | On-demand + cache | REQ-027 |
| Sanctions | OFAC SDN + consolidated, UN, EU consolidated, UK OFSI lists | Batch, daily | REQ-029 |
| Domain signals | RDAP/WHOIS (domain age), DNS MX | On-demand + cache | REQ-027, REQ-033 |
| Email deliverability | Own MX/SMTP checks + an email-verification vendor as fallback | At reveal time | REQ-033, REQ-034 |
| Trade Map directory, Trade Connect, EPC lists | **Link-out only** until reuse terms are confirmed (OKF Q5, Q10) | — | REQ-065 |

### 3.4 Knowledge Pipeline (normalise → resolve → classify)
- **Responsibility:** turn raw records into canonical **Company** entities with typed evidence.
- **Two entry paths, one output (D4):**
  1. **Batch customs path.** Parse shipments, normalise names and addresses, resolve consignees to Company entities, then aggregate per company × HS heading (frequency, volumes, origin countries, suppliers, last-seen date). Raw shipment rows stay in the landing zone and analytical storage. The serving database holds only **per-company aggregates**. *(REQ-018, REQ-019, REQ-021, REQ-022)*
  2. **Web-discovery path.** Queries such as "importer / distributor / wholesaler of ⟨product⟩ in ⟨country⟩" go to the search API. Candidate sites are crawled, then an LLM **classifies** whether each site is a buyer of the product, what buyer type it is, and extracts the page snippets that support that as evidence. Results are resolved into the same Company entities. *(REQ-015, REQ-016, REQ-017, REQ-024)*
- **Entity resolution:** deterministic anchors first (registry ID, LEI, VAT, web domain), then normalised-name and address fuzzy matching with confidence scores. Merges below a set confidence go to the review queue rather than being applied automatically. *(REQ-021, REQ-064)*
- **Non-buyer filter:** a classifier (rules plus a curated list of known forwarders, NVOCCs and logistics firms, plus an LLM fallback) marks logistics entities. They are hidden by default through the policy layer, not deleted. *(REQ-020)*
- **Buyer-type classification:** importer, distributor, wholesaler, retailer or manufacturer, with a confidence score and supporting evidence. *(REQ-016, REQ-018)*
- **When web discovery runs:** 
  - **Pre-warm:** scheduled discovery for launch countries × the most-searched HS headings, so that most searches read from the cache.
  - **On-demand:** a search on a cold country × HS combination starts a discovery job. The UI shows the results already available together with a "finding more buyers…" state, and the user is notified when the job finishes. Results go into the shared cache for all users. *(REQ-015, REQ-026)*
- **LLM use rule:** LLMs **classify and extract**. Each LLM output is stored as an assertion that points back to the crawled page (URL plus capture date). An LLM is never the *source* of a fact. *(REQ-017, REQ-024)*

### 3.5 Evidence Store (the knowledge base)
- **Responsibility:** the canonical store of what is known about each buyer, and how it is known.
- **Decision: assertion model.** Each fact (e.g. "Company X buys HS 6302", "website = …", "sales email = …", "registered in Companies House", "last shipment 2026-08") is an **assertion** with: subject entity, attribute, value, `source_id`, `source_type` (customs / website / directory / registry / user report), `observed_at`, `checked_at`, confidence, licence flags (inherited, §3.3) and a `personal_data_class`. Profiles and search documents are **projections** built from assertions. *(REQ-017, REQ-024, REQ-033, REQ-036; D1)*
- **Why:** provenance and freshness then work the same way for every fact. Licence and opt-out rules can be enforced per fact. Stale facts can be found and re-checked on a schedule. Adding a new source adds assertions and needs no change to the schema.
- **Coverage matrix:** a precomputed table keyed by country × HS heading (with a country-level fallback). It records which source types are available, how many companies and how fresh the data is, and from that computes **Strong / Partial / Limited** with a template explanation. It is refreshed after each pipeline run. Search and market pages only read it. *(REQ-012; D3)*
  - Starting rule (low-level design to tune): *Strong* means customs evidence exists for the country and the recent buyer count is above a threshold. *Partial* means registry-anchored web or directory evidence above a threshold. *Otherwise Limited.*
- **Market analytics tables:** ranking inputs from Comtrade by country × HS6 (import value, CAGR, India's share, top supplier countries) plus FTA flags. The ranking is computed in batch. The short "why this market" text is generated from the numbers by an LLM, **cached per country × HS6**, and not regenerated on each request. *(REQ-010, REQ-011, REQ-013)*

### 3.6 Enrichment Waterfall & Contacts
- **Responsibility:** company → domain → company-level and role contacts → deliverability status.
- **Decisions:**
  - **Company and role-level only in the MVP**: website, main phone, address, role emails (sales@, purchasing@, info@), contact-form URL. These are extracted mainly by **crawling the company's own website**, which is the cheapest source and has the clearest provenance. *(REQ-032; design principle 4)*
  - **Two-step enrichment:** *discovery-time* enrichment finds the domain and records only *which contact types exist*, which is enough for the search row. *Reveal-time* enrichment runs deliverability checks when an item is **stale** (older than the freshness threshold) and only then shows it. This keeps expensive calls to companies that users actually care about. *(REQ-016, REQ-033, REQ-034; D5)*
  - Named-person contacts (REQ-035) are **not built**. The assertion model already supports a `personal_data_class = named_person` and region gating (off for EU/UK), so the feature can later be switched on per region after compliance review, without redesign. *(REQ-035)*
  - Contacts marked invalid by users, or bounced, become negative assertions. The contact is excluded for everyone until it is re-verified. *(REQ-025, REQ-034)*
- **Serves:** REQ-016, REQ-032, REQ-033, REQ-034, REQ-035, REQ-036.

### 3.7 Trust Engine & Sanctions Screener
- **Responsibility:** compute the trust checklist and trust level for catalogue buyers and for ad-hoc "Check a buyer" inputs.
- **Decisions:**
  - **Check modules are pluggable**, and each returns `pass | fail | unknown` plus `checked_at` and a supporting assertion: registered entity (GLEIF / Companies House / VIES / OpenCorporates), website present and consistent (the crawled site matches name and country), domain age (RDAP), corporate vs free-mail (a maintained free-mail domain list), recent trade activity (customs evidence recency), sanctions screening. *(REQ-027)*
  - **The rollup is deterministic and versioned** (a rules table, not an LLM), so each trust level can be explained and audited. The rule version is stored with each result. Liability-sensitive wording comes from reviewed copy that the rules reference (open question 4 in the design). *(REQ-028)*
  - **Sanctions screening** fuzzy-matches names (with transliteration handling) against the daily-refreshed lists. It runs at ingestion, again for **all** entities whenever a list changes, and again synchronously before any reveal or draft. A hit writes a `sanctions_block` flag that the policy layer enforces. Possible matches go to the review queue. Confirmed hits stay blocked. *(REQ-029, REQ-064)*
  - **Check a buyer** reuses the same modules on free-text input (name, email, website, country), plus a **red-flag rules engine** for scam patterns (free-mail domain, new domain, a name that doesn't match the domain, and user-reported keywords such as "registration fee"). Results are metered through the credits ledger allowances. Inputs are not added to the shared catalogue unless they resolve to an existing entity. *(REQ-030, REQ-031, REQ-051)*
- **Serves:** REQ-027, REQ-028, REQ-029, REQ-030, REQ-031.

### 3.8 Visibility & Policy Layer (cross-cutting)
- **Responsibility:** one enforcement point, applied **before** data reaches search results, profiles, exports, drafts, notifications or saved-search alerts.
- **Rules evaluated (in order):** global suppression (opt-out / removal) → sanctions block (the entity can be shown with a warning, but reveal and draft are denied) → licence flags (store/display/export) → region and personal-data gating → default hiding of logistics entities → per-user hides from reports → plan entitlements (e.g. free-tier result limits). *(REQ-020, REQ-025, REQ-029, REQ-036, REQ-037, REQ-048, REQ-051; D2)*
- **Decision:** the **search index is filtered at query time** using the same policy evaluation. Suppressions also trigger an immediate reindex or delete, so there is no window during which suppressed data can be found. Exports are built through the policy layer and never straight from tables. *(REQ-037, REQ-048)*
- **Global suppression list:** stores normalised and hashed identifiers (domain, email, phone, company ID). The **ingestion pipeline checks it**, so re-ingested data cannot bring removed records back. *(REQ-037)*

### 3.9 Outreach Drafting
- **Responsibility:** AI drafts of first and follow-up emails, WhatsApp intro text, and one-pager text.
- **Decisions:**
  - The LLM gets only: the user's product and business profile, the buyer's **company-level** evidence, tone, and language. No named personal data is sent. *(REQ-038, REQ-043)*
  - The **mandatory compliance footer is assembled in code, not by the LLM**: sender identity, business details, opt-out line, and for EU/UK recipients the source-disclosure note built from the assertions' source types. This guarantees REQ-039 no matter what the model outputs.
  - A draft is refused if the policy layer reports a sanctions block or suppression. *(REQ-029)*
  - The product never sends outreach mail. Drafts leave through copy, `mailto:` or `wa.me` only. *(REQ-040, REQ-042; D8)*
  - Follow-up drafts reuse the thread context stored in the pipeline record. *(REQ-041)* Guidance content (REQ-044, REQ-059) is static CMS content, not generated.
- **LLM provider:** used through an internal adapter, so the model can be changed for cost or quality. Drafts are generated when requested and stored in the user's workspace.
- **Serves:** REQ-038, REQ-039, REQ-040, REQ-041, REQ-042, REQ-043, REQ-044.

### 3.10 Credits Ledger, Plans & Billing
- **Decisions:**
  - An **append-only, double-entry credit ledger**: plan grants, top-ups, debits (reveal, check, export) and refunds are all ledger entries with idempotency keys. The balance is derived from the entries (and cached). A reveal places a hold, then commits the debit once contacts are shown. If deliverability later fails, or a user's "invalid" report is confirmed by an automatic re-check, a **refund entry referencing the original debit** is written automatically. *(REQ-034, REQ-054, REQ-056; D7)*
  - **Abuse control on refunds:** automatic refunds apply when an automated re-check confirms the contact is invalid. Refunds that can't be confirmed automatically are capped per user per month, and anything over the cap goes to the review queue. *(REQ-034, REQ-064)*
  - A **price catalogue** (credits per action, per-country multipliers if any) is kept as configuration and shown to the UI and on public pages from the same source, so what is shown always matches what is charged. *(REQ-054, REQ-066)*
  - **Payments: Razorpay Subscriptions** for monthly plans with **UPI AutoPay** mandates, plus cards and net banking. One-time Razorpay orders for top-ups. Entitlements change **only from verified webhooks** (idempotent, signature-checked, reconciled daily against Razorpay). Stripe is not used in the MVP (weaker INR recurring support, OKF §7.2). *(REQ-052, REQ-053, REQ-056)*
  - **GST invoices:** generated for each successful charge with a GST-compliant invoice series, GSTIN capture for B2B users, and stored PDFs, through Razorpay's invoicing or a GST invoicing service [choice deferred to low-level design]. *(REQ-053)*
  - The money-back request is an account action that creates a review item and, when approved, a Razorpay refund. *(REQ-055, REQ-064)*
- **Serves:** REQ-034, REQ-051, REQ-052, REQ-053, REQ-054, REQ-055, REQ-056.

### 3.11 Pipeline, Reminders & Notifications
- **Decisions:**
  - Shortlists, statuses, notes and reminders are plain relational data in the serving schema, scoped to a workspace. *(REQ-045, REQ-046, REQ-047)*
  - A **scheduler** (the same job system as §5) fires reminders and saved-search checks. Saved-search alerts compare new assertions against the stored query **through the policy layer**. *(REQ-026, REQ-047, REQ-049)*
  - **Notification channels:** in-app (always), **transactional email** to our own users through an ESP with SPF/DKIM/DMARC on a subdomain kept separate from marketing, and **WhatsApp** through a Business Solution Provider using approved templates for opted-in users (later). *(REQ-026, REQ-047, REQ-060)*
  - Status changes to Replied, In discussion or Order won go to an **outcome events** stream used for metrics and relevance tuning. *(REQ-050)*
  - The dashboard is a read model that aggregates pipeline counts, due reminders, new saved-search hits and credit balance. *(REQ-049)*
  - Excel/CSV export runs as a job that goes through the policy layer (it includes only revealed contacts and fields whose licence allows export) and is limited by plan. *(REQ-048)*
- **Serves:** REQ-026, REQ-045, REQ-046, REQ-047, REQ-048, REQ-049, REQ-050, REQ-060.

### 3.12 Admin & Review Console
- **Responsibility:** the operator's tool for user reports, opt-out and correction requests, possible sanctions matches, low-confidence entity merges, refund-cap exceptions, and money-back requests.
- **Decisions:** a single **review queue** with typed items, SLA timestamps, an outcome and an audit trail. Outcomes write assertions or suppressions back through the same paths the pipeline uses, so every decision reaches all surfaces through the policy layer. The console runs inside the monolith behind role-based access and requires MFA. *(REQ-025, REQ-037, REQ-055, REQ-064)*
- A **public removal/correction form** (no login needed, with email verification of the requester) creates the review items. *(REQ-037)*

### 3.13 Content (Learn, glossary, scam guide, promises)
- Content is managed by the operator as Markdown or a headless CMS, versioned in the repo, and localisable. It is linked to HS chapters and sectors so the right EPC and government links appear for each product. *(REQ-031, REQ-044, REQ-059, REQ-065, REQ-066)*

---

## 4. Data flows

### 4.1 Batch customs ingestion (weekly)
`Licensed feed → Raw landing (object store) → parse/normalise → suppression check → entity resolution → forwarder filter → per-company×HS aggregates → assertions (with licence flags) → sanctions screen → trust recompute (affected entities) → search index update → coverage matrix refresh`.
*(REQ-012, REQ-015–REQ-022, REQ-027, REQ-029, REQ-037)*

### 4.2 Search → profile → reveal → draft (interactive)
1. The user searches (HS/keyword + countries). The API reads the **coverage matrix** and queries the **search index**. Results pass through the **policy layer** and plan limits. If the country × HS combination is cold, a discovery job is queued. *(REQ-012, REQ-015, REQ-016, REQ-018, REQ-019, REQ-051)*
2. The profile page builds its projection from assertions: evidence, activity, trust checklist and contact *types*. *(REQ-017, REQ-021, REQ-027)*
3. Reveal: price shown → confirm → ledger hold → sanctions re-check → staleness check (re-verify if stale, or show as stale per REQ-033) → contacts shown → debit committed. *(REQ-029, REQ-033, REQ-034, REQ-054)*
4. Draft: policy check → LLM draft → footer added in code → user copies or opens in mail app → status changes to Contacted. *(REQ-038, REQ-039, REQ-040, REQ-046)*

### 4.3 Report / invalid contact
User report → per-user hide takes effect immediately → negative assertion + re-verification job → if invalid is confirmed: global exclusion + **automatic refund entry** → review item for content reports ("not a buyer", "suspicious"). *(REQ-025, REQ-034, REQ-064)*

### 4.4 Opt-out / removal
Public form → email verification → review item → on approval: **global suppression list** entry → immediate removal from the index → future ingestion blocked → confirmation email to the requester. *(REQ-037, REQ-064)*

### 4.5 HS helper
Free text → embedding search over the versioned HS/ITC-HS descriptions (pgvector) → LLM rerank with an explanation → candidates with confidence scores → the user browses the hierarchy or confirms. The chosen code is saved together with its **nomenclature version**. When a new version is loaded, the correlation tables mark affected workspaces for re-confirmation. *(REQ-005, REQ-006, REQ-007, REQ-009)*

---

## 5. Storage & infrastructure decisions

| Concern | Decision | Rationale | Serves |
|---|---|---|---|
| Hosting region | **One cloud region in India** (e.g. AWS ap-south-1 Mumbai) | Latency for Indian users; simpler DPDP story; INR billing | REQ-057, REQ-061, REQ-062 |
| Primary database | **Managed PostgreSQL** with separate schemas: `serving`, `knowledge`, `ledger`, `analytics` | Relational integrity for the ledger and pipeline; JSONB for assertion values; one system to run | REQ-008, REQ-034, REQ-045 |
| Vector search | **pgvector** inside Postgres | HS helper and similar-buyer search at modest scale; no extra service | REQ-005, REQ-023 |
| Buyer search | **Postgres full-text + filtered indexes at first**; move to OpenSearch/Typesense only when needed (§7) | Buyer-entity volume (low millions) fits in Postgres; avoids running a cluster early | REQ-015, REQ-018, REQ-019 |
| Raw data & exports | **Object storage** (S3), versioned; lifecycle rules follow each source's `retention_days` | Immutable raw data allows reprocessing; licence-driven retention | REQ-036, REQ-048 |
| Bulk shipment analytics | Columnar files (Parquet) in object storage queried by DuckDB/Athena-style engines; **only aggregates** loaded into Postgres | US BoL means tens of millions of rows a year; these don't belong in the OLTP database | REQ-018, REQ-021, REQ-022 |
| Jobs & scheduling | **Postgres-backed durable job queue** (e.g. a Graphile-Worker/Oban-style design) or SQS, with per-vendor concurrency and rate limits, retries and dead-letter queues | Vendor rate limits and costs need controlled throughput; durable jobs are needed for refunds and data-rights actions | REQ-026, REQ-034, REQ-047, REQ-061 |
| Cache | Redis (or equivalent) for sessions, rate limits and hot projections | Mobile latency; anonymous-use throttling | REQ-004, REQ-057 |
| Languages | **TypeScript** for the serving plane (web + API); **Python** for knowledge-plane workers | Python has a better ecosystem for data, entity resolution and ML; TypeScript suits the SSR web app. Two languages is an accepted cost. | — |
| LLM | External API through an adapter; small, cheap models for classification, a stronger model for drafts; response caching | Cost control; ability to swap models | REQ-005, REQ-013, REQ-038 |

---

## 6. Security, privacy & compliance architecture

| Topic | Decision | Serves |
|---|---|---|
| Two personal-data domains | **User data** (accounts, profiles, notes, drafts) and **listed-contact data** (company role contacts; named persons later) are inventoried separately, each with its own retention and rights process | REQ-037, REQ-061 |
| Minimisation | MVP stores company and role-level contacts only. Named-person class exists in the model but is switched off. EU/UK named data stays off by default. | REQ-032, REQ-035 |
| GDPR basis for EU/UK role contacts | A documented Legitimate Interest Assessment; source disclosure available on the profile and added to drafts; public opt-out | REQ-037, REQ-039 |
| DPDP readiness (13 May 2027) | Consent ledger, notice versioning, data-rights jobs, breach-response runbook, grievance contact; Consent Manager integration planned | REQ-061, REQ-062 |
| Prohibited sources | Enforced by the licence register at connector level; no LinkedIn | REQ-036 |
| Encryption | TLS everywhere; encryption at rest (managed keys); secrets in a secrets manager | — |
| Access control | Tenant isolation by account/workspace ID checked in the data-access layer (and optionally Postgres row-level security); admin console requires MFA and RBAC; every admin action audit-logged | REQ-063, REQ-064 |
| Abuse / scraping of our catalogue | Rate limits, per-plan result caps, export caps, bot detection, and watermarking/canaries in exports to detect bulk resale | REQ-004, REQ-048, REQ-051 |
| Payment security | No card data stored (Razorpay handles PCI); webhook signature verification | REQ-053 |
| LLM data handling | Only company-level data and the user's own business info are sent; a provider with no training on API data is chosen; prompts and outputs are logged without personal data | REQ-038 |
| Promises & liability | Trust wording and disclaimers come from reviewed, versioned copy; no "verified genuine" label anywhere in the code | REQ-028, REQ-066 |

---

## 7. Non-functional targets

These are **planning assumptions** for sizing. Revisit them after launch.

| Dimension | Target / assumption |
|---|---|
| Users (year 1) | ~10k registered, ~500–1,500 paid, ~300 concurrent at peak |
| Knowledge base | ~1–3M company entities; ~20–50M assertions; US BoL raw data ~10–30M rows/year in object storage |
| Latency (p95, India, 4G) | Page TTFB < 800 ms; search < 1.5 s from the index; reveal < 3 s when fresh (< 15 s when re-verification runs, with a progress state); draft < 10 s streamed |
| Freshness | Customs aggregates weekly; sanctions daily; contact re-verification on reveal if older than ~90 days (tunable); web-discovered entities re-crawled ~every 6 months or when accessed |
| Availability | 99.5% for the serving plane; the knowledge plane may lag by up to 24 h without user-visible failure, since reads come from existing assertions |
| Degradation | Vendor outage → show last-known data marked stale; block only the actions that truly need the vendor (e.g. deliverability re-check → show "unknown" instead of failing) |
| Scale-out path | Stateless API scales horizontally; Postgres read replica for search and projections; move buyer search to a dedicated engine when the index is >5M docs or p95 exceeds the target |
| Observability | Structured logs, traces, and **per-vendor cost metrics** (spend per job type, per user, per credit) with budget alerts |
| Backups | Point-in-time recovery on Postgres; versioned object storage; ledger is append-only |

---

## 8. Cost model (architecture-level)

The pricing in the design (₹1.5k–5k/month) only works if enrichment cost is **shared across users** (D5).

| Cost item | Architectural lever | Rough monthly (year 1) [verify all] |
|---|---|---|
| US customs licence | Single licence, batch ingestion; biggest fixed cost | ~$1,000+/month (ImportYeti Enterprise floor) or a reseller feed [verify] |
| Web discovery (search + crawl) | Pre-warm top combinations; results cached for all users; re-crawl only when stale | ~$100–400 |
| LLM (classification, drafts, summaries) | Small models for classification; cached market summaries; drafts only on request | ~$100–500 |
| Email verification | Only at reveal time, only when stale; own MX checks first | ~$50–200 |
| Registries & sanctions | Mostly free APIs and downloads; OpenCorporates optional | ~$0–300 |
| Infrastructure (Mumbai region, managed DB, storage, workers) | Monolith, a single DB cluster, no search cluster at first | ~$300–800 |
| SMS OTP / transactional email | Email OTP preferred where possible | ~$50–150 |

**Illustrative break-even:** fixed costs of roughly $2–3k/month need about 110–170 Starter-equivalent subscribers at ₹1,500–2,000. Marginal cost per reveal is ≈ $0.00–0.10 when cached, compared with $0.13–0.60 cold (OKF §7.3). The architecture should **report cost per credit** from day one (§7 observability) so that the credit prices in REQ-052 and REQ-054 can be set from data.

**Main risk:** the US customs licence is a fixed cost paid before revenue. Alternative if the budget doesn't allow it: launch with web-discovery coverage only (every country **Partial**, honestly labelled per REQ-012) and add the customs licence when paid users justify it. The architecture supports this unchanged, because customs data is just one more source path into the Evidence Store.

---

## 9. Launch coverage decision

The design asks architecture-planning to choose launch countries (design §7). Based on OKF §3.2:

| Country | Expected label | Basis |
|---|---|---|
| **United States** | Strong | Licensed BoL feed + web + registries (SEC/GLEIF) |
| **United Kingdom** | Partial | Web discovery + Companies House (free, good registry anchor) |
| **Germany, Netherlands** | Partial | Web discovery + VIES / GLEIF anchors |
| **UAE** | Partial | Web discovery; weaker registry anchors; high user demand (CEPA) |
| All other countries | Limited (searchable, clearly labelled) | On-demand web discovery only |

LATAM (Strong via a vendor licence) and "buys from India" data (REQ-022) are **phase-2 source additions**. No architectural change is needed for them. *(REQ-012, REQ-015, REQ-022)*

---

## 10. Requirement traceability

| REQ | Primary component(s) |
|---|---|
| REQ-001, REQ-002, REQ-062 | Identity, Consent & Account (§3.2) |
| REQ-003 | Identity (IEC check) |
| REQ-004 | Front end + Identity (anonymous session, rate limits) |
| REQ-005, REQ-006, REQ-007, REQ-009 | HS nomenclature store + HS helper flow (§3.3, §4.5) |
| REQ-008, REQ-063 | Tenancy model (§3.2) |
| REQ-010, REQ-011, REQ-013, REQ-014 | Market analytics tables + Market Finder (§3.5); REQ-014 is stored as workspace defaults |
| REQ-012 | Coverage matrix (§3.5) |
| REQ-015, REQ-016, REQ-018, REQ-019 | Knowledge pipeline + search index + policy layer (§3.4, §3.8) |
| REQ-017, REQ-024 | Evidence Store assertion model (§3.5) |
| REQ-020 | Non-buyer filter + policy layer |
| REQ-021, REQ-022, REQ-023 | Profile projections; customs aggregates; pgvector similarity |
| REQ-025 | Report flow (§4.3) + review console |
| REQ-026 | Scheduler + saved-search alerts (§3.11) |
| REQ-027, REQ-028, REQ-030, REQ-031 | Trust Engine (§3.7) |
| REQ-029 | Sanctions Screener + policy layer |
| REQ-032, REQ-033, REQ-035 | Enrichment Waterfall (§3.6) |
| REQ-034, REQ-054, REQ-056 | Credits Ledger (§3.10) |
| REQ-036 | Source Licence Register (§3.3) |
| REQ-037 | Global suppression + removal flow (§3.8, §4.4) |
| REQ-038–REQ-044 | Outreach Drafting (§3.9) |
| REQ-045–REQ-050 | Pipeline, Reminders & Notifications (§3.11) |
| REQ-051 | Policy layer (plan entitlements) + ledger allowances |
| REQ-052, REQ-053, REQ-055 | Billing (Razorpay) (§3.10) |
| REQ-057, REQ-058 | Front end (§3.1) |
| REQ-059, REQ-065, REQ-066 | Content (§3.13) + front end |
| REQ-060 | Notifications (WhatsApp BSP) |
| REQ-061 | Data-rights jobs (§3.2, §6) |
| REQ-064 | Admin & Review Console (§3.12) |

---

## 11. Assumptions

1. The product is a **commercial SaaS** (design assumption 1). If it is for the author's own use, drop billing (§3.10), the ledger and multi-tenancy, and replace the licensed customs feed with free ImportYeti browsing plus manual work.
2. There is budget for **one** customs data licence (US) in year 1. Otherwise use the web-only fallback (§8).
3. A small team (1–4 engineers) runs the system, which is why managed services and a monolith were chosen.
4. Storing company-level and role-level contact data under a documented LIA is acceptable for EU/UK, pending legal review.
5. LLM classification of web-discovered buyers reaches useful precision once registry anchoring and user reports are added. The OKF benchmark (28–46% F1) is for harder multi-hop search, not single-site classification. This must be measured before launch.
6. A DLT-registered SMS provider and Razorpay Subscriptions (UPI AutoPay) are available to a new Indian entity without unusual onboarding delays.

## 12. Open questions (for the author, legal review or later stages)

1. **US customs source:** reseller raw AMS feed or ImportYeti Enterprise API? Compare price, freshness and redistribution rights (OKF Q7).
2. **Indian shipping-bill data** provenance and licensability. This blocks REQ-022 "sources from India" (OKF Q6).
3. **ITC Trade Map / Market Access Map** reuse terms: link-out only or ingestible? (OKF Q5). This affects REQ-011 and coverage for non-customs countries.
4. **Google Places** caching terms (OKF Q12). The current decision is not to use it. Revisit if website-derived phone and address coverage turns out to be poor.
5. **DPDP treatment** of publicly available B2B contact data and of processing foreign individuals' data (OKF Q8). This must be answered before 13 May 2027 and before REQ-035 is enabled.
6. **Trust-level liability wording** (design open question 4). The rollup rules are versioned so wording can change without code changes.
7. **Refund-abuse thresholds** for unconfirmed invalid reports (§3.10): a product and ops decision.
8. **Freshness thresholds** (90-day contact re-verify, 6-month re-crawl): to be set from observed decay and cost data.
9. **Web-discovery accuracy bar**: what precision is needed before a web-found buyer is shown at all, rather than only labelled lower-confidence (REQ-024)? This needs an evaluation set per launch country.
10. **GST invoicing route**: Razorpay-native or a separate GST invoicing provider (for low-level design).
11. Whether an **EPC/EPM partnership** (bulk seats) would require SSO or organisation-level billing sooner, which would bring REQ-063 forward.
