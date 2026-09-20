import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MIN_CEILING_GAP,
    ORGASM_BOOST_CAP,
    SURVIVAL_BREACH_TICKS,
    sanitizeHrLimits,
    computeEffectiveCeiling,
    parseSessionDuration,
    countSurvivalBreach,
    isSurvivalDefeated,
    MIN_STALL_GUARD_SECONDS,
    MAX_STALL_GUARD_SECONDS,
    DEFAULT_STALL_GUARD_SECONDS,
    clampStallGuardSeconds,
    tickStallGuard
} from './session-rules.js';

describe('sanitizeHrLimits', () => {
    it('parses typed strings', () => {
        assert.deepEqual(sanitizeHrLimits('70', '140'), { minHr: 70, maxHr: 140, valid: true, invalid: [] });
    });

    it('falls back to the last known-good value on garbage and flags the field', () => {
        const out = sanitizeHrLimits('abc', '', { minHr: 65, maxHr: 150 });
        assert.equal(out.minHr, 65);
        assert.equal(out.maxHr, 150);
        assert.equal(out.valid, false);
        assert.deepEqual(out.invalid, ['min', 'max']);
    });

    it('never raises a typed ceiling: an inverted pair is kept but flagged', () => {
        const out = sanitizeHrLimits(140, 120);
        assert.equal(out.minHr, 140);
        assert.equal(out.maxHr, 120);
        assert.equal(out.valid, false);
    });

    it('rejects physiologically impossible numbers', () => {
        assert.equal(sanitizeHrLimits(70, 999).valid, false);
        assert.equal(sanitizeHrLimits(-5, 140).valid, false);
    });
});

describe('computeEffectiveCeiling', () => {
    const base = { minHr: 70, maxHr: 140 };

    it('returns the typed ceiling when nothing is active', () => {
        const out = computeEffectiveCeiling(base);
        assert.equal(out.maxHr, 140);
        assert.equal(out.minHr, 70);
        assert.equal(out.orgasmBoost, 0);
    });

    it('stacks learned, dual-stim and decay offsets downward', () => {
        const out = computeEffectiveCeiling({
            ...base,
            learnedOffset: 5,
            dualStimActive: true,
            dualDampening: true,
            dualDampeningBpm: 15,
            adaptiveDecay: true,
            edges: 4,
            decayEdgeCount: 2,
            decayBpm: 2,
            decayFloor: 100
        });
        assert.equal(out.learnedOffset, 5);
        assert.equal(out.dualOffset, 15);
        assert.equal(out.totalDecay, 4);
        assert.equal(out.appliedDecay, 4);
        assert.equal(out.maxHr, 140 - 5 - 15 - 4);
    });

    it('decay floor stops the decay but never raises the ceiling', () => {
        // Typed ceiling 100 with a 105 floor: the old code lifted max to 105.
        const out = computeEffectiveCeiling({
            minHr: 70,
            maxHr: 100,
            adaptiveDecay: true,
            edges: 2,
            decayEdgeCount: 2,
            decayBpm: 2,
            decayFloor: 105
        });
        assert.equal(out.maxHr, 100);
        assert.equal(out.appliedDecay, 0);
        assert.equal(out.decayFloored, true);
    });

    it('decay floor is clamped to min + gap', () => {
        const out = computeEffectiveCeiling({
            minHr: 100,
            maxHr: 140,
            adaptiveDecay: true,
            edges: 40,
            decayEdgeCount: 1,
            decayBpm: 5,
            decayFloor: 80
        });
        assert.equal(out.maxHr, 100 + MIN_CEILING_GAP);
    });

    it('offsets never pull the ceiling below min + gap', () => {
        const out = computeEffectiveCeiling({ minHr: 120, maxHr: 140, learnedOffset: 30, dualStimActive: true, dualDampening: true });
        assert.equal(out.maxHr, 120 + MIN_CEILING_GAP);
    });

    it('a typed ceiling closer than the gap is honoured, not raised', () => {
        const out = computeEffectiveCeiling({ minHr: 130, maxHr: 138, learnedOffset: 10 });
        assert.equal(out.maxHr, 138);
    });

    it('ignores non-finite offsets', () => {
        const out = computeEffectiveCeiling({ ...base, learnedOffset: NaN, adaptiveDecay: true, edges: NaN });
        assert.equal(out.maxHr, 140);
    });

    it('applies and caps the orgasm boost', () => {
        assert.equal(computeEffectiveCeiling({ ...base, orgasmBoost: 12 }).maxHr, 152);
        assert.equal(computeEffectiveCeiling({ ...base, orgasmBoost: 500 }).maxHr, 140 + ORGASM_BOOST_CAP);
        assert.equal(computeEffectiveCeiling({ ...base, orgasmBoost: -3 }).maxHr, 140);
    });
});

