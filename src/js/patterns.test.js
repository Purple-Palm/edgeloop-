// The tease patterns, judged by what they hand the motors. Every speed here
// is a percent the drivers act on as it stands, and 0% is not a slow speed:
// The Handy's driver answers it with PUT /hamp/stop and the next moving tick
// with PUT /hamp/start, and the T-Code and Intiface planners park the sleeve.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { roundSpeed, MIN_MOVING_PERCENT, teaseFrame, motion, RUIN_LOCK_SECONDARY, combineWake, warmupShape } from './patterns.js';
import { TEASE_MODES, CRAWL_PERCENT } from './engine.js';

// One pattern frame on the way up the band, below the pullback mark. The
// progress terms are tied together the way the engine ties them (gamma 2).
function frameAt(mode, progress, seconds) {
    return teaseFrame({
        mode,
        rawProgress: progress,
        shapedProgress: progress * progress,
        sensorRaw: progress,
        climbProgress: progress * progress,
        atPeak: false,
        crawlPercent: CRAWL_PERCENT,
        seconds
    });
}

// From the resting rate to one step under the mark. At the mark itself the
// ceiling rule owns the primary, not the pattern.
const BAND = [0, 0.2, 0.4, 0.6, 0.72, 0.8, 0.88, 0.94, 0.97, 0.99];

describe('roundSpeed', () => {
    it('rounds to whole percent but never rounds a motion down to a stop', () => {
        assert.equal(MIN_MOVING_PERCENT, 1);
        for (const sliver of [0.0001, 0.05, 0.2, 0.49, 0.5, 1.49]) {
            assert.equal(roundSpeed(sliver), MIN_MOVING_PERCENT, `${sliver}% must crawl, not stop`);
        }
        assert.equal(roundSpeed(1.5), 2);
        assert.equal(roundSpeed(42.4), 42);
        assert.equal(roundSpeed(99.6), 100);
        assert.equal(roundSpeed(250), 100);
    });

    it('keeps a stop a stop, and reads anything that is not a speed as one', () => {
        assert.equal(roundSpeed(0), 0);
        assert.equal(roundSpeed(-0), 0);
        assert.equal(roundSpeed(-4), 0);
        for (const bad of [NaN, undefined, null, 'fast', Infinity, -Infinity]) {
            assert.equal(roundSpeed(bad), 0, `${String(bad)} must not move a motor`);
        }
    });
});

describe('the near-stop is a crawl, never a stop', () => {
    it('no tease mode hands on 0% anywhere below the pullback mark', () => {
        for (const mode of TEASE_MODES) {
            for (const progress of BAND) {
                for (let seconds = 0; seconds < 3600; seconds += 1) {
                    const frame = frameAt(mode, progress, seconds);
                    if (!(frame.primary >= MIN_MOVING_PERCENT) || !(frame.secondary >= MIN_MOVING_PERCENT)) {
                        assert.fail(`${mode} at ${progress} of the band, t=${seconds}: primary ${frame.primary}, secondary ${frame.secondary}`);
                    }
                }
            }
        }
    });

    it('still almost stops: near the mark the dip takes the pattern to a sliver of its speed', () => {
        // The owner's feature, kept: every so often two waves line up and the
        // stroker nearly stops. Since 1.1.1 that dip opens only in the last
        // stretch before the mark, above about 97% of the band - at rest the
        // pattern no longer dips at all - and takes the speed to 0.28 of
        // itself. At 139 BPM on a 70-140 band the speed left to take a share
        // of is a few percent, so in the frame the dip is the crawl; in the
        // pattern's own speed it is still a sliver of the weave around it.
        for (const mode of ['classic', 'milker', 'headplay', 'ultimate']) {
            const nearMark = [];
            for (let seconds = 0; seconds < 600; seconds += 1) nearMark.push(frameAt(mode, 69 / 70, seconds).primary);
            const sorted = [...nearMark].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            assert.ok(sorted[0] <= 3, `${mode} never nearly stops near the mark: slowest ${sorted[0]}%`);
            assert.ok(median >= 2, `${mode} near the mark should otherwise run above the dip: median ${median}%`);
        }
        for (const salt of [0.6, 1.4, 3.1, 9.2]) {
            const speeds = [];
            for (let seconds = 0; seconds < 600; seconds += 1) speeds.push(motion(seconds, salt, 69 / 70).speed);
            const sorted = [...speeds].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            assert.ok(sorted[0] < median * 0.3,
                `salt ${salt}: the dip should take the speed to a sliver of the weave, slowest ${sorted[0].toFixed(3)} against a median ${median.toFixed(3)}`);
        }
    });

    it('in the upper band the dip comes out as the crawl itself', () => {
        // 139 BPM on a 70-140 band, the last BPM before the mark: the pattern
        // speed is down to a few percent, and the two-wave dip takes it to
        // 0.28 of that, which 1.1.2 rounded to 0 about four times a minute
        // (about three in Ultimate). At 138 BPM the dip does not open yet.
        for (const mode of ['classic', 'milker', 'headplay', 'ultimate']) {
            const upper = [];
            for (let seconds = 0; seconds < 600; seconds += 1) upper.push(frameAt(mode, 69 / 70, seconds).primary);
            assert.equal(Math.min(...upper), MIN_MOVING_PERCENT, `${mode} upper band slowest ${Math.min(...upper)}%`);
            const crawling = upper.filter((speed) => speed === MIN_MOVING_PERCENT).length;
            assert.ok(crawling > 0 && crawling < upper.length, `${mode} should crawl only some of the time, crawled ${crawling}/600 s`);
        }
    });

    it('leaves the stops the pattern decides on at exactly 0', () => {
        for (const mode of TEASE_MODES.filter((m) => m !== 'ruin')) {
            for (const seconds of [0, 7, 19, 33, 101]) {
                const fullStop = teaseFrame({
                    mode, rawProgress: 1, shapedProgress: 1, sensorRaw: 1, climbProgress: 1,
                    atPeak: true, crawlPercent: 0, seconds
                });
                assert.equal(fullStop.primary, 0, `${mode} t=${seconds}: Full Stop at the ceiling must stop`);
                const crawl = teaseFrame({
                    mode, rawProgress: 1, shapedProgress: 1, sensorRaw: 1, climbProgress: 1,
                    atPeak: true, crawlPercent: CRAWL_PERCENT, seconds
                });
                assert.equal(crawl.primary, CRAWL_PERCENT, `${mode} t=${seconds}: Crawl at the ceiling is the crawl the wearer chose`);
            }
        }
        for (const seconds of [0, 7, 19]) {
            const lock = teaseFrame({
                mode: 'ruin', rawProgress: 1, shapedProgress: 1, sensorRaw: 1, climbProgress: 1,
                atPeak: true, crawlPercent: CRAWL_PERCENT, seconds, ruinHoldSeconds: 5
            });
            assert.equal(lock.primary, 0, 'the Ruin lock is a dead stop');
            assert.equal(lock.secondary, RUIN_LOCK_SECONDARY);
        }
    });
});

