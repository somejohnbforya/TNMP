import { STATE, CONFIG, getTournamentMeta, getAppState } from './config.js';

// ─── Countdown (NO-state 60s ticker + off-season day/hour/min/sec) ─

let countdownSeconds = 60;
let countdownInterval = null;
let offSeasonInterval = null;

export function resetCountdown() {
    countdownSeconds = 60;
    updateCountdownDisplay();
}

export function updateCountdownDisplay() {
    const el = document.getElementById('countdown-time');
    const countdownContainer = document.getElementById('countdown');
    if (el) el.textContent = countdownSeconds;
    if (countdownContainer) {
        const shouldShow = getAppState().state === STATE.NO;
        countdownContainer.style.display = shouldShow ? 'block' : 'none';
    }
}

export function stopCountdown() {
    clearInterval(countdownInterval);
    countdownInterval = null;
}

export function startCountdown(checkPairings) {
    stopCountdown();
    resetCountdown();
    countdownInterval = setInterval(() => {
        if (getAppState().state !== STATE.NO) {
            stopCountdown();
            return;
        }
        countdownSeconds--;
        updateCountdownDisplay();
        if (countdownSeconds <= 0) {
            checkPairings();
            resetCountdown();
        }
    }, 1000);
}

export function startOffSeasonCountdown(targetDate) {
    stopOffSeasonCountdown();

    function render() {
        const el = document.getElementById('off-season-countdown');
        if (!el) return;

        const now = new Date();
        const diff = targetDate.getTime() - now.getTime();

        if (diff <= 0) {
            el.innerHTML = '<div class="off-season-countdown-label">Starting soon!</div>';
            stopOffSeasonCountdown();
            return;
        }

        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        el.innerHTML = `
            <div class="off-season-countdown-label">Next tournament starts in</div>
            <div class="off-season-countdown-units">
                ${days > 0 ? `<div class="countdown-unit"><span class="countdown-value">${days}</span><span class="countdown-label">day${days !== 1 ? 's' : ''}</span></div>` : ''}
                <div class="countdown-unit"><span class="countdown-value">${String(hours).padStart(2, '0')}</span><span class="countdown-label">hr</span></div>
                <div class="countdown-unit"><span class="countdown-value">${String(minutes).padStart(2, '0')}</span><span class="countdown-label">min</span></div>
                <div class="countdown-unit"><span class="countdown-value">${String(seconds).padStart(2, '0')}</span><span class="countdown-label">sec</span></div>
            </div>
        `;
    }

    render();
    offSeasonInterval = setInterval(render, 1000);
}

export function stopOffSeasonCountdown() {
    clearInterval(offSeasonInterval);
    offSeasonInterval = null;
}

// ─── Memes (card + caption, and texture inside the answer letters) ─

const MEME_DATA = {
    [STATE.TOO_EARLY]: {
        count: 5,
        captions: [
            'Patience, young grasshopper...',
            'Sir, this is not Monday night',
            "You're a bit early there, champ",
            'Whoa there, eager beaver!',
            "The pairings aren't even close to ready",
            'Come back Monday after 8pm!',
        ],
    },
    [STATE.NO]: {
        count: 11,
        captions: [
            'One does not simply post pairings on time',
            'Still waiting...',
            'Maybe next refresh?',
            'The pairings will be posted any minute now...',
            'Any second now...',
            'Refreshing intensifies',
        ],
    },
    [STATE.YES]: {
        count: 8,
        captions: [
            "IT'S HAPPENING!",
            "Time to see who I'm crushing tonight!",
            "Finally! Let's gooooo!",
            'Prepare yourselves... the pairings have arrived!',
            "The moment we've all been waiting for!",
            "LET'S GO!!!",
        ],
    },
    [STATE.IN_PROGRESS]: {
        count: 3,
        captions: [
            'The games are afoot!',
            'Chess is happening right now',
            'Battles are being waged as we speak',
            'Knights are jumping, bishops are sliding...',
        ],
    },
    [STATE.RESULTS]: {
        count: 9,
        captions: [
            'The results are in!',
            'Another week, another battle complete',
            'Check out how everyone did!',
            'Who crushed it? Who got crushed?',
            'The dust has settled...',
        ],
    },
};

