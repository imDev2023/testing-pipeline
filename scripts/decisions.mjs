#!/usr/bin/env node
// Parses and checks the decision register, docs/decisions.md.
//
//   node scripts/decisions.mjs --check [file]   validate the register; exit 1 on any problem
//   node scripts/decisions.mjs --json  [file]   print the register as JSON (refused while it has problems)
//
// The format is described at the top of docs/decisions.md.
// Plain Node, no dependencies, so the progress site and CI can both run it.
// The site can also import { parseDecisions } from this file.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 1;

/** Product prefixes, in the order their sections appear in the register. */
export const PRODUCTS = ['SUITE', 'BAR', 'PIPESCOPE', 'CANARY', 'EXPLAINER', 'TAX', 'HOOK', 'POOL4', 'LENDING'];

/** The seven fields of a decision block, in the order they must appear. */
export const FIELDS = ['Question', 'Answer', 'Alternatives', 'Specified in', 'Changes by', 'Status', 'Decided'];

export const CHANGES_BY = [
  'spec only',
  'build-time constant',
  'market-creation parameter',
  'runtime setting',
  'fixed on-chain once deployed',
];

export const MAP_URL = 'https://github.com/imDev2023/testing-pipeline/issues/1';

const BLOCK_HEADING = /^### ([A-Z][A-Z0-9]*)-(\d{2,}): (\S.*)$/;
const SECTION_HEADING = /^## (.+) \(([A-Z][A-Z0-9]*)\)$/;
const FIELD_LINE = /^- ([A-Z][A-Za-z ]*): (\S.*)$/;
const SPECIFIED_IN_FILE = /^\[`([^`]+)`, (.+)\]\(([^()\s]+)\)$/;
const SPECIFIED_IN_ISSUE = /^\[the (map|ticket), (.+)\]\(([^()\s]+)\)$/;
const ISSUE_URL = /^https:\/\/github\.com\/imDev2023\/testing-pipeline\/issues\/\d+$/;
const STATUS = /^(default|confirmed|changed)(?: (\d{4}-\d{2}-\d{2}))?$/;
const DECIDED = /^(\d{4}-\d{2}-\d{2}) in \[(.+)\]\((https:\/\/github\.com\/imDev2023\/testing-pipeline\/(?:issues|pull)\/\d+)\)$/;

/**
 * Parse the register's Markdown.
 * Returns the decisions, the follow-ups and every format problem found, each with its line number.
 * It reads no files, so it cannot tell whether a "Specified in" target exists; checkTargets does that.
 */
export function parseDecisions(markdown) {
  const lines = markdown.split(/\r?\n/);
  const decisions = [];
  const followUps = [];
  const problems = [];
  const seen = new Map();
  const lastNumber = new Map();

  let inFence = false;
  let section = null; // the product prefix of the current "## Name (PREFIX)" section
  let inFollowUps = false;
  let block = null;

  const problem = (line, message) => problems.push({ line, message });

  const closeBlock = () => {
    if (!block) return;
    const missing = FIELDS.filter((field) => !(field in block.raw));
    if (missing.length > 0) {
      problem(block.line, `${block.id}: missing ${missing.map((f) => `"${f}"`).join(', ')}`);
    } else {
      decisions.push(finishBlock(block, problem));
    }
    block = null;
  };

  lines.forEach((text, index) => {
    const line = index + 1;

    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    if (/^#{1,6} /.test(text)) {
      closeBlock();

      if (text.startsWith('## ')) {
        inFollowUps = text === '## Follow-ups';
        const match = SECTION_HEADING.exec(text);
        section = match ? match[2] : null;
        if (match && !PRODUCTS.includes(section)) {
          problem(line, `unknown product prefix "${section}"; expected one of ${PRODUCTS.join(', ')}`);
        }
        return;
      }

      if (text.startsWith('### ')) {
        const match = BLOCK_HEADING.exec(text);
        if (!match) {
          problem(line, 'a "###" heading must be a decision: "### PREFIX-NN: Title"');
          return;
        }
        const [, product, digits, title] = match;
        const id = `${product}-${digits}`;
        const number = Number(digits);
        if (section === null) {
          problem(line, `${id}: outside a product section ("## Name (${product})")`);
        } else if (product !== section) {
          problem(line, `${id}: belongs in the ${product} section, not ${section}`);
        }
        if (seen.has(id)) {
          problem(line, `${id}: already used on line ${seen.get(id)}; IDs are never reused`);
        } else {
          seen.set(id, line);
          const expected = (lastNumber.get(product) ?? 0) + 1;
          if (number !== expected) {
            problem(line, `${id}: expected ${product}-${String(expected).padStart(2, '0')}; IDs run in order with no gaps`);
          }
          lastNumber.set(product, Math.max(number, lastNumber.get(product) ?? 0));
        }
        block = { id, product, number, title, line, raw: {} };
      }
      return;
    }

    if (block) {
      if (text.trim() === '') return;
      const match = FIELD_LINE.exec(text);
      if (!match || !FIELDS.includes(match[1])) {
        problem(line, `${block.id}: expected one of the seven fields as "- Label: value" on one line`);
        return;
      }
      const [, label, value] = match;
      if (label in block.raw) {
        problem(line, `${block.id}: "${label}" appears twice`);
        return;
      }
      const expected = FIELDS[Object.keys(block.raw).length];
      if (label !== expected) {
        problem(line, `${block.id}: "${label}" is out of order; expected "${expected}"`);
      }
      block.raw[label] = { value: value.trimEnd(), line };
      return;
    }

    if (inFollowUps) {
      if (text.startsWith('- ')) {
        followUps.push(text.slice(2).trim());
      } else if (/^\s+\S/.test(text) && followUps.length > 0) {
        followUps[followUps.length - 1] += ` ${text.trim()}`;
      }
    }
  });

  closeBlock();
  return { format: FORMAT, decisions, followUps, problems };
}

function finishBlock(block, problem) {
  const { id, product, number, title, raw } = block;
  const value = (label) => raw[label].value;
  const at = (label) => raw[label].line;

  if (!value('Question').endsWith('?')) problem(at('Question'), `${id}: the question must end with "?"`);
  for (const label of ['Answer', 'Alternatives']) {
    if (!value(label).endsWith('.')) problem(at(label), `${id}: "${label}" must be a sentence ending with "."`);
  }

  // Three kinds of place: a section of a file in the repo, a section of the map's body,
  // or a ticket whose spec has not landed yet.
  let specifiedIn = null;
  const fileMatch = SPECIFIED_IN_FILE.exec(value('Specified in'));
  const issueMatch = SPECIFIED_IN_ISSUE.exec(value('Specified in'));
  if (fileMatch) {
    const [, file, sectionName, href] = fileMatch;
    specifiedIn = { kind: 'file', file, section: sectionName, href };
    if (/^[a-z]+:/i.test(href)) {
      problem(at('Specified in'), `${id}: a file target must be a path relative to docs/, not a URL`);
    } else if (!href.includes('#')) {
      problem(at('Specified in'), `${id}: the target needs the section's anchor ("#...")`);
    }
  } else if (issueMatch) {
    const [, kind, sectionName, href] = issueMatch;
    specifiedIn = { kind, file: null, section: sectionName, href };
    if (kind === 'map' && href !== MAP_URL) {
      problem(at('Specified in'), `${id}: "the map" must link to ${MAP_URL}`);
    } else if (kind === 'ticket' && (!ISSUE_URL.test(href) || href === MAP_URL)) {
      problem(at('Specified in'), `${id}: "the ticket" must link to one of this repo's issues`);
    }
  } else {
    problem(
      at('Specified in'),
      `${id}: "Specified in" must be one link: [\`path\`, Section](relative/path.md#anchor), [the map, Section](${MAP_URL}) or [the ticket, Title](issue URL)`,
    );
  }

  if (!CHANGES_BY.includes(value('Changes by'))) {
    problem(at('Changes by'), `${id}: "Changes by" must be one of: ${CHANGES_BY.join('; ')}`);
  }

  let status = null;
  let statusDate = null;
  const statusMatch = STATUS.exec(value('Status'));
  if (!statusMatch) {
    problem(at('Status'), `${id}: "Status" must be "default", "confirmed YYYY-MM-DD" or "changed YYYY-MM-DD"`);
  } else {
    [, status, statusDate = null] = statusMatch;
    if (status === 'default' && statusDate) problem(at('Status'), `${id}: "default" takes no date`);
    if (status !== 'default' && !statusDate) problem(at('Status'), `${id}: "${status}" needs its date`);
  }

  let decided = null;
  const decidedMatch = DECIDED.exec(value('Decided'));
  if (!decidedMatch) {
    problem(at('Decided'), `${id}: "Decided" must be "YYYY-MM-DD in [ticket title](issue URL)"`);
  } else {
    const [, date, ticket, url] = decidedMatch;
    decided = { date, ticket, url };
  }

  return {
    id,
    product,
    number,
    title,
    line: block.line,
    question: value('Question'),
    answer: value('Answer'),
    alternatives: value('Alternatives'),
    specifiedIn,
    changesBy: value('Changes by'),
    status,
    statusDate,
    decided,
  };
}

