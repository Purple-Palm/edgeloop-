// The Handy Wi-Fi driver (REST API v2, HAMP mode).
//
// Design rules, in priority order:
//   1. Fail safe: any doubt about the device state ends in a verified stop.
//      A stop is retried with backoff until the API confirms it; a device
//      that went offline while its motor was running, or may have been,
//      keeps being sent stops in the background until one is confirmed; a
//      start that may have reached the device after a stop is followed by
//      another stop; a start the API did not confirm counts as one that may
//      have moved the device unless the API said the device was not
//      connected (see startHamp); the key the start was issued with is the
//      key that stop uses, so Disconnect or a reconnect can never orphan a
//      moving device. What a motor is still owed is kept by its key, not by
//      the link (see deviceMotion), so Connect with the key already in use
//      takes over every doubt the old link had not settled.
//      The converse is kept just as strictly: a motor this driver never
//      started, or last saw confirmed stopped, is never reported as one
//      that "may still be moving", so that warning still means something
//      on the day it is true.
//   2. Never exceed the user's hardware envelope; the stroke range sent to
//      PUT /slide is always normalised through handy-protocol.js, then moved
//      off the mechanical ends by the end-stop margin (inside that same
//      envelope, so the envelope still bounds it), and the range is
//      confirmed by the API before the motor is started.
//   3. Stay under the API rate limit: velocity is throttled to one call per
//      400 ms (a zero that sends nothing takes no turn, see dispatchHandy),
//      the slide range to one call per second unless it changed, and the
//      GET /connected poll to one call per 10 s in a session and one per
//      30 s outside one (see startOfflinePolling).
//   4. Never show a link that is not there: the poll runs for as long as a
//      Handy is connected, in a session or not, and START / RESUME ask the
//      API again before anything moves (pollHandyConnected, used by app.js).
//
// All fetch calls go through handyRequest(), which classifies the reply and
// reports failures through the error handler installed by app.js.

import {
    HANDY_API_BASE,
    HANDY_MODE,
    HANDY_DEFAULT_END_MARGIN,
    applyEndMargin,
    classifyHandyResponse,
    clampVelocity,
    describeDeviceStop,
    describeSlideAdjustment,
    isDeviceNotConnectedError,
    isHampModeError,
    normalizeSlideRange,
    parseBatteryLevel,
    describeHandyInfo
} from './handy-protocol.js';

export let handyConnected = false;

const VELOCITY_THROTTLE_MS = 400;
const STROKE_THROTTLE_MS = 1000;
const OFFLINE_POLL_FAILURES = 3;
// Why a link was dropped, as the wearer reads it on the banner.
const OFFLINE_REPORTED = 'The Handy reports it is no longer connected to Wi-Fi.';
const OFFLINE_UNREACHABLE = 'The Handy API is unreachable.';
// Consecutive dispatch TICKS (not requests: one tick may send /slide and
// /hamp/velocity together) that must fail before the device is offline.
const OFFLINE_DISPATCH_FAILURES = 5;
// How many background stop rounds an offline device gets before giving up
// (60 rounds at the default 5 s spacing: five minutes).
const OFFLINE_STOP_MAX_ROUNDS = 60;

// Mutable so tests can shorten the waits.
export const HANDY_TIMINGS = {
    requestTimeoutMs: 6000,
    // PUT /hamp/stop backoff between the four attempts of one verified stop.
    stopRetryDelaysMs: [250, 500, 1000],
    // Pause between rounds of the background stop sent to an offline device.
    offlineStopRetryMs: 5000,
    // The GET /connected poll: one tick per pollMs while a Handy is
    // connected, a request on every tick during a session and on every
    // idlePollMs / pollMs-th tick outside one (see startOfflinePolling).
    pollMs: 10000,
    idlePollMs: 30000
};

