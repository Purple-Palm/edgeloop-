import { state, advancedSettings } from './state.js';
import { calculateEngineOutputs } from './engine.js';
import { drawTelemetryChart } from './chart.js';
import { connectBleHeartRate, disconnectBle, bleDeviceRef } from './hardware/ble.js';
import { connectHandy, disconnectHandy, dispatchHandy, handyConnected } from './hardware/handy.js';
import {
    connectIntifaceServer,
    disconnectIntiface,
    rescanIntiface,
    dispatchIntiface,
    setAxisRole,
    setAxisMaxCap,
    testSingleAxis,
    intifaceSocket,
    intifaceDevices
} from './hardware/intiface.js';
import { initHostPeer, initControllerPeer, broadcastPeerTelemetry, sendPeerCommand } from './webrtc.js';

// Auto-migrate legacy storage
const storedSettings = localStorage.getItem('edgeloop_advanced_settings');
if (storedSettings) {
    try {
        const parsed = JSON.parse(storedSettings);
        if (parsed.handyHwMin === 15 && parsed.handyHwMax === 85) {
            parsed.handyHwMin = 0;
            parsed.handyHwMax = 100;
        }
        Object.assign(advancedSettings, parsed);
    } catch (e) {}
}

// Funscript Live Action Buffers
let funscriptPrimary = [];
let funscriptSecondary = [];
let funscriptSessionStart = 0;

// Query string check for remote controller
const urlParams = new URLSearchParams(window.location.search);
const partnerRoom = urlParams.get('partner');
export const isRemoteController = Boolean(partnerRoom);

if (isRemoteController) {
    const role = document.getElementById('roleIndicator');
    if (role) {
        role.textContent = "Remote Controller";
        role.className = "text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-900 text-purple-200 uppercase";
    }
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
if (localStorage.getItem('edgeloop_age_verified') === 'true' && ageOverlay) {
    ageOverlay.classList.add('hidden');
}
document.getElementById('ageConfirmBtn')?.addEventListener('click', () => {
    localStorage.setItem('edgeloop_age_verified', 'true');
    if (ageOverlay) ageOverlay.classList.add('hidden');
});
document.getElementById('ageDenyBtn')?.addEventListener('click', () => {
    window.location.href = 'https://www.google.com';
});

// Guide Wizard
window.dismissWizard = () => {
    const w = document.getElementById('wizardOverlay');
    if (w) w.classList.add('hidden');
};
document.getElementById('guideBtn')?.addEventListener('click', () => {
    const w = document.getElementById('wizardOverlay');
    if (w) w.classList.remove('hidden');
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

    if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') {
        state.sessionStatus = 'PAUSED';
        state.pauses += 1;
        const pauseEl = document.getElementById('pauseCount');
        if (pauseEl) pauseEl.textContent = state.pauses;
        if (playPauseText) playPauseText.textContent = "RESUME";
        if (playPauseIcon) playPauseIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
        if (playPauseBtn) playPauseBtn.className = "flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 shadow-lg shadow-emerald-950/40 cursor-pointer";
        dispatchHardware(0, 0, 0, 100, true);
        syncTelemetry();
    }
    checkReadiness();
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
        } else {
            card.className = "text-left p-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition flex items-start gap-2 cursor-pointer min-w-0";
            dot.className = "h-2 w-2 rounded-full bg-rose-500/30 border border-rose-500 shrink-0 mt-1";
        }
    }
    checkReadiness();
}

function checkReadiness() {
    const hrReady = Boolean(bleDeviceRef && bleDeviceRef.gatt && bleDeviceRef.gatt.connected) || state.simEngaged;
    const toyReady = handyConnected || (intifaceSocket && intifaceSocket.readyState === WebSocket.OPEN && intifaceDevices.size > 0);

    if (!playPauseBtn) return;

    if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'PAUSED' || state.sessionStatus === 'RAMPDOWN') {
        playPauseBtn.disabled = false;
        return;
    }

    if (!hrReady && !toyReady) {
        playPauseBtn.disabled = true;
        if (playPauseText) playPauseText.textContent = "WAITING FOR HR SENSOR & TOY";
        playPauseBtn.className = "flex-1 bg-slate-800 text-slate-500 font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 border border-slate-700/50 cursor-not-allowed";
    } else if (!hrReady) {
        playPauseBtn.disabled = true;
        if (playPauseText) playPauseText.textContent = "WAITING FOR HR SENSOR";
        playPauseBtn.className = "flex-1 bg-slate-800 text-slate-500 font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 border border-slate-700/50 cursor-not-allowed";
    } else if (!toyReady) {
        playPauseBtn.disabled = true;
        if (playPauseText) playPauseText.textContent = "WAITING FOR TOY CONNECTION";
        playPauseBtn.className = "flex-1 bg-slate-800 text-slate-500 font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 border border-slate-700/50 cursor-not-allowed";
    } else {
        playPauseBtn.disabled = false;
        if (playPauseText) playPauseText.textContent = "START SESSION";
        playPauseBtn.className = "flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 shadow-lg shadow-emerald-950/40 cursor-pointer";
    }
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

