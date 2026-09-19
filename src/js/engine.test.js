import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateEngineOutputs, ENGINE_MODES, resolveEngineMode } from './engine.js';

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
    stallGuardEnabled: false,
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

    it('classic full-stops at ceiling without stall guard', () => {
        const result = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: true,
            stallGuardEnabled: false
        });
        assert.equal(result.primaryPercent, 0);
        assert.equal(result.isEdged, true);
    });

    it('classic crawls then stall-halts', () => {
        const crawl = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: true,
            stallGuardEnabled: true
        });
        const halt = calculateEngineOutputs({
            ...running,
            activeMode: 'classic',
            hr: 140,
            isEdged: true,
            stallGuardEnabled: true,
            stallGuardEngaged: true
        });
        assert.equal(crawl.primaryPercent, 12);
        assert.equal(halt.primaryPercent, 0);
        assert.equal(halt.secondaryPercent, 0);
    });

    it('shortener contracts the envelope toward the base', () => {
        const result = calculateEngineOutputs({ ...running, activeMode: 'shortener', hr: 120 });
        assert.ok(result.strokeMaxPercent < 100);
        assert.equal(result.strokeMinPercent, 0);
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
