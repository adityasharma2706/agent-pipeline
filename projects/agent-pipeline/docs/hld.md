<!-- Written by: system-design stage (high-level design). Read by: low-level-design. -->

# High-Level Design: Idea-to-Tested-Software Pipeline

**Summary**
- This document describes how the 36 modules in `docs/implementer.md` (M01–M36) fit together at runtime. It is organised in layers, with one owning module for each shared data structure, a small set of interfaces between modules, and nine key interaction flows.
- There is one process per CLI invocation and two entry points. The **run path** (M12 Run Controller) holds the project run lock. The **critic path** (M30) never holds that lock and communicates with the run path only through durable files, the signal queue and the ledger.
- The whole system hangs on four seams. **Documents + ID blocks** (M02) are the content contract. The **Trace graph** (M08) and the **Stale set** (M09) are the derived knowledge. **Work units + safe points** (M12/M04) are the control contract. The **Signal → Issue → Routing Decision** chain (M04 → M25 → M26 → M27 → M28) is the feedback contract.
- Every module writes durable state to exactly one kind of store. Only M03 commits to git, only M06 calls the model, and only M18 executes generated code. Almost all cross-cutting guarantees (REQ-017, REQ-056, REQ-072, REQ-074) are enforced at those three choke points.
- Per-function signatures, file schemas and prompt text are deliberately left to low-level design. §12 lists the decisions this document makes where the upstream documents were silent (for example, M04 owns the signal queue).

Requirement IDs refer to `docs/design.md` §7, component and AD numbers refer to `docs/architecture.md`, and module IDs refer to `docs/implementer.md`.

---

## 1. System shape

### 1.1 Layers

Modules are grouped into five layers. **Dependency rule:** a module may call modules in its own layer or any layer below it, and never a layer above. Upward communication goes only through durable records (events, signals, ledger entries) that the upper layer reads. The only exceptions are the explicitly registered callbacks in §1.3.

| Layer | Purpose | Modules |
|---|---|---|
| **L5 Interface** | Parse verbs, render progress, status, escalation blocks and consent prompts. No business logic. | M13, M17 (verbs part), M29 (verbs part), M30 (`critic` verb), M32 (`finding` verbs), M35 (`baseline` verb), M36 |
| **L4 Control** | Decide what runs next and whether rework happens | M12, M17 (policy part), M25, M26, M27, M28, M29 (gate-override part), M33, M34 (suggestion part) |
| **L3 Work** | Carry out one unit of work: produce a document, code, findings or verdicts | M10, M11, M16, M19, M20, M21, M22, M23, M24, M30, M31, M35 |
| **L2 Knowledge** | Derived views over the durable state: parsing, trace, staleness, rendering | M02, M07, M08, M09, M14, M15 |
| **L1 Infrastructure** | The single choke points for external effects, plus durable state | M01, M03, M04, M05, M06, M18 |

M14 (Reporter) and M15 (Decision Log) sit in L2 because they are pure *renderers* over durable state. They are *triggered* by L4 (M12 at every stop) but never call into L4.

### 1.2 Choke points (single owners of external effects)

| Effect | Sole owner | What this guarantees | REQs |
|---|---|---|---|
| Model/API calls | **M06** Agent Host Adapter | Every call is budget-checked and metered, runs under a permission profile, starts a fresh session and is logged | REQ-062, REQ-070, REQ-072, REQ-074, REQ-081 |
| Git writes (commit, branch) | **M03** VCS Gateway | One commit per unit with trailers, on the `pipeline/<run-id>` branch; non-pipeline changes detectable | REQ-017, REQ-038, REQ-063 |
| Execution of generated code | **M18** Sandbox Manager | Isolation, and consent before the first execution in a run | REQ-056 |
| Run-state mutation | **M04** Run State/Event Log/Lock | Atomic snapshots, append-only events, one active run | REQ-005, REQ-006, REQ-009 |
| Spend accounting | **M05** Ledger | Budget enforced before every call; attribution by run, stage, increment, go-back and critic | REQ-070–REQ-075 |

Low-level design must not introduce a second path to any of these effects. For example, M22/M23 do not shell out directly; they go through M18.

### 1.3 Registered callbacks (the only upward calls)

1. **Shell-execution hook in M06 → M18.** M06 is built before M18 and defaults to *deny* for all shell tool use. M18 registers itself as the shell executor when present, so agent shell calls are routed into the sandbox (REQ-056).
2. **Budget signals from M05 → M12.** M05 raises `budget_warning` and `budget_exhausted` as events in M04's log and as an in-process notification. M12 acts on the notification only at the next safe point (REQ-073, REQ-075).
3. **Stage hooks in M07 → L3/L4.** Stage manifests may name post-stage hooks: consistency check after design, architecture and impl-plan (M16), and the critic auto-invoke point (M33). M12 runs them; M07 only declares them.

### 1.4 Runtime topology

```
                    ┌──────────────── one CLI process ────────────────┐
 pipeline start ──▶ │ M13 ─▶ M12 ─▶ (M10 | M19 | M20 | M21 | M16) ... │ holds run lock (M04)
 pipeline resume    │         └─▶ M25 → M26 → M27 → M28 (rework)       │
 pipeline status    │ M13 ─▶ M14 (read-only render)                    │ no lock
 pipeline critic    │ M30/M31 ─▶ M06, M18 (read snapshot @HEAD)        │ no run lock (AD-15)
 pipeline finding   │ M32 ─▶ M04 signal queue                          │ no run lock
                    └─────────────────────────────────────────────────┘
        shared durable state: docs/ (git), .pipeline/{state.json, events, ledger, signals,
        routing, findings, trace, hashes, evidence, logs}
```

- **Concurrency model.** There is at most one *writer of run progress* (the lock holder). Critic and finding processes may run at the same time and may write only to append-only stores: `ledger.jsonl`, `signals.jsonl`, `findings.jsonl`, `docs/critic/*`, evidence and logs. `status` is read-only. Appends to these stores must be atomic per record (see §10.3).
- **Critic commits.** Critic reports under `docs/critic/` are **not** committed by the critic process, because it doesn't hold the run lock. M03 picks them up in the next pipeline commit, or the user commits them. See open question 2.

---

## 2. Core data structures

Each structure has one **owning module** that defines it and is the only writer of its durable form. Other modules read it. Fields are listed at the conceptual level; exact schemas belong to low-level design.

### 2.1 Configuration and registry

