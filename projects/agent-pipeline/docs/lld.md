<!-- Written by: low-level-design stage. Read by: spec-implementer. -->

# Low-Level Design: Idea-to-Tested-Software Pipeline

**Summary**
- Implementation-ready specs for all 36 modules (M01–M36) in `docs/implementer.md`. The target is TypeScript on Node ≥ 20, ESM, strict mode, following `docs/architecture.md`.
- §0 fixes the shared conventions: layout, IDs, the error type, JSONL append, and the common types. Each module section then gives its files, exported signatures, on-disk schemas, algorithms, edge cases and errors, plus the REQ IDs it satisfies.
- This LLD settles the open questions the HLD left to this stage: verb names (HLD OQ1), the issue key (OQ3), smoke subset size (OQ4), the review threshold (OQ5), downstream redo (OQ6) and the prose-section guard (OQ7). The decisions are recorded as LD-n in §Z.
- Only M03 commits, only M06 imports the SDK, and only M18 spawns generated code. Lint rules enforce this (§0.7).

---

## 0. Shared conventions (all modules)

### 0.1 Repository layout
```
src/
  infra/    config.ts (M01) vcs.ts (M03) state/ (M04) ledger.ts (M05) agent/ (M06) sandbox/ (M18)
  knowledge/ doc/ (M02) registry.ts (M07) trace.ts (M08) stale.ts (M09) report/ (M14) decisions.ts (M15)
  work/     stageRunner.ts (M10) stages/ (M11, M19, M20, M21, M34 manifests + prompts) consistency.ts (M16)
            increment.ts (M19) review.ts (M20) e2e/ (M21–M24) critic/ (M30, M31) baseline.ts (M35)
  control/  controller.ts (M12) human.ts (M17) router/ (M25–M29) findings.ts (M32) autoCritic.ts (M33) fastMode.ts (M34)
  cli/      main.ts, verbs/*.ts, render.ts (M13) plugin/ (M36)
  shared/   types.ts errors.ts jsonl.ts ids.ts clock.ts
```
Project-side paths: `docs/`, `src/` (the generated product), `.pipeline/`. All paths are resolved through `Policy.paths` (M01).

### 0.2 ID grammar (`shared/ids.ts`)
```ts
export type IdKind = 'REQ'|'AD'|'T'|'INC'|'E2E'|'F';
export const ID_RE = /\b(REQ|AD|T|INC|E2E|F)-(\d{1,4})\b/g;
export interface Id { kind: IdKind; n: number; }   // canonical string: `${kind}-${n padded to 3 for REQ, else as-is}`
export function formatId(id: Id): string;           // REQ-7 -> "REQ-007"; AD-4 -> "AD-4"
export function parseId(s: string): Id | null;
```
REQ numbers are zero-padded to 3 digits and all other kinds are unpadded. `parseId('REQ-7')` normalises to `REQ-007`.

### 0.3 Errors (`shared/errors.ts`)
```ts
export type ErrCode =
 | 'CONFIG_INVALID' | 'DOC_PARSE' | 'CONTRACT_VIOLATION' | 'GUARD_VIOLATION'
 | 'LOCK_HELD' | 'STATE_CORRUPT' | 'GIT_ERROR' | 'GIT_DIRTY_CONFLICT'
 | 'BUDGET_REFUSED' | 'AGENT_ERROR' | 'PERMISSION_DENIED'
 | 'SANDBOX_UNAVAILABLE' | 'CONSENT_REFUSED' | 'SANDBOX_TIMEOUT'
 | 'PRECONDITION_FAILED' | 'NOT_FOUND' | 'USAGE';
export class PipelineError extends Error {
  constructor(public code: ErrCode, message: string, public detail?: Record<string, unknown>, public retryable = false) { super(message); }
}
```
Rules: L1 modules retry `retryable` errors internally (exponential backoff 1s/4s/16s, max 3), then throw. L3 modules never throw for domain failures. They return a `UnitOutcome` with a status instead. Only programming errors and infrastructure failures that remain after retries propagate as exceptions, and M12 converts those into `Escalation{reason:'infrastructure'}`.

### 0.4 JSONL helper (`shared/jsonl.ts`), used for HLD §10.3
```ts
export async function appendJsonl(path: string, rec: object): Promise<void>;
// Implementation: line = JSON.stringify(rec) + '\n'; fs.open(path,'a') (O_APPEND); single write(); fsync; close.
// Lines > 3500 bytes: take advisory lock `${path}.lock` (O_CREAT|O_EXCL, retry 20×50ms, stale after 5s) around the write.
export async function* readJsonl<T>(path: string): AsyncIterable<T>;
// Skips a truncated/unparseable LAST line silently; an unparseable non-last line -> warn event + skip.
```
Atomic file replace: `writeAtomic(path, data)` writes `path.tmp-<pid>`, fsyncs, then `rename`s.

### 0.5 Common types (`shared/types.ts`)
```ts
export type StageId = string;                 // 'understanding'|'classification'|'discovery'|'design'|'architecture'|'impl-plan'|'implement'|'review'|'e2e'|'brief'
export type Tier = 'strong'|'standard'|'fast';
export type PermissionProfileName = 'read-only'|'docs-write'|'code-write';
export interface LedgerTags { runId: string; stage?: StageId; inc?: string; goBackId?: string; criticSessionId?: string; unitId?: string; }
export type WorkUnitKind = 'stage'|'increment'|'review'|'consistency'|'e2e'|'e2e-regression'|'critic-auto'|'rework-stage'|'rework-increment';
export interface WorkUnit {
  unitId: string;                 // `${kind}:${targetId}` + (`@${decisionId}` if rework)
  kind: WorkUnitKind; targetId: string;      // stage id or INC id
  mode: 'normal'|'revise';
  staleTargets?: StaleItem[];      // revise only
  decisionId?: string;             // rework only (RD-n)
  tags: LedgerTags;
}
export type OutcomeStatus = 'committed'|'failed-verification'|'contract-violation'|'guard-violation'|'budget-stopped'|'error'|'no-change';
export interface UnitOutcome { unitId: string; status: OutcomeStatus; commit?: string; signals: string[]; costUsd: number; detail?: string; }
export interface Executor { execute(u: WorkUnit, ctx: RunContext): Promise<UnitOutcome>; }
export interface RunContext { runId: string; policy: Policy; attended: boolean; signal: AbortSignal; }
```
`no-change` means a revise-mode unit whose output matched the prior hash. It counts as success with no commit.

### 0.6 Time and IDs
`clock.now()` returns an ISO-8601 UTC string and can be injected in tests. The run id format is `r-YYYYMMDD-HHmm-<4 hex>`. Counters for `RD-n` (routing decisions), `I-n` (issues), `S-n` (signals) and `C-n` (critic sessions) are monotonic per project. Each is derived as the max existing id in its store plus 1.

### 0.7 Enforced boundaries
ESLint `no-restricted-imports`: `@anthropic-ai/claude-agent-sdk` is allowed only in `src/infra/agent/**`. `child_process` is allowed only in `src/infra/vcs.ts` (git only) and `src/infra/sandbox/**`. `simple-git`/git spawning is allowed only in `vcs.ts`.

---

## M01 Config & Policy
**REQs:** REQ-003, REQ-027, REQ-037, REQ-049, REQ-070, REQ-071.
**File:** `src/infra/config.ts`. Library: `yaml` + `zod`.

```ts
export interface Policy {
  schemaVersion: 1;
  paths: { docs: string; src: string; pipeline: string };            // defaults 'docs','src','.pipeline'
  budget: { defaultUsd: number; warnAtFraction: number; stageShares: Record<StageId, number>; standaloneCriticUsd: number; };
  tiers: Record<Tier, string>;                                          // model ids
  checkpoints: StageId[];
  router: { maxGoBacksPerRun: number; maxAttemptsPerIssue: number; autoProceedMinConfidence: 'high'|'medium';
            reviewSignalMinSeverity: Severity; smokeSubsetSize: number; };
  handEdit: { unattendedPolicy: 'stop-and-ask'|'accept-and-propagate' };
  sandbox: { mode: 'container'|'local-restricted'; runtime: 'auto'|'docker'|'podman'; image: string;
             cpu: number; memoryMb: number; execTimeoutSec: number; appStartTimeoutSec: number; };
  e2e: { flakeReruns: number; parallelism: number };
  critic: { autoInvoke: 'off'|'after-e2e'; autoInvokeMinBudgetFraction: number };
  attended: boolean;                                                     // default: process.stdout.isTTY
  localRetriesPerIncrement: number;
}
export type Severity = 'info'|'minor'|'major'|'critical';
export interface ResolvedPolicy { policy: Policy; provenance: Record<string, 'default'|'file'|'flag'>; }  // dotted key -> source
export function loadPolicy(projectRoot: string, flags: Partial<FlatFlags>): Promise<ResolvedPolicy>;
export const DEFAULT_POLICY: Policy;
```
**Defaults:** `defaultUsd 25`, `warnAtFraction 0.8`, `stageShares {}` (no per-stage caps), `standaloneCriticUsd 2`, tiers `{strong:'claude-opus-…', standard:'claude-sonnet-…', fast:'claude-haiku-…'}` (the actual ids come from config), `checkpoints []`, `maxGoBacksPerRun 3`, `maxAttemptsPerIssue 2`, `autoProceedMinConfidence 'high'`, `reviewSignalMinSeverity 'major'`, `smokeSubsetSize 5`, `unattendedPolicy 'stop-and-ask'`, sandbox `container/auto/'pipeline-sandbox:1'/2 CPU/4096 MB/600 s/60 s`, `flakeReruns 2`, `parallelism 1`, critic `off/0.15`, `localRetriesPerIncrement 1`.

**Algorithm:** start from the defaults, deep-merge `pipeline.config.yaml` if it exists, then merge flags. Validate with the zod schema. Provenance records which layer set each leaf.
**Flags → keys:** `--budget`→`budget.defaultUsd`, `--unattended`→`attended=false`, `--checkpoint <s>` (repeatable)→`checkpoints`, `--sandbox local-restricted`→`sandbox.mode`, `--max-go-backs`→`router.maxGoBacksPerRun`.
**Validation / errors:** `CONFIG_INVALID` with a zod path is raised for: shares whose sum exceeds 1.0, a share outside [0,1], `warnAtFraction` outside (0,1), a `checkpoints` entry that is unknown to M07 (checked lazily by M12 because M07 may not be loaded yet, as a warning event and not an error), negative caps, or an unknown key (strict).
**Edge cases:** a missing file is not an error. An empty YAML file is treated as `{}`. `budget.defaultUsd = 0` is allowed, and the run stops before its first call.

---

## M02 Document Model & Contract Validator
**REQs:** REQ-004, REQ-011, REQ-012, REQ-020, REQ-021, REQ-022, REQ-023.
**Files:** `src/knowledge/doc/{parse.ts,hash.ts,validate.ts,profiles.ts}`. Libraries: `unified` + `remark-parse` + `remark-gfm`, `yaml`.

