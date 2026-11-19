# Research index

Everything this project learned before its wayfinder map, dated 2026-11-09.

| File | What it holds |
| --- | --- |
| `pipeline-router.md` | How Pipeline works, its limits, toolchain, security status, the devnet census, and our verdict |
| `pool4.md` | IMD's Pool4 design, summarised, with notes for porting it to a Pipeline strategy |
| `landscape.md` | Who routes unusual markets on Solana, prior art for each idea, others building near Pipeline |
| `estimates.md` | First feasibility and time estimates per product, with the suggested order |
| `outreach.md` | Where the outreach to MetalLegBob is kept: outside this public repo, in the owner's private file |

MetalLegBob's profile (`metallegbob.md`: who he is, his Factory, why he built Pipeline, his six asks, his views and network) and the full-text archives of his X posts (`x/`: all 333 posts and reposts on @MetalLegBob from 2026-09-01 to 2026-11-09, and the Pipeline launch post with its 35 replies) are kept out of the repo, in the owner's `~/.config/testing-pipeline/research/`.

## Refreshing the X archives

The ids come from an X search in the owner's logged-in Chrome (Claude in Chrome): `from:MetalLegBob since:<date>`, Latest tab, scrolled to the end, reading each post's id from its timestamp link; X rate-limits after about 60 posts, so wait and press Retry.
Then fetch full text by id, free and keyless, into the private folder: `python3 -I scripts/fetch_x_posts.py <ids.txt> ~/.config/testing-pipeline/research/x/<name>.jsonl ~/.config/testing-pipeline/research/x/<name>.md "<title>"`.
The search view cuts long posts short; the fetched text is complete.

## Owner's knowledge bases used

- Jupiter and Meteora: `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora` (routing of hook pools, terminal distribution, Jupiter Forecast, Dynamic Vault).
- Uniswap v4 hooks: `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/v4-hooks` (for Pool4).
- Cloudflare: `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/cloudflare` (Workers, Containers, Durable Objects).
