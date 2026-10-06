// Pure helpers for The Handy REST API v2 (HAMP mode). No fetch, no DOM, so
// everything here is unit-testable under node:test. handy.js does the I/O.
//
// The API described here is the official v2 OpenAPI spec, served at
// https://www.handyfeeling.com/api/handy-rest/v2/docs/spec.yaml.

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

// How far (in percent of travel) the driver keeps the commanded stroke away
// from the mechanical ends at 0 and 100.
//
// The Handy's firmware stops the slider when it decides the carriage is
// blocked (ERROR_SLIDER_BLOCKED / the slider_blocked event in API v3), and a
// carriage thrown into its own end stop looks exactly like a blocked one.
// Forum user X333 hit that lockout on a Handy 2 and worked around it by
// typing guards either side of 0 and 100 by hand.
//
// 5% is 5.5 mm on the 110 mm Handy 1 slider and 6.25 mm on the 125 mm Handy 2
// Pro, so it is never smaller than the 5 mm the firmware's own documented end
// zone (x_end_zone_size, API v3 SliderSettings) reserves for slowing down.
// There is no vendor statement of a safe margin, so this is the smallest
// number derived from a published vendor constant rather than invented. It is
// a default, not a law: the Handy panel takes 0-10 and 0 sends the range
// exactly as the engine asked for it.
export const HANDY_DEFAULT_END_MARGIN = 5;
export const HANDY_MAX_END_MARGIN = 10;

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

// Whether a number typed into one of the Handy panel's fields is finished:
// whole digits only, and already so large that one more digit could not
// still be a number the field accepts (`most` is the largest it takes). "8"
// on its way to "85" is not finished, and neither is "10" on its way to
// "100": the field cannot tell a number the wearer is still typing from one
// they meant, so neither may act as one. Anything else a number input can
// hold mid-edit - nothing, a sign, a decimal point, an exponent - is not
// finished either.
export function isFinishedNumber(raw, most) {
    const text = String(raw ?? '');
    return /^\d+$/.test(text) && Number(text) * 10 > most;
}

// What one keystroke in a Travel Envelope field may do while the wearer is
// still typing (the field's 'input' event). Returns the envelope to put in
// effect now, or null when the keystroke changes nothing yet.
//
// Every keystroke used to go through the normalisation a committed number
// gets, and that keeps a full stroke by moving the OTHER bound. Typing 85
// into an Upper Guard over a Lower Guard of 40 passed through "8": the
// envelope collapsed to 0-10, a running session sent PUT /slide 0-10 to the
// device, and the Lower Guard was rewritten to 0 for good, because the next
// keystroke only ever moved the Upper Guard back. Typing 45 into a Lower
// Guard of 40 passed through "4" and widened the stroke to 4-90.
//
// So a keystroke may only take travel away, and only exactly as typed: the
// number is finished, the other bound stays where it is and still leaves a
// full stroke, and the result sits inside the envelope in effect. Narrowing
// is the direction a wearer correcting a guard mid-session needs at once.
// Everything else - a number that could still grow, a wider envelope, a pair
// only the commit can reconcile - waits for Enter or for the wearer to leave
// the field, where normalizeEnvelope applies exactly as it always has.
//
// The number must also have been typed onto the end of `before`, the text
// the field held when the keystroke arrived. A number field keeps its caret
// to itself, and replacing the 7 of 75 on the way to 68 leaves a finished,
// narrower 65 in the field exactly as typing 6 and 5 does; so does pasting
// 65 over the whole number. Only the typing is known to be finished, so the
// other two wait for the commit, and so does anything whose `before` the
// caller cannot vouch for.
export function envelopeWhileTyping(current, changed, raw, { before, minGap = HANDY_MIN_SLIDE_GAP } = {}) {
    if (changed !== 'min' && changed !== 'max') return null;
    if (before === undefined || before === null) return null;
    const text = String(raw ?? '');
    const held = String(before);
    if (text.length <= held.length || !text.startsWith(held)) return null;
    const now = normalizeEnvelope(current ? current.min : 0, current ? current.max : 100, 'max', minGap);
    if (!isFinishedNumber(text, changed === 'min' ? 100 - minGap : 100)) return null;
    const typed = Number(text);
    const next = changed === 'min' ? { min: typed, max: now.max } : { min: now.min, max: typed };
    if (next.max > 100 || next.max - next.min < minGap) return null;
    if (next.min < now.min || next.max > now.max) return null;
    if (next.min === now.min && next.max === now.max) return null;
    return next;
}

