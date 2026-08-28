export const TOURNAMENTS_LIST_URL = 'https://www.milibrary.org/chess/tournaments/';
export const MI_BASE_URL = 'https://www.milibrary.org';

export function corsHeaders(env, request) {
    const requestOrigin = request?.headers?.get('Origin') || '';

    // Allow any origin for embed support (restrict to specific domains later)
    return {
        'Access-Control-Allow-Origin': requestOrigin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

export function corsResponse(data, status, env, request, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(env, request),
            ...extraHeaders,
        },
    });
}

export function titleCaseName(name) {
    return name.replace(/\w\S*/g, w =>
        w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    );
}

export function normalizePlayerName(name) {
    const t = name.trim();
    const parts = t.split(/,\s*/);
    if (parts.length >= 2) return t.toLowerCase().replace(/\s+/g, '');
    const words = t.split(/\s+/);
    if (words.length >= 2) {
        const last = words[words.length - 1];
        const first = words.slice(0, -1).join(' ');
        return `${last},${first}`.toLowerCase().replace(/\s+/g, '');
    }
    return t.toLowerCase();
}

export function formatPlayerName(name) {
    const parts = name.split(/,\s*/);
    if (parts.length >= 2) return `${parts[1]} ${parts[0]}`;
    return name;
}

// --- Rating floor ---
// US Chess publishes a member's rating floor with their account data.
// The member payload isn't documented, so extraction scans for any
// floor-named field, preferring one attached to the Regular rating.
// Peak-based floors run 1200-2100; the Original Life Master floor is
// 2200, so that's the ceiling for a credible value.

function validFloor(value) {
    const n = typeof value === 'string' ? parseInt(value, 10) : value;
    return Number.isInteger(n) && n >= 1200 && n <= 2200 ? n : null;
}

function deepFindFloor(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 3) return null;
    for (const [key, value] of Object.entries(obj)) {
        if (/floor/i.test(key)) {
            const n = validFloor(value && typeof value === 'object' ? (value.rating ?? value.value) : value);
            if (n != null) return n;
        }
    }
    for (const value of Object.values(obj)) {
        const n = deepFindFloor(value, depth + 1);
        if (n != null) return n;
    }
    return null;
}

export function extractRatingFloor(memberData) {
    const regular = memberData?.ratings?.find?.(r => r.ratingSystem === 'R');
    return deepFindFloor(regular) ?? deepFindFloor(memberData);
}

// The peak-based rule: highest attained rating minus 200, at the
// floor value just below. Peaks under 1400 produce no floor.
export function floorFromPeak(peak) {
    if (!Number.isFinite(peak) || peak < 1400) return null;
    return Math.min(2100, Math.floor((peak - 200) / 100) * 100);
}

// Normalize section names to canonical forms:
// - Fix truncated rating ranges ("1600-199" → "1600-1999")
// - "u" → "U" prefix
// - U2000 → 1600-1999 (same rating band, name changed over time)
// - Extra Game/Extra Games/Extra Rated Games → Extra Rated
export function normalizeSection(section) {
    if (!section) return section;
    let s = section.trim().replace(/^u(?=\d)/i, 'U');
    s = s.replace(/^(\d{4})-(\d{1,3})$/, (_, lo, hi) => {
        const loThousands = Math.floor(parseInt(lo) / 1000);
        const candidate = loThousands * 1000 + 999;
        return candidate > parseInt(lo) ? `${lo}-${candidate}` : `${lo}-${hi}`;
    });
    if (s === 'U2000') s = '1600-1999';
    if (/^extra/i.test(s)) s = 'Extra Rated';
    return s;
}

// US Pacific UTC offset: DST (2nd Sun Mar → 1st Sun Nov) = -07:00, else -08:00
export function pacificOffset(year, month, day) {
    if (month >= 4 && month <= 10) return '-07:00';
    if (month <= 2 || month === 12) return '-08:00';
    if (month === 3) {
        const marchFirstDay = new Date(Date.UTC(year, 2, 1)).getUTCDay();
        const secondSunday = 1 + (7 - marchFirstDay) % 7 + 7;
        return day >= secondSunday ? '-07:00' : '-08:00';
    }
    // November
    const novFirstDay = new Date(Date.UTC(year, 10, 1)).getUTCDay();
    const firstSunday = 1 + (7 - novFirstDay) % 7;
    return day >= firstSunday ? '-08:00' : '-07:00';
}

