// How `contained.ts` reads its command line: a subcommand, then only the flags it takes.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UsageError } from './args.ts';
import { DEVNET_URL, LOCALNET_URL } from './chain.ts';
import { parseContainedArgs } from './contained-args.ts';

const MINT = '5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX';

test('list takes the cluster and an optional record', () => {
    assert.deepEqual(parseContainedArgs(['list', '--cluster', 'devnet']), { command: 'list', cluster: { url: DEVNET_URL, local: false }, record: undefined });
    assert.deepEqual(parseContainedArgs(['list', '--cluster', 'http://127.0.0.1:8984', '--record', 'out.json']), {
        command: 'list',
        cluster: { url: 'http://127.0.0.1:8984', local: true },
        record: 'out.json',
    });
});

test('trade takes the mint, the wallet and the buy in quote-mint base units', () => {
    assert.deepEqual(parseContainedArgs(['trade', '--cluster', 'localnet', '--mint', MINT, '--wallet', 'w.json', '--buy', '1000000']), {
        command: 'trade',
        cluster: { url: LOCALNET_URL, local: true },
        record: undefined,
        mint: MINT,
        wallet: 'w.json',
        buy: 1_000_000n,
    });
});

test('unlock takes the mint and the payer, flags in any order', () => {
    assert.deepEqual(parseContainedArgs(['--payer', 'p.json', 'unlock', '--mint', MINT, '--cluster', 'devnet', '--record', 'r.json']), {
        command: 'unlock',
        cluster: { url: DEVNET_URL, local: false },
        record: 'r.json',
        mint: MINT,
        payer: 'p.json',
    });
});

test('a remote URL is not a local validator, so the scripts check its genesis hash is devnet', () => {
    const parsed = parseContainedArgs(['list', '--cluster', 'https://devnet.helius-rpc.com/']);
    assert.deepEqual(parsed.cluster, { url: 'https://devnet.helius-rpc.com/', local: false });
});

test('anything else is refused before connecting', () => {
    const refused = (argv: string[], message: RegExp) =>
        assert.throws(() => parseContainedArgs(argv), (error) => error instanceof UsageError && message.test(error.message), argv.join(' '));
    refused([], /give a subcommand/);
    refused(['launch', '--cluster', 'devnet'], /must be list, trade or unlock, not "launch"/);
    refused(['list', 'extra', '--cluster', 'devnet'], /list takes no other arguments/);
    refused(['list'], /--cluster is required/);
    refused(['list', '--cluster', 'mainnet'], /--cluster must be localnet, devnet or an RPC URL/);
    refused(['list', '--cluster', 'devnet', '--goal', '1'], /Unknown option '--goal'/);
    refused(['list', '--cluster', 'devnet', '--mint', MINT], /--mint is not a flag of list/);
    refused(['list', '--cluster'], /argument missing/);
    refused(['trade', '--cluster', 'devnet', '--wallet', 'w.json', '--buy', '1'], /trade needs --mint/);
    refused(['trade', '--cluster', 'devnet', '--mint', 'not-a-mint', '--wallet', 'w.json', '--buy', '1'], /--mint must be an address/);
    refused(['trade', '--cluster', 'devnet', '--mint', MINT, '--buy', '1'], /trade needs --wallet/);
    refused(['trade', '--cluster', 'devnet', '--mint', MINT, '--wallet', 'w.json'], /trade needs --buy/);
    refused(['trade', '--cluster', 'devnet', '--mint', MINT, '--wallet', 'w.json', '--buy', '1.5'], /--buy must be a whole number/);
    refused(['trade', '--cluster', 'devnet', '--mint', MINT, '--wallet', 'w.json', '--buy', '0'], /--buy must be above zero/);
    refused(['trade', '--cluster', 'devnet', '--mint', MINT, '--wallet', 'w.json', '--buy', '18446744073709551616'], /--buy must fit in a u64/);
    refused(['trade', '--cluster', 'devnet', '--mint', MINT, '--wallet', 'w.json', '--buy', '1', '--payer', 'p.json'], /--payer is not a flag of trade/);
    refused(['unlock', '--cluster', 'devnet', '--mint', MINT], /unlock needs --payer/);
    refused(['unlock', '--cluster', 'devnet', '--mint', MINT, '--payer', 'p.json', '--wallet', 'w.json'], /--wallet is not a flag of unlock/);
    refused(['unlock', '--cluster', 'devnet', '--mint', MINT, '--payer', 'p.json', '--buy', '1'], /--buy is not a flag of unlock/);
});