// One event on a Travel Envelope field, as the page wires it: 'input' for a
// keystroke, 'change' for a commit (Enter, a spin-button or arrow-key step,
// leaving a field whose number changed) and 'blur' for leaving the field.
// `before` is the text the field held when the event arrived. Returns the
// envelope to put in effect, or null when the event changes nothing. A
// commit is normalised exactly as before: clamped to 0-100 and, where the
// typed number collides with the other bound, the other bound moves,
// because that number is the one the wearer chose to commit.
//
// 'blur' is there because 'change' is not a reliable end to an edit.
// Chromium fires none when the field ends up holding the number it had on
// focus, even though a keystroke in between took effect: typing 80 over 85
// narrows at once, typing 85 again waits, and leaving the field then fires
// nothing - the field would read 85 over an envelope of 80. Enter has the
// same gap, so the page hands Enter over as a 'change' itself (fieldEventOf
// in handy-fields.js, which also binds the fields).
export function envelopeFieldEvent(current, changed, raw, event, { before, minGap = HANDY_MIN_SLIDE_GAP } = {}) {
    if (changed !== 'min' && changed !== 'max') return null;
    if (event === 'input') return envelopeWhileTyping(current, changed, raw, { before, minGap });
    if (event !== 'change' && event !== 'blur') return null;
    const now = normalizeEnvelope(current ? current.min : 0, current ? current.max : 100, 'max', minGap);
    const typed = raw === '' || raw === null || raw === undefined ? null : raw;
    if (event === 'blur' && typed !== null && String(typed) === String(now[changed])) return null;
    return normalizeEnvelope(
        changed === 'min' && typed !== null ? typed : now.min,
        changed === 'max' && typed !== null ? typed : now.max,
        changed,
        minGap
    );
}

export function clampVelocity(velocity) {
    return clampPercent(velocity, 0);
}

// The slowest HAMP velocity EdgeLoop sends, and the one a pattern's
// near-stop goes out as. What the API says about the range, and what is
// known about the bottom of it:
//   - PUT /hamp/velocity takes a PercentValue, any number from 0 to 100 (the
//     v2 OpenAPI spec), and is refused unless HAMP is running (state MOVING).
//   - 0 is accepted and is not a stop: HAMP stays running and the slider
//     stands still (the v3 guide starts every /hamp/start "with an initial
//     velocity of 0"). EdgeLoop never sends it. A stop is always PUT
//     /hamp/stop, the one command the driver can verify.
//   - Anything above 0 moves, and no slower than the firmware's minimum
//     speed. The vendor gives a Handy 1 a range of 32-400 mm/s and says a
//     slower request is run at 32 (said of script playback; the v3 slider
//     settings name the same floor x_min_speed, "the minimum speed the
//     device will use"). 1% of the top is 4 mm/s, already under it.
//   - The vendor's own HAMP control steps in whole percent.
// So 1 is the smallest velocity that still moves, and it moves at the
// slowest speed the slider has: the crawl the pattern means by "almost
// stops".
export const HANDY_MIN_VELOCITY = 1;

// The Handy's velocity for one engine tick: the channel its role follows,
// scaled by the wearer's speed cap. The driver answers 0 with PUT /hamp/stop
// and the next moving tick with PUT /hamp/start, so 0 has to be a decision
// and never a rounding result: under any cap below 50% a 1% speed rounded
// to 0 (0.4 at a 40% cap), and the engine's crawl went out as a stop /
// start pair. A speed the engine wants moving leaves here at
// HANDY_MIN_VELOCITY or more; only a speed of 0, a cap of 0 or the role Off
// give 0. A cap that is not a number is doubt, and doubt ends in a stop, as
// it did before this lived in its own function.
export function handyTargetSpeed(role, primarySpeed, secondarySpeed, capPercent = 100) {
    const speed = role === 'primary' ? Number(primarySpeed)
        : role === 'secondary' ? Number(secondarySpeed)
        : 0;
    const cap = Number(capPercent ?? 100);
    if (!(speed > 0) || !(cap > 0)) return 0;
    const scaled = speed * (cap / 100);
    if (!Number.isFinite(scaled)) return 0;
    return Math.min(100, Math.max(HANDY_MIN_VELOCITY, Math.round(scaled)));
}

export function clampEndMargin(value, fallback = HANDY_DEFAULT_END_MARGIN) {
    const n = toInt(value, fallback);
    return Math.max(0, Math.min(HANDY_MAX_END_MARGIN, n));
}

