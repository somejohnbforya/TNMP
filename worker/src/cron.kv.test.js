import { describe, it, expect, vi, beforeEach } from 'vitest';

// cron.js calls into push.js for the retry sweep; the sweep's whole point is
// deciding whether that call happens at all, so the module is stubbed and the
// assertion is on the call count.
const retryPendingNotifications = vi.fn();
vi.mock('./push.js', () => ({
    retryPendingNotifications: (...a) => retryPendingNotifications(...a),
    listPushSubscriptions: vi.fn(),
    dispatchPushNotifications: vi.fn(),
}));

const { putAppStateIfChanged, sweepPendingRetries } = await import('./cron.js');

function fakeKV(initial = {}) {
    const store = new Map(Object.entries(initial));
    const ops = { get: 0, put: 0 };
    return {
        ops,
        read: (k) => JSON.parse(store.get(k)),
        async get(key, type) {
            ops.get++;
            const v = store.get(key);
            if (v === undefined) return null;
            return type === 'json' ? JSON.parse(v) : v;
        },
        async put(key, value) { ops.put++; store.set(key, value); },
    };
}

function fakeStorage(initial = {}) {
    const m = new Map(Object.entries(initial));
    return {
        peek: (k) => m.get(k),
        async get(k) { return m.get(k); },
        async put(k, v) {
            if (typeof k === 'object') { for (const [kk, vv] of Object.entries(k)) m.set(kk, vv); return; }
            m.set(k, v);
        },
    };
}

const STATE = {
    state: 'yes', round: 4,
    tournamentName: 'Fall TNM', tournamentUrl: 'https://mi/fall', tournamentSlug: '2026-fall',
    roundDates: ['2026-09-22T01:30:00Z', '2026-09-29T01:30:00Z'],
    // computeAppState returns these too; the cache stores neither.
    info: 'Round 4 pairings are up!', totalRounds: 8, offSeason: null,
};

describe('putAppStateIfChanged', () => {
    it('writes when the key is absent', async () => {
        const SUBSCRIBERS = fakeKV();
        expect(await putAppStateIfChanged({ SUBSCRIBERS }, STATE)).toBe(true);
        expect(SUBSCRIBERS.ops.put).toBe(1);
    });

    it('stores only the cached fields, plus fetchedAt', async () => {
        const SUBSCRIBERS = fakeKV();
        await putAppStateIfChanged({ SUBSCRIBERS }, STATE);
        expect(Object.keys(SUBSCRIBERS.read('cache:appState')).sort()).toEqual([
            'fetchedAt', 'round', 'roundDates', 'state', 'tournamentName', 'tournamentSlug', 'tournamentUrl',
        ]);
    });

    it('does not write when nothing changed', async () => {
        const SUBSCRIBERS = fakeKV();
        await putAppStateIfChanged({ SUBSCRIBERS }, STATE);
        const after = SUBSCRIBERS.ops.put;
        expect(await putAppStateIfChanged({ SUBSCRIBERS }, STATE)).toBe(false);
        expect(SUBSCRIBERS.ops.put).toBe(after);
    });

    // The guard's whole reason for existing: fetchedAt moves every tick, so a
    // naive whole-payload comparison would never match and the cron would keep
    // writing a thousand identical records a night.
    it('ignores a stale fetchedAt', async () => {
        const SUBSCRIBERS = fakeKV({
            'cache:appState': JSON.stringify({
                state: 'yes', round: 4,
                tournamentName: 'Fall TNM', tournamentUrl: 'https://mi/fall', tournamentSlug: '2026-fall',
                roundDates: ['2026-09-22T01:30:00Z', '2026-09-29T01:30:00Z'],
                fetchedAt: '1999-01-01T00:00:00.000Z',
            }),
        });
        expect(await putAppStateIfChanged({ SUBSCRIBERS }, STATE)).toBe(false);
        expect(SUBSCRIBERS.ops.put).toBe(0);
    });

    it('writes when the round advances', async () => {
        const SUBSCRIBERS = fakeKV();
        await putAppStateIfChanged({ SUBSCRIBERS }, STATE);
        expect(await putAppStateIfChanged({ SUBSCRIBERS }, { ...STATE, round: 5 })).toBe(true);
        expect(SUBSCRIBERS.read('cache:appState').round).toBe(5);
    });

    it('writes when the state verb changes', async () => {
        const SUBSCRIBERS = fakeKV();
        await putAppStateIfChanged({ SUBSCRIBERS }, STATE);
        expect(await putAppStateIfChanged({ SUBSCRIBERS }, { ...STATE, state: 'in_progress' })).toBe(true);
    });

    it('writes when a round date is rescheduled', async () => {
        const SUBSCRIBERS = fakeKV();
        await putAppStateIfChanged({ SUBSCRIBERS }, STATE);
        const moved = { ...STATE, roundDates: ['2026-09-22T01:30:00Z', '2026-09-30T01:30:00Z'] };
        expect(await putAppStateIfChanged({ SUBSCRIBERS }, moved)).toBe(true);
    });
});

describe('sweepPendingRetries', () => {
    beforeEach(() => retryPendingNotifications.mockReset());

    it('does not scan when nothing is pending and the floor is not due', async () => {
        const storage = fakeStorage({ pendingRetries: false, lastRetrySweep: Date.now() });
        await sweepPendingRetries({}, storage);
        expect(retryPendingNotifications).not.toHaveBeenCalled();
    });

    it('scans when a dispatch armed the flag', async () => {
        retryPendingNotifications.mockResolvedValue({ count: 1, remaining: 0 });
        const storage = fakeStorage({ pendingRetries: true, lastRetrySweep: Date.now() });
        await sweepPendingRetries({}, storage);
        expect(retryPendingNotifications).toHaveBeenCalledOnce();
    });

    it('disarms the flag once nothing is left pending', async () => {
        retryPendingNotifications.mockResolvedValue({ count: 1, remaining: 0 });
        const storage = fakeStorage({ pendingRetries: true, lastRetrySweep: Date.now() });
        await sweepPendingRetries({}, storage);
        expect(storage.peek('pendingRetries')).toBe(false);
    });

    it('keeps the flag armed while a retry is still waiting', async () => {
        retryPendingNotifications.mockResolvedValue({ count: 0, remaining: 2 });
        const storage = fakeStorage({ pendingRetries: true, lastRetrySweep: Date.now() });
        await sweepPendingRetries({}, storage);
        expect(storage.peek('pendingRetries')).toBe(true);
    });

    // The self-healing half: a retry stranded by a lost flag waits an hour,
    // not forever.
    it('scans on the hourly floor even with the flag clear', async () => {
        retryPendingNotifications.mockResolvedValue({ count: 0, remaining: 0 });
        const storage = fakeStorage({ pendingRetries: false, lastRetrySweep: Date.now() - 61 * 60 * 1000 });
        await sweepPendingRetries({}, storage);
        expect(retryPendingNotifications).toHaveBeenCalledOnce();
    });

    it('scans on a cold start, when no sweep has ever run', async () => {
        retryPendingNotifications.mockResolvedValue({ count: 0, remaining: 0 });
        const storage = fakeStorage();
        await sweepPendingRetries({}, storage);
        expect(retryPendingNotifications).toHaveBeenCalledOnce();
    });
});
