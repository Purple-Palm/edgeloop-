import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCommand, sanitizeTelemetry, HISTORY_LENGTH } from './peer-messages.js';

describe('sanitizeCommand', () => {
    it('accepts the transport, orgasm and mode commands the controller UI exposes', () => {
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING' }), { type: 'SESSION_STATE', status: 'RUNNING' });
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_STATE', status: 'PAUSED' }), { type: 'SESSION_STATE', status: 'PAUSED' });
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_STATE', status: 'IDLE' }), { type: 'SESSION_STATE', status: 'IDLE' });
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_RESET' }), { type: 'SESSION_RESET' });
        assert.deepEqual(sanitizeCommand({ type: 'ORGASM_TOGGLE' }), { type: 'ORGASM_TOGGLE' });
        assert.deepEqual(sanitizeCommand({ type: 'MODE_CHANGE', mode: 'milker' }), { type: 'MODE_CHANGE', mode: 'milker' });
    });

    it('strips every extra field so raw limits or speeds never reach the host', () => {
        const cmd = sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING', maxHr: 999, chosenSeconds: -1, speed: 100 });
        assert.deepEqual(cmd, { type: 'SESSION_STATE', status: 'RUNNING' });
    });

    it('rejects unknown types, unknown statuses, unknown modes and garbage', () => {
        assert.equal(sanitizeCommand({ type: 'SET_LIMITS', maxHr: 200 }), null);
        assert.equal(sanitizeCommand({ type: 'SESSION_STATE', status: 'RAMPDOWN' }), null);
        assert.equal(sanitizeCommand({ type: 'SESSION_STATE' }), null);
        assert.equal(sanitizeCommand({ type: 'MODE_CHANGE', mode: '<script>' }), null);
        assert.equal(sanitizeCommand({ type: 42 }), null);
        assert.equal(sanitizeCommand('SESSION_RESET'), null);
        assert.equal(sanitizeCommand(null), null);
        assert.equal(sanitizeCommand([]), null);
    });

    it('lets a viewer ping but never command', () => {
        assert.deepEqual(sanitizeCommand({ type: 'PING' }, 'viewer'), { type: 'PING' });
        assert.equal(sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING' }, 'viewer'), null);
        assert.equal(sanitizeCommand({ type: 'ORGASM_TOGGLE' }, 'viewer'), null);
        assert.equal(sanitizeCommand({ type: 'SESSION_RESET' }, 'viewer'), null);
    });
});

describe('sanitizeTelemetry', () => {
    it('returns null for anything that is not telemetry', () => {
        assert.equal(sanitizeTelemetry({ type: 'SESSION_STATE', status: 'RUNNING' }), null);
        assert.equal(sanitizeTelemetry(null), null);
        assert.equal(sanitizeTelemetry('TELEMETRY'), null);
    });

    it('coerces numeric strings and clamps every number', () => {
        const t = sanitizeTelemetry({
            type: 'TELEMETRY',
            hr: '132',
            seconds: -5,
            chosenTargetSeconds: 1e12,
            edges: '3',
            pauses: 2.6,
            strokerSpeed: 250,
            prostateSpeed: -10,
            minHr: 10,
            maxHr: '150'
        });
        assert.equal(t.hr, 132);
        assert.equal(t.seconds, 0);
        assert.equal(t.chosenTargetSeconds, 48 * 3600);
        assert.equal(t.edges, 3);
        assert.equal(t.pauses, 3);
        assert.equal(t.strokerSpeed, 100);
        assert.equal(t.prostateSpeed, 0);
        assert.equal(t.minHr, 30);
        assert.equal(t.maxHr, 150);
    });

    it('leaves invalid or missing fields undefined instead of zeroing them', () => {
        const t = sanitizeTelemetry({ type: 'TELEMETRY', hr: 'abc', seconds: NaN, sessionStatus: 'EXPLODED', activeMode: 'ghost', orgasmMode: 'yes', ready: 1 });
        assert.equal(t.hr, undefined);
        assert.equal(t.seconds, undefined);
        assert.equal(t.sessionStatus, undefined);
        assert.equal(t.activeMode, undefined);
        assert.equal(t.orgasmMode, undefined);
        assert.equal(t.ready, undefined);
        assert.equal(t.history, undefined);
        assert.equal(t.hrSignal, undefined);
    });

    it('accepts known statuses, modes and booleans', () => {
        const t = sanitizeTelemetry({ type: 'TELEMETRY', sessionStatus: 'RAMPDOWN', activeMode: 'oracle', orgasmMode: true, ready: false });
        assert.equal(t.sessionStatus, 'RAMPDOWN');
        assert.equal(t.activeMode, 'oracle');
        assert.equal(t.orgasmMode, true);
        assert.equal(t.ready, false);
    });

    it('cleans the history and keeps only the newest 60 samples', () => {
        const history = Array.from({ length: 80 }, (_, i) => i);
        history.push('bad', null, 999, -4);
        const t = sanitizeTelemetry({ type: 'TELEMETRY', history });
        assert.equal(t.history.length, HISTORY_LENGTH);
        assert.ok(t.history.every((v) => Number.isFinite(v) && v >= 0 && v <= 250));
        assert.equal(t.history[t.history.length - 1], 0);
        assert.equal(t.history[t.history.length - 2], 250);
    });

    it('normalises the watchdog block', () => {
        const t = sanitizeTelemetry({ type: 'TELEMETRY', hrSignal: { status: 'weird', noContact: 1, silentMs: '2500' } });
        assert.deepEqual(t.hrSignal, { status: 'ok', noContact: true, silentMs: 2500 });
        const stale = sanitizeTelemetry({ type: 'TELEMETRY', hrSignal: { status: 'stale' } });
        assert.deepEqual(stale.hrSignal, { status: 'stale', noContact: false, silentMs: 0 });
    });
});
