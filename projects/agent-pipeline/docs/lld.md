<!-- Written by: low-level-design stage. Read by: spec-implementer. -->

# Low-Level Design: Export Buyer Discovery for Indian Exporters

> **Scope:** implementation-ready specs for each module `M01`…`M53` in `docs/implementer.md`: signatures, table schemas, edge cases and error handling. The section order matches the module order there. Interface (`IF-`), data-structure (`DS-`) and event (`EV-`) IDs come from `docs/hld.md`.
> **Inputs:** `docs/hld.md`, `docs/implementer.md`. `docs/design.md` and `docs/architecture.md` were not read in this stage. REQ IDs are carried over from the implementer plan.
> **How to read a module section:** *Code* (where it lives) · *Schema* (tables) · *API* (signatures) · *Rules* (behaviour and edge cases) · *Errors* · *Tests* (the minimum needed to accept the module).
> Thresholds marked **[tunable]** are config values with a starting default. Change them in config, not in code.

---

## 0. Shared conventions (apply to every module)

### 0.1 Code layout
```
/apps/web            TS: R1 (SSR + API) and R2 (worker process: `node dist/worker.js`)
/apps/web/src/modules/mNN_<name>/   one folder per module: index.ts (public API only), routes.ts, repo.ts, jobs.ts, *.test.ts
/py/kp/mNN_<name>/                  Python knowledge-plane package (R3); public API in __init__.py
/py/kp/rpc/                         the FastAPI "knowledge RPC" app (HLD §3.4)
/db/migrations/NNNN_<module>_<desc>.sql   one migration tool (sqitch or dbmate [assumption: dbmate]), shared by TS and Py
/spec/normalisation/vectors.json    shared test vectors (M10 identifier normalisation)
```
- A module may import another module **only** through that module's `index.ts` or `__init__.py`. Enforce this with an ESLint `no-restricted-imports` rule and an import-linter contract in Python.
- Stack: TS on Node 20, Fastify, zod for every request and payload schema, Kysely for SQL. Python 3.12, pydantic v2, psycopg 3, httpx.

### 0.2 Types and naming
- IDs are `uuid` generated as UUIDv7 in application code. TS type `type Id<T extends string> = string & {__brand: T}`.
- Times are `timestamptz`, always UTC. The API returns ISO-8601 strings.
- Credits are `integer`. Never use floats for credits or money. INR amounts are stored as `bigint` paise.
- Enums are Postgres `text` with a `CHECK` constraint, not native enums, so migrations stay cheap.
- Every table has `created_at timestamptz not null default now()`. Mutable tables also have `updated_at`.
- Country codes are ISO-3166 alpha-2 in uppercase. HS codes are digit strings with no dots (`"630231"`).

### 0.3 Error model
TS: `class AppError extends Error { code: ErrorCode; http: number; details?: Record<string, unknown> }`. Python: `class KpError(Exception)` with the same `code` field. The API responds with `{ "error": { "code", "message", "details" } }`.

| code | http | meaning |
|---|---|---|
| `VALIDATION` | 400 | zod or pydantic validation failed |
| `UNAUTHENTICATED` | 401 | no session, or session expired |
| `FORBIDDEN` | 403 | role or tenant mismatch |
| `NOT_FOUND` | 404 | also used for another tenant's rows, so their existence is never leaked |
| `CONFLICT` | 409 | idempotency key reused with a different payload, or a unique constraint was violated |
| `RATE_LIMITED` | 429 | the response includes `retryAfterSec` |
| `INSUFFICIENT_CREDITS` | 402 | the ledger hold failed |
| `POLICY_DENIED` | 403 | M10 denied the action; `details.reasons: ReasonCode[]` |
| `SANCTIONS_BLOCKED` | 403 | M17 returned a hit |
| `UPSTREAM_UNAVAILABLE` | 503 | vendor down; the caller should degrade |
| `SIGNUP_REQUIRED` | 401 | an anonymous visitor hit a gated action |
| `INTERNAL` | 500 | unexpected error; logged with the correlation id |

Rules:
1. Never return a 500 for a vendor failure. Map it to `UPSTREAM_UNAVAILABLE`, or degrade (see the module).
2. Every mutating HTTP endpoint accepts an `Idempotency-Key` header, or a body field `idempotencyKey` for form posts. A repeat with the same key and the same payload hash returns the stored response. The same key with a different payload returns `CONFLICT`.

### 0.4 Actor context (DS-01), used everywhere
```ts
type ActorKind = 'anonymous' | 'user' | 'admin' | 'system';
interface ActorContext {
  kind: ActorKind;
  accountId?: Id<'account'>; memberId?: Id<'member'>; workspaceId?: Id<'workspace'>;
  anonSessionId?: string;              // present when kind = 'anonymous'
  role?: 'owner' | 'member' | 'consultant' | 'admin_support' | 'admin_ops' | 'admin_super';
  entitlements: Entitlements;          // from M36, or Free defaults from M28 config (HLD assumption 11)
  locale: 'en' | 'hi'; region: string; // region = the user's country code, from the profile, else IP geolocation
  mfaVerified: boolean; correlationId: string;
}
interface Entitlements { plan: 'anonymous'|'free'|'starter'|'growth'; searchResultCap: number; exportRowsPerMonth: number;
  bulkRevealMax: number; checksPerMonth: number; revealsIncludedPerMonth: number; }
```

### 0.5 Events and jobs
Every event payload is a zod schema in TS and a pydantic model in Python. Both are generated from the same JSON Schema in `/spec/events/*.json`. The payload has a `v` field for its version. Handlers must be idempotent: each handler records `(event_id, handler_name)` in `platform.event_handled` inside its own transaction, and skips any pair already recorded.

---

## M01: Platform foundation
**REQs:** enabling for all; REQ-057, REQ-061, REQ-062, REQ-008, REQ-063.

**Code:** `apps/web/src/modules/m01_platform`, `py/kp/m01_platform`.

**Schema:** Postgres 16 in the India region (`ap-south-1` [assumption]) with the extensions `pgvector`, `pg_trgm`, `unaccent` and `citext`. It has the schemas `serving`, `knowledge`, `ledger`, `analytics` and `platform`. `platform` is added to hold the queue, outbox and cost tables.
```sql
platform.cost_event(id uuid pk, vendor text not null, op text not null, units numeric not null, cost_micros_inr bigint not null,
  job_type text, account_id uuid null, credit_ref text null, correlation_id text not null, at timestamptz not null default now());
-- index (vendor, at), (account_id, at)
platform.budget(vendor text pk, monthly_limit_micros_inr bigint, alert_pct int default 80);
```
There are three DB roles. `app_serving` has read/write access to serving, ledger and platform, and **select only** on the knowledge read-model views listed in M09. `app_knowledge` has read/write access to knowledge and analytics, and read access to `knowledge.suppression`. `app_admin` is used for migrations.

**API (TS):**
```ts
// IF-01a
function scoped(ctx: ActorContext): ScopedDb;   // wraps Kysely
interface ScopedDb {
  selectFrom<T extends TenantTable>(t: T): SelectQueryBuilder;  // automatically adds WHERE account_id = ctx.accountId
                                                               // (and workspace_id when the table is workspace-scoped)
  insertInto<T extends TenantTable>(t: T, row: Omit<Row<T>,'account_id'|'workspace_id'>): ...; // injects the ids
  transaction<R>(fn: (db: ScopedDb) => Promise<R>): Promise<R>;
}
function systemDb(reason: string): Db;          // unscoped; the reason is logged. Allowed for kind='system'|'admin' only.
// IF-01b
function recordCost(e: {vendor: string; op: string; units: number; costMicrosInr: number; ctx?: ActorContext; jobType?: string; creditRef?: string}): void; // buffered, flushed every 5 s
// IF-01c
const log: pino.Logger; function withSpan<T>(name: string, fn: () => Promise<T>): Promise<T>;
```
- A **TenantTable** registry (`tenancy.ts`) maps each serving table to `'account' | 'workspace' | 'global'`. `scoped()` throws `FORBIDDEN` when the table is tenant-scoped and `ctx.accountId` is missing, or when a workspace table is used and `ctx.workspaceId` is missing.
- RLS backs this up: the policy is `account_id = current_setting('app.account_id')::uuid`, and the setting is applied per transaction with `SET LOCAL`.

The Python API mirrors these helpers: `record_cost(...)`, `get_logger()`, `span()`.

**Rules:**
- Budget alerts: an hourly job sums `cost_event` for the current month per vendor and alerts at or above `alert_pct`. At 100% it sets a Redis flag `budget:exceeded:<vendor>`. Connectors check this flag and return `UPSTREAM_UNAVAILABLE` when it is set, so spending stops.
- Secrets are read only from the secrets manager at boot. Nothing is committed to the repo.

**Tests:**
- A scoped query can never return rows from another account (property test with 2 accounts).
- A missing ctx throws.

---

## M02: Job queue and scheduler
**REQs:** enabling for REQ-026, REQ-034, REQ-047, REQ-061.

**Decision:** a Postgres-backed queue that both languages can read (`SELECT … FOR UPDATE SKIP LOCKED`). No separate broker.

**Schema:**
```sql
platform.job(id uuid pk, queue text check (queue in ('serving','knowledge')), type text, payload jsonb, v int,
  idempotency_key text, correlation_id text, actor_ref text, rate_class text null,
  state text check (state in ('queued','running','done','failed','dead')), attempts int default 0, max_attempts int default 8,
  run_at timestamptz default now(), locked_until timestamptz, last_error text, created_at, updated_at,
  unique (type, idempotency_key));
-- index (queue, state, run_at)
platform.outbox(id uuid pk, event_type text, payload jsonb, v int, correlation_id text, created_at, dispatched_at timestamptz null);
platform.subscription(event_type text, handler text, queue text, primary key(event_type, handler)); -- seeded from code at boot
platform.schedule(name text pk, cron text, job_type text, payload jsonb, queue text, last_enqueued_at timestamptz);
platform.rate_class(name text pk, max_concurrency int, per_second numeric);
platform.event_handled(event_id uuid, handler text, primary key(event_id, handler));
```

**API (TS; Python has the same names in snake_case):**
```ts
// IF-02a
enqueue<P>(tx: Tx, job: {type: string; queue: 'serving'|'knowledge'; payload: P; idempotencyKey: string; runAt?: Date; rateClass?: string; maxAttempts?: number}, ctx?: ActorContext): Promise<Id<'job'>>;
registerHandler<P>(type: string, schema: ZodType<P>, fn: (p: P, meta: JobMeta) => Promise<void>): void;
// IF-02b
registerSchedule(name: string, cron: string, jobType: string, payload: object, queue): void;  // upserted at boot
// IF-02c
emit<E extends EventType>(tx: Tx, type: E, payload: EventPayload<E>): void;   // inserts into the outbox inside the caller's tx
subscribe<E>(type: E, handlerName: string, fn: (p, meta: {eventId}) => Promise<void>): void;
```

**Rules:**
- `enqueue` uses `INSERT … ON CONFLICT (type, idempotency_key) DO NOTHING RETURNING id`. On a conflict it returns the existing id.
- The dispatcher (in R2, a single leader chosen with `pg_advisory_lock`) polls the outbox every 500 ms. For each subscription it enqueues a job `evt:<event_type>:<handler>` with idempotency key `<outbox.id>:<handler>`, then sets `dispatched_at`.
- Workers poll their own queue, filtered to handlers registered in that process. They lease a job for 5 minutes by setting `locked_until`. A reaper requeues jobs whose lease has expired.
- Retries back off at `min(2^attempts × 5 s, 1 h)` with ±20% jitter. When `attempts ≥ max_attempts`, the job moves to state `dead` and `M11.file('system.dead_letter', …)` is called (HLD assumption 9). Because of the layering, this call goes through a registered hook: M02 exposes `onDeadLetter(fn)` and M11 registers the hook.
- Rate classes are enforced with a Redis token bucket per class. If no token is available, `run_at` is set to now + 1/per_second.
- Scheduler: a leader tick every 30 s evaluates the crons and enqueues with idempotency key `<name>:<scheduled_ts>`, so a tick never double-fires.
- A job handler that throws `NonRetryable` goes straight to `dead`.

**Edge cases:** the payload fails schema validation → the job goes to `dead` (non-retryable). An unknown job type is never picked up; it stays queued and an alert fires after 1 h.

