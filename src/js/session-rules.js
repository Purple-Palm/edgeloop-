// Pure session rules shared by the cockpit: the effective heart-rate ceiling
// (typed limit minus every safety offset), HR-limit sanitising, duration
// parsing, the Survival climb, the stall guard and Ruin & Leak's one-ride
// clock. No DOM and no storage, so all of it runs under node:test.

// What this file reads from the engine: the crawl level, so the cockpit
// banner can tell a crawling motor from a running one with the same number
// the engine sends, which modes are games, where the stall guard has
// nothing of its own to cut, and the modes in which a cool-down may run, so
// the counter here and the easing there can never disagree about where it
// applies. Ruin & Leak's timings come from the patterns that draw its ride
// and its lockout.
import { CRAWL_PERCENT, GAME_MODES, COOLDOWN_MODES, resolveCeilingBehaviour } from './engine.js';
import { RUIN_RIDE_SECONDS, RUIN_LOCK_SECONDS } from './patterns.js';

// The effective ceiling can never be pushed closer than this to the resting
// HR, otherwise the tease band collapses into a permanent cut-off.
export const MIN_CEILING_GAP = 15;

// Force Orgasm raises the working ceiling by 1 BPM per second so the edge
// detector stops firing; the raise is capped so an overdrive left running
// cannot drift the ceiling into nonsense territory.
export const ORGASM_BOOST_CAP = 60;

// Survival Mode only ends after this many consecutive READINGS at or above
// the ceiling, so a single HR-sensor spike cannot end the game. The game
// itself no longer ends on this streak. The counter stays so a held reading
// is still one reading.
export const SURVIVAL_BREACH_TICKS = 3;

// Survival climbs for a long session. The time term takes 30 minutes to add
// SURVIVAL_TIME_SPEED, and each counted edge adds a little speed plus one
// BPM of ceiling. Neither one is allowed to finish the run in the first
// few minutes.
export const SURVIVAL_START_FLOOR = 18;
export const SURVIVAL_SLOW_SPAN_SECONDS = 30 * 60;
export const SURVIVAL_TIME_SPEED = 42;
export const SURVIVAL_EDGE_SPEED = 1.25;
export const SURVIVAL_EDGE_BPM = 1;
export const SURVIVAL_OVERDRIVE_CAP = 40;

// How long pulse may sit at the pullback trigger before the primary is cut.
export const MIN_STALL_GUARD_SECONDS = 3;
export const MAX_STALL_GUARD_SECONDS = 120;
export const DEFAULT_STALL_GUARD_SECONDS = 20;

// How long the primary stays halted after that cut, then crawl resumes
// (still edged) and the hold window starts again.
export const MIN_STALL_PAUSE_SECONDS = 2;
export const MAX_STALL_PAUSE_SECONDS = 60;
export const DEFAULT_STALL_PAUSE_SECONDS = 8;

export const DEFAULT_MIN_HR = 70;
export const DEFAULT_MAX_HR = 140;

function toInt(value) {
    if (value === '' || value === null || value === undefined) return null;
    const n = typeof value === 'number' ? value : parseInt(String(value), 10);
    return Number.isFinite(n) ? Math.round(n) : null;
}

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

