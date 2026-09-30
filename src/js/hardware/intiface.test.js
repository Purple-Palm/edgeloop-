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

const sockets = [];

class FakeSocket {
    constructor(url) {
        if (!/^wss?:\/\//.test(url)) throw new SyntaxError(`Failed to construct 'WebSocket': The URL '${url}' is invalid.`);
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.closed = false;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        sockets.push(this);
    }
    send(data) {
        if (this.readyState !== 1) throw new Error('not open');
        this.sent.push(JSON.parse(data));
    }
    close() {
        this.closed = true;
        this.readyState = 3;
    }
    // test helpers
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    receive(msgs) { if (this.onmessage) this.onmessage({ data: JSON.stringify(Array.isArray(msgs) ? msgs : [msgs]) }); }
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
