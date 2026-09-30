import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    RR_MIN_MS,
    RR_MAX_MS,
    MEDIAN_ORDER,
    DEVIATION_FRACTION,
    GAP_MIN_MS,
    GAP_TOLERANCE_MS,
    RMSSD_WINDOW_MS,
    MIN_PAIRS,
    MAX_REJECTED_PERCENT,
    LOCK_MIN_BEATS,
    LOCK_REJECTED_PERCENT,
    FRESH_BREAK_MS,
    WARMUP_MS,
    NO_RR_AFTER_MS,
    SYNTH_TOLERANCE_MS,
    SYNTH_RATIO,
    SYNTH_MIN_BEATS,
    SYNTH_MAX_BPM,
    FLAT_RMSSD_MS,
    FLAT_MIN_DISTINCT,
    FLAT_WINDOW_BEATS,
    MAX_BEATS,
    createHrvTracker
} from './hrv.js';

const STATUSES = ['synthetic', 'noRr', 'waiting', 'warming', 'artefacts', 'gap', 'flat', 'ok'];

// One packet per second carrying one interval each, the way a chest strap
// reports a heart near 60 BPM. `null` stands for a packet without RR.
// Returns the arrival time of the last packet.
function feed(tracker, values, { bpm = 70, start = 0, period = 1000, contact = true } = {}) {
    let now = start;
    for (const value of values) {
        tracker.push({ now, bpm, rr: value === null ? [] : [value], contact });
        now += period;
    }
    return now - period;
}

// base .. base+190 and back in 10 ms steps. Every successive difference is
// exactly +-10, so the RMSSD is 10 whatever pairs a window takes, and the 20
// distinct values keep the flat guard quiet. `step` scales the pattern.
function triangle(count, base = 900, step = 10) {
    const cycle = [];
    for (let v = 0; v < 20; v++) cycle.push(base + v * step);
    for (let v = 18; v > 0; v--) cycle.push(base + v * step);
    return Array.from({ length: count }, (_, i) => cycle[i % cycle.length]);
}

// A steady rhythm around 1000 ms: 955 .. 1045 and back in 5 ms steps, so
// every successive difference is 5 and the true RMSSD is 5 ms.
function steady(count, from = 0) {
    const cycle = [];
    for (let v = 0; v <= 18; v++) cycle.push(955 + v * 5);
    for (let v = 17; v > 0; v--) cycle.push(955 + v * 5);
    return Array.from({ length: count }, (_, i) => cycle[(from + i) % cycle.length]);
}

// Like feed, but reads right after every packet, the way the modal repaints
// once a second, and returns each reading with its time.
function feedAndRead(tracker, values, options = {}) {
    const { start = 0, period = 1000 } = options;
    return values.map((value, i) => {
        const now = start + i * period;
        feed(tracker, [value], { ...options, start: now });
        return { now, ...tracker.read(now) };
    });
}

// Packets off the skin: 0 BPM, contact bit clear, no interval. Returns the
// time of the first packet after them.
function offSkin(tracker, seconds, start) {
    for (let i = 0; i < seconds; i++) tracker.push({ now: start + i * 1000, bpm: 0, rr: [], contact: false });
    return start + seconds * 1000;
}

// What a strap reports of a heart whose real intervals are `heart`, from
// index `k` on, for at least `ms` of real time: every beat ('each'), every
// other R wave missed ('missed', so each interval it reports is two real
// ones), or the T wave taken for a beat too ('split', so each interval
// arrives cut in two at `at`). Returns the intervals and the next index.
function report(heart, k, ms, how = 'each', at = 0.46) {
    const values = [];
    let t = 0;
    while (t < ms) {
        if (how === 'missed') {
            values.push(heart[k] + heart[k + 1]);
            t += heart[k] + heart[k + 1];
            k += 2;
        } else if (how === 'split') {
            values.push(heart[k] * at, heart[k] * (1 - at));
            t += heart[k];
            k += 1;
        } else {
            values.push(heart[k]);
            t += heart[k];
            k += 1;
        }
    }
    return { values, k };
}

// Lays intervals out in real time, the way a strap sends them: each ends one
// interval after the previous one, and a packet every second carries those
// that ended since the last. Reads after every packet, as the modal repaints,
// and returns each reading with its time.
function strap(tracker, values, { start = 0, bpm = 70 } = {}) {
    const rows = [];
    let end = start;
    let next = 0;
    for (let now = start + 1000; next < values.length; now += 1000) {
        const rr = [];
        while (next < values.length && end + values[next] <= now) {
            end += values[next];
            rr.push(values[next]);
            next += 1;
        }
        tracker.push({ now, bpm, rr, contact: true });
        rows.push({ now, ...tracker.read(now) });
    }
    return rows;
}

function sum(values) {
    return values.reduce((total, v) => total + v, 0);
}

function mean(values) {
    return sum(values) / values.length;
}

// The textbook RMSSD of a list of successive intervals.
function rmssdOf(values) {
    let sum = 0;
    for (let i = 1; i < values.length; i++) sum += (values[i] - values[i - 1]) ** 2;
    return Math.sqrt(sum / (values.length - 1));
}

function assertSane(reading) {
    assert.ok(Object.isFrozen(reading));
    assert.deepEqual(Object.keys(reading).sort(), ['beats', 'rejectedPercent', 'rmssd', 'rrHr', 'rrSeen', 'status']);
    assert.ok(STATUSES.includes(reading.status), `unknown status ${reading.status}`);
    assert.ok(reading.rmssd === null || (Number.isFinite(reading.rmssd) && reading.rmssd >= 0));
    assert.ok(Number.isInteger(reading.beats) && reading.beats >= 0);
    assert.ok(Number.isInteger(reading.rejectedPercent) && reading.rejectedPercent >= 0 && reading.rejectedPercent <= 100);
    assert.ok(reading.rrHr === null || (Number.isFinite(reading.rrHr) && reading.rrHr > 0));
    assert.equal(typeof reading.rrSeen, 'boolean');
    if (reading.status !== 'ok') {
        assert.equal(reading.rmssd, null);
        assert.equal(reading.rrHr, null);
    } else {
        assert.ok(Number.isFinite(reading.rmssd));
        assert.ok(Number.isFinite(reading.rrHr));
    }
}

describe('hrv constants', () => {
    it('are the numbers of the specification', () => {
        assert.equal(RR_MIN_MS, 240);
        assert.equal(RR_MAX_MS, 2000);
        assert.equal(MEDIAN_ORDER, 11);
        assert.equal(DEVIATION_FRACTION, 0.30);
        assert.equal(GAP_MIN_MS, 1500);
        assert.equal(GAP_TOLERANCE_MS, 300);
        assert.equal(RMSSD_WINDOW_MS, 30000);
        assert.equal(MIN_PAIRS, 20);
        assert.equal(MAX_REJECTED_PERCENT, 5);
        assert.equal(LOCK_MIN_BEATS, 20);
        assert.equal(LOCK_REJECTED_PERCENT, 50);
        assert.equal(FRESH_BREAK_MS, 10000);
        assert.equal(WARMUP_MS, 30000);
        assert.equal(NO_RR_AFTER_MS, 10000);
        assert.equal(SYNTH_TOLERANCE_MS, 1.5);
        assert.equal(SYNTH_RATIO, 0.8);
        assert.equal(SYNTH_MIN_BEATS, 20);
        assert.equal(SYNTH_MAX_BPM, 110);
        assert.equal(FLAT_RMSSD_MS, 2);
        assert.equal(FLAT_MIN_DISTINCT, 10);
        assert.equal(FLAT_WINDOW_BEATS, 60);
        assert.equal(MAX_BEATS, 600);
    });
});

describe('createHrvTracker before any packet', () => {
    it('is waiting, with nothing to show and a frozen result', () => {
        const tracker = createHrvTracker();
        const reading = tracker.read(0);
        assert.deepEqual(reading, { status: 'waiting', rmssd: null, beats: 0, rejectedPercent: 0, rrHr: null, rrSeen: false });
        assertSane(reading);
        assertSane(tracker.read(undefined));
        assertSane(tracker.read(NaN));
    });
});

