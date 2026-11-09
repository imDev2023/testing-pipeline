"""Fetch X posts by id through the free api.fxtwitter.com endpoint and archive them.

Usage: python3 -I scripts/fetch_x_posts.py <ids.txt> <out.jsonl> <out.md> [title]

Each line of <ids.txt> is one post id.
Writes one JSON object per post to <out.jsonl> (the fxtwitter `tweet` object, unmodified)
and a readable, chronological Markdown rendering to <out.md>.
"""

import json
import sys
import time
import urllib.request
from pathlib import Path

API = "https://api.fxtwitter.com/i/status/{}"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) archive-script"}


def fetch(post_id: str) -> dict:
    for attempt in range(4):
        try:
            req = urllib.request.Request(API.format(post_id), headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp).get("tweet") or {"id": post_id, "error": "no tweet in response"}
        except Exception as exc:  # network resets happen; back off and retry
            if attempt == 3:
                return {"id": post_id, "error": repr(exc)}
            time.sleep(2 * (attempt + 1))
    return {"id": post_id, "error": "unreachable"}


def render(posts: list[dict], title: str) -> str:
    lines = [f"# {title}", ""]
    lines.append("Fetched from api.fxtwitter.com; text is the author's own, unedited.")
    lines.append("Reposts are posts by other accounts that this account reposted.")
    lines.append("")
    for p in posts:
        if p.get("error"):
            lines.append(f"## {p['id']} (fetch failed: {p['error']})")
            lines.append("")
            continue
        author = p.get("author", {}).get("screen_name", "?")
        when = p.get("created_at", "")
        url = p.get("url", f"https://x.com/i/status/{p['id']}")
        stats = f"{p.get('likes', 0)} likes, {p.get('retweets', 0)} reposts, {p.get('replies', 0)} replies, {p.get('views', 0)} views"
        reply_to = p.get("replying_to")
        head = f"## {when} @{author}"
        if reply_to:
            head += f" (reply to @{reply_to})"
        lines.append(head)
        lines.append("")
        lines.append(f"[{p['id']}]({url}) - {stats}")
        lines.append("")
        lines.append((p.get("text") or "").strip())
        quote = p.get("quote")
        if quote:
            qa = quote.get("author", {}).get("screen_name", "?")
            lines.append("")
            lines.append(f"> Quoting @{qa}: " + (quote.get("text") or "").strip().replace("\n", "\n> "))
        lines.append("")
    return "\n".join(lines) + "\n"


def main() -> None:
    ids_path, jsonl_path, md_path = (Path(a) for a in sys.argv[1:4])
    title = sys.argv[4] if len(sys.argv) > 4 else "X archive"
    ids = [line.strip() for line in ids_path.read_text().splitlines() if line.strip()]
    posts = []
    for i, post_id in enumerate(ids, 1):
        posts.append(fetch(post_id))
        if i % 25 == 0:
            print(f"{i}/{len(ids)}", flush=True)
        time.sleep(0.4)
    posts.sort(key=lambda p: int(p.get("created_timestamp") or 0))
    jsonl_path.write_text("".join(json.dumps(p, ensure_ascii=False) + "\n" for p in posts))
    md_path.write_text(render(posts, title))
    failed = [p["id"] for p in posts if p.get("error")]
    print(f"done: {len(posts)} posts, {len(failed)} failed {failed[:10]}")


if __name__ == "__main__":
    main()
