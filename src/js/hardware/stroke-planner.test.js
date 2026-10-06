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
import { calculateEngineOutputs, TEASE_MODES } from '../engine.js';

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
        // The sleeve sits at 0.8 after leg a: the move to 0.4 covers 0.4, not
        // the new zone's 0.2, and is timed for what it really travels.
        assert.equal(b.durationMs, legDurationMs(10, 0.4));
        const c = p.next(a.durationMs + b.durationMs);
        assert.equal(c.position, 0.6);
        assert.equal(c.durationMs, legDurationMs(10, 0.2));
    });

    it('a stop interrupts the leg in flight with a single rest move and then stays silent', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 10, zoneMin: 0.2, zoneMax: 0.8 });
        const a = p.next(0);
        assert.ok(a.durationMs > 1000, 'a crawl leg is long');
        // A stall guard, Full Stop or the Ruin lockout cuts the speed to 0
        // early in it: the sleeve rests now, not after the leg.
        p.setInput({ speed: 0 });
        const rest = p.next(100);
        assert.deepEqual(rest, { position: 0.2, durationMs: REST_MOVE_MS, kind: 'rest' });
        assert.equal(p.isResting(), true);
        assert.equal(p.next(100 + REST_MOVE_MS), null);
        assert.equal(p.next(a.durationMs), null, 'the interrupted leg is gone');
        assert.equal(p.next(a.durationMs + 5000), null);
        // Speed returns: the first stroke goes up from the rest position.
        p.setInput({ speed: 50 });
        const up = p.next(a.durationMs + 6000);
        assert.equal(up.position, 0.8);
        assert.equal(p.isResting(), false);
    });

    it('a cap of 0 is a stop and interrupts the leg too', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 40, cap: 100, zoneMin: 0, zoneMax: 1 });
        p.next(0);
        p.setInput({ cap: 0 });
        assert.equal(p.next(50).kind, 'rest');
    });

    it('a slowdown that is not a stop waits for the leg in flight', () => {
        // Speed changes apply to the next leg: the Ruin lockout lowering the
        // secondary, or a pattern easing off, never cuts a stroke short.
        const p = createStrokePlanner();
        p.setInput({ speed: 60, zoneMin: 0, zoneMax: 1 });
        const a = p.next(0);
        p.setInput({ speed: 1 });
        assert.equal(p.next(a.durationMs - 1), null);
        const b = p.next(a.durationMs);
        assert.equal(b.kind, 'stroke');
        assert.equal(b.durationMs, legDurationMs(1, 1));
    });

    it('an urgent decision re-times the rest of the leg in flight, to the same end', () => {
        // A stroker on the secondary channel when the Ruin lockout begins:
        // the ride's 46% drops to 18%, a quarter of the way into an upstroke.
        const p = createStrokePlanner();
        p.setInput({ speed: 46, zoneMin: 0.05, zoneMax: 0.69 });
        const a = p.next(0);
        assert.deepEqual(a, { position: 0.69, durationMs: legDurationMs(46, 0.64), kind: 'stroke' });
        const at = Math.round(a.durationMs / 4);
        p.setInput({ speed: 18, zoneMin: 0, zoneMax: 1 });
        const left = (a.durationMs - at) / a.durationMs;
        const r = p.retime(at);
        assert.deepEqual(r, { position: 0.69, durationMs: Math.round(left * legDurationMs(18, 0.64)), kind: 'stroke' });
        assert.ok(r.durationMs > a.durationMs - at, 'the rest of the stroke is slower, not cut short');
        assert.equal(p.legEndsAt(), at + r.durationMs);
        assert.equal(p.next(at + r.durationMs - 1), null, 'nothing more until it ends');
        // Then the strokes carry on at the new speed, in the new zone.
        const b = p.next(at + r.durationMs);
        assert.deepEqual(b, { position: 0, durationMs: legDurationMs(18, 1), kind: 'stroke' });
        assert.equal(p.next(at + r.durationMs + b.durationMs).position, 1);
    });

    it('a second urgent decision re-times what is left of a re-timed leg', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 60, zoneMin: 0, zoneMax: 1 });
        const a = p.next(0);
        const half = Math.round(a.durationMs / 2);
        p.setInput({ speed: 20 });
        const r1 = p.retime(half);
        const share1 = (a.durationMs - half) / a.durationMs;
        assert.equal(r1.durationMs, Math.round(share1 * legDurationMs(20, 1)));
        const at = half + Math.round(r1.durationMs / 2);
        p.setInput({ speed: 80 });
        const share2 = share1 * ((half + r1.durationMs - at) / r1.durationMs);
        assert.deepEqual(p.retime(at), { position: 1, durationMs: Math.round(share2 * legDurationMs(80, 1)), kind: 'stroke' });
    });

    it('re-times a leg by the travel it was sized for', () => {
        // The first leg after a rest crosses more than the zone: what is left
        // of it is timed over that longer way at the new speed, not over the
        // zone's width.
        const p = createStrokePlanner();
        p.setInput({ speed: 0, zoneMin: 0, zoneMax: 1 });
        p.next(0);
        p.setInput({ speed: 50, zoneMin: 0.6, zoneMax: 0.8 });
        const leg = p.next(REST_MOVE_MS);
        assert.equal(leg.durationMs, legDurationMs(50, 0.8));
        p.setInput({ speed: 25 });
        const r = p.retime(REST_MOVE_MS);
        assert.deepEqual(r, { position: 0.8, durationMs: legDurationMs(25, 0.8), kind: 'stroke' });
    });

    it('re-times a leg over the travel the driver says it covers, when that is more', () => {
        // The invert switch flipped at a leg's end: the next leg, sized for a
        // 0.2 zone, takes the sleeve 0.8 of the travel on the device. What is
        // left of it is timed over that 0.8 at the new speed; over the 0.2 it
        // would be the 120 ms floor, three times the planner's pace.
        const p = createStrokePlanner();
        p.setInput({ speed: 10, zoneMin: 0, zoneMax: 0.2 });
        const a = p.next(0);
        assert.equal(a.durationMs, legDurationMs(10, 0.2));
        p.setInput({ speed: 80 });
        const at = Math.round(a.durationMs / 4);
        const share1 = (a.durationMs - at) / a.durationMs;
        const r1 = p.retime(at, { travel: 0.8 });
        assert.deepEqual(r1, { position: 0.2, durationMs: Math.round(share1 * legDurationMs(80, 0.8)), kind: 'stroke' });
        assert.ok(r1.durationMs > 2 * MIN_LEG_MS);
        // A second decision in the same leg keeps timing it over the 0.8.
        p.setInput({ speed: 40 });
        const at2 = at + Math.round(r1.durationMs / 2);
        const share2 = share1 * ((at + r1.durationMs - at2) / r1.durationMs);
        assert.equal(p.retime(at2).durationMs, Math.round(share2 * legDurationMs(40, 0.8)));
    });

    it('never re-times a leg over less travel than it was sized for', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 10, zoneMin: 0, zoneMax: 1 });
        const a = p.next(0);
        p.setInput({ speed: 80 });
        const at = Math.round(a.durationMs / 2);
        const share = (a.durationMs - at) / a.durationMs;
        assert.equal(p.retime(at, { travel: 0.1 }).durationMs, Math.round(share * legDurationMs(80, 1)));
    });

    it('has nothing to re-time unless a stroke at another speed is in flight', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 40, zoneMin: 0, zoneMax: 1 });
        assert.equal(p.retime(0), null, 'nothing sent yet');
        const a = p.next(0);
        assert.equal(p.retime(100), null, 'the leg already has this speed');
        p.setInput({ speed: 40, zoneMin: 0.2, zoneMax: 0.6 });
        assert.equal(p.retime(150), null, 'a zone change still waits for the next leg');
        p.setInput({ speed: 10 });
        assert.equal(p.retime(a.durationMs - MIN_LEG_MS + 1), null, 'a leg about to end is left to end');
        assert.equal(p.retime(a.durationMs), null, 'the leg has ended');
        // A stop is not re-timed: it interrupts the leg, and next() rests.
        p.next(a.durationMs);
        p.setInput({ speed: 0 });
        assert.equal(p.retime(a.durationMs + 50), null);
        assert.equal(p.next(a.durationMs + 50).kind, 'rest');
        // Nor is the rest move.
        p.setInput({ speed: 30 });
        assert.equal(p.retime(a.durationMs + 100), null);
        // After a reset there is no leg to re-time.
        p.next(a.durationMs + 50 + REST_MOVE_MS);
        p.reset();
        p.setInput({ speed: 70 });
        assert.equal(p.retime(a.durationMs + 50 + REST_MOVE_MS + 10), null);
    });

    it('a stop while already resting sends nothing more', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 0, zoneMin: 0.1, zoneMax: 0.9 });
        assert.equal(p.next(0).kind, 'rest');
        p.setInput({ speed: 0, enabled: false });
        assert.equal(p.next(10), null, 'the rest move in flight is not re-sent');
        assert.equal(p.next(REST_MOVE_MS + 10), null);
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
    it('sizes the first leg after a rest or zone shift by the distance really travelled', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 0, zoneMin: 0, zoneMax: 1 });
        assert.equal(p.next(0).position, 0, 'resting at the envelope bottom');
        p.setInput({ speed: 100, zoneMin: 0.6, zoneMax: 0.8 });
        const leg = p.next(REST_MOVE_MS);
        assert.equal(leg.position, 0.8);
        assert.equal(leg.durationMs, legDurationMs(100, 0.8), 'an 80 % move is not timed like a 20 % zone');
        const back = p.next(REST_MOVE_MS + leg.durationMs);
        assert.equal(back.position, 0.6);
        assert.equal(back.durationMs, legDurationMs(100, 0.2));
    });

    it('role OFF interrupts the leg in flight with an immediate rest move', () => {
        const p = createStrokePlanner();
        p.setInput({ speed: 5, zoneMin: 0, zoneMax: 1 });
        const leg = p.next(0);
        assert.ok(leg.durationMs > 2000);
        p.setInput({ enabled: false });
        const rest = p.next(100);
        assert.deepEqual(rest, { position: 0, durationMs: REST_MOVE_MS, kind: 'rest' });
        assert.equal(p.next(200), null);
        // Speed 0 (a guard, STOP, a pause) is a stop the same way.
        p.setInput({ speed: 5, enabled: true });
        const again = p.next(100 + REST_MOVE_MS);
        assert.equal(again.kind, 'stroke');
        p.setInput({ speed: 0 });
        assert.deepEqual(p.next(100 + REST_MOVE_MS + 50), { position: 0, durationMs: REST_MOVE_MS, kind: 'rest' });
    });

    it('legTravel times the leg by speed alone so a small swing is a slow swing', () => {
        const slow = createStrokePlanner();
        slow.setInput({ speed: 10, zoneMin: 0.45, zoneMax: 0.55, legTravel: 1 });
        const fast = createStrokePlanner();
        fast.setInput({ speed: 50, zoneMin: 0.25, zoneMax: 0.75, legTravel: 1 });
        const a = slow.next(0).durationMs;
        const b = fast.next(0).durationMs;
        assert.equal(a, legDurationMs(10, 1));
        assert.equal(b, legDurationMs(50, 1));
        assert.ok(a > b, 'the period falls as the speed rises');
    });
});

