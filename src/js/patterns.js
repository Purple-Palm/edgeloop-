// Timed stroke and speed patterns for the tease modes.
//
// A pattern is a short loop of segments (fast, slow, short, long, stop).
// Heart rate chooses which loop is allowed and how strong the baseline is.
// Nothing here knows about the hardware envelope: every stroke number is a
// percent of the range the wearer already set, and placeStroke() can only
// shrink inside the window it was given.

export const RUIN_RIDE_SECONDS = 12;
export const RUIN_LOCK_SECONDS = 18;
export const GLANS_SECONDARY = 15;
export const RUIN_LOCK_SECONDARY = 18;
const MIN_WIDTH = 10;

const CLASSIC_LOOP = [
    { seconds: 5, speed: 1, depth: 1 },
    { seconds: 4, speed: 0.62, depth: 0.8 },
    { seconds: 5, speed: 0.88, depth: 1 }
];

const MILKER_LOOP = [
    { seconds: 3, speed: 0.55, depth: 0.42, secondary: 0.3 },
    { seconds: 3, speed: 1, depth: 0.36, secondary: 1 },
    { seconds: 2, speed: 0.34, depth: 0.48, secondary: 0.12 },
    { seconds: 3, speed: 0.8, depth: 0.5, secondary: 0.85 }
];

const HEAD_LOOP = [
    { seconds: 3, speed: 1, depth: 1 },
    { seconds: 3, speed: 0.7, depth: 1 }
];

const ULTIMATE_LOW = [
    { seconds: 6, speed: 0.8, depth: 1, secondary: 0.35 },
    { seconds: 4, speed: 0.62, depth: 0.85, secondary: 0.25 }
];

const ULTIMATE_MID = [
    { seconds: 4, speed: 0.48, depth: 1, secondary: 0.55 },
    { seconds: 4, speed: 1, depth: 0.38, secondary: 0.95 }
];

const ULTIMATE_NEAR = [
    { seconds: 2, speed: 0, depth: 0.34, secondary: 0.2 },
    { seconds: 3, speed: 1, depth: 0.32, secondary: 1 },
    { seconds: 2, speed: 0.12, depth: 0.4, secondary: 0.1 },
    { seconds: 3, speed: 0.55, depth: 0.62, secondary: 0.7 }
];

const RUIN_LOOP = [
    { seconds: 2, speed: 1, depth: 0.5, secondary: 0.7 },
    { seconds: 2, speed: 1, depth: 0.42, secondary: 0.85 },
    { seconds: 4, speed: 0.46, depth: 1, secondary: 0.4 }
];

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

export function segmentAt(seconds, segments) {
    const total = segments.reduce((sum, seg) => sum + seg.seconds, 0) || 1;
    let t = Number.isFinite(seconds) ? seconds % total : 0;
    if (t < 0) t += total;
    for (const seg of segments) {
        if (t < seg.seconds) return seg;
        t -= seg.seconds;
    }
    return segments[0];
}

// Shrink `depth` (1 = the whole window) inside [min, max]. The result stays
// inside that window. `align: 'high'` keeps the top (head play); the default
// keeps the bottom (a short stroke that does not reach the tip).
export function placeStroke(min, max, depth, align = 'low') {
    let lo = clamp(Math.round(min), 0, 100);
    let hi = clamp(Math.round(max), 0, 100);
    if (hi < lo) [lo, hi] = [hi, lo];
    const span = hi - lo;
    const wanted = span * clamp(depth, 0, 1);
    const width = span <= MIN_WIDTH ? span : Math.max(MIN_WIDTH, Math.min(span, wanted));
    if (align === 'high') {
        return { min: Math.max(lo, hi - width), max: hi };
    }
    return { min: lo, max: Math.min(hi, lo + width) };
}

// Session-start wake-up. Speed and stroke length ease in over the warm-up
// the wearer already set. Zero minutes means no ramp.
export function warmupShape(seconds, warmupMinutes) {
    const mins = Number(warmupMinutes);
    if (!Number.isFinite(mins) || mins <= 0) return { speed: 1, depth: 1 };
    const t = clamp((Number(seconds) || 0) / (mins * 60), 0, 1);
    const ease = t * t * (3 - 2 * t);
    return { speed: 0.16 + 0.84 * ease, depth: 0.28 + 0.72 * ease };
}

