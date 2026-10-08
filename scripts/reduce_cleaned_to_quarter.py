#!/usr/bin/env python3
"""Promote sessions_quarter.* to main cleaned files; archive previous full set."""

from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLEAN = ROOT / "data" / "cleaned"


def main() -> None:
    bak_dir = ROOT / "data" / f"cleaned_full_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    bak_dir.mkdir(parents=True, exist_ok=True)

    for name in ("sessions.jsonl", "sessions.js", "index.json"):
        p = CLEAN / name
        if p.exists():
            dest = bak_dir / name
            print(f"backup {p.name} -> {dest} ({p.stat().st_size / 1e6:.1f} MB)")
            shutil.move(str(p), str(dest))

    mapping = {
        "sessions_quarter.jsonl": "sessions.jsonl",
        "sessions_quarter.js": "sessions.js",
        "index_quarter.json": "index.json",
    }
    for src_name, dst_name in mapping.items():
        src = CLEAN / src_name
        dst = CLEAN / dst_name
        if not src.exists():
            raise SystemExit(f"missing {src}")
        shutil.move(str(src), str(dst))
        print(f"promote {src_name} -> {dst_name} ({dst.stat().st_size / 1e6:.1f} MB)")

    n = 0
    upc = 0
    roles: dict[str, int] = {}
    with_asst = 0
    with (CLEAN / "sessions.jsonl").open(encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            s = json.loads(line)
            n += 1
            upc += s.get("user_prompt_count") or 0
            turns = s.get("turns") or []
            has = False
            for t in turns:
                r = str(t.get("role"))
                roles[r] = roles.get(r, 0) + 1
                if r == "assistant":
                    has = True
            if has:
                with_asst += 1

    report = {
        "sessions": n,
        "user_prompts": upc,
        "role_counts": roles,
        "sessions_with_assistant": with_asst,
        "sessions_without_assistant": n - with_asst,
        "note": "Local cleaned corpus reduced to 1/4 of prior full import (every 4th session).",
        "subset_rule": "sessions[::4] from previous full cleaned set",
        "source": "promoted from sessions_quarter.*",
        "full_backup": str(bak_dir.relative_to(ROOT)),
    }
    (CLEAN / "import_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (CLEAN / "verify_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("FINAL", json.dumps(report, ensure_ascii=False, indent=2))
    print("cleaned files:", sorted(p.name for p in CLEAN.iterdir() if p.is_file()))


if __name__ == "__main__":
    main()
