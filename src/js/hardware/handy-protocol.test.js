import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    HANDY_MODE,
    HANDY_MIN_SLIDE_GAP,
    clampPercent,
    clampVelocity,
    normalizeSlideRange,
    normalizeEnvelope,
    classifyHandyResponse,
    parseBatteryLevel,
    describeHandyInfo
} from './handy-protocol.js';

describe('handy mode constants', () => {
    it('matches the v2 spec numbering', () => {
        assert.equal(HANDY_MODE.HAMP, 0);
        assert.equal(HANDY_MODE.HSSP, 1);
        assert.equal(HANDY_MODE.HDSP, 2);
        assert.equal(HANDY_MODE.MAINTENANCE, 3);
        assert.equal(HANDY_MODE.HBSP, 4);
    });
});

describe('clampPercent / clampVelocity', () => {
    it('clamps and rounds to integer percent', () => {
        assert.equal(clampPercent(-5), 0);
        assert.equal(clampPercent(105), 100);
        assert.equal(clampPercent(42.6), 43);
        assert.equal(clampPercent('37'), 37);
    });
    it('falls back on garbage', () => {
        assert.equal(clampPercent('abc', 55), 55);
        assert.equal(clampPercent(undefined, 12), 12);
        assert.equal(clampVelocity(NaN), 0);
        assert.equal(clampVelocity(250), 100);
    });
});

describe('normalizeSlideRange', () => {
    it('passes a valid range through', () => {
        assert.deepEqual(normalizeSlideRange(20, 80), { min: 20, max: 80 });
    });
    it('clamps to 0-100 and orders min < max', () => {
        assert.deepEqual(normalizeSlideRange(-10, 130), { min: 0, max: 100 });
        assert.deepEqual(normalizeSlideRange(80, 20), { min: 20, max: 80 });
    });
    it('enforces the minimum gap by widening toward the envelope max', () => {
        assert.deepEqual(normalizeSlideRange(50, 50), { min: 50, max: 50 + HANDY_MIN_SLIDE_GAP });
        assert.deepEqual(normalizeSlideRange(30, 33, 0, 100), { min: 30, max: 40 });
    });
    it('widens downward when the envelope top is already reached', () => {
        assert.deepEqual(normalizeSlideRange(100, 100, 0, 100), { min: 90, max: 100 });
        assert.deepEqual(normalizeSlideRange(78, 80, 20, 80), { min: 70, max: 80 });
    });
    it('never leaves the hardware envelope', () => {
        assert.deepEqual(normalizeSlideRange(0, 100, 15, 85), { min: 15, max: 85 });
        assert.deepEqual(normalizeSlideRange(5, 10, 15, 85), { min: 15, max: 25 });
        assert.deepEqual(normalizeSlideRange(90, 99, 15, 85), { min: 75, max: 85 });
    });
    it('grows past a too-narrow envelope only as a last resort', () => {
        const out = normalizeSlideRange(50, 52, 50, 52);
        assert.ok(out.max - out.min >= HANDY_MIN_SLIDE_GAP);
        assert.ok(out.min >= 0 && out.max <= 100);
    });
    it('rounds fractional input to integers', () => {
        const out = normalizeSlideRange(10.4, 60.6);
        assert.deepEqual(out, { min: 10, max: 61 });
        assert.ok(Number.isInteger(out.min) && Number.isInteger(out.max));
    });
});

