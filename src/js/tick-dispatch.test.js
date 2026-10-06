import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTickDispatch, guardEngagedBy } from './tick-dispatch.js';
import { calculateEngineOutputs } from './engine.js';
import { tickRuinAndStallGuard, startRuinEdge, tickForceOrgasm, ORGASM_BOOST_CAP } from './session-rules.js';
import { RUIN_LOCK_SECONDARY, RUIN_LOCK_SECONDS } from './patterns.js';

const STOP = [0, 0, 0, 100];
const moving = (primary, secondary = 40) => [primary, secondary, 0, 100];

// app.js dispatchHardware, reduced to what reaches the toys: every dispatch
// asks the gate, and what the gate releases is sent at once, in order, with
// whether it went out forced or urgent.
function wire(gate) {
    const sent = [];
    const dispatch = (decision, { force = false, urgent = false } = {}) => {
        const release = gate.admit(decision, { force, urgent });
        if (release) sent.push({ decision, force, urgent: release.urgent });
    };
    // The master clock's send: the tick's decision, urgent when a guard
    // engaged in it.
    const send = (decision, { urgent }) => dispatch(decision, { urgent });
    return { sent, dispatch, send };
}

describe('createTickDispatch', () => {
    it('holds nothing outside a tick: the caller sends at once', () => {
        const gate = createTickDispatch();
        assert.equal(gate.isRunning(), false);
        assert.deepEqual(gate.admit(moving(40)), { urgent: false });
    });

    it('sends the last decision of a tick, once, after everything the tick runs', () => {
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        const order = [];
        gate.run(() => {
            dispatch(moving(60));
            order.push('guards');
            assert.equal(sent.length, 0, 'nothing reaches the toys while the tick runs');
            dispatch(moving(0));
            order.push('watchdog');
        }, (decision, flags) => {
            order.push('send');
            send(decision, flags);
        });
        assert.deepEqual(sent.map((s) => s.decision), [moving(0)]);
        assert.deepEqual(order, ['guards', 'watchdog', 'send']);
        assert.equal(gate.isRunning(), false);
        dispatch(moving(30));
        assert.equal(sent.length, 2, 'a packet after the tick goes out at once');
    });

    it('sends nothing for a tick that decided nothing', () => {
        const gate = createTickDispatch();
        const { sent, send } = wire(gate);
        gate.run(() => {}, send);
        assert.deepEqual(sent, []);
    });

    it('never lets a decision made before a forced dispatch follow it', () => {
        // The watchdog or a game pauses the tick with a forced stop: the
        // motion the tick computed before it is dropped, not sent after it.
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        gate.run(() => {
            dispatch(moving(60));
            dispatch(STOP, { force: true });
            assert.equal(sent.length, 1, 'the stop goes out at once, inside the tick');
        }, send);
        assert.deepEqual(sent.map((s) => [s.decision, s.force]), [[STOP, true]]);
    });

    it('sends one stop per tick: the pause that follows the watchdog\'s stop adds nothing', () => {
        // evaluateHrWatchdog stops the toys, then triggerDisconnectAlert
        // pauses the session, and pauseSession stops them again; the page
        // wrote StopAllDevices and the T-Code rest line twice for it.
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        gate.run(() => {
            dispatch(moving(56));
            dispatch(STOP, { force: true });
            dispatch(STOP, { force: true });
            // The engine refreshed at the end of the tick: PAUSED, so both
            // channels 0 over the envelope - the same stop again.
            dispatch([0, 0, 5, 95]);
        }, send);
        assert.deepEqual(sent.map((s) => [s.decision, s.force]), [[STOP, true]]);
    });

    it('lets nothing through after a stop in the same tick, not even motion', () => {
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        gate.run(() => {
            dispatch(STOP, { force: true });
            dispatch(moving(50), { force: true });
            dispatch(moving(50));
        }, send);
        assert.deepEqual(sent.map((s) => s.decision), [STOP]);
        // The next tick starts afresh.
        gate.run(() => dispatch(moving(30)), send);
        assert.deepEqual(sent.map((s) => s.decision), [STOP, moving(30)]);
    });

    it('never swallows a stop behind a forced dispatch that was not one', () => {
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        gate.run(() => {
            dispatch(moving(50), { force: true });
            dispatch(STOP, { force: true });
        }, send);
        assert.deepEqual(sent.map((s) => s.decision), [moving(50), STOP]);
    });

    it('still sends what a tick decides after a forced dispatch that was not a stop', () => {
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        gate.run(() => {
            dispatch(moving(60));
            dispatch(moving(50), { force: true });
            dispatch(moving(45));
        }, send);
        assert.deepEqual(sent.map((s) => s.decision), [moving(50), moving(45)]);
    });

    it('never sends a decision twice in one tick', () => {
        // Only a forced dispatch goes out while a tick runs. One that carries
        // motion and repeats what the tick has sent is not sent again, and
        // neither is the decision the tick ends on when it is that same one:
        // the toys already have it.
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        gate.run(() => {
            dispatch(moving(50), { force: true });
            dispatch(moving(50), { force: true });
            dispatch(moving(50));
        }, send);
        assert.deepEqual(sent.map((s) => s.decision), [moving(50)]);
        // A different decision after it is still sent, once.
        gate.run(() => {
            dispatch(moving(50), { force: true });
            dispatch(moving(45));
            dispatch(moving(40));
        }, send);
        assert.deepEqual(sent.map((s) => s.decision), [moving(50), moving(50), moving(40)]);
    });

    it('sends every stop outside a tick: a wearer pressing STOP twice is heard twice', () => {
        const gate = createTickDispatch();
        const { sent, dispatch } = wire(gate);
        dispatch(STOP, { force: true });
        dispatch(STOP, { force: true });
        assert.equal(sent.length, 2);
        assert.ok(sent.every((s) => s.force));
    });

    it('sends the tick\'s decision urgent when a guard engaged in it, and only then', () => {
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        gate.run(() => {
            dispatch(moving(40, 51));
            gate.markUrgent();
            dispatch(moving(0, 18));
        }, send);
        gate.run(() => dispatch(moving(0, 18)), send);
        assert.deepEqual(sent.map((s) => s.urgent), [true, false]);
        // Outside a tick there is no tick to mark.
        gate.markUrgent();
        gate.run(() => dispatch(moving(0, 17)), send);
        assert.deepEqual(sent.map((s) => s.urgent), [true, false, false]);
    });

    it('holds an urgent dispatch made while a tick runs, and sends the decision the tick ends on urgent', () => {
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        gate.run(() => {
            dispatch(moving(0, 18), { urgent: true });
            assert.equal(sent.length, 0, 'held like any other');
            dispatch(moving(0, 20));
        }, send);
        assert.deepEqual(sent.map((s) => [s.decision[1], s.urgent]), [[20, true]]);
    });

    it('a guard engaging with the primary already at 0 still sends its tick urgent', () => {
        // The Ruin lockout can begin under a stall pause that already holds
        // the primary at 0; only the secondary moves, to 18%.
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        dispatch(moving(0, 46));
        gate.run(() => {
            dispatch(moving(0, 46));
            gate.markUrgent();
            dispatch(moving(0, 18));
        }, send);
        assert.deepEqual(sent.map((s) => [s.decision[1], s.urgent]), [[46, false], [18, true]]);
    });

    it('a dispatch that cuts a moving primary to 0 is urgent, in a tick or out of one', () => {
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        dispatch(moving(40));
        // Full Stop on the mark, decided on a heart-rate packet.
        dispatch(moving(0, 55));
        // Still 0: nothing new was cut.
        dispatch(moving(0, 60));
        dispatch(moving(12));
        // A cut decided in a tick.
        gate.run(() => dispatch(moving(0)), send);
        assert.deepEqual(sent.map((s) => s.urgent), [false, true, false, false, true]);
    });

    it('never makes a slowdown urgent, however deep, when it is not a stop', () => {
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        for (const primary of [80, 40, 12, 1, 1, 30]) dispatch(moving(primary));
        gate.run(() => {
            dispatch(moving(20));
            dispatch(moving(1));
        }, send);
        assert.ok(sent.every((s) => !s.urgent));
    });

    it('judges a cut against what the toys were sent, not what a tick held and replaced', () => {
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        dispatch(moving(0));
        gate.run(() => {
            dispatch(moving(0));
            dispatch(moving(30));
        }, send);
        dispatch(moving(0));
        assert.deepEqual(sent.map((s) => [s.decision[0], s.urgent]), [[0, false], [30, false], [0, true]]);
    });

    it('a forced dispatch is urgent, and a stop leaves nothing to cut after it', () => {
        // Forced reaches every toy at once in any case; the silence the
        // engine computes after the stop is no cut of its own.
        const gate = createTickDispatch();
        const { sent, dispatch } = wire(gate);
        dispatch(moving(50));
        dispatch(STOP, { force: true });
        dispatch([0, 0, 5, 95]);
        assert.deepEqual(sent.map((s) => s.urgent), [false, true, false]);
    });

    it('a tick that throws still sends its newest decision and releases the hold', () => {
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        assert.throws(() => gate.run(() => {
            dispatch(moving(33));
            throw new Error('a guard failed');
        }, send), /a guard failed/);
        assert.deepEqual(sent.map((s) => s.decision), [moving(33)]);
        assert.equal(gate.isRunning(), false);
        // The packets after it are sent as they arrive, not held forever.
        dispatch(moving(34));
        assert.equal(sent.length, 2);
    });

    it('each tick starts empty', () => {
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        gate.run(() => {
            dispatch(moving(20));
            gate.markUrgent();
        }, send);
        gate.run(() => {}, send);
        gate.run(() => {
            dispatch(moving(25), { force: true });
            dispatch(STOP, { force: true });
        }, send);
        // Neither the urgency, the stop nor the forced 25% of the ticks
        // before holds back the 25% this one ends on.
        gate.run(() => dispatch(moving(25)), send);
        assert.deepEqual(sent.map((s) => [s.decision[0], s.force, s.urgent]), [[20, false, true], [25, true, true], [0, true, true], [25, false, false]]);
    });

    it('a tick run inside a tick is part of it and sends nothing of its own', () => {
        const gate = createTickDispatch();
        const { sent, dispatch, send } = wire(gate);
        gate.run(() => {
            dispatch(moving(10));
            gate.run(() => { dispatch(moving(11)); }, send);
            assert.equal(sent.length, 0);
            assert.equal(gate.isRunning(), true);
        }, send);
        assert.deepEqual(sent.map((s) => s.decision), [moving(11)]);
    });

    it('returns what the tick returns', () => {
        const gate = createTickDispatch();
        assert.equal(gate.run(() => 7, () => {}), 7);
    });
});

