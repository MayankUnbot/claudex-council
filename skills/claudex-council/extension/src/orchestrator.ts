import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn, ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { DEFAULT_SELECTIONS, findModel, ModelSlot } from "./modelCatalog";
import { knownModelStatus, pickAvailableModel, recordRuntimeModelResult } from "./modelProber";
import {
  CouncilRun,
  applyClarificationReview,
  applyCoordinatorPlanToRun as applyLedgerPlan,
  createCouncilRun,
  extractUserQuestions,
  markComposed,
  markOwnerRunning,
  recordOwnerOutput,
  renderClarificationMarkdown,
  renderLedgerForPrompt,
  type ClarificationReview,
} from "./council/ledger";

/**
 * Returns the user's current per-session model picks. SessionPanel owns the
 * mutable selections map and passes a closure here so each turn picks up
 * the latest dropdown choices without us caching anything.
 */
export type SelectionsGetter = () => Record<ModelSlot, string>;

/**
 * Events the orchestrator emits to a session's webview. The webview renders
 * these as message bubbles in a single chat thread.
 *
 *  - Each event has an `agent` field so the webview can color/label bubbles
 *    consistently (planner = blue, decider = orange, claude = purple,
 *    codex = green, user = neutral).
 *  - Token-by-token streaming uses `agent-chunk`; final/whole-message
 *    deliveries use `agent-message`.
 */
export type AgentId = "user" | "planner" | "decider" | "claude" | "codex";
export type BubbleRole = "plan" | "work" | "review" | "synthesis";
export type SessionContextGetter = (excludeTurnId?: string) => string;

export type OrchestratorEvent =
  | { type: "clear" }
  | { type: "turn-started"; turnId: string }
  | { type: "turn-cancelled"; turnId: string; queuedCount: number }
  | { type: "turn-finished"; turnId: string; totalMs: number; agentCount: number }
  | {
      type: "council-activity";
      turnId: string;
      phase: string;
      summary?: string;
      context: CouncilContextUsage;
      lanes: CouncilActivityLane[];
    }
  | {
      type: "agent-message";
      turnId: string;
      agent: AgentId;
      role: BubbleRole;
      content: string;
      attachments?: PromptAttachment[];
    }
  | {
      type: "agent-chunk";
      turnId: string;
      agent: AgentId;
      role: BubbleRole;
      content: string;
    }
  | {
      type: "agent-status";
      turnId: string;
      agent: AgentId;
      role?: BubbleRole;
      status: "thinking" | "running" | "done" | "failed";
    }
  | {
      // Per-agent elapsed time, emitted when that agent's bubble is final.
      // The webview replaces the live "verb · 4s" header counter with this
      // settled value (e.g. "12.3s") and stops the rotating verb.
      type: "agent-timing";
      turnId: string;
      agent: AgentId;
      role: BubbleRole;
      elapsedMs: number;
      usage?: AgentUsage;
    }
  | {
      // Names the model powering a bubble. Emitted twice per call: once
      // before the call starts (with whatever the user configured, or a
      // "(CLI default)" placeholder), then again if we manage to extract
      // the actual resolved model from the CLI's response stream. The
      // webview shows it as a small monospace badge in the bubble header.
      type: "agent-model";
      turnId: string;
      agent: AgentId;
      role: BubbleRole;
      model: string;
    };

export interface PromptAttachment {
  /** base64-encoded image data URI, e.g. "data:image/png;base64,iVBOR..." */
  dataUri: string;
  /** original filename for logging/display */
  name: string;
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
  totalCostUsd?: number;
}

export interface CouncilContextUsage {
  usedChars: number;
  maxChars: number;
  percent: number;
  compacted: boolean;
}

export interface CouncilActivityStep {
  label: string;
  status: "pending" | "running" | "done" | "blocked" | "skipped";
}

export interface CouncilActivityLane {
  agent: "claude" | "codex";
  title: string;
  mission: string;
  status: "queued" | "planning" | "running" | "done" | "limited" | "failed" | "skipped";
  progress: number;
  steps: CouncilActivityStep[];
  model?: string;
  modelReason?: string;
  usage?: AgentUsage;
  note?: string;
}

interface RunResult {
  text: string;
  exitCode: number | null;
  /** Captured stderr from buffered processes (e.g. ask_codex.py meta). */
  stderr?: string;
  usage?: AgentUsage;
}

interface QueuedPrompt {
  turnId: string;
  prompt: string;
  attachments: PromptAttachment[];
}

interface DeliberationResult {
  claudeReview: string;
  codexReview: string;
}

interface DeciderRoute {
  mode: "full-council" | "claude-only" | "economy";
  fidelity: CouncilFidelity;
  reason: string;
  confidence: "high" | "medium" | "low";
  runClaude: boolean;
  runCodex: boolean;
  runSynthesis: boolean;
  fastClaude: boolean;
  planText: string;
  claudeRole: string;
  codexRole: string;
  claudePrompt: string;
  codexPrompt: string;
  coordination?: CoordinatorPlan;
}

interface CoordinatorLane {
  mission: string;
  tasks: string[];
  avoid: string[];
}

interface CoordinatorPlan {
  source: "local" | "model";
  summary: string;
  claudeLane: CoordinatorLane;
  codexLane: CoordinatorLane;
  synthesisStrategy: string;
  coordinationNotes: string[];
  rawText?: string;
}

interface ModelChoice {
  model: string;
  reason: string;
  auto: boolean;
  candidates?: string[];
  preferredModel?: string;
}

type AgentRuntimeId = "claude" | "codex";
type AgentFailureKind = "quota" | "auth" | "missing" | "timeout" | "model" | "transient" | "error";

interface AgentFailureInfo {
  agent: AgentRuntimeId | "council";
  label: string;
  kind: AgentFailureKind;
  title: string;
  message: string;
  raw: string;
}

interface AgentCooldown {
  info: AgentFailureInfo;
  until: number;
}

interface MutableLaneActivity {
  agent: AgentRuntimeId;
  mission: string;
  tasks: string[];
  status: CouncilActivityLane["status"];
  progress: number;
  model?: string;
  modelReason?: string;
  usage?: AgentUsage;
  note?: string;
}

interface CouncilActivityState {
  context: CouncilContextUsage;
  claude: MutableLaneActivity;
  codex: MutableLaneActivity;
}

type CouncilFidelity = "fast" | "full-fidelity";
type CoordinatorMode = "model" | "local";
type DeliberationMode = "auto" | "always" | "off";
type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "dontAsk"
  | "plan";
type CodexFullFidelitySandbox =
  | "inherit"
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

const CLAUDE_WORKER_TIMEOUT_MS = 60_000;
const CLAUDE_REVIEW_TIMEOUT_MS = 30_000;
const CLAUDE_SYNTHESIS_TIMEOUT_MS = 35_000;
const CLAUDE_COORDINATOR_TIMEOUT_MS = 90_000;
// Full-fidelity timeouts are generous because real tool-using turns
// (file reads, web searches, MCP tool calls, multi-step reasoning) can
// legitimately take minutes. 600s matches the codex helper's own
// --timeout default. Cancel-button still works via the tree-kill path
// for users who get tired of waiting.
const CLAUDE_FULL_FIDELITY_WORKER_TIMEOUT_MS = 600_000;
const CLAUDE_FULL_FIDELITY_REVIEW_TIMEOUT_MS = 300_000;
const CLAUDE_FULL_FIDELITY_SYNTHESIS_TIMEOUT_MS = 300_000;
const CLAUDE_FULL_FIDELITY_COORDINATOR_TIMEOUT_MS = 300_000;
const CODEX_WORKER_TIMEOUT_SEC = 45;
const CODEX_REVIEW_TIMEOUT_SEC = 30;
const CODEX_SYNTHESIS_TIMEOUT_SEC = 35;
const CODEX_FULL_FIDELITY_WORKER_TIMEOUT_SEC = 600;
const CODEX_FULL_FIDELITY_REVIEW_TIMEOUT_SEC = 300;
const CODEX_FULL_FIDELITY_SYNTHESIS_TIMEOUT_SEC = 300;
const AGENT_QUOTA_COOLDOWN_MS = 15 * 60 * 1000;
// Auth/missing-binary failures also cool down so we don't re-spawn a broken
// CLI on every successive turn (each spawn would otherwise burn 60s on the
// worker timeout). 5 min is short enough that a user who runs `claude login`
// or installs the missing CLI doesn't have to wait long for normal behavior.
const AGENT_AUTH_COOLDOWN_MS = 5 * 60 * 1000;
const STATIC_CONTEXT_CACHE_MS = 30_000;
const PROJECT_CONTEXT_MAX_CHARS = 7_000;
const ACTIVE_EDITOR_SNIPPET_MAX_CHARS = 2_500;

/**
 * Real orchestrator: spawns claude -p (Claude worker + synthesis) and
 * python ask_codex.py (Codex worker) as child processes, streams the
 * Claude worker's tokens back to the webview as they arrive, waits for
 * Codex (which buffers internally), then runs a synthesis pass.
 *
 * One Orchestrator instance per session/panel — sessions are isolated.
 */
