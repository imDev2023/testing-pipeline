// Moves imDev2023/testing-pipeline to a new repository of the same name (#167), because GitHub's
// read-only pull request refs of the old one still hold the purged research files and only GitHub
// Support could remove them. Run through scripts/move-repo.sh; scripts/move-repo/README.md says what
// each step does. Every step checks GitHub first, so the real run is safe to re-run, and the first
// failed check stops it.
//
//   bash scripts/move-repo.sh --dry-run   builds and checks everything, prints every change, changes nothing
//   bash scripts/move-repo.sh             the move (the owner runs it: auto mode refuses repo creation)
//   bash scripts/move-repo.sh check       proves the issue numbers and scans the new repository
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, symlinkSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CFG, PURGED_PATHS, loadNeedles, findIn, scanGitDir, scanTracker, MARKS_ISSUES } from "./scan.mjs";
import { DRY, run, gh, api, graphqlAll, gitNet, git, Stop, stop, change } from "./run.mjs";

// ---- The move's settings, in one place --------------------------------------------------------
const OWNER = "imDev2023";
const NAME = "testing-pipeline";
const ARCHIVE = "testing-pipeline-archive";
const R = `${OWNER}/${NAME}`;
const A = `${OWNER}/${ARCHIVE}`;
const url = (name) => `https://github.com/${OWNER}/${name}.git`;
// The checkout every worktree on this Mac hangs off, and the owner's private files.
const MAIN_CHECKOUT = "/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/testing-pipeline";
const STATE_DIR = join(CFG, "move");
const REPLACEMENTS = join(CFG, "purge", "replacements.txt");
const HOOK_SRC = join(CFG, "purge");
const HOOKS = ["pre-commit", "pre-push"];
const IMPORT_ACCEPT = "application/vnd.github.golden-comet-preview+json";
const PAUSE_MS = 700; // between writes that create content, under GitHub's secondary rate limit

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MODE = process.argv.includes("check") ? "check" : "move";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---- State kept between runs, in the owner's private folder ------------------------------------
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const STATE_FILE = join(STATE_DIR, "state.json");
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
function save() {
  if (!DRY) writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

let stepNo = 0;
const step = (title) => console.log(`== ${++stepNo}. ${title}`);
const say = (s) => console.log(`  ${s}`);
const day = (iso) => (iso ? iso.slice(0, 10) : "");

// A failed check stops the real run; a dry run notes it and goes on, so it shows every step.
const blockers = [];
function gate(msg) {
  if (!DRY) stop(msg);
  blockers.push(msg);
  say(`BLOCKER (the real run stops here): ${msg}`);
}

// ---- GitHub reads --------------------------------------------------------------------------------
async function repoInfo(full) {
  const r = await api("GET", `repos/${full}`, undefined, { allowFail: true });
  if (r && r.error) {
    if (/HTTP 404|Not Found/.test(r.error)) return null;
    throw new Error(`reading ${full}: ${r.error.slice(0, 300)}`);
  }
  return r;
}

const ISSUE_FIELDS = `number title body state stateReason createdAt closedAt
  labels(first:50){nodes{name}} assignees(first:10){nodes{login}}
  comments(first:100){totalCount nodes{body createdAt}}
  subIssues(first:100){totalCount nodes{number}} parent{number}
  blockedBy(first:100){totalCount nodes{number repository{nameWithOwner}}}`;

async function trackerOf(full) {
  const [o, n] = full.split("/");
  const issues = await graphqlAll(
    `query($o:String!,$n:String!,$after:String){repository(owner:$o,name:$n){issues(first:20,after:$after){pageInfo{hasNextPage endCursor} nodes{${ISSUE_FIELDS}}}}}`,
    ["repository", "issues"],
    { o, n },
  );
  const prs = await graphqlAll(
    `query($o:String!,$n:String!,$after:String){repository(owner:$o,name:$n){pullRequests(first:20,after:$after){pageInfo{hasNextPage endCursor} nodes{
      number title body state isDraft merged createdAt closedAt mergedAt mergeCommit{oid} headRefName baseRefName
      comments(first:100){totalCount nodes{body createdAt}} closingIssuesReferences(first:5){nodes{number}}}}}}`,
    ["repository", "pullRequests"],
    { o, n },
  );
  for (const i of issues) {
    for (const k of ["comments", "subIssues", "blockedBy"]) {
      if (i[k].totalCount > i[k].nodes.length) stop(`#${i.number} has more ${k} than one page; extend the query`);
    }
    if (i.blockedBy.nodes.some((b) => b.repository.nameWithOwner.toLowerCase() !== full.toLowerCase())) {
      stop(`#${i.number} is blocked by an issue in another repository; the move does not carry that`);
    }
  }
  for (const p of prs) if (p.comments.totalCount > p.comments.nodes.length) stop(`PR #${p.number} has more comments than one page`);
  return { issues, prs };
}

async function snapshot(full) {
  const repo = await repoInfo(full);
  const { issues, prs } = await trackerOf(full);
  const labels = await api("GET", `repos/${full}/labels?per_page=100`, undefined, { paginate: true });
  const variables = (await api("GET", `repos/${full}/actions/variables?per_page=30`)).variables;
  const actions = await api("GET", `repos/${full}/actions/permissions`);
  const workflow = await api("GET", `repos/${full}/actions/permissions/workflow`);
  // What the move cannot carry: secret values, webhooks, deploy keys and environments. There are
  // none today; stop rather than drop one silently if that changes.
  const extras = {
    "Actions secrets": (await api("GET", `repos/${full}/actions/secrets`)).total_count,
    webhooks: (await api("GET", `repos/${full}/hooks`)).length,
    "deploy keys": (await api("GET", `repos/${full}/keys`)).length,
    environments: (await api("GET", `repos/${full}/environments`)).total_count,
  };
  const held = Object.entries(extras).filter(([, n]) => n);
  if (held.length) stop(`${full} has ${held.map(([k, n]) => `${n} ${k}`).join(", ")}, which the move does not carry; tell Claude.`);
  const byNumber = new Map();
  for (const i of issues) byNumber.set(i.number, { kind: "issue", ...i });
  for (const p of prs) byNumber.set(p.number, { kind: "pr", ...p });
  const max = Math.max(...byNumber.keys());
  return { repo, labels, variables, actions, workflow, byNumber, max, issues, prs };
}

// ---- Text going to the new repository ------------------------------------------------------------
function loadReplacements() {
  if (!existsSync(REPLACEMENTS)) stop(`${REPLACEMENTS} is missing; nothing changed.`);
  return readFileSync(REPLACEMENTS, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      const at = l.indexOf("==>");
      if (at < 1 || /^(regex|glob):/.test(l)) stop(`replacements line ${i + 1} is not a literal "old==>new" line`);
      return { from: l.slice(0, at), to: l.slice(at + 3) };
    });
}

