import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    calculateEngineOutputs,
    ENGINE_MODES,
    resolveEngineMode,
    resolveCeilingBehaviour,
    hasReleasedEdge,
    EDGE_RELEASE_BPM,
    MIN_ZONE_WIDTH,
    CRAWL_PERCENT,
    SHORTENER_TOP_PERCENT
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
            'classic', 'milker', 'shortener', 'headplay', 'ultimate', 'ruin', 'oracle', 'survival'
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
        assert.equal(hold.primaryPercent, 14);
        assert.equal(denial.primaryPercent, 0);
        assert.ok(climax.primaryPercent >= 85);
        assert.ok(purgatory.primaryPercent > 0);
        assert.ok(purgatory.primaryPercent < 100);
    });

    it('survival uses the accelerating floor', () => {
        const result = calculateEngineOutputs({ ...running, activeMode: 'survival', survivalSpeedFloor: 61 });
        assert.equal(result.primaryPercent, 61);
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
