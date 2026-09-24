// Loads our own agents/<name>.md files into the SDK's AgentDefinition shape.
//
// These definitions deliberately live in agents/ rather than .claude/agents/,
// so the SDK will NOT auto-discover them (and, with settingSources: [], would
// not read them even if they were there). We parse them ourselves and hand
// them to query() via options.agents.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { AgentName } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root: the directory containing agents/, docs/ and state/. */
export const PROJECT_ROOT = path.join(__dirname, "..");

const AGENTS_DIR = path.join(PROJECT_ROOT, "agents");

/** The frontmatter fields we care about; everything else is ignored. */
interface AgentFrontmatter {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** `tools: Read, Write, WebSearch` (CSV) or a real YAML list — accept both. */
function normalizeTools(raw: unknown, filePath: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    return raw.map((tool) => String(tool).trim()).filter((tool) => tool.length > 0);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0);
  }
  throw new Error(`Agent definition ${filePath}: "tools" must be a string or a list.`);
}

/**
 * Reads agents/<name>.md, splits the YAML frontmatter from the markdown body,
 * and maps it onto the SDK's AgentDefinition. The markdown body becomes the
 * agent's system prompt — it comes from a stable file, which is exactly what
 * keeps the cached prompt prefix stable across runs (volatile, run-specific
 * instructions belong in the per-stage `prompt` argument instead).
 */
export async function loadAgentDefinition(name: AgentName): Promise<AgentDefinition> {
  const filePath = path.join(AGENTS_DIR, `${name}.md`);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new Error(`Agent definition not found: ${filePath}`);
    }
    throw err;
  }

  const match = FRONTMATTER_RE.exec(raw);
  if (match === null) {
    throw new Error(
      `Agent definition ${filePath} has no YAML frontmatter block ` +
        `(expected the file to start with a "---" delimited block).`
    );
  }

  const [, frontmatterText = "", body = ""] = match;

  let frontmatter: AgentFrontmatter;
  try {
    const parsed = parseYaml(frontmatterText);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("frontmatter did not parse to an object");
    }
    frontmatter = parsed as AgentFrontmatter;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Agent definition ${filePath}: could not parse YAML frontmatter — ${detail}`);
  }

  const description = frontmatter.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new Error(`Agent definition ${filePath}: missing required "description" in frontmatter.`);
  }

  const prompt = body.trim();
  if (prompt.length === 0) {
    throw new Error(
      `Agent definition ${filePath}: markdown body is empty — there is no system prompt to run.`
    );
  }

  if (frontmatter.model !== undefined && typeof frontmatter.model !== "string") {
    throw new Error(`Agent definition ${filePath}: "model" must be a string if present.`);
  }

  const definition: AgentDefinition = {
    description: description.trim(),
    prompt,
  };

  const tools = normalizeTools(frontmatter.tools, filePath);
  if (tools !== undefined && tools.length > 0) definition.tools = tools;
  if (typeof frontmatter.model === "string") definition.model = frontmatter.model;

  return definition;
}
