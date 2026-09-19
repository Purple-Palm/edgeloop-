/**
 * Core Biofeedback calculation engine.
 * Every cockpit data-mode must exist in ENGINE_MODES or it falls back to classic.
 */
export const ENGINE_MODES = [
    'classic',
    'milker',
    'shortener',
    'headplay',
    'ultimate',
    'ruin',
    'oracle',
    'survival'
];

export function resolveEngineMode(mode) {
    return ENGINE_MODES.includes(mode) ? mode : 'classic';
}

export function calculateEngineOutputs({
    hr,
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
    stallGuardEnabled = false,
    ruinHoldSeconds = 0,
    oracleState = 'IDLE',
    survivalSpeedFloor = 30
}) {
    const mode = resolveEngineMode(activeMode);
    if (sessionStatus !== 'RUNNING' && sessionStatus !== 'RAMPDOWN') {
        return {
            primaryPercent: 0,
            secondaryPercent: 0,
            strokeMinPercent: handyHwMin,
            strokeMaxPercent: handyHwMax,
            isEdged: false,
            newEdgeTriggered: false,
            resolvedMode: mode
        };
    }

    let nextIsEdged = isEdged;
    let newEdgeTriggered = false;

    if (hr >= maxHr) {
        if (!isEdged && !orgasmMode && sessionStatus !== 'RAMPDOWN') {
            newEdgeTriggered = true;
            nextIsEdged = true;
        }
    } else if (hr < (maxHr - 5)) {
        nextIsEdged = false;
    }

    const span = Math.max(1, maxHr - minHr);
    const rawProgress = Math.max(0, Math.min(1, (hr - minHr) / span));
    const progress = Math.pow(rawProgress, gamma);

    let primaryPercent = 0;
    let secondaryPercent = 0;
    let strokeMinPercent = 0;
    let strokeMaxPercent = 100;

    const depthContractAmount = 100 - edgeStrokeDepth;
    const crawlPercent = 12;

    const applyClassicTease = () => {
        const atPeak = nextIsEdged && !orgasmMode;
        if (atPeak && stallGuardEngaged) {
            primaryPercent = 0;
            secondaryPercent = 0;
        } else if (atPeak && stallGuardEnabled) {
            primaryPercent = crawlPercent;
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
        const rampFactor = Math.max(0, rampdownSecondsLeft / 45);
        primaryPercent = Math.round(50 * rampFactor);
        secondaryPercent = Math.round(50 * rampFactor);
        strokeMaxPercent = Math.max(25, Math.round(100 - (1.0 - rampFactor) * depthContractAmount));
    } else if (mode === 'oracle') {
        const oracle = applyOracle(oracleState, progress, nextIsEdged, orgasmMode, sessionSeconds);
        primaryPercent = oracle.primary;
        secondaryPercent = oracle.secondary;
        strokeMinPercent = oracle.strokeMin;
        strokeMaxPercent = oracle.strokeMax;
    } else if (mode === 'survival') {
        const floor = Math.max(5, Math.min(100, survivalSpeedFloor));
        primaryPercent = orgasmMode ? 100 : floor;
        secondaryPercent = orgasmMode ? 100 : Math.round(floor * 0.7);
        strokeMaxPercent = Math.round(100 - (progress * depthContractAmount * 0.4));
    } else if (mode === 'classic') {
        applyClassicTease();
    } else if (mode === 'milker') {
        if (nextIsEdged && !orgasmMode) {
            primaryPercent = stallGuardEngaged ? 0 : (stallGuardEnabled ? crawlPercent : 0);
            secondaryPercent = stallGuardEngaged ? 0 : 100;
        } else {
            primaryPercent = Math.round((1.0 - progress) * 100);
            secondaryPercent = Math.round(20 + (progress * 80));
        }
        strokeMaxPercent = Math.round(100 - (progress * depthContractAmount));
    } else if (mode === 'shortener') {
        applyClassicTease();
        strokeMinPercent = 0;
        strokeMaxPercent = Math.max(25, Math.round(100 - (progress * 75)));
    } else if (mode === 'headplay') {
        applyClassicTease();
        strokeMinPercent = Math.min(75, Math.round(progress * 75));
        strokeMaxPercent = 100;
    } else if (mode === 'ultimate') {
        if (nextIsEdged && !orgasmMode) {
            primaryPercent = stallGuardEngaged ? 0 : (stallGuardEnabled ? crawlPercent : 0);
            secondaryPercent = stallGuardEngaged ? 0 : 100;
            strokeMaxPercent = Math.max(25, edgeStrokeDepth);
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
        secondaryPercent = 0;
    }

    const warmupSeconds = Math.max(0, warmupMinutes) * 60;
    if (warmupSeconds > 0 && sessionSeconds < warmupSeconds && !orgasmMode && sessionStatus === 'RUNNING') {
        const warmT = sessionSeconds / warmupSeconds;
        const warmCap = 55 + (45 * warmT);
        strokeMaxPercent = Math.min(strokeMaxPercent, Math.round(warmCap));
        const speedScale = 0.45 + (0.55 * warmT);
        primaryPercent = Math.round(primaryPercent * speedScale);
        secondaryPercent = Math.round(secondaryPercent * speedScale);
    }

    if (sessionStatus === 'RUNNING' && !orgasmMode && !stallGuardEngaged) {
        if (cadenceBreathing && (mode === 'ultimate' || mode === 'classic')) {
            const wave = 0.5 + 0.5 * Math.sin((sessionSeconds * Math.PI) / 4);
            if (primaryPercent > 0) {
                primaryPercent = Math.round(primaryPercent * (0.82 + 0.18 * wave));
            }
        }
        if (milkingWave && (mode === 'ultimate' || mode === 'milker' || mode === 'ruin')) {
            const wave = 0.5 + 0.5 * Math.sin((sessionSeconds * Math.PI) / 3);
            if (secondaryPercent > 0) {
                secondaryPercent = Math.round(secondaryPercent * (0.72 + 0.28 * wave));
            }
        }
    }

    const intensityScale = 0.5 + (intensityValue / 100);
    if (primaryPercent > 0) {
        primaryPercent = Math.min(100, Math.round(primaryPercent * intensityScale));
    }
    if (secondaryPercent > 0) {
        secondaryPercent = Math.min(100, Math.round(secondaryPercent * intensityScale));
    }

    const physicalMin = Math.round(handyHwMin + (strokeMinPercent / 100) * (handyHwMax - handyHwMin));
    const physicalMax = Math.round(handyHwMin + (strokeMaxPercent / 100) * (handyHwMax - handyHwMin));

    return {
        primaryPercent,
        secondaryPercent,
        strokeMinPercent: physicalMin,
        strokeMaxPercent: Math.max(physicalMin, physicalMax),
        isEdged: nextIsEdged,
        newEdgeTriggered,
        resolvedMode: mode
    };
}

function applyOracle(oracleState, progress, nextIsEdged, orgasmMode, sessionSeconds) {
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
            out.primary = 100;
            out.secondary = 100;
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