**Tests:** exactly-once enqueue under concurrent calls; handler retry and dead letter; the scheduler does not double-fire with two leaders.

---

## M03: LLM adapter
**REQs:** enabling for REQ-005, REQ-013, REQ-038, REQ-015, REQ-016, REQ-024.

**API (IF-03a, TS and Py):**
```ts
type Tier = 'classify' | 'draft';     // mapped to concrete provider/model in config: llm.tiers.<tier> = {provider, model, maxTokens}
interface LlmRequest { tier: Tier; purpose: string; system: string; messages: {role:'user'|'assistant'; content:string}[];
  jsonSchema?: object; temperature?: number; cacheable?: boolean; piiFree: boolean; ctx?: ActorContext; timeoutMs?: number }
interface LlmResult { text: string; json?: unknown; model: string; inputTokens: number; outputTokens: number; cached: boolean }
complete(req: LlmRequest): Promise<LlmResult>;
stream(req: LlmRequest): AsyncIterable<{delta: string}> & { final: Promise<LlmResult> };
```

**Rules:**
- Cache key: `sha256(tier|model|system|messages|jsonSchema|temperature)`. Only `cacheable: true` requests use the cache. They are stored in Redis with a TTL of 30 days, and the M14 "why" summaries are also persisted by M14.
- `jsonSchema` → structured-output mode. If the response does not validate, retry once with the validation error appended. If it fails again, throw `LLM_BAD_OUTPUT` (mapped to `INTERNAL` for the API, and to a retryable failure inside jobs).
- Logging: the prompt and output are logged **only if `piiFree` is true**. Otherwise only the purpose, the token counts and a hash are logged. Draft prompts contain the user's business details, so M34 passes `piiFree: false`.
- Cost is recorded for every call with `recordCost({vendor: provider, op: purpose, units: tokens})`.
- Timeouts default to 20 s for classify and 60 s for draft streams. On timeout or a 5xx, retry once on the fallback provider if `llm.tiers.<tier>.fallback` is configured. After that, throw `UPSTREAM_UNAVAILABLE`.
- The adapter never sends a user's phone number or email. Callers are responsible for this, and a regex guard rejects prompts that contain email or phone patterns when `piiFree` is true.

---

## M04: Web front-end shell and design system
**REQs:** REQ-057, REQ-058, REQ-054.

**Decisions:** Next.js App Router for SSR [assumption], hosted inside R1. Tailwind for styling. `next-intl` for i18n. Message catalogues live in `/apps/web/messages/en.json` (Hindi is added in M51).

**Components (IF-04a):**
```ts
<CostBadge action: PriceAction; country?: string; quantity?: number />   // calls GET /api/prices (IF-28c), which is cached per catalogue version
<CoverageLabel cell: CoverageCellDto />                                    // label + tooltip rendered from the explanation key and params
<TrustChecklist result: TrustResultDto />                                  // wording keys come from M37; never renders the words "verified" or "genuine"
<Disclaimer kind: 'hs'|'trust'|'sanctions'|'coverage' />
<SignupGate reason: string />
```
Every string comes from `t(key)`. An ESLint rule (`i18next/no-literal-string`) fails the build on any literal JSX text.

**Performance budgets** (CI Lighthouse runs on a Moto G Power profile over 4G; the build fails if any is breached):
- LCP ≤ 2.5 s.
- JS ≤ 170 KB gzipped per route.
- CLS ≤ 0.1.

**Navigation** follows design §3.2: Home, Products (workspaces), Markets, Buyers, My buyers, Check a buyer, Learn, Account.

**Edge case:** if the price fetch fails, CostBadge shows "price unavailable" and the parent must disable the action. The badge exposes an `onUnavailable` callback for this.

---

## M05: Identity and sessions
**REQs:** REQ-001, REQ-004.

**Schema (`serving`):**
```sql
account(id uuid pk, status text check in ('active','deleting','deleted'), created_at);
member(id uuid pk, account_id uuid fk, phone_e164 text unique null, email citext unique null, role text default 'owner',
  is_admin bool default false, admin_role text null, totp_secret_enc bytea null, created_at, check (phone_e164 is not null or email is not null));
otp_challenge(id uuid pk, channel text check in ('sms','email'), destination_hash text, code_hash text, attempts int default 0,
  expires_at timestamptz, consumed_at timestamptz null, ip inet, created_at);
session(id text pk /* 256-bit random, stored as sha256 */, member_id uuid null, anon boolean, anon_state jsonb default '{}',
  mfa_verified bool default false, ip inet, ua_hash text, expires_at, created_at, last_seen_at);
```

**API:**
```
POST /api/auth/otp/request {channel:'sms'|'email', destination} → 202 {challengeId, resendAfterSec:30}
POST /api/auth/otp/verify  {challengeId, code} → 200 {isNewUser:boolean} + Set-Cookie sid (HttpOnly, Secure, SameSite=Lax, 30 d sliding)
POST /api/auth/logout → 204
POST /api/admin/mfa/verify {totp} → 204
```
```ts
resolveSession(req): Promise<ActorContext>;                       // IF-05b; creates an anonymous session if there is no cookie
guardAnonymous(ctx, bucket: 'hs'|'market'|'search_preview'|'public_form'|'check'): Promise<void>; // IF-05c, throws RATE_LIMITED
sendTransactionalEmail(to: string, templateKey: string, params: object, opts?: {idempotencyKey: string}): Promise<void>; // resolves HLD OQ1
sendSms(toE164: string, dltTemplateId: string, params: string[]): Promise<void>;
```

**Rules:**
- OTP: 6 digits, stored as `hmac_sha256(pepper, code)`, valid for 10 minutes, at most 5 verify attempts.
- OTP request limits:
  - 3 requests per destination per 15 minutes.
  - 10 per IP per hour.
  - Both are Redis sliding windows. Exceeding either returns `RATE_LIMITED`.
- Phone numbers must be E.164. Only `+91` is allowed for SMS at launch [assumption]; any other number is rejected with `VALIDATION` and the UI suggests email instead.
- On verify, a member is found by destination or created (with a new account). The session id rotates. The anonymous session's `anon_state` (`{hsCode, hsVersion, countries[]}`) is copied into `session.anon_state_pending`, and M07 consumes it (HLD assumption 7).
- Anonymous guard limits per bucket [tunable]:

  | bucket | limit per IP+device per hour |
  |---|---|
  | `hs` | 30 |
  | `market` | 30 |
  | `search_preview` | 10 |
  | `check` | 3 |
  | `public_form` | 5 |

  After 50% of a limit is used, a Turnstile challenge is required (`details.challenge=true`). The device id is a signed first-party cookie.
- Admin: `/admin/*` routes need `is_admin` and `mfa_verified`. Admin sessions expire after 12 hours.
- The ESP (email) and SMS vendor adapters live here. M41 wraps them later. Send failures retry through a job, `m05.send_email`.

**Errors:**
- Wrong code → `VALIDATION` with `attemptsLeft`.
- Expired code → `VALIDATION` with `details.expired=true`.
- Vendor down → `UPSTREAM_UNAVAILABLE`, and the UI offers the other channel.

**Data rights (IF-38a):** export returns the member's identifiers. Erase deletes sessions and nulls the phone and email after the account is closed.

---

## M06: Consent and privacy notice ledger
**REQs:** REQ-062; enabling REQ-061.

**Schema:**
```sql
serving.privacy_notice(version text pk, locale text, body_md text, published_at timestamptz, sha256 text);
serving.consent_event(id uuid pk, account_id uuid, member_id uuid, purpose text check in ('core_service','marketing_email','whatsapp','analytics'),
  action text check in ('grant','withdraw'), notice_version text fk, channel text, ip inet, at timestamptz default now());
-- append-only: REVOKE UPDATE, DELETE from app_serving
```

**API (IF-06a):**
```ts
recordConsent(ctx, purposes: Purpose[], noticeVersion: string): Promise<void>;
withdrawConsent(ctx, purpose: Purpose): Promise<void>;           // emits EV-11 ConsentWithdrawn{accountId, purpose}
currentConsent(accountId): Promise<Record<Purpose, {granted: boolean; at: Date; noticeVersion: string}>>;
consentManagerHook: { onGrant?(e), onWithdraw?(e) }              // no-op now; reserved for a future DPDP Consent Manager
```

**Rules:**
- Signup is blocked until `core_service` is granted against the **current** notice version (`409 CONSENT_REQUIRED`, a sub-code of `CONFLICT`).
- When a new notice version is published, users see a re-accept interstitial on their next login.
- Withdrawing `core_service` behaves like account deletion: the UI confirms first, then M38 is started.

---

## M07: Tenancy, business profile and onboarding
**REQs:** REQ-002, REQ-008; groundwork REQ-063, REQ-003.

**Schema:**
```sql
serving.business_profile(account_id uuid pk, business_name text not null, city text, state text, what_they_make text,
  export_experience text check in ('none','some','regular'), iec text null check (iec ~ '^[A-Z0-9]{10}$'), iec_verified_at timestamptz null,
  target_markets text[] default '{}', sender_name text, sender_email citext, website text null, updated_at);
serving.workspace(id uuid pk, account_id uuid, name text, hs_code text null, hs_level text null, hs_version text null,
  hs_needs_reconfirm bool default false, countries text[] default '{}', deleted_at timestamptz null, created_at, updated_at,
  unique (account_id, name) where deleted_at is null);
```

**API:**
```
POST /api/onboarding {businessName, city, state, whatTheyMake, exportExperience, iec?, targetMarkets?} → 201 {workspaceId}
GET|PATCH /api/profile
GET|POST /api/workspaces ; PATCH|DELETE /api/workspaces/:id
```
```ts
// IF-07a
getWorkspace(ctx, id): Promise<Workspace>; listWorkspaces(ctx): Promise<Workspace[]>;
setHsCode(ctx, id, {code, level, version}): Promise<void>; setCountries(ctx, id, countries: string[]): Promise<void>;
// IF-07b
getBusinessProfile(ctx): Promise<BusinessProfile>;
```

**Rules:**
- Onboarding creates the first workspace. Its name defaults to `whatTheyMake`, truncated to 60 characters. It consumes `anon_state_pending` for the HS code and countries.
- A workspace can hold at most 20 countries and there can be at most 25 workspaces per account [tunable].
- Delete is soft (sets `deleted_at`). Shortlists stay but are hidden. The workspace is hard-purged by M38, or after 30 days.
- The IEC is uppercased before validation.

---

## M08: Source licence register and connector framework
**REQs:** REQ-036; enabling REQ-033, REQ-048.

**Schema (DS-02):**
```sql
knowledge.source(id text pk /* e.g. 'web.crawl', 'customs.us.<vendor>', 'registry.gb.ch' */, source_type text check in
  ('customs','website','directory','registry','sanctions','market_stats','nomenclature','user_report','operator'),
  can_store bool, can_display bool, can_export bool, retention_days int null, attribution_text text,
  personal_data_class text check in ('none','business_contact','named_person'), allowed_regions text[] /* '*' = all */,
  status text check in ('active','disabled','prohibited'), notes text, updated_at);
knowledge.raw_object(id uuid pk, source_id text fk, s3_key text unique, sha256 text, fetched_at, url text null, bytes bigint, expires_at timestamptz null);
```
The register is seeded from `/config/sources.yaml` by a migration. Changes are made by a PR to that file. Prohibited rows are seeded for `linkedin`, plus any site whose terms forbid scraping.

**API (Py, IF-08a/b):**
```python
def get_source(source_id: str) -> SourceEntry            # raises SourceNotRegistered / SourceNotActive
class Connector(ABC):
    source_id: ClassVar[str]; rate_class: ClassVar[str]
    def __init__(self): self.source = get_source(self.source_id)    # refuses to construct if the entry is missing or not active
    @abstractmethod
    def fetch(self, req: FetchRequest) -> Iterable[RawItem]: ...
    def land(self, item: RawItem) -> RawRef                 # writes s3://raw/<source_id>/<yyyy>/<mm>/<dd>/<sha256>; idempotent on sha256
    @abstractmethod
    def parse(self, ref: RawRef) -> Iterable[Record]: ...
    def run(self, req) -> RunStats                          # fetch → land → parse; records cost; checks the budget flag
```
TS gets a read-only `getSource(id)` for M10 and M35.

