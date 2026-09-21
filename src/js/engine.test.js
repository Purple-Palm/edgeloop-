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
    gameEdgeReleased
} from './engine.js';

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
        const atMark = { ...running, activeMode: 'classic', hr: 140, isEdged: true };
        const first = calculateEngineOutputs(atMark);
        assert.equal(first.isEdged, true);

        for (const status of ['PAUSED', 'IDLE', 'STOPPED']) {
            const paused = calculateEngineOutputs({ ...atMark, sessionStatus: status });
            assert.equal(paused.primaryPercent, 0, `${status} must still silence the motors`);
            assert.equal(paused.secondaryPercent, 0);
            assert.equal(paused.newEdgeTriggered, false);
            assert.equal(paused.isEdged, true, `${status} must not release the edge`);

            const resumed = calculateEngineOutputs({ ...atMark, isEdged: paused.isEdged });
            assert.equal(resumed.newEdgeTriggered, false, `resuming after ${status} must not count a new edge`);
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

    it('shortener contracts the envelope toward the base', () => {
        const result = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 120 });
        assert.ok(result.strokeMaxPercent < 100);
        assert.equal(result.strokeMinPercent, 0);
    });

    it('shortener runs full length at rest and lands on base micro-strokes 0-35% at the ceiling', () => {
        assert.equal(SHORTENER_TOP_PERCENT, 35);
        const rest = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 70 });
        assert.equal(rest.strokeMinPercent, 0);
        assert.equal(rest.strokeMaxPercent, 100);
        const mid = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 125 });
        assert.ok(mid.strokeMaxPercent < 100 && mid.strokeMaxPercent > SHORTENER_TOP_PERCENT);
        const ceiling = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 140, isEdged: true, ceilingBehaviour: 'crawl' });
        assert.equal(ceiling.strokeMinPercent, 0);
        assert.equal(ceiling.strokeMaxPercent, SHORTENER_TOP_PERCENT);
        // Never narrower than promised, even past the ceiling.
        const over = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 170, isEdged: true, ceilingBehaviour: 'crawl' });
        assert.equal(over.strokeMaxPercent, SHORTENER_TOP_PERCENT);
    });

    it('headplay contracts the envelope toward the glans', () => {
        const result = calculateEngineOutputs({ ...running, activeMode: 'headplay', hr: 120 });
        assert.ok(result.strokeMinPercent > 0);
        assert.equal(result.strokeMaxPercent, 100);
    });

    it('milker cross-fades secondary up as HR rises', () => {
        const low = calculateEngineOutputs({ ...running, activeMode: 'milker', hr: 75 });
        const high = calculateEngineOutputs({ ...running, activeMode: 'milker', hr: 125 });
        assert.ok(high.secondaryPercent > low.secondaryPercent);
        assert.ok(high.primaryPercent < low.primaryPercent);
    });

    it('ruin holds secondary while primary is cut', () => {
        const result = calculateEngineOutputs({
            ...running,
            activeMode: 'ruin',
            hr: 140,
            isEdged: true,
            ruinHoldSeconds: 10
        });
        assert.equal(result.primaryPercent, 0);
        assert.equal(result.secondaryPercent, 100);
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
        const climax = calculateEngineOutputs({ ...running, activeMode: 'oracle', oracleState: 'CLIMAX', orgasmMode: true, hr: 140 });
        const purgatory = calculateEngineOutputs({ ...running, activeMode: 'oracle', oracleState: 'PURGATORY', sessionSeconds: 4 });
        // HOLD is a hold AT the pullback mark, so it obeys the wearer's
        // ceiling rule; `running` selects Full Stop.
        assert.equal(hold.primaryPercent, 0);
        assert.ok(hold.secondaryPercent > 0, 'the secondary channel keeps running');
        assert.equal(denial.primaryPercent, 0);
        assert.ok(climax.primaryPercent >= 85);
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
        }
        // Force Orgasm is still the one thing that overrides it.
        const forced = calculateEngineOutputs({
            ...atMark, activeMode: 'oracle', oracleState: 'HOLD', ceilingBehaviour: 'stop', orgasmMode: true
        });
        assert.ok(forced.primaryPercent >= 85);
        // Global Intensity cannot smuggle motion past Full Stop either.
        const loud = calculateEngineOutputs({
            ...atMark, activeMode: 'oracle', oracleState: 'PURGATORY', ceilingBehaviour: 'stop', intensityValue: 100
        });
        assert.equal(loud.primaryPercent, 0);
    });

    it('oracle climax with Force Orgasm cancelled obeys the ceiling rule', () => {
        const base = { ...running, activeMode: 'oracle', oracleState: 'CLIMAX', orgasmMode: false, isEdged: true, hr: 170 };
        const stop = calculateEngineOutputs({ ...base, ceilingBehaviour: 'stop' });
        assert.equal(stop.primaryPercent, 0);
        assert.equal(stop.secondaryPercent, 0);
        const crawl = calculateEngineOutputs({ ...base, ceilingBehaviour: 'crawl' });
        assert.equal(crawl.primaryPercent, CRAWL_PERCENT);
        assert.equal(crawl.secondaryPercent, CRAWL_PERCENT);
        const below = calculateEngineOutputs({ ...base, isEdged: false, hr: 100 });
        assert.equal(below.primaryPercent, 100);
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
        const recover = calculateEngineOutputs({
            ...running,
            activeMode: 'edgetrain',
            trainingState: 'recover',
            isEdged: true,
            hr: 140
        });
        assert.equal(recover.primaryPercent, 0);
    });

    it('warmup caps travel at session start', () => {
        const result = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            warmupMinutes: 5,
            sessionSeconds: 0,
            hr: 80
        });
        assert.equal(result.strokeMaxPercent, 55);
    });
});

