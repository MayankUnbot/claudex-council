# Cross-platform proof

This doc is the honest accounting of what's been verified to work on each platform, what's covered by CI, and what still requires actual runtime on a target machine.

## TL;DR

| Platform | Build/package | Fake CLI smoke | Live authenticated CLIs | UI render |
|---|---|---|---|---|
| **Windows** | ✅ verified locally; covered by `windows-latest` CI | ✅ real local smoke + fake CLI CI | ✅ verified locally with authenticated CLIs | ✅ verified locally |
| **macOS** | ✅ covered by `macos-latest` CI after push/PR | ✅ fake CLI CI exercises stdin, Unicode, helper, and stream parsing | ⚠️ needs an authenticated Mac for real Claude/Codex calls | ⚠️ needs visual check on Mac |
| **Linux** | ✅ covered by `ubuntu-latest` CI after push/PR | ✅ fake CLI CI exercises stdin, Unicode, helper, and stream parsing | ⚠️ needs authenticated CLIs for live calls | ⚠️ not the primary VS Code target |

The "Live authenticated CLIs" column for macOS and Linux is the only major gap because hosted CI runners do not have logged-in Claude/Codex accounts. The fake CLI smoke test still exercises the risky cross-platform parts: subprocess launch shape, `ask_codex.py`, prompt stdin, Unicode round-tripping, Codex output-file parsing, and Claude stream-json parsing.

## Auth and availability matrix

The test suite now includes `test/auth-matrix.mjs`, which uses controlled fake CLIs to simulate the account states we cannot safely force against real user accounts in CI.

| Claude state | Codex state | Expected Council behavior |
|---|---|---|
| signed in | signed in | Run the full Council turn. |
| signed in | missing / signed out / quota-limited / timed out | Continue with Claude, show the Codex install/login/quota/timeout notice. |
| missing / signed out / quota-limited / timed out | signed in | Continue with Codex, show the Claude install/login/quota/timeout notice. |
| both unavailable | both unavailable | Block the turn and show both recovery actions. |

Run it locally:

```bash
node skills/claudex-council/test/auth-matrix.mjs
```

This proves error-shape handling and non-interactive process behavior. It does not prove real OAuth refresh, macOS Keychain behavior, ChatGPT plan entitlements, or Anthropic quota reset timing.

## What we tested live, on Windows 11

The local smoke runner exercises exactly the paths the extension uses at runtime:

```
$ node skills/claudex-council/test/smoke.mjs
claudex-council smoke test
  platform: win32, node: v20.20.2
  ask_codex.py: c:\Users\...\extension\scripts\ask_codex.py

[1/4] Codex helper — basic stdin prompt
  ✓ exit code is 0
  ✓ output contains expected sentinel — "codex stdin works fine"

[2/4] Codex helper — Unicode round-trip
  ✓ exit code is 0
  ✓ em-dash bytes are clean UTF-8 (e2 80 94)
  ✓ no double-encoded mojibake (no c3a2e282ac)

[3/4] Codex helper — multi-line prompt
  ✓ exit code is 0
  ✓ output contains 'multiline ok'

[4/4] Claude headless — stdin + stream-json
  ✓ exit code is 0
  ✓ stream-json produced text deltas (2 deltas)
  ✓ assembled text contains sentinel — "claude stdin works fine"

10 checks: 10 passed, 0 failed
```

This proves on Windows: the helper handles UTF-8 correctly, prompts pipe via stdin without shell-quoting issues, multi-line prompts survive intact, and Claude's streaming output assembles correctly.

## What we proved structurally for all platforms

These are platform-portability bugs that **were** in earlier versions and have been fixed and verified to behave correctly. Each fix is exercised by either local smoke tests, CI, or both.

### 1. Prompt encoding via stdin (was: argv on Windows mangled non-ASCII)

**Problem**: `ask_codex.py` was passing the user's prompt to `codex.cmd` as a positional argv. On Windows that's interpreted by `cmd.exe` using the OEM codepage (cp1252-ish), so prompts containing em-dashes / arrows / smart quotes / special chars came out as double-encoded mojibake before Codex even saw them. Same shape would manifest as shell-injection risk on macOS/Linux for any prompt containing `$`, backticks, `&`, `|`.