export function getRandomMeme(state) {
    const data = MEME_DATA[state];
    if (!data) return null;
    const n = Math.floor(Math.random() * data.count) + 1;
    return {
        img: `memes/${state}_${n}.webp`,
        text: data.captions[Math.floor(Math.random() * data.captions.length)],
    };
}

// Color-first tint over the meme texture — state color dominates, the
// meme reads as a faint image inside the glyphs (design: meme-letters).
const STATE_TINT = {
    [STATE.YES]: '#5dd67c',
    [STATE.NO]: '#ef4f5e',
    [STATE.IN_PROGRESS]: '#6fb3f2',
    [STATE.RESULTS]: '#9ec5ff',
    [STATE.TOO_EARLY]: '#c77fd6',
    [STATE.OFF_SEASON]: '#9dc183',
};

/** Set the state class on <html>, preserving the tnmp and dark-mode classes. */
function setHtmlClass(stateClass) {
    const dark = document.documentElement.classList.contains('dark-mode');
    document.documentElement.className = `tnmp${dark ? ' dark-mode' : ''} ${stateClass}`;
}

const esc = (s) =>
    String(s ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

const surname = (name) => (name || '').trim().split(/\s+/).pop() || '';

const PIECE_ICON = { White: 'wK', Black: 'bK' };
const pieceImg = (color, size = 22, cls = '') =>
    `<img class="${cls}" src="pieces/default/${PIECE_ICON[color]}.svg" alt="${color}" width="${size}" height="${size}">`;
const duckImg = (size = 22, cls = '') =>
    `<img class="${cls}" src="pieces/Duck.svg" alt="Bye" width="${size}" height="${size}">`;

const fmtPacific = (iso, opts) =>
    iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', ...opts }) : '';
const fmtDay = (iso) => fmtPacific(iso, { month: 'short', day: 'numeric' });
const fmtTime = (iso) => fmtPacific(iso, { hour: 'numeric', minute: '2-digit' });

// ─── Fluid answer (FitText) ────────────────────────────────────────
//
// The answer renders as an SVG <text> whose viewBox is fit to the glyph
// bbox, so the word always spans the container at any length ("YES",
// "ROUND 12", "COMPLETE") with no JS resize handling. Dark mode fills
// with the state tint; gradient (light) mode with white.

let _lastAnswer = null; // re-render on theme toggle

function renderAnswer(text, state) {
    const el = document.getElementById('answer');
    if (!el) return;
    _lastAnswer = { text, state };

    const dark = document.documentElement.classList.contains('dark-mode');
    const fill = dark ? STATE_TINT[state] || '#9e9e9e' : '#ffffff';

    el.innerHTML = `
        <svg class="answer-svg" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            <text x="0" y="0" font-weight="900" font-size="200" letter-spacing="-9" fill="${fill}">${esc(text)}</text>
        </svg>
        <span class="visually-hidden">${esc(text)}</span>
    `;

    const svg = el.querySelector('svg');
    const textEl = svg.querySelector('text');
    const fit = () => {
        if (!svg.isConnected) return;
        const bb = textEl.getBBox();
        if (!bb.width) return;
        // getBBox height is the full em box (ascent+descent padding).
        // Answers are all caps/digits, so crop to cap height above the
        // baseline (y=0) plus a hair of round-glyph overshoot.
        const cap = 146; // Geist cap height at font-size 200
        const over = 4;
        svg.setAttribute('viewBox', `${bb.x} ${-cap - over} ${bb.width} ${cap + over * 2}`);
    };
    fit();
    // Re-measure once webfonts land — the first pass may size with a fallback.
    document.fonts?.ready.then(fit);
}

// Theme toggles (style panel) swap between tinted and white letters.
if (typeof window !== 'undefined') {
    window.addEventListener('tnmp-theme-change', () => {
        if (_lastAnswer) renderAnswer(_lastAnswer.text, _lastAnswer.state);
    });
}

// --- Public API ---

export function updateTournamentLink() {
    const link = document.querySelector('.footer a[target="_blank"]');
    if (!link) return;
    const meta = getTournamentMeta();
    if (meta.url) link.href = meta.url;
    if (meta.name) link.textContent = `View ${meta.name}`;
}

function updateTopbar(state) {
    const ctxEl = document.getElementById('home-context');
    const liveEl = document.getElementById('home-live');
    if (ctxEl) {
        const name = getTournamentMeta().name || 'Tuesday Night Marathon';
        ctxEl.textContent = name.replace(/Tuesday Night Marathon/i, 'TNM');
    }
    if (liveEl) liveEl.classList.toggle('hidden', state !== STATE.YES && state !== STATE.IN_PROGRESS);
}

export function showLoading() {
    setHtmlClass('loading-state');
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('result').classList.add('hidden');
    document.getElementById('check-btn').disabled = true;
    updateTopbar(null);
}

const STATE_CONFIG = {
    [STATE.YES]: { className: 'yes', answer: 'YES', buttonText: 'View Pairings', buttonHash: '#Pairings' },
    [STATE.NO]: { className: 'no', answer: 'NO', buttonText: 'Check Again', buttonHash: null },
    [STATE.TOO_EARLY]: { className: 'too-early', answer: 'CHILL', buttonText: 'Check Again', buttonHash: null },
    [STATE.IN_PROGRESS]: {
        className: 'in-progress',
        answer: () => `ROUND ${getAppState().round}`,
        buttonText: 'Check Again',
        buttonHash: null,
    },
    [STATE.RESULTS]: { className: 'results', answer: 'COMPLETE', buttonText: 'View Results', buttonHash: '#Standings' },
    [STATE.OFF_SEASON]: { className: 'off-season', answer: 'REST', buttonText: 'View Tournament Info', buttonHash: '' },
};

export function showState(state, info, offSeasonData = null) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('result').classList.remove('hidden');
    document.getElementById('check-btn').disabled = false;

    const config = STATE_CONFIG[state];
    setHtmlClass(config.className);
    updateTopbar(state);

    renderAnswer(typeof config.answer === 'function' ? config.answer() : config.answer, state);

    const meme = getRandomMeme(state);
    const memeEl = document.getElementById('meme');
    if (meme) {
        memeEl.innerHTML = `
            <img src="${meme.img}" alt="" role="presentation">
            <p class="meme-text">${esc(meme.text)}</p>
        `;
        memeEl.classList.remove('hidden');
        const img = memeEl.querySelector('img');
        img.addEventListener('error', () => {
            img.style.display = 'none';
        });
    } else {
        memeEl.innerHTML = '';
        memeEl.classList.add('hidden');
    }

    stopOffSeasonCountdown();

    const extraEl = document.getElementById('home-extra');
    if (state === STATE.OFF_SEASON) {
        if (offSeasonData?.targetDate) {
            extraEl.innerHTML = `<div class="off-season-countdown" id="off-season-countdown"></div>`;
            startOffSeasonCountdown(new Date(offSeasonData.targetDate));
        } else {
            extraEl.innerHTML = '';
        }
        // Hide the player panels — off-season has no rounds or pairing.
        document.getElementById('tracker-section')?.classList.add('hidden');
        document.getElementById('pairing-section')?.classList.add('hidden');
    } else {
        extraEl.innerHTML = '';
    }

    document.getElementById('round-info').textContent = info || '';

    // Button
    const btn = document.getElementById('check-btn');
    const linkUrl = getTournamentMeta().url;
    const hasLink = config.buttonHash !== null && linkUrl;
    btn.textContent = hasLink ? config.buttonText : 'Check Again';
    btn.onclick = hasLink ? () => window.open(linkUrl + config.buttonHash, '_blank') : null;

    updateCountdownDisplay();
}