describe('guardEngagedBy', () => {
    const noGuard = { holdSeconds: 0, pauseSeconds: 0, engaged: false };

    it('is true on the second the stall guard engages', () => {
        const step = tickRuinAndStallGuard({ guard: { holdSeconds: 2 } }, {
            activeMode: 'classic', isEdged: true, stallGuard: true, ceilingBehaviour: 'crawl', holdTimeoutSeconds: 3
        });
        assert.equal(step.guard.justEngaged, true);
        assert.equal(guardEngagedBy(step, {}), true);
        const held = tickRuinAndStallGuard({ guard: step.guard }, {
            activeMode: 'classic', isEdged: true, stallGuard: true, ceilingBehaviour: 'crawl', holdTimeoutSeconds: 3
        });
        assert.equal(guardEngagedBy(held, {}), false, 'not on the seconds of the pause after it');
    });

    it('is true on the second the Ruin lockout begins, and not while it runs', () => {
        const ruin = { rideSeconds: 11, lockSeconds: 0, spent: false };
        const step = tickRuinAndStallGuard({ ruin, guard: noGuard }, { activeMode: 'ruin', isEdged: true });
        assert.equal(step.ruin.lockSeconds, RUIN_LOCK_SECONDS);
        assert.equal(guardEngagedBy(step, ruin), true);
        const next = tickRuinAndStallGuard({ ruin: step.ruin, guard: noGuard }, { activeMode: 'ruin', isEdged: true });
        assert.equal(guardEngagedBy(next, step.ruin), false);
    });

    it('is false for a second in which no guard engaged', () => {
        const ruin = { rideSeconds: 3, lockSeconds: 0, spent: false };
        const step = tickRuinAndStallGuard({ ruin, guard: noGuard }, { activeMode: 'ruin', isEdged: true });
        assert.equal(guardEngagedBy(step, ruin), false);
        assert.equal(guardEngagedBy(undefined, undefined), false);
    });
});

