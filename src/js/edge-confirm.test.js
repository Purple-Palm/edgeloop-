import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_READINGS_KEPT, SPIKE_MARGIN_BPM, rememberEdgeReading, heldBpm, isConfirmedEdge } from './edge-confirm.js';
import { DEFAULT_WATCHDOG_SETTINGS, MIN_STALE_SECONDS, MAX_STALE_SECONDS } from './hr-watchdog.js';

const MARK = 140;
const TIMEOUT = DEFAULT_WATCHDOG_SETTINGS.staleMs;

// A strap's readings, one every `gapMs`, oldest first.
const series = (bpms, gapMs = 1000, from = 0) => bpms.map((bpm, i) => ({ at: from + i * gapMs, bpm }));

// The answer at every reading of a stream, asked the way the engine asks it:
// each reading remembered as it arrives, then the question with that reading
// last. `stream` is a list of BPM one `gapMs` apart, or of [at, bpm] pairs.
function answers(stream, { gapMs = 1000, mark = MARK, maxGapMs } = {}) {
    let readings = [];
    return stream.map((entry, i) => {
        const [at, bpm] = Array.isArray(entry) ? entry : [i * gapMs, entry];
        readings = rememberEdgeReading(readings, at, bpm);
        return isConfirmedEdge(readings, mark, { maxGapMs });
    });
}

// The indexes of the readings that confirmed an edge.
const confirmations = (stream, options) => answers(stream, options)
    .map((confirmed, i) => (confirmed ? i : -1))
    .filter((i) => i >= 0);

describe('rememberEdgeReading', () => {
    it('adds a reading at the end and keeps the last few, dropping the oldest', () => {
        let list = [];
        for (let i = 0; i < EDGE_READINGS_KEPT + 5; i += 1) list = rememberEdgeReading(list, i * 1000, 100 + i);
        assert.equal(list.length, EDGE_READINGS_KEPT);
        assert.deepEqual(list[list.length - 1], { at: (EDGE_READINGS_KEPT + 4) * 1000, bpm: 104 + EDGE_READINGS_KEPT });
        assert.equal(list[0].bpm, 105, 'the oldest go first');
        assert.ok(EDGE_READINGS_KEPT >= 3, 'the rule reads the reading before the current one and its own neighbour');
    });

    it('never changes the list it was given', () => {
        const before = series([120, 130]);
        const copy = JSON.parse(JSON.stringify(before));
        const after = rememberEdgeReading(before, 2000, 140);
        assert.deepEqual(before, copy);
        assert.notEqual(after, before);
        assert.equal(after.length, 3);
    });

    it('leaves out what the watchdog would not call a reading', () => {
        const base = series([120]);
        // Poor contact reports 0; the watchdog ignores anything under 35 or over 250.
        for (const bpm of [0, 34, 251, NaN, Infinity, -1, '140', null, undefined]) {
            assert.equal(rememberEdgeReading(base, 5000, bpm), base, `bpm ${String(bpm)} is not a reading`);
        }
        for (const at of [NaN, Infinity, undefined, null, '5000']) {
            assert.equal(rememberEdgeReading(base, at, 140), base, `a reading at ${String(at)} has no usable time`);
        }
        assert.equal(rememberEdgeReading(base, 5000, 35).length, 2, 'the ends of the valid band are readings');
        assert.equal(rememberEdgeReading(base, 5000, 250).length, 2);
    });

    it('starts a list from nothing, and keeps at least two whatever it is told', () => {
        assert.deepEqual(rememberEdgeReading(undefined, 1000, 130), [{ at: 1000, bpm: 130 }]);
        assert.deepEqual(rememberEdgeReading('junk', 1000, 130), [{ at: 1000, bpm: 130 }]);
        let list = [];
        for (let i = 0; i < 5; i += 1) list = rememberEdgeReading(list, i * 1000, 140, 0);
        assert.equal(list.length, 2);
        assert.equal(isConfirmedEdge(list, MARK), true);
    });
});

