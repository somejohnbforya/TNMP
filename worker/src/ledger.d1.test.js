import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { d1 } from './d1.testkit.js';

// The push services are the one thing here we don't run: they're outside
// services. Everything else is production code on real SQLite with every
// real migration applied.
const sendPushNotification = vi.fn();
vi.mock('./webpush.js', () => ({ sendPushNotification: (...a) => sendPushNotification(...a) }));

const {
    observedEvents, newEvents, claimEvents, messageDeadline, deliver, retryDue, stampDelivery,
    LAST_ROUND_GAMES_WINDOW_MS,
} = await import('./ledger.js');
const { dispatchAllNotifications } = await import('./cron.js');

const WINTER = '2026-winter-tuesday-night-marathon';
const FALL = '2026-fall-tuesday-night-marathon';
const winterDates = ['2026-11-03T18:30:00-08:00', '2026-11-10T18:30:00-08:00', '2026-11-17T18:30:00-08:00'];
const at = (s) => new Date(s).getTime();

// Device records in KV: the dispatch lists them and deletes one a push service
// reports gone.
function devices(records) {
    const store = new Map(records.map(r => [`device:${r.deviceId}`, r]));
    return {
        store,
        async list() { return { keys: [...store.keys()].map(name => ({ name })), list_complete: true }; },
        async get(key) { return store.get(key) ?? null; },
        async delete(key) { store.delete(key); },
    };
}
const device = (deviceId, playerName = '') => ({
    deviceId, playerName, notifyPairings: true, notifyResults: true,
    endpoint: `https://fcm.googleapis.com/fcm/send/${deviceId}`, keys: { p256dh: 'p', auth: 'a' },
});

let board = 0;
function games(db, slug, round, { total, withPgn }) {
    db.prepare('INSERT OR IGNORE INTO tournaments (slug, name, round_dates) VALUES (?, ?, ?)').run(slug, slug, '[]');
    for (let i = 0; i < total; i++) {
        board++;
        db.prepare(`INSERT INTO games (tournament_slug, round, board, white, black, white_norm, black_norm, result, pgn)
                    VALUES (?, ?, ?, 'W', 'B', ?, ?, '1-0', ?)`)
            .run(slug, round, board, `w${board}`, `b${board}`, i < withPgn ? '1. e4 1-0' : null);
    }
}
const events = (db) => db.prepare('SELECT event_key, status, message_kind FROM notification_events ORDER BY event_key').all();
const keys = (list) => list.map(e => e.key);

// One posted round on MI's page, as parseTournamentPage returns it.
function page(round, { results = false } = {}) {
    const row = (board, white, black, wr, br) => ({
        board: String(board), whiteName: white, blackName: black,
        whiteResult: results ? wr : '', blackResult: results ? br : '',
    });
    return {
        roundNumber: round, hasPairings: true, hasResults: results,
        pairingsSections: [{
            round, section: '2000+',
            rows: [row(1, 'Alice Able (2100)', 'Bob Baker (2050)', '1', '0'), row(2, 'Carol Cole (2000)', 'Dan Drake (1990)', '½', '½')],
        }],
    };
}

beforeEach(() => {
    sendPushNotification.mockReset();
    sendPushNotification.mockResolvedValue({ success: true, status: 201 });
});
afterEach(() => vi.useRealTimers());

describe('seeding', () => {
    it('records every past event in every tournament, and games only for rounds that are ready', () => {
        const { db, migrateRest } = d1({ before: '0013' });
        games(db, FALL, 7, { total: 4, withPgn: 4 });
        games(db, WINTER, 3, { total: 4, withPgn: 0 });
        migrateRest();
        expect(events(db)).toEqual([
            { event_key: `${FALL}:games:7`, status: 'seeded', message_kind: null },
            { event_key: `${FALL}:pairings:7`, status: 'seeded', message_kind: null },
            { event_key: `${FALL}:results:7`, status: 'seeded', message_kind: null },
            { event_key: `${WINTER}:pairings:3`, status: 'seeded', message_kind: null },
            { event_key: `${WINTER}:results:3`, status: 'seeded', message_kind: null },
        ]);
    });
});

