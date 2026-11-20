// Rebuilds content.json, the site's only content, from what the project already records:
// the map and its tickets on GitHub, README.md and docs/ on origin/main, and the findings on the
// research/* branches.
//
//   npm run refresh
//   npm run refresh -- --dropped      also lists every block the outreach rules dropped
//   npm run refresh -- --ref HEAD     reads README.md and docs/ from another commit than origin/main,
//                                     to see a branch's docs on the site before it merges
//
// The site is public and the record is not, so three filters run in this order:
//   1. Only the owner's own resolution comments are read, and the outreach tickets are skipped.
//   2. Every block of text is judged: one that touches the outreach is dropped, and one that
//      mentions a third party is dropped unless approved.txt lists that exact block.
//   3. The result must pass the privacy gate (private.mjs) before it replaces content.json.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_URL, withRepoLinks } from './links.mjs';
import { assertPublic } from './private.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO = 'imDev2023/testing-pipeline';
const MAIN = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : 'origin/main';
const MAP = 1;

// Tickets about the outreach never appear: these numbers, and any title that reads like one.
const OUTREACH_TICKETS = [5, 27];
const OUTREACH_TITLE = /outreach|\banswers?\b|\bDMs?\b/i;

// A block matching one of these is dropped.
const DROP = [
  /outreach/i,
  /\bDMs?\b/,
  /\b(x|twitter)\.com\//i,
  /research\/x\//,
  /metallegbob\.md/i,
  // What Pipeline's author was asked, what he asked for and what he said.
  /\b(ask|asks|asked|asking|questions?|requests?|answers?|answered|said|says|told)\b[^.]{0,60}\b(metallegbob|him|he)\b/i,
  /\b(metallegbob|he)\b('s)?[^.]{0,40}\b(asked|said|says|told|answers?|answered|requests?|requested|questions?)\b/i,
  /\b(metallegbob|he) is (not )?building\b/i,
  // What the owner leaves to him is a claim about him, not about the suite.
  /\bleaves? it to (metallegbob|him)\b/i,
  /\b(is|are) (metallegbob's|his) to decide\b/i,
  // His profile and the archive of his X posts, which are kept out of the repo.
  /metallegbob's profile|archive of his x posts/i,
  /\badam\b/i,
  /metallegbob's (five )?public repositories|gh repo list/i,
  /metallegbob's (asks?|ideas?|views?|wish(es)?|list|protocol-owned)/i,
  // The address and handle the owner has chosen but not registered yet, and the lookups that say what is free:
  // publishing either invites someone else to register them first. Remove once the owner has registered both.
  /aviary\.(trade|markets|exchange|so|fun|com|xyz|app|fi|io)\b|aviarytrade|@aviary\b/i,
  /`\.(trade|markets)`|\|\s*(free|taken)\s*\|/i,
  // His messages on Telegram; the Telegram bot the map plans is not one of them.
  /telegram (message|chat|group|reply|answer)|(message|chat|said|wrote|answer(ed)?|repl(y|ied)) (on|in|over|via|through) telegram/i,
  ...OUTREACH_TICKETS.map((number) => new RegExp(`/issues/${number}\\b`)),
];

// A block matching one of these mentions a third party: it is dropped unless approved.txt lists it.
// Pipeline's own address is not a mention, and neither is the standing rule that he may change a decision.
const NOT_A_MENTION = [
  /github\.com\/MetalLegBob\/pipeline/gi,
  /Decisions open to MetalLegBob/g,
  /open to MetalLegBob's (review|change)/g,
  /\b(MetalLegBob|he) may change\b/g,
  /\binvit(e|es|ing) (MetalLegBob|him) to change\b/g,
];
const REVIEW = [/metallegbob|mlbob/i, /\b(he|him|his)\b/i, /\b[Tt]he Factory\b/, /fantastical|fffactory/i];

// Paths on the owner's machine are cut down to the part that says something.
const SCRUB = [
  [/\/Volumes\/[^/`\s]+\/Work Folder\/Dev\/(AI\/)?/g, ''],
  [/\/Users\/[^/`\s]+\//g, '~/'],
];

// README.md's first line, which names the suite and says what it is.
const INTRODUCTION = /^The internal home of ([^:]+): (.+)$/;

// The owner's standing rule in the map's Notes, shown above the decisions: "<name> (owner, <date>): <sentence>."
const STANDING_RULE = /^- (Built for [^(:]+?) \(owner, [\d-]+\): ([^.]+\.)/m;

// What we found in Pipeline itself: the block of each source that contains the phrase, shown as written.
const FOUND_IN_PIPELINE = [
  { from: '/15/', phrase: 'fail every quote and swap' },
  { from: '/6/', phrase: 'The router never reports strategy upgrades' },
  { from: '/12/', phrase: 'Call depth inside a Pipeline swap' },
  { from: '/7/', phrase: 'WASM in a Worker: ruled out' },
  { from: '/2/', phrase: 'Node 26 against public devnet' },
  { from: '/toolchain/', phrase: "in Pipeline's `docs/DEVNET.md`" },
];

// ---- Reading the record ----

function run(command, args) {
  // GitHub is flaky on this network (docs/toolchain.md): a call can fail, or hang for good.
  // So every call gets ninety seconds and a few quiet tries.
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(command, args, {
        cwd: here,
        encoding: 'utf8',
        maxBuffer: 64 << 20,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 90_000,
      });
    } catch (error) {
      if (attempt === 4) fail(`${command} ${args.join(' ')} failed four times:\n${error.stderr || error.message}`);
    }
  }
}

const github = (path) => JSON.parse(run('gh', ['api', `repos/${REPO}/${path}`]));
const git = (...args) => run('git', args).trimEnd();
const fileAt = (ref, path) => git('show', `${ref}:${path}`);

function sectionsOf(markdown) {
  const sections = {};
  let name = null;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = line.match(/^## (.+)$/);
    if (heading) sections[(name = heading[1].trim())] = '';
    else if (name) sections[name] += `${line}\n`;
  }
  return sections;
}

function fail(message) {
  console.error(`\nrefresh: ${message}\n`);
  process.exit(1);
}

// ---- Judging blocks ----

const approvedPath = join(here, 'approved.txt');
const approved = new Map(
  readFileSync(approvedPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => [line, false]),
);
const held = [];
const dropped = [];
const leftOutWhole = []; // decisions of the register with a line that may not be shown

/** 'keep', or why not. */
function judge(text, where) {
  // "Answer:" and "Question:" at the head of a register field are labels, not someone answering or asking.
  const said = text.replace(/^(Question|Answer): /, '');
  if (DROP.some((pattern) => pattern.test(said))) {
    dropped.push({ where, text });
    return 'dropped';
  }
  const rest = NOT_A_MENTION.reduce((left, phrase) => left.replace(phrase, ''), text);
  if (!REVIEW.some((pattern) => pattern.test(rest))) return 'keep';
  if (approved.has(text)) {
    approved.set(text, true);
    return 'keep';
  }
  held.push({ where, text });
  return 'held';
}

/** Splits Markdown into the blocks that are judged one by one: paragraphs, list items, table rows, headings, code. */
function blocksOf(markdown) {
  const blocks = [];
  let open = null; // the paragraph or list item a plain line continues
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.match(/^ */)[0].length;
    if (/^\s*(```|~~~)/.test(line)) {
      const fence = line.trim().slice(0, 3);
      const body = [line];
      while (++i < lines.length) {
        body.push(lines[i]);
        if (lines[i].trim().startsWith(fence)) break;
      }
      blocks.push({ kind: 'code', indent, lines: body });
      open = null;
    } else if (line.trim() === '') {
      blocks.push({ kind: 'blank', lines: [''] });
      open = null;
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push({ kind: 'heading', indent, level: line.match(/^#+/)[0].length, lines: [line] });
      open = null;
    } else if (/^\s*\|/.test(line)) {
      blocks.push({ kind: 'row', indent, lines: [line] });
      open = null;
    } else if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      blocks.push((open = { kind: 'item', indent, lines: [line] }));
    } else if (open) {
      open.lines.push(line);
    } else {
      blocks.push((open = { kind: 'para', indent, lines: [line] }));
    }
  }
  return blocks;
}

/** A block as one line of text, without its list or heading marker. */
const textOf = (block) =>
  block.lines
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^([-*+]|\d+[.)]|#+)\s+/, '');

/**
 * Returns the Markdown with every block that may not be shown removed.
 * With `wholeSections` set to a heading level, a section under a heading of that level is shown whole
 * or not at all: a decision in the register must never appear with one of its fields missing.
 */
function publicPartOf(markdown, where, wholeSections = 0) {
  const kept = [];
  const broken = []; // ranges of `kept` that belong to a section with a block left out
  let section = null;
  let cut = null; // indent of a dropped list item: what is nested under it goes with it
  const closeSection = () => {
    if (section?.broken) {
      broken.push([section.from, kept.length]);
      leftOutWhole.push(section.name);
    }
    section = null;
  };
  for (const block of blocksOf(markdown.replace(/<!--[\s\S]*?-->/g, ''))) {
    if (block.kind === 'blank') {
      kept.push(block);
      continue;
    }
    if (wholeSections && block.kind === 'heading' && block.level <= wholeSections) {
      closeSection();
      if (block.level === wholeSections) {
        section = { from: kept.length, broken: false, name: textOf(block).split(':')[0] };
      }
    }
    if (cut !== null && block.indent > cut) continue;
    cut = null;
    if (judge(textOf(block), where) === 'keep') {
      kept.push(block);
      continue;
    }
    if (section) section.broken = true;
    if (block.kind === 'item') cut = block.indent;
  }
  closeSection();
  for (const [from, to] of broken.reverse()) kept.splice(from, to - from);

  // A table that lost its header, or every row under it, goes whole.
  const isRule = (block) => /^\s*\|[\s:|-]+\|\s*$/.test(block.lines[0]);
  for (let i = 0; i < kept.length; ) {
    let end = i;
    while (kept[end]?.kind === 'row') end++;
    const sound = end - i >= 3 && !isRule(kept[i]) && isRule(kept[i + 1]);
    if (end === i) i++;
    else if (sound) i = end;
    else kept.splice(i, end - i);
  }

  // A heading whose content was dropped goes too.
  for (let again = true; again; ) {
    again = false;
    for (let i = 0; i < kept.length && !again; i++) {
      const after = kept.slice(i + 1).find((block) => block.kind !== 'blank');
      again = kept[i].kind === 'heading' && (!after || (after.kind === 'heading' && after.level <= kept[i].level));
      if (again) kept.splice(i, 1);
    }
  }

  return kept
    .flatMap((block) => block.lines)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- Links ----

/**
 * What the repository holds, for the link checks in links.mjs: read from this clone, and from GitHub for
 * what the clone lacks (tags, the commits of merged pull requests whose branch is gone).
 * A link names `main`, so it is checked against origin/main even when --ref reads the docs from elsewhere.
 */
const answers = new Map();
const remembered = (key, answer) => (answers.has(key) ? answers.get(key) : answers.set(key, answer()).get(key));
const repo = {
  kind: (ref, path) => remembered(`kind ${ref}:${path}`, () => kindHere(ref, path) ?? kindOnGitHub(ref, path)),
  text: (ref, path) =>
    remembered(`text ${ref}:${path}`, () => {
      const at = localRef(ref);
      const local = at && spawnSync('git', ['show', `${at}:${path}`], { cwd: here, encoding: 'utf8', maxBuffer: 64 << 20 });
      return local?.status === 0 ? local.stdout : onGitHub(`contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`, true);
    }),
  lastNumber: () => remembered('last number', () => github('issues?state=all&sort=created&direction=desc&per_page=1')[0].number),
};

/** The ref of this clone that a GitHub ref names, or null when this clone cannot vouch for it. */
function localRef(ref) {
  if (ref === 'main') return 'origin/main';
  if (!/^[0-9a-f]{7,40}$/.test(ref)) return `origin/${ref}`;
  // A commit counts here only when a branch of origin holds it: this clone may keep commits GitHub does not.
  const on = spawnSync('git', ['for-each-ref', '--count=1', '--contains', ref, 'refs/remotes/origin'], { cwd: here, encoding: 'utf8' });
  return on.status === 0 && on.stdout.trim() ? ref : null;
}

function kindHere(ref, path) {
  const at = localRef(ref);
  const type = at && spawnSync('git', ['cat-file', '-t', path ? `${at}:${path}` : at], { cwd: here, encoding: 'utf8' });
  return type?.status === 0 ? ({ blob: 'blob', tree: 'tree', commit: 'tree' }[type.stdout.trim()] ?? null) : null;
}

function kindOnGitHub(ref, path) {
  if (!path) return onGitHub(`commits/${encodeURIComponent(ref)}`) ? 'tree' : null;
  const found = onGitHub(`contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`);
  if (!found) return null;
  return Array.isArray(found) ? 'tree' : found.type === 'file' ? 'blob' : null;
}

/** GitHub's answer for a path of the repo's API, or null when it is not there; `raw` asks for a file's text. */
function onGitHub(path, raw = false) {
  const args = ['api', `repos/${REPO}/${path}`, ...(raw ? ['-H', 'Accept: application/vnd.github.raw'] : [])];
  for (let attempt = 1; ; attempt++) {
    const answer = spawnSync('gh', args, { cwd: here, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 90_000 });
    if (answer.status === 0) return raw ? answer.stdout : JSON.parse(answer.stdout);
    if (/HTTP (404|422)/.test(answer.stderr ?? '')) return null;
    if (attempt === 4) fail(`gh ${args.join(' ')} failed four times:\n${answer.stderr || answer.error?.message}`);
  }
}

/** The text with links into the repository pointing at it, and with paths on the owner's machine cut down. */
function withPublicLinks(markdown, folder = '', ref = 'main') {
  for (const [pattern, replacement] of SCRUB) markdown = markdown.replace(pattern, replacement);
  try {
    return withRepoLinks(markdown, { folder, ref, repo });
  } catch (error) {
    fail(`${error.message} Fix the link at its source.`);
  }
}

// ---- The record, read ----

git('fetch', '--quiet', '--prune', 'origin');

const readme = fileAt(MAIN, 'README.md').split('\n');
const map = sectionsOf(github(`issues/${MAP}`).body);

const decisions = new Map();
for (const line of map['Decisions so far'].split('\n')) {
  const decision = line.match(/^- \[.+?\]\([^)]*\/issues\/(\d+)\): (.+)$/);
  if (decision) decisions.set(Number(decision[1]), decision[2]);
}

const RESOLUTION = /^(#+ *)?Resol(ution|ved)\b/i;
const unresolved = [];
const tickets = [];
for (const issue of github(`issues/${MAP}/sub_issues?per_page=100`)) {
  if (OUTREACH_TICKETS.includes(issue.number) || OUTREACH_TITLE.test(issue.title)) continue;
  if (issue.state === 'closed' && issue.state_reason !== 'completed') continue; // dropped, not done
  if (judge(issue.title, `ticket ${issue.number}, title (the ticket is left out until this is settled)`) !== 'keep') continue;

  const ticket = { number: issue.number, title: issue.title };
  if (issue.state === 'open') {
    ticket.state = issue.assignees.length ? 'in progress' : 'next';
  } else {
    ticket.state = 'done';
    ticket.closed = issue.closed_at;
    ticket.decision = decisions.get(issue.number) ?? null;
    const comments = github(`issues/${issue.number}/comments?per_page=100`)
      .filter((comment) => comment.author_association === 'OWNER')
      .map((comment) => comment.body.trim());
    // The resolution is the comment that says so, with any addendum or follow-up after it.
    const first = comments.findIndex((body) => RESOLUTION.test(body));
    ticket.resolution =
      first < 0
        ? null
        : comments
            .slice(first)
            .filter((body) => RESOLUTION.test(body) || /^(Addendum|Follow-up)\b/i.test(body))
            .map((body) => body.replace(/^#+ *Resol.*\n/i, ''))
            .join('\n\n');
    if (!ticket.resolution) unresolved.push(issue.number);
  }
  tickets.push(ticket);
}

const rank = { done: 0, 'in progress': 1, next: 2 };
tickets.sort(
  (a, b) =>
    rank[a.state] - rank[b.state] ||
    (b.closed ?? '').localeCompare(a.closed ?? '') ||
    a.number - b.number,
);

const documents = [];
const homes = new Map(); // where each document sits in the repo, for the links written relative to it
const addDocument = (ref, file) => {
  const path = file.replace(/^docs\//, '').replace(/\.md$/, '');
  const markdown = fileAt(ref, file);
  const title = markdown.match(/^# (.+)$/m);
  if (!title) fail(`${file} has no title.`);
  if (judge(title[1].trim(), `${path}, title (the document is left out until this is settled)`) !== 'keep') return;
  documents.push({ path, title: title[1].trim(), body: markdown.replace(title[0], '') });
  // A research branch's findings link to that branch; everything else was read from main (or --ref).
  homes.set(path, { folder: posix.dirname(file), ref: ref.startsWith('origin/') ? ref.slice('origin/'.length) : 'main' });
};
const onMain = git('ls-tree', '--full-tree', '--name-only', '-r', MAIN, 'docs/').split('\n');
// The decision register arrives with "Decision register open to MetalLegBob's review"; until then there is none.
for (const file of ['docs/decisions.md', 'docs/toolchain.md']) if (onMain.includes(file)) addDocument(MAIN, file);
for (const file of onMain) if (/^docs\/spec\/[^/]+\.md$/.test(file)) addDocument(MAIN, file);
for (const ref of git('for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/research/').split('\n')) {
  const name = ref.split('/').pop();
  addDocument(ref, `research/${name}.md`);
}

// ---- The record, made public ----

const shown = (markdown, where, home = {}, wholeSections = 0) =>
  withPublicLinks(publicPartOf(markdown, where, wholeSections), home.folder, home.ref);

for (const ticket of tickets) {
  const where = `ticket ${ticket.number}`;
  if (ticket.decision) ticket.decision = shown(ticket.decision, `${where}, decision`) || null;
  if (ticket.resolution) ticket.resolution = shown(ticket.resolution, where);
}
for (const document of documents) {
  // In the register a decision is a third-level section.
  document.body = shown(document.body, document.path, homes.get(document.path), document.path === 'decisions' ? 3 : 0);
}

const sources = new Map([
  ...tickets.filter((ticket) => ticket.resolution).map((ticket) => [`/${ticket.number}/`, ticket.resolution]),
  ...documents.map((document) => [`/${document.path}/`, document.body]),
]);
const pipeline = FOUND_IN_PIPELINE.map(({ from, phrase }) => {
  const matches = blocksOf(sources.get(from) ?? '')
    .filter((block) => block.kind === 'item' || block.kind === 'para')
    .map(textOf)
    .filter((text) => text.includes(phrase));
  if (matches.length !== 1) {
    fail(`"${phrase}" should be in exactly one block of ${from} and is in ${matches.length}. Fix FOUND_IN_PIPELINE.`);
  }
  return { finding: matches[0], from };
});

// Everything shown rests on decisions that Pipeline's author may change, and the site has to say so.
const rule = map.Notes.match(STANDING_RULE);
if (!rule) fail('The standing rule is no longer in the map\'s Notes in the form STANDING_RULE expects. Fix STANDING_RULE.');
const [, ruleName, ruleText] = rule;
if (judge(ruleName, 'the map, standing rule') !== 'keep' || judge(ruleText, 'the map, standing rule') !== 'keep') {
  fail('The standing rule mentions a third party, so both its name and its sentence need a line in approved.txt.');
}

// The public name and what it is, from the one line of README.md that holds both.
const introduction = readme.find((line) => line.trim() && !line.startsWith('#')).match(INTRODUCTION);
if (!introduction) fail('The first line of README.md no longer reads "The internal home of <name>: <what it is>". Fix INTRODUCTION.');

const content = {
  refreshed: new Date().toISOString().slice(0, 10),
  name: introduction[1],
  statement: introduction[2],
  destination: shown(map.Destination, 'the map, Destination'),
  rule: { name: ruleName, text: ruleText },
  tickets,
  pipeline,
  documents,
};

// ---- Checks, then the swap ----

const json = `${JSON.stringify(content, null, 2)}\n`;
// Of the owner's repositories only this one is shown: the others, the private archive among them, may be private.
const leak = json.match(/github\.com\/imDev2023\/(?!testing-pipeline(?:\.git)?(?![\w.-]))\S*|claude\.ai\/|\/Volumes\/|\/Users\//i);
if (leak) fail(`"${leak[0]}" is still in the content. Extend the link or path rules.`);

// If the gate stops here, content.next.json stays (untracked) so the lines it names can be read.
const next = join(here, 'content.next.json');
writeFileSync(next, json);
assertPublic(next);
renameSync(next, join(here, 'content.json'));

const count = (state) => tickets.filter((ticket) => ticket.state === state).length;
console.log(
  `content.json: ${count('done')} done, ${count('in progress')} in progress, ${count('next')} next, ` +
    `${documents.length} documents, with docs from ${MAIN} at ${git('rev-parse', '--short', MAIN)}.`,
);
console.log(`Dropped ${dropped.length} blocks that touch the outreach (npm run refresh -- --dropped lists them).`);
if (process.argv.includes('--dropped')) {
  for (const { where, text } of dropped) console.log(`\n# ${where}\n${text}`);
}
if (held.length) {
  console.log(`\nHeld back ${held.length} blocks that mention a third party.`);
  console.log('To show one, read it against the privacy rules in README.md, then add its line to approved.txt:\n');
  for (const { where, text } of held) console.log(`# ${where}\n${text}\n`);
}
if (leftOutWhole.length) {
  console.log(`\nDecisions left out of the register whole, because a line of theirs may not be shown: ${leftOutWhole.join(', ')}.`);
}
if (unresolved.length) {
  console.log(`\nDone without a page, because no comment of theirs starts with "Resolution" or "Resolved": ${unresolved.map((number) => `#${number}`).join(', ')}.`);
}
const unused = [...approved].filter(([, used]) => !used).map(([text]) => text);
if (unused.length) {
  console.log(`\n${unused.length} lines of approved.txt match nothing any more and can go:\n`);
  for (const text of unused) console.log(`${text}\n`);
}
