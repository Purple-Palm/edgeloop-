// Driver tests with a mocked global fetch. No network, no DOM.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    HANDY_TIMINGS,
    connectHandy,
    disconnectHandy,
    dispatchHandy,
    stopHandy,
    stopHandyOnUnload,
    pollHandyConnected,
    handyPollTick,
    queryHandyBattery,
    setHandyHandlers,
    getHandyKey,
    isHandyMoving,
    isHandyMotionUnknown,
    isHandyOfflineStopPending,
    handyConnected
} from './handy.js';
import { HANDY_API_BASE, HANDY_MIN_VELOCITY, handyTargetSpeed } from './handy-protocol.js';
import { calculateEngineOutputs } from '../engine.js';

const KEY = 'test-key-123';
// The shipped poll cadence, read before any test shortens it.
const SHIPPED_POLL = Object.freeze({ pollMs: HANDY_TIMINGS.pollMs, idlePollMs: HANDY_TIMINGS.idlePollMs });
// What the v2 OpenAPI spec gives as its X-RateLimit-Limit example: requests
// per minute window, the only number it publishes for the limit.
const DOCUMENTED_LIMIT_PER_MINUTE = 240;
// The two answers the v2 spec gives for a command the device did not carry
// out, as its own examples spell them (their codes contradict the spec's
// enum, which is why the driver reads the name and the `connected` flag, not
// the number). DEVICE_TIMEOUT: the API forwarded the command and heard
// nothing back within its timeout, so the device may have carried it out -
// what a device on a failing Wi-Fi link answers. DEVICE_NOT_CONNECTED: the
// API had no device on the key's link and forwarded nothing. A stop left
// unanswered is unconfirmed either way.
const DEVICE_TIMEOUT = { error: { code: 1002, name: 'DeviceTimeout', message: 'Device timeout', connected: true } };
const DEVICE_NOT_CONNECTED = { error: { code: 1001, name: 'DeviceNotConnected', message: 'Device not connected', connected: false } };

let calls = [];
let routes = {};
let errors = [];
let offline = [];
let unconfirmed = [];
let notices = [];
let sessionActive = true;

function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function pathOf(url) {
    assert.ok(url.startsWith(HANDY_API_BASE), `unexpected base url ${url}`);
    return url.slice(HANDY_API_BASE.length);
}

function installFetch() {
    globalThis.fetch = async (url, init = {}) => {
        const path = pathOf(url);
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        const key = init.headers['X-Connection-Key'];
        calls.push({ path, method, body, key, keepalive: init.keepalive === true });
        const handler = routes[`${method} ${path}`] || routes[path];
        let result;
        if (typeof handler === 'function') result = handler({ path, method, body, key });
        else if (handler === undefined) result = jsonResponse({ result: 0 });
        else result = handler;
        // Honour the abort signal like a real fetch would.
        if (init.signal) {
            return new Promise((resolve, reject) => {
                const onAbort = () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    reject(err);
                };
                if (init.signal.aborted) return onAbort();
                init.signal.addEventListener('abort', onAbort, { once: true });
                Promise.resolve(result).then(resolve, reject);
            });
        }
        return result;
    };
}

