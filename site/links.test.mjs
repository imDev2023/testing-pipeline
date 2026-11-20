// The site's links into the repository: since the repo is public they point straight at it.
//
//   node --test

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRepoLinks } from './links.mjs';

const REPO = 'https://github.com/imDev2023/testing-pipeline';

/** A stand-in for the repository: the files and folders of each ref. */
function repo(files) {
  return {
    kind(ref, path) {
      const paths = files[ref] ?? [];
      if (path === '' || paths.some((file) => file.startsWith(`${path}/`))) return ref in files ? 'tree' : null;
      return paths.includes(path) ? 'blob' : null;
    },
  };
}

const main = repo({ main: ['docs/spec/tax-amm.md', 'docs/adr/0003-x.md', 'site/README.md'] });

test('a link relative to a document points at that file on the public repository', () => {
  assert.equal(
    withRepoLinks('See [the ADR](../adr/0003-x.md).', { folder: 'docs/spec', ref: 'main', repo: main }),
    `See [the ADR](${REPO}/blob/main/docs/adr/0003-x.md).`,
  );
});

test('a section of a file keeps its anchor, and a folder links to the folder', () => {
  assert.equal(
    withRepoLinks('[Constants](tax-amm.md#constants) and [the ADRs](../adr/)', { folder: 'docs/spec', ref: 'main', repo: main }),
    `[Constants](${REPO}/blob/main/docs/spec/tax-amm.md#constants) and [the ADRs](${REPO}/tree/main/docs/adr)`,
  );
});

test('links that are not into the repository are kept, except the private claude.ai ones', () => {
  assert.equal(
    withRepoLinks(
      '[Pipeline](https://github.com/MetalLegBob/pipeline), [below](#constants), [a session](https://claude.ai/code/x) and [mail](mailto:a@b.c)',
      { folder: 'docs/spec', ref: 'main', repo: main },
    ),
    '[Pipeline](https://github.com/MetalLegBob/pipeline), [below](#constants), a session and [mail](mailto:a@b.c)',
  );
});

test('a relative link to something the repository does not hold stops the refresh, naming it', () => {
  assert.throws(
    () => withRepoLinks('[gone](../adr/0099-gone.md)', { folder: 'docs/spec', ref: 'main', repo: main }),
    /docs\/adr\/0099-gone\.md is not on main/,
  );
  assert.throws(
    () => withRepoLinks('[outside](../../../x.md)', { folder: 'docs/spec', ref: 'main', repo: main }),
    /\.\.\/x\.md is not on main/,
  );
});

test('a full address into the repository is kept when what it names is there, and stops the refresh when not', () => {
  const research = repo({
    main: ['docs/spec/tax-amm.md'],
    'research/pipeline-router': ['research/pipeline-router.md'],
    '26e5f38': ['docs/spec/tax-amm.md'],
  });
  const shown = [
    `[the spec](${REPO}/blob/main/docs/spec/tax-amm.md#constants)`,
    `[findings](${REPO}/blob/research/pipeline-router/research/pipeline-router.md)`,
    `[then](${REPO}/blob/26e5f38/docs/spec/tax-amm.md)`,
    `[the commit](${REPO}/commit/26e5f38)`,
    `[the map](${REPO}/issues/1), [a PR](${REPO}/pull/185)`,
  ].join('\n');
  assert.equal(withRepoLinks(shown, { ref: 'main', repo: research }), shown);
  assert.throws(
    () => withRepoLinks(`[old](${REPO}/blob/a8b1b1d/docs/spec/tax-amm.md)`, { ref: 'main', repo: research }),
    /blob\/a8b1b1d\/docs\/spec\/tax-amm\.md names something the repository does not hold/,
  );
  assert.throws(
    () => withRepoLinks(`${REPO}/commit/a8b1b1d`, { ref: 'main', repo: research }),
    /commit\/a8b1b1d names something the repository does not hold/,
  );
});

test('a code block is an example and is shown as written', () => {
  const example = '```markdown\n- Specified in: [`docs/spec/tax-amm.md`, Constants](spec/tax-amm.md#constants)\n```';
  assert.equal(withRepoLinks(`Before\n\n${example}\n\nAfter`, { folder: 'docs', ref: 'main', repo: main }), `Before\n\n${example}\n\nAfter`);
});

test('a bare address into the repository becomes a short link: a file by its name, a ticket by its number', () => {
  const research = repo({ main: ['docs/spec/tax-amm.md'], 'research/quoter-hosting': ['research/quoter-hosting.md'] });
  assert.equal(
    withRepoLinks(
      `Findings: ${REPO}/blob/research/quoter-hosting/research/quoter-hosting.md (measured), ` +
        `${REPO}/blob/main/docs/spec/tax-amm.md#constants, ${REPO}/issues/186 and ${REPO}/pull/185.`,
      { ref: 'main', repo: research },
    ),
    `Findings: [quoter-hosting.md](${REPO}/blob/research/quoter-hosting/research/quoter-hosting.md) (measured), ` +
      `[tax-amm.md](${REPO}/blob/main/docs/spec/tax-amm.md#constants), [#186](${REPO}/issues/186) and [#185](${REPO}/pull/185).`,
  );
});
