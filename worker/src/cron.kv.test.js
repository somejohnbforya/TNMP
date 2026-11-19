import { describe, it, expect } from 'vitest';
import { putAppStateIfChanged } from './cron.js';

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
