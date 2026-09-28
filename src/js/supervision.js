// Whether the page is still supervising a running session. Pure: no DOM, no
// timers, so every rule runs under node:test; app.js feeds it the clock.
//
// No toy can tell that EdgeLoop has stopped watching. The Handy is driven
// through the cloud and holds its last command until told otherwise; an
// Intiface or T-Code axis keeps the speed its planner was last given. What
// brings any of them back under the pulse is this page's own code running:
// the one-second master clock (the signal-loss watchdog, the session clock,
// every guard and game) and the heart-rate packets. A page the browser has
// stopped running supervises nothing, whatever the cockpit last showed.
//
// Browsers do exactly that to a page in the background. What Chrome does,
// from its own documentation and source, and measured on Chromium 141:
//   - a hidden page's timers are woken at most once a second, so two ticks
//     of the one-second clock arrive 1-2 s apart
//     (developer.chrome.com/blog/timer-throttling-in-chrome-88);
//   - once a hidden, silent page has been hidden long enough, its chained
//     timers - every setInterval - are woken once a MINUTE. The article says
//     5 minutes; for a page that had finished loading when it was hidden,
//     current Chrome waits only 60 s (the "loaded" grace period in
//     GetIntensiveWakeUpThrottlingGracePeriod), and a background tab here
//     went from one tick a second to one tick a minute 60 s after it was
//     hidden;
//   - a hidden page can be frozen outright - on Android soon after it is
//     backgrounded (kStopInBackground; a minute by default in the source),
//     on the desktop under Energy Saver and for the back/forward cache - and
//     then nothing runs at all until it is resumed. `freeze` fires for it;
//     `pagehide` does not (Page Lifecycle API).
// A phone that locks its screen hides the page; a laptop that sleeps runs
// nothing. Throughout any of that the toy kept doing what it was last told.

import { DEFAULT_WATCHDOG_SETTINGS, clampStaleSeconds } from './hr-watchdog.js';

// The master clock's period in app.js.
export const MASTER_CLOCK_MS = 1000;

// The longest the master clock may go without a tick while a session is
// live before the page counts as no longer supervising it. Two bounds the
// watchdog already puts on the wearer's pulse, whichever is shorter:
//   - the signal-loss timeout the wearer set (3-20 s). A gap that long is a
//     gap in which a lost pulse could have gone unanswered for as long as
//     they allow in total;
//   - the 5 s hold band, the longest the watchdog drives on a reading it has
//     not refreshed before it even says so. The page may not go longer than
//     that without looking at all.
// The floor is the shortest timeout, 3 s, which is still clear of the ticks
// of an ordinary hidden tab (1-2 s apart) and of a tick running a second or
// two late on a busy page. A minute between ticks, Chrome's intensive
// throttling, is twelve times the widest limit.
export function supervisionGapLimitMs(hrStaleSeconds) {
    const staleMs = clampStaleSeconds(hrStaleSeconds) * 1000;
    return Math.min(staleMs, DEFAULT_WATCHDOG_SETTINGS.holdMs);
}

// Remembers when the page last supervised: the last master-clock tick, or
// the moment a session became live (START / RESUME), which is where a gap
// begins to count. Measured on the wall clock, because a sleeping computer
// stops the monotonic clock on some systems while the Handy keeps moving.
export function createSupervisionClock() {
    let lastBeatAt = null;
    // The page was hidden at some point since the last beat, so a gap can be
    // told apart from a page that was on screen but blocked (a dialog open).
    let hiddenSinceBeat = false;

    return {
        beat(now, { hidden = false } = {}) {
            lastBeatAt = Number.isFinite(now) ? now : null;
            hiddenSinceBeat = Boolean(hidden);
        },
        noteHidden() {
            hiddenSinceBeat = true;
        },
        // How long the page has gone without supervising, and whether that
        // is past `limitMs`. Side-effect free, so a heart-rate packet can ask
        // between two ticks without moving the tick's own measurement. A wall
        // clock set backwards is no gap: the next beat takes the new time.
        check(now, { limitMs, hidden = false } = {}) {
            const limit = Number.isFinite(limitMs) && limitMs > 0 ? limitMs : supervisionGapLimitMs();
            const gapMs = Number.isFinite(lastBeatAt) && Number.isFinite(now) ? Math.max(0, now - lastBeatAt) : 0;
            return {
                gapMs,
                limitMs: limit,
                lost: gapMs > limit,
                background: hiddenSinceBeat || Boolean(hidden)
            };
        },
        get lastBeatAt() {
            return lastBeatAt;
        }
    };
}

