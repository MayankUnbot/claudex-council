import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { CATALOG, ModelEntry, ModelProvider } from "./modelCatalog";

/**
 * Discovers which models in CATALOG are actually callable on the user's
 * authenticated `claude` and `codex` CLIs. The CLIs don't expose a "what
 * can I use" introspection API, so we probe each entry with a tiny "ok"
 * call and observe the outcome. Results are cached for 7 days in
 * VS Code's `globalState` so we don't re-probe on every extension start.
 *
 * Expected total cost per full probe round: ~1500–2500 tokens combined
 * across both providers (one ~50-token round-trip per model). User can
 * trigger an immediate re-probe via the "Refresh model availability"
 * command when they upgrade their subscription or a new model launches.
 */

const STATE_KEY = "claudexCouncil.modelAvailability";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PER_PROBE_TIMEOUT_MS = 30_000; // any single probe must finish in 30s
const PARALLEL_LIMIT = 4; // probe at most N models simultaneously

export interface AvailabilityCache {
  /** Unix ms when this snapshot was produced. */
  timestamp: number;
  /** Model IDs the probe confirmed work. */
  available: string[];
  /** Model IDs the probe confirmed do NOT work, with the first error seen. */
  unavailable: Record<string, string>;
  /** Whether the probe ever ran successfully (vs no-cli-found). */
  probeSucceeded: boolean;
  /** True when this snapshot came from runtime learning rather than a full catalog probe. */
  partial?: boolean;
}

export interface ProbeProgress {
  total: number;
  done: number;
  currentId?: string;
  currentResult?: "available" | "unavailable" | "error";
}

const FAILURE_PATTERNS: RegExp[] = [
  /is not supported/i,
  /not supported when using codex with a/i,
  /invalid_request_error/i,
  /invalid model/i,
  /model not found/i,
  /access denied/i,
  /unauthorized/i,
  /no access/i,
  /issue with the selected model/i,
  /may not exist/i,
  /you may not have access/i,
  /unknown model/i,
  /not available/i,
];

export function readCache(context: vscode.ExtensionContext): AvailabilityCache | undefined {
  return context.globalState.get<AvailabilityCache>(STATE_KEY);
}

export function isCacheFresh(cache: AvailabilityCache | undefined): boolean {
  if (!cache) return false;
  if (!cache.probeSucceeded) return false;
  return Date.now() - cache.timestamp < CACHE_TTL_MS;
}

/**
 * Apply availability cache to the raw catalog. Models not in the
 * `available` set are dropped entirely. If no cache exists yet, the full
 * catalog is returned unfiltered (with a marker so the UI can warn).
 */
export function applyAvailability(
  catalog: readonly ModelEntry[],
  cache: AvailabilityCache | undefined
): { filtered: readonly ModelEntry[]; cacheStatus: "fresh" | "stale" | "missing" } {
  if (!cache) {
    return { filtered: catalog, cacheStatus: "missing" };
  }
  if (cache.partial) {
    const blocked = new Set(Object.keys(cache.unavailable));
    return {
      filtered: catalog.filter((m) => !blocked.has(m.id)),
      cacheStatus: isCacheFresh(cache) ? "fresh" : "stale",
    };
  }
  if (!cache.probeSucceeded) {
    return { filtered: catalog, cacheStatus: "missing" };
  }
  const allowed = new Set(cache.available);
  const filtered = catalog.filter((m) => allowed.has(m.id));
  return {
    filtered,
    cacheStatus: isCacheFresh(cache) ? "fresh" : "stale",
  };
}

export function knownModelStatus(
  context: vscode.ExtensionContext,
  modelId: string
): "available" | "unavailable" | "unknown" {
  const id = modelId.trim();
  if (!id) return "unknown";
  const cache = readCache(context);
  if (!cache?.probeSucceeded) return "unknown";
  if (cache.available.includes(id)) return "available";
  if (Object.prototype.hasOwnProperty.call(cache.unavailable, id)) return "unavailable";
  return "unknown";
}

