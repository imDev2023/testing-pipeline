// Which RPC failures the scripts retry: rate limits and dropped connections, which public
// devnet and this network both produce, but never an answer the cluster gave.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isTransientRpcError } from './chain.ts';

const dropped = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`read ${code}`), { code }) });

test('a rate limit and a dropped connection are retried', () => {
    assert.equal(isTransientRpcError(new Error('HTTP error (429): Too Many Requests')), true);
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']) {
        assert.equal(isTransientRpcError(dropped(code)), true, code);
    }
    assert.equal(isTransientRpcError(new TypeError('fetch failed')), true);
});

test("the cluster's own answers are not retried", () => {
    assert.equal(isTransientRpcError(new Error('HTTP error (400): Bad Request')), false);
    assert.equal(isTransientRpcError(new Error('Transaction simulation failed: custom program error: 0x1787')), false);
});
