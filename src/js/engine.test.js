import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    calculateEngineOutputs,
    ENGINE_MODES,
    resolveEngineMode,
    resolveCeilingBehaviour,
    hasReleasedEdge,
    EDGE_RELEASE_BPM,
    MIN_ZONE_WIDTH,
    CRAWL_PERCENT,
    SHORTENER_TOP_PERCENT,
    clampEdgeHoldPercent,
    resolveEdgeTriggerHr,
    describeEdgeHoldPreview,
    DEFAULT_EDGE_HOLD_PERCENT,
    MIN_EDGE_HOLD_PERCENT,
    MAX_EDGE_HOLD_PERCENT,
    gameEdgeReleased,
    micBoostReachesMotors,
    TEASE_MODES,
    COOLDOWN_MODES,
    GAME_MODES,
    cooldownShape
} from './engine.js';
import { MIN_MOVING_PERCENT, warmupShape, roundSpeed, ORGASM_RAMP_SECONDS } from './patterns.js';
import { rememberEdgeReading } from './edge-confirm.js';

// A plausible last dispatch for Force Orgasm's ramp to start from: speeds
// and a stroke window on the physical travel, as app.js hands them to the
// drivers.
const SENT_MID = { primary: 40, secondary: 30, strokeMin: 10, strokeMax: 70 };

// The readings a chest strap sent, one a second, oldest first, ending with
// the current one: what app.js hands the engine as recentReadings.
const readingsOf = (...bpms) => bpms.map((bpm, i) => ({ at: 1000 * (i + 1), bpm }));

// The engine fed the way app.js feeds it: one reading every `gapMs`, each
// remembered before the call, with the edge flag and a count still owed
// carried from call to call. Returns a function taking the next reading.
function strap(base, { gapMs = 1000 } = {}) {
    let isEdged = false;
    let edgePending = false;
    let readings = [];
    let at = 0;
    return (bpm, extra = {}) => {
        at += gapMs;
        readings = rememberEdgeReading(readings, at, bpm);
        const out = calculateEngineOutputs({
            ...base, hr: bpm, edgeHr: bpm, isEdged, edgePending, recentReadings: readings, ...extra
        });
        isEdged = out.isEdged;
        edgePending = out.edgePending;
        return out;
    };
}

const running = {
    hr: 95,
    minHr: 70,
    maxHr: 140,
    sessionStatus: 'RUNNING',
    rampdownSecondsLeft: 45,
    isEdged: false,
    orgasmMode: false,
    sessionSeconds: 20,
    warmupMinutes: 0,
    ceilingBehaviour: 'stop',
    stallGuardEngaged: false,
    oracleState: 'APPROACH',
    survivalSpeedFloor: 42
};

describe('engine modes', () => {
    it('lists every cockpit mode', () => {
        assert.deepEqual(ENGINE_MODES, [
            'classic', 'milker', 'shortener', 'headplay', 'ultimate', 'ruin', 'oracle', 'survival', 'edgetrain'
        ]);
    });

    it('falls unknown modes back to classic', () => {
        assert.equal(resolveEngineMode('not-a-mode'), 'classic');
        const unknown = calculateEngineOutputs({ ...running, activeMode: 'ghost' });
        const classic = calculateEngineOutputs({ ...running, activeMode: 'classic' });
        assert.equal(unknown.resolvedMode, 'classic');
        assert.equal(unknown.primaryPercent, classic.primaryPercent);
    });

    for (const mode of ENGINE_MODES) {
        it(`${mode} produces output while running mid-HR`, () => {
            const result = calculateEngineOutputs({ ...running, activeMode: mode });
            assert.equal(result.resolvedMode, mode);
            const moving = result.primaryPercent + result.secondaryPercent;
            assert.ok(moving > 0, `${mode} should not be a dead zero-output path`);
            assert.ok(result.strokeMaxPercent >= result.strokeMinPercent);
        });

        it(`${mode} is idle-safe`, () => {
            const result = calculateEngineOutputs({ ...running, activeMode: mode, sessionStatus: 'IDLE' });
            assert.equal(result.primaryPercent, 0);
            assert.equal(result.secondaryPercent, 0);
        });
    }

    it('a pause keeps the edge flag, so resuming does not count a phantom edge', () => {
        // The master clock calls the engine every second in every status and
        // writes result.isEdged straight back. Clearing the flag while paused
        // re-armed the detector, so the first RUNNING tick counted a brand
        // new edge: +1 on the counter, the 'edge' cue spoken, a connected
        // rotator reversed, and Adaptive Ceiling Decay walking the working
        // ceiling down. The heart-rate watchdog pauses and (with auto-resume,
        // the default) restarts the session by itself, so a strap that drops
        // one packet burst did this without the wearer touching anything.
        // The pulse has held at the mark on both readings, so an engine that
        // took the resumed flag for a new edge would count one here.
        const atMark = { ...running, activeMode: 'classic', hr: 140, isEdged: true, recentReadings: readingsOf(140, 140) };
        const first = calculateEngineOutputs(atMark);
        assert.equal(first.isEdged, true);

        for (const status of ['PAUSED', 'IDLE', 'STOPPED']) {
            const paused = calculateEngineOutputs({ ...atMark, sessionStatus: status });
            assert.equal(paused.primaryPercent, 0, `${status} must still silence the motors`);
            assert.equal(paused.secondaryPercent, 0);
            assert.equal(paused.newEdgeTriggered, false);
            assert.equal(paused.isEdged, true, `${status} must not release the edge`);

            const resumed = calculateEngineOutputs({ ...atMark, isEdged: paused.isEdged, edgePending: paused.edgePending });
            assert.equal(resumed.newEdgeTriggered, false, `resuming after ${status} must not count a new edge`);
            assert.equal(resumed.pullbackStarted, false, `resuming after ${status} must not start a new pullback`);
        }

        // A session that was never edged still resumes un-edged.
        const clean = calculateEngineOutputs({ ...running, sessionStatus: 'PAUSED', isEdged: false, hr: 140 });
        assert.equal(clean.isEdged, false);
    });

    it('classic full-stops at the ceiling with Full Stop selected', () => {
        const result = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: true,
            ceilingBehaviour: 'stop'
        });
        assert.equal(result.primaryPercent, 0);
        assert.equal(result.secondaryPercent, 0);
        assert.equal(result.isEdged, true);
    });

    it('classic crawls at the ceiling with Crawl selected, then stall-halts', () => {
        const crawl = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: true,
            ceilingBehaviour: 'crawl'
        });
        const halt = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: true,
            ceilingBehaviour: 'crawl',
            stallGuardEngaged: true
        });
        assert.equal(CRAWL_PERCENT, 10);
        assert.equal(crawl.primaryPercent, CRAWL_PERCENT);
        assert.equal(crawl.secondaryPercent, CRAWL_PERCENT);
        assert.equal(halt.primaryPercent, 0);
        // Stall guard cuts the PRIMARY stroker only; the secondary keeps crawling.
        assert.equal(halt.secondaryPercent, CRAWL_PERCENT);
    });

    it('an unknown ceiling behaviour falls back to crawl, "stop" is honoured', () => {
        assert.equal(resolveCeilingBehaviour(undefined), 'crawl');
        assert.equal(resolveCeilingBehaviour('garbage'), 'crawl');
        assert.equal(resolveCeilingBehaviour('stop'), 'stop');
        for (const mode of ['milker', 'ultimate']) {
            const stop = calculateEngineOutputs({ ...running, activeMode: mode, hr: 140, isEdged: true, ceilingBehaviour: 'stop' });
            const crawl = calculateEngineOutputs({ ...running, activeMode: mode, hr: 140, isEdged: true, ceilingBehaviour: 'crawl' });
            assert.equal(stop.primaryPercent, 0, `${mode} primary must full-stop`);
            assert.equal(crawl.primaryPercent, CRAWL_PERCENT, `${mode} primary must crawl`);
            assert.ok(stop.secondaryPercent > 0, `${mode} secondary keeps milking either way`);
        }
    });

    it('stall guard cuts primary but the secondary milker survives', () => {
        for (const mode of ['milker', 'ultimate']) {
            const halt = calculateEngineOutputs({
                ...running,
                activeMode: mode,
                hr: 140,
                isEdged: true,
                ceilingBehaviour: 'crawl',
                stallGuardEngaged: true
            });
            assert.equal(halt.primaryPercent, 0, `${mode} primary must be cut`);
            assert.ok(halt.secondaryPercent > 0, `${mode} secondary must keep running`);
        }
        const classicNoCrawl = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 100,
            ceilingBehaviour: 'crawl',
            stallGuardEngaged: true
        });
        assert.equal(classicNoCrawl.primaryPercent, 0);
        assert.ok(classicNoCrawl.secondaryPercent > 0);
    });

    it('shortener contracts the envelope toward the base once the pulse is close', () => {
        const early = [];
        for (let sessionSeconds = 0; sessionSeconds < 40; sessionSeconds += 1) {
            early.push(calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 120, sessionSeconds }));
        }
        assert.ok(Math.max(...early.map((sample) => sample.strokeMaxPercent)) >= 90, 'at 120 the window is still the full range');
        assert.ok(early.every((sample) => sample.strokeMinPercent === 0));
        const close = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 136 });
        assert.ok(close.strokeMaxPercent < 70, `strokeMax ${close.strokeMaxPercent}`);
        assert.equal(close.strokeMinPercent, 0);
    });

    it('shortener runs full length at rest and lands on base micro-strokes 0-35% at the ceiling', () => {
        assert.equal(SHORTENER_TOP_PERCENT, 35);
        const rest = [];
        for (let sessionSeconds = 0; sessionSeconds < 40; sessionSeconds += 1) {
            const sample = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 70, sessionSeconds });
            assert.equal(sample.strokeMinPercent, 0);
            assert.ok(sample.strokeMaxPercent <= 100);
            rest.push(sample.strokeMaxPercent);
        }
        // The allowed window at rest is the full range. The pattern uses
        // less of it some seconds and almost all of it on others.
        assert.ok(Math.max(...rest) >= 90, `rest tops ${Math.max(...rest)}`);
        assert.ok(Math.min(...rest) <= 70, `rest tops ${Math.min(...rest)}`);
        const mid = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 136 });
        assert.ok(mid.strokeMaxPercent < 100);
        assert.equal(mid.strokeMinPercent, 0);
        for (const sessionSeconds of [0, 7, 20, 33]) {
            const ceiling = calculateEngineOutputs({
                ...running, activeMode: 'shortener', hr: 140, isEdged: true,
                ceilingBehaviour: 'crawl', sessionSeconds
            });
            assert.equal(ceiling.strokeMinPercent, 0);
            assert.equal(ceiling.strokeMaxPercent, SHORTENER_TOP_PERCENT);
            const over = calculateEngineOutputs({
                ...running, activeMode: 'shortener', hr: 170, isEdged: true,
                ceilingBehaviour: 'crawl', sessionSeconds
            });
            assert.equal(over.strokeMaxPercent, SHORTENER_TOP_PERCENT);
        }
    });

    it('headplay climbs toward the glans once the pulse is close', () => {
        const early = [];
        for (let sessionSeconds = 0; sessionSeconds < 40; sessionSeconds += 1) {
            early.push(calculateEngineOutputs({ ...running, activeMode: 'headplay', hr: 120, sessionSeconds }));
        }
        assert.ok(Math.min(...early.map((sample) => sample.strokeMinPercent)) <= 15, 'at 120 the stroke still starts near the base');
        assert.ok(early.every((sample) => sample.strokeMaxPercent === 100));
        const close = calculateEngineOutputs({ ...running, activeMode: 'headplay', hr: 136 });
        assert.ok(close.strokeMinPercent >= 40, `strokeMin ${close.strokeMinPercent}`);
        assert.equal(close.strokeMaxPercent, 100);
    });

    it('milker cross-fades secondary up as HR rises', () => {
        const mean = (hr) => {
            let secondary = 0;
            let primary = 0;
            const n = 60;
            for (let sessionSeconds = 0; sessionSeconds < n; sessionSeconds += 1) {
                const sample = calculateEngineOutputs({ ...running, activeMode: 'milker', hr, sessionSeconds });
                secondary += sample.secondaryPercent;
                primary += sample.primaryPercent;
            }
            return { secondary: secondary / n, primary: primary / n };
        };
        const low = mean(75);
        const high = mean(125);
        assert.ok(high.secondary > low.secondary, `high ${high.secondary} low ${low.secondary}`);
        assert.ok(high.primary < low.primary, `high ${high.primary} low ${low.primary}`);
    });

    it('ruin rides the edge, then cuts the primary and drops the secondary', () => {
        const ride = calculateEngineOutputs({
            ...running,
            activeMode: 'ruin',
            hr: 140,
            isEdged: true,
            ruinHoldSeconds: 0,
            sessionSeconds: 0
        });
        assert.ok(ride.primaryPercent > 0, 'the ride keeps stroking through the edge');
        const lock = calculateEngineOutputs({
            ...running,
            activeMode: 'ruin',
            hr: 140,
            isEdged: true,
            ruinHoldSeconds: 10
        });
        assert.equal(lock.primaryPercent, 0);
        assert.equal(lock.secondaryPercent, 18);
    });

    it('milker near the ceiling pulses the secondary instead of pinning it', () => {
        const samples = [];
        for (let sessionSeconds = 0; sessionSeconds < 40; sessionSeconds += 1) {
            samples.push(calculateEngineOutputs({
                ...running,
                activeMode: 'milker',
                hr: 140,
                isEdged: true,
                sessionSeconds
            }));
        }
        assert.ok(samples.some((sample) => sample.secondaryPercent < 40));
        assert.ok(samples.some((sample) => sample.secondaryPercent > 70));
    });

    it('the same heart rate does not repeat on an 8 second beat', () => {
        const at = (sessionSeconds) => calculateEngineOutputs({
            ...running, activeMode: 'classic', hr: 100, sessionSeconds
        });
        const speeds = [];
        const depths = [];
        for (let sessionSeconds = 0; sessionSeconds < 48; sessionSeconds += 1) {
            const sample = at(sessionSeconds);
            speeds.push(sample.primaryPercent);
            depths.push(sample.strokeMaxPercent);
        }
        const uniqueSpeeds = new Set(speeds);
        const uniqueDepths = new Set(depths);
        assert.ok(uniqueSpeeds.size >= 8, `only ${uniqueSpeeds.size} speeds`);
        assert.ok(uniqueDepths.size >= 4, `only ${uniqueDepths.size} stroke lengths`);
        const sameBeat = speeds.filter((speed, index) => index >= 8 && speed === speeds[index - 8]);
        assert.ok(sameBeat.length < 20, 'an 8 second loop would match almost every sample');
    });

    it('head play stays on the shaft until the pulse is close to the mark', () => {
        const mid = calculateEngineOutputs({ ...running, activeMode: 'headplay', hr: 105, sessionSeconds: 0 });
        assert.ok(mid.strokeMinPercent < 20, `strokeMin ${mid.strokeMinPercent}`);
        assert.equal(mid.strokeMaxPercent, 100);
        const close = calculateEngineOutputs({ ...running, activeMode: 'headplay', hr: 136, sessionSeconds: 0 });
        assert.ok(close.strokeMinPercent >= 40, `strokeMin ${close.strokeMinPercent}`);
    });

    it('oracle approach pulls instead of teasing down', () => {
        const classic = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 120 });
        const oracle = calculateEngineOutputs({
            ...running,
            activeMode: 'oracle',
            oracleState: 'APPROACH',
            hr: 120
        });
        assert.ok(oracle.primaryPercent > classic.primaryPercent);
    });

    it('oracle hold/denial/climax/purgatory are distinct', () => {
        const hold = calculateEngineOutputs({ ...running, activeMode: 'oracle', oracleState: 'HOLD', isEdged: true, hr: 140 });
        const denial = calculateEngineOutputs({ ...running, activeMode: 'oracle', oracleState: 'DENIAL', hr: 140 });
        const climax = calculateEngineOutputs({
            ...running, activeMode: 'oracle', oracleState: 'CLIMAX', orgasmMode: true, orgasmBoost: 28, hr: 140
        });
        const purgatory = calculateEngineOutputs({ ...running, activeMode: 'oracle', oracleState: 'PURGATORY', sessionSeconds: 4 });
        // HOLD is a hold AT the pullback mark, so it obeys the wearer's
        // ceiling rule; `running` selects Full Stop.
        assert.equal(hold.primaryPercent, 0);
        assert.ok(hold.secondaryPercent > 0, 'the secondary channel keeps running');
        assert.equal(denial.primaryPercent, 0);
        assert.ok(climax.primaryPercent >= 70, 'a climax that has ramped is driving, not crawling');
        assert.ok(purgatory.primaryPercent > 0);
        assert.ok(purgatory.primaryPercent < 100);
    });

    it('every Oracle state at the pullback mark obeys the ceiling rule, exactly as Edge Training does', () => {
        // HOLD, PURGATORY and an edged APPROACH are all holds at the mark:
        // app.js only enters HOLD from state.isEdged and does not clear the
        // flag until the pulse leaves the release band. The stall guard is
        // deliberately disarmed for this mode (app.js), so the ceiling rule
        // is the ONLY thing that can stop the primary here. The two games
        // must never drift apart again.
        const atMark = { ...running, hr: 140, isEdged: true, orgasmMode: false, sessionSeconds: 4 };
        const oracleStates = ['HOLD', 'PURGATORY', 'APPROACH'];
        const trainStates = ['hold', 'recover', 'climb'];
        for (const oracleState of oracleStates) {
            const stop = calculateEngineOutputs({ ...atMark, activeMode: 'oracle', oracleState, ceilingBehaviour: 'stop' });
            assert.equal(stop.primaryPercent, 0, `oracle ${oracleState} must park the primary with Full Stop`);
            const crawl = calculateEngineOutputs({ ...atMark, activeMode: 'oracle', oracleState, ceilingBehaviour: 'crawl' });
            assert.equal(crawl.primaryPercent, CRAWL_PERCENT, `oracle ${oracleState} must crawl with Crawl`);
        }
        for (const trainingState of trainStates) {
            const stop = calculateEngineOutputs({ ...atMark, activeMode: 'edgetrain', trainingState, ceilingBehaviour: 'stop' });
            assert.equal(stop.primaryPercent, 0, `edgetrain ${trainingState} must park the primary with Full Stop`);
            // 'recover' is reached with the pulse still on the mark -
            // tickEdgeTraining only leaves it once the pulse drops out of the
            // release band - and it used to dead-stop the primary whichever
            // rule the wearer picked, so every counted hold was followed by
            // 0% for a wearer who chose Crawl to keep the edge alive.
            const crawl = calculateEngineOutputs({ ...atMark, activeMode: 'edgetrain', trainingState, ceilingBehaviour: 'crawl' });
            assert.equal(crawl.primaryPercent, CRAWL_PERCENT, `edgetrain ${trainingState} must crawl with Crawl`);
        }
        // Force Orgasm is still the one thing that overrides it.
        const forced = calculateEngineOutputs({
            ...atMark, activeMode: 'oracle', oracleState: 'HOLD', ceilingBehaviour: 'stop',
            orgasmMode: true, orgasmBoost: 28
        });
        assert.ok(forced.primaryPercent >= 70, 'Force Orgasm overrides Full Stop once it has ramped');
        // Global Intensity cannot smuggle motion past Full Stop either.
        const loud = calculateEngineOutputs({
            ...atMark, activeMode: 'oracle', oracleState: 'PURGATORY', ceilingBehaviour: 'stop', intensityValue: 100
        });
        assert.equal(loud.primaryPercent, 0);
    });

    it('a cancelled Force Orgasm settles at once instead of surging to 100%', () => {
        // Oracle CLIMAX and Edge Training 'finish' are only ever entered with
        // Force Orgasm ON (app.js arms it with the roll and with the finished
        // set), so reaching either with it OFF means the wearer cancelled.
        // app.js hands the game back to the climb on the NEXT tick, and the
        // engine used to run 100/100 until it did: the click dispatched
        // 100/100 and so did the tick after it, one to two seconds of both
        // channels at full speed for someone who had just said no.
        const below = { ...running, orgasmMode: false, isEdged: false, hr: 100, edgeHr: 100 };
        const withdrawn = calculateEngineOutputs({ ...below, activeMode: 'oracle', oracleState: 'CLIMAX' });
        const approach = calculateEngineOutputs({ ...below, activeMode: 'oracle', oracleState: 'APPROACH' });
        assert.equal(withdrawn.primaryPercent, approach.primaryPercent, 'a withdrawn climax IS the approach');
        assert.equal(withdrawn.secondaryPercent, approach.secondaryPercent);
        assert.ok(withdrawn.primaryPercent < 100, 'a withdrawn climax must not surge to 100%');

        const cancelled = calculateEngineOutputs({ ...below, activeMode: 'edgetrain', trainingState: 'finish' });
        const climb = calculateEngineOutputs({ ...below, activeMode: 'edgetrain', trainingState: 'climb' });
        assert.equal(cancelled.primaryPercent, climb.primaryPercent, 'a cancelled finish IS the climb');
        assert.equal(cancelled.secondaryPercent, climb.secondaryPercent);
        assert.ok(cancelled.primaryPercent < 100, 'a cancelled finish must not surge to 100%');

        // On the mark the ceiling rule still governs the primary in both.
        const atMark = { ...running, orgasmMode: false, isEdged: true, hr: 140, edgeHr: 140 };
        for (const probe of [
            { activeMode: 'oracle', oracleState: 'CLIMAX' },
            { activeMode: 'edgetrain', trainingState: 'finish' }
        ]) {
            const where = probe.oracleState || probe.trainingState;
            const stop = calculateEngineOutputs({ ...atMark, ...probe, ceilingBehaviour: 'stop' });
            assert.equal(stop.primaryPercent, 0, `${where} must park the primary with Full Stop`);
            const crawl = calculateEngineOutputs({ ...atMark, ...probe, ceilingBehaviour: 'crawl' });
            assert.equal(crawl.primaryPercent, CRAWL_PERCENT, `${where} must crawl with Crawl`);
        }

        // The first second stays with the game. A ramped Force Orgasm is high
        // and not a flat 100 on both channels.
        const settled = {
            oracle: approach,
            edgetrain: climb
        };
        for (const probe of [
            { activeMode: 'oracle', oracleState: 'CLIMAX' },
            { activeMode: 'edgetrain', trainingState: 'finish' }
        ]) {
            const armed = calculateEngineOutputs({ ...below, ...probe, orgasmMode: true, orgasmBoost: 0 });
            const quiet = settled[probe.activeMode];
            assert.equal(armed.primaryPercent, quiet.primaryPercent);
            assert.equal(armed.secondaryPercent, quiet.secondaryPercent);
            const forcing = calculateEngineOutputs({ ...below, ...probe, orgasmMode: true, orgasmBoost: 28, sessionSeconds: 3 });
            assert.ok(forcing.primaryPercent >= 70);
            assert.ok(forcing.secondaryPercent >= 60);
        }
    });

    it('Force Orgasm ramps with variance and can run past the typed max', () => {
        const parked = {
            ...running,
            activeMode: 'classic',
            hr: 140,
            edgeHr: 140,
            isEdged: true,
            ceilingBehaviour: 'stop',
            sessionSeconds: 4
        };
        const armed = calculateEngineOutputs({ ...parked, orgasmMode: true, orgasmBoost: 0 });
        assert.ok(armed.primaryPercent < 40, 'the first second does not slam the toys');
        const mid = calculateEngineOutputs({ ...parked, orgasmMode: true, orgasmBoost: 14 });
        const full = [];
        for (let sessionSeconds = 0; sessionSeconds < 36; sessionSeconds += 1) {
            full.push(calculateEngineOutputs({
                ...parked, orgasmMode: true, orgasmBoost: 28, sessionSeconds, maxHr: 155
            }));
        }
        assert.ok(mid.primaryPercent > armed.primaryPercent, 'halfway up the ramp is hotter than the start');
        assert.ok(Math.min(...full.map((sample) => sample.primaryPercent)) >= 70);
        assert.ok(new Set(full.map((sample) => sample.primaryPercent)).size >= 4, 'the top of the ramp is not one flat speed');
        assert.ok(full.some((sample) => sample.secondaryPercent < 100));
        assert.ok(full.every((sample) => sample.isEdged === true), 'overdrive does not release the edge');
        assert.ok(full.every((sample) => sample.newEdgeTriggered === false));
        // Stroke still lives inside the travel window the wearer set.
        const boxed = calculateEngineOutputs({
            ...parked, orgasmMode: true, orgasmBoost: 28, handyHwMin: 15, handyHwMax: 80, sessionSeconds: 6
        });
        assert.ok(boxed.strokeMinPercent >= 15);
        assert.ok(boxed.strokeMaxPercent <= 80);
    });

    it('every tease mode keeps the stroker working until the pulse is close to the mark', () => {
        const modes = ['classic', 'milker', 'shortener', 'headplay', 'ultimate', 'ruin'];
        for (const mode of modes) {
            for (const hr of [100, 120, 125]) {
                let low = 100;
                let reach = 100;
                for (let sessionSeconds = 0; sessionSeconds < 40; sessionSeconds += 1) {
                    const sample = calculateEngineOutputs({
                        ...running,
                        activeMode: mode,
                        hr,
                        edgeHr: hr,
                        isEdged: false,
                        ceilingBehaviour: 'crawl',
                        sessionSeconds
                    });
                    assert.equal(sample.isEdged, false, `${mode} at ${hr}`);
                    low = Math.min(low, sample.primaryPercent);
                    reach = Math.min(reach, sample.strokeMaxPercent - sample.strokeMinPercent);
                }
                assert.ok(low > 25, `${mode} at ${hr} dropped to ${low}`);
                assert.ok(reach >= 55, `${mode} at ${hr} shortest stroke was ${reach}`);
            }
            const atMark = calculateEngineOutputs({
                ...running,
                activeMode: mode,
                hr: 140,
                edgeHr: 140,
                isEdged: true,
                ceilingBehaviour: 'crawl'
            });
            if (mode === 'ruin') {
                assert.ok(atMark.primaryPercent > CRAWL_PERCENT, 'ruin keeps stroking on the mark');
            } else {
                assert.equal(atMark.primaryPercent, CRAWL_PERCENT, `${mode} crawls at the mark`);
            }
        }
    });

    it('ultimate keeps stroking until the pulse is close to the mark', () => {
        const sweep = (hr) => {
            const samples = [];
            for (let sessionSeconds = 0; sessionSeconds < 40; sessionSeconds += 1) {
                samples.push(calculateEngineOutputs({
                    ...running,
                    activeMode: 'ultimate',
                    hr,
                    edgeHr: hr,
                    isEdged: false,
                    ceilingBehaviour: 'crawl',
                    sessionSeconds
                }));
            }
            const primary = samples.map((sample) => sample.primaryPercent);
            const reach = samples.map((sample) => sample.strokeMaxPercent - sample.strokeMinPercent);
            return {
                low: Math.min(...primary),
                mean: primary.reduce((sum, value) => sum + value, 0) / primary.length,
                reach: Math.min(...reach)
            };
        };
        // 120 BPM is nowhere near a 140 max (resting 70). The old pattern
        // was already in its stop chapter here and would park the toy.
        const at120 = sweep(120);
        assert.ok(at120.low > 20, `lowest primary at 120 was ${at120.low}`);
        assert.ok(at120.mean > 35, `mean primary at 120 was ${at120.mean}`);
        assert.ok(at120.reach >= 55, `shortest stroke at 120 was ${at120.reach}`);
        const at125 = sweep(125);
        assert.ok(at125.low > 15, `lowest primary at 125 was ${at125.low}`);
        assert.ok(at125.mean > 28, `mean primary at 125 was ${at125.mean}`);
        // Crawl is still the pullback mark, not a pattern stop in the middle.
        const early = calculateEngineOutputs({
            ...running, activeMode: 'ultimate', hr: 125, edgeHr: 125, isEdged: false, ceilingBehaviour: 'crawl'
        });
        assert.ok(early.primaryPercent > CRAWL_PERCENT);
        assert.equal(early.isEdged, false);
        const atMark = calculateEngineOutputs({
            ...running, activeMode: 'ultimate', hr: 140, edgeHr: 140, isEdged: true, ceilingBehaviour: 'crawl'
        });
        assert.equal(atMark.primaryPercent, CRAWL_PERCENT);
    });

    it('Force Orgasm freezes the edge flag instead of releasing it', () => {
        // The overdrive raises the working ceiling 1 BPM per second, so the
        // pullback mark climbs away from a pulse that never moved. Releasing
        // the edge on that evidence meant the tick after the cancel counted a
        // brand-new edge: the counter, the spoken cue, a rotator reversal and
        // Adaptive Ceiling Decay, all for an edge that never ended. The pulse
        // has held at 140 on both readings, so a count here would be live.
        const edged = { ...running, activeMode: 'classic', isEdged: true, hr: 140, edgeHr: 140, recentReadings: readingsOf(140, 140) };
        const forcing = calculateEngineOutputs({ ...edged, orgasmMode: true, maxHr: 160 });
        assert.equal(forcing.isEdged, true, 'an inflated ceiling is not the pulse coming down');
        assert.equal(forcing.newEdgeTriggered, false);

        // The tick after the cancel, judged against the real ceiling again.
        const cancelled = calculateEngineOutputs({ ...edged, isEdged: forcing.isEdged, orgasmMode: false });
        assert.equal(cancelled.newEdgeTriggered, false, 'cancelling must not invent an edge');
        assert.equal(cancelled.isEdged, true);

        // A pulse that really did come down still releases, on that same tick.
        const recovered = calculateEngineOutputs({ ...edged, orgasmMode: false, hr: 110, edgeHr: 110 });
        assert.equal(recovered.isEdged, false);
        // And the freeze cannot arm a new edge while the orgasm runs either.
        const climbing = calculateEngineOutputs({ ...edged, isEdged: false, orgasmMode: true, maxHr: 160 });
        assert.equal(climbing.isEdged, false);
        assert.equal(climbing.newEdgeTriggered, false);
    });

    it('survival uses the accelerating floor', () => {
        const result = calculateEngineOutputs({ ...running, activeMode: 'survival', survivalSpeedFloor: 61 });
        assert.equal(result.primaryPercent, 61);
    });

    it('edge training pulls on the climb and obeys the ceiling rule on a hold', () => {
        const classic = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 120 });
        const climb = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'climb',
            hr: 120
        });
        assert.ok(climb.primaryPercent > classic.primaryPercent);
        // The hold sits AT the pullback mark, so the wearer's ceiling rule
        // decides what the primary does there: Full Stop parks it at 0%,
        // Crawl keeps the 10% micro-motion. Only Force Orgasm overrides it.
        const hold = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'hold',
            isEdged: true,
            hr: 140,
            ceilingBehaviour: 'stop'
        });
        assert.equal(hold.primaryPercent, 0);
        assert.ok(hold.secondaryPercent > 0, 'the secondary channel keeps running');
        const holdCrawl = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'hold',
            isEdged: true,
            hr: 140,
            ceilingBehaviour: 'crawl'
        });
        assert.equal(holdCrawl.primaryPercent, CRAWL_PERCENT);
        // The climb applies the same rule the second the mark is reached.
        const climbEdged = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'climb',
            isEdged: true,
            hr: 140,
            ceilingBehaviour: 'stop'
        });
        assert.equal(climbEdged.primaryPercent, 0);
        const climbEdgedCrawl = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'climb',
            isEdged: true,
            hr: 140,
            ceilingBehaviour: 'crawl'
        });
        assert.equal(climbEdgedCrawl.primaryPercent, CRAWL_PERCENT);
        // Recover is a hold at the mark too, so it answers to the same rule.
        const recover = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'recover',
            isEdged: true,
            hr: 140
        });
        assert.equal(recover.primaryPercent, 0);
        const recoverCrawl = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'recover',
            isEdged: true,
            hr: 140,
            ceilingBehaviour: 'crawl'
        });
        assert.equal(recoverCrawl.primaryPercent, CRAWL_PERCENT);
        assert.ok(recoverCrawl.secondaryPercent > 0, 'the secondary channel keeps running');
    });

    it('warmup starts slow and short, then opens to the full pattern', () => {
        const cold = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            warmupMinutes: 5,
            sessionSeconds: 0,
            hr: 80
        });
        const open = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            warmupMinutes: 0,
            sessionSeconds: 0,
            hr: 80
        });
        assert.ok(cold.primaryPercent < open.primaryPercent * 0.4, `cold ${cold.primaryPercent} open ${open.primaryPercent}`);
        assert.ok(cold.strokeMaxPercent < open.strokeMaxPercent);
        assert.ok(cold.strokeMaxPercent > cold.strokeMinPercent);
        const done = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            warmupMinutes: 5,
            sessionSeconds: 300,
            hr: 80
        });
        const sameBeat = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            warmupMinutes: 0,
            sessionSeconds: 300,
            hr: 80
        });
        assert.equal(done.primaryPercent, sameBeat.primaryPercent);
        assert.equal(done.strokeMaxPercent, sameBeat.strokeMaxPercent);
    });
});

