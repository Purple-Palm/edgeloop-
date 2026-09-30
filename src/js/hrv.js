// Beat-to-beat (HRV) tracker fed by the RR intervals a chest strap puts in
// its Heart Rate Measurement packets. Pure: no DOM and no clock of its own
// (every entry point takes `now`), so all of it runs under node:test. It is
// read-only for the rest of EdgeLoop: nothing here reaches the engine, the
// ceiling or a toy, and the HR Monitor modal only paints what read() says.
//
// The point of the status gate is honesty. The RMSSD of a resting heart is a
// few tens of milliseconds, and a strap slipping on a sweaty chest, a watch
// that fills the RR field from its averaged BPM, a lost notification or a
// premature beat can each manufacture a number that looks like one. Every
// such case has a status here, and rmssd is null unless the status is 'ok'.

import { isValidBpm } from './hr-watchdog.js';

// Physiological bounds: 250 BPM down to 30 BPM. An interval outside them is
// a sensor artefact (a doubled or halved beat, a zero), never a heartbeat.
export const RR_MIN_MS = 240;
export const RR_MAX_MS = 2000;

// Ectopic filter: a beat more than 30% away from the median of the last 11
// accepted beats is rejected. A premature beat and the compensatory pause
// after it are each about 40% off, while real beat-to-beat change stays well
// under 10%, so a single ectopic pair cannot inflate the RMSSD.
//
// The reference never ages. After a loss of contact the first interval back
// is judged against the heart from before the loss, so the artefact a strap
// produces as its electrodes touch the skin again is rejected. A reference
// that forgot beats older than the window had nothing left to judge that
// interval by: it accepted it blind, made it the whole reference and paired
// it with the next real beat, which put an RMSSD fifteen times too high on
// screen as 'ok'.
//
// Only an accepted beat ever moves the reference. A run of rejected beats
// never replaces it, however long the run lasts and however well its
// intervals agree with one another. A strap that misses every other R wave
// reports intervals twice as long as the heart's, which agree with one
// another from the first; one that also triggers on the T wave cuts every
// interval in two, and the halves agree whenever the T wave falls near
// mid-beat. Either lasts as long as the fault does, and nothing in the
// intervals tells it from a heart that changed pace. Adopted as the new
// rhythm once eleven of them agreed, either put its own RMSSD on screen as
// 'ok' within the minute; the missed beats showed 38 ms for a heart at 10,
// next to a heart rate half the real one. The cost is on the other side,
// and it shows nothing false: when the pulse moved by more than 30% while
// no beat came through, every beat after the loss is rejected, and no
// number is shown, until the pulse comes back within 30% of the old rhythm
// or the sensor is reset.
//
// A stream starts with no accepted beat to judge by, and the first interval
// accepted becomes the whole reference. Until there is one, the pulse the
// strap reports in the same packet stands in for it: the first interval in
// range and within 30% of 60000 / BPM seeds the reference, and every
// interval before it is rejected. A packet without a usable BPM seeds
// nothing, since its intervals are dropped. From the seed on, every interval
// is judged against the rhythm, and none is accepted unjudged. Accepted on
// the range alone, a stray detection that opened the stream would reject
// every real beat after it for as long as the stream lasted. Taking the first
// three unjudged instead would let an extra detection in the second
// interval do the same, and would show a strap that misses every other R
// wave, or counts the T wave, from its second interval on as the heart, as
// 'ok'.
//
// Nothing but reset() seeds the reference again, so the cost named above
// also falls on a stream seeded by an interval close enough to the strap's
// pulse but too short for the heart's beats to lie within 30% of it: 70-77%
// of the heart's own when the strap reports the pulse right, as a premature
// beat can be. Either way the heart's beats are rejected until one comes
// within 30% of the reference, and read() says so (see LOCK_MIN_BEATS)
// instead of showing a number.
//
// What makes a rhythm is MEDIAN_ORDER successive beats that agree with one
// another (each within 30% of their own median), and until the stream has
// shown one, no pair counts. A strap put on with dry electrodes opens with a
// few artefacts, and one close enough to the strap's pulse to seed the
// reference, paired with the first real beat, would put a difference of
// hundreds of milliseconds into the first reading after warm-up.
export const MEDIAN_ORDER = 11;
export const DEVIATION_FRACTION = 0.30;