// The End-Stop Margin under the same discipline as the envelope, as the page
// wires its field ('input', 'change', 'blur'). Returns the margin to put in
// effect, or null when the event changes nothing.
//
// A larger margin never lengthens a stroke or shrinks its distance from the
// end stops (applyEndMargin), so a keystroke that finishes a larger number
// takes effect at once. A smaller one moves the carriage back toward its end
// stops and waits for the commit: typing 10 over a margin of 5 used to pass
// through 1 and send strokes out to 1% and 99% of travel on the way.
export function endMarginFieldEvent(current, raw, event) {
    const now = clampEndMargin(current);
    if (event === 'input') {
        if (!isFinishedNumber(raw, HANDY_MAX_END_MARGIN)) return null;
        const typed = Number(raw);
        return typed > now && typed <= HANDY_MAX_END_MARGIN ? typed : null;
    }
    if (event !== 'change' && event !== 'blur') return null;
    const typed = raw === '' || raw === null || raw === undefined ? null : raw;
    if (event === 'blur' && typed !== null && String(typed) === String(now)) return null;
    return clampEndMargin(typed === null ? now : typed);
}

// The part of the wearer's travel envelope a stroke may use once the
// end-stop margin is kept: the envelope with everything closer than
// `margin` to the mechanical ends at 0 and 100 taken off.
//
// The envelope is normalised exactly as normalizeSlideRange normalises it,
// so the window always lies inside the envelope a zone was placed in. Each
// end gives up the margin only when the envelope is too narrow to lose it
// and still hold a `minGap` stroke - an envelope the wearer set barely
// wider than the minimum stroke, against an end - and then only as much of
// it as it has to. That is the one case where the margin yields, and the
// Handy panel's full-length readout shows by how much. How narrow the ZONE
// inside the envelope is never enters into it: a short stroke in a wide
// envelope has room to move off the end, so it is moved, not left on the
// end stop.
export function endMarginWindow(envMin = 0, envMax = 100, margin = HANDY_DEFAULT_END_MARGIN, minGap = HANDY_MIN_SLIDE_GAP) {
    const gap = Math.max(0, toInt(minGap, HANDY_MIN_SLIDE_GAP));
    const env = normalizeEnvelope(envMin, envMax, 'max', gap);
    const keep = Math.min(gap, env.max - env.min);
    const m = clampEndMargin(margin);
    let lo = Math.max(env.min, m);
    let hi = Math.min(env.max, 100 - m);
    if (hi - lo < keep) lo = Math.max(env.min, hi - keep);
    if (hi - lo < keep) hi = Math.min(env.max, lo + keep);
    return { min: lo, max: hi };
}

// Move a slide range off the mechanical ends at 0 and 100 by `margin`,
// inside the wearer's travel `envelope` ({ min, max }).
//
// The patterns pin short strokes to an end of the envelope. Near the
// pullback mark Glans Protector closes its stroke on the base and Head Play
// climbs to the tip, and the warm-up shortens a stroke from the bottom of
// the mode's window, down to the minimum stroke. A margin that could only
// cut a zone had to give way on every one of them rather than shrink it
// below the minimum, so a full 0-100 envelope sent {0,10} and {86,96}:
// strokes on the mechanical end stop the Handy 2 firmware locks itself out
// over, or inside the margin that is there to keep the carriage off it. The
// zone now keeps its length and slides inward into endMarginWindow()
// instead, and only a zone longer than that window is cut down to it.
//
// The result is ALWAYS inside the window, and the window inside the
// envelope, so the envelope still bounds everything that reaches the
// device. It never inverts, it is never longer than the range it was handed,
// and it is shorter only when the window itself is. Keeping the length is
// paid for at the far end: a zone inside its envelope that slides off one
// end reaches up to `margin` further toward the other, and never further.
// Without an envelope the range is its own, so the result is a subset of
// it: that is a full-length stroke, which is what the Handy panel shows.
// Margin 0 returns the range exactly as it came in.
export function applyEndMargin(range, margin = HANDY_DEFAULT_END_MARGIN, envelope = null, minGap = HANDY_MIN_SLIDE_GAP) {
    let lo = clampPercent(range ? range.min : 0, 0);
    let hi = clampPercent(range ? range.max : 100, 100);
    if (lo > hi) [lo, hi] = [hi, lo];
    const m = clampEndMargin(margin);
    if (m === 0) return { min: lo, max: hi };

    // Anything that does not name both bounds is no envelope at all. Read
    // as one, its missing bounds would default to full travel and could
    // slide a stroke out of the bounds the wearer set; the range itself
    // can only ever fail to move it.
    const named = envelope && typeof envelope === 'object' && envelope.min !== undefined && envelope.max !== undefined;
    const env = named ? envelope : { min: lo, max: hi };
    const win = endMarginWindow(env.min, env.max, m, minGap);
    const width = Math.min(hi - lo, win.max - win.min);
    const min = Math.min(Math.max(lo, win.min), win.max - width);
    return { min, max: min + width };
}

