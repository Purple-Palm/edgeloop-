import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    survivalDrive,
    survivalEdgesAtSwitch,
    survivalEdgesAfterEngine,
    SURVIVAL_START_FLOOR,
    SURVIVAL_OVERDRIVE_CAP,
    SURVIVAL_EDGE_BPM,
    endgameKeepsOrgasmLatch,
    FORCE_ORGASM_MAX_OPTIONS,
    DEFAULT_FORCE_ORGASM_MAX_SECONDS,
    MAX_FORCE_ORGASM_SECONDS,
    FORCE_ORGASM_REFUSALS,
    resolveForceOrgasmMaxSeconds,
    tickForceOrgasm,
    forceOrgasmSecondsLeft,
    describeForceOrgasmCountdown,
    inSoftLanding,
    forceOrgasmRefusal,
    describeForceOrgasmRefusal,
    describeForceOrgasmButton,
    describeGameNotice,
    describeCutoffNotice,
    MIN_STALL_GUARD_SECONDS,
    MAX_STALL_GUARD_SECONDS,
    DEFAULT_STALL_GUARD_SECONDS,
    MIN_STALL_PAUSE_SECONDS,
    MAX_STALL_PAUSE_SECONDS,
    DEFAULT_STALL_PAUSE_SECONDS,
    clampStallGuardSeconds,
    clampStallPauseSeconds,
    tickStallGuard,
    stallPauseSecondsLeft,
    stallGuardArmed,
    stallGuardCues,
    tickRuin,
    startRuinEdge,
    ruinRideSecondsLeft,
    tickRuinAndStallGuard,
    describeStallPauseNotice,
    sanitizeStoredHrLimits,
    sanitizeStoredDuration,
    sanitizeStoredEndgame,
    sanitizeSessionLimits,
    DEFAULT_MIN_HR,
    DEFAULT_MAX_HR,
    DEFAULT_DURATION_MODE,
    DEFAULT_FIXED_MINUTES,
    DEFAULT_RANGE_MIN_MINUTES,
    DEFAULT_RANGE_MAX_MINUTES,
    DEFAULT_ENDGAME_TYPE,
    COOLDOWN_MINUTES_OPTIONS,
    COOLDOWN_EVERY_OPTIONS,
    DEFAULT_COOLDOWN_MINUTES,
    DEFAULT_COOLDOWN_EVERY_EDGES,
    COOLDOWN_EVENTS,
    cooldownEligible,
    tickCooldown,
    cooldownSecondsFor,
    describeCooldownBadge
} from './session-rules.js';
import { calculateEngineOutputs, TEASE_MODES, GAME_MODES, EDGE_RELEASE_BPM, COOLDOWN_MODES, ENGINE_MODES } from './engine.js';
import { RUIN_RIDE_SECONDS, RUIN_LOCK_SECONDS, RUIN_LOCK_SECONDARY } from './patterns.js';
import { rememberEdgeReading } from './edge-confirm.js';

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

    it('adds Survival overdrive on top of the typed max and caps it', () => {
        assert.equal(computeEffectiveCeiling({ ...base, survivalOverdrive: 8 }).maxHr, 148);
        assert.equal(computeEffectiveCeiling({ ...base, survivalOverdrive: 500 }).maxHr, 140 + SURVIVAL_OVERDRIVE_CAP);
        assert.equal(computeEffectiveCeiling({ ...base, survivalOverdrive: -4 }).maxHr, 140);
        assert.equal(computeEffectiveCeiling({ ...base, orgasmBoost: 5, survivalOverdrive: 3 }).maxHr, 148);
    });
});

