# Security policy

## What this extension sends, and where

`claudex-council` runs entirely on your machine. It does not host or proxy any traffic of its own. When you submit a prompt:

1. Your prompt is piped via **stdin** (no shell quoting, no argv leakage) into:
   - the `claude` CLI (Anthropic's Claude Code), which sends it to **Anthropic's API**, and
   - the `codex` CLI (OpenAI's Codex), which sends it to **OpenAI's API**.
2. The synthesis call sends both worker outputs back to **Anthropic's API** as a single follow-up call.
3. The extension stores **no** prompts, completions, or telemetry off-machine. Every byte of conversation history lives only in the in-memory webview transcript and is lost when you close the tab.

If you attach an image, it is base64-decoded into a temp file under your OS temp dir, then referenced (by file path) in the Claude prompt so Claude's `Read` tool can open it. The temp file is deleted at the end of the turn.

## What you are trusting

- **Your installed `claude` and `codex` CLIs**, including their auth state. The extension uses whatever account you're already logged in with.
- **Anthropic and OpenAI's data-handling policies** for the prompts you submit (covered by the respective Terms of Service / privacy policies for those products).
- **The contents of this extension**, which are open source and reviewable under [LICENSE](LICENSE).

The extension never reads, stores, or transmits your API keys; auth lives entirely inside the upstream CLIs' own credential stores.

## Reporting a vulnerability

If you find a security issue (prompt injection that exfiltrates data, sandbox escape via the Codex helper, anything that lets a malicious workspace harm a user), **please do not file a public GitHub issue**. Instead:

1. Open a private security advisory on the GitHub repository: **Security → Advisories → Report a vulnerability**.
2. If that's unavailable, email the maintainer listed in `package.json`.
3. Include: a clear description, reproduction steps, the version (`claudex-council` version + your VS Code version + your OS), and any minimal proof-of-concept.

We will acknowledge receipt within 5 business days and aim to ship a fix within 30 days for confirmed issues. Coordinated disclosure is appreciated.

## Out of scope

The following are **not** considered security issues for this project:

- The `claude` or `codex` CLIs misbehaving (report those upstream to Anthropic / OpenAI respectively).
- LLM hallucinations that produce wrong but harmless content.
- Cost overruns from large prompts (use **Economy mode** in settings to cap).
- Quota exhaustion on free-tier accounts (expected; the extension surfaces a friendly message when this happens).

## Hardening notes for users

- Don't paste secrets, API keys, customer data, or proprietary code into a prompt unless you're comfortable with that data being sent to Anthropic and OpenAI.
- The Codex CLI runs with `--full-auto --skip-git-repo-check`, meaning Codex can read/write inside its sandbox workspace without per-action confirmation. If you don't want that, edit `scripts/ask_codex.py` and remove the `--full-auto` flag.
- The Claude worker runs with default Claude Code permissions. If you have an aggressive `~/.claude/settings.json` permission set, those apply here too.
