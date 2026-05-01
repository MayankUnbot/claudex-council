# Changelog

## [0.6.0] - 2026-05-01

### Added
- **`claude auth status` pre-flight on session create.** New session opens
  trigger a fast (~100ms) probe via the official Claude CLI auth-status
  command. If the user isn't signed in, a single actionable warning toast
  fires with an "Open Terminal" button that runs `claude login` for them.
  The probe is fire-and-forget so it never delays session creation.
- **`CLAUDE_CODE_OAUTH_TOKEN` env pass-through (already worked, now
  documented).** Set the token from `claude setup-token` to authenticate
  `claude -p` without browser-based OAuth — needed for CI runners,
  Docker, remote dev boxes, and locked-down corporate Macs.
- **Synthesis fallback banner.** When the synthesizer fails (auth,
  missing CLI, etc.) and the Council substitutes a worker's raw answer,
  the user now sees a short italic notice — *"Council synthesis
  unavailable; showing the working agent's answer directly"* — so they
  know the answer didn't go through merge.

### Fixed
- **Auth detection now matches what the CLIs actually say.** Added the
  real Claude/Codex error strings: `invalid api key`, `please run claude
  login`, `please run codex login`, `missing credentials`, `403
  forbidden`, `expired token`, `oauthtokenexpired`. Previously these
  fell through to a generic "Claude failed" message with no recovery
  guidance.
- **Auth and missing-CLI failures now cool down for 5 minutes.** Without
  this, the orchestrator re-spawned the broken CLI on every successive
  turn and burned another 60s on the worker timeout. Cooldown matches
  the existing 15-min behavior for quota failures, with a shorter TTL
  because users typically fix auth/install issues quickly.
- **Mac binary fallback now includes `~/Library/pnpm`.** Codex installed
  via `pnpm i -g @openai/codex` (a real path users hit) was previously
  invisible to the resolver when VS Code launched from the Dock.
- **Linux binary fallback now includes `~/.cargo/bin` and `/snap/bin`.**
  Catches Rust-installed and Ubuntu snap-installed CLIs.
- **Windows binary fallback now includes `%LOCALAPPDATA%\\pnpm`.**
  Symmetric with the Mac/Linux pnpm additions above.

## Unreleased

### Documentation
- Added a public value proposition guide for Claudex Council, including best-fit use cases, example prompts, benefits, pros/cons, and safe marketing claims.
- Updated the README to explain where the Council shines, what users gain, and when a full council turn is intentionally overkill.
- Added cross-platform confidence notes for Windows/macOS parity and linked the verification matrix.
- Rewrote the account-limits section for free, Plus/Pro, Max/API, and team users, including budget-safe settings and upstream docs links.
- Clarified that Max/Pro-level quota is not required, but full Council value requires both Claude and Codex CLIs to be installed, signed in, and currently within quota.
- Added a Windows bootstrap path that minimizes fresh-machine setup friction.

### Added
- `scripts/install-windows.ps1` to automate per-user Node/Python fallback installs, Claude/Codex CLI installs, VSIX build/install, npm-shim hardening, and VS Code binary settings.

### Testing
- Added a root GitHub Actions workflow that builds, packages, and runs fake Claude/Codex smoke tests on macOS, Windows, and Ubuntu.
- Extended the smoke test with `CLAUDEX_SMOKE_FAKE=1` so CI can verify stdin, Unicode, helper, output-file, and stream-json behavior without authenticated Claude/Codex accounts.
- Added an auth/availability matrix simulation covering signed-in, missing CLI, signed-out, quota-limited, and timeout states for both Claude and Codex.

### Fixed
- Missing CLI and expired-login failures now classify as install/login guidance instead of generic lane failures.
- When the default synthesis provider is unavailable but the other worker succeeded, the Council now returns the successful lane directly instead of adding a noisy synthesis failure.
- Child processes now augment PATH with common Windows Node/npm/Python locations, fixing the case where `codex.cmd` is found but cannot locate `node.exe` because VS Code was launched before PATH changed.
- Explicit `full council`, `codex lane`, or `test codex` prompts now bypass the quick-prompt fast path so users can verify both lanes without crafting a large task.

## [0.5.12] - 2026-05-01

### Changed
- **Planner naming.** The initial routing bubble is now labelled `Planner`; the final synthesis bubble remains `Decider`, giving the turn a clearer sequence: Planner -> Claude/Codex -> Decider.
- **Strict model catalog.** Removed plausible-but-undocumented model IDs and replaced them with documented Claude/OpenAI IDs. The fast Codex default is now `gpt-5.4-mini` instead of the questionable `gpt-5.3-codex-spark`.

## [0.5.11] - 2026-05-01

### Changed
- **Real decider routing.** The plan bubble is no longer a static placeholder. It now chooses and renders a concrete route immediately: Claude-only for conversational/direct prompts, Economy mode when enabled, and full Claude + Codex + synthesis for real implementation, debugging, review, and design work.
- **Worker-specific briefs.** The decider now gives Claude a repo-aware worker brief and Codex an independent second-pass brief, so the two agents do complementary work instead of receiving identical undirected prompts.

