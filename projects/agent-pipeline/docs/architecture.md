<!-- Written by: architecture-planning stage. Read by: implementation-planning. -->

# Architecture: Idea-to-Tested-Software Pipeline

**Summary**
- A **standalone local TypeScript/Node CLI** that uses the **Claude Agent SDK** only to invoke agents. A deterministic orchestrator that we own handles all control flow: stage order, routing, gating, limits and budget.
- **Git plus files are the only durable state.** Markdown stage documents are the contract. A small `.pipeline/` directory holds run state, append-only logs and evidence. A **Trace Index** is built by parsing the documents and is never authored by hand. It drives staleness, coverage, consistency checks and router impact.
- The **Feedback Router** combines deterministic trace-based rules with LLM attribution into an evidence-backed, bucketed confidence. The **Critic** is a separate read-only service. **E2E and all generated-code execution run in a container sandbox.**
- Cost control is built into the architecture: a Budget Ledger checks every agent call and every rework, and rework is limited to the requirement-ID blocks that are stale.

Requirement IDs refer to `docs/design.md` §7. Architecture decisions (AD-n) are in §5, in ADR form (REQ-022).

---

## 1. Architectural drivers

| Driver | Consequence for the architecture | REQs |
|---|---|---|
| The router and critic are the product (P1). Attribution is only about 50–70% accurate (okf §3) | Routing needs structured evidence (a trace index), explicit confidence, gating, caps, and an outcome log for calibration | REQ-030–REQ-041 |
| Requirements are the backbone (P3) | Machine-checkable IDs in human-readable markdown, plus a derived index linking REQ → task → increment → test → verdict | REQ-020–REQ-024, REQ-015 |
| Don't rework what works (P5) | Staleness tracked per ID block, rework runs in "revise mode" with a deterministic preservation guard | REQ-038, REQ-027, REQ-033 |
| Cost is the price (P6) | Every agent call goes through a ledger that checks the budget before it runs. Safe-point stops. Estimates come from history | REQ-070–REQ-076, REQ-072 |
| Documents are the interface (P7), hand edits are first-class | Files in git are the source of truth. SDK sessions are disposable caches, never state | REQ-004, REQ-026, REQ-063 |
| Run unattended, stop honestly (P8) | Explicit run state machine with durable safe points, escalations as first-class states, and resume | REQ-002, REQ-006, REQ-036, REQ-037, REQ-073 |
| Advice is separate from action (P9) | Reviewer, critic and consistency checker have read-only permissions. Only the Run Controller (via the router or the user) starts rework | REQ-015, REQ-018, REQ-047 |
| Running generated code is a security risk (okf §11.8) | A sandbox boundary around all execution of generated code, with consent before the first execution | REQ-056 |
| Preview platform churn and vendor coupling (okf §5, §11.5) | Stable SDK primitives (`query()`, hooks, permissions) sit behind one adapter. No dependency on Dynamic Workflows or Agent Teams | REQ-081 |

---

## 2. System context

```
                ┌──────────────────────────── developer machine ─────────────────────────────┐
  Sam ──CLI──▶  │  pipeline CLI (Node)                                                        │
                │   ├─ Orchestrator core (deterministic TS)                                   │
                │   ├─ Agent Host Adapter ──HTTPS──▶ Anthropic API (via Claude Agent SDK)     │
                │   ├─ Git (local repo: docs/, src/, .pipeline/)                              │
                │   └─ Sandbox Manager ──▶ Docker/Podman container                             │
                │                            ├─ build / unit tests / app process              │
                │                            └─ Playwright (browser) for web E2E + critic     │
                └─────────────────────────────────────────────────────────────────────────────┘
```

