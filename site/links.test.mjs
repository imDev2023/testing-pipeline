// The site's links into the repository: since the repo is public they point straight at it.
//
//   node --test

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRepoLinks } from './links.mjs';

const REPO = 'https://github.com/imDev2023/testing-pipeline';

/** A stand-in for the repository: the files of each ref with their text, and its newest issue or pull request. */
function repo(refs, lastNumber = 200) {
  return {
    kind(ref, path) {
      const files = refs[ref];
      if (!files) return null;
      if (path === '' || Object.keys(files).some((file) => file.startsWith(`${path}/`))) return 'tree';
      return path in files ? 'blob' : null;
    },
    text: (ref, path) => refs[ref][path],
    lastNumber: () => lastNumber,
  };
}

const SPEC = '# Tax AMM\n\n## Constants\n\n## How `quote` works\n\n## Constants\n\n```\n## Not a heading\n```\n';
const main = repo({
  main: { 'docs/spec/tax-amm.md': SPEC, 'docs/adr/0003-x.md': '# X\n', 'site/README.md': '# Site\n' },
  'research/quoter-hosting': { 'research/quoter-hosting.md': '# Findings\n' },
  '26e5f38': { 'docs/spec/tax-amm.md': SPEC },
});
const links = (markdown, folder = 'docs/spec') => withRepoLinks(markdown, { folder, ref: 'main', repo: main });

test('a link relative to a document points at that file on the public repository', () => {
  assert.equal(links('See [the ADR](../adr/0003-x.md).'), `See [the ADR](${REPO}/blob/main/docs/adr/0003-x.md).`);
});

test('a section of a file keeps its anchor, and a folder links to the folder', () => {
  assert.equal(
    links('[Constants](tax-amm.md#constants) and [the ADRs](../adr/)'),
    `[Constants](${REPO}/blob/main/docs/spec/tax-amm.md#constants) and [the ADRs](${REPO}/tree/main/docs/adr)`,
  );
});

test('a link from the root of the repository, or in angle brackets, is read as GitHub reads it', () => {
  assert.equal(
    links('[root](/site/README.md) and [bracketed](<../adr/0003-x.md>)'),
    `[root](${REPO}/blob/main/site/README.md) and [bracketed](${REPO}/blob/main/docs/adr/0003-x.md)`,
  );
});

test('links that are not into the repository are kept, except the private claude.ai ones', () => {
  assert.equal(
    links(
      '[Pipeline](https://github.com/MetalLegBob/pipeline), [below](#constants), [a session](https://claude.ai/code/x), ' +
        '[mail](mailto:a@b.c) and [elsewhere](//example.com/x)',
    ),
    '[Pipeline](https://github.com/MetalLegBob/pipeline), [below](#constants), a session, [mail](mailto:a@b.c) and [elsewhere](//example.com/x)',
  );
});

test('a relative link to something the repository does not hold stops the refresh, naming it', () => {
  assert.throws(() => links('[gone](../adr/0099-gone.md)'), /docs\/adr\/0099-gone\.md is not on main/);
  assert.throws(() => links('[outside](../../../x.md)'), /\.\.\/x\.md is not on main/);
});

test('a link to a section the file does not have stops the refresh; the anchors are the ones GitHub gives', () => {
  assert.equal(
    links('[a](tax-amm.md#how-quote-works) [b](tax-amm.md#constants-1)'),
    `[a](${REPO}/blob/main/docs/spec/tax-amm.md#how-quote-works) [b](${REPO}/blob/main/docs/spec/tax-amm.md#constants-1)`,
  );
  assert.throws(() => links('[typo](tax-amm.md#constans)'), /tax-amm\.md has no section #constans/);
  assert.throws(() => links('[fenced](tax-amm.md#not-a-heading)'), /has no section #not-a-heading/);
  assert.throws(() => links(`[full](${REPO}/blob/main/docs/spec/tax-amm.md#gone)`), /has no section #gone/);
});

test('a full address into the repository is kept when what it names is there, and stops the refresh when not', () => {
  const shown = [
    `[the spec](${REPO}/blob/main/docs/spec/tax-amm.md#constants)`,
    `[findings](${REPO}/blob/research/quoter-hosting/research/quoter-hosting.md)`,
    `[then](${REPO}/blob/26e5f38/docs/spec/tax-amm.md)`,
    `[the commit](${REPO}/commit/26e5f38)`,
    `[the map](${REPO}/issues/1), [a PR](${REPO}/pull/185/files)`,
    `[${REPO}/issues/7](${REPO}/issues/7) and <${REPO}/issues/8>`,
  ].join('\n');
  assert.equal(links(shown), shown);
  assert.throws(() => links(`[old](${REPO}/blob/a8b1b1d/docs/spec/tax-amm.md)`), /blob\/a8b1b1d\/docs\/spec\/tax-amm\.md names something the repository does not hold/);
  assert.throws(() => links(`${REPO}/commit/a8b1b1d`), /commit\/a8b1b1d names something the repository does not hold/);
  assert.throws(() => links(`[later](${REPO}/issues/201)`), /issues\/201 names something the repository does not hold/);
  assert.throws(() => links(`<${REPO}/pull/12x>`), /pull\/12x names something the repository does not hold/);
});

test('a bare address into the repository becomes a short link: a file by its name, a ticket by its number', () => {
  assert.equal(
    links(
      `Findings: ${REPO}/blob/research/quoter-hosting/research/quoter-hosting.md (measured), ` +
        `${REPO}/blob/main/docs/spec/tax-amm.md#constants, ${REPO}/issues/186 and **${REPO}/pull/185**.`,
    ),
    `Findings: [quoter-hosting.md](${REPO}/blob/research/quoter-hosting/research/quoter-hosting.md) (measured), ` +
      `[tax-amm.md](${REPO}/blob/main/docs/spec/tax-amm.md#constants), [#186](${REPO}/issues/186) and **[#185](${REPO}/pull/185)**.`,
  );
});

test('code is an example and is shown as written, except that a private claude.ai link is unwrapped', () => {
  const examples = [
    '```markdown\n- Specified in: [`docs/spec/tax-amm.md`, Constants](spec/tax-amm.md#constants)\n```',
    '~~~\n[x](spec/y.md)\n~~~',
    '- An item:\n\n  ```\n  [x](spec/y.md)\n  ```',
    'Write it as `[x](spec/y.md)` or ``[x](`y`.md)``.',
    `See \`${REPO}/issues/999\`.`,
  ].join('\n\n');
  assert.equal(links(`Before\n\n${examples}\n\nAfter`), `Before\n\n${examples}\n\nAfter`);
  assert.equal(links('```\n[a session](https://claude.ai/code/x)\n```'), '```\na session\n```');
});

test('an image is left alone: the site shows its text, not the picture', () => {
  assert.equal(links('![chart](chart.png)'), '![chart](chart.png)');
});

test('a link whose text is code is still a link', () => {
  assert.equal(
    links(`[\`docs/spec/tax-amm.md\`](${REPO}/blob/main/docs/spec/tax-amm.md) and [\`the ADR\`](../adr/0003-x.md)`),
    `[\`docs/spec/tax-amm.md\`](${REPO}/blob/main/docs/spec/tax-amm.md) and [\`the ADR\`](${REPO}/blob/main/docs/adr/0003-x.md)`,
  );
});
