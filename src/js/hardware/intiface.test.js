// Driver tests with a mocked global WebSocket and an in-memory localStorage.
// No network, no DOM.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    connectIntifaceServer,
    disconnectIntiface,
    dispatchIntiface,
    setAxisRole,
    setAxisMaxCap,
    setAxisInvert,
    setAxisVibeMode,
    setDeviceRotation,
    reverseIntifaceRotation,
    testSingleAxis,
    saveIntifaceConfig,
    stopAllIntiface,
    isIntifaceConnected,
    isIntifaceScanning,
    isValidIntifaceUrl,
    getIntifaceStatus,
    countAssignedIntifaceDevices,
    resetIntifaceForTests,
    intifaceDevices,
    INTIFACE_TIMINGS,
    INTIFACE_STORAGE_KEY,
    HANDSHAKE_TIMEOUT_TEXT
} from './intiface.js';
import { REST_MOVE_MS, legDurationMs } from './stroke-planner.js';
import { OSCILLATE_TEST_LEVEL, TEST_LEVEL, HELD_SEGMENT_MS } from './intiface.js';
import { capStepPercent } from './buttplug-protocol.js';
import { setIntifaceScriptFeed, intifaceAxisPlanner } from './intiface.js';
import { createScriptFeed } from '../player/script-feed.js';
import { createMediaClock } from '../player/media-clock.js';

const sockets = [];

// The driver sends the middle of a step (buttplug-protocol.js); what a
// test reads in `sent` is the step the server lands on, as a fraction -
// ceil for a level, trunc for a position, with the StepCount the device was
// announced with. `raw` keeps the wire values.
function landed(steps, kind, value) {
    const n = Number(steps);
    if (!(n > 0)) return value;
    if (kind === 'linear') return Math.trunc(n * value) / n;
    return value < 0.000001 ? 0 : Math.ceil(n * value) / n;
}

class FakeSocket {
    constructor(url) {
        if (!/^wss?:\/\//.test(url)) throw new SyntaxError(`Failed to construct 'WebSocket': The URL '${url}' is invalid.`);
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.raw = [];
        this.at = [];
        this.steps = new Map();
        this.closed = false;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        sockets.push(this);
    }
    send(data) {
        if (this.readyState !== 1) throw new Error('not open');
        this.raw.push(JSON.parse(data));
        this.at.push(Date.now());
        this.sent.push(JSON.parse(data).map((m) => {
            const steps = (list, i) => ((this.steps.get(Object.values(m)[0].DeviceIndex) || {})[list] || [])[i];
            if (m.ScalarCmd) m.ScalarCmd.Scalars.forEach((x) => { x.Scalar = landed(steps('ScalarCmd', x.Index), 'scalar', x.Scalar); });
            if (m.RotateCmd) m.RotateCmd.Rotations.forEach((x) => { x.Speed = landed(steps('RotateCmd', x.Index), 'scalar', x.Speed); });
            if (m.LinearCmd) m.LinearCmd.Vectors.forEach((x) => { x.Position = landed(steps('LinearCmd', x.Index), 'linear', x.Position); });
            return m;
        }));
    }
    close() {
        this.closed = true;
        this.readyState = 3;
    }
    // test helpers
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    receive(msgs) {
        for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
            const devices = m.DeviceList ? m.DeviceList.Devices : (m.DeviceAdded ? [m.DeviceAdded] : []);
            for (const d of devices) {
                const lists = {};
                for (const list of ['ScalarCmd', 'LinearCmd', 'RotateCmd']) {
                    const attrs = d.DeviceMessages && d.DeviceMessages[list];
                    if (Array.isArray(attrs)) lists[list] = attrs.map((a) => a.StepCount);
                }
                this.steps.set(d.DeviceIndex, lists);
            }
        }
        if (this.onmessage) this.onmessage({ data: JSON.stringify(Array.isArray(msgs) ? msgs : [msgs]) });
    }
    dropped() { this.readyState = 3; if (this.onclose) this.onclose({}); }
    messages(type) { return this.sent.flat().filter((m) => m[type]).map((m) => m[type]); }
}