function roundPct(value) {
    return clamp(Math.round(value), 0, 100);
}

function atCeiling(crawlPercent) {
    return crawlPercent;
}

// Speeds and a stroke window, in percent of the wearer's travel envelope.
// `rawProgress` / `shapedProgress` may include the microphone boost (they
// only feed falling speeds and stroke contraction). `sensorRaw` is the
// measured pulse and is the only input to anything that rises.
export function teaseFrame({
    mode,
    rawProgress = 0,
    shapedProgress = 0,
    sensorRaw = 0,
    climbProgress = 0,
    atPeak = false,
    crawlPercent = 0,
    stallGuardEngaged = false,
    seconds = 0,
    ruinHoldSeconds = 0
}) {
    const raw = clamp(rawProgress, 0, 1);
    const shaped = clamp(shapedProgress, 0, 1);
    const sensor = clamp(sensorRaw, 0, 1);
    const climb = clamp(climbProgress, 0, 1);
    const beat = CLASSIC_LOOP.length ? segmentAt(seconds, CLASSIC_LOOP) : { speed: 1, depth: 1 };

    if (mode === 'shortener') {
        const tempo = segmentAt(seconds, HEAD_LOOP);
        const falling = (1 - raw * 0.5) * 100;
        const primary = atPeak ? atCeiling(crawlPercent) : roundPct(falling * tempo.speed);
        const top = Math.max(35, Math.round(100 - shaped * 65));
        const stroke = placeStroke(0, top, 1, 'low');
        return { primary, secondary: GLANS_SECONDARY, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    if (mode === 'headplay') {
        const tempo = segmentAt(seconds, HEAD_LOOP);
        const falling = (1 - raw) * 100;
        const primary = atPeak ? atCeiling(crawlPercent) : roundPct(falling * tempo.speed);
        const stroke = placeStroke(Math.round(raw * 75), 100, 1, 'high');
        return { primary, secondary: primary, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    if (mode === 'milker') {
        const milking = sensor >= 0.66;
        const seg = milking ? segmentAt(seconds, MILKER_LOOP) : beat;
        const basePrimary = (1 - shaped) * 100;
        const baseSecondary = 20 + climb * 80;
        const primary = atPeak
            ? atCeiling(crawlPercent)
            : roundPct(basePrimary * seg.speed);
        const secondary = milking
            ? roundPct((atPeak ? 100 : baseSecondary) * (seg.secondary ?? 1))
            : roundPct(baseSecondary);
        const stroke = placeStroke(0, 100, milking ? seg.depth : seg.depth, 'low');
        return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    if (mode === 'ultimate') {
        const chapter = sensor < 0.35 ? ULTIMATE_LOW : sensor < 0.72 ? ULTIMATE_MID : ULTIMATE_NEAR;
        const seg = segmentAt(seconds, chapter);
        const basePrimary = (1 - shaped) * 100;
        const baseSecondary = 20 + climb * 70;
        const primary = atPeak
            ? atCeiling(crawlPercent)
            : roundPct(basePrimary * seg.speed);
        const secondary = roundPct((atPeak ? 100 : baseSecondary) * seg.secondary);
        const stroke = placeStroke(0, 100, seg.depth, 'low');
        return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    if (mode === 'ruin') {
        if (ruinHoldSeconds > 0) {
            return { primary: 0, secondary: RUIN_LOCK_SECONDARY, strokeMin: 0, strokeMax: 100 };
        }
        const seg = segmentAt(seconds, RUIN_LOOP);
        const base = atPeak ? 74 : 48 + (1 - shaped) * 52;
        const secondaryBase = 28 + climb * 42;
        const stroke = placeStroke(0, 100, seg.depth, 'low');
        return {
            primary: roundPct(base * seg.speed),
            secondary: roundPct(secondaryBase * seg.secondary),
            strokeMin: stroke.min,
            strokeMax: stroke.max
        };
    }

    const falling = (1 - shaped) * 100;
    const primary = atPeak ? atCeiling(crawlPercent) : roundPct(falling * beat.speed);
    const stroke = placeStroke(0, 100, beat.depth, 'low');
    return { primary, secondary: primary, strokeMin: stroke.min, strokeMax: stroke.max };
}
