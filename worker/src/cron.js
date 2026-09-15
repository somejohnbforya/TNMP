import { DurableObject } from 'cloudflare:workers';
import { slugifyTournament, normalizePlayerName, titleCaseName, normalizeSection, isExtraRated, pacificNow, extractRatingFloor, floorFromPeak } from './helpers.js';
import { resolveTournament, computeAppState, discoverUpcomingTournaments } from './tournament.js';
import { listPushSubscriptions, dispatchPushNotifications, retryPendingNotifications } from './push.js';
import {
    parseTournamentPage, parseStandings,
    parsePlayerInfo, parseGameResult, isForfeitPairing, findPlayerPairingFromSections,
    findPlayerResultFromSections, composeMessage, composeResultsMessage, composeGamesMessage,
    composeRecapMessage, composeFinalMessage,
} from './parser.js';
import { classifyOpening } from './eco.js';

export class TournamentCron extends DurableObject {
    async fetch() {
        await runCronLogic(this.env);
        return new Response('ok');
    }
}

export async function handleScheduled(env, { force = false } = {}) {
    const { day: pDay, hour: pHour, minute: pMinute } = pacificNow();

    const isPairingsWindow = pDay === 1 && pHour >= 19;
    const isResultsWindow = pDay === 2 && pHour >= 19;

    if (!force && !isPairingsWindow && !isResultsWindow) {
        if (pMinute % 20 > 2 && pMinute % 20 < 18) {
            console.log(`Cron skipped: Pacific ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][pDay]} ${pHour}:${String(pMinute).padStart(2, '0')} outside active window`);
            return;
        }
    }

    const id = env.TOURNAMENT_CRON.idFromName('singleton');
    const stub = env.TOURNAMENT_CRON.get(id);
    const res = await stub.fetch('https://do/run');
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`TournamentCron DO failed (${res.status}): ${text}`);
    }
}

async function updateLastCheck(env, { pairingsFound = false, error = null } = {}) {
    const data = { timestamp: new Date().toISOString(), pairingsFound };
    if (error) data.error = error;
    await env.SUBSCRIBERS.put('state:lastCheck', JSON.stringify(data));
}

