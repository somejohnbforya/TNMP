/**
 * US Chess rating math — the estimator's "first pass" computation.
 *
 * Implements the standard and special (provisional) algorithms from
 * "The US Chess Rating System" (Glickman & Doan, revised July 2025):
 * winning expectancy, effective games, K = 800/(N' + m), bonus points
 * with the B = 10 threshold, and the piecewise-linear special rating
 * for players with 8 or fewer prior games. Peak-based rating floors
 * (highest attained rating minus 200) are applied when a floor is
 * supplied; money-prize and Original Life Master floors depend on
 * facts no rating history can reveal, so callers must pass those in.
 */

export const BONUS_B = 10;

// Every rating has this floor, even without a peak-based one.
export const ABSOLUTE_FLOOR = 100;

/**
 * Peak-based rating floor: highest attained rating minus 200, rounded
 * down to the nearest 100. Peak-based floors exist from 1200 to 2100,
 * so a peak under 1400 leaves only the absolute floor.
 */
export function ratingFloor(peak) {
    if (!Number.isFinite(peak) || peak < 1400) return ABSOLUTE_FLOOR;
    return Math.min(2100, Math.floor((peak - 200) / 100) * 100);
}

/** Expected score for a player rated r against an opponent rated oppR. */
export function winningExpectancy(r, oppR) {
    return 1 / (1 + Math.pow(10, -(r - oppR) / 400));
}

/**
 * Effective number of prior games N'. Prior games count for less when
 * the rating is low (it moved recently, so it's less trustworthy).
 */
export function effectiveGames(rating, priorGames) {
    const cap = rating > 2355 ? 50 : 50 / Math.sqrt(0.662 + 0.00000739 * Math.pow(2569 - rating, 2));
    return Math.min(priorGames, cap);
}

/**
 * Provisional winning expectancy — the piecewise-linear expectancy used
 * by the special rating algorithm. Saturates at ±400 points.
 */
export function provisionalExpectancy(r, oppR) {
    if (r <= oppR - 400) return 0;
    if (r >= oppR + 400) return 1;
    return 0.5 + (r - oppR) / 800;
}

/**
 * Special rating for provisional players (N <= 8 prior games).
 *
 * Finds the rating R at which the adjusted score equals the sum of
 * provisional winning expectancies, treating the prior rating as N'
 * virtual draws against an opponent rated r0. The objective is monotone
 * piecewise-linear, so the zero set is a (possibly unbounded) interval
 * [za, zb]; per the spec, the performance-rating first estimate is
 * clamped into that interval, and the result into [100, 2700].
 *
 * games: array of { oppRating, score } with score 1, 0.5, or 0.
 */
export function specialRating(r0, priorGames, games) {
    const m = games.length;
    if (m === 0) return null;
    const nPrime = priorGames > 0 ? effectiveGames(r0, priorGames) : 0;
    const s = games.reduce((sum, g) => sum + g.score, 0);
    const sPrime = s + nPrime / 2;

    const virtual = nPrime > 0 ? [{ oppRating: r0, weight: nPrime }] : [];
    const terms = virtual.concat(games.map((g) => ({ oppRating: g.oppRating, weight: 1 })));
    const objective = (r) =>
        terms.reduce((sum, t) => sum + t.weight * provisionalExpectancy(r, t.oppRating), 0) - sPrime;

    // Performance-rating first estimate over real + virtual games.
    const totalGames = nPrime + m;
    const oppSum = nPrime * r0 + games.reduce((sum, g) => sum + g.oppRating, 0);
    const estimate = (oppSum + 400 * (2 * sPrime - totalGames)) / totalGames;

    // The objective is nondecreasing and only bends at opponent ratings
    // ±400. It is flat at -sPrime below the first knot and flat at
    // (totalWeight - sPrime) above the last, so its zero set is the
    // interval [za, zb] located by scanning knot values.
    const knots = [...new Set(terms.flatMap((t) => [t.oppRating - 400, t.oppRating + 400]))].sort((a, b) => a - b);
    const totalWeight = nPrime + m;
    const values = knots.map(objective);
    const cross = (i) => knots[i] + ((knots[i + 1] - knots[i]) * -values[i]) / (values[i + 1] - values[i]);

    let za;
    if (sPrime === 0) {
        za = -Infinity; // zero score: the zero set extends left without bound
    } else {
        const i = values.findIndex((v) => v >= 0);
        za = values[i] === 0 ? knots[i] : cross(i - 1);
    }
    let zb;
    if (sPrime === totalWeight) {
        zb = Infinity; // perfect score: the zero set extends right without bound
    } else {
        let i = values.length - 1;
        while (values[i] > 0) i--;
        zb = values[i] === 0 ? knots[i] : cross(i);
    }

    const solved = Math.min(Math.max(estimate, za), zb);
    return Math.min(Math.max(solved, 100), 2700);
}

/**
 * Standard rating update for established players (N > 8 prior games).
 * Returns { rating, change, k, expected, bonus }.
 */
export function standardRating(r0, priorGames, games) {
    const m = games.length;
    if (m === 0) return null;
    const nPrime = effectiveGames(r0, priorGames);
    const s = games.reduce((sum, g) => sum + g.score, 0);
    const expected = games.reduce((sum, g) => sum + winningExpectancy(r0, g.oppRating), 0);
    const k = 800 / (nPrime + m);
    const base = k * (s - expected);
    const bonus = Math.max(0, base - BONUS_B * Math.sqrt(Math.max(m, 4)));
    const change = base + bonus;
    return { rating: r0 + change, change, k, expected, bonus };
}

/**
 * Full estimate. Picks the special algorithm for provisional players
 * (8 or fewer prior games) and the standard one otherwise, then holds
 * the result at the player's rating floor (the absolute 100 floor when
 * no peak-based floor is passed).
 *
 * Returns { rating, rawRating, change, provisional, k, expected,
 * bonus, floored } where rating is unrounded, floored means the floor
 * engaged, and rawRating is the pre-floor value; display code rounds
 * to the nearest integer.
 */
export function estimateRating(r0, priorGames, games, floor = ABSOLUTE_FLOOR) {
    const played = games.filter((g) => g.score != null && Number.isFinite(g.oppRating));
    if (played.length === 0) return null;

    let result;
    if (priorGames <= 8) {
        const rating = specialRating(r0, priorGames, played);
        result = {
            rating,
            provisional: true,
            k: null,
            expected: played.reduce((sum, g) => sum + provisionalExpectancy(r0, g.oppRating), 0),
            bonus: 0,
        };
    } else {
        result = { ...standardRating(r0, priorGames, played), provisional: false };
    }

    const held = Math.max(floor, ABSOLUTE_FLOOR);
    const floored = result.rating < held;
    const rating = floored ? held : result.rating;
    return { ...result, rating, rawRating: result.rating, change: rating - r0, floored };
}
