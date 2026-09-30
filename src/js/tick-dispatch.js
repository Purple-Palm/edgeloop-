// What the master clock sends the toys: one decision per tick, sent when the
// tick is over, and sent urgent when it cuts the primary, or a guard or Force
// Orgasm's time limit made it.
//
// Each second the master clock refreshes the engine first, so the guards
// and games judge this second's pulse, ceiling and edge flag, and only then
// runs them. updateEngine() sends what it computes on the spot, so the tick
// used to send the toys this second's motion BEFORE the stall guard or the
// Ruin lockout had decided to cut it, and the cut followed a few
// milliseconds later as a second dispatch - which The Handy's 400 ms
// velocity throttle swallowed. Measured in the page with a mocked Handy API:
// the stop a stall guard decided reached the device on the next heart-rate
// packet or the next tick, 0.5-1.0 s after the engine had set the primary to
// 0. On the second the Ruin lockout began, the tick sent PUT /slide and PUT
// /hamp/velocity for the ride speed one millisecond before the engine cut
// it, and the stop a second later; a Buttplug vibrator and rotator and a
// T-Code vibration axis were sent the ride speed just before their zero.
//
// So an ordinary dispatch made while a tick runs is held, and only the last
// one is sent, once, after the tick has run everything it runs: the guards,
// the games, the endgame and the watchdog. The decision the toys get is the
// one the tick ends on, never one of its rules overruled. A forced dispatch
// (STOP, a pause, the watchdog) is never held: it goes out at once and drops
// what the tick was holding, which was decided before it and must never
// follow it to the toys. Nothing is held outside a tick, so a heart-rate
// packet or a control the wearer touches is sent the moment it happens.
//
// Once per tick. The watchdog stops the toys and then pauses the session,
// and the pause stops them again: in the page the watchdog's tick sent
// StopAllDevices twice and wrote the T-Code rest line twice, a millisecond
// apart. A stop is the last thing its tick sends - no second stop, no zeros
// the engine computes after it, no motion - and nothing a tick has sent is
// sent again in it. A stop itself is never held back or swallowed.
//
// Urgent. The Handy's driver keeps velocity changes to one per 400 ms by
// dropping a dispatch that comes too soon after the last one, and a stroker
// axis takes a new speed on its next leg. Both are right for the ordinary
// changes of a pattern and wrong for a guard's decision, which has to reach
// every toy on the dispatch that carries it, whichever channel the toy
// follows. Measured in the page: a Handy set to follow the secondary channel
// took the Ruin lockout's drop to 18% 0.8 s late, on the next heart-rate
// packet - in the next tick when that packet was missed - because a packet
// 200 ms before the tick had opened the throttle's window, and a stroker on
// the secondary channel took it when its leg ended. So a decision goes out
// urgent when a guard engaged in the tick that made it (markUrgent), or when
// it cuts a moving primary to 0, on a heart-rate packet as much as on a tick
// (Full Stop on the mark raises a milking mode's secondary in the same
// decision); urgent passes the throttle and re-times the leg in flight. The
// tick in which Force Orgasm's time limit runs out is marked the same way:
// it hands a run at up to full speed to its soft landing, whose first value
// has to reach every toy in that tick too (app.js landForcedOrgasm). All of
// them are edges, not levels: a cut is urgent on the dispatch that takes a
// moving primary to 0 and on none after it, a guard on the second it
// engages, that landing on the second it begins, so the request rate cannot
// rise. A forced dispatch reaches every toy at once in any case, and is
// urgent too.
//
// No DOM and no timers, so all of it runs under node:test.

// Every forced dispatch today is a stop; one that carries motion is not, and
// must never stand in for a stop the tick decides after it.
function isStop(decision) {
    return !(Number(decision[0]) > 0) && !(Number(decision[1]) > 0);
}

function sameDecision(a, b) {
    return a !== null && b !== null && a.length === b.length && a.every((v, i) => v === b[i]);
}

function primaryOf(decision) {
    return Number(decision[0]) > 0 ? Number(decision[0]) : 0;
}

// Whether one second of the Ruin clock and the stall guard (session-rules.js
// tickRuinAndStallGuard) engaged a guard: the stall guard cut the primary,
// or the Ruin lockout began. `ruinBefore` is the Ruin clock the step was
// given. True on the second it happens, never on the seconds after it.
export function guardEngagedBy(step, ruinBefore = {}) {
    const lockBefore = Number(ruinBefore && ruinBefore.lockSeconds) || 0;
    const lockAfter = Number(step && step.ruin && step.ruin.lockSeconds) || 0;
    return Boolean(step && step.guard && step.guard.justEngaged) || (lockBefore <= 0 && lockAfter > 0);
}

export function createTickDispatch() {
    let running = false;
    let held = null;
    // A guard engaged in this tick: the decision it ends on goes out urgent.
    let urgentTick = false;
    // A stop has gone out in this tick: nothing more does.
    let stopped = false;
    // The last decision this tick has sent (a forced one): not sent again.
    let sentInTick = null;
    // The primary of the last decision the toys were sent. A cut is judged
    // against what they were really sent, never against a decision a tick
    // held and replaced.
    let lastPrimary = 0;

    function startTick() {
        held = null;
        urgentTick = false;
        stopped = false;
        sentInTick = null;
    }

    return {
        // Run one tick. `send(decision, { urgent })` receives the last
        // decision held during it, once, after `tick` has returned - and
        // after it has thrown: the toys then get the newest decision there
        // is, as they did before, and a tick that fails can never leave the
        // hold on and swallow every packet after it. `urgent`: a guard
        // engaged in the tick.
        run(tick, send) {
            // A tick run from inside a tick is part of it: the outer run
            // sends, once.
            if (running) return tick();
            running = true;
            startTick();
            try {
                return tick();
            } finally {
                running = false;
                const decision = sameDecision(held, sentInTick) ? null : held;
                const urgent = urgentTick;
                startTick();
                if (decision !== null) send(decision, { urgent });
            }
        },
        // Every dispatch asks here before it reaches a driver. Returns null
        // when it must not be sent now: a tick is running and holds it for
        // its end, or the tick has already sent it or a stop. Otherwise
        // returns { urgent } and the caller sends it at once: urgent when it
        // is forced, when the caller says so (the decision of a tick a guard
        // engaged in), or when it cuts a moving primary to 0.
        admit(decision, { force = false, urgent = false } = {}) {
            if (running && stopped) return null;
            if (force) {
                if (running) {
                    if (!isStop(decision) && sameDecision(decision, sentInTick)) return null;
                    held = null;
                    stopped = isStop(decision);
                    sentInTick = decision;
                }
                lastPrimary = primaryOf(decision);
                return { urgent: true };
            }
            if (running) {
                held = decision;
                if (urgent) urgentTick = true;
                return null;
            }
            const primary = primaryOf(decision);
            const cut = lastPrimary > 0 && primary === 0;
            lastPrimary = primary;
            return { urgent: Boolean(urgent) || cut };
        },
        // A guard engaged in the running tick, or Force Orgasm's time limit
        // ran out in it: the decision it ends on goes out urgent. Nothing
        // outside a tick.
        markUrgent() {
            if (running) urgentTick = true;
        },
        isRunning() {
            return running;
        }
    };
}