async function runCronLogic(env) {
    console.log('Cron triggered: checking for pairings...');
    const t = {};
    let t0;

    t0 = performance.now();
    try {
        const added = await discoverUpcomingTournaments(env);
        if (added > 0) console.log(`Tournament discovery: added ${added} new tournament(s).`);
    } catch (err) {
        console.error('Tournament discovery failed:', err.message);
    }
    t.discoverTournaments = performance.now() - t0;

    t0 = performance.now();
    const tournament = await resolveTournament(env);
    t.resolveTournament = performance.now() - t0;
    if (!tournament) {
        console.error('Could not resolve tournament');
        await updateLastCheck(env, { error: 'Could not resolve tournament' });
        return;
    }

    console.log(`Using tournament: ${tournament.name} (${tournament.url})`);

    let html;
    t0 = performance.now();
    try {
        const response = await fetch(tournament.url, {
            headers: { 'User-Agent': 'TNMP-Notification-Worker/1.0' },
        });
        if (!response.ok) {
            console.error(`Failed to fetch tournament page: HTTP ${response.status}`);
            await updateLastCheck(env, { error: `MI page HTTP ${response.status}` });
            return;
        }
        html = await response.text();
    } catch (err) {
        console.error('Fetch error:', err.message);
        await updateLastCheck(env, { error: `Fetch error: ${err.message}` });
        return;
    }
    t.fetchHtml = performance.now() - t0;

    t0 = performance.now();
    const hashBuffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(html));
    const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    const storedHash = await env.SUBSCRIBERS.get('cache:htmlHash');
    t.hashCheck = performance.now() - t0;
    if (hash === storedHash) {
        console.log('HTML unchanged, skipping HTML processing.');
        const cached = await env.SUBSCRIBERS.get('cache:tournamentHtml', 'json');
        const parsed = cached?.html ? parseTournamentPage(cached.html) : null;
        const hasPairingsFlag = !!parsed?.hasPairings;
        await dispatchAllNotifications(parsed, tournament, env);
        await retryPendingNotifications(env);

        // Recompute time-dependent app state even when HTML hasn't changed
        const appState = computeAppState(cached, tournament);
        await env.SUBSCRIBERS.put('cache:appState', JSON.stringify({
            state: appState.state, round: appState.round,
            tournamentName: appState.tournamentName, tournamentUrl: appState.tournamentUrl,
            tournamentSlug: appState.tournamentSlug, roundDates: appState.roundDates,
            fetchedAt: new Date().toISOString(),
        }));
        await updateLastCheck(env, { pairingsFound: hasPairingsFlag });
        return;
    }
    console.log('HTML changed, processing...');

    // The page counts as processed only once every write from it has landed:
    // its hash is saved at the end, so a failed write retries on the next tick
    // instead of waiting for MI to edit the page again.
    const writeErrors = [];

    t0 = performance.now();
    const parsed = parseTournamentPage(html);
    t.parseTournamentPage = performance.now() - t0;

    const aliasMap = new Map();
    const uscfIdMap = new Map();
    const ratingHistoryMap = new Map();
    t0 = performance.now();
    try {
        const allPlayers = await env.DB.prepare(
            "SELECT name, name_norm, uscf_id, aliases, rating_history FROM players"
        ).all();
        for (const row of allPlayers.results) {
            let aliases;
            try { aliases = JSON.parse(row.aliases || '[]'); } catch { aliases = []; }
            if (row.uscf_id) uscfIdMap.set(row.uscf_id, { name: row.name, norm: row.name_norm, aliases });
            for (const alias of aliases) {
                aliasMap.set(alias, { name: row.name, norm: row.name_norm });
            }
            if (row.rating_history) {
                try {
                    const history = JSON.parse(row.rating_history);
                    if (history.length > 0) ratingHistoryMap.set(row.name, history);
                } catch { /* ignore malformed JSON */ }
            }
        }
    } catch { /* players table may not exist yet */ }
    t.loadPlayers = performance.now() - t0;

    function ratingAtDate(playerName, gameDate) {
        if (!gameDate) return null;
        const history = ratingHistoryMap.get(playerName);
        if (!history) return null;
        const normalized = gameDate.replace(/\./g, '-');
        let best = null;
        for (const entry of history) {
            if (entry.date <= normalized) best = entry.rating;
            else break;
        }
        return best;
    }

    const htmlNameToUscfId = new Map();
    let standings = [];
    t0 = performance.now();
    try {
        standings = parseStandings(parsed.strippedHtml);
        for (const section of standings) {
            for (const p of section.players) {
                if (p.id && p.name) htmlNameToUscfId.set(normalizePlayerName(p.name), p.id);
            }
        }
    } catch (err) {
        console.error('Failed to parse standings:', err.message);
    }
    t.parseStandings = performance.now() - t0;

    const newPlayerIds = [];
    for (const section of standings) {
        for (const p of section.players) {
            if (p.id && !uscfIdMap.has(p.id)) newPlayerIds.push(p.id);
        }
    }
    if (newPlayerIds.length > 0) {
        const unique = [...new Set(newPlayerIds)];
        const newPlayerStmts = [];
        for (const uscfId of unique) {
            try {
                const res = await fetch(`https://ratings-api.uschess.org/api/v1/members/${uscfId}/`);
                if (!res.ok) continue;
                const data = await res.json();
                const last = titleCaseName((data.lastName || '').toLowerCase());
                const first = titleCaseName((data.firstName || '').toLowerCase());
                const name = `${last}, ${first}`;
                const norm = normalizePlayerName(name);
                const regular = data.ratings?.find(r => r.ratingSystem === 'R');
                const rating = regular?.rating || null;
                // Published floor if the payload carries one, else derived
                // from the current rating (their peak so far as we know it).
                const floor = extractRatingFloor(data) ?? floorFromPeak(rating) ?? 0;

                uscfIdMap.set(uscfId, { name, norm, aliases: [norm] });
                aliasMap.set(norm, { name, norm });

                newPlayerStmts.push(
                    env.DB.prepare(
                        `INSERT INTO players (name, name_norm, uscf_id, aliases, rating, rating_floor, rating_updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(name_norm) DO UPDATE SET
                         uscf_id = COALESCE(excluded.uscf_id, players.uscf_id),
                         rating = excluded.rating, rating_updated_at = excluded.rating_updated_at,
                         rating_floor = COALESCE(NULLIF(excluded.rating_floor, 0), players.rating_floor, 0)`
                    ).bind(name, norm, uscfId, JSON.stringify([norm]), rating, floor, new Date().toISOString())
                );
            } catch (err) {
                console.error(`Failed to fetch US Chess data for ${uscfId}:`, err.message);
            }
        }
        if (newPlayerStmts.length > 0) {
            await env.DB.batch(newPlayerStmts);
            console.log(`Created ${newPlayerStmts.length} new player(s) from US Chess: ${unique.slice(0, 5).join(', ')}${unique.length > 5 ? '...' : ''}`);
        }
    }

    const newAliases = [];
    function canonicalize(name) {
        const norm = normalizePlayerName(name);
        const alias = aliasMap.get(norm);
        if (alias) return { name: alias.name, norm: alias.norm };
        const uscfId = htmlNameToUscfId.get(norm);
        if (uscfId) {
            const canonical = uscfIdMap.get(uscfId);
            if (canonical && canonical.norm !== norm) {
                aliasMap.set(norm, { name: canonical.name, norm: canonical.norm });
                canonical.aliases.push(norm);
                newAliases.push({ uscfId, norm, canonicalName: canonical.name, aliases: canonical.aliases });
                return { name: canonical.name, norm: canonical.norm };
            }
        }
        const tc = titleCaseName(name);
        const parts = tc.split(/,\s*/);
        if (parts.length >= 2) return { name: tc, norm };
        const words = tc.split(/\s+/);
        if (words.length >= 2) {
            const last = words[words.length - 1];
            const first = words.slice(0, -1).join(' ');
            return { name: `${last}, ${first}`, norm };
        }
        return { name: tc, norm };
    }

    function canonicalizeByIdOrName(uscfId, name) {
        if (uscfId) {
            const canonical = uscfIdMap.get(uscfId);
            if (canonical) return { name: canonical.name, norm: canonical.norm };
        }
        return canonicalize(name);
    }

    t0 = performance.now();
    await env.SUBSCRIBERS.put('cache:tournamentHtml', JSON.stringify({
        html: parsed.strippedHtml,
        fetchedAt: new Date().toISOString(),
        round: parsed.roundNumber,
    }));
    console.log(`Cached tournament HTML in KV (${parsed.strippedHtml.length} chars, stripped from ${html.length}).`);
    t.kvPutHtml = performance.now() - t0;

    t0 = performance.now();
    const cached = { html: parsed.strippedHtml, round: parsed.roundNumber };
    const appState = computeAppState(cached, tournament);
    t.computeAppState = performance.now() - t0;
    const slug = tournament.slug || slugifyTournament(tournament.name);

    t0 = performance.now();
    await env.SUBSCRIBERS.put('cache:appState', JSON.stringify({
        state: appState.state, round: appState.round,
        tournamentName: appState.tournamentName, tournamentUrl: appState.tournamentUrl,
        tournamentSlug: appState.tournamentSlug, roundDates: appState.roundDates,
        fetchedAt: new Date().toISOString(),
    }));
    console.log(`Cached appState in KV.`);
    t.kvPutAppState = performance.now() - t0;

    // Byes and forfeit cleanup read standings round columns as TNM rounds, and
    // the Extra Rated section's columns aren't: it numbers its own rounds.
    const tnmStandings = standings.filter(s => !isExtraRated(s.section));

    t0 = performance.now();
    try {
        const byeTypes = { H: 'half', B: 'full', U: 'zero' };
        const byeStmts = [];
        for (const section of tnmStandings) {
            for (const p of section.players) {
                const uscfId = p.id || null;
                const resolved = canonicalizeByIdOrName(uscfId, p.name);
                for (let i = 0; i < p.rounds.length; i++) {
                    const rd = p.rounds[i];
                    if (!rd || !byeTypes[rd.result]) continue;
                    byeStmts.push(
                        env.DB.prepare(
                            `INSERT INTO byes (tournament_slug, round, player_norm, bye_type)
                             VALUES (?, ?, ?, ?)
                             ON CONFLICT(tournament_slug, round, player_norm) DO NOTHING`
                        ).bind(slug, i + 1, resolved.norm, byeTypes[rd.result])
                    );
                }
            }
        }
        // Rebuild this tournament's byes from the freshly parsed standings. A
        // plain INSERT ... DO NOTHING is append-only and can't remove a bye that
        // was previously written to the wrong round (e.g. when a SwissSys layout
        // change shifted the round columns), so we delete-then-reinsert to make
        // the table self-correcting. Guarded on a non-empty parse so a standings
        // fetch hiccup can't wipe good data. Standings always carry the full bye
        // picture (including future requested byes shown as H---), so a full
        // rebuild is complete.
        if (tnmStandings.length > 0) {
            const stmts = [
                env.DB.prepare(`DELETE FROM byes WHERE tournament_slug = ?`).bind(slug),
                ...byeStmts,
            ];
            for (let i = 0; i < stmts.length; i += 100) {
                await env.DB.batch(stmts.slice(i, i + 100));
            }
            console.log(`Rebuilt byes for ${slug}: ${byeStmts.length} bye(s).`);
        }
    } catch (err) {
        console.error('Failed to persist byes:', err.message);
        writeErrors.push(`byes: ${err.message}`);
    }
    t.byes = performance.now() - t0;

    // Pairings that were never played: once standings are posted, a player
    // marked F (forfeit) or H/B/U (bye) in a round played no regular game that
    // round, so their pairings row is deleted. Extra Rated rows stay (a player
    // on a bye can still play an Extra Rated game), and the pgn-IS-NULL guard
    // never touches a game with moves.
    t0 = performance.now();
    try {
        const unplayedStmts = [];
        for (const section of tnmStandings) {
            for (const p of section.players) {
                const resolved = canonicalizeByIdOrName(p.id || null, p.name);
                for (let i = 0; i < p.rounds.length; i++) {
                    const rd = p.rounds[i];
                    if (!['F', 'H', 'B', 'U'].includes(rd?.result)) continue;
                    unplayedStmts.push(
                        env.DB.prepare(
                            `DELETE FROM games WHERE tournament_slug = ? AND round = ?
                             AND (white_norm = ? OR black_norm = ?)
                             AND (pgn IS NULL OR pgn = '')
                             AND (section IS NULL OR section NOT LIKE '%extra%')`
                        ).bind(slug, i + 1, resolved.norm, resolved.norm)
                    );
                }
            }
        }
        for (let i = 0; i < unplayedStmts.length; i += 100) {
            await env.DB.batch(unplayedStmts.slice(i, i + 100));
        }
    } catch (err) {
        console.error('Failed to clean unplayed pairings:', err.message);
        writeErrors.push(`unplayed pairings cleanup: ${err.message}`);
    }
    t.unplayedCleanup = performance.now() - t0;

    let newCount = 0;
    let updatedCount = 0;
    const existingMap = new Map();
    // Each round's games by pair of players → board: stored rows, then this
    // run's PGNs. The pairings step reads it so a pairing never re-creates a
    // game that already sits on another board.
    const placed = new Map();
    const pairKey = (normA, normB) => [normA, normB].sort().join('|');
    const place = (round, key, board) => {
        if (!placed.has(round)) placed.set(round, new Map());
        placed.get(round).set(key, board);
    };

    // The posted pairings, canonicalized once: PGNs are placed around them,
    // and the pairings step writes them.
    const posted = [];
    for (const section of parsed.pairingsSections) {
        // Extra Rated pairings count their own rounds; their games are
        // played in the page's current TNM round.
        const rnd = isExtraRated(section.section) ? parsed.roundNumber : section.round;
        for (const row of section.rows) {
            if (/^(bye|full point bye)$/i.test(row.whiteName) || /^(bye|full point bye)$/i.test(row.blackName)) continue;
            if (isForfeitPairing(row)) continue;
            const board = row.board ? parseInt(row.board, 10) || null : null;
            if (!board) continue;
            const wInfo = parsePlayerInfo(row.whiteName);
            const bInfo = parsePlayerInfo(row.blackName);
            const wc = canonicalizeByIdOrName(row.whiteUscfId, wInfo.name);
            const bc = canonicalizeByIdOrName(row.blackUscfId, bInfo.name);
            posted.push({
                rnd, board, section: section.section, row, wInfo, bInfo, wc, bc,
                key: pairKey(wc.norm, bc.norm), extra: isExtraRated(section.section), hasPgn: false,
            });
        }
    }

    try {
        t0 = performance.now();
        const existing = await env.DB.prepare(
            'SELECT round, board, section, white_norm, black_norm, result, pgn FROM games WHERE tournament_slug = ?'
        ).bind(slug).all();
        const storedByRound = new Map();
        for (const row of existing.results) {
            const stored = {
                key: pairKey(row.white_norm, row.black_norm), board: row.board,
                extra: isExtraRated(row.section), hasPgn: !!row.pgn,
            };
            existingMap.set(`${row.round}:${row.board}`, { result: row.result, hasPgn: stored.hasPgn });
            if (!storedByRound.has(row.round)) storedByRound.set(row.round, []);
            storedByRound.get(row.round).push(stored);
            if (stored.hasPgn || !placed.get(row.round)?.has(stored.key)) place(row.round, stored.key, row.board);
        }
        t.loadExistingGames = performance.now() - t0;

        const stmts = [];
        const totalParsed = Object.values(parsed.fullGames).reduce((sum, g) => sum + g.length, 0);
        console.log(`fullGames: ${totalParsed} games across rounds ${Object.keys(parsed.fullGames).join(', ')}`);
        t0 = performance.now();
        // Place each round's PGNs, drop the pairings rows they supersede, and
        // keep what still needs writing.
        const writesByRound = new Map();
        for (const [roundNum, games] of Object.entries(parsed.fullGames)) {
            const round = parseInt(roundNum, 10);
            const stored = storedByRound.get(round) || [];
            const pgns = games.map(g => {
                const w = canonicalize(g.white);
                const b = canonicalize(g.black);
                return { g, w, b, key: pairKey(w.norm, b.norm), board: g.board, extra: isExtraRated(g.section) };
            }).sort((x, y) => x.extra - y.extra);
            const boards = assignBoards([...stored, ...posted.filter(p => p.rnd === round)], pgns);
            const roundWrites = [];
            const seen = new Set();
            for (const p of pgns) {
                if (seen.has(p.key)) {
                    console.warn(`R${round} ${p.g.white} - ${p.g.black}: a second PGN for one pair in one round; keeping the first.`);
                    continue;
                }
                seen.add(p.key);
                const board = boards.get(p.key);
                for (const s of stored) {
                    if (s.key !== p.key || s.board === board || s.hasPgn) continue;
                    stmts.push(env.DB.prepare(
                        `DELETE FROM games WHERE tournament_slug = ? AND round = ? AND board = ? AND (pgn IS NULL OR pgn = '')`
                    ).bind(slug, round, s.board));
                    existingMap.delete(`${round}:${s.board}`);
                }
                place(round, p.key, board);
                const ex = existingMap.get(`${round}:${board}`);
                if (ex && ex.hasPgn && ex.result === p.g.result) continue;
                roundWrites.push({ ...p, board, ex, rowKey: `${slug}:${round}:${board}` });
                existingMap.set(`${round}:${board}`, { result: p.g.result, hasPgn: true });
            }
            writesByRound.set(round, roundWrites);
        }
        const pending = [...writesByRound.values()].flat().map(w => ({ rowKey: w.rowKey, gameId: w.g.gameId }));
        const gameIds = resolveGameIds(pending, await loadGameIdOwners(env, pending.map(p => p.gameId)));
        for (const [round, roundWrites] of writesByRound) {
            // Canonical ISO-datetime for this round (e.g. 2026-05-12T18:30:00-07:00).
            // Use this instead of the PGN [Date] header so the games.date column
            // stays in one consistent format for sortable lex comparison.
            const canonicalDate = tournament.roundDates?.[round - 1] || null;
            for (const { g, w, b, board, ex, rowKey } of roundWrites) {
                if (g.gameId && !gameIds.get(rowKey)) {
                    console.warn(`GameId ${g.gameId} collides with another game; storing ${rowKey} without it.`);
                }

                const whiteName = w.name, whiteNorm = w.norm;
                const blackName = b.name, blackNorm = b.norm;

                const opening = classifyOpening(g.pgn);
                stmts.push(
                    env.DB.prepare(
                        `INSERT INTO games
                         (tournament_slug, round, board, white, black, white_norm, black_norm,
                          white_elo, black_elo, result, eco, opening_name, section, date, game_id, pgn)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(tournament_slug, round, board) DO UPDATE SET
                          white=excluded.white, black=excluded.black,
                          white_norm=excluded.white_norm, black_norm=excluded.black_norm,
                          white_elo=excluded.white_elo, black_elo=excluded.black_elo,
                          result=excluded.result, eco=excluded.eco, opening_name=excluded.opening_name,
                          section=excluded.section, date=excluded.date, game_id=excluded.game_id, pgn=excluded.pgn`
                    ).bind(
                        slug, round, board,
                        whiteName, blackName,
                        whiteNorm, blackNorm,
                        g.whiteElo ? parseInt(g.whiteElo) : ratingAtDate(whiteName, g.date),
                        g.blackElo ? parseInt(g.blackElo) : ratingAtDate(blackName, g.date),
                        g.result,
                        opening ? opening.eco : g.eco,
                        opening ? opening.name : null,
                        normalizeSection(g.section), canonicalDate, gameIds.get(rowKey), g.pgn
                    )
                );
                if (ex) updatedCount++;
                else newCount++;
            }
        }
        t.fullGamesLoop = performance.now() - t0;
        t0 = performance.now();
        if (stmts.length > 0) {
            for (let i = 0; i < stmts.length; i += 100) {
                await env.DB.batch(stmts.slice(i, i + 100));
            }
            console.log(`D1: ${newCount} new, ${updatedCount} updated games across ${Object.keys(parsed.fullGames).length} rounds.`);
        }
        t.fullGamesWrite = performance.now() - t0;
    } catch (err) {
        console.error('Failed to store games in D1:', err.message, err.stack);
        writeErrors.push(`games: ${err.message}`);
    }

    t0 = performance.now();
    if (parsed.hasPairings) {
        try {
            const shellStmts = [];
            for (const { rnd, board, section, row, wInfo, bInfo, wc, bc, key } of posted) {
                const ex = existingMap.get(`${rnd}:${board}`);
                const result = parseGameResult(row.whiteResult, row.blackResult);

                if (ex && (ex.result !== '*' || result === '*')) continue;
                // This pair's game already sits on another board, where its PGN put it.
                const at = placed.get(rnd)?.get(key);
                if (at != null && at !== board) continue;

                const white = wc.name, whiteNorm = wc.norm;
                const black = bc.name, blackNorm = bc.norm;
                const roundDate = tournament.roundDates?.[rnd - 1] || null;
                shellStmts.push(
                    env.DB.prepare(
                        `INSERT INTO games
                         (tournament_slug, round, board, white, black, white_norm, black_norm, white_elo, black_elo, result, section, date, pgn)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                         ON CONFLICT(tournament_slug, round, board) DO UPDATE SET
                          result = excluded.result
                          WHERE games.result = '*' AND excluded.result != '*'`
                    ).bind(slug, rnd, board, white, black, whiteNorm, blackNorm,
                        wInfo.rating || ratingAtDate(white, roundDate),
                        bInfo.rating || ratingAtDate(black, roundDate),
                        result, normalizeSection(section), roundDate)
                );
            }
            for (let i = 0; i < shellStmts.length; i += 100) {
                await env.DB.batch(shellStmts.slice(i, i + 100));
            }
            if (shellStmts.length > 0) {
                console.log(`Upserted ${shellStmts.length} shell records (insert or update result).`);
            }
        } catch (err) {
            console.error('Failed to upsert shell records:', err.message, err.stack);
            writeErrors.push(`shell records: ${err.message}`);
        }
    }
    t.shellRecords = performance.now() - t0;

    // Update tournament metadata (total_rounds, sections)
    try {
        const maxRound = await env.DB.prepare(
            'SELECT MAX(round) as max_round FROM games WHERE tournament_slug = ?'
        ).bind(slug).first();
        const sectionRows = await env.DB.prepare(
            'SELECT DISTINCT section FROM games WHERE tournament_slug = ? AND section IS NOT NULL'
        ).bind(slug).all();
        const sortOrder = (s) => {
            if (/extra/i.test(s)) return 9999;
            const m = s.match(/(\d+)/);
            return m ? -parseInt(m[1], 10) : 0;
        };
        const sections = sectionRows.results.map(r => r.section).sort((a, b) => sortOrder(a) - sortOrder(b));
        await env.DB.prepare(
            'UPDATE tournaments SET total_rounds = ?, sections = ? WHERE slug = ?'
        ).bind(maxRound.max_round, sections.length > 0 ? JSON.stringify(sections) : null, slug).run();
    } catch (err) {
        console.error('Failed to update tournament metadata:', err.message);
        writeErrors.push(`tournament metadata: ${err.message}`);
    }

    if (newAliases.length > 0) {
        try {
            const stmts = newAliases.map(a =>
                env.DB.prepare('UPDATE players SET aliases = ? WHERE uscf_id = ?')
                    .bind(JSON.stringify(a.aliases), a.uscfId)
            );
            await env.DB.batch(stmts);
            console.log(`Auto-aliased ${newAliases.length} name(s): ${newAliases.map(a => `${a.norm} → ${a.canonicalName}`).join(', ')}`);
        } catch (err) {
            console.error('Failed to persist new aliases:', err.message);
            writeErrors.push(`aliases: ${err.message}`);
        }
    }

    if (writeErrors.length === 0) await env.SUBSCRIBERS.put('cache:htmlHash', hash);
    await updateLastCheck(env, { pairingsFound: parsed.hasPairings, error: writeErrors.join('; ') || null });

    t0 = performance.now();
    await dispatchAllNotifications(parsed, tournament, env);
    t.notifications = performance.now() - t0;

    t0 = performance.now();
    await retryPendingNotifications(env);
    t.retryNotifications = performance.now() - t0;

    const total = Object.values(t).reduce((s, v) => s + v, 0);
    console.log(`[TIMING] ${Object.entries(t).map(([k, v]) => `${k}=${v.toFixed(1)}ms`).join(' | ')} | total=${total.toFixed(1)}ms`);
}

