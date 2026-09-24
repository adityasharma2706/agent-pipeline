// ui/server.ts — the local control panel for the agent pipeline.
//
// Node's built-in `http` only. No express, no ws, no bundler: the pipeline
// itself has three runtime dependencies and this UI adds zero. Live output
// reaches the browser over Server-Sent Events, which is a plain HTTP response
// with a `text/event-stream` content type and therefore needs no library.
//
// THIS SERVER CAN SPEND REAL MONEY. It spawns the orchestrator CLI, which bills
// an Anthropic account, and it holds the API key used to do it. Four rules
// follow from that and are enforced below rather than documented and hoped for:
//
//   1. It binds to 127.0.0.1 ONLY (see BIND_HOST).
//   2. The API key is write-only over HTTP (see handleSetKey / describeAuth).
//   3. Artifact reads are whitelisted and realpath-checked (see resolveDoc).
//   4. A run NEVER starts by itself — only POST /api/run starts one.

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PIPELINE_STAGES } from "../orchestrator/types.js";
import type {
  HistoryEntry,
  PipelineStage,
  RoutingLogEntry,
  RunState,
  StageOutcome,
} from "../orchestrator/types.js";
import { LAST_IMPLEMENTED_STAGE, NOT_IMPLEMENTED_REASONS } from "../orchestrator/stage-meta.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root: the directory holding docs/, state/, orchestrator/, ui/. */
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DOCS_DIR = path.join(PROJECT_ROOT, "docs");
const STATE_FILE = path.join(PROJECT_ROOT, "state", "run.json");
const ROUTING_LOG = path.join(PROJECT_ROOT, "state", "routing.jsonl");
const ENV_FILE = path.join(PROJECT_ROOT, ".env");
const GITIGNORE_FILE = path.join(PROJECT_ROOT, ".gitignore");
const PUBLIC_DIR = path.join(__dirname, "public");
const TSX_CLI = path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ORCHESTRATOR_ENTRY = path.join(PROJECT_ROOT, "orchestrator", "run.ts");

/**
 * Loopback only, never 0.0.0.0.
 *
 * This server has no authentication of any kind, and two of its endpoints are
 * "spend money" and "store my API key". Binding to 0.0.0.0 would publish both
 * to every device on the network (and, behind a typical home router, to
 * anything that gets on the wifi). Loopback means the only clients that can
 * reach it are processes already running as this user on this machine, which is
 * the same trust boundary as the CLI it wraps. There is deliberately no flag to
 * change this.
 */
const BIND_HOST = "127.0.0.1";

const PORT = Number.parseInt(process.env.PORT ?? "", 10) || 4317;

/** How many output lines are retained for a browser that connects late. */
const LOG_BUFFER_LIMIT = 4000;

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

type Json = unknown;

function sendJson(res: ServerResponse, status: number, body: Json): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    // Defence in depth for a page that renders model-generated markdown.
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Reads a JSON request body with a hard size cap. */
async function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        // Deliberately does not echo the body: POST /api/key bodies contain a
        // secret, and "here is the malformed JSON you sent" is a leak.
        reject(new Error("Request body is not valid JSON."));
      }
    });
    req.on("error", () => reject(new Error("Request stream failed.")));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/* ------------------------------------------------------------------ */
/* run state / dashboard                                               */
/* ------------------------------------------------------------------ */

/** What the dashboard shows per stage. */
type StageStatus = "success" | "failure" | "partial" | "in-progress" | "pending";

interface StageView {
  stage: PipelineStage;
  status: StageStatus;
  implemented: boolean;
  /** The real blocking reason, when there is one; null otherwise. */
  notImplementedReason: string | null;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** Milliseconds for the most recent attempt, or null while running/pending. */
  durationMs: number | null;
  retries: number;
}

/**
 * Reads state/run.json defensively.
 *
 * Deliberately NOT orchestrator/state.ts's loadState(): that throws on a
 * missing file because a *run* cannot proceed without one. A dashboard can —
 * "no run yet" is a legitimate thing to render, and a fresh checkout that has
 * not had setup.sh run must not blow up the whole UI.
 */
