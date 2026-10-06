import { state, advancedSettings, SETTING_KEYS, SETTING_DEFAULTS } from './state.js';
import {
    calculateEngineOutputs,
    resolveEngineMode,
    gameEdgeReleased,
    clampEdgeHoldPercent,
    resolveEdgeTriggerHr,
    describeEdgeHoldPreview,
    micBoostReachesMotors
} from './engine.js';
import {
    ORGASM_BOOST_CAP,
    computeEffectiveCeiling,
    sanitizeHrLimits,
    parseSessionDuration,
    oracleTiming,
    rollOracleFate,
    tickEdgeTraining,
    clampTrainHoldSeconds,
    clampTrainEdges,
    survivalDrive,
    survivalEdgesAtSwitch,
    survivalEdgesAfterEngine,
    clampStallGuardSeconds,
    clampStallPauseSeconds,
    tickRuinAndStallGuard,
    stallPauseSecondsLeft,
    startRuinEdge,
    ruinRideSecondsLeft,
    endgameKeepsOrgasmLatch,
    resolveForceOrgasmMaxSeconds,
    tickForceOrgasm,
    forceOrgasmSecondsLeft,
    forceOrgasmRefusal,
    describeForceOrgasmRefusal,
    describeForceOrgasmButton,
    inSoftLanding,
    describeGameNotice,
    describeCutoffNotice,
    describeStallPauseNotice,
    sanitizeSessionLimits,
    workingCeilingInputs,
    rememberReading,
    cameEarlyStep,
    learnedOffsetCeilings,
    describeCameEarlyConfirm,
    cameEarlyCue,
    describeWipeLearningConfirm,
    describeLearningStatus,
    openCalibrationWindow,
    noteCalibrationReading,
    closeCalibrationWindow,
    planFinishedMe,
    createQuestionGate,
    describeStopNotConfirmed,
    describeWaitingForStop,
    describeStopWaitOver,
    pressAbout
} from './session-rules.js';
import { safeGet, safeParse, safeSet, safeRemove, saveHistoryTrimmed } from './storage.js';
import { buildBackup, backupFilename, describeBackupExport, readBackup, describeBackupImport, mergeDeviceMaps, countDroppedOnMerge, pruneReservedKeys, pruneRetiredKeys, VACUGLIDE_SETTING_NAMES } from './backup.js';
import { applySettingSchema } from './settings-schema.js';
import { createWriteCoalescer } from './write-coalescer.js';
import { cancelWheelWhileFocused, releaseFocusOnCommit, releaseFocusOnPointerUp } from './input-hygiene.js';
import { planBannerUpdate, planBannerClear, planBannerRevise, planBannerPauseEnded, hiddenBannerState, BANNER_OWNER_ANY } from './alert-banner.js';
import { pushSample, buildFunscripts, toFunscript } from './funscript.js';
import { drawTelemetryChart, shouldDrawPullbackLine, watchChartResize } from './chart.js';
import { connectBleHeartRate, disconnectBle, isBleConnected, isBleReconnecting } from './hardware/ble.js';
import { describeBluetoothSupport, describeBleError } from './hardware/ble-protocol.js';
import { createHrWatchdog, clampStaleSeconds } from './hr-watchdog.js';
import { rememberEdgeReading } from './edge-confirm.js';
import {
    supervisionGapLimitMs,
    createSupervisionClock,
    createPageAwayTracker,
    describeSupervisionGap,
    describePageAway
} from './supervision.js';
import { createScreenWakeLock } from './screen-wake-lock.js';
import { createTickDispatch, guardEngagedBy } from './tick-dispatch.js';
import {
    HANDY_TIMINGS,
    connectHandy,
    disconnectHandy,
    dispatchHandy,
    stopHandyOnUnload,
    stopHandyAfterCrash,
    handyConnected,
    setHandyHandlers,
    pollHandyConnected,
    getHandyKey,
    handyMayBeMoving,
    handyRestState,
    handyStopTally
} from './hardware/handy.js';
import {
    newPageId,
    createCrashRecovery,
    createCrashRecoveryStorage,
    whenActivated,
    clearPendingCrashStop,
    clearPendingVacuglideStop,
    drivesHandyNow
} from './crash-recovery.js';
import { openDurableStore } from './durable-store.js';
import { normalizeEnvelope, applyEndMargin, clampEndMargin, handyTargetSpeed, describeStartRefusal } from './hardware/handy-protocol.js';
import { bindEnvelopeField, bindEndMarginField, settleFocusedField } from './hardware/handy-fields.js';
import { createHandyStopReport } from './hardware/handy-stop-report.js';
import { createStartGate } from './start-gate.js';
import {
    connectVacuglide,
    disconnectVacuglide,
    dispatchVacuglide,
    pulseValve,
    attachVacuglideToPage,
    setVacuglideHandlers,
    isVacuglideConnected,
    isVacuglideValveOpen,
    isVacuglideWatching,
    getValvePulse,
    getVacuglideToken,
    getVacuglideCluster,
    stopVacuglideAfterCrash,
    vacuglideStopChaseMs
} from './hardware/vacuglide.js';
import {
    VACUGLIDE_TOKEN_STORAGE_KEY,
    VALVE_PULSE_MIN_MS,
    VALVE_PULSE_MAX_MS,
    sanitizeDeviceToken,
    sanitizeVacuglideRole,
    clampSpeedCap,
    clampValvePulseMs,
    pulseSecondsToMs,
    formatPulseSeconds,
    vacuglideSpeedFor
} from './hardware/vacuglide-protocol.js';
import { APP_VERSION, parseChangelog, GITHUB_CHANGELOG_URL, GITHUB_RELEASES_URL } from './version.js';
import {
    connectIntifaceServer,
    disconnectIntiface,
    rescanIntiface,
    dispatchIntiface,
    stopAllIntiface,
    setAxisRole,
    setAxisMaxCap,
    setAxisInvert,
    setAxisVibeMode,
    setDeviceRotation,
    reverseIntifaceRotation,
    saveIntifaceConfig,
    testSingleAxis,
    isIntifaceConnected,
    isIntifaceScanning,
    getIntifaceStatus,
    countAssignedIntifaceDevices,
    intifaceDevices,
    DEFAULT_INTIFACE_URL,
    ALTERNATE_SECONDS_MIN,
    ALTERNATE_SECONDS_MAX,
    INTIFACE_STORAGE_KEY
} from './hardware/intiface.js';
import { PULSE_PERIODS_MS } from './hardware/vibe-pulse.js';
import {
    connectTCode,
    disconnectTCode,
    dispatchTCode,
    stopTCode,
    setTCodeHandlers,
    setAxisRole as setTCodeAxisRole,
    setAxisCap as setTCodeAxisCap,
    setAxisInvert as setTCodeAxisInvert,
    testAxis as testTCodeAxis,
    isTCodeConnected,
    isSerialSupported,
    getTCodeStatus,
    getTCodeDevice,
    countAssignedTCodeAxes,
    tcodeHasRole,
    TCODE_STORAGE_KEY
} from './hardware/tcode.js';
import { describeSerialSupport } from './hardware/tcode-protocol.js';
import {
    initHostPeer,
    initRemotePeer,
    broadcastPeerTelemetry,
    sendPeerCommand,
    hostVersionAllows,
    pruneStalePeers,
    getPeerCounts,
    peerLibraryAvailable
} from './webrtc.js';
import { describePeerVersionMismatch, peerProtocolRelation, hostTransportAction, transportCommand } from './peer-messages.js';
import { createHotkeyLayer, classifyKeyTarget, transportKeyHint, createResumeHold, REACTION_MS } from './hotkeys.js';
import {
    speakPrompt,
    speakNow,
    cancelSpeech,
    setMindgamePrompt,
    startMicMonitor,
    stopMicMonitor,
    sampleMicLevel,
    clearMicBoost,
    listSpeechVoices,
    setSpeechObserver,
    clampMicGate,
    clampMicBoostBpm,
    micBoostFromLevel,
    micBoostedHr
} from './voice.js';
import {
    createSpeechNotices,
    describeMissingVoice,
    describeVoiceIndicator,
    describeVoiceStatus,
    planCueDelivery,
    resolveSpeechVoice,
    voiceDisplayName
} from './voice-status.js';
import {
    VOICE_CUE_CATALOG,
    mergeVoiceCues,
    resolveVoiceCue,
    applyImportedCues,
    describeImport,
    voiceImportAlert,
    parseVoiceCuesText,
    serializeVoiceCues,
    clampEncourageSeconds
} from './voice-cues.js';

// Load persisted settings. The old 15/85 default envelope is migrated to
// 0/100 exactly once (flagged), so a user who deliberately types 15/85 later
// keeps it.
const storedSettings = safeParse('edgeloop_advanced_settings', null);
if (storedSettings && typeof storedSettings === 'object' && !Array.isArray(storedSettings)) {
    const parsed = storedSettings;
    let migrated = false;
    // Only a store that has never seen the migration runs it. A file can
    // carry `envelopeMigrated: false`, and re-running the migration on that
    // would wipe a 15/85 envelope the user had just restored - then write
    // the flag back and do it again to the next file.
    if (!Object.prototype.hasOwnProperty.call(parsed, 'envelopeMigrated')) {
        if (parsed.handyHwMin === 15 && parsed.handyHwMax === 85) {
            parsed.handyHwMin = 0;
            parsed.handyHwMax = 100;
        }
        parsed.envelopeMigrated = true;
        migrated = true;
    }
    // Before the explicit "At the ceiling" control, crawl was implied by the
    // stall guard toggle: keep whatever behaviour the user effectively had.
    if (parsed.ceilingBehaviour !== 'stop' && parsed.ceilingBehaviour !== 'crawl') {
        parsed.ceilingBehaviour = parsed.stallGuard === false ? 'stop' : 'crawl';
        migrated = true;
    }
    // Old builds stored an offset (0-15 meaning 100-115% of Climax HR).
    if (!Number.isFinite(Number(parsed.edgeHoldPercent))) {
        const old = Number(parsed.edgeOvershootPercent);
        parsed.edgeHoldPercent = (Number.isFinite(old) && old >= 0 && old <= 20)
            ? 100 + Math.round(old)
            : 100;
        migrated = true;
    }
    // Names this build retired (backup.js) leave the store as well as the
    // backup file: nothing reads them, and a merge would otherwise write
    // them back on every save for as long as the install lives.
    if (pruneRetiredKeys(parsed).length) migrated = true;
    Object.assign(advancedSettings, parsed);
    if (migrated) persistSettings();
}

// Heart-rate signal watchdog (hr-watchdog.js). Its clocks are reset on BLE
// connect and when the simulator is engaged, never on START / RESUME: a
// session may only start or resume on a fresh valid reading, so the clocks
// must tell the truth at that moment. Its settings mirror the Guards tab and
// are re-applied after load, apply and import.
const hrWatchdog = createHrWatchdog();
function syncWatchdogSettings() {
    // The two values themselves are bounded by the schema (the single place
    // every Session Setup field is checked); this only hands them to the
    // watchdog. It used to coerce them itself with `!== false`, which read
    // the string 'false' from a hand-edited file as TRUE and auto-resumed a
    // session the watchdog had paused.
    applySettingSchema(advancedSettings);
    hrWatchdog.configure({
        staleMs: advancedSettings.hrStaleSeconds * 1000,
        autoResume: advancedSettings.hrAutoResume
    });
}
// Every Session Setup field, checked the same way wherever it enters -
// typed, loaded from storage on boot, or restored from a file. One
// sanitizer per field lives in settings-schema.js, and a field with no
// sanitizer is a failing test rather than a value nothing bounds: that was
// how `gammaCurve`, which has no control at all and is read straight into
// the engine, could be set to 200 by a one-field imported file and stop the
// engine backing off as the pulse climbed.
function syncGuardSettings() {
    const corrected = applySettingSchema(advancedSettings);
    // The cross-field rules run after the per-field pass: the HR pair, the
    // duration window and the Endgame Trigger depend on each other, and a
    // stored pair is reconciled exactly as a typed one is - a hand-edited
    // store cannot raise the ceiling.
    const limits = sanitizeSessionLimits(advancedSettings);
    for (const [name, value] of Object.entries(limits)) {
        if (JSON.stringify(advancedSettings[name]) !== JSON.stringify(value) && !corrected.includes(name)) {
            corrected.push(name);
        }
        advancedSettings[name] = value;
    }
    // What the pass had to change, for the import to report honestly.
    return corrected;
}
syncWatchdogSettings();
syncGuardSettings();
hrWatchdog.reset(Date.now());

// The last few valid readings of the pulse source, { at, bpm }, oldest first
// (edge-confirm.js). The engine pulls back on the first reading at the mark
// but counts the edge only once the pulse has held there on two consecutive
// readings, so it needs the readings before the current one. state.hrCurrent
// cannot stand in for them: it is one number, and it reads 70 before any
// monitor has spoken. Emptied when the source changes, because a reading
// from one source and the next from another are not two readings of one
// pulse.
let edgeReadings = [];

// Live funscript sample buffer: one 4 Hz timeline of { at, speed, secondary,
// strokeMin, strokeMax }. Both channel scripts are built from it on export.
let funscriptSamples = [];
let funscriptSessionStart = 0;

// The valid readings of the last minute or so, from the strap or the engaged
// simulator, { at, bpm } (session-rules.rememberReading). Came Early judges
// its step on their peak: state.hrCurrent is not a reading - it starts at 70
// before any monitor has spoken, and it is already falling by the time the
// button is pressed. Every reading counts, session running or not, and START
// does not empty them: the wearer who hits STOP at the point of no return and
// tips over anyway climaxes with nothing running, and the pulse the cockpit
// showed during that minute is the climax the press is about.
let recentReadings = [];

// Finished me's record of the Survival run (session-rules.openCalibrationWindow):
// the sustained peak of the monitor's readings while the run was RUNNING,
// since Survival came on in this session. Opened by START with Survival
// selected or by Survival coming on in a live session, closed - and kept for
// a minute - when the session stops, dropped when Survival goes off.
let calibrationWindow = null;

// A Came Early or Finished me press that asked nothing because the Handy had
// not confirmed its stop, while the prompt line tells the wearer it may still
// be moving (session-rules.stopThenAsk): { kind: 'cameEarly', peakHr } or
// { kind: 'finishedMe', pressedAt, win }. The next press of the same button
// answers that line, and asks about the press that was turned away, because
// seeing to a Handy that went offline can take minutes. Finished me reads the
// run as it stood then and counts its minute after STOP from that press.
// Came Early judges its step on the peak of the minute before that press:
// judged on the minute before the second one, a pulse falling from the
// climax took the larger step and went into the profile as the event's
// pulse, only because the Handy had held the question back. START and RESUME
// drop it, and so does Survival going on or off: the wearer has carried on,
// and a press after that is about something new.
let heldPress = null;

// Query string check for remote controller
const urlParams = new URLSearchParams(window.location.search);
const partnerRoom = urlParams.get('partner');
const viewerRoom = urlParams.get('group_sub');
// ?partner= opens a remote CONTROLLER (transport, orgasm and mode commands);
// ?group_sub= opens a read-only VIEWER. Both render the host's telemetry and
// run no engine, watchdog or hardware of their own.
export const isRemoteController = Boolean(partnerRoom);
export const isRemoteViewer = !isRemoteController && Boolean(viewerRoom);
const isRemotePage = isRemoteController || isRemoteViewer;
const remoteRoom = isRemoteController ? partnerRoom : viewerRoom;
const remoteRoleLabel = isRemoteViewer ? 'Viewer' : 'Remote Controller';
// Set when the host link died (peer close / error / silent telemetry).
let remoteLinkLost = false;

// Header badge on a remote page: "Viewer · Live", "Remote Controller · Disconnected"...
let remoteRoleSuffix = '';
function setRemoteRoleStatus(suffix) {
    remoteRoleSuffix = suffix || '';
    const role = document.getElementById('roleIndicator');
    if (role) role.textContent = suffix ? `${remoteRoleLabel} · ${suffix}` : remoteRoleLabel;
}

if (isRemotePage) {
    const role = document.getElementById('roleIndicator');
    if (role) {
        role.className = isRemoteViewer
            ? "text-[9px] font-bold px-1.5 py-0.5 rounded bg-sky-900 text-sky-200 uppercase"
            : "text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-900 text-purple-200 uppercase";
    }
    setRemoteRoleStatus('Connecting');
    const hrTag = document.getElementById('hrWarningTag');
    if (hrTag) hrTag.textContent = "WEARER TELEMETRY";
}

// The crash report (crash-recovery.js) is a source of its own on the alert
// banner, 'crashRecovery'. It is about a Handy of a session that is over,
// and it keeps changing for minutes - every answer the retried stop gets -
// while the wearer may already be running a new session with another Handy.
// No report takes another source's sentence off the banner (alert-banner.js),
// so a late "it has stopped" about the old Handy cannot erase the warning
// that the Handy connected now may still be moving, and no report of the new
// session can erase the warning that the old one may be. It pauses nothing
// and says nothing about a pause. An answer that settles nothing - the first
// word of a report, a stop the device did not answer, one that gave up - is
// a new report, read first among the safety reports and back after a
// Dismiss. A stop that settled rewords it where it stands, and a report the
// wearer dismissed stays dismissed. The same text again is not news. And it
// leaves when its cause is over (createCrashRecovery): once no Handy it
// names may still be moving and the wearer has carried on from it, by
// starting or resuming a session; then the text it is given is empty.
let crashReportText = '';
function showCrashReport(text, { fresh = true } = {}) {
    if (!text) {
        crashReportText = '';
        hideAlertBanner('crashRecovery');
        return;
    }
    if (text === crashReportText) return;
    crashReportText = text;
    if (fresh) showAlertBanner(text, { severity: 'safety', source: 'crashRecovery' });
    else reviseAlertBanner(text, { severity: 'safety', source: 'crashRecovery' });
}

// Crash recovery (crash-recovery.js). While this page's session may drive
// hardware it keeps a marker of its own in storage, named by this page's
// id. A page that crashes, is force-quit or is killed by the phone leaves
// its marker behind, and the next host page to open sends The Handy a stop -
// with the key the marker names and the key saved here - and each VacuGlide
// the marker names its whole stop, motor and both valves, and says on the
// banner that the session did not end cleanly and what each stop returned.
// A crash sends the VacuGlide no unload stop and leaves no handover entry
// (vacuglide.js), so this is the only stop it gets.
// So does a page that was already open, when a session starts in it: the
// wearer may carry on there, next to the Handy the dead page left moving. A
// stop that does not get through is sent again by the next host page to
// open, whatever sessions run in between. Nothing is connected, started or
// changed. The boot pass starts here, before the rest of boot, so nothing
// that fails further down can keep the stop from going out - but not before
// the wearer has opened the page: a page Chrome prerenders (from the address
// bar, as a URL it predicts is typed) runs this module hidden, where it
// could not tell a session running in another tab from a crash
// (whenActivated). A marker whose page was still open at boot is looked at
// once more a few seconds later: it may be the page this one replaced in its
// own tab, not yet torn down. The keys are read when a pass runs, not when
// this module loads: a prerendered page may be opened minutes later, with
// another key saved. A remote page drives no hardware and never touches the
// markers or the stops still owed: they belong to the host.
// The markers and the stops still owed are kept in localStorage and, change
// by change, committed to IndexedDB as well (durable-store.js): Chromium
// writes localStorage to disk a minute or more late, so a browser force-quit
// or killed by the phone took a marker written at START, or kept one
// removed at STOP, and the next page to open stopped nothing, or reported a
// crash that had not happened.
function browserStore(name) {
    try {
        return window[name] || null;
    } catch (e) {
        // Site data blocked for this site.
        return null;
    }
}
const crashStorage = isRemotePage ? null : createCrashRecoveryStorage({
    local: browserStore('localStorage'),
    durable: openDurableStore({ indexedDB: browserStore('indexedDB') })
});
const crashRecovery = isRemotePage ? null : createCrashRecovery({
    owner: newPageId(),
    storage: crashStorage,
    locks: navigator.locks,
    savedHandyKey: () => safeGet('handy_connection_key', '') || '',
    liveHandyKey: () => (handyConnected ? getHandyKey() : ''),
    stopHandy: stopHandyAfterCrash,
    retryMinutes: HANDY_TIMINGS.crashStopWindowMs / 60000,
    savedVacuglideToken: () => safeGet(VACUGLIDE_TOKEN_STORAGE_KEY, '') || '',
    liveVacuglideToken: () => (isVacuglideConnected() ? getVacuglideToken() : ''),
    stopVacuglide: stopVacuglideAfterCrash,
    vacuglideRetryMinutes: vacuglideStopChaseMs() / 60000,
    onReport: showCrashReport,
    onDurable: () => { resumeHeldDispatch(); }
});
if (crashRecovery) whenActivated(document, () => { crashRecovery.atBoot(); });

// Master DOM Elements
const playPauseBtn = document.getElementById('sessionPlayPauseBtn');
const playPauseText = document.getElementById('playPauseText');
const playPauseIcon = document.getElementById('playPauseIcon');
const stopBtn = document.getElementById('sessionStopBtn');
const resetBtn = document.getElementById('sessionResetBtn');
const cameEarlyBtn = document.getElementById('cameEarlyBtn');
const orgasmBtn = document.getElementById('orgasmBtn');
const orgasmBtnText = document.getElementById('orgasmBtnText');
// START / RESUME wait here while The Handy is asked whether it is online
// (see startOrResumeWhenReady); STOP, Reset and the page going away
// (handlePageAway) cancel the wait.
const startGate = createStartGate();
// Came Early and Finished me, one at a time (stopThenAskOnce); START and
// RESUME ask it too (startOrResumeWhenReady). On the clock a click's
// timeStamp is measured on.
const pressQuestion = createQuestionGate({ now: () => performance.now() });

// What the toys were last sent, exactly as dispatchHardware() handed it to
// the drivers: Force Orgasm's ramp starts from it. A decision the master
// clock's tick held and never sent does not count (tickDispatch). Nothing
// has been sent before the first dispatch, and the toys are at rest then.
let lastDispatched = { primary: 0, secondary: 0, strokeMin: 0, strokeMax: 100 };
// The reason the last refused Force Orgasm tap was refused ('landing' or
// 'idle'), shown under the button for as long as that reason holds.
let orgasmRefusalShown = '';

// Age Verification Handlers
const ageOverlay = document.getElementById('ageOverlay');
if (safeGet('edgeloop_age_verified') === 'true' && ageOverlay) {
    ageOverlay.classList.add('hidden');
}
document.getElementById('ageConfirmBtn')?.addEventListener('click', () => {
    safeSet('edgeloop_age_verified', 'true');
    if (ageOverlay) ageOverlay.classList.add('hidden');
});
document.getElementById('ageDenyBtn')?.addEventListener('click', () => {
    window.location.href = 'https://www.google.com';
});

// Guide Wizard (3-step setup)
let wizardStepIndex = 0;
const wizardOverlay = document.getElementById('wizardOverlay');

function markWizardSeen() {
    safeSet('edgeloop_wizard_seen', 'true');
}

function renderWizardStep() {
    document.querySelectorAll('.wizard-pane').forEach((pane, idx) => {
        pane.classList.toggle('hidden', idx !== wizardStepIndex);
    });
    document.querySelectorAll('.wizard-dot').forEach((dot, idx) => {
        dot.className = idx === wizardStepIndex
            ? 'wizard-dot h-1.5 w-6 rounded-full bg-purple-500'
            : 'wizard-dot h-1.5 w-6 rounded-full bg-slate-700';
    });
    const backBtn = document.getElementById('wizardBackBtn');
    const nextBtn = document.getElementById('wizardNextBtn');
    if (backBtn) backBtn.classList.toggle('hidden', wizardStepIndex === 0);
    if (nextBtn) nextBtn.textContent = wizardStepIndex >= 2 ? 'Get Started' : 'Next';
}

function openWizard() {
    wizardStepIndex = 0;
    renderWizardStep();
    wizardOverlay?.classList.remove('hidden');
}

function closeWizard() {
    wizardOverlay?.classList.add('hidden');
    markWizardSeen();
}

window.dismissWizard = closeWizard;

document.getElementById('guideBtn')?.addEventListener('click', openWizard);
document.getElementById('wizardSkipBtn')?.addEventListener('click', closeWizard);
document.getElementById('wizardBackBtn')?.addEventListener('click', () => {
    wizardStepIndex = Math.max(0, wizardStepIndex - 1);
    renderWizardStep();
});
document.getElementById('wizardNextBtn')?.addEventListener('click', () => {
    if (wizardStepIndex >= 2) {
        closeWizard();
        return;
    }
    wizardStepIndex += 1;
    renderWizardStep();
});

function maybeShowFirstRunWizard() {
    const ageOk = safeGet('edgeloop_age_verified') === 'true';
    const seen = safeGet('edgeloop_wizard_seen') === 'true';
    if (ageOk && !seen) openWizard();
}

document.getElementById('ageConfirmBtn')?.addEventListener('click', () => {
    if (location.protocol === 'file:') return;
    // The wizard walks the host through pairing hardware; a partner or viewer
    // page has none.
    if (isRemotePage) return;
    setTimeout(maybeShowFirstRunWizard, 50);
});

// Disconnect / Watchdog Alert Banner
//
// One banner carries every report, so it is ranked (see alert-banner.js): an
// advisory can never overwrite a safety report, no report takes another
// source's sentence off the banner, and each sentence leaves only when its
// own source withdraws it or the wearer dismisses the banner. So whatever
// raises a report here withdraws it again the moment what it reports is
// over; nothing else will.
let bannerState = hiddenBannerState();

document.getElementById('dismissBannerBtn')?.addEventListener('click', () => {
    hideAlertBanner(BANNER_OWNER_ANY);
});

// The one place that writes the banner element: whatever the planned state
// says is shown, in full, or nothing.
function renderAlertBanner() {
    const msg = document.getElementById('disconnectMsg');
    if (msg) msg.textContent = bannerState.text;
    const banner = document.getElementById('disconnectBanner');
    if (!banner) return;
    if (bannerState.visible) banner.classList.remove('hidden');
    else banner.classList.add('hidden');
}

// `motorsPaused` ends the report with "Motors paused for safety." until the
// pause is over (retractMotorsPaused).
function showAlertBanner(message, { severity = 'safety', source = 'device', motorsPaused = false } = {}) {
    bannerState = planBannerUpdate(bannerState, { message, severity, source, motorsPaused });
    renderAlertBanner();
}

// `owner` is the source that raised what it now withdraws, or
// BANNER_OWNER_ANY for the wearer's Dismiss. A source takes out its own
// sentence and nothing else, whether or not it leads the banner.
function hideAlertBanner(owner) {
    const next = planBannerClear(bannerState, owner);
    const unchanged = next.visible === bannerState.visible && next.text === bannerState.text;
    bannerState = next;
    // Every heart-rate reading withdraws the signal-loss report, once a
    // second; a banner that reads the same is not written again.
    if (!unchanged) renderAlertBanner();
}

// `source` rewords the sentence it has standing, in place. A report whose
// cause has partly ended says what is left of it, and one the wearer
// dismissed stays dismissed: nothing new has happened.
function reviseAlertBanner(message, { severity = 'safety', source = 'device' } = {}) {
    const next = planBannerRevise(bannerState, { message, severity, source });
    const unchanged = next.visible === bannerState.visible && next.text === bannerState.text;
    bannerState = next;
    if (!unchanged) renderAlertBanner();
}

// The session is no longer paused: it runs again, or STOP or Reset ended it.
// No report goes on saying the motors are paused; each keeps the rest of
// what it says, in its place (planBannerPauseEnded).
function retractMotorsPaused() {
    const next = planBannerPauseEnded(bannerState);
    const unchanged = next.visible === bannerState.visible && next.text === bannerState.text;
    bannerState = next;
    if (!unchanged) renderAlertBanner();
}

// A safety report that also stops every toy and pauses the session.
// `source` names the one condition the report is about, and withdraws it
// when that condition is over: two conditions reported under one source
// would replace each other's sentences, so an unconfirmed stop and a lost
// link are two sources even on the same device. A report that tells the
// wearer the motors were paused passes `motorsPaused` rather than writing
// the clause into its message, because the clause ends before the report
// does: a device that was lost is still gone after RESUME on the other toys.
// With no session there is nothing to pause, and the report does not say
// there was.
function triggerDisconnectAlert(message, source = 'device', { motorsPaused = false } = {}) {
    showAlertBanner(message, { severity: 'safety', source, motorsPaused: motorsPaused && state.sessionStatus !== 'IDLE' });

    if (pauseSession(null)) syncTelemetry();
    checkReadiness();
}

// Screen Wake Lock (screen-wake-lock.js). A phone that locks its screen hides
// the page, and a hidden page is throttled and then frozen, so while a
// session is RUNNING or RAMPDOWN the screen is kept on. Every transport
// change syncs it and the master clock re-asserts it once a second; a
// browser without the API, or one that refuses it, changes nothing else.
const screenWakeLock = createScreenWakeLock({
    getWakeLock: () => navigator.wakeLock,
    isVisible: () => document.visibilityState === 'visible'
});

function syncScreenWakeLock() {
    screenWakeLock.update(!isRemotePage && (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN'));
}

// Pause a RUNNING or RAMPDOWN session, remembering which one so RESUME goes
// back into the rampdown where it left off. Motors are stopped immediately.
// Returns false when there was nothing to pause.
function pauseSession(voiceText = 'Paused.') {
    if (state.sessionStatus !== 'RUNNING' && state.sessionStatus !== 'RAMPDOWN') return false;
    state.resumeStatus = state.sessionStatus;
    state.sessionStatus = 'PAUSED';
    state.pauses += 1;
    const pauseEl = document.getElementById('pauseCount');
    if (pauseEl) pauseEl.textContent = state.pauses;
    renderTransport('PAUSED');
    clearMicBoost(state);
    dispatchHardware(0, 0, 0, 100, true);
    syncScreenWakeLock();
    if (voiceText) cueVoice('paused');
    renderForceOrgasmButton();
    return true;
}

// RESUME takes no press for a moment after it appears (see the transport's
// click handler).
const resumeHold = createResumeHold();

// Put the transport button into the look for `status`. Shared by start,
// pause, stop / reset and the remote controller's telemetry renderer.
function renderTransport(status) {
    if (!playPauseBtn) return;
    playPauseBtn.disabled = false;
    resumeHold.rendered(status, performance.now());
    if (status === 'RUNNING' || status === 'RAMPDOWN') {
        if (playPauseText) playPauseText.textContent = "PAUSE";
        if (playPauseIcon) playPauseIcon.innerHTML = `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`;
        playPauseBtn.className = "flex-1 bg-amber-600 hover:bg-amber-500 text-white font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 shadow-lg shadow-amber-950/40 cursor-pointer";
    } else if (status === 'PAUSED') {
        if (playPauseText) playPauseText.textContent = "RESUME";
        if (playPauseIcon) playPauseIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
        playPauseBtn.className = "flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 shadow-lg shadow-emerald-950/40 cursor-pointer";
    } else {
        if (playPauseText) playPauseText.textContent = "START SESSION";
        if (playPauseIcon) playPauseIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
        playPauseBtn.className = "flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 shadow-lg shadow-emerald-950/40 cursor-pointer";
    }
    renderTransportKeyHint(status);
}

// Grey out the transport with a reason while the hardware is not ready.
function renderTransportWaiting(reason) {
    if (!playPauseBtn) return;
    playPauseBtn.disabled = true;
    resumeHold.rendered(null, performance.now());
    if (playPauseText) playPauseText.textContent = reason;
    playPauseBtn.className = "flex-1 bg-slate-800 text-slate-500 font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 border border-slate-700/50 cursor-not-allowed";
    renderTransportKeyHint(null);
}

// The transport names its key, and only while that key works it: on PAUSE,
// never on START or RESUME (Space never starts or resumes a session), never
// while the button is greyed out, never on a viewer's locked page. The chip
// is aria-hidden, so the button is still announced as PAUSE; a screen reader
// gets the key from aria-keyshortcuts, and a pointer from the title.
function renderTransportKeyHint(status) {
    if (!playPauseBtn) return;
    const hint = transportKeyHint({
        sessionStatus: status,
        transportEnabled: !isRemoteViewer && !playPauseBtn.disabled
    });
    document.getElementById('playPauseKeyHint')?.classList.toggle('hidden', !hint);
    if (hint) {
        playPauseBtn.title = hint.title;
        playPauseBtn.setAttribute('aria-keyshortcuts', hint.shortcut);
    } else {
        playPauseBtn.removeAttribute('title');
        playPauseBtn.removeAttribute('aria-keyshortcuts');
    }
}

// Flag a numeric input as invalid (red border) or restore its normal border.
function markInputValidity(input, ok) {
    if (!input) return;
    // A ring plus tinted background, so the flag is visible even on the
    // Climax HR input whose focus border is already rose.
    input.classList.toggle('border-rose-500', !ok);
    input.classList.toggle('ring-1', !ok);
    input.classList.toggle('ring-rose-500', !ok);
    input.classList.toggle('bg-rose-950/40', !ok);
    input.classList.toggle('border-slate-700', ok);
    if (ok) input.removeAttribute('aria-invalid');
    else input.setAttribute('aria-invalid', 'true');
}

// Read and validate the typed Resting / Climax HR. A field that does not
// parse keeps the last known-good value and is flagged, so garbage can never
// raise the ceiling.
function readHrLimits() {
    const minInput = document.getElementById('minHr');
    const maxInput = document.getElementById('maxHr');
    const limits = sanitizeHrLimits(minInput?.value, maxInput?.value, state.lastGoodHrLimits || {});
    if (limits.valid) state.lastGoodHrLimits = { minHr: limits.minHr, maxHr: limits.maxHr };
    markInputValidity(minInput, !limits.invalid.includes('min'));
    markInputValidity(maxInput, !limits.invalid.includes('max'));
    return limits;
}

function setBadgeState(type, status, nameLabel, batteryLabel = null) {
    const card = document.getElementById(`card${type}`);
    const dot = document.getElementById(`dot${type}`);
    const text = document.getElementById(`badge${type}Text`);
    const batBadge = document.getElementById(`badge${type}Battery`);

    if (text) text.textContent = nameLabel;
    if (batBadge) {
        if (batteryLabel) {
            batBadge.textContent = batteryLabel;
            batBadge.classList.remove('hidden');
        } else {
            batBadge.classList.add('hidden');
        }
    }

    if (card && dot) {
        if (status === 'connected') {
            card.className = "text-left p-2 rounded-xl bg-emerald-950/20 border border-emerald-800/80 hover:border-emerald-600 transition flex items-start gap-2 cursor-pointer min-w-0";
            dot.className = "h-2 w-2 rounded-full bg-emerald-400 animate-pulse shrink-0 mt-1";
        } else if (status === 'connecting') {
            card.className = "text-left p-2 rounded-xl bg-amber-950/20 border border-amber-800/80 hover:border-amber-600 transition flex items-start gap-2 cursor-pointer min-w-0";
            dot.className = "h-2 w-2 rounded-full bg-amber-400 animate-ping shrink-0 mt-1";
        } else if (status === 'warning') {
            card.className = "text-left p-2 rounded-xl bg-amber-950/20 border border-amber-700 hover:border-amber-500 transition flex items-start gap-2 cursor-pointer min-w-0";
            dot.className = "h-2 w-2 rounded-full bg-amber-400 shrink-0 mt-1";
        } else {
            card.className = "text-left p-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition flex items-start gap-2 cursor-pointer min-w-0";
            dot.className = "h-2 w-2 rounded-full bg-rose-500/30 border border-rose-500 shrink-0 mt-1";
        }
    }
    checkReadiness();
}

// Whether the host has a pulse source and a toy to drive. Sent to the remote
// controller so its transport can mirror the host's readiness.
function hardwareReadiness() {
    const hrReady = isBleConnected() || state.simEngaged;
    const toyReady = Boolean(
        handyConnected
        || isVacuglideConnected()
        || (isIntifaceConnected() && intifaceDevices.size > 0)
        || (isTCodeConnected() && countAssignedTCodeAxes() > 0)
    );
    return { hrReady, toyReady };
}

// True when the pulse source has delivered a usable reading recently enough
// for the watchdog (the simulator is never stale: its value is the slider).
function pulseIsFresh(now = Date.now()) {
    if (state.simEngaged) return true;
    return hrWatchdog.isFresh(now);
}

// Stricter than pulseIsFresh(): true only while hrCurrent is a LIVE reading.
// pulseIsFresh() stays true throughout the watchdog's hold window, where the
// pulse is frozen on the last valid packet; anything that would move the
// toys on something other than a measured beat must gate on this instead.
function pulseIsLive(now = Date.now()) {
    if (state.simEngaged) return true;
    return hrWatchdog.status(now) === 'ok';
}

// Why START / RESUME must stay disabled right now, or null when the session
// may start. Shared by checkReadiness() and startOrResumeSession() so a
// remote command can never bypass what the button shows: resuming on a
// frozen heart rate would drive the toys for a full tick (or the whole
// signal-loss timeout) before the watchdog re-paused.
function transportWaitingReason(now = Date.now()) {
    // One START at a time: the button stays disabled while The Handy is
    // being asked, so a second press cannot queue a second start behind it.
    if (startGate.isPending()) return "CHECKING THE HANDY";
    const { hrReady, toyReady } = hardwareReadiness();
    if (!hrReady && !toyReady) return "WAITING FOR HR SENSOR & TOY";
    if (!hrReady) return "WAITING FOR HR SENSOR";
    if (!toyReady) return "WAITING FOR TOY CONNECTION";
    if (state.sessionStatus === 'PAUSED' && state.hrSignalPaused) return "WAITING FOR PULSE";
    if (!pulseIsFresh(now)) return "WAITING FOR PULSE";
    return null;
}

function checkReadiness() {
    if (!playPauseBtn) return;

    const active = state.sessionStatus === 'RUNNING' || state.sessionStatus === 'PAUSED' || state.sessionStatus === 'RAMPDOWN';

    if (isRemotePage) {
        // A remote page has no hardware of its own: it mirrors the host's
        // state; a controller sends commands, a viewer can only watch.
        if (remoteLinkLost) renderTransportWaiting("HOST LINK LOST");
        else if (active || state.remoteHostReady) renderTransport(state.sessionStatus);
        else renderTransportWaiting("WAITING FOR HOST HARDWARE");
        if (isRemoteViewer) {
            playPauseBtn.disabled = true;
            playPauseBtn.classList.remove('cursor-pointer');
            playPauseBtn.classList.add('cursor-not-allowed', 'opacity-70');
        }
        return;
    }

    if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') {
        playPauseBtn.disabled = false;
        return;
    }

    // IDLE and PAUSED alike: START / RESUME need a pulse source with a fresh
    // valid reading and a toy.
    const reason = transportWaitingReason();
    if (reason) renderTransportWaiting(reason);
    else renderTransport(state.sessionStatus === 'PAUSED' ? 'PAUSED' : 'IDLE');
}

// Center Intensity Slider
const intensitySlider = document.getElementById('intensitySlider');
const intensityValDisplay = document.getElementById('intensityValDisplay');
intensitySlider?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    state.intensityValue = val;
    const pct = Math.round(50 + val);
    if (intensityValDisplay) {
        intensityValDisplay.textContent = val === 50 ? "100% (Default Balanced)" : `${pct}% (${val > 50 ? 'Intense' : 'Gentle'})`;
        intensityValDisplay.className = val > 65 ? 'font-mono font-bold text-rose-400' : (val < 35 ? 'font-mono font-bold text-emerald-400' : 'font-mono font-bold text-amber-400');
    }
    updateEngine();
    syncTelemetry();
});
// A pointer drag would leave the slider holding the keyboard focus, so the
// arrow, Home, End and Page keys pressed afterwards kept moving a motor speed
// long after the hand had left the mouse. Keyboard use keeps the focus.
releaseFocusOnPointerUp(intensitySlider);

