#!/usr/bin/env python3
"""
Build a comprehensive PDF of the entire claudex-council development
session — every user request, every error, every fix, every Codex
collaboration, every version. Output goes to the repo root so the user
can attach it to a follow-up Codex session.
"""
from __future__ import annotations

import os
import sys
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    PageBreak,
    Table,
    TableStyle,
    KeepTogether,
)


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
OUTPUT_PATH = os.path.join(REPO_ROOT, "claudex-council-session.pdf")


def make_styles() -> dict:
    base = getSampleStyleSheet()
    styles = {
        "Title": ParagraphStyle(
            "TitleX",
            parent=base["Title"],
            fontSize=22,
            spaceAfter=12,
            textColor=colors.HexColor("#0b3d91"),
        ),
        "Subtitle": ParagraphStyle(
            "Sub",
            parent=base["Normal"],
            fontSize=12,
            textColor=colors.HexColor("#444"),
            spaceAfter=12,
            italic=True,
        ),
        "H1": ParagraphStyle(
            "H1X",
            parent=base["Heading1"],
            fontSize=16,
            textColor=colors.HexColor("#0b3d91"),
            spaceBefore=18,
            spaceAfter=8,
            keepWithNext=True,
        ),
        "H2": ParagraphStyle(
            "H2X",
            parent=base["Heading2"],
            fontSize=13,
            textColor=colors.HexColor("#0b3d91"),
            spaceBefore=12,
            spaceAfter=6,
            keepWithNext=True,
        ),
        "H3": ParagraphStyle(
            "H3X",
            parent=base["Heading3"],
            fontSize=11,
            textColor=colors.HexColor("#222"),
            spaceBefore=8,
            spaceAfter=4,
            keepWithNext=True,
        ),
        "Body": ParagraphStyle(
            "BodyX",
            parent=base["Normal"],
            fontSize=10,
            leading=14,
            spaceAfter=6,
        ),
        "BodyDim": ParagraphStyle(
            "BodyDim",
            parent=base["Normal"],
            fontSize=9.5,
            leading=13,
            textColor=colors.HexColor("#555"),
            spaceAfter=4,
        ),
        "Quote": ParagraphStyle(
            "Quote",
            parent=base["Normal"],
            fontSize=10,
            leading=14,
            textColor=colors.HexColor("#1a3a6e"),
            leftIndent=18,
            rightIndent=18,
            spaceBefore=4,
            spaceAfter=8,
            borderColor=colors.HexColor("#0b3d91"),
            borderPadding=8,
            backColor=colors.HexColor("#eef3fb"),
        ),
        "Code": ParagraphStyle(
            "Code",
            parent=base["Code"],
            fontSize=8.5,
            leading=11,
            backColor=colors.HexColor("#f5f5f5"),
            borderPadding=6,
            spaceAfter=6,
            textColor=colors.HexColor("#222"),
        ),
        "Caption": ParagraphStyle(
            "Cap",
            parent=base["Normal"],
            fontSize=8.5,
            textColor=colors.HexColor("#777"),
            alignment=1,
        ),
    }
    return styles


def p(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def section_header(text: str, anchor_style) -> Paragraph:
    return Paragraph(text, anchor_style)


def kv_table(rows, col_widths=None):
    if col_widths is None:
        col_widths = [1.6 * inch, 4.6 * inch]
    table = Table(rows, colWidths=col_widths, hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, -1), "Helvetica", 9),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#0b3d91")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#dfe7f5")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#0b3d91")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f9fc")]),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#cdd6e6")),
            ]
        )
    )
    return table