export class Orchestrator {
  private activeProcesses = new Set<ChildProcess>();
  private cancelled = false;
  private busy = false;
  private activeTurnId: string | undefined;
  private readonly promptQueue: QueuedPrompt[] = [];
  private staticContextCache:
    | { cwd: string; builtAt: number; value: string }
    | undefined;
  private readonly agentCooldowns: Partial<Record<AgentRuntimeId, AgentCooldown>> = {};
  /** Temp files written for the in-flight turn's image attachments.
   *  Tracked so cancel() can clean them up even if handleUserPrompt is
   *  awaiting and won't reach its finally block immediately. */
  private currentAttachmentPaths: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly emit: (event: OrchestratorEvent) => void,
    private readonly getSelections?: SelectionsGetter,
    private readonly getSessionContext?: SessionContextGetter
  ) {}

  async handleUserPrompt(
    prompt: string,
    attachments: PromptAttachment[],
    queuedTurnId?: string,
    echoUser = true
  ): Promise<void> {
    const turnId = queuedTurnId || makeTurnId();
    if (this.busy) {
      this.enqueuePrompt(turnId, prompt, attachments);
      return;
    }

    this.busy = true;
    this.cancelled = false;
    this.activeTurnId = turnId;

    const turnStart = Date.now();
    const sessionContext = this.getSessionContextPack(turnId);
    const councilRun = createCouncilRun(turnId, prompt);
    const route = decideRoute(
      prompt,
      attachments,
      this.isEconomyMode(),
      this.getCouncilFidelity()
    );
    const activity = createCouncilActivityState(route, this.getCouncilContextUsage(sessionContext));
    this.applyKnownAgentCooldowns(route, activity, prompt);
    let agentCount = 0;
    let attachmentPaths: string[] = [];
    let emittedTurnFinished = false;
    try {
    if (echoUser) {
      this.emit({ type: "turn-started", turnId });
    }

    // 1. Echo the user's prompt so the bubble appears in the transcript.
    if (echoUser) {
      this.emit({
        type: "agent-message",
        turnId,
        agent: "user",
        role: "work",
        content: userBubbleText(prompt, attachments),
        attachments,
      });
    }
    this.emitCouncilActivity(
      turnId,
      "Preparing council",
      "Loading session context and assigning Claude/Codex lanes.",
      activity
    );

    if (!route.runClaude && !route.runCodex) {
      const message = buildAllAgentsUnavailableMessage(activity);
      this.emitCouncilActivity(
        turnId,
        "Agents unavailable",
        "Both lanes are currently blocked by quota or authentication limits.",
        activity
      );
      this.emit({
        type: "agent-message",
        turnId,
        agent: "decider",
        role: "synthesis",
        content: message,
      });
      this.emit({ type: "agent-status", turnId, agent: "decider", role: "synthesis", status: "done" });
      this.emit({
        type: "turn-finished",
        turnId,
        totalMs: Date.now() - turnStart,
        agentCount: 0,
      });
      emittedTurnFinished = true;
      return;
    }

    // 2. Persist attachments to temp files (claude -p reads images from disk).
    attachmentPaths = await this.persistAttachments(attachments);
    this.currentAttachmentPaths = attachmentPaths;

    // 3. Coordinator route. The local router chooses whether this turn
    // needs the council; for full-council turns the coordinator can make
    // a model call to split work into explicit Claude/Codex lanes.
    await this.runCoordinator(turnId, prompt, attachmentPaths, route, sessionContext);
    if (route.coordination) {
      applyLedgerPlan(councilRun, route.coordination, { runCodex: route.runCodex });
    }
    applyActivityPlan(activity, route);
    this.emitCouncilActivity(
      turnId,
      "Lane plan ready",
      route.runCodex
        ? "Claude and Codex have separate lanes and shared context."
        : "Running the available lane with shared session context.",
      activity
    );
    agentCount += 1;

    // 4. Spawn workers — both in parallel normally, Claude only in
    //    Claude-only routes. Emit the model badges up front so they appear
    //    in the bubble headers immediately.
    const claudeModelChoice = route.runClaude
      ? this.chooseClaudeWorkerModel(prompt, route)
      : undefined;
    const codexModelChoice = route.runCodex
      ? this.chooseCodexWorkerModel(prompt, route)
      : undefined;
    if (route.runClaude) {
      activity.claude.status = "running";
      activity.claude.progress = 52;
      activity.claude.model = formatModelChoice(claudeModelChoice);
      activity.claude.modelReason = claudeModelChoice?.reason;
      this.emit({ type: "agent-status", turnId, agent: "claude", status: "running" });
      this.emit({
        type: "agent-model",
        turnId,
        agent: "claude",
        role: "work",
        model: formatModelChoice(claudeModelChoice) || "(CLI default)",
      });
    }
    if (route.runCodex) {
      activity.codex.status = "running";
      activity.codex.progress = 52;
      activity.codex.model = formatModelChoice(codexModelChoice);
      activity.codex.modelReason = codexModelChoice?.reason;
      this.emit({ type: "agent-status", turnId, agent: "codex", status: "running" });
      this.emit({
        type: "agent-model",
        turnId,
        agent: "codex",
        role: "work",
        model: formatModelChoice(codexModelChoice) || "(CLI default)",
      });
    }
    this.emitCouncilActivity(
      turnId,
      "Agents working",
      route.runClaude && route.runCodex
        ? "Both lanes are executing in parallel and will publish results into the shared ledger."
        : "The available lane is executing; unavailable lanes remain visible with their reason.",
      activity
    );

    if (route.runClaude) markOwnerRunning(councilRun, "claude");
    if (route.runCodex) markOwnerRunning(councilRun, "codex");

    const claudeStart = Date.now();
    const codexStart = Date.now();
    const [claudeResult, codexResult] = await Promise.allSettled([
      !route.runClaude
        ? Promise.resolve({
            text: `(skipped - ${activity.claude.note || "Claude lane unavailable"})`,
            exitCode: 0,
          } as RunResult)
        : this.runClaudeWorker(
            turnId,
            prompt,
            attachmentPaths,
            route,
            sessionContext,
            councilRun,
            claudeModelChoice
          ).then((r) => {
        this.emit({
          type: "agent-timing",
          turnId,
          agent: "claude",
          role: "work",
          elapsedMs: Date.now() - claudeStart,
          usage: r.usage,
        });
        return r;
      }),
      !route.runCodex
        ? Promise.resolve({
            text: `(skipped - ${route.reason})`,
            exitCode: 0,
          } as RunResult)
        : this.runCodexWorker(
            turnId,
            prompt,
            route,
            sessionContext,
            councilRun,
            codexModelChoice
          ).then((r) => {
            this.emit({
              type: "agent-timing",
              turnId,
              agent: "codex",
              role: "work",
              elapsedMs: Date.now() - codexStart,
              usage: r.usage,
            });
            return r;
          }),
    ]);
    agentCount += (route.runClaude ? 1 : 0) + (route.runCodex ? 1 : 0);

    if (this.cancelled) {
      this.cleanup(attachmentPaths);
      this.busy = false;
      return;
    }

    const claudeFailure =
      route.runClaude && claudeResult.status !== "fulfilled"
        ? classifyAgentFailure("claude", String(claudeResult.reason))
        : undefined;
    const codexFailure =
      route.runCodex && codexResult.status !== "fulfilled"
        ? classifyAgentFailure("codex", String(codexResult.reason))
        : undefined;
    if (claudeFailure) this.rememberAgentFailure("claude", claudeFailure);
    if (codexFailure) this.rememberAgentFailure("codex", codexFailure);

    const claudeText =
      route.runClaude && claudeResult.status === "fulfilled"
        ? claudeResult.value.text
        : claudeFailure
          ? claudeFailure.message
          : `(skipped - ${activity.claude.note || "Claude lane unavailable"})`;
    const codexText =
      route.runCodex && codexResult.status === "fulfilled"
        ? codexResult.value.text
        : codexFailure
          ? codexFailure.message
          : `(skipped - ${activity.codex.note || route.reason})`;

    updateActivityAfterWorker(activity.claude, route.runClaude, claudeResult, claudeFailure);
    updateActivityAfterWorker(activity.codex, route.runCodex, codexResult, codexFailure);
    this.emitCouncilActivity(
      turnId,
      "Lane results ready",
      buildLaneResultSummary(route, claudeFailure, codexFailure),
      activity
    );
    let deliberation: DeliberationResult | undefined;
    const claudeBlockers = extractUserQuestions(claudeText, "claude");
    const codexBlockers = route.runCodex ? extractUserQuestions(codexText, "codex") : [];
    if (route.runClaude) recordOwnerOutput(councilRun, "claude", claudeText, claudeBlockers);
    if (route.runCodex) recordOwnerOutput(councilRun, "codex", codexText, codexBlockers);

    // Per Codex's permanent error policy (v0.5.6): the UI never receives
    // role:"error" bubbles. Failures are internal state, logged for
    // debugging via console.warn (Extension Host log) but invisible to
    // the user. The synthesis step uses friendly placeholders for any
    // missing agent output ("(Claude did not return a response)") so the
    // synthesizer can still produce a coherent final answer from one
    // agent's output, or a generic fallback if both failed.
    if (route.runClaude && claudeResult.status !== "fulfilled") {
      console.warn(
        `[claudex-council] claude worker failed silently for turn ${turnId}: ${String(claudeResult.reason).slice(0, 400)}`
      );
      // Hide the bubble entirely (don't even keep an empty one with a
      // failed-status indicator).
      this.emit({ type: "agent-status", turnId, agent: "claude", status: "done" });
    }
    if (route.runCodex && codexResult.status !== "fulfilled") {
      console.warn(
        `[claudex-council] codex worker failed silently for turn ${turnId}: ${String(codexResult.reason).slice(0, 400)}`
      );
      this.emit({ type: "agent-status", turnId, agent: "codex", status: "done" });
    }

    const workerNotice = buildWorkerLimitationNotice(claudeFailure, codexFailure, route);
    const claudeSucceeded = route.runClaude && claudeResult.status === "fulfilled" && !!claudeText.trim();
    const codexSucceeded = route.runCodex && codexResult.status === "fulfilled" && !!codexText.trim();
    if (!claudeSucceeded && !codexSucceeded) {
      const message =
        workerNotice ||
        "Both council lanes were unavailable for this turn. Check the Claude/Codex CLI login or quota status, then try again.";
      markComposed(councilRun, message);
      this.emit({
        type: "agent-message",
        turnId,
        agent: "decider",
        role: "synthesis",
        content: message,
      });
      this.emit({ type: "agent-status", turnId, agent: "decider", role: "synthesis", status: "done" });
      this.emit({
        type: "turn-finished",
        turnId,
        totalMs: Date.now() - turnStart,
        agentCount,
      });
      emittedTurnFinished = true;
      return;
    }

    if (
      !this.cancelled &&
      !claudeFailure &&
      !codexFailure &&
      this.shouldRunClarificationCoordinator(route, claudeText, codexText, councilRun)
    ) {
      const review = await this.runClarificationCoordinator(
        turnId,
        prompt,
        claudeText,
        codexText,
        route,
        sessionContext,
        councilRun
      );
      applyClarificationReview(councilRun, review, { claude: claudeText, codex: codexText });
      if (councilRun.pendingClarifications.length > 0) {
        const clarification = renderClarificationMarkdown(councilRun);
        markComposed(councilRun, clarification);
        this.emit({
          type: "agent-model",
          turnId,
          agent: "decider",
          role: "synthesis",
          model: "(council clarification)",
        });
        this.emit({
          type: "agent-message",
          turnId,
          agent: "decider",
          role: "synthesis",
          content: clarification,
        });
        this.emit({ type: "agent-status", turnId, agent: "decider", status: "done" });
        this.emit({
          type: "turn-finished",
          turnId,
          totalMs: Date.now() - turnStart,
          agentCount: agentCount + 1,
        });
        emittedTurnFinished = true;
        return;
      }
    }

    if (
      !this.cancelled &&
      !claudeFailure &&
      !codexFailure &&
      this.shouldRunDeliberation(route, claudeResult.status === "fulfilled", codexResult.status === "fulfilled")
    ) {
      deliberation = await this.runDeliberation(
        turnId,
        prompt,
        claudeText,
        codexText,
        route,
        sessionContext
      );
      agentCount += 2;
    }

    // 5. Synthesis pass. The decider route controls whether this is needed.
    if (route.runSynthesis) {
      const deciderModelChoice = this.chooseDeciderModel(prompt, route);
      const deciderProvider =
        findModel(deciderModelChoice?.model || "")?.provider === "codex"
          ? "codex"
          : this.getDeciderProvider();
      const synthesisProviderUnavailable =
        (deciderProvider === "claude" && !!claudeFailure && codexSucceeded) ||
        (deciderProvider === "codex" && !!codexFailure && claudeSucceeded);
      this.emitCouncilActivity(
        turnId,
        "Composing answer",
        workerNotice
          ? "One lane was unavailable; composing from the successful lane."
          : "Merging lane results into the final Council answer.",
        activity
      );
      this.emit({
        type: "agent-status",
        turnId,
        agent: "decider",
        role: "synthesis",
        status: "running",
      });
      // Emit the synthesis model badge before the call so it appears in
      // the bubble header as soon as the synthesis bubble is created.
      this.emit({
        type: "agent-model",
        turnId,
        agent: "decider",
        role: "synthesis",
        model: synthesisProviderUnavailable
          ? "(single-lane fallback)"
          : formatModelChoice(deciderModelChoice) || "(CLI default)",
      });
      const synthStart = Date.now();
      let synthesis = "";
      let synthesisUsage: AgentUsage | undefined;
      let synthesisFailure: AgentFailureInfo | undefined;
      try {
        if (synthesisProviderUnavailable) {
          synthesis = codexSucceeded ? codexText.trim() : claudeText.trim();
        } else {
          const synth = await this.runSynthesis(
            turnId,
            prompt,
            claudeText,
            codexText,
            route,
            deliberation,
            sessionContext,
            councilRun,
            deciderModelChoice
          );
          synthesis = synth.text.trim();
          synthesisUsage = synth.usage;
        }
      } catch (err) {
        synthesisFailure = classifyAgentFailure("council", String(err));
        // Synthesis failed too. If at least one worker returned real
        // content, fall back to it directly so the user still gets an
        // answer. If both also failed, show a single polite line.
        const claudeOk =
          claudeResult.status === "fulfilled" && claudeText.trim().length > 4;
        const codexOk =
          route.runCodex && codexResult.status === "fulfilled" && codexText.trim().length > 4;
        console.warn(
          `[claudex-council] synthesis failed for turn ${turnId}: ${String(err).slice(0, 400)}`
        );
        // When we substitute a worker's raw answer for the failed synthesis,
        // prepend a one-line notice so the user knows they're seeing the raw
        // worker output and not a synthesized Council answer. Without this
        // banner the failure is silent and indistinguishable from a normal
        // turn (the prior version logged to console only).
        const fallbackNotice =
          synthesisFailure.kind === "auth"
            ? `> _Council synthesis unavailable (${synthesisFailure.label.toLowerCase()} not authenticated). Showing the working agent's answer directly._\n\n`
            : synthesisFailure.kind === "missing"
              ? `> _Council synthesis unavailable (synthesis CLI not found). Showing the working agent's answer directly._\n\n`
              : `> _Council synthesis failed; showing the working agent's answer directly._\n\n`;
        if (claudeOk) {
          synthesis = fallbackNotice + claudeText.trim();
        } else if (codexOk) {
          synthesis = fallbackNotice + codexText.trim();
        } else {
          synthesis = synthesisFailure.message;
        }
      }
      const synthElapsed = Date.now() - synthStart;
      if (!this.cancelled) {
        const notices = [workerNotice, synthesisFailure ? synthesisFailure.message : ""]
          .filter((s): s is string => !!s && !!s.trim());
        if (notices.length > 0 && synthesis.trim()) {
          synthesis = `${notices.join("\n\n")}\n\n${synthesis}`;
        }
        markComposed(councilRun, synthesis || "(no answer)");
        this.emit({
          type: "agent-message",
          turnId,
          agent: "decider",
          // Always synthesis role — never error. UI only renders
          // assistant content; failures live in console logs.
          role: "synthesis",
          content: synthesis || "(no answer)",
        });
        this.emit({ type: "agent-status", turnId, agent: "decider", status: "done" });
        this.emit({
          type: "agent-timing",
          turnId,
          agent: "decider",
          role: "synthesis",
          elapsedMs: synthElapsed,
          usage: synthesisUsage,
        });
        this.emitCouncilActivity(
          turnId,
          "Complete",
          "Council answer is ready.",
          activity
        );
        agentCount += 1;
      }
    }

    if (!route.runSynthesis) {
      this.emitCouncilActivity(
        turnId,
        "Complete",
        "Council answer is ready.",
        activity
      );
    }

    this.emit({
      type: "turn-finished",
      turnId,
      totalMs: Date.now() - turnStart,
      agentCount,
    });
    emittedTurnFinished = true;
    } catch (err) {
      console.warn(
        `[claudex-council] unexpected turn failure ${turnId}: ${String(err).slice(0, 600)}`
      );
      if (!this.cancelled) {
        this.emit({
          type: "agent-message",
          turnId,
          agent: "decider",
          role: "synthesis",
          content:
            "The council hit an internal runtime problem before it could finish. Check the Extension Host log, then try again.",
        });
      }
    } finally {
      if (!emittedTurnFinished && !this.cancelled) {
        this.emit({
          type: "turn-finished",
          turnId,
          totalMs: Date.now() - turnStart,
          agentCount: Math.max(agentCount, 1),
        });
      }
      this.cleanup(attachmentPaths);
      this.currentAttachmentPaths = [];
      if (this.activeTurnId === turnId) this.activeTurnId = undefined;
      this.busy = false;
      this.drainPromptQueue();
    }
  }

  /**
   * handleUserPrompt is intentionally wrapped in try/finally so cancellation
   * races and new spawn-path bugs cannot leave the session stuck busy.
   */

  cancel(dropQueue = false): void {
    this.cancelled = true;
    if (dropQueue) this.promptQueue.length = 0;
    if (this.activeTurnId) {
      this.emit({
        type: "turn-cancelled",
        turnId: this.activeTurnId,
        queuedCount: this.promptQueue.length,
      });
    }
    for (const proc of this.activeProcesses) {
      killProcessTree(proc);
    }
    this.activeProcesses.clear();
    // Clean up any temp attachment files immediately rather than waiting
    // for handleUserPrompt's finally block — the user pressed Cancel and
    // wants the system back to a clean state right now.
    if (this.currentAttachmentPaths.length > 0) {
      this.cleanup(this.currentAttachmentPaths);
      this.currentAttachmentPaths = [];
    }
  }

  private enqueuePrompt(turnId: string, prompt: string, attachments: PromptAttachment[]): void {
    this.promptQueue.push({ turnId, prompt, attachments });
    this.emit({ type: "turn-started", turnId });
    this.emit({
      type: "agent-message",
      turnId,
      agent: "user",
      role: "work",
      content: userBubbleText(prompt, attachments),
      attachments,
    });
    this.emit({
      type: "agent-message",
      turnId,
      agent: "planner",
      role: "plan",
      content: `Queued behind the current turn. It will start automatically (${this.promptQueue.length} queued).`,
    });
    this.emit({
      type: "agent-model",
      turnId,
      agent: "planner",
      role: "plan",
      model: "(queued)",
    });
    this.emit({ type: "agent-status", turnId, agent: "planner", status: "done" });
  }

  private drainPromptQueue(): void {
    if (this.busy) return;
    const next = this.promptQueue.shift();
    if (!next) return;
    void this.handleUserPrompt(next.prompt, next.attachments, next.turnId, false);
  }

  // ---------- worker spawners ----------

  private async runCoordinator(
    turnId: string,
    prompt: string,
    attachmentPaths: string[],
    route: DeciderRoute,
    sessionContext: string
  ): Promise<void> {
    const startedAt = Date.now();
    const shouldUseModel =
      route.runCodex && route.runSynthesis && this.getCoordinatorMode() === "model";

    if (!shouldUseModel) {
      const plan = makeFallbackCoordinatorPlan(route);
      applyCoordinatorPlanToRoute(route, prompt, plan);
      this.emit({
        type: "agent-message",
        turnId,
        agent: "planner",
        role: "plan",
        content: route.planText,
      });
      this.emit({
        type: "agent-model",
        turnId,
        agent: "planner",
        role: "plan",
        model: "(local coordinator)",
      });
      this.emit({ type: "agent-status", turnId, agent: "planner", status: "done" });
      this.emit({
        type: "agent-timing",
        turnId,
        agent: "planner",
        role: "plan",
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }

    this.emit({ type: "agent-status", turnId, agent: "planner", status: "running" });
    this.emit({
      type: "agent-model",
      turnId,
      agent: "planner",
      role: "plan",
      model: this.getCoordinatorModel() || "(CLI default)",
    });

    try {
      const args = buildClaudeArgs({
        stream: false,
        fidelity: route.fidelity,
        systemPrompt: DEFAULT_COORDINATOR_SYSTEM_PROMPT,
        appendSystemPrompt: DEFAULT_FULL_FIDELITY_COORDINATOR_APPEND_PROMPT,
        permissionMode: this.getClaudeFullFidelityPermissionMode(),
      });
      const coordinatorModel = this.getCoordinatorModel();
      if (coordinatorModel) args.push("--model", coordinatorModel);
      const result = await this.runBufferedProcess({
        command: this.getClaudeBinary(),
        args,
        cwd: this.getWorkingDirectory(),
        stdin: this.buildCoordinatorPrompt(prompt, attachmentPaths, route, sessionContext),
        timeoutMs:
          route.fidelity === "full-fidelity"
            ? CLAUDE_FULL_FIDELITY_COORDINATOR_TIMEOUT_MS
            : CLAUDE_COORDINATOR_TIMEOUT_MS,
        fullFidelity: route.fidelity === "full-fidelity",
      });
      if (result.exitCode !== 0) {
        throw new Error(result.text || `Claude coordinator exited with code ${result.exitCode}`);
      }
      const coordinatorText = extractClaudePrintText(result.text);
      const parsed = parseCoordinatorPlan(coordinatorText);
      const plan = parsed || makeFallbackCoordinatorPlan(route, coordinatorText);
      applyCoordinatorPlanToRoute(route, prompt, plan);
      this.emit({
        type: "agent-message",
        turnId,
        agent: "planner",
        role: "plan",
        content: route.planText,
      });
      this.emit({
        type: "agent-timing",
        turnId,
        agent: "planner",
        role: "plan",
        elapsedMs: Date.now() - startedAt,
        usage: result.usage,
      });
    } catch (err) {
      console.warn(
        `[claudex-council] coordinator failed for turn ${turnId}: ${String(err).slice(0, 400)}`
      );
      const plan = makeFallbackCoordinatorPlan(route);
      applyCoordinatorPlanToRoute(route, prompt, plan);
      this.emit({
        type: "agent-message",
        turnId,
        agent: "planner",
        role: "plan",
        content:
          `${route.planText}\n\nCoordinator fallback: model coordinator was unavailable, so the local coordinator assigned the lanes.`,
      });
      this.emit({
        type: "agent-timing",
        turnId,
        agent: "planner",
        role: "plan",
        elapsedMs: Date.now() - startedAt,
      });
    } finally {
      this.emit({ type: "agent-status", turnId, agent: "planner", status: "done" });
    }
  }

  private buildCoordinatorPrompt(
    prompt: string,
    attachmentPaths: string[],
    route: DeciderRoute,
    sessionContext: string
  ): string {
    const attachmentText =
      attachmentPaths.length > 0
        ? attachmentPaths.map((p, i) => `Attachment ${i + 1}: ${p}`).join("\n")
        : "(none)";
    return [
      this.getPromptContextPack(sessionContext),
      "",
      "<COUNCIL_CONTEXT>",
      `route_mode: ${route.mode}`,
      `route_reason: ${route.reason}`,
      `capability_profile: ${route.fidelity}`,
      `attachments: ${attachmentText}`,
      "</COUNCIL_CONTEXT>",
      "",
      "<USER_REQUEST>",
      prompt,
      "</USER_REQUEST>",
      "",
      "Create a coordination plan for Claude and Codex. Return JSON only with this exact shape:",
      "{",
      '  "summary": "one-sentence coordination intent",',
      '  "claude_lane": { "mission": "...", "tasks": ["..."], "avoid": ["..."] },',
      '  "codex_lane": { "mission": "...", "tasks": ["..."], "avoid": ["..."] },',
      '  "synthesis_strategy": "how the Decider should compose both outputs",',
      '  "coordination_notes": ["shared constraints, ownership boundaries, conflict risks"]',
      "}",
      "",
      "Rules:",
      "- Split work so Claude and Codex can run in parallel without waiting on each other.",
      "- Give Claude the repo-aware/context-heavy lane when useful.",
      "- Give Codex the independent implementation, verification, or second-pass lane when useful.",
      "- Avoid assigning both agents the same broad task unless the goal is explicitly independent review.",
      "- If the user asks for direct work, assign concrete execution/verification lanes, not just opinions.",
    ].join("\n");
  }

  private async runClaudeWorker(
    turnId: string,
    prompt: string,
    attachmentPaths: string[],
    route?: DeciderRoute,
    sessionContext = "",
    councilRun?: CouncilRun,
    modelChoice?: ModelChoice
  ): Promise<RunResult> {
    const claudeBin = this.getClaudeBinary();
    const cwd = this.getWorkingDirectory();

    // If the user attached images, reference them in the prompt body so
    // Claude can read them with its built-in Read tool. claude -p doesn't
    // have a dedicated --image flag for stdin, so referencing by path is
    // the portable approach.
    let workerPrompt = this.withPromptContext(route?.claudePrompt || prompt, sessionContext, councilRun);
    if (attachmentPaths.length > 0) {
      const refs = attachmentPaths
        .map((p, i) => `Attachment ${i + 1}: ${p}`)
        .join("\n");
      workerPrompt = `${workerPrompt}\n\nThe user attached the following image(s). Read them with your Read tool if relevant:\n${refs}`;
    }

    // Pass the prompt via stdin to avoid Windows argv mangling (shell:true
    // word-splits on spaces). The flag set below was tuned with help from
    // Codex's perf audit — the goal is a "pure LLM round-trip" instead of
    // Claude Code's default behavior, which loads MCP servers, plugins,
    // hooks, slash commands, settings cascade, auto-memory, and a multi-K
    // tools system prompt before generating a single token. Cuts cold
    // start from ~13–17s to ~8s per call.
    const fidelity = route?.fidelity ?? "full-fidelity";
    const candidateModels = modelCandidates(modelChoice, this.getClaudeWorkerModel());
    let lastResult: RunResult | undefined;
    let lastFailure: AgentFailureInfo | undefined;

    for (let attempt = 0; attempt < candidateModels.length; attempt++) {
      const workerModel = candidateModels[attempt];
      const args = buildClaudeArgs({
        stream: true,
        fidelity,
        systemPrompt: this.buildClaudeWorkerSystemPrompt("fast"),
        appendSystemPrompt: this.buildClaudeWorkerSystemPrompt("full-fidelity"),
        permissionMode: this.getClaudeFullFidelityPermissionMode(),
      });
      if (workerModel) args.push("--model", workerModel);
      if (attempt > 0) {
        this.emit({
          type: "agent-model",
          turnId,
          agent: "claude",
          role: "work",
          model: `${workerModel || "(CLI default)"} (auto-heal retry)`,
        });
      }

      const result = await this.runStreamingClaude({
        command: claudeBin,
        args,
        cwd,
        turnId,
        agent: "claude",
        role: "work",
        stdin: workerPrompt,
        timeoutMs:
          fidelity === "full-fidelity"
            ? CLAUDE_FULL_FIDELITY_WORKER_TIMEOUT_MS
            : CLAUDE_WORKER_TIMEOUT_MS,
        fullFidelity: fidelity === "full-fidelity",
      });
      lastResult = result;
      if (result.exitCode === 0) {
        await recordRuntimeModelResult(this.context, workerModel, true);
        if (!result.text.trim()) {
          this.emit({
            type: "agent-message",
            turnId,
            agent: "claude",
            role: "work",
            content: "(Claude returned no output.)",
          });
        }
        return result;
      }

      lastFailure = classifyAgentFailure("claude", result.text || `Claude CLI exited with code ${result.exitCode}`);
      if (lastFailure.kind === "model") {
        await recordRuntimeModelResult(this.context, workerModel, false, lastFailure.raw);
      }
      if (!shouldRetryModelFailure(lastFailure, attempt, candidateModels.length)) break;
      console.warn(
        `[claudex-council] Claude model ${workerModel || "(CLI default)"} failed (${lastFailure.kind}); trying fallback.`
      );
    }

    throw new Error(
      lastResult?.text ||
        lastFailure?.message ||
        "Claude CLI exited before a healthy model could answer."
    );
  }

  private async runCodexWorker(
    turnId: string,
    prompt: string,
    route?: DeciderRoute,
    sessionContext = "",
    councilRun?: CouncilRun,
    modelChoice?: ModelChoice
  ): Promise<RunResult> {
    const helperPath = this.getCodexHelperPath();
    if (!helperPath || !fs.existsSync(helperPath)) {
      throw new Error(
        `ask_codex.py not found. Configure 'claudexCouncil.codexHelperPath' or reinstall the skill.`
      );
    }

    const cwd = this.getWorkingDirectory();
    // Helper accepts the prompt either as positional argv or via stdin; we
    // use stdin to bypass cross-platform shell-quoting hazards (a multi-
    // word prompt as positional argv gets word-split by cmd.exe under
    // shell:true on Windows, which makes argparse explode).
    const fidelity = route?.fidelity ?? "full-fidelity";
    const timeoutSec =
      fidelity === "full-fidelity"
        ? CODEX_FULL_FIDELITY_WORKER_TIMEOUT_SEC
        : CODEX_WORKER_TIMEOUT_SEC;
    const candidateModels = modelCandidates(modelChoice, this.getCodexWorkerModel());

    const buildArgs = (model?: string): string[] => {
      const args = [
        helperPath,
        "--cwd",
        cwd,
        "--timeout",
        String(timeoutSec),
        "--fidelity",
        fidelity,
      ];
      this.appendCodexBinaryArg(args);
      if (fidelity === "full-fidelity") {
        args.push("--full-sandbox", this.getCodexFullFidelitySandbox());
        if (this.shouldBypassCodexFullFidelityApprovals()) {
          args.push("--dangerously-bypass-approvals-and-sandbox");
        }
      }
      if (model) args.push("--model", model);
      return args;
    };

    const runHelper = async (model?: string): Promise<RunResult> => {
      const result = await this.runBufferedProcess({
        command: this.getPythonBinary(),
        args: buildArgs(model),
        cwd,
        stdin: this.withPromptContext(route?.codexPrompt || prompt, sessionContext, councilRun),
        timeoutMs: (timeoutSec + 10) * 1000,
      });

      // Parse the helper's stderr for our `CLAUDEX_MODEL: <name>` marker so
      // we can update the badge from "(CLI default)" to the real model name
      // codex actually used (read out of ~/.codex/config.toml by the helper).
      const modelLine = (result.stderr || "").match(/^CLAUDEX_MODEL:\s*(.+?)\s*$/m);
      if (modelLine && modelLine[1]) {
        this.emit({
          type: "agent-model",
          turnId,
          agent: "codex",
          role: "work",
          model: modelLine[1],
        });
      }
      result.usage = extractCodexUsage(result.stderr);
      return result;
    };

    let result: RunResult | undefined;
    let lastFailure: AgentFailureInfo | undefined;
    for (let attempt = 0; attempt < candidateModels.length; attempt++) {
      const codexModel = candidateModels[attempt];
      if (attempt > 0) {
        this.emit({
          type: "agent-model",
          turnId,
          agent: "codex",
          role: "work",
          model: `${codexModel || "(CLI default)"} (auto-heal retry)`,
        });
      }
      result = await runHelper(codexModel);
      if (result.exitCode === 0) {
        await recordRuntimeModelResult(this.context, codexModel, true);
        break;
      }

      lastFailure = classifyAgentFailure(
        "codex",
        result.text || result.stderr || `codex helper exited with ${result.exitCode}`
      );
      if (lastFailure.kind === "model") {
        await recordRuntimeModelResult(this.context, codexModel, false, lastFailure.raw);
      }
      if (!shouldRetryModelFailure(lastFailure, attempt, candidateModels.length)) break;
      console.warn(
        `[claudex-council] Codex model ${codexModel || "(CLI default)"} failed (${lastFailure.kind}); trying fallback.`
      );
    }
    if (!result) {
      throw new Error("Codex helper exited before a model attempt could start.");
    }

    if (this.cancelled) return result;

    if (result.exitCode === 0) {
      const content = result.text.trim() || "(Codex returned no output.)";
      this.emit({
        type: "agent-message",
        turnId,
        agent: "codex",
        role: "work",
        content,
      });
      this.emit({ type: "agent-status", turnId, agent: "codex", status: "done" });
      return { ...result, text: content };
    } else if (result.exitCode !== 0) {
      throw new Error(
        result.text ||
          result.stderr ||
          lastFailure?.message ||
          `codex helper exited with ${result.exitCode}`
      );
    }
    return result;
  }

  private shouldRunDeliberation(
    route: DeciderRoute,
    claudeOk: boolean,
    codexOk: boolean
  ): boolean {
    if (!route.runCodex || !route.runSynthesis) return false;
    if (!claudeOk || !codexOk) return false;
    const mode = this.getDeliberationMode();
    if (mode === "off") return false;
    if (mode === "always") return true;
    return !route.fastClaude && route.mode === "full-council";
  }

  private shouldRunClarificationCoordinator(
    route: DeciderRoute,
    claudeText: string,
    codexText: string,
    councilRun: CouncilRun
  ): boolean {
    if (!route.runSynthesis) return false;
    if (route.fastClaude) return false;
    if (councilRun.pendingClarifications.length > 0) return true;
    if (route.confidence === "low") return true;
    const combined = `${claudeText}\n${codexText}`.toLowerCase();
    return /\b(clarify|confirm|question|blocked|need to know|before (i|we) can|which output|what output)\b/.test(combined);
  }

  private async runClarificationCoordinator(
    turnId: string,
    userPrompt: string,
    claudeOut: string,
    codexOut: string,
    route: DeciderRoute,
    sessionContext: string,
    councilRun: CouncilRun
  ): Promise<ClarificationReview> {
    const fallback = (): ClarificationReview => ({
      needsClarification: councilRun.pendingClarifications.length > 0,
      questions: councilRun.pendingClarifications.map((q) => q.question),
      rationale: "Heuristic clarification extraction.",
    });

    this.emit({
      type: "agent-status",
      turnId,
      agent: "decider",
      role: "review",
      status: "running",
    });
    this.emit({
      type: "agent-model",
      turnId,
      agent: "decider",
      role: "review",
      model: this.getCoordinatorModel() || "(clarification coordinator)",
    });

    try {
      const args = buildClaudeArgs({
        stream: false,
        fidelity: route.fidelity,
        systemPrompt: DEFAULT_CLARIFICATION_SYSTEM_PROMPT,
        appendSystemPrompt:
          "You are coordinating Claude and Codex. Ask the user only for information that blocks a useful answer or safe execution.",
        permissionMode: this.getClaudeFullFidelityPermissionMode(),
      });
      const model = this.getCoordinatorModel();
      if (model) args.push("--model", model);
      const result = await this.runBufferedProcess({
        command: this.getClaudeBinary(),
        args,
        cwd: this.getWorkingDirectory(),
        stdin: this.buildClarificationPrompt(
          userPrompt,
          claudeOut,
          codexOut,
          route,
          sessionContext,
          councilRun
        ),
        timeoutMs:
          route.fidelity === "full-fidelity"
            ? CLAUDE_FULL_FIDELITY_REVIEW_TIMEOUT_MS
            : CLAUDE_REVIEW_TIMEOUT_MS,
        fullFidelity: route.fidelity === "full-fidelity",
      });
      if (result.exitCode !== 0) return fallback();
      return parseClarificationReview(extractClaudePrintText(result.text)) || fallback();
    } catch (err) {
      console.warn(
        `[claudex-council] clarification coordinator failed for turn ${turnId}: ${String(err).slice(0, 400)}`
      );
      return fallback();
    } finally {
      this.emit({
        type: "agent-status",
        turnId,
        agent: "decider",
        role: "review",
        status: "done",
      });
    }
  }

  private buildClarificationPrompt(
    userPrompt: string,
    claudeOut: string,
    codexOut: string,
    route: DeciderRoute,
    sessionContext: string,
    councilRun: CouncilRun
  ): string {
    return [
      this.getPromptContextPack(sessionContext, councilRun),
      "",
      "<USER_REQUEST>",
      userPrompt,
      "</USER_REQUEST>",
      "",
      "<COORDINATOR_PLAN>",
      route.coordination ? renderCoordinatorPlan(route.coordination) : route.planText,
      "</COORDINATOR_PLAN>",
      "",
      "<CLAUDE_OUTPUT>",
      claudeOut.trim() || "(empty)",
      "</CLAUDE_OUTPUT>",
      "",
      "<CODEX_OUTPUT>",
      codexOut.trim() || "(empty)",
      "</CODEX_OUTPUT>",
      "",
      "Decide whether the council must ask the user a merged clarification before continuing.",
      "Return JSON only:",
      "{",
      '  "needs_clarification": true,',
      '  "questions": ["one concise user-facing question"],',
      '  "rationale": "brief reason"',
      "}",
      "",
      "Rules:",
      "- Ask only if the missing information blocks a useful or safe response.",
      "- Merge duplicate Claude/Codex questions into the smallest set.",
      "- Do not ask optional preference questions; make a reasonable assumption instead.",
      "- If the agents can proceed from session/project context, set needs_clarification=false and questions=[].",
    ].join("\n");
  }

  private async runDeliberation(
    turnId: string,
    userPrompt: string,
    claudeOut: string,
    codexOut: string,
    route: DeciderRoute,
    sessionContext: string
  ): Promise<DeliberationResult> {
    this.emit({ type: "agent-status", turnId, agent: "claude", role: "review", status: "running" });
    this.emit({ type: "agent-status", turnId, agent: "codex", role: "review", status: "running" });
    this.emit({
      type: "agent-model",
      turnId,
      agent: "claude",
      role: "review",
      model: this.getClaudeWorkerModel() || "(CLI default)",
    });
    this.emit({
      type: "agent-model",
      turnId,
      agent: "codex",
      role: "review",
      model: this.getCodexWorkerModel() || "(CLI default)",
    });

    const claudeStart = Date.now();
    const codexStart = Date.now();
    const [claudeReview, codexReview] = await Promise.allSettled([
      this.runClaudeReview(turnId, userPrompt, claudeOut, codexOut, route, sessionContext).then((r) => {
        this.emit({
          type: "agent-timing",
          turnId,
          agent: "claude",
          role: "review",
          elapsedMs: Date.now() - claudeStart,
          usage: r.usage,
        });
        return r;
      }),
      this.runCodexReview(turnId, userPrompt, claudeOut, codexOut, route, sessionContext).then((r) => {
        this.emit({
          type: "agent-timing",
          turnId,
          agent: "codex",
          role: "review",
          elapsedMs: Date.now() - codexStart,
          usage: r.usage,
        });
        return r;
      }),
    ]);

    const claudeText =
      claudeReview.status === "fulfilled"
        ? claudeReview.value.text.trim()
        : friendlyAgentError("Claude review", String(claudeReview.reason));
    const codexText =
      codexReview.status === "fulfilled"
        ? codexReview.value.text.trim()
        : friendlyAgentError("Codex review", String(codexReview.reason));

    if (claudeReview.status !== "fulfilled") {
      console.warn(
        `[claudex-council] claude deliberation failed silently for turn ${turnId}: ${String(claudeReview.reason).slice(0, 400)}`
      );
      this.emit({ type: "agent-status", turnId, agent: "claude", role: "review", status: "done" });
    }
    if (codexReview.status !== "fulfilled") {
      console.warn(
        `[claudex-council] codex deliberation failed silently for turn ${turnId}: ${String(codexReview.reason).slice(0, 400)}`
      );
      this.emit({ type: "agent-status", turnId, agent: "codex", role: "review", status: "done" });
    }

    return { claudeReview: claudeText, codexReview: codexText };
  }

  private async runClaudeReview(
    turnId: string,
    userPrompt: string,
    claudeOut: string,
    codexOut: string,
    route: DeciderRoute,
    sessionContext: string
  ): Promise<RunResult> {
    const args = buildClaudeArgs({
      stream: true,
      fidelity: route.fidelity,
      systemPrompt: DEFAULT_REVIEW_SYSTEM_PROMPT,
      appendSystemPrompt: DEFAULT_FULL_FIDELITY_REVIEW_APPEND_PROMPT,
      permissionMode: this.getClaudeFullFidelityPermissionMode(),
    });
    const model = this.getClaudeWorkerModel();
    if (model) args.push("--model", model);

    const result = await this.runStreamingClaude({
      command: this.getClaudeBinary(),
      args,
      cwd: this.getWorkingDirectory(),
      turnId,
      agent: "claude",
      role: "review",
      stdin: this.withPromptContext(
        buildReviewPrompt({
          reviewer: "Claude",
          peer: "Codex",
          userPrompt,
          ownOutput: claudeOut,
          peerOutput: codexOut,
          route,
        }),
        sessionContext
      ),
      timeoutMs:
        route.fidelity === "full-fidelity"
          ? CLAUDE_FULL_FIDELITY_REVIEW_TIMEOUT_MS
          : CLAUDE_REVIEW_TIMEOUT_MS,
      fullFidelity: route.fidelity === "full-fidelity",
    });
    if (result.exitCode !== 0) {
      throw new Error(result.text || `Claude review exited with code ${result.exitCode}`);
    }
    return result;
  }

  private async runCodexReview(
    turnId: string,
    userPrompt: string,
    claudeOut: string,
    codexOut: string,
    route: DeciderRoute,
    sessionContext: string
  ): Promise<RunResult> {
    const helperPath = this.getCodexHelperPath();
    if (!helperPath || !fs.existsSync(helperPath)) {
      throw new Error("Codex helper not found - can't route deliberation through Codex.");
    }
    const timeoutSec =
      route.fidelity === "full-fidelity"
        ? CODEX_FULL_FIDELITY_REVIEW_TIMEOUT_SEC
        : CODEX_REVIEW_TIMEOUT_SEC;
    const args = [
      helperPath,
      "--cwd",
      this.getWorkingDirectory(),
      "--timeout",
      String(timeoutSec),
      "--fidelity",
      route.fidelity,
    ];
    this.appendCodexBinaryArg(args);
    if (route.fidelity === "full-fidelity") {
      args.push("--full-sandbox", this.getCodexFullFidelitySandbox());
      if (this.shouldBypassCodexFullFidelityApprovals()) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      }
    }
    const model = this.getCodexWorkerModel();
    if (model) args.push("--model", model);

    const result = await this.runBufferedProcess({
      command: this.getPythonBinary(),
      args,
      cwd: this.getWorkingDirectory(),
      stdin: this.withPromptContext(
        buildReviewPrompt({
          reviewer: "Codex",
          peer: "Claude",
          userPrompt,
          ownOutput: codexOut,
          peerOutput: claudeOut,
          route,
        }),
        sessionContext
      ),
      timeoutMs: (timeoutSec + 10) * 1000,
    });

    const modelLine = (result.stderr || "").match(/^CLAUDEX_MODEL:\s*(.+?)\s*$/m);
    if (modelLine && modelLine[1]) {
      this.emit({
        type: "agent-model",
        turnId,
        agent: "codex",
        role: "review",
        model: modelLine[1],
      });
    }
    result.usage = extractCodexUsage(result.stderr);
    if (result.exitCode !== 0) {
      throw new Error(result.text || `Codex review exited with code ${result.exitCode}`);
    }
    const content = result.text.trim() || "(Codex returned no deliberation note.)";
    this.emit({
      type: "agent-message",
      turnId,
      agent: "codex",
      role: "review",
      content,
    });
    this.emit({ type: "agent-status", turnId, agent: "codex", role: "review", status: "done" });
    return { ...result, text: content };
  }

  private async runSynthesis(
    turnId: string,
    userPrompt: string,
    claudeOut: string,
    codexOut: string,
    route: DeciderRoute,
    deliberation?: DeliberationResult,
    sessionContext = "",
    councilRun?: CouncilRun,
    modelChoice?: ModelChoice
  ): Promise<RunResult> {
    // Synthesis can run via Claude or Codex depending on the user's pick
    // in the Decider dropdown. The prompt body is provider-agnostic; the
    // only routing decision is which CLI we shell to.
    const promptContext = this.getPromptContextPack(sessionContext, councilRun);
    const synthPrompt = [
      "You are the synthesizer in a two-agent council. Two agents have already answered the user's question independently. Your job is to write ONE final answer the user will read.",
      "",
      promptContext,
      "",
      "<USER_QUESTION>",
      userPrompt,
      "</USER_QUESTION>",
      "",
      "<COORDINATOR_PLAN>",
      route.coordination ? renderCoordinatorPlan(route.coordination) : route.planText,
      "</COORDINATOR_PLAN>",
      "",
      "<CLAUDE_RESPONSE>",
      claudeOut.trim() || "(Claude did not return a response)",
      "</CLAUDE_RESPONSE>",
      "",
      "<CODEX_RESPONSE>",
      codexOut.trim() || "(Codex did not return a response)",
      "</CODEX_RESPONSE>",
      "",
      ...(deliberation
        ? [
            "<DELIBERATION>",
            "<CLAUDE_REVIEW_OF_CODEX>",
            deliberation.claudeReview || "(Claude did not return a deliberation note)",
            "</CLAUDE_REVIEW_OF_CODEX>",
            "",
            "<CODEX_REVIEW_OF_CLAUDE>",
            deliberation.codexReview || "(Codex did not return a deliberation note)",
            "</CODEX_REVIEW_OF_CLAUDE>",
            "</DELIBERATION>",
            "",
          ]
        : []),
      "Write the final answer to the USER_QUESTION above:",
      "- Lead with the direct answer or recommendation.",
      "- Keep it compact: 3-8 short paragraphs or bullets by default, unless the user asked for code, logs, or a detailed plan.",
      "- Compose the answer according to COORDINATOR_PLAN; treat Claude and Codex as assigned lanes, not duplicate contestants.",
      "- Use COUNCIL_LEDGER to preserve task ownership, decisions, blockers, and resolved clarifications from the session.",
      "- Use DELIBERATION to catch gaps, contradictions, and strong ideas before finalizing.",
      "- Where they agreed, just state the conclusion (don't recap each).",
      "- Where an output wandered outside its lane, prefer the agent assigned to that lane unless the other found a concrete bug.",
      "- If one agent failed, just rely on the other.",
      "- Be concise. Do not re-quote worker drafts at length.",
      "- Do NOT begin with 'Here is the synthesis' or any preamble. Just answer.",
      "- Do NOT comment on the user's prompt being short or unclear unless the original USER_QUESTION genuinely is.",
    ].join("\n");

    const deciderModel = modelChoice?.model || this.getDeciderModel();
    const provider =
      findModel(deciderModel)?.provider === "codex" ? "codex" : this.getDeciderProvider();
    const candidateModels = modelCandidates(modelChoice, deciderModel);

    if (provider === "codex") {
      // Route synthesis through the Codex helper. Codex's reply lands as
      // a single buffered message rather than a token stream, so the
      // synthesis bubble fills in one shot — fine for the final summary.
      const helperPath = this.getCodexHelperPath();
      if (!helperPath || !fs.existsSync(helperPath)) {
        throw new Error("Codex helper not found — can't route synthesis through Codex.");
      }
      return this.runCodexSynthesisWithModelHealing(
        turnId,
        synthPrompt,
        route,
        candidateModels,
        helperPath
      );
      // Same stderr-MODEL parsing trick we use for the Codex worker — the
    }

    // Default: Claude synthesis with streaming. Same fast-args treatment
    // as the worker — synthesis is the single most expensive call in the
    // turn, so trimming the cold start matters most here.
    return this.runClaudeSynthesisWithModelHealing(
      turnId,
      synthPrompt,
      route,
      candidateModels
    );
  }

  private async runCodexSynthesisWithModelHealing(
    turnId: string,
    synthPrompt: string,
    route: DeciderRoute,
    candidateModels: string[],
    helperPath: string
  ): Promise<RunResult> {
    const cwd = this.getWorkingDirectory();
    const timeoutSec =
      route.fidelity === "full-fidelity"
        ? CODEX_FULL_FIDELITY_SYNTHESIS_TIMEOUT_SEC
        : CODEX_SYNTHESIS_TIMEOUT_SEC;
    let lastResult: RunResult | undefined;
    let lastFailure: AgentFailureInfo | undefined;

    for (let attempt = 0; attempt < candidateModels.length; attempt++) {
      const model = candidateModels[attempt];
      const args = [
        helperPath,
        "--cwd",
        cwd,
        "--timeout",
        String(timeoutSec),
        "--fidelity",
        route.fidelity,
      ];
      this.appendCodexBinaryArg(args);
      if (route.fidelity === "full-fidelity") {
        args.push("--full-sandbox", this.getCodexFullFidelitySandbox());
        if (this.shouldBypassCodexFullFidelityApprovals()) {
          args.push("--dangerously-bypass-approvals-and-sandbox");
        }
      }
      if (model) args.push("--model", model);
      if (attempt > 0) {
        this.emit({
          type: "agent-model",
          turnId,
          agent: "decider",
          role: "synthesis",
          model: `${model || "(CLI default)"} (auto-heal retry)`,
        });
      }

      const result = await this.runBufferedProcess({
        command: this.getPythonBinary(),
        args,
        cwd,
        stdin: synthPrompt,
        timeoutMs: (timeoutSec + 10) * 1000,
      });
      const modelLine = (result.stderr || "").match(/^CLAUDEX_MODEL:\s*(.+?)\s*$/m);
      if (modelLine && modelLine[1]) {
        this.emit({
          type: "agent-model",
          turnId,
          agent: "decider",
          role: "synthesis",
          model: modelLine[1],
        });
      }
      result.usage = extractCodexUsage(result.stderr);
      lastResult = result;
      if (result.exitCode === 0) {
        await recordRuntimeModelResult(this.context, model, true);
        return result;
      }

      lastFailure = classifyAgentFailure(
        "council",
        result.text || result.stderr || `Codex synthesis exited with code ${result.exitCode}`
      );
      if (lastFailure.kind === "model") {
        await recordRuntimeModelResult(this.context, model, false, lastFailure.raw);
      }
      if (!shouldRetryModelFailure(lastFailure, attempt, candidateModels.length)) break;
      console.warn(
        `[claudex-council] Codex synthesis model ${model || "(CLI default)"} failed (${lastFailure.kind}); trying fallback.`
      );
    }

    throw new Error(
      lastResult?.text ||
        lastResult?.stderr ||
        lastFailure?.message ||
        "Codex synthesis exited before a healthy model could answer."
    );
  }

  private async runClaudeSynthesisWithModelHealing(
    turnId: string,
    synthPrompt: string,
    route: DeciderRoute,
    candidateModels: string[]
  ): Promise<RunResult> {
    let lastResult: RunResult | undefined;
    let lastFailure: AgentFailureInfo | undefined;

    for (let attempt = 0; attempt < candidateModels.length; attempt++) {
      const model = candidateModels[attempt];
      const args = buildClaudeArgs({
        stream: true,
        fidelity: route.fidelity,
        systemPrompt: DEFAULT_SYNTHESIS_SYSTEM_PROMPT,
        appendSystemPrompt: DEFAULT_FULL_FIDELITY_SYNTHESIS_APPEND_PROMPT,
        permissionMode: this.getClaudeFullFidelityPermissionMode(),
      });
      if (model) args.push("--model", model);
      if (attempt > 0) {
        this.emit({
          type: "agent-model",
          turnId,
          agent: "decider",
          role: "synthesis",
          model: `${model || "(CLI default)"} (auto-heal retry)`,
        });
      }

      const result = await this.runStreamingClaude({
        command: this.getClaudeBinary(),
        args,
        cwd: this.getWorkingDirectory(),
        turnId,
        agent: "decider",
        role: "synthesis",
        suppressFinalMessage: false,
        stdin: synthPrompt,
        timeoutMs:
          route.fidelity === "full-fidelity"
            ? CLAUDE_FULL_FIDELITY_SYNTHESIS_TIMEOUT_MS
            : CLAUDE_SYNTHESIS_TIMEOUT_MS,
        fullFidelity: route.fidelity === "full-fidelity",
      });
      lastResult = result;
      if (result.exitCode === 0) {
        await recordRuntimeModelResult(this.context, model, true);
        return result;
      }

      lastFailure = classifyAgentFailure("council", result.text || `Claude synthesis exited with code ${result.exitCode}`);
      if (lastFailure.kind === "model") {
        await recordRuntimeModelResult(this.context, model, false, lastFailure.raw);
      }
      if (!shouldRetryModelFailure(lastFailure, attempt, candidateModels.length)) break;
      console.warn(
        `[claudex-council] Claude synthesis model ${model || "(CLI default)"} failed (${lastFailure.kind}); trying fallback.`
      );
    }

    throw new Error(
      lastResult?.text ||
        lastFailure?.message ||
        "Claude synthesis exited before a healthy model could answer."
    );
  }

  // ---------- low-level process helpers ----------

  /**
   * Spawn `claude -p --output-format stream-json --include-partial-messages`
   * and translate its event stream into UI chunks. Returns the assembled
   * full text once the process exits.
   *
   * Claude's stream-json events look like:
   *   { "type": "stream_event", "event": { "type": "content_block_delta",
   *       "delta": { "type": "text_delta", "text": "..." }, ... }, ... }
   * plus an envelope event with the final result. We extract `text_delta`
   * fragments and forward them as `agent-chunk` events.
   */
  private runStreamingClaude(opts: {
    command: string;
    args: string[];
    cwd: string;
    turnId: string;
    agent: AgentId;
    role: BubbleRole;
    suppressFinalMessage?: boolean;
    fullFidelity?: boolean;
    /**
     * Optional prompt body to pipe into the child via stdin. Strongly
     * preferred over positional argv — shell:true on Windows word-splits
     * argv on spaces, so any multi-word prompt sent as argv gets mangled.
     */
    stdin?: string;
    timeoutMs?: number;
  }): Promise<RunResult> {
    return new Promise((resolve) => {
      let proc: ChildProcess;
      try {
        proc = spawn(
          opts.command,
          opts.args,
          getSpawnOptions(opts.cwd, { fullFidelity: opts.fullFidelity === true })
        );
      } catch (err) {
        resolve({ text: `(failed to spawn ${opts.command}: ${err})`, exitCode: -1 });
        return;
      }
      this.activeProcesses.add(proc);

      proc.stdin?.on("error", () => undefined);
      if (opts.stdin !== undefined) {
        // Write the prompt asynchronously so we don't EPIPE if claude
        // closes stdin before reading. write() then end() is safer than
        // end(buf) for long inputs because end-with-data can race the
        // child's shutdown of its own stdin.
        try {
          proc.stdin?.write(opts.stdin, "utf8");
          proc.stdin?.end();
        } catch {
          // EPIPE during the write — the child closed stdin already.
          // Not fatal; we'll still capture whatever it produced.
        }
      } else {
        proc.stdin?.end();
      }

      // StringDecoder handles multi-byte UTF-8 sequences split across
      // chunk boundaries. Plain `chunk.toString("utf8")` would replace
      // the partial sequence with U+FFFD; the decoder buffers the partial
      // bytes and emits them when the next chunk completes the sequence.
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");

      let stdoutBuf = "";
      let stderrBuf = "";
      let assembled = "";
      let usage: AgentUsage | undefined;
      // Hard cap on a single line. JSONL events should be at most a few KB.
      // If we ever see a line larger than this without a newline, the
      // stream is malformed — we'll discard the buffer to avoid OOM.
      const MAX_LINE_BYTES = 256 * 1024;
      // Guard against double-resolve when both `error` and `close` fire
      // for the same process (rare, but spec-allowed).
      let settled = false;
      let timedOut = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      const safeResolve = (r: RunResult) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve(r);
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          console.warn(
            `[claudex-council] ${opts.agent}/${opts.role} exceeded ${opts.timeoutMs}ms; killing process tree.`
          );
          killProcessTree(proc);
        }, opts.timeoutMs);
      }
      // Track terminal events from claude's stream so we can distinguish
      // "model finished cleanly" from "process died mid-stream". Either
      // a `result` envelope OR a `message_stop` stream_event is enough
      // to call the response complete.
      let sawTerminalEvent = false;
      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (isClaudeTerminalEvent(parsed)) {
          sawTerminalEvent = true;
        }
        usage = mergeUsage(usage, extractClaudeUsage(parsed));
        if (
          parsed?.type === "result" &&
          typeof parsed.result === "string" &&
          parsed.result.trim() &&
          !assembled.trim()
        ) {
          assembled = parsed.result;
          if (!opts.suppressFinalMessage) {
            this.emit({
              type: "agent-message",
              turnId: opts.turnId,
              agent: opts.agent,
              role: opts.role,
              content: parsed.result,
            });
          }
        }
        this.handleClaudeStreamEvent(parsed, opts, (delta) => {
          assembled += delta;
        });
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += stdoutDecoder.write(chunk);
        if (stdoutBuf.length > MAX_LINE_BYTES) {
          // Malformed stream with no newlines — drop and recover.
          console.warn(
            `[claudex-council] stdout line exceeded ${MAX_LINE_BYTES}b without ` +
              `a newline; discarding buffer to avoid OOM.`
          );
          stdoutBuf = "";
          return;
        }
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          processLine(line);
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += stderrDecoder.write(chunk);
      });

      proc.on("error", (err) => {
        this.activeProcesses.delete(proc);
        safeResolve({ text: `(spawn error: ${err.message})`, exitCode: -1 });
      });

      proc.on("close", (code) => {
        this.activeProcesses.delete(proc);
        // Flush any remaining bytes from the decoders.
        stdoutBuf += stdoutDecoder.end();
        stderrBuf += stderrDecoder.end();
        processLine(stdoutBuf);
        stdoutBuf = "";
        if (this.cancelled) {
          safeResolve({ text: assembled, exitCode: code, usage });
          return;
        }
        // Per Codex's policy + our streaming health check:
        //   sawTerminalEvent + content ≥ 4 chars  → real success
        //   content but no terminal event           → partial (truncated)
        //   no content at all                       → real failure
        // Non-zero exit + complete stream  → cleanup noise, treat as success
        //                                    AND log so we can investigate
        //                                    why claude exited non-zero
        //                                    (likely MCP/plugin teardown).
        const haveContent = assembled.trim().length >= 4;
        if (timedOut && !haveContent) {
          safeResolve({
            text: `Claude CLI timed out after ${formatDurationMs(opts.timeoutMs || 0)}`,
            exitCode: 124,
            usage,
          });
          return;
        }
        if (code !== 0 && haveContent && sawTerminalEvent) {
          // Genuine success that hit a cleanup-time non-zero exit. Log
          // the cleanup error so we can find the upstream bug, but do
          // not propagate it as a failure — the user has their answer.
          console.warn(
            `[claudex-council] post-stream cleanup exit (${code}) from claude ` +
              `(${opts.agent}/${opts.role}) — got ${assembled.length} chars + terminal event. ` +
              `stderr: ${stderrBuf.slice(0, 300) || "(empty)"}`
          );
          if (opts.agent === "claude") {
            this.emit({ type: "agent-status", turnId: opts.turnId, agent: "claude", role: opts.role, status: "done" });
          }
          safeResolve({ text: assembled, exitCode: 0, usage });
          return;
        }
        if (code !== 0 && haveContent && !sawTerminalEvent) {
          // Stream truncated mid-reply. Show what we got — better partial
          // than nothing. Log for diagnosis.
          console.warn(
            `[claudex-council] truncated claude stream (${opts.agent}/${opts.role}) ` +
              `exit=${code}, got ${assembled.length} chars but no terminal event. ` +
              `stderr: ${stderrBuf.slice(0, 300) || "(empty)"}`
          );
          if (opts.agent === "claude") {
            this.emit({ type: "agent-status", turnId: opts.turnId, agent: "claude", role: opts.role, status: "done" });
          }
          safeResolve({ text: assembled, exitCode: 0, usage });
          return;
        }
        if (code !== 0) {
          // No content received at all: real failure. Return it promptly so
          // the turn can fall back instead of spending another full call.
          const errText = stderrBuf.trim() || `claude exited with code ${code}`;
          safeResolve({ text: assembled || `Claude CLI failed: ${errText.slice(0, 500)}`, exitCode: code, usage });
          return;
        }
        if (opts.agent === "claude") {
          this.emit({ type: "agent-status", turnId: opts.turnId, agent: "claude", role: opts.role, status: "done" });
        }
        safeResolve({ text: assembled, exitCode: code, usage });
      });
    });
  }

  /**
   * Parse one JSONL line from claude's stream-json output. We only care
   * about text deltas inside content_block_delta events and the final
   * `result` envelope event (which contains the full assembled text — we
   * don't re-emit since chunks have already streamed).
   */
  private handleClaudeStreamEvent(
    parsed: any,
    opts: { turnId: string; agent: AgentId; role: BubbleRole },
    onDelta: (text: string) => void
  ): void {
    // The `system` init event Claude emits at the start of every -p run
    // contains the actual resolved model name. Re-emit `agent-model` with
    // the real value so the badge in the UI changes from "(CLI default)"
    // to the concrete model the API picked.
    if (parsed?.type === "system") {
      const model: string | undefined = parsed.model;
      if (model && typeof model === "string") {
        this.emit({
          type: "agent-model",
          turnId: opts.turnId,
          agent: opts.agent,
          role: opts.role,
          model,
        });
      }
    }

    // The first `assistant` envelope also carries `message.model` — useful
    // as a backup if the system event was missing for any reason. Cheap to
    // re-emit; the webview just overwrites the badge text.
    if (parsed?.type === "assistant" && parsed.message?.model) {
      this.emit({
        type: "agent-model",
        turnId: opts.turnId,
        agent: opts.agent,
        role: opts.role,
        model: parsed.message.model,
      });
    }

    // With --include-partial-messages on, claude emits one stream_event per
    // text delta. We intentionally do NOT also handle the final `assistant`
    // envelope's content — it carries the *full assembled text*, and treating
    // it as another chunk would duplicate everything that already streamed.
    if (parsed?.type === "stream_event") {
      const ev = parsed.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        const text: string = ev.delta.text || "";
        if (text) {
          this.emit({
            type: "agent-chunk",
            turnId: opts.turnId,
            agent: opts.agent,
            role: opts.role,
            content: text,
          });
          onDelta(text);
        }
      }
    }
  }

  /**
   * Spawn a child process, capture all stdout, return when it exits.
   * Used for the Codex helper which already buffers and emits a clean
   * final answer.
   */
  private runBufferedProcess(opts: {
    command: string;
    args: string[];
    cwd: string;
    stdin?: string;
    timeoutMs?: number;
    fullFidelity?: boolean;
  }): Promise<RunResult> {
    return new Promise((resolve) => {
      let proc: ChildProcess;
      try {
        proc = spawn(
          opts.command,
          opts.args,
          getSpawnOptions(opts.cwd, { fullFidelity: opts.fullFidelity === true })
        );
      } catch (err) {
        resolve({ text: `(failed to spawn ${opts.command}: ${err})`, exitCode: -1 });
        return;
      }
      this.activeProcesses.add(proc);

      proc.stdin?.on("error", () => undefined);
      if (opts.stdin !== undefined) {
        try {
          proc.stdin?.write(opts.stdin, "utf8");
          proc.stdin?.end();
        } catch {
          /* child closed stdin early */
        }
      } else {
        proc.stdin?.end();
      }

      let stdout = "";
      let stderr = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
      let settled = false;
      let timedOut = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      const safeResolve = (r: RunResult) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve(r);
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          console.warn(
            `[claudex-council] buffered process exceeded ${opts.timeoutMs}ms; killing process tree.`
          );
          killProcessTree(proc);
        }, opts.timeoutMs);
      }
      proc.stdout?.on("data", (b: Buffer) => {
        stdout += stdoutDecoder.write(b);
        if (stdout.length > MAX_BUFFER_BYTES) {
          stdout = stdout.slice(-MAX_BUFFER_BYTES);
        }
      });
      proc.stderr?.on("data", (b: Buffer) => {
        stderr += stderrDecoder.write(b);
        if (stderr.length > MAX_BUFFER_BYTES) {
          stderr = stderr.slice(-MAX_BUFFER_BYTES);
        }
      });
      proc.on("error", (err) => {
        this.activeProcesses.delete(proc);
        safeResolve({ text: `(spawn error: ${err.message})`, exitCode: -1 });
      });
      proc.on("close", (code) => {
        this.activeProcesses.delete(proc);
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        if (timedOut) {
          safeResolve({
            text: stderr || stdout || `process timed out after ${formatDurationMs(opts.timeoutMs || 0)}`,
            exitCode: 124,
            stderr,
          });
          return;
        }
        if (code !== 0) {
          safeResolve({ text: stderr || stdout || `exit ${code}`, exitCode: code, stderr });
        } else {
          safeResolve({ text: stdout, exitCode: code, stderr });
        }
      });
    });
  }

  // ---------- environment / config ----------

  private getClaudeBinary(): string {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    const configured = cfg.get<string>("claudeBinary");
    if (configured && configured.trim()) return configured;
    // Fall back to a manual lookup that handles macOS-from-Dock PATH gaps
    // (Homebrew, npm-global, ~/.local/bin) before defaulting to a bare name
    // that relies on the inherited PATH being correct.
    return resolveBinary("claude") || "claude";
  }

  private getPythonBinary(): string {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    const configured = cfg.get<string>("pythonBinary");
    if (configured && configured.trim()) return configured;

    // On macOS and most Linux distros, the system 'python' binary is either
    // missing or aliased to Python 2. 'python3' is what users actually have.
    // On Windows the installer adds 'python', and 'python3' is sometimes
    // missing, so we keep that as the Windows default. resolveBinary falls
    // back to well-known dirs when PATH is stripped (macOS GUI launches).
    const preferred = process.platform === "win32" ? "python" : "python3";
    return resolveBinary(preferred) || preferred;
  }

  private isEconomyMode(): boolean {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    return cfg.get<boolean>("economyMode") === true;
  }

  private getCouncilFidelity(): CouncilFidelity {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    // Fallback default tracks package.json's default so a missing key
    // behaves the same as a fresh install. Changing the package.json
    // default also requires updating this fallback.
    const value = (cfg.get<string>("councilFidelity") || "full-fidelity").trim();
    return value === "fast" ? "fast" : "full-fidelity";
  }

  private getCoordinatorMode(): CoordinatorMode {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    const value = (cfg.get<string>("coordinatorMode") || "local").trim();
    return value === "model" ? "model" : "local";
  }

  private getDeliberationMode(): DeliberationMode {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    const value = (cfg.get<string>("deliberationMode") || "off").trim();
    if (value === "always" || value === "off") return value;
    return "auto";
  }

  private getClaudeFullFidelityPermissionMode(): ClaudePermissionMode {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    const value = (cfg.get<string>("claudeFullFidelityPermissionMode") || "auto").trim();
    const allowed = new Set<ClaudePermissionMode>([
      "default",
      "acceptEdits",
      "auto",
      "bypassPermissions",
      "dontAsk",
      "plan",
    ]);
    return allowed.has(value as ClaudePermissionMode)
      ? (value as ClaudePermissionMode)
      : "auto";
  }

  private getCodexFullFidelitySandbox(): CodexFullFidelitySandbox {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    const value = (cfg.get<string>("codexFullFidelitySandbox") || "inherit").trim();
    const allowed = new Set<CodexFullFidelitySandbox>([
      "inherit",
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]);
    return allowed.has(value as CodexFullFidelitySandbox)
      ? (value as CodexFullFidelitySandbox)
      : "inherit";
  }

  private shouldBypassCodexFullFidelityApprovals(): boolean {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    return cfg.get<boolean>("codexFullFidelityBypassApprovalsAndSandbox") === true;
  }

  private buildClaudeWorkerSystemPrompt(fidelity: CouncilFidelity): string {
    const parts = [
      fidelity === "full-fidelity"
        ? DEFAULT_FULL_FIDELITY_WORKER_APPEND_PROMPT
        : DEFAULT_WORKER_SYSTEM_PROMPT,
    ];
    const caveman = this.getCavemanDirective();
    if (caveman) parts.push(caveman);
    return parts.join("\n\n");
  }

  private getCavemanDirective(): string | undefined {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    const mode = (cfg.get<string>("cavemanMode") || "auto").trim().toLowerCase();
    if (mode === "off") return undefined;

    const level = mode === "auto" ? "full" : mode;
    if (mode === "auto" && !findCavemanSkillPath()) return undefined;

    return buildCavemanDirective(level);
  }

  /**
   * Read the current model for a slot. Per-session dropdown selection wins
   * if SessionPanel provided a getter; otherwise fall back to VS Code
   * settings (kept for backward compat and headless usage).
   */
  private getSlotModel(slot: ModelSlot, settingKey: string): string {
    if (this.getSelections) {
      const sel = this.getSelections();
      if (sel && sel[slot]) return sel[slot];
    }
    return (
      vscode.workspace.getConfiguration("claudexCouncil").get<string>(settingKey) || ""
    ).trim();
  }

  private getClaudeWorkerModel(): string {
    return this.getSlotModel("claudeWorker", "claudeWorkerModel");
  }

  private getCoordinatorModel(): string {
    return this.getSlotModel("planner", "coordinatorModel");
  }

  private getCodexWorkerModel(): string {
    return this.getSlotModel("codexWorker", "codexWorkerModel");
  }

  private getCodexBinaryOverride(): string {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    return (cfg.get<string>("codexBinary") || "").trim();
  }

  private appendCodexBinaryArg(args: string[]): void {
    const binary = this.getCodexBinaryOverride();
    if (binary) args.push("--codex-binary", binary);
  }

  private getDeciderModel(): string {
    return this.getSlotModel("decider", "deciderModel");
  }

  /**
   * Which provider should run the synthesis call? If the user picked a
   * Codex model in the Decider dropdown, we route the synthesis through
   * `ask_codex.py` instead of `claude -p`. This is the single piece of
   * cross-provider routing in the orchestrator.
   */
  private getDeciderProvider(): "claude" | "codex" {
    const id = this.getDeciderModel();
    const entry = id ? findModel(id) : undefined;
    return entry?.provider === "codex" ? "codex" : "claude";
  }

  private emitCouncilActivity(
    turnId: string,
    phase: string,
    summary: string,
    state: CouncilActivityState
  ): void {
    this.emit({
      type: "council-activity",
      turnId,
      phase,
      summary,
      context: state.context,
      lanes: [toActivityLane(state.claude), toActivityLane(state.codex)],
    });
  }

  private getCouncilContextUsage(sessionContext: string): CouncilContextUsage {
    const maxChars = this.getSessionContextMaxChars();
    const usedChars = sessionContext.length;
    const percent = maxChars > 0 ? Math.min(100, Math.round((usedChars / maxChars) * 100)) : 0;
    return {
      usedChars,
      maxChars,
      percent,
      compacted:
        sessionContext.includes("Earlier session turns omitted") ||
        (maxChars > 0 && usedChars >= Math.floor(maxChars * 0.95)),
    };
  }

  private getSessionContextMaxChars(): number {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    const configured = cfg.get<number>("sessionContextMaxChars");
    const legacy = cfg.get<number>("sessionMemoryMaxChars");
    const raw = typeof configured === "number" ? configured : typeof legacy === "number" ? legacy : 48000;
    return Math.max(0, Math.min(500_000, Math.floor(raw)));
  }

  private applyKnownAgentCooldowns(
    route: DeciderRoute,
    state: CouncilActivityState,
    prompt: string
  ): void {
    const claudeLimit = this.getActiveAgentCooldown("claude");
    const codexLimit = this.getActiveAgentCooldown("codex");
    if (claudeLimit) {
      route.runClaude = false;
      route.runSynthesis = false;
      state.claude.status = "limited";
      state.claude.progress = 100;
      state.claude.note = cooldownNote(claudeLimit);
      if (!codexLimit) {
        route.runCodex = true;
        route.codexRole =
          route.codexRole ||
          "Claude is currently unavailable, so answer directly as the active Codex lane. Use the shared session context and be explicit about any limits.";
        route.codexPrompt = buildWorkerBrief("Codex", route.codexRole, route.reason, prompt);
        state.codex.status = "planning";
        state.codex.progress = Math.max(state.codex.progress, 12);
        state.codex.note = undefined;
      }
    }
    if (codexLimit && route.runCodex) {
      route.runCodex = false;
      route.runSynthesis = false;
      state.codex.status = "limited";
      state.codex.progress = 100;
      state.codex.note = cooldownNote(codexLimit);
    }
    if (!route.runCodex && state.codex.status !== "limited") {
      state.codex.status = "skipped";
      state.codex.progress = 100;
      state.codex.note = route.reason;
    }
  }

  private getActiveAgentCooldown(agent: AgentRuntimeId): AgentCooldown | undefined {
    const cooldown = this.agentCooldowns[agent];
    if (!cooldown) return undefined;
    if (cooldown.until > Date.now()) return cooldown;
    delete this.agentCooldowns[agent];
    return undefined;
  }

  private rememberAgentFailure(agent: AgentRuntimeId, info: AgentFailureInfo): void {
    // Cooldown for failures that won't self-resolve within seconds:
    // - quota: wait for the upstream window to reset
    // - auth: the user needs to run `<cli> login` — re-spawning the same
    //   broken CLI on the next turn just burns another 60s timeout
    // - missing: same logic; the binary isn't going to appear by itself
    // Other kinds (transient, model, error, timeout) may resolve on retry,
    // so we don't cool them down.
    if (info.kind !== "quota" && info.kind !== "auth" && info.kind !== "missing") return;
    const ttl =
      info.kind === "quota"
        ? AGENT_QUOTA_COOLDOWN_MS
        : AGENT_AUTH_COOLDOWN_MS;
    this.agentCooldowns[agent] = {
      info,
      until: Date.now() + ttl,
    };
  }

  private chooseHealthyModel(
    selected: string,
    defaults: readonly string[],
    unprobedDefault: string,
    reason: string,
    auto: boolean
  ): ModelChoice {
    const selectedModel = selected.trim();
    if (selectedModel) {
      const status = knownModelStatus(this.context, selectedModel);
      if (status !== "unavailable") {
        return {
          model: selectedModel,
          reason,
          auto,
          candidates: [selectedModel, ...defaults],
          preferredModel: selectedModel,
        };
      }
      const healed = pickAvailableModel(this.context, defaults, unprobedDefault);
      return {
        model: healed.model,
        reason: `${reason}; auto-healed because ${selectedModel} is known unavailable`,
        auto: true,
        candidates: healed.source === "none" ? [""] : uniqueModelCandidates([healed.model, ...defaults]),
        preferredModel: selectedModel,
      };
    }

    const picked = pickAvailableModel(this.context, defaults, unprobedDefault);
    const source =
      picked.source === "probed"
        ? " from probed account availability"
        : picked.source === "unknown"
          ? " from unprobed fallback candidates"
          : "";
    return {
      model: picked.model,
      reason: `${reason}${source}`,
      auto,
      candidates: picked.source === "none" ? [""] : uniqueModelCandidates([picked.model, ...defaults]),
      preferredModel: picked.model,
    };
  }

  private chooseClaudeWorkerModel(prompt: string, route: DeciderRoute): ModelChoice {
    const selected = this.getClaudeWorkerModel();
    if (!this.shouldUseSmartModelRouting()) {
      return this.chooseHealthyModel(
        selected,
        CLAUDE_BALANCED_CANDIDATES,
        DEFAULT_SELECTIONS.claudeWorker,
        "Manual model routing",
        false
      );
    }
    if (route.fidelity === "fast" && (route.fastClaude || isTrivialPrompt(prompt))) {
      return this.chooseHealthyModel(
        "",
        CLAUDE_FAST_CANDIDATES,
        TRIVIAL_FAST_MODEL,
        "Auto: fast conversational lane",
        true
      );
    }
    if (selected && selected !== DEFAULT_SELECTIONS.claudeWorker) {
      return this.chooseHealthyModel(
        selected,
        CLAUDE_BALANCED_CANDIDATES,
        DEFAULT_SELECTIONS.claudeWorker,
        "Manual lane model selected",
        false
      );
    }
    const candidates = isComplexPrompt(prompt)
      ? CLAUDE_COMPLEX_CANDIDATES
      : CLAUDE_BALANCED_CANDIDATES;
    return this.chooseHealthyModel(
      "",
      candidates,
      DEFAULT_SELECTIONS.claudeWorker,
      isComplexPrompt(prompt)
        ? "Auto: balanced model for complex coding/context work"
        : "Auto: balanced Claude lane",
      true
    );
  }

  private chooseCodexWorkerModel(prompt: string, _route: DeciderRoute): ModelChoice {
    const selected = this.getCodexWorkerModel();
    if (!this.shouldUseSmartModelRouting()) {
      return this.chooseHealthyModel(
        selected,
        CODEX_FAST_CANDIDATES,
        DEFAULT_SELECTIONS.codexWorker,
        "Manual model routing",
        false
      );
    }
    if (selected && selected !== DEFAULT_SELECTIONS.codexWorker) {
      return this.chooseHealthyModel(
        selected,
        CODEX_IMPLEMENTATION_CANDIDATES,
        CODEX_IMPLEMENTATION_MODEL,
        "Manual lane model selected",
        false
      );
    }
    if (isImplementationHeavyPrompt(prompt)) {
      return this.chooseHealthyModel(
        "",
        CODEX_IMPLEMENTATION_CANDIDATES,
        CODEX_IMPLEMENTATION_MODEL,
        "Auto: stronger Codex lane for implementation/review",
        true
      );
    }
    return this.chooseHealthyModel(
      "",
      CODEX_FAST_CANDIDATES,
      DEFAULT_SELECTIONS.codexWorker,
      "Auto: fast Codex lane",
      true
    );
  }

  private chooseDeciderModel(prompt: string, route: DeciderRoute): ModelChoice {
    const selected = this.getDeciderModel();
    if (!this.shouldUseSmartModelRouting()) {
      return this.chooseHealthyModel(
        selected,
        CLAUDE_DECIDER_FAST_CANDIDATES,
        DEFAULT_SELECTIONS.decider,
        "Manual model routing",
        false
      );
    }
    if (selected && selected !== DEFAULT_SELECTIONS.decider) {
      const entry = findModel(selected);
      const candidates =
        entry?.provider === "codex" ? CODEX_FAST_CANDIDATES : CLAUDE_DECIDER_FAST_CANDIDATES;
      return this.chooseHealthyModel(
        selected,
        candidates,
        entry?.provider === "codex" ? DEFAULT_SELECTIONS.codexWorker : DEFAULT_SELECTIONS.decider,
        "Manual Council answer model selected",
        false
      );
    }
    if (route.fidelity === "full-fidelity" || isComplexPrompt(prompt)) {
      return this.chooseHealthyModel(
        "",
        CLAUDE_DECIDER_COMPLEX_CANDIDATES,
        DEFAULT_SELECTIONS.claudeWorker,
        "Auto: stronger synthesis for complex work",
        true
      );
    }
    return this.chooseHealthyModel(
      "",
      CLAUDE_DECIDER_FAST_CANDIDATES,
      DEFAULT_SELECTIONS.decider,
      "Auto: fast Council synthesis",
      true
    );
  }

  private shouldUseSmartModelRouting(): boolean {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    return cfg.get<boolean>("smartModelRouting") !== false;
  }

  private getCodexHelperPath(): string {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    const configured = cfg.get<string>("codexHelperPath");
    if (configured && configured.trim()) {
      return configured;
    }

    // Primary: the helper is bundled inside the installed extension at
    //   <extensionPath>/scripts/ask_codex.py
    // This is the path that works for users who installed via VSIX,
    // regardless of whether the GitHub-distributed skill is also present.
    const bundled = path.join(this.context.extensionPath, "scripts", "ask_codex.py");
    if (fs.existsSync(bundled)) return bundled;

    // Dev fallback: when running the extension from source via F5, the
    // extension folder is .../skills/claudex-council/extension/, so the
    // sibling skill scripts/ folder is one level up.
    const sibling = path.resolve(this.context.extensionPath, "..", "scripts", "ask_codex.py");
    if (fs.existsSync(sibling)) return sibling;

    // Final fallback: user-installed skill folder.
    const homeFallback = path.join(
      os.homedir(),
      ".claude",
      "skills",
      "claudex-council",
      "scripts",
      "ask_codex.py"
    );
    return homeFallback;
  }

  private getWorkingDirectory(): string {
    const cfg = vscode.workspace.getConfiguration("claudexCouncil");
    const configured = cfg.get<string>("workingDirectory");
    if (configured && configured.trim()) return configured;

    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) return ws.uri.fsPath;
    return os.homedir();
  }

  private withPromptContext(prompt: string, sessionContext = "", councilRun?: CouncilRun): string {
    const context = this.getPromptContextPack(sessionContext, councilRun);
    if (!context) return prompt;
    return `${context}\n\n<USER_PROMPT>\n${prompt}\n</USER_PROMPT>`;
  }

  private getPromptContextPack(sessionContext = "", councilRun?: CouncilRun): string {
    return [
      sessionContext,
      councilRun ? renderLedgerForPrompt(councilRun) : "",
      this.getProjectContextPack(),
    ].filter(Boolean).join("\n\n");
  }

  private getSessionContextPack(excludeTurnId?: string): string {
    if (!this.getSessionContext) return "";
    try {
      return this.getSessionContext(excludeTurnId).trim();
    } catch (err) {
      console.warn(
        `[claudex-council] failed to build session context: ${String(err).slice(0, 300)}`
      );
      return "";
    }
  }

  private getProjectContextPack(): string {
    const cwd = this.getWorkingDirectory();
    const now = Date.now();
    let staticContext = this.staticContextCache?.value;
    if (
      !this.staticContextCache ||
      this.staticContextCache.cwd !== cwd ||
      now - this.staticContextCache.builtAt > STATIC_CONTEXT_CACHE_MS
    ) {
      staticContext = buildStaticProjectContext(cwd);
      this.staticContextCache = { cwd, builtAt: now, value: staticContext };
    }

    const activeContext = buildActiveEditorContext(cwd);
    const combined = [activeContext, staticContext].filter(Boolean).join("\n\n");
    return truncateMiddle(combined, PROJECT_CONTEXT_MAX_CHARS);
  }

  // ---------- attachments ----------

  private async persistAttachments(attachments: PromptAttachment[]): Promise<string[]> {
    const out: string[] = [];
    for (const att of attachments) {
      try {
        const m = att.dataUri.match(/^data:([^;]+);base64,(.*)$/);
        if (!m) continue;
        const ext = mimeToExt(m[1]) || ".png";
        const parsedName = path.parse(att.name || "image");
        const baseName = parsedName.name || "image";
        const safe = baseName.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "image";
        const file = path.join(
          os.tmpdir(),
          `claudex-att-${Date.now()}-${process.pid}-${out.length}-${safe}${
            ext.startsWith(".") ? ext : "." + ext
          }`
        );
        fs.writeFileSync(file, Buffer.from(m[2], "base64"));
        out.push(file);
      } catch {
        // skip bad attachments; we don't want to fail the whole turn over one image
      }
    }
    return out;
  }

  private cleanup(attachmentPaths: string[]): void {
    for (const p of attachmentPaths) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Detect rate-limit / quota-exhausted CLI failures and translate them into a
 * message that tells the user what actually happened. The CLIs surface these
 * as varied stderr strings ("rate_limit", "429", "quota exceeded", "Usage
 * limit reached", "credit balance is too low", etc.) — we look for the most
 * common substrings and fall back to the raw text otherwise.
 */
function createCouncilActivityState(
  route: DeciderRoute,
  context: CouncilContextUsage
): CouncilActivityState {
  return {
    context,
    claude: {
      agent: "claude",
      mission: route.claudeRole || "Answer with the available session context.",
      tasks: ["Load session memory", "Follow assigned Claude lane", "Publish findings to the council"],
      status: route.runClaude ? "planning" : "skipped",
      progress: route.runClaude ? 12 : 100,
      note: route.runClaude ? undefined : route.reason,
    },
    codex: {
      agent: "codex",
      mission: route.codexRole || "Independent verification lane.",
      tasks: ["Load session memory", "Follow assigned Codex lane", "Publish findings to the council"],
      status: route.runCodex ? "planning" : "skipped",
      progress: route.runCodex ? 12 : 100,
      note: route.runCodex ? undefined : route.reason,
    },
  };
}

function applyActivityPlan(state: CouncilActivityState, route: DeciderRoute): void {
  if (route.coordination) {
    state.claude.mission = route.coordination.claudeLane.mission || state.claude.mission;
    state.claude.tasks = normalizeActivityTasks(route.coordination.claudeLane.tasks, state.claude.tasks);
    state.codex.mission = route.coordination.codexLane.mission || state.codex.mission;
    state.codex.tasks = normalizeActivityTasks(route.coordination.codexLane.tasks, state.codex.tasks);
  }
  if (route.runClaude && state.claude.status !== "limited") {
    state.claude.status = "queued";
    state.claude.progress = Math.max(state.claude.progress, 24);
  }
  if (route.runCodex && state.codex.status !== "limited") {
    state.codex.status = "queued";
    state.codex.progress = Math.max(state.codex.progress, 24);
  } else if (state.codex.status !== "limited") {
    state.codex.status = "skipped";
    state.codex.progress = 100;
    state.codex.note = route.reason;
  }
}

function normalizeActivityTasks(tasks: string[] | undefined, fallback: string[]): string[] {
  const cleaned = (tasks || []).map((t) => t.trim()).filter(Boolean).slice(0, 4);
  return cleaned.length > 0 ? cleaned : fallback;
}

function toActivityLane(lane: MutableLaneActivity): CouncilActivityLane {
  return {
    agent: lane.agent,
    title: lane.agent === "claude" ? "Claude lane" : "Codex lane",
    mission: lane.mission,
    status: lane.status,
    progress: lane.progress,
    steps: buildActivitySteps(lane),
    model: lane.model,
    modelReason: lane.modelReason,
    usage: lane.usage,
    note: lane.note,
  };
}

function buildActivitySteps(lane: MutableLaneActivity): CouncilActivityStep[] {
  const labels = [
    "Load session context",
    `Claim lane: ${truncate(lane.mission, 72)}`,
    lane.tasks[0] || "Run assigned analysis",
    lane.tasks[1] || "Cross-check constraints",
    "Publish result to shared council memory",
  ];
  if (lane.status === "skipped") {
    return labels.map((label) => ({ label, status: "skipped" as const }));
  }
  if (lane.status === "limited" || lane.status === "failed") {
    return labels.map((label, index) => ({
      label,
      status: index < 2 ? "done" : index === 2 ? "blocked" : "pending",
    }));
  }
  if (lane.status === "done") {
    return labels.map((label) => ({ label, status: "done" as const }));
  }
  if (lane.status === "running") {
    return labels.map((label, index) => ({
      label,
      status: index < 2 ? "done" : index === 2 ? "running" : "pending",
    }));
  }
  if (lane.status === "queued") {
    return labels.map((label, index) => ({
      label,
      status: index < 2 ? "done" : "pending",
    }));
  }
  return labels.map((label, index) => ({
    label,
    status: index === 0 ? "done" : index === 1 ? "running" : "pending",
  }));
}

function updateActivityAfterWorker(
  lane: MutableLaneActivity,
  wasRun: boolean,
  result: PromiseSettledResult<RunResult>,
  failure?: AgentFailureInfo
): void {
  if (!wasRun) return;
  if (failure) {
    lane.status = failure.kind === "quota" ? "limited" : "failed";
    lane.progress = 100;
    lane.note = failure.title;
    return;
  }
  if (result.status === "fulfilled") {
    lane.status = "done";
    lane.progress = 100;
    lane.usage = result.value.usage;
  }
}

function buildLaneResultSummary(
  route: DeciderRoute,
  claudeFailure?: AgentFailureInfo,
  codexFailure?: AgentFailureInfo
): string {
  if (claudeFailure && codexFailure) return "Both lanes are blocked; the Council cannot complete this turn yet.";
  if (claudeFailure) return "Claude is unavailable, so the Council is continuing with Codex.";
  if (codexFailure) return "Codex is unavailable, so the Council is continuing with Claude.";
  if (!route.runClaude) return "Claude is currently unavailable, so Codex handled the turn.";
  if (!route.runCodex) return "Codex is skipped or unavailable, so Claude handled the turn.";
  return "Both lanes finished and shared their results.";
}

function buildWorkerLimitationNotice(
  claudeFailure: AgentFailureInfo | undefined,
  codexFailure: AgentFailureInfo | undefined,
  route: DeciderRoute
): string {
  const failures = [claudeFailure, codexFailure].filter((f): f is AgentFailureInfo => !!f);
  if (failures.length === 0) return "";
  const lines = failures.map((f) => `- ${f.title}`);
  const continuation =
    claudeFailure && !codexFailure && route.runCodex
      ? "Continuing with Codex only for this turn."
      : codexFailure && !claudeFailure && route.runClaude
        ? "Continuing with Claude only for this turn."
        : "No council lane could complete this turn.";
  return ["**Council availability notice**", ...lines, "", continuation].join("\n");
}

function buildAllAgentsUnavailableMessage(state: CouncilActivityState): string {
  const notes = [state.claude.note, state.codex.note].filter((n): n is string => !!n);
  return [
    "**Both council lanes are unavailable right now.**",
    "",
    ...notes.map((note) => `- ${note}`),
    "",
    "Wait for the quota window to reset, authenticate the affected CLI, or change the model/account settings and try again.",
  ].join("\n");
}

function cooldownNote(cooldown: AgentCooldown): string {
  const minutes = Math.max(1, Math.ceil((cooldown.until - Date.now()) / 60000));
  return `${cooldown.info.title} Retrying automatically in about ${minutes} min.`;
}

function formatModelChoice(choice: ModelChoice | undefined): string {
  if (!choice?.model) return "";
  return choice.auto ? `${choice.model} (auto)` : choice.model;
}

function classifyAgentFailure(agent: AgentRuntimeId | "council", raw: string): AgentFailureInfo {
  const label = agent === "claude" ? "Claude" : agent === "codex" ? "Codex" : "Council answer";
  const lower = raw.toLowerCase();
  const quotaPatterns = [
    "rate limit",
    "rate_limit",
    "429",
    "quota exceeded",
    "quota_exceeded",
    "usage limit",
    "usage_limit_reached",
    "usage limit reached",
    "credit balance is too low",
    "insufficient_quota",
    "exceeded your current quota",
    "billing_hard_limit_reached",
    "too many requests",
    "daily limit",
    "weekly limit",
  ];
  if (quotaPatterns.some((p) => lower.includes(p))) {
    return {
      agent,
      label,
      kind: "quota",
      title: `${label} quota or rate limit reached.`,
      message:
        `${label} hit a rate limit or quota cap. Wait for the quota window to reset, ` +
        `switch models/accounts, or use Economy mode when only Claude is available.\n\n` +
        `Original message: ${truncate(raw, 240)}`,
      raw,
    };
  }
  if (isUnsupportedModelError(raw)) {
    return {
      agent,
      label,
      kind: "model",
      title: `${label} model is not supported by this account.`,
      message:
        `${label} was routed to a model this account cannot run. The Council will remember this and try a fallback model automatically.\n\n` +
        `Original message: ${truncate(raw, 240)}`,
      raw,
    };
  }
  const missingPatterns = [
    "codex cli not found",
    "'codex' cli not found",
    "claude cli not found",
    "ask_codex.py not found",
    "codex helper not found",
    "failed to spawn",
    "spawn error",
    "enoent",
    "command not found",
    "not recognized as an internal or external command",
    "no such file or directory",
  ];
  if (missingPatterns.some((p) => lower.includes(p))) {
    const command = agent === "codex" ? "codex" : agent === "claude" ? "claude" : "the selected CLI";
    return {
      agent,
      label,
      kind: "missing",
      title: `${label} CLI is not installed or not on PATH.`,
      message:
        `${label} could not find \`${command}\`. Install the CLI, run it once in a terminal, ` +
        `or set the matching Claudex Council binary/path setting in VS Code.\n\n` +
        `Original message: ${truncate(raw, 240)}`,
      raw,
    };
  }
  const transientPatterns = [
    "server overloaded",
    "retry later",
    "temporarily unavailable",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "503",
    "502",
    "504",
  ];
  if (transientPatterns.some((p) => lower.includes(p))) {
    return {
      agent,
      label,
      kind: "transient",
      title: `${label} service is temporarily unavailable.`,
      message: `${label} hit a transient service error. The Council will try a fallback route when possible. Original message: ${truncate(raw, 240)}`,
      raw,
    };
  }
  if (
    lower.includes("not authenticated") ||
    lower.includes("not logged in") ||
    lower.includes("not signed in") ||
    lower.includes("login required") ||
    lower.includes("oauth token revoked") ||
    lower.includes("oauth token has expired") ||
    lower.includes("oauthtokenexpired") ||
    lower.includes("expired token") ||
    lower.includes("please run /login") ||
    lower.includes("please run claude login") ||
    lower.includes("please run codex login") ||
    lower.includes("authentication_error") ||
    lower.includes("requires authentication") ||
    lower.includes("invalid api key") ||
    lower.includes("missing credentials") ||
    lower.includes("missing or expired credentials") ||
    lower.includes("api error: 401") ||
    lower.includes("401 unauthorized") ||
    lower.includes("403 forbidden") ||
    lower.includes("unauthorized")
  ) {
    const loginCmd = agent === "codex" ? "codex login" : "claude login";
    return {
      agent,
      label,
      kind: "auth",
      title: `${label} CLI is not authenticated.`,
      message:
        `${label} CLI is not logged in. Run \`${loginCmd}\` in a terminal to authenticate, then try again.`,
      raw,
    };
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      agent,
      label,
      kind: "timeout",
      title: `${label} timed out.`,
      message: `${label} timed out before returning an answer. Original message: ${truncate(raw, 240)}`,
      raw,
    };
  }
  return {
    agent,
    label,
    kind: "error",
    title: `${label} failed.`,
    message: `(${label} failed: ${truncate(raw, 240)})`,
    raw,
  };
}

function friendlyAgentError(agentLabel: string, raw: string): string {
  const agent = agentLabel.toLowerCase().includes("codex") ? "codex" : "claude";
  return classifyAgentFailure(agent, raw).message;
}

function isUnsupportedModelError(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    lower.includes("model is not supported") ||
    lower.includes("not supported when using") ||
    lower.includes("unsupported model") ||
    lower.includes("model_not_supported") ||
    lower.includes("model_not_found") ||
    lower.includes("invalid model") ||
    lower.includes("not available for this account")
  );
}

function makeTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function userBubbleText(prompt: string, attachments: PromptAttachment[]): string {
  if (attachments.length === 0) return prompt;
  return `${prompt}\n\n_(${attachments.length} attachment${attachments.length === 1 ? "" : "s"})_`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function isClaudeTerminalEvent(parsed: any): boolean {
  if (parsed?.type === "result") return true;
  if (parsed?.type === "stream_event" && parsed.event?.type === "message_stop") return true;
  if (parsed?.type === "message_stop") return true;
  return false;
}

function extractClaudeUsage(parsed: any): AgentUsage | undefined {
  const usage =
    parsed?.usage ||
    parsed?.event?.usage ||
    parsed?.message?.usage ||
    parsed?.event?.message?.usage;
  return normalizeUsage(usage, parsed?.total_cost_usd);
}

function extractCodexUsage(stderr: string | undefined): AgentUsage | undefined {
  const m = (stderr || "").match(/^CLAUDEX_USAGE:\s*(\{.+\})\s*$/m);
  if (!m) return undefined;
  try {
    return normalizeUsage(JSON.parse(m[1]));
  } catch {
    return undefined;
  }
}

function normalizeUsage(raw: any, totalCostUsd?: unknown): AgentUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage: AgentUsage = {
    inputTokens: readNumber(raw.inputTokens, raw.input_tokens),
    outputTokens: readNumber(raw.outputTokens, raw.output_tokens),
    cacheCreationInputTokens: readNumber(
      raw.cacheCreationInputTokens,
      raw.cache_creation_input_tokens
    ),
    cacheReadInputTokens: readNumber(
      raw.cacheReadInputTokens,
      raw.cache_read_input_tokens,
      raw.cached_input_tokens
    ),
    reasoningOutputTokens: readNumber(raw.reasoningOutputTokens, raw.reasoning_output_tokens),
    totalCostUsd: readNumber(raw.totalCostUsd, raw.total_cost_usd, totalCostUsd),
  };

  return Object.values(usage).some((v) => typeof v === "number") ? usage : undefined;
}

function readNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function mergeUsage(prev: AgentUsage | undefined, next: AgentUsage | undefined): AgentUsage | undefined {
  if (!next) return prev;
  return { ...(prev || {}), ...next };
}

function buildActiveEditorContext(cwd: string): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") return "";

  const rel = relativeInside(cwd, editor.document.uri.fsPath);
  if (!rel) return "";

  const doc = editor.document;
  let label = "visible";
  let snippet = "";
  if (!editor.selection.isEmpty) {
    label = "selection";
    snippet = doc.getText(editor.selection);
  } else {
    const visible = editor.visibleRanges[0];
    if (!visible) return "";
    const start = Math.max(0, visible.start.line - 20);
    const end = Math.min(doc.lineCount - 1, visible.end.line + 20);
    const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
    snippet = doc.getText(range);
  }

  snippet = truncateMiddle(snippet.trim(), ACTIVE_EDITOR_SNIPPET_MAX_CHARS);
  if (!snippet) return "";
  return [
    '<ACTIVE_EDITOR_CONTEXT compact="true">',
    `path: ${rel}`,
    `snippet: ${label}`,
    "```",
    snippet,
    "```",
    "</ACTIVE_EDITOR_CONTEXT>",
  ].join("\n");
}

function buildStaticProjectContext(cwd: string): string {
  const lines: string[] = ['<PROJECT_CONTEXT compact="true">'];
  lines.push(`workspace: ${path.basename(cwd) || "workspace"}`);

  const pkg = readJsonObject(path.join(cwd, "package.json"));
  if (pkg) {
    const scripts = Object.keys(asRecord(pkg.scripts)).slice(0, 10);
    const deps = [
      ...Object.keys(asRecord(pkg.dependencies)),
      ...Object.keys(asRecord(pkg.devDependencies)),
    ].slice(0, 30);
    lines.push(`package: ${String(pkg.name || "(unnamed)")}${pkg.version ? `@${pkg.version}` : ""}`);
    if (scripts.length > 0) lines.push(`scripts: ${scripts.join(", ")}`);
    if (deps.length > 0) lines.push(`deps: ${deps.join(", ")}`);
  }

  const headings = readMarkdownHeadings(path.join(cwd, "README.md"), 8);
  if (headings.length > 0) {
    lines.push("readme_headings:");
    for (const h of headings) lines.push(`- ${h}`);
  }

  const tree = listProjectTree(cwd, 5, 120);
  if (tree.length > 0) {
    lines.push("file_map:");
    for (const item of tree) lines.push(`- ${item}`);
  }

  lines.push("</PROJECT_CONTEXT>");
  return truncateMiddle(lines.join("\n"), PROJECT_CONTEXT_MAX_CHARS);
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 80_000) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readMarkdownHeadings(file: string, max: number): string[] {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 120_000) return [];
    const text = fs.readFileSync(file, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.match(/^(#{1,3})\s+(.+)$/)?.[2]?.trim())
      .filter((line): line is string => !!line)
      .slice(0, max);
  } catch {
    return [];
  }
}

function listProjectTree(cwd: string, maxDepth: number, maxEntries: number): string[] {
  const out: string[] = [];
  const skipDirs = new Set([
    ".git",
    "node_modules",
    "out",
    "dist",
    "build",
    ".tmp-codex-home",
    ".codex-test",
    ".claude",
    ".vscode-test",
  ]);
  const skipFiles = new Set(["package-lock.json", "bun.lock", "claudex-council.vsix"]);
  const skipExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".vsix", ".map"]);

  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > maxDepth || out.length >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (entry.name.startsWith(".") && entry.name !== ".github") {
        if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
      }
      if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
      if (entry.isFile() && (skipFiles.has(entry.name) || skipExts.has(path.extname(entry.name).toLowerCase()))) {
        continue;
      }
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const display = toPosix(childRel) + (entry.isDirectory() ? "/" : "");
      out.push(display);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel, depth + 1);
    }
  };

  walk(cwd, "", 0);
  if (out.length >= maxEntries) out.push("...");
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function relativeInside(root: string, file: string): string | undefined {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head - 40);
  return `${s.slice(0, head)}\n...[context truncated]...\n${s.slice(-tail)}`;
}

