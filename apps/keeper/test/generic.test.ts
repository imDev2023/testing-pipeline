// The runner is generic over products (docs/spec/keeper-runner.md, "One definition of due"):
// what is due and how to build it live in packages/keeper-jobs, so no runner code names a
// product's instruction or imports a product's client, and a product added there needs no
// change here.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
/** The runner, and the script that installs it as a launchd agent; scripts/demo-trade.ts only makes demo trades. */
const runnerFiles = [
    ...readdirSync(join(root, 'src'))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join('src', name)),
    join('scripts', 'agent.ts'),
];

/** Every instruction of the buy wall AMM and the tax AMM a keeper job sends, in either spelling. */
const INSTRUCTIONS = [/place_?wall/i, /pay_?rewards/i, /sweep_?fees/i, /\bsettle\b/, /\bdistribute\b/];
const CLIENTS = /buy-wall-amm-scripts|tax-amm-scripts|lending-amm-scripts/;

test("no runner code names a product's keeper instruction or imports a product's client", () => {
    assert.ok(runnerFiles.includes(join('src', 'runner.ts')));
    const found: string[] = [];
    for (const file of runnerFiles) {
        readFileSync(join(root, file), 'utf8')
            .split('\n')
            .forEach((line, i) => {
                if (INSTRUCTIONS.some((name) => name.test(line)) || CLIENTS.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
            });
    }
    assert.deepEqual(found, []);
});