// The board each PGN in a round goes on. MI's sources arrive in trust order:
// pairings on Monday, results that can reshuffle them, then PGNs recording
// where each game was actually played. So a PGN takes the board it names,
// unless another pair's game holds it; else its pair's stored board (for an
// Extra Rated game, the one MI adds to the pairings after results); else the
// next free board past the round's regular games, which is how MI numbers
// Extra Rated games. A game already stored with moves keeps its board, regular
// games are placed before Extra Rated ones, and a pair's first PGN wins.
// rows: the round's stored and posted games, as { key, board, extra, hasPgn }
// pgns: the round's PGNs in file order, as { key, board, extra }
// Returns pair key → board.
export function assignBoards(rows, pgns) {
    const holder = new Map(); // board → pair key
    const regularBoards = new Set();
    const own = new Map(); // pair key → its row, preferring one with moves
    const hold = (board, key, extra) => {
        holder.set(board, key);
        if (!extra) regularBoards.add(board);
    };
    for (const r of rows) {
        if (r.board == null) continue;
        if (!holder.has(r.board)) hold(r.board, r.key, r.extra);
        const prev = own.get(r.key);
        if (!prev || (r.hasPgn && !prev.hasPgn)) own.set(r.key, r);
    }

    const boards = new Map();
    for (const p of [...pgns.filter(p => !p.extra), ...pgns.filter(p => p.extra)]) {
        if (boards.has(p.key)) continue;
        const isFree = (board) => board != null && (!holder.has(board) || holder.get(board) === p.key);
        const stored = own.get(p.key);
        let board;
        if (stored?.hasPgn && isFree(stored.board)) board = stored.board;
        else if (isFree(p.board)) board = p.board;
        else if (stored && isFree(stored.board)) board = stored.board;
        else {
            board = Math.max(0, ...regularBoards) + 1;
            while (holder.has(board)) board++;
        }
        if (stored && stored.board !== board && holder.get(stored.board) === p.key) holder.delete(stored.board);
        hold(board, p.key, p.extra);
        boards.set(p.key, board);
    }
    return boards;
}