describe('RMSSD', () => {
    it('measures a triangle tachogram exactly', () => {
        const tracker = createHrvTracker();
        const values = triangle(45);
        const last = feed(tracker, values);
        const reading = tracker.read(last);
        assert.equal(reading.status, 'ok');
        assert.equal(reading.rmssd, 10);
        // The window holds the 31 beats of the last 30 s and nothing was rejected.
        assert.equal(reading.beats, 31);
        assert.equal(reading.rejectedPercent, 0);
        assert.equal(reading.rrSeen, true);
        // RR-derived heart rate: 60000 over the mean of the last ten accepted beats.
        assert.equal(reading.rrHr, Math.round(60000 / mean(values.slice(-10))));
        assertSane(reading);
    });

    it('matches the textbook formula on a pseudo-random tachogram', () => {
        // A fixed linear congruential sequence, so the run is repeatable and
        // the intervals carry fractions of a millisecond like a real strap.
        let seed = 12345;
        const values = [];
        for (let i = 0; i < 45; i++) {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            values.push(900 + (seed % 20000) / 100);
        }
        const tracker = createHrvTracker();
        const last = feed(tracker, values);
        // Read at 44 s: the window holds the beats of the last 30 s, and the
        // pairs are every successive pair whose later beat lies inside it,
        // from (13 s, 14 s) on, all long after the first eleven beats
        // established the rhythm.
        const reading = tracker.read(last);
        assert.equal(reading.status, 'ok');
        const expected = rmssdOf(values.slice(13));
        assert.ok(Math.abs(reading.rmssd - expected) <= 0.5, `${reading.rmssd} vs ${expected}`);
        assert.equal(reading.rmssd, Math.round(expected * 10) / 10);
    });

    it('uses the intervals as given, to the fraction of a millisecond', () => {
        const tracker = createHrvTracker();
        const last = feed(tracker, triangle(45, 900, 10.5));
        assert.equal(tracker.read(last).rmssd, 10.5);
    });

    it('shows no number for the first 30 s after RR appears', () => {
        // Two beats of ~500 ms in every packet, so twenty pairs are there
        // long before 30 s: the warm-up alone is what hides the number.
        const tracker = createHrvTracker();
        const values = triangle(62, 450, 5);
        const packet = (p) => tracker.push({ now: p * 1000, bpm: 120, rr: values.slice(2 * p, 2 * p + 2), contact: true });
        for (let p = 0; p <= 24; p++) packet(p);
        const early = tracker.read(24000);
        assert.equal(early.status, 'warming');
        assert.equal(early.rmssd, null);
        assert.equal(early.rrHr, null);
        assert.equal(early.rrSeen, true);
        for (let p = 25; p <= 29; p++) packet(p);
        assert.equal(tracker.read(WARMUP_MS - 1).status, 'warming');
        packet(30);
        const ready = tracker.read(WARMUP_MS);
        assert.equal(ready.status, 'ok');
        assert.equal(ready.rmssd, 5);
    });

    it('needs 20 contiguous pairs in the window, however long the stream', () => {
        // Every third packet reports no skin contact, so the accepted beats
        // come in runs of two and the window never holds 20 usable pairs.
        const tracker = createHrvTracker();
        const values = triangle(60);
        values.forEach((value, i) => {
            tracker.push({ now: i * 1000, bpm: 70, rr: [value], contact: i % 3 !== 2 });
        });
        const reading = tracker.read(59000);
        assert.equal(reading.status, 'warming');
        assert.equal(reading.rmssd, null);
        // Dropped intervals are not beats: neither counted nor rejected. The
        // window spans 31 packets, 11 of them without contact.
        assert.equal(reading.beats, 20);
        assert.equal(reading.rejectedPercent, 0);
    });
});

describe('contiguity', () => {
    it('a lost notification breaks the run, and the pair across it is never used', () => {
        const tracker = createHrvTracker();
        const before = triangle(41);
        feed(tracker, before);                                  // packets at 0 .. 40000
        // The 41 s packet never arrives. The next one comes 2 s after the
        // previous, more than max(1500, 750 + 300), and the pulse has moved
        // to a lower level meanwhile: had the pair across the hole counted,
        // its difference of 170 ms would swamp the 10 ms pattern.
        const after = triangle(30, 750);
        feed(tracker, after.slice(0, 1), { start: 42000 });
        const atBreak = tracker.read(42000);
        assert.equal(atBreak.status, 'gap');
        assert.equal(atBreak.rmssd, null);
        feed(tracker, after.slice(1, 10), { start: 43000 });    // .. 51000
        assert.equal(tracker.read(42000 + FRESH_BREAK_MS - 1).status, 'gap');
        feed(tracker, after.slice(10, 11), { start: 52000 });
        const rebuilt = tracker.read(42000 + FRESH_BREAK_MS);
        assert.equal(rebuilt.status, 'ok');
        assert.equal(rebuilt.rmssd, 10);
        assert.equal(rebuilt.rejectedPercent, 0);
    });

    it('a rejected beat breaks the run: the beats around it never pair, and the window rebuilds', () => {
        const tracker = createHrvTracker();
        feed(tracker, triangle(41));                                    // 0 .. 40000, last value 920
        tracker.push({ now: 41000, bpm: 70, rr: [3000], contact: true });
        // One rejection in 31 beats is 3%, under the artefact line, so it is
        // the break itself that hides the number.
        const fresh = tracker.read(41000);
        assert.equal(fresh.status, 'gap');
        assert.equal(fresh.rejectedPercent, 3);
        // The pulse goes on 170 ms lower. Had the beats on either side of the
        // rejection been paired, that step would show in the RMSSD.
        const lower = triangle(30, 750);
        feed(tracker, lower.slice(0, 10), { start: 42000 });             // .. 51000
        assert.equal(tracker.read(50999).status, 'gap');
        feed(tracker, lower.slice(10, 11), { start: 52000 });
        const rebuilt = tracker.read(52000);
        assert.equal(rebuilt.status, 'ok');
        assert.equal(rebuilt.rmssd, 10);
    });

    it('breaks the run when a silence ends with a packet that carries no interval', () => {
        // Two notifications lost, then a packet with nothing in it: the beat
        // that follows is not the successor of the last one heard, whether
        // or not the packet that ended the silence carried it.
        const tracker = createHrvTracker();
        feed(tracker, triangle(41));                                    // 0 .. 40000
        tracker.push({ now: 43000, bpm: 70, rr: [], contact: true });
        const lower = triangle(30, 750);
        feed(tracker, lower.slice(0, 1), { start: 44000 });
        const fresh = tracker.read(44000);
        assert.equal(fresh.status, 'gap');
        assert.equal(fresh.rejectedPercent, 0);
        feed(tracker, lower.slice(1, 10), { start: 45000 });             // .. 53000
        const rebuilt = tracker.read(53000);
        assert.equal(rebuilt.status, 'ok');
        assert.equal(rebuilt.rmssd, 10);
    });

    it('breaks the run on an entry that is not a number', () => {
        // Nothing the parser produces gets here; a caller bug does. A beat we
        // cannot use hides the number rather than being skipped over.
        const tracker = createHrvTracker();
        const last = feed(tracker, triangle(45));
        assert.equal(tracker.read(last).status, 'ok');
        tracker.push({ now: last + 1000, bpm: 70, rr: [NaN, 970], contact: true });
        const reading = tracker.read(last + 1000);
        assert.equal(reading.status, 'gap');
        assert.equal(reading.rejectedPercent, 0);
        assert.equal(reading.beats, 31);
    });

    it('does not see a break when a 50 BPM strap sends a packet with no interval', () => {
        // Beats every ~1200 ms, reported once a second: every sixth packet
        // has no beat to carry. The arrival gap is still 1 s, so the run is
        // unbroken and the number stays on screen.
        const tracker = createHrvTracker();
        const packets = new Map();
        let end = 0;
        for (let k = 0; end < 70000; k++) {
            const rr = 1200 + ((k * 7) % 23) - 11;
            end += rr;
            const p = Math.ceil(end / 1000);
            if (!packets.has(p)) packets.set(p, []);
            packets.get(p).push(rr);
        }
        const withoutRr = [];
        for (let p = 2; p <= 70; p++) if (!packets.has(p)) withoutRr.push(p);
        assert.ok(withoutRr.length >= 10, `the stream must contain packets without RR, got ${withoutRr.length}`);
        // Read once per second, right after each packet, as the modal does.
        // The first pair opens at the eleventh beat, the one that establishes
        // the rhythm, so the twentieth pair closes with the beat that ends
        // near 37.2 s and arrives in the 38 s packet.
        for (let p = 0; p <= 70; p++) {
            tracker.push({ now: p * 1000, bpm: 50, rr: packets.get(p) || [], contact: true });
            const status = tracker.read(p * 1000).status;
            assert.notEqual(status, 'gap', `gap reported at ${p} s`);
            if (p >= 38) assert.equal(status, 'ok', `not ok at ${p} s`);
        }
    });

    it('judges a batching relay by the RR it carries, not by a fixed gap', () => {
        // Four beats per 4 s packet: the gap equals the RR sum, within the
        // 300 ms tolerance. A packet that carries only three of them means a
        // beat went missing.
        const tracker = createHrvTracker();
        const values = triangle(48, 1000);
        for (let p = 0; p < 12; p++) tracker.push({ now: p * 4000, bpm: 70, rr: values.slice(p * 4, p * 4 + 4), contact: true });
        const steady = tracker.read(44000);
        assert.equal(steady.status, 'ok');
        assert.equal(steady.rmssd, 10);
        tracker.push({ now: 48000, bpm: 70, rr: values.slice(0, 3), contact: true });
        assert.equal(tracker.read(48000).status, 'gap');
    });

    it('assigns beat times backwards from the arrival, without interpolating', () => {
        const tracker = createHrvTracker();
        tracker.push({ now: 100000, bpm: 70, rr: [1000, 1000, 1000, 1000, 1000], contact: true });
        // Beats ended at 96000 .. 100000: all five are inside a window that
        // starts at 96000, four inside one that starts a millisecond later.
        assert.equal(tracker.read(126000).beats, 5);
        assert.equal(tracker.read(126001).beats, 4);
        assert.equal(tracker.read(130000).beats, 1);
    });

    it('drops the intervals of a packet without skin contact or without a usable pulse, and breaks the run', () => {
        for (const packet of [{ bpm: 70, contact: false }, { bpm: 0, contact: true }, { bpm: NaN, contact: null }]) {
            const tracker = createHrvTracker();
            const last = feed(tracker, triangle(45));
            assert.equal(tracker.read(last).status, 'ok');
            tracker.push({ now: last + 1000, rr: [1000], ...packet });
            const reading = tracker.read(last + 1000);
            assert.equal(reading.status, 'gap', JSON.stringify(packet));
            // 30 beats of the window remain; the dropped one is not among them
            // and is not a rejection either.
            assert.equal(reading.beats, 30);
            assert.equal(reading.rejectedPercent, 0);
        }
    });

    it('counts RR as seen even when the packet that carried it was dropped', () => {
        // Otherwise a strap that reports no contact for its first seconds
        // would be called a heart-rate-only sensor.
        const tracker = createHrvTracker();
        tracker.push({ now: 0, bpm: 0, rr: [1000], contact: false });
        const reading = tracker.read(0);
        assert.equal(reading.rrSeen, true);
        assert.equal(reading.status, 'warming');
        assert.equal(tracker.read(NO_RR_AFTER_MS).status, 'warming');
    });

    it('breaks the run where an entry that is not a number sits, not before the packet', () => {
        // 970 follows the 960 of the previous packet; the unusable entry lies
        // between 970 and 1170, and the beats after 1170 continue from it.
        // Had the break been placed before the packet, the 200 ms step from
        // 970 to 1170 would be paired and the real pair 960-970 lost.
        const tracker = createHrvTracker();
        feed(tracker, triangle(45));                                    // 0 .. 44000, last 960
        tracker.push({ now: 45000, bpm: 70, rr: [970, NaN, 1170], contact: true });
        assert.equal(tracker.read(45000).status, 'gap');
        const after = Array.from({ length: 20 }, (_, i) => 1160 - 10 * i);
        feed(tracker, after.slice(0, 11), { start: 46000 });            // .. 56000
        const reading = tracker.read(56000);
        assert.equal(reading.status, 'ok');
        assert.equal(reading.rmssd, 10);
    });
});

