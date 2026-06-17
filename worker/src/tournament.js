import { corsResponse, slugifyTournament, pacificDatetime, pacificNow, TOURNAMENTS_LIST_URL, MI_BASE_URL } from './helpers.js';
import { hasPairings, hasResults, parseRoundDates, extractTournamentName, parseTournamentList, parseStandings } from './parser.js';

// Falls back to MI listing page discovery during ~7-day gaps between tournaments
export async function resolveTournament(env) {
    const today = new Date().toISOString().split('T')[0];

    const [current, next] = await Promise.all([
        env.DB.prepare(
            `SELECT * FROM tournaments WHERE json_extract(round_dates, '$[0]') <= ?
             ORDER BY json_extract(round_dates, '$[0]') DESC LIMIT 1`
        ).bind(today).first(),
        env.DB.prepare(
            `SELECT * FROM tournaments WHERE json_extract(round_dates, '$[0]') > ?
             ORDER BY json_extract(round_dates, '$[0]') ASC LIMIT 1`
        ).bind(today).first(),
    ]);

    if (current) {
        let roundDates;
        try { roundDates = JSON.parse(current.round_dates || '[]'); } catch { roundDates = []; }
        let url = current.url;

        if (!url) {
            url = await discoverTournamentUrl(env, current.name);
            if (url) {
                await env.DB.prepare('UPDATE tournaments SET url = ? WHERE slug = ?')
                    .bind(url, current.slug).run();
            }
        }

        let nextStartDate = null;
        let nextRoundDates = [];
        if (next) {
            try {
                nextRoundDates = JSON.parse(next.round_dates || '[]');
                const r1 = nextRoundDates[0];
                nextStartDate = r1 ? r1.slice(0, 10) : null;
            } catch { /* corrupted */ }
        }

        return {
            name: current.name, slug: current.slug, url, roundDates,
            totalRounds: roundDates.length,
            nextTournament: next ? {
                name: next.name, slug: next.slug, url: next.url,
                startDate: nextStartDate, roundDates: nextRoundDates,
            } : null,
        };
    }

    return await discoverTournament(env, today);
}

async function discoverTournamentUrl(env, tournamentName) {
    try {
        const res = await fetch(TOURNAMENTS_LIST_URL, { headers: { 'User-Agent': 'TNMP-Notification-Worker/1.0' } });
        if (!res.ok) return null;
        const listHtml = await res.text();
        const tournaments = parseTournamentList(listHtml);
        const slug = slugifyTournament(tournamentName);
        const match = tournaments.find(t => slugifyTournament(t.name) === slug);
        if (match) {
            console.log(`Discovered URL for ${tournamentName}: ${MI_BASE_URL + match.url}`);
            return MI_BASE_URL + match.url;
        }
    } catch (err) {
        console.error('Failed to discover tournament URL:', err.message);
    }
    return null;
}

export async function discoverUpcomingTournaments(env) {
    const UA = { 'User-Agent': 'TNMP-Notification-Worker/1.0' };

    let listHtml;
    try {
        const res = await fetch(TOURNAMENTS_LIST_URL, { headers: UA });
        if (!res.ok) return 0;
        listHtml = await res.text();
    } catch { return 0; }

    const listed = parseTournamentList(listHtml);
    if (listed.length === 0) return 0;

    const knownSlugs = new Set();
    try {
        const rows = await env.DB.prepare('SELECT slug FROM tournaments').all();
        for (const r of rows.results) knownSlugs.add(r.slug);
    } catch { /* tournaments table missing — surface via caller */ }

    const today = new Date().toISOString().split('T')[0];
    let added = 0;

    for (const t of listed) {
        if (knownSlugs.has(slugifyTournament(t.name))) continue;

        let pageHtml;
        try {
            const res = await fetch(MI_BASE_URL + t.url, { headers: UA });
            if (!res.ok) continue;
            pageHtml = await res.text();
        } catch { continue; }

        const name = extractTournamentName(pageHtml) || t.name;
        const slug = slugifyTournament(name);
        if (knownSlugs.has(slug)) continue;

        const yearMatch = name.match(/\b(20\d{2})\b/);
        const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
        const roundDates = parseRoundDates(pageHtml, year);
        if (roundDates.length === 0) continue;
        if (roundDates[roundDates.length - 1].slice(0, 10) < today) continue;

        await env.DB.prepare(
            `INSERT INTO tournaments (slug, name, round_dates, url)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(slug) DO UPDATE SET name=excluded.name,
             round_dates=excluded.round_dates, url=excluded.url`
        ).bind(slug, name, JSON.stringify(roundDates), MI_BASE_URL + t.url).run();

        knownSlugs.add(slug);
        added++;
        console.log(`Discovered upcoming tournament: ${name} (${roundDates.length} rounds, R1 ${roundDates[0]})`);
    }

    return added;
}

