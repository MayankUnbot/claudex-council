#!/usr/bin/env python3
"""
Side-by-side evaluation: does the claudex-council add value over plain
Claude or plain Codex on the same prompt?

For each prompt we run three paths:
  1. Claude alone   — claude -p (mirrors what the extension does for one worker)
  2. Codex alone    — codex exec (mirrors what the extension does for the Codex worker)
  3. Council        — both in parallel, then a Claude synthesis pass
                      (mirrors the orchestrator's full-council path)

We measure wall time and capture every reply, then save a JSON record
plus a quick markdown summary. A separate script generates the chart.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
OUT_DIR = REPO_ROOT / "skills" / "claudex-council" / "scripts" / "benchmark_out"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Prompts intentionally span the routing taxonomy the orchestrator's
# heuristic uses, so we can see where the council pays off and where it
# wastes tokens. Kept short so the whole run stays under ~5 minutes.
PROMPTS = [
    {
        "id": "trivial",
        "label": "Trivial greeting",
        "prompt": "hey what's up",
    },
    {
        "id": "factual",
        "label": "Simple factual",
        "prompt": "In one paragraph: what's the practical difference between SSE and WebSockets for a notifications backend?",
    },
    {
        "id": "code",
        "label": "Code generation",
        "prompt": "Write a Python function `dedup_preserve(items)` that returns the input list with duplicates removed but original order preserved. Include a one-line docstring. No imports.",
    },
    {
        "id": "architecture",
        "label": "Architecture decision",
        "prompt": "I have a Postgres-backed app doing ~1000 events/min that need fan-out to 3 worker types. Should I use Postgres LISTEN/NOTIFY or add Redis? Two-paragraph answer with the deciding factor.",
    },
    {
        "id": "review",
        "label": "Code review / debugging",
        "prompt": "Review this Python: `def avg(xs): return sum(xs) / len(xs)`. List 3 ways it can fail in production and the smallest fix for each.",
    },
]


def run_claude(prompt: str) -> dict:
    """Mirror the extension's Claude worker invocation, minus the bulky session prompt."""
    args = [
        shutil.which("claude") or "claude",
        "-p",
        "--output-format", "json",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--max-turns", "1",
        "--system-prompt",
        "You are a council member responding directly to the user. Be concise and complete.",
    ]
    start = time.perf_counter()
    proc = subprocess.run(
        args, input=prompt, capture_output=True, text=True, encoding="utf-8",
        errors="replace", shell=(sys.platform == "win32"),
    )
    elapsed = time.perf_counter() - start
    parsed = {}
    text = ""
    try:
        # last JSON line is the result envelope
        for line in proc.stdout.splitlines():
            if not line.strip():
                continue
            parsed = json.loads(line)
        text = parsed.get("result", "") if isinstance(parsed, dict) else ""
    except Exception:
        text = proc.stdout
    return {
        "elapsed_sec": round(elapsed, 2),
        "exit_code": proc.returncode,
        "text": text.strip(),
        "raw_meta": {
            k: parsed.get(k)
            for k in ("model", "duration_ms", "duration_api_ms", "num_turns", "total_cost_usd", "usage")
            if isinstance(parsed, dict) and k in parsed
        },
    }


def run_codex(prompt: str) -> dict:
    """Mirror the extension's Codex worker invocation."""
    helper = REPO_ROOT / "skills" / "claudex-council" / "extension" / "scripts" / "ask_codex.py"
    args = [sys.executable, str(helper), "--cwd", "."]
    start = time.perf_counter()
    proc = subprocess.run(
        args, input=prompt, capture_output=True, text=True, encoding="utf-8",
        errors="replace",
    )
    elapsed = time.perf_counter() - start
    return {
        "elapsed_sec": round(elapsed, 2),
        "exit_code": proc.returncode,
        "text": proc.stdout.strip(),
        "raw_meta": {"stderr_tail": proc.stderr[-200:] if proc.stderr else ""},
    }