export function hideOfflineBanner() {
    const banner = document.getElementById('offline-banner');
    if (banner) banner.classList.remove('show');
}

// ─── Round Tracker (scoreboard bar + expanded detail) ──────────────

const CELL_CLASS = { W: 'tb-w', L: 'tb-l', D: 'tb-d', B: 'tb-bye', H: 'tb-bye', U: 'tb-bye' };

const RESULT_VERB = {
    W: { label: 'You won', cls: 'td-verb-w' },
    L: { label: 'You lost', cls: 'td-verb-l' },
    D: { label: 'You drew', cls: 'td-verb-d' },
};

const BYE_LABEL = { full: 'Full-point bye', half: 'Half-point bye', zero: 'Zero-point bye' };

/** Score summary through the current round: W/B=1, D/H=½, L/U=0.
 *  Byes committed for FUTURE rounds don't count until their round
 *  arrives — 2½/5 this week becomes 3/6 next week, not 3½/7 today. */
export function playerScore(rounds, currentRound = Infinity) {
    let score = 0;
    let played = 0;
    for (const [n, r] of Object.entries(rounds || {})) {
        if (Number(n) > currentRound || !r?.result) continue;
        played++;
        if (r.result === 'W' || r.result === 'B') score += 1;
        else if (r.result === 'D' || r.result === 'H') score += 0.5;
    }
    return { score, played };
}

