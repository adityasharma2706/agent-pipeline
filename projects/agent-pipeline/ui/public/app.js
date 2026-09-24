// agent-pipeline UI — frontend. Plain ES modules-free script, no build step.
//
// Two rules that matter more than the layout:
//   1. Nothing here can start a run except a click on #startRun. There is no
//      poll, timer or load handler that POSTs to /api/run.
//   2. Every piece of text that came from disk (markdown, stage names, console
//      output, routing reasons) is escaped before it reaches innerHTML. The
//      documents are model-generated, so "it would never contain a <script>
//      tag" is not an assumption available to us.

"use strict";

/* ------------------------------------------------------------------ */
/* utilities                                                           */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

/** The single escape used everywhere. Order matters: & first. */
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showError(message) {
  const banner = $("banner");
  banner.textContent = message;
  banner.classList.remove("hidden");
}

function clearError() {
  $("banner").classList.add("hidden");
}

/** fetch + JSON with server-reported errors surfaced in the UI, not the console. */
async function api(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    showError(`Cannot reach the UI server at ${location.host}. Is \`npm start\` still running?`);
    throw new Error("network");
  }
  let body = {};
  try {
    body = await response.json();
  } catch {
    /* non-JSON response; handled below */
  }
  if (!response.ok) {
    const message = body && body.error ? body.error : `${response.status} ${response.statusText}`;
    showError(message);
    throw new Error(message);
  }
  clearError();
  return body;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function formatWhen(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/* ------------------------------------------------------------------ */
/* markdown — deliberately small, and escape-first                     */
/* ------------------------------------------------------------------ */

/**
 * Handles the subset the pipeline's documents actually use: ATX headings,
 * fenced and indented code, unordered/ordered lists, pipe tables, blockquotes,
 * horizontal rules, paragraphs, and inline code/bold/italic/links.
 *
 * Every line is escaped BEFORE any tag is produced, so document content can
 * only ever become text. Link hrefs are additionally scheme-checked, because
 * an escaped `javascript:` URL is still a live javascript: URL.
 */
function renderMarkdown(source) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;

  const inline = (text) => {
    let s = esc(text);
    // Code spans first: their contents must not be re-interpreted as emphasis.
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, label, href) =>
      /^(https?:|#|\.{0,2}\/)/i.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : whole
    );
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
  };

  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const splitRow = (line) =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i += 1; continue; }

    // fenced code
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push("<hr />"); i += 1; continue; }

    // heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // table: a pipe row followed by a --- separator row
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(splitRow(lines[i])); i += 1; }
      const head = header.map((cell) => `<th>${inline(cell)}</th>`).join("");
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }

    // lists (one level; nesting is flattened rather than mis-parsed)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "")));
        i += 1;
        // continuation lines of the same item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items[items.length - 1] += ` ${inline(lines[i].trim())}`;
          i += 1;
        }
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
      continue;
    }

    // paragraph
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*(#{1,6}\s|```|>|[-*+]\s|\d+\.\s|\|)/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length > 0) out.push(`<p>${inline(para.join(" "))}</p>`);
    else i += 1;
  }

  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* tabs                                                                */
/* ------------------------------------------------------------------ */

function selectTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("active", panel.id === `tab-${name}`);
  }
  location.hash = name;
  if (name === "artifacts") loadArtifacts();
  if (name === "routing") loadRouting();
  if (name === "dashboard") loadStatus();
}

/* ------------------------------------------------------------------ */
/* dashboard                                                           */
/* ------------------------------------------------------------------ */

const STATUS_LABEL = {
  success: "success",
  failure: "failure",
  partial: "partial",
  "in-progress": "running",
  pending: "pending",
};

