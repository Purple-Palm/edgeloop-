// Per-axis stroke scheduler for Buttplug LinearCmd actuators (OSR2 / SR6 /
// OSSM through Intiface). Pure: no timers, no sockets. The driver feeds it
// the engine's inputs and asks "what should be sent now?"; the planner
// answers with at most ONE leg at a time and never re-issues a leg that is
// still in flight (only an urgent decision re-times one), which is what keeps
// the motion smooth.
//
// Rules:
//   - A stroke alternates between zone min and zone max; each leg is one
//     LinearCmd carrying the FULL leg duration.
//   - Speed, cap and zone changes apply to the NEXT leg only, save the two
//     below.
//   - A stop interrupts the leg in flight: when the axis stops moving -
//     speed 0, a cap of 0, role OFF (enabled: false) - a single move to the
//     rest position (zone min) over REST_MOVE_MS is the next thing sent,
//     then silence until it moves again. Speed 0 is always a stop somebody
//     decided (a guard, Full Stop on the mark, the Ruin lockout, a pause,
//     STOP): a pattern's near-stop crawls at 1% (patterns.js). A stop that
//     let the leg finish kept the sleeve stroking for up to SLOW_LEG_MS after
//     the engine had cut it: measured in the page, a Buttplug stroker and a
//     T-Code L0 axis got the rest move for a stall guard's cut up to 1.9 s
//     after the vibrators had stopped. It is the same rest move the stop
//     always ended with, started from wherever the leg was cut instead of
//     from its end, so it never covers more than a rest from one end of the
//     stroke already did.
//   - An urgent decision - a guard engaging, a cut, Force Orgasm's landing
//     (tick-dispatch.js) - re-times the leg in flight (retime()): the rest
//     of it goes to the same end at the new speed. A speed change otherwise
//     waits for the next leg, and an axis that follows the other channel is
//     not stopped by a cut, so in the page a stroker or a twist axis set to
//     the secondary channel took the Ruin lockout's drop to 18% only when
//     its leg ended, up to 0.9 s after the tick, and Milker's raise of the
//     secondary on the mark 1.6 s later, past the next tick, when every
//     vibrator had it at once. A re-timed leg never sends a position the leg
//     was not already on its way to - a device starts a timed move from
//     wherever the axis is - so only when the sleeve gets there changes. The
//     position retime() hands back is the planner's, a logical one: the
//     driver sends the re-timed leg to the physical position it sent the leg
//     to, and not at all once the wearer has put that outside the travel
//     envelope (intiface.js, tcode.js), because what maps one onto the
//     other - the envelope, the invert switch - can change while the leg is
//     in flight. Nor is the rest of a leg timed over less than the leg
//     covers on the device: one planned just after that mapping changed can
//     cover more than the planner sized it for, and the driver says how much
//     (retime()).
//   - A leg's duration follows the distance really travelled: the first leg
//     after a rest or a zone shift that has to cross more than the zone
//     width gets proportionally longer, never a snap. `legTravel` overrides
//     the zone width as the base (rotation axes: 1, so the swing period
//     depends on the speed alone, not on the amplitude).

export const FAST_LEG_MS = 180;
export const SLOW_LEG_MS = 2200;
export const MIN_LEG_MS = 120;
export const MIN_TRAVEL = 0.08;
export const REST_MOVE_MS = 400;

function clamp01(v, fallback = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function clampPercent(v, fallback = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, n));
}

// One leg's duration: 100 % speed ~ 180 ms per leg, 0 % ~ 2200 ms, scaled by
// the travel (a 40 % zone takes 40 % of the time), never below MIN_LEG_MS.
export function legDurationMs(speedPercent, travel) {
    const speed = clampPercent(speedPercent);
    const span = Math.max(MIN_TRAVEL, clamp01(travel));
    const duration = FAST_LEG_MS + ((100 - speed) / 100) * (SLOW_LEG_MS - FAST_LEG_MS);
    return Math.max(MIN_LEG_MS, Math.round(duration * span));
}

// Normalise the planner inputs: percentages clamped, zone ordered.
export function normalizePlannerInput({ speed = 0, zoneMin = 0, zoneMax = 1, cap = 100, enabled = true, legTravel = null } = {}) {
    const min = clamp01(zoneMin, 0);
    const max = Math.max(min, clamp01(zoneMax, 1));
    const capPct = clampPercent(cap, 100);
    const effectiveSpeed = clampPercent(speed) * (capPct / 100);
    const travelBase = legTravel === null || legTravel === undefined ? null : clamp01(legTravel, 1);
    return { speed: clampPercent(speed), cap: capPct, effectiveSpeed, zoneMin: min, zoneMax: max, enabled: enabled !== false, legTravel: travelBase };
}

