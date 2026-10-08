/**
 * Core Biofeedback calculation engine.
 * Every cockpit data-mode must exist in ENGINE_MODES or it falls back to classic.
 *
 * Pure: no DOM, no I/O. Fail-safe by construction: any non-finite input
 * yields zero motor output, the stroke zone can never invert or collapse,
 * an edge is only released once the pulse has clearly come back down, and
 * only counted once the pulse has held at the mark.
 */
import { normalizeEnvelope } from './hardware/handy-protocol.js';
import { teaseFrame, warmupShape, combineWake, placeStroke, orgasmFrame, roundSpeed } from './patterns.js';
import { isConfirmedEdge } from './edge-confirm.js';
import { scriptAllowance, scriptSecondary, sanitizeScriptSettings, MAX_REJOIN_SECONDS } from './player/script-governor.js';

export const TEASE_MODES = ['classic', 'milker', 'shortener', 'headplay', 'ultimate', 'ruin'];
export const GAME_MODES = ['oracle', 'survival', 'edgetrain'];

// The modes in which a cool-down after an edge is allowed to ease the toys
// back in. Ruin & Leak is left out because its premise is a cold cut and a
// timed lockout of its own, and the games are left out because they run their
// own speeds against the pulse: a cool-down slowing the Oracle's approach or
// a Survival floor would change what the game promised.
//
// Script mode is in the list because its rejoin ramp after an edge IS this
// cool-down, on the Script tab's length in seconds (cooldownShape('script',
// secondsSinceRelease, rejoinSeconds / 60)); script-governor.js computes the
// same curve. The Guards tab's minutes-long cool-down is not started in
// Script mode (session-rules.js cooldownEligible), and the script branch
// below never reads `cooldownSeconds`.
export const COOLDOWN_MODES = ['classic', 'milker', 'shortener', 'headplay', 'ultimate', 'script'];

export function resolveTeaseMode(strokeMode, activeMode) {
    if (TEASE_MODES.includes(strokeMode)) return strokeMode;
    if (TEASE_MODES.includes(activeMode)) return activeMode;
    return 'classic';
}

export const ENGINE_MODES = [
    'classic',
    'milker',
    'shortener',
    'headplay',
    'ultimate',
    'ruin',
    'oracle',
    'survival',
    'edgetrain',
    // The wearer's own funscript, played with the pulse as the limiter
    // (player/script-governor.js): the primary channel is the ALLOWANCE,
    // how much of the script the toy may play.
    'script'
];

// Hysteresis: once edged, the flag only clears when HR drops MORE than this
// many BPM below the typed climax ceiling, so a reading hovering at the
// limit cannot flap the motors on and off or count phantom edges.
export const EDGE_RELEASE_BPM = 5;

// Pullback as a percent of the working Climax HR. 100% is that ceiling; 95%
// pulls back early. It can never be more than 100%: the typed Climax HR is a
// hard ceiling, so the crawl / Full Stop rule and the stall guard must fire
// at it or below it, never above it.
export const MIN_EDGE_HOLD_PERCENT = 90;
export const MAX_EDGE_HOLD_PERCENT = 100;
export const DEFAULT_EDGE_HOLD_PERCENT = 100;

export function clampEdgeHoldPercent(value, fallback = DEFAULT_EDGE_HOLD_PERCENT) {
    const n = typeof value === 'number' ? Math.round(value) : parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, MIN_EDGE_HOLD_PERCENT, MAX_EDGE_HOLD_PERCENT);
}

// The pullback mark. It is bounded at both ends: never above the working
// ceiling, and never so low that its release band (EDGE_RELEASE_BPM below it)
// falls to the resting rate, which would latch the session edged from the
// first reading with a release point the wearer can never reach. With a typed
// band too narrow for that margin the mark simply sits at the ceiling.
export function resolveEdgeTriggerHr(maxHr, holdPercent = DEFAULT_EDGE_HOLD_PERCENT, minHr) {
    if (!Number.isFinite(maxHr)) return maxHr;
    const pct = clampEdgeHoldPercent(holdPercent, DEFAULT_EDGE_HOLD_PERCENT);
    const raw = Math.max(1, Math.round(maxHr * (pct / 100)));
    const capped = Math.min(maxHr, raw);
    if (!Number.isFinite(minHr)) return capped;
    const lowest = Math.min(maxHr, minHr + EDGE_RELEASE_BPM + 1);
    return Math.max(capped, lowest);
}

// The Guards preview line. The pullback mark is NOT always the percentage
// of the ceiling: `resolveEdgeTriggerHr` lifts it whenever that percentage
// would land inside the release band above the resting rate, and a preview
// that still quoted the percentage described a number it was no longer
// producing ("Pullback at 94 BPM (90% of 95)" for a Resting 88 / Climax 95
// pair, where 90% of 95 is 86 - a resting rate sitting close under the low
// Climax HR the README sends prostate users to). It now says what actually
// happened instead.
export function describeEdgeHoldPreview({ typedMaxHr, workingMaxHr, minHr, holdPercent } = {}) {
    const pct = clampEdgeHoldPercent(holdPercent, DEFAULT_EDGE_HOLD_PERCENT);
    const max = Number.isFinite(workingMaxHr) ? workingMaxHr : typedMaxHr;
    if (!Number.isFinite(max)) return 'Pullback mark: type a Resting and a Climax HR first.';
    const trigger = resolveEdgeTriggerHr(max, pct, minHr);
    const base = max === typedMaxHr ? `${typedMaxHr}` : `${max}, the working ceiling right now`;
    // The mark the percentage alone would give, before the resting-rate floor.
    const fromPercent = Math.min(max, Math.max(1, Math.round(max * (pct / 100))));
    if (trigger === fromPercent) {
        return `Pullback at ${trigger} BPM (${pct}% of ${base})`;
    }
    const baseMid = max === typedMaxHr ? `${typedMaxHr}` : `${max}, the working ceiling right now,`;
    return `Pullback at ${trigger} BPM - ${pct}% of ${baseMid} is ${fromPercent}, `
        + `lifted to clear your Resting HR (${minHr})`;
}