describe('newEvents', () => {
    // 2026-10-27: Fall's page had no pairings left and every round's games had
    // long been announced; the old dispatch re-announced round 1's.
    it('finds nothing new on a finished tournament whose page has no pairings', async () => {
        const { db, env, migrateRest } = d1({ before: '0013' });
        for (let r = 1; r <= 7; r++) games(db, FALL, r, { total: 2, withPgn: 2 });
        migrateRest();
        const seen = await observedEvents(env, FALL, { roundNumber: null, hasPairings: false, hasResults: false });
        expect(seen).toHaveLength(7);
        expect(await newEvents(env, seen)).toEqual([]);
    });

    it('finds round 4 pairings new when round 3 is recorded', async () => {
        const { db, env, migrateRest } = d1({ before: '0013' });
        games(db, WINTER, 3, { total: 2, withPgn: 0 });
        migrateRest();
        expect(keys(await newEvents(env, await observedEvents(env, WINTER, page(4))))).toEqual([`${WINTER}:pairings:4`]);
    });

    it('refuses pairings or results for a round below one already recorded', async () => {
        const { db, env, migrateRest } = d1({ before: '0013' });
        games(db, WINTER, 4, { total: 2, withPgn: 0 });
        migrateRest();
        db.prepare(`DELETE FROM notification_events WHERE event_key LIKE '%:3'`).run();
        expect(await newEvents(env, await observedEvents(env, WINTER, page(3, { results: true })))).toEqual([]);
    });

    it('finds games new for a ready round that was never announced, whatever round the page is on', async () => {
        const { db, env, migrateRest } = d1({ before: '0013' });
        games(db, WINTER, 2, { total: 4, withPgn: 1 });
        migrateRest();
        games(db, WINTER, 2, { total: 3, withPgn: 3 }); // late PGNs: 4 of 7 have moves
        expect(keys(await newEvents(env, await observedEvents(env, WINTER, page(3))))).toEqual(
            [`${WINTER}:pairings:3`, `${WINTER}:games:2`]);
    });
});

describe('claimEvents', () => {
    it('records an event once: a second claim gets nothing', async () => {
        const { env } = d1();
        const e = [{ key: `${WINTER}:pairings:4`, tournament: WINTER, signal: 'pairings', round: 4 }];
        expect(await claimEvents(env, e, { kind: 'pairings', status: 'sent', now: 0 })).toHaveLength(1);
        expect(await claimEvents(env, e, { kind: 'pairings', status: 'sent', now: 0 })).toEqual([]);
    });
});

describe('messageDeadline', () => {
    const now = at('2026-11-12T12:00:00Z');
    it('keeps pairings until their round starts', () => {
        expect(messageDeadline('pairings', 2, winterDates, now)).toBe(at(winterDates[1]));
    });
    it('keeps games until the next round starts', () => {
        expect(messageDeadline('games', 2, winterDates, now)).toBe(at(winterDates[2]));
    });
    it('keeps the last round\'s games for a week after it', () => {
        expect(messageDeadline('games', 3, winterDates, now)).toBe(at(winterDates[2]) + LAST_ROUND_GAMES_WINDOW_MS);
    });
});

describe('dispatchAllNotifications', () => {
    const tournament = { name: '2026 Winter TNM', slug: WINTER, roundDates: winterDates, totalRounds: 7 };

    // The Winter round 1 sequence: pairings and results first seen together on
    // Tuesday night, the PGNs on Friday.
    it('sends one recap, then one games message, and nothing twice', async () => {
        const { db, env } = d1();
        env.SUBSCRIBERS = devices([device('alice', 'Alice Able'), device('nobody'), device('zed', 'Zed Zane')]);

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(at('2026-11-04T07:05:00Z'));
        games(db, WINTER, 1, { total: 2, withPgn: 0 });
        await dispatchAllNotifications(page(1, { results: true }), tournament, env);
        await dispatchAllNotifications(page(1, { results: true }), tournament, env);
        // Zed isn't in the pairings; a device with no name gets the general message.
        expect(sendPushNotification).toHaveBeenCalledTimes(2);
        const recap = JSON.parse(sendPushNotification.mock.calls[0][1]);
        expect(recap).toMatchObject({ title: 'Round 1 is in the books!', eventKey: `${WINTER}:results:1`, type: 'recap' });

        vi.setSystemTime(at('2026-11-06T23:20:00Z'));
        db.prepare(`UPDATE games SET pgn = '1. e4 1-0' WHERE tournament_slug = ?`).run(WINTER);
        await dispatchAllNotifications(page(1, { results: true }), tournament, env);
        await dispatchAllNotifications(page(1, { results: true }), tournament, env);
        expect(sendPushNotification).toHaveBeenCalledTimes(5); // games go to everyone
        expect(JSON.parse(sendPushNotification.mock.calls[4][1]).title).toBe('Round 1 Games Are Up!');

        expect(events(db)).toEqual([
            { event_key: `${WINTER}:games:1`, status: 'sent', message_kind: 'games' },
            { event_key: `${WINTER}:pairings:1`, status: 'sent', message_kind: 'recap' },
            { event_key: `${WINTER}:results:1`, status: 'sent', message_kind: 'recap' },
        ]);
    });

    it('records pairings seen after their round started as stale, and sends nothing', async () => {
        const { db, env } = d1();
        env.SUBSCRIBERS = devices([device('alice', 'Alice Able')]);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(at('2026-11-10T20:00:00-08:00'));
        await dispatchAllNotifications(page(2), tournament, env);
        expect(sendPushNotification).not.toHaveBeenCalled();
        expect(events(db)).toEqual([{ event_key: `${WINTER}:pairings:2`, status: 'stale', message_kind: 'pairings' }]);
    });
});