async function discoverTournament(env, today) {
    const UA = { 'User-Agent': 'TNMP-Notification-Worker/1.0' };

    let listHtml;
    try {
        const res = await fetch(TOURNAMENTS_LIST_URL, { headers: UA });
        if (!res.ok) { console.error(`Failed to fetch tournaments list: HTTP ${res.status}`); return null; }
        listHtml = await res.text();
    } catch (err) {
        console.error('Failed to fetch tournaments list:', err.message);
        return null;
    }

    const tournaments = parseTournamentList(listHtml);
    if (tournaments.length === 0) { console.error('No TNM tournaments found on listing page'); return null; }

    const year = new Date().getFullYear();

    for (const t of tournaments) {
        const tournamentUrl = MI_BASE_URL + t.url;
        let pageHtml;
        try {
            const res = await fetch(tournamentUrl, { headers: UA });
            if (!res.ok) continue;
            pageHtml = await res.text();
        } catch { continue; }

        const roundDates = parseRoundDates(pageHtml, year);
        const name = extractTournamentName(pageHtml) || t.name;
        if (roundDates.length === 0) continue;

        const slug = slugifyTournament(name);
        const roundDatesJson = JSON.stringify(roundDates);
        await env.DB.prepare(
            `INSERT INTO tournaments (slug, name, round_dates, url)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(slug) DO UPDATE SET name=excluded.name,
             round_dates=excluded.round_dates, url=excluded.url`
        ).bind(slug, name, roundDatesJson, tournamentUrl).run();

        console.log(`Discovered tournament: ${name} (${roundDates.length} rounds), wrote to D1`);

        return {
            name, slug, url: tournamentUrl, roundDates,
            totalRounds: roundDates.length, nextTournament: null,
        };
    }

    console.log('No current or upcoming TNM tournament found');
    return null;
}

export function getTimeState(roundDates, nextTournament) {
    const { day, minutes: timeInMinutes, dateStr: today, ms: nowMs } = pacificNow();

    if (roundDates?.length > 0) {
        const rounds = roundDates.map(d => { const dt = new Date(d); return isNaN(dt) ? null : dt; }).filter(Boolean);

        if (rounds.length > 0) {
            const r1Date = rounds[0];
            const [ry, rm, rd] = roundDates[0].slice(0, 10).split('-').map(Number);
            const r1DayStart = new Date(pacificDatetime(ry, rm, rd));

            if (nextTournament?.startDate) {
                const [ny, nm, nd] = nextTournament.startDate.split('-').map(Number);
                const nextR1 = new Date(pacificDatetime(ny, nm, nd, '18:30:00'));
                const sevenBefore = new Date(nextR1.getTime() - 7 * 24 * 60 * 60 * 1000);
                if (nowMs >= sevenBefore.getTime() && nowMs < nextR1.getTime()) return 'off_season';
            }
            if (nowMs < r1DayStart.getTime()) return 'off_season';
            if (nowMs < r1Date.getTime()) return 'off_season_r1';

            const lastRound = rounds[rounds.length - 1];
            if (nowMs >= lastRound.getTime()) {
                const lastRoundDay = roundDates[roundDates.length - 1].slice(0, 10);
                if (lastRoundDay === today && timeInMinutes >= 1110) return 'round_in_progress';
                return 'results_window';
            }
        }
    }

    if (day === 1 && timeInMinutes >= 1200) return 'check_pairings'; // Mon 8PM+
    if (day === 2 && timeInMinutes < 1110) return 'check_pairings';  // Tue before 6:30PM
    if (day === 2 && timeInMinutes >= 1110) return 'round_in_progress';
    if (day === 1 && timeInMinutes < 1200) return 'too_early';
    return 'results_window';
}

// Pick the single tournament the response describes, together with its time
// phase. We stay on `current` through its entire arc — pre-R1, in-progress, and
// the post-final results window (where it reads as "complete, final standings")
// — and switch to `next` only once we're inside next's 7-day countdown window.
// getTimeState returns plain 'off_season' for `current` ONLY in that window
// (current's own R1 is always in the past; its R1-day case is the distinct
// 'off_season_r1'), so that signal doubles as the switch trigger.
//
// Returning the phase alongside the subject is the whole point: state, round,
// and identity then all derive from ONE tournament and can never describe two
// at once — the bug where a current-phase verb ("in progress") wore next's
// round + name ("Round 1", next tournament).
function chooseSubject(meta) {
    const next = meta?.nextTournament || null;
    const currentRoundDates = meta?.roundDates || [];
    const phase = getTimeState(currentRoundDates, next);

    if (phase === 'off_season' && next?.roundDates?.length > 0) {
        return {
            subject: {
                name: next.name, slug: next.slug, url: next.url,
                roundDates: next.roundDates, totalRounds: next.roundDates.length,
                isNext: true,
            },
            phase: getTimeState(next.roundDates, null),
        };
    }

    return {
        subject: {
            name: meta?.name || 'Tuesday Night Marathon',
            slug: meta?.slug || null,
            url: meta?.url || null,
            roundDates: currentRoundDates,
            totalRounds: meta?.totalRounds || currentRoundDates.length,
            isNext: false,
        },
        phase,
    };
}

