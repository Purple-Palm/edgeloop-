import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenWakeLock } from './screen-wake-lock.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

// A stand-in for navigator.wakeLock that behaves like the browser's: each
// grant is a sentinel with `released`, `release()` and a `release` event, and
// hiding the page releases every sentinel it handed out. `mode` decides the
// next request: 'grant', 'reject' (NotAllowedError), 'throw', or 'hold'
// (settled later by the test through `settle`).
function fakeBrowser({ mode = 'grant', visible = true, releasedFlag = true } = {}) {
    const b = {
        mode,
        visible,
        releasedFlag,
        requests: 0,
        releases: 0,
        sentinels: [],
        held: [],
        later: [],
        api: {
            request(type) {
                b.requests += 1;
                assert.equal(type, 'screen');
                if (b.mode === 'throw') throw new TypeError('wake lock exploded');
                if (b.mode === 'reject') return Promise.reject(Object.assign(new Error('refused'), { name: 'NotAllowedError' }));
                const sentinel = b.makeSentinel();
                if (b.mode === 'hold') {
                    return new Promise((resolve, reject) => b.later.push({ resolve: () => resolve(sentinel), reject, sentinel }));
                }
                return Promise.resolve(sentinel);
            }
        },
        // Chrome 84-86 had no `released` flag: the release event was the only
        // way to learn that the browser had dropped a lock.
        makeSentinel() {
            const s = new EventTarget();
            s.gone = false;
            if (b.releasedFlag) Object.defineProperty(s, 'released', { get: () => s.gone });
            s.type = 'screen';
            s.release = () => {
                if (!s.gone) {
                    s.gone = true;
                    b.releases += 1;
                    s.dispatchEvent(new Event('release'));
                }
                return Promise.resolve();
            };
            b.sentinels.push(s);
            return s;
        },
        // What a browser does when the page is hidden: every lock goes.
        hide() {
            b.visible = false;
            b.sentinels.forEach((s) => {
                if (!s.gone) {
                    s.gone = true;
                    s.dispatchEvent(new Event('release'));
                }
            });
        },
        show() {
            b.visible = true;
        },
        live() {
            return b.sentinels.filter((s) => !s.gone).length;
        }
    };
    return b;
}

function lockFor(b) {
    return createScreenWakeLock({ getWakeLock: () => b.api, isVisible: () => b.visible });
}