describe('Force Orgasm starts from what the toys were last sent', () => {
    // 1.1.1 blended the ramp from the mode's own speeds worked out again with
    // no ceiling rule, no warm-up and no cool-down, so its first tick was never
    // what the toys were doing. Measured in the page on 1.1.2 with a mocked
    // Handy: armed on the mark with Crawl, The Handy was sent PUT /hamp/stop,
    // and /hamp/start a second later; armed 12 s into a five-minute warm-up at
    // 95 BPM, it went from 13% to 75% in one tick. app.js now hands the engine
    // what it last dispatched, and the ramp eases from exactly that.
    const asSent = (out) => ({
        primary: out.primaryPercent,
        secondary: out.secondaryPercent,
        strokeMin: out.strokeMinPercent,
        strokeMax: out.strokeMaxPercent
    });
    const sentBy = (input) => asSent(calculateEngineOutputs(input));

    // Where the defect was measured, and every mode's own way of holding the
    // toys: each is what the wearer was being sent when Force Orgasm went on.
    const SITUATIONS = [
        ['on the mark with Crawl', { activeMode: 'classic', hr: 140, edgeHr: 140, isEdged: true, ceilingBehaviour: 'crawl' }],
        ['on the mark with Full Stop', { activeMode: 'classic', hr: 140, edgeHr: 140, isEdged: true, ceilingBehaviour: 'stop' }],
        ['in the warm-up', { activeMode: 'classic', hr: 95, edgeHr: 95, warmupMinutes: 5, sessionSeconds: 12 }],
        ['in a cool-down', { activeMode: 'classic', hr: 110, edgeHr: 110, cooldownSeconds: 5, cooldownMinutes: 2 }],
        ['Glans Protector on the mark', { activeMode: 'shortener', hr: 140, edgeHr: 140, isEdged: true, ceilingBehaviour: 'crawl' }],
        ['Head Play on the mark', { activeMode: 'headplay', hr: 140, edgeHr: 140, isEdged: true, ceilingBehaviour: 'crawl' }],
        ['Prostate Milker mid-band', { activeMode: 'milker', hr: 115, edgeHr: 115 }],
        ['a Ruin & Leak ride', { activeMode: 'ruin', hr: 140, edgeHr: 140, isEdged: true }],
        ['a Ruin & Leak lockout', { activeMode: 'ruin', hr: 140, edgeHr: 140, isEdged: true, ruinHoldSeconds: 8, ruinSpent: true }],
        ['an Oracle hold', { activeMode: 'oracle', oracleState: 'HOLD', hr: 140, edgeHr: 140, isEdged: true, ceilingBehaviour: 'crawl' }],
        ['Survival', { activeMode: 'survival', survivalSpeedFloor: 35, hr: 120, edgeHr: 120 }],
        ['an Edge Training hold', { activeMode: 'edgetrain', trainingState: 'hold', hr: 140, edgeHr: 140, isEdged: true, ceilingBehaviour: 'crawl' }],
        ['a stall pause', { activeMode: 'classic', hr: 140, edgeHr: 140, isEdged: true, ceilingBehaviour: 'crawl', stallGuardEngaged: true }],
        ['a narrow travel envelope', { activeMode: 'headplay', hr: 128, edgeHr: 128, handyHwMin: 30, handyHwMax: 63 }]
    ];
    const INTENSITIES = [0, 50, 100];
    const T0 = 40;

    it('the first tick sends exactly what was sent, in every situation', () => {
        for (const [where, patch] of SITUATIONS) {
            for (const intensityValue of INTENSITIES) {
                const before = { ...running, sessionSeconds: T0, ...patch, intensityValue };
                const sent = sentBy(before);
                const armed = calculateEngineOutputs({ ...before, orgasmMode: true, orgasmBoost: 0, orgasmFrom: sent });
                assert.deepEqual(asSent(armed), sent, `${where}, intensity ${intensityValue}`);
                // Told nothing, the engine starts from what it sends without
                // Force Orgasm this second - for a caller that runs it every
                // second, the same thing.
                const untold = calculateEngineOutputs({ ...before, orgasmMode: true, orgasmBoost: 0 });
                assert.deepEqual(asSent(untold), sent, `${where}, intensity ${intensityValue}, nothing said about what was sent`);
            }
        }
        // The measured cases in numbers: the crawl stays the crawl, and the
        // warm-up's slow short stroke stays slow and short.
        const crawl = { ...running, activeMode: 'classic', hr: 140, edgeHr: 140, isEdged: true, ceilingBehaviour: 'crawl' };
        const crawlSent = sentBy(crawl);
        assert.equal(crawlSent.primary, CRAWL_PERCENT);
        assert.equal(calculateEngineOutputs({ ...crawl, orgasmMode: true, orgasmBoost: 0, orgasmFrom: crawlSent }).primaryPercent, CRAWL_PERCENT);
        const warm = { ...running, activeMode: 'classic', hr: 95, edgeHr: 95, warmupMinutes: 5, sessionSeconds: 12 };
        const warmSent = sentBy(warm);
        assert.ok(warmSent.primary < 20 && warmSent.strokeMax < 30, `the warm-up fixture must be slow and short: ${JSON.stringify(warmSent)}`);
        assert.deepEqual(asSent(calculateEngineOutputs({ ...warm, orgasmMode: true, orgasmBoost: 0, orgasmFrom: warmSent })), warmSent);
    });

    it('each second adds one ORGASM_RAMP_SECONDS-th of the way to the top, and a moving toy never gets 0%', () => {
        for (const [where, patch] of SITUATIONS) {
            for (const intensityValue of INTENSITIES) {
                const before = { ...running, sessionSeconds: T0, ...patch, intensityValue };
                const sent = sentBy(before);
                let previous = asSent(calculateEngineOutputs({ ...before, orgasmMode: true, orgasmBoost: 0, orgasmFrom: sent }));
                for (let boost = 1; boost <= ORGASM_RAMP_SECONDS + 4; boost += 1) {
                    const at = { ...before, sessionSeconds: T0 + boost, orgasmMode: true, orgasmFrom: sent };
                    const out = asSent(calculateEngineOutputs({ ...at, orgasmBoost: boost }));
                    // The top of this very second: what the ramp is heading for.
                    const top = asSent(calculateEngineOutputs({ ...at, orgasmBoost: ORGASM_RAMP_SECONDS }));
                    const share = Math.min(1, boost / ORGASM_RAMP_SECONDS);
                    const tag = `${where}, intensity ${intensityValue}, ${boost} s in`;
                    for (const key of ['primary', 'secondary', 'strokeMin', 'strokeMax']) {
                        const line = sent[key] + (top[key] - sent[key]) * share;
                        assert.ok(Math.abs(out[key] - line) <= 1, `${tag}: ${key} ${out[key]} is off the straight line (${line.toFixed(2)})`);
                    }
                    if (sent.primary > 0) assert.ok(out.primary >= MIN_MOVING_PERCENT, `${tag}: a moving primary was handed ${out.primary}%`);
                    if (sent.secondary > 0) assert.ok(out.secondary >= MIN_MOVING_PERCENT, `${tag}: a moving secondary was handed ${out.secondary}%`);
                    if (boost === 1) {
                        // The first second after the arming is one small step.
                        for (const key of ['primary', 'secondary']) {
                            const step = Math.abs(out[key] - previous[key]);
                            const allowed = Math.ceil(Math.abs(top[key] - sent[key]) / ORGASM_RAMP_SECONDS) + 1;
                            assert.ok(step <= allowed, `${tag}: ${key} jumped ${previous[key]} -> ${out[key]}`);
                        }
                    }
                    previous = out;
                }
            }
        }
    });

    it('the ramp is the same over every mode once it knows what was sent', () => {
        // The overdrive is applied to what the toys were sent and not to a
        // frame of the mode's worked out again, so neither the mode nor the
        // pulse, the edge, the warm-up, the cool-down or the stall guard
        // underneath can move it.
        const sent = { primary: 12, secondary: 20, strokeMin: 0, strokeMax: 60 };
        for (const boost of [0, 1, 7, 14, 21, 28, 40]) {
            const seen = new Set();
            for (const [, patch] of SITUATIONS.filter(([where]) => where !== 'a narrow travel envelope')) {
                const out = calculateEngineOutputs({ ...running, ...patch, sessionSeconds: 90, orgasmMode: true, orgasmBoost: boost, orgasmFrom: sent });
                seen.add(JSON.stringify(asSent(out)));
            }
            assert.equal(seen.size, 1, `${boost} s in: ${[...seen].join(' / ')}`);
        }
    });

    it('a stopped toy starts from the stop: a pause, a stall halt, Full Stop', () => {
        // What a pause sends every driver: both channels at 0 over the whole
        // travel. RESUME starts the ramp again from it (app.js).
        const stop = { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 };
        const first = calculateEngineOutputs({ ...running, orgasmMode: true, orgasmBoost: 0, orgasmFrom: stop });
        assert.deepEqual(asSent(first), stop);
        const second = calculateEngineOutputs({
            ...running, sessionSeconds: running.sessionSeconds + 1, orgasmMode: true, orgasmBoost: 1, orgasmFrom: stop
        });
        assert.ok(second.primaryPercent >= MIN_MOVING_PERCENT && second.primaryPercent <= 5, `one second in: ${second.primaryPercent}%`);
        assert.ok(second.secondaryPercent >= MIN_MOVING_PERCENT && second.secondaryPercent <= 5, `one second in: ${second.secondaryPercent}%`);
        // The stop's window is held inside a narrower travel envelope.
        const boxed = calculateEngineOutputs({ ...running, handyHwMin: 15, handyHwMax: 80, orgasmMode: true, orgasmBoost: 0, orgasmFrom: stop });
        assert.deepEqual(asSent(boxed), { primary: 0, secondary: 0, strokeMin: 15, strokeMax: 80 });
    });

    it('at the top the output no longer depends on where the ramp started', () => {
        const origins = [
            SENT_MID,
            { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 },
            { primary: 100, secondary: 100, strokeMin: 50, strokeMax: 100 },
            null
        ];
        for (const boost of [ORGASM_RAMP_SECONDS, 40, 60]) {
            const tops = new Set();
            for (const orgasmFrom of origins) {
                const out = calculateEngineOutputs({ ...running, hr: 140, edgeHr: 140, isEdged: true, orgasmMode: true, orgasmBoost: boost, orgasmFrom });
                tops.add(JSON.stringify(asSent(out)));
            }
            assert.equal(tops.size, 1, `${boost} s in: ${[...tops].join(' / ')}`);
        }
    });

    it('an origin it cannot read is replaced part by part with what the engine sends without Force Orgasm', () => {
        const base = { ...running, activeMode: 'classic', hr: 140, edgeHr: 140, isEdged: true, ceilingBehaviour: 'crawl' };
        const own = sentBy(base);
        const armed = (orgasmFrom, extra = {}) => asSent(calculateEngineOutputs({ ...base, ...extra, orgasmMode: true, orgasmBoost: 0, orgasmFrom }));
        for (const junk of [null, undefined, 'crawl', 42, [], {}]) {
            assert.deepEqual(armed(junk), own, `origin ${JSON.stringify(junk)}`);
        }
        // A speed that is not a number is no speed; the parts that are stand.
        assert.deepEqual(armed({ primary: '40', secondary: 30, strokeMin: 10, strokeMax: 70 }), { ...own, secondary: 30, strokeMin: 10, strokeMax: 70 });
        assert.deepEqual(armed({ primary: 40, secondary: NaN, strokeMin: 10, strokeMax: 70 }), { ...own, primary: 40, strokeMin: 10, strokeMax: 70 });
        // Speeds off either end are held to 0-100, and a crawl of a fraction
        // of a percent is still a motion.
        assert.deepEqual(armed({ primary: 180, secondary: -20, strokeMin: 10, strokeMax: 70 }), { primary: 100, secondary: 0, strokeMin: 10, strokeMax: 70 });
        assert.equal(armed({ primary: 0.3, secondary: 5, strokeMin: 10, strokeMax: 70 }).primary, MIN_MOVING_PERCENT);
        // A window the wrong way round is put right; one off both ends is held
        // to the travel; one too narrow to be an output, or left with no width
        // inside a narrowed envelope, is not a window, and the speeds stand.
        assert.deepEqual(armed({ primary: 40, secondary: 30, strokeMin: 70, strokeMax: 10 }), { primary: 40, secondary: 30, strokeMin: 10, strokeMax: 70 });
        assert.deepEqual(armed({ primary: 40, secondary: 30, strokeMin: -50, strokeMax: 300 }), { primary: 40, secondary: 30, strokeMin: 0, strokeMax: 100 });
        assert.deepEqual(armed({ primary: 40, secondary: 30, strokeMin: 40, strokeMax: 42 }), { ...own, primary: 40, secondary: 30 });
        const narrowed = { handyHwMin: 50, handyHwMax: 100 };
        const ownNarrowed = sentBy({ ...base, ...narrowed });
        assert.deepEqual(armed({ primary: 40, secondary: 30, strokeMin: 10, strokeMax: 30 }, narrowed), { ...ownNarrowed, primary: 40, secondary: 30 });
    });

    it('stays inside the travel envelope, ordered and no narrower than the engine sends there', () => {
        const origins = [
            SENT_MID,
            { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 },
            { primary: 70, secondary: 5, strokeMin: 88, strokeMax: 99 },
            null
        ];
        for (const [hwMin, hwMax] of [[0, 100], [15, 80], [30, 63], [45, 55], [90, 10]]) {
            const env = { min: Math.min(hwMin, hwMax), max: Math.max(hwMin, hwMax) };
            const narrowest = Math.max(1, Math.floor(((env.max - env.min) * MIN_ZONE_WIDTH) / 100));
            for (const orgasmFrom of origins) {
                for (let boost = 0; boost <= ORGASM_RAMP_SECONDS + 2; boost += 3) {
                    for (const mode of ENGINE_MODES) {
                        const out = calculateEngineOutputs({
                            ...running, activeMode: mode, hr: 130, edgeHr: 130, handyHwMin: hwMin, handyHwMax: hwMax,
                            sessionSeconds: 60 + boost, orgasmMode: true, orgasmBoost: boost, orgasmFrom
                        });
                        const tag = `${mode} envelope ${hwMin}-${hwMax} from ${JSON.stringify(orgasmFrom)} ${boost} s in`;
                        assert.ok(out.strokeMinPercent >= env.min && out.strokeMaxPercent <= env.max, `${tag}: ${out.strokeMinPercent}-${out.strokeMaxPercent}`);
                        assert.ok(out.strokeMaxPercent - out.strokeMinPercent >= narrowest, `${tag}: ${out.strokeMinPercent}-${out.strokeMaxPercent}`);
                        assert.ok(out.primaryPercent >= 0 && out.primaryPercent <= 100, tag);
                        assert.ok(out.secondaryPercent >= 0 && out.secondaryPercent <= 100, tag);
                    }
                }
            }
        }
    });

    it('only a running session is forced: a soft landing, a pause and a stopped session ignore the latch', () => {
        for (const sessionStatus of ['RAMPDOWN', 'PAUSED', 'IDLE']) {
            const base = { ...running, sessionStatus, rampdownSecondsLeft: 30, hr: 120, edgeHr: 120 };
            assert.deepEqual(
                calculateEngineOutputs({ ...base, orgasmMode: true, orgasmBoost: 20, orgasmFrom: SENT_MID }),
                calculateEngineOutputs({ ...base, orgasmMode: false }),
                sessionStatus
            );
        }
    });
});

