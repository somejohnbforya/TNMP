import { describe, it, expect } from 'vitest';
import { getRandomMeme } from '../src/ui.js';
import { STATE } from '../src/config.js';

describe('getRandomMeme', () => {
    const states = [STATE.YES, STATE.NO, STATE.TOO_EARLY, STATE.IN_PROGRESS, STATE.RESULTS];

    for (const state of states) {
        it(`returns an img path and caption for state "${state}"`, () => {
            const meme = getRandomMeme(state);
            expect(meme.img).toMatch(/^memes\//);
            expect(meme.img).toMatch(/\.webp$/);
            expect(typeof meme.text).toBe('string');
            expect(meme.text.length).toBeGreaterThan(0);
        });
    }

    it('returns null for states without memes', () => {
        expect(getRandomMeme(STATE.OFF_SEASON)).toBeNull();
        expect(getRandomMeme(null)).toBeNull();
    });

    it('returns different memes on repeated calls (randomness check)', () => {
        // Run enough times to get at least 2 different results (NO has 11 images)
        const results = new Set();
        for (let i = 0; i < 50; i++) {
            results.add(getRandomMeme(STATE.NO).img);
        }
        expect(results.size).toBeGreaterThan(1);
    });
});
