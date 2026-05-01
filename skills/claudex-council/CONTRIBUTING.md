# Contributing to claudex-council

Thanks for considering a contribution. This is a small open-source project — keep PRs focused, please.

## Quick local setup

You need: Node 18+, npm, Python 3.8+, VS Code 1.85+, and a working `claude` CLI and `codex` CLI authenticated against your accounts.

```bash
git clone <this-repo>
cd <repo>/skills/claudex-council/extension
npm install
npx tsc -p ./
npx --yes @vscode/vsce package --out claudex-council.vsix --allow-missing-repository --skip-license

# Install into your local VS Code:
#   macOS / Linux:
code --install-extension claudex-council.vsix --force
#   Windows (PowerShell or Git Bash):
code.cmd --install-extension claudex-council.vsix --force
```

Reload VS Code (`Ctrl+Shift+P` → "Reload Window") and the council icon appears in the Activity Bar.

## Running the extension from source (faster iteration)

Open `skills/claudex-council/extension/` in VS Code, hit `F5`. A second VS Code window launches with the extension loaded directly from `out/extension.js`. Edit, save, recompile (`npx tsc -p ./`), and reload the dev window — no VSIX repackage needed.

## What to send PRs for

Welcome contributions:

- **Cross-platform fixes** — anything that breaks on macOS, Linux, or specific shells.
- **Free-tier resilience** — better detection of upstream rate-limit messages from Claude or Codex CLIs. Pattern strings live in `extension/src/orchestrator.ts` → `friendlyAgentError()`.
- **More verbs** — extend the `VERBS` arrays in `extension/webview/app.js`. New verbs should fit each agent's vibe (decider = judicial, claude = craft, codex = ML/optimization) and not collide with any other agent's set.
- **Cost telemetry** — per-phase token tracking would help users measure savings.
- **Smarter routing** — a real classifier-based decider that picks single-agent vs council vs split based on prompt type.
- **Structured worker briefs** — replacing free-form worker output with a JSON schema like `{answer, reasoning, risks, confidence}`. This is the next planned big optimization.
- **Image / attachment improvements** — currently images are referenced by file path in the prompt; native multimodal would be cleaner.

## What to skip

- Renaming files for style preferences only.
- Speculative architecture changes without a working implementation.
- Adding dependencies — the extension is intentionally zero-runtime-deps. Stick to Node stdlib + `vscode` + Python stdlib.

## Code style

- TypeScript: strict mode is on; keep it. No `any` unless there's a comment explaining why.
- Comments: explain *why*, not *what*. Skip comments that just restate the code.
- Cross-platform: any new `child_process.spawn` should pass prompts via **stdin**, not positional argv (Windows + `shell:true` word-splits multi-word args). Look at how `runStreamingClaude` and `runBufferedProcess` already do it.
- No new emojis unless a real UX reason.

## Before opening a PR

1. Run `npx tsc -p ./` from `extension/` and make sure it compiles cleanly.
2. Repackage the VSIX and install it locally; smoke-test with one short prompt and one multi-word punctuated prompt.
3. Update `CHANGELOG.md` under an `## Unreleased` heading.
4. If you changed user-visible behavior, update `README.md`.

## Disagreements

If a maintainer pushes back on a PR, the burden is on you to explain *why* the change is right, not just *what* it does. We bias toward small, defensible diffs.