| Structure | Owner | Key contents | Consumers | REQs |
|---|---|---|---|---|
| **Policy** | M01 | budget default, stage shares, model tier map, checkpoint list, router thresholds and caps (go-backs per run, attempts per issue), unattended hand-edit policy, sandbox mode, critic auto-invoke point, flake re-run count, warning threshold, standalone critic cap | all | REQ-003, REQ-027, REQ-037, REQ-049, REQ-070, REQ-071 |
| **StageManifest** | M07 | stage id, output document path, required inputs (doc / section / ID kinds), role template ref, model tier, permission profile, budget share, checkpoint-capable flag, profiles membership, post-stage hooks, *upstream stage ids* (edges of the stage dependency graph) | M09, M10, M11, M12, M19, M20, M21, M33, M34 | REQ-008, REQ-010, REQ-013, REQ-071 |
| **ModeProfile** | M07 (mechanism), M34 (`fast` content) | ordered list of stage ids for `full` or `fast` | M12 | REQ-008 |
| **PermissionProfile** | M06 | `read-only`, `docs-write` (docs/ only), `code-write` (worktree only, shell → sandbox) | M07 manifests reference it by name | REQ-018, REQ-047, REQ-056 |
| **RoleTier** | M06 (resolution), M01 (map) | `strong` / `standard` / `fast` → model | M06 | AD-13 |

### 2.2 Documents and derived knowledge

| Structure | Owner | Key contents | Consumers | REQs |
|---|---|---|---|---|
| **StageDocument** | M02 (model); written by the stage's L3 module | header comment (writer/readers), front-matter (`stage`, `run_id`, `generated_from`, `schema_version`), summary, sections, ID blocks, Assumptions, Open questions | M08, M09, M10, M14, M15, M16, M17, M21, M26, M30 | REQ-004, REQ-011, REQ-012 |
| **IdBlock** | M02 | id (kind + number: REQ, AD, T, INC, E2E, F), location (doc, heading/row), body, content hash, outgoing references (`REQ-nnn` tokens etc.), kind-specific attributes (REQ: priority + acceptance intent; AD: status/superseded-by; T/INC: REQ refs) | M08, M09, M10 (Preservation Guard), M16 | REQ-020–REQ-023 |
| **ContractViolation** | M02 | rule broken, location, severity (blocking or warning) | M10 (re-prompt/escalate), M16 | REQ-004, REQ-011, REQ-012 |
| **OpenQuestion** | M02 (extraction), M09 (answered state) | source doc and section, text, answered flag, answer text | M14 roll-up, M17 | REQ-028, REQ-061 |
| **TraceGraph** | M08 | nodes = ID blocks + commits + verdicts + evidence refs; typed edges REQ→AD, REQ→T, T→INC, INC→commit, REQ→E2E, E2E→Verdict, Verdict→Evidence, F→REQ | M09, M14, M16, M21, M26, M27 | REQ-015, REQ-023, REQ-024, REQ-033, REQ-052 |
| **HashRecord** | M09 | for each artefact (document or ID block or increment): the upstream block hashes it was generated from, and its own hash at the last pipeline commit | M09 only (persisted in `.pipeline/hashes/`) | REQ-006, REQ-013, REQ-027 |
| **StaleSet** | M09 | list of stale items, each with: item (doc / section / ID block / INC), granularity used, *cause* (upstream change, user-edit, restart, routing decision id) and the causal chain back to the root change | M10, M12, M14, M17, M27, M28 | REQ-007, REQ-027, REQ-033, REQ-038 |
| **EditRecord** | M09 (detection), M03 (git evidence) | document, changed blocks, classification `user-edit` or `oq-answer`, commit/working-tree origin | M17, M15 | REQ-026, REQ-027, REQ-028 |

**Granularity contract (M09 → everyone):** a stale item is always reported at the finest granularity that exists: ID block, then section, then whole document. The `granularity` field tells consumers which one was used. M10's Preservation Guard and M27's cost estimate both depend on this.

### 2.3 Run control

| Structure | Owner | Key contents | Consumers | REQs |
|---|---|---|---|---|
| **RunState** (`state.json`) | M04 (storage), M12 (sole mutator via M04) | run id, branch, mode profile, controller state (§5), current/last completed unit, completed-unit list with commit refs, pending escalation, consent record, budget top-ups, checkpoint config snapshot | M12, M13, M14, M17 | REQ-005, REQ-006 |
| **WorkUnit** | M12 | kind (`stage`, `increment`, `review`, `consistency`, `e2e`, `e2e-regression`, `critic-auto`, `rework-stage`, `rework-increment`), target id, mode (`normal` / `revise`), stale targets (revise only), originating routing decision id (rework only), ledger attribution tags | M10, M16, M19, M20, M21, M33 | REQ-006, REQ-016, REQ-038 |
| **UnitOutcome** | each L3 executor | status (`committed`, `failed-verification`, `contract-violation`, `guard-violation`, `budget-stopped`, `error`), commit ref, emitted signals, cost | M12 | REQ-013, REQ-016, REQ-073 |
| **Event** | M04 | timestamp, run id, type (state transition, unit start/end, budget warning, go-back, escalation, checkpoint, consent, user decision), payload | M13 (progress/verbose), M14, M15 | REQ-005, REQ-062 |
| **Escalation** | M12 (raised), M14 (rendered), M29 (resolved) | reason (low confidence, cap reached, budget insufficient for rework, guard violation, contract violation, hand-edit policy, verification exhausted), problem summary, options with commands and the recommended option first, related routing decision id | M13, M14, M17, M29 | REQ-036, REQ-037, REQ-072 |
| **RunLock** | M04 | PID, heartbeat time, run id | M12 (acquire), M13 (`start` refusal message) | REQ-009 |

### 2.4 Cost

| Structure | Owner | Key contents | Consumers | REQs |
|---|---|---|---|---|
| **LedgerEntry** | M05 | run id (or `critic-standalone`), stage, increment, go-back id, critic session id, model tier, tokens, cost, timestamp | M14, M27, M34, M35 | REQ-074 |
| **Allowance** | M05 | per-call cap = min(stage share remaining, run remaining), or a refusal | M06 | REQ-072 |
| **BudgetProjection** | M05 | spent, remaining, median-history estimate of remaining units, likely-to-finish flag | M13, M14 | REQ-075 |
| **CostEstimate** | M05 (history query), M27 (rework), M34 (pre-run) | point estimate + basis (history / prior) | M14, M27, M29 | REQ-033, REQ-076 |

### 2.5 Checks, verdicts and findings

