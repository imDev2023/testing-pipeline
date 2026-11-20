// Links into the repository, which is public since 2026-11-20 (#167): every one points straight at it.

import { posix } from 'node:path';

export const REPO_URL = 'https://github.com/imDev2023/testing-pipeline';

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// One pass over prose finds whichever comes first: a Markdown link or image (with or without a title), a
// reference definition, an autolink, a bare address into the repo, or an inline code span, so a link's
// text may hold code and code never holds a link.
const LINK = /(?<bang>!?)\[(?<label>(?:[^\[\]]|\[[^\]]*\])*)\]\((?<destination><[^>\n]*>|[^)\s]+)(?<title>\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/.source;
const DEFINITION = /^(?<head> {0,3}\[[^\]\n]+\]:[ \t]*)(?<target><[^>\n]*>|\S+)/.source;
const AUTOLINK = /<(?<autolink>https?:\/\/[^>\s]+)>/.source;
// Not an attribute's value, and ending at a space, a bracket, a quote, a pipe or emphasis.
const BARE = `(?<!=["']?)(?<bare>${escaped(REPO_URL)}/[^\\s()<>\\[\\]\`*"'|]+)`;
const CODE = /(?<code>(?<!`)(?<run>`+)(?!`)(?:(?!\n\s*\n)[\s\S])*?(?<!`)\k<run>(?!`))/.source;
const ANY = new RegExp(`${LINK}|${DEFINITION}|${AUTOLINK}|${BARE}|${CODE}`, 'gm');

const PRIVATE = /^https:\/\/claude\.ai\//; // a Claude Code session, which only the owner can open
const unwrapPrivate = (code) =>
  code.replace(new RegExp(LINK, 'g'), (link, ...args) => {
    const { label, destination } = args.at(-1);
    return PRIVATE.test(destination) ? label : link;
  });

/**
 * Returns the Markdown with every link into the repository pointing at it on GitHub, and throws when one
 * names a file, a folder, a section, a commit or a ticket the repository does not hold, so no link the
 * site shows is broken.
 *
 * `folder` is where the text sits in the repo, for the links written relative to it, and `ref` is the
 * branch they point at. `repo` answers for the repository:
 *   kind(ref, path)  'blob' for a file, 'tree' for a folder, null when it is not there; the path '' asks
 *                    whether the ref itself is there
 *   text(ref, path)  a file's text, to find its sections
 *   lastNumber()     the newest issue or pull request number; every number up to it exists
 * Code is an example and is shown as written, except that a private claude.ai link is unwrapped.
 */
export function withRepoLinks(markdown, { folder = '', ref = 'main', repo }) {
  return pieces(markdown)
    .map(({ code, text }) => (code ? unwrapPrivate(text) : linksIn(text, folder, ref, repo)))
    .join('');
}

// ---- Code ----

/** The marks of a line that opens a fence, as CommonMark reads it, also inside a block quote; null when it does not. */
function fenceOpening(line) {
  const fence = line.replace(/^(\s*>)+/, '').replace(/\r?\n$/, '').match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!fence || (fence[1][0] === '`' && fence[2].includes('`'))) return null;
  return fence[1];
}

/** True for a line that closes the fence `opening`: its own marks, at least as many, and nothing else. */
function closes(line, opening) {
  const fence = line.replace(/^(\s*>)+/, '').match(/^\s*(`{3,}|~{3,})\s*$/);
  return !!fence && fence[1][0] === opening[0] && fence[1].length >= opening.length;
}

/** Splits Markdown into fenced code blocks and the text around them. */
function pieces(markdown) {
  const out = [];
  let prose = [];
  const flush = () => {
    if (prose.length) out.push({ code: false, text: prose.join('') });
    prose = [];
  };
  const lines = markdown.split(/(?<=\n)/);
  for (let i = 0; i < lines.length; i++) {
    const opening = fenceOpening(lines[i]);
    if (!opening) {
      prose.push(lines[i]);
      continue;
    }
    flush();
    const block = [lines[i]];
    while (++i < lines.length) {
      block.push(lines[i]);
      if (closes(lines[i], opening)) break;
    }
    out.push({ code: true, text: block.join('') });
  }
  flush();
  return out;
}

// ---- Links ----

