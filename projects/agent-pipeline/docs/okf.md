<!-- Written by: deep-discovery stage (organized knowledge file). Read by: design-planning, architecture-planning. -->

# Organized Knowledge File (OKF)

**Subject:** an automated multi-agent pipeline that turns a product idea into tested software. The stages are understand → research → classify → discover → plan → architect → implement incrementally → review → e2e test. It adds a feedback router that can send work back to any earlier stage, and a critic that reviews output from a human/UX point of view when asked.
**Category (from classification.md):** developer tooling / AI agentic software-development orchestration. It runs locally, is developer-facing, and most likely sits on the Claude Agent SDK.
**Purpose of this file:** collect research so design-planning and architecture-planning can use it without searching again. This file records findings and options only. **It makes no design or architecture decisions.** Each section ends with "Implications to weigh", which lists questions for later stages, not answers.

**How to read confidence tags:** **[P]** means a peer-reviewed or arXiv paper. **[D]** means official vendor docs or a vendor blog. **[S]** means a secondary round-up or blog, so treat it as approximate. Research date: 2026-09-24.

---

## 0. Executive summary (the ten things later stages most need to know)

1. **The stage list is copyable. The router and the critic are what set this apart.** BMAD, Spec Kit and Kiro already provide staged, file-handoff workflows. What they lack is (a) automatic attribution of a failure to the stage that caused it, followed by targeted rework, and (b) a human/UX critic grounded in real interaction with the running app (§2, §3).
2. **Automated failure attribution is an unsolved research problem.** On the Who&When benchmark, the best general method identifies the responsible *agent* 53.5% of the time and the responsible *step* only 14.2% of the time. A specialised trained model (AgenTracer-8B) reaches about 69% for agent and 20% for step [P]. A router that trusts its own attribution blindly will often send work to the wrong stage (§3).
3. **Our router works at a much coarser level than those benchmarks, which helps.** It picks one of about 9 stages, with a written document per stage, rather than one step out of hundreds of chat turns. Agent-level accuracy (roughly 50–70%) is the relevant figure. Structured evidence, such as linking requirement IDs to tests, can raise it (§3.4).
4. **More agents do not automatically do better.** MAST found 14 failure modes across 7 frameworks: about 42% come from specification, 37% from inter-agent misalignment and 21% from verification [P]. In E2EDevBench, a two-agent coder+tester team *beat* a three-agent waterfall with a design phase, and the main failure causes were *omitted requirements* and *weak self-verification* [P]. "Two Calls Beat Five Agents" found that a five-role pipeline on a 7B model *cut* accuracy from 75% to 45% when handoffs used JSON [P] (§4).
5. **Requirement omission is the biggest measured weakness.** State-of-the-art agents implement only about 50% of the requirements in an end-to-end build [P]. That makes traceability from requirement to task to test to verdict the most useful piece of structure available (§4, §6).
6. **The host platform already offers most of the plumbing.** The Claude Agent SDK provides subagents, session resume, hooks and `max_budget_usd`. Claude Code **Dynamic Workflows** (research preview, 28 May 2026) provide deterministic, resumable orchestration written in JS [D]. This is both a foundation to build on and competition (§5).
7. **E2E testing of web apps with agents is now practical.** Playwright MCP gives agents accessibility snapshots, and Playwright ships Planner, Generator and Healer agents [S/D]. Non-web products (CLIs, libraries) need other harnesses (§7).
8. **LLM UX critique is real but uneven.** UXBench (2026) finds that critique quality varies a lot by model and by type of screen: docs and pricing pages score well, while dashboards and chat/agent UIs score poorly. It measures a critique's value by whether a *repair agent can act on it* [P]. UXAgent, PerceptUI and AppLooper are prior work on persona-based virtual users [P] (§8).
9. **The router's rework mechanics have a direct precedent.** LangGraph's checkpoint "time travel" replays everything after a chosen checkpoint, which means all later nodes run again at full cost [D] (§6.3).
10. **Cost is effectively the price.** The user pays their own API bill, and every go-back re-runs expensive stages. Budget caps, per-stage cost reporting and loop limits are expected in this category (§9).

---

## 1. Problem space recap (inputs from earlier stages)

| Earlier finding | Source doc |
|---|---|
| Target user: solo developer or technical founder, running a local CLI (`npm run orchestrator`), with git and `docs/*.md` handoffs | product_understanding §2, §5 |
| Stages run unattended by default and record open questions instead of blocking | product_understanding §5.3 |
| The critic gives advice only | product_understanding §5.7 |
| Budgets matter, and runaway loops must be avoided | product_understanding §5.8; classification §5.1 |
| Pitfalls: meter shock, more agents ≠ better, absorption by the platform, ceremony, silent failures, e2e is hard, vendor coupling | classification §5 |
| The key competitive question: "what does this do that a BMAD-style plugin on Claude Code doesn't?" | classification §6 |

