import { corsResponse, corsHeaders, isAllowedPushEndpoint, isAdminRequest } from './helpers.js';
import { sendPushNotification } from './webpush.js';
import { stampDelivery } from './ledger.js';

async function sha256Hex(input) {
    const encoded = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

function deviceKey(deviceId) {
    return `device:${deviceId}`;
}

// A client old enough to send no deviceId is keyed by a hash of its endpoint,
// under the same prefix — one prefix means one list operation per scan.
async function endpointKey(endpoint) {
    return deviceKey(await sha256Hex(endpoint));
}

// No expiry: a subscription the push service no longer knows is deleted when
// a send comes back gone. What was sent, shown and clicked lives in the
// ledger's delivery rows, so a record is written only when the device changes.
async function putRecord(env, key, record) {
    await env.SUBSCRIBERS.put(key, JSON.stringify(record));
}

export async function handlePushSubscribe(request, env) {
    const { subscription, playerName, deviceId, deviceLabel, oldEndpoint, notifyPairings, notifyResults } = await request.json();

    if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
        return corsResponse({ success: false, error: 'Invalid push subscription' }, 400, env, request);
    }
    // The worker POSTs to subscription.endpoint on every cron dispatch — it must
    // be a real push service, never an attacker-chosen URL.
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
        return corsResponse({ success: false, error: 'Unsupported push endpoint' }, 400, env, request);
    }

    const key = deviceId ? deviceKey(deviceId) : await endpointKey(subscription.endpoint);
    const existing = await env.SUBSCRIBERS.get(key, 'json');

    // An endpoint-keyed record is orphaned when the push service rotates the
    // endpoint. Guarded by a read: an unconditional delete spends a delete
    // operation every subscribe to remove a key that is almost never there.
    if (!deviceId && oldEndpoint && oldEndpoint !== subscription.endpoint) {
        const oldKey = await endpointKey(oldEndpoint);
        if (await env.SUBSCRIBERS.get(oldKey)) {
            console.log(`Cleaning up rotated push endpoint: ${oldKey}`);
            await env.SUBSCRIBERS.delete(oldKey);
        }
    }

    await putRecord(env, key, {
        playerName: (playerName || '').trim().slice(0, 80),
        deviceLabel: deviceLabel || existing?.deviceLabel || null,
        notifyPairings: notifyPairings !== undefined ? notifyPairings !== false : existing?.notifyPairings !== false,
        notifyResults: notifyResults !== undefined ? notifyResults !== false : existing?.notifyResults !== false,
        deviceId: deviceId || null,
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        createdAt: existing?.createdAt || new Date().toISOString(),
    });

    return corsResponse({ success: true }, 200, env, request);
}

export async function handlePushUnsubscribe(request, env) {
    const { endpoint, deviceId } = await request.json();

    if (!endpoint && !deviceId) {
        return corsResponse({ success: false, error: 'Endpoint or deviceId is required' }, 400, env, request);
    }

    await env.SUBSCRIBERS.delete(deviceId ? deviceKey(deviceId) : await endpointKey(endpoint));

    return corsResponse({ success: true }, 200, env, request);
}

export async function handlePushStatus(request, env) {
    const url = new URL(request.url);
    const endpoint = url.searchParams.get('endpoint');
    const deviceId = url.searchParams.get('deviceId');

    let record = null;
    if (deviceId) record = await env.SUBSCRIBERS.get(deviceKey(deviceId), 'json');
    if (!record && endpoint) record = await env.SUBSCRIBERS.get(await endpointKey(endpoint), 'json');

    if (!record) {
        return corsResponse({ subscribed: false }, 200, env, request);
    }

    return corsResponse({
        subscribed: true,
        playerName: record.playerName,
        notifyPairings: record.notifyPairings !== false,
        notifyResults: record.notifyResults !== false,
    }, 200, env, request);
}

export async function handlePushPreferences(request, env) {
    const { endpoint, deviceId, notifyPairings, notifyResults } = await request.json();

    if (!endpoint && !deviceId) {
        return corsResponse({ success: false, error: 'Endpoint or deviceId is required' }, 400, env, request);
    }

    let key = null, record = null;
    if (deviceId) {
        key = deviceKey(deviceId);
        record = await env.SUBSCRIBERS.get(key, 'json');
    }
    if (!record && endpoint) {
        key = await endpointKey(endpoint);
        record = await env.SUBSCRIBERS.get(key, 'json');
    }

    if (!record) {
        return corsResponse({ success: false, error: 'No push subscription found' }, 404, env, request);
    }

    record.notifyPairings = notifyPairings !== false;
    record.notifyResults = notifyResults !== false;
    await putRecord(env, key, record);

    return corsResponse({ success: true }, 200, env, request);
}

// The service worker reports a notification shown or clicked. The event key
// is absent from service workers older than the ledger.
async function stamp(request, env, column) {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get('deviceId');
    if (deviceId) await stampDelivery(env, column, deviceId, url.searchParams.get('event'), Date.now());
    return new Response('', { status: 204, headers: corsHeaders(env, request) });
}

export const handlePushAck = (request, env) => stamp(request, env, 'displayed_at');
export const handlePushClick = (request, env) => stamp(request, env, 'clicked_at');

export async function handlePushTest(request, env) {
    const { type, key: authKey } = await request.json();

    if (!isAdminRequest(request, env, authKey)) {
        return corsResponse({ error: 'Unauthorized' }, 403, env, request);
    }

    const pushSubs = await listPushSubscriptions(env);

    if (pushSubs.length === 0) {
        return corsResponse({ success: false, error: 'No push subscriptions found' }, 404, env, request);
    }

    const testPayloads = {
        pairings: {
            title: 'Round 5 Pairings Are Up!',
            body: 'TNM Round 5 pairings have been posted!',
            url: '/',
            type: 'pairings',
            round: 5,
        },
        'pairings-named': {
            title: 'Round 5 Pairings Are Up!',
            body: 'TNM Round 5: You have White vs Dahlia Quinn (1850) on Board 16.',
            url: '/',
            type: 'pairings',
            round: 5,
        },
        results: {
            title: 'Round 5 Results Are In!',
            body: 'TNM Round 5 results have been posted!',
            url: '/',
            type: 'results',
            round: 5,
        },
    };

    const payload = testPayloads[type] || testPayloads.pairings;
    const results = [];

    for (const { key, record } of pushSubs) {
        if (!record) continue;

        const fullPayload = { ...payload, deviceId: record.deviceId || null };
        const result = await sendPushNotification(
            { endpoint: record.endpoint, keys: record.keys },
            JSON.stringify(fullPayload),
            env
        );

        results.push({ key, deviceLabel: record.deviceLabel, success: result.success, status: result.status, error: result.error, gone: result.gone });

        if (result.gone) {
            console.log(`Test: push subscription gone, removing: ${key}`);
            await env.SUBSCRIBERS.delete(key);
        }
    }

    return corsResponse({ success: true, type: type || 'pairings', payload, results }, 200, env, request);
}

export async function listPushSubscriptions(env) {
    const subs = [];
    let cursor = undefined;

    do {
        const list = await env.SUBSCRIBERS.list({ prefix: 'device:', cursor });
        const records = await Promise.all(
            list.keys.map(k => env.SUBSCRIBERS.get(k.name, 'json').then(r => ({ key: k.name, record: r })))
        );
        subs.push(...records);
        cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);

    return subs;
}