// The Handy Role & Speed Cap Controls
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
            localStorage.setItem('handy_max_cap', state.handyMaxCap);
            updateEngine();
        });
    }

    const applyRole = (role) => {
        state.handyRole = role;
        localStorage.setItem('handy_role', role);
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
    if (isRemoteController) return;

    const minInput = document.getElementById('minHr');
    const maxInput = document.getElementById('maxHr');
    const min = parseInt(minInput?.value || 70, 10);
    let max = parseInt(maxInput?.value || 140, 10);
    let hr = state.hrCurrent;
    if (!hr || hr < 35) hr = min;

    const hrDisplay = document.getElementById('hrDisplay');
    if (hrDisplay) hrDisplay.textContent = hr;
    if (hr > state.peakHr) state.peakHr = hr;

    // Dual Stimulation Offset Check
    const hasSecondary = Array.from(intifaceDevices.values()).some(d => d.axes.some(a => a.role === 'secondary'));
    const isDualStimActive = hasSecondary && (handyConnected || Array.from(intifaceDevices.values()).some(d => d.axes.some(a => a.role === 'primary')));
    const dualBadge = document.getElementById('dualStimBadge');
    if (isDualStimActive && advancedSettings.dualDampening) {
        const offset = advancedSettings.dualDampeningBpm || 15;
        max = Math.max(min + 15, max - offset);
        if (dualBadge) {
            dualBadge.textContent = `DUAL STIM (-${offset} BPM)`;
            dualBadge.classList.remove('hidden');
        }
    } else if (dualBadge) {
        dualBadge.classList.add('hidden');
    }

    // Adaptive Ceiling Decay
    const decayBadge = document.getElementById('decayBadge');
    if (advancedSettings.adaptiveDecay && state.edges > 0) {
        const drops = Math.floor(state.edges / (advancedSettings.decayEdgeCount || 2));
        const totalDecay = drops * (advancedSettings.decayBpm || 2);
        if (totalDecay > 0) {
            const decayedMax = Math.max(advancedSettings.decayFloor || 105, max - totalDecay);
            max = Math.max(min + 15, decayedMax);
            const decayText = document.getElementById('decayAmountText');
            if (decayText) decayText.textContent = totalDecay;
            if (decayBadge) decayBadge.classList.remove('hidden');
        } else if (decayBadge) {
            decayBadge.classList.add('hidden');
        }
    } else if (decayBadge) {
        decayBadge.classList.add('hidden');
    }

    const result = calculateEngineOutputs({
        hr,
        minHr: min,
        maxHr: max,
        activeMode: state.activeMode,
        sessionStatus: state.sessionStatus,
        rampdownSecondsLeft: state.rampdownSecondsLeft,
        isEdged: state.isEdged,
        orgasmMode: state.orgasmMode,
        gamma: advancedSettings.gammaCurve,
        intensityValue: state.intensityValue,
        edgeStrokeDepth: advancedSettings.edgeStrokeDepth,
        handyHwMin: advancedSettings.handyHwMin,
        handyHwMax: advancedSettings.handyHwMax
    });

    if (result.newEdgeTriggered) {
        state.edges += 1;
        const edgeEl = document.getElementById('edgeCount');
        if (edgeEl) edgeEl.textContent = state.edges;
        if (state.activeMode === 'ruin') state.ruinHoldSeconds = 18;
        intifaceDevices.forEach(dev => { dev.clockwise = !dev.clockwise; });
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
        cutoffEl.classList.toggle('hidden', !state.isEdged || state.orgasmMode || state.sessionStatus === 'RAMPDOWN');
    }

    dispatchHardware(result.primaryPercent, result.secondaryPercent, result.strokeMinPercent, result.strokeMaxPercent);
}

function dispatchHardware(primarySpeed, secondarySpeed, strokeMin, strokeMax, force = false) {
    if (isRemoteController) return;
    const key = document.getElementById('modalHandyInput')?.value.trim() || '';

    let targetHandySpeed = 0;
    const handyCap = (state.handyMaxCap ?? 100) / 100;
    if (state.handyRole === 'primary') {
        targetHandySpeed = Math.round(primarySpeed * handyCap);
    } else if (state.handyRole === 'secondary') {
        targetHandySpeed = Math.round(secondarySpeed * handyCap);
    } else {
        targetHandySpeed = 0;
    }

    const effStrokeMin = state.alwaysFullStroke ? 0 : strokeMin;
    const effStrokeMax = state.alwaysFullStroke ? 100 : strokeMax;

    dispatchHandy(key, targetHandySpeed, effStrokeMin, effStrokeMax, force);
    dispatchIntiface(primarySpeed, secondarySpeed);
}

