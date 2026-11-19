# Progress site

The public site that shows what this project has done so far: https://testing-pipeline.vercel.app
Built for [Progress site on Vercel](https://github.com/imDev2023/testing-pipeline/issues/30).

It is a static site with no server and no script in its pages.
A visitor's browser never calls GitHub, and Vercel never sees the repo: it receives only the built pages.

## Commands

Run them in `site/`, after `npm ci`.

| Command | What it does |
| --- | --- |
| `npm run refresh` | Rebuilds `content.json` from the project's record and prints what it left out. `-- --dropped` lists every dropped block; `-- --ref HEAD` reads `README.md` and `docs/` from your branch instead of `origin/main`, to see its docs on the site before it merges. |
| `npm run build` | Renders `content.json` into `dist/`. |
| `npm run preview` | Builds, then serves `dist/` at http://127.0.0.1:4310. |
| `npm run deploy` | Builds, runs the privacy gate, and deploys to production on Vercel. |

To bring the live site up to date:

```sh
cd site && npm ci
npm run refresh     # read its report; see "Privacy" below
git add content.json approved.txt && git commit -m "Refresh the progress site"
npm run deploy
```

`refresh` needs `gh` signed in to the repo, and fetches `origin` itself.
`deploy` needs the Vercel CLI signed in as `imdev2023-8959`.
Both need the owner's private lines file, `~/.config/testing-pipeline/private-lines.txt`, and stop without it.
Everything runs on the machine's default Node 26; if a tool breaks there, use Node 24.4.1 from nvm (`docs/toolchain.md`).

## How it fits together

| File | Job |
| --- | --- |
| `content.json` | The site's only content. Generated, committed, and served as `/content.json`. Never edit it by hand. |
| `refresh.mjs` | Writes `content.json` from the map and its tickets on GitHub, `README.md` and `docs/` on `origin/main`, and the findings on the `research/*` branches. |
| `approved.txt` | The blocks that mention a third party and may be shown. |
| `private.mjs` | The privacy gate, used by `refresh` and `deploy`. |
| `build.mjs` | Renders the pages, their Markdown twins and `llms.txt` into `dist/`. One dependency, `marked`. |
| `static/` | The stylesheet, the fonts (Geist and Geist Mono, self-hosted) and the icon, copied as they are. |
| `deploy.mjs`, `vercel.json` | The deploy, and the headers Vercel serves. |

### What is shown

- The site's name and its headline: both from the first line of the repo's `README.md`, "The internal home of Aviary: a terminal and ...".
  That line is the one place the site takes the public name from (`INTRODUCTION` in `refresh.mjs`), so a rename there renames the site.
- The front page: that headline, the map's Destination, the map's tickets grouped as Done, In progress and Next, and the six things found in Pipeline itself.
- Tickets and their resolutions are dated records: they keep the working names they were written with (Pipescope, Pool4 for Solana), and the site shows them as written (owner, 2026-11-10).
- Above the tickets, the owner's standing rule from the map's Notes, "Built for MetalLegBob": every decision is a default he may change.
  It is there because anything shown to him must list the decisions it rests on and invite him to change any (the map's Notes, 2026-11-10); the Done list below it is that list.
  `STANDING_RULE` in `refresh.mjs` finds it, and `refresh` stops if the note is reworded.
- A ticket is Done when it is closed as completed, In progress when it is open and assigned, Next when it is open and unassigned.
- A Done ticket shows its line from the map's "Decisions so far" and links to a page with its resolution comment.
- One page per document: `docs/toolchain.md`, every file in `docs/spec/`, and the findings file of every `research/*` branch.
- The decision register, `docs/decisions.md`, becomes a page at `/decisions/` as soon as it is on `main`, and the front page then links to it under the standing rule.
  Each decision is reachable by its id, for example `/decisions/#tax-03`.
- The six findings about Pipeline are picked by a phrase each, in `FOUND_IN_PIPELINE` at the top of `refresh.mjs`, and shown as their source wrote them.
  If a source is reworded, `refresh` stops and names the phrase to fix.
- The repository moved on 2026-11-19 (#167) with every issue number kept, so the ticket pages keep their addresses; the numbers that were pull requests are placeholders, which the site never shows, since it reads only the map's sub-issues.
  `refresh` reads only `imDev2023/testing-pipeline`, never the private archive.
- The repo is private, so links into it, whether full addresses or relative links between files, are pointed at the site's own pages, and the ones with no page are turned into plain text.
  Headings get the anchors GitHub gives them, so a link to a section of a file lands on that section here.
- To show another document, add one `addDocument` line in `refresh.mjs`.

### For agents reading the site

Every page has a Markdown twin (`/7/` is also `/7.md`, the front page is `/index.md`), `/llms.txt` indexes them, and `/content.json` holds everything in one file.

## Privacy

The site is public and the project's record is not.
Never show MetalLegBob's words, his messages, the outreach drafts, his profile or the archive of his X posts, and never show a key.
Public devnet addresses and transaction links are fine.

`refresh.mjs` enforces this in three steps:

1. It reads only the owner's own resolution comments (and addenda), never the "Input from" comments, and skips the outreach tickets (`OUTREACH_TICKETS`, and any title that reads like one).
2. It judges every block of text (a paragraph, a list item, a table row, a code block).
   A block that touches the outreach, or says what he was asked, asked for or said, is dropped (`DROP`).
   A block that names him or refers to him is dropped unless that exact block is in `approved.txt` (`REVIEW`).
   The standing rule's own phrases, such as "a default he may change", are not mentions (`NOT_A_MENTION`).
   A block that names the address or the handle the owner has chosen but not registered yet, or says which names are free, is dropped too, so nobody can register them first; remove that rule from `DROP` once the owner has registered both.
3. The result must pass the privacy gate before it replaces `content.json`.

The privacy gate is `grep -r -i -F -f ~/.config/testing-pipeline/private-lines.txt` over the content, and again over the built output before every deploy.
Any match stops the run and names the file and line, never the matched text.
Do not read the private lines file yourself, and read nothing else under `~/.config/testing-pipeline/`.

After a refresh, read its report:

- "Held back" lists new blocks that mention a third party.
  Add a block's line to `approved.txt` only if it states a fact read from public code or the public chain.
  If it must never be shown, add a pattern for its kind to `DROP`, so the report stays empty.
- "Match nothing any more" lists lines of `approved.txt` whose source changed; delete them.
- "Decisions left out of the register whole" names the decisions of `docs/decisions.md` with a line that may not be shown.
  A decision is shown whole or not at all, so a field value that names him, the private correspondence or the unregistered address takes its whole decision off the site.
- "Done without a page" names closed tickets with no comment that starts with "Resolution" or "Resolved".

## Vercel

- Project `testing-pipeline`, in the `imdev2023-8959` account, at https://testing-pipeline.vercel.app.
  The address keeps the repo's internal name; the site itself is called Aviary (owner, 2026-11-10).
- `package.json` asks for Node 24 or later because the builder in Vercel CLI 59 refuses the project's default, 26.x.
- A deploy goes to production.
  The owner approved the first on 2026-11-10; ask before another unless they have said otherwise.
- Do not connect the GitHub repo to the project, and do not buy a domain or anything else.
- `deploy.mjs` links the folder, runs `vercel build --prod` (which packs `dist/` into `.vercel/output`), checks that folder with the privacy gate, and uploads it with `vercel deploy --prebuilt --prod`.
- `vercel.json` sets a Content-Security-Policy that allows no script at all, so a page that needs one will not work until the policy changes.

## Design

The owner's brief: as perfect as Linear's website or Apple Notes, with a simple purpose, architecture, design and implementation, and no taglines, helper text or secondary labels.

- One column of content, 42rem wide, beside a rail that holds the section names on the front page and a document's contents elsewhere.
  Below 66rem the rail folds into the column.
- One colour beyond ink and paper, a canary yellow: it marks what is done, and whatever is pointed at.
- Light and dark follow the system; the tokens are at the top of `static/style.css`.
- Tables and commands that are wider than the column run into the free space to its right on a desktop, and scroll edge to edge on a phone.
- Every word on the site comes from the project's record, except the 404 page.
  If a screen seems to need a label or a line of help, change the layout instead.

After a change to the look, check every page at phone and desktop widths, in light and dark, with `agent-browser`.
