// Intiface Central / Buttplug v3 WebSocket driver.
//
// Design rules, in priority order:
//   1. Fail safe: any doubt (socket gone, handshake stalled, fatal server
//      error) ends with StopAllDevices where possible and motors treated as
//      stopped. Only a connection loss while toys are ASSIGNED a role pauses
//      the session (app.js decides via onClose).
//   2. Never exceed the user's limits: the stroke zone is clamped into the
//      hardware envelope and every per-axis cap scales the engine output.
//   3. Smooth motion: each linear axis is driven by a stroke planner
//      (stroke-planner.js) issuing ONE LinearCmd per leg with the full leg
//      duration, timed by a per-axis setTimeout at leg end. Engine ticks only
//      update the planner inputs: only a stop cuts a leg short, and only an
//      urgent dispatch (a guard engaging, a cut, Force Orgasm's landing)
//      re-times the leg in flight, to the position it was sent to and only
//      inside the envelope.
//      Vibrators and rotators get immediate updates, deduplicated so
//      identical values are not re-sent, never above the axis's cap; a
//      vibrator set to Pulsed runs a square wave of its own under the
//      engine's level (vibe-pulse.js), cut by any 0.
//   4. One motor, one mode: an Oscillate actuator and the linear axis of the
//      same motor (an OSSM, oscillateTwins) are never both in use, and the
//      one not in use is sent nothing (silenced). A ScalarCmd Position is a
//      position, never a level, and a ScalarCmd Rotate that RotateCmd lists
//      as well is the same rotator: both are sent nothing (axis.inert).
//   5. The linear axis of such a motor holds where it is on a stop: Intiface
//      cannot stop an OSSM in position mode and its firmware will not turn a
//      move round, so each leg goes out in short segments and a stop is the
//      end of the segments (pumpHeld). Its Oscillate twin runs the machine's
//      own full-rail stroke, so it runs only while the travel envelope is
//      the whole travel (fullRail).
//   6. Script mode: a PRIMARY-role linear axis plays the wearer's funscript
//      through a script planner (script-planner.js) instead of its stroke
//      planner, when app.js has installed a script feed that is driving
//      (setIntifaceScriptFeed). The two planners share one interface and
//      one timer chain; the axis changes hands only while it moves, and
//      only between legs (syncPlanner). A script leg may be IDLE - the
//      script holds where the axis is - and an idle leg sends nothing at
//      all. Every stop is the planners' own: the rest move, or an OSSM's
//      hold (rule 5). Vibrators, rotators and secondary-role axes follow the
//      engine's channels as in every mode, the primary being the allowance.
//
// Message construction and parsing live in buttplug-protocol.js (pure,
// unit-tested). Roles, caps, linear invert and the rotation settings are
// persisted per device signature through storage.js and re-applied on
// DeviceList / DeviceAdded, so a reconnect keeps the user's mapping.

import { safeParse, safeSet } from '../storage.js';
import {
    buildRequestServerInfo,
    buildPing,
    buildRequestDeviceList,
    buildStartScanning,
    buildStopAllDevices,
    buildStopDeviceCmd,
    buildScalarCmd,
    buildLinearCmd,
    buildRotateCmd,
    buildSensorReadCmd,
    encodeFrame,
    decodeFrame,
    classifyMessage,
    parseServerInfo,
    pingIntervalMs,
    describeError,
    parseDevice,
    deviceSignature,
    defaultRoleFor,
    drivesAsLevel,
    oscillateTwins,
    rotateDuplicates,
    scalarLevel,
    linearStep,
    capSteps
} from './buttplug-protocol.js';
import { createStrokePlanner } from './stroke-planner.js';
import { createScriptPlanner, liveFeed } from './script-planner.js';
import { readVibeMode, readPulsePeriod, pulsePhase, pulseLevel, DEFAULT_VIBE_MODE, DEFAULT_PULSE_PERIOD_MS } from './vibe-pulse.js';

export const INTIFACE_STORAGE_KEY = 'edgeloop_intiface_devices';
export const DEFAULT_INTIFACE_URL = 'ws://localhost:12345';
export const ALTERNATE_SECONDS_MIN = 5;
export const ALTERNATE_SECONDS_MAX = 60;

// Mutable so tests can shorten the waits.
export const INTIFACE_TIMINGS = {
    handshakeMs: 5000,
    minDirectionChangeMs: 1000,
    failuresBeforeFlag: 3,
    testMoveMs: 450
};

// The Test button's level. The Oscillate mode of an OSSM-type machine
// (fullRail) runs the machine's own stroke over the whole rail, which
// Intiface sets to full depth and full stroke on entering that mode, so the
// press that only has to show which motor it is runs it slowly.
export const TEST_LEVEL = 0.6;
export const OSCILLATE_TEST_LEVEL = 0.2;

// The longest one segment of a held axis's leg lasts (pumpHeld): a stop
// leaves the machine at most this much movement, at five to ten commands a
// second.
export const HELD_SEGMENT_MS = 200;

export const INVALID_URL_TEXT = 'Invalid WebSocket URL: it must start with ws:// (or wss:// for a remote server with TLS), e.g. ws://localhost:12345.';
export const HANDSHAKE_TIMEOUT_TEXT = 'Handshake timed out. Make sure Intiface Central is running and its server is started; for localhost the URL must be ws://, not wss://.';
export const CONNECT_FAILED_TEXT = 'Connection failed. Make sure Intiface Central is running and its server is started; for localhost the URL must be ws://, not wss://.';

const WS_OPEN = 1;
const MAX_PENDING = 256;
const MAX_SAVED_DEVICES = 32;

// Kept exported for callers that still inspect the raw socket; prefer
// isIntifaceConnected().
export let intifaceSocket = null;
export let intifaceDevices = new Map();

let session = null;
let msgId = 1;
let scanning = false;
let status = { state: 'offline', text: 'Offline' };
let lastZone = { min: 0.2, max: 0.8 };
let lastEnvelope = { min: 0, max: 1 };
let lastSpeeds = { primary: 0, secondary: 0 };
// The script feed app.js installed (setIntifaceScriptFeed), and the
// unsubscribe for its change listener. Every script planner asks it through
// `scriptFeedNow`, so it can be installed after the planners exist.
let scriptFeed = null;
let unsubscribeScriptFeed = null;
const scriptFeedNow = liveFeed(() => scriptFeed);

const handlers = {
    onStatus: null,
    onDevicesChanged: null,
    onClose: null,
    onError: null
};

// app.js installs UI callbacks here:
//   onStatus({ state, text })   state: offline | connecting | handshake | connected | error
//   onDevicesChanged()          device list, battery, roles or failure flags changed
//   onClose({ wasConnected, assignedDevices, intentional, text })
//   onError(text)               a server Error message or a socket error
export function setIntifaceHandlers(next = {}) {
    Object.keys(handlers).forEach((k) => {
        if (next[k] !== undefined) handlers[k] = next[k];
    });
}

function call(name, ...args) {
    const fn = handlers[name];
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (e) {}
}

function nextId() {
    const id = msgId;
    msgId = msgId >= 0x7fffffff ? 1 : msgId + 1;
    return id;
}

export function isIntifaceConnected() {
    return Boolean(session && session.handshaken && session.socket && session.socket.readyState === WS_OPEN);
}

export function isIntifaceScanning() {
    return scanning;
}

export function getIntifaceStatus() {
    return { ...status };
}

export function getIntifaceServerName() {
    return session ? session.serverName : '';
}