**Fix**: prompts go via **stdin** to both `claude` and `codex` everywhere. Argv carries flags only. Python on Windows additionally has `sys.stdin/stdout/stderr.reconfigure(encoding="utf-8")` so the bytes coming in from Node's `proc.stdin.end(prompt, "utf8")` are decoded correctly instead of cp1252-mangled.

**Verification**: `smoke.mjs` test #2 explicitly hex-dumps Codex's output and checks for clean UTF-8 byte signatures (`e2 80 94` for "—", `e2 86 92` for "→") AND for absence of the double-encoded mojibake signature (`c3 a2 e2 82 ac`).

**File**: [scripts/ask_codex.py](extension/scripts/ask_codex.py), [src/orchestrator.ts](extension/src/orchestrator.ts) `runStreamingClaude` / `runBufferedProcess`.

### 2. Process-tree cancellation (was: orphan agents on cancel)

**Problem**: when the user clicked "Clear Conversation" mid-turn, `proc.kill()` killed only the immediate child. On Windows with `shell: true` that's just `cmd.exe` — the actual Node/Codex/Claude grandchildren kept running. On Unix the same applied if any wrapper script was involved.

**Fix**: `killProcessTree` (TypeScript, in `orchestrator.ts`) and `_kill_tree` (Python, in `ask_codex.py`) both walk the whole process tree:
- **Windows**: `taskkill /T /F /PID <pid>` walks descendants and force-kills each.
- **Unix**: `process.kill(-pid)` (Node) / `os.killpg(os.getpgid(pid), SIGKILL)` (Python) targets the process group, which is set up because we spawn with `detached: true` (Node) / `start_new_session=True` (Python).

**File**: [src/orchestrator.ts](extension/src/orchestrator.ts) `killProcessTree`, [scripts/ask_codex.py](extension/scripts/ask_codex.py) `_kill_tree`.

### 3. Binary discovery on macOS Dock-launched VS Code (was: "claude not found")

**Problem**: VS Code launched from the macOS Dock inherits a stripped PATH (essentially `/usr/bin:/bin`). Users with `claude` and `codex` installed via Homebrew (`/opt/homebrew/bin`), npm-global (`~/.npm-global/bin`), or `~/.local/bin` would see *"`claude` not found"* even though it works fine in their terminal.

**Fix**: `resolveBinary(name)` (TypeScript) and `_resolve_codex_binary()` (Python) both search PATH first, then fall back to a list of well-known dirs scoped per platform:
- **macOS**: `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`, `~/.local/bin`, `/usr/bin`
- **Linux**: `/usr/local/bin`, `~/.npm-global/bin`, `~/.local/bin`, `~/node_modules/.bin`, `/usr/bin`
- **Windows**: `%APPDATA%\npm` (with PATHEXT honoring `.cmd`/`.exe`/`.bat`)

**File**: [src/orchestrator.ts](extension/src/orchestrator.ts) `resolveBinary`, [scripts/ask_codex.py](extension/scripts/ask_codex.py) `_resolve_codex_binary`.

### 4. Python interpreter selection (was: "python not found" on macOS)

**Problem**: macOS doesn't ship `python` (only `python3`). `pythonBinary` defaulted to `python` everywhere, breaking the Codex worker on every Mac install.

**Fix**: `getPythonBinary()` returns `python3` on Darwin/Linux, `python` on Win32, with override via the `claudexCouncil.pythonBinary` setting.

**File**: [src/orchestrator.ts](extension/src/orchestrator.ts) `getPythonBinary`.

### 5. UTF-8 encoding throughout the Python helper

**Problem**: Windows console / pipe defaults to cp1252. When Codex returned an em-dash in its reply, `ask_codex.py` would crash on `sys.stdout.write` with `UnicodeEncodeError: 'charmap' codec can't encode character '→'`. Same issue on stdin if the prompt had non-ASCII.