function renderStages(status) {
  const list = $("stageList");
  list.innerHTML = status.stages
    .map((stage, index) => {
      const blocked = !stage.implemented;
      const classes = ["stage", stage.status, blocked ? "blocked" : ""].filter(Boolean).join(" ");
      const label = blocked && stage.status === "pending" ? "blocked" : STATUS_LABEL[stage.status];
      const attempts = stage.attempts > 1 ? `${stage.attempts} attempts` : "";
      const retries = stage.retries > 0 ? `${stage.retries} retr${stage.retries === 1 ? "y" : "ies"}` : "";
      const sub = [attempts, retries, stage.finishedAt ? `last: ${formatWhen(stage.finishedAt)}` : ""]
        .filter(Boolean)
        .join(" · ");
      const reason = stage.notImplementedReason
        ? `<p class="blocked-reason">${esc(stage.notImplementedReason)}</p>`
        : blocked
          ? `<p class="blocked-reason">Not implemented in this build. The last implemented stage is "${esc(status.lastImplementedStage)}".</p>`
          : "";
      return `<li class="${classes}">
        <span class="idx">${index + 1}</span>
        <span class="name">${esc(stage.stage)}${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</span>
        <span class="timing">${esc(formatDuration(stage.durationMs))}</span>
        <span class="stage-status">${esc(label)}</span>
        ${reason}
      </li>`;
    })
    .join("");

  const done = status.stages.filter((s) => s.status === "success").length;
  $("dashboardSummary").textContent = status.hasRunState
    ? `${done} of ${status.stages.length} stages complete · last successful stage: ${status.currentStage ?? "none yet"} · go-backs used: ${status.goBacksUsed}`
    : "No state/run.json yet — nothing has run. Run ./setup.sh, or just start a run from the Run tab.";
  if (status.stateError) showError(status.stateError);
}