async function loadRunStateSafe(): Promise<{ state: RunState | null; error: string | null }> {
  let raw: string;
  try {
    raw = await readFile(STATE_FILE, "utf-8");
  } catch {
    return { state: null, error: null };
  }
  try {
    const parsed = asRecord(JSON.parse(raw));
    const history = Array.isArray(parsed.history) ? (parsed.history as HistoryEntry[]) : [];
    const stage = typeof parsed.stage === "string" ? (parsed.stage as PipelineStage) : null;
    const retries =
      typeof parsed.retries === "object" && parsed.retries !== null && !Array.isArray(parsed.retries)
        ? (parsed.retries as Partial<Record<PipelineStage, number>>)
        : {};
    const goBacksUsed = typeof parsed.goBacksUsed === "number" ? parsed.goBacksUsed : 0;
    return { state: { stage, history, retries, goBacksUsed }, error: null };
  } catch {
    return { state: null, error: "state/run.json exists but is not valid JSON." };
  }
}

function durationMs(entry: HistoryEntry): number | null {
  if (entry.finishedAt === null) return null;
  const start = Date.parse(entry.startedAt);
  const end = Date.parse(entry.finishedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

/**
 * Per-stage status derived from history.
 *
 * The LAST entry for a stage wins, not the best one: a stage that succeeded and
 * was then re-run by a go-back and failed is failing now, and a dashboard that
 * reported the older success would be lying about the current state.
 */
function buildStageViews(state: RunState | null): StageView[] {
  return PIPELINE_STAGES.map((stage): StageView => {
    const entries = (state?.history ?? []).filter((entry) => entry.stage === stage);
    const latest = entries.length > 0 ? entries[entries.length - 1] : undefined;
    const reason = NOT_IMPLEMENTED_REASONS[stage] ?? null;
    const implemented =
      reason === null &&
      PIPELINE_STAGES.indexOf(stage) <= PIPELINE_STAGES.indexOf(LAST_IMPLEMENTED_STAGE);

    let status: StageStatus = "pending";
    if (latest !== undefined) {
      if (latest.outcome === "in-progress" || latest.outcome === null) status = "in-progress";
      else status = latest.outcome as StageOutcome;
    }

    return {
      stage,
      status,
      implemented,
      notImplementedReason: reason,
      attempts: entries.length,
      startedAt: latest?.startedAt ?? null,
      finishedAt: latest?.finishedAt ?? null,
      durationMs: latest === undefined ? null : durationMs(latest),
      retries: state?.retries[stage] ?? 0,
    };
  });
}

/* ------------------------------------------------------------------ */
/* workspace progress ledger                                           */
/* ------------------------------------------------------------------ */

interface ModuleView {
  moduleId: string;
  title: string;
  outcome: string;
  reqsClaimed: string[];
  filesWritten: number;
  costUsd: number;
  failureReason: string | null;
  finishedAt: string | null;
}

interface WorkspaceView {
  root: string;
  exists: boolean;
  /** Total modules in docs/implementer.md, or null if it could not be counted. */
  totalModules: number | null;
  built: number;
  failed: number;
  modules: ModuleView[];
}

/** Mirrors orchestrator/workspace.ts's workspaceRoot() without importing it. */
function workspaceRootPath(): string {
  const fromEnv = process.env.PIPELINE_WORKSPACE;
  const chosen =
    typeof fromEnv === "string" && fromEnv.trim().length > 0
      ? fromEnv.trim()
      : path.join(process.env.HOME ?? "", "agent-pipeline-workspace");
  return path.resolve(chosen.startsWith("~") ? chosen.replace(/^~/, process.env.HOME ?? "") : chosen);
}

/** Counts `### Mnn ...` headings in docs/implementer.md — same shape modules.ts parses. */
async function countModulesInPlan(): Promise<number | null> {
  try {
    const markdown = await readFile(path.join(DOCS_DIR, "implementer.md"), "utf-8");
    const matches = markdown.match(/^###\s+M\d+\s/gm);
    return matches === null ? null : matches.length;
  } catch {
    return null;
  }
}

async function loadWorkspaceView(): Promise<WorkspaceView> {
  const root = workspaceRootPath();
  const empty: WorkspaceView = {
    root,
    exists: false,
    totalModules: await countModulesInPlan(),
    built: 0,
    failed: 0,
    modules: [],
  };

  let raw: string;
  try {
    raw = await readFile(path.join(root, "pipeline-progress.json"), "utf-8");
  } catch {
    return empty;
  }

  let entries: unknown;
  try {
    entries = asRecord(JSON.parse(raw)).entries;
  } catch {
    return { ...empty, exists: true };
  }
  if (!Array.isArray(entries)) return { ...empty, exists: true };

  const modules: ModuleView[] = entries.map((value): ModuleView => {
    const entry = asRecord(value);
    return {
      moduleId: asString(entry.moduleId) ?? "?",
      title: asString(entry.title) ?? "",
      outcome: asString(entry.outcome) ?? "unknown",
      reqsClaimed: Array.isArray(entry.reqsClaimed) ? entry.reqsClaimed.map(String) : [],
      filesWritten: Array.isArray(entry.filesWritten) ? entry.filesWritten.length : 0,
      costUsd: typeof entry.costUsd === "number" ? entry.costUsd : 0,
      failureReason: asString(entry.failureReason),
      finishedAt: asString(entry.finishedAt),
    };
  });

  return {
    ...empty,
    exists: true,
    modules,
    built: modules.filter((m) => m.outcome === "success").length,
    failed: modules.filter((m) => m.outcome === "failure").length,
  };
}

/* ------------------------------------------------------------------ */
/* auth status — reports PRESENCE ONLY, never the key                  */
/* ------------------------------------------------------------------ */

type AuthSource = "env-file" | "environment" | "cli-login";

interface AuthView {
  configured: boolean;
  source: AuthSource;
  detail: string;
}

/**
 * Whether a key is set and where it comes from. It returns no part of the key
 * itself — not the value, not a prefix, not a masked form, not its length.
 * "Just the last four characters" is how keys end up in screenshots and
 * screen-shares, and there is nothing a human needs those characters for here.
 *
 * The precedence mirrors the orchestrator's: loadDotEnv() only fills in
 * variables that are not already set, so a real environment variable wins over
 * .env, and no key at all falls back to the machine's Claude CLI login.
 */
async function describeAuth(): Promise<AuthView> {
  const fromEnvVar = process.env.ANTHROPIC_API_KEY;
  if (typeof fromEnvVar === "string" && fromEnvVar.length > 0) {
    return {
      configured: true,
      source: "environment",
      detail:
        "ANTHROPIC_API_KEY is set in this server's own environment. It takes precedence over .env, " +
        "so saving a key here will not change which credential a run bills until that variable is unset.",
    };
  }

  let envText: string;
  try {
    envText = await readFile(ENV_FILE, "utf-8");
  } catch {
    return {
      configured: false,
      source: "cli-login",
      detail:
        "No ANTHROPIC_API_KEY is set. The Agent SDK will fall back to this machine's Claude CLI " +
        "login, if there is one, and bill that account.",
    };
  }

  const hasKey = /^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*\S/m.test(envText);
  if (hasKey) {
    return {
      configured: true,
      source: "env-file",
      detail: "A key is stored in .env (file mode 0600, gitignored). Runs will bill that account.",
    };
  }
  return {
    configured: false,
    source: "cli-login",
    detail:
      ".env exists but contains no ANTHROPIC_API_KEY. The Agent SDK will fall back to this " +
      "machine's Claude CLI login, if there is one, and bill that account.",
  };
}

/** The key format the API actually issues. Rejecting early beats a $0 failed run. */
const API_KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,250}$/;

/** True when .gitignore would keep .env out of git. Checked BEFORE writing a key. */
async function envFileIsGitignored(): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(GITIGNORE_FILE, "utf-8");
  } catch {
    return false;
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ".env" || line === "/.env" || line === "*.env" || line === ".env*");
}

