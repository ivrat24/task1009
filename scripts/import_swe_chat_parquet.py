#!/usr/bin/env python3
"""Download SWE-chat parquet tables and convert into cleaned sessions for the annotator.

Faster than pulling 5k+ raw transcript jsonl files.
Requires: pandas, pyarrow, huggingface_hub (and HF auth + gated access).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# Must be set before huggingface_hub import / download path selection.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "600")
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "0")

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "parquet"
CLEAN = ROOT / "data" / "cleaned"

SKIP_TYPES = {
    "progress",
    "queue_operation",
    "file_snapshot",
    "system_event",
    "summary",
}


def ensure_deps() -> None:
    try:
        import pandas  # noqa: F401
        import pyarrow  # noqa: F401
        import huggingface_hub  # noqa: F401
    except ImportError:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-U", "pandas", "pyarrow", "huggingface_hub"]
        )


def download_parquets(files: list[str]) -> dict[str, Path]:
    import time

    from huggingface_hub import hf_hub_download, get_token, HfApi

    # Avoid stale proxy settings from shell / system that break TLS.
    for k in list(os.environ):
        if "PROXY" in k.upper():
            os.environ.pop(k, None)

    token = get_token()
    if not token:
        raise SystemExit("未登录 HF，请先 hf auth login")

    for attempt in range(1, 6):
        try:
            print("HF:", HfApi().whoami(token=token).get("name"), flush=True)
            break
        except Exception as e:
            print(f"whoami fail try {attempt}: {e}", flush=True)
            time.sleep(2 ** attempt)
    else:
        raise SystemExit("无法连接 Hugging Face API")

    print("HF_HUB_DISABLE_XET=", os.environ.get("HF_HUB_DISABLE_XET"), flush=True)

    RAW.mkdir(parents=True, exist_ok=True)
    out: dict[str, Path] = {}
    for name in files:
        print(f"download {name} …", flush=True)
        last_err: Exception | None = None
        for attempt in range(1, 8):
            try:
                p = hf_hub_download(
                    "SALT-NLP/SWE-chat",
                    name,
                    repo_type="dataset",
                    local_dir=str(RAW),
                    force_download=False,
                )
                out[name] = Path(p)
                print(f"  -> {p} ({Path(p).stat().st_size} bytes)", flush=True)
                break
            except Exception as e:
                last_err = e
                wait = min(90, 2 ** attempt)
                print(f"  fail try {attempt}: {type(e).__name__}: {e}", flush=True)
                print(f"  sleep {wait}s", flush=True)
                time.sleep(wait)
        else:
            raise SystemExit(f"下载失败 {name}: {last_err}")
    return out


def is_labelable(role: str, turn_type: str) -> bool:
    if str(role).lower() != "user":
        return False
    t = str(turn_type or "").lower()
    if t in SKIP_TYPES or "tool" in t:
        return False
    # Only real user prompts — not system_injected / meta user rows.
    if t in {"system_injected", "system", "meta"}:
        return False
    return t in {"user_prompt", "user", "human", "prompt", ""} or "user" in t


def keep_turn(role: str, turn_type: str, *, mode: str) -> bool:
    """mode: conversational | assistant_full | all_except_skip"""
    role = str(role).lower()
    t = str(turn_type or "").lower()
    if t in SKIP_TYPES:
        return False
    if t == "system_injected":
        return False
    if mode == "all_except_skip":
        return True
    if role == "user":
        # Keep labelable user prompts only (matches prior conversational user set).
        return t in {"user_prompt", "user", "human", "prompt"} or (
            "user" in t and "tool" not in t and "inject" not in t
        )
    if role == "assistant":
        # Keep visible replies AND thinking — previous default dropped thinking (~12k).
        if mode == "conversational":
            return t in {"assistant_response", "response", "assistant"} or (
                "think" not in t and "tool" not in t
            )
        # assistant_full (default): all assistant rows including assistant_thinking
        return True
    return False


def convert(
    conversations_path: Path,
    cleaned_dir: Path,
    *,
    mode: str,
    max_sessions: int | None,
    write_js: bool,
) -> dict:
    import pandas as pd

    print(f"reading {conversations_path} …", flush=True)
    df = pd.read_parquet(conversations_path)
    needed = [
        "session_id",
        "turn_id",
        "turn_number",
        "conversation_turn_number",
        "role",
        "turn_type",
        "is_conversational",
        "content",
    ]
    missing = [c for c in needed if c not in df.columns]
    if missing:
        raise SystemExit(f"conversations.parquet missing columns: {missing}; have={list(df.columns)}")

    df = df.sort_values(["session_id", "turn_number"])
    sessions: dict[str, dict] = {}
    stats = {
        "rows_in": int(len(df)),
        "rows_kept": 0,
        "assistant_response": 0,
        "assistant_thinking": 0,
        "user": 0,
        "other": 0,
        "skipped_empty": 0,
    }
    for sid, g in df.groupby("session_id", sort=True):
        turns = []
        for row in g.itertuples(index=False):
            role = str(row.role)
            turn_type = str(row.turn_type)
            if not keep_turn(role, turn_type, mode=mode):
                continue
            content = row.content
            if content is None or (isinstance(content, float) and pd.isna(content)):
                stats["skipped_empty"] += 1
                continue
            content = str(content)
            if not content.strip():
                stats["skipped_empty"] += 1
                continue
            turns.append(
                {
                    "turn_id": str(row.turn_id),
                    "turn_number": int(row.turn_number) if row.turn_number == row.turn_number else 0,
                    "conversation_turn_number": (
                        int(row.conversation_turn_number)
                        if row.conversation_turn_number == row.conversation_turn_number
                        else None
                    ),
                    "role": role,
                    "turn_type": turn_type,
                    "is_conversational": bool(getattr(row, "is_conversational", True)),
                    "content": content,
                }
            )
            stats["rows_kept"] += 1
            tl = turn_type.lower()
            if role == "user":
                stats["user"] += 1
            elif "think" in tl:
                stats["assistant_thinking"] += 1
            elif role == "assistant":
                stats["assistant_response"] += 1
            else:
                stats["other"] += 1
        upc = sum(1 for t in turns if is_labelable(t["role"], t["turn_type"]))
        if upc < 1:
            continue
        sessions[str(sid)] = {
            "session_id": str(sid),
            "source_file": "conversations.parquet",
            "meta": {"import_mode": mode},
            "turns": turns,
            "user_prompt_count": upc,
        }
        if max_sessions and len(sessions) >= max_sessions:
            break

    cleaned_dir.mkdir(parents=True, exist_ok=True)
    sessions_list = list(sessions.values())
    out_jsonl = cleaned_dir / "sessions.jsonl"
    with out_jsonl.open("w", encoding="utf-8") as f:
        for s in sessions_list:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    index = [
        {
            "session_id": s["session_id"],
            "source_file": s["source_file"],
            "user_prompt_count": s["user_prompt_count"],
            "turn_count": len(s["turns"]),
        }
        for s in sessions_list
    ]
    (cleaned_dir / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    if write_js:
        (cleaned_dir / "sessions.js").write_text(
            "window.CLEANED_SESSIONS = " + json.dumps(sessions_list, ensure_ascii=False) + ";\n",
            encoding="utf-8",
        )
        print(f"wrote {cleaned_dir / 'sessions.js'}", flush=True)
    else:
        print("skip sessions.js (use --write-js to emit ~140MB bundle)", flush=True)

    prompts = sum(s["user_prompt_count"] for s in sessions_list)
    asst_sessions = sum(
        1 for s in sessions_list if any(t.get("role") == "assistant" for t in s["turns"])
    )
    stats.update(
        {
            "sessions": len(sessions_list),
            "user_prompts": prompts,
            "sessions_with_assistant": asst_sessions,
            "sessions_without_assistant": len(sessions_list) - asst_sessions,
        }
    )
    print(
        f"sessions={stats['sessions']} user_prompts={prompts} "
        f"with_assistant={asst_sessions} without_assistant={stats['sessions_without_assistant']}",
        flush=True,
    )
    print(
        f"kept assistant_response={stats['assistant_response']} "
        f"assistant_thinking={stats['assistant_thinking']} user={stats['user']}",
        flush=True,
    )
    print(f"wrote {out_jsonl}", flush=True)
    (cleaned_dir / "import_report.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-sessions", type=int, default=None, help="Optional cap for smoke tests")
    ap.add_argument(
        "--mode",
        choices=("assistant_full", "conversational", "all_except_skip"),
        default="assistant_full",
        help="assistant_full=user+all assistant incl. thinking (default); "
        "conversational=old behavior; all_except_skip=also keep tools",
    )
    ap.add_argument("--keep-tools", action="store_true", help="Alias for --mode all_except_skip")
    ap.add_argument("--skip-download", action="store_true", help="Use already downloaded parquet")
    ap.add_argument("--force-download", action="store_true", help="Re-download parquet even if present")
    ap.add_argument("--write-js", action="store_true", help="Also write sessions.js (~140MB)")
    args = ap.parse_args()

    ensure_deps()
    mode = "all_except_skip" if args.keep_tools else args.mode
    conv = RAW / "conversations.parquet"
    if args.force_download or (not args.skip_download and not conv.exists()):
        # force: delete local copy first so hub re-pulls
        if args.force_download and conv.exists():
            print(f"removing {conv} for force download", flush=True)
            conv.unlink()
        download_parquets(["conversations.parquet", "sessions.parquet"])
        conv = RAW / "conversations.parquet"
    elif not conv.exists():
        download_parquets(["conversations.parquet", "sessions.parquet"])
        conv = RAW / "conversations.parquet"
    convert(
        conv,
        CLEAN,
        mode=mode,
        max_sessions=args.max_sessions,
        write_js=args.write_js,
    )


if __name__ == "__main__":
    main()