export function pickAvailableModel(
  context: vscode.ExtensionContext,
  candidates: readonly string[],
  unprobedDefault?: string
): { model: string; source: "probed" | "default" | "unknown" | "none" } {
  const ordered = uniqueModelIds(candidates);
  if (ordered.length === 0) return { model: "", source: "none" };

  const cache = readCache(context);
  if (cache && (cache.probeSucceeded || cache.partial)) {
    const available = new Set(cache.available);
    const unavailable = new Set(Object.keys(cache.unavailable));
    const probed = ordered.find((id) => available.has(id));
    if (probed) return { model: probed, source: "probed" };

    const unknown = ordered.find((id) => !unavailable.has(id));
    if (unknown) return { model: unknown, source: "unknown" };
    return { model: "", source: "none" };
  }

  const fallback =
    unprobedDefault && ordered.includes(unprobedDefault) ? unprobedDefault : ordered[0];
  return { model: fallback, source: cache?.probeSucceeded ? "unknown" : "default" };
}

export async function recordRuntimeModelResult(
  context: vscode.ExtensionContext,
  modelId: string | undefined,
  available: boolean,
  error?: string
): Promise<void> {
  const id = (modelId || "").trim();
  if (!id) return;

  const existing = readCache(context);
  const cache: AvailabilityCache = {
    timestamp: existing?.timestamp ?? Date.now(),
    available: uniqueModelIds(existing?.available || []),
    unavailable: { ...(existing?.unavailable || {}) },
    probeSucceeded: existing?.probeSucceeded || available,
    partial: existing?.partial ?? true,
  };

  if (available) {
    cache.available = uniqueModelIds([...cache.available, id]);
    delete cache.unavailable[id];
    cache.probeSucceeded = true;
  } else {
    cache.available = cache.available.filter((m) => m !== id);
    cache.unavailable[id] = (error || "runtime rejection").slice(0, 500);
  }

  await context.globalState.update(STATE_KEY, cache);
}

function uniqueModelIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Run one probe per model in CATALOG, with a parallelism cap. Calls
 * `onProgress` after each probe completes so the webview can update a
 * "Probing your account…" banner. Returns the new cache snapshot.
 */
export async function runFullProbe(
  context: vscode.ExtensionContext,
  onProgress?: (p: ProbeProgress) => void
): Promise<AvailabilityCache> {
  const total = CATALOG.length;
  let done = 0;
  const available: string[] = [];
  const unavailable: Record<string, string> = {};
  let anySuccess = false;

  // Process in parallel batches so we don't fan out 33 concurrent CLI
  // children at once (which would explode RAM + concurrency limits on the
  // upstream API).
  const queue = [...CATALOG];
  while (queue.length > 0) {
    const batch = queue.splice(0, PARALLEL_LIMIT);
    await Promise.all(
      batch.map(async (m) => {
        let result: ProbeResult;
        try {
          result = await probeOne(m);
        } catch (err) {
          result = { available: false, error: String(err).slice(0, 200) };
        }
        done += 1;
        if (result.available) {
          available.push(m.id);
          anySuccess = true;
          onProgress?.({ total, done, currentId: m.id, currentResult: "available" });
        } else {
          unavailable[m.id] = result.error || "unknown";
          onProgress?.({ total, done, currentId: m.id, currentResult: "unavailable" });
        }
      })
    );
  }

  const cache: AvailabilityCache = {
    timestamp: Date.now(),
    available,
    unavailable,
    probeSucceeded: anySuccess, // if literally nothing worked, treat as no probe
    partial: false,
  };
  if (!anySuccess) {
    const existing = readCache(context);
    if (existing) return existing;
  }
  await context.globalState.update(STATE_KEY, cache);
  return cache;
}

interface ProbeResult {
  available: boolean;
  error?: string;
}

async function probeOne(m: ModelEntry): Promise<ProbeResult> {
  if (m.provider === "claude") return probeClaudeModel(m.id);
  return probeCodexModel(m.id);
}

function probeClaudeModel(id: string): Promise<ProbeResult> {
  // `claude -p --model X` with stdin "ok" — fastest possible round-trip.
  // We don't care about the reply text, just the exit code + stderr.
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    getEmptyMcpConfigPath(),
    "--disable-slash-commands",
    "--tools",
    "",
    "--system-prompt",
    "Reply with ok only. Do not call tools.",
    "--max-turns",
    "1",
    "--model",
    id,
  ];
  return runProbe("claude", args, "ok");
}

