// Webview frontend for Claudex Council. Talks to the extension host via
// vscode.postMessage; renders bubbles in a chat thread; handles prompt
// composition, image attachment, live streaming chunks, rotating creative
// verbs while agents are working, and per-agent + total elapsed timings.

(function () {
  const vscode = acquireVsCodeApi();

  const transcriptEl = document.getElementById("transcript");
  const emptyStateEl = document.getElementById("emptyState");
  const promptEl = document.getElementById("prompt");
  const sendBtn = document.getElementById("sendBtn");
  const stopBtn = document.getElementById("stopBtn");
  const attachBtn = document.getElementById("attachBtn");
  const fileInput = document.getElementById("fileInput");
  const attachmentsEl = document.getElementById("attachments");
  const modelBarEl = document.getElementById("modelBar");
  const resetBtn = document.getElementById("resetModels");
  const refreshBtn = document.getElementById("refreshCatalog");
  const probeBannerEl = document.getElementById("probeBanner");

  /** @type {{ name: string, dataUri: string }[]} */
  let pendingAttachments = [];

  /** Map of (turnId|agent|role) -> bubble body element, so streamed chunks
   * append to the right bubble instead of opening a new one each time. */
  const openBubbles = new Map();
  /** Map of turnId -> Council activity card. */
  const activityCards = new Map();

  // ----- Agent display ------------------------------------------------

  const AGENT_LABELS = {
    user: "You",
    planner: "Coordinator",
    decider: "Council",
    claude: "Claude lane",
    codex: "Codex lane",
  };

  const ROLE_LABELS = {
    plan: "plan",
    work: "work",
    review: "deliberation",
    synthesis: "answer",
  };

  // Distinct verb sets so no two agents say the same word simultaneously.
  // The Council is the unified default voice. Coordinator, Claude lane,
  // and Codex lane still exist in expanded visibility modes.
  const VERBS = {
    planner: [
      "Routing",
      "Scoping",
      "Briefing",
      "Sequencing",
      "Dispatching",
      "Prioritizing",
      "Framing",
      "Sizing",
    ],
    decider: [
      "Coordinating",
      "Checking context",
      "Splitting work",
      "Comparing answers",
      "Merging notes",
      "Resolving blockers",
      "Preparing reply",
      "Keeping state",
    ],
    claude: [
      "Steeping",
      "Brewing",
      "Conjuring",
      "Wrangling",
      "Untangling",
      "Threading",
      "Knitting",
      "Distilling",
      "Whittling",
      "Crafting",
      "Sculpting",
      "Weaving",
      "Smelting",
    ],
    codex: [
      "Iterating",
      "Annealing",
      "Backtracking",
      "Beam-searching",
      "Vectorizing",
      "Permuting",
      "Lattice-walking",
      "Decoding",
      "Formalizing",
      "Optimizing",
      "Stochastic-stepping",
      "Token-grinding",
      "Embedding",
      "Backpropagating",
      "Compiling",
    ],
  };

  // Rotate verb every ~1.6s, refresh elapsed counter every ~250ms (smooth-ish
  // without burning CPU). Each running bubble gets its own ticker handle so
  // multiple bubbles can rotate independently.
  const VERB_ROTATE_MS = 1600;
  const COUNTER_TICK_MS = 250;
  /** @type {Map<HTMLElement, {verbTimer:number, counterTimer:number, startedAt:number, verbIdx:number}>} */
  const tickerHandles = new Map();

  function pickVerb(agent, idx) {
    const list = VERBS[agent] || ["Working"];
    return list[idx % list.length];
  }

  function startTicker(bubble, agent) {
    if (!bubble || tickerHandles.has(bubble)) return;
    const verbEl = bubble.querySelector('[data-verb="true"]');
    const counterEl = bubble.querySelector('[data-counter="true"]');
    if (!verbEl || !counterEl) return;

    let verbIdx = Math.floor(Math.random() * (VERBS[agent]?.length || 1));
    const startedAt = Date.now();
    verbEl.textContent = pickVerb(agent, verbIdx);
    counterEl.textContent = "0s";

    const verbTimer = setInterval(() => {
      verbIdx += 1;
      verbEl.textContent = pickVerb(agent, verbIdx);
    }, VERB_ROTATE_MS);

    const counterTimer = setInterval(() => {
      const sec = (Date.now() - startedAt) / 1000;
      counterEl.textContent = sec < 10 ? sec.toFixed(1) + "s" : Math.round(sec) + "s";
    }, COUNTER_TICK_MS);

    tickerHandles.set(bubble, { verbTimer, counterTimer, startedAt, verbIdx });
  }

  function stopTicker(bubble, finalElapsedMs, usage) {
    if (!bubble) return;
    const handle = tickerHandles.get(bubble);
    if (handle) {
      clearInterval(handle.verbTimer);
      clearInterval(handle.counterTimer);
      tickerHandles.delete(bubble);
    }
    const verbEl = bubble.querySelector('[data-verb="true"]');
    const counterEl = bubble.querySelector('[data-counter="true"]');
    if (verbEl) verbEl.textContent = "";
    if (counterEl) {
      const ms =
        typeof finalElapsedMs === "number"
          ? finalElapsedMs
          : handle
          ? Date.now() - handle.startedAt
          : null;
      const elapsed = ms != null ? formatElapsed(ms) : "";
      const usageText = formatUsage(usage);
      counterEl.textContent = [elapsed, usageText].filter(Boolean).join(" · ");
      if (usageText) counterEl.title = usageTitle(usage);
    }
  }

  function formatElapsed(ms) {
    if (ms < 1000) return ms + "ms";
    const sec = ms / 1000;
    if (sec < 60) return sec.toFixed(sec < 10 ? 1 : 0) + "s";
    const min = Math.floor(sec / 60);
    const rem = Math.round(sec - min * 60);
    return `${min}m${rem.toString().padStart(2, "0")}s`;
  }

  function formatUsage(usage) {
    if (!usage || typeof usage !== "object") return "";
    const parts = [];
    if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
      parts.push(`${compactNumber(usage.inputTokens || 0)} in/${compactNumber(usage.outputTokens || 0)} out`);
    }
    const cache =
      (typeof usage.cacheCreationInputTokens === "number" ? usage.cacheCreationInputTokens : 0) +
      (typeof usage.cacheReadInputTokens === "number" ? usage.cacheReadInputTokens : 0);
    if (cache > 0) parts.push(`${compactNumber(cache)} cache`);
    if (typeof usage.reasoningOutputTokens === "number" && usage.reasoningOutputTokens > 0) {
      parts.push(`${compactNumber(usage.reasoningOutputTokens)} reason`);
    }
    if (typeof usage.totalCostUsd === "number" && usage.totalCostUsd > 0) {
      parts.push(formatUsd(usage.totalCostUsd));
    }
    return parts.join(" · ");
  }

  function usageTitle(usage) {
    if (!usage || typeof usage !== "object") return "";
    const rows = [];
    if (typeof usage.inputTokens === "number") rows.push(`Input tokens: ${usage.inputTokens}`);
    if (typeof usage.outputTokens === "number") rows.push(`Output tokens: ${usage.outputTokens}`);
    if (typeof usage.cacheCreationInputTokens === "number") rows.push(`Cache creation tokens: ${usage.cacheCreationInputTokens}`);
    if (typeof usage.cacheReadInputTokens === "number") rows.push(`Cache read tokens: ${usage.cacheReadInputTokens}`);
    if (typeof usage.reasoningOutputTokens === "number") rows.push(`Reasoning output tokens: ${usage.reasoningOutputTokens}`);
    if (typeof usage.totalCostUsd === "number") rows.push(`Estimated cost: ${formatUsd(usage.totalCostUsd)}`);
    return rows.join("\n");
  }

  function compactNumber(n) {
    if (!Number.isFinite(n)) return "0";
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + "m";
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
    return String(Math.round(n));
  }

  function formatUsd(n) {
    if (n < 0.01) return "$" + n.toFixed(4);
    if (n < 1) return "$" + n.toFixed(3);
    return "$" + n.toFixed(2);
  }

  // ----- Bubble rendering ---------------------------------------------

  function bubbleKey(turnId, agent, role) {
    return `${turnId}::${agent}::${role}`;
  }

  function ensureBubble(turnId, agent, role, attachments) {
    const key = bubbleKey(turnId, agent, role);
    let body = openBubbles.get(key);
    if (body) return body;

    if (emptyStateEl && emptyStateEl.parentNode) {
      emptyStateEl.remove();
    }

    const bubble = document.createElement("div");
    bubble.className = `bubble ${agent}`;
    bubble.dataset.turnId = turnId;
    bubble.dataset.agent = agent;
    bubble.dataset.role = role;

    if (agent !== "user") {
      const header = document.createElement("div");
      header.className = "bubble-header";

      const dot = document.createElement("span");
      dot.className = `dot dot-${agent}`;
      header.appendChild(dot);

      const label = document.createElement("span");
      label.className = "agent-name";
      label.textContent = AGENT_LABELS[agent] || agent;
      header.appendChild(label);

      if (role && ROLE_LABELS[role] && role !== "work") {
        const roleTag = document.createElement("span");
        roleTag.className = "role-tag";
        roleTag.textContent = ROLE_LABELS[role];
        header.appendChild(roleTag);
      }

      // Model badge — shows which model is powering this bubble. Updated
      // by `agent-model` events; starts blank and gets filled in once the
      // orchestrator emits the configured value (or the resolved value from
      // the stream). Click to show a tooltip-style note in console for now.
      const model = document.createElement("span");
      model.className = "agent-model";
      model.dataset.model = "true";
      model.title = "Model powering this call";
      header.appendChild(model);

      // Live verb (rotates while running, blanks when settled).
      const verb = document.createElement("span");
      verb.className = "agent-verb";
      verb.dataset.verb = "true";
      header.appendChild(verb);

      // Live counter (live tick while running, final elapsed when settled).
      const counter = document.createElement("span");
      counter.className = "agent-counter";
      counter.dataset.counter = "true";
      header.appendChild(counter);

      const spinner = document.createElement("span");
      spinner.className = "spinner";
      spinner.dataset.spinner = "true";
      header.appendChild(spinner);

      bubble.appendChild(header);
    }

    body = document.createElement("div");
    body.className = "bubble-body";
    bubble.appendChild(body);

    if (attachments && attachments.length) {
      const attachWrap = document.createElement("div");
      attachWrap.className = "bubble-attachments";
      for (const att of attachments) {
        const img = document.createElement("img");
        img.src = att.dataUri;
        img.alt = att.name || "attachment";
        attachWrap.appendChild(img);
      }
      bubble.appendChild(attachWrap);
    }

    transcriptEl.appendChild(bubble);
    openBubbles.set(key, body);
    scrollToBottom();
    return body;
  }

  function setBubbleStatus(turnId, agent, status, role) {
    if (agent === "user") return;
    let bubbles = getTurnAgentBubbles(turnId, agent);
    if (role) {
      bubbles = bubbles.filter((bubble) => bubble.dataset.role === role);
    }
    if (!bubbles.length && (status === "running" || status === "thinking")) {
      const body = ensureBubble(
        turnId,
        agent,
        role || (agent === "decider" ? "synthesis" : agent === "planner" ? "plan" : "work")
      );
      if (body.parentElement) bubbles = [body.parentElement];
    }
    if (!bubbles.length) return;

    const terminal = status === "done" || status === "failed";
    const targets = terminal ? bubbles : [bubbles[bubbles.length - 1]];
    for (const bubble of targets) {
      bubble.dataset.status = status;
      const spinner = bubble.querySelector('[data-spinner="true"]');
      if (spinner) spinner.style.display = terminal ? "none" : "";
      if (terminal) {
        stopTicker(bubble);
      } else {
        startTicker(bubble, agent);
      }
    }
  }

  function hasRunningBubbles() {
    return Array.from(transcriptEl.querySelectorAll(".bubble")).some((bubble) => {
      return bubble.dataset.status === "running" || bubble.dataset.status === "thinking";
    });
  }

  function setStopVisible(visible) {
    if (stopBtn) stopBtn.hidden = !visible;
  }

  function stopAllRunningBubbles() {
    for (const bubble of tickerHandles.keys()) stopTicker(bubble);
    for (const bubble of transcriptEl.querySelectorAll(".bubble")) {
      if (bubble.dataset.status === "running" || bubble.dataset.status === "thinking") {
        bubble.dataset.status = "done";
      }
      const spinner = bubble.querySelector('[data-spinner="true"]');
      if (spinner) spinner.style.display = "none";
    }
  }

  function getTurnAgentBubbles(turnId, agent) {
    return Array.from(transcriptEl.querySelectorAll(".bubble")).filter(
      (bubble) => bubble.dataset.turnId === turnId && bubble.dataset.agent === agent
    );
  }

  function appendChunk(turnId, agent, role, text) {
    const body = ensureBubble(turnId, agent, role);
    body.dataset.raw = (body.dataset.raw || "") + text;
    body.innerHTML = renderMarkdown(body.dataset.raw);
    // First real text means streaming has begun — drop the rotating verb so
    // the user sees content, not "Annealing..." over the top of real text.
    const bubble = body.parentElement;
    if (bubble) {
      const verbEl = bubble.querySelector('[data-verb="true"]');
      if (verbEl && verbEl.textContent) verbEl.textContent = "";
    }
    scrollToBottom();
  }

  function setMessage(turnId, agent, role, text, attachments) {
    const body = ensureBubble(turnId, agent, role, attachments);
    body.dataset.raw = text;
    body.innerHTML = renderMarkdown(text);
    // A final message means this bubble is settled — stop the spinner and
    // ticker regardless of whether a corresponding agent-status:done arrives.
    const bubble = body.parentElement;
    if (bubble) {
      const spinner = bubble.querySelector('[data-spinner="true"]');
      if (spinner) spinner.style.display = "none";
      stopTicker(bubble);
    }
    scrollToBottom();
  }

  function applyTiming(turnId, agent, role, elapsedMs, usage) {
    const key = bubbleKey(turnId, agent, role);
    const body = openBubbles.get(key);
    const bubble = body ? body.parentElement : null;
    if (!bubble) return;
    stopTicker(bubble, elapsedMs, usage);
  }

  function applyModel(turnId, agent, role, model) {
    // Lazily create the bubble so the badge can land even if it arrives
    // before any chunk/message (which is the normal case — the orchestrator
    // emits agent-model right after agent-status: running).
    const body = ensureBubble(turnId, agent, role);
    const bubble = body.parentElement;
    if (!bubble) return;
    const modelEl = bubble.querySelector('[data-model="true"]');
    if (!modelEl) return;
    modelEl.textContent = model;
    // Update tooltip too so hover surfaces the full string even when the
    // header truncates it visually.
    modelEl.title = "Model: " + model;
  }

  function appendTurnFooter(turnId, totalMs, agentCount) {
    const footer = document.createElement("div");
    footer.className = "turn-footer";
    footer.dataset.turnId = turnId;
    footer.textContent = `Turn complete · ${formatElapsed(totalMs)} · ${agentCount} agent${
      agentCount === 1 ? "" : "s"
    }`;
    transcriptEl.appendChild(footer);
    scrollToBottom();
  }

  function appendStoppedFooter(turnId, queuedCount) {
    const footer = document.createElement("div");
    footer.className = "turn-footer";
    footer.dataset.turnId = turnId;
    footer.textContent =
      "Turn stopped" + (queuedCount > 0 ? ` · ${queuedCount} queued` : "");
    transcriptEl.appendChild(footer);
    scrollToBottom();
  }

  function renderCouncilActivity(msg) {
    if (!msg || !msg.turnId) return;
    if (emptyStateEl && emptyStateEl.parentNode) emptyStateEl.remove();

    let card = activityCards.get(msg.turnId);
    if (!card) {
      card = document.createElement("section");
      card.className = "activity-card";
      card.dataset.turnId = msg.turnId;
      transcriptEl.appendChild(card);
      activityCards.set(msg.turnId, card);
    }
    card.dataset.phase = msg.phase || "";
    card.innerHTML = "";

    const header = document.createElement("div");
    header.className = "activity-header";

    const titleWrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "activity-title";
    title.textContent = "Council activity";
    const phase = document.createElement("div");
    phase.className = "activity-phase";
    phase.textContent = msg.phase || "Working";
    titleWrap.appendChild(title);
    titleWrap.appendChild(phase);
    header.appendChild(titleWrap);

    const context = document.createElement("div");
    context.className = "activity-context";
    context.textContent = formatContextUsage(msg.context);
    context.title = contextTitle(msg.context);
    header.appendChild(context);
    card.appendChild(header);

    if (msg.summary) {
      const summary = document.createElement("div");
      summary.className = "activity-summary";
      summary.textContent = msg.summary;
      card.appendChild(summary);
    }

    const lanes = document.createElement("div");
    lanes.className = "activity-lanes";
    for (const lane of msg.lanes || []) {
      lanes.appendChild(renderActivityLane(lane));
    }
    card.appendChild(lanes);
    scrollToBottom();
  }

  function renderActivityLane(lane) {
    const laneEl = document.createElement("article");
    laneEl.className = `activity-lane lane-${lane.agent || "unknown"} status-${lane.status || "queued"}`;

    const top = document.createElement("div");
    top.className = "activity-lane-top";

    const name = document.createElement("div");
    name.className = "activity-lane-name";
    const dot = document.createElement("span");
    dot.className = `dot dot-${lane.agent || "decider"}`;
    name.appendChild(dot);
    const label = document.createElement("span");
    label.textContent = lane.title || lane.agent || "Lane";
    name.appendChild(label);
    top.appendChild(name);

    const status = document.createElement("span");
    status.className = "activity-status";
    status.textContent = statusLabel(lane.status);
    top.appendChild(status);
    laneEl.appendChild(top);

    const mission = document.createElement("div");
    mission.className = "activity-mission";
    mission.textContent = lane.mission || "Assigned lane";
    laneEl.appendChild(mission);

    const meta = document.createElement("div");
    meta.className = "activity-meta";
    if (lane.model) {
      const model = document.createElement("span");
      model.textContent = lane.model;
      model.title = lane.modelReason || "Model selected for this lane";
      meta.appendChild(model);
    }
    const usage = formatUsage(lane.usage);
    if (usage) {
      const usageEl = document.createElement("span");
      usageEl.textContent = usage;
      usageEl.title = usageTitle(lane.usage);
      meta.appendChild(usageEl);
    }
    if (lane.note) {
      const note = document.createElement("span");
      note.textContent = lane.note;
      meta.appendChild(note);
    }
    if (meta.childNodes.length) laneEl.appendChild(meta);

    const progress = document.createElement("div");
    progress.className = "activity-progress";
    const bar = document.createElement("div");
    bar.style.width = `${Math.max(0, Math.min(100, lane.progress || 0))}%`;
    progress.appendChild(bar);
    laneEl.appendChild(progress);

    const steps = document.createElement("ol");
    steps.className = "activity-steps";
    for (const step of lane.steps || []) {
      const item = document.createElement("li");
      item.className = `step-${step.status || "pending"}`;
      item.textContent = step.label || "";
      steps.appendChild(item);
    }
    laneEl.appendChild(steps);
    return laneEl;
  }

  function statusLabel(status) {
    switch (status) {
      case "planning": return "Planning";
      case "queued": return "Queued";
      case "running": return "Working";
      case "done": return "Done";
      case "limited": return "Limited";
      case "failed": return "Failed";
      case "skipped": return "Skipped";
      default: return "Working";
    }
  }

  function formatContextUsage(context) {
    if (!context || typeof context !== "object") return "Context ready";
    const used = compactNumber(context.usedChars || 0);
    const max = compactNumber(context.maxChars || 0);
    const pct = typeof context.percent === "number" ? `${context.percent}%` : "";
    const compacted = context.compacted ? " · compacted" : "";
    return `Session context ${used}/${max} chars${pct ? ` · ${pct}` : ""}${compacted}`;
  }

  function contextTitle(context) {
    if (!context || typeof context !== "object") return "";
    return [
      `Session context characters sent: ${context.usedChars || 0}`,
      `Configured context budget: ${context.maxChars || 0}`,
      context.compacted ? "Older turns were compacted/omitted for this prompt." : "No compaction needed for this prompt.",
    ].join("\n");
  }

  function scrollToBottom() {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  // ----- Tiny markdown renderer ---------------------------------------

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderMarkdown(src) {
    const codeBlocks = [];
    let s = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, body) => {
      const idx =
        codeBlocks.push(
          `<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(body)}</code></pre>`
        ) - 1;
      return ` CODEBLOCK${idx} `;
    });
    s = escapeHtml(s);
    s = s.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|\W)\*([^*\n]+)\*(\W|$)/g, "$1<em>$2</em>$3");
    s = s.replace(/_([^_\n]+)_/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, h) => `<a href="${escapeHtml(h)}">${t}</a>`);
    s = s.replace(/\n/g, "<br>");
    s = s.replace(/ CODEBLOCK(\d+) /g, (_m, i) => codeBlocks[Number(i)]);
    return s;
  }

  // ----- Composer -----------------------------------------------------

  function autoGrowTextarea() {
    promptEl.style.height = "auto";
    promptEl.style.height = Math.min(promptEl.scrollHeight, 200) + "px";
  }
  promptEl.addEventListener("input", autoGrowTextarea);

  promptEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitPrompt();
    }
  });

  sendBtn.addEventListener("click", submitPrompt);
  if (stopBtn) {
    stopBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "cancel" });
      setStopVisible(false);
      stopAllRunningBubbles();
    });
  }

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    addAttachments(files);
    fileInput.value = "";
  });

  // Paste images into the prompt
  promptEl.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f && f.type.startsWith("image/")) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addAttachments(files);
    }
  });

  // Drag-drop images on the whole panel
  document.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
    }
  });
  document.addEventListener("drop", (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length) {
      e.preventDefault();
      addAttachments(files);
    }
  });

  function addAttachments(files) {
    const readers = files.map(
      (f) =>
        new Promise((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve({ name: f.name, dataUri: String(r.result) });
          r.readAsDataURL(f);
        })
    );
    Promise.all(readers).then((newOnes) => {
      pendingAttachments.push(...newOnes);
      renderAttachments();
    });
  }

  function renderAttachments() {
    if (!pendingAttachments.length) {
      attachmentsEl.hidden = true;
      attachmentsEl.innerHTML = "";
      return;
    }
    attachmentsEl.hidden = false;
    attachmentsEl.innerHTML = "";
    pendingAttachments.forEach((att, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "attachment-thumb";
      const img = document.createElement("img");
      img.src = att.dataUri;
      img.alt = att.name;
      wrap.appendChild(img);
      const x = document.createElement("button");
      x.className = "remove-x";
      x.type = "button";
      x.textContent = "×";
      x.title = `Remove ${att.name}`;
      x.addEventListener("click", () => {
        pendingAttachments.splice(idx, 1);
        renderAttachments();
      });
      wrap.appendChild(x);
      attachmentsEl.appendChild(wrap);
    });
  }

  function submitPrompt() {
    const text = promptEl.value.trim();
    if (!text && !pendingAttachments.length) return;
    vscode.postMessage({
      type: "submit-prompt",
      prompt: text,
      attachments: pendingAttachments,
    });
    promptEl.value = "";
    autoGrowTextarea();
    pendingAttachments = [];
    renderAttachments();
    promptEl.focus();
  }

  // ----- Inbound messages from extension ------------------------------

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "clear":
        // Stop every running ticker, then wipe the transcript.
        for (const bubble of tickerHandles.keys()) stopTicker(bubble);
        setStopVisible(false);
        transcriptEl.innerHTML = "";
        openBubbles.clear();
        activityCards.clear();
        if (emptyStateEl) transcriptEl.appendChild(emptyStateEl);
        break;
      case "turn-started":
        setStopVisible(true);
        // Reserved — could insert a divider or per-turn header here.
        break;
      case "turn-finished":
        appendTurnFooter(msg.turnId, msg.totalMs ?? 0, msg.agentCount ?? 0);
        setStopVisible(false);
        break;
      case "turn-cancelled":
        stopAllRunningBubbles();
        appendStoppedFooter(msg.turnId, msg.queuedCount || 0);
        setStopVisible(false);
        break;
      case "council-activity":
        renderCouncilActivity(msg);
        break;
      case "agent-message":
        setMessage(msg.turnId, msg.agent, msg.role, msg.content, msg.attachments);
        break;
      case "agent-chunk":
        appendChunk(msg.turnId, msg.agent, msg.role, msg.content);
        break;
      case "agent-status":
        setBubbleStatus(msg.turnId, msg.agent, msg.status, msg.role);
        if (msg.status === "running" || msg.status === "thinking") {
          setStopVisible(true);
        } else if (!hasRunningBubbles()) {
          setStopVisible(false);
        }
        break;
      case "agent-timing":
        applyTiming(msg.turnId, msg.agent, msg.role, msg.elapsedMs, msg.usage);
        break;
      case "agent-model":
        applyModel(msg.turnId, msg.agent, msg.role, msg.model);
        break;
      case "restore-bubbles":
        // Session was restored from persisted state on extension activation.
        // Render every saved bubble in original order — model badges and
        // final timings already settled (no spinners, no rotating verbs;
        // these are historical, not live).
        if (Array.isArray(msg.bubbles)) {
          for (const b of msg.bubbles) {
            const role = b.role === "error" ? "synthesis" : b.role;
            setMessage(b.turnId, b.agent, role, b.content || "", b.attachments);
            if (b.model) applyModel(b.turnId, b.agent, role, b.model);
            if (typeof b.elapsedMs === "number") applyTiming(b.turnId, b.agent, role, b.elapsedMs);
          }
        }
        if (Array.isArray(msg.turns)) {
          for (const t of msg.turns) {
            if (typeof t.totalMs === "number") {
              appendTurnFooter(t.turnId, t.totalMs, t.agentCount || 0);
            }
          }
        }
        break;
    }
  });

  // ----- Model picker (top bar) ---------------------------------------

  /**
   * Populate the dropdowns from a catalog payload sent by the
   * extension. Slot 'decider' shows BOTH providers (the synthesizer can be
   * either Claude or Codex). Slots 'planner', 'claudeWorker', and 'codexWorker' are
   * provider-locked. Each <option> embeds the tier and badge so the user
   * sees subscription requirement at a glance.
   */
  function populateModelBar(catalog, current) {
    const slots = ["planner", "claudeWorker", "codexWorker", "decider"];
    for (const slot of slots) {
      const sel = modelBarEl.querySelector(`select[data-slot="${slot}"]`);
      if (!sel) continue;
      sel.innerHTML = "";

      let options;
      if (slot === "planner" || slot === "claudeWorker") {
        options = catalog.filter((m) => m.provider === "claude");
      } else if (slot === "codexWorker") {
        options = catalog.filter((m) => m.provider === "codex");
      } else {
        options = catalog.slice();
      }

      // Group by provider when the slot mixes both, so users can scan it.
      let lastProvider = null;
      for (const m of options) {
        if (slot === "decider" && m.provider !== lastProvider) {
          const grp = document.createElement("optgroup");
          grp.label = m.provider === "claude" ? "Claude" : "Codex";
          sel.appendChild(grp);
          lastProvider = m.provider;
        }
        const opt = document.createElement("option");
        opt.value = m.id;
        let label = m.label;
        if (m.badge) label += " · " + m.badge;
        if (m.tier && m.tier !== "free" && m.tier !== "pro") {
          label += " · " + m.tier;
        }
        opt.textContent = label;
        if (m.hint) opt.title = m.hint + (m.tier ? `\n(min tier: ${m.tier})` : "");
        const target = slot === "decider" ? sel.lastElementChild : sel;
        target.appendChild(opt);
      }
      if (current && current[slot]) sel.value = current[slot];
    }
  }

  if (modelBarEl) {
    modelBarEl.addEventListener("change", (e) => {
      const target = e.target;
      if (target instanceof HTMLSelectElement && target.dataset.slot) {
        vscode.postMessage({
          type: "set-model",
          slot: target.dataset.slot,
          modelId: target.value,
        });
      }
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "reset-models" });
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "refresh-catalog" });
    });
  }

  // Catalog payload handler — runs whenever the extension pushes a fresh
  // model list (initial load, after Reset, after Refresh, or after a
  // probe completes). Updates the dropdowns AND the cache-status banner.
  function handleModelCatalog(msg) {
    if (Array.isArray(msg.catalog)) {
      populateModelBar(msg.catalog, msg.current || {});
    }
    updateCacheBanner(msg);
  }

  // Probe progress handler — fires while the prober runs through its list
  // of models. We surface a thin banner above the dropdown bar so the
  // user knows the dropdowns will refresh shortly with their actual
  // available models.
  function handleProbeProgress(msg) {
    if (!probeBannerEl) return;
    if (msg.finished) {
      probeBannerEl.hidden = true;
      probeBannerEl.textContent = "";
      return;
    }
    probeBannerEl.hidden = false;
    const pct = msg.total > 0 ? Math.round((msg.done / msg.total) * 100) : 0;
    probeBannerEl.textContent =
      `Probing your account for available models — ${msg.done}/${msg.total} (${pct}%)` +
      (msg.currentId ? ` · ${msg.currentId}` : "");
  }

  function updateCacheBanner(msg) {
    if (!probeBannerEl) return;
    if (msg.cacheStatus === "missing") {
      probeBannerEl.hidden = false;
      probeBannerEl.textContent =
        "Showing full catalog — click ↻ to probe your account so unsupported models get hidden.";
    } else if (msg.cacheStatus === "stale") {
      probeBannerEl.hidden = false;
      probeBannerEl.textContent =
        `Cached availability is older than 7 days. ${msg.probedCount} models cached, ${msg.hiddenCount} hidden. Click ↻ to re-probe.`;
    } else {
      probeBannerEl.hidden = true;
    }
  }

  // Hook the catalog + probe handlers into the existing window message
  // listener. Kept on a separate listener from chat rendering so the
  // model-picker logic stays isolated.
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === "model-catalog") handleModelCatalog(msg);
    else if (msg.type === "probe-progress") handleProbeProgress(msg);
  });

  vscode.postMessage({ type: "ready" });
})();
