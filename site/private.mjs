// The privacy gate: nothing that matches the owner's private lines may be committed or deployed.
// The lines live outside the repo and are only ever handed to grep, never read or printed here.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PRIVATE_LINES = join(homedir(), '.config', 'testing-pipeline', 'private-lines.txt');

/** Exits the process unless `target` (a file or a directory) is free of every private line. */
export function assertPublic(target) {
  let size = 0;
  try {
    size = statSync(PRIVATE_LINES).size;
  } catch {}
  if (size === 0) {
    stop(`${PRIVATE_LINES} is missing or empty, so ${target} cannot be checked.`);
  }

  const grep = spawnSync('grep', ['-r', '-i', '-F', '-H', '-n', '-f', PRIVATE_LINES, target], {
    encoding: 'utf8',
    maxBuffer: 256 << 20,
  });
  if (grep.status === 1) return; // grep found nothing
  if (grep.status !== 0) stop(`grep failed on ${target}: ${grep.stderr.trim()}`);

  // Name the places, not the text: the matched text is private.
  const places = new Set();
  for (const match of grep.stdout.split('\n')) {
    const place = match.match(/^(.*?):(\d+):/);
    if (place) places.add(`${place[1]}, line ${place[2]}`);
  }
  stop(
    `${target} matches the private lines at:\n` +
      [...places].map((place) => `  ${place}`).join('\n') +
      '\nFind what put that text there and remove it at the source. Do not commit or deploy.',
  );
}

function stop(message) {
  console.error(`\nPrivacy gate: ${message}\n`);
  process.exit(1);
}