| Structure | Owner | Key contents | Consumers | REQs |
|---|---|---|---|---|
| **Finding** (common shape) | producers: M16 (consistency), M20 (review), M30/M31 (critic) | id `F-n`, source (`consistency`/`review`/`critic`), location, problem, severity, affected REQ/AD ids, evidence refs; critic-only fields: heuristic/guideline, suggestion, persona, interaction refs | M14, M25, M32 | REQ-015, REQ-018, REQ-046 |
| **FindingState** | M32 | open / promoted / dismissed (+ reason), dismissal key = (target content hash, finding fingerprint) | M14, M30 (suppression) | REQ-047 |
| **Scenario** | M21 | `E2E-n`, REQ id(s), preconditions, steps, expected observations derived from acceptance intent, driver kind, repeatable-spec ref | M22–M24, M08 | REQ-051 |
| **ScenarioResult** | M21 (with driver data) | pass / fail / flaky / error, attempts, evidence refs | M21 judge, M25 | REQ-053, REQ-054 |
| **Verdict** | M21 | per REQ: `pass` / `fail` / `not verifiable` + reason, scenario results used, judge rationale, evidence refs | M08, M14, M25, M35 | REQ-052 |
| **EvidenceRef** | M21 (E2E), M31 (critic) | path under `.pipeline/evidence/<run>/…`, kind (step log, stdout, snapshot, screenshot, trace) | M08, M14, M26 | REQ-054, REQ-044 |
| **SupportedTypeVerdict** | M11 (classification stage) | product type, support level (`full` / `partial` / `unsupported`), driver kind | M13, M21, M31 | REQ-014 |

### 2.6 Feedback chain

| Structure | Owner | Key contents | Consumers | REQs |
|---|---|---|---|---|
| **Signal** | M04 (queue storage); produced by M16, M19, M20, M21, M32, M29 (user report) | source kind, source ref (finding id / scenario / INC), REQ ids, raw evidence refs, produced-at unit | M25 (consumer); M14 (pre-M25 display) | REQ-034 |
| **Issue** | M25 | stable issue key (normalised symptom + REQ ids + location class), signals merged, attempt count, history of routing decision ids, status (`open`/`routed`/`resolved`/`known-issue`/`flaky`) | M26, M27, M28, M19 (attempt counting) | REQ-034, REQ-035, REQ-037, REQ-053 |
| **EvidenceBundle** | M26 | trace chain around the issue (REQ→AD→T→INC→E2E→verdict), linked document excerpts, diff scope of the INC, evidence refs | M26 attributor, M28 (links in decision) | REQ-030 |
| **Attribution** | M26 | ranked candidate stages each with rationale; rule hits; LLM ranking; confidence bucket + one-line reason | M27 | REQ-031, REQ-032 |
| **RoutingPlan** | M27 | chosen target stage, nearest-first position, alternatives, impact (StaleSet), CostEstimate vs remaining budget, gate result `auto-proceed` / `ask-user` / `escalate` with reason | M28, M29, M12 | REQ-033, REQ-035, REQ-036, REQ-037, REQ-072 |
| **RoutingDecision** | M28 | the published, user-readable record: symptom, origin, REQ ids, evidence links, confidence + reason, alternatives, impact, cost vs remaining, author (`router` / `user`), outcome (`pending`/`resolved`/`recurred`/`rejected`/`overridden`) | M12, M14, M15, M29 | REQ-030, REQ-041 |

---

## 3. Durable stores and ownership

| Store | Writer (only) | Readers | Kind |
|---|---|---|---|
| `docs/<stage>.md` | the stage's L3 module via M10 (content) → M03 (commit) | L2, L3, L4 | authored, git |
| `docs/review.md` | M20 via M10 | M08, M14, M25 | authored, git |
| `docs/e2e.md` (scenarios + verdicts view) | M21 | M08, M14, M26 | authored, git |
| `docs/routing.md` | M28 | user, M14 | rendered, git |
| `docs/decisions.md` | M15 | user, M14 | rendered, git |
| `docs/run_report.md` | M14 | user | rendered, git |
| `docs/critic/<ts>.md` | M30/M31 | user, M32 | authored, uncommitted until next pipeline commit |
| `src/`, tests | M19 (agent via M06 code-write) | M20, M21 judge, M18 | code, git |
| `.pipeline/state.json`, `lock`, `events.jsonl`, `signals.jsonl` | M04 (M12 is the sole caller for state) | M12, M13, M14, M15, M25 | operational |
| `.pipeline/ledger.jsonl` | M05 | M13, M14, M27, M34 | append-only |
| `.pipeline/routing.jsonl` | M28 (router decisions), M29 (user decisions) | M14, M15, M26 (calibration) | append-only, cross-run |
| `.pipeline/findings.jsonl` | M32 | M14, M30, M25 | append-only (state as latest record) |
| `.pipeline/trace.json` | M08 | M09, M14, M16, M26, M27 | derived cache, rebuildable |
| `.pipeline/hashes/` | M09 | M09 | derived-at-commit |
| `.pipeline/evidence/`, `.pipeline/logs/` | M21/M22–M24/M31 (evidence), M06 (logs) | M14, M26, M13 verbose | gitignored |

**Safe-point write order (M12 orchestrates, AD-3):** unit output on disk → M03 commit (with trailers) → M09 records hashes → M08 rebuilds the trace → M04 updates `state.json` and appends the event. If there is a crash between the commit and the state update, M04's reconciliation reads M03 trailers on resume. Hashes and trace are recomputed because they are derived.

---

## 4. Module interfaces

Each interface is listed with its provider, main consumers, the operations it offers (coarse), and the REQs it carries. The operation names are descriptive, not API names.

### 4.1 Infrastructure (L1)

**I-CFG: Policy access (M01)**
- Provides: resolved Policy (config file merged with CLI flags), with per-key provenance for the report.
- Consumers: all modules.
- REQs: REQ-003, REQ-027, REQ-037, REQ-049, REQ-070, REQ-071.

**I-VCS: Version control (M03)**
- Ensure the run branch exists and is checked out; commit a unit (paths, message, trailers `Pipeline-Run`, `Stage`, `Refs`, `Routing-Decision`); find the commit for a unit; diff for a unit; list non-pipeline changes since a commit (commits without pipeline trailers + working-tree changes); read file content at a revision (for ID-reuse checks and critic snapshots); revert a unit (user verb).
- Consumers: M09 (edit detection), M10, M16 (ID history), M19, M28, M30 (HEAD snapshot), M04 (trailer reconciliation), M17.
- REQs: REQ-017, REQ-026, REQ-038, REQ-063, REQ-020 (history check).