export function edgeReleaseHr(maxHr, triggerHr) {
    if (!Number.isFinite(maxHr)) return maxHr;
    const top = Number.isFinite(triggerHr) ? Math.min(maxHr, triggerHr) : maxHr;
    return top - EDGE_RELEASE_BPM;
}

// The narrowest stroke zone (percent of the hardware envelope) the engine
// will ever emit. Anything tighter jams the sleeve in place.
export const MIN_ZONE_WIDTH = 10;

// Primary / secondary speed while parked at the ceiling in Crawl mode
// (ceilingBehaviour 'crawl'); Full Stop ('stop') parks at 0%.
export const CRAWL_PERCENT = 10;
export const CEILING_BEHAVIOURS = ['stop', 'crawl'];

// Glans Protector: the stroke zone contracts from the full range at rest
// toward 0-SHORTENER_TOP_PERCENT (base micro-strokes) at the ceiling.
export const SHORTENER_TOP_PERCENT = 35;

export function resolveCeilingBehaviour(value) {
    return value === 'stop' ? 'stop' : 'crawl';
}

export function resolveEngineMode(mode) {
    return ENGINE_MODES.includes(mode) ? mode : 'classic';
}

// The cool-down's wake-up factors: the session warm-up curve, restarted at
// the edge. `cooldownSeconds` is how far into the cool-down this tick is and
// `cooldownMinutes` its length; null seconds or zero minutes means there is
// no cool-down, and the factors are 1 so the output is exactly today's.
//
// The gate is strict on purpose. warmupShape reads a NaN or negative second
// as second zero, its SLOWEST point, so a caller that handed over a stale or
// broken clock would pin the toys at 16% speed with no cool-down running and
// nothing on the cockpit to say why. Only a finite second at or after the
// start, a positive length and a mode that allows a cool-down count.
export function cooldownShape(mode, cooldownSeconds, cooldownMinutes) {
    const none = { speed: 1, depth: 1 };
    if (!COOLDOWN_MODES.includes(mode)) return none;
    if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 0) return none;
    if (!Number.isFinite(cooldownMinutes) || cooldownMinutes <= 0) return none;
    return warmupShape(cooldownSeconds, cooldownMinutes);
}

// Does the microphone boost reach a motor in this mode? The boost rides on
// `hr`, which drives the falling tease curve and the stroke-depth
// contraction that shares it; every term that RISES with arousal reads the
// measured pulse (`edgeHr`) instead. The two climb games compute BOTH
// channels from the measured pulse and fix their stroke zone per game state,
// so there the boosted pulse reaches nothing at all and a cockpit badge
// promising "MIC +N" promises a push nothing is making - the wearer goes off
// and adjusts the gate and the cap, and nothing changes. Survival runs its
// speeds off its own clock and lets the boost contract the stroke zone only,
// which is a no-op at full depth.
export function micBoostReachesMotors(activeMode, { edgeStrokeDepth = 100 } = {}) {
    const mode = resolveEngineMode(activeMode);
    if (mode === 'oracle' || mode === 'edgetrain') return false;
    if (mode === 'survival') return clamp(finiteOr(Number(edgeStrokeDepth), 100), 0, 100) < 100;
    return true;
}

export function hasReleasedEdge(hr, maxHr, triggerHr) {
    const release = edgeReleaseHr(maxHr, triggerHr);
    return Number.isFinite(hr) && Number.isFinite(release) && hr < release;
}

// The release question the Oracle and Edge Training ask once a second, and
// the ONLY way they may ask it. `hasReleasedEdge` falls back to `maxHr - 5`
// when it is handed no pullback mark, and with any pullback below 100% that
// band sits ABOVE the mark: the game would clear the edge flag while the
// engine still reads the pulse as edged, and the next tick counts an invented
// edge that Adaptive Ceiling Decay then acts on. A mark that is not a finite
// number is not an answer, so this refuses to say "released" rather than
// guessing one - `state.edgeTriggerHr` starts as null, and a caller that
// reaches this before the engine's first tick must get "no", not a fallback.
//
// Force Orgasm is the same answer here as it is inside the engine: no. The
// overdrive raises the working ceiling 1 BPM per second and the release band
// rides up with it, so after a few seconds a pulse parked ON the mark reads
// as "released" against a ceiling that only moved because the wearer armed
// the button. calculateEngineOutputs freezes the edge flag for exactly that
// reason; a game asking its own release question has to get the same answer,
// or cancelling Force Orgasm counts an edge the pulse never gave.
export function gameEdgeReleased(hr, maxHr, triggerHr, { orgasmMode = false } = {}) {
    if (orgasmMode) return false;
    if (!Number.isFinite(triggerHr)) return false;
    return hasReleasedEdge(hr, maxHr, triggerHr);
}

function finiteOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

// Order, clamp and widen the hardware envelope. An inverted pair is swapped
// (not collapsed) so a hand-edited 90/10 still yields 10-90 of travel.
function safeEnvelope(hwMin, hwMax) {
    const a = Number(hwMin);
    const b = Number(hwMax);
    const lo = Number.isFinite(a) ? a : 0;
    const hi = Number.isFinite(b) ? b : 100;
    return normalizeEnvelope(Math.min(lo, hi), Math.max(lo, hi));
}