// Devices with at least one axis that is not OFF.
export function countAssignedIntifaceDevices() {
    let n = 0;
    intifaceDevices.forEach((dev) => {
        if (dev.axes.some((a) => a.role !== 'off')) n += 1;
    });
    return n;
}

function setStatus(state, text) {
    status = { state, text };
    call('onStatus', { state, text });
}

function describeConnected(s) {
    const n = intifaceDevices.size;
    const name = s && s.serverName ? s.serverName : 'Intiface';
    let text = `Connected (${name}, ${n} device${n === 1 ? '' : 's'})`;
    if (s && s.lastError) text += ` - ${s.lastError}`;
    return text;
}

function refreshConnectedStatus() {
    if (session && session.handshaken) setStatus('connected', describeConnected(session));
}

function send(message) {
    if (!session || !session.socket || session.socket.readyState !== WS_OPEN) return false;
    try {
        session.socket.send(encodeFrame(message));
        return true;
    } catch (e) {
        return false;
    }
}

// Device commands remember which axis they were for, so an Error reply can
// be attributed and a run of failures flagged on that axis.
function sendDeviceCmd(dev, axis, message) {
    const id = message[Object.keys(message)[0]].Id;
    if (!send(message)) return false;
    if (session) {
        session.pending.set(id, { devIndex: dev.index, axisKey: axis ? axis.key : null });
        if (session.pending.size > MAX_PENDING) {
            const oldest = session.pending.keys().next().value;
            session.pending.delete(oldest);
        }
    }
    return true;
}

// ---- connection lifecycle ---------------------------------------------------

function clearSessionTimers(s) {
    if (!s) return;
    if (s.handshakeTimer) { clearTimeout(s.handshakeTimer); s.handshakeTimer = null; }
    if (s.pingTimer) { clearInterval(s.pingTimer); s.pingTimer = null; }
}

function detachSocket(socket) {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
}

function clearAxisTimers(dev) {
    dev.axes.forEach((axis) => {
        if (axis.timer) { clearTimeout(axis.timer); axis.timer = null; }
        if (axis.testTimer) { clearTimeout(axis.testTimer); axis.testTimer = null; }
        cancelSegments(axis);
        cutPulse(axis);
    });
}

function clearAllDevices() {
    intifaceDevices.forEach((dev) => clearAxisTimers(dev));
    intifaceDevices.clear();
}

// Tear down `s` (timers, devices, socket) and report. `reason`:
//   'user'     the user pressed Disconnect (or a new connect replaced it)
//   'timeout'  ServerInfo never arrived
//   'fatal'    the server sent a handshake / ping error
//   'remote'   the socket closed on its own
//   'failed'   the socket never opened
function finishSession(s, reason, text) {
    if (!s || s.finished) return;
    s.finished = true;
    clearSessionTimers(s);
    const wasConnected = Boolean(s.handshaken);
    const assignedDevices = countAssignedIntifaceDevices();
    if (reason === 'user' && s.socket && s.socket.readyState === WS_OPEN) {
        try { s.socket.send(encodeFrame(buildStopAllDevices(nextId()))); } catch (e) {}
    }
    detachSocket(s.socket);
    try { s.socket.close(); } catch (e) {}
    if (session === s) {
        session = null;
        intifaceSocket = null;
    }
    clearAllDevices();
    scanning = false;

    let finalText = text;
    let state = 'error';
    if (reason === 'user') { state = 'offline'; finalText = 'Offline'; }
    else if (reason === 'timeout') finalText = finalText || HANDSHAKE_TIMEOUT_TEXT;
    else if (reason === 'failed' || (reason === 'remote' && !wasConnected)) finalText = finalText || CONNECT_FAILED_TEXT;
    else finalText = finalText || 'Connection lost';
    setStatus(state, finalText);
    call('onDevicesChanged');
    call('onClose', { wasConnected, assignedDevices, intentional: reason === 'user', text: finalText });
}

// Browsers resolve a scheme-less WebSocket URL ("localhost:12345") against
// the page origin instead of throwing, which ends in a confusing HTTP 404.
// Only absolute ws:// or wss:// URLs are accepted.
export function isValidIntifaceUrl(url) {
    return typeof url === 'string' && /^wss?:\/\/\S+$/i.test(url.trim());
}

// Open a socket to Intiface Central. Any previous socket is closed first
// (detached, so its close cannot wipe the new connection's device list).
// Returns false when the URL is rejected synchronously.
export function connectIntifaceServer(url, newHandlers) {
    if (newHandlers) setIntifaceHandlers(newHandlers);
    const target = typeof url === 'string' && url.trim() ? url.trim() : DEFAULT_INTIFACE_URL;
    if (!isValidIntifaceUrl(target)) {
        setStatus('error', INVALID_URL_TEXT);
        return false;
    }

    if (session) finishSession(session, 'user');

    const WebSocketCtor = globalThis.WebSocket;
    if (typeof WebSocketCtor !== 'function') {
        setStatus('error', 'WebSocket is not available in this browser.');
        return false;
    }
    let socket;
    try {
        socket = new WebSocketCtor(target);
    } catch (e) {
        setStatus('error', `Invalid WebSocket URL: ${e && e.message ? e.message : target}`);
        return false;
    }

    const s = {
        socket,
        url: target,
        handshakeTimer: null,
        pingTimer: null,
        handshaken: false,
        finished: false,
        serverName: '',
        lastError: null,
        pending: new Map()
    };
    session = s;
    intifaceSocket = socket;
    setStatus('connecting', 'Connecting...');
    // The clock starts now, not at onopen: a socket that hangs in CONNECTING
    // (blackholed host) must not leave the modal on "Connecting..." forever.
    s.handshakeTimer = setTimeout(() => {
        if (s !== session || s.handshaken) return;
        finishSession(s, 'timeout');
    }, INTIFACE_TIMINGS.handshakeMs);

    socket.onopen = () => {
        if (s !== session) return;
        setStatus('handshake', 'Handshake...');
        send(buildRequestServerInfo(nextId()));
    };
    socket.onmessage = (event) => {
        if (s !== session) return;
        decodeFrame(event.data).forEach((msg) => handleMessage(s, msg));
    };
    socket.onerror = () => {
        if (s !== session) return;
        call('onError', s.handshaken ? 'WebSocket error' : CONNECT_FAILED_TEXT);
    };
    socket.onclose = () => {
        if (s !== session) return;
        finishSession(s, s.handshaken ? 'remote' : 'failed');
    };
    return true;
}

export function disconnectIntiface() {
    if (!session) return;
    finishSession(session, 'user');
}

// Best-effort StopAllDevices (page unload, or any caller that wants the
// server-side stop without touching the planners). A pulse train is cut
// with it: its next pulse would start the vibrator again after the stop, on
// a page that has gone away or been frozen with the session still running.
// A held axis (pumpHeld) stops here as well: StopAllDevices does nothing to
// an OSSM in position mode, and only the end of its segments stops it.
export function stopAllIntiface() {
    intifaceDevices.forEach((dev) => dev.axes.forEach((axis) => {
        cancelTest(axis);
        if (axis.holds) holdNow(axis);
        if (!axis.pulse) return;
        cutPulse(axis);
        axis.lastSent = null;
    }));
    if (!isIntifaceConnected()) return false;
    return send(buildStopAllDevices(nextId()));
}

export function rescanIntiface() {
    if (!isIntifaceConnected()) return;
    scanning = true;
    send(buildStartScanning(nextId()));
    call('onDevicesChanged');
}

// ---- incoming messages ------------------------------------------------------