// The master clock of app.js, reduced to what decides motion, with the real
// engine and the real guards: each tick refreshes the engine so the guards
// judge this second's edge flag, runs the guards (and marks the tick when one
// engages, as tickSessionGuardsAndGames does), then the watchdog, and runs
// the engine again at its end. Each second a heart-rate packet lands shortly
// before the tick and runs the engine too, outside any tick. `watchdogAt`:
// the second the watchdog finds the pulse lost - it stops the toys and
// pauses the session, and the pause stops them again, as
// evaluateHrWatchdog and triggerDisconnectAlert do. `sent` is every decision
// that reached the toys, with the second and the task it went out in.
function masterClock({ mode, ceilingBehaviour = 'crawl', stallGuard = false, pauseTimeoutSeconds = 8, watchdogAt = null, gate = createTickDispatch() }) {
    const sent = [];
    const s = {
        second: 0,
        task: 'packet',
        status: 'RUNNING',
        isEdged: false,
        ruin: { rideSeconds: 0, lockSeconds: 0, spent: false },
        guard: { holdSeconds: 0, pauseSeconds: 0, engaged: false }
    };
    const dispatch = (decision, { force = false, urgent = false } = {}) => {
        const release = gate.admit(decision, { force, urgent });
        if (release) sent.push({ second: s.second, task: s.task, primary: decision[0], secondary: decision[1], force, urgent: release.urgent });
    };
    const updateEngine = (hr) => {
        const out = calculateEngineOutputs({
            hr,
            edgeHr: hr,
            minHr: 70,
            maxHr: 140,
            activeMode: mode,
            sessionStatus: s.status,
            isEdged: s.isEdged,
            orgasmMode: false,
            warmupMinutes: 0,
            ceilingBehaviour,
            stallGuardEngaged: s.guard.engaged,
            ruinHoldSeconds: s.ruin.lockSeconds,
            ruinSpent: s.ruin.spent,
            sessionSeconds: s.second
        });
        // As app.js does: a new edge's Ruin ride starts with the pullback,
        // on the first reading at the mark.
        if (out.pullbackStarted) s.ruin = startRuinEdge(s.ruin);
        s.isEdged = out.isEdged;
        dispatch([out.primaryPercent, out.secondaryPercent, out.strokeMinPercent, out.strokeMaxPercent]);
    };
    const tick = (hr) => gate.run(() => {
        s.task = 'tick';
        if (s.status === 'RUNNING') {
            updateEngine(hr);
            const ruinBefore = s.ruin;
            const step = tickRuinAndStallGuard({ ruin: s.ruin, guard: s.guard }, {
                activeMode: mode,
                isEdged: s.isEdged,
                orgasmMode: false,
                stallGuard,
                ceilingBehaviour,
                holdTimeoutSeconds: 3,
                pauseTimeoutSeconds
            });
            s.ruin = step.ruin;
            s.guard = step.guard;
            if (guardEngagedBy(step, ruinBefore)) gate.markUrgent();
        }
        if (s.status === 'RUNNING' && s.second === watchdogAt) {
            dispatch([0, 0, 0, 100], { force: true });
            s.status = 'PAUSED';
            dispatch([0, 0, 0, 100], { force: true });
        }
        updateEngine(hr);
    }, (decision, { urgent }) => dispatch(decision, { urgent }));
    // One second: the packet `hr`, then the tick.
    const run = (seconds, hr) => {
        for (let i = 0; i < seconds; i++) {
            s.second += 1;
            s.task = 'packet';
            updateEngine(hr);
            tick(hr);
        }
    };
    return { run, sent, s };
}