/**
 * Stores the key in .env, which is the file the orchestrator's loadDotEnv()
 * already reads. The key goes one way only: in. Nothing in this server ever
 * returns it, logs it, or includes it in an error message — note that the
 * catch below reports a fixed string rather than the underlying error, because
 * fs errors can quote the content they failed to write.
 */
async function handleSetKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : "Could not read the request body.");
    return;
  }

  const key = (asString(asRecord(body).key) ?? "").trim();
  if (key.length === 0) {
    sendError(res, 400, "No key was supplied.");
    return;
  }
  if (!API_KEY_RE.test(key)) {
    sendError(
      res,
      400,
      "That does not look like an Anthropic API key. They start with \"sk-ant-\" and contain only " +
        "letters, digits, hyphens and underscores. Nothing was written."
    );
    return;
  }

  if (!(await envFileIsGitignored())) {
    sendError(
      res,
      409,
      "Refusing to write the key: .env is not listed in .gitignore, so it could be committed. " +
        "Add \".env\" to .gitignore and try again."
    );
    return;
  }

  // Preserve any other variables already in .env; replace only this one.
  let existing = "";
  try {
    existing = await readFile(ENV_FILE, "utf-8");
  } catch {
    existing = "";
  }
  const kept = existing
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=/.test(line))
    .join("\n")
    .trimEnd();
  const next = `${kept.length > 0 ? `${kept}\n` : ""}ANTHROPIC_API_KEY=${key}\n`;

  try {
    // 0600 — owner read/write only. The mode is passed to writeFile rather than
    // chmod'd afterwards so the file is never briefly world-readable.
    await writeFile(ENV_FILE, next, { encoding: "utf-8", mode: 0o600 });
  } catch {
    sendError(res, 500, "Could not write .env. Check the project directory is writable.");
    return;
  }

  sendJson(res, 200, { ok: true, auth: await describeAuth() });
}

