import { describe, it, expect } from 'vitest';
import { resolveGameIds } from './cron.js';

const FALL_R2_ERG_ID = '2352688410645319';

describe('resolveGameIds', () => {
    it('keeps an id no other game claims', () => {
        const ids = resolveGameIds([{ rowKey: 'fall:2:1', gameId: '2352688410596131' }], new Map());
        expect(ids.get('fall:2:1')).toBe('2352688410596131');
    });

    it('stores null when the PGN carries no GameId', () => {
        const ids = resolveGameIds([{ rowKey: 'fall:2:1', gameId: null }], new Map());
        expect(ids.get('fall:2:1')).toBeNull();
    });

    // Fall 2026 round 2: MI stamped one GameId on Hasteer–Robinson and
    // Hasteer–Guan. Nothing says which header is real, so neither keeps it —
    // and the rest of the round is unaffected.
    it('drops an id two games claim in the same write', () => {
        const ids = resolveGameIds([
            { rowKey: 'fall:2:933', gameId: FALL_R2_ERG_ID },
            { rowKey: 'fall:2:949', gameId: FALL_R2_ERG_ID },
            { rowKey: 'fall:2:1', gameId: '2352688410596131' },
        ], new Map());
        expect(ids.get('fall:2:933')).toBeNull();
        expect(ids.get('fall:2:949')).toBeNull();
        expect(ids.get('fall:2:1')).toBe('2352688410596131');
    });

    it('drops an id D1 already stores on a different game', () => {
        const owners = new Map([[FALL_R2_ERG_ID, 'summer:3:2']]);
        const ids = resolveGameIds([{ rowKey: 'fall:2:949', gameId: FALL_R2_ERG_ID }], owners);
        expect(ids.get('fall:2:949')).toBeNull();
    });

    it('keeps an id on the row that already holds it, even when another write claims it too', () => {
        const owners = new Map([[FALL_R2_ERG_ID, 'fall:2:933']]);
        const ids = resolveGameIds([
            { rowKey: 'fall:2:933', gameId: FALL_R2_ERG_ID },
            { rowKey: 'fall:2:949', gameId: FALL_R2_ERG_ID },
        ], owners);
        expect(ids.get('fall:2:933')).toBe(FALL_R2_ERG_ID);
        expect(ids.get('fall:2:949')).toBeNull();
    });
});