export function calculateEngineOutputs({
    hr,
    // The sensor's own pulse. `hr` may carry the microphone boost, which
    // drives the FALLING tease curve and the stroke-depth contraction that
    // shares it (`strokeMax` everywhere, plus `strokeMin` in Glans Protector
    // and Head Play): more progress there means less motion, so the boost can
    // only ever back the toys off. The edge flag, every guard, game and
    // counter, the two climb games' rising ramps and every RISING secondary
    // (milker) term all judge `edgeHr`, the pulse that was actually measured.
    edgeHr,
    minHr,
    maxHr,
    activeMode,
    sessionStatus,
    rampdownSecondsLeft,
    // What the toys were last sent when the soft landing under way began,
    // exactly as it was dispatched ({ primary, secondary }), if that landing
    // took over from a Force Orgasm run; null for any other landing (app.js
    // beginSoftLanding). The landing then never sends more than that, eased
    // down on its own clock (landingCap).
    landingFrom = null,
    isEdged,
    // The edge flag is up, and the pullback with it, but the edge has not
    // been counted yet: the pulse has not held at the mark (edge-confirm.js).
    // Carried from call to call beside the flag. It defaults to false, so a
    // caller that hands over an edge in progress without it hands over one
    // already counted, and can never make the engine count it twice.
    edgePending = false,
    // The last few valid readings of the SENSOR, oldest first, as { at, bpm },
    // and the signal-loss timeout in ms. Only the count reads them: no motor
    // waits for them.
    recentReadings = [],
    readingGapMs,
    orgasmMode,
    // Seconds since Force Orgasm's ramp began: at the arming, and again at
    // a RESUME, which starts it over from the stop (app.js). The ceiling
    // already climbs 1 BPM per second from this; the motors ramp on the
    // same clock.
    orgasmBoost = 0,
    // What the toys were last sent when that ramp began, exactly as it was
    // dispatched: { primary, secondary, strokeMin, strokeMax }, the stroke in
    // percent of the physical travel. The ramp starts from it (rampOrigin).
    orgasmFrom = null,
    gamma = 2.0,
    intensityValue = 50,
    edgeStrokeDepth = 100,
    handyHwMin = 0,
    handyHwMax = 100,
    sessionSeconds = 0,
    warmupMinutes = 0,
    stallGuardEngaged = false,
    ceilingBehaviour = 'crawl',
    edgeHoldPercent = DEFAULT_EDGE_HOLD_PERCENT,
    // Ruin & Leak's own clock (session-rules.js tickRuin): seconds of
    // lockout left, and whether the current edge has already had its ride.
    ruinHoldSeconds = 0,
    ruinSpent = false,
    strokeMode,
    oracleState = 'IDLE',
    survivalSpeedFloor = 30,
    trainingState = 'climb',
    // Seconds into the cool-down that follows an edge (null: none running)
    // and the length the wearer chose (0: Off). See cooldownShape.
    cooldownSeconds = null,
    cooldownMinutes = 0,
    // Script mode only. The Script tab's settings (script-governor.js
    // DEFAULT_SCRIPT_SETTINGS keys; each goes through its sanitizer here),
    // and the session second the edge flag last cleared, or null: the start
    // of the rejoin ramp. The caller carries it from call to call as this
    // returns it (`scriptReleasedAt`), the way it carries the edge flag.
    scriptSettings = null,
    scriptReleasedAt = null
}) {
    const mode = resolveEngineMode(activeMode);
    const teaseMode = resolveTeaseMode(strokeMode, mode);
    // The hardware envelope is normalised here so an inverted, narrow or
    // garbage envelope (hand-edited settings) can never invert the zone.
    const env = safeEnvelope(handyHwMin, handyHwMax);
    const silent = {
        primaryPercent: 0,
        secondaryPercent: 0,
        strokeMinPercent: env.min,
        strokeMaxPercent: env.max,
        isEdged: false,
        edgePending: false,
        pullbackStarted: false,
        newEdgeTriggered: false,
        resolvedMode: mode
    };
    // What a call that decides nothing hands back: the edge flag as it was,
    // and a count still owed with it. Only an edge in progress can be owed
    // a count.
    const heldEdge = { isEdged: Boolean(isEdged), edgePending: Boolean(isEdged) && Boolean(edgePending) };
    // Script mode's rejoin stamp is state as well, and is held the same way.
    if (mode === 'script') heldEdge.scriptReleasedAt = Number.isFinite(scriptReleasedAt) ? scriptReleasedAt : null;

    // Motors are silent in every other status, but the edge flag is state,
    // not output: clearing it here would re-arm the detector, so the first
    // RUNNING tick after a pause (including every watchdog auto-resume) would
    // count the edge the wearer is still sitting on as a brand-new one. An
    // edge still waiting to be counted keeps waiting through the pause: held
    // after it, it is counted then, and never twice.
    if (sessionStatus !== 'RUNNING' && sessionStatus !== 'RAMPDOWN') {
        return { ...silent, ...heldEdge };
    }

    // Fail safe: a NaN heart rate or limit stops the motors and keeps the
    // edge flag as it was (bad data must never release an edge either).
    if (!Number.isFinite(hr) || !Number.isFinite(minHr) || !Number.isFinite(maxHr)) {
        return { ...silent, ...heldEdge };
    }

    const gammaSafe = Number.isFinite(gamma) && gamma > 0 ? gamma : 2.0;
    const intensitySafe = clamp(finiteOr(intensityValue, 50), 0, 100);
    const depthSafe = clamp(finiteOr(edgeStrokeDepth, 100), 0, 100);
    const rampLeft = clamp(finiteOr(rampdownSecondsLeft, 0), 0, 45);
    const seconds = Math.max(0, finiteOr(sessionSeconds, 0));

    let nextIsEdged = heldEdge.isEdged;
    let nextPending = heldEdge.edgePending;
    let pullbackStarted = false;
    let newEdgeTriggered = false;

    const triggerHr = resolveEdgeTriggerHr(maxHr, edgeHoldPercent, minHr);
    const edgeSource = Number.isFinite(edgeHr) ? edgeHr : hr;

    // Force Orgasm FREEZES the edge flag; it never clears it. The overdrive
    // raises the working ceiling 1 BPM per second, and the pullback mark
    // rides up with it, so after a few seconds a pulse parked ON the mark
    // sits below the release band of a ceiling that only moved because the
    // wearer armed the button. Releasing the edge on that evidence counted a
    // phantom edge the moment they cancelled - the counter, the edge cue, a
    // rotator reversal and Adaptive Ceiling Decay - while the pulse had
    // never left the mark. New edges were already suppressed here; releases
    // are too, so the flag stays whatever the pulse last really said and the
    // first tick after a cancel judges it against the real ceiling again.
    if (edgeSource >= triggerHr) {
        if (!isEdged && !orgasmMode && sessionStatus !== 'RAMPDOWN') {
            pullbackStarted = true;
            nextIsEdged = true;
            nextPending = true;
        }
    } else if (!orgasmMode && hasReleasedEdge(edgeSource, maxHr, triggerHr)) {
        nextIsEdged = false;
        nextPending = false;
    }

    // The pullback starts above, on the first reading at the mark, exactly
    // as it always has: every motor term below reads the flag. The EDGE is
    // counted here, and only once the pulse has held at the mark - this
    // reading and the one before it both at or above it, with no signal loss
    // between them and no spike standing in for either (edge-confirm.js).
    // One reading used to be enough, so a glitch or the top of a posture
    // spike was an edge: a step of Adaptive Ceiling Decay for the rest of the
    // session, a step of Survival's climb, a reversed rotator, the edge cue
    // and a game's hold, for an edge that never happened. The count waits one
    // more reading, and an edge whose flag is released first is never counted
    // at all. It is only ever made where an edge can start: Force Orgasm
    // freezes a count still owed along with the flag, to be judged against
    // the real mark once it is cancelled, and a Soft Landing counts none.
    if (
        nextPending
        && !orgasmMode
        && sessionStatus !== 'RAMPDOWN'
        && edgeSource >= triggerHr
        && isConfirmedEdge(recentReadings, triggerHr, { maxGapMs: readingGapMs })
    ) {
        newEdgeTriggered = true;
        nextPending = false;
    }

    // Script mode: everything above - the mark, the pullback, the release
    // band, the count - is the edge logic every mode shares, untouched. What
    // follows replaces the tease curve: the primary is the allowance, the
    // share of the wearer's script the toy may play (script-governor.js), and
    // the governor already applies the warm-up (its speed factor only), the
    // stall guard, Global Intensity, Force Orgasm and the Soft Landing on it,
    // number for number as the code below does for the other modes. None of
    // that runs again here, or the allowance would be scaled twice.
    if (mode === 'script') {
        return scriptOutputs({
            hr,
            triggerHr,
            wasEdged: heldEdge.isEdged,
            isEdged: nextIsEdged,
            edgePending: nextPending,
            pullbackStarted,
            newEdgeTriggered,
            sessionStatus,
            seconds,
            warmupMinutes,
            stallGuardEngaged,
            orgasmMode,
            orgasmBoost,
            orgasmFrom,
            rampLeft,
            landingFrom,
            intensityValue: intensitySafe,
            releasedAt: heldEdge.scriptReleasedAt,
            settings: scriptSettings,
            env
        });
    }

    // The tease band runs from the resting rate to the pullback mark, so the
    // curve reaches 0% exactly where crawl / Full Stop takes over. The mark is
    // never above the working ceiling, so neither is the band.
    const span = Math.max(1, triggerHr - minHr);
    const rawProgress = clamp((hr - minHr) / span, 0, 1);
    const progress = Math.pow(rawProgress, gammaSafe);
    // The same curve on the MEASURED pulse, for every term that RISES with
    // progress. Each tease mode maps progress onto a falling primary, so the
    // boost can only ever back that channel off. But the climb games invert
    // it (`48 + progress * 52`), and the milking modes cross-fade a rising
    // secondary against that falling primary (`20 + progress * 80`): fed the
    // boosted pulse, both drive a motor UP on nothing but room noise - the
    // primary to 100% for the last BPM of the approach, the internal toy from
    // a measured 26-30 to 52-60. Every rising term reads the sensor alone, so
    // the microphone can only ever ease the toys off, on either channel.
    const sensorRawProgress = clamp((edgeSource - minHr) / span, 0, 1);
    const climbProgress = Math.pow(sensorRawProgress, gammaSafe);

    let primaryPercent = 0;
    let secondaryPercent = 0;
    let strokeMinPercent = 0;
    let strokeMaxPercent = 100;

    const depthContractAmount = 100 - depthSafe;
    // At the ceiling the user chooses Full Stop (0%) or Crawl (CRAWL_PERCENT).
    const crawl = resolveCeilingBehaviour(ceilingBehaviour) === 'crawl';
    const crawlPercent = crawl ? CRAWL_PERCENT : 0;

    // Stall guard only ever cuts the PRIMARY stroker: the secondary
    // channel keeps whatever the mode gives it at the ceiling.
    //
    // Ruin's lockout belongs to Ruin as the ACTIVE mode. A game only borrows
    // Ruin's stroke; the Ruin clock now survives a game being switched on
    // (so switching one on and off again cannot hand out a second ride), and
    // passing it through here would have given that game Ruin's ending too.
    //
    // A spent edge holds its stop for as long as the edge flag says the
    // wearer is still on it, and the flag is what gates it. Force Orgasm
    // used to clear `atPeak`, and gating on that handed its ramp a fresh ride
    // on the first tick - 0% to about 43% - where over the lockout it climbs
    // from the stop.
    //
    // Everything down to the travel envelope is the output WITHOUT Force
    // Orgasm, ceiling rule, stall guard, warm-up and cool-down included: what
    // the toys are being sent while it is off. The overdrive is applied last,
    // on that output, and never reshapes the mode underneath it.
    const ruinActive = mode === 'ruin';
    const teaseArgs = {
        mode: teaseMode,
        rawProgress: clamp((hr - minHr) / span, 0, 1),
        shapedProgress: progress,
        sensorRaw: sensorRawProgress,
        climbProgress,
        atPeak: nextIsEdged,
        crawlPercent,
        stallGuardEngaged,
        seconds,
        ruinHoldSeconds: ruinActive ? ruinHoldSeconds : 0,
        ruinSpent: ruinActive && Boolean(ruinSpent) && nextIsEdged
    };
    const stroke = teaseFrame(teaseArgs);
    const isGame = mode === 'oracle' || mode === 'survival' || mode === 'edgetrain';

    if (sessionStatus === 'RAMPDOWN') {
        const rampFactor = Math.max(0, rampLeft / 45);
        primaryPercent = Math.round(50 * rampFactor);
        secondaryPercent = Math.round(50 * rampFactor);
    } else if (mode === 'oracle') {
        const oracle = applyOracle(oracleState, climbProgress, nextIsEdged, orgasmMode, seconds, crawlPercent);
        primaryPercent = oracle.primary;
        secondaryPercent = oracle.secondary;
    } else if (mode === 'survival') {
        const floor = clamp(finiteOr(survivalSpeedFloor, 30), 5, 100);
        // Force Orgasm ramps from this floor; it does not replace it with a flat 100.
        primaryPercent = floor;
        secondaryPercent = Math.round(floor * 0.7);
    } else if (mode === 'edgetrain') {
        const train = applyEdgeTrain(trainingState, climbProgress, nextIsEdged, orgasmMode, crawlPercent);
        primaryPercent = train.primary;
        secondaryPercent = train.secondary;
    } else {
        const tease = isGame ? stroke : teaseFrame({ ...teaseArgs, mode });
        primaryPercent = tease.primary;
        secondaryPercent = tease.secondary;
    }

    // Games keep their own speeds. The stroke always comes from the tease
    // mode the wearer selected, then the warm-up and the envelope below
    // can only shrink it further. A game used to substitute its own zone.
    strokeMinPercent = stroke.strokeMin;
    strokeMaxPercent = stroke.strokeMax;

    if (stallGuardEngaged && sessionStatus === 'RUNNING') {
        primaryPercent = 0;
    }

    // Wake-up: a resting pulse used to mean full speed on the first tick.
    // Over the warm-up the wearer set, speed and stroke length ease in from
    // a short slow stroke. The stroke still starts at the bottom of whatever
    // window the mode asked for, which is already inside the travel envelope.
    // The ease slows a speed down and never stops it: at the first minutes'
    // factor (0.16) a speed of 3% or less rounded to 0, and a default
    // warm-up held at 139 BPM on a 70/140 band sent The Handy 17-19 stop /
    // start pairs. A stop decided above (the stall guard, Full Stop) is 0
    // and stays 0.
    //
    // A cool-down after an edge is the same easing, restarted at the edge:
    // the pulse has just been at the pullback mark, and full speed on the
    // first tick after it is what tips a wearer over. The two shapes are
    // combined by the smaller factor, so a cool-down can only slow the toys
    // and shorten the stroke, never speed anything up, and with no cool-down
    // running the factors are the warm-up's own. The edge flag was decided
    // above and is not read here, so the cool-down can never move it.
    let warmZone = null;
    if (sessionStatus === 'RUNNING') {
        const warm = warmupShape(seconds, warmupMinutes);
        const cool = cooldownShape(mode, cooldownSeconds, cooldownMinutes);
        const wake = combineWake(warm, cool);
        if (wake.depth < 1 || wake.speed < 1) {
            // Where the cool-down is the tighter shape, keep the zone the
            // warm-up alone would have given: the cooled zone is held inside
            // it once both are settled below. With no cool-down running, or
            // one looser than the warm-up, nothing is kept and the zone is
            // exactly today's.
            if (cool.depth < warm.depth) {
                warmZone = (warm.depth < 1 || warm.speed < 1)
                    ? placeStroke(strokeMinPercent, strokeMaxPercent, warm.depth, 'low')
                    : { min: strokeMinPercent, max: strokeMaxPercent };
            }
            const woken = placeStroke(strokeMinPercent, strokeMaxPercent, wake.depth, 'low');
            strokeMinPercent = woken.min;
            strokeMaxPercent = woken.max;
            primaryPercent = roundSpeed(primaryPercent * wake.speed);
            secondaryPercent = roundSpeed(secondaryPercent * wake.speed);
        }
    }

    // Optional stored stroke-depth contraction. Default depth is the full
    // window, so this is a no-op until a backup carries a smaller value.
    // It reads the boosted curve, so a louder room can only shorten travel.
    const contraction = depthContractAmount > 0 ? progress * depthContractAmount : null;

    // Global Intensity scales both channels by 0.5-1.5x. Like the warm-up it
    // may slow a motion down but never round it into a stop.
    const intensityScale = 0.5 + (intensitySafe / 100);
    primaryPercent = roundSpeed(primaryPercent * intensityScale);
    secondaryPercent = roundSpeed(secondaryPercent * intensityScale);

    // A soft landing that takes over from a Force Orgasm run eases down from
    // what the toys were last sent whenever that is slower than the landing's
    // own start, half speed scaled by Global Intensity. A RESUME starts the
    // run's ramp again from the stop the pause sent (app.js) while its time
    // limit keeps counting from the arming, so a run paused in its last
    // seconds - a strap slipping at the moment of orgasm is enough for the
    // watchdog - runs out with the ramp still low. The landing then took a
    // toy that had only just started moving again, or had not moved at all,
    // to 50% in one tick (75% at full intensity) while the cue said it was
    // easing the wearer down, and the Soft Landing ending or an Oracle roll
    // arriving in those seconds did the same. Each channel now starts at the
    // lower of the two and eases down on the landing's own factor: the first
    // second sends no more than was sent, and no second after it sends more
    // than the one before (Global Intensity aside). A run at its top is sent
    // more than the landing's start on both channels (78-100% and 70-100% of
    // full speed, scaled the same way), and lands exactly as it always has.
    if (sessionStatus === 'RAMPDOWN' && landingFrom && typeof landingFrom === 'object') {
        primaryPercent = Math.min(primaryPercent, landingCap(landingFrom.primary, rampLeft));
        secondaryPercent = Math.min(secondaryPercent, landingCap(landingFrom.secondary, rampLeft));
    }

    const settled = settleZone(strokeMinPercent, strokeMaxPercent, contraction);
    strokeMinPercent = settled.min;
    strokeMaxPercent = settled.max;

    // A cool-down may only ever shorten the stroke the wearer would have had
    // without it, and settling the cooled zone on its own does not promise
    // that: placeStroke rounds the window's ends before it shrinks, so a
    // factor within half a percent of 1 can hand back a top a fraction ABOVE
    // the unrounded one, which the contraction then rounds into a whole
    // percent; and the width floor pulls a zone that came out too narrow
    // DOWN, so the cooled zone sits at a different height than the warm-up's
    // and the rounding onto a narrow travel envelope can make it a physical
    // percent longer. So the cooled zone is held inside the zone the warm-up
    // alone gives, settled the same way, and widened UPWARD inside it when
    // the floor asks. Inside that zone every percent of travel is one the
    // wearer would have been stroked over anyway, and a zone inside another
    // stays inside it through the rounding onto the envelope below.
    if (warmZone) {
        const bound = settleZone(warmZone.min, warmZone.max, contraction);
        strokeMinPercent = Math.max(strokeMinPercent, bound.min);
        strokeMaxPercent = Math.min(strokeMaxPercent, bound.max);
        if (strokeMaxPercent - strokeMinPercent < MIN_ZONE_WIDTH) {
            strokeMaxPercent = Math.min(bound.max, strokeMinPercent + MIN_ZONE_WIDTH);
        }
    }

    const envSpan = env.max - env.min;
    // The wearer's travel limits are the last word. A mode, a pattern, a
    // game, warm-up, or Force Orgasm can use less of that range. None of
    // them can stroke past it.
    const toTravel = (percent) => clamp(Math.round(env.min + (percent / 100) * envSpan), env.min, env.max);
    let physicalMin = toTravel(strokeMinPercent);
    let physicalMax = toTravel(strokeMaxPercent);
    if (physicalMax < physicalMin) [physicalMin, physicalMax] = [physicalMax, physicalMin];

    // Force Orgasm eases both channels and the stroke from what the toys
    // were last sent to a high varied top over ORGASM_RAMP_SECONDS, and keeps
    // a wave there. The working ceiling climbs on the same clock (app.js), so
    // the pulse is allowed past the typed max until the wearer finishes.
    //
    // The ramp starts from the output as it was DISPATCHED, and the easing is
    // done on that output. 1.1.1 blended from the mode's own speeds worked
    // out again with no ceiling rule, no warm-up and no cool-down, so the
    // first tick was never what the toys were doing: armed on the mark with
    // Crawl it handed The Handy 0% (PUT /hamp/stop, and /hamp/start a second
    // or so later), and armed 12 s into a five-minute warm-up at 95 BPM it
    // jumped from 13% to 75% in one tick. Easing from the output itself, the
    // first tick sends exactly what was sent, and each second after it adds
    // one ORGASM_RAMP_SECONDS-th of the way from there to the top. The top
    // never drops below a third of full speed on either channel, whatever
    // Global Intensity says, so a toy that was moving is never handed 0% on
    // the way, and one that was stopped starts from the stop.
    if (orgasmMode && sessionStatus === 'RUNNING') {
        const frame = orgasmFrame(seconds, orgasmBoost);
        const full = placeStroke(0, 100, frame.depth, 'low');
        const top = settleZone(full.min, full.max, contraction);
        const from = rampOrigin(orgasmFrom, env, {
            primary: primaryPercent, secondary: secondaryPercent, min: physicalMin, max: physicalMax
        });
        const toward = (sent, peak) => sent + (peak - sent) * frame.ease;
        primaryPercent = roundSpeed(toward(from.primary, roundSpeed(frame.primary * intensityScale)));
        secondaryPercent = roundSpeed(toward(from.secondary, roundSpeed(frame.secondary * intensityScale)));
        physicalMin = clamp(Math.round(toward(from.min, toTravel(top.min))), env.min, env.max);
        physicalMax = clamp(Math.round(toward(from.max, toTravel(top.max))), env.min, env.max);
    }

    return {
        primaryPercent: clamp(finiteOr(primaryPercent, 0), 0, 100),
        secondaryPercent: clamp(finiteOr(secondaryPercent, 0), 0, 100),
        strokeMinPercent: physicalMin,
        strokeMaxPercent: Math.max(physicalMin, physicalMax),
        isEdged: nextIsEdged,
        edgePending: nextPending,
        pullbackStarted,
        newEdgeTriggered,
        resolvedMode: mode
    };
}

