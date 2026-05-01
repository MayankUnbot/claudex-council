# claudex-council

> Two coding agents, one verdict. Inside VS Code.

A VS Code extension that puts **Claude** and **Codex** on a council. You ask one question; both agents share the same session context, coordinate through a task ledger, and return one merged Council answer by default. If you want the machinery, you can still expand the internal routing and worker views.

---

> **Unofficial.** Not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, GitHub, or Microsoft. Claude, Codex, and Visual Studio Code are trademarks of their respective owners. This project simply orchestrates their publicly-documented CLIs.

---

## Why this exists

Claude and Codex are good at different things and disagree in useful ways. When the answer matters more than the bill — architecture decisions, deep code reviews, ambiguous design calls — having both weigh in catches what either misses alone. This extension turns that into a one-line operation instead of a tab-switching ritual.

## Where the Council shines

Claudex Council is for prompts where a second independent model can change the outcome, not just repeat the answer. It is most valuable when you are about to choose a direction, ship risky code, or commit to a plan that would be expensive to unwind later.

| Use case | Why the Council helps | Example prompt |
|---|---|---|
| **Architecture planning** | Claude can build the repo-aware plan while Codex challenges assumptions, edge cases, and implementation risk. | "Plan a migration from a monolith to services without breaking our current PostgreSQL workflows." |
| **Plan mode / technical strategy** | You get one decision memo instead of two disconnected opinions. | "Create an implementation plan for realtime collaboration. Compare WebSockets, SSE, and polling, then choose." |
| **Code review** | Independent review catches subtle bugs, missing cleanup, race conditions, and test gaps. | "Review this async request bridge for production risks and propose safer code." |
| **Security and reliability review** | The second lane acts like a skeptical reviewer before the final answer is written. | "Audit this auth middleware for bypasses, session risks, and operational failure modes." |
| **Debugging hard failures** | Two models can form different hypotheses before the Decider merges the strongest evidence. | "This worker hangs under load but passes local tests. Find likely root causes and a debug plan." |
| **Large refactors** | One lane proposes the path; the other looks for API breakage, migration traps, and rollout risk. | "Refactor this 1,400-line module while preserving public behavior and tests." |
| **Product + engineering tradeoffs** | The Council can weigh user value, implementation cost, maintenance burden, and launch risk together. | "Should this feature be a VS Code extension, CLI, or hosted app? Give a launch recommendation." |

## What you gain

- **Independent second opinion without tab-switching.** Ask once; Claude and Codex both weigh in from the same session.
- **One synthesized answer.** The Council answer resolves overlap and contradictions so you can act on one recommendation.
- **Better planning discipline.** Full council turns create explicit lanes, task ownership, blockers, and a final decision path.
- **Stronger review coverage.** Useful disagreement is preserved instead of hidden; the final answer can include what one model caught that the other missed.
- **Local orchestration.** The extension talks to the `claude` and `codex` CLIs already installed on your machine. There is no third-party relay service.
- **Cost visibility.** Per-agent timing, token usage, model badges, and Economy mode make the tradeoff visible instead of mysterious.
- **Graceful failure behavior.** Quota, auth, timeout, and unsupported-model failures are surfaced as friendly guidance rather than raw crashes.

For a deeper positioning guide, see [VALUE_PROPOSITION.md](VALUE_PROPOSITION.md).

## When not to use it

The Council is intentionally overpowered for low-stakes work. For quick explanations, tiny regexes, boilerplate, copy tweaks, or one-line code snippets, use Claude or Codex directly. A full council turn spends extra time and tokens; save it for work where the extra perspective can prevent rework, bugs, or a bad technical bet.

## Cost is engineered in, not retrofitted

A naive multi-agent setup is expensive. A naïve "spawn Claude + Codex + synthesizer per turn" extension burns ~30K tokens for a 100-token user prompt. We took the cost shape seriously and built the following in:

