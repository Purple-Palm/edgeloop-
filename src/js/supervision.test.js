import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MASTER_CLOCK_MS,
    supervisionGapLimitMs,
    createSupervisionClock,
    createPageAwayTracker,
    formatGap,
    describeSupervisionGap,
    describePageAway
} from './supervision.js';
import { DEFAULT_WATCHDOG_SETTINGS, MIN_STALE_SECONDS, MAX_STALE_SECONDS } from './hr-watchdog.js';

// A master clock ticking every `intervalMs` from `start`, returning the
// verdict of every tick after the first: what app.js asks on each tick.
function runTicks(clock, { start = 0, intervals, limitMs, hidden = false }) {
    let now = start;
    clock.beat(now, { hidden });
    return intervals.map((interval) => {
        now += interval;
        const verdict = clock.check(now, { limitMs, hidden });
        clock.beat(now, { hidden });
        return verdict;
    });
}

describe('supervisionGapLimitMs', () => {
    it('is the signal-loss timeout, capped at the watchdog hold band', () => {
        assert.equal(supervisionGapLimitMs(3), 3000);
        assert.equal(supervisionGapLimitMs(4), 4000);
        assert.equal(supervisionGapLimitMs(5), DEFAULT_WATCHDOG_SETTINGS.holdMs);
        // The factory timeout (8 s) and the longest one (20 s) both stop at
        // the 5 s the watchdog drives on an unrefreshed reading.
        assert.equal(supervisionGapLimitMs(8), 5000);
        assert.equal(supervisionGapLimitMs(MAX_STALE_SECONDS), 5000);
    });

    it('is clamped like the timeout itself, so a stored value cannot widen it', () => {
        assert.equal(supervisionGapLimitMs(1), MIN_STALE_SECONDS * 1000);
        assert.equal(supervisionGapLimitMs(0), MIN_STALE_SECONDS * 1000);
        assert.equal(supervisionGapLimitMs(9999), 5000);
        assert.equal(supervisionGapLimitMs('abc'), 5000);
        assert.equal(supervisionGapLimitMs(undefined), 5000);
        assert.equal(supervisionGapLimitMs(NaN), 5000);
    });

    it('never falls to a gap an ordinary hidden tab or a late tick produces', () => {
        // Chrome wakes a hidden page's timers at most once a second, so the
        // one-second clock ticks 1-2 s apart there; a tick 1-2 s late on a
        // busy page arrives 2-3 s after the previous one.
        for (let stale = MIN_STALE_SECONDS; stale <= MAX_STALE_SECONDS; stale += 1) {
            assert.ok(supervisionGapLimitMs(stale) >= 3 * MASTER_CLOCK_MS, `timeout ${stale} s`);
        }
    });

    it('is always well under the once-a-minute wake-ups of intensive throttling', () => {
        for (let stale = MIN_STALE_SECONDS; stale <= MAX_STALE_SECONDS; stale += 1) {
            assert.ok(supervisionGapLimitMs(stale) * 10 <= 60000, `timeout ${stale} s`);
            assert.ok(supervisionGapLimitMs(stale) <= stale * 1000, `never past the timeout ${stale} s`);
        }
    });
});