// 250ms Live Funscript Sampling Loop (4Hz)
setInterval(() => {
    if (state && state.sessionStatus === 'RUNNING') {
        const now = Date.now();
        if (funscriptSessionStart === 0) funscriptSessionStart = now;
        const at = now - funscriptSessionStart;
        funscriptPrimary.push({ at, pos: Math.round(state.strokerSpeed) });
        funscriptSecondary.push({ at, pos: Math.round(state.prostateSpeed) });
    }
}, 250);

// 1-Second Master Clock
setInterval(() => {
    if (state.sessionStatus === 'RUNNING') {
        state.sessionSeconds += 1;
        updateTimerDisplay();

        if (state.chosenTargetSeconds > 0 && state.sessionSeconds >= state.chosenTargetSeconds) {
            handleTargetTimeReached();
        }
        if (state.orgasmMode) {
            const maxInput = document.getElementById('maxHr');
            if (maxInput) maxInput.value = parseInt(maxInput.value, 10) + 1;
        }

        const isStale = (Date.now() - state.lastHrTimestamp) > 3500;
        const staleAlert = document.getElementById('staleAlert');
        if (staleAlert) staleAlert.classList.toggle('hidden', !isStale);
        if (isStale && !state.simEngaged) {
            dispatchHardware(0, 0, 0, 100, true);
            triggerDisconnectAlert("Warning: Heart Rate signal lost. Motors paused for safety.");
        }
    } else if (state.sessionStatus === 'RAMPDOWN') {
        state.rampdownSecondsLeft -= 1;
        const timerEl = document.getElementById('sessionTimer');
        if (timerEl) timerEl.textContent = `00:${String(state.rampdownSecondsLeft).padStart(2, '0')}`;
        if (state.rampdownSecondsLeft <= 0) stopSession("Soft Landing (Edged Out)");
    }

    syncTelemetry();
    if (!isRemoteController) updateEngine();
    const min = parseInt(document.getElementById('minHr')?.value || 70, 10);
    const max = parseInt(document.getElementById('maxHr')?.value || 140, 10);
    const chartEl = document.getElementById('hrChart');
    if (chartEl) drawTelemetryChart(chartEl, state.history, min, max);
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
    } else if (state.durationMode === 'range') {
        timerEl.textContent = activeStr;
        subLabelEl.textContent = "Mystery Target";
    } else {
        timerEl.textContent = activeStr;
        subLabelEl.textContent = "Endless Mode";
    }
}

// Session Controls Handlers
playPauseBtn?.addEventListener('click', () => {
    if (state.sessionStatus === 'IDLE' || state.sessionStatus === 'PAUSED') {
        if (state.sessionStatus === 'IDLE') {
            funscriptPrimary = [];
            funscriptSecondary = [];
            funscriptSessionStart = Date.now();
            const min = parseInt(document.getElementById('paramMinInput')?.value || 25, 10);
            const max = parseInt(document.getElementById('paramMaxInput')?.value || 45, 10);
            state.chosenTargetSeconds = max > 0 ? (Math.floor(Math.random() * (Math.max(min, max) - Math.min(min, max) + 1)) + Math.min(min, max)) * 60 : 0;
        }
        state.sessionStatus = 'RUNNING';
        document.getElementById('rampdownNotice')?.classList.add('hidden');
        if (playPauseText) playPauseText.textContent = "PAUSE";
        if (playPauseIcon) playPauseIcon.innerHTML = `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`;
        if (playPauseBtn) playPauseBtn.className = "flex-1 bg-amber-600 hover:bg-amber-500 text-white font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 shadow-lg shadow-amber-950/40 cursor-pointer";
    } else if (state.sessionStatus === 'RUNNING' || state.sessionStatus === 'RAMPDOWN') {
        state.sessionStatus = 'PAUSED';
        state.pauses += 1;
        const pauseEl = document.getElementById('pauseCount');
        if (pauseEl) pauseEl.textContent = state.pauses;
        if (playPauseText) playPauseText.textContent = "RESUME";
        if (playPauseIcon) playPauseIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
        if (playPauseBtn) playPauseBtn.className = "flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 shadow-lg shadow-emerald-950/40 cursor-pointer";
        dispatchHardware(0, 0, 0, 100, true);
    }
    sendPeerCommand({ type: 'SESSION_STATE', status: state.sessionStatus, chosenSeconds: state.chosenTargetSeconds });
    syncTelemetry();
    if (!isRemoteController) updateEngine();
});

stopBtn?.addEventListener('click', () => stopSession("Stopped"));