function handleMessage(s, msg) {
    const { type, id, body } = classifyMessage(msg);
    switch (type) {
        case 'ServerInfo': {
            const info = parseServerInfo(body);
            s.handshaken = true;
            s.serverName = info ? info.serverName : 'Intiface';
            if (s.handshakeTimer) { clearTimeout(s.handshakeTimer); s.handshakeTimer = null; }
            const every = pingIntervalMs(info ? info.maxPingTime : 0);
            if (every > 0) {
                s.pingTimer = setInterval(() => { send(buildPing(nextId())); }, every);
            }
            setStatus('connected', describeConnected(s));
            send(buildRequestDeviceList(nextId()));
            scanning = true;
            send(buildStartScanning(nextId()));
            break;
        }
        case 'Ok':
            resolvePending(s, id, true);
            break;
        case 'Error':
            handleServerError(s, id, body);
            break;
        case 'DeviceList':
            (Array.isArray(body.Devices) ? body.Devices : []).forEach((dev) => addDiscoveredDevice(dev));
            refreshConnectedStatus();
            call('onDevicesChanged');
            break;
        case 'DeviceAdded':
            addDiscoveredDevice(body);
            refreshConnectedStatus();
            call('onDevicesChanged');
            break;
        case 'DeviceRemoved':
            removeDevice(body.DeviceIndex);
            refreshConnectedStatus();
            call('onDevicesChanged');
            break;
        case 'ScanningFinished':
            scanning = false;
            call('onDevicesChanged');
            break;
        case 'SensorReading': {
            if (body.SensorType !== 'Battery') break;
            const dev = intifaceDevices.get(body.DeviceIndex);
            if (dev && Array.isArray(body.Data) && body.Data.length > 0) {
                const level = Number(body.Data[0]);
                dev.battery = Number.isFinite(level) ? Math.max(0, Math.min(100, Math.round(level))) : null;
                call('onDevicesChanged');
            }
            break;
        }
        default:
            break;
    }
}

function findAxis(devIndex, axisKey) {
    const dev = intifaceDevices.get(devIndex);
    if (!dev) return { dev: null, axis: null };
    return { dev, axis: dev.axes.find((a) => a.key === axisKey) || null };
}

function resolvePending(s, id, ok) {
    const entry = s.pending.get(id);
    if (!entry) return false;
    s.pending.delete(id);
    const { axis } = findAxis(entry.devIndex, entry.axisKey);
    if (!axis) return true;
    if (ok) {
        if (axis.failures > 0 || axis.failing) {
            axis.failures = 0;
            axis.failing = false;
            call('onDevicesChanged');
        }
        if (s.lastError) {
            s.lastError = null;
            refreshConnectedStatus();
        }
        return true;
    }
    axis.failures += 1;
    if (axis.failures >= INTIFACE_TIMINGS.failuresBeforeFlag && !axis.failing) {
        axis.failing = true;
        call('onDevicesChanged');
    }
    return true;
}

function handleServerError(s, id, body) {
    const err = describeError(body);
    s.lastError = err.message;
    call('onError', err.message);
    // A handshake failure or a ping timeout means the server is dropping us
    // (and has stopped every device): close cleanly and say why.
    if (err.fatal) {
        finishSession(s, 'fatal', err.message);
        return;
    }
    if (!s.handshaken) {
        finishSession(s, 'fatal', err.message);
        return;
    }
    resolvePending(s, id, false);
    setStatus('connected', describeConnected(s));
}

// ---- devices ------------------------------------------------------------------

function loadSavedConfig() {
    return safeParse(INTIFACE_STORAGE_KEY, {});
}

function makeAxis(kind, attr, position, parsed, saved) {
    const key = `${kind}:${attr.index}`;
    const savedAxis = saved && saved.axes && saved.axes[key] && typeof saved.axes[key] === 'object' ? saved.axes[key] : null;
    // A scalar that takes a position (drivesAsLevel) is never driven: OFF
    // whatever was saved, and sendScalar sends it nothing.
    const inert = kind === 'scalar' && !drivesAsLevel(attr.actuatorType);
    const role = !inert && savedAxis && ['primary', 'secondary', 'off'].includes(savedAxis.role)
        ? savedAxis.role
        : defaultRoleFor(parsed, kind, position);
    const cap = savedAxis ? Number(savedAxis.maxCap) : NaN;
    const vibrates = kind === 'scalar' && attr.actuatorType === 'Vibrate';
    const axis = {
        key,
        kind,
        index: attr.index,
        type: attr.actuatorType,
        descriptor: attr.descriptor || '',
        stepCount: attr.stepCount || null,
        role: inert ? 'off' : role,
        // Never driven: 'position' (drivesAsLevel) or 'rotate'
        // (rotateDuplicates, set by addDiscoveredDevice); null when driven.
        inert,
        inertReason: inert ? 'position' : null,
        maxCap: Number.isFinite(cap) ? Math.max(0, Math.min(100, Math.round(cap))) : 100,
        invert: Boolean(savedAxis && savedAxis.invert),
        // Vibrate axes only: Constant (the engine's level as it is) or
        // Pulsed (vibe-pulse.js), and the pulse period.
        vibeMode: vibrates ? (readVibeMode(savedAxis && savedAxis.vibeMode) || DEFAULT_VIBE_MODE) : DEFAULT_VIBE_MODE,
        pulsePeriodMs: (vibrates && readPulsePeriod(savedAxis && savedAxis.pulsePeriodMs)) || DEFAULT_PULSE_PERIOD_MS,
        // The running pulse train of a Pulsed axis: { startedAt, timer }.
        pulse: null,
        // The other actuator of the same motor (oscillateTwins) and the
        // record the two share of which of them last put the motor in its
        // mode; null on every other axis.
        twin: null,
        pair: null,
        // A linear axis that holds where it is on a stop (pumpHeld), with
        // its segment timer and the last position it was sent, as a
        // position and as the device step it lands on (null: unknown).
        holds: false,
        segTimer: null,
        sentPos: null,
        sentStep: null,
        planner: kind === 'linear' ? createStrokePlanner() : null,
        // The axis's two planners: the stroke planner of every mode, and the
        // script planner of Script mode, made the first time it is needed.
        // `planner` is the one in use (syncPlanner).
        strokePlanner: null,
        scriptPlanner: null,
        // The physical positions the leg in flight was sent from and to (the
        // end of the leg before it, and its own), for a re-time (pumpLinear);
        // null while unknown.
        legFrom: null,
        legTarget: null,
        timer: null,
        testTimer: null,
        lastSent: null,
        failures: 0,
        failing: false
    };
    axis.strokePlanner = axis.planner;
    return axis;
}

