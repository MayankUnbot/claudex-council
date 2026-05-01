# claudex-council

> Two coding agents, one verdict — inside VS Code.

A VS Code extension that orchestrates **Claude** and **Codex** as a council per prompt. Both agents answer the same question in parallel; a synthesizer pass merges their outputs into one final answer. You see one chat bubble; the deliberation happens behind it.

> **Unofficial.** Not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, GitHub, or Microsoft. Claude, Codex, and Visual Studio Code are trademarks of their respective owners. This project orchestrates their publicly-documented CLIs.

---

## What it is

When you ask one question, claudex-council:

1. Classifies the prompt locally (greeting, factual, code, architecture, review, debugging, refactor)
2. Routes it: trivial prompts go to a single agent fast-path; substantive prompts go to the full council
3. Runs **Claude** and **Codex** in parallel as workers
4. Merges their answers via a synthesizer (Claude Haiku by default, configurable)
5. Returns one final Council answer

You can switch visibility modes if you want to see the worker drafts and routing decisions, or keep the default `final-only` mode where the chat looks like a normal one-bubble conversation.

## When the council is worth it

| Use case | Why two agents help |
|---|---|
| **Architecture decisions** | Claude proposes; Codex challenges. Synthesis lands a *decisive* recommendation with the deciding factor. |
| **Code review before merge** | Two independent reads catch what one misses; the synthesizer rejects weak suggestions. |
| **Debugging hard failures** | Two different root-cause hypotheses surface; the synthesizer picks the most probable. |
| **Large refactors** | One lane proposes the path; the other looks for breakage and migration traps. |
| **Plan mode / technical strategy** | One decision memo instead of two disconnected opinions. |
| **Security / threat modeling** | Independent second pass catches missed attack surface. |

## When NOT to use it

For greetings, single-fact lookups, formatting, or boilerplate, use Claude or Codex directly. A full council turn costs ~2.5–3× the wall time of a solo agent and adds no quality lift on trivial work. The extension's local router fast-paths these to a single agent automatically, but you can also just use the CLIs directly.

## How it actually works

```
┌──────────┐
│  user    │
│  prompt  │
└────┬─────┘
     │
┌────▼──────────────────────────────────────┐
│  Orchestrator (VS Code extension host)    │
│                                           │
│   1. decideRoute()  — local classifier    │
│      ├─ trivial      → Claude only        │
│      ├─ code/review  → full council       │
│      └─ architecture → full council       │
│                                           │
│   2. spawn workers in parallel:           │
│      ├─ stdin → claude -p (Claude worker) │
│      └─ stdin → python ask_codex.py       │
│                  (Codex worker)           │
│                                           │
│      both emit stream-json chunks         │
│      ──→ webview via postMessage          │
│                                           │
│   3. synthesizer pass:                    │
│      stdin → claude -p --model haiku      │
│      with both worker outputs as context  │
└────────────────┬──────────────────────────┘
                 │  events
                 ▼
        ┌─────────────────┐
        │  webview panel  │
        │  ├─ bubbles     │
        │  ├─ live verbs  │
        │  ├─ timings     │
        │  └─ model badges│
        └─────────────────┘
```

**No localhost server, no MCP layer, no extra processes.** The extension orchestrates `claude` and `codex` CLIs directly via `child_process.spawn` and pipes prompts through stdin (avoids shell-quoting bugs and Unicode mojibake).

**Each session is an independent webview panel** with its own orchestrator instance. Sessions persist across VS Code reloads via `globalState`. You can run multiple sessions in parallel — they don't share state.

**Worker authentication is handled by the underlying CLIs** — `claude login` and `codex login` once in a terminal, and the extension uses your existing auth.

## Requirements

