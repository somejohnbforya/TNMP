// GIF Maker — paste a PGN, configure board look, generate a shareable GIF.
// Renderer (Rabbit) + encoder (gifenc) land in a follow-up; UI is wired ahead.

import { openModal } from './modal.js';
import { splitPgn, extractMoveText, parseMoveText } from './pgn-parser.js';
import {
    PIECE_THEMES,
    BOARD_PRESETS,
    initDropdown,
    buildPieceMenu,
    buildBoardMenu,
    piecePreviewHtml,
    boardSwatchHtml,
} from './style.js';
import { Chess } from 'chess.js';
import { GIFEncoder, applyPalette } from 'gifenc';

// ─── State ────────────────────────────────────────────────────────

const state = {
    pgn: '',
    fens: [], // computed FEN per ply, including starting position at index 0
    lastMoves: [], // [{from, to}] aligned to fens; lastMoves[i] is the move that produced fens[i]
    currentFrame: 0,
    options: {
        pieceTheme: 'default',
        boardLight: '#dee3e6',
        boardDark: '#8ca2ad',
        flip: false,
        timing: 'medium', // 'fast' | 'medium' | 'slow' | 'custom'
        customMs: 600,
        finalFrameHold: false,
    },
    generating: false,
};

const TIMING_MS = { fast: 200, medium: 600, slow: 1500 };

function getDelayMs() {
    return state.options.timing === 'custom' ? state.options.customMs : TIMING_MS[state.options.timing];
}

// ─── DOM refs (resolved on init) ──────────────────────────────────

let dom = null;

function resolveDom() {
    dom = {
        modal: document.getElementById('gif-maker-modal'),
        pgnInput: document.getElementById('gif-pgn-input'),
        pgnStatus: document.getElementById('gif-pgn-status'),
        piecesDropdown: document.getElementById('gif-pieces-dropdown'),
        boardDropdown: document.getElementById('gif-board-dropdown'),
        light: document.getElementById('gif-board-light'),
        dark: document.getElementById('gif-board-dark'),
        previewPane: document.getElementById('gif-preview-pane'),
        preview: document.getElementById('gif-preview'),
        scrubber: document.getElementById('gif-scrubber'),
        frameCur: document.getElementById('gif-frame-current'),
        frameTotal: document.getElementById('gif-frame-total'),
        timing: document.getElementById('gif-timing-options'),
        customMs: document.getElementById('gif-timing-custom-ms'),
        flip: document.getElementById('gif-flip-board'),
        finalHold: document.getElementById('gif-final-hold'),
        generateBtn: document.getElementById('gif-generate-btn'),
        progress: document.getElementById('gif-progress'),
        progressFill: document.getElementById('gif-progress-fill'),
        progressTxt: document.getElementById('gif-progress-text'),
        result: document.getElementById('gif-result'),
        resultImg: document.getElementById('gif-result-img'),
        download: document.getElementById('gif-download-btn'),
        regen: document.getElementById('gif-regen-btn'),
    };
}

// Trigger refreshers (local to gif-maker so they update the gif-maker dropdowns,
// not the style modal's).
function refreshPiecesTrigger() {
    const themeId = state.options.pieceTheme;
    const theme = PIECE_THEMES.find((t) => t.id === themeId) || PIECE_THEMES[0];
    dom.piecesDropdown.querySelector('.style-dropdown-trigger').innerHTML =
        `<span class="style-piece-row">${piecePreviewHtml(themeId)}</span>
         <span class="style-dropdown-label">${theme.name}</span>
         <span class="style-dropdown-arrow">▾</span>`;
}
function refreshBoardTrigger() {
    const { boardLight, boardDark } = state.options;
    const preset = BOARD_PRESETS.find(
        (p) => p.light.toLowerCase() === boardLight.toLowerCase() && p.dark.toLowerCase() === boardDark.toLowerCase(),
    );
    const name = preset ? preset.name : 'Custom';
    dom.boardDropdown.querySelector('.style-dropdown-trigger').innerHTML =
        `${boardSwatchHtml(boardLight, boardDark, preset?.pattern)}
         <span class="style-dropdown-label">${name}</span>
         <span class="style-dropdown-arrow">▾</span>`;
}

// Swap the stage between the live preview and the generated result.
function showStage(mode) {
    dom.previewPane.classList.toggle('hidden', mode !== 'preview');
    dom.result.classList.toggle('hidden', mode !== 'result');
}

// ─── PGN handling ─────────────────────────────────────────────────