function addDiscoveredDevice(raw) {
    const parsed = parseDevice(raw);
    if (!parsed) return null;
    const existing = intifaceDevices.get(parsed.deviceIndex);
    if (existing) clearAxisTimers(existing);

    const signature = deviceSignature(parsed);
    const savedAll = loadSavedConfig();
    const saved = savedAll && typeof savedAll[signature] === 'object' ? savedAll[signature] : null;

    const axes = [];
    parsed.scalars.forEach((a, pos) => axes.push(makeAxis('scalar', a, pos, parsed, saved)));
    parsed.linears.forEach((a, pos) => axes.push(makeAxis('linear', a, pos, parsed, saved)));
    parsed.rotations.forEach((a, pos) => axes.push(makeAxis('rotate', a, pos, parsed, saved)));
    if (axes.length === 0) {
        axes.push(makeAxis('scalar', { index: 0, actuatorType: 'Vibrate', descriptor: '', stepCount: null }, 0, parsed, saved));
    }
    // Two actuators of one motor: never both in use. A saved map (or a
    // backup) from before this build may have both on; the linear axis keeps
    // its role, the one that keeps the stroke inside the travel envelope.
    oscillateTwins(parsed).forEach(({ scalar, linear }) => {
        const osc = axes[scalar];
        const lin = axes[parsed.scalars.length + linear];
        if (!osc || !lin) return;
        const pair = { owner: null };
        osc.twin = lin; lin.twin = osc;
        osc.pair = pair; lin.pair = pair;
        if (osc.role !== 'off' && lin.role !== 'off') osc.role = 'off';
        lin.holds = true;
        lin.planner = createStrokePlanner({ hold: true });
        lin.strokePlanner = lin.planner;
    });
    // A rotator listed twice is driven through RotateCmd only.
    rotateDuplicates(parsed).forEach((pos) => {
        const axis = axes[pos];
        if (!axis) return;
        axis.inert = true;
        axis.inertReason = 'rotate';
        axis.role = 'off';
    });

    const altSaved = saved ? Number(saved.alternateSeconds) : 0;
    const dev = {
        index: parsed.deviceIndex,
        name: parsed.name,
        displayName: parsed.displayName,
        signature,
        axes,
        clockwise: true,
        reverseOnEdge: saved ? saved.reverseOnEdge !== false : true,
        alternateSeconds: clampAlternateSeconds(altSaved),
        lastDirectionChangeAt: Date.now(),
        hasBattery: parsed.batterySensorIndex !== null,
        batterySensorIndex: parsed.batterySensorIndex,
        battery: null,
        canStop: parsed.canStop
    };
    intifaceDevices.set(dev.index, dev);

    if (dev.hasBattery) {
        send(buildSensorReadCmd(nextId(), dev.index, dev.batterySensorIndex, 'Battery'));
    }
    return dev;
}

function removeDevice(devIndex) {
    const dev = intifaceDevices.get(devIndex);
    if (!dev) return;
    clearAxisTimers(dev);
    intifaceDevices.delete(devIndex);
}

function clampAlternateSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(ALTERNATE_SECONDS_MIN, Math.min(ALTERNATE_SECONDS_MAX, Math.round(n)));
}

// ---- persistence ----------------------------------------------------------------

// Persist every connected device's mapping under its signature. Returns
// true when the store accepted the write.
export function saveIntifaceConfig() {
    const all = loadSavedConfig();
    const now = Date.now();
    intifaceDevices.forEach((dev) => {
        const axes = {};
        dev.axes.forEach((axis) => {
            axes[axis.key] = { role: axis.role, maxCap: axis.maxCap, invert: Boolean(axis.invert) };
            if (axis.kind === 'scalar' && axis.type === 'Vibrate') {
                axes[axis.key].vibeMode = axis.vibeMode;
                axes[axis.key].pulsePeriodMs = axis.pulsePeriodMs;
            }
        });
        all[dev.signature] = {
            name: dev.name,
            axes,
            reverseOnEdge: dev.reverseOnEdge !== false,
            alternateSeconds: dev.alternateSeconds || 0,
            savedAt: now
        };
    });
    const keys = Object.keys(all);
    if (keys.length > MAX_SAVED_DEVICES) {
        keys.sort((a, b) => (Number(all[a].savedAt) || 0) - (Number(all[b].savedAt) || 0));
        keys.slice(0, keys.length - MAX_SAVED_DEVICES).forEach((k) => { delete all[k]; });
    }
    return safeSet(INTIFACE_STORAGE_KEY, all);
}

// ---- per-axis output ----------------------------------------------------------------

// The Max Power Cap as a fraction of full power: on a stepped actuator the
// step it allows (capSteps), which is what the modal shows.
function capFraction(axis) {
    const steps = capSteps(axis.maxCap ?? 100, axis.stepCount);
    return steps === null ? (axis.maxCap ?? 100) / 100 : steps / Math.round(axis.stepCount);
}

// The axis's level for an engine speed (percent): the speed under the
// axis's Max Power Cap, on the axis's step grid and never above the cap
// (scalarLevel).
function scalarFor(axis, speedPercent) {
    if (axis.role === 'off' || axis.inert) return 0;
    const cap = capFraction(axis);
    const speed = Math.max(0, Math.min(100, Number(speedPercent) || 0)) / 100;
    return scalarLevel(speed * cap, axis.stepCount, cap);
}

// The Oscillate mode of an OSSM-type machine (an Oscillate twin): Intiface
// sets the OSSM's depth and stroke to 100% on entering it
// (protocol_impl/ossm.rs), so it strokes the whole rail at full depth, and
// nothing EdgeLoop sends can keep it inside a travel envelope. It is driven
// only while the envelope is the whole travel.
function fullRail(axis) {
    return axis.kind === 'scalar' && axis.type === 'Oscillate' && Boolean(axis.twin);
}

function envelopeIsWhole(env) {
    return Boolean(env) && env.min <= 0 && env.max >= 1;
}

function speedForRole(role) {
    if (role === 'primary') return lastSpeeds.primary;
    if (role === 'secondary') return lastSpeeds.secondary;
    return 0;
}

// Twins (oscillateTwins) are two modes of one motor. The motor is in the
// mode of the twin that last sent it something it acts on: any LinearCmd,
// an Oscillate level above 0 - Buttplug drops an Oscillate 0 outside
// oscillate mode (protocol_impl/ossm.rs). Only that twin's stop or rest
// move reaches the motor in the mode it is in.
function noteDrove(axis, acting) {
    if (axis.pair && acting) axis.pair.owner = axis.kind;
}

// Whether an axis must be sent nothing at all. An inert scalar (a position,
// or a rotator RotateCmd drives) never is. Nor is an OFF twin whose twin
// holds the motor: a rest move, a zero or a Test to it is a command for the
// other mode, and Buttplug answers that by sending the OSSM to its menu,
// which its firmware runs as an emergency stop, and then into the other
// mode - the slam and the stop forum user X333 saw. The twin in use stops
// the motor: in oscillate mode StopAllDevices reaches it (Oscillate 0); in
// position mode nothing from Intiface does, and the held linear axis stops
// by sending no further segment (pumpHeld).
function silenced(axis) {
    if (axis.inert) return true;
    return Boolean(axis.pair) && axis.role === 'off' && axis.pair.owner !== axis.kind;
}

function sendScalar(dev, axis, value) {
    if (silenced(axis)) return false;
    if (axis.lastSent === value) return false;
    if (!sendDeviceCmd(dev, axis, buildScalarCmd(nextId(), dev.index, [{ index: axis.index, scalar: value, actuatorType: axis.type }]))) return false;
    axis.lastSent = value;
    noteDrove(axis, value > 0);
    return true;
}

// ---- pulsed vibration (vibe-pulse.js) -------------------------------------

function isPulsed(axis) {
    return axis.kind === 'scalar' && axis.type === 'Vibrate' && axis.vibeMode === 'pulsed';
}

// Stop a pulse train where it is. Synchronous: once this returns, no pulse
// of that train can go out - its timer is cleared, and the callback checks
// that its train is still the axis's own all the same.
function cutPulse(axis) {
    if (!axis.pulse) return;
    if (axis.pulse.timer) clearTimeout(axis.pulse.timer);
    axis.pulse = null;
}

// Arm the timer for the train's next change of phase.
function armPulse(dev, axis, now) {
    const train = axis.pulse;
    if (!train) return;
    const { changeAt } = pulsePhase(train.startedAt, now, axis.pulsePeriodMs);
    train.timer = setTimeout(() => {
        if (axis.pulse !== train) return;
        train.timer = null;
        if (!isIntifaceConnected() || intifaceDevices.get(dev.index) !== dev) { axis.pulse = null; return; }
        const t = Date.now();
        applyScalar(dev, axis, speedForRole(axis.role), t);
        if (axis.pulse === train) armPulse(dev, axis, t);
    }, Math.max(1, changeAt - now));
}

