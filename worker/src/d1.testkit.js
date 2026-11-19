import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const migrationFiles = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();

// A D1 binding over node:sqlite with the real migrations applied, so these
// tests run production SQL against the production schema. `before` stops
// short of a migration so a test can seed rows for it to backfill. Every
// prepared statement is recorded so a test can ask SQLite for its plan.
export function d1({ before } = {}) {
    const db = new DatabaseSync(':memory:');
    const pending = [...migrationFiles];
    const migrate = (until) => {
        while (pending.length && !(until && pending[0] >= until)) {
            db.exec(fs.readFileSync(new URL(pending.shift(), MIGRATIONS), 'utf8'));
        }
    };
    migrate(before);

    const prepared = [];
    const exec = (sql, params) => ({ results: [], meta: { changes: Number(db.prepare(sql).run(...params).changes) } });
    const stmt = (sql, params) => ({
        bind: (...p) => stmt(sql, p),
        first: async () => db.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        run: async () => exec(sql, params),
        exec: () => exec(sql, params),
    });
    // D1 runs a batch as one transaction: all of it lands, or none.
    const batch = async (stmts) => {
        db.exec('BEGIN');
        try {
            const out = stmts.map(s => s.exec());
            db.exec('COMMIT');
            return out;
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    };
    return {
        db, prepared,
        migrateRest: () => migrate(),
        env: { DB: { prepare: (sql) => { prepared.push(sql); return stmt(sql, []); }, batch } },
    };
}