/* ------------------------------------------------------------------ */
/* artifacts — whitelisted, realpath-checked                           */
/* ------------------------------------------------------------------ */

interface ArtifactView {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  /** True when the file still holds only its HTML-comment header. */
  placeholder: boolean;
}

/** Same emptiness test the orchestrator uses to verify a document stage. */
function isPlaceholder(text: string): boolean {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim().length === 0;
}

async function listArtifacts(): Promise<ArtifactView[]> {
  let names: string[];
  try {
    names = (await readdir(DOCS_DIR)).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }

  const views: ArtifactView[] = [];
  for (const name of names.sort()) {
    const full = path.join(DOCS_DIR, name);
    try {
      const info = await stat(full);
      if (!info.isFile()) continue;
      const text = await readFile(full, "utf-8");
      views.push({
        name,
        sizeBytes: info.size,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
        placeholder: isPlaceholder(text),
      });
    } catch {
      // Unreadable file: omitted rather than crashing the list.
    }
  }
  return views;
}

/**
 * Resolves a requested artifact name to an absolute path, or null.
 *
 * Two independent checks, because either alone has a known bypass:
 *   1. the name must be in the whitelist derived from a fresh readdir of docs/
 *      (so "../.env", "%2e%2e/", absolute paths and anything not ending .md are
 *      simply not in the set), and
 *   2. the REAL path — symlinks resolved — must still sit inside the real
 *      docs/ directory, so a symlink inside docs/ pointing at ~/.ssh/id_rsa
 *      cannot be read through a whitelisted name.
 * No string concatenation decides this.
 */
async function resolveDoc(requested: string): Promise<string | null> {
  const allowed = new Set((await listArtifacts()).map((a) => a.name));
  if (!allowed.has(requested)) return null;

  try {
    const realDocs = await realpath(DOCS_DIR);
    const realFile = await realpath(path.join(DOCS_DIR, requested));
    const inside = realFile.startsWith(realDocs + path.sep);
    const info = await stat(realFile);
    return inside && info.isFile() ? realFile : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* routing log                                                         */
/* ------------------------------------------------------------------ */

async function loadRoutingEntries(): Promise<RoutingLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(ROUTING_LOG, "utf-8");
  } catch {
    return [];
  }
  const entries: RoutingLogEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = asRecord(JSON.parse(line));
      if (typeof parsed.id === "string" && typeof parsed.target_stage === "string") {
        entries.push(parsed as unknown as RoutingLogEntry);
      }
    } catch {
      // A corrupt line degrades the view; it does not break it.
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* the run process + SSE                                               */
/* ------------------------------------------------------------------ */

interface LogLine {
  seq: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
  at: string;
}

interface RunView {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  /** Cumulative USD scraped from the orchestrator's own output. */
  costUsd: number;
  /** The command line, for transparency about what is actually being spawned. */
  command: string | null;
  pid: number | null;
}

/** stdin is ignored; stdout/stderr are piped, so both are non-null Readables. */
type RunProcess = ChildProcessByStdio<null, Readable, Readable>;

let child: RunProcess | null = null;
let run: RunView = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  costUsd: 0,
  command: null,
  pid: null,
};
let logBuffer: LogLine[] = [];
let seq = 0;
const sseClients = new Set<ServerResponse>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    // A browser tab that went away mid-write must not take the server with it.
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function pushLine(stream: LogLine["stream"], text: string): void {
  seq += 1;
  const line: LogLine = { seq, stream, text, at: new Date().toISOString() };
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_LIMIT) logBuffer = logBuffer.slice(-LOG_BUFFER_LIMIT);
  broadcast("line", line);
}