function renderWorkspace(workspace) {
  const box = $("workspaceBox");
  if (!workspace.exists || workspace.modules.length === 0) {
    box.innerHTML = `<div class="empty">
      No workspace progress ledger yet at <code>${esc(workspace.root)}/pipeline-progress.json</code>.
      It appears once the spec-implementer stage builds its first module.
    </div>`;
    return;
  }

  const total = workspace.totalModules;
  const pct = total ? Math.round((workspace.built / total) * 100) : 0;
  const cost = workspace.modules.reduce((sum, m) => sum + m.costUsd, 0);

  const rows = workspace.modules
    .map(
      (m) => `<tr>
        <td><code>${esc(m.moduleId)}</code></td>
        <td>${esc(m.title)}${m.failureReason ? `<div class="muted">${esc(m.failureReason)}</div>` : ""}</td>
        <td>${esc(m.outcome)}</td>
        <td><div class="reqs">${m.reqsClaimed.map((r) => `<span class="req">${esc(r)}</span>`).join("") || '<span class="muted">none</span>'}</div></td>
        <td>${m.filesWritten}</td>
        <td>$${m.costUsd.toFixed(4)}</td>
      </tr>`
    )
    .join("");

  box.innerHTML = `
    <div class="cards">
      <div class="card"><div class="k">Modules built</div><div class="v">${workspace.built}${total ? ` of ${total}` : ""}</div></div>
      <div class="card"><div class="k">Failed attempts</div><div class="v">${workspace.failed}</div></div>
      <div class="card"><div class="k">Spend recorded</div><div class="v">$${cost.toFixed(2)}</div></div>
    </div>
    ${total ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ""}
    <p class="hint">Workspace: <code>${esc(workspace.root)}</code></p>
    <table>
      <thead><tr><th>Module</th><th>Title</th><th>Outcome</th><th>REQs claimed</th><th>Files</th><th>Cost</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderAuth(auth) {
  const pill = $("authPill");
  pill.textContent = auth.configured
    ? `key set (${auth.source === "env-file" ? ".env" : "env var"})`
    : "no key — CLI login";
  pill.className = `pill ${auth.configured ? "ok" : "warn"}`;
  $("authDetail").textContent = auth.detail;
}

let lastRunView = null;

function renderRun(run) {
  lastRunView = run;
  const pill = $("runPill");
  pill.textContent = run.running ? "run in progress" : run.finishedAt ? `exited ${run.exitCode ?? 0}` : "idle";
  pill.className = `pill ${run.running ? "live" : ""}`;
  $("startRun").disabled = run.running;
  $("stopRun").disabled = !run.running;
  $("costReadout").textContent = `$${(run.costUsd ?? 0).toFixed(4)}`;
}

async function loadStatus() {
  try {
    const status = await api("/api/status");
    $("projectRoot").textContent = status.projectRoot;
    renderStages(status);
    renderWorkspace(status.workspace);
    renderAuth(status.auth);
    renderRun(status.run);
  } catch {
    /* already surfaced in the banner */
  }
}

/* ------------------------------------------------------------------ */
/* artifacts                                                           */
/* ------------------------------------------------------------------ */

let selectedArtifact = null;

async function loadArtifacts() {
  let data;
  try {
    data = await api("/api/artifacts");
  } catch {
    return;
  }
  const list = $("artifactList");
  if (data.artifacts.length === 0) {
    list.innerHTML = '<li class="muted">No .md files in docs/.</li>';
    return;
  }
  list.innerHTML = data.artifacts
    .map(
      (a) => `<li><button data-name="${esc(a.name)}" class="${a.name === selectedArtifact ? "active" : ""}">
        ${esc(a.name)}${a.placeholder ? ' <span class="tag">placeholder</span>' : ""}
        <span class="meta">${formatBytes(a.sizeBytes)} · ${esc(formatWhen(a.modifiedAt))}</span>
      </button></li>`
    )
    .join("");

  for (const button of list.querySelectorAll("button")) {
    button.addEventListener("click", () => openArtifact(button.dataset.name));
  }
  if (selectedArtifact === null) openArtifact(data.artifacts[0].name);
}

async function openArtifact(name) {
  selectedArtifact = name;
  for (const button of $("artifactList").querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.name === name);
  }
  let data;
  try {
    data = await api(`/api/artifact?name=${encodeURIComponent(name)}`);
  } catch {
    return;
  }
  $("artifactView").innerHTML = data.placeholder
    ? `<div class="empty">${esc(name)} is still a placeholder — the stage that writes it has not run yet.</div>`
    : renderMarkdown(data.markdown);
  $("artifactView").scrollTop = 0;
}

/* ------------------------------------------------------------------ */
/* routing log                                                         */
/* ------------------------------------------------------------------ */

async function loadRouting() {
  let data;
  try {
    data = await api("/api/routing");
  } catch {
    return;
  }
  const box = $("routingList");
  if (data.entries.length === 0) {
    box.innerHTML = `<div class="empty">
      No routing decisions yet. state/routing.jsonl is written the first time the reviewer stage
      completes and the feedback-router runs.
    </div>`;
    return;
  }
  box.innerHTML = data.entries
    .map((entry) => {
      const outcome = entry.enacted ? "enacted" : entry.outcome || "deferred";
      return `<div class="rd ${esc(outcome)}">
        <div class="rd-head">
          <span class="rd-id">${esc(entry.id)}</span>
          <span class="rd-arrow">→</span>
          <strong>${esc(entry.target_stage)}</strong>
          <span class="stage-status">${esc(outcome)}</span>
          <span class="pill">confidence: ${esc(entry.confidence ?? "?")}</span>
          <span class="pill">${esc(entry.priority ?? "?")} priority</span>
          <span class="muted">${esc(formatWhen(entry.ts))}</span>
        </div>
        <dl>
          <dt>Reason</dt><dd>${esc(entry.reason ?? "")}</dd>
          <dt>Confidence why</dt><dd>${esc(entry.confidence_reason ?? "")}</dd>
          <dt>Evidence</dt><dd>${esc((entry.evidence || []).join("; ")) || "—"}</dd>
          <dt>Findings</dt><dd>${esc((entry.finding_ids || []).join(", ")) || "—"}</dd>
          <dt>Gate</dt><dd>${esc(entry.gate ?? "")}</dd>
          ${entry.escalation ? `<dt>Escalated because</dt><dd>${esc(entry.escalation)}</dd>` : ""}
          <dt>Estimate</dt><dd>$${Number(entry.estimate_usd ?? 0).toFixed(2)} (budget left $${Number(entry.remaining_usd ?? 0).toFixed(2)}, go-backs used ${esc(entry.go_backs_used ?? 0)})</dd>
        </dl>
      </div>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ */
/* run control + SSE                                                   */
/* ------------------------------------------------------------------ */

const consoleEl = () => $("console");

function appendLine(line) {
  const box = consoleEl();
  const idle = box.querySelector(".idle");
  if (idle) idle.remove();
  const span = document.createElement("span");
  span.className = line.stream;
  span.textContent = `${line.text}\n`;
  box.appendChild(span);
  if ($("autoscroll").checked) box.scrollTop = box.scrollHeight;
}

function connectStream() {
  const source = new EventSource("/api/stream");
  source.addEventListener("line", (event) => appendLine(JSON.parse(event.data)));
  source.addEventListener("run", (event) => {
    const run = JSON.parse(event.data);
    const wasRunning = lastRunView && lastRunView.running;
    renderRun(run);
    // A finished run changed state/run.json and probably docs/ — refresh once.
    if (wasRunning && !run.running) {
      loadStatus();
      loadArtifacts();
      loadRouting();
    }
  });
  source.onerror = () => {
    // EventSource reconnects on its own; say so rather than silently stalling.
    $("runPill").textContent = "stream reconnecting…";
  };
}

async function startRun() {
  const idea = $("idea").value.trim();
  const confirmed = confirm(
    idea.length > 0
      ? "Start a new pipeline run?\n\nThis calls the Anthropic API and spends real money (up to the orchestrator's $25 run cap). It will also overwrite docs/idea.md."
      : "Resume the existing run?\n\nThis calls the Anthropic API and spends real money (up to the orchestrator's $25 run cap)."
  );
  if (!confirmed) return;

  consoleEl().innerHTML = "";
  try {
    const result = await api("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idea,
        maxModules: Number($("maxModules").value),
        maxGoBacks: Number($("maxGoBacks").value),
      }),
    });
    renderRun(result.run);
  } catch {
    /* surfaced in the banner */
  }
}