function stopSession(outcome = "Stopped") {
    if (state.sessionSeconds >= 10 && !isRemoteController) saveSessionToHistory(outcome);
    state.sessionStatus = 'IDLE';
    state.strokerSpeed = 0;
    state.prostateSpeed = 0;
    document.getElementById('rampdownNotice')?.classList.add('hidden');
    const sVal = document.getElementById('strokerVal');
    const sBar = document.getElementById('strokerBar');
    const pVal = document.getElementById('prostateVal');
    const pBar = document.getElementById('prostateBar');
    if (sVal) sVal.textContent = "0%";
    if (sBar) sBar.style.width = "0%";
    if (pVal) pVal.textContent = "0%";
    if (pBar) pBar.style.width = "0%";
    if (playPauseText) playPauseText.textContent = "START SESSION";
    if (playPauseIcon) playPauseIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
    if (playPauseBtn) playPauseBtn.className = "flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 px-3 rounded-xl text-xs sm:text-sm transition tracking-wide flex justify-center items-center gap-1.5 shadow-lg shadow-emerald-950/40 cursor-pointer";
    dispatchHardware(0, 0, 0, 100, true);
    sendPeerCommand({ type: 'SESSION_STATE', status: state.sessionStatus, chosenSeconds: 0 });
    syncTelemetry();
    checkReadiness();
}

resetBtn?.addEventListener('click', () => {
    funscriptPrimary = [];
    funscriptSecondary = [];
    funscriptSessionStart = 0;
    state.sessionStatus = 'IDLE';
    state.sessionSeconds = 0;
    state.chosenTargetSeconds = 0;
    state.edges = 0;
    state.pauses = 0;
    state.peakHr = state.hrCurrent;
    state.strokerSpeed = 0;
    state.prostateSpeed = 0;
    document.getElementById('rampdownNotice')?.classList.add('hidden');
    updateTimerDisplay();
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
    if (playPauseText) playPauseText.textContent = "START SESSION";
    if (playPauseIcon) playPauseIcon.innerHTML = `<path d="M8 5v14l11-7z"/>`;
    dispatchHardware(0, 0, 0, 100, true);
    sendPeerCommand({ type: 'SESSION_RESET' });
    syncTelemetry();
    checkReadiness();
});

// Came Early & Learning Profile
function renderLearningStatus() {
    const text = document.getElementById('learningStatusText');
    if (!text) return;
    const p = advancedSettings.learningProfile;
    if (p.breakthroughEvents > 0) {
        text.textContent = `Active Learning: ${p.breakthroughEvents} premature event(s) logged. Climax threshold offset by -${p.suggestedMaxHrOffset} BPM.`;
        text.className = "p-2 bg-amber-950/40 border border-amber-800 rounded-lg text-[10px] font-mono text-amber-300";
    } else {
        text.textContent = "Zero breakthrough events recorded. Calibrated limits active.";
        text.className = "p-2 bg-slate-900 rounded-lg text-[10px] font-mono text-purple-300";
    }
}

cameEarlyBtn?.addEventListener('click', () => {
    if (confirm("Log an accidental release? EdgeLoop will tighten protection.")) {
        advancedSettings.learningProfile.breakthroughEvents += 1;
        advancedSettings.learningProfile.suggestedMaxHrOffset += 3;
        const currentMax = parseInt(document.getElementById('maxHr')?.value || 140, 10);
        const maxInput = document.getElementById('maxHr');
        if (maxInput) maxInput.value = Math.max(90, currentMax - 3);
        localStorage.setItem('edgeloop_advanced_settings', JSON.stringify(advancedSettings));
        renderLearningStatus();
        stopSession("Premature Release");
    }
});

document.getElementById('wipeLearningBtn')?.addEventListener('click', () => {
    if (confirm("Reset local bio-learning memory?")) {
        advancedSettings.learningProfile = { breakthroughEvents: 0, suggestedMaxHrOffset: 0 };
        localStorage.setItem('edgeloop_advanced_settings', JSON.stringify(advancedSettings));
        renderLearningStatus();
    }
});