/**
 * Common spawn options used by every child-process call so the cross-platform
 * details (shell handling, process-group / detached flag for tree-killing)
 * are defined in exactly one place. On Windows we set `shell: true` so .cmd
 * shims like `claude.cmd` and `codex.cmd` resolve, and cancellation uses
 * `taskkill /T /F /PID` to walk the whole process tree. On Unix we set
 * `detached: true` so we can later `process.kill(-pid)` to signal the
 * whole group; without this, `proc.kill()` only signals the immediate child
 * and leaves grandchildren orphaned.
 */
function getSpawnOptions(cwd: string, opts: { fullFidelity?: boolean } = {}) {
  // Inherit the parent process env. This is the headless-auth path:
  // setting CLAUDE_CODE_OAUTH_TOKEN (generated via `claude setup-token`,
  // see https://code.claude.com/docs/en/authentication) lets `claude -p`
  // run without a browser-based OAuth flow — useful for CI, Docker,
  // remote servers, or company-locked Macs where browser login is
  // blocked. We don't read or set the token ourselves; the inherit
  // here is what makes it work.
  const env = buildChildProcessEnv();
  if (!opts.fullFidelity) {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = "1";
  }
  return {
    cwd,
    shell: process.platform === "win32",
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
  } as const;
}

/**
 * Kill a child process AND every descendant on both Windows and Unix. The
 * naive `proc.kill()` only signals the immediate child; on Windows with
 * shell:true that's just cmd.exe (the shim's host), leaving the real
 * Node/Claude/Codex/Python processes alive. On Unix the same applies once
 * a script wrapper is involved.
 */
