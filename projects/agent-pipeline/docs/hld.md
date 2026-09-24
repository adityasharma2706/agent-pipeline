<!-- Written by: system-design stage (high-level design). Read by: low-level-design. -->

# High-Level Design: Export Buyer Discovery for Indian Exporters

> **Scope:** how the modules in `docs/implementer.md` (`M01`…`M53`) fit together. It covers runtime shape, which module owns which data, the interfaces between modules, key data structures (at the conceptual level), cross-module events, and the main interaction sequences. It does **not** give per-function signatures, table DDL, algorithms or thresholds. Low-level design (LLD) specifies those from this document.
>
> **Inputs:** `docs/design.md` (REQ-001…REQ-066), `docs/architecture.md`, `docs/implementer.md`.
>
> **Conventions**
> - Every interface (`IF-xx`), data structure (`DS-xx`) and event (`EV-xx`) names the module that **owns** it and the modules that **use** it, with module IDs exactly as written in `docs/implementer.md`.
> - Where an interface exists for a specific requirement, the `REQ-` IDs it carries are listed.
> - Field lists in data structures are *conceptual* (what must be representable). LLD decides names, types, keys and indexes.
> - Anything marked **[assumption]** is a decision made here with no human to ask. Section 11 lists them all again.

---

## 1. Design goals carried from architecture

The HLD makes the architecture's drivers enforceable at module boundaries:

| Goal | How this HLD enforces it | Modules |
|---|---|---|
| Every fact has provenance (D1) | Only M09 writes buyer facts. All writers go through `IF-09a AssertionWrite`, which rejects a write that has no source-register entry. | M08, M09 |
| One policy gate on every read (D2) | Serving modules never read buyer read-models directly. They call `IF-10a PolicyGate`, which returns filtered documents plus allowed actions. | M10, all readers |
| Planes stay decoupled | The knowledge and serving planes interact only through **jobs/events** (M02) and **read models** (M09, M14, M15). There are no synchronous cross-plane calls, with one listed exception (§3.4). | M02, M09 |
| Credits are auditable and refundable (D7) | All credit movement goes through `IF-28a Ledger`, using idempotency keys and hold/commit/refund. | M28 |
| Nothing costly or legally sensitive happens without a check | Reveal and draft call the sanctions screener synchronously (`IF-17a`) and the policy gate before acting. | M17, M29, M34 |

---

## 2. System shape

### 2.1 Runtime units

| Runtime unit | Language | What runs in it | Modules hosted |
|---|---|---|---|
| **R1 Web/API monolith** | TypeScript | SSR front end, JSON API, admin console, webhook endpoints | M04, M05, M06, M07, M10 (TS side), M11, M13, M16, M26, M27, M28, M29, M30, M31, M32, M33, M34, M35 (request side), M36, M37, M38 (request side), M40–M52 (serving parts) |
| **R2 Serving workers** | TypeScript | Serving-plane async jobs: exports, data-rights jobs, reminders, notifications, billing reconciliation, reveal-time re-verification orchestration | M35, M38, M41, M36 (reconcile), M30 (refund follow-through), M45 |
| **R3 Knowledge workers** | Python | Connectors, ingestion, entity resolution, classification, discovery, enrichment, trust, coverage, market analytics, projection builder | M08, M09 (write + projection), M12, M14, M15, M17, M18, M19, M20, M21, M22, M23, M24, M25, M53 |
| **R4 Scheduler** | (M02) | Cron triggers that enqueue jobs into R2/R3 queues | M02 |
| **Shared infra** | — | Postgres (`serving`, `knowledge`, `ledger`, `analytics` schemas + pgvector), Redis, S3, secrets, observability | M01 |

**[assumption]** R2 and R1 are the same codebase deployed as two process types. R3 is a separate deployable. M02 gives both languages a client for the same Postgres-backed queue, so jobs can cross planes.

### 2.2 Layering inside the serving monolith (R1/R2)

```
 Layer 4  UI / API routes          M04 shell + page modules (M13, M16, M26, M27, M29–M37, M40–M52)
 Layer 3  Serving domain modules   M07 Workspace · M26 Search · M27 Profile · M29 Reveal · M30 Reports
                                   M32 Check · M33 Pipeline · M34 Drafts · M35 Export · M36 Billing · M41 Notify
 Layer 2  Governance & money       M10 PolicyGate/Suppression · M11 ReviewQueue · M28 Ledger/Prices · M06 Consent
 Layer 1  Platform                 M01 data access/tenancy/cost · M02 jobs/events · M03 LLM · M05 identity
```

Rules:
1. A module may call modules in its own layer or lower layers only. Layer 2 never calls Layer 3. Instead, Layer 3 modules **register providers or handlers** with Layer 2 (see `IF-10b`, `IF-11b`). This keeps the policy layer and review queue generic.
2. **No Layer 3 or 4 module reads `knowledge` schema tables directly.** Buyer data reaches them only as policy-filtered documents from `IF-10a`, which reads M09 read models on their behalf. M14/M15 read models (market stats, coverage) are not buyer data about companies or people, so M16/M26 may read them directly through `IF-14a`/`IF-15a`.
3. Each table has **exactly one owning module**. Other modules use the owner's interface. §4 lists ownership.

### 2.3 Layering inside the knowledge plane (R3)

```
 Sources ─► M08 Connector framework + licence register ─► raw landing (S3)
                 │
                 ├─ M12 HS loaders      M14 Comtrade/FTA        M17 Sanctions lists
                 ├─ M20 Web discovery   M21 US customs          M23 Registries/domain  M53 (later)
                 ▼
          M18 Entity resolution (checks M10 suppression) ─► M19 Classifiers
                 ▼
          M09 Evidence store  (IF-09a AssertionWrite: single write path)
                 │  emits EV-01 EntityChanged
                 ├─► M22 Enrichment (contacts)   ├─► M24 Trust engine   ├─► M17 screening
                 ├─► M09 Projection builder ─► buyer read models (profile doc, search doc)
                 └─► M15 Coverage builder (batched)       M25 Freshness scheduler (periodic)
```

Knowledge modules call each other in-process as Python libraries inside a job, or chain through jobs. Fan-out from `EV-01` is event-driven so that a new consumer (for example M48 similarity) can be added without touching the producers.

---

## 3. Cross-cutting mechanisms

### 3.1 Tenancy and scoping (M01, M07)