// The hardware travel envelope is ONE persisted setting (advancedSettings
// handyHwMin / handyHwMax) that bounds The Handy and every TCode linear axis,
// so it is edited from both the Handy and the TCode modal. Every input and
// display on the page is listed here and kept in sync.
const HW_ENVELOPE_INPUT_IDS = {
    min: ['hwMinInput', 'tcodeHwMinInput'],
    max: ['hwMaxInput', 'tcodeHwMaxInput']
};
const HW_ENVELOPE_DISPLAY_IDS = ['hwEnvelopeDisplay', 'tcodeHwEnvelopeDisplay'];

function hwEnvelopeInputs(bound) {
    return HW_ENVELOPE_INPUT_IDS[bound].map((id) => document.getElementById(id)).filter(Boolean);
}

// Update every Travel Envelope Bounds display (Handy and TCode modals)
function updateHwEnvelopeDisplay() {
    const env = normalizeEnvelope(advancedSettings.handyHwMin, advancedSettings.handyHwMax);
    HW_ENVELOPE_DISPLAY_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = `Bounds: ${env.min}% - ${env.max}%`;
    });
    updateHandySlideDisplay();
}

// What a full-length stroke actually reaches The Handy as, once the end-stop
// margin has been applied. The wearer can see what the margin costs them
// before they decide what to type into it. Handy only; the T-Code and
// Intiface axes get the envelope unchanged.
function updateHandySlideDisplay() {
    const el = document.getElementById('handySlideDisplay');
    if (!el) return;
    const env = normalizeEnvelope(advancedSettings.handyHwMin, advancedSettings.handyHwMax);
    const margin = clampEndMargin(advancedSettings.handyEndMargin);
    const sent = applyEndMargin({ min: env.min, max: env.max }, margin);
    // The margin yields rather than shrink a stroke below its minimum width,
    // so an envelope only just that wide and sitting on an end keeps the end.
    // That is the one case where the number above does nothing, and the
    // wearer should not have to infer it by reading the two numbers back.
    const stillOnEnd = margin > 0 && (sent.min === 0 || sent.max === 100);
    // Only a FULL-LENGTH stroke is described here: this is the envelope with
    // the margin applied, and a warm-up tick or any mode that narrows the zone
    // sends less than this. Saying "sent to the device" flatly would be false
    // for most of a session, and a wearer reading this row is usually reading
    // it because their device did something they did not expect.
    el.textContent = `A full-length stroke reaches the device as ${sent.min}% - ${sent.max}%`
        + (stillOnEnd ? ' - this Travel Envelope is too narrow for the margin to move the stroke off the end.' : '');
}

// Put an end-stop margin (0-10; 0 sends the range untouched) in effect and
// persist it. The field is bound through handy-fields.js, which decides what
// each keystroke or commit may do: a keystroke can raise the margin once the
// number is finished, never lower it, so typing 10 over 5 no longer sends
// strokes out to 1% on the way. A commit writes the corrected value back into
// the field.
function putHandyEndMargin(margin, commit) {
    const el = document.getElementById('handyEndMarginInput');
    advancedSettings.handyEndMargin = margin;
    if (commit && el && String(el.value) !== String(margin)) el.value = margin;
    persistSettings();
    updateHandySlideDisplay();
    updateEngine();
}

// Normalise the persisted envelope and push it into every modal input. Used
// on boot and after a settings import, so a hand-edited or imported file can
// never produce an inverted or zero-width envelope.
function syncHwEnvelopeInputs() {
    const env = normalizeEnvelope(advancedSettings.handyHwMin, advancedSettings.handyHwMax);
    advancedSettings.handyHwMin = env.min;
    advancedSettings.handyHwMax = env.max;
    hwEnvelopeInputs('min').forEach((el) => { el.value = env.min; });
    hwEnvelopeInputs('max').forEach((el) => { el.value = env.max; });
    // The end-stop margin sits in the same panel and is restored the same
    // way, so an imported file can never leave the input showing one number
    // while the driver uses another.
    advancedSettings.handyEndMargin = clampEndMargin(advancedSettings.handyEndMargin);
    const marginInput = document.getElementById('handyEndMarginInput');
    if (marginInput) marginInput.value = advancedSettings.handyEndMargin;
    updateHwEnvelopeDisplay();
}

// Put a Travel Envelope in effect: the persisted settings, every input (both
// modals) and the engine. The fields are bound through handy-fields.js, which
// decides what each event on them may do: a keystroke only ever narrows,
// exactly as typed, and never touches the other bound; a commit clamps to
// 0-100 and keeps at least a 10% stroke by moving the bound the wearer did
// NOT edit. `edited` is the input being typed into, if any.
function putHwEnvelope(env, commit, edited = null) {
    advancedSettings.handyHwMin = env.min;
    advancedSettings.handyHwMax = env.max;
    // While typing, only rewrite the inputs the user is NOT focused on so a
    // half-typed number is not yanked away; on commit, rewrite all of them.
    hwEnvelopeInputs('min').forEach((el) => {
        if ((commit || el !== edited) && String(el.value) !== String(env.min)) el.value = env.min;
    });
    hwEnvelopeInputs('max').forEach((el) => {
        if ((commit || el !== edited) && String(el.value) !== String(env.max)) el.value = env.max;
    });
    persistSettings();
    updateHwEnvelopeDisplay();
    updateEngine();
}

// Every typed field of the Handy and TCode panels: the four envelope inputs
// and the end-stop margin.
function handyPanelFields() {
    return [...hwEnvelopeInputs('min'), ...hwEnvelopeInputs('max'), document.getElementById('handyEndMarginInput')].filter(Boolean);
}

// Put back a number still waiting in a Handy panel field when the panel is
// about to be hidden while the field still has the focus: the Handy link or a
// heart-rate monitor finishing its connection closes the modal under a wearer
// who is typing, and the browser would commit the field it hides
// (settleFocusedField says why, and what it does instead).
function settleHandyPanelInputs() {
    settleFocusedField(handyPanelFields(), document.activeElement, syncHwEnvelopeInputs);
}