// A scalar axis takes the engine's speed: as it is (Constant), or as the
// peak of a pulse train (Pulsed), which starts on the first positive level
// - at the peak at once - and is cut by the first 0: a stop, a pause, the
// watchdog, OFF, a cap of 0.
function applyScalar(dev, axis, speed, now) {
    const level = fullRail(axis) && !envelopeIsWhole(lastEnvelope) ? 0 : scalarFor(axis, speed);
    if (!isPulsed(axis) || level <= 0) {
        cutPulse(axis);
        sendScalar(dev, axis, level);
        return;
    }
    let fresh = false;
    if (!axis.pulse) {
        axis.pulse = { startedAt: now, timer: null };
        fresh = true;
    }
    sendScalar(dev, axis, pulseLevel(level, pulsePhase(axis.pulse.startedAt, now, axis.pulsePeriodMs).on));
    if (fresh) armPulse(dev, axis, now);
}

function sendRotate(dev, axis, value) {
    const clockwise = dev.clockwise !== false;
    const key = `${value}|${clockwise}`;
    // A stopped rotator stays stopped whatever the direction flag does.
    if (axis.lastSent === key || (value === 0 && typeof axis.lastSent === 'string' && axis.lastSent.startsWith('0|'))) return false;
    if (!sendDeviceCmd(dev, axis, buildRotateCmd(nextId(), dev.index, [{ index: axis.index, speed: value, clockwise }]))) return false;
    axis.lastSent = key;
    return true;
}

// Invert mirrors a linear axis INSIDE the hardware envelope (min + max -
// position), not around 0.5: a 20-100 % envelope must never produce a
// physical 0-80 % move just because the sleeve is mounted upside down. The
// rest move mirrors the same way, so a stop stays inside the envelope too.
function physicalPosition(axis, position) {
    if (axis.kind !== 'linear' || !axis.invert) return position;
    return lastEnvelope.min + lastEnvelope.max - position;
}

// How far past a bound of the envelope a position may lie and still be on
// it. A mirrored position carries float noise: 0.2 + 0.8 - 0.8 is
// 0.19999999999999996, and the leg that carries it goes to the bottom of a
// 20-80 envelope. The finest step a device is sent, 1/1000 of its travel, is
// a million times this.
const ENVELOPE_BOUND_SLACK = 1e-9;

// Whether the leg in flight may be re-timed: it was sent somewhere, and that
// is still inside the travel envelope (pumpLinear says why).
function mayRetime(axis) {
    const to = axis.legTarget;
    return to !== null && to >= lastEnvelope.min - ENVELOPE_BOUND_SLACK && to <= lastEnvelope.max + ENVELOPE_BOUND_SLACK;
}

// How much of the travel the leg in flight covers on the device, for a
// re-time: from where the leg before it was sent to where it was sent. Before
// that is known, the whole of it, so what is left of a leg is never timed as
// shorter than it may be.
function travelCovered(axis) {
    return axis.legFrom === null ? 1 : Math.abs(axis.legTarget - axis.legFrom);
}

// Ask the planner for the next leg and, when it yields one, send it and
// arm a timer for its end. Never sends while a leg is in flight, except the
// leg in flight re-timed for an urgent decision (`retime`, stroke-planner.js).
//
// A re-timed leg goes to the physical position its leg was sent to
// (axis.legTarget), never to the planner's position mapped again. The
// planner's is a logical position, and what maps it onto the device - the
// mirror of an inverted axis through the travel envelope - can change while
// the leg is in flight. Mapped again after the wearer had raised the
// envelope's minimum from 0 to 20 during a leg to 80%, the re-timed leg of a
// cut sent an inverted stroker to 100%, past the wearer's maximum; after the
// invert switch was flipped during a downstroke, back up to the top. Nor is
// a leg re-timed whose end the wearer has since put outside the envelope:
// sent again, it would be a new command past the wearer's bounds. It runs
// out as it was sent, as a leg in flight always did when the envelope
// changed, and the next leg, inside the envelope, carries the new speed. And
// what is left of a leg is timed over what the leg covers on the device
// (travelCovered), which is more than the planner sized it for when the
// mapping changed just before it was planned.
function pumpLinear(dev, axis, now = Date.now(), { retime = false } = {}) {
    if (!axis.planner || !isIntifaceConnected() || intifaceDevices.get(dev.index) !== dev) return;
    if (silenced(axis)) {
        if (axis.timer) { clearTimeout(axis.timer); axis.timer = null; }
        cancelSegments(axis);
        return;
    }
    syncPlanner(axis, now);
    if (axis.holds) {
        pumpHeld(dev, axis, now);
        return;
    }
    const retimed = retime && mayRetime(axis) ? axis.planner.retime(now, { travel: travelCovered(axis) }) : null;
    const leg = retimed || axis.planner.next(now);
    if (!leg) return;
    if (leg.kind === 'idle') {
        armLegTimer(dev, axis, leg.durationMs);
        return;
    }
    if (!retimed) {
        axis.legFrom = axis.legTarget;
        axis.legTarget = physicalPosition(axis, leg.position);
    }
    sendLinear(dev, axis, axis.legTarget, leg.durationMs);
    armLegTimer(dev, axis, leg.durationMs);
}

// The timer at the end of a leg - a stroke, a rest move, a held axis's
// segments, or an idle leg of the script, which sent nothing - that asks for
// the next one.
function armLegTimer(dev, axis, durationMs) {
    if (axis.timer) clearTimeout(axis.timer);
    axis.timer = setTimeout(() => {
        axis.timer = null;
        pumpLinear(dev, axis, Math.max(Date.now(), axis.planner.legEndsAt()));
    }, durationMs);
}

// ---- Script mode (script-planner.js) ---------------------------------------

// Whether this axis plays the script: a primary-role linear axis while the
// installed feed says Script mode is driving. A feed that throws is not.
function wantsScript(axis) {
    if (axis.kind !== 'linear' || axis.role !== 'primary' || !scriptFeed) return false;
    try {
        return Boolean(scriptFeed.isActive());
    } catch (e) {
        return false;
    }
}

function scriptPlannerOf(axis) {
    if (!axis.scriptPlanner) {
        axis.scriptPlanner = createScriptPlanner({
            feed: scriptFeedNow,
            hold: axis.holds,
            // An OSSM's ceiling where it holds (position mode), Intiface's
            // linear ceiling otherwise (script-shaper.js DEVICE_CEILINGS).
            profile: axis.holds ? 'ossm' : 'intiface'
        });
    }
    return axis.scriptPlanner;
}

function plannerMoves(planner) {
    const input = planner.getInput();
    return input.enabled && input.effectiveSpeed > 0;
}

// Hand the axis to the planner it should be using now. Only a moving axis
// changes hands - a stop is the same in both planners, and the one in use
// gives it - and only between legs: the leg in flight runs out first (a
// stroke leg at most SLOW_LEG_MS, a script leg about SCRIPT_WINDOW_MS), so
// the new planner starts from where the axis really is. A held axis starts
// from the last segment it was sent.
function syncPlanner(axis, now) {
    if (axis.kind !== 'linear' || !axis.strokePlanner) return;
    const want = wantsScript(axis) ? scriptPlannerOf(axis) : axis.strokePlanner;
    const current = axis.planner;
    if (want === current) return;
    if (!plannerMoves(current) || current.isInFlight(now) || axis.testTimer) return;
    const at = axis.holds
        ? (axis.sentPos === null ? null : physicalPosition(axis, axis.sentPos))
        : current.lastPosition();
    want.reset();
    want.place(at);
    axis.planner = want;
}

