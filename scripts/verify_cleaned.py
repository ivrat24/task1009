#!/usr/bin/env python3
"""Secondary verification of cleaned sessions vs parquet / raw transcripts."""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLEAN = ROOT / "data" / "cleaned" / "sessions.jsonl"
PARQUET = ROOT / "data" / "raw" / "parquet" / "conversations.parquet"
RAW = ROOT / "data" / "raw" / "transcripts"
REPORT = ROOT / "data" / "cleaned" / "verify_report.json"


def main() -> int:
    if not CLEAN.exists():
        print("missing", CLEAN)
        return 1

    sessions = []
    with CLEAN.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                sessions.append(json.loads(line))

    role_c: Counter[str] = Counter()
    type_c: Counter[str] = Counter()
    no_asst = []
    empty_asst = 0
    short_asst = 0
    for s in sessions:
        turns = s.get("turns") or []
        assts = [t for t in turns if t.get("role") == "assistant"]
        if not assts:
            no_asst.append(s["session_id"])
        for t in turns:
            role_c[str(t.get("role"))] += 1
            type_c[str(t.get("turn_type"))] += 1
            if t.get("role") == "assistant":
                n = len(str(t.get("content") or "").strip())
                if n == 0:
                    empty_asst += 1
                elif n < 20:
                    short_asst += 1

    report: dict = {
        "cleaned_sessions": len(sessions),
        "user_prompts": sum(s.get("user_prompt_count") or 0 for s in sessions),
        "role_counts": dict(role_c),
        "top_turn_types": type_c.most_common(20),
        "sessions_without_assistant": len(no_asst),
        "empty_assistant_turns": empty_asst,
        "short_assistant_turns_lt20": short_asst,
        "first_session_id": sessions[0]["session_id"] if sessions else None,
        "last_session_id": sessions[-1]["session_id"] if sessions else None,
    }

    if PARQUET.exists():
        import pandas as pd

        df = pd.read_parquet(
            PARQUET,
            columns=["session_id", "role", "turn_type", "is_conversational", "content"],
        )
        pq_asst_resp = int(
            ((df["role"] == "assistant") & (df["turn_type"] == "assistant_response")).sum()
        )
        pq_asst_think = int(
            ((df["role"] == "assistant") & (df["turn_type"] == "assistant_thinking")).sum()
        )
        cleaned_resp = type_c.get("assistant_response", 0)
        cleaned_think = type_c.get("assistant_thinking", 0)
        report["parquet_assistant_response"] = pq_asst_resp
        report["parquet_assistant_thinking"] = pq_asst_think
        report["cleaned_assistant_response"] = cleaned_resp
        report["cleaned_assistant_thinking"] = cleaned_think
        report["assistant_response_coverage"] = (
            None if pq_asst_resp == 0 else round(cleaned_resp / pq_asst_resp, 4)
        )
        report["assistant_thinking_coverage"] = (
            None if pq_asst_think == 0 else round(cleaned_think / pq_asst_think, 4)
        )

    if RAW.exists():
        report["raw_transcript_files"] = sum(1 for _ in RAW.glob("*.jsonl"))

    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"wrote {REPORT}")

    # Soft pass criteria
    ok = True
    if report["cleaned_sessions"] < 5000:
        print("FAIL: expected ~5795 sessions")
        ok = False
    cov = report.get("assistant_response_coverage")
    if cov is not None and cov < 0.99:
        print("FAIL: assistant_response coverage < 99%")
        ok = False
    think = report.get("assistant_thinking_coverage")
    if think is not None and think < 0.99:
        print("FAIL: assistant_thinking coverage < 99% (should keep thinking)")
        ok = False
    if ok:
        print("PASS: secondary verification OK")
        return 0
    print("FAIL: see report")
    return 2


if __name__ == "__main__":
    sys.exit(main())