// The Handy Role, Speed Cap & Physical Travel Envelope Controls
function initHandyRoleUI() {
    const pBtn = document.getElementById('handyRolePrimaryBtn');
    const sBtn = document.getElementById('handyRoleSecondaryBtn');
    const oBtn = document.getElementById('handyRoleOffBtn');
    const capSlider = document.getElementById('handyCapSlider');
    const capVal = document.getElementById('handyCapVal');

    if (capSlider && capVal) {
        capSlider.value = state.handyMaxCap ?? 100;
        capVal.textContent = `${state.handyMaxCap ?? 100}%`;
        capSlider.addEventListener('input', (e) => {
            state.handyMaxCap = parseInt(e.target.value, 10);
            capVal.textContent = `${state.handyMaxCap}%`;
            safeSet('handy_max_cap', String(state.handyMaxCap));
            updateEngine();
        });
    }

    // Every typed field in this panel is bound through handy-fields.js, which
    // turns what the browser reports - a keystroke, its own commit, Enter, the
    // wearer leaving the field, the window losing the focus - into what may be
    // put in effect, and asks the document whether the page has the focus.
    // The value itself is painted by syncHwEnvelopeInputs (below, and again
    // after every settings import).
    const marginInput = document.getElementById('handyEndMarginInput');
    if (marginInput) {
        bindEndMarginField(marginInput, {
            page: document,
            margin: () => advancedSettings.handyEndMargin,
            put: putHandyEndMargin
        });
    }

    // Envelope inputs live in the Handy AND the TCode modal, all bound to the
    // same persisted setting; editing either keeps the others in sync.
    syncHwEnvelopeInputs();
    ['min', 'max'].forEach((bound) => {
        hwEnvelopeInputs(bound).forEach((el) => {
            bindEnvelopeField(el, bound, {
                page: document,
                envelope: () => ({ min: advancedSettings.handyHwMin, max: advancedSettings.handyHwMax }),
                put: (env, commit) => putHwEnvelope(env, commit, el)
            });
        });
    });

    const applyRole = (role) => {
        state.handyRole = role;
        safeSet('handy_role', role);
        const badge = document.getElementById('modalHandyRoleBadge');

        if (pBtn) pBtn.className = role === 'primary' ? "py-1.5 rounded-lg bg-rose-600 text-white font-bold text-xs transition cursor-pointer" : "py-1.5 rounded-lg bg-slate-800 text-slate-400 font-bold text-xs hover:text-white transition cursor-pointer";
        if (sBtn) sBtn.className = role === 'secondary' ? "py-1.5 rounded-lg bg-purple-600 text-white font-bold text-xs transition cursor-pointer" : "py-1.5 rounded-lg bg-slate-800 text-slate-400 font-bold text-xs hover:text-white transition cursor-pointer";
        if (oBtn) oBtn.className = role === 'off' ? "py-1.5 rounded-lg bg-slate-700 text-amber-300 font-bold text-xs transition cursor-pointer" : "py-1.5 rounded-lg bg-slate-800 text-slate-400 font-bold text-xs hover:text-white transition cursor-pointer";

        if (badge) {
            if (role === 'primary') { badge.textContent = "Primary (Tease)"; badge.className = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800"; }
            else if (role === 'secondary') { badge.textContent = "Secondary (Milker)"; badge.className = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800"; }
            else { badge.textContent = "Disabled (OFF)"; badge.className = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-amber-400 border border-slate-700"; }
        }
        // A running session drives the Handy from here in this role.
        if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') settleDrivenHandyStop();
        updateEngine();
    };

    pBtn?.addEventListener('click', () => applyRole('primary'));
    sBtn?.addEventListener('click', () => applyRole('secondary'));
    oBtn?.addEventListener('click', () => applyRole('off'));
    applyRole(state.handyRole || 'primary');
}

// Everything the working ceiling is computed from, in one object: the engine
// hands it to computeEffectiveCeiling, and the Came Early, Wipe Memory and
// Finished me dialogs work from the same object, so a dialog can never work
// its numbers out from different inputs than the motors run on. Survival's
// two switches - no decay during the game, and its overdrive only while it
// is on - are made by workingCeilingInputs, with Force Orgasm's boost.
function ceilingInputs(minHr, typedMaxHr) {
    // Dual Stimulation Offset Check: a stroker (primary) AND an internal toy
    // (secondary) are both live. The Handy and the VacuGlide count for
    // whichever role they hold; Intiface and TCode axes count for the role
    // they are assigned.
    const intifaceHasRole = (role) => Array.from(intifaceDevices.values()).some(d => d.axes.some(a => a.role === role));
    const serialHasRole = (role) => isTCodeConnected() && tcodeHasRole(role);
    const vacuglideHasRole = (role) => isVacuglideConnected() && sanitizeVacuglideRole(advancedSettings.vacuglideRole) === role;
    const hasPrimary = (handyConnected && state.handyRole === 'primary') || vacuglideHasRole('primary') || intifaceHasRole('primary') || serialHasRole('primary');
    const hasSecondary = (handyConnected && state.handyRole === 'secondary') || vacuglideHasRole('secondary') || intifaceHasRole('secondary') || serialHasRole('secondary');
    return workingCeilingInputs({
        minHr,
        maxHr: typedMaxHr,
        activeMode: state.activeMode,
        settings: advancedSettings,
        dualStimActive: hasPrimary && hasSecondary,
        edges: state.edges,
        orgasmMode: state.orgasmMode,
        orgasmBoost: state.orgasmBoost,
        survivalOverdrive: state.survivalOverdrive
    });
}

// The working ceiling: typed Climax HR minus learned / dual-stim / decay
// offsets (never raised by any of them), plus two explicit raises: Force
// Orgasm, and Survival's per-edge overdrive. One place only, so the engine,
// the cockpit badges and the Session Setup preview can never quote different
// BPM at the wearer.
function workingCeiling(minHr, typedMaxHr) {
    return computeEffectiveCeiling(ceilingInputs(minHr, typedMaxHr));
}

// Engine Calculation Loop
function updateEngine() {
    if (isRemotePage) return;

    const limits = readHrLimits();
    const min = limits.minHr;
    const typedMax = limits.maxHr;
    let hr = state.hrCurrent;
    if (!Number.isFinite(hr) || hr < 35) hr = min;

    const ceiling = workingCeiling(min, typedMax);
    const max = ceiling.maxHr;
    // Two heart rates from here on. `sensorHr` is what the monitor measured:
    // every guard, game, counter, the cockpit readout and the session record
    // judge THAT number. `hr` may additionally carry the microphone boost,
    // which drives the engine's falling tease curve only - never a term that
    // RISES with arousal (the two climb games' ramps, the milking modes'
    // secondary), every one of which reads the sensor alone.
    const sensorHr = hr;
    // The boost is frozen with the pulse. Inside the watchdog's hold window
    // the engine keeps the boost measured on the last fresh reading, so an
    // ordinary inter-packet gap (a watch relaying every ~5 s trips the 5 s
    // band on jitter alone) can neither grow it on room noise nor drop it
    // out - and a drop-out speeds the motors UP in every tease mode.
    const pulseFresh = pulseIsLive();
    if (pulseFresh) state.micBoostHeld = Number.isFinite(state.micBoost) ? state.micBoost : 0;
    hr = micBoostedHr({
        sensorHr,
        micBoost: state.micBoost,
        heldBoost: state.micBoostHeld,
        ceiling: max,
        micEnabled: Boolean(advancedSettings.micEnabled),
        pulseFresh
    });
    // What the boost actually added this tick. It is 0 whenever the boost is
    // suppressed (no live reading, or the pulse is already at the ceiling),
    // and the badge shows THAT, so it can never claim a push the engine is
    // not making: the big BPM number no longer moves with the boost, which
    // leaves the badge as the only signal the wearer has.
    // ...and only in a mode that feeds the boosted pulse to a motor at all:
    // the Oracle and Edge Training compute both channels from the MEASURED
    // pulse, so the boost reaches nothing there and a MIC +N badge sent the
    // wearer off to adjust a gate and a cap that change nothing.
    const micReaches = micBoostReachesMotors(state.activeMode, { edgeStrokeDepth: advancedSettings.edgeStrokeDepth });
    const micRaw = Number.isFinite(hr) && Number.isFinite(sensorHr) ? hr - sensorHr : 0;
    const micApplied = micReaches && micRaw > 0 ? micRaw : 0;
    state.micApplied = micApplied;
    const micBadge = document.getElementById('micActiveBadge');
    const micBadgeLive = Boolean(state.micAnalyser) && (Boolean(advancedSettings.micEnabled) || state.isTestingMic);
    if (micBadge && micBadgeLive) {
        if (micApplied > 0) {
            micBadge.textContent = `MIC +${micApplied}`;
            micBadge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-950/80 border border-rose-700 text-rose-300 ml-1';
        } else {
            micBadge.textContent = 'MIC LISTEN';
            micBadge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-950/80 border border-emerald-700 text-emerald-300 ml-1';
        }
        micBadge.classList.remove('hidden');
    } else if (micBadge) {
        micBadge.classList.add('hidden');
    }
    state.effectiveMinHr = min;
    state.effectiveMaxHr = max;
    state.effectiveHr = hr;
    state.sensorHr = sensorHr;

    const hrDisplay = document.getElementById('hrDisplay');
    if (hrDisplay) hrDisplay.textContent = sensorHr;
    if (!Number.isFinite(state.peakHr) || sensorHr > state.peakHr) state.peakHr = sensorHr;

    // Each offset badge is shown while its offset is asked for, and says how
    // much of it the floor let through - the same amounts the ceiling below
    // was built from, so the badges add up to it. They used to print the
    // requested amounts: LEARNED -3 and DUAL STIM (-15 BPM) stayed lit over
    // an engine the Resting HR floor was holding at the typed Climax HR. A
    // floored offset now reads as the smaller number, or 0, instead of
    // quietly vanishing, so a wearer can see that protection is not in force.
    const learnBadge = document.getElementById('learnBadge');
    const learnAmount = document.getElementById('learnAmountText');
    if (learnAmount) learnAmount.textContent = ceiling.appliedLearned;
    learnBadge?.classList.toggle('hidden', !(ceiling.requestedLearned > 0));

    const dualBadge = document.getElementById('dualStimBadge');
    if (dualBadge) {
        dualBadge.textContent = `DUAL STIM (-${ceiling.appliedDual} BPM)`;
        dualBadge.classList.toggle('hidden', !(ceiling.requestedDual > 0));
    }

    const decayBadge = document.getElementById('decayBadge');
    const decayText = document.getElementById('decayAmountText');
    if (decayText) decayText.textContent = ceiling.appliedDecay;
    decayBadge?.classList.toggle('hidden', !(ceiling.requestedDecay > 0));

    paintLearningStatus(ceiling);

    // Shown whenever the working ceiling differs from the typed Climax HR.
    // The two raises it can carry are the ones the ceiling applied.
    const ceilingBadge = document.getElementById('effectiveCeilingBadge');
    const ceilingLabel = document.getElementById('effectiveCeilingLabel');
    const ceilingText = document.getElementById('effectiveCeilingText');
    if (ceilingLabel) {
        const raised = ceiling.orgasmBoost > 0 || ceiling.survivalOverdrive > 0;
        ceilingLabel.textContent = raised ? 'OVERDRIVE CEILING' : 'CEILING';
    }
    if (ceilingText) ceilingText.textContent = max;
    ceilingBadge?.classList.toggle('hidden', max === typedMax);

    const holdPct = clampEdgeHoldPercent(advancedSettings.edgeHoldPercent);
    const triggerHr = resolveEdgeTriggerHr(max, holdPct, min);
    const holdBadge = document.getElementById('edgeHoldBadge');
    const holdText = document.getElementById('edgeHoldText');
    if (holdText) holdText.textContent = `${triggerHr}`;
    holdBadge?.classList.toggle('hidden', holdPct === 100 || triggerHr === max);
    state.edgeTriggerHr = triggerHr;
    updateEdgeHoldPreview(ceiling);

    const result = calculateEngineOutputs({
        hr,
        edgeHr: sensorHr,
        minHr: min,
        maxHr: max,
        activeMode: resolveEngineMode(state.activeMode),
        sessionStatus: state.sessionStatus,
        rampdownSecondsLeft: state.rampdownSecondsLeft,
        landingFrom: state.landingFrom,
        isEdged: state.isEdged,
        edgePending: state.edgePending,
        // Two readings further apart than the signal-loss timeout are not
        // consecutive: across that gap the watchdog called the pulse lost.
        recentReadings: edgeReadings,
        readingGapMs: hrWatchdog.settings.staleMs,
        orgasmMode: state.orgasmMode,
        orgasmBoost: state.orgasmMode ? state.orgasmBoost : 0,
        orgasmFrom: state.orgasmMode ? state.orgasmFrom : null,
        gamma: advancedSettings.gammaCurve,
        intensityValue: state.intensityValue,
        edgeStrokeDepth: advancedSettings.edgeStrokeDepth,
        strokeMode: state.teaseMode,
        handyHwMin: advancedSettings.handyHwMin,
        handyHwMax: advancedSettings.handyHwMax,
        sessionSeconds: state.sessionSeconds,
        warmupMinutes: advancedSettings.warmupMinutes,
        stallGuardEngaged: state.stallGuardEngaged,
        ceilingBehaviour: advancedSettings.ceilingBehaviour,
        edgeHoldPercent: advancedSettings.edgeHoldPercent,
        ruinHoldSeconds: state.ruinHoldSeconds,
        ruinSpent: state.ruinSpent,
        oracleState: state.oracleState,
        survivalSpeedFloor: state.survivalSpeedFloor,
        trainingState: state.trainState
    });

    // A new edge, and only a new edge, earns Ruin & Leak another ride. The
    // ride is part of the pullback, so it starts with the flag, on the first
    // reading at the mark, as it always did. Keyed to the count below, which
    // comes a reading later, it would restart a ride already under way, and
    // on a relay whose second reading came after the 12 s ride it would hand
    // the same edge a second ride once its lockout ran out.
    if (result.pullbackStarted) applyRuinClock(startRuinEdge(readRuinClock()));
    // The edge itself - the counter, with Adaptive Ceiling Decay and
    // Survival's climb reading it, the rotator and the edge cue - waits for
    // the pulse to hold at the mark (edge-confirm.js).
    if (result.newEdgeTriggered) {
        state.edges += 1;
        const edgeEl = document.getElementById('edgeCount');
        if (edgeEl) edgeEl.textContent = state.edges;
        // The new direction goes out with this edge's own speed, below; the
        // speed from before the edge is never sent reversed first.
        reverseIntifaceRotation('edge', Date.now(), { apply: false });
        cueVoice('edge');
    }
    // Survival steps its climb on the edges counted while it is on. The edge
    // that was in progress when it was switched on is one from before the
    // switch, and a count made for it here is seen instead of stepped
    // (survivalEdgesAtSwitch).
    const survivalSeen = survivalEdgesAfterEngine(
        { edgesSeen: state.survivalEdgesSeen, owedEdgeSeen: state.survivalOwedEdgeSeen },
        result
    );
    state.survivalEdgesSeen = survivalSeen.edgesSeen;
    state.survivalOwedEdgeSeen = survivalSeen.owedEdgeSeen;

    state.isEdged = result.isEdged;
    state.edgePending = result.edgePending;
    state.strokerSpeed = result.primaryPercent;
    state.prostateSpeed = result.secondaryPercent;
    state.strokeMin = result.strokeMinPercent;
    state.strokeMax = result.strokeMaxPercent;

    const strokerVal = document.getElementById('strokerVal');
    const strokerBar = document.getElementById('strokerBar');
    const prostateVal = document.getElementById('prostateVal');
    const prostateBar = document.getElementById('prostateBar');
    const strokeBadge = document.getElementById('strokeRangeBadge');

    if (strokerVal) strokerVal.textContent = `${result.primaryPercent}%`;
    if (strokerBar) strokerBar.style.width = `${result.primaryPercent}%`;
    if (prostateVal) prostateVal.textContent = `${result.secondaryPercent}%`;
    if (prostateBar) prostateBar.style.width = `${result.secondaryPercent}%`;
    if (strokeBadge) strokeBadge.textContent = `Zone: ${result.strokeMinPercent}-${result.strokeMaxPercent}%`;

    // The banner names what each channel was really sent this tick, and is
    // silent unless the session is running: the edge flag survives a pause on
    // purpose, so it used to keep claiming an active secondary through a
    // watchdog pause with every motor stopped.
    const cutoffEl = document.getElementById('cutoffNotice');
    if (cutoffEl) {
        const cutoffText = describeCutoffNotice({
            sessionStatus: state.sessionStatus,
            isEdged: state.isEdged,
            orgasmMode: state.orgasmMode,
            stallGuardEngaged: state.stallGuardEngaged,
            primaryPercent: result.primaryPercent,
            secondaryPercent: result.secondaryPercent
        });
        cutoffEl.textContent = cutoffText;
        cutoffEl.classList.toggle('hidden', !cutoffText);
    }

    const stallNotice = document.getElementById('stallGuardNotice');
    if (stallNotice) {
        // In Ruin & Leak the banner says whether the ride is still there when
        // the pause ends, from the same two clocks that decide it.
        const rideLeft = ruinRideSecondsLeft(readRuinClock(), { active: state.activeMode === 'ruin', isEdged: state.isEdged });
        const pauseLeft = stallPauseSecondsLeft(
            { pauseSeconds: state.stallPauseElapsed, engaged: state.stallGuardEngaged },
            { pauseTimeoutSeconds: advancedSettings.stallPauseSeconds }
        );
        if (state.stallGuardEngaged) {
            stallNotice.textContent = describeStallPauseNotice({
                mode: state.activeMode,
                ceilingBehaviour: advancedSettings.ceilingBehaviour,
                rideSecondsLeft: rideLeft,
                pauseSecondsLeft: pauseLeft
            });
        } else if (stallNotice.textContent !== '') {
            // Emptied as well as hidden: a banner that is not engaged has
            // nothing true to say, and a sentence left behind display:none
            // is one paint away from being shown for the wrong mode.
            stallNotice.textContent = '';
        }
        stallNotice.classList.toggle('hidden', !state.stallGuardEngaged);
    }

    updateWarmupBadge();
    updateGameNotice(ceiling);
    renderForceOrgasmButton();

    dispatchHardware(result.primaryPercent, result.secondaryPercent, result.strokeMinPercent, result.strokeMaxPercent);
}

// Physical stroke bounds to send to the toys. engine.js has ALREADY mapped
// strokeMin/strokeMax into the hardware envelope, so they are passed through.
function effectiveStrokeRange(strokeMin, strokeMax) {
    const env = normalizeEnvelope(advancedSettings.handyHwMin, advancedSettings.handyHwMax);
    return { min: strokeMin, max: strokeMax, env };
}

// The master clock's dispatch (tick-dispatch.js): what the engine computes
// while a tick runs is sent once, when the tick is over, so the toys get the
// decision the guards and games leave standing - a cut in the same tick it
// was decided, and never first the speed it overrules.
const tickDispatch = createTickDispatch();

// What a live session is driving right now, for its crash-recovery marker.
// Called before every dispatch, and whenever a toy joins mid-session: a role
// change or a Test press can move an Intiface or T-Code axis before the
// next engine tick does, and the marker must name the toy by then. Called
// after every dispatch as well, and when the page is frozen, so that every
// other page knows at once whether this session drives its Handy right now,
// a start the dispatch has just sent included: a page recovering a crash
// leaves a Handy to this one only while it does (drivesHandyNow). That is a
// Web Lock, never a storage write: the marker is written when a session
// starts or a toy joins it, not at the starts and stops of the Handy
// (crash-recovery.js). The first call of a session also recovers any page
// that died while this one was open (createCrashRecovery): the wearer may be
// carrying on here next to the Handy that page left moving.
let liveSessionUnsaved = false;
// Set from 'freeze' to 'resume': a frozen page runs nothing, so it drives
// nothing, whatever its driver last believed.
let pageFrozen = false;
function noteLiveHardware() {
    if (!crashRecovery || state.sessionStatus === 'IDLE') return;
    const handyKey = handyConnected ? getHandyKey() : '';
    const current = crashRecovery.note({
        handyKey,
        driving: drivesHandyNow({ sessionStatus: state.sessionStatus, handyKey, mayBeMoving: handyMayBeMoving(), frozen: pageFrozen }),
        intiface: isIntifaceConnected() && intifaceDevices.size > 0,
        tcode: isTCodeConnected(),
        // A VacuGlide joins the marker with the cluster it is reached
        // through: a crash sends it no unload stop and leaves no handover
        // entry, so the marker is all the next page has to stop it with.
        vacuglide: isVacuglideConnected() ? { token: getVacuglideToken(), cluster: getVacuglideCluster() } : null
    });
    if (!current && !liveSessionUnsaved) {
        liveSessionUnsaved = true;
        console.warn('The crash-recovery marker is not in localStorage (storage full or unavailable): only its IndexedDB copy, if it has one, can tell the next page to stop The Handy if this page dies mid-session.');
    }
}

// Set while a dispatch has left a toy out because the marker on disk does
// not name it yet (crash-recovery.js, waitingForDisk). The commit that names
// it runs the engine again at once (resumeHeldDispatch).
let heldDispatch = false;
const NOTHING_HELD = Object.freeze({ handy: false, intiface: false, tcode: false, vacuglide: false });

// `urgent`: the decision of a tick a guard engaged in, or in which Force
// Orgasm's time limit handed the run to its landing (the master clock
// passes it with the tick's decision).
function dispatchHardware(primarySpeed, secondarySpeed, strokeMin, strokeMax, force = false, urgent = false) {
    if (isRemotePage) return;
    // Before any command of a live session reaches a toy: no moment in which
    // a crash could leave hardware moving without a marker for the next page
    // to find. PAUSED counts too: the session has not ended, and a pause is
    // often the answer to a device that stopped confirming anything.
    noteLiveHardware();

    // Inside a tick an ordinary dispatch waits for the end of the tick. A
    // forced one (STOP, a pause, the watchdog) goes out now and nothing the
    // tick decided before it may follow it; a tick sends a stop once, and
    // nothing after it. What goes out is urgent when it is forced, cuts a
    // moving primary to 0, or a guard or Force Orgasm's time limit made it:
    // every toy takes it now - The Handy past its velocity throttle, a
    // stroker on the leg in flight - whichever channel it follows.
    const release = tickDispatch.admit([primarySpeed, secondarySpeed, strokeMin, strokeMax], { force, urgent });
    if (!release) return;
    // And not before the marker naming the toy is on disk. localStorage
    // reaches the disk a minute or more late, so a browser force-quit early
    // in a session left the next page no marker, and The Handy kept
    // stroking. The wait is the IndexedDB commit, milliseconds: for the
    // first command of a session, and the first to a toy that joins one,
    // the engine runs again the moment it lands, or once IndexedDB has had
    // DURABLE_WRITE_TIMEOUT_MS to answer. Once the marker naming a toy has
    // reached the disk or had that long, the toy is never held again in the
    // session (waitingForDisk): it may be moving by then, and what the
    // engine sends it next may be a stop - Full Stop at the ceiling, the
    // stall guard - and a stop is never held back; nor is a forced
    // dispatch, which is one. Asked of what goes out, never of what a tick
    // holds for its end: that is asked again when the tick sends it.
    const held = force || !crashRecovery ? NOTHING_HELD : crashRecovery.waitingForDisk();
    heldDispatch = held.handy || held.intiface || held.tcode || held.vacuglide;
    // Only what goes out is what the toys were sent. A decision a tick held
    // and replaced never reached them, and Force Orgasm's ramp and its
    // landing start from what did: a landing must never begin above the
    // speed the toys were really running.
    lastDispatched = { primary: primarySpeed, secondary: secondarySpeed, strokeMin, strokeMax };

    // The role picks the channel and the speed cap scales it. A low cap
    // slows a crawl down to the slowest velocity the Handy has; it never
    // rounds one into PUT /hamp/stop (handy-protocol.js says why).
    const targetHandySpeed = handyTargetSpeed(state.handyRole, primarySpeed, secondarySpeed, state.handyMaxCap);

    const range = effectiveStrokeRange(strokeMin, strokeMax);

    // The end-stop margin is The Handy's alone: it is a property of that
    // carriage and its firmware, not of the session, so it is applied in the
    // driver and the funscript export still records what the engine asked
    // for. A T-Code or Intiface linear axis takes a wider zone as a longer,
    // slower stroke rather than a faster one, so they keep the envelope as is.
    if (!held.handy) dispatchHandy(targetHandySpeed, range.min, range.max, force, range.env.min, range.env.max, advancedSettings.handyEndMargin, { urgent: release.urgent });
    // The VacuGlide takes one speed and nothing else: the channel its role
    // names, under its cap. It has no stroke range to follow and no second
    // motor for the other channel, and its valves are the wearer's alone -
    // nothing on this path can open one. A cut to 0 is its whole stop, which
    // goes at once; urgent lets the tick's decision past the one-second gap
    // between speeds, as a routine request that never spends the reserve its
    // request budget keeps for a stop.
    if (!held.vacuglide) dispatchVacuglide(vacuglideSpeedFor(advancedSettings.vacuglideRole, primarySpeed, secondarySpeed, advancedSettings.vacuglideMaxCap), force, { urgent: release.urgent });
    // Intiface linear axes run on their own per-leg timers; this call only
    // updates the planner inputs (and, with force, issues StopAllDevices;
    // urgent re-times the leg in flight).
    if (!held.intiface) dispatchIntiface(primarySpeed, secondarySpeed, range.min, range.max, range.env.min, range.env.max, force, { urgent: release.urgent });
    // Same for the direct T-Code serial device: a forced zero dispatch is an
    // immediate stop (every axis to rest on one line).
    if (!held.tcode) dispatchTCode(primarySpeed, secondarySpeed, range.min, range.max, range.env.min, range.env.max, force, { urgent: release.urgent });
    // And once more after it: every other page learns of a start this
    // dispatch just sent before it can take The Handy for one nobody drives.
    noteLiveHardware();
}

// A change of the crash-recovery records has reached the disk, failed or
// timed out. A dispatch that left a toy out for it goes out now, with what
// the engine asks for now. A session stopped or paused meanwhile has had
// its forced stop, and is left alone.
function resumeHeldDispatch() {
    if (!heldDispatch) return;
    heldDispatch = false;
    if (state.sessionStatus !== 'RUNNING' && state.sessionStatus !== 'RAMPDOWN') return;
    updateEngine();
}

// Queue a spoken cue (voice.js keeps a short queue, so back-to-back cues are
// all heard instead of cutting each other off). An `urgent` cue (signal
// lost, stop) jumps the queue and silences whatever was waiting.
function sessionVoiceVars() {
    return {
        hr: Math.round(Number.isFinite(state.sensorHr) ? state.sensorHr : (state.hrCurrent || 0)),
        maxHr: Math.round(Number.isFinite(state.effectiveMaxHr) ? state.effectiveMaxHr : 0),
        minHr: Math.round(Number.isFinite(state.effectiveMinHr) ? state.effectiveMinHr : 0),
        edges: state.edges || 0,
        minutes: Math.floor(Math.max(0, state.sessionSeconds || 0) / 60),
        done: state.trainEdgesDone || 0,
        need: clampTrainEdges(advancedSettings.trainEdges),
        hold: Math.max(0, clampTrainHoldSeconds(advancedSettings.trainHoldSeconds) - (state.trainHoldSeconds || 0))
    };
}

// The resting line for the dashboard. An emptied Resting prompt bank is a
// mute the wearer chose (the editor labels it so), and substituting the
// factory sentence put the exact line they had just deleted back on the
// cockpit at every idle moment. Empty means empty; paintIdlePrompt() then
// leaves the box hidden rather than inventing one.
function dashboardIdlePrompt() {
    const { text } = resolveVoiceCue(advancedSettings.voiceCues, 'idle', sessionVoiceVars());
    return text;
}

// The prompt line is on screen whether or not the voice is on (see cueVoice).
// A remote page runs no engine, so its line could only ever be this device's
// own resting phrase, never the wearer's cue.
function paintIdlePrompt() {
    const text = state.lastSpokenPrompt || dashboardIdlePrompt();
    setMindgamePrompt(text, Boolean(text) && !isRemotePage);
    renderVoiceState();
}

// Deliver a cue; voice-status.js decides how. Every cue is painted on the
// dashboard prompt line whether or not voice guidance is on: with the voice
// off the line used to stay hidden, so a wearer without working speech got
// no cue in any channel - a lost pulse or a stall pause included. Voice
// guidance ON also speaks it, and an `urgent` cue (signal lost, stop) jumps
// the TTS queue.
//
// "Muted" and "voice guidance off" are different states. An emptied phrase
// bank resolves to '': that cue says nothing and paints nothing, and the
// dashboard keeps whatever the last unmuted cue wrote. Hiding the box there
// wiped a live edge warning one second after it appeared, every
// encouragement interval, all session.
//
// `vars` overrides the live values the cue's tokens are filled from, for a
// cue that is not about this second's pulse: Came Early's {hr} is the peak
// its step was judged on, and nothing when there was no reading, not the
// cockpit's current value - which is the 70 the app starts with when no
// monitor is on.
function cueVoice(key, urgent = false, vars = null) {
    const lastTemplate = state.lastCueTemplateById?.[key] || '';
    const { text, template } = resolveVoiceCue(
        advancedSettings.voiceCues,
        key,
        { ...sessionVoiceVars(), ...(vars || {}) },
        { lastTemplate }
    );
    const now = Date.now();
    const plan = planCueDelivery({
        text,
        urgent,
        voiceEnabled: advancedSettings.voiceEnabled,
        remote: isRemotePage,
        lastText: state.lastSpokenPrompt,
        lastAt: state.lastSpokenAt || 0,
        now
    });
    if (!plan.paint) return;
    state.lastSpokenPrompt = text;
    state.lastSpokenAt = now;
    if (template) {
        if (!state.lastCueTemplateById) state.lastCueTemplateById = {};
        state.lastCueTemplateById[key] = template;
    }
    setMindgamePrompt(text, true);
    if (plan.speak === 'now') speakNow(text, advancedSettings.voiceURI);
    else if (plan.speak === 'queue') speakPrompt(true, text, advancedSettings.voiceURI);
}

function updateWarmupBadge() {
    const badge = document.getElementById('warmupBadge');
    const remainingEl = document.getElementById('warmupRemainingText');
    const warmupSeconds = Math.max(0, advancedSettings.warmupMinutes || 0) * 60;
    const active = state.sessionStatus === 'RUNNING' && warmupSeconds > 0 && state.sessionSeconds < warmupSeconds;
    if (badge) badge.classList.toggle('hidden', !active);
    if (active && remainingEl) {
        const left = warmupSeconds - state.sessionSeconds;
        remainingEl.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    }
}

// `ceiling` is the one updateEngine has just handed the engine: Survival's
// +N BPM is the overdrive it applied. The calibration toggle passes none, and
// the game's own figure stands until the next tick.
function updateGameNotice(ceiling = null) {
    const notice = document.getElementById('gameNotice');
    if (!notice) return;
    const text = describeGameNotice({
        activeMode: state.activeMode,
        sessionStatus: state.sessionStatus,
        oracleState: state.oracleState,
        oracleTimer: state.oracleTimer,
        trainState: state.trainState,
        trainHoldSeconds: state.trainHoldSeconds,
        trainEdgesDone: state.trainEdgesDone,
        trainHoldGoal: advancedSettings.trainHoldSeconds,
        trainEdgesGoal: advancedSettings.trainEdges,
        survivalSpeedFloor: state.survivalSpeedFloor,
        survivalOverdrive: ceiling ? ceiling.survivalOverdrive : state.survivalOverdrive,
        survivalCalibrating: Boolean(advancedSettings.survivalCalibrating),
        sessionSeconds: state.sessionSeconds,
        minSeconds: state.durationMinSeconds,
        maxSeconds: state.durationMaxSeconds,
        targetSeconds: state.chosenTargetSeconds,
        fixedLength: state.durationFixed
    });
    notice.textContent = text || 'GAME MODE ACTIVE';
    notice.classList.toggle('hidden', !text);
    renderCameEarlyButton();
}

// Came Early is an accidental release in every other mode. Survival is the
// climb that is supposed to finish you, so that same button changes its
// words while the game is selected and, during the run, saves the heart rate.
// The Came Early tooltip is the one index.html ships with. It used to promise
// that every press "tightens limits next time"; the Resting HR floor and the
// offset cap can each leave the ceiling where it was.
function renderCameEarlyButton() {
    const kicker = document.getElementById('cameEarlyKicker');
    const label = document.getElementById('cameEarlyLabel');
    if (!cameEarlyBtn || !kicker || !label) return;
    const survival = !isRemotePage && state.activeMode === 'survival';
    const calibrating = survival && Boolean(advancedSettings.survivalCalibrating);
    kicker.textContent = survival ? 'The app' : 'Accidental';
    label.textContent = survival ? 'Finished me' : 'Came Early';
    cameEarlyBtn.title = calibrating
        ? 'Stops the toys and pauses the run at once, then offers the highest heart rate this Survival run held on two readings in a row as your Climax HR. OK saves it and ends the run. It still works for a minute after STOP.'
        : survival
            ? 'Stops the toys and pauses the run, then asks to end it. Check Calibration on the Survival card if the run should set your Climax HR.'
            : 'Stops the toys and pauses the session, then asks to log an accidental climax. Logged, it adds to the learned offset, which lowers your working climax ceiling on later sessions unless the Resting HR floor or the offset cap holds it. The confirmation states the ceiling before and after.';
    kicker.classList.toggle('text-rose-300', survival);
    kicker.classList.toggle('text-amber-400', !survival);
    cameEarlyBtn.classList.toggle('bg-rose-950/60', survival);
    cameEarlyBtn.classList.toggle('hover:bg-rose-900', survival);
    cameEarlyBtn.classList.toggle('border-rose-800', survival);
    cameEarlyBtn.classList.toggle('text-rose-300', survival);
    cameEarlyBtn.classList.toggle('bg-amber-950/60', !survival);
    cameEarlyBtn.classList.toggle('hover:bg-amber-900', !survival);
    cameEarlyBtn.classList.toggle('border-amber-800', !survival);
    cameEarlyBtn.classList.toggle('text-amber-300', !survival);
}

// Validate the Session Setup duration fields and flag any bad one in red.
// Returns the parsed result; an invalid field means targetSeconds 0 (endless).
function validateDurationInputs() {
    const fixedInput = document.getElementById('paramFixedInput');
    const minInput = document.getElementById('paramMinInput');
    const maxInput = document.getElementById('paramMaxInput');
    const parsed = parseSessionDuration({
        mode: state.durationMode,
        fixedMinutes: fixedInput?.value,
        minMinutes: minInput?.value,
        maxMinutes: maxInput?.value
    });
    markInputValidity(fixedInput, !parsed.invalid.includes('fixed'));
    markInputValidity(minInput, !parsed.invalid.includes('min'));
    markInputValidity(maxInput, !parsed.invalid.includes('max'));
    return parsed;
}

function pickSessionTargetSeconds() {
    const parsed = validateDurationInputs();
    state.durationFallback = !parsed.valid;
    state.durationMinSeconds = parsed.minSeconds || 0;
    state.durationMaxSeconds = parsed.maxSeconds || 0;
    // Snapshotted at START: a Fixed length and a Mystery window typed with
    // the same number in both boxes hand out identical seconds, and only a
    // Fixed one opens the Oracle's window halfway. state.durationMode is
    // live and would change under a running session if the wearer tapped
    // another duration card.
    state.durationFixed = Boolean(parsed.fixedLength);
    return parsed.targetSeconds;
}

// Zero every per-session counter and its display. Called when a session
// stops, on Reset, and again on START so a new run can never inherit time,
// edges or motion samples from the previous one.
function resetSessionCounters() {
    state.sessionSeconds = 0;
    state.chosenTargetSeconds = 0;
    state.durationMinSeconds = 0;
    state.durationMaxSeconds = 0;
    state.durationFixed = false;
    state.edges = 0;
    state.pauses = 0;
    state.peakHr = Number.isFinite(state.hrCurrent) ? state.hrCurrent : 70;
    state.isEdged = false;
    state.edgePending = false;
    // Ruin & Leak's clock belongs to the edge, so it is cleared with the edge
    // flag: here, on STOP, Reset and START, and never by a mode card, a game
    // toggle or a partner's MODE_CHANGE. A release of the edge re-arms the
    // ride on its own (tickRuin).
    applyRuinClock({ rideSeconds: 0, lockSeconds: 0, spent: false });
    state.orgasmBoost = 0;
    state.orgasmSeconds = 0;
    clearMicBoost(state);
    state.rampdownSecondsLeft = 45;
    state.landingAfterForceOrgasm = false;
    state.landingFrom = null;
    state.resumeStatus = null;
    state.durationFallback = false;
    state.endgameFired = false;
    state.endgameHeldByOrgasm = false;
    state.strokerSpeed = 0;
    state.prostateSpeed = 0;
    funscriptSamples = [];
    funscriptSessionStart = 0;
    const edgeEl = document.getElementById('edgeCount');
    const pauseEl = document.getElementById('pauseCount');
    const sVal = document.getElementById('strokerVal');
    const sBar = document.getElementById('strokerBar');
    const pVal = document.getElementById('prostateVal');
    const pBar = document.getElementById('prostateBar');
    if (edgeEl) edgeEl.textContent = "0";
    if (pauseEl) pauseEl.textContent = "0";
    if (sVal) sVal.textContent = "0%";
    if (sBar) sBar.style.width = "0%";
    if (pVal) pVal.textContent = "0%";
    if (pBar) pBar.style.width = "0%";
    document.getElementById('cutoffNotice')?.classList.add('hidden');
    updateTimerDisplay();
}

function resetGameState() {
    state.oracleState = 'IDLE';
    state.oracleTimer = 0;
    state.survivalSpeedFloor = 18;
    state.survivalTimer = 0;
    state.survivalEdges = 0;
    state.survivalOverdrive = 0;
    // Edges from before Survival was switched on do not step it: the ones
    // already counted, and the edge in progress if its count is still owed,
    // which updateEngine sees when that count is made.
    const survivalSeen = survivalEdgesAtSwitch({ edges: state.edges, isEdged: state.isEdged, edgePending: state.edgePending });
    state.survivalEdgesSeen = survivalSeen.edgesSeen;
    state.survivalOwedEdgeSeen = survivalSeen.owedEdgeSeen;
    state.survivalBreachTicks = 0;
    state.survivalLastReadingAt = null;
    state.trainState = 'climb';
    state.trainHoldSeconds = 0;
    state.trainEdgesDone = 0;
    state.edgeStallSeconds = 0;
    state.stallPauseElapsed = 0;
    state.stallGuardEngaged = false;
    // Ruin & Leak's clock is deliberately NOT reset here. This runs on every
    // game toggle - including one a partner sends - and zeroing the clock
    // there cancelled a running 18 s dead stop and started a fresh ride.
    // resetSessionCounters clears it with the edge flag it belongs to.
    state.lastSpokenPrompt = '';
    document.getElementById('stallGuardNotice')?.classList.add('hidden');
    document.getElementById('gameNotice')?.classList.add('hidden');
}

// Ruin & Leak's clock lives in three state fields; these move it in and out
// of the shape session-rules.js works on.
function readRuinClock() {
    return { rideSeconds: state.ruinRideSeconds, lockSeconds: state.ruinHoldSeconds, spent: state.ruinSpent };
}

function applyRuinClock(clock) {
    state.ruinRideSeconds = clock.rideSeconds;
    state.ruinHoldSeconds = clock.lockSeconds;
    state.ruinSpent = clock.spent;
}

function tickSessionGuardsAndGames() {
    if (state.sessionStatus !== 'RUNNING') return;

    // Guards and games judge against the SAME ceiling the engine used on its
    // last tick (after dual-stim / decay / learned offsets), never the raw
    // typed Climax HR, and against the pulse the SENSOR reported: the
    // microphone boost moves the engine's speed, never a guard or a game.
    const ceiling = Number.isFinite(state.effectiveMaxHr) ? state.effectiveMaxHr : readHrLimits().maxHr;
    const hr = Number.isFinite(state.sensorHr) ? state.sensorHr : state.hrCurrent;
    const nearCeiling = hr >= (ceiling - 2);

    // Ruin keeps stroking through the edge, once: RUIN_RIDE_SECONDS on the
    // mark, then a dead stop of RUIN_LOCK_SECONDS that holds until the edge
    // releases. A game does not use this ending; it only borrows Ruin's
    // stroke when that is the selected mode, so the ride clock only runs with
    // Ruin itself active.
    //
    // The stall guard only arms where it has something to cut: Crawl on the
    // mark, or a Ruin & Leak ride whichever ceiling rule is set. Whenever its
    // preconditions are not met (guard off, Full Stop, orgasm, a game mode,
    // Ruin's lockout) an engaged guard is released at once, even with the
    // pulse still parked at the ceiling - except a pause that began during a
    // Ruin ride, which runs its course. Both clocks tick in one call because
    // the order is part of the rule (see tickRuinAndStallGuard).
    const ruinBefore = readRuinClock();
    const step = tickRuinAndStallGuard(
        {
            ruin: ruinBefore,
            guard: { holdSeconds: state.edgeStallSeconds, pauseSeconds: state.stallPauseElapsed, engaged: state.stallGuardEngaged }
        },
        {
            activeMode: state.activeMode,
            isEdged: state.isEdged,
            orgasmMode: state.orgasmMode,
            stallGuard: Boolean(advancedSettings.stallGuard),
            ceilingBehaviour: advancedSettings.ceilingBehaviour,
            holdTimeoutSeconds: advancedSettings.stallGuardSeconds,
            pauseTimeoutSeconds: advancedSettings.stallPauseSeconds
        }
    );
    applyRuinClock(step.ruin);
    state.edgeStallSeconds = step.guard.holdSeconds;
    state.stallPauseElapsed = step.guard.pauseSeconds;
    state.stallGuardEngaged = step.guard.engaged;
    // A guard that engages this second makes the tick's decision urgent, so
    // every toy takes it in this tick: a Handy that follows the secondary
    // channel was sent the Ruin lockout's 18% only with the next packet,
    // the throttle having dropped it (tick-dispatch.js). The lockout can
    // begin with the primary already at 0 - a stall pause from the ride
    // still running - so a cut alone would not say so.
    if (guardEngagedBy(step, ruinBefore)) tickDispatch.markUrgent();
    step.cues.forEach((cue) => cueVoice(cue));

    const warmupSeconds = Math.max(0, advancedSettings.warmupMinutes || 0) * 60;
    if (warmupSeconds > 0 && state.sessionSeconds === warmupSeconds) {
        cueVoice('warmupDone');
    }

    // A cue like any other: with the voice off it still reaches the prompt
    // line. Its own timer (0 = off) is what switches it off.
    const encourageEvery = clampEncourageSeconds(advancedSettings.voiceEncourageSeconds);
    if (
        encourageEvery > 0
        && state.sessionStatus === 'RUNNING'
        && !state.orgasmMode
        && state.sessionSeconds > 0
        && state.sessionSeconds % encourageEvery === 0
    ) {
        cueVoice('encourage');
    }

    // The gate and the cap come from the APPLIED settings. Dragging a
    // Session Setup slider previews on the meter; only Apply commits it,
    // so dismissing the modal can never change the running session.
    if (advancedSettings.micEnabled && state.micAnalyser) {
        const level = sampleMicLevel(state);
        state.micBoost = micBoostFromLevel(
            level,
            clampMicGate(advancedSettings.micSensitivityThreshold),
            clampMicBoostBpm(advancedSettings.micBoostMaxBpm)
        );
        paintMicMeter(level);
    } else if (!state.isTestingMic) {
        clearMicBoost(state);
        document.getElementById('micActiveBadge')?.classList.add('hidden');
    }

    // A game's edge is an edge the engine has COUNTED. The flag goes up on the
    // first reading at the mark, and every state of both games backs the
    // motors off on it, but one reading - a glitch, the top of a posture
    // spike - must not start an Oracle hold, whose roll 15 s later can arm
    // Force Orgasm or end the session, nor an Edge Training hold that counts
    // toward the set. The hold starts once the pulse has held at the mark.
    const edgeCounted = state.isEdged && !state.edgePending;

    if (state.activeMode === 'oracle') {
        if (state.oracleState === 'IDLE' || state.oracleState === 'APPROACH') {
            if (state.oracleState !== 'APPROACH') {
                state.oracleState = 'APPROACH';
                cueVoice('oracleWatching');
            }
            if (edgeCounted) {
                state.oracleState = 'HOLD';
                state.oracleTimer = 15;
                cueVoice('oracleHold');
            }
        } else if (state.oracleState === 'HOLD') {
            state.oracleTimer = Math.max(0, state.oracleTimer - 1);
            if (state.oracleTimer <= 0) {
                const timing = oracleTiming({
                    sessionSeconds: state.sessionSeconds,
                    minSeconds: state.durationMinSeconds,
                    maxSeconds: state.durationMaxSeconds,
                    targetSeconds: state.chosenTargetSeconds,
                    fixedLength: state.durationFixed
                });
                const fate = rollOracleFate(timing, { endgameType: state.endgameType });
                if (fate === 'CLIMAX') {
                    state.oracleState = 'CLIMAX';
                    // Arm Force Orgasm without its own bank so Oracle climax
                    // is the one phrase the wearer hears.
                    if (!state.orgasmMode) setOrgasmMode(true);
                    cueVoice('oracleClimax');
                } else if (fate === 'DENIAL') {
                    state.oracleState = 'DENIAL';
                    stopSession('Oracle Denial', 'The Oracle chooses denial.');
                    return;
                } else if (fate === 'RAMPDOWN') {
                    // Soft Landing is the ending the wearer picked, so the
                    // Oracle hands the session to that tease-down instead of
                    // arming Force Orgasm on a coin flip.
                    state.oracleState = 'RAMPDOWN';
                    state.endgameFired = true;
                    cueVoice('oracleSoftLanding');
                    handleTargetTimeReached();
                    return;
                } else {
                    state.oracleState = 'PURGATORY';
                    state.oracleTimer = 0;
                    cueVoice(timing.canEnd ? 'oraclePurgatory' : 'oracleNotYet');
                }
            }
        } else if (state.oracleState === 'CLIMAX') {
            // app.js switched Force Orgasm on with the roll; if the wearer
            // taps it off again the climax is withdrawn and the ceiling
            // rules apply as in APPROACH (the engine cuts CLIMAX at the
            // ceiling too, this keeps the game state honest).
            if (!state.orgasmMode) {
                state.oracleState = 'APPROACH';
                cueVoice('oracleWithdrawn');
            }
        } else if (state.oracleState === 'PURGATORY') {
            // Purgatory lasts 28 s, but the edge flag is only cleared once the
            // pulse has genuinely dropped below the release band; resetting it
            // while HR still sits at the ceiling would count a phantom edge.
            state.oracleTimer += 1;
            if (state.oracleTimer >= 28 && gameEdgeReleased(hr, ceiling, state.edgeTriggerHr, { orgasmMode: state.orgasmMode })) {
                state.oracleState = 'APPROACH';
                state.oracleTimer = 0;
                state.isEdged = false;
                state.edgePending = false;
                cueVoice('oracleReset');
            }
        }
    } else if (state.activeMode === 'survival') {
        // Edges from before this game was switched on are ignored, the one in
        // progress at the switch too when it is counted after it
        // (survivalEdgesAtSwitch). Each new one raises the mark 1 BPM and the
        // speed a step. The clock is slow on purpose: half an hour of it is
        // still a build, not a finish.
        const seen = state.survivalEdgesSeen || 0;
        const gained = Math.max(0, (state.edges || 0) - seen);
        state.survivalEdges = (state.survivalEdges || 0) + gained;
        state.survivalEdgesSeen = state.edges || 0;
        state.survivalTimer += 1;
        const drive = survivalDrive({ seconds: state.survivalTimer, edges: state.survivalEdges });
        state.survivalSpeedFloor = drive.floor;
        state.survivalOverdrive = drive.overdriveBpm;
    } else if (state.activeMode === 'edgetrain') {
        const next = tickEdgeTraining(
            { state: state.trainState, holdSeconds: state.trainHoldSeconds, edgesDone: state.trainEdgesDone },
            {
                isEdged: edgeCounted,
                released: gameEdgeReleased(hr, ceiling, state.edgeTriggerHr, { orgasmMode: state.orgasmMode }),
                holdGoal: advancedSettings.trainHoldSeconds,
                edgesGoal: advancedSettings.trainEdges,
                orgasmMode: state.orgasmMode
            }
        );
        state.trainState = next.state;
        state.trainHoldSeconds = next.holdSeconds;
        state.trainEdgesDone = next.edgesDone;
        if (next.justHold) cueVoice('trainHold');
        if (next.justCounted && !next.justFinished) cueVoice('trainHeld');
        if (next.justDropped) cueVoice('trainDrop');
        if (next.justFinished) {
            if (!state.orgasmMode) setOrgasmMode(true);
            cueVoice('trainFinish');
        }
    }
}

// 250ms Live Funscript Sampling Loop (4Hz). Records what was really sent to
// the toys (speed plus the physical stroke zone); the buffer is capped at
// four hours, oldest dropped first.
setInterval(() => {
    if (isRemotePage) return;
    const active = state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN';
    // A pause is part of the timeline too: the motors are stopped, so record
    // explicit zero-speed samples rather than leaving a hole the export
    // would have to guess about.
    const paused = state.sessionStatus === 'PAUSED' && funscriptSessionStart > 0;
    if (active || paused) {
        const now = Date.now();
        if (funscriptSessionStart === 0) funscriptSessionStart = now;
        const range = effectiveStrokeRange(state.strokeMin, state.strokeMax);
        pushSample(funscriptSamples, {
            at: now - funscriptSessionStart,
            speed: paused ? 0 : state.strokerSpeed,
            secondary: paused ? 0 : state.prostateSpeed,
            strokeMin: range.min,
            strokeMax: range.max
        });
    }
}, 250);

// Record one heart-rate notification from the sensor or the simulator.
// Every packet refreshes the watchdog's packet clock; only a usable BPM
// (35-250) updates the displayed pulse, the history and the engine, so a
// 0 BPM "no contact" packet holds the last value instead of dropping to 0.
function recordHrReading(bpm, sensorContact = null, now = Date.now()) {
    // Packets are events, not timers, so they keep arriving in a background
    // tab whose master clock the browser holds back to once a minute. Each
    // one checks that the clock is still keeping up: the gap is caught a few
    // seconds in, not a minute later when the late tick finally runs.
    haltIfUnsupervised(now);
    const valid = hrWatchdog.recordPacket(now, bpm, sensorContact);
    state.hrNoContact = !valid || sensorContact === false;
    document.getElementById('hrContactHint')?.classList.toggle('hidden', !state.hrNoContact);
    if (!valid) return false;
    state.hrCurrent = bpm;
    state.lastHrTimestamp = now;
    state.history.push(bpm);
    if (state.history.length > 60) state.history.shift();
    // Remembered before the engine runs on it, so the reading the engine
    // judges is always the last one in the list.
    edgeReadings = rememberEdgeReading(edgeReadings, now, bpm);
    rememberReading(recentReadings, now, bpm);
    // Judged as it arrives: a reading that brings a paused session back was
    // still taken while it was paused, and one the simulator's slider made is
    // never the wearer's heart rate.
    calibrationWindow = noteCalibrationReading(calibrationWindow, {
        at: now,
        bpm,
        running: state.sessionStatus === 'RUNNING',
        simulator: state.simEngaged,
        staleSeconds: advancedSettings.hrStaleSeconds
    });
    // The watchdog's report says no valid reading is arriving, and one just
    // did, so it goes now, whatever the session does next: an auto-resume
    // that cannot run (no toy left to drive, or The Handy not answering that
    // it is online) leaves the session paused under the reports that say
    // why, not under one about a pulse that is back. Until then it stays,
    // even past STOP or a page that went away, because it is still true:
    // nothing is reading a pulse.
    hideAlertBanner('hrSignal');
    if (state.hrSignalPaused) handleHrSignalReturned();
    updateEngine();
    syncTelemetry();
    return true;
}

// Human message for the disconnect banner: which device, for how long, why.
function describeHrLoss(verdict) {
    const name = state.hrDeviceName || 'Heart-rate monitor';
    const secs = Math.max(1, Math.round((verdict.sinceValidMs || 0) / 1000));
    const why = verdict.sourceLost
        ? 'no heart-rate sensor is linked'
        : verdict.noContact
            ? 'the sensor is transmitting but reports no pulse; check skin contact'
            : 'no packets received';
    return `${name}: no valid heart-rate reading for ${secs} s (${why}).`;
}

// Overlay on the chart, the "holding" hint and the "no skin contact" hint.
// `verdict` null hides everything.
function renderHrSignal(verdict) {
    const overlay = document.getElementById('staleAlert');
    const overlayText = document.getElementById('staleAlertText');
    const holdHint = document.getElementById('hrHoldHint');
    const contactHint = document.getElementById('hrContactHint');
    const status = verdict ? verdict.status : 'ok';
    const secs = verdict ? Math.round((verdict.sinceValidMs || 0) / 1000) : 0;
    overlay?.classList.toggle('hidden', status !== 'stale');
    if (overlayText && status === 'stale') {
        overlayText.textContent = `WATCHDOG: NO HEART-RATE READING FOR ${secs} S, MOTORS HALTED`;
    }
    holdHint?.classList.toggle('hidden', status !== 'holding');
    if (holdHint && status === 'holding') holdHint.textContent = `HOLDING LAST READING (${secs} s)`;
    contactHint?.classList.toggle('hidden', !(verdict && verdict.noContact));
}

let hrSignalBadgeTimer = null;
// Small badge next to the BPM. `ms` 0 keeps it until the next transport
// change; otherwise it hides itself.
function showHrSignalBadge(text, ms) {
    const badge = document.getElementById('hrSignalBadge');
    if (!badge) return;
    if (hrSignalBadgeTimer) clearTimeout(hrSignalBadgeTimer);
    hrSignalBadgeTimer = null;
    badge.textContent = text;
    badge.classList.remove('hidden');
    if (ms > 0) hrSignalBadgeTimer = setTimeout(() => badge.classList.add('hidden'), ms);
}

function hideHrSignalBadge() {
    if (hrSignalBadgeTimer) clearTimeout(hrSignalBadgeTimer);
    hrSignalBadgeTimer = null;
    document.getElementById('hrSignalBadge')?.classList.add('hidden');
}

// Forget that the watchdog paused the session (start, resume, stop, reset).
function clearHrSignalPause() {
    state.hrSignalPaused = false;
    state.hrSignalState = 'ok';
    state.hrSignalSilentMs = 0;
    hideHrSignalBadge();
    renderHrSignal(null);
}

// A usable reading arrived while the watchdog had the session paused.
function handleHrSignalReturned() {
    if (!state.hrSignalPaused) return;
    if (state.sessionStatus !== 'PAUSED') {
        state.hrSignalPaused = false;
        return;
    }
    if (advancedSettings.hrAutoResume) {
        resumeAfterSignalReturn();
        return;
    }
    holdAfterSignalReturn();
}

// The signal is back but the session stays paused: drop the overlay and
// keep a badge up until the user presses RESUME. Used when auto-resume is
// off and when the simulator is engaged during a watchdog pause (a
// synthetic source must never restart the motors by itself).
function holdAfterSignalReturn() {
    state.hrSignalPaused = false;
    state.hrSignalState = 'ok';
    state.hrSignalSilentMs = 0;
    renderHrSignal(null);
    showHrSignalBadge('SIGNAL BACK, PRESS RESUME', 0);
    checkReadiness();
}

// The same RESUME as the button, Handy check included: a pulse coming back
// says nothing about whether the toy is still there. The signal-loss report
// is already down (recordHrReading), and only that one: a standing report
// about a device that may still be moving is not the pulse's to clear.
function resumeAfterSignalReturn() {
    state.hrSignalPaused = false;
    startOrResumeWhenReady().then((resumed) => {
        if (resumed) {
            cueVoice('signalRestored');
            showHrSignalBadge('SIGNAL RESTORED, RESUMED', 6000);
            syncTelemetry();
            updateEngine();
            return;
        }
        // The pulse is back but the session stays paused: The Handy did not
        // answer that it is online (the refusal says so on the banner) or a
        // toy has gone meanwhile. Hold exactly as with auto-resume off, so
        // the overlay drops and the badge says what to do. Not after STOP or
        // Reset during the check: they have cleared everything already, and
        // the badge would name a RESUME there is not.
        if (state.sessionStatus === 'PAUSED') holdAfterSignalReturn();
    });
}

// One watchdog verdict per clock tick while the session is live. The
// simulator only changes when its slider moves, so it is never stale and the
// overlay never shows for it.
function evaluateHrWatchdog(now = Date.now()) {
    if (state.simEngaged) {
        state.hrSignalState = 'ok';
        state.hrNoContact = false;
        state.hrSignalSilentMs = 0;
        renderHrSignal(null);
        return;
    }
    const verdict = hrWatchdog.evaluate(now);
    // No pulse source at all (link gone and no reconnect in flight): that is
    // a loss, whatever the clocks say, never a "holding" gap.
    if (!isBleConnected() && !isBleReconnecting()) {
        verdict.status = 'stale';
        verdict.sourceLost = true;
    }
    state.hrSignalState = verdict.status;
    state.hrNoContact = verdict.noContact;
    state.hrSignalSilentMs = verdict.sinceValidMs;
    renderHrSignal(verdict);
    // 'holding' needs nothing: hrCurrent still carries the last valid pulse.
    if (verdict.status === 'stale' && !state.hrSignalPaused) {
        state.hrSignalPaused = true;
        dispatchHardware(0, 0, 0, 100, true);
        triggerDisconnectAlert(describeHrLoss(verdict), 'hrSignal', { motorsPaused: true });
        cueVoice('signalLost', true);
    }
}

// The partner page only renders what the host reports: no watchdog, no
// games, no endgame, no ceiling inflation.
function renderRemoteClock() {
    updateTimerDisplay();
    checkRemoteLinkHealth();
    redrawChart();
}

// Draw the guide lines where edges really trigger: the host's WORKING
// limits after every offset (on a remote page these arrive in telemetry).
function redrawChart() {
    const chartEl = document.getElementById('hrChart');
    if (!chartEl) return;
    const triggerHr = Number.isFinite(state.edgeTriggerHr) ? state.edgeTriggerHr : undefined;
    drawTelemetryChart(chartEl, state.history, state.effectiveMinHr, state.effectiveMaxHr, triggerHr);
}

// Supervision of the master clock itself (supervision.js). The clock counted
// ticks, not time: a browser holding a background tab to one wake-up a
// minute, a frozen page or a sleeping laptop left the toys on their last
// command with no watchdog and no guard, and the session carried on from the
// late tick as if nothing had happened. Each tick now measures the wall
// clock since the last one; a live session whose clock went quiet for longer
// than supervisionGapLimitMs() is stopped and paused, never picked up where
// it was. The gap is not added to the session clock: the per-second rules
// only count seconds they actually watched.
const supervisionClock = createSupervisionClock();

// Stop and pause a RUNNING / RAMPDOWN session whose clock has fallen behind.
// Asked by every tick and by every heart-rate packet between ticks. Returns
// true when it halted the session.
function haltIfUnsupervised(now = Date.now()) {
    if (isRemotePage) return false;
    if (state.sessionStatus !== 'RUNNING' && state.sessionStatus !== 'RAMPDOWN') return false;
    const verdict = supervisionClock.check(now, {
        limitMs: supervisionGapLimitMs(advancedSettings.hrStaleSeconds),
        hidden: document.visibilityState === 'hidden'
    });
    if (!verdict.lost) return false;
    // A forced zero dispatch to every driver and the pause, in one step.
    triggerDisconnectAlert(describeSupervisionGap(verdict), 'supervision');
    return true;
}

// 1-Second Master Clock. Whatever the engine computes during a tick reaches
// the toys once, when the tick is over (tickDispatch above), urgent when a
// guard engaged in it or Force Orgasm's time limit ran out in it.
setInterval(() => tickDispatch.run(masterClockTick, (decision, { urgent }) => dispatchHardware(...decision, false, urgent)), 1000);

function masterClockTick() {
    if (isRemotePage) {
        renderRemoteClock();
        return;
    }

    // Before anything else reads the session: a tick that arrives long after
    // the last one pauses the session instead of counting a second.
    const now = Date.now();
    haltIfUnsupervised(now);
    supervisionClock.beat(now, { hidden: document.visibilityState === 'hidden' });

    // The simulator's slider IS the pulse for as long as it is engaged, and a
    // value left on it is a value held: every second it stays there is one
    // more reading. Otherwise an edge set on the slider in one step - a click
    // on the track, one arrow key - would pull back and then wait for the
    // slider to move again before it counted. Came Early's recent readings
    // take it the same way, or a slider left alone for a minute would read to
    // them as no reading at all. (Finished me never counts the simulator.)
    // Not once a sensor is linked: while a new strap connects, the simulator
    // is still flagged engaged but the pulse is the strap's, and repeating
    // its reading here would hold one reading twice.
    if (state.simEngaged && !isBleConnected()) {
        edgeReadings = rememberEdgeReading(edgeReadings, now, state.hrCurrent);
        rememberReading(recentReadings, now, state.hrCurrent);
    }

    if (state.sessionStatus === 'RUNNING') {
        state.sessionSeconds += 1;
        updateTimerDisplay();
        // Force Orgasm's time limit is asked before the engine runs, so on
        // the second it runs out the toys are sent the soft landing rather
        // than one more second of overdrive, urgent, in this tick.
        tickForcedOrgasm();
        // Refresh the engine first so the guards and games below judge THIS
        // second's HR, ceiling and edge flag, not the previous tick's. What
        // it computes is held, not sent: the toys get the decision the tick
        // ends on, once, and never first the speed a stall guard or a Ruin
        // lockout below is about to cut.
        updateEngine();
        tickSessionGuardsAndGames();

        // The endgame fires exactly once per session: the Orgasm endgame
        // arms Force Orgasm, which stays a toggle the wearer can cancel.
        if (!state.endgameFired && state.chosenTargetSeconds > 0 && state.sessionSeconds >= state.chosenTargetSeconds) {
            const oracleResolving = state.activeMode === 'oracle'
                && (state.oracleState === 'HOLD' || state.oracleState === 'CLIMAX' || state.orgasmMode);
            // Only an orgasm actually in progress defers the endgame. The
            // training state alone must never suppress it: a cancelled Force
            // Orgasm would leave a timed session with no way to end.
            const trainResolving = state.activeMode === 'edgetrain' && state.orgasmMode;
            if (state.orgasmMode && (oracleResolving || trainResolving)) state.endgameHeldByOrgasm = true;
            if (!oracleResolving && !trainResolving) {
                state.endgameFired = true;
                // The only way to get here with the endgame still pending
                // after an orgasm held it back is that the wearer tapped
                // Force Orgasm OFF. Running the orgasm endgame now would
                // synthesise a click on that same button within a second of
                // them saying no, surging both channels back to 100%. The
                // orgasm endgame is spent; Soft Landing and Denied still run,
                // because cancelling an orgasm is not a request to skip the
                // gentle ending the wearer picked.
                const cancelled = state.endgameHeldByOrgasm && !state.orgasmMode && state.endgameType === 'orgasm';
                if (!cancelled) handleTargetTimeReached();
            }
        }
        if (state.orgasmMode) {
            // Raise the WORKING ceiling 1 BPM/s (capped) so the edge detector
            // stops firing; the typed Climax HR input is never touched.
            state.orgasmBoost = Math.min(ORGASM_BOOST_CAP, (state.orgasmBoost || 0) + 1);
        }
    } else if (state.sessionStatus === 'RAMPDOWN') {
        state.rampdownSecondsLeft -= 1;
        const timerEl = document.getElementById('sessionTimer');
        if (timerEl) timerEl.textContent = `00:${String(state.rampdownSecondsLeft).padStart(2, '0')}`;
        // A landing Force Orgasm's time limit started follows a forced
        // climax, not an edge the wearer rode out, and the history says so.
        if (state.rampdownSecondsLeft <= 0) stopSession(state.landingAfterForceOrgasm ? 'Force Orgasm (Soft Landing)' : "Soft Landing (Edged Out)");
    }

    // The watchdog guards every state in which motors may move, and keeps
    // the overlay's counter honest while it holds the session paused.
    if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') {
        evaluateHrWatchdog();
    } else if (state.sessionStatus === 'PAUSED' && state.hrSignalPaused) {
        evaluateHrWatchdog();
    } else if (state.hrSignalState !== 'ok') {
        clearHrSignalPause();
    }

    // The START / RESUME gate depends on the age of the last valid reading,
    // so the label is refreshed every second while the session is not live.
    if (state.sessionStatus === 'IDLE' || state.sessionStatus === 'PAUSED') checkReadiness();

    pruneStalePeers(Date.now());
    syncTelemetry();
    // The decision this second ends on: the one the toys are sent.
    updateEngine();
    redrawChart();
    // Every transport change syncs the screen lock itself; this catches any
    // path that did not, so the lock never outlives the session by more than
    // a second or fails to follow it into a new one.
    syncScreenWakeLock();
}

function handleTargetTimeReached() {
    // A latched Force Orgasm does not survive an ending that is not an
    // orgasm. While it is on, the motors ramp toward a high varied output
    // and the ceiling climbs, so a Soft Landing reached with the latch still
    // set - the wearer tapped it during an Oracle hold, and the roll or the
    // timer then chose the tease-down - would keep driving the toys instead
    // of the gentle ending. Denied stops the session, which clears it
    // anyway; the Orgasm endgame IS the latch and keeps it.
    // Read before the latch is cleared: a landing that takes over from a run
    // starts no higher than the run was sending (beginSoftLanding).
    const forcedRun = state.orgasmMode;
    if (!endgameKeepsOrgasmLatch(state.endgameType)) setOrgasmMode(false);
    if (state.endgameType === 'orgasm') {
        if (!state.orgasmMode && orgasmBtn) orgasmBtn.click();
    } else if (state.endgameType === 'rampdown') {
        beginSoftLanding({ afterForcedRun: forcedRun });
    } else {
        stopSession("Denied");
    }
}

// The soft landing: both channels from half speed down to a stop over 45 s,
// and then the session ends. The Soft Landing ending and Force Orgasm's
// time limit both finish a session through it. `afterForcedRun`: the landing
// takes over from a Force Orgasm run - its time limit ran out, or the Soft
// Landing ending (the timer's or an Oracle roll's) arrived with it latched -
// and then starts from what the toys were last sent wherever that is slower
// than half speed (engine.js landingCap). A RESUME starts the run's ramp
// again from a standstill, so the toys may be far below half speed when it
// ends, and a landing must never speed them up.
function beginSoftLanding({ afterForcedRun = false } = {}) {
    state.sessionStatus = 'RAMPDOWN';
    state.rampdownSecondsLeft = 45;
    state.landingFrom = afterForcedRun
        ? { primary: lastDispatched.primary, secondary: lastDispatched.secondary }
        : null;
    // RAMPDOWN computes both channels from the ramp factor alone and
    // never looks at the heart rate, so no boost reaches the toys. The
    // session tick that refreshes (and clears) the boost is RUNNING-only,
    // so without this the badge would show a MIC +N frozen at whatever
    // the room was when the landing began, for the whole 45 s.
    clearMicBoost(state);
    document.getElementById('rampdownNotice')?.classList.remove('hidden');
    renderForceOrgasmButton();
}

function updateTimerDisplay() {
    const timerEl = document.getElementById('sessionTimer');
    const subLabelEl = document.getElementById('timerSubLabel');
    if (!timerEl || !subLabelEl) return;

    const aMins = String(Math.floor(state.sessionSeconds / 60)).padStart(2, '0');
    const aSecs = String(state.sessionSeconds % 60).padStart(2, '0');
    const activeStr = `${aMins}:${aSecs}`;

    if (state.durationMode === 'fixed' && state.chosenTargetSeconds > 0) {
        const rem = Math.max(0, state.chosenTargetSeconds - state.sessionSeconds);
        const rMins = String(Math.floor(rem / 60)).padStart(2, '0');
        const rSecs = String(rem % 60).padStart(2, '0');
        timerEl.textContent = `${rMins}:${rSecs}`;
        subLabelEl.textContent = `Elapsed ${activeStr}`;
    } else if (state.durationFallback && state.chosenTargetSeconds === 0) {
        timerEl.textContent = activeStr;
        subLabelEl.textContent = "Endless (Invalid Duration)";
    } else if (state.durationMode === 'range') {
        timerEl.textContent = activeStr;
        subLabelEl.textContent = "Mystery Target";
    } else {
        timerEl.textContent = activeStr;
        subLabelEl.textContent = "Endless Mode";
    }
}

// Start from IDLE or resume from PAUSED. Returns false when the session was
// in neither state, or when the hardware is not ready: a pulse source with a
// fresh valid reading and a toy are required, so a resume can never run the
// motors on a frozen heart rate. The watchdog clocks are left untouched.
function startOrResumeSession() {
    if (state.sessionStatus !== 'IDLE' && state.sessionStatus !== 'PAUSED') return false;
    if (transportWaitingReason()) {
        checkReadiness();
        return false;
    }
    // Nothing below declines: the session runs from here on, from the button
    // as from the partner's controller or the auto-resume, and a session that
    // runs is paused for nothing. So the line a refused START or RESUME left
    // has nothing more to say. The signal-loss report is down already, since
    // a session only starts on a fresh reading and every reading takes it
    // down, and "Every toy was stopped and the session paused; press RESUME
    // when you are ready" has had its RESUME: the session runs again under
    // the page's own supervision. Each takes back only its own words: a
    // standing report about a device that may still be moving is none of
    // theirs to clear.
    withdrawStartRefusal();
    hideAlertBanner('hrSignal');
    hideAlertBanner('supervision');
    hideAlertBanner('vacuglidePaused');
    // And no report may go on saying "Motors paused for safety." over motors
    // that run. The rest of a report can still be true: an Intiface or
    // T-Code device that was lost, or a Handy lost while reconnecting, is
    // still gone while the session runs on the toys that are left, so its
    // report stays where it stands, without the clause. Left in, it told the
    // wearer the motors were paused while the Handy stroked, and after a
    // signal loss the auto-resume brought it back into view still saying so.
    retractMotorsPaused();
    // "The Handy did not confirm a stop" stands until the device it is about
    // is accounted for, and a session that drives that Handy from here
    // accounts for it; a Handy on Off, or any other key, still owes its stop.
    settleDrivenHandyStop();
    // All of this comes before the cue below, which can put a voice notice on
    // the banner (a saved voice this browser does not have, a voice that
    // cannot speak here) that is told once only. That notice is the voice's
    // own and none of these take it back; when it was folded into the
    // refusal's line or appended under the watchdog's report, taking those
    // back after the cue took it along before it was ever shown.
    let resumingRampdown = false;
    if (state.sessionStatus === 'IDLE') {
        // A fresh run never inherits time, edges or samples from the last one.
        resetSessionCounters();
        setOrgasmMode(false);
        funscriptSessionStart = Date.now();
        resetGameState();
        // A new session is a new run: the last one's record is gone even
        // inside its minute, and Survival selected now is Survival switched
        // on for this session.
        calibrationWindow = state.activeMode === 'survival' ? openCalibrationWindow(Date.now()) : null;
        state.chosenTargetSeconds = pickSessionTargetSeconds();
        updateTimerDisplay();
        // A voice that fails is told about once per session, so a fresh
        // session may tell it once more.
        speechNotices.newSession();
        cueVoice('sessionStart');
    } else {
        // Resume into the rampdown where it left off, not back to RUNNING.
        resumingRampdown = state.resumeStatus === 'RAMPDOWN' && state.rampdownSecondsLeft > 0;
        // A tab that died while this session was paused may have left a
        // Handy moving, and the wearer carries on here next to it: the pass
        // a session start runs (crash-recovery.js).
        crashRecovery?.sessionResumed();
    }
    // The wearer carries on: a Came Early or Finished me press the Handy
    // turned away is not what the next press is about any more.
    heldPress = null;
    state.sessionStatus = resumingRampdown ? 'RAMPDOWN' : 'RUNNING';
    state.resumeStatus = null;
    // A Force Orgasm run that a pause interrupted ramps up again from the
    // stop the pause sent, never from where it was: resumed at its old
    // level, a heart-rate watchdog pause, a supervision gap or a frozen tab
    // put the toys straight back on the 78-100% wave on the first tick, from
    // a standstill. Only the ramp starts again; the run's time limit still
    // counts from the arming. (START switched Force Orgasm off above.)
    if (state.orgasmMode && state.sessionStatus === 'RUNNING') startOrgasmRamp();
    // Supervision starts now. The clock may not have ticked for a while (a
    // pulse returning to a watchdog pause in a background tab), and that
    // quiet stretch belongs to the pause, not to this session.
    supervisionClock.beat(Date.now(), { hidden: document.visibilityState === 'hidden' });
    clearHrSignalPause();
    document.getElementById('rampdownNotice')?.classList.toggle('hidden', !resumingRampdown);
    renderTransport(state.sessionStatus);
    syncScreenWakeLock();
    renderForceOrgasmButton();
    return true;
}

// The line a refused START or RESUME put on the banner is about that one
// press, so it is taken back as soon as it has nothing left to say: when a
// later START or RESUME runs, or is refused and says why in its place; when
// The Handy is connected again, since what the line said about the link no
// longer holds; and when STOP or Reset starts over, leaving nothing to press
// again. Being an advisory, it is read under whatever safety report stands -
// always under the offline report when the check itself found the device
// offline, and under "The Handy disconnected." as often - and, like every
// notice, it is its own source's to take back (alert-banner.js): that report
// neither takes it along when it goes nor goes with it.
function withdrawStartRefusal() {
    hideAlertBanner('handyCheck');
}

// START and RESUME, from the button, the partner's controller and the
// watchdog's auto-resume alike. A connected Handy is asked whether it is
// online (GET /connected) first, and the session only starts on a yes: the
// poll can be up to 30 s behind a device that was switched off, and START
// on a dead Handy used to run the session for several seconds before the
// failed commands paused it again. Anything else that is not ready is
// refused before the question is asked, and the answer is checked against
// the whole readiness gate again, since the pulse or a toy can go in the
// meantime. Resolves whether the session started.
//
// Nothing is started while Came Early or Finished me is stopping the toys
// and asking, nor by a tap made before its question was over that the page
// gets only afterwards (`tappedAt`, the click's timeStamp: the press's own
// rule, createQuestionGate). The press keeps the toys stopped until the
// wearer has answered, and a START or RESUME tapped while it waited for the
// stop was still waiting for The Handy's answer when the question opened:
// the answer started the toys once the question was answered - after
// Cancel, whose dialog says the session stays paused, and after OK in the
// minute after STOP. A partner's is dropped while a press runs before it
// reaches the button (onCommandReceived).
function startOrResumeWhenReady(tappedAt) {
    if (pressQuestion.claims(tappedAt)) return Promise.resolve(false);
    if (state.sessionStatus !== 'IDLE' && state.sessionStatus !== 'PAUSED') return Promise.resolve(false);
    if (transportWaitingReason()) {
        checkReadiness();
        return Promise.resolve(false);
    }
    const resuming = state.sessionStatus === 'PAUSED';
    const started = startGate.run({
        ask: handyConnected
            ? () => pollHandyConnected().then((answer) => ({ ok: answer.state === 'online', answer }))
            : null,
        start: startOrResumeSession,
        // An advisory: a start that did not happen moves nothing, and a
        // standing safety report (a motor that may still be moving) must
        // keep its place above it. It takes the place of the line an
        // earlier refusal left instead of stacking under it: only the
        // latest press is news.
        refuse: (verdict) => {
            withdrawStartRefusal();
            showAlertBanner(describeStartRefusal(verdict && verdict.answer, resuming), {
                severity: 'advisory',
                source: 'handyCheck'
            });
        }
    });
    // Paints CHECKING THE HANDY while the question is out.
    checkReadiness();
    // The lines a running session outdates are taken back inside the start
    // itself, before its cue (see startOrResumeSession).
    return started.catch(() => false).then((ok) => {
        checkReadiness();
        syncTelemetry();
        updateEngine();
        return ok;
    });
}

// Session Controls Handlers
playPauseBtn?.addEventListener('click', (event) => {
    if (isRemoteViewer) return;
    // When the tap was made, which is not always when the page gets it.
    const tappedAt = Number.isFinite(event?.timeStamp) && event.timeStamp > 0 ? event.timeStamp : performance.now();
    // A press that lands on RESUME moments after it appeared was aimed at
    // what the button showed before: at PAUSE, for the second click of a
    // double-click or a click already on its way when Space or the partner
    // paused. Taken, it would start the motors the wearer had just stopped.
    // It is judged by when it was made, so the page getting it late does not
    // let it through.
    if (state.sessionStatus === 'PAUSED' && resumeHold.held(tappedAt)) return;
    if (isRemoteController) {
        // Ask the host; the button re-renders from the telemetry it sends back.
        // The command says which host state the button is showing, so a
        // RESUME the host gets late never starts a session the wearer has
        // ended meanwhile (peer-messages.transportCommand, hostTransportAction).
        sendPeerCommand(transportCommand(state.sessionStatus));
        return;
    }
    if (state.sessionStatus === 'IDLE' || state.sessionStatus === 'PAUSED') {
        startOrResumeWhenReady(tappedAt);
    } else if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') {
        pauseSession('Paused.');
    }
    checkReadiness();
    syncTelemetry();
    updateEngine();
});

stopBtn?.addEventListener('click', () => {
    if (isRemoteViewer) return;
    if (isRemoteController) {
        sendPeerCommand({ type: 'SESSION_STATE', status: 'IDLE' });
        return;
    }
    stopSession("Stopped");
});

// Put the transport back into its idle look. Shared by stop and reset.
function showIdleTransport() {
    document.getElementById('rampdownNotice')?.classList.add('hidden');
    renderTransport('IDLE');
}

// `voiceText` overrides the spoken outcome when a game or guard wants to say
// more than the history label (one cue, never two back-to-back), and
// `voiceVars` fills its tokens when they are not this second's values.
function stopSession(outcome = "Stopped", voiceText = null, voiceVars = null) {
    const wasActive = state.sessionStatus !== 'IDLE';
    // Status and motors FIRST: nothing below (history, storage, voice) may
    // leave the session running if it throws. A START still waiting for The
    // Handy's answer is dropped with them: STOP means no session, whatever
    // the answer turns out to be.
    startGate.cancel();
    state.sessionStatus = 'IDLE';
    state.resumeStatus = null;
    state.strokerSpeed = 0;
    state.prostateSpeed = 0;
    dispatchHardware(0, 0, 0, 100, true);
    syncScreenWakeLock();
    // Ended cleanly: nothing for the next page to recover (crash-recovery.js).
    crashRecovery?.clear();
    setOrgasmMode(false);
    clearHrSignalPause();
    // No paused session is left for a supervision report to ask a RESUME of,
    // nor for any report to call the motors paused: a device that was lost,
    // or a pulse that is still not read, is reported on in its own words.
    hideAlertBanner('supervision');
    retractMotorsPaused();
    // The run is over, but Finished me may still read it for a minute: the
    // wearer who stops the toys at the point of no return, or whose run ends
    // in a Soft Landing, comes after this.
    calibrationWindow = closeCalibrationWindow(calibrationWindow, Date.now());
    try {
        if (wasActive && state.sessionSeconds >= 10 && !isRemotePage) saveSessionToHistory(outcome);
    } catch (e) {
        console.warn('Session history could not be saved', e);
    } finally {
        resetSessionCounters();
        resetGameState();
        updateWarmupBadge();
        showIdleTransport();
        withdrawStartRefusal();
        // Nor a VacuGlide that something else stopped: no RESUME is left.
        hideAlertBanner('vacuglidePaused');
        // STOP silences every queued cue; the outcome is the one thing said.
        cancelSpeech();
        cueVoice(voiceText || ((outcome && outcome !== 'Stopped') ? outcome : 'sessionStop'), true, voiceVars);
        syncTelemetry();
        checkReadiness();
        if (!isRemotePage) updateEngine();
    }
}

resetBtn?.addEventListener('click', () => {
    if (isRemoteViewer) return;
    if (isRemoteController) {
        sendPeerCommand({ type: 'SESSION_RESET' });
        return;
    }
    startGate.cancel();
    state.sessionStatus = 'IDLE';
    state.resumeStatus = null;
    dispatchHardware(0, 0, 0, 100, true);
    syncScreenWakeLock();
    crashRecovery?.clear();
    setOrgasmMode(false);
    clearHrSignalPause();
    // As after STOP: no paused session is left to resume, or to report.
    hideAlertBanner('supervision');
    hideAlertBanner('vacuglidePaused');
    retractMotorsPaused();
    // Reset ends a run as STOP does, and Finished me may read it for a minute.
    calibrationWindow = closeCalibrationWindow(calibrationWindow, Date.now());
    resetSessionCounters();
    resetGameState();
    updateWarmupBadge();
    cancelSpeech();
    // Back to the resting line, exactly as on a fresh load.
    paintIdlePrompt();
    showIdleTransport();
    withdrawStartRefusal();
    syncTelemetry();
    checkReadiness();
    if (!isRemotePage) updateEngine();
});

// Came Early & Learning Profile
function persistSettings() {
    const saved = safeSet('edgeloop_advanced_settings', advancedSettings);
    if (!saved) console.warn('Settings could not be saved (storage full or unavailable)');
    return saved;
}

// Session Setup values that used to be lost on every reload: the typed HR
// limits, the duration window and the Endgame Trigger. They are read off the
// page, sanitized exactly as a stored set is, and written to the same store
// as every other setting - so the Backup export carries them and Import
// restores them with no extra plumbing. A remote page never writes: those
// numbers belong to the host and would overwrite the partner's own store.
// The settings blob is JSON-encoded on every write, so a typed field does not
// get one write per key: the new value lands in advancedSettings on the spot
// (the engine reads it from memory on the next tick, which is what makes a
// mid-session correction take effect immediately) and the STORE write is
// coalesced into one per window. Anything that could take the page away
// flushes first, so a reload can never outrun a typed limit.
const sessionLimitsWriter = createWriteCoalescer({ write: () => persistSettings() });
window.addEventListener('pagehide', () => { sessionLimitsWriter.flush(); });
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sessionLimitsWriter.flush();
});