describe('parseSessionDuration', () => {
    it('endless is always zero', () => {
        assert.deepEqual(parseSessionDuration({ mode: 'endless' }), {
            targetSeconds: 0, minSeconds: 0, maxSeconds: 0, fixedLength: false, valid: true, invalid: []
        });
    });

    it('fixed uses the typed minutes as both ends of the window', () => {
        const out = parseSessionDuration({ mode: 'fixed', fixedMinutes: '30' });
        assert.equal(out.targetSeconds, 1800);
        assert.equal(out.minSeconds, 1800);
        assert.equal(out.maxSeconds, 1800);
        assert.equal(out.fixedLength, true);
    });

    it('only a Fixed length reports fixedLength, however the range was typed', () => {
        // The seconds alone cannot tell a Fixed 30 from a Mystery typed 30-30,
        // and the Oracle treats the two completely differently. This flag is
        // the only thing that carries the difference.
        const fixed = parseSessionDuration({ mode: 'fixed', fixedMinutes: '30' });
        const collapsed = parseSessionDuration({ mode: 'range', minMinutes: '30', maxMinutes: '30' });
        assert.equal(collapsed.targetSeconds, fixed.targetSeconds);
        assert.equal(collapsed.minSeconds, fixed.minSeconds);
        assert.equal(collapsed.maxSeconds, fixed.maxSeconds);
        assert.equal(collapsed.fixedLength, false, 'a Mystery is never a Fixed length');
        for (const spread of [['30', '60'], ['5', '5'], ['90', '90']]) {
            const out = parseSessionDuration({
                mode: 'range', minMinutes: spread[0], maxMinutes: spread[1], random: () => 0
            });
            assert.equal(out.fixedLength, false);
        }
        assert.equal(parseSessionDuration({ mode: 'endless' }).fixedLength, false);
        assert.equal(parseSessionDuration({ mode: 'fixed', fixedMinutes: 'abc' }).fixedLength, false);
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
        const fixed = (t) => oracleTiming({
            sessionSeconds: t, minSeconds: 1800, maxSeconds: 1800, targetSeconds: 1800, fixedLength: true
        });
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
        const fixedRun = oracleTiming({
            sessionSeconds: 901, minSeconds: 1800, maxSeconds: 1800, targetSeconds: 1800, fixedLength: true
        });
        assert.equal(fixedRun.openAt, 900);
        assert.equal(fixedRun.canEnd, true);
    });

    it('a Mystery typed with one number in both boxes still honours that minimum', () => {
        // 30-30 hands out exactly the seconds a Fixed 30 does, and the old
        // rule read the numbers alone: it unlocked climax - which arms Force
        // Orgasm - and denial at 15 minutes, half the minimum the wearer
        // typed. A Mystery minimum is a promise whatever the spread.
        const mystery = (t) => oracleTiming({
            sessionSeconds: t, minSeconds: 1800, maxSeconds: 1800, targetSeconds: 1800
        });
        const half = mystery(901);
        assert.equal(half.openAt, 1800, 'never halfway through a typed Mystery minimum');
        assert.equal(half.canEnd, false);
        assert.equal(rollOracleFate(half, { random: () => 0.99 }), 'PURGATORY');

        const due = mystery(1800);
        assert.equal(due.canEnd, true);
        assert.equal(due.mustEnd, true, 'and it ends there, the way the target says');
        assert.equal(rollOracleFate(due, { random: () => 0.9, endgameType: 'rampdown' }), 'RAMPDOWN');

        // The same numbers typed as a FIXED length keep the halfway ramp.
        const fixed = oracleTiming({
            sessionSeconds: 901, minSeconds: 1800, maxSeconds: 1800, targetSeconds: 1800, fixedLength: true
        });
        assert.equal(fixed.openAt, 900);
        assert.equal(fixed.canEnd, true);
    });

    it('end to end: only the Fixed card opens the window halfway', () => {
        // The two parses that produce identical seconds, fed straight into
        // the timing the way app.js feeds them.
        const at = (parsed, t) => oracleTiming({
            sessionSeconds: t,
            minSeconds: parsed.minSeconds,
            maxSeconds: parsed.maxSeconds,
            targetSeconds: parsed.targetSeconds,
            fixedLength: parsed.fixedLength
        });
        const fixed = parseSessionDuration({ mode: 'fixed', fixedMinutes: '30' });
        const mystery = parseSessionDuration({ mode: 'range', minMinutes: '30', maxMinutes: '30' });
        assert.equal(at(fixed, 901).canEnd, true);
        assert.equal(at(mystery, 901).canEnd, false);
        assert.equal(at(mystery, 1800).mustEnd, true);
        // A wide Mystery is unchanged by any of this.
        const wide = parseSessionDuration({ mode: 'range', minMinutes: '30', maxMinutes: '60', random: () => 0.5 });
        assert.equal(at(wide, 1799).canEnd, false);
        assert.equal(at(wide, 1800).canEnd, true);
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

describe('survival climb', () => {
    it('stays gentle for a long while and steps up on each edge', () => {
        const start = survivalDrive({ seconds: 0, edges: 0 });
        assert.equal(start.floor, SURVIVAL_START_FLOOR);
        assert.equal(start.overdriveBpm, 0);
        const fiveMin = survivalDrive({ seconds: 5 * 60, edges: 0 });
        assert.ok(fiveMin.floor < 40, `five minutes was already ${fiveMin.floor}%`);
        const halfHour = survivalDrive({ seconds: 30 * 60, edges: 0 });
        assert.ok(halfHour.floor > 50 && halfHour.floor < 80, `thirty minutes was ${halfHour.floor}%`);
        const edged = survivalDrive({ seconds: 30 * 60, edges: 12 });
        assert.equal(edged.overdriveBpm, 12 * SURVIVAL_EDGE_BPM);
        assert.ok(edged.floor > halfHour.floor);
        const capped = survivalDrive({ seconds: 90 * 60, edges: 80 });
        assert.equal(capped.floor, 100);
        assert.equal(capped.overdriveBpm, SURVIVAL_OVERDRIVE_CAP);
    });

    it('steps only on an edge the engine counted, never on one reading at the mark', () => {
        // Each edge the engine counts raises the mark 1 BPM and the speed a
        // step, and 1.1.2 counted one reading at the mark: the top of a
        // posture spike, or a single glitch, stepped the climb for the rest
        // of the run. The count now waits for the pulse to hold there
        // (edge-confirm.js), and the climb with it. A reading a second, the
        // way app.js runs Survival: each reading remembered, the engine on
        // the working ceiling the climb has reached, the climb stepped from
        // the edges counted so far.
        const run = (stream) => {
            let isEdged = false;
            let edgePending = false;
            let readings = [];
            let edges = 0;
            let overdrive = 0;
            return stream.map((bpm, i) => {
                readings = rememberEdgeReading(readings, (i + 1) * 1000, bpm);
                const { maxHr } = computeEffectiveCeiling({ minHr: 70, maxHr: 140, survivalOverdrive: overdrive });
                const out = calculateEngineOutputs({
                    hr: bpm, edgeHr: bpm, minHr: 70, maxHr, activeMode: 'survival', sessionStatus: 'RUNNING',
                    isEdged, edgePending, recentReadings: readings
                });
                isEdged = out.isEdged;
                edgePending = out.edgePending;
                if (out.newEdgeTriggered) edges += 1;
                overdrive = survivalDrive({ seconds: i + 1, edges }).overdriveBpm;
                return { bpm, isEdged, edges, overdrive };
            });
        };
        const spike = run([128, 132, 136, 138, 140, 138, 134, 130, 128]);
        assert.ok(spike.some((s) => s.isEdged), 'the reading at the mark still raises the flag');
        assert.ok(spike.every((s) => s.edges === 0 && s.overdrive === 0), 'a posture spike stepped the climb');
        assert.ok(run([125, 125, 162, 125, 125]).every((s) => s.overdrive === 0), 'a glitch stepped the climb');
        const held = run([130, 136, 140, 141, 141, 141]);
        assert.deepEqual(held.map((s) => s.overdrive), [0, 0, 0, 1, 1, 1].map((n) => n * SURVIVAL_EDGE_BPM),
            'one step, on the reading that holds the mark, and none for the mark it raised');
    });

    it('an edge from before it was switched on does not step it, however late it is counted', () => {
        // 1.1.2: edges from before you switch Survival on do not count. The
        // switch takes the edges counted so far as seen, and 1.1.2 counted an
        // edge on the reading its pullback began on, so the edge in progress
        // at the switch was always one of them. The count now comes a reading
        // later (edge-confirm.js), so an edge whose pullback began before the
        // switch can be counted after it, and the counter alone would step
        // the climb for it for the rest of the run: the working ceiling to
        // 141 and the speed floor a step up. A reading a second in Classic,
        // then Survival switched on, the way app.js runs it: each reading
        // remembered and the engine run on it, Survival's seen edges settled
        // after every engine call, the switch taking them from the counter
        // and the edge in progress and running the engine in the new mode,
        // then each second of Survival stepping the climb for the edges
        // counted since.
        const run = (before, after) => {
            let mode = 'classic';
            let isEdged = false;
            let edgePending = false;
            let readings = [];
            let edges = 0;
            let seen = { edgesSeen: 0, owedEdgeSeen: false };
            let survivalSeconds = 0;
            let survivalEdges = 0;
            let overdrive = 0;
            let t = 0;
            const engine = (bpm) => {
                const { maxHr } = computeEffectiveCeiling({ minHr: 70, maxHr: 140, survivalOverdrive: overdrive });
                const out = calculateEngineOutputs({
                    hr: bpm, edgeHr: bpm, minHr: 70, maxHr, activeMode: mode, sessionStatus: 'RUNNING',
                    isEdged, edgePending, recentReadings: readings
                });
                if (out.newEdgeTriggered) edges += 1;
                seen = survivalEdgesAfterEngine(seen, out);
                isEdged = out.isEdged;
                edgePending = out.edgePending;
            };
            const rows = [];
            const second = (bpm) => {
                t += 1;
                readings = rememberEdgeReading(readings, t * 1000, bpm);
                engine(bpm);
                if (mode === 'survival') {
                    survivalSeconds += 1;
                    survivalEdges += Math.max(0, edges - seen.edgesSeen);
                    seen = { ...seen, edgesSeen: edges };
                    overdrive = survivalDrive({ seconds: survivalSeconds, edges: survivalEdges }).overdriveBpm;
                }
                rows.push({ bpm, mode, isEdged, edgePending, edges, overdrive });
            };
            before.forEach(second);
            seen = survivalEdgesAtSwitch({ edges, isEdged, edgePending });
            mode = 'survival';
            engine(before[before.length - 1]);
            after.forEach(second);
            return rows;
        };
        const survival = (rows) => rows.filter((r) => r.mode === 'survival');
        const owedAtSwitch = (rows) => {
            const last = rows.filter((r) => r.mode === 'classic').pop();
            return last.isEdged && last.edgePending && last.edges === 0;
        };

        // A strap: the pullback on the 140 before the switch, the count on the
        // 141 after it.
        const strap = run([120, 128, 134, 138, 140], [141, 142, 142, 142]);
        assert.ok(owedAtSwitch(strap), 'the edge was pulled back on and owed its count at the switch');
        assert.equal(survival(strap)[0].edges, 1, 'counted after the switch');
        assert.ok(strap.every((r) => r.overdrive === 0), 'an edge from before the switch stepped the climb');

        // The pulse touches the mark, hovers under it above the release
        // point, as it does after a Crawl pullback, and comes back to hold
        // there only once Survival is on.
        const hover = run([120, 130, 136, 140, 138, 138, 137, 138, 138], [139, 141, 142, 142]);
        assert.ok(owedAtSwitch(hover));
        assert.deepEqual(survival(hover).map((r) => r.edges), [0, 0, 1, 1]);
        assert.ok(hover.every((r) => r.overdrive === 0), 'an edge from before the switch stepped the climb');

        // Counted before the switch, as 1.1.2 always counted it.
        const counted = run([120, 128, 134, 138, 140, 141], [142, 142, 142]);
        assert.ok(counted.every((r) => r.overdrive === 0));

        // Released before it was counted, the edge is never counted, and the
        // next one, begun with Survival on, steps the climb once.
        const released = run([120, 128, 134, 138, 140], [133, 130, 136, 140, 141, 141]);
        assert.ok(owedAtSwitch(released));
        assert.deepEqual(survival(released).map((r) => r.overdrive), [0, 0, 0, 0, 1, 1].map((n) => n * SURVIVAL_EDGE_BPM));
        assert.equal(released[released.length - 1].edges, 1);

        // Its count made after the switch, the next edge still steps it.
        const next = run([120, 128, 134, 138, 140], [141, 142, 133, 130, 138, 140, 141, 141]);
        assert.deepEqual(survival(next).map((r) => r.overdrive), [0, 0, 0, 0, 0, 0, 1, 1].map((n) => n * SURVIVAL_EDGE_BPM));
        assert.equal(next[next.length - 1].edges, 2);
    });

    it('holds the count owed at the switch as seen until it is made, and forgets it when the flag releases', () => {
        assert.deepEqual(survivalEdgesAtSwitch({ edges: 3, isEdged: true, edgePending: true }), { edgesSeen: 3, owedEdgeSeen: true });
        assert.deepEqual(survivalEdgesAtSwitch({ edges: 3, isEdged: true, edgePending: false }), { edgesSeen: 3, owedEdgeSeen: false },
            'an edge already counted is seen by the counter');
        assert.deepEqual(survivalEdgesAtSwitch({ edges: 3, isEdged: false, edgePending: true }), { edgesSeen: 3, owedEdgeSeen: false },
            'no count is owed without the flag');
        assert.deepEqual(survivalEdgesAtSwitch({ edges: NaN }), { edgesSeen: 0, owedEdgeSeen: false });
        const owed = { edgesSeen: 3, owedEdgeSeen: true };
        assert.deepEqual(survivalEdgesAfterEngine(owed, { newEdgeTriggered: true, edgePending: false }), { edgesSeen: 4, owedEdgeSeen: false },
            'made, the owed count is seen, not stepped');
        assert.deepEqual(survivalEdgesAfterEngine(owed, { newEdgeTriggered: false, edgePending: true }), owed,
            'still owed - no second reading yet, a pause, Force Orgasm - it is held');
        assert.deepEqual(survivalEdgesAfterEngine(owed, { newEdgeTriggered: false, edgePending: false }), { edgesSeen: 3, owedEdgeSeen: false },
            'the flag released first: that edge is never counted');
        assert.deepEqual(survivalEdgesAfterEngine(owed, { pullbackStarted: true, edgePending: true }), { edgesSeen: 3, owedEdgeSeen: false },
            'a pullback that starts is a new edge');
        assert.deepEqual(survivalEdgesAfterEngine(owed, { pullbackStarted: true, newEdgeTriggered: true }), { edgesSeen: 3, owedEdgeSeen: false },
            'a new edge counted on its first engine call steps the climb');
        assert.deepEqual(survivalEdgesAfterEngine({ edgesSeen: 3, owedEdgeSeen: false }, { newEdgeTriggered: true }), { edgesSeen: 3, owedEdgeSeen: false },
            'with nothing owed, a count is the climb\'s to step');
    });

    it('app.js takes the owed count at the switch and settles it after its one engine call', () => {
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const reset = src.match(/function resetGameState\(\) \{[\s\S]*?\n\}/);
        assert.ok(reset, 'resetGameState moved');
        assert.match(reset[0], /survivalEdgesAtSwitch\(\{ edges: state\.edges, isEdged: state\.isEdged, edgePending: state\.edgePending \}\)/);
        assert.match(reset[0], /state\.survivalOwedEdgeSeen = /);
        const engine = src.match(/function updateEngine\(\) \{[\s\S]*?\n\}/);
        assert.ok(engine, 'updateEngine moved');
        assert.match(engine[0], /survivalEdgesAfterEngine\([^;]*\bresult\s*\)/);
        assert.match(engine[0], /state\.survivalOwedEdgeSeen = /);
        assert.equal((src.match(/calculateEngineOutputs\(/g) || []).length, 1, 'app.js runs the engine somewhere the owed count is not settled');
    });

    it('does not end the session when the pulse crosses the max', () => {
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.equal(src.includes('Survival Defeat'), false);
        assert.equal(src.includes('isSurvivalDefeated'), false);
    });

    it('saves the run peak from the Came Early button only after the wearer confirms', () => {
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        assert.equal(html.includes('survivalCameBtn'), false);
        assert.match(html, /id="cameEarlyLabel"[^>]*>Came Early</);
        assert.match(html, /id="survivalCalibrateToggle"/);
        assert.match(html, /id="wizardCalibrateBtn"/);
        assert.match(src, /Finished me/);
        assert.match(src, /survivalCalibrating/);
        const handler = src.match(/cameEarlyBtn\?\.addEventListener\([\s\S]*?stopSession\('Survival calibration'/);
        assert.ok(handler, 'Finished me has no handler on the Came Early button');
        assert.match(handler[0], /activeMode === 'survival'/);
        assert.match(handler[0], /confirm\(/);
        assert.equal(handler[0].includes('suggestedMaxHrOffset'), false);
        assert.match(handler[0], /isRemotePage/);
        assert.match(src, /suggestedMaxHrOffset/);
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

describe('the endgame and a latched Force Orgasm', () => {
    it('only the Orgasm ending keeps the latch', () => {
        assert.equal(endgameKeepsOrgasmLatch('orgasm'), true);
        assert.equal(endgameKeepsOrgasmLatch('rampdown'), false, 'a Soft Landing is not run at 85-100%');
        assert.equal(endgameKeepsOrgasmLatch('denial'), false);
        for (const junk of ['', null, undefined, 'mystery-meat']) {
            assert.equal(endgameKeepsOrgasmLatch(junk), false, `an unknown ending must not keep the latch`);
        }
    });

    it('app.js clears the latch before it runs a Soft Landing', () => {
        // The helper is worthless unless the cockpit asks it on the way in:
        // Force Orgasm keeps driving the toys and raising the ceiling for as
        // long as it is latched, so a Soft Landing reached with it still on
        // would not be the gentle ending.
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const fn = src.match(/function handleTargetTimeReached\(\)[\s\S]*?\n}/);
        assert.ok(fn, 'handleTargetTimeReached anchor moved');
        assert.ok(
            /endgameKeepsOrgasmLatch\(/.test(fn[0]),
            `the endgame must decide what happens to the latch: ${fn[0]}`
        );
        assert.ok(/setOrgasmMode\(false\)/.test(fn[0]), 'and actually clear it');
        const clear = fn[0].indexOf('setOrgasmMode(false)');
        const ramp = fn[0].indexOf("'rampdown'");
        assert.ok(clear >= 0 && ramp >= 0 && clear < ramp, 'the latch must be cleared before the rampdown starts');
    });
});

describe('Force Orgasm runs for at most the time the Guards tab says', () => {
    // Nothing used to end Force Orgasm but the wearer: a wearer who came on it
    // had to find STOP in the middle of his orgasm. These drive the rules the
    // cockpit runs once a second, a second at a time, the way app.js does.

    // One running session, second by second: `arm` switches Force Orgasm on
    // (the clock restarts at 0, as setOrgasmMode does), `pause` / `resume`
    // move the transport, and each tick asks tickForceOrgasm before anything
    // else. Returns the tick on which the limit expired, or null.
    function drive(maxSeconds, script, ticks = 400) {
        let session = { sessionStatus: 'RUNNING', resumeStatus: null, orgasmMode: false, seconds: 0 };
        const trace = [];
        for (let t = 1; t <= ticks; t += 1) {
            const action = script[t];
            if (action === 'arm') session = { ...session, orgasmMode: true, seconds: 0 };
            if (action === 'off') session = { ...session, orgasmMode: false, seconds: 0 };
            if (action === 'pause') session = { ...session, resumeStatus: session.sessionStatus, sessionStatus: 'PAUSED' };
            if (action === 'resume') session = { ...session, sessionStatus: session.resumeStatus, resumeStatus: null };
            const step = tickForceOrgasm({ seconds: session.seconds }, { orgasmMode: session.orgasmMode, sessionStatus: session.sessionStatus, maxSeconds });
            session = { ...session, seconds: step.seconds };
            trace.push({ t, ...session, left: forceOrgasmSecondsLeft({ orgasmMode: session.orgasmMode, seconds: session.seconds, maxSeconds }) });
            if (step.expired) return { expiredAt: t, trace };
        }
        return { expiredAt: null, trace };
    }

    it('offers 60, 90, 120 and 180 seconds and Off, and 90 s is the factory limit', () => {
        assert.deepEqual(FORCE_ORGASM_MAX_OPTIONS, [60, 90, 120, 180, 0]);
        assert.equal(DEFAULT_FORCE_ORGASM_MAX_SECONDS, 90);
        assert.equal(MAX_FORCE_ORGASM_SECONDS, 180);
    });

    it('takes an option as it is written and anything else as the factory limit, never as Off', () => {
        for (const seconds of FORCE_ORGASM_MAX_OPTIONS) {
            assert.equal(resolveForceOrgasmMaxSeconds(seconds), seconds);
            assert.equal(resolveForceOrgasmMaxSeconds(String(seconds)), seconds, 'the select writes its option as text');
        }
        assert.equal(resolveForceOrgasmMaxSeconds(' 120 '), 120);
        // Only an explicit 0 is Off. Number() reads all of these as 0.
        for (const junk of [undefined, null, '', ' ', false, true, [], [0], {}, 'off', 'Off', '0x0', '0.0e1', NaN, Infinity]) {
            assert.equal(resolveForceOrgasmMaxSeconds(junk), DEFAULT_FORCE_ORGASM_MAX_SECONDS, `${JSON.stringify(junk)} is not a limit anybody chose`);
        }
        // A number no control writes is not rounded to the nearest option.
        for (const stray of [1, 30, 59, 61, 89.5, 90.4, 100, 179, 181, 3600, -60, -90, '45', '90s', '1:30']) {
            assert.equal(resolveForceOrgasmMaxSeconds(stray), DEFAULT_FORCE_ORGASM_MAX_SECONDS, `${JSON.stringify(stray)}`);
        }
        assert.ok(Object.is(resolveForceOrgasmMaxSeconds(-0), 0), 'an explicit zero is Off, and the plain number 0');
    });

    it('lands 90 running seconds after the arming by default, the ramp included', () => {
        const run = drive(undefined, { 5: 'arm' });
        assert.equal(run.expiredAt, 5 + 89, 'the arming tick counts as the first second of the run');
        // The button counted it down the whole way, never below 0:01.
        const armed = run.trace.filter((r) => r.orgasmMode);
        assert.equal(armed[0].left, 89);
        assert.equal(Math.min(...armed.map((r) => r.left)), 1);
        assert.deepEqual(armed.map((r) => r.left), [...armed.map((r) => r.left)].sort((a, b) => b - a), 'the countdown only goes down');
        for (const limit of [60, 120, 180]) {
            assert.equal(drive(limit, { 1: 'arm' }).expiredAt, limit, `${limit} s`);
        }
    });

    it('Off is the old behaviour: no countdown, and nothing ends the run', () => {
        const run = drive(0, { 2: 'arm' }, 1000);
        assert.equal(run.expiredAt, null);
        assert.ok(run.trace.every((r) => r.left === 0), 'no countdown while it runs');
    });

    it('a pause stops the clock, and the run lands after its running seconds', () => {
        // Armed at 1, paused from 31 to 60, resumed: the 30 paused ticks do not
        // count, and it lands after 90 running seconds.
        const run = drive(90, { 1: 'arm', 31: 'pause', 61: 'resume' });
        assert.equal(run.expiredAt, 90 + 30);
        const paused = run.trace.filter((r) => r.sessionStatus === 'PAUSED');
        assert.equal(new Set(paused.map((r) => r.left)).size, 1, 'the countdown stands still in a pause');
    });

    it('switching it off and on again starts a fresh run', () => {
        const run = drive(60, { 1: 'arm', 40: 'off', 50: 'arm' });
        assert.equal(run.expiredAt, 50 + 59);
    });

    it('a lowered limit ends a run already past it on the next tick', () => {
        let seconds = 0;
        for (let t = 0; t < 100; t += 1) {
            seconds = tickForceOrgasm({ seconds }, { orgasmMode: true, sessionStatus: 'RUNNING', maxSeconds: 180 }).seconds;
        }
        assert.equal(forceOrgasmSecondsLeft({ orgasmMode: true, seconds, maxSeconds: 60 }), 1, 'never 0:00 while it still runs');
        assert.equal(tickForceOrgasm({ seconds }, { orgasmMode: true, sessionStatus: 'RUNNING', maxSeconds: 60 }).expired, true);
    });

    it('only counts a running session, and only while Force Orgasm is on', () => {
        for (const sessionStatus of ['PAUSED', 'RAMPDOWN', 'IDLE']) {
            assert.deepEqual(tickForceOrgasm({ seconds: 89 }, { orgasmMode: true, sessionStatus, maxSeconds: 90 }), { seconds: 89, expired: false }, sessionStatus);
        }
        assert.deepEqual(tickForceOrgasm({ seconds: 89 }, { orgasmMode: false, sessionStatus: 'RUNNING', maxSeconds: 90 }), { seconds: 0, expired: false });
        // A clock that is not a number starts again rather than stopping forever.
        assert.deepEqual(tickForceOrgasm({ seconds: NaN }, { orgasmMode: true, sessionStatus: 'RUNNING', maxSeconds: 90 }), { seconds: 1, expired: false });
    });

    it('counts down as m:ss, and says nothing when there is nothing to count', () => {
        assert.equal(describeForceOrgasmCountdown(90), '1:30');
        assert.equal(describeForceOrgasmCountdown(180), '3:00');
        assert.equal(describeForceOrgasmCountdown(61), '1:01');
        assert.equal(describeForceOrgasmCountdown(9), '0:09');
        assert.equal(describeForceOrgasmCountdown(1), '0:01');
        for (const none of [0, -3, NaN, undefined, null]) assert.equal(describeForceOrgasmCountdown(none), '', `${none}`);
        assert.equal(forceOrgasmSecondsLeft({ orgasmMode: false, seconds: 0, maxSeconds: 90 }), 0);
        assert.equal(forceOrgasmSecondsLeft({ orgasmMode: true, seconds: 0, maxSeconds: 90 }), 90);
        assert.equal(forceOrgasmSecondsLeft({ orgasmMode: true, seconds: 30, maxSeconds: 'junk' }), 60, 'a junk limit is the factory 90 s');
    });
});

describe('Force Orgasm cannot be switched on in a soft landing', () => {
    const STATES = [
        { sessionStatus: 'IDLE', resumeStatus: null },
        { sessionStatus: 'RUNNING', resumeStatus: null },
        { sessionStatus: 'PAUSED', resumeStatus: 'RUNNING' },
        { sessionStatus: 'RAMPDOWN', resumeStatus: null },
        { sessionStatus: 'PAUSED', resumeStatus: 'RAMPDOWN' }
    ];

    it('refuses it in every landing, and with no session running', () => {
        assert.equal(forceOrgasmRefusal({ sessionStatus: 'RAMPDOWN' }), 'landing');
        assert.equal(forceOrgasmRefusal({ sessionStatus: 'PAUSED', resumeStatus: 'RAMPDOWN' }), 'landing', 'a paused landing is still a landing');
        assert.equal(forceOrgasmRefusal({ sessionStatus: 'IDLE' }), 'idle');
        assert.equal(forceOrgasmRefusal({}), 'idle');
        assert.equal(forceOrgasmRefusal({ sessionStatus: 'RUNNING' }), '');
        assert.equal(forceOrgasmRefusal({ sessionStatus: 'PAUSED', resumeStatus: 'RUNNING' }), '', 'armed in a pause, it ramps up from the stop on RESUME');
        for (const reason of ['landing', 'idle']) {
            assert.ok(FORCE_ORGASM_REFUSALS.includes(reason));
            assert.ok(describeForceOrgasmRefusal(reason).length > 0, reason);
        }
        assert.equal(describeForceOrgasmRefusal(''), '');
        assert.match(describeForceOrgasmRefusal('landing'), /SOFT LANDING/);
        assert.match(describeForceOrgasmRefusal('idle'), /START/);
    });

    it('a tap just after the limit ran out lands in the landing, and is refused there', () => {
        // The race the limit creates: the limit switches Force Orgasm off by
        // itself, and a tap meant to switch it off arrives a moment later.
        // By then the session is in its landing, and the tap would switch it
        // back ON - so it is refused, whether it is the wearer's or a
        // partner's, however late it comes.
        let seconds = 0;
        let expired = false;
        for (let t = 0; t < 90 && !expired; t += 1) {
            ({ seconds, expired } = tickForceOrgasm({ seconds }, { orgasmMode: true, sessionStatus: 'RUNNING', maxSeconds: 90 }));
        }
        assert.equal(expired, true);
        // app.js answers `expired` with Force Orgasm off and the soft landing.
        const landing = { sessionStatus: 'RAMPDOWN', resumeStatus: null };
        assert.equal(forceOrgasmRefusal(landing), 'landing');
        assert.equal(forceOrgasmRefusal({ sessionStatus: 'PAUSED', resumeStatus: 'RAMPDOWN' }), 'landing');
    });

    it('the button reads Forcing... only while a running session is being forced', () => {
        for (const orgasmMode of [false, true]) {
            for (const state of STATES) {
                for (const secondsLeft of [0, 45]) {
                    const landing = inSoftLanding(state);
                    const face = describeForceOrgasmButton({ orgasmMode, sessionStatus: state.sessionStatus, landing, secondsLeft });
                    const where = `${JSON.stringify(state)} orgasm=${orgasmMode} left=${secondsLeft}`;
                    const forcing = orgasmMode && state.sessionStatus === 'RUNNING';
                    assert.equal(face.label === 'Forcing...', forcing, `${where}: ${face.label}`);
                    assert.equal(face.look === 'forcing', forcing, where);
                    if (landing) {
                        assert.equal(face.look, 'barred', where);
                        assert.equal(face.countdown, '', `${where}: nothing is counting down in a landing`);
                    }
                    if (!orgasmMode) assert.equal(face.countdown, '', `${where}: no countdown while it is off`);
                    if (forcing) assert.equal(face.countdown, secondsLeft ? '0:45' : '', where);
                }
            }
        }
        // A latched run in a pause says so, and its countdown stands still.
        assert.deepEqual(
            describeForceOrgasmButton({ orgasmMode: true, sessionStatus: 'PAUSED', landing: false, secondsLeft: 61 }),
            { kicker: 'Overdrive', label: 'Armed', countdown: '1:01', look: 'armed' }
        );
        assert.deepEqual(
            describeForceOrgasmButton({ orgasmMode: false, sessionStatus: 'RAMPDOWN', landing: true, secondsLeft: 0 }),
            { kicker: 'Soft landing', label: 'Force Orgasm', countdown: '', look: 'barred' }
        );
    });
});

describe('the cockpit game banner', () => {
    const oracle = { activeMode: 'oracle', sessionStatus: 'RUNNING' };
    const train = { activeMode: 'edgetrain', sessionStatus: 'RUNNING' };

    it('says nothing outside a game or outside a live session', () => {
        assert.equal(describeGameNotice({ activeMode: 'classic', sessionStatus: 'RUNNING' }), '');
        assert.equal(describeGameNotice({ ...oracle, sessionStatus: 'PAUSED' }), '');
        assert.equal(describeGameNotice({ ...oracle, sessionStatus: 'IDLE' }), '');
        assert.equal(describeGameNotice(), '');
    });

    it('reports the Oracle state it is really in', () => {
        assert.match(describeGameNotice({ ...oracle, oracleState: 'HOLD', oracleTimer: 9 }), /HOLDING 9s/);
        assert.match(describeGameNotice({ ...oracle, oracleState: 'CLIMAX' }), /CLIMAX/);
        assert.match(describeGameNotice({ ...oracle, oracleState: 'DENIAL' }), /DENIAL/);
        assert.match(describeGameNotice({ ...oracle, oracleState: 'APPROACH' }), /APPROACHING THE CEILING/);
        const locked = describeGameNotice({
            ...oracle, oracleState: 'PURGATORY', sessionSeconds: 60, minSeconds: 1800, maxSeconds: 3600, targetSeconds: 1800
        });
        assert.match(locked, /NOT YET/);
        const open = describeGameNotice({
            ...oracle, oracleState: 'PURGATORY', sessionSeconds: 2000, minSeconds: 1800, maxSeconds: 3600, targetSeconds: 2400
        });
        assert.match(open, /PURGATORY/);
    });

    it('reports the training set it is really in', () => {
        assert.equal(
            describeGameNotice({ ...train, trainState: 'hold', trainHoldSeconds: 4, trainHoldGoal: 15, trainEdgesDone: 2, trainEdgesGoal: 5 }),
            'EDGE TRAINING: HOLD 11s — 2/5 EDGES'
        );
        assert.match(describeGameNotice({ ...train, trainState: 'recover', trainEdgesDone: 2, trainEdgesGoal: 5 }), /RECOVER — 2\/5/);
        assert.match(describeGameNotice({ ...train, trainState: 'finish' }), /COMPLETE/);
        assert.match(describeGameNotice({ ...train, trainState: 'climb', trainEdgesGoal: 5 }), /CLIMB — 0\/5/);
        assert.match(
            describeGameNotice({ activeMode: 'survival', sessionStatus: 'RUNNING', survivalSpeedFloor: 42.4 }),
            /SURVIVAL: FLOOR 42%/
        );
        assert.equal(
            describeGameNotice({ activeMode: 'survival', sessionStatus: 'RUNNING', survivalSpeedFloor: 42.4 }).includes('CALIBRATING'),
            false
        );
        assert.match(
            describeGameNotice({ activeMode: 'survival', sessionStatus: 'RUNNING', survivalSpeedFloor: 42.4, survivalCalibrating: true }),
            /SURVIVAL: CALIBRATING — FLOOR 42%/
        );
    });

    it('never claims a game is still running during a Soft Landing', () => {
        // The session timer can hand ANY game to the 45 s tease-down, and it
        // leaves the game state exactly where it stood: the banner told the
        // wearer the Oracle was still deciding, or the training still
        // climbing, for the whole tease-down, while neither was true.
        const landings = [
            { ...oracle, sessionStatus: 'RAMPDOWN', oracleState: 'APPROACH' },
            { ...oracle, sessionStatus: 'RAMPDOWN', oracleState: 'HOLD', oracleTimer: 7 },
            { ...oracle, sessionStatus: 'RAMPDOWN', oracleState: 'PURGATORY' },
            { ...oracle, sessionStatus: 'RAMPDOWN', oracleState: 'RAMPDOWN' },
            { ...train, sessionStatus: 'RAMPDOWN', trainState: 'climb', trainEdgesGoal: 5 },
            { ...train, sessionStatus: 'RAMPDOWN', trainState: 'hold', trainHoldSeconds: 3 },
            { activeMode: 'survival', sessionStatus: 'RAMPDOWN', survivalSpeedFloor: 42 }
        ];
        for (const landing of landings) {
            const text = describeGameNotice(landing);
            assert.match(text, /SOFT LANDING/, `${landing.activeMode}/${landing.oracleState || landing.trainState}`);
            for (const lie of [/HOLDING/, /APPROACHING/, /PURGATORY/, /NOT YET/, /CLIMB/, /RECOVER/, /STAY UNDER/]) {
                assert.ok(!lie.test(text), `the banner still claims the game is running: ${text}`);
            }
        }
    });
});

describe('the cockpit cutoff banner', () => {
    const edged = {
        sessionStatus: 'RUNNING',
        isEdged: true,
        orgasmMode: false,
        stallGuardEngaged: false,
        primaryPercent: 0,
        secondaryPercent: 100
    };

    it('names what each channel was really sent', () => {
        // Ultimate Milker at the mark: the primary is parked, the secondary
        // really is milking, and that is the only case the old fixed
        // sentence described.
        assert.equal(
            describeCutoffNotice(edged),
            'CLIMAX LIMIT REACHED: PRIMARY CUT \u2014 SECONDARY MILKING (100%)'
        );
        // Crawl keeps the micro-motion on both channels in Classic Tease.
        assert.equal(
            describeCutoffNotice({ ...edged, primaryPercent: 10, secondaryPercent: 10 }),
            'CLIMAX LIMIT REACHED: PRIMARY CRAWLING (10%) \u2014 SECONDARY CRAWLING (10%)'
        );
        // Survival keeps climbing through the mark; the banner used to call
        // that running primary cut.
        assert.equal(
            describeCutoffNotice({ ...edged, primaryPercent: 52, secondaryPercent: 36 }),
            'CLIMAX LIMIT REACHED: PRIMARY RUNNING (52%) \u2014 SECONDARY MILKING (36%)'
        );
    });

    it('never calls a stopped secondary milking', () => {
        // Classic Tease with Full Stop and a vibrator on the secondary: both
        // motors are at 0%, and the banner told the wearer the secondary was
        // milking them, so they went looking for a broken toy or a wrong
        // role assignment.
        const text = describeCutoffNotice({ ...edged, primaryPercent: 0, secondaryPercent: 0 });
        assert.equal(text, 'CLIMAX LIMIT REACHED: PRIMARY CUT \u2014 SECONDARY STOPPED');
        assert.ok(!/MILKING/.test(text), `a stopped secondary is not milking: ${text}`);
        // Nor a crawling one - Global Intensity scales the 10% crawl to
        // anywhere from 5% to 15%, and all of that is still a crawl.
        for (const pct of [5, 10, 15]) {
            const crawling = describeCutoffNotice({ ...edged, secondaryPercent: pct });
            assert.ok(!/MILKING/.test(crawling), `${pct}% is a crawl, not milking: ${crawling}`);
            assert.match(crawling, new RegExp(`SECONDARY CRAWLING \\(${pct}%\\)`));
        }
    });

    it('asserts nothing at all once the session is not running', () => {
        // The edge flag deliberately survives a pause (clearing it counted a
        // phantom edge on the first tick after RESUME), so the banner went on
        // claiming an active secondary through every watchdog pause with all
        // motors stopped.
        for (const sessionStatus of ['PAUSED', 'IDLE', 'STOPPED', 'RAMPDOWN', undefined]) {
            assert.equal(
                describeCutoffNotice({ ...edged, sessionStatus }),
                '',
                `the banner must be silent in ${String(sessionStatus)}`
            );
        }
        // And the cases the banner never covered: not on the mark, Force
        // Orgasm (not a cutoff) and the stall guard (its own banner).
        assert.equal(describeCutoffNotice({ ...edged, isEdged: false }), '');
        assert.equal(describeCutoffNotice({ ...edged, orgasmMode: true }), '');
        assert.equal(describeCutoffNotice({ ...edged, stallGuardEngaged: true }), '');
        assert.equal(describeCutoffNotice(), '');
    });

    it('refuses to guess at a percentage it was not given', () => {
        const text = describeCutoffNotice({ ...edged, primaryPercent: NaN, secondaryPercent: undefined });
        assert.equal(text, 'CLIMAX LIMIT REACHED: PRIMARY UNKNOWN \u2014 SECONDARY UNKNOWN');
        // Out-of-range numbers are reported inside the scale, never as a
        // negative or a 300% motor.
        assert.match(describeCutoffNotice({ ...edged, primaryPercent: -5, secondaryPercent: 300 }), /PRIMARY CUT/);
        assert.match(describeCutoffNotice({ ...edged, primaryPercent: -5, secondaryPercent: 300 }), /SECONDARY MILKING \(100%\)/);
    });

    it('is the only thing app.js paints into the cutoff banner', () => {
        // index.html no longer carries the sentence, and app.js must not
        // reinvent one: a hand-built string is how the last one drifted away
        // from what the engine was sending.
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        assert.ok(!/SECONDARY MILKING ACTIVE/.test(html), 'the fixed banner sentence must be gone from the markup');
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.ok(/describeCutoffNotice\(/.test(src), 'app.js must ask for the text');
        assert.ok(!/CLIMAX LIMIT REACHED/.test(src), 'app.js must not build the text itself');
    });
});

describe('describeStallPauseNotice', () => {
    it('promises a crawl only where a crawl really comes back', () => {
        for (const mode of ['classic', 'milker', 'ultimate', 'shortener', 'headplay']) {
            assert.equal(
                describeStallPauseNotice({ mode, ceilingBehaviour: 'crawl' }),
                'STALL PAUSE: PRIMARY HALTED — CRAWL RESUMES AFTER THE PAUSE',
                `${mode} does come back to a crawl`
            );
        }
    });

    it('never promises a crawl in Ruin & Leak, whichever ceiling rule is set', () => {
        // The reported defect: on the defaults (Crawl, stall guard on, 20 s /
        // 8 s) a wearer parked on the pullback mark in Ruin & Leak was told a
        // crawl resumes in 8 seconds. The mode's 18 s lockout parks the
        // primary at 0% for as long as the pulse sits there, so it never did.
        for (const behaviour of ['crawl', 'stop', undefined]) {
            const text = describeStallPauseNotice({ mode: 'ruin', ceilingBehaviour: behaviour });
            assert.ok(!/CRAWL RESUMES/.test(text), `Ruin & Leak promised a crawl: ${text}`);
            assert.equal(text, 'STALL PAUSE: PRIMARY HALTED — RUIN LOCKOUT HOLDS IT AT 0%');
        }
    });

    it('never promises a crawl under Full Stop', () => {
        for (const mode of ['classic', 'milker', 'ultimate', 'oracle', 'edgetrain', undefined]) {
            const text = describeStallPauseNotice({ mode, ceilingBehaviour: 'stop' });
            assert.ok(!/CRAWL RESUMES/.test(text), `Full Stop promised a crawl in ${mode}: ${text}`);
            assert.equal(text, 'STALL PAUSE: PRIMARY HALTED — FULL STOP HOLDS IT AT 0%');
        }
    });

    it('says the speed comes back in Survival, which never parks on the mark', () => {
        // Survival ignores the "At the ceiling" setting the way Ruin & Leak
        // does - the speed climbs on its own clock - so Full Stop must not
        // make this sentence promise a 0% Survival is not going to give.
        for (const behaviour of ['crawl', 'stop', undefined]) {
            assert.equal(
                describeStallPauseNotice({ mode: 'survival', ceilingBehaviour: behaviour }),
                'STALL PAUSE: PRIMARY HALTED — SPEED RESUMES AFTER THE PAUSE',
                `Survival under ${behaviour}`
            );
        }
    });

    it('always reports the halt itself, whatever it is handed', () => {
        for (const args of [undefined, {}, { mode: 'nonsense', ceilingBehaviour: 'nonsense' }]) {
            assert.match(describeStallPauseNotice(args), /^STALL PAUSE: PRIMARY HALTED — /);
        }
    });

    it('leaves no stale sentence behind display:none', () => {
        // Between engagements the banner is hidden. It is emptied as well,
        // so a sentence painted for the last mode cannot be shown again by a
        // future paint that forgets to rewrite it first.
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const at = src.indexOf('describeStallPauseNotice({');
        assert.ok(at >= 0, 'the stall banner is no longer painted here');
        const block = src.slice(at, at + 700);
        assert.ok(/stallNotice\.textContent = '';/.test(block),
            'the banner must be emptied when it is not engaged');
        const clearAt = block.indexOf("stallNotice.textContent = '';");
        const toggleAt = block.indexOf("classList.toggle('hidden'");
        assert.ok(clearAt >= 0 && toggleAt > clearAt, 'it must be emptied before it is hidden');
    });

    it('is the only thing app.js paints into the stall banner', () => {
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        assert.ok(!/CRAWL RESUMES/.test(html), 'the fixed sentence must be gone from the markup');
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.ok(/describeStallPauseNotice\(/.test(src), 'app.js must ask for the text');
        assert.ok(!/CRAWL RESUMES/.test(src), 'app.js must not build the text itself');
        // And it must be handed the live mode and ceiling rule, not a guess.
        const at = src.indexOf('describeStallPauseNotice({');
        assert.ok(at >= 0, 'app.js does not call describeStallPauseNotice with arguments');
        const call = src.slice(at, at + 220);
        assert.ok(/mode: state\.activeMode/.test(call), 'the banner must be told the active mode');
        assert.ok(/ceilingBehaviour: advancedSettings\.ceilingBehaviour/.test(call), 'the banner must be told the ceiling rule');
    });
});

// ---- Ruin & Leak: one ride per edge ----------------------------------------

// A session driven the way app.js drives it, one second at a time. The pulse
// readings that arrived since the last tick come first (recordHrReading
// remembers each and runs the engine on it), then the 1 s master tick: the
// engine, then the Ruin clock and the stall guard in the one step app.js
// calls, then the engine again - whose output is what the toys hold until
// the next tick. A new edge re-arms the ride on whichever engine call raises
// its flag, and is counted on whichever call finds it held, as updateEngine
// does. A second with no reading (`pulse` gives null) is a slow relay: the
// ticks run on the last reading, and `readingGapMs` is the signal-loss
// timeout. Force Orgasm's clock runs the way app.js keeps it: back to 0 on
// every toggle, +1 after the guards on every second it is on (capped at
// ORGASM_BOOST_CAP), and the working ceiling raised by it, so the ramp moves
// exactly as it does in the page.
// Each row is one second: what the toys were sent, and the state behind it.
function driveSession({
    seconds,
    pulse,
    mode = () => 'ruin',
    ceilingBehaviour = 'crawl',
    stallGuard = true,
    holdTimeoutSeconds = DEFAULT_STALL_GUARD_SECONDS,
    pauseTimeoutSeconds = DEFAULT_STALL_PAUSE_SECONDS,
    orgasm = () => false,
    intensityValue = 50,
    readingGapMs
}) {
    let isEdged = false;
    let edgePending = false;
    let readings = [];
    let lastHr = NaN;
    let edges = 0;
    let ruin = { rideSeconds: 0, lockSeconds: 0, spent: false };
    let guard = { holdSeconds: 0, pauseSeconds: 0, engaged: false };
    let orgasmOn = false;
    let orgasmBoost = 0;
    const rows = [];
    const engine = (t, hr, activeMode, orgasmMode) => {
        const boost = orgasmMode ? orgasmBoost : 0;
        const out = calculateEngineOutputs({
            hr,
            edgeHr: hr,
            minHr: 70,
            maxHr: 140 + boost,
            activeMode,
            // A game borrows the selected tease mode's stroke: Ruin's, here.
            strokeMode: TEASE_MODES.includes(activeMode) ? activeMode : 'ruin',
            sessionStatus: 'RUNNING',
            isEdged,
            edgePending,
            recentReadings: readings,
            readingGapMs,
            orgasmMode,
            orgasmBoost: boost,
            sessionSeconds: t,
            warmupMinutes: 0,
            intensityValue,
            ceilingBehaviour,
            stallGuardEngaged: guard.engaged,
            ruinHoldSeconds: ruin.lockSeconds,
            ruinSpent: ruin.spent
        });
        isEdged = out.isEdged;
        edgePending = out.edgePending;
        if (out.pullbackStarted) ruin = startRuinEdge(ruin);
        if (out.newEdgeTriggered) edges += 1;
        return out;
    };
    for (let t = 1; t <= seconds; t += 1) {
        const activeMode = mode(t);
        const orgasmMode = orgasm(t);
        if (orgasmMode !== orgasmOn) {
            orgasmOn = orgasmMode;
            orgasmBoost = 0;
        }
        const packets = [].concat(pulse(t)).filter((bpm) => bpm !== null && bpm !== undefined);
        packets.forEach((bpm, i) => {
            // A strap's reading a second, and each packet of a busier second
            // a millisecond after the one before it.
            readings = rememberEdgeReading(readings, t * 1000 + i, bpm);
            lastHr = bpm;
            engine(t, bpm, activeMode, orgasmMode);
        });
        const hr = lastHr;
        engine(t, hr, activeMode, orgasmMode);
        const step = tickRuinAndStallGuard({ ruin, guard }, {
            activeMode, isEdged, orgasmMode, stallGuard, ceilingBehaviour, holdTimeoutSeconds, pauseTimeoutSeconds
        });
        ruin = step.ruin;
        guard = { holdSeconds: step.guard.holdSeconds, pauseSeconds: step.guard.pauseSeconds, engaged: step.guard.engaged };
        if (orgasmMode) orgasmBoost = Math.min(ORGASM_BOOST_CAP, orgasmBoost + 1);
        const out = engine(t, hr, activeMode, orgasmMode);
        const rideLeft = ruinRideSecondsLeft(ruin, { active: activeMode === 'ruin', isEdged });
        rows.push({
            t,
            hr,
            activeMode,
            isEdged,
            edges,
            primary: out.primaryPercent,
            secondary: out.secondaryPercent,
            ruin: { ...ruin },
            engaged: guard.engaged,
            cues: step.cues,
            rideLeft,
            banner: guard.engaged
                ? describeStallPauseNotice({
                    mode: activeMode,
                    ceilingBehaviour,
                    rideSecondsLeft: rideLeft,
                    pauseSecondsLeft: stallPauseSecondsLeft(guard, { pauseTimeoutSeconds })
                })
                : ''
        });
    }
    return rows;
}

const at = (rows, t) => rows.find((r) => r.t === t);
// The seconds a lockout started: the first row holding a full lockout.
const lockStarts = (rows) => rows
    .filter((r, i) => r.ruin.lockSeconds === RUIN_LOCK_SECONDS && (i === 0 || rows[i - 1].ruin.lockSeconds !== RUIN_LOCK_SECONDS))
    .map((r) => r.t);
const RIDE_TEXT = 'STALL PAUSE: PRIMARY HALTED — RUIN RIDE RESUMES AFTER THE PAUSE';
const LOCKOUT_TEXT = 'STALL PAUSE: PRIMARY HALTED — RUIN LOCKOUT HOLDS IT AT 0%';

describe('Ruin & Leak rides each edge once', () => {
    it('rides the edge, stops dead, and holds the primary at 0% for as long as the pulse stays on the mark', () => {
        // The reported defect: 1.1.0 started the ride again the moment the
        // 18 s lockout ran out, so a pulse parked on the mark got 12 s at up
        // to 74% out of every 30, without end. Five minutes on the mark, on
        // both ceiling rules, with and without the stall guard.
        for (const ceilingBehaviour of ['crawl', 'stop']) {
            for (const stallGuard of [true, false]) {
                const rows = driveSession({ seconds: 300, pulse: (t) => (t < 5 ? 90 : 145), ceilingBehaviour, stallGuard });
                const label = `${ceilingBehaviour}, stall guard ${stallGuard ? 'on' : 'off'}`;
                const onset = rows.find((r) => r.isEdged).t;
                const [lockAt, ...more] = lockStarts(rows);
                assert.equal(more.length, 0, `${label}: the lockout must start once, not every 30 s`);
                // The designed timings: twelve seconds on the mark (the onset
                // second counts), then eighteen seconds of lockout.
                assert.equal(lockAt - onset + 1, RUIN_RIDE_SECONDS, `${label}: the ride lasts ${RUIN_RIDE_SECONDS} s`);
                for (let t = onset; t < lockAt; t += 1) {
                    assert.ok(at(rows, t).primary > 0, `${label}: the ride keeps stroking at t=${t}`);
                }
                for (let i = 0; i < RUIN_LOCK_SECONDS; i += 1) {
                    assert.equal(at(rows, lockAt + i).ruin.lockSeconds, RUIN_LOCK_SECONDS - i, `${label}: lockout clock`);
                }
                for (const row of rows.filter((r) => r.t >= lockAt)) {
                    assert.equal(row.primary, 0, `${label}: the primary moved again at t=${row.t} with the pulse still on the mark`);
                    assert.equal(row.secondary, RUIN_LOCK_SECONDARY, `${label}: the secondary stays at the lockout level at t=${row.t}`);
                    assert.ok(row.isEdged, 'the pulse never left the mark');
                }
                assert.equal(at(rows, 300).ruin.spent, true);
                assert.equal(at(rows, 300).edges, 1, 'one edge, so one ride');
            }
        }
    });

    it('only a real release of the edge earns the next ride', () => {
        // The release point is the one the engine already uses: more than
        // EDGE_RELEASE_BPM below the mark. A dip that stops on it is not a
        // release and must not hand out a second ride; a dip below it is, and
        // the next crossing of the mark rides again - once.
        const onTheBand = 140 - EDGE_RELEASE_BPM;
        const pulse = (t) => {
            if (t < 5) return 90;
            if (t >= 60 && t < 70) return onTheBand;
            if (t >= 120 && t < 125) return onTheBand - 1;
            return 145;
        };
        const rows = driveSession({ seconds: 200, pulse });
        const [first, second, ...rest] = lockStarts(rows);
        assert.equal(rest.length, 0);
        for (const row of rows.filter((r) => r.t >= first && r.t < 120)) {
            assert.ok(row.isEdged, `a pulse sitting on the release point is still edged (t=${row.t})`);
            assert.equal(row.primary, 0, `no second ride without a release (t=${row.t})`);
        }
        const released = rows.filter((r) => r.t >= 120 && r.t < 125);
        assert.ok(released.every((r) => !r.isEdged), 'the dip below the release point released the edge');
        assert.ok(released.some((r) => r.primary > 0), 'off the edge, Ruin teases again');
        // The next crossing is a new edge. Its ride starts on the crossing
        // itself; it is counted a reading later, once the pulse has held at
        // the mark (this used to assert the count on the crossing).
        assert.ok(at(rows, 125).isEdged && at(rows, 125).edges === 1, 'the crossing pulls back, and is not counted yet');
        assert.equal(at(rows, 126).edges, 2, 'held for a second reading, the crossing is a new edge');
        const ride = rows.filter((r) => r.t >= 125 && r.t < second);
        assert.ok(ride.length > 0 && ride.length <= RUIN_RIDE_SECONDS);
        assert.ok(ride.every((r) => r.primary > 0), 'the new edge gets its ride');
        assert.ok(rows.filter((r) => r.t >= second).every((r) => r.primary === 0), 'and then the stop holds again');
    });

    it('a release during the lockout re-arms the next ride but never shortens the lockout', () => {
        const base = (t) => (t < 5 ? 90 : 145);
        const [lockAt] = lockStarts(driveSession({ seconds: 40, pulse: base }));
        // (a) The pulse drops out of the band a few seconds into the lockout
        // and stays out: the dead stop still runs its full 18 s.
        const dropped = driveSession({ seconds: 80, pulse: (t) => (t >= lockAt + 4 ? 120 : base(t)) });
        for (let t = lockAt; t < lockAt + RUIN_LOCK_SECONDS; t += 1) {
            assert.equal(at(dropped, t).primary, 0, `the lockout was cut short at t=${t}`);
        }
        assert.ok(!at(dropped, lockAt + RUIN_LOCK_SECONDS).isEdged);
        assert.ok(at(dropped, lockAt + RUIN_LOCK_SECONDS).primary > 0, 'off the edge after the lockout, Ruin teases again');
        // (b) It drops out and climbs back while the lockout is still running:
        // that is a new edge, and it rides - but only once the lockout is over.
        const back = driveSession({
            seconds: 120,
            pulse: (t) => (t >= lockAt + 4 && t < lockAt + 7 ? 120 : base(t))
        });
        // Counted on its second reading at the mark (it used to be the first).
        assert.equal(at(back, lockAt + 7).edges, 1, 'one reading back on the mark is not an edge yet');
        assert.equal(at(back, lockAt + 8).edges, 2, 'the climb back is a new edge');
        for (let t = lockAt; t < lockAt + RUIN_LOCK_SECONDS; t += 1) {
            assert.equal(at(back, t).primary, 0, `the new edge rode inside the lockout at t=${t}`);
        }
        const [, secondLock, ...rest] = lockStarts(back);
        assert.equal(rest.length, 0);
        const ride = back.filter((r) => r.t >= lockAt + RUIN_LOCK_SECONDS && r.t < secondLock);
        assert.ok(ride.length > 0 && ride.length <= RUIN_RIDE_SECONDS, `second ride of ${ride.length} s`);
        assert.ok(ride.every((r) => r.primary > 0));
        assert.ok(back.filter((r) => r.t >= secondLock).every((r) => r.primary === 0));
    });

    it('a pulse that releases and crosses back between two ticks still earns its ride; one that does not release does not', () => {
        // The tick only reads the edge flag once a second. The engine raises
        // the flag on the reading itself, and that is what re-arms the ride:
        // the ride is part of the pullback, and does not wait for the count,
        // which comes on the next reading (this used to assert the count at
        // the crossing, when the count was what re-armed it).
        const run = (dip) => driveSession({
            seconds: 90,
            pulse: (t) => {
                if (t < 5) return 90;
                if (t === 60) return [dip, 145];
                return 145;
            }
        });
        const released = run(140 - EDGE_RELEASE_BPM - 1);
        assert.equal(at(released, 60).edges, 1, 'one reading at the mark after the dip is not an edge yet');
        assert.ok(at(released, 60).primary > 0, 'the new edge rides');
        assert.equal(at(released, 61).edges, 2, 'held on the next reading, it is counted');
        assert.equal(lockStarts(released).length, 2);
        const held = run(140 - EDGE_RELEASE_BPM);
        assert.equal(at(held, 60).edges, 1);
        assert.ok(held.filter((r) => r.t >= 60).every((r) => r.primary === 0), 'no release, no ride');
    });

    it("a slow relay's second reading neither starts the ride over nor gives the edge a second one", () => {
        // An edge is counted a reading after its pullback, and on a relay app
        // that sends a reading every 15 s (with the signal-loss timeout raised
        // to 20 s, so the session runs at all) that reading comes after the
        // 12 s ride has already ended in the lockout. The ride belongs to the
        // pullback: re-armed on the count, it would have handed this one edge
        // a second ride the moment its lockout ran out.
        const rows = driveSession({
            seconds: 120,
            pulse: (t) => (t % 15 === 0 ? (t < 30 ? 100 : 145) : null),
            readingGapMs: 20000
        });
        const onset = rows.find((r) => r.isEdged).t;
        assert.equal(onset, 30);
        assert.equal(at(rows, onset).edges, 0, 'one reading on the mark is not an edge yet');
        assert.equal(at(rows, onset + 14).edges, 0);
        assert.equal(at(rows, onset + 15).edges, 1, 'the second reading, 15 s on, counts it');
        const [lockAt, ...more] = lockStarts(rows);
        assert.equal(lockAt - onset + 1, RUIN_RIDE_SECONDS, 'the ride ran its 12 s from the pullback');
        assert.ok(lockAt < onset + 15, 'and was over before the edge was counted');
        assert.equal(more.length, 0, 'one lockout');
        assert.ok(rows.filter((r) => r.t >= lockAt).every((r) => r.primary === 0), 'and no second ride on the same edge');
        assert.equal(at(rows, 120).edges, 1);
    });

    it('switching modes, re-selecting Ruin or running a game does not hand out a second ride', () => {
        // The clock is session state. 1.1.0 zeroed it on every mode card and
        // game toggle, so one tap during the lockout started a fresh ride.
        const pulse = (t) => (t < 5 ? 90 : 145);
        const [lockAt] = lockStarts(driveSession({ seconds: 40, pulse }));
        const plans = {
            'Classic and back during the lockout': (t) => (t >= lockAt + 3 && t < lockAt + 6 ? 'classic' : 'ruin'),
            'Classic and back after the lockout': (t) => (t >= lockAt + 25 && t < lockAt + 40 ? 'classic' : 'ruin'),
            'a game on and off during the lockout': (t) => (t >= lockAt + 3 && t < lockAt + 9 ? 'oracle' : 'ruin'),
            'every game in turn': (t) => (t >= lockAt + 2 && t < lockAt + 60 ? GAME_MODES[Math.floor(t / 7) % GAME_MODES.length] : 'ruin')
        };
        for (const [label, mode] of Object.entries(plans)) {
            for (const ceilingBehaviour of ['crawl', 'stop']) {
                const rows = driveSession({ seconds: 150, pulse, mode, ceilingBehaviour });
                const again = rows.filter((r) => r.t >= lockAt && r.activeMode === 'ruin' && r.primary > 0);
                assert.deepEqual(again.map((r) => r.t), [], `${label} (${ceilingBehaviour}): Ruin rode again`);
                assert.equal(lockStarts(rows).length, 1, `${label} (${ceilingBehaviour})`);
            }
        }
        // Leaving in the middle of the ride keeps what is left of it, no more.
        const split = driveSession({
            seconds: 120,
            pulse,
            mode: (t) => (t >= 9 && t < 40 ? 'classic' : 'ruin')
        });
        const ruinRide = split.filter((r) => r.activeMode === 'ruin' && r.isEdged && r.primary > 0);
        assert.ok(ruinRide.length <= RUIN_RIDE_SECONDS, `one ride in total across the switch, got ${ruinRide.length} s`);
        assert.ok(ruinRide.some((r) => r.t >= 40), 'the rest of the ride is still there on the way back');
        const [splitLock, ...splitRest] = lockStarts(split);
        assert.equal(splitRest.length, 0);
        assert.ok(split.filter((r) => r.t >= splitLock).every((r) => r.primary === 0));
    });

    it('Force Orgasm overrides the stop, and cancelling it on the mark goes back to 0%', () => {
        const rows = driveSession({
            seconds: 90,
            pulse: (t) => (t < 5 ? 90 : 145),
            orgasm: (t) => t >= 50 && t < 60
        });
        // Since 1.1.1 Force Orgasm ramps over 28 s from what the toy was
        // doing. Over this spent edge that is the dead stop, so it climbs
        // from there - it does not jump to a fresh ride on its first second.
        const forced = rows.filter((r) => r.t >= 50 && r.t < 60).map((r) => r.primary);
        assert.ok(forced[0] > 0 && forced[0] <= 5, `the ramp must start at the stop: ${forced.join(',')}`);
        assert.ok(forced.every((p, i) => i === 0 || p >= forced[i - 1] - 3), `the ramp must climb: ${forced.join(',')}`);
        assert.ok(forced[forced.length - 1] >= 25, `ten seconds in the ramp is well on its way: ${forced.join(',')}`);
        assert.ok(rows.filter((r) => r.t >= 60).every((r) => r.primary === 0), 'no ride after a cancelled Force Orgasm on the same edge');
    });

    it('holds on a pulse that wanders, whatever the settings (a seeded sweep)', () => {
        // The rules, checked second by second on random sessions: within one
        // stretch on the mark the primary never moves again after a lockout
        // has started (unless the engine counted a new edge inside it); a
        // lockout is never shorter than 18 s; the stall banner is right about
        // what the end of each pause brings; and no cue says something that
        // is not happening.
        let seed = 20260927;
        const random = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        const pick = (list) => list[Math.floor(random() * list.length)];
        let checkedPauses = 0;
        let checkedLocks = 0;
        for (let run = 0; run < 250; run += 1) {
            const segments = [];
            let t = 1;
            while (t <= 240) {
                const length = 1 + Math.floor(random() * 25);
                segments.push({ from: t, to: t + length, bpm: pick([100, 128, 134, 135, 138, 140, 142, 150]) });
                t += length;
            }
            const settings = {
                ceilingBehaviour: pick(['crawl', 'stop']),
                stallGuard: random() < 0.8,
                holdTimeoutSeconds: 3 + Math.floor(random() * 22),
                pauseTimeoutSeconds: 2 + Math.floor(random() * 12),
                intensityValue: pick([0, 50, 100])
            };
            const rows = driveSession({
                seconds: 240,
                pulse: (s) => segments.find((g) => s >= g.from && s < g.to).bpm,
                ...settings
            });
            const label = `run ${run} ${JSON.stringify(settings)}`;
            let lockedThisStretch = false;
            rows.forEach((row, i) => {
                const prev = rows[i - 1];
                if (!row.isEdged) lockedThisStretch = false;
                // A new edge inside a lockout rides once the lockout is over:
                // that is its first ride, not a second one.
                if (prev && row.edges > prev.edges) lockedThisStretch = false;
                const lockStarted = row.ruin.lockSeconds === RUIN_LOCK_SECONDS && (!prev || prev.ruin.lockSeconds !== RUIN_LOCK_SECONDS);
                if (lockStarted) {
                    checkedLocks += 1;
                    lockedThisStretch = true;
                    for (let k = 0; k < RUIN_LOCK_SECONDS && rows[i + k]; k += 1) {
                        assert.equal(rows[i + k].primary, 0, `${label}: lockout broken at t=${rows[i + k].t}`);
                    }
                }
                if (lockedThisStretch && row.isEdged && row.primary > 0) {
                    assert.fail(`${label}: a second ride on one edge at t=${row.t}`);
                }
                for (const cue of row.cues) {
                    assert.notEqual(cue, 'stallResume', `${label}: promised a crawl in Ruin at t=${row.t}`);
                    if (cue === 'stallRecover') assert.ok(!row.isEdged, `${label}: "recovered" on the mark at t=${row.t}`);
                }
                if (row.engaged && (!prev || !prev.engaged)) {
                    const claim = row.banner;
                    let j = i;
                    while (rows[j] && rows[j].engaged) {
                        assert.equal(rows[j].banner, claim, `${label}: the banner changed its mind at t=${rows[j].t}`);
                        j += 1;
                    }
                    const after = rows[j];
                    // Only a pause that ran its course is a promise to check:
                    // leaving the edge releases the guard early, and ends the ride.
                    if (after && after.isEdged && rows[j - 1].isEdged && after.edges === row.edges) {
                        checkedPauses += 1;
                        if (claim === RIDE_TEXT) {
                            assert.ok(after.rideLeft > 0 && after.primary > 0, `${label}: promised the ride back at t=${after.t}`);
                        } else {
                            assert.equal(claim, LOCKOUT_TEXT, label);
                            assert.equal(after.primary, 0, `${label}: promised the lockout, the ride came back at t=${after.t}`);
                        }
                    }
                }
            });
        }
        assert.ok(checkedLocks > 100, `the sweep must reach the lockout, reached it ${checkedLocks} times`);
        assert.ok(checkedPauses > 50, `the sweep must check real pauses, checked ${checkedPauses}`);
    });
});

describe('the stall guard during a Ruin ride', () => {
    it('is armed during the ride whichever ceiling rule is set, and cuts it at once', () => {
        // With Full Stop the guard used to be disarmed on the premise that
        // the primary is parked at 0% on the mark - which a Ruin ride is not.
        for (const ceilingBehaviour of ['crawl', 'stop']) {
            const rows = driveSession({
                seconds: 60,
                pulse: (t) => (t < 5 ? 90 : 145),
                ceilingBehaviour,
                holdTimeoutSeconds: 5,
                pauseTimeoutSeconds: 8
            });
            const halt = rows.find((r) => r.cues.includes('stallHalt'));
            assert.ok(halt, `${ceilingBehaviour}: the guard never engaged during the ride`);
            assert.ok(halt.rideLeft > 0, 'it engaged during the ride');
            assert.equal(halt.primary, 0, 'and cut the primary on the same second');
            // Five seconds into a twelve second ride, an eight second pause
            // outlasts it: the ride is over, and the banner says so for the
            // whole pause, which runs its course across the end of the ride.
            const paused = rows.filter((r) => r.engaged);
            assert.equal(paused.length, 8, 'the pause runs its full length');
            assert.ok(paused.every((r) => r.banner === LOCKOUT_TEXT));
            assert.ok(rows.filter((r) => r.t >= halt.t).every((r) => r.primary === 0));
            assert.ok(!rows.some((r) => r.cues.includes('stallResume')), 'no crawl is promised');
        }
    });

    it('leaving a paused ride for a Full Stop mode says nothing about recovering', () => {
        // Full Stop disarms the guard in Classic, which releases the pause
        // with the pulse still on the mark. "Recovered. Resume." there would
        // send someone who is still on the edge back up.
        const rows = driveSession({
            seconds: 40,
            pulse: (t) => (t < 5 ? 90 : 145),
            mode: (t) => (t < 9 ? 'ruin' : 'classic'),
            ceilingBehaviour: 'stop',
            holdTimeoutSeconds: 3,
            pauseTimeoutSeconds: 8
        });
        const halt = rows.find((r) => r.cues.includes('stallHalt'));
        assert.ok(halt && halt.t < 9, 'the guard engaged during the ride');
        const left = at(rows, 9);
        assert.equal(left.engaged, false, 'Full Stop released the pause');
        assert.ok(left.isEdged);
        assert.deepEqual(left.cues, [], 'and said nothing untrue about it');
        assert.equal(left.primary, 0, 'Full Stop holds the primary at 0%');
    });

    it('lets a ride with time left come back after a short pause, and says so', () => {
        for (const ceilingBehaviour of ['crawl', 'stop']) {
            const rows = driveSession({
                seconds: 60,
                pulse: (t) => (t < 5 ? 90 : 145),
                ceilingBehaviour,
                holdTimeoutSeconds: 3,
                pauseTimeoutSeconds: 2
            });
            const halt = rows.find((r) => r.cues.includes('stallHalt'));
            assert.equal(halt.banner, RIDE_TEXT, ceilingBehaviour);
            const resumed = rows.find((r) => r.t > halt.t && !r.engaged);
            assert.ok(resumed.primary > 0, 'the ride came back');
            const [lockAt] = lockStarts(rows);
            assert.ok(rows.filter((r) => r.t >= lockAt).every((r) => r.primary === 0 && !r.engaged));
            // The guard carved pauses out of the ride; it never made it longer.
            const onset = rows.find((r) => r.isEdged).t;
            assert.equal(lockAt - onset + 1, RUIN_RIDE_SECONDS);
        }
    });

    it('stands down in the lockout and the stop after it, where the primary is at 0% already', () => {
        // 1.1.0 kept it armed there with Crawl: it paused a primary that was
        // not moving, said the lockout held it, and spoke "Crawl again" when
        // the pause ended. The allow window that would run out on the very
        // second the ride does is the edge case: the ride ends first, so there
        // is nothing left to halt.
        for (const holdTimeoutSeconds of [RUIN_RIDE_SECONDS, RUIN_RIDE_SECONDS + 1, 20, 60]) {
            for (const ceilingBehaviour of ['crawl', 'stop']) {
                const rows = driveSession({ seconds: 200, pulse: (t) => (t < 5 ? 90 : 145), ceilingBehaviour, holdTimeoutSeconds });
                assert.ok(
                    rows.every((r) => !r.engaged && r.cues.length === 0),
                    `allow ${holdTimeoutSeconds} s, ${ceilingBehaviour}: the guard paused a primary that was already stopped`
                );
            }
        }
    });
});

describe('the Ruin clock and the guard rules, one by one', () => {
    it('tickRuin: counts the ride only in Ruin and only on the mark, then locks, then holds', () => {
        let clock = { rideSeconds: 0, lockSeconds: 0, spent: false };
        clock = tickRuin(clock, { active: false, isEdged: true });
        assert.deepEqual(clock, { rideSeconds: 0, lockSeconds: 0, spent: false }, 'a game or another mode does not ride');
        for (let s = 1; s < RUIN_RIDE_SECONDS; s += 1) {
            clock = tickRuin(clock, { active: true, isEdged: true });
            assert.deepEqual(clock, { rideSeconds: s, lockSeconds: 0, spent: false });
        }
        clock = tickRuin(clock, { active: true, isEdged: true });
        assert.deepEqual(clock, { rideSeconds: 0, lockSeconds: RUIN_LOCK_SECONDS, spent: true });
        for (let s = RUIN_LOCK_SECONDS - 1; s >= 0; s -= 1) {
            clock = tickRuin(clock, { active: s % 2 === 0, isEdged: true });
            assert.deepEqual(clock, { rideSeconds: 0, lockSeconds: s, spent: true }, 'the lockout runs down in any mode');
        }
        for (let s = 0; s < 100; s += 1) clock = tickRuin(clock, { active: true, isEdged: true });
        assert.deepEqual(clock, { rideSeconds: 0, lockSeconds: 0, spent: true }, 'and the ride does not come back on the mark');
        clock = tickRuin(clock, { active: true, isEdged: false });
        assert.deepEqual(clock, { rideSeconds: 0, lockSeconds: 0, spent: false }, 'a release re-arms it');
    });

    it('tickRuin: a release keeps a running lockout, and garbage cannot stop the clock', () => {
        const locked = { rideSeconds: 0, lockSeconds: 9, spent: true };
        assert.deepEqual(tickRuin(locked, { active: true, isEdged: false }), { rideSeconds: 0, lockSeconds: 8, spent: false });
        assert.deepEqual(
            tickRuin({ rideSeconds: NaN, lockSeconds: 'x', spent: 0 }, { active: true, isEdged: true }),
            { rideSeconds: 1, lockSeconds: 0, spent: false }
        );
        assert.equal(tickRuin({ rideSeconds: 0, lockSeconds: 9999, spent: true }, { active: true, isEdged: true }).lockSeconds, RUIN_LOCK_SECONDS - 1);
        assert.deepEqual(tickRuin(undefined, undefined), { rideSeconds: 0, lockSeconds: 0, spent: false });
    });

    it('startRuinEdge: a new edge re-arms the ride and keeps a running lockout', () => {
        assert.deepEqual(startRuinEdge({ rideSeconds: 7, lockSeconds: 11, spent: true }), { rideSeconds: 0, lockSeconds: 11, spent: false });
        let clock = startRuinEdge({ rideSeconds: 0, lockSeconds: 3, spent: true });
        for (let s = 0; s < 3; s += 1) clock = tickRuin(clock, { active: true, isEdged: true });
        assert.deepEqual(clock, { rideSeconds: 0, lockSeconds: 0, spent: false });
        clock = tickRuin(clock, { active: true, isEdged: true });
        assert.equal(clock.rideSeconds, 1, 'the new edge rides once the lockout is over');
    });

    it('ruinRideSecondsLeft counts exactly the seconds tickRuin still rides', () => {
        for (let ride = 0; ride < RUIN_RIDE_SECONDS; ride += 1) {
            let clock = { rideSeconds: ride, lockSeconds: 0, spent: false };
            const left = ruinRideSecondsLeft(clock, { active: true, isEdged: true });
            let ticks = 0;
            while (clock.lockSeconds === 0) {
                clock = tickRuin(clock, { active: true, isEdged: true });
                ticks += 1;
            }
            assert.equal(left, ticks, `from ${ride} s ridden`);
        }
        const riding = { rideSeconds: 4, lockSeconds: 0, spent: false };
        assert.equal(ruinRideSecondsLeft(riding, { active: false, isEdged: true }), 0, 'not in Ruin');
        assert.equal(ruinRideSecondsLeft(riding, { active: true, isEdged: false }), 0, 'not on the mark');
        assert.equal(ruinRideSecondsLeft({ ...riding, lockSeconds: 5 }, { active: true, isEdged: true }), 0, 'locked');
        assert.equal(ruinRideSecondsLeft({ ...riding, spent: true }, { active: true, isEdged: true }), 0, 'spent');
    });

    it('stallPauseSecondsLeft counts exactly the seconds tickStallGuard still pauses', () => {
        for (let limit = 2; limit <= 60; limit += 1) {
            for (let elapsed = 0; elapsed < limit; elapsed += 1) {
                let guard = { holdSeconds: 5, pauseSeconds: elapsed, engaged: true };
                const left = stallPauseSecondsLeft(guard, { pauseTimeoutSeconds: limit });
                let ticks = 0;
                while (guard.engaged) {
                    guard = tickStallGuard(guard, { armed: true, isEdged: true, holdTimeoutSeconds: 20, pauseTimeoutSeconds: limit });
                    ticks += 1;
                }
                assert.equal(left, ticks, `limit ${limit}, elapsed ${elapsed}`);
            }
        }
        // A limit lowered below what has already run ends the pause next tick.
        assert.equal(stallPauseSecondsLeft({ pauseSeconds: 7, engaged: true }, { pauseTimeoutSeconds: 3 }), 1);
        assert.equal(stallPauseSecondsLeft({ pauseSeconds: 7, engaged: false }, { pauseTimeoutSeconds: 8 }), 0);
    });

    it('stallGuardArmed: Crawl, or a Ruin ride under either rule; never a game, Force Orgasm or the guard off', () => {
        const base = { enabled: true, ceilingBehaviour: 'crawl', orgasmMode: false, activeMode: 'classic', ruinRiding: false, engaged: false };
        assert.equal(stallGuardArmed(base), true);
        assert.equal(stallGuardArmed({ ...base, ceilingBehaviour: 'stop' }), false, 'Full Stop parks the primary at 0%');
        for (const ceilingBehaviour of ['crawl', 'stop']) {
            const ruin = { ...base, activeMode: 'ruin', ceilingBehaviour };
            assert.equal(stallGuardArmed({ ...ruin, ruinRiding: true }), true, `a ride under ${ceilingBehaviour}`);
            assert.equal(stallGuardArmed(ruin), false, `the lockout under ${ceilingBehaviour}`);
            assert.equal(stallGuardArmed({ ...ruin, engaged: true }), true, `a pause that began in the ride runs out (${ceilingBehaviour})`);
            assert.equal(stallGuardArmed({ ...ruin, ruinRiding: true, orgasmMode: true }), false);
            assert.equal(stallGuardArmed({ ...ruin, ruinRiding: true, enabled: false }), false);
        }
        for (const activeMode of GAME_MODES) {
            assert.equal(stallGuardArmed({ ...base, activeMode, ruinRiding: true, engaged: true }), false, activeMode);
        }
        assert.equal(stallGuardArmed({ ...base, orgasmMode: true }), false);
        assert.equal(stallGuardArmed({ ...base, enabled: false }), false);
        assert.equal(stallGuardArmed(), false);
    });

    it('stallGuardCues: no crawl promised in Ruin, no "recovered" on the mark', () => {
        assert.deepEqual(stallGuardCues({ justEngaged: true }, { activeMode: 'ruin', isEdged: true }), ['stallHalt']);
        assert.deepEqual(stallGuardCues({ justResumed: true }, { activeMode: 'classic', isEdged: true }), ['stallResume']);
        assert.deepEqual(stallGuardCues({ justResumed: true }, { activeMode: 'ruin', isEdged: true }), []);
        assert.deepEqual(stallGuardCues({ justReleased: true }, { activeMode: 'classic', isEdged: false }), ['stallRecover']);
        assert.deepEqual(stallGuardCues({ justReleased: true }, { activeMode: 'classic', isEdged: true }), [], 'disarmed on the mark is not a recovery');
        assert.deepEqual(stallGuardCues(), []);
    });

    it('describeStallPauseNotice: the ride comes back only if it outlasts the pause', () => {
        for (const ceilingBehaviour of ['crawl', 'stop']) {
            assert.equal(describeStallPauseNotice({ mode: 'ruin', ceilingBehaviour, rideSecondsLeft: 6, pauseSecondsLeft: 5 }), RIDE_TEXT);
            assert.equal(
                describeStallPauseNotice({ mode: 'ruin', ceilingBehaviour, rideSecondsLeft: 5, pauseSecondsLeft: 5 }),
                LOCKOUT_TEXT,
                'on the tick they both run out the ride ends first'
            );
            assert.equal(describeStallPauseNotice({ mode: 'ruin', ceilingBehaviour, rideSecondsLeft: 0, pauseSecondsLeft: 3 }), LOCKOUT_TEXT);
        }
        // Outside Ruin the ride clock means nothing.
        assert.equal(
            describeStallPauseNotice({ mode: 'classic', ceilingBehaviour: 'crawl', rideSecondsLeft: 9, pauseSecondsLeft: 1 }),
            'STALL PAUSE: PRIMARY HALTED — CRAWL RESUMES AFTER THE PAUSE'
        );
    });
});

describe('sanitizeStoredHrLimits', () => {
    it('keeps a pair the wearer could have typed', () => {
        assert.deepEqual(sanitizeStoredHrLimits(65, 95), { minHr: 65, maxHr: 95 });
        assert.deepEqual(sanitizeStoredHrLimits('65', '95'), { minHr: 65, maxHr: 95 });
    });

    it('falls back to the factory pair on anything unusable', () => {
        const factory = { minHr: DEFAULT_MIN_HR, maxHr: DEFAULT_MAX_HR };
        for (const bad of [[undefined, undefined], ['', ''], ['abc', 'def'], [null, null],
            [70, 70], [140, 70], [70, 20], [70, 999], [-5, 140], [{}, []]]) {
            assert.deepEqual(sanitizeStoredHrLimits(bad[0], bad[1]), factory, `stored ${JSON.stringify(bad)}`);
        }
    });

    it('never restores a ceiling the clamp would refuse', () => {
        // A hand-edited store is the attack: every reachable result must be a
        // ceiling sanitizeHrLimits itself accepts, and never the stored one
        // when that is out of range.
        for (const raw of [999, 251, 1e9, '300', Infinity, NaN, '140abc', 29]) {
            const out = sanitizeStoredHrLimits(70, raw);
            assert.ok(out.maxHr >= 30 && out.maxHr <= 250, `ceiling out of range for ${raw}: ${out.maxHr}`);
            assert.ok(out.maxHr <= DEFAULT_MAX_HR, `a corrupt store raised the ceiling for ${raw}: ${out.maxHr}`);
        }
    });

    it('restores a narrow but legal pair exactly as it was typed', () => {
        // A pair the Session Setup fields accept must come back unchanged.
        // Repairing it - either by raising the ceiling or by dropping the
        // Resting HR to leave MIN_CEILING_GAP - would hand back limits the
        // wearer never typed, which is the very complaint this persistence
        // was added to answer. MIN_CEILING_GAP stays where it belongs, in
        // computeEffectiveCeiling, which only ever lowers the ceiling.
        assert.deepEqual(sanitizeStoredHrLimits(130, 140), { minHr: 130, maxHr: 140 });
        assert.deepEqual(sanitizeStoredHrLimits(70, 75), { minHr: 70, maxHr: 75 });
        assert.deepEqual(sanitizeStoredHrLimits(30, 31), { minHr: 30, maxHr: 31 });
        // And a narrow restored pair still cannot lift the working ceiling.
        const ceiling = computeEffectiveCeiling({ minHr: 130, maxHr: 140 });
        assert.ok(ceiling.maxHr <= 140, `narrow pair raised the working ceiling to ${ceiling.maxHr}`);
    });

    it('restores every pair the typed fields accept, byte for byte', () => {
        // The single promise of this feature: what you typed is what comes
        // back. A stored pair is clamped by sanitizeHrLimits and nothing
        // else, so the two paths can never disagree.
        for (let min = 30; min <= 250; min += 13) {
            for (let max = 30; max <= 250; max += 17) {
                const typed = sanitizeHrLimits(min, max, { minHr: DEFAULT_MIN_HR, maxHr: DEFAULT_MAX_HR });
                const restored = sanitizeStoredHrLimits(min, max);
                if (typed.valid) {
                    assert.deepEqual(restored, { minHr: typed.minHr, maxHr: typed.maxHr }, `${min}/${max}`);
                } else {
                    assert.deepEqual(restored, { minHr: DEFAULT_MIN_HR, maxHr: DEFAULT_MAX_HR }, `${min}/${max}`);
                }
                assert.ok(restored.maxHr <= Math.max(max, DEFAULT_MAX_HR), `${min}/${max} raised the ceiling`);
            }
        }
    });

    it('is idempotent, so a stored value survives a round trip unchanged', () => {
        for (const pair of [[70, 140], [65, 95], [70, 75], [40, 41], ['x', 'y'], [200, 250]]) {
            const once = sanitizeStoredHrLimits(pair[0], pair[1]);
            assert.deepEqual(sanitizeStoredHrLimits(once.minHr, once.maxHr), once, `pair ${pair}`);
        }
    });

    it('always leaves resting below climax', () => {
        for (let min = 25; min <= 260; min += 7) {
            for (let max = 25; max <= 260; max += 11) {
                const out = sanitizeStoredHrLimits(min, max);
                assert.ok(out.minHr < out.maxHr, `${min}/${max} restored as ${out.minHr}/${out.maxHr}`);
                assert.ok(out.maxHr <= Math.max(max, DEFAULT_MAX_HR), `${min}/${max} raised the ceiling`);
            }
        }
    });
});

describe('sanitizeStoredDuration / sanitizeStoredEndgame', () => {
    it('keeps a window the Session Setup fields would accept', () => {
        assert.deepEqual(sanitizeStoredDuration({
            durationMode: 'fixed',
            durationFixedMinutes: '42',
            durationMinMinutes: 10,
            durationMaxMinutes: 20
        }), {
            durationMode: 'fixed',
            durationFixedMinutes: 42,
            durationMinMinutes: 10,
            durationMaxMinutes: 20
        });
    });

    it('falls back per field on anything parseSessionDuration refuses', () => {
        const out = sanitizeStoredDuration({
            durationMode: 'sideways',
            durationFixedMinutes: 0,
            durationMinMinutes: 60,
            durationMaxMinutes: 30
        });
        assert.deepEqual(out, {
            durationMode: DEFAULT_DURATION_MODE,
            durationFixedMinutes: DEFAULT_FIXED_MINUTES,
            durationMinMinutes: DEFAULT_RANGE_MIN_MINUTES,
            durationMaxMinutes: DEFAULT_RANGE_MAX_MINUTES
        });
        // An empty store is the factory window.
        assert.deepEqual(sanitizeStoredDuration(), out);
        assert.deepEqual(sanitizeStoredDuration({}), out);
    });

    it('keeps the three real endgames and refuses anything else', () => {
        for (const type of ['orgasm', 'rampdown', 'denial']) {
            assert.equal(sanitizeStoredEndgame(type), type);
        }
        for (const junk of [undefined, null, '', 'ORGASM', 'finish', 42, {}]) {
            assert.equal(sanitizeStoredEndgame(junk), DEFAULT_ENDGAME_TYPE);
        }
    });
});

describe('sanitizeSessionLimits', () => {
    const factory = {
        minHr: DEFAULT_MIN_HR,
        maxHr: DEFAULT_MAX_HR,
        durationMode: DEFAULT_DURATION_MODE,
        durationFixedMinutes: DEFAULT_FIXED_MINUTES,
        durationMinMinutes: DEFAULT_RANGE_MIN_MINUTES,
        durationMaxMinutes: DEFAULT_RANGE_MAX_MINUTES,
        endgameType: DEFAULT_ENDGAME_TYPE
    };

    it('gives a brand-new install exactly the defaults index.html ships', () => {
        assert.deepEqual(sanitizeSessionLimits(), factory);
        assert.deepEqual(sanitizeSessionLimits({}), factory);
    });

    it('restores a whole typed set', () => {
        const typed = {
            minHr: 65,
            maxHr: 92,
            durationMode: 'fixed',
            durationFixedMinutes: 40,
            durationMinMinutes: 20,
            durationMaxMinutes: 50,
            endgameType: 'rampdown'
        };
        assert.deepEqual(sanitizeSessionLimits(typed), typed);
    });

    it('is idempotent and ignores the other settings around it', () => {
        const stored = { minHr: 70, maxHr: 4000, endgameType: 'whatever', stallGuard: false, voiceCues: {} };
        const once = sanitizeSessionLimits(stored);
        assert.deepEqual(sanitizeSessionLimits(once), once);
        assert.equal(once.maxHr, DEFAULT_MAX_HR);
        assert.equal(once.endgameType, DEFAULT_ENDGAME_TYPE);
        assert.ok(!('stallGuard' in once), 'it must only return the session limits');
    });
});

describe('app.js persists and restores the typed session limits', () => {
    const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

    it('clamps the stored set wherever settings enter', () => {
        // load, Apply and import all run syncGuardSettings.
        const at = src.indexOf('function syncGuardSettings');
        assert.ok(at >= 0, 'syncGuardSettings not found');
        const body = src.slice(at, src.indexOf('\n}', at));
        assert.ok(/sanitizeSessionLimits\(advancedSettings\)/.test(body),
            'the stored session limits must go through the sanitiser on the way in');
    });

    it('writes them through the same sanitiser and the same store as every other setting', () => {
        const at = src.indexOf('function persistSessionLimits');
        assert.ok(at >= 0, 'persistSessionLimits not found');
        const body = src.slice(at, src.indexOf('\n}', at));
        assert.ok(/sanitizeSessionLimits\(/.test(body), 'a written value is clamped exactly as a stored one is');
        assert.ok(/readHrLimits\(\)/.test(body), 'the HR pair must come from the validated reader');
        assert.ok(/if \(isRemotePage\) return/.test(body), 'a remote page must never write the host limits');
        // The write itself is coalesced (write-coalescer.js) so a burst of
        // keystrokes does not re-encode the whole settings blob per key, but
        // it must still end in the ONE store every other setting uses.
        assert.ok(/sessionLimitsWriter\.(schedule|flush)\(/.test(body), 'it must go through the settings writer');
        assert.ok(/createWriteCoalescer\(\{ write: \(\) => persistSettings\(\) \}\)/.test(src),
            'the coalesced write must be the existing settings store');
    });

    it('is wired to every field the wearer can type', () => {
        // #minHr / #maxHr, the duration window, the three mode buttons and
        // the endgame cards. Each one used to be lost on reload.
        // persistSessionLimits(true) writes on the spot, persistSessionLimits()
        // joins the coalescing window; both count as wired. The function's own
        // declaration is not a call.
        const calls = (src.match(/persistSessionLimits\(/g) || []).length
            - (src.match(/function persistSessionLimits\(/g) || []).length;
        assert.ok(calls >= 7, `only ${calls} persist calls: a field is still unsaved`);
        // The typed HR pair, saved as it is typed rather than only on blur.
        const hrAt = src.indexOf("['minHr', 'maxHr'].forEach(");
        assert.ok(hrAt >= 0, 'the HR inputs are no longer wired in one place - move this guard with them');
        const hrBlock = src.slice(hrAt, hrAt + 700);
        assert.ok(/persistSessionLimits\(/.test(hrBlock), 'a typed HR limit must be saved');
        assert.ok(/addEventListener\('input'/.test(hrBlock), 'it must be saved while typing, not only on blur');
        assert.ok(/durFixedBtn\?\.addEventListener\('click', \(\) => \{ setDurationMode\('fixed'\); persistSessionLimits\(true\); \}\)/.test(src));
        assert.ok(/state\.endgameType = card\.getAttribute\('data-endgame'\);[\s\S]{0,120}persistSessionLimits\(true\)/.test(src),
            'the Endgame Trigger must be saved when it is picked');
        // A deliberate single action is never left sitting in the window.
        for (const click of ["setDurationMode('fixed')", "setDurationMode('range')", "setDurationMode('endless')"]) {
            const at = src.indexOf(click + '; persistSessionLimits');
            assert.ok(at >= 0 && src.slice(at, at + 60).includes('persistSessionLimits(true)'),
                `${click} must be written on the spot, not coalesced`);
        }
    });

    it('never seeds the fallback HR pair from this device on a remote page', () => {
        // ?partner= / ?group_sub= mirror the HOST's limits. The pair
        // readHrLimits falls back to before the first host reading must stay
        // the factory 70 / 140 there, not whatever this browser has stored.
        const guard = src.indexOf('function syncGuardSettings');
        const guardBody = src.slice(guard, src.indexOf('\n}', guard));
        assert.ok(!/lastGoodHrLimits/.test(guardBody),
            'syncGuardSettings runs on every page: it must not seed the fallback pair');
        const at = src.indexOf('state.lastGoodHrLimits = { minHr: advancedSettings.minHr');
        assert.ok(at >= 0, 'the fallback pair is seeded nowhere - a host page needs it');
        const before = src.slice(Math.max(0, at - 900), at);
        assert.ok(/if \(!isRemotePage\) \{/.test(before),
            'the seed must sit inside the host-only branch that paints those fields');
    });

    it('never lets a remote page restore the limits stored in this browser', () => {
        // A remote page is told the host's HR limits over the wire and
        // NOTHING about their Target Mode or Endgame Trigger. The timer
        // sub-label reads state.durationMode, so a partner whose own browser
        // had Endless stored watched their screen announce Endless Mode
        // while the wearer ran a Mystery window. The whole restore sits
        // inside the host-only branch.
        const at = src.indexOf('function syncParamsUI');
        const body = src.slice(at, src.indexOf('\n}\n', at));
        const open = body.indexOf('if (!isRemotePage) {');
        assert.ok(open >= 0, 'the host-only branch is gone');
        const close = body.indexOf('\n    }', open);
        assert.ok(close > open, 'the host-only branch never closes');
        const hostOnly = body.slice(open, close);
        for (const restored of ['minHr', 'maxHr', 'paramFixedInput', 'paramMinInput', 'paramMaxInput']) {
            assert.ok(hostOnly.includes(`getElementById('${restored}')`),
                `${restored} is restored outside the host-only branch`);
        }
        for (const seeded of ['state.durationMode = advancedSettings.durationMode',
            'state.endgameType = advancedSettings.endgameType',
            'highlightEndgameCard(state.endgameType)',
            'state.lastGoodHrLimits = {']) {
            assert.ok(hostOnly.includes(seeded), `"${seeded}" is not host-only`);
            assert.equal(body.split(seeded).length - 1, 1, `"${seeded}" also runs outside the branch`);
        }
        // And syncGuardSettings, which runs on every page including a remote
        // one, must not seed them either.
        const guard = src.indexOf('function syncGuardSettings');
        const guardBody = src.slice(guard, src.indexOf('\n}', guard));
        assert.ok(!/state\.durationMode|state\.endgameType/.test(guardBody),
            'syncGuardSettings runs on a remote page: it must not seed the wearer settings');
    });

    it('restores them into the page on boot', () => {
        const at = src.indexOf('function syncParamsUI');
        assert.ok(at >= 0, 'syncParamsUI not found');
        const body = src.slice(at, src.indexOf('\n}\n', at));
        for (const id of ['minHr', 'maxHr', 'paramFixedInput', 'paramMinInput', 'paramMaxInput']) {
            assert.ok(body.includes(`getElementById('${id}')`), `${id} is not restored on boot`);
        }
        assert.ok(/highlightEndgameCard\(/.test(body), 'the endgame trigger is not restored on boot');
        assert.ok(/isRemotePage/.test(body), 'a remote page must keep the host limits it is shown');
        assert.ok(src.lastIndexOf('syncParamsUI();') > at, 'syncParamsUI must run at boot');
    });
});

describe('cool-down after edges', () => {
    const tease = ['classic', 'milker', 'shortener', 'headplay', 'ultimate'];

    it('the choices are the Guards options, and the defaults are Off and every 2nd edge', () => {
        assert.deepEqual(COOLDOWN_MINUTES_OPTIONS, [0, 1, 2, 3, 5]);
        assert.deepEqual(COOLDOWN_EVERY_OPTIONS, [1, 2, 3]);
        assert.equal(DEFAULT_COOLDOWN_MINUTES, 0);
        assert.equal(DEFAULT_COOLDOWN_EVERY_EDGES, 2);
        assert.ok(COOLDOWN_MINUTES_OPTIONS.includes(DEFAULT_COOLDOWN_MINUTES));
        assert.ok(COOLDOWN_EVERY_OPTIONS.includes(DEFAULT_COOLDOWN_EVERY_EDGES));
        assert.deepEqual(COOLDOWN_EVENTS, ['release', 'edgeResume']);
        assert.deepEqual(COOLDOWN_MODES, tease);
    });

    it('is eligible only in a running tease mode, and never during Force Orgasm', () => {
        for (const activeMode of [...ENGINE_MODES, 'ghost', undefined]) {
            for (const sessionStatus of ['RUNNING', 'RAMPDOWN', 'PAUSED', 'IDLE', undefined]) {
                for (const orgasmMode of [false, true]) {
                    const expected = sessionStatus === 'RUNNING' && !orgasmMode && tease.includes(activeMode);
                    assert.equal(
                        cooldownEligible({ activeMode, orgasmMode, sessionStatus }),
                        expected,
                        `${activeMode} ${sessionStatus} orgasm=${orgasmMode}`
                    );
                }
            }
        }
        assert.equal(cooldownEligible(), false);
        assert.equal(cooldownEligible({ activeMode: 'classic', sessionStatus: 'RUNNING' }), true, 'orgasmMode defaults to off');
    });

    // Drive the counter through a series of edges, every one eligible.
    const edgesAt = (every, minutes, times, event = 'release') => {
        let cd = Object.freeze({ count: 0, startedAt: null });
        const log = [];
        for (const t of times) {
            cd = Object.freeze(tickCooldown(cd, { event, sessionSeconds: t, minutes, every, eligible: true }));
            log.push(cd);
        }
        return log;
    };

    for (const every of COOLDOWN_EVERY_OPTIONS) {
        it(`with "every ${every}" a cool-down starts on edges ${every}, ${2 * every}, ${3 * every}...`, () => {
            // 30 s apart with a 5 min length, so none has run out between
            // two edges on the rhythm: the start moves only when the
            // rhythm lands, and stays put on the edges between.
            const times = [10, 40, 70, 100, 130, 160, 190];
            for (const event of COOLDOWN_EVENTS) {
                const log = edgesAt(every, 5, times, event);
                log.forEach((cd, i) => {
                    const n = i + 1;
                    assert.equal(cd.count, n, `${event} ${n}: count`);
                    assert.equal(cd.justStarted, n % every === 0, `${event} ${n}: justStarted`);
                    const lastOnRhythm = Math.floor(n / every) * every;
                    assert.equal(cd.startedAt, lastOnRhythm === 0 ? null : times[lastOnRhythm - 1], `${event} ${n}: startedAt`);
                });
            }
        });
    }

    it('a tick with no event, an edge that does not count, or an ineligible one changes nothing but expiry', () => {
        const running = Object.freeze({ count: 3, startedAt: 100 });
        for (const args of [
            { event: null, eligible: true },
            { eligible: true },
            { event: 'foo', eligible: true },
            { event: 'RELEASE', eligible: true },
            { event: 'release', countsAsEdge: false, eligible: true },
            { event: 'edgeResume', countsAsEdge: false, eligible: true },
            { event: 'release', eligible: false },
            { event: 'release' }
        ]) {
            const out = tickCooldown(running, { sessionSeconds: 150, minutes: 2, every: 1, ...args });
            assert.deepEqual(out, { count: 3, startedAt: 100, justStarted: false }, JSON.stringify(args));
        }
        // The same tick with a counted, eligible edge is the control.
        assert.deepEqual(
            tickCooldown(running, { sessionSeconds: 150, minutes: 2, every: 1, event: 'release', eligible: true }),
            { count: 4, startedAt: 150, justStarted: true }
        );
    });

    it('Off, or a length nobody could choose, never starts a cool-down but still counts the edges', () => {
        for (const minutes of [0, 4, 6, 0.5, -1, NaN, Infinity, '2', null, undefined]) {
            let cd = { count: 0, startedAt: null };
            for (const t of [10, 40, 70, 100]) {
                cd = tickCooldown(cd, { event: 'release', sessionSeconds: t, minutes, every: 1, eligible: true });
                assert.equal(cd.startedAt, null, `minutes ${minutes} at ${t}`);
                assert.equal(cd.justStarted, false, `minutes ${minutes} at ${t}`);
            }
            assert.equal(cd.count, 4, `minutes ${minutes}: the rhythm is still measured from the first edge`);
            // A start left over from a valid length is dropped the moment
            // the length is not one: nothing may hold the toys slow for a
            // time nobody chose.
            assert.equal(tickCooldown({ count: 2, startedAt: 90 }, { sessionSeconds: 100, minutes, every: 2 }).startedAt, null, `minutes ${minutes}`);
        }
    });

    it('a rhythm nobody could choose falls back to the factory one instead of silencing a cool-down that is on', () => {
        for (const every of [0, 4, -1, NaN, '2', null, undefined]) {
            const log = edgesAt(every, 2, [10, 40, 70, 100]);
            assert.deepEqual(log.map((cd) => cd.justStarted), [false, true, false, true], `every ${every}`);
        }
    });

    it('expires exactly at its length, and a later edge on the rhythm starts it again', () => {
        for (const minutes of [1, 2, 3, 5]) {
            const length = minutes * 60;
            const start = tickCooldown({ count: 1, startedAt: null }, { event: 'release', sessionSeconds: 100, minutes, every: 2, eligible: true });
            assert.deepEqual(start, { count: 2, startedAt: 100, justStarted: true });
            const lastSecond = tickCooldown(start, { sessionSeconds: 100 + length - 1, minutes, every: 2 });
            assert.deepEqual(lastSecond, { count: 2, startedAt: 100, justStarted: false }, `${minutes} min: still running one second before the end`);
            const over = tickCooldown(start, { sessionSeconds: 100 + length, minutes, every: 2 });
            assert.deepEqual(over, { count: 2, startedAt: null, justStarted: false }, `${minutes} min: over at the length`);
            // Edge 3 is off the rhythm; edge 4 is on it, whichever kind it is.
            const third = tickCooldown(over, { event: 'release', sessionSeconds: 100 + length + 30, minutes, every: 2, eligible: true });
            assert.deepEqual(third, { count: 3, startedAt: null, justStarted: false });
            const fourth = tickCooldown(third, { event: 'edgeResume', sessionSeconds: 100 + length + 60, minutes, every: 2, eligible: true });
            assert.deepEqual(fourth, { count: 4, startedAt: 100 + length + 60, justStarted: true });
        }
    });

    it('an edge on the rhythm during a running cool-down restarts it from the slowest point', () => {
        const first = tickCooldown({ count: 0, startedAt: null }, { event: 'release', sessionSeconds: 50, minutes: 2, every: 1, eligible: true });
        assert.deepEqual(first, { count: 1, startedAt: 50, justStarted: true });
        assert.equal(cooldownSecondsFor({ ...first, sessionSeconds: 80, minutes: 2 }), 30);
        const again = tickCooldown(first, { event: 'release', sessionSeconds: 80, minutes: 2, every: 1, eligible: true });
        assert.deepEqual(again, { count: 2, startedAt: 80, justStarted: true });
        assert.equal(cooldownSecondsFor({ ...again, sessionSeconds: 80, minutes: 2 }), 0);
    });

    it('a start after the present, or a missing clock, is dropped rather than kept', () => {
        assert.equal(tickCooldown({ count: 2, startedAt: 500 }, { sessionSeconds: 100, minutes: 2, every: 2 }).startedAt, null);
        for (const sessionSeconds of [NaN, undefined, null, '100', Infinity]) {
            const out = tickCooldown({ count: 1, startedAt: 40 }, { event: 'release', sessionSeconds, minutes: 2, every: 2, eligible: true });
            assert.equal(out.startedAt, null, `clock ${sessionSeconds}`);
            assert.equal(out.justStarted, false, `clock ${sessionSeconds}`);
            assert.equal(out.count, 2, 'the edge is still counted');
        }
    });

    it('a junk counter starts fresh, and never throws', () => {
        for (const prev of [null, undefined, {}, { count: NaN, startedAt: 'x' }, { count: -4, startedAt: NaN }, 'junk', 7, []]) {
            const out = tickCooldown(prev, { sessionSeconds: 10, minutes: 2, every: 2 });
            assert.deepEqual(out, { count: 0, startedAt: null, justStarted: false }, JSON.stringify(prev));
        }
        assert.equal(tickCooldown({ count: 2.6 }, { sessionSeconds: 10, minutes: 2, every: 2 }).count, 3);
        assert.deepEqual(tickCooldown(), { count: 0, startedAt: null, justStarted: false });
    });

    it('cooldownSecondsFor hands the engine the elapsed second only while a cool-down is in force', () => {
        assert.equal(cooldownSecondsFor({ startedAt: 100, sessionSeconds: 100, minutes: 2 }), 0);
        assert.equal(cooldownSecondsFor({ startedAt: 100, sessionSeconds: 101, minutes: 2 }), 1);
        assert.equal(cooldownSecondsFor({ startedAt: 100, sessionSeconds: 219, minutes: 2 }), 119);
        assert.equal(cooldownSecondsFor({ startedAt: 100, sessionSeconds: 220, minutes: 2 }), null);
        assert.equal(cooldownSecondsFor({ startedAt: 100, sessionSeconds: 99, minutes: 2 }), null, 'a start after the present is not a cool-down');
        assert.equal(cooldownSecondsFor({ startedAt: null, sessionSeconds: 100, minutes: 2 }), null);
        for (const minutes of [0, 4, NaN, '2', undefined]) {
            assert.equal(cooldownSecondsFor({ startedAt: 100, sessionSeconds: 110, minutes }), null, `minutes ${minutes}`);
        }
        for (const sessionSeconds of [NaN, undefined, Infinity, '110']) {
            assert.equal(cooldownSecondsFor({ startedAt: 100, sessionSeconds, minutes: 2 }), null, `clock ${sessionSeconds}`);
        }
        for (const startedAt of [NaN, undefined, '100', -Infinity]) {
            assert.equal(cooldownSecondsFor({ startedAt, sessionSeconds: 110, minutes: 2 }), null, `start ${startedAt}`);
        }
        assert.equal(cooldownSecondsFor(), null);
        // Whatever comes back is a second the engine's gate accepts: finite,
        // at or after the start and short of the length. warmupShape reads a
        // NaN or negative second as its SLOWEST point, so a wrong answer here
        // would pin the toys at 16% with no cool-down running.
        for (let t = 0; t < 400; t += 1) {
            const s = cooldownSecondsFor({ startedAt: 50, sessionSeconds: t, minutes: 3 });
            assert.ok(s === null || (Number.isFinite(s) && s >= 0 && s < 180), `t=${t} gave ${s}`);
            assert.equal(s === null, t < 50 || t >= 230, `t=${t}`);
        }
    });

    it('the badge counts the time left down in m:ss and is gone the second it runs out', () => {
        assert.equal(describeCooldownBadge({ startedAt: 100, sessionSeconds: 100, minutes: 2 }), 'COOL-DOWN 2:00');
        assert.equal(describeCooldownBadge({ startedAt: 100, sessionSeconds: 101, minutes: 2 }), 'COOL-DOWN 1:59');
        assert.equal(describeCooldownBadge({ startedAt: 100, sessionSeconds: 160, minutes: 2 }), 'COOL-DOWN 1:00');
        assert.equal(describeCooldownBadge({ startedAt: 100, sessionSeconds: 219, minutes: 2 }), 'COOL-DOWN 0:01');
        assert.equal(describeCooldownBadge({ startedAt: 100, sessionSeconds: 220, minutes: 2 }), '');
        assert.equal(describeCooldownBadge({ startedAt: 0, sessionSeconds: 0, minutes: 5 }), 'COOL-DOWN 5:00');
        assert.equal(describeCooldownBadge({ startedAt: 0, sessionSeconds: 0, minutes: 1 }), 'COOL-DOWN 1:00');
        assert.equal(describeCooldownBadge({ startedAt: 0, sessionSeconds: 125, minutes: 3 }), 'COOL-DOWN 0:55');
        assert.equal(describeCooldownBadge({ startedAt: null, sessionSeconds: 10, minutes: 2 }), '');
        assert.equal(describeCooldownBadge({ startedAt: 100, sessionSeconds: 110, minutes: 0 }), '');
        assert.equal(describeCooldownBadge(), '');
        for (let t = 0; t < 400; t += 1) {
            const text = describeCooldownBadge({ startedAt: 30, sessionSeconds: t, minutes: 3 });
            assert.ok(text === '' || /^COOL-DOWN [0-3]:[0-5]\d$/.test(text), text);
            assert.notEqual(text, 'COOL-DOWN 0:00');
            assert.equal(
                text === '',
                cooldownSecondsFor({ startedAt: 30, sessionSeconds: t, minutes: 3 }) === null,
                `t=${t}: the badge and the engine input agree on whether one is running`
            );
        }
    });

    it('a session: releases count, a resume from the pause on that same edge does not, and the clock expires it', () => {
        // The wiring calls this on every release, on every resume from an
        // edge pause (countsAsEdge false when that edge was already the
        // pullback the release counted) and once a second with no event.
        const args = { minutes: 1, every: 2 };
        const eligible = cooldownEligible({ activeMode: 'milker', orgasmMode: false, sessionStatus: 'RUNNING' });
        let cd = Object.freeze({ count: 0, startedAt: null });
        cd = tickCooldown(cd, { ...args, event: 'release', sessionSeconds: 120, eligible });
        assert.deepEqual(cd, { count: 1, startedAt: null, justStarted: false });
        cd = tickCooldown(cd, { ...args, event: 'edgeResume', countsAsEdge: false, sessionSeconds: 140, eligible });
        assert.deepEqual(cd, { count: 1, startedAt: null, justStarted: false }, 'the resume from the pause on that same edge is not a second edge');
        cd = tickCooldown(cd, { ...args, event: 'edgeResume', countsAsEdge: true, sessionSeconds: 200, eligible });
        assert.deepEqual(cd, { count: 2, startedAt: 200, justStarted: true }, 'an edge pause no pullback covered is the second edge');
        const secondsIntoIt = [];
        for (let t = 200; t <= 262; t += 1) {
            cd = tickCooldown(cd, { ...args, event: null, sessionSeconds: t, eligible });
            secondsIntoIt.push(cooldownSecondsFor({ ...cd, sessionSeconds: t, minutes: 1 }));
        }
        assert.equal(secondsIntoIt[0], 0);
        assert.equal(secondsIntoIt[59], 59);
        assert.equal(secondsIntoIt[60], null, 'over after 60 s');
        assert.deepEqual(cd, { count: 2, startedAt: null, justStarted: false });
        // During Force Orgasm the release is not an edge for the cool-down
        // at all: the wearer asked for full speed.
        const overdrive = tickCooldown(cd, {
            ...args,
            event: 'release',
            sessionSeconds: 300,
            eligible: cooldownEligible({ activeMode: 'milker', orgasmMode: true, sessionStatus: 'RUNNING' })
        });
        assert.deepEqual(overdrive, { count: 2, startedAt: null, justStarted: false });
    });
});
