import { corsResponse, corsHeaders, isAllowedPushEndpoint, isAdminRequest } from './helpers.js';
import { sendPushNotification } from './webpush.js';

const KV_TTL = 7776000; // 90 days in seconds

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

async function putRecord(env, key, record) {
    await env.SUBSCRIBERS.put(key, JSON.stringify(record), { expirationTtl: KV_TTL });
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
        lastNotifiedPairings: existing?.lastNotifiedPairings || null,
        lastNotifiedResults: existing?.lastNotifiedResults || null,
        lastNotifiedGames: existing?.lastNotifiedGames || null,
        createdAt: existing?.createdAt || new Date().toISOString(),
        lastDeliveredAt: existing?.lastDeliveredAt || null,
        lastDisplayedAt: existing?.lastDisplayedAt || null,
        lastClickedAt: existing?.lastClickedAt || null,
        failCount: existing?.failCount || 0,
        retryAfter: existing?.retryAfter || null,
        retryPayload: existing?.retryPayload || null,
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

export async function handlePushAck(request, env) {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) return new Response('', { status: 204, headers: corsHeaders(env, request) });

    const key = deviceKey(deviceId);
    const record = await env.SUBSCRIBERS.get(key, 'json');
    if (record) {
        record.lastDisplayedAt = new Date().toISOString();
        await putRecord(env, key, record);
    }
    return new Response('', { status: 204, headers: corsHeaders(env, request) });
}

export async function handlePushClick(request, env) {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) return new Response('', { status: 204, headers: corsHeaders(env, request) });

    const key = deviceKey(deviceId);
    const record = await env.SUBSCRIBERS.get(key, 'json');
    if (record) {
        record.lastClickedAt = new Date().toISOString();
        await putRecord(env, key, record);
    }
    return new Response('', { status: 204, headers: corsHeaders(env, request) });
}

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

// Returns { count, retried } — retried is what tells the cron whether a
// later tick has any reason to scan for pending retries at all.
export async function dispatchPushNotifications({ subscribers, prefKey, marks, buildPayload, shouldNotify, env, label }) {
    let count = 0, skipped = 0, retried = 0;

    // Per-subscriber dedup: skip only when ALL marks are already-notified.
    // If any mark is missing, dispatch (the user is owed at least one signal).
    const isMarked = (record, m) => record[m.trackKey] === m.trackValue;

    for (const { key, record } of subscribers) {
        if (!record || record[prefKey] === false) continue;
        if (marks.every(m => isMarked(record, m))) continue;
        if (shouldNotify && !shouldNotify(record)) { skipped++; continue; }

        const payloadObj = await buildPayload(record);
        payloadObj.deviceId = record.deviceId || null;
        const payload = JSON.stringify(payloadObj);

        const result = await sendPushNotification(
            { endpoint: record.endpoint, keys: record.keys },
            payload,
            env
        );

        if (result.success) {
            for (const m of marks) record[m.trackKey] = m.trackValue;
            record.lastDeliveredAt = new Date().toISOString();
            record.failCount = 0;
            record.retryAfter = null;
            record.retryPayload = null;
            await putRecord(env, key, record);
            count++;
        } else if (result.gone) {
            console.log(`Push subscription gone, removing: ${key}`);
            await env.SUBSCRIBERS.delete(key);
        } else {
            record.failCount = (record.failCount || 0) + 1;
            if (record.failCount < 5) {
                record.retryAfter = new Date(Date.now() + 5 * 60 * 1000).toISOString();
                record.retryPayload = payload;
                retried++;
            }
            console.error(`Push ${label} failed for ${key} (attempt ${record.failCount}): ${result.error}`);
            await putRecord(env, key, record);
        }
    }

    if (skipped > 0) console.log(`Push ${label}: skipped ${skipped} subscriber(s) not in tournament`);
    if (retried > 0) console.log(`Push ${label}: ${retried} scheduled for retry`);
    return { count, retried };
}

// Returns { count, remaining } — remaining counts subscribers still holding a
// retry after this pass, so the caller knows whether to scan again next tick.
export async function retryPendingNotifications(env) {
    const subs = await listPushSubscriptions(env);
    const now = new Date();
    let count = 0, remaining = 0;

    for (const { key, record } of subs) {
        if (!record?.retryAfter || !record.retryPayload) continue;
        if (new Date(record.retryAfter) > now) { remaining++; continue; }

        try {
            const payload = JSON.parse(record.retryPayload);
            if (payload.expiresAt && new Date(payload.expiresAt) < now) {
                console.log(`Retry expired for ${key}, clearing`);
                record.retryAfter = null;
                record.retryPayload = null;
                await putRecord(env, key, record);
                continue;
            }
        } catch { /* payload parse failed, clear it */ }

        const result = await sendPushNotification(
            { endpoint: record.endpoint, keys: record.keys },
            record.retryPayload,
            env
        );

        if (result.success) {
            record.lastDeliveredAt = new Date().toISOString();
            record.failCount = 0;
            record.retryAfter = null;
            record.retryPayload = null;
            await putRecord(env, key, record);
            count++;
            console.log(`Retry succeeded for ${key}`);
        } else if (result.gone) {
            await env.SUBSCRIBERS.delete(key);
        } else {
            record.failCount = (record.failCount || 0) + 1;
            if (record.failCount >= 5) {
                console.log(`Push ${key} dormant after ${record.failCount} failures, stopping retries`);
                record.retryAfter = null;
                record.retryPayload = null;
            } else {
                record.retryAfter = new Date(Date.now() + 20 * 60 * 1000).toISOString();
                remaining++;
            }
            await putRecord(env, key, record);
        }
    }

    if (count > 0) console.log(`Retries: ${count} succeeded`);
    return { count, remaining };
}