function persistSessionLimits(immediate = false) {
    if (isRemotePage) return false;
    const limits = readHrLimits();
    Object.assign(advancedSettings, sanitizeSessionLimits({
        minHr: limits.minHr,
        maxHr: limits.maxHr,
        durationMode: state.durationMode,
        durationFixedMinutes: document.getElementById('paramFixedInput')?.value,
        durationMinMinutes: document.getElementById('paramMinInput')?.value,
        durationMaxMinutes: document.getElementById('paramMaxInput')?.value,
        endgameType: state.endgameType
    }));
    sessionLimitsWriter.schedule();
    // A single deliberate action (a button, a card, leaving a field) is not a
    // burst and is written on the spot.
    return immediate ? sessionLimitsWriter.flush() : true;
}

// The learning line in Session Setup. updateEngine paints it from the
// ceiling it has just handed the engine, on every tick, so the line can never
// describe an offset the engine is not applying.
function paintLearningStatus(ceiling) {
    const text = document.getElementById('learningStatusText');
    if (!text) return;
    const status = describeLearningStatus({ profile: advancedSettings.learningProfile, ceiling });
    const className = status.active
        ? "p-2 bg-amber-950/40 border border-amber-800 rounded-lg text-[10px] font-mono text-amber-300"
        : "p-2 bg-slate-900 rounded-lg text-[10px] font-mono text-purple-300";
    if (text.textContent !== status.text) text.textContent = status.text;
    if (text.className !== className) text.className = className;
}

// Anything that changes the learning profile repaints through the engine
// tick, which computes the ceiling once and paints every surface from it.
function renderLearningStatus() {
    updateEngine();
}

function sessionIsLive() {
    return state.sessionStatus === 'RUNNING' || state.sessionStatus === 'PAUSED' || state.sessionStatus === 'RAMPDOWN';
}

// A session that is driving the toys: RUNNING, or in its Soft Landing.
function sessionDriving() {
    return state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN';
}

// Came Early and Finished me stop every toy the moment they are pressed,
// with the forced zero dispatch STOP sends, and ask only once the toys are
// at rest (session-rules.stopThenAsk says why the question waits for the
// Handy to confirm its stop, and what a press does when it does not). A
// session that is driving the toys is paused, not ended: nothing is decided
// before the answer, OK ends it, and Cancel leaves it paused for RESUME. The
// press used to end it first, so a mis-tap cost the session, and History
// kept an outcome Cancel could not take back. A pause the watchdog made
// would end by itself when the pulse came back, starting the toys under the
// question or after Cancel, so the press makes it one only RESUME ends. The
// pause is counted as any other pause is. A partner's RESUME that reaches the
// page only once OK has ended the session is not taken for a START
// (peer-messages.hostTransportAction). A START or RESUME still waiting for
// The Handy's answer (startOrResumeWhenReady) is dropped as STOP drops it -
// the wearer's, a partner's taken just before the press, and the watchdog's
// auto-resume, which no longer reads as a watchdog pause while it waits:
// its answer would start the toys while the press waits for their stop, or
// once the question is answered, Cancel included. One pressed while the
// press stops the toys and asks is not taken at all (startOrResumeWhenReady);
// pressed again once the question is answered, it asks again.
function haltForTheQuestion() {
    startGate.cancel();
    if (state.hrSignalPaused) clearHrSignalPause();
    if (!pauseSession('Paused.')) dispatchHardware(0, 0, 0, 100, true);
    checkReadiness();
    syncTelemetry();
    updateEngine();
}

function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// The frame after the next paint, so a question opened then stands over the
// cockpit as it is, not as it was a moment earlier.
function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

// Stop the toys, then `ask` once they are at rest - or, for the press that
// answers a refusal (`acknowledged`), once nothing is on its way to the Handy
// any more. A press made while an earlier one is still stopping or asking is
// dropped (createQuestionGate). `press` is what this press is about
// (session-rules.pressAbout), kept when it is refused.
function stopThenAskOnce(tappedAt, { press, acknowledged, notStoppedLine }, ask) {
    pressQuestion.run({
        halt: haltForTheQuestion,
        driving: sessionDriving,
        handyRest: handyRestState,
        stopTally: handyStopTally,
        wait: waitMs,
        nextFrame,
        acknowledged,
        ask: (answer) => {
            heldPress = null;
            // The prompt line said the press was waiting for the Handy: it
            // now says how that wait ended - and says it, notice or not,
            // when a stop it waited for went unanswered over a Handy
            // already at rest, which asks all the same.
            if (answer.waited || answer.unanswered) cueVoice(describeStopWaitOver(answer));
            try {
                return ask(answer);
            } finally {
                // The question is a native dialog. Escape closes it as Cancel
                // without the page ever seeing the key, and a click on its
                // way to the dialog's buttons lands a moment later on what the
                // dialog covered: RESUME, or START once OK has ended the
                // session. So the press sheet goes up as it closes, however
                // it was answered (raisePressSheet).
                raisePressSheet();
            }
        },
        // Said on the prompt line and spoken, never in a dialog: a dialog
        // would hold back the very stops the page is still sending.
        refuse: () => {
            heldPress = press;
            cueVoice(notStoppedLine, true);
        },
        waiting: () => cueVoice(describeWaitingForStop())
    }, { pressedAt: tappedAt }).catch((e) => console.warn('Came Early could not finish', e));
}

// Finished me: the Came Early button while Survival is the game.
function finishedMe(tappedAt) {
    // The run as it stood at the press, or at the press this one answers.
    // The record is never changed in place, so this is the run the question
    // is about, whatever happens before the question is asked.
    const { press, acknowledged } = pressAbout({ kind: 'finishedMe', held: heldPress, now: Date.now(), window: calibrationWindow });
    const calibrating = Boolean(advancedSettings.survivalCalibrating);
    stopThenAskOnce(tappedAt, { press, acknowledged, notStoppedLine: describeStopNotConfirmed({ finishedMe: true }) }, ({ handyAtRest }) => {
        // Worked out as the question is asked and stored exactly as asked.
        const limits = readHrLimits();
        const paused = state.sessionStatus === 'PAUSED';
        const plan = planFinishedMe({
            calibrating,
            paused,
            window: press.win,
            now: press.pressedAt,
            inputs: ceilingInputs(limits.minHr, limits.maxHr),
            holdPercent: advancedSettings.edgeHoldPercent,
            handyAtRest
        });
        if (plan.ask === 'alert') {
            // A press that saves nothing says so out loud and on the
            // cockpit's prompt line, which stays up behind the dialog and
            // after it. 1.1.2 returned in silence on a reading above 220,
            // with the toys still running.
            cueVoice(plan.line);
            alert(plan.text);
            return;
        }
        if (!confirm(plan.text)) {
            if (plan.cancelLine) cueVoice(plan.cancelLine);
            return;
        }
        if (plan.saveHr !== null) {
            const input = document.getElementById('maxHr');
            if (input) {
                input.value = String(plan.saveHr);
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
        if (paused) stopSession(plan.outcome, plan.line);
        else cueVoice(plan.line);
    });
}

// Came Early in every other mode: log an accidental release.
function cameEarly(tappedAt) {
    // The step is judged on the pulse of the minute before the press, or
    // before the press this one answers.
    const { press, acknowledged } = pressAbout({ kind: 'cameEarly', held: heldPress, now: Date.now(), readings: recentReadings });
    stopThenAskOnce(tappedAt, { press, acknowledged, notStoppedLine: describeStopNotConfirmed() }, ({ handyAtRest }) => {
        // Everything else is worked out as the question is asked, from the
        // profile as it stands, and exactly that is stored after it: the
        // numbers the wearer agrees to are the numbers they get.
        const limits = readHrLimits();
        const inputs = ceilingInputs(limits.minHr, limits.maxHr);
        const step = cameEarlyStep({ offset: inputs.learnedOffset, typedMaxHr: limits.maxHr, peakHr: press.peakHr });
        const before = learnedOffsetCeilings(inputs, step.previous);
        const after = learnedOffsetCeilings(inputs, step.offset);
        const paused = state.sessionStatus === 'PAUSED';
        if (!confirm(describeCameEarlyConfirm({ before, after, step, paused, handyAtRest, peakFromFirstPress: acknowledged }))) return;
        if (!advancedSettings.learningProfile) {
            advancedSettings.learningProfile = { breakthroughEvents: 0, suggestedMaxHrOffset: 0, lastBreakthroughHr: null };
        }
        const profile = advancedSettings.learningProfile;
        profile.breakthroughEvents = (profile.breakthroughEvents || 0) + 1;
        // The peak the step was judged on, or nothing: with no monitor this
        // used to record the 70 BPM the app starts with as the pulse of the
        // event.
        profile.lastBreakthroughHr = step.peakHr;
        profile.suggestedMaxHrOffset = step.offset;
        persistSettings();
        // No tick of the session runs on the offset stored here: it is
        // paused, which keeps the toys silent and counts no edge, and OK ends
        // it in the same breath. Stored under a running session, as 1.1.2
        // did, it lowered the ceiling for one more tick: a pulse between the
        // old and the new pullback mark - where a climax under the Climax HR
        // sits - counted as a brand-new edge, queued the edge cue ahead of
        // this one, reversed an Intiface rotator and went into the session
        // history as one edge more. The stop, or the tick below, repaints the
        // learning line and the badges with the offset just stored. The cue
        // says what the dialog said: a tighter limit only when the ceiling the
        // next session starts at really went down, and the peak the step was
        // judged on for {hr}.
        const cue = cameEarlyCue({ before, after, step });
        if (paused) {
            stopSession('Premature Release', cue.cue, cue.vars);
        } else {
            renderLearningStatus();
            cueVoice(cue.cue, false, cue.vars);
        }
    });
}

cameEarlyBtn?.addEventListener('click', (event) => {
    // The learning profile and the typed max belong to the host.
    if (isRemotePage || isRemoteViewer) return;
    // When the tap was made, which is not always when the page gets it.
    const tappedAt = Number.isFinite(event?.timeStamp) && event.timeStamp > 0 ? event.timeStamp : performance.now();
    if (state.activeMode === 'survival') finishedMe(tappedAt);
    else cameEarly(tappedAt);
});

document.getElementById('wipeLearningBtn')?.addEventListener('click', () => {
    const limits = readHrLimits();
    const inputs = ceilingInputs(limits.minHr, limits.maxHr);
    const message = describeWipeLearningConfirm({
        before: learnedOffsetCeilings(inputs),
        after: learnedOffsetCeilings(inputs, 0)
    });
    if (confirm(message)) {
        advancedSettings.learningProfile = { breakthroughEvents: 0, suggestedMaxHrOffset: 0, lastBreakthroughHr: null };
        persistSettings();
        renderLearningStatus();
    }
});

// Force Orgasm Overdrive. The state and button look live in one place so the
// toggle, stop, reset and remote telemetry all agree. The ceiling boost
// counter restarts from zero on every change and the typed Climax HR input
// is never modified. A run's time limit counts from the moment it is
// switched on, so switching it on or off by any path - the button, STOP,
// Reset, an ending, the limit itself - clears that clock.
function setOrgasmMode(on, { voice = false } = {}) {
    const next = Boolean(on);
    const changed = next !== Boolean(state.orgasmMode);
    state.orgasmMode = next;
    if (next) startOrgasmRamp();
    else {
        state.orgasmBoost = 0;
        state.orgasmFrom = null;
    }
    if (changed || !next) state.orgasmSeconds = 0;
    renderForceOrgasmButton();
    if (!changed || !voice) return;
    if (next) {
        cueVoice('forceOrgasm');
        return;
    }
    // Oracle CLIMAX already has oracleWithdrawn on the next tick.
    if (state.activeMode === 'oracle' && state.oracleState === 'CLIMAX') return;
    cueVoice('forceOrgasmOff');
}

// Force Orgasm's ramp starts from what the toys were last sent, as it was
// dispatched: at the arming, and again at a RESUME, where that is the stop
// the pause sent. The engine eases from there to the top (engine.js).
function startOrgasmRamp() {
    state.orgasmBoost = 0;
    state.orgasmFrom = { ...lastDispatched };
}

// One second of Force Orgasm's clock (session-rules.js tickForceOrgasm). The
// master clock asks it on every RUNNING tick, so every way of switching Force
// Orgasm on - the button, the Climax ending, an Oracle climax, the end of
// Edge Training, a run during Survival, a partner's ORGASM_TOGGLE (which
// clicks the same button) - runs against the same limit.
function tickForcedOrgasm() {
    const step = tickForceOrgasm(
        { seconds: state.orgasmSeconds },
        {
            orgasmMode: state.orgasmMode,
            sessionStatus: state.sessionStatus,
            maxSeconds: advancedSettings.forceOrgasmMaxSeconds
        }
    );
    state.orgasmSeconds = step.seconds;
    if (step.expired) landForcedOrgasm();
    renderForceOrgasmButton();
}

// The run has lasted as long as the Guards tab allows. It is never simply
// cut: the session goes into the same soft landing the Soft Landing ending
// uses, never above what the run was sending (beginSoftLanding), with its
// own cue on the dashboard (and in the voice), and the landing ends the
// session. That landing is this session's ending, so the endgame is spent
// with it: a target time falling inside the 45 s must neither arm Force
// Orgasm again nor stop the toys dead with Denied.
function landForcedOrgasm() {
    setOrgasmMode(false);
    state.endgameFired = true;
    state.landingAfterForceOrgasm = true;
    beginSoftLanding({ afterForcedRun: true });
    cueVoice('forceOrgasmLimit');
    // The landing's first value goes to the toys in this tick, and past The
    // Handy's 400 ms throttle: the driver drops a command that follows the
    // last one it sent by less than that, so a strap reading just before
    // this tick would have left the overdrive on The Handy for most of
    // another second. The master clock asks the limit before the engine
    // runs, and its tick sends the decision it ends on - this landing's first
    // value - once, when the tick is over (tickDispatch). Marked urgent, like
    // a guard's decision, it passes The Handy's throttle, and a stroker on
    // Intiface or T-Code takes it on the leg in flight instead of the next
    // one. A run that runs out on the first tick after a RESUME has not moved
    // yet, and its landing is a zero, sent like any other: a stop to a Handy
    // that may be moving, nothing to one at rest.
    tickDispatch.markUrgent();
}

// The seconds the Force Orgasm button counts down, 0 for none. A remote page
// runs no session of its own, so it shows the number the host sends.
function forceOrgasmSecondsLeftNow() {
    if (isRemotePage) return state.orgasmMode ? state.remoteOrgasmSecondsLeft : 0;
    return forceOrgasmSecondsLeft({
        orgasmMode: state.orgasmMode,
        seconds: state.orgasmSeconds,
        maxSeconds: advancedSettings.forceOrgasmMaxSeconds
    });
}

// Why switching Force Orgasm on would be refused right now ('' when it would
// not). The host decides from its own session; a remote page from what the
// host last said, since only the host knows what a pause resumes into.
function forceOrgasmRefusalNow() {
    if (isRemotePage) return state.remoteOrgasmRefusal || '';
    return forceOrgasmRefusal({ sessionStatus: state.sessionStatus, resumeStatus: state.resumeStatus });
}

const ORGASM_BUTTON_LOOKS = {
    ready: 'bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-xl p-1.5 transition text-xs flex flex-col items-center justify-center cursor-pointer shadow-lg shadow-amber-950/30',
    forcing: 'bg-rose-700 text-white font-bold rounded-xl p-1.5 transition text-xs flex flex-col items-center justify-center animate-pulse cursor-pointer shadow-lg shadow-rose-950/40',
    armed: 'bg-rose-900 text-rose-100 font-bold rounded-xl p-1.5 transition text-xs flex flex-col items-center justify-center cursor-pointer shadow-lg shadow-rose-950/40',
    barred: 'bg-slate-800 text-slate-400 font-bold rounded-xl p-1.5 transition text-xs flex flex-col items-center justify-center cursor-not-allowed border border-slate-700'
};

// The button says what the session is really doing (describeForceOrgasmButton)
// and counts a timed run down, and the line under the action bar says why the
// last refused tap was refused, for as long as that is still the reason.
function renderForceOrgasmButton() {
    const refusal = forceOrgasmRefusalNow();
    const face = describeForceOrgasmButton({
        orgasmMode: state.orgasmMode,
        sessionStatus: state.sessionStatus,
        landing: isRemotePage ? refusal === 'landing' : inSoftLanding(state),
        secondsLeft: forceOrgasmSecondsLeftNow()
    });
    // Painted on every engine tick, so only what changed is written: the
    // pulsing look must not be restarted, and a remote page's lock (added to
    // the button's classes after each telemetry frame) must not be undone
    // between frames for nothing.
    const paint = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
    paint(orgasmBtnText, face.label);
    paint(document.getElementById('orgasmBtnKicker'), face.kicker);
    const countdown = document.getElementById('orgasmBtnCountdown');
    paint(countdown, face.countdown);
    countdown?.classList.toggle('hidden', !face.countdown);
    const look = ORGASM_BUTTON_LOOKS[face.look] || ORGASM_BUTTON_LOOKS.ready;
    if (orgasmBtn && orgasmBtn.dataset.look !== face.look) {
        orgasmBtn.className = look;
        orgasmBtn.dataset.look = face.look;
    }
    if (orgasmRefusalShown && orgasmRefusalShown !== refusal) orgasmRefusalShown = '';
    const notice = document.getElementById('orgasmNotice');
    paint(notice, describeForceOrgasmRefusal(orgasmRefusalShown));
    notice?.classList.toggle('hidden', !orgasmRefusalShown);
}

orgasmBtn?.addEventListener('click', () => {
    if (isRemoteViewer) return;
    // Switching Force Orgasm OFF is never refused, here or on a partner's
    // page. Switching it ON is refused in a soft landing and with no session
    // running (session-rules.js forceOrgasmRefusal says why), and the line
    // under the button says so instead of the button reading Forcing...
    // while nothing is forced.
    const refusal = state.orgasmMode ? '' : forceOrgasmRefusalNow();
    if (refusal) {
        orgasmRefusalShown = refusal;
        renderForceOrgasmButton();
        return;
    }
    if (isRemoteController) {
        // The host toggles and reports back through telemetry. It refuses a
        // switch-on it cannot honour itself, whatever this page last heard.
        sendPeerCommand({ type: 'ORGASM_TOGGLE' });
        return;
    }
    setOrgasmMode(!state.orgasmMode, { voice: true });
    syncTelemetry();
    updateEngine();
});

// Typed HR limits take effect immediately (and are validated) rather than on
// the next clock tick.
['minHr', 'maxHr'].forEach((id) => {
    const input = document.getElementById(id);
    // Persisted on every edit, not only on blur: a wearer who lowers the
    // ceiling mid-session and never leaves the field used to lose it on the
    // next reload. A half-typed number is refused by readHrLimits, so what
    // is stored is always the last pair the sanitiser accepted.
    const edited = (immediate) => {
        persistSessionLimits(immediate);
        updateEngine();
        syncTelemetry();
        updateEdgeHoldPreview();
    };
    input?.addEventListener('input', () => edited(false));
    // A committed value lets go of the field, so the next key pressed goes to
    // the page and not into the Climax HR; the 'change' a window or tab
    // switch fires while the page has no focus still stores the limits but
    // keeps the field, which the wearer comes back to. And the wheel never
    // steps the field, which Chromium does one beat per wheel event while it
    // is focused and the input handler above would persist: the wheel is
    // cancelled while the field is focused, and one that can no longer be
    // cancelled lets go of the field instead (input-hygiene.js).
    releaseFocusOnCommit(input, () => edited(true));
    cancelWheelWhileFocused(input);
});

// Experience Modes vs Games Tab Switching
const expTabBioBtn = document.getElementById('expTabBioBtn');
const expTabGameBtn = document.getElementById('expTabGameBtn');
const bioProfilesGrid = document.getElementById('bioProfilesGrid');
const gameModesGrid = document.getElementById('gameModesGrid');

expTabBioBtn?.addEventListener('click', () => {
    expTabBioBtn.className = "px-2.5 py-0.5 rounded-md bg-purple-600 text-white transition cursor-pointer";
    if (expTabGameBtn) expTabGameBtn.className = "px-2.5 py-0.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer";
    bioProfilesGrid?.classList.remove('hidden');
    gameModesGrid?.classList.add('hidden');
    renderModeDetail();
});

expTabGameBtn?.addEventListener('click', () => {
    expTabGameBtn.className = "px-2.5 py-0.5 rounded-md bg-purple-600 text-white transition cursor-pointer";
    if (expTabBioBtn) expTabBioBtn.className = "px-2.5 py-0.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer";
    gameModesGrid?.classList.remove('hidden');
    bioProfilesGrid?.classList.add('hidden');
    renderModeDetail();
});

// Experience Mode Selection. A tease mode owns the stroke. A game, while
// selected, owns the speeds and uses that stroke. Clicking the selected
// game again turns the game off and leaves the tease mode running.
const GAME_CARD_MODES = ['oracle', 'survival', 'edgetrain'];
const modeCards = document.querySelectorAll('.mode-card');

const MODE_DETAILS = {
    classic: 'Full strokes inside the travel range you set. Tempo and depth drift so the same pulse does not feel identical, then Crawl or Full Stop at the ceiling.',
    milker: 'The stroker eases off as you climb and the internal toy takes over. Short bursts and the on-off pulse wait until your pulse is close to the heart rate you set.',
    shortener: 'Full strokes until your pulse is close to the heart rate you set, then the stroke shortens to the base. It stays quicker than Classic. The secondary channel stays low.',
    headplay: 'Full strokes until your pulse is close to the heart rate you set, then the stroke climbs toward the head. Speed eases off with your pulse, and the stroke opens back up when your pulse drops.',
    ultimate: 'The pattern changes with your pulse: long and steady, then long-slow against short-fast. Stops and short bursts wait until your pulse is close to the heart rate you set. The internal toy follows the same chapters.',
    ruin: 'The stroker keeps moving through the edge, once. After about 12 seconds on the mark it stops dead and the other toy drops low, so it can leak without a full orgasm. The stop lasts at least 18 seconds, and until the edge releases 5 BPM below the mark; only the next edge rides again. "At the ceiling" does not govern the ride or that stop.',
    oracle: 'Pulls you up and holds the edge, then decides how the session ends. Climax and denial wait for your Mystery minimum. The stroke range is the tease mode you selected.',
    survival: 'Each edge raises your max by 1 BPM and the speed a little. The climb takes about half an hour to get hard, and "At the ceiling" does not stop the toys or end the run. Check Calibration when this run should set your Climax HR, then tap Finished me when you come: it stops the toys, then offers the highest heart rate your monitor held on two readings in a row. The stroke range is the tease mode you selected.',
    edgetrain: 'Hold the edge for the time you set. Drop early and it does not count. After the set number of holds it offers to finish you. The stroke range is the tease mode you selected.'
};

// The paragraph above the cards follows the card you are looking at.
// On Modes it is the tease mode. On Games it is the game, when one is on.
function renderModeDetail() {
    const el = document.getElementById('modeDetail');
    if (!el) return;
    const gamesVisible = gameModesGrid && !gameModesGrid.classList.contains('hidden');
    const mode = (gamesVisible && state.gameMode) ? state.gameMode : state.teaseMode;
    el.textContent = MODE_DETAILS[mode] || '';
}

function highlightModeCard() {
    modeCards.forEach(c => {
        const mode = c.getAttribute('data-mode');
        const on = mode === state.teaseMode || mode === state.gameMode;
        const check = c.querySelector('.mode-check');
        const title = c.querySelector('.font-bold');
        if (on) {
            c.className = "mode-card text-left p-2 rounded-xl bg-purple-950/20 border border-purple-800 hover:border-purple-600 transition cursor-pointer flex flex-col justify-between";
            if (title) title.className = "font-bold text-[11px] text-purple-300 flex justify-between items-center";
            check?.classList.remove('hidden');
        } else {
            c.className = "mode-card text-left p-2 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 transition cursor-pointer flex flex-col justify-between";
            if (title) title.className = "font-bold text-[11px] text-slate-200 flex justify-between items-center";
            check?.classList.add('hidden');
        }
    });
}

function applyModeSelection(mode, enabled) {
    const wasSurvival = state.activeMode === 'survival';
    if (GAME_CARD_MODES.includes(mode)) {
        const turnOn = enabled !== undefined ? enabled : state.gameMode !== mode;
        if (!turnOn) {
            state.gameMode = null;
            resetGameState();
        } else {
            if (state.gameMode !== mode) resetGameState();
            state.gameMode = mode;
        }
    } else {
        // Ruin & Leak's clock is left alone: it belongs to the edge, not to
        // the card. Zeroing it here let one tap during the lockout - even on
        // the Ruin card itself, or a partner's MODE_CHANGE - cancel the 18 s
        // dead stop and start a fresh ride on a pulse still on the mark.
        state.teaseMode = mode;
    }
    state.activeMode = state.gameMode || state.teaseMode;
    // Finished me reads the run from the moment Survival came on in this
    // session, as the game's own edges do: readings from before belong to
    // another game. Going off ends its record; a tease-mode card under the
    // game leaves it alone.
    if (state.activeMode !== 'survival') calibrationWindow = null;
    else if (!wasSurvival) calibrationWindow = sessionIsLive() ? openCalibrationWindow(Date.now()) : null;
    // The button now means the other thing, and a press it turned away as
    // Came Early is no Finished me - nor a Finished me of a record just gone.
    if (wasSurvival !== (state.activeMode === 'survival')) heldPress = null;
    highlightModeCard();
    renderModeDetail();
    updateEngine();
}

document.getElementById('wizardCalibrateBtn')?.addEventListener('click', () => {
    if (isRemotePage || isRemoteViewer) return;
    advancedSettings.survivalCalibrating = true;
    const box = document.getElementById('survivalCalibrateToggle');
    if (box) box.checked = true;
    persistSettings();
    document.getElementById('expTabGameBtn')?.click();
    applyModeSelection('survival', true);
    closeWizard();
});

modeCards.forEach(card => {
    card.addEventListener('click', () => {
        if (isRemoteViewer) return;
        const mode = card.getAttribute('data-mode');
        const enabled = GAME_CARD_MODES.includes(mode) ? state.gameMode !== mode : true;
        const command = { type: 'MODE_CHANGE', mode, enabled };
        // A host on another version can read this message as something
        // else - a 1.0.0 host restarts the very game that "game off" means
        // to stop - so the click is refused here (as it is before the host's
        // first frame has said which version it runs), and not shown as made
        // either: the host's next frame would only take it back. The notice
        // says why.
        if (isRemoteController && !hostVersionAllows(command)) {
            showPeerVersionNotice();
            return;
        }
        applyModeSelection(mode, enabled);
        if (isRemoteController) sendPeerCommand(command);
        else syncTelemetry();
    });
});

renderModeDetail();

function persistTrainSettings() {
    advancedSettings.trainHoldSeconds = clampTrainHoldSeconds(document.getElementById('trainHoldSecondsInput')?.value);
    advancedSettings.trainEdges = clampTrainEdges(document.getElementById('trainEdgesInput')?.value);
    const holdEl = document.getElementById('trainHoldSecondsInput');
    const edgesEl = document.getElementById('trainEdgesInput');
    if (holdEl) holdEl.value = String(advancedSettings.trainHoldSeconds);
    if (edgesEl) edgesEl.value = String(advancedSettings.trainEdges);
    persistSettings();
}

// Host only. The hold length and the edge count are read from the WEARER's
// own settings, so a remote page must not collect them: they would stick on
// the partner's screen, overwrite that device's own stored training, and
// never reach the session. They are locked below like every other host-only
// control.
if (!isRemotePage) {
    ['trainHoldSecondsInput', 'trainEdgesInput'].forEach((id) => {
        const el = document.getElementById(id);
        el?.addEventListener('click', (e) => e.stopPropagation());
        el?.addEventListener('change', persistTrainSettings);
    });
    const calibrate = document.getElementById('survivalCalibrateToggle');
    document.querySelector('[data-survival-calibrate]')?.addEventListener('click', (e) => e.stopPropagation());
    calibrate?.addEventListener('change', () => {
        advancedSettings.survivalCalibrating = Boolean(calibrate.checked);
        persistSettings();
        if (calibrate.checked && state.gameMode !== 'survival') applyModeSelection('survival', true);
        else updateGameNotice();
    });
}

// Pop-up Modals Router
const overlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modals = {
    Ble: document.getElementById('modalBodyBle'),
    Handy: document.getElementById('modalBodyHandy'),
    Vacuglide: document.getElementById('modalBodyVacuglide'),
    Intiface: document.getElementById('modalBodyIntiface'),
    TCode: document.getElementById('modalBodyTCode'),
    History: document.getElementById('modalBodyHistory'),
    Params: document.getElementById('modalBodyParams'),
    Partner: document.getElementById('modalBodyPartner'),
    Legal: document.getElementById('modalBodyLegal'),
    Changelog: document.getElementById('modalBodyChangelog'),
    HrGuide: document.getElementById('modalBodyHrGuide')
};

function openModal(type) {
    Object.values(modals).forEach(m => m?.classList.add('hidden'));
    if (type === 'Ble' && modalTitle) {
        modalTitle.textContent = "Heart Rate Monitor & Simulator";
        modals.Ble?.classList.remove('hidden');
        warnBluetoothUnsupported();
    }
    else if (type === 'Handy' && modalTitle) {
        modalTitle.textContent = "The Handy (Wi-Fi API)";
        modals.Handy?.classList.remove('hidden');
        updateHwEnvelopeDisplay();
    }
    else if (type === 'Vacuglide' && modalTitle) {
        modalTitle.textContent = "Autoblow VacuGlide 2 (Wi-Fi API)";
        modals.Vacuglide?.classList.remove('hidden');
        renderVacuglideValves();
    }
    else if (type === 'Intiface' && modalTitle) { modalTitle.textContent = "Intiface Central & Toy Roles"; modals.Intiface?.classList.remove('hidden'); renderIntifaceDevices(); }
    else if (type === 'TCode' && modalTitle) {
        modalTitle.textContent = "TCode Serial (OSR2 / SR6 / OSSM)";
        modals.TCode?.classList.remove('hidden');
        renderTCodeStatus(getTCodeStatus());
        renderTCodeDevice();
        warnSerialUnsupported();
    }
    else if (type === 'History' && modalTitle) { modalTitle.textContent = "Session History & Funscripts"; modals.History?.classList.remove('hidden'); renderHistory(); }
    else if (type === 'Params' && modalTitle) { modalTitle.textContent = "Session Setup"; modals.Params?.classList.remove('hidden'); renderLearningStatus(); syncParamsUI(); }
    else if (type === 'Partner' && modalTitle) { modalTitle.textContent = "Share Control Hub"; modals.Partner?.classList.remove('hidden'); setupPartnerHost(); }
    else if (type === 'Legal' && modalTitle) { modalTitle.textContent = "Legal & Medical Disclaimer"; modals.Legal?.classList.remove('hidden'); }
    else if (type === 'Changelog' && modalTitle) {
        modalTitle.textContent = `Changelog · v${APP_VERSION}`;
        modals.Changelog?.classList.remove('hidden');
        loadChangelog();
    }
    else if (type === 'HrGuide' && modalTitle) { modalTitle.textContent = "Smartwatch Pairing Guide"; modals.HrGuide?.classList.remove('hidden'); }
    overlay?.classList.remove('hidden');
}

function closeModal() {
    // Before the overlay is hidden: hiding is what would commit the field.
    settleHandyPanelInputs();
    overlay?.classList.add('hidden');
    if (state.isTestingMic && !advancedSettings.micEnabled) {
        stopMicMonitor(state);
        paintMicMeter(0);
    }
    state.isTestingMic = false;
}

document.getElementById('cardBle')?.addEventListener('click', () => { if (!isRemotePage) openModal('Ble'); });
document.getElementById('cardHandy')?.addEventListener('click', () => { if (!isRemotePage) openModal('Handy'); });
document.getElementById('cardVacuglide')?.addEventListener('click', () => { if (!isRemotePage) openModal('Vacuglide'); });
document.getElementById('cardIntiface')?.addEventListener('click', () => { if (!isRemotePage) openModal('Intiface'); });
document.getElementById('cardTCode')?.addEventListener('click', () => { if (!isRemotePage) openModal('TCode'); });
document.getElementById('historyBtn')?.addEventListener('click', () => openModal('History'));
document.getElementById('sessionParamsHeaderBtn')?.addEventListener('click', () => openModal('Params'));
document.getElementById('openParamsBtn')?.addEventListener('click', () => openModal('Params'));
document.getElementById('partnerShareBtn')?.addEventListener('click', () => { if (!isRemotePage) openModal('Partner'); });
document.getElementById('bleQuickHelpBtn')?.addEventListener('click', () => openModal('HrGuide'));
document.getElementById('footerLegalBtn')?.addEventListener('click', () => openModal('Legal'));
document.getElementById('footerChangelogBtn')?.addEventListener('click', () => openModal('Changelog'));

const versionEl = document.getElementById('appVersion');
if (versionEl) versionEl.textContent = `v${APP_VERSION}`;

function appendChangelogText(parent, text) {
    const parts = String(text).split('**');
    parts.forEach((part, index) => {
        if (!part) return;
        if (index % 2 === 1) {
            const strong = document.createElement('strong');
            strong.className = 'text-slate-200';
            strong.textContent = part;
            parent.appendChild(strong);
        } else {
            parent.appendChild(document.createTextNode(part));
        }
    });
}

function paintChangelog(markdown) {
    const body = document.getElementById('changelogBody');
    if (!body) return;
    body.replaceChildren();
    for (const section of parseChangelog(markdown)) {
        const heading = document.createElement('h4');
        heading.className = 'text-xs font-bold text-slate-200 uppercase tracking-wider pt-1';
        heading.textContent = section.title;
        body.appendChild(heading);
        let list = null;
        for (const block of section.blocks) {
            if (block.type !== 'item') list = null;
            if (block.type === 'area') {
                const area = document.createElement('div');
                area.className = 'font-semibold text-slate-300 pt-1';
                area.textContent = block.text;
                body.appendChild(area);
            } else if (block.type === 'text') {
                const paragraph = document.createElement('p');
                appendChangelogText(paragraph, block.text);
                body.appendChild(paragraph);
            } else if (block.type === 'item') {
                if (!list) {
                    list = document.createElement('ul');
                    list.className = 'list-disc list-inside space-y-1';
                    body.appendChild(list);
                }
                const item = document.createElement('li');
                appendChangelogText(item, block.text);
                list.appendChild(item);
            }
        }
    }
}

let changelogLoaded = false;
async function loadChangelog() {
    const body = document.getElementById('changelogBody');
    const github = document.getElementById('changelogGithubLink');
    const releases = document.getElementById('changelogReleasesLink');
    if (github) github.href = GITHUB_CHANGELOG_URL;
    if (releases) releases.href = GITHUB_RELEASES_URL;
    if (!body || changelogLoaded) return;
    try {
        const response = await fetch('./CHANGELOG.md', { cache: 'no-cache' });
        if (!response.ok) throw new Error(String(response.status));
        paintChangelog(await response.text());
        changelogLoaded = true;
    } catch {
        body.textContent = 'This copy could not load its changelog. It is on GitHub at the link below.';
    }
}
document.getElementById('modalCloseBtn')?.addEventListener('click', closeModal);
overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

// Keyboard (hotkeys.js decides, this only reads the page and presses). Space
// pauses a running session and never resumes or starts one; Escape closes
// the open modal. Each presses the very button a click would - the
// transport, the modal's X - so a key obeys every lock and readiness check
// that button obeys, on the host and on a controller page alike, and a
// viewer's locked transport answers no key. The listeners run in the capture
// phase because a pause must reach the transport before a handler on the
// focused control acts on the same Space (the Import labels open a file
// picker on it); a key the layer consumes goes no further.
const hotkeys = createHotkeyLayer();

function overlayUp(el) {
    return Boolean(el) && !el.classList.contains('hidden');
}

// For REACTION_MS after Escape closes the dialog, a sheet lies over the whole
// page. Escape closes the dialog on the way down, and a click on its X that
// is already on its way lands a moment later on whatever the dialog covered:
// on START or RESUME, which set the toys moving, or on a mode card or the
// intensity slider. The sheet takes that click. The Came Early and Finished
// me question raises it too, as it closes (stopThenAskOnce). It has no
// content, is aria-hidden and cannot take the focus, so a keyboard and a
// screen reader pass it by.
// A press that begins on the sheet presses nothing else, even when the sheet
// is gone before the press ends: a mouse's click goes to what both its press
// and its release were on, and a tap's click, aimed again as the finger
// lifts, is cancelled with the tap's touchend.
const pressSheet = document.createElement('div');
pressSheet.setAttribute('aria-hidden', 'true');
pressSheet.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none';
document.body.append(pressSheet);
let pressSheetTimer = null;

function raisePressSheet() {
    pressSheet.style.display = 'block';
    clearTimeout(pressSheetTimer);
    pressSheetTimer = setTimeout(() => { pressSheet.style.display = 'none'; }, REACTION_MS);
}

pressSheet.addEventListener('touchend', (e) => e.preventDefault(), { passive: false });

// Stopping the motors is always allowed: while the session runs, a press on
// the sheet over PAUSE or STOP presses that button at once. Not Reset: it
// throws the session away unsaved, and a press meant for the X that landed
// on it would lose the wearer's whole session.
pressSheet.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (state.sessionStatus !== 'RUNNING' && state.sessionStatus !== 'RAMPDOWN') return;
    const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el !== pressSheet);
    const button = under?.closest('button');
    if (button && (button === playPauseBtn || button === stopBtn)) button.click();
});