## [0.5.10] - 2026-05-01

### Changed
- **Latency-first default path.** Codex worker now defaults to `gpt-5.3-codex-spark` instead of the heavier flagship model. GPT-5.5 remains available as the quality pick in the dropdown.
- **No blind agent retries.** A failed Claude/Codex worker no longer silently spends a second full model call before falling back. This keeps bad auth, quota, unsupported-model, and timeout cases from doubling user wait time.
- **Bounded agent waits.** Claude worker calls cap at 90s, Codex worker calls cap at 90s, and synthesis calls cap at 60s. The turn falls back to whatever useful output arrived instead of hanging for minutes.
- **Compact project context.** Worker prompts now include a small, locally-built context pack: active editor snippet, package/scripts/dependency summary, README headings, and a capped file map. This restores repo grounding without re-enabling slow tool/plugin loading.

### Fixed
- **Clear Conversation persistence.** Clearing a session now clears the saved transcript too, so old bubbles do not reappear after reload.
- **Stop and queue UX.** The panel now has a Stop button for running agents, and prompts submitted during an active turn are queued instead of rejected.

All notable changes to claudex-council are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.5.9] — 2026-05-01

### Added
- **Per-agent token telemetry.** Claude stream-json usage and Codex `exec --json` usage are now parsed into the bubble timing line: input/output/cache tokens, reasoning tokens where available, and Claude cost when exposed by the CLI.
- **Real Caveman integration.** `claudexCouncil.cavemanMode` defaults to `auto`, detects common installed Caveman skill layouts, and compresses Claude worker output only. The final synthesis remains normal prose.

### Fixed
- **No chat error role leaks.** The webview/orchestrator event contract no longer allows `role: "error"` messages; busy turns use a VS Code notification instead of rendering an error-like bubble.
- **Turn cleanup is finally-guarded.** Unexpected spawn/parser failures can no longer leave a session permanently busy.
- **Buffered process hardening.** Codex/synthesis helper calls now use UTF-8 `StringDecoder`, a double-resolve guard, bounded stdout/stderr buffers, and safer stdin writes.
- **Faster, safer model probing.** Probes now use the same stripped-down Claude/Codex flags as real council calls, binary fallback lookup, and process-tree cleanup on timeout.

## [0.3.2] — 2026-04-30

### Added
- **Per-agent model selection.** Three new settings — `claudexCouncil.claudeWorkerModel`, `claudexCouncil.codexWorkerModel`, `claudexCouncil.deciderModel` — let you choose which model powers each of the three calls a council turn makes. Empty = whatever the CLI picks; otherwise pass any model name your CLI supports (e.g. `claude-haiku-4-5` for cheap synthesis, `gpt-5.4-mini` for faster Codex reasoning, `claude-opus-4-6` for the heaviest worker). Translates directly to the `--model` flag on `claude -p` and `-m` on `codex exec`.
- Cross-platform smoke test at [test/smoke.mjs](test/smoke.mjs) — 10 checks covering basic call, Unicode round-trip, multi-line, special chars, and Claude streaming. Runs identically on macOS, Linux, Windows.
- GitHub Actions workflow at [.github/workflows/cross-platform.yml](.github/workflows/cross-platform.yml) — every push runs build + structural smoke on `macos-latest`, `windows-latest`, `ubuntu-latest`. Tripwire for any future PR that introduces a Windows-only assumption.
- [CROSS_PLATFORM.md](CROSS_PLATFORM.md) — written accounting of what's verified live, what's verified structurally, and what still requires Mac runtime.

## [0.3.1] — 2026-04-30

### Fixed (Codex audit caught these)
- **Unicode mojibake** when prompts contained em-dashes / arrows / smart quotes / any non-ASCII. Root cause: `ask_codex.py` was passing prompts to `codex` as positional argv. On Windows `codex` resolves to `codex.cmd`, and `cmd.exe` decodes argv through the OEM codepage (cp1252-ish), producing double-encoded mojibake before Codex ever saw the prompt. **Fix**: prompts now pipe via stdin to `codex` (mirroring what we did for `claude`). Also reconfigure stdin/stdout/stderr to UTF-8 at the top of `ask_codex.py`.
- **Process-tree leaks on cancel.** Clicking "Clear Conversation" called `proc.kill()`, which on Windows with `shell: true` only killed the `cmd.exe` shim — the actual Codex/Claude/Node grandchildren ran on. Fix: `killProcessTree()` uses `taskkill /T /F /PID` on Windows and process-group SIGKILL via `detached: true` on Unix. `_kill_tree()` in `ask_codex.py` mirrors this for the Python helper's own timeout path.
- **Binary discovery on macOS Dock-launched VS Code.** When VS Code is launched from the Dock instead of a terminal, it inherits a stripped PATH (essentially `/usr/bin:/bin`), so installs in `/opt/homebrew/bin` / `~/.npm-global/bin` / `~/.local/bin` were invisible. Added a `resolveBinary()` helper that searches PATH first, then falls back to a per-OS list of well-known dirs. Mirrored in `_resolve_codex_binary()` in the Python helper.

