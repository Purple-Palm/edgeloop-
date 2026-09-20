// localStorage can throw on access itself (blocked cookies / private mode);
// boot must survive that with defaults rather than a blank page, so every
// read goes through storage.js.
import { safeGet } from './storage.js';

export const state = {
    sessionStatus: 'IDLE',
    sessionSeconds: 0,
    chosenTargetSeconds: 0,
    durationMode: 'range',
    endgameType: 'orgasm',
    rampdownSecondsLeft: 45,
    hrCurrent: 70,
    edges: 0,
    pauses: 0,
    peakHr: 70,
    isEdged: false,
    orgasmMode: false,
    // Force Orgasm raises the WORKING ceiling by 1 BPM/s (capped) instead of
    // rewriting the typed Climax HR input; cleared by stop/reset.
    orgasmBoost: 0,
    // Ceiling and HR the engine actually used on the last tick, after every
    // offset; guards and games compare against these, never the raw input.
    effectiveMinHr: 70,
    effectiveMaxHr: 140,
    effectiveHr: 70,
    lastGoodHrLimits: { minHr: 70, maxHr: 140 },
    // Status to resume into after PAUSED ('RUNNING' or 'RAMPDOWN').
    resumeStatus: null,
    // True when the typed duration was invalid and the session fell back to endless.
    durationFallback: false,
    // The endgame (orgasm / soft landing / denied) fires once per session.
    endgameFired: false,
    activeMode: 'classic',
    alwaysFullStroke: false,
    lastHrTimestamp: Date.now(),
    // Heart-rate watchdog (hr-watchdog.js): last verdict, whether packets
    // arrive without a usable pulse, how long since the last valid reading,
    // and whether the watchdog (not the user) paused the session so it can
    // auto-resume when the signal returns.
    hrSignalState: 'ok',
    hrNoContact: false,
    hrSignalSilentMs: 0,
    hrSignalPaused: false,
    hrDeviceName: '',
    // Remote controller page only: the host reports whether it has a pulse
    // source and a toy, so the partner's START button can mirror it.
    remoteHostReady: false,
    strokerSpeed: 0,
    prostateSpeed: 0,
    strokeMin: 0,
    strokeMax: 100,
    ruinHoldSeconds: 0,
    edgeStallSeconds: 0,
    stallPauseElapsed: 0,
    stallGuardEngaged: false,
    intensityValue: 50,
    history: [70],
    bleBattery: null,
    handyBattery: null,
    intifaceBattery: null,
    simEngaged: false,
    handyRole: safeGet('handy_role', 'primary') || 'primary',
    handyMaxCap: (() => {
        const cap = parseInt(safeGet('handy_max_cap', '100') || '100', 10);
        return Number.isFinite(cap) ? Math.max(0, Math.min(100, cap)) : 100;
    })(),
    oracleState: 'IDLE',
    oracleTimer: 0,
    survivalSpeedFloor: 30,
    survivalTimer: 0,
    survivalBreachTicks: 0,
    // Timestamp of the reading the last Survival tick judged, so a value held
    // across ticks by a slow source counts as one breach reading.
    survivalLastReadingAt: null,
    lastSpokenPrompt: '',
    lastSpokenAt: 0,
    isTestingMic: false,
    micStream: null,
    micAudioCtx: null,
    micAnalyser: null,
    micAnimId: null,
    micBoost: 0,
    edgeTriggerHr: 140
};

export const advancedSettings = {
    gammaCurve: 2.0,
    warmupMinutes: 5,
    edgeStrokeDepth: 100,
    cadenceBreathing: true,
    milkingWave: true,
    handyHwMin: 0,
    handyHwMax: 100,
    // Fresh installs need no legacy 15/85 envelope migration (see app.js).
    envelopeMigrated: true,
    stallGuard: true,
    stallGuardSeconds: 20,
    stallPauseSeconds: 8,
    // What the primary does while parked at the pullback trigger: 'stop'
    // (0%) or 'crawl' (CRAWL_PERCENT). The stall guard only matters in crawl.
    ceilingBehaviour: 'crawl',
    // Pullback as a percent of typed Climax HR (90-115, default 100).
    edgeHoldPercent: 100,
    // Heart-rate signal-loss timeout (seconds, 3-20) and whether a session
    // the watchdog paused resumes by itself once readings return.
    hrStaleSeconds: 8,
    hrAutoResume: true,
    dualDampening: true,
    dualDampeningBpm: 15,
    adaptiveDecay: true,
    decayEdgeCount: 2,
    decayBpm: 2,
    decayFloor: 105,
    voiceEnabled: false,
    voiceURI: '',
    micEnabled: false,
    micSensitivityThreshold: 40,
    customProfiles: {},
    learningProfile: {
        breakthroughEvents: 0,
        suggestedMaxHrOffset: 0,
        lastBreakthroughHr: null
    }
};