**I-STATE: Run state, events, lock, signals (M04)**
- Lock: acquire / heartbeat / release / inspect (with dead-PID recovery).
- State: read snapshot / atomic replace (M12 only) / reconcile from VCS trailers.
- Events: append / tail / query by run.
- Signals: append (any producer) / read unconsumed / mark consumed (M25 only).
- Consumers: M12 (all), M13 (tail, inspect lock), M14/M15 (query), M16/M19/M20/M21/M29/M32 (append signals), M25 (consume).
- REQs: REQ-005, REQ-006, REQ-009, REQ-034, REQ-062.

**I-LEDGER: Budget and cost (M05)**
- Request an Allowance for a call (tags: run, stage, increment, go-back, critic); record usage; totals by tag; BudgetProjection; historical cost for a stage kind (median, count); top up the budget (resume); per-scope caps (run, stage share, standalone critic).
- Emits (through I-STATE events plus an in-process notification to M12): warning threshold crossed, budget exhausted.
- Consumers: M06 (allowance and usage), M12, M13, M14, M27, M30, M34, M35.
- REQs: REQ-070–REQ-075, REQ-033.

**I-AGENT: Agent invocation (M06)**
- Run one agent unit: role tier, permission profile, system/role template, context documents, tool allow-list, attribution tags, optional structured-output expectation. Returns final text/artefacts, usage and a transcript ref. It fails fast with `budget-refused` if the allowance is refused.
- Guarantees: fresh session per unit (an in-unit retry may continue its session); every call passes through I-LEDGER; permissions are enforced by callbacks/hooks, not just by prompt; shell tool use is denied unless an I-SANDBOX executor is registered.
- Consumers: M10, M16 (LLM layer), M19, M20, M21 (deriver, judge, web exploration), M26, M30, M31, M34 (classifier), M35.
- REQs: REQ-056, REQ-062, REQ-070, REQ-072, REQ-074, REQ-081.

**I-SANDBOX: Isolated execution (M18)**
- Ensure consent for this run (renders a consent block through M13; the result is recorded in RunState via M12/M04); exec a command (cwd, env allow-list, time/CPU/memory limits, network phase `install` or `run`) → exit code, stdout, stderr, artefact paths; start the app (entry point from the implementation doc) → handle, reachable localhost endpoint; stop the app; register as M06's shell executor; report the mode (`container` / `local-restricted`) for M14.
- Consumers: M19, M21–M24, M31, M35, M06 (hook).
- REQs: REQ-016, REQ-044, REQ-050, REQ-056.

### 4.2 Knowledge (L2)

**I-DOC: Document model (M02)**
- Parse a document → StageDocument; list ID blocks and references; hash a block/section/document; validate against a contract profile (the base contract plus stage-specific rules, e.g. "REQ blocks carry acceptance intent", "AD blocks carry status + REQs"); extract open questions.
- Consumers: M08, M09, M10, M14, M15, M16, M17, M21, M26, M30.
- REQs: REQ-004, REQ-011, REQ-012, REQ-020–REQ-023.

**I-REGISTRY: Stage registry (M07)**
- Look up a manifest by id; list the stages of a mode profile in order; upstream/downstream stages of a stage; checkpoint candidates; hooks after a stage.
- Consumers: M09, M10, M12, M17, M33, M34.
- REQs: REQ-008, REQ-010, REQ-013, REQ-071.

**I-TRACE: Trace graph (M08)**
- Rebuild (full or for one changed doc); coverage query (Must REQs lacking a task / INC / scenario / verdict); orphan query; unknown-reference query; downstream closure of a node set; upstream chain for a node (used by the router); coverage matrix rows for the report.
- Consumers: M09, M14, M16, M21, M26, M27.
- REQs: REQ-015, REQ-023, REQ-024, REQ-033, REQ-052.

**I-STALE: Staleness (M09)**
- Record the generation basis for an artefact at commit; compute the current StaleSet (full scan, or "what if these blocks change" for M27 impact previews without mutating anything); detect edits → EditRecords; mark items stale by fiat (restart, routing decision) with a cause; check the preconditions of a stage (inputs exist and are not stale).
- Consumers: M10 (preconditions, recording), M12 (next unit), M14, M17, M27 (preview), M28 (mark).
- REQs: REQ-006, REQ-007, REQ-013, REQ-026, REQ-027, REQ-028, REQ-033, REQ-038.

**I-REPORT: Rendering (M14)**
- Render the run report (at every stop), the status view, escalation blocks and routing-decision summaries. Sections are **section providers** registered by later modules: coverage and verdicts (M21), go-backs (M28), open findings (M32), consistency/review findings (M16/M20, before M25). A missing provider renders `n/a`.
- Consumers: M12 (trigger on stop), M13 (status, escalation display), M29.
- REQs: REQ-005, REQ-024, REQ-060, REQ-061, REQ-074.

**I-DECISIONS: Decision log (M15)**
- Record a decision (by stage, router or user; what, why, supersedes); re-render `docs/decisions.md` from events; maintain AD supersession consistency.
- Consumers: M10 (stage-declared decisions), M17 (user edits), M28, M29.
- REQs: REQ-022, REQ-025.

### 4.3 Work (L3)

All L3 executors share one shape: **execute(WorkUnit) → UnitOutcome**. They are called only by M12, except M30/M31, which are called by the critic entry point. Each may append Signals and must not commit except through M10/M03.

**I-STAGE: Stage runner (M10)**
- Execute a document-stage WorkUnit in `normal` or `revise` mode. Internally: I-STALE precondition check → context assembly (upstream docs, answered open questions; in revise mode also the routing decision, stale IDs and the current doc) → I-AGENT → I-DOC validation (one re-prompt) → Preservation Guard (revise mode: every non-stale block hash unchanged; one re-prompt) → I-VCS commit → I-STALE record → I-TRACE rebuild.
- Outcome on a failed validation or a guard violation after the re-prompt: `contract-violation` / `guard-violation`, which M12 turns into an Escalation.
- Used by: M11 (document stages), M19 (implementer stage definition shares context assembly), M20, M21 (e2e.md), M34 (brief stage).
- REQs: REQ-002, REQ-004, REQ-011–REQ-013, REQ-026, REQ-038.

**I-STAGEDEF: Stage definitions (M11, M19, M20, M21, M34)**
- Each provides manifests plus role templates, registered into M07. Stage-specific contract rules are supplied to M02's validator as a contract profile. The classification definition (M11) must produce the SupportedTypeVerdict in a machine-readable block.
- REQs: REQ-010, REQ-012, REQ-014, REQ-020–REQ-023.