- Serving data is scoped by **Account → Workspace**. M01 provides `IF-01a ScopedDataAccess`: every serving query runs with an **actor context** (`DS-01 ActorContext`) and the helper adds account/workspace predicates. Optional Postgres RLS sits underneath. *(REQ-008, REQ-063)*
- **Account-scoped:** ledger, plan/subscription, revealed-contact records, exports, consent, business profile. **Workspace-scoped:** HS code, shortlisted countries, searches, shortlist entries, notes, drafts, reminders. **[assumption]** Credits live at account level. M52 (consultant, per-client credits) will add optional sub-balances keyed by workspace rather than moving the ledger.
- Knowledge data (companies, assertions) is **global and shared across tenants** (the cross-user cache, D5). Per-user views of it (hides, reveals) live in serving tables owned by M30/M29.

### 3.2 Jobs, events and the outbox (M02)

- `IF-02a JobQueue`: enqueue a typed job with an idempotency key, a target queue (serving or knowledge), a vendor rate-limit class and a retry policy. Both languages have a client.
- `IF-02b Schedule`: cron-style registrations, declared by each owning module.
- `IF-02c EventBus`: domain events (`EV-xx`, §6) are written to an **outbox in the same transaction** as the state change. A dispatcher then turns them into jobs for the subscribed handlers. Subscriptions are declared by consumer modules. Delivery is at least once, so handlers must be idempotent.
- Dead-lettered jobs are visible in the M11 console as a system item type **[assumption]**, so failures in refunds and data rights are not lost silently.

### 3.3 Cost metering (M01, M03)

`IF-01b CostMeter` records vendor spend for each call, tagged with job type, account (if any) and credit reference (if any). M03, M08-based connectors, M23, M25 and M36 must call it. M39 builds the cost-per-credit dashboard from this data.

### 3.4 Cross-plane synchronous exceptions

The serving plane may call knowledge-plane logic **synchronously** only in these cases, all bounded by latency targets:

| Exception | Caller | Callee | Why | REQs |
|---|---|---|---|---|
| Sanctions screen on reveal/draft | M29, M34, M32 | M17 via `IF-17a` | Must be current at the moment of action | REQ-029 |
| Ad-hoc trust checks | M32 | M24 via `IF-24b` | Interactive tool | REQ-030 |
| Reveal-time re-verification | M29 | M25 via `IF-25a` (request/await with timeout) | Stale contacts must be re-checked before display | REQ-033, REQ-034 |

**[assumption]** These are exposed as a small **internal HTTP service inside R3** (one "knowledge RPC" endpoint group). They are not called as cross-language libraries. Everything else crosses the planes through M02.

### 3.5 Dual-language modules

M09 (read-model access), M10 (suppression lookups) and M28 (not dual) need care:
- **M09:** writes are Python only (R3). Reads of read models happen in TS, but only inside M10 (`IF-10a`), per rule 2.
- **M10:** policy evaluation is TS (R1/R2). The suppression **lookup** is also needed in Python for ingestion (M18, M20, M21, M22), so M10 ships a thin Python read-only client for `IF-10c SuppressionCheck`. Suppression **writes** are TS only (from M11 outcomes).
- LLD must keep a single source of truth for identifier normalisation (for domain, email, phone and company ID hashing) that both clients share. **[assumption]** This is a spec with shared test vectors, not shared code.

---

## 4. Data ownership map

| Data (conceptual) | Owner | Schema | Written by | Read by |
|---|---|---|---|---|
| Accounts, members, sessions, admin roles | M05 / M07 | serving | M05, M07 | all serving modules via `DS-01` |
| Business profile, workspaces, workspace defaults | M07 | serving | M07, M13 (HS code), M16 (country shortlist), M40 | M13, M16, M26, M33, M34, M38 |
| Consent ledger, notice versions | M06 | serving | M06 | M38, M50 |
| Source licence register | M08 | knowledge | M08 (operator config) | M09 (flag inheritance), M10 (licence rules), M35 |
| Raw landing objects | M08 | S3 | connectors (M12, M14, M17, M20, M21, M23, M53) | same connectors (reprocessing) |
| Companies, assertions, negative assertions | M09 | knowledge | **only via `IF-09a`** (M18–M25, M17 flags, M53; serving-originated commands via `IF-09b`) | M10, M15, M24, M25, projection builder |
| Buyer read models (profile doc, search doc) | M09 | knowledge | M09 projection builder | **M10 only** (on behalf of M26, M27, M29, M34, M35, M41, M45, M48) |
| Global suppression list | M10 | knowledge **[assumption]** | M10 (triggered by M11 outcomes) | M10 (TS), M18/M20/M21/M22 (Python client) |
| Per-user hides | M30 | serving | M30 | M10 (as a registered provider) |
| Review items, outcomes, audit trail | M11 | serving | M11 (items filed by M17, M18, M30, M31, M36, M43, M47) | M11 |
| HS nomenclature, correlations, ITC-HS policy, embeddings | M12 | knowledge | M12 | M13, M14, M37, M40 |
| Market stats, rankings, FTA table, "why" summaries | M14 | analytics (read model in knowledge) | M14 | M16 via `IF-14a` |
| Coverage matrix | M15 | knowledge | M15 | M16, M26 via `IF-15a` |
| Sanctions lists, screening results, `sanctions_block` flags | M17 | knowledge | M17 (+ M11 outcome via `IF-09b`) | M10, M24 |
| Shipment raw/parquet | M21 | S3 / analytics | M21 | M21 only (aggregates go to M09) |
| Trust results (per entity, rule-versioned) | M24 | knowledge | M24 | projection builder (M09) |
| Ledger entries, holds, balances | M28 | ledger | **only via `IF-28a`** | M28 (balance/history), M41, M39 |
| Price catalogue, plan allowances | M28 (catalogue), M36 (plans) | config + serving | operator / M36 | M04 cost badge, M29, M32, M35, M37 |
| Revealed-contact records | M29 | serving | M29 | M35, M34 (contact availability), M38 |
| Check-a-buyer results | M32 | serving | M32 | M32, M38 |
| Shortlist entries, statuses, notes | M33 | serving | M33 | M34, M35, M41, M44, M38 |
| Drafts, thread context | M34 | serving | M34, M42 | M42, M38 |
| Export jobs and files | M35 | serving + S3 | M35 | M35 (download), M38 |
| Subscriptions, payments, invoices, entitlements | M36 | serving + S3 (PDFs) | M36 (webhooks only for entitlement changes) | M10 (entitlement provider), M28 (grants), M43 |
| Content / Learn / promise pages | M37 | repo/CMS | operator | M04, M13, M24 (wording), M32, M34 (guidance) |
| Reminders, notifications, dashboard read model | M41 | serving | M41 | M41 |
| Outcome events | M44 | analytics | M44 | analytics |
| Saved searches, alert hits | M45 | serving | M45 | M41 |