// Install the script feed (player/script-feed.js), or null to remove it.
// Its changes - the clock starting or stopping, Script mode on or off, a new
// track - reach every axis at once: a clock that stopped (a seek, a pause)
// interrupts a script leg in flight like any stop.
export function setIntifaceScriptFeed(feed) {
    if (unsubscribeScriptFeed) {
        try { unsubscribeScriptFeed(); } catch (e) {}
        unsubscribeScriptFeed = null;
    }
    scriptFeed = feed && typeof feed === 'object' ? feed : null;
    if (scriptFeed && typeof scriptFeed.subscribe === 'function') {
        try { unsubscribeScriptFeed = scriptFeed.subscribe(onScriptFeedChange); } catch (e) {}
    }
    onScriptFeedChange();
}

// A change the feed announced reaches the axes playing the script at once:
// a clock that stopped cuts the leg in flight (the planner's stop goes out),
// one that started again sends the rejoin. Axes on their stroke planner are
// left to the next dispatch, which hands them over between legs; nothing
// that no dispatch has moved yet is sent anything from here.
function onScriptFeedChange() {
    if (!isIntifaceConnected()) return;
    const now = Date.now();
    intifaceDevices.forEach((dev) => dev.axes.forEach((axis) => {
        if (!axis.scriptPlanner || axis.planner !== axis.scriptPlanner) return;
        axis.scriptPlanner.poke();
        pumpLinear(dev, axis, now);
    }));
}

// Which planner an axis is using, for the modal's per-toy note and the
// tests: 'script', 'stroke', or null for an axis with none.
export function intifaceAxisPlanner(devIdx, axisIdx) {
    const dev = intifaceDevices.get(devIdx);
    const axis = dev && dev.axes[axisIdx];
    if (!axis || !axis.planner) return null;
    return axis.planner === axis.scriptPlanner ? 'script' : 'stroke';
}

// One LinearCmd, on the axis's step grid and inside the travel envelope
// (linearWirePosition). A held axis is never sent the step it was last
// sent: the OSSM firmware takes a move's direction as
// distance / abs(distance) (src/ossm/streaming/streaming.cpp), an integer
// 0 / 0 when the position repeats - on its ESP32 a divide-by-zero fault and
// a reboot, whose homing then drives the rail to both of its ends.
function sendLinear(dev, axis, position, durationMs) {
    const step = linearStep(position, axis.stepCount, lastEnvelope);
    if (axis.holds && step === axis.sentStep) return false;
    const sent = sendDeviceCmd(dev, axis, buildLinearCmd(nextId(), dev.index, [{ index: axis.index, position, durationMs, stepCount: axis.stepCount, bounds: lastEnvelope }]));
    if (sent) {
        axis.sentPos = position;
        axis.sentStep = step;
    }
    noteDrove(axis, sent);
    return sent;
}

// ---- held linear axes (an OSSM in Intiface's position mode) ---------------
//
// Intiface cannot stop an OSSM that is streaming positions: StopDeviceCmd
// and StopAllDevices become an Oscillate 0, which Buttplug drops outside
// oscillate mode (protocol_impl/ossm.rs). The firmware runs a move to its
// end and will not take one the other way before it has
// (streaming.cpp). So a leg in one long LinearCmd ran on for up to its
// whole length after a STOP, and the rest move that followed went to the
// bottom of the travel envelope - toward an end of the rail that depends on
// the OSSM's firmware version. Here a leg goes out as segments of about
// HELD_SEGMENT_MS, all in the leg's direction, which the firmware takes one
// after another without stopping; a stop sends nothing more, so the
// machine halts within one segment, where it is, and holds there. No rest
// move, on STOP, pause, the watchdog, page-away or OFF. Nor a re-time: it
// would send the leg's end again. The first leg from a position nobody
// knows (after connecting, or after Oscillate) has no start to cut into
// segments and goes as one move, sized for the farthest end of the travel.

function cancelSegments(axis) {
    if (axis.segTimer) { clearTimeout(axis.segTimer); axis.segTimer = null; }
}

// A Test still under way ends at a stop: its second move must not follow
// it - a Test on an OSSM and a STOP half a second later sent the Test's
// "stream:20:450" after the stop. A linear axis is left where the Test's
// first move put it, as its second move would have recorded; a scalar or
// rotator gets its 0 from the stop itself.
function cancelTest(axis) {
    if (!axis.testTimer) return;
    clearTimeout(axis.testTimer);
    axis.testTimer = null;
    if (axis.kind !== 'linear') return;
    axis.planner.reset();
    if (axis.holds) axis.planner.place(axis.sentPos === null ? null : physicalPosition(axis, axis.sentPos));
}

// Stop a held axis where it is: nothing more goes out, and the planner is
// told the position the last segment sent will leave it at.
function holdAxis(axis) {
    cancelSegments(axis);
    if (axis.timer) { clearTimeout(axis.timer); axis.timer = null; }
    cancelTest(axis);
    axis.planner.place(axis.sentPos === null ? null : physicalPosition(axis, axis.sentPos));
}

// The same from outside a dispatch (page-away): the planner stops as well.
function holdNow(axis) {
    cancelTest(axis);
    axis.planner.setInput({ enabled: false });
    axis.planner.next(Date.now());
    holdAxis(axis);
}

function pumpHeld(dev, axis, now) {
    const leg = axis.planner.next(now);
    if (!leg) return;
    if (leg.kind === 'hold') {
        holdAxis(axis);
        return;
    }
    if (leg.kind === 'idle') {
        armLegTimer(dev, axis, leg.durationMs);
        return;
    }
    const to = physicalPosition(axis, leg.position);
    axis.legFrom = axis.sentPos;
    axis.legTarget = to;
    streamLeg(dev, axis, axis.sentPos, to, leg.durationMs);
    armLegTimer(dev, axis, leg.durationMs);
}

// One leg as segments from `from` to `to` over `durationMs`; a segment that
// lands on the step the one before it did is folded into the next one.
function streamLeg(dev, axis, from, to, durationMs) {
    cancelSegments(axis);
    const n = from === null ? 1 : Math.max(1, Math.ceil(durationMs / HELD_SEGMENT_MS));
    const each = durationMs / n;
    const segments = [];
    let prev = axis.sentStep;
    let carry = 0;
    for (let i = 1; i <= n; i++) {
        const pos = from === null ? to : from + (to - from) * (i / n);
        const step = linearStep(pos, axis.stepCount, lastEnvelope);
        if (step === prev) { carry += each; continue; }
        segments.push({ pos, ms: Math.round(each + carry), at: (i - 1) * each - carry });
        prev = step;
        carry = 0;
    }
    const start = Date.now();
    const next = () => {
        axis.segTimer = null;
        if (!isIntifaceConnected() || intifaceDevices.get(dev.index) !== dev) return;
        const seg = segments.shift();
        if (!seg) return;
        sendLinear(dev, axis, seg.pos, seg.ms);
        if (segments.length) axis.segTimer = setTimeout(next, Math.max(1, start + segments[0].at - Date.now()));
    };
    next();
}

function flipDirection(dev, now) {
    if (now - (dev.lastDirectionChangeAt || 0) < INTIFACE_TIMINGS.minDirectionChangeMs) return false;
    dev.clockwise = !(dev.clockwise !== false);
    dev.lastDirectionChangeAt = now;
    return true;
}