**I-CONSIST: Consistency check (M16)**
- Execute the `consistency` unit after a planning stage: deterministic checks via I-TRACE + I-VCS history, then an LLM contradiction scan via I-AGENT (read-only). Output: Findings plus a Signal for each finding that needs action. Never writes documents other than its own findings section in the report data.
- REQs: REQ-015, REQ-020, REQ-023, REQ-034.

**I-INCREMENT: Increment executor (M19)**
- Execute one `increment` / `rework-increment` unit: implementer agent (code-write) → Verification Gate via I-SANDBOX (build + the increment's own tests) → commit with `Refs: REQ-…, T-…, INC-…`. On failure: bounded local retry, then a Signal (source `verification`) and `failed-verification` outcome.
- Attempt counting: uses the Issue attempt count from M25 when present; before M25 it keys on INC id and applies the M01 cap directly.
- REQs: REQ-016, REQ-017, REQ-023, REQ-037, REQ-056.

**I-REVIEW: Reviewer (M20)**
- Execute the `review` unit read-only; writes `docs/review.md` (through M10) and Signals for findings above a severity threshold (threshold is policy, see open question 5).
- REQs: REQ-018, REQ-034.

**I-E2E: E2E harness (M21) and I-DRIVER plug-ins (M22, M23, M24)**
- M21 executes `e2e` and `e2e-regression` units: derive scenarios (context limited to REQs, acceptance intent, SupportedTypeVerdict and public entry points; **no source access**, enforced by the permission profile and context assembly) → select a driver by driver kind → run → flake filter (re-run failures N times in fresh app instances) → Requirement Judge per REQ (read-only code access for omission checks only) → Verdicts + evidence → Signals for non-flaky failures and for Must REQs judged `fail`.
- Regression unit input: previously failing scenarios, previously passing scenarios of affected REQs (from the StaleSet), and a smoke subset.
- **I-DRIVER** (implemented by M22 CLI, M23 web, M24 lib/API; consumed by M21 and M31): declare supported driver kind; prepare (via I-SANDBOX: start app or ready the CLI); run a scenario (or free exploration for the critic) → step log, observations, evidence refs; replay a repeatable spec (M23: generated Playwright spec); teardown. Unsupported types have no driver, and M21 emits `not verifiable: unsupported type` directly.
- REQs: REQ-014, REQ-039, REQ-050–REQ-055.

**I-CRITIC: Critic (M30, M31) and I-FINDINGS (M32)**
- M30: critique(target = doc | doc set | app, persona?, flow?) → a critic report with Findings, a banner and a reliability note. It takes the snapshot at HEAD through I-VCS, charges I-LEDGER with the run tags if a run is active (lock inspected via I-STATE), otherwise with the standalone critic cap. It filters out dismissed findings using I-FINDINGS suppression keys.
- M31: app-mode extension; uses I-SANDBOX and I-DRIVER exploration. **Coverage gate:** the report is accepted only if the recorded interactions cover the requested flow, and every finding cites interaction refs.
- M32 (I-FINDINGS): record findings; promote (→ Signal with source `critic` via I-STATE); dismiss with a reason (stores the suppression key); list open findings (report section provider).
- REQs: REQ-042–REQ-048 (M30/M31), REQ-034, REQ-047 (M32).

### 4.4 Control (L4)

**I-RUN: Run controller (M12)**
- Verbs it serves (called by M13/M17/M29): start(idea, mode, budget), resume(top-up?), stop-requested, apply-user-decision(escalation option | checkpoint approve/reject | route override).
- Internal loop: choose the next WorkUnit → dispatch to L3 → handle the UnitOutcome → safe point (§3) → run the stage hooks → drain signals into the router (Phase 4+) → check the budget notification → transition state.
- **Next-unit rule** (deterministic, re-derivable from files): (1) pending rework units from accepted RoutingDecisions, in stage-dependency order; (2) otherwise the first stale or missing unit of the mode profile, in profile order (M09 StaleSet ∩ M07 profile); (3) otherwise, if unconsumed signals exist, route them; (4) otherwise `done`.
- REQs: REQ-002, REQ-006, REQ-009, REQ-010, REQ-013, REQ-073.

**I-HUMAN: Human control (M17)**
- Checkpoint handling: after a checkpoint-capable stage listed in Policy, M12 transitions to `checkpoint`; M17's `approve` resumes, and `reject` stops (the run stays resumable).
- Restart from a stage: I-STALE mark-by-fiat on the stage and everything downstream, cause `restart`.
- Resume-time edit flow: I-STALE edit detection → present the StaleSet with causes → confirm (attended) or apply policy (unattended; the default raises an `Escalation(reason = hand-edit policy)`) → I-DECISIONS "user edit".
- REQs: REQ-003, REQ-007, REQ-026–REQ-028, REQ-061.

**I-ROUTER: Router chain (M25 → M26 → M27 → M28, with M29)**
- M25 intake: consume Signals → merge into Issues by issue key → drop flaky items (record only) → produce the "issues ready to route" list.
- M26 attribute(Issue) → EvidenceBundle + Attribution. The rules layer is deterministic over I-TRACE; the LLM layer runs via I-AGENT (strong tier, read-only, documents + evidence, no transcripts). Calibration input: past outcomes from `routing.jsonl`.
- M27 plan(Issue, Attribution) → RoutingPlan. Nearest-first over the stage order in I-REGISTRY; on recurrence (the Issue already has a resolved-then-recurred decision) the minimum distance steps back by one stage. Impact via I-STALE preview; cost via I-LEDGER history × stale fraction + regression cost; the gate applies REQ-036 policy, the caps from Policy, and a budget sufficiency check.
- M28 enact(RoutingPlan) → RoutingDecision published (`docs/routing.md`, `routing.jsonl`, I-DECISIONS). If `auto-proceed` (or user-accepted), it marks the stale set with cause = decision id via I-STALE and hands M12 the rework WorkUnits in dependency order ending with an `e2e-regression` unit. After regression it sets the outcome: failing items fixed and no regression → `resolved`; same issue key fails again → `recurred` (the Issue re-enters M27).
- M29 overrides: redirect (user-authored plan re-entering the M27 gate with target fixed; caps and budget still apply), reject as known issue (Issue → `known-issue`, outcome `rejected`), manual go-back (creates a Signal of source `user` with a target hint that M27 honours), and escalation option selection. All are logged as user-authored.
- REQs: REQ-030–REQ-041, REQ-053, REQ-072.

### 4.5 Interface (L5)

**I-CLI (M13 core; verbs added by M17, M29, M30, M32, M34, M35)**
- Verb → call on I-RUN / I-HUMAN / I-ROUTER (M29) / I-CRITIC / I-FINDINGS / baseline. The progress renderer is a subscriber to I-STATE events (one line per unit event; verbose tails M06 logs). The escalation and consent prompts are rendered by M14/M18 content and displayed by M13.
- Verb-name collision to resolve in low-level design: M17's checkpoint `reject` and M29's "reject go-back as known issue" (see open question 1).
- REQs: REQ-001, REQ-005, REQ-006, REQ-014, REQ-062, REQ-070, REQ-074, REQ-075.

---

## 5. Run Controller state machine (M12)

```
            start                  unit committed & more work
  idle ─────────────▶ running ◀───────────────────────────────┐
                        │  │                                   │
    checkpoint-capable  │  │ outcome / signal / budget          │ resume / approve / user decision
    stage done & listed │  ▼                                   │
                        │  ├─▶ checkpoint ─────────────────────┤
                        │  ├─▶ escalated ──────────────────────┤
                        │  ├─▶ budget_stopped ──(resume+top-up)┤
                        │  └─▶ crashed (implicit: lock dead) ──┘ (resume)
                        ▼
                      done  (every Must REQ has a Verdict and no auto-rework remains within limits)
```

| Transition | Triggered by | Module |
|---|---|---|
| running → checkpoint | stage complete ∧ stage in Policy checkpoint list | M12 + M17 |
| running → escalated | gate result `escalate`; `ask-user` in attended mode; guard/contract violation after re-prompt; verification exhausted with the router absent (pre-Phase 4); hand-edit policy | M12, raised from M10/M19/M27 |
| running → budget_stopped | M05 exhausted notification, acted on at the next safe point | M12 |
| (any) → crashed | process death; recognised on the next command via dead lock PID | M04 |
| stopped state → running | `resume` / `approve` / escalation option / route override | M13 → M17/M29 → M12 |
| running → done | next-unit rule step (4) with the done condition met | M12 |

**Report on every stop:** entering any state other than `running` triggers I-REPORT (REQ-060). `ask-user` in attended mode is an `escalated` state that the CLI resolves immediately in the same process. In unattended mode the process exits.

---

## 6. Key interaction flows

### 6.1 Forward document stage (Milestone A)
1. M12 selects `stage:<id>` (next-unit rule 2) and asks M05 via M06 per call.
2. M10: I-STALE precondition check → context assembly → I-AGENT (`docs-write`) → I-DOC validate (one re-prompt) → I-VCS commit → I-STALE record → I-TRACE rebuild.
3. M12 safe point → event → M13 prints `✓ <stage> $x`. After classification (M11), M13 prints the supported-type line (REQ-014).
4. Hooks from M07: after design, architecture and impl-plan, M12 runs the M16 `consistency` unit; its Signals are queued (REQ-015).
5. If the stage is in the checkpoint list → `checkpoint` (REQ-003).

### 6.2 Increment (Milestone B)
1. M12 expands the impl-plan's INC blocks (via I-TRACE) into `increment` units in plan order.
2. The first unit that needs the sandbox triggers the M18 consent block. Consent is recorded in RunState; refusal → `escalated` (REQ-056).
3. M19: agent (`code-write`, shell → M18) → Verification Gate in M18 → commit with `Refs` trailers (REQ-016, REQ-017). On failure: local retry, then a Signal.

### 6.3 E2E (Milestone C)
M21 derives scenarios (no source access) → I-DRIVER per supported type → flake filter → Requirement Judge → Verdicts written to `docs/e2e.md` and a verdict manifest → I-TRACE picks up E2E→Verdict edges → Signals for non-flaky failures → M14 coverage section (REQ-050–REQ-054).

### 6.4 Rework loop (Milestone D, design F2)
```
M21 Signal ─▶ M04 queue ─▶ M25 Issue(key) ─▶ M26 EvidenceBundle (M08) + Attribution (rules + M06)
   ─▶ M27 nearest-first target, impact preview (M09), cost (M05), gate
        ├─ auto-proceed ─▶ M28 publish decision, M09 mark stale(cause=decision)
        │                  ─▶ M12 schedules: rework-stage (M10 revise, guard) → downstream stale
        │                     stages → rework-increment (M19) → e2e-regression (M21)
        │                  ─▶ M28 outcome: resolved | recurred(→M27 steps back)
        ├─ ask-user (attended) ─▶ M12 escalated → M13 prompt → M29 decision → M28
        └─ escalate ─▶ M12 escalated, M14 escalation block, process exits
```
Every rework unit carries the go-back id so that M05 itemises rework cost (REQ-074). Caps are checked in M27 *before* any spend (REQ-037, REQ-072).

### 6.5 Escalation and override (design F7)
M27 returns `escalate` (medium confidence, not the nearest stage) → M12 persists the Escalation in RunState → M14 renders the block (options: router's pick first, alternatives, "accept as known issue", each with its exact command) → the process exits. Later: `route --to design` → M29 → user-authored plan → M27 gate (caps and budget only) → M28 → M12 resumes. The outcome is logged as `overridden` / later `resolved` (REQ-040, REQ-041).

### 6.6 Resume and hand edit (design F4, F5)
`resume` → M04 lock (recover a dead lock) → M04 reconcile state from M03 trailers → M05 top-up → M17 edit flow (M09 EditRecords → StaleSet with causes → confirm or apply policy) → M12 next-unit rule. Completed, non-stale units are never re-dispatched, because rule 2 selects only stale or missing units (REQ-006, REQ-027).

### 6.7 Budget stop (design F4)
M06 requests an Allowance from M05 per call and passes it on as the per-call cap. When the remaining budget hits zero, M05 emits `budget_exhausted`, and the in-flight call is bounded by its cap. M12 finishes or abandons the current unit at the safe point: a unit whose output was not committed is re-run on resume, never half-applied (design assumption 5) → `budget_stopped` → M14 report lists the remaining units (REQ-073). The warning at the threshold comes from M05's projection and is displayed by M13 (REQ-075).

### 6.8 Critic on demand and promotion (design F3)
`critic --app --flow sign-up` → M30 snapshot at HEAD, personas from the understanding/discovery docs → M31: M18 start app (consent reused if already given this run; otherwise it asks) → I-DRIVER exploration → coverage gate → findings (suppressing dismissed ones via M32) → `docs/critic/<ts>.md` + M32 records. `finding promote F-3` → M32 → Signal(source `critic`) in the M04 queue. If a run is active, M12 drains it at its next safe point. Otherwise it is routed on the next `resume`/`start` (REQ-042–REQ-048).

### 6.9 Fast mode (design F6)
`start` → M34 classifier call (via M06) suggests fast mode → the user chooses → M12 uses the `fast` ModeProfile from M07. The merged "brief" stage (M34 definition, executed by M10) must satisfy the combined contract profile: REQ blocks with acceptance intent plus the SupportedTypeVerdict. Every other interface is unchanged. In particular, M27's nearest-first ordering works over the profile's stage list, so fast-mode go-backs target `brief`, `impl-plan` or `implement` (REQ-008).

---

## 7. How interfaces evolve across build phases

Implementer phases add modules incrementally. Each interface is defined in full when its provider is built, and consumers built earlier use the stated fallback.

| Interface / seam | Provider phase | Fallback before then |
|---|---|---|
| Signal queue (I-STATE) | Phase 0 (M04) | none needed. Producers from Phase 2 onward append; until M25 exists, M14 lists unconsumed signals as "unrouted findings" (implementer assumption 3) |
| Shell executor hook (I-AGENT → I-SANDBOX) | Phase 2 (M18) | M06 denies shell tool use; Phase 1 stages are document-only |
| Report section providers (I-REPORT) | M21, M28, M32 register their sections | render `n/a` |
| Rework units in I-RUN | Phase 4 (M28 extends M12) | Verification failures and E2E failures stop the run as `escalated` with reason "routing unavailable" |
| Issue attempt counts (M25) | Phase 4 | M19 counts per INC id against the M01 cap |
| Dismissal suppression (I-FINDINGS) | M32 | M30 doesn't suppress anything (M30 and M32 ship in the same phase) |
| Fast profile content | Phase 6 (M34) | only the `full` profile is registered |

---

## 8. Cross-cutting concerns

### 8.1 Traceability (P3)
IDs originate in authored documents (M11 stages, M19 commit trailers, M21 scenarios, finding producers). Only M02 parses them and only M08 relates them. No other module maintains its own ID mapping. Every published artefact that refers to requirements (commit trailers, Signals, Issues, RoutingDecisions, Verdicts, Findings) carries REQ ids as plain tokens that M02/M08 can resolve (REQ-020–REQ-024).

### 8.2 Permissions (P9, REQ-056)
Permission is a property of the **stage manifest** (M07), enforced by **M06**. Read-only roles: M16 LLM layer, M20, M21 deriver and judge, M26 attributor, M30/M31. Docs-write: M11 stages and M34 brief. Code-write: M19 only. Web content seen by M23/M31 agents is untrusted input, and those roles have no write tools.

### 8.3 Error taxonomy and handling
| Class | Examples | Handling |
|---|---|---|
| Recoverable in-unit | contract violation, guard violation, verification failure | one re-prompt / bounded retry inside the L3 module |
| Routable | review/E2E/consistency/critic issue, exhausted verification | Signal → router |
| Policy stop | caps, low confidence, insufficient budget for rework, hand-edit policy, consent refused | Escalation (M12), process exits with a report |
| Budget | exhausted | `budget_stopped` at the safe point |
| Infrastructure | API error, container runtime missing, git conflict | retry with backoff inside M06/M18/M03, then `escalated` with a diagnostic; a missing container runtime without opt-in → escalation offering `local-restricted` |
| Crash | process death | lock recovery + reconciliation on resume |

No path loops without counting against a cap: in-unit retries count toward the Issue attempts (REQ-037).

### 8.4 Determinism and re-derivability
Everything in `.pipeline/` except `state.json`, the append-only logs and evidence can be rebuilt from `docs/` + git. The next unit is a pure function of (RunState, StaleSet, profile, pending decisions, signal queue). This is what makes resume cheap (REQ-006) and hand edits authoritative (REQ-026).

### 8.5 Cost attribution
Every WorkUnit carries ledger tags. M06 forwards them on every call. Critic calls are tagged with a critic session id, plus the run id if a run was active. M14 itemises cost by stage, by go-back and for the critic (REQ-074).

### 8.6 Observability
Events (M04) drive the progress lines and status. Transcripts (M06) drive verbose mode. `routing.jsonl` drives accuracy review (REQ-041). The report is rewritten at every stop.

---

## 9. Extension points

| Extension | Mechanism | Owner of the contract |
|---|---|---|
| New stage / new mode | StageManifest + role template + contract profile, registered in M07 | M07, M02 |
| New product type | I-DRIVER plug-in + a SupportedTypeVerdict value | M21 |
| New signal source | Signal record with a new source kind; M25 normaliser rule | M04, M25 |
| New attribution rule | rule entry in M26's rule set | M26 |
| New host (plugin) | alternative M06 adapter + M36 shell over the M13 verbs | M06, M36 |
| Baseline | M35 reuses I-SANDBOX, I-E2E (shared scenario set) and I-LEDGER; separate worktree and run tags | M35 |

---

## 10. Non-functional notes that shape the design

### 10.1 Scale
≤ ~200 REQs, ≤ ~50 INCs and hundreds of scenarios fit comfortably in full rebuilds of M08, so incremental rebuild is an optimisation only. M09 hashing is linear in document size.

### 10.2 Latency
Wall-clock time is dominated by model calls and E2E. v1 dispatches units sequentially. The only concurrency allowed in v1 is (a) the critic process running beside a run and (b) M21 running independent scenarios in parallel inside one unit, if low-level design chooses to.

### 10.3 Concurrent appends
`ledger.jsonl`, `signals.jsonl` and `findings.jsonl` may be appended to by the run process and the critic process at the same time. Each record must be written with a single atomic append (or under a short per-file advisory lock). Readers must tolerate a truncated last line.

### 10.4 Portability
All paths go through M01-configured roots. Container runtime detection happens in M18.

---

## 11. REQ → interface trace (Must requirements)

| REQ | Carried by interface(s) | Modules |
|---|---|---|
| REQ-001, REQ-002 | I-CLI, I-RUN, I-STAGE | M13, M12, M10, M11 |
| REQ-004, REQ-011, REQ-012 | I-DOC, I-STAGE | M02, M10 |
| REQ-005 | I-STATE, I-REPORT, I-CLI | M04, M14, M13 |
| REQ-006 | I-STATE, I-STALE, I-RUN | M04, M09, M12 |
| REQ-009 | I-STATE (lock) | M04, M12 |
| REQ-010, REQ-013 | I-REGISTRY, I-STALE, I-RUN | M07, M09, M12 |
| REQ-014 | I-STAGEDEF (SupportedTypeVerdict), I-CLI, I-E2E | M11, M13, M21 |
| REQ-015 | I-CONSIST, I-TRACE | M16, M08 |
| REQ-016, REQ-017 | I-INCREMENT, I-SANDBOX, I-VCS | M19, M18, M03 |
| REQ-018 | I-REVIEW, I-AGENT (read-only) | M20, M06 |
| REQ-020–REQ-024 | I-DOC, I-TRACE, I-CONSIST, I-REPORT | M02, M08, M16, M14 |
| REQ-026 | I-STALE, I-VCS, I-HUMAN | M09, M03, M17 |
| REQ-030–REQ-032 | I-ROUTER (M26, M28) | M26, M28 |
| REQ-033 | I-STALE preview, I-LEDGER history, I-ROUTER (M27) | M09, M05, M27 |
| REQ-034 | Signal queue (I-STATE), I-ROUTER (M25) | M04, M16, M19, M20, M21, M32, M25 |
| REQ-035–REQ-037 | I-ROUTER (M27), I-CFG | M27, M01, M29 |
| REQ-038 | I-STAGE revise + guard, I-STALE, I-VCS | M10, M09, M03, M28 |
| REQ-039 | I-E2E regression, I-ROUTER (M28) | M21, M28 |
| REQ-042–REQ-048 | I-CRITIC, I-FINDINGS, I-DRIVER, I-SANDBOX | M30, M31, M32, M22, M23, M18 |
| REQ-050–REQ-053 | I-E2E, I-DRIVER, I-SANDBOX | M21, M22, M23, M18 |
| REQ-056 | I-SANDBOX (consent, isolation), I-AGENT (permissions, shell hook) | M18, M06 |
| REQ-060 | I-REPORT | M14 |
| REQ-070, REQ-072–REQ-074 | I-LEDGER, I-AGENT | M05, M06, M27, M13, M14 |

Should and Could requirements follow the same mapping as the coverage matrix in `docs/implementer.md`. Their carrying interfaces are named in §4 (e.g. REQ-003 → I-HUMAN, REQ-025 → I-DECISIONS, REQ-040/REQ-041 → I-ROUTER M29/M28, REQ-049 → M33 hook, REQ-080 → M35, REQ-081 → I-AGENT swap + M36).

---

## 12. Design decisions made at this level

| # | Decision | Why | Modules |
|---|---|---|---|
| HD-1 | **M04 owns the Signal queue** (`.pipeline/signals.jsonl`), not M25 | Producers (M16, M19, M20, M21) are built before M25 and all already depend on M04, so this avoids an upward dependency | M04, M16, M19, M20, M21, M25, M32 |
| HD-2 | **All L3 executors share the WorkUnit → UnitOutcome shape** | One dispatch path in M12. Resume and ledger tagging stay uniform | M10, M16, M19, M20, M21, M33 |
| HD-3 | **Rework is expressed as ordinary WorkUnits with `mode = revise` and a decision id**, not a separate engine | Reuses M10/M19/M21 unchanged. The Preservation Guard stays in one place | M12, M28, M10, M19, M21 |
| HD-4 | **M06 denies shell by default and M18 registers as the executor** | M06 comes before M18 in the build order, and REQ-056 must hold in every phase | M06, M18 |
| HD-5 | **M14 uses section providers** registered by later modules | Satisfies the implementer's "n/a until filled" without M14 depending upward | M14, M21, M28, M32, M16, M20 |
| HD-6 | **Critic promotion is asynchronous via the queue**; the run process drains it at safe points | Keeps AD-15 (the critic never takes the run lock) intact | M30, M32, M04, M12, M25 |
| HD-7 | **M09 offers a non-mutating "preview" staleness computation** | M27 must show impact (REQ-033) before the gate decides | M09, M27 |
| HD-8 | **Nearest-first is computed over the active ModeProfile's stage order** | Fast mode has a different stage chain | M27, M07, M34 |
| HD-9 | **Before Phase 4, failures that would be routed stop the run as `escalated` (reason "routing unavailable")** | Stays honest under P8 and avoids silent pass-through | M12, M19, M21 |

---

## Assumptions
1. Module boundaries and dependencies are as listed in `docs/implementer.md`. Where this HLD adds a seam (HD-1, HD-4, HD-5), it doesn't add a new build-time dependency, except that producers of Signals use I-STATE, which they already reach transitively through M06/M12.
2. Verdicts are stored in two places: a human-readable view in `docs/e2e.md` and a machine-readable verdict manifest that M08 reads. Low-level design picks the manifest location under `.pipeline/`, consistent with architecture §3.7 ("test manifests and verdict files").
3. The consent given for the sandbox is per run and is reused by the critic's app mode within the same run. A standalone critic session (no active run) asks for its own consent.
4. "Safe point" means that the last completed unit is committed and the state is recorded. A unit that was in progress when a stop occurred is re-executed from the start on resume.
5. Router calibration (M26) reads only the local project's `routing.jsonl` in v1. A user-level aggregate stays an open architecture question.
6. Parallelism within E2E is optional and does not change any interface.

## Open questions
1. **Verb collision:** M17's checkpoint `reject` and M29's `reject` (accept as known issue) share a name. Proposal: `checkpoint approve|reject` and `route reject <decision>`. Low-level design to confirm.
2. **Critic report commits:** should `docs/critic/*.md` written while no run is active be committed by a lightweight M03 call that bypasses the run lock (safe, because the path is disjoint), or left for the user? This HLD assumes they are left uncommitted until the next pipeline commit.
3. **Issue key stability:** what normalisation makes two failures "the same issue" across rework (same REQ + same scenario? same finding fingerprint?). This drives recurrence detection (REQ-035) and the attempt caps (REQ-037). Owned by M25 low-level design.
4. **Regression smoke subset size and selection** (M21) directly trades REQ-039 confidence against cost. Needs a policy key in M01.
5. **Review finding threshold:** which severities from M20 become Signals versus report-only entries? Proposal: a policy key, defaulting to "major and above".
6. **Downstream redo after a revise-mode stage:** when revising REQ-007 in design changes only that block, do downstream stages run in revise mode scoped to the propagated stale blocks (the assumed default), or can some be skipped when M09 finds no downstream block referencing the changed ID?
7. **Preservation Guard for sections without IDs** (architecture open question 4) remains open. The guard currently falls back to whole-section hashing, which may force escalations on prose-only edits.
8. **Plugin shape (M36)** is still blocked on architecture open question 6. Nothing in this HLD assumes one option over the other, beyond keeping M06 and the M13 verb layer as the swap points.
