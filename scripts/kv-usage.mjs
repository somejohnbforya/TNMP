/**
 * Report Workers KV operations per UTC day, broken down by operation type.
 *
 * The free tier is FOUR separate daily caps, and the dashboard's headline
 * number is the one that never binds:
 *
 *   read 100,000/day   write 1,000/day   delete 1,000/day   list 1,000/day
 *
 * A "50% of the daily limit" warning from Cloudflare is almost always writes
 * or lists, never reads. This prints all four against their caps.
 *
 * Nothing but the retry sweep issues a list, and that is exactly two per cron
 * tick (one scan, one paginated continuation at most), so `lists` is also a
 * usable tick counter when you need to separate per-tick overhead from work
 * that actually happened.
 *
 * Run with: node scripts/kv-usage.mjs [days]
 * Requires: `npx wrangler whoami` to be authed (reads that OAuth token).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Visible in every dashboard URL; the namespace ids come from wrangler.toml.
const ACCOUNT = 'c84c98ab1610858ea513be97ec1623b7';
const LIMIT = { read: 100000, write: 1000, delete: 1000, list: 1000 };
const DAYS = Number(process.argv[2] || 14);

const cfgPath = path.join(os.homedir(), 'Library/Preferences/.wrangler/config/default.toml');
if (!fs.existsSync(cfgPath)) {
    console.error(`No wrangler credentials at ${cfgPath} — run \`npx wrangler login\`.`);
    process.exit(1);
}
const token = fs.readFileSync(cfgPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];
if (!token) {
    console.error('No oauth_token in the wrangler config — run `npx wrangler login`.');
    process.exit(1);
}

// Name the namespaces from wrangler.toml so this cannot drift from the worker.
const toml = fs.readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');
const NS = Object.fromEntries(
    [...toml.matchAll(/binding\s*=\s*"(\w+)"\s*\nid\s*=\s*"([0-9a-f]+)"/g)].map(m => [m[2], m[1]]),
);

const end = new Date();
const start = new Date(end.getTime() - DAYS * 864e5);
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');

const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
        query: `query KV($account: String!, $start: Time!, $end: Time!) {
            viewer { accounts(filter: { accountTag: $account }) {
                kvOperationsAdaptiveGroups(
                    filter: { datetime_geq: $start, datetime_lt: $end }
                    limit: 10000
                    orderBy: [datetimeHour_ASC]
                ) {
                    sum { requests }
                    dimensions { actionType namespaceId datetimeHour }
                }
            } }
        }`,
        variables: { account: ACCOUNT, start: iso(start), end: iso(end) },
    }),
});

const json = await res.json();
if (json.errors) {
    console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
    process.exit(1);
}

const rows = json.data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups ?? [];
if (!rows.length) {
    console.log('No KV operations in the window.');
    process.exit(0);
}

const sum = (keyOf) => {
    const m = new Map();
    for (const r of rows) {
        const k = keyOf(r);
        if (k !== null) m.set(k, (m.get(k) ?? 0) + r.sum.requests);
    }
    return m;
};

const byDay = sum(r => `${r.dimensions.datetimeHour.slice(0, 10)}|${r.dimensions.actionType}`);
const days = [...new Set([...byDay.keys()].map(k => k.split('|')[0]))].sort();
const types = ['read', 'write', 'delete', 'list'].filter(t => rows.some(r => r.dimensions.actionType === t));

console.log(`KV operations per UTC day (free-tier daily cap in the header)\n`);
console.log(['day'.padEnd(12), ...types.map(t => `${t}/${LIMIT[t]}`.padStart(17))].join(''));
for (const d of days) {
    const cells = types.map(t => {
        const n = byDay.get(`${d}|${t}`) ?? 0;
        return `${n} (${Math.round((100 * n) / LIMIT[t])}%)`.padStart(17);
    });
    console.log([d.padEnd(12), ...cells].join(''));
}

const today = days[days.length - 1];
const byNs = sum(r => (r.dimensions.datetimeHour.startsWith(today)
    ? `${NS[r.dimensions.namespaceId] ?? r.dimensions.namespaceId}|${r.dimensions.actionType}`
    : null));
console.log(`\n${today} by namespace`);
for (const [k, v] of [...byNs.entries()].sort()) console.log(`  ${k.replace('|', '  ')}: ${v}`);
