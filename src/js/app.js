import { state, advancedSettings } from './state.js';
import { calculateEngineOutputs, resolveEngineMode, hasReleasedEdge } from './engine.js';
import {
    ORGASM_BOOST_CAP,
    computeEffectiveCeiling,
    sanitizeHrLimits,
    parseSessionDuration,
    countSurvivalBreach,
    isSurvivalDefeated
} from './session-rules.js';
import { safeGet, safeParse, safeSet, safeRemove, saveHistoryTrimmed } from './storage.js';
import { pushSample, buildFunscripts, toFunscript } from './funscript.js';
import { drawTelemetryChart, watchChartResize } from './chart.js';
import { connectBleHeartRate, disconnectBle, isBleConnected, isBleReconnecting } from './hardware/ble.js';
import { describeBluetoothSupport, describeBleError } from './hardware/ble-protocol.js';
import { createHrWatchdog, clampStaleSeconds } from './hr-watchdog.js';
import { connectHandy, disconnectHandy, dispatchHandy, handyConnected, setHandyHandlers } from './hardware/handy.js';
import { normalizeEnvelope } from './hardware/handy-protocol.js';
import {
    connectIntifaceServer,
    disconnectIntiface,
    rescanIntiface,
    dispatchIntiface,
    stopAllIntiface,
    setAxisRole,
    setAxisMaxCap,
    setAxisInvert,
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
    ALTERNATE_SECONDS_MAX
} from './hardware/intiface.js';
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
    tcodeHasRole
} from './hardware/tcode.js';
import { describeSerialSupport } from './hardware/tcode-protocol.js';
import {
    initHostPeer,
    initRemotePeer,
    broadcastPeerTelemetry,
    sendPeerCommand,
    pruneStalePeers,
    getPeerCounts,
    peerLibraryAvailable
} from './webrtc.js';
import {
    speakPrompt,
    speakNow,
    cancelSpeech,
    setMindgamePrompt,
    startMicMonitor,
    stopMicMonitor,
    sampleMicLevel,
    listSpeechVoices
} from './voice.js';

// Load persisted settings. The old 15/85 default envelope is migrated to
// 0/100 exactly once (flagged), so a user who deliberately types 15/85 later
// keeps it.
const storedSettings = safeParse('edgeloop_advanced_settings', null);
if (storedSettings && typeof storedSettings === 'object' && !Array.isArray(storedSettings)) {
    const parsed = storedSettings;
    let migrated = false;
    if (!parsed.envelopeMigrated) {
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
    Object.assign(advancedSettings, parsed);
    if (migrated) persistSettings();
}

// Heart-rate signal watchdog (hr-watchdog.js). Its clocks are reset on BLE
// connect, on START / RESUME and when the simulator is engaged; its settings
// mirror the Guards tab and are re-applied after load, apply and import.
const hrWatchdog = createHrWatchdog();
function syncWatchdogSettings() {
    advancedSettings.hrStaleSeconds = clampStaleSeconds(advancedSettings.hrStaleSeconds);
    advancedSettings.hrAutoResume = advancedSettings.hrAutoResume !== false;
    hrWatchdog.configure({
        staleMs: advancedSettings.hrStaleSeconds * 1000,
        autoResume: advancedSettings.hrAutoResume
    });
}
syncWatchdogSettings();
hrWatchdog.reset(Date.now());

// Live funscript sample buffer: one 4 Hz timeline of { at, speed, secondary,
// strokeMin, strokeMax }. Both channel scripts are built from it on export.
let funscriptSamples = [];
let funscriptSessionStart = 0;

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

// Master DOM Elements
const playPauseBtn = document.getElementById('sessionPlayPauseBtn');
const playPauseText = document.getElementById('playPauseText');
const playPauseIcon = document.getElementById('playPauseIcon');
const stopBtn = document.getElementById('sessionStopBtn');
const resetBtn = document.getElementById('sessionResetBtn');
const cameEarlyBtn = document.getElementById('cameEarlyBtn');
const orgasmBtn = document.getElementById('orgasmBtn');
const orgasmBtnText = document.getElementById('orgasmBtnText');

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
    setTimeout(maybeShowFirstRunWizard, 50);
});

// Disconnect / Watchdog Alert Banner
document.getElementById('dismissBannerBtn')?.addEventListener('click', () => {
    document.getElementById('disconnectBanner')?.classList.add('hidden');
});

function triggerDisconnectAlert(message) {
    const banner = document.getElementById('disconnectBanner');
    const msg = document.getElementById('disconnectMsg');
    if (msg) msg.textContent = message;
    if (banner) banner.classList.remove('hidden');

    if (pauseSession(null)) syncTelemetry();
    checkReadiness();
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
    dispatchHardware(0, 0, 0, 100, true);
    if (voiceText) cueVoice(voiceText);
    return true;
}

// Put the transport button into the look for `status`. Shared by start,
// pause, stop / reset and the remote controller's telemetry renderer.
function renderTransport(status) {
    if (!playPauseBtn) return;
    playPauseBtn.disabled = false;
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
}

// Grey out the transport with a reason while the hardware is not ready.
function renderTransportWaiting(reason) {
    if (!playPauseBtn) return;
    playPauseBtn.disabled = true;
    if (playPauseText) playPauseText.textContent = reason;
    playPauseBtn.className = "flex-1 bg-slate-800 text-slate-500 font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 border border-slate-700/50 cursor-not-allowed";
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
        || (isIntifaceConnected() && intifaceDevices.size > 0)
        || (isTCodeConnected() && countAssignedTCodeAxes() > 0)
    );
    return { hrReady, toyReady };
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

    if (active) {
        playPauseBtn.disabled = false;
        return;
    }

    const { hrReady, toyReady } = hardwareReadiness();
    if (!hrReady && !toyReady) renderTransportWaiting("WAITING FOR HR SENSOR & TOY");
    else if (!hrReady) renderTransportWaiting("WAITING FOR HR SENSOR");
    else if (!toyReady) renderTransportWaiting("WAITING FOR TOY CONNECTION");
    else renderTransport('IDLE');
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

// Full Stroke Slide Toggle
const fullStrokeToggleBtn = document.getElementById('fullStrokeToggleBtn');
const fullStrokeToggleKnob = document.getElementById('fullStrokeToggleKnob');
fullStrokeToggleBtn?.addEventListener('click', () => {
    state.alwaysFullStroke = !state.alwaysFullStroke;
    if (fullStrokeToggleBtn && fullStrokeToggleKnob) {
        if (state.alwaysFullStroke) {
            fullStrokeToggleBtn.className = "w-11 h-6 bg-purple-600 rounded-full p-0.5 transition cursor-pointer relative";
            fullStrokeToggleKnob.className = "w-5 h-5 bg-white rounded-full transition transform translate-x-5 shadow";
        } else {
            fullStrokeToggleBtn.className = "w-11 h-6 bg-slate-800 rounded-full p-0.5 transition cursor-pointer relative";
            fullStrokeToggleKnob.className = "w-5 h-5 bg-slate-400 rounded-full transition transform translate-x-0";
        }
    }
    updateEngine();
});

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
    updateHwEnvelopeDisplay();
}

