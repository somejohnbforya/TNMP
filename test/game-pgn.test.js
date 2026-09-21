import { describe, it, expect } from 'vitest';
import { createGame } from '../src/game.js';

describe('Copy PGN follows the comments toggle', () => {
    // The comments button hides comments AND variations in the move list;
    // what Copy PGN hands over matches what the list shows.
    const PGN = '[White "A"]\n[Black "B"]\n[Result "*"]\n\n1. e4 {Best by test} e5 (1... c5 {Sicilian}) 2. Nf3 *\n';

    it('exports comments and variations while the toggle is on', () => {
        const game = createGame(PGN);
        const out = game.getReadablePgn();
        expect(out).toContain('{Best by test}');
        expect(out).toContain('1... c5');
    });

    it('exports bare moves once comments are toggled off', () => {
        const game = createGame(PGN);
        game.toggleComments();
        const out = game.getReadablePgn();
        expect(out).not.toContain('Best by test');
        expect(out).not.toContain('c5');
        expect(out).toContain('1. e4 e5 2. Nf3 *');
        expect(out).toContain('[White "A"]');
    });

    it('comes back when the toggle goes on again', () => {
        const game = createGame(PGN);
        game.toggleComments();
        game.toggleComments();
        expect(game.getReadablePgn()).toContain('{Best by test}');
    });
});
