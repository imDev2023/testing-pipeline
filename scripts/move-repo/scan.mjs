// Finds the purged material in text: MetalLegBob's profile, the archive of his X posts, the lines of
// the owner's private outreach file and the marks of the outreach wording removed on 2026-11-10.
// All of it is read from ~/.config/testing-pipeline/ at run time and never printed: a hit names
// only where it is and which source it matches (an X post id, a profile line number, a private line
// number), never the matched text.
//
// Two kinds of needle:
//   - any run of SHINGLE words of a post or of the profile, compared word for word after folding
//     case, quotes and punctuation, so a quote survives being rewrapped or re-punctuated;
//   - each private line and mark as a case-insensitive phrase, as the purge's own checks use them.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, graphqlAll } from "./run.mjs";

export const CFG = process.env.TP_CONFIG_DIR || join(homedir(), ".config", "testing-pipeline");
export const SHINGLE = 8;

// The paths the purge removes from every commit (owner, 2026-11-10).
export const PURGED_PATHS = ["research/metallegbob.md", "research/x/"];

export function words(text) {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[‘’ʼ]/g, "'")
      .replace(/https?:\/\/\S+/g, " ")
      // File names, such as the archive's own, are references, not words.
      .replace(/[\p{L}\p{N}_./-]*\.(?:md|jsonl|txt|json)\b/gu, " ")
      .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) || []
  );
}

function flat(text) {
  return text.normalize("NFKC").toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ");
}

function addShingles(set, srcOf, text, src) {
  const w = words(text);
  for (let i = 0; i + SHINGLE <= w.length; i++) {
    const k = w.slice(i, i + SHINGLE).join(" ");
    if (!set.has(k)) {
      set.add(k);
      srcOf.set(k, src);
    }
  }
}

function lines(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

// Everything the scan needs, or a thrown error naming the missing source.
export function loadNeedles(cfg = CFG) {
  const need = {
    profile: join(cfg, "research", "metallegbob.md"),
    x: join(cfg, "research", "x"),
    privateLines: join(cfg, "private-lines.txt"),
    marks: join(cfg, "purge", "marks.txt"),
  };
  for (const [name, path] of Object.entries(need)) {
    if (!existsSync(path)) throw new Error(`the scan's ${name} source is missing (${path})`);
  }
  const shingles = new Set();
  const srcOf = new Map();
  const phrases = [];
  const marks = [];

  const posts = readdirSync(need.x).filter((f) => f.endsWith(".jsonl"));
  if (!posts.length) throw new Error(`no .jsonl post archive in ${need.x}`);
  let n = 0;
  for (const f of posts) {
    for (const line of lines(join(need.x, f))) {
      const p = JSON.parse(line);
      for (const t of [p.text, p.raw_text, p.quote?.text, p.article?.text, p.article?.title]) {
        if (typeof t === "string") addShingles(shingles, srcOf, t, `x post ${p.id}`);
      }
      n++;
    }
  }
  if (n < 100) throw new Error(`the post archive holds only ${n} posts; expected the full archive`);

  readFileSync(need.profile, "utf8")
    .split("\n")
    .forEach((l, i) => addShingles(shingles, srcOf, l, `profile line ${i + 1}`));

  lines(need.privateLines).forEach((l, i) => {
    phrases.push({ p: flat(l), src: `private line ${i + 1}` });
    addShingles(shingles, srcOf, l, `private line ${i + 1}`);
  });
  lines(need.marks).forEach((l, i) => marks.push({ p: flat(l), src: `outreach mark ${i + 1}` }));
  if (phrases.length < 10 || marks.length < 3) throw new Error("the private lines or the marks look truncated");

  return { shingles, srcOf, phrases, marks, posts: n };
}

// The sources a text matches, at most `max` of them; empty when it is clean. The marks are plain
// English phrases that identify the old outreach wording only where it lived, so they are checked
// only when `marks` is set: in research/outreach.md and on the map and the follow-up ticket.
export function findIn(text, needles, { marks = false, max = 5 } = {}) {
  const hits = new Set();
  const f = flat(text);
  for (const { p, src } of marks ? [...needles.phrases, ...needles.marks] : needles.phrases) {
    if (f.includes(p)) hits.add(src);
    if (hits.size >= max) return [...hits];
  }
  const w = words(text);
  for (let i = 0; i + SHINGLE <= w.length; i++) {
    const k = w.slice(i, i + SHINGLE).join(" ");
    if (needles.shingles.has(k)) hits.add(needles.srcOf.get(k));
    if (hits.size >= max) break;
  }
  return [...hits];
}

// Where the old outreach wording lived, so where the marks apply (the purge's own checks).
export const MARKS_PATH = "research/outreach.md";
export const MARKS_ISSUES = [1, 27];

// Every hit in a git repository: any commit that touches a purged path, and the purged material in
// any blob or commit or tag message of every object the repository holds. Returns lines to print.
export function scanGitDir(dir, needles) {
  const out = [];
  const touched = run("git", ["log", "--all", "--format=%h", "--", ...PURGED_PATHS], { cwd: dir }).trim();
  if (touched) out.push(`commits touch the purged paths: ${touched.split("\n").slice(0, 5).join(" ")}`);
  const paths = new Map();
  for (const l of run("git", ["rev-list", "--objects", "--all"], { cwd: dir }).split("\n")) {
    const sp = l.indexOf(" ");
    if (sp > 0) paths.set(l.slice(0, sp), l.slice(sp + 1));
  }
  const all = run("git", ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    cwd: dir,
  })
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" "));
  let blobs = 0;
  let commits = 0;
  const want = [];
  for (const [sha, type, size] of all) {
    if (type === "tree") continue;
    if (type === "blob" && +size > 20e6) out.push(`blob ${sha.slice(0, 10)} (${paths.get(sha) || "unreachable"}) is too big to scan`);
    else want.push(sha);
  }
  // One git process reads every object: "<sha> <type> <size>\n<content>\n" each.
  const r = spawnSync("git", ["cat-file", "--batch"], { cwd: dir, input: want.join("\n") + "\n", maxBuffer: 2 ** 31 - 1 });
  if (r.status !== 0) throw new Error(`git cat-file --batch failed in ${dir}`);
  const buf = r.stdout;
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    const [sha, type, size] = buf.subarray(at, nl).toString().split(" ");
    const body = buf.subarray(nl + 1, nl + 1 + +size);
    at = nl + 1 + +size + 1;
    if (type === "blob" && body.includes(0)) continue;
    const path = paths.get(sha) || "";
    const hits = findIn(body.toString("utf8"), needles, { marks: path === MARKS_PATH });
    if (type === "blob") blobs++;
    else commits++;
    if (hits.length) out.push(`${type} ${sha.slice(0, 10)} ${path ? `(${path}) ` : ""}matches ${hits.join("; ")}`);
  }
  return { hits: out, blobs, commits };
}