---

## 5. Key data structures (conceptual)

### DS-01 ActorContext — owner M01 (populated by M05, M07, M36)
Who is acting and with what rights. It is passed through every serving call.
- actor kind: anonymous visitor / user / admin / system job
- account id, member id, current workspace id (if any)
- plan and entitlements snapshot (from M36; default Free until M36 exists, from M28 allowance config)
- locale, region (for gating)
- anonymous session id and rate-limit bucket (M05)
*(REQ-004, REQ-008, REQ-051, REQ-063)*

### DS-02 SourceRegisterEntry — owner M08
- source id, source type (customs / website / directory / registry / sanctions / market-stats / nomenclature / user report / operator)
- licence flags: can_store, can_display, can_export, retention_days, attribution_text
- personal_data_class ceiling, allowed_regions
- status (active / disabled / prohibited). LinkedIn-class sources exist only as `prohibited` so the prohibition is explicit.
*(REQ-036, REQ-033, REQ-048)*

### DS-03 Company (canonical entity) — owner M09
- stable company id; lifecycle (active / merged-into / closed)
- anchors: registry ids, LEI, VAT, primary domain (all as assertions, with anchors indexed)
- merge lineage (so reports and pipeline rows that point to merged ids keep resolving)

### DS-04 Assertion — owner M09
The single representation of every buyer and contact fact.
- subject (company id; later person id for `named_person`), attribute (from a controlled vocabulary per module: product-evidence, buyer-type, activity-aggregate, contact-*, registry-*, domain-*, logistics-flag, sanctions-flag, trust-check-*…), value (structured)
- polarity (positive / negative, e.g. "email invalid")
- source id → DS-02, source type, source reference (URL + capture date, shipment batch id, registry record id, report id)
- observed_at, checked_at, confidence
- inherited licence flags, personal_data_class, region
- producer module id and producer version (for audit and reprocessing)
*(REQ-017, REQ-024, REQ-033, REQ-036)*

**Rule (M09, M20):** an assertion produced with LLM help must carry a source reference to the captured page. `IF-09a` rejects LLM-derived assertions that have no page reference. *(REQ-017, REQ-024)*

### DS-05 Buyer read models — owner M09 (shape agreed with M26/M27)
- **SearchDoc** (one per company × HS heading with evidence): name, city/country, buyer type + confidence, evidence summary + strongest source type, latest activity, trust level, contact types available, shipment frequency/volume (if any), India/competitor origin flags (if any), logistics flag, text fields for keyword search, plus ids of the underlying assertions (so M10 can apply per-fact licence and suppression rules).
- **ProfileDoc** (one per company): overview, evidence list (source type, what it says, last seen/checked), activity summary, sourcing (REQ-022), website, trust checklist (DS-08), contact slots (type, source, checked_at, deliverability status, **with values held back**; values are released only through M29).
- Both carry a projection version and `built_at`. They are rebuilt from `EV-01`.
*(REQ-016, REQ-017, REQ-021, REQ-022, REQ-024, REQ-027, REQ-032, REQ-033)*

### DS-06 SuppressionEntry — owner M10
- normalised and hashed identifier (kind: domain / email / phone / company id / registry id)
- scope (global; **[assumption]** there is no partial scope in the MVP), reason (removal request / confirmed invalid / operator), review item id, created_at
*(REQ-037)*

### DS-07 PolicyDecision — owner M10
Returned for each document or entity by `IF-10a`:
- visibility: hidden / visible / visible-with-warning (sanctions)
- allowed actions: {view, reveal, draft, export, notify}
- field redactions (licence display/export, region/personal-data gating)
- reason codes (for UI explanation and audit, e.g. `SANCTIONS_BLOCK`, `USER_HIDDEN`, `PLAN_LIMIT`, `LOGISTICS_DEFAULT_HIDDEN`)
- plan limit metadata (for example "20 of 143 shown on Free")
*(REQ-020, REQ-025, REQ-029, REQ-036, REQ-037, REQ-048, REQ-051)*

### DS-08 TrustResult — owner M24
- subject (company id, or an ad-hoc input hash for M32)
- checks: list of {check id, outcome pass/fail/unknown, checked_at, supporting assertion ref, explanation key}
- rollup level High/Medium/Low/Unknown, rule-set version, wording-copy version (M37)
- red flags (M32 rules engine output, when there are any)
*(REQ-027, REQ-028, REQ-030, REQ-031)*

### DS-09 CoverageCell — owner M15
- country, HS heading (or a country-level fallback row)
- source types present, company counts, freshness stats
- label Strong/Partial/Limited, explanation template key + parameters, rule version, computed_at
*(REQ-012)*

### DS-10 MarketRow — owner M14
- country × HS6: import value, growth, India share, top supplier countries, FTA flag + agreement ref, "why" summary (cached LLM text + input snapshot hash), data year/version
*(REQ-010, REQ-011, REQ-013)*

### DS-11 HsCode — owner M12
- code, level (chapter/heading/subheading/ITC-HS 8-digit), nomenclature version, descriptions, parent
- ITC-HS export policy status + official source link (8-digit only)
- correlation links across versions
*(REQ-005, REQ-006, REQ-007, REQ-009)*

### DS-12 LedgerEntry / Hold — owner M28
- account id, entry type (grant / top-up / hold / commit / release / debit / refund / expiry / adjustment), credits (signed, double-entry pair), action type + action reference (reveal id, check id, export id), price-catalogue version, idempotency key, `refers_to` (a refund or commit points to its hold or debit), created_at
- A hold has a TTL. An expired hold releases itself.
*(REQ-034, REQ-054, REQ-056)*

### DS-13 PriceCatalogue — owner M28
- action → credits, optional country multipliers, catalogue version, effective dates. It is the **single source** for the M04 cost badge, the M37 public pages and M28 debits.
*(REQ-054, REQ-066)*

### DS-14 ReviewItem — owner M11
- item type (registered by the owning module), subject refs, payload, filed_by (user / system / public requester), SLA timestamps, state, outcome, outcome handler result, audit trail
*(REQ-064)*

### DS-15 ShortlistEntry — owner M33
- workspace id, company id (following merges), status, status history, notes, next-action reminder ref (M41), created_at
*(REQ-045, REQ-046, REQ-047)*

### DS-16 Draft — owner M34
- workspace id, shortlist entry id, kind (first / follow-up n / WhatsApp intro), language, tone, generated body, **code-assembled footer** (sender identity, business details, opt-out line, EU/UK source-disclosure), user edits, model id, created_at, left-product-at (copy/mailto clicked)
*(REQ-038, REQ-039, REQ-040, REQ-041)*