describe('a soft landing that takes over from Force Orgasm never speeds the toys up', () => {
    // A RESUME starts Force Orgasm's ramp again from the stop the pause sent,
    // while the run's time limit keeps counting from the arming, so a run
    // paused in its last seconds runs out with its ramp still low. Measured
    // in the page with a mocked Handy: after a heart-rate watchdog pause and
    // auto-resume the limit's landing sent PUT /hamp/start and velocity 50
    // (75 at Global Intensity 100) to a Handy at a standstill, and after the
    // wearer's own PAUSE and RESUME the ramp had climbed back to 23% when the
    // landing sent 50%, as the cue said "Easing you down". app.js now hands a
    // landing that takes over from a run what the toys were last sent.
    const STOP = { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 };
    const LEFT = Array.from({ length: 46 }, (_, i) => 45 - i);
    const landing = (extra = {}) => calculateEngineOutputs({ ...running, hr: 150, edgeHr: 150, sessionStatus: 'RAMPDOWN', ...extra });
    const speeds = (out) => ({ primary: out.primaryPercent, secondary: out.secondaryPercent });

    it('a run resumed in its last seconds lands from where its ramp had got to, and eases down from there', () => {
        // Second by second, as app.js drives it: RESUME starts the ramp from
        // the stop, the ramp climbs for `climb` seconds, and the landing then
        // takes over from what was last sent.
        for (const intensityValue of [0, 50, 100]) {
            for (const climb of [0, 1, 2, 5, 9, 14]) {
                let sent = { primary: 0, secondary: 0 };
                for (let boost = 0; boost < climb; boost += 1) {
                    sent = speeds(calculateEngineOutputs({
                        ...running, intensityValue, hr: 150, edgeHr: 150, sessionSeconds: 300 + boost,
                        orgasmMode: true, orgasmBoost: boost, orgasmFrom: STOP
                    }));
                }
                let previous = sent;
                for (const rampdownSecondsLeft of LEFT) {
                    const tag = `intensity ${intensityValue}, ${climb} s of climb, ${rampdownSecondsLeft} s of landing left`;
                    const out = speeds(landing({ intensityValue, rampdownSecondsLeft, landingFrom: sent }));
                    assert.ok(out.primary <= previous.primary, `${tag}: primary ${previous.primary} -> ${out.primary}`);
                    assert.ok(out.secondary <= previous.secondary, `${tag}: secondary ${previous.secondary} -> ${out.secondary}`);
                    // Eased, not cut: a channel that was moving keeps moving
                    // until the landing's last second.
                    if (rampdownSecondsLeft > 0 && sent.primary > 0) assert.ok(out.primary >= MIN_MOVING_PERCENT, `${tag}: primary stopped early`);
                    if (rampdownSecondsLeft > 0 && sent.secondary > 0) assert.ok(out.secondary >= MIN_MOVING_PERCENT, `${tag}: secondary stopped early`);
                    previous = out;
                }
                assert.deepEqual(previous, { primary: 0, secondary: 0 }, 'the landing ends in a stop');
                // Told nothing, the landing is the one it always was, which
                // is exactly what took the toys up.
                const plain = speeds(landing({ intensityValue, rampdownSecondsLeft: 45 }));
                assert.ok(plain.primary > sent.primary, `the fixture must be a run below the landing's start: ${JSON.stringify({ sent, plain })}`);
            }
        }
        // The measured cases in numbers. A Handy at a standstill stays there
        // for the whole landing, at Global Intensity 100 as at 50.
        for (const intensityValue of [50, 100]) {
            for (const rampdownSecondsLeft of LEFT) {
                assert.deepEqual(speeds(landing({ intensityValue, rampdownSecondsLeft, landingFrom: { primary: 0, secondary: 0 } })), { primary: 0, secondary: 0 });
            }
        }
        assert.deepEqual(speeds(landing({ intensityValue: 100, rampdownSecondsLeft: 45 })), { primary: 75, secondary: 75 });
        // A ramp back at 23% (16% on the secondary) lands from 23% and 16%,
        // not from 50%.
        const from = { primary: 23, secondary: 16 };
        assert.deepEqual(speeds(landing({ rampdownSecondsLeft: 45, landingFrom: from })), from);
        assert.deepEqual(speeds(landing({ rampdownSecondsLeft: 44, landingFrom: from })), { primary: 23, secondary: 16 });
        assert.deepEqual(speeds(landing({ rampdownSecondsLeft: 23, landingFrom: from })), { primary: 12, secondary: 8 });
        assert.deepEqual(speeds(landing({ rampdownSecondsLeft: 1, landingFrom: from })), { primary: 1, secondary: 1 });
        assert.deepEqual(speeds(landing({ rampdownSecondsLeft: 0, landingFrom: from })), { primary: 0, secondary: 0 });
    });

    it('each channel starts at the lower of what was sent and the landing\'s own start, and never goes above either', () => {
        for (const intensityValue of [0, 13, 50, 77, 100]) {
            for (const sent of [
                { primary: 1, secondary: 90 }, { primary: 10, secondary: 10 }, { primary: 23, secondary: 16 },
                { primary: 40, secondary: 0 }, { primary: 60, secondary: 74 }, { primary: 100, secondary: 3 }
            ]) {
                let previous = null;
                for (const rampdownSecondsLeft of [...LEFT, 22.5, 0.4]) {
                    const tag = `intensity ${intensityValue}, sent ${JSON.stringify(sent)}, ${rampdownSecondsLeft} s left`;
                    const plain = landing({ intensityValue, rampdownSecondsLeft });
                    const out = landing({ intensityValue, rampdownSecondsLeft, landingFrom: sent });
                    assert.ok(out.primaryPercent <= plain.primaryPercent && out.primaryPercent <= sent.primary, `${tag}: primary ${out.primaryPercent}`);
                    assert.ok(out.secondaryPercent <= plain.secondaryPercent && out.secondaryPercent <= sent.secondary, `${tag}: secondary ${out.secondaryPercent}`);
                    if (rampdownSecondsLeft === 45) {
                        assert.equal(out.primaryPercent, Math.min(plain.primaryPercent, sent.primary), tag);
                        assert.equal(out.secondaryPercent, Math.min(plain.secondaryPercent, sent.secondary), tag);
                    }
                    if (previous && Number.isInteger(rampdownSecondsLeft)) {
                        assert.ok(out.primaryPercent <= previous.primaryPercent && out.secondaryPercent <= previous.secondaryPercent, `${tag}: went up`);
                    }
                    // The speeds only: the stroke is the landing's own.
                    assert.equal(out.strokeMinPercent, plain.strokeMinPercent, tag);
                    assert.equal(out.strokeMaxPercent, plain.strokeMaxPercent, tag);
                    assert.equal(out.isEdged, plain.isEdged, tag);
                    assert.equal(out.newEdgeTriggered, plain.newEdgeTriggered, tag);
                    if (Number.isInteger(rampdownSecondsLeft)) previous = out;
                }
            }
        }
    });

    it('a run at its top lands exactly as a landing always has', () => {
        // What a run sends at its top is above the landing's start on both
        // channels, whatever the mode, the pulse and Global Intensity, so the
        // landing after it is today's to the last percent - checked from the
        // run's own output, and over every speed at or above the start.
        for (const intensityValue of [0, 25, 50, 75, 100]) {
            for (const mode of ENGINE_MODES) {
                for (const sessionSeconds of [100, 137, 181, 222, 263]) {
                    const top = calculateEngineOutputs({
                        ...running, activeMode: mode, intensityValue, hr: 150, edgeHr: 150, sessionSeconds,
                        orgasmMode: true, orgasmBoost: ORGASM_RAMP_SECONDS + (sessionSeconds % 7), orgasmFrom: SENT_MID
                    });
                    for (const rampdownSecondsLeft of LEFT) {
                        const base = { activeMode: mode, intensityValue, rampdownSecondsLeft };
                        assert.deepEqual(
                            landing({ ...base, landingFrom: speeds(top) }),
                            landing(base),
                            `${mode}, intensity ${intensityValue}, top ${JSON.stringify(speeds(top))}, ${rampdownSecondsLeft} s left`
                        );
                    }
                }
            }
        }
        // The landing's start is half speed scaled by Global Intensity,
        // 50 x (0.5 + intensity / 100), before any rounding: every whole speed
        // from there up.
        for (let intensityValue = 0; intensityValue <= 100; intensityValue += 1) {
            const start = Math.ceil(25 + intensityValue / 2);
            for (let sent = start; sent <= 100; sent += 1) {
                for (const rampdownSecondsLeft of LEFT) {
                    assert.deepEqual(
                        speeds(landing({ intensityValue, rampdownSecondsLeft, landingFrom: { primary: sent, secondary: sent } })),
                        speeds(landing({ intensityValue, rampdownSecondsLeft })),
                        `intensity ${intensityValue}, sent ${sent}, ${rampdownSecondsLeft} s left`
                    );
                }
            }
        }
    });

    it('what it cannot read caps nothing, and only a landing reads it', () => {
        const at = { rampdownSecondsLeft: 30, intensityValue: 70 };
        const plain = landing(at);
        for (const junk of [null, undefined, 'stop', 42, [], {}, { primary: '10', secondary: '10' }, { primary: NaN, secondary: Infinity }]) {
            assert.deepEqual(landing({ ...at, landingFrom: junk }), plain, `landingFrom ${JSON.stringify(junk)}`);
        }
        // Channel by channel: the one it can read is capped, the other lands
        // as any landing does. Speeds off either end are held to 0-100.
        const capped = speeds(landing({ ...at, landingFrom: { primary: 12, secondary: 'x' } }));
        assert.deepEqual(capped, { primary: 8, secondary: plain.secondaryPercent });
        assert.deepEqual(speeds(landing({ ...at, landingFrom: { primary: 180, secondary: -20 } })), { primary: plain.primaryPercent, secondary: 0 });
        // A running session, forced or not, a pause and a stopped one never
        // read it: RESUME into RUNNING and a new session start from nothing.
        for (const sessionStatus of ['RUNNING', 'PAUSED', 'IDLE']) {
            for (const orgasmMode of [false, true]) {
                const base = { ...running, sessionStatus, hr: 120, edgeHr: 120, orgasmMode, orgasmBoost: 9, orgasmFrom: SENT_MID };
                assert.deepEqual(
                    calculateEngineOutputs({ ...base, landingFrom: { primary: 2, secondary: 2 } }),
                    calculateEngineOutputs(base),
                    `${sessionStatus}${orgasmMode ? ' forced' : ''}`
                );
            }
        }
    });
});

