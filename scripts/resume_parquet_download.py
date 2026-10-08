#!/usr/bin/env python3
"""Resume-download conversations.parquet with HTTP Range + auto-retry."""

from __future__ import annotations

import shutil
import time
from pathlib import Path

import httpx
from huggingface_hub import hf_hub_url, get_token
from huggingface_hub.utils import build_hf_headers

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / "data" / "raw" / "parquet"
DL = LOCAL / ".cache" / "huggingface" / "download"
EXPECTED = 6424352043
DEST = LOCAL / "conversations.parquet"


def main() -> None:
    LOCAL.mkdir(parents=True, exist_ok=True)
    DL.mkdir(parents=True, exist_ok=True)

    if DEST.exists() and DEST.stat().st_size == EXPECTED:
        print("already complete", DEST, flush=True)
        return

    incs = sorted(DL.glob("*.incomplete"), key=lambda p: p.stat().st_size, reverse=True)
    if incs:
        inc = incs[0]
        # drop competing smaller incompletes
        for p in incs[1:]:
            print("remove small incomplete", p.name, p.stat().st_size, flush=True)
            p.unlink(missing_ok=True)
    else:
        inc = DL / "conversations.parquet.manual.incomplete"
        inc.touch()

    url = hf_hub_url("SALT-NLP/SWE-chat", "conversations.parquet", repo_type="dataset")
    attempt = 0
    while True:
        start = inc.stat().st_size
        if start >= EXPECTED:
            break
        attempt += 1
        remain = EXPECTED - start
        print(
            f"attempt={attempt} resume_from={start} remain_mb={remain/1e6:.1f} pct={100*start/EXPECTED:.1f}",
            flush=True,
        )
        headers = build_hf_headers(token=get_token())
        headers["Range"] = f"bytes={start}-"
        try:
            with httpx.stream(
                "GET",
                url,
                headers=headers,
                timeout=httpx.Timeout(1800.0, connect=60.0),
                follow_redirects=True,
            ) as r:
                print(
                    "status",
                    r.status_code,
                    "content-range",
                    r.headers.get("content-range"),
                    flush=True,
                )
                if r.status_code == 200:
                    raise SystemExit("server ignored Range; refuse overwrite")
                r.raise_for_status()
                written = start
                with open(inc, "ab") as f:
                    for chunk in r.iter_bytes(1024 * 1024):
                        f.write(chunk)
                        written += len(chunk)
                        if written // (50 * 1024 * 1024) != (written - len(chunk)) // (
                            50 * 1024 * 1024
                        ):
                            print(
                                f"progress_mb={written/1e6:.1f} pct={100*written/EXPECTED:.1f}",
                                flush=True,
                            )
            print("stream ended size", inc.stat().st_size, flush=True)
        except Exception as e:
            print(f"interrupted: {type(e).__name__}: {e}", flush=True)
            time.sleep(min(60, 2 + attempt))
            continue

    final = inc.stat().st_size
    if final != EXPECTED:
        raise SystemExit(f"size mismatch {final} != {EXPECTED}")
    if DEST.exists():
        DEST.unlink()
    shutil.move(str(inc), str(DEST))
    print("OK", DEST, DEST.stat().st_size, flush=True)


if __name__ == "__main__":
    main()