### DS-17 RevealRecord — owner M29
- account id, company id, contact assertion ids revealed with the values *as shown*, deliverability status at reveal time, ledger hold/commit refs, revealed_at
- It is the basis for export eligibility (M35) and for automatic refunds (M30).
*(REQ-034, REQ-048)*

### DS-18 JobEnvelope / DomainEvent — owner M02
- type, payload version, idempotency key, correlation id (links a user action to all its downstream jobs, for cost and audit), actor ref, attempt metadata

---

## 6. Domain events

All events use `IF-02c` (outbox → jobs). Consumers must be idempotent.

| Event | Producer | Consumers | Purpose | REQs |
|---|---|---|---|---|
| **EV-01 EntityChanged** (company id, changed attribute classes) | M09 | M09 projection builder, M24 (if trust inputs changed), M17 (new name/anchor), M22 (new domain), M15 (batched mark-dirty), M45 (later), M48 (later) | Keep read models, trust and coverage in sync | REQ-012, REQ-016, REQ-027 |
| **EV-02 SanctionsListUpdated** | M17 | M17 (full re-screen job) | Re-screen every entity after a list changes | REQ-029 |
| **EV-03 SanctionsFlagChanged** | M17 (and M11 outcome) | M09 projection builder, M10 cache invalidation | Block or unblock across all surfaces | REQ-029 |
| **EV-04 SuppressionAdded** | M10 | M09 (purge read models for matching entities), M26 search doc removal, M35 (cancel pending exports that contain them) | No window in which suppressed data is visible | REQ-037 |
| **EV-05 DiscoveryCompleted** (country × HS, new company count) | M20 | M15 (recompute cell), M26 (live results update), M41 (notify requester, once M41 exists) | Cold-search completion | REQ-015, REQ-026 |
| **EV-06 ContactVerified / ContactInvalidated** (assertion id, outcome, trigger ref) | M25 | M30 (refund decision), M09 (negative assertion already written), M29 (awaiting reveal) | Automatic refund path | REQ-033, REQ-034 |
| **EV-07 ReviewOutcome** (item type, outcome) | M11 | handler of the module that registered the item type (M17, M18, M30, M31, M36, M43, M47) | Close loops through the owners' write paths | REQ-064 |
| **EV-08 PipelineStatusChanged** | M33 | M44 (outcome events), M41 (dashboard), M42 (follow-up timing) | Metrics and reminders | REQ-046, REQ-050 |
| **EV-09 DraftLeftProduct** (copy/mailto/wa.me) | M34 | M33 (auto-set status to Contacted), M41 | Flow 1 step 8 | REQ-040, REQ-046 |
| **EV-10 PaymentVerified / SubscriptionChanged** | M36 (webhook handler, after signature and idempotency checks) | M28 (grants, top-ups), M10 entitlement cache, M41 | Entitlements come only from verified payments | REQ-052, REQ-053 |
| **EV-11 ConsentWithdrawn / DataRightsRequested** | M06 / M38 | every registered data-rights contributor (see `IF-38a`) | Rights actions across all schemas | REQ-061 |
| **EV-12 NomenclatureVersionLoaded** | M12 | M40 (flag workspaces), M14 (re-key stats) | HS 2027 handling | REQ-009 |
| **EV-13 ReportFiled** | M30 | M25 (re-verify contact), M11 (content reports) | Report flow | REQ-025 |

---

## 7. Interface catalogue

"Style": **lib** = in-process call inside the same runtime · **rpc** = internal synchronous call across runtimes (§3.4 only) · **job** = enqueue through M02 · **event** = subscribe through `IF-02c` · **read** = read-model query · **http** = public or external HTTP endpoint.

### 7.1 Platform (Phase 0)

| IF | Owner | Users | Style | Purpose | REQs |
|---|---|---|---|---|---|
| IF-01a ScopedDataAccess | M01 | all serving modules | lib | Runs queries under DS-01 with tenant predicates | REQ-008, REQ-063 |
| IF-01b CostMeter | M01 | M03, M08 connectors, M20–M23, M25, M36 | lib | Records vendor spend per job, account and credit | enabling (REQ-052/054 pricing from data) |
| IF-01c Observability | M01 | all | lib | Logs and traces carrying a correlation id | — |
| IF-02a JobQueue | M02 | all async producers | lib (TS + Py) | Typed, idempotent jobs with rate-limit classes | enabling REQ-026, 034, 047, 061 |
| IF-02b Schedule | M02 | M14, M15, M17, M20, M21, M25, M36, M41, M45 | lib | Cron registrations | enabling |
| IF-02c EventBus (outbox) | M02 | all producers and consumers in §6 | event | Transactional events | enabling |
| IF-03a LlmComplete / LlmStream | M03 | M13, M14, M19, M20, M34, M42, M49 | lib (TS + Py) | Tiered model call, cache key, personal-data-free logging, cost via IF-01b | REQ-005, REQ-013, REQ-038, REQ-015/016/024 |
| IF-04a UI kit incl. CostBadge, TrustChecklist, CoverageLabel, Disclaimer | M04 | all page modules | lib | Consistent wording and cost display; CostBadge takes its price from IF-28c | REQ-054, REQ-057, REQ-058, REQ-012, REQ-028 |

### 7.2 Accounts (Phase 1)

| IF | Owner | Users | Style | Purpose | REQs |
|---|---|---|---|---|---|
| IF-05a OtpAuth | M05 | M04 pages | http | Request and verify OTP (SMS via DLT provider, email via ESP); create session | REQ-001 |
| IF-05b SessionResolve | M05 | R1 middleware | lib | Builds DS-01 from a user or anonymous session; admin MFA state | REQ-001, REQ-004 |
| IF-05c AnonymousGuard | M05 | M13, M16, M26 (preview), M31, M32 | lib | Per-IP/device rate limits and bot challenge for anonymous or public use | REQ-004, REQ-051 |
| IF-06a Consent | M06 | M05 signup, M38, M50 | lib | Record or withdraw consent against a notice version; query current consent | REQ-062, REQ-061 |
| IF-07a Workspace | M07 | M13, M16, M26, M33, M34, M40 | lib | CRUD on workspaces; get/set HS code (with version) and country shortlist defaults | REQ-008, REQ-014 |
| IF-07b BusinessProfile | M07 | M34, M42, M47, M49 | lib | Read the sender identity and business details used in drafts and footers | REQ-002, REQ-039 |