// Force Orgasm Overdrive
orgasmBtn?.addEventListener('click', () => {
    state.orgasmMode = !state.orgasmMode;
    if (state.orgasmMode) {
        state.savedMaxHr = parseInt(document.getElementById('maxHr')?.value || 140, 10);
        if (orgasmBtnText) orgasmBtnText.textContent = 'Forcing...';
        if (orgasmBtn) orgasmBtn.className = 'bg-rose-700 text-white font-bold rounded-xl p-1.5 transition text-xs flex flex-col items-center justify-center animate-pulse cursor-pointer shadow-lg shadow-rose-950/40';
    } else {
        if (state.savedMaxHr) {
            const maxInput = document.getElementById('maxHr');
            if (maxInput) maxInput.value = state.savedMaxHr;
        }
        if (orgasmBtnText) orgasmBtnText.textContent = 'Force Orgasm';
        if (orgasmBtn) orgasmBtn.className = 'bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-xl p-1.5 transition text-xs flex flex-col items-center justify-center cursor-pointer shadow-lg shadow-amber-950/30';
    }
    sendPeerCommand({ type: 'ORGASM_TOGGLE' });
    syncTelemetry();
    updateEngine();
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
modeCards.forEach(card => {
    card.addEventListener('click', () => {
        state.activeMode = card.getAttribute('data-mode');
        modeCards.forEach(c => {
            const check = c.querySelector('.mode-check');
            const title = c.querySelector('.font-bold');
            if (c === card) {
                c.className = "mode-card text-left p-2 rounded-xl bg-purple-950/20 border border-purple-800 hover:border-purple-600 transition cursor-pointer flex flex-col justify-between";
                if (title) title.className = "font-bold text-[11px] text-purple-300 flex justify-between items-center";
                check?.classList.remove('hidden');
            } else {
                c.className = "mode-card text-left p-2 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 transition cursor-pointer flex flex-col justify-between";
                if (title) title.className = "font-bold text-[11px] text-slate-200 flex justify-between items-center";
                check?.classList.add('hidden');
            }
        });
        sendPeerCommand({ type: 'MODE_CHANGE', mode: state.activeMode });
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
    History: document.getElementById('modalBodyHistory'),
    Params: document.getElementById('modalBodyParams'),
    Partner: document.getElementById('modalBodyPartner'),
    Legal: document.getElementById('modalBodyLegal'),
    HrGuide: document.getElementById('modalBodyHrGuide')
};

function openModal(type) {
    Object.values(modals).forEach(m => m?.classList.add('hidden'));
    if (type === 'Ble' && modalTitle) { modalTitle.textContent = "Heart Rate Monitor & Simulator"; modals.Ble?.classList.remove('hidden'); }
    else if (type === 'Handy' && modalTitle) { modalTitle.textContent = "The Handy (Wi-Fi API)"; modals.Handy?.classList.remove('hidden'); }
    else if (type === 'Intiface' && modalTitle) { modalTitle.textContent = "Intiface Central & Toy Roles"; modals.Intiface?.classList.remove('hidden'); renderIntifaceDevices(); }
    else if (type === 'History' && modalTitle) { modalTitle.textContent = "Session History & Funscripts"; modals.History?.classList.remove('hidden'); renderHistory(); }
    else if (type === 'Params' && modalTitle) { modalTitle.textContent = "Session Setup"; modals.Params?.classList.remove('hidden'); renderLearningStatus(); syncParamsUI(); }
    else if (type === 'Partner' && modalTitle) { modalTitle.textContent = "Share Control Hub"; modals.Partner?.classList.remove('hidden'); setupPartnerHost(); }
    else if (type === 'Legal' && modalTitle) { modalTitle.textContent = "Legal & Medical Disclaimer"; modals.Legal?.classList.remove('hidden'); }
    else if (type === 'HrGuide' && modalTitle) { modalTitle.textContent = "Smartwatch Pairing Guide"; modals.HrGuide?.classList.remove('hidden'); }
    overlay?.classList.remove('hidden');
}

function closeModal() { overlay?.classList.add('hidden'); }

document.getElementById('cardBle')?.addEventListener('click', () => { if (!isRemoteController) openModal('Ble'); });
document.getElementById('cardHandy')?.addEventListener('click', () => { if (!isRemoteController) openModal('Handy'); });
document.getElementById('cardIntiface')?.addEventListener('click', () => { if (!isRemoteController) openModal('Intiface'); });
document.getElementById('historyBtn')?.addEventListener('click', () => openModal('History'));
document.getElementById('sessionParamsHeaderBtn')?.addEventListener('click', () => openModal('Params'));
document.getElementById('openParamsBtn')?.addEventListener('click', () => openModal('Params'));
document.getElementById('partnerShareBtn')?.addEventListener('click', () => openModal('Partner'));
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

// Session Setup Sub-Tabs
const paramsTabMap = {
    duration: { btn: document.getElementById('paramsTabDurationBtn'), sec: document.getElementById('paramsDurationSection') },
    guards: { btn: document.getElementById('paramsTabGuardsBtn'), sec: document.getElementById('paramsGuardsSection') },
    motion: { btn: document.getElementById('paramsTabMotionBtn'), sec: document.getElementById('paramsMotionSection') },
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
paramsTabMap.motion.btn?.addEventListener('click', () => setParamsTab('motion'));
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
    updateTimerDisplay();
}

durFixedBtn?.addEventListener('click', () => setDurationMode('fixed'));
durRangeBtn?.addEventListener('click', () => setDurationMode('range'));
durEndlessBtn?.addEventListener('click', () => setDurationMode('endless'));

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
    const warmupDisplay = document.getElementById('warmupValDisplay');
    const hwMin = document.getElementById('hwMinInput');
    const hwMax = document.getElementById('hwMaxInput');
    const hwEnv = document.getElementById('hwEnvelopeDisplay');

    if (stallToggle) stallToggle.checked = Boolean(advancedSettings.stallGuard);
    if (stallSec) stallSec.value = advancedSettings.stallGuardSeconds || 8;
    if (dualToggle) dualToggle.checked = Boolean(advancedSettings.dualDampening);
    if (dualBpm) dualBpm.value = advancedSettings.dualDampeningBpm || 15;
    if (decayToggle) decayToggle.checked = Boolean(advancedSettings.adaptiveDecay);
    if (decayCount) decayCount.value = advancedSettings.decayEdgeCount || 2;
    if (decayBpm) decayBpm.value = advancedSettings.decayBpm || 2;
    if (decayFloor) decayFloor.value = advancedSettings.decayFloor || 105;

    if (warmup) warmup.value = advancedSettings.warmupMinutes ?? 5;
    if (warmupDisplay) warmupDisplay.textContent = (advancedSettings.warmupMinutes === 0) ? "0 min (Instant)" : `${advancedSettings.warmupMinutes ?? 5} Minutes`;

    if (hwMin) hwMin.value = advancedSettings.handyHwMin ?? 0;
    if (hwMax) hwMax.value = advancedSettings.handyHwMax ?? 100;
    if (hwEnv) hwEnv.textContent = `Bounds: ${advancedSettings.handyHwMin ?? 0}% - ${advancedSettings.handyHwMax ?? 100}%`;
}

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

// Apply Session Setup
document.getElementById('applyParamsBtn')?.addEventListener('click', () => {
    advancedSettings.stallGuard = document.getElementById('stallGuardToggle')?.checked ?? true;
    advancedSettings.stallGuardSeconds = parseInt(document.getElementById('stallGuardSecondsInput')?.value, 10) || 8;
    advancedSettings.dualDampening = document.getElementById('dualDampeningToggle')?.checked ?? true;
    advancedSettings.dualDampeningBpm = parseInt(document.getElementById('dualDampeningOffsetInput')?.value, 10) || 15;
    advancedSettings.adaptiveDecay = document.getElementById('adaptiveDecayToggle')?.checked ?? true;
    advancedSettings.decayEdgeCount = parseInt(document.getElementById('decayEdgeCountInput')?.value, 10) || 2;
    advancedSettings.decayBpm = parseInt(document.getElementById('decayBpmInput')?.value, 10) || 2;
    advancedSettings.decayFloor = parseInt(document.getElementById('decayFloorInput')?.value, 10) || 105;
    advancedSettings.warmupMinutes = parseInt(document.getElementById('warmupInput')?.value, 10) || 5;
    advancedSettings.handyHwMin = parseInt(document.getElementById('hwMinInput')?.value, 10) || 0;
    advancedSettings.handyHwMax = parseInt(document.getElementById('hwMaxInput')?.value, 10) || 100;
    advancedSettings.voiceEnabled = document.getElementById('paramVoiceToggle')?.checked ?? false;

    localStorage.setItem('edgeloop_advanced_settings', JSON.stringify(advancedSettings));
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
            Object.assign(advancedSettings, parsed);
            localStorage.setItem('edgeloop_advanced_settings', JSON.stringify(advancedSettings));
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

// BLE Hardware Scanning
document.getElementById('modalBleScanBtn')?.addEventListener('click', async () => {
    try {
        setBadgeState('Ble', 'connecting', 'Scanning...');
        const dev = await connectBleHeartRate({
            onHrMeasurement: (hr) => {
                if (!hr || hr < 35) return;
                state.hrCurrent = hr;
                state.lastHrTimestamp = Date.now();
                state.history.push(hr);
                if (state.history.length > 60) state.history.shift();
                updateEngine();
                syncTelemetry();
            },
            onBatteryLevel: (bat) => {
                state.bleBattery = bat;
                const batEl = document.getElementById('modalBleBatteryDisplay');
                if (batEl) {
                    batEl.textContent = `Battery: ${bat}%`;
                    batEl.classList.remove('hidden');
                }
            },
            onDisconnected: () => {
                state.bleBattery = null;
                setBadgeState('Ble', 'disconnected', 'Disconnected');
                triggerDisconnectAlert("Warning: BLE Heart Rate Monitor Disconnected!");
            }
        });

        const devName = document.getElementById('modalBleDeviceName');
        if (devName) devName.textContent = dev.name || "Bluetooth HR Monitor";
        document.getElementById('modalBleDisconnectBtn')?.classList.remove('hidden');
        setBadgeState('Ble', 'connected', dev.name ? dev.name.split(' ')[0] : 'HR Monitor', state.bleBattery !== null ? `🔋 ${state.bleBattery}%` : null);
        document.getElementById('hrWarningTag')?.classList.add('hidden');
        document.getElementById('simActiveTag')?.classList.add('hidden');
        state.simEngaged = false;
        closeModal();
        syncTelemetry();
    } catch (e) {
        setBadgeState('Ble', 'disconnected', 'Cancelled');
    }
});
document.getElementById('modalBleDisconnectBtn')?.addEventListener('click', disconnectBle);

// Manual Simulation
const modalSimSlider = document.getElementById('modalSimHrSlider');
const modalSimVal = document.getElementById('modalSimHrVal');
modalSimSlider?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    if (modalSimVal) modalSimVal.textContent = `${val} BPM`;
    if (state.simEngaged) {
        state.hrCurrent = val;
        state.lastHrTimestamp = Date.now();
        state.history.push(val);
        if (state.history.length > 60) state.history.shift();
        updateEngine();
        syncTelemetry();
    }
});

document.getElementById('modalEngageSimBtn')?.addEventListener('click', () => {
    state.simEngaged = true;
    state.hrCurrent = parseInt(modalSimSlider?.value || 70, 10);
    state.lastHrTimestamp = Date.now();
    state.history.push(state.hrCurrent);
    if (state.history.length > 60) state.history.shift();
    document.getElementById('simActiveTag')?.classList.remove('hidden');
    document.getElementById('hrWarningTag')?.classList.add('hidden');
    setBadgeState('Ble', 'connected', 'Simulator', null);
    closeModal();
    checkReadiness();
    updateEngine();
    syncTelemetry();
});

// The Handy Connection
const handyInput = document.getElementById('modalHandyInput');
if (handyInput) handyInput.value = localStorage.getItem('handy_connection_key') || '';
document.getElementById('modalHandyConnectBtn')?.addEventListener('click', async () => {
    const key = handyInput?.value.trim() || '';
    if (!key) return alert("Please enter your Handy Connection Key.");
    localStorage.setItem('handy_connection_key', key);
    setBadgeState('Handy', 'connecting', 'Connecting...');

    try {
        const bat = await connectHandy(key);
        state.handyBattery = bat;
        setBadgeState('Handy', 'connected', 'The Handy', bat !== null ? `🔋 ${bat}%` : null);
        document.getElementById('modalHandyDisconnectBtn')?.classList.remove('hidden');
        closeModal();
        syncTelemetry();
    } catch (e) {
        setBadgeState('Handy', 'disconnected', 'Offline');
    }
});

document.getElementById('modalHandyDisconnectBtn')?.addEventListener('click', () => {
    const key = handyInput?.value.trim() || '';
    disconnectHandy(key);
    state.handyBattery = null;
    setBadgeState('Handy', 'disconnected', 'Disconnected');
    document.getElementById('modalHandyDisconnectBtn')?.classList.add('hidden');
    triggerDisconnectAlert("The Handy disconnected.");
});

// Intiface Central WebSocket
document.getElementById('modalIntifaceConnectBtn')?.addEventListener('click', () => {
    const url = document.getElementById('modalIntifaceUrl')?.value.trim() || 'ws://localhost:12345';
    setBadgeState('Intiface', 'connecting', 'Connecting...');
    connectIntifaceServer(url, {
        onOpen: () => {
            document.getElementById('modalIntifaceConnectBtn')?.classList.add('hidden');
            document.getElementById('modalIntifaceDisconnectBtn')?.classList.remove('hidden');
            document.getElementById('modalIntifaceRescanBtn')?.classList.remove('hidden');
        },
        onDevicesChanged: () => {
            renderIntifaceDevices();
            syncTelemetry();
        },
        onError: () => {
            setBadgeState('Intiface', 'disconnected', 'WS Error');
            triggerDisconnectAlert("Intiface WebSocket Error.");
        },
        onClose: () => {
            renderIntifaceDevices();
            setBadgeState('Intiface', 'disconnected', 'Disconnected');
            document.getElementById('modalIntifaceConnectBtn')?.classList.remove('hidden');
            document.getElementById('modalIntifaceDisconnectBtn')?.classList.add('hidden');
            document.getElementById('modalIntifaceRescanBtn')?.classList.add('hidden');
        }
    });
});
document.getElementById('modalIntifaceDisconnectBtn')?.addEventListener('click', disconnectIntiface);
document.getElementById('modalIntifaceRescanBtn')?.addEventListener('click', rescanIntiface);
document.getElementById('modalIntifaceSaveBtn')?.addEventListener('click', () => {
    renderIntifaceSummaryBadge();
    closeModal();
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

window.testAxis = (devIdx, axisIdx) => testSingleAxis(devIdx, axisIdx);

function renderIntifaceDevices() {
    const list = document.getElementById('modalIntifaceList');
    if (!list) return;
    if (intifaceDevices.size === 0) {
        list.innerHTML = `<div class="p-3 bg-slate-950 rounded-xl border border-slate-800 text-slate-500 text-xs italic">
        ${intifaceSocket && intifaceSocket.readyState === WebSocket.OPEN ? 'Scanning... Power on your toys.' : 'Connect to Intiface server to detect your toys.'}
        </div>`;
        return;
    }
    list.innerHTML = '';
    intifaceDevices.forEach((dev, devIdx) => {
        const item = document.createElement('div');
        item.className = 'p-2.5 bg-slate-950 rounded-xl border border-slate-800 space-y-2 text-xs';
        const batText = dev.hasBattery ? (dev.battery !== null ? `🔋 ${dev.battery}%` : '🔋 Reading...') : '🔋 N/A';

        let axisRows = '';
        dev.axes.forEach((axis, aIdx) => {
            axisRows += `
            <div class="bg-slate-900 p-2 rounded-lg border border-slate-800 space-y-1.5 text-[10px]">
            <div class="flex justify-between items-center">
            <span class="font-bold text-slate-300">Axis ${axis.index} (${axis.type})</span>
            <button onclick="testAxis(${devIdx}, ${aIdx})" class="bg-slate-800 hover:bg-slate-700 px-1.5 py-0.5 rounded text-[9px] cursor-pointer">Test</button>
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
            </div>
            `;
        });

        item.innerHTML = `
        <div class="flex justify-between items-center font-bold text-slate-200">
        <span>${dev.name}</span>
        <span class="text-[9px] font-mono text-emerald-400">${batText}</span>
        </div>
        <div class="space-y-1">${axisRows}</div>
        `;
        list.appendChild(item);
    });
    renderIntifaceSummaryBadge();
}

function renderIntifaceSummaryBadge() {
    if (intifaceDevices.size === 0) {
        const isConn = intifaceSocket && intifaceSocket.readyState === WebSocket.OPEN;
        setBadgeState('Intiface', isConn ? 'connected' : 'disconnected', isConn ? '0 Toys Ready' : 'Disconnected', null);
        return;
    }
    const firstToy = Array.from(intifaceDevices.values())[0];
    let nameLabel = firstToy.name.split(' ')[0];
    if (intifaceDevices.size > 1) nameLabel += ` +${intifaceDevices.size - 1}`;
    setBadgeState('Intiface', 'connected', nameLabel, firstToy.battery !== null ? `🔋 ${firstToy.battery}%` : null);
}

// Session History & Funscript Downloader Hook
function saveSessionToHistory(outcome) {
    const history = JSON.parse(localStorage.getItem('edgeloop_history') || '[]');
    const sessionId = Date.now();
    history.unshift({
        id: sessionId,
        date: new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    duration: state.sessionSeconds,
                    edges: state.edges,
                    pauses: state.pauses,
                    peakHr: state.peakHr,
                    outcome,
                    primaryActions: [...funscriptPrimary],
                    secondaryActions: [...funscriptSecondary]
    });
    if (history.length > 10) history.pop();
    try {
        localStorage.setItem('edgeloop_history', JSON.stringify(history));
    } catch (e) {
        console.warn("Storage quota limit reached; saving without traces", e);
    }
}

window.downloadFunscript = (sessionId, channel) => {
    const history = JSON.parse(localStorage.getItem('edgeloop_history') || '[]');
    const session = history.find(s => s.id === sessionId);
    if (!session) return alert("Session log not found.");

    const actions = channel === 'primary' ? (session.primaryActions || []) : (session.secondaryActions || []);
    if (!actions || actions.length === 0) return alert("No motion recorded for this channel during this session.");

    const funscriptPayload = {
        version: "1.0",
        inverted: false,
        range: 100,
        actions: actions
    };

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
    const history = JSON.parse(localStorage.getItem('edgeloop_history') || '[]');
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
    localStorage.removeItem('edgeloop_history');
    renderHistory();
});

// Partner WebRTC Sync
function setupPartnerHost() {
    initHostPeer({
        onPeerReady: (id) => {
            const share = document.getElementById('partnerShareUrl');
            const group = document.getElementById('groupShareUrl');
            if (share) share.value = `${window.location.origin}${window.location.pathname}?partner=${id}`;
            if (group) group.value = `${window.location.origin}${window.location.pathname}?group_sub=${id}`;
            const status = document.getElementById('partnerStatusText');
            if (status) status.textContent = "Ready (Awaiting Controller)";
        },
        onPartnerConnected: () => {
            const status = document.getElementById('partnerStatusText');
            if (status) {
                status.textContent = "Controller Connected";
                status.className = "font-bold text-emerald-400";
            }
            syncTelemetry();
        },
        onCommandReceived: (cmd) => {
            if (cmd.type === 'SESSION_STATE') {
                if ((cmd.status === 'RUNNING' && state.sessionStatus !== 'RUNNING') || (cmd.status === 'PAUSED' && state.sessionStatus === 'RUNNING')) playPauseBtn?.click();
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

function syncTelemetry() {
    if (isRemoteController) return;
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
        activeMode: state.activeMode
    });
}

document.getElementById('copyShareUrlBtn')?.addEventListener('click', () => {
    const copyInput = document.getElementById('partnerShareUrl');
    if (!copyInput) return;
    copyInput.select();
    navigator.clipboard.writeText(copyInput.value);
    const btn = document.getElementById('copyShareUrlBtn');
    if (btn) {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    }
});

document.getElementById('copyGroupUrlBtn')?.addEventListener('click', () => {
    const copyInput = document.getElementById('groupShareUrl');
    if (!copyInput) return;
    copyInput.select();
    navigator.clipboard.writeText(copyInput.value);
    const btn = document.getElementById('copyGroupUrlBtn');
    if (btn) {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 2000);
    }
});

// Boot Initialization
initHandyRoleUI();
renderLearningStatus();
checkReadiness();
updateEngine();