const pad2 = n => String(n).padStart(2, '0');

export function pacificDatetime(year, month, day, time = '00:00:00') {
    return `${year}-${pad2(month)}-${pad2(day)}T${time}${pacificOffset(year, month, day)}`;
}

// Single source for "now" in US Pacific terms. The toLocaleString round-trip
// yields a Date whose get*() fields read as Pacific wall-clock; `ms` stays the
// true UTC instant and `dateStr` is the Pacific calendar date (en-CA → ISO).
// Both the worker's time-state logic and the cron scheduler read from here, so
// there's one audited place where "what time is it in SF" is computed.
export function pacificNow() {
    const now = new Date();
    const wall = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const hour = wall.getHours();
    const minute = wall.getMinutes();
    return {
        day: wall.getDay(),
        hour,
        minute,
        minutes: hour * 60 + minute,
        dateStr: now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
        ms: now.getTime(),
    };
}

export function slugifyTournament(name) {
    return name
        .toLowerCase()
        .replace(/['']/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export async function resolveCurrentSlug(env, request) {
    const today = new Date().toISOString().split('T')[0];
    const row = await env.DB.prepare(
        `SELECT slug FROM tournaments WHERE json_extract(round_dates, '$[0]') <= ?
         ORDER BY json_extract(round_dates, '$[0]') DESC LIMIT 1`
    ).bind(today).first();
    if (!row) return corsResponse({ error: 'Tournament not resolved' }, 503, env, request);
    return { slug: row.slug };
}

export function validateGameId(url, env, request) {
    const gameId = url.searchParams.get('id');
    if (!gameId || !/^\d{10,20}$/.test(gameId)) {
        return { gameId: null, error: corsResponse({ error: 'Valid game ID is required' }, 400, env, request) };
    }
    return { gameId, error: null };
}


// --- Security helpers (added 2026-08-25, security-hardening pass) ---

// Web Push endpoints must belong to a real push service. Without this check,
// /push-subscribe would let anyone register an arbitrary URL that the worker
// then POSTs to on every cron dispatch — outbound-request abuse, and a lever to
// flood the subscriber set (bogus tokens at a real host 410 and self-clean).
const PUSH_HOSTS_EXACT = new Set([
    'fcm.googleapis.com',
    'android.googleapis.com',
    'web.push.apple.com',
    'updates.push.services.mozilla.com',
]);
const PUSH_HOST_SUFFIXES = [
    '.push.services.mozilla.com', // Mozilla autopush shards
    '.notify.windows.com',        // WNS (Edge / Windows)
    '.push.apple.com',            // Apple web-push shards
];

export function isAllowedPushEndpoint(endpoint) {
    let url;
    try { url = new URL(endpoint); } catch { return false; }
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (PUSH_HOSTS_EXACT.has(host)) return true;
    return PUSH_HOST_SUFFIXES.some(s => host.endsWith(s) && host.length > s.length);
}

// Constant-time string compare — avoids leaking a secret prefix match via
// early-return timing. Length mismatch returns fast (length is not the secret).
export function timingSafeEqualStr(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const enc = new TextEncoder();
    const ab = enc.encode(a);
    const bb = enc.encode(b);
    if (ab.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
    return diff === 0;
}

// The admin secret gates manual/privileged endpoints. Prefer a dedicated
// ADMIN_TOKEN so it can rotate independently of the VAPID signing key; fall
// back to VAPID_PRIVATE_KEY so existing deployments keep working until an
// ADMIN_TOKEN is provisioned.
export function adminSecret(env) {
    return env.ADMIN_TOKEN || env.VAPID_PRIVATE_KEY || null;
}

// Authorize a privileged request. The token may arrive as
// `Authorization: Bearer <token>` or (for JSON POSTs that already carry it) as
// an explicit body value passed in `presentedToken`.
export function isAdminRequest(request, env, presentedToken = null) {
    const secret = adminSecret(env);
    if (!secret) return false;
    let token = presentedToken;
    if (!token) {
        const auth = request.headers.get('Authorization') || '';
        const m = auth.match(/^Bearer\s+(.+)$/);
        token = m ? m[1] : null;
    }
    if (!token) return false;
    return timingSafeEqualStr(token, secret);
}