// A session the page had to put down when it went away, remembered until the
// page comes back so the wearer is told why it is paused. `kind` is 'freeze'
// (the browser froze the page), 'bfcache' (pagehide into the back/forward
// cache) or 'unload' (pagehide for good). Only the first event of one
// departure counts: Chrome fires pagehide and THEN freeze for the
// back/forward cache, and on the way back resume and then pageshow.
export function createPageAwayTracker() {
    let away = null;
    return {
        // `wasRunning`: the session was RUNNING or RAMPDOWN, as opposed to a
        // watchdog pause that would have resumed by itself.
        leave(kind, now, { wasRunning = true } = {}) {
            if (away) return false;
            away = { kind: String(kind || 'freeze'), at: Number.isFinite(now) ? now : null, wasRunning: Boolean(wasRunning) };
            return true;
        },
        // The page is back. Returns the departure once, with how long it
        // lasted when that is known, or null when nothing was put down.
        back(now) {
            if (!away) return null;
            const trip = {
                ...away,
                awayMs: Number.isFinite(away.at) && Number.isFinite(now) ? Math.max(0, now - away.at) : null
            };
            away = null;
            return trip;
        },
        get away() {
            return away ? { ...away } : null;
        }
    };
}

// "12 s", "4 min 12 s", "2 h 5 min".
export function formatGap(ms) {
    const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
    if (total < 60) return `${total} s`;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
    return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

const RESUME_WHEN_READY = 'press RESUME when you are ready';
// What the wearer can do about a browser that holds back pages it hides.
const KEEP_IN_VIEW = ', and keep EdgeLoop in view to avoid this';

// The banner for a master clock that stalled under a live session. On
// screen the page cannot have been throttled, so it names what else stops
// it: a native dialog, a busy page, a sleeping computer.
export function describeSupervisionGap({ gapMs, background = false } = {}) {
    const span = formatGap(gapMs);
    if (background) {
        return `This page was in the background and the browser held EdgeLoop back for ${span}, so it could not supervise the toys. Every toy was stopped and the session paused; ${RESUME_WHEN_READY}${KEEP_IN_VIEW}.`;
    }
    return `EdgeLoop was held up for ${span} (an open dialog, a busy page or a sleeping computer can do that), so it could not supervise the toys. Every toy was stopped and the session paused; ${RESUME_WHEN_READY}.`;
}

// The banner for a session put down because the page went away. A session
// the watchdog had already paused was not moving, but it would have resumed
// by itself on the first packet after the page came back, so it is told
// apart.
export function describePageAway({ kind = 'freeze', awayMs = null, wasRunning = true } = {}) {
    const span = Number.isFinite(awayMs) && awayMs >= 1000 ? ` for ${formatGap(awayMs)}` : '';
    const frozen = kind === 'freeze';
    const what = frozen
        ? `The browser froze this page in the background${span}, so EdgeLoop could not supervise the toys.`
        : 'You left this page while the session was on, so EdgeLoop could not supervise the toys.';
    const then = wasRunning
        ? 'Every toy was stopped and the session paused;'
        : 'The session stays paused and will not resume by itself when your pulse returns;';
    return `${what} ${then} ${RESUME_WHEN_READY}${frozen ? KEEP_IN_VIEW : ''}.`;
}