describe('deliveries', () => {
    const lead = `${WINTER}:pairings:4`;
    const row = (db) => db.prepare('SELECT status, attempts, payload IS NOT NULL AS hasPayload, displayed_at, clicked_at FROM notification_deliveries').get();

    it('retries a failed send until it lands', async () => {
        const { db, env } = d1();
        env.SUBSCRIBERS = devices([device('alice')]);
        const now = at('2026-11-23T20:00:00-08:00');
        sendPushNotification.mockResolvedValueOnce({ success: false, status: 500, error: 'HTTP 500' });
        await deliver(env, lead, [{ key: 'device:alice', record: device('alice'), payload: { expiresAt: '2026-11-24T18:30:00-08:00' } }], now);
        expect(row(db)).toMatchObject({ status: 'pending', attempts: 1, hasPayload: 1 });

        expect(await retryDue(env, now + 60_000)).toBe(0); // not due yet
        expect(await retryDue(env, now + 5 * 60_000)).toBe(1);
        expect(row(db)).toMatchObject({ status: 'delivered', attempts: 2, hasPayload: 0 });
    });

    it('gives up after five attempts', async () => {
        const { db, env } = d1();
        env.SUBSCRIBERS = devices([device('alice')]);
        sendPushNotification.mockResolvedValue({ success: false, status: 500, error: 'HTTP 500' });
        let now = at('2026-11-23T20:00:00-08:00');
        await deliver(env, lead, [{ key: 'device:alice', record: device('alice'), payload: {} }], now);
        for (let i = 0; i < 6; i++) await retryDue(env, now += 20 * 60_000);
        expect(row(db)).toMatchObject({ status: 'failed', attempts: 5, hasPayload: 0 });
        expect(sendPushNotification).toHaveBeenCalledTimes(5);
    });

    it('stops retrying once the message has lapsed', async () => {
        const { db, env } = d1();
        env.SUBSCRIBERS = devices([device('alice')]);
        sendPushNotification.mockResolvedValueOnce({ success: false, status: 500, error: 'HTTP 500' });
        const now = at('2026-11-24T18:00:00-08:00');
        await deliver(env, lead, [{ key: 'device:alice', record: device('alice'), payload: { expiresAt: '2026-11-24T18:30:00-08:00' } }], now);
        await retryDue(env, now + 60 * 60_000);
        expect(row(db)).toMatchObject({ status: 'expired', attempts: 1 });
    });

    it('deletes a subscription the push service reports gone', async () => {
        const { db, env } = d1();
        env.SUBSCRIBERS = devices([device('alice')]);
        sendPushNotification.mockResolvedValueOnce({ success: false, gone: true, status: 410 });
        await deliver(env, lead, [{ key: 'device:alice', record: device('alice'), payload: {} }], 0);
        expect(row(db)).toMatchObject({ status: 'gone' });
        expect(env.SUBSCRIBERS.store.has('device:alice')).toBe(false);
    });

    it('stamps shown and clicked, with or without the event key', async () => {
        const { db, env } = d1();
        await deliver(env, `${WINTER}:pairings:3`, [{ key: 'device:alice', record: device('alice'), payload: {} }], 1000);
        await deliver(env, lead, [{ key: 'device:alice', record: device('alice'), payload: {} }], 2000);
        await stampDelivery(env, 'displayed_at', 'alice', null, 3000); // an old service worker: the latest delivery
        await stampDelivery(env, 'clicked_at', 'alice', lead, 4000);
        expect(db.prepare('SELECT event_key, displayed_at, clicked_at FROM notification_deliveries ORDER BY event_key').all()).toEqual([
            { event_key: `${WINTER}:pairings:3`, displayed_at: null, clicked_at: null },
            { event_key: lead, displayed_at: new Date(3000).toISOString(), clicked_at: new Date(4000).toISOString() },
        ]);
    });
});
