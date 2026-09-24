<!-- Written by: product-alignment stage. Read by: deep-discovery, architecture-planning. -->

# Product Classification

## 1. Decision

**Primary category: Developer tooling**
**Sub-category: AI agentic software-development orchestration.** This means spec-driven, multi-agent "idea → code" pipelines that run locally as a CLI.

**Secondary tags (these shape the playbook but don't change the category):**
- *Open-source / local-first developer tool*: runs on the user's machine and repo, and uses the user's own model API key or subscription.
- *AI infrastructure / agent framework*: it orchestrates LLM agents rather than being a single end-user app.

**Rejected categories:**

| Category | Why not |
|---|---|
| Finance, ecommerce, self-business | Nothing in the idea involves money flows, catalogs or commerce. |
| Content/media | It produces documents, but only as working material for building software, not as the product itself. |
| No-code app builder (Lovable/Bolt/v0 style) | Close neighbour, but product_understanding explicitly excludes non-technical users and polished GUIs. The user is a developer running `npm run orchestrator`. |
| Enterprise SDLC/DevOps platform | Large governed organisations are explicitly listed as not the target. |

**Confidence: high.** The one thing that could change it: if the intended user moved from "solo developer at a terminal" to "non-technical founder in a browser", the category would shift to *no-code AI app builder*. That category has a very different business model and different pitfalls (see §4).

**Note to avoid confusion:** this pipeline *has its own* classification stage for the products it builds. This document classifies *the pipeline itself*. The input idea describes the pipeline, so the two are the same here, but later stages shouldn't read this document as the design of the classification feature.

## 2. Reasoning

1. **Who pays attention and why.** The user is a developer (a solo builder or technical founder) who wants to turn an idea into a prototype. They judge the tool on output quality, cost per run, trust and inspectability. Those are dev-tool buying criteria, not consumer-app criteria.
2. **How it's delivered.** It's a local CLI working on a git repo, with markdown handoffs in `docs/`. That's the typical shape of the current spec-driven development (SDD) wave of dev tools (Spec Kit, BMAD, OpenSpec). It doesn't match hosted builders.
3. **What sets it apart.** Staged handoffs, a feedback router that can send work back to any stage, and a critic that reviews from a human/UX point of view. All three are answers to known problems with AI coding agents (drift, shallow single-prompt output, one-way pipelines), and those problems belong to the dev-tooling category.
4. **Who it competes with.** Its alternatives are other developer tools: Claude Code workflows and subagents, Spec Kit, BMAD, Kiro, MetaGPT/MGX, OpenHands, Devin. The user is choosing among these, not among consumer apps.

## 3. Grounded market research: comparable products

The table groups comparables by how close they are to this product. Figures come from secondary sources (tool round-ups, review sites) and should be treated as approximate.

### 3a. Direct comparables: multi-agent, SDLC-shaped, spec/file handoffs

| Product | Shape | Overlap | Gap this idea targets |
|---|---|---|---|
| **BMAD-METHOD** (open source, reported ~48k stars) | Named agent personas (analyst, PM, architect, dev, QA) with file-based context passing and strict role boundaries | **Very high.** This is almost exactly the same staged-persona, file-handoff concept. | Mainly a prompt/method framework the user drives through an IDE agent. No automatic feedback router that sends work back to any stage, and no dedicated UX critic. |
| **GitHub Spec Kit** (open source, reported >100k stars within months of launch) | "Constitution" plus spec → plan → tasks → implement, layered onto existing coding agents | High on the spec/plan side | Mostly one-way; the human is the loop. No research or classification stages, no critic. |
| **OpenSpec, GSD and similar SDD frameworks** | Lightweight spec-first workflows | Medium to high | Same as above. |
| **MetaGPT / MGX** (open-source framework plus a hosted product) | A "software company" of role agents; MGX is the hosted version with freemium plans starting around $20/mo and Pro tiers of $200–$500/mo sold as credits | High in concept | The original MetaGPT has a weak feedback loop (noted in product_understanding). MGX moved toward hosted, less technical users. |
| **ChatDev** | Research framework of chat-chain role agents | High in concept | Research-grade, not a maintained dev tool. |

### 3b. Platform-level comparables: the "build it yourself" alternative

| Product | Relevance |
|---|---|
| **Claude Code: subagents, Agent Teams (experimental, Feb 2026), Dynamic Workflows (research preview, May 2026), plugins** | This is the biggest competitive threat and also the most likely foundation. Dynamic Workflows specifically targets *deterministic, code-encoded multi-agent control flow*, which is roughly what this orchestrator is. The plugin ecosystem (reported 9k+ plugins) means BMAD-like pipelines can already be shared as plugins. |
| **AWS Kiro** | An IDE with specs as first-class objects. It shows the SDD workflow being absorbed into IDEs. |
| **Cursor, Copilot cloud agent, Codex** | General coding agents. Many users will simply prompt these instead of running a pipeline. |

### 3c. Autonomous "AI engineer" agents

| Product | Relevance |
|---|---|
| **Devin** (Free / $20 Pro / $200 Max / Teams) | Autonomous, task-level engineer. It competes on the end result (working code), not on the staged paper trail. |
| **OpenHands** (open source, free; its paid hosted Growth plan was reportedly discontinued in 2026) | Open-source autonomous agent. A cautionary data point: monetising a hosted version of an open-source agent is hard. |

### 3d. Adjacent category (not the target, but instructive)

| Product | Relevance |
|---|---|
| **gpt-engineer → Lovable** | The closest historical precedent. gpt-engineer, an open-source "prompt → codebase" CLI, drew about 50k stars. The team then built a hosted web product for *non-technical* users (Lovable), which reached very large ARR. **Lesson:** in this category, the money went to the hosted, non-developer experience, not the developer CLI. |

## 4. Typical business models in this category

1. **Free open-source CLI/framework, user pays the model provider (BYO key or subscription).** Used by BMAD, Spec Kit, OpenHands core, gpt-engineer. The tool itself earns nothing; value is reputation, community and a funnel. This is the most natural fit for the product as currently understood.
2. **Open core plus a hosted cloud version** (MetaGPT → MGX, gpt-engineer → Lovable, OpenHands Cloud). The hosted version adds convenience, sandboxes and collaboration. It worked well for Lovable (non-developer audience) and poorly for OpenHands Growth (developer audience).
3. **Credit/usage-based subscriptions**, now the standard for AI coding tools. Cursor, Copilot (moved to per-token credits on 1 Jun 2026), Codex, Replit and MGX all meter usage instead of charging a flat fee. Typical price points are **$20 / ~$60–100 / $200 per month**, plus team seats.
4. **Distribution through a platform marketplace** (e.g. packaging as a Claude Code plugin). This means low friction and no billing of your own, but the platform owns the relationship with the user.

**Implication (for deep-discovery and architecture to weigh, not decide here):** given the target (a solo developer running it locally), the realistic model is #1 or #4. That makes **cost per run to the user's own API bill** the de facto "price", and the main thing to optimise.

## 5. Known pitfalls for this category

1. **Runaway cost and "meter shock".** The 2026 move to usage billing caused backlash, including reported overage bills above $1,000/month. A multi-stage pipeline with a feedback router *multiplies* token use, and every go-back re-runs expensive stages. Budget caps, per-stage cost reporting and loop limits are expected features in this category, not extras.
2. **More agents ≠ better results.** The MAST study ("Why Do Multi-Agent LLM Systems Fail?", 1,600+ traces across 7 frameworks, including MetaGPT and ChatDev) found gains over single agents on benchmarks are often minimal. By its breakdown, failures come roughly **42% from specification/system design, 37% from inter-agent misalignment and 21% from weak verification**. That maps directly onto this product: the understanding/discovery stages address the first, file handoffs and the router the second, and review, e2e tests and the critic the third. Each stage must earn its cost compared with a simple plan → code → self-review loop (see also "Two Calls Beat Five Agents", already cited in product_understanding).
3. **Getting absorbed by the platform.** Claude Code's Dynamic Workflows, Agent Teams and plugins, Kiro's spec-first IDE, and Spec Kit backed by GitHub are all moving into this space. A standalone orchestrator whose only value is "stages plus handoffs" is easy to copy. What's defensible is the **feedback router's accuracy in attributing a problem to the right stage** and the **quality of the critic**, not the stage list.
4. **Framework overhead and ceremony.** SDD tools are regularly criticised for generating heavy document sets that users skim or ignore, and for being too slow for small ideas. Product_understanding already flags "keep the pipeline no heavier than it needs to be". Expect users to want a fast path for small ideas.
5. **Silent failures and plausible-but-wrong documents.** Agents hand off confident prose, and later stages build on hidden mistakes. (Recent papers on "silent failures" in agent runtimes describe errors being turned into believable narratives.) Traceability, meaning a record of which decision came from which stage, is what makes this category trustworthy.
6. **E2E verification is the hard part.** Most tools in this category stop at "code written" or unit tests. Actually running the built app (browser automation, sandboxes) is where competitors are weak, and also where cost and flakiness are highest.
7. **Stars ≠ revenue.** Open-source SDD frameworks gain stars quickly but have almost no direct monetisation. The one big commercial success (Lovable) came from changing audience to non-developers. If making money ever becomes a goal, that tension will come up.
8. **Model and vendor coupling.** Tools built on one vendor's SDK or CLI inherit that vendor's pricing changes, rate limits and feature deprecations. This matters here because the likely foundation is the Claude Agent SDK.

## 6. What this classification means for later stages (guidance, not design)

- **Deep-discovery** should compare requirements against BMAD, Spec Kit and Claude Code Workflows specifically. It should answer: "what does this do that a BMAD-style plugin on Claude Code doesn't?" Current answer: an automatic feedback router that can send work back to any stage, plus an on-demand human/UX critic.
- **Architecture** should treat cost controls (budgets, loop limits, per-stage cost reports), traceability and resumability as core requirements of the category, and should consider building *on top of* platform features instead of duplicating them.
- Success should be measured against a single-agent baseline, not just "did it finish".

## 7. Assumptions and open questions

- **Assumption:** the product isn't being monetised for now. It's a personal or open-source developer tool, so the business-model findings are context, not a plan.
- **Assumption:** the Claude Agent SDK / Claude Code is the host platform (as inferred in product_understanding). That makes Claude Code's own orchestration features both the foundation and the main competitor.
- **Open question:** should this ship as a standalone CLI or as a Claude Code plugin/workflow? The category trend favours the latter for distribution.
- **Open question:** is there any intent to serve non-technical users later? That would move the category to *no-code AI app builder* and change the business model and pitfalls.
- **Caveat:** star counts, prices and dates come from secondary round-ups and review sites as of Sept 2026 and weren't independently verified. The "3–10× first-pass success" claims made for SDD tools come from vendor and early-adopter marketing and shouldn't be relied on.

## Sources

- [6 Best Spec-Driven Development Tools for AI Coding in 2026 – Augment Code](https://www.augmentcode.com/tools/best-spec-driven-development-tools)
- [BMAD vs Spec Kit vs OpenSpec (2026) – Medium/Reenbit](https://medium.com/@reenbit/bmad-vs-spec-kit-vs-openspec-choosing-your-spec-driven-ai-framework-in-2026-a6996b3ebb8d)
- [Guide to Kiro, GitHub Spec Kit, and BMAD-METHOD – Medium](https://medium.com/@visrow/comprehensive-guide-to-spec-driven-development-kiro-github-spec-kit-and-bmad-method-5d28ff61b9b1)
- [9 Best AI Tools for Spec-Driven Development in 2026 – MarkTechPost](https://www.marktechpost.com/2026/05/08/9-best-ai-tools-for-spec-driven-development-in-2026-kiro-bmad-gsd-and-more-compare/)
- [MGX (MetaGPT): Features, Pricing & Alternatives – TechShark](https://www.techshark.io/tools/mgx-dev/)
- [OpenHands Review — Pricing (2026) – VibeCompare](https://vibecompare.dev/tools/openhands/)
- [AI Coding Tools Pricing Compared (2026) – amux](https://amux.io/blog/ai-coding-tools-pricing-2026/)
- [GitHub Copilot Alternatives After the Pricing Reset – CodingFleet](https://codingfleet.com/blog/github-copilot-alternatives-2026/)
- [Tokenomics #1: The Pricing Evolution of AI Coding Agents](https://dannguyenhuu.substack.com/p/tokenomics-1-the-pricing-evolution)
- [Why Do Multi-Agent LLM Systems Fail? (arXiv 2503.13657)](https://arxiv.org/abs/2503.13657)
- [When Errors Become Narratives: Silent Failures in a Production LLM Agent Runtime (arXiv)](https://arxiv.org/pdf/2606.14589)
- [Claude Code Orchestration – Ken Huang](https://kenhuangus.substack.com/p/claude-code-orchestration-dynamic)
- [Claude Code Agent Teams, Subagents, and MCP: 2026 Playbook – Developers Digest](https://www.developersdigest.tech/blog/claude-code-agent-teams-subagents-2026)
- [gpt-engineer (GitHub)](https://github.com/AntonOsika/gpt-engineer)
- [GPT Engineer and Lovable – The Evolution](https://lovable.dev/gpt-engineer)
- [How Lovable Hit $100M ARR in 8 Months – Product Growth](https://www.productgrowth.blog/p/how-lovable-dev-hacked-their-growth)