describe('what a running session hands the planner', () => {
    // The T-Code stroke axis and every Intiface linear axis run on this
    // planner, and a speed of 0 parks the sleeve at the bottom of the zone.
    // Release 1.1.0's near-stop rounded to 0 in the upper band and all
    // through the warm-up, so those axes dropped to the bottom and started
    // over several times a minute. Since 1.1.1 the dip waits for the last
    // stretch before the mark, and 1.1.2 rounded it to 0 there: at 139 BPM
    // on this 70-140 band, in the band and in a warm-up held there. The
    // engine now hands them a crawl, which is the planner's slowest leg.
    function drive(planner, segment) {
        const kinds = [];
        let timerAt = null;
        // One pump, the way the drivers pump: a leg when none is in flight,
        // and a timer at its end that asks again.
        const pump = (at) => {
            const leg = planner.next(at);
            if (!leg) return;
            kinds.push(leg.kind);
            timerAt = at + leg.durationMs;
        };
        for (let i = 0; i < segment.ticks; i++) {
            const tickAt = segment.startMs + i * 1000;
            while (timerAt !== null && timerAt <= tickAt) {
                const at = timerAt;
                timerAt = null;
                pump(Math.max(at, planner.legEndsAt()));
            }
            const out = calculateEngineOutputs({
                hr: segment.hr,
                edgeHr: segment.hr,
                minHr: 70,
                maxHr: 140,
                activeMode: segment.mode,
                sessionStatus: 'RUNNING',
                isEdged: false,
                orgasmMode: false,
                warmupMinutes: segment.warmupMinutes,
                ceilingBehaviour: 'crawl',
                sessionSeconds: segment.fromSecond + i
            });
            planner.setInput({
                speed: out.primaryPercent,
                cap: 100,
                zoneMin: out.strokeMinPercent / 100,
                zoneMax: out.strokeMaxPercent / 100,
                enabled: true
            });
            pump(tickAt);
        }
        return kinds;
    }

    it('keeps a linear axis stroking through every pattern near-stop instead of parking it', () => {
        for (const mode of TEASE_MODES) {
            const planner = createStrokePlanner();
            const kinds = [
                // The default warm-up, held at the last BPM before the mark.
                ...drive(planner, { mode, hr: 139, warmupMinutes: 5, fromSecond: 0, ticks: 300, startMs: 0 }),
                // The same pulse once the warm-up is over.
                ...drive(planner, { mode, hr: 139, warmupMinutes: 0, fromSecond: 600, ticks: 600, startMs: 300000 })
            ];
            assert.equal(kinds.filter((k) => k === 'rest').length, 0, `${mode} parked the sleeve mid-session`);
            assert.ok(kinds.length > 300, `${mode} barely stroked: ${kinds.length} legs`);
        }
    });
});

