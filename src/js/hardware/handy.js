// The Handy Wi-Fi driver (REST API v2, HAMP mode).
//
// Design rules, in priority order:
//   1. Fail safe: any doubt about the device state ends in a verified stop.
//   2. Never exceed the user's hardware envelope; the stroke range sent to
//      PUT /slide is always normalised through handy-protocol.js.
//   3. Stay under the API rate limit: velocity is throttled to one call per
//      400 ms and the slide range to one call per second unless it changed.
//
// All fetch calls go through handyRequest(), which classifies the reply and
// reports failures through the error handler installed by app.js.

import {
    HANDY_API_BASE,
    HANDY_MODE,
    classifyHandyResponse,
    clampVelocity,
    normalizeSlideRange,
    parseBatteryLevel,
    describeHandyInfo
} from './handy-protocol.js';

export let handyConnected = false;

const VELOCITY_THROTTLE_MS = 400;
const STROKE_THROTTLE_MS = 1000;
const STOP_RETRY_DELAYS_MS = [250, 500, 1000];
const OFFLINE_POLL_MS = 10000;
const OFFLINE_POLL_FAILURES = 3;
const OFFLINE_DISPATCH_FAILURES = 5;
const REQUEST_TIMEOUT_MS = 6000;

let handyKey = '';
let handyInfo = null;
let handyIsHampRunning = false;
let handyStartInFlight = false;
let handyStopInFlight = null;
let handyLastSend = 0;
let handyLastStrokeSend = 0;
let handyLastStrokeSent = { min: -1, max: -1 };
let handyLastVelocitySent = -1;
let handyPendingVelocity = 0;

// Every start/stop bumps this. A start promise that resolves after a later
// command sees a different generation and must not touch the running flag.
let commandGeneration = 0;

let consecutiveDispatchFailures = 0;
let consecutivePollFailures = 0;
let offlinePollTimer = null;
let lastReportedError = null;

const handlers = {
    onError: null,
    onOffline: null,
    isSessionActive: null
};

// app.js installs UI callbacks here:
//   onError(message | null)  -> non-null: show the API error; null: last call succeeded again
//   onOffline(reason)        -> the device stopped answering; motors must be treated as stopped
//   isSessionActive()        -> true while a session is RUNNING or RAMPDOWN
export function setHandyHandlers({ onError, onOffline, isSessionActive } = {}) {
    if (onError !== undefined) handlers.onError = onError;
    if (onOffline !== undefined) handlers.onOffline = onOffline;
    if (isSessionActive !== undefined) handlers.isSessionActive = isSessionActive;
}

export function getHandyKey() {
    return handyKey;
}

export function getHandyInfo() {
    return handyInfo;
}

export function isHandyMoving() {
    return handyIsHampRunning;
}

function reportError(message) {
    lastReportedError = message;
    if (typeof handlers.onError === 'function') {
        try { handlers.onError(message); } catch (e) {}
    }
}

