#!/usr/bin/env python3
"""
Render the value-vs-cost analysis chart from benchmark_value.py's results.
Saves a PNG you can open locally — for personal-decision use only, per the
user's request.
"""
from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
OUT_DIR = REPO_ROOT / "skills" / "claudex-council" / "scripts" / "benchmark_out"
RESULTS_PATH = OUT_DIR / "results.json"
CHART_PATH = OUT_DIR / "council_value_vs_cost.png"


# Manual scoring after reading every output side-by-side.
# Score = "did the council's answer add real value beyond the better-of-the-
# two solo answers?" on 0-10 (0 = pure waste, 10 = transformative).
# Justification stored next to each so the chart is auditable.
QUALITY_SCORES = {
    "trivial":      {"claude": 7, "codex": 5, "council": 7,  "verdict": "Council = Claude alone. 2x time, zero added."},
    "factual":      {"claude": 8, "codex": 7, "council": 8,  "verdict": "Slightly cleaner with a 'bottom line' line. ~10% lift."},
    "code":         {"claude": 6, "codex": 7, "council": 9,  "verdict": "Picked Codex's readable version + explained WHY Claude's clever trick is worse. Real judgment."},
    "architecture": {"claude": 8, "codex": 7, "council": 9,  "verdict": "Tighter, more decisive than either alone. Synthesis of best insights."},
    "review":       {"claude": 8, "codex": 7, "council": 9,  "verdict": "Picked best fix from each agent, REJECTED one of Claude's suggestions as less practical."},
}


def main() -> None:
    data = json.loads(RESULTS_PATH.read_text(encoding="utf-8"))

    labels = [r["label"] for r in data]
    ids = [r["id"] for r in data]
    claude_t = [r["claude_only"]["elapsed_sec"] for r in data]
    codex_t = [r["codex_only"]["elapsed_sec"] for r in data]
    council_t = [r["council_wall_sec"] for r in data]

    claude_q = [QUALITY_SCORES[i]["claude"] for i in ids]
    codex_q = [QUALITY_SCORES[i]["codex"] for i in ids]
    council_q = [QUALITY_SCORES[i]["council"] for i in ids]

    fig, (ax_time, ax_qual, ax_value) = plt.subplots(
        3, 1, figsize=(11, 12), gridspec_kw={"hspace": 0.55}
    )
    fig.suptitle(
        "claudex-council: value vs. cost — 5-prompt benchmark",
        fontsize=14, fontweight="bold"
    )

    x = np.arange(len(labels))
    bw = 0.27

    # -------- Top: wall time --------
    ax_time.bar(x - bw, claude_t, bw, label="Claude alone", color="#8b5cf6")
    ax_time.bar(x,       codex_t, bw, label="Codex alone",  color="#10b981")
    ax_time.bar(x + bw, council_t, bw, label="Council (workers ‖ + synth)", color="#d97706")
    ax_time.set_ylabel("Wall time (sec)")
    ax_time.set_title("Cost: wall-clock seconds per turn")
    ax_time.set_xticks(x)
    ax_time.set_xticklabels(labels, rotation=15, ha="right")
    ax_time.grid(True, axis="y", alpha=0.3)
    ax_time.legend(loc="upper left", fontsize=9)
    for i, v in enumerate(council_t):
        ax_time.text(i + bw, v + 0.5, f"{v:.0f}s", ha="center", fontsize=8, color="#d97706")

    # -------- Middle: quality --------
    ax_qual.bar(x - bw, claude_q, bw, color="#8b5cf6")
    ax_qual.bar(x,       codex_q, bw, color="#10b981")
    ax_qual.bar(x + bw, council_q, bw, color="#d97706")
    ax_qual.set_ylabel("Quality score (0-10)")
    ax_qual.set_title("Value: subjective quality after manually reading every output")
    ax_qual.set_ylim(0, 10)
    ax_qual.set_xticks(x)
    ax_qual.set_xticklabels(labels, rotation=15, ha="right")
    ax_qual.grid(True, axis="y", alpha=0.3)
    for i in range(len(labels)):
        delta = council_q[i] - max(claude_q[i], codex_q[i])
        sign = "+" if delta > 0 else ("=" if delta == 0 else "")
        color = "#16a34a" if delta > 0 else ("#666" if delta == 0 else "#dc2626")
        ax_qual.text(i + bw, council_q[i] + 0.15, f"{sign}{delta} vs better solo",
                     ha="center", fontsize=8, color=color, fontweight="bold")

    # -------- Bottom: value-per-second (efficiency) --------
    # Quality lift over best-of-solo, divided by extra wall time vs best solo.
    # Negative means council was slower AND no better; positive means real lift.
    extra_time = []
    quality_lift = []
    for i, _id in enumerate(ids):
        best_solo_t = min(claude_t[i], codex_t[i])
        best_solo_q = max(claude_q[i], codex_q[i])
        extra_time.append(council_t[i] - best_solo_t)
        quality_lift.append(council_q[i] - best_solo_q)

    colors = ["#16a34a" if q > 0 else "#dc2626" if q == 0 and e > 0 else "#6b7280"
              for q, e in zip(quality_lift, extra_time)]
    ax_value.bar(x, quality_lift, color=colors, width=0.55)
    ax_value.set_ylabel("Quality lift (council vs best solo)")
    ax_value.set_title("Value-add: did the council answer beat the better solo?")
    ax_value.set_xticks(x)
    ax_value.set_xticklabels(labels, rotation=15, ha="right")
    ax_value.axhline(0, color="black", linewidth=0.8)
    ax_value.grid(True, axis="y", alpha=0.3)
    ax_value.set_ylim(-1, 3)
    for i, (q, e) in enumerate(zip(quality_lift, extra_time)):
        verdict = "WIN" if q > 0 else ("WASH" if q == 0 else "LOSS")
        ax_value.text(i, q + 0.15 if q >= 0 else q - 0.3,
                      f"{verdict}\n+{e:.0f}s", ha="center", fontsize=8,
                      color="#16a34a" if q > 0 else "#6b7280",
                      fontweight="bold" if q > 0 else "normal")

    legend_patches = [
        Patch(color="#16a34a", label="Council wins (quality > best solo)"),
        Patch(color="#6b7280", label="Council = best solo (no lift, extra time wasted)"),
        Patch(color="#dc2626", label="Council loses (rare)"),
    ]
    ax_value.legend(handles=legend_patches, loc="upper left", fontsize=8)

    plt.savefig(CHART_PATH, dpi=110, bbox_inches="tight")
    print(f"Saved chart: {CHART_PATH}")


if __name__ == "__main__":
    main()
