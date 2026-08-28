import { describe, it, expect } from 'vitest';
import {
    isAllowedPushEndpoint,
    timingSafeEqualStr,
    isAdminRequest,
} from './helpers.js';

// Minimal request stub: headers.get(name) reads from a plain object.
const req = (headers = {}) => ({
    headers: { get: (k) => (k in headers ? headers[k] : null) },
});

describe('isAllowedPushEndpoint', () => {
    it('accepts real push-service hosts', () => {
        expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
        expect(isAllowedPushEndpoint('https://web.push.apple.com/xyz')).toBe(true);
        expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
        expect(isAllowedPushEndpoint('https://autopush-shard.push.services.mozilla.com/x')).toBe(true);
        expect(isAllowedPushEndpoint('https://wns2-by3p.notify.windows.com/w/?token=abc')).toBe(true);
    });

    it('rejects arbitrary / attacker-chosen hosts', () => {
        expect(isAllowedPushEndpoint('https://evil.example/collect')).toBe(false);
        expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.example/x')).toBe(false);
        expect(isAllowedPushEndpoint('https://notfcm.googleapis.com/x')).toBe(false);
        expect(isAllowedPushEndpoint('http://fcm.googleapis.com/x')).toBe(false); // not https
        expect(isAllowedPushEndpoint('https://.notify.windows.com/x')).toBe(false); // bare suffix
        expect(isAllowedPushEndpoint('not a url')).toBe(false);
        expect(isAllowedPushEndpoint('')).toBe(false);
    });
});

describe('timingSafeEqualStr', () => {
    it('true only for identical strings', () => {
        expect(timingSafeEqualStr('secret', 'secret')).toBe(true);
        expect(timingSafeEqualStr('secret', 'Secret')).toBe(false);
        expect(timingSafeEqualStr('secret', 'secre')).toBe(false);
        expect(timingSafeEqualStr('secret', 'secretx')).toBe(false);
    });
    it('false for non-strings', () => {
        expect(timingSafeEqualStr(null, 'x')).toBe(false);
        expect(timingSafeEqualStr('x', undefined)).toBe(false);
        expect(timingSafeEqualStr(1, 1)).toBe(false);
    });
});

describe('isAdminRequest', () => {
    const env = { ADMIN_TOKEN: 'admintok' };
    it('accepts a matching Bearer header', () => {
        expect(isAdminRequest(req({ Authorization: 'Bearer admintok' }), env)).toBe(true);
    });
    it('accepts a matching body token', () => {
        expect(isAdminRequest(req({}), env, 'admintok')).toBe(true);
    });
    it('rejects missing / wrong tokens', () => {
        expect(isAdminRequest(req({}), env)).toBe(false);
        expect(isAdminRequest(req({ Authorization: 'Bearer nope' }), env)).toBe(false);
        expect(isAdminRequest(req({}), env, 'nope')).toBe(false);
    });
    it('falls back to VAPID_PRIVATE_KEY when ADMIN_TOKEN is unset', () => {
        const e2 = { VAPID_PRIVATE_KEY: 'vapidkey' };
        expect(isAdminRequest(req({ Authorization: 'Bearer vapidkey' }), e2)).toBe(true);
        expect(isAdminRequest(req({ Authorization: 'Bearer wrong' }), e2)).toBe(false);
    });
    it('rejects everything when no secret is configured', () => {
        expect(isAdminRequest(req({ Authorization: 'Bearer anything' }), {}, 'anything')).toBe(false);
    });
});