### 7.3 Knowledge core and governance (Phase 2)

| IF | Owner | Users | Style | Purpose | REQs |
|---|---|---|---|---|---|
| IF-08a SourceRegistry | M08 | M09, M10, M35, all connectors | lib (Py; TS read-only) | Look up DS-02; a connector refuses to start with no active entry | REQ-036, REQ-048 |
| IF-08b ConnectorBase + RawLanding | M08 | M12, M14, M17, M20, M21, M23, M53 | lib (Py) | Fetch → immutable dated S3 object → parse hook; retention lifecycle | REQ-036 |
| IF-09a AssertionWrite | M09 | M17, M18, M19, M20, M21, M22, M23, M24, M25, M53 | lib (Py) | Upsert/negate assertions with provenance; inherits licence flags; checks suppression through IF-10c; emits EV-01 | REQ-017, REQ-024, REQ-033, REQ-036, REQ-037 |
| IF-09b AssertionCommand | M09 | M11 outcome handlers, M30, M31 (corrections) | job | Serving-originated facts (user reports, operator corrections, confirmed merges, sanctions decisions) queued to R3 and applied through IF-09a | REQ-025, REQ-037, REQ-064 |
| IF-09c EntityQuery | M09 | M15, M17, M18, M22, M24, M25 | lib (Py) | Read assertions by subject, attribute, staleness or anchor | — |
| IF-09d ReadModelStore | M09 | **M10 only** | read | Fetch SearchDoc/ProfileDoc sets and run the search query primitives defined with M26 | REQ-016, REQ-021 |
| IF-10a PolicyGate | M10 | M26, M27, M29, M32 (catalogue match), M34, M35, M41, M45, M48 | lib (TS) | Given DS-01 + surface + a query or ids → policy-filtered docs + DS-07 per doc. Rules run in the architecture order (§3.8). | REQ-020, REQ-025, REQ-029, REQ-036, REQ-037, REQ-048, REQ-051 |
| IF-10b PolicyProviders (registration) | M10 | M17 (sanctions flag), M19 (logistics flag, via read-model field), M30 (user hides), M28/M36 (entitlements) | lib | Lets higher modules plug in rule inputs without M10 depending on them. Stubs return "no restriction" / Free defaults until the provider exists. | REQ-020, REQ-025, REQ-029, REQ-051 |
| IF-10c SuppressionCheck | M10 | M18, M20, M21, M22 (Py client); M10 itself | lib | Is this identifier suppressed? | REQ-037 |
| IF-10d Suppress | M10 | M11 outcome handlers (M31 removal, M30 confirmed invalid if chosen) | lib (TS) | Add DS-06; emit EV-04 in the same transaction | REQ-037 |
| IF-11a ReviewQueue.file | M11 | M17, M18, M30, M31, M36, M43, M47, M02 (dead letters) | lib / job | File a typed DS-14 item | REQ-064 |
| IF-11b ReviewQueue.registerType | M11 | same modules as above | lib | Register the item type's schema, console view and **outcome handler** (runs on EV-07 in the owning module) | REQ-064 |

### 7.4 Product and markets (Phase 3)

| IF | Owner | Users | Style | Purpose | REQs |
|---|---|---|---|---|---|
| IF-12a HsCatalogue | M12 | M13, M14, M37, M40 | read | Hierarchy browse, code lookup (version-aware), policy status, vector search over descriptions | REQ-005, REQ-006, REQ-007 |
| IF-12b HsCorrelation | M12 | M40, M14 | read | Map codes between nomenclature versions | REQ-009 |
| IF-13a HsSuggest | M13 | M04 pages, M16 | http | Free text → candidates with confidence and explanations (vector search + IF-03a rerank); anonymous via IF-05c | REQ-004, REQ-005 |
| IF-14a MarketStats | M14 | M16 | read | Ranked DS-10 rows for an HS code | REQ-010, REQ-011, REQ-013 |
| IF-15a Coverage | M15 | M16, M26, M37 (coverage page) | read | DS-09 for (country, HS heading) with country fallback | REQ-012 |
| IF-16a MarketFinder | M16 | M04 pages | http | Ranking + coverage + shortlist countries (writes through IF-07a) | REQ-010–014, REQ-004 |

### 7.5 Buyer knowledge acquisition (Phase 4, R3)

| IF | Owner | Users | Style | Purpose | REQs |
|---|---|---|---|---|---|
| IF-17a SanctionsScreen | M17 | M29, M34, M32 (rpc); M24, M18 pipeline (lib) | rpc / lib | Screen an entity or a free-text name → clear / possible / confirmed hit | REQ-029 |
| IF-18a Resolve | M18 | M20, M21, M23, M53 | lib | Candidate record → existing or new company id + confidence; low-confidence merges filed with M11 | REQ-021, REQ-064 |
| IF-19a Classify | M19 | M20, M21, M53 | lib | Logistics flag and buyer type with evidence | REQ-016, REQ-020 |
| IF-20a DiscoveryRequest | M20 | M26 (cold search), M02 schedule (pre-warm) | job | Discover buyers for (HS heading, country); dedupe in-flight requests per key; EV-05 on completion | REQ-015, REQ-024 |
| IF-21a CustomsIngest | M21 | M02 schedule | job | Weekly batch → aggregates as assertions | REQ-018, REQ-019, REQ-021, REQ-022 |
| IF-22a EnrichContacts | M22 | EV-01 handler, M25 | job | Domain → role contacts and contact-type availability | REQ-016, REQ-032, REQ-033 |
| IF-23a RegistryLookup / DomainSignals | M23 | M18 (anchors), M24, M32 (via M24) | lib (cached) | Registry match, domain age, MX, free-mail classification | REQ-027, REQ-030 |
| IF-24a TrustEvaluate(entity) | M24 | EV-01 handler | job | Produce DS-08 for a catalogue company; stored as assertions and projected | REQ-027, REQ-028 |
| IF-24b TrustEvaluate(ad-hoc) | M24 | M32 | rpc | DS-08 for free-text input, without writing to the catalogue | REQ-030 |
| IF-25a Reverify | M25 | M29 (rpc await with timeout), M30 (job) | rpc / job | Re-check the given contact assertions; writes the outcome and emits EV-06 | REQ-033, REQ-034 |

### 7.6 Buyer serving, credits and trust (Phase 5)