| Optimization | What it does | Cost reduction |
|---|---|---|
| **stdin prompt piping** | Prompts go via stdin instead of argv. No shell-quoting overhead, no malformed prompts that re-cost a turn. | Eliminates a full failure-mode class. |
| **Economy mode** (toggleable) | Runs Claude only — skips Codex and the synthesis call entirely. Single-agent path for free-tier users or simple turns. | Down to **~30%** of full-council cost per turn. |
| **Friendly quota errors** | Detects rate-limit / 429 / quota-exhausted patterns from upstream CLIs and tells the user what to do, instead of crashing the turn. | Prevents wasted retries on already-exhausted quotas. |
| **Per-agent timing + token telemetry** | Live elapsed counter, final time, input/output/cache tokens, and cost where the CLI exposes it. | Visibility — you can tell when an agent is hot, cold, token-heavy, or hung. |
| **Compatible with [Caveman](https://github.com/JuliusBrussee/caveman)** | Drop the `caveman` skill into `~/.claude/skills/caveman/` and `claudexCouncil.cavemanMode: auto` compresses Claude worker output. Synthesis stays normal English. | Stacks on top of Economy mode for further savings. |

We're working on more (structured worker briefs, conditional synthesis, Haiku for synthesis, smarter prompt-routing — see [CHANGELOG.md](CHANGELOG.md) for ship cadence).

## What you'll see

Each turn looks like a normal chat by default: your prompt, one live Council response, and one final answer. The coordinator, Claude lane, Codex lane, and synthesis model controls live behind a collapsed **Model routing** drawer so the UI does not make you babysit the internals.

```
You              "Should I switch our auth from session cookies to JWT?"

Council · answer <Coordinating...> <Comparing answers...> 14.2s
                Stay with session cookies. Codex's JWT case is generic and
                assumes a problem you don't have. Revisit if you move to
                multi-region.

------ Turn complete · 24.0s · 4 agents ------
```

Verbs rotate every ~1.6 seconds while the Council is working. In expanded visibility modes, the internal lanes still get distinct labels and timings for debugging or tuning.

## Requirements

| Tool | Why | How to get it |
|------|-----|--------------|
| [VS Code](https://code.visualstudio.com/) 1.85+ | Hosts the extension | install per OS instructions |
| [Claude CLI](https://code.claude.com) (`claude`) | Claude worker, coordinator, and Council answer | install per Anthropic docs; run `claude` once to authenticate |
| [Codex CLI](https://github.com/openai/codex) (`codex`) | Codex worker | `npm i -g @openai/codex`; run `codex` once to authenticate |
| Python 3.8+ | Runs the small `ask_codex.py` wrapper that captures Codex's final reply cleanly | preinstalled on macOS; [python.org](https://python.org) or Microsoft Store on Windows |

Works on **macOS**, **Linux**, and **Windows**. The helper script and orchestration are platform-aware (e.g. `python3` is auto-selected on macOS/Linux, `python` on Windows; `code.cmd` is used on Windows where `code` doesn't accept CLI flags).

## Cross-platform confidence

The extension is built to behave the same on Windows and macOS:

- prompts are piped through stdin instead of shell argv, avoiding quoting and Unicode bugs on every shell
- Python defaults to `python3` on macOS/Linux and `python` on Windows
- Claude/Codex binaries are resolved from PATH plus common Homebrew, npm-global, and local-bin locations
- process cancellation kills the full child process tree (`taskkill` on Windows, process groups on Unix)
- CI builds, packages, and runs fake Claude/Codex smoke tests on `macos-latest`, `windows-latest`, and `ubuntu-latest`

What has actually been verified:

| Platform | What is verified today | What still needs a real machine |
|---|---|---|
| **Windows** | Live authenticated Claude + Codex smoke test passed locally, plus fake CI-style tests. | More user hardware is always welcome, but the main runtime path has been exercised. |
| **macOS** | Build/package assumptions, helper inclusion, stdin, Unicode, fake Claude/Codex streaming, and auth-state simulation are covered by CI-style tests. | Real Claude/Codex OAuth, macOS Keychain behavior, Dock-launched VS Code PATH behavior, and live account quotas require a signed-in Mac. |
| **Linux** | Build/package assumptions, helper inclusion, stdin, Unicode, fake Claude/Codex streaming, and auth-state simulation are covered by CI-style tests. | Real authenticated CLI calls require a signed-in Linux machine. |

Authenticated live Claude/Codex calls still require a real logged-in machine. We do **not** put user credentials into public/temporary online Macs. For the exact verification matrix and the Mac smoke command, see [CROSS_PLATFORM.md](CROSS_PLATFORM.md).

## Account limits and budget users

Claudex Council does not bypass Claude or Codex limits. It uses the local `claude` and `codex` CLIs you are already logged into, so a full Council turn can spend from **both** upstream allowances: Claude worker/synthesis on the Claude side, Codex worker on the OpenAI side.

Important: **Claude Max, ChatGPT Pro, or "max quota" is not required for Claudex Council to work.** Higher limits only make the Council more practical for frequent or large tasks. The real requirement for a **full Council** turn is simpler:

> Full Council = Claude CLI is installed, signed in, and has quota **and** Codex CLI is installed, signed in, and has quota.

If only one side is usable, Claudex Council should still answer through the available lane, but that is a **single-lane fallback**, not the full two-agent Council experience.

Current official guidance says:

- Claude Code access is available through Claude Pro/Max subscriptions or Claude Console/API billing, and Claude usage is shared across Claude surfaces. See Anthropic's [Claude Code with Pro or Max](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan) and [usage limits](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work) docs.
- Codex is included with ChatGPT Plus, Pro, Business, Edu, and Enterprise plans. OpenAI may also include Codex on Free/Go for limited periods, but that should be treated as availability that can change. See OpenAI's [Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) and [Codex CLI](https://developers.openai.com/codex/cli) docs.

### Practical plan fit

| User account situation | What to expect | Recommended settings |
|---|---|---|
| **Free-only accounts** | Not a reliable full-Council target. If either CLI cannot authenticate or has no included coding-agent access, that lane will be unavailable. | Use single-agent tools directly, or enable Economy mode if Claude Code works for you. |
| **Only one paid account** | The paid side may work, but full Council will not be reliable unless the other CLI is also authenticated and entitled. | Use the available lane; add the second provider when you want full Council value. |
| **Claude Pro + ChatGPT Plus** | Good for occasional architecture planning, review, and hard debugging. Not ideal for running the Council on every small prompt. | Keep `councilFidelity: fast`, `coordinatorMode: local`, `deliberationMode: off`; use Economy mode for simple work. |
| **Claude Max / ChatGPT Pro or API-backed usage** | Better fit for daily Council use, large repos, long planning sessions, and repeated review loops. | Full Council is reasonable for high-value work; still keep deliberation off unless needed. |
| **Team / Business / Enterprise** | Best fit when the organization wants reviewability, model diversity, and predictable admin controls. | Pair Council usage with team policy on model choice, quota, and data controls. |

### Budget-safe defaults

For $20-plan users or anyone who wants to avoid surprise quota burn:

1. Keep **Council Fidelity** on `fast`.
2. Keep **Coordinator Mode** on `local`.
3. Keep **Deliberation Mode** on `off`.
4. Use **Economy Mode** for small prompts.
5. Save full Council turns for architecture, refactors, security review, hard debugging, and launch decisions.
6. Avoid refreshing the full model catalog repeatedly; model probing makes small test calls to both CLIs.

When a provider hits quota or auth limits, the extension shows a friendly inline message and can continue with the available lane where possible. The right user experience is graceful degradation, not a crash.

### Login-state behavior

| Claude CLI | Codex CLI | Council behavior |
|---|---|---|
| signed in with quota | signed in with quota | Full Council can run. |
| signed in with quota | missing, signed out, quota-limited, or timed out | Continues with Claude and shows Codex recovery guidance. |
| missing, signed out, quota-limited, or timed out | signed in with quota | Continues with Codex and shows Claude recovery guidance. |
| both missing, signed out, quota-limited, or timed out | both unavailable | Stops the turn and shows both recovery actions. |

The fake auth matrix is covered by `node skills/claudex-council/test/auth-matrix.mjs`; real OAuth and quota behavior still depends on the user's upstream accounts.

## Install

### Option 1 — Install from VSIX (recommended for now)

Download the latest `claudex-council.vsix` from the [Releases](../../releases) page, then:

**macOS / Linux**
```bash
code --install-extension ~/Downloads/claudex-council.vsix --force
```

**Windows (PowerShell or Git Bash)**
```bash
code.cmd --install-extension claudex-council.vsix --force
```

Reload VS Code (`Ctrl+Shift+P` → "Reload Window"). The council icon appears in the left activity bar.

### Option 2 — Build from source

```bash
git clone <this-repo>
cd <repo>/skills/claudex-council/extension
npm install
npx tsc -p ./
npx --yes @vscode/vsce package --out claudex-council.vsix --allow-missing-repository --skip-license

# Install the .vsix you just built (use code.cmd on Windows)
code --install-extension claudex-council.vsix --force
```

### macOS-specific notes

- If macOS Gatekeeper warns the `.vsix` is "damaged" because it was downloaded from the internet, clear the quarantine attribute:
  ```bash
  xattr -d com.apple.quarantine ~/Downloads/claudex-council.vsix
  ```
- Default Python on macOS is `python3`, not `python`. The extension auto-detects this.

### Windows-specific notes

- Use `code.cmd`, not `code`, when passing CLI flags from any shell. Bare `code` on Windows opens VS Code and ignores `--install-extension`.
- The `codex` CLI on Windows is installed as `codex.cmd` (npm global). The extension resolves this via `shutil.which()` so no manual path config is needed.

## Use

1. Click the **two-overlapping-circles** icon in the left activity bar.
2. The **Sessions** sidebar opens. Click `+ New Council Session` (or the `+` in the sidebar header).
3. A new editor tab opens with the chat UI. Type any prompt and hit Enter.
4. Watch verbs rotate as Claude and Codex work in parallel; final synthesis arrives last.
5. Click `+` again to start a second, independent session in another tab. Each session carries its own prior context, but sessions don't share state.

## Settings

`Settings → Extensions → Claudex Council`:

| Setting | Default | Effect |
|---|---|---|
| `claudexCouncil.economyMode` | `false` | Run Claude only per turn (skip Codex + synthesis). ~30% of normal cost. |
| `claudexCouncil.councilFidelity` | `fast` | `fast` keeps the current low-latency stripped worker calls. `full-fidelity` lets Claude keep normal Claude Code tools/MCP/skills/memory context and lets Codex load the user's normal config, web, MCP, and tools. |
| `claudexCouncil.coordinatorMode` | `model` | Full-council turns use a real coordinator model to assign separate Claude/Codex lanes. Set `local` for the old cheap deterministic route. |
| `claudexCouncil.coordinatorModel` | *empty* | Claude model for the coordinator call. Empty uses the session dropdown default (`claude-sonnet-4-6`). |
| `claudexCouncil.deliberationMode` | `auto` | Runs a bounded Claude<->Codex peer-review round before final synthesis. Use `off` for speed or `always` when you want the two agents to talk on every dual-worker turn. |
| `claudexCouncil.smartModelRouting` | `true` | Lets the Council choose faster or stronger models per lane when the session is still using default model selections. Explicit dropdown choices are respected. |
| `claudexCouncil.orchestrationVisibility` | `final-only` | Shows one unified Council answer while keeping coordinator, worker drafts, and deliberation in the backend. Use `answers` to show worker drafts, or `detailed` to show every internal bubble. |
| `claudexCouncil.sessionContextMaxChars` | `48000` | Maximum characters of prior per-session context injected into coordinator, worker, review, and Council-answer prompts. Includes session metadata, model selections, and recent turn-grouped transcript. The full transcript remains persisted for restore; set `0` to disable prompt context. |
| `claudexCouncil.claudeFullFidelityPermissionMode` | `auto` | Claude Code permission mode used in `full-fidelity`. Use `plan` for Claude Plan Mode behavior, or `bypassPermissions` only in trusted sandboxes. |
| `claudexCouncil.codexFullFidelitySandbox` | `workspace-write` | Codex sandbox used in `full-fidelity`: `inherit`, `read-only`, `workspace-write`, or `danger-full-access`. |
| `claudexCouncil.codexFullFidelityBypassApprovalsAndSandbox` | `false` | Passes Codex's dangerous bypass flag in `full-fidelity`; only use when the surrounding environment is trusted. |
| `claudexCouncil.cavemanMode` | `auto` | Compress Claude worker output when Caveman is installed. Use `off`, `lite`, `full`, or `ultra` to override. |
| `claudexCouncil.claudeBinary` | `claude` | Path to Claude CLI binary (override if not on PATH). |
| `claudexCouncil.codexBinary` | *empty* | Optional path or command name for the Codex CLI (override if installed somewhere unusual). |
| `claudexCouncil.codexHelperPath` | *empty* | Override path to `ask_codex.py` (defaults to bundled). |
| `claudexCouncil.pythonBinary` | *empty* | Override Python interpreter (defaults to `python3` on macOS/Linux, `python` on Windows). |
| `claudexCouncil.workingDirectory` | *empty* | Working directory passed to agents (defaults to first workspace folder). |

## How it actually works

```
┌──────────┐
│  user    │
│  prompt  │
└────┬─────┘
     │
┌────▼──────────────────────────────────────┐
│  Orchestrator (extension host, Node.js)   │
│  ├─ stdin → claude -p (worker)  ─────┐    │
│  ├─ stdin → python ask_codex.py ─────┤    │
│  │       (Codex worker)              │    │
│  │                                   │    │
│  │  parallel; both emit chunks       │    │
│  │  ──→ webview via postMessage      │    │
│  │                                   │    │
│  └─ stdin → claude -p (synthesis) ───┘    │
│         on both worker outputs            │
└────────────────┬──────────────────────────┘
                 │  (events)
                 ▼
         ┌──────────────┐
         │  webview     │
         │  chat panel  │
         │  + bubbles   │
         │  + verbs     │
         │  + timings   │
         └──────────────┘
```

- **No localhost server, no MCP layer, no extra processes** — the extension orchestrates `claude` and `codex` CLIs directly via `child_process.spawn` and pipes prompts via stdin.
- **Each session is its own webview panel** with its own orchestrator instance. A compact session context pack is injected into later turns, including session metadata, model selections, prior turns, roles, attachments, and final answers. No shared state means parallel sessions can't interfere.
- **Each full council turn now carries a shared task ledger** so Claude, Codex, and the Council answer pass see task ownership, peer status, blockers, and decisions in the same prompt context.
- **Council activity cards** show Claude/Codex lane plans, live progress, selected model, quota/auth status, and context usage without exposing raw internal drafts in the default UI.
- **Merged clarifications**: when Claude/Codex surface blocking questions, a clarification coordinator deduplicates them and asks the user once, in one Council response, instead of showing competing agent questions.
- **All events flow one-way** to the webview (`agent-message`, `agent-chunk`, `agent-status`, `agent-timing`, `turn-finished`). The webview only sends `submit-prompt` and `cancel` back.

## Roadmap

Already built and shipping in 0.3.0 above. Next:

- [ ] Structured worker briefs (`{answer, reasoning, risks, confidence}`) — replaces free-form prose with a JSON schema, makes synthesis cheaper *and* better-quality
- [ ] Conditional synthesis — skip the third call when both worker briefs agree on the `answer` field
- [ ] Haiku for synthesis when it does run (~5× cheaper)
- [ ] `--bare` flag for `claude -p` workers — drops the bulky default Claude Code system prompt
- [ ] Smart routing — classify the prompt up front and pick economy / single-agent / full-council based on task type
- [x] Per-phase token telemetry for Claude + Codex CLI usage events
- [ ] Native multimodal image input (currently images go via temp file path reference)

See [CHANGELOG.md](CHANGELOG.md) for what's already shipped.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Especially:
- More verbs (in `extension/webview/app.js` → `VERBS`)
- Cross-platform fixes
- Better free-tier resilience patterns
- Cost telemetry

## Security

See [SECURITY.md](SECURITY.md). TL;DR: prompts go to Anthropic and OpenAI via your already-installed CLIs; nothing routes through any third party. Don't paste secrets into prompts.

## License

[MIT](LICENSE).

## Trademark notice

"Claude" and the Claude name/logo are trademarks of Anthropic, PBC. "Codex" and "OpenAI" are trademarks of OpenAI, Inc. "Visual Studio Code" is a trademark of Microsoft Corporation. This project is an independent open-source integration that calls those products' publicly-documented CLIs. It is not affiliated with, endorsed by, or sponsored by any of them.