// PUT /slide answers with a SlideResult: ACCEPTED(0), ACCEPTED_ROUNDED_DOWN(1)
// or ACCEPTED_ROUNDED_UP(2). A 1 or a 2 is the only way the device ever tells
// us it did not take the numbers we sent (the spec names a MIN_ALLOWED stroke
// width but never gives its value). Returns a sentence, or null when the
// device took the range as sent.
export function describeSlideAdjustment(body, range = null) {
    if (!body || typeof body !== 'object') return null;
    const n = Number(body.result);
    if (n !== 1 && n !== 2) return null;
    const asked = range ? ` EdgeLoop asked for ${clampPercent(range.min, 0)}-${clampPercent(range.max, 100)}%.` : '';
    const dir = n === 1 ? 'rounded down' : 'rounded up';
    return `The Handy ${dir} the stroke range it was sent to one its own slider settings allow.${asked}`;
}

// True for the HAMP error band (3000-3999). API v2 has exactly one code in it,
// ERROR(3000) "Unspecified HAMP error", so a HAMP fault - including a slider
// the firmware has locked out - can only ever arrive as that.
export function isHampModeError(code) {
    const n = Number(code);
    return Number.isFinite(n) && n >= 3000 && n <= 3999;
}

// The wearer-facing sentence for a device that refused a motion command.
// Over API v2 we can never name slider_blocked outright - the whole HAMP
// error set is one unspecified code - so this says what the device does and
// which setting to change, and claims nothing more. EdgeLoop never concludes
// a lockout by itself: this explains a refusal the device sent us.
export function describeDeviceStop(cause = '') {
    const lead = cause ? `${String(cause).trim()} ` : '';
    return `${lead}The Handy's firmware stops the slider when it reads as blocked, which includes being driven hard into the ends of its travel. Check the sleeve and the rails for an obstruction, then narrow the Travel Envelope or raise the End-stop margin in the Handy panel.`;
}

// The banner line for a START or RESUME refused because The Handy did not
// answer that it is online. `answer` is what the driver's pollHandyConnected
// resolved: { state, reason, cause }. When the check took the link offline,
// the offline report is already on the banner above this line (it outranks
// this one and keeps its place), so this says what did not happen and what
// to do next rather than why all over again. What to do next depends on
// why the link went (`cause`): a device that said it is not connected
// needs checking, but when the API could not be reached for the third time
// in a row the device may be fine and it is the network that needs
// checking. "Check the device" there would send the wearer to a toy that
// was never the problem while the connection stayed down.
export function describeStartRefusal(answer, resuming = false) {
    const what = resuming ? 'resumed' : 'started';
    const press = resuming ? 'RESUME' : 'START';
    const state = answer && typeof answer === 'object' ? answer.state : null;
    const reason = answer && typeof answer.reason === 'string' ? answer.reason.trim() : '';
    if (state === 'offline' && answer.cause === 'api') {
        return `The session was not ${what}: The Handy API could not be reached, so the connection was dropped. Check the connection, then connect again in The Handy panel.`;
    }
    if (state === 'offline') {
        return `The session was not ${what}: The Handy is offline. Check the device, then connect it again in The Handy panel.`;
    }
    if (state === 'unreachable') {
        const detail = reason ? ` (${reason})` : '';
        return `The session was not ${what}: EdgeLoop could not reach The Handy API to check that the device is online${detail}. Check the connection and press ${press} again.`;
    }
    // No "press again" here: with the link gone, START may now be waiting
    // for a toy, and the report of why the link went is already above.
    if (state === 'lost') {
        return `The session was not ${what}: The Handy connection was lost while it was being checked.`;
    }
    if (state === 'stale') {
        return `The session was not ${what}: The Handy connection changed while it was being checked. Press ${press} again.`;
    }
    return `The session was not ${what}: The Handy could not be checked. Press ${press} again.`;
}