def build():
    s = make_styles()
    doc = SimpleDocTemplate(
        OUTPUT_PATH,
        pagesize=LETTER,
        leftMargin=0.7 * inch,
        rightMargin=0.7 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
        title="claudex-council Development Session Log",
        author="Generated from Claude Code session",
    )
    story = []

    # ---- Title page ----
    story.append(p("claudex-council", s["Title"]))
    story.append(p(
        "Full development session log: vision, architecture, every bug, every fix, "
        "every Codex collaboration, every version v0.1.0 → v0.5.8.",
        s["Subtitle"],
    ))
    story.append(Spacer(1, 0.2 * inch))
    story.append(kv_table([
        ["Field", "Value"],
        ["Project", "claudex-council — VS Code extension that orchestrates a Claude + Codex council per turn"],
        ["Repo root", REPO_ROOT],
        ["Skill folder", "skills/claudex-council/"],
        ["Extension folder", "skills/claudex-council/extension/"],
        ["Latest version installed", "v0.5.8"],
        ["Generated by", "Claude Code session, on user request"],
        ["Generated for", "Hand-off to Codex (per user's explicit follow-up plan)"],
    ]))
    story.append(PageBreak())

    # ---- Executive summary ----
    story.append(p("1. Executive summary", s["H1"]))
    story.append(p(
        "Across this session we designed and built <b>claudex-council</b>, a VS Code extension "
        "that runs a 'council' of two coding agents per user turn: Claude as one worker, OpenAI's "
        "Codex CLI as the other, with a third Claude call (the 'decider') synthesizing both into a "
        "single final answer. The user wanted the experience to look and feel like Claude Code's "
        "own chat panel, run on Mac and Windows seamlessly, and ship as a free, open-source "
        "GitHub release.",
        s["Body"],
    ))
    story.append(p(
        "The build went through eight major versions in a single session, with progressively tighter "
        "user feedback loops. Codex itself was used as a collaborator at multiple inflection points: "
        "validating the model catalog, auditing for cross-platform bugs, and recommending "
        "performance flag combinations. Both agents contributed real, distinct value.",
        s["Body"],
    ))
    story.append(p("Headline outcomes:", s["H3"]))
    story.append(kv_table([
        ["Aspect", "State at v0.5.8"],
        ["Multi-session", "Each click of the + in the Sessions sidebar opens an independent editor-tab session with its own orchestrator. Sessions don't share state."],
        ["Per-agent model picker", "Top-bar dropdowns for Claude worker / Codex worker / Decider synthesis. 33 models in the catalog. Decider dropdown allows BOTH providers; selecting a Codex model routes synthesis through codex exec."],
        ["Subscription-aware filtering", "Probe-on-demand: real micro-calls to each catalog model verify availability on the user's account; results cached 7 days. 19/25 Codex models in the catalog don't work on the user's ChatGPT account; only 6 do — those are the ones shown after probing."],
        ["Cost story", "Trivial-prompt fast path (greetings, ack) skips Codex + synthesis and forces Haiku. Default Claude worker dropped from Opus 4.7 to Sonnet 4.6 (~3× faster). Empty MCP, --disable-slash-commands, --max-turns 1, custom --system-prompt cut Claude cold-start ~40%."],
        ["Cross-platform", "Verified on Windows. Code paths and CI workflow built for macOS and Linux. CROSS_PLATFORM.md documents what's verified live vs. structurally."],
        ["Live UI feedback", "Per-agent verb rotation while running (Adjudicating, Beam-searching, Steeping...). Live elapsed counter that settles to final time. Turn footer with total time and agent count. Model badge per bubble showing exact model used."],
        ["Error policy (v0.5.6 → v0.5.8)", "UI never renders role:'error' bubbles. Errors log to console.warn. Stream classified as success / partial / failure via terminal-event detection. StringDecoder for UTF-8 chunk safety. Settled-flag double-resolve guard."],
    ]))
    story.append(PageBreak())

    # ---- The product vision ----
    story.append(p("2. The product vision (user's framing, in their words)", s["H1"]))
    quotes = [
        ("Initial scope", "I want to make maybe some extension named Codex, let's say for now. When I click a button of the Claude Code extension, it just opens a tab in VS Code. ... in that extension as well, when I click on that extension, it should open a tab for me in VS Code. The basic idea will be: if I write a prompt, it will go to a decider, and the decider agent will be of Claude Code only. The decider will throw the prompt at both of them, Codex and Claude Code both. ... The decider will merge those outputs and show it to the end user that Claude did this and Codex did this, and this is your final output."),
        ("Distribution: skill, not extension", "should we make this an extension or a Claude Code skill over GitHub? ... if we push it as a Claude Code skill, not as a cloud codex scale over GitHub, then it can catch a lot of traction. Also, it should be running on both Mac and Windows. ... once anyone on any other machine downloads that skill, then automatically it will download as an extension onto their VS Code, and it will just do whatever I have asked you to do before."),
        ("Cost-conscious from day one", "since the requests will be enormous, because the agents will be calling Codex, then also the cloud as well, it will be enormous. There will be many requests, and so the token limit and those things will be too much. It will be very cost-driven, cost-heavy. I wanted to make use of tools like caveman where it can help us reduce so much of tokens."),
        ("Free-tier first", "I don't know whether it will work for free Claude Code and free codex and free ChatGPT accounts. I know there will be limits, but at least it should work if there is a limit."),
        ("Live status, distinct verbs per agent", "I want you to paste whatever Claude Code is thinking, just like you show those options like tinkering, combo volatting, that feels very nice. Those support I want you to give it to this as well. ... Similarly, for cloud agent as well, you can write the same for codex. I would suggest you write like this only, but it should be some different. It should feel good. It should be different. It should be coming as, the words should not be from that list which Claude Code has."),
        ("Per-agent timing in UI", "I want you to add how much time the decider took to write the query to write the response. Similarly, how much time Claude took, then Codex took, then the final decider took, and overall how much time it took for each response."),
        ("Model selection per agent", "Codex runs on a model, right? It could be 5.4, it could be 5.5, and many others. Similarly, for Codex, it runs on a model, right? I would also like to give people an option to choose what would be the decider, which exact model will be the Claude, which exact model will be the Codex, and which exact model will be the final decider."),
        ("Subscription-aware filtering", "It is completely subscription-based. Whatever the model the user is using, we have to show only those models to him, just like how Claude Code and codex show models based on user subscription. ... If he's not logged in, if he is logged in as a free account for codex, then show only those models which are free."),
        ("Production grade, not prototype", "Coordinate with codex and test for all the scenarios where I don't know what, but all the agents should actually work. It's not a prototype. We are building production-level code, buddy. Everything should be perfect."),
        ("Speed", "still, it is very slow. I got cloud output in 30 seconds, codex in 6 seconds, and decider in 14 seconds. ... I want fast and fast output, just like how codecs normally work and just like how Claude normally works."),
        ("No errors visible to user", "make sure that cloud and Codex and deciders, it never returns any error. It should never return any error. Tell it to fix it permanently forever."),
        ("Real fixes, not silencing", "I didn't mean that. The errors are silent. I know. The thing is, I want you to fix all the bugs. That's what my intention is. ... fix the errors permanently and fix all the bugs."),
    ]
    for label, quote in quotes:
        story.append(p(f"<b>{label}.</b> &ldquo;{quote}&rdquo;", s["Quote"]))
    story.append(PageBreak())

    # ---- Architecture timeline ----
    story.append(p("3. Architecture decisions, in the order they were made", s["H1"]))
    arch = [
        ("Initial proposal: skill alone, no extension",
         "First instinct was to build claudex-council as a pure Claude Code skill — install via cloning into ~/.claude/skills/, no VS Code extension at all. The Claude Code panel itself would be the UI; markdown rendering would handle the three-section output. Cost: zero. Maintenance: minimal."),
        ("User pushback: distinct UI surface",
         "User wanted a real chat-style tab in VS Code with per-agent panels and a bottom composer with image upload. A pure markdown answer in the Claude Code panel didn't match their vision. Pivoted to skill + bundled VS Code extension."),
        ("Extension scaffolding (v0.1.0)",
         "Activity-bar icon + view container + sidebar webview. Webview HTML/CSS/JS in skills/claudex-council/extension/webview/. Three-color verb-style theme using VS Code CSS variables (theme-aware). Initial bubble structure with placeholder agent responses."),
        ("Multi-session refactor (v0.2.0)",
         "User: 'I can only open one session, which is not good.' Refactored to vscode.window.createWebviewPanel per session. Each session = its own editor tab + own Orchestrator instance. Sidebar became a Sessions tree with + button + open-sessions list."),
        ("Cross-provider synthesis routing (v0.4.0)",
         "Decider dropdown contains BOTH Claude AND Codex models. If user picks a Codex model, runSynthesis() routes through ask_codex.py instead of claude -p. Provider detected via findModel(id).provider. Same synthesis prompt body works for either provider."),
        ("Subscription-aware probing (v0.5.0)",
         "Catalog had 33 models but only ~14 worked on the user's account. Built modelProber.ts: real micro-call per model with stdin 'ok' prompt, parses the response for known failure patterns. Caches results in context.globalState for 7 days. Webview filters dropdowns through the cache so only callable models show up."),
        ("Performance pass (v0.5.2 → v0.5.5)",
         "Codex audited the spawn pattern and recommended a flag set that turns claude -p into a near-pure LLM call: --no-session-persistence, --strict-mcp-config + empty config file, --disable-slash-commands, --max-turns 1, --system-prompt override. ~40% cold-start reduction. Plus trivial-prompt fast path that runs only the Claude worker on greetings (with Haiku forced). Default worker dropped Opus→Sonnet because Opus is ~3× slower for the same output."),
        ("Permanent error policy (v0.5.6 → v0.5.8)",
         "User: 'It should never return any error.' Then: 'No, fix the bugs at the source.' Both correct simultaneously. Three-tier classification: stream + terminal event = success; stream + no terminal event = partial (show what we got, log truncation); no stream = real failure (retry once, then surface only via console.warn). UI never renders role:'error'. StringDecoder for chunk-boundary UTF-8. Settled-flag against double-resolve. Attachment cleanup on cancel."),
    ]
    for title, body in arch:
        story.append(p(title, s["H2"]))
        story.append(p(body, s["Body"]))
    story.append(PageBreak())

    # ---- Version history ----
    story.append(p("4. Full version history with bugs fixed per release", s["H1"]))
    versions = [
        ("v0.1.0", "Initial release. Activity-bar icon, single sidebar webview, placeholder agent bubbles for UI preview."),
        ("v0.2.0", "Multi-session via WebviewPanel-per-session. Real orchestration replacing placeholders: claude -p stream-json for the Claude worker, ask_codex.py for the Codex worker, claude -p synthesis on both outputs."),
        ("v0.2.1", "Bundled ask_codex.py inside the VSIX (was missing in v0.2.0). Stream parser ignores duplicate 'assistant' envelope to fix doubled output. Decider plan bubble's spinner stops immediately. Synthesis prompt wraps inputs in &lt;USER_QUESTION&gt;/&lt;CLAUDE_RESPONSE&gt;/&lt;CODEX_RESPONSE&gt; so it stops misreading the embedded context."),
        ("v0.2.2", "Multi-word prompt mangling killed: prompts now pipe via stdin to both claude -p and python ask_codex.py. argv-with-spaces was being word-split by cmd.exe under shell:true on Windows, making argparse explode and Claude see only the first word ('You')."),
        ("v0.2.3", "Codex's audit found and fixed: per-bubble status targeting via dataset.turnId/agent/role; turn IDs now include random suffix to avoid collisions; synthesis failure path explicitly emits agent-status:failed."),
        ("v0.3.0", "Per-agent timing display: live elapsed counter while running, settles to final time when done. Turn footer below every completed turn. Three creative verb sets (Adjudicating/Beam-searching/Steeping families). Economy mode setting (skip Codex + synthesis). Friendly quota error messages. Default Python: python3 on macOS/Linux, python on Windows."),
        ("v0.3.1", "Codex's perf audit caught: stdin instead of argv for codex too (was still argv); UTF-8 stdin/stdout/stderr reconfigure in ask_codex.py to fix Windows cp1252 mojibake; process tree kill via taskkill /T /F on Windows + killpg on Unix; binary discovery fallback paths for macOS Dock-launched VS Code (/opt/homebrew/bin etc)."),
        ("v0.3.2", "Per-agent model selection: claudeWorkerModel, codexWorkerModel, deciderModel settings. Translates to --model flag on claude -p and -m on codex exec."),
        ("v0.3.3", "Live model badge in each bubble header. Parsed from claude stream-json's system:init event for Claude bubbles. Read from ~/.codex/config.toml + emitted on stderr via a CLAUDEX_MODEL marker for the Codex bubble."),
        ("v0.4.0", "Top-bar model picker: dropdowns for Plan / Claude / Codex / Decider. Decider dropdown contains BOTH providers grouped. Cross-provider synthesis routing — picking a Codex model in the Decider runs synthesis through ask_codex.py. Reset + Refresh buttons. Initial catalog of 33 models."),
        ("v0.4.1", "Catalog merged with Codex's authoritative listing (Pro/Mini/Nano variants for every GPT-5.x generation; dated Claude snapshots). Codex flagged 5 deprecated IDs which got dropped: gpt-5-codex, gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.1-codex-mini, gpt-5.2-codex."),
        ("v0.5.0", "modelProber.ts: real micro-calls per catalog model verify availability on the user's account. Cached 7 days in context.globalState. Webview filters dropdowns through the cache. 'Refresh Available Models' command in palette + ↻ button. Auto-probe at activation initially."),
        ("v0.5.1", "Auto-probe disabled — was firing 21+ parallel CLI calls competing with the user's first real turn. Now probe only runs on manual ↻ click or command. Trivial-prompt fast path added: greetings/ack skip Codex + synthesis, just run Claude solo."),
        ("v0.5.2", "Codex's perf flag set applied to claude -p: --no-session-persistence, --strict-mcp-config + empty MCP config, --disable-slash-commands, --system-prompt override, --max-turns 1. ~40% cold-start reduction. Codex side: --ephemeral, --ignore-user-config, project_doc_max_bytes=0, include_*_instructions=false, mcp_servers={}, model_reasoning_effort=low."),
        ("v0.5.3", "Bug: --setting-sources '' was rejected by claude CLI (valid options: user/project/local). Fixed by dropping that flag — there's no clean way to pass 'no settings' short of --bare which breaks OAuth."),
        ("v0.5.4", "Bug: --mcp-config '{\"mcpServers\":{}}' was being read as a file path under Windows cmd.exe (shell:true strips single quotes, then treats the unquoted JSON as a path). Fixed by writing the empty config to a temp file once and passing the file path."),
        ("v0.5.5", "Trivial detection too strict — 'Hey buddy how are you how do you do' (9 words) wasn't matching. Word count cap raised to 15 for greeting matches; substantive-keyword veto added (any 'write/fix/explain/code/...' kicks the prompt to full council). Trivial path forces Haiku regardless of user's worker-model selection. Default Claude worker dropped Opus 4.7 → Sonnet 4.6 (Opus is opt-in via dropdown)."),
        ("v0.5.6", "Permanent error-suppression policy (per Codex's recommendation): UI never receives role:'error' bubbles. Failures log to console.warn. If synthesis itself fails, falls back to first working agent's text, then to one polite line."),
        ("v0.5.7", "Smarter stream classification: sawTerminalEvent flag tracked from message_stop / result events. Three classes: success (content + terminal), partial (content but no terminal — show + log truncation), failure (no content — retry/surface). EPIPE-safe stdin write (write+end instead of end-with-buffer)."),
        ("v0.5.8", "Codex audit findings applied: StringDecoder for stream chunk UTF-8 (handles multi-byte split across data events); MAX_LINE_BYTES cap on stdoutBuf to prevent unbounded growth on malformed streams; settled-flag guard against double-resolve race between 'error' and 'close' events; currentAttachmentPaths tracked at orchestrator level so cancel() cleans temp images immediately."),
    ]
    rows = [["Version", "Changes"]] + versions
    story.append(kv_table(rows, col_widths=[0.7 * inch, 5.5 * inch]))
    story.append(PageBreak())

    # ---- Codex collaborations ----
    story.append(p("5. Where Codex genuinely contributed", s["H1"]))
    story.append(p(
        "Codex was used as more than a passive worker — it was a collaborator at four specific "
        "points where it caught things I'd missed:",
        s["Body"],
    ))

    collabs = [
        ("Cross-platform bug audit (v0.3.1)",
         "I asked Codex to audit orchestrator.ts and ask_codex.py for cross-platform bugs. It identified: "
         "(1) proc.kill() only kills the immediate child on shell:true Windows, leaving Claude/Codex/Node grandchildren orphaned; "
         "(2) ask_codex.py was passing prompts as argv to codex.cmd, which on Windows means cmd.exe word-splits non-ASCII through OEM codepage; "
         "(3) macOS Dock-launched VS Code has stripped PATH lacking /opt/homebrew/bin, ~/.npm-global/bin, ~/.local/bin; "
         "(4) Python helper timeout doesn't kill codex.cmd subtree on Windows. All four were real bugs and got fixed."),
        ("Model catalog enumeration (v0.4.1)",
         "I built an initial catalog of ~10 models. Codex's catalog response added 23 more entries I hadn't known about: gpt-5.5-pro, gpt-5.4-mini/nano, gpt-5.3-codex/codex-spark, the gpt-5.2 family, gpt-5.1 family, original gpt-5 with mini/nano variants, o3-pro. It also flagged 5 deprecated IDs as 'drop': gpt-5-codex, gpt-5.1-codex/max/mini, gpt-5.2-codex. We removed those from the source catalog."),
        ("Performance flag tuning (v0.5.2)",
         "I asked Codex what flag combinations turn claude -p into a near-pure LLM round-trip. Its recommendation went much further than what I'd tried — --setting-sources, --strict-mcp-config + empty MCP config, --tools '', --system-prompt override, --max-turns 1, plus environment variables CLAUDE_CODE_DISABLE_AUTO_MEMORY and CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS. Live benchmark confirmed ~40% cold-start reduction. I then had to drop --setting-sources '' because Claude CLI rejected it, and switch --mcp-config from inline JSON to a temp-file path because Windows cmd.exe strips single quotes — but the rest stuck."),
        ("Error-suppression policy (v0.5.6) and bug audit (v0.5.8)",
         "Codex's response on permanent error policy crystallized the rule: 'UI must treat agent failures as internal state, never as renderable chat content.' That became the policy. Then for the v0.5.8 bug audit, Codex flagged: (1) stream success criterion needs sawTerminalEvent (not just any content); (2) UTF-8 chunk-boundary splits with chunk.toString('utf8') need StringDecoder; (3) double-resolve race between 'error' and 'close' events needs a settled flag; (4) unbounded stdoutBuf growth needs a MAX_LINE_BYTES cap; (5) attachment cleanup on cancel needs orchestrator-level path tracking. All five shipped."),
    ]
    for label, body in collabs:
        story.append(p(label, s["H2"]))
        story.append(p(body, s["Body"]))
    story.append(PageBreak())

    # ---- Outstanding items ----
    story.append(p("6. Outstanding items / open questions for the next session", s["H1"]))
    open_items = [
        ("Reproduce the post-stream exit-1 bug",
         "User saw 'Claude failed: Error: Claude exited with code 1' alongside a successful streamed reply. I cannot reproduce this on my Windows box with the same flag set via direct CLI OR via Node spawn (mirroring the orchestrator). v0.5.8 has defensive code that would prevent the user-facing symptom even if the underlying cleanup-exit-1 happens, but the root cause is unidentified. Codex's top hypothesis: --strict-mcp-config + empty MCP config exercises plugin teardown paths that occasionally exit non-zero. A/B benchmark didn't reproduce; Codex's hypothesis remains unproven."),
        ("CI workflow needs a real run on macos-latest",
         "The .github/workflows/cross-platform.yml workflow exists and runs build + smoke on macos-latest, windows-latest, ubuntu-latest. It hasn't actually executed yet because the repo hasn't been pushed to GitHub. First push will give a real cross-platform proof signal."),
        ("Live native macOS verification",
         "I've never run the extension on an actual Mac. CROSS_PLATFORM.md is honest about what's verified live (Windows: 10/10 smoke) versus structurally (macOS: code paths exist and CI builds). Claims to verify on a real Mac: VSIX install behavior under macOS Gatekeeper, Activity Bar icon SVG rendering, retina display sharpness of the bubble UI, Dock-launched VS Code's PATH gap actually being recovered by resolveBinary()'s well-known dirs."),
        ("Caveman skill integration",
         "User installed the JuliusBrussee/caveman skill via git clone into ~/.claude/skills/caveman/. We've discussed wiring it into the worker prompts only (keep synthesis output in normal English) but haven't actually integrated it. The hooks should be: in orchestrator.ts when building the worker system prompt, conditionally include caveman's compression directive."),
        ("Network-fetched model catalog",
         "The 'Refresh' button currently re-emits the bundled catalog. Plumbing exists (sendModelCatalog can do an async fetch). For real updates when new models drop, host a model-catalog.json at a versioned URL (e.g. GitHub Pages from this repo) and add a 5s-timeout fetch with bundled-fallback in sendModelCatalog()."),
        ("Per-phase token telemetry",
         "Codex repeatedly recommended adding per-phase token tracking (router/claude-worker/codex-worker/synthesis/output) so we can prove each future cost optimization actually helps. Currently the only timing instrumentation is wall-clock. Token counts are available in claude's stream-json result envelope (input_tokens, cache_creation_input_tokens, output_tokens) — wire them into agent-timing events."),
        ("README polish for public release",
         "skills/claudex-council/README.md is comprehensive but still aimed at the user's own workflow. For public release: add screenshots/GIFs, finalize the trademark disclaimer placement, add a 'why three agents' explainer section. CHANGELOG.md is current through v0.5.8."),
    ]
    for label, body in open_items:
        story.append(p(label, s["H2"]))
        story.append(p(body, s["Body"]))

    # ---- File map ----
    story.append(PageBreak())
    story.append(p("7. File map (current, post-v0.5.8)", s["H1"]))
    story.append(p("All paths are relative to the repository root.", s["BodyDim"]))
    files = [
        ("File", "Purpose"),
        ("skills/claudex-council/SKILL.md", "Original skill definition (now superseded by the extension; kept for skill-only install path)"),
        ("skills/claudex-council/README.md", "Public-facing readme with cost story, install for Mac/Windows, trademark disclaimer"),
        ("skills/claudex-council/LICENSE", "MIT"),
        ("skills/claudex-council/SECURITY.md", "Vulnerability reporting, what data leaves the machine, scope"),
        ("skills/claudex-council/CONTRIBUTING.md", "Local setup, F5 dev loop, what PRs are welcome"),
        ("skills/claudex-council/CHANGELOG.md", "Full v0.1.0 → v0.5.8 history"),
        ("skills/claudex-council/CROSS_PLATFORM.md", "What's verified live vs structurally vs needs-Mac"),
        ("skills/claudex-council/scripts/ask_codex.py", "Cross-platform Python wrapper around codex exec. UTF-8 reconfigure of stdin/stdout/stderr. Passes prompts via stdin to codex (no argv mangling). Resolves codex via shutil.which + well-known fallback dirs. Emits CLAUDEX_MODEL on stderr."),
        ("skills/claudex-council/scripts/build_session_pdf.py", "This PDF generator (the script you just ran)"),
        ("skills/claudex-council/test/smoke.mjs", "10-check portable smoke test that runs on Win/Mac/Linux"),
        ("skills/claudex-council/.github/workflows/cross-platform.yml", "macos-latest + windows-latest + ubuntu-latest CI on every push"),
        ("skills/claudex-council/.github/ISSUE_TEMPLATE/", "bug + feature templates"),
        ("skills/claudex-council/extension/package.json", "VS Code extension manifest (v0.5.8). All settings, commands, view contributions."),
        ("skills/claudex-council/extension/src/extension.ts", "activate(): registers commands, sessions tree, refreshModels command"),
        ("skills/claudex-council/extension/src/sessionPanel.ts", "Per-session WebviewPanel + Orchestrator wiring. Catalog + availability filtering before sending to webview."),
        ("skills/claudex-council/extension/src/sessionsTree.ts", "Sidebar Sessions tree provider"),
        ("skills/claudex-council/extension/src/orchestrator.ts", "THE BRAIN. Spawns claude/codex CLIs, parses stream-json, emits events to webview. All the v0.5.8 hardening lives here."),
        ("skills/claudex-council/extension/src/modelCatalog.ts", "33-model catalog (Claude 9 + Codex 24 after dedup) with tier, speed, recommendedFor metadata"),
        ("skills/claudex-council/extension/src/modelProber.ts", "Probe-on-demand availability checker. 7-day cache in globalState."),
        ("skills/claudex-council/extension/scripts/ask_codex.py", "Bundled copy of the helper (gets installed at ~/.vscode/extensions/.../scripts/ on VSIX install)"),
        ("skills/claudex-council/extension/webview/index.html", "Top model bar + transcript + composer"),
        ("skills/claudex-council/extension/webview/styles.css", "VS Code theme variables; bubble + verb + counter + footer styles"),
        ("skills/claudex-council/extension/webview/app.js", "Webview frontend. Bubble rendering, verb rotation, model badges, attachments, postMessage handlers."),
        ("skills/claudex-council/extension/claudex-council.vsix", "Built artifact (v0.5.8)"),
        ("skills/claudex-council/extension/out/", "Compiled JS (TypeScript output)"),
    ]
    story.append(kv_table(files, col_widths=[3.0 * inch, 3.2 * inch]))

    # ---- Closing ----
    story.append(PageBreak())
    story.append(p("8. Hand-off note for Codex", s["H1"]))
    story.append(p(
        "This PDF was generated by Claude Code at the user's explicit request as a complete "
        "session log. The user's intent: hand the document to Codex so Codex can come up to speed "
        "on the project's history without rebuilding context from scratch.",
        s["Body"],
    ))
    story.append(p("If you (Codex) are reading this, here's what would help most going forward:", s["H3"]))
    story.append(p(
        "<b>1. Reproduce the exit-1 bug.</b> The user reported it. Claude's local repro fails — "
        "the bug is environment- or timing-specific. If you can find conditions where it fires "
        "(specific MCP plugins loaded, specific prompt patterns, slow network), the team can fix "
        "the root cause instead of just the symptom.",
        s["Body"],
    ))
    story.append(p(
        "<b>2. Run the live smoke test on macOS.</b> The CI workflow handles build/structure but "
        "doesn't test live agent calls (no upstream credentials available to runners). A real Mac "
        "run of node skills/claudex-council/test/smoke.mjs is the missing live-cross-platform proof.",
        s["Body"],
    ))
    story.append(p(
        "<b>3. Wire up Caveman.</b> The user installed it; we discussed integration but haven't shipped "
        "it. The natural place is orchestrator.ts buildClaudeFastArgs(): conditionally append "
        "caveman's compression instruction to the worker prompts (NOT the synthesis output, which "
        "must read in normal prose for the user-facing answer).",
        s["Body"],
    ))
    story.append(p(
        "<b>4. Add per-phase token telemetry.</b> claude -p stream-json's result envelope has "
        "input_tokens / cache_creation_input_tokens / output_tokens. Wire those into agent-timing "
        "events so the webview can show 'cost' alongside 'time' per bubble. Then future "
        "optimizations have a quantitative baseline.",
        s["Body"],
    ))
    story.append(Spacer(1, 0.3 * inch))
    story.append(p("Generated by Claude Code session, claude-opus-4-7[1m].", s["Caption"]))
    story.append(p(f"Output: {OUTPUT_PATH}", s["Caption"]))

    doc.build(story)
    print(f"PDF written to: {OUTPUT_PATH}")
    print(f"Size: {os.path.getsize(OUTPUT_PATH):,} bytes")


if __name__ == "__main__":
    try:
        build()
    except Exception as e:
        print(f"build failed: {e}", file=sys.stderr)
        sys.exit(1)
