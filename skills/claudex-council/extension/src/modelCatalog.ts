/**
 * Model catalog for the dropdown bar at the top of each council session.
 *
 * Keep this list conservative. IDs here are passed directly to
 * `claude --model` or `codex -m`, so every entry must be a documented
 * provider model ID or a documented provider alias. Avoid invented
 * "nice sounding" names.
 */

export type ModelProvider = "claude" | "codex";
export type ModelTier = "free" | "pro" | "max" | "api";
export type ModelSpeed = "fast" | "balanced" | "thorough";
export type ModelSlot = "planner" | "claudeWorker" | "codexWorker" | "decider";

export interface ModelEntry {
  /** Exact CLI/API model ID. */
  id: string;
  /** Short human-readable name shown in dropdown. */
  label: string;
  /** Long description shown in the option's tooltip. */
  hint?: string;
  provider: ModelProvider;
  /** Approximate minimum subscription tier. Real availability is probed. */
  tier: ModelTier;
  speed: ModelSpeed;
  /** Approximate context window in thousands of tokens. */
  contextK: number;
  /** Slots this model is a sensible recommendation for. */
  recommendedFor?: ModelSlot[];
  /** Tag in the dropdown like "default" or "cheap". */
  badge?: string;
}

export const CATALOG: readonly ModelEntry[] = [
  // Claude current models.
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    hint: "Fastest Claude option. Best default for synthesis and quick replies.",
    provider: "claude",
    tier: "free",
    speed: "fast",
    contextK: 200,
    recommendedFor: ["decider"],
    badge: "cheap",
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5 snapshot",
    hint: "Pinned Haiku 4.5 snapshot.",
    provider: "claude",
    tier: "free",
    speed: "fast",
    contextK: 200,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    hint: "Balanced Claude coding model. Default Claude worker.",
    provider: "claude",
    tier: "pro",
    speed: "balanced",
    contextK: 1000,
    recommendedFor: ["planner", "claudeWorker", "decider"],
    badge: "default",
  },
  {
    id: "opus",
    label: "Claude Opus",
    hint: "Claude Code alias for the latest Opus model available on your account. Best when quality matters more than latency.",
    provider: "claude",
    tier: "max",
    speed: "thorough",
    contextK: 1000,
    badge: "latest alias",
  },
  {
    id: "sonnet",
    label: "Claude Sonnet",
    hint: "Claude Code alias for the latest Sonnet model available on your account.",
    provider: "claude",
    tier: "pro",
    speed: "balanced",
    contextK: 1000,
    badge: "alias",
  },
  {
    id: "haiku",
    label: "Claude Haiku",
    hint: "Claude Code alias for the latest Haiku model available on your account.",
    provider: "claude",
    tier: "free",
    speed: "fast",
    contextK: 200,
    badge: "alias",
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    hint: "Latest Opus generation. Verified callable on Claude.ai accounts logged in via Claude Code (this is the model claude-code v2.1.123 reports for OAuth users).",
    provider: "claude",
    tier: "max",
    speed: "thorough",
    contextK: 200,
  },
  {
    id: "claude-opus-4-7[1m]",
    label: "Claude Opus 4.7 · 1M context",
    hint: "Opus 4.7 with the 1M-token extended context variant. Same quality, much larger window.",
    provider: "claude",
    tier: "max",
    speed: "thorough",
    contextK: 1000,
  },
  {
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    hint: "Previous-gen Opus. Use when 4.7 isn't available or you want a slightly cheaper variant.",
    provider: "claude",
    tier: "max",
    speed: "thorough",
    contextK: 1000,
  },
  {
    id: "claude-opus-4-1-20250805",
    label: "Claude Opus 4.1 snapshot",
    hint: "Pinned Opus 4.1 snapshot.",
    provider: "claude",
    tier: "api",
    speed: "thorough",
    contextK: 200,
  },
  {
    id: "claude-sonnet-4-20250514",
    label: "Claude Sonnet 4 snapshot",
    hint: "Pinned Sonnet 4 snapshot.",
    provider: "claude",
    tier: "api",
    speed: "balanced",
    contextK: 200,
  },

  // OpenAI frontier/current models.
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    hint: "OpenAI flagship for complex reasoning and coding.",
    provider: "codex",
    tier: "pro",
    speed: "balanced",
    contextK: 1000,
    badge: "quality",
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    hint: "Affordable OpenAI model for coding and professional work.",
    provider: "codex",
    tier: "pro",
    speed: "balanced",
    contextK: 1000,
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    hint: "Documented lower-latency OpenAI option. Default Codex worker.",
    provider: "codex",
    tier: "pro",
    speed: "fast",
    contextK: 400,
    recommendedFor: ["codexWorker"],
    badge: "default, fast",
  },
  {
    id: "gpt-5.4-nano",
    label: "GPT-5.4 Nano",
    hint: "Smallest GPT-5.4 option for speed and cost.",
    provider: "codex",
    tier: "api",
    speed: "fast",
    contextK: 400,
  },

  // OpenAI Codex-specialized documented models.
  {
    id: "gpt-5.2-codex",
    label: "GPT-5.2 Codex",
    hint: "Coding-optimized GPT-5.2 model for Codex-style agentic work.",
    provider: "codex",
    tier: "pro",
    speed: "balanced",
    contextK: 1000,
  },
  {
    id: "gpt-5.1-codex",
    label: "GPT-5.1 Codex",
    hint: "Coding-optimized GPT-5.1 model.",
    provider: "codex",
    tier: "pro",
    speed: "balanced",
    contextK: 400,
  },
  {
    id: "gpt-5.1-codex-mini",
    label: "GPT-5.1 Codex Mini",
    hint: "Smaller Codex model for faster and cheaper coding work.",
    provider: "codex",
    tier: "pro",
    speed: "fast",
    contextK: 400,
  },
  {
    id: "gpt-5.1-codex-max",
    label: "GPT-5.1 Codex Max",
    hint: "Codex model optimized for longer-running coding tasks.",
    provider: "codex",
    tier: "max",
    speed: "thorough",
    contextK: 400,
  },
  {
    id: "gpt-5-codex",
    label: "GPT-5 Codex",
    hint: "Coding-optimized GPT-5 model.",
    provider: "codex",
    tier: "pro",
    speed: "balanced",
    contextK: 400,
  },

  // OpenAI general and reasoning models.
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    hint: "Strong OpenAI model for coding and agentic tasks.",
    provider: "codex",
    tier: "pro",
    speed: "balanced",
    contextK: 400,
  },
  {
    id: "gpt-5.2-pro",
    label: "GPT-5.2 Pro",
    hint: "More thorough GPT-5.2 variant.",
    provider: "codex",
    tier: "api",
    speed: "thorough",
    contextK: 400,
  },
  {
    id: "gpt-5.1",
    label: "GPT-5.1",
    hint: "OpenAI model for coding and agentic tasks.",
    provider: "codex",
    tier: "api",
    speed: "balanced",
    contextK: 400,
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    hint: "General GPT-5 model.",
    provider: "codex",
    tier: "api",
    speed: "balanced",
    contextK: 400,
  },
  {
    id: "gpt-5-pro",
    label: "GPT-5 Pro",
    hint: "More thorough GPT-5 variant.",
    provider: "codex",
    tier: "pro",
    speed: "thorough",
    contextK: 400,
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 Mini",
    hint: "Faster, cost-efficient GPT-5 option.",
    provider: "codex",
    tier: "api",
    speed: "fast",
    contextK: 400,
  },
  {
    id: "gpt-5-nano",
    label: "GPT-5 Nano",
    hint: "Fastest, most cost-efficient GPT-5 option.",
    provider: "codex",
    tier: "api",
    speed: "fast",
    contextK: 400,
  },
  {
    id: "o3",
    label: "o3",
    hint: "OpenAI reasoning model for complex tasks.",
    provider: "codex",
    tier: "api",
    speed: "thorough",
    contextK: 200,
  },
  {
    id: "o3-pro",
    label: "o3 Pro",
    hint: "More compute for harder reasoning tasks.",
    provider: "codex",
    tier: "pro",
    speed: "thorough",
    contextK: 200,
  },
  {
    id: "o4-mini",
    label: "o4-mini",
    hint: "Fast, cost-efficient reasoning model.",
    provider: "codex",
    tier: "api",
    speed: "fast",
    contextK: 200,
  },
  {
    id: "o3-mini",
    label: "o3-mini",
    hint: "Small o3 reasoning option.",
    provider: "codex",
    tier: "api",
    speed: "fast",
    contextK: 200,
  },
];

export const DEFAULT_SELECTIONS: Record<ModelSlot, string> = {
  planner: "claude-sonnet-4-6",
  claudeWorker: "claude-sonnet-4-6",
  codexWorker: "gpt-5.4-mini",
  decider: "claude-haiku-4-5",
};

export function modelsForSlot(slot: ModelSlot): readonly ModelEntry[] {
  switch (slot) {
    case "planner":
      return CATALOG.filter((m) => m.provider === "claude");
    case "claudeWorker":
      return CATALOG.filter((m) => m.provider === "claude");
    case "codexWorker":
      return CATALOG.filter((m) => m.provider === "codex");
    case "decider":
      return CATALOG;
  }
}

export function findModel(id: string): ModelEntry | undefined {
  return CATALOG.find((m) => m.id === id);
}
