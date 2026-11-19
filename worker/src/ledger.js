// The notification ledger (docs/design-notification-ledger.md): one D1 row per
// event that has happened, and one per device a message went to. An event is
// new only if it has never been recorded, so nothing is ever announced twice,
// whatever the page or the round dates seem to say.

import { sendPushNotification } from './webpush.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// How long each message stays worth sending after its event is first seen,
// beyond which the event is recorded as stale and nothing goes out. Pairings
// last until their round starts and games until the next round starts (see
// messageDeadline); PGNs sometimes don't go up until the weekend.
export const RESULTS_WINDOW_MS = 12 * HOUR;
export const FINAL_WINDOW_MS = 2 * DAY;
export const LAST_ROUND_GAMES_WINDOW_MS = 7 * DAY;
const NO_DATES_WINDOW_MS = DAY;

// A failed send is retried this long after each attempt, up to MAX_ATTEMPTS.
const RETRY_DELAY_MS = [5 * 60 * 1000, 20 * 60 * 1000];
const MAX_ATTEMPTS = 5;

export const eventKey = (tournament, signal, round) => `${tournament}:${signal}:${round}`;

const iso = (ms) => new Date(ms).toISOString();
const placeholders = (n) => Array(n).fill('?').join(', ');

// The events this tick can see for one tournament: pairings and results for
// the round on its page (the parser takes it from the TNM sections only), and
// games for every round more than half of whose games have moves.
export async function observedEvents(env, tournament, parsed) {
    const events = [];
    const round = parsed?.roundNumber;
    if (round && parsed.hasPairings) events.push({ signal: 'pairings', round });
    if (round && parsed.hasResults) events.push({ signal: 'results', round });
    const { results } = await env.DB.prepare(
        `SELECT round FROM games WHERE tournament_slug = ? GROUP BY round
         HAVING SUM(CASE WHEN pgn IS NOT NULL AND pgn != '' THEN 1 ELSE 0 END) * 2 > COUNT(*)`
    ).bind(tournament).all();
    for (const r of results) events.push({ signal: 'games', round: r.round });
    return events.map(e => ({ ...e, tournament, key: eventKey(tournament, e.signal, e.round) }));
}

// The events never recorded before. Pairings and results only move forward,
// so one for a round below the highest already recorded can only come from a
// bad input: it's refused and logged. Games can arrive late or out of order.
export async function newEvents(env, events) {
    if (events.length === 0) return [];
    const { results } = await env.DB.prepare(
        `SELECT event_key, NULL AS signal, NULL AS round FROM notification_events
         WHERE event_key IN (${placeholders(events.length)})
         UNION ALL
         SELECT NULL, signal, MAX(round) FROM notification_events
         WHERE tournament = ? AND signal IN ('pairings', 'results') GROUP BY signal`
    ).bind(...events.map(e => e.key), events[0].tournament).all();
    const known = new Set(results.filter(r => r.event_key).map(r => r.event_key));
    const highest = new Map(results.filter(r => r.signal).map(r => [r.signal, r.round]));
    return events.filter(e => {
        if (known.has(e.key)) return false;
        if (e.signal !== 'games' && e.round < (highest.get(e.signal) ?? 0)) {
            console.warn(`Refusing ${e.key}: ${e.signal} already recorded for round ${highest.get(e.signal)}.`);
            return false;
        }
        return true;
    });
}

// Until when a message about `round` is worth sending. Round dates are the
// tournament's round start times.
export function messageDeadline(kind, round, roundDates, now) {
    const start = (r) => {
        const t = roundDates?.[r - 1] ? new Date(roundDates[r - 1]).getTime() : NaN;
        return Number.isNaN(t) ? null : t;
    };
    switch (kind) {
        case 'pairings': return start(round) ?? now + NO_DATES_WINDOW_MS;
        case 'results':
        case 'recap': return now + RESULTS_WINDOW_MS;
        case 'final': return now + FINAL_WINDOW_MS;
        case 'games': {
            const next = start(round + 1);
            if (next != null) return next;
            const own = start(round);
            return own != null && round === roundDates.length
                ? own + LAST_ROUND_GAMES_WINDOW_MS
                : now + LAST_ROUND_GAMES_WINDOW_MS;
        }
        default: throw new Error(`Unknown notification kind: ${kind}`);
    }
}

// Records the events one message covers. Returns those this call recorded: an
// event another run recorded first is not this run's to announce.
export async function claimEvents(env, events, { kind, status, now }) {
    const res = await env.DB.batch(events.map(e => env.DB.prepare(
        `INSERT INTO notification_events (event_key, tournament, signal, round, observed_at, status, message_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING`
    ).bind(e.key, e.tournament, e.signal, e.round, iso(now), status, kind)));
    return events.filter((_, i) => res[i].meta.changes === 1);
}

const deviceIdOf = (kvKey) => kvKey.slice('device:'.length);