| IF | Owner | Users | Style | Purpose | REQs |
|---|---|---|---|---|---|
| IF-26a BuyerSearch | M26 | M04 pages, M35 (search export), M45 | http / lib | Query (HS/keyword, countries, filters, sort, logistics toggle) → IF-10a → rows + coverage + "finding more" state (starts IF-20a); anonymous preview mode | REQ-004, REQ-012, REQ-015, REQ-016, REQ-018, REQ-019, REQ-020, REQ-024, REQ-051 |
| IF-27a BuyerProfile | M27 | M04 pages, M33, M34 | http / lib | ProfileDoc through IF-10a, with DS-07 driving warnings and enabled actions | REQ-017, REQ-021, REQ-022, REQ-027, REQ-028, REQ-029 |
| IF-28a Ledger | M28 | M29, M30, M32, M35, M36, M43, M46 | lib | `quote` → `hold` → `commit`/`release`; `refund(ref)`; `grant`; `balance`; all idempotent (DS-12) | REQ-034, REQ-054, REQ-056 |
| IF-28b Allowances | M28 | M29, M32, M35, M10 (entitlement provider) | lib | Monthly free and plan allowances remaining | REQ-051 |
| IF-28c PriceCatalogue | M28 | M04 CostBadge, M37, M29, M32, M35 | lib / read | DS-13 lookup with version | REQ-054, REQ-066 |
| IF-29a Reveal | M29 | M04 pages, M33 (bulk from shortlist) | http | Single or bulk reveal following the §8.2 sequence | REQ-029, REQ-032, REQ-033, REQ-034, REQ-054 |
| IF-29b RevealedContacts | M29 | M35, M34, M38 | lib | Which values this account has revealed | REQ-048 |
| IF-30a Report | M30 | M04 pages | http | File a report; immediate per-user hide; emits EV-13 | REQ-025 |
| IF-30b UserHideProvider | M30 | M10 (via IF-10b) | lib | Per-account hidden companies and contacts | REQ-025 |
| IF-31a PublicRemovalForm | M31 | public | http | Removal or correction request + email verification → M11 item | REQ-037 |
| IF-32a CheckBuyer | M32 | M04 pages | http | Free-text → IF-24b + IF-17a + red-flag rules → DS-08 + advice; metered via IF-28b/28a | REQ-030, REQ-031, REQ-051 |
| IF-32b RedFlagRules | M32 | M27 (contextual red flags), M37 (guide references) | lib | Scam-pattern rules shared between the tool and the profile | REQ-031 |

### 7.7 Outreach, pipeline and commerce (Phases 6–7)

| IF | Owner | Users | Style | Purpose | REQs |
|---|---|---|---|---|---|
| IF-33a Pipeline | M33 | M04 pages, M34, M35, M41, M42 | lib / http | Shortlist add (single/bulk), status change (emits EV-08), notes, the "My buyers" cross-workspace view | REQ-045, REQ-046, REQ-047 |
| IF-34a DraftGenerate | M34 | M04 pages, M42 | http (streamed) | Policy check (IF-10a `draft` action) + IF-17a → IF-03a stream → footer from IF-34b → DS-16 | REQ-029, REQ-038, REQ-040 |
| IF-34b ComplianceFooter | M34 | M34, M42, M49 | lib | Deterministic footer from IF-07b + the source types behind the buyer's evidence + recipient region | REQ-039 |
| IF-34c DraftHandoff | M34 | M04 pages | http | Records copy/mailto/wa.me handoff → EV-09 | REQ-040 |
| IF-35a Export | M35 | M04 pages | job | Shortlist or search export → IF-10a (`export` surface) + IF-29b → file in S3 with watermark → download link; plan caps | REQ-048 |
| IF-36a Checkout / ManageSubscription | M36 | M04 pages | http | Plans in INR, Razorpay subscription creation, payment method update, cancellation | REQ-052, REQ-053 |
| IF-36b RazorpayWebhook | M36 | Razorpay | http | Signature check + idempotency → EV-10; the only path that changes entitlements | REQ-053 |
| IF-36c EntitlementProvider | M36 | M10 (via IF-10b), DS-01 build | lib | Current plan limits per account | REQ-051, REQ-052 |
| IF-36d Invoices | M36 | M04 pages, M38 | http | GST invoice PDFs and GSTIN capture | REQ-053 |
| IF-37a Content | M37 | M04, M13 (disclaimer), M24 (wording keys), M32, M34 (guidance) | read | Versioned, localisable content by key, HS chapter and sector | REQ-028, REQ-031, REQ-044, REQ-059, REQ-065, REQ-066 |
| IF-38a DataRightsContributor (registration) | M38 | M05, M06, M07, M28, M29, M30, M32, M33, M34, M35, M36, M41, M45, M50, M52 | lib | Each module that holds user data registers `export(account)` and `erase(account)` with its retention rules. M38 fans out on EV-11. | REQ-061 |
| IF-38b DataRightsRequest | M38 | M04 pages | http | View, download, delete, withdraw consent | REQ-061 |

### 7.8 Should / Could extensions (Phases 8–9)

| IF | Owner | Users | Style | Purpose | REQs |
|---|---|---|---|---|---|
| IF-40a ReconfirmHs | M40 | M04 pages, M13 | http | Lists flagged workspaces; re-confirm through IF-07a | REQ-009 |
| IF-41a Reminders | M41 | M33, M42 | lib | Create, snooze or complete reminders; scheduler fires them | REQ-047 |
| IF-41b Notify | M41 | M41, M45, M20 (via EV-05), M31 (requester confirmation, see §11) | lib | In-app + email (+ WhatsApp via M50); content checked through IF-10a `notify` | REQ-026, REQ-047, REQ-060 |
| IF-41c Dashboard | M41 | M04 pages | read | Pipeline counts, reminders due, saved-search hits, balance (from IF-28a) | REQ-049 |
| IF-42a FollowUpDraft | M42 | M04 pages | http | Uses DS-16 thread context + IF-34b + IF-41a | REQ-041 |
| IF-43a MoneyBackRequest | M43 | M04 pages | http | Window check → M11 item → outcome: Razorpay refund via M36 + ledger adjustment via IF-28a | REQ-055 |
| IF-44a OutcomeSink | M44 | EV-08 | event | Append outcome events to analytics | REQ-050 |
| IF-45a SavedSearch | M45 | M04 pages | http / job | Store an IF-26a query; scheduled re-run through IF-10a; hits → IF-41b | REQ-026 |
| IF-46a TopUp | M46 | M04 pages | http | Razorpay order → webhook → IF-28a grant(top-up) | REQ-056 |
| IF-47a IecVerify | M47 | M04 pages | http / job | DGFT lookup or M11 manual item; badge flag on the profile, read by IF-34b | REQ-003 |
| IF-48a SimilarBuyers | M48 | M27 | lib | pgvector neighbours on read models via IF-10a | REQ-023 |
| IF-49a WhatsAppIntro / OnePager | M49 | M04 pages, M34 | lib / http | `wa.me` link text; reusable intro content that drafts can use | REQ-042, REQ-043 |
| IF-50a WhatsAppChannel | M50 | M41 | lib | BSP template send for opted-in users (consent via IF-06a) | REQ-060 |
| IF-51 (none) | M51 | — | — | Adds locale bundles to M04 i18n and localised content to M37; no new interface | REQ-058 |
| IF-52a Membership | M52 | M01 (DS-01), M07 | lib | Members, roles, invitations, consultant multi-account switching; extends DS-01 with role | REQ-063 |
| IF-53 (reuses IF-08b, IF-18a, IF-19a, IF-09a) | M53 | — | — | New connectors plug into the existing pipeline | REQ-015, REQ-018, REQ-022 |

