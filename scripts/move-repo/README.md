# The move to a new repository (#167)

GitHub keeps a read-only ref for every pull request (`refs/pull/<n>/head`), and two of the old repository's still pointed at commits holding the research files the privacy purge removes.
Only GitHub Support can delete those refs, so on 2026-11-19 the owner chose to move the project to a new repository of the same name instead (decision `SUITE-46`).
`scripts/move-repo.sh` is that move, run once by the owner, because auto mode refuses repository creation and renaming.

```sh
bash scripts/move-repo.sh --dry-run   # builds and checks everything, prints every change, changes nothing on GitHub or in the checkouts
bash scripts/move-repo.sh             # the move: safe to re-run, stops at the first failed check
bash scripts/move-repo.sh check       # proves every issue number against the archive and scans the new repository
bash scripts/move-repo.sh check --strict   # also compares every field, which holds only until sessions write again
```

It needs `gh` signed in as `imDev2023`, `git-filter-repo`, Docker Desktop running (for the CI runners) and the owner's private files under `~/.config/testing-pipeline/`: the profile and the X archive in `research/`, `private-lines.txt`, and in `purge/` the outreach marks, the replacement list and the two hooks.
It keeps its state, its rewrites and its logs in `~/.config/testing-pipeline/move/`, never in the repo.

## What it does

1. Checks the tools, the sign-in and the private sources.
2. Installs the purge's `pre-commit` and `pre-push` hooks in the main checkout's git folder, so every worktree on the Mac refuses to commit the purged files and to push the old history: a session left on the old history cannot put the purged files back.
3. Finds where the move stands from GitHub itself (renamed yet, created yet), so a second run picks up where the first stopped.
4. Reads the old repository: every issue with its comments, labels, assignees, sub-issues and blocked-by links, every pull request, the labels, the Actions settings and variables; it stops if there are secrets, webhooks, deploy keys or environments, which it cannot carry.
5. Rewrites the history in a fresh clone with `git filter-repo`: every commit loses `research/metallegbob.md` and `research/x/`, and the replacement list rewords the few lines that quoted him; then it scans every object (see "The scan") and checks that `main` already ignores the purged paths.
6. Builds every number of the new repository, from #1 to the highest: each issue as it is, through the same replacements, with our old commit ids pointed at the rewritten ones; each pull request as a closed placeholder issue that names the archive and the PR's squash commit, old and new; an open pull request's placeholder names the number it goes on as. All of it is scanned before anything changes on GitHub.
7. Checks that no branch moved and no issue was opened since the clone, so a session that did not pause stops the move rather than losing work.
8. Renames `imDev2023/testing-pipeline` to `imDev2023/testing-pipeline-archive`, which stays private for good.
9. Creates the new private `imDev2023/testing-pipeline` with the old one's merge, wiki and project settings, and README's first sentence as its description; the name, every link in the docs, the local remotes and the Orca repo stay as they are.
10. Carries over the Actions settings and the `CI_RUNS_ON` variable.
11. Registers the iMac's runners with the new repository (`scripts/ci-runner/start.sh` forgets the archive's registration, whose entries go offline and which GitHub drops after 14 days).
12. Pushes `main` and then every other rewritten branch.
13. Makes the labels exactly the old ones.
14. Creates every number in order through GitHub's issue import API, which keeps each issue's and comment's original dates, checking that each lands on its own number and stopping otherwise; if GitHub has dropped that API, it uses the plain issue API, without the dates.
15. Links the sub-issues in their order and the blocked-by dependencies.
16. Recreates the open pull requests on their branches with their comments, notes the new number on each one's ticket, and points the map's links at the new numbers.
17. Moves the Mac's checkout and every worktree onto the rewrite of the commit it is on (`git reset --keep`, which keeps uncommitted changes), replays local commits that are not on GitHub, and leaves alone, with a `CHECK` line, anything it cannot move safely.
18. Runs the check.

## The check

- Every number from #1 to the highest is on the new repository: the issue it was in the archive, with the creation time GitHub's import kept, or the closed placeholder of the pull request it was.
- Every pull request open at the move was recreated on its branch (it may have merged since).
- With `--strict`, as the move runs it at its end before any session writes again, each issue must also match the archive field by field: title, body, state and reason, labels, assignees, comments, parent, sub-issues in order and blocked-by links. Once sessions work on the issues again that no longer holds, so `check` without it is what `scripts/make-repo-public.sh` runs; the strict check passed on 2026-11-19.
- The scan finds nothing in a mirror clone of the new repository (every branch and pull request ref, every object) or in any issue, pull request, comment, review or edit revision.
- It reports CI on `main` and the recreated pull requests' checks, and whether CodeRabbit has reviewed them; if it never does, add the repository to CodeRabbit at https://github.com/settings/installations.

## The scan

`scan.mjs` looks for the purged material without ever printing it: a hit names only where it is and which source it matches.

- Any 8 words in a row from his X posts (all 369 in the archive) or from his profile, compared after folding case, quotes and punctuation, so a quote survives being rewrapped; file names are ignored.
- Every line of the owner's private lines file, as a phrase, as the purge's own checks use it.
- The marks of the outreach wording removed on 2026-11-10, only where that wording lived: `research/outreach.md`, the map (#1) and the follow-up ticket (#27), because elsewhere they are plain English.
- Any commit that touches `research/metallegbob.md` or `research/x/`.

## After the move

- Old commit ids in issue comments point at the rewritten commits; old ids inside committed files and in the archive do not, and `~/.config/testing-pipeline/move/last-pushed/rewrite.git/filter-repo/commit-map` maps each old id to its new one.
- `scripts/make-repo-public.sh` makes the new repository public once the owner says yes: it runs the check first and stops unless it passes.
