// Links into the repository, which is public since 2026-11-20 (#167): every one points straight at it.

import { posix } from 'node:path';

export const REPO_URL = 'https://github.com/imDev2023/testing-pipeline';

/**
 * Returns the Markdown with every link into the repository pointing at it on GitHub, and throws when one
 * names a file, a folder or a commit the repository does not hold, so no link the site shows is broken.
 *
 * `folder` is where the text sits in the repo, for the links written relative to it; `ref` is the branch
 * the text was read from; `repo.kind(ref, path)` says whether a path at a ref is a file ('blob'), a folder
 * ('tree') or not there (null), and the path '' asks whether the ref itself is there.
 * A code block is an example, shown as written.
 */
export function withRepoLinks(markdown, { folder = '', ref = 'main', repo }) {
  return markdown
    .split(/^(```[\s\S]*?^```)/m)
    .map((part) => (part.startsWith('```') ? part : linksIn(part, folder, ref, repo)))
    .join('');
}

function linksIn(markdown, folder, ref, repo) {
  return markdown
    .replace(/\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^)\s]+)\)/g, (link, text, url) => {
      // A Claude Code session is private to the owner, so its link is shown as plain text.
      if (/^https:\/\/claude\.ai\//.test(url)) return text;
      if (url.startsWith(`${REPO_URL}/`)) return checked(url, repo) && link;
      if (/^([a-z][a-z0-9+.-]*:|#)/i.test(url)) return link;
      // A link relative to the file the text sits in, as GitHub reads it.
      const [file, anchor] = url.split('#');
      const path = posix.normalize(posix.join(folder, file)).replace(/\/$/, '');
      const kind = path.startsWith('../') ? null : repo.kind(ref, path);
      if (!kind) throw new Error(`[${text}](${url}) links to a file that is not there: ${path} is not on ${ref}.`);
      return `[${text}](${REPO_URL}/${kind}/${ref}/${path}${anchor ? `#${anchor}` : ''})`;
    })
    .replace(new RegExp(`(?<!\\]\\()${REPO_URL}/[^\\s)>]+`, 'g'), (match) => {
      // A full address in running text reads badly on a phone, so it becomes a short link.
      const url = match.replace(/[.,;:!?]+$/, '');
      checked(url, repo);
      return `[${shortName(url)}](${url})${match.slice(url.length)}`;
    });
}

/** What a bare address is called in running text: a ticket or a pull request by its number, as GitHub writes it, else its last part. */
function shortName(url) {
  const parts = url.slice(REPO_URL.length + 1).replace(/[?#].*$/, '').split('/').filter(Boolean);
  if ((parts[0] === 'issues' || parts[0] === 'pull') && /^\d+$/.test(parts[1] ?? '')) return `#${parts[1]}`;
  return parts.at(-1);
}

/** True when what a full address into the repository names is there; throws when it is not. */
function checked(url, repo) {
  const path = url.slice(REPO_URL.length + 1).replace(/[?#].*$/, '');
  const [route, ...rest] = path.split('/');
  let there = true;
  if (route === 'blob' || route === 'tree') {
    // A branch can hold slashes ("research/pipeline-router"), so try each split, as GitHub does.
    there = rest.some((_, i) => repo.kind(rest.slice(0, i + 1).join('/'), rest.slice(i + 1).join('/')) !== null);
  } else if (route === 'commit') {
    there = repo.kind(rest[0], '') !== null;
  }
  if (!there) throw new Error(`${url} names something the repository does not hold.`);
  return true;
}
