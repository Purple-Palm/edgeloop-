// Stroke and speed patterns for the tease modes.
//
// Heart rate sets how hard the mode is allowed to push. Overlapping waves
// then move speed, length and the secondary channel so a steady pulse does
// not become a beat you can count.
// Nothing here knows about the hardware envelope: every stroke number is a
// percent of the range the wearer already set, and placeStroke() can only
// shrink inside the window it was given.

export const RUIN_RIDE_SECONDS = 12;
export const RUIN_LOCK_SECONDS = 18;
export const RUIN_LOCK_SECONDARY = 18;
const MIN_WIDTH = 10;

// Overlapping waves whose lengths do not divide into each other. A session
// never settles on one tempo you can count. `salt` gives each mode its own
// phase so two modes at the same second do not move together.
function wobble(seconds, period, phase) {
    const t = ((Number(seconds) || 0) + phase) / period;
    return 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
}

export function motion(seconds, salt = 0) {
    const a = wobble(seconds, 5.3, salt);
    const b = wobble(seconds, 8.7, salt + 2.2);
    const c = wobble(seconds, 13.1, salt + 5.5);
    const d = wobble(seconds, 19.4, salt + 1.1);
    // Two waves lining up is a brief stop. It does not land on a fixed beat.
    const pause = (a < 0.16 && b < 0.22) ? 0.04 : 1;
    const speed = (0.22 + 0.78 * (0.5 * a + 0.3 * b + 0.2 * c)) * pause;
    let depth = 0.34 + 0.66 * (0.55 * wobble(seconds, 7.1, salt + 4) + 0.45 * d);
    if (speed > 0.72) depth = Math.min(depth, 0.46);
    else if (speed < 0.38) depth = Math.max(depth, 0.78);
    const secondary = 0.12 + 0.88 * (
        0.4 * c + 0.35 * wobble(seconds, 6.4, salt + 8) + 0.25 * a
    );
    return {
        speed: clamp(speed, 0, 1),
        depth: clamp(depth, 0.28, 1),
        secondary: clamp(secondary, 0, 1)
    };
}

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
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
    if (mode === 'shortener') {
        const beat = motion(seconds, 1.4);
        const falling = (1 - raw * 0.5) * 100;
        const primary = atPeak ? atCeiling(crawlPercent) : roundPct(falling * beat.speed);
        const top = Math.max(35, Math.round(100 - shaped * 65));
        // At the ceiling the window is the base. On the way there the length
        // keeps changing inside that window.
        const stroke = placeStroke(0, top, atPeak ? 1 : beat.depth, 'low');
        const secondary = roundPct(6 + beat.secondary * 16);
        return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    if (mode === 'headplay') {
        const beat = motion(seconds, 3.1);
        const falling = (1 - raw) * 100;
        const primary = atPeak ? atCeiling(crawlPercent) : roundPct(falling * beat.speed);
        const stroke = placeStroke(Math.round(raw * 75), 100, atPeak ? 1 : beat.depth, 'high');
        const secondary = atPeak ? primary : roundPct(primary * (0.45 + 0.55 * beat.secondary));
        return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    if (mode === 'milker') {
        const milking = sensor >= 0.66;
        const beat = motion(seconds, milking ? 9.2 : 2.4);
        const basePrimary = (1 - shaped) * 100;
        const baseSecondary = 20 + climb * 80;
        const primary = atPeak
            ? atCeiling(crawlPercent)
            : roundPct(basePrimary * beat.speed);
        const secondaryGain = milking ? beat.secondary : (0.35 + 0.65 * beat.secondary);
        const secondary = roundPct((atPeak ? 100 : baseSecondary) * secondaryGain);
        const stroke = placeStroke(0, 100, beat.depth, 'low');
        return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    if (mode === 'ultimate') {
        const chapter = sensor < 0.35 ? 0 : sensor < 0.72 ? 1 : 2;
        const beat = motion(seconds, 4 + chapter * 3.7);
        const nearStop = chapter === 2 && wobble(seconds, 9.2, 1.7) < 0.34;
        const basePrimary = (1 - shaped) * 100;
        const baseSecondary = 20 + climb * 70;
        const primary = atPeak
            ? atCeiling(crawlPercent)
            : roundPct(basePrimary * (nearStop ? 0.06 : beat.speed));
        const secondary = roundPct((atPeak ? 100 : baseSecondary) * (nearStop ? beat.secondary * 0.35 : beat.secondary));
        const stroke = placeStroke(0, 100, nearStop ? Math.min(beat.depth, 0.4) : beat.depth, 'low');
        return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
    }

    if (mode === 'ruin') {
        if (ruinHoldSeconds > 0) {
            return { primary: 0, secondary: RUIN_LOCK_SECONDARY, strokeMin: 0, strokeMax: 100 };
        }
        const beat = motion(seconds, 6.6);
        const base = atPeak ? 74 : 48 + (1 - shaped) * 52;
        const secondaryBase = 28 + climb * 42;
        const stroke = placeStroke(0, 100, beat.depth, 'low');
        return {
            primary: roundPct(base * beat.speed),
            secondary: roundPct(secondaryBase * beat.secondary),
            strokeMin: stroke.min,
            strokeMax: stroke.max
        };
    }

    const beat = motion(seconds, 0.6);
    const falling = (1 - shaped) * 100;
    const primary = atPeak ? atCeiling(crawlPercent) : roundPct(falling * beat.speed);
    const secondary = atPeak ? primary : roundPct(primary * (0.5 + 0.5 * beat.secondary));
    const stroke = placeStroke(0, 100, atPeak ? 1 : beat.depth, 'low');
    return { primary, secondary, strokeMin: stroke.min, strokeMax: stroke.max };
}
