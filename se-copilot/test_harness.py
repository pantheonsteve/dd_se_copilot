#!/usr/bin/env python3
"""
Iterate on Support Admin Copilot prompts without driving the browser.

Usage:
    python test_harness.py screenshots/service_catalog_01.png service_catalog \\
        --prompt "What observability gaps do you see?"

SE Copilot must be running (default http://localhost:5070).
"""

from __future__ import annotations

import argparse
import base64
import sys
from pathlib import Path

import httpx


def load_image_as_data_url(path: Path) -> str:
    ext = path.suffix.lower().lstrip(".") or "png"
    media = f"image/{'jpeg' if ext in ('jpg', 'jpeg') else ext}"
    b64 = base64.b64encode(path.read_bytes()).decode()
    return f"data:{media};base64,{b64}"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("image", type=Path, help="Path to screenshot PNG/JPG")
    p.add_argument("page_type", help="Page type (e.g. service_catalog, monitors_list)")
    p.add_argument("--prompt", default="What am I looking at? Identify observability gaps.")
    p.add_argument("--url", default="https://app.datad0g.com/services")
    p.add_argument(
        "--backend",
        default="http://localhost:5070/api/sac",
        help="Base URL for SAC routes (no trailing slash)",
    )
    p.add_argument("--account", default=None, help="Account name for grounding (optional)")
    args = p.parse_args()

    if not args.image.exists():
        print(f"Image not found: {args.image}", file=sys.stderr)
        return 2

    data_url = load_image_as_data_url(args.image)

    payload = {
        "prompt": args.prompt,
        "image": data_url,
        "pageContext": {
            "url": args.url,
            "pageType": args.page_type,
            "title": f"Test — {args.page_type}",
            "headings": [],
            "filters": [],
            "entityRows": [],
        },
        "history": [],
    }

    url = f"{args.backend.rstrip('/')}/analyze"
    print(f"→ POST {url} (image {args.image.stat().st_size // 1024} KB, page_type={args.page_type})")
    with httpx.Client(timeout=120.0) as c:
        r = c.post(url, json=payload)
    if r.status_code != 200:
        print(f"ERROR {r.status_code}: {r.text}", file=sys.stderr)
        return 1

    data = r.json()
    print("\n" + "=" * 70)
    print("ANALYSIS")
    print("=" * 70)
    print(data.get("text", "(no text)"))
    print("\n" + "=" * 70)
    print("STRUCTURED OBSERVATIONS")
    print("=" * 70)
    for o in data.get("observations", []):
        print(f"  • {o}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