// Lost notifications: a packet arriving more than max(1500 ms, its own RR
// sum + 300 ms) after the previous one means beats went missing in transit,
// so the beats on either side are not successive. The floor covers a slow
// heart (50 BPM fits no beat into some 1 s packets) and the RR sum covers
// relay apps that batch several beats into one packet.
export const GAP_MIN_MS = 1500;
export const GAP_TOLERANCE_MS = 300;

// RMSSD is taken over the last 30 s and needs 20 contiguous pairs. More than
// 5% rejected beats in that window means the electrodes, not the heart, are
// making the numbers, so none is shown.
export const RMSSD_WINDOW_MS = 30000;
export const MIN_PAIRS = 20;
export const MAX_REJECTED_PERCENT = 5;

// More than half of 20 or more beats in the window rejected means the strap
// is not being read cleanly: a fault is still going on, or the reference no
// longer reaches the heart (see MEDIAN_ORDER). That is 'artefacts' even
// during the warm-up and without 20 pairs: 'warming' would promise a number
// that is not coming, when what helps is moistening the electrodes or
// reconnecting.
export const LOCK_MIN_BEATS = 20;
export const LOCK_REJECTED_PERCENT = 50;

// A break in the last 10 s hides the number while the window rebuilds; the
// first 30 s after RR appears are a warm-up; 10 s of packets without one RR
// means this sensor does not send them (watches and phone relays do not).
export const FRESH_BREAK_MS = 10000;
export const WARMUP_MS = 30000;
export const NO_RR_AFTER_MS = 10000;

// Some sensors fill the RR field with 60000 / BPM instead of measured beats.
// The stream is judged once, on the first 20 beats that arrived with a BPM
// under 110: more than 80% within 1.5 ms of the formula is arithmetic, not a
// heart. At higher rates real intervals bunch within a few milliseconds of
// their mean, too close to the formula for the test to be safe, so those
// beats are not judged.
export const SYNTH_TOLERANCE_MS = 1.5;
export const SYNTH_RATIO = 0.8;
export const SYNTH_MIN_BEATS = 20;
export const SYNTH_MAX_BPM = 110;

// Flat guard: an RMSSD under 2 ms, or fewer than 10 distinct whole-ms values
// in the last 60 beats, is a stream too regular to be a living heart (a
// formula stream at a rate the synthetic check never judges lands here).
export const FLAT_RMSSD_MS = 2;
export const FLAT_MIN_DISTINCT = 10;
export const FLAT_WINDOW_BEATS = 60;

// Memory bound. 600 beats is ten minutes at 60 BPM, far more than any window
// here needs, so trimming never changes a reading.
export const MAX_BEATS = 600;

// The RR-derived heart rate shown next to the sensor's BPM averages this many
// of the latest accepted beats: long enough to steady it, short enough that
// it still follows the pulse.
const RR_HR_BEATS = 10;

// What read() says before a single packet has arrived.
const NOTHING_YET = Object.freeze({
    status: 'waiting',
    rmssd: null,
    beats: 0,
    rejectedPercent: 0,
    rrHr: null,
    rrSeen: false
});

function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isNear(value, typical) {
    return Math.abs(value - typical) <= DEVIATION_FRACTION * typical;
}

// Intervals that each lie within 30% of their own median are a rhythm, not
// scatter.
function agree(values) {
    const typical = median(values);
    return values.every((value) => isNear(value, typical));
}

function freshState() {
    return {
        firstPacketAt: null,
        lastPacketAt: null,
        firstRrAt: null,
        rrSeen: false,
        // Every judged beat, oldest first: { t, rr, ok, contiguous }. `t` is
        // when the beat ended; `contiguous` says the previous accepted beat
        // is its true predecessor, with no break between the two.
        beats: [],
        // The reference a beat is judged against: the last MEDIAN_ORDER
        // accepted intervals. Kept apart from `beats`, so trimming the record
        // never loses it. Empty until an interval close to the strap's own
        // pulse seeds it.
        rhythm: [],
        // Whether the stream has shown a rhythm yet (see MEDIAN_ORDER), which
        // it does once, by MEDIAN_ORDER accepted beats in a row that agree
        // with one another. `streak` counts the beats accepted since the last
        // break.
        established: false,
        streak: 0,
        // A break stays pending until the next accepted beat, which then
        // starts a new contiguous run instead of pairing across the break.
        // A stream starts with one: its first beat has no predecessor.
        pendingBreak: true,
        lastBreakAt: null,
        synthSeen: 0,
        synthClose: 0,
        synthJudged: false,
        synthetic: false
    };
}