/**
 * Scrapes the cumulative spend out of the orchestrator's own console output.
 *
 * It is deliberately a reader of what the CLI already prints rather than a
 * second accounting system: the numbers a human sees in the UI and in a
 * terminal are then the same numbers, and the CLI stays the single source of
 * truth for money. `(cumulative $X of $Y)` and the final `Total cost: $X`
 * both carry the running total, so the maximum seen is the total so far.
 */
function updateCostFromLine(text: string): void {
  const patterns = [/cumulative \$([0-9]+\.[0-9]+)/, /Total cost: \$([0-9]+\.[0-9]+)/];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const value = Number.parseFloat(match[1] ?? "");
    if (Number.isFinite(value) && value > run.costUsd) {
      run = { ...run, costUsd: value };
      broadcast("run", run);
    }
  }
}

/** Splits a chunk into lines, keeping a partial tail until its newline arrives. */
function makeLineSplitter(stream: "stdout" | "stderr"): (chunk: Buffer) => void {
  let pending = "";
  return (chunk: Buffer): void => {
    pending += chunk.toString("utf-8");
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const part of parts) {
      pushLine(stream, part);
      updateCostFromLine(part);
    }
  };
}

/**
 * Starts the orchestrator.
 *
 * It SPAWNS THE EXISTING CLI rather than reimplementing any of the pipeline:
 * every cap, retry rule, budget gate and state transition stays in
 * orchestrator/run.ts, and this server is only a keyboard and a screen for it.
 *
 * Arguments are passed as an argv array with no shell, so an idea containing
 * backticks, `$(...)` or a semicolon is idea text and nothing else.
 */
async function handleStartRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (child !== null) {
    sendError(res, 409, "A run is already in progress. Stop it before starting another.");
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendError(res, 400, err instanceof Error ? err.message : "Could not read the request body.");
    return;
  }
  const fields = asRecord(body);
  const idea = (asString(fields.idea) ?? "").trim();
  const maxModules = asPositiveInt(fields.maxModules, 2);
  const maxGoBacks = asPositiveInt(fields.maxGoBacks, 3);

  const args = [TSX_CLI, ORCHESTRATOR_ENTRY];
  if (idea.length > 0) args.push(idea);
  args.push("--max-modules", String(maxModules), "--max-go-backs", String(maxGoBacks));

  const command = `node tsx orchestrator/run.ts${idea.length > 0 ? " \"<idea>\"" : ""} --max-modules ${maxModules} --max-go-backs ${maxGoBacks}`;

  let spawned: RunProcess;
  try {
    spawned = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      // The child inherits this server's env, which is how an operator-set
      // ANTHROPIC_API_KEY reaches it. The child reads .env itself (loadDotEnv),
      // so this server never has to hold the key in memory.
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }) as RunProcess;
  } catch (err) {
    sendError(res, 500, `Could not start the orchestrator: ${err instanceof Error ? err.message : "unknown error"}`);
    return;
  }

  child = spawned;
  logBuffer = [];
  seq = 0;
  run = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    costUsd: 0,
    command,
    pid: spawned.pid ?? null,
  };
  broadcast("run", run);
  pushLine("system", `$ ${command}`);

  spawned.stdout.on("data", makeLineSplitter("stdout"));
  spawned.stderr.on("data", makeLineSplitter("stderr"));

  spawned.on("error", (err: Error) => {
    pushLine("system", `Failed to run the orchestrator: ${err.message}`);
  });

  spawned.on("close", (code: number | null, signal: string | null) => {
    child = null;
    run = {
      ...run,
      running: false,
      finishedAt: new Date().toISOString(),
      exitCode: code,
      pid: null,
    };
    pushLine(
      "system",
      signal !== null ? `Process stopped (${signal}).` : `Process exited with code ${code ?? 0}.`
    );
    broadcast("run", run);
  });

  sendJson(res, 200, { ok: true, run });
}

