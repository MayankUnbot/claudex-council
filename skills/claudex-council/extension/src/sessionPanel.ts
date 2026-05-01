import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Orchestrator, OrchestratorEvent, PromptAttachment, AgentId, BubbleRole, probeClaudeAuth } from "./orchestrator";
import { CATALOG, DEFAULT_SELECTIONS, ModelEntry, ModelSlot } from "./modelCatalog";
import { applyAvailability, readCache, runFullProbe } from "./modelProber";

// ---------- Session persistence types ----------

/**
 * One persisted bubble in a session's transcript. Captured by intercepting
 * the orchestrator's emit callback so we can rebuild the chat thread
 * exactly as the user saw it after a VS Code reload.
 */
interface PersistedBubble {
  turnId: string;
  agent: AgentId;
  role: BubbleRole | "error";
  content: string;
  model?: string;
  elapsedMs?: number;
  attachments?: PromptAttachment[];
}

interface PersistedTurn {
  turnId: string;
  totalMs?: number;
  agentCount?: number;
}

interface PersistedSessionState {
  id: string;
  title: string;
  modelSelections: Record<ModelSlot, string>;
  bubbles: PersistedBubble[];
  turns: PersistedTurn[];
  firstUserMessage: string;
  lastUpdated: number;
}

type OrchestrationVisibility = "final-only" | "answers" | "detailed";

/** workspaceState key prefix for one session's saved state. */
const SESSION_STATE_PREFIX = "claudexCouncil.session.";
/** workspaceState key for the list of session IDs to auto-restore on activation. */
const OPEN_SESSIONS_KEY = "claudexCouncil.openSessions";
const DEFAULT_SESSION_CONTEXT_MAX_CHARS = 48_000;
const DEFAULT_SESSION_CONTEXT_BUBBLE_MAX_CHARS = 3_000;
const SESSION_PERSIST_DEBOUNCE_MS = 400;

export function listPersistedSessionIds(context: vscode.ExtensionContext): string[] {
  return context.workspaceState.get<string[]>(OPEN_SESSIONS_KEY) || [];
}

export function readPersistedSession(
  context: vscode.ExtensionContext,
  id: string
): PersistedSessionState | undefined {
  return context.workspaceState.get<PersistedSessionState>(SESSION_STATE_PREFIX + id);
}

async function deletePersistedSession(
  context: vscode.ExtensionContext,
  id: string
): Promise<void> {
  await context.workspaceState.update(SESSION_STATE_PREFIX + id, undefined);
  const list = listPersistedSessionIds(context).filter((x) => x !== id);
  await context.workspaceState.update(OPEN_SESSIONS_KEY, list);
}

/**
 * One council session = one WebviewPanel (editor tab) + one Orchestrator.
 * Sessions are independent: the user can have many open at once and each
 * has its own conversation history and its own concurrently-running
 * agent processes.
 */
