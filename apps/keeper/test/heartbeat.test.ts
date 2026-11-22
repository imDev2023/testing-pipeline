// The runner's heartbeat (SUITE-57): after each pass it posts what pass ran and when to Aviary's
// API, signed with the keeper wallet's key, so the keeper page can tell a quiet runner from a
// stopped one while Postgres sleeps. A heartbeat never holds up or stops the runner.

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { generateKeyPairSigner, getBase58Encoder, getPublicKeyFromAddress, signatureBytes, verifySignature, type KeyPairSigner } from '@solana/kit';
import { KeeperHeartbeat, KeeperHeartbeatPayload, keeperHeartbeatMessage } from 'terminal-api/contract';

import { heartbeatSender } from '../src/heartbeat.ts';
import { MemoryLogger } from '../src/log.ts';

const CAPS = { maxTxCost: 3_000_000, marketDailyCap: 10_000_000, dailyCap: 100_000_000, minBalance: 100_000_000, lowBalance: 500_000_000 };

let signer: KeyPairSigner;
let server: Server;
let url: string;
let received: { payload: string; signature: string }[] = [];
let respond: (req: IncomingMessage, res: ServerResponse) => void = (_, res) => res.writeHead(202).end('{"stored":true}');

before(async () => {
    signer = await generateKeyPairSigner();
    server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            received.push(KeeperHeartbeat.parse(JSON.parse(body)));
            respond(req, res);
        });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/keeper/heartbeat`;
});
after(() => new Promise<void>((done) => server.close(() => done())));

const beat = (pass: 'sweep' | 'daily' | 'transaction', at = '2026-11-22T12:00:00.000Z') => ({ wallet: signer.address, pass, at, sweepIntervalMs: 600_000, caps: CAPS, warnings: [] });

test("each heartbeat carries the pass and is signed with the keeper wallet's key", async () => {
    received = [];
    const heartbeat = heartbeatSender({ url, signer, log: new MemoryLogger() });
    heartbeat.beat(beat('daily'));
    await heartbeat.flush();
    assert.equal(received.length, 1);
    const [{ payload, signature }] = received as [{ payload: string; signature: string }];
    assert.deepEqual(KeeperHeartbeatPayload.parse(JSON.parse(payload)), beat('daily'));
    const key = await getPublicKeyFromAddress(signer.address);
    assert.ok(await verifySignature(key, signatureBytes(new Uint8Array(getBase58Encoder().encode(signature))), keeperHeartbeatMessage(payload)));
});

test('while one heartbeat is on its way, only the newest of those after it is sent', async () => {
    received = [];
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    respond = (_, res) => void held.then(() => res.writeHead(202).end('{"stored":true}'));
    const heartbeat = heartbeatSender({ url, signer, log: new MemoryLogger() });
    heartbeat.beat(beat('sweep', '2026-11-22T12:00:00.000Z'));
    heartbeat.beat(beat('transaction', '2026-11-22T12:00:01.000Z'));
    heartbeat.beat(beat('transaction', '2026-11-22T12:00:02.000Z'));
    await new Promise((done) => setTimeout(done, 50));
    release();
    await heartbeat.flush();
    respond = (_, res) => res.writeHead(202).end('{"stored":true}');
    assert.deepEqual(
        received.map(({ payload }) => JSON.parse(payload).at),
        ['2026-11-22T12:00:00.000Z', '2026-11-22T12:00:02.000Z'],
    );
});

test('a refused or failed heartbeat is logged, never thrown, and the next one is still sent', async () => {
    received = [];
    respond = (_, res) => res.writeHead(409, { 'content-type': 'application/json' }).end('{"error":"The heartbeat\'s time is too far from now."}');
    const log = new MemoryLogger();
    const heartbeat = heartbeatSender({ url, signer, log });
    heartbeat.beat(beat('sweep'));
    await heartbeat.flush();
    respond = (_, res) => res.writeHead(202).end('{"stored":true}');
    assert.deepEqual(log.of('heartbeat'), [{ row: 'heartbeat', outcome: 'refused', status: 409, error: "The heartbeat's time is too far from now." }]);

    const unreachable = heartbeatSender({ url: 'http://127.0.0.1:9/keeper/heartbeat', signer, log });
    unreachable.beat(beat('sweep'));
    await unreachable.flush();
    assert.equal(log.of('heartbeat').at(-1)?.outcome, 'failed');

    heartbeat.beat(beat('daily'));
    await heartbeat.flush();
    assert.equal(received.length, 2);
});