// Whether an API error says the command never reached the device. The v2
// spec's DEVICE_NOT_CONNECTED means the API found no device on the key's
// link and forwarded nothing, so the motor did not turn on this command.
// Every other failure leaves that open: its DEVICE_TIMEOUT is "a response
// from the device was not received within the maximum timeout", which is a
// command that may have been carried out, and an unspecified or server
// error says nothing either way. The spec's enum and its own examples
// disagree about which of 1001 and 1002 is which error, so the number is
// not trusted: the name has to say it, and the error's `connected` flag
// (which the schema requires on every error) has to agree.
export function isDeviceNotConnectedError(body) {
    const err = body && typeof body === 'object' ? body.error : null;
    if (!err || typeof err !== 'object') return false;
    const name = typeof err.name === 'string' ? err.name.replace(/[^a-z]/gi, '').toLowerCase() : '';
    return name === 'devicenotconnected' && err.connected === false;
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

// What a PUT /hamp/stop reply says about a Handy this page never connected:
// the stop a freshly opened page sends when an earlier one crashed, was
// force-quit or was killed by the phone while its session was driving the
// device (crash-recovery.js decides when, handy.js sends it). Read against
// the official v2 OpenAPI spec (spec.yaml, 2.0.0-beta-3):
//   * The API keeps no session. The key travels in the X-Connection-Key
//     header of every request, so nothing has to be connected first.
//   * HAMP operations exist only in HAMP mode, and HAMP motion only runs in
//     HAMP mode, so a device EdgeLoop left moving answers /hamp/stop with no
//     PUT /mode before it. Setting the mode first could only disturb a
//     device that another app has switched to a mode of its own since.
//   * The answer is a StateResult: 0 (SUCCESS_NEW_STATE) it was moving and
//     has stopped, 1 (SUCCESS_SAME_STATE) it was already stopped - "no
//     effect if the device is already stopped" - and -1 an error.
//   * For an offline device the server answers with an error object whose
//     `connected` is false ("Device not connected"). The spec numbers that
//     error 1001 in one place and 1002 in another, so the flag is read and
//     the number never is.
//   * A device in another mode answers METHOD_NOT_FOUND (2002), "No such
//     method": no HAMP motion is running on it.
export const RECOVERY_STOP = Object.freeze({
    STOPPED: 'stopped',
    ALREADY_STOPPED: 'already-stopped',
    NOT_HAMP: 'not-hamp',
    OFFLINE: 'offline',
    FAILED: 'failed',
    // Not a reply to this stop: Connect was pressed for the same key, and
    // its own verified stop (connectHandy) answered for the device instead.
    CONNECTED: 'connected',
    // Not a reply either: the key is this page's live link, whose driver
    // answers for the device from here on and has been told that it cannot
    // vouch for it being stopped (handy.js, stopHandyAfterCrash).
    LINKED: 'linked'
});

export const HANDY_METHOD_NOT_FOUND = 2002;

// The outcomes that settle it: the device is stopped, is not running HAMP
// motion at all, or is this page's own link, whose driver stops it itself.
// Every other outcome leaves it possibly still moving.
export function isRecoveryStopConclusive(outcome) {
    return outcome === RECOVERY_STOP.STOPPED
        || outcome === RECOVERY_STOP.ALREADY_STOPPED
        || outcome === RECOVERY_STOP.NOT_HAMP
        || outcome === RECOVERY_STOP.CONNECTED
        || outcome === RECOVERY_STOP.LINKED;
}

// `reply` is one exchange: { httpOk, status, body } when the API answered,
// { noReply: true, timedOut } when nothing came back. Returns { outcome,
// detail }; the detail is what the API said, in its own words where it gave
// any, so the wearer is told what the stop actually returned. The ok/fail
// line is classifyHandyResponse's, so a crash stop is "confirmed" by exactly
// the reply that confirms every other stop in the driver.
export function classifyRecoveryStop(reply) {
    const r = reply && typeof reply === 'object' ? reply : {};
    if (r.noReply) {
        return {
            outcome: RECOVERY_STOP.FAILED,
            detail: r.timedOut ? 'the request timed out' : 'the Handy API could not be reached'
        };
    }
    const body = r.body && typeof r.body === 'object' ? r.body : null;
    const verdict = classifyHandyResponse(r.httpOk, r.status, body);
    if (verdict.ok) {
        const result = body ? body.result : undefined;
        if (result === 1) return { outcome: RECOVERY_STOP.ALREADY_STOPPED, detail: 'result 1' };
        // Only a 0 says the device was moving until now. A reply with no
        // StateResult is still a confirmed stop, and claims nothing more.
        return { outcome: RECOVERY_STOP.STOPPED, detail: result === 0 ? 'result 0' : '' };
    }
    const err = body && body.error && typeof body.error === 'object' ? body.error : null;
    if (err && err.connected === false) return { outcome: RECOVERY_STOP.OFFLINE, detail: verdict.message };
    if (err && Number(err.code) === HANDY_METHOD_NOT_FOUND) {
        return { outcome: RECOVERY_STOP.NOT_HAMP, detail: `error ${HANDY_METHOD_NOT_FOUND}, ${verdict.message}` };
    }
    return { outcome: RECOVERY_STOP.FAILED, detail: verdict.message };
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
