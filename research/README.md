# Research index

Everything this project learned before its wayfinder map, dated 2026-11-09.

| File | What it holds |
| --- | --- |
| `pipeline-router.md` | How Pipeline works, its limits, toolchain, security status, the devnet census, and our verdict |
| `metallegbob.md` | Who Pipeline's author is, his Factory, why he built Pipeline, his six asks, his views and network, and what they mean for us |
| `pool4.md` | IMD's Pool4 design, summarised, with notes for porting it to a Pipeline strategy |
| `landscape.md` | Who routes unusual markets on Solana, prior art for each idea, others building near Pipeline |
| `estimates.md` | First feasibility and time estimates per product, with the suggested order |
| `outreach.md` | Where the outreach to MetalLegBob is kept: outside this public repo, in the owner's private file |
| `x/metallegbob-2026-09-01-to-2026-11-09.md` | Full text of all 333 posts and reposts on @MetalLegBob from 2026-09-01 to 2026-11-09 (`.jsonl` beside it is the raw fxtwitter data) |
| `x/pipeline-launch-thread.md` | The Pipeline launch post and its 35 replies, full text |

## Refreshing the X archives

The ids come from an X search in the owner's logged-in Chrome (Claude in Chrome): `from:MetalLegBob since:<date>`, Latest tab, scrolled to the end, reading each post's id from its timestamp link; X rate-limits after about 60 posts, so wait and press Retry.
Then fetch full text by id, free and keyless: `python3 -I scripts/fetch_x_posts.py <ids.txt> <out.jsonl> <out.md> "<title>"`.
The search view cuts long posts short; the fetched text is complete.

## Owner's knowledge bases used

- Jupiter and Meteora: `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora` (routing of hook pools, terminal distribution, Jupiter Forecast, Dynamic Vault).
- Uniswap v4 hooks: `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/v4-hooks` (for Pool4).
- Cloudflare: `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/cloudflare` (Workers, Containers, Durable Objects).
