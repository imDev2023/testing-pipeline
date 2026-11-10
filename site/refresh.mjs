// Rebuilds content.json, the site's only content, from what the project already records:
// the map and its tickets on GitHub, README.md and docs/ on origin/main, and the findings on the
// research/* branches.
//
//   npm run refresh
//   npm run refresh -- --dropped    also lists every block the outreach rules dropped
//
// The site is public and the record is not, so three filters run in this order:
//   1. Only the owner's own resolution comments are read, and the outreach tickets are skipped.
//   2. Every block of text is judged: one that touches the outreach is dropped, and one that
//      mentions a third party is dropped unless approved.txt lists that exact block.
//   3. The result must pass the privacy gate (private.mjs) before it replaces content.json.

import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublic } from './private.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO = 'imDev2023/testing-pipeline';
const REPO_URL = `https://github.com/${REPO}`;
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
  /\badam\b/i,
  /metallegbob's (five )?public repositories|gh repo list/i,
  /metallegbob's (asks?|ideas?|views?|wish(es)?|list|protocol-owned)/i,
  // His messages on Telegram; the Telegram bot the map plans is not one of them.
  /telegram (message|chat|group|reply|answer)|(message|chat|said|wrote|answer(ed)?|repl(y|ied)) (on|in|over|via|through) telegram/i,
  ...OUTREACH_TICKETS.map((number) => new RegExp(`/issues/${number}\\b`)),
];

// A block matching one of these mentions a third party: it is dropped unless approved.txt lists it.
// Pipeline's own address is not a mention.
const PIPELINE = /github\.com\/MetalLegBob\/pipeline/gi;
const REVIEW = [/metallegbob|mlbob/i, /\b(he|him|his)\b/i, /\b[Tt]he Factory\b/, /fantastical|fffactory/i];

