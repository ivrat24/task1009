#!/usr/bin/env python3
"""Normalize messy SWE-chat / agent transcripts into cleaned session JSONL.

Input (any mix):
  - conversations.parquet-style JSONL rows (session_id, role, turn_type, content, ...)
  - raw transcript JSONL / JSON (Claude Code / Cursor-like event streams)
  - already-cleaned session objects

Output:
  data/cleaned/sessions.jsonl   one session object per line
  data/cleaned/index.json       lightweight file list for the annotator UI

Usage:
  python scripts/normalize_transcripts.py data/raw -o data/cleaned
  python scripts/normalize_transcripts.py path/to/one.jsonl -o data/cleaned
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any


USERISH = {"user", "human", "developer"}
ASSISTISH = {"assistant", "model", "ai", "bot"}
SKIP_TYPES = {
    "progress",
    "queue_operation",
    "file_snapshot",
    "system_event",
    "summary",
}


def read_json_or_jsonl(path: Path) -> list[Any]:
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if not text:
        return []
    if path.suffix.lower() == ".json":
        obj = json.loads(text)
        if isinstance(obj, list):
            return obj
        if isinstance(obj, dict):
            # common wrappers
            for key in ("turns", "messages", "events", "conversation", "items"):
                if isinstance(obj.get(key), list):
                    return obj[key] if key != "conversation" else [obj]
            return [obj]
        return []
    rows: list[Any] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or not line.startswith(("{", "[")):
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def infer_role(row: dict[str, Any]) -> str | None:
    role = str(row.get("role") or row.get("speaker") or row.get("author") or "").lower()
    if role in USERISH:
        return "user"
    if role in ASSISTISH:
        return "assistant"
    if role in {"tool", "tool_result", "function"}:
        return "tool"
    if role == "system":
        return "system"

    t = str(row.get("turn_type") or row.get("type") or row.get("kind") or "").lower()
    if "user" in t or t in {"human", "prompt", "user_prompt"}:
        return "user"
    if "assistant" in t or t in {"response", "assistant_response", "ai"}:
        return "assistant"
    if "tool" in t:
        return "tool"
    if "think" in t:
        return "assistant"
    return None


def infer_turn_type(row: dict[str, Any], role: str | None) -> str:
    t = str(row.get("turn_type") or row.get("type") or row.get("kind") or "").lower()
    if t:
        return t
    if role == "user":
        return "user_prompt"
    if role == "assistant":
        return "assistant_response"
    if role == "tool":
        return "tool_result"
    return "unknown"


def extract_content(row: dict[str, Any]) -> str:
    def from_blocks(val: Any) -> str:
        if isinstance(val, str):
            return val
        if not isinstance(val, list):
            return ""
        parts: list[str] = []
        for item in val:
            if isinstance(item, str):
                parts.append(item)
                continue
            if not isinstance(item, dict):
                continue
            t = str(item.get("type") or "")
            if t == "text" or item.get("text"):
                parts.append(str(item.get("text") or item.get("content") or ""))
            elif t == "thinking" or item.get("thinking"):
                # Preserve agent thinking so replies are not "empty" after tool-only turns.
                th = str(item.get("thinking") or item.get("content") or "")
                if th.strip():
                    parts.append(th)
            elif t == "tool_use":
                name = item.get("name") or "tool"
                inp = item.get("input")
                preview = ""
                if isinstance(inp, dict):
                    preview = str(inp.get("command") or inp.get("path") or inp.get("query") or "")[:200]
                elif isinstance(inp, str):
                    preview = inp[:200]
                parts.append(f"[tool_use:{name}] {preview}".rstrip())
            else:
                parts.append(str(item.get("text") or item.get("content") or ""))
        return "\n".join(p for p in parts if str(p).strip())

    for key in ("content", "text", "prompt", "output", "result"):
        val = row.get(key)
        if isinstance(val, str) and val.strip():
            return val
        joined = from_blocks(val)
        if joined.strip():
            return joined
    # Claude-ish nested message
    msg = row.get("message")
    if isinstance(msg, dict):
        return extract_content(msg)
    return ""


def compact_tool(content: str, max_len: int = 800) -> str:
    s = content.strip()
    if len(s) <= max_len:
        return s
    return s[: max_len - 1] + "…"


def session_id_of(row: dict[str, Any], fallback: str) -> str:
    for key in ("session_id", "sessionId", "conversation_id", "id"):
        val = row.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return fallback


def rows_to_sessions(rows: list[Any], source_name: str) -> dict[str, dict[str, Any]]:
    """Group heterogeneous rows into session objects."""
    # Case A: already cleaned session objects
    if rows and isinstance(rows[0], dict) and isinstance(rows[0].get("turns"), list):
        out = {}
        for i, ep in enumerate(rows):
            sid = str(ep.get("session_id") or f"{source_name}#{i}")
            out[sid] = normalize_session_obj(ep, source_name)
        return out

    # Case B: flat conversation rows
    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    fallback = Path(source_name).stem
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        # nested session wrapper
        if isinstance(row.get("turns"), list) or isinstance(row.get("messages"), list):
            sid = session_id_of(row, f"{fallback}#{i}")
            buckets[sid].append(row)
            continue
        sid = session_id_of(row, fallback)
        buckets[sid].append(row)

    sessions: dict[str, dict[str, Any]] = {}
    for sid, items in buckets.items():
        if len(items) == 1 and (
            isinstance(items[0].get("turns"), list) or isinstance(items[0].get("messages"), list)
        ):
            sessions[sid] = normalize_session_obj(items[0], source_name)
            continue
        turns = []
        for idx, row in enumerate(items):
            role = infer_role(row)
            turn_type = infer_turn_type(row, role)
            if turn_type in SKIP_TYPES:
                continue
            content = extract_content(row)
            if not content.strip():
                continue
            if role == "tool" or "tool" in turn_type:
                content = compact_tool(content)
                role = role or "tool"
            if role is None:
                # keep unknown but mark
                role = "system"
            turn_number = row.get("turn_number")
            if not isinstance(turn_number, int):
                turn_number = idx
            turn_id = str(row.get("turn_id") or f"{sid}#{turn_number}")
            turns.append(
                {
                    "turn_id": turn_id,
                    "turn_number": turn_number,
                    "conversation_turn_number": row.get("conversation_turn_number"),
                    "role": role,
                    "turn_type": turn_type,
                    "is_conversational": bool(
                        row.get("is_conversational")
                        if "is_conversational" in row
                        else role in {"user", "assistant"} and "tool" not in turn_type and "think" not in turn_type
                    ),
                    "content": content,
                }
            )
        turns.sort(key=lambda t: (t["turn_number"], t["turn_id"]))
        sessions[sid] = {
            "session_id": sid,
            "source_file": source_name,
            "meta": {},
            "turns": turns,
            "user_prompt_count": sum(1 for t in turns if is_labelable(t)),
        }
    return sessions


def is_labelable(turn: dict[str, Any]) -> bool:
    if turn.get("role") != "user":
        return False
    t = str(turn.get("turn_type") or "").lower()
    if t in SKIP_TYPES:
        return False
    if "tool" in t:
        return False
    # treat plain user / user_prompt as label targets
    return True


def normalize_session_obj(obj: dict[str, Any], source_name: str) -> dict[str, Any]:
    sid = str(obj.get("session_id") or obj.get("id") or Path(source_name).stem)
    raw_turns = obj.get("turns") or obj.get("messages") or []
    turns = []
    for idx, row in enumerate(raw_turns):
        if not isinstance(row, dict):
            continue
        role = infer_role(row) or str(row.get("role") or "system").lower()
        if role in USERISH:
            role = "user"
        elif role in ASSISTISH:
            role = "assistant"
        turn_type = infer_turn_type(row, role)
        if turn_type in SKIP_TYPES:
            continue
        content = extract_content(row)
        if not content.strip():
            continue
        if role == "tool" or "tool" in turn_type:
            content = compact_tool(content)
        turn_number = row.get("turn_number") if isinstance(row.get("turn_number"), int) else idx
        turns.append(
            {
                "turn_id": str(row.get("turn_id") or f"{sid}#{turn_number}"),
                "turn_number": turn_number,
                "conversation_turn_number": row.get("conversation_turn_number"),
                "role": role,
                "turn_type": turn_type,
                "is_conversational": bool(
                    row.get("is_conversational")
                    if "is_conversational" in row
                    else role in {"user", "assistant"}
                ),
                "content": content,
            }
        )
    turns.sort(key=lambda t: (t["turn_number"], t["turn_id"]))
    return {
        "session_id": sid,
        "source_file": source_name,
        "meta": obj.get("meta") or {},
        "turns": turns,
        "user_prompt_count": sum(1 for t in turns if is_labelable(t)),
    }


def collect_input_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    files = []
    for p in sorted(path.rglob("*")):
        if p.is_file() and p.suffix.lower() in {".json", ".jsonl", ".jsonl.txt"}:
            files.append(p)
    return files


def main() -> None:
    ap = argparse.ArgumentParser(description="Normalize transcripts for intention annotation")
    ap.add_argument("input", type=Path, help="Raw file or directory")
    ap.add_argument("-o", "--out", type=Path, default=Path("data/cleaned"))
    ap.add_argument(
        "--min-user-prompts",
        type=int,
        default=1,
        help="Drop sessions with fewer than N labelable user prompts",
    )
    ap.add_argument(
        "--conversational-only",
        action="store_true",
        help="Keep only user_prompt / assistant_response turns in cleaned output",
    )
    args = ap.parse_args()

    files = collect_input_files(args.input)
    if not files:
        raise SystemExit(f"No json/jsonl files under {args.input}")

    merged: dict[str, dict[str, Any]] = {}
    for fp in files:
        rel = str(fp)
        rows = read_json_or_jsonl(fp)
        part = rows_to_sessions(rows, rel)
        for sid, sess in part.items():
            if sid in merged:
                # avoid clobber: suffix
                sid2 = f"{sid}::{Path(fp).stem}"
                sess = dict(sess)
                sess["session_id"] = sid2
                merged[sid2] = sess
            else:
                merged[sid] = sess

    cleaned = []
    for sid, sess in sorted(merged.items(), key=lambda kv: kv[0]):
        turns = sess["turns"]
        if args.conversational_only:
            turns = [
                t
                for t in turns
                if t.get("role") in {"user", "assistant"}
                and "tool" not in str(t.get("turn_type") or "").lower()
                and "think" not in str(t.get("turn_type") or "").lower()
            ]
            # re-number display order only; keep ids
            sess = dict(sess)
            sess["turns"] = turns
        sess["user_prompt_count"] = sum(1 for t in sess["turns"] if is_labelable(t))
        if sess["user_prompt_count"] < args.min_user_prompts:
            continue
        cleaned.append(sess)

    args.out.mkdir(parents=True, exist_ok=True)
    out_sessions = args.out / "sessions.jsonl"
    with out_sessions.open("w", encoding="utf-8") as f:
        for sess in cleaned:
            f.write(json.dumps(sess, ensure_ascii=False) + "\n")

    index = [
        {
            "session_id": s["session_id"],
            "source_file": s.get("source_file"),
            "user_prompt_count": s.get("user_prompt_count", 0),
            "turn_count": len(s.get("turns") or []),
        }
        for s in cleaned
    ]
    (args.out / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # also emit a browser-friendly JS bundle optional for file:// usage
    js = "window.CLEANED_SESSIONS = " + json.dumps(cleaned, ensure_ascii=False) + ";\n"
    (args.out / "sessions.js").write_text(js, encoding="utf-8")

    total_prompts = sum(s["user_prompt_count"] for s in cleaned)
    print(f"files={len(files)} sessions={len(cleaned)} user_prompts={total_prompts}")
    print(f"wrote {out_sessions}")
    print(f"wrote {args.out / 'index.json'}")
    print(f"wrote {args.out / 'sessions.js'}")


if __name__ == "__main__":
    main()