// game_id → the row holding it, as `slug:round:board`, across every tournament
// (the UNIQUE index on games.game_id is global). Chunked under D1's limit of 100
// bound parameters per query.
async function loadGameIdOwners(env, gameIds) {
    const ids = [...new Set(gameIds.filter(Boolean))];
    const owners = new Map();
    for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const { results } = await env.DB.prepare(
            `SELECT game_id, tournament_slug, round, board FROM games WHERE game_id IN (${chunk.map(() => '?').join(', ')})`
        ).bind(...chunk).all();
        for (const r of results) owners.set(r.game_id, `${r.tournament_slug}:${r.round}:${r.board}`);
    }
    return owners;
}

// Which GameId each pending write may store (rowKey → id or null). game_id is
// UNIQUE because share links resolve by it, and a D1 batch is all-or-nothing,
// so one colliding id used to sink the whole round. MI's exporter does collide
// (Fall 2026 round 2 stamped one id on two different Extra Rated games), so a
// collision costs the id, never the game: a row that already holds an id keeps
// it, so existing share links still resolve, and an id claimed by two writes
// goes to neither, since nothing says which header is the real one.
export function resolveGameIds(pending, owners) {
    const claims = new Map();
    for (const { gameId } of pending) {
        if (gameId) claims.set(gameId, (claims.get(gameId) || 0) + 1);
    }
    const resolved = new Map();
    for (const { rowKey, gameId } of pending) {
        const owner = gameId ? owners.get(gameId) : undefined;
        const keep = gameId && (owner ? owner === rowKey : claims.get(gameId) === 1);
        resolved.set(rowKey, keep ? gameId : null);
    }
    return resolved;
}

