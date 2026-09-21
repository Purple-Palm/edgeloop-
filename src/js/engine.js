/**
 * Core Biofeedback calculation engine.
 * Every cockpit data-mode must exist in ENGINE_MODES or it falls back to classic.
 *
 * Pure: no DOM, no I/O. Fail-safe by construction: any non-finite input
 * yields zero motor output, the stroke zone can never invert or collapse,
 * and an edge is only released once the pulse has clearly come back down.
 */
import { normalizeEnvelope } from './hardware/handy-protocol.js';

export const ENGINE_MODES = [
    'classic',
    'milker',
    'shortener',
    'headplay',
    'ultimate',
    'ruin',
    'oracle',
    'survival',
    'edgetrain'
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

export function hasReleasedEdge(hr, maxHr, triggerHr) {
    const release = edgeReleaseHr(maxHr, triggerHr);
    return Number.isFinite(hr) && Number.isFinite(release) && hr < release;
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
    // drives the speed curve only; the edge flag, and every guard, game and
    // counter that reads it, must judge the pulse that was measured.
    edgeHr,
    minHr,
    maxHr,
    activeMode,
    sessionStatus,
    rampdownSecondsLeft,
    isEdged,
    orgasmMode,
    gamma = 2.0,
    intensityValue = 50,
    edgeStrokeDepth = 100,
    handyHwMin = 0,
    handyHwMax = 100,
    sessionSeconds = 0,
    warmupMinutes = 0,
    cadenceBreathing = false,
    milkingWave = false,
    stallGuardEngaged = false,
    ceilingBehaviour = 'crawl',
    edgeHoldPercent = DEFAULT_EDGE_HOLD_PERCENT,
    ruinHoldSeconds = 0,
    oracleState = 'IDLE',
    survivalSpeedFloor = 30,
    trainingState = 'climb'
}) {
    const mode = resolveEngineMode(activeMode);
    // The hardware envelope is normalised here so an inverted, narrow or
    // garbage envelope (hand-edited settings) can never invert the zone.
    const env = safeEnvelope(handyHwMin, handyHwMax);
    const silent = {
        primaryPercent: 0,
        secondaryPercent: 0,
        strokeMinPercent: env.min,
        strokeMaxPercent: env.max,
        isEdged: false,
        newEdgeTriggered: false,
        resolvedMode: mode
    };

    if (sessionStatus !== 'RUNNING' && sessionStatus !== 'RAMPDOWN') {
        return silent;
    }

    // Fail safe: a NaN heart rate or limit stops the motors and keeps the
    // edge flag as it was (bad data must never release an edge either).
    if (!Number.isFinite(hr) || !Number.isFinite(minHr) || !Number.isFinite(maxHr)) {
        return { ...silent, isEdged: Boolean(isEdged) };
    }

    const gammaSafe = Number.isFinite(gamma) && gamma > 0 ? gamma : 2.0;
    const intensitySafe = clamp(finiteOr(intensityValue, 50), 0, 100);
    const depthSafe = clamp(finiteOr(edgeStrokeDepth, 100), 0, 100);
    const rampLeft = clamp(finiteOr(rampdownSecondsLeft, 0), 0, 45);
    const seconds = Math.max(0, finiteOr(sessionSeconds, 0));

    let nextIsEdged = Boolean(isEdged);
    let newEdgeTriggered = false;

    const triggerHr = resolveEdgeTriggerHr(maxHr, edgeHoldPercent, minHr);
    const edgeSource = Number.isFinite(edgeHr) ? edgeHr : hr;

    if (edgeSource >= triggerHr) {
        if (!isEdged && !orgasmMode && sessionStatus !== 'RAMPDOWN') {
            newEdgeTriggered = true;
            nextIsEdged = true;
        }
    } else if (hasReleasedEdge(edgeSource, maxHr, triggerHr)) {
        nextIsEdged = false;
    }

    // The tease band runs from the resting rate to the pullback mark, so the
    // curve reaches 0% exactly where crawl / Full Stop takes over. The mark is
    // never above the working ceiling, so neither is the band.
    const span = Math.max(1, triggerHr - minHr);
    const rawProgress = clamp((hr - minHr) / span, 0, 1);
    const progress = Math.pow(rawProgress, gammaSafe);

    let primaryPercent = 0;
    let secondaryPercent = 0;
    let strokeMinPercent = 0;
    let strokeMaxPercent = 100;

    const depthContractAmount = 100 - depthSafe;
    // At the ceiling the user chooses Full Stop (0%) or Crawl (CRAWL_PERCENT).
    const crawl = resolveCeilingBehaviour(ceilingBehaviour) === 'crawl';
    const crawlPercent = crawl ? CRAWL_PERCENT : 0;

    // Stall guard only ever cuts the PRIMARY stroker: the secondary (milker)
    // channel keeps whatever the mode gives it at the ceiling.
    const applyClassicTease = () => {
        const atPeak = nextIsEdged && !orgasmMode;
        if (atPeak && crawl) {
            primaryPercent = stallGuardEngaged ? 0 : crawlPercent;
            secondaryPercent = crawlPercent;
        } else if (atPeak) {
            primaryPercent = 0;
            secondaryPercent = 0;
        } else {
            const val = Math.round((1.0 - progress) * 100);
            primaryPercent = val;
            secondaryPercent = val;
        }
        strokeMaxPercent = Math.round(100 - (progress * depthContractAmount));
    };

    if (sessionStatus === 'RAMPDOWN') {
        const rampFactor = Math.max(0, rampLeft / 45);
        primaryPercent = Math.round(50 * rampFactor);
        secondaryPercent = Math.round(50 * rampFactor);
        strokeMaxPercent = Math.max(25, Math.round(100 - (1.0 - rampFactor) * depthContractAmount));
    } else if (mode === 'oracle') {
        const oracle = applyOracle(oracleState, progress, nextIsEdged, orgasmMode, seconds, crawlPercent);
        primaryPercent = oracle.primary;
        secondaryPercent = oracle.secondary;
        strokeMinPercent = oracle.strokeMin;
        strokeMaxPercent = oracle.strokeMax;
    } else if (mode === 'survival') {
        const floor = clamp(finiteOr(survivalSpeedFloor, 30), 5, 100);
        primaryPercent = orgasmMode ? 100 : floor;
        secondaryPercent = orgasmMode ? 100 : Math.round(floor * 0.7);
        strokeMaxPercent = Math.round(100 - (progress * depthContractAmount * 0.4));
    } else if (mode === 'edgetrain') {
        const train = applyEdgeTrain(trainingState, progress, nextIsEdged, orgasmMode, crawlPercent);
        primaryPercent = train.primary;
        secondaryPercent = train.secondary;
        strokeMinPercent = train.strokeMin;
        strokeMaxPercent = train.strokeMax;
    } else if (mode === 'classic') {
        applyClassicTease();
    } else if (mode === 'milker') {
        if (nextIsEdged && !orgasmMode) {
            primaryPercent = stallGuardEngaged ? 0 : crawlPercent;
            secondaryPercent = 100;
        } else {
            primaryPercent = Math.round((1.0 - progress) * 100);
            secondaryPercent = Math.round(20 + (progress * 80));
        }
        strokeMaxPercent = Math.round(100 - (progress * depthContractAmount));
    } else if (mode === 'shortener') {
        // Full length at rest, base micro-strokes (0-35%) at the ceiling.
        applyClassicTease();
        strokeMinPercent = 0;
        const shortenerSpan = 100 - SHORTENER_TOP_PERCENT;
        strokeMaxPercent = Math.max(SHORTENER_TOP_PERCENT, Math.round(100 - (progress * shortenerSpan)));
    } else if (mode === 'headplay') {
        applyClassicTease();
        strokeMinPercent = Math.min(75, Math.round(progress * 75));
        strokeMaxPercent = 100;
    } else if (mode === 'ultimate') {
        if (nextIsEdged && !orgasmMode) {
            primaryPercent = stallGuardEngaged ? 0 : crawlPercent;
            secondaryPercent = 100;
            strokeMaxPercent = Math.max(25, depthSafe);
        } else {
            primaryPercent = Math.round((1.0 - progress) * 100);
            secondaryPercent = Math.round(20 + (progress * 80));
            strokeMaxPercent = Math.max(25, Math.round(100 - (progress * depthContractAmount)));
        }
    } else if (mode === 'ruin') {
        if ((nextIsEdged || ruinHoldSeconds > 0) && !orgasmMode) {
            primaryPercent = 0;
            secondaryPercent = 100;
            strokeMaxPercent = 25;
        } else {
            primaryPercent = Math.round((1.0 - progress) * 100);
            secondaryPercent = Math.round(20 + (progress * 60));
        }
    } else {
        applyClassicTease();
    }

    if (orgasmMode) {
        primaryPercent = Math.max(primaryPercent, 85);
        secondaryPercent = 100;
        strokeMinPercent = 0;
        strokeMaxPercent = 100;
    }

    if (stallGuardEngaged && !orgasmMode && sessionStatus === 'RUNNING') {
        primaryPercent = 0;
    }

    const warmupSeconds = Math.max(0, finiteOr(warmupMinutes, 0)) * 60;
    if (warmupSeconds > 0 && seconds < warmupSeconds && !orgasmMode && sessionStatus === 'RUNNING') {
        const warmT = seconds / warmupSeconds;
        const warmCap = 55 + (45 * warmT);
        strokeMaxPercent = Math.min(strokeMaxPercent, Math.round(warmCap));
        const speedScale = 0.45 + (0.55 * warmT);
        primaryPercent = Math.round(primaryPercent * speedScale);
        secondaryPercent = Math.round(secondaryPercent * speedScale);
    }

    if (sessionStatus === 'RUNNING' && !orgasmMode && !stallGuardEngaged) {
        if (cadenceBreathing && (mode === 'ultimate' || mode === 'classic')) {
            const wave = 0.5 + 0.5 * Math.sin((seconds * Math.PI) / 4);
            if (primaryPercent > 0) {
                primaryPercent = Math.round(primaryPercent * (0.82 + 0.18 * wave));
            }
        }
        if (milkingWave && (mode === 'ultimate' || mode === 'milker' || mode === 'ruin')) {
            const wave = 0.5 + 0.5 * Math.sin((seconds * Math.PI) / 3);
            if (secondaryPercent > 0) {
                secondaryPercent = Math.round(secondaryPercent * (0.72 + 0.28 * wave));
            }
        }
    }

    const intensityScale = 0.5 + (intensitySafe / 100);
    if (primaryPercent > 0) {
        primaryPercent = Math.min(100, Math.round(primaryPercent * intensityScale));
    }
    if (secondaryPercent > 0) {
        secondaryPercent = Math.min(100, Math.round(secondaryPercent * intensityScale));
    }

    // Zone sanity: whatever the mode and warm-up cap did, the zone must stay
    // ordered and at least MIN_ZONE_WIDTH wide. The cap (upper bound) wins,
    // so the lower bound is pulled down first; only when the cap itself sits
    // below the minimum width is it raised.
    strokeMinPercent = clamp(Math.round(finiteOr(strokeMinPercent, 0)), 0, 100);
    strokeMaxPercent = clamp(Math.round(finiteOr(strokeMaxPercent, 100)), 0, 100);
    if (strokeMaxPercent - strokeMinPercent < MIN_ZONE_WIDTH) {
        strokeMinPercent = Math.max(0, strokeMaxPercent - MIN_ZONE_WIDTH);
        if (strokeMaxPercent - strokeMinPercent < MIN_ZONE_WIDTH) {
            strokeMaxPercent = Math.min(100, strokeMinPercent + MIN_ZONE_WIDTH);
        }
    }

    const envSpan = env.max - env.min;
    const physicalMin = Math.round(env.min + (strokeMinPercent / 100) * envSpan);
    const physicalMax = Math.round(env.min + (strokeMaxPercent / 100) * envSpan);

    return {
        primaryPercent: clamp(finiteOr(primaryPercent, 0), 0, 100),
        secondaryPercent: clamp(finiteOr(secondaryPercent, 0), 0, 100),
        strokeMinPercent: physicalMin,
        strokeMaxPercent: Math.max(physicalMin, physicalMax),
        isEdged: nextIsEdged,
        newEdgeTriggered,
        resolvedMode: mode
    };
}