// Validate the typed envelope: clamp to 0-100, keep at least a 10% stroke by
// moving the bound the user did NOT just edit, then write the corrected values
// back into every input (both modals) and the persisted settings. `changed`
// is 'min' or 'max'; `source` is the input being edited (defaults to the
// first input of that bound).
function applyHwEnvelopeInput(changed, commit = false, source = null) {
    const edited = source || hwEnvelopeInputs(changed)[0] || null;
    const typed = edited && edited.value !== '' ? edited.value : null;
    const rawMin = changed === 'min' && typed !== null ? typed : advancedSettings.handyHwMin;
    const rawMax = changed === 'max' && typed !== null ? typed : advancedSettings.handyHwMax;
    const env = normalizeEnvelope(rawMin, rawMax, changed);
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

    // Envelope inputs live in the Handy AND the TCode modal, all bound to the
    // same persisted setting; editing either keeps the others in sync.
    syncHwEnvelopeInputs();
    ['min', 'max'].forEach((bound) => {
        hwEnvelopeInputs(bound).forEach((el) => {
            el.addEventListener('input', () => applyHwEnvelopeInput(bound, false, el));
            el.addEventListener('change', () => applyHwEnvelopeInput(bound, true, el));
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
        updateEngine();
    };

    pBtn?.addEventListener('click', () => applyRole('primary'));
    sBtn?.addEventListener('click', () => applyRole('secondary'));
    oBtn?.addEventListener('click', () => applyRole('off'));
    applyRole(state.handyRole || 'primary');
}

// Engine Calculation Loop
function updateEngine() {
    if (isRemotePage) return;

    const limits = readHrLimits();
    const min = limits.minHr;
    const typedMax = limits.maxHr;
    let hr = state.hrCurrent;
    if (!Number.isFinite(hr) || hr < 35) hr = min;

    // Dual Stimulation Offset Check: a stroker (primary) AND an internal toy
    // (secondary) are both live. The Handy counts for whichever role it holds;
    // Intiface and TCode axes count for the role they are assigned.
    const intifaceHasRole = (role) => Array.from(intifaceDevices.values()).some(d => d.axes.some(a => a.role === role));
    const serialHasRole = (role) => isTCodeConnected() && tcodeHasRole(role);
    const hasPrimary = (handyConnected && state.handyRole === 'primary') || intifaceHasRole('primary') || serialHasRole('primary');
    const hasSecondary = (handyConnected && state.handyRole === 'secondary') || intifaceHasRole('secondary') || serialHasRole('secondary');
    const isDualStimActive = hasPrimary && hasSecondary;

    // The working ceiling: typed Climax HR minus learned / dual-stim / decay
    // offsets (never raised by any of them), plus the explicit Force Orgasm
    // boost. Guards and games read the same number from state.
    const ceiling = computeEffectiveCeiling({
        minHr: min,
        maxHr: typedMax,
        learnedOffset: advancedSettings.learningProfile?.suggestedMaxHrOffset || 0,
        dualStimActive: isDualStimActive,
        dualDampening: Boolean(advancedSettings.dualDampening),
        dualDampeningBpm: advancedSettings.dualDampeningBpm,
        adaptiveDecay: Boolean(advancedSettings.adaptiveDecay),
        edges: state.edges,
        decayEdgeCount: advancedSettings.decayEdgeCount,
        decayBpm: advancedSettings.decayBpm,
        decayFloor: advancedSettings.decayFloor,
        orgasmBoost: state.orgasmMode ? state.orgasmBoost : 0
    });
    const max = ceiling.maxHr;
    // The microphone boost may push the working HR up to the EFFECTIVE
    // ceiling (after every offset), never past it and never downward.
    if (advancedSettings.micEnabled && state.micBoost > 0 && hr < max) {
        hr = Math.min(max, hr + state.micBoost);
    }
    state.effectiveMinHr = min;
    state.effectiveMaxHr = max;
    state.effectiveHr = hr;

    const hrDisplay = document.getElementById('hrDisplay');
    if (hrDisplay) hrDisplay.textContent = hr;
    if (!Number.isFinite(state.peakHr) || hr > state.peakHr) state.peakHr = hr;

    const learnBadge = document.getElementById('learnBadge');
    const learnAmount = document.getElementById('learnAmountText');
    if (learnAmount) learnAmount.textContent = ceiling.learnedOffset;
    learnBadge?.classList.toggle('hidden', !(ceiling.learnedOffset > 0));

    const dualBadge = document.getElementById('dualStimBadge');
    if (dualBadge) {
        dualBadge.textContent = `DUAL STIM (-${ceiling.dualOffset} BPM)`;
        dualBadge.classList.toggle('hidden', !(ceiling.dualOffset > 0));
    }

    const decayBadge = document.getElementById('decayBadge');
    const decayText = document.getElementById('decayAmountText');
    if (decayText) decayText.textContent = ceiling.appliedDecay;
    decayBadge?.classList.toggle('hidden', !(ceiling.totalDecay > 0));

    // Shown whenever the working ceiling differs from the typed Climax HR.
    const ceilingBadge = document.getElementById('effectiveCeilingBadge');
    const ceilingLabel = document.getElementById('effectiveCeilingLabel');
    const ceilingText = document.getElementById('effectiveCeilingText');
    if (ceilingLabel) ceilingLabel.textContent = (state.orgasmMode && ceiling.orgasmBoost > 0) ? 'OVERDRIVE CEILING' : 'CEILING';
    if (ceilingText) ceilingText.textContent = max;
    ceilingBadge?.classList.toggle('hidden', max === typedMax);

    const result = calculateEngineOutputs({
        hr,
        minHr: min,
        maxHr: max,
        activeMode: resolveEngineMode(state.activeMode),
        sessionStatus: state.sessionStatus,
        rampdownSecondsLeft: state.rampdownSecondsLeft,
        isEdged: state.isEdged,
        orgasmMode: state.orgasmMode,
        gamma: advancedSettings.gammaCurve,
        intensityValue: state.intensityValue,
        edgeStrokeDepth: advancedSettings.edgeStrokeDepth,
        handyHwMin: advancedSettings.handyHwMin,
        handyHwMax: advancedSettings.handyHwMax,
        sessionSeconds: state.sessionSeconds,
        warmupMinutes: advancedSettings.warmupMinutes,
        cadenceBreathing: advancedSettings.cadenceBreathing,
        milkingWave: advancedSettings.milkingWave,
        stallGuardEngaged: state.stallGuardEngaged,
        ceilingBehaviour: advancedSettings.ceilingBehaviour,
        ruinHoldSeconds: state.ruinHoldSeconds,
        oracleState: state.oracleState,
        survivalSpeedFloor: state.survivalSpeedFloor
    });

    if (result.newEdgeTriggered) {
        state.edges += 1;
        const edgeEl = document.getElementById('edgeCount');
        if (edgeEl) edgeEl.textContent = state.edges;
        if (state.activeMode === 'ruin') state.ruinHoldSeconds = 18;
        reverseIntifaceRotation('edge');
        cueVoice('Edge. Back off.');
    }

    state.isEdged = result.isEdged;
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

    const cutoffEl = document.getElementById('cutoffNotice');
    if (cutoffEl) {
        cutoffEl.classList.toggle('hidden', !state.isEdged || state.orgasmMode || state.sessionStatus === 'RAMPDOWN' || state.stallGuardEngaged);
    }

    const stallNotice = document.getElementById('stallGuardNotice');
    if (stallNotice) stallNotice.classList.toggle('hidden', !state.stallGuardEngaged);

    updateWarmupBadge();
    updateGameNotice();

    dispatchHardware(result.primaryPercent, result.secondaryPercent, result.strokeMinPercent, result.strokeMaxPercent);
}

// Physical stroke bounds to send to the toys. engine.js has ALREADY mapped
// strokeMin/strokeMax into the hardware envelope, so they are passed through;
// "Full Length Strokes Only" swaps in the full envelope instead of raw 0-100
// so the user's typed guards are never exceeded.
function effectiveStrokeRange(strokeMin, strokeMax) {
    const env = normalizeEnvelope(advancedSettings.handyHwMin, advancedSettings.handyHwMax);
    if (state.alwaysFullStroke) return { min: env.min, max: env.max, env };
    return { min: strokeMin, max: strokeMax, env };
}

function dispatchHardware(primarySpeed, secondarySpeed, strokeMin, strokeMax, force = false) {
    if (isRemotePage) return;

    let targetHandySpeed = 0;
    const handyCap = (state.handyMaxCap ?? 100) / 100;
    if (state.handyRole === 'primary') {
        targetHandySpeed = Math.round(primarySpeed * handyCap);
    } else if (state.handyRole === 'secondary') {
        targetHandySpeed = Math.round(secondarySpeed * handyCap);
    } else {
        targetHandySpeed = 0;
    }

    const range = effectiveStrokeRange(strokeMin, strokeMax);

    dispatchHandy(targetHandySpeed, range.min, range.max, force, range.env.min, range.env.max);
    // Intiface linear axes run on their own per-leg timers; this call only
    // updates the planner inputs (and, with force, issues StopAllDevices).
    dispatchIntiface(primarySpeed, secondarySpeed, range.min, range.max, range.env.min, range.env.max, force);
    // Same for the direct T-Code serial device: a forced zero dispatch is an
    // immediate stop (every axis to rest on one line).
    dispatchTCode(primarySpeed, secondarySpeed, range.min, range.max, range.env.min, range.env.max, force);
}

// Queue a spoken cue (voice.js keeps a short queue, so back-to-back cues are
// all heard instead of cutting each other off). An `urgent` cue (signal
// lost, stop) jumps the queue and silences whatever was waiting.
function cueVoice(text, urgent = false) {
    if (!advancedSettings.voiceEnabled || !text) {
        setMindgamePrompt(text || '', Boolean(advancedSettings.voiceEnabled && text));
        return;
    }
    const now = Date.now();
    if (!urgent && text === state.lastSpokenPrompt && (now - (state.lastSpokenAt || 0) < 7000)) return;
    state.lastSpokenPrompt = text;
    state.lastSpokenAt = now;
    setMindgamePrompt(text, true);
    if (urgent) speakNow(text, advancedSettings.voiceURI);
    else speakPrompt(true, text, advancedSettings.voiceURI);
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

function updateGameNotice() {
    const notice = document.getElementById('gameNotice');
    if (!notice) return;
    let text = '';
    if (state.activeMode === 'oracle' && (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN')) {
        if (state.oracleState === 'HOLD') text = `THE ORACLE: HOLDING ${state.oracleTimer}s — FATE PENDING`;
        else if (state.oracleState === 'CLIMAX') text = 'THE ORACLE: CLIMAX';
        else if (state.oracleState === 'DENIAL') text = 'THE ORACLE: DENIAL';
        else if (state.oracleState === 'PURGATORY') text = 'THE ORACLE: PURGATORY';
        else text = 'THE ORACLE: APPROACHING THE CEILING';
    } else if (state.activeMode === 'survival' && state.sessionStatus === 'RUNNING') {
        text = `SURVIVAL: FLOOR ${Math.round(state.survivalSpeedFloor)}% — STAY UNDER YOUR LIMIT`;
    }
    notice.textContent = text || 'GAME MODE ACTIVE';
    notice.classList.toggle('hidden', !text);
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
    return parsed.targetSeconds;
}

// Zero every per-session counter and its display. Called when a session
// stops, on Reset, and again on START so a new run can never inherit time,
// edges or motion samples from the previous one.
function resetSessionCounters() {
    state.sessionSeconds = 0;
    state.chosenTargetSeconds = 0;
    state.edges = 0;
    state.pauses = 0;
    state.peakHr = Number.isFinite(state.hrCurrent) ? state.hrCurrent : 70;
    state.isEdged = false;
    state.orgasmBoost = 0;
    state.rampdownSecondsLeft = 45;
    state.resumeStatus = null;
    state.durationFallback = false;
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
    state.survivalSpeedFloor = 30;
    state.survivalTimer = 0;
    state.survivalBreachTicks = 0;
    state.edgeStallSeconds = 0;
    state.stallGuardEngaged = false;
    state.ruinHoldSeconds = 0;
    state.lastSpokenPrompt = '';
    document.getElementById('stallGuardNotice')?.classList.add('hidden');
    document.getElementById('gameNotice')?.classList.add('hidden');
}

function tickSessionGuardsAndGames() {
    if (state.sessionStatus !== 'RUNNING') return;

    if (state.ruinHoldSeconds > 0) state.ruinHoldSeconds -= 1;

    // Guards and games judge against the SAME ceiling and HR the engine used
    // on its last tick (after dual-stim / decay / learned offsets and mic
    // boost), never the raw typed Climax HR.
    const ceiling = Number.isFinite(state.effectiveMaxHr) ? state.effectiveMaxHr : readHrLimits().maxHr;
    const hr = Number.isFinite(state.effectiveHr) ? state.effectiveHr : state.hrCurrent;
    const nearCeiling = hr >= (ceiling - 2);

    // The stall guard only has something to cut in Crawl mode: with Full
    // Stop the primary is already parked at 0% at the ceiling.
    const crawlAtCeiling = advancedSettings.ceilingBehaviour !== 'stop';
    if (advancedSettings.stallGuard && crawlAtCeiling && state.isEdged && !state.orgasmMode && state.activeMode !== 'oracle' && state.activeMode !== 'survival') {
        state.edgeStallSeconds += 1;
        if (state.edgeStallSeconds >= (advancedSettings.stallGuardSeconds || 8)) {
            if (!state.stallGuardEngaged) {
                state.stallGuardEngaged = true;
                cueVoice('Stall guard. Primary halted. Recover.');
            }
        }
    } else if (!nearCeiling || !state.isEdged) {
        if (state.stallGuardEngaged) cueVoice('Recovered. Resume.');
        state.edgeStallSeconds = 0;
        state.stallGuardEngaged = false;
    }

    const warmupSeconds = Math.max(0, advancedSettings.warmupMinutes || 0) * 60;
    if (warmupSeconds > 0 && state.sessionSeconds === warmupSeconds) {
        cueVoice('Warm up complete.');
    }

    if (advancedSettings.micEnabled && state.micAnalyser) {
        const level = sampleMicLevel(state);
        const threshold = advancedSettings.micSensitivityThreshold || 35;
        state.micBoost = level >= threshold ? Math.round((level - threshold) / 8) : 0;
        document.getElementById('micActiveBadge')?.classList.toggle('hidden', false);
    } else {
        state.micBoost = 0;
        document.getElementById('micActiveBadge')?.classList.add('hidden');
    }

    if (state.activeMode === 'oracle') {
        if (state.oracleState === 'IDLE' || state.oracleState === 'APPROACH') {
            if (state.oracleState !== 'APPROACH') {
                state.oracleState = 'APPROACH';
                cueVoice('The Oracle is watching. Climb.');
            }
            if (state.isEdged) {
                state.oracleState = 'HOLD';
                state.oracleTimer = 15;
                cueVoice('Hold. Fifteen seconds.');
            }
        } else if (state.oracleState === 'HOLD') {
            state.oracleTimer = Math.max(0, state.oracleTimer - 1);
            if (state.oracleTimer <= 0) {
                const roll = Math.random();
                if (roll < 0.33) {
                    state.oracleState = 'CLIMAX';
                    if (!state.orgasmMode) orgasmBtn?.click();
                    cueVoice('The Oracle chooses climax.');
                } else if (roll < 0.66) {
                    state.oracleState = 'DENIAL';
                    stopSession('Oracle Denial', 'The Oracle chooses denial.');
                    return;
                } else {
                    state.oracleState = 'PURGATORY';
                    state.oracleTimer = 0;
                    cueVoice('The Oracle chooses purgatory.');
                }
            }
        } else if (state.oracleState === 'PURGATORY') {
            // Purgatory lasts 28 s, but the edge flag is only cleared once the
            // pulse has genuinely dropped below the release band; resetting it
            // while HR still sits at the ceiling would count a phantom edge.
            state.oracleTimer += 1;
            if (state.oracleTimer >= 28 && hasReleasedEdge(hr, ceiling)) {
                state.oracleState = 'APPROACH';
                state.oracleTimer = 0;
                state.isEdged = false;
                cueVoice('Purgatory resets. Climb again.');
            }
        }
    } else if (state.activeMode === 'survival') {
        state.survivalTimer += 1;
        state.survivalSpeedFloor = Math.min(100, 28 + state.survivalTimer * 0.45);
        // One spike is not a defeat: the ceiling must be breached on
        // consecutive ticks (SURVIVAL_BREACH_TICKS) before the game ends.
        state.survivalBreachTicks = state.orgasmMode ? 0 : countSurvivalBreach(state.survivalBreachTicks, hr, ceiling);
        if (isSurvivalDefeated(state.survivalBreachTicks)) {
            stopSession('Survival Defeat', 'Survival failed. Limit breached.');
            return;
        }
        if (state.survivalBreachTicks > 0) cueVoice('Over the limit. Drop it.');
    }
}

// 250ms Live Funscript Sampling Loop (4Hz). Records what was really sent to
// the toys (speed plus the physical stroke zone, honouring "Full Length
// Strokes Only"); the buffer is capped at four hours, oldest dropped first.
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
    const valid = hrWatchdog.recordPacket(now, bpm, sensorContact);
    state.hrNoContact = !valid || sensorContact === false;
    document.getElementById('hrContactHint')?.classList.toggle('hidden', !state.hrNoContact);
    if (!valid) return false;
    state.hrCurrent = bpm;
    state.lastHrTimestamp = now;
    state.history.push(bpm);
    if (state.history.length > 60) state.history.shift();
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
    return `${name}: no valid heart-rate reading for ${secs} s (${why}). Motors paused for safety.`;
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
    // Auto-resume is off: leave the session paused, drop the overlay and
    // keep a badge up until the user presses RESUME.
    state.hrSignalPaused = false;
    state.hrSignalState = 'ok';
    state.hrSignalSilentMs = 0;
    renderHrSignal(null);
    showHrSignalBadge('SIGNAL BACK, PRESS RESUME', 0);
}

function resumeAfterSignalReturn() {
    state.hrSignalPaused = false;
    if (!startOrResumeSession()) return;
    document.getElementById('disconnectBanner')?.classList.add('hidden');
    cueVoice('Signal restored. Resuming.');
    showHrSignalBadge('SIGNAL RESTORED, RESUMED', 6000);
    syncTelemetry();
    updateEngine();
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
        triggerDisconnectAlert(describeHrLoss(verdict));
        cueVoice('Heart rate signal lost. Motors stopped.', true);
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
    drawTelemetryChart(chartEl, state.history, state.effectiveMinHr, state.effectiveMaxHr);
}

// 1-Second Master Clock
setInterval(() => {
    if (isRemotePage) {
        renderRemoteClock();
        return;
    }

    if (state.sessionStatus === 'RUNNING') {
        state.sessionSeconds += 1;
        updateTimerDisplay();
        // Refresh the engine first so the guards and games below judge THIS
        // second's HR, ceiling and edge flag, not the previous tick's.
        updateEngine();
        tickSessionGuardsAndGames();

        if (state.chosenTargetSeconds > 0 && state.sessionSeconds >= state.chosenTargetSeconds) {
            handleTargetTimeReached();
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
        if (state.rampdownSecondsLeft <= 0) stopSession("Soft Landing (Edged Out)");
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

    pruneStalePeers(Date.now());
    syncTelemetry();
    updateEngine();
    redrawChart();
}, 1000);

function handleTargetTimeReached() {
    if (state.endgameType === 'orgasm') {
        if (!state.orgasmMode && orgasmBtn) orgasmBtn.click();
    } else if (state.endgameType === 'rampdown') {
        state.sessionStatus = 'RAMPDOWN';
        state.rampdownSecondsLeft = 45;
        document.getElementById('rampdownNotice')?.classList.remove('hidden');
    } else {
        stopSession("Denied");
    }
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
// in neither state. Both paths give the watchdog a fresh grace window.
function startOrResumeSession() {
    if (state.sessionStatus !== 'IDLE' && state.sessionStatus !== 'PAUSED') return false;
    let resumingRampdown = false;
    if (state.sessionStatus === 'IDLE') {
        // A fresh run never inherits time, edges or samples from the last one.
        resetSessionCounters();
        setOrgasmMode(false);
        funscriptSessionStart = Date.now();
        resetGameState();
        state.chosenTargetSeconds = pickSessionTargetSeconds();
        updateTimerDisplay();
        cueVoice('Session started. Breathe.');
    } else {
        // Resume into the rampdown where it left off, not back to RUNNING.
        resumingRampdown = state.resumeStatus === 'RAMPDOWN' && state.rampdownSecondsLeft > 0;
    }
    state.sessionStatus = resumingRampdown ? 'RAMPDOWN' : 'RUNNING';
    state.resumeStatus = null;
    clearHrSignalPause();
    hrWatchdog.reset(Date.now());
    document.getElementById('rampdownNotice')?.classList.toggle('hidden', !resumingRampdown);
    renderTransport(state.sessionStatus);
    return true;
}

// Session Controls Handlers
playPauseBtn?.addEventListener('click', () => {
    if (isRemoteViewer) return;
    if (isRemoteController) {
        // Ask the host; the button re-renders from the telemetry it sends back.
        const wants = (state.sessionStatus === 'IDLE' || state.sessionStatus === 'PAUSED') ? 'RUNNING' : 'PAUSED';
        sendPeerCommand({ type: 'SESSION_STATE', status: wants });
        return;
    }
    if (state.sessionStatus === 'IDLE' || state.sessionStatus === 'PAUSED') {
        startOrResumeSession();
    } else if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') {
        pauseSession('Paused.');
    }
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
// more than the history label (one cue, never two back-to-back).
function stopSession(outcome = "Stopped", voiceText = null) {
    const wasActive = state.sessionStatus !== 'IDLE';
    // Status and motors FIRST: nothing below (history, storage, voice) may
    // leave the session running if it throws.
    state.sessionStatus = 'IDLE';
    state.resumeStatus = null;
    state.strokerSpeed = 0;
    state.prostateSpeed = 0;
    dispatchHardware(0, 0, 0, 100, true);
    setOrgasmMode(false);
    clearHrSignalPause();
    try {
        if (wasActive && state.sessionSeconds >= 10 && !isRemotePage) saveSessionToHistory(outcome);
    } catch (e) {
        console.warn('Session history could not be saved', e);
    } finally {
        resetSessionCounters();
        resetGameState();
        updateWarmupBadge();
        showIdleTransport();
        // STOP silences every queued cue; the outcome is the one thing said.
        cancelSpeech();
        cueVoice(voiceText || ((outcome && outcome !== 'Stopped') ? outcome : 'Session stopped.'), true);
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
    state.sessionStatus = 'IDLE';
    state.resumeStatus = null;
    dispatchHardware(0, 0, 0, 100, true);
    setOrgasmMode(false);
    clearHrSignalPause();
    resetSessionCounters();
    resetGameState();
    updateWarmupBadge();
    cancelSpeech();
    setMindgamePrompt('', false);
    showIdleTransport();
    syncTelemetry();
    checkReadiness();
    if (!isRemotePage) updateEngine();
});

// Came Early & Learning Profile
function persistSettings() {
    if (!safeSet('edgeloop_advanced_settings', advancedSettings)) {
        console.warn('Settings could not be saved (storage full or unavailable)');
    }
}

function renderLearningStatus() {
    const text = document.getElementById('learningStatusText');
    const p = advancedSettings.learningProfile || { breakthroughEvents: 0, suggestedMaxHrOffset: 0 };
    if (text) {
        if (p.breakthroughEvents > 0) {
            const last = p.lastBreakthroughHr ? ` Last event at ${p.lastBreakthroughHr} BPM.` : '';
            text.textContent = `Active: ${p.breakthroughEvents} premature event(s). Working climax ceiling is ${p.suggestedMaxHrOffset} BPM below your typed Climax HR on every session.${last}`;
            text.className = "p-2 bg-amber-950/40 border border-amber-800 rounded-lg text-[10px] font-mono text-amber-300";
        } else {
            text.textContent = "Zero breakthrough events recorded. Typed Climax HR is used as-is.";
            text.className = "p-2 bg-slate-900 rounded-lg text-[10px] font-mono text-purple-300";
        }
    }
    updateEngine();
}

cameEarlyBtn?.addEventListener('click', () => {
    // The learning profile belongs to the host; a remote page never logs one.
    if (isRemotePage) return;
    if (confirm("Log an accidental release? EdgeLoop will lower your working climax ceiling on this and future sessions.")) {
        if (!advancedSettings.learningProfile) {
            advancedSettings.learningProfile = { breakthroughEvents: 0, suggestedMaxHrOffset: 0, lastBreakthroughHr: null };
        }
        const profile = advancedSettings.learningProfile;
        const userMax = readHrLimits().maxHr;
        profile.breakthroughEvents += 1;
        profile.lastBreakthroughHr = state.hrCurrent;
        profile.suggestedMaxHrOffset = Math.min(30, (profile.suggestedMaxHrOffset || 0) + 3);
        if (state.hrCurrent && state.hrCurrent < userMax - 8) {
            profile.suggestedMaxHrOffset = Math.min(30, profile.suggestedMaxHrOffset + 2);
        }
        persistSettings();
        renderLearningStatus();
        stopSession("Premature Release", "Premature release. Limit tightened.");
    }
});

document.getElementById('wipeLearningBtn')?.addEventListener('click', () => {
    if (confirm("Reset local bio-learning memory? Your typed Climax HR will be used with no offset.")) {
        advancedSettings.learningProfile = { breakthroughEvents: 0, suggestedMaxHrOffset: 0, lastBreakthroughHr: null };
        persistSettings();
        renderLearningStatus();
    }
});

// Force Orgasm Overdrive. The state and button look live in one place so the
// toggle, stop, reset and remote telemetry all agree. The ceiling boost
// counter restarts from zero on every change and the typed Climax HR input
// is never modified.
function setOrgasmMode(on) {
    state.orgasmMode = Boolean(on);
    state.orgasmBoost = 0;
    if (orgasmBtnText) orgasmBtnText.textContent = state.orgasmMode ? 'Forcing...' : 'Force Orgasm';
    if (orgasmBtn) {
        orgasmBtn.className = state.orgasmMode
            ? 'bg-rose-700 text-white font-bold rounded-xl p-1.5 transition text-xs flex flex-col items-center justify-center animate-pulse cursor-pointer shadow-lg shadow-rose-950/40'
            : 'bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-xl p-1.5 transition text-xs flex flex-col items-center justify-center cursor-pointer shadow-lg shadow-amber-950/30';
    }
}

orgasmBtn?.addEventListener('click', () => {
    if (isRemoteViewer) return;
    if (isRemoteController) {
        // The host toggles and reports back through telemetry.
        sendPeerCommand({ type: 'ORGASM_TOGGLE' });
        return;
    }
    setOrgasmMode(!state.orgasmMode);
    syncTelemetry();
    updateEngine();
});

// Typed HR limits take effect immediately (and are validated) rather than on
// the next clock tick.
['minHr', 'maxHr'].forEach((id) => {
    const input = document.getElementById(id);
    input?.addEventListener('input', () => { updateEngine(); syncTelemetry(); });
    input?.addEventListener('change', () => { updateEngine(); syncTelemetry(); });
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
});

expTabGameBtn?.addEventListener('click', () => {
    expTabGameBtn.className = "px-2.5 py-0.5 rounded-md bg-purple-600 text-white transition cursor-pointer";
    if (expTabBioBtn) expTabBioBtn.className = "px-2.5 py-0.5 rounded-md text-slate-400 hover:text-white transition cursor-pointer";
    gameModesGrid?.classList.remove('hidden');
    bioProfilesGrid?.classList.add('hidden');
});

// Experience Mode Selection
const modeCards = document.querySelectorAll('.mode-card');
function highlightModeCard(mode) {
    modeCards.forEach(c => {
        const check = c.querySelector('.mode-check');
        const title = c.querySelector('.font-bold');
        if (c.getAttribute('data-mode') === mode) {
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
modeCards.forEach(card => {
    card.addEventListener('click', () => {
        if (isRemoteViewer) return;
        state.activeMode = card.getAttribute('data-mode');
        resetGameState();
        highlightModeCard(state.activeMode);
        // A controller asks the host; the host tells every remote via telemetry.
        if (isRemoteController) sendPeerCommand({ type: 'MODE_CHANGE', mode: state.activeMode });
        else syncTelemetry();
        updateEngine();
    });
});

// Pop-up Modals Router
const overlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modals = {
    Ble: document.getElementById('modalBodyBle'),
    Handy: document.getElementById('modalBodyHandy'),
    Intiface: document.getElementById('modalBodyIntiface'),
    TCode: document.getElementById('modalBodyTCode'),
    History: document.getElementById('modalBodyHistory'),
    Params: document.getElementById('modalBodyParams'),
    Partner: document.getElementById('modalBodyPartner'),
    Legal: document.getElementById('modalBodyLegal'),
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
    else if (type === 'HrGuide' && modalTitle) { modalTitle.textContent = "Smartwatch Pairing Guide"; modals.HrGuide?.classList.remove('hidden'); }
    overlay?.classList.remove('hidden');
}

function closeModal() { overlay?.classList.add('hidden'); }

document.getElementById('cardBle')?.addEventListener('click', () => { if (!isRemotePage) openModal('Ble'); });
document.getElementById('cardHandy')?.addEventListener('click', () => { if (!isRemotePage) openModal('Handy'); });
document.getElementById('cardIntiface')?.addEventListener('click', () => { if (!isRemotePage) openModal('Intiface'); });
document.getElementById('cardTCode')?.addEventListener('click', () => { if (!isRemotePage) openModal('TCode'); });
document.getElementById('historyBtn')?.addEventListener('click', () => openModal('History'));
document.getElementById('sessionParamsHeaderBtn')?.addEventListener('click', () => openModal('Params'));
document.getElementById('openParamsBtn')?.addEventListener('click', () => openModal('Params'));
document.getElementById('partnerShareBtn')?.addEventListener('click', () => { if (!isRemotePage) openModal('Partner'); });
document.getElementById('bleQuickHelpBtn')?.addEventListener('click', () => openModal('HrGuide'));
document.getElementById('footerLegalBtn')?.addEventListener('click', () => openModal('Legal'));
document.getElementById('modalCloseBtn')?.addEventListener('click', closeModal);
overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

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
    document.getElementById(id)?.addEventListener('input', () => validateDurationInputs());
});

durFixedBtn?.addEventListener('click', () => setDurationMode('fixed'));
durRangeBtn?.addEventListener('click', () => setDurationMode('range'));
durEndlessBtn?.addEventListener('click', () => setDurationMode('endless'));

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
    if (stallSec) stallSec.value = advancedSettings.stallGuardSeconds || 8;
    const ceilingSelect = document.getElementById('ceilingBehaviourSelect');
    if (ceilingSelect) ceilingSelect.value = advancedSettings.ceilingBehaviour === 'stop' ? 'stop' : 'crawl';
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
    populateVoiceSelect();
    setMindgamePrompt(state.lastSpokenPrompt || 'Calm and steady. Breathe.', advancedSettings.voiceEnabled);
}

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
    if (current && !voices.some((voice) => voice.voiceURI === current)) {
        select.value = '';
    } else {
        select.value = current;
    }
}

if (window.speechSynthesis) {
    populateVoiceSelect();
    window.speechSynthesis.addEventListener('voiceschanged', populateVoiceSelect);
}

document.getElementById('paramVoicePreviewBtn')?.addEventListener('click', () => {
    const select = document.getElementById('paramVoiceSelect');
    if (select) advancedSettings.voiceURI = select.value;
    speakNow('EdgeLoop voice preview. Stay right on the edge.', advancedSettings.voiceURI);
});

document.getElementById('paramVoiceSelect')?.addEventListener('change', (e) => {
    advancedSettings.voiceURI = e.target.value;
});

// Endgame selection inside Session Setup
const paramEndgameCards = document.querySelectorAll('.param-endgame-card');
paramEndgameCards.forEach(card => {
    card.addEventListener('click', () => {
        state.endgameType = card.getAttribute('data-endgame');
        paramEndgameCards.forEach(c => {
            const bold = c.querySelector('.font-bold');
            if (c === card) {
                c.className = "param-endgame-card p-1.5 rounded-lg bg-purple-950/30 border border-purple-800 text-left transition cursor-pointer";
                if (bold) bold.className = "font-bold text-[10px] text-purple-300";
            } else {
                c.className = "param-endgame-card p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-left transition cursor-pointer";
                if (bold) bold.className = "font-bold text-[10px] text-slate-300";
            }
        });
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

// Must run from a click handler (see startMicMonitor).
async function applyMicSetting(enabled) {
    advancedSettings.micEnabled = Boolean(enabled);
    const badge = document.getElementById('micActiveBadge');
    showMicReenable(false);
    if (!enabled) {
        stopMicMonitor(state);
        badge?.classList.add('hidden');
        state.micBoost = 0;
        return;
    }
    try {
        await startMicMonitor(state);
        badge?.classList.remove('hidden');
    } catch (e) {
        advancedSettings.micEnabled = false;
        const toggle = document.getElementById('paramMicToggle');
        if (toggle) toggle.checked = false;
        badge?.classList.add('hidden');
        alert('Microphone permission denied or unavailable in this browser.');
    }
}

// Apply Session Setup
document.getElementById('applyParamsBtn')?.addEventListener('click', async () => {
    advancedSettings.stallGuard = document.getElementById('stallGuardToggle')?.checked ?? true;
    advancedSettings.stallGuardSeconds = parseInt(document.getElementById('stallGuardSecondsInput')?.value, 10) || 8;
    advancedSettings.ceilingBehaviour = document.getElementById('ceilingBehaviourSelect')?.value === 'stop' ? 'stop' : 'crawl';
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
    advancedSettings.voiceEnabled = document.getElementById('paramVoiceToggle')?.checked ?? false;
    advancedSettings.voiceURI = document.getElementById('paramVoiceSelect')?.value || '';
    if (!advancedSettings.voiceEnabled) cancelSpeech();
    const micOn = document.getElementById('paramMicToggle')?.checked ?? false;
    const micWasOn = Boolean(state.micAnalyser);
    // Only (re)start the monitor when the setting changed: the button click
    // that submits the form is the user gesture the microphone needs.
    if (micOn !== micWasOn) {
        await applyMicSetting(micOn);
    } else {
        advancedSettings.micEnabled = micOn;
        if (!micOn) showMicReenable(false);
    }
    setMindgamePrompt(state.lastSpokenPrompt || 'Calm and steady. Breathe.', advancedSettings.voiceEnabled);

    persistSettings();
    closeModal();
    updateEngine();
    syncTelemetry();
});

// Export & Import Settings
document.getElementById('exportSettingsBtn')?.addEventListener('click', () => {
    const data = JSON.stringify(advancedSettings, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'edgeloop_settings.json';
    a.click();
    URL.revokeObjectURL(url);
});

document.getElementById('importConfigFile')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
        try {
            const parsed = JSON.parse(evt.target.result);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a settings object');
            Object.assign(advancedSettings, parsed);
            syncHwEnvelopeInputs();
            syncWatchdogSettings();
            persistSettings();
            syncParamsUI();
            updateEngine();
            alert("Settings successfully imported!");
        } catch (err) {
            alert("Invalid configuration file.");
        }
    };
    reader.readAsText(file);
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

// BLE modal "Status:" line. tone: 'idle' | 'busy' | 'ok' | 'error'
function setBleStatus(text, tone = 'idle') {
    const el = document.getElementById('modalBleMsg');
    if (!el) return;
    el.textContent = `Status: ${text}`;
    const toneClass = tone === 'ok' ? 'text-emerald-400'
        : tone === 'error' ? 'text-rose-400'
        : tone === 'busy' ? 'text-amber-300'
        : 'text-slate-500';
    el.className = `text-xs leading-snug ${toneClass}`;
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
    setBadgeState('Ble', 'disconnected', 'Unsupported');
    return true;
}

// BLE Hardware Scanning
document.getElementById('modalBleScanBtn')?.addEventListener('click', async () => {
    if (warnBluetoothUnsupported()) return;
    try {
        setBadgeState('Ble', 'connecting', 'Scanning...');
        setBleStatus('Pick your sensor in the browser chooser...', 'busy');
        const dev = await connectBleHeartRate({
            onHrMeasurement: (bpm, info) => {
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
                    if (sessionLive) triggerDisconnectAlert(`${name} (heart-rate monitor) was disconnected. Motors paused for safety.`);
                } else {
                    const silentMs = Math.max(0, Date.now() - (hrWatchdog.lastValidAt || Date.now()));
                    triggerDisconnectAlert(`${name} (heart-rate monitor) dropped and did not answer ${attempts} reconnect attempts; no reading for ${Math.round(silentMs / 1000)} s. Motors paused for safety.`);
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
        // Fresh grace window: the first packet may take a few seconds.
        hrWatchdog.reset(Date.now());
        state.hrNoContact = false;
        document.getElementById('hrContactHint')?.classList.add('hidden');
        closeModal();
        checkReadiness();
        syncTelemetry();
    } catch (e) {
        const described = describeBleError(e);
        setBleStatus(described.message, described.kind === 'cancelled' ? 'idle' : 'error');
        if (isBleConnected()) {
            // The chooser was closed before anything changed: the previous
            // sensor is still linked and keeps its badge.
            setBadgeState('Ble', 'connected', bleBadgeName(), bleBatteryLabel());
        } else {
            // A re-scan drops the previous link before subscribing to the new
            // sensor, so a failure here leaves no pulse source at all.
            setBadgeState('Ble', 'disconnected', described.kind === 'cancelled' ? 'Disconnected' : 'Failed');
            document.getElementById('modalBleDisconnectBtn')?.classList.add('hidden');
            document.getElementById('modalBleBatteryDisplay')?.classList.add('hidden');
            const devName = document.getElementById('modalBleDeviceName');
            if (devName) devName.textContent = 'No device paired';
            if (!state.simEngaged) {
                document.getElementById('hrWarningTag')?.classList.remove('hidden');
                if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') {
                    triggerDisconnectAlert(`${state.hrDeviceName || 'Heart-rate monitor'} was released for a new pairing that failed (${described.message}). Motors paused for safety.`);
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
    hrWatchdog.reset(Date.now());
    renderHrSignal(null);
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
        // Pauses the session and issues a stop to every other toy.
        triggerDisconnectAlert(reason || 'The Handy went offline. Motors paused for safety.');
    }
});

document.getElementById('modalHandyConnectBtn')?.addEventListener('click', async () => {
    const key = handyInput?.value.trim() || '';
    if (!key) {
        setHandyStatus('Enter your Handy Connection Key first.', 'error');
        return;
    }
    safeSet('handy_connection_key', key);
    setHandyStatus('Connecting...', 'busy');
    setBadgeState('Handy', 'connecting', 'Connecting...');

    try {
        const result = await connectHandy(key);
        state.handyBattery = result.battery;
        handyConnectedLabel = result.description ? `Connected (${result.description})` : 'Connected';
        setHandyStatus(handyConnectedLabel, 'ok');
        setBadgeState('Handy', 'connected', 'The Handy', handyBatteryLabel());
        document.getElementById('modalHandyDisconnectBtn')?.classList.remove('hidden');
        closeModal();
        syncTelemetry();
    } catch (e) {
        state.handyBattery = null;
        setHandyStatus(e && e.message ? e.message : 'Connection failed', 'error');
        setBadgeState('Handy', 'disconnected', 'Offline');
    }
});

document.getElementById('modalHandyDisconnectBtn')?.addEventListener('click', () => {
    disconnectHandy();
    state.handyBattery = null;
    setHandyStatus('Offline', 'idle');
    setBadgeState('Handy', 'disconnected', 'Disconnected');
    document.getElementById('modalHandyDisconnectBtn')?.classList.add('hidden');
    triggerDisconnectAlert("The Handy disconnected.");
});

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
        onStatus: renderIntifaceStatus,
        onDevicesChanged: () => {
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
                ? `Intiface Central disconnected with ${toys} in use. Motors paused for safety.`
                : `Intiface Central connection lost: ${toys} unreachable. Motors paused for safety.`);
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

// Best effort: stop every Intiface toy when the page goes away.
window.addEventListener('pagehide', () => { stopAllIntiface(); });

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

window.setDeviceReverseOnEdge = (devIdx, checked) => {
    setDeviceRotation(devIdx, { reverseOnEdge: Boolean(checked) });
};

window.setDeviceAlternate = (devIdx, val) => {
    setDeviceRotation(devIdx, { alternateSeconds: parseInt(val, 10) || 0 });
};

window.testAxis = (devIdx, axisIdx) => testSingleAxis(devIdx, axisIdx);

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
            const failing = axis.failing
                ? `<span class="text-[9px] font-bold text-rose-400 bg-rose-950/60 border border-rose-800 px-1 rounded" title="Intiface rejected the last 3 commands to this axis">Not responding</span>`
                : '';
            const invertRow = axis.kind === 'linear' ? `
            <label class="flex items-center justify-between text-[9px] text-slate-400 pt-1 border-t border-slate-800/60 cursor-pointer">
            <span>Invert direction (sleeve mounted upside down)</span>
            <input type="checkbox" ${axis.invert ? 'checked' : ''} onchange="setDeviceInvert(${devIdx}, ${aIdx}, this.checked)" class="accent-amber-500 cursor-pointer">
            </label>` : '';
            axisRows += `
            <div class="bg-slate-900 p-2 rounded-lg border ${axis.failing ? 'border-rose-800' : 'border-slate-800'} space-y-1.5 text-[10px]">
            <div class="flex justify-between items-center gap-1">
            <span class="font-bold text-slate-300 truncate">Axis ${axis.index} (${label})</span>
            <span class="flex items-center gap-1 shrink-0">${failing}
            <button onclick="testAxis(${devIdx}, ${aIdx})" class="bg-slate-800 hover:bg-slate-700 px-1.5 py-0.5 rounded text-[9px] cursor-pointer">Test</button></span>
            </div>
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
    renderTCodeStatus({ state: 'error', text: describeSerialSupport(navigator.userAgent) });
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
    onStatus: renderTCodeStatus,
    onDevicesChanged: () => {
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
            ? `TCode Serial device disconnected with ${axes} in use. Motors paused for safety.`
            : `TCode Serial device lost: ${axes} unreachable. Motors paused for safety.`);
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

// Best effort: rest every axis when the page goes away.
window.addEventListener('pagehide', () => { stopTCode(); });

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
            if (getPeerCounts().controllers > 0) setPartnerStatus('Controller Connected', 'ok');
            else setPartnerStatus('Ready (Awaiting Controller)');
            renderPeerCounts();
        },
        onPartnerConnected: () => {
            setPartnerStatus('Controller Connected', 'ok');
            renderPeerCounts();
            syncTelemetry();
        },
        onControllerDisconnected: (reason) => {
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
                const hostActive = state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN';
                if (cmd.status === 'RUNNING' && !hostActive) playPauseBtn?.click();
                else if (cmd.status === 'PAUSED' && hostActive) playPauseBtn?.click();
                else if (cmd.status === 'IDLE') stopBtn?.click();
            } else if (cmd.type === 'SESSION_RESET') resetBtn?.click();
            else if (cmd.type === 'ORGASM_TOGGLE') orgasmBtn?.click();
            else if (cmd.type === 'MODE_CHANGE') {
                const target = document.querySelector(`.mode-card[data-mode="${cmd.mode}"]`);
                if (target) target.click();
            }
        }
    });
}

// ---- Remote page (controller or viewer) ----------------------------------

// A viewer page renders everything but can change nothing. Re-applied after
// every telemetry frame because some renderers reset element classes.
const VIEWER_LOCKED_IDS = [
    'sessionPlayPauseBtn', 'sessionStopBtn', 'sessionResetBtn', 'cameEarlyBtn', 'orgasmBtn',
    'intensitySlider', 'fullStrokeToggleBtn', 'openParamsBtn', 'sessionParamsHeaderBtn',
    'partnerShareBtn', 'historyBtn', 'cardBle', 'cardHandy', 'cardIntiface', 'cardTCode'
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
    const banner = document.getElementById('disconnectBanner');
    const msg = document.getElementById('disconnectMsg');
    if (msg) msg.textContent = message;
    banner?.classList.remove('hidden');
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
        document.getElementById('disconnectBanner')?.classList.add('hidden');
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
    if (data.activeMode !== undefined && data.activeMode !== state.activeMode) {
        state.activeMode = data.activeMode;
        highlightModeCard(state.activeMode);
    }
    if (data.orgasmMode !== undefined && data.orgasmMode !== state.orgasmMode) setOrgasmMode(data.orgasmMode);
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
    if (isRemoteViewer) lockViewerControls();
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
        activeMode: state.activeMode,
        orgasmMode: state.orgasmMode,
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
renderLearningStatus();
syncParamsUI();
// A persisted mic setting waits for a tap (browser gesture rule).
if (advancedSettings.micEnabled && !isRemotePage) showMicReenable(true);
if (advancedSettings.voiceEnabled) setMindgamePrompt('Calm and steady. Breathe.', true);
watchChartResize(document.getElementById('hrChart'), redrawChart);
if (isRemotePage && remoteRoom) {
    lockRemoteLimitInputs();
    if (isRemoteViewer) lockViewerControls();
    const started = initRemotePeer(remoteRoom, isRemoteViewer ? 'viewer' : 'controller', {
        onConnected: () => {
            remoteLinkUp = true;
            remoteLinkLost = false;
            lastTelemetryAt = Date.now();
            setRemoteRoleStatus('Live');
            document.getElementById('disconnectBanner')?.classList.add('hidden');
        },
        onTelemetryReceived: applyRemoteTelemetry,
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