describe('heldBpm: the value held on the last two consecutive readings', () => {
    it('is the lower of the last two readings', () => {
        assert.equal(heldBpm(series([150, 141])), 141);
        assert.equal(heldBpm(series([141, 150])), 141);
        assert.equal(heldBpm(series([100, 120, 150, 141])), 141, 'only the last two decide');
    });

    it('needs two readings', () => {
        assert.equal(heldBpm([]), null);
        assert.equal(heldBpm(series([150])), null);
        assert.equal(heldBpm(undefined), null);
        assert.equal(heldBpm('junk'), null);
    });

    it('reads the readings in the order they arrived, the last being the current one', () => {
        assert.equal(heldBpm([{ at: 0, bpm: 150 }, { at: 1000, bpm: 150 }, { at: 2000, bpm: 110 }]), 110);
    });

    it('skips entries that are not readings', () => {
        const list = [{ at: 0, bpm: 145 }, { at: 500, bpm: 0 }, null, { at: 600, bpm: NaN }, { at: 1000, bpm: 147 }];
        assert.equal(heldBpm(list), 145);
    });

    it('is nothing across a gap longer than the signal-loss timeout', () => {
        assert.equal(heldBpm([{ at: 0, bpm: 150 }, { at: TIMEOUT, bpm: 150 }]), 150, 'a gap of exactly the timeout is still consecutive');
        assert.equal(heldBpm([{ at: 0, bpm: 150 }, { at: TIMEOUT + 1, bpm: 150 }]), null, 'one millisecond more is a lost pulse');
        assert.equal(heldBpm([{ at: 0, bpm: 150 }, { at: 12000, bpm: 150 }], { maxGapMs: 15000 }), 150, 'the timeout the wearer set is the limit');
        assert.equal(heldBpm([{ at: 0, bpm: 150 }, { at: 12000, bpm: 150 }], { maxGapMs: 10000 }), null);
    });

    it('holds any limit it is given to the timeouts the app allows', () => {
        const pair = (gap) => [{ at: 0, bpm: 150 }, { at: gap, bpm: 150 }];
        const longest = MAX_STALE_SECONDS * 1000;
        const shortest = MIN_STALE_SECONDS * 1000;
        assert.equal(heldBpm(pair(longest + 1), { maxGapMs: 10 * longest }), null, 'no caller stretches it past the longest timeout');
        assert.equal(heldBpm(pair(longest), { maxGapMs: 10 * longest }), 150);
        assert.equal(heldBpm(pair(shortest), { maxGapMs: 1 }), 150, 'nor shrinks it under the shortest');
        assert.equal(heldBpm(pair(shortest + 1), { maxGapMs: 1 }), null);
        for (const junk of [undefined, null, NaN, -5, 0, 'x', Infinity]) {
            assert.equal(heldBpm(pair(TIMEOUT), { maxGapMs: junk }), 150, `limit ${String(junk)} falls back to the default`);
            assert.equal(heldBpm(pair(TIMEOUT + 1), { maxGapMs: junk }), null, `limit ${String(junk)} falls back to the default`);
        }
    });

    it('is nothing when the clock was set back between the two', () => {
        assert.equal(heldBpm([{ at: 5000, bpm: 150 }, { at: 4000, bpm: 150 }]), null);
        assert.equal(heldBpm([{ at: 5000, bpm: 150 }, { at: 5000, bpm: 150 }]), 150, 'two readings in the same millisecond are still two');
    });
});