export function pairingsExpiresAt(roundDates, round) {
    const dateStr = roundDates?.[round - 1];
    if (!dateStr) return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return new Date(dateStr).toISOString();
}

// Combinatorial notification dispatcher.
//
// On each cron tick we observe up to three signals:
//   pairings_new — page has fresh pairings we haven't notified for
//   results_new  — page has fresh results we haven't notified for
//   games_new    — D1 has enough PGN games to consider the round "playable"
//
// Rather than firing one notification per signal (the old design, which sent
// 2-3 buzzes within 3 seconds when MI published everything at once on Round 1),
// we look at the signal combination and emit a single notification whose
// framing fits the situation. Final-round signals get a "Tournament Complete!"
// framing instead of "Round X."
//
// Selection priority: high-information notifications outrank narrow ones.
// If recap fires (pairings + results both new), games stays unmarked so it
// can fire on its own subsequent tick once PGNs are uploaded.
export function selectNotificationKind({ pairingsNew, resultsNew, gamesNew, isFinalRound }) {
    // Final round consumes any combination of pairings/results into one
    // "Tournament Complete!" message — no separate final-recap needed since
    // it'd be functionally identical.
    if (resultsNew && isFinalRound) return 'final';
    if (pairingsNew && resultsNew) return 'recap';
    if (resultsNew) return 'results';
    if (pairingsNew) return 'pairings';
    if (gamesNew) return 'games';
    return null;
}