export class SessionPanel {
  public readonly id: string;
  public title: string;
  public readonly panel: vscode.WebviewPanel;
  private readonly orchestrator: Orchestrator;
  private readonly disposables: vscode.Disposable[] = [];
  private firstUserMessage = "";
  /**
   * Per-session model selections. Initialized from the user's persistent
   * settings if any, falling back to DEFAULT_SELECTIONS from modelCatalog.
   * The webview dropdown bar mutates this map; the orchestrator reads from
   * it via the constructor callback so each turn always uses the latest
   * choice without needing to touch VS Code settings on every call.
   */
  private modelSelections: Record<ModelSlot, string>;
  /**
   * The transcript captured turn-by-turn so we can rebuild this session
   * after a VS Code reload. Keyed by turnId+agent+role; for streaming
   * bubbles we accumulate chunks into the bubble's content as they arrive.
   */
  private bubbles = new Map<string, PersistedBubble>();
  private turns = new Map<string, PersistedTurn>();
  /** Insertion order so we render bubbles in the order the user saw them. */
  private bubbleOrder: string[] = [];
  /** When true, this panel was reconstructed from persisted state. */
  private restoredFromState = false;
  private persistTimer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    onDispose: (id: string) => void,
    onTitleChange: () => void,
    savedState?: PersistedSessionState
  ) {
    if (savedState) {
      this.id = savedState.id;
      this.title = savedState.title || "Council";
      this.firstUserMessage = savedState.firstUserMessage || "";
      this.restoredFromState = true;
      // Rebuild the in-memory bubble map / order from the saved transcript.
      for (const b of savedState.bubbles) {
        const key = bubbleKey(b.turnId, b.agent, b.role);
        this.bubbles.set(key, b);
        this.bubbleOrder.push(key);
      }
      for (const t of savedState.turns) this.turns.set(t.turnId, t);
    } else {
      this.id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      this.title = panel.title;
    }
    this.panel = panel;
    this.panel.title = this.title;
    this.modelSelections = {
      ...this.initialSelections(),
      ...(savedState?.modelSelections || {}),
    };

    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "webview"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    this.panel.webview.html = renderWebviewHtml(this.context, this.panel.webview);

    this.orchestrator = new Orchestrator(
      this.context,
      (event: OrchestratorEvent) => {
        // Capture the event for persistence FIRST, then forward to the
        // webview. Persisting before forwarding means a VS Code crash
        // mid-event still leaves the transcript consistent on disk.
        this.captureEventForPersistence(event);
        for (const visibleEvent of this.visibleEvents(event)) {
          this.panel.webview.postMessage(visibleEvent);
        }
      },
      () => this.modelSelections,
      (excludeTurnId?: string) => this.buildSessionContext(excludeTurnId)
    );

    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        switch (msg?.type) {
          case "submit-prompt": {
            const prompt: string = msg.prompt ?? "";
            const attachments: PromptAttachment[] = msg.attachments ?? [];
            if (!this.firstUserMessage && prompt.trim()) {
              this.firstUserMessage = prompt;
              const newTitle = makeShortTitle(prompt);
              this.title = newTitle;
              this.panel.title = newTitle;
              onTitleChange();
            }
            this.orchestrator.handleUserPrompt(prompt, attachments);
            break;
          }
          case "cancel":
            this.orchestrator.cancel();
            break;
          case "ready":
            // Webview is up — push the catalog + current selections so it
            // can paint the dropdown bar. Then, if this session was
            // restored from persisted state, push the saved transcript
            // so the chat reappears exactly as the user left it.
            this.sendModelCatalog();
            if (this.bubbles.size > 0) {
              this.panel.webview.postMessage({
                type: "restore-bubbles",
                bubbles: this.visiblePersistedBubbles(),
                turns: Array.from(this.turns.values()),
              });
            }
            break;
          case "set-model": {
            const slot: ModelSlot = msg.slot;
            const modelId: string = msg.modelId;
            if (slot in this.modelSelections && typeof modelId === "string") {
              this.modelSelections[slot] = modelId;
              this.schedulePersistToStorage();
            }
            break;
          }
          case "reset-models":
            this.modelSelections = this.initialSelections();
            this.sendModelCatalog();
            this.schedulePersistToStorage();
            break;
          case "refresh-catalog":
            // Force a full re-probe of available models. Same code path
            // the "Refresh model availability" command uses; here it's
            // wired to the ↻ button in each session.
            void this.refreshAvailabilityProbe();
            break;
        }
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(
      () => {
        this.orchestrator.cancel(true);
        if (this.persistTimer) {
          clearTimeout(this.persistTimer);
          this.persistTimer = undefined;
        }
        for (const d of this.disposables) d.dispose();
        // Deliberate close = forget the session. (VS Code reload doesn't
        // dispose webview panels via this path — it disposes them with a
        // distinguishable internal flag, but we can't observe it. Trade-
        // off: closing a tab loses the transcript permanently. Acceptable
        // given the alternative — restoring closed tabs forever — would
        // bloat workspaceState indefinitely.)
        void deletePersistedSession(this.context, this.id);
        onDispose(this.id);
      },
      undefined,
      this.disposables
    );
  }

  static create(
    context: vscode.ExtensionContext,
    onDispose: (id: string) => void,
    onTitleChange: () => void
  ): SessionPanel {
    const panel = vscode.window.createWebviewPanel(
      "claudexCouncil.sessionPanel",
      "Council",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
    const session = new SessionPanel(context, panel, onDispose, onTitleChange);

    // Pre-flight: check that Claude CLI is signed in. Fire-and-forget — we
    // don't want to slow session creation by even a few hundred ms. If the
    // probe finds a clear "not authenticated" signal we surface a single
    // actionable warning toast. We deliberately don't pester for the
    // "unknown" case (older CLI without `auth status`, network glitch,
    // etc.) — the per-turn classifier still catches real failures.
    void probeClaudeAuth().then((result) => {
      if (result.state === "not-authenticated") {
        vscode.window
          .showWarningMessage(
            "Claudex Council: Claude CLI is not signed in. Run `claude login` in a terminal to authenticate.",
            "Open Terminal"
          )
          .then((choice) => {
            if (choice === "Open Terminal") {
              const term = vscode.window.createTerminal("claude login");
              term.show();
              term.sendText("claude login", false);
            }
          });
      } else if (result.state === "binary-missing") {
        vscode.window.showWarningMessage(
          "Claudex Council: Claude CLI not found on PATH. Install Claude Code from https://code.claude.com or set the `claudexCouncil.claudeBinary` setting."
        );
      }
      // state === "ok" — silent (the happy path).
      // state === "unknown" — silent (don't false-positive).
    });

    return session;
  }

  /**
   * Recreate a SessionPanel from saved state — used at extension activation
   * to auto-restore each session that was open at the last shutdown. The
   * caller is responsible for adding the result to the SessionsTreeProvider.
   */
  static restoreFromState(
    context: vscode.ExtensionContext,
    state: PersistedSessionState,
    onDispose: (id: string) => void,
    onTitleChange: () => void
  ): SessionPanel {
    const panel = vscode.window.createWebviewPanel(
      "claudexCouncil.sessionPanel",
      state.title || "Council",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
    return new SessionPanel(context, panel, onDispose, onTitleChange, state);
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
  }

  clearConversation(): void {
    this.orchestrator.cancel(true);
    this.captureEventForPersistence({ type: "clear" });
    this.panel.webview.postMessage({ type: "clear" });
  }

  /**
   * Build the initial selections map: respect VS Code settings if the user
   * has explicitly set one, otherwise fall back to the catalog defaults.
   * Settings act as the user's persistent baseline; the per-session
   * dropdowns can override that baseline temporarily.
   */
  private initialSelections(): Record<ModelSlot, string> {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    const fromSetting = (key: string): string =>
      (cfg.get<string>(key) || "").trim();
    return {
      planner: fromSetting("coordinatorModel") || DEFAULT_SELECTIONS.planner,
      claudeWorker: fromSetting("claudeWorkerModel") || DEFAULT_SELECTIONS.claudeWorker,
      codexWorker: fromSetting("codexWorkerModel") || DEFAULT_SELECTIONS.codexWorker,
      decider: fromSetting("deciderModel") || DEFAULT_SELECTIONS.decider,
    };
  }

  /**
   * Re-emit the catalog to the webview, filtered through the availability
   * cache so only models that work on this account appear. Called on
   * webview ready, on Reset, after a probe completes, and on Refresh.
   */
  private sendModelCatalog(): void {
    const cache = readCache(this.context);
    const { filtered, cacheStatus } = applyAvailability(CATALOG, cache);
    this.reconcileSelections(filtered);
    this.panel.webview.postMessage({
      type: "model-catalog",
      catalog: filtered,
      defaults: DEFAULT_SELECTIONS,
      current: this.modelSelections,
      cacheStatus,
      cacheTimestamp: cache?.timestamp ?? null,
      probedCount: cache?.available.length ?? 0,
      hiddenCount: cache ? Object.keys(cache.unavailable).length : 0,
    });
  }

  private reconcileSelections(catalog: readonly ModelEntry[]): void {
    for (const slot of Object.keys(this.modelSelections) as ModelSlot[]) {
      const options = catalog.filter((m) => {
        if (slot === "planner") return m.provider === "claude";
        if (slot === "claudeWorker") return m.provider === "claude";
        if (slot === "codexWorker") return m.provider === "codex";
        return true;
      });
      if (options.length === 0) continue;
      const current = this.modelSelections[slot];
      if (options.some((m) => m.id === current)) continue;
      const defaultId = DEFAULT_SELECTIONS[slot];
      const fallback = options.find((m) => m.id === defaultId) || options[0];
      this.modelSelections[slot] = fallback.id;
    }
  }

  /**
   * Public entry point for the extension lifecycle: nudge this session to
   * re-fetch and re-render its catalog after a probe completes elsewhere.
   */
  refreshAvailability(): void {
    this.sendModelCatalog();
  }

  private getOrchestrationVisibility(): OrchestrationVisibility {
    const value = (
      vscode.workspace
        .getConfiguration("claudexCouncil")
        .get<string>("orchestrationVisibility") || "final-only"
    ).trim();
    if (value === "answers" || value === "detailed") return value;
    return "final-only";
  }

  private visibleEvents(event: OrchestratorEvent): OrchestratorEvent[] {
    const visibility = this.getOrchestrationVisibility();
    if (visibility === "detailed") return [event];

    if (
      event.type === "clear" ||
      event.type === "turn-started" ||
      event.type === "turn-cancelled"
    ) {
      return [event];
    }

    if (event.type === "council-activity") {
      return [event];
    }

    if (event.type === "turn-finished") {
      const fallback =
        visibility === "final-only" && !this.hasVisibleFinalForTurn(event.turnId)
          ? this.fallbackAnswerForTurn(event.turnId)
          : undefined;
      return fallback
        ? [
            fallback,
            {
              type: "agent-status",
              turnId: event.turnId,
              agent: "decider",
              role: "synthesis",
              status: "done",
            },
            event,
          ]
        : [event];
    }

    if (
      event.type === "agent-message" ||
      event.type === "agent-chunk" ||
      event.type === "agent-model" ||
      event.type === "agent-timing" ||
      event.type === "agent-status"
    ) {
      return this.isVisibleAgentEvent(event, visibility) ? [event] : [];
    }

    return [event];
  }

  private isVisibleAgentEvent(
    event: Extract<
      OrchestratorEvent,
      | { type: "agent-message" }
      | { type: "agent-chunk" }
      | { type: "agent-model" }
      | { type: "agent-timing" }
      | { type: "agent-status" }
    >,
    visibility: OrchestrationVisibility
  ): boolean {
    const role = event.role || "work";
    if (event.agent === "user") return true;
    if (visibility === "answers") {
      return role === "work" || role === "plan" || role === "synthesis";
    }
    // final-only: present one unified assistant voice. Coordinator,
    // worker, and review internals are still persisted and available via
    // answers/detailed, but the default console should feel like one
    // Council conversation.
    return event.agent === "decider" && role === "synthesis";
  }

  private visiblePersistedBubbles(): PersistedBubble[] {
    const visibility = this.getOrchestrationVisibility();
    const all = this.bubbleOrder
      .map((k) => this.bubbles.get(k))
      .filter((b): b is PersistedBubble => !!b);
    if (visibility === "detailed") return all;
    if (visibility === "answers") {
      return all.filter((b) => b.agent === "user" || b.role === "work" || b.role === "plan" || b.role === "synthesis");
    }

    // final-only persistence mirrors the live filter: keep user bubbles
    // and the unified Council answer only.
    const out: PersistedBubble[] = [];
    const seenFinal = new Set<string>();
    for (const b of all) {
      if (b.agent === "user") {
        out.push(b);
        continue;
      }
      if (b.agent === "decider" && b.role === "synthesis") {
        out.push(b);
        seenFinal.add(b.turnId);
      }
    }
    for (const turn of this.turns.values()) {
      if (seenFinal.has(turn.turnId)) continue;
      const fallback = this.fallbackBubbleForTurn(turn.turnId);
      if (fallback) out.push(fallback);
    }
    return out;
  }

  private hasVisibleFinalForTurn(turnId: string): boolean {
    return this.bubbleOrder.some((k) => {
      const b = this.bubbles.get(k);
      return b?.turnId === turnId && b.agent === "decider" && b.role === "synthesis" && !!b.content.trim();
    });
  }

  private fallbackAnswerForTurn(turnId: string): OrchestratorEvent | undefined {
    const b = this.fallbackBubbleForTurn(turnId);
    if (!b) return undefined;
    return {
      type: "agent-message",
      turnId: b.turnId,
      agent: "decider",
      role: "synthesis",
      content: b.content,
      attachments: b.attachments,
    };
  }

  private fallbackBubbleForTurn(turnId: string): PersistedBubble | undefined {
    for (const key of this.bubbleOrder) {
      const b = this.bubbles.get(key);
      if (!b || b.turnId !== turnId) continue;
      if ((b.agent === "claude" || b.agent === "codex") && b.role === "work" && b.content.trim()) {
        return {
          ...b,
          agent: "decider",
          role: "synthesis",
          model: b.model || "(direct)",
        };
      }
    }
    return undefined;
  }

  /**
   * Full prompt context for the next council turn. The complete transcript
   * remains in workspaceState for restore; this builds a bounded, structured
   * context window for the stateless CLI calls.
   */
  private buildSessionContext(excludeTurnId?: string): string {
    const maxChars = this.getSessionContextMaxChars();
    if (maxChars <= 0) return "";

    const maxBubbleChars = Math.max(
      800,
      Math.min(DEFAULT_SESSION_CONTEXT_BUBBLE_MAX_CHARS, Math.floor(maxChars / 4))
    );
    const bubbles = this.bubbleOrder
      .map((k) => this.bubbles.get(k))
      .filter(
        (b): b is PersistedBubble =>
          !!b && b.turnId !== excludeTurnId && !!b.content.trim()
      );

    const meta = [
      '<SESSION_CONTEXT compact="true">',
      'This is the prior context for the same Claudex Council session. Treat it like the earlier conversation in a normal Claude/Codex chat: use it for follow-ups, pronouns, prior decisions, constraints, model/lane context, and questions like "what did I ask before". The current user request appears after this block.',
      '<SESSION_META>',
      `session_id: ${this.id}`,
      `title: ${this.title || "Council"}`,
      `first_user_message: ${this.firstUserMessage || "(none yet)"}`,
      `restored_from_saved_state: ${this.restoredFromState ? "true" : "false"}`,
      `saved_turns: ${this.turns.size}`,
      `saved_messages: ${this.bubbles.size}`,
      `model_selections: planner=${this.modelSelections.planner || "(default)"}, claudeWorker=${this.modelSelections.claudeWorker || "(default)"}, codexWorker=${this.modelSelections.codexWorker || "(default)"}, decider=${this.modelSelections.decider || "(default)"}`,
      '</SESSION_META>',
      '<SESSION_TRANSCRIPT>',
    ];
    const footer = ["</SESSION_TRANSCRIPT>", "</SESSION_CONTEXT>"];
    const turnBlocks = this.buildSessionTurnBlocks(bubbles, maxBubbleChars);
    const overhead = meta.join("\n").length + footer.join("\n").length + 2;
    const budget = Math.max(0, maxChars - overhead);
    const selected: string[] = [];
    let used = 0;

    for (let i = turnBlocks.length - 1; i >= 0; i--) {
      const block = turnBlocks[i];
      const nextSize = used + block.length + (selected.length > 0 ? 2 : 0);
      if (selected.length > 0 && nextSize > budget) break;
      selected.unshift(block);
      used = nextSize;
    }

    if (selected.length < turnBlocks.length) {
      selected.unshift("[Earlier session turns omitted to keep prompt context bounded.]");
    }
    if (selected.length === 0) {
      selected.push("(no previous messages in this session yet)");
    }

    return truncateMiddle([...meta, ...selected, ...footer].join("\n"), maxChars);
  }

  private buildSessionTurnBlocks(
    bubbles: PersistedBubble[],
    maxBubbleChars: number
  ): string[] {
    const byTurn = new Map<string, PersistedBubble[]>();
    const turnOrder: string[] = [];
    for (const bubble of bubbles) {
      if (!byTurn.has(bubble.turnId)) {
        byTurn.set(bubble.turnId, []);
        turnOrder.push(bubble.turnId);
      }
      byTurn.get(bubble.turnId)?.push(bubble);
    }

    return turnOrder.map((turnId) => {
      const turn = this.turns.get(turnId);
      const attrs = [
        `id="${escapeAttr(turnId)}"`,
        turn?.totalMs !== undefined ? `total_ms="${turn.totalMs}"` : "",
        turn?.agentCount !== undefined ? `agent_count="${turn.agentCount}"` : "",
      ].filter(Boolean).join(" ");
      return [
        `<TURN ${attrs}>`,
        ...(byTurn.get(turnId) || []).map((bubble) =>
          formatContextBubble(bubble, maxBubbleChars)
        ),
        "</TURN>",
      ].join("\n");
    });
  }

  private getSessionContextMaxChars(): number {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    const contextSetting = readConfiguredNumber(cfg, "sessionContextMaxChars");
    const legacySetting = readConfiguredNumber(cfg, "sessionMemoryMaxChars");
    const raw = contextSetting.configured
      ? contextSetting.value
      : legacySetting.configured
        ? legacySetting.value
        : DEFAULT_SESSION_CONTEXT_MAX_CHARS;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return DEFAULT_SESSION_CONTEXT_MAX_CHARS;
    }
    return Math.max(0, Math.min(500_000, Math.floor(raw)));
  }

  /**
   * Capture an orchestrator event into the in-memory transcript so we can
   * persist it. Bubbles are keyed by turnId+agent+role; streaming chunks
   * append to the existing bubble's content.
   */
  private captureEventForPersistence(event: OrchestratorEvent): void {
    switch (event.type) {
      case "clear":
        this.bubbles.clear();
        this.bubbleOrder.length = 0;
        this.turns.clear();
        this.firstUserMessage = "";
        this.schedulePersistToStorage(0);
        break;
      case "agent-message": {
        const key = bubbleKey(event.turnId, event.agent, event.role);
        if (!this.bubbles.has(key)) this.bubbleOrder.push(key);
        this.bubbles.set(key, {
          turnId: event.turnId,
          agent: event.agent,
          role: event.role,
          content: event.content,
          attachments: event.attachments,
          model: this.bubbles.get(key)?.model,
          elapsedMs: this.bubbles.get(key)?.elapsedMs,
        });
        this.schedulePersistToStorage();
        break;
      }
      case "agent-chunk": {
        const key = bubbleKey(event.turnId, event.agent, event.role);
        const existing = this.bubbles.get(key);
        if (!existing) this.bubbleOrder.push(key);
        this.bubbles.set(key, {
          turnId: event.turnId,
          agent: event.agent,
          role: event.role,
          content: (existing?.content || "") + event.content,
          model: existing?.model,
          elapsedMs: existing?.elapsedMs,
          attachments: existing?.attachments,
        });
        this.schedulePersistToStorage();
        break;
      }
      case "agent-model": {
        const key = bubbleKey(event.turnId, event.agent, event.role);
        const existing = this.bubbles.get(key);
        if (existing) {
          existing.model = event.model;
          this.schedulePersistToStorage();
        }
        break;
      }
      case "agent-timing": {
        const key = bubbleKey(event.turnId, event.agent, event.role);
        const existing = this.bubbles.get(key);
        if (existing) {
          existing.elapsedMs = event.elapsedMs;
          this.schedulePersistToStorage();
        }
        break;
      }
      case "turn-finished":
        this.turns.set(event.turnId, {
          turnId: event.turnId,
          totalMs: event.totalMs,
          agentCount: event.agentCount,
        });
        this.schedulePersistToStorage(0);
        break;
    }
  }

  /**
   * Write this session's full state to workspaceState. Event-level writes are
   * debounced while streaming, then flushed immediately at turn boundaries.
   * Also adds this session's id to the open list so it's auto-restored on
   * activation.
   */
  private schedulePersistToStorage(delayMs = SESSION_PERSIST_DEBOUNCE_MS): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistToStorage();
    }, delayMs);
  }

  private async persistToStorage(): Promise<void> {
    const state: PersistedSessionState = {
      id: this.id,
      title: this.title,
      modelSelections: this.modelSelections,
      bubbles: this.bubbleOrder
        .map((k) => this.bubbles.get(k))
        .filter((b): b is PersistedBubble => !!b),
      turns: Array.from(this.turns.values()),
      firstUserMessage: this.firstUserMessage,
      lastUpdated: Date.now(),
    };
    await this.context.workspaceState.update(SESSION_STATE_PREFIX + this.id, state);
    const list = listPersistedSessionIds(this.context);
    if (!list.includes(this.id)) {
      list.push(this.id);
      await this.context.workspaceState.update(OPEN_SESSIONS_KEY, list);
    }
  }

  /**
   * Force a fresh probe round, then push the new catalog. Wired to the ↻
   * button in the model bar of this specific session.
   */
  private async refreshAvailabilityProbe(): Promise<void> {
    this.panel.webview.postMessage({
      type: "probe-progress",
      done: 0,
      total: CATALOG.length,
    });
    const cache = await runFullProbe(this.context, (p) => {
      this.panel.webview.postMessage({
        type: "probe-progress",
        done: p.done,
        total: p.total,
        currentId: p.currentId,
      });
    });
    this.panel.webview.postMessage({
      type: "probe-progress",
      done: cache.available.length + Object.keys(cache.unavailable).length,
      total: CATALOG.length,
      finished: true,
    });
    this.sendModelCatalog();
  }
}