**Rules:**
- The S3 bucket has versioning and Object Lock in governance mode. Lifecycle expiry per source prefix is set from `retention_days`, and a nightly job re-syncs the lifecycle rules. `expires_at` is set on each `raw_object` row.
- If `can_store = false`, the connector may process data in memory only. `land()` raises and `parse()` receives the item directly.
- The robots.txt check is part of the base `http_fetch` helper. A disallowed URL raises `RobotsDisallowed` and is counted in `RunStats.skipped`.
- The helper sends a user agent that identifies the product and a contact URL.

**Tests:** constructing a connector with an unregistered or prohibited source raises; landing the same bytes twice produces one object.

---

## M09: Evidence store (assertions and projections)
**REQs:** REQ-017, REQ-024, REQ-033; enabling REQ-021, REQ-032.

**Schema (`knowledge`):**
```sql
company(id uuid pk, status text check in ('active','merged','closed'), merged_into uuid null fk company, display_name text,
  country text, city text null, primary_domain text null, created_at, updated_at);
company_anchor(kind text check in ('registry','lei','vat','domain'), value_norm text, company_id uuid, primary key(kind, value_norm));
assertion(id uuid pk, subject_type text check in ('company','person'), subject_id uuid, attribute text, value jsonb,
  polarity text check in ('positive','negative'), source_id text fk source, source_type text, source_ref jsonb not null,
  observed_at timestamptz, checked_at timestamptz, confidence real check (confidence between 0 and 1),
  can_display bool, can_export bool, personal_data_class text, region text, producer text, producer_version text,
  llm_assisted bool default false, superseded_by uuid null, hs_heading text null, created_at);
-- index (subject_id, attribute) where superseded_by is null; (attribute, checked_at); (hs_heading, subject_id)
search_doc(company_id uuid, hs_heading text, doc jsonb, tsv tsvector, country text, buyer_type text, trust_level text,
  last_activity date null, shipment_freq int null, volume_score real null, origin_india text check in ('yes','no','unknown'),
  origin_competitor text check in ('yes','no','unknown'), contact_types text[], is_logistics bool, sanctions_block bool,
  identifier_hashes text[], projection_version int, built_at, primary key(company_id, hs_heading));
-- GIN(tsv), GIN(identifier_hashes), GIN(contact_types), btree(country, hs_heading)
profile_doc(company_id uuid pk, doc jsonb, identifier_hashes text[], sanctions_block bool, is_logistics bool, projection_version int, built_at);
contact_value(assertion_id uuid pk, company_id uuid, kind text, value text, value_hash text); -- read only by M29, through a view
```

**Attribute vocabulary** (enforced by an allow-list in `attributes.py`):
- `product_evidence`: `{hs_heading, snippet, url}`
- `buyer_type`: `{type}`
- `activity_aggregate`: `{hs_heading, shipments_12m, volume_kg_12m, origins: {CC: n}, top_suppliers: [..], last_seen}`
- `contact.website`, `contact.phone`, `contact.role_email`, `contact.form_url`, `contact.address`, `contact.whatsapp`
- `registry.match`, `domain.age_days`, `domain.mx`, `domain.freemail`
- `logistics_flag`, `sanctions_flag`
- `trust.check.<id>`, `trust.rollup`
- `status.closed`, `not_buyer_for`

**API (Py):**
```python
# IF-09a
def write_assertion(a: AssertionIn, *, tx) -> AssertionId | None
def negate(subject_id, attribute, value_match: dict, source_id, source_ref, *, tx) -> AssertionId
# IF-09c
def get_assertions(subject_id, attributes: list[str] | None = None, include_superseded=False) -> list[Assertion]
def find_by_anchor(kind, value_norm) -> CompanyId | None
def stale(attribute_prefix: str, older_than: timedelta, limit: int) -> list[Assertion]
def resolve_company_id(id) -> CompanyId        # follows merged_into up to 10 hops; raises on a cycle
# IF-09b handler (job type 'm09.assertion_command')
class AssertionCommand(BaseModel): kind: Literal['report_not_buyer','report_closed','operator_correction','merge_confirm','merge_reject',
    'sanctions_decision']; subject_id: UUID; payload: dict; review_item_id: UUID | None; actor: str
```

`write_assertion` validation order. The first failure raises:
1. Attribute not in the allow-list → `InvalidAttribute`.
2. Source is not registered or not active → `SourceNotActive`.
3. `llm_assisted=True` but `source_ref` has no `url` and `captured_at` → `MissingPageReference` (DS-04 rule).
4. `personal_data_class == 'named_person'` → `PersonalDataDisabled` (REQ-035 is not built).
5. Any identifier in the value (domain, email, phone) is suppressed via IF-10c → returns `None`. Nothing is written and `suppressed_skip` is counted. This is not an error.
6. `can_display`, `can_export` and `personal_data_class` are copied from the source. A caller can make them *more* restrictive but never less.
7. Supersede: an existing active assertion with the same `(subject, attribute, identity key)` is marked `superseded_by`. The identity key is: `value.value_hash` for contacts, `hs_heading` for evidence and aggregates, `check id` for trust checks, and none for single-valued attributes. If the new value equals the old one, only `checked_at` is updated (no new row).
8. `EV-01` is emitted in the same tx: `{company_id, attribute_classes: [prefix before '.']}`.

**Projection builder** (handler for EV-01, EV-03 and EV-04; job `m09.project`, keyed by `company_id` and debounced 60 s via `run_at`):
- Load the active assertions for the resolved company. If it is merged, rebuild the target and delete the docs for the old id.
- Build one `search_doc` per `hs_heading` that has a `product_evidence` or `activity_aggregate` assertion. Build one `profile_doc`.
- `identifier_hashes` = `norm_hash` (M10 spec) of the domain, every contact value, the company id and the registry ids.
- `origin_india` / `origin_competitor` are `unknown` unless an `activity_aggregate` exists (HLD OQ8).
- Contact slots in the `profile_doc` hold `{assertion_id, kind, source_type, checked_at, deliverability}`. They **never hold values**. Values live only in `contact_value`.
- Assertions with `can_display=false` are excluded from the docs. Their ids are kept in `doc.hidden_assertion_ids` so audits can still see them.
- If the company is `closed`: its search docs are deleted and the profile doc is kept with `status: closed`.

**Merge follow-through (HLD OQ3, confirmed):** serving tables keep old ids. Every serving read resolves them through the view `knowledge.company_redirect(id, current_id)`, which app_serving can select. Nothing is rewritten.

**Views app_serving can read:** `v_search_doc`, `v_profile_doc`, `v_company_redirect`. `v_contact_value` is granted only to the role `app_reveal`, which is used only by M29's repo.

**Tests:**
- An LLM-assisted write without a URL is rejected.
- A suppressed domain is skipped.
- Supersede keeps history.
- The projection never contains contact values.

---

## M10: Global suppression and Visibility & Policy layer
**REQs:** REQ-037, REQ-020, REQ-025, REQ-029, REQ-036, REQ-048, REQ-051.

**Normalisation spec** (TS and Py share `/spec/normalisation/vectors.json`, at least 40 vectors):
- `domain`: lowercase; strip scheme, `www.` and the port; IDNA → punycode; take the registrable domain using the Public Suffix List (a pinned version, the same file for both languages).
- `email`: lowercase and trim. Gmail-family dots and `+tags` are removed **only** for gmail.com and googlemail.com.
- `phone`: E.164 via libphonenumber. If it cannot be parsed → digits only, prefixed `raw:`.
- `company_id`: the uuid as-is. `registry`: `<CC>:<registry>:<id uppercase, non-alphanumerics stripped>`.
- The hash is `sha256("<kind>:" + normalised)` in lowercase hex. No pepper is used, because both languages must match and the set is not secret.

**Schema:**
```sql
knowledge.suppression(hash text pk, kind text, reason text check in ('removal_request','operator','legal'), review_item_id uuid null, created_at);
serving.policy_audit(id uuid pk, account_id uuid null, surface text, company_id uuid, decision jsonb, at timestamptz) -- sampled 1%, plus every deny on reveal/draft/export
```

**API (TS):**
```ts
type Surface = 'search'|'profile'|'reveal'|'draft'|'export'|'notify'|'alert'|'similar';
type Action = 'view'|'reveal'|'draft'|'export'|'notify';
type ReasonCode = 'SUPPRESSED'|'SANCTIONS_BLOCK'|'LICENCE_REDACTED'|'REGION_REDACTED'|'LOGISTICS_DEFAULT_HIDDEN'|'USER_HIDDEN'|'PLAN_LIMIT'|'CLOSED';
interface PolicyDecision { visibility: 'hidden'|'visible'|'visible_with_warning'; allowed: Action[]; redactedFields: string[]; reasons: ReasonCode[] }
// IF-10a
search(ctx, surface: 'search'|'export'|'alert', q: SearchQuery): Promise<{rows: Array<{doc: SearchDoc; decision: PolicyDecision}>;
   total: number; shown: number; limit?: {cap: number; reason: 'PLAN_LIMIT'}}>;
byIds(ctx, surface: Surface, companyIds: Id<'company'>[]): Promise<Map<Id<'company'>, {doc: ProfileDoc|null; decision: PolicyDecision}>>;
assertAllowed(ctx, surface, companyId, action: Action): Promise<ProfileDoc>;   // throws POLICY_DENIED / SANCTIONS_BLOCKED / NOT_FOUND
// IF-10b
registerProvider(kind: 'userHides', p: {hiddenCompanies(accountId): Promise<Set<string>>; hiddenAssertions(accountId): Promise<Set<string>>}): void;
registerProvider(kind: 'entitlements', p: {get(accountId|null): Promise<Entitlements>}): void;
// (sanctions and logistics are read from the doc fields sanctions_block / is_logistics, so no provider is needed; M17 invalidates the cache via EV-03)
// IF-10c
isSuppressed(kind, raw: string): Promise<boolean>; normHash(kind, raw): string;
// IF-10d
suppress(tx, entries: {kind; raw: string}[], reason, reviewItemId?): Promise<void>;   // emits EV-04 {hashes}
```
Python client: `is_suppressed(kind, raw) -> bool`, `norm_hash(kind, raw)`, `any_suppressed(hashes) -> set[str]`.

**SearchQuery (the IF-09d primitive, HLD OQ6):**
```ts
interface SearchQuery { hsHeadings: string[]; keyword?: string; countries: string[]; buyerTypes?: string[];
  activeWithinMonths?: 3|6|12; minShipments12m?: number; trustLevels?: ('high'|'medium'|'low'|'unknown')[];
  contactTypes?: string[]; originIndia?: boolean; originCompetitor?: boolean; includeLogistics?: boolean;
  sort: 'relevance'|'recency'|'volume'|'trust'; page: number; pageSize: 20|50 }
```
It is compiled to SQL over `v_search_doc` inside `m10/readModelStore.ts`, the only file allowed to reference these views.

**Rule pipeline.** It runs set-based in SQL where possible:
1. `NOT (identifier_hashes && :suppressed)`. This is a belt-and-braces check; purge on EV-04 is the primary control. The suppressed-hash array is not loaded per request; instead a `NOT EXISTS (select 1 from suppression where hash = any(identifier_hashes))` subquery is used.
2. `sanctions_block` → `visible_with_warning`. `allowed` keeps only `view`.
3. Licence: the doc already excludes non-displayable facts. For surface `export`, fields whose assertions have `can_export=false` are listed in `redactedFields`. The map `field → assertion ids` is in `doc.field_sources`.
4. Region: `named_person` is always redacted. If `ctx.region` is not in the source's `allowed_regions`, those fields are redacted.
5. `is_logistics AND NOT includeLogistics` → hidden (applied in SQL).
6. User hides → excluded in SQL via `company_id <> ALL(:hidden)`.
7. Plan: `shown = min(total, entitlements.searchResultCap)` when `surface=search`. Rows past the cap are not returned, and `limit` metadata is returned instead. Anonymous: cap 5 [tunable], and the returned rows carry only `{name, country, buyerType, trustLevel}` (other fields are redacted).

Search results are cached per `(ctx.accountId, queryHash)` for 60 s. EV-03 and EV-04 invalidate this by bumping a global `policy:gen` counter that is part of the key.