```ts
export interface FrontMatter { stage: StageId; run_id: string; generated_from: Record<string, string>; schema_version: 1; }
export interface Section { heading: string; slug: string; level: number; path: string[]; startLine: number; endLine: number; hash: string; blockIds: string[]; }
export interface IdBlock {
  id: string; kind: IdKind; doc: string; sectionSlug: string;
  form: 'heading'|'table-row'|'list-item';
  startLine: number; endLine: number; body: string; hash: string;
  refs: string[];                                    // other IDs cited in body, deduped, excluding own id
  attrs: ReqAttrs | AdAttrs | TaskAttrs | Record<string, string>;
}
export interface ReqAttrs { priority?: 'Must'|'Should'|'Could'; acceptance?: string; }
export interface AdAttrs { status?: 'accepted'|'proposed'|`superseded by AD-${number}`; reqs: string[]; hasContext: boolean; hasDecision: boolean; hasConsequences: boolean; }
export interface TaskAttrs { reqs: string[]; incs?: string[]; }
export interface OpenQuestion { doc: string; index: number; text: string; answered: boolean; answer?: string; line: number; }
export interface StageDocument {
  path: string; headerComment: string | null; frontMatter: FrontMatter | null;
  summary: { lines: string[] } | null; sections: Section[]; blocks: IdBlock[];
  assumptions: string[] | null; openQuestions: OpenQuestion[] | null; docHash: string; raw: string;
}
export function parseDocument(path: string, raw: string): StageDocument;        // never throws on content; throws DOC_PARSE only on invalid YAML front-matter
export function hashText(s: string): string;                                     // sha256 over normalised text, hex first 16
export function normalise(s: string): string;                                    // CRLF->LF, trim trailing ws per line, collapse >1 blank lines, strip trailing blank lines
export interface ContractViolation { rule: string; location: { doc: string; line?: number; id?: string }; severity: 'blocking'|'warning'; message: string; }
export interface ContractProfile { name: string; rules: ContractRule[]; }
export type ContractRule = (d: StageDocument) => ContractViolation[];
export function validate(d: StageDocument, profile: ContractProfile): ContractViolation[];
export const BASE_PROFILE: ContractProfile;
export const RULES: { reqHasAcceptance: ContractRule; reqHasPriority: ContractRule; adIsAdr: ContractRule; taskCitesReq: ContractRule; supportedTypeBlock: ContractRule; };
```
**Document layout expected:** line 1 is the HTML comment `<!-- Written by: … Read by: … -->`. It is followed by a YAML front-matter block delimited by a `---` line pair, placed *after* the comment. Front-matter is optional in hand-authored docs and required in docs produced by the pipeline. Next comes a `**Summary**` paragraph followed by a bullet list, then the H2 sections, which include `## Assumptions` and `## Open questions`.

**ID block extraction:**
- **Heading form:** a heading whose text starts with an ID (`### REQ-007 Title`). The body runs until the next heading of the same or higher level.
- **Table-row form:** a GFM row whose first cell's text starts with an ID. The body is the row's raw text.
- **List-item form:** a top-level list item starting with `**F-3**` or `F-3:`, used for findings.
- **REQ attributes:** `priority` is taken from the text `Priority: Must` or a `(Must)` token. `acceptance` is the text after `Acceptance:` or `When … the system shall …` (EARS), up to the end of that paragraph.
- **AD attributes:** read from the bold labels `Context:`, `Decision:`, `Consequences:`, `Status:` and `REQs:`.
- **Hashing:** the block hash is `hashText(normalise(body))`. The heading line is included, so renaming a title makes the block stale.

**Open questions:** these are the numbered or bulleted items under the `## Open questions` heading. An item counts as `answered` if a line inside it starts with `Answer:` (case-insensitive) or with a blockquote `> `. The text after that marker is the answer.

**BASE_PROFILE rules (all blocking unless noted):**
1. `header-present`: line 1 is an HTML comment.
2. `summary-present` and `summary-max-5`: at most 5 bullet lines.
3. `assumptions-section`.
4. `open-questions-section`. The section may contain "None".
5. `id-wellformed`: a token that looks like an ID but has a bad form, such as `REQ7` or `REQ-07a`, is flagged as a warning.
6. `id-unique`: each ID is defined at most once per doc.
7. `front-matter-valid`: this rule applies only when `requireFrontMatter` is set.

**Stage profiles** (composed in `profiles.ts`):
- `design` = base + `reqHasAcceptance` + `reqHasPriority`.
- `architecture` = base + `adIsAdr`. Each AD needs context, decision, consequences, ≥1 REQ and a status. A superseded AD must name an existing AD.
- `impl-plan` = base + `taskCitesReq`, and every Must REQ in design.md must be cited by at least one T. That cross-doc check is performed by M16/M08, so here it is a warning only.
- `classification` = base + `supportedTypeBlock`. This requires a fenced block ```` ```supported-type ```` containing YAML `{type, support: full|partial|unsupported, driver: web|cli|library|api|none}`.

**Edge cases:**
- A duplicate ID across *different* docs is allowed only as a reference, never as a second definition. This is detected by M08 as `duplicate-definition`.
- IDs inside code fences are ignored.
- IDs inside the HTML comment are ignored.
- An empty doc parses to all-null fields, and validation then reports every missing part.

---

## M03 VCS Gateway
**REQs:** REQ-017, REQ-026, REQ-038, REQ-063 (plus the REQ-020 history read).
**File:** `src/infra/vcs.ts`. It spawns `git` via `execFile` and never uses a shell.

```ts
export interface Trailers { 'Pipeline-Run': string; Stage: string; Refs?: string[]; 'Routing-Decision'?: string; Unit: string; }
export interface CommitInfo { sha: string; subject: string; trailers: Partial<Trailers>; author: string; date: string; }
export class Vcs {
  constructor(root: string, policy: Policy);
  ensureRepo(): Promise<void>;                                    // git init if absent + initial empty commit
  ensureRunBranch(runId: string): Promise<string>;               // creates/checks out pipeline/<runId> from current HEAD; returns branch
  commitUnit(p: { paths: string[]; message: string; trailers: Trailers }): Promise<string>;  // returns sha; 'no-change' -> throws NOT_FOUND? no: returns '' if nothing staged
  findUnitCommit(unitId: string, runId: string): Promise<CommitInfo | null>;
  listRunCommits(runId: string): Promise<CommitInfo[]>;          // oldest first
  diffUnit(sha: string): Promise<string>;                         // `git show --stat -p sha`
  nonPipelineChanges(sinceSha: string): Promise<{ commits: CommitInfo[]; workingTree: string[] }>;
  readAt(rev: string, path: string): Promise<string | null>;
  pathHistory(path: string): Promise<{ sha: string; content: string }[]>;   // capped at 50 revisions
  headSha(): Promise<string>;
  revertUnit(sha: string): Promise<string>;
  workingTreeDirty(paths?: string[]): Promise<string[]>;
}
```
**Commit message format:**
```
pipeline(<Stage>): <subject ≤72 chars>

<optional body>

Pipeline-Run: r-…
Stage: design
Unit: stage:design
Refs: REQ-001, REQ-007, T-3, INC-2
Routing-Decision: RD-4
```
Trailers are written with `git interpret-trailers` semantics, and they are read back with `git log --format=%H%x1f%s%x1f%(trailers:unfold)%x1e`.

**Rules:**
- `commitUnit` stages exactly `paths` with `git add -- <paths>`. It never uses `add -A`.
- `.pipeline/` is gitignored except for `.pipeline/routing.jsonl`, which is committed by M28.
- If nothing is staged, `commitUnit` returns `''`. The caller maps that to `no-change`.
- The author is the configured git user, with committer `pipeline <pipeline@local>`.
- A "pipeline commit" is a commit that has a `Pipeline-Run` trailer. Any other commit on the branch is a user commit.

**Errors:**
- Git failures raise `GIT_ERROR`, retried once only when the index lock exists and is less than 10 s old.
- `ensureRunBranch` raises `GIT_DIRTY_CONFLICT` when the working tree has changes that would be clobbered by a checkout.
- `revertUnit` conflicts are aborted, and the method raises `GIT_ERROR` with detail `conflict`.

**Edge cases:**
- Detached HEAD: branch from HEAD.
- The branch exists already (resume): check it out and don't reset.
- Git ≥ 2.30 is required, and this is checked in `ensureRepo`.

---

## M04 Run State, Event Log & Run Lock
**REQs:** REQ-005, REQ-006, REQ-009, REQ-062 (and the REQ-034 queue, per HD-1).
**Files:** `src/infra/state/{lock.ts,state.ts,events.ts,signals.ts,reconcile.ts}`.

```ts
// lock.ts — .pipeline/lock
export interface LockRecord { pid: number; host: string; runId: string; acquiredAt: string; heartbeatAt: string; }
export function acquireLock(runId: string): Promise<{ release(): Promise<void> }>;  // throws LOCK_HELD {holder}
export function inspectLock(): Promise<{ held: boolean; record?: LockRecord; stale: boolean }>;
```
Lock acquisition works as follows:
- Create the file with `O_EXCL`.
- On `EEXIST`, read the record. It is **stale** if `host === os.hostname()` and `process.kill(pid,0)` throws `ESRCH`, or if `now - heartbeatAt > 120s`. A stale lock is removed and the create is retried once. Otherwise `LOCK_HELD` is thrown.
- The heartbeat rewrites the file atomically every 30 s through an unref'd interval.
- Release deletes the file only when the pid matches.
- The lock is also released on SIGINT/SIGTERM, and `exit` handlers run release synchronously.

```ts
// state.ts — .pipeline/state.json
export type ControllerState = 'idle'|'running'|'checkpoint'|'escalated'|'budget_stopped'|'done';
export interface RunState {
  schemaVersion: 1; runId: string; branch: string; profile: 'full'|'fast'; idea: { text: string; sourcePath?: string };
  state: ControllerState; currentUnit?: WorkUnit;
  completed: { unitId: string; commit: string; at: string; costUsd: number }[];
  pendingRework: WorkUnit[]; escalation?: Escalation; checkpointStage?: StageId;
  consent?: { given: boolean; at: string; block: string; mode: 'container'|'local-restricted' };
  budget: { initialUsd: number; topUps: { usd: number; at: string }[] };
  goBacksUsed: number; policySnapshot: Policy; updatedAt: string;
}
export interface Escalation {
  id: string; reason: 'low-confidence'|'cap-reached'|'budget-insufficient'|'guard-violation'|'contract-violation'
       |'hand-edit-policy'|'verification-exhausted'|'routing-unavailable'|'consent-refused'|'infrastructure'|'ask-user';
  summary: string; options: { key: string; label: string; command: string; recommended: boolean }[];
  decisionId?: string; unitId?: string; at: string;
}
export function readState(): Promise<RunState | null>;                 // STATE_CORRUPT if JSON invalid -> caller may reconcile
export function writeState(s: RunState): Promise<void>;                // writeAtomic; only M12 calls
```
```ts
// events.ts — .pipeline/events.jsonl
export type EventType = 'state'|'unit-start'|'unit-end'|'budget-warning'|'budget-exhausted'|'go-back'|'escalation'
  |'checkpoint'|'consent'|'user-decision'|'user-edit'|'signal'|'warning'|'critic';
