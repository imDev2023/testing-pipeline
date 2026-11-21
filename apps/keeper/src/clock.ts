// The runner's sense of time: what time it is, and timers for its passes and retries. The real
// clock is the system's; tests drive a fake one, so the passes and retries run when a test says
// while the chain they talk to is real (docs/spec/keeper-runner.md, "Testing it").

export type Timer = { readonly id: number };

export interface Clock {
    /** Milliseconds since the Unix epoch. */
    now(): number;
    /** Calls `fn` once, `ms` from now. */
    setTimer(ms: number, fn: () => void): Timer;
    clearTimer(timer: Timer): void;
}

const handles = new Map<number, NodeJS.Timeout>();
let nextHandle = 1;

export const systemClock: Clock = {
    now: () => Date.now(),
    setTimer(ms, fn) {
        const id = nextHandle++;
        // setTimeout holds at most 2^31 - 1 ms (about 24.8 days): settings.ts refuses longer
        // durations, and the daily pass is at most a day away.
        handles.set(
            id,
            setTimeout(() => {
                handles.delete(id);
                fn();
            }, ms),
        );
        return { id };
    },
    clearTimer(timer) {
        clearTimeout(handles.get(timer.id));
        handles.delete(timer.id);
    },
};

/** A clock that moves only when told to, firing each timer it passes, in order. */
export class FakeClock implements Clock {
    private time: number;
    private next = 1;
    private readonly timers = new Map<number, { at: number; fn: () => void }>();

    constructor(start: number) {
        this.time = start;
    }

    now() {
        return this.time;
    }

    setTimer(ms: number, fn: () => void): Timer {
        const id = this.next++;
        this.timers.set(id, { at: this.time + Math.max(0, ms), fn });
        return { id };
    }

    clearTimer(timer: Timer) {
        this.timers.delete(timer.id);
    }

    /** When the next timer fires, if any. */
    nextTimerAt(): number | null {
        let earliest: number | null = null;
        for (const { at } of this.timers.values()) if (earliest === null || at < earliest) earliest = at;
        return earliest;
    }

    /**
     * Moves the time forward by `ms`, firing every timer that falls due on the way at its own
     * time, and waiting for `drain` after each, so work a timer starts finishes before the next.
     */
    async advance(ms: number, drain: () => Promise<void> = async () => {}) {
        const end = this.time + ms;
        for (;;) {
            let due: [number, { at: number; fn: () => void }] | undefined;
            for (const entry of this.timers) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
            if (!due) break;
            this.timers.delete(due[0]);
            this.time = Math.max(this.time, due[1].at);
            due[1].fn();
            await drain();
        }
        this.time = end;
        await drain();
    }
}