---

## 8. Key interaction sequences

Each sequence names the module doing each step. LLD specifies the error paths in detail. This section fixes the order and who is responsible for what.

### 8.1 Anonymous try → signup (Flow 1, steps 1–5)
1. M04 page → **M13** `IF-13a` (guarded by M05 `IF-05c`) → M12 vector search → M03 rerank → candidates. *(REQ-004, REQ-005)*
2. The visitor picks a code. It is held in the anonymous session (M05), because no workspace exists yet.
3. **M16** `IF-16a` → M14 `IF-14a` + M15 `IF-15a` → ranked countries with coverage labels. *(REQ-010, REQ-012)*
4. The visitor picks countries → **M26** `IF-26a` in preview mode → M10 applies an `anonymous` entitlement (count + first N names + trust summary) → signup gate. *(REQ-004, REQ-051)*
5. **M05** OTP → **M06** consent → **M07** onboarding. The anonymous session's HS code and countries **are carried into the new workspace** by M07. **[assumption]** *(REQ-001, REQ-002, REQ-062)*

### 8.2 Contact reveal (M29)
```
UI (CostBadge from IF-28c) → user confirms
M29 → M10 IF-10a(surface=reveal)          ── deny if suppressed / sanctions / plan
M29 → M28 IF-28a.hold(idempotency=reveal id)
M29 → M17 IF-17a (rpc)                     ── hit ⇒ release hold, file M11 item if "possible", deny
M29 → M09 read (via M10) contact slots; for each stale slot → M25 IF-25a (rpc, bounded wait)
        timeout ⇒ show value marked "stale / unknown deliverability" (REQ-033, degraded mode)
M29 → write DS-17 RevealRecord → M28 IF-28a.commit(hold)
return values + deliverability status
```
- Bulk reveal = one confirmation, one hold for the total, and a commit per buyer. Buyers that fail are released individually. *(REQ-034, REQ-054)*
- **[assumption]** One reveal = one buyer's full set of company-level contacts for one credit-priced action (the price comes from DS-13, not from this document).

### 8.3 Report and automatic refund (M30)
1. `IF-30a` → per-user hide row (M30) → effective at once through `IF-10b`. EV-13.
2. Contact reports: M25 re-verify job → EV-06.
   - **Invalid confirmed:** M25 writes a negative assertion (EV-01 → projections exclude it for everyone). M30 finds the matching DS-17 and calls `IF-28a.refund(ref=commit)`, idempotent per (reveal, contact). The user is notified.
   - **Not confirmed:** M30 applies the per-user monthly cap. Under the cap → refund. Over the cap → M11 item.
3. Content reports ("not a buyer", "suspicious", "closed", "wrong product") → M11 item. The outcome handler (owned by M30) issues an `IF-09b` AssertionCommand (for example `not_buyer_for(HS)`, `closed`), and M09 applies it globally. *(REQ-025, REQ-034, REQ-064)*

### 8.4 Removal request (M31)
Public form (`IF-31a`, guarded by `IF-05c`) → email verification → M11 item → operator approves → M31 outcome handler → M10 `IF-10d Suppress` (DS-06 + EV-04 in one transaction) → M09 purges and rebuilds read models → confirmation email to the requester through the transactional ESP. From then on, ingestion (M18/M20/M21/M22) skips matching records via `IF-10c`. Corrections instead issue `IF-09b` with source type `operator`. *(REQ-037, REQ-064)*

### 8.5 Web discovery, cold search (M26 → M20)
M26 sees DS-09 with few or no results for (country, heading) → `IF-20a` (deduplicated by key) → UI shows "finding more buyers…" → M20: search API → crawl (M08 raw landing) → IF-10c → M03 classify/extract → M18 resolve → M19 classify → M09 `IF-09a` (evidence assertions with page refs) → EV-01 fan-out (M22 contacts, M23/M24 trust, M17 screen, projections) → EV-05 → M15 recompute cell, M26 refreshes the result set (polling or push **[assumption]**: polling in the MVP, push later via M41). *(REQ-012, REQ-015, REQ-017, REQ-024)*

### 8.6 Batch customs ingestion (M21)
Schedule → M08 raw landing → Parquet → per-company × heading aggregates → IF-10c → M18 → M19 (forwarder filter) → `IF-09a` aggregate assertions → EV-01 fan-out → M15 batch recompute at the end of the run. *(REQ-018, REQ-019, REQ-021, REQ-022)*

### 8.7 Draft (M34)
`IF-34a` → M27 profile via M10 (surface=`draft`; deny on sanctions or suppression) → M17 `IF-17a` → prompt built from M07 `IF-07b` + **company-level** evidence only → M03 stream → `IF-34b` footer appended in code (never produced by the LLM) → DS-16 stored → user copies or opens mailto → `IF-34c` → EV-09 → M33 sets "Contacted". *(REQ-029, REQ-038, REQ-039, REQ-040, REQ-046)*

### 8.8 Payment (M36)
Checkout (`IF-36a`) → Razorpay → webhook `IF-36b` (signature + idempotency) → subscription state → EV-10 → M28 `grant` for the period, M10 entitlement cache refresh. A daily reconcile job compares against Razorpay and files M11 items for mismatches. Client-side "success" redirects never change entitlements. *(REQ-052, REQ-053, REQ-054)*

### 8.9 Data rights (M38)
`IF-38b` → EV-11 → each `IF-38a` contributor runs `export` or `erase` as a job → M38 assembles the archive (S3, time-limited link) or confirms deletion. The ledger (M28) and invoices (M36) keep records for their legal retention period with personal fields minimised, as each contributor declares. Consent withdrawal goes through M06, and the contributors that depend on consent (M41 email, M50 WhatsApp) stop at once. *(REQ-061, REQ-062)*