export interface PipelineEvent { ts: string; runId: string; type: EventType; payload: Record<string, unknown>; }
export function appendEvent(e: Omit<PipelineEvent,'ts'>): Promise<void>;
export function queryEvents(f: { runId?: string; types?: EventType[]; since?: string }): Promise<PipelineEvent[]>;
export function tailEvents(onEvent: (e: PipelineEvent) => void): { stop(): void };   // fs.watch + offset polling 250ms
export const bus: EventEmitter;   // in-process mirror of appended events (used for M05→M12 notification)
```
```ts
// signals.ts — .pipeline/signals.jsonl (records) + .pipeline/signals.consumed.jsonl ({id, issueId, at})
export type SignalSource = 'consistency'|'review'|'verification'|'e2e'|'critic'|'user';
export interface Signal {
  id: string; ts: string; runId: string | null; source: SignalSource; sourceRef: string;   // F-n / E2E-n / INC-n / RD-n
  reqIds: string[]; summary: string; location?: string; severity?: Severity;
  evidence: string[]; producedBy: string;        // unitId or 'critic:C-n' or 'user'
  targetHint?: StageId;                           // user route --to
  fingerprint: string;                            // producer-computed, see M25
}
export function appendSignal(s: Omit<Signal,'id'|'ts'>): Promise<Signal>;
export function unconsumedSignals(): Promise<Signal[]>;
export function markConsumed(ids: string[], issueId: string): Promise<void>;   // M25 only
```
Signal ids come from a counter file, `signals.seq`, which is updated under the jsonl advisory lock. The critic process can append concurrently.

```ts
// reconcile.ts
export function reconcile(state: RunState, vcs: Vcs): Promise<{ state: RunState; repaired: string[] }>;
```
`reconcile` reads `vcs.listRunCommits(runId)`. For each commit whose `Unit` trailer is not in `state.completed`, it appends the unit with its commit sha and `costUsd` summed from the ledger by `unitId`. If `currentUnit` is committed, it clears `currentUnit`. It emits a `warning` event listing the repairs.
**Edge cases:** if `state.json` is missing but run commits exist, a minimal RunState is rebuilt from the first commit's `Pipeline-Run` trailer and `policySnapshot = current policy`. This emits a warning.

---

## M05 Budget & Cost Ledger
**REQs:** REQ-070–REQ-075.
**File:** `src/infra/ledger.ts`. Store: `.pipeline/ledger.jsonl`.

```ts
export interface LedgerEntry { ts: string; tags: LedgerTags; tier: Tier; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; callId: string; }
export interface Allowance { ok: true; capUsd: number; } | { ok: false; reason: 'run-exhausted'|'stage-exhausted'|'standalone-exhausted' };
export class Ledger {
  constructor(policy: Policy, state: () => RunState | null);
  allowance(tags: LedgerTags): Promise<Allowance>;
  record(e: Omit<LedgerEntry,'ts'>): Promise<void>;             // appends, then checks thresholds
  totals(filter: Partial<LedgerTags>): Promise<number>;
  byStage(runId: string): Promise<Record<string, number>>;
  byGoBack(runId: string): Promise<Record<string, number>>;
  projection(runId: string, remainingUnits: { stage: StageId }[]): Promise<BudgetProjection>;
  historicalStageCost(stage: StageId): Promise<{ medianUsd: number; count: number } | null>;
  runBudget(runId: string): number;                              // initial + topUps
}
export interface BudgetProjection { spentUsd: number; remainingUsd: number; estimatedRemainingUsd: number; likelyToFinish: boolean; basis: 'history'|'prior'; }
```
**Allowance:**
- The run cap is `runBudget - totals({runId})`.
- If the stage has a share, `stageCap = share*runBudget - totals({runId, stage})`.
- `capUsd = min(runCap, stageCap)`. If `capUsd < 0.01`, the result is a refusal.
- Critic without a run: `standaloneCriticUsd - totals({criticSessionId})`, with the critic session tagged `runId:'critic-standalone'`.

**Thresholds:** after each `record`, if spent crosses `warnAtFraction*budget` for the first time in the run, the ledger emits the event `budget-warning` with a projection. It checks for "already emitted" by querying events. If remaining ≤ 0.01, it emits `budget-exhausted`. Both are also sent through `bus`.

**History and projection:**
- History is the median `costUsd` summed per (runId, stage) over completed stage units from *other* runs, across the current project's ledger.
- The prior table used when there is no history is, in USD: understanding 0.3, classification 0.1, discovery 0.6, design 0.8, architecture 0.8, impl-plan 0.6, increment 1.2 each, review 0.5, e2e 2.0, brief 0.8.
- `likelyToFinish` is `estimatedRemaining ≤ remaining`.

**Top-up:** implemented by M12 as a push to `state.budget.topUps`. `runBudget` reads it.

**Pricing:** `costUsd` is taken from the SDK result's `total_cost_usd` when present. Otherwise it is computed from a pricing table in `ledger.pricing.ts`, keyed by model id, which is overridable in config as `pricing:`.

**Edge cases:** reconcile the ledger by `callId` so that a duplicate record, such as a retry after a crash, is ignored. Totals tolerate a truncated last line.

---

## M06 Agent Host Adapter
**REQs:** REQ-056 (permissions), REQ-062, REQ-070, REQ-072, REQ-074, REQ-081.
**Files:** `src/infra/agent/{adapter.ts,permissions.ts,transcript.ts}`. This is the only importer of `@anthropic-ai/claude-agent-sdk`.

```ts
export interface AgentRequest {
  role: string; tier: Tier; permission: PermissionProfileName;
  systemPrompt: string; prompt: string;
  contextFiles?: string[];                       // injected as <doc path="…"> blocks in prompt, read by adapter
  allowedTools?: string[];                       // subset of profile's tools
  cwd: string; writeRoots?: string[];            // docs-write: [docs/]; code-write: [src/, tests/, package files]
  tags: LedgerTags; maxTurns?: number;           // default 40
  outputSchema?: z.ZodTypeAny;                   // if set, final message must contain ```json block parsing to schema
  resumeSessionId?: string;                      // in-unit retry only
}
export interface AgentResult { text: string; json?: unknown; sessionId: string; costUsd: number; usage: {input:number; output:number}; transcript: string; turns: number; stopReason: 'end'|'max-turns'|'budget'|'error'; }
export type ShellExecutor = (cmd: string, opts: { cwd: string; timeoutSec: number; tags: LedgerTags }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export class AgentHost {
  constructor(policy: Policy, ledger: Ledger);
  registerShellExecutor(fn: ShellExecutor): void;        // M18
  run(req: AgentRequest): Promise<AgentResult>;          // throws BUDGET_REFUSED, AGENT_ERROR
}
```
**Profiles (`permissions.ts`):**

| Profile | Allowed tools | Write check | Bash |
|---|---|---|---|
| read-only | Read, Glob, Grep | none (Write/Edit denied) | denied |
| docs-write | Read, Glob, Grep, Write, Edit | resolved path ⊂ `docs/` | denied |
| code-write | Read, Glob, Grep, Write, Edit, Bash | resolved path ⊂ writeRoots, never `.pipeline/`, `.git/`, `docs/` | routed to ShellExecutor; denied if none registered |

Enforcement uses both the SDK `canUseTool` callback and a `PreToolUse` hook, as defence in depth. Paths are resolved with `realpath` of the parent directory, so a symlink that escapes the allowed roots is denied. `WebFetch`/`WebSearch` are always denied. MCP tools are allowed only when listed in `allowedTools`, which M23 uses for Playwright MCP. Bash through the executor works like this: the hook denies the native Bash call and returns the executor's output as the tool result message. If the SDK version can't substitute a result, a custom in-process MCP tool `sandbox_exec` is exposed instead of Bash. **Decision LD-1:** use a custom `sandbox_exec` MCP tool (via `createSdkMcpServer`) and never enable native Bash.

**run():**
1. `a = ledger.allowance(tags)`. If it is refused, throw `BUDGET_REFUSED`.
2. `query({prompt, options:{model: policy.tiers[tier], systemPrompt, cwd, maxTurns, allowedTools, canUseTool, hooks, maxBudgetUsd: a.capUsd, resume}})`.
3. Stream the messages. Write each message to the transcript `.pipeline/logs/<runId>/<unitId>.<n>.jsonl`, and append a human line to `<unitId>.log` for verbose mode.
4. On the `result` message, call `ledger.record` with the usage and a `callId` equal to the SDK session id plus a sequence number.
5. If `outputSchema` is set, extract the last ```json fence and parse it. On failure, run one follow-up turn in the same session with the text "Return only the JSON block matching …". If that also fails, throw `AGENT_ERROR{detail:'schema'}`.

**Errors:** API 429/5xx and network errors are retried with backoff, up to 3 times, and then raise `AGENT_ERROR` (retryable = false). If `stopReason === 'budget'`, the result is returned so the caller can map it to `budget-stopped`.
**Fresh session:** no `resume` is used unless `resumeSessionId` is given explicitly.

---

## M07 Stage Registry & Mode Profiles
**REQs:** REQ-003, REQ-008, REQ-010, REQ-013, REQ-071.
**File:** `src/knowledge/registry.ts`.

```ts
export interface StageManifest {
  id: StageId; output: string;                     // 'docs/design.md'
  inputs: { stage: StageId; kinds?: IdKind[]; sections?: string[] }[];
  upstream: StageId[];                             // graph edges (derived from inputs by default)
  roleTemplate: string;                            // path to prompt .md
  tier: Tier; permission: PermissionProfileName; budgetShare?: number;
  checkpointCapable: boolean; profiles: ('full'|'fast')[];
  contractProfile: string;                         // M02 profile name
  hooksAfter: ('consistency'|'critic-auto')[];
  executor: 'stage-runner'|'increment'|'review'|'e2e';
  expands?: 'increments';                          // implement stage expands into INC units
}
export class Registry {
  register(m: StageManifest): void;                // throws USAGE on dup id or unknown upstream (validated at freeze())
  freeze(): void;                                  // topo-sort check; cycle -> throws USAGE
  get(id: StageId): StageManifest;
  profile(p: 'full'|'fast'): StageId[];            // topologically ordered, filtered by membership
  upstreamOf(id): StageId[]; downstreamOf(id): StageId[];   // transitive, in profile order
  checkpointCandidates(): StageId[]; hooksAfter(id): StageManifest['hooksAfter'];
}
```
**Full profile order:** understanding → classification → discovery → design → architecture → impl-plan → implement → review → e2e.
**Fast profile order (M34):** brief → impl-plan → implement → review → e2e. In fast mode, impl-plan's `inputs` are resolved through an alias map `{design:'brief', classification:'brief'}` held on the profile.

---

## M08 Trace Index
**REQs:** REQ-015, REQ-023, REQ-024, REQ-033, REQ-052.
**File:** `src/knowledge/trace.ts`. Cache: `.pipeline/trace.json`.

```ts
export type NodeKind = IdKind | 'commit' | 'verdict' | 'evidence';
export type EdgeKind = 'REQ-AD'|'REQ-T'|'T-INC'|'INC-commit'|'REQ-E2E'|'E2E-verdict'|'verdict-evidence'|'F-REQ'|'AD-supersedes';
export interface TraceGraph { builtAt: string; docHashes: Record<string,string>; nodes: Record<string, { kind: NodeKind; doc?: string; attrs?: any }>; edges: { from: string; to: string; kind: EdgeKind }[]; problems: TraceProblem[]; }
export interface TraceProblem { kind: 'unknown-ref'|'duplicate-definition'|'orphan-task'|'orphan-inc'; id: string; where: string; }
export function rebuild(root: string, vcs: Vcs): Promise<TraceGraph>;       // full; writes cache
export function load(root: string): Promise<TraceGraph>;                     // cache if docHashes match current, else rebuild
export function coverage(g: TraceGraph): CoverageRow[];
export interface CoverageRow { req: string; priority?: string; ads: string[]; tasks: string[]; incs: string[]; commits: string[]; scenarios: string[]; verdict?: 'pass'|'fail'|'not verifiable'|'flaky'; gaps: ('task'|'inc'|'scenario'|'verdict')[]; }
export function orphans(g: TraceGraph): TraceProblem[];
export function downstream(g: TraceGraph, ids: string[]): Set<string>;       // BFS along edge direction
export function upstreamChain(g: TraceGraph, id: string): string[];          // reverse BFS
```
**Edge derivation:**
- An AD citing REQ-x gives `REQ-x→AD`.
- A T citing REQ-x gives `REQ-x→T`. A T citing INC-y, or an INC block listing T-z, gives `T→INC`.
- Commits whose `Refs` trailer includes INC-y give `INC-y→commit`. These come from `vcs.listRunCommits` for the current run.
- An E2E-n in `docs/e2e.md` citing REQ-x gives `REQ-x→E2E-n`.
- Verdicts come from `.pipeline/verdicts.json` (the M21 schema): `E2E→verdict:<runId>:<E2E-n>`, then `verdict→evidence` paths.
- An F block citing a REQ gives `F→REQ`.
- `Status: superseded by AD-m` gives `AD-m→AD-n (AD-supersedes)`.

**Other rules:**
- A per-REQ verdict node is `verdict:REQ-x`, which the REQ row's `verdict` reads. The latest run's verdict wins.
- Unknown refs are IDs referenced anywhere but not defined in any doc. F-ids from `docs/critic/` are excluded.
- A duplicate definition is the same ID defined in two docs.

---

## M09 Staleness / Dependency Tracker
**REQs:** REQ-006, REQ-007, REQ-013, REQ-026, REQ-027, REQ-028, REQ-033, REQ-038.
**File:** `src/knowledge/stale.ts`. Store: `.pipeline/hashes/<artefactKey>.json`, where the key is the doc path with `/` replaced by `__`, or `inc__INC-n`.

```ts
export interface HashRecord { artefact: string; commit: string; ownHash: string; ownBlockHashes: Record<string,string>; ownSectionHashes: Record<string,string>;
  basis: { doc: string; docHash: string; blocks: Record<string,string>; sections: Record<string,string> }[]; recordedAt: string; }
export type Granularity = 'block'|'section'|'document';
export interface StaleItem { artefact: string; granularity: Granularity; key: string;    // id, section slug, or '*'
  cause: { kind: 'upstream-change'|'user-edit'|'oq-answer'|'restart'|'routing-decision'|'missing'; ref?: string };
  chain: string[]; }                                    // root change … → this item
export interface StaleSet { items: StaleItem[]; byStage: Record<StageId, StaleItem[]>; }
export interface EditRecord { doc: string; changedBlocks: string[]; changedSections: string[]; classification: 'user-edit'|'oq-answer'; origin: 'commit'|'working-tree'; commits: string[]; }
export class Staleness {
  constructor(root: string, reg: Registry, vcs: Vcs, trace: () => Promise<TraceGraph>);
  record(artefact: string, commit: string, basisDocs: string[], usedIds?: string[]): Promise<void>;
  compute(profile: StageId[]): Promise<StaleSet>;
  preview(changes: { doc: string; ids?: string[]; sections?: string[] }[], profile: StageId[]): Promise<StaleSet>;   // pure
  detectEdits(sinceSha: string): Promise<EditRecord[]>;
  markByFiat(items: { artefact: string; key?: string }[], cause: StaleItem['cause']): Promise<void>;   // writes .pipeline/hashes/_fiat.json
  clearFiat(artefact: string): Promise<void>;          // called by record()
  checkPreconditions(stage: StageId): Promise<{ ok: true } | { ok: false; missing: string[]; stale: StaleItem[] }>;
  acceptEdits(edits: EditRecord[]): Promise<void>;     // re-records ownHash for the edited doc (authoritative)
}
```
**compute algorithm:**
1. For each stage artefact in profile order:
   - If no HashRecord exists, the item is `missing` at the document level.
   - Otherwise, for each basis doc, re-parse its current version and compare each recorded block hash. A changed or removed block becomes a block item. An added block in an upstream doc is a document-level change *only* if it is referenced by the artefact, or if the upstream doc has no IDs. For sections without IDs, compare section hashes. If both maps are empty, compare the docHash.
2. Propagation to the artefact's own content:
   - Downstream blocks whose `refs` include a stale upstream id are stale at block granularity, with the chain extended.
   - A changed upstream item that is not referenced by id, such as a section change, marks the downstream doc at document granularity.
3. Propagate transitively in profile order. A stale block in design marks architecture blocks citing it, then the T blocks citing those ADs or REQs, then INCs via the trace, then E2E scenarios citing the REQ. INC items have `artefact='inc:INC-n'`. E2E staleness is aggregated into the `e2e` stage.
4. Add the fiat items from `_fiat.json`.

**Edit detection:** a doc is edited when its current `hashText(normalise(raw)) !== HashRecord.ownHash` *and* `vcs.nonPipelineChanges(record.commit)` touches it, either in the working tree or in a non-pipeline commit.
- The classification is `oq-answer` if the only changed region is inside the `## Open questions` section and the number of answered questions increased. Otherwise it is `user-edit`.
- Changed blocks are found by diffing `ownBlockHashes`.

**Edge cases:**
- A doc that was deleted by the user is `missing`, and its downstream becomes stale at document level.
- If the hashes dir is lost, every artefact becomes `missing`. **LD-2:** in that case, `resume` offers `status --rebuild-hashes`, which re-records hashes for all artefacts at HEAD, assuming HEAD is consistent.

---

## M10 Stage Runner & Preservation Guard
**REQs:** REQ-002, REQ-004, REQ-011, REQ-012, REQ-013, REQ-026, REQ-038.
**File:** `src/work/stageRunner.ts`.

```ts
export interface StageDefinition { manifest: StageManifest; buildPrompt(ctx: StageContext): { system: string; prompt: string }; contract: ContractProfile; postProcess?(doc: StageDocument): Promise<void>; }
export interface StageContext { unit: WorkUnit; upstream: StageDocument[]; answeredQuestions: OpenQuestion[]; current?: StageDocument; decision?: RoutingDecision; runId: string; idea?: string; }
export class StageRunner implements Executor {
  constructor(deps: { reg: Registry; defs: Map<StageId, StageDefinition>; agent: AgentHost; vcs: Vcs; stale: Staleness; trace: typeof import('./trace'); decisions?: DecisionLog });
  execute(u: WorkUnit, ctx: RunContext): Promise<UnitOutcome>;
}
```
**execute steps:**
1. `stale.checkPreconditions(stage)`. If it fails, return `error` with detail `precondition: …`. M12 treats this as a scheduling bug and schedules the missing upstream first.
2. Assemble the context.
   - The upstream docs are the manifests' `inputs`. When `sections` is specified, only those sections are included.
   - Answered open questions are collected from all upstream docs.
   - In revise mode, also include the current doc, the decision (M28 record), the stale item list, and the instruction block below.
   - The front-matter template is pre-filled, with `generated_from` computed from the upstream docHashes.
3. Snapshot the pre-run file: `before = parse(current)`.
4. `agent.run({ permission: manifest.permission, writeRoots:['docs/'], tier, … })`. The agent writes `manifest.output` itself.
5. Read and parse the output, then run `validate(doc, contract)`.
   - If there are blocking violations, re-run once, resuming the same session, with a prompt that lists the violations.
   - If they are still blocking, restore the pre-run file (`vcs.readAt('HEAD')`, or delete it if it is new) and return `contract-violation`.
6. The **Preservation Guard** runs in revise mode only.
   - For every block in `before` that is not in `staleTargets`, the hash must be equal and the block must still exist.
   - For sections with no IDs that are not stale, **LD-3** applies: compare `normalise` with whitespace collapsed to single spaces and case-folded headings. A difference only in markdown table alignment or list markers is tolerated.
   - Newly added IDs are allowed. Removing a non-stale ID is a violation.
   - On violation, re-prompt once in the same session with the list of offending ids. If it still fails, restore the file and return `guard-violation`.
7. If the doc hash is unchanged from `before`, return `no-change`.
8. Commit with `vcs.commitUnit({paths:[output], trailers:{Pipeline-Run, Stage, Unit, Refs: ids defined or changed (max 40, else 'many'), Routing-Decision}})`.
9. `stale.record(output, sha, upstreamPaths)`, then `trace.rebuild`, then `def.postProcess?.(doc)`.
10. Return `committed` with the cost as the sum of ledger totals for the unitId.

**Revise-mode instruction block (fixed text):** "You are revising `<doc>`. Only change these items: <list>. Every other ID block and section must remain byte-for-byte identical. Reason: <decision.symptom>. Evidence: <links>."

**Errors:**
- `BUDGET_REFUSED`, or an agent stopReason of `budget`: restore the file and return `budget-stopped`.
- `AGENT_ERROR`: restore the file and return `error`.
- The runner never commits partial output.

---

## M11 Document Stage Definitions
**REQs:** REQ-002, REQ-010, REQ-012, REQ-014, REQ-020, REQ-021, REQ-022, REQ-023.
**Files:** `src/work/stages/{understanding,classification,discovery,design,architecture,implPlan}.ts` plus `prompts/*.md`.

| Stage | Output | Inputs | Tier | Contract profile | Hooks |
|---|---|---|---|---|---|
| understanding | docs/understanding.md | idea | standard | base | – |
| classification | docs/classification.md | understanding | fast | classification | – |
| discovery | docs/discovery.md | understanding, classification | standard | base | – |
| design | docs/design.md | understanding, classification, discovery | strong | design | consistency |
| architecture | docs/architecture.md | design, classification | strong | architecture | consistency |
| impl-plan | docs/implementer.md | design, architecture | strong | impl-plan | consistency |

All six stages use `docs-write` and are checkpoint-capable, and all belong to the full profile.

**Prompt requirements** (each template must contain these as explicit instructions):
- **All stages:** keep the header comment and front-matter. Write the summary in 5 or fewer bullets. Record Assumptions and Open questions instead of asking. Never renumber existing IDs (in revise mode the current doc is given).
- **design:** write REQ-nnn heading blocks with `Priority:` and `Acceptance:` in EARS form. New IDs continue from max(existing, historic) + 1. The historic max comes from `vcs.pathHistory('docs/design.md')` and is passed in the prompt as "Next free REQ number: N".
- **architecture:** each AD is an ADR (Context/Decision/Consequences/Status/REQs). Superseded ADs stay in place with a `Status: superseded by AD-m` line. The next free AD number is computed the same way.
- **impl-plan:** T-n and INC-n blocks. Each T cites its REQs, each INC lists its T ids and `Entry point:` and `Test command:` lines, and every Must REQ must be covered.
- **classification:** must emit the `supported-type` fenced block. The type-to-support mapping: web app is full with driver web, CLI is full with driver cli, library is partial with driver library, HTTP API is partial with driver api, and mobile/desktop/embedded/other is unsupported with driver none.

**Post-processing:** classification's `postProcess` parses the supported-type block into `.pipeline/supported-type.json` (`SupportedTypeVerdict`) and emits the event `{type:'unit-end', payload:{supportedType}}`, which M13 prints.

---

## M12 Run Controller
**REQs:** REQ-002, REQ-006, REQ-009, REQ-010, REQ-013, REQ-073 (rework states from M28 cover REQ-036/037).
**File:** `src/control/controller.ts`.

```ts
export class RunController {
  constructor(deps: Deps);   // policy, reg, stale, trace, ledger, vcs, executors: Record<WorkUnitKind, Executor>, report, hooks, router?: RouterPort
  start(p: { idea: string; sourcePath?: string; profile: 'full'|'fast'; budgetUsd: number }): Promise<ControllerState>;
  resume(p: { topUpUsd?: number }): Promise<ControllerState>;
  applyUserDecision(d: UserDecision): Promise<ControllerState>;       // from M17/M29
  nextUnit(state: RunState): Promise<WorkUnit | { done: true } | { route: true }>;   // pure-ish, exported for tests
}
export type UserDecision =
  | { kind: 'checkpoint'; approve: boolean }
  | { kind: 'escalation-option'; escalationId: string; optionKey: string }
  | { kind: 'route'; to: StageId; issueId?: string }
  | { kind: 'reject-issue'; issueId: string; reason: string }
  | { kind: 'edits'; accept: boolean };
export interface RouterPort { drain(ctx): Promise<{ rework: WorkUnit[]; escalation?: Escalation }>; onReworkComplete(decisionId: string): Promise<void>; }
```
**start:**
1. `acquireLock`.
2. If a RunState exists and is not `done`, throw `USAGE` ("run r-… in progress; use resume").
3. `vcs.ensureRepo` and `ensureRunBranch`.
4. Write the idea to `docs/idea.md` if it was given as a sentence, and commit it as `Unit: idea`.
5. Initialise RunState with state `running`, then call `loop()`.

**loop():**
```
while true:
  if abortRequested or budgetExhaustedFlag: return stop('budget_stopped')
  n = await nextUnit(state)
  if n.done: return stop('done')
  if n.route: r = router ? await router.drain() : escalate('routing-unavailable'); push r.rework to pendingRework; continue
  state.currentUnit = n; write; event unit-start
  out = await executors[n.kind].execute(n, ctx)          // exceptions -> escalate('infrastructure')
  switch out.status:
    committed|no-change: completed.push; clear currentUnit; write; event unit-end;
        run hooks for stage (consistency unit executed inline via executors.consistency; critic-auto via M33)
        if n.kind in (stage, rework-stage) and policy.checkpoints includes stage and n.mode=='normal': return stop('checkpoint')
        if n.decisionId and n.kind=='e2e-regression': router.onReworkComplete(n.decisionId)
    budget-stopped: return stop('budget_stopped')
    contract-violation|guard-violation: return escalate(reason, options: [retry, restart --from, edit & resume])
    failed-verification: signal already appended by M19; if !router: escalate('routing-unavailable') else continue (rule 3 will route)
    error: escalate('infrastructure')
```
**nextUnit (deterministic):**
1. `state.pendingRework[0]`, if any.
2. `ss = stale.compute(profile)`. Walk the profile stages in order:
   - A stage with an expansion (`implement`) produces one unit per INC, in plan order. An INC is due if it has no commit with an `Unit: increment:INC-n` trailer, or if it is in `ss` as `inc:INC-n`.
   - A document stage is due if it is in `ss.byStage`. Its mode is `revise` if the doc exists, otherwise `normal`.
   - `review` and `e2e` are due if missing, or if any upstream unit committed after their last completion.
3. If there are unconsumed signals and a router exists, return `route`. If there is no router, unconsumed signals of the source kinds `verification` or `e2e` (failures) lead to escalation with `routing-unavailable`, while other kinds are report-only.
4. Otherwise return done. The done condition is that every Must REQ has a verdict, or that verdicts exist with the report listing the gaps.

**stop(s):** set the state, write it, emit the `state` event, call `report.render()`, and release the lock unless the state is attended `escalated` and the CLI will prompt in-process.

**Budget:** subscribe to `bus` `budget-exhausted` and set the flag. The flag is checked only at the top of the loop, which is a safe point. The in-flight unit returns `budget-stopped` on its own when its allowance is refused.

**resume:**
1. Acquire the lock.
2. Read the state, falling back to reconcile if it is corrupt.
3. Top up the budget if given.
4. `human.editFlow()` (M17, if present). This may escalate.
5. If the state is `checkpoint` or `escalated`, don't advance. Require `approve` or a decision, except that `budget_stopped` and `crashed` just continue.
6. Clear `currentUnit`, which is re-run from scratch, then call `loop()`.

**Edge cases:**
- The consistency hook is recorded as a completed unit `consistency:<stage>` so it is not re-run.
- `goBacksUsed` is incremented by M28, not by M12.

---

## M13 CLI Command Surface & Progress Renderer
**REQs:** REQ-001, REQ-005, REQ-006, REQ-014, REQ-062, REQ-070, REQ-074, REQ-075.
**Files:** `src/cli/main.ts` (commander), `verbs/*.ts`, `render.ts`. Binary name: `pipeline`.

| Verb | Args/flags | Calls |
|---|---|---|
| `start <idea...>` | `--file <path>`, `--budget <usd>`, `--fast`, `--full`, `--unattended`, `--checkpoint <stage>`*, `--verbose` | M34 suggest (if present & neither flag), `controller.start` |
| `status` | `--json` | M14 status (no lock) |
| `resume` | `--budget <usd>` (top-up), `--verbose`, `--unattended` | `controller.resume` |
| `budget` | – | ledger totals + projection |
| `checkpoint approve|reject` (M17) | | `applyUserDecision` |
| `restart --from <stage>` (M17) | | M17 |
| `edits accept|reject` (M17) | | M17 |
| `route --to <stage> [--issue I-n]` / `route reject <I-n> --reason` / `route choose <ESC-id> <option>` (M29) | | M29 |
| `critic [docs...] [--app] [--persona] [--flow]` (M30) | | critic entry |
| `finding promote|dismiss <F-n> [--reason]` (M32) | | M32 |
| `baseline` (M35) | | M35 |

**Exit codes:** 0 = done or checkpoint, 2 = escalated, 3 = budget_stopped, 4 = lock held, 1 = error, 64 = usage.

**Progress renderer:**
- It subscribes to `bus`, or to `tailEvents` for another process.
- Line formats: `▸ design …` on unit-start, `✓ design  $0.82 (run $3.10/25.00)` on unit-end, `✗ INC-3 verification failed → routed`, and `⚠ budget 80%: projected $27.40 — likely to exceed` on budget-warning.
- After classification it prints `Product type: CLI — full E2E support` (or `partial…`, or `unsupported: verdicts will be "not verifiable"`).
- With `--verbose`, it tails `.pipeline/logs/<run>/*.log` and prefixes each line with the unit id.
- When stdout is not a TTY, it prints no spinners or colours.

**Attended prompts:** for an escalation it prints M14's escalation block, then uses `@inquirer/select` over the options, and the selected option calls `applyUserDecision`. In unattended mode it prints the block and exits 2. There is no business logic in this module.

---

## M14 Reporter
**REQs:** REQ-005, REQ-024, REQ-060, REQ-061, REQ-074.
**Files:** `src/knowledge/report/{report.ts,status.ts,escalation.ts,providers.ts}`.

```ts
export interface SectionProvider { id: string; title: string; order: number; render(ctx: ReportCtx): Promise<string>; }
export function registerSection(p: SectionProvider): void;
export function renderReport(runId: string): Promise<string>;     // writes docs/run_report.md; M12 commits it as part of stop (Unit: report@<ts>)
export function renderStatus(): Promise<string>;                  // read-only
export function renderEscalation(e: Escalation): string;
```
**Built-in sections, in order:**
1. **Outcome.** A single line, e.g. `Done: 14/16 Must REQs pass, 1 fail, 1 not verifiable. $18.20 of $25.`
2. **Coverage matrix.** Rows from M08 `coverage`, with gaps shown in **bold** plus ⚠.
3. **Go-backs:** provided by M28, `n/a` until then.
4. **Findings:** open critic findings from M32. Until M25 exists, this also lists unrouted signals.
5. **Open questions roll-up.** For every doc: each question, marked ✔ answered with the answer excerpt or ✗ unanswered, with a link `docs/x.md#L<line>`.
6. **Cost.** Per stage (`ledger.byStage`), per go-back (`byGoBack`), and critic, plus the total and remaining budget.
7. **How to run.** The entry point and test command from the INC blocks and supported-type.
8. **Next actions.** Derived from the state: the escalation commands, `pipeline resume --budget X` when budget-stopped, and `checkpoint approve`.

If a provider throws, its section renders `n/a (error: msg)`. The report is always written.
**Status view:** run id, state, current unit, completed count out of planned count, spend and budget, the last 5 events, and the pending escalation block.
**Escalation block format:**
```
⛔ Escalation ESC-3 (low-confidence): <summary>
Options (recommended first):
  [1] ★ Revise design (REQ-007)      → pipeline route choose ESC-3 1
  [2] Revise impl-plan                → pipeline route choose ESC-3 2
  [3] Accept as known issue           → pipeline route reject I-4 --reason "..."
```

---

## M15 Decision Log
**REQs:** REQ-022, REQ-025.
**File:** `src/knowledge/decisions.ts`. Source events: `type:'user-decision'|'go-back'|'user-edit'`, plus `stage-decision` events, which M10 emits for each new or superseded AD.

```ts
export interface DecisionRecord { id: string; ts: string; by: 'stage'|'router'|'user'; stage?: StageId; what: string; why: string; replaces?: string; refs: string[]; }
export class DecisionLog {
  record(d: Omit<DecisionRecord,'id'|'ts'>): Promise<DecisionRecord>;   // appends event type 'decision'; ids D-n
  render(): Promise<string>;               // rewrites docs/decisions.md (grouped by run, newest first); committed by caller's unit
  checkSupersession(arch: StageDocument): ContractViolation[];   // AD superseded-by target exists & target lists 'Supersedes: AD-n' (warning)
}
```

---

## M16 Consistency Checker
**REQs:** REQ-015, REQ-020, REQ-023, REQ-034.
**File:** `src/work/consistency.ts`. It implements `Executor` for `consistency:<stage>` units.

**Deterministic checks:**
- `uncovered-must`: after impl-plan, a Must REQ with no T.
- `orphan-task`: a T with no REQ.
- `unknown-ref` and `duplicate-definition`: taken from `trace.problems`.
- `id-reuse`: for each REQ or AD id in the current doc, compare its title (heading text after the id) against `pathHistory`. If the same id has a different normalised title with a similarity below 0.5 (token Jaccard), the id was reused. If the ID set lost members that still appear in later docs, that is `id-renumbered`.
- `ad-without-req`.

**LLM layer:**
- One `agent.run` call (read-only, standard tier) per doc pair: (design, architecture) and (design, impl-plan), plus (architecture, impl-plan) after impl-plan.
- `outputSchema = z.array({location, problem, severity, ids:[string]})`, with at most 10 findings per pair.

**Output:**
- Findings F-n are appended to `.pipeline/findings.jsonl`, with `source:'consistency'`, using the M32 schema. If M32 is not built yet, the same file and schema are used.
- For every finding with severity ≥ major, `appendSignal({source:'consistency', fingerprint})`.
- The outcome is `committed` with an empty commit (no doc is written). The unit is recorded as complete with `commit: ''`.

**Fingerprint:** `hashText([rule, sorted ids, normalisedLocation].join('|'))`.

---

## M17 Human Control: Checkpoints, Restart, Hand Edits
**REQs:** REQ-003, REQ-007, REQ-026, REQ-027, REQ-028, REQ-061.
**File:** `src/control/human.ts` plus verbs.

```ts
export class HumanControl {
  checkpoint(approve: boolean): Promise<void>;       // requires state=checkpoint; approve -> running + loop; reject -> stays checkpoint, event, exit 0 (resumable; LD-4: reject = "pause", no data change)
  restartFrom(stage: StageId): Promise<StaleSet>;    // requires lock; markByFiat(stage + downstreamOf(stage), 'restart'); prints stale set; state->running on next resume
  editFlow(ctx): Promise<'proceed'|'escalated'>;     // called by M12.resume and at start
}
```
**editFlow:**
1. Take `lastSha`, the last pipeline commit in the run, and call `edits = stale.detectEdits(lastSha)`. If there are no edits, proceed.
2. Compute the stale set `preview(edits→changes)` and render the stale items with their causes, e.g. `design.md REQ-007 (user-edit) → architecture AD-4 → T-6 → INC-3`.
3. If attended, prompt Accept or Reject.
   - Accept: `acceptEdits`, commit the edited docs with `vcs.commitUnit(Unit:'user-edit:<doc>', Stage:'user')`, record the decision log entry "user edit", and proceed.
   - Reject: exit without changing anything.
4. If unattended with `stop-and-ask`, escalate with `hand-edit-policy`. The options are `edits accept` and `edits reject`, which runs `git checkout` of the listed files and is performed through M03's `restorePaths`.
5. If unattended with `accept-and-propagate`, treat it as accept.
6. `oq-answer` edits follow the same path. The answered state is visible in the M14 roll-up.

**Edge cases:** an edit to a doc that has no HashRecord, i.e. a user-created doc, is ignored except for `docs/idea.md`. Edits to `src/` are handled by the same flow, keyed on INC commits. The affected INCs are those whose committed files changed, and the downstream is `review` and `e2e`.
Required M03 addition: `restorePaths(paths: string[]): Promise<void>` (`git checkout HEAD -- paths`).

---

## M18 Sandbox Manager
**REQs:** REQ-016, REQ-044, REQ-050, REQ-056.
**Files:** `src/infra/sandbox/{runtime.ts,consent.ts,exec.ts,app.ts,image/Dockerfile}`.

```ts
export interface ExecOpts { cwd?: string; env?: Record<string,string>; timeoutSec?: number; network: 'install'|'run'; tags: LedgerTags; }
export interface ExecResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number; artefacts: string[]; }
export interface AppHandle { id: string; url?: string; port?: number; logs(): Promise<string>; }
export class Sandbox {
  static detect(policy: Policy): Promise<{ runtime: 'docker'|'podman'|null }>;
  ensureConsent(ctx: RunContext, prompt: (block: string) => Promise<boolean>): Promise<void>;   // throws CONSENT_REFUSED / SANDBOX_UNAVAILABLE
  exec(cmd: string, o: ExecOpts): Promise<ExecResult>;
  startApp(entry: { command: string; port?: number; readyPath?: string }, o: ExecOpts): Promise<AppHandle>;
  stopApp(h: AppHandle): Promise<void>;
  mode(): 'container'|'local-restricted';
  asShellExecutor(): ShellExecutor;
}
```
**Container invocation:** `docker run --rm -v <worktree>:/work:rw -w /work --network <net> --cpus <cpu> --memory <mb>m --pids-limit 512 --read-only --tmpfs /tmp --user <uid>:<gid> --cap-drop ALL --security-opt no-new-privileges <image> sh -lc <cmd>`.
- The host HOME is never mounted, and env vars are passed only from the allow-list (`CI=1`, `NODE_ENV`, the explicit `env`).
- For `network:'install'`, use the network `pipeline-egress`, a user-defined bridge. Egress restriction to registries (npm and pypi hosts) is best-effort through the image's proxy config. For `run`, use `--network none`.
- The app runs with `-d` on a private network with the port published only on `127.0.0.1`.

**Timeouts:** after `execTimeoutSec`, run `docker kill`, and return `timedOut: true` with exit code 124.

**Consent:**
- The block lists the image, mounts, commands classes, network policy and limits.
- Consent is recorded in `RunState.consent` through a callback to M12, since it is state held by M12. Consent is asked once per run.
- An unattended run with no consent recorded escalates with `consent-refused`. The option is `pipeline resume --consent`, which sets it. **LD-5:** `--yes-sandbox` is accepted on `start` to pre-consent unattended runs.

**Missing runtime:** if the mode is `container` and no runtime exists, throw `SANDBOX_UNAVAILABLE`. M12 turns that into an escalation with option `resume --sandbox local-restricted`.

**local-restricted mode:** runs `spawn` with `cwd` equal to the worktree, env scrubbed, and `ulimit` limits applied via `sh -c 'ulimit -t … -v …; cmd'`. There is no network restriction, and this is labelled in the report.

**Image:** `pipeline-sandbox:1` is based on `mcr.microsoft.com/playwright:<pinned>-jammy` with node, python3 and git. It is built on first use from the bundled Dockerfile if the pull fails.

**Registration:** at construction, M18 registers `agent.registerShellExecutor(this.asShellExecutor())` with `network: 'install'` for agent shell use.

---

## M19 Increment Executor & Verification Gate
**REQs:** REQ-016, REQ-017, REQ-023, REQ-037, REQ-056.
**Files:** `src/work/increment.ts`, `stages/implement.ts` (manifest: executor `increment`, expands `increments`, code-write, standard tier).

```ts
export class IncrementExecutor implements Executor {
  execute(u: WorkUnit /* kind increment|rework-increment, targetId INC-n */, ctx): Promise<UnitOutcome>;
}
```
**Steps:**
1. Read the INC block from the impl-plan: the T ids, REQ ids (through the Ts), `Test command:` and `Entry point:`.
2. Call `sandbox.ensureConsent`.
3. Call `agent.run` with code-write permission and `writeRoots=['src','test','tests','package.json','package-lock.json', other manifest files declared in architecture]`. The prompt includes the INC, its Ts, the relevant REQs with acceptance, the architecture ADs cited, the file tree, and in rework mode the decision and the failing evidence.
4. **Verification Gate**:
   - `sandbox.exec(installCmd, {network:'install'})` runs if a package manifest changed. The install command is detected as `npm ci || npm install` / `pip install -r`.
   - Then `sandbox.exec(testCmd, {network:'run'})`.
   - The gate passes when the exit code is 0 and it has not timed out. It fails if the test command is empty, **LD-6**, because every INC must declare one (enforced by the impl-plan contract as a warning and here as a failure).
5. On pass, commit all changed paths under the write roots with trailers `Refs: REQ-…, T-…, INC-n` and `Unit: <unitId>`. Record the hash with `artefact 'inc:INC-n'` and the basis impl-plan and architecture. The outcome is `committed`.
6. On failure, run up to `localRetriesPerIncrement` retries. A retry resumes the same session with the gate output (the last 200 lines of stdout and stderr). If attempts are exhausted:
   - Stash the failed diff to `.pipeline/evidence/<run>/INC-n/attempt-<k>.patch`.
   - Reset the write roots with `vcs.restorePaths` plus a clean of untracked files under the write roots only.
   - Call `appendSignal({source:'verification', sourceRef:'INC-n', reqIds, evidence:[patch, log], fingerprint: hash('verification|INC-n|'+firstFailingTestName)})`.
   - Return `failed-verification`.

**Attempt cap:** before the agent runs, `attempts = issues.attemptsFor(fingerprint)` from M25 if present, otherwise a count of `verification` signals for this INC in the run. If `attempts ≥ maxAttemptsPerIssue`, return `failed-verification` with detail `cap` without spending. M12 then escalates with `verification-exhausted`.

---

## M20 Reviewer
**REQs:** REQ-018, REQ-034.
**File:** `src/work/review.ts`, with a manifest (`review`, read-only, strong tier, output `docs/review.md`).
Because the agent is read-only, the reviewer does **not** write the doc itself.
1. The agent returns JSON through `outputSchema`: `{findings:[{location:'path:line', severity, problem, ids:[REQ/AD], suggestion}]}`.
2. `review.ts` renders `docs/review.md`: the base contract layout, with each finding as a heading block `### F-n <problem>` containing the fields.
3. It validates and commits through the M10 helpers `commitDoc(unit, path)`.

**LD-7:** M10 exposes `commitDoc` and `recordAndTrace` for L3 modules that render docs themselves.
**Signals:** one per finding with `severity ≥ policy.router.reviewSignalMinSeverity` (default major). Fingerprint: `hash('review|'+ids.sort()+'|'+fileOfLocation+'|'+normalise(problem).slice(0,80))`.
**Inputs:** the diff since the last review (or since the branch base), design, architecture and impl-plan.

---

## M21 E2E Harness Core
**REQs:** REQ-014, REQ-039, REQ-051, REQ-052, REQ-053, REQ-054.
**Files:** `src/work/e2e/{harness.ts,deriver.ts,flake.ts,judge.ts,evidence.ts,regression.ts,driver.ts}`.

```ts
export type DriverKind = 'web'|'cli'|'library'|'api';
export interface Scenario { id: string; reqIds: string[]; title: string; preconditions: string[]; steps: { action: string; input?: string }[]; expect: string[]; driver: DriverKind; specRef?: string; smoke: boolean; }
export interface StepLog { i: number; action: string; observation: string; ok: boolean; evidence?: string; }
export interface ScenarioResult { scenarioId: string; status: 'pass'|'fail'|'flaky'|'error'; attempts: { status: 'pass'|'fail'|'error'; steps: StepLog[]; evidence: string[] }[]; }
export interface Verdict { req: string; verdict: 'pass'|'fail'|'not verifiable'; reason: string; scenarios: string[]; rationale: string; evidence: string[]; runId: string; unitId: string; }
export interface Driver {
  kind: DriverKind;
  prepare(ctx: { sandbox: Sandbox; entry: EntryPoint; evidenceDir: string }): Promise<DriverSession>;
}
export interface DriverSession { run(s: Scenario): Promise<{ status: 'pass'|'fail'|'error'; steps: StepLog[]; evidence: string[] }>; explore?(goal: string, persona: string, budgetTags: LedgerTags): Promise<{ steps: StepLog[]; evidence: string[] }>; teardown(): Promise<void>; }
export interface EntryPoint { kind: DriverKind; command?: string; url?: string; port?: number; startCommand?: string; }
export function registerDriver(d: Driver): void;
export class E2EHarness implements Executor { execute(u: WorkUnit, ctx): Promise<UnitOutcome>; }
```
**execute(e2e):**
1. Load `supported-type.json`. If the support is `unsupported`, write a verdict `not verifiable` with reason `unsupported type: <type>` for every Must and Should REQ, then return `committed`.
2. **Derive the scenarios.**
   - The call is `agent.run` with read-only permission, `allowedTools: []` and *no* cwd file access (`cwd` set to an empty temp dir).
   - The context is only the REQ blocks (id, priority, acceptance), the supported-type block and the entry points, which are INC `Entry point:` lines and the CLI `--help` output captured through `sandbox.exec`.
   - Output schema: `Scenario[]`, where each scenario cites ≥1 REQ. Every REQ must have at least 1 scenario, or the judge marks it `not verifiable: no scenario derived`. `smoke:true` must be set on ≤ `smokeSubsetSize` scenarios.
   - Existing scenarios in `docs/e2e.md` are kept in revise mode, and only scenarios for stale REQs are re-derived.
3. Select the driver by `supported.driver`. If none is registered, the result is `not verifiable: driver unavailable`.
4. Run the scenarios. The default is sequential; if `parallelism > 1`, independent sessions run concurrently. Each scenario gets a fresh `prepare`, meaning a fresh app instance.
5. **Flake filter:** for a failure, re-run it `flakeReruns` times, each with a fresh prepare. All attempts failing gives `fail`. Mixed results give `flaky`.
6. **Judge** (one call per REQ, read-only, strong tier, with read access to `src/` through Read/Grep only). The inputs are the REQ text, the scenario results and steps, and the instruction "use code only to detect omissions of required behaviour, not to override observed results". The output is `{verdict, reason, rationale}`.
   - Constraints are applied after the call. The judge cannot turn a non-flaky fail into a pass (it is forced to `fail` with a note). Flaky-only evidence gives `not verifiable: flaky`.
7. **Write the outputs:**
   - `docs/e2e.md` holds the scenarios as `### E2E-n` blocks with `REQs:`, `Steps:` and `Expect:`, plus a verdict table.
   - `.pipeline/verdicts.json` holds `{runs: {[runId]: {[unitId]: Verdict[]}}, scenarios: ScenarioResult[] (latest)}`.
   - Commit with `commitDoc`.
8. **Signals:**
   - One per non-flaky failing scenario (source `e2e`, sourceRef `E2E-n`, fingerprint `hash('e2e|'+E2E-n+'|'+reqIds)`).
   - One per Must REQ judged `fail` without a failing scenario, i.e. an omission (fingerprint `hash('judge|'+REQ)`).
   - Flaky results are recorded as signals with `severity:'info'`, and M25 records them as flaky without routing them.

**Evidence dir:** `.pipeline/evidence/<runId>/<E2E-n>/attempt-<k>/{steps.jsonl,stdout.txt,stderr.txt,snapshot-<i>.yml,screenshot-<i>.png,trace.zip}`.
**Regression mode (`e2e-regression`):** the scenario set is the union of:
1. scenarios that failed in the last run,
2. scenarios citing REQs in the decision's stale set that previously passed,
3. the smoke scenarios (flagged `smoke:true`; **LD-8**: size = `smokeSubsetSize`, default 5, chosen by the deriver as one per top-priority user flow).

No re-derivation happens unless the REQ itself is stale. Verdicts merge into the latest per REQ.

---

## M22 CLI E2E Driver
**REQs:** REQ-050, REQ-054. **File:** `src/work/e2e/drivers/cli.ts`.
- `prepare` runs the build or install step once per session through `sandbox.exec(network:'install')`, only when no `node_modules` or equivalent exists.
- `run(s)`: each step is `{action:'run', input:'<cmd line>'}` or `{action:'expect', input:'stdout contains "x"' | 'exit 0' | 'stderr matches /re/' | 'file <p> equals golden <g>'}`.
  - Commands run through `sandbox.exec(network:'run', timeoutSec:60)`.
  - The expectation mini-grammar is parsed by regex: `stdout|stderr (contains|matches|equals) <arg>`, `exit <n>`, `file <path> (exists|contains <s>|equals golden <path>)`.
  - Unparseable expectations give `error`, never `pass`.
  - stdout and stderr are written per step as evidence.
- Golden files are stored under `tests/e2e/golden/` and written by the deriver as scenario fixtures inside docs/e2e.md fenced blocks, then extracted.

## M23 Web E2E Driver
**REQs:** REQ-050, REQ-054. **File:** `src/work/e2e/drivers/web.ts`.
- `prepare` calls `sandbox.startApp({command: entry.startCommand, port})` and polls `readyPath`, default `/`, until HTTP < 500 or `appStartTimeoutSec`. A timeout gives session `error` with the app logs as evidence.
- `run(s)`:
  - If `s.specRef` exists, replay it: `sandbox.exec('npx playwright test <spec> --reporter=json', network:'run')`.
  - Otherwise do agent-driven execution. The call is `agent.run` read-only with `allowedTools: Playwright MCP browser_* tools`. The MCP server `@playwright/mcp` runs *inside the sandbox* (stdio through `docker exec`) and is pointed at the app URL. The prompt contains the scenario steps and expects. The output schema is `{steps: StepLog[], status}`.
  - After a pass, the agent is asked to emit a Playwright spec, which is saved to `tests/e2e/web/<E2E-n>.spec.ts`, and the `specRef` is set.
- Accessibility snapshots are taken after each step (`browser_snapshot`), and a screenshot is taken on failure.
- **Selector repair:** if a replayed spec fails with a locator-not-found error and the agent-driven run of the same scenario passes, the result is a `pass` with a `spec-repaired` note, and the spec is regenerated. This is never counted as a behavioural fail.
- `explore(goal, persona)` is used by M31: the same agent session, with a free exploration prompt.
- Web page content is untrusted, and the prompt says so. The role is read-only.

## M24 Library / HTTP API E2E Driver (Should)
**REQ:** REQ-055. **File:** `drivers/libapi.ts`.
- **library:** the deriver's steps are `{action:'script', input:'<consumer code>'}`. The code is written to `/tmp/e2e/<E2E-n>.mjs` (or `.py`) inside the sandbox, importing the package by its public name through `npm link`/`pip install -e`, and run. Asserts use the same grammar as CLI on stdout and exit.
- **api:** `startApp`, then steps `{action:'http', input:'GET /path'|'POST /path {json}'}` with expectations `status <n>`, `json <jsonpath> equals <v>`, `header <h> contains <s>`. The requests are made with an in-sandbox `curl` so that network isolation stays intact.

---

## M25 Router Signal Intake & Issue Registry
**REQs:** REQ-034, REQ-053. **File:** `src/control/router/intake.ts`. Store: `.pipeline/issues.json` (atomic, owned by M25).

```ts
export interface Issue { id: string; key: string; status: 'open'|'routed'|'resolved'|'known-issue'|'flaky'; signals: string[]; reqIds: string[]; sources: SignalSource[]; summary: string; attempts: number; decisions: string[]; firstSeen: string; lastSeen: string; }
export class IssueRegistry {
  intake(): Promise<Issue[]>;          // consumes unconsumed signals, returns issues ready to route (status open)
  attemptsFor(fingerprintOrKey: string): Promise<number>;
  get(id: string): Promise<Issue>; setStatus(id, s, note?): Promise<void>; list(f?): Promise<Issue[]>;
}
```
**Issue key (LD-9, which resolves HLD OQ3):** `key = source-class + '|' + sorted reqIds + '|' + locationClass`, where:
- `source-class` groups the sources as `test` = {e2e, verification}, `static` = {review, consistency} and `critic`/`user`.
- `locationClass` is the INC id for verification, the E2E id for e2e, the doc path for static, and the finding fingerprint for critic.

**Merge rules:**
- A signal whose key equals an existing issue's key is merged, even when the issue is `resolved`. Merging into a resolved issue reopens it and marks the latest decision `recurred`, which M28 handles through a callback.
- A `severity:'info'` signal from e2e with the flaky marker sets `status:'flaky'` and is not returned.
- `attempts` counts the routing decisions enacted for the issue plus the verification local retries recorded.

**Edge cases:**
- A signal with no reqIds takes the REQ ids found through `trace.upstreamChain(sourceRef)`. If there are still none, it gets `reqIds:[]` and key `…|none|…`.
- Several signals in one drain that share a key become one issue.

## M26 Router Evidence & Attribution
**REQs:** REQ-030, REQ-031, REQ-032. **Files:** `router/evidence.ts`, `router/attribute.ts`, `router/rules.ts`.

```ts
export interface EvidenceBundle { issueId: string; chain: { id: string; kind: NodeKind; excerpt: string; doc?: string }[]; incDiffStat?: string; evidence: string[]; }
export interface Candidate { stage: StageId; score: number; rationale: string; source: ('rule'|'llm')[]; }
export interface Attribution { candidates: Candidate[]; ruleHits: string[]; confidence: 'high'|'medium'|'low'; confidenceReason: string; }
export function buildEvidence(issue: Issue, g: TraceGraph): Promise<EvidenceBundle>;   // excerpts ≤ 1500 chars each, ≤ 20 nodes
export function attribute(issue: Issue, b: EvidenceBundle, profile: StageId[]): Promise<Attribution>;
```
**Rules (`rules.ts`):** each rule is `(issue, bundle, graph) => {stage, weight, why} | null`.

| Rule | Condition | Target stage | Weight |
|---|---|---|---|
| R1 | acceptance intent missing or ambiguous for the REQ (no `Acceptance:`) | design | 0.8 |
| R2 | REQ has no T | impl-plan | 0.9 |
| R3 | T exists, no INC commit | implement | 0.7 |
| R4 | verification failure, and the INC's tests reference behaviour not in the REQ | impl-plan | 0.5 |
| R5 | verification failure (default) | implement | 0.6 |
| R6 | e2e fail, INC committed, judge rationale says "omission" | implement | 0.7 |
| R7 | consistency finding across design/architecture | the later doc, unless the finding says the earlier one is wrong | 0.6 |
| R8 | two REQs in the issue contradict (consistency) | design | 0.7 |
| R9 | AD cited by the chain is superseded | architecture | 0.6 |
| R10 | issue came through a `user` signal with a targetHint | the targetHint | 1.0, and the LLM is skipped |

**LLM attributor:**
- A strong-tier, read-only call with the bundle and the profile stage list, in which the transcripts are excluded.
- It also gets calibration: the last 20 `routing.jsonl` outcomes as `{symptom-class, target, outcome}` lines.
- Output schema: `{ranking:[{stage, probability, rationale}]}`.

**Combination:**
- `score(stage) = 0.5*maxRuleWeight(stage) + 0.5*llmProb(stage)`.
- Confidence is **high** if the top stage is the same under rules and LLM *and* `llmProb ≥ 0.6`. It is **medium** if they agree with `llmProb < 0.6`, or if they disagree but the top score − the second score ≥ 0.2. Otherwise it is **low**.
- The reason names which layer supported which stage, in one line.
- **Edge case:** if the LLM call fails, use the rules only and cap the confidence at medium.

## M27 Router Planning, Impact & Gate
**REQs:** REQ-033, REQ-035, REQ-036, REQ-037, REQ-072. **File:** `router/plan.ts`.

```ts
export interface RoutingPlan { issueId: string; target: StageId; alternatives: Candidate[]; distance: number; impact: StaleSet; estimate: { usd: number; basis: 'history'|'prior' }; remainingUsd: number;
  gate: { result: 'auto-proceed'|'ask-user'|'escalate'; reason: string }; authoredBy: 'router'|'user'; confidence: Attribution['confidence']; }
export function plan(issue: Issue, a: Attribution, ctx: { profile: StageId[]; failingStage: StageId; forcedTarget?: StageId; state: RunState }): Promise<RoutingPlan>;
```
**Target selection:**
- The failing stage is `implement` for verification, `e2e` for e2e, and the doc's stage for static findings.
- Candidates are the stages at or before the failing stage in the profile.
- `minDistance` is 0, plus the number of prior decisions for the issue with outcome `recurred`.
- Choose the candidate with the highest score among those whose distance from the failing stage is ≥ minDistance. Ties go to the nearest one.
- If no candidate satisfies the constraint, step back from the failing stage by minDistance in profile order.
- `forcedTarget` (user) skips the selection.

**Impact and estimate:**
- `impact = stale.preview([{doc: target doc, ids: issue.reqIds ∩ ids in target doc (or section-level if none)}])`.
- The estimate is the sum over the impacted stages of `historicalStageCost(stage).median × staleFraction`. `staleFraction` is the number of stale blocks in the doc divided by the total blocks, with 1 at document granularity. Each stale INC costs its median. Add the regression cost, which is `median(e2e) × (regressionScenarioCount / totalScenarios)`, or the prior.

**Gate, applied in order:**
1. `state.goBacksUsed ≥ maxGoBacksPerRun`: escalate with `cap-reached`.
2. `issue.attempts ≥ maxAttemptsPerIssue`: escalate with `cap-reached`.
3. `estimate > remainingUsd`: escalate with `budget-insufficient`.
4. The plan is user-authored: auto-proceed.
5. Confidence is at least `autoProceedMinConfidence` *and* distance ≤ 1: auto-proceed.
6. Confidence is medium: ask-user if attended, otherwise escalate. This is the REQ-036 policy. `ask-user` in unattended mode always becomes escalate.
7. Low confidence: escalate with `low-confidence`.

## M28 Rework Execution & Outcome Tracking
**REQs:** REQ-030, REQ-038, REQ-039, REQ-041. **Files:** `router/enact.ts`, `router/index.ts` (implements `RouterPort`).

```ts
export interface RoutingDecision { id: string; runId: string; ts: string; issueId: string; symptom: string; origin: StageId; reqIds: string[]; evidence: string[];
  confidence: string; confidenceReason: string; alternatives: { stage: StageId; rationale: string }[]; impact: { artefact: string; key: string }[];
  estimateUsd: number; remainingUsd: number; author: 'router'|'user'; gate: string; outcome: 'pending'|'resolved'|'recurred'|'rejected'|'overridden'; outcomeAt?: string; supersedes?: string; }
export class Router implements RouterPort {
  drain(ctx): Promise<{ rework: WorkUnit[]; escalation?: Escalation }>;   // intake → per issue (oldest first, one issue enacted per drain) attribute → plan → enact or escalate
  enact(p: RoutingPlan): Promise<{ decision: RoutingDecision; units: WorkUnit[] }>;
  onReworkComplete(decisionId: string): Promise<void>;
}
```
**enact:**
1. Allocate RD-n, append the decision to `.pipeline/routing.jsonl`, re-render `docs/routing.md` (newest first, one H3 block per RD), and record it in the decision log.
2. Mark the stale items by fiat with `cause:'routing-decision', ref: RD-n`, then set `state.goBacksUsed++` and `issue.status='routed'`, and push the decision id.
3. Build the units:
   - `rework-stage` for each impacted document stage in profile order (revise mode, staleTargets filtered per artefact).
   - `rework-increment` for each impacted INC.
   - `review` only if the code changed.
   - `e2e-regression` last.
   - Every unit gets `decisionId` and `tags.goBackId = RD-n`.
4. **Downstream redo (LD-10, which resolves HLD OQ6):** a downstream stage is included only when M09 reports at least one stale item in it. When the revised block is not referenced downstream, the downstream stages are skipped and the decision records `skipped: [stages]`.

**Recording:** `routing.jsonl` is committed with `docs/routing.md` in the first rework unit's commit, because M10 adds `extraPaths`. **LD-11:** M10's `execute` accepts `u.extraCommitPaths`.

**onReworkComplete(RD):**
- Read the regression verdicts. If the issue's scenarios and REQs now pass and no previously passing REQ in the regression set now fails, set `outcome='resolved'` and `issue.status='resolved'`.
- If the issue's key fails again, M25 merges the new signal. Set `outcome='recurred'`, and the issue is re-planned on the next drain with minDistance+1.
- If new failures appear on other REQs, those are new issues through the normal intake.
- Outcome updates are appended as a new line to `routing.jsonl` with the same id (latest wins).

**Escalation creation:** the escalation for an `ask-user`/`escalate` plan (the M14 block) is built with these options, and the M29 commands are attached:
1. the router's recommended target,
2. each alternative,
3. `route reject I-n` (accept as a known issue),
4. `resume` after a manual fix.

---

## M29 Router Overrides & Escalation UX
**REQs:** REQ-036, REQ-037, REQ-040, REQ-041. **Files:** `cli/verbs/route.ts`, `router/override.ts`.
**Verbs (LD-12, which resolves HLD OQ1):**
- `pipeline route --to <stage> [--issue I-n]`:
  - With an issue given, this is a redirect. It builds a user-authored plan through `plan(…, {forcedTarget})`, and the gate still checks caps and budget. It enacts, and marks the escalation's pending decision (if any) `overridden`.
  - Without an issue, it is a manual go-back. It appends `Signal{source:'user', targetHint, summary: --why text required}`, which M26 R10 honours.
- `pipeline route reject <I-n> --reason "<text>"`: `issue.status='known-issue'`, the latest decision is set to `rejected`, a decision log entry is written, and the escalation is cleared.
- `pipeline route choose <ESC-id> <n>`: runs the option's action.
- The checkpoint verbs are `pipeline checkpoint approve|reject` (M17), so there is no collision.

**Errors:** an unknown stage or one not in the active profile raises `USAGE`. `route` needs the lock. If the lock is held by a live run, `LOCK_HELD` is raised, and the manual go-back signal is instead appended without the lock, since the queue is append-only.

**Logging:** every override produces an event `user-decision` plus a decision log entry with `by:'user'`.

---

## M30 Critic Service Core (document mode)
**REQs:** REQ-042, REQ-043, REQ-045, REQ-046, REQ-048. **Files:** `work/critic/{critic.ts,personas.ts,schema.ts}`.

```ts
export interface CriticRequest { targets: string[] | 'app'; persona?: string; flow?: string; }
export interface CriticFinding { id: string; location: string; problem: string; heuristic: string; severity: Severity; evidence: string; suggestion: string; reqIds: string[]; persona: string; interactionRefs?: string[]; fingerprint: string; }
export interface CriticReport { sessionId: string; path: string; findings: CriticFinding[]; suppressed: number; snapshotSha: string; costUsd: number; }
export function critique(req: CriticRequest): Promise<CriticReport>;
```
**Flow:**
1. Set `snapshotSha = vcs.headSha()` and read the targets with `vcs.readAt(sha, path)`. They are copied into a temp dir, and the agent's cwd is that temp dir, so it reads the snapshot and not the live tree.
2. `inspectLock()`: if a run is active, `tags = {runId, criticSessionId:C-n}`. Otherwise `runId:'critic-standalone'`.
3. **Personas:** a fast-tier call extracts `[{name, goals, expertise}]` from understanding.md and discovery.md, cached in `.pipeline/personas.json` keyed by the docs' hashes. The default is the first persona (primary). `--persona` matches by name, case-insensitive; if there is no match, raise `USAGE` listing the options.
4. Walkthrough call: strong tier, read-only. The prompt applies the cognitive-walkthrough questions per step, with Nielsen heuristics. Output schema: `CriticFinding[]` without id or fingerprint.
5. Assign F ids in the per-session namespace `F-C<n>-<k>` (**LD-13**), which avoids clashing with review and consistency F-n. Fingerprint: `hash(heuristic|location|normalise(problem)[:80])`.
6. Suppression: drop the findings where M32 `isDismissed(targetHash, fingerprint)`.
7. Write `docs/critic/<YYYYMMDD-HHmmss>.md`, starting with the banner `> **Simulated reviewer, not real-user evidence.**`, then a reliability note ("LLM walkthroughs find some but not all usability problems; validate important findings with real users"), then the findings as `### F-C3-1` blocks. Record them through M32 as `open`.
8. The file is not committed (HLD OQ2 stands).

## M31 Critic App Mode
**REQs:** REQ-043, REQ-044. **File:** `work/critic/app.ts`.
1. Resolve the driver from supported-type (web → M23 `explore`, cli → M22 with the steps generated by the agent). Unsupported types raise `USAGE`: "app mode unsupported for <type>".
2. Consent: reuse the run's consent if a run is active and consent was given. Otherwise ask through the CLI prompt. Unattended with no consent raises `CONSENT_REFUSED`.
3. Call `explore(flow goal, persona)`. The interactions are logged as StepLogs with ids `A-<i>` under `.pipeline/evidence/critic/<C-n>/`.
4. **Coverage gate:**
   - Before exploring, a fast-tier call derives the flow's required steps from the flow name, the REQs and the acceptance. They are then checked against the observed steps: each required step must be matched by at least one StepLog, judged by the same call after exploring through a boolean map.
   - If coverage is below 100%, re-explore once with the missing steps. If it is still incomplete, the report is written with `status: incomplete coverage` and the findings are **not** recorded as promotable. They are marked `open` with a flag `coverage:false`, and M32 refuses to promote them.
5. Findings without `interactionRefs`, or whose refs don't exist, are rejected (dropped and counted in the report).

## M32 Findings Store, Promote & Dismiss
**REQs:** REQ-034, REQ-047. **File:** `control/findings.ts`. Store: `.pipeline/findings.jsonl` (latest record per id wins).

```ts
export interface FindingRecord { id: string; source: 'consistency'|'review'|'critic'; state: 'open'|'promoted'|'dismissed'; finding: CriticFinding | object; targetHash: string; fingerprint: string; reason?: string; signalId?: string; ts: string; coverage?: boolean; }
export function record(f: FindingRecord): Promise<void>;
export function promote(id: string): Promise<Signal>;                // USAGE if not open or coverage===false; appendSignal({source:'critic', sourceRef:id, reqIds, fingerprint})
export function dismiss(id: string, reason: string): Promise<void>;  // reason required (USAGE if empty)
export function isDismissed(targetHash: string, fingerprint: string): Promise<boolean>;
export function openFindings(): Promise<FindingRecord[]>;            // M14 section provider 'findings'
```
**Dismiss key:** `targetHash` is the hash of the critiqued target set at the snapshot. For documents it is the combined hash of the target docs. For the app it is the hash of the HEAD tree of `src/`. When the target changes, the suppression no longer applies.
Neither verb needs the run lock.

## M33 Critic Auto-Invocation (Could)
**REQ:** REQ-049. **File:** `control/autoCritic.ts`.
- It registers `hooksAfter: ['critic-auto']` on the `e2e` manifest when `policy.critic.autoInvoke === 'after-e2e'`.
- When the hook runs (the unit `critic-auto:e2e`):
  - If remaining/budget < `autoInvokeMinBudgetFraction`, skip it with an event.
  - Otherwise run M31 app mode (or M30 over design.md if the type is unsupported) with the primary persona and the flow set to the first Must REQ's title.
  - It uses the run's tags with `stage:'critic'`.
- Findings stay `open`. It never auto-promotes (P9).

## M34 Fast Mode & Pre-run Estimate
**REQs:** REQ-008, REQ-076. **Files:** `stages/brief.ts`, `control/fastMode.ts`.
- **brief manifest:** output `docs/brief.md`, inputs idea, strong tier, docs-write, profile `fast`, contract = base + reqHasAcceptance + reqHasPriority + supportedTypeBlock, hooks `consistency`. `postProcess` is shared with classification, so supported-type.json is written.
- **Suggestion:** `suggestMode(idea): Promise<{ mode:'fast'|'full'; reason: string }>`, a fast-tier call with no tools. The heuristic in the prompt is at most about 3 user-facing features and a single product surface. The CLI shows the suggestion and asks. The default is full when unattended.
- **Estimate:** `estimate(profile, idea): {usd, basis, breakdown}`. It sums the history median (or the prior) per stage. The increments count is estimated as `clamp(round(wordCount(idea)/15), 3, 12)` for full and `/25` capped at 6 for fast. The e2e cost scales with the increments. It is printed before `start` proceeds, and the CLI flag `--estimate-only` exits after printing.

## M35 Baseline Runner (Could)
**REQ:** REQ-080. **File:** `work/baseline.ts`, verb `pipeline baseline [--budget]`.
1. Create a git worktree at `.pipeline/baseline/<runId>` from the branch base. The sandbox mounts it instead of the main worktree.
2. Make one code-write agent call (strong tier, prompt = idea only, maxTurns 200). Its tags are `{runId, stage:'baseline'}`, and the budget defaults to the same as the main run.
3. Run M21 with the **same scenario set** from docs/e2e.md (LD per implementer OQ4), without re-derivation, pointing the driver at the baseline worktree. The entry point is asked from the agent in the final JSON as `{startCommand, command, port}`.
4. Write `docs/baseline.md`: a per-REQ verdict table, pipeline versus baseline, and a cost comparison. Commit it.

**Edge case:** the pipeline run must have completed e2e. Otherwise raise `USAGE`.

## M36 Plugin Packaging (Could)
**REQ:** REQ-081. **File:** `src/plugin/`.
**LD-14 (a provisional resolution of architecture OQ6):** ship a **skill** (`SKILL.md` plus a scripts wrapper) that shells out to the `pipeline` CLI with `--unattended --json`, and parses the `status --json` output. The reasons:
- It preserves all the Must behaviour, since the same process, lock, sandbox and ledger are used.
- It needs no second M06 adapter.

Interface: `plugin/skill/SKILL.md` documents the verbs. `plugin/bin/pipeline-skill.mjs` maps the host request to argv, streams stdout, and returns the exit code meaning (§M13). An MCP-server variant is deferred. If it is built later, it must be an alternative `AgentHost` implementing the same `run()` contract.

---

## §Z Decisions made in this LLD
| ID | Decision | Resolves |
|---|---|---|
| LD-1 | Agent shell goes through a custom `sandbox_exec` MCP tool, and native Bash is never enabled | HD-4 mechanics |
| LD-2 | `status --rebuild-hashes` recovers from lost hash records | M09 edge |
| LD-3 | The prose-section guard compares whitespace- and markup-normalised text | HLD OQ7 (partially) |
| LD-4 | Checkpoint `reject` pauses the run and changes no data | M17 semantics |
| LD-5 | `--yes-sandbox` pre-consents unattended runs | REQ-056 in unattended mode |
| LD-6 | An INC without a test command fails verification | REQ-016 |
| LD-7 | M10 exposes `commitDoc`/`recordAndTrace` for L3 modules that render their own docs | M20, M21 |
| LD-8 | Smoke subset: `router.smokeSubsetSize`, default 5 | HLD OQ4 |
| LD-9 | Issue key = source class + REQs + location class | HLD OQ3 |
| LD-10 | Downstream stages are redone only if M09 finds stale items in them | HLD OQ6 |
| LD-11 | `WorkUnit.extraCommitPaths` carries routing.md/jsonl into the first rework commit | M28 |
| LD-12 | Verbs: `checkpoint approve|reject`, `route --to`, `route reject`, `route choose` | HLD OQ1 |
| LD-13 | Critic finding IDs are `F-C<session>-<k>` | ID collision |
| LD-14 | The plugin is a skill that shells out to the CLI | Arch OQ6 (provisional) |
| — | Review signal threshold: `major`, via `router.reviewSignalMinSeverity` | HLD OQ5 |

## Test obligations (per module, minimum)
- **M01:** merge precedence, strict unknown key, shares > 1.
- **M02:** golden-parse fixtures for each doc kind, every contract rule positive and negative, IDs inside code fences ignored.
- **M03:** trailers round-trip, and non-pipeline commit detection.
- **M04:** stale lock recovery (dead pid, old heartbeat), atomic state write, truncated-line tolerance, and reconcile after a commit without a state update.
- **M05:** min(stage, run) allowance, warning emitted once, and duplicate callId.
- **M06:** a fake SDK, with the path-escape denial and Bash denial without an executor.
- **M09:** block-level staleness chain, section fallback, OQ-answer classification and preview purity.
- **M10:** guard violation leads to a re-prompt and then a restore.
- **M12:** kill after the commit and before the state write, then resume skips the unit.
- **M21:** a flaky mixed result is not routed, and the judge can't override a fail.
- **M25/M27:** recurrence steps back one stage, and caps escalate before any ledger spend.
- **M28:** the F2 and F7 seeded-fault fixtures.
- **M32:** a dismissal is suppressed until the target hash changes.

## Assumptions
1. TypeScript/Node ≥ 20 per architecture §2. The libraries named (commander, zod, yaml, remark, @inquirer/select, @playwright/mcp) are the choices of this LLD and are swappable within their modules.
2. The Claude Agent SDK exposes `query()` with `canUseTool`, `hooks.PreToolUse`, `maxBudgetUsd`, `resume`, and in-process MCP servers. If `maxBudgetUsd` is unavailable, M06 enforces the cap by aborting the stream when the cumulative cost reported in messages exceeds it.
3. `docs/idea.md` is the persisted idea input and the root of the dependency graph.
4. The implementer doc for this project is `docs/implementer.md`, so the impl-plan stage writes that path.
5. Prices, model ids and the prior-cost table are configuration, not code constants, except for the defaults.

## Open questions
1. Egress restriction during `install` is best-effort (a proxy allow-list). A strict allow-list may need a sidecar proxy container. That is decided in M18 implementation, and it doesn't affect interfaces.
2. Whether the critic's `docs/critic/*.md` should be auto-committed stays open (HLD OQ2). The LLD keeps them uncommitted.
3. The confidence combination constants (0.5/0.5, 0.6, 0.2) are initial values. They should be calibrated from `routing.jsonl` after dogfooding.
4. The M19 write roots for non-Node stacks, such as Python or Go, are taken from the architecture doc of the *generated* product. If it doesn't declare them, the default is `src/`, `tests/` and the root manifest files.
5. Playwright MCP inside the container over `docker exec` stdio has not been validated. The fallback is to run MCP on the host, pointed at the container-published port, with the browser still in the container through `connectOverCDP`.

## Modules not yet specified
None. All 36 module IDs in `docs/implementer.md` (M01–M36) have a section above. I checked each ID against this document: M01, M02, M03, M04, M05, M06, M07, M08, M09, M10, M11, M12, M13, M14, M15, M16, M17, M18, M19, M20, M21, M22, M23, M24, M25, M26, M27, M28, M29, M30, M31, M32, M33, M34, M35, M36 are all specified. M24, M33, M35 and M36 are Should/Could modules, and their specs are shorter. M36's spec is provisional on architecture open question 6 (LD-14).
