// Whether the pulse has really reached the pullback mark, or one reading only
// said it had. Pure: no DOM and no timers, so every rule runs under node:test.
// app.js keeps the last few readings of the pulse source; the engine asks.
//
// The pullback and the edge are two different things. The pullback - the
// primary eased to a crawl or stopped at the mark - starts on the first
// reading at the mark, exactly as it always has: a pulse that really is there
// must not wait for anything. The EDGE is what the session counts, and a
// count is not free. Adaptive Ceiling Decay lowers the working ceiling for
// the rest of the session on it, Survival raises its ceiling 1 BPM and its
// speed a step, a rotating toy reverses, the edge cue is spoken, and The
// Oracle and Edge Training start their hold on it. 1.1.0 to 1.1.2 counted
// an edge on one reading at the mark, so a wearer who sat up - his pulse rose
// about 10 BPM for about 10 s, and one reading of it touched the mark - had
// an edge counted for it, and Adaptive Ceiling Decay a step closer to
// lowering his ceiling for the rest of the session. Roughly 5% of
// wrist-sensor readings are off by 20 BPM or more, and chest straps glitch
// too.
//
// So an edge is counted only once the pulse has HELD at the mark, by the rule
// a sustained peak is read with: the value held on two consecutive readings,
// which is the lower of the two. The current reading and the one before it
// must both be at or above the mark.
//
// A reading more than SPIKE_MARGIN_BPM above both of its neighbours is a
// spike, not a heartbeat, and it never counts: not as the reading at the
// mark, and not as the reading that holds it there. The pair rule alone would
// let a glitch vouch for a pulse that touched the mark once - 141 on a 140
// mark, then a 170 that was never a heartbeat, hold 141 between them. A
// spike is left out as if the sensor had skipped it, and the readings either
// side of it become neighbours, so one of them may in turn stand out as a
// spike against the other: in 139, 165, 190, 141 the 190 goes first, then
// the 165, and neither counts. A reading with no neighbour before it - the
// first after a gap, or the first of all, which is when a strap settling on
// the skin reads its wildest - is judged by the reading after it alone. The
// newest reading has no neighbour after it yet: one that leapt more than the
// margin above the reading before it confirms nothing until the next reading
// shows it was not a spike.
//
// Two readings are consecutive only when the second came within the
// signal-loss timeout of the first. A longer gap is the one the watchdog
// calls a lost pulse and stops the motors for: a reading from before it and
// one from after it are not two readings of one pulse, so they confirm
// nothing, and after a gap the edge waits for two readings again.
//
// What it costs. The pullback is not delayed at all; the count waits for one
// more reading - the next one, if the pulse holds there. That is the
// source's own interval: about 1 s on a chest strap, which reads once a
// second, and 4-10 s on a watch or relay app that sends a reading every
// 4-10 s. It waits one reading more only when that next reading leapt more
// than SPIKE_MARGIN_BPM above the one before it, which a real pulse does not
// do between two readings of a strap, or when a spike came in between. A
// relay slower than the signal-loss timeout (8 s unless the wearer changed
// it) has to have the timeout raised above its interval to run at all - the
// watchdog would pause the session between two of its readings - and with it
// raised, its readings are consecutive here too.

import { isValidBpm, DEFAULT_WATCHDOG_SETTINGS, MIN_STALE_SECONDS, MAX_STALE_SECONDS } from './hr-watchdog.js';

// How many readings app.js keeps for this. The rule reads the current
// reading, the one before it and that one's own neighbour; a few more cost
// nothing and cover a glitch or two in between.
export const EDGE_READINGS_KEPT = 8;

// A reading more than this far above both of its neighbours is a spike, not
// a heartbeat: roughly 5% of wrist-sensor readings are off by 20 BPM or more,
// and a real pulse does not move this far between two readings of a strap.
export const SPIKE_MARGIN_BPM = 20;

