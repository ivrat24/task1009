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
    return True


def convert(
    conversations_path: Path,
    cleaned_dir: Path,
    *,
    conversational_only: bool,
    max_sessions: int | None,
) -> None:
    import pandas as pd

    print(f"reading {conversations_path} …")
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

    if conversational_only and "is_conversational" in df.columns:
        df = df[df["is_conversational"] == True]  # noqa: E712
    else:
        df = df[~df["turn_type"].astype(str).isin(SKIP_TYPES)]

    df = df.sort_values(["session_id", "turn_number"])
    sessions: dict[str, dict] = {}
    for sid, g in df.groupby("session_id", sort=True):
        turns = []
        for row in g.itertuples(index=False):
            content = row.content
            if content is None or (isinstance(content, float) and pd.isna(content)):
                continue
            content = str(content)
            if not content.strip():
                continue
            role = str(row.role)
            turn_type = str(row.turn_type)
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
        upc = sum(1 for t in turns if is_labelable(t["role"], t["turn_type"]))
        if upc < 1:
            continue
        sessions[str(sid)] = {
            "session_id": str(sid),
            "source_file": "conversations.parquet",
            "meta": {},
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
    (cleaned_dir / "sessions.js").write_text(
        "window.CLEANED_SESSIONS = " + json.dumps(sessions_list, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )
    prompts = sum(s["user_prompt_count"] for s in sessions_list)
    print(f"sessions={len(sessions_list)} user_prompts={prompts}")
    print(f"wrote {out_jsonl}")
    print(f"wrote {cleaned_dir / 'sessions.js'}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-sessions", type=int, default=None, help="Optional cap for smoke tests")
    ap.add_argument("--keep-tools", action="store_true", help="Keep non-conversational turns")
    ap.add_argument("--skip-download", action="store_true", help="Use already downloaded parquet")
    args = ap.parse_args()

    ensure_deps()
    conv = RAW / "conversations.parquet"
    if not args.skip_download or not conv.exists():
        download_parquets(["conversations.parquet", "sessions.parquet"])
        conv = RAW / "conversations.parquet"
    convert(
        conv,
        CLEAN,
        conversational_only=not args.keep_tools,
        max_sessions=args.max_sessions,
    )


if __name__ == "__main__":
    main()