// The rejoin stamp for this tick: the session second the edge flag cleared,
// carried from the last tick, restarted when it clears on this one, and
// dropped once no rejoin ramp can still be running (MAX_REJOIN_SECONDS) or
// when it lies after the present (a stamp from an earlier session). A seek
// does not touch it: a scrub is not an edge.
export function nextScriptRelease(releasedAt, { wasEdged = false, isEdged = false, seconds } = {}) {
    if (!Number.isFinite(seconds)) return null;
    let stamp = Number.isFinite(releasedAt) ? releasedAt : null;
    if (wasEdged && !isEdged) stamp = seconds;
    if (stamp === null) return null;
    const since = seconds - stamp;
    if (since < 0 || since >= MAX_REJOIN_SECONDS) return null;
    return stamp;
}

// Script mode's outputs (calculateEngineOutputs' script branch):
//   primary    the allowance (scriptAllowance), 0-100
//   secondary  the limiter at 60% (scriptSecondary), or 0 with the second
//              channel Off
//   zone       the whole travel envelope: the shaper maps the script into it,
//              so no tease zone and no warm-up depth apply
// plus `script`, the governor's answer (phase, approach, rejoin) for the
// status line, and `scriptReleasedAt` for the caller to carry.
function scriptOutputs({
    hr, triggerHr, wasEdged, isEdged, edgePending, pullbackStarted, newEdgeTriggered,
    sessionStatus, seconds, warmupMinutes, stallGuardEngaged, orgasmMode, orgasmBoost, orgasmFrom,
    rampLeft, landingFrom, intensityValue, releasedAt, settings, env
}) {
    const script = sanitizeScriptSettings(settings);
    const stamp = nextScriptRelease(releasedAt, { wasEdged, isEdged, seconds });
    const governed = scriptAllowance({
        hr,
        triggerHr,
        isEdged,
        sessionStatus,
        sessionSeconds: seconds,
        warmupMinutes,
        // The stall guard only ever holds a RUNNING session's primary, as in
        // every other mode; a landing runs its own course.
        stallGuardEngaged: Boolean(stallGuardEngaged) && sessionStatus === 'RUNNING',
        orgasmMode: Boolean(orgasmMode) && sessionStatus === 'RUNNING',
        orgasmBoost,
        orgasmFrom,
        rampdownSecondsLeft: rampLeft,
        landingFrom,
        intensityValue,
        sinceReleaseSeconds: stamp === null ? null : seconds - stamp,
        settings: script
    });
    const primary = clamp(finiteOr(governed.allowance, 0), 0, 100);
    return {
        primaryPercent: primary,
        secondaryPercent: clamp(finiteOr(scriptSecondary(primary, script.scriptSecondChannel), 0), 0, 100),
        strokeMinPercent: env.min,
        strokeMaxPercent: env.max,
        isEdged,
        edgePending,
        pullbackStarted,
        newEdgeTriggered,
        resolvedMode: 'script',
        script: governed,
        scriptReleasedAt: stamp
    };
}