// The cool-down after an edge shares the warm-up's shape; the two are
// combined by the smaller factor.

// A small seeded generator, so a failing case can be re-run by number.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('combineWake', () => {
    const NONE = { speed: 1, depth: 1 };

    it('takes the smaller factor of each pair, so a second shape can only slow and shorten', () => {
        assert.deepEqual(combineWake({ speed: 0.5, depth: 0.9 }, { speed: 0.7, depth: 0.3 }), { speed: 0.5, depth: 0.3 });
        assert.deepEqual(combineWake({ speed: 0.16, depth: 0.28 }, NONE), { speed: 0.16, depth: 0.28 });
        assert.deepEqual(combineWake(NONE, NONE), NONE);
    });

    it('is the same shape whichever side the cool-down is on', () => {
        const rnd = mulberry32(7);
        for (let i = 0; i < 2000; i += 1) {
            const a = { speed: rnd(), depth: rnd() };
            const b = { speed: rnd(), depth: rnd() };
            assert.deepEqual(combineWake(a, b), combineWake(b, a));
        }
    });

    it('the neutral shape leaves the warm-up exactly as it was, at every second of every length', () => {
        // The engine hands this the warm-up and a cool-down that reads
        // { speed: 1, depth: 1 } whenever none is running. Anything but
        // bit-identity here would change every session that never uses the
        // cool-down, which the wearer was promised cannot happen.
        for (const minutes of [0, 1, 2, 3, 5, 10]) {
            for (let seconds = 0; seconds <= minutes * 60 + 5; seconds += 1) {
                const warm = warmupShape(seconds, minutes);
                assert.deepEqual(combineWake(warm, NONE), warm, `minutes ${minutes} second ${seconds}`);
                assert.deepEqual(combineWake(NONE, warm), warm, `minutes ${minutes} second ${seconds}`);
            }
        }
    });

    it('never returns a factor above either input', () => {
        const rnd = mulberry32(11);
        for (let i = 0; i < 5000; i += 1) {
            const a = warmupShape(rnd() * 400, [0, 1, 2, 3, 5][Math.floor(rnd() * 5)]);
            const b = warmupShape(rnd() * 400, [0, 1, 2, 3, 5][Math.floor(rnd() * 5)]);
            const out = combineWake(a, b);
            assert.ok(out.speed <= a.speed && out.speed <= b.speed, `speed ${out.speed} from ${a.speed} and ${b.speed}`);
            assert.ok(out.depth <= a.depth && out.depth <= b.depth, `depth ${out.depth} from ${a.depth} and ${b.depth}`);
            assert.ok(out.speed >= 0.16 && out.depth >= 0.28, 'a warm-up factor never drops below its own floor');
        }
    });

    it('a factor that is not a number is no instruction: the other shape stands', () => {
        // Neither a stop nor full speed may come out of a missing number. The
        // warm-up factor in force is the one thing a broken caller can get.
        const warm = { speed: 0.4, depth: 0.6 };
        assert.deepEqual(combineWake(warm, { speed: NaN, depth: NaN }), warm);
        assert.deepEqual(combineWake(warm, { speed: undefined, depth: '0.2' }), warm);
        assert.deepEqual(combineWake(warm, {}), warm);
        assert.deepEqual(combineWake(warm, null), warm);
        assert.deepEqual(combineWake(warm, undefined), warm);
        assert.deepEqual(combineWake(null, warm), warm);
        assert.deepEqual(combineWake(undefined, undefined), { speed: 1, depth: 1 });
        // A finite factor on one channel still counts when the other is junk.
        assert.deepEqual(combineWake(warm, { speed: 0.2, depth: NaN }), { speed: 0.2, depth: 0.6 });
    });
});