// Whether normalised inputs ask the axis to stroke at all. The one test for
// both the rest move and the stop that interrupts a leg, so they cannot drift
// apart.
function isMoving(input) {
    return input.enabled && input.effectiveSpeed > 0;
}

export function createStrokePlanner({ restMs = REST_MOVE_MS } = {}) {
    let input = normalizePlannerInput({});
    let legEndsAt = 0;
    let lastPosition = null;      // null: position unknown (fresh axis)
    let atRest = false;           // a rest move has been issued and nothing since
    let goingUp = true;           // direction of the next stroke leg
    // The stroke leg in flight as it was last timed, for retime(): when that
    // timing began, the speed it was for, the travel the whole leg was timed
    // over, and the share of that travel still ahead when it began. Null for
    // a rest move.
    let stroke = null;

    function isInFlight(now) {
        return now < legEndsAt;
    }

    return {
        // Update the inputs. Takes effect on the next leg (or on the leg in
        // flight through retime()), except that a stop (speed 0, cap 0, role
        // OFF) interrupts the leg in flight so the rest move goes out at once.
        setInput(next) {
            const wasMoving = isMoving(input);
            input = normalizePlannerInput({ ...input, ...next });
            if (wasMoving && !isMoving(input)) legEndsAt = 0;
        },
        getInput() {
            return { ...input };
        },
        isInFlight,
        legEndsAt() {
            return legEndsAt;
        },
        isResting() {
            return atRest;
        },
        lastPosition() {
            return lastPosition;
        },
        // The leg to send right now, or null when nothing should be sent
        // (a leg is in flight, or the axis is already resting).
        next(now) {
            if (isInFlight(now)) return null;
            if (!isMoving(input)) {
                if (atRest) return null;
                atRest = true;
                goingUp = true;
                lastPosition = input.zoneMin;
                legEndsAt = now + restMs;
                stroke = null;
                return { position: input.zoneMin, durationMs: restMs, kind: 'rest' };
            }
            atRest = false;
            const travel = input.zoneMax - input.zoneMin;
            const position = goingUp ? input.zoneMax : input.zoneMin;
            // Size the leg by what it really has to cover: the zone width
            // (or legTravel) at least, the distance from the last position
            // when that is longer (first leg after a rest or a zone shift).
            const base = input.legTravel !== null ? input.legTravel : travel;
            const distance = lastPosition === null ? 0 : Math.abs(position - lastPosition);
            const durationMs = legDurationMs(input.effectiveSpeed, Math.max(base, distance));
            goingUp = !goingUp;
            lastPosition = position;
            legEndsAt = now + durationMs;
            stroke = { startedAt: now, speed: input.effectiveSpeed, travel: Math.max(base, distance), share: 1 };
            return { position, durationMs, kind: 'stroke' };
        },
        // The leg in flight re-timed for an urgent decision, to be sent now in
        // place of it, or null when there is none to re-time: no stroke in
        // flight, an axis that has stopped (a stop interrupts the leg by
        // itself, and next() sends the rest move), a leg already at this
        // speed, or one about to end, whose next leg follows at once anyway.
        // The rest of the leg goes to the same end in the share of a whole
        // leg at the new speed that is still ahead of it, so the sleeve
        // covers what is left of the stroke at that speed. Zone changes still
        // wait for the next leg. The position is the leg's logical end; a
        // driver sends the re-timed leg where it sent the leg, never this
        // position mapped again (see the rules above).
        //
        // `travel`: how much of the travel the leg covers on the device, when
        // the driver knows it. A leg planned just after the mapping changed
        // covers more than it was sized for - with the invert switch flipped
        // at a leg's end, a leg timed for 0.2 of the travel took the sleeve
        // 0.8 - and what is left of it is timed over what it covers, never
        // over less: re-timed to 100% over 0.2, the rest of that leg asked
        // for 6.1 travel/s, beyond the 5.6 of the planner's fastest leg.
        retime(now, { travel = 0 } = {}) {
            if (!stroke || !isInFlight(now) || !isMoving(input)) return null;
            if (input.effectiveSpeed === stroke.speed) return null;
            const left = legEndsAt - now;
            if (left < MIN_LEG_MS) return null;
            const share = stroke.share * Math.min(1, left / (legEndsAt - stroke.startedAt));
            const covers = Math.max(stroke.travel, clamp01(travel));
            const durationMs = Math.max(MIN_LEG_MS, Math.round(share * legDurationMs(input.effectiveSpeed, covers)));
            stroke = { startedAt: now, speed: input.effectiveSpeed, travel: covers, share };
            legEndsAt = now + durationMs;
            return { position: lastPosition, durationMs, kind: 'stroke' };
        },
        // Forget the in-flight leg (device removed, socket closed). The next
        // call to next() with speed 0 issues a fresh rest move.
        reset() {
            legEndsAt = 0;
            lastPosition = null;
            atRest = false;
            goingUp = true;
            stroke = null;
        }
    };
}