describe('normalizeEnvelope', () => {
    it('keeps a sane envelope untouched', () => {
        assert.deepEqual(normalizeEnvelope(15, 85), { min: 15, max: 85 });
    });
    it('clamps to 0-100', () => {
        assert.deepEqual(normalizeEnvelope(-20, 140), { min: 0, max: 100 });
    });
    it('moves max when min was edited into a collision', () => {
        assert.deepEqual(normalizeEnvelope(85, 80, 'min'), { min: 85, max: 95 });
        assert.deepEqual(normalizeEnvelope(60, 65, 'min'), { min: 60, max: 70 });
        // min 95 cannot hold a 10% stroke below 100, so min itself is pulled back.
        assert.deepEqual(normalizeEnvelope(95, 90, 'min'), { min: 90, max: 100 });
    });
    it('moves min when max was edited into a collision', () => {
        assert.deepEqual(normalizeEnvelope(60, 65, 'max'), { min: 55, max: 65 });
        assert.deepEqual(normalizeEnvelope(5, 5, 'max'), { min: 0, max: 10 });
    });
    it('falls back when the edited bound sits at the hard limit', () => {
        assert.deepEqual(normalizeEnvelope(100, 100, 'min'), { min: 90, max: 100 });
        assert.deepEqual(normalizeEnvelope(0, 0, 'max'), { min: 0, max: 10 });
    });
    it('uses defaults for empty input', () => {
        assert.deepEqual(normalizeEnvelope('', ''), { min: 0, max: 100 });
    });
});

describe('classifyHandyResponse', () => {
    it('accepts a plain 200 with a result code', () => {
        assert.deepEqual(classifyHandyResponse(true, 200, { result: 0 }), { ok: true, message: '', code: null });
        assert.equal(classifyHandyResponse(true, 200, { result: 1 }).ok, true);
        assert.equal(classifyHandyResponse(true, 200, { connected: true }).ok, true);
    });
    it('rejects a non-ok HTTP status', () => {
        const out = classifyHandyResponse(false, 401, null, '/connected');
        assert.equal(out.ok, false);
        assert.match(out.message, /HTTP 401/);
        assert.match(out.message, /\/connected/);
    });
    it('rejects an error object even with HTTP 200', () => {
        const out = classifyHandyResponse(true, 200, { error: { code: 1001, message: 'Invalid connection key' } }, '/mode');
        assert.equal(out.ok, false);
        assert.equal(out.code, 1001);
        assert.match(out.message, /Invalid connection key/);
    });
    it('rejects result -1', () => {
        const out = classifyHandyResponse(true, 200, { result: -1 });
        assert.equal(out.ok, false);
        assert.equal(out.code, -1);
    });
    it('handles a non-JSON body', () => {
        assert.equal(classifyHandyResponse(true, 200, null).ok, true);
        assert.equal(classifyHandyResponse(false, 502, null).ok, false);
    });
});

describe('parseBatteryLevel', () => {
    it('returns null when the field is absent', () => {
        assert.equal(parseBatteryLevel({}), null);
        assert.equal(parseBatteryLevel(null), null);
        assert.equal(parseBatteryLevel({ battery: 'n/a' }), null);
    });
    it('does not scale integer percentages', () => {
        assert.equal(parseBatteryLevel({ battery: 1 }), 1);
        assert.equal(parseBatteryLevel({ battery: 85 }), 85);
        assert.equal(parseBatteryLevel({ batteryLevel: 100 }), 100);
    });
    it('scales fractional 0-1 values', () => {
        assert.equal(parseBatteryLevel({ battery: 0.42 }), 42);
        assert.equal(parseBatteryLevel({ battery: 0.999 }), 100);
    });
    it('clamps out-of-range values', () => {
        assert.equal(parseBatteryLevel({ battery: 140 }), 100);
        assert.equal(parseBatteryLevel({ battery: -3 }), null);
    });
});

describe('describeHandyInfo', () => {
    it('formats firmware and model', () => {
        assert.equal(describeHandyInfo({ fwVersion: '3.2.3', model: 'Handy 1.1' }), 'fw 3.2.3, Handy 1.1');
        assert.equal(describeHandyInfo({ fwVersion: '3.2.3' }), 'fw 3.2.3');
        assert.equal(describeHandyInfo({ hwVersion: '1.1' }), '1.1');
        assert.equal(describeHandyInfo({}), '');
        assert.equal(describeHandyInfo(null), '');
    });
});
