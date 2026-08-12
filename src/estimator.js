/**
 * Rating estimator — a US Chess rating calculator that pre-loads the
 * current tournament from the standings cache. Pick a player and their
 * played rounds arrive with opponent ratings and results filled in;
 * every field stays editable, and hypothetical rounds can be added to
 * ask "what if I win next week?". Math lives in rating-calc.js.
 */

import { CONFIG } from './config.js';
import { openModal } from './modal.js';
import { prefetchStandings, stripTitle, nameKey } from './standings.js';
import { estimateRating } from './rating-calc.js';

// Blank "prior games" means an established player; 50 saturates the
// effective-games cap so it behaves as "fully established".
const ESTABLISHED_N = 50;

let _data = null; // /standings payload, or null when unavailable
let _rows = []; // [{ round, opponent, oppRating, score }] score: 1|0.5|0|null
let _skipped = 0; // byes/forfeits dropped during pre-load (not rated)

const esc = (s) =>
    String(s ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

// ─── Pre-load from standings ─────────────────────────────────────────

function resultToScore(result) {
    if (result === 'W') return 1;
    if (result === 'D') return 0.5;
    if (result === 'L') return 0;
    return null; // byes (B/H/U) and forfeits (X/F) are not rated
}

function loadPlayer(si, pi) {
    const sec = _data?.sections[si];
    const p = sec?.players[pi];
    if (!p) return;

    const byRank = new Map(sec.players.map((o) => [o.rank, o]));
    _rows = [];
    _skipped = 0;
    p.rounds.forEach((r, i) => {
        if (!r) return;
        const score = resultToScore(r.result);
        const opp = r.opponentRank != null ? byRank.get(r.opponentRank) : null;
        if (score === null || !opp) {
            _skipped++;
            return;
        }
        _rows.push({ round: i + 1, opponent: stripTitle(opp.name), oppRating: opp.rating, score });
    });

    document.getElementById('est-rating').value = p.rating ?? '';
    document.getElementById('est-prior').value = p.rating == null ? 0 : '';
    document.getElementById('est-floor').value = '';
    updateFloorHint(p);
    render();
}

// US Chess publishes each member's floor (including money-prize and
// Life Master floors we could never derive) on their MUIR player page,
// so the hint links straight to the selected player's page.
function updateFloorHint(p) {
    const hint = document.getElementById('est-floor-hint');
    const id = p?.id && /^\d+$/.test(p.id) ? p.id : null;
    const lookup = id
        ? `<a href="https://ratings.uschess.org/player/${id}" target="_blank" rel="noopener">${esc(stripTitle(p.name))}'s US Chess page</a>`
        : 'the US Chess member page';
    hint.innerHTML = `Floor: check ${lookup} — usually peak rating − 200; leave blank if none.`;
}

function findTracked() {
    if (!_data || !CONFIG.playerName) return null;
    const key = nameKey(CONFIG.playerName);
    for (let si = 0; si < _data.sections.length; si++) {
        const pi = _data.sections[si].players.findIndex((p) => nameKey(p.name) === key);
        if (pi !== -1) return { si, pi };
    }
    return null;
}

// ─── Rendering ───────────────────────────────────────────────────────

function segBtn(row, idx, score, label) {
    const on = row.score === score;
    return `<button type="button" class="est-seg-btn${on ? ' est-seg-on' : ''}" data-est-score="${score}" data-est-idx="${idx}" aria-pressed="${on}">${label}</button>`;
}

function renderRows() {
    const body = document.getElementById('est-rows');
    if (_rows.length === 0) {
        body.innerHTML = '<p class="est-empty">No games yet — add one below.</p>';
        return;
    }
    body.innerHTML = _rows
        .map(
            (row, i) => `
        <div class="est-row">
            <span class="est-row-round">R${row.round}</span>
            <span class="est-row-opp">${row.opponent ? esc(row.opponent) : '<span class="est-row-anon">anyone</span>'}</span>
            <input type="number" class="est-row-rating" data-est-idx="${i}" value="${row.oppRating ?? ''}" min="100" max="3000" placeholder="rating" aria-label="Opponent rating, round ${row.round}">
            <div class="est-seg" role="group" aria-label="Result, round ${row.round}">
                ${segBtn(row, i, 1, 'W')}${segBtn(row, i, 0.5, 'D')}${segBtn(row, i, 0, 'L')}
            </div>
            <button type="button" class="est-row-del" data-est-del="${i}" aria-label="Remove round ${row.round}">&times;</button>
        </div>`,
        )
        .join('');
}

function compute() {
    const out = document.getElementById('est-result');
    const ratingRaw = document.getElementById('est-rating').value.trim();
    const priorRaw = document.getElementById('est-prior').value.trim();

    // Blank rating = first-timer: no prior games, the seed only labels
    // the form (the special algorithm ignores it when N' is 0).
    const unrated = ratingRaw === '';
    const r0 = unrated ? 1300 : parseInt(ratingRaw, 10);
    const prior = unrated ? 0 : priorRaw === '' ? ESTABLISHED_N : Math.max(0, parseInt(priorRaw, 10) || 0);
    const floorRaw = parseInt(document.getElementById('est-floor').value, 10);
    const floor = Number.isFinite(floorRaw) ? floorRaw : 100;

    const res = Number.isFinite(r0) ? estimateRating(r0, prior, _rows, floor) : null;
    if (!res) {
        out.innerHTML = '<p class="est-empty">Enter results above to see an estimate.</p>';
        return;
    }

    const rounded = Math.round(res.rating);
    const change = unrated ? null : res.rating - r0;
    const changeHtml =
        change === null
            ? '<span class="est-result-badge">first rating</span>'
            : `<span class="est-result-change ${change >= 0 ? 'est-up' : 'est-down'}">${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}</span>`;
    const scored = _rows.reduce((s, g) => s + (g.score ?? 0), 0);
    const detail =
        (res.provisional
            ? `provisional formula · scored ${scored} of ${_rows.length} · expected ${res.expected.toFixed(2)}`
            : `scored ${scored} of ${_rows.length} · expected ${res.expected.toFixed(2)} · K ${res.k.toFixed(1)}` +
              (res.bonus > 0 ? ` · bonus +${res.bonus.toFixed(1)}` : '')) +
        (res.floored ? ` · held at floor ${floor} (unfloored ${Math.round(res.rawRating)})` : '');

    out.innerHTML = `
        <div class="est-result-main">
            <span class="est-result-rating">${rounded}</span>
            ${changeHtml}
        </div>
        <p class="est-result-detail">${detail}</p>`;
}

function render() {
    renderRows();
    const note = document.getElementById('est-skip-note');
    note.classList.toggle('hidden', _skipped === 0);
    compute();
}

// ─── Setup ───────────────────────────────────────────────────────────

function buildPlayerSelect() {
    const select = document.getElementById('est-player');
    const wrap = document.getElementById('est-player-group');
    if (!_data) {
        wrap.classList.add('hidden');
        return;
    }
    wrap.classList.remove('hidden');
    const groups = _data.sections
        .map(
            (sec, si) =>
                `<optgroup label="${esc(sec.section)}">` +
                sec.players
                    .map(
                        (p, pi) =>
                            `<option value="${si}:${pi}">${esc(p.name)}${p.rating ? ` (${p.rating})` : ''}</option>`,
                    )
                    .join('') +
                '</optgroup>',
        )
        .join('');
    select.innerHTML = `<option value="">Choose a player…</option>${groups}`;
}

export async function openEstimator() {
    const data = await prefetchStandings();
    _data = data?.sections?.length ? data : null;
    buildPlayerSelect();

    const tracked = findTracked();
    if (tracked) {
        document.getElementById('est-player').value = `${tracked.si}:${tracked.pi}`;
        loadPlayer(tracked.si, tracked.pi);
    } else {
        _rows = [];
        _skipped = 0;
        document.getElementById('est-rating').value = '';
        document.getElementById('est-prior').value = '';
        document.getElementById('est-floor').value = '';
        updateFloorHint(null);
        render();
    }
    openModal('estimator-modal');
}

export function initEstimator(mount) {
    mount.innerHTML = `
        <div id="estimator-modal" class="modal hidden" role="dialog" aria-labelledby="estimator-title" aria-modal="true">
            <div class="modal-backdrop"></div>
            <div class="modal-content modal-content-scrollable estimator-modal-content">
                <button data-close-modal class="style-close-btn" aria-label="Close">&times;</button>
                <h2 id="estimator-title" class="est-title">Rating Estimator</h2>
                <div id="est-player-group" class="setting-group hidden">
                    <label for="est-player">Load a player's results</label>
                    <select id="est-player" class="est-select"></select>
                </div>
                <div class="est-inputs">
                    <div class="setting-group">
                        <label for="est-rating">Rating</label>
                        <input type="number" id="est-rating" min="100" max="3000" placeholder="unrated">
                    </div>
                    <div class="setting-group">
                        <label for="est-prior">Prior games</label>
                        <input type="number" id="est-prior" min="0" max="999" placeholder="25+">
                    </div>
                    <div class="setting-group">
                        <label for="est-floor">Floor</label>
                        <input type="number" id="est-floor" min="100" max="2200" placeholder="none">
                    </div>
                </div>
                <p class="setting-hint">Leave games blank if established. 8 or fewer uses the provisional formula, like the official estimator.</p>
                <p id="est-floor-hint" class="setting-hint"></p>
                <div id="est-rows" class="est-rows"></div>
                <p id="est-skip-note" class="setting-hint hidden">Byes and forfeits aren't rated, so they were left out.</p>
                <button type="button" id="est-add" class="modal-btn modal-btn-secondary modal-btn-small">+ Add a game</button>
                <div id="est-result" class="est-result raised-panel"></div>
                <p class="setting-hint est-footnote">First-pass estimate per the US Chess rating system (July 2025 revision, bonus threshold 10). Multi-pass recalculation is not modeled.</p>
            </div>
        </div>`;

    mount.addEventListener('click', (e) => {
        const seg = e.target.closest('[data-est-score]');
        if (seg) {
            _rows[+seg.dataset.estIdx].score = parseFloat(seg.dataset.estScore);
            render();
            return;
        }
        const del = e.target.closest('[data-est-del]');
        if (del) {
            _rows.splice(+del.dataset.estDel, 1);
            render();
            return;
        }
        if (e.target.id === 'est-add') {
            const next = _rows.reduce((max, r) => Math.max(max, r.round), 0) + 1;
            _rows.push({ round: next, opponent: null, oppRating: null, score: null });
            render();
            mount.querySelector('.est-row:last-child .est-row-rating')?.focus();
        }
    });

    mount.addEventListener('input', (e) => {
        if (e.target.classList.contains('est-row-rating')) {
            const v = parseInt(e.target.value, 10);
            _rows[+e.target.dataset.estIdx].oppRating = Number.isFinite(v) ? v : null;
        }
        compute();
    });

    mount.addEventListener('change', (e) => {
        if (e.target.id !== 'est-player' || !e.target.value) return;
        const [si, pi] = e.target.value.split(':').map(Number);
        loadPlayer(si, pi);
    });
}