def run_council(prompt: str, claude_text: str, codex_text: str) -> dict:
    """Mirror the orchestrator's synthesis pass: feed both worker outputs to Claude (Haiku)."""
    synth_input = (
        "You are the synthesizer in a two-agent council. Two agents have already answered the user's question. "
        "Write ONE final answer the user will read.\n\n"
        f"<USER_QUESTION>\n{prompt}\n</USER_QUESTION>\n\n"
        f"<CLAUDE_RESPONSE>\n{claude_text or '(no response)'}\n</CLAUDE_RESPONSE>\n\n"
        f"<CODEX_RESPONSE>\n{codex_text or '(no response)'}\n</CODEX_RESPONSE>\n\n"
        "Write the final answer:\n"
        "- Lead with the direct answer or recommendation.\n"
        "- Where they agreed, just state the conclusion.\n"
        "- Where they meaningfully differed, pick a side and briefly say why.\n"
        "- Be concise.\n"
        "- No preamble like 'Here is the synthesis'."
    )
    args = [
        shutil.which("claude") or "claude",
        "-p",
        "--output-format", "json",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--max-turns", "1",
        "--model", "claude-haiku-4-5",  # synthesis uses Haiku per our defaults
        "--system-prompt", "You are the synthesizer. Be concise.",
    ]
    start = time.perf_counter()
    proc = subprocess.run(
        args, input=synth_input, capture_output=True, text=True, encoding="utf-8",
        errors="replace", shell=(sys.platform == "win32"),
    )
    elapsed = time.perf_counter() - start
    parsed = {}
    text = ""
    try:
        for line in proc.stdout.splitlines():
            if not line.strip():
                continue
            parsed = json.loads(line)
        text = parsed.get("result", "") if isinstance(parsed, dict) else ""
    except Exception:
        text = proc.stdout
    return {
        "elapsed_sec": round(elapsed, 2),
        "exit_code": proc.returncode,
        "text": text.strip(),
        "raw_meta": {
            k: parsed.get(k)
            for k in ("model", "duration_ms", "duration_api_ms", "num_turns", "total_cost_usd", "usage")
            if isinstance(parsed, dict) and k in parsed
        },
    }


def main() -> None:
    results = []
    for p in PROMPTS:
        print(f"\n=== {p['label']} ({p['id']}) ===")
        print(f"Prompt: {p['prompt'][:90]}{'...' if len(p['prompt']) > 90 else ''}")

        print("  -> claude alone...", end=" ", flush=True)
        claude_only = run_claude(p["prompt"])
        print(f"done in {claude_only['elapsed_sec']}s")

        print("  -> codex alone...", end=" ", flush=True)
        codex_only = run_codex(p["prompt"])
        print(f"done in {codex_only['elapsed_sec']}s")

        # Council = parallel Claude + Codex (we already have both above) + synthesis
        # The "parallel" wall-clock for the workers is max(claude, codex) since
        # the extension runs them concurrently. We approximate by reusing the
        # outputs we just captured (rather than re-burning tokens).
        worker_wall = max(claude_only["elapsed_sec"], codex_only["elapsed_sec"])
        print("  -> council synthesis...", end=" ", flush=True)
        synth = run_council(p["prompt"], claude_only["text"], codex_only["text"])
        print(f"done in {synth['elapsed_sec']}s")

        council_wall = round(worker_wall + synth["elapsed_sec"], 2)
        results.append({
            "id": p["id"],
            "label": p["label"],
            "prompt": p["prompt"],
            "claude_only": claude_only,
            "codex_only": codex_only,
            "synthesis": synth,
            "council_wall_sec": council_wall,
            "council_text": synth["text"],
        })
        print(f"  >> council total wall: {council_wall}s "
              f"(parallel workers {worker_wall}s + synth {synth['elapsed_sec']}s)")

    out_path = OUT_DIR / "results.json"
    with out_path.open("w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2)
    print(f"\nSaved raw results to {out_path}")


if __name__ == "__main__":
    main()
