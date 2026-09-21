import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MIN_CEILING_GAP,
    ORGASM_BOOST_CAP,
    SURVIVAL_BREACH_TICKS,
    sanitizeHrLimits,
    computeEffectiveCeiling,
    parseSessionDuration,
    oracleTiming,
    rollOracleFate,
    tickEdgeTraining,
    clampTrainHoldSeconds,
    clampTrainEdges,
    DEFAULT_TRAIN_HOLD_SECONDS,
    DEFAULT_TRAIN_EDGES,
    MIN_TRAIN_HOLD_SECONDS,
    MAX_TRAIN_HOLD_SECONDS,
    MIN_TRAIN_EDGES,
    MAX_TRAIN_EDGES,
    countSurvivalBreach,
    isSurvivalDefeated,
    MIN_STALL_GUARD_SECONDS,
    MAX_STALL_GUARD_SECONDS,
    DEFAULT_STALL_GUARD_SECONDS,
    MIN_STALL_PAUSE_SECONDS,
    MAX_STALL_PAUSE_SECONDS,
    DEFAULT_STALL_PAUSE_SECONDS,
    clampStallGuardSeconds,
    clampStallPauseSeconds,
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
        assert.deepEqual(parseSessionDuration({ mode: 'endless' }), {
            targetSeconds: 0, minSeconds: 0, maxSeconds: 0, valid: true, invalid: []
        });
    });

    it('fixed uses the typed minutes as both ends of the window', () => {
        const out = parseSessionDuration({ mode: 'fixed', fixedMinutes: '30' });
        assert.equal(out.targetSeconds, 1800);
        assert.equal(out.minSeconds, 1800);
        assert.equal(out.maxSeconds, 1800);
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
        assert.equal(lo.minSeconds, 25 * 60);
        assert.equal(hi.maxSeconds, 45 * 60);
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

describe('oracle timing and fate', () => {
    it('blocks climax and denial before the mystery minimum', () => {
        const early = oracleTiming({ sessionSeconds: 5 * 60, minSeconds: 30 * 60, maxSeconds: 60 * 60, targetSeconds: 42 * 60 });
        assert.equal(early.canEnd, false);
        assert.equal(early.mustEnd, false);
        assert.equal(rollOracleFate(early, { random: () => 0 }), 'PURGATORY');
        assert.equal(rollOracleFate(early, { random: () => 0.99 }), 'PURGATORY');
    });

    it('opens the window at min and forces an ending at max', () => {
        const open = oracleTiming({ sessionSeconds: 30 * 60, minSeconds: 30 * 60, maxSeconds: 60 * 60, targetSeconds: 42 * 60 });
        assert.equal(open.canEnd, true);
        assert.equal(open.mustEnd, false);
        assert.equal(rollOracleFate(open, { random: () => 0 }), 'PURGATORY');
        const late = oracleTiming({ sessionSeconds: 42 * 60, minSeconds: 30 * 60, maxSeconds: 60 * 60, targetSeconds: 42 * 60 });
        assert.equal(late.mustEnd, true);
        const stillOpen = oracleTiming({ sessionSeconds: 40 * 60, minSeconds: 30 * 60, maxSeconds: 60 * 60, targetSeconds: 42 * 60 });
        assert.equal(stillOpen.mustEnd, false);
        assert.equal(stillOpen.canEnd, true);
        assert.equal(rollOracleFate(late, { random: () => 0.9, endgameType: 'orgasm' }), 'CLIMAX');
        assert.equal(rollOracleFate(late, { random: () => 0.1, endgameType: 'denial' }), 'DENIAL');
    });

    it('endless has no clock so any hold may end', () => {
        const open = oracleTiming({ sessionSeconds: 12, minSeconds: 0, maxSeconds: 0, targetSeconds: 0 });
        assert.equal(open.canEnd, true);
        assert.equal(open.mustEnd, false);
        assert.equal(rollOracleFate(open, { random: () => 0.5 }), 'CLIMAX');
    });

    it('a Fixed length still gives the Oracle a window to roll in', () => {
        // Fixed hands min === max === target, which used to leave a
        // zero-width window: every hold of the whole session was PURGATORY
        // and the game never chose anything.
        const fixed = (t) => oracleTiming({ sessionSeconds: t, minSeconds: 1800, maxSeconds: 1800, targetSeconds: 1800 });
        const early = fixed(5 * 60);
        assert.equal(early.canEnd, false);
        assert.equal(rollOracleFate(early, { random: () => 0.99 }), 'PURGATORY');

        const open = fixed(16 * 60);
        assert.equal(open.canEnd, true, 'the window opens inside the session');
        assert.equal(open.mustEnd, false);
        assert.equal(open.openAt, 900);
        assert.equal(open.closeAt, 1800);
        assert.ok(rollOracleFate(open, { random: () => 0.99 }) !== 'PURGATORY');

        const due = fixed(1800);
        assert.equal(due.mustEnd, true);
        assert.equal(rollOracleFate(due, { random: () => 0.9, endgameType: 'orgasm' }), 'CLIMAX');
    });

    it('a Mystery target on the minimum still honours the typed minimum', () => {
        // 1 roll in 21 lands the secret target on the wearer's minimum. The
        // window is NOT halved there: they typed 30 minutes to mean "do not
        // finish me before then", and they cannot see the roll, so climax and
        // denial stay locked until the minimum exactly as the README and the
        // mode card promise. Only a FIXED length (min === max === target)
        // opens halfway, because its window is otherwise zero-width.
        const timing = oracleTiming({ sessionSeconds: 20 * 60, minSeconds: 1800, maxSeconds: 3600, targetSeconds: 1800 });
        assert.equal(timing.openAt, 1800);
        assert.equal(timing.canEnd, false, 'locked before the typed minimum');
        assert.equal(timing.mustEnd, false);

        const atMin = oracleTiming({ sessionSeconds: 1800, minSeconds: 1800, maxSeconds: 3600, targetSeconds: 1800 });
        assert.equal(atMin.canEnd, true);
        assert.equal(atMin.mustEnd, true, 'the rolled target is still the latest it waits');

        // Half the typed minimum is the number the old rule unlocked at.
        const half = oracleTiming({ sessionSeconds: 901, minSeconds: 1800, maxSeconds: 3600, targetSeconds: 1800 });
        assert.equal(half.canEnd, false, 'never at half the minimum the wearer typed');

        // A Fixed length keeps its documented halfway ramp.
        const fixedRun = oracleTiming({ sessionSeconds: 901, minSeconds: 1800, maxSeconds: 1800, targetSeconds: 1800 });
        assert.equal(fixedRun.openAt, 900);
        assert.equal(fixedRun.canEnd, true);
    });

    it('later holds inside the window are likelier to end the session', () => {
        const at = (t) => oracleTiming({ sessionSeconds: t, minSeconds: 30 * 60, maxSeconds: 60 * 60, targetSeconds: 45 * 60 });
        assert.equal(rollOracleFate(at(30 * 60), { random: () => 0.5 }), 'PURGATORY');
        assert.ok(rollOracleFate(at(44 * 60), { random: () => 0.5 }) !== 'PURGATORY');
        // The ramp is monotone: the purgatory share only ever shrinks.
        let previous = 100;
        for (let t = 30 * 60; t <= 45 * 60; t += 60) {
            let purgatory = 0;
            for (let r = 0; r < 100; r++) {
                if (rollOracleFate(at(t), { random: () => r / 100 }) === 'PURGATORY') purgatory++;
            }
            assert.ok(purgatory <= previous, `purgatory share rose at ${t / 60} min`);
            previous = purgatory;
        }
    });

    it('a forced ending honours Soft Landing instead of flipping a coin', () => {
        const due = oracleTiming({ sessionSeconds: 45 * 60, minSeconds: 30 * 60, maxSeconds: 60 * 60, targetSeconds: 45 * 60 });
        assert.equal(due.mustEnd, true);
        // Every roll: the wearer asked for a tease-down, not a 50/50 that
        // can arm Force Orgasm on their behalf.
        for (let r = 0; r < 100; r++) {
            assert.equal(rollOracleFate(due, { random: () => r / 100, endgameType: 'rampdown' }), 'RAMPDOWN');
        }
        // An unknown endgame still resolves to an ending, never to nothing.
        assert.ok(['CLIMAX', 'DENIAL'].includes(rollOracleFate(due, { random: () => 0.2, endgameType: 'mystery-meat' })));
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
    it('clamps the typed timeouts to their ranges and falls back on garbage', () => {
        assert.equal(clampStallGuardSeconds(-5), MIN_STALL_GUARD_SECONDS);
        assert.equal(clampStallGuardSeconds('200'), MAX_STALL_GUARD_SECONDS);
        assert.equal(clampStallGuardSeconds('12'), 12);
        assert.equal(clampStallGuardSeconds('99'), 99);
        assert.equal(clampStallGuardSeconds('abc'), DEFAULT_STALL_GUARD_SECONDS);
        assert.equal(clampStallGuardSeconds(undefined), DEFAULT_STALL_GUARD_SECONDS);
        assert.equal(clampStallGuardSeconds(NaN), DEFAULT_STALL_GUARD_SECONDS);
        assert.equal(MAX_STALL_GUARD_SECONDS, 120);
        assert.equal(DEFAULT_STALL_GUARD_SECONDS, 20);
        assert.equal(clampStallPauseSeconds(1), MIN_STALL_PAUSE_SECONDS);
        assert.equal(clampStallPauseSeconds(99), MAX_STALL_PAUSE_SECONDS);
        assert.equal(clampStallPauseSeconds('8'), 8);
        assert.equal(clampStallPauseSeconds('nope'), DEFAULT_STALL_PAUSE_SECONDS);
        assert.equal(DEFAULT_STALL_PAUSE_SECONDS, 8);
        assert.equal(MIN_STALL_PAUSE_SECONDS, 2);
        assert.equal(MAX_STALL_PAUSE_SECONDS, 60);
    });

    it('counts the hold window while armed and edged, then pauses, then resumes', () => {
        let g = { holdSeconds: 0, pauseSeconds: 0, engaged: false };
        const opts = { armed: true, isEdged: true, holdTimeoutSeconds: 3, pauseTimeoutSeconds: 2 };
        for (let i = 0; i < 2; i++) g = tickStallGuard(g, opts);
        assert.equal(g.holdSeconds, 2);
        assert.equal(g.engaged, false);
        g = tickStallGuard(g, opts);
        assert.equal(g.engaged, true);
        assert.equal(g.justEngaged, true);
        g = tickStallGuard(g, opts);
        assert.equal(g.engaged, true);
        assert.equal(g.pauseSeconds, 1);
        assert.equal(g.justEngaged, false);
        g = tickStallGuard(g, opts);
        assert.equal(g.engaged, false);
        assert.equal(g.justResumed, true);
        assert.equal(g.holdSeconds, 0);
        // A negative hold timeout is clamped, so the guard cannot fire on the first tick.
        assert.equal(tickStallGuard({ holdSeconds: 0 }, { armed: true, isEdged: true, holdTimeoutSeconds: -5, pauseTimeoutSeconds: 8 }).engaged, false);
    });

    it('releases at once when disarmed while engaged, even with the pulse still at the ceiling', () => {
        const engaged = { holdSeconds: 9, pauseSeconds: 1, engaged: true };
        const off = tickStallGuard(engaged, { armed: false, isEdged: true, holdTimeoutSeconds: 8, pauseTimeoutSeconds: 8 });
        assert.equal(off.engaged, false);
        assert.equal(off.justReleased, true);
        assert.equal(off.holdSeconds, 0);
        const released = tickStallGuard(engaged, { armed: true, isEdged: false, holdTimeoutSeconds: 8, pauseTimeoutSeconds: 8 });
        assert.equal(released.engaged, false);
        assert.equal(released.justReleased, true);
        const idle = tickStallGuard({ holdSeconds: 0, engaged: false }, { armed: false, isEdged: true, holdTimeoutSeconds: 8, pauseTimeoutSeconds: 8 });
        assert.equal(idle.justReleased, false);
    });
});

describe('edge training', () => {
    it('clamps hold seconds and edge counts', () => {
        assert.equal(clampTrainHoldSeconds(15), 15);
        assert.equal(clampTrainHoldSeconds(2), MIN_TRAIN_HOLD_SECONDS);
        assert.equal(clampTrainHoldSeconds(400), MAX_TRAIN_HOLD_SECONDS);
        assert.equal(clampTrainHoldSeconds('nope'), DEFAULT_TRAIN_HOLD_SECONDS);
        assert.equal(clampTrainEdges(5), 5);
        assert.equal(clampTrainEdges(0), MIN_TRAIN_EDGES);
        assert.equal(clampTrainEdges(99), MAX_TRAIN_EDGES);
        assert.equal(clampTrainEdges('x'), DEFAULT_TRAIN_EDGES);
    });

    it('counts a full hold as one edge and finishes at the goal', () => {
        let t = { state: 'climb', holdSeconds: 0, edgesDone: 0 };
        t = tickEdgeTraining(t, { isEdged: true, holdGoal: 5, edgesGoal: 2 });
        assert.equal(t.state, 'hold');
        assert.equal(t.justHold, true);
        assert.equal(t.holdSeconds, 1);
        for (let i = 0; i < 3; i++) {
            t = tickEdgeTraining(t, { isEdged: true, holdGoal: 5, edgesGoal: 2 });
        }
        assert.equal(t.state, 'hold');
        t = tickEdgeTraining(t, { isEdged: true, holdGoal: 5, edgesGoal: 2 });
        assert.equal(t.justCounted, true);
        assert.equal(t.edgesDone, 1);
        assert.equal(t.state, 'recover');
        t = tickEdgeTraining(t, { isEdged: false, released: true, holdGoal: 5, edgesGoal: 2 });
        assert.equal(t.state, 'climb');
        t = tickEdgeTraining(t, { isEdged: true, holdGoal: 5, edgesGoal: 2 });
        for (let i = 0; i < 4; i++) {
            t = tickEdgeTraining(t, { isEdged: true, holdGoal: 5, edgesGoal: 2 });
        }
        assert.equal(t.state, 'finish');
        assert.equal(t.justFinished, true);
        assert.equal(t.edgesDone, 2);
    });

    it('Force Orgasm suspends training instead of completing it', () => {
        // Tapping Force Orgasm is not five held edges: the counter and the
        // state must be exactly where the wearer left them.
        const fresh = tickEdgeTraining(
            { state: 'climb', holdSeconds: 0, edgesDone: 0 },
            { isEdged: false, holdGoal: 15, edgesGoal: 5, orgasmMode: true }
        );
        assert.equal(fresh.state, 'climb');
        assert.equal(fresh.edgesDone, 0);
        assert.equal(fresh.justFinished, false);

        const mid = tickEdgeTraining(
            { state: 'hold', holdSeconds: 3, edgesDone: 1 },
            { isEdged: true, holdGoal: 15, edgesGoal: 5, orgasmMode: true }
        );
        assert.equal(mid.state, 'hold');
        assert.equal(mid.holdSeconds, 3, 'the hold clock is frozen, not advanced');
        assert.equal(mid.edgesDone, 1);

        // Cancelling it hands the game back unchanged.
        const back = tickEdgeTraining(mid, { isEdged: true, holdGoal: 15, edgesGoal: 5, orgasmMode: false });
        assert.equal(back.state, 'hold');
        assert.equal(back.holdSeconds, 4);
        assert.equal(back.edgesDone, 1);
    });

    it('holds the finish while Force Orgasm runs and returns to the climb when it is cancelled', () => {
        const finished = { state: 'finish', holdSeconds: 0, edgesDone: 5 };
        const forcing = tickEdgeTraining(finished, { isEdged: true, holdGoal: 15, edgesGoal: 5, orgasmMode: true });
        assert.equal(forcing.state, 'finish');
        assert.equal(forcing.edgesDone, 5);
        assert.equal(forcing.justFinished, false, 'finishing must be announced once, not every second');

        // The wearer cancels Force Orgasm: the game leaves the terminal state
        // the way the Oracle leaves CLIMAX, so the session can end normally.
        const withdrawn = tickEdgeTraining(finished, { isEdged: false, released: true, holdGoal: 15, edgesGoal: 5, orgasmMode: false });
        assert.equal(withdrawn.state, 'climb');
        assert.equal(withdrawn.justFinished, false);
        // The set is over and the wearer said no, so a NEW set starts. If the
        // counter stayed at the goal the very next hold would re-arm Force
        // Orgasm, seconds after it was deliberately cancelled.
        assert.equal(withdrawn.edgesDone, 0, 'withdrawal starts a fresh set');
    });

    it('cancelling the finish cannot re-arm Force Orgasm on the next hold', () => {
        const withdrawn = tickEdgeTraining(
            { state: 'finish', holdSeconds: 0, edgesDone: 3 },
            { isEdged: true, holdGoal: MIN_TRAIN_HOLD_SECONDS, edgesGoal: 3, orgasmMode: false }
        );
        assert.equal(withdrawn.state, 'climb');
        assert.equal(withdrawn.edgesDone, 0);

        // One full hold from here counts an edge but must NOT finish again.
        let t = withdrawn;
        for (let i = 0; i < MIN_TRAIN_HOLD_SECONDS; i++) {
            t = tickEdgeTraining(t, { isEdged: true, holdGoal: MIN_TRAIN_HOLD_SECONDS, edgesGoal: 3, orgasmMode: false });
        }
        assert.equal(t.edgesDone, 1);
        assert.equal(t.justFinished, false, 'one hold must never re-arm a cancelled Force Orgasm');
        assert.notEqual(t.state, 'finish');

        // The training still works: the full set finishes it again.
        while (t.edgesDone < 3 && !t.justFinished) {
            t = tickEdgeTraining(t, { isEdged: true, released: false, holdGoal: MIN_TRAIN_HOLD_SECONDS, edgesGoal: 3, orgasmMode: false });
            if (t.state === 'recover') {
                t = tickEdgeTraining(t, { isEdged: false, released: true, holdGoal: MIN_TRAIN_HOLD_SECONDS, edgesGoal: 3, orgasmMode: false });
            }
        }
        assert.equal(t.state, 'finish');
        assert.equal(t.edgesDone, 3);
        assert.equal(t.justFinished, true);
    });

    it('a dropped hold does not count', () => {
        let t = tickEdgeTraining({ state: 'climb' }, { isEdged: true, holdGoal: 8, edgesGoal: 3 });
        t = tickEdgeTraining(t, { isEdged: true, holdGoal: 8, edgesGoal: 3 });
        t = tickEdgeTraining(t, { isEdged: false, holdGoal: 8, edgesGoal: 3 });
        assert.equal(t.justDropped, true);
        assert.equal(t.edgesDone, 0);
        assert.equal(t.state, 'recover');
    });
});
