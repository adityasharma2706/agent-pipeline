// The per-module prompt for spec-implementer, and the doc paths it names.
//
// Split out of run.ts for one concrete reason: run.ts imports `query()` from the
// Agent SDK at module scope, so ANY script that imports run.ts to look at a
// prompt has the billable path in its import graph. A prompt is the cheapest
// thing in this pipeline to get wrong and the most expensive to verify live, so
// it has to be renderable — and diffable — by a script that cannot spend money.
// Nothing in this file imports the SDK, and nothing in it should.

import path from "node:path";
import { PROJECT_ROOT } from "./agent-loader.js";
import type { ModuleSpec } from "./modules.js";
import { renderRetryGuidance } from "./retry-context.js";
import type { PriorAttempt } from "./retry-context.js";
import { workspaceRoot } from "./workspace.js";

/** The module breakdown spec-implementer loops over. */
export const IMPLEMENTER_DOC = "docs/implementer.md";

/** Absolute path to the pipeline's docs, granted to the workspace stage read-only. */
export const DOCS_DIR = path.join(PROJECT_ROOT, "docs");

/**
 * The per-module instruction for spec-implementer.
 *
 * Note what it does NOT do: paste docs/lld.md. That file is well over a
 * thousand lines, and re-sending all of it on every one of N module calls is
 * the single most expensive mistake available here. The agent has Grep and is
 * told to find its own section.
 *
 * `prior` is the one thing that differs between a first attempt and a retry.
 * When it is null the prompt is byte-identical to the pre-Phase-6 one, which is
 * deliberate: a first attempt has nothing to be told about, and changing its
 * prompt would invalidate every cost measurement taken against it.
 */
export function buildModulePrompt(
  spec: ModuleSpec,
  position: number,
  total: number,
  completed: string[],
  prior: PriorAttempt | null
): string {
  const done =
    completed.length > 0
      ? `Modules already built in this workspace: ${completed.join(", ")}. Their files exist ` +
        `already — import from them, and do not rewrite them.`
      : `This is the first module built in this workspace; it is otherwise empty apart from ` +
        `package.json, tsconfig.json and the progress log.`;

  // The retry section leads. It is the reason this call is happening, and a
  // paragraph about fixing line 131 buried under the standard preamble is a
  // paragraph that gets skimmed.
  const retry = prior === null ? [] : [renderRetryGuidance(spec.id, prior)];

  return [
    ...retry,
    `You are running as the "spec-implementer" stage of an automated product-development pipeline.`,
    `Build exactly ONE module this call: ${spec.id} (${spec.title}). It is module ${position} of ${total} in the build order.`,
    `The pipeline's design documents are at ${DOCS_DIR} and are READ-ONLY — never write there.`,
    `Do NOT read docs/lld.md end to end. Use Grep on ${path.join(DOCS_DIR, "lld.md")} to find the "${spec.id}" section, then read only that section and whatever it explicitly references.`,
    `Your working directory is ${workspaceRoot()}. All code you write goes there, at paths of your own choosing consistent with the design.`,
    done,
    `Here is ${spec.id}'s entry from ${IMPLEMENTER_DOC}, verbatim:\n\n${spec.body}`,
    spec.reqs.length > 0
      ? `The requirement IDs assigned to ${spec.id} are: ${spec.reqs.join(", ")}. Claim these and only these; claiming a REQ ID this module does not own fails the stage.`
      : `${IMPLEMENTER_DOC} assigns no REQ IDs to ${spec.id}, so report "none" for reqs.`,
    `You have no shell. Write real, complete code — the orchestrator runs tsc against the workspace after this call and rejects placeholder output.`,
    `Finish with the PIPELINE-PROGRESS block described in your instructions.`,
  ].join("\n\n");
}
