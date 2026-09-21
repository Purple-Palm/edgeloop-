// Pure session rules shared by the cockpit: the effective heart-rate ceiling
// (typed limit minus every safety offset), HR-limit sanitising, duration
// parsing and the Survival breach counter. No DOM and no storage, so all of
// it runs under node:test.

// The one thing this file reads from the engine: the crawl level, so the
// cockpit banner can tell a crawling motor from a running one with the same
// number the engine sends.
import { CRAWL_PERCENT } from './engine.js';

// The effective ceiling can never be pushed closer than this to the resting
// HR, otherwise the tease band collapses into a permanent cut-off.
export const MIN_CEILING_GAP = 15;

// Force Orgasm raises the working ceiling by 1 BPM per second so the edge
// detector stops firing; the raise is capped so an overdrive left running
// cannot drift the ceiling into nonsense territory.
export const ORGASM_BOOST_CAP = 60;

// Survival Mode only ends after this many consecutive READINGS at or above
// the ceiling, so a single HR-sensor spike cannot end the game.
export const SURVIVAL_BREACH_TICKS = 3;

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
// typed value); only the explicit Force Orgasm boost may raise it.
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
    orgasmBoost = 0
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
    max += boost;

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

export function parseSessionDuration({ mode, fixedMinutes, minMinutes, maxMinutes, random = Math.random }) {
    if (mode === 'endless') return emptyDuration();

    const toMinutes = (value) => {
        const n = toInt(value);
        return n !== null && n > 0 ? n : null;
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

export function isSurvivalDefeated(breachTicks) {
    return (breachTicks || 0) >= SURVIVAL_BREACH_TICKS;
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
// and the engine's orgasm override floors the primary at 85% and pins the
// secondary at 100% for as long as it is on. Only the Orgasm endgame keeps
// it, because that ending IS the latch: a Soft Landing is a 45 s tease-down
// and would otherwise run at full speed from its first second to its last,
// and Denied stops the session (which clears the latch anyway).
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
        return `SURVIVAL: FLOOR ${floor}% — STAY UNDER YOUR LIMIT`;
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
