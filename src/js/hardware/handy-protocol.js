// Pure helpers for The Handy REST API v2 (HAMP mode). No fetch, no DOM, so
// everything here is unit-testable under node:test. handy.js does the I/O.

export const HANDY_API_BASE = 'https://www.handyfeeling.com/api/handy/v2';

// PUT /mode body values, per the official v2 OpenAPI spec.
export const HANDY_MODE = Object.freeze({
    HAMP: 0,
    HSSP: 1,
    HDSP: 2,
    MAINTENANCE: 3,
    HBSP: 4
});

// PUT /mode result codes: -1 error, 0 mode changed, 1 mode already active.
export const HANDY_RESULT_ERROR = -1;

// The narrowest slide range the driver is allowed to send. Anything tighter
// jams the sleeve in place and gives the user no stroke at all.
export const HANDY_MIN_SLIDE_GAP = 10;

function toInt(value, fallback) {
    if (value === '' || value === null || value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(n);
}

export function clampPercent(value, fallback = 0) {
    const n = toInt(value, fallback);
    return Math.max(0, Math.min(100, n));
}

// Normalise a requested stroke range into a valid PUT /slide body.
// Values are clamped to 0-100 integers, ordered so min < max, and widened
// toward the hardware envelope until at least `minGap` percent of travel
// remains. The envelope itself is never exceeded unless it is narrower than
// the gap, in which case the range grows toward 0/100 as a last resort.
export function normalizeSlideRange(min, max, envMin = 0, envMax = 100, minGap = HANDY_MIN_SLIDE_GAP) {
    const env = normalizeEnvelope(envMin, envMax, 'max', minGap);
    let lo = clampPercent(min, env.min);
    let hi = clampPercent(max, env.max);
    if (lo > hi) [lo, hi] = [hi, lo];
    lo = Math.max(env.min, Math.min(env.max, lo));
    hi = Math.max(env.min, Math.min(env.max, hi));

    if (hi - lo < minGap) {
        // Prefer lengthening the stroke outward (toward the envelope max) so a
        // shallow "tip only" request still keeps the user inside the envelope.
        hi = Math.min(env.max, lo + minGap);
        if (hi - lo < minGap) lo = Math.max(env.min, hi - minGap);
        if (hi - lo < minGap) {
            hi = Math.min(100, lo + minGap);
            lo = Math.max(0, hi - minGap);
        }
    }
    return { min: lo, max: hi };
}

// Normalise the user-typed hardware envelope. `changed` names the bound the
// user just edited ('min' or 'max'); the OTHER bound is moved when the two
// collide, so the typed number is honoured wherever physically possible.
export function normalizeEnvelope(min, max, changed = 'max', minGap = HANDY_MIN_SLIDE_GAP) {
    let lo = clampPercent(min, 0);
    let hi = clampPercent(max, 100);
    if (hi - lo < minGap) {
        if (changed === 'min') {
            hi = Math.min(100, lo + minGap);
            if (hi - lo < minGap) lo = Math.max(0, hi - minGap);
        } else {
            lo = Math.max(0, hi - minGap);
            if (hi - lo < minGap) hi = Math.min(100, lo + minGap);
        }
    }
    return { min: lo, max: hi };
}

export function clampVelocity(velocity) {
    return clampPercent(velocity, 0);
}

// Classify one API reply. `body` is the parsed JSON (or null when the body was
// not JSON). Returns { ok, message, code }. Failure is any of: non-2xx HTTP
// status, a body carrying an `error` object, or `result === -1`.
export function classifyHandyResponse(httpOk, status, body, path = '') {
    const where = path ? ` (${path})` : '';
    if (body && typeof body === 'object' && body.error) {
        const err = body.error;
        const message = (typeof err === 'object' && err !== null)
            ? (err.message || err.name || `error code ${err.code ?? '?'}`)
            : String(err);
        const code = (typeof err === 'object' && err !== null) ? (err.code ?? null) : null;
        return { ok: false, message: `${message}${where}`, code };
    }
    if (!httpOk) {
        return { ok: false, message: `HTTP ${status || '?'}${where}`, code: status || null };
    }
    if (body && typeof body === 'object' && body.result === HANDY_RESULT_ERROR) {
        return { ok: false, message: `Device rejected command${where}`, code: HANDY_RESULT_ERROR };
    }
    return { ok: true, message: '', code: null };
}

// Pull a battery percentage out of a GET /info reply. The v2 spec has no
// battery endpoint, so any of these fields is best-effort. Returns null when
// nothing usable is present. Only fractional 0-1 values are scaled to percent.
export function parseBatteryLevel(info) {
    if (!info || typeof info !== 'object') return null;
    const raw = info.battery ?? info.batteryLevel ?? info.battery_level ?? info.level ?? null;
    if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    const scaled = (n > 0 && n <= 1 && !Number.isInteger(n)) ? n * 100 : n;
    return Math.max(0, Math.min(100, Math.round(scaled)));
}

// Build the human-readable "fw x.y, model" suffix for the status line.
export function describeHandyInfo(info) {
    if (!info || typeof info !== 'object') return '';
    const parts = [];
    const fw = info.fwVersion ?? info.firmwareVersion ?? info.firmware ?? null;
    const model = info.model ?? info.hwVersion ?? null;
    if (fw) parts.push(`fw ${fw}`);
    if (model) parts.push(String(model));
    return parts.join(', ');
}
