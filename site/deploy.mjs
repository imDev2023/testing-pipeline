// Deploys the site to production on Vercel: builds it, checks every file against the privacy gate,
// then uploads exactly the files that were checked.
//
//   npm run deploy
//
// Vercel only ever receives the built pages. The project is not connected to the GitHub repo and
// must stay that way.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublic } from './private.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const PROJECT = 'testing-pipeline';
const run = (command, ...args) => execFileSync(command, args, { cwd: here, stdio: 'inherit' });

run('node', 'build.mjs');
assertPublic(join(here, 'dist'));

run('vercel', 'link', '--yes', '--project', PROJECT);
run('vercel', 'build', '--prod', '--yes'); // packs dist/ into .vercel/output, the upload
assertPublic(join(here, '.vercel', 'output'));
run('vercel', 'deploy', '--prebuilt', '--prod');