describe('engine safety guards', () => {
    it('head play during warm-up stays inside the head window', () => {
        // Warm-up used to cap strokeMax at 55 while head play had already
        // lifted strokeMin to 75, which collapsed the zone.
        const result = calculateEngineOutputs({
            ...running,
            activeMode: 'headplay',
            hr: 135,
            warmupMinutes: 5,
            sessionSeconds: 0
        });
        const open = calculateEngineOutputs({
            ...running,
            activeMode: 'headplay',
            hr: 135,
            warmupMinutes: 0,
            sessionSeconds: 0
        });
        assert.ok(result.strokeMaxPercent - result.strokeMinPercent >= MIN_ZONE_WIDTH);
        assert.ok(result.strokeMinPercent >= open.strokeMinPercent);
        assert.ok(result.strokeMaxPercent <= open.strokeMaxPercent);
        assert.ok(result.primaryPercent < open.primaryPercent);
    });

    it('no mode, pattern, game, warm-up or orgasm leaves the travel envelope', () => {
        const games = ['oracle', 'survival', 'edgetrain'];
        for (const mode of ENGINE_MODES) {
            for (const sessionSeconds of [0, 3, 7, 12, 20, 40]) {
                for (const hr of [70, 105, 140]) {
                    for (const orgasmMode of [false, true]) {
                        const result = calculateEngineOutputs({
                            ...running,
                            activeMode: mode,
                            strokeMode: games.includes(mode) ? 'headplay' : undefined,
                            handyHwMin: 15,
                            handyHwMax: 80,
                            hr,
                            edgeHr: hr,
                            sessionSeconds,
                            isEdged: hr >= 140,
                            orgasmMode,
                            warmupMinutes: sessionSeconds === 0 ? 5 : 0,
                            ruinHoldSeconds: sessionSeconds % 2 ? 8 : 0,
                            oracleState: 'HOLD',
                            trainingState: 'hold'
                        });
                        assert.ok(
                            result.strokeMinPercent >= 15
                                && result.strokeMaxPercent <= 80
                                && result.strokeMaxPercent > result.strokeMinPercent,
                            `${mode} t=${sessionSeconds} hr=${hr} orgasm=${orgasmMode} zone ${result.strokeMinPercent}-${result.strokeMaxPercent}`
                        );
                    }
                }
            }
        }
    });

    it('a game borrows the selected tease stroke instead of its own zone', () => {
        const held = calculateEngineOutputs({
            ...running,
            activeMode: 'oracle',
            strokeMode: 'shortener',
            oracleState: 'HOLD',
            hr: 140,
            isEdged: true,
            handyHwMin: 15,
            handyHwMax: 80
        });
        assert.equal(held.primaryPercent, 0);
        assert.equal(held.strokeMinPercent, 15);
        assert.equal(held.strokeMaxPercent, 15 + Math.round(0.35 * 65));
    });

    it('an inverted or narrow hardware envelope still yields an ordered zone', () => {
        const inverted = calculateEngineOutputs({ ...running, activeMode: 'headplay', hr: 130, handyHwMin: 90, handyHwMax: 10 });
        assert.ok(inverted.strokeMaxPercent > inverted.strokeMinPercent);
        assert.ok(inverted.strokeMinPercent >= 10 && inverted.strokeMaxPercent <= 90);
        const narrow = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 130, handyHwMin: 50, handyHwMax: 52 });
        assert.ok(narrow.strokeMaxPercent > narrow.strokeMinPercent);
        const idle = calculateEngineOutputs({ ...running, sessionStatus: 'IDLE', handyHwMin: 80, handyHwMax: 20 });
        assert.ok(idle.strokeMaxPercent > idle.strokeMinPercent);
    });

    it('every mode keeps the zone at least MIN_ZONE_WIDTH wide across the HR band', () => {
        for (const mode of ENGINE_MODES) {
            for (let hr = 70; hr <= 150; hr += 5) {
                for (const sessionSeconds of [0, 60, 299, 400]) {
                    const r = calculateEngineOutputs({ ...running, activeMode: mode, hr, warmupMinutes: 5, sessionSeconds, isEdged: hr >= 140 });
                    assert.ok(r.strokeMaxPercent - r.strokeMinPercent >= MIN_ZONE_WIDTH, `${mode} hr=${hr} t=${sessionSeconds} zone ${r.strokeMinPercent}-${r.strokeMaxPercent}`);
                }
            }
        }
    });

    it('hysteresis: the edge only releases below ceiling minus the release band', () => {
        assert.equal(EDGE_RELEASE_BPM, 5);
        assert.equal(hasReleasedEdge(134, 140), true);
        assert.equal(hasReleasedEdge(135, 140), false);
        assert.equal(hasReleasedEdge(NaN, 140), false);
        const stillEdged = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 136, isEdged: true });
        assert.equal(stillEdged.isEdged, true);
        assert.equal(stillEdged.primaryPercent, 0);
        const boundary = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 135, isEdged: true });
        assert.equal(boundary.isEdged, true);
        const released = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 134, isEdged: true });
        assert.equal(released.isEdged, false);
        assert.ok(released.primaryPercent > 0);
    });

    it('newEdgeTriggered fires exactly once per crossing, on the reading that holds it', () => {
        // This used to count the edge on `first`, the first reading at the
        // mark: that is how one glitch, or the one reading of a posture spike
        // that touched the mark, became an edge. The pullback still starts on
        // that reading; the count waits for the next one to be at the mark
        // too (edge-confirm.js).
        const next = strap({ ...running, activeMode: 'classic' });
        next(120);
        const first = next(141);
        assert.equal(first.isEdged, true, 'the pullback starts on the first reading');
        assert.equal(first.pullbackStarted, true);
        assert.equal(first.newEdgeTriggered, false, 'one reading is not an edge');
        assert.equal(first.edgePending, true);
        const second = next(145);
        assert.equal(second.newEdgeTriggered, true, 'the second reading at the mark is');
        assert.equal(second.edgePending, false);
        assert.equal(second.pullbackStarted, false);
        assert.equal(second.isEdged, true);
        assert.equal(next(146).newEdgeTriggered, false, 'and it is counted once');
        const hovering = next(137);
        assert.equal(hovering.newEdgeTriggered, false);
        assert.equal(hovering.isEdged, true);
        const onceMore = next(141);
        assert.equal(onceMore.newEdgeTriggered, false, 'back on the mark inside the release band is the same edge');
        assert.equal(onceMore.pullbackStarted, false);
        const back = next(120);
        assert.equal(back.isEdged, false);
        const again = next(140);
        assert.equal(again.pullbackStarted, true);
        assert.equal(again.newEdgeTriggered, false);
        assert.equal(next(140).newEdgeTriggered, true, 'the next crossing that holds is the next edge');
    });

    it('clamps hold percent and maps it onto a trigger HR', () => {
        assert.equal(DEFAULT_EDGE_HOLD_PERCENT, 100);
        assert.equal(MIN_EDGE_HOLD_PERCENT, 90);
        // The typed Climax HR is a hard ceiling, so the pullback mark can
        // only ever sit AT it or below it.
        assert.equal(MAX_EDGE_HOLD_PERCENT, 100);
        assert.equal(clampEdgeHoldPercent(80), 90);
        assert.equal(clampEdgeHoldPercent(140), 100);
        assert.equal(clampEdgeHoldPercent(115), 100);
        assert.equal(clampEdgeHoldPercent('abc'), DEFAULT_EDGE_HOLD_PERCENT);
        assert.equal(resolveEdgeTriggerHr(140, 100), 140);
        assert.equal(resolveEdgeTriggerHr(140, 105), 140);
        assert.equal(resolveEdgeTriggerHr(140, 95), 133);
        assert.ok(Number.isNaN(resolveEdgeTriggerHr(NaN, 105)));
    });

    it('a stored hold percent above 100 pulls back AT the typed ceiling', () => {
        // Settings saved before the range was corrected (or a hand-edited
        // backup) may still carry 115: it must behave exactly like 100%.
        // The pullback is on the first reading at 140; the edge is counted
        // on the second, once the pulse has held there (this used to assert
        // a count on the first reading alone).
        const next = strap({ ...running, activeMode: 'classic', ceilingBehaviour: 'crawl', edgeHoldPercent: 115 });
        next(130);
        const atMax = next(140);
        assert.equal(atMax.isEdged, true, 'the typed max is the pullback mark');
        assert.equal(atMax.newEdgeTriggered, false);
        assert.equal(atMax.primaryPercent, CRAWL_PERCENT);
        const held = next(140);
        assert.equal(held.newEdgeTriggered, true, 'held at the typed max, the edge counts');
        assert.equal(held.primaryPercent, CRAWL_PERCENT);

        const released = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 134,
            isEdged: true,
            ceilingBehaviour: 'crawl',
            edgeHoldPercent: 115,
            sessionSeconds: 0
        });
        assert.equal(released.isEdged, false);
        assert.ok(released.primaryPercent > CRAWL_PERCENT);
    });

    it('keeps the pullback mark above the resting rate on a narrow typed band', () => {
        // Resting 70 / Climax 75 is a legal pair. 90% of 75 is 68, below the
        // resting rate: the session would latch edged on the first reading
        // with a release point (63) the wearer can never reach.
        assert.equal(resolveEdgeTriggerHr(75, 90, 70), 75);
        assert.equal(resolveEdgeTriggerHr(95, 90, 70), 86);
        // Without a resting rate the mark is simply the percentage.
        assert.equal(resolveEdgeTriggerHr(95, 90), 86);

        const atRest = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 70,
            minHr: 70,
            maxHr: 75,
            isEdged: false,
            ceilingBehaviour: 'crawl',
            edgeHoldPercent: 90
        });
        assert.equal(atRest.isEdged, false, 'a resting pulse must not be an edge');
        assert.ok(atRest.primaryPercent > CRAWL_PERCENT);
    });

    it('sweeps every legal limit pair and hold percent for the ceiling contract', () => {
        for (let minHr = 30; minHr <= 240; minHr += 1) {
            for (const span of [1, 2, 5, 15, 40, 120]) {
                const maxHr = minHr + span;
                if (maxHr > 250) continue;
                for (let pct = MIN_EDGE_HOLD_PERCENT; pct <= MAX_EDGE_HOLD_PERCENT; pct++) {
                    const trigger = resolveEdgeTriggerHr(maxHr, pct, minHr);
                    assert.ok(
                        trigger <= maxHr,
                        `trigger ${trigger} above the ceiling ${maxHr} at ${pct}%`
                    );
                    assert.ok(
                        trigger >= Math.min(maxHr, minHr + EDGE_RELEASE_BPM + 1),
                        `trigger ${trigger} too close to resting ${minHr} at ${pct}%`
                    );
                    assert.ok(trigger > minHr, `trigger ${trigger} at or under resting ${minHr}`);
                }
            }
        }
    });

    it('sweeps the hold percents for the crawl / Full Stop rule at the typed ceiling', () => {
        for (let pct = MIN_EDGE_HOLD_PERCENT; pct <= MAX_EDGE_HOLD_PERCENT; pct++) {
            for (const behaviour of ['crawl', 'stop']) {
                const atCeiling = calculateEngineOutputs({
                    ...running,
                    activeMode: 'classic',
                    hr: 140,
                    isEdged: false,
                    ceilingBehaviour: behaviour,
                    edgeHoldPercent: pct
                });
                assert.equal(atCeiling.isEdged, true, `not edged at the ceiling at ${pct}%`);
                assert.equal(
                    atCeiling.primaryPercent,
                    behaviour === 'crawl' ? CRAWL_PERCENT : 0,
                    `primary still driving at the ceiling at ${pct}%`
                );
            }
        }
    });

    it('100% hold still edges at the typed climax', () => {
        // Full Stop on the first reading at the mark, and the count on the
        // reading that holds it (it used to be asserted on the first).
        const next = strap({ ...running, activeMode: 'classic', ceilingBehaviour: 'stop', edgeHoldPercent: 100 });
        next(128);
        const hit = next(140);
        assert.equal(hit.primaryPercent, 0);
        assert.equal(hit.newEdgeTriggered, false);
        const held = next(140);
        assert.equal(held.newEdgeTriggered, true);
        assert.equal(held.primaryPercent, 0);
    });

    it('95% hold pulls back before the typed climax', () => {
        // The pullback at 133 is immediate; the edge is counted when the
        // pulse holds there for a second reading (it used to be asserted on
        // the first).
        const next = strap({ ...running, activeMode: 'classic', ceilingBehaviour: 'crawl', edgeHoldPercent: 95 });
        next(125);
        const early = next(133);
        assert.equal(early.primaryPercent, CRAWL_PERCENT);
        assert.equal(early.newEdgeTriggered, false);
        assert.equal(next(134).newEdgeTriggered, true);
        const below = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 132,
            isEdged: false,
            ceilingBehaviour: 'crawl',
            edgeHoldPercent: 95
        });
        assert.equal(below.isEdged, false);
    });

    it('does not count edges during orgasm mode or rampdown', () => {
        // The pulse has held at the mark on both readings, so a refusal here
        // is the rule and not a want of evidence: the same call with neither
        // counts at once.
        const held = { ...running, activeMode: 'classic', hr: 150, recentReadings: readingsOf(150, 150) };
        assert.equal(calculateEngineOutputs(held).newEdgeTriggered, true);
        const orgasm = calculateEngineOutputs({ ...held, orgasmMode: true });
        assert.equal(orgasm.newEdgeTriggered, false);
        assert.equal(orgasm.pullbackStarted, false);
        const ramp = calculateEngineOutputs({ ...held, sessionStatus: 'RAMPDOWN' });
        assert.equal(ramp.newEdgeTriggered, false);
        assert.equal(ramp.pullbackStarted, false);
        // Nor is a count still owed from before either of them began.
        const owed = { ...held, isEdged: true, edgePending: true };
        assert.equal(calculateEngineOutputs({ ...owed, orgasmMode: true }).newEdgeTriggered, false);
        assert.equal(calculateEngineOutputs({ ...owed, sessionStatus: 'RAMPDOWN' }).newEdgeTriggered, false);
    });

    it('rampdown scales linearly from 50% to 0% over 45 seconds', () => {
        const full = calculateEngineOutputs({ ...running, sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 45 });
        const half = calculateEngineOutputs({ ...running, sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 22.5 });
        const done = calculateEngineOutputs({ ...running, sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 0 });
        assert.equal(full.primaryPercent, 50);
        assert.equal(full.secondaryPercent, 50);
        assert.equal(half.primaryPercent, 25);
        assert.equal(done.primaryPercent, 0);
        assert.equal(done.secondaryPercent, 0);
        const negative = calculateEngineOutputs({ ...running, sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: -10 });
        assert.equal(negative.primaryPercent, 0);
    });

    it('intensity scales output between 0.5x and 1.5x and caps at 100', () => {
        const gentle = calculateEngineOutputs({ ...running, activeMode: 'classic', intensityValue: 0 });
        const balanced = calculateEngineOutputs({ ...running, activeMode: 'classic', intensityValue: 50 });
        const intense = calculateEngineOutputs({ ...running, activeMode: 'classic', intensityValue: 100 });
        assert.ok(gentle.primaryPercent < balanced.primaryPercent);
        assert.ok(intense.primaryPercent > balanced.primaryPercent);
        assert.equal(gentle.primaryPercent, Math.round(balanced.primaryPercent * 0.5));
        assert.ok(intense.primaryPercent <= 100);
        const cut = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 140, isEdged: true, intensityValue: 100 });
        assert.equal(cut.primaryPercent, 0, 'intensity must never revive a cut motor');
    });

    it('non-finite inputs yield zero output, never NaN', () => {
        const cases = [
            { hr: NaN },
            { hr: Infinity },
            { minHr: NaN },
            { maxHr: NaN },
            { maxHr: undefined },
            { hr: 'abc' }
        ];
        for (const patch of cases) {
            for (const mode of ENGINE_MODES) {
                const r = calculateEngineOutputs({ ...running, activeMode: mode, ...patch });
                assert.equal(r.primaryPercent, 0, `${mode} ${JSON.stringify(patch)} primary`);
                assert.equal(r.secondaryPercent, 0, `${mode} ${JSON.stringify(patch)} secondary`);
                assert.ok(Number.isFinite(r.strokeMinPercent) && Number.isFinite(r.strokeMaxPercent));
                assert.equal(r.newEdgeTriggered, false);
            }
        }
        const keepsEdge = calculateEngineOutputs({ ...running, hr: NaN, isEdged: true });
        assert.equal(keepsEdge.isEdged, true, 'bad data must not release an edge');
    });

    it('non-finite tuning values fall back instead of poisoning the output', () => {
        const r = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            gamma: NaN,
            intensityValue: NaN,
            edgeStrokeDepth: NaN,
            warmupMinutes: NaN,
            handyHwMin: NaN,
            handyHwMax: NaN
        });
        assert.ok(Number.isFinite(r.primaryPercent) && r.primaryPercent > 0);
        assert.ok(Number.isFinite(r.secondaryPercent));
        assert.ok(r.strokeMaxPercent > r.strokeMinPercent);
    });
});

describe('edge detection source', () => {
    it('judges the edge on edgeHr while the speed curve follows hr', () => {
        // The microphone boost moves `hr` (the engine's speed input) but never
        // `edgeHr` (the sensor's own pulse), so a loud room cannot latch an edge.
        // The readings are the sensor's too: they are what the count reads.
        const boosted = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            edgeHr: 120,
            isEdged: false,
            recentReadings: readingsOf(120, 120)
        });
        assert.equal(boosted.newEdgeTriggered, false, 'noise must not count an edge');
        assert.equal(boosted.isEdged, false);

        const unboosted = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 120,
            edgeHr: 120,
            isEdged: false
        });
        assert.ok(
            boosted.primaryPercent < unboosted.primaryPercent,
            'the boost must still move the speed curve'
        );

        // A measured pulse at the mark pulls back at once; held there on the
        // reading before as well, it is an edge (one reading used to be).
        const real = calculateEngineOutputs({
            ...running, activeMode: 'classic', hr: 140, edgeHr: 140, isEdged: false, recentReadings: readingsOf(140, 140)
        });
        assert.equal(real.newEdgeTriggered, true);
        assert.equal(real.isEdged, true);
    });

    it('releases an edge on the sensor pulse, not the boosted one', () => {
        const held = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 120,
            edgeHr: 138,
            isEdged: true
        });
        assert.equal(held.isEdged, true, 'a low speed input must not release the edge');

        const released = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            edgeHr: 120,
            isEdged: true
        });
        assert.equal(released.isEdged, false, 'the sensor pulse came down, so the edge releases');
    });

    it('falls back to hr when no edgeHr is given', () => {
        // Held at the mark on the reading before too, so the count is judged
        // on the fallback as well as the pullback (it used to be one reading).
        const held = readingsOf(140, 140);
        const r = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 140, isEdged: false, recentReadings: held });
        assert.equal(r.isEdged, true);
        assert.equal(r.newEdgeTriggered, true);
        const bad = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 140, edgeHr: NaN, isEdged: false, recentReadings: held });
        assert.equal(bad.isEdged, true);
        assert.equal(bad.newEdgeTriggered, true);
    });
});

