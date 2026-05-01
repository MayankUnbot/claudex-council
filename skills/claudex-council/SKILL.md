---
name: claudex-council
description: Run a dual-agent council where Claude acts as the decider, splits the user's prompt into subtasks for itself and the OpenAI Codex CLI (`codex exec`), executes them in parallel or sequence, then synthesizes a unified final answer with three labelled sections — "What Claude did", "What Codex did", and "Final answer". Use this skill whenever the user types `/claudex-council`, asks for a "dual-agent" review, asks to "have Claude and Codex collaborate" or "second-opinion", asks for a "council" of models, or wants both Claude and OpenAI's Codex CLI weighing in on a non-trivial coding, design, or review task. Especially valuable when output quality matters more than token cost — ambiguous architectural decisions, multi-language refactors, deep code reviews, or any task where two independent agents are likely to catch what one would miss.
---

# claudex-council

You are the **decider** in a two-agent council. The other agent is OpenAI's Codex CLI, reachable via the bundled `scripts/ask_codex.py` helper. The user has invoked this skill because they want both of you working on their prompt together, and they expect a clean three-section answer at the end.

The user does **not** want to see your planning, the routing logic, or the bash plumbing. They want to see what each agent produced and your final synthesis. Treat the orchestration as backend; treat the three sections as the entire frontend.

## When this skill is active

Whenever Claude Code loads this skill (the user typed `/claudex-council`, asked for a "dual-agent" / "second-opinion" / "council" workflow, or otherwise indicated they want both agents involved), follow the four phases below for the user's request. Do not narrate the phases to the user — execute them silently and only surface the three-section output at the end.

## Prerequisites — verify silently on first invocation per session

Before phase 1, confirm Codex is reachable. Run:

```bash
codex --version
```

If that fails (command not found), tell the user once: *"This skill needs the OpenAI Codex CLI installed and authenticated. Install from https://github.com/openai/codex, run `codex` once to log in, then re-run your prompt."* Then stop. If it succeeds, proceed silently.

