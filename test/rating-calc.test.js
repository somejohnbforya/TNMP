import { describe, it, expect } from 'vitest';
import {
    winningExpectancy,
    effectiveGames,
    provisionalExpectancy,
    specialRating,
    standardRating,
    estimateRating,
} from '../src/rating-calc.js';

function game(oppRating, score) {
    return { oppRating, score };
}

describe('winningExpectancy', () => {
    it('is 0.5 against an equal opponent', () => {
        expect(winningExpectancy(1500, 1500)).toBe(0.5);
    });

    it('follows the logistic curve at ±100 points', () => {
        // 1/(1 + 10^-0.25) = 0.6400649998...
        expect(winningExpectancy(1500, 1400)).toBeCloseTo(0.640065, 5);
        expect(winningExpectancy(1400, 1500)).toBeCloseTo(0.359935, 5);
    });

    it('sums to 1 for the two players of a game', () => {
        expect(winningExpectancy(1830, 1610) + winningExpectancy(1610, 1830)).toBeCloseTo(1, 12);
    });
});

describe('effectiveGames', () => {
    it('caps prior games by the rating-based ceiling', () => {
        // At 1500: 50/sqrt(0.662 + 0.00000739 * 1069^2) = 16.568...
        expect(effectiveGames(1500, 30)).toBeCloseTo(16.5684, 3);
    });

    it('uses the raw count when below the ceiling', () => {
        expect(effectiveGames(1500, 10)).toBe(10);
    });

    it('caps at 50 above 2355', () => {
        expect(effectiveGames(2400, 120)).toBe(50);
    });
});

describe('provisionalExpectancy', () => {
    it('is linear within ±400 and saturates outside', () => {
        expect(provisionalExpectancy(1500, 1500)).toBe(0.5);
        expect(provisionalExpectancy(1700, 1500)).toBe(0.75);
        expect(provisionalExpectancy(1100, 1500)).toBe(0);
        expect(provisionalExpectancy(1900, 1500)).toBe(1);
    });
});

describe('standardRating', () => {
    it('computes K, expectancy, and bonus for a strong event', () => {
        // R0=1500, N=30 → N'=16.5684; opponents 1400 W, 1500 W, 1600 D, 1700 L.
        // S=2.5, E=1.740253, K=800/20.5684=38.8947,
        // base=38.8947*0.759747=29.550, bonus=29.550-10*sqrt(4)=9.550.
        const r = standardRating(1500, 30, [
            game(1400, 1),
            game(1500, 1),
            game(1600, 0.5),
            game(1700, 0),
        ]);
        expect(r.k).toBeCloseTo(38.8947, 3);
        expect(r.expected).toBeCloseTo(1.740253, 5);
        expect(r.bonus).toBeCloseTo(9.5503, 3);
        expect(r.rating).toBeCloseTo(1539.1, 1);
    });

    it('awards no bonus when the gain is under the threshold', () => {
        const r = standardRating(1500, 30, [game(1500, 1), game(1500, 0), game(1500, 0.5), game(1500, 0.5)]);
        expect(r.bonus).toBe(0);
        expect(r.change).toBeCloseTo(0, 10);
    });

    it('uses max(m, 4) in the bonus threshold for short events', () => {
        // One big upset in a 1-game event: base = K*(1-E) with the
        // threshold still 10*sqrt(4)=20, not 10*sqrt(1).
        const r = standardRating(1500, 10, [game(1900, 1)]);
        const k = 800 / 11;
        const base = k * (1 - winningExpectancy(1500, 1900));
        expect(r.bonus).toBeCloseTo(Math.max(0, base - 20), 10);
    });

    it('loses points symmetrically with no negative bonus', () => {
        const r = standardRating(1500, 30, [game(1400, 0), game(1500, 0), game(1600, 0), game(1700, 0)]);
        expect(r.bonus).toBe(0);
        expect(r.change).toBeCloseTo((800 / 20.5684) * -1.740253, 2);
    });
});