// One stroke zone, in percent of the envelope, brought to its final shape:
// the stored stroke-depth contraction (`contraction` is the cut in percent,
// or null when the depth is the full window), then the zone sanity. Whatever
// the mode and the wake-up did, the zone must stay ordered and at least
// MIN_ZONE_WIDTH wide. The cap (upper bound) wins, so the lower bound is
// pulled down first; only when the cap itself sits below the minimum width is
// it raised.
function settleZone(min, max, contraction) {
    let lo = min;
    let hi = max;
    if (contraction !== null) hi = Math.max(lo, Math.round(hi - contraction));
    lo = clamp(Math.round(finiteOr(lo, 0)), 0, 100);
    hi = clamp(Math.round(finiteOr(hi, 100)), 0, 100);
    if (hi - lo < MIN_ZONE_WIDTH) {
        lo = Math.max(0, hi - MIN_ZONE_WIDTH);
        if (hi - lo < MIN_ZONE_WIDTH) hi = Math.min(100, lo + MIN_ZONE_WIDTH);
    }
    return { min: lo, max: hi };
}

// Where Force Orgasm's ramp starts: what the toys were last sent, as the
// caller dispatched it. Only the caller knows that - a pause, a stop or a
// stall halt sent the toys something this second's inputs no longer show.
// `unforced` is the output this engine sends without Force Orgasm this
// second, which for a caller that runs it every second is what was sent;
// each part of the origin the caller cannot vouch for is taken from it
// instead. A speed that is not a number is no speed. The window is held
// inside the travel envelope as it is now (a stop is dispatched over the
// whole travel, and the wearer may narrow the envelope in the middle of a
// ramp), and one left narrower there than the narrowest zone this engine
// ever sends is no window: the speeds that were sent still stand.
function rampOrigin(from, env, unforced) {
    const sent = from && typeof from === 'object' ? from : {};
    const speed = (value, fallback) => (Number.isFinite(value) ? clamp(roundSpeed(value), 0, 100) : fallback);
    const origin = {
        primary: speed(sent.primary, unforced.primary),
        secondary: speed(sent.secondary, unforced.secondary),
        min: unforced.min,
        max: unforced.max
    };
    if (Number.isFinite(sent.strokeMin) && Number.isFinite(sent.strokeMax)) {
        const lo = clamp(Math.round(Math.min(sent.strokeMin, sent.strokeMax)), env.min, env.max);
        const hi = clamp(Math.round(Math.max(sent.strokeMin, sent.strokeMax)), env.min, env.max);
        const narrowest = Math.max(1, Math.floor(((env.max - env.min) * MIN_ZONE_WIDTH) / 100));
        if (hi - lo >= narrowest) {
            origin.min = lo;
            origin.max = hi;
        }
    }
    return origin;
}