function bubbleKey(turnId: string, agent: AgentId, role: string): string {
  return `${turnId}::${agent}::${role}`;
}

function readConfiguredNumber(
  cfg: vscode.WorkspaceConfiguration,
  key: string
): { value: number | undefined; configured: boolean } {
  const inspected = cfg.inspect<number>(key);
  const configured =
    inspected?.globalValue !== undefined ||
    inspected?.workspaceValue !== undefined ||
    inspected?.workspaceFolderValue !== undefined ||
    inspected?.globalLanguageValue !== undefined ||
    inspected?.workspaceLanguageValue !== undefined ||
    inspected?.workspaceFolderLanguageValue !== undefined;
  return { value: cfg.get<number>(key), configured };
}

function formatContextBubble(bubble: PersistedBubble, maxChars: number): string {
  const text = truncateMiddle(bubble.content.trim(), maxChars);
  const meta = [
    bubble.model ? `model=${bubble.model}` : "",
    bubble.elapsedMs !== undefined ? `elapsed_ms=${bubble.elapsedMs}` : "",
    bubble.attachments?.length
      ? `attachments=${bubble.attachments.map((a) => a.name || "attachment").join(",")}`
      : "",
  ].filter(Boolean);
  const suffix = meta.length > 0 ? ` {${meta.join("; ")}}` : "";
  return `[${contextLabel(bubble.agent, bubble.role)}]${suffix}\n${text}`;
}