// Which signals each notification "consumes" — i.e., which KV state keys to
// write so subsequent ticks dedup correctly. `final` consumes both pairings
// and results so that, in the rare case where both arrive together on the
// final round, neither fires separately on a later tick.
export const KIND_CONSUMES = {
    pairings: ['pairings'],
    results: ['results'],
    games: ['games'],
    recap: ['pairings', 'results'],
    final: ['pairings', 'results'],
};

const STATE_KEY = { pairings: 'state:pairingsUp', results: 'state:resultsPosted', games: 'state:gamesPosted' };
const TRACK_KEY = { pairings: 'lastNotifiedPairings', results: 'lastNotifiedResults', games: 'lastNotifiedGames' };
const LEGACY_TRACK_KEY = { pairings: 'lastNotifiedRound', results: 'lastNotifiedResultsRound', games: 'lastNotifiedGamesRound' };
const SIGNAL_LETTER = { pairings: 'p', results: 'r', games: 'g' };

async function dispatchAllNotifications(parsed, tournament, env) {
    const slug = tournament.slug || slugifyTournament(tournament.name);
    const round = parsed?.roundNumber || (await env.SUBSCRIBERS.get('cache:appState', 'json'))?.round;
    if (!round) {
        console.log('No round number known, skipping notifications.');
        return;
    }
    const totalRounds = tournament.totalRounds || 0;
    const isFinalRound = totalRounds > 0 && round === totalRounds;

    // Legacy KV state had only {round} — treat a round-only match as same-
    // tournament for backward compat, so we don't re-fire on first post-deploy
    // cron tick (and don't lose suppression of yesterday's spurious dispatches).
    const stateMatches = (s) => s && s.round === round && (!s.tournamentSlug || s.tournamentSlug === slug);

    const [pairingsState, resultsState, gamesState] = await Promise.all([
        env.SUBSCRIBERS.get('state:pairingsUp', 'json'),
        env.SUBSCRIBERS.get('state:resultsPosted', 'json'),
        env.SUBSCRIBERS.get('state:gamesPosted', 'json'),
    ]);

    const pairingsNew = !!parsed?.hasPairings && !stateMatches(pairingsState);
    const resultsNew = !!parsed?.hasResults && !stateMatches(resultsState);
    const gamesNew = !stateMatches(gamesState) && (await isGamesReady(slug, round, env));

    const kind = selectNotificationKind({ pairingsNew, resultsNew, gamesNew, isFinalRound });
    if (!kind) {
        console.log(`Nothing new to notify for ${slug} r${round}.`);
        return;
    }

    const pushSubs = await listPushSubscriptions(env);
    const sections = parsed?.pairingsSections || [];
    const isInTournament = (record) =>
        !record.playerName || findPlayerPairingFromSections(sections, record.playerName) !== null;
    const buildPairingFor = (record) => record.playerName
        ? findPlayerPairingFromSections(sections, record.playerName)
        : null;
    const buildResultFor = (record) => record.playerName
        ? findPlayerResultFromSections(sections, record.playerName)
        : null;

    const consumed = KIND_CONSUMES[kind];
    const marks = consumed.map(sig => ({
        trackKey: TRACK_KEY[sig],
        trackValue: `${slug}:${SIGNAL_LETTER[sig]}:${round}`,
        legacyKey: LEGACY_TRACK_KEY[sig],
        legacyValue: round,
    }));

    const spec = buildNotificationSpec(kind, { round, tournament, parsed });
    let count = 0;
    try {
        count = await dispatchPushNotifications({
            subscribers: pushSubs,
            prefKey: spec.prefKey,
            marks,
            shouldNotify: spec.audienceAll ? () => true : isInTournament,
            buildPayload: (record) => {
                const pairing = buildPairingFor(record);
                const result = buildResultFor(record);
                return {
                    title: spec.title,
                    body: spec.body(pairing, result),
                    url: '/', type: kind, round,
                    expiresAt: spec.expiresAt,
                };
            },
            env, label: kind,
        });
    } catch (err) { console.error(`Push ${kind} dispatch error:`, err.message); }

    // Mark all consumed signals in KV state.
    const now = new Date().toISOString();
    await Promise.all(consumed.map(sig => env.SUBSCRIBERS.put(STATE_KEY[sig], JSON.stringify({
        round, tournamentSlug: slug, detectedAt: now, pushNotifiedCount: count, kind,
    }))));
    console.log(`Notified ${count} push subscriber(s) of ${kind} for ${slug} r${round}.`);
}