describe('rhythm reference', () => {
    it('judges the first interval after a long loss of contact against the rhythm from before it', () => {
        // The pulse did not move while the strap was off; the first interval
        // back is a half beat. The reference from before the loss rejects
        // it, and the number returns with the true value as soon as twenty
        // pairs are back: 21 s after the strap is. Had the reference
        // forgotten everything older than 30 s, the 480 would have been
        // accepted blind and every real beat after it rejected for a minute.
        for (const lossSeconds of [31, 40, 120]) {
            const tracker = createHrvTracker();
            feed(tracker, steady(61));                                  // 0 .. 60000
            const back = offSkin(tracker, lossSeconds, 61000);
            tracker.push({ now: back, bpm: 60, rr: [480], contact: true });
            const first = tracker.read(back);
            assert.equal(first.rejectedPercent, 100, `${lossSeconds} s: the 480 was not rejected`);
            const rows = feedAndRead(tracker, steady(40, 61), { bpm: 60, start: back + 1000 });
            const firstOk = rows.find((r) => r.status === 'ok');
            assert.ok(firstOk, `${lossSeconds} s: never ok`);
            assert.equal(firstOk.now - back, 21000, `${lossSeconds} s loss`);
            for (const r of rows) if (r.status === 'ok') assert.equal(r.rmssd, 5, `${lossSeconds} s loss, ${r.now}`);
        }
    });

    it('never shows an artefact that ends a long loss of contact as part of the number', () => {
        // 1350 is 35% away from the rhythm and inside 240-2000. Accepted
        // blind and paired with the next real beat, it read as an RMSSD of
        // 75 ms, shown as 'ok', for twelve seconds.
        for (const [lossSeconds, artefact] of [[35, 1350], [60, 1350], [35, 680], [35, 2000]]) {
            const tracker = createHrvTracker();
            feed(tracker, steady(61));
            const back = offSkin(tracker, lossSeconds, 61000);
            tracker.push({ now: back, bpm: 60, rr: [artefact], contact: true });
            const rows = feedAndRead(tracker, steady(60, 61), { bpm: 60, start: back + 1000 });
            const shown = rows.filter((r) => r.status === 'ok').map((r) => r.rmssd);
            assert.ok(shown.length > 30, `${artefact} after ${lossSeconds} s: the number did not return`);
            assert.deepEqual([...new Set(shown)], [5], `${artefact} after ${lossSeconds} s`);
        }
    });

    it('never takes a strap that misses every other beat for the heart, however long it lasts', () => {
        // A heart near 92 BPM whose every step is 10 ms (true RMSSD 10). For
        // two minutes the strap misses every other R wave: each interval it
        // reports is two of the heart's, 1130-1490 ms, inside 240-2000 and in
        // agreement with one another. Adopted as the rhythm after eleven of
        // them, they showed 38 ms as 'ok' 45 s into the fault, next to a
        // heart rate of about 45. Rejected, they hide the number until they
        // have left the window, and every number shown is the heart's.
        const heart = triangle(1000, 560);
        const before = report(heart, 0, 60000);
        const fault = report(heart, before.k, 120000, 'missed');
        const after = report(heart, fault.k, 60000);
        const faultFrom = sum(before.values);
        const faultTo = faultFrom + sum(fault.values);
        const rows = strap(createHrvTracker(), [...before.values, ...fault.values, ...after.values], { bpm: 92 });
        assert.ok(rows.some((r) => r.now < faultFrom && r.status === 'ok'), 'no number before the fault');
        for (const r of rows) {
            // From the packet that carries the first doubled interval on.
            const during = r.now >= faultFrom + fault.values[0] && r.now <= faultTo;
            if (during) assert.notEqual(r.status, 'ok', `${r.now}: shown during the fault`);
            if (r.status === 'ok') assert.equal(r.rmssd, 10, String(r.now));
        }
        const back = rows.find((r) => r.now > faultTo && r.status === 'ok');
        assert.ok(back, 'the number did not return');
        assert.ok(back.now - faultTo <= 31000, `back only ${(back.now - faultTo) / 1000} s after the fault`);
    });

    it('never takes a strap that counts the T wave as a beat for the heart', () => {
        // The same heart, and for two minutes the strap also triggers on the
        // T wave, so every interval arrives cut in two at 46%. The halves
        // agree with one another, and adopted as the rhythm they showed 52 ms
        // as 'ok' 33 s into the fault.
        for (const at of [0.44, 0.46, 0.5]) {
            const heart = triangle(1000, 560);
            const before = report(heart, 0, 60000);
            const fault = report(heart, before.k, 120000, 'split', at);
            const after = report(heart, fault.k, 60000);
            const faultFrom = sum(before.values);
            const faultTo = faultFrom + sum(fault.values);
            const rows = strap(createHrvTracker(), [...before.values, ...fault.values, ...after.values], { bpm: 92 });
            for (const r of rows) {
                const during = r.now >= faultFrom + fault.values[0] && r.now <= faultTo;
                if (during) assert.notEqual(r.status, 'ok', `T at ${at}, ${r.now}`);
                if (r.status === 'ok') assert.equal(r.rmssd, 10, `T at ${at}, ${r.now}`);
            }
            assert.ok(rows.some((r) => r.now > faultTo && r.status === 'ok'), `T at ${at}: the number did not return`);
        }
    });

    it('judges a strap that comes back from a loss of contact missing every other beat against the heart from before it', () => {
        // 40 s off the skin, and when the strap is back it misses every other
        // R wave for a minute and a half. The heart has not changed pace, and
        // the reference from before the loss rejects the doubled intervals
        // for as long as they come.
        const heart = triangle(1000, 560);
        const tracker = createHrvTracker();
        const before = report(heart, 0, 60000);
        const rowsBefore = strap(tracker, before.values, { bpm: 92 });
        const lost = rowsBefore[rowsBefore.length - 1].now + 1000;
        const back = offSkin(tracker, 40, lost);
        // The heart kept beating while the strap was off.
        const unseen = report(heart, before.k, 40000);
        const fault = report(heart, unseen.k, 90000, 'missed');
        const after = report(heart, fault.k, 60000);
        const rows = strap(tracker, [...fault.values, ...after.values], { start: back - 1000, bpm: 92 });
        const faultTo = back - 1000 + sum(fault.values);
        for (const r of rows) {
            if (r.now <= faultTo) assert.notEqual(r.status, 'ok', `${r.now}: shown during the fault`);
            if (r.status === 'ok') assert.equal(r.rmssd, 10, String(r.now));
        }
        assert.ok(rows.some((r) => r.now > faultTo && r.status === 'ok'), 'the number did not return');
    });

    it('never pairs a run that agrees with itself with the heart that follows it', () => {
        // A heart near 82 BPM whose every step is 3 ms (true RMSSD 3), then a
        // dozen intervals a third longer that agree with one another, then
        // the heart again. The run starts where the heart is at its fastest,
        // so all of it is more than 30% away. Adopted as the rhythm, it let
        // its last interval be paired with the heart's first, and 38-40 ms
        // showed as 'ok' half a minute later.
        for (const [count, ratio] of [[12, 1.32], [15, 1.34], [25, 1.36]]) {
            const heart = triangle(200, 700, 3);
            const run = Array.from({ length: count }, (_, i) => Math.round(728.5 * ratio) + ((i * 7) % 11) - 5);
            const rows = strap(createHrvTracker(), [...heart.slice(0, 80), ...run, ...heart.slice(80)], { bpm: 82 });
            const shown = rows.filter((r) => r.status === 'ok');
            assert.ok(shown.length > 60, `${count} x ${ratio}: the number did not come`);
            for (const r of shown) assert.equal(r.rmssd, 3, `${count} x ${ratio}, ${r.now}`);
        }
    });

    it('keeps the rhythm from before a loss of contact or of the notifications when the pulse moved by more than 30% meanwhile', () => {
        // ~1000 ms before the strap slipped, or before its notifications
        // stopped arriving, and ~640 ms when it came back 40 s later. Every
        // beat is more than 30% away from the rhythm (median 1060 ms, so
        // nothing under 742 is kept) and is rejected, and nothing is shown:
        // from the intervals alone, a heart that changed pace while it was
        // not seen cannot be told from a strap that came back counting wrong.
        // The strap's pulse (92 BPM) does not seed the reference again; the
        // stream says it is not being read, as 'artefacts', from the moment
        // 20 beats are in the window. Once the pulse is back within reach its
        // beats are accepted, and the number returns, true, as the rejected
        // ones leave the window.
        for (const loss of ['contact', 'notifications']) {
            const tracker = createHrvTracker();
            feed(tracker, triangle(60), { bpm: 62 });                   // 0 .. 59000
            // 40 s of packets off the skin, or 40 s without a single packet.
            const back = loss === 'contact' ? offSkin(tracker, 40, 60000) : 100000;
            const faster = feedAndRead(tracker, triangle(90, 540), { bpm: 92, start: back });
            faster.forEach((r, i) => {
                assert.equal(r.status, i + 1 < LOCK_MIN_BEATS ? 'warming' : 'artefacts', `${loss}, ${r.now}`);
                assert.equal(r.rmssd, null);
                assert.equal(r.rrHr, null);
            });
            assert.equal(faster[faster.length - 1].rejectedPercent, 100, loss);
            const calmer = feedAndRead(tracker, triangle(60, 800), { bpm: 68, start: back + 90000 });
            assert.equal(calmer[0].rejectedPercent, 97, `${loss}: the first beat within reach was not accepted`);
            // 'artefacts' while the rejected beats are more than half the
            // window (15 of 31 accepted is not enough, 16 is), then the
            // warm-up.
            assert.equal(calmer[14].status, 'artefacts', loss);
            assert.equal(calmer[15].status, 'warming', loss);
            const firstOk = calmer.find((r) => r.status === 'ok');
            assert.ok(firstOk, `${loss}: the number did not return`);
            // One rejected beat of 31 is left in the window then (3%).
            assert.equal(firstOk.now - (back + 90000), 29000, loss);
            for (const r of calmer) if (r.status === 'ok') assert.equal(r.rmssd, 10, `${loss}, ${r.now}`);
        }
    });

    it('seeds the reference on the first interval near the pulse the strap reports, so a stray first interval is rejected', () => {
        // A heart near 860 ms, reported at 70 BPM (60000 / 70 = 857). The
        // stream opens with stray intervals. Judged against nothing, a 339
        // would become the whole reference, and every real beat after it,
        // more than 30% away, would be rejected for as long as the stream
        // lasted. Against the strap's pulse the strays are rejected, the
        // heart's first beat seeds the reference, and every beat of the heart
        // is accepted after it.
        const heart = triangle(80, 770);                                // 770 .. 960
        for (const stray of [[339], [1250], [339, 330], [339, 2500, 1250]]) {
            const tracker = createHrvTracker();
            tracker.push({ now: 0, bpm: 70, rr: stray, contact: true });
            const opened = tracker.read(0);
            assert.equal(opened.beats, stray.length, String(stray));
            assert.equal(opened.rejectedPercent, 100, String(stray));
            const rows = feedAndRead(tracker, heart, { bpm: 70, start: 1000 });
            // The stray intervals are the only rejections the stream ever has.
            assert.equal(rows[0].beats, stray.length + 1, String(stray));
            assert.equal(rows[0].rejectedPercent, Math.round(stray.length * 100 / (stray.length + 1)), String(stray));
            assert.equal(rows[rows.length - 1].rejectedPercent, 0, String(stray));
            const shown = rows.filter((r) => r.status === 'ok');
            assert.ok(shown.length > 40, `${stray}: the number did not come`);
            // heart[i] arrives at (i + 1) s: the ten latest beats at t s are
            // heart[t - 10 .. t - 1].
            for (const r of shown) {
                assert.equal(r.rmssd, 10, `${stray}, ${r.now}`);
                assert.equal(r.rrHr, Math.round(60000 / mean(heart.slice(r.now / 1000 - 10, r.now / 1000))), `${stray}, ${r.now}`);
            }
        }
    });

    it('seeds on an interval up to 30% from the pulse, and on nothing further', () => {
        // 60 BPM stands for 1000 ms: 700 and 1300 seed the reference; 650,
        // 699.9, 1300.1 and 1350 are rejected.
        for (const [value, seeds] of [[700, true], [1300, true], [699.9, false], [1300.1, false], [650, false], [1350, false]]) {
            const tracker = createHrvTracker();
            tracker.push({ now: 0, bpm: 60, rr: [value], contact: true });
            const reading = tracker.read(0);
            assert.equal(reading.beats, 1, String(value));
            assert.equal(reading.rejectedPercent, seeds ? 0 : 100, String(value));
        }
    });

    it('judges each interval before the seed against the pulse of its own packet', () => {
        // A strap whose first packet reports a pulse that has not settled:
        // 120 BPM (500 ms) with a 1000 ms beat, then 60 BPM with the next
        // one. The first is rejected against its own packet's 500 ms, and
        // the second seeds against its own packet's 1000 ms.
        const tracker = createHrvTracker();
        tracker.push({ now: 0, bpm: 120, rr: [1000], contact: true });
        tracker.push({ now: 1000, bpm: 60, rr: [1000], contact: true });
        const reading = tracker.read(1000);
        assert.equal(reading.beats, 2);
        assert.equal(reading.rejectedPercent, 50);
        // Several intervals in one packet are each judged against its pulse
        // until one seeds, and the rest against the rhythm.
        const batched = createHrvTracker();
        batched.push({ now: 4000, bpm: 60, rr: [480, 1000, 990, 1010], contact: true });
        assert.equal(batched.read(4000).beats, 4);
        assert.equal(batched.read(4000).rejectedPercent, 25);
    });

    it('breaks the run on an interval rejected before the seed, like on any other rejection', () => {
        // Nothing before the seed can pair, so the break shows only as 'gap'
        // for the 10 s after it, and only where the number could come sooner:
        // near 220 BPM, whose eleven beats that establish the rhythm and
        // twenty pairs after them fit into those 10 s. The strap is off the
        // skin for its first 20 s, and the first interval it sends on the
        // skin is an artefact.
        const tracker = createHrvTracker();
        for (let t = 0; t <= 20000; t += 1000) tracker.push({ now: t, bpm: 220, rr: [270], contact: false });
        const rows = strap(tracker, [600, ...triangle(80, 240, 3)], { start: 20000, bpm: 220 });
        const at = (t) => rows.find((r) => r.now === t);
        // The 600 is rejected and the heart's first beat seeds the reference.
        assert.equal(at(21000).beats, 2);
        assert.equal(at(21000).rejectedPercent, 50);
        // At 30 s the warm-up is over and twenty pairs are in, 9 s after the
        // break.
        assert.equal(at(30000).status, 'gap');
        assert.equal(at(31000).status, 'ok');
        assert.equal(at(31000).rmssd, 3);
    });

    it('rejects a fault or an extra detection that starts at the first, second or third interval, and shows the true value after it', () => {
        // A heart near 92 BPM whose every step is 5 ms (true RMSSD 5),
        // reported at 92 BPM, starting mid-pattern at 650 ms. From its first,
        // second or third interval the strap counts wrong: once (a T wave or
        // a noise spike cuts one interval in two), or for a minute and a half
        // (it misses every other R wave, or counts every T wave). Accepted
        // unjudged, a fault from the first interval, or from the second with
        // the first three unjudged, would be taken for the heart and shown as
        // 'ok', and an interval cut in two there would outvote the heart for
        // as long as the stream lasted.
        const heart = triangle(1100, 600, 5).slice(10);
        for (const from of [1, 2, 3]) {
            const k = from - 1;
            const start = heart.slice(0, k);
            const faults = {
                cut: { values: [heart[k] * 0.4, heart[k] * 0.6], k: k + 1 },
                missed: report(heart, k, 90000, 'missed'),
                split: report(heart, k, 90000, 'split'),
                // Two artefacts that agree with each other.
                pair: { values: [330, 340], k }
            };
            for (const [name, fault] of Object.entries(faults)) {
                const after = report(heart, fault.k, 90000);
                const faultTo = sum(start) + sum(fault.values);
                const rows = strap(createHrvTracker(), [...start, ...fault.values, ...after.values], { bpm: 92 });
                const label = `${name} from interval ${from}`;
                for (const r of rows) {
                    if (r.now <= faultTo) assert.notEqual(r.status, 'ok', `${label}, ${r.now}`);
                    if (r.status === 'ok') assert.equal(r.rmssd, 5, `${label}, ${r.now}`);
                }
                const back = rows.find((r) => r.now > faultTo && r.status === 'ok');
                assert.ok(back, `${label}: the number did not come`);
                assert.ok(back.now - faultTo <= 32000, `${label}: back only ${(back.now - faultTo) / 1000} s after the fault`);
                assert.equal(rows[rows.length - 1].rejectedPercent, 0, label);
                // A fault that lasts is shown as one, not as a warm-up.
                if (name === 'missed' || name === 'split') {
                    assert.equal(rows.find((r) => r.now === 60000).status, 'artefacts', label);
                }
            }
        }
    });

    it('cannot be seeded by a packet without a usable heart rate', () => {
        // Its intervals are dropped, so they are neither beats nor the
        // reference: had the 480 seeded it, the heart's 660 would be more
        // than 30% away and rejected. Instead the heart's first beat, in the
        // first packet with a pulse, seeds it.
        const heart = triangle(80, 560).slice(10);                      // from 660
        for (const bpm of [undefined, null, 0, NaN, 300, '92']) {
            const tracker = createHrvTracker();
            tracker.push({ now: 0, bpm, rr: [480], contact: true });
            tracker.push({ now: 1000, bpm, rr: [470], contact: null });
            assert.equal(tracker.read(1000).beats, 0, String(bpm));
            const rows = feedAndRead(tracker, heart, { bpm: 92, start: 2000 });
            assert.equal(rows[0].beats, 1, String(bpm));
            assert.equal(rows[0].rejectedPercent, 0, String(bpm));
            assert.ok(rows.every((r) => r.rejectedPercent === 0), String(bpm));
            const shown = rows.filter((r) => r.status === 'ok');
            assert.ok(shown.length > 30, `${bpm}: the number did not come`);
            for (const r of shown) assert.equal(r.rmssd, 10, `${bpm}, ${r.now}`);
        }
    });

    it('judges every interval after the seed against the rhythm, whatever pulse its packet reports', () => {
        // The pulse only stands in for a reference that does not exist yet.
        // Once one does, a packet reporting 90 BPM (667 ms) cannot get a
        // 1250 rejected, 22% from the rhythm's 1025 ms; and one reporting
        // 46 BPM (1304 ms) cannot get a 1400 accepted, 36% from the 1030 ms
        // the rhythm has moved to.
        const tracker = createHrvTracker();
        feed(tracker, steady(20), { bpm: 60 });                         // 0 .. 19000
        tracker.push({ now: 20000, bpm: 90, rr: [1250], contact: true });
        assert.equal(tracker.read(20000).rejectedPercent, 0);
        tracker.push({ now: 21000, bpm: 46, rr: [1400], contact: true });
        const reading = tracker.read(21000);
        assert.equal(reading.beats, 22);
        assert.equal(reading.rejectedPercent, Math.round(100 / 22));
        // Even in the packet that seeded it: a premature beat of 750 ms seeds
        // against the 1000 ms of 60 BPM, and the pause of 1250 ms after it,
        // 25% from the pulse but 67% from the seed, is rejected.
        const same = createHrvTracker();
        same.push({ now: 0, bpm: 60, rr: [750, 1250], contact: true });
        assert.equal(same.read(0).beats, 2);
        assert.equal(same.read(0).rejectedPercent, 50);
    });

    it('does not add up premature beats scattered through the rhythm to a new one', () => {
        // A premature beat every fifth beat, always 650 ms after the one
        // before (premature beats keep their coupling interval). Twelve of
        // them agree with one another, but a rejected beat never enters the
        // reference, so it stays the heart's, and the number returns 30 s
        // after the last one.
        const tracker = createHrvTracker();
        const values = triangle(200);
        feed(tracker, values.slice(0, 45));                             // 0 .. 44000
        for (let i = 45; i <= 130; i++) {
            tracker.push({ now: i * 1000, bpm: 70, rr: [i < 105 && i % 5 === 0 ? 650 : values[i]], contact: true });
        }
        // The last premature beat came at 100 s; at 130 s it is the only
        // rejection left in the window (1 of 31).
        const reading = tracker.read(130000);
        assert.equal(reading.status, 'ok');
        assert.equal(reading.rmssd, 10);
        assert.equal(reading.rejectedPercent, 3);
    });

    it('does not take an alternating run as a rhythm', () => {
        // Thirty beats alternating 600 and 1400 ms, both in range and both
        // over 30% away from the rhythm: all rejected, none of them enters
        // the reference, and the heart is accepted again the moment the run
        // ends.
        const tracker = createHrvTracker();
        feed(tracker, triangle(45));                                    // 0 .. 44000
        let now = 45000;
        for (let i = 0; i < 30; i++) {
            tracker.push({ now, bpm: 70, rr: [i % 2 ? 1400 : 600], contact: true });
            now += 1000;
        }
        const rows = feedAndRead(tracker, triangle(45), { start: now });
        // 30 rejected and the heart's first beat accepted: 30 of 31.
        assert.equal(rows[0].rejectedPercent, 97);
        const back = rows.find((r) => r.now === now + 29000);
        assert.equal(back.status, 'ok');
        assert.equal(back.rmssd, 10);
    });

    it('establishes the rhythm only on beats that follow one another', () => {
        // The first 40 beats of a stream come in runs of eight, each ended
        // by a lost notification. Eight accepted beats in a row never make a
        // rhythm, so none of them opens a pair; the first eleven of the clean
        // stretch that follows do, and the twentieth pair after them closes
        // 30 s into it.
        const tracker = createHrvTracker();
        const values = triangle(200);
        let now = 0;
        let k = 0;
        for (let run = 0; run < 5; run++) {
            for (let i = 0; i < 8; i++) {
                tracker.push({ now, bpm: 70, rr: [values[k++]], contact: true });
                now += 1000;
            }
            now += 1000;
        }
        const clean = now;
        const rows = feedAndRead(tracker, values.slice(k, k + 45), { start: clean });
        for (const r of rows) {
            if (r.now < clean + 30000) assert.equal(r.status, 'warming', String(r.now - clean));
            else assert.equal(r.status, 'ok', String(r.now - clean));
        }
        assert.equal(rows[rows.length - 1].rmssd, 10);
    });

    it('does not take the premature beats of a slow bigeminy as the rhythm', () => {
        // At ~1300 ms a premature beat of ~700 ms is followed by a pause of
        // over 2000 ms. The premature beats agree with one another, but they
        // are rejected, and a rejected beat never enters the reference, so
        // the heart is accepted again the moment the bigeminy ends.
        const tracker = createHrvTracker();
        const slow = triangle(200, 1250);
        feed(tracker, slow.slice(0, 45), { bpm: 46 });                  // 0 .. 44000
        let now = 45000;
        for (let i = 0; i < 40; i++) {
            tracker.push({ now, bpm: 46, rr: [i % 2 ? 2150 : 700 + (i % 7)], contact: true });
            now += 1000;
        }
        const resumed = now;                                            // 85000
        const rows = feedAndRead(tracker, slow.slice(45, 90), { bpm: 46, start: resumed });
        // The window holds the last 30 beats of the bigeminy, all rejected,
        // and the first beat of the heart, accepted: 30 of 31.
        assert.equal(rows[0].rejectedPercent, 97, 'the first beat after the bigeminy was not accepted');
        const atThirty = rows.find((r) => r.now === resumed + 30000);
        assert.equal(atThirty.status, 'ok');
        assert.equal(atThirty.rmssd, 10);
    });

    it('shows no pair until the first beats of a stream agree with one another', () => {
        // A strap put on with dry electrodes, reporting 68 BPM (882 ms): two
        // artefacts, then the heart. The first is within 30% of the pulse and
        // seeds the reference, the second is within 30% of the first, and the
        // heart's beats are accepted against them. No pair counts before
        // eleven accepted beats in a row agree, so neither artefact ever
        // reaches the number; paired with each other and with the heart's
        // first beat, they would have shown 80 ms for a heart at 10.
        const tracker = createHrvTracker();
        tracker.push({ now: 1000, bpm: 68, rr: [1140], contact: true });
        tracker.push({ now: 2000, bpm: 68, rr: [1400], contact: true });
        const heart = [];
        for (let v = 1052; v >= 882; v -= 10) heart.push(v);
        for (let v = 892; v <= 1062; v += 10) heart.push(v);
        const rows = feedAndRead(tracker, [...heart, ...heart], { bpm: 68, start: 3000 });
        assert.ok(rows.every((r) => r.rejectedPercent === 0), 'an artefact or a beat was rejected');
        const shown = rows.filter((r) => r.status === 'ok');
        assert.ok(shown.length > 20, 'the number never came');
        for (const r of shown) assert.equal(r.rmssd, 10, String(r.now));
    });

    it('waits for the first eleven beats to agree, not only to be accepted', () => {
        // 1290, within 30% of the 1000 ms the strap's 60 BPM stands for,
        // then the steady rhythm: every beat is accepted, but the first
        // eleven do not agree (1290 is over 30% above their median of 980),
        // so the rhythm is established one beat later, when 1290 leaves
        // them, and the twentieth pair closes at 31 s instead of 30 s.
        const tracker = createHrvTracker();
        tracker.push({ now: 0, bpm: 60, rr: [1290], contact: true });
        const rows = feedAndRead(tracker, steady(60), { bpm: 60, start: 1000 });
        assert.equal(rows[rows.length - 1].rejectedPercent, 0);
        const at = (t) => rows.find((r) => r.now === t);
        assert.equal(at(30000).status, 'warming');
        assert.equal(at(31000).status, 'ok');
        assert.equal(at(31000).rmssd, 5);
    });

    it('forgets the rhythm on reset, and judges the first interval after it against the pulse again', () => {
        // A reset means another sensor or another session: the rhythm of
        // the old stream says nothing about the new one. Its first interval
        // is judged against the pulse the strap reports, exactly as at the
        // start of a stream: a stray 339 is rejected, the heart seeds a new
        // reference and establishes its own rhythm from scratch.
        const tracker = createHrvTracker();
        feed(tracker, triangle(45));                                    // ~900-1090
        tracker.reset(45000);
        tracker.push({ now: 46000, bpm: 100, rr: [339], contact: true });
        assert.equal(tracker.read(46000).rejectedPercent, 100);
        const rows = feedAndRead(tracker, triangle(40, 560), { bpm: 100, start: 47000 });
        // 560 is 40% below the old rhythm, and within 30% of 600 ms.
        assert.equal(rows[0].rejectedPercent, 50);
        assert.equal(rows[rows.length - 1].rejectedPercent, 0);
        assert.equal(rows.find((r) => r.status === 'ok').now, 77000);
        for (const r of rows) if (r.status === 'ok') assert.equal(r.rmssd, 10, String(r.now));
    });

    it('keeps the reference however many rejected intervals the record drops', () => {
        // Seven hundred intervals outside 240-2000 ms push every accepted
        // beat out of the 600-beat record. The reference is kept apart, so an
        // interval 35% away from the old rhythm is still rejected, and the
        // rhythm itself is accepted at once. The strap now reports 50 BPM
        // (1200 ms), so a lost reference would not have rejected the 1350:
        // the pulse would have judged it, and let it seed a new one.
        const tracker = createHrvTracker();
        feed(tracker, steady(45));
        for (let i = 0; i < 700; i++) tracker.push({ now: 45000 + i * 1000, bpm: 50, rr: [3000], contact: true });
        const now = 745000;
        tracker.push({ now, bpm: 50, rr: [1350], contact: true });
        tracker.push({ now: now + 1000, bpm: 50, rr: [1000], contact: true });
        const reading = tracker.read(now + 1000);
        // The window holds 29 intervals of 3000 ms, the 1350 and the 1000:
        // 30 rejected of 31. Had the 1350 seeded a new reference, the 1000
        // after it would have been accepted too (within 30% of 1350): 29 of
        // 31.
        assert.equal(reading.beats, 31);
        assert.equal(reading.rejectedPercent, Math.round(30 * 100 / 31));
    });
});

