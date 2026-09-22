import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendPushNotification = vi.fn();
vi.mock('./webpush.js', () => ({ sendPushNotification: (...a) => sendPushNotification(...a) }));

const {
    listPushSubscriptions, dispatchPushNotifications, retryPendingNotifications, handlePushSubscribe,
} = await import('./push.js');

const ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/abc';
const KEYS = { p256dh: 'p', auth: 'a' };

function fakeKV(initial = {}, { pageSize = Infinity } = {}) {
    const store = new Map(Object.entries(initial));
    const ops = { get: 0, put: 0, delete: 0, list: 0 };
    return {
        ops,
        keys: () => [...store.keys()],
        read: (k) => JSON.parse(store.get(k)),
        async get(key, type) {
            ops.get++;
            const v = store.get(key);
            if (v === undefined) return null;
            return type === 'json' ? JSON.parse(v) : v;
        },
        async put(key, value) { ops.put++; store.set(key, value); },
        async delete(key) { ops.delete++; store.delete(key); },
        async list({ prefix = '', cursor } = {}) {
            ops.list++;
            const all = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
            const start = cursor ? all.indexOf(cursor) : 0;
            const page = all.slice(start, start + pageSize);
            const next = all[start + pageSize];
            return { keys: page.map(name => ({ name })), list_complete: !next, cursor: next ?? null };
        },
    };
}

const sub = (id, extra = {}) => [`device:${id}`, JSON.stringify({ deviceId: id, endpoint: ENDPOINT, keys: KEYS, ...extra })];

describe('listPushSubscriptions', () => {
    // The legacy `push:` prefix is gone, so a scan is one list operation. On a
    // pairings night the cron ticks ~400 times; a second prefix was ~400 list
    // operations a night against a 1,000/day cap, scanning nothing.
    it('scans a single prefix', async () => {
        const SUBSCRIBERS = fakeKV(Object.fromEntries([sub('a'), sub('b'), sub('c')]));
        const subs = await listPushSubscriptions({ SUBSCRIBERS });
        expect(SUBSCRIBERS.ops.list).toBe(1);
        expect(subs).toHaveLength(3);
    });

    it('still pages through a cursor', async () => {
        const SUBSCRIBERS = fakeKV(Object.fromEntries([sub('a'), sub('b'), sub('c')]), { pageSize: 2 });
        expect(await listPushSubscriptions({ SUBSCRIBERS })).toHaveLength(3);
        expect(SUBSCRIBERS.ops.list).toBe(2);
    });

    it('ignores keys outside the prefix', async () => {
        const SUBSCRIBERS = fakeKV({ ...Object.fromEntries([sub('a')]), 'cache:appState': '{}', 'state:lastCheck': '{}' });
        expect(await listPushSubscriptions({ SUBSCRIBERS })).toHaveLength(1);
    });
});

describe('handlePushSubscribe', () => {
    const post = (body) => new Request('https://api/push-subscribe', {
        method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
    });

    // Every subscribe used to fire one or two deletes at legacy keys that the
    // migration had already removed, inside a try/catch that hid it.
    it('spends no delete operations on a normal subscribe', async () => {
        const SUBSCRIBERS = fakeKV();
        const res = await handlePushSubscribe(post({
            subscription: { endpoint: ENDPOINT, keys: KEYS }, deviceId: 'dev-1', playerName: 'A',
        }), { SUBSCRIBERS });
        expect(res.status).toBe(200);
        expect(SUBSCRIBERS.ops.delete).toBe(0);
        expect(SUBSCRIBERS.keys()).toEqual(['device:dev-1']);
    });

    it('spends no delete operations when the endpoint rotated', async () => {
        const SUBSCRIBERS = fakeKV();
        await handlePushSubscribe(post({
            subscription: { endpoint: ENDPOINT, keys: KEYS }, deviceId: 'dev-1',
            oldEndpoint: 'https://updates.push.services.mozilla.com/wpush/v2/old',
        }), { SUBSCRIBERS });
        expect(SUBSCRIBERS.ops.delete).toBe(0);
    });

    // A browser on cached pre-deviceId JS still works, under the same prefix,
    // so there is never a second prefix to scan.
    it('keys a deviceId-less client under the device prefix', async () => {
        const SUBSCRIBERS = fakeKV();
        await handlePushSubscribe(post({ subscription: { endpoint: ENDPOINT, keys: KEYS } }), { SUBSCRIBERS });
        const keys = SUBSCRIBERS.keys();
        expect(keys).toHaveLength(1);
        expect(keys[0].startsWith('device:')).toBe(true);
        expect(keys.some(k => k.startsWith('push:'))).toBe(false);
    });
});