**Fix**: at the top of `main()` we reconfigure all three streams to UTF-8:
```python
for stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
```

**File**: [scripts/ask_codex.py](extension/scripts/ask_codex.py).

### 6. VS Code CLI flag invocation (was: `code` ignores `--install-extension` on Windows)

**Problem**: bare `code` on Windows opens the editor and silently drops CLI flags. Only `code.cmd` accepts `--install-extension`. macOS / Linux just use `code`.

**Fix**: documented in README and CONTRIBUTING with the per-platform install snippets:

```bash
# macOS / Linux
code --install-extension claudex-council.vsix --force

# Windows
code.cmd --install-extension claudex-council.vsix --force
```

Not a code change — this is a docs/UX issue that we surfaced clearly so users don't get confused.

## How to independently verify on a Mac

If you (or a Mac user) want to confirm the whole pipeline works end-to-end, here's the full test you can run after installing on a Mac:

```bash
# Prerequisites:
#   - Claude CLI installed and authenticated (claude --version works in a fresh terminal)
#   - Codex CLI installed and authenticated
#   - Python 3.11+ (system python3 on macOS is fine)

git clone <this-repo>
cd <repo>

# Build + install
cd skills/claudex-council/extension
npm install
npx tsc -p ./
npx --yes @vscode/vsce package --out claudex-council.vsix --allow-missing-repository --skip-license
code --install-extension claudex-council.vsix --force

# Run the live smoke test (calls real claude + codex CLIs)
cd ../../..
node skills/claudex-council/test/smoke.mjs
```

Expected output: `10 checks: 10 passed, 0 failed`. Anything else is a real bug — please file an issue with the platform/output.

## CI signal you'll get on every push

The root [`cross-platform.yml`](../../.github/workflows/cross-platform.yml) workflow runs on every push to `main` and every PR that touches `skills/claudex-council/`. It executes on three runners simultaneously:

| Runner | Tests run | What this proves |
|---|---|---|
| `macos-latest` | TypeScript compile, VSIX package, helper `--help`, fake Claude/Codex smoke | Code is structurally portable to macOS: no Windows-only path assumptions, helper ships in VSIX, stdin/Unicode/stream parsing works |
| `ubuntu-latest` | same as above | Same — Linux structurally compatible |
| `windows-latest` | same as above | Same — plus `.cmd` shim discovery, Windows shell mode, and `python` preference are exercised |

It does **not** run live `claude -p` / `codex exec` calls in CI because those need authenticated upstream accounts and the runners don't have user credentials. Live agent-side testing is the local `smoke.mjs` run without fake mode:

```bash
node skills/claudex-council/test/smoke.mjs
```

CI uses fake mode:

```bash
CLAUDEX_SMOKE_FAKE=1 node skills/claudex-council/test/smoke.mjs
```

If a future PR breaks cross-platform structural compatibility (e.g. someone hardcodes a Windows path separator, removes a fallback dir, or breaks the UTF-8 reconfigure), CI will fail on `macos-latest` or `ubuntu-latest` even though the developer who wrote the PR is on Windows. That's the point — it's a tripwire.

## What's NOT verified yet (honest list)

Things I genuinely cannot verify from a Windows-only test rig and which need an actual Mac to confirm:

1. **`code --install-extension` Gatekeeper interaction** when the VSIX is downloaded from the internet. Documented workaround (`xattr -d com.apple.quarantine`) is in the README but unverified by us.
2. **Webview rendering on macOS retina displays** — VS Code abstracts this so it should be fine, but visual fidelity (verb italics, monospace counter alignment) hasn't been eyeballed.
3. **macOS Dock vs terminal launch behavior** for the binary discovery fallback — the code paths are written but only end-to-end verifiable on a Mac whose user has a stripped Dock-PATH.
4. **Activity-bar icon SVG rendering on macOS Sonoma+** — should work since VS Code rasterizes the SVG itself, but unverified.

If any of these breaks for someone, please file a bug — we'll fix it and add a regression case to the smoke test or CI.