describe('createSupervisionClock', () => {
    it('never trips on a steady one-second clock', () => {
        const verdicts = runTicks(createSupervisionClock(), { intervals: Array(120).fill(1000), limitMs: 3000 });
        assert.ok(verdicts.every((v) => !v.lost));
        assert.ok(verdicts.every((v) => v.gapMs === 1000));
    });

    it('never trips on the ticks of a hidden tab, 1-2 s apart', () => {
        // One-second aligned wake-ups: a tick due just after a wake-up waits
        // for the next one, so a gap can reach 2 s, never more.
        const intervals = [1000, 1999, 1, 1000, 2000, 1000, 1500, 500, 2000, 2000];
        for (const limitMs of [3000, 5000]) {
            const verdicts = runTicks(createSupervisionClock(), { intervals, limitMs, hidden: true });
            assert.ok(verdicts.every((v) => !v.lost), `limit ${limitMs}`);
        }
    });

    it('never trips on a tick one or two seconds late', () => {
        const clock = createSupervisionClock();
        clock.beat(10000);
        assert.equal(clock.check(12000, { limitMs: 3000 }).lost, false);
        assert.equal(clock.check(13000, { limitMs: 3000 }).lost, false);
    });

    it('trips once the gap is past the limit, and says how long it was', () => {
        const clock = createSupervisionClock();
        clock.beat(10000);
        assert.equal(clock.check(15000, { limitMs: 5000 }).lost, false);
        const v = clock.check(15001, { limitMs: 5000 });
        assert.equal(v.lost, true);
        assert.equal(v.gapMs, 5001);
        assert.equal(v.limitMs, 5000);
    });

    it('trips on the once-a-minute wake-ups of intensive throttling', () => {
        const verdicts = runTicks(createSupervisionClock(), { intervals: [1000, 1000, 60000, 60000], limitMs: 5000, hidden: true });
        assert.deepEqual(verdicts.map((v) => v.lost), [false, false, true, true]);
        assert.equal(verdicts[2].gapMs, 60000);
    });

    it('lets a packet ask between ticks without moving the measurement', () => {
        // The master clock is held back while heart-rate packets keep
        // arriving: each packet asks, and the gap keeps growing from the
        // last tick until one of them sees it past the limit.
        const clock = createSupervisionClock();
        clock.beat(0);
        const asked = [1000, 2000, 3000, 4000, 5000, 6000].map((now) => clock.check(now, { limitMs: 5000 }));
        assert.deepEqual(asked.map((v) => v.gapMs), [1000, 2000, 3000, 4000, 5000, 6000]);
        assert.deepEqual(asked.map((v) => v.lost), [false, false, false, false, false, true]);
        assert.equal(clock.lastBeatAt, 0);
    });

    it('counts a gap from the moment a session became live, not from a stale tick', () => {
        // The clock was held back while the session was paused; a resume
        // re-anchors it, so the first tick after it is not a false gap.
        const clock = createSupervisionClock();
        clock.beat(0);
        clock.beat(60000); // START / RESUME at 60 s, the clock not having ticked since 0
        assert.equal(clock.check(61000, { limitMs: 3000 }).lost, false);
    });

    it('reports no gap before the first beat, and none for a clock set backwards', () => {
        const clock = createSupervisionClock();
        const first = clock.check(5000, { limitMs: 3000 });
        assert.equal(first.lost, false);
        assert.equal(first.gapMs, 0);
        clock.beat(100000);
        const back = clock.check(40000, { limitMs: 3000 });
        assert.equal(back.lost, false);
        assert.equal(back.gapMs, 0);
        // The next beat takes the new time and measures from there.
        clock.beat(40000);
        assert.equal(clock.check(41000, { limitMs: 3000 }).lost, false);
        assert.equal(clock.check(47000, { limitMs: 3000 }).lost, true);
    });

    it('falls back to the factory limit when none is given', () => {
        const clock = createSupervisionClock();
        clock.beat(0);
        assert.equal(clock.check(5000).lost, false);
        assert.equal(clock.check(5001).lost, true);
        assert.equal(clock.check(5001, { limitMs: -1 }).limitMs, 5000);
    });

    it('tells a gap spent in the background from one on screen', () => {
        const clock = createSupervisionClock();
        clock.beat(0, { hidden: false });
        assert.equal(clock.check(9000, { limitMs: 5000, hidden: false }).background, false);
        // Hidden in between, visible again by the time anyone asks.
        clock.noteHidden();
        assert.equal(clock.check(9000, { limitMs: 5000, hidden: false }).background, true);
        // A beat on screen forgets it...
        clock.beat(9000, { hidden: false });
        assert.equal(clock.check(18000, { limitMs: 5000, hidden: false }).background, false);
        // ...a beat while hidden does not, and hidden right now always counts.
        clock.beat(18000, { hidden: true });
        assert.equal(clock.check(30000, { limitMs: 5000, hidden: false }).background, true);
        clock.beat(30000, { hidden: false });
        assert.equal(clock.check(40000, { limitMs: 5000, hidden: true }).background, true);
    });
});