describe('rejection', () => {
    it('rejects an ectopic beat and its compensatory pause, then recovers without them', () => {
        const tracker = createHrvTracker();
        const values = triangle(40);
        feed(tracker, values);                                   // 0 .. 39000
        tracker.push({ now: 40000, bpm: 70, rr: [600], contact: true });   // premature
        tracker.push({ now: 41000, bpm: 70, rr: [1400], contact: true });  // compensatory pause
        // Two rejections among the 31 beats of the window are over 5%.
        const fresh = tracker.read(41000);
        assert.equal(fresh.status, 'artefacts');
        assert.equal(fresh.rejectedPercent, 6);
        assert.equal(fresh.rmssd, null);
        const rest = triangle(50);
        feed(tracker, rest.slice(0, 19), { start: 42000 });     // .. 60000
        assert.equal(tracker.read(60000).status, 'artefacts');
        // Once the premature beat has left the window one rejection in 31 is
        // 3%: the number returns, computed without the pairs that touched
        // the rejected beats.
        feed(tracker, rest.slice(19, 30), { start: 61000 });    // .. 71000
        const later = tracker.read(71000);
        assert.equal(later.status, 'ok');
        assert.equal(later.rejectedPercent, 3);
        assert.equal(later.rmssd, 10);
        feed(tracker, rest.slice(30), { start: 72000 });        // .. 91000
        const clean = tracker.read(91000);
        assert.equal(clean.rejectedPercent, 0);
        assert.equal(clean.rmssd, 10);
    });

    it('rejects intervals outside 240-2000 ms, even where the pulse or the rhythm would accept them', () => {
        // As the first interval of a stream: 250 BPM stands for 240 ms and
        // 35 BPM for 1714 ms, so the pulse alone would take 239.9 and 2000.1.
        for (const [bpm, value, ok] of [[250, 239.9, false], [250, 240, true], [35, 2000, true], [35, 2000.1, false], [70, 3000, false], [70, 0, false], [70, -5, false]]) {
            const tracker = createHrvTracker();
            tracker.push({ now: 0, bpm, rr: [value], contact: true });
            const reading = tracker.read(0);
            assert.equal(reading.beats, 1, String(value));
            assert.equal(reading.rejectedPercent, ok ? 0 : 100, String(value));
        }
        // Against a rhythm: 239.9 is 20% below a 300 ms one, and 2000.1 is
        // 18% above a 1700 ms one.
        for (const [bpm, rhythm, value, ok] of [[200, 300, 239.9, false], [200, 300, 240, true], [35, 1700, 2000, true], [35, 1700, 2000.1, false]]) {
            const tracker = createHrvTracker();
            feed(tracker, new Array(11).fill(rhythm), { bpm });         // 0 .. 10000
            tracker.push({ now: 11000, bpm, rr: [value], contact: true });
            const reading = tracker.read(11000);
            assert.equal(reading.beats, 12, String(value));
            assert.equal(reading.rejectedPercent, ok ? 0 : Math.round(100 / 12), String(value));
        }
    });

    it('measures the deviation against the median of the accepted rhythm', () => {
        // Median of the last eleven triangle values before 40 s is 940.
        const setup = () => {
            const tracker = createHrvTracker();
            feed(tracker, triangle(40));
            return tracker;
        };
        const kept = setup();
        kept.push({ now: 40000, bpm: 70, rr: [940 * 1.25], contact: true });
        assert.equal(kept.read(40000).rejectedPercent, 0);
        const dropped = setup();
        dropped.push({ now: 40000, bpm: 70, rr: [940 * 1.35], contact: true });
        assert.equal(dropped.read(40000).rejectedPercent, 3);
        // A rejected beat does not enter the reference: the next real beat
        // is judged against the same rhythm and accepted.
        dropped.push({ now: 41000, bpm: 70, rr: [940], contact: true });
        const after = dropped.read(41000);
        assert.equal(after.beats, 31);
        assert.equal(after.rejectedPercent, 3);
    });

    it('takes the median of the rhythm, so one large accepted beat cannot drag the reference', () => {
        const tracker = createHrvTracker();
        feed(tracker, new Array(10).fill(1000));                        // 0 .. 9000
        tracker.push({ now: 10000, bpm: 70, rr: [1290], contact: true });   // 29% off: accepted
        assert.equal(tracker.read(10000).rejectedPercent, 0);
        // Against the median (1000) 1305 is 30.5% off and rejected; against
        // the mean (1026) it would be 27% off and let through.
        tracker.push({ now: 11000, bpm: 70, rr: [1305], contact: true });
        assert.equal(tracker.read(11000).rejectedPercent, 8);
    });

    it('rejects only what is more than 30% away: exactly 30% is kept', () => {
        for (const value of [700, 1300]) {
            const tracker = createHrvTracker();
            feed(tracker, new Array(11).fill(1000));                     // 0 .. 10000
            tracker.push({ now: 11000, bpm: 70, rr: [value], contact: true });
            assert.equal(tracker.read(11000).rejectedPercent, 0, String(value));
        }
    });
});