let handyKey = '';
let handyInfo = null;
let handyIsHampRunning = false;
// True for the whole of a start: while its slide range is on the way and
// while PUT /hamp/start itself is.
let handyStartInFlight = false;
// True while this link cannot tell whether the device is moving (a start
// the API did not confirm but may have carried to the device, or the page
// sent its last stop with nobody left to read the answer): the next
// zero-speed dispatch then sends a verified stop instead of nothing.
let handyMotionUnknown = false;
// Every verified PUT /hamp/stop is numbered as it leaves (attemptStop,
// verifyKey), so that a stop sent after a start came back can be told from
// one that was already on its way and may have reached the device first.
let stopsSent = 0;
// What each device's motor may still be doing, by connection key:
// { startsOut, unsettledSince }. A key names a device, not a link: Connect
// with the key already in use - after an API error, after Disconnect, or
// once the device was found offline - reaches the same motor, so what the
// old link owed it must still count on the new one. It used to be kept
// only in flags of the link, which every change of link clears. A
// reconnect then forgot a start that had come back behind the stop meant
// to cancel it, so the stop sent to undo it went out as one nobody needed
// to hear back from, and a device that died right then was neither chased
// nor warned about; it forgot a start still on its way, so a device that
// died before that start came back was not chased; and it forgot a motor
// set going after its own verification stop had left, so a paused session
// sent that motor nothing at all.
//   startsOut       PUT /hamp/start requests on their way: the motor can
//                   begin to turn at any moment without us hearing about
//                   it. A start still waiting for its slide range has sent
//                   the device nothing that moves it and is not counted.
//   unsettledSince  null, or stopsSent at the moment a start came back
//                   that may have set the motor going: confirmed, answered
//                   behind a stop, or failed without the API saying the
//                   device never got it. Only a stop sent after that, and
//                   confirmed, says the motor is at rest again.
const deviceMotion = new Map();
// True while a reconnect has stopped the old device and is about to swap
// keys: engine ticks must not restart the old device in that window.
let handySwitching = false;
// The in-flight verified stop for the CURRENT device: { key, generation,
// promise }. Only reused by a caller that asks for the same key with no
// command issued in between; a stop for an old key never masks a new one.
let stopInFlight = null;
let handyLastSend = 0;
let handyLastStrokeSend = 0;
let handyLastStrokeSent = { min: -1, max: -1 };
let handyLastVelocitySent = -1;
let handyPendingVelocity = 0;
// One notice per connection each: the device's own HAMP error band, and a
// PUT /slide the device rounded to numbers of its own.
let hampFaultNotified = false;
let slideAdjustNotified = false;

// Every start/stop bumps this. A start promise that resolves after a later
// command sees a different generation and must not touch the running flag.
let commandGeneration = 0;
// Bumped by every start so a stale start's cleanup cannot clear the
// in-flight flag of a newer start.
let startSequence = 0;

// Dispatch ticks are numbered so the offline counter advances once per
// failed tick, however many requests that tick issued.
let dispatchSequence = 0;
let lastFailedDispatch = -1;
let consecutiveDispatchFailures = 0;
let consecutivePollFailures = 0;
let offlinePollTimer = null;
// Poll timer ticks since the last GET /connected went out.
let pollTicksSinceCheck = 0;
// Bumped whenever the link changes hands (connect, disconnect, offline). A
// /connected answer is only acted on when it is still about the link that
// asked: a slow reply about a dropped or replaced link must not take down
// the one that is live now.
let linkEpoch = 0;
// The background stop job for a device that went offline: { key, timer,
// rounds, active }. Cancelled by Connect and Disconnect.
let offlineStop = null;
// The last error shown to the user: { path, message }. Only a success on
// the SAME path clears it, so a /connected poll or a slide reply cannot
// hide a velocity call that keeps failing.
let lastReportedError = null;

const handlers = {
    onError: null,
    onOffline: null,
    onStopUnconfirmed: null,
    onNotice: null,
    isSessionActive: null
};