describe('createPageAwayTracker', () => {
    it('hands back a departure once, with how long it lasted', () => {
        const away = createPageAwayTracker();
        assert.equal(away.back(1000), null);
        assert.equal(away.leave('freeze', 10000, { wasRunning: true }), true);
        assert.deepEqual(away.back(250000), { kind: 'freeze', at: 10000, wasRunning: true, awayMs: 240000 });
        assert.equal(away.back(260000), null);
        assert.equal(away.away, null);
    });

    it('keeps the first event of one departure (pagehide, then freeze)', () => {
        // Chrome puts a page into the back/forward cache with pagehide and
        // then freeze, and brings it back with resume and then pageshow.
        const away = createPageAwayTracker();
        assert.equal(away.leave('bfcache', 5000, { wasRunning: true }), true);
        assert.equal(away.leave('freeze', 5001, { wasRunning: false }), false);
        const trip = away.back(9000);
        assert.equal(trip.kind, 'bfcache');
        assert.equal(trip.wasRunning, true);
        assert.equal(trip.awayMs, 4000);
        assert.equal(away.back(9001), null, 'pageshow after resume reports nothing twice');
    });

    it('starts a new departure once the last one has been reported', () => {
        const away = createPageAwayTracker();
        away.leave('freeze', 0, { wasRunning: true });
        away.back(1000);
        assert.equal(away.leave('freeze', 2000, { wasRunning: false }), true);
        assert.equal(away.back(3000).wasRunning, false);
    });

    it('survives a departure with no usable time', () => {
        const away = createPageAwayTracker();
        away.leave('freeze', NaN);
        assert.equal(away.back(5000).awayMs, null);
    });
});

describe('formatGap', () => {
    it('reads as seconds, minutes and hours', () => {
        assert.equal(formatGap(0), '0 s');
        assert.equal(formatGap(5400), '5 s');
        assert.equal(formatGap(59400), '59 s');
        assert.equal(formatGap(60000), '1 min');
        assert.equal(formatGap(63000), '1 min 3 s');
        assert.equal(formatGap(252000), '4 min 12 s');
        assert.equal(formatGap(3600000), '1 h');
        assert.equal(formatGap(7500000), '2 h 5 min');
        assert.equal(formatGap(-5), '0 s');
        assert.equal(formatGap(undefined), '0 s');
    });
});

describe('the banners', () => {
    it('name the gap, say every toy stopped and how to go on', () => {
        const hidden = describeSupervisionGap({ gapMs: 62000, background: true });
        assert.match(hidden, /in the background/);
        assert.match(hidden, /1 min 2 s/);
        assert.match(hidden, /could not supervise the toys/);
        assert.match(hidden, /Every toy was stopped and the session paused/);
        assert.match(hidden, /press RESUME when you are ready/);
        assert.match(hidden, /keep EdgeLoop in view/);
        const onScreen = describeSupervisionGap({ gapMs: 12000, background: false });
        assert.doesNotMatch(onScreen, /background/, 'a page on screen was not in the background');
        assert.doesNotMatch(onScreen, /keep EdgeLoop in view/, 'it was in view');
        assert.match(onScreen, /12 s/);
        assert.match(onScreen, /dialog/);
        assert.match(onScreen, /Every toy was stopped and the session paused/);
        assert.match(onScreen, /press RESUME when you are ready\.$/);
    });

    it('say why a session is paused after the page was frozen or left', () => {
        const frozen = describePageAway({ kind: 'freeze', awayMs: 252000, wasRunning: true });
        assert.match(frozen, /froze this page in the background for 4 min 12 s/);
        assert.match(frozen, /Every toy was stopped and the session paused/);
        assert.match(frozen, /press RESUME when you are ready, and keep EdgeLoop in view/);
        // A freeze too short to measure does not quote "0 s".
        assert.doesNotMatch(describePageAway({ kind: 'freeze', awayMs: 300 }), /for 0 s/);
        assert.doesNotMatch(describePageAway({ kind: 'freeze', awayMs: null }), / for /);
        const left = describePageAway({ kind: 'bfcache', awayMs: 30000, wasRunning: true });
        assert.match(left, /You left this page/);
        assert.match(left, /Every toy was stopped and the session paused/);
        assert.doesNotMatch(left, /keep EdgeLoop in view/, 'leaving the page was the wearer\'s own doing');
        assert.match(left, /press RESUME when you are ready\.$/);
    });

    it('say a watchdog pause will not resume by itself any more', () => {
        const text = describePageAway({ kind: 'freeze', awayMs: 90000, wasRunning: false });
        assert.match(text, /will not resume by itself/);
        assert.doesNotMatch(text, /Every toy was stopped/);
        assert.match(text, /RESUME/);
    });
});