function tick(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait for a condition on a real timer, for tests that have to let one run.
async function waitFor(cond, ms = 2000) {
    const until = Date.now() + ms;
    while (!cond() && Date.now() < until) await tick(5);
    return cond();
}

async function connectOk() {
    routes['/connected'] = jsonResponse({ connected: true });
    routes['/info'] = jsonResponse({ fwVersion: '3.2.3', model: 'Handy 1.1' });
    const result = await connectHandy(KEY);
    calls = [];
    return result;
}

const sent = (path, method) => calls.filter((c) => c.path === path && (!method || c.method === method));

describe('handy driver', () => {
    beforeEach(() => {
        calls = [];
        routes = {};
        errors = [];
        offline = [];
        unconfirmed = [];
        notices = [];
        sessionActive = true;
        // Short backoffs keep the retry tests fast; the attempt counts are unchanged.
        HANDY_TIMINGS.requestTimeoutMs = 6000;
        HANDY_TIMINGS.stopRetryDelaysMs = [5, 10, 20];
        HANDY_TIMINGS.offlineStopRetryMs = 80;
        // The real 10 s timer never fires inside a test; the cadence is
        // driven tick by tick through handyPollTick() instead.
        HANDY_TIMINGS.pollMs = SHIPPED_POLL.pollMs;
        HANDY_TIMINGS.idlePollMs = SHIPPED_POLL.idlePollMs;
        installFetch();
        setHandyHandlers({
            onError: (m) => errors.push(m),
            onOffline: (r) => offline.push(r),
            onStopUnconfirmed: (m) => unconfirmed.push(m),
            onNotice: (m) => notices.push(m),
            isSessionActive: () => sessionActive
        });
    });

    afterEach(async () => {
        routes = {};
        disconnectHandy();
        await tick(0);
    });

    it('connects in HAMP mode, stops the device and reads info', async () => {
        routes['/connected'] = jsonResponse({ connected: true });
        routes['/info'] = jsonResponse({ fwVersion: '3.2.3', model: 'Handy 1.1', battery: 77 });
        const result = await connectHandy(` ${KEY} `);

        assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
            'GET /connected', 'PUT /mode', 'PUT /hamp/stop', 'GET /info'
        ]);
        assert.deepEqual(sent('/mode')[0].body, { mode: 0 });
        assert.ok(calls.every((c) => c.key === KEY));
        assert.equal(getHandyKey(), KEY);
        assert.equal(result.battery, 77);
        assert.equal(result.description, 'fw 3.2.3, Handy 1.1');
        assert.equal(isHandyMoving(), false);
    });

    it('rejects an offline device with a readable error', async () => {
        routes['/connected'] = jsonResponse({ connected: false });
        await assert.rejects(connectHandy(KEY), /offline/i);
        assert.equal(getHandyKey(), '');
    });

    it('rejects an API error object even on HTTP 200', async () => {
        routes['/connected'] = jsonResponse({ error: { code: 1001, message: 'Invalid connection key' } });
        await assert.rejects(connectHandy(KEY), /Invalid connection key/);
    });

    it('rejects a failed mode switch', async () => {
        routes['/connected'] = jsonResponse({ connected: true });
        routes['PUT /mode'] = jsonResponse({ result: -1 });
        await assert.rejects(connectHandy(KEY), /rejected|HAMP/);
        assert.equal(sent('/hamp/stop').length, 0);
    });

    it('rejects a failed initial stop', async () => {
        routes['/connected'] = jsonResponse({ connected: true });
        routes['PUT /hamp/stop'] = jsonResponse(null, 503);
        await assert.rejects(connectHandy(KEY), /HTTP 503/);
    });

    it('still connects when /info is unavailable', async () => {
        routes['/connected'] = jsonResponse({ connected: true });
        routes['/info'] = jsonResponse(null, 404);
        const result = await connectHandy(KEY);
        assert.equal(result.battery, null);
        assert.equal(result.description, '');
    });

    it('sets slide, starts, then sends velocity using the stored key', async () => {
        await connectOk();
        dispatchHandy(55, 20, 80, true, 0, 100);
        await tick(5);

        const seq = calls.map((c) => `${c.method} ${c.path}`);
        assert.deepEqual(seq, ['PUT /slide', 'PUT /hamp/start', 'PUT /hamp/velocity']);
        assert.deepEqual(sent('/slide')[0].body, { min: 20, max: 80 });
        assert.deepEqual(sent('/hamp/velocity')[0].body, { velocity: 55 });
        assert.ok(calls.every((c) => c.key === KEY));
        assert.equal(isHandyMoving(), true);
    });

    it('re-sends the slide range when only min changes', async () => {
        await connectOk();
        dispatchHandy(40, 20, 80, true, 0, 100);
        await tick(5);
        dispatchHandy(40, 30, 80, true, 0, 100);
        await tick(5);
        const slides = sent('/slide').map((c) => c.body);
        assert.deepEqual(slides, [{ min: 20, max: 80 }, { min: 30, max: 80 }]);
    });

    it('never sends a slide narrower than 10% or outside the envelope', async () => {
        await connectOk();
        dispatchHandy(40, 84, 85, true, 15, 85);
        await tick(5);
        assert.deepEqual(sent('/slide')[0].body, { min: 75, max: 85 });
        dispatchHandy(40, -20, 140, true, 15, 85);
        await tick(5);
        assert.deepEqual(sent('/slide')[1].body, { min: 15, max: 85 });
    });

    it('clamps velocity to 0-100 and skips duplicate velocity sends', async () => {
        await connectOk();
        dispatchHandy(140, 0, 100, true, 0, 100);
        await tick(5);
        dispatchHandy(140, 0, 100, true, 0, 100);
        await tick(5);
        const vel = sent('/hamp/velocity').map((c) => c.body.velocity);
        assert.deepEqual(vel, [100]);
    });

    it('throttles unforced dispatches to one per 400 ms', async () => {
        await connectOk();
        dispatchHandy(30, 0, 100, false, 0, 100);
        await tick(5);
        dispatchHandy(60, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
        assert.deepEqual(sent('/hamp/velocity').map((c) => c.body.velocity), [30]);
    });

    it('a zero for a motor at rest takes no turn from the throttle, so START is sent at once', async () => {
        await connectOk();
        // Between sessions the engine dispatches a zero on every clock tick
        // and heart-rate packet, and START dispatches one more while The
        // Handy is asked whether it is online. None of them sends anything,
        // and the start that follows inside 400 ms used to wait for the next
        // tick, or the one after, because of them.
        dispatchHandy(0, 0, 100, false, 0, 100);
        await tick(5);
        dispatchHandy(0, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(calls.length, 0);
        dispatchHandy(30, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(sent('/slide').length, 1);
        assert.equal(sent('/hamp/start').length, 1, 'the start went out on the same dispatch');
        assert.deepEqual(sent('/hamp/velocity').map((c) => c.body.velocity), [30]);
        // A dispatch that does send takes its turn exactly as before.
        dispatchHandy(60, 0, 100, false, 0, 100);
        await tick(5);
        assert.deepEqual(sent('/hamp/velocity').map((c) => c.body.velocity), [30]);
    });

    it('a zero that sends a stop still takes its turn: no restart inside the window', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        await tick(400);
        dispatchHandy(0, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(isHandyMoving(), false);
        calls = [];
        dispatchHandy(50, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(calls.length, 0, 'the throttle still spaces a stop and the next start');
        await tick(400);
        dispatchHandy(50, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
    });

    it('stops on zero speed and marks the device stopped only after confirmation', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);

        let release;
        routes['PUT /hamp/stop'] = () => new Promise((resolve) => { release = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(isHandyMoving(), true, 'must not flip to stopped before the API confirms');
        release();
        await tick(5);
        assert.equal(isHandyMoving(), false);
    });

    it('retries a failed stop with backoff and reports when it is never confirmed', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);

        let attempts = 0;
        routes['PUT /hamp/stop'] = () => {
            attempts += 1;
            return attempts < 3 ? jsonResponse(null, 500) : jsonResponse({ result: 0 });
        };
        const ok = await stopHandy();
        assert.equal(ok, true);
        assert.equal(attempts, 3);
        assert.equal(isHandyMoving(), false);
        assert.ok(errors.some((m) => m && /HTTP 500/.test(m)));
        assert.equal(errors[errors.length - 1], null, 'recovery is reported after the confirmed stop');
    });

    it('keeps the device flagged as moving when every stop attempt fails', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);

        let attempts = 0;
        routes['PUT /hamp/stop'] = () => { attempts += 1; return jsonResponse(null, 500); };
        const ok = await stopHandy();
        assert.equal(ok, false);
        assert.equal(attempts, 4);
        assert.ok(errors.some((m) => m && /Stop not confirmed/.test(m)));
    });

    it('ignores a start that resolves after a later stop and re-issues the stop', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });

        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
        assert.equal(isHandyMoving(), false);

        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);

        releaseStart();
        await tick(5);
        assert.equal(isHandyMoving(), false, 'stale start must not flip running=true');
        assert.equal(sent('/hamp/velocity').length, 0, 'stale start must not send velocity');
        assert.equal(sent('/hamp/stop').length, 2, 'a safety stop follows the stale start');
    });

    it('leaves running=false and reports when start fails', async () => {
        await connectOk();
        routes['PUT /hamp/start'] = jsonResponse({ error: { code: 3000, message: 'Device busy' } });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), false);
        assert.equal(sent('/hamp/velocity').length, 0);
        assert.ok(errors.some((m) => m && /Device busy/.test(m)));
    });

    it('goes offline after five consecutive failed dispatch ticks (not requests)', async () => {
        await connectOk();
        routes['PUT /slide'] = jsonResponse(null, 500);
        routes['PUT /hamp/start'] = jsonResponse(null, 500);
        routes['PUT /hamp/velocity'] = jsonResponse(null, 500);
        for (let i = 0; i < 4; i++) {
            dispatchHandy(50, 0, 100, true, 0, 100);
            await tick(5);
        }
        assert.equal(offline.length, 0, 'four failed ticks are not yet offline');
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(offline.length, 1);
        assert.match(offline[0], /stopped responding/);
        assert.equal(handyConnected, false);
        // Every slide was refused, so no PUT /hamp/start ever left and the
        // motor never turned. This used to assert that going offline sends a
        // stop anyway; that stop, left unanswered by a dead device, is what
        // told the wearer a motor that had never started "may still be
        // moving". A motor that was running still gets its stops: see
        // 'keeps sending stops to an offline device until one is confirmed'.
        assert.equal(sent('/hamp/start').length, 0);
        await tick(HANDY_TIMINGS.offlineStopRetryMs + 40);
        assert.equal(sent('/hamp/stop').length, 0, 'a motor that never started is not chased with stops');
        assert.equal(isHandyOfflineStopPending(), false);
        assert.equal(unconfirmed.length, 0);
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(offline.length, 1, 'offline is reported once');
    });

    // This test used to be 'polls /connected only while a session is active',
    // and that was a deliberate choice: outside a session nothing moves, so
    // there seemed to be nothing to watch. What it cost was measured with the
    // device switched off: no request at all in 45 s IDLE or 40 s PAUSED, the
    // card green, the modal saying "Connected", START enabled - and START
    // then drove the dead device for seconds before the failed commands
    // paused the session. The poll now runs for as long as a Handy is
    // connected; only how often depends on the session.
    it('polls /connected outside a session too, every third tick instead of every tick', async () => {
        await connectOk();
        sessionActive = false;
        for (let i = 0; i < 6; i++) await handyPollTick();
        assert.equal(sent('/connected').length, 2, 'IDLE / PAUSED: every third tick');
        calls = [];
        sessionActive = true;
        for (let i = 0; i < 6; i++) await handyPollTick();
        assert.equal(sent('/connected').length, 6, 'in a session: every tick, exactly as before');
        assert.equal(offline.length, 0);
        // A pause does not reset the wait: the first idle poll comes three
        // ticks after the last one of the session.
        calls = [];
        sessionActive = false;
        await handyPollTick();
        await handyPollTick();
        assert.equal(sent('/connected').length, 0);
        await handyPollTick();
        assert.equal(sent('/connected').length, 1);
    });

    it('the shipped cadence keeps the idle poll far under the documented rate limit', async () => {
        // A minute of ticks at the shipped period. The session cadence is the
        // old one; the idle one is what is new, and it has to cost next to
        // nothing: under 1% of the limit, so several tabs or another app on
        // the same key cannot be pushed over it by this.
        const ticksPerMinute = Math.round(60000 / SHIPPED_POLL.pollMs);
        await connectOk();
        sessionActive = false;
        for (let i = 0; i < ticksPerMinute; i++) await handyPollTick();
        const idlePerMinute = sent('/connected').length;
        assert.ok(idlePerMinute >= 1, 'the idle poll must run at all');
        assert.ok(idlePerMinute <= DOCUMENTED_LIMIT_PER_MINUTE / 100, `${idlePerMinute} a minute outside a session`);
        calls = [];
        sessionActive = true;
        for (let i = 0; i < ticksPerMinute; i++) await handyPollTick();
        assert.equal(sent('/connected').length, 6, 'the session poll is unchanged: 6 a minute, one every 10 s');
    });

    it('the real timer polls while no session is active and takes a switched-off Handy offline', async () => {
        HANDY_TIMINGS.pollMs = 10;
        HANDY_TIMINGS.idlePollMs = 30;
        await connectOk();
        sessionActive = false;
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        assert.ok(await waitFor(() => offline.length > 0), 'the idle poll never ran');
        assert.match(offline[0], /no longer connected/);
        assert.equal(handyConnected, false);
        // Nothing was moving: no stop job, no "may still be moving".
        await tick(HANDY_TIMINGS.offlineStopRetryMs * 2);
        assert.equal(sent('/hamp/stop').length, 0);
        assert.equal(unconfirmed.length, 0);
        assert.equal(isHandyOfflineStopPending(), false);
        // And the timer is gone with the link.
        const polls = sent('/connected').length;
        await tick(100);
        assert.equal(sent('/connected').length, polls);
    });

    it('goes offline when the poll reports connected=false', async () => {
        await connectOk();
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        assert.match(offline[0], /no longer connected/);
    });

    it('goes offline after three consecutive poll errors', async () => {
        await connectOk();
        routes['/connected'] = () => { throw new TypeError('Failed to fetch'); };
        await pollHandyConnected();
        await pollHandyConnected();
        assert.equal(offline.length, 0);
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        assert.match(offline[0], /unreachable/);
        assert.ok(errors.some((m) => m && /Network error/.test(m)));
    });

    it('disconnect sends a stop with the stored key and ignores further dispatches', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        calls = [];
        disconnectHandy();
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(sent('/hamp/stop')[0].key, KEY);
        calls = [];
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(calls.length, 0);
    });

    it('queryHandyBattery only reads /info and tolerates a missing field', async () => {
        await connectOk();
        routes['/info'] = jsonResponse({ fwVersion: '3.2.3' });
        assert.equal(await queryHandyBattery(), null);
        routes['/info'] = jsonResponse({ fwVersion: '3.2.3', battery: 0.5 });
        assert.equal(await queryHandyBattery(), 50);
        routes['/info'] = jsonResponse({ battery: 1 });
        assert.equal(await queryHandyBattery(), 1);
        assert.ok(calls.every((c) => c.path === '/info'));
    });
    // ---- reconnect ---------------------------------------------------------------

    it('a reconnect whose verification fails leaves the live link, and its stop path, untouched', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);
        routes['/connected'] = () => { throw new TypeError('Failed to fetch'); };
        await assert.rejects(connectHandy(KEY), /Network error/);
        assert.equal(handyConnected, true);
        assert.equal(getHandyKey(), KEY);
        assert.equal(isHandyMoving(), true, 'the running device is still owned');
        calls = [];
        assert.equal(await stopHandy(), true);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(sent('/hamp/stop')[0].key, KEY);
        assert.equal(isHandyMoving(), false);
    });

    it('a reconnect brings the running device to a confirmed stop before switching keys', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        calls = [];
        const result = await connectHandy('second-key');
        assert.equal(result.description, 'fw 3.2.3, Handy 1.1');
        assert.equal(getHandyKey(), 'second-key');
        assert.equal(isHandyMoving(), false);
        const stops = sent('/hamp/stop');
        assert.ok(stops.some((c) => c.key === 'second-key'), 'the new key is verified with a stop');
        assert.ok(stops.some((c) => c.key === KEY), 'the running device is stopped with its own key');
        const verify = calls.findIndex((c) => c.path === '/connected' && c.key === 'second-key');
        const oldStop = calls.findIndex((c) => c.path === '/hamp/stop' && c.key === KEY);
        assert.ok(verify >= 0 && verify < oldStop, 'the old device is only stopped once the new key passed');
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start')[0].key, 'second-key');
    });

    it('refuses to switch keys when the running device will not confirm a stop', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? jsonResponse(null, 503) : jsonResponse({ result: 0 }));
        await assert.rejects(connectHandy('second-key'), /did not confirm a stop/);
        assert.equal(handyConnected, true);
        assert.equal(getHandyKey(), KEY);
        assert.equal(isHandyMoving(), true);
        assert.equal(unconfirmed.length, 1);
    });

    // ---- stops that must still reach a device the driver no longer owns -------------

    it('a start that resolves after Disconnect is followed by a stop with the old key', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
        assert.equal(await disconnectHandy(), true);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(getHandyKey(), '');
        releaseStart();
        await tick(5);
        assert.equal(isHandyMoving(), false, 'stale start must not flip running=true');
        assert.equal(sent('/hamp/velocity').length, 0, 'stale start must not send velocity');
        assert.equal(sent('/hamp/stop').length, 2, 'a safety stop follows the stale start');
        assert.equal(sent('/hamp/stop')[1].key, KEY);
    });

    it('a start that resolves after the device went offline is followed by a stop', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['/connected'] = () => { throw new TypeError('Failed to fetch'); };
        for (let i = 0; i < 3; i++) await pollHandyConnected();
        assert.equal(offline.length, 1);
        await tick(5);
        const stopsAfterOffline = sent('/hamp/stop').length;
        assert.ok(stopsAfterOffline >= 1, 'going offline sends a stop');
        releaseStart();
        await tick(5);
        assert.equal(isHandyMoving(), false);
        assert.equal(sent('/hamp/stop').length, stopsAfterOffline + 1, 'a safety stop follows the stale start');
        assert.equal(sent('/hamp/stop')[stopsAfterOffline].key, KEY);
    });

    it('a hanging stop for a disconnected key never masks a stop for the new device', async () => {
        await connectOk();
        // The old device is running when it is let go, so its stop is one
        // that matters and its chain ends unconfirmed. (Disconnecting a motor
        // last seen stopped resolves true instead: see 'Disconnect of an idle
        // Handy that does not answer ...'.)
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);
        HANDY_TIMINGS.requestTimeoutMs = 60;
        // The old device is out of reach: its stop hangs until the timeout and retries.
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? new Promise(() => {}) : jsonResponse({ result: 0 }));
        const oldStop = disconnectHandy();
        await tick(5);
        await connectHandy('second-key');
        dispatchHandy(60, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);
        calls = [];
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').filter((c) => c.key === 'second-key').length, 1, 'STOP reaches the new device at once');
        assert.equal(isHandyMoving(), false);
        assert.equal(await oldStop, false, 'the old chain ends unconfirmed on its own');
    });

    it('keeps sending stops to an offline device until one is confirmed', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);
        const fail = () => { throw new TypeError('Failed to fetch'); };
        routes['PUT /slide'] = fail;
        routes['PUT /hamp/velocity'] = fail;
        routes['PUT /hamp/stop'] = fail;
        for (let i = 0; i < 5; i++) {
            dispatchHandy(50 + i, 0, 100, true, 0, 100);
            await tick(5);
        }
        assert.equal(offline.length, 1);
        assert.equal(handyConnected, false);
        // First background round: four attempts, none confirmed, reported once.
        await tick(60);
        assert.ok(sent('/hamp/stop').length >= 4);
        assert.equal(unconfirmed.length, 1);
        assert.equal(isHandyOfflineStopPending(), true);
        // The network is back: the next round confirms the stop and the job ends.
        routes['PUT /hamp/stop'] = undefined;
        const before = sent('/hamp/stop').length;
        await tick(HANDY_TIMINGS.offlineStopRetryMs + 40);
        assert.ok(sent('/hamp/stop').length > before, 'another stop round went out');
        assert.equal(sent('/hamp/stop')[sent('/hamp/stop').length - 1].key, KEY);
        assert.equal(isHandyOfflineStopPending(), false);
    });

    it('disconnect resolves false and reports when the stop is never confirmed', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['PUT /hamp/stop'] = jsonResponse(null, 500);
        assert.equal(await disconnectHandy(), false);
        assert.equal(sent('/hamp/stop').length, 4);
        assert.equal(unconfirmed.length, 1);
        assert.match(unconfirmed[0], /Stop not confirmed/);
        assert.equal(getHandyKey(), '');
    });

    it('stopHandyOnUnload sends a keepalive stop and treats the device as stopped', async () => {
        await connectOk();
        assert.equal(stopHandyOnUnload(), false, 'nothing to stop while idle');
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        calls = [];
        assert.equal(stopHandyOnUnload(), true);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(sent('/hamp/stop')[0].keepalive, true);
        assert.equal(sent('/hamp/stop')[0].key, KEY);
        assert.equal(isHandyMoving(), false);
        // A page that comes back restarts the motor on its next tick.
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
    });

    // ---- ordering and unknown states -------------------------------------------------

    it('starts the motor only after the slide range has been confirmed', async () => {
        await connectOk();
        let releaseSlide;
        routes['PUT /slide'] = () => new Promise((resolve) => { releaseSlide = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 20, 80, true, 0, 100);
        await tick(5);
        assert.equal(sent('/slide').length, 1);
        assert.equal(sent('/hamp/start').length, 0, 'no start before the range landed');
        releaseSlide();
        await tick(5);
        assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['PUT /slide', 'PUT /hamp/start', 'PUT /hamp/velocity']);
        assert.equal(isHandyMoving(), true);
    });

    it('does not start at an unknown range: a rejected slide is re-sent before any start', async () => {
        await connectOk();
        routes['PUT /slide'] = jsonResponse(null, 500);
        dispatchHandy(50, 20, 80, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 0);
        assert.equal(isHandyMoving(), false);
        routes['PUT /slide'] = undefined;
        dispatchHandy(50, 20, 80, true, 0, 100);
        await tick(5);
        assert.equal(sent('/slide').length, 2);
        assert.equal(sent('/hamp/start').length, 1);
        assert.equal(isHandyMoving(), true);
    });

    it('a start that times out after a stop is followed by a fresh stop', async () => {
        await connectOk();
        HANDY_TIMINGS.requestTimeoutMs = 40;
        routes['PUT /hamp/start'] = () => new Promise(() => {});
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        await tick(70);
        assert.equal(sent('/hamp/stop').length, 2, 'the relay may still deliver the start: stop again');
        assert.equal(isHandyMoving(), false);
    });

    it('a start that times out leaves the motion unknown, so the next zero dispatch sends a stop', async () => {
        await connectOk();
        HANDY_TIMINGS.requestTimeoutMs = 40;
        routes['PUT /hamp/start'] = () => new Promise(() => {});
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(70);
        assert.equal(isHandyMoving(), false);
        assert.equal(isHandyMotionUnknown(), true);
        assert.ok(errors.some((m) => m && /timed out/.test(m)));
        routes['PUT /hamp/start'] = undefined;
        // An unforced zero (the IDLE tick) after the throttle window.
        await tick(400);
        dispatchHandy(0, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(isHandyMotionUnknown(), false);
    });

    it('a success on another path does not clear a velocity error', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['PUT /hamp/velocity'] = jsonResponse({ error: { code: 3000, message: 'HampError' } });
        dispatchHandy(60, 0, 100, true, 0, 100);
        await tick(5);
        assert.match(errors[errors.length - 1], /HampError/);
        routes['/connected'] = jsonResponse({ connected: true });
        await pollHandyConnected();
        assert.match(errors[errors.length - 1], /HampError/, 'the poll must not clear it');
        dispatchHandy(70, 10, 90, true, 0, 100);
        await tick(5);
        assert.match(errors[errors.length - 1], /HampError/, 'a slide reply must not clear it');
        routes['PUT /hamp/velocity'] = undefined;
        dispatchHandy(80, 10, 90, true, 0, 100);
        await tick(5);
        assert.equal(errors[errors.length - 1], null, 'cleared once velocity succeeds again');
    });
    // The report this came from: X333's Handy 2 hit its own safety lockout
    // "as soon as warmup is over", once our /slide fix meant the full 0-100
    // range reached the device for the first time. The driver now keeps the
    // carriage off the mechanical ends unless the wearer says otherwise.
    it('keeps the stroke off the mechanical ends by default', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.deepEqual(sent('/slide')[0].body, { min: 5, max: 95 });
    });

    it('sends the full range when the margin is 0', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100, 0);
        await tick(5);
        assert.deepEqual(sent('/slide')[0].body, { min: 0, max: 100 });
    });

    it('does not touch a range that already clears the ends', async () => {
        // Anyone who typed their own guards sees exactly what they typed.
        await connectOk();
        dispatchHandy(50, 15, 85, true, 15, 85, 5);
        await tick(5);
        assert.deepEqual(sent('/slide')[0].body, { min: 15, max: 85 });
    });

    it('never leaves the envelope or the minimum stroke with a margin applied', async () => {
        await connectOk();
        // A tip-only zone at the top of a full envelope, at the widest margin.
        dispatchHandy(50, 95, 100, true, 0, 100, 10);
        await tick(5);
        const body = sent('/slide')[0].body;
        assert.ok(body.min >= 0 && body.max <= 100);
        assert.ok(body.max - body.min >= 10, `stroke was ${body.min}-${body.max}`);
        // A narrow envelope: the margin yields rather than shrink the stroke.
        dispatchHandy(50, 0, 100, true, 0, 10, 10);
        await tick(5);
        assert.deepEqual(sent('/slide')[1].body, { min: 0, max: 10 });
    });

    it('passes on a range the device rounded to its own limits, once', async () => {
        await connectOk();
        routes['PUT /slide'] = jsonResponse({ result: 1 });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(notices.length, 1);
        assert.match(notices[0], /rounded down/);
        assert.match(notices[0], /5-95%/);
        dispatchHandy(50, 10, 90, true, 0, 100);
        await tick(5);
        assert.equal(notices.length, 1, 'the same news every tick is not news');
    });

    it('names a HAMP fault instead of leaving a dead toy unexplained', async () => {
        await connectOk();
        routes['PUT /hamp/velocity'] = jsonResponse({ error: { code: 3000, message: 'HampError' } });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(notices.length, 1);
        assert.match(notices[0], /HAMP error 3000/);
        assert.match(notices[0], /obstruction/i);
        // Explaining a refusal is all it does: the existing offline counter
        // is still the only thing that decides when to give up on the link.
        assert.equal(offline.length, 0);
    });

    // ---- what a running session sends ------------------------------------------------

    // Drive the driver with the real engine, one master-clock second per
    // tick, the way app.js does: the Handy's channel and speed cap through
    // handyTargetSpeed, the engine's zone as the stroke, and no force. Date.now
    // is stepped a second per tick so the 400 ms throttle sees the 1 s clock.
    async function runSession(segments) {
        const realNow = Date.now;
        let clock = realNow.call(Date);
        Date.now = () => clock;
        const log = [];
        try {
            for (const segment of segments) {
                const { ticks, role = 'primary', cap = 100, ...engine } = segment;
                for (let i = 0; i < ticks; i++) {
                    const out = calculateEngineOutputs({
                        minHr: 70,
                        maxHr: 140,
                        sessionStatus: 'RUNNING',
                        isEdged: false,
                        orgasmMode: false,
                        warmupMinutes: 0,
                        ceilingBehaviour: 'crawl',
                        ...engine,
                        edgeHr: engine.hr,
                        sessionSeconds: (engine.sessionSeconds || 0) + i
                    });
                    const velocity = handyTargetSpeed(role, out.primaryPercent, out.secondaryPercent, cap);
                    const before = calls.length;
                    dispatchHandy(velocity, out.strokeMinPercent, out.strokeMaxPercent, false, 0, 100);
                    clock += 1000;
                    await tick(0);
                    log.push({ velocity, sent: calls.slice(before).map((c) => c.path) });
                }
            }
        } finally {
            Date.now = realNow;
        }
        return log;
    }

    it('a pattern near-stop reaches the device as the slowest velocity, never as a stop / start pair', async () => {
        await connectOk();
        // In release 1.1.2 each of these sent PUT /hamp/stop and PUT
        // /hamp/start over and over at 139 BPM, the last BPM before the mark
        // on this 70-140 band: the default warm-up (17 pairs), Classic and
        // Ultimate (about 4 and 2 a minute), Milker under a 40% speed cap
        // (about 5 a minute), and the Handy on Head Play's secondary channel
        // (about 4 a minute). 1.1.0 did the same from 130 BPM up, in a
        // warm-up from a resting pulse, and at 100 BPM under the cap.
        await runSession([
            { ticks: 300, activeMode: 'classic', hr: 139, warmupMinutes: 5, sessionSeconds: 0 },
            { ticks: 240, activeMode: 'classic', hr: 139, sessionSeconds: 600 },
            { ticks: 240, activeMode: 'ultimate', hr: 139, sessionSeconds: 900 },
            { ticks: 240, activeMode: 'milker', hr: 139, cap: 40, sessionSeconds: 1200 },
            { ticks: 240, activeMode: 'headplay', hr: 139, role: 'secondary', sessionSeconds: 1500 }
        ]);
        assert.equal(sent('/hamp/stop').length, 0, 'no stop the engine did not decide on');
        assert.equal(sent('/hamp/start').length, 1, 'one start for the whole session');
        const velocities = sent('/hamp/velocity').map((c) => c.body.velocity);
        assert.ok(velocities.includes(HANDY_MIN_VELOCITY), 'the near-stops went out as the crawl');
        assert.ok(velocities.every((v) => v >= HANDY_MIN_VELOCITY), `a velocity under the crawl was sent: ${Math.min(...velocities)}`);
        assert.equal(isHandyMoving(), true);
        assert.equal(notices.length, 0);
    });

    it('a stop the engine decides on still reaches the device as PUT /hamp/stop', async () => {
        await connectOk();
        const moving = { ticks: 5, activeMode: 'classic', hr: 118, ceilingBehaviour: 'stop' };
        const log = await runSession([
            { ...moving, sessionSeconds: 400 },
            { ...moving, ticks: 8, stallGuardEngaged: true, sessionSeconds: 405 },
            { ...moving, sessionSeconds: 413 },
            // Full Stop, parked at the pullback mark.
            { ...moving, hr: 140, isEdged: true, sessionSeconds: 418 },
            { ...moving, sessionSeconds: 423 },
            { ...moving, activeMode: 'ruin', hr: 140, isEdged: true, ruinHoldSeconds: 5, sessionSeconds: 428 },
            { ...moving, sessionSeconds: 433 },
            // The speed cap at 0 and the role Off are the wearer's own stops.
            { ...moving, cap: 0, sessionSeconds: 438 },
            { ...moving, sessionSeconds: 443 },
            { ...moving, role: 'off', sessionSeconds: 448 }
        ]);
        assert.equal(sent('/hamp/stop').length, 5, 'stall guard, Full Stop, Ruin lock, cap 0 and Off each stop once');
        assert.equal(sent('/hamp/start').length, 5, 'and the session starts again after each');
        // Each halt is a stop on the tick it begins, and nothing moves until it ends.
        for (const first of [5, 18, 28, 38, 48]) {
            assert.equal(log[first].velocity, 0);
            assert.deepEqual(log[first].sent, ['/hamp/stop'], `tick ${first}: ${JSON.stringify(log[first].sent)}`);
        }
        assert.equal(isHandyMoving(), false);
    });

    // ---- the answer START / RESUME wait for --------------------------------------------

    it('answers online, offline, or unreachable until the third miss in a row', async () => {
        await connectOk();
        sessionActive = false;
        assert.deepEqual(await pollHandyConnected(), { state: 'online', reason: null });
        routes['/connected'] = () => { throw new TypeError('Failed to fetch'); };
        const miss = await pollHandyConnected();
        assert.equal(miss.state, 'unreachable');
        assert.match(miss.reason, /Network error \(\/connected\)/);
        assert.equal(handyConnected, true, 'one miss is not a dead device');
        assert.match(errors[errors.length - 1], /Network error \(\/connected\)/, 'but it is on the status line at once');
        await pollHandyConnected();
        // An answer in between starts the count again, and clears the line.
        routes['/connected'] = jsonResponse({ connected: true });
        assert.equal((await pollHandyConnected()).state, 'online');
        assert.equal(errors[errors.length - 1], null);
        routes['/connected'] = () => { throw new TypeError('Failed to fetch'); };
        await pollHandyConnected();
        assert.equal((await pollHandyConnected()).state, 'unreachable');
        assert.equal(handyConnected, true, 'two misses since the last answer');
        const third = await pollHandyConnected();
        assert.equal(third.state, 'offline');
        assert.match(third.reason, /unreachable/);
        assert.equal(third.cause, 'api', 'the network failed, not necessarily the device');
        assert.equal(handyConnected, false);
        assert.equal(offline.length, 1);
        assert.equal((await pollHandyConnected()).state, 'lost', 'no link, nothing to confirm');
        assert.equal(sent('/connected').length, 7, 'and nothing is asked without a link');
    });

    it('a check whose link is dropped while it is out says so, and drops nothing twice', async () => {
        await connectOk();
        // START's question is slow; the timer's poll, sent after it, comes
        // back first and takes the link offline.
        let releaseStartCheck;
        let asked = 0;
        routes['/connected'] = () => {
            asked += 1;
            if (asked === 1) return new Promise((resolve) => { releaseStartCheck = () => resolve(jsonResponse({ connected: true })); });
            return jsonResponse({ connected: false });
        };
        const startCheck = pollHandyConnected();
        await tick(5);
        assert.equal((await pollHandyConnected()).state, 'offline');
        releaseStartCheck();
        const answer = await startCheck;
        assert.equal(answer.state, 'lost', 'even a yes is no use once the link is gone');
        assert.match(answer.reason, /lost while it was being checked/);
        assert.equal(offline.length, 1, 'one offline report');
        assert.equal(handyConnected, false);
        // Disconnect while a check is out: the same answer.
        await connectOk();
        let releaseLate;
        routes['/connected'] = () => new Promise((resolve) => { releaseLate = () => resolve(jsonResponse({ connected: true })); });
        const late = pollHandyConnected();
        await tick(5);
        disconnectHandy();
        releaseLate();
        assert.equal((await late).state, 'lost', 'a yes about a link that is gone starts nothing');
    });

    it('a device that says it is offline is dropped on the first answer', async () => {
        await connectOk();
        routes['/connected'] = jsonResponse({ connected: false });
        const answer = await pollHandyConnected();
        assert.equal(answer.state, 'offline');
        assert.match(answer.reason, /no longer connected to Wi-Fi/);
        assert.equal(answer.cause, 'device');
        assert.equal(offline.length, 1);
        assert.equal(handyConnected, false);
    });

    it('an answer about a link that was replaced meanwhile is ignored, good or bad', async () => {
        await connectOk();
        const pending = [];
        routes['/connected'] = ({ key }) => (key === KEY
            ? new Promise((resolve, reject) => pending.push({ resolve, reject }))
            : jsonResponse({ connected: true }));
        const slowNo = pollHandyConnected();
        const slowMiss = pollHandyConnected();
        await tick(5);
        assert.equal(pending.length, 2);
        await connectHandy('second-key');
        pending[0].resolve(jsonResponse({ connected: false }));
        pending[1].reject(new TypeError('Failed to fetch'));
        assert.equal((await slowNo).state, 'stale');
        assert.equal((await slowMiss).state, 'stale');
        assert.equal(offline.length, 0, 'the old link\'s "offline" did not take down the new one');
        assert.equal(handyConnected, true);
        assert.equal(getHandyKey(), 'second-key');
        // Nor was the old link's miss counted against the new one.
        routes['/connected'] = () => { throw new TypeError('Failed to fetch'); };
        await pollHandyConnected();
        await pollHandyConnected();
        assert.equal(handyConnected, true, 'two misses of its own are not three');
    });

    // ---- what an offline verdict owes the motor -------------------------------------------

    it('a motor that never started is not chased with stops when the device goes offline (role OFF)', async () => {
        await connectOk();
        sessionActive = true;
        // Role OFF hands the driver a speed of 0 on every tick: nothing leaves.
        dispatchHandy(0, 20, 80, false, 0, 100);
        await tick(5);
        assert.equal(calls.length, 0);
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        await tick(HANDY_TIMINGS.offlineStopRetryMs * 3);
        assert.equal(sent('/hamp/stop').length, 0, 'no stop job for a motor that never turned');
        assert.equal(isHandyOfflineStopPending(), false);
        assert.equal(unconfirmed.length, 0, 'and no "may still be moving"');
    });

    it('nor is a motor whose stop was confirmed (a paused session)', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), false, 'PAUSE had its stop confirmed');
        calls = [];
        sessionActive = false;
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        await tick(HANDY_TIMINGS.offlineStopRetryMs * 3);
        assert.equal(sent('/hamp/stop').length, 0);
        assert.equal(unconfirmed.length, 0);
    });

    it('a motor that was running is chased, and the wearer is told it may still be moving', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        assert.ok(await waitFor(() => unconfirmed.length > 0), 'the first unanswered round is reported');
        assert.ok(sent('/hamp/stop').length >= 4);
        assert.equal(isHandyOfflineStopPending(), true);
    });

    it('a start still waiting for its slide range is not a turning motor', async () => {
        await connectOk();
        let releaseSlide;
        routes['PUT /slide'] = () => new Promise((resolve) => { releaseSlide = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 20, 80, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 0);
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        releaseSlide();
        await tick(HANDY_TIMINGS.offlineStopRetryMs * 2);
        assert.equal(sent('/hamp/start').length, 0, 'the start that was waiting never goes out');
        assert.equal(sent('/hamp/stop').length, 0);
        assert.equal(unconfirmed.length, 0);
    });

    it('a PUT /hamp/start on its way is: the device may begin to turn at any moment', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        await pollHandyConnected();
        assert.ok(await waitFor(() => unconfirmed.length > 0));
        assert.equal(isHandyOfflineStopPending(), true);
        // The start lands after the link was dropped: it is stopped again
        // with the key it went out with, and that stop goes unanswered too.
        releaseStart();
        assert.ok(await waitFor(() => unconfirmed.length > 1), 'the late start is chased and reported as well');
        assert.equal(isHandyMoving(), false);
    });

    it('so is a start whose answer never came: its motion is unknown', async () => {
        await connectOk();
        HANDY_TIMINGS.requestTimeoutMs = 40;
        routes['PUT /hamp/start'] = () => new Promise(() => {});
        dispatchHandy(50, 0, 100, true, 0, 100);
        assert.ok(await waitFor(() => isHandyMotionUnknown()));
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        await pollHandyConnected();
        assert.ok(await waitFor(() => unconfirmed.length > 0));
        assert.equal(isHandyOfflineStopPending(), true);
    });

    it('after the keepalive stop on pagehide the motion is unknown, so an offline device is still chased', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(stopHandyOnUnload(), true);
        assert.equal(isHandyMoving(), false);
        assert.equal(isHandyMotionUnknown(), true, 'nobody read the answer to that stop');
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        await pollHandyConnected();
        assert.ok(await waitFor(() => unconfirmed.length > 0));
        assert.equal(isHandyOfflineStopPending(), true);
    });

    it('a page that comes back idle after its keepalive stop confirms it with a verified one', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        stopHandyOnUnload();
        calls = [];
        // The IDLE tick: an unforced zero after the throttle window.
        await tick(410);
        dispatchHandy(0, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(sent('/hamp/stop')[0].keepalive, false);
        assert.equal(isHandyMotionUnknown(), false);
    });

    // ---- when an unconfirmed stop is worth an alarm ------------------------------------------

    it('an unanswered forced stop to a motor that never turned is an API error, not "may still be moving"', async () => {
        await connectOk();
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        // STOP or Reset in IDLE, PAUSE with role OFF: a forced zero.
        dispatchHandy(0, 0, 100, true, 0, 100);
        assert.ok(await waitFor(() => sent('/hamp/stop').length >= 4));
        await tick(20);
        assert.equal(sent('/hamp/stop').length, 4, 'the stop itself is still sent and retried');
        assert.equal(unconfirmed.length, 0);
        assert.match(errors[errors.length - 1], /Device timeout \(\/hamp\/stop\)/, 'the failure is still on the status line');
    });

    it('an unanswered forced stop to a running motor is the alarm, as before', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        dispatchHandy(0, 0, 100, true, 0, 100);
        assert.ok(await waitFor(() => unconfirmed.length > 0));
        assert.equal(unconfirmed.length, 1);
        assert.equal(isHandyMoving(), true, 'still flagged as moving');
    });

    it('Disconnect of an idle Handy that does not answer resolves true and warns nobody', async () => {
        await connectOk();
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        assert.equal(await disconnectHandy(), true, 'nothing needed stopping');
        assert.equal(sent('/hamp/stop').length, 4, 'the stop is still sent, with its retries');
        assert.ok(sent('/hamp/stop').every((c) => c.key === KEY));
        assert.equal(unconfirmed.length, 0);
    });

    it('a start that lands after a confirmed stop makes its re-stop one that must be confirmed', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        // PAUSE while the start is out; its stop is confirmed.
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(isHandyMoving(), false);
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        // The relay delivers the start after all: the motor may be turning.
        releaseStart();
        assert.ok(await waitFor(() => unconfirmed.length > 0), 'an unanswered re-stop after a late start is reported');
        assert.equal(sent('/hamp/stop').length, 5);
        assert.equal(isHandyMotionUnknown(), true, 'and the motion stays unknown until a stop is confirmed');
    });

    // ---- a start the API did not confirm ---------------------------------------------------

    it('a start the API answered with its device timeout may have moved the device: it is chased when the device goes offline', async () => {
        await connectOk();
        // The slide landed, so PUT /hamp/start went out; the API forwarded it
        // and heard nothing back within its timeout. Whether the device
        // started is exactly what nobody knows. This used to pass for a
        // start that never happened, and the device was left alone.
        routes['PUT /hamp/start'] = jsonResponse(DEVICE_TIMEOUT);
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(10);
        assert.equal(sent('/hamp/start').length, 1);
        assert.equal(isHandyMoving(), false);
        assert.equal(isHandyMotionUnknown(), true, 'the API did not confirm the start');
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        assert.equal(isHandyOfflineStopPending(), true, 'the device is chased');
        assert.ok(await waitFor(() => unconfirmed.length > 0), 'and the wearer is told it may still be moving');
        assert.ok(sent('/hamp/stop').length >= 4);
    });

    it('the same when the failed commands take the link offline instead', async () => {
        await connectOk();
        routes['PUT /hamp/start'] = jsonResponse(DEVICE_TIMEOUT);
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(10);
        assert.equal(isHandyMotionUnknown(), true);
        // The device answers nothing from here on: the dispatch counter takes
        // it offline, the way a dead device is found mid-session.
        routes['PUT /slide'] = jsonResponse(DEVICE_TIMEOUT);
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        for (let i = 0; i < 6 && offline.length === 0; i++) {
            dispatchHandy(50, 0, 100, true, 0, 100);
            await tick(10);
        }
        assert.equal(offline.length, 1);
        assert.match(offline[0], /stopped responding/);
        assert.equal(isHandyOfflineStopPending(), true);
        assert.ok(await waitFor(() => unconfirmed.length > 0));
    });

    it('and a PAUSE after it that the device leaves unanswered is the alarm', async () => {
        await connectOk();
        routes['PUT /hamp/start'] = jsonResponse(DEVICE_TIMEOUT);
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(10);
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        dispatchHandy(0, 0, 100, true, 0, 100);
        assert.ok(await waitFor(() => unconfirmed.length > 0));
        assert.equal(sent('/hamp/stop').length, 4);
    });

    it('a start the device then confirms settles the doubt', async () => {
        await connectOk();
        routes['PUT /hamp/start'] = jsonResponse(DEVICE_TIMEOUT);
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(10);
        assert.equal(isHandyMotionUnknown(), true);
        routes['PUT /hamp/start'] = jsonResponse({ result: 0 });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(10);
        assert.equal(isHandyMoving(), true);
        assert.equal(isHandyMotionUnknown(), false);
    });

    it('a start the API refused because the device was not connected moved nothing: no chase, no alarm', async () => {
        await connectOk();
        // The device dropped off Wi-Fi between the slide and the start; the
        // API had no device to forward the start to, and says so.
        routes['PUT /hamp/start'] = jsonResponse(DEVICE_NOT_CONNECTED);
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(10);
        assert.equal(sent('/hamp/start').length, 1);
        assert.equal(isHandyMotionUnknown(), false, 'the API said the device never got it');
        assert.match(errors[errors.length - 1], /Device not connected \(\/hamp\/start\)/, 'the failure is on the status line');
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_NOT_CONNECTED);
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        await tick(HANDY_TIMINGS.offlineStopRetryMs * 2);
        assert.equal(sent('/hamp/stop').length, 0);
        assert.equal(isHandyOfflineStopPending(), false);
        assert.equal(unconfirmed.length, 0);
    });

    it('a start answered behind a stop is stopped again unless the API said the device never got it', async () => {
        await connectOk();
        let answerStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { answerStart = (body) => resolve(jsonResponse(body)); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        // PAUSE while the start is out; its stop is confirmed at once.
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        // The API had no device to forward the start to: nothing to undo.
        answerStart(DEVICE_NOT_CONNECTED);
        await tick(20);
        assert.equal(sent('/hamp/stop').length, 1, 'no re-stop for a start that reached no device');
        assert.equal(isHandyMotionUnknown(), false);

        // The same, but the API heard nothing back from the device: the start
        // may yet reach it after the stop, so a fresh stop follows.
        calls = [];
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { answerStart = (body) => resolve(jsonResponse(body)); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        answerStart(DEVICE_TIMEOUT);
        assert.ok(await waitFor(() => sent('/hamp/stop').length === 2), 'a fresh stop follows the doubtful start');
        await tick(10);
        assert.equal(isHandyMotionUnknown(), false, 'and its confirmation settles the motion');
    });

    // ---- a start that lands while the pause's stop is still out -----------------------------

    it('a start that lands while the pause\'s stop is still out: that stop\'s confirmation settles nothing, the fresh one must', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        // PAUSE while the start is out: its stop is slow too, and every stop
        // after it goes unanswered - the device dies right then.
        let releaseStop;
        let stops = 0;
        routes['PUT /hamp/stop'] = () => {
            stops += 1;
            if (stops === 1) return new Promise((resolve) => { releaseStop = () => resolve(jsonResponse({ result: 0 })); });
            return jsonResponse(DEVICE_TIMEOUT);
        };
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        // The device answers in order, so the start lands first, with the
        // pause's stop still out.
        releaseStart();
        await tick(5);
        assert.equal(isHandyMotionUnknown(), true);
        // The pause's stop is confirmed. It was sent before anyone knew what
        // became of the start, so it settles nothing: the fresh stop goes
        // out and, unanswered, is the alarm. It used to be the other way
        // round - the confirmation cleared the doubt, the fresh stop went out
        // as one nobody needed to hear back from, and nothing was reported.
        releaseStop();
        assert.ok(await waitFor(() => unconfirmed.length > 0), 'the unanswered fresh stop is reported');
        assert.equal(sent('/hamp/stop').length, 5);
        assert.equal(isHandyMotionUnknown(), true, 'the doubt stands');
        // And an offline verdict now chases the device. The chase's first
        // round is let finish: a round still in flight when the test ends
        // would land its stops in the next test's call log.
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        assert.equal(isHandyOfflineStopPending(), true);
        assert.ok(await waitFor(() => unconfirmed.length === 2), 'and its first unanswered round is reported too');
    });

    it('the same when the start times out on our side while that stop is out', async () => {
        await connectOk();
        HANDY_TIMINGS.requestTimeoutMs = 40;
        routes['PUT /hamp/start'] = () => new Promise(() => {});
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        // The pause's stop has to outlive the start's timeout: give it the
        // shipped one.
        HANDY_TIMINGS.requestTimeoutMs = 6000;
        let releaseStop;
        let stops = 0;
        routes['PUT /hamp/stop'] = () => {
            stops += 1;
            if (stops === 1) return new Promise((resolve) => { releaseStop = () => resolve(jsonResponse({ result: 0 })); });
            return jsonResponse(DEVICE_TIMEOUT);
        };
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.ok(await waitFor(() => isHandyMotionUnknown()), 'the start timed out behind the stop');
        releaseStop();
        assert.ok(await waitFor(() => unconfirmed.length > 0));
        assert.equal(isHandyMotionUnknown(), true);
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), true);
        // Let the chase's first round finish before the next test starts.
        assert.ok(await waitFor(() => unconfirmed.length === 2));
    });

    it('and when the fresh stop is confirmed the motion is known stopped again', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        let releaseStop;
        let stops = 0;
        routes['PUT /hamp/stop'] = () => {
            stops += 1;
            if (stops === 1) return new Promise((resolve) => { releaseStop = () => resolve(jsonResponse({ result: 0 })); });
            return jsonResponse({ result: 0 });
        };
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        releaseStart();
        await tick(5);
        releaseStop();
        assert.ok(await waitFor(() => sent('/hamp/stop').length === 2 && !isHandyMotionUnknown()), 'the fresh stop, confirmed, clears the doubt');
        assert.equal(unconfirmed.length, 0);
        // Nothing left to chase: an offline verdict now starts no stop job.
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), false);
    });

    // ---- Connect again with the key already in use ------------------------------------------
    //
    // The README tells the wearer to press Connect Handy again, with the
    // same key, after an API error. That key names the same device, so what
    // the old link still owed its motor must count on the new link. It used
    // to live in flags of the link, which every change of link clears.

    // The tests below look at the background stop job's first round only. A
    // second one, 80 ms later, could still be sending when a test ends and
    // land its stops in the next test's call log; this puts it out of reach.
    const ONE_CHASE_ROUND = 5000;

    // A PUT /hamp/start held until `release` is called with a body, or with
    // an Error to fail it on the network.
    function holdStart() {
        const held = {};
        routes['PUT /hamp/start'] = () => new Promise((resolve, reject) => {
            held.release = (outcome = { result: 0 }) => (outcome instanceof Error ? reject(outcome) : resolve(jsonResponse(outcome)));
        });
        return held;
    }

    // The reconnect's own stop is answered, the one for the old link is held
    // until `release` is called, and every stop after that goes unanswered:
    // the device dies right then.
    function holdSwitchStop() {
        const held = {};
        let stops = 0;
        routes['PUT /hamp/stop'] = () => {
            stops += 1;
            if (stops === 1) return jsonResponse({ result: 0 });
            if (stops === 2) return new Promise((resolve) => { held.release = () => resolve(jsonResponse({ result: 0 })); });
            return jsonResponse(DEVICE_TIMEOUT);
        };
        return held;
    }

    it('a start that lands behind the switching stop of a same-key reconnect is still owed a confirmed stop', async () => {
        await connectOk();
        HANDY_TIMINGS.offlineStopRetryMs = ONE_CHASE_ROUND;
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        const switchStop = holdSwitchStop();
        const reconnect = connectHandy(KEY);
        assert.ok(await waitFor(() => typeof switchStop.release === 'function'), 'the old link is being stopped');
        // The start lands while that stop is out, so it may have reached the
        // device after it; then the stop is confirmed and the link is made
        // again.
        start.release();
        await tick(5);
        switchStop.release();
        await reconnect;
        assert.equal(getHandyKey(), KEY);
        // The fresh stop goes out on the new link and, unanswered, is the
        // alarm. It used to be neither: the change of link cleared the
        // doubt while the switching stop was out, and the fresh stop went
        // out as one nobody needed to hear back from.
        assert.ok(await waitFor(() => unconfirmed.length > 0), 'the unanswered fresh stop is reported');
        assert.equal(sent('/hamp/stop').length, 6, 'verification, switch, and the fresh stop\'s four attempts');
        assert.equal(isHandyMotionUnknown(), true, 'the doubt stands on the new link');
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), true, 'and an offline verdict chases the device');
        // Let the chase's first round finish before the next test starts.
        assert.ok(await waitFor(() => unconfirmed.length === 2));
    });

    it('the same when that start fails on the network instead of landing', async () => {
        await connectOk();
        HANDY_TIMINGS.offlineStopRetryMs = ONE_CHASE_ROUND;
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        const switchStop = holdSwitchStop();
        const reconnect = connectHandy(KEY);
        assert.ok(await waitFor(() => typeof switchStop.release === 'function'));
        // A request lost on the way back may still have been carried out.
        start.release(new TypeError('Failed to fetch'));
        await tick(5);
        switchStop.release();
        await reconnect;
        assert.ok(await waitFor(() => unconfirmed.length > 0));
        assert.equal(isHandyMotionUnknown(), true);
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), true);
        assert.ok(await waitFor(() => unconfirmed.length === 2));
    });

    it('a start still on its way when the same key is connected again counts on the new link', async () => {
        await connectOk();
        HANDY_TIMINGS.offlineStopRetryMs = ONE_CHASE_ROUND;
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        // Every stop of the reconnect is answered before the start is.
        await connectHandy(KEY);
        assert.equal(sent('/hamp/stop').length, 2);
        // The device dies with the start still out: it may begin to turn at
        // any moment, so it is chased and the wearer is warned. The new link
        // used to know nothing of that start until it came back.
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        assert.equal(isHandyOfflineStopPending(), true, 'the device is chased');
        assert.ok(await waitFor(() => unconfirmed.length > 0), 'and the wearer is told it may still be moving');
        // The start lands after all and is stopped again with its key.
        start.release();
        assert.ok(await waitFor(() => unconfirmed.length === 2));
        assert.ok(calls.filter((c) => c.path === '/hamp/stop').every((c) => c.key === KEY));
    });

    it('so does one still out after Disconnect, when the same key is connected again', async () => {
        await connectOk();
        HANDY_TIMINGS.offlineStopRetryMs = ONE_CHASE_ROUND;
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(await disconnectHandy(), true);
        await connectOk();
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), true);
        assert.ok(await waitFor(() => unconfirmed.length > 0));
        start.release();
        assert.ok(await waitFor(() => unconfirmed.length === 2));
    });

    it('and one still out after an offline verdict, when the device is back and connected again', async () => {
        await connectOk();
        HANDY_TIMINGS.offlineStopRetryMs = ONE_CHASE_ROUND;
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        // Back, and connected again with the same key; the chase for the old
        // link ends with it.
        routes['/connected'] = jsonResponse({ connected: true });
        await connectHandy(KEY);
        assert.equal(isHandyOfflineStopPending(), false);
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        await pollHandyConnected();
        assert.equal(offline.length, 2);
        assert.equal(isHandyOfflineStopPending(), true, 'the start still out is chased');
        assert.ok(await waitFor(() => unconfirmed.length > 0));
        start.release();
        assert.ok(await waitFor(() => unconfirmed.length === 2));
    });

    // Connect again with the same key while a start is out; the start is
    // answered with `startAnswer` after the new key's stop has left. The
    // device then drops off while /info is out, so the reconnect finds no
    // live link to stop, and the chase goes unanswered until the device
    // answers again and the reconnect completes, ending the chase. Nothing
    // has stopped the motor since the start came back.
    async function startAnsweredAcrossAReconnect(startAnswer) {
        await connectOk();
        // The chase must not get to a second round here either: a stop it had
        // confirmed would settle the motor for a reason of its own.
        HANDY_TIMINGS.offlineStopRetryMs = ONE_CHASE_ROUND;
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        let releaseInfo;
        routes['/info'] = () => new Promise((resolve) => { releaseInfo = () => resolve(jsonResponse({ fwVersion: '3.2.3' })); });
        const reconnect = connectHandy(KEY);
        assert.ok(await waitFor(() => typeof releaseInfo === 'function'), 'the new key\'s stop has left');
        start.release(startAnswer);
        await tick(5);
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        await pollHandyConnected();
        assert.ok(await waitFor(() => unconfirmed.length > 0), 'the device was chased');
        routes['/connected'] = jsonResponse({ connected: true });
        routes['PUT /hamp/stop'] = undefined;
        releaseInfo();
        await reconnect;
        assert.equal(isHandyOfflineStopPending(), false);
        assert.equal(isHandyMotionUnknown(), true, 'the new link knows the motor may be running');
        // The paused session's next zero sends a verified stop. It used to
        // send nothing, and the motor kept running under a paused session.
        calls = [];
        dispatchHandy(0, 0, 100, false, 0, 100);
        await tick(10);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(isHandyMotionUnknown(), false);
    }

    it('a start confirmed after a reconnect\'s verification stop left still has to be stopped on the new link', async () => {
        await startAnsweredAcrossAReconnect({ result: 0 });
    });

    it('so does one the API answered with its device timeout', async () => {
        await startAnsweredAcrossAReconnect(DEVICE_TIMEOUT);
    });

    // A start lands while the pause's stop is held; the next zero sends a
    // fresh stop, which the device confirms. Resolves the release of the
    // pause's stop.
    async function lateStartSettledByAFreshStop() {
        await connectOk();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        let releasePauseStop;
        let stops = 0;
        routes['PUT /hamp/stop'] = () => {
            stops += 1;
            if (stops === 1) return new Promise((resolve) => { releasePauseStop = () => resolve(jsonResponse({ result: 0 })); });
            return jsonResponse({ result: 0 });
        };
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        start.release();
        await tick(5);
        assert.equal(isHandyMotionUnknown(), true);
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 2);
        assert.equal(isHandyMotionUnknown(), false, 'a stop sent after the start came back settles it');
        return releasePauseStop;
    }

    it('a stop that left after the late start and was confirmed settles it, whatever link sent it', async () => {
        const releasePauseStop = await lateStartSettledByAFreshStop();
        // Connect again with the same key; the pause's stop is answered only
        // then, and the device dies before the re-stop that follows it. The
        // motor was confirmed at rest after the start: this is not the day
        // "may still be moving" is true.
        await connectHandy(KEY);
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        releasePauseStop();
        assert.ok(await waitFor(() => sent('/hamp/stop').length === 7), 'the re-stop still goes out, four times');
        await tick(20);
        assert.equal(unconfirmed.length, 0);
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), false, 'and nothing is chased');
    });

    it('and the same when the link is let go instead: the re-stop to a settled motor is no alarm', async () => {
        const releasePauseStop = await lateStartSettledByAFreshStop();
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        assert.equal(await disconnectHandy(), true, 'the motor was confirmed at rest');
        releasePauseStop();
        assert.ok(await waitFor(() => sent('/hamp/stop').length === 10), 'Disconnect\'s four attempts, then the re-stop\'s');
        assert.ok(sent('/hamp/stop').every((c) => c.key === KEY));
        await tick(20);
        assert.equal(unconfirmed.length, 0);
    });

    it('a retry of the pause\'s stop that left after the start came back is a stop that start has had', async () => {
        await connectOk();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        // PAUSE while the start is out. The first attempt of its stop is
        // lost on the way; the start lands meanwhile; the retry, which left
        // after it, is confirmed. Every stop after that goes unanswered.
        let loseFirstAttempt;
        let stops = 0;
        routes['PUT /hamp/stop'] = () => {
            stops += 1;
            if (stops === 1) return new Promise((resolve, reject) => { loseFirstAttempt = () => reject(new TypeError('Failed to fetch')); });
            if (stops === 2) return jsonResponse({ result: 0 });
            return jsonResponse(DEVICE_TIMEOUT);
        };
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        start.release();
        await tick(5);
        assert.equal(isHandyMotionUnknown(), true);
        loseFirstAttempt();
        // The re-stop still follows the pause's stop and meets a dead device,
        // but the motor was confirmed at rest after the start came back.
        assert.ok(await waitFor(() => sent('/hamp/stop').length === 6), 'two attempts, then the re-stop\'s four');
        await tick(20);
        assert.equal(isHandyMotionUnknown(), false);
        assert.equal(unconfirmed.length, 0);
    });

    // The start lands while the pause's stop is out, and the device stops
    // answering the stops sent after it: the late start is still owed one.
    async function lateStartLeftUnsettled() {
        await connectOk();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? jsonResponse(DEVICE_TIMEOUT) : jsonResponse({ result: 0 }));
        start.release();
        assert.ok(await waitFor(() => unconfirmed.length === 1), 'the fresh stop goes unanswered');
        assert.equal(isHandyMotionUnknown(), true);
    }

    it('a switch to another key first has the old device confirm a stop for its late start, or leaves the link as it was', async () => {
        await lateStartLeftUnsettled();
        await assert.rejects(connectHandy('second-key'), /did not confirm a stop/);
        assert.equal(getHandyKey(), KEY, 'STOP still reaches the device that may be moving');
        assert.equal(unconfirmed.length, 2);
    });

    it('the page going away sends its keepalive stop while a late start is unsettled', async () => {
        await lateStartLeftUnsettled();
        calls = [];
        assert.equal(stopHandyOnUnload(), true);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(sent('/hamp/stop')[0].keepalive, true);
    });

    it('the verification stop of a new connection settles a start that came back before it left', async () => {
        await connectOk();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        assert.equal(await disconnectHandy(), false, 'a start was out: the unanswered stop is the alarm');
        // The start lands after Disconnect; the stop sent after it goes
        // unanswered as well.
        start.release();
        assert.ok(await waitFor(() => unconfirmed.length === 2));
        // The device answers again and is connected with the same key: the
        // new key's stop left after the start came back, and was confirmed.
        routes['PUT /hamp/stop'] = undefined;
        await connectOk();
        assert.equal(isHandyMotionUnknown(), false);
        routes['/connected'] = jsonResponse({ connected: false });
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), false, 'nothing left to chase');
        assert.equal(unconfirmed.length, 2);
    });

    it('a doubt stays with its own device: another key neither takes it over nor drops it', async () => {
        await connectOk();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        let releaseSwitchStop;
        routes['PUT /hamp/stop'] = ({ key }) => {
            if (key !== KEY) return jsonResponse({ result: 0 });
            if (!releaseSwitchStop) return new Promise((resolve) => { releaseSwitchStop = () => resolve(jsonResponse({ result: 0 })); });
            return jsonResponse(DEVICE_TIMEOUT);
        };
        const reconnect = connectHandy('second-key');
        assert.ok(await waitFor(() => typeof releaseSwitchStop === 'function'));
        start.release();
        await tick(5);
        releaseSwitchStop();
        await reconnect;
        assert.equal(getHandyKey(), 'second-key');
        // The old device's fresh stop goes out with its own key and,
        // unanswered, is the alarm.
        assert.ok(await waitFor(() => unconfirmed.length === 1));
        assert.equal(calls.filter((c) => c.path === '/hamp/stop' && c.key === KEY).length, 5, 'the switch, then four attempts');
        // The new device has had no start: nothing is owed to it.
        assert.equal(isHandyMotionUnknown(), false);
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), false);
        assert.equal(calls.filter((c) => c.path === '/hamp/stop' && c.key === 'second-key').length, 1, 'only its verification stop');
    });
});