async function stopRun() {
  try {
    await api("/api/stop", { method: "POST" });
  } catch {
    /* surfaced in the banner */
  }
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */


async function saveKey() {
  const input = $("apiKey");
  const key = input.value.trim();
  if (key.length === 0) {
    showError("Enter a key first.");
    return;
  }
  try {
    const result = await api("/api/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    // Clear immediately: the value never needs to sit in the DOM after this,
    // and the server will never send it back to repopulate the field.
    input.value = "";
    renderAuth(result.auth);
    const detail = $("authDetail");
    detail.textContent = `Saved to .env (mode 0600). ${result.auth.detail}`;
  } catch {
    /* surfaced in the banner */
  }
}

/* ------------------------------------------------------------------ */
/* boot — reads only. Nothing here starts a run.                       */
/* ------------------------------------------------------------------ */

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
}
$("refreshDashboard").addEventListener("click", loadStatus);
$("refreshArtifacts").addEventListener("click", loadArtifacts);
$("refreshRouting").addEventListener("click", loadRouting);
$("startRun").addEventListener("click", startRun);
$("stopRun").addEventListener("click", stopRun);
$("saveKey").addEventListener("click", saveKey);
$("apiKey").addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveKey();
});
consoleEl().innerHTML = '<span class="idle">No run yet. Output appears here live once you start one.</span>';
selectTab((location.hash || "#dashboard").slice(1));
loadStatus();
connectStream();
// Cheap periodic refresh of the dashboard while a run is in flight.
setInterval(() => {
  if (lastRunView && lastRunView.running) loadStatus();
}, 10000);