// What a send's outcome writes to its delivery row.
function outcome(result, attempts, now) {
    if (result.success) return { status: 'delivered', delivered_at: iso(now), next_retry_at: null, error: null, keepPayload: false };
    if (result.gone) return { status: 'gone', delivered_at: null, next_retry_at: null, error: `HTTP ${result.status}`, keepPayload: false };
    if (attempts >= MAX_ATTEMPTS) return { status: 'failed', delivered_at: null, next_retry_at: null, error: result.error, keepPayload: false };
    const delay = RETRY_DELAY_MS[Math.min(attempts, RETRY_DELAY_MS.length) - 1];
    return { status: 'pending', delivered_at: null, next_retry_at: iso(now + delay), error: result.error, keepPayload: true };
}

// Sends one message to each target and records a delivery row per device.
// targets: [{ key, record, payload }] with payload a plain object. Returns how
// many the push services accepted.
export async function deliver(env, lead, targets, now) {
    const rows = [];
    let delivered = 0;
    for (const { key, record, payload } of targets) {
        const body = JSON.stringify({ ...payload, eventKey: lead, deviceId: record.deviceId || null });
        const result = await sendPushNotification({ endpoint: record.endpoint, keys: record.keys }, body, env);
        const o = outcome(result, 1, now);
        if (result.success) delivered++;
        if (result.gone) await env.SUBSCRIBERS.delete(key);
        if (o.status === 'pending' || o.status === 'failed') console.error(`Push ${lead} failed for ${key}: ${result.error}`);
        rows.push(env.DB.prepare(
            `INSERT INTO notification_deliveries (event_key, device_id, status, attempts, next_retry_at, delivered_at, error, payload)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT(event_key, device_id) DO NOTHING`
        ).bind(lead, deviceIdOf(key), o.status, o.next_retry_at, o.delivered_at, o.error, o.keepPayload ? body : null));
    }
    if (rows.length > 0) await env.DB.batch(rows);
    return delivered;
}

// Resends every delivery whose retry is due. One indexed read when none is.
export async function retryDue(env, now) {
    const { results } = await env.DB.prepare(
        `SELECT event_key, device_id, attempts, payload FROM notification_deliveries
         WHERE status = 'pending' AND next_retry_at <= ?`
    ).bind(iso(now)).all();
    if (results.length === 0) return 0;

    const updates = [];
    let delivered = 0;
    for (const row of results) {
        const key = `device:${row.device_id}`;
        const record = await env.SUBSCRIBERS.get(key, 'json');
        let expiresAt = null;
        try { expiresAt = JSON.parse(row.payload).expiresAt ?? null; } catch { /* unreadable: send it anyway */ }

        let o, attempts = row.attempts;
        if (!record) {
            o = { status: 'gone', delivered_at: null, next_retry_at: null, error: 'unsubscribed', keepPayload: false };
        } else if (expiresAt && new Date(expiresAt).getTime() <= now) {
            o = { status: 'expired', delivered_at: null, next_retry_at: null, error: null, keepPayload: false };
        } else {
            const result = await sendPushNotification({ endpoint: record.endpoint, keys: record.keys }, row.payload, env);
            o = outcome(result, ++attempts, now);
            if (result.success) delivered++;
            if (result.gone) await env.SUBSCRIBERS.delete(key);
        }
        updates.push(env.DB.prepare(
            `UPDATE notification_deliveries
             SET status = ?, attempts = ?, next_retry_at = ?, delivered_at = ?, error = ?,
                 payload = CASE WHEN ? THEN payload END
             WHERE event_key = ? AND device_id = ?`
        ).bind(o.status, attempts, o.next_retry_at, o.delivered_at, o.error,
            o.keepPayload ? 1 : 0, row.event_key, row.device_id));
    }
    await env.DB.batch(updates);
    console.log(`Retries: ${delivered} of ${results.length} delivered.`);
    return delivered;
}

// Stamps a delivery as shown or clicked. A service worker from before the
// ledger sends no event key; its device's latest delivery is the notification
// it just showed.
export async function stampDelivery(env, column, deviceId, event, now) {
    if (column !== 'displayed_at' && column !== 'clicked_at') throw new Error(`Not a stamp column: ${column}`);
    const stmt = event
        ? env.DB.prepare(`UPDATE notification_deliveries SET ${column} = ? WHERE device_id = ? AND event_key = ?`)
            .bind(iso(now), deviceId, event)
        : env.DB.prepare(
            `UPDATE notification_deliveries SET ${column} = ? WHERE rowid = (
                SELECT rowid FROM notification_deliveries WHERE device_id = ? AND delivered_at IS NOT NULL
                ORDER BY delivered_at DESC LIMIT 1)`
        ).bind(iso(now), deviceId);
    await stmt.run();
}

// The latest recorded events, for /health.
export async function latestEvents(env, limit = 6) {
    const { results } = await env.DB.prepare(
        `SELECT event_key, status, message_kind, audience, observed_at,
                (SELECT COUNT(*) FROM notification_deliveries d WHERE d.event_key = e.event_key AND d.status = 'delivered') AS delivered
         FROM notification_events e WHERE status != 'seeded' ORDER BY observed_at DESC LIMIT ?`
    ).bind(limit).all();
    return results;
}

export async function recordAudience(env, events, audience) {
    await env.DB.prepare(
        `UPDATE notification_events SET audience = ? WHERE event_key IN (${placeholders(events.length)})`
    ).bind(audience, ...events.map(e => e.key)).run();
}