| Tool | Why | Install |
|------|-----|---------|
| [VS Code](https://code.visualstudio.com/) 1.85+ | Hosts the extension | Per-OS download |
| [Claude CLI](https://code.claude.com) (`claude`) | Claude worker + synthesizer | Per [Anthropic docs](https://code.claude.com); `claude login` to authenticate |
| [Codex CLI](https://github.com/openai/codex) (`codex`) | Codex worker | `npm i -g @openai/codex`; run `codex` once to authenticate |
| Python 3.8+ | Runs the `ask_codex.py` wrapper that captures Codex's reply cleanly | Preinstalled on macOS/Linux; [python.org](https://python.org) on Windows |

Works on **macOS**, **Linux**, and **Windows**. Process spawning, binary resolution, encoding, and tree-kill are all platform-aware. CI runs on `macos-latest`, `windows-latest`, `ubuntu-latest`.

## Install

### From source (current path)

```bash
git clone https://github.com/MayankUnbot/claudex-council.git
cd claudex-council/skills/claudex-council/extension
npm install
npx tsc -p ./
npx --yes @vscode/vsce package --out claudex-council.vsix --allow-missing-repository --skip-license

# Install the .vsix you just built
code --install-extension claudex-council.vsix --force          # macOS / Linux
code.cmd --install-extension claudex-council.vsix --force      # Windows
```

Reload VS Code (`Ctrl+Shift+P` → "Reload Window"). A council icon appears in the left activity bar.

### Use

1. Click the **two-overlapping-circles** icon in the left activity bar.
2. The **Sessions** sidebar opens. Click `+ New Council Session`.
3. A new editor tab opens with the chat UI. Type a prompt and hit Enter.
4. Watch verbs rotate as Claude and Codex work in parallel; final synthesis arrives last.
5. Click `+` again to start a second independent session in another tab.

## Settings (essentials)

Open `Settings → Extensions → Claudex Council`. Most users never need to touch these — the defaults are tuned for low cost and good quality.

| Setting | Default | What it does |
|---|---|---|
| `claudexCouncil.economyMode` | `false` | Run Claude only per turn (skip Codex + synthesis). ~30% of normal cost. |
| `claudexCouncil.councilFidelity` | `fast` | `fast` strips workers to bare prompt for speed. `full-fidelity` keeps Claude tools/MCP/skills and Codex's normal config. |
| `claudexCouncil.coordinatorMode` | `local` | `local` uses the deterministic prompt classifier (instant, free). `model` runs a real coordinator model — slower, more expensive, only switch if `local` disappoints you. |
| `claudexCouncil.orchestrationVisibility` | `final-only` | `final-only` shows one merged Council answer. `answers` shows worker drafts. `detailed` shows every internal bubble. |
| `claudexCouncil.deliberationMode` | `off` | `auto` or `always` add a Claude↔Codex peer-review round before final synthesis. Off by default for speed. |
| `claudexCouncil.smartModelRouting` | `true` | Council picks faster/stronger models per lane when the session is on defaults. Explicit dropdown picks are respected. |
| `claudexCouncil.claudeWorkerModel` | *empty* | Override Claude worker model (e.g. `claude-sonnet-4-6`, `claude-opus-4-7`). Empty = session dropdown default. |
| `claudexCouncil.codexWorkerModel` | *empty* | Override Codex worker model (e.g. `gpt-5-codex`, `o3`). |
| `claudexCouncil.deciderModel` | *empty* | Override synthesizer model. Default is `claude-haiku-4-5` for low latency. |

Full settings reference: [skills/claudex-council/README.md](skills/claudex-council/README.md#settings).

## Account and budget

claudex-council does not bypass quotas. It uses the local `claude` and `codex` CLIs you're already signed into, so a full council turn can spend from **both** Claude and Codex allowances per turn.

Claude Max, ChatGPT Pro, or "max quota" is **not** required for claudex-council to work. Higher limits only make full-council usage more practical for frequent or large tasks. A full council turn requires both CLIs to be installed, signed in, and currently within quota; if only one side is usable, the extension falls back to that available lane.

| Account situation | What works | Recommended |
|---|---|---|
| Both CLIs signed in with quota | Full council | Defaults are fine |
| Only one CLI signed in | Single-lane fallback (extension continues with the available agent) | Keep using; add the second provider when you want full council |
| Neither signed in | Won't work — the extension can't run without at least one authenticated CLI | Run `claude login` and `codex login` |
| Free-tier accounts | Either CLI may not have agent access | Use Economy mode if Claude works for you |

Auth, quota, missing-binary, timeout, and unsupported-model failures are surfaced as lane availability notices with recovery guidance. The fake auth matrix covers signed-in, missing CLI, signed-out, quota-limited, and timeout states for both Claude and Codex.

## Repository layout

```
.
├── README.md                          ← this file
├── architecture.svg                   ← legacy bridge diagram (see "Note on bridge code" below)
├── skills/
│   └── claudex-council/               ← THE PRODUCT
│       ├── README.md                  ← in-depth product documentation
│       ├── extension/                 ← VS Code extension source
│       │   ├── src/
│       │   │   ├── orchestrator.ts    ← brain: routing, spawn, synthesis
│       │   │   ├── sessionPanel.ts    ← per-session webview + state
│       │   │   ├── modelCatalog.ts    ← model registry
│       │   │   ├── modelProber.ts     ← subscription-aware availability probe
│       │   │   ├── extension.ts       ← activation, commands
│       │   │   └── council/ledger.ts  ← shared task ledger for full-council turns
│       │   ├── webview/               ← chat UI (HTML/CSS/JS)
│       │   ├── scripts/ask_codex.py   ← Codex CLI wrapper (UTF-8, tree-kill)
│       │   └── package.json           ← extension manifest + settings schema
│       ├── scripts/                   ← benchmark + eval utilities
│       ├── test/                      ← smoke + auth-matrix tests
│       ├── CHANGELOG.md
│       ├── CONTRIBUTING.md
│       ├── CROSS_PLATFORM.md
│       ├── SECURITY.md
│       ├── SKILL.md
│       └── VALUE_PROPOSITION.md
│
├── codex-mcp.ts                       ← legacy: codex-side MCP server (see below)
├── server.ts                          ← legacy: Claude-side channel plugin (see below)
├── .mcp.json                          ← legacy: MCP plugin config
└── .claude-plugin/plugin.json         ← legacy: Claude Code plugin metadata
```

### Note on the legacy bridge code

The root files (`codex-mcp.ts`, `server.ts`, `.mcp.json`, `.claude-plugin/`, `architecture.svg`) are an earlier experiment that piped conversations between Claude Code and Codex over an MCP-based bridge protocol. **claudex-council does not use any of this** — the extension spawns the CLIs directly with `child_process.spawn`, no MCP layer involved. The bridge code is preserved in this repo as a separate exploration but is not part of the council product.

## Documentation

- **Full product README** with extended features, value proposition, and use-case guidance: [skills/claudex-council/README.md](skills/claudex-council/README.md)
- **Cross-platform notes** (verified Windows; macOS/Linux structural with CI): [skills/claudex-council/CROSS_PLATFORM.md](skills/claudex-council/CROSS_PLATFORM.md)
- **Why this exists**: [skills/claudex-council/VALUE_PROPOSITION.md](skills/claudex-council/VALUE_PROPOSITION.md)
- **Changelog**: [skills/claudex-council/CHANGELOG.md](skills/claudex-council/CHANGELOG.md)
- **Security model**: [skills/claudex-council/SECURITY.md](skills/claudex-council/SECURITY.md)
- **Contributing**: [skills/claudex-council/CONTRIBUTING.md](skills/claudex-council/CONTRIBUTING.md)

## Roadmap (next)

- Auth-failure detection that catches real CLI strings (`Invalid API key`, `not signed in`, etc.) and surfaces the remediation command (`claude login` / `codex login`) inline
- `claude auth status` / Codex equivalent pre-flight on session creation
- `CLAUDE_CODE_OAUTH_TOKEN` env var support for headless/CI/locked-down environments
- Auth-failure cooldown so successive turns don't re-burn 60s on the same broken CLI
- "Plan Mode" composer toggle: first turn = full council, follow-up turns = solo for fast iteration
- Mac binary-resolution fallback for `pnpm`-installed Codex (`~/Library/pnpm`)
- Linux fallback for `~/.cargo/bin` and `/snap/bin`
- Conditional synthesis: skip the synthesizer call when worker briefs already agree

## License

[MIT](skills/claudex-council/LICENSE)

## Trademark notice

"Claude" is a trademark of Anthropic, PBC. "Codex" and "OpenAI" are trademarks of OpenAI, Inc. "Visual Studio Code" is a trademark of Microsoft Corporation. This project is an independent open-source integration that calls those products' publicly-documented CLIs. It is not affiliated with, endorsed by, or sponsored by any of them.
