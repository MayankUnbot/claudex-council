#!/usr/bin/env node
/**
 * Cross-platform smoke test for the claudex-council spawn paths.
 *
 * Runs on macOS, Linux, and Windows. Exercises exactly the same code
 * paths the extension uses at runtime — `claude -p` via stdin and
 * `ask_codex.py` via stdin — and asserts:
 *
 *   - exit code is 0
 *   - output contains the expected sentinel string
 *   - non-ASCII characters round-trip cleanly (no double-encoded mojibake)
 *
 * Run from the repo root:
 *   node skills/claudex-council/test/smoke.mjs
 *
 * In CI it's invoked from .github/workflows/cross-platform.yml on
 * macos-latest, windows-latest, and ubuntu-latest runners. Any test
 * failure on any platform fails the workflow.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Buffer } from "node:buffer";

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

const PYTHON = process.platform === "win32" ? "python" : "python3";
const SHELL = process.platform === "win32";
const USE_FAKE_CLIS = process.env.CLAUDEX_SMOKE_FAKE === "1";
const COLOR = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

if (USE_FAKE_CLIS) {
  const fakeBinDir = installFakeClis();
  process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH || ""}`;
}

async function runProc(cmd, args, stdin, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { shell: SHELL });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        p.kill();
      } catch {
        /* best effort */
      }
      resolve({
        code: 124,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8") + `\nTimed out after ${timeoutMs}ms`,
        stdoutBytes: Buffer.concat(chunks),
      });
    }, timeoutMs);
    if (stdin !== undefined) p.stdin.end(stdin, "utf8");
    const chunks = [];
    const errChunks = [];
    p.stdout.on("data", (b) => chunks.push(b));
    p.stderr.on("data", (b) => errChunks.push(b));
    p.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: String(err), stdoutBytes: Buffer.alloc(0) });
    });
    p.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        stdoutBytes: Buffer.concat(chunks),
      })
    });
  });
}

