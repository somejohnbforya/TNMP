// Share as Video — paste a PGN (or open from a game), configure the board
// look, and generate a scrubbable MP4 (or a GIF fallback/loop).
//
// Frames: Rabbit's static renderer (vendored extraction, src/vendor/) wrapped
// in a header/board/footer grammar — every frame self-describing since any
// frame can be the paused one. MP4: WebCodecs H.264 → mp4-muxer.
// GIF: gifenc, kept as the no-WebCodecs fallback and the loop-lovers option.

import { openModal } from './modal.js';
import { splitPgn, extractMoveText, parseMoveText, parseRecord } from './pgn-parser.js';
import {
    PIECE_THEMES,
    BOARD_PRESETS,
    initDropdown,
    buildPieceMenu,
    buildBoardMenu,
    piecePreviewHtml,
    boardSwatchHtml,
} from './style.js';
import { loadEcoData, classifyFen } from './eco.js';
import { Chess } from 'chess.js';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { renderToSVG } from './vendor/rabbit-static.js';

// ─── Frame geometry (the shared frame grammar) ────────────────────

const BOARD = 720; // board pixels; header/footer scale from it
const px = (n) => Math.round((n * BOARD) / 720);
const HEADER = px(76);
const FOOTER = px(64) + ((px(76) + BOARD + px(64)) % 2); // keep H even for yuv420p
const W = BOARD;
const H = HEADER + BOARD + FOOTER;
const FONT = 'Helvetica, Arial, sans-serif';

// ─── State ────────────────────────────────────────────────────────

const state = {
    pgn: '',
    record: null, // parseRecord() of the loaded game (headers)
    fens: [], // FEN per ply, including the start at index 0
    lastMoves: [], // [{from,to}|null] aligned to fens
    sans: [], // SAN per ply (null at index 0)
    checks: [], // checked-king square per ply (null unless the move gave check)
    opening: null, // {eco, name} from eco.js, when resolvable
    currentFrame: 0,
    options: {
        pieceTheme: 'default',
        boardLight: '#dee3e6',
        boardDark: '#8ca2ad',
        flip: false,
        timing: 'medium', // 'fast' | 'medium' | 'slow' | 'custom'
        customMs: 600,
        finalFrameHold: false,
        format: 'mp4', // 'mp4' | 'gif' — mp4 only when WebCodecs supports it
    },
    generating: false,
};

const TIMING_MS = { fast: 200, medium: 600, slow: 1500 };

function getDelayMs() {
    return state.options.timing === 'custom' ? state.options.customMs : TIMING_MS[state.options.timing];
}

let mp4Supported = null; // resolved on first open

const CFR_FPS = 10; // constant-frame-rate grid for the MP4 (see generateMp4)
const TICK_MS = 1000 / CFR_FPS;

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
        format: document.getElementById('gif-format-options'),
        generateBtn: document.getElementById('gif-generate-btn'),
        progress: document.getElementById('gif-progress'),
        progressFill: document.getElementById('gif-progress-fill'),
        progressTxt: document.getElementById('gif-progress-text'),
        result: document.getElementById('gif-result'),
        resultImg: document.getElementById('gif-result-img'),
        resultVideo: document.getElementById('gif-result-video'),
        share: document.getElementById('gif-share-btn'),
        download: document.getElementById('gif-download-btn'),
        regen: document.getElementById('gif-regen-btn'),
    };
}

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

function showStage(mode) {
    dom.previewPane.classList.toggle('hidden', mode !== 'preview');
    dom.result.classList.toggle('hidden', mode !== 'result');
}

// ─── PGN handling ─────────────────────────────────────────────────