// The most one channel of a landing that took over from Force Orgasm may
// send this second: what that channel was last sent when the landing began,
// eased down by the landing's own factor. The factor is counted in the same
// fiftieths as the landing's half speed (the RAMPDOWN branch above), so a
// channel that was sent at least the landing's start caps nothing, down to
// the last rounding. A value that is not a speed caps nothing either, and
// that channel lands as any landing does.
function landingCap(sent, rampLeft) {
    if (!Number.isFinite(sent)) return Infinity;
    const steps = Math.round(50 * Math.max(0, rampLeft / 45));
    return roundSpeed((steps * roundSpeed(sent)) / 50);
}

function applyOracle(oracleState, progress, nextIsEdged, orgasmMode, sessionSeconds, crawlPercent = CRAWL_PERCENT) {
    const out = { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 };
    // Force Orgasm is applied once, after this, so a climax ramps instead of
    // replacing the game with a flat 100. `orgasmMode` stays on the signature
    // so a caller cannot forget the flag exists; the ramp reads it.
    void orgasmMode;
    // Every Oracle state below HOLD is reached with the wearer parked at the
    // pullback mark (app.js only enters HOLD from `state.isEdged`, and the
    // flag is not cleared until the pulse drops out of the release band), so
    // the wearer's "At the ceiling" rule decides the primary there exactly as
    // it does in Edge Training and every tease mode: Full Stop parks it at
    // 0%, Crawl keeps the micro-motion. Force Orgasm ramps over that after
    // this function returns. The stall guard is disarmed for this mode, so
    // nothing else would.
    // The secondary channel keeps the game's own level.
    switch (oracleState) {
        case 'HOLD':
            out.primary = crawlPercent;
            out.secondary = 55;
            out.strokeMax = 70;
            break;
        case 'DENIAL':
            out.primary = 0;
            out.secondary = 0;
            out.strokeMax = 40;
            break;
        case 'PURGATORY': {
            const swing = 28 + Math.round(32 * (0.5 + 0.5 * Math.sin(sessionSeconds * 1.3)));
            out.primary = nextIsEdged ? crawlPercent : swing;
            out.secondary = 40 + Math.round(30 * (0.5 + 0.5 * Math.sin(sessionSeconds * 0.8)));
            out.strokeMax = 80;
            break;
        }
        // CLIMAX is reached with Force Orgasm ON (app.js arms it with the
        // roll). The ramp above lifts that. Reaching CLIMAX with it OFF
        // means the wearer cancelled: app.js hands the game back to APPROACH
        // on the very next tick. A withdrawn climax IS the approach, so it
        // settles there immediately instead of surging.
        case 'CLIMAX':
        case 'APPROACH':
        default: {
            const pull = Math.round(48 + progress * 52);
            out.primary = nextIsEdged ? crawlPercent : pull;
            out.secondary = nextIsEdged ? 40 : Math.round(30 + progress * 50);
            out.strokeMax = 100;
        }
    }
    return out;
}

