// `keeper once`, the built program as `pnpm keeper:once`, the launchd agent and the Docker image
// run it: one full pass and exit, the key read only from KEEPER_KEYPAIR and in no line it writes
// (docs/spec/keeper-runner.md, "The keeper wallet" and "Running it").

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createKeyPairSignerFromBytes, getBase58Decoder } from '@solana/kit';

import { checkLocalValidator, createMarket, fund, LOCAL_URL, LOCAL_WS_URL, owed, tokens, trade, wallet } from './harness.ts';

const run = promisify(execFile);
const BUNDLE = fileURLToPath(new URL('../../dist/keeper.mjs', import.meta.url));

before(async () => {
    await checkLocalValidator();
    await run('pnpm', ['build'], { cwd: fileURLToPath(new URL('../..', import.meta.url)) });
});

/** A solana-keygen key file of a fresh key, and the key's secret in the forms it could leak in. */
function keyFile(): { path: string; bytes: number[]; leaks: string[] } {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
    const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const bytes = [...secret, ...pub];
    const path = join(mkdtempSync(join(tmpdir(), 'keeper-key-')), 'keeper.json');
    writeFileSync(path, JSON.stringify(bytes), { mode: 0o600 });
    const base58 = getBase58Decoder();
    return {
        path,
        bytes,
        leaks: [JSON.stringify(bytes), bytes.join(','), base58.decode(new Uint8Array(bytes)), base58.decode(secret), Buffer.from(secret).toString('hex'), Buffer.from(secret).toString('base64')],
    };
}

test('keeper once runs one full pass and exits, never writing the key', async () => {
    const owner = await wallet(10n);
    const mints = await tokens(owner);
    const market = await createMarket(owner, mints);
    await trade(market);
    const key = keyFile();
    const keeper = await createKeyPairSignerFromBytes(new Uint8Array(key.bytes));
    await fund(keeper.address, 2_000_000_000n);

    const { stdout, stderr } = await run(process.execPath, [BUNDLE, 'once'], {
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            KEEPER_KEYPAIR: key.path,
            KEEPER_RPC_URL: LOCAL_URL,
            KEEPER_DISCOVERY_RPC_URL: LOCAL_URL,
            KEEPER_WS_URL: LOCAL_WS_URL,
        },
        timeout: 300_000,
        maxBuffer: 64 * 1024 * 1024,
    });
    const rows = stdout.trimEnd().split('\n').map((line) => JSON.parse(line));
    // It starts by logging every setting it runs with.
    assert.equal(rows[0].row, 'start');
    assert.equal(rows[0].mode, 'once');
    assert.equal(rows[0].wallet, keeper.address);
    assert.ok(rows[0].settings.DAILY_CAP && rows[0].settings.RETRY_DELAYS && rows[0].settings.KEYPAIR === key.path);
    // One pass, the full one, which pays this market as well as any other owing on the validator.
    const passes = rows.filter((row) => row.row === 'pass');
    assert.deepEqual(passes.map((row) => row.pass), ['once']);
    const sent = rows.filter((row) => row.row === 'job' && row.market === market.marketState && row.outcome === 'sent');
    assert.equal(sent.length, 4);
    assert.deepEqual(await owed(market), [0n, 0n, 0n, 0n, 0n, 0n]);
    for (const leak of key.leaks) {
        assert.ok(!stdout.includes(leak) && !stderr.includes(leak), 'the key must appear in no line the runner writes');
    }
});

test('keeper once refuses to start without a readable key, naming only the path', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'keeper-key-')), 'missing.json');
    await assert.rejects(
        run(process.execPath, [BUNDLE, 'once'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, KEEPER_KEYPAIR: path, KEEPER_RPC_URL: LOCAL_URL } }),
        (error: { stderr: string; code: number }) => error.code === 1 && error.stderr.includes(path) && error.stderr.includes('KEEPER_KEYPAIR'),
    );
});
