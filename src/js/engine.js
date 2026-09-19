/**
 * Core Biofeedback calculation engine
 */
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
    handyHwMax = 100
}) {
    if (sessionStatus !== 'RUNNING' && sessionStatus !== 'RAMPDOWN') {
        return {
            primaryPercent: 0,
            secondaryPercent: 0,
            strokeMinPercent: handyHwMin,
            strokeMaxPercent: handyHwMax,
            isEdged: false,
            newEdgeTriggered: false
        };
    }

    // 1. Edge & Hysteresis Buffer (5 BPM drop to un-edge)
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

    // 2. Normalized Progress with Convex Gamma Curve
    const rawProgress = Math.max(0, Math.min(1, (hr - minHr) / (maxHr - minHr)));
    const progress = Math.pow(rawProgress, gamma);

    let primaryPercent = 0;
    let secondaryPercent = 0;
    let strokeMinPercent = 0;
    let strokeMaxPercent = 100;

    const depthContractAmount = 100 - edgeStrokeDepth;

    // 3. Soft Landing (Rampdown)
    if (sessionStatus === 'RAMPDOWN') {
        const rampFactor = Math.max(0, rampdownSecondsLeft / 45);
        primaryPercent = Math.round(50 * rampFactor);
        secondaryPercent = Math.round(50 * rampFactor);
        strokeMaxPercent = Math.max(25, Math.round(100 - (1.0 - rampFactor) * depthContractAmount));
    } else {
        // 4. Experience Modes
        if (activeMode === 'classic') {
            const val = (!nextIsEdged || orgasmMode) ? Math.round((1.0 - progress) * 100) : 0;
            primaryPercent = val;
            secondaryPercent = val;
            strokeMaxPercent = Math.round(100 - (progress * depthContractAmount));
        } else if (activeMode === 'milker') {
            if (nextIsEdged && !orgasmMode) {
                primaryPercent = 0;
                secondaryPercent = 100;
            } else {
                primaryPercent = Math.round((1.0 - progress) * 100);
                secondaryPercent = Math.round(20 + (progress * 80));
            }
            strokeMaxPercent = Math.round(100 - (progress * depthContractAmount));
        } else if (activeMode === 'shortener') {
            primaryPercent = (!nextIsEdged || orgasmMode) ? Math.round((1.0 - progress) * 100) : 0;
            secondaryPercent = primaryPercent;
            strokeMinPercent = 0;
            strokeMaxPercent = Math.max(25, Math.round(100 - (progress * 75)));
        } else if (activeMode === 'headplay') {
            primaryPercent = (!nextIsEdged || orgasmMode) ? Math.round((1.0 - progress) * 100) : 0;
            secondaryPercent = primaryPercent;
            strokeMinPercent = Math.min(75, Math.round(progress * 75));
            strokeMaxPercent = 100;
        } else if (activeMode === 'ultimate') {
            if (nextIsEdged && !orgasmMode) {
                primaryPercent = 0;
                secondaryPercent = 100;
                strokeMaxPercent = Math.max(25, edgeStrokeDepth);
            } else {
                primaryPercent = Math.round((1.0 - progress) * 100);
                secondaryPercent = Math.round(20 + (progress * 80));
                strokeMaxPercent = Math.max(25, Math.round(100 - (progress * depthContractAmount)));
            }
        } else if (activeMode === 'ruin') {
            if (nextIsEdged && !orgasmMode) {
                primaryPercent = 0;
                secondaryPercent = 100;
                strokeMaxPercent = 25;
            } else {
                primaryPercent = Math.round((1.0 - progress) * 100);
                secondaryPercent = Math.round(20 + (progress * 60));
            }
        }

        if (orgasmMode) {
            primaryPercent = Math.max(primaryPercent, 85);
            secondaryPercent = 100;
            strokeMinPercent = 0;
            strokeMaxPercent = 100;
        }
    }

    // 5. Apply Intensity Multiplier (50 = 1.0x, 0 = 0.5x, 100 = 1.5x)
    const intensityScale = 0.5 + (intensityValue / 100);
    if (primaryPercent > 0) {
        primaryPercent = Math.min(100, Math.round(primaryPercent * intensityScale));
    }
    if (secondaryPercent > 0) {
        secondaryPercent = Math.min(100, Math.round(secondaryPercent * intensityScale));
    }

    // 6. Map to Physical Handy Travel Envelope
    const physicalMin = Math.round(handyHwMin + (strokeMinPercent / 100) * (handyHwMax - handyHwMin));
    const physicalMax = Math.round(handyHwMin + (strokeMaxPercent / 100) * (handyHwMax - handyHwMin));

    return {
        primaryPercent,
        secondaryPercent,
        strokeMinPercent: physicalMin,
        strokeMaxPercent: physicalMax,
        isEdged: nextIsEdged,
        newEdgeTriggered
    };
}