function contextLabel(agent: AgentId, role: BubbleRole | "error"): string {
  const agentLabel: Record<AgentId, string> = {
    user: "User",
    planner: "Coordinator",
    claude: "Claude",
    codex: "Codex",
    decider: "Council",
  };
  const roleLabel =
    role === "synthesis"
      ? "final"
      : role === "plan"
        ? "plan"
        : role === "review"
          ? "review"
          : role === "error"
            ? "error"
            : "work";
  return `${agentLabel[agent]}/${roleLabel}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head - 40);
  return `${s.slice(0, head)}\n...[memory truncated]...\n${s.slice(-tail)}`;
}

function makeShortTitle(prompt: string): string {
  // Strip newlines, collapse spaces, cap at ~38 chars for tab readability.
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (flat.length <= 38) return flat;
  return flat.slice(0, 36).trimEnd() + "…";
}

/**
 * Renders the chat webview HTML, substituting CSP nonce + asset URIs.
 * Same UI for every session — only the orchestrator backing it differs.
 */
function renderWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const webviewDir = vscode.Uri.joinPath(context.extensionUri, "webview");
  const htmlPath = path.join(webviewDir.fsPath, "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");

  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, "styles.css"));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, "app.js"));
  const nonce = makeNonce();

  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource}`,
  ].join("; ");

  return html
    .replace(/{{CSP}}/g, csp)
    .replace(/{{NONCE}}/g, nonce)
    .replace(/{{CSS_URI}}/g, cssUri.toString())
    .replace(/{{JS_URI}}/g, jsUri.toString());
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