function handleStopRun(res: ServerResponse): void {
  if (child === null) {
    sendError(res, 409, "No run is in progress.");
    return;
  }
  // SIGTERM, not SIGKILL: the orchestrator persists state/run.json as it goes,
  // and an in-progress history entry is an honest record either way.
  child.kill("SIGTERM");
  pushLine("system", "Stop requested (SIGTERM).");
  sendJson(res, 200, { ok: true });
}

function handleStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  res.write(`event: run\ndata: ${JSON.stringify(run)}\n\n`);
  for (const line of logBuffer) {
    res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`);
  }
  sseClients.add(res);

  // Some proxies and sleeping laptops drop an idle stream silently; a comment
  // every 20s keeps it demonstrably alive.
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

/* ------------------------------------------------------------------ */
/* static files                                                        */
/* ------------------------------------------------------------------ */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // Same containment rule as the artifact endpoint: resolve, then verify the
  // result is still under PUBLIC_DIR.
  const target = path.resolve(PUBLIC_DIR, relative);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    sendError(res, 403, "Forbidden.");
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(target)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    createReadStream(target).pipe(res);
  } catch {
    sendError(res, 404, `Not found: ${pathname}`);
  }
}

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

async function handleStatus(res: ServerResponse): Promise<void> {
  const { state, error } = await loadRunStateSafe();
  sendJson(res, 200, {
    stages: buildStageViews(state),
    lastImplementedStage: LAST_IMPLEMENTED_STAGE,
    currentStage: state?.stage ?? null,
    goBacksUsed: state?.goBacksUsed ?? 0,
    hasRunState: state !== null,
    stateError: error,
    workspace: await loadWorkspaceView(),
    auth: await describeAuth(),
    run,
    projectRoot: PROJECT_ROOT,
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // `req.url` is a path, never a full URL, so a fixed dummy origin is correct.
  const url = new URL(req.url ?? "/", `http://${BIND_HOST}`);
  const pathname = url.pathname;
  const method = req.method ?? "GET";

  // Request logging is PATH ONLY and never includes bodies, query strings or
  // headers — POST /api/key carries a secret in its body, and an access log
  // that swallowed it would persist the key somewhere nobody expects.
  if (pathname.startsWith("/api/")) console.log(`${method} ${pathname}`);

  if (method === "GET" && pathname === "/api/status") return await handleStatus(res);
  if (method === "GET" && pathname === "/api/artifacts") {
    return sendJson(res, 200, { artifacts: await listArtifacts() });
  }
  if (method === "GET" && pathname === "/api/artifact") {
    const name = url.searchParams.get("name") ?? "";
    const file = await resolveDoc(name);
    if (file === null) {
      // The same message for "not in the whitelist" and "escaped docs/": a
      // distinct error for the second tells a prober which names exist.
      sendError(res, 404, "No such artifact.");
      return;
    }
    const text = await readFile(file, "utf-8");
    return sendJson(res, 200, { name, markdown: text, placeholder: isPlaceholder(text) });
  }
  if (method === "GET" && pathname === "/api/routing") {
    return sendJson(res, 200, { entries: await loadRoutingEntries() });
  }
  if (method === "GET" && pathname === "/api/stream") return handleStream(req, res);
  if (method === "POST" && pathname === "/api/key") return await handleSetKey(req, res);
  if (method === "POST" && pathname === "/api/run") return await handleStartRun(req, res);
  if (method === "POST" && pathname === "/api/stop") return handleStopRun(res);

  if (pathname.startsWith("/api/")) {
    sendError(res, 404, `No such endpoint: ${method} ${pathname}`);
    return;
  }
  if (method !== "GET") {
    sendError(res, 405, "Method not allowed.");
    return;
  }
  await serveStatic(pathname, res);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "Unknown server error.";
    console.error(`[ui] ${req.method ?? "?"} ${req.url ?? "?"} failed: ${message}`);
    if (!res.headersSent) sendError(res, 500, message);
    else res.end();
  });
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`agent-pipeline UI -> http://${BIND_HOST}:${PORT}`);
  console.log("Bound to loopback only. No run starts until you press Start in the UI.");
});

/** Do not leave an orphaned billable child behind when the server is killed. */
function shutdown(): void {
  if (child !== null) child.kill("SIGTERM");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
