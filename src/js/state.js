// localStorage can throw on access itself (blocked cookies / private mode);
// boot must survive that with defaults rather than a blank page, so every
// read goes through storage.js.
import { safeGet } from './storage.js';

export const state = {
    sessionStatus: 'IDLE',
    sessionSeconds: 0,
    chosenTargetSeconds: 0,
    durationMinSeconds: 0,
    durationMaxSeconds: 0,
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
    // Diagnostic only: the heart rate the ENGINE last ran on, microphone
    // boost included. Nothing reads it, and nothing should - it is not the
    // wearer's pulse. Read sensorHr instead.
    effectiveHr: 70,
    // The pulse the sensor reported, with no microphone boost: what every
    // guard, game, counter, the cockpit readout and the record judge.
    sensorHr: 70,
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
    trainState: 'climb',
    trainHoldSeconds: 0,
    trainEdgesDone: 0,
    lastSpokenPrompt: '',
    lastCueTemplateById: {},
    lastSpokenAt: 0,
    isTestingMic: false,
    micStream: null,
    micAudioCtx: null,
    micAnalyser: null,
    micAnimId: null,
    micBoost: 0,
    // What updateEngine last actually added to the engine's heart rate (0
    // when the boost was suppressed). The cockpit badge reads THIS, never
    // the meter's own preview.
    micApplied: 0,
    // Last measured voice-band level, held while the app itself is speaking.
    micLastLevel: 0,
    micSpeechAt: 0,
    // When the current hold started, so a speech flag that never clears
    // cannot latch one level forever.
    micHoldSince: 0,
    // What the browser actually did with the capture constraints.
    micProcessing: null,
    // The pullback mark. Null until the engine computes it (host) or
    // telemetry carries it (remote page): a default would draw a chart
    // line for a threshold nobody set.
    edgeTriggerHr: null
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
    // Pullback as a percent of typed Climax HR (90-100, default 100).
    edgeHoldPercent: 100,
    trainHoldSeconds: 15,
    trainEdges: 5,
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
    voiceCues: {},
    voiceEncourageSeconds: 45,
    micEnabled: false,
    micSensitivityThreshold: 40,
    micBoostMaxBpm: 8,
    customProfiles: {},
    learningProfile: {
        breakthroughEvents: 0,
        suggestedMaxHrOffset: 0,
        lastBreakthroughHr: null
    }
};
