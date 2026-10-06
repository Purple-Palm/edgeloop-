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
    stopHandyAfterCrash,
    resetHandyCrashStopsForTests,
    pollHandyConnected,
    handyPollTick,
    queryHandyBattery,
    setHandyHandlers,
    getHandyKey,
    isHandyMoving,
    isHandyMotionUnknown,
    isHandyOfflineStopPending,
    handyRestState,
    handyStopTally,
    resetHandyRestForTests,
    handyMayBeMoving,
    handyConnected
} from './handy.js';
import { HANDY_API_BASE, HANDY_MIN_VELOCITY, handyTargetSpeed, applyEndMargin, normalizeSlideRange } from './handy-protocol.js';
import { createHandyStopReport } from './handy-stop-report.js';
import { calculateEngineOutputs } from '../engine.js';
import { tickRuinAndStallGuard, startRuinEdge } from '../session-rules.js';
import { createTickDispatch, guardEngagedBy } from '../tick-dispatch.js';
import { RUIN_LOCK_SECONDARY } from '../patterns.js';

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
// The key each unconfirmed stop was reported for, and the key of every stop
// the API confirmed, in order.
let unconfirmedKeys = [];
let confirmedKeys = [];
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
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) await tick(5);
    return cond();
}

// Waits until `condition()` holds, for a retry chain whose length depends on
// how busy the machine is, and fails the test with `what` if it never does.
async function until(condition, what, timeoutMs = 3000) {
    const started = Date.now();
    while (!condition()) {
        assert.ok(Date.now() - started < timeoutMs, `timed out waiting for ${what}`);
        await tick(5);
    }
}

