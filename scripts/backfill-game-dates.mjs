/**
 * Backfill games.date to canonical round ISO datetimes.
 *
 * Fixes legacy rows still carrying PGN dot-format dates (2026.05.19) or
 * bare ISO dates (2026-05-19). Both break or degrade lexicographic date
 * sorting against the canonical ISO-datetime format the cron now writes
 * (dot-format lex-sorts ABOVE ISO since '.' > '-' in ASCII — this is the
 * "3rd Silman above 2026 Summer" sort bug).
 *
 * Each bad row gets its tournament's round_dates[round-1]. Rows whose
 * round has no entry in round_dates are reported and left untouched.
 *
 * Prerequisites: npx wrangler whoami (to refresh OAuth token)
 * Usage: node scripts/backfill-game-dates.mjs [--dry-run]
 */

import { readFileSync } from 'fs';

const DRY_RUN = process.argv.includes('--dry-run');
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

const bad = await query(`
    SELECT g.id, g.tournament_slug, g.round, g.board, g.date, t.round_dates
    FROM games g JOIN tournaments t ON g.tournament_slug = t.slug
    WHERE g.date IS NOT NULL AND g.date NOT LIKE '____-__-__T%'
    ORDER BY g.tournament_slug, g.round, g.board
`);
console.log(`${bad.length} rows with non-canonical dates.`);

let fixed = 0, skipped = 0;
for (const row of bad) {
    const roundDates = JSON.parse(row.round_dates || '[]');
    const canonical = roundDates[row.round - 1];
    if (!canonical) {
        console.log(`  SKIP #${row.id} ${row.tournament_slug} r${row.round} b${row.board}: no round_dates[${row.round - 1}]`);
        skipped++;
        continue;
    }
    console.log(`  ${DRY_RUN ? 'would fix' : 'fix'} #${row.id} ${row.tournament_slug} r${row.round} b${row.board}: ${JSON.stringify(row.date)} -> ${canonical}`);
    if (!DRY_RUN) {
        await query('UPDATE games SET date = ? WHERE id = ?', [canonical, row.id]);
    }
    fixed++;
}
console.log(`\n${DRY_RUN ? 'Would fix' : 'Fixed'} ${fixed}, skipped ${skipped}.`);