// app.js installs UI callbacks here:
//   onError(message | null)     -> non-null: show the API error; null: the failing call succeeded again
//   onOffline(reason)           -> the device stopped answering; motors must be treated as stopped
//   onStopUnconfirmed(message)  -> a stop the device may have needed was never confirmed by the API
//   onNotice(message)           -> the device said something worth reading; not an error, not a fault
//   isSessionActive()           -> true while a session is RUNNING or RAMPDOWN (sets the poll cadence)
export function setHandyHandlers({ onError, onOffline, onStopUnconfirmed, onNotice, isSessionActive } = {}) {
    if (onError !== undefined) handlers.onError = onError;
    if (onOffline !== undefined) handlers.onOffline = onOffline;
    if (onStopUnconfirmed !== undefined) handlers.onStopUnconfirmed = onStopUnconfirmed;
    if (onNotice !== undefined) handlers.onNotice = onNotice;
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

// True while the driver cannot vouch for the device being stopped, and does
// not know it to be running either: this link's own doubt, or one the
// device is still owed from an earlier link with the same key.
export function isHandyMotionUnknown() {
    if (handyIsHampRunning) return false;
    const record = deviceMotion.get(handyKey);
    return handyMotionUnknown || Boolean(record && record.unsettledSince !== null);
}

// True while the motor may be turning: it was started and no stop has been
// confirmed since, a PUT /hamp/start is on its way, or the motion is
// unknown - on this link, or on an earlier one with the same key. Only then
// is a stop that goes unconfirmed a reason to tell the wearer the device
// "may still be moving", and only then does a device that went offline get
// chased with stops.
function motorMayBeMoving() {
    return handyIsHampRunning || handyMotionUnknown || deviceMayMove(handyKey);
}

function motionRecord(key) {
    let record = deviceMotion.get(key);
    if (!record) {
        record = { startsOut: 0, unsettledSince: null };
        deviceMotion.set(key, record);
    }
    return record;
}

function dropIfSettled(key, record) {
    if (record.startsOut === 0 && record.unsettledSince === null) deviceMotion.delete(key);
}

// True while the device behind `key` may be moving, whichever link set it
// going.
function deviceMayMove(key) {
    const record = deviceMotion.get(key);
    return Boolean(record) && (record.startsOut > 0 || record.unsettledSince !== null);
}

// A start to `key` came back, or failed, in a way that may have set the
// motor going. A later start moves the mark on: a stop that went out before
// it came back settles nothing.
function noteMayHaveStarted(key) {
    motionRecord(key).unsettledSince = stopsSent;
}

// The API confirmed the PUT /hamp/stop that left as number `sentAs`.
function noteStopConfirmed(key, sentAs) {
    const record = deviceMotion.get(key);
    if (!record || record.unsettledSince === null || sentAs <= record.unsettledSince) return;
    record.unsettledSince = null;
    dropIfSettled(key, record);
}

// Every "once per connection" latch, cleared when the link changes.
function resetDeviceNotices() {
    hampFaultNotified = false;
    slideAdjustNotified = false;
}

function callHandler(name, ...args) {
    const fn = handlers[name];
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (e) {}
}

function reportError(path, message) {
    lastReportedError = { path, message };
    callHandler('onError', message);
}

function reportRecovered(path) {
    if (lastReportedError === null || lastReportedError.path !== path) return;
    lastReportedError = null;
    callHandler('onError', null);
}

function reportStopUnconfirmed(path, error) {
    const message = `Stop not confirmed: ${error && error.message ? error.message : 'unknown error'}`;
    reportError(path, message);
    callHandler('onStopUnconfirmed', message);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function unref(timer) {
    // Never keep a node:test process alive; a no-op in browsers.
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
}

// One API call. Resolves with the parsed body on success, throws an Error with
// a human-readable message on any failure (network, HTTP status, error object,
// result -1). The error is flagged `undelivered` when the API itself said the
// command never reached the device (its DEVICE_NOT_CONNECTED answer). Every
// other failure - our own timeout or a network error, the API's DEVICE_TIMEOUT
// ("a response from the device was not received"), a device or server error -
// leaves open whether the device acted on the command, and startHamp treats
// it so. Tracks the consecutive-failure counter that drives offline detection
// while connected.
async function handyRequest(path, { method = 'GET', body = undefined, key = handyKey, countFailure = true } = {}) {
    if (!key) throw new Error('No Handy connection key');
    const headers = { 'X-Connection-Key': key };
    const init = { method, headers };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const tick = dispatchSequence;
    let abortTimer = null;
    if (typeof AbortController === 'function') {
        const controller = new AbortController();
        init.signal = controller.signal;
        abortTimer = setTimeout(() => controller.abort(), HANDY_TIMINGS.requestTimeoutMs);
    }

    let res;
    let data = null;
    try {
        res = await fetch(`${HANDY_API_BASE}${path}`, init);
        try { data = await res.json(); } catch (e) { data = null; }
    } catch (e) {
        const msg = (e && e.name === 'AbortError') ? `Request timed out (${path})` : `Network error (${path})`;
        noteFailure(path, msg, countFailure, tick);
        const err = new Error(msg);
        err.undelivered = false;
        throw err;
    } finally {
        if (abortTimer !== null) clearTimeout(abortTimer);
    }

    const verdict = classifyHandyResponse(res.ok, res.status, data, path);
    if (!verdict.ok) {
        noteFailure(path, verdict.message, countFailure, tick);
        // Every call the driver makes is one the session asked for, so a HAMP
        // refusal of it is worth explaining to the wearer.
        noteHampFault(verdict.code);
        const err = new Error(verdict.message);
        err.undelivered = isDeviceNotConnectedError(data);
        throw err;
    }
    if (countFailure) consecutiveDispatchFailures = 0;
    reportRecovered(path);
    return data;
}

function noteFailure(path, message, countFailure, tick) {
    reportError(path, message);
    if (!countFailure) return;
    // One failed tick counts once, however many of its requests failed.
    if (tick === lastFailedDispatch) return;
    lastFailedDispatch = tick;
    consecutiveDispatchFailures += 1;
    if (handyConnected && consecutiveDispatchFailures >= OFFLINE_DISPATCH_FAILURES) {
        markOffline(`The Handy stopped responding (${consecutiveDispatchFailures} failed commands).`);
    }
}

// API v2 has exactly one HAMP error code, ERROR(3000) "Unspecified HAMP
// error", so a slider the firmware has locked out arrives - if it arrives at
// all - as that and nothing else. We cannot claim which fault it was, only
// say what the device does and what the wearer can change. Once per
// connection: a device that keeps refusing would otherwise repeat it every
// tick, and the failure itself is already on the status line.
function noteHampFault(code) {
    if (!isHampModeError(code) || hampFaultNotified) return;
    hampFaultNotified = true;
    callHandler('onNotice', describeDeviceStop(`The Handy refused a motion command (HAMP error ${code}).`));
}

// The retry loop behind every verified stop: PUT /hamp/stop for `key`, up
// to four attempts with backoff. Touches no link state and never throws; a
// confirmed attempt is entered against the device (noteStopConfirmed), by
// the number it left with, since a retry that left after a start came back
// is a stop that start has had. Resolves { ok, error }.
async function attemptStop(key, { countFailure = true } = {}) {
    const delays = HANDY_TIMINGS.stopRetryDelaysMs;
    let lastErr = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        const sentAs = ++stopsSent;
        try {
            await handyRequest('/hamp/stop', { method: 'PUT', key, countFailure });
            noteStopConfirmed(key, sentAs);
            return { ok: true, error: null };
        } catch (e) {
            lastErr = e;
            if (attempt < delays.length) await sleep(delays[attempt]);
        }
    }
    return { ok: false, error: lastErr };
}

// Verified stop for a device this driver no longer owns (the key of a
// disconnected, replaced or stale link). `mayMove` says whether the motor
// could be turning: when the link was let go, or, for the stop that follows
// a start which came back behind a stop, whether no stop sent since has
// been confirmed (deviceMayMove). Resolves whether the device is
// known to be at rest: true when the stop was confirmed, and true as well
// when it was only ever confirming a motor already known to be stopped - an
// unanswered stop to a motor that never turned is reported nowhere, because
// "may still be moving" would be false.
async function stopForeignDevice(key, mayMove = true) {
    const result = await attemptStop(key);
    if (result.ok || !mayMove) return true;
    reportStopUnconfirmed('/hamp/stop', result.error);
    return false;
}

// Drop the connection from our side and tell app.js, which pauses the
// session. A motor that was running, or may have been (a PUT /hamp/start on
// its way, or a start or last stop nobody heard back from), keeps receiving
// stops in the background until one is confirmed. A motor this driver never
// started, or last saw confirmed stopped, gets none: a device that is off
// answers nothing, so the job used to fire four stops every five seconds
// at a toy that had not turned all session (role OFF, or a pause whose stop
// was confirmed) and tell the wearer after the first four that it "may
// still be moving".
function markOffline(reason) {
    if (!handyConnected) return;
    const key = handyKey;
    const mayMove = motorMayBeMoving();
    handyConnected = false;
    handyIsHampRunning = false;
    handyStartInFlight = false;
    handyMotionUnknown = false;
    handySwitching = false;
    commandGeneration += 1;
    linkEpoch += 1;
    stopOfflinePolling();
    if (key && mayMove) beginOfflineStop(key);
    callHandler('onOffline', reason);
}

// Keep sending PUT /hamp/stop to an offline device (one verified-stop round
// per HANDY_TIMINGS.offlineStopRetryMs) until the API confirms one, the job
// is cancelled by Connect / Disconnect, or the round cap is reached. A device
// that was merely slow, or comes back after a Wi-Fi blip, is brought to rest
// by this even though the app already gave up on it.
function beginOfflineStop(key) {
    cancelOfflineStop();
    const job = { key, timer: null, rounds: 0, active: true };
    offlineStop = job;
    const round = async () => {
        if (!job.active) return;
        job.rounds += 1;
        const result = await attemptStop(key, { countFailure: false });
        if (!job.active) return;
        if (result.ok || job.rounds >= OFFLINE_STOP_MAX_ROUNDS) {
            job.active = false;
            if (offlineStop === job) offlineStop = null;
            return;
        }
        if (job.rounds === 1) reportStopUnconfirmed('/hamp/stop', result.error);
        job.timer = unref(setTimeout(round, HANDY_TIMINGS.offlineStopRetryMs));
    };
    round();
}

function cancelOfflineStop() {
    if (!offlineStop) return;
    offlineStop.active = false;
    if (offlineStop.timer) clearTimeout(offlineStop.timer);
    offlineStop = null;
}

// True while a background stop for an offline device is still unconfirmed.
export function isHandyOfflineStopPending() {
    return Boolean(offlineStop && offlineStop.active);
}

// The connectivity poll: GET /connected, which the v2 spec names as the
// endpoint for "a continuous device connectivity check". It runs for as long
// as a Handy is connected. It used to run only during a session, so a Handy
// switched off between sessions left the card green, the modal saying
// "Connected" and START enabled for as long as anyone looked; START then
// drove the dead device for several seconds before the dispatch failures
// paused it.
//
// The cadence comes from the rate limit the spec documents: a per-minute
// window (X-RateLimit-Limit, "Request limit per minute window", example
// 240). The timer ticks every HANDY_TIMINGS.pollMs (10 s):
//   - in a session every tick polls, 6 requests a minute, as it always has.
//     There the dispatch failure counter already catches a dead device in
//     about five seconds; the poll is for the device that is sent nothing
//     (role OFF, or a speed of 0);
//   - outside a session only every third tick polls (idlePollMs, 30 s):
//     2 requests a minute, 1/120 of the documented 240, so it cannot be
//     what takes a key near its limit, even with EdgeLoop open in several
//     tabs or another app driving the same device. Three failed polls in a
//     row, the rule for an unreachable API, take a full minute at this
//     pace, the length of a whole rate-limit window, so one window spent by
//     other traffic is not enough on its own to take the link down. A
//     device that is switched off answers { connected: false } straight
//     away and is shown offline within 30 s; START and RESUME do not rely
//     on that, they ask the API themselves first.
function startOfflinePolling() {
    stopOfflinePolling();
    consecutivePollFailures = 0;
    pollTicksSinceCheck = 0;
    offlinePollTimer = unref(setInterval(handyPollTick, HANDY_TIMINGS.pollMs));
}

function stopOfflinePolling() {
    if (offlinePollTimer !== null) {
        clearInterval(offlinePollTimer);
        offlinePollTimer = null;
    }
    consecutivePollFailures = 0;
}

function sessionIsActive() {
    return typeof handlers.isSessionActive === 'function' ? Boolean(handlers.isSessionActive()) : false;
}

// One tick of the poll timer: sends GET /connected when one is due and
// resolves with what pollHandyConnected() found, or null when none was due.
// Exported so the cadence is testable without waiting on the real timer.
export function handyPollTick() {
    if (!handyConnected) { stopOfflinePolling(); return Promise.resolve(null); }
    pollTicksSinceCheck += 1;
    const idleTicks = Math.max(1, Math.round(HANDY_TIMINGS.idlePollMs / HANDY_TIMINGS.pollMs));
    const due = sessionIsActive() ? 1 : idleTicks;
    if (pollTicksSinceCheck < due) return Promise.resolve(null);
    return pollHandyConnected();
}

// One GET /connected for the link as it stands, from the timer or from
// START / RESUME in app.js (the poll can be up to 30 s behind a device that
// was just switched off, so a session never starts on its word alone).
// connected:false marks the link offline at once; OFFLINE_POLL_FAILURES
// failed requests in a row mark it unreachable. An answer that arrives after
// the link was dropped or replaced is ignored. Resolves { state, reason },
// with a `cause` as well when the state is 'offline':
//   'online'       the device answered connected: true;
//   'offline'      the link was just marked offline (reason: why), with
//                  cause 'device' when the device said it is not connected
//                  and 'api' when the API could not be reached, so that
//                  START's refusal does not send the wearer to check a
//                  device when it is the network that failed;
//   'unreachable'  this request failed, the link is kept until the count
//                  runs out (reason: the error);
//   'lost'         there is no link, or it was dropped while the request
//                  was out (Disconnect, or another check took it offline);
//   'stale'        the link was replaced while the request was out.
export async function pollHandyConnected() {
    if (!handyConnected || !handyKey) {
        stopOfflinePolling();
        return { state: 'lost', reason: 'The Handy is not connected.' };
    }
    const epoch = linkEpoch;
    pollTicksSinceCheck = 0;
    try {
        const data = await handyRequest('/connected', { countFailure: false });
        if (epoch !== linkEpoch) return answerForOldLink();
        if (!data || data.connected !== true) {
            markOffline(OFFLINE_REPORTED);
            return { state: 'offline', reason: OFFLINE_REPORTED, cause: 'device' };
        }
        consecutivePollFailures = 0;
        return { state: 'online', reason: null };
    } catch (e) {
        if (epoch !== linkEpoch) return answerForOldLink();
        consecutivePollFailures += 1;
        if (consecutivePollFailures >= OFFLINE_POLL_FAILURES) {
            markOffline(OFFLINE_UNREACHABLE);
            return { state: 'offline', reason: OFFLINE_UNREACHABLE, cause: 'api' };
        }
        return { state: 'unreachable', reason: e && e.message ? e.message : 'unknown error' };
    }
}

// What an answer means once the link it was asked for is no longer live.
function answerForOldLink() {
    return handyConnected
        ? { state: 'stale', reason: 'The Handy connection changed while it was being checked.' }
        : { state: 'lost', reason: 'The Handy connection was lost while it was being checked.' };
}

// Verify a key without touching the live state: the device must be online,
// switch to HAMP mode and accept a stop. Resolves the /info body (null when
// unavailable); throws a descriptive Error on any failure.
async function verifyKey(key) {
    const conn = await handyRequest('/connected', { key, countFailure: false });
    if (!conn || conn.connected !== true) {
        throw new Error('The Handy is offline. Check its Wi-Fi status on the device.');
    }

    const mode = await handyRequest('/mode', { method: 'PUT', body: { mode: HANDY_MODE.HAMP }, key, countFailure: false });
    if (!mode || typeof mode.result !== 'number' || mode.result < 0) {
        throw new Error('Could not switch The Handy into HAMP mode.');
    }

    // A confirmed stop like any other: it settles whatever an earlier link
    // with this key had started before it left, and nothing that came back
    // after (see deviceMotion).
    const sentAs = ++stopsSent;
    await handyRequest('/hamp/stop', { method: 'PUT', key, countFailure: false });
    noteStopConfirmed(key, sentAs);

    try {
        return await handyRequest('/info', { key, countFailure: false });
    } catch (e) {
        return null;
    }
}

// Connect: verify the new key first (online, HAMP mode, stopped, info), and
// only then replace the current link. A live device is brought to a
// confirmed stop before its key is dropped; if that stop is never confirmed
// the current link is left exactly as it was and the error says so, so
// STOP keeps reaching the device that is moving. The new link starts with
// clear flags, but a device is not a link: when the key is the one already
// in use, a start still on its way to that device, or one that came back
// after the stops sent so far, is still owed a confirmed stop on the new
// link (see deviceMotion). Resolves with { battery, info, description };
// throws a descriptive Error on any failure.
export async function connectHandy(key) {
    const trimmed = (key || '').trim();
    if (!trimmed) throw new Error('Connection key is empty');

    // Nothing below touches the live link until the new key has passed.
    const info = await verifyKey(trimmed);

    if (handyConnected && handyKey) {
        const oldKey = handyKey;
        const oldMayMove = handyStartInFlight || motorMayBeMoving();
        if (oldMayMove) {
            // Freeze the engine's motion commands to the old device while it
            // is stopped; zero-speed dispatches still go through.
            handySwitching = true;
            let confirmed = false;
            try {
                confirmed = await stopWithRetry(oldKey);
            } finally {
                handySwitching = false;
            }
            if (!confirmed) {
                throw new Error('The connected Handy did not confirm a stop; the connection was left unchanged.');
            }
        }
    }

    cancelOfflineStop();
    stopOfflinePolling();
    handyKey = trimmed;
    handyInfo = info;
    handyConnected = true;
    handyIsHampRunning = false;
    handyStartInFlight = false;
    handyMotionUnknown = false;
    handySwitching = false;
    commandGeneration += 1;
    startSequence += 1;
    linkEpoch += 1;
    consecutiveDispatchFailures = 0;
    lastFailedDispatch = -1;
    lastReportedError = null;
    handyLastStrokeSent = { min: -1, max: -1 };
    handyLastVelocitySent = -1;
    handyLastSend = 0;
    handyLastStrokeSend = 0;
    resetDeviceNotices();
    startOfflinePolling();

    return {
        battery: parseBatteryLevel(info),
        info,
        description: describeHandyInfo(info)
    };
}

// Disconnect from our side. Sends a verified stop with the stored key first
// so the device is never left moving, and resolves with whether the device
// is known to be at rest: whether the API confirmed that stop, and true when
// there was nothing to stop (no link, or a motor last seen confirmed
// stopped - disconnecting a Handy that was switched off while idle is not a
// motor that "may still be moving"). The link is dropped immediately;
// further dispatches are ignored.
export function disconnectHandy() {
    const wasConnected = handyConnected;
    const key = handyKey;
    // Read before the link is dropped: after it, every motion flag is clear.
    const mayMove = motorMayBeMoving();
    cancelOfflineStop();
    stopOfflinePolling();
    handyConnected = false;
    handyStartInFlight = false;
    handyMotionUnknown = false;
    handySwitching = false;
    commandGeneration += 1;
    startSequence += 1;
    linkEpoch += 1;
    handyIsHampRunning = false;
    handyKey = '';
    handyInfo = null;
    handyLastStrokeSent = { min: -1, max: -1 };
    handyLastVelocitySent = -1;
    resetDeviceNotices();
    if (!wasConnected || !key) return Promise.resolve(true);
    return stopForeignDevice(key, mayMove);
}

// PUT /hamp/stop with up to three retries (250 / 500 / 1000 ms backoff).
// Resolves true only when the API confirmed the stop; running=false is set
// exclusively on that path. Concurrent callers asking for the same key with
// no command in between share the in-flight promise. Always called for the
// live link, whose motor state - its own flags and what the device behind
// its key is still owed - decides what an unconfirmed stop means: the
// wearer is told the device "may still be moving" only when it was running,
// or may have been, when the stop was asked for. A forced stop to a motor
// that never turned - PAUSE or STOP with role OFF, Reset in IDLE - that a
// switched-off device leaves unanswered stays an API error on the status
// line and nothing more.
function stopWithRetry(key = handyKey) {
    const mayMove = motorMayBeMoving();
    if (stopInFlight && stopInFlight.key === key && stopInFlight.generation === commandGeneration) {
        // A caller that knows of motion can only make the shared stop more urgent.
        if (mayMove) stopInFlight.mayMove = true;
        return stopInFlight.promise;
    }
    const generation = ++commandGeneration;
    const record = { key, generation, mayMove, promise: null };
    record.promise = (async () => {
        const result = await attemptStop(key);
        if (result.ok) {
            if (generation === commandGeneration) {
                handyIsHampRunning = false;
                handyMotionUnknown = false;
                handyLastVelocitySent = -1;
            }
            return true;
        }
        if (record.mayMove) reportStopUnconfirmed('/hamp/stop', result.error);
        return false;
    })();
    stopInFlight = record;
    record.promise.catch(() => {}).finally(() => {
        if (stopInFlight === record) stopInFlight = null;
    });
    return record.promise;
}

// Public verified stop. Used by app.js STOP paths; safe to call at any time.
export async function stopHandy() {
    if (!handyConnected || !handyKey) return false;
    return stopWithRetry(handyKey);
}

// A stop or disconnect happened while a start was in flight. The device may
// now be moving even though we asked it to stop, so wait for any stop that
// is still in flight for that key (it may have reached the device before
// this start did) and then send a fresh verified stop rather than trusting
// the earlier one. The key is the one the start was issued with, so this
// still reaches a device that has since been disconnected or replaced.
// Until a stop sent after this moment is confirmed nobody knows whether the
// motor is turning, and the device's record says so (noteMayHaveStarted),
// so that an offline verdict in the meantime still chases the device with
// stops and the fresh stop, unanswered, is the alarm. The record belongs to
// the key rather than to the link, and only a stop that left after this
// moment settles it, because two things used to clear the doubt too early.
// The pause's stop, when the start landed while it was still out: it was
// sent before anyone knew what became of the start and may have reached the
// device first. And Connect with the same key, whose change of link wiped
// the flag while that stop was out, so the fresh stop went out on the new
// link as one nobody needed to hear back from. Either way a device that
// died right then was neither chased nor warned about.
function restopAfterStaleStart(key) {
    noteMayHaveStarted(key);
    // A stop asked for from here on must be a fresh one: sharing the stop
    // that is already on its way would settle nothing.
    if (handyConnected && handyKey === key) commandGeneration += 1;
    const pending = stopInFlight && stopInFlight.key === key ? stopInFlight.promise : Promise.resolve();
    pending.catch(() => {}).then(() => {
        if (handyConnected && handyKey === key) return stopWithRetry(key);
        return stopForeignDevice(key, deviceMayMove(key));
    }).catch(() => {});
}

// Start HAMP motion. `rangeConfirmed` resolves once PUT /slide for the
// current range has been answered (true on success): the motor is only
// started after the range landed, so the first strokes can never run at a
// stale range the device still holds.
async function startHamp(velocity, rangeConfirmed = Promise.resolve(true)) {
    if (handyStartInFlight) {
        handyPendingVelocity = velocity;
        return;
    }
    handyStartInFlight = true;
    handyPendingVelocity = velocity;
    const key = handyKey;
    const generation = ++commandGeneration;
    const sequence = ++startSequence;
    // Whether PUT /hamp/start left at all: a start that failed before it
    // has sent the device nothing that moves it.
    let requested = false;
    try {
        const rangeOk = await rangeConfirmed.then((ok) => ok !== false, () => false);
        // A stop or disconnect while the range was in flight: nothing has been
        // started, so there is nothing to undo.
        if (generation !== commandGeneration) return;
        // The range never reached the device: do not move at an unknown
        // range; the next tick re-sends it and tries again.
        if (!rangeOk) return;
        requested = true;
        motionRecord(key).startsOut += 1;
        await handyRequest('/hamp/start', { method: 'PUT', key });
        if (generation !== commandGeneration) {
            restopAfterStaleStart(key);
            return;
        }
        handyIsHampRunning = true;
        handyMotionUnknown = false;
        noteMayHaveStarted(key);
        sendVelocity(handyPendingVelocity);
    } catch (e) {
        // A start the API did not confirm may still have moved the device:
        // the request may have been relayed and its answer lost (our own
        // timeout, a network error), the API may have relayed it and heard
        // nothing back (its DEVICE_TIMEOUT, "a response from the device was
        // not received"), or the relay may yet deliver it. Only the API's
        // word that the device was not connected settles it: nothing was
        // forwarded, so nothing turned. This used to count our own timeouts
        // alone as doubt, so a start the API answered with its device
        // timeout passed for one that never started, and a device it may
        // have set moving was neither chased nor warned about when it then
        // went offline.
        const mayHaveMoved = requested && !(e && e.undelivered);
        if (generation !== commandGeneration) {
            // A stop was issued while the start was out: the start may reach
            // the device after that stop, so it is stopped again.
            if (mayHaveMoved) restopAfterStaleStart(key);
            return;
        }
        handyIsHampRunning = false;
        // The next zero-speed dispatch then sends a verified stop rather
        // than nothing, and an offline verdict chases the device.
        if (mayHaveMoved) {
            handyMotionUnknown = true;
            noteMayHaveStarted(key);
        }
    } finally {
        // Only after whatever the answer settled has been noted above, so
        // the device is never left looking idle in between.
        if (requested) {
            const record = motionRecord(key);
            record.startsOut -= 1;
            dropIfSettled(key, record);
        }
        if (sequence === startSequence) handyStartInFlight = false;
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

// PUT /slide. Resolves true when the API accepted the range, false when it
// did not (the range is then re-sent on the next tick).
function sendSlide(range) {
    handyLastStrokeSent = { min: range.min, max: range.max };
    return handyRequest('/slide', { method: 'PUT', body: { min: range.min, max: range.max } })
        .then((body) => {
            // The device reports when it did not take our numbers. Said once
            // per connection: it is the same news every tick afterwards.
            const adjusted = describeSlideAdjustment(body, range);
            if (adjusted && !slideAdjustNotified) {
                slideAdjustNotified = true;
                callHandler('onNotice', adjusted);
            }
            return true;
        })
        .catch(() => {
            handyLastStrokeSent = { min: -1, max: -1 };
            return false;
        });
}

// Main dispatch entry point. strokeMin/strokeMax are physical sleeve percents
// that app.js has ALREADY mapped into the hardware envelope (engine.js does
// the mapping); the envelope arguments are used only to widen a too-narrow
// range in the right direction without leaving the user's bounds.
// `endMargin` is the wearer's end-stop margin in percent of travel (0 = off):
// the normalised range is moved inside the envelope less that margin,
// keeping its length wherever that leaves room for it, so the envelope
// still bounds everything that reaches the device and a short stroke pinned
// to an end is moved off it too.
export function dispatchHandy(primarySpeed, strokeMin, strokeMax, force = false, envMin = 0, envMax = 100, endMargin = HANDY_DEFAULT_END_MARGIN) {
    if (!handyConnected || !handyKey) return;
    const now = Date.now();
    if (!force && (now - handyLastSend < VELOCITY_THROTTLE_MS)) return;

    const velocity = clampVelocity(primarySpeed);
    // A zero for a motor this driver knows to be at rest sends nothing, so
    // it is no dispatch at all: it takes no turn from the throttle, which is
    // there for the API's rate limit, and no number in the tick count. It
    // used to take a turn. The engine dispatches a zero on every clock tick
    // and heart-rate packet while no session runs, and START and RESUME
    // dispatch one more while The Handy is asked whether it is online, so
    // the dispatch that starts the motor, a moment later, fell inside the
    // window and waited for the next tick or packet: measured with the page
    // against a mocked API, the session read RUNNING for up to 1.4 s before
    // the device was sent anything.
    const stopNeeded = force || handyStartInFlight || motorMayBeMoving();
    if (velocity === 0 && !stopNeeded) return;
    handyLastSend = now;
    dispatchSequence += 1;

    if (velocity === 0) {
        stopWithRetry(handyKey).catch(() => {});
        handyLastStrokeSent = { min: -1, max: -1 };
        return;
    }

    // A reconnect is stopping this device before replacing it: no motion.
    if (handySwitching) return;

    // The margin is handed the same envelope the range was normalised into:
    // without it the margin could only cut the zone, and a minimum-width
    // zone on an end has nothing to cut, so it stayed on the end stop.
    const range = applyEndMargin(normalizeSlideRange(strokeMin, strokeMax, envMin, envMax), endMargin, { min: envMin, max: envMax });
    const rangeChanged = range.min !== handyLastStrokeSent.min || range.max !== handyLastStrokeSent.max;
    let rangeConfirmed = Promise.resolve(true);
    if (force || rangeChanged || (now - handyLastStrokeSend > STROKE_THROTTLE_MS)) {
        handyLastStrokeSend = now;
        rangeConfirmed = sendSlide(range);
    }

    if (!handyIsHampRunning) {
        startHamp(velocity, rangeConfirmed);
    } else {
        sendVelocity(velocity);
    }
}

// Last-resort stop when the page goes away (pagehide / freeze): a plain
// request would be cancelled with the document, so the stop is sent with
// keepalive. The device is then treated as not running, so a page that
// comes back re-sends /hamp/start on its next tick - but not as confirmed
// stopped, because nobody reads the answer to a keepalive stop: its motion
// stays unknown until a verified stop or a start settles it, so a page
// that comes back idle sends that verified stop, and an offline verdict in
// the meantime still chases the device with stops. Returns whether a stop
// was sent. Never throws.
export function stopHandyOnUnload() {
    if (!handyConnected || !handyKey) return false;
    if (!(handyStartInFlight || motorMayBeMoving())) return false;
    const key = handyKey;
    commandGeneration += 1;
    handyIsHampRunning = false;
    handyMotionUnknown = true;
    handyLastVelocitySent = -1;
    handyLastStrokeSent = { min: -1, max: -1 };
    try {
        const pending = fetch(`${HANDY_API_BASE}/hamp/stop`, {
            method: 'PUT',
            headers: { 'X-Connection-Key': key },
            keepalive: true
        });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (e) {
        return false;
    }
    return true;
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
