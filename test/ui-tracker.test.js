import { describe, it, expect } from 'vitest';
import {
    playerScore,
    buildTrackerCellsHtml,
    buildTrackerDetailHtml,
    buildPairingPillHtml,
    buildResultsPillHtml,
} from '../src/ui.js';
import { STATE } from '../src/config.js';

// The scoreboard renderers are pure (data in, HTML out) so they're tested
// as string builders — no DOM shim needed. The thin DOM glue in ui.js is
// exercised in the browser.

const ROUNDS = {
    1: { color: 'White', opponent: 'Alice Aa', opponentRating: 1500, result: 'W', isBye: false, gameId: 'g1', board: 3, ownRating: 1740 },
    2: { color: 'Black', opponent: 'Bob Bb', opponentRating: 1600, result: 'L', isBye: false, gameId: 'g2', board: 5, ownRating: 1741 },
    3: { color: 'White', opponent: 'Cara Cc', opponentRating: 1550, result: 'D', isBye: false, gameId: 'g3', board: 4, ownRating: 1742 },
    4: { isBye: true, byeType: 'half', result: 'H' },
    5: { color: 'Black', opponent: 'Carl Anthony Pickering', opponentRating: 1758, result: null, isBye: false, gameId: null, board: 18 },
};

const ROUND_DATES = [
    '2026-07-07T18:30:00-07:00',
    '2026-07-14T18:30:00-07:00',
    '2026-07-21T18:30:00-07:00',
    '2026-07-28T18:30:00-07:00',
    '2026-08-04T18:30:00-07:00',
    '2026-08-11T18:30:00-07:00',
    '2026-08-18T18:30:00-07:00',
];

describe('playerScore', () => {
    it('scores wins, draws, and byes', () => {
        // W(1) + L(0) + D(0.5) + half-bye(0.5); round 5 unplayed
        expect(playerScore(ROUNDS)).toEqual({ score: 2, played: 4 });
    });

    it('handles empty rounds', () => {
        expect(playerScore({})).toEqual({ score: 0, played: 0 });
    });
});

describe('buildTrackerCellsHtml', () => {
    it('renders one cell per round with result classes', () => {
        const html = buildTrackerCellsHtml(ROUNDS, 7, 5, STATE.YES, null);
        expect(html.match(/tracker-cell/g)).toHaveLength(7);
        expect(html).toContain('tb-w');
        expect(html).toContain('tb-l');
        expect(html).toContain('tb-d');
        expect(html).toContain('tb-bye');
        expect(html).toContain('tb-x'); // rounds 6-7 unplayed
    });

    it('marks the live round and the selected round', () => {
        const html = buildTrackerCellsHtml(ROUNDS, 7, 5, STATE.YES, 2);
        expect(html).toContain('tb-live');
        expect(html).toContain('tb-selected');
    });

    it('uses the duck for byes and piece icons for played colors', () => {
        const html = buildTrackerCellsHtml(ROUNDS, 7, 5, STATE.RESULTS, null);
        expect(html).toContain('Duck.svg');
        expect(html).toContain('wK.svg');
        expect(html).toContain('bK.svg');
    });
});

describe('buildTrackerDetailHtml', () => {
    it('renders result verb, opponent piece color, and view-game button', () => {
        const html = buildTrackerDetailHtml(1, ROUNDS[1], ROUND_DATES, STATE.RESULTS);
        expect(html).toContain('You won');
        expect(html).toContain('bK.svg'); // opponent of a White game
        expect(html).toContain('Alice Aa');
        expect(html).toContain('data-game-id="g1"');
        expect(html).toContain('Round 1 · Board 3');
    });

    it('renders a half-point bye', () => {
        const html = buildTrackerDetailHtml(4, ROUNDS[4], ROUND_DATES, STATE.RESULTS);
        expect(html).toContain('Half-point bye');
        expect(html).toContain('Duck.svg');
        expect(html).not.toContain('view-game-btn');
    });

    it('renders a live unfinished round without a verb or game link', () => {
        const html = buildTrackerDetailHtml(5, ROUNDS[5], ROUND_DATES, STATE.YES);
        expect(html).toContain('Playing tonight');
        expect(html).not.toContain('view-game-btn');
    });

    it('escapes HTML in names', () => {
        const evil = { ...ROUNDS[1], opponent: '<img onerror=x>' };
        const html = buildTrackerDetailHtml(1, evil, ROUND_DATES, STATE.RESULTS);
        expect(html).not.toContain('<img onerror');
        expect(html).toContain('&lt;img onerror=x&gt;');
    });
});

describe('buildPairingPillHtml', () => {
    const pairing = { board: 18, color: 'Black', opponent: 'Carl Anthony Pickering', opponentRating: 1758 };

    it('shows both surnames with the correct piece per side', () => {
        const html = buildPairingPillHtml(pairing, 'John Boyer', 1743, 5, ROUND_DATES);
        // You play Black → your side gets bK, opponent side gets wK
        const you = html.slice(html.indexOf('pp-you'), html.indexOf('pp-seam'));
        const opp = html.slice(html.indexOf('pp-opp'));
        expect(you).toContain('bK.svg');
        expect(you).toContain('Boyer');
        expect(you).toContain('1743');
        expect(opp).toContain('wK.svg');
        expect(opp).toContain('Pickering');
        expect(opp).toContain('1758');
        expect(html).toContain('Round 5 · Board 18');
    });

    it('links the opponent to their profile with the full name', () => {
        const html = buildPairingPillHtml(pairing, 'John Boyer', 1743, 5, ROUND_DATES);
        expect(html).toContain('data-action="open-profile"');
        expect(html).toContain('data-name="Carl Anthony Pickering"');
    });

    it('renders a bye pill with the duck', () => {
        const html = buildPairingPillHtml({ isBye: true, byeType: 'full' }, 'John Boyer', 1743, 5, ROUND_DATES);
        expect(html).toContain('Full-point bye');
        expect(html).toContain('Duck.svg');
        expect(html).not.toContain('pp-seam');
    });
});

describe('buildResultsPillHtml', () => {
    it('counts wins, draws, and losses', () => {
        const html = buildResultsPillHtml(ROUNDS, 7);
        expect(html).toContain('Final · 7 rounds');
        const nums = [...html.matchAll(/rp-num">(\d+)</g)].map((m) => Number(m[1]));
        expect(nums).toEqual([1, 1, 1]); // 1W, 1D, 1L (bye + unplayed excluded)
    });
});
