#!/usr/bin/env python3
"""
ask_codex.py — Invoke the OpenAI Codex CLI headlessly and return only the
agent's final message on stdout. Designed to be called from Claude Code as
part of the claudex-council skill.

Usage:
    python ask_codex.py "<prompt text>"
    echo "<prompt text>" | python ask_codex.py
    python ask_codex.py --cwd /path/to/project "<prompt>"

Why this wrapper exists:
  - `codex exec` streams a lot of intermediate event chatter to stdout. We
    use `-o <file>` to capture only the final agent reply, then print that.
  - Cross-platform quoting via stdin avoids shell-escaping nightmares when
    prompts contain quotes, newlines, backticks, or unicode.
  - `--full-auto --skip-git-repo-check --color never` makes Codex run
    non-interactively in a sandboxed workspace without ANSI noise.

Exits 0 on success, 127 if codex isn't installed, 124 on timeout, otherwise
forwards Codex's exit code.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile


def main() -> int:
    # Force UTF-8 on stdin/stdout/stderr so:
    #   - Prompts piped to us as UTF-8 bytes (from Node's
    #     `proc.stdin.end(prompt, 'utf8')` or a bash heredoc) are decoded
    #     correctly into Python codepoints — not mangled through cp1252,
    #     which is the Windows default and silently corrupts em-dashes,
    #     arrows, smart quotes, and any non-ASCII text.
    #   - Codex's reply is written back as UTF-8 bytes to whoever called us.
    # Without all three streams reconfigured, multi-byte characters get
    # round-tripped through cp1252 and emerge as double-encoded mojibake.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

    parser = argparse.ArgumentParser(description="Invoke Codex CLI headlessly.")
    parser.add_argument(
        "prompt",
        nargs="?",
        help="Prompt text. If omitted, prompt is read from stdin.",
    )
    parser.add_argument(
        "--cwd",
        default=None,
        help="Working directory Codex should treat as its workspace root.",
    )
    parser.add_argument(
        "--codex-binary",
        default=None,
        help=(
            "Optional path or command name for the Codex CLI. If omitted, the "
            "helper searches PATH and common per-OS install locations."
        ),
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Override the Codex model (e.g. 'o3', 'gpt-5'). Defaults to Codex's configured model.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=600,
        help="Seconds to wait for Codex before killing it (default: 600).",
    )
    parser.add_argument(
        "--fidelity",
        choices=("fast", "full-fidelity"),
        default="full-fidelity",
        help=(
            "Capability profile. Default 'full-fidelity' keeps the user's "
            "Codex config, web search, MCP servers, project rules, AGENTS.md, "
            "and tool surface — same as a native `codex` session. Use 'fast' "
            "only when you want a cheap read-only LLM pass with no tools."
        ),
    )
    parser.add_argument(
        "--full-sandbox",
        choices=("inherit", "read-only", "workspace-write", "danger-full-access"),
        default="inherit",
        help=(
            "Sandbox to apply only in full-fidelity mode. 'inherit' leaves the "
            "user's Codex config/default untouched."
        ),
    )
    parser.add_argument(
        "--dangerously-bypass-approvals-and-sandbox",
        action="store_true",
        help=(
            "Only in full-fidelity mode: pass Codex's dangerous bypass flag. "
            "Use only when the surrounding environment is already trusted."
        ),
    )
    args = parser.parse_args()

    prompt = args.prompt if args.prompt is not None else sys.stdin.read()
    if not prompt.strip():
        sys.stderr.write("ask_codex.py: empty prompt; nothing to send to Codex.\n")
        return 2

    # Resolve `codex` executable. PATH first (with PATHEXT on Windows so
    # codex.cmd is found), then well-known fallback dirs so VS Code launched
    # from the macOS dock — which often inherits a stripped PATH lacking
    # /opt/homebrew/bin and ~/.npm-global/bin — still finds it.
    codex_path = _resolve_codex_binary(args.codex_binary)
    if not codex_path:
        sys.stderr.write(
            "ask_codex.py: 'codex' CLI not found.\n"
            "Install it from https://github.com/openai/codex and ensure "
            "you've authenticated (run `codex` once interactively).\n"
            "If it's installed somewhere unusual, set claudexCouncil.codexBinary "
            "in VS Code settings, or add its directory to your PATH.\n"
        )
        return 127

    out_fd, out_path = tempfile.mkstemp(prefix="codex-out-", suffix=".txt")
    os.close(out_fd)

    # CRITICAL: We pass the prompt to codex via STDIN, not as a positional
    # argv. On Windows, codex resolves to codex.cmd (a npm shim batch file);
    # passing non-ASCII prompts through cmd.exe argv mangles them. stdin is
    # also safe for prompts containing %, &, |, newlines, etc.
    #
    # Common wrapper flags: stdin prompt, machine-readable event stream,
    # final answer captured to a file, no persistent session file. The
    # capability profile below decides whether we strip Codex down for
    # speed or let it keep the user's normal agent configuration.
    cmd: list[str] = [
        codex_path, "exec",
        # Read prompt from stdin (the `-` sentinel).
        "-",
        "--color", "never",
        "--json",
        "-o", out_path,
    ]
    if args.fidelity == "fast":
        # Fast mode is a pure read-only LLM pass. It deliberately removes
        # user config, project rules, web search, MCP, and tool context.
        # --ephemeral and --skip-git-repo-check stay scoped to fast so
        # full-fidelity behaves like a normal `codex` session (writes
        # rollouts, respects git-repo-check default).
        cmd += [
            "--ephemeral",
            "--skip-git-repo-check",
            "--ignore-user-config",
            "--ignore-rules",
            "--sandbox", "read-only",
            "-c", "project_doc_max_bytes=0",
            "-c", "include_environment_context=false",
            "-c", "include_permissions_instructions=false",
            "-c", "include_apps_instructions=false",
            "-c", "include_skill_instructions=false",
            "-c", "include_apply_patch_tool=false",
            "-c", 'web_search="disabled"',
            "-c", "mcp_servers={}",
            "-c", 'history.persistence="none"',
            "-c", 'model_reasoning_effort="low"',
            "-c", 'model_verbosity="low"',
        ]
    else:
        # Full fidelity preserves Codex's normal config/rules/tooling.
        # Sandbox follows the user's ~/.codex/config.toml unless the
        # user explicitly overrode it via the extension's
        # codexFullFidelitySandbox setting.
        if args.dangerously_bypass_approvals_and_sandbox:
            cmd.append("--dangerously-bypass-approvals-and-sandbox")
        elif args.full_sandbox != "inherit":
            cmd += ["--sandbox", args.full_sandbox]

    if args.cwd:
        cmd += ["-C", args.cwd]
    if args.model:
        cmd += ["-m", args.model]

    # Surface the resolved model name to our caller (the extension
    # orchestrator) on stderr, so it can paint the model badge in the UI
    # bubble header. This is metadata, not the answer; the actual answer
    # still flows through stdout. A magic prefix lets the orchestrator
    # filter for it without confusing it with diagnostic stderr lines.
    resolved_model = args.model or _read_default_codex_model() or "(CLI default)"
    sys.stderr.write(f"CLAUDEX_MODEL: {resolved_model}\n")
    sys.stderr.flush()

    # On Windows, ensure that if our timeout fires we can kill the whole
    # process tree (codex.cmd → node → codex), not just the immediate cmd.exe
    # shim. We do this by creating a new process group and using taskkill in
    # the timeout path. On Unix we use start_new_session for the same effect.
    popen_extra: dict = {}
    if sys.platform == "win32":
        popen_extra["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_extra["start_new_session"] = True

    proc: subprocess.Popen | None = None
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            **popen_extra,
        )
        try:
            stdout, stderr = proc.communicate(input=prompt, timeout=args.timeout)
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            try:
                proc.communicate(timeout=5)
            except Exception:
                pass
            sys.stderr.write(
                f"ask_codex.py: codex did not return within {args.timeout}s; aborting.\n"
            )
            _safe_unlink(out_path)
            return 124

        class _Result:
            pass
        result = _Result()
        result.returncode = proc.returncode
        result.stdout = stdout or ""
        result.stderr = stderr or ""
    except FileNotFoundError:
        sys.stderr.write(
            f"ask_codex.py: failed to execute resolved codex path: {codex_path}\n"
        )
        _safe_unlink(out_path)
        return 127

    if result.returncode != 0:
        sys.stderr.write(
            f"ask_codex.py: codex exited with code {result.returncode}.\n"
        )
        if result.stderr:
            sys.stderr.write(result.stderr)
        _safe_unlink(out_path)
        return result.returncode

    usage = _extract_usage(result.stdout)
    if usage:
        sys.stderr.write(
            "CLAUDEX_USAGE: "
            + json.dumps(usage, ensure_ascii=False, separators=(",", ":"))
            + "\n"
        )
        sys.stderr.flush()

    try:
        with open(out_path, "r", encoding="utf-8", errors="replace") as fh:
            sys.stdout.write(fh.read())
    finally:
        _safe_unlink(out_path)

    return 0


def _extract_usage(jsonl: str) -> dict | None:
    """Extract token telemetry from `codex exec --json` output."""
    latest: dict | None = None
    for raw in jsonl.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        usage = event.get("usage") if isinstance(event, dict) else None
        if not isinstance(usage, dict):
            continue
        latest = {
            "inputTokens": _number_or_none(usage.get("input_tokens")),
            "outputTokens": _number_or_none(usage.get("output_tokens")),
            "cacheReadInputTokens": _number_or_none(usage.get("cached_input_tokens")),
            "reasoningOutputTokens": _number_or_none(usage.get("reasoning_output_tokens")),
        }
    if not latest:
        return None
    return {k: v for k, v in latest.items() if v is not None}


def _number_or_none(value: object) -> int | float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    return None


def _safe_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def _read_default_codex_model() -> str | None:
    """Peek the user's ~/.codex/config.toml for the default model string.

    We don't try to parse TOML properly — we just look for a top-level
    `model = "..."` line. This is the convention codex uses and avoids a
    dependency on the `tomllib` stdlib module (only available 3.11+;
    while we require 3.8+, some users on 3.8/3.9 don't have it).
    """
    home = os.path.expanduser("~")
    config_path = os.environ.get("CODEX_HOME")
    if config_path:
        cfg = os.path.join(config_path, "config.toml")
    else:
        cfg = os.path.join(home, ".codex", "config.toml")
    if not os.path.isfile(cfg):
        return None
    try:
        with open(cfg, "r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.strip()
                # Skip section headers and comments.
                if not line or line.startswith("#") or line.startswith("["):
                    continue
                # Match: model = "value"  OR  model="value"
                if line.lower().startswith("model"):
                    eq = line.find("=")
                    if eq < 0:
                        continue
                    val = line[eq + 1 :].strip()
                    # Strip surrounding quotes (single OR double) and any
                    # trailing inline comment.
                    if "#" in val:
                        # naive but good enough: drop trailing comment
                        # only when not inside quotes.
                        if val.startswith(("'", '"')):
                            quote = val[0]
                            end = val.find(quote, 1)
                            if end > 0:
                                val = val[: end + 1]
                        else:
                            val = val.split("#", 1)[0].strip()
                    if (val.startswith('"') and val.endswith('"')) or (
                        val.startswith("'") and val.endswith("'")
                    ):
                        val = val[1:-1]
                    if val:
                        return val
    except OSError:
        return None
    return None


def _resolve_codex_binary(override: str | None = None) -> str | None:
    """Find the codex CLI executable across platforms.

    macOS VS Code launched from the Dock inherits a minimal PATH that often
    omits /opt/homebrew/bin, /usr/local/bin, ~/.npm-global/bin, and
    ~/.local/bin — exactly the places where users actually have codex
    installed. Search PATH first, then fall back to those well-known dirs.
    """
    if override and override.strip():
        candidate = override.strip()
        has_sep = os.path.sep in candidate or (os.path.altsep and os.path.altsep in candidate)
        if has_sep:
            if os.path.isfile(candidate) and os.access(
                candidate, os.X_OK if sys.platform != "win32" else os.F_OK
            ):
                return candidate
            return None
        path_hit = shutil.which(candidate)
        return path_hit

    path_hit = shutil.which("codex")
    if path_hit:
        return path_hit

    if sys.platform == "win32":
        # On Windows, npm-global bins are usually on PATH already; if not,
        # %APPDATA%\npm is the standard location for npm globals.
        appdata = os.environ.get("APPDATA")
        localappdata = os.environ.get("LOCALAPPDATA")
        candidates = []
        if appdata:
            candidates.append(os.path.join(appdata, "npm", "codex.cmd"))
            candidates.append(os.path.join(appdata, "npm", "codex"))
        if localappdata:
            # pnpm globals on Windows
            candidates.append(os.path.join(localappdata, "pnpm", "codex.cmd"))
            candidates.append(os.path.join(localappdata, "pnpm", "codex"))
    else:
        home = os.path.expanduser("~")
        candidates = [
            "/opt/homebrew/bin/codex",      # Apple Silicon Homebrew
            "/usr/local/bin/codex",          # Intel Homebrew / generic /usr/local
            os.path.join(home, ".npm-global", "bin", "codex"),
            os.path.join(home, ".local", "bin", "codex"),
            os.path.join(home, "node_modules", ".bin", "codex"),
            # pnpm globals: ~/Library/pnpm on macOS, ~/.local/share/pnpm on Linux
            os.path.join(home, "Library", "pnpm", "codex"),
            os.path.join(home, ".local", "share", "pnpm", "codex"),
            # Rust / cargo + Ubuntu snap (Linux)
            os.path.join(home, ".cargo", "bin", "codex"),
            "/snap/bin/codex",
            "/usr/bin/codex",
        ]
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK if sys.platform != "win32" else os.F_OK):
            return c
    return None


def _kill_tree(proc: "subprocess.Popen") -> None:
    """Kill a child process AND its descendants on both Windows and Unix.

    Why this exists: when codex resolves to codex.cmd on Windows, the immediate
    child is a cmd.exe shim that spawns Node, which spawns codex itself.
    proc.kill() on the cmd.exe shim leaves Node + codex orphaned. Same idea
    on Unix when shells get involved. Kill by process-group / process-tree.
    """
    try:
        if sys.platform == "win32":
            # taskkill /T /F kills the whole tree rooted at the given PID.
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                capture_output=True,
                timeout=5,
            )
        else:
            import signal
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
    except Exception:
        # Last resort — at least try the immediate child.
        try:
            proc.kill()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
