import { describe, it, expect } from 'vitest';
import { formatName, resultClass, resultSymbol, getHeader, fenToEpd, resultDisplay, shareTarget } from '../src/utils.js';

describe('shareTarget', () => {
    const PAGE = 'https://tnmpairings.com/';
    // Fall 2026 R2: MI stamped GameId 2352688410645319 on two different games,
    // so neither stores it, but each PGN still carries it.
    const collidedPgn = [
        '[Event "2026 Fall TNM: Extra rated"]',
        '[Round "2"]',
        '[White "Hasteer, Divija"]',
        '[Black "Robinson, Damian"]',
        '[Result "1-0"]',
        '[GameId "2352688410645319"]',
        '',
        '1. e4 d6 1-0',
    ].join('\n');

    it('shares a stored game by its stored GameId, with its stored names and result', () => {
        const game = {
            tournamentSlug: '2026-fall-tuesday-night-marathon',
            gameId: '2352688410596131',
            white: 'Jimmy Heiserman',
            black: 'Zelin Fang',
            result: '1-0',
        };
        expect(shareTarget(game, '[White "Heiserman, Jimmy"]', PAGE)).toEqual({
            url: 'https://tnmpairings.com?game=2352688410596131',
            title: 'Jimmy Heiserman vs Zelin Fang — 1-0',
        });
    });

    it("shares the page for a stored game whose GameId was dropped, never the PGN's copy", () => {
        const game = {
            tournamentSlug: '2026-fall-tuesday-night-marathon',
            gameId: '2026-fall-tuesday-night-marathon:2:933',
            white: 'Divija Hasteer',
            black: 'Damian Robinson',
            result: '1-0',
        };
        expect(shareTarget(game, collidedPgn, PAGE)).toEqual({
            url: PAGE,
            title: 'Divija Hasteer vs Damian Robinson — 1-0',
        });
    });

    it('shares a pasted game by what its PGN says', () => {
        expect(shareTarget({ tournamentSlug: null, gameId: 'local-0' }, collidedPgn, PAGE)).toEqual({
            url: 'https://tnmpairings.com?game=2352688410645319',
            title: 'Divija Hasteer vs Damian Robinson — 1-0',
        });
        expect(shareTarget(null, '[White "A, B"]\n[Black "C, D"]\n[Result "*"]', PAGE).url).toBe(PAGE);
    });
});

describe('formatName', () => {
    it('converts "Last, First" to "First Last"', () => {
        expect(formatName('Boyer, John')).toBe('John Boyer');
    });

    it('passes through names without commas', () => {
        expect(formatName('John Boyer')).toBe('John Boyer');
    });

    it('trims whitespace around parts', () => {
        expect(formatName('Boyer , John')).toBe('John Boyer');
    });

    it('handles single name', () => {
        expect(formatName('Kasparov')).toBe('Kasparov');
    });

    it('handles names with multiple commas (takes first split)', () => {
        // "A, B, C" → 3 parts, length !== 2, returns original
        expect(formatName('A, B, C')).toBe('A, B, C');
    });
});

describe('resultClass', () => {
    it('returns draw class for 1/2-1/2', () => {
        expect(resultClass('1/2-1/2', 'white')).toBe('viewer-draw');
        expect(resultClass('1/2-1/2', 'black')).toBe('viewer-draw');
    });

    it('returns winner/loser for 1-0', () => {
        expect(resultClass('1-0', 'white')).toBe('viewer-winner');
        expect(resultClass('1-0', 'black')).toBe('viewer-loser');
    });

    it('returns winner/loser for 0-1', () => {
        expect(resultClass('0-1', 'black')).toBe('viewer-winner');
        expect(resultClass('0-1', 'white')).toBe('viewer-loser');
    });

    it('uses custom prefix', () => {
        expect(resultClass('1-0', 'white', 'browser')).toBe('browser-winner');
    });

    it('returns empty string for unknown result', () => {
        expect(resultClass('*', 'white')).toBe('');
    });
});

describe('resultSymbol', () => {
    it('returns ½ for draw', () => {
        expect(resultSymbol('1/2-1/2', 'white')).toBe('\u00BD');
        expect(resultSymbol('1/2-1/2', 'black')).toBe('\u00BD');
    });

    it('returns 1 for winner, 0 for loser', () => {
        expect(resultSymbol('1-0', 'white')).toBe('1');
        expect(resultSymbol('1-0', 'black')).toBe('0');
        expect(resultSymbol('0-1', 'black')).toBe('1');
        expect(resultSymbol('0-1', 'white')).toBe('0');
    });

    it('returns empty string for unknown result', () => {
        expect(resultSymbol('*', 'white')).toBe('');
    });
});

describe('getHeader', () => {
    const pgn = `[Event "Test Event"]
[White "Boyer, John"]
[Black "Chen, Quincy"]
[Result "1-0"]
[Round "2.18"]

1. e4 e5 1-0`;

    it('extracts a header value', () => {
        expect(getHeader(pgn, 'White')).toBe('Boyer, John');
        expect(getHeader(pgn, 'Event')).toBe('Test Event');
        expect(getHeader(pgn, 'Round')).toBe('2.18');
    });

    it('returns empty string for missing header', () => {
        expect(getHeader(pgn, 'ECO')).toBe('');
    });

    it('returns empty string for empty PGN', () => {
        expect(getHeader('', 'White')).toBe('');
    });
});


describe('fenToEpd', () => {
    it('strips halfmove and fullmove clocks', () => {
        expect(fenToEpd('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'))
            .toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3');
    });

    it('handles starting position', () => {
        expect(fenToEpd('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'))
            .toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
    });
});

describe('resultDisplay', () => {
    it('recognizes win codes', () => {
        expect(resultDisplay('W').outcome).toBe('win');
        expect(resultDisplay('1').outcome).toBe('win');
        expect(resultDisplay('1 X').outcome).toBe('win');
    });

    it('recognizes loss codes', () => {
        expect(resultDisplay('L').outcome).toBe('loss');
        expect(resultDisplay('0').outcome).toBe('loss');
        expect(resultDisplay('0 F').outcome).toBe('loss');
    });

    it('recognizes draw codes', () => {
        expect(resultDisplay('D').outcome).toBe('draw');
        expect(resultDisplay('\u00BD').outcome).toBe('draw');
        expect(resultDisplay('½').outcome).toBe('draw');
    });

    it('returns null for unrecognized codes', () => {
        expect(resultDisplay('X')).toBeNull();
        expect(resultDisplay('')).toBeNull();
        expect(resultDisplay(null)).toBeNull();
    });

    it('trims whitespace', () => {
        expect(resultDisplay('  W  ').outcome).toBe('win');
    });
});