document.addEventListener('keydown', (e) => {
    const plan = hotkeys.keyDown(e, {
        target: classifyKeyTarget(e.target, playPauseBtn),
        sessionStatus: state.sessionStatus,
        transportEnabled: Boolean(playPauseBtn) && !playPauseBtn.disabled && !isRemoteViewer,
        modalOpen: overlayUp(overlay),
        // The age gate sits above the wizard, so it names the pair.
        overlay: overlayUp(ageOverlay) ? 'ageGate' : (overlayUp(wizardOverlay) ? 'wizard' : null)
    });
    if (plan.consume) {
        e.preventDefault();
        e.stopPropagation();
    }
    if (plan.action === 'pause') {
        // The plan only ever pauses a running session. Neither does this
        // line press the transport in any other state, whatever a later
        // change does to the plan: there the press would be START or RESUME.
        if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') playPauseBtn?.click();
    } else if (plan.action === 'closeModal') {
        document.getElementById('modalCloseBtn')?.click();
        raisePressSheet();
    }
}, true);
document.addEventListener('keyup', (e) => {
    if (!hotkeys.keyUp(e, { target: classifyKeyTarget(e.target, playPauseBtn) }).consume) return;
    e.preventDefault();
    e.stopPropagation();
}, true);

// BLE Modal Tabs
const bleTabRealBtn = document.getElementById('bleTabRealBtn');
const bleTabSimBtn = document.getElementById('bleTabSimBtn');
const bleRealSection = document.getElementById('bleRealSection');
const bleSimSection = document.getElementById('bleSimSection');

bleTabRealBtn?.addEventListener('click', () => {
    bleTabRealBtn.className = "flex-1 py-1.5 rounded-md bg-purple-600 text-white transition cursor-pointer";
    if (bleTabSimBtn) bleTabSimBtn.className = "flex-1 py-1.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer";
    bleRealSection?.classList.remove('hidden');
    bleSimSection?.classList.add('hidden');
});

bleTabSimBtn?.addEventListener('click', () => {
    bleTabSimBtn.className = "flex-1 py-1.5 rounded-md bg-purple-600 text-white transition cursor-pointer";
    if (bleTabRealBtn) bleTabRealBtn.className = "flex-1 py-1.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer";
    bleSimSection?.classList.remove('hidden');
    bleRealSection?.classList.add('hidden');
});

// Session Setup Sub-Tabs (4 Tabs: duration, guards, audio, backup)
const paramsTabMap = {
    duration: { btn: document.getElementById('paramsTabDurationBtn'), sec: document.getElementById('paramsDurationSection') },
    guards: { btn: document.getElementById('paramsTabGuardsBtn'), sec: document.getElementById('paramsGuardsSection') },
    audio: { btn: document.getElementById('paramsTabAudioBtn'), sec: document.getElementById('paramsAudioSection') },
    backup: { btn: document.getElementById('paramsTabBackupBtn'), sec: document.getElementById('paramsBackupSection') }
};

function setParamsTab(activeKey) {
    Object.keys(paramsTabMap).forEach(key => {
        const item = paramsTabMap[key];
        if (item.btn && item.sec) {
            const isActive = (key === activeKey);
            item.sec.classList.toggle('hidden', !isActive);
            item.btn.className = isActive
            ? "flex-1 py-1.5 rounded-md bg-purple-600 text-white transition cursor-pointer"
            : "flex-1 py-1.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer";
        }
    });
}

paramsTabMap.duration.btn?.addEventListener('click', () => setParamsTab('duration'));
paramsTabMap.guards.btn?.addEventListener('click', () => setParamsTab('guards'));
paramsTabMap.audio.btn?.addEventListener('click', () => setParamsTab('audio'));
paramsTabMap.backup.btn?.addEventListener('click', () => setParamsTab('backup'));

// Duration Mode Switcher
const durFixedBtn = document.getElementById('durFixedBtn');
const durRangeBtn = document.getElementById('durRangeBtn');
const durEndlessBtn = document.getElementById('durEndlessBtn');
const paramFixedContainer = document.getElementById('paramFixedContainer');
const paramRangeContainer = document.getElementById('paramRangeContainer');
const paramEndlessContainer = document.getElementById('paramEndlessContainer');

function setDurationMode(mode) {
    state.durationMode = mode;
    if (durFixedBtn) durFixedBtn.className = mode === 'fixed' ? 'px-2 py-0.5 rounded-md bg-purple-600 text-white transition cursor-pointer' : 'px-2 py-0.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer';
    if (durRangeBtn) durRangeBtn.className = mode === 'range' ? 'px-2 py-0.5 rounded-md bg-purple-600 text-white transition cursor-pointer' : 'px-2 py-0.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer';
    if (durEndlessBtn) durEndlessBtn.className = mode === 'endless' ? 'px-2 py-0.5 rounded-md bg-purple-600 text-white transition cursor-pointer' : 'px-2 py-0.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer';

    paramFixedContainer?.classList.toggle('hidden', mode !== 'fixed');
    paramRangeContainer?.classList.toggle('hidden', mode !== 'range');
    paramEndlessContainer?.classList.toggle('hidden', mode !== 'endless');
    validateDurationInputs();
    updateTimerDisplay();
}

['paramFixedInput', 'paramMinInput', 'paramMaxInput'].forEach((id) => {
    const input = document.getElementById(id);
    input?.addEventListener('input', () => { validateDurationInputs(); persistSessionLimits(); });
    input?.addEventListener('change', () => { validateDurationInputs(); persistSessionLimits(true); });
});

// setDurationMode is also how the stored mode is restored, so only a real
// click writes the store.
durFixedBtn?.addEventListener('click', () => { setDurationMode('fixed'); persistSessionLimits(true); });
durRangeBtn?.addEventListener('click', () => { setDurationMode('range'); persistSessionLimits(true); });
durEndlessBtn?.addEventListener('click', () => { setDurationMode('endless'); persistSessionLimits(true); });

// Warm-up Slider Listener
const warmupInput = document.getElementById('warmupInput');
const warmupDisplay = document.getElementById('warmupValDisplay');
warmupInput?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    if (warmupDisplay) {
        warmupDisplay.textContent = (val === 0) ? "0 min (Instant)" : `${val} Minutes`;
    }
});

function syncParamsUI() {
    // Restore the persisted session limits into the page. advancedSettings
    // has already been through sanitizeSessionLimits (syncGuardSettings), so
    // these are values the wearer could have typed themselves. All of it is
    // host-only: every one of these numbers describes the WEARER's session,
    // and a remote page shows the host's, so none of them may be supplied
    // out of the partner's own browser.
    if (!isRemotePage) {
        const minInput = document.getElementById('minHr');
        const maxInput = document.getElementById('maxHr');
        if (minInput) minInput.value = String(advancedSettings.minHr);
        if (maxInput) maxInput.value = String(advancedSettings.maxHr);
        // The fallback pair readHrLimits falls back to when a field is
        // half-typed, seeded from the same numbers that were just painted
        // into those fields. A remote page keeps the factory 70 / 140: its
        // two HR fields mirror the HOST's limits, so this device's stored
        // pair must never stand in for them before the first telemetry.
        state.lastGoodHrLimits = { minHr: advancedSettings.minHr, maxHr: advancedSettings.maxHr };
        const fixedInput = document.getElementById('paramFixedInput');
        const rangeMinInput = document.getElementById('paramMinInput');
        const rangeMaxInput = document.getElementById('paramMaxInput');
        if (fixedInput) fixedInput.value = String(advancedSettings.durationFixedMinutes);
        if (rangeMinInput) rangeMinInput.value = String(advancedSettings.durationMinMinutes);
        if (rangeMaxInput) rangeMaxInput.value = String(advancedSettings.durationMaxMinutes);
        // The Target Mode and the Endgame Trigger are the WEARER's: a remote
        // page is told neither over the wire, and the timer sub-label reads
        // state.durationMode, so adopting this device's stored mode would
        // have a partner's screen announce Endless while the host runs a
        // Mystery window. A remote page keeps the built-in Mystery / Climax
        // until the host says otherwise, exactly as it did before these
        // values were stored at all.
        state.endgameType = advancedSettings.endgameType;
        highlightEndgameCard(state.endgameType);
        state.durationMode = advancedSettings.durationMode;
    }
    setDurationMode(state.durationMode);
    const stallToggle = document.getElementById('stallGuardToggle');
    const stallSec = document.getElementById('stallGuardSecondsInput');
    const dualToggle = document.getElementById('dualDampeningToggle');
    const dualBpm = document.getElementById('dualDampeningOffsetInput');
    const decayToggle = document.getElementById('adaptiveDecayToggle');
    const decayCount = document.getElementById('decayEdgeCountInput');
    const decayBpm = document.getElementById('decayBpmInput');
    const decayFloor = document.getElementById('decayFloorInput');
    const warmup = document.getElementById('warmupInput');
    const warmupDisp = document.getElementById('warmupValDisplay');

    if (stallToggle) stallToggle.checked = Boolean(advancedSettings.stallGuard);
    if (stallSec) stallSec.value = clampStallGuardSeconds(advancedSettings.stallGuardSeconds);
    const stallPause = document.getElementById('stallPauseSecondsInput');
    if (stallPause) stallPause.value = clampStallPauseSeconds(advancedSettings.stallPauseSeconds);
    const orgasmMax = document.getElementById('forceOrgasmMaxSelect');
    if (orgasmMax) orgasmMax.value = String(resolveForceOrgasmMaxSeconds(advancedSettings.forceOrgasmMaxSeconds));
    const ceilingSelect = document.getElementById('ceilingBehaviourSelect');
    if (ceilingSelect) ceilingSelect.value = advancedSettings.ceilingBehaviour === 'stop' ? 'stop' : 'crawl';
    const holdInput = document.getElementById('edgeHoldPercentInput');
    if (holdInput) holdInput.value = isRemotePage ? '' : clampEdgeHoldPercent(advancedSettings.edgeHoldPercent);
    if (isRemotePage && holdInput) holdInput.placeholder = '--';
    if (!isRemotePage) updateEdgeHoldPreview();
    const trainHold = document.getElementById('trainHoldSecondsInput');
    const trainEdges = document.getElementById('trainEdgesInput');
    // On a remote page these belong to the HOST. Writing this browser's own
    // persisted values would show the partner their own Hold / edges while
    // they pace the wearer's session by them; the HTML defaults would be just
    // as wrong. They stay blank until telemetry carries the host's numbers.
    if (trainHold) trainHold.value = isRemotePage ? '' : clampTrainHoldSeconds(advancedSettings.trainHoldSeconds);
    if (trainEdges) trainEdges.value = isRemotePage ? '' : clampTrainEdges(advancedSettings.trainEdges);
    const calibrate = document.getElementById('survivalCalibrateToggle');
    if (calibrate) calibrate.checked = !isRemotePage && Boolean(advancedSettings.survivalCalibrating);
    if (isRemotePage) {
        if (trainHold) trainHold.placeholder = '--';
        if (trainEdges) trainEdges.placeholder = '--';
    }
    if (dualToggle) dualToggle.checked = Boolean(advancedSettings.dualDampening);
    if (dualBpm) dualBpm.value = advancedSettings.dualDampeningBpm || 15;
    if (decayToggle) decayToggle.checked = Boolean(advancedSettings.adaptiveDecay);
    if (decayCount) decayCount.value = advancedSettings.decayEdgeCount || 2;
    if (decayBpm) decayBpm.value = advancedSettings.decayBpm || 2;
    if (decayFloor) decayFloor.value = advancedSettings.decayFloor || 105;

    const staleInput = document.getElementById('hrStaleSecondsInput');
    const autoResumeToggle = document.getElementById('hrAutoResumeToggle');
    if (staleInput) staleInput.value = clampStaleSeconds(advancedSettings.hrStaleSeconds);
    if (autoResumeToggle) autoResumeToggle.checked = advancedSettings.hrAutoResume !== false;

    if (warmup) warmup.value = advancedSettings.warmupMinutes ?? 5;
    if (warmupDisp) warmupDisp.textContent = (advancedSettings.warmupMinutes === 0) ? "0 min (Instant)" : `${advancedSettings.warmupMinutes ?? 5} Minutes`;

    const voiceToggle = document.getElementById('paramVoiceToggle');
    const micToggle = document.getElementById('paramMicToggle');
    if (voiceToggle) voiceToggle.checked = Boolean(advancedSettings.voiceEnabled);
    if (micToggle) micToggle.checked = Boolean(advancedSettings.micEnabled);
    const gateInput = document.getElementById('micGateInput');
    const gateValue = document.getElementById('micGateValue');
    const gate = clampMicGate(advancedSettings.micSensitivityThreshold);
    if (gateInput) gateInput.value = gate;
    if (gateValue) gateValue.textContent = String(gate);
    const boostInput = document.getElementById('micBoostBpmInput');
    const boostValue = document.getElementById('micBoostBpmValue');
    const boostCap = clampMicBoostBpm(advancedSettings.micBoostMaxBpm);
    if (boostInput) boostInput.value = boostCap;
    if (boostValue) boostValue.textContent = String(boostCap);
    previewedWhileOff = false;
    populateVoiceSelect();
    renderVoiceCueEditor();
    paintIdlePrompt();
}

// What the wearer is told about the voice itself. Speech errors used to be
// swallowed, so a voice that never worked looked exactly like one that did.
// A failure now shows on the label beside the dashboard prompt line for as
// long as it lasts, under Preview in Session Setup, and on the alert banner
// once per session: a voice that fails fails on every cue, and one banner per
// cue would bury the reports that matter more.
const speechNotices = createSpeechNotices();
let speechProblem = null;
let previewedWhileOff = false;

const VOICE_LABEL_TONES = {
    on: 'text-purple-300',
    off: 'text-slate-500',
    warn: 'text-amber-300 font-bold'
};

function renderVoiceState() {
    const label = document.getElementById('mindgameVoiceLabel');
    if (label) {
        const indicator = describeVoiceIndicator({
            enabled: advancedSettings.voiceEnabled,
            failing: Boolean(speechProblem)
        });
        label.textContent = indicator.text;
        label.className = `text-[9px] font-mono shrink-0 ${VOICE_LABEL_TONES[indicator.tone]}`;
    }
    const note = document.getElementById('voiceStatusNote');
    if (note) {
        const status = describeVoiceStatus({
            enabled: advancedSettings.voiceEnabled,
            problem: speechProblem,
            voiceURI: advancedSettings.voiceURI,
            voices: listSpeechVoices(),
            previewedWhileOff
        });
        note.textContent = status ? status.text : '';
        note.className = `text-[9px] leading-snug ${status && status.tone === 'warn' ? 'text-amber-300' : 'text-slate-400'}`;
        note.classList.toggle('hidden', !status);
    }
}

// Is the note under Preview on screen right now? Then it already says it.
function voiceNoteOnScreen() {
    return paramsModalOpen() && !document.getElementById('paramsAudioSection')?.classList.contains('hidden');
}

function announceVoiceNotice(kind, message, source) {
    if (voiceNoteOnScreen()) return;
    if (!speechNotices.take(kind)) return;
    // An advisory: it never replaces a safety report, and it stands beside
    // any other advisory rather than in its place (alert-banner.js), so a
    // lost microphone's sentence stays up next to it. It is the voice's own
    // sentence, too, and leaves when the voice speaks again, when the voice
    // is switched off or when a voice this browser has is picked. Written
    // into the microphone's sentence, as it was, it could leave with
    // neither: it stayed up under the microphone's name after the voice had
    // spoken again.
    showAlertBanner(message, { severity: 'advisory', source });
}

setSpeechObserver((event) => {
    if (event.type === 'started') {
        if (!speechProblem) return;
        speechProblem = null;
        hideAlertBanner('voice');
        renderVoiceState();
    } else if (event.type === 'failed') {
        speechProblem = { kind: event.kind, message: event.message };
        renderVoiceState();
        announceVoiceNotice(event.kind, event.message, 'voice');
    } else if (event.type === 'voice-missing') {
        renderVoiceState();
        announceVoiceNotice('voice-missing', describeMissingVoice(event.voiceURI), 'voice-choice');
    }
});

// The switch takes effect the moment it moves and is saved at once, like the
// microphone Test beside it. It used to wait for Apply, which sits below the
// fold on this tab: a wearer could switch it on, hear Preview, close the
// panel with the X and run a whole session in silence - and the panel then
// showed the switch OFF again, with nothing saying why.
//
// A failure the browser already reported is kept across the switch: it
// belongs to the browser and its voices, not to the switch, and clearing it
// would show "Voice on" to a wearer whose browser was just seen unable to
// speak. The next cue that really starts clears it.
function setVoiceEnabled(on) {
    const next = Boolean(on);
    const changed = next !== Boolean(advancedSettings.voiceEnabled);
    advancedSettings.voiceEnabled = next;
    // Off means silent now, not after the cue that is playing.
    if (!next) cancelSpeech();
    if (!changed) return;
    previewedWhileOff = false;
    // Nothing is spoken with the voice off, so a banner about the voice has
    // nothing left to warn about.
    if (!next) {
        hideAlertBanner('voice');
        hideAlertBanner('voice-choice');
    }
}

document.getElementById('paramVoiceToggle')?.addEventListener('change', (e) => {
    setVoiceEnabled(e.target.checked);
    persistSettings();
    paintIdlePrompt();
});

function populateVoiceSelect() {
    const select = document.getElementById('paramVoiceSelect');
    if (!select || !window.speechSynthesis) return;
    const voices = listSpeechVoices();
    const current = advancedSettings.voiceURI || '';
    select.innerHTML = '<option value="">Browser default</option>';
    voices.forEach((voice) => {
        const option = document.createElement('option');
        option.value = voice.voiceURI;
        option.textContent = `${voice.name} (${voice.lang})`;
        if (voice.voiceURI === current) option.selected = true;
        select.appendChild(option);
    });
    // A saved voice this browser does not list stays in the picker, named for
    // what it is. Showing "Browser default" in its place made the next Apply
    // or Preview overwrite the saved choice - and Chrome lists no voice at all
    // until it has loaded them, so that could happen to a voice that was about
    // to appear.
    if (current && !voices.some((voice) => voice.voiceURI === current)) {
        const option = document.createElement('option');
        option.value = current;
        option.textContent = `${voiceDisplayName(current)} (not in this browser's voice list)`;
        select.appendChild(option);
    }
    select.value = current;
    renderVoiceState();
}

if (window.speechSynthesis) {
    populateVoiceSelect();
    window.speechSynthesis.addEventListener('voiceschanged', populateVoiceSelect);
}

// Preview and Speak play whatever the switch says, so a wearer can try a
// voice before turning guidance on. Hearing one with the switch off is
// exactly how the forum report went, so the panel says it was only a preview.
function notePreview() {
    previewedWhileOff = !advancedSettings.voiceEnabled;
    renderVoiceState();
}

document.getElementById('paramVoicePreviewBtn')?.addEventListener('click', () => {
    const select = document.getElementById('paramVoiceSelect');
    if (select) advancedSettings.voiceURI = select.value;
    const { text } = resolveVoiceCue(currentVoiceCues().cues, 'preview', sessionVoiceVars());
    if (!text) return;
    speakNow(text, advancedSettings.voiceURI);
    notePreview();
});

function escapeAttr(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderVoiceCueEditor() {
    const root = document.getElementById('voiceCuesList');
    if (!root) return;
    const merged = mergeVoiceCues(advancedSettings.voiceCues);
    let lastGroup = '';
    root.innerHTML = VOICE_CUE_CATALOG.map((cue) => {
        const lines = merged[cue.id] || cue.lines;
        const rows = Math.min(8, Math.max(3, lines.length + 1));
        const group = cue.group || '';
        const heading = group && group !== lastGroup
            ? `<p class="text-[9px] uppercase tracking-wider text-purple-400 font-bold pt-1">${escapeAttr(group)}</p>`
            : '';
        lastGroup = group;
        return `${heading}<div class="space-y-0.5">
            <div class="flex justify-between items-center gap-2">
              <label class="text-[9px] text-slate-400 font-semibold" for="voiceCue-${cue.id}">${escapeAttr(cue.label)} <span class="text-slate-600 font-mono">(${lines.length === 0 ? 'muted' : lines.length})</span></label>
              <button type="button" data-voice-preview="${cue.id}" class="text-[9px] text-purple-300 hover:underline cursor-pointer">Speak</button>
            </div>
            <textarea id="voiceCue-${cue.id}" data-voice-cue="${cue.id}" rows="${rows}" class="w-full bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-[10px] text-slate-200 outline-none focus:border-purple-500 font-mono leading-snug">${escapeAttr(lines.join('\n'))}</textarea>
        </div>`;
    }).join('');
    const interval = document.getElementById('voiceEncourageSecondsInput');
    if (interval) interval.value = clampEncourageSeconds(advancedSettings.voiceEncourageSeconds);
}

// Reads the phrase editor WITHOUT committing it: Speak, Preview and both
// exports only look at what is typed. Only Apply (and Import / Reset, which
// the user confirms) writes these into advancedSettings, so closing the modal
// with the X discards phrase edits like every other control in it.
function readVoiceCuesFromForm() {
    const raw = {};
    document.querySelectorAll('[data-voice-cue]').forEach((el) => {
        raw[el.getAttribute('data-voice-cue')] = el.value;
    });
    const intervalEl = document.getElementById('voiceEncourageSecondsInput');
    return {
        cues: Object.keys(raw).length > 0 ? mergeVoiceCues(raw) : null,
        encourageSeconds: intervalEl ? clampEncourageSeconds(intervalEl.value) : null
    };
}

// The phrases as they stand right now: what is typed in the editor when it is
// on screen, otherwise what is saved.
function currentVoiceCues() {
    const form = readVoiceCuesFromForm();
    return {
        cues: form.cues || mergeVoiceCues(advancedSettings.voiceCues),
        encourageSeconds: form.encourageSeconds ?? clampEncourageSeconds(advancedSettings.voiceEncourageSeconds)
    };
}

document.getElementById('voiceCuesList')?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-voice-preview]');
    if (!btn) return;
    const { text } = resolveVoiceCue(currentVoiceCues().cues, btn.getAttribute('data-voice-preview'), sessionVoiceVars());
    if (!text) return;
    speakNow(text, advancedSettings.voiceURI);
    notePreview();
});

document.getElementById('voiceCuesResetBtn')?.addEventListener('click', () => {
    if (!confirm('Restore the factory phrases for all cues? Every custom line you wrote is lost.')) return;
    advancedSettings.voiceCues = mergeVoiceCues({});
    advancedSettings.voiceEncourageSeconds = clampEncourageSeconds(advancedSettings.voiceEncourageSeconds);
    renderVoiceCueEditor();
    if (!persistSettings()) alert('The phrases were reset, but the browser refused to save them (storage full or unavailable).');
});

function downloadNamedText(filename, body, mime = 'application/json') {
    const blob = new Blob([body], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

document.getElementById('voiceCuesExportBtn')?.addEventListener('click', () => {
    const live = currentVoiceCues();
    const payload = {
        voiceCues: serializeVoiceCues(live.cues),
        voiceEncourageSeconds: live.encourageSeconds
    };
    downloadNamedText('edgeloop_voice_cues.json', JSON.stringify(payload, null, 2));
});

document.getElementById('voiceCuesImportFile')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => {
        alert('That file could not be read. Nothing was changed.');
    };
    reader.onload = (evt) => {
        const parsed = parseVoiceCuesText(String(evt.target.result || ''));
        if (parsed.error === 'header') {
            alert(`"${parsed.header}" is not a phrase section EdgeLoop knows, so nothing was imported. Sections are # edge, # encourage, # forceOrgasm, # cameEarly and the other cue names (upper or lower case).`);
            return;
        }
        if (parsed.error === 'preamble') {
            // Filing a title or a note as a phrase would replace a whole
            // bank with it and then speak it at the wearer, so the file is
            // refused and the offending line is named.
            alert(`"${parsed.line}" sits above the first # section, so EdgeLoop cannot tell which cue it belongs to and nothing was imported. Put every phrase under a section header (# edge, # encourage, ...), or start the file with "// " to make that line a comment.`);
            return;
        }
        if (parsed.error || !parsed.cues || Object.keys(parsed.cues).length === 0) {
            alert('That file did not look like an EdgeLoop phrase list. Use Export phrases, a settings backup, or a text file with # edge / # encourage sections.');
            return;
        }
        // Start from what is on screen so phrase edits made before the import
        // are not lost, then let the file win for the cues it carries.
        const live = currentVoiceCues();
        advancedSettings.voiceCues = applyImportedCues(live.cues, parsed.cues);
        const nextEncourage = parsed.encourageSeconds ?? live.encourageSeconds;
        const timerChanged = nextEncourage !== live.encourageSeconds;
        advancedSettings.voiceEncourageSeconds = nextEncourage;
        renderVoiceCueEditor();
        // What was really written, not how many keys the file had: a value
        // that is not a list of lines keeps the bank, so it is neither
        // imported nor muted.
        alert(voiceImportAlert(describeImport(parsed.cues), { saved: persistSettings(), timerChanged }));
    };
    reader.readAsText(file);
    e.target.value = '';
});

// Live from the moment it is picked, as it always was, and now saved then too:
// a reload used to forget the voice unless Apply happened to run.
document.getElementById('paramVoiceSelect')?.addEventListener('change', (e) => {
    advancedSettings.voiceURI = e.target.value;
    persistSettings();
    if (resolveSpeechVoice(listSpeechVoices(), advancedSettings.voiceURI).status !== 'missing') {
        hideAlertBanner('voice-choice');
    }
    renderVoiceState();
});

// Endgame selection inside Session Setup
const paramEndgameCards = document.querySelectorAll('.param-endgame-card');
// Also used to paint the restored Endgame Trigger on boot (syncParamsUI).
function highlightEndgameCard(type) {
    paramEndgameCards.forEach(c => {
        const bold = c.querySelector('.font-bold');
        if (c.getAttribute('data-endgame') === type) {
            c.className = "param-endgame-card p-1.5 rounded-lg bg-purple-950/30 border border-purple-800 text-left transition cursor-pointer";
            if (bold) bold.className = "font-bold text-[10px] text-purple-300";
        } else {
            c.className = "param-endgame-card p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-left transition cursor-pointer";
            if (bold) bold.className = "font-bold text-[10px] text-slate-300";
        }
    });
}
paramEndgameCards.forEach(card => {
    card.addEventListener('click', () => {
        state.endgameType = card.getAttribute('data-endgame');
        highlightEndgameCard(state.endgameType);
        persistSessionLimits(true);
    });
});

// Browsers only grant the microphone (and an unmuted AudioContext) inside a
// user gesture, so a persisted mic setting is never started on load: the
// cockpit shows a "Tap to re-enable microphone" control instead.
const micReenableBtn = document.getElementById('micReenableBtn');
function showMicReenable(visible) {
    micReenableBtn?.classList.toggle('hidden', !visible);
}
micReenableBtn?.addEventListener('click', () => { applyMicSetting(true); });

// The report that the microphone stopped, and the control that offers it
// back, are over once the session's microphone listens again or the wearer
// settles on none (Session Setup applied with it off). Nothing but this
// source takes that report down: left up, it went on telling the wearer the
// microphone was gone while it was listening.
function settleMicReport() {
    showMicReenable(false);
    hideAlertBanner('mic');
}