---

## 2. Competitor and prior-art feature matrix

### 2.1 Feature-level comparison

| Capability | BMAD-METHOD | GitHub Spec Kit | AWS Kiro | MetaGPT / ChatDev | Claude Code (subagents + Dynamic Workflows) | Devin / OpenHands | AppLooper (research) | **This idea** |
|---|---|---|---|---|---|---|---|---|
| Staged role personas | ✅ analyst, PM, architect, SM, dev, QA | Partial (commands, not personas) | Partial (3 phases) | ✅ | Build your own | ❌ single agent | ✅ 5 actors | ✅ ~9 stages |
| File-based handoffs | ✅ | ✅ `spec.md`/`plan.md`/`tasks.md` | ✅ `requirements.md`/`design.md`/`tasks.md` | Structured docs (SOPs) | Build your own | ❌ | Partial | ✅ `docs/<stage>.md` |
| Idea research / market check | Analyst persona (brainstorm, brief) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Product classification → playbook | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (appears unique) |
| Clarify ambiguity before planning | Via human chat | ✅ `/speckit.clarify` | Human reviews each phase | Weak | — | Asks the human | Owner confirms requirements | Records open questions (runs unattended) |
| Cross-artifact consistency check | Checklists | ✅ `/speckit.analyze` (read-only; spec↔plan↔tasks) | Tasks linked to requirements | ❌ | — | ❌ | Owner-intent simulation agent | Reviewer + router (TBD) |
| Change management / going back | ✅ **"Correct Course" workflow**, triggered by the human (impact assessment, re-prioritisation, re-planning) | Human edits and re-runs commands; `/speckit.converge` | Human edits and regenerates | Weak (noted in literature) | Code-level loops only | Retries in its own loop | Development loop driven by virtual-user feedback | ✅ **automatic router to any stage** |
| UX / human-perspective critic | ❌ (UX-expert persona writes specs, doesn't critique running apps) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ virtual-user cohort | ✅ on demand |
| Runs the built app (e2e) | QA persona (mostly written tests) | ❌ | ❌ | Limited | Possible via MCP | ✅ sandboxed | ✅ browser interaction | ✅ required |
| Deterministic, resumable orchestration | ❌ (driven by the human) | ❌ | IDE state | ❌ | ✅ Dynamic Workflows | Platform-managed | Research prototype | TBD |
| Budget / cost controls | None built in | None | Plan limits | None | `max_budget_usd`, plan limits | Plan credits | n/a | Required (category norm) |
| Distribution | npm installer, IDE agents, skills marketplaces | CLI (`specify`), works with many agents | IDE | pip / hosted MGX | Built in | SaaS / OSS | Paper | Local CLI; plugin is an open question |

### 2.2 Notes per competitor

- **BMAD-METHOD** [S]. Around 48k stars (reported). Defines personas with strict role boundaries and a lot of templates. The **"Correct Course" skill** is the closest existing counterpart to the feedback router. It is triggered manually ("correct course" / "propose sprint change") and produces an impact assessment, re-prioritisation, re-estimation of affected items, and risk and rollback plans. It works at sprint/backlog level and is not automatic. A GitHub issue (#1620, "Refinement Workflow?") shows users asking for better refinement and going-back support. BMAD is also packaged as Claude Code / agent skills (LobeHub, skills.lc), which shows the "pipeline as plugin" route already exists.
- **GitHub Spec Kit** [D]. Command path: `/speckit.constitution → specify → clarify → plan → checklist → tasks → analyze → implement → converge`. *clarify*, *checklist* and *analyze* are optional **quality gates**. The **constitution** holds project principles that every later step is checked against, which is a cross-cutting "rules" document. `/speckit.analyze` is **read-only** and reports inconsistencies between spec, plan and tasks without editing them. That pattern (detect and report, let someone else fix) is directly useful for designing the router and reviewer.
- **AWS Kiro** [D]. Three files per spec. Requirements use **EARS notation** ("WHEN [condition] THE SYSTEM SHALL [behaviour]"). Tasks are sequenced by dependency and **each is linked to requirements**, and tasks carry test, loading-state, responsiveness and accessibility sub-items. EARS gives acceptance criteria a machine-checkable shape, which helps turn e2e results into requirement-level verdicts.
- **MetaGPT / ChatDev** [P]. They established the "software company of agents" idea with SOP-structured documents. Their weak feedback loops and plausible-but-wrong handoffs are well documented in MAST.
- **Claude Code** [D/S]. Subagents give isolated context. Agent Teams are experimental (Feb 2026). **Dynamic Workflows** (28 May 2026, research preview; Max/Team/Enterprise and API/Bedrock/Vertex/Foundry): JS scripts where loops, conditionals and fan-out are plain code, and only leaf `agent()` calls spend tokens. They behave the same on every run and **can resume if they stop partway**. Commentators warn against using them as an "intern swarm" of many parallel agents with no structure.
- **Devin / OpenHands** [S]. Autonomous task-level engineers. They compete on the end result, not on the paper trail.
- **AppLooper** (arXiv 2608.14093, Aug 2026) [P]. The closest research prior art to the critic + e2e + router combination. It has five actors: an *owner* (confirms requirements and decides on release), a *development agent* (works in an isolated workspace), a *virtual-user cohort* (runs interface scenarios grounded in target users and contexts), an *owner-intent simulation agent* (read-only retesting against **only owner-confirmed** requirements), and a *testing agent* (read-only: reproduction, regression, source-assisted diagnosis, browser). It names the problems as requirement drift, users losing track of current state and rationale, and poor grounding in target users.

### 2.3 Implications to weigh
- How the automatic router differs from BMAD's human-triggered Correct Course is the headline difference. It needs to be *visibly* better, for example with evidence-backed attribution and a displayed impact assessment.
- Several read-only checker patterns (Spec Kit analyze, AppLooper's read-only testers) separate *detecting* a problem from *fixing* it. That fits the "critic advises only" assumption.
- Is a constitution-style cross-cutting document useful here? `classification.md` partly plays that role already.

---

## 3. Feedback router: prior art on failure attribution

### 3.1 Benchmarks and results

| Work | Setup | Key numbers |
|---|---|---|
| **Who&When** (ICML 2025 spotlight; arXiv 2505.00212) [P] | Failure logs from 127 multi-agent systems, annotated with the responsible agent and the decisive step | Best method: **53.5% agent-level, 14.2% step-level**. o1 and R1 are not practically usable. Some methods score below random. |
| Three baseline strategies (same paper) | *All-at-once* (whole log), *step-by-step* (incremental), *binary search* (which half contains the error) | Trade-offs: all-at-once tends to do better at agent level, step-by-step at step level. Binary search is cheaper on long logs. |
| **AgenTracer** (ICLR 2026; arXiv 2509.03312) [P] | Counterfactual replay (swap one action for a gold action and see whether the outcome flips) plus fault injection → TracerTraj dataset of 2k+ traces → trained 8B scorer | **~69% agent, ~20% step.** Beats DeepSeek-R1 by ~12 points and Gemini-2.5-Pro by ~18 points on Who&When. Adding it to self-correcting systems gave **up to +14.2%** task performance. |
| Causal Agent Replay (arXiv 2606.08275) [P] | Counterfactual attribution by replaying | The same idea: re-run with one change to test whether it causes the failure. |
| Hierarchical attribution (2510.04886), "Detect Before You Attribute" / cascade attribution (2608.29646), "Seeing the Whole Elephant" benchmark (2604.22708), "Who Broke the System?" (2607.07989) [P] | Newer work on how errors cascade and where they start | Theme: errors *spread*. The stage where a symptom shows up is often not where it began, so detect first, then trace back. |
| Autonomous repair via MCTS (2607.29055) [P] | Searches over candidate repairs to a multi-agent system | Shows repair treated as a search, with cost to match. |

### 3.2 MAST failure taxonomy (arXiv 2503.13657) [P]
Fourteen modes, with high inter-annotator agreement (κ = 0.88):
- **Specification (~42%)**: 1.1 disobey task spec · 1.2 disobey role spec · 1.3 step repetition · 1.4 loss of conversation history · 1.5 unaware of termination conditions
- **Inter-agent misalignment (~37%)**: 2.1 conversation reset · 2.2 fail to ask for clarification · 2.3 task derailment · 2.4 information withholding · 2.5 ignored other agent's input · 2.6 reasoning–action mismatch
- **Task verification (~21%)**: 3.1 premature termination · 3.2 no or incomplete verification · (3.3 incorrect verification, in some versions)

The MAST dataset is on Hugging Face (`mcemri/MAST-Data`), and IBM has applied it to enterprise agents with IT-Bench.

### 3.3 How the router's problem differs from the benchmarks
- **Granularity:** our router chooses among about 9 stages that each produce a durable document. Who&When chooses among many agents and steps in raw chat logs. The *agent-level* figures (~50–70%) are the relevant ones, and the task here is probably easier because stage boundaries are explicit.
- **Available evidence:** we can have structured artefacts (requirement IDs, task↔requirement links, test↔requirement links, commit↔task links) that the benchmark systems lacked.
- **Counterfactual replay is possible but expensive:** re-running a stage with a patched input to see whether the problem goes away is the AgenTracer idea, but each replay costs a stage run.

### 3.4 Attribution signals available in this pipeline (a list, not a design)
| Signal | Points to |
|---|---|
| Failing e2e test tied to a requirement ID that is missing from discovery/plan | discovery or plan (omission) |
| Requirement present in the spec but no task covers it | plan |
| Task present, code absent or wrong, and the test fails | implementation |
| Code matches the task, but the task contradicts the architecture | plan ↔ architecture mismatch |
| Critic says "users won't understand X" and X matches the spec exactly | discovery or design (intent), not code |
| Review finds a pattern that goes against the architecture document | implementation (or the architecture was under-specified) |
| Contradictions between docs (Spec-Kit-analyze style) | the earlier of the two contradicting docs is a candidate |

### 3.5 Implications to weigh
- Router accuracy is the defensible feature *and* a known weak point. Options include: attach evidence and confidence to each routing decision; ask for human confirmation when confidence is low; route to the *nearest* likely stage first and escalate further back if the problem comes back; use counterfactual replay only for expensive decisions.
- Which MAST modes can each stage's checks catch? (For example, 1.5 "unaware of termination" corresponds to loop limits, and 2.2 "fail to ask for clarification" corresponds to how open questions are recorded.)
- Should routing decisions be logged as data, so their accuracy can be measured over time?

---

## 4. Evidence on pipeline shape: does staging help?

| Study | Finding | Relevance |
|---|---|---|
| **E2EDevBench** (arXiv 2511.04064) [P] | 50 recent PyPI projects, sandboxed. Compared Single agent, **DT (coder + tester)** and **DDT (design → dev → test waterfall)**. Best: **DT with Gemini-2.5-Pro at 53.5% of requirements implemented.** Main bottlenecks: **requirement omission and weak self-verification.** Evaluation combined test cases with LLM-based checking of each requirement. | Adding a design stage did not automatically help. Tester pairing and requirement coverage mattered more. The hybrid evaluation method is reusable for our e2e and review stages. |
| **Two Calls Beat Five Agents** (arXiv 2607.26922) [P] | Five-role pipeline (Parishad) on Qwen2.5-7B: GSM8K fell 75% → 45% with **JSON handoffs** and recovered to 82% with **plaintext**. Two-call self-refinement reached 86.2% with **7.4× fewer tokens**. On HumanEval (baseline 96.3%), self-refinement *dropped* to 66.5%; a task-aware gated version kept 95.1%. Rule of thumb: refine when the baseline is below 85%, avoid or gate it above 90%. | Handoff format matters (markdown prose held up better than rigid JSON on small models). Refinement and rework loops can *damage* output that was already good, so rework should be gated. |
| **MAST** [P] | Gains over single agents are often small. Failures break down as spec 42%, misalignment 37%, verification 21%. | Every stage must earn its cost. |
| **ProjDevBench** (2602.01655), **ProjectEval** (2503.07010; 20 tasks, 284 test cases, web + console), **DevBench** (2403.08604; PRD + UML + architecture → code), **PRDBench** (50 Python projects with PRDs), **DevEval** (5 stages: design, env setup, implementation, acceptance test, unit test), **E2EDev** (2510.14509) [P] | Benchmarks for building a whole project from requirements | Candidate evaluation sets for measuring the pipeline against a single-agent baseline (classification §6 asks for this). |

### 4.1 Implications to weigh
- Is there a lightweight or fast path for small ideas? This is backed by the evidence and by the "ceremony" pitfall.
- Should the handoff format be markdown prose, structured front-matter, or a mix? The evidence leans against pure JSON for reasoning-heavy handoffs, but IDs and links benefit from structure.
- Should there be a baseline comparison harness, e.g. a single-agent run on the same idea?

---

## 5. Host platform capabilities (Claude Agent SDK / Claude Code)

| Capability | What exists [D/S] | Caveats |
|---|---|---|
| `query()` sessions | Each call without `resume` starts fresh. Capture `session_id` from the init message and pass it back to continue. | Resuming keeps the full history, which adds to cost. |
| Subagents | Isolated context. The main agent coordinates. **Subagents can be resumed** with their full history (tool calls, results, reasoning). | No shared context or built-in coordination between subagents. Coordination is up to you, e.g. through files. |
| Hooks | PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd, UserPromptSubmit, etc. | Needs `ClaudeSDKClient`, not `query()`. The Python SDK lacks the SessionStart, SessionEnd and Notification hooks (per secondary sources; verify for the TS SDK). |
| `max_budget_usd` | Optional per-session cap on **cumulative** session cost | Not a default. A resumed long session reaches the cap sooner. This pipeline stage is itself running under such a cap. |
| Dynamic Workflows | Deterministic JS orchestration. Only leaf `agent()` calls spend tokens. Resumable. Parallel fan-out plus validation. | Research preview since 28 May 2026. Plan-gated (Max/Team/Enterprise) or API. The feature set may change. |
| Agent Teams | Experimental (Feb 2026) | Unstable. |
| Plugins / skills marketplace | 9k+ plugins reported. BMAD skills are already published. | The platform owns the relationship with the user. |
| MCP | Standard tool protocol, e.g. Playwright MCP for browsers | Each MCP server adds token overhead. |

### 5.1 Implications to weigh
- Build on the SDK's `query()` plus the orchestrator's own control flow, **or** on Dynamic Workflows, **or** ship as a plugin? Consider vendor coupling (classification pitfall 8) and the preview status.
- Where does durable state live (files in git vs SDK sessions)? Files survive restarts and can be edited by hand. Sessions keep reasoning but are opaque and costly to resume.

---

## 6. Traceability, resumability and rework: standards and patterns

### 6.1 Requirement formats
- **EARS** (Easy Approach to Requirements Syntax; Mavin et al., Rolls-Royce; used by Kiro). Five patterns: ubiquitous ("The system shall…"), event-driven ("WHEN… the system shall…"), state-driven ("WHILE…"), unwanted behaviour ("IF… THEN…"), optional feature ("WHERE…"). It produces testable acceptance criteria.
- **BDD Gherkin** (Given/When/Then). An alternative that maps directly to e2e test scenarios.
- **User stories with acceptance criteria.** BMAD and Spec Kit style.
- **ISO/IEC/IEEE 29148** (requirements engineering). The long-standing reference for requirement quality: necessary, unambiguous, verifiable, traceable. It is useful as a checklist even if not formally adopted.

### 6.2 Traceability patterns
- **Requirements traceability matrix (RTM)**: requirement ↔ design element ↔ task ↔ test ↔ result. Kiro links tasks to requirements, and E2EDevBench checks each requirement individually.
- **Architecture Decision Records (ADR)** (Nygard format: context, decision, consequences, status). A lightweight way to record "why" at the architecture stage, and it supports "superseded by" when the router causes a redo.
- **Provenance per decision.** "Traceability and Accountability in Role-Specialized Multi-Agent LLM Pipelines" (arXiv 2510.07614; cited in product_understanding) argues for recording which stage made which decision.
- **Git as audit log.** Commit per stage or per increment. Diffs show what a rework changed.

### 6.3 Resume and rework precedents
- **LangGraph checkpointing** [D]: saves a state snapshot after every node, per thread. `interrupt()` pauses and saves for human approval, and the graph resumes from that checkpoint. **Time travel** (`get_state_history`) replays from an earlier checkpoint, possibly with changed state, and creates a branch. **Everything after that point runs again, including model calls. Replay is a re-run of the tail, not a recording of it.** Interrupts fire again during replay.
- **Build systems (Make/Bazel) as an analogy**: invalidation based on dependencies, where only artefacts downstream of a changed input are rebuilt. This relates to product_understanding's open question "redo everything downstream or only affected parts?". Content hashes of upstream docs are one way to detect staleness.
- **Dynamic Workflows**: resumable if a run stops partway [D].

### 6.4 Implications to weigh
- How fine-grained should invalidation be: whole stage, section, or requirement ID?
- Which requirement notation (if any) to standardise on so the router and e2e stages can reason in terms of IDs?
- When a user edits a document by hand, how is that detected and fed back in (hash change → mark downstream stale)?

---

## 7. End-to-end testing approaches

| Product type | Tools and approaches found | Notes |
|---|---|---|
| Web app | **Playwright MCP**: the agent drives a real browser through **accessibility-tree snapshots** (roles, labels, states) instead of screenshots, and works with Claude Code, Cursor, VS Code, etc. [S]. Playwright's built-in agents: **Planner** (explores the app and drafts a test plan from a goal), **Generator** (writes test files with role-based locators), **Healer** (tells a real bug from a broken selector and fixes non-behavioural breakage) [S/D]. Traces include DOM snapshots, network, console and screenshots at each step. | Accessibility snapshots are cheaper and more reliable than vision. They also surface accessibility problems, which helps the critic. The Healer's "real bug vs flaky test" call feeds router signals. |
| CLI | Run commands in a sandbox and assert on stdout/exit codes (golden files); `expect`-style scripting | No browser needed. |
| Library | Tests of the public API, example-based or property-based | "E2E" here means consumer-level use of the API. |
| API / service | Contract tests (OpenAPI), HTTP smoke tests | — |
| Evaluation method | **E2EDevBench's hybrid approach**: test cases plus an **LLM check of each requirement** [P] | Catches omitted requirements, which tests alone may miss if the tests were written from the same flawed spec. |
| Sandboxing | Devin/OpenHands use container sandboxes. E2EDevBench filtered projects by whether they could run in a sandbox. | Local-first means Docker or a temp directory. Security matters when running generated code. |

### 7.1 Implications to weigh
- Which product types does v1 support? This is product_understanding open question 3. E2E cost depends heavily on it.
- Should tests come *from requirements* (independent of the implementer) to avoid a self-confirming loop? AppLooper's owner-intent agent retests only against owner-confirmed requirements.
- How to handle flaky tests before they trigger a (costly) router go-back.

---

## 8. Critic (human/UX perspective): prior art

| Work | What it does | Takeaways |
|---|---|---|
| **UXBench** (arXiv 2606.16262, 2026) [P] | Benchmark of LLMs as **interaction-grounded** UX judges. Runnable web fixtures across 10 kinds of product screen. **Coverage-gated exploration** (the model must interact before reporting). Scores each report by **repair lift**: does a downstream repair agent improve the UI using the critique? Checked with a blind human study; 8 frontier models. | Critique quality is **not saturated** and varies by model and screen type. Docs and pricing pages are easy; **dashboards and chat/agent UIs are hard**. Models have different rubric strengths (e.g. error recovery vs feedback). "Actionability" is a measurable quality bar. |
| **UXAgent** (CHI EA 2025; arXiv 2502.12561 / 2504.09407) [P] | Persona Generator, LLM agents, and a Universal Browser Connector. Simulates thousands of users. Outputs qualitative results (interviews with agents), quantitative results (action counts) and video. | UX researchers worried that simulated users could be *mistaken for real users*, which is a risk to over-trust. |
| **PerceptUI** (arXiv 2606.05697) [P] | LLM agents as human-aligned synthetic users for UI/UX evaluation | Aligning agents with human perception is an active research area. |
| **SimUser, UXCascade, Avenir-UX** (cited in the UXAgent line of work) [P] | Mobile heuristic issues; combining traces into findings; GUI-grounded SUS/SEQ-style reports | Standard instruments (SUS, SEQ) can structure critic output. |
| **UICrit** [P] | Dataset of UI critiques for automated design evaluation | Possible few-shot source. |
| **AppLooper virtual-user cohort** [P] | Interface scenarios grounded in target users and contexts of use | The personas come from the discovered users, which connects the critic to the discovery documents. |
| Established heuristics | **Nielsen's 10 usability heuristics**, **WCAG 2.2** (accessibility), **SUS** (10-item System Usability Scale), **SEQ** (Single Ease Question), cognitive walkthrough | Recognised frameworks the critic could cite, so its findings are grounded and not just taste. |

### 8.1 Two kinds of critique target
- **Documents** (spec, plan, architecture): "Would a person understand this, and is the scope sensible?" No browser needed. Closer to a cognitive walkthrough of the intended flows.
- **Running software**: needs interaction evidence (UXBench's coverage gating). Playwright MCP accessibility snapshots, optionally with screenshots for visual issues.

### 8.2 Implications to weigh
- Should critic findings be scored or formatted for *actionability*, e.g. location, heuristic violated, severity, suggested fix, so the router and implementers can act on them?
- Should personas come from the discovery documents?
- Model choice for the critic matters, since it is not saturated and varies by screen type.
- Guard against over-trust: label critic output as simulated, not real user evidence.

---

## 9. Cost and pricing context

| Fact | Source |
|---|---|
| AI coding tools have moved to metered, credit-based billing; typical tiers are $20 / ~$60–100 / $200 per month; Copilot moved to per-token credits on 1 Jun 2026 | classification §4 [S] |
| Reported overage bills above $1k/month caused backlash ("meter shock") | classification §5 [S] |
| Self-refinement used **7.4× fewer tokens** than a 5-agent pipeline while being more accurate on GSM8K | Two Calls Beat Five Agents [P] |
| Replaying from a checkpoint re-runs every later model call | LangGraph docs [D] |
| `max_budget_usd` counts cumulative session cost, and resumed sessions carry earlier cost | Agent SDK guides [S] |
| Dynamic Workflows spend tokens only in leaf `agent()` calls; control flow is free | Claude docs/blog [D] |
| Competing tools' prices: MGX from about $20/mo to $200–500 Pro; Devin Free/$20/$200 | classification §3 [S] |

### 9.1 Cost levers found in prior art (options, not choices)
- Per-stage budgets plus a global run budget; loop and go-back limits (MAST 1.5 "unaware of termination").
- Different models per role (cheaper models for mechanical stages, stronger ones for attribution and critique).
- Prompt caching of stable context such as upstream documents (a common SDK practice; the exact savings weren't verified here).
- Gated refinement: rework only when a check fails with confidence (Two Calls finding).
- Selective invalidation downstream instead of redoing everything (§6.3).
- Per-stage cost reporting in the run summary (expected in the category).

---

## 10. User expectations (collected from competitor reviews and the category)

| Expectation | Evidence |
|---|---|
| **Low ceremony and a fast path for small ideas**; users skim heavy document sets | SDD criticism (classification §5.4) [S] |
| **Inspectability**: readable documents, clear why/what, a git trail | Spec Kit, Kiro, BMAD popularity; product_understanding §4 |
| **Control over going back**: users ask for refinement and going-back workflows | BMAD issue #1620; the Correct Course workflow exists |
| **Predictable cost** and caps | Backlash over metered billing |
| **Works with their existing agent or IDE** | Spec Kit supports many agents; BMAD is shipped as skills |
| **Evidence it works**, not just "code written" | The e2e gap (classification §5.6); requirement coverage around 50% [P] |
| **Resumable runs**; interruptions shouldn't lose work | Dynamic Workflows and LangGraph both advertise resuming |
| **Honesty about uncertainty**: record open questions instead of inventing answers | MAST 2.2 "fail to ask for clarification"; silent-failure papers |

---

## 11. Risks surfaced by this research (for planning to handle)

1. **Router sends work to the wrong stage.** Attribution accuracy is roughly 50–70% at best in the literature. Wrong routing wastes budget and can make good work worse.
2. **Rework makes good output worse.** Refining output that is already strong can reduce quality (HumanEval: 96% → 66%).
3. **Tests that confirm themselves.** Tests written from the same flawed spec pass while requirements are still missing.
4. **Over-trusting the critic.** Simulated users are not real users, and critique quality varies by screen type.
5. **Churn in preview platform features.** Dynamic Workflows and Agent Teams are preview or experimental.
6. **Losing information between stages.** MAST 1.4 and 2.4. Prose handoffs can drop constraints, and JSON handoffs can hurt reasoning.
7. **Cost growing with loops.** Each go-back re-runs the stages after it.
8. **Running generated code locally without a sandbox** is a security risk.

---

## 12. Open questions carried forward (not resolved here)

1. Standalone CLI, a Claude Code plugin, or a Dynamic Workflow script? (classification open question; §5.1)
2. Which product types to support in v1? This decides the e2e harness (§7).
3. Should the router act automatically at any confidence, or confirm with a human below a threshold? What are the maximum go-backs per run?
4. Invalidation granularity: stage, section, or requirement ID (§6.4)?
5. Handoff format: pure markdown, or markdown with structured front-matter and IDs (§4.1)?
6. Can the critic review documents only, running apps only, or both? Who can call it: user, router, other stages (§8)?
7. Model per role, and a default per-run budget?
8. Is a baseline comparison harness (single agent vs pipeline) in scope for v1?
9. Should a human's manual edits to a document mark downstream documents as stale automatically?
10. Is the pipeline expected to build itself as its own acceptance test? (product_understanding open question 9)

## 13. Assumptions made in this research
- The host is the Claude Agent SDK / Claude Code (inherited from earlier stages).
- Vendor feature details for Dynamic Workflows and SDK hooks come from docs and secondary guides as of Sept 2026 and may change. Hook support in the TS SDK vs the Python SDK should be checked against the current docs before relying on it.
- Star counts and prices come from secondary sources and are approximate.
- Academic numbers come from specific benchmarks and models. They show direction, not exact expected performance for this pipeline.

---

## Sources

**Failure attribution and taxonomy**
- [Which Agent Causes Task Failures and When? (Who&When, arXiv 2505.00212)](https://arxiv.org/abs/2505.00212) · [GitHub: ag2ai/Agents_Failure_Attribution](https://github.com/ag2ai/Agents_Failure_Attribution) · [Synced summary](https://syncedreview.com/2025/08/14/which-agent-causes-task-failures-and-whenresearchers-from-psu-and-duke-explores-automated-failure-attribution-of-llm-multi-agent-systems/)
- [AgenTracer (arXiv 2509.03312)](https://arxiv.org/abs/2509.03312) · [ICLR 2026 paper](https://proceedings.iclr.cc/paper_files/paper/2026/file/134ed7a477770f227f12450ef0cbb8f4-Paper-Conference.pdf)
- [Causal Agent Replay (arXiv 2606.08275)](https://arxiv.org/html/2606.08275v1)
- [Where Did It All Go Wrong? Hierarchical Error Attribution (arXiv 2510.04886)](https://arxiv.org/pdf/2510.04886)
- [Detect Before You Attribute: Cascade Failure Attribution (arXiv 2608.29646)](https://arxiv.org/pdf/2608.29646)
- [Seeing the Whole Elephant (arXiv 2604.22708)](https://arxiv.org/pdf/2604.22708)
- [Who Broke the System? (arXiv 2607.07989)](https://arxiv.org/pdf/2607.07989)
- [Autonomous Repair for MAS via MCTS (arXiv 2607.29055)](https://arxiv.org/pdf/2607.29055)
- [Why Do Multi-Agent LLM Systems Fail? (MAST, arXiv 2503.13657)](https://arxiv.org/html/2503.13657v3) · [MAST-Data](https://huggingface.co/datasets/mcemri/MAST-Data) · [IBM IT-Bench + MAST](https://huggingface.co/blog/ibm-research/itbenchandmast)

**Pipeline-shape evidence and benchmarks**
- [Two Calls Beat Five Agents (arXiv 2607.26922)](https://arxiv.org/abs/2607.26922)
- [Benchmarking LLM Agent Systems in End-to-End Software Development (E2EDevBench, arXiv 2511.04064)](https://arxiv.org/abs/2511.04064)
- [ProjDevBench (arXiv 2602.01655)](https://arxiv.org/pdf/2602.01655) · [ProjectEval (arXiv 2503.07010)](https://arxiv.org/pdf/2503.07010) · [DevBench (arXiv 2403.08604)](https://arxiv.org/html/2403.08604v1) · [E2EDev (arXiv 2510.14509)](https://arxiv.org/pdf/2510.14509)
- [AppLooper (arXiv 2608.14093)](https://arxiv.org/abs/2608.14093)

**Competitors and SDD tools**
- [BMAD correct-course skill (LobeHub)](https://lobehub.com/ru/skills/amalik-convoke-agents-bmad-correct-course) · [BMAD issue #1620](https://github.com/bmad-code-org/BMAD-METHOD/issues/1620) · [BMAD skill (skills.lc)](https://skills.lc/IHaveManyRepeat/BMAD-METHOD/ihavemanyrepeat-bmad-method-src-bmm-skills-4-implementation-bmad-correct-course-skill-md)
- [GitHub Spec Kit](https://github.com/github/spec-kit) · [Spec Kit Quickstart](https://github.github.com/spec-kit/quickstart.html) · [Spec Kit Agentic SDD](https://github.github.com/spec-kit/reference/agentic-sdd.html) · [Spec-Kit Commands (Maestro)](https://docs.runmaestro.ai/speckit-commands)
- [Kiro Specs docs](https://kiro.dev/docs/specs/) · [Introducing Kiro](https://kiro.dev/blog/introducing-kiro/) · [EARS (Wikipedia)](https://en.wikipedia.org/wiki/Easy_Approach_to_Requirements_Syntax) · [Kiro Specs Explained](https://codemyspec.com/blog/kiro-specs-explained)

**Platform**
- [Agent SDK subagents docs](https://code.claude.com/docs/en/agent-sdk/subagents) · [Claude Agent SDK guide (ksred)](https://www.ksred.com/the-claude-agent-sdk-what-it-is-and-why-its-worth-understanding/) · [Augment: Agent SDK loops](https://www.augmentcode.com/guides/claude-agent-sdk-agent-loops-tool-calls) · [Agent SDK complete guide (hidekazu-konishi)](https://hidekazu-konishi.com/entry/claude_agent_sdk_complete_guide.html)
- [A harness for every task: dynamic workflows in Claude Code](https://claude.dev/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code/) · [InfoQ: Dynamic Workflows](https://www.infoq.com/news/2026/06/dynamic-workflows-claude-code/) · [alexop.dev: deterministic orchestration](https://alexop.dev/posts/claude-code-workflows-deterministic-orchestration/) · [Tyler Folkman: don't use them like an intern swarm](https://tylerfolkman.substack.com/p/claude-code-workflows-are-here-dont)
- [LangGraph time travel docs](https://docs.langchain.com/oss/python/langgraph/use-time-travel) · [LangGraph checkpoints part 3 (jtdub)](https://www.jtdub.com/2026/09/03/langgraph-checkpoints-part-3-time-travel-and-recovery/)

**E2E testing**
- [Playwright](https://playwright.dev/) · [Playwright MCP explained (TestDino)](https://testdino.com/blog/playwright-mcp) · [Playwright AI ecosystem 2026 (TestDino)](https://testdino.com/blog/playwright-ai-ecosystem) · [Playwright MCP guide (MCP.Directory)](https://mcp.directory/blog/playwright-browser-mcp-guide-2026) · [What's new in Playwright 2026 (QASkills)](https://qaskills.sh/blog/whats-new-playwright-2026)

**UX critic**
- [UXBench (arXiv 2606.16262)](https://arxiv.org/abs/2606.16262) · [UXAgent (arXiv 2502.12561)](https://arxiv.org/abs/2502.12561) · [UXAgent system (arXiv 2504.09407)](https://arxiv.org/abs/2504.09407) · [PerceptUI (arXiv 2606.05697)](https://arxiv.org/html/2606.05697v1) · [UICrit](https://www.researchgate.net/publication/384882559_UICrit_Enhancing_Automated_Design_Evaluation_with_a_UI_Critique_Dataset)

**Carried over from earlier stages:** see the source lists in `docs/product_understanding.md` and `docs/classification.md` (pricing, market and traceability sources).