function applyEdgeTrain(trainingState, progress, nextIsEdged, orgasmMode, crawlPercent = CRAWL_PERCENT) {
    const out = { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 };
    // Same as Oracle: Force Orgasm ramps after the game picks a speed.
    void orgasmMode;
    // 'finish' is the completed set, and app.js arms Force Orgasm with it.
    // The ramp lifts that. Reaching 'finish' with Force Orgasm OFF means the
    // wearer cancelled. tickEdgeTraining hands the game back to the climb on
    // the next tick; the switch below sends 'finish' down the climb branch,
    // so the cancel settles immediately instead of surging.
    //
    // A training hold is a hold AT the pullback mark, so the wearer's
    // ceiling rule decides the primary there exactly as it does in every
    // other mode: Full Stop parks it at 0%, Crawl keeps the micro-motion.
    // Force Orgasm ramps over that after this function returns. The secondary channel is not
    // governed by that rule and keeps the game's own level.
    switch (trainingState) {
        case 'hold':
            out.primary = crawlPercent;
            out.secondary = 55;
            out.strokeMax = 70;
            break;
        case 'recover':
            // Recover is still a hold at the mark: tickEdgeTraining only
            // leaves it once the pulse has dropped out of the release band,
            // so the ceiling rule governs the primary here exactly as it
            // does in the hold. A dead stop is the premise of Ruin & Leak,
            // not of recover - a wearer who picked Crawl because a full stop
            // kills their edge was given 0% after every counted hold.
            out.primary = crawlPercent;
            out.secondary = 35;
            out.strokeMax = 55;
            break;
        default: {
            const pull = Math.round(48 + progress * 52);
            out.primary = nextIsEdged ? crawlPercent : pull;
            out.secondary = nextIsEdged ? 40 : Math.round(30 + progress * 50);
            out.strokeMax = 100;
        }
    }
    return out;
}