// COALESCE guards against SUM-of-empty-set returning NULL when the (slug,
// round) has no rows in games — without it, !== 0 would slip past the
// readiness gate and dispatch on a tournament that has no games yet.
export async function isGamesReady(slug, round, env) {
    const { totalGames, gamesWithPgn } = (await env.DB.prepare(
        `SELECT COUNT(*) as totalGames,
                COALESCE(SUM(CASE WHEN pgn IS NOT NULL AND pgn != '' THEN 1 ELSE 0 END), 0) as gamesWithPgn
         FROM games WHERE tournament_slug = ? AND round = ?`
    ).bind(slug, round).first()) || { totalGames: 0, gamesWithPgn: 0 };
    return !!gamesWithPgn && gamesWithPgn > totalGames / 2;
}

function buildNotificationSpec(kind, { round, tournament, parsed }) {
    const tournamentName = tournament?.name || 'Tuesday Night Marathon';
    const pairingsExpiry = pairingsExpiresAt(tournament.roundDates, round);
    const twelveHours = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const oneDay = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const twoDays = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    switch (kind) {
        case 'pairings':
            return {
                prefKey: 'notifyPairings',
                title: `Round ${round} Pairings Are Up!`,
                body: (pairing) => composeMessage(pairing, round),
                expiresAt: pairingsExpiry,
            };
        case 'results':
            return {
                prefKey: 'notifyResults',
                title: `Round ${round} Results Are In!`,
                body: (pairing, result) => composeResultsMessage(pairing, result, round),
                expiresAt: twelveHours,
            };
        case 'games':
            return {
                prefKey: 'notifyResults',
                audienceAll: true,
                title: `Round ${round} Games Are Up!`,
                body: () => composeGamesMessage(round),
                expiresAt: oneDay,
            };
        case 'recap':
            return {
                prefKey: 'notifyResults',
                title: `Round ${round} is in the books!`,
                body: (pairing, result) => composeRecapMessage(pairing, result, round),
                expiresAt: twelveHours,
            };
        case 'final':
            return {
                prefKey: 'notifyResults',
                title: `${tournamentName} is complete!`,
                body: (pairing, result) => composeFinalMessage(pairing, result, round, tournamentName),
                expiresAt: twoDays,
            };
        default:
            throw new Error(`Unknown notification kind: ${kind}`);
    }
}