const inSecond = (sent, second) => sent.filter((d) => d.second === second);

describe('the master clock sends what its guards decide, in the second they decide it', () => {
    it('a stall guard cut goes out on its tick, urgent, as the only decision of that tick', () => {
        const clock = masterClock({ mode: 'classic', ceilingBehaviour: 'crawl', stallGuard: true });
        clock.run(5, 100);
        clock.run(8, 145);
        const engagedAt = 5 + 3;
        const decisions = inSecond(clock.sent, engagedAt);
        // The packet before the tick went out at once (crawl on the mark);
        // the tick itself sent one decision: the cut.
        assert.deepEqual(decisions.map((d) => [d.task, d.primary, d.urgent]), [['packet', 10, false], ['tick', 0, true]]);
        assert.ok(clock.s.guard.engaged);
        assert.ok(clock.sent.filter((d) => d.second > engagedAt).every((d) => !d.urgent), 'the pause after it is not urgent');
    });

    it('the Ruin lockout goes out on its tick, urgent, and the ride speed it cut never does', () => {
        const clock = masterClock({ mode: 'ruin' });
        clock.run(5, 100);
        clock.run(15, 145);
        const lockAt = clock.sent.find((d) => d.primary === 0).second;
        const decisions = inSecond(clock.sent, lockAt);
        assert.equal(decisions.length, 2, 'the packet, then the tick');
        assert.ok(decisions[0].primary > 0, 'the packet before the tick still rode');
        assert.deepEqual([decisions[1].primary, decisions[1].secondary, decisions[1].urgent], [0, RUIN_LOCK_SECONDARY, true]);
        assert.equal(clock.sent.filter((d) => d.urgent).length, 1, 'one urgent dispatch for one lockout');
    });

    it('a Ruin lockout that begins under a stall pause still sends its tick urgent', () => {
        // The guard cuts the ride 3 s in and its pause outlasts the ride, so
        // the primary is already 0 when the lockout begins: only the
        // secondary moves, and no cut would have said so.
        const clock = masterClock({ mode: 'ruin', stallGuard: true, pauseTimeoutSeconds: 30 });
        clock.run(5, 100);
        clock.run(15, 145);
        const lock = clock.sent.find((d) => d.task === 'tick' && d.secondary === RUIN_LOCK_SECONDARY);
        assert.ok(lock, 'the lockout began');
        const before = inSecond(clock.sent, lock.second).find((d) => d.task === 'packet');
        assert.equal(before.primary, 0, 'the stall pause already held the primary at 0');
        assert.ok(before.secondary > RUIN_LOCK_SECONDARY, 'and the ride still set the secondary');
        assert.equal(lock.urgent, true);
        // Two guards engaged, two urgent ticks: the stall cut and the lockout.
        assert.deepEqual(clock.sent.filter((d) => d.urgent).map((d) => d.task), ['tick', 'tick']);
    });

    it('Full Stop decided on a packet goes out urgent on that packet', () => {
        const clock = masterClock({ mode: 'classic', ceilingBehaviour: 'stop' });
        clock.run(5, 100);
        clock.run(4, 145);
        const cut = clock.sent.find((d) => d.primary === 0);
        assert.deepEqual([cut.task, cut.urgent], ['packet', true]);
        assert.equal(clock.sent.filter((d) => d.urgent).length, 1);
    });

    it('a pattern slowing the stroke is never urgent', () => {
        for (const mode of ['classic', 'milker', 'ultimate', 'headplay', 'shortener', 'ruin']) {
            const clock = masterClock({ mode, ceilingBehaviour: 'crawl', stallGuard: true });
            clock.run(90, 110);
            const decreases = clock.sent.filter((d, i) => i > 0 && d.primary < clock.sent[i - 1].primary);
            assert.ok(decreases.length > 10, `${mode} slows down on its own`);
            assert.ok(clock.sent.every((d) => !d.urgent && d.primary > 0), `${mode} never cuts or goes urgent`);
        }
    });

    it('without the hold the tick sent the overruled speed first, the defect this prevents', () => {
        // The same clock with a gate that never holds: what updateEngine did
        // before, one dispatch per call.
        const never = { run: (tick) => tick(), admit: () => ({ urgent: false }), markUrgent() {}, isRunning: () => false };
        const clock = masterClock({ mode: 'ruin', gate: never });
        clock.run(5, 100);
        clock.run(15, 145);
        const lockAt = clock.sent.find((d) => d.primary === 0).second;
        const primaries = inSecond(clock.sent, lockAt).map((d) => d.primary);
        assert.equal(primaries.length, 3, 'the packet, the tick before its guards, the tick after');
        assert.ok(primaries[1] > 0, 'the ride speed the lockout cut went out in the same tick');
        assert.equal(primaries[2], 0);
    });

    it('the watchdog\'s tick sends its stop once, and nothing before or after it', () => {
        const clock = masterClock({ mode: 'classic', watchdogAt: 8 });
        clock.run(5, 100);
        clock.run(5, 120);
        const tick = inSecond(clock.sent, 8).filter((d) => d.task === 'tick');
        assert.deepEqual(tick.map((d) => [d.primary, d.secondary, d.force]), [[0, 0, true]], 'one stop, not the motion computed before it nor the pause\'s repeat');
        assert.ok(inSecond(clock.sent, 7).some((d) => d.primary > 0), 'the toys were moving the second before');
        // Paused: every second after it is one silence per packet and per tick.
        for (const second of [9, 10]) {
            assert.deepEqual(inSecond(clock.sent, second).map((d) => [d.task, d.primary, d.force]), [['packet', 0, false], ['tick', 0, false]]);
        }
    });

    it('every tick sends exactly one decision, whatever it decides', () => {
        for (const mode of ['classic', 'milker', 'ruin', 'ultimate']) {
            const clock = masterClock({ mode, ceilingBehaviour: 'crawl', stallGuard: true });
            clock.run(6, 110);
            clock.run(30, 145);
            clock.run(10, 120);
            for (let second = 1; second <= 46; second++) {
                // One from the packet, one from the tick.
                assert.deepEqual(inSecond(clock.sent, second).map((d) => d.task), ['packet', 'tick'], `${mode} second ${second}`);
            }
        }
    });
});