**EV-04 handler (in M10's own TS worker):** delete matching `search_doc` / `profile_doc` rows immediately. M10 is given `DELETE` on these two tables only, and the grant is documented. Then enqueue `m09.project` so the docs are rebuilt without the suppressed identifiers. Result: there is no visibility window (REQ-037).

**Tests:**
- The shared vectors pass in both languages.
- Each rule has its own unit test.
- Sanctions: `view` is allowed, `reveal`/`draft` are denied.
- Anonymous redaction.
- After `suppress()`, the next `search()` excludes the company even before the rebuild runs.

---

## M11: Review queue and admin console
**REQs:** REQ-064; enabling REQ-025, REQ-029, REQ-037, REQ-055.

**Schema:**
```sql
serving.review_item(id uuid pk, type text, subject_refs jsonb, payload jsonb, filed_by_kind text check in ('user','system','public'),
  filed_by_ref text, state text check in ('open','in_review','resolved','rejected'), assignee uuid null,
  sla_due_at timestamptz, outcome text null, outcome_payload jsonb null, handler_result text null, created_at, updated_at, dedupe_key text null,
  unique(type, dedupe_key) where state in ('open','in_review'));
serving.review_audit(id uuid pk, item_id uuid, actor uuid, action text, before jsonb, after jsonb, at);
```

**API:**
```ts
registerType<P, O>(def: {type: string; payloadSchema: ZodType<P>; outcomes: readonly string[]; outcomeSchema: ZodType<O>;
   slaHours: number; view: ConsoleViewSpec; onOutcome: (item: ReviewItem<P>, outcome: string, data: O, tx) => Promise<void>}): void;  // IF-11b
file<P>(tx, type, {subjectRefs, payload, filedBy, dedupeKey?}): Promise<Id<'review_item'>>;   // IF-11a; returns the existing id on a dedupe hit
// admin HTTP: GET /admin/review?type&state ; POST /admin/review/:id/claim ; POST /admin/review/:id/resolve {outcome, data}
```

**Rules:**
- `resolve` writes the audit row, sets the state, and emits EV-07 in one tx. The registered `onOutcome` runs as the EV-07 handler, in the owning module's code. If the handler fails, the job retries and `handler_result='error'` is shown in the console.
- SLA values [tunable]: removal 72 h, sanctions possible-match 24 h, reports 5 d, money-back 7 d. A breach alert is sent hourly.
- RBAC:
  - `admin_support` can resolve report and removal items.
  - `admin_ops` adds sanctions, merges and dead letters.
  - `admin_super` has everything, including refunds above the cap.
- Built-in type: `system.dead_letter` with outcomes `requeue` and `discard`.

---

## M12: HS nomenclature store and loaders
**REQs:** data for REQ-005, REQ-006, REQ-007, REQ-009.

**Schema (`knowledge`):**
```sql
hs_code(version text /* 'HS2022','HS2027','ITCHS2022' */, code text, level text check in ('chapter','heading','subheading','national8'),
  parent_code text null, description text, description_en_simple text null, export_policy text null check in ('free','restricted','prohibited','ste'),
  policy_conditions text null, policy_source_url text null, embedding vector(1024) null, primary key(version, code));
hs_correlation(from_version text, from_code text, to_version text, to_code text, relation text check in ('1:1','1:n','n:1','n:n'));
hs_version(version text pk, loaded_at timestamptz, is_current bool);
```

**Loaders** (Py, `Connector` subclasses): `WcoHsLoader(version)` and `DgftItcHsLoader(edition)`, which reads the DGFT schedule PDF or Excel from a URL in the source register; the parser is table-extraction from the Excel. Also `CorrelationLoader`. Embeddings use `embed(texts)` through M03 [extension: add `embed` to IF-03a, tier `embed`], with a batch size of 128.

**API (TS read, IF-12a/b):**
```ts
browse(version, parentCode|null): Promise<HsNode[]>; lookup(version, code): Promise<HsNode|null>;
vectorSearch(version, queryEmbedding: number[], k=30): Promise<HsNode[]>; currentVersion(level): Promise<string>;
correlate(fromVersion, code, toVersion): Promise<{code; relation}[]>;
```

**Rules:**
- Loading a new version is transactional per version. It sets `is_current` and emits EV-12 `{version}`.
- 8-digit codes must have a 6-digit parent in the corresponding HS version. Orphans fail the load.

---

## M13: HS helper
**REQs:** REQ-005, REQ-006, REQ-007, REQ-004.

**API (IF-13a):**
```
POST /api/hs/suggest {text: string(3..300)} → {candidates: [{code, level, version, description, confidence: 0..1, explanation, exportPolicy?, policyUrl?}], disclaimerKey}
GET  /api/hs/browse?parent= ; GET /api/hs/code/:code
POST /api/workspaces/:id/hs {code, version} (auth) | POST /api/anon/hs {code, version} (anonymous; stored in session.anon_state)
```

**Algorithm:**
1. `guardAnonymous(ctx,'hs')` if the visitor is anonymous.
2. Embed the text (cacheable), then run `vectorSearch` over the current ITC-HS national8 and HS subheadings, k=30.
3. Rerank with `complete({tier:'classify', jsonSchema: {ranked:[{code, confidence, explanation}]}, piiFree:true, cacheable:true})`. The prompt includes the 30 candidates' descriptions. Any code in the output that was not among the candidates is dropped. This guards against hallucinated codes.
4. Return the top 5, each with confidence ≥ 0.15 [tunable]. If none qualifies, return `candidates: []`, and the UI offers the browse view.
5. If the LLM is unavailable, return the vector top 5 with `confidence = cosine-derived` and `explanation = null` (degraded).

**Edge cases:**
- Direct entry of a 4 or 6 digit code is accepted: `level` is set from the length, and `exportPolicy` is null, with the prompt "pick 8-digit for export policy".
- A code that does not exist → `NOT_FOUND`.

---

## M14: Market analytics builder
**REQs:** REQ-010, REQ-011, REQ-013 (data).

**Schema (`analytics`):**
```sql
trade_flow(reporter text, partner text, hs6 text, year int, value_usd bigint, qty numeric null, primary key(reporter, partner, hs6, year));
market_row(country text, hs6 text, data_year int, import_value_usd bigint, cagr_5y real null, india_share real null,
  top_suppliers jsonb /* [{country, share}] top 5 */, fta_ref text null, score real, rank int, why_text text null, why_input_hash text,
  hs_version text, built_at, primary key(country, hs6));
fta(partner text, agreement text, in_force_from date, hs_scope text /* 'all' or a chapters list */, notes text, source_url text);
```

**Jobs:**
- `m14.comtrade_ingest` runs monthly on the 5th, plus an annual refresh. It fetches importer-reported data for the ~60 target countries [tunable list] × all HS6.
- `m14.build_rows` runs after ingest.

**Score** (versioned `SCORE_V=1`):
```
score = 0.45 × pct_rank(import_value) + 0.25 × pct_rank(cagr_5y) + 0.15 × (1 − india_share_capped) + 0.15 × fta_flag
```
`india_share_capped = min(india_share, 0.5) / 0.5`. The leftover room for India is the signal; an assumption, documented in the UI tooltip. Countries with an import value under $1 M are excluded [tunable].

**"Why":** generated only for the top 15 per HS6, and lazily on the first request for the others. `why_input_hash = sha256(json of the numbers)`, and the text is regenerated only when the hash changes. The prompt forbids numbers that are not in the input. A post-check verifies that every number in the output appears in the input (to 1 decimal place); if the check fails, `why_text` is null and the UI shows a template sentence.

**API (IF-14a, TS read):** `marketRows(hs6, {limit=30}): Promise<MarketRow[]>`. It takes an 8-digit or 4-digit input: 8→6 by truncation, and 4 → the aggregate of its HS6 rows by summing values (computed at build time as `hs6 = '<4digits>__'`).

---

## M15: Coverage matrix builder
**REQs:** REQ-012 (data).

**Schema:**
```sql
knowledge.coverage_cell(country text, hs_heading text /* '*' = country fallback */, source_types text[], company_count int,
  fresh_company_count int, label text check in ('strong','partial','limited'), explanation_key text, params jsonb, rule_version int, computed_at,
  primary key(country, hs_heading));
```

**Rule (RULE_V=1) [tunable]:**
- `fresh` = a company with any evidence assertion where `checked_at` is within 180 days.
- **strong:** `'customs' ∈ source_types` AND fresh_company_count ≥ 50.
- **partial:** fresh_company_count ≥ 10 (any source).
- **limited:** otherwise.
- Explanation keys: `coverage.strong.customs`, `coverage.partial.web_only`, `coverage.partial.few`, `coverage.limited`.
- Params: `{count, sources}`.

**Jobs:**
- `m15.recompute_cell(country, heading)` runs on EV-05, debounced 5 minutes.
- `m15.recompute_all` runs nightly at 02:00 IST (HLD OQ5: yes, the periodic recompute is needed) and at the end of M21 runs.
- The country fallback row aggregates across headings.

**API (IF-15a):** `coverage(country, hsHeading): Promise<CoverageCell>`. It returns the heading row, or else the fallback row with `explanation_key` suffixed `.country_level`, or else a synthetic `limited` cell.

---

## M16: Market Finder
**REQs:** REQ-010–014, REQ-004.

**API (IF-16a):**
```
GET /api/markets?hs=<code>&version= → {rows: [{country, importValueUsd, cagr5y, indiaShare, topSuppliers, fta, why, coverage: CoverageCellDto, rank}], dataYear, disclaimerKey}
PUT /api/workspaces/:id/countries {countries: string[]}   | PUT /api/anon/countries
```

**Rules:**
- Anonymous visitors pass `guardAnonymous('market')`.
- Coverage is attached per row: `coverage(country, hs.slice(0,4))`.
- The response is cached for 1 h per `(hs6, dataYear)`.
- No market rows → `rows: []`, with guidance to try the parent heading.

---

## M17: Sanctions ingestion and screener
**REQs:** REQ-029.

**Schema (`knowledge`):**
```sql
sanctions_entry(id uuid pk, list text check in ('ofac_sdn','ofac_cons','un','eu','uk_ofsi'), list_uid text, names text[], names_norm text[],
  countries text[], entity_type text, list_version text, active bool, unique(list, list_uid));
sanctions_screen(subject_key text /* company id or 'adhoc:<sha>' */, result text check in ('clear','possible','hit'), matched_entry_ids uuid[],
  best_score real, list_versions jsonb, screened_at, decision text null check in ('confirmed','cleared'), primary key(subject_key));
```

**Matching (Py):**
- `names_norm` = NFKD → ASCII transliteration (`unidecode`) → lowercase → legal suffixes stripped (a list covering ltd, llc, gmbh, bv, fze, llp, inc, co, sarl, …) → punctuation collapsed.
- Score = `max(token_sort_ratio, jaro_winkler × 100)` via rapidfuzz, plus a +5 country bonus when the countries match.
- Candidates come from a trigram prefilter (`pg_trgm` similarity > 0.3).
- **hit** if score ≥ 95 [tunable]. **possible** if 85 ≤ score < 95. **clear** otherwise.
- A stored decision overrides the result: `cleared` → clear, until the matched entries change. `confirmed` → hit.

**API:**
```python
def screen_company(company_id) -> ScreenResult            # writes sanctions_screen + a sanctions_flag assertion (value {block: bool}) when it changes; emits EV-03
def screen_name(name: str, country: str | None) -> ScreenResult   # ad-hoc, no catalogue write
```
RPC endpoint (IF-17a): `POST /rpc/sanctions/screen {companyId?} | {name, country?}` → `{result, listVersions, screenedAt}`. The server timeout is 800 ms. For a company it returns the stored result if `screened_at` is later than the latest list load; otherwise it screens live.

TS client: `screen(ctx, input): Promise<'clear'|'possible'|'hit'>`. On timeout or 5xx it **fails closed** for reveal and draft (throws `UPSTREAM_UNAVAILABLE`, and the action is not performed).

**Rules:**
- `hit` → `sanctions_flag` block=true.
- `possible` → file `sanctions.possible_match` (dedupe key = company id). Block=true is **also set while the item is pending** [assumption: fail safe]. Outcomes are `confirmed` and `cleared`, which go through IF-09b `sanctions_decision`.
- Daily ingest at 03:00 IST. It diffs by `(list, list_uid)`, and on any change emits EV-02, which triggers the batched re-screen (10k per job).

---

## M18: Normalisation and entity resolution
**REQs:** enabling REQ-021, REQ-037; REQ-064.

**API (IF-18a):**
```python
class Candidate(BaseModel): name: str; country: str; city: str | None; address: str | None; domain: str | None;
    registry_ids: list[str] = []; lei: str | None; vat: str | None; source_id: str
class Resolution(BaseModel): company_id: UUID | None; created: bool; confidence: float; method: Literal['anchor','fuzzy','new','suppressed','review']
def resolve(c: Candidate, *, tx) -> Resolution
```

**Algorithm:**
1. Normalise the name (same function as M17) and the domain (M10 spec).
2. Suppression: if any of the domain or registry hashes is suppressed → return `method='suppressed'`, `company_id=None`. The caller must drop the record.
3. Anchors, in the order lei → registry → vat → domain (free-mail and marketplace domains are excluded as anchors). The first match → `anchor`, confidence 1.0. If different anchors point to different companies, file `entity.merge_review` and use the lei/registry match.
4. Fuzzy: candidates with the same country and a trigram name similarity > 0.5. Score = 0.6 × name sim + 0.2 × city match + 0.2 × address token overlap.
   - ≥ 0.92 → match.
   - 0.80–0.92 → create a new company and file `entity.merge_review {a, b, score}` (`method='review'`).
   - < 0.80 → new company.
5. New company: insert `company` and the anchors. A unique-violation race on an anchor → retry the lookup once.

**Merge outcome handler (`entity.merge_review`):** `merge` → IF-09b `merge_confirm`. M09 then sets `b.merged_into=a`, moves the anchors, re-points the assertions' `subject_id`, and emits EV-01 for a.

---

## M19: Buyer classifiers
**REQs:** REQ-020, REQ-016, REQ-018.

**API (IF-19a):**
```python
def classify(company_id, evidence_texts: list[EvidenceText]) -> Classification
class Classification(BaseModel): is_logistics: bool; logistics_confidence: float; buyer_type: Literal['importer','distributor','wholesaler','retailer','manufacturer','unknown'];
    type_confidence: float; evidence_assertion_ids: list[UUID]
```

**Logic:**
1. Curated list `/config/logistics_entities.yaml` (domains and normalised names). A hit → `is_logistics`, confidence 1.0.
2. Keyword rules (name contains freight, logistics, forwarding, shipping agency, customs broker, NVOCC …) → 0.85.
3. Otherwise, LLM classify (tier `classify`, piiFree), but only over the evidence snippets. The output must cite `evidence_assertion_ids`, and a result with no citation → `unknown`.
4. It writes `logistics_flag` and `buyer_type` assertions, with `source_id='operator.classifier'` (source type `operator`) and a `source_ref` listing the evidence assertion ids.

---

## M20: Web discovery path
**REQs:** REQ-015, REQ-016, REQ-017, REQ-024.

**Job (IF-20a):** `m20.discover {hsHeading, country, reason:'prewarm'|'on_demand', requestedBy?: accountId}`. The idempotency key is `disc:<heading>:<country>:<yyyy-mm-dd>`, so in-flight requests for the same key are deduplicated for the day.

**Pipeline:**
1. Build queries from the heading description plus synonyms: 3 query templates × the country's language [tunable]. Call the search API (vendor adapter `SearchApi`, rate class `search_api`), with at most 30 results per query.
2. Drop results that are marketplaces, social sites, or news (domain list). Drop any domain that is suppressed (IF-10c).
3. Crawl the homepage plus up to 5 internal pages matching `/products|about|contact|import|brands/`, through `http_fetch` (robots-aware, 1 req/s per domain) and `land()`.
4. LLM extract (tier `classify`, JSON) → `{is_buyer_of_product: bool, confidence, snippets: [{text ≤300 chars, url}], company_name, city, country}`. **Each snippet must be an exact substring of the fetched page text.** Snippets that fail this check are dropped. If there are no valid snippets → the domain is discarded.
5. `resolve()` (M18) → `classify()` (M19) → `write_assertion(product_evidence {hs_heading, snippet, url}, llm_assisted=True, source_ref={url, captured_at, raw_object_id}, confidence)`.
6. At the end: emit EV-05 `{country, hsHeading, newCompanies, runId}`.

**Pre-warm:** a weekly schedule over `/config/prewarm.yaml` (GB, DE, NL, AE, US × the top 50 headings) [tunable].

**Precision bar (HLD OQ9):** the output of each run is tagged with the `DISCOVERY_V` model version. M26 shows web-found rows only for `(country)` values listed in `/config/discovery_released.yaml`. A country is added there after the evaluation set shows precision ≥ 0.8 [assumption]. Until then, results are stored but not served.

**Errors:** a search-API outage → the job retries with backoff and M26 keeps showing "finding more". After 3 failures the job completes with `EV-05{newCompanies:0, degraded:true}`.

---

## M21: US customs batch connector
**REQs:** REQ-015, REQ-016, REQ-018, REQ-019, REQ-021, REQ-022.

The vendor is still to be chosen (open question). The connector is `CustomsUsConnector(source_id='customs.us.<vendor>')` behind an interface: `fetch(week) -> files`.
- Records are landed as Parquet at `s3://analytics/customs_us/week=YYYY-WW/` with the schema: `{bol_id, arrival_date, consignee_name, consignee_addr, shipper_name, shipper_country, hs_code (may be missing), description, weight_kg, teu}`.
- A missing HS code → an HS heading is inferred by keyword and vector match against M12 descriptions. Anything with confidence < 0.6 is dropped from aggregates.
- The aggregation is written in DuckDB SQL over the last 12 months, per consignee × hs_heading: `shipments_12m`, `volume_kg_12m`, `origins`, `top_suppliers` (top 5 shipper names, company-level), `last_seen`.
- For each consignee group: `resolve(Candidate(name, country='US', address))`, then `write_assertion(activity_aggregate …, source_ref={batch_week, row_count})`. Aggregates only; individual BOLs are never written to M09.
- `volume_score` is the percentile of volume within the heading, and is computed at projection time.
- At the end of the run → `m15.recompute_all`.

---

## M22: Enrichment: discovery-time contacts
**REQs:** REQ-032, REQ-033, REQ-016.

**Job:** `m22.enrich {companyId}`. It runs on EV-01 when the attribute classes include `product_evidence` or `domain`, and when M25 asks. It is idempotent per company per day.

**Steps:**
1. Primary domain: the `primary_domain`, else a guess from the evidence URLs.
2. Crawl the contact and about pages.
3. Extract:
   - Role emails matching `^(info|sales|export|import|purchasing|procurement|buying|contact|office|enquiries)@` on the company domain. **Personal-looking emails (firstname.lastname@) are discarded** (REQ-035 is not built).
   - Phone numbers via libphonenumber, with the company's country as the region.
   - The address.
   - Contact-form URLs.
   - `wa.me` links as `contact.whatsapp`.
4. DNS: MX lookup → `domain.mx`. Emails on a domain with no MX get deliverability `invalid`.
5. Each value becomes `write_assertion(contact.<kind>, value={value_hash, display_mask}, source_ref={url, captured_at})` and a row in `contact_value`. `display_mask` is, for example, `s***@acme.de`, and is used only for the type/availability display.
6. Every value is checked against IF-10c before it is written.

---

## M23: Registry and domain-signal connectors
**REQs:** enabling REQ-027, REQ-030.

**API (IF-23a, Py):**
```python
def registry_lookup(name: str, country: str) -> RegistryMatch | Unavailable   # GLEIF (global), Companies House (GB), OpenCorporates (optional)
def vat_check(vat: str) -> VatResult | Unavailable                            # VIES (EU)
def domain_signals(domain: str) -> DomainSignals  # {age_days|None, has_mx, is_freemail, rdap_available}
```
- Results are cached in Redis: registry for 30 days, domain for 7 days.
- Each vendor has its own rate class (Companies House 600/5 min, GLEIF 60/min, VIES 1/s) [tunable].
- `Unavailable` is a value, not an exception, so callers can map it to `unknown`.
- The free-mail list is `/config/freemail.txt`, refreshed monthly from an upstream list.

---

## M24: Trust engine
**REQs:** REQ-027, REQ-028.

**Checks** (each is `def run(subject: TrustSubject) -> CheckOutcome{outcome:'pass'|'fail'|'unknown', checked_at, assertion_id|None, explanation_key}`):

| id | pass | fail | unknown |
|---|---|---|---|
| `registered_entity` | registry or LEI match with name sim ≥ 0.9 | registry says dissolved | no registry for the country, or unavailable |
| `website_consistent` | the domain resolves and the page name ≈ the company name (≥ 0.8) | parked domain, or name mismatch | no domain |
| `domain_age` | ≥ 2 years | < 6 months | unavailable |
| `corporate_email` | the role email is on the company domain | only free-mail contacts | no email |
| `recent_trade` | activity aggregate with `last_seen` ≤ 12 months | last_seen > 24 months | no customs data (always unknown without M21) |
| `sanctions` | clear | hit or possible | screener unavailable |

**Rollup (RULE_V=1, deterministic):**
- **low** if any check fails in {`sanctions`, `registered_entity`}, or if ≥ 2 checks fail.
- **high** if `registered_entity` passes AND ≥ 4 checks pass AND nothing fails.
- **medium** if ≥ 2 checks pass and at most 1 fails.
- **unknown** otherwise.

It writes `trust.check.<id>` and `trust.rollup {level, rule_version, copy_version}`.

**Triggers:**
- EV-01 with attribute classes in {`registry`, `domain`, `contact`, `activity_aggregate`, `sanctions_flag`} (HLD OQ4: filter on attribute class).
- `IF-24b` RPC: `POST /rpc/trust/adhoc {name?, email?, website?, country?}` → DS-08 with no writes. Timeout 8 s; each check has a 3 s budget, and a check that runs out → unknown.

Wording lives only in M37 keys like `trust.level.high`. A unit test greps the rendered strings for `/verified|genuine|guaranteed/i` and fails if any are found.

---

## M25: Freshness and re-verification
**REQs:** REQ-033; enabling REQ-034.

**Config [tunable]:** `contact_stale_days=90`, `recrawl_days=180`, `reverify_rpc_wait_ms=12000`.

**API:**
```python
def reverify(assertion_ids: list[UUID], trigger: Literal['reveal','report','schedule'], trigger_ref: str) -> list[VerifyOutcome]  # IF-25a
# VerifyOutcome {assertion_id, status: 'valid'|'risky'|'invalid'|'unknown', checked_at}
```
RPC: `POST /rpc/reverify {assertionIds, trigger, triggerRef}` → it waits up to `reverify_rpc_wait_ms`. Anything still pending comes back as `unknown` while the job continues in the background.

**Per kind:**
- **Email:** MX check, then the email-verification vendor, which maps deliverable→valid, risky/catch-all→risky, undeliverable→invalid, and error→unknown.
- **Phone:** libphonenumber validity only (`valid` / `invalid`).
- **Website and form:** HTTP 200 within 2 redirects → `valid`; a 404 or DNS failure → `invalid`.

Writes:
- `invalid` → `negate(...)` (a negative assertion), plus EV-06 ContactInvalidated.
- `valid` or `risky` → update `checked_at` and deliverability, plus EV-06 ContactVerified.
- `unknown` → no write.

**Nightly schedule:** `stale('contact.', 90d, limit=5000)` → re-verify jobs. `stale('product_evidence', 180d)` → a re-crawl through M20 for that domain.

HLD OQ2 is decided: invalid means a negative assertion only, with **no suppression**.

---

## M26: Buyer search
**REQs:** REQ-015, REQ-016, REQ-018, REQ-019, REQ-020, REQ-012, REQ-024, REQ-004, REQ-051.

**API (IF-26a):**
```
POST /api/buyers/search {workspaceId?, ...SearchQuery (countries default = workspace.countries; hsHeadings default = workspace.hs_code[0..4])}
→ {rows: SearchRowDto[], total, shown, limit?, coverage: {[country]: CoverageCellDto}, discovery: {[country]: 'idle'|'running'|'done'}, previewMode: boolean}
GET /api/buyers/discovery-status?heading&countries → {[country]: status}   // polled every 5 s by the UI, for at most 3 minutes
```
`SearchRowDto = {companyId, name, city, country, buyerType, buyerTypeConfidence, evidenceSummary, strongestSourceType, lowConfidence: boolean, lastActivity, trustLevel, contactTypes, sanctionsWarning: boolean, decision.allowed}`.

**Rules:**
- An empty `countries` list → `VALIDATION` "choose at least one country". More than 10 → `VALIDATION`.
- `lowConfidence = strongest evidence confidence < 0.6 OR source type is website only` [tunable]. The row shows a "lower confidence" label (REQ-024).
- Discovery trigger: for each country where `total_in_country < 10` and `coverage.label != 'strong'` → enqueue IF-20a `on_demand`. Status is read from the `platform.job` state for that idempotency key.
- Anonymous: `guardAnonymous('search_preview')`. M10 applies anonymous redaction and the response has `previewMode=true`. The UI shows the count, the first 5 names and a SignupGate.
- `keyword` is matched with `websearch_to_tsquery('simple', unaccent(keyword))`, and at most 100 characters are accepted.
- Relevance ranking = `ts_rank` × evidence confidence × source weight (customs 1.0, website 0.7).

---

## M27: Buyer profile
**REQs:** REQ-021, REQ-017, REQ-022, REQ-024, REQ-027, REQ-028, REQ-029.

**API (IF-27a):** `GET /api/buyers/:companyId?workspaceId=` → `{profile: ProfileDto, decision: PolicyDecision, redFlags: RedFlag[], revealed: boolean, shortlistEntry?: {...}}`.

**Rules:**
- The company id is resolved through `v_company_redirect`. If it redirects, the response has `redirectedFrom`.
- `hidden` → `NOT_FOUND`. There is one exception: when the user's own hide is the only reason, return `404` with `details.userHidden=true` so the UI can offer an "unhide" link.
- A sanctions block → the profile is returned with `sanctionsWarning`, and the reveal and draft buttons are disabled with an explanation key.
- Sourcing: `unknown` renders as "No shipment data available", which is different from "No".
- Red flags come from `M32.evaluateContextual(profile)`.
- Anonymous visitors → `SIGNUP_REQUIRED`.

---

## M28: Credits ledger and price catalogue
**REQs:** REQ-054, REQ-034, REQ-051.

**Schema (`ledger`):**
```sql
account_balance_acct(account_id uuid pk);   -- one row per account; locked with FOR UPDATE to serialise ledger writes
entry(id uuid pk, account_id uuid, txn_id uuid, kind text check in ('grant','topup','hold','commit','release','refund','expiry','adjustment'),
  bucket text check in ('available','held','spent','system'), credits int /* signed */, action_type text null, action_ref text null,
  catalogue_version text null, refers_to uuid null, idempotency_key text, expires_at timestamptz null, created_at,
  unique(account_id, idempotency_key, bucket));
-- each txn_id's credits sum to 0 across buckets (double entry); enforced by a deferred constraint trigger
balance_cache(account_id uuid pk, available int, held int, updated_at);
allowance_usage(account_id uuid, period text /* 'YYYY-MM' IST */, kind text, used int, primary key(account_id, period, kind));
```

**Price catalogue:** `/config/prices.yaml` holds `{version, effective_from, actions: {reveal: 1, reveal_bulk_each: 1, check_buyer: 0|1, export_row: 0}, country_multipliers: {US: 1}}`. It is loaded at boot and served by `GET /api/prices`.

**API (IF-28a/b/c):**
```ts
quote(ctx, action: PriceAction, {country?, quantity=1}): {credits: number; catalogueVersion: string};
hold(ctx, {credits, actionType, actionRef, idempotencyKey, ttlSec=300}): Promise<HoldId>;    // INSUFFICIENT_CREDITS if available < credits
commit(ctx, holdId, {credits?}): Promise<void>;          // credits ≤ held amount; any remainder is released
release(ctx, holdId): Promise<void>;
refund(ctx|system, {refersTo: commitEntryId, credits, reason, idempotencyKey}): Promise<void>;   // Σ refunds ≤ committed
grant(system, {accountId, credits, kind:'grant'|'topup'|'adjustment', expiresAt?, idempotencyKey, reason}): Promise<void>;
balance(ctx): Promise<{available: number; held: number}>;
consumeAllowance(ctx, kind: 'reveal'|'check', n=1): Promise<boolean>;   // true = covered by the free allowance, so no credits are needed
allowanceRemaining(ctx): Promise<Record<kind, number>>;
getCatalogue(): PriceCatalogue;
```

**Rules:**
- Each operation runs in one tx that locks the account row. Every operation is keyed by its idempotency key. A replay with identical params is a no-op; different params → `CONFLICT`.
- Expired holds: a sweeper job runs every minute and releases any hold whose `expires_at` has passed and that has no commit or release.
- `commit` on an expired or released hold → `CONFLICT`. M29 must re-hold.
- Monthly Free grant: on the 1st at 00:05 IST, grant `free.monthly_credits` [tunable, 10] with `expires_at` = the end of the month, keyed `free:<acct>:<YYYY-MM>`. Expiry writes `expiry` entries for any unspent granted credits, using FIFO consumption by `expires_at`.
- Usage history: `GET /api/credits/history?cursor` returns the entries grouped by `txn_id`.

---

## M29: Contact reveal
**REQs:** REQ-032, REQ-033, REQ-034, REQ-029, REQ-054.

**Schema:**
```sql
serving.reveal(id uuid pk, account_id uuid, company_id uuid, state text check in ('pending','done','failed'), hold_id uuid, commit_entry_id uuid null,
  catalogue_version text, created_at, unique(account_id, company_id) where state='done');
serving.reveal_contact(reveal_id uuid, assertion_id uuid, kind text, value_enc bytea /* encrypted with a KMS data key */, deliverability text, checked_at, primary key(reveal_id, assertion_id));
```

**API (IF-29a/b):**
```
POST /api/reveal {companyId, idempotencyKey} → {revealId, contacts: [{assertionId, kind, value, deliverability, checkedAt, stale:boolean}], creditsCharged}
POST /api/reveal/bulk {companyIds (≤ entitlements.bulkRevealMax), idempotencyKey, confirmedCredits} → {results: [{companyId, status:'done'|'failed'|'already', reason?}], creditsCharged}
```
```ts
revealedContacts(ctx, companyIds?): Promise<RevealedContact[]>;   // IF-29b (decrypted)
```

**Sequence (single reveal):**
1. Already revealed (a `done` row exists) → return the stored values. No charge, and the response says `already:true`.
2. `M10.assertAllowed(ctx,'reveal',companyId,'reveal')`.
3. `consumeAllowance('reveal')`. If it returns false → `quote` + `hold`, where the idempotency key is `reveal:<acct>:<company>:<clientKey>`.
4. `M17.screen({companyId})`. A `hit` or `possible` → release, then `SANCTIONS_BLOCKED`. Unavailable → release, then `UPSTREAM_UNAVAILABLE`.
5. Load the contact slots, then each value from `v_contact_value` using the `app_reveal` role. Slots with `checked_at` older than 90 days → `reverify` RPC. Outcomes:
   - `invalid` → excluded.
   - `unknown` / timeout → included with `stale:true`, deliverability `unknown`.
6. Zero deliverable contacts remain (all invalid, or no slots) → release (or undo the allowance) and return `{contacts: [], creditsCharged: 0, reason:'NO_VALID_CONTACTS'}`.
7. Insert `reveal` + `reveal_contact` and `commit` the hold in the same tx. The credit is charged only after the values are ready.

**Allowance undo:** `consumeAllowance` and its undo are both keyed by the reveal id.

**Bulk:**
- `confirmedCredits` must equal `quote('reveal_bulk_each', quantity = number of not-yet-revealed ids)`. Otherwise → `CONFLICT {expected}`, and the UI re-confirms.
- One hold covers the total. Each company then runs steps 2 and 4–7 with a per-company commit of its share. At the end, the remainder is released.
- Companies are processed with a concurrency of 4, and the request must finish within 60 s. If the batch is large, the request is processed as a job and the UI polls `GET /api/reveal/bulk/:id`.

---

## M30: Reports and automatic refunds
**REQs:** REQ-025, REQ-034, REQ-064.

**Schema:**
```sql
serving.user_hide(account_id uuid, target_kind text check in ('company','assertion'), target_id uuid, created_at, primary key(account_id, target_kind, target_id));
serving.report(id uuid pk, account_id uuid, company_id uuid, assertion_id uuid null, reason text check in
  ('wrong_product','not_buyer','closed','invalid_contact','suspicious'), note text null check (length(note) ≤ 1000), reveal_id uuid null,
  state text check in ('open','reverifying','refunded','review','closed'), created_at);
```

**API (IF-30a):** `POST /api/reports {companyId, assertionId?, reason, note?}` → `{reportId, hidden: true, refundStatus?: 'pending'|'not_applicable'}`. `DELETE /api/hides/:kind/:id` removes a hide.

**Rules:**
- A report always hides the target for that user, immediately. It does this by inserting `user_hide` in the same tx, which is what the IF-30b provider reads. The report also emits EV-13.
- `invalid_contact` with a matching `reveal_contact` from **this account** → `state='reverifying'`, and M25 re-verify runs as a job.
  - On EV-06 **ContactInvalidated** for that assertion → `refund(refersTo=reveal.commit_entry_id, credits = the per-contact share, rounded up to 1, idempotencyKey = 'refund:<revealId>:<assertionId>')`. The report becomes `refunded`, and the user is notified (in-app banner now, M41 later).
  - On **ContactVerified**, or if M25 reports `unknown` after 24 h: check the cap, `refunds_unconfirmed_per_month = 3` [tunable]. Under the cap → refund. Over the cap → file `report.refund_exception`.
- `invalid_contact` without a reveal → no refund. The negative signal only raises the re-verification priority.
- `not_buyer`, `wrong_product`, `closed` and `suspicious` → file `report.content`, deduped per `(company, reason)` with a counter in the payload. Outcomes:
  - `apply` → IF-09b (`report_not_buyer {hs_heading}` or `report_closed`).
  - `dismiss`.
- Reports are rate-limited to 30 per account per day.

---

## M31: Public removal and correction page
**REQs:** REQ-037, REQ-064.

**API (IF-31a):**
```
POST /api/public/removal {requesterEmail, kind:'removal'|'correction', identifiers: {domain?, email?, phone?, companyName?, country?}, details ≤2000, turnstileToken}
  → 202; a verification email with a 24 h token is sent
GET  /api/public/removal/verify?token= → the item is filed (review type 'removal.request', dedupe key = sha of the normalised identifiers)
```

**Outcomes:**
- `approve_removal` → in one tx: `M10.suppress(identifiers + matched company ids, 'removal_request', itemId)`, then an email to the requester (`removal.confirmed`).
- `approve_correction {attribute, value}` → IF-09b `operator_correction`.
- `reject {reasonKey}` → an email to the requester.

**Rules:**
- The requester's email must be on the same domain as the identifier being removed. Otherwise the item is flagged `needs_identity_check` for the operator; it is still filed.
- Target SLA: 72 h.

---

## M32: Check a buyer
**REQs:** REQ-030, REQ-031, REQ-051.

**API (IF-32a):**
```
POST /api/check {name?, email?, website?, country?, messageText? ≤ 4000} (at least one of name/email/website)
→ {trust: TrustResultDto, sanctions: 'clear'|'possible'|'hit'|'unknown', redFlags: RedFlag[], adviceKeys: string[], matchedCompanyId?: string, creditsCharged}
```
```ts
// IF-32b
evaluateRedFlags(input: {email?, website?, name?, messageText?, domainSignals?}): RedFlag[];
evaluateContextual(profile: ProfileDoc): RedFlag[];
// RedFlag = {id, severity:'high'|'medium', explanationKey, guideSlug}
```

**Red-flag rules (v1):**

| id | trigger |
|---|---|
| `advance_fee` | regex over messageText: registration / processing / membership fee, pay before order |
| `cert_fee_trap` | a demand for certification or lab-test fees from a specific agency |
| `freemail` | the email domain is on the free-mail list |
| `new_domain` | domain age < 180 days |
| `name_domain_mismatch` | token similarity between the name and the domain < 0.3 |
| `urgent_large_order` | urgency words + large quantity or value patterns |
| `sample_only` | free samples requested with no order discussion |

**Rules:**
- Anonymous visitors: `guardAnonymous('check')`, 1 free check per day.
- Users: `consumeAllowance('check')`. If none is left → credits, via the quote/hold/commit flow.
- Match to the catalogue: look up the domain or registry anchors through M09. This lookup goes through an M10 `byIds` wrapper, because M32 cannot query anchors directly; M10 adds `matchByIdentifiers(ctx, {domain?, email?}) → companyId|null`. If there is a match, `matchedCompanyId` links to the profile.
- The input is stored in `serving.check_run(id, account_id, input_enc, result jsonb, created_at)` for the user's history. **Nothing is written to knowledge.**

---

## M33: Pipeline: shortlists, statuses and notes
**REQs:** REQ-045, REQ-046, REQ-008, REQ-047.

**Schema:**
```sql
serving.shortlist_entry(id uuid pk, account_id uuid, workspace_id uuid, company_id uuid, status text check in
  ('to_contact','contacted','replied','in_discussion','sample_sent','order_won','not_interested') default 'to_contact',
  next_action_at timestamptz null, created_at, updated_at, unique(workspace_id, company_id));
serving.status_history(id uuid pk, entry_id uuid, from_status text, to_status text, source text check in ('user','auto_draft'), at);
serving.note(id uuid pk, entry_id uuid, body text check (length(body) ≤ 5000), created_at, updated_at);
```

**API (IF-33a):**
```
POST /api/workspaces/:ws/shortlist {companyIds: string[] ≤ 200} → {added, alreadyPresent, denied: [{companyId, reason}]}
PATCH /api/shortlist/:id {status?, nextActionAt?} ; POST/PATCH/DELETE /api/shortlist/:id/notes
GET /api/workspaces/:ws/shortlist?status ; GET /api/my-buyers?status&workspaceId
```

**Rules:**
- Adding runs `M10.byIds(ctx,'profile',ids)`. Hidden companies are denied. Sanctions-flagged companies are allowed, and they carry a warning.
- Any status transition is allowed (it is the user's pipeline). Setting the same status is a no-op. Each change writes history and emits EV-08.
- EV-09 handler: if the status is `to_contact` → set it to `contacted` with source `auto_draft`. If the status is already further along, do nothing.
- Reads resolve company ids through the redirect view. Two entries that merge into the same company are both shown, with a "duplicate" hint.

---

## M34: Outreach drafting: first contact
**REQs:** REQ-038, REQ-039, REQ-040, REQ-029.

**Schema:**
```sql
serving.draft(id uuid pk, account_id uuid, workspace_id uuid, entry_id uuid, kind text check in ('first','follow_up_1','follow_up_2','whatsapp_intro'),
  language text, tone text check in ('formal','friendly'), body_generated text, footer text, body_edited text null, model text,
  thread_parent uuid null, left_via text null check in ('copy','mailto','wa'), left_at timestamptz null, created_at);
```

**API:**
```
POST /api/drafts {entryId, language:'en'|<ISO-639-1 of the buyer country's primary language>, tone} → SSE stream: data:{delta} … event:footer data:{footer} event:done data:{draftId}
PATCH /api/drafts/:id {bodyEdited} ; POST /api/drafts/:id/handoff {via} → 204 (IF-34c, emits EV-09)
```
```ts
buildFooter(profile: BusinessProfile, buyer: {country: string; evidenceSourceTypes: string[]}, language): string; // IF-34b, pure function
```

**Sequence:**
1. `assertAllowed(ctx,'draft',companyId,'draft')`.
2. `M17.screen` must return clear. Anything else → error, and nothing is generated.
3. Build the prompt:
   - The business profile (name, product, city).
   - The HS description.
   - At most 5 **company-level** evidence snippets.
   - The buyer's company name and country.
   - Never a contact value or a person's name.
   - The instruction: "no claims of certification or verification not present in the profile; no footer".
4. `stream(tier:'draft', piiFree:false)`.
5. When the stream ends, append the footer.

**Footer (in code, from templates in M37):**
- Sender name and business name.
- City and state, and the IEC if present.
- The opt-out line: "Reply 'unsubscribe' and I won't contact you again".
- **If the buyer's country is in the EU/EEA, the UK or CH**, add: "I found your company through <joined source-type labels, e.g. 'your public website', 'public trade records'>".

**Rules:**
- Business profile incomplete (no business_name or sender_name) → `VALIDATION {missing: [...]}`.
- The draft is stored after the stream finishes. If the client disconnects, the draft is stored anyway.
- Rate limit: 50 drafts per account per day [tunable].

---

## M35: Export to Excel/CSV
**REQs:** REQ-048.

**API (IF-35a):**
```
POST /api/exports {source: {shortlist: {workspaceId, status?}} | {search: SearchQuery}, format:'xlsx'|'csv'} → 202 {exportId}
GET /api/exports/:id → {state:'queued'|'running'|'ready'|'failed'|'cancelled', rows?, downloadUrl? (S3 pre-signed, 15 min), expiresAt}
```

**Schema:**
```sql
serving.export(id uuid pk, account_id uuid, source jsonb, format text, state text, row_count int, s3_key text, canary_ids text[], created_at, expires_at /* +7 d */);
```

**Job `m35.build`:**
1. Rows come from `M10.search(ctx,'export',q)` or `M10.byIds(ctx,'export',ids)`.
2. For each row, drop the fields listed in `redactedFields`. Contact columns are filled **only** from `revealedContacts(ctx)`.
3. The row cap is `entitlements.exportRowsPerMonth` minus this month's usage. If a file would exceed it, the export is truncated and a "limit reached" note row is added.
4. Watermark:
   - A header row: "Exported by <account id short> on <date>".
   - A hidden sheet with the account id.
   - 1 canary row per export, a synthetic company tied to the account id (record the canary ids).
5. The file goes to `s3://exports/<acct>/<id>`. S3 lifecycle deletes it after 7 days.

**EV-04 handler:** cancel exports in `queued` or `running` state. Delete `ready` files whose source contained a suppressed company. The check uses a `company_ids` list kept alongside each export.

---

## M36: Plans, subscriptions and billing (Razorpay)
**REQs:** REQ-052, REQ-053, REQ-051, REQ-054.

**Config:** `/config/plans.yaml` holds per-plan `{priceInrMonthly, priceInrAnnual, razorpayPlanId, monthlyCredits, entitlements}`.

**Schema:**
```sql
serving.subscription(id uuid pk, account_id uuid unique, plan text, cycle text, razorpay_sub_id text unique, status text check in
  ('created','authenticated','active','pending','halted','cancelled','completed'), current_period_start, current_period_end, cancel_at_period_end bool, updated_at);
serving.payment(id uuid pk, account_id uuid, razorpay_payment_id text unique, amount_paise bigint, status text, invoice_id uuid null, created_at);
serving.webhook_event(razorpay_event_id text pk, type text, payload jsonb, received_at, processed_at timestamptz null);
serving.invoice(id uuid pk, account_id uuid, number text unique /* 'INV/FY26-27/000123' */, gstin text null, place_of_supply text,
  taxable_paise bigint, cgst_paise bigint, sgst_paise bigint, igst_paise bigint, pdf_s3_key text, issued_at);
serving.billing_details(account_id uuid pk, legal_name text, gstin text null check (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'), state_code text, address text);
```

**API:**
```
GET /api/plans ; POST /api/billing/checkout {plan, cycle} → {razorpaySubscriptionId, keyId}
POST /api/billing/cancel {atPeriodEnd: true} ; POST /api/billing/update-method → {shortUrl}
POST /webhooks/razorpay (raw body; header X-Razorpay-Signature) ; GET /api/invoices ; GET /api/invoices/:id/pdf
```

**Webhook rules:**
1. Verify `HMAC_SHA256(webhook_secret, raw_body)` with a constant-time compare. On failure → 400, logged.
2. `INSERT webhook_event … ON CONFLICT DO NOTHING`. A duplicate → 200 and no processing.
3. Handle the events:
   - `subscription.activated` and `subscription.charged` → set status and period. Emit EV-10. The M28 grant uses idempotency key `plan:<sub>:<period_start>`, and the credits expire at `period_end + 30 d` [tunable].
   - `payment.captured` → payment row + invoice.
   - `subscription.halted` or `cancelled` → the entitlements fall back to Free at `period_end`. Halted means immediately.
4. Return 200 within 5 s. Heavy work runs as a job.

**Other rules:**
- Invoice: IGST if the place of supply ≠ the supplier's state, otherwise CGST+SGST at 9% each (18% total). Invoice numbers come from a DB sequence, one per financial year. The PDF is rendered from an HTML template [open: GST invoicing route].
- Reconcile: a daily job lists Razorpay subscriptions updated in the last 48 h. A status mismatch → file `billing.mismatch`.
- `IF-36c` = the entitlements provider registered with M10: `get(accountId)` → the plan entitlements when the subscription is active, otherwise Free. Cached for 60 s; EV-10 invalidates the cache.

---

## M37: Content, Learn and promise pages
**REQs:** REQ-059, REQ-031, REQ-044, REQ-065, REQ-066.

**Decision:** Markdown in the repo, at `/content/<locale>/<section>/<slug>.md`. Each file has front-matter `{title, key, hsChapters?: string[], version, reviewedBy?, reviewedAt?}`. Files are built into a static index at deploy. Microcopy keys (trust wording, footers, coverage explanations) live in `/content/<locale>/strings/*.json`.

**API (IF-37a):**
```ts
getPage(locale, slug); listBySection(locale, section); byHsChapter(locale, chapter); string(locale, key, params?)
```
Pages: `/learn/*`, `/glossary`, `/scam-red-flags`, `/first-export-checklist`, `/promise`, `/coverage` (built from `coverage_cell` aggregates), `/refund-policy`, `/pricing`.

**Rules:**
- Prices are interpolated with `{{price:reveal}}` tokens that resolve through IF-28c at render time. A build check fails on any hardcoded "₹" or "credit" number inside the promise, refund and pricing pages.
- Missing locale → fall back to `en`.
- Trust wording keys must have `reviewedAt` set before prod deploy; CI enforces this for the `trust.*` keys (legal review open question).

---

## M38: User data rights
**REQs:** REQ-061.

**API:**
```ts
// IF-38a
registerContributor({module: string; export(accountId): Promise<{files: {name; json: unknown}[]}>; erase(accountId): Promise<{retained?: string[]}>; order: number}): void;
```
```
// IF-38b
POST /api/me/data-export → 202 {requestId} ; GET /api/me/data-export/:id
POST /api/me/delete {confirm: 'DELETE'} → 202 ; POST /api/me/consent/withdraw {purpose}
GET /grievance (the grievance officer's contact, from M37)
```

**Schema:**
```sql
serving.rights_request(id uuid pk, account_id uuid, kind text check in ('export','erase'), state text, zip_s3_key text null, created_at, completed_at);
```

**Rules:**
- **Export:** run every contributor's `export` as a job. Zip the results to S3 and keep them 7 days; the download link is pre-signed for 24 h. Notify the user by email.
- **Erase:**
  1. Set `account.status='deleting'`, revoke all sessions, cancel the subscription (M36).
  2. Run contributors in `order` (M34 drafts, M33, M29 reveals, M32, M35, M30, M41…, then M07, M06 last).
  3. Retention exceptions:
     - M28 keeps the ledger rows, and the `account_id` stays because it is a uuid with no personal data.
     - M36 keeps invoices for 8 years. Their personal fields (address, legal name) are kept as the law requires; this is noted in the retention list.
     - M06 keeps the consent history, since it is proof of consent. The member row is replaced by an `erased` marker.
  4. Set `account.status='deleted'`.
  5. Target completion: 30 days. In practice this is immediate, with jobs retrying on failure.
- Failed contributors dead-letter to M11. The request stays `running` until all contributors succeed.

---

## M39: Launch hardening
**REQs:** REQ-057, REQ-028, REQ-066, REQ-004, REQ-051.

Deliverables (checklists and code):
1. A Playwright suite on a Moto G Power emulation over throttled 4G, covering Flows 1, 2 and 4. It asserts the §10 budgets: search p95 < 1.5 s, reveal < 3 s (fresh), first draft token < 3 s and completion < 10 s.
2. `k6` load test: 50 RPS search for 10 minutes with p95 < 1.5 s.
3. Anti-scrape:
   - Per-account search pages capped at 200/day on Free and 2000/day on paid [tunable].
   - Sequential-page velocity detection (more than 30 pages in 5 minutes) → challenge.
   - Export canaries are monitored by a web-search alert job, which runs monthly.
4. Degraded-mode tests with each vendor mocked down:
   - Search API down → "finding more" becomes "try later".
   - Email verifier down → `unknown` deliverability.
   - LLM down → HS vector-only mode, and drafts return `UPSTREAM_UNAVAILABLE`.
   - Sanctions RPC down → reveal and draft blocked, with a clear message.
5. Cost-per-credit dashboard: a SQL view `analytics.v_cost_per_credit` = sum of `cost_event` by `credit_ref`, joined to ledger commits.
6. Activation metric: `analytics.activation(account_id, saved_count, drafted bool, activated_at)`, fed by EV-08 and EV-09.
7. Wording audit: a CI grep across `/content`, `/apps/web/messages` and the templates for `verified genuine|guaranteed buyer|100% genuine`. Any match fails the build.

---

## M40: HS version change re-confirmation
**REQs:** REQ-009.

**EV-12 handler:**
- For each workspace whose `hs_version` ≠ the new current version: `correlate(old, code, new)`.
  - `1:1` with the same code → update silently and log it.
  - Otherwise → `hs_needs_reconfirm=true`.
- `GET /api/hs/reconfirm` → `[{workspaceId, oldCode, candidates:[{code, relation}]}]`.
- `POST /api/workspaces/:id/hs/reconfirm {code}` → `setHsCode` and clear the flag.
- A banner appears on the workspace until the user reconfirms. Saved searches keep working on the old heading via the correlation.

---

## M41: Reminders, notifications and dashboard
**REQs:** REQ-047, REQ-049.

**Schema:**
```sql
serving.reminder(id uuid pk, account_id uuid, entry_id uuid, due_at timestamptz, kind text, state text check in ('pending','fired','done','snoozed'), created_at);
serving.notification(id uuid pk, account_id uuid, kind text, title_key text, params jsonb, company_id uuid null, read_at timestamptz null, created_at);
serving.notify_pref(account_id uuid pk, email bool default false, whatsapp bool default false);
```

**API:**
```ts
// IF-41a
createReminder(ctx, entryId, dueAt, kind); snooze(ctx, id, until); complete(ctx, id);
// IF-41b
notify(accountId, {kind, titleKey, params, companyId?}): Promise<void>;
```
`notify` checks M10 `byIds(systemCtxFor(account),'notify',[companyId])` and drops the notification if the company is hidden. It writes the in-app row. If `email` is on and `marketing`-class consent is not required for this transactional kind, it sends email via M05's `sendTransactionalEmail` from the subdomain `notify.<domain>`, which has SPF/DKIM/DMARC set up. If `whatsapp` is on and M50 exists, it sends via WhatsApp.

**Scheduler:** every 5 minutes, fire reminders with `due_at ≤ now`.

**Dashboard (IF-41c):** `GET /api/dashboard` → `{pipelineCounts: {status: n}, remindersDue: [...], savedSearchHits: [...], balance}`. It is computed live; the queries are indexed.

---

## M42: Follow-up drafts
**REQs:** REQ-041.

`POST /api/drafts/:parentId/follow-up` → an SSE stream, the same as M34, with `kind = follow_up_1|2`. Thread context = the parent draft's `body_edited ?? body_generated`.
- At most 2 follow-ups per thread.
- Suggested timing: +5 days and +12 days after `left_at` [tunable]. After a follow-up leaves the product, `createReminder` is called for the next one.
- The same policy, sanctions and footer steps as M34 apply.
- Status `replied`, or anything further along → `CONFLICT` "buyer already replied".

---

## M43: Money-back requests
**REQs:** REQ-055.

`POST /api/billing/money-back {reason}`:
- Eligible only for the first paid payment, and only within `money_back_days = 7` [tunable, to match the M37 policy page]. Otherwise → `FORBIDDEN {reasonKey}`.
- Files `billing.money_back` (dedupe per payment). Outcome `approve`:
  1. Razorpay refund API (idempotent via the `receipt`).
  2. Cancel the subscription immediately.
  3. M28 `adjustment` removing the remaining granted credits for the period.
  4. Email to the user.
- Outcome `reject {reasonKey}` → email to the user.

---

## M44: Outcome events
**REQs:** REQ-050.

EV-08 handler → `analytics.outcome_event(id, account_id, company_id, hs_heading, country, from_status, to_status, at)`, written only for `to_status ∈ {replied, in_discussion, order_won}`. Nothing else is written, and there is no personal data.

---

## M45: Saved searches and alerts
**REQs:** REQ-026.

**Schema:**
```sql
serving.saved_search(id uuid pk, account_id uuid, workspace_id uuid, query jsonb, name text, last_run_at, last_seen_company_ids uuid[], alert bool default true);
serving.saved_search_hit(id uuid pk, saved_search_id uuid, company_id uuid, found_at, seen bool default false);
```
- At most 10 saved searches per account on Free and 50 on paid.
- A daily job re-runs each saved search through `M10.search(ctx,'alert',q)`. New ids not in `last_seen` become hits, capped at 20 per run. It then calls `notify`.

---

## M46: Credit top-up packs
**REQs:** REQ-056.

- Packs are defined in `/config/topups.yaml` as `{id, credits, priceInr}`.
- `POST /api/billing/topup {packId}` → a Razorpay Order with `notes.accountId` and `notes.packId`. The response returns the order id.
- Webhook `payment.captured` with `notes.packId` → `grant(kind:'topup', idempotencyKey:'topup:<payment_id>')`. Top-up credits expire after 12 months, plus an invoice.

---

## M47: IEC verification and badge
**REQs:** REQ-003.

- `POST /api/profile/iec/verify` runs `DgftIecLookup` if it is configured (a source register entry is required). Otherwise it files `iec.verify` with the IEC and the business name.
- Outcome `verified` → `business_profile.iec_verified_at = now()`.
- The badge shows while `iec_verified_at` is not null. IF-34b adds "IEC <code> (verified)" to the footer only when the IEC is verified.
- Editing the IEC clears `iec_verified_at`.

---

## M48: Similar buyers
**REQs:** REQ-023.

- `search_doc` gets a new column `embedding vector(1024)`. It is built from `buyer_type + evidence summary + country`, and the projection builder writes it.
- `similar(ctx, companyId, k=6)` = the nearest neighbours with the same `hs_heading`. Candidate ids go through `M10.byIds(ctx,'similar',...)`, and any hidden results are dropped.
- It is shown on M27 for users only.

---

## M49: Outreach extras: WhatsApp and one-pager
**REQs:** REQ-042, REQ-043.

- **One-pager:** `serving.company_intro(account_id pk, products text, moq text, certifications text[], incoterms text[], updated_at)`, edited in the profile. M34 includes it in the prompt when it is present.
- **WhatsApp:**
  - Shown only when a revealed `contact.whatsapp` exists, from IF-29b.
  - The link is `https://wa.me/<digits>?text=<urlencoded intro ≤ 1000 chars>`. The intro is a draft of `kind='whatsapp_intro'`.
  - Clicking the link → IF-34c with `via='wa'`.
  - The footer opt-out line is shortened.

---

## M50: WhatsApp notifications and support (opt-in)
**REQs:** REQ-060.

- `IF-50a sendTemplate(accountId, templateName, params)`.
- It requires M06 consent `whatsapp`, **and** a phone number on the member. Otherwise it is a silent no-op.
- It uses a BSP adapter (vendor still open) with approved templates `reminder_due_v1` and `saved_search_hits_v1`.
- The BSP's inbound webhook handles a STOP keyword → `withdrawConsent('whatsapp')`.
- Support entry point: a static `wa.me` link to the support number.

---

## M51: Hindi localisation
**REQs:** REQ-058.

- Add `/apps/web/messages/hi.json`, with the same key set as `en.json`. A CI check requires key parity; missing keys fail the build.
- Add `/content/hi/**` for core Learn pages. Missing pages fall back to English.
- Locale switcher: saved on the member as `member.locale` (a column is added) and in a cookie for anonymous visitors.
- Numbers and currency use the `en-IN` or `hi-IN` Intl formatting.
- Drafts are unaffected; M34's language is chosen separately.

---

## M52: Teams and consultant workspaces
**REQs:** REQ-063.

- Allow multiple `member` rows per account through a new `serving.membership(member_id, account_id, role, primary key(member_id, account_id))` table. `member.account_id` becomes the default account.
- Invitations: `serving.invite(id, account_id, email, role, token_hash, expires_at, accepted_at)`, valid for 7 days.
- Account switcher: `POST /api/session/account {accountId}` updates `ctx.accountId` after checking membership.
- Roles:
  - `owner`: billing, members, everything else.
  - `member`: everything except billing and members.
  - `consultant`: member rights on each client account.
- Per-client credits come naturally from the M28 per-account ledger, because each client is its own account. This supersedes the HLD's sub-balance idea (see Assumptions).

---

## M53: Additional licensed buyer sources
**REQs:** REQ-022, REQ-015, REQ-018.

- `CustomsInShippingBillConnector` and `CustomsLatamConnector(country)` follow the M21 pattern. Each needs a source register entry, and the Indian one also needs **provenance sign-off recorded in `source.notes`** before `status='active'`.
- Aggregates are written with `origins` populated. For LATAM, the same `activity_aggregate` attribute is used, so `origin_india` becomes `yes` or `no` for non-US buyers with no serving changes.
- M15 treats them as `customs` source type, so the coverage label can reach **strong**.

---

## Resolutions of HLD open questions
| HLD OQ | Resolution |
|---|---|
| 1 ESP ownership | M05 owns the ESP and SMS clients (`sendTransactionalEmail`, `sendSms`). M41 wraps them. |
| 2 Invalid contacts | A negative assertion only. No suppression (M25). |
| 3 Merge follow-through | Resolved at read time through `v_company_redirect`. No rewrites (M09). |
| 4 Trust recompute scope | Triggered only by the attribute classes listed in M24. |
| 5 Coverage recompute | Per cell on EV-05, plus a nightly full recompute (M15). |
| 6 Search engine migration | The `SearchQuery` DSL is compiled only in `m10/readModelStore.ts`. |
| 7 REQ-035 | `named_person` writes are rejected in M09. M22 discards personal emails. |
| 8 REQ-022 unknown vs no | The tri-state `origin_*` fields (M09) are rendered distinctly (M27). |

## Assumptions and open questions (LLD)
1. The stack choices are Next.js, Fastify, Kysely, dbmate, FastAPI and rapidfuzz. They can be swapped without changing any interface.
2. An `embed` tier was added to M03, because M12 and M48 need embeddings. The embedding dimension is 1024 [depends on the chosen model].
3. `possible` sanctions matches are blocked until review (fail-safe). The sanctions RPC fails closed for reveal and draft.
4. M10 is given `DELETE` on the knowledge read-model tables, for the zero-window suppression purge. This is the only serving→knowledge write, and it is documented here as a deliberate exception to HLD rule 2.3.
5. M32 needs an identifier-match helper in M10 (`matchByIdentifiers`), because M32 cannot read anchors directly.
6. M52 uses one account per client with membership, not ledger sub-balances. This departs from HLD assumption 5, and is simpler because the ledger is already per account.
7. The following numbers are **[tunable]** config defaults and need product sign-off:
   - Anonymous and Free caps.
   - Refund cap (3/month).
   - Freshness thresholds (90 days and 180 days).
   - Sanctions thresholds (95 and 85).
   - Coverage thresholds (50 and 10).
   - Discovery precision bar (0.8).
   - Money-back window (7 days).
8. Still open from earlier stages: the US customs vendor (M21), the GST invoicing route (M36), legal review of the trust wording (M24/M37), the WhatsApp BSP (M50), and the DGFT IEC lookup availability (M47).

## Modules not yet specified
None. I checked every module ID in `docs/implementer.md` (M01 to M53) against the sections above, and each one has its own spec section. REQ-035 is the only requirement with no module in the implementer plan, and that was deliberate. It is handled only as guard rails, in M09 and M22.