function probeCodexModel(id: string): Promise<ProbeResult> {
  const args = [
    "exec",
    "-",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "-m",
    id,
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "include_environment_context=false",
    "-c",
    "include_permissions_instructions=false",
    "-c",
    "include_apps_instructions=false",
    "-c",
    "include_skill_instructions=false",
    "-c",
    "include_apply_patch_tool=false",
    "-c",
    'web_search="disabled"',
    "-c",
    "mcp_servers={}",
    "-c",
    'history.persistence="none"',
    "-c",
    'model_reasoning_effort="low"',
    "-c",
    'model_verbosity="low"',
  ];
  return runProbe("codex", args, "ok");
}

function runProbe(command: string, args: string[], stdin: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(resolveBinary(command) || command, args, {
        shell: process.platform === "win32",
        env: process.env,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolve({ available: false, error: `spawn failed: ${String(err).slice(0, 80)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        killProbeTree(proc);
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    timer = setTimeout(() => {
      // Treat a timeout as "available" — slow/loaded models are real and
      // should still appear. Only outright errors prove unavailability.
      killProbeTree(proc);
      settle({ available: true });
    }, PER_PROBE_TIMEOUT_MS);

    proc.stdin?.on("error", () => undefined);
    proc.stdin?.end(stdin, "utf8");
    proc.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    proc.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));

    proc.on("error", (err) => {
      settle({ available: false, error: `error: ${err.message.slice(0, 80)}` });
    });

    proc.on("close", (code) => {
      const combined = (stderr + "\n" + stdout).slice(0, 2000);
      const failureMatch = FAILURE_PATTERNS.find((p) => p.test(combined));
      if (failureMatch) {
        settle({ available: false, error: combined.match(failureMatch)?.[0] || "rejected" });
        return;
      }
      if (code === 0) {
        settle({ available: true });
      } else {
        // Exit code non-zero with no recognized failure pattern — could be
        // a rate-limit, network glitch, or new error string. Be optimistic
        // (treat as available) so we don't accidentally hide a working
        // model. The cache TTL means a future re-probe will reclassify.
        settle({ available: true });
      }
    });
  });
}

function killProbeTree(proc: any): void {
  if (!proc?.pid || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      const tk = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
      tk.on("error", () => undefined);
    } else {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }
  } catch {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
}

function resolveBinary(name: string): string | null {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".CMD;.EXE;.BAT").split(";")
      : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);

  if (process.platform === "darwin") {
    dirs.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.join(os.homedir(), ".npm-global", "bin"),
      path.join(os.homedir(), ".local", "bin"),
      "/usr/bin"
    );
  } else if (process.platform === "linux") {
    dirs.push(
      "/usr/local/bin",
      path.join(os.homedir(), ".npm-global", "bin"),
      path.join(os.homedir(), ".local", "bin"),
      path.join(os.homedir(), "node_modules", ".bin"),
      "/usr/bin"
    );
  } else if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) dirs.push(path.join(appdata, "npm"));
  }

  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

let emptyMcpConfigPath: string | undefined;

function getEmptyMcpConfigPath(): string {
  if (emptyMcpConfigPath && fs.existsSync(emptyMcpConfigPath)) {
    return emptyMcpConfigPath;
  }
  const dir = path.join(os.tmpdir(), "claudex-council");
  fs.mkdirSync(dir, { recursive: true });
  emptyMcpConfigPath = path.join(dir, "empty-mcp.json");
  fs.writeFileSync(emptyMcpConfigPath, '{"mcpServers":{}}', "utf8");
  return emptyMcpConfigPath;
}

/**
 * Convenience: kick off a probe in the background if cache is missing or
 * stale, but don't block the activate() path. Suitable for extension
 * activation. Returns immediately; caller doesn't await.
 */
export function maybeProbeInBackground(
  context: vscode.ExtensionContext,
  onComplete?: (cache: AvailabilityCache) => void
): void {
  const cache = readCache(context);
  if (isCacheFresh(cache)) return;
  // Fire and forget — we're explicit about not blocking activate().
  void runFullProbe(context).then((c) => onComplete?.(c)).catch(() => undefined);
}

export function getProvidersWithCounts(
  cache: AvailabilityCache | undefined
): Record<ModelProvider, number> {
  const counts: Record<ModelProvider, number> = { claude: 0, codex: 0 };
  if (!cache) return counts;
  for (const id of cache.available) {
    const entry = CATALOG.find((m) => m.id === id);
    if (entry) counts[entry.provider] += 1;
  }
  return counts;
}