function applyOracle(oracleState, progress, nextIsEdged, orgasmMode, sessionSeconds, crawlPercent = CRAWL_PERCENT) {
    const out = { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 };
    if (orgasmMode) {
        out.primary = 100;
        out.secondary = 100;
        return out;
    }
    switch (oracleState) {
        case 'HOLD':
            out.primary = 14;
            out.secondary = 55;
            out.strokeMax = 70;
            break;
        case 'CLIMAX':
            // Reached only with Force Orgasm off (app.js switches it on with
            // the roll): the wearer cancelled it, so the climax is withdrawn
            // and the ceiling rule (Full Stop / Crawl) applies like anywhere.
            out.primary = nextIsEdged ? crawlPercent : 100;
            out.secondary = nextIsEdged ? crawlPercent : 100;
            break;
        case 'DENIAL':
            out.primary = 0;
            out.secondary = 0;
            out.strokeMax = 40;
            break;
        case 'PURGATORY': {
            const swing = 28 + Math.round(32 * (0.5 + 0.5 * Math.sin(sessionSeconds * 1.3)));
            out.primary = swing;
            out.secondary = 40 + Math.round(30 * (0.5 + 0.5 * Math.sin(sessionSeconds * 0.8)));
            out.strokeMax = 80;
            break;
        }
        case 'APPROACH':
        default: {
            const pull = Math.round(48 + progress * 52);
            out.primary = nextIsEdged ? 14 : pull;
            out.secondary = nextIsEdged ? 40 : Math.round(30 + progress * 50);
            out.strokeMax = 100;
        }
    }
    return out;
}

function applyEdgeTrain(trainingState, progress, nextIsEdged, orgasmMode, crawlPercent = CRAWL_PERCENT) {
    const out = { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 };
    if (orgasmMode) {
        out.primary = 100;
        out.secondary = 100;
        return out;
    }
    if (trainingState === 'finish') {
        out.primary = nextIsEdged ? crawlPercent : 100;
        out.secondary = nextIsEdged ? crawlPercent : 100;
        return out;
    }
    // A training hold is a hold AT the pullback mark, so the wearer's
    // ceiling rule decides the primary there exactly as it does in every
    // other mode: Full Stop parks it at 0%, Crawl keeps the micro-motion.
    // Only Force Orgasm (above) overrides it. The secondary channel is not
    // governed by that rule and keeps the game's own level.
    switch (trainingState) {
        case 'hold':
            out.primary = crawlPercent;
            out.secondary = 55;
            out.strokeMax = 70;
            break;
        case 'recover':
            out.primary = 0;
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