// Paths on the owner's machine are cut down to the part that says something.
const SCRUB = [
  [/\/Volumes\/[^/`\s]+\/Work Folder\/Dev\/(AI\/)?/g, ''],
  [/\/Users\/[^/`\s]+\//g, '~/'],
];

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
  // GitHub is flaky on this network (docs/toolchain.md), so every call gets a few quiet tries.
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(command, args, {
        cwd: here,
        encoding: 'utf8',
        maxBuffer: 64 << 20,
        stdio: ['ignore', 'pipe', 'pipe'],
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

/** 'keep', or why not. */
function judge(text, where) {
  if (DROP.some((pattern) => pattern.test(text))) {
    dropped.push({ where, text });
    return 'dropped';
  }
  const withoutPipeline = text.replace(PIPELINE, '');
  if (!REVIEW.some((pattern) => pattern.test(withoutPipeline))) return 'keep';
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

const textOf = (block) =>
  block.lines
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^([-*+]|\d+[.)])\s+/, '');

/** Returns the Markdown with every block that may not be shown removed. */
function publicPartOf(markdown, where) {
  const kept = [];
  let cut = null; // indent of a dropped list item: what is nested under it goes with it
  for (const block of blocksOf(markdown.replace(/<!--[\s\S]*?-->/g, ''))) {
    if (block.kind === 'blank') {
      kept.push(block);
      continue;
    }
    if (cut !== null && block.indent > cut) continue;
    cut = null;
    if (judge(textOf(block), where) === 'keep') kept.push(block);
    else if (block.kind === 'item') cut = block.indent;
  }

  // A heading or a table header whose content was dropped goes too.
  for (let again = true; again; ) {
    again = false;
    for (let i = 0; i < kept.length && !again; i++) {
      const after = kept.slice(i + 1).find((block) => block.kind !== 'blank');
      const emptyHeading =
        kept[i].kind === 'heading' && (!after || (after.kind === 'heading' && after.level <= kept[i].level));
      const emptyTable =
        kept[i].kind === 'row' &&
        kept[i - 1]?.kind !== 'row' &&
        kept[i + 1]?.kind === 'row' &&
        kept[i + 2]?.kind !== 'row';
      if (emptyHeading) kept.splice(i, 1);
      if (emptyTable) kept.splice(i, 2);
      again = emptyHeading || emptyTable;
    }
  }

  return kept
    .flatMap((block) => block.lines)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- Links ----

/** The site's page for a link into the private repo, or null when there is none. */
function pageFor(url, pages) {
  const path = url.slice(REPO_URL.length).replace(/[#?].*$/, '');
  const ticket = path.match(/^\/issues\/(\d+)$/);
  const research = path.match(/^\/blob\/research\/([^/]+)\/research\/\1\.md$/);
  const doc = path.match(/^\/blob\/main\/docs\/(.+)\.md$/);
  const page = ticket
    ? `/${ticket[1]}/`
    : research
      ? `/research/${research[1]}/`
      : doc
        ? `/${doc[1]}/`
        : null;
  return pages.has(page) ? page : null;
}

/** Points links at the site's own pages and unwraps the ones a visitor could not open. */
function withPublicLinks(markdown, pages) {
  for (const [pattern, replacement] of SCRUB) markdown = markdown.replace(pattern, replacement);
  return markdown
    .replace(/\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^)\s]+)\)/g, (link, text, url) => {
      if (url.startsWith(REPO_URL)) {
        const page = pageFor(url, pages);
        return page ? `[${text}](${page})` : text;
      }
      if (/^https:\/\/claude\.ai\//.test(url) || !/^(https?:|#)/.test(url)) return text;
      return link;
    })
    .replace(new RegExp(`(?<!\\]\\()${REPO_URL}/[^\\s)]+`, 'g'), (url) => {
      const page = pageFor(url, pages);
      if (!page) fail(`${url} is a bare link into the private repo with no page on the site.`);
      return `[${url.split('/').pop()}](${page})`;
    });
}

// ---- The record, read ----

git('fetch', '--quiet', '--prune', 'origin');

const readme = fileAt('origin/main', 'README.md').split('\n');
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
const addDocument = (path, markdown) => {
  const title = markdown.match(/^# (.+)$/m);
  if (!title) fail(`${path} has no title.`);
  if (judge(title[1].trim(), `${path}, title (the document is left out until this is settled)`) !== 'keep') return;
  documents.push({ path, title: title[1].trim(), body: markdown.replace(title[0], '') });
};
addDocument('toolchain', fileAt('origin/main', 'docs/toolchain.md'));
for (const file of git('ls-tree', '--full-tree', '--name-only', 'origin/main', 'docs/spec/').split('\n')) {
  if (file.endsWith('.md')) addDocument(file.slice('docs/'.length, -'.md'.length), fileAt('origin/main', file));
}
for (const ref of git('for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/research/').split('\n')) {
  const name = ref.split('/').pop();
  addDocument(`research/${name}`, fileAt(ref, `research/${name}.md`));
}

// ---- The record, made public ----

const pages = new Set([
  ...tickets.filter((ticket) => ticket.resolution).map((ticket) => `/${ticket.number}/`),
  ...documents.map((document) => `/${document.path}/`),
]);
const shown = (markdown, where) => withPublicLinks(publicPartOf(markdown, where), pages);

for (const ticket of tickets) {
  const where = `ticket ${ticket.number}`;
  if (ticket.decision) ticket.decision = shown(ticket.decision, `${where}, decision`) || null;
  if (ticket.resolution) ticket.resolution = shown(ticket.resolution, where);
}
for (const document of documents) document.body = shown(document.body, document.path);

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

const content = {
  refreshed: new Date().toISOString().slice(0, 10),
  commit: git('rev-parse', '--short', 'origin/main'),
  name: readme.find((line) => line.startsWith('# ')).slice(2).trim(),
  statement: readme.find((line) => line.trim() && !line.startsWith('#')).trim(),
  destination: shown(map.Destination, 'the map, Destination'),
  rule: { name: ruleName, text: ruleText },
  tickets,
  pipeline,
  documents,
};

// ---- Checks, then the swap ----

const json = `${JSON.stringify(content, null, 2)}\n`;
const leak = json.match(/github\.com\/imDev2023|claude\.ai\/|\/Volumes\/|\/Users\//);
if (leak) fail(`"${leak[0]}" is still in the content. Extend the link or path rules.`);

// If the gate stops here, content.next.json stays (untracked) so the lines it names can be read.
const next = join(here, 'content.next.json');
writeFileSync(next, json);
assertPublic(next);
renameSync(next, join(here, 'content.json'));

const count = (state) => tickets.filter((ticket) => ticket.state === state).length;
console.log(
  `content.json: ${count('done')} done, ${count('in progress')} in progress, ${count('next')} next, ` +
    `${documents.length} documents, at ${content.commit}.`,
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
if (unresolved.length) {
  console.log(`\nDone without a page, because no comment of theirs starts with "Resolution" or "Resolved": ${unresolved.map((number) => `#${number}`).join(', ')}.`);
}
const unused = [...approved].filter(([, used]) => !used).map(([text]) => text);
if (unused.length) {
  console.log(`\n${unused.length} lines of approved.txt match nothing any more and can go:\n`);
  for (const text of unused) console.log(`${text}\n`);
}