/** The anchor GitHub gives a heading. */
export function headingAnchor(heading) {
  return heading
    .trim()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // a link contributes its text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
}

/** Every heading of a Markdown file as { text, anchor }, with GitHub's suffixes for repeated headings. */
export function headingsOf(markdown) {
  const headings = [];
  const counts = new Map();
  let inFence = false;
  for (const text of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#{1,6} (.+?)\s*$/.exec(text);
    if (!match) continue;
    const base = headingAnchor(match[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    headings.push({ text: match[1], anchor: count === 0 ? base : `${base}-${count}` });
  }
  return headings;
}

/**
 * Check that every "Specified in" link names a file and a section that exist.
 * registerPath is the register's own path; targets resolve against its folder, and repoRoot bounds them.
 */
export function checkTargets(decisions, registerPath, repoRoot) {
  const problems = [];
  const cache = new Map();
  for (const decision of decisions) {
    const target = decision.specifiedIn;
    if (!target || target.kind !== 'file' || !target.href.includes('#') || /^[a-z]+:/i.test(target.href)) continue;
    const [relative, anchor] = target.href.split('#');
    const absolute = path.resolve(path.dirname(registerPath), decodeURIComponent(relative));
    const fromRoot = path.relative(repoRoot, absolute).split(path.sep).join('/');
    const fail = (message) => problems.push({ line: decision.line, message: `${decision.id}: ${message}` });

    if (fromRoot.startsWith('..')) {
      fail(`"${target.href}" points outside the repo`);
      continue;
    }
    if (fromRoot !== target.file) {
      fail(`the link text names \`${target.file}\` but the target is \`${fromRoot}\``);
      continue;
    }
    if (!existsSync(absolute)) {
      fail(`\`${fromRoot}\` does not exist`);
      continue;
    }
    if (!cache.has(absolute)) cache.set(absolute, headingsOf(readFileSync(absolute, 'utf8')));
    const heading = cache.get(absolute).find((candidate) => candidate.anchor === anchor);
    if (!heading) {
      fail(`\`${fromRoot}\` has no section with the anchor "#${anchor}"`);
    } else if (heading.text !== target.section) {
      fail(`"#${anchor}" is the section "${heading.text}", but the link text says "${target.section}"`);
    }
  }
  return problems;
}

function main(argv) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const mode = argv.find((arg) => arg === '--check' || arg === '--json');
  const fileArg = argv.find((arg) => !arg.startsWith('--'));
  if (!mode) {
    console.error('usage: node scripts/decisions.mjs --check|--json [file]');
    return 2;
  }
  const registerPath = path.resolve(fileArg ?? path.join(repoRoot, 'docs', 'decisions.md'));
  if (!existsSync(registerPath)) {
    console.error(`${registerPath} does not exist`);
    return 2;
  }

  const parsed = parseDecisions(readFileSync(registerPath, 'utf8'));
  const problems = [...parsed.problems, ...checkTargets(parsed.decisions, registerPath, repoRoot)].sort(
    (a, b) => a.line - b.line,
  );
  const shown = path.relative(process.cwd(), registerPath) || registerPath;

  if (problems.length > 0) {
    for (const { line, message } of problems) console.error(`${shown}:${line}: ${message}`);
    console.error(`${problems.length} problem${problems.length === 1 ? '' : 's'} in the decision register`);
    return 1;
  }

  if (mode === '--json') {
    const { format, decisions, followUps } = parsed;
    const publicDecisions = decisions.map(({ line, number, ...rest }) => rest);
    process.stdout.write(`${JSON.stringify({ format, decisions: publicDecisions, followUps }, null, 2)}\n`);
    return 0;
  }

  const perProduct = PRODUCTS.map((product) => {
    const count = parsed.decisions.filter((decision) => decision.product === product).length;
    return `${product} ${count}`;
  }).join(', ');
  console.log(`${shown}: ${parsed.decisions.length} decisions (${perProduct}), ${parsed.followUps.length} follow-ups, no problems`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