const ISSUE_TEXT = `number title body userContentEdits(first:100){totalCount nodes{diff}}
  comments(first:100){totalCount nodes{body userContentEdits(first:100){totalCount nodes{diff}}}}`;

// Every hit in a repository's issues and pull requests: titles, bodies, comments, reviews, review
// comments, and every edit revision GitHub keeps of a body or a comment.
export async function scanTracker(owner, name, needles) {
  const out = [];
  const issues = await graphqlAll(
    `query($o:String!,$n:String!,$after:String){repository(owner:$o,name:$n){issues(first:20,after:$after){pageInfo{hasNextPage endCursor} nodes{${ISSUE_TEXT}}}}}`,
    ["repository", "issues"],
    { o: owner, n: name },
  );
  const prs = await graphqlAll(
    `query($o:String!,$n:String!,$after:String){repository(owner:$o,name:$n){pullRequests(first:10,after:$after){pageInfo{hasNextPage endCursor} nodes{${ISSUE_TEXT}
      reviews(first:50){totalCount nodes{body comments(first:100){totalCount nodes{body userContentEdits(first:50){nodes{diff}}}}}}}}}}`,
    ["repository", "pullRequests"],
    { o: owner, n: name },
  );
  const check = (where, text, marks) => {
    const hits = findIn(text || "", needles, { marks });
    if (hits.length) out.push(`${where} matches ${hits.join("; ")}`);
  };
  const full = (where, c) => {
    if (c.totalCount > c.nodes.length) out.push(`${where}: more than ${c.nodes.length} entries, not all scanned`);
  };
  for (const [kind, list] of [
    ["issue", issues],
    ["pull request", prs],
  ]) {
    for (const i of list) {
      const at = `${kind} #${i.number}`;
      const marks = MARKS_ISSUES.includes(i.number);
      check(`${at} title`, i.title, marks);
      check(`${at} body`, i.body, marks);
      full(`${at} body revisions`, i.userContentEdits);
      i.userContentEdits.nodes.forEach((e, k) => check(`${at} body revision ${k + 1}`, e.diff, marks));
      full(`${at} comments`, i.comments);
      i.comments.nodes.forEach((c, k) => {
        check(`${at} comment ${k + 1}`, c.body, marks);
        full(`${at} comment ${k + 1} revisions`, c.userContentEdits);
        c.userContentEdits.nodes.forEach((e, j) => check(`${at} comment ${k + 1} revision ${j + 1}`, e.diff, marks));
      });
      for (const [k, r] of (i.reviews?.nodes || []).entries()) {
        check(`${at} review ${k + 1}`, r.body, marks);
        full(`${at} review ${k + 1} comments`, r.comments);
        r.comments.nodes.forEach((c, j) => {
          check(`${at} review ${k + 1} comment ${j + 1}`, c.body, marks);
          c.userContentEdits.nodes.forEach((e, m) => check(`${at} review ${k + 1} comment ${j + 1} revision ${m + 1}`, e.diff, marks));
        });
      }
    }
  }
  return { hits: out, issues: issues.length, prs: prs.length };
}