// Must run from a click handler (see startMicMonitor).
async function applyMicSetting(enabled) {
    advancedSettings.micEnabled = Boolean(enabled);
    const badge = document.getElementById('micActiveBadge');
    showMicReenable(false);
    if (!enabled) {
        stopMicMonitor(state);
        state.isTestingMic = false;
        badge?.classList.add('hidden');
        clearMicBoost(state);
        paintMicMeter(0);
        settleMicReport();
        return;
    }
    try {
        await startMicMonitor(state, { onLost: handleMicLost });
        badge?.classList.remove('hidden');
        paintMicMeter(0);
        startMicMeterLoop();
        // Only while the monitor is still live: a track that died during the
        // start has already reported again, and that report is true.
        if (state.micAnalyser) settleMicReport();
    } catch (e) {
        advancedSettings.micEnabled = false;
        const toggle = document.getElementById('paramMicToggle');
        if (toggle) toggle.checked = false;
        badge?.classList.add('hidden');
        alert('Microphone permission denied or unavailable in this browser.');
    }
}

// Slider values are a PREVIEW for the meter and only while Session Setup
// is on screen. Dismissing the modal without Apply leaves the dragged
// value in the DOM, and the engine must never see it.
function paramsModalOpen() {
    // closeModal() hides the overlay and leaves the modal body as it was,
    // so the body's own class is not evidence that Setup is on screen.
    if (!overlay || overlay.classList.contains('hidden')) return false;
    return Boolean(modals.Params) && !modals.Params.classList.contains('hidden');
}

function liveMicGate() {
    const fromSlider = paramsModalOpen() ? document.getElementById('micGateInput')?.value : null;
    if (fromSlider !== undefined && fromSlider !== null && fromSlider !== '') {
        return clampMicGate(fromSlider);
    }
    return clampMicGate(advancedSettings.micSensitivityThreshold);
}

function liveMicBoostCap() {
    const fromSlider = paramsModalOpen() ? document.getElementById('micBoostBpmInput')?.value : null;
    if (fromSlider !== undefined && fromSlider !== null && fromSlider !== '') {
        return clampMicBoostBpm(fromSlider);
    }
    return clampMicBoostBpm(advancedSettings.micBoostMaxBpm);
}

function paintMicMeter(level) {
    const bar = document.getElementById('micLevelBar');
    const label = document.getElementById('micLevelLabel');
    const badge = document.getElementById('micActiveBadge');
    const gate = liveMicGate();
    const cap = liveMicBoostCap();
    const value = Number.isFinite(level) ? Math.max(0, Math.min(100, level)) : 0;
    const boost = micBoostFromLevel(value, gate, cap);
    const gated = value >= gate;
    if (bar) {
        bar.style.width = `${value}%`;
        bar.className = `h-full transition-[width] duration-75 ${gated ? 'bg-emerald-400' : 'bg-slate-600'}`;
    }
    if (label) {
        if (!state.micAnalyser) {
            label.textContent = 'Tap Test, then make noise. Toys should stay below the gate.';
            label.className = 'text-[9px] font-mono text-slate-500';
        } else if (boost > 0) {
            label.textContent = `Voice ${value} — +${boost} BPM toward the edge (max ${cap}).`;
            label.className = 'text-[9px] font-mono text-rose-300';
        } else if (gated) {
            label.textContent = `Voice ${value} — above gate ${gate}, extra BPM is 0.`;
            label.className = 'text-[9px] font-mono text-emerald-300';
        } else {
            label.textContent = `Level ${value} — below gate ${gate}. Toys/noise ignored.`;
            label.className = 'text-[9px] font-mono text-slate-400';
        }
    }
    // The meter only paints. state.micBoost is owned by the once-a-second
    // session tick, so a ~60 Hz animation frame can never re-enter the
    // engine or move the toys between heart-rate readings.

    // The badge reports what updateEngine actually added, never this
    // meter's own preview: the meter repaints ~60 times a second and would
    // otherwise claim a push the engine is suppressing.
    const applied = Number.isFinite(state.micApplied) ? state.micApplied : 0;
    if (badge && (advancedSettings.micEnabled || state.isTestingMic) && state.micAnalyser) {
        badge.classList.remove('hidden');
        if (applied > 0) {
            badge.textContent = `MIC +${applied}`;
            badge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-950/80 border border-rose-700 text-rose-300 ml-1';
        } else {
            badge.textContent = 'MIC LISTEN';
            badge.className = 'text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-950/80 border border-emerald-700 text-emerald-300 ml-1';
        }
    } else if (badge) {
        // Test microphone with the toggle off used to leave MIC LISTEN lit
        // on the cockpit for the rest of the session.
        badge.classList.add('hidden');
    }
    renderMicProcessingNote();
}

// Tell the wearer when the browser refused to switch its audio processing
// off: their gate is then calibrated against a signal the browser is
// already flattening, which means something different.
function renderMicProcessingNote() {
    const note = document.getElementById('micProcessingNote');
    if (!note) return;
    const report = state.micProcessing;
    if (!state.micAnalyser || !report || report.clean) {
        note.classList.add('hidden');
        note.textContent = '';
        return;
    }
    note.textContent = report.message;
    note.classList.remove('hidden');
}

// A microphone that goes away mid-session is reported, never swallowed.
function handleMicLost(message) {
    advancedSettings.micEnabled = false;
    const toggle = document.getElementById('paramMicToggle');
    if (toggle) toggle.checked = false;
    document.getElementById('micActiveBadge')?.classList.add('hidden');
    state.isTestingMic = false;
    clearMicBoost(state);
    paintMicMeter(0);
    showMicReenable(true);
    // An advisory: nothing is moving because of this. It must never replace a
    // safety report (a motor that may still be running, a lost pulse) that is
    // already on the banner - it is appended to it instead.
    showAlertBanner(message, { severity: 'advisory', source: 'mic' });
}

function startMicMeterLoop() {
    if (state.micAnimId) cancelAnimationFrame(state.micAnimId);
    const tick = () => {
        paintMicMeter(sampleMicLevel(state));
        state.micAnimId = requestAnimationFrame(tick);
    };
    tick();
}

// `ceiling` is the one updateEngine has just handed the engine; the input
// handlers pass none and have it worked out here by the same function. The
// engine tick repaints this line too: painted only when Session Setup opened
// or the field was edited, it went on quoting the ceiling of that moment
// while the modal stayed open over a running session - a toy dropping out
// ends dual-stim dampening and raises the real mark by 15 BPM, and the line
// kept promising the lower one.
function updateEdgeHoldPreview(ceiling = null) {
    const preview = document.getElementById('edgeHoldPreview');
    if (!preview) return;
    let working = ceiling;
    if (!working) {
        const limits = readHrLimits();
        working = workingCeiling(limits.minHr, limits.maxHr);
    }
    // The percentage applies to the WORKING ceiling, which is what the
    // engine, the HOLD TO badge and the guards use. Previewing it against
    // the typed Climax HR promised a mark the session never pulls back at
    // (dual-stim dampening and decay are on by default).
    const pct = clampEdgeHoldPercent(document.getElementById('edgeHoldPercentInput')?.value);
    const text = describeEdgeHoldPreview({
        typedMaxHr: working.typedMaxHr,
        workingMaxHr: working.maxHr,
        minHr: working.minHr,
        holdPercent: pct
    });
    if (preview.textContent !== text) preview.textContent = text;
}

document.getElementById('edgeHoldPercentInput')?.addEventListener('input', () => updateEdgeHoldPreview());

document.getElementById('paramMicTestBtn')?.addEventListener('click', async () => {
    try {
        state.isTestingMic = true;
        await startMicMonitor(state, { onLost: handleMicLost });
        document.getElementById('micActiveBadge')?.classList.remove('hidden');
        paintMicMeter(0);
        startMicMeterLoop();
    } catch (e) {
        state.isTestingMic = false;
        paintMicMeter(0);
        alert('Microphone permission denied or unavailable in this browser.');
    }
});

document.getElementById('micGateInput')?.addEventListener('input', (e) => {
    const gate = clampMicGate(e.target.value);
    const disp = document.getElementById('micGateValue');
    if (disp) disp.textContent = String(gate);
    paintMicMeter(sampleMicLevel(state));
});

document.getElementById('micBoostBpmInput')?.addEventListener('input', (e) => {
    const cap = clampMicBoostBpm(e.target.value);
    const disp = document.getElementById('micBoostBpmValue');
    if (disp) disp.textContent = String(cap);
    paintMicMeter(sampleMicLevel(state));
});

// Apply Session Setup
document.getElementById('applyParamsBtn')?.addEventListener('click', async () => {
    advancedSettings.stallGuard = document.getElementById('stallGuardToggle')?.checked ?? true;
    advancedSettings.stallGuardSeconds = clampStallGuardSeconds(document.getElementById('stallGuardSecondsInput')?.value);
    advancedSettings.stallPauseSeconds = clampStallPauseSeconds(document.getElementById('stallPauseSecondsInput')?.value);
    // Takes hold of a run already under way: one that has gone past a limit
    // lowered here lands on the next tick.
    advancedSettings.forceOrgasmMaxSeconds = resolveForceOrgasmMaxSeconds(document.getElementById('forceOrgasmMaxSelect')?.value);
    advancedSettings.ceilingBehaviour = document.getElementById('ceilingBehaviourSelect')?.value === 'stop' ? 'stop' : 'crawl';
    advancedSettings.edgeHoldPercent = clampEdgeHoldPercent(document.getElementById('edgeHoldPercentInput')?.value);
    advancedSettings.dualDampening = document.getElementById('dualDampeningToggle')?.checked ?? true;
    advancedSettings.dualDampeningBpm = parseInt(document.getElementById('dualDampeningOffsetInput')?.value, 10) || 15;
    advancedSettings.adaptiveDecay = document.getElementById('adaptiveDecayToggle')?.checked ?? true;
    advancedSettings.decayEdgeCount = parseInt(document.getElementById('decayEdgeCountInput')?.value, 10) || 2;
    advancedSettings.decayBpm = parseInt(document.getElementById('decayBpmInput')?.value, 10) || 2;
    advancedSettings.decayFloor = parseInt(document.getElementById('decayFloorInput')?.value, 10) || 105;
    advancedSettings.hrStaleSeconds = clampStaleSeconds(document.getElementById('hrStaleSecondsInput')?.value);
    advancedSettings.hrAutoResume = document.getElementById('hrAutoResumeToggle')?.checked ?? true;
    syncWatchdogSettings();
    const warmupParsed = parseInt(document.getElementById('warmupInput')?.value, 10);
    advancedSettings.warmupMinutes = Number.isFinite(warmupParsed) ? warmupParsed : 5;
    // Already live from the switch itself; Apply commits the same value
    // through the same rule (silence at once when it is off).
    setVoiceEnabled(document.getElementById('paramVoiceToggle')?.checked ?? false);
    advancedSettings.voiceURI = document.getElementById('paramVoiceSelect')?.value || '';
    const voiceForm = currentVoiceCues();
    advancedSettings.voiceCues = voiceForm.cues;
    advancedSettings.voiceEncourageSeconds = voiceForm.encourageSeconds;
    const micOn = document.getElementById('paramMicToggle')?.checked ?? false;
    advancedSettings.micSensitivityThreshold = clampMicGate(document.getElementById('micGateInput')?.value);
    advancedSettings.micBoostMaxBpm = clampMicBoostBpm(document.getElementById('micBoostBpmInput')?.value);
    syncGuardSettings();
    const micWasOn = Boolean(state.micAnalyser);
    // Only (re)start the monitor when the setting changed: the button click
    // that submits the form is the user gesture the microphone needs.
    if (micOn !== micWasOn) {
        await applyMicSetting(micOn);
    } else {
        advancedSettings.micEnabled = micOn;
        // Ticked while Test microphone had it running, that monitor goes on
        // as the session's and the microphone is listening again; left off,
        // the wearer has settled on none. The report is over either way.
        settleMicReport();
    }
    paintIdlePrompt();

    persistSettings();
    closeModal();
    updateEngine();
    syncTelemetry();
});

// A <label> wrapping a display:none file input is not in the tab order and
// answers no key, so Import could only be reached with a mouse. The labels
// carry role="button" and tabindex="0" in the markup; this opens the picker
// on Enter and Space, which is what a button does.
document.querySelectorAll('[data-file-label]').forEach((label) => {
    label.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        e.preventDefault();
        document.getElementById(label.dataset.fileLabel)?.click();
    });
});

// Export & Import Settings. The file shape, every clamp on the way in and
// every sentence the user reads live in backup.js; this side only reads the
// stores, offers the file and routes each restored piece home.
function paintExportNotice(notice) {
    const el = document.getElementById('exportKeyNotice');
    if (!el) return;
    el.textContent = notice.message;
    el.className = `text-[9px] leading-snug ${notice.tone === 'warn' ? 'text-rose-300' : 'text-slate-400'}`;
}

document.getElementById('exportSettingsBtn')?.addEventListener('click', () => {
    // The panel promises the phrase lists, so export what the Audio & Mic tab
    // currently shows (a backup is a copy, so this commits nothing).
    const live = currentVoiceCues();
    const includeKey = document.getElementById('exportIncludeKey')?.checked === true;
    const savedKey = safeGet('handy_connection_key', '') || '';
    const savedToken = safeGet(VACUGLIDE_TOKEN_STORAGE_KEY, '') || '';
    const file = buildBackup({
        settings: { ...advancedSettings, voiceCues: live.cues, voiceEncourageSeconds: live.encourageSeconds },
        handyRole: state.handyRole,
        handyMaxCap: state.handyMaxCap,
        handyConnectionKey: savedKey,
        vacuglideDeviceToken: savedToken,
        intifaceDevices: safeParse(INTIFACE_STORAGE_KEY, {}),
        tcodeDevices: safeParse(TCODE_STORAGE_KEY, {}),
        ageVerified: safeGet('edgeloop_age_verified') === 'true',
        wizardSeen: safeGet('edgeloop_wizard_seen') === 'true'
    }, { includeKey });
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = backupFilename(file);
    // Painted before the download starts, so "this file CONTAINS your key"
    // is on screen (and announced, the notice is a live region) by the time
    // the save dialog asks where to put it - not after it is already on disk.
    paintExportNotice(describeBackupExport(file, {
        requestedKey: includeKey,
        hasSavedKey: savedKey.trim().length > 0,
        hasSavedToken: savedToken.trim().length > 0
    }));
    try {
        a.click();
    } catch (err) {
        // The notice is painted first so the key warning is announced
        // before the file exists; if the download never starts, the claim
        // that it did must not be left on screen.
        paintExportNotice({ tone: 'warn', message: 'The download did not start, so nothing was written. Your browser may be blocking downloads from this page.' });
    } finally {
        URL.revokeObjectURL(url);
    }
});

// Everything an import restores that does not live in advancedSettings. A
// file that carries no key never clears the one saved here: restoring
// settings on a paired machine must not break that pairing. Nothing here
// connects anything - that stays behind the user's own click.
// Returns what the browser refused to save and what the merge had to drop,
// so the import can say so instead of announcing a restore that a reload
// undoes. safeSet reports whether the write landed; a full or blocked store
// is a live condition here, since session history is what fills it.
function applyImportedBackup(result) {
    const unsaved = [];
    if (result.keyPresent) {
        if (!safeSet('handy_connection_key', result.handyConnectionKey)) unsaved.push('key');
        const input = document.getElementById('modalHandyInput');
        if (input) input.value = result.handyConnectionKey;
    }
    if (result.tokenPresent) {
        if (!safeSet(VACUGLIDE_TOKEN_STORAGE_KEY, result.vacuglideDeviceToken)) unsaved.push('token');
        const input = document.getElementById('modalVacuglideInput');
        if (input) input.value = result.vacuglideDeviceToken;
    }
    if (result.handy.role) {
        // The role buttons own the badge and the button painting, so the
        // restored role is applied the way a tap applies it. The write
        // itself happens inside that handler, so it is verified by reading
        // it back: the role is the setting whose loss is worst of all,
        // because boot writes `primary` over a missing one and hands back a
        // live channel the user did not choose.
        const btnId = { primary: 'handyRolePrimaryBtn', secondary: 'handyRoleSecondaryBtn', off: 'handyRoleOffBtn' }[result.handy.role];
        document.getElementById(btnId)?.click();
        if (safeGet('handy_role', '') !== result.handy.role) unsaved.push('role');
    }
    if (result.handy.maxCap !== null) {
        state.handyMaxCap = result.handy.maxCap;
        if (!safeSet('handy_max_cap', String(result.handy.maxCap))) unsaved.push('cap');
        const slider = document.getElementById('handyCapSlider');
        const capVal = document.getElementById('handyCapVal');
        if (slider) slider.value = String(result.handy.maxCap);
        if (capVal) capVal.textContent = `${result.handy.maxCap}%`;
    }
    let droppedDeviceMaps = 0;
    if (Object.keys(result.devices.intiface).length) {
        const existing = safeParse(INTIFACE_STORAGE_KEY, {});
        droppedDeviceMaps += countDroppedOnMerge(existing, result.devices.intiface);
        if (!safeSet(INTIFACE_STORAGE_KEY, mergeDeviceMaps(existing, result.devices.intiface))) unsaved.push('intiface');
    }
    if (Object.keys(result.devices.tcode).length) {
        const existing = safeParse(TCODE_STORAGE_KEY, {});
        droppedDeviceMaps += countDroppedOnMerge(existing, result.devices.tcode);
        if (!safeSet(TCODE_STORAGE_KEY, mergeDeviceMaps(existing, result.devices.tcode))) unsaved.push('tcode');
    }
    // Only ever set: a file that never passed the age gate must not put the
    // overlay back in front of someone who did.
    let flagsRefused = false;
    if (result.flags.ageVerified && !safeSet('edgeloop_age_verified', 'true')) flagsRefused = true;
    if (result.flags.wizardSeen && !safeSet('edgeloop_wizard_seen', 'true')) flagsRefused = true;
    if (flagsRefused) unsaved.push('flags');
    return { unsaved, droppedDeviceMaps };
}

// How many of the file's Session Setup values are still what the file said
// once the app's own clamps have run. A pair like minHr 5 / maxHr 9999 is
// refused by sanitizeSessionLimits and comes back at the factory numbers,
// and "2 values imported" over two defaults is a count of nothing.
// Key order is not a difference: a backup re-serialised by any tool (jq -S,
// json.dump(sort_keys=True)) has the same values in another order, and
// reporting that as "outside what this app accepts" would be nonsense.
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((out, key) => { out[key] = canonical(value[key]); return out; }, {});
    }
    return value;
}
const sameValue = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// The VacuGlide's values are named on their own by describeBackupImport,
// with their values, so they are not counted among the Session Setup ones.
function countStoredSettings(fileSettings) {
    let kept = 0;
    for (const [name, value] of Object.entries(fileSettings)) {
        if (VACUGLIDE_SETTING_NAMES.includes(name)) continue;
        if (name === 'voiceCues') {
            // mergeVoiceCues fills in every bank the file did not mention,
            // so only the banks the file DID carry can be compared. A
            // voiceCues that is not an object at all carries no bank and
            // restored nothing; `[].every()` is true, so it has to be
            // rejected before the comparison, not by it.
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            const banks = Object.keys(value);
            // `[].every()` is true, so an empty cue object would count as a
            // restored value while restoring nothing.
            if (!banks.length) continue;
            const live = advancedSettings.voiceCues || {};
            if (banks.every((bank) => sameValue(live[bank], value[bank]))) kept += 1;
            continue;
        }
        if (sameValue(advancedSettings[name], value)) kept += 1;
    }
    return kept;
}

document.getElementById('importConfigFile')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // A restore reaches the motors: it writes the Handy speed cap, sets the
    // channel role, rewrites the stroke envelope and ticks the engine on the
    // same pass. Picking the file is the commit - there is no preview and no
    // undo - so it is not something to do to a session in progress. Measured
    // before this guard: importing a legitimate backup at 120 BPM took both
    // channels from 48% to 100% between one tick and the next.
    if (state.sessionStatus !== 'IDLE') {
        alert('Stop the session first. Restoring a backup changes the Handy speed cap, the channel roles and the stroke range, and those reach the toys the moment the file is read - not something to do mid-session.');
        e.target.value = '';
        return;
    }
    const reader = new FileReader();
    // A file that vanishes or loses its permission between the pick and the
    // read fires `error`, not `load`. Without this the button does nothing
    // at all, which reads as "the app ignored me".
    reader.onerror = () => alert('That file could not be read. Nothing was changed.');
    reader.onload = (evt) => {
        let parsed;
        try {
            parsed = JSON.parse(evt.target.result);
        } catch {
            // Picking the wrong file is the common mistake, so name that
            // case instead of reporting it as a bad backup.
            alert('That file is not JSON, so it is not an EdgeLoop backup. Pick the .json the Backup tab writes with Export.');
            return;
        }
        try {
            const result = readBackup(parsed);
            // describeBackupImport says which way the file is wrong.
            if (!result.ok) { alert(describeBackupImport(result)); return; }
            const existingKey = safeGet('handy_connection_key', '') || '';
            const hadExistingKey = Boolean(existingKey);
            const keyReplaced = result.keyPresent && hadExistingKey && existingKey !== result.handyConnectionKey;
            const existingToken = safeGet(VACUGLIDE_TOKEN_STORAGE_KEY, '') || '';
            const hadExistingToken = Boolean(existingToken);
            const tokenReplaced = result.tokenPresent && hadExistingToken && existingToken !== result.vacuglideDeviceToken;
            // An older build merged every unknown top-level field into the
            // settings store, so a connection key could be sitting in there
            // and ride along in every future export. Clear those names out
            // before merging, and never let the file add one back.
            pruneReservedKeys(advancedSettings);
            // What the store held before the merge, so the message can say
            // whether anything actually changed rather than inferring it
            // from how many values came through untouched.
            const settingsBefore = JSON.stringify(advancedSettings);
            // The VacuGlide's values as they were, so the message can say
            // which ones this file changed.
            const vacuglideBefore = Object.fromEntries(VACUGLIDE_SETTING_NAMES.map((name) => [name, advancedSettings[name]]));
            Object.assign(advancedSettings, result.settings);
            syncHwEnvelopeInputs();
            syncWatchdogSettings();
            syncGuardSettings();
            // Counted after the clamps, before the write, so the number the
            // user reads is the number that is actually in the store.
            // One comparison: what the file ASKED for against what the
            // store ended up with. A value the app corrected does not match
            // and is reported as corrected, with no second list to keep in
            // step with this one.
            const settingsStored = countStoredSettings(result.requested);
            // Refusals are reported by part name (see RESTORE_PARTS), so the
            // message cannot name a part as lost and as restored at once.
            const unsaved = persistSettings() ? [] : ['settings'];
            syncParamsUI();
            // The VacuGlide's role, cap and pulse length are settings too,
            // and its panel shows them.
            syncVacuglidePanel();
            // Before the engine tick, so a restored Handy speed cap reaches
            // the device on the same pass as the settings it came with.
            const applied = applyImportedBackup(result);
            // Repaints the learning line and ticks the engine, so the panel
            // agrees with the offset the engine has just been handed.
            renderLearningStatus();
            alert(describeBackupImport(result, {
                hadExistingKey,
                keyReplaced,
                hadExistingToken,
                tokenReplaced,
                settingsStored,
                settingsChanged: JSON.stringify(advancedSettings) !== settingsBefore,
                // The numbers themselves, so "the Handy speed cap" does not
                // leave the reader opening the Handy panel to find out what
                // it now is.
                handyCap: result.handy.maxCap,
                handyRole: result.handy.role,
                vacuglideBefore,
                droppedDeviceMaps: applied.droppedDeviceMaps,
                unsaved: [...unsaved, ...applied.unsaved]
            }));
        } catch (err) {
            alert(`This backup could not be applied: ${err && err.message ? err.message : 'unknown error'}.`);
        }
    };
    reader.readAsText(file);
    // A file input fires no change event for the same file twice: clear it
    // so importing the same backup again (to revert edits) works.
    e.target.value = '';
});

// Partner Tab Switcher
const partnerTab1on1Btn = document.getElementById('partnerTab1on1Btn');
const partnerTabGroupBtn = document.getElementById('partnerTabGroupBtn');
const partner1on1Section = document.getElementById('partner1on1Section');
const partnerGroupSection = document.getElementById('partnerGroupSection');

partnerTab1on1Btn?.addEventListener('click', () => {
    partnerTab1on1Btn.className = "flex-1 py-1.5 rounded-lg bg-purple-600 text-white transition cursor-pointer";
    if (partnerTabGroupBtn) partnerTabGroupBtn.className = "flex-1 py-1.5 rounded-lg text-slate-400 hover:text-white transition cursor-pointer";
    partner1on1Section?.classList.remove('hidden');
    partnerGroupSection?.classList.add('hidden');
});

partnerTabGroupBtn?.addEventListener('click', () => {
    partnerTabGroupBtn.className = "flex-1 py-1.5 rounded-lg bg-purple-600 text-white transition cursor-pointer";
    if (partnerTab1on1Btn) partnerTab1on1Btn.className = "flex-1 py-1.5 rounded-lg text-slate-400 hover:text-white transition cursor-pointer";
    partnerGroupSection?.classList.remove('hidden');
    partner1on1Section?.classList.add('hidden');
});

// BLE modal "Status:" line. tone: 'idle' | 'busy' | 'ok' | 'error'. `help`
// ({ title, items }, from describeBleError) is listed under the line; every
// other status clears it, so the reasons a chooser came back empty never
// linger beside "Scanning" or "Connected".
function setBleStatus(text, tone = 'idle', help = null) {
    const el = document.getElementById('modalBleMsg');
    if (!el) return;
    el.textContent = `Status: ${text}`;
    const toneClass = tone === 'ok' ? 'text-emerald-400'
        : tone === 'error' ? 'text-rose-400'
        : tone === 'busy' ? 'text-amber-300'
        : 'text-slate-500';
    el.className = `text-xs leading-snug ${toneClass}`;
    const items = help && Array.isArray(help.items) ? help.items : [];
    const box = document.getElementById('modalBleHelp');
    const title = document.getElementById('modalBleHelpTitle');
    const list = document.getElementById('modalBleHelpList');
    if (title) title.textContent = items.length > 0 ? String(help.title || '') : '';
    list?.replaceChildren(...items.map((line) => {
        const item = document.createElement('li');
        item.textContent = line;
        return item;
    }));
    box?.classList.toggle('hidden', items.length === 0);
}

function bleBatteryLabel() {
    return state.bleBattery !== null && state.bleBattery !== undefined ? `🔋 ${state.bleBattery}%` : null;
}

function bleBadgeName() {
    return state.hrDeviceName ? state.hrDeviceName.split(' ')[0] : 'HR Monitor';
}

// Tell the user why Web Bluetooth is missing instead of a silent failure.
function warnBluetoothUnsupported() {
    if (navigator.bluetooth) return false;
    setBleStatus(describeBluetoothSupport(navigator.userAgent), 'error');
    // The modal status line explains it; the card keeps the source in use.
    if (!state.simEngaged) setBadgeState('Ble', 'disconnected', 'Unsupported');
    return true;
}

// BLE Hardware Scanning
document.getElementById('modalBleScanBtn')?.addEventListener('click', async () => {
    if (warnBluetoothUnsupported()) return;
    try {
        setBadgeState('Ble', 'connecting', 'Scanning...');
        setBleStatus('Pick your sensor in the browser chooser...', 'busy');
        // The edge readings start again with this sensor's first packet. Its
        // notifications can arrive before the connect below has finished
        // (the battery is read after them), while the simulator may still be
        // the engaged source, so clearing the list once the connect returns
        // could pair a slider value with a strap reading.
        let firstPacket = true;
        const dev = await connectBleHeartRate({
            onHrMeasurement: (bpm, info) => {
                if (firstPacket) {
                    firstPacket = false;
                    edgeReadings = [];
                }
                recordHrReading(bpm, info ? info.sensorContact : null);
            },
            onBatteryLevel: (bat) => {
                state.bleBattery = bat;
                const batEl = document.getElementById('modalBleBatteryDisplay');
                if (batEl) {
                    batEl.textContent = `Battery: ${bat}%`;
                    batEl.classList.remove('hidden');
                }
                if (isBleConnected()) setBadgeState('Ble', 'connected', bleBadgeName(), bleBatteryLabel());
            },
            onReconnecting: (attempt, maxAttempts) => {
                setBadgeState('Ble', 'connecting', `Reconnecting ${attempt}/${maxAttempts}...`);
                setBleStatus(`Link dropped, reconnecting (attempt ${attempt} of ${maxAttempts})...`, 'busy');
            },
            onReconnected: () => {
                setBadgeState('Ble', 'connected', bleBadgeName(), bleBatteryLabel());
                setBleStatus(`Reconnected to ${state.hrDeviceName || 'the sensor'}.`, 'ok');
            },
            onDisconnected: ({ intentional, attempts }) => {
                const name = state.hrDeviceName || 'Heart-rate monitor';
                state.bleBattery = null;
                setBadgeState('Ble', 'disconnected', intentional ? 'Disconnected' : 'Lost');
                setBleStatus(intentional ? 'Disconnected.' : `${name} dropped and did not answer ${attempts} reconnect attempts.`, intentional ? 'idle' : 'error');
                document.getElementById('modalBleDisconnectBtn')?.classList.add('hidden');
                document.getElementById('modalBleBatteryDisplay')?.classList.add('hidden');
                const devName = document.getElementById('modalBleDeviceName');
                if (devName) devName.textContent = 'No device paired';
                document.getElementById('hrContactHint')?.classList.add('hidden');
                state.hrNoContact = false;
                if (!state.simEngaged) document.getElementById('hrWarningTag')?.classList.remove('hidden');
                const sessionLive = state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN';
                if (intentional) {
                    if (sessionLive) triggerDisconnectAlert(`${name} (heart-rate monitor) was disconnected.`, 'hrMonitor', { motorsPaused: true });
                } else {
                    const silentMs = Math.max(0, Date.now() - (hrWatchdog.lastValidAt || Date.now()));
                    triggerDisconnectAlert(`${name} (heart-rate monitor) dropped and did not answer ${attempts} reconnect attempts; no reading for ${Math.round(silentMs / 1000)} s.`, 'hrMonitor', { motorsPaused: true });
                    // A drop is a signal loss too: once the sensor is paired
                    // again and readings return, the session may auto-resume.
                    if (sessionLive && state.sessionStatus === 'PAUSED') {
                        state.hrSignalPaused = true;
                        state.hrSignalState = 'stale';
                        state.hrSignalSilentMs = silentMs;
                        renderHrSignal({ status: 'stale', noContact: false, sinceValidMs: silentMs });
                    }
                }
                syncTelemetry();
            }
        });

        state.hrDeviceName = dev.name || 'Bluetooth HR Monitor';
        const devName = document.getElementById('modalBleDeviceName');
        if (devName) devName.textContent = state.hrDeviceName;
        document.getElementById('modalBleDisconnectBtn')?.classList.remove('hidden');
        setBadgeState('Ble', 'connected', bleBadgeName(), bleBatteryLabel());
        setBleStatus(`Connected to ${state.hrDeviceName}.`, 'ok');
        document.getElementById('hrWarningTag')?.classList.add('hidden');
        document.getElementById('simActiveTag')?.classList.add('hidden');
        state.simEngaged = false;
        // A pulse source is linked again, so the report that the last one
        // was lost is over. What the session does next is the watchdog's:
        // it stays paused until RESUME, or until auto-resume sees a reading.
        hideAlertBanner('hrMonitor');
        // Fresh grace window: the first packet may take a few seconds.
        hrWatchdog.reset(Date.now());
        state.hrNoContact = false;
        document.getElementById('hrContactHint')?.classList.add('hidden');
        closeModal();
        checkReadiness();
        syncTelemetry();
    } catch (e) {
        const described = describeBleError(e);
        setBleStatus(described.message, described.kind === 'cancelled' ? 'idle' : 'error', described.help);
        if (isBleConnected()) {
            // The chooser was closed before anything changed: the previous
            // sensor is still linked and keeps its badge.
            setBadgeState('Ble', 'connected', bleBadgeName(), bleBatteryLabel());
        } else {
            // A re-scan drops the previous link before subscribing to the new
            // sensor, so a failure here leaves no pulse source at all, unless
            // the simulator is engaged and keeps driving the session.
            if (state.simEngaged) setBadgeState('Ble', 'connected', 'Simulator', null);
            else setBadgeState('Ble', 'disconnected', described.kind === 'cancelled' ? 'Disconnected' : 'Failed');
            document.getElementById('modalBleDisconnectBtn')?.classList.add('hidden');
            document.getElementById('modalBleBatteryDisplay')?.classList.add('hidden');
            const devName = document.getElementById('modalBleDeviceName');
            if (devName) devName.textContent = 'No device paired';
            if (!state.simEngaged) {
                document.getElementById('hrWarningTag')?.classList.remove('hidden');
                if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') {
                    triggerDisconnectAlert(`${state.hrDeviceName || 'Heart-rate monitor'} was released for a new pairing that failed (${described.message}).`, 'hrMonitor', { motorsPaused: true });
                }
            }
            checkReadiness();
            syncTelemetry();
        }
    }
});
document.getElementById('modalBleDisconnectBtn')?.addEventListener('click', () => disconnectBle());

// Manual Simulation
const modalSimSlider = document.getElementById('modalSimHrSlider');
const modalSimVal = document.getElementById('modalSimHrVal');
modalSimSlider?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    if (modalSimVal) modalSimVal.textContent = `${val} BPM`;
    if (state.simEngaged) recordHrReading(val, true);
});

document.getElementById('modalEngageSimBtn')?.addEventListener('click', () => {
    // A real sensor still linked would fight the slider: drop it quietly.
    disconnectBle({ silent: true });
    state.simEngaged = true;
    state.hrDeviceName = 'Simulator';
    // The simulator is the pulse source now: a monitor lost before it is
    // no longer what the session is waiting for.
    hideAlertBanner('hrMonitor');
    hrWatchdog.reset(Date.now());
    edgeReadings = [];
    renderHrSignal(null);
    // A session the watchdog paused stays paused: the slider's first sample
    // is not a returning pulse, the user presses RESUME when ready.
    if (state.hrSignalPaused) holdAfterSignalReturn();
    recordHrReading(parseInt(modalSimSlider?.value || 70, 10), true);
    document.getElementById('simActiveTag')?.classList.remove('hidden');
    document.getElementById('hrWarningTag')?.classList.add('hidden');
    document.getElementById('modalBleDisconnectBtn')?.classList.add('hidden');
    setBadgeState('Ble', 'connected', 'Simulator', null);
    closeModal();
    checkReadiness();
    updateEngine();
    syncTelemetry();
});

// The Handy Connection
const handyInput = document.getElementById('modalHandyInput');
if (handyInput) handyInput.value = safeGet('handy_connection_key', '') || '';
let handyConnectedLabel = 'The Handy';

// Modal "Status:" line. tone: 'idle' | 'busy' | 'ok' | 'error'
function setHandyStatus(text, tone = 'idle') {
    const el = document.getElementById('modalHandyMsg');
    if (!el) return;
    el.textContent = `Status: ${text}`;
    const toneClass = tone === 'ok' ? 'text-emerald-400'
        : tone === 'error' ? 'text-rose-400'
        : tone === 'busy' ? 'text-amber-300'
        : 'text-slate-500';
    el.className = `text-xs ${toneClass}`;
}

function handyBatteryLabel() {
    return state.handyBattery !== null && state.handyBattery !== undefined ? `🔋 ${state.handyBattery}%` : null;
}

// The Handy reports on the banner under two sources, because they end at
// different times: 'handyLink' for a link that is gone (offline, lost while
// reconnecting, disconnected), which is over once the Handy is connected
// again, and 'handyStop' for a stop the API never confirmed, which is over
// only once the device that owes it is accounted for. A Handy that went
// offline may still be moving, and one reported offline again must not take
// "may still be moving" off the banner with its own report.
//
// Every Handy that owes a confirmed stop, by the key the stop was sent to
// (handy-stop-report.js): the one connected now, one that was disconnected
// or replaced, one that went offline.
const handyStopReport = createHandyStopReport();

// Put what handyStopReport says on the banner. A stop that was not confirmed
// is a new report: like every safety report it pauses the session and stops
// every toy. A stop that was, or a session driving that Handy again, only
// takes the report down or, while another Handy still owes its stop, says
// what is left.
function reportOwedHandyStops({ fresh = false } = {}) {
    const sentence = handyStopReport.sentence();
    if (!sentence) hideAlertBanner('handyStop');
    else if (fresh) triggerDisconnectAlert(sentence, 'handyStop');
    else reviseAlertBanner(sentence, { severity: 'safety', source: 'handyStop' });
}

// A live session drives the Handy connected now, in the role it has now:
// asked at START and RESUME, and when the wearer gives it a role while the
// session runs (handy-stop-report.js).
function settleDrivenHandyStop() {
    if (handyStopReport.sessionDrives({ connected: handyConnected, key: getHandyKey(), role: state.handyRole })) reportOwedHandyStops();
}

setHandyHandlers({
    isSessionActive: () => state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN',
    onError: (message) => {
        if (!handyConnected) return;
        if (message) {
            const short = message.length > 70 ? `${message.slice(0, 67)}...` : message;
            setHandyStatus(`API error: ${short}`, 'error');
            setBadgeState('Handy', 'warning', 'API Error', handyBatteryLabel());
        } else {
            setHandyStatus(handyConnectedLabel, 'ok');
            setBadgeState('Handy', 'connected', 'The Handy', handyBatteryLabel());
        }
    },
    onOffline: (reason) => {
        state.handyBattery = null;
        setHandyStatus('Offline', 'error');
        setBadgeState('Handy', 'disconnected', 'Offline');
        document.getElementById('modalHandyDisconnectBtn')?.classList.add('hidden');
        // Pauses the session and issues a stop to every other toy. The
        // driver names what happened; a report it gave no reason for falls
        // back to saying the Handy went offline and the motors were paused.
        triggerDisconnectAlert(reason || 'The Handy went offline.', 'handyLink', { motorsPaused: !reason });
    },
    // Something the device told us that is worth reading and is not a fault.
    onNotice: (message) => {
        if (!handyConnected || !message) return;
        setHandyStatus(message, 'busy');
    },
    // Not gated on handyConnected: the Disconnect and offline paths drop the
    // link before their stop resolves, and an unconfirmed stop there is the
    // one thing the user must hear about.
    onStopUnconfirmed: (message, key) => {
        setHandyStatus(message, 'error');
        setBadgeState('Handy', handyConnected ? 'warning' : 'disconnected', 'Stop unconfirmed', handyConnected ? handyBatteryLabel() : null);
        handyStopReport.unconfirmed(key, message);
        reportOwedHandyStops({ fresh: true });
    },
    // Whoever sent it: a pause retried until it went through, Disconnect,
    // the background stop of an offline Handy, a reconnect stopping the old
    // device, or the stop that verifies a key being connected. The driver
    // says it only of a stop that brings that device's own record to rest,
    // so not while a start to that device is still on its way.
    onStopConfirmed: (key) => {
        if (handyStopReport.confirmed(key)) reportOwedHandyStops();
    }
});