async function connectOk() {
    routes['/connected'] = jsonResponse({ connected: true });
    routes['/info'] = jsonResponse({ fwVersion: '3.2.3', model: 'Handy 1.1' });
    const result = await connectHandy(KEY);
    calls = [];
    confirmedKeys = [];
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
        unconfirmedKeys = [];
        confirmedKeys = [];
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
        // Longer than any test runs, unless a test sets its own.
        HANDY_TIMINGS.crashStopWindowMs = 60000;
        // What the last test left on its way, or in doubt, is not this one's.
        resetHandyRestForTests();
        installFetch();
        setHandyHandlers({
            onError: (m) => errors.push(m),
            onOffline: (r) => offline.push(r),
            onStopUnconfirmed: (m, key) => { unconfirmed.push(m); unconfirmedKeys.push(key); },
            onStopConfirmed: (key) => confirmedKeys.push(key),
            onNotice: (m) => notices.push(m),
            isSessionActive: () => sessionActive
        });
    });

    afterEach(async () => {
        routes = {};
        resetHandyCrashStopsForTests();
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

    it('never throttles a stop: a cut right after a dispatch goes out on its own dispatch', async () => {
        await connectOk();
        dispatchHandy(40, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);
        // A few ms later, well inside the 400 ms window, the engine cuts.
        dispatchHandy(0, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(isHandyMoving(), false);
        // The start that follows still waits out the throttle.
        dispatchHandy(40, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
    });

    it('keeps the throttle for a slowdown that is not a stop', async () => {
        await connectOk();
        dispatchHandy(60, 0, 100, false, 0, 100);
        await tick(5);
        dispatchHandy(1, 0, 100, false, 0, 100);
        await tick(5);
        assert.deepEqual(sent('/hamp/velocity').map((c) => c.body.velocity), [60]);
        assert.equal(sent('/hamp/stop').length, 0);
    });

    it('never throttles an urgent dispatch, whatever speed it carries', async () => {
        // A Handy that follows the secondary channel, on the second the Ruin
        // lockout begins: the ride's 51% went out on a packet 200 ms before,
        // and the lockout drops the channel to 18%.
        await connectOk();
        dispatchHandy(51, 0, 60, false, 0, 100);
        await tick(5);
        dispatchHandy(18, 0, 100, false, 0, 100, 5, { urgent: true });
        await tick(5);
        assert.deepEqual(sent('/hamp/velocity').map((c) => c.body.velocity), [51, 18]);
        // The end-stop margin moves 0-60 off the end stop, keeping its length.
        assert.deepEqual(sent('/slide').map((c) => [c.body.min, c.body.max]), [[5, 65], [5, 95]]);
        assert.equal(sent('/hamp/stop').length, 0, 'a slowdown, not a stop');
        // The throttle's clock restarts from it: an ordinary change right
        // after it still waits.
        dispatchHandy(30, 0, 100, false, 0, 100);
        await tick(5);
        assert.deepEqual(sent('/hamp/velocity').map((c) => c.body.velocity), [51, 18]);
    });

    it('an urgent dispatch that changes nothing on this device sends nothing', async () => {
        // A stall guard cut leaves the secondary channel where it was, so a
        // Handy that follows it has nothing new to be sent.
        await connectOk();
        dispatchHandy(40, 0, 100, false, 0, 100);
        await tick(5);
        const before = calls.length;
        dispatchHandy(40, 0, 100, false, 0, 100, 5, { urgent: true });
        await tick(5);
        assert.equal(calls.length, before);
    });

    it('an urgent zero stops only a device that may be moving', async () => {
        await connectOk();
        dispatchHandy(0, 0, 100, false, 0, 100, 5, { urgent: true });
        await tick(5);
        assert.equal(calls.length, 0);
    });

    it('a zero sends nothing when nothing may be moving', async () => {
        await connectOk();
        dispatchHandy(0, 0, 100, false, 0, 100);
        dispatchHandy(0, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(calls.length, 0);
    });

    it('sends one stop while one is in flight, however many zero dispatches arrive', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, false, 0, 100);
        await tick(5);
        let release;
        routes['PUT /hamp/stop'] = () => new Promise((resolve) => { release = () => resolve(jsonResponse({ result: 0 })); });
        for (let i = 0; i < 5; i++) {
            dispatchHandy(0, 0, 100, false, 0, 100);
            await tick(1);
        }
        assert.equal(sent('/hamp/stop').length, 1);
        release();
        await tick(5);
        assert.equal(isHandyMoving(), false);
        dispatchHandy(0, 0, 100, false, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
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

    // ---- which device a stop report is about ------------------------------------------
    //
    // app.js keeps "The Handy did not confirm a stop and may still be moving"
    // on the banner until the device it is about has confirmed a stop. That
    // is not always the device connected now, and the driver's "the failing
    // call went through" (onError null) names no key at all, so both stop
    // reports carry the key the stop was sent to.

    // The page's record of which Handys owe a stop, fed from the driver's two
    // stop reports the way app.js feeds it: its sentence is what the banner
    // says about them, and null is nothing.
    function wireStopReport() {
        const report = createHandyStopReport();
        setHandyHandlers({
            onStopUnconfirmed: (m, key) => { unconfirmed.push(m); unconfirmedKeys.push(key); report.unconfirmed(key, m); },
            onStopConfirmed: (key) => { confirmedKeys.push(key); report.confirmed(key); }
        });
        return report;
    }

    it('names the key of every stop the API confirms, whoever sent it', async () => {
        routes['/connected'] = jsonResponse({ connected: true });
        routes['/info'] = jsonResponse({});
        await connectHandy(KEY);
        assert.deepEqual(confirmedKeys, [KEY], 'the stop that verifies the key');
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => confirmedKeys.length === 2, 'the pause');
        assert.deepEqual(confirmedKeys, [KEY, KEY]);
        assert.equal(await disconnectHandy(), true);
        assert.equal(getHandyKey(), '', 'Disconnect drops the key before its stop is answered');
        assert.deepEqual(confirmedKeys, [KEY, KEY, KEY], 'and its stop is still reported for that key');
        assert.deepEqual(unconfirmed, []);
    });

    it('reports a pause that went unconfirmed, and the retry that went through, for the same key', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        routes['PUT /hamp/stop'] = jsonResponse(null, 503);
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => unconfirmedKeys.length === 1, 'the unconfirmed stop');
        assert.deepEqual(unconfirmedKeys, [KEY]);
        assert.deepEqual(confirmedKeys, []);
        assert.equal(isHandyMoving(), true, 'still owed its stop');
        // The next zero dispatch of the paused session retries it.
        routes['PUT /hamp/stop'] = undefined;
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => confirmedKeys.length === 1, 'the retried stop');
        assert.deepEqual(confirmedKeys, [KEY]);
        assert.equal(isHandyMoving(), false);
    });

    it('reports an unconfirmed Disconnect stop for the key it dropped', async () => {
        await connectOk();
        // A motor that was running: an unanswered stop to one that never
        // turned warns nobody (Disconnect of an idle Handy, below).
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        routes['PUT /hamp/stop'] = jsonResponse(null, 503);
        assert.equal(await disconnectHandy(), false);
        assert.equal(getHandyKey(), '');
        assert.deepEqual(unconfirmedKeys, [KEY]);
        assert.deepEqual(confirmedKeys, []);
    });

    it('does not report a stop that left before a late start came back as confirmed, to the page or to itself', async () => {
        // The page and the driver read one fact (noteStopConfirmed): the
        // pause's stop, answered after a start that landed behind it, says
        // nothing about the motor now, so "may still be moving" must not end
        // on it any more than the driver's own record of the start does.
        await connectOk();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => sent('/hamp/start').length === 1, 'the start going out');
        let releasePauseStop;
        let stops = 0;
        routes['PUT /hamp/stop'] = () => {
            stops += 1;
            if (stops === 1) return new Promise((resolve) => { releasePauseStop = () => resolve(jsonResponse({ result: 0 })); });
            return jsonResponse(DEVICE_TIMEOUT);
        };
        // PAUSE while the start is out; the start lands behind its stop, and
        // that stop is answered only then.
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => typeof releasePauseStop === 'function', 'the pause\'s stop going out');
        start.release();
        await tick(5);
        releasePauseStop();
        // The stop sent after the start came back goes unanswered.
        await until(() => unconfirmedKeys.length === 1, 'the stop after the late start');
        assert.deepEqual(unconfirmedKeys, [KEY]);
        assert.deepEqual(confirmedKeys, [], 'the pause\'s stop left before the start came back');
        assert.equal(isHandyMotionUnknown(), true, 'and the driver holds the same view');
        // The device answers again: the paused session's next zero is a stop
        // sent after the start, and both hear that it was confirmed.
        routes['PUT /hamp/stop'] = undefined;
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => confirmedKeys.length === 1, 'the retried stop');
        assert.deepEqual(confirmedKeys, [KEY]);
        assert.equal(isHandyMotionUnknown(), false);
    });

    it('nor a stop confirmed while a start is still on its way: the report stands until that start is accounted for', async () => {
        // PAUSE while a start is out goes unanswered and is reported; the
        // paused session's next stop is confirmed with the start still out.
        // The start may reach the device after that stop, so the page keeps
        // "may still be moving" up, as the driver keeps the motor owed a
        // stop. Taken down there, the banner would say nothing over the
        // paused session until the start came back and the stop after it
        // failed.
        await connectOk();
        const report = wireStopReport();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => sent('/hamp/start').length === 1, 'the start going out');
        routes['PUT /hamp/stop'] = jsonResponse(null, 503);
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => unconfirmedKeys.length === 1, 'the pause');
        const warning = report.sentence();
        assert.match(warning, /may still be moving/);
        routes['PUT /hamp/stop'] = undefined;
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => sent('/hamp/stop').length === 5, 'the next stop');
        await tick(20);
        assert.deepEqual(confirmedKeys, [], 'confirmed with the start still out');
        assert.equal(report.sentence(), warning, 'the report stands');
        // The start comes back, having set the motor going: the stop sent
        // after it is the one that settles the device, and the report.
        start.release();
        await until(() => confirmedKeys.length === 1, 'the stop after the start came back');
        assert.deepEqual(confirmedKeys, [KEY]);
        assert.equal(sent('/hamp/stop').length, 6);
        assert.equal(report.sentence(), null);
        assert.deepEqual(unconfirmedKeys, [KEY]);
    });

    it('reports the background stop of an offline Handy as confirmed after a Connect failed on /connected', async () => {
        // The last error shown is then the Connect's /connected, so this
        // stop going through is not "the failing call went through", and
        // before it had a report of its own nobody heard of it.
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        const fail = () => { throw new TypeError('Failed to fetch'); };
        routes['PUT /slide'] = fail;
        routes['PUT /hamp/velocity'] = fail;
        routes['PUT /hamp/stop'] = fail;
        for (let i = 0; i < 5; i++) {
            dispatchHandy(50 + i, 0, 100, true, 0, 100);
            await tick(5);
        }
        await until(() => offline.length === 1, 'the device going offline');
        await until(() => unconfirmedKeys.length === 1, 'the first background round');
        assert.deepEqual(unconfirmedKeys, [KEY]);
        // The wearer tries Connect while the API is still down.
        routes['/connected'] = fail;
        await assert.rejects(connectHandy(KEY), /Network error \(\/connected\)/);
        assert.equal(isHandyOfflineStopPending(), true, 'a failed Connect leaves the background stop running');
        assert.deepEqual(confirmedKeys, []);
        // The API is back: a later round's stop goes through.
        routes['PUT /hamp/stop'] = undefined;
        await until(() => confirmedKeys.length === 1 && !isHandyOfflineStopPending(), 'the background stop');
        assert.deepEqual(confirmedKeys, [KEY]);
    });

    // ---- a Handy that went offline, let go before its first round of stops came back ----
    //
    // The background job reports an offline device when its first round of
    // stops goes unconfirmed, and a round that Connect or Disconnect cancels
    // reports nothing. The page takes the lost-link report down on every
    // Connect that goes through, so a second Handy connected while that round
    // was still out left the first one, running when its link died, with no
    // report at all, and no round of stops after the one that was out.

    // KEY runs and is found offline. Every stop to it is held until answered
    // by hand, and the background job's first one is out. Resolves the list
    // of held answers.
    async function offlineWithTheFirstStopOut() {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        const held = [];
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY
            ? new Promise((resolve) => held.push(resolve))
            : jsonResponse({ result: 0 }));
        routes['/connected'] = ({ key }) => jsonResponse({ connected: key !== KEY });
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        await until(() => held.length === 1, 'the first stop of the background job');
        assert.equal(isHandyOfflineStopPending(), true);
        assert.deepEqual(unconfirmedKeys, [], 'its first round has not come back');
        return held;
    }

    const stopsTo = (key) => sent('/hamp/stop').filter((c) => c.key === key);

    it('reports an offline Handy for its own key when another key is connected before its first round of stops came back', async () => {
        const held = await offlineWithTheFirstStopOut();
        await connectHandy('second-key');
        assert.equal(getHandyKey(), 'second-key');
        assert.equal(isHandyOfflineStopPending(), false, 'no round of stops to it follows');
        assert.deepEqual(unconfirmedKeys, [KEY], 'so it is reported as the Connect ends its stops, for its own key');
        assert.match(unconfirmed[0], /^Stop not confirmed: another Handy was connected while the one that went offline was still being sent stops$/);
        assert.deepEqual(confirmedKeys, ['second-key']);
        // The rest of the round goes unanswered: no second report, no round after it.
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? jsonResponse(DEVICE_TIMEOUT) : jsonResponse({ result: 0 }));
        held[0](jsonResponse(DEVICE_TIMEOUT));
        await until(() => stopsTo(KEY).length === 4, 'the rest of the round');
        await tick(HANDY_TIMINGS.offlineStopRetryMs + 40);
        assert.equal(stopsTo(KEY).length, 4);
        assert.deepEqual(unconfirmedKeys, [KEY]);
    });

    it('and a stop of that round the API confirms afterwards is reported as confirmed for it', async () => {
        const held = await offlineWithTheFirstStopOut();
        await connectHandy('second-key');
        assert.deepEqual(unconfirmedKeys, [KEY]);
        held[0](jsonResponse({ result: 0 }));
        await until(() => confirmedKeys.length === 2, 'the late confirmation');
        assert.deepEqual(confirmedKeys, ['second-key', KEY], 'which is what takes the report down again');
        assert.equal(stopsTo(KEY).length, 1);
        assert.deepEqual(unconfirmedKeys, [KEY]);
    });

    it('a Connect with that same key reports nothing: the stop that verifies it is one that device confirmed', async () => {
        const held = await offlineWithTheFirstStopOut();
        // The device is back and answers the verification while the round's
        // first stop is still out.
        routes['/connected'] = jsonResponse({ connected: true });
        routes['PUT /hamp/stop'] = jsonResponse({ result: 0 });
        await connectHandy(KEY);
        assert.equal(isHandyOfflineStopPending(), false);
        assert.deepEqual(confirmedKeys, [KEY]);
        assert.deepEqual(unconfirmedKeys, []);
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        held[0](jsonResponse(DEVICE_TIMEOUT));
        await until(() => stopsTo(KEY).length === 5, 'the rest of the round');
        await tick(20);
        assert.deepEqual(unconfirmedKeys, [], 'nor does the rest of the round, unanswered');
        assert.equal(isHandyMotionUnknown(), false);
    });

    it('nor when a start to it came back after that verifying stop: the new link, on the same device, takes the doubt over', async () => {
        await connectOk();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => sent('/hamp/start').length === 1, 'the start going out');
        // The job's first stop and the one after the late start are held;
        // the verification's is answered; every later one goes unanswered.
        const held = [];
        let stops = 0;
        routes['PUT /hamp/stop'] = () => {
            stops += 1;
            if (stops === 1 || stops === 3) return new Promise((resolve) => held.push(resolve));
            return jsonResponse(stops === 2 ? { result: 0 } : DEVICE_TIMEOUT);
        };
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), true);
        await until(() => held.length === 1, 'the job\'s first stop');
        // Back, and connected again with the same key; the start lands after
        // the verification's stop, while /info is out.
        routes['/connected'] = jsonResponse({ connected: true });
        let releaseInfo;
        routes['/info'] = () => new Promise((resolve) => { releaseInfo = () => resolve(jsonResponse({ fwVersion: '3.2.3' })); });
        const reconnect = connectHandy(KEY);
        await until(() => typeof releaseInfo === 'function', 'the verification\'s stop');
        start.release();
        await until(() => held.length === 2, 'the stop after the late start');
        releaseInfo();
        await reconnect;
        assert.equal(isHandyOfflineStopPending(), false);
        assert.deepEqual(unconfirmedKeys, [], 'the Connect ends the job without a word');
        assert.equal(isHandyMotionUnknown(), true, 'the new link knows the motor may be turning');
        held[1](jsonResponse({ result: 0 }));
        await until(() => !isHandyMotionUnknown(), 'the stop after the late start');
        held[0](jsonResponse(DEVICE_TIMEOUT));
        await until(() => sent('/hamp/stop').length === 6, 'the rest of the round');
        await tick(20);
        assert.deepEqual(unconfirmedKeys, []);
    });

    it('nor one last seen confirmed at rest: a start that came back after the verdict, then a stop confirmed after it', async () => {
        // "May still be moving" is kept for a motor that may be turning. A
        // start still out when the link was found offline comes back, and the
        // stop sent after it is confirmed while the job's first stop is out.
        await connectOk();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => sent('/hamp/start').length === 1, 'the start going out');
        const held = [];
        let stops = 0;
        routes['PUT /hamp/stop'] = ({ key }) => {
            if (key !== KEY) return jsonResponse({ result: 0 });
            stops += 1;
            if (stops === 1) return new Promise((resolve) => held.push(resolve));
            return jsonResponse(stops === 2 ? { result: 0 } : DEVICE_TIMEOUT);
        };
        routes['/connected'] = ({ key }) => jsonResponse({ connected: key !== KEY });
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), true, 'a start on its way is chased');
        await until(() => held.length === 1, 'the job\'s first stop');
        start.release();
        await until(() => confirmedKeys.includes(KEY), 'the stop after the late start');
        await connectHandy('second-key');
        assert.equal(isHandyOfflineStopPending(), false);
        assert.deepEqual(unconfirmedKeys, [], 'a device confirmed at rest since is not reported');
        held[0](jsonResponse(DEVICE_TIMEOUT));
        await until(() => stopsTo(KEY).length === 5, 'the rest of the round');
        await tick(20);
        assert.deepEqual(unconfirmedKeys, []);
    });

    it('but one a start was still on its way to is: a stop confirmed before that start came back does not put the motor at rest', async () => {
        // The pause's stop, sent while a start was out, is confirmed once the
        // link has been found offline. The start may still reach the device
        // after it, so that stop settles nothing yet, for the driver or for
        // the page, and neither does a later one confirmed while the start is
        // still out.
        await connectOk();
        const report = wireStopReport();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => sent('/hamp/start').length === 1, 'the start going out');
        const held = [];
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY
            ? new Promise((resolve) => held.push(resolve))
            : jsonResponse({ result: 0 }));
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => held.length === 1, 'the pause\'s stop');
        routes['/connected'] = ({ key }) => jsonResponse({ connected: key !== KEY });
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), true, 'a start on its way is chased');
        await until(() => held.length === 2, 'the job\'s first stop');
        held[0](jsonResponse({ result: 0 }));
        await tick(20);
        assert.deepEqual(confirmedKeys, [], 'the pause\'s stop is confirmed with the start still out');
        await connectHandy('second-key');
        assert.equal(isHandyOfflineStopPending(), false);
        assert.deepEqual(unconfirmedKeys, [KEY], 'reported as the Connect ends its stops');
        const warning = report.sentence();
        assert.match(warning, /may still be moving/);
        // The round's next stop is confirmed, the start still out. Taking the
        // report down on it would leave the banner saying nothing over the
        // paused session while that start could still set the device going.
        routes['PUT /hamp/stop'] = jsonResponse({ result: 0 });
        held[1](jsonResponse(DEVICE_TIMEOUT));
        await until(() => stopsTo(KEY).length === 3, 'the rest of the round');
        await tick(20);
        assert.deepEqual(confirmedKeys, ['second-key']);
        assert.equal(report.sentence(), warning, 'the report stands');
        // The start comes back: the stop sent after it is the one that
        // settles the device, and takes the report down.
        start.release();
        await until(() => confirmedKeys.length === 2, 'the stop after the late start');
        assert.deepEqual(confirmedKeys, ['second-key', KEY]);
        assert.deepEqual(unconfirmedKeys, [KEY]);
        assert.equal(report.sentence(), null);
    });

    it('and when the API says that start never reached the device, the stop confirmed while it was out is what put it at rest', async () => {
        // The API answered that the device was not connected: nothing was
        // forwarded, nothing turned, and no stop has to follow the start. The
        // stop the round had confirmed while the start was out did bring the
        // device to rest, and is reported as the start comes back.
        await connectOk();
        const report = wireStopReport();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => sent('/hamp/start').length === 1, 'the start going out');
        const held = [];
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY
            ? new Promise((resolve) => held.push(resolve))
            : jsonResponse({ result: 0 }));
        routes['/connected'] = ({ key }) => jsonResponse({ connected: key !== KEY });
        await pollHandyConnected();
        await until(() => held.length === 1, 'the job\'s first stop');
        await connectHandy('second-key');
        assert.deepEqual(unconfirmedKeys, [KEY], 'reported as the Connect ends its stops');
        held[0](jsonResponse({ result: 0 }));
        await tick(20);
        assert.deepEqual(confirmedKeys, ['second-key'], 'confirmed with the start still out');
        assert.match(report.sentence(), /may still be moving/);
        start.release(DEVICE_NOT_CONNECTED);
        await until(() => confirmedKeys.length === 2, 'the start coming back');
        assert.deepEqual(confirmedKeys, ['second-key', KEY]);
        assert.equal(report.sentence(), null);
        await tick(20);
        assert.equal(stopsTo(KEY).length, 1, 'no stop follows a start that never reached the device');
        assert.deepEqual(unconfirmedKeys, [KEY]);
    });

    it('a Handy its first round has reported already is not reported twice when another key is connected', async () => {
        await connectOk();
        // One round only: the next one would come long after the test.
        HANDY_TIMINGS.offlineStopRetryMs = 5000;
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? jsonResponse(DEVICE_TIMEOUT) : jsonResponse({ result: 0 }));
        routes['/connected'] = ({ key }) => jsonResponse({ connected: key !== KEY });
        await pollHandyConnected();
        await until(() => unconfirmedKeys.length === 1, 'the first round');
        assert.equal(isHandyOfflineStopPending(), true);
        await connectHandy('second-key');
        assert.equal(isHandyOfflineStopPending(), false);
        assert.deepEqual(unconfirmedKeys, [KEY], 'the report it has stands, and is not made again');
    });

    it('Disconnect of a link found offline lets its Handy go the same way, and resolves false', async () => {
        const held = await offlineWithTheFirstStopOut();
        assert.equal(await disconnectHandy(), false, 'no stop was confirmed for it');
        assert.equal(isHandyOfflineStopPending(), false);
        assert.deepEqual(unconfirmedKeys, [KEY]);
        assert.match(unconfirmed[0], /^Stop not confirmed: the Handy that went offline was disconnected while it was still being sent stops$/);
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        held[0](jsonResponse(DEVICE_TIMEOUT));
        await until(() => stopsTo(KEY).length === 4, 'the rest of the round');
        await tick(20);
        assert.deepEqual(unconfirmedKeys, [KEY]);
    });

    it('and true when that Handy had confirmed a stop before it was let go', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        await until(() => confirmedKeys.length === 1 && !isHandyOfflineStopPending(), 'the background stop');
        assert.equal(await disconnectHandy(), true);
        assert.deepEqual(unconfirmedKeys, []);
    });

    it('reports a reconnect\'s stops by their own keys: the key verified, then the old device stopped', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? jsonResponse(null, 503) : jsonResponse({ result: 0 }));
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => unconfirmedKeys.length === 1, 'the unconfirmed stop');
        assert.deepEqual(unconfirmedKeys, [KEY]);
        // The old device's stop goes through during the switch to another key.
        routes['PUT /hamp/stop'] = undefined;
        await connectHandy('second-key');
        assert.equal(getHandyKey(), 'second-key');
        assert.deepEqual(confirmedKeys, ['second-key', KEY]);
    });

    it('reports the stop after a late start for the key it was issued with, while another key is connected', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => sent('/hamp/start').length === 1, 'the start going out');
        // Replaced while its start is in flight: the old device is stopped
        // before the switch. That stop is confirmed with the start still out,
        // so it does not yet say the old device is at rest.
        await connectHandy('second-key');
        assert.equal(sent('/hamp/stop').filter((c) => c.key === KEY).length, 1, 'the old device was stopped');
        assert.deepEqual(confirmedKeys, ['second-key']);
        // The start lands after that stop, and the device it reached does not
        // confirm the stop that follows it.
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? jsonResponse(null, 503) : jsonResponse({ result: 0 }));
        releaseStart();
        await until(() => unconfirmedKeys.length === 1, 'the stop after the late start');
        assert.equal(getHandyKey(), 'second-key');
        assert.deepEqual(unconfirmedKeys, [KEY], 'the device that may be moving, not the one connected');
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

    // What another page is told through the crash-recovery marker: while
    // this holds, the Handy is this driver's to stop, and it does so on every
    // way out; once a stop is confirmed, a stop from elsewhere takes nothing.
    it('may be moving from the moment a start is sent until a stop is confirmed, and whenever it cannot tell', async () => {
        assert.equal(handyMayBeMoving(), false, 'no link');
        await connectOk();
        assert.equal(handyMayBeMoving(), false, 'Connect confirmed a stop');
        let releaseStart = null;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        assert.equal(handyMayBeMoving(), true, 'a start is on its way as soon as the dispatch returns');
        await until(() => releaseStart !== null, 'the start going out');
        releaseStart();
        await tick(5);
        assert.equal(isHandyMoving(), true);
        assert.equal(handyMayBeMoving(), true);
        let releaseStop = null;
        routes['PUT /hamp/stop'] = () => new Promise((resolve) => { releaseStop = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => releaseStop !== null, 'the stop going out');
        assert.equal(handyMayBeMoving(), true, 'a stop the API has not confirmed yet');
        releaseStop();
        await tick(5);
        assert.equal(handyMayBeMoving(), false, 'the stop is confirmed');
        // A start that timed out may still have reached the device.
        HANDY_TIMINGS.requestTimeoutMs = 40;
        routes['PUT /hamp/stop'] = undefined;
        routes['PUT /hamp/start'] = () => new Promise(() => {});
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(70);
        assert.equal(isHandyMoving(), false);
        assert.equal(handyMayBeMoving(), true);
        // Without a link nothing is driven through it, whatever the device does.
        disconnectHandy();
        assert.equal(handyMayBeMoving(), false);
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
        // A tip-only zone at the top of a full envelope, at the widest
        // margin: a whole minimum stroke, clear of the top end stop.
        dispatchHandy(50, 95, 100, true, 0, 100, 10);
        await tick(5);
        assert.deepEqual(sent('/slide')[0].body, { min: 80, max: 90 });
        // A narrow envelope: the margin yields rather than shrink the stroke.
        dispatchHandy(50, 0, 100, true, 0, 10, 10);
        await tick(5);
        assert.deepEqual(sent('/slide')[1].body, { min: 0, max: 10 });
    });

    // On the wire before this change, with the default 0-100 envelope and 5%
    // margin: Glans Protector's warm-up at 139 BPM sent {0,10}, and Head Play
    // {86,96}. The margin gave way on any zone too short to be cut, so the
    // carriage was run onto the very end stop it exists to keep it off, or
    // into the margin beside it.
    it('moves a minimum-width stroke off the end stop inside a wide envelope', async () => {
        await connectOk();
        dispatchHandy(50, 0, 10, true, 0, 100);
        dispatchHandy(50, 86, 96, true, 0, 100);
        dispatchHandy(50, 90, 100, true, 0, 100);
        dispatchHandy(50, 0, 10, true, 0, 100, 10);
        await tick(5);
        assert.deepEqual(sent('/slide').map((c) => c.body), [
            { min: 5, max: 15 }, { min: 85, max: 95 }, { min: 85, max: 95 }, { min: 10, max: 20 }
        ]);
    });

    it('moves the stroke only inside the envelope the wearer set', async () => {
        await connectOk();
        // Room for the stroke to move but not for the whole margin: it
        // keeps what it can and stays inside the typed bounds.
        dispatchHandy(50, 0, 10, true, 0, 12);
        dispatchHandy(50, 88, 100, true, 88, 100);
        // A narrowed envelope that clears the ends is sent as it was.
        dispatchHandy(50, 15, 25, true, 15, 85);
        // Margin 0 still sends the engine's zone untouched.
        dispatchHandy(50, 0, 10, true, 0, 100, 0);
        await tick(5);
        assert.deepEqual(sent('/slide').map((c) => c.body), [
            { min: 2, max: 12 }, { min: 88, max: 98 }, { min: 15, max: 25 }, { min: 0, max: 10 }
        ]);
    });

    it('sends every zone through the margin rule the protocol tests cover', async () => {
        // The exhaustive grid lives in handy-protocol.test.js. This holds
        // the driver to it: whatever dispatchHandy puts on the wire must be
        // that function's answer, and must keep the margin by itself.
        await connectOk();
        const envelopes = [[0, 100], [0, 50], [50, 100], [0, 20], [80, 100], [0, 12], [88, 100], [0, 10], [90, 100], [15, 85], [30, 45]];
        const expected = [];
        let n = 0;
        for (const [envMin, envMax] of envelopes) {
            for (const margin of [0, 1, 5, 10]) {
                for (let lo = 0; lo <= 100; lo += 5) {
                    for (let hi = lo; hi <= 100; hi += 5) {
                        dispatchHandy(50, lo, hi, true, envMin, envMax, margin);
                        expected.push({ envMin, envMax, margin, lo, hi });
                        n += 1;
                        // Let the mocked replies land now and then.
                        if (n % 500 === 0) await tick(0);
                    }
                }
            }
        }
        await tick(5);
        const bodies = sent('/slide').map((c) => c.body);
        assert.equal(bodies.length, expected.length);
        expected.forEach(({ envMin, envMax, margin, lo, hi }, i) => {
            const at = `zone ${lo}-${hi} envelope ${envMin}-${envMax} margin ${margin}`;
            const want = applyEndMargin(normalizeSlideRange(lo, hi, envMin, envMax), margin, { min: envMin, max: envMax });
            assert.deepEqual(bodies[i], want, at);
            const body = bodies[i];
            assert.ok(body.min >= envMin && body.max <= envMax, `left the envelope at ${at}`);
            assert.ok(body.max - body.min >= 10, `shorter than the minimum stroke at ${at}`);
            const roomy = Math.min(envMax, 100 - margin) - Math.max(envMin, margin) >= 10;
            if (roomy) assert.ok(body.min >= margin && body.max <= 100 - margin, `inside the margin at ${at}`);
        });
    });

    // A pulse held at 139 BPM on this 70-140 band, factory settings, as it
    // was recorded in the page before this change: Glans Protector's warm-up
    // put all 26 of its strokes inside the margin, 21 of them {0,10}, on the
    // end stop; Head Play 16 of 35, {86,96} 14 times; the warm-ups of
    // Classic, Ultimate and Milker 18 of 43, 16 of 36 and 16 of 36.
    it('keeps every stroke of a session off the end stops, the shortest ones too', async () => {
        await connectOk();
        await runSession([
            { ticks: 60, activeMode: 'shortener', hr: 139, warmupMinutes: 5, sessionSeconds: 0 },
            { ticks: 60, activeMode: 'headplay', hr: 139, warmupMinutes: 5, sessionSeconds: 0 },
            { ticks: 60, activeMode: 'headplay', hr: 139, sessionSeconds: 600 },
            { ticks: 60, activeMode: 'classic', hr: 139, warmupMinutes: 5, sessionSeconds: 0 },
            { ticks: 60, activeMode: 'ultimate', hr: 139, warmupMinutes: 5, sessionSeconds: 0 },
            { ticks: 60, activeMode: 'milker', hr: 139, warmupMinutes: 5, sessionSeconds: 0 }
        ]);
        const bodies = sent('/slide').map((c) => c.body);
        assert.ok(bodies.length > 150, `only ${bodies.length} strokes were sent`);
        assert.deepEqual(bodies.filter((b) => b.min < 5 || b.max > 95), [], 'a stroke went out inside the margin');
        assert.deepEqual(bodies.filter((b) => b.max - b.min < 10), [], 'a stroke went out shorter than the minimum');
        // The engine really did ask for minimum strokes on both ends: they
        // left moved off the end, whole.
        assert.ok(bodies.some((b) => b.min === 5 && b.max === 15), 'no minimum stroke at the base was moved up');
        assert.ok(bodies.some((b) => b.min === 85 && b.max === 95), 'no minimum stroke at the tip was moved down');
    });

    // What the far end pays, through the real engine: the stroke Glans
    // Protector and Head Play hold at the ceiling, as The Handy is sent it at
    // each margin. README.md quotes these numbers.
    it('sends a stroke held against one end at most one margin further toward the other than no margin does', async () => {
        await connectOk();
        const atCeiling = (activeMode, envMin, envMax, margin) => {
            const out = calculateEngineOutputs({
                hr: 150, edgeHr: 150, minHr: 70, maxHr: 140, activeMode,
                sessionStatus: 'RUNNING', isEdged: true, orgasmMode: false,
                warmupMinutes: 0, ceilingBehaviour: 'crawl', sessionSeconds: 600,
                handyHwMin: envMin, handyHwMax: envMax
            });
            dispatchHandy(out.primaryPercent, out.strokeMinPercent, out.strokeMaxPercent, true, envMin, envMax, margin);
            return `${out.strokeMinPercent}-${out.strokeMaxPercent}`;
        };
        assert.deepEqual([
            atCeiling('shortener', 0, 100, 0),
            atCeiling('shortener', 0, 100, 5),
            atCeiling('shortener', 0, 100, 10),
            atCeiling('shortener', 0, 60, 10),
            atCeiling('headplay', 0, 100, 5)
        ], ['0-35', '0-35', '0-35', '0-21', '75-100'], 'the engine\'s own zones');
        await tick(5);
        assert.deepEqual(sent('/slide').map((c) => `${c.body.min}-${c.body.max}`), ['0-35', '5-40', '10-45', '10-31', '70-95']);
    });

    // A narrowed envelope, through the real engine. In 0-40 Glans
    // Protector's warm-up at 139 BPM asks for 0-4 - a tenth of the envelope,
    // less than the 10% of travel The Handy is always sent - and the
    // cockpit's Zone badge shows 0-4%. The driver lengthens it to a whole
    // minimum stroke first, margin or not, and only then moves that off the
    // end stop. At the default margin its far end lands 11 past the zone the
    // engine asked for and 5 past what no margin sends, which is why the
    // Handy panel and README.md measure what the margin costs from no
    // margin, and say that a shorter stroke is lengthened to 10% first.
    it('lengthens a short stroke in a narrowed envelope before moving it off the end stop', async () => {
        await connectOk();
        const out = calculateEngineOutputs({
            hr: 139, edgeHr: 139, minHr: 70, maxHr: 140, activeMode: 'shortener',
            sessionStatus: 'RUNNING', isEdged: false, orgasmMode: false,
            warmupMinutes: 5, ceilingBehaviour: 'crawl', sessionSeconds: 10,
            handyHwMin: 0, handyHwMax: 40
        });
        assert.deepEqual([out.strokeMinPercent, out.strokeMaxPercent], [0, 4], 'the engine\'s own zone');
        assert.ok(out.primaryPercent > 0, 'the warm-up is moving');
        for (const margin of [0, 5, 10]) {
            dispatchHandy(out.primaryPercent, out.strokeMinPercent, out.strokeMaxPercent, true, 0, 40, margin);
        }
        // Head Play's warm-up at the tip of a 50-100 envelope asks for 94-99.
        dispatchHandy(50, 94, 99, true, 50, 100, 0);
        dispatchHandy(50, 94, 99, true, 50, 100, 5);
        await tick(5);
        assert.deepEqual(sent('/slide').map((c) => `${c.body.min}-${c.body.max}`), ['0-10', '5-15', '10-20', '90-100', '85-95']);
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

    // The master clock and a strap, wired to the driver the way app.js wires
    // them: each second a heart-rate packet runs the engine `packetLeadMs`
    // before the tick, and the tick runs the engine, the guards and the
    // engine again, its dispatch held until the tick is over and marked
    // urgent when a guard engaged in it (tick-dispatch.js). Every dispatch
    // asks the gate, which also makes a cut urgent. The Handy follows
    // `handyRole`. Date.now is stepped so the throttle sees the real spacing
    // of the two. Returns, per second, what the packet and the tick each put
    // on the wire. `markGuards: false` leaves out the guard's mark, and
    // `urgency: false` every urgent dispatch: the defects each one fixes.
    async function runClock({ seconds, pulse, mode, ceilingBehaviour = 'crawl', stallGuard = false, pauseTimeoutSeconds = 8, packetLeadMs = 200, handyRole = 'primary', markGuards = true, urgency = true }) {
        const realNow = Date.now;
        let clock = realNow.call(Date);
        Date.now = () => clock;
        const gate = createTickDispatch();
        const s = {
            second: 0,
            isEdged: false,
            primary: null,
            secondary: null,
            ruin: { rideSeconds: 0, lockSeconds: 0, spent: false },
            guard: { holdSeconds: 0, pauseSeconds: 0, engaged: false }
        };
        // app.js dispatchHardware, for The Handy alone.
        const dispatch = (d, urgent = false) => {
            const release = gate.admit(d, { urgent });
            if (!release) return;
            dispatchHandy(handyTargetSpeed(handyRole, d[0], d[1], 100), d[2], d[3], false, 0, 100, 5, { urgent: urgency && release.urgent });
        };
        const updateEngine = (hr) => {
            const out = calculateEngineOutputs({
                hr,
                edgeHr: hr,
                minHr: 70,
                maxHr: 140,
                activeMode: mode,
                sessionStatus: 'RUNNING',
                isEdged: s.isEdged,
                orgasmMode: false,
                warmupMinutes: 0,
                ceilingBehaviour,
                stallGuardEngaged: s.guard.engaged,
                ruinHoldSeconds: s.ruin.lockSeconds,
                ruinSpent: s.ruin.spent,
                sessionSeconds: s.second
            });
            // As app.js does: a new edge's Ruin ride starts with the pullback,
            // on the first reading at the mark.
            if (out.pullbackStarted) s.ruin = startRuinEdge(s.ruin);
            s.isEdged = out.isEdged;
            s.primary = out.primaryPercent;
            s.secondary = out.secondaryPercent;
            dispatch([out.primaryPercent, out.secondaryPercent, out.strokeMinPercent, out.strokeMaxPercent]);
        };
        const velocityOf = () => handyTargetSpeed(handyRole, s.primary, s.secondary, 100);
        const wireSince = (at) => calls.slice(at).map((c) => (c.path === '/hamp/velocity' ? `${c.path} ${c.body.velocity}` : c.path));
        const log = [];
        try {
            for (let second = 1; second <= seconds; second++) {
                const hr = pulse(second);
                clock += 1000 - packetLeadMs;
                const atPacket = calls.length;
                updateEngine(hr);
                const packet = { primary: s.primary, velocity: velocityOf(), sent: wireSince(atPacket) };
                await tick(0);
                packet.sent = wireSince(atPacket);
                clock += packetLeadMs;
                s.second = second;
                const atTick = calls.length;
                gate.run(() => {
                    updateEngine(hr);
                    const ruinBefore = s.ruin;
                    const step = tickRuinAndStallGuard({ ruin: s.ruin, guard: s.guard }, {
                        activeMode: mode,
                        isEdged: s.isEdged,
                        orgasmMode: false,
                        stallGuard,
                        ceilingBehaviour,
                        holdTimeoutSeconds: 3,
                        pauseTimeoutSeconds
                    });
                    s.ruin = step.ruin;
                    s.guard = step.guard;
                    if (markGuards && guardEngagedBy(step, ruinBefore)) gate.markUrgent();
                    updateEngine(hr);
                }, (d, { urgent }) => dispatch(d, urgent));
                // What the tick itself issued, before any reply came back.
                const tickSent = wireSince(atTick);
                await tick(0);
                log.push({ second, packet, tick: { primary: s.primary, velocity: velocityOf(), sent: tickSent, engaged: s.guard.engaged, lock: s.ruin.lockSeconds } });
            }
        } finally {
            Date.now = realNow;
        }
        return log;
    }

    // Stops, and the one urgent dispatch a guard or a cut earns ('tick 16',
    // 'packet 6'), aside, no two motion requests from different dispatches
    // closer than 400 ms: the throttle still holds every ordinary change.
    function assertThrottled(log, packetLeadMs, urgent = []) {
        const at = [];
        for (const row of log) {
            if (row.packet.sent.some((p) => p !== '/hamp/stop')) at.push({ t: row.second * 1000 - packetLeadMs, task: `packet ${row.second}` });
            if (row.tick.sent.some((p) => p !== '/hamp/stop')) at.push({ t: row.second * 1000, task: `tick ${row.second}` });
        }
        for (let i = 1; i < at.length; i++) {
            if (urgent.includes(at[i].task)) continue;
            assert.ok(at[i].t - at[i - 1].t >= 400, `${at[i].task}: motion ${at[i].t - at[i - 1].t} ms after the last`);
        }
    }

    // A packet 200 ms before the tick leaves the tick inside the throttle
    // window; one 850 ms before it (150 ms after the last tick) leaves the
    // tick's own dispatch free to go out, the speed a guard overrules with it.
    for (const packetLeadMs of [200, 850]) {
        it(`a stall guard cut reaches the device on the tick that decides it (packet ${packetLeadMs} ms before)`, async () => {
            await connectOk();
            const log = await runClock({
                seconds: 14,
                mode: 'classic',
                stallGuard: true,
                packetLeadMs,
                pulse: (second) => (second <= 6 ? 100 : 145)
            });
            const engaged = log.find((row) => row.tick.engaged);
            assert.ok(engaged, 'the guard engaged');
            assert.equal(engaged.packet.primary, 10, 'the packet before it still crawled');
            assert.equal(engaged.tick.primary, 0);
            assert.deepEqual(engaged.tick.sent, ['/hamp/stop'], 'the stop, and nothing the guard overruled');
            assert.equal(sent('/hamp/stop').length, 1, 'one stop for one cut');
            assert.equal(isHandyMoving(), false);
        });

        it(`the Ruin lockout reaches the device on its tick, with nothing for the ride it cut (packet ${packetLeadMs} ms before)`, async () => {
            await connectOk();
            const log = await runClock({
                seconds: 24,
                mode: 'ruin',
                packetLeadMs,
                pulse: (second) => (second <= 5 ? 100 : 145)
            });
            const locked = log.find((row) => row.tick.lock > 0);
            assert.ok(locked, 'the lockout began');
            assert.ok(locked.packet.primary > 0, 'the packet before it still rode');
            assert.deepEqual(locked.tick.sent, ['/hamp/stop']);
            assert.equal(sent('/hamp/stop').length, 1);
            assertThrottled(log, packetLeadMs);
        });

        it(`the Ruin lockout reaches a Handy on the secondary channel on its tick (packet ${packetLeadMs} ms before)`, async () => {
            await connectOk();
            const log = await runClock({
                seconds: 24,
                mode: 'ruin',
                handyRole: 'secondary',
                packetLeadMs,
                pulse: (second) => (second <= 5 ? 100 : 145)
            });
            const locked = log.find((row) => row.tick.lock > 0);
            assert.ok(locked, 'the lockout began');
            assert.ok(locked.packet.velocity > RUIN_LOCK_SECONDARY, 'the packet before it still carried the ride');
            assert.equal(locked.tick.velocity, RUIN_LOCK_SECONDARY);
            // Its own dispatch, in its own tick: the lockout's stroke range and
            // its 18%, and nothing else.
            assert.deepEqual(locked.tick.sent, ['/slide', `/hamp/velocity ${RUIN_LOCK_SECONDARY}`]);
            assert.equal(sent('/hamp/stop').length, 0, 'the secondary channel slows, it does not stop');
            assertThrottled(log, packetLeadMs, [`tick ${locked.second}`]);
        });
    }

    it('without urgency the lockout\'s 18% waited for the next packet, the defect this fixes', async () => {
        // The clock as it was: the tick held, but nothing urgent. A packet
        // 200 ms before the tick opened the throttle's window, and the
        // lockout's own dispatch fell inside it.
        await connectOk();
        const log = await runClock({
            seconds: 24,
            mode: 'ruin',
            handyRole: 'secondary',
            packetLeadMs: 200,
            urgency: false,
            pulse: (second) => (second <= 5 ? 100 : 145)
        });
        const at = log.findIndex((row) => row.tick.lock > 0);
        assert.ok(at > 0 && at + 1 < log.length, 'the lockout began');
        assert.deepEqual(log[at].tick.sent, [], 'the throttle dropped the lockout in its own tick');
        assert.ok(log[at + 1].packet.sent.includes(`/hamp/velocity ${RUIN_LOCK_SECONDARY}`), 'the next packet carried it, 0.8 s later');
    });

    it('a lockout that cuts a riding primary is urgent by the cut alone', async () => {
        // Without the guard's mark the gate still sees the ride's primary
        // go to 0; the mark is for the lockout the cut cannot see (below).
        await connectOk();
        const log = await runClock({
            seconds: 24,
            mode: 'ruin',
            handyRole: 'secondary',
            packetLeadMs: 200,
            markGuards: false,
            pulse: (second) => (second <= 5 ? 100 : 145)
        });
        const locked = log.find((row) => row.tick.lock > 0);
        assert.ok(locked.packet.primary > 0);
        assert.deepEqual(locked.tick.sent, ['/slide', `/hamp/velocity ${RUIN_LOCK_SECONDARY}`]);
    });

    it('a Ruin lockout that begins under a stall pause reaches a Handy on the secondary channel on its tick', async () => {
        // The stall guard cuts the ride 3 s in and its pause outlasts the
        // ride, so the primary is already 0 when the lockout begins: no cut,
        // only the guard, says the tick must go out now.
        await connectOk();
        const log = await runClock({
            seconds: 24,
            mode: 'ruin',
            handyRole: 'secondary',
            stallGuard: true,
            pauseTimeoutSeconds: 30,
            packetLeadMs: 200,
            pulse: (second) => (second <= 5 ? 100 : 145)
        });
        const locked = log.find((row) => row.tick.lock > 0);
        assert.ok(locked, 'the lockout began');
        assert.equal(locked.packet.primary, 0, 'the stall pause already held the primary');
        assert.ok(locked.packet.velocity > RUIN_LOCK_SECONDARY);
        assert.deepEqual(locked.tick.sent, ['/slide', `/hamp/velocity ${RUIN_LOCK_SECONDARY}`]);
        const engagedAt = log.find((row) => row.tick.engaged).second;
        assertThrottled(log, 200, [`tick ${engagedAt}`, `tick ${locked.second}`]);
    });

    it('the same lockout under a stall pause, with no guard marked, waited for the next packet', async () => {
        await connectOk();
        const log = await runClock({
            seconds: 24,
            mode: 'ruin',
            handyRole: 'secondary',
            stallGuard: true,
            pauseTimeoutSeconds: 30,
            packetLeadMs: 200,
            markGuards: false,
            pulse: (second) => (second <= 5 ? 100 : 145)
        });
        const at = log.findIndex((row) => row.tick.lock > 0);
        assert.ok(at > 0 && at + 1 < log.length);
        assert.deepEqual(log[at].tick.sent, [], 'the throttle dropped the lockout in its own tick');
        assert.ok(log[at + 1].packet.sent.includes(`/hamp/velocity ${RUIN_LOCK_SECONDARY}`), 'the next packet carried it, 0.8 s later');
    });

    it('Full Stop decided on a packet 150 ms after the tick reaches the device on that packet', async () => {
        await connectOk();
        const log = await runClock({
            seconds: 8,
            mode: 'classic',
            ceilingBehaviour: 'stop',
            packetLeadMs: 850,
            pulse: (second) => (second <= 5 ? 100 : 145)
        });
        const edge = log.find((row) => row.packet.primary === 0);
        assert.ok(edge, 'the pulse crossed the mark on a packet');
        assert.deepEqual(edge.packet.sent, ['/hamp/stop']);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(isHandyMoving(), false);
    });

    it('Full Stop on a packet 150 ms after the tick carries its secondary to a Handy that follows it', async () => {
        // At the mark Milker drops the primary to 0 and raises the secondary.
        // The tick 150 ms before restarted the throttle's clock, so the raise
        // was dropped and the next tick sent the lower value after it: the
        // peak never reached a Handy that follows the secondary channel. The
        // cut is urgent, so it goes out on the packet that decides it.
        await connectOk();
        const log = await runClock({
            seconds: 8,
            mode: 'milker',
            ceilingBehaviour: 'stop',
            handyRole: 'secondary',
            packetLeadMs: 850,
            pulse: (second) => (second <= 5 ? 100 : 145)
        });
        const at = log.findIndex((row) => row.packet.primary === 0);
        assert.ok(at > 0, 'the pulse crossed the mark on a packet');
        const edge = log[at];
        assert.notEqual(edge.packet.velocity, log[at - 1].tick.velocity, 'the cut moved the secondary');
        assert.ok(edge.packet.sent.includes(`/hamp/velocity ${edge.packet.velocity}`), JSON.stringify(edge.packet));
        assertThrottled(log, 850, [`packet ${edge.second}`]);
    });

    // app.js asks Came Early's and Finished me's question only over a device
    // this says is at rest: the question is a native dialog, which holds back
    // every timer of the page, and the retries of a verified stop are timers.
    it('handyRestState: nothing to wait for without a link, and a connected device starts at rest', async () => {
        assert.equal(handyRestState(), 'none');
        await connectOk();
        assert.equal(handyRestState(), 'stopped', 'the connect confirmed a stop');
        dispatchHandy(50, 0, 100, true, 0, 100);
        assert.equal(handyRestState(), 'pending', 'a start is on its way');
        await tick(5);
        assert.equal(isHandyMoving(), true);
        assert.equal(handyRestState(), 'unconfirmed', 'a running device is not at rest');
    });

    it('handyRestState: pending through every retry of a stop, stopped only once one is confirmed', async () => {
        await connectOk();
        HANDY_TIMINGS.stopRetryDelaysMs = [40, 40, 40];
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        // The measured failure: the first PUT /hamp/stop gets a 502, the
        // retry succeeds - held here until the test lets it answer.
        let release;
        let attempts = 0;
        routes['PUT /hamp/stop'] = () => {
            attempts += 1;
            if (attempts === 1) return jsonResponse({ message: 'bad gateway' }, 502);
            return new Promise((resolve) => { release = () => resolve(jsonResponse({ result: 0 })); });
        };
        dispatchHandy(0, 0, 100, true, 0, 100);
        assert.equal(handyRestState(), 'pending');
        await tick(10);
        assert.equal(attempts, 1, 'the first attempt failed and the retry waits out its backoff');
        assert.equal(handyRestState(), 'pending', 'a failed first attempt is not the answer');
        await tick(50);
        assert.equal(attempts, 2);
        assert.equal(handyRestState(), 'pending', 'the retry is on its way');
        release();
        await tick(5);
        assert.equal(handyRestState(), 'stopped');
        assert.equal(isHandyMoving(), false);
    });

    it('handyRestState: unconfirmed once every attempt of the stop has failed', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['PUT /hamp/stop'] = () => { throw new TypeError('Failed to fetch'); };
        const stopping = stopHandy();
        assert.equal(handyRestState(), 'pending');
        assert.equal(await stopping, false);
        await tick(0);
        assert.equal(handyRestState(), 'unconfirmed');
        // A later stop that is confirmed puts it right.
        routes['PUT /hamp/stop'] = undefined;
        assert.equal(await stopHandy(), true);
        await tick(0);
        assert.equal(handyRestState(), 'stopped');
    });

    it('handyRestState: a start that lands after the stop keeps it pending until the stop after it is confirmed', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
        // The stop is confirmed at once, but the start is still out there.
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        assert.equal(handyRestState(), 'pending', 'a start on its way may still move the device');
        // It lands: the device may be moving, and the driver stops it again.
        let releaseStop;
        routes['PUT /hamp/stop'] = () => new Promise((resolve) => { releaseStop = () => resolve(jsonResponse({ result: 0 })); });
        releaseStart();
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 2, 'a safety stop follows the stale start');
        assert.equal(handyRestState(), 'pending', 'never stopped before that stop is confirmed');
        releaseStop();
        await tick(5);
        assert.equal(handyRestState(), 'stopped');
    });

    it('handyRestState: a device that went offline with its stop unconfirmed is not at rest', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        const fail = () => { throw new TypeError('Failed to fetch'); };
        routes['/connected'] = fail;
        routes['PUT /hamp/stop'] = fail;
        for (let i = 0; i < 3; i++) await pollHandyConnected();
        assert.equal(offline.length, 1);
        assert.equal(isHandyOfflineStopPending(), true);
        assert.equal(handyRestState(), 'unconfirmed');
        // The background stop gets through: nothing is owed any more.
        routes['PUT /hamp/stop'] = undefined;
        await until(() => !isHandyOfflineStopPending(), 'the background stop');
        assert.equal(handyRestState(), 'none');
    });

    // The stop Disconnect sends outlives the link, and is retried like any
    // other: a question opened before it is confirmed would hold its
    // retries back just the same. Measured: Disconnect's PUT /hamp/stop got
    // a 502, the question opened 130 ms later over "The toys are stopped",
    // and the retry due 250 ms after the 502 went out four seconds later,
    // once the question had been answered.
    it("handyRestState: Disconnect's own stop is on its way until it is confirmed", async () => {
        await connectOk();
        HANDY_TIMINGS.stopRetryDelaysMs = [40, 40, 40];
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);
        let attempts = 0;
        routes['PUT /hamp/stop'] = () => {
            attempts += 1;
            return attempts <= 2 ? jsonResponse({ message: 'bad gateway' }, 502) : jsonResponse({ result: 0 });
        };
        const stopped = disconnectHandy();
        assert.equal(handyConnected, false);
        assert.equal(handyRestState(), 'pending', 'the link is gone, but the device is not known to be at rest');
        await tick(10);
        assert.equal(attempts, 1);
        assert.equal(handyRestState(), 'pending', 'a failed attempt is not the answer');
        assert.equal(await stopped, true);
        assert.equal(attempts, 3);
        assert.equal(handyRestState(), 'none');
    });

    it('handyRestState: a device dropped with its stop never confirmed stays in doubt until a stop to it is confirmed', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['PUT /hamp/stop'] = () => { throw new TypeError('Failed to fetch'); };
        assert.equal(await disconnectHandy(), false);
        assert.equal(isHandyOfflineStopPending(), false);
        assert.equal(handyRestState(), 'unconfirmed', 'no link and nothing on its way, but the device may still be moving');
        // Connect with the same key: the device confirms a stop first.
        routes['PUT /hamp/stop'] = undefined;
        await connectOk();
        assert.equal(handyRestState(), 'stopped');
        assert.equal(await disconnectHandy(), true);
        assert.equal(handyRestState(), 'none');
    });

    it('handyRestState: a start still on its way when the link is dropped keeps it pending until the stop after it is confirmed', async () => {
        await connectOk();
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
        // Disconnect's stop is confirmed at once, but the start is still out there.
        assert.equal(await disconnectHandy(), true);
        assert.equal(handyRestState(), 'pending', 'a start on its way may still move the device');
        let releaseStop;
        routes['PUT /hamp/stop'] = () => new Promise((resolve) => { releaseStop = () => resolve(jsonResponse({ result: 0 })); });
        releaseStart();
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 2, 'the start landed: the dropped device is stopped again');
        assert.equal(sent('/hamp/stop')[1].key, KEY);
        assert.equal(handyRestState(), 'pending');
        releaseStop();
        await tick(5);
        assert.equal(handyRestState(), 'none');
    });

    it('handyRestState: of two stops to one device, the one sent last decides, whichever is answered last', async () => {
        const ok = () => jsonResponse({ result: 0 });
        const failed = () => jsonResponse({ message: 'bad gateway' }, 502);
        // The press's stop and then Disconnect's, both held until answered:
        // answers[0] and answers[1] are their first attempts, and each retry
        // of whichever fails comes after them.
        const race = async (answer) => {
            routes['PUT /hamp/stop'] = undefined;
            await connectOk();
            HANDY_TIMINGS.stopRetryDelaysMs = [0, 0, 0];
            dispatchHandy(50, 0, 100, true, 0, 100);
            await tick(5);
            const answers = [];
            routes['PUT /hamp/stop'] = () => new Promise((resolve) => answers.push(resolve));
            dispatchHandy(0, 0, 100, true, 0, 100);
            const stopped = disconnectHandy();
            assert.equal(answers.length, 2);
            await answer(answers, stopped);
            await until(() => handyRestState() !== 'pending', 'the last stop to be answered');
            return handyRestState();
        };
        const failTheRetries = async (answers) => {
            for (let i = 2; i < 5; i += 1) {
                await until(() => answers.length > i, 'the next attempt');
                answers[i](failed());
            }
        };
        // Disconnect's stop is confirmed; the press's, sent before it, then
        // fails every attempt: the device is at rest.
        assert.equal(await race(async (answers, stopped) => {
            answers[1](ok());
            assert.equal(await stopped, true);
            answers[0](failed());
            await failTheRetries(answers);
        }), 'none');
        // The other way round: the last stop sent was never confirmed, and
        // the driver does not vouch for the device, as it would not on the
        // live link either.
        assert.equal(await race(async (answers, stopped) => {
            answers[0](ok());
            answers[1](failed());
            await failTheRetries(answers);
            assert.equal(await stopped, false);
        }), 'unconfirmed');
    });

    // A round of an offline device's background stop is not waited for: the
    // device is in doubt until one is confirmed, round or no round, and a
    // round is four attempts - 26 s when each times out.
    it('handyRestState: an offline device is in doubt while a round of its background stop is on its way, not pending', async () => {
        await connectOk();
        HANDY_TIMINGS.stopRetryDelaysMs = [0, 0, 0];
        HANDY_TIMINGS.offlineStopRetryMs = 10000;
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        const answers = [];
        routes['/connected'] = () => { throw new TypeError('Failed to fetch'); };
        routes['PUT /hamp/stop'] = () => new Promise((resolve) => answers.push(resolve));
        for (let i = 0; i < 3; i++) await pollHandyConnected();
        assert.equal(offline.length, 1);
        assert.equal(answers.length, 1, 'the first round is on its way');
        assert.equal(isHandyOfflineStopPending(), true);
        assert.equal(handyRestState(), 'unconfirmed');
        answers[0](jsonResponse({ message: 'bad gateway' }, 502));
        await until(() => answers.length === 2, 'the round\'s second attempt');
        assert.equal(handyRestState(), 'unconfirmed', 'the round retries, and the device is still in doubt');
        // The retry is confirmed: the device is at rest and no stop is owed.
        answers[1](jsonResponse({ result: 0 }));
        await until(() => !isHandyOfflineStopPending(), 'the background stop');
        assert.equal(handyRestState(), 'none');
    });

    it('handyRestState: a stop still on its way when the device goes offline is waited for, and the device is in doubt after it', async () => {
        await connectOk();
        HANDY_TIMINGS.stopRetryDelaysMs = [0, 0, 0];
        HANDY_TIMINGS.offlineStopRetryMs = 10000;
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        const answers = [];
        routes['/connected'] = () => { throw new TypeError('Failed to fetch'); };
        routes['PUT /hamp/stop'] = () => new Promise((resolve) => answers.push(resolve));
        // The session's stop is sent, and the device goes offline before it
        // is answered.
        dispatchHandy(0, 0, 100, true, 0, 100);
        for (let i = 0; i < 3; i++) await pollHandyConnected();
        assert.equal(offline.length, 1);
        assert.equal(answers.length, 2, "the session's stop and the first background round");
        assert.equal(handyRestState(), 'pending', "the session's stop may still be confirmed");
        // Its four attempts fail; the background round is still unanswered.
        answers[0](jsonResponse({ message: 'bad gateway' }, 502));
        for (let i = 2; i < 5; i += 1) {
            await until(() => answers.length > i, 'the next attempt');
            answers[i](jsonResponse({ message: 'bad gateway' }, 502));
        }
        await until(() => handyRestState() !== 'pending', 'the last stop to be answered');
        assert.equal(handyRestState(), 'unconfirmed');
        assert.equal(isHandyOfflineStopPending(), true);
        // The background round is confirmed: nothing is owed any more.
        answers[1](jsonResponse({ result: 0 }));
        await until(() => !isHandyOfflineStopPending(), 'the background stop');
        assert.equal(handyRestState(), 'none');
    });

    it('handyRestState: a stop confirmed after a later one that was confirmed first leaves the device at rest', async () => {
        await connectOk();
        HANDY_TIMINGS.stopRetryDelaysMs = [0, 0, 0];
        // The first stop's first attempt is held; everything after it is
        // answered at once.
        let releaseFirst = null;
        let stops = 0;
        routes['PUT /hamp/stop'] = () => {
            stops += 1;
            if (stops === 1) return new Promise((resolve) => { releaseFirst = () => resolve(jsonResponse({ result: 0 })); });
            return jsonResponse({ result: 0 });
        };
        // A forced stop to a device at rest, a start while it is still on its
        // way - Reset in IDLE, then START and PAUSE while Reset's stop is
        // still being answered - and a stop again.
        dispatchHandy(0, 0, 100, true, 0, 100);
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);
        dispatchHandy(0, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(stops, 2);
        assert.equal(isHandyMoving(), false, 'the later stop is confirmed');
        assert.equal(handyRestState(), 'pending', 'the first stop is still on its way');
        releaseFirst();
        await tick(5);
        assert.equal(handyRestState(), 'stopped', 'the late answer to the first stop does not undo the later one');
    });

    it('handyRestState: an offline device the background stop gave up on stays in doubt until Connect has it confirm a stop', async () => {
        await connectOk();
        HANDY_TIMINGS.stopRetryDelaysMs = [0, 0, 0];
        HANDY_TIMINGS.offlineStopRetryMs = 1;
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        routes['/connected'] = () => { throw new TypeError('Failed to fetch'); };
        routes['PUT /hamp/stop'] = () => { throw new TypeError('Failed to fetch'); };
        for (let i = 0; i < 3; i++) await pollHandyConnected();
        assert.equal(offline.length, 1);
        await until(() => !isHandyOfflineStopPending(), 'every round of the background stop', 10000);
        await until(() => handyRestState() !== 'pending', 'the last stop to be answered');
        assert.ok(sent('/hamp/stop').length >= 60 * 4, 'every round was tried');
        assert.equal(handyRestState(), 'unconfirmed', 'giving up is no answer');
        routes['PUT /hamp/stop'] = undefined;
        await connectOk();
        assert.equal(handyRestState(), 'stopped');
    });

    // ---- one record of whether a device has confirmed its stop ---------------------------
    //
    // Three things ask it: the page's "may still be moving" (onStopUnconfirmed /
    // onStopConfirmed, kept per key by handy-stop-report.js), the background
    // stop job an offline device is sent, and handyRestState, which Came Early
    // and Finished me ask before their question. All three read the device's
    // record (deviceMotion), so none of them can call a device at rest while
    // another says it may still be moving.

    // KEY runs; the paused session's stop and then Disconnect's go out, every
    // attempt of each held until the test answers it: answers[0] and
    // answers[1] are their first attempts, and each retry comes after them.
    async function pauseThenDisconnect() {
        await connectOk();
        const report = wireStopReport();
        HANDY_TIMINGS.stopRetryDelaysMs = [0, 0, 0];
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        const answers = [];
        routes['PUT /hamp/stop'] = () => new Promise((resolve) => answers.push(resolve));
        dispatchHandy(0, 0, 100, true, 0, 100);
        const disconnected = disconnectHandy();
        assert.equal(answers.length, 2, 'the pause\'s stop and Disconnect\'s');
        return { report, answers, disconnected };
    }
    const stopOk = () => jsonResponse({ result: 0 });
    const stopFailed = () => jsonResponse({ message: 'bad gateway' }, 502);

    // Fails the three retries of the stop whose first attempt was failed.
    async function failTheRetries(answers) {
        for (let i = 2; i < 5; i += 1) {
            await until(() => answers.length > i, 'the next attempt');
            answers[i](stopFailed());
        }
    }

    it('a stop that fails after a later one was confirmed is no warning: the page and handyRestState both read the device at rest', async () => {
        // Disconnect's stop, sent last, is confirmed; the pause's, sent before
        // it, then fails every attempt. It used to be reported all the same,
        // and the banner said "may still be moving" over a device the
        // driver's own record had at rest.
        const { report, answers, disconnected } = await pauseThenDisconnect();
        answers[1](stopOk());
        assert.equal(await disconnected, true);
        answers[0](stopFailed());
        await failTheRetries(answers);
        await until(() => handyRestState() !== 'pending', 'the pause\'s last attempt');
        assert.equal(handyRestState(), 'none');
        assert.deepEqual(unconfirmedKeys, [], 'the stop that failed was not the last word');
        assert.deepEqual(confirmedKeys, [KEY]);
        assert.equal(report.sentence(), null);
    });

    it('the stop sent last decides: one that fails after an earlier one was confirmed is the warning, until a stop after it is confirmed', async () => {
        const { report, answers, disconnected } = await pauseThenDisconnect();
        answers[0](stopOk());
        await until(() => confirmedKeys.length === 1, 'the pause\'s stop');
        answers[1](stopFailed());
        await failTheRetries(answers);
        assert.equal(await disconnected, false);
        await until(() => handyRestState() !== 'pending', 'Disconnect\'s last attempt');
        assert.equal(handyRestState(), 'unconfirmed');
        assert.deepEqual(unconfirmedKeys, [KEY]);
        assert.match(report.sentence(), /may still be moving/);
        // Connect with the same key: the stop that verifies it settles both.
        routes['PUT /hamp/stop'] = undefined;
        routes['/connected'] = jsonResponse({ connected: true });
        await connectHandy(KEY);
        assert.deepEqual(confirmedKeys, [KEY, KEY]);
        assert.equal(report.sentence(), null);
        assert.equal(handyRestState(), 'stopped');
    });

    it('whichever is answered last: an earlier stop confirmed after the later one failed settles nothing, for the page or for handyRestState', async () => {
        const { report, answers, disconnected } = await pauseThenDisconnect();
        answers[1](stopFailed());
        await failTheRetries(answers);
        assert.equal(await disconnected, false);
        assert.deepEqual(unconfirmedKeys, [KEY]);
        assert.equal(handyRestState(), 'pending', 'the pause\'s stop is still on its way');
        const warning = report.sentence();
        assert.match(warning, /may still be moving/);
        // The pause's stop, sent before Disconnect's, is confirmed now.
        answers[0](stopOk());
        await until(() => handyRestState() !== 'pending', 'the pause\'s stop');
        assert.equal(handyRestState(), 'unconfirmed');
        assert.deepEqual(confirmedKeys, []);
        assert.equal(report.sentence(), warning);
    });

    it('a device brought to rest while its background stop is out reads at rest everywhere, and a round that then fails is a new warning', async () => {
        await connectOk();
        const report = wireStopReport();
        HANDY_TIMINGS.stopRetryDelaysMs = [0, 0, 0];
        HANDY_TIMINGS.offlineStopRetryMs = ONE_CHASE_ROUND;
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        const answers = [];
        routes['PUT /hamp/stop'] = () => new Promise((resolve) => answers.push(resolve));
        routes['/connected'] = jsonResponse({ connected: false });
        // The pause's stop goes out, then the device is found offline: the
        // background job's first round goes out behind it.
        dispatchHandy(0, 0, 100, true, 0, 100);
        await pollHandyConnected();
        assert.equal(offline.length, 1);
        assert.equal(answers.length, 2, 'the pause\'s stop and the first round');
        assert.equal(isHandyOfflineStopPending(), true);
        // The pause's stop is confirmed: the device is at rest, the job runs on.
        answers[0](stopOk());
        await until(() => confirmedKeys.length === 1, 'the pause\'s stop');
        assert.equal(handyRestState(), 'none', 'a round of the background stop is not waited for');
        assert.equal(report.sentence(), null);
        assert.equal(isHandyOfflineStopPending(), true);
        // The round, sent after the pause's stop, fails every attempt: it is
        // the stop sent last, and the page and handyRestState say so together.
        answers[1](stopFailed());
        await failTheRetries(answers);
        await until(() => unconfirmedKeys.length === 1, 'the round\'s report');
        assert.match(report.sentence(), /may still be moving/);
        assert.equal(handyRestState(), 'unconfirmed');
        assert.equal(isHandyOfflineStopPending(), true);
    });

    it('a round that fails after the warning was taken back is a new warning, so the page never reads at rest a device in doubt', async () => {
        await connectOk();
        const report = wireStopReport();
        HANDY_TIMINGS.stopRetryDelaysMs = [0, 0, 0];
        HANDY_TIMINGS.offlineStopRetryMs = 20;
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        const answers = [];
        routes['PUT /hamp/stop'] = () => new Promise((resolve) => answers.push(resolve));
        routes['/connected'] = jsonResponse({ connected: false });
        dispatchHandy(0, 0, 100, true, 0, 100);
        await pollHandyConnected();
        assert.equal(answers.length, 2, 'the pause\'s stop and the first round');
        // The first round fails every attempt: the warning.
        answers[1](stopFailed());
        for (let i = 2; i < 5; i += 1) {
            await until(() => answers.length > i, 'the round\'s next attempt');
            answers[i](stopFailed());
        }
        await until(() => unconfirmedKeys.length === 1, 'the first round\'s report');
        assert.match(report.sentence(), /may still be moving/);
        assert.equal(handyRestState(), 'pending', 'the pause\'s stop is still on its way');
        // The pause's stop fails its first attempt; its retry, sent after the
        // round, is confirmed: the device is at rest, and the warning goes.
        answers[0](stopFailed());
        await until(() => answers.length > 5, 'the pause\'s retry');
        answers[5](stopOk());
        await until(() => confirmedKeys.length === 1, 'the pause\'s retry');
        assert.equal(report.sentence(), null);
        assert.equal(handyRestState(), 'none');
        assert.equal(isHandyOfflineStopPending(), true, 'the job runs on until a round of its own is confirmed');
        // The next round, sent after that, fails every attempt: the device is
        // in doubt again, and the page is told again.
        for (let i = 6; i < 10; i += 1) {
            await until(() => answers.length > i, 'the second round\'s next attempt');
            answers[i](stopFailed());
        }
        await until(() => unconfirmedKeys.length === 2, 'the second round\'s report');
        assert.match(report.sentence(), /may still be moving/);
        assert.equal(handyRestState(), 'unconfirmed');
        // Let the job finish: its third round is confirmed.
        await until(() => answers.length > 10, 'the third round');
        answers[10](stopOk());
        await until(() => !isHandyOfflineStopPending(), 'the background stop');
        assert.equal(report.sentence(), null);
        assert.equal(handyRestState(), 'none');
    });

    it('a Connect lets go of an offline Handy without a word when a start that never reached it was the only thing that could have moved it', async () => {
        // PAUSE while a start is out is confirmed at once, and the device is
        // found offline with the start still out: it is chased. The start
        // then comes back with the API's word that it never reached the
        // device, which puts the record at rest. The job used to keep a flag
        // of its own for a stop confirmed since it began, which the pause's
        // stop - confirmed before - never set, so the Connect that let the
        // device go reported it as one that may still be moving.
        await connectOk();
        const report = wireStopReport();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => sent('/hamp/start').length === 1, 'the start going out');
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => sent('/hamp/stop').length === 1, 'the pause\'s stop');
        await tick(5);
        assert.deepEqual(confirmedKeys, [], 'confirmed with the start still out');
        const held = [];
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? new Promise((resolve) => held.push(resolve)) : jsonResponse({ result: 0 }));
        routes['/connected'] = ({ key }) => jsonResponse({ connected: key !== KEY });
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), true, 'a start on its way is chased');
        await until(() => held.length === 1, 'the job\'s first stop');
        start.release(DEVICE_NOT_CONNECTED);
        await until(() => confirmedKeys.length === 1, 'the start coming back');
        assert.equal(handyRestState(), 'none');
        await connectHandy('second-key');
        assert.equal(isHandyOfflineStopPending(), false);
        assert.deepEqual(unconfirmedKeys, [], 'a device the record has at rest is not let go as one that may be moving');
        assert.equal(report.sentence(), null);
        assert.equal(handyRestState(), 'stopped');
        // The round still out says nothing when it fails.
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? jsonResponse(DEVICE_TIMEOUT) : jsonResponse({ result: 0 }));
        held[0](jsonResponse(DEVICE_TIMEOUT));
        await until(() => stopsTo(KEY).length === 5, 'the rest of the round');
        await tick(20);
        assert.deepEqual(unconfirmedKeys, []);
        assert.equal(handyRestState(), 'stopped');
    });

    it('a warning said as an offline Handy is let go with a start still out to it is taken back when that start comes back having moved nothing', async () => {
        await connectOk();
        const report = wireStopReport();
        const start = holdStart();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => sent('/hamp/start').length === 1, 'the start going out');
        const held = [];
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? new Promise((resolve) => held.push(resolve)) : jsonResponse({ result: 0 }));
        routes['/connected'] = ({ key }) => jsonResponse({ connected: key !== KEY });
        await pollHandyConnected();
        await until(() => held.length === 1, 'the job\'s first stop');
        await connectHandy('second-key');
        assert.deepEqual(unconfirmedKeys, [KEY], 'let go with a start out to it');
        assert.match(report.sentence(), /may still be moving/);
        assert.equal(handyRestState(), 'pending', 'that start may still reach it');
        // The API never reached the device with it, and nothing had moved the
        // device before it: the record is at rest, and the warning goes with
        // it. It used to stand until a stop to that device was confirmed.
        start.release(DEVICE_NOT_CONNECTED);
        await until(() => confirmedKeys.includes(KEY), 'the start coming back');
        assert.equal(report.sentence(), null);
        assert.equal(handyRestState(), 'stopped');
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? jsonResponse(DEVICE_TIMEOUT) : jsonResponse({ result: 0 }));
        held[0](jsonResponse(DEVICE_TIMEOUT));
        await until(() => stopsTo(KEY).length === 4, 'the rest of the round');
        await tick(20);
        assert.deepEqual(unconfirmedKeys, [KEY], 'the round of a job let go says nothing more');
        assert.equal(report.sentence(), null);
    });

    it('the keepalive stop leaves its device in doubt in the record, so a Handy let go before a verified stop to it is answered is still reported', async () => {
        await connectOk();
        // A start still waiting for its slide range when the page goes away:
        // the keepalive stop goes out, and nobody reads its answer.
        let releaseSlide;
        routes['PUT /slide'] = () => new Promise((resolve) => { releaseSlide = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => typeof releaseSlide === 'function', 'the slide range going out');
        assert.equal(stopHandyOnUnload(), true);
        assert.equal(handyRestState(), 'pending', 'the start is still waiting for its slide range');
        // Found offline before any verified stop: it is chased, and a Connect
        // lets it go before the first round comes back.
        HANDY_TIMINGS.offlineStopRetryMs = ONE_CHASE_ROUND;
        const held = [];
        routes['PUT /hamp/stop'] = ({ key }) => (key === KEY ? new Promise((resolve) => held.push(resolve)) : jsonResponse({ result: 0 }));
        routes['/connected'] = ({ key }) => jsonResponse({ connected: key !== KEY });
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), true);
        await until(() => held.length === 1, 'the job\'s first stop');
        assert.equal(handyRestState(), 'unconfirmed', 'the link is gone, the doubt is not');
        await connectHandy('second-key');
        assert.deepEqual(unconfirmedKeys, [KEY]);
        assert.equal(handyRestState(), 'unconfirmed');
        // A stop of that round confirmed afterwards puts it at rest for every reader.
        held[0](jsonResponse({ result: 0 }));
        await until(() => confirmedKeys.includes(KEY), 'the late confirmation');
        assert.equal(handyRestState(), 'stopped');
        releaseSlide();
        await tick(5);
        assert.equal(sent('/hamp/start').length, 0, 'the start that was waiting never goes out');
    });

    it('a forced stop a Handy never moved leaves unanswered is no doubt: the press may ask, as the page says nothing', async () => {
        // STOP or Reset in IDLE, PAUSE with role OFF, or the stop Came Early
        // sends: this base reports none of them as "may still be moving",
        // and handyRestState, which the press reads, agrees.
        await connectOk();
        const tallyBefore = handyStopTally();
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        dispatchHandy(0, 0, 100, true, 0, 100);
        assert.equal(handyRestState(), 'pending', 'the stop is on its way');
        await until(() => handyRestState() !== 'pending', 'the stop\'s last attempt');
        assert.equal(sent('/hamp/stop').length, 4);
        assert.deepEqual(unconfirmed, []);
        assert.equal(handyRestState(), 'stopped', 'the stop that verified the key is the last word, and nothing has moved the device since');
        // The press asks, but is told this stop went unanswered: "The Handy
        // has confirmed its stop" would be false.
        assert.deepEqual(handyStopTally(), { confirmed: tallyBefore.confirmed, unanswered: tallyBefore.unanswered + 1 });
        // Once the motor has run, the same unanswered stop is the doubt.
        routes['PUT /hamp/stop'] = undefined;
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => unconfirmed.length === 1, 'the unanswered stop');
        assert.equal(handyRestState(), 'unconfirmed');
    });

    // Came Early and Finished me read it before and after they wait for the
    // stops on their way (session-rules.stopThenAsk), so the line that ends
    // the wait never says the Handy confirmed a stop it left unanswered.
    it('handyStopTally counts the verified stops confirmed and those that give up with no later stop to their device confirmed, rounds apart', async () => {
        await connectOk();
        HANDY_TIMINGS.stopRetryDelaysMs = [0, 0, 0];
        const before = handyStopTally();
        const tally = (confirmed, unanswered) => ({ confirmed: before.confirmed + confirmed, unanswered: before.unanswered + unanswered });
        // Confirmed at once, and confirmed on a retry: one stop each.
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => handyRestState() !== 'pending', 'the stop');
        let attempts = 0;
        routes['PUT /hamp/stop'] = () => (++attempts === 1 ? jsonResponse({ message: 'bad gateway' }, 502) : jsonResponse({ result: 0 }));
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => handyRestState() !== 'pending', 'the retried stop');
        assert.equal(attempts, 2);
        assert.deepEqual(handyStopTally(), tally(2, 0));
        // Every attempt refused over a device at rest: unanswered, though
        // handyRestState goes on calling it at rest.
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_NOT_CONNECTED);
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => handyRestState() !== 'pending', 'the refused stop');
        assert.equal(handyRestState(), 'stopped');
        assert.deepEqual(unconfirmed, []);
        assert.deepEqual(handyStopTally(), tally(2, 1));
        // Over a running device, which it leaves in doubt: unanswered too.
        routes['PUT /hamp/stop'] = undefined;
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => handyRestState() !== 'pending', 'the unanswered stop');
        assert.equal(handyRestState(), 'unconfirmed');
        assert.deepEqual(handyStopTally(), tally(2, 2));
        // A round of the background stop an offline device is sent is not
        // waited for, and counted neither way.
        const sentBefore = sent('/hamp/stop').length;
        routes['/connected'] = jsonResponse({ connected: false });
        await pollHandyConnected();
        assert.equal(isHandyOfflineStopPending(), true);
        await until(() => sent('/hamp/stop').length >= sentBefore + 8, 'two rounds of the background stop');
        await tick(20);
        assert.equal(isHandyOfflineStopPending(), true, 'every round so far went unanswered');
        routes['PUT /hamp/stop'] = undefined;
        await until(() => !isHandyOfflineStopPending(), 'a confirmed round');
        assert.equal(handyRestState(), 'none');
        assert.deepEqual(handyStopTally(), tally(2, 2));
    });

    it('handyStopTally: a stop that gives up after a later one to its device was confirmed is no unanswered stop; Disconnect\'s own is', async () => {
        // The pause's stop, then Disconnect's; Disconnect's is confirmed and
        // the pause's then fails every attempt: the device answered a stop
        // sent after it.
        let run = await pauseThenDisconnect();
        let before = handyStopTally();
        run.answers[1](stopOk());
        assert.equal(await run.disconnected, true);
        run.answers[0](stopFailed());
        await failTheRetries(run.answers);
        await until(() => handyRestState() !== 'pending', 'the pause\'s last attempt');
        assert.equal(handyRestState(), 'none');
        assert.deepEqual(handyStopTally(), { confirmed: before.confirmed + 1, unanswered: before.unanswered });
        // The other way round: Disconnect's stop, sent last, gives up.
        resetHandyRestForTests();
        routes = {};
        run = await pauseThenDisconnect();
        before = handyStopTally();
        run.answers[0](stopOk());
        await until(() => confirmedKeys.length === 1, 'the pause\'s stop');
        run.answers[1](stopFailed());
        await failTheRetries(run.answers);
        assert.equal(await run.disconnected, false);
        assert.deepEqual(handyStopTally(), { confirmed: before.confirmed + 1, unanswered: before.unanswered + 1 });
    });

    it('handyStopTally: a stop that gives up while a start is still out, and the stop after that start is confirmed, shows the confirmation', async () => {
        // Came Early pressed with a start still on its way: the press's stop
        // gives up unanswered, the start lands, and the stop sent after it
        // is confirmed. The device is at rest on that confirmation, and the
        // press says the Handy confirmed its stop, not that it had confirmed
        // an earlier one.
        await connectOk();
        HANDY_TIMINGS.stopRetryDelaysMs = [0, 0, 0];
        let releaseStart;
        routes['PUT /hamp/start'] = () => new Promise((resolve) => { releaseStart = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => typeof releaseStart === 'function', 'the start on its way');
        const before = handyStopTally();
        routes['PUT /hamp/stop'] = stopFailed;
        dispatchHandy(0, 0, 100, true, 0, 100);
        await until(() => sent('/hamp/stop').length === 4, 'every attempt of the press\'s stop');
        await until(() => handyStopTally().unanswered === before.unanswered + 1, 'the stop that gave up');
        assert.equal(handyRestState(), 'pending', 'the start is still on its way');
        routes['PUT /hamp/stop'] = undefined;
        releaseStart();
        await until(() => handyRestState() !== 'pending', 'the stop after the late start');
        assert.equal(sent('/hamp/stop').length, 5, 'a stop follows the start that landed late');
        assert.equal(handyRestState(), 'stopped');
        assert.deepEqual(handyStopTally(), { confirmed: before.confirmed + 1, unanswered: before.unanswered + 1 });
    });

    // Interleavings drawn from a fixed seed: starts and stops answered in any
    // order, with any outcome, across Disconnect, a reconnect with the same
    // key, another key, the offline verdict and the keepalive stop. Whenever
    // the page's record says a Handy may still be moving, handyRestState must
    // not call the toys at rest - while anything is still out, and once
    // everything has been answered.
    it('the page\'s warning and handyRestState never disagree, over seeded interleavings', async () => {
        const OTHER = 'second-key';
        let seed = 0x5eed1e55;
        const random = () => {
            seed = (seed * 1103515245 + 12345) >>> 0;
            return seed / 0x100000000;
        };
        // `choices` is [[weight, value], ...].
        const pick = (choices) => {
            let r = random() * choices.reduce((sum, [w]) => sum + w, 0);
            for (const [w, value] of choices) {
                r -= w;
                if (r < 0) return value;
            }
            return choices[choices.length - 1][1];
        };
        HANDY_TIMINGS.stopRetryDelaysMs = [0, 0, 0];
        HANDY_TIMINGS.offlineStopRetryMs = 1;
        let checks = 0;
        for (let run = 0; run < 40; run++) {
            resetHandyRestForTests();
            routes = {};
            await connectOk();
            const report = wireStopReport();
            let connecting = false;
            const pending = [];
            const hold = ({ path, key }) => new Promise((resolve, reject) => pending.push({ path, key, resolve, reject }));
            routes['PUT /hamp/stop'] = hold;
            routes['PUT /hamp/start'] = hold;
            routes['PUT /slide'] = () => jsonResponse({ result: 0 });
            routes['PUT /hamp/velocity'] = () => jsonResponse({ result: 0 });
            routes['/connected'] = () => jsonResponse({ connected: true });
            const ok = (p) => p.resolve(jsonResponse({ result: 0 }));
            const failed = (p) => p.resolve(jsonResponse({ message: 'bad gateway' }, 502));
            const timedOut = (p) => p.resolve(jsonResponse(DEVICE_TIMEOUT));
            const lost = (p) => p.reject(new TypeError('Failed to fetch'));
            const notConnected = (p) => p.resolve(jsonResponse(DEVICE_NOT_CONNECTED));
            // The API answers each device's stops alike for a stretch: down,
            // every attempt fails, as a device off its Wi-Fi does; up, nearly
            // every one goes through.
            const down = new Set();
            const answerOne = () => {
                if (pending.length === 0) return;
                const p = pending.splice(Math.floor(random() * pending.length), 1)[0];
                const isDown = down.has(p.key);
                const outcome = p.path === '/hamp/start'
                    ? (isDown ? pick([[1, timedOut], [1, notConnected], [1, lost]]) : pick([[6, ok], [1, timedOut], [1, notConnected]]))
                    : (isDown ? pick([[1, failed], [1, timedOut], [1, lost]]) : pick([[6, ok], [1, failed]]));
                outcome(p);
            };
            const action = () => pick([
                [4, () => dispatchHandy(50, 0, 100, true, 0, 100)],
                [4, () => dispatchHandy(0, 0, 100, true, 0, 100)],
                [1, () => { disconnectHandy(); }],
                [1, () => {
                    if (connecting) return;
                    connecting = true;
                    connectHandy(random() < 0.5 ? KEY : OTHER).catch(() => {}).finally(() => { connecting = false; });
                }],
                [0.5, () => {
                    routes['/connected'] = () => jsonResponse({ connected: false });
                    pollHandyConnected().finally(() => { routes['/connected'] = () => jsonResponse({ connected: true }); });
                }],
                [0.5, () => { stopHandyOnUnload(); }],
                [3, () => {
                    const key = random() < 0.5 ? KEY : OTHER;
                    if (down.has(key)) down.delete(key);
                    else down.add(key);
                }],
                [10, answerOne]
            ]);
            for (let step = 0; step < 60; step++) {
                action()();
                await tick(0);
                const rest = handyRestState();
                for (const key of [KEY, OTHER]) {
                    if (!report.owes(key)) continue;
                    checks += 1;
                    assert.ok(rest === 'pending' || rest === 'unconfirmed',
                        `run ${run}, step ${step}: the page says ${key} may still be moving, handyRestState says ${rest}`);
                }
            }
            // Answer everything still out, every stop confirmed, and let the
            // retries and the background job run out.
            routes['PUT /hamp/stop'] = () => jsonResponse({ result: 0 });
            routes['PUT /hamp/start'] = () => jsonResponse(DEVICE_NOT_CONNECTED);
            while (pending.length > 0) {
                const p = pending.shift();
                (p.path === '/hamp/start' ? notConnected : ok)(p);
                await tick(0);
            }
            await until(() => !connecting && handyRestState() !== 'pending' && !isHandyOfflineStopPending(), `run ${run} to settle`);
            const rest = handyRestState();
            for (const key of [KEY, OTHER]) {
                if (report.owes(key)) {
                    assert.equal(rest, 'unconfirmed', `run ${run}: the page says ${key} may still be moving once everything was answered`);
                }
            }
            disconnectHandy();
            await until(() => handyRestState() !== 'pending', `run ${run}'s Disconnect`);
        }
        // That the runs reached the warning at all, not a count to tune: the
        // interleavings shift with how busy the machine is.
        assert.ok(checks > 40, `the warning stood at only ${checks} checks`);
    });

    // ---- crash recovery: the stop for a device an earlier page left driving ------------

    const OFFLINE_REPLY = { error: { code: 1001, name: 'DeviceNotConnected', message: 'Device not connected', connected: false } };
    // The rounds run on unref'd timers, which never keep a node:test process
    // alive: a test that needs a later round waits for it on a timer of its own.
    const nextRound = () => tick(HANDY_TIMINGS.offlineStopRetryMs + 40);

    it('the crash stop sends PUT /hamp/stop with the given key and nothing else', async () => {
        const updates = [];
        const final = await stopHandyAfterCrash(` ${KEY} `, { onUpdate: (u) => updates.push(u) });
        // No /connected, no PUT /mode, no /info: the API needs none of them
        // before a stop, and a mode switch could only disturb another app.
        assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['PUT /hamp/stop']);
        assert.equal(calls[0].key, KEY);
        assert.equal(calls[0].body, undefined);
        assert.deepEqual(final, { outcome: 'stopped', detail: 'result 0', final: true });
        assert.deepEqual(updates, [final]);
        // Nothing was connected, and nothing was reported to app.js.
        assert.equal(handyConnected, false);
        assert.equal(getHandyKey(), '');
        assert.deepEqual([errors, offline, unconfirmed, notices], [[], [], [], []]);
    });

    it('an idle Handy answers that it was already stopped, and that settles it', async () => {
        routes['PUT /hamp/stop'] = jsonResponse({ result: 1 });
        const final = await stopHandyAfterCrash(KEY);
        assert.deepEqual(final, { outcome: 'already-stopped', detail: 'result 1', final: true });
        await nextRound();
        assert.equal(sent('/hamp/stop').length, 1, 'nothing more is sent');
    });

    it('a Handy in another mode ends it at once: no HAMP motion runs there', async () => {
        routes['PUT /hamp/stop'] = jsonResponse({ error: { code: 2002, name: 'MethodNotFound', message: 'No such method', connected: true } });
        const final = await stopHandyAfterCrash(KEY);
        assert.equal(final.outcome, 'not-hamp');
        await nextRound();
        assert.equal(sent('/hamp/stop').length, 1, 'nothing more is sent');
        assert.equal(sent('/mode').length, 0, 'and the mode is never touched');
    });

    it('retries an attempt that got no answer inside the round, and reports the answer once', async () => {
        let attempts = 0;
        routes['PUT /hamp/stop'] = () => {
            attempts += 1;
            if (attempts < 3) throw new TypeError('Failed to fetch');
            return jsonResponse({ result: 0 });
        };
        const updates = [];
        const final = await stopHandyAfterCrash(KEY, { onUpdate: (u) => updates.push(u) });
        assert.equal(attempts, 3);
        assert.equal(final.outcome, 'stopped');
        assert.deepEqual(updates, [final], 'the wearer is told the answer, not every attempt');
        assert.deepEqual(errors, [], "nothing reaches the live link's error line");
    });

    it('keeps sending the stop to an offline Handy and says so when it gets through', async () => {
        let online = false;
        routes['PUT /hamp/stop'] = () => (online ? jsonResponse({ result: 0 }) : jsonResponse(OFFLINE_REPLY));
        const updates = [];
        const done = stopHandyAfterCrash(KEY, { onUpdate: (u) => updates.push(u) });
        await tick(20);
        assert.equal(sent('/hamp/stop').length, 1, 'an offline answer is not asked again inside the round');
        assert.deepEqual(updates, [{ outcome: 'offline', detail: 'Device not connected', final: false }]);
        await tick(HANDY_TIMINGS.offlineStopRetryMs + 20);
        // At least: on a machine short of CPU the wait can outlast one more round.
        assert.ok(sent('/hamp/stop').length >= 2, 'a fresh round went out');
        assert.equal(updates.length, 1, 'the same answer again is not news');
        online = true;
        await nextRound();
        const final = await done;
        assert.deepEqual(final, { outcome: 'stopped', detail: 'result 0', final: true });
        assert.deepEqual(updates[updates.length - 1], final);
        assert.ok(sent('/hamp/stop').every((c) => c.key === KEY));
        assert.deepEqual([errors, offline, unconfirmed, notices], [[], [], [], []]);
    });

    it('gives up once its window is over, and the last update says so', async () => {
        // Rounds 200 ms apart in a 300 ms window: the second round starts
        // inside it, a third would not.
        HANDY_TIMINGS.offlineStopRetryMs = 200;
        HANDY_TIMINGS.crashStopWindowMs = 300;
        routes['PUT /hamp/stop'] = jsonResponse(OFFLINE_REPLY);
        const updates = [];
        const done = stopHandyAfterCrash(KEY, { onUpdate: (u) => updates.push(u) });
        await nextRound();
        // Bounded: a job that never gives up must fail here, not hang.
        const final = await Promise.race([done, tick(1000).then(() => 'still sending')]);
        assert.deepEqual(final, { outcome: 'offline', detail: 'Device not connected', final: true });
        assert.deepEqual(updates.map((u) => u.final), [false, true]);
        assert.equal(sent('/hamp/stop').length, 2);
        await nextRound();
        assert.equal(sent('/hamp/stop').length, 2, 'nothing after giving up');
    });

    it('a Handy API that never answers cannot stretch the window the wearer was told', async () => {
        // Every attempt waits out the request timeout, so one round of four
        // lasts longer than the whole window here - as sixty rounds of four
        // timed-out attempts would last half an hour against five minutes.
        HANDY_TIMINGS.requestTimeoutMs = 30;
        HANDY_TIMINGS.crashStopWindowMs = 150;
        routes['PUT /hamp/stop'] = () => new Promise(() => {});
        const updates = [];
        const done = stopHandyAfterCrash(KEY, { onUpdate: (u) => updates.push(u) });
        const final = await Promise.race([done, tick(1000).then(() => 'still sending')]);
        assert.deepEqual(final, { outcome: 'failed', detail: 'the request timed out', final: true });
        assert.deepEqual(updates, [final], 'it gave up after the round that ran past the window');
        assert.equal(sent('/hamp/stop').length, 4, 'one full round of attempts, each timed out');
        await nextRound();
        assert.equal(sent('/hamp/stop').length, 4, 'and no round after it');
        assert.deepEqual([errors, offline, unconfirmed, notices], [[], [], [], []]);
    });

    it('never touches the live link, not even while its own stops fail', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(isHandyMoving(), true);
        // No second round: the window closes with the first.
        HANDY_TIMINGS.crashStopWindowMs = 0;
        routes['PUT /hamp/stop'] = ({ key }) => (key === 'dead-key'
            ? jsonResponse({ error: { code: 3000, name: 'HampError', message: 'HampError', connected: true } })
            : jsonResponse({ result: 0 }));
        const final = await stopHandyAfterCrash('dead-key');
        assert.deepEqual(final, { outcome: 'failed', detail: 'HampError', final: true });
        assert.equal(sent('/hamp/stop').filter((c) => c.key === 'dead-key').length, 4, 'one full verified-stop round');
        assert.equal(sent('/hamp/stop').filter((c) => c.key === KEY).length, 0, 'the live device was not stopped');
        // A HAMP refusal of this stop is not the live device's news either.
        assert.deepEqual([errors, offline, unconfirmed, notices], [[], [], [], []]);
        assert.equal(handyConnected, true);
        assert.equal(getHandyKey(), KEY);
        assert.equal(isHandyMoving(), true);
    });

    // One record of whether a device has confirmed its stop (deviceMotion):
    // a crash stop the API confirms is entered there like any other.
    it('a crash stop the API confirms settles a stop this page still owed that very Handy', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        routes['PUT /hamp/stop'] = jsonResponse(DEVICE_TIMEOUT);
        assert.equal(await disconnectHandy(), false);
        assert.deepEqual(unconfirmedKeys, [KEY], 'the page was told it may still be moving');
        assert.equal(handyRestState(), 'unconfirmed');
        routes['PUT /hamp/stop'] = jsonResponse({ result: 0 });
        const final = await stopHandyAfterCrash(KEY);
        assert.deepEqual(final, { outcome: 'stopped', detail: 'result 0', final: true });
        assert.deepEqual(confirmedKeys, [KEY], 'and is told that very Handy confirmed a stop');
        assert.equal(handyRestState(), 'none');
        // A crash stop that settles nothing puts nothing in doubt here: the
        // job says so itself, on the crash report.
        routes['PUT /hamp/stop'] = jsonResponse(OFFLINE_REPLY);
        HANDY_TIMINGS.crashStopWindowMs = 0;
        assert.equal((await stopHandyAfterCrash('dead-key')).outcome, 'offline');
        assert.equal(handyRestState(), 'none');
        assert.deepEqual(unconfirmedKeys, [KEY]);
    });

    it('a stop already on its way when the crash stop finds the key linked settles nothing it raised', async () => {
        await connectOk();
        dispatchHandy(50, 0, 100, true, 0, 100);
        await until(() => isHandyMoving(), 'the start');
        let releaseStop = null;
        routes['PUT /hamp/stop'] = () => new Promise((resolve) => { releaseStop = () => resolve(jsonResponse({ result: 0 })); });
        dispatchHandy(0, 0, 100, false, 0, 100);
        await until(() => releaseStop !== null, 'the stop going out');
        // The dead page may have moved it after that stop left.
        assert.deepEqual(await stopHandyAfterCrash(KEY), { outcome: 'linked', detail: '', final: true });
        routes['PUT /hamp/stop'] = undefined;
        releaseStop();
        await tick(5);
        assert.equal(isHandyMoving(), false);
        assert.equal(handyMayBeMoving(), true, 'only a stop sent after it can vouch for the device');
        assert.equal(isHandyMotionUnknown(), true);
        dispatchHandy(0, 0, 100, false, 0, 100);
        await until(() => !handyMayBeMoving(), 'the stop sent after it');
        assert.equal(sent('/hamp/stop').length, 2, 'a fresh verified stop went out through the link');
        assert.deepEqual([errors, offline, unconfirmed, notices], [[], [], [], []]);
    });

    it('a key that is already the live link is sent nothing, and its driver no longer vouches for it being stopped', async () => {
        await connectOk();
        assert.equal(handyMayBeMoving(), false, 'Connect confirmed a stop');
        const final = await stopHandyAfterCrash(KEY);
        assert.deepEqual(final, { outcome: 'linked', detail: '', final: true });
        assert.equal(calls.length, 0, "no stop behind the live link's back");
        assert.equal(isHandyMotionUnknown(), true);
        assert.equal(handyMayBeMoving(), true);
        // A session that does not drive it - its role switched off, or a
        // zero-speed beat - used to send it nothing: the driver believed it
        // stopped. Now its next zero dispatch stops it through the link.
        dispatchHandy(0, 0, 100, false, 0, 100);
        await tick(5);
        assert.deepEqual(calls.map((c) => `${c.method} ${c.path} ${c.key}`), [`PUT /hamp/stop ${KEY}`]);
        assert.equal(handyMayBeMoving(), false);
        assert.deepEqual([errors, offline, unconfirmed, notices], [[], [], [], []]);
    });

    it('a session that drives the live link starts it as ever, and that start answers for it', async () => {
        await connectOk();
        await stopHandyAfterCrash(KEY);
        dispatchHandy(50, 0, 100, true, 0, 100);
        await tick(5);
        assert.equal(sent('/hamp/start').length, 1);
        assert.equal(sent('/hamp/stop').length, 0, 'no stop ahead of the start');
        assert.equal(isHandyMoving(), true);
        assert.equal(isHandyMotionUnknown(), false);
    });

    it('one job per key, and no key means no request', async () => {
        routes['PUT /hamp/stop'] = jsonResponse(OFFLINE_REPLY);
        const a = stopHandyAfterCrash(KEY);
        const b = stopHandyAfterCrash(KEY);
        await tick(20);
        assert.equal(sent('/hamp/stop').length, 1);
        routes['PUT /hamp/stop'] = undefined;
        await nextRound();
        const [fa, fb] = await Promise.all([a, b]);
        assert.equal(fa, fb);
        assert.equal(fa.outcome, 'stopped');
        calls = [];
        const none = await stopHandyAfterCrash('   ');
        assert.equal(none.outcome, 'failed');
        assert.equal(calls.length, 0);
    });

    it('Connect for the same key waits for the stop on the wire, then takes over', async () => {
        let releaseStop = null;
        let first = true;
        routes['PUT /hamp/stop'] = () => {
            if (!first) return jsonResponse({ result: 0 });
            first = false;
            return new Promise((resolve) => { releaseStop = () => resolve(jsonResponse(null, 503)); });
        };
        routes['/connected'] = jsonResponse({ connected: true });
        routes['/info'] = jsonResponse({ fwVersion: '3.2.3' });
        const updates = [];
        const done = stopHandyAfterCrash(KEY, { onUpdate: (u) => updates.push(u) });
        await tick(5);
        const connecting = connectHandy(KEY);
        await tick(20);
        // Were it sent now, the crash stop could land after this link's first
        // /hamp/start and stop the new session behind the driver's back.
        assert.equal(sent('/connected').length, 0, 'Connect waits for the crash stop on the wire');
        releaseStop();
        await connecting;
        const final = await done;
        assert.deepEqual(final, { outcome: 'connected', detail: '', final: true });
        assert.deepEqual(updates, [final], 'the unanswered attempt Connect waited for is not reported');
        assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
            'PUT /hamp/stop', 'GET /connected', 'PUT /mode', 'PUT /hamp/stop', 'GET /info'
        ]);
        dispatchHandy(50, 0, 100, true, 0, 100);
        await nextRound();
        assert.equal(sent('/hamp/stop').length, 2, 'no crash stop after the link took over');
        assert.equal(isHandyMoving(), true);
    });

    it('an answer that settles it while Connect waits is the one reported', async () => {
        let releaseStop = null;
        let first = true;
        routes['PUT /hamp/stop'] = () => {
            if (!first) return jsonResponse({ result: 1 });
            first = false;
            return new Promise((resolve) => { releaseStop = () => resolve(jsonResponse({ result: 0 })); });
        };
        routes['/connected'] = jsonResponse({ connected: true });
        const done = stopHandyAfterCrash(KEY);
        await tick(5);
        const connecting = connectHandy(KEY);
        await tick(5);
        releaseStop();
        assert.deepEqual(await done, { outcome: 'stopped', detail: 'result 0', final: true });
        await connecting;
        assert.equal(handyConnected, true);
    });

    it('a Connect that fails hands the device back to the crash stop', async () => {
        let online = false;
        routes['PUT /hamp/stop'] = () => (online ? jsonResponse({ result: 0 }) : jsonResponse(OFFLINE_REPLY));
        routes['/connected'] = jsonResponse({ connected: false });
        const done = stopHandyAfterCrash(KEY);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1);
        await assert.rejects(connectHandy(KEY), /offline/i);
        online = true;
        await nextRound();
        const final = await done;
        assert.deepEqual(final, { outcome: 'stopped', detail: 'result 0', final: true });
        assert.equal(sent('/hamp/stop').length, 2, 'the crash stop carried on after the failed Connect');
        assert.equal(handyConnected, false);
    });

    it('a crash stop asked for while Connect verifies the same key waits for that Connect', async () => {
        let releaseConnected = null;
        routes['/connected'] = () => new Promise((resolve) => { releaseConnected = () => resolve(jsonResponse({ connected: true })); });
        routes['/info'] = jsonResponse({ fwVersion: '3.2.3' });
        const connecting = connectHandy(KEY);
        await tick(5);
        const done = stopHandyAfterCrash(KEY);
        await tick(20);
        assert.equal(sent('/hamp/stop').length, 0, 'nothing may race the Connect that owns the device');
        releaseConnected();
        await connecting;
        assert.deepEqual(await done, { outcome: 'connected', detail: '', final: true });
        assert.equal(sent('/hamp/stop').length, 1, "only the Connect's own verified stop");
        await nextRound();
        assert.equal(sent('/hamp/stop').length, 1);
    });

    it('and when that Connect fails, the crash stop goes out at once', async () => {
        let releaseConnected = null;
        routes['/connected'] = () => new Promise((resolve) => { releaseConnected = () => resolve(jsonResponse({ connected: false })); });
        const connecting = connectHandy(KEY);
        await tick(5);
        const done = stopHandyAfterCrash(KEY);
        await tick(5);
        releaseConnected();
        await assert.rejects(connecting, /offline/i);
        await tick(5);
        assert.equal(sent('/hamp/stop').length, 1, 'no round of waiting for a job that never sent');
        assert.deepEqual(await done, { outcome: 'stopped', detail: 'result 0', final: true });
    });

    it('Connect with another key leaves the crash stop to its own device', async () => {
        // Rounds 200 ms apart in a 500 ms window: three rounds.
        HANDY_TIMINGS.offlineStopRetryMs = 200;
        HANDY_TIMINGS.crashStopWindowMs = 500;
        routes['PUT /hamp/stop'] = ({ key }) => (key === 'dead-key' ? jsonResponse(OFFLINE_REPLY) : jsonResponse({ result: 0 }));
        const done = stopHandyAfterCrash('dead-key');
        await tick(5);
        await connectOk();
        await nextRound();
        await nextRound();
        const final = await Promise.race([done, tick(1000).then(() => 'still sending')]);
        assert.deepEqual(final, { outcome: 'offline', detail: 'Device not connected', final: true });
        assert.equal(sent('/hamp/stop').filter((c) => c.key === 'dead-key').length, 2, 'its remaining rounds went out');
        assert.equal(handyConnected, true);
        assert.equal(getHandyKey(), KEY);
        assert.deepEqual([errors, offline, unconfirmed, notices], [[], [], [], []]);
    });

    it('a crash stop that gave up is told, once, when Connect with its key confirms a stop later', async () => {
        // No second round: the window closes with the first.
        HANDY_TIMINGS.crashStopWindowMs = 0;
        routes['PUT /hamp/stop'] = jsonResponse(OFFLINE_REPLY);
        const updates = [];
        const final = await stopHandyAfterCrash(KEY, { onUpdate: (u) => updates.push(u) });
        assert.deepEqual(final, { outcome: 'offline', detail: 'Device not connected', final: true });
        // The Handy is back, and the wearer connects it on the same page.
        routes['PUT /hamp/stop'] = undefined;
        await connectOk();
        assert.deepEqual(updates, [final, { outcome: 'connected', detail: '', final: true }]);
        disconnectHandy();
        await connectOk();
        assert.equal(updates.length, 2, 'a later Connect is not news');
    });

    it('a failed Connect, or one with another key, tells a crash stop that gave up nothing', async () => {
        HANDY_TIMINGS.crashStopWindowMs = 0;
        routes['PUT /hamp/stop'] = ({ key }) => (key === 'dead-key' ? jsonResponse(OFFLINE_REPLY) : jsonResponse({ result: 0 }));
        const updates = [];
        await stopHandyAfterCrash('dead-key', { onUpdate: (u) => updates.push(u) });
        routes['/connected'] = jsonResponse({ connected: false });
        await assert.rejects(connectHandy('dead-key'), /offline/i);
        await connectOk();
        assert.equal(getHandyKey(), KEY);
        assert.equal(updates.length, 1);
        assert.equal(updates[0].outcome, 'offline');
    });

    it('a crash stop that settled is not told about a later Connect', async () => {
        const updates = [];
        await stopHandyAfterCrash(KEY, { onUpdate: (u) => updates.push(u) });
        await connectOk();
        assert.deepEqual(updates, [{ outcome: 'stopped', detail: 'result 0', final: true }]);
    });

    it('a new crash stop for the key answers for it, and whoever heard the one before it give up is told when it settles', async () => {
        // A page's boot recovery gave up on the Handy and promised the next
        // page to open another stop; a session started in that page then
        // sends it a stop of its own. The first report must not keep that
        // promise standing once the device has answered.
        HANDY_TIMINGS.crashStopWindowMs = 0;
        routes['PUT /hamp/stop'] = jsonResponse(OFFLINE_REPLY);
        const before = [];
        await stopHandyAfterCrash(KEY, { onUpdate: (u) => before.push(u) });
        HANDY_TIMINGS.crashStopWindowMs = 60000;
        const now = [];
        const done = stopHandyAfterCrash(KEY, { onUpdate: (u) => now.push(u) });
        await until(() => now.length === 1, 'the first round answered');
        routes['PUT /hamp/stop'] = undefined;
        await connectOk();
        assert.deepEqual(await done, { outcome: 'connected', detail: '', final: true });
        assert.deepEqual(now.map((u) => u.outcome), ['offline', 'connected']);
        assert.deepEqual(before.map((u) => [u.outcome, u.final]), [['offline', true], ['connected', true]]);
        disconnectHandy();
        await connectOk();
        assert.equal(now.length, 2, 'a later Connect is not news');
    });

    it('whoever heard a stop give up is not told a later stop giving up too, only what settles it', async () => {
        // A give-up is not news alone to crash-recovery.js: it notes, or
        // ends, the promise of another try. Told twice, it would renew a
        // promise that the later stop's page may be the try of.
        HANDY_TIMINGS.crashStopWindowMs = 0;
        routes['PUT /hamp/stop'] = jsonResponse(OFFLINE_REPLY);
        const first = [];
        await stopHandyAfterCrash(KEY, { onUpdate: (u) => first.push(u) });
        const second = [];
        await stopHandyAfterCrash(KEY, { onUpdate: (u) => second.push(u) });
        assert.equal(first.length, 1, 'not told the second give-up');
        assert.deepEqual(second.map((u) => [u.outcome, u.final]), [['offline', true]]);
        // A third stop gets through: everyone who heard a give-up hears it.
        routes['PUT /hamp/stop'] = jsonResponse({ result: 1 });
        const third = [];
        await stopHandyAfterCrash(KEY, { onUpdate: (u) => third.push(u) });
        const settled = { outcome: 'already-stopped', detail: 'result 1', final: true };
        assert.deepEqual(third, [settled]);
        assert.deepEqual(first[first.length - 1], settled);
        assert.deepEqual(second[second.length - 1], settled);
        assert.equal(first.length, 2);
        assert.equal(second.length, 2);
    });

    it('a second stop for a key already being stopped joins that job: one request at a time, every answer to both', async () => {
        routes['PUT /hamp/stop'] = jsonResponse(OFFLINE_REPLY);
        const first = [];
        const a = stopHandyAfterCrash(KEY, { onUpdate: (u) => first.push(u) });
        await until(() => first.length === 1, 'the first round answered');
        assert.deepEqual(first.map((u) => [u.outcome, u.final]), [['offline', false]]);
        const second = [];
        const sentBefore = sent('/hamp/stop').length;
        const b = stopHandyAfterCrash(KEY, { onUpdate: (u) => second.push(u) });
        assert.deepEqual(second, first, 'told the latest answer at once');
        assert.equal(sent('/hamp/stop').length, sentBefore, 'joining sends nothing of its own');
        routes['PUT /hamp/stop'] = undefined;
        await nextRound();
        const [fa, fb] = await Promise.all([a, b]);
        assert.equal(fa, fb);
        assert.deepEqual(fa, { outcome: 'stopped', detail: 'result 0', final: true });
        assert.deepEqual(first[first.length - 1], fa);
        assert.deepEqual(second[second.length - 1], fa);
        assert.ok(sent('/hamp/stop').every((c) => c.key === KEY));
    });
});