describe('an edge is counted once the pulse has held at the mark', () => {
    // One reading at or above the pullback mark used to count an edge, and a
    // count is what Adaptive Ceiling Decay, the rotator, the edge cue and the
    // games act on: a wearer who sat up had his working ceiling lowered for
    // the rest of the session by one reading of a posture spike. The
    // pullback still starts on that first reading; the count waits.
    const motors = (out) => [out.primaryPercent, out.secondaryPercent, out.strokeMinPercent, out.strokeMaxPercent];

    it('does not delay the pullback: the first reading at the mark drives every motor as a counted edge does', () => {
        // Every mode, every sub-state reachable on the mark, both ceiling
        // rules: the reading that raises the flag with nothing held yet, and
        // the one that raises it already held, send exactly what an edge
        // counted long ago sends. The count moves no motor, so no motor
        // waits for it.
        const reachable = { oracle: ['APPROACH', 'HOLD', 'PURGATORY'], edgetrain: ['climb', 'hold', 'recover'] };
        let compared = 0;
        for (const activeMode of ENGINE_MODES) {
            const key = activeMode === 'oracle' ? 'oracleState' : 'trainingState';
            for (const sub of reachable[activeMode] || [undefined]) {
                for (const ceilingBehaviour of ['stop', 'crawl']) {
                    for (const hr of [140, 146]) {
                        for (const sessionSeconds of [3, 40]) {
                            const base = { ...running, activeMode, [key]: sub, ceilingBehaviour, hr, edgeHr: hr, sessionSeconds };
                            const where = `${activeMode}/${sub || '-'} ${ceilingBehaviour} ${hr} t=${sessionSeconds}`;
                            const first = calculateEngineOutputs({ ...base, isEdged: false, recentReadings: readingsOf(120, hr) });
                            const counted = calculateEngineOutputs({ ...base, isEdged: true, recentReadings: readingsOf(120, hr) });
                            const heldAtOnce = calculateEngineOutputs({ ...base, isEdged: false, recentReadings: readingsOf(hr, hr) });
                            assert.equal(first.isEdged, true, `${where}: no pullback on the first reading`);
                            assert.equal(first.pullbackStarted, true, where);
                            assert.equal(first.newEdgeTriggered, false, `${where}: one reading counted`);
                            assert.equal(heldAtOnce.newEdgeTriggered, true, `${where}: a held pulse was not counted`);
                            assert.deepEqual(motors(first), motors(counted), `${where}: the motors waited for the count`);
                            assert.deepEqual(motors(heldAtOnce), motors(counted), where);
                            compared += 1;
                        }
                    }
                }
            }
        }
        assert.ok(compared > 50, `expected a real sweep, compared ${compared}`);
    });

    it('a posture spike, a glitch or a pulse hovering across the mark pulls back and counts nothing', () => {
        const streams = {
            // Sitting up: about 10 BPM for about 10 s, one reading on the mark.
            'posture spike': [128, 130, 133, 136, 138, 140, 138, 135, 132, 130, 128],
            'one glitch, 37 BPM above both neighbours': [125, 125, 162, 125, 125],
            // The pulse touches the mark once and a glitch follows: the pair
            // 141/170 alone would read as held at 141.
            'a glitch right after one reading on the mark': [136, 138, 141, 170, 139, 135, 130],
            'hovering, never on the mark twice running': [138, 139, 141, 137, 139, 140, 136, 139, 141, 137]
        };
        for (const [name, stream] of Object.entries(streams)) {
            for (const ceilingBehaviour of ['stop', 'crawl']) {
                const next = strap({ ...running, activeMode: 'classic', ceilingBehaviour });
                let edges = 0;
                for (const bpm of stream) {
                    const out = next(bpm);
                    if (out.newEdgeTriggered) edges += 1;
                    if (bpm >= 140) {
                        assert.equal(out.isEdged, true, `${name}: no pullback at ${bpm}`);
                        assert.equal(out.primaryPercent, ceilingBehaviour === 'crawl' ? CRAWL_PERCENT : 0, `${name}: the primary kept going at ${bpm}`);
                    }
                }
                assert.equal(edges, 0, `${name} (${ceilingBehaviour}) counted an edge`);
            }
        }
    });

    it('a sustained climb is counted once, one reading after its pullback', () => {
        const next = strap({ ...running, activeMode: 'classic', ceilingBehaviour: 'crawl' });
        const climb = [120, 126, 131, 135, 138, 140, 142, 144, 145, 145, 146, 144];
        const outs = climb.map((bpm) => next(bpm));
        const pulledBack = outs.findIndex((out) => out.isEdged);
        assert.equal(climb[pulledBack], 140, 'the pullback is on the first reading at the mark');
        assert.equal(outs[pulledBack].primaryPercent, CRAWL_PERCENT);
        assert.deepEqual(outs.map((out) => out.pullbackStarted), climb.map((_, i) => i === pulledBack), 'and it starts once');
        const counted = outs.map((out, i) => (out.newEdgeTriggered ? i : -1)).filter((i) => i >= 0);
        assert.deepEqual(counted, [pulledBack + 1], 'the edge is counted once, on the next reading');
    });

    it('a strap sending one reading every 5 s is counted on its second reading at the mark', () => {
        const next = strap({ ...running, activeMode: 'classic' }, { gapMs: 5000 });
        const outs = [128, 134, 141, 143, 144].map((bpm) => next(bpm));
        assert.equal(outs[2].isEdged, true, 'the pullback does not wait for the next reading');
        assert.equal(outs[2].primaryPercent, 0);
        assert.equal(outs[2].newEdgeTriggered, false);
        assert.equal(outs[3].newEdgeTriggered, true, '5 s later is inside the 8 s signal-loss timeout');
        assert.equal(outs[4].newEdgeTriggered, false);
    });

    it('a reading gap is not a confirmation, and the signal-loss timeout it is given is the gap', () => {
        const owed = { ...running, activeMode: 'classic', hr: 142, edgeHr: 142, isEdged: true, edgePending: true };
        // The mark at 1 s, then nothing until 12 s: longer than the 8 s
        // timeout, so the watchdog called the pulse lost in between.
        const afterGap = [{ at: 0, bpm: 130 }, { at: 1000, bpm: 141 }, { at: 12000, bpm: 142 }];
        const first = calculateEngineOutputs({ ...owed, recentReadings: afterGap });
        assert.equal(first.newEdgeTriggered, false, 'the first reading after the gap confirms nothing');
        assert.equal(first.edgePending, true);
        assert.equal(first.isEdged, true, 'and the pullback holds meanwhile');
        const second = calculateEngineOutputs({ ...owed, recentReadings: [...afterGap, { at: 13000, bpm: 142 }] });
        assert.equal(second.newEdgeTriggered, true, 'the second one does');
        // A wearer with a slow relay raised the timeout; the same 11 s gap is
        // then an ordinary interval.
        assert.equal(calculateEngineOutputs({ ...owed, recentReadings: afterGap, readingGapMs: 12000 }).newEdgeTriggered, true);
        assert.equal(calculateEngineOutputs({ ...owed, recentReadings: afterGap, readingGapMs: 8000 }).newEdgeTriggered, false);
    });

    it('a count still owed waits through a pause and is paid once; nothing is owed off the edge', () => {
        const owed = { ...running, activeMode: 'classic', hr: 141, edgeHr: 141, isEdged: true, edgePending: true, recentReadings: readingsOf(141, 142, 141) };
        for (const sessionStatus of ['PAUSED', 'IDLE']) {
            const paused = calculateEngineOutputs({ ...owed, sessionStatus });
            assert.equal(paused.newEdgeTriggered, false);
            assert.equal(paused.isEdged, true);
            assert.equal(paused.edgePending, true, `${sessionStatus} must not drop the count owed`);
        }
        const bad = calculateEngineOutputs({ ...owed, hr: NaN, edgeHr: NaN });
        assert.equal(bad.edgePending, true, 'nor may bad data');
        assert.equal(bad.newEdgeTriggered, false);
        const resumed = calculateEngineOutputs(owed);
        assert.equal(resumed.newEdgeTriggered, true, 'held after the pause, it is counted');
        assert.equal(resumed.edgePending, false);
        assert.equal(resumed.pullbackStarted, false, 'the pullback began before the pause');
        const after = calculateEngineOutputs({ ...owed, isEdged: resumed.isEdged, edgePending: resumed.edgePending });
        assert.equal(after.newEdgeTriggered, false, 'once');
        // A count "owed" with no edge in progress is nothing at all.
        const stray = calculateEngineOutputs({ ...owed, hr: 120, edgeHr: 120, isEdged: false, recentReadings: readingsOf(120, 120) });
        assert.equal(stray.edgePending, false);
        assert.equal(stray.newEdgeTriggered, false);
        assert.equal(calculateEngineOutputs({ ...owed, isEdged: false, sessionStatus: 'PAUSED' }).edgePending, false);
    });

    it('Force Orgasm freezes a count still owed, and a cancel judges it against the real mark', () => {
        const owed = { ...running, activeMode: 'classic', isEdged: true, edgePending: true };
        const forcing = calculateEngineOutputs({ ...owed, hr: 150, edgeHr: 150, orgasmMode: true, maxHr: 160, recentReadings: readingsOf(150, 150) });
        assert.equal(forcing.newEdgeTriggered, false, 'no edge is counted during a forced orgasm');
        assert.equal(forcing.isEdged, true);
        assert.equal(forcing.edgePending, true);
        const heldAfter = calculateEngineOutputs({ ...owed, hr: 150, edgeHr: 150, recentReadings: readingsOf(150, 150) });
        assert.equal(heldAfter.newEdgeTriggered, true, 'still held at the real mark after the cancel: counted, once');
        const cameDown = calculateEngineOutputs({ ...owed, hr: 120, edgeHr: 120, recentReadings: readingsOf(125, 120) });
        assert.equal(cameDown.isEdged, false, 'come down meanwhile: released');
        assert.equal(cameDown.edgePending, false);
        assert.equal(cameDown.newEdgeTriggered, false, 'and never counted');
    });

    it('a Soft Landing counts no edge, not even one whose pullback began before it', () => {
        const owed = { ...running, activeMode: 'classic', hr: 145, edgeHr: 145, isEdged: true, edgePending: true, recentReadings: readingsOf(145, 145) };
        const landing = calculateEngineOutputs({ ...owed, sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 30 });
        assert.equal(landing.newEdgeTriggered, false);
        assert.equal(landing.isEdged, true);
        assert.equal(landing.edgePending, true);
        assert.equal(landing.primaryPercent, calculateEngineOutputs({ ...owed, isEdged: true, edgePending: false, sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 30 }).primaryPercent);
    });

    it('judges the readings against its own pullback mark', () => {
        const base = { ...running, activeMode: 'classic', hr: 134, edgeHr: 134, recentReadings: readingsOf(133, 134) };
        assert.equal(calculateEngineOutputs({ ...base, edgeHoldPercent: 95 }).newEdgeTriggered, true, '95% of 140 is 133');
        assert.equal(calculateEngineOutputs({ ...base, edgeHoldPercent: 100 }).newEdgeTriggered, false, 'under a 140 mark nothing is held');
        assert.equal(calculateEngineOutputs({ ...base, edgeHoldPercent: 95, recentReadings: readingsOf(132, 134) }).newEdgeTriggered, false, 'the reading before was under it');
        // The mark follows the working ceiling the engine is handed.
        assert.equal(calculateEngineOutputs({ ...base, edgeHoldPercent: 100, maxHr: 134 }).newEdgeTriggered, false, 'the reading before sits under a 134 mark');
        assert.equal(calculateEngineOutputs({ ...base, edgeHoldPercent: 100, maxHr: 133 }).newEdgeTriggered, true);
    });

    it('counts only while the measured pulse it is judging is on the mark', () => {
        // app.js remembers each reading before it runs the engine, so the
        // readings always end at the sensor pulse. Should they ever not, an
        // old pair at the mark must not count an edge under a pulse that has
        // come back down into the release band, and a microphone boost must
        // not stand in for the sensor either.
        const owed = { ...running, activeMode: 'classic', isEdged: true, edgePending: true, recentReadings: readingsOf(141, 142) };
        const inBand = calculateEngineOutputs({ ...owed, hr: 136, edgeHr: 136 });
        assert.equal(inBand.isEdged, true);
        assert.equal(inBand.newEdgeTriggered, false);
        assert.equal(inBand.edgePending, true, 'still owed while the flag is up');
        const boosted = calculateEngineOutputs({ ...owed, hr: 140, edgeHr: 136 });
        assert.equal(boosted.newEdgeTriggered, false, 'a boosted pulse on the mark is not the sensor on it');
        assert.equal(calculateEngineOutputs({ ...owed, hr: 142, edgeHr: 142 }).newEdgeTriggered, true);
    });

    it('owes a count only while the flag is up, and counts nothing without readings', () => {
        const next = strap({ ...running, activeMode: 'classic' });
        next(125);
        assert.equal(next(150).edgePending, true, 'a glitch raises the flag, and owes a count');
        const released = next(125);
        assert.equal(released.isEdged, false);
        assert.equal(released.edgePending, false, 'the release takes the count owed with it');
        let seen = 0;
        for (const sessionStatus of ['RUNNING', 'RAMPDOWN', 'PAUSED', 'IDLE']) {
            for (const orgasmMode of [false, true]) {
                for (const isEdged of [false, true]) {
                    for (const hr of [NaN, 100, 128, 136, 140, 150]) {
                        const out = calculateEngineOutputs({
                            ...running, activeMode: 'classic', sessionStatus, orgasmMode, isEdged, edgePending: true,
                            hr, edgeHr: hr, recentReadings: readingsOf(145, 145)
                        });
                        const where = `${sessionStatus} orgasm=${orgasmMode} edged=${isEdged} hr=${hr}`;
                        assert.ok(!(out.edgePending && !out.isEdged), `${where}: a count owed off the edge`);
                        assert.ok(!(out.newEdgeTriggered && out.edgePending), `${where}: counted and still owed`);
                        seen += 1;
                    }
                }
            }
        }
        assert.ok(seen > 50);
        // A caller that hands over no readings has handed over no evidence.
        for (const recentReadings of [undefined, [], null, 'junk', readingsOf(150)]) {
            const out = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 150, edgeHr: 150, recentReadings });
            assert.equal(out.isEdged, true, 'the pullback never waits for evidence');
            assert.equal(out.newEdgeTriggered, false, `readings ${JSON.stringify(recentReadings)} counted an edge`);
        }
    });
});

describe('game-side edge release', () => {
    it('is judged against the pullback mark, not the ceiling', () => {
        // Climax 140, pullback 90% -> mark 126, release 121. A game that asks
        // "has the pulse come back down?" without the mark gets 135 instead,
        // clears the edge flag while the engine still sees the pulse at or
        // above the mark, and the next engine tick counts an invented edge.
        const trigger = resolveEdgeTriggerHr(140, 90, 70);
        assert.equal(trigger, 126);
        assert.equal(hasReleasedEdge(130, 140, trigger), false, 'still on the mark');
        assert.equal(hasReleasedEdge(130, 140), true, 'what the 2-argument call wrongly answers');
        assert.equal(hasReleasedEdge(120, 140, trigger), true);

        // The pulse has sat at 130 all along, so the readings hold it there:
        // a flag cleared under it is raised again and counted at once.
        const phantom = calculateEngineOutputs({
            ...running,
            activeMode: 'oracle',
            oracleState: 'PURGATORY',
            hr: 130,
            isEdged: false,
            edgeHoldPercent: 90,
            recentReadings: readingsOf(130, 130)
        });
        assert.equal(phantom.newEdgeTriggered, true, 'clearing the flag at 130 costs one phantom edge');
    });

    it('gameEdgeReleased refuses to answer without a pullback mark', () => {
        // The property, not the shape of the call. `hasReleasedEdge` falls
        // back to maxHr - 5 when it is handed no mark, and with any pullback
        // below 100% that band sits ABOVE the mark: the game clears the edge
        // flag while the engine still reads the pulse as edged, and the next
        // tick counts an invented edge that Adaptive Ceiling Decay acts on.
        const trigger = resolveEdgeTriggerHr(140, 90, 70);
        assert.equal(trigger, 126);
        assert.equal(gameEdgeReleased(130, 140, trigger), false, 'still on the mark');
        assert.equal(gameEdgeReleased(120, 140, trigger), true);

        // state.edgeTriggerHr starts as null (state.js) and is only written by
        // the engine loop. A caller that reaches this before the first tick,
        // or after a reordering, must get "not released" - never the silent
        // maxHr - 5 fallback that hasReleasedEdge would use.
        for (const noMark of [null, undefined, NaN, 'abc']) {
            assert.equal(gameEdgeReleased(130, 140, noMark), false, `no mark (${String(noMark)}) is not a release`);
            assert.equal(gameEdgeReleased(70, 140, noMark), false, 'not even far below the ceiling');
        }
        assert.equal(hasReleasedEdge(130, 140, undefined), true, 'what the unguarded call wrongly answers');
    });

    it('gameEdgeReleased says "no" for as long as Force Orgasm is on', () => {
        // The overdrive lifts the working ceiling 1 BPM per second and the
        // release band rides up with it, so a pulse parked ON the mark reads
        // as released against a ceiling that only moved because the wearer
        // armed the button. calculateEngineOutputs freezes the edge flag for
        // that reason; the games ask their own release question once a second
        // and have to get the same answer, or the Oracle's purgatory reset
        // counts an edge - and walks Adaptive Ceiling Decay - on a pulse that
        // never left the mark.
        const typed = 140;
        const mark = resolveEdgeTriggerHr(typed, 100, 70);
        assert.equal(mark, typed);
        const onTheMark = 140;
        assert.equal(gameEdgeReleased(onTheMark, typed, mark), false, 'on the mark, no overdrive');
        // Six seconds of Force Orgasm: the ceiling (and the mark with it) is
        // six BPM higher, which puts the unchanged pulse below the band.
        const boosted = typed + 6;
        const boostedMark = resolveEdgeTriggerHr(boosted, 100, 70);
        assert.equal(
            gameEdgeReleased(onTheMark, boosted, boostedMark),
            true,
            'what the inflated ceiling wrongly answers'
        );
        assert.equal(
            gameEdgeReleased(onTheMark, boosted, boostedMark, { orgasmMode: true }),
            false,
            'Force Orgasm freezes the answer, exactly as the engine freezes the flag'
        );
        // A genuine release is still a release the moment the button is off.
        assert.equal(gameEdgeReleased(120, typed, mark, { orgasmMode: false }), true);
        assert.equal(gameEdgeReleased(120, typed, mark, { orgasmMode: true }), false);
    });

    it('app.js hands both game release checks the Force Orgasm flag', () => {
        // The Oracle's purgatory reset and Edge Training's recover both ask
        // it once a second while the wearer may be holding Force Orgasm.
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const sites = /gameEdgeReleased\(([^)]*)\)/g;
        let seen = 0;
        let match;
        while ((match = sites.exec(src)) !== null) {
            seen += 1;
            assert.ok(
                /orgasmMode/.test(match[1]),
                `the release check must be told about Force Orgasm: ${match[0]}`
            );
        }
        assert.ok(seen >= 2, 'expected the Oracle and Edge Training call sites');
    });

    it('app.js asks the release question only through gameEdgeReleased', () => {
        // The Oracle and Edge Training both ask it once a second. A call site
        // that reaches hasReleasedEdge directly can be handed a null mark, so
        // there must be no such call site at all.
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const guarded = src.match(/gameEdgeReleased\(/g) || [];
        assert.ok(guarded.length >= 2, 'expected the Oracle and Edge Training call sites');
        const raw = src.match(/(?<![A-Za-z0-9_])hasReleasedEdge\(/g) || [];
        assert.equal(raw.length, 0, 'app.js must not call hasReleasedEdge directly');
        const sites = /gameEdgeReleased\(([^)]*)\)/g;
        let seen = 0;
        let match;
        while ((match = sites.exec(src)) !== null) {
            seen += 1;
            assert.ok(
                /edgeTriggerHr/.test(match[1]),
                `the release check must be given the pullback mark: ${match[0]}`
            );
        }
        assert.equal(seen, guarded.length, 'every call site must have been inspected');
    });
});