describe('a holding planner (an OSSM in position mode)', () => {
    it('answers a stop with one hold and silence, never a rest move', () => {
        const p = createStrokePlanner({ hold: true });
        p.setInput({ speed: 50, zoneMin: 0.3, zoneMax: 0.7 });
        const leg = p.next(0);
        assert.equal(leg.kind, 'stroke');
        p.setInput({ speed: 0 });
        assert.deepEqual(p.next(10), { position: null, durationMs: 0, kind: 'hold' });
        assert.equal(p.isInFlight(10), false);
        assert.equal(p.next(20), null);
        assert.equal(p.next(5000), null);
        p.setInput({ enabled: false });
        assert.equal(p.next(6000), null);
    });

    it('starts again from where it was placed, toward the farther end, sized by that distance', () => {
        const p = createStrokePlanner({ hold: true });
        p.setInput({ speed: 50, zoneMin: 0.3, zoneMax: 0.7 });
        p.next(0);
        p.setInput({ speed: 0 });
        p.next(10);
        p.place(0.62);
        p.setInput({ speed: 50 });
        const first = p.next(20);
        assert.equal(first.position, 0.3, '0.3 is farther from 0.62 than 0.7');
        assert.equal(first.durationMs, legDurationMs(50, 0.4));
        p.place(0.35);
        p.setInput({ speed: 0 });
        p.next(first.durationMs + 20);
        p.setInput({ speed: 50 });
        assert.equal(p.next(first.durationMs + 30).position, 0.7);
    });

    it('sizes a first leg from nowhere it knows for the farthest end of the travel', () => {
        const p = createStrokePlanner({ hold: true });
        p.setInput({ speed: 50, zoneMin: 0.3, zoneMax: 0.7 });
        assert.equal(p.next(0).durationMs, legDurationMs(50, 0.7));
        const plain = createStrokePlanner();
        plain.setInput({ speed: 50, zoneMin: 0.3, zoneMax: 0.7 });
        assert.equal(plain.next(0).durationMs, legDurationMs(50, 0.4), 'the resting planner keeps its zone-width first leg');
    });
});