External dependencies: the Anthropic API (the user's own key or plan), local git, a local container runtime (recommended; see AD-9), and Node ≥ 20. No hosted backend and no telemetry leaving the machine (design §8 out of scope: hosted operation).

---

## 3. Components

Each component lists its responsibility and the requirements it serves. The boundaries are logical. How they are packaged into modules is left to implementation-planning.

### 3.1 CLI / Command Surface
Parses the verbs `start`, `status`, `resume`, `restart --from <stage>`, `approve|reject` (checkpoint), `critic`, `finding promote|dismiss`, `route --to <stage>` (manual go-back or redirect), `budget`, and `baseline` (Could). It renders compact progress lines and escalation blocks, and has a verbose mode that tails per-stage logs. It holds no business logic: every verb becomes a command to the Run Controller or the Critic Service.
**Serves:** REQ-001, REQ-003, REQ-005, REQ-006, REQ-007, REQ-040, REQ-042, REQ-047, REQ-062, REQ-070, REQ-080.

### 3.2 Run Controller (orchestrator state machine)
This is the single authority over run progress. It is an explicit state machine: `idle → running(stage|increment) → {checkpoint | escalated | budget_stopped | crashed} → running … → done`. It persists state at every **safe point**, meaning after a stage document or increment is committed (design assumption 5). It picks the next unit of work from three things: the **Stage Registry**, the **Staleness Tracker** (what is stale or missing), and the **Router's** pending decisions. It acquires the **project run lock** (REQ-009). It keeps no conversational state, so resuming means re-deriving the next work from files, git and `state.json`.
**Serves:** REQ-002, REQ-006, REQ-007, REQ-009, REQ-010, REQ-013, REQ-036, REQ-037, REQ-073.

### 3.3 Stage Registry (declarative stage manifests)
This is data, not code paths. For each stage it declares: id, output document, required inputs (documents or sections), the prompt/role template, the model tier, the permission profile (read-only / docs-write / code-write), the budget share, whether it is a checkpoint candidate, and which **mode profiles** (`full`, `fast`) include it. Fast mode is just a different profile that merges understanding, classification and design into one "brief" stage. The profile must still emit REQ IDs, acceptance intent and the supported-type verdict, and then skip discovery and architecture.
**Serves:** REQ-008, REQ-010, REQ-013, REQ-014, REQ-071, REQ-003.

### 3.4 Stage Runner
Runs one stage (or one revise-mode rework of a stage):
1. Checks preconditions with the Staleness Tracker (REQ-013).
2. Assembles context: upstream documents, answered open questions, and in revise mode the routing decision, the stale ID list and the current document.
3. Invokes the agent via the Agent Host Adapter.
4. Validates the output against a **document contract**: header comment, summary of 5 lines or fewer, Assumptions and Open questions sections, and well-formed ID anchors.
5. In revise mode, runs the **Preservation Guard**: ID blocks not marked stale must hash the same as before. If they don't, it re-prompts once and then escalates.
6. Hands off to the VCS Gateway for a commit.

**Serves:** REQ-004, REQ-011, REQ-012, REQ-013, REQ-026, REQ-038.

### 3.5 Agent Host Adapter
This is the only module that imports the Claude Agent SDK. It wraps `query()` with: model selection per role tier, a tool allow-list and permission profile enforced through SDK permission callbacks and PreToolUse hooks (for example, the reviewer and critic cannot write; implementers can write only inside the project worktree, and shell execution is routed to the sandbox), a per-call `max_budget_usd` derived from the ledger, streaming of usage to the Budget Ledger, and per-stage transcript logs. Every stage invocation is a **fresh session**. Sessions are never resumed across safe points, because files carry the state. A retry within one unit may resume its session.
**Serves:** REQ-056 (permissions), REQ-062, REQ-070, REQ-072, REQ-074, REQ-081 (single swap point for a plugin host).

### 3.6 Artifact Store and Document Model
`docs/*.md` hold the authored content. The structure is readable to humans and also parseable:
- The existing HTML header comment (writer/readers) is kept, plus a small **YAML front-matter** block: `stage`, `run_id`, `generated_from` (upstream doc → content hash, per-ID-block hashes consumed), and `schema_version`.
- **ID blocks**: each requirement, architecture decision (AD-n), task (T-n), increment (INC-n), scenario (E2E-n) and finding (F-n) is a heading or table row that starts with its ID. Cross-references are plain `REQ-nnn` tokens in prose. The parser extracts blocks and references with regexes over markdown AST headings and table rows.
- Handoffs stay prose-first. There is no JSON handoff between agents (okf §4, Two Calls).

**Serves:** REQ-004, REQ-011, REQ-012, REQ-020, REQ-021, REQ-022, REQ-023, REQ-026.

### 3.7 Trace Index (derived)
It is rebuilt from `docs/`, the test manifests and verdict files whenever a document changes. It is cached in `.pipeline/trace.json` but can always be regenerated. It models a graph with these edges: REQ → AD, REQ → task, task → increment/commit, REQ → E2E scenario, scenario → verdict/evidence, and finding → REQ. It supports coverage queries ("Must REQs with no task"), orphan queries ("task with no REQ") and impact queries ("everything downstream of REQ-007").
**Serves:** REQ-015, REQ-023, REQ-024, REQ-033, REQ-052, REQ-060.

### 3.8 Staleness / Dependency Tracker
Uses the Make/Bazel model (okf §6.3). Each artefact records the content hashes of the upstream **ID blocks** (and whole-document hashes for sections without IDs) it was generated from. An artefact is **stale** when any recorded upstream hash differs from the current one. Staleness then propagates transitively through the stage dependency graph and the Trace Index edges. Hand edits are detected the same way: a document's own hash differs from the hash recorded at its last commit by the pipeline, *and* git shows a non-pipeline change. Such edits are marked `user-edit` and become authoritative. Answers written into Open questions sections count as edits. Granularity is **requirement/ID-block where IDs exist, section otherwise, whole document as a fallback**. That gives the user an explanation at REQ level (design §11 Q1).
**Serves:** REQ-006, REQ-007, REQ-013, REQ-026, REQ-027, REQ-028, REQ-033, REQ-038.

### 3.9 Consistency Checker (read-only)
Runs after design, architecture and implementation planning, in two layers:
- **Deterministic:** checks from the Trace Index (uncovered Must REQs, orphan tasks, references to unknown IDs, reused or renumbered IDs compared with git history, which enforces REQ-020).
- **LLM:** a read-only contradiction scan between document pairs, Spec Kit `analyze` style.

The output is a list of findings sent to the Router's signal intake. It never edits anything.
**Serves:** REQ-015, REQ-020, REQ-023, REQ-034.

### 3.10 Increment Executor
For each INC in the implementation plan: the implementer agent writes code in the worktree, then the Verification Gate runs build and the increment's own tests **inside the sandbox**. On pass, it commits (one commit per increment, trailer `Refs: REQ-…, T-…, INC-…`). On failure, it makes a bounded local retry (counted in the attempts-per-issue limit) and then emits a signal to the router.
**Serves:** REQ-016, REQ-017, REQ-023, REQ-037, REQ-056.

### 3.11 Reviewer (read-only)
An agent with read-only permissions over code and documents. It emits findings (location, severity, affected REQ/AD) into `docs/review.md` and the router intake.
**Serves:** REQ-018, REQ-034.

### 3.12 E2E Harness
- **Scenario Deriver:** an agent that sees *only* the requirements, the acceptance intent and the supported-type verdict, plus the product's public entry points (URL/command/API surface). It does not see the implementation source. It writes `E2E-n` scenarios, each citing a REQ, which separates the tests from the code (REQ-051).
- **Drivers** (plug-ins by product type): **Web**: Playwright via Playwright MCP, using accessibility snapshots plus screenshots on failure. **CLI**: command runner with stdout/stderr/exit-code/golden-file assertions. **Library/API** (Should): a consumer-script driver and HTTP smoke/contract checks. Unsupported types produce no driver, and verdicts are `not verifiable: unsupported type`.
- **Flake Filter:** each failing scenario is re-run N times (default 2) in a fresh app instance. Mixed outcomes are marked `flaky` and are not routed.
- **Requirement Judge:** a per-REQ LLM check (E2EDevBench hybrid) that combines scenario results with the requirement text and a read-only look at the code to catch omissions. It produces `pass / fail / not verifiable (reason)`.
- **Evidence Store:** `.pipeline/evidence/<run>/<E2E-n>/` holds step logs, outputs, snapshots and traces, linked from verdicts.
- **Regression mode:** after rework, it re-runs the previously failing scenarios and the scenarios that passed before for affected REQs, plus a cheap smoke subset for everything else.

**Serves:** REQ-014, REQ-039, REQ-050, REQ-051, REQ-052, REQ-053, REQ-054, REQ-055, REQ-056.

### 3.13 Sandbox Manager
Provides an isolated execution environment for all generated-code execution: builds, unit tests, app processes, E2E drivers and critic app sessions. The default is a **Docker/Podman container** with the project worktree mounted (read-write only for build outputs), no host home directory, network egress limited to package registries during install and localhost-only at run time, and CPU/memory/time limits. Before the first execution in a run, it shows a **consent block** (image, mounted paths, commands, network policy), recorded in the state. If no container runtime is available, a **degraded "local-restricted" mode** (temp worktree, scrubbed env, no secrets, timeouts) needs explicit opt-in and is labelled in the report.
**Serves:** REQ-056, REQ-016, REQ-050, REQ-044.

### 3.14 Feedback Router
This is the core differentiator. Its pipeline:
1. **Signal Intake:** normalises inputs (review findings, E2E fails after the flake filter, consistency findings, promoted critic findings, user reports, Verification Gate failures) into `Issue` records with a stable issue key, so recurrences are recognised (REQ-034, REQ-053).
2. **Evidence Assembly:** queries the Trace Index for the chain REQ → AD → task → INC → scenario → verdict around the issue and collects linked artefacts.
3. **Attribution**, in two layers:
   - (a) **Deterministic rules** encoding okf §3.4 (for example, Must REQ with no task → plan; task present, test fails, code diff doesn't touch task scope → implementation; REQ acceptance contradicts another REQ → design).
   - (b) An **LLM attributor** (strong model tier, all-at-once over the *documents and evidence*, not raw transcripts) that returns ranked candidate stages with rationale.

   Confidence is **bucketed by agreement**. It is high when the rules fire unambiguously and the LLM's top pick agrees, medium when only one of them is decisive or they disagree between adjacent stages, and low otherwise. The rules get calibration adjustments from the Routing Log over time (REQ-031, REQ-041).
4. **Nearest-first planning:** among plausible candidates it picks the nearest to the symptom. On recurrence of the same issue key it escalates one step further back, using the new evidence (REQ-035).
5. **Impact analysis:** the Staleness Tracker computes the stale set (documents, sections, REQ IDs, increments) for the target. The **cost estimate** is the historical per-stage cost from the ledger × the stale fraction + the E2E regression cost (REQ-033, REQ-072).
6. **Gate:** applies REQ-036 policy, the go-back and attempts caps (REQ-037) and the budget check (REQ-072). The result is `auto-proceed`, `ask-user` (attended), or `escalate` (unattended or limit reached).
7. **Emit:** writes a **Routing Decision** (symptom, origin, REQs, evidence links, confidence plus reason, alternatives, impact, cost vs remaining) to `docs/routing.md` and `.pipeline/routing.jsonl`. It then hands the decision to the Run Controller. The Controller marks the stale set and schedules revise-mode runs (REQ-030, REQ-032, REQ-038).
8. **Outcome tracking:** after re-verification, each decision is marked `resolved / recurred / rejected / overridden`. User overrides (redirect, reject as known issue, manual go-back) enter at step 6 as user-authored decisions (REQ-040, REQ-041).

The router can target any earlier stage (REQ-032). It never edits artefacts itself (P9).
**Serves:** REQ-030–REQ-041, REQ-072.

### 3.15 Critic Service
It is a separate entry point from the Run Controller, so it can be invoked at any time, including while a run is active (REQ-042). It takes a **shared read lock** on `docs/` (a consistent snapshot at the current git HEAD) and never takes the run lock.
- **Document mode:** a cognitive walkthrough agent over one or more documents.
- **App mode:** starts the built product in the Sandbox. The web driver uses the same Playwright stack as E2E, and the CLI driver runs commands. **Coverage gating** means the critic must record interactions covering the requested flow before the report is accepted. Findings without a cited action or observation are rejected (UXBench-style; REQ-044).
- **Personas** are extracted from the discovery and understanding documents (primary by default) and can be overridden (REQ-045).
- **Findings** follow a fixed schema (location, problem, heuristic/guideline, severity, evidence, suggestion, REQ IDs) and are written to `docs/critic/<timestamp>.md` plus `.pipeline/findings.jsonl` with state `open/promoted/dismissed`. Dismissals are keyed by (target content hash, finding fingerprint), so they are suppressed while the target is unchanged (REQ-046, REQ-047).
- Every critic report has a fixed banner, "Simulated reviewer, not real-user evidence", and a per-target reliability note (for example dashboards and chat UIs) (REQ-048).
- **Promotion** sends the finding to Router Signal Intake. Optional **auto-invocation** is a Stage Registry hook at one configured point (default off) that is budget-gated (REQ-049).
- **Cost:** charged to the active run's ledger if a run exists, otherwise to a standalone critic cap.

**Serves:** REQ-042–REQ-049.

### 3.16 Budget and Cost Ledger
An append-only `.pipeline/ledger.jsonl` records each agent call's cost, attributed to (run, stage, increment, go-back id, critic). It enforces the run budget, optional per-stage shares, and the **pre-call check**: the call's cap is `min(stage share remaining, run remaining)`, passed as `max_budget_usd`. It raises the **warning threshold** event (default 80%) with a projection. The projection is spent-so-far plus the median historical cost of the remaining units, and uses conservative priors when there's no history. When the budget is exhausted, it signals the Run Controller to stop at the next safe point. The in-flight call is capped, so overshoot is bounded by one call. It also provides the pre-run estimate (Could) from the mode profile × priors × idea size.
**Serves:** REQ-070–REQ-076, REQ-033, REQ-060.

### 3.17 VCS Gateway (git)
All commits go through one gateway. It makes one commit per stage completion, per increment and per rework unit, with structured trailers (`Pipeline-Run`, `Stage`, `Refs: REQ-…`, `Routing-Decision`). Runs work on a dedicated branch `pipeline/<run-id>`, so the user's branch is untouched until they merge (AD-8). It detects non-pipeline commits and working-tree edits for the Staleness Tracker. Revert-by-stage/increment works because units map 1:1 to commits.
**Serves:** REQ-017, REQ-026, REQ-027, REQ-038, REQ-063.

### 3.18 Logs: Decision, Routing, Event
- **Event log** (`.pipeline/events.jsonl`): every state transition. It is the basis for status, resume and verbose output (REQ-005, REQ-006, REQ-062).
- **Decision log** (`docs/decisions.md`, rendered from events): stage, router and user decisions, with supersession links. ADRs in architecture docs use `Status: superseded by AD-n` (REQ-022, REQ-025).
- **Routing log** (`.pipeline/routing.jsonl`): decisions and outcomes, kept across runs for accuracy review (REQ-041).

### 3.19 Reporter
Renders `docs/run_report.md` at every stop, not just at `done`, so a budget stop or escalation still leaves a report. Contents: a one-line outcome, the coverage matrix from the Trace Index with gaps highlighted, go-backs and outcomes, open critic findings, the **open-questions roll-up** (parsed from every document's Open questions section, with answered/unanswered state from the Staleness Tracker's edit detection), itemised cost, how to run the product (from the implementation document), and next actions. It also renders the `status` view and escalation blocks.
**Serves:** REQ-005, REQ-024, REQ-060, REQ-061, REQ-074.

### 3.20 Baseline Runner (Could)
Runs a single-agent build of the same idea in a separate worktree and sandbox. It reuses the same E2E Harness and the same scenario set (derived from the pipeline's requirements) to give a side-by-side verdict and cost comparison.
**Serves:** REQ-080.

### 3.21 Config and Policy
`pipeline.config.(json|yaml)` at the project root holds: the default budget, stage shares, model tier map, checkpoint list, router thresholds and caps (default: 3 go-backs per run, 2 attempts per issue), the hand-edit policy in unattended mode (default: **stop and ask**, see AD-12), the sandbox mode, the critic auto-invoke point, and the flake re-run count. CLI flags override config.
**Serves:** REQ-003, REQ-027, REQ-037, REQ-049, REQ-070, REQ-071.

---

## 4. Data flows

### 4.1 Main forward flow (full mode)
```
idea ─▶ CLI ─▶ Run Controller ──(lock, state.json)──┐
                    │                               │
      for each stage in Registry profile:           │
        Staleness Tracker: inputs present & fresh? ─┤ no → stop w/ message (REQ-013)
        Stage Runner ─▶ Agent Host Adapter ─▶ SDK ─▶ API
             │   ▲ ledger pre-check / usage (REQ-072/074)
             ▼
        docs/<stage>.md ─▶ contract check ─▶ VCS commit ─▶ Trace Index rebuild
             │
        [after design/arch/impl-plan] Consistency Checker ─▶ Router intake
        [checkpoint?] ─▶ state=checkpoint, stop (REQ-003)
      Increment Executor loop: code → Sandbox verify → commit (REQ-016/017)
      Reviewer ─▶ findings ─▶ Router intake
      E2E: derive scenarios (from REQs) → drivers in Sandbox → flake filter → judge → verdicts+evidence
      Router: route? → rework loop (4.2) | done
      Reporter ─▶ docs/run_report.md
```

### 4.2 Rework flow
```
signal ─▶ Router intake (issue key) ─▶ evidence (Trace Index) ─▶ rules + LLM attribution
       ─▶ nearest-first target ─▶ impact (Staleness Tracker) ─▶ cost (Ledger)
       ─▶ Gate {auto | ask | escalate}
auto ─▶ Run Controller marks stale set ─▶ Stage Runner (revise mode, stale IDs only)
     ─▶ Preservation Guard ─▶ commit (diff visible) ─▶ downstream stale items redone in order
     ─▶ E2E regression mode ─▶ Router outcome = resolved | recurred(→ escalate one step back)
```

### 4.3 Critic flow
```
CLI critic ─▶ Critic Service (read lock @HEAD) ─▶ personas from docs
   doc mode: walkthrough agent ─▶ findings
   app mode: Sandbox start app ─▶ driver interactions (coverage-gated) ─▶ findings
findings ─▶ docs/critic/*.md + findings.jsonl ─▶ user promote ─▶ Router intake
```

### 4.4 Resume / hand-edit flow
```
resume ─▶ acquire lock ─▶ load state.json + events ─▶ VCS: detect non-pipeline changes
       ─▶ Staleness Tracker recompute ─▶ show stale list (REQ-027) ─▶ policy/confirm
       ─▶ continue from first stale or unfinished unit (REQ-006)
```

---

## 5. Architecture decisions (ADR-style; REQ-022)

| AD | Decision | Context / alternatives | Consequences | REQs |
|---|---|---|---|---|
| AD-1 | **Standalone Node/TypeScript CLI on the Claude Agent SDK. The orchestrator control flow is our own deterministic code.** | Alternatives: Dynamic Workflows (preview, plan-gated, churn risk), a Claude Code plugin (the platform owns the UX). The TS SDK has fuller hook support than Python (okf §5). | Full control over gating, limits and state. More code to own. Plugin packaging becomes a thin adapter later. | REQ-001, REQ-002, REQ-010, REQ-036, REQ-037, REQ-081 |
| AD-2 | **All SDK usage goes behind the Agent Host Adapter. A fresh session per unit of work.** | Resuming sessions carries full-history cost and opaque state (okf §5, §9). | Resume is cheap and deterministic. Some context gets re-read, which prompt caching of upstream docs offsets. | REQ-006, REQ-070, REQ-074, REQ-081 |
| AD-3 | **Git + markdown files are the source of truth. `.pipeline/` holds only operational state, logs and evidence, and every derived index can be rebuilt.** | Alternative: a SQLite state DB. Rejected for v1: it's opaque to the user and adds a second source of truth that can drift. | Hand edits just work. JSONL logs are append-only and crash-tolerant. Files are small at single-project scale. | REQ-004, REQ-006, REQ-026, REQ-063, REQ-041 |
| AD-4 | **Markdown with ID-block anchors + minimal YAML front-matter. Prose handoffs, no JSON handoffs between agents.** | Evidence against JSON handoffs for reasoning (okf §4); IDs need machine-checkability. | A parser plus a contract validator are required. Agents must follow the ID conventions, which the Stage Runner validates. | REQ-004, REQ-011, REQ-012, REQ-015, REQ-020, REQ-021, REQ-024 |
| AD-5 | **Staleness by content hashes of upstream ID blocks (Make-style), at ID-block granularity with section/doc fallback.** | Alternatives: whole-document invalidation (simple, wasteful), LangGraph-style replay of the tail (re-runs everything). | Explainable "what will be redone" at REQ level. Needs stable block extraction. | REQ-007, REQ-013, REQ-027, REQ-033, REQ-038 |
| AD-6 | **Revise-mode rework + Preservation Guard (hash compare of non-stale blocks).** | Unscoped refinement degrades good output (okf §4). | Unaffected content is protected mechanically, not by prompt alone. Guard violations escalate. | REQ-038, REQ-039 |
| AD-7 | **Router = deterministic trace rules + LLM attributor, confidence bucketed by agreement, calibrated from the routing log.** | LLM-only attribution is about 50–70% accurate (okf §3.1). Counterfactual replay is too costly by default. | Confidence can be explained. Rules are cheap and auditable. Calibration improves across runs. Counterfactual replay is possible as a future opt-in. | REQ-030, REQ-031, REQ-035, REQ-036, REQ-041 |
| AD-8 | **One commit per stage, increment and rework unit, on a `pipeline/<run-id>` branch, with structured trailers.** | Committing on the user's current branch is simpler but intrusive. | Easy inspect and revert. The user merges when satisfied. Branch management adds a step. | REQ-017, REQ-038, REQ-063 |
| AD-9 | **Container sandbox (Docker/Podman) by default for all generated-code execution. Opt-in degraded local mode.** | Devin/OpenHands use containers (okf §7). Docker is common on developer machines but not universal. | Strong isolation. Needs a container runtime, with the fallback clearly labelled. Adds startup latency. | REQ-056, REQ-016, REQ-050, REQ-044 |
| AD-10 | **E2E via Playwright (MCP for agent-driven exploration, generated Playwright specs for repeatable re-runs) for web. A shell harness for CLI. Driver plug-ins per product type.** | Accessibility snapshots are cheaper and more robust than vision (okf §7). Repeatable specs make flake re-runs and regression cheap. | Web and CLI are covered in v1. Library/API are Should-level drivers. Unsupported types yield "not verifiable". | REQ-014, REQ-050, REQ-051, REQ-053, REQ-054, REQ-055 |
| AD-11 | **Scenario derivation isolated from the implementation source. The Requirement Judge may read code only to detect omissions.** | Prevents self-confirming tests (okf §11.3). | Scenarios occasionally miss implementation-specific selectors. The Healer-style repair of selectors is kept separate from behavioural failure. | REQ-051, REQ-052 |
| AD-12 | **Default unattended hand-edit policy: stop and ask** (configurable to "proceed and redo"). | Design §11 Q7. Cost and surprise risk favour asking. | Slightly less autonomy. Explicit and safe. | REQ-027, REQ-002 |
| AD-13 | **Model tiers per role: strong for router attribution, critic, architecture and requirement judge; standard for other stages; fast/cheap for mechanical checks.** Configured per tier, not exposed as per-stage prompts. | Critique quality varies by model (okf §8). Cost levers (okf §9.1). | Better quality where the product differentiates. The tier map lives in config. | REQ-031, REQ-046, REQ-070 |
| AD-14 | **Budget is enforced before each call (`max_budget_usd` = remaining allowance) and at safe points. Estimates come from ledger history with conservative priors.** | `max_budget_usd` is per-session and cumulative (okf §5). | Overshoot is bounded by one call. Estimates improve with use. | REQ-070–REQ-075, REQ-033 |
| AD-15 | **Critic is a separate service with a read-only snapshot lock and never mutates run state except via promotion.** | Must be callable any time (REQ-042) without violating the one-run rule (REQ-009). | Concurrency is safe. Critic cost is attributed separately. | REQ-042, REQ-047, REQ-009 |
| AD-16 | **One active run per project via a lock file with PID + heartbeat. Stale locks (dead PID) are recovered on resume.** | Crash tolerance. | A crash never blocks the user permanently. | REQ-009, REQ-006 |

---

## 6. Storage layout

```
<project>/
  pipeline.config.yaml            # policy & defaults (3.21)
  docs/
    idea.md, product_understanding.md, classification.md, okf.md,
    design.md, architecture.md, implementation_plan.md, review.md,
    e2e.md, routing.md, decisions.md, run_report.md, critic/*.md
  src/ … (generated product)      # plus tests/
  .pipeline/                      # committed except evidence/ and logs/ (gitignored, size)
    state.json                    # run state machine snapshot (atomic write-rename)
    lock                          # PID + heartbeat
    events.jsonl  ledger.jsonl  routing.jsonl  findings.jsonl
    trace.json                    # derived, rebuildable
    hashes/                       # recorded upstream block hashes per artefact
    evidence/<run>/…              # E2E & critic evidence (gitignored; referenced by path)
    logs/<run>/<stage>.log        # transcripts for verbose mode
```

State writes are atomic (temp file + rename). The order at a safe point is: document write → commit → state.json update. On resume, a commit without a matching state update is reconciled from git trailers.

---

## 7. Non-functional requirements

### 7.1 Cost
- Only leaf agent calls spend tokens. Control flow, trace, staleness and consistency rules are deterministic code (AD-1, AD-7).
- Prompt caching of stable upstream documents. Tiered models (AD-13). Scoped rework (AD-5, AD-6). Go-back caps (REQ-037).
- Targets (assumptions to calibrate): fast mode ≤ ~25% of a full run's cost. Rework share visible per run (design §9).
- **Serves:** REQ-070–REQ-076, REQ-008, REQ-037.

### 7.2 Security and privacy
- Generated code executes only in the sandbox (AD-9), with consent before the first execution (REQ-056).
- Agent permission profiles: read-only roles cannot write, and code-writing roles are confined to the worktree. Agents get no shell outside the sandbox (REQ-018, REQ-047, REQ-056).
- The API key is read from the environment/SDK config, never written to docs, logs or evidence. Evidence capture redacts env and known secret patterns.
- No network services exposed. No telemetry. The routing log stays local (REQ-041 across runs = across local runs in the same project, plus an optional user-level aggregate at `~/.pipeline/`; see open question 3).
- Prompt-injection surface: web content seen by E2E/critic agents is treated as untrusted. Those agents have no write tools.

### 7.3 Reliability and resumability
- Every state transition is persisted at safe points. A crash loses at most the in-flight unit (REQ-006, REQ-073).
- Deterministic re-derivation of the next work from files means no hidden in-memory state.
- The lock heartbeat handles crashes (AD-16). The flake filter reduces false routing (REQ-053).

### 7.4 Scale and performance
- Single user, single project, one run at a time (REQ-009). Expected scale: tens of documents, ≤ ~200 requirements, ≤ ~50 increments, hundreds of E2E scenarios at most. File-based indices are sufficient; no database is needed.
- Wall-clock time is dominated by model calls and E2E. v1 runs stages sequentially. Possible parallelism (independent E2E scenarios, critic in parallel with a run) is allowed where it doesn't affect determinism.

### 7.5 Observability
- Compact progress lines, a verbose mode, per-stage transcripts, the event log, the ledger and the routing log (REQ-062, REQ-074, REQ-041). The run report is written at every stop (REQ-060).

### 7.6 Portability
- macOS and Linux first-class. Windows via WSL2 (assumption). Node ≥ 20, git ≥ 2.30, Docker/Podman recommended.

### 7.7 Extensibility
- New stages = new registry manifests (REQ-010, REQ-008). New product types = new E2E driver plug-ins (REQ-014, REQ-055). New host environment = a new Agent Host Adapter plus CLI shell (REQ-081).

---

## 8. Requirement → architecture coverage

| REQ range | Primary components |
|---|---|
| REQ-001–REQ-009 | CLI, Run Controller, Stage Registry, Staleness Tracker, lock (AD-16) |
| REQ-010–REQ-018 | Stage Registry, Stage Runner, Consistency Checker, Increment Executor, Reviewer, VCS Gateway |
| REQ-020–REQ-028 | Document Model, Trace Index, Staleness Tracker, Decision log, Reporter |
| REQ-030–REQ-041 | Feedback Router, Staleness Tracker, Ledger, Routing log, Run Controller |
| REQ-042–REQ-049 | Critic Service, Sandbox, E2E drivers (shared), findings store |
| REQ-050–REQ-056 | E2E Harness, Sandbox Manager |
| REQ-060–REQ-063 | Reporter, Event log, VCS Gateway |
| REQ-070–REQ-076 | Budget Ledger, Agent Host Adapter, Reporter |
| REQ-080–REQ-081 | Baseline Runner, Agent Host Adapter (plugin swap point) |

Every Must requirement in design §7 maps to at least one component above.

---

## 9. Key risks and architectural mitigations

| Risk (okf §11) | Mitigation | REQs |
|---|---|---|
| Wrong-stage routing | Rules + LLM agreement, nearest-first, gating, caps, outcome calibration | REQ-031, REQ-035–REQ-037, REQ-041 |
| Rework degrades good output | Revise mode + Preservation Guard + regression E2E | REQ-038, REQ-039 |
| Self-confirming tests | Scenario derivation from REQs without source access; per-REQ judge | REQ-051, REQ-052 |
| Critic over-trust | Coverage gating, evidence-required findings, simulated banner, reliability notes | REQ-044, REQ-048 |
| Platform churn | Single SDK adapter, only stable primitives | REQ-081 |
| Information loss between stages | Stable ID anchors, contract validation, consistency checker | REQ-015, REQ-020 |
| Cost growth from loops | Ledger pre-checks, scoped rework, caps, estimates | REQ-037, REQ-072 |
| Unsafe local execution | Container sandbox, consent, permission profiles | REQ-056 |
| Agents not following ID conventions | Contract validator re-prompts once, then escalates | REQ-004, REQ-020 |

---

## Assumptions
1. The host is the Claude Agent SDK for TypeScript. Its `query()`, permission callbacks, PreToolUse hooks and `max_budget_usd` behave as described in okf §5 (to be verified at implementation time).
2. Most target users have Docker or Podman. Those who don't accept the labelled degraded mode.
3. Playwright and Playwright MCP run inside the sandbox container image. A pre-built base image is pulled on the first run.
4. Default caps (3 go-backs per run, 2 attempts per issue, 2 flake re-runs, 80% warning) are starting values to calibrate.
5. The `pipeline/<run-id>` branch model is acceptable to users. Merging to their main branch is a manual step.
6. The regex/AST-based ID extraction is reliable enough if the Stage Runner enforces conventions. No heavier schema is needed.
7. Fast mode merges understanding, classification and design into one "brief" stage and skips discovery and architecture. Review is kept but lightweight. The "looks small" suggestion comes from a cheap classifier call at start.
8. The critic auto-invocation point (REQ-049) defaults to off. When enabled, the suggested point is after E2E if at least 15% of the budget remains.

## Open questions
1. Should counterfactual replay (AgenTracer-style) be offered as an opt-in router mode for low-confidence, high-cost decisions, and how would its cost be capped?
2. Should `.pipeline/evidence/` be committed (full audit) or kept gitignored (repo size)? Current choice: gitignored, referenced by path.
3. Should router calibration data (REQ-041) be aggregated across projects in a user-level store (`~/.pipeline/`) to reach useful sample sizes faster, and with what privacy defaults?
4. What exact heuristics decide Preservation Guard violations for sections without IDs (for example, prose in the architecture overview)? Whole-section hash may be too strict.
5. How should the Requirement Judge's code access be limited so it detects omissions without drifting into implementation-confirming judgements?
6. Does the plugin path (REQ-081) need the Run Controller exposed as an MCP server, or is a skill that shells out to the CLI enough?
7. Windows support without WSL2: in scope for v1 or not?
8. Should the baseline runner (REQ-080) share the pipeline's derived E2E scenarios (fair, but biased toward the pipeline's reading of the idea) or derive its own?