function loadPgn(text) {
    state.pgn = text;
    state.fens = [];
    state.lastMoves = [];

    if (!text.trim()) {
        setStatus('', '');
        updateScrubber();
        renderPreview();
        return;
    }

    let games;
    try {
        games = splitPgn(text);
    } catch (e) {
        setStatus(`✗ Parse failed: ${e.message}`, 'error');
        updateScrubber();
        return;
    }
    if (!games.length) {
        setStatus('✗ No games found in input', 'error');
        updateScrubber();
        return;
    }

    // Use the first game. Multi-game PGNs are a future feature.
    const moves = parseMoveText(extractMoveText(games[0]));

    const chess = new Chess();
    state.fens.push(chess.fen());
    state.lastMoves.push(null);
    let played = 0;
    for (const { san } of moves) {
        let move;
        try {
            move = chess.move(san);
        } catch {
            break;
        }
        if (!move) break;
        state.fens.push(chess.fen());
        state.lastMoves.push({ from: move.from, to: move.to });
        played++;
    }

    state.currentFrame = state.fens.length - 1; // jump to last position
    setStatus(`✓ ${played} move${played === 1 ? '' : 's'} loaded`, 'ok');
    updateScrubber();
    renderPreview();
    updateGenerateBtn();
}

function setStatus(text, cls) {
    dom.pgnStatus.textContent = text;
    dom.pgnStatus.className = `gif-pgn-status ${cls}`.trim();
}

// ─── Scrubber ─────────────────────────────────────────────────────

function updateScrubber() {
    const total = state.fens.length;
    const max = Math.max(0, total - 1);
    dom.scrubber.max = max;
    dom.scrubber.value = state.currentFrame;
    dom.scrubber.disabled = total === 0;
    dom.frameCur.textContent = total === 0 ? 0 : state.currentFrame;
    dom.frameTotal.textContent = max;
}

// ─── Preview (placeholder until Rabbit lands) ─────────────────────

// Placeholder preview — squares + last-move highlight. Pieces come with Rabbit.
function renderPreview() {
    const { boardLight, boardDark, flip } = state.options;
    const squares = [];
    for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
            const light = (r + f) % 2 === 0;
            const x = f;
            const y = flip ? 7 - r : r;
            squares.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${light ? boardLight : boardDark}"/>`);
        }
    }

    // Last-move highlight, if known for the current frame.
    const lm = state.lastMoves[state.currentFrame];
    let highlight = '';
    if (lm) {
        for (const sq of [lm.from, lm.to]) {
            const f = sq.charCodeAt(0) - 97;
            const r = 8 - parseInt(sq[1], 10);
            const x = flip ? 7 - f : f;
            const y = flip ? 7 - r : r;
            highlight += `<rect x="${x}" y="${y}" width="1" height="1" fill="rgba(255,255,100,0.40)"/>`;
        }
    }

    dom.preview.innerHTML = `
        <svg viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block;">
            ${squares.join('')}
            ${highlight}
        </svg>
    `;
}

// ─── Controls ─────────────────────────────────────────────────────

function populateDropdowns() {
    // Piece theme dropdown — same widget as the style modal
    dom.piecesDropdown.querySelector('.style-dropdown-menu').innerHTML = buildPieceMenu(state.options.pieceTheme);
    refreshPiecesTrigger();
    initDropdown('gif-pieces-dropdown', (themeId) => {
        state.options.pieceTheme = themeId;
        refreshPiecesTrigger();
        renderPreview();
    });

    // Board preset dropdown + adjacent color pickers
    dom.boardDropdown.querySelector('.style-dropdown-menu').innerHTML = buildBoardMenu(
        state.options.boardLight,
        state.options.boardDark,
        '',
    );
    refreshBoardTrigger();
    initDropdown('gif-board-dropdown', (presetId) => {
        const preset = BOARD_PRESETS.find((p) => p.id === presetId);
        if (!preset) return;
        state.options.boardLight = preset.light;
        state.options.boardDark = preset.dark;
        dom.light.value = preset.light;
        dom.dark.value = preset.dark;
        refreshBoardTrigger();
        renderPreview();
    });
}

function updateGenerateBtn() {
    dom.generateBtn.disabled = state.fens.length === 0 || state.generating;
}

function wireControls() {
    dom.pgnInput.addEventListener('input', (e) => loadPgn(e.target.value));

    dom.light.addEventListener('input', (e) => {
        state.options.boardLight = e.target.value;
        refreshBoardTrigger();
        renderPreview();
    });
    dom.dark.addEventListener('input', (e) => {
        state.options.boardDark = e.target.value;
        refreshBoardTrigger();
        renderPreview();
    });

    dom.scrubber.addEventListener('input', (e) => {
        state.currentFrame = parseInt(e.target.value, 10);
        dom.frameCur.textContent = state.currentFrame;
        renderPreview();
    });

    dom.timing.addEventListener('change', (e) => {
        if (e.target.name !== 'gif-timing') return;
        state.options.timing = e.target.value;
        dom.customMs.classList.toggle('hidden', state.options.timing !== 'custom');
    });

    dom.customMs.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10);
        if (!isNaN(v)) state.options.customMs = v;
    });

    dom.flip.addEventListener('change', (e) => {
        state.options.flip = e.target.checked;
        renderPreview();
    });

    dom.finalHold.addEventListener('change', (e) => {
        state.options.finalFrameHold = e.target.checked;
    });

    dom.generateBtn.addEventListener('click', generate);
    dom.regen.addEventListener('click', generate);
    dom.download.addEventListener('click', downloadResult);
}