describe('a strap that is not being read', () => {
    it('says artefacts, not warming, once more than half of 20 or more beats in the window were rejected', () => {
        // One beat of the heart, then nothing the strap sends is a heartbeat.
        // 'warming' would promise a number that is not coming.
        const tracker = createHrvTracker();
        tracker.push({ now: 0, bpm: 60, rr: [1000], contact: true });
        const rows = feedAndRead(tracker, new Array(25).fill(3000), { bpm: 60, start: 1000 });
        // 19 beats in the window are too few to call.
        assert.equal(rows[17].beats, 19);
        assert.equal(rows[17].status, 'warming');
        // 20 of them, 19 rejected, 19 s into the stream: still in the warm-up.
        assert.equal(rows[18].beats, 20);
        assert.equal(rows[18].rejectedPercent, 95);
        assert.ok(rows[18].now < WARMUP_MS);
        assert.equal(rows[18].status, 'artefacts');
        assert.equal(rows[18].rmssd, null);
        assert.equal(rows[18].rrHr, null);
    });

    it('needs more than half: an even split is still the warm-up', () => {
        // Beats of the heart and intervals out of range alternate.
        const tracker = createHrvTracker();
        const values = [];
        for (let i = 0; i < 10; i++) values.push(1000 + (i % 3) * 5, 3000);
        const last = feed(tracker, values, { bpm: 60 });                // 0 .. 19000
        const even = tracker.read(last);
        assert.equal(even.beats, 20);
        assert.equal(even.rejectedPercent, LOCK_REJECTED_PERCENT);
        assert.equal(even.status, 'warming');
        tracker.push({ now: last + 1000, bpm: 60, rr: [3000], contact: true });
        assert.equal(tracker.read(last + 1000).status, 'artefacts');    // 11 of 21
    });

    it('says artefacts for as long as the reference cannot reach the heart, and reset seeds it again', () => {
        // A premature beat opens the stream: 720 ms, within 30% of the
        // 1000 ms the strap's 60 BPM stands for, so it seeds the reference.
        // The pause after it and every beat of the heart, 955-1045 ms, are
        // more than 30% above it, so all of them are rejected, and nothing
        // but reset() seeds the reference again. For five minutes nothing is
        // shown, and the stream says it is not being read.
        const tracker = createHrvTracker();
        tracker.push({ now: 0, bpm: 60, rr: [720, 1280], contact: true });
        const rows = feedAndRead(tracker, steady(300), { bpm: 60, start: 1000 });
        for (const r of rows) {
            assert.notEqual(r.status, 'ok', String(r.now));
            if (r.beats >= LOCK_MIN_BEATS) assert.equal(r.status, 'artefacts', String(r.now));
        }
        assert.equal(rows[rows.length - 1].rejectedPercent, 100);
        tracker.reset(301000);
        const again = feedAndRead(tracker, steady(40, 300), { bpm: 60, start: 301000 });
        assert.ok(again.every((r) => r.rejectedPercent === 0));
        assert.equal(again.find((r) => r.status === 'ok').now, 301000 + WARMUP_MS);
        for (const r of again) if (r.status === 'ok') assert.equal(r.rmssd, 5, String(r.now));
    });

    it('still says synthetic first', () => {
        // A sensor caught filling the RR field from its BPM is named for what
        // it is, whatever it sends afterwards: moistening it would not help.
        const tracker = createHrvTracker();
        const last = feed(tracker, new Array(SYNTH_MIN_BEATS).fill(750), { bpm: 80 });
        const rows = feedAndRead(tracker, new Array(30).fill(3000), { bpm: 80, start: last + 1000 });
        const end = rows[rows.length - 1];
        assert.ok(end.beats >= LOCK_MIN_BEATS && end.rejectedPercent > LOCK_REJECTED_PERCENT);
        assert.ok(rows.every((r) => r.status === 'synthetic'));
    });
});