const fmtScore = (n) => {
    const whole = Math.floor(n);
    const half = n - whole >= 0.5;
    if (half) return whole === 0 ? '½' : `${whole}½`;
    return String(whole);
};

/** One tracker cell per round. Pure: data in, HTML out. */
export function buildTrackerCellsHtml(rounds, totalRounds, currentRound, state, selectedRound) {
    const isLiveNext = state === STATE.YES || state === STATE.IN_PROGRESS;
    let html = '';
    for (let i = 1; i <= totalRounds; i++) {
        const r = rounds[i];
        const played = !!r?.result;
        const isLive = i === currentRound && isLiveNext;
        const clickable = played || (r && i === currentRound);
        const cls = [
            'tracker-cell',
            played ? CELL_CLASS[r.result] || 'tb-d' : 'tb-x',
            i === selectedRound ? 'tb-selected' : '',
            isLive ? 'tb-live' : '',
        ]
            .filter(Boolean)
            .join(' ');
        let content;
        if (r?.isBye) content = duckImg(22, 'tb-piece');
        else if (r?.color) content = pieceImg(r.color, 22, 'tb-piece');
        else if (isLive) content = '<span class="tb-live-dot" aria-hidden="true"></span>';
        else content = '<span class="tb-future-dot" aria-hidden="true">·</span>';
        html += `
            <button type="button" class="${cls}" data-round="${i}" ${clickable ? 'data-clickable' : 'disabled'}
                aria-label="Round ${i}">
                <span class="tb-num" aria-hidden="true">${i}</span>${content}
            </button>
        `;
    }
    return html;
}

/** Expanded card for the selected round. Pure: data in, HTML out. */
export function buildTrackerDetailHtml(roundNum, r, roundDates, state) {
    if (!r) return '';
    const meta = `Round ${roundNum}${r.board ? ` · Board ${r.board}` : ''}`;
    const date = fmtDay(roundDates?.[roundNum - 1]);

    if (r.isBye) {
        return `
            <div class="tracker-detail-card">
                <button type="button" class="td-close" data-action="tracker-close" aria-label="Close">✕</button>
                <div class="td-meta">${esc(meta)}</div>
                <div class="td-verb td-verb-d">${BYE_LABEL[r.byeType] || 'Bye'}</div>
                <div class="td-opp">${duckImg(22, 'td-piece')}<span class="td-opp-sub">${esc(date)}</span></div>
            </div>
        `;
    }

    const verb = RESULT_VERB[r.playerResult || r.result];
    const isLiveRound = !r.result && (state === STATE.YES || state === STATE.IN_PROGRESS);
    const verbHtml = verb
        ? `<div class="td-verb ${verb.cls}">${verb.label}</div>`
        : isLiveRound
          ? `<div class="td-verb td-verb-d">Playing tonight</div>`
          : '';
    const oppColor = r.color === 'White' ? 'Black' : 'White';
    const rating = r.opponentRating ? `${r.opponentRating}` : '';
    const sub = [rating, date].filter(Boolean).join(' · ');
    const gameBtn =
        r.gameId && r.result
            ? `<button type="button" class="view-game-btn" data-action="view-tracker-game" data-game-id="${esc(r.gameId)}">View Game →</button>`
            : '';

    return `
        <div class="tracker-detail-card">
            <button type="button" class="td-close" data-action="tracker-close" aria-label="Close">✕</button>
            <div class="td-meta">${esc(meta)}</div>
            ${verbHtml}
            <div class="td-opp">
                ${pieceImg(oppColor, 22, 'td-piece')}
                <div class="td-opp-text">
                    <button type="button" class="td-opp-name" data-action="open-profile" data-name="${esc(r.opponent || '')}">${esc(r.opponent || 'Unknown')}</button>
                    <div class="td-opp-sub">${esc(sub)}</div>
                </div>
            </div>
            ${gameBtn}
        </div>
    `;
}