function reportRecovered() {
    if (lastReportedError === null) return;
    lastReportedError = null;
    if (typeof handlers.onError === 'function') {
        try { handlers.onError(null); } catch (e) {}
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// One API call. Resolves with the parsed body on success, throws an Error with
// a human-readable message on any failure (network, HTTP status, error object,
// result -1). Tracks the consecutive-failure counter that drives offline
// detection while connected.
async function handyRequest(path, { method = 'GET', body = undefined, key = handyKey, countFailure = true } = {}) {
    if (!key) throw new Error('No Handy connection key');
    const headers = { 'X-Connection-Key': key };
    const init = { method, headers };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    let abortTimer = null;
    if (typeof AbortController === 'function') {
        const controller = new AbortController();
        init.signal = controller.signal;
        abortTimer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    }

    let res;
    let data = null;
    try {
        res = await fetch(`${HANDY_API_BASE}${path}`, init);
        try { data = await res.json(); } catch (e) { data = null; }
    } catch (e) {
        const msg = (e && e.name === 'AbortError') ? `Request timed out (${path})` : `Network error (${path})`;
        noteFailure(msg, countFailure);
        throw new Error(msg);
    } finally {
        if (abortTimer !== null) clearTimeout(abortTimer);
    }

    const verdict = classifyHandyResponse(res.ok, res.status, data, path);
    if (!verdict.ok) {
        noteFailure(verdict.message, countFailure);
        throw new Error(verdict.message);
    }
    if (countFailure) consecutiveDispatchFailures = 0;
    reportRecovered();
    return data;
}

function noteFailure(message, countFailure) {
    reportError(message);
    if (!countFailure) return;
    consecutiveDispatchFailures += 1;
    if (handyConnected && consecutiveDispatchFailures >= OFFLINE_DISPATCH_FAILURES) {
        markOffline(`The Handy stopped responding (${consecutiveDispatchFailures} failed commands).`);
    }
}

// Drop the connection from our side and tell app.js. Motors are assumed to be
// in an unknown state, so the UI path pauses the session.
function markOffline(reason) {
    if (!handyConnected) return;
    handyConnected = false;
    handyIsHampRunning = false;
    handyStartInFlight = false;
    commandGeneration += 1;
    stopOfflinePolling();
    // Best-effort single stop with the old key: if the device is merely slow
    // rather than gone, this is what brings it to rest.
    if (handyKey) handyRequest('/hamp/stop', { method: 'PUT', key: handyKey, countFailure: false }).catch(() => {});
    if (typeof handlers.onOffline === 'function') {
        try { handlers.onOffline(reason); } catch (e) {}
    }
}

function startOfflinePolling() {
    stopOfflinePolling();
    consecutivePollFailures = 0;
    offlinePollTimer = setInterval(pollHandyConnected, OFFLINE_POLL_MS);
    // Never keep a node:test process alive; a no-op in browsers.
    if (offlinePollTimer && typeof offlinePollTimer.unref === 'function') offlinePollTimer.unref();
}

function stopOfflinePolling() {
    if (offlinePollTimer !== null) {
        clearInterval(offlinePollTimer);
        offlinePollTimer = null;
    }
    consecutivePollFailures = 0;
}

// One offline-check tick. Exported so the timer logic stays testable.
export async function pollHandyConnected() {
    if (!handyConnected) { stopOfflinePolling(); return; }
    const active = typeof handlers.isSessionActive === 'function' ? Boolean(handlers.isSessionActive()) : false;
    if (!active) { consecutivePollFailures = 0; return; }
    try {
        const data = await handyRequest('/connected', { countFailure: false });
        if (!data || data.connected !== true) {
            markOffline('The Handy reports it is no longer connected to Wi-Fi.');
            return;
        }
        consecutivePollFailures = 0;
    } catch (e) {
        consecutivePollFailures += 1;
        if (consecutivePollFailures >= OFFLINE_POLL_FAILURES) {
            markOffline('The Handy API is unreachable.');
        }
    }
}

// Connect: verify the device is online, switch to HAMP mode, make sure it is
// stopped, then read firmware/model info. Resolves with { battery, info,
// description }; throws a descriptive Error on any failure.
export async function connectHandy(key) {
    const trimmed = (key || '').trim();
    if (!trimmed) throw new Error('Connection key is empty');

    // A previous connection must not keep polling with the old key.
    stopOfflinePolling();
    handyConnected = false;
    handyIsHampRunning = false;
    handyStartInFlight = false;
    commandGeneration += 1;
    consecutiveDispatchFailures = 0;
    lastReportedError = null;

    const conn = await handyRequest('/connected', { key: trimmed, countFailure: false });
    if (!conn || conn.connected !== true) {
        throw new Error('The Handy is offline. Check its Wi-Fi status on the device.');
    }

    const mode = await handyRequest('/mode', { method: 'PUT', body: { mode: HANDY_MODE.HAMP }, key: trimmed, countFailure: false });
    if (!mode || typeof mode.result !== 'number' || mode.result < 0) {
        throw new Error('Could not switch The Handy into HAMP mode.');
    }

    await handyRequest('/hamp/stop', { method: 'PUT', key: trimmed, countFailure: false });

    let info = null;
    try {
        info = await handyRequest('/info', { key: trimmed, countFailure: false });
    } catch (e) {
        info = null;
    }

    handyKey = trimmed;
    handyInfo = info;
    handyConnected = true;
    handyIsHampRunning = false;
    handyLastStrokeSent = { min: -1, max: -1 };
    handyLastVelocitySent = -1;
    handyLastSend = 0;
    handyLastStrokeSend = 0;
    startOfflinePolling();

    return {
        battery: parseBatteryLevel(info),
        info,
        description: describeHandyInfo(info)
    };
}

// Disconnect from our side. Sends a verified stop first (best effort) so the
// device is never left moving. The key argument is accepted for backwards
// compatibility but the stored key is what gets used.
export function disconnectHandy() {
    const wasConnected = handyConnected;
    stopOfflinePolling();
    handyConnected = false;
    handyStartInFlight = false;
    commandGeneration += 1;
    if (wasConnected && handyKey) {
        const key = handyKey;
        stopWithRetry(key).catch(() => {}).finally(() => {
            handyIsHampRunning = false;
        });
    } else {
        handyIsHampRunning = false;
    }
    handyKey = '';
    handyInfo = null;
    handyLastStrokeSent = { min: -1, max: -1 };
    handyLastVelocitySent = -1;
}

// PUT /hamp/stop with up to three retries (250 / 500 / 1000 ms backoff).
// Resolves true only when the API confirmed the stop; running=false is set
// exclusively on that path. Concurrent callers share the in-flight promise.
async function stopWithRetry(key = handyKey) {
    if (handyStopInFlight) return handyStopInFlight;
    const generation = ++commandGeneration;
    handyStopInFlight = (async () => {
        let lastErr = null;
        for (let attempt = 0; attempt <= STOP_RETRY_DELAYS_MS.length; attempt++) {
            try {
                await handyRequest('/hamp/stop', { method: 'PUT', key });
                if (generation === commandGeneration) {
                    handyIsHampRunning = false;
                    handyLastVelocitySent = -1;
                }
                return true;
            } catch (e) {
                lastErr = e;
                if (attempt < STOP_RETRY_DELAYS_MS.length) await sleep(STOP_RETRY_DELAYS_MS[attempt]);
            }
        }
        reportError(`Stop not confirmed: ${lastErr ? lastErr.message : 'unknown error'}`);
        return false;
    })();
    try {
        return await handyStopInFlight;
    } finally {
        handyStopInFlight = null;
    }
}

// Public verified stop. Used by app.js STOP paths; safe to call at any time.
export async function stopHandy() {
    if (!handyConnected || !handyKey) return false;
    return stopWithRetry(handyKey);
}

async function startHamp(velocity) {
    if (handyStartInFlight) {
        handyPendingVelocity = velocity;
        return;
    }
    handyStartInFlight = true;
    handyPendingVelocity = velocity;
    const generation = ++commandGeneration;
    try {
        await handyRequest('/hamp/start', { method: 'PUT' });
        if (generation !== commandGeneration) {
            // A stop or disconnect happened while start was in flight. The
            // device may now be moving even though we asked it to stop, so
            // wait for any stop that is still in flight (it may have reached
            // the device before this start did) and then send a fresh
            // verified stop rather than trusting the earlier one.
            if (handyConnected) {
                const pending = handyStopInFlight || Promise.resolve();
                pending.catch(() => {}).then(() => {
                    if (handyConnected) return stopWithRetry(handyKey);
                }).catch(() => {});
            }
            return;
        }
        handyIsHampRunning = true;
        sendVelocity(handyPendingVelocity);
    } catch (e) {
        if (generation === commandGeneration) handyIsHampRunning = false;
    } finally {
        handyStartInFlight = false;
    }
}

function sendVelocity(velocity) {
    const v = clampVelocity(velocity);
    if (v === handyLastVelocitySent) return;
    handyLastVelocitySent = v;
    handyRequest('/hamp/velocity', { method: 'PUT', body: { velocity: v } }).catch(() => {
        // Force a resend on the next tick; a lost velocity update must not
        // leave the device stuck at the previous speed.
        handyLastVelocitySent = -1;
    });
}

function sendSlide(range) {
    handyLastStrokeSent = { min: range.min, max: range.max };
    handyRequest('/slide', { method: 'PUT', body: { min: range.min, max: range.max } }).catch(() => {
        handyLastStrokeSent = { min: -1, max: -1 };
    });
}

// Main dispatch entry point. strokeMin/strokeMax are physical sleeve percents
// that app.js has ALREADY mapped into the hardware envelope (engine.js does
// the mapping); the envelope arguments are used only to widen a too-narrow
// range in the right direction without leaving the user's bounds.
export function dispatchHandy(primarySpeed, strokeMin, strokeMax, force = false, envMin = 0, envMax = 100) {
    if (!handyConnected || !handyKey) return;
    const now = Date.now();
    if (!force && (now - handyLastSend < VELOCITY_THROTTLE_MS)) return;
    handyLastSend = now;

    const velocity = clampVelocity(primarySpeed);

    if (velocity === 0) {
        if (handyIsHampRunning || force || handyStartInFlight) {
            stopWithRetry(handyKey).catch(() => {});
            handyLastStrokeSent = { min: -1, max: -1 };
        }
        return;
    }

    const range = normalizeSlideRange(strokeMin, strokeMax, envMin, envMax);
    const rangeChanged = range.min !== handyLastStrokeSent.min || range.max !== handyLastStrokeSent.max;
    if (force || rangeChanged || (now - handyLastStrokeSend > STROKE_THROTTLE_MS)) {
        handyLastStrokeSend = now;
        sendSlide(range);
    }

    if (!handyIsHampRunning) {
        startHamp(velocity);
    } else {
        sendVelocity(velocity);
    }
}

// The v2 spec has no battery endpoint. GET /info is the only place a level
// could appear; returns null when it does not.
export async function queryHandyBattery(key = handyKey) {
    try {
        const info = await handyRequest('/info', { key, countFailure: false });
        return parseBatteryLevel(info);
    } catch (e) {
        return null;
    }
}
