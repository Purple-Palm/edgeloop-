// Keeps the screen on while a session is live (Screen Wake Lock API: Chrome
// and Edge 84+, Firefox 126+, Safari 16.4+ and 18.4+ on iOS, secure contexts
// only).
//
// A phone that locks its screen hides the page, and a hidden page is one the
// browser throttles and then freezes (see supervision.js): the session ends
// in a supervision pause a minute or so after the screen goes dark, and on a
// phone that suspends the page at once the toy runs unwatched until the
// screen is unlocked again. So while a session is RUNNING or RAMPDOWN the
// page asks the browser to keep the screen awake.
//
// Rules:
//   - held only while the session is live: released on pause, stop, reset
//     and idle, and a lock granted after the session stopped is released the
//     moment it arrives;
//   - the browser itself releases the lock whenever the page is hidden, and
//     refuses a request from a hidden page, so it is asked for again when the
//     page is back in view and the session is still live;
//   - a missing API, a request that throws and a request the browser refuses
//     (a battery saver, a permissions policy) never reach the caller. A
//     refusal is not retried on every tick: only a fresh START / RESUME or
//     the page coming back into view asks again.
//
// Pure apart from the API it is handed, so every transition runs under
// node:test; app.js hands it navigator.wakeLock and the page's visibility.

export function createScreenWakeLock({ getWakeLock = () => undefined, isVisible = () => true } = {}) {
    let wanted = false;
    let sentinel = null;
    let requesting = false;
    // The last request was refused. Forgotten when the session stops (so
    // the next START / RESUME asks again) or the page comes back into view.
    let refused = false;
    // Bumped by every event that entitles a refused lock to another try, so
    // a refusal that lands after one of them does not latch.
    let attempt = 0;

    const api = () => {
        try {
            const lock = getWakeLock();
            return lock && typeof lock.request === 'function' ? lock : null;
        } catch (e) {
            return null;
        }
    };

    const visible = () => {
        try {
            return Boolean(isVisible());
        } catch (e) {
            return false;
        }
    };

    function release(held) {
        try {
            const done = held.release();
            if (done && typeof done.catch === 'function') done.catch(() => {});
        } catch (e) {
            // Already released by the browser.
        }
    }

    // The `release` event is what tells a lock the browser dropped: the
    // `released` flag only arrived in Chrome 87, three versions after the API.
    function hold(granted) {
        sentinel = granted;
        const onRelease = () => {
            if (sentinel === granted) sentinel = null;
        };
        try {
            if (typeof granted.addEventListener === 'function') granted.addEventListener('release', onRelease);
            else granted.onrelease = onRelease;
        } catch (e) {
            // The `released` flag, where there is one, still tells.
        }
        if (granted.released === true) onRelease();
    }

    function isHeld() {
        return Boolean(sentinel && sentinel.released !== true);
    }

    function acquire() {
        if (!wanted || requesting || refused || isHeld()) return;
        // A hidden page is refused anyway; it asks again when it is shown.
        if (!visible()) return;
        const lock = api();
        if (!lock) return;
        const mine = attempt;
        let pending;
        try {
            pending = Promise.resolve(lock.request('screen'));
        } catch (e) {
            refused = true;
            return;
        }
        requesting = true;
        // A refusal counts against this attempt only. If the session was
        // started again or the page came back into view while the request
        // was out, that event is owed a request of its own.
        const refusedNow = () => {
            if (mine === attempt) refused = true;
            else acquire();
        };
        pending.then((granted) => {
            requesting = false;
            if (!granted || typeof granted.release !== 'function') {
                refusedNow();
                return;
            }
            if (!wanted) {
                release(granted);
                return;
            }
            hold(granted);
            // Already released when it arrived: the page was hidden while
            // the request was out. Shown again since, it asks again now;
            // otherwise the next time it is shown does.
            if (!isHeld() && mine !== attempt) acquire();
        }, () => {
            requesting = false;
            refusedNow();
        });
    }

    return {
        // Hold the lock while `live` is true, release it otherwise.
        update(live) {
            if (!live) {
                wanted = false;
                refused = false;
                if (sentinel) {
                    const held = sentinel;
                    sentinel = null;
                    release(held);
                }
                return;
            }
            if (!wanted) attempt += 1;
            wanted = true;
            acquire();
        },
        // The page's visibility changed. Back in view, a live session asks
        // again (the browser dropped the lock when the page was hidden) and
        // an earlier refusal gets another try.
        visibilityChanged() {
            if (!visible()) return;
            refused = false;
            attempt += 1;
            acquire();
        },
        get held() {
            return isHeld();
        },
        get requesting() {
            return requesting;
        },
        get refused() {
            return refused;
        },
        get supported() {
            return Boolean(api());
        }
    };
}