function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      // taskkill /T /F walks the whole tree rooted at the given PID and
      // force-kills each node. We swallow the result — the worst case is
      // the process was already dead, which we don't care about.
      const tk = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
      tk.on("error", () => undefined);
    } else {
      // Negative PID signals the whole process group (set up by detached:
      // true in getSpawnOptions). SIGKILL is intentional — cancellation is
      // user-driven and we don't want graceful shutdowns racing with a
      // re-prompt.
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
  } catch {
    // Last-resort fallback: at least try the immediate child.
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Find a binary across both PATH and well-known fallback dirs. Designed for
 * the macOS-VS-Code-launched-from-the-Dock case where PATH is stripped to
 * essentially `/usr/bin:/bin` and Homebrew / npm-global / .local installs
 * are invisible. Returns an absolute path, or null if not found anywhere.
 */
function resolveBinary(name: string): string | null {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".CMD;.EXE;.BAT").split(";")
      : [""];
  const dirs = [
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
    ...getExtraBinaryDirs(),
  ];

  // Add well-known fallback dirs that GUI VS Code on macOS / Linux often
  // misses. Order matters — Apple Silicon Homebrew first since it's the
  // most common on modern Macs.
  if (process.platform === "darwin") {
    dirs.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.join(os.homedir(), ".npm-global", "bin"),
      path.join(os.homedir(), ".local", "bin"),
      // pnpm-installed globals on macOS land in ~/Library/pnpm
      path.join(os.homedir(), "Library", "pnpm"),
      "/usr/bin"
    );
  } else if (process.platform === "linux") {
    dirs.push(
      "/usr/local/bin",
      path.join(os.homedir(), ".npm-global", "bin"),
      path.join(os.homedir(), ".local", "bin"),
      path.join(os.homedir(), "node_modules", ".bin"),
      // Rust / cargo-installed globals
      path.join(os.homedir(), ".cargo", "bin"),
      // Ubuntu snap bin (e.g. snap-installed node packages)
      "/snap/bin",
      "/usr/bin"
    );
  } else if (process.platform === "win32") {
    // Windows fallback dirs are returned by getExtraBinaryDirs() so child
    // process PATH and binary lookup stay in sync.
  }

  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        const s = fs.statSync(full);
        if (s.isFile()) return full;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * Pre-flight check that the Claude CLI is signed in. Uses the official
 * `claude auth status` command (exits 0 if logged in, 1 if not — see
 * https://code.claude.com/docs/en/cli-reference). Cheaper and more
 * reliable than spawning a real `-p` call and parsing stderr.
 *
 * Fire-and-forget by callers; takes ~100ms when claude is on PATH and
 * authenticated, ~5s upper bound when not. Returns:
 *   - { state: "ok" }                   — signed in
 *   - { state: "not-authenticated" }    — binary present, not logged in
 *   - { state: "binary-missing" }       — claude not found anywhere
 *   - { state: "unknown", reason }      — probe failed for some other
 *                                          reason (don't pester the user)
 */
export async function probeClaudeAuth(): Promise<
  | { state: "ok" }
  | { state: "not-authenticated" }
  | { state: "binary-missing" }
  | { state: "unknown"; reason: string }
> {
  const cfg = vscode.workspace.getConfiguration("claudexCouncil");
  const configured = cfg.get<string>("claudeBinary");
  const binary =
    configured && configured.trim()
      ? configured.trim()
      : resolveBinary("claude") || "claude";

  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(binary, ["auth", "status", "--text"], {
        shell: process.platform === "win32",
        env: buildChildProcessEnv(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ state: "binary-missing" });
      return;
    }

    let stderrBuf = "";
    proc.stderr?.on("data", (d) => (stderrBuf += d.toString()));
    proc.on("error", (err: NodeJS.ErrnoException) => {
      // ENOENT = binary genuinely not on PATH (and not in any fallback dir).
      if (err.code === "ENOENT") resolve({ state: "binary-missing" });
      else resolve({ state: "unknown", reason: String(err) });
    });

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      resolve({ state: "unknown", reason: "auth probe timed out" });
    }, 5000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      // Per the docs: exit 0 = authenticated, exit 1 = not authenticated.
      // Anything else (e.g. exit 127, command-unknown) is treated as
      // "unknown" so older Claude CLIs without `auth status` don't
      // trigger a false warning.
      if (code === 0) {
        resolve({ state: "ok" });
      } else if (code === 1) {
        resolve({ state: "not-authenticated" });
      } else {
        resolve({
          state: "unknown",
          reason: `exit ${code}: ${stderrBuf.trim().slice(0, 160)}`,
        });
      }
    });
  });
}

function buildChildProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  env[pathKey] = mergePathDirs(String(env[pathKey] || ""), getExtraBinaryDirs());
  if (process.platform === "win32" && !env.PATHEXT) {
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.PS1";
  }
  return env;
}

function mergePathDirs(current: string, extraDirs: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...current.split(path.delimiter), ...extraDirs]) {
    const dir = raw.trim();
    if (!dir) continue;
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out.join(path.delimiter);
}

function getExtraBinaryDirs(): string[] {
  const dirs: string[] = [];
  const home = os.homedir();
  const appdata = process.env.APPDATA;
  const localappdata = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];

  if (process.platform === "win32") {
    if (appdata) dirs.push(path.join(appdata, "npm"));
    if (localappdata) {
      dirs.push(path.join(localappdata, "pnpm"));
      dirs.push(path.join(localappdata, "Microsoft", "WindowsApps"));
      addPythonInstallDirs(dirs, path.join(localappdata, "Programs", "Python"));
    }
    if (programFiles) dirs.push(path.join(programFiles, "nodejs"));
    if (programFilesX86) dirs.push(path.join(programFilesX86, "nodejs"));
    dirs.push(
      path.join(home, "Tools", "nodejs"),
      path.join(home, "Tools", "python312"),
      path.join(home, "Tools", "python312", "Scripts"),
      path.join(home, "Tools", "python311"),
      path.join(home, "Tools", "python311", "Scripts"),
      path.join(home, "Tools", "python310"),
      path.join(home, "Tools", "python310", "Scripts")
    );
  }

  return dirs.filter((dir, index, all) => {
    if (!dir) return false;
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    return all.findIndex((d) => (process.platform === "win32" ? d.toLowerCase() : d) === key) === index;
  });
}

function addPythonInstallDirs(out: string[], root: string): void {
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^Python\d+/i.test(entry.name)) continue;
      const dir = path.join(root, entry.name);
      out.push(dir, path.join(dir, "Scripts"));
    }
  } catch {
    /* root missing */
  }
}

function findCavemanSkillPath(): string | undefined {
  const root = path.join(os.homedir(), ".claude", "skills", "caveman");
  const candidates = [
    path.join(root, "SKILL.md"),
    path.join(root, "caveman", "SKILL.md"),
    path.join(root, "skills", "caveman", "SKILL.md"),
    path.join(root, "plugins", "caveman", "skills", "caveman", "SKILL.md"),
  ];
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

function buildCavemanDirective(level: string): string | undefined {
  const normalized = level.toLowerCase();
  const known = new Set(["lite", "full", "ultra", "wenyan-lite", "wenyan-full", "wenyan-ultra"]);
  if (!known.has(normalized)) return undefined;

  const intensity =
    normalized === "lite"
      ? "Drop filler and hedging, but keep complete professional sentences."
      : normalized === "ultra"
        ? "Use very terse fragments and common technical abbreviations. One word when one word is enough."
        : normalized.startsWith("wenyan")
          ? "Use the requested wenyan-style compression only when it remains clear to the user."
          : "Drop articles and filler. Fragments are OK. Use short words.";

  return [
    `Caveman compression mode: ${normalized}.`,
    intensity,
    "Keep all technical substance exact. Preserve code, commands, file paths, URLs, quoted errors, and identifiers exactly.",
    "Avoid pleasantries and preamble. Pattern: thing -> action -> reason -> next step.",
  ].join(" ");
}

/**
 * Path to a temp file containing `{"mcpServers":{}}`. Created lazily on
 * first use and reused for the lifetime of the extension host. We write a
 * file rather than passing the JSON inline because Windows `cmd.exe`
 * (under spawn `shell: true`) strips single quotes and reinterprets the
 * inner double quotes, mangling the inline JSON into a non-existent file
 * path like `c:\workspace\{mcpServers:{}}`. A real temp-file path has no
 * shell-special characters so it survives any quoting regime cleanly.
 */
let emptyMcpConfigPath: string | undefined;

const DEFAULT_WORKER_SYSTEM_PROMPT =
  "You are a council worker answering the user's question directly. Be concise but complete. Prefer 3-8 short paragraphs or bullets; go longer only for code or explicit detail. Do not call tools.";

const DEFAULT_SYNTHESIS_SYSTEM_PROMPT =
  "You are the final synthesizer for a Claude + Codex council. Merge the two worker answers into one clear, compact answer for the user. Use normal professional English. Do not call tools.";

const DEFAULT_COORDINATOR_SYSTEM_PROMPT =
  "You are the coordinator for a Claude + Codex council. Split the user's task into explicit parallel lanes for Claude and Codex. Return valid JSON only.";

const DEFAULT_REVIEW_SYSTEM_PROMPT =
  "You are one worker in a Claude + Codex council. Review the peer worker's draft against the user's request and the coordinator plan. Be brief, specific, and constructive.";

const DEFAULT_CLARIFICATION_SYSTEM_PROMPT =
  "You are the clarification coordinator for a Claude + Codex council. Merge blockers from both agents into one minimal set of user-facing questions. Return valid JSON only.";

const DEFAULT_FULL_FIDELITY_WORKER_APPEND_PROMPT =
  "You are a full-fidelity Claude Code council worker. Keep your normal Claude Code capabilities available and use tools, project files, MCP servers, skills, and configured search only when they materially improve the answer. Coordinate with the independent Codex worker by producing a concrete answer, risks, and recommended next action.";

const DEFAULT_FULL_FIDELITY_COORDINATOR_APPEND_PROMPT =
  "You are coordinating a full-fidelity council. You may inspect project state if needed before assigning lanes, but keep the planning call bounded and return the requested JSON.";

const DEFAULT_FULL_FIDELITY_REVIEW_APPEND_PROMPT =
  "You are reviewing inside a full-fidelity council. Use tools only if a concrete verification would materially change your review; otherwise keep the deliberation bounded.";

const DEFAULT_FULL_FIDELITY_SYNTHESIS_APPEND_PROMPT =
  "You are the final synthesizer for a full-fidelity Claude + Codex council. You may use your normal Claude Code capabilities if you need to verify a fact or inspect project state before the final answer, but prefer merging the worker outputs directly when they are sufficient.";

function getEmptyMcpConfigPath(): string {
  if (emptyMcpConfigPath && fs.existsSync(emptyMcpConfigPath)) {
    return emptyMcpConfigPath;
  }
  const dir = path.join(os.tmpdir(), "claudex-council");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore — dir likely exists */
  }
  const target = path.join(dir, "empty-mcp.json");
  try {
    fs.writeFileSync(target, '{"mcpServers":{}}', "utf8");
  } catch {
    // Fallback to a per-process temp file if the directory write failed
    // for any reason (read-only tmpdir, etc.).
    const fallback = path.join(os.tmpdir(), `claudex-empty-mcp-${process.pid}.json`);
    fs.writeFileSync(fallback, '{"mcpServers":{}}', "utf8");
    emptyMcpConfigPath = fallback;
    return fallback;
  }
  emptyMcpConfigPath = target;
  return target;
}

/**
 * Build the flag set that turns `claude -p` into a near-pure LLM call —
 * skipping the multi-second cold start that Claude Code's defaults incur
 * (MCP server inits, plugin sync, hooks, slash-command discovery, settings
 * cascade, auto-memory load, dynamic system prompt assembly).
 *
 * Tuned with help from Codex (see v0.5.2 release notes). The benchmark
 * shows ~50% wall-time reduction on a "ok" round-trip vs. the previous
 * stack (13-17s → 8s) without breaking OAuth-based Claude.ai login.
 *
 * Stream mode adds the `stream-json` output flags so the webview can
 * paint tokens live; the synthesis path uses the same set so its bubble
 * also fills incrementally.
 */
function buildClaudeArgs(opts: {
  stream: boolean;
  fidelity: CouncilFidelity;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  permissionMode?: ClaudePermissionMode;
}): string[] {
  if (opts.fidelity === "full-fidelity") {
    return buildClaudeFullFidelityArgs(opts);
  }
  return buildClaudeFastArgs(opts);
}

function buildClaudeFastArgs(opts: { stream: boolean; systemPrompt?: string }): string[] {
  const args: string[] = ["-p"];
  if (opts.stream) {
    args.push(
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose"
    );
  } else {
    args.push("--output-format", "json");
  }
  args.push(
    // Don't write a session file we'll never read.
    "--no-session-persistence",
    // Don't load MCP servers — force an empty MCP config via a temp
    // FILE PATH (not inline JSON, which gets mangled by cmd.exe under
    // shell:true on Windows).
    "--strict-mcp-config",
    "--mcp-config",
    getEmptyMcpConfigPath(),
    // No slash commands / skills enumeration.
    "--disable-slash-commands",
    // No built-in tools in the model context. The worker/synthesizer are
    // pure answer calls; file access belongs to the surrounding extension.
    "--tools",
    "",
    // Replace Claude Code's bulky default system prompt (which describes
    // every tool, every CLAUDE.md, every memory path) with a one-liner.
    // The worker is acting as a council member, not a coding agent.
    "--system-prompt",
    opts.systemPrompt || DEFAULT_WORKER_SYSTEM_PROMPT,
    // Hard cap at one turn — no agentic looping.
    "--max-turns",
    "1"
  );
  return args;
}

function buildClaudeFullFidelityArgs(opts: {
  stream: boolean;
  appendSystemPrompt?: string;
  permissionMode?: ClaudePermissionMode;
}): string[] {
  const args: string[] = ["-p"];
  if (opts.stream) {
    args.push(
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose"
    );
  } else {
    args.push("--output-format", "json");
  }
  // Full-fidelity intentionally does NOT pass --no-session-persistence:
  // the user wanted the worker to behave like a native `claude` session,
  // and that includes leaving a session record they can resume from
  // their normal Claude Code UI. Fast mode keeps the flag for hygiene.
  if (opts.permissionMode && opts.permissionMode !== "default") {
    args.push("--permission-mode", opts.permissionMode);
  }
  if (opts.appendSystemPrompt?.trim()) {
    args.push("--append-system-prompt", opts.appendSystemPrompt.trim());
  }
  // Cap agentic loops at a generous-but-safe number. Native `claude -p`
  // has no cap, but an unbounded loop in a council worker can drift far
  // outside the original prompt's scope. 30 is enough for a real
  // multi-step task (read files, search web, propose edits) without
  // letting a runaway loop torch the user's quota.
  args.push("--max-turns", "30");
  return args;
}

function decideRoute(
  prompt: string,
  attachments: PromptAttachment[],
  economyMode: boolean,
  fidelity: CouncilFidelity
): DeciderRoute {
  const trimmed = prompt.trim();
  const hasAttachments = attachments.length > 0;
  const forceFullCouncil = explicitlyRequestsFullCouncil(trimmed);

  if (economyMode) {
    return makeRoute({
      mode: "economy",
      fidelity,
      reason: "Economy mode is enabled",
      confidence: "high",
      runCodex: false,
      runSynthesis: false,
      fastClaude: isTrivialPrompt(prompt),
      planText:
        "Route: Claude only. Starting Claude now because Economy mode is enabled; Codex and synthesis are skipped for speed/cost.",
      prompt,
      claudeRole:
        "Answer directly and practically. Economy mode is on, so you are the only worker for this turn.",
      codexRole: "",
    });
  }

  if (!forceFullCouncil && isTrivialPrompt(prompt) && !hasAttachments) {
    return makeRoute({
      mode: "claude-only",
      fidelity,
      reason: "quick conversational prompt; Codex skipped to save quota",
      confidence: "high",
      runCodex: false,
      runSynthesis: false,
      fastClaude: true,
      planText:
        "Route: Claude only. Starting Claude now for a quick conversational reply. Codex is skipped to save quota; ask for a review, plan, debug task, or mention 'full council' to run both lanes.",
      prompt,
      claudeRole:
        "Give a short, warm, direct reply. Do not over-explain or mention the council routing.",
      codexRole: "",
    });
  }

  if (!forceFullCouncil && isLightDirectPrompt(trimmed) && !hasAttachments) {
    return makeRoute({
      mode: "claude-only",
      fidelity,
      reason: "quick direct answer; Codex skipped to save quota",
      confidence: "medium",
      runCodex: false,
      runSynthesis: false,
      fastClaude: false,
      planText:
        "Route: Claude only. Starting Claude now because this looks like a quick direct answer. Codex is skipped to save quota; ask for a review, plan, debug task, or mention 'full council' to run both lanes.",
      prompt,
      claudeRole:
        "Answer directly and concisely. Use the project context only if it is clearly relevant.",
      codexRole: "",
    });
  }

  const taskType = forceFullCouncil
    ? "explicit full-council request"
    : classifyTaskType(trimmed, hasAttachments);
  const confidence = taskType === "ambiguous task" ? "low" : "high";
  return makeRoute({
    mode: "full-council",
    fidelity,
    reason: taskType,
    confidence,
    runCodex: true,
    runSynthesis: true,
    fastClaude: false,
    planText:
      confidence === "low"
        ? "Route: Full council. Starting Claude and Codex now because the request is ambiguous enough that a second pass is safer; Decider will merge both."
        : `Route: Full council. Starting Claude for the repo-aware pass and Codex for an independent pass; Decider will merge both. Reason: ${taskType}.`,
    prompt,
    claudeRole:
      "You are the repo-aware Claude worker. Focus on the user's requested outcome, the active project context, edge cases, and concrete implementation guidance.",
    codexRole:
      "You are the independent Codex worker. Give a second implementation/review pass, look for missed risks, and be specific about what should change.",
  });
}