function loadPgn(text) {
    state.pgn = text;
    state.record = null;
    state.fens = [];
    state.lastMoves = [];
    state.sans = [];
    state.checks = [];
    state.opening = null;

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
    state.record = parseRecord(games[0]);
    const moves = parseMoveText(extractMoveText(games[0]));

    const chess = new Chess();
    state.fens.push(chess.fen());
    state.lastMoves.push(null);
    state.sans.push(null);
    state.checks.push(null);
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
        state.sans.push(move.san);
        state.checks.push(chess.inCheck() ? kingSquare(chess) : null);
        played++;
    }

    state.currentFrame = state.fens.length - 1; // jump to last position
    setStatus(`✓ ${played} move${played === 1 ? '' : 's'} loaded`, 'ok');
    updateScrubber();
    renderPreview();
    updateGenerateBtn();
    resolveOpening();
}

// Square of the side-to-move king (the checked king right after a check move).
function kingSquare(chess) {
    const turn = chess.turn();
    for (const row of chess.board()) {
        for (const cell of row) {
            if (cell && cell.type === 'k' && cell.color === turn) return cell.square;
        }
    }
    return null;
}

// Deepest book hit across the mainline — used for the no-names title.
async function resolveOpening() {
    await loadEcoData();
    let best = null;
    for (const fen of state.fens) {
        const hit = classifyFen(fen);
        if (hit) best = hit;
    }
    state.opening = best;
    renderPreview();
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

// ─── Frame grammar (header / board / footer) ──────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const surname = (s) => (s ?? '').split(',')[0].trim();
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function hasNames() {
    const r = state.record;
    return r && ((r.white && r.white !== 'Unknown') || (r.black && r.black !== 'Unknown'));
}

function prettyResult() {
    let result = state.record?.result;
    if (!result || result === '*') {
        // A final mate is self-evident: odd ply index of the last move = White.
        const lastSan = state.sans[state.sans.length - 1];
        if (lastSan?.endsWith('#')) result = (state.sans.length - 1) % 2 ? '1-0' : '0-1';
    }
    return (result ?? '*').replace('1/2-1/2', '½–½').replace('-', '–');
}

function moveLabel(i) {
    const totalMoves = Math.ceil((state.fens.length - 1) / 2);
    if (i === 0) return `${totalMoves} move${totalMoves === 1 ? '' : 's'}`;
    const n = Math.ceil(i / 2);
    return i % 2 ? `${n}. ${state.sans[i]}` : `${n}… ${state.sans[i]}`;
}

function headerLines() {
    const r = state.record;
    if (hasNames()) {
        const elo = (e) => (e ? ` (${e})` : '');
        const title = `${surname(r.white) || '?'}${elo(r.whiteElo)}  vs  ${surname(r.black) || '?'}${elo(r.blackElo)}`;
        const sub = [r.tournament, r.section, r.round ? `R${r.round}` : null, r.date].filter(Boolean).join(' · ');
        return { title: trunc(title, 46), sub: trunc(sub, 74) };
    }
    if (state.opening) {
        const [family, ...variation] = state.opening.name.split(': ');
        const eco = state.opening.eco ? `${state.opening.eco} · ` : '';
        return { title: trunc(`${eco}${family}`, 46), sub: trunc(variation.join(': '), 74) };
    }
    return { title: 'Casual game', sub: '' };
}

async function frameSVG(i, { final = false } = {}) {
    const { boardLight, boardDark, flip, pieceTheme } = state.options;
    const boardSVG = await renderToSVG(state.fens[i], {
        pieces: await loadPieceSvgs(pieceTheme),
        size: BOARD,
        light: boardLight,
        dark: boardDark,
        lastMove: state.lastMoves[i],
        check: state.checks[i],
        orientation: flip ? 'black' : 'white',
    });
    const { title, sub } = headerLines();
    const progress = i === 0 ? '' : `move ${Math.ceil(i / 2)} of ${Math.ceil((state.fens.length - 1) / 2)}`;
    // Result appears only on the final-hold frame — no spoilers mid-scrub.
    const resultText = final
        ? `<text x="${W - px(24)}" y="${px(34)}" text-anchor="end" font-family="${FONT}" font-size="${px(25)}" font-weight="700" fill="#d9b45a">${esc(prettyResult())}</text>`
        : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#1e1b17"/>
  <text x="${px(24)}" y="${px(34)}" font-family="${FONT}" font-size="${px(25)}" font-weight="700" fill="#f5f2ec">${esc(title)}</text>${resultText}
  <text x="${px(24)}" y="${px(60)}" font-family="${FONT}" font-size="${px(16)}" fill="#8f8a82">${esc(sub)}</text>
  <g transform="translate(0,${HEADER})">${boardSVG}</g>
  <text x="${px(24)}" y="${HEADER + BOARD + px(43)}" font-family="${FONT}" font-size="${px(30)}" font-weight="700" fill="#f5f2ec">${esc(moveLabel(i))}</text>
  <text x="${W - px(24)}" y="${HEADER + BOARD + px(41)}" text-anchor="end" font-family="${FONT}" font-size="${px(17)}" fill="#8f8a82">${esc(progress)}</text>
</svg>`;
}

// ─── Piece SVGs (fetched per theme, cached) ───────────────────────

const PIECE_CODES = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
const pieceCache = new Map();

// Some piece sets (e.g. the Illustrator-exported default set) style via
// <style> blocks with class names that REPEAT across files (wN and bN both
// define .clsN-2, with different fills). Inlined into one parent SVG those
// rules cascade document-wide and the last block wins — every piece turns
// one color. Bake each file's flat class rules onto its elements as plain
// attributes and drop the <style>, so every piece is self-contained.
// Attribute-styled sets (cburnett etc.) have no <style> and pass through.
function inlinePieceStyles(svgText) {
    if (!svgText.includes('<style')) return svgText;
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const root = doc.documentElement;
    for (const styleEl of root.querySelectorAll('style')) {
        const css = styleEl.textContent;
        // Flat `.a,.b{decls}` rules only — all these generated sets use.
        for (const [, selectors, decls] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            const classes = [...selectors.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
            if (!classes.length) continue;
            const attrs = [...decls.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)];
            for (const cls of classes) {
                for (const el of root.querySelectorAll(`.${CSS.escape(cls)}`)) {
                    for (const [, prop, value] of attrs) el.setAttribute(prop.trim(), value.trim());
                }
            }
        }
        styleEl.remove();
    }
    for (const el of root.querySelectorAll('[class]')) el.removeAttribute('class');
    return new XMLSerializer().serializeToString(root);
}

async function loadPieceSvgs(themeId) {
    if (pieceCache.has(themeId)) return pieceCache.get(themeId);
    const svgs = {};
    await Promise.all(
        PIECE_CODES.map(async (code) => {
            const res = await fetch(`/pieces/${themeId}/${code}.svg`);
            if (!res.ok) throw new Error(`piece fetch failed: ${themeId}/${code}`);
            svgs[code] = inlinePieceStyles(await res.text());
        }),
    );
    const pieces = { name: themeId, svgs };
    pieceCache.set(themeId, pieces);
    return pieces;
}

// ─── Preview ──────────────────────────────────────────────────────

let _previewToken = 0;

async function renderPreview() {
    const token = ++_previewToken;
    if (!state.fens.length) {
        dom.preview.innerHTML = '';
        return;
    }
    try {
        const svg = await frameSVG(state.currentFrame);
        if (token === _previewToken) dom.preview.innerHTML = svg;
    } catch (e) {
        if (token === _previewToken) dom.preview.innerHTML = `<div class="gif-preview-error">${esc(e.message)}</div>`;
    }
}

// ─── Controls ─────────────────────────────────────────────────────

function populateDropdowns() {
    dom.piecesDropdown.querySelector('.style-dropdown-menu').innerHTML = buildPieceMenu(state.options.pieceTheme);
    refreshPiecesTrigger();
    initDropdown('gif-pieces-dropdown', (themeId) => {
        state.options.pieceTheme = themeId;
        refreshPiecesTrigger();
        renderPreview();
    });

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
    dom.generateBtn.textContent = state.options.format === 'mp4' ? 'Generate video' : 'Generate GIF';
}

function wireControls() {
    dom.pgnInput.addEventListener('input', (e) => loadPgn(e.target.value));

    // Drop a .pgn file straight onto the textarea.
    dom.pgnInput.addEventListener('dragover', (e) => e.preventDefault());
    dom.pgnInput.addEventListener('drop', async (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        e.preventDefault();
        const text = await file.text();
        dom.pgnInput.value = text;
        loadPgn(text);
    });

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

    dom.format.addEventListener('change', (e) => {
        if (e.target.name !== 'gif-format') return;
        state.options.format = e.target.value;
        updateGenerateBtn();
    });

    dom.generateBtn.addEventListener('click', generate);
    dom.regen.addEventListener('click', generate);
    dom.download.addEventListener('click', downloadResult);
    dom.share.addEventListener('click', shareResult);
}

// ─── Frame rasterization (SVG → canvas) ───────────────────────────

async function drawFrame(ctx, i, opts) {
    const svg = await frameSVG(i, opts);
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();
    ctx.drawImage(img, 0, 0, W, H);
}

function setProgress(fraction, text) {
    dom.progressFill.style.width = `${Math.round(fraction * 100)}%`;
    dom.progressTxt.textContent = text;
}

// ─── Generate ─────────────────────────────────────────────────────

let _resultUrl = null;
let _resultBlob = null;
let _resultName = null;

function resultFilename(ext) {
    const r = state.record;
    const base = hasNames()
        ? `${surname(r.white)}-vs-${surname(r.black)}`
        : state.opening
          ? `${state.opening.eco ?? ''}-${state.opening.name}`
          : 'chess-game';
    const slug = base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
    return `${slug || 'chess-game'}.${ext}`;
}

async function generate() {
    if (state.generating || !state.fens.length) return;
    state.generating = true;
    updateGenerateBtn();
    dom.progress.classList.remove('hidden');
    setProgress(0, 'Rendering…');

    try {
        const blob = state.options.format === 'mp4' ? await generateMp4() : await generateGif();
        if (_resultUrl) URL.revokeObjectURL(_resultUrl);
        _resultBlob = blob;
        _resultUrl = URL.createObjectURL(blob);
        _resultName = resultFilename(state.options.format === 'mp4' ? 'mp4' : 'gif');

        const isVideo = state.options.format === 'mp4';
        dom.resultImg.classList.toggle('hidden', isVideo);
        dom.resultVideo.classList.toggle('hidden', !isVideo);
        if (isVideo) dom.resultVideo.src = _resultUrl;
        else dom.resultImg.src = _resultUrl;

        const file = new File([_resultBlob], _resultName, { type: _resultBlob.type });
        dom.share.classList.toggle('hidden', !navigator.canShare?.({ files: [file] }));
        setProgress(1, `Done — ${Math.round(blob.size / 1024)} KB`);
        showStage('result');
    } catch (e) {
        setProgress(0, `✗ ${e.message}`);
    } finally {
        state.generating = false;
        updateGenerateBtn();
    }
}

// Per-frame durations in ms: a settling intro on the first frame, an optional
// long hold on the last, the user's per-move delay everywhere else.
function frameDurations() {
    const delay = getDelayMs();
    const n = state.fens.length;
    return Array.from({ length: n }, (_, i) => {
        if (i === 0) return Math.max(delay, 1500);
        if (i === n - 1) return state.options.finalFrameHold ? Math.max(delay * 3, 3000) : Math.max(delay, 1500);
        return delay;
    });
}

async function generateMp4() {
    const support = await detectMp4Support();
    if (!support) throw new Error('This browser cannot encode MP4 — try the GIF option');

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width: W, height: H },
        fastStart: 'in-memory',
    });
    const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => console.error('encode error', e),
    });
    encoder.configure(support.config);

    // Constant frame rate on a 10fps grid — per-sample (VFR) durations are
    // legal MP4 but players/encoders pace them unevenly; duplicated ticks
    // are near-free P-frames and every player handles a uniform grid.
    const durations = frameDurations();
    const n = state.fens.length;
    const keyEveryTicks = CFR_FPS * 10; // ≈ one keyframe / 10s
    let tick = 0;
    for (let i = 0; i < n; i++) {
        await drawFrame(ctx, i, { final: i === n - 1 });
        const ticks = Math.max(1, Math.round(durations[i] / TICK_MS));
        for (let k = 0; k < ticks; k++) {
            const frame = new VideoFrame(canvas, {
                timestamp: tick * TICK_MS * 1000,
                duration: TICK_MS * 1000,
            });
            encoder.encode(frame, { keyFrame: tick % keyEveryTicks === 0, ...support.encodeOpts });
            frame.close();
            tick++;
        }
        setProgress((i + 1) / (n + 1), `Frame ${i + 1} / ${n}`);
    }
    setProgress(n / (n + 1), 'Encoding…');
    await encoder.flush();
    encoder.close();
    muxer.finalize();

    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

// Probe once: quantizer-mode rate control where available (constant quality —
// measured best for flat board art), else VBR sized to the frame cadence.
async function detectMp4Support() {
    if (mp4Supported !== null) return mp4Supported;
    if (typeof VideoEncoder === 'undefined') {
        mp4Supported = false;
        return mp4Supported;
    }
    const base = {
        codec: 'avc1.640028',
        width: W,
        height: H,
        framerate: CFR_FPS,
    };
    try {
        const q = await VideoEncoder.isConfigSupported({ ...base, bitrate: 1_000_000, bitrateMode: 'quantizer' });
        if (q.supported) {
            mp4Supported = {
                config: { ...base, bitrate: 1_000_000, bitrateMode: 'quantizer', latencyMode: 'quality' },
                encodeOpts: { avc: { quantizer: 26 } },
            };
            return mp4Supported;
        }
        const v = await VideoEncoder.isConfigSupported({ ...base, bitrate: 100_000, bitrateMode: 'variable' });
        if (v.supported) {
            mp4Supported = {
                config: { ...base, bitrate: 100_000, bitrateMode: 'variable', latencyMode: 'quality' },
                encodeOpts: {},
            };
            return mp4Supported;
        }
    } catch {
        /* fall through */
    }
    mp4Supported = false;
    return mp4Supported;
}

async function generateGif() {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const gif = GIFEncoder();
    const durations = frameDurations();
    const n = state.fens.length;
    let palette = null;
    for (let i = 0; i < n; i++) {
        await drawFrame(ctx, i, { final: i === n - 1 });
        const data = ctx.getImageData(0, 0, W, H).data;
        // Global palette from the first frame — board art is palette-stable.
        if (!palette) palette = quantize(data, 256);
        const indexed = applyPalette(data, palette);
        gif.writeFrame(indexed, W, H, { palette: i === 0 ? palette : undefined, delay: durations[i] });
        setProgress((i + 1) / n, `Frame ${i + 1} / ${n}`);
        if ((i & 7) === 0) await new Promise((r) => setTimeout(r, 0));
    }
    gif.finish();
    return new Blob([gif.bytes()], { type: 'image/gif' });
}

// ─── Output actions ───────────────────────────────────────────────

function downloadResult() {
    if (!_resultUrl) return;
    const a = document.createElement('a');
    a.href = _resultUrl;
    a.download = _resultName ?? `chess-game-${Date.now()}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

async function shareResult() {
    if (!_resultBlob) return;
    const file = new File([_resultBlob], _resultName, { type: _resultBlob.type });
    try {
        await navigator.share({ files: [file] });
    } catch {
        /* user cancelled the sheet — fine */
    }
}

// ─── Public API ───────────────────────────────────────────────────

let initialized = false;

export async function openGifMaker(prefilledPgn = '') {
    if (!initialized) {
        resolveDom();
        populateDropdowns();
        wireControls();
        renderPreview();
        updateScrubber();
        // MP4 only where WebCodecs can actually encode it.
        const support = await detectMp4Support();
        if (!support) {
            state.options.format = 'gif';
            dom.format.classList.add('hidden');
        }
        updateGenerateBtn();
        initialized = true;
    }

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
    window.openGifMaker = openGifMaker;
}