describe('synthetic RR', () => {
    it('latches on a 60000 / BPM stream at 80 BPM at the 20th beat, until reset', () => {
        const tracker = createHrvTracker();
        const last = feed(tracker, new Array(SYNTH_MIN_BEATS - 1).fill(750), { bpm: 80 });
        assert.equal(tracker.read(last).status, 'warming');
        tracker.push({ now: last + 1000, bpm: 80, rr: [750], contact: true });
        const judged = tracker.read(last + 1000);
        assert.equal(judged.status, 'synthetic');
        assert.equal(judged.rmssd, null);
        // Real-looking beats afterwards change nothing: it is judged once.
        const real = feed(tracker, triangle(45), { bpm: 70, start: last + 2000 });
        assert.equal(tracker.read(real).status, 'synthetic');
        tracker.reset(real);
        assert.equal(tracker.read(real).status, 'waiting');
        assert.equal(tracker.read(real).rrSeen, false);
        // And the latch is really gone: beats after the reset are judged afresh.
        const again = feed(tracker, triangle(45), { bpm: 70, start: real + 1000 });
        assert.equal(tracker.read(again).status, 'ok');
    });

    it('judges every beat that arrived, whether the rhythm kept it or not', () => {
        // A watch filling the field from its BPM, which jumps from 60 to 100
        // after 16 beats: the formula jumps with it, 40% away from the
        // rhythm, and those 4 beats are rejected. They are still the
        // formula, and the stream is caught at the 20th beat that arrived,
        // not at the 20th the rhythm kept.
        const tracker = createHrvTracker();
        const last = feed(tracker, new Array(16).fill(1000), { bpm: 60 });
        for (let i = 1; i <= 3; i++) tracker.push({ now: last + i * 1000, bpm: 100, rr: [600], contact: true });
        assert.equal(tracker.read(last + 3000).status, 'warming');
        tracker.push({ now: last + 4000, bpm: 100, rr: [600], contact: true });
        const judged = tracker.read(last + 4000);
        assert.equal(judged.rejectedPercent, 20);
        assert.equal(judged.status, 'synthetic');
    });

    it('counts a beat as the formula only within 1.5 ms', () => {
        const build = (offset) => {
            const tracker = createHrvTracker();
            const last = feed(tracker, new Array(SYNTH_MIN_BEATS).fill(750 + offset), { bpm: 80 });
            return tracker.read(last).status;
        };
        assert.equal(build(SYNTH_TOLERANCE_MS), 'synthetic');
        assert.notEqual(build(SYNTH_TOLERANCE_MS + 0.5), 'synthetic');
        assert.notEqual(build(-2), 'synthetic');
    });

    it('recognises the formula through the sensor\'s 1/1024 s quantisation and a moving BPM', () => {
        const tracker = createHrvTracker();
        let now = 0;
        for (let i = 0; i < 25; i++) {
            const bpm = 71 + (i % 9);
            const units = Math.round(60000 / bpm * 1024 / 1000);
            tracker.push({ now, bpm, rr: [units * 1000 / 1024], contact: true });
            now += 1000;
        }
        assert.equal(tracker.read(now).status, 'synthetic');
    });

    it('never judges beats that arrived with a BPM of 110 or more', () => {
        const tracker = createHrvTracker();
        const last = feed(tracker, new Array(60).fill(400), { bpm: 150 });
        const reading = tracker.read(last);
        assert.notEqual(reading.status, 'synthetic');
        // The flat guard still keeps a constant stream off the screen.
        assert.equal(reading.status, 'flat');
        assert.equal(reading.rmssd, null);
        const edge = createHrvTracker();
        const lastEdge = feed(edge, new Array(60).fill(60000 / SYNTH_MAX_BPM), { bpm: SYNTH_MAX_BPM });
        assert.notEqual(edge.read(lastEdge).status, 'synthetic');
    });

    it('judges once: a stream that was real for its first 20 beats is never re-judged', () => {
        const tracker = createHrvTracker();
        feed(tracker, triangle(SYNTH_MIN_BEATS), { bpm: 60 });
        const last = feed(tracker, new Array(100).fill(1000), { bpm: 60, start: SYNTH_MIN_BEATS * 1000 });
        assert.notEqual(tracker.read(last).status, 'synthetic');
    });

    it('does not latch on a real tachogram whose values sometimes equal the formula', () => {
        const tracker = createHrvTracker();
        const last = feed(tracker, triangle(45), { bpm: 60 });
        assert.equal(tracker.read(last).status, 'ok');
    });

    it('needs more than 80%: 16 of 20 is not enough, 17 is', () => {
        const build = (close) => {
            const tracker = createHrvTracker();
            const values = [];
            for (let i = 0; i < SYNTH_MIN_BEATS; i++) values.push(i < close ? 750 : 780 + i);
            const last = feed(tracker, values, { bpm: 80 });
            return tracker.read(last).status;
        };
        assert.notEqual(build(16), 'synthetic');
        assert.equal(build(17), 'synthetic');
    });
});