describe('dispatchPushNotifications', () => {
    const marks = [{ trackKey: 'lastNotifiedPairings', trackValue: 'fall:p:4' }];
    const base = (SUBSCRIBERS, subscribers) => ({
        subscribers, prefKey: 'notifyPairings', marks,
        buildPayload: () => ({ title: 't', body: 'b' }),
        env: { SUBSCRIBERS }, label: 'pairings',
    });

    beforeEach(() => sendPushNotification.mockReset());

    it('reports what it delivered and what it queued', async () => {
        sendPushNotification.mockResolvedValue({ success: true });
        const SUBSCRIBERS = fakeKV();
        const out = await dispatchPushNotifications(base(SUBSCRIBERS, [
            { key: 'device:a', record: { endpoint: ENDPOINT, keys: KEYS } },
        ]));
        expect(out).toEqual({ count: 1, retried: 0 });
    });

    // retried is what arms the cron's retry sweep; if it were wrong the sweep
    // would either never run or run every tick.
    it('reports a queued retry when delivery fails', async () => {
        sendPushNotification.mockResolvedValue({ success: false, error: 'boom' });
        const SUBSCRIBERS = fakeKV();
        const out = await dispatchPushNotifications(base(SUBSCRIBERS, [
            { key: 'device:a', record: { endpoint: ENDPOINT, keys: KEYS } },
        ]));
        expect(out).toEqual({ count: 0, retried: 1 });
    });

    it('marks a delivered subscriber so the next tick skips it', async () => {
        sendPushNotification.mockResolvedValue({ success: true });
        const SUBSCRIBERS = fakeKV();
        await dispatchPushNotifications(base(SUBSCRIBERS, [
            { key: 'device:a', record: { endpoint: ENDPOINT, keys: KEYS } },
        ]));
        expect(SUBSCRIBERS.read('device:a').lastNotifiedPairings).toBe('fall:p:4');
    });

    it('sends nothing to an already-marked subscriber, and writes nothing', async () => {
        sendPushNotification.mockResolvedValue({ success: true });
        const SUBSCRIBERS = fakeKV();
        const out = await dispatchPushNotifications(base(SUBSCRIBERS, [
            { key: 'device:a', record: { endpoint: ENDPOINT, keys: KEYS, lastNotifiedPairings: 'fall:p:4' } },
        ]));
        expect(sendPushNotification).not.toHaveBeenCalled();
        expect(out.count).toBe(0);
        expect(SUBSCRIBERS.ops.put).toBe(0);
    });

    it('drops a subscription the push service reports gone', async () => {
        sendPushNotification.mockResolvedValue({ success: false, gone: true });
        const SUBSCRIBERS = fakeKV(Object.fromEntries([sub('a')]));
        await dispatchPushNotifications(base(SUBSCRIBERS, [
            { key: 'device:a', record: { endpoint: ENDPOINT, keys: KEYS } },
        ]));
        expect(SUBSCRIBERS.keys()).toEqual([]);
    });
});

describe('retryPendingNotifications', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const payload = JSON.stringify({ title: 't', body: 'b' });

    beforeEach(() => sendPushNotification.mockReset());

    it('reports nothing remaining when there is nothing to retry', async () => {
        const SUBSCRIBERS = fakeKV(Object.fromEntries([sub('a')]));
        expect(await retryPendingNotifications({ SUBSCRIBERS })).toEqual({ count: 0, remaining: 0 });
    });

    // A retry inside its backoff window is still outstanding — reporting it as
    // remaining is what keeps the sweep armed until it actually fires.
    it('counts a retry that is not due yet as remaining', async () => {
        const SUBSCRIBERS = fakeKV(Object.fromEntries([sub('a', { retryAfter: future, retryPayload: payload })]));
        expect(await retryPendingNotifications({ SUBSCRIBERS })).toEqual({ count: 0, remaining: 1 });
        expect(sendPushNotification).not.toHaveBeenCalled();
    });

    it('clears a retry that succeeds', async () => {
        sendPushNotification.mockResolvedValue({ success: true });
        const SUBSCRIBERS = fakeKV(Object.fromEntries([sub('a', { retryAfter: past, retryPayload: payload })]));
        expect(await retryPendingNotifications({ SUBSCRIBERS })).toEqual({ count: 1, remaining: 0 });
        expect(SUBSCRIBERS.read('device:a').retryAfter).toBeNull();
    });

    it('keeps a retry outstanding when it fails again', async () => {
        sendPushNotification.mockResolvedValue({ success: false, error: 'boom' });
        const SUBSCRIBERS = fakeKV(Object.fromEntries([sub('a', { retryAfter: past, retryPayload: payload })]));
        expect(await retryPendingNotifications({ SUBSCRIBERS })).toEqual({ count: 0, remaining: 1 });
    });

    it('stops counting a subscriber that has gone dormant', async () => {
        sendPushNotification.mockResolvedValue({ success: false, error: 'boom' });
        const SUBSCRIBERS = fakeKV(Object.fromEntries([
            sub('a', { retryAfter: past, retryPayload: payload, failCount: 4 }),
        ]));
        expect(await retryPendingNotifications({ SUBSCRIBERS })).toEqual({ count: 0, remaining: 0 });
        expect(SUBSCRIBERS.read('device:a').retryAfter).toBeNull();
    });
});
