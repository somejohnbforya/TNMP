import { describe, it, expect } from 'vitest';
import { resolveGameIds, assignBoards, movedPairings } from './cron.js';

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

describe('assignBoards', () => {
    const row = (key, board, { extra = false, hasPgn = false } = {}) => ({ key, board, extra, hasPgn });
    const pgn = (key, board, extra = false) => ({ key, board, extra });
    const regularRows = (upTo) => Array.from({ length: upTo }, (_, i) => row(`regular-${i + 1}`, i + 1));

    // Fall 2026 R2: regular games end on 38 (26, 35 and 36 were forfeits). MI's
    // pairings list Hasteer–Guan on 41 but not the other two Extra Rated games,
    // and none of the three PGNs names a board.
    it('numbers Extra Rated games from the pairings, else right after the regular boards', () => {
        const rows = [
            ...regularRows(38).filter(r => ![26, 35, 36].includes(r.board)),
            row('guan|hasteer', 41, { extra: true }),
        ];
        const boards = assignBoards(rows, [
            pgn('hasteer|robinson', null, true),
            pgn('guan|hasteer', null, true),
            pgn('hallman|tobias', null, true),
        ]);
        expect(Object.fromEntries(boards)).toEqual({ 'hasteer|robinson': 39, 'guan|hasteer': 41, 'hallman|tobias': 40 });
    });

    // Summer 2026 R6: Walder–Shrauger (regular) and Canessa–Langendorf (Extra
    // Rated) were both tagged 6.8, with Extra Rated games already on 38–40.
    it("never puts a game on another pair's board, and places regular games first", () => {
        const rows = [
            ...regularRows(37).map(r => (r.board === 8 ? row('shrauger|walder', 8) : r)),
            row('erg-a', 38, { extra: true, hasPgn: true }),
            row('erg-b', 39, { extra: true, hasPgn: true }),
            row('erg-c', 40, { extra: true, hasPgn: true }),
        ];
        const boards = assignBoards(rows, [pgn('canessa|langendorf', 8, true), pgn('shrauger|walder', 8)]);
        expect(boards.get('shrauger|walder')).toBe(8);
        expect(boards.get('canessa|langendorf')).toBe(41);
    });

    // Summer 2026 R3: the pairings had Diller–Hasteer on 43; its PGN says 3.2.
    it("takes the board the PGN records over the pairings' board", () => {
        const rows = [row('pang|yoo', 1, { hasPgn: true }), row('diller|hasteer', 43)];
        expect(assignBoards(rows, [pgn('diller|hasteer', 2)]).get('diller|hasteer')).toBe(2);
    });

    it("falls back to its pair's stored board when the board it names is taken", () => {
        const rows = [row('a|b', 5), row('c|d', 7)];
        expect(assignBoards(rows, [pgn('c|d', 5)]).get('c|d')).toBe(7);
    });

    it('keeps a game already stored with moves on its board', () => {
        const rows = [...regularRows(37), row('canessa|langendorf', 41, { extra: true, hasPgn: true })];
        expect(assignBoards(rows, [pgn('canessa|langendorf', 50, true)]).get('canessa|langendorf')).toBe(41);
    });
});

describe('movedPairings', () => {
    const post = (key, board, rnd = 3) => ({ rnd, board, key });
    const store = (rows, rnd = 3) => {
        const placed = new Map([[rnd, new Map()]]);
        const existing = new Map();
        for (const [key, board, hasPgn = false] of rows) {
            placed.get(rnd).set(key, board);
            existing.set(`${rnd}:${board}`, { hasPgn });
        }
        return { placed, existing };
    };

    // Fall 2026 R3: Monday's pairings had these four on boards 2, 3, 4 and 7;
    // the results table renumbered them 1-4, and their results never landed.
    it('moves moveless games to the boards the results table renumbered', () => {
        const { placed, existing } = store([['bambou|zavgorodniy', 2], ['cawthon|yoo', 3], ['fang|wang', 4], ['parsons|powers', 7], ['stults|zhao', 5]]);
        const posted = [post('bambou|zavgorodniy', 1), post('cawthon|yoo', 2), post('fang|wang', 3), post('parsons|powers', 4), post('stults|zhao', 5)];
        expect(movedPairings(posted, placed, existing)).toEqual([
            { rnd: 3, key: 'bambou|zavgorodniy', from: 2, to: 1 },
            { rnd: 3, key: 'cawthon|yoo', from: 3, to: 2 },
            { rnd: 3, key: 'fang|wang', from: 4, to: 3 },
            { rnd: 3, key: 'parsons|powers', from: 7, to: 4 },
        ]);
    });

    it('moves both games that trade boards', () => {
        const { placed, existing } = store([['a|b', 1], ['c|d', 2]]);
        expect(movedPairings([post('a|b', 2), post('c|d', 1)], placed, existing)).toHaveLength(2);
    });

    it('leaves a game placed by its PGN on its board', () => {
        const { placed, existing } = store([['a|b', 9, true]]);
        expect(movedPairings([post('a|b', 2)], placed, existing)).toEqual([]);
    });

    it('moves a game once when MI lists its section twice', () => {
        const { placed, existing } = store([['a|b', 2]]);
        expect(movedPairings([post('a|b', 1), post('a|b', 1)], placed, existing)).toEqual([{ rnd: 3, key: 'a|b', from: 2, to: 1 }]);
    });

    it('ignores a pairing with no stored game', () => {
        const { placed, existing } = store([]);
        expect(movedPairings([post('a|b', 1)], placed, existing)).toEqual([]);
    });
});