describe('flat guard', () => {
    it('hides a constant stream', () => {
        const tracker = createHrvTracker();
        const last = feed(tracker, new Array(45).fill(1000));
        const reading = tracker.read(last);
        assert.equal(reading.status, 'flat');
        assert.equal(reading.rmssd, null);
    });

    it('hides a stream with fewer than 10 distinct whole-millisecond values', () => {
        const tracker = createHrvTracker();
        const last = feed(tracker, Array.from({ length: 45 }, (_, i) => (i % 2 ? 1010 : 990)));
        // RMSSD would be 20 ms, but two values are not a heart.
        assert.equal(tracker.read(last).status, 'flat');
    });

    it('hides an RMSSD under 2 ms even with plenty of distinct values', () => {
        const tracker = createHrvTracker();
        const last = feed(tracker, triangle(45, 1000, 1));
        assert.equal(tracker.read(last).status, 'flat');
        const fine = createHrvTracker();
        const lastFine = feed(fine, triangle(45, 1000, 2));
        assert.equal(fine.read(lastFine).status, 'ok');
        assert.equal(fine.read(lastFine).rmssd, 2);
    });
});

describe('sensors without RR', () => {
    it('reports noRr after 10 s of packets, and warming once RR appears', () => {
        const tracker = createHrvTracker();
        for (let t = 0; t < 10000; t += 1000) tracker.push({ now: t, bpm: 70, rr: [], contact: null });
        assert.equal(tracker.read(NO_RR_AFTER_MS - 1).status, 'waiting');
        tracker.push({ now: 10000, bpm: 70, rr: [], contact: null });
        const none = tracker.read(NO_RR_AFTER_MS);
        assert.equal(none.status, 'noRr');
        assert.equal(none.rrSeen, false);
        assert.equal(none.beats, 0);
        tracker.push({ now: 11000, bpm: 70, rr: [850], contact: null });
        const back = tracker.read(11000);
        assert.equal(back.status, 'warming');
        assert.equal(back.rrSeen, true);
    });

    it('treats a missing rr field like an empty one', () => {
        const tracker = createHrvTracker();
        for (let t = 0; t <= 10000; t += 1000) tracker.push({ now: t, bpm: 70 });
        assert.equal(tracker.read(10000).status, 'noRr');
    });
});