### 8.10 Sanctions list change (M17)
Daily fetch → diff → EV-02 → full re-screen job (batched through M09 `IF-09c`) → changed flags written via `IF-09a` → EV-03 → projections + M10 cache invalidation → possible matches → M11 items. The owning handler (M17) writes the confirmed or cleared decision through `IF-09b`. *(REQ-029, REQ-064)*

---

## 9. Policy layer composition (M10)

M10 is the most-shared component, so its boundaries are fixed here:

- **Inputs:** DS-01, a **surface** (`search`, `profile`, `reveal`, `draft`, `export`, `notify`, `alert`, `similar`), and either a query (delegated to `IF-09d`) or a set of company ids.
- **Rule pipeline (fixed order, per architecture §3.8):**
  1. Global suppression (DS-06), matched against the identifiers carried in the read model → hidden.
  2. Sanctions flag (provider: M17) → visible-with-warning; reveal, draft, export and notify are removed from allowed actions.
  3. Licence flags (from DS-02 via the assertion ids in the doc) → field redaction per surface (display vs export).
  4. Region / personal-data gating → redact the `named_person` class (always in the MVP) and apply region rules.
  5. Logistics default-hide (field from M19 via the read model) → hidden unless the query sets the toggle.
  6. Per-user hides (provider: M30).
  7. Plan entitlements (provider: M36, with M28 allowances as the fallback) → result caps and action availability.
- **Outputs:** filtered docs + DS-07 per doc + aggregate plan-limit metadata.
- **Caching:** M10 may cache suppression and sanctions state in Redis. EV-03/EV-04 invalidate it. **Correctness must not depend on the cache**: suppression is also applied at read-model purge time (EV-04).
- **Not M10's job:** pricing (M28), deciding what counts as stale (M25), trust rollup (M24).

---

## 10. Non-functional allocation to modules

| Target (architecture §7) | Modules responsible | HLD notes |
|---|---|---|
| Search p95 < 1.5 s | M26, M09 (read model design), M10 | M10 filtering must be set-based in the query, not per-row calls. The SearchDoc carries the flags M10 needs. |
| Reveal < 3 s fresh / < 15 s re-verify | M29, M25, M17 | The rpc budget is split: sanctions screen is short. Re-verify has a bounded wait, then degrades to "unknown". |
| Draft < 10 s streamed | M34, M03 | Stream tokens. The footer is appended after the stream ends. |
| Knowledge lag ≤ 24 h tolerated | M02, R3 modules | Serving never blocks on R3 except in the §3.4 exceptions. |
| Vendor outage degradation | M08 connectors, M23, M25, M03 | Each returns an explicit "unknown / unavailable" result that downstream code turns into "unknown" checks or stale labels. |
| Cost observability | M01 `IF-01b`, M02 correlation ids | Every vendor call is traceable to a job and, where applicable, a credit. |
| Abuse / scraping | M05 `IF-05c`, M10 plan caps, M35 watermark, M39 | Anonymous and Free limits are enforced server-side in M10, not in the UI. |
| Security | M01, M05 (admin MFA), M11 (audit) | Admin actions all go through M11 or audited admin endpoints. |

---

## 11. Assumptions and open questions

**Assumptions made in this HLD** (LLD may revisit them; each should be confirmed or changed explicitly):
1. R1/R2 share one TS codebase. R3 is a separate Python deployable. Cross-plane synchronous calls are limited to the three rpc exceptions in §3.4.
2. The global suppression list lives in the `knowledge` schema (so Python ingestion reads it locally) but is owned and written only by M10 on the TS side.
3. Buyer read models (SearchDoc, ProfileDoc) are built by M09 in R3, and **only M10** reads them for serving. M26 and M27 define the fields they need as a contract with M09.
4. Serving-originated fact changes (reports, operator corrections, sanctions decisions, confirmed merges) reach the evidence store only as `IF-09b` jobs, which keeps M09 the single writer.
5. Credits are account-scoped. Consultant per-client balances (M52) will be sub-balances, not a re-key.
6. One reveal action reveals all company-level contacts for one buyer. Pricing granularity itself belongs to DS-13.
7. The anonymous session's chosen HS code and countries are carried into the first workspace at signup.
8. Cold-search completion reaches the user by polling in the MVP. Push notifications arrive with M41.
9. Dead-lettered jobs appear as a system review item type in M11.
10. Identifier normalisation and hashing (for suppression) is one spec with shared test vectors, implemented in TS and Python.
11. Before M36 exists, M10 and DS-01 use the Free-plan defaults from M28 allowance config, so Phases 5–6 can be verified end to end.

**Open questions for LLD / the author:**
1. **Notification dependency gap:** M31 (removal confirmation to the requester) and M20/M26 (discovery-complete notices) need outbound email before M41 exists. Proposal: M05's transactional ESP client is exposed as a minimal `send transactional email` utility in Phase 1, and M41 later wraps it. LLD should confirm which module owns the ESP client.
2. **Invalid-contact suppression:** should a confirmed-invalid contact become a negative assertion only (current design, reversible by re-verification), or also a DS-06 suppression? This HLD uses a negative assertion only, because suppression is for removal requests.
3. **Merge follow-through:** when M18 merges companies, M29 reveal records, M30 hides and M33 shortlist entries point to old ids. This HLD assumes they resolve through DS-03 merge lineage at read time, not through rewrites. LLD should confirm.
4. **Trust recompute scope:** does a change to any assertion trigger M24, or only changes to attribute classes that affect trust? This HLD assumes EV-01 carries the changed attribute classes and M24 filters on them.
5. **Coverage recompute granularity:** per EV-05 (cell-level) plus at the end of each batch run. Does M15 also need a periodic full recompute for freshness decay? A periodic full recompute is recommended.
6. **Search engine migration:** IF-09d's query primitives should be defined so that a future move to OpenSearch or Typesense (architecture §7) changes only M09/M10 internals, not M26.
7. **REQ-035** has no module. The HLD only reserves the `named_person` class (DS-04) and M10 rule 4. There is nothing more to design until legal clearance.
8. **REQ-022** is US-only until M53. The SearchDoc/ProfileDoc sourcing fields must allow "unknown" to be shown distinctly from "no".
9. Carried from earlier stages without change: US customs vendor (M21), GST invoicing route (M36), refund cap and freshness thresholds (M30, M25), trust-wording legal review (M24, M37), and the web-discovery precision bar (M20, gating M26 display).