/** Split pairing pill: [you · rating · piece | VS | piece · opp · rating]. */
export function buildPairingPillHtml(pairing, playerName, playerRating, roundNum, roundDates) {
    const time = fmtTime(roundDates?.[roundNum - 1]);
    const metaRow = `
        <div class="pairing-meta">
            <span>Round ${roundNum}${pairing.board ? ` · Board ${pairing.board}` : ''}</span>
            <span>${esc(time)}</span>
        </div>
    `;

    if (pairing.isBye) {
        return `
            ${metaRow}
            <div class="pairing-pill pairing-pill-bye">
                ${duckImg(26, 'pp-piece')}
                <span class="pp-bye-label">${BYE_LABEL[pairing.byeType] || 'Bye'}</span>
            </div>
        `;
    }

    const youColor = pairing.color;
    const oppColor = youColor === 'White' ? 'Black' : 'White';
    return `
        ${metaRow}
        <div class="pairing-pill">
            <div class="pp-side pp-you" title="${esc(playerName)}">
                <div class="pp-info">
                    <div class="pp-name">${esc(surname(playerName))}</div>
                    ${playerRating ? `<div class="pp-rating">${esc(playerRating)}</div>` : ''}
                </div>
                ${pieceImg(youColor, 26, 'pp-piece')}
            </div>
            <div class="pp-seam" aria-hidden="true">VS</div>
            <div class="pp-side pp-opp" title="${esc(pairing.opponent)}">
                ${pieceImg(oppColor, 26, 'pp-piece')}
                <div class="pp-info">
                    <button type="button" class="pp-name pp-name-link" data-action="open-profile" data-name="${esc(pairing.opponent || '')}">${esc(surname(pairing.opponent))}</button>
                    ${pairing.opponentRating ? `<div class="pp-rating">${esc(pairing.opponentRating)}</div>` : ''}
                </div>
            </div>
        </div>
    `;
}

/** Final-standings summary pill: W / D / L counts. */
export function buildResultsPillHtml(rounds, totalRounds) {
    const all = Object.values(rounds || {});
    const wins = all.filter((r) => r.result === 'W').length;
    const draws = all.filter((r) => r.result === 'D').length;
    const losses = all.filter((r) => r.result === 'L').length;
    return `
        <div class="pairing-meta">
            <span>Final · ${totalRounds} rounds</span>
            <span></span>
        </div>
        <div class="results-pill">
            <div class="rp-seg rp-w"><span class="rp-num">${wins}</span><span class="rp-label">Wins</span></div>
            <div class="rp-seg rp-d"><span class="rp-num">${draws}</span><span class="rp-label">Draws</span></div>
            <div class="rp-seg rp-l"><span class="rp-num">${losses}</span><span class="rp-label">Losses</span></div>
        </div>
    `;
}

let _lastTracker = null;