describe('robustness', () => {
    it('never produces NaN, whatever the packets carry', () => {
        const tracker = createHrvTracker();
        const junk = [
            { now: 0, bpm: NaN, rr: [1000] },
            { now: 1000, bpm: '70', rr: 'abc' },
            { now: 2000, bpm: 70, rr: {} },
            { now: 3000, bpm: 70, rr: [NaN, Infinity, 'x', null, 1000], contact: 'yes' },
            { now: 4000, bpm: 70, rr: new Float64Array([980, 1020]), contact: 1 },
            { now: 5000, bpm: 70, rr: [-5, 0, 1e9] },
            { now: 6000, bpm: 300, rr: [1000] },
            { now: 7000, bpm: 70, rr: [true, false] },
            { now: 8000, bpm: 70, rr: [], contact: undefined },
            { now: -5, bpm: 70, rr: [1000] },
            { now: 1e15, bpm: 70, rr: [1000] }
        ];
        for (const packet of junk) tracker.push(packet);
        for (const at of [0, 5000, 8000, 1e15, 1e15 + 60000, -1, undefined, NaN, Infinity]) assertSane(tracker.read(at));
        const flooded = createHrvTracker();
        for (let i = 0; i < 100; i++) flooded.push({ now: i * 1000, bpm: 70, rr: [1e9, -1e9] });
        assertSane(flooded.read(99000));
        assert.equal(flooded.read(99000).rejectedPercent, 100);
    });

    it('a throw inside push leaves read consistent', () => {
        const tracker = createHrvTracker();
        const last = feed(tracker, triangle(45));
        const before = tracker.read(last);
        assert.equal(before.status, 'ok');
        assert.throws(() => tracker.push(null), TypeError);
        assert.throws(() => tracker.push(), TypeError);
        assert.throws(() => tracker.push({ now: NaN, bpm: 70, rr: [1000] }), TypeError);
        assert.throws(() => tracker.push({ now: '45000', bpm: 70, rr: [1000] }), TypeError);
        assert.throws(() => tracker.push({ now: last + 1000, bpm: 70, rr: [{ valueOf() { throw new Error('boom'); } }] }), /boom/);
        assert.deepEqual(tracker.read(last), before);
        assertSane(tracker.read(last + 1000));
        // The stream goes on as if the bad packets had never been offered.
        const resumed = feed(tracker, triangle(50).slice(45), { start: last + 1000 });
        assert.equal(tracker.read(resumed).status, 'ok');
        assert.equal(tracker.read(resumed).rmssd, 10);
    });

    it('keeps at most 600 beats', () => {
        const tracker = createHrvTracker();
        for (let i = 0; i < MAX_BEATS + 100; i++) tracker.push({ now: 1000, bpm: 70, rr: [1000], contact: true });
        assert.equal(tracker.read(1000).beats, MAX_BEATS);
    });

    it('hands out frozen readings', () => {
        const tracker = createHrvTracker();
        const last = feed(tracker, triangle(45));
        const reading = tracker.read(last);
        assert.ok(Object.isFrozen(reading));
        assert.throws(() => { reading.status = 'ok'; });
        assert.throws(() => { reading.rmssd = 0; });
    });

    it('rounds the reported percentage but decides on the exact share', () => {
        // 60 packets 550 ms apart put exactly 55 beats into the 30 s window.
        // 3 rejections among them are 5.45%: over the 5% line, shown as 5%.
        const tracker = createHrvTracker();
        const values = triangle(60, 600);
        values[30] = 3000;
        values[40] = 3000;
        values[50] = 3000;
        const last = feed(tracker, values, { bpm: 100, period: 550 });
        const reading = tracker.read(last);
        assert.equal(reading.beats, 55);
        assert.equal(reading.rejectedPercent, 5);
        assert.equal(reading.status, 'artefacts');
    });
});