// Applies the same literal replacements the rewrite applies to every file, then points our own
// commit ids at the rewritten commits.
function makeTransform(replacements, commitMap) {
  const olds = [...commitMap.keys()];
  const short = new Map();
  const shortOf = (h) => {
    if (!short.has(h)) {
      const m = olds.filter((o) => o.startsWith(h));
      short.set(h, m.length === 1 && commitMap.get(m[0]) !== m[0] ? commitMap.get(m[0]).slice(0, h.length) : null);
    }
    return short.get(h);
  };
  return (text) => {
    if (!text) return text || "";
    let t = text;
    for (const { from, to } of replacements) t = t.split(from).join(to);
    return t.replace(/\b[0-9a-f]{7,40}\b/g, (h) => {
      if (!/[a-f]/.test(h) || !/[0-9]/.test(h)) return h;
      if (h.length === 40) return commitMap.get(h) || h;
      return shortOf(h) || h;
    });
  };
}

function placeholderTitle(pr) {
  const t = `Archived pull request: ${pr.title}`;
  return t.length > 250 ? `${t.slice(0, 247)}...` : t;
}

function placeholderBody(pr, commitMap, newPr, movedOn) {
  const lines = [
    `#${pr.number} was a pull request before the repository moved on ${movedOn}.`,
    `The old repository, with this pull request, its review and its comments, is \`${A}\`, private for good.`,
  ];
  if (pr.merged) {
    const oldSha = pr.mergeCommit?.oid;
    const newSha = oldSha && commitMap.get(oldSha);
    lines.push(
      newSha
        ? `It was merged on ${day(pr.mergedAt)} as ${newSha} on \`main\` (\`${oldSha.slice(0, 7)}\` in the archive).`
        : `It was merged on ${day(pr.mergedAt)} (\`${(oldSha || "").slice(0, 7)}\` in the archive).`,
    );
  } else if (pr.state === "OPEN") {
    lines.push(`It was still open at the move and goes on as #${newPr}, on the same branch \`${pr.headRefName}\`.`);
  } else {
    lines.push(`It was closed without merging on ${day(pr.closedAt)}.`);
  }
  return lines.join("\n");
}

// The ticket a pull request builds: the issue it closes, else the number in a build-<n> branch name.
const ticketOf = (p) => p.closingIssuesReferences.nodes[0]?.number || +(p.headRefName.match(/build-(\d+)$/) || [])[1] || null;

// The map links pull requests by number; point the moved ones at their new numbers.
function remapPrs(body, prMap) {
  for (const [o, n] of Object.entries(prMap)) body = body.split(`/${NAME}/pull/${o})`).join(`/${NAME}/pull/${n})`).split(`[#${o}](`).join(`[#${n}](`);
  return body;
}

const prNote = (old, num, head, movedOn) =>
  `Pull request #${old} goes on as #${num} since the repository moved on ${movedOn}: the same branch, \`${head}\`, with its commits rewritten by the purge.`;

// What every number of the new repository will hold, built and scanned before anything changes.
function plan(snap, transform, commitMap, needles, movedOn) {
  const items = [];
  const openPrs = snap.prs.filter((p) => p.state === "OPEN").sort((a, b) => a.number - b.number);
  const predicted = new Map(openPrs.map((p, i) => [p.number, (state.prMap || {})[p.number] || snap.max + 1 + i]));
  for (let n = 1; n <= snap.max; n++) {
    const it = snap.byNumber.get(n);
    if (!it) {
      items.push({ n, kind: "gone", title: `Number ${n} was never used`, body: `Number ${n} held an issue that was deleted before the repository moved on ${movedOn}.`, closed: true, closedAt: null, createdAt: null, labels: [], assignees: [], comments: [] });
    } else if (it.kind === "pr") {
      items.push({ n, kind: "placeholder", pr: it, title: placeholderTitle(it), body: placeholderBody(it, commitMap, predicted.get(n), movedOn), closed: true, createdAt: it.createdAt, closedAt: it.mergedAt || it.closedAt || new Date().toISOString(), stateReason: "COMPLETED", labels: [], assignees: [], comments: [] });
    } else {
      items.push({
        n,
        kind: "issue",
        title: transform(it.title),
        body: transform(it.body),
        closed: it.state === "CLOSED",
        stateReason: it.stateReason,
        createdAt: it.createdAt,
        closedAt: it.closedAt,
        labels: it.labels.nodes.map((l) => l.name),
        assignees: it.assignees.nodes.map((a) => a.login),
        comments: it.comments.nodes.map((c) => ({ body: transform(c.body), createdAt: c.createdAt })),
        parent: it.parent?.number || null,
        subIssues: it.subIssues.nodes.map((s) => s.number),
        blockedBy: it.blockedBy.nodes.map((b) => b.number),
      });
    }
  }
  const prs = openPrs.map((p) => ({
    old: p.number,
    predicted: predicted.get(p.number),
    title: transform(p.title),
    head: p.headRefName,
    base: p.baseRefName,
    draft: p.isDraft,
    body: `${transform(p.body)}\n\n---\nRecreated on ${movedOn}, when the repository moved; it was #${p.number}, which is now a placeholder pointing here.`,
    comments: p.comments.nodes.map((c) => transform(c.body)),
    ticket: ticketOf(p),
  }));
  const hits = [];
  const check = (where, text, n) => {
    const h = findIn(text || "", needles, { marks: MARKS_ISSUES.includes(n) });
    if (h.length) hits.push(`${where} matches ${h.join("; ")}`);
  };
  for (const it of items) {
    check(`#${it.n} title`, it.title, it.n);
    check(`#${it.n} body`, it.body, it.n);
    it.comments.forEach((c, k) => check(`#${it.n} comment ${k + 1}`, c.body, it.n));
    if (it.body.length > 65000) hits.push(`#${it.n} body is too long for GitHub`);
  }
  for (const p of prs) {
    check(`PR #${p.old} title`, p.title, p.old);
    check(`PR #${p.old} body`, p.body, p.old);
    p.comments.forEach((c, k) => check(`PR #${p.old} comment ${k + 1}`, c, p.old));
  }
  return { items, prs, hits };
}