describe('engine safety guards', () => {
    it('head play during warm-up never collapses or inverts the zone', () => {
        // Progress near the top pushes strokeMin to 75 while warm-up caps
        // strokeMax at 55: the old code returned a zero-width zone.
        const result = calculateEngineOutputs({
            ...running,
            activeMode: 'headplay',
            hr: 135,
            warmupMinutes: 5,
            sessionSeconds: 0
        });
        assert.ok(result.strokeMaxPercent - result.strokeMinPercent >= MIN_ZONE_WIDTH);
        assert.ok(result.strokeMaxPercent <= 55);
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

    it('newEdgeTriggered fires exactly once per crossing', () => {
        const first = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 141, isEdged: false });
        assert.equal(first.newEdgeTriggered, true);
        assert.equal(first.isEdged, true);
        const second = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 145, isEdged: first.isEdged });
        assert.equal(second.newEdgeTriggered, false);
        assert.equal(second.isEdged, true);
        const hovering = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 137, isEdged: second.isEdged });
        assert.equal(hovering.newEdgeTriggered, false);
        assert.equal(hovering.isEdged, true);
        const back = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 120, isEdged: hovering.isEdged });
        assert.equal(back.isEdged, false);
        const again = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 140, isEdged: back.isEdged });
        assert.equal(again.newEdgeTriggered, true);
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
        const atMax = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: false,
            ceilingBehaviour: 'crawl',
            edgeHoldPercent: 115
        });
        assert.equal(atMax.isEdged, true, 'the typed max is the pullback mark');
        assert.equal(atMax.newEdgeTriggered, true);
        assert.equal(atMax.primaryPercent, CRAWL_PERCENT);

        const released = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 134,
            isEdged: true,
            ceilingBehaviour: 'crawl',
            edgeHoldPercent: 115
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
        const hit = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: false,
            ceilingBehaviour: 'stop',
            edgeHoldPercent: 100
        });
        assert.equal(hit.newEdgeTriggered, true);
        assert.equal(hit.primaryPercent, 0);
    });

    it('95% hold pulls back before the typed climax', () => {
        const early = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 133,
            isEdged: false,
            ceilingBehaviour: 'crawl',
            edgeHoldPercent: 95
        });
        assert.equal(early.newEdgeTriggered, true);
        assert.equal(early.primaryPercent, CRAWL_PERCENT);
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
        const orgasm = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 150, orgasmMode: true });
        assert.equal(orgasm.newEdgeTriggered, false);
        const ramp = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 150, sessionStatus: 'RAMPDOWN' });
        assert.equal(ramp.newEdgeTriggered, false);
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
        const boosted = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            edgeHr: 120,
            isEdged: false
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

        const real = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 140, edgeHr: 140, isEdged: false });
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
        const r = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 140, isEdged: false });
        assert.equal(r.newEdgeTriggered, true);
        const bad = calculateEngineOutputs({ ...running, activeMode: 'classic', hr: 140, edgeHr: NaN, isEdged: false });
        assert.equal(bad.newEdgeTriggered, true);
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

        const phantom = calculateEngineOutputs({
            ...running,
            activeMode: 'oracle',
            oracleState: 'PURGATORY',
            hr: 130,
            isEdged: false,
            edgeHoldPercent: 90
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
                    for (const isEdged of [false, true]) {
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
                                            isEdged,
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
        const defaultBranch = { oracle: 'APPROACH', edgetrain: 'climb' };
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
                if (value === defaultBranch[mode]) {
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
                    const quiet = calculateEngineOutputs({ ...base, hr: sensorHr, edgeHr: sensorHr });
                    const loud = calculateEngineOutputs({
                        ...base,
                        hr: Math.min(base.maxHr, sensorHr + boost),
                        edgeHr: sensorHr
                    });
                    const where = `${base.activeMode}/${base.oracleState || base.trainingState || '-'}`
                        + ` ${base.sessionStatus} ${base.ceilingBehaviour}`
                        + ` edged=${base.isEdged} orgasm=${base.orgasmMode}`
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

describe('Survival Mode is the documented exception to the ceiling rule', () => {
    it('keeps climbing whatever the At-the-ceiling setting says', () => {
        // Deliberate and self-terminating: the run ends on a breach, which is
        // why the Guards text, the mode card and the README name Survival as
        // the one mode Full Stop / Crawl does not govern.
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

    it('the Guards text, the mode card and the README all say so', () => {
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
        }
        const card = guards.match(/Speed steadily accelerates[^<]*/);
        assert.ok(card, 'Survival mode card anchor missing');
        assert.ok(/At the ceiling/.test(card[0]), `the Survival card must say the rule does not govern it: ${card[0]}`);
    });
});