export function renderRoundTracker(rounds, totalRounds, currentRound, currentState, selectedRound = null) {
    const section = document.getElementById('tracker-section');
    const container = document.getElementById('round-tracker');
    if (!section || !container) return;

    if (!rounds || !Object.keys(rounds).length) {
        section.classList.add('hidden');
        document.getElementById('pairing-section')?.classList.add('hidden');
        return;
    }

    _lastTracker = { rounds, totalRounds, currentRound, currentState };
    section.classList.remove('hidden');

    // Meta row: player identity (tap → own profile) + running score
    const playerEl = document.getElementById('tracker-player');
    const scoreEl = document.getElementById('tracker-score');
    const ratings = Object.values(rounds)
        .filter((r) => r.ownRating)
        .map((r) => r.ownRating);
    const rating = ratings.length ? ratings[ratings.length - 1] : null;
    if (playerEl) {
        const first = (CONFIG.playerName || '').split(/\s+/)[0];
        playerEl.textContent = rating ? `${first} · ${rating}` : first;
        playerEl.dataset.name = CONFIG.playerName || '';
        playerEl.title = 'View your profile';
    }
    if (scoreEl) {
        const { score, played } = playerScore(rounds, currentRound);
        scoreEl.innerHTML = played ? `<b>${fmtScore(score)}</b> / ${played}` : '';
    }

    container.innerHTML = buildTrackerCellsHtml(rounds, totalRounds, currentRound, currentState, selectedRound);
    container.dataset.active = selectedRound || '';

    const detailEl = document.getElementById('tracker-expanded');
    if (detailEl) {
        const meta = getTournamentMeta();
        detailEl.innerHTML = selectedRound
            ? buildTrackerDetailHtml(selectedRound, rounds[selectedRound], meta.roundDates, currentState)
            : '';
    }

    renderPairingPill(rounds, totalRounds, currentRound, currentState);
}

function renderPairingPill(rounds, totalRounds, currentRound, state) {
    const el = document.getElementById('pairing-section');
    if (!el) return;

    const pairing = getAppState().pairing;
    const meta = getTournamentMeta();
    const isFinal = state === STATE.RESULTS && totalRounds > 0 && currentRound >= totalRounds;

    if (isFinal) {
        el.innerHTML = buildResultsPillHtml(rounds, totalRounds);
        el.classList.remove('hidden');
    } else if (pairing && (state === STATE.YES || state === STATE.IN_PROGRESS)) {
        const ratings = Object.values(rounds)
            .filter((r) => r.ownRating)
            .map((r) => r.ownRating);
        const rating = ratings.length ? ratings[ratings.length - 1] : null;
        el.innerHTML = buildPairingPillHtml(pairing, CONFIG.playerName || 'You', rating, currentRound, meta.roundDates);
        el.classList.remove('hidden');
    } else {
        el.innerHTML = '';
        el.classList.add('hidden');
    }
}

// Cell click → expand round; ✕ → collapse. (Static container in HTML.)
if (typeof document !== 'undefined') {
    document.getElementById('tracker-section')?.addEventListener('click', (e) => {
        if (!_lastTracker) return;
        const { rounds, totalRounds, currentRound, currentState } = _lastTracker;
        const closeBtn = e.target.closest('[data-action="tracker-close"]');
        const cell = e.target.closest('.tracker-cell[data-clickable]');
        if (!closeBtn && !cell) return;
        const active = document.getElementById('round-tracker')?.dataset.active;
        const next = closeBtn || (cell && cell.dataset.round === active) ? null : Number(cell.dataset.round);
        renderRoundTracker(rounds, totalRounds, currentRound, currentState, next);
    });
}

export function showError(message) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('result').classList.remove('hidden');
    document.getElementById('check-btn').disabled = false;

    setHtmlClass('no');
    updateTopbar(null);
    renderAnswer('???', null);
    document.getElementById('home-extra').innerHTML = `
        <p class="home-error">Couldn't check the page. Maybe try opening it directly?</p>
        <p class="home-error home-error-small">${esc(message)}</p>
    `;
    document.getElementById('round-info').textContent = '';
}