// One connect at a time; a second click while a key is being verified is ignored.
let handyConnectInFlight = false;

document.getElementById('modalHandyConnectBtn')?.addEventListener('click', async () => {
    const key = handyInput?.value.trim() || '';
    if (!key) {
        setHandyStatus('Enter your Handy Connection Key first.', 'error');
        return;
    }
    if (handyConnectInFlight) return;
    handyConnectInFlight = true;
    safeSet('handy_connection_key', key);
    // A live link is only replaced once the new key has been verified and
    // the connected device has confirmed a stop (see connectHandy); until
    // then it keeps driving, and stopping, the toy.
    const wasConnected = handyConnected;
    setHandyStatus(wasConnected ? 'Verifying the key, then stopping the connected Handy...' : 'Connecting...', 'busy');
    setBadgeState('Handy', 'connecting', wasConnected ? 'Reconnecting...' : 'Connecting...');

    try {
        const result = await connectHandy(key);
        // Connecting sent this very device a stop and the API confirmed it:
        // whatever a crashed session left it doing is over, so no
        // crash-recovery stop is owed to it any more (crash-recovery.js),
        // and the next page to open neither sends one nor reports one.
        if (!isRemotePage) clearPendingCrashStop(key, crashStorage);
        state.handyBattery = result.battery;
        handyConnectedLabel = result.description ? `Connected (${result.description})` : 'Connected';
        setHandyStatus(handyConnectedLabel, 'ok');
        setBadgeState('Handy', 'connected', 'The Handy', handyBatteryLabel());
        withdrawStartRefusal();
        document.getElementById('modalHandyDisconnectBtn')?.classList.remove('hidden');
        // Connected: whatever said the link was gone is over. A stop this
        // key owed was settled already, by the stop that verified it
        // (onStopConfirmed), unless a start to it was still on its way: then
        // only by that start coming back having moved nothing, or by the
        // stop sent after it. Another key is another device, and one that
        // may still be moving stays reported. So does a Handy that went
        // offline and was still being sent stops: no round of them follows
        // this Connect, so the driver has reported its stop unconfirmed by
        // now (onStopUnconfirmed), unless the first round had already or
        // that Handy is known to be at rest.
        hideAlertBanner('handyLink');
        closeModal();
        syncTelemetry();
    } catch (e) {
        const message = e && e.message ? e.message : 'Connection failed';
        if (handyConnected) {
            // The new key was refused or the live device would not stop: the
            // previous link is untouched and still owns the toy.
            setHandyStatus(`${message} The current connection is unchanged.`, 'error');
            setBadgeState('Handy', 'connected', 'The Handy', handyBatteryLabel());
        } else {
            state.handyBattery = null;
            setHandyStatus(message, 'error');
            setBadgeState('Handy', 'disconnected', 'Offline');
            if (wasConnected) triggerDisconnectAlert('The Handy connection was lost while reconnecting.', 'handyLink', { motorsPaused: true });
        }
    } finally {
        handyConnectInFlight = false;
    }
});

document.getElementById('modalHandyDisconnectBtn')?.addEventListener('click', async () => {
    // The link drops at once; the verified stop it sends is awaited so the
    // modal can say whether the device confirmed it. The banner hears from
    // the driver either way: a stop that fails is reported for this key, and
    // one that is confirmed settles whatever this key still owed.
    const stopped = disconnectHandy();
    state.handyBattery = null;
    setHandyStatus('Stopping the device...', 'busy');
    setBadgeState('Handy', 'disconnected', 'Stopping...');
    document.getElementById('modalHandyDisconnectBtn')?.classList.add('hidden');
    triggerDisconnectAlert("The Handy disconnected.", 'handyLink');
    const ok = await stopped.catch(() => false);
    // Reconnected meanwhile: the new link owns the modal and the badge.
    if (handyConnected) return;
    if (ok) {
        setHandyStatus('Offline', 'idle');
        setBadgeState('Handy', 'disconnected', 'Disconnected');
    } else {
        setHandyStatus('Disconnected, but the stop was not confirmed: check that The Handy is not moving.', 'error');
        setBadgeState('Handy', 'disconnected', 'Stop unconfirmed');
    }
});

// The Autoblow VacuGlide 2 Connection. Speed only, from the channel its role
// names; the two valve buttons are the only thing that ever opens a valve.
const vacuglideInput = document.getElementById('modalVacuglideInput');
if (vacuglideInput) vacuglideInput.value = safeGet(VACUGLIDE_TOKEN_STORAGE_KEY, '') || '';
let vacuglideConnectedLabel = 'Connected';
let vacuglideConnectInFlight = false;

// Modal "Status:" line. tone: 'idle' | 'busy' | 'ok' | 'error'
function setVacuglideStatus(text, tone = 'idle') {
    const el = document.getElementById('modalVacuglideMsg');
    if (!el) return;
    el.textContent = `Status: ${text}`;
    const toneClass = tone === 'ok' ? 'text-emerald-400'
        : tone === 'error' ? 'text-rose-400'
        : tone === 'busy' ? 'text-amber-300'
        : 'text-slate-500';
    el.className = `text-xs leading-snug ${toneClass}`;
}

// The lock that tells every other page's crash recovery that this page has
// the VacuGlide connected and answers for it (crash-recovery.js
// holdVacuglideLink): held while the device is connected here, and let go
// of while the page is frozen - a frozen page runs nothing, so it answers
// for nothing until it is resumed, as with The Handy's driving lock.
function syncVacuglideLinkLock() {
    crashRecovery?.holdVacuglideLink(isVacuglideConnected() && !pageFrozen ? getVacuglideToken() : '');
}

// One device at a time: Connect while connected would have to take the link
// over from a device that may be running, so the panel offers Disconnect
// in its place until the link is gone. Every change of the link comes
// through here, and so does the lock above.
function paintVacuglideButtons() {
    const connected = isVacuglideConnected();
    syncVacuglideLinkLock();
    const connectBtn = document.getElementById('modalVacuglideConnectBtn');
    if (connectBtn) {
        connectBtn.classList.toggle('hidden', connected);
        connectBtn.disabled = vacuglideConnectInFlight;
        connectBtn.classList.toggle('opacity-50', vacuglideConnectInFlight);
        connectBtn.textContent = vacuglideConnectInFlight ? 'Connecting...' : 'Connect VacuGlide';
    }
    document.getElementById('modalVacuglideDisconnectBtn')?.classList.toggle('hidden', !connected);
    if (vacuglideInput) vacuglideInput.disabled = connected || vacuglideConnectInFlight;
}

const VALVE_BUTTONS = { plus: 'vacuglideValvePlusBtn', minus: 'vacuglideValveMinusBtn' };
const VALVE_LABELS = { plus: 'Valve +', minus: 'Valve −' };

// The valve buttons and the line above them follow the driver: usable only
// while connected and no pulse is running, so a press can never be queued
// behind another.
function renderVacuglideValves() {
    const connected = isVacuglideConnected();
    const running = getValvePulse();
    for (const [valve, id] of Object.entries(VALVE_BUTTONS)) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        const blocked = !connected || Boolean(running);
        btn.disabled = blocked;
        btn.setAttribute('aria-disabled', blocked ? 'true' : 'false');
        btn.classList.toggle('opacity-50', blocked && !(running && running.valve === valve));
        btn.classList.toggle('cursor-not-allowed', blocked);
        btn.classList.toggle('ring-2', Boolean(running && running.valve === valve));
        btn.classList.toggle('ring-amber-400', Boolean(running && running.valve === valve));
    }
    const el = document.getElementById('vacuglideValveState');
    if (!el) return;
    let text;
    let tone = 'text-teal-400';
    if (running) {
        const label = VALVE_LABELS[running.valve];
        text = running.stage === 'closing' ? `Closing ${label}...`
            : running.stage === 'opening' ? `Opening ${label}...`
            : `${label} open`;
        tone = 'text-amber-300';
    } else if (!connected) {
        text = 'Not connected';
        tone = 'text-slate-500';
    } else {
        const open = Object.keys(VALVE_BUTTONS).filter((valve) => isVacuglideValveOpen(valve));
        if (open.length) {
            text = `${open.map((valve) => VALVE_LABELS[valve]).join(' and ')} may still be open`;
            tone = 'text-rose-400';
        } else if (isVacuglideWatching()) {
            // Closed as far as anything has confirmed, but a press whose
            // open was never answered may still land: "Both valves closed"
            // would be a promise the driver cannot make yet. Short enough to
            // stay on one line beside the title on a 360 px phone.
            text = 'Watching for a late open';
            tone = 'text-amber-300';
        } else {
            text = 'Both valves closed';
        }
    }
    el.textContent = text;
    el.className = `font-mono text-[10px] font-bold ${tone}`;
}

function setVacuglideValveMessage(text, tone = 'idle') {
    const el = document.getElementById('vacuglideValveMsg');
    if (!el) return;
    el.textContent = text;
    el.className = `text-[10px] leading-snug ${tone === 'error' ? 'text-rose-400' : 'text-slate-400'}${text ? '' : ' hidden'}`;
}

// The VacuGlide reports on the banner under two sources, as The Handy does,
// because they end at different times: 'vacuglideLink' for a link that is
// gone (offline, disconnected), which is over once a VacuGlide is connected
// again, and 'vacuglideStop' for a stop or a valve close the device never
// confirmed, which is over once a whole stop of that very device has been
// confirmed (onStopConfirmed) - by the pause the report itself makes, the
// background stop, Disconnect, or connecting it again. Each device that owes
// one is its own entry, by its token: one device's confirmed stop must not
// take down the warning about another.
const vacuglideStopsOwed = new Map();
// What the panel's status line says while it reports an unconfirmed stop of
// the device `token`, with the badge "Stop unconfirmed" - and the badge the
// panel had before, to go back to - or null. A whole stop of that device
// confirmed later takes back exactly that line and that badge, and nothing
// another message has painted over them since (onStopConfirmed): after a
// lost link, the background stop's confirmation left "Stop unconfirmed" and
// "Stop not confirmed: ..." up beside a device at rest.
let vacuglidePanelOwed = null;
const VACUGLIDE_RESTING_BADGES = ['Offline', 'Device error', 'Disconnected'];

function noteVacuglidePanelOwed(token, status) {
    const badge = (document.getElementById('badgeVacuglideText')?.textContent || '').trim();
    const before = badge === 'Stop unconfirmed' && vacuglidePanelOwed ? vacuglidePanelOwed.badge : badge;
    vacuglidePanelOwed = { token, status: `Status: ${status}`, badge: before };
}

function settleVacuglidePanel(token) {
    const owed = vacuglidePanelOwed;
    if (!owed || owed.token !== token) return;
    vacuglidePanelOwed = null;
    const status = (document.getElementById('modalVacuglideMsg')?.textContent || '').trim();
    const badge = (document.getElementById('badgeVacuglideText')?.textContent || '').trim();
    if (status !== owed.status || badge !== 'Stop unconfirmed') return;
    if (isVacuglideConnected()) {
        setVacuglideStatus(vacuglideConnectedLabel, 'ok');
        setBadgeState('Vacuglide', 'connected', 'VacuGlide', null);
        return;
    }
    setVacuglideStatus("Autoblow's server confirmed the stop: the motor is stopped and both valves are closed.", 'idle');
    setBadgeState('Vacuglide', 'disconnected', VACUGLIDE_RESTING_BADGES.includes(owed.badge) ? owed.badge : 'Disconnected');
}

function vacuglideOwedSentence() {
    const details = [...vacuglideStopsOwed.values()];
    if (details.length === 0) return '';
    const lead = details.length === 1
        ? 'The VacuGlide did not confirm a stop and may still be running, or have a valve open: check the device.'
        : `${details.length} VacuGlides did not confirm a stop and may still be running, or have a valve open: check each device.`;
    const newest = details[details.length - 1];
    return newest ? `${lead} (${newest})` : lead;
}

function reportOwedVacuglideStops({ fresh = false } = {}) {
    const sentence = vacuglideOwedSentence();
    if (!sentence) hideAlertBanner('vacuglideStop');
    else if (fresh) triggerDisconnectAlert(sentence, 'vacuglideStop');
    else reviseAlertBanner(sentence, { severity: 'safety', source: 'vacuglideStop' });
}

setVacuglideHandlers({
    isSessionActive: () => state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN',
    onError: (message) => {
        if (!isVacuglideConnected()) return;
        if (message) {
            const short = message.length > 70 ? `${message.slice(0, 67)}...` : message;
            setVacuglideStatus(`API error: ${short}`, 'error');
            setBadgeState('Vacuglide', 'warning', 'API Error', null);
        } else {
            setVacuglideStatus(vacuglideConnectedLabel, 'ok');
            setBadgeState('Vacuglide', 'connected', 'VacuGlide', null);
        }
    },
    onOffline: (reason, label) => {
        setVacuglideStatus(reason || 'Offline', 'error');
        setBadgeState('Vacuglide', 'disconnected', label || 'Offline');
        paintVacuglideButtons();
        renderVacuglideValves();
        // Pauses the session and issues a stop to every other toy. The
        // pause is said by the banner, which takes it back once the session
        // runs again on the toys that are left.
        triggerDisconnectAlert(reason || 'The VacuGlide went offline.', 'vacuglideLink', { motorsPaused: true });
    },
    onNotice: (message) => {
        if (!isVacuglideConnected() || !message) return;
        setVacuglideStatus(message, 'busy');
    },
    onPulse: () => renderVacuglideValves(),
    // A valve a reply showed open with no press holding it, its close, and
    // the watch after a press whose open was never answered. The message
    // says what happened to that valve, next to the buttons that move it.
    onValves: (message) => {
        renderVacuglideValves();
        if (message && isVacuglideConnected()) setVacuglideValveMessage(message, 'error');
    },
    // A device EdgeLoop had already let go of - Disconnect, a lost link -
    // that a command Autoblow's server delivered late set moving again, and
    // that EdgeLoop stopped again. The panel is that device's while no
    // other VacuGlide is connected.
    onLateStop: (message) => {
        if (isVacuglideConnected() || !message) return;
        setVacuglideStatus(message, 'busy');
    },
    // A device a page that went away (a reload, a closed tab) could not
    // vouch for, which this page took over: it is watched, and stopped if it
    // moves, without being connected. The panel is that device's until one
    // is connected; `active` is false once the page has finished with it.
    onTakeover: (message, active) => {
        if (isVacuglideConnected() || !message) return;
        setVacuglideStatus(message, active ? 'busy' : 'idle');
        setBadgeState('Vacuglide', active ? 'warning' : 'disconnected', active ? 'Watching' : 'Disconnected');
    },
    // The VacuGlide was found stopped under the running session by
    // something other than this page - Autoblow's app, another app on its
    // token, a stop Autoblow delivered late. The session pauses where the
    // wearer is, which sends it the whole stop and no speed, and the driver
    // sends it none until the session runs again: RESUME starts it, not the
    // session's next tick behind whoever stopped it.
    onStoppedElsewhere: (message) => {
        if (!isVacuglideConnected() || !message) return;
        triggerDisconnectAlert(message, 'vacuglidePaused');
    },
    // Not gated on the link: Disconnect and a lost link drop it before their
    // stop resolves, and an unconfirmed stop or valve close there is the
    // one thing the wearer must hear about.
    onStopUnconfirmed: (message, token) => {
        const connected = isVacuglideConnected();
        const key = typeof token === 'string' ? token : '';
        noteVacuglidePanelOwed(key, message);
        setVacuglideStatus(message, 'error');
        setBadgeState('Vacuglide', connected ? 'warning' : 'disconnected', 'Stop unconfirmed', null);
        renderVacuglideValves();
        vacuglideStopsOwed.delete(key);
        vacuglideStopsOwed.set(key, typeof message === 'string' ? message.trim() : '');
        reportOwedVacuglideStops({ fresh: true });
    },
    // A whole stop of that device confirmed: what its unconfirmed stop
    // warned about is over - on the banner, which says what is left, and on
    // the panel's line and badge, unless something else is on them since.
    onStopConfirmed: (token) => {
        if (vacuglideStopsOwed.delete(typeof token === 'string' ? token : '')) reportOwedVacuglideStops();
        settleVacuglidePanel(typeof token === 'string' ? token : '');
    }
});

document.getElementById('modalVacuglideConnectBtn')?.addEventListener('click', async () => {
    const raw = vacuglideInput?.value || '';
    if (!raw.trim()) {
        setVacuglideStatus('Enter your VacuGlide device token first.', 'error');
        return;
    }
    const token = sanitizeDeviceToken(raw);
    if (!token) {
        setVacuglideStatus('That is not a device token. Paste it exactly as Autoblow shows it: plain letters and digits, no spaces, at most 128 characters.', 'error');
        return;
    }
    if (vacuglideConnectInFlight || isVacuglideConnected()) return;
    vacuglideConnectInFlight = true;
    safeSet(VACUGLIDE_TOKEN_STORAGE_KEY, token);
    if (vacuglideInput) vacuglideInput.value = token;
    setVacuglideStatus("Finding the VacuGlide on Autoblow's server, then stopping it and closing both valves...", 'busy');
    setBadgeState('Vacuglide', 'connecting', 'Connecting...');
    setVacuglideValveMessage('');
    paintVacuglideButtons();
    try {
        const result = await connectVacuglide(token);
        // Connecting brought this very device to a confirmed whole stop:
        // whatever a crashed session left it doing is over, so no crash
        // stop is owed to it any more (crash-recovery.js), as for The Handy.
        if (!isRemotePage) clearPendingVacuglideStop(token, crashStorage);
        vacuglideConnectedLabel = result.description ? `Connected (${result.description})` : 'Connected';
        setVacuglideStatus(vacuglideConnectedLabel, 'ok');
        setBadgeState('Vacuglide', 'connected', 'VacuGlide', null);
        // Connected: whatever said the link was gone is over. A stop this
        // device owed was settled by the confirmed stop the connect made
        // (onStopConfirmed); another device's stays reported.
        hideAlertBanner('vacuglideLink');
        syncTelemetry();
    } catch (e) {
        setVacuglideStatus(e && e.message ? e.message : 'Connection failed', 'error');
        setBadgeState('Vacuglide', 'disconnected', 'Offline');
    } finally {
        vacuglideConnectInFlight = false;
        paintVacuglideButtons();
        renderVacuglideValves();
    }
});

document.getElementById('modalVacuglideDisconnectBtn')?.addEventListener('click', async () => {
    // The link drops at once; the whole stop it sends - motor and both
    // valves - is awaited so the modal can say whether the device confirmed it.
    const token = getVacuglideToken();
    const stopped = disconnectVacuglide();
    setVacuglideStatus('Stopping the device and closing both valves...', 'busy');
    setBadgeState('Vacuglide', 'disconnected', 'Stopping...');
    paintVacuglideButtons();
    renderVacuglideValves();
    triggerDisconnectAlert('The VacuGlide disconnected.', 'vacuglideLink');
    const result = await stopped.catch(() => ({ confirmed: false, mayHaveMoved: true }));
    // Connected again meanwhile: the new link owns the modal and the badge.
    if (isVacuglideConnected()) return;
    // Connected in another tab before this stop was through: that tab drives
    // the device now, and the panel already says this one let go of it.
    if (result.letGo) return;
    if (result.confirmed) {
        // The stop is confirmed, but a command still unanswered may land
        // after it: "Offline" alone would promise more than the driver can.
        if (result.watching) setVacuglideStatus("Disconnected. EdgeLoop watches the VacuGlide for a minute in case a command Autoblow's server has not answered still reaches it, and stops it again if it does.", 'busy');
        else setVacuglideStatus('Offline', 'idle');
        setBadgeState('Vacuglide', 'disconnected', 'Disconnected');
    } else if (result.mayHaveMoved) {
        const line = 'Disconnected, but the stop was not confirmed: check that the VacuGlide is not running and that neither valve is open.';
        noteVacuglidePanelOwed(token, line);
        setVacuglideStatus(line, 'error');
        setBadgeState('Vacuglide', 'disconnected', 'Stop unconfirmed');
    } else {
        setVacuglideStatus('Disconnected. The device did not answer its stop, but EdgeLoop had not started it or opened a valve.', 'idle');
        setBadgeState('Vacuglide', 'disconnected', 'Disconnected');
    }
});

// A valve button: one press, one pulse of the length the panel shows.
Object.entries(VALVE_BUTTONS).forEach(([valve, id]) => {
    document.getElementById(id)?.addEventListener('click', async () => {
        if (isRemotePage || !isVacuglideConnected() || getValvePulse()) return;
        setVacuglideValveMessage('');
        const result = await pulseValve(valve, advancedSettings.vacuglideValvePulseMs);
        renderVacuglideValves();
        if (!result.ok) setVacuglideValveMessage(result.message, result.reason === 'busy' || result.reason === 'let-go' ? 'idle' : 'error');
    });
});