The bundled helper lives at `scripts/ask_codex.py` relative to this SKILL.md. Use the absolute path when invoking it (resolve it from the skill's own location).

## Phase 1 — Decide

Read the user's prompt and decide, internally, three things:

1. **What subtasks does this break into?** Even a single-question prompt usually has implicit subtasks: gather context, draft, critique, finalize. List them in your head.
2. **Who should do each subtask?** Match each subtask to the agent better suited to it:
   - **Claude is generally better at**: large-context reasoning over many files, structured writing, explaining tradeoffs, code review with prose justification, working with the user's existing tools (Read/Grep/Glob/Edit), tasks needing memory of this repo's conventions.
   - **Codex is generally better at**: fresh implementations from scratch in a sandboxed workspace, second-opinion sanity checks (it doesn't share Claude's biases), tasks where having a different model's perspective is the whole point, isolated coding problems where you want a clean attempt without the parent context.
   - **When the task is purely "give me a second perspective"**: send the *same* prompt to both agents and compare outputs in synthesis. This is the simplest valid plan.
3. **Parallel or sequential?** If subtasks are independent, run them in parallel (Codex in background, Claude work in the same turn). If one feeds the other, run sequentially.

Keep this plan in your head. Do **not** print the plan to the user.

## Phase 2 — Dispatch

### Calling Codex

Always invoke Codex through the helper, never `codex exec` directly. Pass the prompt via the positional argument or stdin — both are safe across Mac, Linux, and Windows shells:

```bash
python "<absolute-path-to-skill>/scripts/ask_codex.py" "<the subtask prompt for Codex>"
```

For long or multi-line prompts, prefer stdin to avoid quoting fragility:

```bash
python "<abs-path>/scripts/ask_codex.py" <<'PROMPT'
<multi-line prompt body here>
PROMPT
```

The helper returns only Codex's final reply on stdout; intermediate event noise is suppressed. It exits non-zero if Codex fails — surface those failures by including a brief note in the "What Codex did" section rather than aborting the whole turn.

When the Codex subtask should operate inside the user's project, pass `--cwd <path>`. When you want a specific model, pass `--model <name>`. Otherwise let it use the user's configured default.

### Running in parallel

When Claude's and Codex's subtasks are independent, kick Codex off as a background process **in the same assistant turn** where you start your own work, then read its output once both are done.

Pseudo-pattern:

```
1. Bash(run_in_background: true,
        command: 'python ".../ask_codex.py" "<codex subtask>"')
   → returns shell_id

2. Do Claude's subtask inline (Read/Edit/Grep/reasoning/code-writing).

3. BashOutput(shell_id) until Codex finishes. Capture its full stdout.
```

If Codex's subtask is short (a single quick question), it's fine to run it synchronously instead. Use background only when there's meaningful parallel work to overlap with.

### Running sequentially

When Codex needs Claude's output (or vice versa), just call them in order. Synchronous bash for Codex, normal tool use for Claude's part.

## Phase 3 — Collect

Once both agents are done, you have two raw outputs in hand:

- **Claude's output**: whatever you produced (code diffs, analysis, file edits, etc.).
- **Codex's output**: the text the helper printed to stdout.

If Codex produced anything ambiguous, weird, or wrong, do not silently drop it — note it in the synthesis. The user trusts the council precisely because it surfaces disagreement.

## Phase 4 — Synthesize and respond

Your final response to the user must follow this exact structure and contain nothing else (no preamble, no "Here's what I did", no planning narration):

```markdown
## What Claude did

<concise summary of Claude's contribution. If code was written or edited,
reference the files with [filename](relative/path) links. Show the key
output inline if it's small; reference it if it's large.>

## What Codex did

<concise summary of Codex's contribution, presented in the same shape as
Claude's. Quote the relevant parts of Codex's reply verbatim where it
helps the user judge quality. If Codex disagreed with Claude, say so
explicitly — that disagreement is the value of the council.>

## Final answer

<your synthesized answer to the user's original prompt. This is the part
the user will actually act on. It should:
- Resolve any disagreement between Claude and Codex with reasoning,
  not coin flips.
- State the recommendation/result clearly up front.
- Reference the per-agent sections only when the choice matters.
- Be the single source of truth for the user — they shouldn't need to
  read the upper two sections to act on this one.>
```

The three section headers (`## What Claude did`, `## What Codex did`, `## Final answer`) are **mandatory and exact** — downstream renderers and the user's eyes both rely on this structure.

## Examples

### Example 1 — pure second-opinion

**User prompt:** *"Should I switch our auth from session cookies to JWT?"*

**Internal plan:** Same prompt to both agents (this is a "second perspective" task). Run in parallel.

**Dispatch:** Background Codex with the verbatim user prompt. In parallel, Claude reasons about the user's repo (greps for current auth code, reads the relevant files, considers their stack).

**Final response shape:**

```
## What Claude did
Reviewed src/auth/ in this repo. Found session-cookie middleware in
[auth.ts:42](src/auth/auth.ts#L42) backed by Redis. Concluded that for
this stack, switching to JWT would lose server-side revocation without
a clear win.

## What Codex did
Argued JWT is preferable for stateless horizontal scaling and gave a
3-step migration sketch. Did not have visibility into the existing
Redis-backed session store.

## Final answer
Stay with session cookies. Codex's JWT case is generic and assumes a
problem you don't have (you already have Redis + session revocation).
Revisit only if you move to a multi-region deployment where session
affinity becomes a constraint.
```

### Example 2 — task-split build

**User prompt:** *"Add a /healthz endpoint to my FastAPI app and write a pytest for it."*

**Internal plan:** Claude does the FastAPI edit (it has full repo context, knows your existing router patterns). Codex writes the pytest fresh in its sandbox. Parallel.

**Dispatch:** Background Codex with *"Write a pytest test for a FastAPI /healthz endpoint that returns {'status':'ok'} with HTTP 200. Include the import and fixture setup. Output just the test file content."* Claude meanwhile reads the FastAPI app, edits the router file.

**Final response shape:**

```
## What Claude did
Added /healthz to [app/routes.py](app/routes.py) wired to your existing
APIRouter pattern. Endpoint returns {"status": "ok"} with 200.

## What Codex did
Produced a self-contained pytest using TestClient. <verbatim test code>

## Final answer
Endpoint is live in app/routes.py; drop Codex's test into
tests/test_health.py and `pytest -k health` should go green. Codex's
test uses TestClient which matches your existing test style (verified
against tests/test_users.py).
```

## Notes on style

- The "Final answer" section is for the user. The other two sections are evidence. Lead with the answer; let the evidence support it.
- If one agent failed entirely (e.g. Codex timed out), still include its section but say "Codex did not return in time" in one line. Don't hide failures.
- Don't apologize for the format. Don't add a closing "let me know if you need anything else." The structure speaks for itself.
- Token cost is not a concern for this skill — the user opted in knowing it spends two agents per turn. Don't try to economize by skipping Codex when the prompt is "easy"; if the user invoked the council, they want the council.
