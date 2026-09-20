import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    createStrokePlanner,
    legDurationMs,
    normalizePlannerInput,
    FAST_LEG_MS,
    SLOW_LEG_MS,
    MIN_LEG_MS,
    REST_MOVE_MS
} from './stroke-planner.js';

describe('legDurationMs', () => {
    it('maps 100 % to the fast leg and 0 % to the slow leg over full travel', () => {
        assert.equal(legDurationMs(100, 1), FAST_LEG_MS);
        assert.equal(legDurationMs(0, 1), SLOW_LEG_MS);
        assert.equal(legDurationMs(50, 1), Math.round(FAST_LEG_MS + 0.5 * (SLOW_LEG_MS - FAST_LEG_MS)));
    });
    it('scales with travel and never drops below the minimum', () => {
        assert.equal(legDurationMs(0, 0.5), SLOW_LEG_MS / 2);
        assert.equal(legDurationMs(100, 0.1), MIN_LEG_MS);
        assert.equal(legDurationMs(100, 0), MIN_LEG_MS);
    });
    it('tolerates garbage', () => {
        // speed 0 over the minimum travel of 8 %: 2200 * 0.08
        assert.equal(legDurationMs('abc', NaN), 176);
        assert.equal(legDurationMs(500, 5), FAST_LEG_MS);
    });
});

describe('normalizePlannerInput', () => {
    it('clamps and orders the zone, scales speed by cap', () => {
        const n = normalizePlannerInput({ speed: 80, zoneMin: 0.9, zoneMax: 0.2, cap: 50 });
        assert.equal(n.zoneMin, 0.9);
        assert.equal(n.zoneMax, 0.9);
        assert.equal(n.effectiveSpeed, 40);
        assert.equal(n.enabled, true);
    });
    it('falls back on garbage', () => {
        const n = normalizePlannerInput({ speed: 'x', zoneMin: null, zoneMax: 'y', cap: undefined, enabled: false });
        assert.deepEqual([n.speed, n.zoneMin, n.zoneMax, n.cap, n.enabled], [0, 0, 1, 100, false]);
    });
});

describe('stroke planner', () => {
    it('alternates between zone max and zone min, one leg per call', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 100, zoneMin: 0.2, zoneMax: 0.8 });
        const a = p.next(1000);
        assert.deepEqual(a, { position: 0.8, durationMs: legDurationMs(100, 0.6), kind: 'stroke' });
        assert.equal(p.isInFlight(1000 + a.durationMs - 1), true);
        assert.equal(p.legEndsAt(), 1000 + a.durationMs);
        const b = p.next(1000 + a.durationMs);
        assert.equal(b.position, 0.2);
        const c = p.next(1000 + a.durationMs + b.durationMs);
        assert.equal(c.position, 0.8);
    });

    it('never re-sends while a leg is in flight', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 30, zoneMin: 0, zoneMax: 1 });
        const a = p.next(0);
        assert.ok(a);
        for (let t = 1; t < a.durationMs; t += 50) {
            assert.equal(p.next(t), null, `re-sent at t=${t}`);
        }
        assert.ok(p.next(a.durationMs));
    });

    it('applies speed and zone changes to the next leg only', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 100, zoneMin: 0.2, zoneMax: 0.8 });
        const a = p.next(0);
        p.setInput({ speed: 10, zoneMin: 0.4, zoneMax: 0.6 });
        assert.equal(p.next(10), null);
        assert.equal(p.legEndsAt(), a.durationMs);
        const b = p.next(a.durationMs);
        assert.equal(b.position, 0.4);
        assert.equal(b.durationMs, legDurationMs(10, 0.2));
    });

    it('issues a single rest move on speed 0 and then stays silent', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 100, zoneMin: 0.2, zoneMax: 0.8 });
        const a = p.next(0);
        p.setInput({ speed: 0 });
        // Still in flight: the running stroke is not snapped.
        assert.equal(p.next(a.durationMs - 1), null);
        const rest = p.next(a.durationMs);
        assert.deepEqual(rest, { position: 0.2, durationMs: REST_MOVE_MS, kind: 'rest' });
        assert.equal(p.isResting(), true);
        assert.equal(p.next(a.durationMs + REST_MOVE_MS), null);
        assert.equal(p.next(a.durationMs + REST_MOVE_MS + 5000), null);
        // Speed returns: the first stroke goes up from the rest position.
        p.setInput({ speed: 50 });
        const up = p.next(a.durationMs + REST_MOVE_MS + 6000);
        assert.equal(up.position, 0.8);
        assert.equal(p.isResting(), false);
    });

    it('treats role OFF (enabled: false) like speed 0', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 100, zoneMin: 0.1, zoneMax: 0.9, enabled: false });
        const rest = p.next(0);
        assert.equal(rest.kind, 'rest');
        assert.equal(rest.position, 0.1);
        assert.equal(p.next(REST_MOVE_MS), null);
    });

    it('a rest move is sent even when the axis is idle at start', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 0, zoneMin: 0.3, zoneMax: 0.7 });
        assert.equal(p.next(0).position, 0.3);
        assert.equal(p.next(REST_MOVE_MS), null);
    });

    it('scales the speed by the cap', () => {
        const capped = createStrokePlanner();
        capped.setInput({ speed: 100, cap: 50, zoneMin: 0, zoneMax: 1 });
        const plain = createStrokePlanner();
        plain.setInput({ speed: 50, cap: 100, zoneMin: 0, zoneMax: 1 });
        const cappedLeg = capped.next(0);
        assert.equal(cappedLeg.durationMs, plain.next(0).durationMs);
        assert.equal(cappedLeg.durationMs > legDurationMs(100, 1), true);
    });

    it('cap 0 rests the axis', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 100, cap: 0, zoneMin: 0.2, zoneMax: 0.8 });
        assert.equal(p.next(0).kind, 'rest');
    });

    it('reset forgets the in-flight leg and re-issues a rest move', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 0, zoneMin: 0.2, zoneMax: 0.8 });
        assert.equal(p.next(0).kind, 'rest');
        assert.equal(p.next(REST_MOVE_MS), null);
        p.reset();
        assert.equal(p.next(REST_MOVE_MS).kind, 'rest');
    });
});