describe('isConfirmedEdge', () => {
    it('one reading at the mark is not an edge; a second one is, and on the mark counts', () => {
        assert.equal(isConfirmedEdge(series([130, 140]), MARK), false);
        assert.equal(isConfirmedEdge(series([140]), MARK), false);
        assert.equal(isConfirmedEdge(series([140, 140]), MARK), true);
        assert.equal(isConfirmedEdge(series([139, 140]), MARK), false);
        assert.equal(isConfirmedEdge(series([140, 139]), MARK), false, 'the current reading must be at the mark too');
    });

    it('a posture spike that touches the mark on one reading never counts', () => {
        // The report: sitting up raised the pulse about 10 BPM for about 10 s,
        // and one reading of it reached the mark.
        const bump = [128, 128, 130, 133, 136, 138, 140, 138, 135, 132, 130, 128, 128];
        assert.deepEqual(confirmations(bump), []);
        // The same bump held at the top for a second reading is an edge.
        assert.deepEqual(confirmations([128, 130, 133, 136, 138, 140, 141, 138, 135]), [6]);
    });

    it('a single-reading spike above both neighbours never counts, however high', () => {
        for (const neighbour of [100, 125, 135, 139]) {
            for (let margin = 1; neighbour + margin <= 250; margin += 1) {
                const stream = [neighbour, neighbour, neighbour + margin, neighbour, neighbour];
                assert.deepEqual(confirmations(stream), [], `${neighbour} ${neighbour + margin} ${neighbour}`);
            }
        }
    });

    it('a spike more than the margin above both neighbours never counts, not even as the second reading', () => {
        // The pair rule alone lets a glitch stand in for the second reading
        // of a pulse that touched the mark once: 141 and 170 are both on a
        // 140 mark, and the lower of them is 141.
        assert.deepEqual(confirmations([136, 138, 141, 170, 139, 135]), [], 'one reading on the mark and a glitch after it');
        assert.deepEqual(confirmations([136, 138, 170, 141, 139, 135]), [], 'a glitch before it');
        assert.deepEqual(confirmations([136, 138, 141, 141 + SPIKE_MARGIN_BPM + 1, 139]), [], 'one more than the margin');
        // A pulse that is on the mark either side of the glitch is held
        // there all the same, and counts on the reading after the glitch.
        assert.deepEqual(confirmations([136, 141, 175, 142, 143]), [3, 4]);
        // Within the margin a reading is a reading, and the pair rule reads
        // the lower of the two: on the mark, that is an edge.
        assert.deepEqual(confirmations([136, 138, 141, 141 + SPIKE_MARGIN_BPM, 139]), [3]);
        // The margin itself is the boundary on the far side too: 161 stands
        // exactly the margin above the 141 after it, so it is a reading and
        // holds the mark with it; 162 is one more, a spike, and holds nothing.
        assert.equal(SPIKE_MARGIN_BPM, 20);
        assert.deepEqual(confirmations([139, 161, 141]), [2]);
        assert.deepEqual(confirmations([139, 162, 141]), []);
        // And on the near side: on a relay reading every 5 s, 161 stands
        // exactly the margin above the 141 before it, so it is a reading even
        // though the 140 after it is more than the margin below, and it holds
        // the mark with that 140. Left out, it would leave 141 and 140 ten
        // seconds apart, past the signal-loss timeout.
        assert.deepEqual(confirmations([141, 161, 140], { gapMs: 5000 }), [1, 2]);
    });

    it('a spike on a spike never counts: once one is left out, its neighbours are judged against each other', () => {
        // One reading on the mark behind a glitch that climbed in two steps.
        // Leaving out the 185 makes 162 a reading more than the margin above
        // both of its neighbours, and it goes too.
        assert.deepEqual(confirmations([128, 130, 162, 185, 141, 139]), []);
        assert.deepEqual(confirmations([139, 165, 190, 141, 139]), []);
        // A pulse really on the mark after it is counted on its second reading.
        assert.deepEqual(confirmations([139, 165, 190, 141, 142]), [4]);
        // And the order the two were left out in does not matter.
        assert.deepEqual(confirmations([139, 190, 165, 141, 139]), []);
    });

    it('leaving a spike in the stream changes no answer, and a spike never confirms anything', () => {
        // Seeded streams that climb, fall, leap, pause and resume around the
        // mark, from a strap and from a slow relay, with glitches dropped in
        // between two readings - and before the first - each more than the
        // margin above both readings beside it. Every answer at a real
        // reading must be the answer of the same stream without them.
        let seed = 20260928;
        const random = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648;
        };
        let glitches = 0;
        let edges = 0;
        let refused = 0;
        const answersAt = (stream) => answers(stream.map((r) => [r.at, r.bpm]));
        for (let run = 0; run < 1500; run += 1) {
            const interval = random() < 0.7 ? 1000 : 5000;
            const clean = [];
            let bpm = 120 + Math.floor(random() * 30);
            let at = 0;
            for (let i = 0; i < 30; i += 1) {
                bpm += random() < 0.08 ? Math.floor(random() * 61) - 30 : Math.floor(random() * 9) - 4;
                bpm = Math.max(60, Math.min(225, bpm));
                at += random() < 0.05 ? TIMEOUT + 1 + Math.floor(random() * 5000) : interval + Math.floor(random() * 200) - 100;
                clean.push({ at, bpm });
            }
            const withGlitches = [];
            if (random() < 0.1) {
                withGlitches.push({ at: clean[0].at - 300, bpm: clean[0].bpm + SPIKE_MARGIN_BPM + 1 + Math.floor(random() * 20), glitch: true });
                glitches += 1;
            }
            clean.forEach((reading, i) => {
                withGlitches.push({ ...reading, glitch: false });
                const next = clean[i + 1];
                if (!next || random() >= 0.15) return;
                const top = Math.max(reading.bpm, next.bpm) + SPIKE_MARGIN_BPM + 1 + Math.floor(random() * 20);
                const glitchAt = reading.at + 1 + Math.floor((next.at - reading.at - 2) * random());
                withGlitches.push({ at: glitchAt, bpm: Math.min(250, top), glitch: true });
                glitches += 1;
            });
            const expected = answersAt(clean);
            let k = 0;
            answersAt(withGlitches).forEach((confirmed, i) => {
                if (withGlitches[i].glitch) {
                    assert.equal(confirmed, false, `run ${run}: a glitch confirmed an edge`);
                    return;
                }
                assert.equal(confirmed, expected[k], `run ${run} reading ${k}: the glitch changed the answer`);
                if (confirmed) edges += 1;
                else if (withGlitches[i].bpm >= MARK) refused += 1;
                k += 1;
            });
        }
        assert.ok(glitches > 5000, `the streams must carry glitches, had ${glitches}`);
        assert.ok(edges > 5000, `and the mark must be reached and held in them, was ${edges} times`);
        assert.ok(refused > 500, `and reached without being held, was ${refused} times`);
    });

    it('only a reading above BOTH of its neighbours is a spike: a fast fall is a reading', () => {
        // A relay reading every 5 s can fall more than the margin between two
        // readings. The reading before the fall is not a spike - it stands no
        // higher than the one before it - so it and the lower one after it
        // still hold the pulse on the mark between them.
        assert.deepEqual(confirmations([165, 166, 142], { gapMs: 5000 }), [1, 2]);
        assert.equal(heldBpm(series([165, 166, 142], 5000)), 142);
        // And the reading after a fall is judged like any other.
        assert.deepEqual(confirmations([150, 168, 169, 146, 145]), [1, 2, 3, 4]);
    });

    it('a reading that leaps more than the margin waits one reading to show it was not a spike', () => {
        // A pulse that leaps onto the mark is confirmed one reading later,
        // like any other: the leap is the first reading on the mark, and the
        // next one shows it was not a spike.
        assert.deepEqual(confirmations([118, 150, 152]), [2]);
        // The simulator's slider set in one step, then read again a second on.
        assert.deepEqual(confirmations([125, 150, 150]), [2]);
        // Only a second reading that leaps more than the margin above the
        // first waits for a third: a leap no real pulse makes between two
        // readings of a strap.
        assert.deepEqual(confirmations([138, 141, 141 + SPIKE_MARGIN_BPM + 4, 141 + SPIKE_MARGIN_BPM + 5]), [3]);
        assert.deepEqual(confirmations([138, 141, 141 + SPIKE_MARGIN_BPM, 141 + SPIKE_MARGIN_BPM + 1]), [2, 3], 'a leap of exactly the margin is a reading');
        // A strap that alternates (a glitch every other reading) is still
        // read: each glitch drops out.
        assert.deepEqual(confirmations([139, 145, 175, 145, 175, 145]), [3, 5]);
    });

    it('a reading with no neighbour before it is judged by the one after it: the first after a gap, or of all', () => {
        const gap = TIMEOUT + 3000;
        // The strap comes back from a drop-out on a glitch, then reads the
        // mark once: the glitch confirms nothing, and the edge waits for a
        // real second reading.
        assert.deepEqual(answers([[0, 141], [gap, 175], [gap + 1000, 141], [gap + 2000, 142]]), [false, false, false, true]);
        // The same at the very first readings a strap sends, while it settles.
        assert.deepEqual(answers([[0, 175], [1000, 141], [2000, 142]]), [false, false, true]);
        // A real first reading after a gap is a reading like any other.
        assert.deepEqual(answers([[0, 141], [gap, 146], [gap + 1000, 142]]), [false, false, true]);
        // And a leap just before a gap is judged by nothing across it.
        assert.deepEqual(answers([[0, 141], [1000, 175], [1000 + gap, 176], [2000 + gap, 177]]), [false, false, false, true]);
    });

    it('a sustained climb is confirmed on the second reading at the mark, and not later', () => {
        const climb = [120, 126, 131, 135, 138, 140, 142, 144, 145, 146];
        const first = climb.findIndex((bpm) => bpm >= MARK);
        const hits = confirmations(climb);
        assert.equal(hits[0], first + 1, 'one extra reading: about 1 s on a strap');
        assert.deepEqual(hits, climb.map((_, i) => i).filter((i) => i > first), 'and every held reading after it says so');
    });

    it('a relay app sending one reading every 5 s is confirmed on its second reading, 5 s on', () => {
        const hits = confirmations([125, 132, 140, 143, 145], { gapMs: 5000 });
        assert.equal(hits[0], 3);
        assert.ok(5000 <= TIMEOUT, 'a 5 s relay runs inside the default signal-loss timeout');
    });

    it('a 10 s relay needs the timeout it already needs to run: the gap is the watchdog\'s', () => {
        const readings = [125, 140, 142];
        assert.deepEqual(confirmations(readings, { gapMs: 10000 }), [], 'at the default 8 s timeout a 10 s gap is a lost pulse');
        assert.deepEqual(confirmations(readings, { gapMs: 10000, maxGapMs: 12000 }), [2], 'with 12 s it is the next reading');
    });

    it('a reading gap is not a confirmation: the edge waits for a second reading after it', () => {
        const back = 1000 + TIMEOUT + 2000;
        assert.deepEqual(
            answers([[0, 130], [1000, 141], [back, 142], [back + 1000, 142]]),
            [false, false, false, true],
            'the first reading after the gap confirms nothing, the second one does'
        );
    });

    it('no mark is no edge', () => {
        for (const mark of [NaN, undefined, null, 'abc', Infinity]) {
            assert.equal(isConfirmedEdge(series([200, 200]), mark), false, String(mark));
        }
    });
});
