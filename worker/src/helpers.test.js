import { describe, it, expect } from 'vitest';
import { extractRatingFloor, floorFromPeak, isExtraRated } from './helpers.js';

describe('extractRatingFloor', () => {
    it('reads a floor off the regular rating entry', () => {
        const data = {
            ratings: [
                { ratingSystem: 'Q', rating: 1500, floor: 1300 },
                { ratingSystem: 'R', rating: 1800, floor: 1600 },
            ],
        };
        expect(extractRatingFloor(data)).toBe(1600);
    });

    it('finds a floor-named field anywhere in the payload', () => {
        expect(extractRatingFloor({ ratingFloor: 1700 })).toBe(1700);
        expect(extractRatingFloor({ member: { rating_floor: '1500' } })).toBe(1500);
    });

    it('ignores values outside the credible 1200-2200 range', () => {
        expect(extractRatingFloor({ floor: 0 })).toBe(null);
        expect(extractRatingFloor({ floor: 100 })).toBe(null);
        expect(extractRatingFloor({ floor: 3000 })).toBe(null);
    });

    it('returns null when the payload has no floor', () => {
        expect(extractRatingFloor({ ratings: [{ ratingSystem: 'R', rating: 1800 }] })).toBe(null);
        expect(extractRatingFloor(null)).toBe(null);
    });
});

describe('floorFromPeak', () => {
    it('is peak minus 200 at the floor just below', () => {
        // The worked example from the US Chess rules: peak 1941 → 1700.
        expect(floorFromPeak(1941)).toBe(1700);
        expect(floorFromPeak(1400)).toBe(1200);
    });

    it('produces no floor below a 1400 peak', () => {
        expect(floorFromPeak(1399)).toBe(null);
        expect(floorFromPeak(null)).toBe(null);
    });

    it('caps at 2100', () => {
        expect(floorFromPeak(2500)).toBe(2100);
    });
});

describe('isExtraRated', () => {
    it('recognizes the Extra Rated section under the spellings MI uses', () => {
        expect(isExtraRated('Extra Rated')).toBe(true);
        expect(isExtraRated('Extra rated')).toBe(true);
        expect(isExtraRated('Extra Rated Games')).toBe(true);
    });

    it('is false for regular sections and a missing name', () => {
        expect(isExtraRated('2000+')).toBe(false);
        expect(isExtraRated('u1600')).toBe(false);
        expect(isExtraRated(null)).toBe(false);
    });
});