function linksIn(prose, folder, ref, repo) {
  return prose.replace(ANY, (match, ...args) => {
    const { bang, label, destination, head, target, autolink, bare, code } = args.at(-1);
    if (code) return unwrapPrivate(match);
    if (bare) {
      // A full address in running text reads badly on a phone, so it becomes a short link.
      const url = bare.replace(/[.,;:!?_~]+$/, '');
      checked(url, repo);
      return `[${shortName(url)}](${url})${match.slice(url.length)}`;
    }
    if (autolink) {
      if (autolink.startsWith(`${REPO_URL}/`)) checked(autolink, repo);
      return match;
    }
    if (head !== undefined) {
      const url = target.replace(/^<(.*)>$/, '$1');
      return `${head}${pointed(url, match, folder, ref, repo) ?? target}`;
    }
    if (bang) return match; // an image: the site shows its text
    const url = destination.replace(/^<(.*)>$/, '$1');
    if (PRIVATE.test(url)) return label;
    const repointed = pointed(url, match, folder, ref, repo);
    return repointed ? `[${label}](${repointed}${args.at(-1).title ?? ''})` : match;
  });
}

/**
 * Where a link's address points on GitHub when it was written relative to a file or to the root of the
 * repo, as GitHub reads it; null when it stays as written: it leads elsewhere, or it is a full address
 * into the repo that checks out.
 */
function pointed(url, written, folder, ref, repo) {
  if (url.startsWith(`${REPO_URL}/`)) return checked(url, repo) && null;
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)) return null;

  const [name, anchor] = url.split('#');
  let file = name;
  try {
    file = decodeURI(name);
  } catch {}
  const path = posix.normalize(file.startsWith('/') ? file.slice(1) : posix.join(folder, file)).replace(/\/$/, '');
  const kind = path.startsWith('../') ? null : repo.kind(ref, path);
  if (!kind) throw new Error(`${written} links to a file that is not there: ${path} is not on ${ref}.`);
  if (anchor) checkSection(ref, path, kind, anchor, repo);
  return `${REPO_URL}/${kind}/${encodeURI(ref)}/${encodeURI(path)}${anchor ? `#${anchor}` : ''}`;
}

/** True when what a full address into the repository names is there; throws when it is not. */
function checked(url, repo) {
  const [path, anchor] = url.slice(REPO_URL.length + 1).replace(/\?[^#]*/, '').split('#');
  const [route, ...rest] = path.split('/').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  let there = true;
  if (route === 'blob' || route === 'tree') {
    // A branch can hold slashes ("research/quoter-hosting"), so try each split, as GitHub does.
    const split = rest
      .map((_, i) => ({ ref: rest.slice(0, i + 1).join('/'), file: rest.slice(i + 1).join('/') }))
      .find(({ ref, file }) => repo.kind(ref, file) !== null);
    there = !!split;
    if (split && anchor) checkSection(split.ref, split.file, repo.kind(split.ref, split.file), anchor, repo);
  } else if (route === 'commit') {
    there = repo.kind(rest[0], '') !== null;
  } else if ((route === 'issues' || route === 'pull') && rest[0]) {
    there = /^\d+$/.test(rest[0]) && Number(rest[0]) >= 1 && Number(rest[0]) <= repo.lastNumber();
  }
  if (!there) throw new Error(`${url} names something the repository does not hold.`);
  return true;
}

// ---- Sections ----

/** Throws unless a Markdown file has the section an anchor names; a line anchor, or another kind of file, is not checked. */
function checkSection(ref, path, kind, anchor, repo) {
  if (kind !== 'blob' || !/\.md$/i.test(path) || /^L\d+(C\d+)?(-L\d+(C\d+)?)?$/.test(anchor)) return;
  let wanted = anchor;
  try {
    wanted = decodeURIComponent(anchor);
  } catch {}
  if (!sectionsOf(repo.text(ref, path)).has(wanted.toLowerCase())) {
    throw new Error(`${path} has no section #${anchor} on ${ref}.`);
  }
}

/** The anchors GitHub gives the headings of a Markdown file, made from each heading's text as it is shown. */
function sectionsOf(markdown) {
  const ids = new Set();
  let opening = null;
  for (const line of markdown.split('\n')) {
    if (opening) {
      if (closes(line, opening)) opening = null;
      continue;
    }
    opening = fenceOpening(line);
    const heading = !opening && line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
    if (!heading) continue;
    const shown = heading[1]
      .replace(/!?\[((?:[^\[\]]|\[[^\]]*\])*)\]\([^)]*\)/g, '$1')
      .replace(/(`+)(.+?)\1|<[^>]+>/g, (tag, run, code) => (run ? code : ''));
    const base = shown.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    let id = base;
    for (let n = 1; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
  }
  return ids;
}

/** What a bare address is called in running text: a ticket or a pull request by its number, as GitHub writes it, else its last part. */
function shortName(url) {
  const parts = url.slice(REPO_URL.length + 1).replace(/[?#].*$/, '').split('/').filter(Boolean);
  if ((parts[0] === 'issues' || parts[0] === 'pull') && /^\d+$/.test(parts[1] ?? '')) return `#${parts[1]}`;
  const last = parts.at(-1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