## [0.3.0] — 2026-04-30

### Added
- **Per-agent timing**: every bubble header now shows a live elapsed counter while the agent is working (`Adjudicating… · 4s`) and settles to the final time when done (`12.3s`).
- **Turn footer**: a `Turn complete · 24.7s · 3 agents` line below every completed turn so you can see the whole-turn cost at a glance.
- **Three creative verb sets** that rotate while each agent works, distinct per role and intentionally different from Claude Code's own whimsical set:
  - Decider: *Adjudicating · Triangulating · Reconciling · Weighing · Arbitrating · Cross-referencing · Diffing · Mediating · Harmonizing · Tallying · Quorum-checking · Vote-counting · Consensus-forming*
  - Claude worker: *Steeping · Brewing · Conjuring · Wrangling · Untangling · Threading · Knitting · Distilling · Whittling · Crafting · Sculpting · Weaving · Smelting*
  - Codex worker: *Iterating · Annealing · Backtracking · Beam-searching · Vectorizing · Permuting · Lattice-walking · Decoding · Formalizing · Optimizing · Stochastic-stepping · Token-grinding · Embedding · Backpropagating · Compiling*
- **Economy mode** (`claudexCouncil.economyMode` setting). When on, runs Claude only and skips both Codex and the synthesis call. Reduces cost to ~30% of normal — recommended for users on free-tier accounts who hit quota limits.
- **`claudexCouncil.pythonBinary` setting** for explicitly choosing the Python interpreter used to invoke `ask_codex.py`. Defaults to `python3` on macOS/Linux and `python` on Windows.
- **Friendly quota / auth error messages** instead of raw CLI exit-code dumps. The extension now detects rate-limit / 429 / quota-exceeded / not-authenticated patterns from both `claude` and `codex` and tells the user what to do (wait, switch to Economy mode, log in).

### Changed
- Default Python binary on macOS/Linux is now `python3` (was always `python`, which is missing on most modern macOS installs).

### Distribution
- Added `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, this `CHANGELOG.md`, and a rewritten public `README.md` covering install on macOS and Windows.

## [0.2.3] — 2026-04-30

### Fixed
- **Webview spinner state hardening**: per-bubble status targeting via `dataset.turnId/agent/role`. Status events now affect only the intended bubble even when an agent has multiple bubbles in the same turn.
- **TurnId collision**: turn IDs now include a random suffix in addition to the timestamp, preventing same-millisecond collisions when sessions fire prompts simultaneously.
- **Synthesis failure path**: if synthesis errors, the bubble role is set to `error` (not `synthesis`) and `agent-status: failed` is emitted explicitly.

## [0.2.2] — 2026-04-30

### Fixed
- **Multi-word prompt mangling**. On Windows, `shell: true` + multi-word prompt-as-positional-argv caused `cmd.exe` to word-split, so `ask_codex.py` saw `"Hey", "buddy,", ...` and Claude's synthesizer saw only `"You"`. Fix: every prompt is now piped via **stdin** to both `claude -p` and `python ask_codex.py`. No prompt is ever passed as a positional argv anymore.
- **Unicode crash in `ask_codex.py`** on Windows: the helper now reconfigures stdout/stderr to UTF-8 before printing, fixing the `'charmap' codec can't encode character '→'` crash that happened whenever Codex's reply contained an em-dash, arrow, or smart quote.

## [0.2.1] — 2026-04-30

### Fixed
- `ask_codex.py` is now bundled inside the VSIX at `<extension>/scripts/ask_codex.py` and resolved from `extensionPath` first.
- Stream parser ignores the duplicate `assistant` envelope at the end of `claude -p --output-format stream-json --include-partial-messages` output, so Claude's reply no longer renders twice.
- Decider plan bubble's spinner now stops immediately after the plan message instead of spinning forever.
- Synthesis prompt wraps inputs in `<USER_QUESTION>`/`<CLAUDE_RESPONSE>`/`<CODEX_RESPONSE>` tags so the synthesizer doesn't misread the prompt structure as the user's question.

## [0.2.0] — 2026-04-30

### Added
- **Multi-session support**. Each click of the `+` in the Sessions sidebar opens a new editor-tab webview with its own independent orchestrator and conversation. Run as many parallel councils as you want.
- **Real orchestration** (replaced placeholder bubbles): `claude -p --output-format stream-json --include-partial-messages` for the Claude worker (live token streaming), `python ask_codex.py` for the Codex worker, and a final `claude -p` synthesis call merging both into a unified answer.

## [0.1.0] — 2026-04-30

Initial release. Activity-bar icon, single sidebar webview, placeholder agent bubbles for UI preview.
