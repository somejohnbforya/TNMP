/**
 * Audit games.date formats in D1 — find rows still in PGN dot-format
 * (e.g. 2026.05.19) that break lexicographic date sorting against
 * ISO datetimes ('.' > '-' in ASCII).
 *
 * Prerequisites: npx wrangler whoami (to refresh OAuth token)
 * Usage: node scripts/audit-date-formats.mjs
 */

import { readFileSync } from 'fs';

const ACCOUNT_ID = 'c84c98ab1610858ea513be97ec1623b7';
const DB_ID = '571ae443-e8d3-4ffa-819b-51cbd9471d47';

function getToken() {
    const toml = readFileSync(`${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`, 'utf-8');
    const match = toml.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (!match) throw new Error('No OAuth token found — run: npx wrangler whoami');
    return match[1];
}

async function query(sql, params = []) {
    const token = getToken();
    const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql, params }),
        }
    );
    const data = await res.json();
    if (!data.success) throw new Error(JSON.stringify(data.errors));
    return data.result[0].results;
}

const byFormat = await query(`
    SELECT
        CASE
            WHEN date IS NULL THEN 'null'
            WHEN date LIKE '____.__.__' THEN 'dot'
            WHEN date LIKE '____-__-__T%' THEN 'iso-datetime'
            WHEN date LIKE '____-__-__' THEN 'iso-date'
            ELSE 'other'
        END AS fmt,
        COUNT(*) AS n
    FROM games GROUP BY fmt ORDER BY n DESC
`);
console.log('games.date formats:');
for (const r of byFormat) console.log(`  ${r.fmt.padEnd(14)} ${r.n}`);

const dotRows = await query(`
    SELECT tournament_slug, COUNT(*) AS n, MIN(date) AS min_d, MAX(date) AS max_d,
           GROUP_CONCAT(DISTINCT round) AS rounds
    FROM games WHERE date LIKE '____.__.__'
    GROUP BY tournament_slug ORDER BY n DESC
`);
console.log('\nDot-format rows by tournament:');
for (const r of dotRows) console.log(`  ${r.tournament_slug}: ${r.n} rows, rounds [${r.rounds}], ${r.min_d}..${r.max_d}`);

const others = await query(`
    SELECT id, tournament_slug, round, board, date FROM games
    WHERE date IS NOT NULL
      AND date NOT LIKE '____.__.__'
      AND date NOT LIKE '____-__-__T%'
      AND date NOT LIKE '____-__-__'
    LIMIT 20
`);
if (others.length) {
    console.log('\nUnrecognized formats (up to 20):');
    for (const r of others) console.log(`  #${r.id} ${r.tournament_slug} r${r.round} b${r.board}: ${JSON.stringify(r.date)}`);
}