// Reverse every rotator that opted in (reason 'edge' honours the per-device
// "reverse on edge" switch). Rate-limited to one change per second.
//
// `apply: false` only turns the direction; the caller's own dispatch, which
// follows at once, sends it. The engine reverses on the edge it has just
// counted, in the same pass that decides the edge's speed, and re-sending
// the last speeds reversed put the speed from before the edge on the wire
// first: at Full Stop a rotator was sent 45% the other way and then 0,
// within two milliseconds.
export function reverseIntifaceRotation(reason = 'edge', now = Date.now(), { apply = true } = {}) {
    let flipped = 0;
    intifaceDevices.forEach((dev) => {
        if (!dev.axes.some((a) => a.kind === 'rotate')) return;
        if (reason === 'edge' && dev.reverseOnEdge === false) return;
        if (flipDirection(dev, now)) flipped += 1;
    });
    if (flipped > 0 && apply) applyLastSpeeds();
    return flipped;
}

function maybeAlternate(dev, now, active) {
    if (!active || !dev.alternateSeconds) return;
    if (now - (dev.lastDirectionChangeAt || 0) >= dev.alternateSeconds * 1000) flipDirection(dev, now);
}

function applyAxis(dev, axis, primary, secondary, zone, now, urgent = false) {
    const speed = axis.role === 'primary' ? primary : (axis.role === 'secondary' ? secondary : 0);
    if (axis.kind === 'linear') {
        const enabled = axis.role !== 'off';
        axis.strokePlanner.setInput({ speed, cap: axis.maxCap, zoneMin: zone.min, zoneMax: zone.max, enabled });
        // The script is mapped into the whole travel envelope (the engine's
        // zone in Script mode), and a stop rests at its bottom.
        if (axis.scriptPlanner || wantsScript(axis)) {
            scriptPlannerOf(axis).setInput({ speed, cap: axis.maxCap, zoneMin: lastEnvelope.min, zoneMax: lastEnvelope.max, enabled });
        }
        pumpLinear(dev, axis, now, { retime: urgent });
    } else if (axis.kind === 'rotate') {
        const value = scalarFor(axis, speed);
        maybeAlternate(dev, now, value > 0);
        sendRotate(dev, axis, value);
    } else {
        applyScalar(dev, axis, speed, now);
    }
}

function applyLastSpeeds(now = Date.now(), { urgent = false } = {}) {
    if (!isIntifaceConnected()) return;
    intifaceDevices.forEach((dev) => {
        dev.axes.forEach((axis) => applyAxis(dev, axis, lastSpeeds.primary, lastSpeeds.secondary, lastZone, now, urgent));
    });
}

function zoneFromPercent(strokeMin, strokeMax, envMin, envMax) {
    const pct = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
    };
    const eMin = pct(envMin, 0) / 100;
    const eMax = Math.max(eMin, pct(envMax, 100) / 100);
    const min = Math.max(eMin, Math.min(eMax, pct(strokeMin, 0) / 100));
    const max = Math.max(min, Math.min(eMax, pct(strokeMax, 100) / 100));
    return { zone: { min, max }, envelope: { min: eMin, max: eMax } };
}

// Main dispatch entry point, called on every engine tick and on every
// stop / pause (force = true). strokeMin/strokeMax are physical percents
// already mapped into the hardware envelope by engine.js; the envelope is
// used only to clamp (and to mirror inverted axes) so no position can ever
// leave the user's bounds. `urgent` (tick-dispatch.js): this dispatch
// carries a guard's decision, a cut or the landing Force Orgasm's time limit
// starts, and a linear axis takes its new speed on the leg in flight instead
// of the next one.
export function dispatchIntiface(primarySpeed, secondarySpeed, strokeMin = 0, strokeMax = 100, envMin = 0, envMax = 100, force = false, { urgent = false } = {}) {
    const mapped = zoneFromPercent(strokeMin, strokeMax, envMin, envMax);
    lastZone = mapped.zone;
    lastEnvelope = mapped.envelope;
    lastSpeeds = {
        primary: Math.max(0, Math.min(100, Number(primarySpeed) || 0)),
        secondary: Math.max(0, Math.min(100, Number(secondarySpeed) || 0))
    };
    if (!isIntifaceConnected() || intifaceDevices.size === 0) return;
    if (force && lastSpeeds.primary === 0 && lastSpeeds.secondary === 0) {
        // STOP / pause: the server-side stop first, then the per-axis rest
        // moves and zeros (a stop interrupts a linear axis's leg in flight,
        // so its rest move goes out now: stroke-planner.js). A Test still
        // under way ends with it. (Not on every dispatch of zeros: an idle
        // page dispatches them on each heart-rate reading.)
        intifaceDevices.forEach((dev) => dev.axes.forEach(cancelTest));
        send(buildStopAllDevices(nextId()));
    }
    applyLastSpeeds(Date.now(), { urgent });
}

// ---- user settings ----------------------------------------------------------------

// An axis set OFF stops: a linear axis with one rest move to the bottom of
// the zone it was last given, inside the travel envelope - a held one
// (pumpHeld) where it is, with no move at all; a scalar (its pulse train
// cut) or a rotator with a 0. A linear axis nothing has moved yet is sent
// nothing: its planner had never been given a zone, and its rest move went
// to 0 whatever the travel envelope - setting an OSSM's Position axis OFF
// before a session sent it to the end of its rail.
function restAxisNow(dev, axis) {
    cancelTest(axis);
    if (axis.kind === 'linear') {
        axis.planner.setInput({ enabled: false, zoneMin: lastZone.min, zoneMax: lastZone.max });
        if (axis.legTarget === null) return;
        pumpLinear(dev, axis);
    } else if (axis.kind === 'rotate') {
        sendRotate(dev, axis, 0);
    } else {
        cutPulse(axis);
        sendScalar(dev, axis, 0);
    }
}

// The twin of an axis the wearer has just put in use goes OFF and quiet:
// timers, pulse and leg forgotten, and nothing sent (silenced()). The
// twin taking over moves the motor into its own mode with its first
// command; where the carriage is after that, nothing here knows.
function yieldTwin(axis) {
    axis.role = 'off';
    if (axis.timer) { clearTimeout(axis.timer); axis.timer = null; }
    if (axis.testTimer) { clearTimeout(axis.testTimer); axis.testTimer = null; }
    cancelSegments(axis);
    cutPulse(axis);
    if (axis.planner) {
        for (const planner of [axis.strokePlanner, axis.scriptPlanner]) {
            if (!planner) continue;
            planner.reset();
            planner.setInput({ enabled: false });
        }
        axis.planner = axis.strokePlanner;
        axis.legFrom = null;
        axis.legTarget = null;
        axis.sentPos = null;
        axis.sentStep = null;
    }
    axis.lastSent = null;
}

// `envelope`: the travel envelope in percent, { min, max }, as the page has
// it now. The Oscillate mode of an OSSM-type machine cannot keep to it
// (fullRail): it is refused while the envelope is narrower than 0-100%.
export function setAxisRole(devIdx, axisIdx, role, { envelope = null } = {}) {
    const dev = intifaceDevices.get(devIdx);
    const axis = dev && dev.axes[axisIdx];
    if (!axis || !['primary', 'secondary', 'off'].includes(role)) return false;
    // An inert scalar is never driven (drivesAsLevel, rotateDuplicates).
    if (axis.inert && role !== 'off') return false;
    useEnvelope(envelope);
    if (role !== 'off' && fullRail(axis) && !envelopeIsWhole(lastEnvelope)) return false;
    axis.role = role;
    // One motor, one mode: putting one twin in use takes the other out.
    if (role !== 'off' && axis.twin && axis.twin.role !== 'off') yieldTwin(axis.twin);
    saveIntifaceConfig();
    if (!isIntifaceConnected()) return true;
    if (role === 'off') {
        if (dev.axes.every((a) => a.role === 'off')) send(buildStopDeviceCmd(nextId(), dev.index));
        restAxisNow(dev, axis);
    } else {
        applyAxis(dev, axis, lastSpeeds.primary, lastSpeeds.secondary, lastZone, Date.now());
    }
    return true;
}