// Force Orgasm on the master clock, as app.js runs it (masterClockTick,
// tickForcedOrgasm, landForcedOrgasm, beginSoftLanding): its time limit is
// asked before the engine runs, and a run the limit ends is switched off,
// the session goes into the soft landing from what the toys were last sent,
// and the tick is marked urgent. The ramp's origin, like the landing's, is
// what the gate let out (dispatchHardware records it only then). The wearer
// arms the run and pauses the session outside any tick; RESUME starts the
// ramp again from the stop the pause sent. Each second a heart-rate packet
// runs the engine before the tick.
function forceOrgasmClock({ mode = 'classic', maxSeconds = 60 } = {}) {
    const gate = createTickDispatch();
    const sent = [];
    let last = { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 };
    const s = {
        second: 0,
        task: 'packet',
        status: 'RUNNING',
        isEdged: false,
        orgasmMode: false,
        orgasmSeconds: 0,
        orgasmBoost: 0,
        orgasmFrom: null,
        rampLeft: 45,
        landingFrom: null
    };
    const dispatch = (decision, { force = false, urgent = false } = {}) => {
        const release = gate.admit(decision, { force, urgent });
        if (!release) return;
        last = { primary: decision[0], secondary: decision[1], strokeMin: decision[2], strokeMax: decision[3] };
        sent.push({ second: s.second, task: s.task, status: s.status, primary: decision[0], secondary: decision[1], urgent: release.urgent });
    };
    const updateEngine = (hr) => {
        const out = calculateEngineOutputs({
            hr,
            edgeHr: hr,
            minHr: 70,
            maxHr: 140,
            activeMode: mode,
            sessionStatus: s.status,
            rampdownSecondsLeft: s.rampLeft,
            landingFrom: s.landingFrom,
            isEdged: s.isEdged,
            orgasmMode: s.orgasmMode,
            orgasmBoost: s.orgasmMode ? s.orgasmBoost : 0,
            orgasmFrom: s.orgasmMode ? s.orgasmFrom : null,
            warmupMinutes: 0,
            sessionSeconds: s.second
        });
        s.isEdged = out.isEdged;
        dispatch([out.primaryPercent, out.secondaryPercent, out.strokeMinPercent, out.strokeMaxPercent]);
    };
    const startRamp = () => {
        s.orgasmBoost = 0;
        s.orgasmFrom = { ...last };
    };
    const arm = (hr) => {
        s.task = 'control';
        s.orgasmMode = true;
        s.orgasmSeconds = 0;
        startRamp();
        updateEngine(hr);
    };
    const pause = () => {
        s.task = 'control';
        s.status = 'PAUSED';
        dispatch([0, 0, 0, 100], { force: true });
    };
    const resume = (hr) => {
        s.task = 'control';
        s.status = 'RUNNING';
        if (s.orgasmMode) startRamp();
        updateEngine(hr);
    };
    const tick = (hr) => gate.run(() => {
        s.task = 'tick';
        if (s.status === 'RUNNING') {
            const step = tickForceOrgasm({ seconds: s.orgasmSeconds }, { orgasmMode: s.orgasmMode, sessionStatus: s.status, maxSeconds });
            s.orgasmSeconds = step.seconds;
            if (step.expired) {
                s.orgasmMode = false;
                s.orgasmSeconds = 0;
                s.orgasmBoost = 0;
                s.orgasmFrom = null;
                s.status = 'RAMPDOWN';
                s.rampLeft = 45;
                s.landingFrom = { primary: last.primary, secondary: last.secondary };
                gate.markUrgent();
            }
            updateEngine(hr);
            if (s.orgasmMode) s.orgasmBoost = Math.min(ORGASM_BOOST_CAP, s.orgasmBoost + 1);
        } else if (s.status === 'RAMPDOWN') {
            s.rampLeft -= 1;
        }
        updateEngine(hr);
    }, (decision, { urgent }) => dispatch(decision, { urgent }));
    const run = (seconds, hr) => {
        for (let i = 0; i < seconds; i++) {
            s.second += 1;
            s.task = 'packet';
            updateEngine(hr);
            tick(hr);
        }
    };
    return { run, arm, pause, resume, sent, s };
}