function distinctRoundedValues(beats) {
    const seen = new Set();
    let counted = 0;
    for (let i = beats.length - 1; i >= 0 && counted < FLAT_WINDOW_BEATS; i--) {
        if (!beats[i].ok) continue;
        seen.add(Math.round(beats[i].rr));
        counted += 1;
    }
    return seen.size;
}

function meanOfLastAccepted(beats, count) {
    let sum = 0;
    let n = 0;
    for (let i = beats.length - 1; i >= 0 && n < count; i--) {
        if (!beats[i].ok) continue;
        sum += beats[i].rr;
        n += 1;
    }
    return n ? sum / n : null;
}

// Tracker with three entry points:
//   push({ now, bpm, rr, contact })  one Heart Rate Measurement packet, as
//                                    ble.js hands it on (rr in ms, contact
//                                    true / false / null).
//   read(now)                        a frozen { status, rmssd, beats,
//                                    rejectedPercent, rrHr, rrSeen }.
//   reset(now)                       forget the stream (connect, disconnect,
//                                    simulator engaged).
// Statuses, first match wins: synthetic, noRr, waiting, artefacts (more than
// half of 20 or more beats rejected), warming, artefacts (more than 5%), gap,
// flat, ok. rmssd (one decimal) and rrHr (60000 / mean of the last ten
// accepted beats) are null unless the status is 'ok'.
export function createHrvTracker() {
    let s = freshState();

    return {
        push(packet) {
            if (!packet || typeof packet !== 'object') throw new TypeError('HRV push needs a packet object');
            const now = packet.now;
            if (!Number.isFinite(now)) throw new TypeError('HRV packet needs a finite arrival time');
            const bpm = packet.bpm;
            const contact = packet.contact;
            const rrRaw = Array.isArray(packet.rr) || ArrayBuffer.isView(packet.rr)
                ? Array.from(packet.rr, Number)
                : [];
            const rr = rrRaw.filter(Number.isFinite);

            // Everything that can throw has thrown by now. The rest works on
            // a copy and swaps it in with one assignment at the end, so a
            // failure anywhere leaves read() describing the stream exactly as
            // it was before this packet.
            const next = { ...s, beats: s.beats.slice(), rhythm: s.rhythm.slice() };
            const markBreak = () => {
                next.pendingBreak = true;
                next.lastBreakAt = now;
                next.streak = 0;
            };

            const previousArrival = next.lastPacketAt;
            next.lastPacketAt = now;
            if (next.firstPacketAt === null) next.firstPacketAt = now;
            if (rr.length) {
                next.rrSeen = true;
                if (next.firstRrAt === null) next.firstRrAt = now;
            }

            // Lost notification(s) between the previous packet (of any kind,
            // even one without RR) and this one.
            if (previousArrival !== null) {
                const carried = rr.reduce((sum, value) => sum + value, 0);
                if (now - previousArrival > Math.max(GAP_MIN_MS, carried + GAP_TOLERANCE_MS)) markBreak();
            }

            // Off the skin or no usable pulse: whatever RR came along is not
            // a beat of this heart, and the beats before and after it are
            // not successive either.
            if (!isValidBpm(bpm) || contact === false) {
                markBreak();
                s = next;
                return;
            }

            // Beat times run backwards from the arrival: the last interval
            // ended when the packet arrived, each earlier one that interval
            // before. Nothing is interpolated, and an entry that is not a
            // number has no duration to count.
            const times = new Array(rrRaw.length);
            let t = now;
            for (let i = rrRaw.length - 1; i >= 0; i--) {
                times[i] = t;
                if (Number.isFinite(rrRaw[i])) t -= rrRaw[i];
            }

            for (let i = 0; i < rrRaw.length; i++) {
                const value = rrRaw[i];

                // An entry that is not a number was a beat we cannot use, so
                // the run breaks where it sits: the beats on either side of it
                // are not successive, while the ones before it still are.
                if (!Number.isFinite(value)) {
                    markBreak();
                    continue;
                }

                if (!next.synthJudged && bpm < SYNTH_MAX_BPM) {
                    next.synthSeen += 1;
                    if (Math.abs(value - 60000 / bpm) <= SYNTH_TOLERANCE_MS) next.synthClose += 1;
                    if (next.synthSeen >= SYNTH_MIN_BEATS) {
                        next.synthJudged = true;
                        next.synthetic = next.synthClose > SYNTH_RATIO * next.synthSeen;
                    }
                }

                // Until the reference is seeded, the pulse this packet
                // reports stands in for it (see MEDIAN_ORDER). The BPM is
                // usable here: a packet without one was dropped above.
                const typical = next.rhythm.length ? median(next.rhythm) : 60000 / bpm;
                const ok = value >= RR_MIN_MS && value <= RR_MAX_MS && isNear(value, typical);

                if (ok) {
                    next.beats.push({ t: times[i], rr: value, ok: true, contiguous: !next.pendingBreak });
                    next.rhythm.push(value);
                    if (next.rhythm.length > MEDIAN_ORDER) next.rhythm.shift();
                    next.streak += 1;
                    if (!next.established && next.streak >= MEDIAN_ORDER && agree(next.rhythm)) {
                        next.established = true;
                    }
                    // Before the rhythm is established this beat opens no
                    // pair, so the next accepted beat starts a new run.
                    next.pendingBreak = !next.established;
                } else {
                    next.beats.push({ t: times[i], rr: value, ok: false, contiguous: false });
                    markBreak();
                }
            }

            if (next.beats.length > MAX_BEATS) next.beats.splice(0, next.beats.length - MAX_BEATS);
            s = next;
        },

        read(now) {
            if (s.firstPacketAt === null) return NOTHING_YET;
            // A caller without a clock gets the stream as of its last packet.
            const at = Number.isFinite(now) ? now : s.lastPacketAt;

            const oldest = at - RMSSD_WINDOW_MS;
            let inWindow = 0;
            let rejected = 0;
            let sumSquares = 0;
            let pairs = 0;
            let previous = null;
            for (const beat of s.beats) {
                const recent = beat.t >= oldest;
                if (recent) {
                    inWindow += 1;
                    if (!beat.ok) rejected += 1;
                }
                if (!beat.ok) continue;
                if (previous && beat.contiguous && recent) {
                    const diff = beat.rr - previous.rr;
                    sumSquares += diff * diff;
                    pairs += 1;
                }
                previous = beat;
            }
            const rmssd = pairs ? Math.sqrt(sumSquares / pairs) : null;

            let status;
            if (s.synthetic) {
                status = 'synthetic';
            } else if (!s.rrSeen) {
                status = at - s.firstPacketAt >= NO_RR_AFTER_MS ? 'noRr' : 'waiting';
            } else if (inWindow >= LOCK_MIN_BEATS && rejected * 100 > LOCK_REJECTED_PERCENT * inWindow) {
                status = 'artefacts';
            } else if (at - s.firstRrAt < WARMUP_MS || pairs < MIN_PAIRS) {
                status = 'warming';
            } else if (rejected * 100 > MAX_REJECTED_PERCENT * inWindow) {
                status = 'artefacts';
            } else if (s.lastBreakAt !== null && at - s.lastBreakAt < FRESH_BREAK_MS) {
                status = 'gap';
            } else if (rmssd < FLAT_RMSSD_MS || distinctRoundedValues(s.beats) < FLAT_MIN_DISTINCT) {
                status = 'flat';
            } else {
                status = 'ok';
            }

            const meanRr = status === 'ok' ? meanOfLastAccepted(s.beats, RR_HR_BEATS) : null;
            return Object.freeze({
                status,
                rmssd: status === 'ok' ? Math.round(rmssd * 10) / 10 : null,
                beats: inWindow,
                rejectedPercent: inWindow ? Math.round(rejected * 100 / inWindow) : 0,
                rrHr: meanRr ? Math.round(60000 / meanRr) : null,
                rrSeen: s.rrSeen
            });
        },

        // `now` is taken for symmetry with push and read, but a reset has
        // nothing to date: the 10 s no-RR clock starts at the first packet,
        // because a sensor that has sent nothing yet cannot be said to send
        // heart rate only.
        reset(now) {
            s = freshState();
        }
    };
}