// The role, the speed cap and the pulse length are Session Setup values
// (advancedSettings), so they are painted from the store here - on boot and
// again after a backup import - and every control writes back through the
// same sanitizers the schema uses.
function paintVacuglideRole(role) {
    const pBtn = document.getElementById('vacuglideRolePrimaryBtn');
    const sBtn = document.getElementById('vacuglideRoleSecondaryBtn');
    const oBtn = document.getElementById('vacuglideRoleOffBtn');
    const badge = document.getElementById('modalVacuglideRoleBadge');
    const idle = "py-1.5 rounded-lg bg-slate-800 text-slate-400 font-bold text-xs hover:text-white transition cursor-pointer";
    if (pBtn) pBtn.className = role === 'primary' ? "py-1.5 rounded-lg bg-rose-600 text-white font-bold text-xs transition cursor-pointer" : idle;
    if (sBtn) sBtn.className = role === 'secondary' ? "py-1.5 rounded-lg bg-purple-600 text-white font-bold text-xs transition cursor-pointer" : idle;
    if (oBtn) oBtn.className = role === 'off' ? "py-1.5 rounded-lg bg-slate-700 text-amber-300 font-bold text-xs transition cursor-pointer" : idle;
    [[pBtn, 'primary'], [sBtn, 'secondary'], [oBtn, 'off']].forEach(([btn, name]) => btn?.setAttribute('aria-pressed', role === name ? 'true' : 'false'));
    if (badge) {
        if (role === 'primary') { badge.textContent = "Primary speed"; badge.className = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800"; }
        else if (role === 'secondary') { badge.textContent = "Secondary speed"; badge.className = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800"; }
        else { badge.textContent = "Disabled (OFF)"; badge.className = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-amber-400 border border-slate-700"; }
    }
}

function syncVacuglidePanel() {
    advancedSettings.vacuglideRole = sanitizeVacuglideRole(advancedSettings.vacuglideRole);
    advancedSettings.vacuglideMaxCap = clampSpeedCap(advancedSettings.vacuglideMaxCap);
    advancedSettings.vacuglideValvePulseMs = clampValvePulseMs(advancedSettings.vacuglideValvePulseMs);
    paintVacuglideRole(advancedSettings.vacuglideRole);
    const capSlider = document.getElementById('vacuglideCapSlider');
    const capVal = document.getElementById('vacuglideCapVal');
    if (capSlider) capSlider.value = String(advancedSettings.vacuglideMaxCap);
    if (capVal) capVal.textContent = `${advancedSettings.vacuglideMaxCap}%`;
    const pulseInput = document.getElementById('vacuglidePulseInput');
    if (pulseInput) pulseInput.value = formatPulseSeconds(advancedSettings.vacuglideValvePulseMs);
}

// Same shape as the end-stop margin input: while typing, a half-typed
// number is left alone; on commit the corrected value is written back.
function applyVacuglidePulseInput(commit = false) {
    const el = document.getElementById('vacuglidePulseInput');
    if (!el) return;
    const ms = el.value === '' ? clampValvePulseMs(advancedSettings.vacuglideValvePulseMs) : pulseSecondsToMs(el.value);
    advancedSettings.vacuglideValvePulseMs = ms;
    if (commit) el.value = formatPulseSeconds(ms);
    persistSettings();
}

function initVacuglidePanel() {
    const roles = { vacuglideRolePrimaryBtn: 'primary', vacuglideRoleSecondaryBtn: 'secondary', vacuglideRoleOffBtn: 'off' };
    Object.entries(roles).forEach(([id, role]) => {
        document.getElementById(id)?.addEventListener('click', () => {
            advancedSettings.vacuglideRole = role;
            persistSettings();
            paintVacuglideRole(role);
            updateEngine();
        });
    });
    const capSlider = document.getElementById('vacuglideCapSlider');
    capSlider?.addEventListener('input', (e) => {
        advancedSettings.vacuglideMaxCap = clampSpeedCap(e.target.value);
        const capVal = document.getElementById('vacuglideCapVal');
        if (capVal) capVal.textContent = `${advancedSettings.vacuglideMaxCap}%`;
        persistSettings();
        updateEngine();
    });
    const pulseInput = document.getElementById('vacuglidePulseInput');
    if (pulseInput) {
        pulseInput.min = String(VALVE_PULSE_MIN_MS / 1000);
        pulseInput.max = String(VALVE_PULSE_MAX_MS / 1000);
        pulseInput.addEventListener('input', () => applyVacuglidePulseInput(false));
        pulseInput.addEventListener('change', () => applyVacuglidePulseInput(true));
    }
    syncVacuglidePanel();
    paintVacuglideButtons();
    renderVacuglideValves();
}

// The device has no watchdog: if this page dies, it keeps running at its
// last speed with its valves as they were. attachVacuglideToPage sends it
// the whole stop with keepalive on pagehide and freeze, like The Handy's,
// and takes over what a page that went away left once this page has loaded,
// and again when it comes back - never in a tab that was merely open when
// that page went away. All of that is in the driver, where node can test it
// with a window and a document of its own: app.js only says whether this is
// a partner page. The partner viewer and controller pages run no hardware of
// their own, and never read, stop or take over a VacuGlide.
attachVacuglideToPage({ remote: isRemotePage, win: window, doc: document });

// Intiface Central WebSocket. The driver reports its state through
// onStatus; the modal label, the summary badge and the buttons follow it.
const intifaceStatusColors = {
    offline: 'text-rose-400',
    connecting: 'text-amber-400',
    handshake: 'text-amber-400',
    connected: 'text-emerald-400',
    error: 'text-rose-400'
};

function renderIntifaceStatus(status) {
    const label = document.getElementById('modalIntifaceStatusText');
    if (label) {
        label.textContent = status.text;
        label.className = `text-[10px] font-mono text-right max-w-[60%] break-words ${intifaceStatusColors[status.state] || 'text-slate-400'}`;
    }
    const connectBtn = document.getElementById('modalIntifaceConnectBtn');
    const disconnectBtn = document.getElementById('modalIntifaceDisconnectBtn');
    const rescanBtn = document.getElementById('modalIntifaceRescanBtn');
    const busy = status.state === 'connecting' || status.state === 'handshake';
    const connected = status.state === 'connected';
    if (connectBtn) {
        connectBtn.disabled = busy;
        connectBtn.classList.toggle('opacity-50', busy);
        connectBtn.classList.toggle('cursor-not-allowed', busy);
        connectBtn.classList.toggle('hidden', connected);
        connectBtn.textContent = busy ? 'Connecting...' : 'Connect';
    }
    disconnectBtn?.classList.toggle('hidden', !(connected || busy));
    rescanBtn?.classList.toggle('hidden', !connected);
    renderIntifaceSummaryBadge();
}

document.getElementById('modalIntifaceConnectBtn')?.addEventListener('click', () => {
    const url = document.getElementById('modalIntifaceUrl')?.value.trim() || DEFAULT_INTIFACE_URL;
    connectIntifaceServer(url, {
        onStatus: (status) => {
            // Connected again: the report that the last connection was lost
            // or closed with toys in use is over.
            if (status && status.state === 'connected') hideAlertBanner('intiface');
            renderIntifaceStatus(status);
        },
        onDevicesChanged: () => {
            noteLiveHardware();
            renderIntifaceDevices();
            syncTelemetry();
        },
        onError: () => {
            // The status label already carries the text; a failed connect
            // attempt must not pause a session running on other hardware.
        },
        onClose: ({ wasConnected, assignedDevices, intentional }) => {
            renderIntifaceDevices();
            syncTelemetry();
            if (!wasConnected || assignedDevices === 0) return;
            const toys = `${assignedDevices} assigned toy${assignedDevices === 1 ? '' : 's'}`;
            triggerDisconnectAlert(intentional
                ? `Intiface Central disconnected with ${toys} in use.`
                : `Intiface Central connection lost: ${toys} unreachable.`, 'intiface', { motorsPaused: true });
        }
    });
});
document.getElementById('modalIntifaceDisconnectBtn')?.addEventListener('click', () => disconnectIntiface());
document.getElementById('modalIntifaceRescanBtn')?.addEventListener('click', () => {
    rescanIntiface();
    renderIntifaceDevices();
});
document.getElementById('modalIntifaceSaveBtn')?.addEventListener('click', () => {
    const btn = document.getElementById('modalIntifaceSaveBtn');
    const saved = saveIntifaceConfig();
    if (btn) {
        btn.textContent = saved ? 'Saved' : 'Could not save (storage full or blocked)';
        setTimeout(() => { btn.textContent = 'Save & Apply Configuration'; }, 1500);
    }
    renderIntifaceSummaryBadge();
    syncTelemetry();
    if (saved) setTimeout(closeModal, 600);
});

window.setDeviceRole = (devIdx, axisIdx, role) => {
    setAxisRole(devIdx, axisIdx, role);
    renderIntifaceDevices();
    syncTelemetry();
};

window.setDeviceCap = (devIdx, axisIdx, val) => {
    setAxisMaxCap(devIdx, axisIdx, parseInt(val, 10));
    const el = document.getElementById(`capVal_${devIdx}_${axisIdx}`);
    if (el) el.textContent = `${val}%`;
    syncTelemetry();
};

window.setDeviceInvert = (devIdx, axisIdx, checked) => {
    setAxisInvert(devIdx, axisIdx, Boolean(checked));
};

window.setDeviceVibeMode = (devIdx, axisIdx, mode) => {
    setAxisVibeMode(devIdx, axisIdx, { mode });
    renderIntifaceDevices();
};

window.setDevicePulsePeriod = (devIdx, axisIdx, val) => {
    setAxisVibeMode(devIdx, axisIdx, { periodMs: parseInt(val, 10) });
};

window.setDeviceReverseOnEdge = (devIdx, checked) => {
    setDeviceRotation(devIdx, { reverseOnEdge: Boolean(checked) });
};

window.setDeviceAlternate = (devIdx, val) => {
    setDeviceRotation(devIdx, { alternateSeconds: parseInt(val, 10) || 0 });
};

// The travel envelope goes with the press: before a session's first tick
// the driver has no other way to know it.
window.testAxis = (devIdx, axisIdx) => testSingleAxis(devIdx, axisIdx, normalizeEnvelope(advancedSettings.handyHwMin, advancedSettings.handyHwMax));

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderIntifaceDevices() {
    const list = document.getElementById('modalIntifaceList');
    if (!list) return;
    if (intifaceDevices.size === 0) {
        let hint = 'Connect to Intiface server to detect your toys.';
        if (isIntifaceConnected()) {
            hint = isIntifaceScanning()
                ? 'Scanning... Power on your toys.'
                : 'No toys found. Power them on and tap Re-Scan Toys.';
        }
        list.innerHTML = `<div class="p-3 bg-slate-950 rounded-xl border border-slate-800 text-slate-500 text-xs italic text-center">${hint}</div>`;
        renderIntifaceSummaryBadge();
        return;
    }
    list.innerHTML = '';
    intifaceDevices.forEach((dev, devIdx) => {
        const item = document.createElement('div');
        item.className = 'p-2.5 bg-slate-950 rounded-xl border border-slate-800 space-y-2 text-xs';
        const batText = dev.hasBattery ? (dev.battery !== null ? `🔋 ${dev.battery}%` : '🔋 Reading...') : '🔋 N/A';

        let axisRows = '';
        dev.axes.forEach((axis, aIdx) => {
            const label = axis.descriptor ? `${escapeHtml(axis.type)} - ${escapeHtml(axis.descriptor)}` : escapeHtml(axis.type);
            // A scalar that takes a position: the same motor as a Linear
            // axis, driven through that one only (buttplug-protocol.js,
            // drivesAsLevel). No role, no cap, no Test.
            if (axis.inert) {
                axisRows += `
            <div class="bg-slate-900 p-2 rounded-lg border border-slate-800 space-y-1 text-[10px]">
            <div class="font-bold text-slate-500 truncate">Axis ${axis.index} (${label}) - not used</div>
            <p class="text-[9px] text-slate-500 leading-snug">A position without a duration: EdgeLoop strokes this motor through its Linear axis and sends this one nothing.</p>
            </div>`;
                return;
            }
            const failing = axis.failing
                ? `<span class="text-[9px] font-bold text-rose-400 bg-rose-950/60 border border-rose-800 px-1 rounded" title="Intiface rejected the last 3 commands to this axis">Not responding</span>`
                : '';
            const invertRow = axis.kind === 'linear' ? `
            <label class="flex items-center justify-between text-[9px] text-slate-400 pt-1 border-t border-slate-800/60 cursor-pointer">
            <span>Invert direction (sleeve mounted upside down)</span>
            <input type="checkbox" ${axis.invert ? 'checked' : ''} onchange="setDeviceInvert(${devIdx}, ${aIdx}, this.checked)" class="accent-amber-500 cursor-pointer">
            </label>` : '';
            // Two actuators of one motor (an OSSM's Position and Oscillate):
            // only one in use, and the Test of the other refused while it is.
            const twinBusy = Boolean(axis.twin && axis.twin.role !== 'off');
            const twinLabel = axis.twin ? `Axis ${axis.twin.index} (${escapeHtml(axis.twin.type)})` : '';
            let twinNote = '';
            if (axis.twin && axis.kind === 'linear') {
                twinNote = `<p class="text-[9px] text-slate-500 leading-snug">Same motor as ${twinLabel}: only one of the two can be on. This one strokes inside your Travel Envelope.</p>`;
            } else if (axis.twin) {
                twinNote = `<p class="text-[9px] text-amber-300/80 leading-snug">Same motor as ${twinLabel}: only one of the two can be on, and switching makes the machine stop and change mode. Oscillate runs the machine's own stroke over its whole rail - Intiface sets full depth and stroke - at the engine's speed; your Travel Envelope cannot reach it. Use ${twinLabel} to keep the stroke inside your envelope.</p>`;
            }
            const testButton = twinBusy
                ? `<button disabled title="${twinLabel} is in use; set it OFF to test this one" class="bg-slate-800 px-1.5 py-0.5 rounded text-[9px] opacity-40 cursor-not-allowed">Test</button>`
                : `<button onclick="testAxis(${devIdx}, ${aIdx})" class="bg-slate-800 hover:bg-slate-700 px-1.5 py-0.5 rounded text-[9px] cursor-pointer">Test</button>`;
            let vibeRow = '';
            if (axis.kind === 'scalar' && axis.type === 'Vibrate') {
                const pulsed = axis.vibeMode === 'pulsed';
                const periods = PULSE_PERIODS_MS.map((ms) => `<option value="${ms}" ${axis.pulsePeriodMs === ms ? 'selected' : ''}>${(ms / 1000).toFixed(1)} s</option>`).join('');
                vibeRow = `
            <div class="space-y-1 pt-1 border-t border-slate-800/60">
            <div class="flex items-center gap-1 text-[9px] text-slate-400">
            <span class="mr-1">Vibration:</span>
            <button onclick="setDeviceVibeMode(${devIdx}, ${aIdx}, 'constant')" class="flex-1 py-0.5 rounded ${!pulsed ? 'bg-slate-700 text-amber-300 font-bold' : 'bg-slate-800 text-slate-400'} cursor-pointer">Constant</button>
            <button onclick="setDeviceVibeMode(${devIdx}, ${aIdx}, 'pulsed')" class="flex-1 py-0.5 rounded ${pulsed ? 'bg-slate-700 text-amber-300 font-bold' : 'bg-slate-800 text-slate-400'} cursor-pointer">Pulsed</button>
            <select aria-label="Pulse period" onchange="setDevicePulsePeriod(${devIdx}, ${aIdx}, this.value)" ${pulsed ? '' : 'disabled'} class="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[9px] text-slate-200 ${pulsed ? 'cursor-pointer' : 'opacity-40'}">${periods}</select>
            </div>
            ${pulsed ? '<p class="text-[9px] text-slate-500 leading-snug">On for half of each period, off for the other half. The engine\'s intensity sets the peak, never above the cap.</p>' : ''}
            </div>`;
            }
            axisRows += `
            <div class="bg-slate-900 p-2 rounded-lg border ${axis.failing ? 'border-rose-800' : 'border-slate-800'} space-y-1.5 text-[10px]">
            <div class="flex justify-between items-center gap-1">
            <span class="font-bold text-slate-300 truncate">Axis ${axis.index} (${label})</span>
            <span class="flex items-center gap-1 shrink-0">${failing}
            ${testButton}</span>
            </div>
            ${twinNote}
            <div class="flex gap-1">
            <button onclick="setDeviceRole(${devIdx}, ${aIdx}, 'primary')" class="flex-1 py-1 rounded ${axis.role === 'primary' ? 'bg-rose-600 text-white font-bold' : 'bg-slate-800 text-slate-400'} transition cursor-pointer">Primary</button>
            <button onclick="setDeviceRole(${devIdx}, ${aIdx}, 'secondary')" class="flex-1 py-1 rounded ${axis.role === 'secondary' ? 'bg-purple-600 text-white font-bold' : 'bg-slate-800 text-slate-400'} transition cursor-pointer">Secondary</button>
            <button onclick="setDeviceRole(${devIdx}, ${aIdx}, 'off')" class="flex-1 py-1 rounded ${axis.role === 'off' ? 'bg-slate-700 text-amber-300 font-bold' : 'bg-slate-800 text-slate-400'} transition cursor-pointer">OFF</button>
            </div>
            <div class="space-y-0.5 pt-1 border-t border-slate-800/60">
            <div class="flex justify-between text-[9px] text-slate-400">
            <span>Max Power Cap:</span>
            <span id="capVal_${devIdx}_${aIdx}" class="font-bold font-mono text-amber-400">${axis.maxCap ?? 100}%</span>
            </div>
            <input type="range" min="10" max="100" step="5" value="${axis.maxCap ?? 100}" oninput="setDeviceCap(${devIdx}, ${aIdx}, this.value)" class="w-full accent-amber-500 h-1 bg-slate-800 rounded cursor-pointer">
            </div>
            ${vibeRow}
            ${invertRow}
            </div>
            `;
        });

        let rotationRow = '';
        if (dev.axes.some((a) => a.kind === 'rotate')) {
            let options = `<option value="0" ${!dev.alternateSeconds ? 'selected' : ''}>Off</option>`;
            for (let sec = ALTERNATE_SECONDS_MIN; sec <= ALTERNATE_SECONDS_MAX; sec += 5) {
                options += `<option value="${sec}" ${dev.alternateSeconds === sec ? 'selected' : ''}>${sec} s</option>`;
            }
            rotationRow = `
            <div class="bg-slate-900 p-2 rounded-lg border border-slate-800 space-y-1.5 text-[10px]">
            <div class="font-bold text-slate-300">Rotation</div>
            <label class="flex items-center justify-between text-[9px] text-slate-400 cursor-pointer">
            <span>Reverse direction on every edge</span>
            <input type="checkbox" ${dev.reverseOnEdge !== false ? 'checked' : ''} onchange="setDeviceReverseOnEdge(${devIdx}, this.checked)" class="accent-purple-500 cursor-pointer">
            </label>
            <label class="flex items-center justify-between text-[9px] text-slate-400">
            <span>Alternate direction every</span>
            <select onchange="setDeviceAlternate(${devIdx}, this.value)" class="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[9px] text-slate-200 cursor-pointer">${options}</select>
            </label>
            <p class="text-[9px] text-slate-500">Direction never changes more than once per second.</p>
            </div>`;
        }

        item.innerHTML = `
        <div class="flex justify-between items-center font-bold text-slate-200">
        <span class="truncate">${escapeHtml(dev.displayName || dev.name)}</span>
        <span class="text-[9px] font-mono text-emerald-400 shrink-0">${batText}</span>
        </div>
        <div class="space-y-1">${axisRows}${rotationRow}</div>
        `;
        list.appendChild(item);
    });
    renderIntifaceSummaryBadge();
}

function renderIntifaceSummaryBadge() {
    const status = getIntifaceStatus();
    if (!isIntifaceConnected()) {
        const busy = status.state === 'connecting' || status.state === 'handshake';
        let label = 'Disconnected';
        if (busy) label = status.state === 'handshake' ? 'Handshake...' : 'Connecting...';
        else if (status.state === 'error') label = 'Error';
        setBadgeState('Intiface', busy ? 'connecting' : 'disconnected', label, null);
        return;
    }
    if (intifaceDevices.size === 0) {
        setBadgeState('Intiface', 'connected', isIntifaceScanning() ? 'Scanning...' : '0 Toys Ready', null);
        return;
    }
    const firstToy = Array.from(intifaceDevices.values())[0];
    let nameLabel = (firstToy.displayName || firstToy.name).split(' ')[0];
    if (intifaceDevices.size > 1) nameLabel += ` +${intifaceDevices.size - 1}`;
    const assigned = countAssignedIntifaceDevices();
    if (assigned === 0) nameLabel += ' (all OFF)';
    const failing = Array.from(intifaceDevices.values()).some((d) => d.axes.some((a) => a.failing));
    setBadgeState('Intiface', failing ? 'warning' : 'connected', failing ? `${nameLabel} - errors` : nameLabel, firstToy.battery !== null ? `🔋 ${firstToy.battery}%` : null);
}

// TCode Serial (Web Serial). The driver reports its state through onStatus;
// the modal label, the summary badge and the buttons follow it.
function warnSerialUnsupported() {
    if (isSerialSupported()) return false;
    renderTCodeStatus({ state: 'error', text: describeSerialSupport(navigator.userAgent, window.isSecureContext !== false) });
    setBadgeState('TCode', 'disconnected', 'Unsupported');
    return true;
}

function renderTCodeStatus(status) {
    const label = document.getElementById('modalTCodeStatusText');
    if (label) {
        label.textContent = status.text;
        label.className = `text-[10px] font-mono text-right max-w-[70%] break-words ${intifaceStatusColors[status.state] || 'text-slate-400'}`;
    }
    const connectBtn = document.getElementById('modalTCodeConnectBtn');
    const disconnectBtn = document.getElementById('modalTCodeDisconnectBtn');
    const busy = status.state === 'connecting' || status.state === 'handshake';
    const connected = status.state === 'connected';
    if (connectBtn) {
        connectBtn.disabled = busy;
        connectBtn.classList.toggle('opacity-50', busy);
        connectBtn.classList.toggle('cursor-not-allowed', busy);
        connectBtn.classList.toggle('hidden', connected);
        connectBtn.textContent = busy ? 'Connecting...' : 'Connect';
    }
    disconnectBtn?.classList.toggle('hidden', !(connected || busy));
    renderTCodeSummaryBadge();
}

setTCodeHandlers({
    onStatus: (status) => {
        // Connected again: the report that the device was lost or closed with
        // axes in use is over.
        if (status && status.state === 'connected') hideAlertBanner('tcode');
        renderTCodeStatus(status);
    },
    onDevicesChanged: () => {
        noteLiveHardware();
        renderTCodeDevice();
        syncTelemetry();
    },
    onError: () => {
        // The status label carries the text; the driver closes the port
        // itself and onClose decides whether the session must pause.
    },
    onClose: ({ wasConnected, assignedAxes, intentional }) => {
        renderTCodeDevice();
        syncTelemetry();
        if (!wasConnected || assignedAxes === 0) return;
        const axes = `${assignedAxes} assigned ax${assignedAxes === 1 ? 'is' : 'es'}`;
        triggerDisconnectAlert(intentional
            ? `TCode Serial device disconnected with ${axes} in use.`
            : `TCode Serial device lost: ${axes} unreachable.`, 'tcode', { motorsPaused: true });
    }
});

document.getElementById('modalTCodeConnectBtn')?.addEventListener('click', () => {
    if (warnSerialUnsupported()) return;
    // requestPort needs the click's user activation: call straight away.
    // The modal stays open so the identified axes can be checked with Test.
    connectTCode().then(() => syncTelemetry()).catch(() => {});
});
document.getElementById('modalTCodeDisconnectBtn')?.addEventListener('click', () => {
    disconnectTCode().catch(() => {});
});

window.setTCodeRole = (axisIdx, role) => {
    setTCodeAxisRole(axisIdx, role);
    renderTCodeDevice();
    syncTelemetry();
};

window.setTCodeCap = (axisIdx, val) => {
    setTCodeAxisCap(axisIdx, parseInt(val, 10));
    const el = document.getElementById(`tcodeCapVal_${axisIdx}`);
    if (el) el.textContent = `${val}%`;
};

window.setTCodeInvert = (axisIdx, checked) => {
    setTCodeAxisInvert(axisIdx, Boolean(checked));
};

window.testTCodeAxis = (axisIdx) => testTCodeAxis(axisIdx);

function renderTCodeDevice() {
    const list = document.getElementById('modalTCodeList');
    const info = document.getElementById('modalTCodeInfo');
    if (!list) return;
    const dev = isTCodeConnected() ? getTCodeDevice() : null;
    if (info) {
        if (dev) {
            info.textContent = `${dev.name}${dev.version ? ` - ${dev.version}` : ''}${dev.identified ? '' : ' (no reply to D0/D1/D2: assuming the OSR2 axis set)'}`;
            info.classList.remove('hidden');
        } else {
            info.textContent = 'No device';
            info.classList.add('hidden');
        }
    }
    if (!dev) {
        list.innerHTML = `<div class="p-3 bg-slate-950 rounded-xl border border-slate-800 text-slate-500 text-xs italic text-center">Connect to list the device axes.</div>`;
        renderTCodeSummaryBadge();
        return;
    }
    list.innerHTML = '';
    dev.axes.forEach((axis, aIdx) => {
        const kindLabel = axis.kind === 'linear' ? 'Linear' : axis.kind === 'rotate' ? 'Rotate' : axis.kind === 'vibe' ? 'Vibe' : 'Aux';
        const invertRow = axis.kind === 'linear' ? `
        <label class="flex items-center justify-between text-[9px] text-slate-400 pt-1 border-t border-slate-800/60 cursor-pointer">
        <span>Invert direction (sleeve mounted upside down)</span>
        <input type="checkbox" ${axis.invert ? 'checked' : ''} onchange="setTCodeInvert(${aIdx}, this.checked)" class="accent-amber-500 cursor-pointer">
        </label>` : '';
        const item = document.createElement('div');
        item.className = 'bg-slate-900 p-2 rounded-lg border border-slate-800 space-y-1.5 text-[10px]';
        item.innerHTML = `
        <div class="flex justify-between items-center gap-1">
        <span class="font-bold text-slate-300 truncate">${escapeHtml(axis.id)} - ${escapeHtml(axis.description)} <span class="font-normal text-slate-500">(${kindLabel})</span></span>
        <button onclick="testTCodeAxis(${aIdx})" class="bg-slate-800 hover:bg-slate-700 px-1.5 py-0.5 rounded text-[9px] cursor-pointer shrink-0">Test</button>
        </div>
        <div class="flex gap-1">
        <button onclick="setTCodeRole(${aIdx}, 'primary')" class="flex-1 py-1 rounded ${axis.role === 'primary' ? 'bg-rose-600 text-white font-bold' : 'bg-slate-800 text-slate-400'} transition cursor-pointer">Primary</button>
        <button onclick="setTCodeRole(${aIdx}, 'secondary')" class="flex-1 py-1 rounded ${axis.role === 'secondary' ? 'bg-purple-600 text-white font-bold' : 'bg-slate-800 text-slate-400'} transition cursor-pointer">Secondary</button>
        <button onclick="setTCodeRole(${aIdx}, 'off')" class="flex-1 py-1 rounded ${axis.role === 'off' ? 'bg-slate-700 text-amber-300 font-bold' : 'bg-slate-800 text-slate-400'} transition cursor-pointer">OFF</button>
        </div>
        <div class="space-y-0.5 pt-1 border-t border-slate-800/60">
        <div class="flex justify-between text-[9px] text-slate-400">
        <span>Max cap:</span>
        <span id="tcodeCapVal_${aIdx}" class="font-bold font-mono text-amber-400">${axis.maxCap ?? 100}%</span>
        </div>
        <input type="range" min="10" max="100" step="5" value="${axis.maxCap ?? 100}" oninput="setTCodeCap(${aIdx}, this.value)" class="w-full accent-amber-500 h-1 bg-slate-800 rounded cursor-pointer">
        </div>
        ${invertRow}
        `;
        list.appendChild(item);
    });
    renderTCodeSummaryBadge();
}

function renderTCodeSummaryBadge() {
    const status = getTCodeStatus();
    if (!isTCodeConnected()) {
        const busy = status.state === 'connecting' || status.state === 'handshake';
        let label = 'Disconnected';
        if (busy) label = status.state === 'handshake' ? 'Identifying...' : 'Connecting...';
        else if (status.state === 'error') label = isSerialSupported() ? 'Error' : 'Unsupported';
        setBadgeState('TCode', busy ? 'connecting' : 'disconnected', label, null);
        return;
    }
    const dev = getTCodeDevice();
    let nameLabel = dev ? dev.name.split(' ')[0] : 'TCode';
    const assigned = countAssignedTCodeAxes();
    if (assigned === 0) nameLabel += ' (all OFF)';
    setBadgeState('TCode', 'connected', nameLabel, null);
}

// Page lifecycle. A page that goes away (pagehide) or that the browser
// freezes in the background (freeze) runs nothing afterwards, and no toy
// notices: The Handy is driven through the cloud, an Intiface or T-Code axis
// keeps the speed it was given. So both events send every toy the last stop
// it will get - a keepalive request to The Handy (a plain one is cancelled
// with a document that goes away, and does not leave a frozen one until it
// is resumed), StopAllDevices to Intiface Central, the rest line to the
// T-Code device. Freeze used to stop The Handy alone, and pagehide does not
// fire for a frozen page, so a frozen tab left an Intiface or T-Code toy
// running with no engine and no watchdog behind it.
//
// A live session is paused there and then, while the page still runs. A
// frozen page is resumed with its timers intact, and the next tick would
// otherwise restart every toy where it left off, with nobody having watched
// the wearer in between. The banner saying so goes up when the page is back.
const pageAway = createPageAwayTracker();

function stopEveryToyOnPageAway() {
    // One at a time, so a driver that throws cannot keep the stop from the others.
    try { stopHandyOnUnload(); } catch (e) {}
    try { stopAllIntiface(); } catch (e) {}
    try { stopTCode(); } catch (e) {}
}

function handlePageAway(kind) {
    stopEveryToyOnPageAway();
    if (isRemotePage) return;
    // A START or RESUME still waiting for The Handy's answer (see
    // startOrResumeWhenReady) is dropped too, the auto-resume's included:
    // its answer would land once the page is back and start the toys after
    // a stretch nobody watched. Pressing it again asks again.
    if (startGate.cancel()) checkReadiness();
    const running = state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN';
    // A watchdog pause with auto-resume on restarts the toys by itself on the
    // first reading after the page is back. After a stretch nobody watched,
    // that is the wearer's call, so it becomes an ordinary pause.
    const selfResuming = state.sessionStatus === 'PAUSED' && state.hrSignalPaused && advancedSettings.hrAutoResume;
    if (!running && !selfResuming) return;
    pageAway.leave(kind, Date.now(), { wasRunning: running });
    if (running) pauseSession(null);
    if (selfResuming) clearHrSignalPause();
    checkReadiness();
    syncTelemetry();
}

function handlePageBack() {
    if (isRemotePage) return;
    const trip = pageAway.back(Date.now());
    if (!trip) return;
    showAlertBanner(describePageAway(trip), { severity: 'safety', source: 'supervision' });
    checkReadiness();
    syncTelemetry();
}

window.addEventListener('pagehide', (event) => handlePageAway(event.persisted ? 'bfcache' : 'unload'));
// A frozen page runs nothing until it is resumed, so once every toy has had
// its stop it tells every other page that this session no longer drives The
// Handy (crash-recovery.js): another page that recovers a crash meanwhile
// must not leave a Handy to a page that cannot stop it.
document.addEventListener('freeze', () => {
    handlePageAway('freeze');
    pageFrozen = true;
    noteLiveHardware();
    syncVacuglideLinkLock();
});
// Chrome fires resume and then pageshow for a page back from the
// back/forward cache; the banner goes up once.
document.addEventListener('resume', () => {
    pageFrozen = false;
    syncVacuglideLinkLock();
    handlePageBack();
});
window.addEventListener('pageshow', (event) => { if (event.persisted) handlePageBack(); });

// A page that is hidden is not paused for it: a video in another tab is not
// a reason to stop. What is tracked is whether the clock kept up meanwhile,
// and back in view the page settles that first, then asks for the screen
// lock again (the browser dropped it when the page was hidden).
document.addEventListener('visibilitychange', () => {
    if (isRemotePage) return;
    if (document.visibilityState === 'hidden') {
        supervisionClock.noteHidden();
        return;
    }
    haltIfUnsupervised();
    screenWakeLock.visibilityChanged();
    syncScreenWakeLock();
});

// Session History & Funscript Downloader Hook
function saveSessionToHistory(outcome) {
    const history = safeParse('edgeloop_history', []);
    const sessionId = Date.now();
    history.unshift({
        id: sessionId,
        date: new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        duration: state.sessionSeconds,
        edges: state.edges,
        pauses: state.pauses,
        peakHr: state.peakHr,
        outcome,
        // Raw 4 Hz timeline; both funscripts are built from it on download.
        samples: [...funscriptSamples]
    });
    while (history.length > 10) history.pop();
    const result = saveHistoryTrimmed('edgeloop_history', history);
    if (!result.saved) {
        console.warn('Session history could not be saved (storage full or unavailable)');
    } else if (result.dropped > 0 || result.stripped) {
        console.warn(`Storage quota reached: dropped ${result.dropped} oldest session(s)${result.stripped ? ' and the motion trace of this one' : ''}`);
    }
}

// Build the requested channel script for a stored session. New entries carry
// the raw sample timeline; entries written by older versions carry
// pre-built primaryActions / secondaryActions and are exported as-is.
function funscriptForSession(session, channel) {
    if (Array.isArray(session.samples) && session.samples.length > 0) {
        const both = buildFunscripts(session.samples);
        return channel === 'primary' ? both.primary : both.secondary;
    }
    const legacy = channel === 'primary' ? session.primaryActions : session.secondaryActions;
    return toFunscript(Array.isArray(legacy) ? legacy : []);
}

window.downloadFunscript = (sessionId, channel) => {
    const history = safeParse('edgeloop_history', []);
    const session = history.find(s => s.id === sessionId);
    if (!session) return alert("Session log not found.");

    const funscriptPayload = funscriptForSession(session, channel);
    if (funscriptPayload.actions.length === 0) return alert("No motion recorded for this channel during this session.");

    const blob = new Blob([JSON.stringify(funscriptPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ext = channel === 'primary' ? '.funscript' : '.v0.funscript';
    a.href = url;
    a.download = `edgeloop_${sessionId}${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

function renderHistory() {
    const history = safeParse('edgeloop_history', []);
    const list = document.getElementById('historyList');
    if (!list) return;
    if (history.length === 0) {
        list.innerHTML = `<div class="p-4 bg-slate-950 rounded-xl border border-slate-800 text-slate-500 text-xs text-center italic">No completed sessions recorded yet.</div>`;
        return;
    }
    list.innerHTML = '';
    history.forEach((s, idx) => {
        const mins = Math.floor(s.duration / 60);
        const secs = s.duration % 60;
        const item = document.createElement('div');
        item.className = 'p-2.5 bg-slate-950 rounded-xl border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs';
        item.innerHTML = `
        <div>
        <div class="font-bold text-slate-200">#${idx + 1} — ${s.date}</div>
        <div class="text-[10px] text-slate-400 mt-0.5">⏱ ${mins}m ${secs}s &bull; ⚡ ${s.edges} Edges &bull; 🔥 ${s.peakHr} BPM &bull; <span class="text-purple-300 font-semibold">${s.outcome}</span></div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
        <button onclick="downloadFunscript(${s.id}, 'primary')" class="px-2 py-1 bg-purple-950 hover:bg-purple-800 border border-purple-700 text-purple-200 rounded text-[10px] font-mono transition cursor-pointer flex items-center gap-1" title="Download Primary Stroker Funscript">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
        .funscript
        </button>
        <button onclick="downloadFunscript(${s.id}, 'secondary')" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded text-[10px] font-mono transition cursor-pointer flex items-center gap-1" title="Download Secondary Milker Funscript">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
        .v0.funscript
        </button>
        </div>
        `;
        list.appendChild(item);
    });
}
document.getElementById('clearHistoryBtn')?.addEventListener('click', () => {
    safeRemove('edgeloop_history');
    renderHistory();
});

// Partner WebRTC Sync (host side): one controller plus any number of
// read-only viewers. Commands arrive already validated by peer-messages.js.
function setPartnerStatus(text, tone = 'wait') {
    const status = document.getElementById('partnerStatusText');
    if (!status) return;
    status.textContent = text;
    status.className = tone === 'ok' ? 'font-bold text-emerald-400'
        : tone === 'error' ? 'font-bold text-rose-400'
        : 'font-bold text-amber-400';
}

// The version the other page speaks, as webrtc.js last reported it: the
// controller's on the host, the host's on a remote page. Null while nothing
// is known - no controller yet, or no telemetry yet.
let peerVersion = null;

// Both people are told when the two pages run different versions, because
// each one alone sees only a click that did nothing (or, before, a game
// that switched itself off). Only the older page can fix it, by a reload,
// and the notice names which one that is.
function showPeerVersionNotice() {
    if (!peerVersion || peerVersion.matches) return;
    const role = !isRemotePage ? 'host' : isRemoteViewer ? 'viewer' : 'controller';
    showAlertBanner(describePeerVersionMismatch(role, peerVersion.protocol), { severity: 'advisory', source: 'peerVersion' });
}

// The notice describes the page connected right now, so it goes the moment
// that page does, or a page on this version takes its place.
function renderPeerVersion(report) {
    peerVersion = report && typeof report === 'object'
        ? { protocol: report.protocol, matches: report.matches === true }
        : null;
    if (peerVersion && !peerVersion.matches) showPeerVersionNotice();
    else hideAlertBanner('peerVersion');
    if (!isRemotePage && getPeerCounts().controllers > 0) renderControllerStatus();
}

function renderControllerStatus() {
    if (peerVersion && !peerVersion.matches) {
        setPartnerStatus(`Controller Connected - ${peerProtocolRelation(peerVersion.protocol)} version, its mode and game changes are refused`, 'error');
    } else {
        setPartnerStatus('Controller Connected', 'ok');
    }
}

// Header badge ("1C+2V") and the Share modal's viewer list, counted apart.
function renderPeerCounts() {
    const counts = getPeerCounts();
    const badge = document.getElementById('shareControlBadge');
    if (badge) {
        const parts = [];
        if (counts.controllers > 0) parts.push(`${counts.controllers}C`);
        if (counts.viewers > 0) parts.push(`${counts.viewers}V`);
        badge.textContent = parts.join('+');
        badge.title = `${counts.controllers} controller, ${counts.viewers} viewer(s) connected`;
        badge.classList.toggle('hidden', parts.length === 0);
    }
    const viewerBadge = document.getElementById('groupViewerCountBadge');
    if (viewerBadge) viewerBadge.textContent = `${counts.viewers} Watching`;
    const viewerList = document.getElementById('groupViewersList');
    if (viewerList) {
        viewerList.textContent = counts.viewers > 0
            ? `${counts.viewers} read-only viewer(s) receiving live telemetry.`
            : 'No viewers currently connected.';
    }
}

function setupPartnerHost() {
    if (!peerLibraryAvailable()) {
        setPartnerStatus('Signalling library not loaded (CDN blocked or offline). Remote control is unavailable.', 'error');
        ['partnerShareUrl', 'groupShareUrl'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = 'Unavailable: the PeerJS library could not be loaded';
        });
        return;
    }
    initHostPeer({
        onPeerReady: (id) => {
            const share = document.getElementById('partnerShareUrl');
            const group = document.getElementById('groupShareUrl');
            if (share) share.value = `${window.location.origin}${window.location.pathname}?partner=${id}`;
            if (group) group.value = `${window.location.origin}${window.location.pathname}?group_sub=${id}`;
            // Also fires after a signalling reconnect: keep a live controller shown as such.
            if (getPeerCounts().controllers > 0) renderControllerStatus();
            else setPartnerStatus('Ready (Awaiting Controller)');
            renderPeerCounts();
        },
        onPartnerConnected: () => {
            // A new controller: its version is reported right after this, and
            // the notice about whichever page held the seat before goes with
            // that page (a seat taken over is not a disconnect, so nothing
            // else withdraws it).
            renderPeerVersion(null);
            renderPeerCounts();
            syncTelemetry();
        },
        onPeerProtocol: renderPeerVersion,
        onCommandRefused: () => {
            // The partner just tried to change the mode. Say why nothing
            // happened, and send the session's real mode now, so their cards
            // stop claiming a change the host did not make.
            showPeerVersionNotice();
            syncTelemetry();
        },
        onControllerDisconnected: (reason) => {
            // Whatever that page ran, it is gone, and so is the notice about it.
            renderPeerVersion(null);
            setPartnerStatus(reason === 'timeout' ? 'Partner disconnected (no response)' : 'Partner disconnected', 'error');
            renderPeerCounts();
        },
        onViewerConnected: () => {
            renderPeerCounts();
            syncTelemetry();
        },
        onViewerDisconnected: () => renderPeerCounts(),
        onCountsChanged: () => renderPeerCounts(),
        onSignallingLost: () => setPartnerStatus('Signalling lost, reconnecting...', 'error'),
        onPeerClosed: () => {
            setPartnerStatus('Signalling closed. Reopen Share Control to create a new room.', 'error');
            renderPeerCounts();
        },
        onPeerError: (message) => {
            setPartnerStatus(`Signalling error: ${message}`, 'error');
            renderPeerCounts();
        },
        onCommandReceived: (cmd) => {
            if (cmd.type === 'SESSION_STATE') {
                // Start, resume and pause are the one button, which does
                // whichever the host's state calls for; the command has just
                // been checked against that state.
                const action = hostTransportAction(cmd, state.sessionStatus);
                // While Came Early or Finished me is stopping the toys and
                // asking, a partner's START or RESUME is not taken: the
                // wearer has just come. Taken, it drove the toys until the
                // press stopped them again.
                if ((action === 'start' || action === 'resume') && pressQuestion.busy) return;
                if (action === 'stop') stopBtn?.click();
                else if (action) playPauseBtn?.click();
            } else if (cmd.type === 'SESSION_RESET') resetBtn?.click();
            else if (cmd.type === 'ORGASM_TOGGLE') orgasmBtn?.click();
            else if (cmd.type === 'MODE_CHANGE') {
                applyModeSelection(cmd.mode, cmd.enabled);
                syncTelemetry();
            }
        }
    });
}

// ---- Remote page (controller or viewer) ----------------------------------

// A viewer page renders everything but can change nothing. Re-applied after
// every telemetry frame because some renderers reset element classes.
const VIEWER_LOCKED_IDS = [
    'sessionPlayPauseBtn', 'sessionStopBtn', 'sessionResetBtn', 'cameEarlyBtn', 'orgasmBtn',
    'intensitySlider', 'openParamsBtn', 'sessionParamsHeaderBtn',
    'partnerShareBtn', 'historyBtn', 'cardBle', 'cardHandy', 'cardVacuglide', 'cardIntiface', 'cardTCode',
    // Nested in the Edge Training card: a disabled ancestor does not stop a
    // browser from focusing and editing them, so they are disabled themselves.
    'trainHoldSecondsInput', 'trainEdgesInput', 'survivalCalibrateToggle'
];
function lockElement(el) {
    if (!el) return;
    el.disabled = true;
    el.setAttribute('aria-disabled', 'true');
    el.classList.remove('cursor-pointer');
    el.classList.add('opacity-60', 'cursor-not-allowed');
}
function lockViewerControls() {
    VIEWER_LOCKED_IDS.forEach((id) => lockElement(document.getElementById(id)));
    modeCards.forEach(lockElement);
}

// A controller page sends transport, Force Orgasm and mode commands only.
// Everything else is host-only (its handlers return or its state never
// leaves the page), so it is locked rather than left looking clickable.
const CONTROLLER_LOCKED_IDS = [
    'cameEarlyBtn', 'intensitySlider', 'openParamsBtn', 'sessionParamsHeaderBtn',
    'partnerShareBtn', 'cardBle', 'cardHandy', 'cardVacuglide', 'cardIntiface', 'cardTCode',
    // The mode cards stay live (MODE_CHANGE is a legal command), but the two
    // Edge Training numbers inside one of them are host-only settings.
    'trainHoldSecondsInput', 'trainEdgesInput', 'survivalCalibrateToggle'
];
function lockControllerControls() {
    CONTROLLER_LOCKED_IDS.forEach((id) => lockElement(document.getElementById(id)));
}

// Re-applied after every telemetry frame because some renderers reset classes.
function lockRemoteControls() {
    if (isRemoteViewer) lockViewerControls();
    else if (isRemoteController) lockControllerControls();
}

// The typed limits belong to the host: on a remote page the inputs only
// mirror what the host reports.
function lockRemoteLimitInputs() {
    ['minHr', 'maxHr'].forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.disabled = true;
        input.title = 'Set by the host';
        input.classList.add('opacity-70');
    });
}

let lastTelemetryAt = 0;
let remoteLinkUp = false;

function showRemoteBanner(message) {
    showAlertBanner(message, { severity: 'safety', source: 'remote' });
}

// Telemetry arrives every second; a long silence with the channel still
// nominally open means the host is gone.
const REMOTE_TELEMETRY_STALE_MS = 10000;
function checkRemoteLinkHealth(now = Date.now()) {
    if (!remoteLinkUp || remoteLinkLost || !lastTelemetryAt) return;
    if (now - lastTelemetryAt > REMOTE_TELEMETRY_STALE_MS) {
        markRemoteLinkLost(`No telemetry from the host for ${Math.round((now - lastTelemetryAt) / 1000)} s. The host may have closed the page or lost its connection.`);
    }
}

function markRemoteLinkLost(message) {
    remoteLinkLost = true;
    state.remoteHostReady = false;
    setRemoteRoleStatus('Disconnected');
    showRemoteBanner(message);
    checkReadiness();
}

function applyRemoteTelemetry(data) {
    if (!data || data.type !== 'TELEMETRY') return;
    lastTelemetryAt = Date.now();
    // Telemetry proves the data channel is alive even after a signalling
    // error, so the stale check stays armed.
    remoteLinkUp = true;
    if (remoteLinkLost || remoteRoleSuffix !== 'Live') {
        // Also clears a transient "Signalling lost" once frames keep coming.
        remoteLinkLost = false;
        setRemoteRoleStatus('Live');
        hideAlertBanner('remote');
        // The version notice stood under the link report, unless the banner
        // was dismissed while the link was down; the link is back and the
        // other version is not gone, so say it again (it replaces its own
        // sentence rather than doubling it).
        showPeerVersionNotice();
    }
    if (data.hr !== undefined) state.hrCurrent = data.hr;
    if (data.seconds !== undefined) state.sessionSeconds = data.seconds;
    if (data.chosenTargetSeconds !== undefined) state.chosenTargetSeconds = data.chosenTargetSeconds;
    if (data.sessionStatus !== undefined) state.sessionStatus = data.sessionStatus;
    if (data.edges !== undefined) state.edges = data.edges;
    if (data.pauses !== undefined) state.pauses = data.pauses;
    if (data.strokerSpeed !== undefined) state.strokerSpeed = data.strokerSpeed;
    if (data.prostateSpeed !== undefined) state.prostateSpeed = data.prostateSpeed;
    if (data.history !== undefined) state.history = data.history;
    if (data.minHr !== undefined) state.effectiveMinHr = data.minHr;
    if (data.maxHr !== undefined) state.effectiveMaxHr = data.maxHr;
    if (data.edgeTriggerHr !== undefined) state.edgeTriggerHr = data.edgeTriggerHr;
    // The Edge Training card and the pullback input are host settings, so a
    // remote page mirrors the host rather than its own localStorage. Until a
    // frame carries them they stay blank (see syncParamsUI), never a number
    // from this browser.
    renderRemoteHostSettings(data);
    // The HOLD TO badge is written by the host's engine loop, which never
    // runs here, so a remote page labels the chart's pullback line itself.
    const remoteHoldBadge = document.getElementById('edgeHoldBadge');
    const remoteHoldText = document.getElementById('edgeHoldText');
    const showHoldBadge = shouldDrawPullbackLine(state.edgeTriggerHr, state.effectiveMaxHr);
    if (remoteHoldText && showHoldBadge) remoteHoldText.textContent = `${state.edgeTriggerHr}`;
    remoteHoldBadge?.classList.toggle('hidden', !showHoldBadge);
    if (data.teaseMode !== undefined) state.teaseMode = data.teaseMode;
    if (data.gameMode === 'off') state.gameMode = null;
    else if (data.gameMode !== undefined) state.gameMode = data.gameMode;
    if (data.activeMode !== undefined) state.activeMode = data.activeMode;
    if (data.teaseMode !== undefined || data.gameMode !== undefined || data.activeMode !== undefined) {
        highlightModeCard();
        renderModeDetail();
    }
    // Taken before setOrgasmMode, which repaints the button from them.
    if (data.orgasmSecondsLeft !== undefined) state.remoteOrgasmSecondsLeft = data.orgasmSecondsLeft;
    if (data.orgasmRefusal !== undefined) state.remoteOrgasmRefusal = data.orgasmRefusal;
    if (data.orgasmMode !== undefined && data.orgasmMode !== state.orgasmMode) setOrgasmMode(data.orgasmMode);
    renderForceOrgasmButton();
    if (data.ready !== undefined) state.remoteHostReady = data.ready;
    // Watchdog state is rendered, never evaluated, on a remote page.
    if (data.hrSignal) {
        state.hrSignalState = data.hrSignal.status;
        state.hrNoContact = data.hrSignal.noContact;
        renderHrSignal({
            status: state.hrSignalState,
            noContact: state.hrNoContact,
            sinceValidMs: data.hrSignal.silentMs
        });
    }
    checkReadiness();

    const hrDisplay = document.getElementById('hrDisplay');
    if (hrDisplay) hrDisplay.textContent = state.hrCurrent;
    const minInput = document.getElementById('minHr');
    const maxInput = document.getElementById('maxHr');
    if (minInput) minInput.value = state.effectiveMinHr;
    if (maxInput) maxInput.value = state.effectiveMaxHr;
    const strokerVal = document.getElementById('strokerVal');
    const strokerBar = document.getElementById('strokerBar');
    const prostateVal = document.getElementById('prostateVal');
    const prostateBar = document.getElementById('prostateBar');
    if (strokerVal) strokerVal.textContent = `${Math.round(state.strokerSpeed)}%`;
    if (strokerBar) strokerBar.style.width = `${state.strokerSpeed}%`;
    if (prostateVal) prostateVal.textContent = `${Math.round(state.prostateSpeed)}%`;
    if (prostateBar) prostateBar.style.width = `${state.prostateSpeed}%`;
    const edgeEl = document.getElementById('edgeCount');
    const pauseEl = document.getElementById('pauseCount');
    if (edgeEl) edgeEl.textContent = state.edges;
    if (pauseEl) pauseEl.textContent = state.pauses;
    updateTimerDisplay();
    redrawChart();
    lockRemoteControls();
}

// A remote page renders the host's game settings; it never computes them.
function renderRemoteHostSettings(data) {
    const trainHold = document.getElementById('trainHoldSecondsInput');
    const trainEdges = document.getElementById('trainEdgesInput');
    const holdInput = document.getElementById('edgeHoldPercentInput');
    if (trainHold && data.trainHoldSeconds !== undefined) trainHold.value = data.trainHoldSeconds;
    if (trainEdges && data.trainEdges !== undefined) trainEdges.value = data.trainEdges;
    if (holdInput && data.edgeHoldPercent !== undefined) holdInput.value = data.edgeHoldPercent;
}

function syncTelemetry() {
    if (isRemotePage) return;
    const readiness = hardwareReadiness();
    broadcastPeerTelemetry({
        type: 'TELEMETRY',
        hr: state.hrCurrent,
        seconds: state.sessionSeconds,
        chosenTargetSeconds: state.chosenTargetSeconds,
        sessionStatus: state.sessionStatus,
        edges: state.edges,
        pauses: state.pauses,
        strokerSpeed: state.strokerSpeed,
        prostateSpeed: state.prostateSpeed,
        history: state.history,
        // The WORKING limits after every offset, so remote charts draw the
        // guide lines where edges really trigger.
        minHr: state.effectiveMinHr,
        maxHr: state.effectiveMaxHr,
        edgeTriggerHr: state.edgeTriggerHr,
        activeMode: state.activeMode,
        teaseMode: state.teaseMode,
        gameMode: state.gameMode || 'off',
        // The host's game settings. A remote page holds its own persisted
        // copies of these; without them on the wire the Edge Training card a
        // partner is reading quotes THEIR numbers for the wearer's session.
        trainHoldSeconds: clampTrainHoldSeconds(advancedSettings.trainHoldSeconds),
        trainEdges: clampTrainEdges(advancedSettings.trainEdges),
        edgeHoldPercent: clampEdgeHoldPercent(advancedSettings.edgeHoldPercent),
        orgasmMode: state.orgasmMode,
        // The countdown on the wearer's Force Orgasm button (0 = none) and
        // why the host would refuse to switch it on, so a partner's button
        // reads what the wearer's does.
        orgasmSecondsLeft: forceOrgasmSecondsLeftNow(),
        orgasmRefusal: forceOrgasmRefusalNow(),
        ready: readiness.hrReady && readiness.toyReady,
        hrSignal: {
            status: state.hrSignalState,
            noContact: state.hrNoContact,
            silentMs: state.hrSignalSilentMs
        }
    });
}

// Copy a share link. navigator.clipboard only exists in secure contexts
// (https / localhost): on plain http over a LAN fall back to selecting the
// field and execCommand('copy'). Never throws; when even that fails the
// text is left selected so the user can copy it by hand.
async function copyLinkFrom(inputId, btnId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if (!input || !input.value) return false;
    let copied = false;
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(input.value);
            copied = true;
        }
    } catch (e) {
        copied = false;
    }
    if (!copied) {
        try {
            input.focus();
            input.select();
            input.setSelectionRange(0, input.value.length);
            copied = typeof document.execCommand === 'function' && document.execCommand('copy');
        } catch (e) {
            copied = false;
        }
    }
    if (btn) {
        btn.textContent = copied ? 'Copied!' : 'Select & copy';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    }
    if (!copied) {
        try {
            input.focus();
            input.select();
        } catch (e) { /* nothing more to do */ }
    }
    return copied;
}

document.getElementById('copyShareUrlBtn')?.addEventListener('click', () => {
    copyLinkFrom('partnerShareUrl', 'copyShareUrlBtn').catch(() => {});
});

document.getElementById('copyGroupUrlBtn')?.addEventListener('click', () => {
    copyLinkFrom('groupShareUrl', 'copyGroupUrlBtn').catch(() => {});
});

// Boot Initialization
initHandyRoleUI();
initVacuglidePanel();
renderLearningStatus();
syncParamsUI();
// A persisted mic setting waits for a tap (browser gesture rule).
if (advancedSettings.micEnabled && !isRemotePage) showMicReenable(true);
watchChartResize(document.getElementById('hrChart'), redrawChart);
if (isRemotePage && remoteRoom) {
    lockRemoteLimitInputs();
    lockRemoteControls();
    const started = initRemotePeer(remoteRoom, isRemoteViewer ? 'viewer' : 'controller', {
        onConnected: () => {
            remoteLinkUp = true;
            remoteLinkLost = false;
            lastTelemetryAt = Date.now();
            setRemoteRoleStatus('Live');
            hideAlertBanner('remote');
        },
        onTelemetryReceived: applyRemoteTelemetry,
        onPeerProtocol: renderPeerVersion,
        onDisconnected: () => {
            remoteLinkUp = false;
            markRemoteLinkLost('Host disconnected. Reload this link once the host has reopened Share Control.');
        },
        onSignallingLost: () => setRemoteRoleStatus(remoteLinkLost ? 'Disconnected' : 'Signalling lost'),
        onPeerClosed: () => {
            remoteLinkUp = false;
            markRemoteLinkLost('The signalling connection closed. Reload this link to reconnect.');
        },
        onPeerError: (message) => {
            remoteLinkUp = false;
            markRemoteLinkLost(`Signalling error: ${message}.`);
        }
    });
    if (!started) {
        markRemoteLinkLost('This remote link cannot start: the PeerJS signalling library could not be loaded (CDN blocked or offline).');
        setRemoteRoleStatus('Unavailable');
    }
}
checkReadiness();
updateEngine();
redrawChart();
if (!isRemotePage) maybeShowFirstRunWizard();
