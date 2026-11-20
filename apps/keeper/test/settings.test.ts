// The runner's policy values: one module, each overridable by its KEEPER_ variable
// (docs/spec/keeper-runner.md, "Spending caps").

import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { describeSettings, loadSettings, SETTING_NAMES } from '../src/settings.ts';

const ALCHEMY = { ALCHEMY_API_KEY: 'alchemy-secret' };

describe('settings', () => {
    test('every setting has a default, and the RPC defaults come from ALCHEMY_API_KEY', () => {
        const settings = loadSettings(ALCHEMY);
        assert.equal(settings.rpcUrl, 'https://solana-devnet.g.alchemy.com/v2/alchemy-secret');
        assert.equal(settings.keypair, join(homedir(), '.config/testing-pipeline/devnet/keeper.json'));
        assert.equal(settings.databaseUrl, null);
        assert.ok(settings.retryDelaysMs.length > 0);
        assert.ok(settings.minBalance < settings.lowBalance && settings.lowBalance < settings.floatTarget);
        assert.ok(settings.maxTxCost <= settings.marketDailyCap && settings.marketDailyCap <= settings.dailyCap);
    });

    test("Alchemy's free devnet endpoint serves neither logsSubscribe nor getProgramAccounts, so neither defaults to it", () => {
        const settings = loadSettings(ALCHEMY);
        assert.doesNotMatch(settings.wsUrl, /alchemy/);
        assert.doesNotMatch(settings.discoveryRpcUrl, /alchemy/);
    });

    test("Aviary's own Helius key, once the project's .env has it, carries the socket and discovery", () => {
        const settings = loadSettings({ ...ALCHEMY, RPC_URL: 'https://devnet.helius-rpc.com/?api-key=aviary-secret' });
        assert.equal(settings.wsUrl, 'wss://devnet.helius-rpc.com/?api-key=aviary-secret');
        assert.equal(settings.discoveryRpcUrl, 'https://devnet.helius-rpc.com/?api-key=aviary-secret');
        assert.equal(settings.rpcUrl, 'https://solana-devnet.g.alchemy.com/v2/alchemy-secret');
    });

    test('each setting is overridden by its KEEPER_ variable', () => {
        const settings = loadSettings({
            ...ALCHEMY,
            KEEPER_FLOAT_TARGET: '3',
            KEEPER_LOW_BALANCE: '0.75',
            KEEPER_MIN_BALANCE: '0.2',
            KEEPER_MAX_TX_COST: '0.000005',
            KEEPER_MARKET_DAILY_CAP: '0.02',
            KEEPER_DAILY_CAP: '0.5',
            KEEPER_PRIORITY_FEE_MICROLAMPORTS: '1000',
            KEEPER_TIP_UNWRAP_AT: '0.1',
            KEEPER_RETRY_DELAYS: '1s, 5s',
            KEEPER_SWEEP_INTERVAL: '90s',
            KEEPER_SETTLE_INTERVAL: '2h',
            KEEPER_DAILY_PASS_UTC: '13:45',
            KEEPER_KEYPAIR: '/keys/keeper.json',
            KEEPER_RPC_URL: 'http://127.0.0.1:8999',
            KEEPER_WS_URL: 'ws://127.0.0.1:9000',
            KEEPER_DISCOVERY_RPC_URL: 'http://127.0.0.1:8999',
            KEEPER_DATABASE_URL: 'postgres://example',
        });
        assert.equal(settings.floatTarget, 3_000_000_000n);
        assert.equal(settings.lowBalance, 750_000_000n);
        assert.equal(settings.minBalance, 200_000_000n);
        assert.equal(settings.maxTxCost, 5_000n);
        assert.equal(settings.marketDailyCap, 20_000_000n);
        assert.equal(settings.dailyCap, 500_000_000n);
        assert.equal(settings.priorityFeeMicrolamports, 1_000n);
        assert.equal(settings.tipUnwrapAt, 100_000_000n);
        assert.deepEqual(settings.retryDelaysMs, [1_000, 5_000]);
        assert.equal(settings.sweepIntervalMs, 90_000);
        assert.equal(settings.settleIntervalMs, 7_200_000);
        assert.deepEqual(settings.dailyPassUtc, { hour: 13, minute: 45 });
        assert.equal(settings.keypair, '/keys/keeper.json');
        assert.equal(settings.rpcUrl, 'http://127.0.0.1:8999');
        assert.equal(settings.wsUrl, 'ws://127.0.0.1:9000');
        assert.equal(settings.discoveryRpcUrl, 'http://127.0.0.1:8999');
        assert.equal(settings.databaseUrl, 'postgres://example');
    });

    test('a KEEPER_ variable that names no setting is refused, so a typo never leaves a default in force', () => {
        assert.throws(() => loadSettings({ ...ALCHEMY, KEEPER_DAILY_CAPS: '1' }), /KEEPER_DAILY_CAPS/);
    });

    test('a value that does not parse is refused with its name', () => {
        assert.throws(() => loadSettings({ ...ALCHEMY, KEEPER_DAILY_CAP: 'lots' }), /KEEPER_DAILY_CAP/);
        assert.throws(() => loadSettings({ ...ALCHEMY, KEEPER_MAX_TX_COST: '0.0000000001' }), /KEEPER_MAX_TX_COST/);
        assert.throws(() => loadSettings({ ...ALCHEMY, KEEPER_DAILY_PASS_UTC: '24:00' }), /KEEPER_DAILY_PASS_UTC/);
        assert.throws(() => loadSettings({ ...ALCHEMY, KEEPER_RETRY_DELAYS: '30' }), /KEEPER_RETRY_DELAYS/);
        // Longer than a Node timer holds, which would fire at once and repeat.
        assert.throws(() => loadSettings({ ...ALCHEMY, KEEPER_SWEEP_INTERVAL: '600h' }), /KEEPER_SWEEP_INTERVAL/);
        assert.equal(loadSettings({ ...ALCHEMY, KEEPER_SWEEP_INTERVAL: '596h' }).sweepIntervalMs, 596 * 3_600_000);
    });

    test('with no RPC URL and no ALCHEMY_API_KEY the runner refuses to start', () => {
        assert.throws(() => loadSettings({}), /KEEPER_RPC_URL/);
    });

    test('the values it started with are described in full, with no API key in them', () => {
        const env = {
            ...ALCHEMY,
            RPC_URL: 'https://devnet.helius-rpc.com/?api-key=aviary-secret',
            KEEPER_DATABASE_URL: 'postgres://user:db-secret@host/db',
            KEEPER_DAILY_CAP: '0.25',
            KEEPER_RETRY_DELAYS: '5s,90s,2h',
        };
        const described = describeSettings(loadSettings(env));
        assert.deepEqual(Object.keys(described).sort(), [...SETTING_NAMES].sort());
        const text = JSON.stringify(described);
        for (const secret of ['alchemy-secret', 'aviary-secret', 'db-secret']) assert.doesNotMatch(text, new RegExp(secret));
        assert.equal(described.DAILY_CAP, '0.25 SOL');
        assert.equal(described.RETRY_DELAYS, '5s, 90s, 2h');
    });
});
