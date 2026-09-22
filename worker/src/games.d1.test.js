import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handleTournaments, recountPgnGames, resolvePlayerNorm } from './games.js';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const migrationFiles = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();

// A D1 binding over node:sqlite with the real migrations applied, so these
// tests run production SQL against the production schema. `before` stops
// short of a migration so a test can seed rows for it to backfill. Every
// prepared statement is recorded so a test can ask SQLite for its plan.
function d1({ before } = {}) {
    const db = new DatabaseSync(':memory:');
    const pending = [...migrationFiles];
    const migrate = (until) => {
        while (pending.length && !(until && pending[0] >= until)) {
            db.exec(fs.readFileSync(new URL(pending.shift(), MIGRATIONS), 'utf8'));
        }
    };
    migrate(before);

    const prepared = [];
    const stmt = (sql, params) => ({
        bind: (...p) => stmt(sql, p),
        first: async () => db.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        run: async () => ({ meta: { changes: db.prepare(sql).run(...params).changes } }),
    });
    return {
        db, prepared,
        migrateRest: () => migrate(),
        env: { DB: { prepare: (sql) => { prepared.push(sql); return stmt(sql, []); } } },
    };
}

const plan = (db, sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(r => r.detail);

// Whether a statement opens any b-tree of `table` — the table itself or one
// of its indexes — for reading, which is what D1 bills as rows read. Read
// from the bytecode, not the query plan: the plan names an aliased table by
// its alias ("SEARCH g USING INDEX ..."), so a text match on the table name
// misses exactly the join this guards against.
function readsTable(db, sql, table) {
    const roots = new Set(db.prepare('SELECT rootpage FROM sqlite_schema WHERE tbl_name = ?').all(table).map(r => r.rootpage));
    return db.prepare(`EXPLAIN ${sql}`).all().some(op => op.opcode === 'OpenRead' && roots.has(op.p2));
}

function tournament(db, slug, firstRound) {
    db.prepare('INSERT INTO tournaments (slug, name, round_dates) VALUES (?, ?, ?)')
        .run(slug, slug.toUpperCase(), JSON.stringify([firstRound]));
}

let board = 0;
function game(db, slug, pgn) {
    board++;
    db.prepare(`INSERT INTO games (tournament_slug, round, board, white, black, white_norm, black_norm, pgn)
                VALUES (?, 1, ?, 'W', 'B', 'w', 'b', ?)`).run(slug, board, pgn);
}

const count = (db, slug) => db.prepare('SELECT pgn_games FROM tournaments WHERE slug = ?').get(slug).pgn_games;

describe('migration 0012', () => {
    // Plant a known answer before the migration runs, then read it back.
    it('backfills pgn_games with games that have moves, ignoring empty and null PGNs', () => {
        const { db, migrateRest } = d1({ before: '0012' });
        tournament(db, 'fall', '2026-09-01T18:30:00');
        tournament(db, 'summer', '2026-06-01T18:30:00');
        tournament(db, 'empty', '2026-03-01T18:30:00');
        for (const pgn of ['1. e4', '1. d4', '1. c4', '', null]) game(db, 'fall', pgn);
        game(db, 'summer', '1. Nf3');

        migrateRest();

        expect(count(db, 'fall')).toBe(3);
        expect(count(db, 'summer')).toBe(1);
        expect(count(db, 'empty')).toBe(0);
    });

    it('defaults a tournament created later to zero', () => {
        const { db } = d1();
        tournament(db, 'next', '2026-12-01T18:30:00');
        expect(count(db, 'next')).toBe(0);
    });
});

describe('recountPgnGames', () => {
    function seeded() {
        const h = d1();
        tournament(h.db, 'fall', '2026-09-01T18:30:00');
        tournament(h.db, 'summer', '2026-06-01T18:30:00');
        return h;
    }

    // The cron recounts only the tournament it ingested — the whole point is
    // not touching every game — so an out-of-band write elsewhere stays stale.
    it('recounts only the named tournament', async () => {
        const { db, env } = seeded();
        game(db, 'fall', '1. e4');
        game(db, 'summer', '1. d4');

        await recountPgnGames(env, 'fall').run();

        expect(count(db, 'fall')).toBe(1);
        expect(count(db, 'summer')).toBe(0);
    });

    // ...which is what the daily run is for.
    it('recounts every tournament when given none', async () => {
        const { db, env } = seeded();
        game(db, 'fall', '1. e4');
        game(db, 'summer', '1. d4');
        game(db, 'summer', '1. c4');

        await recountPgnGames(env).run();

        expect(count(db, 'fall')).toBe(1);
        expect(count(db, 'summer')).toBe(2);
    });

    it('counts down when a game loses its moves', async () => {
        const { db, env } = seeded();
        game(db, 'fall', '1. e4');
        game(db, 'fall', '1. d4');
        await recountPgnGames(env, 'fall').run();
        db.prepare("UPDATE games SET pgn = '' WHERE pgn = '1. d4'").run();

        await recountPgnGames(env, 'fall').run();

        expect(count(db, 'fall')).toBe(1);
    });
});

describe('handleTournaments', () => {
    it('serves the stored count rather than recounting', async () => {
        const { db, env } = d1();
        tournament(db, 'fall', '2026-09-01T18:30:00');
        game(db, 'fall', '1. e4');
        // Deliberately wrong: if the handler counted games itself it would say 1.
        db.prepare("UPDATE tournaments SET pgn_games = 42 WHERE slug = 'fall'").run();

        const body = await (await handleTournaments(new Request('https://api/tournaments'), env)).json();

        expect(body.tournaments[0].pgnGameCount).toBe(42);
    });

    it('lists the newest tournament first', async () => {
        const { db, env } = d1();
        tournament(db, 'spring', '2026-03-01T18:30:00');
        tournament(db, 'fall', '2026-09-01T18:30:00');
        tournament(db, 'summer', '2026-06-01T18:30:00');

        const body = await (await handleTournaments(new Request('https://api/tournaments'), env)).json();

        expect(body.tournaments.map(t => t.slug)).toEqual(['fall', 'summer', 'spring']);
    });

    // The regression guard. Counting at read time joined every game on every
    // request; D1 bills that as rows read, and it was 81% of the daily budget.
    it('never reads the games table', async () => {
        const { db, env, prepared } = d1();
        await handleTournaments(new Request('https://api/tournaments'), env);

        expect(prepared.length).toBeGreaterThan(0);
        for (const sql of prepared) expect(readsTable(db, sql, 'games')).toBe(false);
    });
});

describe('resolvePlayerNorm', () => {
    function players() {
        const h = d1();
        const add = (name, norm, aliases = []) => h.db
            .prepare('INSERT INTO players (name, name_norm, aliases) VALUES (?, ?, ?)')
            .run(name, norm, JSON.stringify(aliases));
        add('Smith, James', 'james smith', ['jim smith']);
        add('Lee, Ann', 'ann lee');
        return h;
    }

    it('returns a canonical norm as-is', async () => {
        const { env } = players();
        expect(await resolvePlayerNorm('james smith', env)).toBe('james smith');
    });

    // The client sends canonical names, so this is nearly every call. The OR'd
    // alias test used to force a scan of every player; now the unique index
    // answers and the alias scan never runs.
    it('answers a canonical norm from the index, without the alias scan', async () => {
        const { db, env, prepared } = players();
        await resolvePlayerNorm('james smith', env);

        expect(prepared).toHaveLength(1);
        const steps = plan(db, prepared[0]);
        expect(steps.some(s => /SEARCH players USING (COVERING )?INDEX/.test(s))).toBe(true);
        expect(steps.some(s => /^SCAN players/.test(s))).toBe(false);
    });

    it('resolves an alias to its canonical norm', async () => {
        const { env } = players();
        expect(await resolvePlayerNorm('jim smith', env)).toBe('james smith');
    });

    it('returns an unknown norm unchanged', async () => {
        const { env } = players();
        expect(await resolvePlayerNorm('nobody here', env)).toBe('nobody here');
    });

    // The single OR'd query returned whichever row SQLite reached first.
    it('prefers the player whose own name matches over one listing it as an alias', async () => {
        const { db, env } = players();
        db.prepare('INSERT INTO players (name, name_norm, aliases) VALUES (?, ?, ?)')
            .run('Lee, Annie', 'annie lee', JSON.stringify(['ann lee']));
        expect(await resolvePlayerNorm('ann lee', env)).toBe('ann lee');
    });
});