// ---- The rewrite of the history ------------------------------------------------------------------
function readMap(G) {
  const m = new Map();
  for (const l of readFileSync(join(G, "filter-repo", "commit-map"), "utf8").split("\n").slice(1)) {
    const [o, n] = l.split(" ");
    if (o && n) m.set(o, n);
  }
  return m;
}
const refsOf = (G) =>
  Object.fromEntries(
    git(G, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ")),
  );

async function buildRewrite(fromName) {
  const RUN = join(STATE_DIR, "runs", new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"));
  mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const G = join(RUN, "rewrite.git");
  say(`cloning ${OWNER}/${fromName} into ${RUN}`);
  await gitNet(["clone", "-q", "--bare", url(fromName), G]);
  const before = refsOf(G);
  writeFileSync(join(RUN, "refs-before.json"), JSON.stringify(before, null, 2));
  say(`${Object.keys(before).length} branches, ${git(G, "rev-list", "--all", "--count").trim()} commits`);
  run("git", ["filter-repo", "--quiet", "--invert-paths", ...PURGED_PATHS.flatMap((p) => ["--path", p]), "--replace-text", REPLACEMENTS, "--replace-message", REPLACEMENTS, "--prune-empty", "never"], { cwd: G, timeout: 1_800_000 });
  const after = refsOf(G);
  writeFileSync(join(RUN, "refs-after.json"), JSON.stringify(after, null, 2));
  if (JSON.stringify(Object.keys(before).sort()) !== JSON.stringify(Object.keys(after).sort())) stop("the rewrite lost or added a branch; nothing changed on GitHub.");
  return RUN;
}

// ---- Steps ---------------------------------------------------------------------------------------
async function preflight() {
  step("Check the tools, the sign-in and the private sources");
  for (const [cmd, args] of [
    ["git", ["--version"]],
    ["git", ["filter-repo", "--version"]],
    ["gh", ["--version"]],
  ]) {
    if (!run(cmd, args, { allowFail: true }).ok) stop(`${cmd} ${args[0]} is not installed; nothing changed.`);
  }
  const user = (await gh(["api", "user", "--jq", ".login"])).trim();
  if (user !== OWNER) stop(`gh is signed in as ${user}, not ${OWNER}; nothing changed.`);
  const needles = loadNeedles();
  say(`scan sources: ${needles.posts} X posts, the profile, ${needles.phrases.length} private lines, ${needles.marks.length} marks`);
  const replacements = loadReplacements();
  say(`${replacements.length} replacements for his words in the history and the issues`);
  for (const h of HOOKS) if (!existsSync(join(HOOK_SRC, h))) stop(`${join(HOOK_SRC, h)} is missing; nothing changed.`);
  return { needles, replacements };
}

async function installHooks() {
  step("Install the hooks that refuse the purged files and the old history (every worktree on this Mac)");
  const common = resolve(MAIN_CHECKOUT, git(MAIN_CHECKOUT, "rev-parse", "--git-common-dir").trim());
  const hooksPath = run("git", ["config", "--get", "core.hooksPath"], { cwd: MAIN_CHECKOUT, allowFail: true }).out.trim();
  if (hooksPath) stop(`core.hooksPath is set (${hooksPath}); the hooks would not run. Nothing changed.`);
  for (const h of HOOKS) {
    const dest = join(common, "hooks", h);
    const same = existsSync(dest) && readFileSync(dest, "utf8") === readFileSync(join(HOOK_SRC, h), "utf8");
    if (same) {
      say(`${dest}: in place`);
      continue;
    }
    if (existsSync(dest)) stop(`a different ${dest} already exists; left alone. Nothing changed on GitHub.`);
    await change(`install ${dest}`, () => {
      copyFileSync(join(HOOK_SRC, h), dest);
      chmodSync(dest, 0o755);
    });
  }
}

async function whereAreWe() {
  step("Find where the move stands on GitHub");
  const cur = await repoInfo(R);
  const arc = await repoInfo(A);
  if (!state.oldRepoId) {
    if (arc) stop(`${A} exists, but there is no record of the old repository's id; nothing changed, tell Claude.`);
    if (!cur) stop(`${R} does not exist; nothing changed.`);
    state.oldRepoId = cur.id;
    save();
  }
  const renamed = !!arc && arc.id === state.oldRepoId;
  if (arc && !renamed) stop(`${A} exists but is not the old repository; nothing changed, tell Claude.`);
  if (!renamed && cur?.id !== state.oldRepoId) stop(`${R} is not the repository this move started from; nothing changed, tell Claude.`);
  if (renamed && arc.private === false) stop(`${A} is public; it must stay private. Tell Claude.`);
  const created = !!cur && cur.id !== state.oldRepoId;
  say(renamed ? `renamed: the old repository is ${A}` : `not renamed yet: ${R} is the old repository`);
  say(created ? `created: ${R} is the new repository (${cur.private ? "private" : "PUBLIC"})` : `the new repository does not exist yet`);
  return { renamed, created, oldName: renamed ? ARCHIVE : NAME, cur };
}

async function rewrite(where, needles) {
  step("Rewrite the history without the purged files and his words, and scan every object");
  let RUN = null;
  if (where.created) {
    const heads = await api("GET", `repos/${R}/git/matching-refs/heads/`, undefined, { allowFail: true });
    if (Array.isArray(heads) && heads.length) {
      RUN = state.run;
      if (!RUN || !existsSync(join(RUN, "rewrite.git"))) stop(`${R} already has branches, but the rewrite that was pushed is not on this Mac; tell Claude.`);
      say(`the new repository already has the rewrite of ${RUN}; using it`);
    }
  }
  if (!RUN) RUN = await buildRewrite(where.oldName);
  const G = join(RUN, "rewrite.git");
  const scan = scanGitDir(G, needles);
  say(`scanned ${scan.blobs} files and ${scan.commits} commits`);
  if (scan.hits.length) {
    scan.hits.slice(0, 40).forEach((h) => say(`HIT ${h}`));
    gate("the rewrite still holds purged material; nothing changed on GitHub, tell Claude.");
  }
  const ignore = git(G, "show", "main:.gitignore");
  for (const p of PURGED_PATHS) {
    if (!ignore.split("\n").includes(p)) gate(`main's .gitignore does not list ${p}: merge the pull request that removes the profile first. Nothing changed.`);
  }
  const before = JSON.parse(readFileSync(join(RUN, "refs-before.json"), "utf8"));
  const after = JSON.parse(readFileSync(join(RUN, "refs-after.json"), "utf8"));
  const commitMap = readMap(G);
  if (!scan.hits.length) say(`clean: no purged path, no private line, no post or profile text`);
  say(`main ${before["refs/heads/main"].slice(0, 7)} -> ${after["refs/heads/main"].slice(0, 7)}`);
  return { RUN, G, before, after, commitMap };
}

async function quietCheck(where, rw, snap) {
  step("Check that nothing moved on the old repository since the clone");
  if (where.renamed) {
    say("already renamed; the archive is no longer written to");
    return;
  }
  const remote = Object.fromEntries(
    (await gitNet(["ls-remote", url(NAME), "refs/heads/*"]))
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t").reverse()),
  );
  const moved = [...new Set([...Object.keys(remote), ...Object.keys(rw.before)])].filter((r) => remote[r] !== rw.before[r]);
  if (moved.length) gate(`branches moved since the clone (${moved.slice(0, 5).join(", ")}): a session is still pushing. Pause it, then run this again; nothing changed.`);
  const latest = await api("GET", `repos/${R}/issues?state=all&per_page=1&sort=created&direction=desc`);
  if (latest[0]?.number !== snap.max) gate(`#${latest[0]?.number} was opened since the snapshot; run this again. Nothing changed.`);
  say(`quiet: ${Object.keys(remote).length} branches as cloned, highest number #${snap.max}`);
}

async function renameOld(where) {
  step(`Rename ${R} to ${A} (private for good)`);
  if (where.renamed) return say("done before");
  await change(`rename ${R} to ${A}`, () => api("PATCH", `repos/${R}`, { name: ARCHIVE }));
  if (!DRY) {
    const arc = await repoInfo(A);
    if (arc?.id !== state.oldRepoId) stop(`the rename did not land as expected; tell Claude.`);
    where.renamed = true;
  }
}

function settingsOf(snap, description) {
  const r = snap.repo;
  return {
    description,
    homepage: r.homepage || "",
    private: true,
    has_issues: true,
    has_projects: r.has_projects,
    has_wiki: r.has_wiki,
    has_discussions: r.has_discussions,
    allow_squash_merge: r.allow_squash_merge,
    allow_merge_commit: r.allow_merge_commit,
    allow_rebase_merge: r.allow_rebase_merge,
    allow_auto_merge: r.allow_auto_merge,
    allow_update_branch: r.allow_update_branch,
    delete_branch_on_merge: r.delete_branch_on_merge,
    squash_merge_commit_title: r.squash_merge_commit_title,
    squash_merge_commit_message: r.squash_merge_commit_message,
    merge_commit_title: r.merge_commit_title,
    merge_commit_message: r.merge_commit_message,
    web_commit_signoff_required: r.web_commit_signoff_required,
  };
}

// The repository's description is README.md's first sentence, so the public names live in one place.
function descriptionOf(G) {
  const line = git(G, "show", "main:README.md")
    .split("\n")
    .find((l) => l.startsWith("The internal home of"));
  if (!line) stop("README.md on main has no line starting \"The internal home of\"; tell Claude.");
  return line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
}

async function createNew(where, snap, rw) {
  step(`Create the new private ${R} with the old one's settings`);
  const s = settingsOf(snap, descriptionOf(rw.G));
  if (!where.created) {
    await change(`create ${R} (private): ${JSON.stringify({ description: s.description })}`, () =>
      api("POST", "user/repos", { name: NAME, private: true, auto_init: false, has_issues: true, description: s.description }),
    );
  } else say("created before");
  await change(`set its merge, wiki and project settings to the old one's`, () => api("PATCH", `repos/${R}`, s));
  if (!DRY) {
    const cur = await repoInfo(R);
    if (!cur || cur.id === state.oldRepoId || !cur.private) stop("the new repository is not as expected; tell Claude.");
    where.created = true;
    where.cur = cur;
  }
}

async function actionsSettings(snap) {
  step("Carry over the Actions settings and the CI_RUNS_ON variable");
  await change(`set Actions to enabled=${snap.actions.enabled}, allowed_actions=${snap.actions.allowed_actions}`, () =>
    api("PUT", `repos/${R}/actions/permissions`, { enabled: snap.actions.enabled, allowed_actions: snap.actions.allowed_actions }),
  );
  await change(`set the workflow token to ${snap.workflow.default_workflow_permissions}, approving reviews ${snap.workflow.can_approve_pull_request_reviews}`, () =>
    api("PUT", `repos/${R}/actions/permissions/workflow`, snap.workflow),
  );
  for (const v of snap.variables) {
    await change(`set the variable ${v.name}=${v.value}`, async () => {
      const r = await api("POST", `repos/${R}/actions/variables`, { name: v.name, value: v.value }, { allowFail: true });
      if (r?.error) await api("PATCH", `repos/${R}/actions/variables/${v.name}`, { name: v.name, value: v.value });
    });
  }
}

async function runners() {
  step("Register the iMac's CI runners with the new repository");
  const start = join(REPO_ROOT, "scripts", "ci-runner", "start.sh");
  if (DRY) {
    const ps = run("docker", ["compose", "-f", join(REPO_ROOT, "scripts", "ci-runner", "compose.yml"), "ps", "--format", "{{.Service}} {{.State}}"], { allowFail: true });
    say(ps.ok ? `runners now: ${ps.out.trim().split("\n").join(", ") || "none running"}` : "docker is not reachable; the real run needs Docker Desktop running");
    return change(`run ${start}, which registers each runner with ${R} afresh (the archive's entries go offline and GitHub drops them after 14 days)`);
  }
  run("bash", [start], { timeout: 1_800_000, cwd: REPO_ROOT });
  const list = await api("GET", `repos/${R}/actions/runners`);
  say(`registered: ${list.runners.map((r) => `${r.name} (${r.status})`).join(", ")}`);
  if (list.runners.length < 2) stop("the runners did not register with the new repository; tell Claude.");
}

async function push(rw) {
  step("Push every rewritten branch to the new repository");
  const remote = DRY
    ? {}
    : Object.fromEntries(
        (await gitNet(["ls-remote", url(NAME), "refs/heads/*"]))
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split("\t").reverse()),
      );
  const n = Object.keys(rw.after).length;
  // What is there already must be exactly the rewrite's (a run stopped halfway); anything else is a stranger's push.
  if (Object.keys(remote).some((r) => remote[r] !== rw.after[r])) stop(`${R} has branches that differ from the rewrite; a session pushed to it. Tell Claude.`);
  if (!DRY) {
    state.run = rw.RUN; // before pushing, so a run stopped halfway resumes with this same rewrite
    save();
  }
  const missing = Object.keys(rw.after).filter((r) => !remote[r]);
  if (!missing.length) say(`all ${n} branches are there`);
  else {
    // main first, so it becomes the default branch, then the rest in one go.
    await change(`push ${remote["refs/heads/main"] ? "" : `main (${rw.after["refs/heads/main"].slice(0, 7)}) and then `}${missing.length - (remote["refs/heads/main"] ? 0 : 1)} other branches`, async () => {
      if (!remote["refs/heads/main"]) await gitNet(["push", "-q", url(NAME), "refs/heads/main:refs/heads/main"], { cwd: rw.G, timeout: 900_000 });
      const rest = missing.filter((r) => r !== "refs/heads/main").map((r) => `${r}:${r}`);
      if (rest.length) await gitNet(["push", "-q", "--atomic", url(NAME), ...rest], { cwd: rw.G, timeout: 900_000 });
    });
  }
  if (!DRY) {
    await api("PATCH", `repos/${R}`, { default_branch: "main" });
    const link = join(STATE_DIR, "last-pushed");
    rmSync(link, { force: true });
    symlinkSync(rw.RUN, link);
  }
}

async function labels(snap) {
  step(`Make the labels the old repository's ${snap.labels.length}`);
  const have = DRY ? [] : await api("GET", `repos/${R}/labels?per_page=100`, undefined, { paginate: true });
  const want = new Map(snap.labels.map((l) => [l.name, l]));
  for (const l of snap.labels) {
    const h = have.find((x) => x.name === l.name);
    const body = { name: l.name, color: l.color, description: l.description || "" };
    if (!h) await change(`create the label ${l.name}`, () => api("POST", `repos/${R}/labels`, body));
    else if (h.color !== l.color || (h.description || "") !== (l.description || "")) await change(`update the label ${l.name}`, () => api("PATCH", `repos/${R}/labels/${encodeURIComponent(l.name)}`, body));
  }
  for (const h of have) if (!want.has(h.name)) await change(`delete GitHub's default label ${h.name}, which the old repository did not have`, () => api("DELETE", `repos/${R}/labels/${encodeURIComponent(h.name)}`));
}

async function newIssues() {
  const list = await api("GET", `repos/${R}/issues?state=all&per_page=100`, undefined, { paginate: true });
  return new Map(list.map((i) => [i.number, i]));
}

async function waitImport(id) {
  for (let i = 0; i < 120; i++) {
    const r = await api("GET", `repos/${R}/import/issues/${id}`, undefined, { accept: IMPORT_ACCEPT });
    if (r.status === "imported") return +r.issue_url.split("/").pop();
    if (r.status === "failed") stop(`GitHub refused an issue import: ${JSON.stringify(r.errors || r).slice(0, 400)}. Tell Claude.`);
    await sleep(i < 10 ? 1000 : 3000);
  }
  stop(`issue import ${id} is still pending after six minutes; run this again later (it resumes).`);
}

// One number: the issue with its comments (or a placeholder) through GitHub's issue import, which
// keeps the original dates, or, if GitHub has dropped that API, through the plain issue API.
async function createNumber(it) {
  if (state.mode !== "rest") {
    const body = {
      issue: { title: it.title, body: it.body, closed: it.closed, labels: it.labels, ...(it.createdAt && { created_at: it.createdAt }), ...(it.closed && it.closedAt && { closed_at: it.closedAt }), ...(it.assignees[0] && { assignee: it.assignees[0] }) },
      comments: it.comments.map((c) => ({ body: c.body, created_at: c.createdAt })),
    };
    const r = await api("POST", `repos/${R}/import/issues`, body, { accept: IMPORT_ACCEPT, allowFail: true });
    if (r?.error && /HTTP 404|HTTP 410/.test(r.error) && it.n === 1) {
      say("GitHub's issue import API is gone; using the plain issue API (dates are not kept)");
      state.mode = "rest";
      save();
    } else if (r?.error) {
      stop(`importing #${it.n} failed: ${r.error.slice(0, 400)}. Tell Claude.`);
    } else {
      state.pendingImport = { n: it.n, id: r.id };
      save();
      const got = await waitImport(r.id);
      delete state.pendingImport;
      save();
      return got;
    }
  }
  const made = await api("POST", `repos/${R}/issues`, { title: it.title, body: it.body, labels: it.labels, assignees: it.assignees });
  return made.number;
}

async function finishNumber(it, have) {
  // What the import cannot set: extra assignees, the comments of a plain-API copy, the reason it closed.
  const cur = have || (await api("GET", `repos/${R}/issues/${it.n}`));
  const assignees = cur.assignees.map((a) => a.login);
  const missing = it.assignees.filter((a) => !assignees.includes(a));
  if (missing.length) await api("POST", `repos/${R}/issues/${it.n}/assignees`, { assignees: missing });
  if (cur.comments < it.comments.length) {
    for (const c of it.comments.slice(cur.comments)) {
      await api("POST", `repos/${R}/issues/${it.n}/comments`, { body: c.body });
      await sleep(PAUSE_MS);
    }
  }
  const reason = it.closed ? (it.stateReason || "COMPLETED").toLowerCase() : null;
  if (it.closed && (cur.state !== "closed" || (cur.state_reason || "completed") !== reason)) {
    await api("PATCH", `repos/${R}/issues/${it.n}`, { state: "closed", state_reason: reason });
  }
  if (!it.closed && cur.state !== "open") await api("PATCH", `repos/${R}/issues/${it.n}`, { state: "open" });
}

async function issues(p) {
  step(`Copy every number from #1 to #${p.items.length}: issues with their comments, placeholders for pull requests`);
  if (DRY) {
    for (const it of p.items) {
      say(`#${it.n} ${it.kind === "issue" ? "issue" : it.kind}${it.closed ? " (closed)" : ""}: ${it.title.slice(0, 90)}${it.comments.length ? `, ${it.comments.length} comment(s)` : ""}`);
    }
    return change(`create those ${p.items.length} numbers in order, checking each lands on its own number`);
  }
  let have = await newIssues();
  if (state.pendingImport) {
    say(`finishing the import of #${state.pendingImport.n} that was under way`);
    const got = await waitImport(state.pendingImport.id);
    if (got !== state.pendingImport.n) stop(`the pending import landed on #${got}, not #${state.pendingImport.n}; tell Claude.`);
    delete state.pendingImport;
    save();
    have = await newIssues();
  }
  for (const it of p.items) {
    const h = have.get(it.n);
    if (h) {
      if (h.pull_request || h.title !== it.title) stop(`#${it.n} on ${R} is "${h.title.slice(0, 60)}", not the copy of #${it.n}; tell Claude.`);
      await finishNumber(it, h);
      continue;
    }
    const top = Math.max(0, ...have.keys());
    if (top !== it.n - 1) stop(`the next number on ${R} would be #${top + 1}, not #${it.n}; something else created an issue. Tell Claude.`);
    const got = await createNumber(it);
    if (got !== it.n) stop(`#${it.n} landed on #${got}; something else created an issue. Tell Claude.`);
    await finishNumber(it);
    have.set(it.n, await api("GET", `repos/${R}/issues/${it.n}`));
    if (it.n % 10 === 0 || it.n === p.items.length) say(`#${it.n} of ${p.items.length}`);
    await sleep(PAUSE_MS);
  }
}

async function relations(p) {
  const subs = p.items.filter((i) => i.kind === "issue" && i.subIssues.length);
  const blocked = p.items.filter((i) => i.kind === "issue" && i.blockedBy.length);
  step(`Link ${subs.reduce((a, i) => a + i.subIssues.length, 0)} sub-issues and ${blocked.reduce((a, i) => a + i.blockedBy.length, 0)} blocked-by dependencies`);
  if (DRY) {
    for (const i of subs) say(`#${i.n} gets sub-issues ${i.subIssues.map((s) => `#${s}`).join(" ")}`);
    for (const i of blocked) say(`#${i.n} is blocked by ${i.blockedBy.map((s) => `#${s}`).join(" ")}`);
    return change("add those links in that order");
  }
  const have = await newIssues();
  const id = (n) => have.get(n).id;
  for (const i of subs) {
    const cur = (await api("GET", `repos/${R}/issues/${i.n}/sub_issues?per_page=100`, undefined, { paginate: true })).map((s) => s.number);
    for (const s of i.subIssues) {
      if (cur.includes(s)) continue;
      await api("POST", `repos/${R}/issues/${i.n}/sub_issues`, { sub_issue_id: id(s) });
      await sleep(PAUSE_MS);
    }
  }
  for (const i of blocked) {
    const cur = (await api("GET", `repos/${R}/issues/${i.n}/dependencies/blocked_by?per_page=100`, undefined, { paginate: true })).map((s) => s.number);
    for (const b of i.blockedBy) {
      if (cur.includes(b)) continue;
      await api("POST", `repos/${R}/issues/${i.n}/dependencies/blocked_by`, { issue_id: id(b) });
      await sleep(PAUSE_MS);
    }
  }
  say("linked");
}

async function pullRequests(p, commitMap, movedOn) {
  step(`Recreate the ${p.prs.length} open pull request(s) on their branches`);
  state.prMap ||= {};
  for (const pr of p.prs) {
    if (DRY) {
      await change(`open "${pr.title.slice(0, 70)}" from ${pr.head} as #${pr.predicted} (was #${pr.old}), with its ${pr.comments.length} comment(s), and note it on ${pr.ticket ? `#${pr.ticket}` : "no ticket"} and the map`);
      continue;
    }
    const open = await api("GET", `repos/${R}/pulls?state=all&head=${OWNER}:${encodeURIComponent(pr.head)}`);
    let num = open.find((x) => x.state === "open")?.number;
    if (!num) {
      num = (await api("POST", `repos/${R}/pulls`, { title: pr.title, head: pr.head, base: pr.base, body: pr.body, draft: pr.draft })).number;
      say(`#${pr.old} -> #${num}`);
    }
    state.prMap[pr.old] = num;
    save();
    const have = (await api("GET", `repos/${R}/issues/${num}`)).comments;
    for (const c of pr.comments.slice(have)) {
      await api("POST", `repos/${R}/issues/${num}/comments`, { body: c });
      await sleep(PAUSE_MS);
    }
    if (num !== pr.predicted) {
      const old = p.items[pr.old - 1];
      await api("PATCH", `repos/${R}/issues/${pr.old}`, { body: placeholderBody(old.pr, commitMap, num, movedOn) });
    }
    const note = prNote(pr.old, num, pr.head, movedOn);
    if (pr.ticket) {
      const cs = await api("GET", `repos/${R}/issues/${pr.ticket}/comments?per_page=100`, undefined, { paginate: true });
      if (!cs.some((c) => c.body === note)) await api("POST", `repos/${R}/issues/${pr.ticket}/comments`, { body: note });
    }
  }
  if (DRY) return;
  const map = await api("GET", `repos/${R}/issues/1`);
  const body = remapPrs(map.body, state.prMap);
  if (body !== map.body) {
    await api("PATCH", `repos/${R}/issues/1`, { body });
    say(`the map now links ${Object.entries(state.prMap).map(([o, n]) => `#${n} for #${o}`).join(", ")}`);
  }
}

// Moves this Mac's checkout and every worktree onto the rewritten history (the purge's step 4).
async function moveCheckouts(rw) {
  step("Move this Mac's checkout and every worktree onto the new history");
  const newOf = (c) => {
    const n = rw.commitMap.get(c);
    return n && n !== c ? n : null;
  };
  const inMap = (c) => rw.commitMap.has(c);
  const carries = (dir, rev) => !!run("git", ["log", "-1", "--format=%h", rev, "--", ...PURGED_PATHS], { cwd: dir, allowFail: true }).out.trim();
  const nearest = (dir, rev) => run("git", ["rev-list", "--max-count=500", rev], { cwd: dir }).split("\n").find((c) => c && inMap(c));
  if (!DRY) await gitNet(["fetch", "-q", "--prune", "origin"], { cwd: MAIN_CHECKOUT });
  const wts = git(MAIN_CHECKOUT, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9));
  const checks = [];
  for (const wt of wts) {
    if (!existsSync(wt)) continue;
    const head = git(wt, "rev-parse", "HEAD").trim();
    const branch = run("git", ["symbolic-ref", "-q", "--short", "HEAD"], { cwd: wt, allowFail: true }).out.trim();
    const remoteOld = branch && rw.before[`refs/heads/${branch}`];
    // Each checkout lands on the rewrite of the very commit it is on, so nothing about it changes but the ids.
    const target = remoteOld && head === remoteOld ? rw.after[`refs/heads/${branch}`] : newOf(head);
    if (target) {
      if (target === head) continue;
      const dirty = git(wt, "status", "--porcelain", "--untracked-files=no").trim() ? " (keeping its uncommitted changes)" : "";
      await change(`${wt}: ${head.slice(0, 7)} -> ${target.slice(0, 7)}${dirty}`, () => {
        if (!run("git", ["reset", "-q", "--keep", target], { cwd: wt, allowFail: true }).ok) checks.push(`${wt} has uncommitted changes that clash with the rewrite; left on ${head.slice(0, 7)}`);
      });
      continue;
    }
    if (!carries(wt, head)) continue; // already on the new history
    const base = nearest(wt, head);
    if (!base) {
      checks.push(`${wt} is on ${head.slice(0, 7)}, whose history the rewrite does not know (older than the outreach purge); left as is`);
      continue;
    }
    const n = git(wt, "rev-list", "--count", `${base}..${head}`).trim();
    if (git(wt, "status", "--porcelain", "--untracked-files=no").trim()) {
      checks.push(`${wt} has ${n} local commit(s) and uncommitted changes; left on the old history`);
      continue;
    }
    await change(`${wt}: replay ${n} local commit(s) from ${base.slice(0, 7)} onto ${rw.commitMap.get(base).slice(0, 7)}`, () => {
      if (!run("git", ["rebase", "-q", "--onto", rw.commitMap.get(base), base], { cwd: wt, allowFail: true }).ok) {
        run("git", ["rebase", "--abort"], { cwd: wt, allowFail: true });
        checks.push(`${wt}: its local commits clash with the rewrite; left on the old history`);
      }
    });
  }
  const busy = new Set(
    git(MAIN_CHECKOUT, "worktree", "list", "--porcelain")
      .split("\n")
      .filter((l) => l.startsWith("branch "))
      .map((l) => l.slice(7)),
  );
  for (const l of git(MAIN_CHECKOUT, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads").split("\n").filter(Boolean)) {
    const [ref, sha] = l.split(" ");
    if (busy.has(ref)) continue;
    const n = newOf(sha);
    if (n) await change(`${ref}: ${sha.slice(0, 7)} -> ${n.slice(0, 7)}`, () => git(MAIN_CHECKOUT, "update-ref", ref, n, sha));
    else if (!inMap(sha) && carries(MAIN_CHECKOUT, sha)) checks.push(`${ref} (${sha.slice(0, 7)}) has local commits on the old history or is older than the outreach purge; left as is`);
  }
  checks.forEach((c) => say(`CHECK: ${c}`));
  return checks;
}

// ---- The proof ----------------------------------------------------------------------------------
async function check(snapOld, transform, needles, movedOn) {
  step(`Prove every number of ${R} against the archive`);
  const [o, n] = R.split("/");
  const fresh = await trackerOf(R);
  const newBy = new Map([...fresh.issues.map((i) => [i.number, { kind: "issue", ...i }]), ...fresh.prs.map((x) => [x.number, { kind: "pr", ...x }])]);
  const bad = [];
  const set = (a) => JSON.stringify([...a].sort());
  const prMap = {};
  const notes = new Map();
  for (const pr of snapOld.prs.filter((x) => x.state === "OPEN")) {
    const m = fresh.prs.find((x) => x.headRefName === pr.headRefName && x.state === "OPEN");
    if (!m) continue;
    prMap[pr.number] = m.number;
    if (ticketOf(pr)) notes.set(ticketOf(pr), prNote(pr.number, m.number, pr.headRefName, movedOn));
  }
  for (let k = 1; k <= snapOld.max; k++) {
    const was = snapOld.byNumber.get(k);
    const now = newBy.get(k);
    if (!now) {
      bad.push(`#${k} is missing`);
      continue;
    }
    if (now.kind !== "issue") {
      bad.push(`#${k} is a pull request on ${R}`);
      continue;
    }
    if (!was) continue;
    if (was.kind === "pr") {
      if (now.title !== placeholderTitle(was) || now.state !== "CLOSED") bad.push(`#${k} is not the closed placeholder of pull request #${k}`);
      else if (!now.body.includes(ARCHIVE)) bad.push(`#${k}'s placeholder does not name the archive`);
      continue;
    }
    const diffs = [];
    if (now.title !== transform(was.title)) diffs.push("title");
    if (now.body !== remapPrs(transform(was.body), prMap)) diffs.push("body");
    if (now.state !== was.state) diffs.push(`state ${now.state} (was ${was.state})`);
    if (was.state === "CLOSED" && (now.stateReason || "COMPLETED") !== (was.stateReason || "COMPLETED")) diffs.push(`closed as ${now.stateReason} (was ${was.stateReason})`);
    if (set(now.labels.nodes.map((l) => l.name)) !== set(was.labels.nodes.map((l) => l.name))) diffs.push("labels");
    if (set(now.assignees.nodes.map((l) => l.login)) !== set(was.assignees.nodes.map((l) => l.login))) diffs.push("assignees");
    const want = was.comments.totalCount + (notes.has(k) ? 1 : 0);
    if (now.comments.totalCount !== want) diffs.push(`${now.comments.totalCount} comments (expected ${want})`);
    else if (notes.has(k) && now.comments.nodes[want - 1].body !== notes.get(k)) diffs.push("the note of its moved pull request");
    else if (was.comments.nodes.some((c, j) => now.comments.nodes[j].body !== transform(c.body))) diffs.push("a comment's text");
    if ((now.parent?.number || null) !== (was.parent?.number || null)) diffs.push("parent");
    if (JSON.stringify(now.subIssues.nodes.map((s) => s.number)) !== JSON.stringify(was.subIssues.nodes.map((s) => s.number))) diffs.push("sub-issues or their order");
    if (set(now.blockedBy.nodes.map((b) => b.number)) !== set(was.blockedBy.nodes.map((b) => b.number))) diffs.push("blocked-by");
    if (diffs.length) bad.push(`#${k}: ${diffs.join(", ")}`);
  }
  for (const pr of snapOld.prs.filter((x) => x.state === "OPEN")) {
    const m = fresh.prs.find((x) => x.headRefName === pr.headRefName && x.state === "OPEN");
    if (!m) bad.push(`open pull request #${pr.number} (${pr.headRefName}) was not recreated`);
    else say(`#${pr.number} -> #${m.number} (${pr.headRefName})`);
  }
  say(`${snapOld.max - bad.filter((b) => /^#\d+/.test(b)).length} of ${snapOld.max} numbers match the archive`);
  bad.forEach((b) => say(`MISMATCH ${b}`));

  step(`Scan every object, issue, comment and revision on ${R}`);
  const M = join(STATE_DIR, "check", `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.git`);
  mkdirSync(dirname(M), { recursive: true, mode: 0o700 });
  await gitNet(["clone", "-q", "--mirror", url(NAME), M]);
  const refs = git(M, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean);
  const g = scanGitDir(M, needles);
  say(`${refs.length} refs (${refs.filter((r) => r.startsWith("refs/pull/")).length} pull request refs), ${g.blobs} files, ${g.commits} commits and tags`);
  const t = await scanTracker(o, n, needles);
  say(`${t.issues} issues and ${t.prs} pull requests with their comments, reviews and revisions`);
  const hits = [...g.hits, ...t.hits];
  hits.forEach((h) => say(`HIT ${h}`));

  step("CI on the new repository");
  const runs = await api("GET", `repos/${R}/actions/runs?per_page=20`);
  const mainRun = runs.workflow_runs.find((x) => x.name === "ci" && x.head_branch === "main");
  say(mainRun ? `main: ${mainRun.status}${mainRun.conclusion ? `, ${mainRun.conclusion}` : ""} (${mainRun.html_url})` : "no CI run on main yet");
  for (const pr of fresh.prs.filter((x) => x.state === "OPEN")) {
    const st = await gh(["pr", "checks", String(pr.number), "--repo", R], { allowFail: true });
    const lines = (st.out || "").trim().split("\n").filter(Boolean);
    const pending = lines.filter((l) => /\tpending\t/.test(l)).length;
    const failed = lines.filter((l) => /\tfail\t/.test(l)).length;
    const rabbit = lines.some((l) => /^CodeRabbit\t/i.test(l));
    say(`#${pr.number}: ${lines.length} checks, ${failed} failed, ${pending} pending${rabbit ? "" : "; no CodeRabbit check yet (if none comes, add the repository to CodeRabbit at https://github.com/settings/installations)"}`);
  }
  const ok = !bad.length && !hits.length;
  console.log(ok ? "PASS: every number matches and nothing purged is on the new repository." : "FAIL: see the lines above.");
  return ok;
}

// ---- Main ---------------------------------------------------------------------------------------
async function main() {
  console.log(`${MODE === "check" ? "Check" : DRY ? "Dry run of the move" : "The move"} of ${R} (#167)${DRY ? ": nothing on GitHub or in the checkouts changes" : ""}`);
  const { needles, replacements } = await preflight();
  if (MODE === "check") {
    const where = await whereAreWe();
    if (!where.renamed || !where.created) stop("the move has not happened yet.");
    if (!state.run) stop("there is no record of the pushed rewrite on this Mac.");
    const commitMap = readMap(join(state.run, "rewrite.git"));
    const snap = await snapshot(A);
    const ok = await check(snap, makeTransform(replacements, commitMap), needles, state.movedOn);
    process.exit(ok ? 0 : 1);
  }
  if (!DRY) await installHooks();
  else {
    step("Install the hooks (skipped in a dry run)");
    say(`would install ${HOOKS.join(" and ")} into ${MAIN_CHECKOUT}/.git/hooks unless they are there`);
  }
  const where = await whereAreWe();
  step(`Read the old repository (${OWNER}/${where.oldName}): issues, pull requests, labels, settings`);
  const snap = await snapshot(`${OWNER}/${where.oldName}`);
  say(`#1 to #${snap.max}: ${snap.issues.length} issues, ${snap.prs.length} pull requests (${snap.prs.filter((x) => x.state === "OPEN").length} open), ${snap.labels.length} labels, ${snap.variables.length} variable(s)`);
  const rw = await rewrite(where, needles);
  state.movedOn ||= new Date().toISOString().slice(0, 10);
  const movedOn = state.movedOn;
  const transform = makeTransform(replacements, rw.commitMap);
  step("Build every issue, comment, placeholder and pull request for the new repository, and scan them");
  const p = plan(snap, transform, rw.commitMap, needles, movedOn);
  say(`${p.items.filter((i) => i.kind === "issue").length} issues with ${p.items.reduce((a, i) => a + i.comments.length, 0)} comments, ${p.items.filter((i) => i.kind !== "issue").length} placeholders, ${p.prs.length} pull request(s) to recreate`);
  if (p.hits.length) {
    p.hits.forEach((h) => say(`HIT ${h}`));
    gate("text bound for the new repository holds purged material; nothing changed on GitHub, tell Claude.");
  } else say("clean");
  await quietCheck(where, rw, snap);
  await renameOld(where);
  await createNew(where, snap, rw);
  await actionsSettings(snap);
  await runners();
  await push(rw);
  await labels(snap);
  await issues(p);
  await relations(p);
  await pullRequests(p, rw.commitMap, movedOn);
  const checks = await moveCheckouts(rw);
  save();
  if (DRY) {
    console.log(
      blockers.length
        ? `Dry run complete, nothing changed. The real run would stop at ${blockers.length} blocker(s):\n${blockers.map((b) => `  - ${b}`).join("\n")}`
        : "Dry run complete: every check passed and nothing changed. The real run is: bash scripts/move-repo.sh",
    );
    return;
  }
  const ok = await check(await snapshot(A), transform, needles, movedOn);
  console.log(
    ok
      ? `The move is done. ${R} is new and private; ${A} is the old one, private for good. Tell Claude, who checks CI and asks you before it goes public.`
      : "The move ran, but the check found problems (above). Tell Claude.",
  );
  if (checks.length) console.log("Some checkouts were left as they were (CHECK lines above); tell Claude.");
}

export { makeTransform, placeholderBody, placeholderTitle, remapPrs, ticketOf };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    if (e instanceof Stop) console.log(`  STOP: ${e.message}`);
    else console.log(`  ERROR: ${e.stack || e.message}`);
    process.exit(1);
  });
}