function installFakeClis() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-smoke-"));
  const fakeCodexJs = path.join(dir, "fake-codex.js");
  const fakeClaudeJs = path.join(dir, "fake-claude.js");

  fs.writeFileSync(
    fakeCodexJs,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
  console.log("codex-cli fake");
  process.exit(0);
}
let outPath = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-o" || args[i] === "--output-last-message") outPath = args[i + 1] || "";
}
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  let answer = "fake codex answer";
  if (/alpha/.test(input)) answer = "alpha — bravo → charlie · done";
  else if (/multiline/i.test(input)) answer = "multiline ok";
  else if (/codex stdin works fine/i.test(input)) answer = "codex stdin works fine";
  if (outPath) fs.writeFileSync(outPath, answer, "utf8");
  else console.log(answer);
  console.log(JSON.stringify({
    usage: {
      input_tokens: 12,
      output_tokens: 3,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0
    }
  }));
});
`,
    "utf8"
  );

  fs.writeFileSync(
    fakeClaudeJs,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const text = /claude stdin works fine/i.test(input)
    ? "claude stdin works fine"
    : "fake claude answer";
  const jsonMode = args.includes("--output-format") && args[args.indexOf("--output-format") + 1] === "json";
  if (jsonMode) {
    console.log(JSON.stringify({
      type: "result",
      subtype: "success",
      result: text,
      usage: { input_tokens: 1, output_tokens: 4 }
    }));
    return;
  }
  for (const part of [text.slice(0, 13), text.slice(13)]) {
    console.log(JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: part }
      }
    }));
  }
});
`,
    "utf8"
  );

  if (process.platform === "win32") {
    fs.writeFileSync(path.join(dir, "codex.cmd"), `@echo off\r\nnode "%~dp0\\fake-codex.js" %*\r\n`, "utf8");
    fs.writeFileSync(path.join(dir, "claude.cmd"), `@echo off\r\nnode "%~dp0\\fake-claude.js" %*\r\n`, "utf8");
  } else {
    const codexPath = path.join(dir, "codex");
    const claudePath = path.join(dir, "claude");
    fs.copyFileSync(fakeCodexJs, codexPath);
    fs.copyFileSync(fakeClaudeJs, claudePath);
    fs.chmodSync(codexPath, 0o755);
    fs.chmodSync(claudePath, 0o755);
  }
  return dir;
}

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ${COLOR.green("✓")} ${name}${detail ? COLOR.dim(" — " + detail) : ""}`);
  } else {
    failed += 1;
    console.log(`  ${COLOR.red("✗")} ${name}${detail ? COLOR.dim(" — " + detail) : ""}`);
  }
}

async function testCodexHelperSmoke() {
  console.log("\n[1/4] Codex helper — basic stdin prompt");
  const result = await runProc(
    PYTHON,
    [askCodex, "--cwd", repoRoot],
    "Reply with exactly the four words: codex stdin works fine. Nothing else."
  );
  check("exit code is 0", result.code === 0, `exit=${result.code}`);
  check(
    "output contains expected sentinel",
    /codex stdin works fine/i.test(result.stdout),
    `got: ${JSON.stringify(result.stdout.trim().slice(0, 80))}`
  );
}

async function testCodexHelperUnicode() {
  console.log("\n[2/4] Codex helper — Unicode round-trip");
  const result = await runProc(
    PYTHON,
    [askCodex, "--cwd", repoRoot],
    "Reply with exactly: alpha — bravo → charlie · done"
  );
  check("exit code is 0", result.code === 0, `exit=${result.code}`);
  // The em-dash is U+2014 → UTF-8 bytes E2 80 94. The arrow is U+2192 →
  // E2 86 92. If our pipeline double-encodes (the Windows cp1252 bug we
  // fixed), we'd see C3 A2 E2 82 AC ... instead.
  const hex = result.stdoutBytes.toString("hex");
  check(
    "em-dash bytes are clean UTF-8 (e2 80 94)",
    hex.includes("e28094"),
    `bytes: ${hex.slice(0, 60)}…`
  );
  check(
    "no double-encoded mojibake (no c3a2e282ac)",
    !hex.includes("c3a2e282ac"),
    "absence of double-encode signature"
  );
}

async function testCodexHelperMultiline() {
  console.log("\n[3/4] Codex helper — multi-line prompt");
  const prompt = [
    "Read these three lines.",
    "Line two has special chars: $variable, `backticks`, && pipes |.",
    "Line three asks: reply with exactly 'multiline ok'.",
  ].join("\n");
  const result = await runProc(PYTHON, [askCodex, "--cwd", repoRoot], prompt);
  check("exit code is 0", result.code === 0, `exit=${result.code}`);
  check(
    "output contains 'multiline ok'",
    /multiline ok/i.test(result.stdout),
    `got: ${JSON.stringify(result.stdout.trim().slice(0, 80))}`
  );
}

async function testClaudeHeadlessStdin() {
  console.log("\n[4/4] Claude headless — stdin + stream-json");
  const result = await runProc(
    "claude",
    ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"],
    "Reply with exactly four words: claude stdin works fine"
  );
  check("exit code is 0", result.code === 0, `exit=${result.code}`);
  // Pull text deltas out of the streaming JSON envelope and assemble them.
  const deltas = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (
        ev.type === "stream_event" &&
        ev.event?.type === "content_block_delta" &&
        ev.event.delta?.type === "text_delta"
      ) {
        deltas.push(ev.event.delta.text);
      }
    } catch {
      /* ignore non-JSON noise */
    }
  }
  const assembled = deltas.join("");
  check(
    "stream-json produced text deltas",
    deltas.length > 0,
    `${deltas.length} deltas`
  );
  check(
    "assembled text contains sentinel",
    /claude stdin works fine/i.test(assembled),
    `got: ${JSON.stringify(assembled.slice(0, 80))}`
  );
}

(async () => {
  console.log(`claudex-council smoke test`);
  console.log(`  platform: ${process.platform}, node: ${process.version}`);
  console.log(`  ask_codex.py: ${askCodex}`);
  if (USE_FAKE_CLIS) console.log("  mode: fake claude/codex CLIs");

  try {
    await testCodexHelperSmoke();
    await testCodexHelperUnicode();
    await testCodexHelperMultiline();
    await testClaudeHeadlessStdin();
  } catch (err) {
    console.log(COLOR.red(`\nUnexpected exception: ${err && err.stack ? err.stack : err}`));
    failed += 1;
  }

  console.log(
    `\n${passed + failed} checks: ${COLOR.green(passed + " passed")}, ${
      failed > 0 ? COLOR.red(failed + " failed") : "0 failed"
    }`
  );
  process.exit(failed === 0 ? 0 : 1);
})();