function makeRoute(opts: {
  mode: DeciderRoute["mode"];
  fidelity: CouncilFidelity;
  reason: string;
  confidence: DeciderRoute["confidence"];
  runCodex: boolean;
  runSynthesis: boolean;
  fastClaude: boolean;
  planText: string;
  prompt: string;
  claudeRole: string;
  codexRole: string;
}): DeciderRoute {
  const claudePrompt = buildWorkerBrief("Claude", opts.claudeRole, opts.reason, opts.prompt);
  const codexPrompt = opts.runCodex
    ? buildWorkerBrief("Codex", opts.codexRole, opts.reason, opts.prompt)
    : "";
  return {
    mode: opts.mode,
    fidelity: opts.fidelity,
    reason: opts.reason,
    confidence: opts.confidence,
    runClaude: true,
    runCodex: opts.runCodex,
    runSynthesis: opts.runSynthesis,
    fastClaude: opts.fastClaude,
    planText: `${opts.planText}\n${describeCapabilityProfile(opts.fidelity)}`,
    claudeRole: opts.claudeRole,
    codexRole: opts.codexRole,
    claudePrompt,
    codexPrompt,
  };
}

function describeCapabilityProfile(fidelity: CouncilFidelity): string {
  if (fidelity === "full-fidelity") {
    return [
      "Capability profile: Full fidelity.",
      "Claude keeps normal Claude Code tools/MCP/skills/memory context.",
      "Codex loads the user's Codex config instead of disabling web/MCP/tools; sandbox follows claudexCouncil.codexFullFidelitySandbox.",
    ].join(" ");
  }
  return [
    "Capability profile: Fast council.",
    "Claude/Codex startup is trimmed for speed; Codex runs read-only with web/MCP/user config disabled, and Claude worker tools are disabled.",
  ].join(" ");
}

function explicitlyRequestsFullCouncil(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return [
    "full council",
    "run both",
    "use both",
    "both agents",
    "claude and codex",
    "codex lane",
    "run codex",
    "test codex",
    "council mode",
  ].some((phrase) => lower.includes(phrase));
}

function makeFallbackCoordinatorPlan(route: DeciderRoute, rawText?: string): CoordinatorPlan {
  return {
    source: rawText ? "model" : "local",
    summary: !route.runClaude && route.runCodex
      ? "Use Codex as the active lane because Claude is currently unavailable."
      : route.runCodex
      ? "Split the turn into a Claude repo-aware lane and a Codex independent verification lane."
      : "Use a single Claude lane for this lightweight turn.",
    claudeLane: {
      mission: route.runClaude ? route.claudeRole || "Answer the user directly." : "Unavailable for this route.",
      tasks: route.runClaude ? [route.claudeRole || "Handle the user request."] : ["Skipped because Claude is unavailable."],
      avoid: route.runClaude && route.runCodex
        ? ["Do not spend time duplicating Codex's independent second-pass lane unless needed."]
        : [],
    },
    codexLane: {
      mission: route.runCodex ? route.codexRole : "Skipped for this route.",
      tasks: route.runCodex ? [route.codexRole] : ["Skipped."],
      avoid: route.runCodex ? ["Do not duplicate Claude's repo-context summary without adding independent value."] : [],
    },
    synthesisStrategy: !route.runClaude && route.runCodex
      ? "Return Codex's answer directly."
      : route.runCodex
      ? "Compose Claude's repo-aware answer with Codex's independent pass; prefer concrete findings over duplicate commentary."
      : "Return Claude's answer directly.",
    coordinationNotes: [
      route.reason,
      describeCapabilityProfile(route.fidelity),
    ],
    rawText,
  };
}

function applyCoordinatorPlanToRoute(
  route: DeciderRoute,
  prompt: string,
  plan: CoordinatorPlan
): void {
  route.coordination = plan;
  route.planText = renderCoordinatorPlan(plan);
  route.claudePrompt = buildWorkerBrief("Claude", route.claudeRole, route.reason, prompt, plan);
  route.codexPrompt = route.runCodex
    ? buildWorkerBrief("Codex", route.codexRole, route.reason, prompt, plan)
    : "";
}

function renderCoordinatorPlan(plan: CoordinatorPlan): string {
  const lines = [
    `Coordinator: ${plan.summary}`,
    "",
    `Claude lane: ${plan.claudeLane.mission}`,
    ...plan.claudeLane.tasks.map((t) => `- ${t}`),
    "",
    `Codex lane: ${plan.codexLane.mission}`,
    ...plan.codexLane.tasks.map((t) => `- ${t}`),
    "",
    `Synthesis strategy: ${plan.synthesisStrategy}`,
  ];
  if (plan.coordinationNotes.length > 0) {
    lines.push("", "Coordination notes:", ...plan.coordinationNotes.map((n) => `- ${n}`));
  }
  if (plan.source === "local") {
    lines.push("", "Coordinator source: local fallback.");
  }
  return lines.join("\n");
}

function parseCoordinatorPlan(text: string): CoordinatorPlan | undefined {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  const obj = asRecord(parsed);
  const claude = asRecord(obj.claude_lane);
  const codex = asRecord(obj.codex_lane);
  const plan: CoordinatorPlan = {
    source: "model",
    summary: stringValue(obj.summary) || "Coordinate Claude and Codex lanes.",
    claudeLane: {
      mission: stringValue(claude.mission) || "Handle the repo-aware lane.",
      tasks: stringArray(claude.tasks),
      avoid: stringArray(claude.avoid),
    },
    codexLane: {
      mission: stringValue(codex.mission) || "Handle the independent lane.",
      tasks: stringArray(codex.tasks),
      avoid: stringArray(codex.avoid),
    },
    synthesisStrategy:
      stringValue(obj.synthesis_strategy) ||
      "Compose both assigned lanes into one final answer.",
    coordinationNotes: stringArray(obj.coordination_notes),
    rawText: text,
  };
  if (plan.claudeLane.tasks.length === 0) plan.claudeLane.tasks.push(plan.claudeLane.mission);
  if (plan.codexLane.tasks.length === 0) plan.codexLane.tasks.push(plan.codexLane.mission);
  return plan;
}

function parseClarificationReview(text: string): ClarificationReview | undefined {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }
  const obj = asRecord(parsed);
  const questions = stringArray(obj.questions);
  const needs =
    typeof obj.needs_clarification === "boolean"
      ? obj.needs_clarification
      : typeof obj.needsClarification === "boolean"
        ? obj.needsClarification
        : questions.length > 0;
  return {
    needsClarification: needs && questions.length > 0,
    questions,
    rationale: stringValue(obj.rationale),
  };
}

function buildWorkerBrief(
  agent: string,
  role: string,
  reason: string,
  prompt: string,
  plan?: CoordinatorPlan
): string {
  const ownLane =
    agent === "Claude" ? plan?.claudeLane : agent === "Codex" ? plan?.codexLane : undefined;
  const otherLane =
    agent === "Claude" ? plan?.codexLane : agent === "Codex" ? plan?.claudeLane : undefined;
  return [
    `<COUNCIL_ROUTE agent="${agent}" reason="${escapeAttr(reason)}">`,
    role,
    "</COUNCIL_ROUTE>",
    "",
    ...(plan
      ? [
          "<COORDINATOR_PLAN>",
          renderCoordinatorPlan(plan),
          "</COORDINATOR_PLAN>",
          "",
          "<YOUR_LANE>",
          ownLane ? renderLane(ownLane) : role,
          "</YOUR_LANE>",
          "",
          "<OTHER_AGENT_LANE>",
          otherLane ? renderLane(otherLane) : "(none)",
          "</OTHER_AGENT_LANE>",
          "",
          "Stay inside YOUR_LANE unless you find a concrete reason to cross-check the other lane. Mention blockers instead of silently doing both jobs.",
          "You and the other worker share the COUNCIL_LEDGER in the prompt context. Use it to know task ownership, peer status, prior decisions, and open questions.",
          "If you need user input before a useful or safe answer is possible, add a short section named `Questions for user:` with only the blocking questions. Do not ask optional preference questions; state assumptions instead.",
          "If you discover the peer should handle something, write it as a concise handoff instead of duplicating their lane.",
          "Keep the draft compact. The Decider will merge it with the other lane; do not pad with repeated context.",
          "",
        ]
      : []),
    "<USER_REQUEST>",
    prompt,
    "</USER_REQUEST>",
  ].join("\n");
}

function buildReviewPrompt(opts: {
  reviewer: "Claude" | "Codex";
  peer: "Claude" | "Codex";
  userPrompt: string;
  ownOutput: string;
  peerOutput: string;
  route: DeciderRoute;
}): string {
  return [
    `<DELIBERATION reviewer="${opts.reviewer}" peer="${opts.peer}">`,
    "You are now talking to the other council worker before the final Decider response.",
    "Review the peer output as if you are helping them and the Decider produce the best final answer.",
    "</DELIBERATION>",
    "",
    "<USER_REQUEST>",
    opts.userPrompt,
    "</USER_REQUEST>",
    "",
    "<COORDINATOR_PLAN>",
    opts.route.coordination ? renderCoordinatorPlan(opts.route.coordination) : opts.route.planText,
    "</COORDINATOR_PLAN>",
    "",
    "<YOUR_DRAFT>",
    opts.ownOutput.trim() || "(your draft was empty)",
    "</YOUR_DRAFT>",
    "",
    `<${opts.peer.toUpperCase()}_DRAFT>`,
    opts.peerOutput.trim() || "(peer draft was empty)",
    `</${opts.peer.toUpperCase()}_DRAFT>`,
    "",
    "Write a concise deliberation note:",
    "- What the peer draft got right that should be preserved.",
    "- What is missing, risky, duplicated, or outside its assigned lane.",
    "- Any concrete change the Decider should make when merging.",
    "- Do not rewrite the whole answer. Keep it to 3-6 bullets.",
  ].join("\n");
}

function renderLane(lane: CoordinatorLane): string {
  const lines = [
    `Mission: ${lane.mission}`,
    "Tasks:",
    ...lane.tasks.map((t) => `- ${t}`),
  ];
  if (lane.avoid.length > 0) {
    lines.push("Avoid:", ...lane.avoid.map((t) => `- ${t}`));
  }
  return lines.join("\n");
}

function extractClaudePrintText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    const result = asRecord(parsed).result;
    if (typeof result === "string") return result.trim();
  } catch {
    /* fall through */
  }
  const lines = trimmed.split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const result = asRecord(parsed).result;
      if (typeof result === "string") return result.trim();
    } catch {
      /* keep looking */
    }
  }
  return trimmed;
}

function extractJsonObject(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1] || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

function classifyTaskType(prompt: string, hasAttachments: boolean): string {
  const lower = prompt.toLowerCase();
  if (hasAttachments) return "attachment-backed task";
  if (/\b(review|audit|security|risk|regression|bug)\b/.test(lower)) return "review/debug task";
  if (/\b(fix|debug|broken|issue|error|failing|latency|slow|performance)\b/.test(lower)) {
    return "fix/performance task";
  }
  if (/\b(build|implement|create|add|refactor|change|update|wire|integrate)\b/.test(lower)) {
    return "implementation task";
  }
  if (/\b(design|architect|plan|should we|tradeoff|approach|migrate)\b/.test(lower)) {
    return "design decision";
  }
  if (looksLikeCodeOrPath(prompt)) return "code/context task";
  return "ambiguous task";
}

function isComplexPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    prompt.length > 1200 ||
    looksLikeCodeOrPath(prompt) ||
    /\b(refactor|architecture|architect|migration|multi-file|production|security|performance|debug|review|implement|integration|database|frontend|backend|end to end)\b/.test(lower)
  );
}

function isImplementationHeavyPrompt(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    looksLikeCodeOrPath(prompt) ||
    /\b(build|implement|fix|debug|refactor|test|review|audit|wire|integrate|frontend|backend|api|database|typescript|python|compile|package)\b/.test(lower)
  );
}

function isLightDirectPrompt(prompt: string): boolean {
  if (!prompt) return false;
  if (prompt.length > 220) return false;
  if (looksLikeCodeOrPath(prompt)) return false;
  if (/[{};=<>]|```/.test(prompt)) return false;
  const lower = prompt.toLowerCase();
  const heavy =
    /\b(fix|debug|build|implement|create|add|refactor|review|audit|test|design|architect|migrate|deploy|backend|frontend|database|api|latency|performance|bug|error|broken|issue|should i|should we|best approach)\b/;
  if (heavy.test(lower)) return false;
  return /^(what is|what are|define|explain briefly|summarize|tell me|can you explain)\b/.test(lower);
}

function looksLikeCodeOrPath(prompt: string): boolean {
  return (
    /```/.test(prompt) ||
    /\b[\w.-]+\.(ts|tsx|js|jsx|py|java|go|rs|json|md|css|html|yml|yaml)\b/i.test(prompt) ||
    /[\\/][\w.-]+[\\/][\w.-]+/.test(prompt)
  );
}

/**
 * Cheap heuristic: is this prompt trivial enough to skip Codex + synthesis?
 *
 * The full council adds ~30-60 seconds of cold-start overhead per turn (two
 * extra CLI invocations beyond the Claude worker). For greetings, thanks,
 * acknowledgements, and other very short prompts, that overhead is the
 * entire user experience — the model itself replies in 1-3 seconds. The
 * fast path collapses these to a single Claude call (forced to Haiku via
 * trivialModelOverride below) so they feel instant.
 *
 * False positives (treating a real question as trivial) are bad — the user
 * loses the second perspective. We bias conservative: must look like
 * small-talk AND have no signals of a real coding/design question.
 */
function isTrivialPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;

  // Cap at ~140 chars — long prompts almost always have substance even if
  // they start with "hey". Greeting prompts that go on this long are
  // typically reverberating small talk and still safe to fast-path.
  if (trimmed.length > 140) return false;

  // Hard veto: any prompt mentioning common coding/design intent goes
  // through the full council regardless of length or greeting prefix.
  const substantiveKeywords =
    /\b(write|build|fix|debug|refactor|implement|create|generate|review|analyze|explain|design|architect|plan|optimize|migrate|deploy|test|why|how do i|how can i|what's the best|should i|code|function|class|component|api|database|sql|regex|bug|error|issue|tutorial)\b/i;
  if (substantiveKeywords.test(trimmed)) return false;

  // Very short inputs are basically always greetings/ack — no further
  // pattern matching needed.
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 3) return true;

  // Greeting / ack / thanks / small-talk patterns anchored at start.
  // Word-count cap raised from 6 → 15 because "stacked" greetings like
  // "Hey buddy, how are you? How do you do?" are obviously small talk
  // even though they cross the original limit.
  const triviallyGreets = [
    /^(hi|hello|hey|howdy|yo|sup|hiya|hola)\b/i,
    /^(thanks|thank you|thx|ty|ok|okay|cool|nice|great|awesome|got it|sounds good)\b/i,
    /^(good morning|good afternoon|good evening|good night)\b/i,
    /^(what'?s up|how are you|how's it going|how goes|how do you do)\b/i,
  ];
  if (triviallyGreets.some((re) => re.test(trimmed)) && wordCount <= 15) {
    return true;
  }
  return false;
}

/**
 * On the trivial-prompt fast path we want the cheapest, fastest model
 * regardless of what the user picked in the dropdown for serious work.
 * Opus on a "hey howdy" is 25-30s of waiting for a one-line reply; Haiku
 * does the same in 4-6s. The user's chosen worker model is preserved for
 * non-trivial turns.
 */
const TRIVIAL_FAST_MODEL = "claude-haiku-4-5";
const CODEX_IMPLEMENTATION_MODEL = "gpt-5.4";
const CLAUDE_FAST_CANDIDATES = ["claude-haiku-4-5", "haiku", "claude-sonnet-4-6", "sonnet"];
const CLAUDE_BALANCED_CANDIDATES = ["claude-sonnet-4-6", "sonnet", "claude-haiku-4-5", "haiku"];
const CLAUDE_COMPLEX_CANDIDATES = ["claude-sonnet-4-6", "sonnet", "opus", "claude-haiku-4-5"];
const CLAUDE_DECIDER_FAST_CANDIDATES = ["claude-haiku-4-5", "haiku", "claude-sonnet-4-6", "sonnet"];
const CLAUDE_DECIDER_COMPLEX_CANDIDATES = ["claude-sonnet-4-6", "sonnet", "claude-haiku-4-5", "haiku"];
const CODEX_FAST_CANDIDATES = ["gpt-5.4-mini", "gpt-5.4", "gpt-5.1-codex-mini", "gpt-5-codex"];
const CODEX_IMPLEMENTATION_CANDIDATES = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5-codex",
  "gpt-5.1-codex-mini",
];

function modelCandidates(choice: ModelChoice | undefined, fallback: string): string[] {
  const candidates = uniqueModelCandidates([
    choice?.model || "",
    ...(choice?.candidates || []),
    fallback,
  ]);
  return candidates.length > 0 ? candidates : [""];
}

function uniqueModelCandidates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = (raw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function shouldRetryModelFailure(
  failure: AgentFailureInfo,
  attempt: number,
  totalAttempts: number
): boolean {
  if (attempt >= totalAttempts - 1) return false;
  if (failure.kind === "auth") return false;
  return (
    failure.kind === "model" ||
    failure.kind === "transient" ||
    failure.kind === "timeout" ||
    failure.kind === "quota"
  );
}

function mimeToExt(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    default:
      return ".bin";
  }
}