describe('parseSessionDuration', () => {
    it('endless is always zero', () => {
        assert.deepEqual(parseSessionDuration({ mode: 'endless' }), { targetSeconds: 0, valid: true, invalid: [] });
    });

    it('fixed uses the typed minutes', () => {
        assert.equal(parseSessionDuration({ mode: 'fixed', fixedMinutes: '30' }).targetSeconds, 1800);
    });

    it('fixed rejects zero, negative and non-numeric values', () => {
        for (const bad of ['0', '-4', 'abc', '', null, undefined, NaN]) {
            const out = parseSessionDuration({ mode: 'fixed', fixedMinutes: bad });
            assert.equal(out.valid, false, `fixed ${String(bad)} should be invalid`);
            assert.equal(out.targetSeconds, 0);
            assert.deepEqual(out.invalid, ['fixed']);
        }
    });

    it('range picks inside the window inclusive', () => {
        const lo = parseSessionDuration({ mode: 'range', minMinutes: 25, maxMinutes: 45, random: () => 0 });
        const hi = parseSessionDuration({ mode: 'range', minMinutes: 25, maxMinutes: 45, random: () => 0.9999 });
        assert.equal(lo.targetSeconds, 25 * 60);
        assert.equal(hi.targetSeconds, 45 * 60);
        const same = parseSessionDuration({ mode: 'range', minMinutes: 10, maxMinutes: 10, random: () => 0.5 });
        assert.equal(same.targetSeconds, 600);
    });

    it('range flags an inverted window and falls back to endless', () => {
        const out = parseSessionDuration({ mode: 'range', minMinutes: 45, maxMinutes: 25 });
        assert.equal(out.valid, false);
        assert.equal(out.targetSeconds, 0);
        assert.ok(out.invalid.includes('min') && out.invalid.includes('max'));
    });

    it('range flags only the broken field', () => {
        const out = parseSessionDuration({ mode: 'range', minMinutes: 'x', maxMinutes: 40 });
        assert.deepEqual(out.invalid, ['min']);
        assert.equal(out.targetSeconds, 0);
    });
});

describe('survival breach counter', () => {
    it('counts consecutive ticks at or above the ceiling and resets below it', () => {
        let ticks = 0;
        ticks = countSurvivalBreach(ticks, 141, 140);
        ticks = countSurvivalBreach(ticks, 140, 140);
        assert.equal(ticks, 2);
        assert.equal(isSurvivalDefeated(ticks), false);
        ticks = countSurvivalBreach(ticks, 139, 140);
        assert.equal(ticks, 0);
    });

    it('defeats only after the configured streak', () => {
        let ticks = 0;
        for (let i = 0; i < SURVIVAL_BREACH_TICKS; i++) ticks = countSurvivalBreach(ticks, 150, 140);
        assert.equal(isSurvivalDefeated(ticks), true);
    });

    it('treats non-finite readings as no breach', () => {
        assert.equal(countSurvivalBreach(2, NaN, 140), 0);
        assert.equal(countSurvivalBreach(2, 150, NaN), 0);
    });

    it('a tick without a new reading leaves the streak untouched', () => {
        // A watch pushing every 5 s holds one spike across five ticks.
        let ticks = countSurvivalBreach(0, 141, 140);
        for (let i = 0; i < 4; i++) ticks = countSurvivalBreach(ticks, 141, 140, false);
        assert.equal(ticks, 1);
        assert.equal(isSurvivalDefeated(ticks), false);
        ticks = countSurvivalBreach(ticks, 139, 140, false);
        assert.equal(ticks, 1, 'a held value is not a new reading below the ceiling either');
        ticks = countSurvivalBreach(ticks, 139, 140, true);
        assert.equal(ticks, 0);
    });
});

describe('stall guard', () => {
    it('clamps the typed timeout to its range and falls back on garbage', () => {
        assert.equal(clampStallGuardSeconds(-5), MIN_STALL_GUARD_SECONDS);
        assert.equal(clampStallGuardSeconds('99'), MAX_STALL_GUARD_SECONDS);
        assert.equal(clampStallGuardSeconds('12'), 12);
        assert.equal(clampStallGuardSeconds('abc'), DEFAULT_STALL_GUARD_SECONDS);
        assert.equal(clampStallGuardSeconds(undefined), DEFAULT_STALL_GUARD_SECONDS);
        assert.equal(clampStallGuardSeconds(NaN), DEFAULT_STALL_GUARD_SECONDS);
    });

    it('counts up while armed and edged and engages at the timeout', () => {
        let g = { seconds: 0, engaged: false };
        for (let i = 0; i < 2; i++) g = tickStallGuard(g, { armed: true, isEdged: true, timeoutSeconds: 3 });
        assert.deepEqual(g, { seconds: 2, engaged: false, justEngaged: false, justReleased: false });
        g = tickStallGuard(g, { armed: true, isEdged: true, timeoutSeconds: 3 });
        assert.deepEqual(g, { seconds: 3, engaged: true, justEngaged: true, justReleased: false });
        g = tickStallGuard(g, { armed: true, isEdged: true, timeoutSeconds: 3 });
        assert.equal(g.justEngaged, false, 'engages once');
        // A negative typed timeout is clamped, so the guard cannot fire on the first tick.
        assert.equal(tickStallGuard({ seconds: 0 }, { armed: true, isEdged: true, timeoutSeconds: -5 }).engaged, false);
    });

    it('releases at once when disarmed while engaged, even with the pulse still at the ceiling', () => {
        const engaged = { seconds: 9, engaged: true };
        const off = tickStallGuard(engaged, { armed: false, isEdged: true, timeoutSeconds: 8 });
        assert.deepEqual(off, { seconds: 0, engaged: false, justEngaged: false, justReleased: true });
        const released = tickStallGuard(engaged, { armed: true, isEdged: false, timeoutSeconds: 8 });
        assert.equal(released.engaged, false);
        assert.equal(released.justReleased, true);
        const idle = tickStallGuard({ seconds: 0, engaged: false }, { armed: false, isEdged: true, timeoutSeconds: 8 });
        assert.equal(idle.justReleased, false);
    });
});