const memory = new Map();
const fakeStorage = {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => { memory.set(k, String(v)); },
    removeItem: (k) => { memory.delete(k); }
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const OSR2 = {
    DeviceIndex: 1,
    DeviceName: 'TCode v0.3 (Single Linear Axis)',
    DeviceMessages: { LinearCmd: [{ StepCount: 1000, FeatureDescriptor: 'L0', ActuatorType: 'Position' }], StopDeviceCmd: {} }
};
const EDGE = {
    DeviceIndex: 0,
    DeviceName: 'Lovense Edge',
    DeviceMessages: {
        ScalarCmd: [{ StepCount: 20, ActuatorType: 'Vibrate' }, { StepCount: 20, ActuatorType: 'Vibrate' }],
        SensorReadCmd: [{ SensorType: 'RSSI' }, { SensorType: 'Battery' }],
        StopDeviceCmd: {}
    }
};
const VORZE = {
    DeviceIndex: 2,
    DeviceName: 'Vorze A10 Cyclone',
    DeviceMessages: { RotateCmd: [{ StepCount: 100, ActuatorType: 'Rotate' }], StopDeviceCmd: {} }
};
const SR6 = {
    DeviceIndex: 3,
    DeviceName: 'TCode v0.3 (SR6)',
    DeviceMessages: {
        LinearCmd: [
            { StepCount: 1000, FeatureDescriptor: 'L0', ActuatorType: 'Position' },
            { StepCount: 1000, FeatureDescriptor: 'L1', ActuatorType: 'Position' }
        ],
        StopDeviceCmd: {}
    }
};

// What current Intiface Central lists for an OSSM over Bluetooth
// (buttplugio/buttplug protocols/ossm.yml through the v3 view,
// message/v3/server_device_message_attributes.rs): ONE motor, two entries.
const OSSM = {
    DeviceIndex: 4,
    DeviceName: 'Kinky Makers OSSM',
    DeviceMessageTimingGap: 0,
    DeviceMessages: {
        ScalarCmd: [{ FeatureDescriptor: '', StepCount: 100, ActuatorType: 'Oscillate' }],
        LinearCmd: [{ FeatureDescriptor: '', StepCount: 100, ActuatorType: 'Position' }],
        StopDeviceCmd: {}
    }
};
// And a T-Code stroker (OSR2, or an OSSM on T-Code firmware) through
// current Intiface: protocols/tcode-v03.yml, position + hw_position_with_duration.
const TCODE_V03 = {
    DeviceIndex: 5,
    DeviceName: 'TCode v0.3 (Single Linear Axis)',
    DeviceMessages: {
        ScalarCmd: [{ FeatureDescriptor: '', StepCount: 999, ActuatorType: 'Position' }],
        LinearCmd: [{ FeatureDescriptor: '', StepCount: 999, ActuatorType: 'Position' }],
        StopDeviceCmd: {}
    }
};

let events;
function handlersRecorder() {
    events = { status: [], closes: [], errors: [], changes: 0 };
    return {
        onStatus: (s) => events.status.push(s),
        onClose: (c) => events.closes.push(c),
        onError: (e) => events.errors.push(e),
        onDevicesChanged: () => { events.changes += 1; }
    };
}

function handshake(ws, { maxPing = 0, devices = [] } = {}) {
    ws.open();
    ws.receive({ ServerInfo: { Id: 1, ServerName: 'Intiface Central', MessageVersion: 3, MaxPingTime: maxPing } });
    ws.receive({ DeviceList: { Id: 2, Devices: devices } });
}

function connectWith(devices, opts = {}) {
    connectIntifaceServer('ws://localhost:12345', handlersRecorder());
    const ws = sockets[sockets.length - 1];
    handshake(ws, { ...opts, devices });
    return ws;
}

beforeEach(() => {
    sockets.length = 0;
    memory.clear();
    globalThis.WebSocket = FakeSocket;
    globalThis.localStorage = fakeStorage;
    INTIFACE_TIMINGS.handshakeMs = 60;
    INTIFACE_TIMINGS.minDirectionChangeMs = 1000;
    resetIntifaceForTests();
});

afterEach(() => {
    resetIntifaceForTests();
    delete globalThis.localStorage;
});

describe('connection lifecycle', () => {
    it('walks Offline -> Connecting -> Handshake -> Connected and enumerates', () => {
        const ws = connectWith([EDGE]);
        assert.deepEqual(events.status.map((s) => s.state), ['connecting', 'handshake', 'connected', 'connected']);
        assert.equal(getIntifaceStatus().text, 'Connected (Intiface Central, 1 device)');
        assert.equal(isIntifaceConnected(), true);
        assert.equal(isIntifaceScanning(), true);
        const rsi = ws.messages('RequestServerInfo');
        assert.equal(rsi.length, 1);
        assert.equal(rsi[0].MessageVersion, 3);
        assert.ok(rsi[0].Id >= 1);
        assert.equal(ws.messages('RequestDeviceList').length, 1);
        assert.equal(ws.messages('StartScanning').length, 1);
        // Battery read uses the real sensor index (1), not 0.
        const battery = ws.messages('SensorReadCmd');
        assert.equal(battery.length, 1);
        assert.equal(battery[0].SensorIndex, 1);
        ws.receive({ ScanningFinished: { Id: 0 } });
        assert.equal(isIntifaceScanning(), false);
        ws.receive({ SensorReading: { Id: battery[0].Id, DeviceIndex: 0, SensorIndex: 1, SensorType: 'Battery', Data: [77] } });
        assert.equal(intifaceDevices.get(0).battery, 77);
    });

    it('rejects an invalid URL synchronously without throwing', () => {
        const ok = connectIntifaceServer('localhost:12345', handlersRecorder());
        assert.equal(ok, false);
        assert.equal(getIntifaceStatus().state, 'error');
        assert.match(getIntifaceStatus().text, /Invalid WebSocket URL/);
        assert.equal(sockets.length, 0);
    });

    it('rejects scheme-less and http URLs before touching the socket (browsers resolve them relatively)', () => {
        // A permissive socket, like a real browser: no throw on odd URLs.
        const Permissive = class extends FakeSocket { constructor(url) { super('ws://x'); this.url = url; } };
        globalThis.WebSocket = Permissive;
        for (const bad of ['127.0.0.1:12345', 'not a websocket url', 'http://localhost:12345', 'ws://', '']) {
            const ok = connectIntifaceServer(bad, handlersRecorder());
            if (bad === '') {
                assert.equal(ok, true, 'empty falls back to the default URL');
                disconnectIntiface();
                continue;
            }
            assert.equal(ok, false, bad);
            assert.match(getIntifaceStatus().text, /Invalid WebSocket URL/, bad);
        }
        assert.equal(sockets.length, 1);
        assert.equal(isValidIntifaceUrl('WSS://intiface.example.org:12345/'), true);
    });

    it('times out the handshake and closes the socket', async () => {
        connectIntifaceServer('ws://localhost:12345', handlersRecorder());
        const ws = sockets[0];
        ws.open();
        await sleep(INTIFACE_TIMINGS.handshakeMs + 30);
        assert.equal(ws.closed, true);
        assert.equal(getIntifaceStatus().state, 'error');
        assert.equal(getIntifaceStatus().text, HANDSHAKE_TIMEOUT_TEXT);
        assert.equal(events.closes.length, 1);
        assert.equal(events.closes[0].wasConnected, false);
        assert.equal(events.closes[0].assignedDevices, 0);
    });

    it('a refused connection reports an error without a session pause flag', () => {
        connectIntifaceServer('ws://localhost:12345', handlersRecorder());
        const ws = sockets[0];
        if (ws.onerror) ws.onerror({});
        ws.dropped();
        assert.equal(getIntifaceStatus().state, 'error');
        assert.match(getIntifaceStatus().text, /Intiface Central is running/);
        assert.deepEqual(events.closes[0].wasConnected, false);
        assert.deepEqual(events.closes[0].assignedDevices, 0);
    });

    it('closes a previous socket before connecting again, detached', () => {
        const first = connectWith([EDGE]);
        connectIntifaceServer('ws://localhost:12345', handlersRecorder());
        assert.equal(first.closed, true);
        assert.equal(first.messages('StopAllDevices').length, 1);
        const second = sockets[1];
        handshake(second, { devices: [OSR2] });
        // The old socket's late close must not wipe the new device list.
        if (first.onclose) first.onclose({});
        assert.equal(intifaceDevices.size, 1);
        assert.equal(intifaceDevices.get(1).name, OSR2.DeviceName);
        assert.equal(isIntifaceConnected(), true);
    });

    it('reports a lost connection with the assigned device count', () => {
        const ws = connectWith([EDGE, OSR2]);
        setAxisRole(0, 0, 'off');
        setAxisRole(0, 1, 'off');
        assert.equal(countAssignedIntifaceDevices(), 1);
        ws.dropped();
        assert.equal(events.closes.length, 1);
        assert.equal(events.closes[0].wasConnected, true);
        assert.equal(events.closes[0].assignedDevices, 1);
        assert.equal(events.closes[0].intentional, false);
        assert.equal(intifaceDevices.size, 0);
        assert.equal(isIntifaceConnected(), false);
    });

    it('sends StopAllDevices on disconnect and reports Offline', () => {
        const ws = connectWith([EDGE]);
        disconnectIntiface();
        assert.equal(ws.messages('StopAllDevices').length, 1);
        assert.equal(getIntifaceStatus().state, 'offline');
        assert.equal(events.closes[0].intentional, true);
    });
});

describe('protocol details', () => {
    it('pings at half MaxPingTime and stops on close', async () => {
        // MaxPingTime 200 -> a Ping every 100 ms.
        const ws = connectWith([], { maxPing: 200 });
        await sleep(260);
        const pings = ws.messages('Ping').length;
        assert.ok(pings >= 2, `expected pings, got ${pings}`);
        disconnectIntiface();
        await sleep(50);
        assert.equal(ws.messages('Ping').length, pings);
    });

    it('does not ping when MaxPingTime is 0', async () => {
        const ws = connectWith([]);
        await sleep(40);
        assert.equal(ws.messages('Ping').length, 0);
    });

    it('closes on a handshake error and surfaces the message', () => {
        connectIntifaceServer('ws://localhost:12345', handlersRecorder());
        const ws = sockets[0];
        ws.open();
        ws.receive({ Error: { Id: 1, ErrorMessage: 'Unsupported message version', ErrorCode: 1 } });
        assert.equal(ws.closed, true);
        assert.equal(getIntifaceStatus().state, 'error');
        assert.equal(getIntifaceStatus().text, 'Unsupported message version');
    });

    it('flags an axis after three consecutive command errors and clears it on Ok', () => {
        const ws = connectWith([EDGE]);
        dispatchIntiface(50, 50, 0, 100);
        const first = ws.messages('ScalarCmd');
        assert.equal(first.length, 2);
        const axis = intifaceDevices.get(0).axes[0];
        const fail = (id) => ws.receive({ Error: { Id: id, ErrorMessage: 'Device write failed', ErrorCode: 4 } });
        fail(first[0].Id);
        assert.equal(axis.failing, false);
        assert.match(getIntifaceStatus().text, /Device write failed/);
        dispatchIntiface(60, 60, 0, 100);
        fail(ws.messages('ScalarCmd')[2].Id);
        dispatchIntiface(70, 70, 0, 100);
        fail(ws.messages('ScalarCmd')[4].Id);
        assert.equal(axis.failing, true);
        assert.equal(isIntifaceConnected(), true);
        dispatchIntiface(80, 80, 0, 100);
        ws.receive({ Ok: { Id: ws.messages('ScalarCmd')[6].Id } });
        assert.equal(axis.failing, false);
        assert.equal(getIntifaceStatus().text, 'Connected (Intiface Central, 1 device)');
    });
});

describe('dispatch', () => {
    it('deduplicates identical scalar values', () => {
        const ws = connectWith([EDGE]);
        dispatchIntiface(50, 50, 0, 100);
        dispatchIntiface(50, 50, 0, 100);
        dispatchIntiface(50, 50, 0, 100);
        assert.equal(ws.messages('ScalarCmd').length, 2);
        // Both axes of an internal toy are secondary: a primary change is
        // ignored, a secondary change re-sends both.
        dispatchIntiface(55, 50, 0, 100);
        assert.equal(ws.messages('ScalarCmd').length, 2);
        dispatchIntiface(55, 60, 0, 100);
        assert.equal(ws.messages('ScalarCmd').length, 4);
    });

    it('sends one LinearCmd per leg with the full duration and no re-send in flight', async () => {
        const ws = connectWith([OSR2]);
        dispatchIntiface(100, 0, 20, 80);
        let legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 1);
        assert.equal(legs[0].Vectors[0].Position, 0.8);
        const duration = legs[0].Vectors[0].Duration;
        assert.ok(duration >= 120);
        // Engine ticks during the leg do not re-send.
        dispatchIntiface(100, 0, 20, 80);
        dispatchIntiface(90, 0, 20, 80);
        assert.equal(ws.messages('LinearCmd').length, 1);
        await sleep(duration + 30);
        legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 2);
        assert.equal(legs[1].Vectors[0].Position, 0.2);
        await sleep(legs[1].Vectors[0].Duration + 30);
        assert.equal(ws.messages('LinearCmd').length, 3);
        assert.equal(ws.messages('LinearCmd')[2].Vectors[0].Position, 0.8);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('a cut the engine decides rests a stroker at once, not after the leg in flight', async () => {
        const ws = connectWith([OSR2, EDGE]);
        // The crawl on the mark: a slow leg, over two seconds long.
        dispatchIntiface(5, 40, 0, 100);
        const legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 1);
        assert.ok(legs[0].Vectors[0].Duration > 2000);
        // A slowdown that is not a stop waits for the leg.
        dispatchIntiface(2, 40, 0, 100);
        assert.equal(ws.messages('LinearCmd').length, 1);
        // The stall guard cuts the primary on an ordinary dispatch: the rest
        // move goes out with it, and the secondary keeps its vibration.
        const scalarsBefore = ws.messages('ScalarCmd').length;
        dispatchIntiface(0, 40, 0, 100);
        const after = ws.messages('LinearCmd');
        assert.equal(after.length, 2, 'the rest move goes out with the cut');
        assert.equal(after[1].Vectors[0].Duration, REST_MOVE_MS);
        assert.equal(after[1].Vectors[0].Position, 0);
        assert.equal(ws.messages('StopAllDevices').length, 0, 'an engine cut is not STOP');
        assert.equal(ws.messages('ScalarCmd').length, scalarsBefore, 'the secondary did not change');
        // Once, whatever the ticks after it say.
        dispatchIntiface(0, 40, 0, 100);
        await sleep(REST_MOVE_MS + 40);
        dispatchIntiface(0, 40, 0, 100);
        assert.equal(ws.messages('LinearCmd').length, 2);
    });

    it('an urgent dispatch re-times a stroker\'s leg in flight; an ordinary one waits for the next leg', async () => {
        // A stroker set to the secondary channel when the Ruin lockout
        // begins: the ride's 46% drops to 18% and the zone opens up.
        const ws = connectWith([OSR2]);
        setAxisRole(1, 0, 'secondary');
        // Nothing moves yet: the axis rests first.
        await sleep(REST_MOVE_MS + 40);
        const rested = ws.messages('LinearCmd').length;
        const t0 = Date.now();
        dispatchIntiface(46, 46, 5, 69);
        const ride = ws.messages('LinearCmd').slice(rested);
        assert.equal(ride.length, 1);
        assert.deepEqual(ride[0].Vectors[0], { Index: 0, Duration: legDurationMs(46, 0.64), Position: 0.69 });
        await sleep(100);
        // The packet before the lockout, an ordinary change: the next leg's.
        dispatchIntiface(0, 18, 0, 100);
        assert.equal(ws.messages('LinearCmd').length, rested + 1);
        // The lockout's own dispatch, urgent: the rest of the upstroke, to
        // the same end, at 18%.
        dispatchIntiface(0, 18, 0, 100, 0, 100, false, { urgent: true });
        const retimed = ws.messages('LinearCmd').slice(rested);
        assert.equal(retimed.length, 2);
        const { Position, Duration } = retimed[1].Vectors[0];
        assert.equal(Position, 0.69, 'no position the leg was not already on its way to');
        const left = t0 + ride[0].Vectors[0].Duration - Date.now();
        assert.ok(Duration > left && Duration < legDurationMs(18, 0.64), `${Duration} ms for what was left of ${left} ms`);
        // Once: the same decision again has nothing left to re-time.
        dispatchIntiface(0, 18, 0, 100, 0, 100, false, { urgent: true });
        assert.equal(ws.messages('LinearCmd').length, rested + 2);
        // The next leg comes when the re-timed one ends, not the original.
        await sleep(left + 60);
        assert.equal(ws.messages('LinearCmd').length, rested + 2);
        await sleep(Duration - left);
        const legs = ws.messages('LinearCmd').slice(rested);
        assert.equal(legs.length, 3);
        assert.deepEqual(legs[2].Vectors[0], { Index: 0, Duration: legDurationMs(18, 1), Position: 0 });
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('a re-timed leg goes where its leg was sent, not through an envelope changed since', async () => {
        // An inverted stroker on the secondary channel, a travel envelope of
        // 0-80: the zone's bottom is the envelope's top, 80%. During that leg
        // the wearer raises the envelope's minimum to 20, then an urgent
        // decision re-times the leg. Mirrored through 20-80, the leg's end
        // would have become 100%, 20 points past the wearer's maximum.
        const ws = connectWith([OSR2]);
        setAxisRole(1, 0, 'secondary');
        setAxisInvert(1, 0, true);
        await sleep(REST_MOVE_MS + 40);
        const legs = () => ws.messages('LinearCmd').map((m) => m.Vectors[0]);
        const leg = legDurationMs(60, 0.8);
        dispatchIntiface(0, 60, 0, 80, 0, 80);
        assert.deepEqual(legs().pop(), { Index: 0, Duration: leg, Position: 0 }, 'the zone top, mirrored to the envelope bottom');
        await sleep(leg + 10);
        assert.deepEqual(legs().pop(), { Index: 0, Duration: leg, Position: 0.8 }, 'the zone bottom, mirrored to the envelope top');
        const edited = legs().length;
        dispatchIntiface(0, 60, 20, 80, 20, 80);
        dispatchIntiface(0, 18, 20, 80, 20, 80, false, { urgent: true });
        const sent = legs().slice(edited);
        assert.equal(sent.length, 1, 'the leg is re-timed, once');
        assert.equal(sent[0].Position, 0.8, 'to 80%, where it was going');
        assert.ok(sent[0].Duration > leg - 20, `${sent[0].Duration} ms: the rest of the leg at 18%`);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('a re-timed leg goes where its leg was sent when the invert switch flips during it', async () => {
        // The wearer turns the sleeve over mid-stroke. Re-timed, the leg in
        // flight goes on up to the top at the new speed; mirrored through the
        // new setting, it was turned back down to the bottom.
        const ws = connectWith([OSR2]);
        setAxisRole(1, 0, 'secondary');
        await sleep(REST_MOVE_MS + 40);
        const legs = () => ws.messages('LinearCmd').map((m) => m.Vectors[0]);
        const leg = legDurationMs(60, 1);
        dispatchIntiface(0, 60, 0, 100);
        assert.deepEqual(legs().pop(), { Index: 0, Duration: leg, Position: 1 });
        await sleep(100);
        setAxisInvert(1, 0, true);
        dispatchIntiface(0, 95, 0, 100, 0, 100, false, { urgent: true });
        const retimed = legs().pop();
        assert.equal(retimed.Position, 1, 'on up to the top, not back down');
        assert.ok(retimed.Duration < leg - 100, `${retimed.Duration} ms: faster, as 95% asks`);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('re-times a leg to the envelope\'s own bound, which an inverted axis reaches through float noise', async () => {
        // 0.2 + 0.8 - 0.8 is 0.19999999999999996: the leg to the bottom of a
        // 20-80 envelope is on its bound, and an urgent decision re-times it
        // like any other.
        const ws = connectWith([OSR2]);
        setAxisRole(1, 0, 'secondary');
        setAxisInvert(1, 0, true);
        await sleep(REST_MOVE_MS + 40);
        const legs = () => ws.messages('LinearCmd').map((m) => m.Vectors[0]);
        const leg = legDurationMs(60, 0.6);
        dispatchIntiface(0, 60, 20, 80, 20, 80);
        assert.deepEqual(legs().pop(), { Index: 0, Duration: leg, Position: 0.2 });
        await sleep(60);
        const before = legs().length;
        dispatchIntiface(0, 18, 20, 80, 20, 80, false, { urgent: true });
        assert.equal(legs().length, before + 1);
        const retimed = legs().pop();
        assert.equal(retimed.Position, 0.2);
        assert.ok(retimed.Duration > leg, `${retimed.Duration} ms: re-timed at 18%`);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('a leg the wearer has put outside the envelope runs out instead of being re-timed', async () => {
        // During an upstroke to the top the wearer lowers the envelope's
        // maximum to 60, then the Ruin lockout drops the secondary to 18%.
        // Sent again, the leg would be a new command to 100%, outside the
        // envelope: it runs out as it was sent, as a leg in flight always did
        // when the envelope changed, and the next leg, inside the envelope,
        // carries the 18%.
        const ws = connectWith([OSR2]);
        setAxisRole(1, 0, 'secondary');
        await sleep(REST_MOVE_MS + 40);
        const legs = () => ws.messages('LinearCmd').map((m) => m.Vectors[0]);
        const leg = legDurationMs(70, 1);
        const t0 = Date.now();
        dispatchIntiface(0, 70, 0, 100);
        assert.deepEqual(legs().pop(), { Index: 0, Duration: leg, Position: 1 });
        await sleep(60);
        const edited = legs().length;
        dispatchIntiface(0, 70, 0, 60, 0, 60);
        dispatchIntiface(0, 18, 0, 60, 0, 60, false, { urgent: true });
        assert.equal(legs().length, edited, 'no new command to 100%');
        await sleep(t0 + leg - Date.now() + 40);
        assert.deepEqual(legs().slice(edited), [{ Index: 0, Duration: legDurationMs(18, 1), Position: 0 }], 'the next leg, at 18%');
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('times what is left of a leg over what it covers on the device', async () => {
        // A narrow zone at the bottom of the envelope. The wearer turns the
        // sleeve over during a leg to 0.2: the next leg, the zone's bottom
        // mirrored to the top, takes the sleeve 0.8 of the travel in a leg
        // timed for the zone's 0.2. An urgent raise to 80% early in it times
        // what is left over the 0.8, at the planner's pace for 80%; over the
        // 0.2 it was the 120 ms floor, faster than any leg the planner makes.
        const ws = connectWith([OSR2]);
        setAxisRole(1, 0, 'secondary');
        await sleep(REST_MOVE_MS + 40);
        const legs = () => ws.messages('LinearCmd').map((m) => m.Vectors[0]);
        const leg = legDurationMs(10, 0.2);
        const t0 = Date.now();
        dispatchIntiface(0, 10, 0, 20, 0, 100);
        assert.deepEqual(legs().pop(), { Index: 0, Duration: leg, Position: 0.2 });
        setAxisInvert(1, 0, true);
        await sleep(t0 + leg - Date.now() + 5);
        assert.deepEqual(legs().pop(), { Index: 0, Duration: leg, Position: 1 }, 'from 0.2 to the top on a leg timed for 0.2');
        const before = legs().length;
        dispatchIntiface(0, 80, 0, 20, 0, 100, false, { urgent: true });
        // The leg began no earlier than t0 + leg: at least this share of it
        // is left.
        const share = (leg - (Date.now() - t0 - leg)) / leg;
        assert.equal(legs().length, before + 1, 'the leg is re-timed');
        const retimed = legs().pop();
        assert.equal(retimed.Position, 1);
        assert.ok(retimed.Duration >= Math.round(share * legDurationMs(80, 0.8)) - 1, `${retimed.Duration} ms: at least ${share.toFixed(2)} of a leg over 0.8 at 80%`);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('times what is left of a first leg as if it covered the whole travel', async () => {
        // Intiface does not rest a stroker on connect: the first leg starts
        // wherever the sleeve was left, which can be the far end. What is left
        // of it is timed over the whole travel, never over less.
        const ws = connectWith([OSR2]);
        const leg = legDurationMs(10, 0.2);
        const t0 = Date.now();
        dispatchIntiface(10, 0, 0, 20);
        assert.deepEqual(ws.messages('LinearCmd').map((m) => m.Vectors[0]), [{ Index: 0, Duration: leg, Position: 0.2 }]);
        await sleep(50);
        dispatchIntiface(80, 0, 0, 20, 0, 100, false, { urgent: true });
        const share = (leg - (Date.now() - t0)) / leg;
        const legs = ws.messages('LinearCmd').map((m) => m.Vectors[0]);
        assert.equal(legs.length, 2);
        assert.equal(legs[1].Position, 0.2);
        assert.ok(legs[1].Duration >= Math.round(share * legDurationMs(80, 1)) - 1, `${legs[1].Duration} ms: at least ${share.toFixed(2)} of a leg over the whole travel at 80%`);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('times a leg after the Test button from where the test left the sleeve', async () => {
        // The stroker rests at 0.9, then the Test button takes it to the top
        // and back to the bottom. The next leg goes from the bottom to the
        // top of a zone at 0.8-1.0: the whole travel on a leg timed for the
        // zone's 0.2, and an urgent raise times what is left of it over the
        // whole travel - not from the rest, nor from the top of the test.
        const testMoveMs = INTIFACE_TIMINGS.testMoveMs;
        INTIFACE_TIMINGS.testMoveMs = 20;
        try {
            const ws = connectWith([OSR2]);
            const legs = () => ws.messages('LinearCmd').map((m) => m.Vectors[0]);
            dispatchIntiface(0, 0, 90, 100);
            assert.deepEqual(legs(), [{ Index: 0, Duration: REST_MOVE_MS, Position: 0.9 }]);
            await sleep(REST_MOVE_MS + 40);
            dispatchIntiface(0, 0, 0, 100);
            assert.equal(testSingleAxis(1, 0), true);
            await sleep(3 * INTIFACE_TIMINGS.testMoveMs + 100);
            assert.deepEqual(legs().slice(1).map((v) => v.Position), [1, 0]);
            const leg = legDurationMs(10, 0.2);
            const t0 = Date.now();
            dispatchIntiface(10, 0, 80, 100);
            assert.deepEqual(legs().pop(), { Index: 0, Duration: leg, Position: 1 });
            await sleep(40);
            const before = legs().length;
            dispatchIntiface(80, 0, 80, 100, 0, 100, false, { urgent: true });
            const share = (leg - (Date.now() - t0)) / leg;
            assert.equal(legs().length, before + 1, 'the leg is re-timed');
            const retimed = legs().pop();
            assert.equal(retimed.Position, 1);
            assert.ok(retimed.Duration >= Math.round(share * legDurationMs(80, 1)) - 1, `${retimed.Duration} ms: at least ${share.toFixed(2)} of a leg over the whole travel at 80%`);
            dispatchIntiface(0, 0, 0, 100, 0, 100, true);
        } finally {
            INTIFACE_TIMINGS.testMoveMs = testMoveMs;
        }
    });

    it('stop sends StopAllDevices then a single 400 ms rest move and goes quiet', async () => {
        const ws = connectWith([OSR2]);
        dispatchIntiface(0, 0, 0, 100, 10, 90, true);
        assert.equal(ws.messages('StopAllDevices').length, 1);
        const legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 1);
        assert.equal(legs[0].Vectors[0].Duration, REST_MOVE_MS);
        // Rest position is clamped into the hardware envelope (10 %).
        assert.equal(legs[0].Vectors[0].Position, 0.1);
        await sleep(REST_MOVE_MS + 40);
        dispatchIntiface(0, 0, 0, 100, 10, 90, true);
        dispatchIntiface(0, 0, 0, 100, 10, 90);
        assert.equal(ws.messages('LinearCmd').length, 1);
    });

    it('OFF sends a single rest / zero and then nothing, plus StopDeviceCmd when the device is all OFF', async () => {
        const ws = connectWith([OSR2, EDGE]);
        dispatchIntiface(80, 80, 20, 80);
        const linearBefore = ws.messages('LinearCmd').length;
        assert.equal(linearBefore, 1);
        const firstLeg = ws.messages('LinearCmd')[0].Vectors[0].Duration;
        setAxisRole(1, 0, 'off');
        assert.equal(ws.messages('StopDeviceCmd').filter((m) => m.DeviceIndex === 1).length, 1);
        await sleep(firstLeg + 40);
        const legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 2);
        assert.equal(legs[1].Vectors[0].Duration, REST_MOVE_MS);
        assert.equal(legs[1].Vectors[0].Position, 0.2);
        await sleep(REST_MOVE_MS + 40);
        dispatchIntiface(80, 80, 20, 80);
        dispatchIntiface(90, 90, 20, 80);
        assert.equal(ws.messages('LinearCmd').length, 2);

        // Scalar OFF: one zero, then silence.
        const scalarsBefore = ws.messages('ScalarCmd').length;
        setAxisRole(0, 0, 'off');
        const zero = ws.messages('ScalarCmd')[scalarsBefore];
        assert.equal(zero.Scalars[0].Scalar, 0);
        dispatchIntiface(95, 95, 20, 80);
        const after = ws.messages('ScalarCmd').slice(scalarsBefore + 1);
        assert.ok(after.every((m) => m.Scalars[0].Index !== 0));
    });

    it('one axis OFF mid-leg on a multi-axis stroker rests that axis at once', async () => {
        const ws = connectWith([SR6]);
        const dev = intifaceDevices.get(3);
        assert.deepEqual(dev.axes.map((a) => a.role), ['primary', 'secondary']);
        dispatchIntiface(5, 5, 0, 100);
        const legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 2);
        assert.ok(legs.every((m) => m.Vectors[0].Duration > 2000), 'slow legs are in flight');
        setAxisRole(3, 1, 'off');
        const after = ws.messages('LinearCmd');
        assert.equal(after.length, 3, 'the rest move goes out immediately, not after the leg');
        assert.equal(after[2].Vectors[0].Index, 1);
        assert.equal(after[2].Vectors[0].Duration, REST_MOVE_MS);
        assert.equal(after[2].Vectors[0].Position, 0);
        assert.equal(ws.messages('StopDeviceCmd').length, 0, 'the other axis keeps its leg');
        await sleep(REST_MOVE_MS + 40);
        dispatchIntiface(5, 5, 0, 100);
        assert.equal(ws.messages('LinearCmd').length, 3, 'nothing more for the OFF axis');
    });

    it('applies the cap to scalars and honours linear invert', async () => {
        const ws = connectWith([EDGE, OSR2]);
        setAxisMaxCap(0, 1, 50);
        setAxisInvert(1, 0, true);
        dispatchIntiface(100, 100, 20, 80);
        const scalars = ws.messages('ScalarCmd').filter((m) => m.Scalars[0].Index === 1);
        assert.equal(scalars[scalars.length - 1].Scalars[0].Scalar, 0.5);
        const leg = ws.messages('LinearCmd')[0];
        assert.equal(leg.Vectors[0].Position, 0.2);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
        await sleep(leg.Vectors[0].Duration + REST_MOVE_MS + 60);
    });

    it('invert mirrors inside the hardware envelope, never below its lower guard', async () => {
        const ws = connectWith([OSR2]);
        setAxisInvert(1, 0, true);
        dispatchIntiface(100, 0, 20, 90, 20, 90);
        const leg = ws.messages('LinearCmd')[0];
        // zone max 0.9 mirrored inside 0.2..0.9 -> 0.2, never 0.1
        assert.equal(leg.Vectors[0].Position, 0.2);
        // STOP: the rest move (envelope min 0.2) mirrors to 0.9, still inside.
        dispatchIntiface(0, 0, 0, 100, 20, 90, true);
        await sleep(leg.Vectors[0].Duration + 30);
        const legs = ws.messages('LinearCmd');
        assert.equal(legs.length, 2);
        assert.equal(legs[1].Vectors[0].Duration, REST_MOVE_MS);
        assert.equal(legs[1].Vectors[0].Position, 0.9);
        assert.ok(legs.every((m) => m.Vectors[0].Position >= 0.2 && m.Vectors[0].Position <= 0.9));
    });

    it('stopAllIntiface is a best-effort StopAllDevices', () => {
        const ws = connectWith([EDGE]);
        assert.equal(stopAllIntiface(), true);
        assert.equal(ws.messages('StopAllDevices').length, 1);
        disconnectIntiface();
        assert.equal(stopAllIntiface(), false);
    });
});

describe('rotation', () => {
    it('reverses on edge at most once per second and re-sends the new direction', () => {
        const ws = connectWith([VORZE]);
        dispatchIntiface(60, 0, 0, 100);
        assert.equal(ws.messages('RotateCmd').length, 1);
        assert.equal(ws.messages('RotateCmd')[0].Rotations[0].Clockwise, true);
        const t0 = intifaceDevices.get(2).lastDirectionChangeAt;
        assert.equal(reverseIntifaceRotation('edge', t0 + 500), 0);
        assert.equal(reverseIntifaceRotation('edge', t0 + 1000), 1);
        const rot = ws.messages('RotateCmd');
        assert.equal(rot.length, 2);
        assert.equal(rot[1].Rotations[0].Clockwise, false);
        assert.equal(reverseIntifaceRotation('edge', t0 + 1500), 0);
        setDeviceRotation(2, { reverseOnEdge: false });
        assert.equal(reverseIntifaceRotation('edge', t0 + 5000), 0);
    });

    it('a reversal left to the next dispatch sends the new direction with the new speed, once', () => {
        const ws = connectWith([VORZE]);
        dispatchIntiface(45, 0, 0, 100);
        const t0 = intifaceDevices.get(2).lastDirectionChangeAt;
        // Full Stop on the edge: the engine reverses and cuts in one pass.
        assert.equal(reverseIntifaceRotation('edge', t0 + 1000, { apply: false }), 1);
        assert.equal(ws.messages('RotateCmd').length, 1, 'the reversal sent nothing by itself');
        dispatchIntiface(0, 0, 0, 100);
        let rot = ws.messages('RotateCmd');
        assert.equal(rot.length, 2, 'the stop, and no 45% the other way before it');
        assert.equal(rot[1].Rotations[0].Speed, 0);
        // Crawl on the next edge: the crawl goes out already reversed.
        dispatchIntiface(45, 0, 0, 100);
        rot = ws.messages('RotateCmd');
        assert.deepEqual(rot[2].Rotations[0], { Index: 0, Speed: 0.45, Clockwise: false });
        assert.equal(reverseIntifaceRotation('edge', t0 + 2000, { apply: false }), 1);
        dispatchIntiface(10, 0, 0, 100);
        rot = ws.messages('RotateCmd');
        assert.equal(rot.length, 4);
        assert.deepEqual(rot[3].Rotations[0], { Index: 0, Speed: 0.1, Clockwise: true });
    });

    it('alternates direction every N seconds while spinning', () => {
        const ws = connectWith([VORZE]);
        setDeviceRotation(2, { alternateSeconds: 5 });
        const dev = intifaceDevices.get(2);
        dev.lastDirectionChangeAt = Date.now() - 6000;
        dispatchIntiface(60, 0, 0, 100);
        assert.equal(ws.messages('RotateCmd').length, 1);
        assert.equal(ws.messages('RotateCmd')[0].Rotations[0].Clockwise, false);
        dispatchIntiface(60, 0, 0, 100);
        assert.equal(ws.messages('RotateCmd').length, 1);
        // Stopped rotator: no direction churn, one zero only.
        dispatchIntiface(0, 0, 0, 100);
        dev.lastDirectionChangeAt = Date.now() - 6000;
        dispatchIntiface(0, 0, 0, 100);
        const rot = ws.messages('RotateCmd');
        assert.equal(rot.length, 2);
        assert.equal(rot[1].Rotations[0].Speed, 0);
        assert.equal(setDeviceRotation(2, { alternateSeconds: 999 }), true);
        assert.equal(dev.alternateSeconds, 60);
        setDeviceRotation(2, { alternateSeconds: 0 });
        assert.equal(dev.alternateSeconds, 0);
    });
});

describe('persistence', () => {
    it('stores roles, caps, invert and rotation per device signature and reapplies them on reconnect', () => {
        connectWith([EDGE, OSR2, VORZE]);
        setAxisRole(0, 0, 'off');
        setAxisMaxCap(0, 1, 35);
        setAxisInvert(1, 0, true);
        setAxisRole(1, 0, 'secondary');
        setDeviceRotation(2, { reverseOnEdge: false, alternateSeconds: 12 });
        assert.equal(saveIntifaceConfig(), true);
        const stored = JSON.parse(memory.get(INTIFACE_STORAGE_KEY));
        assert.equal(stored['Lovense Edge|S:Vibrate,Vibrate|L:|R:'].axes['scalar:0'].role, 'off');
        assert.equal(stored['Lovense Edge|S:Vibrate,Vibrate|L:|R:'].axes['scalar:1'].maxCap, 35);
        disconnectIntiface();
        assert.equal(intifaceDevices.size, 0);

        // Re-enumerated with different DeviceIndex values: the mapping follows the signature.
        connectWith([
            { ...OSR2, DeviceIndex: 7 },
            { ...EDGE, DeviceIndex: 8 },
            { ...VORZE, DeviceIndex: 9 }
        ]);
        const edge = intifaceDevices.get(8);
        assert.equal(edge.axes[0].role, 'off');
        assert.equal(edge.axes[1].maxCap, 35);
        const osr = intifaceDevices.get(7);
        assert.equal(osr.axes[0].invert, true);
        assert.equal(osr.axes[0].role, 'secondary');
        const vorze = intifaceDevices.get(9);
        assert.equal(vorze.reverseOnEdge, false);
        assert.equal(vorze.alternateSeconds, 12);
    });

    it('survives corrupt storage', () => {
        memory.set(INTIFACE_STORAGE_KEY, '{not json');
        connectWith([OSR2]);
        assert.equal(intifaceDevices.get(1).axes[0].role, 'primary');
        assert.equal(saveIntifaceConfig(), true);
    });
});

// Buttplug's OSSM handler (protocol_impl/ossm.rs) answers a command for the
// mode the machine is not in with "go:menu", which the OSSM firmware runs as
// an emergency stop (src/ossm/state/machine.h): every switch between a
// LinearCmd and a non-zero Oscillate is one. This counts them in what the
// driver sent, the way the server would see it.
function ossmModeSwitches(ws, devIndex = OSSM.DeviceIndex) {
    let mode = 'none';
    let switches = 0;
    for (const frame of ws.sent) {
        for (const m of frame) {
            const [type, body] = Object.entries(m)[0];
            if (!body || body.DeviceIndex !== devIndex) continue;
            if (type === 'LinearCmd') {
                if (mode !== 'pos') { if (mode !== 'none') switches += 1; mode = 'pos'; }
            } else if (type === 'ScalarCmd' && body.Scalars.some((x) => x.Scalar > 0)) {
                if (mode !== 'osc') { if (mode !== 'none') switches += 1; mode = 'osc'; }
            }
        }
    }
    return switches;
}

const ossmMessages = (ws, type) => ws.messages(type).filter((m) => m.DeviceIndex === OSSM.DeviceIndex);

describe('an OSSM through Intiface: one motor, one mode', () => {
    it('drives the Position axis alone by default and never touches Oscillate', async () => {
        const ws = connectWith([OSSM]);
        const dev = intifaceDevices.get(4);
        assert.deepEqual(dev.axes.map((a) => [a.type, a.role]), [['Oscillate', 'off'], ['Position', 'primary']]);
        for (let i = 0; i < 6; i++) {
            dispatchIntiface(60 + i * 5, 40 + (i % 3) * 20, 30, 70, 20, 80);
            await sleep(120);
        }
        dispatchIntiface(0, 0, 0, 100, 20, 80, true);
        assert.equal(ossmMessages(ws, 'ScalarCmd').length, 0, 'the secondary channel never reaches the Oscillate twin');
        const legs = ossmMessages(ws, 'LinearCmd');
        assert.ok(legs.length >= 2);
        assert.equal(ossmModeSwitches(ws), 0);
        assert.ok(legs.every((m) => m.Vectors[0].Position >= 0.2 && m.Vectors[0].Position <= 0.8));
    });

    it('drove both before: the old default flipped the machine on every secondary change', () => {
        // The roles a saved map from before this build (or the old
        // defaults) held: Position primary, Oscillate secondary. The driver
        // takes the Position axis and leaves Oscillate OFF.
        memory.set(INTIFACE_STORAGE_KEY, JSON.stringify({
            'Kinky Makers OSSM|S:Oscillate|L:Position|R:': { axes: { 'scalar:0': { role: 'secondary' }, 'linear:0': { role: 'primary' } } }
        }));
        const ws = connectWith([OSSM]);
        assert.deepEqual(intifaceDevices.get(4).axes.map((a) => a.role), ['off', 'primary']);
        dispatchIntiface(50, 60, 30, 70);
        dispatchIntiface(50, 80, 30, 70);
        assert.equal(ossmMessages(ws, 'ScalarCmd').length, 0);
        assert.equal(ossmModeSwitches(ws), 0);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('putting Oscillate in use takes Position out without a command to it, and drives a speed', async () => {
        const ws = connectWith([OSSM]);
        assert.equal(setAxisRole(4, 0, 'primary'), true);
        const dev = intifaceDevices.get(4);
        assert.deepEqual(dev.axes.map((a) => a.role), ['primary', 'off']);
        assert.equal(ossmMessages(ws, 'LinearCmd').length, 0, 'no rest move for the axis going out: it would flip the machine');
        setAxisMaxCap(4, 0, 50);
        // Oscillate runs only while the travel envelope is the whole travel.
        for (const speed of [20, 40, 60]) {
            dispatchIntiface(speed, 90, 30, 70, 0, 100);
            await sleep(20);
        }
        const levels = ossmMessages(ws, 'ScalarCmd').map((m) => m.Scalars[0]);
        assert.ok(levels.every((x) => x.ActuatorType === 'Oscillate' && x.Index === 0));
        // The primary speed under the cap - a speed, never a position, and
        // the secondary's 90 nowhere. (The 0 the role change sent at rest
        // Buttplug drops outside oscillate mode: no mode change.)
        assert.deepEqual(levels.filter((x) => x.Scalar > 0).map((x) => Math.round(100 * x.Scalar)), [10, 20, 30]);
        // STOP: the server-side stop, a zero, and still no LinearCmd.
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
        const stopAt = ws.sent.findIndex((f) => f.some((m) => m.StopAllDevices));
        assert.ok(stopAt >= 0);
        assert.equal(ossmMessages(ws, 'ScalarCmd').at(-1).Scalars[0].Scalar, 0);
        await sleep(REST_MOVE_MS + 50);
        assert.equal(ossmMessages(ws, 'LinearCmd').length, 0);
        assert.equal(ossmModeSwitches(ws), 0);
    });

    it('refuses a Test of the mode not in use and runs the Oscillate Test slowly', async () => {
        const ws = connectWith([OSSM]);
        assert.equal(testSingleAxis(4, 0), false, 'Position is in use: an Oscillate Test would flip the machine');
        assert.equal(ossmMessages(ws, 'ScalarCmd').length, 0);
        setAxisRole(4, 1, 'off');
        assert.equal(testSingleAxis(4, 0), true);
        const [test] = ossmMessages(ws, 'ScalarCmd');
        assert.equal(test.Scalars[0].Scalar, OSCILLATE_TEST_LEVEL);
        assert.equal(testSingleAxis(4, 1), true, 'with both OFF either can be tested');
        disconnectIntiface();
    });

    it('setting Position OFF before anything moved it sends nothing, not a move to the end of the rail', () => {
        const ws = connectWith([OSSM, OSR2]);
        setAxisRole(4, 1, 'off');
        setAxisRole(1, 0, 'off');
        assert.equal(ws.messages('LinearCmd').length, 0);
    });

    it('a Test takes the travel envelope with it, and an OFF after it rests inside the envelope', async () => {
        const ws = connectWith([OSR2]);
        assert.equal(testSingleAxis(1, 0, { min: 40, max: 90 }), true);
        await sleep(INTIFACE_TIMINGS.testMoveMs + 100);
        const legs = ws.messages('LinearCmd').map((m) => m.Vectors[0].Position);
        assert.deepEqual(legs, [0.8, 0.4]);
        setAxisRole(1, 0, 'off');
        const rest = ws.messages('LinearCmd').slice(2).map((m) => m.Vectors[0].Position);
        assert.ok(rest.every((p) => p >= 0.4 && p <= 0.9), `rest at ${rest}`);
    });

    it('sends every position on the device\'s own step, inside the envelope', async () => {
        const ws = connectWith([OSSM]);
        // A 29-71% envelope: 0.29 x 100 truncates to 28 on the server.
        dispatchIntiface(100, 0, 29, 71, 29, 71);
        await sleep(400);
        dispatchIntiface(0, 0, 0, 100, 29, 71, true);
        const steps = ossmMessages(ws, 'LinearCmd').map((m) => Math.round(100 * m.Vectors[0].Position));
        assert.ok(steps.length >= 2);
        assert.ok(steps.every((s) => s >= 29 && s <= 71), `steps ${steps}`);
        assert.ok(steps.includes(29));
    });

    it('STOP, page-away and disconnect send StopAllDevices, which stops the Oscillate mode', () => {
        const ws = connectWith([OSSM]);
        setAxisRole(4, 0, 'primary');
        dispatchIntiface(60, 0, 30, 70);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
        assert.equal(ws.messages('StopAllDevices').length, 1);
        dispatchIntiface(60, 0, 30, 70);
        assert.equal(stopAllIntiface(), true);
        assert.equal(ws.messages('StopAllDevices').length, 2);
        disconnectIntiface();
        assert.equal(ws.messages('StopAllDevices').length, 3);
        assert.equal(ossmModeSwitches(ws), 0);
    });
});

describe('a ScalarCmd Position is a position, never a level', () => {
    it('is OFF, cannot be put in use, is not tested and is sent nothing', async () => {
        const ws = connectWith([TCODE_V03]);
        const dev = intifaceDevices.get(5);
        assert.deepEqual(dev.axes.map((a) => [a.kind, a.role, a.inert]), [['scalar', 'off', true], ['linear', 'primary', false]]);
        assert.equal(setAxisRole(5, 0, 'secondary'), false);
        assert.equal(testSingleAxis(5, 0), false);
        dispatchIntiface(40, 90, 20, 80);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
        assert.equal(ws.messages('ScalarCmd').length, 0, 'the secondary speed used to go out as where the stroker jumped to');
        assert.ok(ws.messages('LinearCmd').length >= 1);
    });

    it('stays OFF whatever a saved map says', () => {
        memory.set(INTIFACE_STORAGE_KEY, JSON.stringify({
            'TCode v0.3 (Single Linear Axis)|S:Position|L:Position|R:': { axes: { 'scalar:0': { role: 'secondary' } } }
        }));
        connectWith([TCODE_V03]);
        assert.equal(intifaceDevices.get(5).axes[0].role, 'off');
    });
});

describe('pulsed vibration', () => {
    const NORA = {
        DeviceIndex: 6,
        DeviceName: 'Lovense Nora',
        DeviceMessages: { ScalarCmd: [{ StepCount: 20, ActuatorType: 'Vibrate' }], StopDeviceCmd: {} }
    };
    const levels = (ws) => ws.messages('ScalarCmd').filter((m) => m.DeviceIndex === 6).map((m) => m.Scalars[0].Scalar);

    it('is Constant until chosen, and only on a vibrate axis', () => {
        connectWith([NORA, OSSM]);
        assert.equal(intifaceDevices.get(6).axes[0].vibeMode, 'constant');
        assert.equal(setAxisVibeMode(4, 0, { mode: 'pulsed' }), false, 'Oscillate is not a vibrator');
        assert.equal(setAxisVibeMode(4, 1, { mode: 'pulsed' }), false);
        assert.equal(setAxisVibeMode(6, 0, { mode: 'strobe' }), false);
        assert.equal(setAxisVibeMode(6, 0, { periodMs: 1000 }), false);
        assert.equal(intifaceDevices.get(6).axes[0].vibeMode, 'constant');
        assert.equal(intifaceDevices.get(6).axes[0].pulsePeriodMs, 1600);
    });

    it('alternates the engine\'s level and 0 on its period: two commands a period', async () => {
        const ws = connectWith([NORA]);
        assert.equal(setAxisVibeMode(6, 0, { mode: 'pulsed', periodMs: 800 }), true);
        const from = levels(ws).length;
        dispatchIntiface(50, 0, 0, 100);
        assert.deepEqual(levels(ws).slice(from), [0.5], 'on at once, at the peak');
        // Engine ticks while it pulses add nothing when the level holds.
        await sleep(200);
        dispatchIntiface(50, 0, 0, 100);
        await sleep(1450);
        const seen = levels(ws).slice(from);
        assert.deepEqual(seen.slice(0, 5), [0.5, 0, 0.5, 0, 0.5]);
        assert.ok(seen.length <= 5, `${seen.length} commands in 1.65 s`);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('takes a new engine level at once while on, and never goes above the cap', async () => {
        const ws = connectWith([NORA]);
        setAxisVibeMode(6, 0, { mode: 'pulsed', periodMs: 1600 });
        setAxisMaxCap(6, 0, 38);
        const from = levels(ws).length;
        dispatchIntiface(100, 0, 0, 100);
        // 38% is not a step of a 20-step toy: the cap is the step under it,
        // 35%, and the peak is the engine's level under that.
        assert.deepEqual(levels(ws).slice(from), [0.35]);
        dispatchIntiface(60, 0, 0, 100);
        assert.deepEqual(levels(ws).slice(from), [0.35, 0.2]);
        assert.ok(levels(ws).every((x) => Math.ceil(20 * x) / 20 <= 0.38));
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('is cut at once by STOP, pause and the watchdog, page-away, OFF and disconnect, with no pulse after', async () => {
        const cuts = {
            stop: () => dispatchIntiface(0, 0, 0, 100, 0, 100, true),
            pageAway: () => stopAllIntiface(),
            off: () => setAxisRole(6, 0, 'off'),
            disconnect: () => disconnectIntiface()
        };
        for (const [name, cut] of Object.entries(cuts)) {
            resetIntifaceForTests();
            memory.clear();
            const ws = connectWith([NORA]);
            setAxisVibeMode(6, 0, { mode: 'pulsed', periodMs: 800 });
            const axis = intifaceDevices.get(6).axes[0];
            dispatchIntiface(80, 0, 0, 100);
            await sleep(500); // into the off half, so the next pulse is due
            cut();
            assert.equal(axis.pulse, null, `${name}: the train is still running`);
            const at = ws.sent.length;
            await sleep(900);
            const after = ws.sent.slice(at).flat().filter((m) => m.ScalarCmd && m.ScalarCmd.Scalars.some((x) => x.Scalar > 0));
            assert.deepEqual(after, [], `${name}: a pulse went out after the cut`);
        }
    });

    it('a cut in the on half leaves the vibrator at 0', async () => {
        const ws = connectWith([NORA]);
        setAxisVibeMode(6, 0, { mode: 'pulsed', periodMs: 2400 });
        dispatchIntiface(70, 0, 0, 100);
        await sleep(100);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
        assert.equal(ws.messages('StopAllDevices').length, 1);
        assert.equal(levels(ws).at(-1), 0);
        await sleep(1400);
        assert.equal(levels(ws).at(-1), 0);
    });

    it('starts again from the peak when the engine starts again after page-away', async () => {
        const ws = connectWith([NORA]);
        setAxisVibeMode(6, 0, { mode: 'pulsed', periodMs: 800 });
        dispatchIntiface(60, 0, 0, 100);
        stopAllIntiface();
        const before = levels(ws).length;
        dispatchIntiface(60, 0, 0, 100);
        assert.deepEqual(levels(ws).slice(before), [0.6], 'the level the server stopped is not taken as still running');
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('is saved per device with its period and comes back on reconnect', () => {
        connectWith([NORA]);
        setAxisVibeMode(6, 0, { mode: 'pulsed', periodMs: 2400 });
        const stored = JSON.parse(memory.get(INTIFACE_STORAGE_KEY));
        assert.deepEqual(stored['Lovense Nora|S:Vibrate|L:|R:'].axes['scalar:0'], { role: 'primary', maxCap: 100, invert: false, vibeMode: 'pulsed', pulsePeriodMs: 2400 });
        disconnectIntiface();
        connectWith([{ ...NORA, DeviceIndex: 9 }]);
        const axis = intifaceDevices.get(9).axes[0];
        assert.equal(axis.vibeMode, 'pulsed');
        assert.equal(axis.pulsePeriodMs, 2400);
    });
});

// The OSSM's linear axis as the server sees it: each LinearCmd with the step
// it lands on (100 steps) and when it was sent.
function ossmLegs(ws) {
    const out = [];
    ws.sent.forEach((frame, i) => frame.forEach((m) => {
        if (m.LinearCmd && m.LinearCmd.DeviceIndex === OSSM.DeviceIndex) {
            out.push({ step: Math.round(100 * m.LinearCmd.Vectors[0].Position), ms: m.LinearCmd.Vectors[0].Duration, at: ws.at[i] });
        }
    }));
    return out;
}

describe('an OSSM\'s Position axis holds where it is on a stop', () => {
    it('STOP, pause and the watchdog send it nothing more - no rest move', async () => {
        const ws = connectWith([OSSM]);
        dispatchIntiface(30, 0, 30, 70, 20, 80);
        await sleep(1700);
        const moving = ossmLegs(ws).length;
        assert.ok(moving >= 3);
        // What app.js sends for STOP, a pause and the watchdog alike.
        dispatchIntiface(0, 0, 0, 100, 20, 80, true);
        assert.equal(ws.messages('StopAllDevices').length, 1);
        await sleep(1200);
        assert.equal(ossmLegs(ws).length, moving, 'not a segment and not a rest move after the stop');
    });

    it('page-away and OFF hold it the same way', async () => {
        for (const cut of [() => stopAllIntiface(), () => setAxisRole(4, 1, 'off')]) {
            resetIntifaceForTests();
            memory.clear();
            const ws = connectWith([OSSM]);
            dispatchIntiface(10, 0, 30, 70, 0, 100);
            await sleep(1500);
            const moving = ossmLegs(ws).length;
            cut();
            await sleep(1200);
            assert.equal(ossmLegs(ws).length, moving);
        }
    });

    it('sends every leg after the first as one-way segments of at most 200 ms, re-timed never', async () => {
        const ws = connectWith([OSSM]);
        dispatchIntiface(5, 0, 30, 70, 0, 100);
        await sleep(2500);
        // A guard's new speed mid-leg: re-timed, the leg's end would go out
        // ahead of the segments still due, and they would run back from it.
        dispatchIntiface(8, 0, 30, 70, 0, 100, false, { urgent: true });
        await sleep(2000);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
        const legs = ossmLegs(ws);
        const later = legs.slice(1);
        assert.ok(later.length >= 8, `${later.length} segments`);
        assert.ok(later.every((l) => l.ms <= HELD_SEGMENT_MS), `durations ${later.map((l) => l.ms)}`);
        // One way between the zone's ends, and only there does it turn.
        for (let i = 1; i < later.length - 1; i++) {
            const turn = Math.sign(later[i].step - later[i - 1].step) !== Math.sign(later[i + 1].step - later[i].step);
            if (turn) assert.ok([30, 70].includes(later[i].step), `turned at ${later[i].step}`);
        }
        const span = (legs.at(-1).at - legs[0].at) / 1000;
        assert.ok(legs.length / span <= 10, `${(legs.length / span).toFixed(1)} commands a second`);
    });

    it('never sends the position it last sent: no re-time, no repeat at a turn, a stop or a restart', async () => {
        const ws = connectWith([OSSM]);
        dispatchIntiface(20, 0, 30, 70, 20, 80);
        await sleep(300);
        // A guard engaging mid-leg: an OSR2 re-times the leg in flight; an OSSM would get its end again.
        dispatchIntiface(70, 0, 30, 70, 20, 80, false, { urgent: true });
        await sleep(900);
        dispatchIntiface(0, 0, 0, 100, 20, 80, true);
        await sleep(300);
        dispatchIntiface(40, 0, 45, 65, 20, 80);
        await sleep(900);
        dispatchIntiface(40, 0, 45, 65, 20, 80, false, { urgent: true });
        dispatchIntiface(0, 0, 0, 100, 20, 80, true);
        setAxisRole(4, 1, 'off');
        setAxisRole(4, 1, 'primary');
        await sleep(200);
        dispatchIntiface(60, 0, 30, 70, 20, 80);
        await sleep(600);
        dispatchIntiface(0, 0, 0, 100, 20, 80, true);
        const steps = ossmLegs(ws).map((l) => l.step);
        assert.ok(steps.length >= 6);
        steps.forEach((step, i) => { if (i) assert.notEqual(step, steps[i - 1], `repeat at ${i}: ${steps.join(' ')}`); });
        assert.ok(steps.every((x) => x >= 20 && x <= 80));
    });

    it('starts again from where it held, in segments, toward the farther end of the zone', async () => {
        const ws = connectWith([OSSM]);
        dispatchIntiface(5, 0, 30, 70, 0, 100);
        await sleep(2700);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
        const held = ossmLegs(ws).at(-1).step;
        await sleep(200);
        const before = ossmLegs(ws).length;
        dispatchIntiface(5, 0, 30, 70, 0, 100);
        const first = ossmLegs(ws)[before];
        assert.ok(first, 'it moves again');
        assert.notEqual(first.step, held);
        assert.ok(first.ms <= HELD_SEGMENT_MS, 'the start is known: segments from the first command');
        const farther = (70 - held) >= (held - 30) ? 70 : 30;
        assert.equal(Math.sign(first.step - held), Math.sign(farther - held));
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });
});

describe('the Oscillate mode of an OSSM only with the whole travel', () => {
    it('is refused while the travel envelope is narrower than 0-100%, Test included', () => {
        const ws = connectWith([OSSM]);
        assert.equal(setAxisRole(4, 0, 'primary', { envelope: { min: 20, max: 80 } }), false);
        assert.deepEqual(intifaceDevices.get(4).axes.map((a) => a.role), ['off', 'primary']);
        setAxisRole(4, 1, 'off');
        assert.equal(testSingleAxis(4, 0, { min: 0, max: 90 }), false);
        assert.equal(ossmMessages(ws, 'ScalarCmd').length, 0);
        assert.equal(setAxisRole(4, 0, 'primary', { envelope: { min: 0, max: 100 } }), true);
    });

    it('stays at 0 if the envelope is narrowed while it is on', () => {
        const ws = connectWith([OSSM]);
        setAxisRole(4, 0, 'primary', { envelope: { min: 0, max: 100 } });
        dispatchIntiface(50, 0, 0, 100, 0, 100);
        assert.ok(ossmMessages(ws, 'ScalarCmd').at(-1).Scalars[0].Scalar > 0);
        dispatchIntiface(50, 0, 30, 70, 30, 70);
        assert.equal(ossmMessages(ws, 'ScalarCmd').at(-1).Scalars[0].Scalar, 0);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('keeps the slow Test for the OSSM\'s Oscillate only', () => {
        const HISMITH = {
            DeviceIndex: 7,
            DeviceName: 'Hismith Thrusting Cup',
            DeviceMessages: { ScalarCmd: [{ FeatureDescriptor: 'Stroker Oscillation Speed', StepCount: 100, ActuatorType: 'Oscillate' }], StopDeviceCmd: {} }
        };
        const ws = connectWith([HISMITH]);
        assert.equal(testSingleAxis(7, 0, { min: 20, max: 80 }), true, 'not an OSSM twin: the envelope rule is the OSSM\'s');
        assert.equal(ws.messages('ScalarCmd')[0].Scalars[0].Scalar, TEST_LEVEL);
        disconnectIntiface();
    });
});

describe('a rotator Intiface lists twice is driven once', () => {
    const NORA2 = {
        DeviceIndex: 8,
        DeviceName: 'Lovense Nora',
        DeviceMessages: {
            ScalarCmd: [{ FeatureDescriptor: '', StepCount: 20, ActuatorType: 'Vibrate' }, { FeatureDescriptor: '', StepCount: 20, ActuatorType: 'Rotate' }],
            RotateCmd: [{ FeatureDescriptor: '', StepCount: 20 }],
            StopDeviceCmd: {}
        }
    };

    it('drives the RotateCmd axis and sends the ScalarCmd Rotate nothing', () => {
        const ws = connectWith([NORA2]);
        const dev = intifaceDevices.get(8);
        assert.deepEqual(dev.axes.map((a) => [a.key, a.role, a.inert]), [['scalar:0', 'secondary', false], ['scalar:1', 'off', true], ['rotate:0', 'primary', false]]);
        assert.equal(setAxisRole(8, 1, 'primary'), false);
        dispatchIntiface(60, 60, 0, 100);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
        assert.ok(ws.messages('ScalarCmd').every((m) => m.Scalars.every((x) => x.Index === 0)));
        assert.ok(ws.messages('RotateCmd').some((m) => m.Rotations[0].Speed > 0));
    });
});

describe('a cap on a stepped toy never keeps a toy that ran from running', () => {
    const SHARK = {
        DeviceIndex: 9,
        DeviceName: 'Libo Shark',
        DeviceMessages: { ScalarCmd: [{ StepCount: 3, ActuatorType: 'Vibrate' }, { StepCount: 3, ActuatorType: 'Vibrate' }], StopDeviceCmd: {} }
    };
    const levels = (ws) => ws.messages('ScalarCmd').filter((m) => m.DeviceIndex === 9).map((m) => [m.Scalars[0].Index, m.Scalars[0].Scalar]);

    it('runs a 3-step toy at its first step under a saved 30% cap, and keeps one under half of it off', () => {
        memory.set(INTIFACE_STORAGE_KEY, JSON.stringify({
            'Libo Shark|S:Vibrate,Vibrate|L:|R:': { axes: { 'scalar:0': { role: 'primary', maxCap: 30 }, 'scalar:1': { role: 'primary', maxCap: 10 } } }
        }));
        const ws = connectWith([SHARK]);
        dispatchIntiface(100, 0, 0, 100);
        const last = Object.fromEntries(levels(ws));
        assert.equal(last[0], 1 / 3, 'the strict cap sent this toy 0 for ever');
        assert.equal(last[1], 0, 'under half its first step it never ran: it stays off');
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('takes a cap chosen as a step and gives the toy exactly that step', () => {
        const ws = connectWith([SHARK]);
        setAxisMaxCap(9, 0, capStepPercent(2, 3));
        dispatchIntiface(100, 0, 0, 100);
        assert.equal(Object.fromEntries(levels(ws))[0], 2 / 3);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });
});

describe('a held axis is never sent the same step twice and never left idle mid-leg', () => {
    it('refuses a Test that would repeat where a stop left it', () => {
        const ws = connectWith([OSSM]);
        // A fast leg is one segment: the stop lands with 70 the last step sent.
        dispatchIntiface(100, 0, 30, 70, 30, 70);
        dispatchIntiface(0, 0, 0, 100, 30, 70, true);
        assert.deepEqual(ossmLegs(ws).map((l) => l.step), [70]);
        testSingleAxis(4, 1, { min: 30, max: 70 });
        assert.deepEqual(ossmLegs(ws).map((l) => l.step), [70], 'the Test\'s first move would be 70 again');
        disconnectIntiface();
    });

    it('folds segments that land on one step, so the motion does not stop between them', async () => {
        // Intiface lets a user limit a device's range; this OSSM is left 10 steps.
        const COARSE = { ...OSSM, DeviceMessages: { ...OSSM.DeviceMessages, LinearCmd: [{ FeatureDescriptor: '', StepCount: 10, ActuatorType: 'Position' }] } };
        const ws = connectWith([COARSE]);
        dispatchIntiface(5, 0, 30, 70, 0, 100);
        await sleep(3500);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
        const legs = ws.sent.flatMap((frame, i) => frame.filter((m) => m.LinearCmd).map((m) => ({ step: Math.round(10 * m.LinearCmd.Vectors[0].Position), ms: m.LinearCmd.Vectors[0].Duration, at: ws.at[i] })));
        legs.forEach((l, i) => { if (i) assert.notEqual(l.step, legs[i - 1].step); });
        let checked = 0;
        for (let i = 1; i < legs.length - 1; i++) {
            const sameWay = Math.sign(legs[i].step - legs[i - 1].step) === Math.sign(legs[i + 1].step - legs[i].step);
            if (!sameWay) continue;
            assert.ok(Math.abs(legs[i + 1].at - (legs[i].at + legs[i].ms)) < 60, `segment ${i} ran ${legs[i].ms} ms, the next came ${legs[i + 1].at - legs[i].at} ms later`);
            checked += 1;
        }
        assert.ok(checked >= 2, `${checked} segment joints checked`);
    });
});

describe('nothing a Test or a yielded twin still had due goes out after a stop', () => {
    for (const [name, stop] of [
        ['STOP', () => dispatchIntiface(0, 0, 0, 100, 20, 80, true)],
        ['page-away', () => { stopAllIntiface(); dispatchIntiface(0, 0, 0, 100, 20, 80, true); }],
        ['OFF', () => setAxisRole(4, 1, 'off')]
    ]) {
        it(`a Test on the OSSM, then ${name}: the Test's second move never goes out`, async () => {
            const ws = connectWith([OSSM]);
            assert.equal(testSingleAxis(4, 1, { min: 20, max: 80 }), true);
            await sleep(200);
            const at = ossmLegs(ws).length;
            assert.equal(at, 1, 'the first move of the Test');
            stop();
            await sleep(INTIFACE_TIMINGS.testMoveMs + 300);
            assert.equal(ossmLegs(ws).length, at);
        });
    }

    it('a Test on an OSR2, then STOP: the rest move, and not the Test\'s second move after it', async () => {
        const ws = connectWith([OSR2]);
        assert.equal(testSingleAxis(1, 0, { min: 20, max: 80 }), true);
        await sleep(200);
        dispatchIntiface(0, 0, 0, 100, 20, 80, true);
        const at = ws.messages('LinearCmd').length;
        await sleep(INTIFACE_TIMINGS.testMoveMs + 300);
        assert.equal(ws.messages('LinearCmd').length, at);
        assert.equal(ws.messages('LinearCmd').at(-1).Vectors[0].Duration, REST_MOVE_MS);
    });

    for (const [name, stop] of [['OFF', () => setAxisRole(1, 0, 'off')], ['page-away', () => stopAllIntiface()]]) {
        it(`a Test on an OSR2, then ${name}: not the Test's second move`, async () => {
            const ws = connectWith([OSR2]);
            testSingleAxis(1, 0, { min: 20, max: 80 });
            await sleep(200);
            stop();
            const at = ws.messages('LinearCmd').length;
            await sleep(INTIFACE_TIMINGS.testMoveMs + 300);
            assert.equal(ws.messages('LinearCmd').length, at);
        });
    }

    it('a Test on the OSSM survives an idle page\'s zeros, and ends with a session\'s cut', async () => {
        let ws = connectWith([OSSM]);
        testSingleAxis(4, 1, { min: 20, max: 80 });
        await sleep(100);
        dispatchIntiface(0, 0, 0, 100, 20, 80);
        await sleep(INTIFACE_TIMINGS.testMoveMs + 200);
        assert.equal(ossmLegs(ws).length, 2, 'an idle page dispatches zeros on every heart-rate reading: the Test still comes back');
        resetIntifaceForTests();
        memory.clear();
        ws = connectWith([OSSM]);
        testSingleAxis(4, 1, { min: 20, max: 80 });
        await sleep(50);
        dispatchIntiface(60, 0, 30, 70, 20, 80);
        await sleep(50);
        dispatchIntiface(0, 0, 0, 100, 20, 80);
        const at = ossmLegs(ws).length;
        await sleep(INTIFACE_TIMINGS.testMoveMs + 200);
        assert.equal(ossmLegs(ws).length, at, 'the cut holds the OSSM; the Test does not move it afterwards');
    });

    it('a Position segment still due when Oscillate takes over never goes out', async () => {
        const ws = connectWith([OSSM]);
        dispatchIntiface(5, 0, 30, 70, 0, 100);
        await sleep(2600);
        const at = ossmLegs(ws).length;
        assert.equal(setAxisRole(4, 0, 'primary', { envelope: { min: 0, max: 100 } }), true);
        await sleep(600);
        assert.equal(ossmLegs(ws).length, at, 'a segment after the switch would send the OSSM back to position mode');
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('a cap chosen as any step of a 15-step toy gives exactly that step', () => {
        const DOT = { DeviceIndex: 10, DeviceName: 'Fifteen', DeviceMessages: { ScalarCmd: [{ StepCount: 15, ActuatorType: 'Vibrate' }], StopDeviceCmd: {} } };
        const ws = connectWith([DOT]);
        for (let k = 2; k <= 15; k++) {
            setAxisMaxCap(10, 0, capStepPercent(k, 15));
            dispatchIntiface(100, 0, 0, 100);
            const last = ws.messages('ScalarCmd').at(-1).Scalars[0].Scalar;
            assert.equal(Math.round(last * 15), k, `cap ${capStepPercent(k, 15)}% gave step ${Math.round(last * 15)}`);
        }
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });
});

// ---- Script mode -------------------------------------------------------------

// A script feed playing `actions` from now: media time 0 is the moment it is
// made, and the clock runs on the page's own performance.now().
function playingFeed(actions, { settings = {} } = {}) {
    const feed = createScriptFeed({ clock: createMediaClock({ maxExtrapolateMs: Infinity }) });
    feed.setTrack({
        at: Int32Array.from(actions.map(([t]) => t)),
        pos: Uint8Array.from(actions.map(([, p]) => p))
    });
    feed.setSettings(settings);
    feed.setVideoState('playing');
    feed.sample({ mediaMs: 0, perfMs: performance.now(), source: 'frame' });
    return feed;
}

// 0 and 100 in turn every `every` ms for `seconds`.
function beat(every, seconds = 30) {
    const out = [];
    for (let t = 0, i = 0; t <= seconds * 1000; t += every, i += 1) out.push([t, i % 2 ? 100 : 0]);
    return out;
}

function linearTo(ws, deviceIndex) {
    const out = [];
    ws.sent.forEach((frame, i) => frame.forEach((m) => {
        if (m.LinearCmd && m.LinearCmd.DeviceIndex === deviceIndex) {
            m.LinearCmd.Vectors.forEach((v) => out.push({ index: v.Index, pos: v.Position, ms: v.Duration, at: ws.at[i] }));
        }
    }));
    return out;
}

describe('Script mode: a primary linear axis plays the script', () => {
    afterEach(() => setIntifaceScriptFeed(null));

    it('strokes on the script\'s beat inside the travel envelope, through the script planner', async () => {
        const ws = connectWith([OSR2]);
        const feed = playingFeed(beat(400));
        setIntifaceScriptFeed(feed);
        // Loaded but not driving: the stroke planner, as in every mode.
        dispatchIntiface(100, 60, 20, 80, 20, 80);
        assert.equal(intifaceAxisPlanner(1, 0), 'stroke');
        dispatchIntiface(0, 0, 0, 100, 20, 80, true);
        await sleep(450);
        const before = linearTo(ws, 1).length;
        feed.setActive(true);
        dispatchIntiface(100, 60, 20, 80, 20, 80);
        assert.equal(intifaceAxisPlanner(1, 0), 'script');
        await sleep(2600);
        const legs = linearTo(ws, 1).slice(before);
        assert.ok(legs.length >= 5, `${legs.length} legs`);
        assert.ok(legs.every((l) => l.pos >= 0.2 - 1e-9 && l.pos <= 0.8 + 1e-9), legs.map((l) => l.pos).join(' '));
        // After the join, every leg runs to the next beat: about 400 ms, and
        // the turns land at the envelope's ends.
        const steady = legs.slice(2);
        assert.ok(steady.every((l) => l.ms >= 340 && l.ms <= 400), steady.map((l) => l.ms).join(' '));
        assert.ok(steady.every((l) => Math.abs(l.pos - 0.2) < 0.002 || Math.abs(l.pos - 0.8) < 0.002), steady.map((l) => l.pos).join(' '));
        // STOP: StopAllDevices and the usual rest move to the envelope's bottom.
        const stopAt = linearTo(ws, 1).length;
        dispatchIntiface(0, 0, 0, 100, 20, 80, true);
        assert.equal(ws.messages('StopAllDevices').length, 2);
        const rest = linearTo(ws, 1).slice(stopAt);
        assert.deepEqual(rest.map((l) => [l.pos, l.ms]), [[0.2, REST_MOVE_MS]]);
        await sleep(900);
        assert.equal(linearTo(ws, 1).length, stopAt + 1, 'then silence');
    });

    it('skips at the edge (allowance 0) with the rest move, and rejoins when the allowance comes back', async () => {
        const ws = connectWith([OSR2]);
        const feed = playingFeed(beat(400));
        feed.setActive(true);
        setIntifaceScriptFeed(feed);
        dispatchIntiface(100, 60, 0, 100, 0, 100);
        await sleep(1200);
        const at = linearTo(ws, 1).length;
        dispatchIntiface(0, 0, 0, 100, 0, 100, false, { urgent: true });
        const cut = linearTo(ws, 1).slice(at);
        assert.deepEqual(cut.map((l) => [l.pos, l.ms]), [[0, REST_MOVE_MS]], 'the rest move goes out with the cut');
        assert.equal(ws.messages('StopAllDevices').length, 0, 'a skip is not STOP');
        await sleep(800);
        assert.equal(linearTo(ws, 1).length, at + 1, 'nothing while skipping; the video plays on');
        assert.equal(feed.hasTime(), true);
        dispatchIntiface(40, 24, 0, 100, 0, 100);
        await sleep(1500);
        const back = linearTo(ws, 1).slice(at + 1);
        assert.ok(back.length >= 2, 'strokes again');
        // From the rest at 0, the join comes at no more than half the limit.
        assert.ok(back[0].pos / back[0].ms <= 300 / 100 / 1000 / 2 + 1e-9, JSON.stringify(back[0]));
        // The allowance at 40%: every stroke is shortened to 40% of the travel.
        assert.ok(back.every((l) => l.pos <= 0.4 + 1e-9), back.map((l) => l.pos).join(' '));
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('a seek interrupts the leg in flight at once, and the axis rejoins once the video plays', async () => {
        const ws = connectWith([OSR2]);
        // Slow strokes: a leg lasts most of two seconds.
        const feed = playingFeed(beat(1800), { settings: { scriptMaxSpeed: 600 } });
        feed.setActive(true);
        setIntifaceScriptFeed(feed);
        dispatchIntiface(100, 0, 0, 100, 0, 100);
        await sleep(2300);
        const at = linearTo(ws, 1).length;
        feed.setVideoState('seeking');
        const cut = linearTo(ws, 1).slice(at);
        assert.deepEqual(cut.map((l) => [l.pos, l.ms]), [[0, REST_MOVE_MS]], 'rests now, not at the leg\'s end');
        await sleep(600);
        assert.equal(linearTo(ws, 1).length, at + 1);
        // Scrubbed to 8 s, where the script climbs from the bottom (7.2 s)
        // to the top (9 s): the axis, resting at the bottom, joins it there.
        feed.setVideoState('playing');
        feed.sample({ mediaMs: 8000, perfMs: performance.now(), source: 'frame' });
        await sleep(100);
        const join = linearTo(ws, 1).slice(at + 1);
        assert.equal(join.length, 1, 'playing again');
        assert.equal(join[0].pos, 1);
        assert.ok(join[0].ms >= 900 && join[0].ms <= 1000, `${join[0].ms}`);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('sends nothing while the script holds where the axis is (idle legs)', async () => {
        const ws = connectWith([OSR2]);
        // To the top, held there from 0.6 s to 3 s, then down.
        const feed = playingFeed([[0, 0], [600, 100], [3000, 100], [3400, 0], [3800, 100]]);
        feed.setActive(true);
        setIntifaceScriptFeed(feed);
        dispatchIntiface(100, 0, 0, 100, 0, 100);
        await sleep(1400);
        const during = linearTo(ws, 1).length;
        await sleep(1300);
        assert.equal(linearTo(ws, 1).length, during, 'not one command during the hold');
        await sleep(900);
        const after = linearTo(ws, 1).slice(during);
        assert.ok(after.some((l) => l.pos === 0), 'and the stroke after it goes out');
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('only the primary role plays the script; the secondary keeps its stroke planner, and Script mode off hands the axis back', async () => {
        const ws = connectWith([SR6]);
        setAxisRole(3, 0, 'primary');
        setAxisRole(3, 1, 'secondary');
        const feed = playingFeed(beat(400));
        feed.setActive(true);
        setIntifaceScriptFeed(feed);
        dispatchIntiface(100, 60, 0, 100, 0, 100);
        // The role change rested the axis (setAxisRole); it changes hands
        // when that rest move ends.
        await sleep(REST_MOVE_MS + 50);
        assert.equal(intifaceAxisPlanner(3, 0), 'script');
        assert.equal(intifaceAxisPlanner(3, 1), 'stroke');
        await sleep(450);
        feed.setActive(false);
        // The leg in flight runs out; the axis changes hands at its end.
        assert.equal(intifaceAxisPlanner(3, 0), 'script');
        await sleep(700);
        assert.equal(intifaceAxisPlanner(3, 0), 'stroke');
        const l0 = linearTo(ws, 3).filter((l) => l.index === 0);
        assert.ok(l0.length >= 3);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('with no feed, or a feed that is not driving, nothing changes', () => {
        const ws = connectWith([OSR2]);
        dispatchIntiface(100, 0, 20, 80);
        assert.equal(intifaceAxisPlanner(1, 0), 'stroke');
        assert.equal(ws.messages('LinearCmd')[0].Vectors[0].Position, 0.8);
        setIntifaceScriptFeed(playingFeed(beat(400)));
        dispatchIntiface(100, 0, 20, 80);
        assert.equal(intifaceAxisPlanner(1, 0), 'stroke');
        assert.equal(intifaceAxisPlanner(1, 7), null);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });

    it('a vibrator follows the allowance as a level', () => {
        const ws = connectWith([EDGE]);
        setAxisRole(0, 0, 'primary');
        const feed = playingFeed(beat(400));
        feed.setActive(true);
        setIntifaceScriptFeed(feed);
        dispatchIntiface(65, 40, 0, 100, 0, 100);
        const levels = ws.messages('ScalarCmd').flatMap((c) => c.Scalars.map((x) => x.Scalar));
        assert.ok(levels.includes(0.65), levels.join(' '));
        assert.equal(intifaceAxisPlanner(0, 0), null);
        dispatchIntiface(0, 0, 0, 100, 0, 100, true);
    });
});

describe('Script mode on an OSSM: it holds where it stops', () => {
    afterEach(() => setIntifaceScriptFeed(null));

    it('plays the script as one-way segments of at most 200 ms, never the same step twice, and holds on a skip', async () => {
        const ws = connectWith([OSSM]);
        const feed = playingFeed(beat(700), { settings: { scriptMaxSpeed: 200 } });
        feed.setActive(true);
        setIntifaceScriptFeed(feed);
        dispatchIntiface(100, 0, 20, 80, 20, 80);
        assert.equal(intifaceAxisPlanner(4, 1), 'script');
        await sleep(3000);
        const legs = ossmLegs(ws);
        assert.ok(legs.length >= 8, `${legs.length}`);
        const later = legs.slice(1);
        assert.ok(later.every((l) => l.ms <= HELD_SEGMENT_MS), later.map((l) => l.ms).join(' '));
        legs.forEach((l, i) => { if (i) assert.notEqual(l.step, legs[i - 1].step, `repeat at ${i}`); });
        assert.ok(legs.every((l) => l.step >= 20 && l.step <= 80));
        // One way between turns, and only at the envelope's ends does it turn.
        for (let i = 1; i < later.length - 1; i++) {
            const turn = Math.sign(later[i].step - later[i - 1].step) !== Math.sign(later[i + 1].step - later[i].step);
            if (turn) assert.ok([20, 80].includes(later[i].step), `turned at ${later[i].step}: ${later.map((l) => l.step).join(' ')}`);
        }
        // A skip: nothing more, no rest move.
        dispatchIntiface(0, 0, 20, 80, 20, 80, false, { urgent: true });
        const held = ossmLegs(ws).length;
        await sleep(900);
        assert.equal(ossmLegs(ws).length, held, 'held where it is');
        // Back from the hold: from where it stopped, never its last step again.
        dispatchIntiface(100, 0, 20, 80, 20, 80);
        await sleep(1200);
        const again = ossmLegs(ws);
        assert.ok(again.length > held);
        again.forEach((l, i) => { if (i) assert.notEqual(l.step, again[i - 1].step, `repeat at ${i}`); });
        dispatchIntiface(0, 0, 0, 100, 20, 80, true);
        const stopped = ossmLegs(ws).length;
        await sleep(600);
        assert.equal(ossmLegs(ws).length, stopped, 'STOP: no rest move either');
    });
});