describe('the microphone boost can never raise either channel', () => {
    // The promise the panel, the README and the engine comment all make to
    // the wearer: a louder room may only ever ease the toys off. It held for
    // every FALLING primary, but the milking modes cross-fade a RISING
    // secondary against that primary, and that term was reading the boosted
    // pulse: with the pulse pinned at 100 BPM an injected boost took the
    // secondary from 26-30 to 52-60, so a partner talking next to the wearer
    // sped up an internal toy. Sweep every mode, every game sub-state and
    // both ceiling rules, and assert it of BOTH channels.
    const modeStates = {
        oracle: { key: 'oracleState', values: ['APPROACH', 'HOLD', 'PURGATORY', 'CLIMAX', 'DENIAL'] },
        edgetrain: { key: 'trainingState', values: ['climb', 'hold', 'recover', 'finish'] }
    };

    const sweep = (visit) => {
        for (const mode of ENGINE_MODES) {
            const sub = modeStates[mode] || { key: 'unusedState', values: [null] };
            for (const subState of sub.values) {
                for (const ceilingBehaviour of ['stop', 'crawl']) {
                    // Off the edge, on an edge already counted, and on one
                    // whose count is still owed.
                    for (const edge of [{ isEdged: false }, { isEdged: true }, { isEdged: true, edgePending: true }]) {
                        for (const orgasmMode of [false, true]) {
                            for (const sessionStatus of ['RUNNING', 'RAMPDOWN']) {
                                for (const edgeHoldPercent of [90, 100]) {
                                    for (const extras of [
                                        {},
                                        { warmupMinutes: 5, sessionSeconds: 60 },
                                        { cadenceBreathing: true, milkingWave: true, sessionSeconds: 7 },
                                        { stallGuardEngaged: true },
                                        { intensityValue: 100 },
                                        { edgeStrokeDepth: 40, ruinHoldSeconds: 3 }
                                    ]) {
                                        visit({
                                            ...running,
                                            activeMode: mode,
                                            [sub.key]: subState,
                                            ceilingBehaviour,
                                            ...edge,
                                            orgasmMode,
                                            sessionStatus,
                                            edgeHoldPercent,
                                            ...extras
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    };

    it('sweeps the engine\'s real sub-states, not names it made up', () => {
        // The table above writes the state names out by hand, so a rename in
        // engine.js would quietly send every sweep down the default branch
        // and narrow this whole file's coverage without failing anything.
        // Anchor it in behaviour: a state with its own branch must NOT look
        // like an unknown one, and the two that ARE the default branch
        // (Oracle APPROACH, Edge Training climb) must look exactly like it.
        // CLIMAX and 'finish' are deliberately the SAME branch as the climb:
        // both are only ever entered with Force Orgasm on (handled before the
        // switch), so the only way into them here is a cancel, and a cancel
        // settles on the state app.js is about to move the game to.
        const defaultBranch = { oracle: ['APPROACH', 'CLIMAX'], edgetrain: ['climb', 'finish'] };
        for (const [mode, sub] of Object.entries(modeStates)) {
            const shape = (value) => {
                const out = calculateEngineOutputs({
                    ...running,
                    activeMode: mode,
                    [sub.key]: value,
                    hr: 118,
                    edgeHr: 118
                });
                return [
                    out.primaryPercent, out.secondaryPercent,
                    out.strokeMinPercent, out.strokeMaxPercent
                ].join('/');
            };
            const unknown = shape('__no_such_state__');
            for (const value of sub.values) {
                if (defaultBranch[mode].includes(value)) {
                    assert.equal(shape(value), unknown, `${mode}/${value} is meant to BE the default branch`);
                } else {
                    assert.notEqual(
                        shape(value),
                        unknown,
                        `${mode}/${value} no longer has its own branch in engine.js - if it was renamed,`
                            + ' rename it here too, or this sweep silently stops covering it'
                    );
                }
            }
        }
    });

    it('holds for every mode, every sub-state and every measured pulse', () => {
        let checked = 0;
        sweep((base) => {
            for (const sensorHr of [70, 85, 100, 118, 126, 135, 140]) {
                // The boost is clamped to the working ceiling in app.js, so
                // the loop never sees more than that.
                for (const boost of [1, 5, 8, 20]) {
                    // The measured pulse held on the reading before as well,
                    // so the count is live wherever the rule allows one.
                    const recentReadings = readingsOf(sensorHr, sensorHr);
                    const quiet = calculateEngineOutputs({ ...base, hr: sensorHr, edgeHr: sensorHr, recentReadings });
                    const loud = calculateEngineOutputs({
                        ...base,
                        hr: Math.min(base.maxHr, sensorHr + boost),
                        edgeHr: sensorHr,
                        recentReadings
                    });
                    const where = `${base.activeMode}/${base.oracleState || base.trainingState || '-'}`
                        + ` ${base.sessionStatus} ${base.ceilingBehaviour}`
                        + ` edged=${base.isEdged}${base.edgePending ? ' (count owed)' : ''} orgasm=${base.orgasmMode}`
                        + ` hr=${sensorHr} +${boost}`;
                    assert.ok(
                        loud.primaryPercent <= quiet.primaryPercent,
                        `${where}: boost raised the primary ${quiet.primaryPercent} -> ${loud.primaryPercent}`
                    );
                    assert.ok(
                        loud.secondaryPercent <= quiet.secondaryPercent,
                        `${where}: boost raised the secondary ${quiet.secondaryPercent} -> ${loud.secondaryPercent}`
                    );
                    // A boost must not invent an edge or release one either.
                    assert.equal(loud.isEdged, quiet.isEdged, `${where}: boost moved the edge flag`);
                    assert.equal(loud.newEdgeTriggered, quiet.newEdgeTriggered, `${where}: boost counted an edge`);
                    assert.equal(loud.edgePending, quiet.edgePending, `${where}: boost settled a count still owed`);
                    assert.equal(loud.pullbackStarted, quiet.pullbackStarted, `${where}: boost started a pullback`);
                    checked += 1;
                }
            }
        });
        assert.ok(checked > 2000, `expected a real sweep, ran ${checked} comparisons`);
    });

    it('still eases the milking secondary off, and only off', () => {
        // The measured regression, pinned: pulse 100, Prostate Milker.
        const base = { ...running, activeMode: 'milker', hr: 100, edgeHr: 100, isEdged: false };
        const quiet = calculateEngineOutputs(base);
        const loud = calculateEngineOutputs({ ...base, hr: 120 });
        assert.equal(loud.secondaryPercent, quiet.secondaryPercent, 'the rising secondary reads the sensor alone');
        assert.ok(loud.primaryPercent < quiet.primaryPercent, 'the falling primary still hears the room');
        // The depth contraction keeps reading the boosted pulse: less travel.
        const deep = { ...base, edgeStrokeDepth: 40 };
        const deepQuiet = calculateEngineOutputs(deep);
        const deepLoud = calculateEngineOutputs({ ...deep, hr: 120 });
        assert.ok(deepLoud.strokeMaxPercent < deepQuiet.strokeMaxPercent, 'the boost still shortens the stroke');
    });

    it('a rising secondary on the measured pulse is not frozen', () => {
        // Easing off must not mean "deaf": the cross-fade still follows the
        // wearer's own pulse all the way up.
        const low = calculateEngineOutputs({ ...running, activeMode: 'milker', hr: 80, edgeHr: 80 });
        const high = calculateEngineOutputs({ ...running, activeMode: 'milker', hr: 130, edgeHr: 130 });
        assert.ok(high.secondaryPercent > low.secondaryPercent);
    });
});

describe('the Guards pullback preview', () => {
    it('quotes the percentage only while the percentage is what produced the mark', () => {
        assert.equal(
            describeEdgeHoldPreview({ typedMaxHr: 140, workingMaxHr: 140, minHr: 70, holdPercent: 100 }),
            'Pullback at 140 BPM (100% of 140)'
        );
        assert.equal(
            describeEdgeHoldPreview({ typedMaxHr: 140, workingMaxHr: 125, minHr: 70, holdPercent: 95 }),
            'Pullback at 119 BPM (95% of 125, the working ceiling right now)'
        );
    });

    it('says what really happened when the resting-rate floor lifts the mark', () => {
        // A low prostate ceiling of the kind the README sends you to
        // (Climax 92-95) with a resting rate close under it: Resting 88,
        // Climax 95, Pullback 90%. The mark is lifted to 94 to leave the
        // 5 BPM release band, and 90% of 95 is 86 - the old line printed
        // both numbers side by side and one of them was fiction.
        const text = describeEdgeHoldPreview({ typedMaxHr: 95, workingMaxHr: 95, minHr: 88, holdPercent: 90 });
        assert.equal(text, 'Pullback at 94 BPM - 90% of 95 is 86, lifted to clear your Resting HR (88)');
        assert.equal(resolveEdgeTriggerHr(95, 90, 88), 94);
    });

    it('never prints a percentage that does not produce the BPM beside it', () => {
        // The property, over every pair the inputs allow: if the line reads
        // "N BPM (P% of M)" then P% of M must really be N.
        let lifted = 0;
        for (let minHr = 40; minHr <= 120; minHr += 4) {
            for (let maxHr = minHr + 1; maxHr <= 200; maxHr += 3) {
                for (let pct = MIN_EDGE_HOLD_PERCENT; pct <= MAX_EDGE_HOLD_PERCENT; pct += 1) {
                    const text = describeEdgeHoldPreview({
                        typedMaxHr: maxHr, workingMaxHr: maxHr, minHr, holdPercent: pct
                    });
                    const trigger = resolveEdgeTriggerHr(maxHr, pct, minHr);
                    assert.ok(text.startsWith(`Pullback at ${trigger} BPM`), text);
                    const quoted = text.match(/\((\d+)% of (\d+)\)$/);
                    if (quoted) {
                        assert.equal(
                            Math.min(maxHr, Math.max(1, Math.round(Number(quoted[2]) * (Number(quoted[1]) / 100)))),
                            trigger,
                            `the quoted percentage must produce the mark: ${text}`
                        );
                    } else {
                        lifted += 1;
                        assert.ok(/lifted to clear your Resting HR/.test(text), text);
                        assert.ok(text.includes(`${pct}% of ${maxHr} is `), text);
                    }
                }
            }
        }
        assert.ok(lifted > 0, 'the sweep must have covered the lifted case');
    });

    it('does not fall over without usable limits', () => {
        const text = describeEdgeHoldPreview({ typedMaxHr: NaN, workingMaxHr: NaN, minHr: NaN, holdPercent: 95 });
        assert.equal(typeof text, 'string');
        assert.ok(text.length > 0);
    });
});

describe('Survival Mode and Ruin & Leak are the documented exceptions to the ceiling rule', () => {
    it('keeps climbing whatever the At-the-ceiling setting says', () => {
        // Deliberate: the toys keep the speed floor on the mark, which is
        // why the Guards text and the README name Survival as one of the
        // two modes Full Stop / Crawl does not govern. The run does not end
        // there. Each edge raises the mark instead.
        for (const ceilingBehaviour of ['stop', 'crawl']) {
            const onTheMark = calculateEngineOutputs({
                ...running,
                activeMode: 'survival',
                survivalSpeedFloor: 61,
                hr: 140,
                isEdged: true,
                ceilingBehaviour
            });
            assert.equal(onTheMark.primaryPercent, 61, `survival ignores ${ceilingBehaviour} by design`);
        }
    });

    it('Ruin & Leak rides through the edge, then the lockout is a dead stop', () => {
        // The ride ignores Crawl and Full Stop. The lockout is a dead stop
        // on the primary either way, with the secondary dropped low.
        for (const ceilingBehaviour of ['stop', 'crawl']) {
            const ride = calculateEngineOutputs({
                ...running, activeMode: 'ruin', hr: 140, edgeHr: 140, isEdged: true,
                ruinHoldSeconds: 0, sessionSeconds: 0, ceilingBehaviour
            });
            assert.ok(ride.primaryPercent > 0, `ruin keeps stroking on ${ceilingBehaviour}`);
            const lockout = calculateEngineOutputs({
                ...running, activeMode: 'ruin', hr: 100, edgeHr: 100, isEdged: false,
                ruinHoldSeconds: 12, ceilingBehaviour
            });
            assert.equal(lockout.primaryPercent, 0, `ruin's lockout ignores ${ceilingBehaviour} by design`);
            assert.equal(lockout.secondaryPercent, 18);
        }
    });

    it('Ruin & Leak holds the stop after the lockout for as long as the pulse stays on the mark', () => {
        // `ruinSpent`: this edge has had its ride. The lockout is over, the
        // pulse is still on the mark, and the primary stays at 0% with the
        // secondary at the lockout level - whichever ceiling rule is set.
        // 1.1.0 had no such state and simply started the ride again.
        for (const ceilingBehaviour of ['stop', 'crawl']) {
            for (let sessionSeconds = 0; sessionSeconds < 60; sessionSeconds += 1) {
                const held = calculateEngineOutputs({
                    ...running, activeMode: 'ruin', hr: 145, edgeHr: 145, isEdged: true,
                    ruinHoldSeconds: 0, ruinSpent: true, sessionSeconds, ceilingBehaviour
                });
                assert.equal(held.primaryPercent, 0, `${ceilingBehaviour} t=${sessionSeconds}`);
                assert.equal(held.secondaryPercent, 18);
                assert.equal(held.isEdged, true);
            }
        }
        // It holds until the edge RELEASES, on the engine's own release band:
        // a pulse still inside the band is still on the edge...
        const inBand = calculateEngineOutputs({
            ...running, activeMode: 'ruin', hr: 140 - EDGE_RELEASE_BPM, edgeHr: 140 - EDGE_RELEASE_BPM, isEdged: true, ruinSpent: true
        });
        assert.equal(inBand.isEdged, true);
        assert.equal(inBand.primaryPercent, 0);
        // ...and the moment it drops out of it Ruin teases again, on that
        // same call, not a second later.
        const released = calculateEngineOutputs({
            ...running, activeMode: 'ruin', hr: 140 - EDGE_RELEASE_BPM - 1, edgeHr: 140 - EDGE_RELEASE_BPM - 1, isEdged: true, ruinSpent: true
        });
        assert.equal(released.isEdged, false);
        assert.ok(released.primaryPercent > 0);
        // Force Orgasm still overrides it. Since 1.1.1 that is a ramp over
        // 28 s from what the toy was doing, so over a spent edge it starts
        // from the dead stop the toy is in - exactly the ramp it runs over the
        // lockout - never from a fresh ride on its first tick. The working
        // ceiling climbs 1 BPM a second under it, as app.js raises it.
        const forced = (orgasmBoost, clock) => calculateEngineOutputs({
            ...running, activeMode: 'ruin', hr: 145, edgeHr: 145, isEdged: true, orgasmMode: true,
            orgasmBoost, maxHr: 140 + orgasmBoost, sessionSeconds: 400 + orgasmBoost, ...clock
        });
        const spentEdge = { ruinHoldSeconds: 0, ruinSpent: true };
        const lockout = { ruinHoldSeconds: 10, ruinSpent: true };
        assert.equal(forced(0, spentEdge).primaryPercent, 0);
        for (let orgasmBoost = 0; orgasmBoost <= 30; orgasmBoost += 1) {
            assert.deepEqual(forced(orgasmBoost, spentEdge), forced(orgasmBoost, lockout), `Force Orgasm at ${orgasmBoost} s`);
        }
        assert.ok(forced(1, spentEdge).primaryPercent > 0);
        assert.ok(forced(28, spentEdge).primaryPercent >= 70);
        // And so do the stall guard and a stopped session, during a ride.
        const ride = { ...running, activeMode: 'ruin', hr: 145, edgeHr: 145, isEdged: true, ruinSpent: false, sessionSeconds: 3 };
        assert.ok(calculateEngineOutputs(ride).primaryPercent > 0);
        assert.equal(calculateEngineOutputs({ ...ride, stallGuardEngaged: true }).primaryPercent, 0);
        for (const sessionStatus of ['IDLE', 'PAUSED']) {
            assert.equal(calculateEngineOutputs({ ...ride, sessionStatus }).primaryPercent, 0, sessionStatus);
        }
    });

    it('a game borrows Ruin & Leak\'s stroke, never its lockout', () => {
        // The Ruin clock now survives a game being switched on (a game toggle
        // used to zero it and hand out a fresh ride). The game must still
        // run exactly as it did: Ruin's ending belongs to Ruin as the active
        // mode, not to the stroke a game borrows from it.
        const subStates = {
            oracle: { key: 'oracleState', values: ['APPROACH', 'HOLD', 'PURGATORY', 'DENIAL'] },
            survival: { key: 'unused', values: [null] },
            edgetrain: { key: 'trainingState', values: ['climb', 'hold', 'recover'] }
        };
        let compared = 0;
        for (const [activeMode, sub] of Object.entries(subStates)) {
            for (const value of sub.values) {
                for (const hr of [100, 130, 145]) {
                    for (let sessionSeconds = 0; sessionSeconds < 20; sessionSeconds += 1) {
                        const game = {
                            ...running, activeMode, strokeMode: 'ruin', [sub.key]: value,
                            hr, edgeHr: hr, isEdged: hr >= 140, sessionSeconds, handyHwMin: 10, handyHwMax: 90
                        };
                        const fresh = calculateEngineOutputs({ ...game, ruinHoldSeconds: 0, ruinSpent: false });
                        for (const clock of [{ ruinHoldSeconds: 11 }, { ruinSpent: true }, { ruinHoldSeconds: 3, ruinSpent: true }]) {
                            assert.deepEqual(
                                calculateEngineOutputs({ ...game, ...clock }),
                                fresh,
                                `${activeMode}/${value} at ${hr} t=${sessionSeconds} with ${JSON.stringify(clock)}`
                            );
                            compared += 1;
                        }
                    }
                }
            }
        }
        assert.ok(compared > 0);
    });

    it('the Guards text, both mode cards and the README name BOTH exceptions', () => {
        const read = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
        const guards = read('index.html');
        const readme = read('README.md');
        const claims = [
            ['index.html Guards text', guards.match(/Crawl<\/strong> keeps a 10% micro-motion[\s\S]*?<\/p>/)],
            ['README Guards bullet', readme.match(/\*Crawl\* keeps a 10% micro-motion[^\n]*/)]
        ];
        for (const [where, match] of claims) {
            assert.ok(match, `${where}: anchor missing, the guard would be vacuous`);
            assert.ok(
                /Survival Mode/.test(match[0]),
                `${where} claims the ceiling rule applies everywhere without naming Survival: ${match[0]}`
            );
            assert.ok(
                /Ruin &(amp;)? Leak/.test(match[0]),
                `${where} must name Ruin & Leak too - its lockout ignores the setting: ${match[0]}`
            );
            assert.ok(
                !/The exception is/.test(match[0]),
                `${where} still calls one mode THE exception: ${match[0]}`
            );
        }
        const app = read('src/js/app.js');
        const survivalDetail = app.match(/survival: '([^']*)'/);
        const ruinDetail = app.match(/ruin: '([^']*)'/);
        assert.ok(survivalDetail, 'Survival detail anchor missing');
        assert.ok(ruinDetail, 'Ruin & Leak detail anchor missing');
        assert.ok(
            /At the ceiling/.test(survivalDetail[1]),
            `the Survival detail must say the rule does not govern it: ${survivalDetail[1]}`
        );
        assert.ok(
            /At the ceiling/.test(ruinDetail[1]),
            `the Ruin & Leak detail must say the rule does not govern it either: ${ruinDetail[1]}`
        );
    });
});

describe('the MIC badge only promises a push that reaches a motor', () => {
    it('names the modes the boosted pulse can reach', () => {
        for (const mode of ['classic', 'milker', 'shortener', 'headplay', 'ultimate', 'ruin']) {
            assert.equal(micBoostReachesMotors(mode), true, `${mode} teases down on the boosted pulse`);
        }
        assert.equal(micBoostReachesMotors('oracle'), false);
        assert.equal(micBoostReachesMotors('edgetrain'), false);
        // Survival's speeds run off its own clock; the boost can only shorten
        // the stroke zone, and at full depth there is no contraction at all.
        assert.equal(micBoostReachesMotors('survival', { edgeStrokeDepth: 100 }), false);
        assert.equal(micBoostReachesMotors('survival', { edgeStrokeDepth: 40 }), true);
        assert.equal(micBoostReachesMotors('not-a-mode'), true, 'unknown modes are classic');
    });

    it('a mode it calls blind really does ignore the boost, in every sub-state', () => {
        // The cockpit badge is only honest if this list is the list the
        // engine computes from, so take the answer from the engine itself:
        // where the helper says nothing is reached, the outputs must be
        // identical with and without a boost.
        const probes = [
            { activeMode: 'oracle', oracleState: 'APPROACH' },
            { activeMode: 'oracle', oracleState: 'HOLD' },
            { activeMode: 'oracle', oracleState: 'PURGATORY' },
            { activeMode: 'oracle', oracleState: 'DENIAL' },
            { activeMode: 'edgetrain', trainingState: 'climb' },
            { activeMode: 'edgetrain', trainingState: 'hold' },
            { activeMode: 'edgetrain', trainingState: 'recover' },
            { activeMode: 'survival' }
        ];
        let checked = 0;
        for (const probe of probes) {
            assert.equal(
                micBoostReachesMotors(probe.activeMode, { edgeStrokeDepth: 100 }),
                false,
                `${probe.activeMode} is meant to be one of the blind modes`
            );
            for (const sensorHr of [80, 100, 120, 135, 140]) {
                for (const isEdged of [false, true]) {
                    const base = { ...running, ...probe, edgeStrokeDepth: 100, isEdged, edgeHr: sensorHr };
                    const quiet = calculateEngineOutputs({ ...base, hr: sensorHr });
                    const loud = calculateEngineOutputs({ ...base, hr: Math.min(base.maxHr, sensorHr + 8) });
                    assert.deepEqual(
                        [loud.primaryPercent, loud.secondaryPercent, loud.strokeMinPercent, loud.strokeMaxPercent],
                        [quiet.primaryPercent, quiet.secondaryPercent, quiet.strokeMinPercent, quiet.strokeMaxPercent],
                        `${probe.activeMode}/${probe.oracleState || probe.trainingState || '-'} at ${sensorHr}`
                            + ' is called blind but the boost moved its output'
                    );
                    checked += 1;
                }
            }
        }
        assert.ok(checked > 0);
        // A mode it does NOT call blind must really use the boosted pulse.
        const teaseQuiet = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 120, edgeHr: 120 });
        const teaseLoud = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 128, edgeHr: 120 });
        assert.ok(teaseLoud.primaryPercent < teaseQuiet.primaryPercent, 'a tease mode must feel the boost');
    });

    it('app.js gates the badge on that helper', () => {
        // The badge text is written in app.js; the helper is worthless if the
        // cockpit does not ask it before promising MIC +N.
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        assert.ok(/micBoostReachesMotors\(/.test(src), 'app.js must ask which modes the boost reaches');
        const badge = src.match(/const micApplied = [^;]*;/);
        assert.ok(badge, 'the badge value anchor moved');
        assert.ok(
            /micReaches/.test(badge[0]),
            `the badge must report nothing in a blind mode: ${badge[0]}`
        );
    });
});

describe('0% reaches the motors only as a stop the engine decided on', () => {
    // The Handy's driver answers 0% with PUT /hamp/stop and the next moving
    // tick with PUT /hamp/start, and the T-Code and Intiface planners park the
    // sleeve at the bottom of the zone. So a running session may hand on 0%
    // only where the engine means a stop. Releases up to 1.1.2 also produced
    // it by rounding. In 1.1.2 that is the two-wave dip, which opens above
    // about 97% of the band, and the warm-up's 0.16 factor on the few percent
    // left there: at 139 BPM on 70-140, about 246 stop / start pairs an hour
    // in Classic, 168 in Ultimate, and 17 in a default warm-up held there.
    // 1.1.0 did it from 130 BPM up, and in a warm-up from a resting pulse.
    const sweep = (visit) => {
        for (const mode of TEASE_MODES) {
            for (const warmupMinutes of [0, 5]) {
                for (const intensityValue of [0, 50, 100]) {
                    for (let hr = 70; hr < 140; hr += 3) visit({ mode, warmupMinutes, intensityValue, hr });
                }
            }
        }
    };

    it('a tease mode running below the pullback mark never hands on 0%', () => {
        let ticks = 0;
        sweep(({ mode, warmupMinutes, intensityValue, hr }) => {
            for (let sessionSeconds = 0; sessionSeconds < 900; sessionSeconds += 1) {
                const out = calculateEngineOutputs({
                    ...running, activeMode: mode, hr, edgeHr: hr, warmupMinutes, intensityValue, sessionSeconds
                });
                if (!(out.primaryPercent >= MIN_MOVING_PERCENT) || !(out.secondaryPercent >= MIN_MOVING_PERCENT)) {
                    assert.fail(`${mode} hr=${hr} warm-up ${warmupMinutes} min intensity ${intensityValue} t=${sessionSeconds}:`
                        + ` primary ${out.primaryPercent}%, secondary ${out.secondaryPercent}%`);
                }
                ticks += 1;
            }
        });
        assert.ok(ticks > 500000, `expected a real sweep, ran ${ticks} ticks`);
    });

    it('the warm-up slows a near-stop down to the crawl instead of stopping it', () => {
        // The measured case: Classic at 139 BPM, the last BPM before the mark
        // on 70-140, through the default warm-up. The pattern runs at 1-3%
        // there and the wake-up factor starts at 0.16, so 1.1.2 rounded most
        // of the first minutes to 0: 17 stop / start pairs. Since 1.1.1 the
        // pattern no longer dips at a resting pulse, so a warm-up from 80 BPM
        // never gets that low.
        const speeds = [];
        for (let sessionSeconds = 0; sessionSeconds < 300; sessionSeconds += 1) {
            speeds.push(calculateEngineOutputs({
                ...running, activeMode: 'classic', hr: 139, edgeHr: 139, warmupMinutes: 5, sessionSeconds
            }).primaryPercent);
        }
        assert.equal(Math.min(...speeds), MIN_MOVING_PERCENT);
        assert.ok(speeds.filter((speed) => speed === MIN_MOVING_PERCENT).length >= 8, 'the near-stops of a warm-up are crawls');
    });

    it('every stop the engine decides on is still exactly 0%, warm-up and intensity notwithstanding', () => {
        const atMark = { ...running, hr: 140, edgeHr: 140, isEdged: true };
        for (const shared of [
            { warmupMinutes: 0, sessionSeconds: 400 },
            { warmupMinutes: 5, sessionSeconds: 30 }
        ]) {
            for (const intensityValue of [0, 50, 100]) {
                const at = { ...shared, intensityValue };
                // Full Stop at the ceiling, in every tease mode that obeys it.
                for (const mode of TEASE_MODES.filter((m) => m !== 'ruin')) {
                    const out = calculateEngineOutputs({ ...atMark, ...at, activeMode: mode, ceilingBehaviour: 'stop' });
                    assert.equal(out.primaryPercent, 0, `${mode} Full Stop, intensity ${intensityValue}`);
                }
                // The stall guard, in the middle of the band.
                for (const mode of TEASE_MODES) {
                    const out = calculateEngineOutputs({ ...running, ...at, activeMode: mode, hr: 118, edgeHr: 118, stallGuardEngaged: true });
                    assert.equal(out.primaryPercent, 0, `${mode} stall guard, intensity ${intensityValue}`);
                }
                // The Ruin lock.
                const lock = calculateEngineOutputs({ ...atMark, ...at, activeMode: 'ruin', ruinHoldSeconds: 5 });
                assert.equal(lock.primaryPercent, 0, `Ruin lock, intensity ${intensityValue}`);
                // The Oracle's denial stops both channels.
                const denial = calculateEngineOutputs({ ...atMark, ...at, activeMode: 'oracle', oracleState: 'DENIAL' });
                assert.equal(denial.primaryPercent, 0);
                assert.equal(denial.secondaryPercent, 0);
                // Pause (STOP, the HR watchdog) and every other state that is not running.
                for (const sessionStatus of ['IDLE', 'PAUSED']) {
                    const idle = calculateEngineOutputs({ ...running, ...at, activeMode: 'classic', sessionStatus });
                    assert.equal(idle.primaryPercent, 0);
                    assert.equal(idle.secondaryPercent, 0);
                }
            }
        }
    });
});

describe('cool-down after edges', () => {
    // A small seeded generator, so a failing case can be re-run by number.
    function mulberry32(seed) {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
    const between = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

    // One random engine input. Every field the engine reads is drawn, junk
    // included, so a sweep covers the silent paths as well as the moving ones.
    function seededInput(rnd) {
        const minHr = between(rnd, 40, 110);
        const maxHr = rnd() < 0.05 ? between(rnd, 30, minHr) : between(rnd, minHr + 1, 200);
        const hr = rnd() < 0.03 ? NaN : between(rnd, minHr - 10, maxHr + 15);
        // Narrow envelopes too: 45, 25 and 33 percent of travel round the
        // engine's ten-percent floor onto a fraction of a physical percent.
        const envelope = pick(rnd, [
            [0, 100], [0, 100], [15, 80], [90, 10], [50, 52], [NaN, NaN],
            [15, 60], [20, 45], [30, 63], [between(rnd, 0, 60), between(rnd, 40, 100)]
        ]);
        return {
            hr,
            edgeHr: rnd() < 0.2 ? undefined : (rnd() < 0.05 ? NaN : hr + between(rnd, -25, 5)),
            minHr: rnd() < 0.02 ? NaN : minHr,
            maxHr: rnd() < 0.02 ? NaN : maxHr,
            activeMode: rnd() < 0.03 ? 'ghost' : pick(rnd, ENGINE_MODES),
            strokeMode: pick(rnd, [undefined, undefined, 'classic', 'milker', 'shortener', 'headplay', 'ultimate', 'ruin']),
            sessionStatus: pick(rnd, ['RUNNING', 'RUNNING', 'RUNNING', 'RUNNING', 'RAMPDOWN', 'PAUSED', 'IDLE']),
            rampdownSecondsLeft: between(rnd, 0, 45),
            isEdged: rnd() < 0.35,
            orgasmMode: rnd() < 0.15,
            gamma: pick(rnd, [0.5, 1, 2, 2, 3, NaN]),
            intensityValue: rnd() < 0.05 ? NaN : between(rnd, 0, 100),
            edgeStrokeDepth: pick(rnd, [100, 100, 100, 40, 70, NaN]),
            handyHwMin: envelope[0],
            handyHwMax: envelope[1],
            sessionSeconds: between(rnd, 0, 900),
            warmupMinutes: pick(rnd, [0, 0, 1, 5, 10, NaN]),
            cadenceBreathing: rnd() < 0.5,
            milkingWave: rnd() < 0.5,
            stallGuardEngaged: rnd() < 0.2,
            ceilingBehaviour: pick(rnd, ['stop', 'crawl', 'garbage']),
            edgeHoldPercent: pick(rnd, [90, 95, 100, 100, NaN]),
            ruinHoldSeconds: pick(rnd, [0, 0, 3, 8]),
            oracleState: pick(rnd, ['IDLE', 'APPROACH', 'HOLD', 'PURGATORY', 'CLIMAX', 'DENIAL']),
            survivalSpeedFloor: between(rnd, 5, 100),
            trainingState: pick(rnd, ['climb', 'hold', 'recover', 'finish']),
            // Ruin & Leak's one ride per edge: once spent, the mark locks
            // instead of riding again until the edge releases.
            ruinSpent: rnd() < 0.3,
            // Seconds since Force Orgasm was armed: its ramp reads them. Drawn
            // LAST, so every draw above keeps its place in the stream. Without
            // it the sweep only ever saw the ramp at its first second.
            orgasmBoost: pick(rnd, [0, 0, 1, 3, 14, 27, 28, 40, 60, NaN]),
            // What the toys were last sent, which the ramp starts from: none
            // at all, real dispatches (a crawl, the stop a pause sends, a
            // stroke in the middle of the travel), and junk the engine must
            // refuse - text, NaN, an inverted window, one too narrow to be
            // an output, values off both ends. Drawn after everything else.
            orgasmFrom: pick(rnd, [
                undefined, undefined, null,
                { primary: 10, secondary: 10, strokeMin: 0, strokeMax: 100 },
                { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 },
                SENT_MID,
                { primary: '40', secondary: 30, strokeMin: 10, strokeMax: 70 },
                { primary: NaN, secondary: 30, strokeMin: 10, strokeMax: 70 },
                { primary: 55, secondary: 70, strokeMin: 90, strokeMax: 20 },
                { primary: 55, secondary: 70, strokeMin: 40, strokeMax: 42 },
                { primary: 180, secondary: -20, strokeMin: -50, strokeMax: 300 }
            ])
        };
    }

    function fnv1a(text, hash) {
        let h = hash >>> 0;
        for (let i = 0; i < text.length; i += 1) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h >>> 0;
    }

    // The digest of one seeded sweep of the engine. The cool-down fields are
    // drawn from their OWN generator, so the engine inputs are the same
    // stream whether or not a patch is applied.
    function digestSweep(seed, count, patch) {
        const rnd = mulberry32(seed);
        const cool = mulberry32(seed ^ 0x5bd1e995);
        let h = 0x811c9dc5;
        for (let i = 0; i < count; i += 1) {
            const input = seededInput(rnd);
            const r = calculateEngineOutputs(patch ? { ...input, ...patch(cool) } : input);
            h = fnv1a(JSON.stringify([
                r.primaryPercent, r.secondaryPercent, r.strokeMinPercent, r.strokeMaxPercent,
                r.isEdged, r.newEdgeTriggered, r.resolvedMode
            ]), h);
        }
        return h.toString(16).padStart(8, '0');
    }

    const NONE = { speed: 1, depth: 1 };
    const FIRST_SECOND = { speed: 0.16, depth: 0.28 };
    const LENGTHS = [1, 2, 3, 5];
    const span = (r) => r.strokeMaxPercent - r.strokeMinPercent;
    // The output fields the literals below write out: the four motor
    // numbers, the edge flag, the edge count and the mode, which was the
    // engine's whole output when this suite was written. It hands back two
    // more now, edgePending and pullbackStarted, both decided with the edge
    // flag before any cool-down runs. A literal is compared on the fields it
    // documents, and the property below checks that a cool-down never moves
    // the two new ones either.
    const documented = (r) => ({
        primaryPercent: r.primaryPercent,
        secondaryPercent: r.secondaryPercent,
        strokeMinPercent: r.strokeMinPercent,
        strokeMaxPercent: r.strokeMaxPercent,
        isEdged: r.isEdged,
        newEdgeTriggered: r.newEdgeTriggered,
        resolvedMode: r.resolvedMode
    });

    it('runs only in the five tease modes: not in Ruin & Leak, not in a game', () => {
        assert.deepEqual(COOLDOWN_MODES, ['classic', 'milker', 'shortener', 'headplay', 'ultimate']);
        for (const mode of COOLDOWN_MODES) {
            assert.ok(ENGINE_MODES.includes(mode) && !GAME_MODES.includes(mode) && mode !== 'ruin', mode);
        }
    });

    it('cooldownShape is the warm-up curve restarted at the edge, and reads junk as no cool-down', () => {
        for (const mode of COOLDOWN_MODES) {
            for (const minutes of LENGTHS) {
                for (const seconds of [0, 0.5, 1, 30, 59, 60, 119, 120, 179, 180, 299, 300, 301, 1000]) {
                    assert.deepEqual(cooldownShape(mode, seconds, minutes), warmupShape(seconds, minutes), `${mode} ${seconds}s of ${minutes} min`);
                }
                assert.deepEqual(cooldownShape(mode, minutes * 60, minutes), NONE, `${mode}: exactly at its length the cool-down is over`);
            }
            for (const seconds of [NaN, -3, -0.001, Infinity, -Infinity, null, undefined, '5', '', true]) {
                assert.deepEqual(cooldownShape(mode, seconds, 2), NONE, `${mode} seconds ${seconds}`);
            }
            for (const minutes of [0, -1, NaN, Infinity, -Infinity, null, undefined, '2', true]) {
                assert.deepEqual(cooldownShape(mode, 10, minutes), NONE, `${mode} minutes ${minutes}`);
            }
        }
        for (const mode of ['ruin', ...GAME_MODES, 'ghost', undefined, null]) {
            assert.deepEqual(cooldownShape(mode, 0, 2), NONE, `${mode} never cools down`);
        }
        // Why the gate is strict: the curve itself reads a NaN or negative
        // second as second zero, its SLOWEST point. Handed a broken clock
        // unchecked, the engine would pin the toys at 16% speed with no
        // cool-down running and nothing on the cockpit to say why.
        assert.deepEqual(warmupShape(NaN, 2), FIRST_SECOND);
        assert.deepEqual(warmupShape(-3, 2), FIRST_SECOND);
    });

    it('at the first second the factors are 0.16 (speed) and 0.28 (depth)', () => {
        for (const mode of COOLDOWN_MODES) {
            for (const minutes of LENGTHS) {
                assert.deepEqual(cooldownShape(mode, 0, minutes), FIRST_SECOND, `${mode} ${minutes} min`);
            }
        }
        // In the engine, with Global Intensity at 50 (a scale of exactly 1)
        // the two factors can be read straight off the output: the speeds
        // are 16% of the open ones, rounded the way every speed is (a motion
        // slowed down crawls at 1% instead of rounding into a stop), and the
        // stroke is 28% of the open stroke (never under the MIN_ZONE_WIDTH
        // floor). Classic Tease keeps the stroke at the bottom of the window,
        // so strokeMin stays 0.
        for (const hr of [70, 80, 95, 110, 125, 135]) {
            for (const sessionSeconds of [3, 20, 47, 128, 300]) {
                const base = { ...running, activeMode: 'classic', hr, sessionSeconds, intensityValue: 50, warmupMinutes: 0 };
                const open = calculateEngineOutputs(base);
                const cooled = calculateEngineOutputs({ ...base, cooldownSeconds: 0, cooldownMinutes: 2 });
                const at = `hr ${hr} t=${sessionSeconds}`;
                assert.equal(cooled.primaryPercent, roundSpeed(open.primaryPercent * 0.16), `${at} primary ${open.primaryPercent}`);
                assert.equal(cooled.secondaryPercent, roundSpeed(open.secondaryPercent * 0.16), `${at} secondary ${open.secondaryPercent}`);
                assert.equal(cooled.strokeMinPercent, 0, at);
                assert.equal(cooled.strokeMaxPercent, Math.max(MIN_ZONE_WIDTH, Math.round(open.strokeMaxPercent * 0.28)), `${at} stroke ${open.strokeMaxPercent}`);
            }
        }
        // Parked at the ceiling on Crawl: the 10% crawl becomes 2%, the full
        // stroke becomes 28%, and the edge flag is exactly what it was.
        const parked = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: true,
            ceilingBehaviour: 'crawl',
            intensityValue: 50,
            cooldownSeconds: 0,
            cooldownMinutes: 2
        });
        assert.deepEqual(documented(parked), {
            primaryPercent: 2,
            secondaryPercent: 2,
            strokeMinPercent: 0,
            strokeMaxPercent: 28,
            isEdged: true,
            newEdgeTriggered: false,
            resolvedMode: 'classic'
        });
        // A cool-down's first second IS a warm-up's first second, bit for bit.
        for (const mode of COOLDOWN_MODES) {
            for (const hr of [75, 100, 130]) {
                const base = { ...running, activeMode: mode, hr, sessionSeconds: 0 };
                assert.deepEqual(
                    calculateEngineOutputs({ ...base, warmupMinutes: 0, cooldownSeconds: 0, cooldownMinutes: 3 }),
                    calculateEngineOutputs({ ...base, warmupMinutes: 5 }),
                    `${mode} hr ${hr}`
                );
            }
        }
    });

    it('eases every tease mode from its first second and lets go exactly at its length', () => {
        for (const mode of COOLDOWN_MODES) {
            for (const minutes of LENGTHS) {
                const base = { ...running, activeMode: mode, hr: 100, sessionSeconds: 45 };
                const open = calculateEngineOutputs(base);
                const start = calculateEngineOutputs({ ...base, cooldownSeconds: 0, cooldownMinutes: minutes });
                const at = `${mode} ${minutes} min`;
                assert.ok(open.primaryPercent > 0, `${at}: the fixture must be moving`);
                assert.ok(start.primaryPercent < open.primaryPercent, `${at}: primary ${start.primaryPercent} vs ${open.primaryPercent}`);
                assert.ok(span(start) < span(open), `${at}: stroke ${span(start)} vs ${span(open)}`);
                assert.ok(span(start) >= MIN_ZONE_WIDTH, `${at}: the zone never jams`);
                const mid = calculateEngineOutputs({ ...base, cooldownSeconds: minutes * 30, cooldownMinutes: minutes });
                assert.ok(start.primaryPercent <= mid.primaryPercent && mid.primaryPercent <= open.primaryPercent, `${at}: half way`);
                assert.ok(span(start) <= span(mid) && span(mid) <= span(open), `${at}: half way stroke`);
                const done = calculateEngineOutputs({ ...base, cooldownSeconds: minutes * 60, cooldownMinutes: minutes });
                assert.deepEqual(done, open, `${at}: identical once the length has run`);
                const past = calculateEngineOutputs({ ...base, cooldownSeconds: minutes * 60 + 500, cooldownMinutes: minutes });
                assert.deepEqual(past, open, `${at}: and long after`);
            }
        }
    });

    it('with the warm-up still running, the smaller factor of the two wins', () => {
        for (const mode of COOLDOWN_MODES) {
            const base = { ...running, activeMode: mode, hr: 100, sessionSeconds: 60 };
            // A cool-down at its start under a warm-up a fifth of the way
            // in: the cool-down is slower, and the result is the cool-down
            // alone. It never speeds a warm-up up.
            assert.deepEqual(
                calculateEngineOutputs({ ...base, warmupMinutes: 5, cooldownSeconds: 0, cooldownMinutes: 2 }),
                calculateEngineOutputs({ ...base, warmupMinutes: 0, cooldownSeconds: 0, cooldownMinutes: 2 }),
                `${mode}: the cool-down is the slower shape`
            );
            // A cool-down at its last second under that same warm-up: the
            // warm-up is slower, and the result is the warm-up alone. It
            // never cuts a warm-up short.
            assert.deepEqual(
                calculateEngineOutputs({ ...base, warmupMinutes: 5, cooldownSeconds: 119, cooldownMinutes: 2 }),
                calculateEngineOutputs({ ...base, warmupMinutes: 5 }),
                `${mode}: the warm-up is the slower shape`
            );
        }
    });

    it('has no effect in the games, Ruin & Leak, Force Orgasm, RAMPDOWN, PAUSED, or with NaN, -3 or Infinity inputs', () => {
        const unchanged = (patch, why) => {
            for (const hr of [70, 100, 139, 141]) {
                for (const sessionSeconds of [0, 7, 61, 300]) {
                    for (const isEdged of [false, true]) {
                        const base = { ...running, hr, sessionSeconds, isEdged, ceilingBehaviour: 'crawl', ...patch };
                        const plain = calculateEngineOutputs(base);
                        for (const cool of [
                            { cooldownSeconds: 0, cooldownMinutes: 2 },
                            { cooldownSeconds: 30, cooldownMinutes: 5 },
                            { cooldownSeconds: null, cooldownMinutes: 2 }
                        ]) {
                            assert.deepEqual(
                                calculateEngineOutputs({ ...base, ...cool }),
                                plain,
                                `${why}: ${JSON.stringify({ hr, sessionSeconds, isEdged, ...cool })}`
                            );
                        }
                    }
                }
            }
        };
        for (const mode of GAME_MODES) {
            for (const strokeMode of [undefined, 'classic', 'headplay']) {
                unchanged({ activeMode: mode, strokeMode }, `${mode} borrowing ${strokeMode}`);
            }
        }
        for (const oracleState of ['IDLE', 'APPROACH', 'HOLD', 'PURGATORY', 'CLIMAX', 'DENIAL']) {
            unchanged({ activeMode: 'oracle', oracleState }, `oracle ${oracleState}`);
        }
        for (const trainingState of ['climb', 'hold', 'recover', 'finish']) {
            unchanged({ activeMode: 'edgetrain', trainingState }, `edgetrain ${trainingState}`);
        }
        unchanged({ activeMode: 'survival', survivalSpeedFloor: 60 }, 'survival');
        unchanged({ activeMode: 'ruin' }, 'ruin');
        unchanged({ activeMode: 'ruin', ruinHoldSeconds: 8 }, 'ruin lockout');
        for (const mode of COOLDOWN_MODES) {
            // A cool-down never slows the overdrive. Force Orgasm's ramp starts
            // from what the toys were last sent, so once the caller says what
            // that was - and once the ramp has reached the top - a cool-down
            // cannot change a thing. (Told nothing, the ramp starts from the
            // output the engine sends without Force Orgasm, which in a
            // cool-down is the cooled one: see 'Force Orgasm starts from what
            // the toys were last sent'.)
            unchanged({ activeMode: mode, orgasmMode: true, orgasmFrom: SENT_MID }, `${mode} Force Orgasm from what was sent`);
            unchanged({ activeMode: mode, orgasmMode: true, orgasmFrom: SENT_MID, orgasmBoost: 14 }, `${mode} Force Orgasm half way up`);
            unchanged({ activeMode: mode, orgasmMode: true, orgasmBoost: 28 }, `${mode} Force Orgasm at the top`);
            unchanged({ activeMode: mode, sessionStatus: 'RAMPDOWN', rampdownSecondsLeft: 30 }, `${mode} RAMPDOWN`);
            unchanged({ activeMode: mode, sessionStatus: 'PAUSED' }, `${mode} PAUSED`);
            unchanged({ activeMode: mode, sessionStatus: 'IDLE' }, `${mode} IDLE`);
            unchanged({ activeMode: mode, sessionStatus: 'STOPPED' }, `${mode} STOPPED`);
        }
        // Junk in either field is no cool-down, in the very state where a
        // real one would bite hardest.
        for (const mode of COOLDOWN_MODES) {
            const base = { ...running, activeMode: mode, hr: 100, sessionSeconds: 20 };
            const plain = calculateEngineOutputs(base);
            assert.notDeepEqual(calculateEngineOutputs({ ...base, cooldownSeconds: 0, cooldownMinutes: 2 }), plain, `${mode}: the control case must move`);
            for (const cooldownSeconds of [NaN, -3, -0.001, Infinity, -Infinity, '5', null, undefined, true]) {
                for (const cooldownMinutes of LENGTHS) {
                    assert.deepEqual(calculateEngineOutputs({ ...base, cooldownSeconds, cooldownMinutes }), plain, `${mode} seconds ${cooldownSeconds} of ${cooldownMinutes} min`);
                }
            }
            for (const cooldownMinutes of [NaN, -3, Infinity, -Infinity, 0, '2', null, undefined, true]) {
                for (const cooldownSeconds of [0, 30]) {
                    assert.deepEqual(calculateEngineOutputs({ ...base, cooldownSeconds, cooldownMinutes }), plain, `${mode} ${cooldownSeconds}s of minutes ${cooldownMinutes}`);
                }
            }
        }
    });

    it('property: over 100 000 seeded inputs a cool-down never raises primary, secondary or the stroke span, and never moves the edge flags', () => {
        // INV-13. The cool-down is decided after the edge flag and composed
        // into the wake-up by the smaller factor, so whatever the mode, the
        // status, the game state, the guards or the junk in the input, the
        // toys with a cool-down are never faster or longer than without one,
        // and the edge detector never sees it: not the flag, not the start of
        // a pullback, not the count and not a count still owed.
        const rnd = mulberry32(31337);
        const cool = mulberry32(1);
        let eased = 0;
        let counted = 0;
        for (let i = 0; i < 100000; i += 1) {
            // The count's own inputs are derived from the draw, never drawn,
            // so they take nothing from the stream seededInput draws: two
            // readings of the measured pulse, which hold it wherever it is,
            // and a count still owed on the edged inputs whose index is a
            // multiple of three. Without them no edge is ever counted here,
            // and the count would be compared for nothing.
            const drawn = seededInput(rnd);
            const pulse = Number.isFinite(drawn.edgeHr) ? drawn.edgeHr : drawn.hr;
            const input = {
                ...drawn,
                edgePending: drawn.isEdged && i % 3 === 0,
                recentReadings: [{ at: 1000, bpm: pulse }, { at: 2000, bpm: pulse }]
            };
            const patch = {
                cooldownSeconds: cool() < 0.2 ? 0 : between(cool, 0, 400),
                cooldownMinutes: pick(cool, LENGTHS)
            };
            const plain = calculateEngineOutputs({ ...input, cooldownSeconds: null });
            const cooled = calculateEngineOutputs({ ...input, ...patch });
            // Messages are built only on failure: 100 000 eager strings
            // would cost more than the engine calls they describe. Each
            // comparison is written so that a NaN output fails it too.
            const fail = (what) => assert.fail(
                `${what}: case ${i} ${JSON.stringify(input)} with ${JSON.stringify(patch)}\n`
                + `  plain  ${JSON.stringify(plain)}\n  cooled ${JSON.stringify(cooled)}`
            );
            if (!(cooled.primaryPercent <= plain.primaryPercent)) fail('the primary rose');
            if (!(cooled.secondaryPercent <= plain.secondaryPercent)) fail('the secondary rose');
            if (!(span(cooled) <= span(plain))) fail('the stroke span grew');
            if (!(cooled.strokeMaxPercent <= plain.strokeMaxPercent)) fail('the stroke top rose');
            if (!(cooled.strokeMinPercent <= plain.strokeMinPercent)) fail('the stroke bottom rose');
            // The zone is never collapsed, and inside the full travel
            // envelope it keeps the engine's own floor. A narrower envelope
            // maps that floor onto fewer physical percent, exactly as today.
            if (!(cooled.strokeMaxPercent > cooled.strokeMinPercent)) fail('the zone collapsed');
            const fullEnvelope = !(Number.isFinite(input.handyHwMin) && Number.isFinite(input.handyHwMax))
                || (input.handyHwMin === 0 && input.handyHwMax === 100);
            if (fullEnvelope && !(span(cooled) >= MIN_ZONE_WIDTH)) fail(`the zone is under ${MIN_ZONE_WIDTH} wide`);
            if (cooled.isEdged !== plain.isEdged) fail('isEdged moved');
            if (cooled.pullbackStarted !== plain.pullbackStarted) fail('pullbackStarted moved');
            if (cooled.edgePending !== plain.edgePending) fail('edgePending moved');
            if (cooled.newEdgeTriggered !== plain.newEdgeTriggered) fail('newEdgeTriggered moved');
            if (cooled.resolvedMode !== plain.resolvedMode) fail('resolvedMode moved');
            if (cooled.primaryPercent < plain.primaryPercent || span(cooled) < span(plain)) eased += 1;
            if (plain.newEdgeTriggered) counted += 1;
        }
        // Roughly a quarter of the sweep is a running tease mode outside
        // Force Orgasm, and about half of those draw a cool-down still in
        // progress: the bounds below are guards against a vacuous sweep, not
        // measurements.
        assert.ok(eased >= 5000, `the sweep must exercise the cool-down, not only its silent paths (${eased} of 100000 eased)`);
        assert.ok(counted >= 3000, `the sweep must count edges, or the count is compared for nothing (${counted} of 100000 counted)`);
    });

    it('golden: cooldownSeconds null or cooldownMinutes 0 is bit-identical to the engine without a cool-down, over every mode', () => {
        // INV-16. The digests below are those of an engine with no cool-down
        // at all, over exactly this sweep: 20 000 seeded inputs per seed,
        // every mode, every status, junk included. A wearer who never turns
        // the cool-down on gets that engine to the last digit. A deliberate
        // change to the engine's numbers has to record new digests here and
        // say so in its commit. History, so the next person to move them
        // knows what moved them before. Over this sweep, which also draws
        // ruinSpent (Ruin & Leak's one-ride flag) and, last, orgasmBoost (the
        // clock 1.1.1's Force Orgasm ramp reads), release 1.1.2 gives bb2167ce
        // and 52342959. Three deliberate engine changes moved them. A pattern
        // near-stop crawls at 1% instead of rounding into a stop (39084f87
        // and 4322c050). Ruin & Leak rides each edge once - a game borrows its
        // stroke but never its lockout, and Force Orgasm over a spent edge
        // ramps from the stop - which gives b2ebc162 and 553ece13: the engine
        // just before the cool-down arrived, and the cool-down with nothing
        // running left them there. And an edge is counted only once the pulse
        // has held at the mark, which gives 3038b1b4 and 3b656b53: this sweep
        // hands the engine no readings, so a reading on the mark still raises
        // the flag and pulls back, but no edge is counted (the count has its
        // own suite above). The engine just before the cool-down, with that
        // change made to it, gives the same two digests. An engine that
        // ignored either drawn field gives different digests, so both are
        // pinned here too. Release 1.1.0 gave ebd8f3f8 and 853ecdc8 over the
        // sweep as it stood then, before it drew either field. The sweep now
        // also draws orgasmFrom, what the toys were last sent, last of all,
        // which moves every input after the first: over it the engine before
        // the next change gives 114b5bfe and 95edb64e, and Force Orgasm easing
        // from what was sent - or, told nothing, from what the engine sends
        // without it that second - gives the digests below. Made on the
        // engine as it was before an edge waited for the pulse to hold at the
        // mark, the same change took 13bc6d6e and c49dd7e8 to c3e3a7d1 and
        // b123e1e8. An engine that ignored orgasmFrom gives different digests
        // too. The sweep does not draw landingFrom, what a soft landing that
        // took over from Force Orgasm was last sent: told nothing, a landing
        // is the one these digests pin, and 'a soft landing that takes over
        // from Force Orgasm never speeds the toys up' covers it.
        const GOLDEN = [[20260927, '86dced1d'], [424242, '726a2ad2']];
        for (const [seed, digest] of GOLDEN) {
            assert.equal(digestSweep(seed, 20000), digest, `seed ${seed}: the engine with no cool-down fields`);
            assert.equal(
                digestSweep(seed, 20000, (cool) => ({ cooldownSeconds: null, cooldownMinutes: pick(cool, LENGTHS) })),
                digest,
                `seed ${seed}: cooldownSeconds null`
            );
            assert.equal(
                digestSweep(seed, 20000, (cool) => ({ cooldownSeconds: between(cool, 0, 400), cooldownMinutes: 0 })),
                digest,
                `seed ${seed}: cooldownMinutes 0`
            );
            assert.notEqual(
                digestSweep(seed, 20000, (cool) => ({ cooldownSeconds: between(cool, 0, 400), cooldownMinutes: pick(cool, LENGTHS) })),
                digest,
                `seed ${seed}: a running cool-down must change the output, or this digest proves nothing`
            );
        }
        // The sweep visits every mode.
        const rnd = mulberry32(20260927);
        const seen = new Set();
        for (let i = 0; i < 20000; i += 1) seen.add(resolveEngineMode(seededInput(rnd).activeMode));
        assert.deepEqual([...seen].sort(), [...ENGINE_MODES].sort());
    });

    it('golden, readable: the 1.1.2 numbers for every mode through the warm-up, cool-down Off', () => {
        // The same promise in numbers a reviewer can read: the fixture above
        // with the warm-up on at 20 s (the code path this change touches)
        // and Crawl at the ceiling, as release 1.1.2 computes it; the engine
        // just before this change gives the same numbers at these points.
        // Each row is [mode, hr, primary, secondary, strokeMin, strokeMax,
        // isEdged, newEdgeTriggered]; the pulse at 140 is parked on the mark.
        const GOLDEN_ROWS = [
            ['classic', 80, 14, 13, 0, 26, false, false],
            ['classic', 120, 7, 6, 0, 26, false, false],
            ['classic', 140, 2, 2, 0, 29, true, false],
            ['milker', 80, 16, 3, 0, 23, false, false],
            ['milker', 120, 8, 9, 0, 23, false, false],
            ['milker', 140, 2, 5, 0, 12, true, false],
            ['shortener', 80, 15, 3, 0, 24, false, false],
            ['shortener', 120, 10, 3, 0, 24, false, false],
            ['shortener', 140, 2, 3, 0, 10, true, false],
            ['headplay', 80, 16, 15, 15, 40, false, false],
            ['headplay', 120, 8, 7, 15, 40, false, false],
            ['headplay', 140, 2, 2, 75, 85, true, false],
            ['ultimate', 80, 15, 3, 0, 25, false, false],
            ['ultimate', 120, 8, 8, 0, 24, false, false],
            ['ultimate', 140, 2, 8, 0, 14, true, false],
            ['ruin', 80, 16, 4, 0, 27, false, false],
            ['ruin', 120, 12, 7, 0, 27, false, false],
            ['ruin', 140, 12, 10, 0, 27, true, false],
            ['oracle', 80, 8, 5, 0, 26, false, false],
            ['oracle', 120, 13, 10, 0, 26, false, false],
            ['oracle', 140, 2, 7, 0, 29, true, false],
            ['survival', 80, 7, 5, 0, 26, false, false],
            ['survival', 120, 7, 5, 0, 26, false, false],
            ['survival', 140, 7, 5, 0, 29, true, false],
            ['edgetrain', 80, 8, 5, 0, 26, false, false],
            ['edgetrain', 120, 13, 10, 0, 26, false, false],
            ['edgetrain', 140, 2, 7, 0, 29, true, false]
        ];
        assert.deepEqual([...new Set(GOLDEN_ROWS.map(([mode]) => mode))], ENGINE_MODES, 'every mode has its rows');
        for (const [mode, hr, primary, secondary, strokeMin, strokeMax, isEdged, newEdgeTriggered] of GOLDEN_ROWS) {
            const input = { ...running, activeMode: mode, hr, isEdged: hr >= 140, warmupMinutes: 5, sessionSeconds: 20, ceilingBehaviour: 'crawl' };
            const expected = {
                primaryPercent: primary,
                secondaryPercent: secondary,
                strokeMinPercent: strokeMin,
                strokeMaxPercent: strokeMax,
                isEdged,
                newEdgeTriggered,
                resolvedMode: mode
            };
            assert.deepEqual(documented(calculateEngineOutputs(input)), expected, `${mode} hr ${hr}: no cool-down fields`);
            assert.deepEqual(documented(calculateEngineOutputs({ ...input, cooldownSeconds: null, cooldownMinutes: 5 })), expected, `${mode} hr ${hr}: cooldownSeconds null`);
            assert.deepEqual(documented(calculateEngineOutputs({ ...input, cooldownSeconds: 12, cooldownMinutes: 0 })), expected, `${mode} hr ${hr}: cooldownMinutes 0`);
        }
    });
});
