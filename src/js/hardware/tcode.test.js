// Driver tests with a fake Web Serial port built on the standard streams
// (ReadableStream / WritableStream). No real hardware, no DOM.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    TCODE_TIMINGS,
    TCODE_STORAGE_KEY,
    connectTCode,
    disconnectTCode,
    dispatchTCode,
    stopTCode,
    setAxisRole,
    setAxisCap,
    setAxisInvert,
    testAxis,
    saveTCodeConfig,
    isTCodeConnected,
    isSerialSupported,
    getTCodeStatus,
    getTCodeDevice,
    countAssignedTCodeAxes,
    tcodeHasRole,
    resetTCodeForTests
} from './tcode.js';
import { REST_MOVE_MS, FAST_LEG_MS, legDurationMs } from './stroke-planner.js';
import { setTCodeScriptFeed, tcodeAxisPlanner } from './tcode.js';
import { createScriptFeed } from '../player/script-feed.js';
import { createMediaClock } from '../player/media-clock.js';

const OSR_REPLIES = {
    D0: ['OSR2 Test Rig'],
    D1: ['TCode v0.3'],
    D2: ['L0 stroke', 'R0 twist', 'R1 roll', 'V0 vibe']
};
const SR6_REPLIES = {
    D0: ['SR6'],
    D1: ['TCode v0.3'],
    D2: ['L0 stroke', 'L1 surge', 'L2 sway', 'R0 twist', 'R1 roll', 'R2 pitch', 'V0 vibe']
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Writes go through a promise chain: let them land on the fake port.
function flush() {
    return sleep(3);
}

// A SerialPort stand-in. Writes are decoded and, when they match a reply
// table, answered on the readable side; the test can also push bytes,
// close or error the readable stream and fire 'disconnect'.
function makeFakePort(replies = OSR_REPLIES) {
    const written = [];
    const listeners = {};
    let enqueue = null;
    let closeReadable = null;
    let errorReadable = null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const readable = new ReadableStream({
        start(controller) {
            enqueue = (text) => { try { controller.enqueue(encoder.encode(text)); } catch (e) {} };
            closeReadable = () => { try { controller.close(); } catch (e) {} };
            errorReadable = (err) => { try { controller.error(err); } catch (e) {} };
        }
    });
    const port = {
        readable: null,
        writable: null,
        opened: false,
        closed: false,
        openOptions: null,
        failWrites: false,
        written,
        async open(options) {
            this.openOptions = options;
            this.opened = true;
        },
        async close() {
            this.closed = true;
        },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
        fire(type) { (listeners[type] || []).forEach((fn) => fn({ target: port })); },
        listenerCount(type) { return (listeners[type] || []).length; },
        push(text) { enqueue(text); },
        closeReadable() { closeReadable(); },
        errorReadable(err) { errorReadable(err); }
    };
    port.readable = readable;
    port.writable = new WritableStream({
        write(chunk) {
            if (port.failWrites) throw new Error('device gone');
            const text = decoder.decode(chunk);
            written.push(text);
            const cmd = text.trim();
            // A reply table entry may be a function (answers can differ per query).
            const reply = replies && typeof replies[cmd] === 'function' ? replies[cmd]() : (replies ? replies[cmd] : null);
            if (reply) reply.forEach((line) => enqueue(`${line}\n`));
        }
    });
    return port;
}

let port = null;
let serialListeners = {};
let requestPortImpl = null;
let store = {};
let events = { status: [], changed: 0, close: [], errors: [] };

function installNavigator({ serial = true, userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/128' } = {}) {
    const value = { userAgent };
    if (serial) {
        value.serial = {
            requestPort: () => requestPortImpl(),
            addEventListener(type, fn) { (serialListeners[type] ||= []).push(fn); },
            removeEventListener(type, fn) { serialListeners[type] = (serialListeners[type] || []).filter((f) => f !== fn); }
        };
    }
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

function installStorage() {
    store = {};
    globalThis.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
    };
}

function handlers() {
    return {
        onStatus: (s) => events.status.push(s),
        onDevicesChanged: () => { events.changed += 1; },
        onClose: (info) => events.close.push(info),
        onError: (text) => events.errors.push(text)
    };
}

function lines() {
    return port.written.map((w) => w.trim());
}

function lastLine() {
    const all = lines();
    return all[all.length - 1];
}

// Connect and wait for the post-connect rest move to finish, so every axis
// is free for the next command.
async function connect(replies = OSR_REPLIES) {
    port = makeFakePort(replies);
    requestPortImpl = async () => port;
    const ok = await connectTCode(handlers());
    await sleep(TCODE_TIMINGS.restMs + 5);
    return ok;
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalStorage = globalThis.localStorage;

beforeEach(() => {
    resetTCodeForTests();
    TCODE_TIMINGS.bootQuietMs = 10;
    TCODE_TIMINGS.bootCapMs = 40;
    TCODE_TIMINGS.identifyMs = 40;
    TCODE_TIMINGS.replyQuietMs = 15;
    TCODE_TIMINGS.restMs = 30;
    TCODE_TIMINGS.testMoveMs = 20;
    TCODE_TIMINGS.testHoldMs = 20;
    TCODE_TIMINGS.closeGraceMs = 50;
    serialListeners = {};
    events = { status: [], changed: 0, close: [], errors: [] };
    installNavigator();
    installStorage();
});

afterEach(async () => {
    await disconnectTCode();
    resetTCodeForTests();
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    globalThis.localStorage = originalStorage;
});

describe('feature detection', () => {
    it('reports the supporting browsers when Web Serial is missing', async () => {
        installNavigator({ serial: false, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0' });
        assert.equal(isSerialSupported(), false);
        const ok = await connectTCode(handlers());
        assert.equal(ok, false);
        assert.equal(getTCodeStatus().state, 'error');
        assert.match(getTCodeStatus().text, /Firefox does not implement Web Serial/);
        assert.match(getTCodeStatus().text, /Chrome and Edge on a desktop/);
        assert.equal(isTCodeConnected(), false);
    });
    it('turns a cancelled chooser and a busy port into readable status text', async () => {
        requestPortImpl = async () => { const e = new Error('no port'); e.name = 'NotFoundError'; throw e; };
        assert.equal(await connectTCode(handlers()), false);
        assert.match(getTCodeStatus().text, /No port selected/);

        port = makeFakePort();
        port.open = async () => { const e = new Error('Failed to open serial port.'); e.name = 'NetworkError'; throw e; };
        requestPortImpl = async () => port;
        assert.equal(await connectTCode(handlers()), false);
        assert.match(getTCodeStatus().text, /Close Intiface Central/);
        assert.match(getTCodeStatus().text, /dialout/);
        assert.equal(isTCodeConnected(), false);
    });
});

describe('connect and identify', () => {
    it('opens at 115200 8N1, identifies the device and rests every axis', async () => {
        assert.equal(await connect(), true);
        assert.deepEqual(port.openOptions, { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
        assert.equal(isTCodeConnected(), true);
        const dev = getTCodeDevice();
        assert.equal(dev.name, 'OSR2 Test Rig');
        assert.equal(dev.version, 'TCode v0.3');
        assert.equal(dev.identified, true);
        assert.deepEqual(dev.axes.map((a) => a.id), ['L0', 'R0', 'R1', 'V0']);
        assert.deepEqual(dev.axes.map((a) => a.role), ['primary', 'off', 'off', 'secondary']);
        assert.deepEqual(dev.axes.map((a) => a.kind), ['linear', 'rotate', 'rotate', 'vibe']);
        assert.equal(countAssignedTCodeAxes(), 2);
        assert.equal(tcodeHasRole('primary'), true);
        assert.equal(tcodeHasRole('secondary'), true);
        assert.deepEqual(lines().slice(0, 3), ['D0', 'D1', 'D2']);
        // The first motion line is the rest move on one line.
        assert.equal(lines()[3], `L00000I${TCODE_TIMINGS.restMs} R05000I${TCODE_TIMINGS.restMs} R15000I${TCODE_TIMINGS.restMs} V00000`);
        assert.equal(getTCodeStatus().state, 'connected');
        assert.match(getTCodeStatus().text, /OSR2 Test Rig, TCode v0\.3/);
        assert.deepEqual(events.status.map((s) => s.state), ['connecting', 'connecting', 'handshake', 'handshake', 'connected']);
        assert.equal(port.listenerCount('disconnect'), 1);
    });
    it('falls back to the OSR2 axis set when the device stays silent', async () => {
        const started = Date.now();
        assert.equal(await connect({}), true);
        const elapsed = Date.now() - started;
        // Settle, then D0 twice (a silent first query is retried), D1, D2.
        assert.ok(elapsed < 4 * TCODE_TIMINGS.identifyMs + TCODE_TIMINGS.bootCapMs + 200, `identification took ${elapsed} ms`);
        const dev = getTCodeDevice();
        assert.equal(dev.name, 'TCode device');
        assert.equal(dev.version, '');
        assert.equal(dev.identified, false);
        assert.deepEqual(dev.axes.map((a) => a.id), ['L0', 'R0', 'R1', 'R2', 'V0']);
        assert.equal(isTCodeConnected(), true);
    });
    it('names a silent device after its USB ids and keeps its settings apart', async () => {
        port = makeFakePort({});
        port.getInfo = () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
        requestPortImpl = async () => port;
        assert.equal(await connectTCode(handlers()), true);
        await sleep(TCODE_TIMINGS.restMs + 5);
        const dev = getTCodeDevice();
        assert.equal(dev.name, 'TCode device 1a86:7523');
        assert.equal(dev.identified, false);
        assert.match(getTCodeStatus().text, /TCode device 1a86:7523/);
        setAxisCap(0, 40);
        const saved = JSON.parse(store[TCODE_STORAGE_KEY]);
        assert.equal(saved['TCode device 1a86:7523'].axes.L0.maxCap, 40);
        assert.equal(saved['TCode device'], undefined);
        // A port whose getInfo() throws still connects under the plain name.
        await disconnectTCode();
        port = makeFakePort({});
        port.getInfo = () => { throw new Error('no info'); };
        assert.equal(await connectTCode(handlers()), true);
        await sleep(TCODE_TIMINGS.restMs + 5);
        assert.equal(getTCodeDevice().name, 'TCode device');
    });
    it('ignores a command echo and unsolicited chatter', async () => {
        assert.equal(await connect({ D0: ['D0', 'SR6'], D1: ['D1', 'v0.3'], D2: ['D2', 'L0 stroke', 'L1 surge', 'OK'] }), true);
        const dev = getTCodeDevice();
        assert.equal(dev.name, 'SR6');
        assert.equal(dev.version, 'v0.3');
        assert.deepEqual(dev.axes.map((a) => a.id), ['L0', 'L1']);
        port.push('debug: hello\nnoise\n');
        await sleep(5);
        assert.equal(isTCodeConnected(), true);
    });
});

describe('dispatch', () => {
    it('drives L0 one leg at a time and never re-sends mid-leg', async () => {
        await connect();
        const before = port.written.length;
        dispatchTCode(100, 0, 20, 80, 0, 100);
        await flush();
        assert.equal(port.written.length, before + 1);
        // From the rest position (0) to the zone top: an 80 % move, timed as such.
        const duration = legDurationMs(100, 0.8);
        assert.equal(lastLine(), `L08000I${duration}`);
        // Ticks while the leg is in flight change nothing.
        dispatchTCode(100, 0, 20, 80, 0, 100);
        dispatchTCode(90, 0, 20, 80, 0, 100);
        await flush();
        assert.equal(port.written.length, before + 1);
        await sleep(duration + 20);
        // The timer issued the return leg with the NEW speed applied.
        assert.equal(port.written.length, before + 2);
        assert.equal(lastLine(), `L02000I${legDurationMs(90, 0.6)}`);
    });
    it('a cut the engine decides rests L0 at once, not after the leg in flight', async () => {
        await connect();
        const stroke = () => lines().filter((l) => l.startsWith('L0'));
        // The crawl on the mark: a slow leg, over two seconds long.
        dispatchTCode(5, 40, 0, 100, 0, 100);
        await flush();
        const legs = stroke();
        assert.match(legs[legs.length - 1], /^L09999I\d+$/);
        assert.ok(Number(legs[legs.length - 1].split('I')[1]) > 2000);
        const before = port.written.length;
        // A slowdown that is not a stop waits for the leg.
        dispatchTCode(2, 40, 0, 100, 0, 100);
        await flush();
        assert.equal(port.written.length, before);
        // The stall guard cuts the primary on an ordinary dispatch: L0 rests
        // now, and the secondary vibration is left as it was.
        dispatchTCode(0, 40, 0, 100, 0, 100);
        await flush();
        assert.equal(port.written.length, before + 1);
        assert.equal(lastLine(), `L00000I${TCODE_TIMINGS.restMs}`);
        // Once, whatever the ticks after it say.
        dispatchTCode(0, 40, 0, 100, 0, 100);
        await sleep(TCODE_TIMINGS.restMs + 10);
        dispatchTCode(0, 40, 0, 100, 0, 100);
        await flush();
        assert.equal(port.written.length, before + 1);
    });
    it('an urgent dispatch re-times a planner axis\'s leg in flight; an ordinary one waits for the next leg', async () => {
        // L0 and the twist set to the secondary channel when the Ruin lockout
        // begins: the ride's 46% drops to 18% and the zone opens up.
        await connect();
        setAxisRole(0, 'secondary');
        setAxisRole(1, 'secondary');
        await sleep(TCODE_TIMINGS.restMs + 10);
        const axisLines = (id) => lines().filter((l) => l.startsWith(id));
        const interval = (line) => Number(line.split('I')[1]);
        const t0 = Date.now();
        dispatchTCode(46, 46, 5, 69, 0, 100);
        await flush();
        // From the rest at the bottom: 0.69 of travel.
        assert.equal(axisLines('L0').pop(), `L06900I${legDurationMs(46, 0.69)}`);
        assert.equal(axisLines('R0').pop(), `R07300I${legDurationMs(46, 1)}`);
        await sleep(60);
        const before = port.written.length;
        // The packet before the lockout, an ordinary change: the next leg's.
        dispatchTCode(0, 18, 0, 100, 0, 100);
        await flush();
        assert.deepEqual(port.written.slice(before).map((w) => w.trim()), ['V01800'], 'only the vibration takes it now');
        // The lockout's own dispatch, urgent: the rest of each leg, to the
        // same end, at 18%.
        dispatchTCode(0, 18, 0, 100, 0, 100, false, { urgent: true });
        await flush();
        const l0 = axisLines('L0').pop();
        const r0 = axisLines('R0').pop();
        assert.match(l0, /^L06900I\d+$/, 'no position the leg was not already on its way to');
        assert.match(r0, /^R07300I\d+$/);
        const leftL0 = t0 + legDurationMs(46, 0.69) - Date.now();
        assert.ok(interval(l0) > leftL0 && interval(l0) < legDurationMs(18, 0.69), `${l0} for what was left of ${leftL0} ms`);
        assert.ok(interval(r0) > t0 + legDurationMs(46, 1) - Date.now() && interval(r0) < legDurationMs(18, 1), r0);
        assert.equal(port.written.length, before + 3, 'the vibration once, each planner axis once');
        // Once: the same decision again has nothing left to re-time.
        dispatchTCode(0, 18, 0, 100, 0, 100, false, { urgent: true });
        await flush();
        assert.equal(port.written.length, before + 3);
        // L0's next leg comes when its re-timed leg ends, not the original.
        await sleep(leftL0 + 40);
        assert.equal(axisLines('L0').pop(), l0);
        await sleep(interval(l0) - leftL0);
        assert.equal(axisLines('L0').pop(), `L00000I${legDurationMs(18, 1)}`);
    });
    it('a re-timed leg goes where its leg was sent, not through an envelope changed since', async () => {
        // L0 inverted on the secondary channel, a travel envelope of 0-80:
        // the zone's bottom is the envelope's top, 80%. During that leg the
        // wearer raises the envelope's minimum to 20, then an urgent decision
        // re-times the leg. Mirrored through 20-80, the leg's end would have
        // become 100%, 20 points past the wearer's maximum.
        await connect();
        setAxisRole(0, 'secondary');
        setAxisInvert(0, true);
        await sleep(TCODE_TIMINGS.restMs + 10);
        const stroke = () => lines().filter((l) => l.startsWith('L0'));
        const leg = legDurationMs(60, 0.8);
        dispatchTCode(0, 60, 0, 80, 0, 80);
        await flush();
        assert.equal(stroke().pop(), `L00000I${leg}`, 'the zone top, mirrored to the envelope bottom');
        await sleep(leg + 10);
        assert.equal(stroke().pop(), `L08000I${leg}`, 'the zone bottom, mirrored to the envelope top');
        const edited = port.written.length;
        dispatchTCode(0, 60, 20, 80, 20, 80);
        dispatchTCode(0, 18, 20, 80, 20, 80, false, { urgent: true });
        await flush();
        const sent = port.written.slice(edited).map((w) => w.trim()).filter((l) => l.startsWith('L0'));
        assert.equal(sent.length, 1, 'the leg is re-timed, once');
        assert.match(sent[0], /^L08000I\d+$/, 'to 80%, where it was going');
        assert.ok(Number(sent[0].split('I')[1]) > leg - 20, `${sent[0]}: the rest of the leg at 18%`);
    });
    it('a re-timed leg goes where its leg was sent when the invert switch flips during it', async () => {
        // The wearer turns the sleeve over mid-stroke. Re-timed, the leg in
        // flight goes on up to the top at the new speed. Mirrored through the
        // new setting it was turned back down to the bottom: late in a leg,
        // three quarters of the travel in 120 ms, faster than any leg the
        // planner makes.
        await connect();
        setAxisRole(0, 'secondary');
        await sleep(TCODE_TIMINGS.restMs + 10);
        const stroke = () => lines().filter((l) => l.startsWith('L0'));
        const leg = legDurationMs(60, 1);
        dispatchTCode(0, 60, 0, 100, 0, 100);
        await flush();
        assert.equal(stroke().pop(), `L09999I${leg}`);
        await sleep(100);
        setAxisInvert(0, true);
        dispatchTCode(0, 95, 0, 100, 0, 100, false, { urgent: true });
        await flush();
        const retimed = stroke().pop();
        assert.match(retimed, /^L09999I\d+$/, 'on up to the top, not back down');
        assert.ok(Number(retimed.split('I')[1]) < leg - 100, `${retimed}: faster, as 95% asks`);
    });
    it('re-times a leg to the envelope\'s own bound, which an inverted axis reaches through float noise', async () => {
        // 0.2 + 0.8 - 0.8 is 0.19999999999999996: the leg to the bottom of a
        // 20-80 envelope is on its bound, and an urgent decision re-times it
        // like any other.
        await connect();
        setAxisRole(0, 'secondary');
        setAxisInvert(0, true);
        await sleep(TCODE_TIMINGS.restMs + 10);
        const stroke = () => lines().filter((l) => l.startsWith('L0'));
        // From the rest at 0: 0.8 of travel.
        const leg = legDurationMs(60, 0.8);
        dispatchTCode(0, 60, 20, 80, 20, 80);
        await flush();
        assert.equal(stroke().pop(), `L02000I${leg}`);
        await sleep(60);
        dispatchTCode(0, 18, 20, 80, 20, 80, false, { urgent: true });
        await flush();
        const retimed = stroke().pop();
        assert.match(retimed, /^L02000I\d+$/);
        assert.ok(Number(retimed.split('I')[1]) > leg, `${retimed}: re-timed at 18%`);
    });
    it('a leg the wearer has put outside the envelope runs out instead of being re-timed', async () => {
        // L0 and the twist on the secondary channel. During an upstroke to the
        // top the wearer lowers the envelope's maximum to 60, then the Ruin
        // lockout drops the secondary to 18%. Sent again, the leg would be a
        // new command to 100%, outside the envelope: it runs out as it was
        // sent, as a leg in flight always did when the envelope changed, and
        // the next leg, inside the envelope, carries the 18%. The twist
        // swings around the middle, which the envelope does not bound: it is
        // re-timed as ever.
        await connect();
        setAxisRole(0, 'secondary');
        setAxisRole(1, 'secondary');
        await sleep(TCODE_TIMINGS.restMs + 10);
        const axisLines = (id) => lines().filter((l) => l.startsWith(id));
        const leg = legDurationMs(70, 1);
        const t0 = Date.now();
        dispatchTCode(0, 70, 0, 100, 0, 100);
        await flush();
        assert.equal(axisLines('L0').pop(), `L09999I${leg}`);
        assert.equal(axisLines('R0').pop(), `R08500I${leg}`);
        await sleep(60);
        const edited = port.written.length;
        dispatchTCode(0, 70, 0, 60, 0, 60);
        dispatchTCode(0, 18, 0, 60, 0, 60, false, { urgent: true });
        await flush();
        const sent = port.written.slice(edited).map((w) => w.trim());
        assert.deepEqual(sent.filter((l) => l.startsWith('L0')), [], 'no new command to 100%');
        assert.match(sent.filter((l) => l.startsWith('R0')).join(' '), /^R08500I\d+$/, 'the twist is re-timed');
        await sleep(t0 + leg - Date.now() + 30);
        assert.equal(axisLines('L0').pop(), `L00000I${legDurationMs(18, 1)}`, 'the next leg, at 18%');
    });
    it('times what is left of a leg over what it covers on the device', async () => {
        // A narrow zone at the bottom of the envelope. The wearer turns the
        // sleeve over during a leg to 0.2: the next leg, the zone's bottom
        // mirrored to the top, takes the sleeve 0.8 of the travel in a leg
        // timed for the zone's 0.2. An urgent raise to 80% early in it times
        // what is left over the 0.8, at the planner's pace for 80%; over the
        // 0.2 it was the 120 ms floor, faster than any leg the planner makes.
        await connect();
        setAxisRole(0, 'secondary');
        await sleep(TCODE_TIMINGS.restMs + 10);
        const stroke = () => lines().filter((l) => l.startsWith('L0'));
        const leg = legDurationMs(10, 0.2);
        const t0 = Date.now();
        dispatchTCode(0, 10, 0, 20, 0, 100);
        await flush();
        assert.equal(stroke().pop(), `L02000I${leg}`);
        setAxisInvert(0, true);
        await sleep(t0 + leg - Date.now() + 5);
        assert.equal(stroke().pop(), `L09999I${leg}`, 'from 0.2 to the top on a leg timed for 0.2');
        const before = stroke().length;
        dispatchTCode(0, 80, 0, 20, 0, 100, false, { urgent: true });
        // The leg began no earlier than t0 + leg: at least this share of it
        // is left.
        const share = (leg - (Date.now() - t0 - leg)) / leg;
        await flush();
        assert.equal(stroke().length, before + 1, 'the leg is re-timed');
        const retimed = stroke().pop();
        assert.match(retimed, /^L09999I\d+$/);
        const interval = Number(retimed.split('I')[1]);
        assert.ok(interval >= Math.round(share * legDurationMs(80, 0.8)) - 1, `${retimed}: at least ${share.toFixed(2)} of a leg over 0.8 at 80%`);
    });
    it('times a leg after the Test button from where the test left the sleeve', async () => {
        // L0 rests at 0.9, then the Test button takes it to the top and back
        // to the bottom. The next leg goes from the bottom to the top of a
        // zone at 0.8-1.0: the whole travel on a leg timed for the zone's
        // 0.2, and an urgent raise times what is left of it over the whole
        // travel - not from the rest, nor from the top of the test.
        await connect();
        const stroke = () => lines().filter((l) => l.startsWith('L0'));
        dispatchTCode(0, 0, 0, 100, 90, 100, true);
        await flush();
        assert.match(stroke().pop(), new RegExp(`^L09000I${TCODE_TIMINGS.restMs}`));
        await sleep(TCODE_TIMINGS.restMs + 10);
        dispatchTCode(0, 0, 0, 100, 0, 100);
        assert.equal(testAxis(0), true);
        await sleep(3 * TCODE_TIMINGS.testMoveMs + 100);
        assert.deepEqual(stroke().slice(-2), [`L09999I${TCODE_TIMINGS.testMoveMs}`, `L00000I${TCODE_TIMINGS.testMoveMs}`]);
        const leg = legDurationMs(10, 0.2);
        const t0 = Date.now();
        dispatchTCode(10, 0, 80, 100, 0, 100);
        await flush();
        assert.equal(stroke().pop(), `L09999I${leg}`);
        await sleep(40);
        const before = stroke().length;
        dispatchTCode(80, 0, 80, 100, 0, 100, false, { urgent: true });
        const share = (leg - (Date.now() - t0)) / leg;
        await flush();
        assert.equal(stroke().length, before + 1, 'the leg is re-timed');
        const retimed = stroke().pop();
        assert.match(retimed, /^L09999I\d+$/);
        const interval = Number(retimed.split('I')[1]);
        assert.ok(interval >= Math.round(share * legDurationMs(80, 1)) - 1, `${retimed}: at least ${share.toFixed(2)} of a leg over the whole travel at 80%`);
    });
    it('feeds the secondary channel to V0 and deduplicates', async () => {
        await connect();
        dispatchTCode(0, 50, 0, 100, 0, 100);
        await flush();
        assert.ok(lines().includes('V05000'), lines().join(' | '));
        const count = port.written.length;
        dispatchTCode(0, 50, 0, 100, 0, 100);
        await flush();
        assert.equal(port.written.length, count, 'identical scalar was re-sent');
        dispatchTCode(0, 0, 0, 100, 0, 100);
        await flush();
        assert.equal(lastLine(), 'V00000');
    });
    it('swings a rotation axis around the centre by speed and cap', async () => {
        await connect();
        assert.equal(setAxisRole(1, 'primary'), true);
        setAxisCap(1, 50);
        await sleep(TCODE_TIMINGS.restMs + 5);
        dispatchTCode(100, 0, 0, 100, 0, 100);
        await flush();
        // amplitude 0.5 * 1.0 * 0.5 = 0.25 -> zone 0.25..0.75; effective speed
        // 50 %; the swing period follows the speed alone, not the amplitude
        const rot = lines().filter((l) => l.startsWith('R0'));
        assert.equal(rot[rot.length - 1], `R07500I${legDurationMs(50, 1)}`);
    });
    it('applies the cap and the invert flag to linear axes', async () => {
        await connect();
        setAxisCap(0, 50);
        setAxisInvert(0, true);
        dispatchTCode(100, 0, 0, 100, 0, 100);
        await flush();
        // effective speed 50 % over full travel; inverted: 1 - 1 = 0
        assert.equal(lastLine(), `L00000I${legDurationMs(50, 1)}`);
    });
    it('invert mirrors inside the hardware envelope, never below its lower guard', async () => {
        await connect();
        setAxisInvert(0, true);
        dispatchTCode(100, 0, 20, 90, 20, 90);
        await flush();
        // zone max 0.9 mirrored inside 0.2..0.9 -> 0.2, never 0.1 (from rest 0: a 90 % move)
        assert.equal(lastLine(), `L02000I${legDurationMs(100, 0.9)}`);
        stopTCode();
        await flush();
        // rest = envelope min 0.2 mirrored -> 0.9
        assert.match(lastLine(), new RegExp(`^L09000I${TCODE_TIMINGS.restMs} `));
    });
    it('clamps the zone into the hardware envelope', async () => {
        await connect();
        dispatchTCode(100, 0, 0, 100, 10, 90);
        await flush();
        assert.equal(lastLine(), `L09000I${legDurationMs(100, 0.9)}`);
    });
    it('a rotation axis swings slower, not faster, at a low speed', async () => {
        await connect();
        assert.equal(setAxisRole(1, 'primary'), true);
        await sleep(TCODE_TIMINGS.restMs + 5);
        dispatchTCode(10, 0, 0, 100, 0, 100);
        await flush();
        const rot = lines().filter((l) => l.startsWith('R0'));
        const slow = Number(rot[rot.length - 1].split('I')[1]);
        assert.equal(slow, legDurationMs(10, 1));
        assert.ok(slow > legDurationMs(50, 1));
    });
    it('role OFF mid-leg rests the axis at once instead of after the running stroke', async () => {
        await connect();
        dispatchTCode(5, 0, 0, 100, 0, 100);
        await flush();
        assert.equal(lastLine(), `L09999I${legDurationMs(5, 1)}`);
        const before = port.written.length;
        setAxisRole(0, 'off');
        await flush();
        assert.equal(port.written.length, before + 1, 'the rest line is written without waiting for the leg');
        assert.equal(lastLine(), `L00000I${TCODE_TIMINGS.restMs}`);
        await sleep(TCODE_TIMINGS.restMs + 10);
        assert.equal(port.written.length, before + 1, 'and nothing after it');
    });
    it('rests an axis whose role is switched OFF', async () => {
        await connect();
        dispatchTCode(0, 60, 0, 100, 0, 100);
        await flush();
        assert.equal(lastLine(), 'V06000');
        setAxisRole(3, 'off');
        await flush();
        assert.equal(lastLine(), 'V00000');
        assert.equal(countAssignedTCodeAxes(), 1);
    });
    it('never throws when nothing is connected', () => {
        assert.doesNotThrow(() => dispatchTCode(100, 100, 0, 100, 0, 100));
        assert.doesNotThrow(() => dispatchTCode('x', null, undefined, NaN));
        assert.equal(stopTCode(), false);
        assert.equal(setAxisRole(0, 'primary'), false);
        assert.equal(testAxis(0), false);
    });
});

describe('surge and sway', () => {
    it('rest at the mechanical centre on connect and on STOP, never in a corner', async () => {
        assert.equal(await connect(SR6_REPLIES), true);
        const r = TCODE_TIMINGS.restMs;
        assert.deepEqual(getTCodeDevice().axes.map((a) => a.role), ['primary', 'off', 'off', 'off', 'off', 'off', 'secondary']);
        assert.equal(lines()[3], `L00000I${r} L15000I${r} L25000I${r} R05000I${r} R15000I${r} R25000I${r} V00000`);
        dispatchTCode(100, 0, 0, 100, 20, 90);
        await flush();
        stopTCode();
        await flush();
        assert.equal(lastLine(), `L02000I${r} L15000I${r} L25000I${r} R05000I${r} R15000I${r} R25000I${r} V00000`);
    });
    it('an assigned surge axis swings around the centre like a rotation axis', async () => {
        assert.equal(await connect(SR6_REPLIES), true);
        assert.equal(setAxisRole(1, 'primary'), true);
        setAxisCap(1, 50);
        await sleep(TCODE_TIMINGS.restMs + 5);
        dispatchTCode(100, 0, 20, 80, 0, 100);
        await flush();
        const surge = lines().filter((l) => l.startsWith('L1'));
        // amplitude 0.25 around 0.5, timed by the speed alone; L0 still strokes the zone
        assert.equal(surge[surge.length - 1], `L17500I${legDurationMs(50, 1)}`);
        const stroke = lines().filter((l) => l.startsWith('L0'));
        assert.match(stroke[stroke.length - 1], /^L08000I/);
    });
});

describe('stop', () => {
    it('a forced zero dispatch rests every axis on one line, inside the envelope', async () => {
        await connect();
        dispatchTCode(100, 80, 20, 80, 10, 90);
        await flush();
        const before = port.written.length;
        dispatchTCode(0, 0, 0, 100, 10, 90, true);
        await flush();
        assert.equal(port.written.length, before + 1);
        assert.equal(lastLine(), `L01000I${TCODE_TIMINGS.restMs} R05000I${TCODE_TIMINGS.restMs} R15000I${TCODE_TIMINGS.restMs} V00000`);
        // STOP interrupts the leg in flight: the very next tick may move again.
        await sleep(TCODE_TIMINGS.restMs + 10);
        dispatchTCode(100, 0, 20, 80, 10, 90);
        await flush();
        assert.match(lastLine(), /^L08000I\d+$/);
    });
    it('honours invert on the rest move', async () => {
        await connect();
        setAxisInvert(0, true);
        stopTCode();
        await flush();
        assert.match(lastLine(), new RegExp(`^L09999I${TCODE_TIMINGS.restMs} `));
    });
});

describe('loss of the device', () => {
    it('a disconnect event marks the device offline and reports the assigned axes', async () => {
        await connect();
        dispatchTCode(100, 50, 0, 100, 0, 100);
        port.fire('disconnect');
        await sleep(20);
        assert.equal(isTCodeConnected(), false);
        assert.equal(getTCodeDevice(), null);
        assert.equal(getTCodeStatus().state, 'error');
        assert.match(getTCodeStatus().text, /unplugged/);
        assert.equal(events.close.length, 1);
        assert.equal(events.close[0].intentional, false);
        assert.equal(events.close[0].wasConnected, true);
        assert.equal(events.close[0].assignedAxes, 2);
        assert.equal(port.listenerCount('disconnect'), 0);
        assert.doesNotThrow(() => dispatchTCode(100, 0, 0, 100, 0, 100));
    });
    it('a failed write ends the session exactly once', async () => {
        await connect();
        port.failWrites = true;
        dispatchTCode(100, 0, 0, 100, 0, 100);
        await sleep(30);
        assert.equal(isTCodeConnected(), false);
        assert.equal(events.close.length, 1);
        assert.equal(events.close[0].intentional, false);
        assert.ok(events.errors.some((t) => /Write to the serial port failed/.test(t)));
    });
    it('a closed readable stream is treated as a lost device', async () => {
        await connect();
        port.closeReadable();
        await sleep(20);
        assert.equal(isTCodeConnected(), false);
        assert.equal(events.close.length, 1);
        assert.match(events.close[0].text, /closed/);
    });
    it('a read error is reported and closes the session', async () => {
        await connect();
        port.errorReadable(new Error('bus error'));
        await sleep(20);
        assert.equal(isTCodeConnected(), false);
        assert.ok(events.errors.some((t) => /Serial read failed: bus error/.test(t)));
        assert.equal(events.close.length, 1);
    });
    it('losing the port during identification fails the connect', async () => {
        port = makeFakePort({});
        requestPortImpl = async () => port;
        const pending = connectTCode(handlers());
        await sleep(10);
        port.fire('disconnect');
        assert.equal(await pending, false);
        assert.equal(isTCodeConnected(), false);
        assert.equal(events.close.length, 1);
        assert.equal(events.close[0].wasConnected, false);
    });
});

describe('disconnect', () => {
    it('rests every axis, flushes and releases the port', async () => {
        await connect();
        dispatchTCode(100, 50, 0, 100, 0, 100);
        assert.equal(await disconnectTCode(), true);
        assert.equal(port.closed, true);
        assert.match(lastLine(), new RegExp(`^L00000I${TCODE_TIMINGS.restMs} R05000I${TCODE_TIMINGS.restMs} R15000I${TCODE_TIMINGS.restMs} V00000$`));
        assert.equal(isTCodeConnected(), false);
        assert.equal(getTCodeStatus().state, 'offline');
        assert.equal(events.close.length, 1);
        assert.equal(events.close[0].intentional, true);
        assert.equal(events.close[0].assignedAxes, 2);
        assert.equal(await disconnectTCode(), false);
        assert.equal(events.close.length, 1);
    });
    it('refuses motion while the rest line is being flushed', async () => {
        await connect();
        dispatchTCode(0, 50, 0, 100, 0, 100);
        await flush();
        assert.equal(lastLine(), 'V05000');
        const closing = disconnectTCode();
        assert.equal(isTCodeConnected(), false, 'a closing session is not connected');
        // An engine tick landing in the flush window must not reach the port.
        dispatchTCode(0, 60, 0, 100, 0, 100);
        assert.equal(testAxis(3), false);
        assert.equal(await closing, true);
        assert.equal(port.closed, true);
        assert.equal(lastLine(), `L00000I${TCODE_TIMINGS.restMs} R05000I${TCODE_TIMINGS.restMs} R15000I${TCODE_TIMINGS.restMs} V00000`);
        assert.ok(!lines().includes('V06000'), lines().join(' | '));
    });
    it('a second Connect while the chooser is open is ignored', async () => {
        port = makeFakePort();
        let release = null;
        requestPortImpl = () => new Promise((resolve) => { release = () => resolve(port); });
        const first = connectTCode(handlers());
        await sleep(5);
        assert.equal(await connectTCode(handlers()), false);
        release();
        assert.equal(await first, true);
        assert.equal(isTCodeConnected(), true);
    });
    it('Disconnect while the chooser is open cancels the connect', async () => {
        port = makeFakePort();
        let release = null;
        requestPortImpl = () => new Promise((resolve) => { release = () => resolve(port); });
        const pending = connectTCode(handlers());
        await sleep(5);
        assert.equal(getTCodeStatus().state, 'connecting');
        assert.equal(await disconnectTCode(), true);
        assert.equal(getTCodeStatus().state, 'offline');
        release();
        assert.equal(await pending, false);
        assert.equal(port.opened, false, 'a port picked after Disconnect must not be opened');
        assert.equal(isTCodeConnected(), false);
        assert.equal(getTCodeStatus().state, 'offline');
        // The driver is usable again straight away.
        await connect();
        assert.equal(isTCodeConnected(), true);
    });
    it('a second connect replaces the first port', async () => {
        await connect();
        const first = port;
        await connect();
        assert.equal(first.closed, true);
        assert.equal(port.closed, false);
        assert.equal(isTCodeConnected(), true);
        assert.equal(events.close.length, 1);
    });
});

describe('persistence', () => {
    it('remembers roles, caps and invert per device name', async () => {
        await connect();
        setAxisRole(1, 'secondary');
        setAxisCap(0, 65);
        setAxisInvert(0, true);
        setAxisRole(3, 'off');
        const saved = JSON.parse(store[TCODE_STORAGE_KEY]);
        assert.deepEqual(saved['OSR2 Test Rig'].axes.L0, { role: 'primary', maxCap: 65, invert: true });
        assert.deepEqual(saved['OSR2 Test Rig'].axes.R0, { role: 'secondary', maxCap: 100, invert: false });
        assert.deepEqual(saved['OSR2 Test Rig'].axes.V0, { role: 'off', maxCap: 100, invert: false });
        await disconnectTCode();
        await connect();
        const dev = getTCodeDevice();
        assert.deepEqual(dev.axes.map((a) => a.role), ['primary', 'secondary', 'off', 'off']);
        assert.equal(dev.axes[0].maxCap, 65);
        assert.equal(dev.axes[0].invert, true);
        assert.equal(saveTCodeConfig(), true);
    });
    it('ignores corrupt saved data and refuses bad roles', async () => {
        store[TCODE_STORAGE_KEY] = '{"OSR2 Test Rig": {"axes": {"L0": {"role": "sideways", "maxCap": "lots", "invert": 1}}}}';
        await connect();
        const axis = getTCodeDevice().axes[0];
        assert.equal(axis.role, 'primary');
        assert.equal(axis.maxCap, 100);
        assert.equal(axis.invert, true);
        assert.equal(setAxisRole(0, 'sideways'), false);
        assert.equal(setAxisInvert(1, true), false, 'invert is linear-only');
    });
});

describe('test button', () => {
    it('moves a linear axis up and back', async () => {
        await connect();
        dispatchTCode(0, 0, 20, 80, 0, 100);
        await flush();
        const before = port.written.length;
        assert.equal(testAxis(0), true);
        await flush();
        assert.equal(lastLine(), `L08000I${TCODE_TIMINGS.testMoveMs}`);
        assert.equal(testAxis(0), false, 'a second test while one runs is refused');
        await sleep(TCODE_TIMINGS.testMoveMs + 70);
        assert.equal(port.written.length, before + 2);
        assert.equal(lastLine(), `L02000I${TCODE_TIMINGS.testMoveMs}`);
    });
    it('buzzes a vibe axis briefly at 60 % of its cap', async () => {
        await connect();
        setAxisCap(3, 50);
        assert.equal(testAxis(3), true);
        await flush();
        assert.equal(lastLine(), 'V03000');
        await sleep(TCODE_TIMINGS.testHoldMs + 20);
        assert.equal(lastLine(), 'V00000');
    });
    it('turns a rotation axis a quarter turn and back', async () => {
        await connect();
        assert.equal(testAxis(1), true);
        await flush();
        assert.equal(lastLine(), `R07500I${TCODE_TIMINGS.testMoveMs}`);
        await sleep(TCODE_TIMINGS.testMoveMs + 70);
        assert.equal(lastLine(), `R05000I${TCODE_TIMINGS.testMoveMs}`);
    });
});

describe('auto-resetting boards', () => {
    it('drains boot chatter before D0 and never takes the banner for a name', async () => {
        port = makeFakePort(OSR_REPLIES);
        const open = port.open.bind(port);
        port.open = async (options) => {
            await open(options);
            // An ESP32 prints its ROM banner right after the DTR toggle.
            setTimeout(() => port.push('ets Jul 29 2019 12:21:46\r\nrst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n'), 2);
        };
        requestPortImpl = async () => port;
        assert.equal(await connectTCode(handlers()), true);
        await sleep(TCODE_TIMINGS.restMs + 5);
        assert.equal(getTCodeDevice().name, 'OSR2 Test Rig');
        assert.equal(getTCodeDevice().version, 'TCode v0.3');
        assert.equal(lines()[0], 'D0');
        assert.ok(events.status.some((s) => /settle/i.test(s.text)));
    });
    it('asks D0 again when the first query was swallowed by the reboot', async () => {
        let queries = 0;
        const replies = {
            ...OSR_REPLIES,
            D0: () => (queries++ === 0 ? ['ets Jul 29 2019 12:21:46'] : ['OSR2 Test Rig'])
        };
        assert.equal(await connect(replies), true);
        assert.equal(lines().filter((l) => l === 'D0').length, 2);
        assert.equal(getTCodeDevice().name, 'OSR2 Test Rig');
        assert.equal(getTCodeDevice().identified, true);
    });
    it('a silent device gets one D0 retry and then the fallback', async () => {
        assert.equal(await connect({}), true);
        assert.equal(lines().filter((l) => l === 'D0').length, 2);
        assert.equal(lines().filter((l) => l === 'D1').length, 1);
        assert.equal(getTCodeDevice().name, 'TCode device');
    });
});

describe('secure origin', () => {
    it('tells desktop Chrome on a plain http origin about the secure-origin rule', async () => {
        installNavigator({ serial: false });
        globalThis.isSecureContext = false;
        try {
            assert.equal(await connectTCode(handlers()), false);
            assert.match(getTCodeStatus().text, /secure origin/);
            assert.match(getTCodeStatus().text, /https:\/\/ or http:\/\/localhost/);
        } finally {
            delete globalThis.isSecureContext;
        }
    });
});

describe('planner constants', () => {
    it('rest defaults match the shared planner', () => {
        assert.equal(REST_MOVE_MS, 400);
        assert.equal(FAST_LEG_MS, 180);
    });
});

// ---- Script mode -------------------------------------------------------------

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

function beat(every, seconds = 30) {
    const out = [];
    for (let t = 0, i = 0; t <= seconds * 1000; t += every, i += 1) out.push([t, i % 2 ? 100 : 0]);
    return out;
}

// The L0 commands written, as { pos (0-1), ms }.
function l0() {
    return lines().filter((l) => /^L0\d+I\d+$/.test(l)).map((l) => {
        const [, mag, ms] = /^L0(\d+)I(\d+)$/.exec(l);
        return { pos: Number(mag) / 10000, ms: Number(ms) };
    });
}

describe('Script mode: L0 plays the script', () => {
    afterEach(() => setTCodeScriptFeed(null));

    it('strokes on the script\'s beat inside the envelope; the other axes follow the engine as in every mode', async () => {
        await connect();
        const feed = playingFeed(beat(400));
        feed.setActive(true);
        setTCodeScriptFeed(feed);
        const before = l0().length;
        dispatchTCode(100, 60, 20, 80, 20, 80);
        await flush();
        assert.equal(tcodeAxisPlanner(0), 'script');
        assert.equal(tcodeAxisPlanner(1), 'stroke', 'R0 swings with the engine speed');
        await sleep(2600);
        const legs = l0().slice(before);
        assert.ok(legs.length >= 5, `${legs.length}`);
        assert.ok(legs.every((l) => l.pos >= 0.2 - 1e-9 && l.pos <= 0.8 + 1e-9), legs.map((l) => l.pos).join(' '));
        const steady = legs.slice(2);
        assert.ok(steady.every((l) => l.ms >= 340 && l.ms <= 400), steady.map((l) => l.ms).join(' '));
        assert.ok(steady.every((l) => Math.abs(l.pos - 0.2) < 0.001 || Math.abs(l.pos - 0.8) < 0.001), steady.map((l) => l.pos).join(' '));
        // V0 takes the secondary (the allowance x 0.6 from the engine).
        assert.ok(lines().some((l) => /^V0/.test(l)));
        // STOP rests every axis on one line, L0 at the envelope's bottom.
        dispatchTCode(0, 0, 0, 100, 20, 80, true);
        await flush();
        assert.match(lastLine(), new RegExp(`^L02000I${TCODE_TIMINGS.restMs} `));
        const after = port.written.length;
        await sleep(700);
        assert.equal(port.written.length, after, 'then silence');
    });

    it('a skip rests L0 at once and the script carries on without it; the allowance back rejoins it', async () => {
        await connect();
        const feed = playingFeed(beat(400));
        feed.setActive(true);
        setTCodeScriptFeed(feed);
        dispatchTCode(100, 60, 0, 100, 0, 100);
        await sleep(1200);
        const at = l0().length;
        dispatchTCode(0, 0, 0, 100, 0, 100, false, { urgent: true });
        await flush();
        assert.deepEqual(l0().slice(at), [{ pos: 0, ms: TCODE_TIMINGS.restMs }]);
        await sleep(700);
        assert.equal(l0().length, at + 1);
        dispatchTCode(50, 30, 0, 100, 0, 100);
        await sleep(1500);
        const back = l0().slice(at + 1);
        assert.ok(back.length >= 2);
        assert.ok(back[0].pos / back[0].ms <= 300 / 100 / 1000 / 2 + 1e-6, JSON.stringify(back[0]));
        assert.ok(back.every((l) => l.pos <= 0.5 + 1e-9), back.map((l) => l.pos).join(' '));
    });

    it('a seek rests L0 at once, not at the end of the leg in flight', async () => {
        await connect();
        const feed = playingFeed(beat(1800), { settings: { scriptMaxSpeed: 600 } });
        feed.setActive(true);
        setTCodeScriptFeed(feed);
        dispatchTCode(100, 0, 0, 100, 0, 100);
        await sleep(2300);
        const at = l0().length;
        feed.setVideoState('seeking');
        await flush();
        assert.deepEqual(l0().slice(at), [{ pos: 0, ms: TCODE_TIMINGS.restMs }]);
        feed.setVideoState('playing');
        feed.sample({ mediaMs: 8000, perfMs: performance.now(), source: 'frame' });
        await sleep(80);
        const join = l0().slice(at + 1);
        assert.equal(join.length, 1);
        assert.equal(join[0].pos, 0.9999);
        assert.ok(join[0].ms >= 900 && join[0].ms <= 1000, `${join[0].ms}`);
    });

    it('writes nothing while the script holds where L0 is', async () => {
        await connect();
        // Connected, L0 rests at the bottom; the script holds there for
        // 2.6 s, then strokes.
        const feed = playingFeed([[0, 0], [2600, 0], [3000, 100], [3400, 0]]);
        feed.setActive(true);
        setTCodeScriptFeed(feed);
        const before = l0().length;
        dispatchTCode(100, 0, 0, 100, 0, 100);
        await sleep(2400);
        assert.equal(l0().length, before, 'not one L0 command during the hold');
        await sleep(900);
        assert.ok(l0().slice(before).some((l) => l.pos === 0.9999), JSON.stringify(l0().slice(before)));
    });

    it('a secondary-role L0 keeps its stroke planner, and Script mode off hands L0 back after its leg', async () => {
        await connect();
        const feed = playingFeed(beat(400));
        feed.setActive(true);
        setTCodeScriptFeed(feed);
        setAxisRole(0, 'secondary');
        dispatchTCode(100, 60, 0, 100, 0, 100);
        await sleep(TCODE_TIMINGS.restMs + 20);
        dispatchTCode(100, 60, 0, 100, 0, 100);
        assert.equal(tcodeAxisPlanner(0), 'stroke');
        setAxisRole(0, 'primary');
        await sleep(1200);
        dispatchTCode(100, 60, 0, 100, 0, 100);
        assert.equal(tcodeAxisPlanner(0), 'script');
        feed.setActive(false);
        dispatchTCode(100, 60, 0, 100, 0, 100);
        assert.equal(tcodeAxisPlanner(0), 'script', 'the leg in flight runs out first');
        await sleep(500);
        assert.equal(tcodeAxisPlanner(0), 'stroke');
        dispatchTCode(0, 0, 0, 100, 0, 100, true);
    });
});