describe('Force Orgasm goes through the same tick', () => {
    it('its time limit sends the landing once, urgent, in the tick it runs out, never above what was sent', () => {
        for (const mode of ['classic', 'milker', 'ruin']) {
            const clock = forceOrgasmClock({ mode, maxSeconds: 60 });
            clock.run(20, 110);
            clock.arm(110);
            clock.run(70, 110);
            const at = clock.sent.findIndex((d) => d.status === 'RAMPDOWN');
            assert.ok(at > 0, `${mode}: the run ran out`);
            const landing = clock.sent[at];
            assert.deepEqual([landing.second, landing.task, landing.urgent], [80, 'tick', true], mode);
            // The packet just before it carried the overdrive.
            const before = clock.sent[at - 1];
            assert.equal(before.status, 'RUNNING');
            assert.ok(landing.primary < before.primary && landing.secondary <= before.secondary, `${mode}: ${JSON.stringify([before, landing])}`);
            // One decision from that tick, and the ramp before it and the
            // landing after it are ordinary changes.
            assert.equal(inSecond(clock.sent, 80).filter((d) => d.task === 'tick').length, 1);
            assert.deepEqual(clock.sent.filter((d) => d.urgent).map((d) => d.second), [80], mode);
            const landed = clock.sent.slice(at);
            for (let i = 1; i < landed.length; i++) {
                assert.ok(landed[i].primary <= landed[i - 1].primary && landed[i].secondary <= landed[i - 1].secondary, `${mode}: the landing never steps up`);
            }
        }
    });

    it('a run that runs out on the first tick after a RESUME lands from the stop the pause sent', () => {
        const clock = forceOrgasmClock({ mode: 'classic', maxSeconds: 60 });
        clock.run(20, 110);
        clock.arm(110);
        clock.run(59, 110);
        clock.pause();
        clock.run(3, 110);
        clock.resume(110);
        clock.run(1, 110);
        const at = clock.sent.findIndex((d) => d.status === 'RAMPDOWN');
        assert.ok(at > 0, 'the run ran out');
        assert.deepEqual([clock.sent[at].task, clock.sent[at].urgent], ['tick', true]);
        // Nothing has moved since the pause's stop, and the landing starts
        // it nowhere.
        const pausedAt = clock.sent.findIndex((d) => d.task === 'control' && d.status === 'PAUSED');
        assert.ok(clock.sent.slice(pausedAt).every((d) => d.primary === 0 && d.secondary === 0), JSON.stringify(clock.sent.slice(pausedAt)));
    });
});