describe('specialRating', () => {
    it('rates a single win at opponent + 400 for a first-time player', () => {
        expect(specialRating(1300, 0, [game(1520, 1)])).toBe(1920);
    });

    it('rates a single draw at the opponent rating', () => {
        expect(specialRating(1300, 0, [game(1520, 0.5)])).toBe(1520);
    });

    it('rates a single loss at opponent - 400', () => {
        expect(specialRating(1300, 0, [game(1520, 0)])).toBe(1120);
    });

    it('matches the hand-solved value for a mixed provisional event', () => {
        // R0=1400 with N=4 prior games, then W vs 1500, L vs 1700, D vs 1300.
        // N'=4 (below the ~15.2 ceiling at 1400), S'=1.5+2=3.5.
        // f(R) = 4*PWe(R,1400) + PWe(R,1500) + PWe(R,1700) + PWe(R,1300) - 3.5.
        // With all terms unsaturated: 3.5 + (7R - 5600 - 4500)/800 = 3.5
        // → R = 10100/7 = 1442.857, and |R - opp| < 400 holds for all → valid.
        expect(specialRating(1400, 4, [game(1500, 1), game(1700, 0), game(1300, 0.5)])).toBeCloseTo(
            10100 / 7,
            6,
        );
    });

    it('rates a perfect score at highest opponent + 400', () => {
        // 3-0 for an unrated player: the zero set is [1600+400, ∞) and the
        // performance estimate (4500 + 1200)/3 = 1900 clamps up to 2000 —
        // the classic perfect-score provisional rule.
        const r = specialRating(1300, 0, [game(1400, 1), game(1500, 1), game(1600, 1)]);
        expect(r).toBeCloseTo(2000, 6);
    });

    it('never returns below the absolute floor of 100', () => {
        expect(specialRating(400, 0, [game(450, 0), game(500, 0)])).toBe(100);
    });

    it('caps at 2700', () => {
        expect(specialRating(2600, 3, [game(2650, 1), game(2680, 1), game(2600, 1)])).toBe(2700);
    });

    it('a win never lowers the special rating', () => {
        const before = specialRating(1400, 4, [game(1500, 1), game(1700, 0)]);
        const after = specialRating(1400, 4, [game(1500, 1), game(1700, 0), game(900, 1)]);
        expect(after).toBeGreaterThanOrEqual(before);
    });

    it('returns null with no games', () => {
        expect(specialRating(1400, 4, [])).toBeNull();
    });
});

describe('estimateRating', () => {
    it('routes provisional players to the special algorithm', () => {
        const r = estimateRating(1300, 0, [game(1520, 1)]);
        expect(r.provisional).toBe(true);
        expect(r.rating).toBe(1920);
        expect(r.change).toBe(620);
    });

    it('routes established players to the standard algorithm', () => {
        const r = estimateRating(1500, 30, [game(1400, 1), game(1500, 1), game(1600, 0.5), game(1700, 0)]);
        expect(r.provisional).toBe(false);
        expect(r.rating).toBeCloseTo(1539.1, 1);
    });

    it('uses special exactly through 8 prior games and standard from 9', () => {
        expect(estimateRating(1400, 8, [game(1400, 1)]).provisional).toBe(true);
        expect(estimateRating(1400, 9, [game(1400, 1)]).provisional).toBe(false);
    });

    it('skips unplayed rounds and unrated opponents', () => {
        const r = estimateRating(1500, 30, [
            game(1400, 1),
            game(NaN, 1),
            game(1600, null),
            game(1500, 1),
            game(1600, 0.5),
            game(1700, 0),
        ]);
        expect(r.rating).toBeCloseTo(1539.1, 1);
    });

    it('returns null when nothing has been played', () => {
        expect(estimateRating(1500, 30, [game(1600, null)])).toBeNull();
    });
});
