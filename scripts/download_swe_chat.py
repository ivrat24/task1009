#!/usr/bin/env python3
"""Download SALT-NLP/SWE-chat transcripts and normalize into the annotator format.

Dataset (gated): https://huggingface.co/datasets/SALT-NLP/SWE-chat/tree/main/transcripts

Prereqs:
  1) Open the dataset page, accept access conditions while logged in.
  2) Authenticate locally:
       hf auth login
     (or set HF_TOKEN / HUGGING_FACE_HUB_TOKEN)

Examples:
  python scripts/download_swe_chat.py --limit 100
  python scripts/download_swe_chat.py --all
  python scripts/download_swe_chat.py --limit 100 --seed 42 --conversational-only
"""

from __future__ import annotations

import argparse
import random
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw" / "transcripts"
CLEAN_DIR = ROOT / "data" / "cleaned"


def ensure_hub():
    try:
        import huggingface_hub  # noqa: F401
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-U", "huggingface_hub"])


def check_auth() -> None:
    from huggingface_hub import HfApi, get_token

    token = get_token()
    if not token:
        raise SystemExit(
            "未检测到 Hugging Face 登录状态。\n"
            "请先：\n"
            "  1) 浏览器打开并接受条款：https://huggingface.co/datasets/SALT-NLP/SWE-chat\n"
            "  2) 本机执行：hf auth login\n"
            "然后重新运行本脚本。"
        )
    api = HfApi()
    try:
        who = api.whoami(token=token)
        name = who.get("name") or who.get("fullname") or who
        print(f"HF logged in as: {name}")
    except Exception as e:
        raise SystemExit(f"HF token 无效或过期：{e}\n请重新执行 hf auth login") from e


def list_transcript_files() -> list[str]:
    from huggingface_hub import list_repo_files

    files = list_repo_files("SALT-NLP/SWE-chat", repo_type="dataset")
    return sorted(f for f in files if f.startswith("transcripts/") and f.endswith((".jsonl", ".json")))


def download_files(
    rel_paths: list[str],
    local_dir: Path,
    *,
    retries: int = 5,
    skip_existing: bool = True,
) -> tuple[list[Path], list[str]]:
    """Per-file download with retries; continues on individual failures."""
    import os
    import time

    from huggingface_hub import hf_hub_download

    # Xet/CAS reconstruction errors are common on large trees; fall back to classic HTTP.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    # Large transcript jsonl can exceed default read timeout.
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "600")

    local_dir.mkdir(parents=True, exist_ok=True)
    out: list[Path] = []
    failed: list[str] = []
    total = len(rel_paths)
    for i, rel in enumerate(rel_paths, 1):
        dest = local_dir / Path(rel).name
        if skip_existing and dest.exists() and dest.stat().st_size > 0:
            if i % 200 == 0 or i == total:
                print(f"[{i}/{total}] skip existing {dest.name}")
            out.append(dest)
            continue

        ok = False
        last_err: Exception | None = None
        for attempt in range(1, retries + 1):
            try:
                print(f"[{i}/{total}] {rel} (try {attempt}/{retries})")
                p = hf_hub_download(
                    repo_id="SALT-NLP/SWE-chat",
                    filename=rel,
                    repo_type="dataset",
                    local_dir=str(local_dir.parent),  # writes under data/raw/transcripts/...
                )
                out.append(Path(p))
                ok = True
                break
            except Exception as e:
                last_err = e
                wait = min(60, 2 ** attempt)
                print(f"  fail: {type(e).__name__}: {e}")
                print(f"  retry in {wait}s")
                time.sleep(wait)
        if not ok:
            print(f"  GIVE UP: {rel} ({last_err})")
            failed.append(rel)
    return out, failed


def download_snapshot(local_dir: Path) -> Path:
    import os

    from huggingface_hub import snapshot_download

    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    local_dir.mkdir(parents=True, exist_ok=True)
    path = snapshot_download(
        repo_id="SALT-NLP/SWE-chat",
        repo_type="dataset",
        allow_patterns=["transcripts/*"],
        local_dir=str(local_dir.parent),
        max_workers=4,
    )
    return Path(path)


def normalize(raw: Path, cleaned: Path, conversational_only: bool) -> None:
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "normalize_transcripts.py"),
        str(raw),
        "-o",
        str(cleaned),
    ]
    if conversational_only:
        cmd.append("--conversational-only")
    print("normalize:", " ".join(cmd))
    subprocess.check_call(cmd)


def main() -> None:
    ap = argparse.ArgumentParser(description="Download + import SWE-chat transcripts")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--all", action="store_true", help="Download all transcripts (large)")
    g.add_argument(
        "--limit",
        type=int,
        default=100,
        help="Randomly download N transcript files (default 100, matches gold-label plan)",
    )
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument(
        "--snapshot",
        action="store_true",
        help="Use snapshot_download for the whole transcripts/ tree (implies --all)",
    )
    ap.add_argument(
        "--conversational-only",
        action="store_true",
        default=True,
        help="Drop tool/thinking noise when normalizing (default on)",
    )
    ap.add_argument(
        "--keep-tools",
        action="store_true",
        help="Keep tool/thinking turns in cleaned output",
    )
    ap.add_argument("--skip-normalize", action="store_true")
    args = ap.parse_args()

    ensure_hub()
    check_auth()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    conversational = not args.keep_tools

    files = list_transcript_files()
    print(f"Remote transcripts available: {len(files)}")

    if args.snapshot:
        print("Downloading full transcripts/ tree via snapshot_download …")
        download_snapshot(RAW_DIR)
        failed: list[str] = []
    elif args.all:
        print(f"Resume-safe download of all {len(files)} transcripts …")
        _, failed = download_files(files, RAW_DIR)
    else:
        rng = random.Random(args.seed)
        chosen = files[:]
        rng.shuffle(chosen)
        chosen = chosen[: max(0, args.limit)]
        print(f"Downloading {len(chosen)} files (seed={args.seed})")
        _, failed = download_files(chosen, RAW_DIR)

    target = RAW_DIR
    if failed:
        fail_path = ROOT / "data" / "download_failed.txt"
        fail_path.write_text("\n".join(failed) + "\n", encoding="utf-8")
        print(f"WARNING: {len(failed)} files failed; listed in {fail_path}")
        print("Re-run the same command to retry missing files.")

    if not args.skip_normalize:
        normalize(target, CLEAN_DIR, conversational_only=conversational)
        print("Done. Open annotator and refresh, or re-import data/cleaned/sessions.jsonl")
        print(f"  cleaned: {CLEAN_DIR / 'sessions.jsonl'}")
        print(f"  bundle : {CLEAN_DIR / 'sessions.js'}")
    else:
        print(f"Raw files ready under {target}")


if __name__ == "__main__":
    main()