describe('createScreenWakeLock', () => {
    it('asks once when the session goes live and holds the lock', async () => {
        const b = fakeBrowser();
        const lock = lockFor(b);
        lock.update(true);
        await flush();
        assert.equal(b.requests, 1);
        assert.equal(lock.held, true);
        // The master clock re-asserts it every tick: no second request.
        for (let i = 0; i < 5; i++) lock.update(true);
        await flush();
        assert.equal(b.requests, 1);
        assert.equal(b.live(), 1);
    });

    it('releases on pause, stop and reset, and asks again on the next start', async () => {
        const b = fakeBrowser();
        const lock = lockFor(b);
        lock.update(true);
        await flush();
        lock.update(false);
        assert.equal(lock.held, false);
        assert.equal(b.releases, 1);
        assert.equal(b.live(), 0);
        // Idle ticks keep it released.
        lock.update(false);
        await flush();
        assert.equal(b.requests, 1);
        lock.update(true);
        await flush();
        assert.equal(b.requests, 2);
        assert.equal(lock.held, true);
    });

    it('does not ask while the page is hidden, and asks when it is shown', async () => {
        const b = fakeBrowser({ visible: false });
        const lock = lockFor(b);
        lock.update(true);
        await flush();
        assert.equal(b.requests, 0);
        b.show();
        lock.visibilityChanged();
        await flush();
        assert.equal(b.requests, 1);
        assert.equal(lock.held, true);
    });

    it('asks again after the browser dropped the lock for a hidden page', async () => {
        const b = fakeBrowser();
        const lock = lockFor(b);
        lock.update(true);
        await flush();
        b.hide();
        lock.visibilityChanged();
        assert.equal(lock.held, false);
        // Ticks while hidden do not ask (the browser would refuse).
        lock.update(true);
        await flush();
        assert.equal(b.requests, 1);
        b.show();
        lock.visibilityChanged();
        await flush();
        assert.equal(b.requests, 2);
        assert.equal(lock.held, true);
    });

    it('learns of a dropped lock from the release event alone (no `released` flag)', async () => {
        const b = fakeBrowser({ releasedFlag: false });
        const lock = lockFor(b);
        lock.update(true);
        await flush();
        assert.equal(lock.held, true);
        b.hide();
        lock.visibilityChanged();
        assert.equal(lock.held, false);
        b.show();
        lock.visibilityChanged();
        await flush();
        assert.equal(b.requests, 2, 'asked again once the page was shown');
        assert.equal(lock.held, true);
        lock.update(false);
        assert.equal(b.live(), 0);
    });

    it('does not ask when the page comes back to a session that is no longer live', async () => {
        const b = fakeBrowser();
        const lock = lockFor(b);
        lock.update(true);
        await flush();
        b.hide();
        lock.update(false);
        b.show();
        lock.visibilityChanged();
        await flush();
        assert.equal(b.requests, 1);
        assert.equal(lock.held, false);
    });

    it('releases a lock that is granted after the session stopped', async () => {
        const b = fakeBrowser({ mode: 'hold' });
        const lock = lockFor(b);
        lock.update(true);
        assert.equal(lock.requesting, true);
        lock.update(false);
        b.later[0].resolve();
        await flush();
        assert.equal(lock.held, false);
        assert.equal(b.live(), 0, 'the late grant was released on arrival');
        assert.equal(lock.requesting, false);
    });

    it('keeps one request in flight across a quick pause and resume', async () => {
        const b = fakeBrowser({ mode: 'hold' });
        const lock = lockFor(b);
        lock.update(true);
        lock.update(false);
        lock.update(true);
        assert.equal(b.requests, 1);
        b.later[0].resolve();
        await flush();
        assert.equal(lock.held, true);
        assert.equal(b.requests, 1);
    });

    it('asks again when a refusal lands after a quick pause and resume', async () => {
        // The RESUME is owed a request of its own: the refusal belongs to the
        // request made before the pause.
        const b = fakeBrowser({ mode: 'hold' });
        const lock = lockFor(b);
        lock.update(true);
        lock.update(false);
        lock.update(true);
        b.mode = 'grant';
        b.later[0].reject(Object.assign(new Error('refused'), { name: 'NotAllowedError' }));
        await flush();
        assert.equal(b.requests, 2);
        assert.equal(lock.held, true);
    });

    it('never throws, and never breaks the caller, without the API', async () => {
        for (const getWakeLock of [() => undefined, () => null, () => ({}), () => { throw new Error('no navigator'); }]) {
            const lock = createScreenWakeLock({ getWakeLock, isVisible: () => true });
            assert.doesNotThrow(() => { lock.update(true); lock.visibilityChanged(); lock.update(false); });
            await flush();
            assert.equal(lock.held, false);
            assert.equal(lock.supported, false);
        }
        // Nor with no options at all, or a visibility probe that throws.
        assert.doesNotThrow(() => createScreenWakeLock().update(true));
        const odd = createScreenWakeLock({ getWakeLock: () => fakeBrowser().api, isVisible: () => { throw new Error('no document'); } });
        assert.doesNotThrow(() => odd.update(true));
    });

    it('takes a refusal quietly and does not ask again on every tick', async () => {
        const b = fakeBrowser({ mode: 'reject' });
        const lock = lockFor(b);
        lock.update(true);
        await flush();
        assert.equal(b.requests, 1);
        assert.equal(lock.refused, true);
        assert.equal(lock.held, false);
        for (let i = 0; i < 30; i++) lock.update(true);
        await flush();
        assert.equal(b.requests, 1, 'a refusal is not retried by the clock');
    });

    it('asks again after a refusal once the session is started again or the page is shown', async () => {
        const b = fakeBrowser({ mode: 'reject' });
        const lock = lockFor(b);
        lock.update(true);
        await flush();
        b.mode = 'grant';
        lock.update(false);
        lock.update(true);
        await flush();
        assert.equal(b.requests, 2);
        assert.equal(lock.held, true);

        const c = fakeBrowser({ mode: 'reject' });
        const other = lockFor(c);
        other.update(true);
        await flush();
        c.mode = 'grant';
        c.hide();
        other.visibilityChanged();
        c.show();
        other.visibilityChanged();
        await flush();
        assert.equal(c.requests, 2);
        assert.equal(other.held, true);
    });

    it('treats a request that throws like a refusal', async () => {
        const b = fakeBrowser({ mode: 'throw' });
        const lock = lockFor(b);
        assert.doesNotThrow(() => lock.update(true));
        await flush();
        assert.equal(lock.refused, true);
        lock.update(true);
        await flush();
        assert.equal(b.requests, 1);
    });

    it('asks again when a refusal lands after the page was shown again', async () => {
        // Hidden while the request was out (the browser refuses it), shown
        // again before the refusal arrived: that showing is owed a request.
        const b = fakeBrowser({ mode: 'hold' });
        const lock = lockFor(b);
        lock.update(true);
        b.hide();
        lock.visibilityChanged();
        b.show();
        lock.visibilityChanged();
        assert.equal(b.requests, 1, 'still one in flight');
        b.mode = 'grant';
        b.later[0].reject(Object.assign(new Error('hidden'), { name: 'NotAllowedError' }));
        await flush();
        assert.equal(b.requests, 2);
        assert.equal(lock.held, true);
        assert.equal(lock.refused, false);
    });

    it('asks again when a grant arrives already released but the page is shown again', async () => {
        const b = fakeBrowser({ mode: 'hold' });
        const lock = lockFor(b);
        lock.update(true);
        b.hide(); // releases the sentinel the pending request will hand over
        lock.visibilityChanged();
        b.show();
        lock.visibilityChanged();
        b.mode = 'grant';
        b.later[0].resolve();
        await flush();
        assert.equal(lock.held, true);
        assert.equal(b.requests, 2);
    });

    it('does not spin when a grant arrives already released with nothing new since', async () => {
        const b = fakeBrowser({ mode: 'hold' });
        const lock = lockFor(b);
        lock.update(true);
        b.hide();
        b.later[0].resolve();
        await flush();
        assert.equal(lock.held, false);
        assert.equal(b.requests, 1);
        // Shown again: now it asks.
        b.mode = 'grant';
        b.show();
        lock.visibilityChanged();
        await flush();
        assert.equal(b.requests, 2);
        assert.equal(lock.held, true);
    });
});
