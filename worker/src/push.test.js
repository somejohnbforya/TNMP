import { describe, it, expect } from 'vitest';
import { listPushSubscriptions, handlePushSubscribe } from './push.js';

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

