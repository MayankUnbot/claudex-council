#!/usr/bin/env node
/**
 * Simulate Claude/Codex availability states without real account credentials.
 *
 * This is intentionally fake-CLI based. It proves that our non-interactive
 * command shape can observe success, missing binary, auth, quota, and timeout
 * signals on every OS. It does not prove real OAuth/Keychain/ChatGPT session
 * behavior; that still requires a real signed-in machine.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const askCodex = path.join(
  repoRoot,
  "skills",
  "claudex-council",
  "extension",
  "scripts",
  "ask_codex.py"
);

const SHELL = process.platform === "win32";
const PYTHON = findCommand(process.platform === "win32" ? ["python.exe", "python"] : ["python3", "python"]);
if (!PYTHON) {
  console.error("Could not find python/python3 on PATH.");
  process.exit(1);
}

const CASES = [
  {
    name: "both signed in",
    claude: "ok",
    codex: "ok",
    expected: "full Council turn can run",
  },
  {
    name: "Claude signed in, Codex missing",
    claude: "ok",
    codex: "missing",
    expected: "continue with Claude; show Codex install/PATH guidance",
  },
  {
    name: "Claude signed in, Codex signed out",
    claude: "ok",
    codex: "auth",
    expected: "continue with Claude; ask user to run codex login flow",
  },
  {
    name: "Claude signed in, Codex quota-limited",
    claude: "ok",
    codex: "quota",
    expected: "continue with Claude; show quota/reset guidance",
  },
  {
    name: "Codex signed in, Claude missing",
    claude: "missing",
    codex: "ok",
    expected: "continue with Codex; show Claude install/PATH guidance",
  },
  {
    name: "Codex signed in, Claude signed out",
    claude: "auth",
    codex: "ok",
    expected: "continue with Codex; ask user to run Claude login flow",
  },
  {
    name: "Codex signed in, Claude quota-limited",
    claude: "quota",
    codex: "ok",
    expected: "continue with Codex; show quota/reset guidance",
  },
  {
    name: "both signed out",
    claude: "auth",
    codex: "auth",
    expected: "block the turn; show both login actions",
  },
  {
    name: "both missing",
    claude: "missing",
    codex: "missing",
    expected: "block the turn; show install/PATH actions for both",
  },
  {
    name: "both quota-limited",
    claude: "quota",
    codex: "quota",
    expected: "block the turn; show quota/reset guidance for both",
  },
  {
    name: "Codex timeout, Claude ok",
    claude: "ok",
    codex: "timeout",
    expected: "continue with Claude; show Codex timeout guidance",
  },
  {
    name: "Claude timeout, Codex ok",
    claude: "timeout",
    codex: "ok",
    expected: "continue with Codex; show Claude timeout guidance",
  },
];

let passed = 0;
let failed = 0;

console.log("claudex-council auth/availability matrix");
console.log(`  platform: ${process.platform}, node: ${process.version}`);
console.log(`  python: ${PYTHON}`);
console.log(`  ask_codex.py: ${askCodex}`);

for (const scenario of CASES) {
  const fakeBin = installFakeClis(scenario);
  const env = makeChildEnv(fakeBin, scenario);
  const [claudeResult, codexResult] = await Promise.all([
    runClaudeProbe(env, scenario.claude),
    runCodexProbe(env, scenario.codex),
  ]);
  const ok =
    claudeResult.kind === expectedKind(scenario.claude) &&
    codexResult.kind === expectedKind(scenario.codex);

  if (ok) passed += 1;
  else failed += 1;

  const mark = ok ? "PASS" : "FAIL";
  console.log(`\n[${mark}] ${scenario.name}`);
  console.log(`  Claude: ${claudeResult.kind} (exit ${claudeResult.code})`);
  console.log(`  Codex:  ${codexResult.kind} (exit ${codexResult.code})`);
  console.log(`  Expected product behavior: ${scenario.expected}`);
  if (!ok) {
    console.log(`  Claude raw: ${oneLine(claudeResult.raw)}`);
    console.log(`  Codex raw: ${oneLine(codexResult.raw)}`);
  }
}

console.log(`\n${passed + failed} scenarios: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;

async function runClaudeProbe(env, mode) {
  if (mode === "timeout") {
    return classifyResult(
      "claude",
      await runProc(
        "claude",
        ["-p", "--output-format", "stream-json", "--include-partial-messages"],
        "Reply with exactly: ok",
        env,
        1500
      )
    );
  }
  return classifyResult(
    "claude",
    await runProc(
      "claude",
      ["-p", "--output-format", "stream-json", "--include-partial-messages"],
      "Reply with exactly: ok",
      env,
      5000
    )
  );
}

async function runCodexProbe(env, mode) {
  const timeout = mode === "timeout" ? "1" : "5";
  return classifyResult(
    "codex",
    await runProc(
      PYTHON,
      [askCodex, "--cwd", repoRoot, "--timeout", timeout, "--codex-binary", "codex"],
      "Reply with exactly: ok",
      env,
      mode === "timeout" ? 5000 : 8000
    )
  );
}

function runProc(command, args, stdin, env, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(command, args, {
        shell: SHELL,
        env,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err) });
      return;
    }

    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        killTree(proc);
      } catch {
        /* best effort */
      }
      resolve({
        code: 124,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8") + `\nTimed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.stdin?.on("error", () => undefined);
    proc.stdin?.end(stdin, "utf8");
    proc.stdout?.on("data", (b) => out.push(b));
    proc.stderr?.on("data", (b) => err.push(b));
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: String(e) });
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

function killTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => undefined);
    return;
  }
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* best effort */
    }
  }
}

function classifyResult(agent, result) {
  const raw = `${result.stderr || ""}\n${result.stdout || ""}`;
  const lower = raw.toLowerCase();
  let kind = "error";
  if (result.code === 0) kind = "ok";
  else if (
    lower.includes("cli not found") ||
    lower.includes("failed to spawn") ||
    lower.includes("spawn") && lower.includes("enoent") ||
    lower.includes("command not found") ||
    lower.includes("not recognized as an internal or external command") ||
    lower.includes("no such file or directory")
  ) {
    kind = "missing";
  } else if (
    lower.includes("not authenticated") ||
    lower.includes("not logged in") ||
    lower.includes("not signed in") ||
    lower.includes("login required") ||
    lower.includes("please run /login") ||
    lower.includes("authentication_error") ||
    lower.includes("api error: 401") ||
    lower.includes("unauthorized")
  ) {
    kind = "auth";
  } else if (
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("usage limit") ||
    lower.includes("weekly limit") ||
    lower.includes("daily limit")
  ) {
    kind = "quota";
  } else if (result.code === 124 || lower.includes("timed out") || lower.includes("timeout")) {
    kind = "timeout";
  }
  return { agent, kind, code: result.code, raw };
}

function expectedKind(mode) {
  return mode === "ok" ? "ok" : mode;
}

function installFakeClis(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-auth-matrix-"));
  const fakeClaudeJs = path.join(dir, "fake-claude.js");
  const fakeCodexJs = path.join(dir, "fake-codex.js");
  fs.writeFileSync(fakeClaudeJs, fakeClaudeSource(), "utf8");
  fs.writeFileSync(fakeCodexJs, fakeCodexSource(), "utf8");

  if (scenario.claude !== "missing") {
    writeWrapper(dir, "claude", fakeClaudeJs);
  }
  if (scenario.codex !== "missing") {
    writeWrapper(dir, "codex", fakeCodexJs);
  }
  return dir;
}

function writeWrapper(dir, name, scriptPath) {
  if (process.platform === "win32") {
    const target = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(
      target,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      "utf8"
    );
    return;
  }
  const target = path.join(dir, name);
  fs.writeFileSync(
    target,
    `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
    "utf8"
  );
  fs.chmodSync(target, 0o755);
}

function fakeClaudeSource() {
  return `#!/usr/bin/env node
const mode = process.env.CLAUDEX_FAKE_CLAUDE_MODE || "ok";
if (mode === "auth") {
  console.error("OAuth token has expired. Please run /login. API Error: 401 authentication_error");
  process.exit(1);
}
if (mode === "quota") {
  console.error("You've hit your weekly limit. resets Mon 12:00am");
  process.exit(1);
}
if (mode === "timeout") {
  setTimeout(() => {}, 60000);
  return;
}
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "ok" }
    }
  }));
});
`;
}

function fakeCodexSource() {
  return `#!/usr/bin/env node
const fs = require("fs");
const mode = process.env.CLAUDEX_FAKE_CODEX_MODE || "ok";
const args = process.argv.slice(2);
let outPath = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-o" || args[i] === "--output-last-message") outPath = args[i + 1] || "";
}
if (mode === "auth") {
  console.error("Not authenticated. Run codex to sign in.");
  process.exit(1);
}
if (mode === "quota") {
  console.error("rate_limit: 429 quota exceeded; usage limit reached");
  process.exit(1);
}
if (mode === "timeout") {
  setTimeout(() => {}, 60000);
  return;
}
process.stdin.resume();
process.stdin.on("end", () => {
  if (outPath) fs.writeFileSync(outPath, "ok", "utf8");
  else console.log("ok");
  console.log(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
});
`;
}

function makeChildEnv(fakeBin, scenario) {
  const env = {
    ...process.env,
    CLAUDEX_FAKE_CLAUDE_MODE: scenario.claude,
    CLAUDEX_FAKE_CODEX_MODE: scenario.codex,
  };
  const safePath = [fakeBin, path.dirname(PYTHON)];
  if (process.platform === "win32") {
    const root = process.env.SystemRoot || "C:\\Windows";
    safePath.push(path.join(root, "System32"), root);
    env.PATHEXT = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
    env.APPDATA = path.join(fakeBin, "appdata");
  } else {
    safePath.push("/bin", "/usr/bin");
    env.HOME = path.join(fakeBin, "home");
  }
  env.PATH = unique(safePath).join(path.delimiter);
  return env;
}

function findCommand(names) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  for (const dir of dirs) {
    for (const name of names) {
      const hasExt = path.extname(name) !== "";
      for (const ext of hasExt ? [""] : exts) {
        const candidate = path.join(dir, name + ext);
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 220);
}