// A stepped actuator's cap is one of its steps (capChoices), stored to
// 1/10000 % so that capSteps() reads the same step back.
export function setAxisMaxCap(devIdx, axisIdx, maxCap) {
    const dev = intifaceDevices.get(devIdx);
    const axis = dev && dev.axes[axisIdx];
    if (!axis) return false;
    const n = Number(maxCap);
    axis.maxCap = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 10000) / 10000)) : 100;
    saveIntifaceConfig();
    if (isIntifaceConnected() && axis.role !== 'off') {
        applyAxis(dev, axis, lastSpeeds.primary, lastSpeeds.secondary, lastZone, Date.now());
    }
    return true;
}

export function setAxisInvert(devIdx, axisIdx, invert) {
    const dev = intifaceDevices.get(devIdx);
    const axis = dev && dev.axes[axisIdx];
    if (!axis || axis.kind !== 'linear') return false;
    axis.invert = Boolean(invert);
    saveIntifaceConfig();
    return true;
}

// Rotation settings per device: reverseOnEdge (boolean) and alternateSeconds
// (0 = off, else 5-60).
export function setDeviceRotation(devIdx, { reverseOnEdge, alternateSeconds } = {}) {
    const dev = intifaceDevices.get(devIdx);
    if (!dev) return false;
    if (reverseOnEdge !== undefined) dev.reverseOnEdge = Boolean(reverseOnEdge);
    if (alternateSeconds !== undefined) {
        dev.alternateSeconds = clampAlternateSeconds(alternateSeconds);
        dev.lastDirectionChangeAt = Date.now();
    }
    saveIntifaceConfig();
    return true;
}

// Take the travel envelope (percent) as the page has it now, for what can
// move a linear axis before a session's first dispatch hands it over: until
// then the driver knew only 0-100, and a Test press stroked 20-80% whatever
// the wearer's bounds.
function useEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') return;
    const mapped = zoneFromPercent(lastZone.min * 100, lastZone.max * 100, envelope.min, envelope.max);
    lastEnvelope = mapped.envelope;
    lastZone = mapped.zone;
}

// Short manual test of one axis so the user can see which motor it is.
// Skipped while the engine drives the axis (a session is running would
// fight the planner), for a scalar that takes a position, and for the twin
// of a motor whose other mode is in use (silenced() says why). `envelope`:
// the travel envelope in percent, { min, max }.
export function testSingleAxis(devIdx, axisIdx, envelope = null) {
    const dev = intifaceDevices.get(devIdx);
    const axis = dev && dev.axes[axisIdx];
    if (!axis || !isIntifaceConnected() || axis.inert) return false;
    if (axis.twin && axis.twin.role !== 'off') return false;
    useEnvelope(envelope);
    if (fullRail(axis) && !envelopeIsWhole(lastEnvelope)) return false;
    const cap = capFraction(axis);
    const level = scalarLevel((fullRail(axis) ? OSCILLATE_TEST_LEVEL : TEST_LEVEL) * cap, axis.stepCount, cap);
    const holdMs = 1000;

    if (axis.kind === 'linear') {
        if (axis.planner.isInFlight(Date.now()) || axis.testTimer) return false;
        const up = physicalPosition(axis, lastZone.max);
        const down = physicalPosition(axis, lastZone.min);
        const moveMs = INTIFACE_TIMINGS.testMoveMs;
        // A held axis's planner is put at rest first, so the zeros an idle
        // page dispatches on every heart-rate reading do not count as the
        // stop that ends this Test (holdAxis).
        if (axis.holds) {
            axis.planner.setInput({ enabled: false });
            axis.planner.next(Date.now());
        }
        sendLinear(dev, axis, up, moveMs);
        // Where the next leg starts from (travelCovered).
        axis.legTarget = up;
        axis.testTimer = setTimeout(() => {
            axis.testTimer = null;
            if (!isIntifaceConnected() || intifaceDevices.get(dev.index) !== dev) return;
            sendLinear(dev, axis, down, moveMs);
            axis.legTarget = down;
            axis.planner.reset();
            // A held axis stays where the Test left it, and starts from there.
            if (axis.holds) axis.planner.place(axis.sentPos === null ? null : physicalPosition(axis, axis.sentPos));
        }, moveMs + 50);
        return true;
    }

    if (axis.kind === 'rotate') {
        sendDeviceCmd(dev, axis, buildRotateCmd(nextId(), dev.index, [{ index: axis.index, speed: level, clockwise: dev.clockwise !== false }]));
        axis.lastSent = null;
        if (axis.testTimer) clearTimeout(axis.testTimer);
        axis.testTimer = setTimeout(() => {
            axis.testTimer = null;
            sendRotate(dev, axis, 0);
        }, holdMs);
        return true;
    }

    if (sendDeviceCmd(dev, axis, buildScalarCmd(nextId(), dev.index, [{ index: axis.index, scalar: level, actuatorType: axis.type }]))) noteDrove(axis, level > 0);
    axis.lastSent = null;
    if (axis.testTimer) clearTimeout(axis.testTimer);
    axis.testTimer = setTimeout(() => {
        axis.testTimer = null;
        sendScalar(dev, axis, 0);
    }, holdMs);
    return true;
}

// Vibrate axes: Constant or Pulsed, and the pulse period (vibe-pulse.js).
// Either change starts a fresh train, at its peak, at once.
export function setAxisVibeMode(devIdx, axisIdx, { mode, periodMs } = {}) {
    const dev = intifaceDevices.get(devIdx);
    const axis = dev && dev.axes[axisIdx];
    if (!axis || axis.kind !== 'scalar' || axis.type !== 'Vibrate') return false;
    const nextMode = mode === undefined ? axis.vibeMode : readVibeMode(mode);
    const nextPeriod = periodMs === undefined ? axis.pulsePeriodMs : readPulsePeriod(periodMs);
    if (!nextMode || !nextPeriod) return false;
    axis.vibeMode = nextMode;
    axis.pulsePeriodMs = nextPeriod;
    saveIntifaceConfig();
    cutPulse(axis);
    if (isIntifaceConnected() && axis.role !== 'off') {
        applyAxis(dev, axis, lastSpeeds.primary, lastSpeeds.secondary, lastZone, Date.now());
    }
    return true;
}

// Test hook: forget everything (sockets, devices, counters).
export function resetIntifaceForTests() {
    if (session) {
        const s = session;
        s.finished = true;
        clearSessionTimers(s);
        detachSocket(s.socket);
        try { s.socket.close(); } catch (e) {}
        session = null;
        intifaceSocket = null;
    }
    clearAllDevices();
    scanning = false;
    msgId = 1;
    status = { state: 'offline', text: 'Offline' };
    lastZone = { min: 0.2, max: 0.8 };
    lastEnvelope = { min: 0, max: 1 };
    lastSpeeds = { primary: 0, secondary: 0 };
    if (unsubscribeScriptFeed) {
        try { unsubscribeScriptFeed(); } catch (e) {}
        unsubscribeScriptFeed = null;
    }
    scriptFeed = null;
    Object.keys(handlers).forEach((k) => { handlers[k] = null; });
}