const OG_STATE_CONFIG = {
    yes:         { title: 'YES — Pairings Are Up!', color: '#00c853', image: 'og-yes.png' },
    no:          { title: 'Waiting for Pairings...', color: '#ff1744', image: 'og-no.png' },
    too_early:   { title: 'CHILL', color: '#7b1fa2', image: 'og-too-early.png' },
    in_progress: { title: 'In Progress', color: '#1565c0', image: 'og-in-progress.png' },
    results:     { title: 'COMPLETE — Results Are In!', color: '#f57c00', image: 'og-results.png' },
    off_season:  { title: 'REST — Off Season', color: '#5D8047', image: 'og-off-season.png' },
};

export function computeAppState(cached, meta) {
    // One subject tournament drives the entire response. chooseSubject also
    // returns the time phase computed from THAT subject's dates, so the state
    // verb, the round number, and the tournament identity all come from one
    // place and can't drift apart.
    const { subject, phase } = chooseSubject(meta);
    const { name: tournamentName, roundDates, totalRounds } = subject;
    const nextTournament = meta?.nextTournament || null;

    // Round derives from the subject only. cached.round is parsed from
    // current's HTML, so it's authoritative just when the subject IS current;
    // otherwise fall back to "latest round whose start time has passed."
    let roundNumber = subject.isNext ? null : (cached?.round || null);
    if (!roundNumber && roundDates.length > 0) {
        const nowMs = Date.now();
        for (let i = roundDates.length - 1; i >= 0; i--) {
            if (nowMs >= new Date(roundDates[i]).getTime()) { roundNumber = i + 1; break; }
        }
        if (!roundNumber) roundNumber = 1;
    }

    let state, info, offSeason = null;

    if (phase === 'off_season' || phase === 'off_season_r1') {
        state = 'off_season';
        const r1 = roundDates?.[0];
        const r1Date = r1 ? new Date(r1) : null;
        if (phase === 'off_season_r1') {
            offSeason = { targetDate: r1 };
            info = 'Round 1 pairings will be posted onsite';
        } else if (r1Date && r1Date.getTime() > Date.now()) {
            const dateStr = r1Date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
            info = `${tournamentName || 'The next TNM'} starts ${dateStr}. Round 1 pairings will be posted onsite.`;
            offSeason = { targetDate: r1 };
        } else if (nextTournament?.startDate) {
            const [ny, nm, nd] = nextTournament.startDate.split('-').map(Number);
            const dateStr = new Date(pacificDatetime(ny, nm, nd)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
            info = `The next TNM starts ${dateStr}. Round 1 pairings will be posted onsite.`;
            offSeason = { targetDate: pacificDatetime(ny, nm, nd, '18:30:00') };
        } else {
            info = 'Check back for the next TNM schedule.';
        }
    } else if (phase === 'too_early') {
        const pairingsUp = cached?.html ? hasPairings(cached.html) : false;
        if (pairingsUp && !hasResults(cached.html)) {
            state = 'yes'; info = `Round ${roundNumber} pairings are up!`;
        } else {
            state = 'too_early'; info = 'Pairings are posted Monday at 8PM Pacific. Check back then!';
        }
    } else if (phase === 'round_in_progress') {
        const resultsIn = cached?.html ? hasResults(cached.html) : false;
        if (resultsIn) { state = 'results'; info = `Round ${roundNumber} is complete. Results are in!`; }
        else { state = 'in_progress'; info = `Round ${roundNumber} is being played right now!`; }
    } else if (phase === 'results_window') {
        state = 'results';
        const isFinal = totalRounds > 0 && roundNumber >= totalRounds;
        info = isFinal
            ? `${tournamentName} is complete! Final standings are posted.`
            : roundNumber
                ? `Round ${roundNumber} is complete. Check back Monday for next week's pairings!`
                : 'The round is complete. Check back Monday for next week\'s pairings!';
    } else {
        const pairingsUp = cached?.html ? hasPairings(cached.html) : false;
        if (!pairingsUp) {
            state = 'no'; info = 'Waiting for pairings to be posted...';
        } else if (!hasResults(cached.html)) {
            state = 'yes'; info = `Round ${roundNumber} pairings are up!`;
        } else {
            state = 'no'; info = `Round ${roundNumber} is complete. Waiting for Round ${roundNumber + 1}...`;
        }
    }

    return {
        state, round: roundNumber, info,
        tournamentName, tournamentSlug: subject.slug, tournamentUrl: subject.url,
        roundDates, totalRounds, offSeason,
    };
}

export async function handleTournamentHtml(request, env) {
    const [cached, meta] = await Promise.all([
        env.SUBSCRIBERS.get('cache:tournamentHtml', 'json'),
        resolveTournament(env),
    ]);
    if (!cached) return corsResponse({ error: 'No cached data available', html: null }, 503, env, request);

    return corsResponse({
        html: cached.html, fetchedAt: cached.fetchedAt, round: cached.round,
        tournamentName: meta?.name || null, tournamentSlug: meta?.slug || null,
        tournamentUrl: meta?.url || null, roundDates: meta?.roundDates || [],
    }, 200, env, request);
}

export async function handleTournamentState(request, env) {
    const cachedAppState = await env.SUBSCRIBERS.get('cache:appState', 'json');
    if (cachedAppState) return corsResponse(cachedAppState, 200, env, request);

    const [cached, meta] = await Promise.all([
        env.SUBSCRIBERS.get('cache:tournamentHtml', 'json'),
        resolveTournament(env),
    ]);
    const appState = computeAppState(cached, meta);

    return corsResponse({
        state: appState.state, round: appState.round,
        tournamentName: appState.tournamentName, tournamentUrl: appState.tournamentUrl,
        tournamentSlug: appState.tournamentSlug, roundDates: appState.roundDates,
        fetchedAt: cached?.fetchedAt || null,
    }, 200, env, request);
}

export async function handleStandings(request, env) {
    const [cached, meta] = await Promise.all([
        env.SUBSCRIBERS.get('cache:tournamentHtml', 'json'),
        resolveTournament(env),
    ]);
    if (!cached?.html) return corsResponse({ sections: [], tournamentName: null, tournamentSlug: null }, 200, env, request);

    const sections = parseStandings(cached.html);
    return corsResponse({
        sections,
        tournamentName: meta?.name || null,
        tournamentSlug: meta?.slug || null,
        tournamentUrl: meta?.url || null,
        roundDates: meta?.roundDates || [],
        fetchedAt: cached.fetchedAt,
    }, 200, env, request);
}

export async function handleOgState(request, env) {
    const [cached, meta] = await Promise.all([
        env.SUBSCRIBERS.get('cache:tournamentHtml', 'json'),
        resolveTournament(env),
    ]);
    const appState = computeAppState(cached, meta);
    const ogConfig = OG_STATE_CONFIG[appState.state] || OG_STATE_CONFIG.no;
    const title = appState.state === 'in_progress' && appState.round
        ? `ROUND ${appState.round} — In Progress` : ogConfig.title;

    return corsResponse({
        state: appState.state, roundNumber: appState.round,
        tournamentName: appState.tournamentName, title,
        description: appState.info, color: ogConfig.color, image: ogConfig.image,
    }, 200, env, request);
}

export async function handleHealth(env, request) {
    const [lastCheck, pairingsState, resultsState, gamesState, cached] = await Promise.all([
        env.SUBSCRIBERS.get('state:lastCheck'),
        env.SUBSCRIBERS.get('state:pairingsUp', 'json'),
        env.SUBSCRIBERS.get('state:resultsPosted', 'json'),
        env.SUBSCRIBERS.get('state:gamesPosted', 'json'),
        env.SUBSCRIBERS.get('cache:tournamentHtml', 'json'),
    ]);

    let lastCheckData = null;
    if (lastCheck) {
        try { lastCheckData = JSON.parse(lastCheck); }
        catch { console.warn('Corrupt state:lastCheck in KV, ignoring'); }
    }
    const lastCheckTime = lastCheckData?.timestamp ? new Date(lastCheckData.timestamp).getTime() : null;

    return corsResponse({
        status: 'ok',
        lastCheck: lastCheckData || null,
        minutesSinceLastCheck: lastCheckTime ? Math.round((Date.now() - lastCheckTime) / 60000) : null,
        pairingsUp: pairingsState || null, resultsPosted: resultsState || null, gamesPosted: gamesState || null,
        cachedRound: cached?.round || null, cachedAt: cached?.fetchedAt || null,
    }, 200, env, request);
}