// One more reading at the end of the list, oldest first, keeping at most
// `keep` of them. A value the watchdog would not accept (outside 35-250 BPM:
// poor contact reports 0) or one with no usable time is not a reading of the
// pulse, and the list comes back as it was given. Otherwise it is a new
// list; the one passed in is never changed.
export function rememberEdgeReading(readings, at, bpm, keep = EDGE_READINGS_KEPT) {
    const list = Array.isArray(readings) ? readings : [];
    if (!Number.isFinite(at) || !isValidBpm(bpm)) return list;
    const limit = Math.max(2, Number.isFinite(keep) ? Math.floor(keep) : EDGE_READINGS_KEPT);
    const next = [...list, { at, bpm }];
    return next.length > limit ? next.slice(next.length - limit) : next;
}

// The longest gap, in ms, two readings may have between them and still be
// consecutive: the signal-loss timeout. The app bounds that timeout to 3-20 s
// and a value from anywhere else is held to the same bounds, so no caller can
// stretch a confirmation across a longer drop-out than the watchdog allows;
// one that is not a positive number is the watchdog's own default.
function consecutiveGapMs(maxGapMs) {
    if (!Number.isFinite(maxGapMs) || maxGapMs <= 0) return DEFAULT_WATCHDOG_SETTINGS.staleMs;
    return Math.min(MAX_STALE_SECONDS * 1000, Math.max(MIN_STALE_SECONDS * 1000, maxGapMs));
}

// Whether `later` followed `earlier` closely enough to be the next reading of
// the same pulse. A reading stamped before the one it follows - a wall clock
// set back between them - says nothing about how long the pulse stayed, so
// it is treated as a gap.
function follows(earlier, later, gapMs) {
    const gap = later.at - earlier.at;
    return gap >= 0 && gap <= gapMs;
}

// Is list[i] a spike? Only a reading with a neighbour after it can be judged:
// it must stand more than the margin above that one, and above the neighbour
// before it too, if it has one. A neighbour across a gap is no neighbour.
function isSpike(list, i, gapMs) {
    const reading = list[i];
    const after = list[i + 1];
    if (!after || !follows(reading, after, gapMs)) return false;
    if (reading.bpm - after.bpm <= SPIKE_MARGIN_BPM) return false;
    const before = list[i - 1];
    if (!before || !follows(before, reading, gapMs)) return true;
    return reading.bpm - before.bpm > SPIKE_MARGIN_BPM;
}

// The readings with every spike left out. Leaving one out makes the readings
// either side of it neighbours, and either of them may then stand out as a
// spike in its turn, so the pass steps back one reading after each removal.
// It ends where no reading is a spike, and that end does not depend on which
// spike went first: a reading next to a spike stands below it, so it was
// never a spike itself, and leaving one out never clears another. The newest
// reading is never judged here: it has no neighbour after it yet.
function withoutSpikes(readings, gapMs) {
    const kept = readings.slice();
    let i = 0;
    while (i < kept.length - 1) {
        if (isSpike(kept, i, gapMs)) {
            kept.splice(i, 1);
            i = Math.max(0, i - 1);
        } else {
            i += 1;
        }
    }
    return kept;
}

// The value the pulse holds on its last two consecutive readings - the lower
// of the two - or null when there are not two such readings: fewer than two
// usable ones once spikes are left out, a gap longer than the signal-loss
// timeout (or a clock set back) between the last two, or a current reading
// that leapt more than the margin above the one before it and may yet prove
// a spike. The list is read in the order the readings arrived, the last one
// being the current reading; entries that are not readings are skipped.
export function heldBpm(readings, { maxGapMs } = {}) {
    if (!Array.isArray(readings)) return null;
    const gapMs = consecutiveGapMs(maxGapMs);
    const usable = readings.filter((r) => r && Number.isFinite(r.at) && isValidBpm(r.bpm));
    const kept = withoutSpikes(usable, gapMs);
    if (kept.length < 2) return null;
    const previous = kept[kept.length - 2];
    const current = kept[kept.length - 1];
    if (!follows(previous, current, gapMs)) return null;
    if (current.bpm - previous.bpm > SPIKE_MARGIN_BPM) return null;
    return Math.min(previous.bpm, current.bpm);
}

// Is the current reading a confirmed edge? Only when it and the reading
// before it (spikes left out) both sit at or above the mark, with no signal
// loss between them. No mark is no edge.
export function isConfirmedEdge(readings, mark, { maxGapMs } = {}) {
    if (!Number.isFinite(mark)) return false;
    const held = heldBpm(readings, { maxGapMs });
    return held !== null && held >= mark;
}
