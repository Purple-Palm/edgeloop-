// The crash stop of a Handy the dead session drove over HSP (handy.js,
// stopHandyAfterCrash with protocol 'hsp'), against a mocked global fetch
// that answers both API v2 and API v3.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HANDY_TIMINGS, stopHandyAfterCrash, resetHandyCrashStopsForTests, resetHandyRestForTests, setHandyHandlers } from './handy.js';
import { HANDY_API_BASE } from './handy-protocol.js';
import { HANDY_V3_BASE, HANDY_APP_ID } from './handy-hsp-protocol.js';

const KEY = 'crash-key-hsp';
const NOT_HAMP = { error: { code: 2002, name: 'MethodNotFound', message: 'No such method', connected: true } };
const OFFLINE = { error: { code: 1001, name: 'DeviceNotConnected', message: 'Device not connected', connected: false } };
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let calls;
let routes;
// The driver's rounds run on unref'd timers; this keeps the test alive for them.
let keepAlive = null;
const saved = { ...HANDY_TIMINGS, stopRetryDelaysMs: HANDY_TIMINGS.stopRetryDelaysMs.slice() };

beforeEach(() => {
    keepAlive = setInterval(() => {}, 10);
    calls = [];
    routes = {};
    HANDY_TIMINGS.stopRetryDelaysMs = [0, 0, 0];
    HANDY_TIMINGS.offlineStopRetryMs = 20;
    HANDY_TIMINGS.crashStopWindowMs = 200;
    globalThis.fetch = async (url, init = {}) => {
        const api = url.startsWith(HANDY_V3_BASE) ? 'v3' : url.startsWith(HANDY_API_BASE) ? 'v2' : '?';
        const path = url.slice((api === 'v3' ? HANDY_V3_BASE : HANDY_API_BASE).length);
        const call = { api, path, method: init.method || 'GET', headers: init.headers || {} };
        calls.push(call);
        const handler = routes[`${api} ${call.method} ${path}`];
        const answer = typeof handler === 'function' ? handler(call) : handler;
        if (answer === 'network') throw new TypeError('Failed to fetch');
        return answer || json({ result: 0 });
    };
});

afterEach(() => {
    clearInterval(keepAlive);
    resetHandyCrashStopsForTests();
    resetHandyRestForTests();
    Object.assign(HANDY_TIMINGS, saved);
    setHandyHandlers({ onLinkedCrash: null });
});

describe('the crash stop of a Handy driven over HSP', () => {
    it('sends the v3 HSP stop with the Application ID beside the v2 HAMP stop, and a confirmed HSP stop settles it', async () => {
        routes['v2 PUT /hamp/stop'] = json(NOT_HAMP);
        routes['v3 PUT /hsp/stop'] = json({ result: { play_state: 2, points: 0 } });
        const final = await stopHandyAfterCrash(KEY, { protocol: 'hsp' });
        assert.equal(final.outcome, 'stopped');
        assert.equal(final.final, true);
        const v3 = calls.filter((c) => c.api === 'v3');
        assert.deepEqual(v3.map((c) => `${c.method} ${c.path}`), ['PUT /hsp/stop']);
        assert.equal(v3[0].headers['X-Api-Key'], HANDY_APP_ID);
        assert.equal(v3[0].headers['X-Connection-Key'], KEY);
        assert.deepEqual(calls.filter((c) => c.api === 'v2').map((c) => c.path), ['/hamp/stop']);
    });

    it('sends the override Application ID when one is given', async () => {
        routes['v3 PUT /hsp/stop'] = json({ result: { play_state: 2, points: 0 } });
        await stopHandyAfterCrash(KEY, { protocol: 'hsp', apiKey: 'My-Own-Application-Id' });
        assert.equal(calls.find((c) => c.api === 'v3').headers['X-Api-Key'], 'My-Own-Application-Id');
    });

    it('is not settled by "not in HAMP mode": it keeps sending both stops', async () => {
        routes['v2 PUT /hamp/stop'] = json(NOT_HAMP);
        routes['v3 PUT /hsp/stop'] = 'network';
        const final = await stopHandyAfterCrash(KEY, { protocol: 'hsp' });
        assert.equal(final.outcome, 'failed');
        assert.match(final.detail, /No such method/);
        assert.ok(calls.filter((c) => c.api === 'v3').length >= 2, 'retried');
    });

    it('a HAMP session\'s stop is what it always was: v2 only, and "not in HAMP mode" settles it', async () => {
        routes['v2 PUT /hamp/stop'] = json(NOT_HAMP);
        const final = await stopHandyAfterCrash(KEY);
        assert.equal(final.outcome, 'not-hamp');
        assert.equal(calls.filter((c) => c.api === 'v3').length, 0);
    });

    it('reports an offline device as offline', async () => {
        routes['v2 PUT /hamp/stop'] = json(OFFLINE);
        routes['v3 PUT /hsp/stop'] = json(OFFLINE);
        const final = await stopHandyAfterCrash(KEY, { protocol: 'hsp' });
        assert.equal(final.outcome, 'offline');
    });

    it('a second request for the same key over HSP turns a HAMP job into an HSP one', async () => {
        let v2 = 0;
        routes['v2 PUT /hamp/stop'] = () => {
            v2 += 1;
            return json(OFFLINE);
        };
        routes['v3 PUT /hsp/stop'] = json({ result: { play_state: 2, points: 0 } });
        const first = stopHandyAfterCrash(KEY);
        const second = stopHandyAfterCrash(KEY, { protocol: 'hsp' });
        const [a, b] = await Promise.all([first, second]);
        assert.equal(a, b);
        assert.equal(a.outcome, 'stopped');
        assert.ok(v2 >= 1);
        assert.ok(calls.some((c) => c.api === 'v3'));
    });
});
