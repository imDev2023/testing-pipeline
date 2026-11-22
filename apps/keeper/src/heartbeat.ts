// The runner's heartbeat (SUITE-57; docs/spec/keeper-runner.md, "How Aviary shows it"): after each
// pass it posts which pass ran and when to `terminal-api`'s /keeper/heartbeat (HEARTBEAT_URL),
// signed with the keeper wallet's key, so the keeper page can tell a quiet runner from a stopped
// one while Postgres sleeps (the runner records there only the passes that did something).
//
// A heartbeat never holds up or stops the runner: it goes in the background, one at a time, and
// while one is on its way only the newest of those after it is kept. A refusal or a failure is
// logged and the next pass sends another.

import { getBase58Decoder, signBytes, type KeyPairSigner } from '@solana/kit';
import { keeperHeartbeatMessage, type KeeperHeartbeatPayload } from 'terminal-api/contract';

import type { Logger } from './log.ts';
import { LIMITS } from './settings.ts';

export interface Heartbeat {
    /** Queues a heartbeat; returns at once. */
    beat(payload: KeeperHeartbeatPayload): void;
    /** Resolves once nothing is on its way or queued. */
    flush(): Promise<void>;
}

export function heartbeatSender(options: { url: string; signer: KeyPairSigner; log: Logger; fetch?: typeof fetch }): Heartbeat {
    const { url, signer, log } = options;
    const send = options.fetch ?? fetch;
    let pending: KeeperHeartbeatPayload | null = null;
    let running: Promise<void> | null = null;

    async function post(payload: KeeperHeartbeatPayload) {
        try {
            const text = JSON.stringify(payload);
            const signature = getBase58Decoder().decode(await signBytes(signer.keyPair.privateKey, keeperHeartbeatMessage(text)));
            const response = await send(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ payload: text, signature }),
                signal: AbortSignal.timeout(LIMITS.heartbeatTimeoutMs),
            });
            if (!response.ok) {
                const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
                log.write({ row: 'heartbeat', outcome: 'refused', status: response.status, error: typeof body?.error === 'string' ? body.error : null });
            }
        } catch (error) {
            log.write({ row: 'heartbeat', outcome: 'failed', error: (error as Error)?.name ?? String(error) });
        }
    }

    async function drain() {
        try {
            while (pending) {
                const next = pending;
                pending = null;
                await post(next);
            }
        } finally {
            running = null;
        }
    }

    return {
        beat(payload) {
            pending = payload;
            running ??= drain();
        },
        async flush() {
            while (running) await running;
        },
    };
}