// ─── Generate ─────────────────────────────────────────────────────

// Highlight tint applied over the last-move squares in renderFrameToCanvas.
const HIGHLIGHT_RGB = [255, 255, 100];
const HIGHLIGHT_ALPHA = 0.4;

function hexToRgb(hex) {
    const c = parseInt(hex.slice(1), 16);
    return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}
function blendOver(over, base, alpha) {
    return [
        Math.round(over[0] * alpha + base[0] * (1 - alpha)),
        Math.round(over[1] * alpha + base[1] * (1 - alpha)),
        Math.round(over[2] * alpha + base[2] * (1 - alpha)),
    ];
}
// Explicit 4-color palette: board light/dark + highlight blended over each.
// Hardcoded (rather than quantize()) so the highlight colors — which only
// appear in 2 of 64 squares — aren't merged into the dominant board colors.
function buildPalette() {
    const light = hexToRgb(state.options.boardLight);
    const dark = hexToRgb(state.options.boardDark);
    return [
        light,
        dark,
        blendOver(HIGHLIGHT_RGB, light, HIGHLIGHT_ALPHA),
        blendOver(HIGHLIGHT_RGB, dark, HIGHLIGHT_ALPHA),
    ];
}

// Mirrors renderPreview() but draws to a 2D canvas instead of SVG.
// Pieces will join here once Rabbit lands.
function renderFrameToCanvas(ctx, frameIdx, size) {
    const { boardLight, boardDark, flip } = state.options;
    const sq = size / 8;
    for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
            const light = (r + f) % 2 === 0;
            const x = f * sq;
            const y = (flip ? 7 - r : r) * sq;
            ctx.fillStyle = light ? boardLight : boardDark;
            ctx.fillRect(x, y, sq, sq);
        }
    }
    const lm = state.lastMoves[frameIdx];
    if (lm) {
        ctx.fillStyle = 'rgba(255, 255, 100, 0.4)';
        for (const s of [lm.from, lm.to]) {
            const f = s.charCodeAt(0) - 97;
            const r = 8 - parseInt(s[1], 10);
            const x = (flip ? 7 - f : f) * sq;
            const y = (flip ? 7 - r : r) * sq;
            ctx.fillRect(x, y, sq, sq);
        }
    }
}

// Holds the most recent generation's Blob URL so the download button can use it
// and we can revoke the previous URL on regeneration.
let _resultUrl = null;

async function generate() {
    if (state.generating || !state.fens.length) return;
    state.generating = true;
    updateGenerateBtn();

    dom.progress.classList.remove('hidden');
    dom.progressFill.style.width = '0%';
    dom.progressTxt.textContent = 'Encoding…';

    const size = 480;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const totalFrames = state.fens.length;
    const baseDelay = getDelayMs();
    const finalDelay = state.options.finalFrameHold ? Math.max(baseDelay * 3, 1500) : baseDelay;

    const gif = GIFEncoder();
    const palette = buildPalette();

    for (let i = 0; i < totalFrames; i++) {
        renderFrameToCanvas(ctx, i, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const indexed = applyPalette(data, palette);
        const delay = i === totalFrames - 1 ? finalDelay : baseDelay;
        // gifenc writes the palette as the global table from the first frame.
        gif.writeFrame(indexed, size, size, { palette: i === 0 ? palette : undefined, delay });

        dom.progressFill.style.width = `${((i + 1) / totalFrames) * 100}%`;
        dom.progressTxt.textContent = `Frame ${i + 1} / ${totalFrames}`;
        // Yield periodically so the progress bar can actually paint.
        if ((i & 7) === 0) await new Promise((r) => setTimeout(r, 0));
    }
    gif.finish();

    const bytes = gif.bytes();
    if (_resultUrl) URL.revokeObjectURL(_resultUrl);
    _resultUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
    dom.resultImg.src = _resultUrl;
    dom.progressTxt.textContent = `Done — ${Math.round(bytes.byteLength / 1024)} KB`;
    showStage('result');

    state.generating = false;
    updateGenerateBtn();
}

function downloadResult() {
    if (!_resultUrl) return;
    const a = document.createElement('a');
    a.href = _resultUrl;
    a.download = `chess-game-${Date.now()}.gif`;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

// ─── Public API ───────────────────────────────────────────────────

let initialized = false;

export function openGifMaker(prefilledPgn = '') {
    if (!initialized) {
        resolveDom();
        populateDropdowns();
        wireControls();
        renderPreview();
        updateScrubber();
        updateGenerateBtn();
        initialized = true;
    }

    // Reset to preview view each time the modal opens.
    showStage('preview');
    dom.progress.classList.add('hidden');

    if (prefilledPgn) {
        dom.pgnInput.value = prefilledPgn;
        loadPgn(prefilledPgn);
    }

    openModal('gif-maker-modal');
}

// Dev convenience: trigger via URL hash `#gif`.
if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', () => {
        if (location.hash === '#gif') openGifMaker();
    });
    // Also expose on window so we can poke it from the console.
    window.openGifMaker = openGifMaker;
}
