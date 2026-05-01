export type CouncilOwner = "planner" | "claude" | "codex" | "decider" | "either";
export type CouncilTaskStatus = "planned" | "in_progress" | "blocked" | "done" | "dropped";
export type CouncilRunPhase = "intake" | "plan" | "execute" | "coordinate" | "clarify" | "compose" | "done";

export interface CouncilTaskClaim {
  files?: string[];
  topics?: string[];
}

export interface CouncilBlocker {
  id: string;
  source: CouncilOwner;
  taskId?: string;
  question: string;
  needs: "user" | "peer";
}

export interface CouncilTaskRound {
  round: number;
  output?: string;
  blockers?: CouncilBlocker[];
}

export interface CouncilTask {
  id: string;
  owner: CouncilOwner;
  goal: string;
  rationale: string;
  deps: string[];
  claims: CouncilTaskClaim;
  status: CouncilTaskStatus;
  rounds: CouncilTaskRound[];
}

export interface CouncilDecision {
  at: number;
  text: string;
}

export interface CouncilRun {
  id: string;
  turnId: string;
  userPrompt: string;
  phase: CouncilRunPhase;
  round: number;
  tasks: CouncilTask[];
  pendingClarifications: CouncilBlocker[];
  decisions: CouncilDecision[];
  finalAnswer?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CoordinatorLaneLike {
  mission: string;
  tasks: string[];
  avoid: string[];
}

export interface CoordinatorPlanLike {
  summary: string;
  claudeLane: CoordinatorLaneLike;
  codexLane: CoordinatorLaneLike;
  synthesisStrategy: string;
  coordinationNotes: string[];
}

export interface ClarificationReview {
  needsClarification: boolean;
  questions: string[];
  rationale?: string;
}

export function createCouncilRun(turnId: string, userPrompt: string): CouncilRun {
  const now = Date.now();
  return {
    id: `run-${turnId}`,
    turnId,
    userPrompt,
    phase: "intake",
    round: 1,
    tasks: [],
    pendingClarifications: [],
    decisions: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function applyCoordinatorPlanToRun(
  run: CouncilRun,
  plan: CoordinatorPlanLike,
  opts: { runCodex: boolean }
): void {
  run.phase = "plan";
  run.tasks = [];
  run.decisions.push({
    at: Date.now(),
    text: `Plan: ${plan.summary}`,
  });
  run.tasks.push({
    id: "t1",
    owner: "claude",
    goal: plan.claudeLane.mission || "Handle the repo-aware lane.",
    rationale: "Claude is responsible for project-context-heavy reasoning and primary execution guidance.",
    deps: [],
    claims: { topics: plan.claudeLane.tasks.slice(0, 8) },
    status: "planned",
    rounds: [],
  });
  if (opts.runCodex) {
    run.tasks.push({
      id: "t2",
      owner: "codex",
      goal: plan.codexLane.mission || "Handle the independent verification lane.",
      rationale: "Codex is responsible for the independent pass, missed risks, and concrete verification.",
      deps: [],
      claims: { topics: plan.codexLane.tasks.slice(0, 8) },
      status: "planned",
      rounds: [],
    });
  }
  run.tasks.push({
    id: opts.runCodex ? "t3" : "t2",
    owner: "decider",
    goal: plan.synthesisStrategy || "Merge council outputs into one answer.",
    rationale: "The user should receive one coherent council answer, not conflicting agent fragments.",
    deps: run.tasks.map((task) => task.id),
    claims: { topics: plan.coordinationNotes.slice(0, 8) },
    status: "planned",
    rounds: [],
  });
  touch(run);
}

export function markOwnerRunning(run: CouncilRun, owner: CouncilOwner): void {
  run.phase = "execute";
  for (const task of run.tasks.filter((t) => t.owner === owner)) {
    if (task.status === "planned") task.status = "in_progress";
  }
  touch(run);
}

export function recordOwnerOutput(
  run: CouncilRun,
  owner: CouncilOwner,
  output: string,
  blockers: CouncilBlocker[] = []
): void {
  const task = run.tasks.find((t) => t.owner === owner);
  if (!task) return;
  task.status = blockers.length > 0 ? "blocked" : "done";
  task.rounds.push({
    round: run.round,
    output,
    blockers,
  });
  if (blockers.length > 0) {
    run.pendingClarifications = mergeBlockers(run.pendingClarifications, blockers);
  }
  touch(run);
}

export function applyClarificationReview(
  run: CouncilRun,
  review: ClarificationReview,
  sources: { claude?: string; codex?: string }
): void {
  run.phase = review.needsClarification ? "clarify" : "coordinate";
  if (!review.needsClarification) {
    run.pendingClarifications = [];
    if (review.rationale) {
      run.decisions.push({ at: Date.now(), text: `Clarification review: ${review.rationale}` });
    }
    touch(run);
    return;
  }
  const blockers = review.questions.map((question, idx) => ({
    id: `q${run.pendingClarifications.length + idx + 1}`,
    source: "decider" as CouncilOwner,
    question,
    needs: "user" as const,
  }));
  run.pendingClarifications = mergeBlockers(run.pendingClarifications, blockers);
  if (review.rationale) {
    run.decisions.push({ at: Date.now(), text: `Clarification review: ${review.rationale}` });
  }
  const heuristicBlockers = [
    ...extractUserQuestions(sources.claude || "", "claude"),
    ...extractUserQuestions(sources.codex || "", "codex"),
  ];
  run.pendingClarifications = mergeBlockers(run.pendingClarifications, heuristicBlockers);
  touch(run);
}

export function markComposed(run: CouncilRun, finalAnswer: string): void {
  run.phase = "done";
  run.finalAnswer = finalAnswer;
  for (const task of run.tasks.filter((t) => t.owner === "decider")) {
    task.status = "done";
    task.rounds.push({ round: run.round, output: finalAnswer });
  }
  touch(run);
}

export function renderLedgerForPrompt(run: CouncilRun): string {
  const lines = [
    '<COUNCIL_LEDGER compact="true">',
    `run_id: ${run.id}`,
    `phase: ${run.phase}`,
    `round: ${run.round}`,
    "tasks:",
    ...run.tasks.map((task) => {
      const deps = task.deps.length ? ` deps=${task.deps.join(",")}` : "";
      const claims = [
        task.claims.files?.length ? `files=${task.claims.files.join(",")}` : "",
        task.claims.topics?.length ? `topics=${task.claims.topics.join(" | ")}` : "",
      ].filter(Boolean).join("; ");
      return `- ${task.id} owner=${task.owner} status=${task.status}${deps}: ${task.goal}${claims ? ` (${claims})` : ""}`;
    }),
  ];
  if (run.decisions.length > 0) {
    lines.push("decisions:", ...run.decisions.slice(-6).map((d) => `- ${d.text}`));
  }
  if (run.pendingClarifications.length > 0) {
    lines.push(
      "pending_clarifications:",
      ...run.pendingClarifications.map((b) => `- ${b.question}`)
    );
  }
  lines.push("</COUNCIL_LEDGER>");
  return lines.join("\n");
}

export function renderClarificationMarkdown(run: CouncilRun): string {
  const questions = mergeQuestions(run.pendingClarifications.map((b) => b.question));
  const lines = [
    "The council needs a little more input before it can execute cleanly.",
    "",
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    "Reply with the answers in one message and the next council turn will continue from this context.",
  ];
  return lines.join("\n");
}

export function extractUserQuestions(text: string, source: CouncilOwner): CouncilBlocker[] {
  const out: CouncilBlocker[] = [];
  const normalized = text.replace(/\r/g, "");
  const questionLines = normalized
    .split("\n")
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((line) => line.length > 8 && line.length < 260 && line.includes("?"));
  for (const line of questionLines.slice(0, 6)) {
    if (isRhetoricalQuestion(line)) continue;
    out.push({
      id: `${source}-${out.length + 1}`,
      source,
      question: line,
      needs: "user",
    });
  }
  return out;
}

export function mergeQuestions(questions: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of questions) {
    const q = raw.trim().replace(/\s+/g, " ");
    if (!q) continue;
    const key = q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const shortKey = key.split(" ").slice(0, 10).join(" ");
    if (seen.has(key) || seen.has(shortKey)) continue;
    seen.add(key);
    seen.add(shortKey);
    out.push(q.endsWith("?") ? q : `${q}?`);
  }
  return out.slice(0, 6);
}

function mergeBlockers(existing: CouncilBlocker[], next: CouncilBlocker[]): CouncilBlocker[] {
  const questions = mergeQuestions([...existing, ...next].map((b) => b.question));
  return questions.map((question, idx) => {
    const source = [...existing, ...next].find((b) => normalizeQuestion(b.question) === normalizeQuestion(question));
    return {
      id: source?.id || `q${idx + 1}`,
      source: source?.source || "decider",
      taskId: source?.taskId,
      question,
      needs: source?.needs || "user",
    };
  });
}

function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isRhetoricalQuestion(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    lower.includes("what does this mean") ||
    lower.includes("why does this matter") ||
    lower.includes("so what") ||
    lower.includes("right?")
  );
}

function touch(run: CouncilRun): void {
  run.updatedAt = Date.now();
}