// A clock value as whole seconds, never negative. The clocks below are only
// ever written by this file, but a NaN in one would stop it forever.
function wholeSeconds(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

// Parse the two typed HR limits. A field that does not parse falls back to
// the last known-good value for that field (never to a higher default), and
// is reported in `invalid` so the UI can flag it. Ordering is NOT corrected:
// a max below the min is flagged but kept, because the engine treats that as
// "always at ceiling" and stops the motors, which is the safe outcome.
export function sanitizeHrLimits(rawMin, rawMax, lastGood = {}) {
    const fallbackMin = Number.isFinite(lastGood.minHr) ? lastGood.minHr : DEFAULT_MIN_HR;
    const fallbackMax = Number.isFinite(lastGood.maxHr) ? lastGood.maxHr : DEFAULT_MAX_HR;
    const invalid = [];
    let minHr = toInt(rawMin);
    let maxHr = toInt(rawMax);
    if (minHr === null || minHr < 30 || minHr > 250) {
        invalid.push('min');
        minHr = fallbackMin;
    }
    if (maxHr === null || maxHr < 30 || maxHr > 250) {
        invalid.push('max');
        maxHr = fallbackMax;
    }
    if (maxHr <= minHr) {
        if (!invalid.includes('min')) invalid.push('min');
        if (!invalid.includes('max')) invalid.push('max');
    }
    return { minHr, maxHr, valid: invalid.length === 0, invalid };
}

// Compute the ceiling the engine actually uses. Every offset only ever LOWERS
// the typed ceiling (never below min + MIN_CEILING_GAP, and never above the
// typed value). Two explicit raises sit on top: Force Orgasm, and Survival's
// per-edge overdrive while that game is on.
export function computeEffectiveCeiling({
    minHr,
    maxHr,
    learnedOffset = 0,
    dualStimActive = false,
    dualDampening = false,
    dualDampeningBpm = 15,
    adaptiveDecay = false,
    edges = 0,
    decayEdgeCount = 2,
    decayBpm = 2,
    decayFloor = 105,
    orgasmBoost = 0,
    survivalOverdrive = 0
}) {
    const min = Number.isFinite(minHr) ? minHr : DEFAULT_MIN_HR;
    const typedMax = Number.isFinite(maxHr) ? maxHr : DEFAULT_MAX_HR;
    let max = typedMax;
    // The lowest any offset may drag the ceiling. If the user typed a ceiling
    // that is already closer than the gap, the typed value wins (offsets are
    // simply not applied) rather than the floor raising it above what they typed.
    const floorMax = Math.min(typedMax, min + MIN_CEILING_GAP);

    const learned = Number.isFinite(learnedOffset) && learnedOffset > 0 ? learnedOffset : 0;
    if (learned > 0) max = Math.max(floorMax, max - learned);

    const dual = (dualStimActive && dualDampening)
        ? (Number.isFinite(dualDampeningBpm) && dualDampeningBpm > 0 ? dualDampeningBpm : 15)
        : 0;
    if (dual > 0) max = Math.max(floorMax, max - dual);

    let totalDecay = 0;
    let appliedDecay = 0;
    let decayFloored = false;
    if (adaptiveDecay && Number.isFinite(edges) && edges > 0) {
        const every = Number.isFinite(decayEdgeCount) && decayEdgeCount > 0 ? decayEdgeCount : 2;
        const perDrop = Number.isFinite(decayBpm) && decayBpm > 0 ? decayBpm : 2;
        totalDecay = Math.floor(edges / every) * perDrop;
        if (totalDecay > 0) {
            const floor = Math.max(floorMax, Number.isFinite(decayFloor) ? decayFloor : 105);
            // The floor may STOP the decay but must never raise the ceiling.
            const decayedMax = Math.min(max, Math.max(floor, max - totalDecay));
            const next = Math.max(floorMax, decayedMax);
            appliedDecay = max - next;
            decayFloored = appliedDecay < totalDecay;
            max = next;
        }
    }

    // Belt and braces: no offset path may leave the ceiling above the typed one.
    max = Math.min(max, typedMax);

    const boost = clamp(Number.isFinite(orgasmBoost) ? orgasmBoost : 0, 0, ORGASM_BOOST_CAP);
    // Survival is the other explicit raise. It is session-only, one BPM per
    // edge counted while that game is on, and it drops the moment the game
    // is off. Offsets above still lower the base it climbs from.
    const overdrive = clamp(Number.isFinite(survivalOverdrive) ? survivalOverdrive : 0, 0, SURVIVAL_OVERDRIVE_CAP);
    max += boost + overdrive;

    return {
        minHr: min,
        maxHr: max,
        typedMaxHr: typedMax,
        learnedOffset: learned,
        dualOffset: dual,
        totalDecay,
        appliedDecay,
        decayFloored,
        orgasmBoost: boost
    };
}

// Parse the Session Setup duration fields. Anything that is not a positive
// finite integer, or a window whose min exceeds its max, is reported in
// `invalid` (field names 'fixed', 'min', 'max') and the session falls back to
// endless (targetSeconds 0) so the caller can flag the field instead of
// silently running forever.
function emptyDuration(invalid = []) {
    return {
        targetSeconds: 0,
        minSeconds: 0,
        maxSeconds: 0,
        fixedLength: false,
        valid: invalid.length === 0,
        invalid
    };
}

// A "Fixed" session longer than a day is the Endless mode with extra steps.
// A length outside the window is REFUSED here rather than clamped, so both
// a typed one and a stored one fall back to the factory length - the same
// answer, whichever way the number arrived.
export const MAX_SESSION_MINUTES = 1440;

export function parseSessionDuration({ mode, fixedMinutes, minMinutes, maxMinutes, random = Math.random }) {
    if (mode === 'endless') return emptyDuration();

    const toMinutes = (value) => {
        const n = toInt(value);
        return n !== null && n > 0 && n <= MAX_SESSION_MINUTES ? n : null;
    };

    if (mode === 'fixed') {
        const mins = toMinutes(fixedMinutes);
        if (mins === null) return { ...emptyDuration(['fixed']), valid: false };
        const seconds = mins * 60;
        // `fixedLength` is the ONLY thing that tells a Fixed length from a
        // Mystery window the wearer typed with the same number in both boxes:
        // both hand out min === max === target, and the Oracle treats the two
        // completely differently (see oracleTiming).
        return {
            targetSeconds: seconds,
            minSeconds: seconds,
            maxSeconds: seconds,
            fixedLength: true,
            valid: true,
            invalid: []
        };
    }

    const lo = toMinutes(minMinutes);
    const hi = toMinutes(maxMinutes);
    const invalid = [];
    if (lo === null) invalid.push('min');
    if (hi === null) invalid.push('max');
    if (lo !== null && hi !== null && lo > hi) invalid.push('min', 'max');
    if (invalid.length > 0) return { ...emptyDuration(invalid), valid: false };

    const roll = clamp(Number(random()) || 0, 0, 0.999999);
    const mins = Math.min(hi, Math.floor(roll * (hi - lo + 1)) + lo);
    return {
        targetSeconds: mins * 60,
        minSeconds: lo * 60,
        maxSeconds: hi * 60,
        fixedLength: false,
        valid: true,
        invalid: []
    };
}

// Share of a collapsed duration window (min === target) the Oracle waits
// before climax and denial unlock.
export const ORACLE_MIN_WINDOW_SHARE = 0.5;

// When the Oracle may climax or deny. Endless (all zeros) has no clock, so
// any hold may end the session. Mystery/Fixed keep climax and denial closed
// until minSeconds, then open them through the window; past maxSeconds the
// next hold must end (no more purgatory).
export function oracleTiming({
    sessionSeconds = 0,
    minSeconds = 0,
    maxSeconds = 0,
    targetSeconds = 0,
    fixedLength = false
} = {}) {
    const t = Math.max(0, Number(sessionSeconds) || 0);
    const min = Math.max(0, Number(minSeconds) || 0);
    const max = Math.max(0, Number(maxSeconds) || 0);
    const target = Math.max(0, Number(targetSeconds) || 0);
    const closeAt = target > 0 ? target : max;
    // A FIXED length leaves a window of zero width (min === max === target):
    // every hold to the final second would be purgatory and the Oracle would
    // never choose at all. That session opens the window halfway instead, so
    // the ramp still runs and the length the wearer typed stays the latest
    // the Oracle will wait - which is what the UI promises for Fixed.
    //
    // A Mystery window is NOT collapsed, even when the hidden roll happens to
    // land on its own minimum. The wearer typed that minimum to mean "do not
    // finish me before then", and halving it because of a roll they cannot
    // see would unlock climax and denial at half the time they asked for.
    // Such a session simply has canEnd false until the minimum and mustEnd
    // true at it.
    //
    // A Mystery typed with the same number in both boxes (30-30) hands out
    // exactly the numbers a Fixed length does, so the numbers alone cannot
    // tell them apart: 30-30 was read as Fixed and unlocked climax - which
    // arms Force Orgasm - and denial at 15 minutes, half the minimum that was
    // typed. The caller says which kind it is, and the default is the Mystery
    // rule, because that is the one that waits.
    const fixedWindow = Boolean(fixedLength) && min >= closeAt && min >= max;
    const openAt = closeAt > 0 && fixedWindow
        ? Math.floor(closeAt * ORACLE_MIN_WINDOW_SHARE)
        : min;
    const endless = openAt === 0 && closeAt === 0;
    if (endless) {
        return { canEnd: true, mustEnd: false, openAt: 0, closeAt: 0, progress: 1 };
    }
    const span = Math.max(1, closeAt - openAt);
    const progress = clamp((t - openAt) / span, 0, 1);
    return {
        canEnd: t >= openAt,
        mustEnd: closeAt > 0 && t >= closeAt,
        openAt,
        closeAt,
        progress
    };
}

export function rollOracleFate(timing, { random = Math.random, endgameType = 'orgasm' } = {}) {
    const gate = timing && typeof timing === 'object'
        ? timing
        : { canEnd: true, mustEnd: false, progress: 1 };
    if (!gate.canEnd) return 'PURGATORY';
    const roll = clamp(Number(random()) || 0, 0, 0.999999);
    if (gate.mustEnd) {
        // The forced ending is the one the wearer picked in Endgame Trigger.
        // Soft Landing is a tease-down: it must never fall through to a coin
        // flip that arms Force Orgasm on their behalf.
        if (endgameType === 'denial') return 'DENIAL';
        if (endgameType === 'orgasm') return 'CLIMAX';
        if (endgameType === 'rampdown') return 'RAMPDOWN';
        return roll < 0.5 ? 'CLIMAX' : 'DENIAL';
    }
    // Early in the window most holds continue; near the close, climax and
    // denial take most of the rolls. Equal split between those two.
    const p = clamp(Number(gate.progress) || 0, 0, 1);
    const purgP = 0.72 * (1 - p) + 0.18 * p;
    if (roll < purgP) return 'PURGATORY';
    const mid = purgP + (1 - purgP) / 2;
    return roll < mid ? 'CLIMAX' : 'DENIAL';
}

// Survival breach counter: consecutive readings at or above the ceiling. A
// reading below the ceiling resets the streak. A tick that saw no new
// reading (a watch or relay app holding its last value for 2-5 s) leaves
// the streak as it is: one spike must never be counted several times.
export function countSurvivalBreach(previousTicks, hr, ceiling, newReading = true) {
    if (!Number.isFinite(hr) || !Number.isFinite(ceiling)) return 0;
    if (!newReading) return previousTicks || 0;
    return hr >= ceiling ? (previousTicks || 0) + 1 : 0;
}

export function clampStallGuardSeconds(value, fallback = DEFAULT_STALL_GUARD_SECONDS) {
    const n = toInt(value);
    if (n === null) return fallback;
    return clamp(n, MIN_STALL_GUARD_SECONDS, MAX_STALL_GUARD_SECONDS);
}

export function clampStallPauseSeconds(value, fallback = DEFAULT_STALL_PAUSE_SECONDS) {
    const n = toInt(value);
    if (n === null) return fallback;
    return clamp(n, MIN_STALL_PAUSE_SECONDS, MAX_STALL_PAUSE_SECONDS);
}

// One 1 s tick of the stall guard.
// holdTimeoutSeconds: how long you may stay edged before the primary is cut.
// pauseTimeoutSeconds: how long that halt lasts, then crawl resumes and the
// hold window starts over. Disarm or leaving the edge clears both clocks.
export function tickStallGuard(
    { holdSeconds = 0, pauseSeconds = 0, engaged = false, seconds } = {},
    { armed = false, isEdged = false, holdTimeoutSeconds, pauseTimeoutSeconds, timeoutSeconds } = {}
) {
    const hold = Number.isFinite(holdSeconds) ? holdSeconds : (Number.isFinite(seconds) ? seconds : 0);
    const pause = Number.isFinite(pauseSeconds) ? pauseSeconds : 0;
    if (!armed || !isEdged) {
        return {
            holdSeconds: 0,
            pauseSeconds: 0,
            seconds: 0,
            engaged: false,
            justEngaged: false,
            justReleased: Boolean(engaged),
            justResumed: false
        };
    }
    const holdLimit = clampStallGuardSeconds(holdTimeoutSeconds ?? timeoutSeconds);
    const pauseLimit = clampStallPauseSeconds(pauseTimeoutSeconds);

    if (engaged) {
        const nextPause = pause + 1;
        if (nextPause >= pauseLimit) {
            return {
                holdSeconds: 0,
                pauseSeconds: 0,
                seconds: 0,
                engaged: false,
                justEngaged: false,
                justReleased: false,
                justResumed: true
            };
        }
        return {
            holdSeconds: hold,
            pauseSeconds: nextPause,
            seconds: hold,
            engaged: true,
            justEngaged: false,
            justReleased: false,
            justResumed: false
        };
    }

    const nextHold = hold + 1;
    const engagedNow = nextHold >= holdLimit;
    return {
        holdSeconds: nextHold,
        pauseSeconds: 0,
        seconds: nextHold,
        engaged: engagedNow,
        justEngaged: engagedNow,
        justReleased: false,
        justResumed: false
    };
}

// How many more 1 s ticks the current stall pause lasts before tickStallGuard
// hands the primary back; 0 when the guard is not engaged. A pause that has
// already run past a limit the wearer has just lowered ends on the very next
// tick, so an engaged guard always has at least one second left.
export function stallPauseSecondsLeft({ pauseSeconds = 0, engaged = false } = {}, { pauseTimeoutSeconds } = {}) {
    if (!engaged) return 0;
    return Math.max(1, clampStallPauseSeconds(pauseTimeoutSeconds) - wholeSeconds(pauseSeconds));
}

// ---- Ruin & Leak: one ride per edge ----------------------------------------

// Ruin & Leak keeps stroking through the edge for RUIN_RIDE_SECONDS, then
// stops dead for RUIN_LOCK_SECONDS with the secondary dropped low, so the
// wearer can leak without a full orgasm. That is ONE ride per edge. 1.1.0
// and 1.1.2 start the ride again the moment the lockout runs out, so a pulse
// that simply stays on the mark - which is what a pulse does in the minute
// after a ruined orgasm - gets 12 s at up to 74% (100% at full intensity)
// out of every 30, for as long as it stays there; since 1.1.1 each of those
// rides is a steady 59-74%. Before 1.1.0 the mode sent 0% whenever the
// wearer was edged.
//
// So the ride belongs to the edge. Once this edge has had it (`spent`), the
// primary stays at 0% after the lockout until the edge RELEASES - the pulse
// falls below the release point the engine already uses, which is exactly
// when the engine's own edge flag clears - and only then may a new edge ride.
// It is session state, not mode state: re-selecting Ruin, switching to
// another mode and back, a game toggle or a partner's MODE_CHANGE all used to
// zero it, so one tap during the lockout cancelled the dead stop and started
// a fresh ride. Only a release re-arms the ride (a lockout already running
// still runs out), and only STOP, Reset or a new session clears the clock.
//
// One 1 s tick of a RUNNING session. `active`: Ruin & Leak is the active
// mode (a game only borrows Ruin's stroke, so the ride clock does not run
// under one). `isEdged`: the engine's edge flag this second.
export function tickRuin(
    { rideSeconds = 0, lockSeconds = 0, spent = false } = {},
    { active = false, isEdged = false } = {}
) {
    let ride = Math.min(RUIN_RIDE_SECONDS, wholeSeconds(rideSeconds));
    const lock = Math.min(RUIN_LOCK_SECONDS, wholeSeconds(lockSeconds));
    let used = Boolean(spent);
    // A release re-arms the ride for the NEXT edge. It does not shorten a
    // lockout that is already running: those 18 s of dead stop are the ruin
    // itself, and a pulse that dips during them has not earned the stroker
    // back early.
    if (!isEdged) {
        ride = 0;
        used = false;
    }
    // The lockout runs down in every mode, so a wearer who leaves Ruin for a
    // minute does not come back to 18 s of dead stop they had already served.
    // Whether the primary is still held after it is the `spent` flag's job.
    if (lock > 0) return { rideSeconds: ride, lockSeconds: lock - 1, spent: used };
    if (active && isEdged && !used) {
        ride += 1;
        if (ride >= RUIN_RIDE_SECONDS) return { rideSeconds: 0, lockSeconds: RUIN_LOCK_SECONDS, spent: true };
    }
    return { rideSeconds: ride, lockSeconds: lock, spent: used };
}

// The engine has just raised its edge flag: a new edge's pullback has begun.
// It only ever raises it after a release, and a release is what re-arms the
// ride. The 1 s tick sees most releases itself, but a pulse that drops
// through the release point and crosses the mark again between two ticks
// reads to the tick as one unbroken edge; this is the engine's own word that
// it was two. It is the flag and not the edge count, which waits a reading
// longer (edge-confirm.js): the ride is part of the pullback. A lockout that
// is already running is kept: the new edge rides once it has been served.
export function startRuinEdge({ lockSeconds = 0 } = {}) {
    return { rideSeconds: 0, lockSeconds: Math.min(RUIN_LOCK_SECONDS, wholeSeconds(lockSeconds)), spent: false };
}

// How many more seconds the current ride runs if the pulse stays on the
// mark: 0 unless Ruin & Leak is the active mode, the wearer is edged, no
// lockout is running and this edge has not had its ride yet. The ride clock
// keeps running through a stall pause (the guard can cut a ride short, never
// make it longer), so this is also what decides whether a ride is still
// there to come back when a pause ends.
export function ruinRideSecondsLeft(
    { rideSeconds = 0, lockSeconds = 0, spent = false } = {},
    { active = false, isEdged = false } = {}
) {
    if (!active || !isEdged || spent || wholeSeconds(lockSeconds) > 0) return 0;
    return Math.max(0, RUIN_RIDE_SECONDS - wholeSeconds(rideSeconds));
}

// Whether the stall guard is armed this second. It only arms where it has
// something to cut: Crawl keeps the primary moving on the mark, so it arms
// there; Full Stop already parks the primary at 0%, so it does not; a game
// runs its own clock, and Force Orgasm overrides every guard.
//
// Ruin & Leak is governed by neither ceiling rule, so there the question is
// whether its RIDE is on. The guard used to be keyed to Crawl alone, and Full
// Stop disarmed it on the premise that the primary is parked at 0% - which a
// Ruin ride is not - so with Full Stop nothing could cut a ride at all.
// During the lockout, and the stop that holds after it, the primary is at 0%
// already and the guard stands down. A pause that began during the ride
// still runs its course when the ride ends underneath it, as a pause does in
// any other mode: the banner told the wearer the primary is halted for it,
// and switching to a crawling mode inside it must not bring the crawl back
// early.
export function stallGuardArmed({
    enabled = false,
    ceilingBehaviour,
    orgasmMode = false,
    activeMode,
    ruinRiding = false,
    engaged = false
} = {}) {
    if (!enabled || orgasmMode || GAME_MODES.includes(activeMode)) return false;
    if (activeMode === 'ruin') return Boolean(ruinRiding) || Boolean(engaged);
    return resolveCeilingBehaviour(ceilingBehaviour) === 'crawl';
}

// The cue ids the stall guard speaks on one tick. The factory lines for the
// end of a pause promise a crawl ("Hold window reset. Crawl."), which only a
// crawling mode gives back: in Ruin & Leak the primary goes back to the ride
// or stays in the lockout, so that cue stays silent there. And the "left the
// edge" cue ("Recovered. Resume.") is only spoken when the wearer really left
// it. The guard is also released when it is disarmed with the pulse still on
// the mark - switching from a Ruin ride to a Full Stop mode, Force Orgasm, the
// toggle - and "recovered" there tells someone still on the edge to climb.
export function stallGuardCues(
    { justEngaged = false, justResumed = false, justReleased = false } = {},
    { activeMode, isEdged = false } = {}
) {
    const cues = [];
    if (justEngaged) cues.push('stallHalt');
    if (justResumed && activeMode !== 'ruin') cues.push('stallResume');
    if (justReleased && !isEdged) cues.push('stallRecover');
    return cues;
}

// One 1 s tick of Ruin & Leak's clock and the stall guard together, in the
// order that matters: the Ruin clock first, so the guard is armed by THIS
// second's ride - on the second the ride runs out the primary is already
// back at 0%, and a guard armed by last second's ride would start a pause
// with nothing left to cut - then the guard, then the cues it earned.
export function tickRuinAndStallGuard(
    { ruin = {}, guard = {} } = {},
    {
        activeMode,
        isEdged = false,
        orgasmMode = false,
        stallGuard = false,
        ceilingBehaviour,
        holdTimeoutSeconds,
        pauseTimeoutSeconds
    } = {}
) {
    const active = activeMode === 'ruin';
    const nextRuin = tickRuin(ruin, { active, isEdged });
    const armed = stallGuardArmed({
        enabled: stallGuard,
        ceilingBehaviour,
        orgasmMode,
        activeMode,
        ruinRiding: ruinRideSecondsLeft(nextRuin, { active, isEdged }) > 0,
        engaged: Boolean(guard.engaged)
    });
    const nextGuard = tickStallGuard(guard, { armed, isEdged, holdTimeoutSeconds, pauseTimeoutSeconds });
    return { ruin: nextRuin, guard: nextGuard, cues: stallGuardCues(nextGuard, { activeMode, isEdged }) };
}

export function isSurvivalDefeated(breachTicks) {
    return (breachTicks || 0) >= SURVIVAL_BREACH_TICKS;
}

// Speed floor and how far the working ceiling sits above the typed max.
// `seconds` is time spent IN Survival, not the whole session. `edges` is
// edges counted since Survival was switched on.
export function survivalDrive({ seconds = 0, edges = 0 } = {}) {
    const t = Math.max(0, Number(seconds) || 0);
    const n = Math.max(0, Math.floor(Number(edges) || 0));
    const timeMix = t / SURVIVAL_SLOW_SPAN_SECONDS;
    const floor = clamp(Math.round(
        SURVIVAL_START_FLOOR + timeMix * SURVIVAL_TIME_SPEED + n * SURVIVAL_EDGE_SPEED
    ), 5, 100);
    const overdriveBpm = clamp(n * SURVIVAL_EDGE_BPM, 0, SURVIVAL_OVERDRIVE_CAP);
    return { floor, overdriveBpm };
}

// Which counted edges step Survival's climb. Edges from before it was
// switched on do not (1.1.2): the switch takes every edge counted so far as
// seen, and each second of Survival steps the climb once for each edge
// counted since, and sees those too (app.js). But an edge is counted a
// reading after its pullback began, once the pulse has held at the mark
// (edge-confirm.js) - 1.1.2 counted it on the reading the pullback began on -
// so the edge in progress at the switch may still be owed its count. Its
// pullback began before the switch, so it is an edge from before the switch
// however late its count comes: `owedEdgeSeen` holds that count as seen
// until it is made.
export function survivalEdgesAtSwitch({ edges = 0, isEdged = false, edgePending = false } = {}) {
    return {
        edgesSeen: Math.max(0, Math.floor(Number(edges) || 0)),
        owedEdgeSeen: Boolean(isEdged) && Boolean(edgePending)
    };
}

// Survival's seen edges after one engine call. A count made while the owed
// count is held as seen is that count - the flag has stayed up since the
// switch - and it is seen, not stepped. Made, or never to be made because the
// flag released first, it is owed no longer. A pullback that starts is a new
// edge - the flag went down somewhere in between - so it forgets the owed
// count too, and the new edge's count steps the climb.
export function survivalEdgesAfterEngine(
    { edgesSeen = 0, owedEdgeSeen = false } = {},
    { newEdgeTriggered = false, edgePending = false, pullbackStarted = false } = {}
) {
    const owed = Boolean(owedEdgeSeen) && !pullbackStarted;
    return {
        edgesSeen: Math.max(0, Math.floor(Number(edgesSeen) || 0)) + (owed && newEdgeTriggered ? 1 : 0),
        owedEdgeSeen: owed && !newEdgeTriggered && Boolean(edgePending)
    };
}

// Edge Training: climb to the pullback mark, hold there for holdGoal
// seconds, repeat until edgesGoal successful holds, then finish.
export const MIN_TRAIN_HOLD_SECONDS = 5;
export const MAX_TRAIN_HOLD_SECONDS = 90;
export const DEFAULT_TRAIN_HOLD_SECONDS = 15;
export const MIN_TRAIN_EDGES = 1;
export const MAX_TRAIN_EDGES = 20;
export const DEFAULT_TRAIN_EDGES = 5;

export function clampTrainHoldSeconds(value, fallback = DEFAULT_TRAIN_HOLD_SECONDS) {
    const n = toInt(value);
    if (n === null) return fallback;
    return clamp(n, MIN_TRAIN_HOLD_SECONDS, MAX_TRAIN_HOLD_SECONDS);
}

export function clampTrainEdges(value, fallback = DEFAULT_TRAIN_EDGES) {
    const n = toInt(value);
    if (n === null) return fallback;
    return clamp(n, MIN_TRAIN_EDGES, MAX_TRAIN_EDGES);
}

export function tickEdgeTraining(
    { state: trainState = 'climb', holdSeconds = 0, edgesDone = 0 } = {},
    { isEdged = false, released = false, holdGoal = DEFAULT_TRAIN_HOLD_SECONDS, edgesGoal = DEFAULT_TRAIN_EDGES, orgasmMode = false } = {}
) {
    const holdLimit = clampTrainHoldSeconds(holdGoal);
    const need = clampTrainEdges(edgesGoal);
    const done = Math.max(0, Number.isFinite(edgesDone) ? Math.round(edgesDone) : 0);
    const held = Math.max(0, Number.isFinite(holdSeconds) ? Math.round(holdSeconds) : 0);
    const idle = {
        justHold: false,
        justCounted: false,
        justDropped: false,
        justFinished: false,
        justRecovered: false
    };

    // Force Orgasm SUSPENDS training, it never completes it: the state, the
    // hold clock and the edge counter are handed back exactly as they were,
    // so tapping it can neither report unearned edges nor latch the game.
    if (orgasmMode) {
        return { ...idle, state: trainState, holdSeconds: held, edgesDone: done };
    }

    // Force Orgasm was cancelled after the finish. Mirroring the Oracle's
    // withdrawal (CLIMAX -> APPROACH), the game returns to the climb instead
    // of sitting in a terminal state the session can never leave. That set is
    // over, so the counter starts again from zero: keeping it at the goal
    // would let the very next completed hold re-arm Force Orgasm, seconds
    // after the wearer deliberately cancelled it, and would read N/N (then
    // N+1/N) on the dashboard. A fresh set is the Oracle's minimum-window
    // equivalent: the whole training has to be earned again.
    if (trainState === 'finish') {
        return { ...idle, state: 'climb', holdSeconds: 0, edgesDone: 0 };
    }

    if (trainState === 'hold') {
        if (!isEdged) {
            return { ...idle, state: 'recover', holdSeconds: 0, edgesDone: done, justDropped: true };
        }
        const nextHold = held + 1;
        if (nextHold >= holdLimit) {
            const nextDone = done + 1;
            if (nextDone >= need) {
                return { ...idle, state: 'finish', holdSeconds: 0, edgesDone: nextDone, justCounted: true, justFinished: true };
            }
            return { ...idle, state: 'recover', holdSeconds: 0, edgesDone: nextDone, justCounted: true };
        }
        return { ...idle, state: 'hold', holdSeconds: nextHold, edgesDone: done };
    }

    if (trainState === 'recover') {
        if (released || !isEdged) {
            return { ...idle, state: 'climb', holdSeconds: 0, edgesDone: done, justRecovered: Boolean(isEdged) || released };
        }
        return { ...idle, state: 'recover', holdSeconds: 0, edgesDone: done };
    }

    if (isEdged) {
        return { ...idle, state: 'hold', holdSeconds: 1, edgesDone: done, justHold: true };
    }
    return { ...idle, state: 'climb', holdSeconds: 0, edgesDone: done };
}

// What arriving at the endgame does to a latched Force Orgasm. The latch is
// armed earlier in the session, by the wearer or by an Oracle climax roll,
// and while it is on the motors ramp up and the ceiling climbs. Only the
// Orgasm endgame keeps it, because that ending IS the latch: a Soft Landing
// is a 45 s tease-down and would otherwise keep driving the toys, and Denied
// stops the session (which clears the latch anyway).
export function endgameKeepsOrgasmLatch(endgameType) {
    return endgameType === 'orgasm';
}

// The highest reading a crawl can give: Global Intensity scales every motor
// term by 0.5x to 1.5x, so the 10% micro-motion reaches the toys as 5-15%.
// Nothing above this is a crawl, so nothing above it may be called one.
const MAX_CRAWL_READING = Math.round(CRAWL_PERCENT * 1.5);

// One channel of the cockpit's cutoff banner, named by what the engine really
// sent it on this tick rather than by what the mode is supposed to do.
function describeCutoffChannel(label, percent) {
    if (!Number.isFinite(percent)) return `${label} UNKNOWN`;
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    if (pct === 0) return label === 'PRIMARY' ? 'PRIMARY CUT' : 'SECONDARY STOPPED';
    if (pct <= MAX_CRAWL_READING) return `${label} CRAWLING (${pct}%)`;
    return label === 'PRIMARY' ? `PRIMARY RUNNING (${pct}%)` : `SECONDARY MILKING (${pct}%)`;
}

// The cockpit's cutoff banner, as pure text: the caller paints what comes
// back and hides the banner on ''. It used to be one fixed sentence - PRIMARY
// CUT, SECONDARY MILKING ACTIVE - shown whenever the pulse sat on the mark,
// whatever the engine was doing. In Classic Tease with Full Stop both motors
// are parked at 0% and the wearer was told an idle vibrator was milking them,
// so they went looking for a broken toy or a wrong role; in Survival the
// primary is still climbing while the banner called it cut. Worse, the edge
// flag deliberately survives a pause, so a watchdog pause on a lost signal
// left the banner asserting an active secondary with every motor stopped.
// It now reports the two numbers the engine produced on this tick, and says
// nothing at all unless the session is RUNNING.
export function describeCutoffNotice({
    sessionStatus,
    isEdged = false,
    orgasmMode = false,
    stallGuardEngaged = false,
    primaryPercent,
    secondaryPercent
} = {}) {
    if (sessionStatus !== 'RUNNING') return '';
    // Force Orgasm is not a cutoff, and the stall guard raises its own
    // banner for the halt it is running.
    if (!isEdged || orgasmMode || stallGuardEngaged) return '';
    const primary = describeCutoffChannel('PRIMARY', primaryPercent);
    const secondary = describeCutoffChannel('SECONDARY', secondaryPercent);
    return `CLIMAX LIMIT REACHED: ${primary} \u2014 ${secondary}`;
}

// The cockpit's game banner, as pure text: the caller paints what comes back
// and hides the banner on ''. It is only ever a report of the state the
// session is really in - a banner that says the Oracle is still deciding, or
// that the training is still climbing, while the session is teasing down to
// a stop is worse than no banner at all.
export function describeGameNotice({
    activeMode,
    sessionStatus,
    oracleState = 'IDLE',
    oracleTimer = 0,
    trainState = 'climb',
    trainHoldSeconds = 0,
    trainEdgesDone = 0,
    trainHoldGoal,
    trainEdgesGoal,
    survivalSpeedFloor = 0,
    survivalOverdrive = 0,
    survivalCalibrating = false,
    sessionSeconds = 0,
    minSeconds = 0,
    maxSeconds = 0,
    targetSeconds = 0,
    fixedLength = false
} = {}) {
    const isGame = activeMode === 'oracle' || activeMode === 'survival' || activeMode === 'edgetrain';
    const live = sessionStatus === 'RUNNING' || sessionStatus === 'RAMPDOWN';
    if (!isGame || !live) return '';

    // A Soft Landing ends the game whichever way it was reached: the Oracle's
    // own roll sets oracleState to RAMPDOWN, but the session timer can hand
    // ANY game to the same tease-down and leaves the game state exactly where
    // it stood. Nothing is still deciding and nothing is still climbing for
    // those 45 s, so the banner says what is really happening instead.
    if (sessionStatus === 'RAMPDOWN') {
        return activeMode === 'oracle' ? 'THE ORACLE: SOFT LANDING' : 'SOFT LANDING: TEASING DOWN';
    }

    if (activeMode === 'oracle') {
        if (oracleState === 'HOLD') return `THE ORACLE: HOLDING ${oracleTimer}s — FATE PENDING`;
        if (oracleState === 'CLIMAX') return 'THE ORACLE: CLIMAX';
        if (oracleState === 'DENIAL') return 'THE ORACLE: DENIAL';
        if (oracleState === 'RAMPDOWN') return 'THE ORACLE: SOFT LANDING';
        if (oracleState === 'PURGATORY') {
            const timing = oracleTiming({ sessionSeconds, minSeconds, maxSeconds, targetSeconds, fixedLength });
            return timing.canEnd ? 'THE ORACLE: PURGATORY' : 'THE ORACLE: NOT YET — KEEP CLIMBING';
        }
        return 'THE ORACLE: APPROACHING THE CEILING';
    }

    if (activeMode === 'survival') {
        const floor = Math.round(Number.isFinite(survivalSpeedFloor) ? survivalSpeedFloor : 0);
        const over = Math.max(0, Math.round(Number.isFinite(survivalOverdrive) ? survivalOverdrive : 0));
        const mark = survivalCalibrating ? 'CALIBRATING — ' : '';
        return `SURVIVAL: ${mark}FLOOR ${floor}% — +${over} BPM`;
    }

    const need = clampTrainEdges(trainEdgesGoal);
    const done = Math.max(0, Number.isFinite(trainEdgesDone) ? Math.round(trainEdgesDone) : 0);
    if (trainState === 'hold') {
        const holdGoal = clampTrainHoldSeconds(trainHoldGoal);
        const held = Math.max(0, Number.isFinite(trainHoldSeconds) ? Math.round(trainHoldSeconds) : 0);
        return `EDGE TRAINING: HOLD ${Math.max(0, holdGoal - held)}s — ${done}/${need} EDGES`;
    }
    if (trainState === 'recover') return `EDGE TRAINING: RECOVER — ${done}/${need} EDGES`;
    if (trainState === 'finish') return 'EDGE TRAINING: COMPLETE — COME';
    return `EDGE TRAINING: CLIMB — ${done}/${need} EDGES`;
}

// The cockpit's stall-pause banner, as pure text. The banner used to be one
// fixed sentence in index.html - CRAWL RESUMES AFTER THE PAUSE - painted
// whatever mode was running. In Ruin & Leak the primary is parked at 0% by
// the mode's own lockout once its ride is over, so the wearer held at the
// pullback mark on the defaults was promised a crawl in 8 seconds that the
// mode can never give: the premise of Ruin & Leak is cutting penile input
// cold. The same sentence is wrong wherever the primary is not coming back to
// a crawl, so the banner now names what the ACTIVE mode and the "At the
// ceiling" setting will really do when the pause ends.
//
// `rideSecondsLeft` / `pauseSecondsLeft` (ruinRideSecondsLeft and
// stallPauseSecondsLeft) matter in Ruin & Leak only.
export function describeStallPauseNotice({ mode, ceilingBehaviour, rideSecondsLeft = 0, pauseSecondsLeft = 0 } = {}) {
    const halted = 'STALL PAUSE: PRIMARY HALTED';
    // Ruin & Leak is governed by neither ceiling rule. The guard is armed
    // during its ride, and the ride's clock runs on through the pause, so the
    // ride only comes back if it still has time left when the pause ends; on
    // the tick they both run out the ride ends first. Otherwise the lockout,
    // and the stop that holds after it until the edge releases, keeps the
    // primary at 0%. This banner used to say the lockout held it at 0% in
    // every case - over a ride that came back as the pause ended, and over a
    // lockout that was about to run out into a fresh ride.
    if (mode === 'ruin') {
        return rideSecondsLeft > pauseSecondsLeft
            ? `${halted} — RUIN RIDE RESUMES AFTER THE PAUSE`
            : `${halted} — RUIN LOCKOUT HOLDS IT AT 0%`;
    }
    // Survival never parks on the mark: its speed climbs on its own clock,
    // and the "At the ceiling" setting does not govern it either - so this
    // is asked BEFORE the Full Stop rule, which would otherwise promise a
    // 0% that Survival is not going to give.
    if (mode === 'survival') return `${halted} — SPEED RESUMES AFTER THE PAUSE`;
    if (resolveCeilingBehaviour(ceilingBehaviour) !== 'crawl') return `${halted} — FULL STOP HOLDS IT AT 0%`;
    return `${halted} — CRAWL RESUMES AFTER THE PAUSE`;
}

// ---- Cool-down after edges -------------------------------------------------

// The Guards choices: how long the cool-down after an edge lasts (0 is Off)
// and after every how-manieth edge it starts. The engine restarts the session
// warm-up curve over that length; the rules below only decide WHEN.
export const COOLDOWN_MINUTES_OPTIONS = [0, 1, 2, 3, 5];
export const COOLDOWN_EVERY_OPTIONS = [1, 2, 3];
export const DEFAULT_COOLDOWN_MINUTES = 0;
export const DEFAULT_COOLDOWN_EVERY_EDGES = 2;

// The two things that count as an edge for the cool-down: the pulse leaving
// the pullback mark, and the wearer resuming after an edge pause.
export const COOLDOWN_EVENTS = ['release', 'edgeResume'];

// The cool-down's length in seconds, or null when it is Off or the stored
// value is not one the wearer could have chosen. A length nobody picked must
// not hold the toys slow, so junk reads as Off here and in cooldownSecondsFor.
function cooldownLength(minutes) {
    return COOLDOWN_MINUTES_OPTIONS.includes(minutes) && minutes > 0 ? minutes * 60 : null;
}

// May an edge start a cool-down right now? Only in a running tease mode the
// engine eases (COOLDOWN_MODES), never during Force Orgasm - the wearer asked
// for full speed - and never in a soft landing or a pause, where the toys are
// already teasing down or stopped and a cool-down clock would run unseen.
export function cooldownEligible({ activeMode, orgasmMode = false, sessionStatus } = {}) {
    return sessionStatus === 'RUNNING' && !orgasmMode && COOLDOWN_MODES.includes(activeMode);
}

// One event of the cool-down counter, called on every edge release, on every
// resume from an edge pause and once a second with no event, to expire it.
// `prev` is { count, startedAt }: the edges counted this session and the
// session second the running cool-down began, or null. A counted edge that
// lands on the chosen rhythm starts a cool-down at this second, restarting
// one already running: the pulse was just at the mark again, so the easing
// begins again from its slowest point. The count is kept whatever the
// length setting says, so the rhythm the wearer chose is measured from the
// first edge of the session and not from the moment a cool-down first ran.
export function tickCooldown(
    prev,
    { event = null, countsAsEdge = true, sessionSeconds, minutes, every, eligible = false } = {}
) {
    const count0 = prev && Number.isFinite(prev.count) ? Math.max(0, Math.round(prev.count)) : 0;
    const t = Number.isFinite(sessionSeconds) ? sessionSeconds : null;
    const length = cooldownLength(minutes);
    let startedAt = prev && Number.isFinite(prev.startedAt) ? prev.startedAt : null;

    // Expire: the cool-down has run its length, or nothing can say where it
    // stands (Off, a stored start after the present, no clock). A cool-down
    // with an end nobody can compute is dropped rather than left to hold the
    // toys slow, and one stamped in the future is dropped rather than kept
    // to spring on the wearer minutes later.
    if (startedAt !== null && (length === null || t === null || t < startedAt || t - startedAt >= length)) {
        startedAt = null;
    }

    let count = count0;
    let justStarted = false;
    if (COOLDOWN_EVENTS.includes(event) && countsAsEdge && eligible) {
        count += 1;
        const rhythm = COOLDOWN_EVERY_OPTIONS.includes(every) ? every : DEFAULT_COOLDOWN_EVERY_EDGES;
        if (count % rhythm === 0 && length !== null && t !== null) {
            startedAt = t;
            justStarted = true;
        }
    }
    return { count, startedAt, justStarted };
}

// How far into the running cool-down this second is: the number the engine
// takes as `cooldownSeconds`. null means no cool-down is in force, which the
// engine reads as "the factors are 1". It is null, and never a guess, when
// there is no start, when the length is Off or junk, when the start lies
// after the present, and once the length has run out - so the engine is
// never handed a second that warmupShape would read as its slowest point.
export function cooldownSecondsFor({ startedAt, sessionSeconds, minutes } = {}) {
    const length = cooldownLength(minutes);
    if (length === null || !Number.isFinite(startedAt) || !Number.isFinite(sessionSeconds)) return null;
    const elapsed = sessionSeconds - startedAt;
    if (elapsed < 0 || elapsed >= length) return null;
    return elapsed;
}

// The cockpit badge, as pure text: the time the cool-down has left, in the
// warm-up badge's own m:ss form, or '' when none is running so the caller
// hides it. It never reads 0:00 - the second the length runs out the
// cool-down is over and the badge is gone.
export function describeCooldownBadge({ startedAt, sessionSeconds, minutes } = {}) {
    const elapsed = cooldownSecondsFor({ startedAt, sessionSeconds, minutes });
    if (elapsed === null) return '';
    const left = Math.ceil(minutes * 60 - elapsed);
    return `COOL-DOWN ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

// ---- Persisted Session Setup values ---------------------------------------

// Resting / Climax HR, the duration window and the Endgame Trigger are typed
// into plain inputs and are remembered between sessions like every other
// setting. A STORED value is never trusted more than a typed one: it goes
// back through the same validators (sanitizeHrLimits, parseSessionDuration)
// on the way in AND on the way out, so a corrupt or hand-edited store can
// only ever restore limits the wearer could have typed themselves.
export const DURATION_MODES = ['fixed', 'range', 'endless'];
export const ENDGAME_TYPES = ['orgasm', 'rampdown', 'denial'];
export const DEFAULT_DURATION_MODE = 'range';
export const DEFAULT_FIXED_MINUTES = 30;
export const DEFAULT_RANGE_MIN_MINUTES = 25;
export const DEFAULT_RANGE_MAX_MINUTES = 45;
export const DEFAULT_ENDGAME_TYPE = 'orgasm';

// The typed HR pair, clamped for storage by exactly the validator the typed
// fields already go through: a stored pair is never treated more harshly, or
// more leniently, than one the wearer types, so what comes back after a
// reload is the pair they left. A pair sanitizeHrLimits refuses (either field
// outside 30-250, or a ceiling at or below the resting rate) falls back to
// the factory pair rather than being repaired into something nobody chose.
// A narrow but legal pair is restored as typed and NOT widened: the release
// band is the engine's business (resolveEdgeTriggerHr simply pulls back at
// the ceiling when the band is too tight) and MIN_CEILING_GAP is enforced
// where it belongs, inside computeEffectiveCeiling, which only ever lowers
// the working ceiling. Moving the Resting HR here would quietly change a
// setting the wearer typed - and widening the tease band raises the rising
// secondary channel (`20 + progress * 80`) at every heart rate.
export function sanitizeStoredHrLimits(rawMin, rawMax) {
    const limits = sanitizeHrLimits(rawMin, rawMax, { minHr: DEFAULT_MIN_HR, maxHr: DEFAULT_MAX_HR });
    if (!limits.valid) return { minHr: DEFAULT_MIN_HR, maxHr: DEFAULT_MAX_HR };
    return { minHr: limits.minHr, maxHr: limits.maxHr };
}

// The duration window, validated by the same parser the Session Setup fields
// go through at START. A length that parser refuses falls back to the factory
// one for that field; an unknown mode falls back to Mystery.
export function sanitizeStoredDuration({
    durationMode,
    durationFixedMinutes,
    durationMinMinutes,
    durationMaxMinutes
} = {}) {
    const fixedOk = parseSessionDuration({ mode: 'fixed', fixedMinutes: durationFixedMinutes }).valid;
    const rangeOk = parseSessionDuration({
        mode: 'range',
        minMinutes: durationMinMinutes,
        maxMinutes: durationMaxMinutes,
        random: () => 0
    }).valid;
    return {
        durationMode: DURATION_MODES.includes(durationMode) ? durationMode : DEFAULT_DURATION_MODE,
        durationFixedMinutes: fixedOk ? toInt(durationFixedMinutes) : DEFAULT_FIXED_MINUTES,
        durationMinMinutes: rangeOk ? toInt(durationMinMinutes) : DEFAULT_RANGE_MIN_MINUTES,
        durationMaxMinutes: rangeOk ? toInt(durationMaxMinutes) : DEFAULT_RANGE_MAX_MINUTES
    };
}

export function sanitizeStoredEndgame(value) {
    return ENDGAME_TYPES.includes(value) ? value : DEFAULT_ENDGAME_TYPE;
}

// One entry point for the whole set, used on load, on every write and on
// import, so the stored form and the typed form can never drift apart. It is
// idempotent: sanitizing an already sanitized set returns it unchanged.
export function sanitizeSessionLimits(stored = {}) {
    return {
        ...sanitizeStoredHrLimits(stored.minHr, stored.maxHr),
        ...sanitizeStoredDuration(stored),
        endgameType: sanitizeStoredEndgame(stored.endgameType)
    };
}