// A wiring check beside the behaviour above: the page must actually run its
// clock through the gate, mark a guard and Force Orgasm's landing, and send
// its last decision after the guards. The page itself was driven in headless
// Chromium for the timings.
describe('app.js runs its master clock through it', () => {
    const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    const bodyOf = (name) => {
        const at = src.indexOf(`function ${name}(`);
        assert.ok(at >= 0, `${name} is gone - rename this guard with it`);
        return src.slice(at, src.indexOf('\n}', at));
    };

    it('asks the gate before any driver, and hands every driver the urgency', () => {
        const body = bodyOf('dispatchHardware');
        assert.match(body, /const release = tickDispatch\.admit\(\[primarySpeed, secondarySpeed, strokeMin, strokeMax\], \{ force, urgent \}\);\s*if \(!release\) return;/);
        assert.ok(body.indexOf('tickDispatch.admit(') < body.indexOf('dispatchHandy('), 'the gate comes before any driver');
        for (const driver of ['dispatchHandy', 'dispatchVacuglide', 'dispatchIntiface', 'dispatchTCode']) {
            assert.ok(body.indexOf('tickDispatch.admit(') < body.indexOf(`${driver}(`), `the gate comes before ${driver}`);
            assert.match(body, new RegExp(`${driver}\\([^;]*\\{ urgent: release\\.urgent \\}\\);`), driver);
        }
    });

    it('marks the tick when a guard engages', () => {
        const body = bodyOf('tickSessionGuardsAndGames');
        assert.match(body, /if \(guardEngagedBy\(step, ruinBefore\)\) tickDispatch\.markUrgent\(\);/);
        assert.ok(body.indexOf('const ruinBefore = readRuinClock();') < body.indexOf('tickRuinAndStallGuard('));
    });

    it('ticks inside it and ends each tick on the engine, after the guards and the watchdog', () => {
        assert.match(src, /setInterval\(\(\) => tickDispatch\.run\(masterClockTick, \(decision, \{ urgent \}\) => dispatchHardware\(\.\.\.decision, false, urgent\)\), 1000\);/);
        const body = bodyOf('masterClockTick');
        const last = body.lastIndexOf('updateEngine();');
        assert.ok(last > body.indexOf('tickSessionGuardsAndGames();'), 'the decision sent comes after the guards and games');
        assert.ok(last > body.indexOf('evaluateHrWatchdog();'), 'and after the watchdog');
    });

    it('lands Force Orgasm through the tick: the limit marks it, and sends nothing of its own', () => {
        const body = bodyOf('landForcedOrgasm');
        assert.match(body, /tickDispatch\.markUrgent\(\);/);
        assert.ok(!/dispatchHardware\(|updateEngine\(/.test(body), 'the tick sends the landing, once, when it is over');
        const clock = bodyOf('masterClockTick');
        const asked = clock.indexOf('tickForcedOrgasm();');
        assert.ok(asked >= 0 && asked < clock.indexOf('updateEngine();'), 'the limit is asked before the engine runs');
    });

    it('counts as sent only what the gate lets out: Force Orgasm starts from it', () => {
        const body = bodyOf('dispatchHardware');
        const released = body.indexOf('if (!release) return;');
        assert.ok(released >= 0 && body.indexOf('lastDispatched = ') > released, 'a decision a tick held and replaced never reached the toys');
    });
});
