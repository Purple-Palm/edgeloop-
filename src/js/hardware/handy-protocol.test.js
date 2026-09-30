import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    HANDY_MODE,
    HANDY_MIN_SLIDE_GAP,
    HANDY_DEFAULT_END_MARGIN,
    HANDY_MAX_END_MARGIN,
    clampPercent,
    clampVelocity,
    clampEndMargin,
    applyEndMargin,
    endMarginWindow,
    normalizeSlideRange,
    normalizeEnvelope,
    isFinishedNumber,
    envelopeWhileTyping,
    envelopeFieldEvent,
    endMarginFieldEvent,
    classifyHandyResponse,
    describeSlideAdjustment,
    isHampModeError,
    describeDeviceStop,
    describeStartRefusal,
    isDeviceNotConnectedError,
    parseBatteryLevel,
    describeHandyInfo,
    HANDY_MIN_VELOCITY,
    handyTargetSpeed
} from './handy-protocol.js';
import { fieldEventOf } from './handy-fields.js';

describe('handy mode constants', () => {
    it('matches the v2 spec numbering', () => {
        assert.equal(HANDY_MODE.HAMP, 0);
        assert.equal(HANDY_MODE.HSSP, 1);
        assert.equal(HANDY_MODE.HDSP, 2);
        assert.equal(HANDY_MODE.MAINTENANCE, 3);
        assert.equal(HANDY_MODE.HBSP, 4);
    });
});

describe('clampPercent / clampVelocity', () => {
    it('clamps and rounds to integer percent', () => {
        assert.equal(clampPercent(-5), 0);
        assert.equal(clampPercent(105), 100);
        assert.equal(clampPercent(42.6), 43);
        assert.equal(clampPercent('37'), 37);
    });
    it('falls back on garbage', () => {
        assert.equal(clampPercent('abc', 55), 55);
        assert.equal(clampPercent(undefined, 12), 12);
        assert.equal(clampVelocity(NaN), 0);
        assert.equal(clampVelocity(250), 100);
    });
});

describe('normalizeSlideRange', () => {
    it('passes a valid range through', () => {
        assert.deepEqual(normalizeSlideRange(20, 80), { min: 20, max: 80 });
    });
    it('clamps to 0-100 and orders min < max', () => {
        assert.deepEqual(normalizeSlideRange(-10, 130), { min: 0, max: 100 });
        assert.deepEqual(normalizeSlideRange(80, 20), { min: 20, max: 80 });
    });
    it('enforces the minimum gap by widening toward the envelope max', () => {
        assert.deepEqual(normalizeSlideRange(50, 50), { min: 50, max: 50 + HANDY_MIN_SLIDE_GAP });
        assert.deepEqual(normalizeSlideRange(30, 33, 0, 100), { min: 30, max: 40 });
    });
    it('widens downward when the envelope top is already reached', () => {
        assert.deepEqual(normalizeSlideRange(100, 100, 0, 100), { min: 90, max: 100 });
        assert.deepEqual(normalizeSlideRange(78, 80, 20, 80), { min: 70, max: 80 });
    });
    it('never leaves the hardware envelope', () => {
        assert.deepEqual(normalizeSlideRange(0, 100, 15, 85), { min: 15, max: 85 });
        assert.deepEqual(normalizeSlideRange(5, 10, 15, 85), { min: 15, max: 25 });
        assert.deepEqual(normalizeSlideRange(90, 99, 15, 85), { min: 75, max: 85 });
    });
    it('grows past a too-narrow envelope only as a last resort', () => {
        const out = normalizeSlideRange(50, 52, 50, 52);
        assert.ok(out.max - out.min >= HANDY_MIN_SLIDE_GAP);
        assert.ok(out.min >= 0 && out.max <= 100);
    });
    it('rounds fractional input to integers', () => {
        const out = normalizeSlideRange(10.4, 60.6);
        assert.deepEqual(out, { min: 10, max: 61 });
        assert.ok(Number.isInteger(out.min) && Number.isInteger(out.max));
    });
});

describe('normalizeEnvelope', () => {
    it('keeps a sane envelope untouched', () => {
        assert.deepEqual(normalizeEnvelope(15, 85), { min: 15, max: 85 });
    });
    it('clamps to 0-100', () => {
        assert.deepEqual(normalizeEnvelope(-20, 140), { min: 0, max: 100 });
    });
    it('moves max when min was edited into a collision', () => {
        assert.deepEqual(normalizeEnvelope(85, 80, 'min'), { min: 85, max: 95 });
        assert.deepEqual(normalizeEnvelope(60, 65, 'min'), { min: 60, max: 70 });
        // min 95 cannot hold a 10% stroke below 100, so min itself is pulled back.
        assert.deepEqual(normalizeEnvelope(95, 90, 'min'), { min: 90, max: 100 });
    });
    it('moves min when max was edited into a collision', () => {
        assert.deepEqual(normalizeEnvelope(60, 65, 'max'), { min: 55, max: 65 });
        assert.deepEqual(normalizeEnvelope(5, 5, 'max'), { min: 0, max: 10 });
    });
    it('falls back when the edited bound sits at the hard limit', () => {
        assert.deepEqual(normalizeEnvelope(100, 100, 'min'), { min: 90, max: 100 });
        assert.deepEqual(normalizeEnvelope(0, 0, 'max'), { min: 0, max: 10 });
    });
    it('uses defaults for empty input', () => {
        assert.deepEqual(normalizeEnvelope('', ''), { min: 0, max: 100 });
    });
});

// The page hands every event on a Travel Envelope field to envelopeFieldEvent,
// with the text the field held when the event arrived, and puts in effect
// whatever it returns. These replay what a wearer really does to the field,
// event by event, and keep what was in effect after each. The field starts
// out holding the bound in effect, as it does when it gains focus.
function replayEnvelope(current, changed, events, focusText = String(current[changed])) {
    let env = { ...current };
    let before = focusText;
    return events.map(([event, raw]) => {
        const next = envelopeFieldEvent(env, changed, raw, event, { before });
        if (next) env = next;
        // A commit repaints the field with the bound it put in effect.
        before = next && event !== 'input' ? String(next[changed]) : raw;
        return { event, raw, env: { ...env }, acted: next !== null };
    });
}

// The 'input' events of typing `text` into a field whose number is selected,
// so the first key replaces it: "85" is "8", then "85".
const typing = (text) => [...text].map((_, i) => ['input', text.slice(0, i + 1)]);

// Enter, as the page hands it to the field: its keydown, mapped by fieldEventOf
// (handy-fields.js).
const enter = (raw) => [fieldEventOf({ type: 'keydown', key: 'Enter', isComposing: false }), raw];

describe('isFinishedNumber', () => {
    it('is not finished while one more digit could still be a number the field takes', () => {
        // Upper Guard, 10-100: every single digit and "10" can still grow.
        for (let n = 0; n <= 10; n++) assert.equal(isFinishedNumber(String(n), 100), false, `${n} of an Upper Guard`);
        for (let n = 11; n <= 100; n++) assert.equal(isFinishedNumber(String(n), 100), true, `${n} of an Upper Guard`);
        // Lower Guard, 0-90: "9" can still become 90.
        for (let n = 0; n <= 9; n++) assert.equal(isFinishedNumber(String(n), 90), false, `${n} of a Lower Guard`);
        for (let n = 10; n <= 90; n++) assert.equal(isFinishedNumber(String(n), 90), true, `${n} of a Lower Guard`);
        // End-Stop Margin, 0-10: "1" can still become 10.
        assert.equal(isFinishedNumber('0', HANDY_MAX_END_MARGIN), false);
        assert.equal(isFinishedNumber('1', HANDY_MAX_END_MARGIN), false);
        for (let n = 2; n <= 10; n++) assert.equal(isFinishedNumber(String(n), HANDY_MAX_END_MARGIN), true, `margin ${n}`);
    });
    it('is never finished for anything but whole digits', () => {
        // What a number field can hold mid-edit, or hand back when it holds
        // nothing it can parse.
        for (const raw of ['', null, undefined, '85.5', '8.', '-5', '8e1', '1e2', '+50', '.5', ' 85', '85 ', 'abc']) {
            assert.equal(isFinishedNumber(raw, 100), false, JSON.stringify(raw));
        }
        // A leading zero changes nothing: "085" is 85, and 85 is finished.
        assert.equal(isFinishedNumber('085', 100), true);
        assert.equal(isFinishedNumber('05', 100), false);
    });
});

describe('typing into the Travel Envelope', () => {
    it('never collapses the stroke or rewrites the Lower Guard on the way to an Upper Guard', () => {
        // The reported sequence: 40-85, select the Upper Guard, type 8 then 5.
        // The first key used to put 0-10 in effect - sent to the device as
        // PUT /slide 0-10 mid-session - and the Lower Guard of 40 never came
        // back: the second key only moved the Upper Guard. Chromium fires no
        // 'change' when the field ends on the number it started with, so the
        // edit ends on 'blur'.
        const seen = replayEnvelope({ min: 40, max: 85 }, 'max', [...typing('85'), ['blur', '85']]);
        for (const step of seen) {
            assert.deepEqual(step.env, { min: 40, max: 85 }, `after ${step.event} "${step.raw}"`);
        }
        assert.ok(seen.every((step) => !step.acted), 'nothing had anything to put in effect');
    });

    it('never widens the stroke on the way to a narrower Lower Guard', () => {
        // Typing 45 over 40 passed through 4 and put 4-90 in effect.
        const seen = replayEnvelope({ min: 40, max: 90 }, 'min', typing('45'));
        assert.deepEqual(seen[0].env, { min: 40, max: 90 }, '"4" must not reach the device');
        // 45 narrows the envelope and is finished, so it takes effect on the
        // keystroke that finishes it.
        assert.deepEqual(seen[1].env, { min: 45, max: 90 });
    });

    it('lowers the Upper Guard the moment the number is finished', () => {
        // The wearer pulling the guard in mid-session wants it now, not on
        // Enter: a narrower envelope is the safe direction.
        const seen = replayEnvelope({ min: 40, max: 85 }, 'max', typing('70'));
        assert.deepEqual(seen.map((s) => s.env.max), [85, 70]);
        assert.ok(seen.every((s) => s.env.min === 40), 'the Lower Guard is never touched');
    });

    it('waits on a number that could still grow, even when it would narrow', () => {
        // "10" narrows 0-90 and is a legal pair on its own - but it is also
        // the way to 100, and a stroke collapsed to 0-10 is not what anyone
        // typing 100 asked for.
        const seen = replayEnvelope({ min: 0, max: 90 }, 'max', [...typing('100'), ['change', '100']]);
        assert.deepEqual(seen.map((s) => s.env.max), [90, 90, 90, 100]);
        // A Lower Guard of 60 over 5 passes through 6, which would narrow too.
        const lower = replayEnvelope({ min: 5, max: 100 }, 'min', typing('60'));
        assert.deepEqual(lower.map((s) => s.env.min), [5, 60]);
    });

    it('holds a wider envelope until Enter or leaving the field', () => {
        const seen = replayEnvelope({ min: 40, max: 85 }, 'max', [...typing('95'), ['change', '95']]);
        assert.deepEqual(seen.map((s) => s.env), [
            { min: 40, max: 85 },
            { min: 40, max: 85 },
            { min: 40, max: 95 }
        ]);
        const lower = replayEnvelope({ min: 40, max: 85 }, 'min', [...typing('25'), ['blur', '25']]);
        assert.deepEqual(lower.map((s) => s.env.min), [40, 40, 25]);
    });

    it('leaves a pair only the commit can reconcile to the commit, which reconciles it as before', () => {
        // 45 over a Lower Guard of 40 is not a full stroke as typed. While
        // typing nothing moves; committed, the typed number is honoured and
        // the other bound makes room, exactly as it always has.
        const seen = replayEnvelope({ min: 40, max: 85 }, 'max', [...typing('45'), ['change', '45']]);
        assert.deepEqual(seen.map((s) => s.env), [
            { min: 40, max: 85 },
            { min: 40, max: 85 },
            { min: 35, max: 45 }
        ]);
    });

    it('settles on leaving the field an edit no change event will report', () => {
        // 80 narrows at once; typing 85 again waits (it widens); the field
        // now holds the number it had on focus, so Chromium fires no 'change'
        // - measured - and only 'blur' can put 85 back in effect.
        const events = [...typing('80'), ...typing('85'), ['blur', '85']];
        const seen = replayEnvelope({ min: 40, max: 85 }, 'max', events);
        assert.deepEqual(seen.map((s) => s.env.max), [85, 80, 80, 80, 85]);
        // Enter has the same gap - measured: no 'change' follows it either -
        // and the panel promises a waiting number takes effect on Enter. The
        // page hands Enter over as the commit it is, and 85 is back in effect
        // with the field still focused.
        const pressed = replayEnvelope({ min: 40, max: 85 }, 'max', [...typing('80'), ...typing('85'), enter('85')]);
        assert.deepEqual(pressed.map((s) => s.env.max), [85, 80, 80, 80, 85]);
        assert.equal(pressed[4].acted, true, 'Enter put the number in effect');
        // Chromium's own 'change', when it does follow Enter, repeats the
        // commit and changes nothing more; so does leaving the field.
        const repeated = replayEnvelope({ min: 40, max: 85 }, 'max', [...typing('95'), enter('95'), ['change', '95'], ['blur', '95']]);
        assert.deepEqual(repeated.map((s) => s.env), [
            { min: 40, max: 85 }, { min: 40, max: 85 }, { min: 40, max: 95 }, { min: 40, max: 95 }, { min: 40, max: 95 }
        ]);
        assert.equal(repeated[4].acted, false, 'nothing left to settle on leaving');
        // Leaving a field that shows what is in effect does nothing at all.
        assert.equal(envelopeFieldEvent({ min: 40, max: 85 }, 'max', '85', 'blur'), null);
        assert.equal(envelopeFieldEvent({ min: 40, max: 85 }, 'min', '40', 'blur'), null);
        // Leaving an emptied field hands back what is in effect, to repaint it.
        assert.deepEqual(envelopeFieldEvent({ min: 40, max: 85 }, 'max', '', 'blur'), { min: 40, max: 85 });
        assert.deepEqual(envelopeFieldEvent({ min: 40, max: 85 }, 'max', '', 'change'), { min: 40, max: 85 });
    });

    it('commits exactly as the envelope always has', () => {
        // The commit path is untouched: whatever a committed number did
        // before, it still does, other bound and all.
        for (let lo = 0; lo <= 90; lo += 15) {
            for (let hi = lo + 10; hi <= 100; hi += 15) {
                for (const raw of ['0', '5', '8', '10', '45', '85', '95', '100', '150', '-5', '85.5', '']) {
                    for (const changed of ['min', 'max']) {
                        const typed = raw === '' ? null : raw;
                        const always = normalizeEnvelope(
                            changed === 'min' && typed !== null ? typed : lo,
                            changed === 'max' && typed !== null ? typed : hi,
                            changed
                        );
                        const now = envelopeFieldEvent({ min: lo, max: hi }, changed, raw, 'change');
                        assert.deepEqual(now, always, `${lo}-${hi} ${changed} "${raw}"`);
                    }
                }
            }
        }
    });

    it('waits on a narrower number that was not typed onto the end', () => {
        // Replacing the 7 of 75 on the way to 68 leaves a finished, narrower
        // 65 in the field for one keystroke - measured in Chromium: Home,
        // Shift+Right, 6 raises one 'input' holding "65". Taken as typed, 65
        // would reach the device, and 68, being wider than 65, would then
        // wait for the commit with the stroke held at 65 meanwhile.
        const inPlace = replayEnvelope({ min: 40, max: 75 }, 'max', [
            ['input', '65'], ['input', '68'], ['change', '68']
        ]);
        assert.deepEqual(inPlace.map((s) => s.env.max), [75, 75, 68]);
        // Pasting over the whole number is the same: one 'input', no typing.
        const pasted = replayEnvelope({ min: 40, max: 85 }, 'max', [['input', '70'], ['blur', '70']]);
        assert.deepEqual(pasted.map((s) => s.env.max), [85, 70]);
        // Backspacing a number the field does not take back to one it does
        // is not typing it either: 150 is refused, and 15 waits.
        const back = replayEnvelope({ min: 0, max: 90 }, 'max', [...typing('150'), ['input', '15']]);
        assert.equal(back[3].acted, false);
        // Typed onto the end of an emptied field, a finished number acts.
        const emptied = replayEnvelope({ min: 40, max: 85 }, 'max', [['input', ''], ...typing('70')]);
        assert.deepEqual(emptied.map((s) => s.env.max), [85, 85, 70]);
    });

    it('acts on no keystroke whose starting text is unknown', () => {
        // The page takes the field's text when it gains focus. Without it
        // nothing can show the number was typed, so the keystroke waits.
        assert.equal(envelopeFieldEvent({ min: 40, max: 85 }, 'max', '70', 'input'), null);
        assert.equal(envelopeWhileTyping({ min: 40, max: 85 }, 'max', '70', { before: null }), null);
        assert.deepEqual(envelopeWhileTyping({ min: 40, max: 85 }, 'max', '70', { before: '7' }), { min: 40, max: 70 });
    });

    it('never lets any keystroke move the other bound, widen, or act before the number is finished', () => {
        // Every digit string a field can hold on the way anywhere - typed
        // from the left, edited in the middle, backspaced - over every
        // envelope on a 5% grid. Each is offered as typed into an emptied
        // field, the one starting text every string can be typed onto.
        const texts = [];
        for (let n = 0; n <= 999; n++) {
            texts.push(String(n));
            if (n < 100) texts.push(String(n).padStart(2, '0'));
        }
        texts.push('', '85.5', '-5', '8e1', '1e2');
        let acted = 0;
        for (let lo = 0; lo <= 90; lo += 5) {
            for (let hi = lo + 10; hi <= 100; hi += 5) {
                for (const changed of ['min', 'max']) {
                    const other = changed === 'min' ? 'max' : 'min';
                    for (const raw of texts) {
                        const next = envelopeFieldEvent({ min: lo, max: hi }, changed, raw, 'input', { before: '' });
                        if (next === null) continue;
                        acted += 1;
                        const where = `${lo}-${hi} ${changed} "${raw}" -> ${next.min}-${next.max}`;
                        assert.equal(next[other], changed === 'min' ? hi : lo, `moved the other bound: ${where}`);
                        assert.ok(next.min >= lo && next.max <= hi, `widened: ${where}`);
                        assert.ok(next.max - next.min >= HANDY_MIN_SLIDE_GAP, `less than a full stroke: ${where}`);
                        assert.equal(next[changed], Number(raw), `not what was typed: ${where}`);
                        assert.ok(isFinishedNumber(raw, changed === 'min' ? 90 : 100), `acted before it was finished: ${where}`);
                    }
                }
            }
        }
        assert.ok(acted > 1000, 'the narrowing path must actually be exercised');
    });

    it('never lets a keystroke on the way to a number act on anything but that number', () => {
        // Typing from the left, every number either field accepts, over every
        // envelope on a 5% grid: no proper prefix ever takes effect, so the
        // only thing a keystroke can send is the finished number itself.
        for (let lo = 0; lo <= 90; lo += 5) {
            for (let hi = lo + 10; hi <= 100; hi += 5) {
                for (const [changed, first, last] of [['min', 0, 90], ['max', 10, 100]]) {
                    for (let target = first; target <= last; target++) {
                        const text = String(target);
                        const seen = replayEnvelope({ min: lo, max: hi }, changed, typing(text));
                        seen.slice(0, -1).forEach((step) => {
                            assert.equal(step.acted, false, `${lo}-${hi}: "${step.raw}" acted on the way to ${text}`);
                        });
                    }
                }
            }
        }
    });

    it('ignores an event or a bound it does not know', () => {
        assert.equal(envelopeFieldEvent({ min: 40, max: 85 }, 'max', '70', 'keyup', { before: '7' }), null);
        assert.equal(envelopeFieldEvent({ min: 40, max: 85 }, 'max', '70', 'keydown', { before: '7' }), null);
        assert.equal(envelopeFieldEvent({ min: 40, max: 85 }, 'max', '70', null, { before: '7' }), null);
        assert.equal(envelopeFieldEvent({ min: 40, max: 85 }, 'middle', '70', 'input', { before: '7' }), null);
        assert.equal(envelopeFieldEvent({ min: 40, max: 85 }, 'middle', '70', 'change'), null);
        assert.equal(envelopeWhileTyping({ min: 40, max: 85 }, undefined, '70', { before: '7' }), null);
        // A missing envelope reads as full travel rather than throwing.
        assert.deepEqual(envelopeWhileTyping(null, 'max', '70', { before: '7' }), { min: 0, max: 70 });
    });
});

describe('classifyHandyResponse', () => {
    it('accepts a plain 200 with a result code', () => {
        assert.deepEqual(classifyHandyResponse(true, 200, { result: 0 }), { ok: true, message: '', code: null });
        assert.equal(classifyHandyResponse(true, 200, { result: 1 }).ok, true);
        assert.equal(classifyHandyResponse(true, 200, { connected: true }).ok, true);
    });
    it('rejects a non-ok HTTP status', () => {
        const out = classifyHandyResponse(false, 401, null, '/connected');
        assert.equal(out.ok, false);
        assert.match(out.message, /HTTP 401/);
        assert.match(out.message, /\/connected/);
    });
    it('rejects an error object even with HTTP 200', () => {
        const out = classifyHandyResponse(true, 200, { error: { code: 1001, message: 'Invalid connection key' } }, '/mode');
        assert.equal(out.ok, false);
        assert.equal(out.code, 1001);
        assert.match(out.message, /Invalid connection key/);
    });
    it('rejects result -1', () => {
        const out = classifyHandyResponse(true, 200, { result: -1 });
        assert.equal(out.ok, false);
        assert.equal(out.code, -1);
    });
    it('handles a non-JSON body', () => {
        assert.equal(classifyHandyResponse(true, 200, null).ok, true);
        assert.equal(classifyHandyResponse(false, 502, null).ok, false);
    });
});

describe('parseBatteryLevel', () => {
    it('returns null when the field is absent', () => {
        assert.equal(parseBatteryLevel({}), null);
        assert.equal(parseBatteryLevel(null), null);
        assert.equal(parseBatteryLevel({ battery: 'n/a' }), null);
    });
    it('does not scale integer percentages', () => {
        assert.equal(parseBatteryLevel({ battery: 1 }), 1);
        assert.equal(parseBatteryLevel({ battery: 85 }), 85);
        assert.equal(parseBatteryLevel({ batteryLevel: 100 }), 100);
    });
    it('scales fractional 0-1 values', () => {
        assert.equal(parseBatteryLevel({ battery: 0.42 }), 42);
        assert.equal(parseBatteryLevel({ battery: 0.999 }), 100);
    });
    it('clamps out-of-range values', () => {
        assert.equal(parseBatteryLevel({ battery: 140 }), 100);
        assert.equal(parseBatteryLevel({ battery: -3 }), null);
    });
});

describe('describeHandyInfo', () => {
    it('formats firmware and model', () => {
        assert.equal(describeHandyInfo({ fwVersion: '3.2.3', model: 'Handy 1.1' }), 'fw 3.2.3, Handy 1.1');
        assert.equal(describeHandyInfo({ fwVersion: '3.2.3' }), 'fw 3.2.3');
        assert.equal(describeHandyInfo({ hwVersion: '1.1' }), '1.1');
        assert.equal(describeHandyInfo({}), '');
        assert.equal(describeHandyInfo(null), '');
    });
});

// X333, on the public build, after the range started reaching the device for
// the first time: "new version triggers the safety lockout on the handy 2
// (hitting too hard against the sides) as soon as warmup is over. i had to
// set guards around the 0 and 100%." The margin is that guard, applied by the
// driver so it reaches the people who never typed one.
describe('clampEndMargin', () => {
    it('keeps 0-10 whole percent', () => {
        assert.equal(clampEndMargin(0), 0);
        assert.equal(clampEndMargin(5), 5);
        assert.equal(clampEndMargin(10), 10);
        assert.equal(clampEndMargin('3'), 3);
        assert.equal(clampEndMargin(4.4), 4);
    });
    it('clamps out of range and falls back on garbage', () => {
        assert.equal(clampEndMargin(-5), 0);
        assert.equal(clampEndMargin(40), HANDY_MAX_END_MARGIN);
        assert.equal(clampEndMargin('abc'), HANDY_DEFAULT_END_MARGIN);
        assert.equal(clampEndMargin(undefined), HANDY_DEFAULT_END_MARGIN);
        assert.equal(clampEndMargin(null), HANDY_DEFAULT_END_MARGIN);
        // A corrupt stored value protects the wearer rather than disabling
        // the guard silently; only a typed 0 turns it off.
        assert.equal(clampEndMargin(NaN), HANDY_DEFAULT_END_MARGIN);
    });
});

// The window a stroke may use inside the wearer's envelope once the margin
// is kept. The envelope, never the zone, decides whether the margin yields.
describe('endMarginWindow', () => {
    it('takes the margin off each end of a full envelope', () => {
        assert.deepEqual(endMarginWindow(0, 100, 5), { min: 5, max: 95 });
        assert.deepEqual(endMarginWindow(0, 100, 10), { min: 10, max: 90 });
        assert.deepEqual(endMarginWindow(0, 100, 0), { min: 0, max: 100 });
        assert.deepEqual(endMarginWindow(0, 50, 5), { min: 5, max: 50 });
        assert.deepEqual(endMarginWindow(60, 100, 5), { min: 60, max: 95 });
    });
    it('leaves an envelope that already clears the ends alone', () => {
        for (let m = 0; m <= HANDY_MAX_END_MARGIN; m++) {
            assert.deepEqual(endMarginWindow(15, 85, m), { min: 15, max: 85 });
            assert.deepEqual(endMarginWindow(10, 90, m), { min: 10, max: 90 });
        }
    });
    it('yields only for an envelope too narrow to lose the margin, and only as far as it must', () => {
        // Exactly one minimum stroke wide against an end: nothing to give.
        assert.deepEqual(endMarginWindow(0, 10, 5), { min: 0, max: 10 });
        assert.deepEqual(endMarginWindow(90, 100, 5), { min: 90, max: 100 });
        assert.deepEqual(endMarginWindow(3, 13, 5), { min: 3, max: 13 });
        // Some room to spare: that much of the margin is kept.
        assert.deepEqual(endMarginWindow(0, 12, 5), { min: 2, max: 12 });
        assert.deepEqual(endMarginWindow(88, 100, 5), { min: 88, max: 98 });
        assert.deepEqual(endMarginWindow(0, 15, 10), { min: 5, max: 15 });
    });
    it('reads the envelope exactly as normalizeSlideRange does', () => {
        // The driver normalises the zone into the envelope first and moves
        // it inside this window second. Were the two to repair a typed pair
        // differently (an inverted or too-narrow one), the zone could be
        // moved straight out of the envelope it had just been placed in. At
        // margin 0 the window must be exactly what a full-length stroke is
        // normalised to, for every pair on the grid, repaired or not.
        for (let a = 0; a <= 100; a += 5) {
            for (let b = 0; b <= 100; b += 5) {
                assert.deepEqual(endMarginWindow(a, b, 0), normalizeSlideRange(0, 100, a, b), `envelope ${a}-${b}`);
            }
        }
        assert.deepEqual(endMarginWindow(-20, 140, 5), { min: 5, max: 95 });
        assert.deepEqual(endMarginWindow('', '', 5), { min: 5, max: 95 });
        assert.deepEqual(endMarginWindow(undefined, undefined, undefined), {
            min: HANDY_DEFAULT_END_MARGIN, max: 100 - HANDY_DEFAULT_END_MARGIN
        });
    });
});

describe('applyEndMargin', () => {
    // Without an envelope the range is its own envelope: a full-length
    // stroke, which has nowhere to slide to and is cut to the window.
    it('insets a full-travel stroke by the margin', () => {
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }, 5), { min: 5, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }, 3), { min: 3, max: 97 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }, 10), { min: 10, max: 90 });
    });
    it('leaves a range that already clears the ends exactly as it was', () => {
        // The property the report asks for: a wearer who already typed a
        // guard sees no change at all, at any margin up to the maximum.
        for (let m = 0; m <= HANDY_MAX_END_MARGIN; m++) {
            assert.deepEqual(applyEndMargin({ min: 15, max: 85 }, m), { min: 15, max: 85 });
            assert.deepEqual(applyEndMargin({ min: 15, max: 85 }, m, { min: 0, max: 100 }), { min: 15, max: 85 });
            assert.deepEqual(applyEndMargin({ min: 40, max: 50 }, m, { min: 0, max: 100 }), { min: 40, max: 50 });
        }
        assert.deepEqual(applyEndMargin({ min: 5, max: 95 }, 5), { min: 5, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 20, max: 80 }, 5), { min: 20, max: 80 });
    });
    it('cuts a full-length stroke only at the end that is against the stop', () => {
        assert.deepEqual(applyEndMargin({ min: 0, max: 90 }, 5), { min: 5, max: 90 });
        assert.deepEqual(applyEndMargin({ min: 10, max: 100 }, 5), { min: 10, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 35 }, 5), { min: 5, max: 35 });
        assert.deepEqual(applyEndMargin({ min: 75, max: 100 }, 5), { min: 75, max: 95 });
    });
    it('sends the range untouched at margin 0', () => {
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }, 0), { min: 0, max: 100 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 12 }, 0), { min: 0, max: 12 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 0, { min: 0, max: 100 }), { min: 0, max: 10 });
        assert.deepEqual(applyEndMargin({ min: 90, max: 100 }, 0, { min: 0, max: 100 }), { min: 90, max: 100 });
        // Margin 0 is the wearer switching the rule off, so it hands back
        // whatever it was given, exactly as before the rule existed. Keeping
        // the zone inside the envelope is normalizeSlideRange's job.
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 0, { min: 40, max: 60 }), { min: 0, max: 10 });
    });

    // On the wire before this change, default 0-100 envelope and 5% margin,
    // a pulse held at 139 BPM on a 70-140 band: Glans Protector's warm-up
    // sent {0,10}, {1,11} and {2,12}, Head Play {86,96}, {87,97} and {88,98},
    // while the Handy panel said a full-length stroke left as 5-95%. The
    // margin could only cut a zone, and gave way rather than cut one below
    // the minimum stroke, so every stroke shorter than the margin and a
    // minimum stroke together stayed in it, although the envelope had all
    // the room in the world for it to move off the end.
    it('moves a minimum-width stroke off the end stop inside a wide envelope', () => {
        const full = { min: 0, max: 100 };
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5, full), { min: 5, max: 15 });
        assert.deepEqual(applyEndMargin({ min: 86, max: 96 }, 5, full), { min: 85, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 89, max: 99 }, 5, full), { min: 85, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 90, max: 100 }, 5, full), { min: 85, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 90, max: 100 }, 10, full), { min: 80, max: 90 });
        assert.deepEqual(applyEndMargin({ min: 3, max: 13 }, 10, full), { min: 10, max: 20 });
    });
    it('keeps the stroke length and moves it only as far as the margin needs', () => {
        // A shorter stroke at the same HAMP velocity is a faster rhythm, so
        // the length the engine chose survives whenever the window holds it.
        const full = { min: 0, max: 100 };
        assert.deepEqual(applyEndMargin({ min: 0, max: 35 }, 5, full), { min: 5, max: 40 });
        assert.deepEqual(applyEndMargin({ min: 61, max: 100 }, 5, full), { min: 56, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 2, max: 50 }, 5, full), { min: 5, max: 53 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 90 }, 5, full), { min: 5, max: 95 });
        // The far end pays for the length, by the margin at most. Glans
        // Protector holds the bottom 35% of the range at the ceiling, and
        // The Handy is sent that stroke one margin higher: 5-40 at the
        // default, 10-45 at the widest, and 10-31 for the engine's 0-21
        // inside a 0-60 envelope. Head Play's ceiling stroke reaches one
        // margin lower. A wearer who needs the top of the stroke lower has
        // the envelope max to bring it down with; these are the numbers the
        // wearer has to be told.
        assert.deepEqual(applyEndMargin({ min: 0, max: 35 }, 10, full), { min: 10, max: 45 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 21 }, 10, { min: 0, max: 60 }), { min: 10, max: 31 });
        assert.deepEqual(applyEndMargin({ min: 75, max: 100 }, 5, full), { min: 70, max: 95 });
    });
    it('cuts a zone longer than the window down to the window', () => {
        const full = { min: 0, max: 100 };
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }, 5, full), { min: 5, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 95 }, 5, full), { min: 5, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 1, max: 100 }, 10, full), { min: 10, max: 90 });
    });
    it('moves a stroke only inside the envelope it is given', () => {
        // An envelope ending just past the minimum stroke keeps what margin
        // it can: the stroke must not be pushed out of the wearer's bounds.
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5, { min: 0, max: 12 }), { min: 2, max: 12 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5, { min: 0, max: 50 }), { min: 5, max: 15 });
        assert.deepEqual(applyEndMargin({ min: 90, max: 100 }, 5, { min: 60, max: 100 }), { min: 85, max: 95 });
        // A zone handed in outside its envelope still comes back inside it.
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5, { min: 40, max: 60 }), { min: 40, max: 50 });
    });
    it('yields only for the wearer\'s own too-narrow envelope', () => {
        // A minimum-width envelope against the bottom stop keeps its width:
        // the margin gives up rather than leave a jammed sleeve.
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5), { min: 0, max: 10 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5, { min: 0, max: 10 }), { min: 0, max: 10 });
        assert.deepEqual(applyEndMargin({ min: 90, max: 100 }, 10, { min: 90, max: 100 }), { min: 90, max: 100 });
        // An envelope with room to spare gives up only as much as it must.
        assert.deepEqual(applyEndMargin({ min: 0, max: 12 }, 5), { min: 2, max: 12 });
        // Already narrower than the minimum gap (a hand-narrowed envelope):
        // the width it had is the width it keeps.
        assert.deepEqual(applyEndMargin({ min: 96, max: 100 }, 5), { min: 96, max: 100 });
    });
    it('is a subset of a full-length stroke for every range and margin', () => {
        // With no envelope the range is its own, so the result can neither
        // leave it, invert, nor come back wider: the full-length readout in
        // the Handy panel rests on this.
        let checked = 0;
        for (let lo = 0; lo <= 100; lo += 1) {
            for (let hi = lo; hi <= 100; hi += 1) {
                for (let m = 0; m <= HANDY_MAX_END_MARGIN; m += 1) {
                    const out = applyEndMargin({ min: lo, max: hi }, m);
                    assert.ok(out.min >= lo && out.max <= hi, `escaped input ${lo}-${hi} margin ${m}: ${out.min}-${out.max}`);
                    assert.ok(out.max >= out.min, `inverted at ${lo}-${hi} margin ${m}`);
                    const keep = Math.min(HANDY_MIN_SLIDE_GAP, hi - lo);
                    assert.ok(out.max - out.min >= keep, `lost stroke at ${lo}-${hi} margin ${m}: ${out.min}-${out.max}`);
                    checked += 1;
                }
            }
        }
        assert.ok(checked > 50000);
    });
    it('survives a hand-edited or missing range', () => {
        assert.deepEqual(applyEndMargin({ min: 80, max: 20 }, 5), { min: 20, max: 80 });
        assert.deepEqual(applyEndMargin({ min: -10, max: 140 }, 5), { min: 5, max: 95 });
        assert.deepEqual(applyEndMargin(null, 5), { min: 5, max: 95 });
        assert.deepEqual(applyEndMargin({}, 0), { min: 0, max: 100 });
    });
    it('never takes a stray value for a wider envelope', () => {
        // Garbage bounds read the way normalizeSlideRange reads them...
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5, { min: 'x', max: null }), { min: 5, max: 15 });
        // ...but something that is not an envelope at all (the third
        // argument used to be the minimum gap) leaves the range as its own
        // envelope. Read as 0-100 it could push a stroke out of the bounds
        // the wearer set; read as the range it can only fail to move it.
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5, 10), { min: 0, max: 10 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 30 }, 5, 'wide'), { min: 5, max: 30 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5, {}), { min: 0, max: 10 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5, [0, 100]), { min: 0, max: 10 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5, { min: 0 }), { min: 0, max: 10 });
    });
    it('defaults to the shipped margin', () => {
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }), { min: HANDY_DEFAULT_END_MARGIN, max: 100 - HANDY_DEFAULT_END_MARGIN });
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, undefined, { min: 0, max: 100 }), {
            min: HANDY_DEFAULT_END_MARGIN, max: HANDY_DEFAULT_END_MARGIN + 10
        });
    });
});

// What dispatchHandy puts in PUT /slide on a tick: the engine's zone
// normalised into the wearer's envelope, then moved off the mechanical ends
// inside that same envelope. handy.test.js holds the driver to this.
function slideSent(zoneMin, zoneMax, envMin, envMax, margin) {
    return applyEndMargin(normalizeSlideRange(zoneMin, zoneMax, envMin, envMax), margin, { min: envMin, max: envMax });
}

describe('the stroke range The Handy is sent', () => {
    // Every whole-percent zone the engine can command, on every envelope a
    // 5-point grid can type - inverted and too-narrow pairs included, since
    // the driver repairs those itself - at every margin the panel accepts.
    // The expected placement is written out here case by case rather than
    // with the formula the module uses, so the two can only agree by being
    // right: a zone that fits the window keeps its length and moves inward
    // just far enough to clear the end it reached into, and only a zone
    // longer than the window is cut down to it. Either way no end of it is
    // sent more than the margin past where no margin sends it - the zone
    // after normalizeSlideRange, which has already lengthened anything
    // shorter than the minimum stroke.
    it('keeps every zone off the ends wherever the envelope leaves room', () => {
        const GAP = HANDY_MIN_SLIDE_GAP;
        const failures = [];
        // 25 million cases: the message is only built for one that fails.
        const fail = (what, lo, hi, a, b, m, out) => {
            if (failures.length < 25) failures.push(`${what}: zone ${lo}-${hi}, envelope ${a}-${b}, margin ${m} sent ${out.min}-${out.max}`);
        };
        let checked = 0;
        let slid = 0;
        let cut = 0;
        let yielded = 0;
        for (let a = 0; a <= 100; a += 5) {
            for (let b = 0; b <= 100; b += 5) {
                const typed = { min: a, max: b };
                // The envelope the driver really works in for this pair.
                const env = normalizeEnvelope(a, b);
                for (let lo = 0; lo <= 100; lo++) {
                    for (let hi = lo; hi <= 100; hi++) {
                        // Exactly what reached the device before the margin
                        // existed, and what margin 0 must still send.
                        const zone = normalizeSlideRange(lo, hi, a, b);
                        const length = zone.max - zone.min;
                        for (let m = 0; m <= HANDY_MAX_END_MARGIN; m++) {
                            // slideSent(lo, hi, a, b, m), with the half that
                            // does not depend on the margin lifted out.
                            const out = applyEndMargin(zone, m, typed);
                            checked += 1;
                            if (!Number.isInteger(out.min) || !Number.isInteger(out.max)) fail('not whole percent', lo, hi, a, b, m, out);
                            if (out.min < env.min || out.max > env.max) fail('outside the envelope', lo, hi, a, b, m, out);
                            if (out.max - out.min < GAP) fail('shorter than the minimum stroke, or inverted', lo, hi, a, b, m, out);
                            if (m === 0) {
                                if (out.min !== zone.min || out.max !== zone.max) fail('changed at margin 0', lo, hi, a, b, m, out);
                                continue;
                            }
                            // Room for the margin at both ends and a minimum
                            // stroke between them: then nothing may land in it.
                            const roomy = Math.min(env.max, 100 - m) - Math.max(env.min, m) >= GAP;
                            if (roomy && (out.min < m || out.max > 100 - m)) fail('inside the margin', lo, hi, a, b, m, out);
                            if (!roomy) yielded += 1;
                            // Keeping the length is paid for at the far end,
                            // and the price is bounded: neither end is ever
                            // sent more than the margin past where the
                            // normalised zone had it, whether the zone slid
                            // whole or was cut to its window. Glans Protector's
                            // ceiling stroke reaching one margin higher, and
                            // no higher, rests on this.
                            if (out.min < zone.min - m || out.max > zone.max + m) fail('moved past the zone by more than the margin', lo, hi, a, b, m, out);
                            // Without that room each end gives up only what a
                            // minimum stroke inside the envelope needs.
                            const winMin = Math.max(env.min, Math.min(m, env.max - GAP));
                            const winMax = Math.min(env.max, Math.max(100 - m, env.min + GAP));
                            let wantMin = zone.min;
                            let wantMax = zone.max;
                            if (length > winMax - winMin) {
                                wantMin = winMin;
                                wantMax = winMax;
                                cut += 1;
                            } else if (zone.min < winMin) {
                                wantMin = winMin;
                                wantMax = winMin + length;
                                slid += 1;
                            } else if (zone.max > winMax) {
                                wantMin = winMax - length;
                                wantMax = winMax;
                                slid += 1;
                            }
                            if (out.min !== wantMin || out.max !== wantMax) fail(`expected ${wantMin}-${wantMax}`, lo, hi, a, b, m, out);
                        }
                    }
                }
            }
        }
        assert.deepEqual(failures, []);
        // The grid really was walked, and it really reached every path:
        // zones slid off an end whole, zones cut to their window, and
        // envelopes too narrow for the margin to be kept in full.
        assert.equal(checked, 21 * 21 * 5151 * (HANDY_MAX_END_MARGIN + 1));
        assert.ok(slid > 150000, `only ${slid} zones slid off an end`);
        assert.ok(cut > 100000, `only ${cut} zones were longer than their window`);
        assert.ok(yielded > 1000000, `only ${yielded} cases had an envelope too narrow for the margin`);
    });

    it('never lengthens a stroke or shrinks its distance from the end stops for a larger margin', () => {
        // What lets a keystroke that RAISES the margin take effect at once
        // (endMarginFieldEvent). A larger margin moves a stroke further in
        // rather than only cutting it, so what it sends is not always inside
        // what a smaller one sent - Glans Protector's ceiling stroke leaves
        // as 5-40 at 5 and 10-45 at 10 - but it is never longer, and the gap
        // between it and the nearer end stop never shrinks. Every envelope
        // pair a 5-point grid can type, every zone on a 2-point grid, each
        // margin against the one below it.
        const nearest = (r) => Math.min(r.min, 100 - r.max);
        const failures = [];
        let checked = 0;
        let moved = 0;
        for (let a = 0; a <= 100; a += 5) {
            for (let b = 0; b <= 100; b += 5) {
                const typed = { min: a, max: b };
                for (let lo = 0; lo <= 100; lo += 2) {
                    for (let hi = lo; hi <= 100; hi += 2) {
                        // slideSent(lo, hi, a, b, m) for each margin, with the
                        // half that does not depend on the margin lifted out.
                        const zone = normalizeSlideRange(lo, hi, a, b);
                        let prev = applyEndMargin(zone, 0, typed);
                        for (let m = 1; m <= HANDY_MAX_END_MARGIN; m++) {
                            const out = applyEndMargin(zone, m, typed);
                            checked += 1;
                            if (out.max - out.min > prev.max - prev.min || nearest(out) < nearest(prev)) {
                                if (failures.length < 25) failures.push(`zone ${lo}-${hi}, envelope ${a}-${b}: margin ${m} sent ${out.min}-${out.max} after ${prev.min}-${prev.max}`);
                            }
                            if (out.min < prev.min || out.max > prev.max) moved += 1;
                            prev = out;
                        }
                    }
                }
            }
        }
        assert.deepEqual(failures, []);
        assert.equal(checked, 21 * 21 * 1326 * HANDY_MAX_END_MARGIN);
        // The strokes really did move rather than only shrink, or this would
        // prove nothing the old subset rule did not.
        assert.ok(moved > 40000, `only ${moved} strokes moved`);
        // And the panel's full-length stroke is still only ever cut.
        for (let lo = 0; lo <= 100; lo += 1) {
            for (let hi = lo; hi <= 100; hi += 1) {
                let prev = applyEndMargin({ min: lo, max: hi }, 0);
                for (let m = 1; m <= HANDY_MAX_END_MARGIN; m += 1) {
                    const out = applyEndMargin({ min: lo, max: hi }, m);
                    assert.ok(out.min >= prev.min && out.max <= prev.max, `${lo}-${hi}: margin ${m} shows ${out.min}-${out.max}, wider than ${prev.min}-${prev.max}`);
                    prev = out;
                }
            }
        }
    });

    it('matches what the Handy panel says a full-length stroke is sent as', () => {
        // The panel reads applyEndMargin(envelope, margin) with no envelope
        // argument; the driver sends a full-length stroke through the whole
        // pipeline. Every envelope the inputs can hold, every margin.
        for (let a = 0; a <= 100; a++) {
            for (let b = 0; b <= 100; b++) {
                const env = normalizeEnvelope(a, b);
                for (let m = 0; m <= HANDY_MAX_END_MARGIN; m++) {
                    const shown = applyEndMargin({ min: env.min, max: env.max }, m);
                    assert.deepEqual(slideSent(env.min, env.max, env.min, env.max, m), shown, `envelope ${a}-${b} margin ${m}`);
                    assert.deepEqual(endMarginWindow(env.min, env.max, m), shown, `envelope ${a}-${b} margin ${m}`);
                }
            }
        }
    });

    // What the Handy panel and README.md say about a stroke shorter than the
    // minimum. The engine's shortest zone is a tenth of the wearer's
    // envelope, so once the envelope is narrowed it asks for less than the
    // 10% of travel The Handy is always sent: in a 0-40 envelope Glans
    // Protector's warm-up at 139 BPM asks for 0-4, and the cockpit's Zone
    // badge says so. That stroke is lengthened to a whole minimum stroke
    // first, margin or not, and only then moved off the end. Measured
    // against no margin, neither end moves by more than the margin;
    // measured against the zone the engine asked for, the far end can land
    // further than that - 0-4 leaves as 5-15 - so a sentence that promised
    // "up to the margin further than the mode asked" was false in a
    // narrowed envelope against an end, and the panel measures from no
    // margin instead.
    it('lengthens a stroke shorter than the minimum first, then moves it at most one margin', () => {
        assert.deepEqual(slideSent(0, 4, 0, 40, 0), { min: 0, max: 10 });
        assert.deepEqual(slideSent(0, 4, 0, 40, 5), { min: 5, max: 15 });
        assert.deepEqual(slideSent(0, 5, 0, 50, 5), { min: 5, max: 15 });
        assert.deepEqual(slideSent(0, 6, 0, 60, 10), { min: 10, max: 20 });
        assert.deepEqual(slideSent(94, 99, 50, 100, 0), { min: 90, max: 100 });
        assert.deepEqual(slideSent(94, 99, 50, 100, 5), { min: 85, max: 95 });
        // Every zone shorter than the minimum, on every envelope a 5-point
        // grid can type, at every margin the panel accepts.
        const failures = [];
        const fail = (what, lo, hi, a, b, m, out) => {
            if (failures.length < 25) failures.push(`${what}: zone ${lo}-${hi}, envelope ${a}-${b}, margin ${m} sent ${out.min}-${out.max}`);
        };
        let checked = 0;
        let pastAsked = 0;
        for (let a = 0; a <= 100; a += 5) {
            for (let b = 0; b <= 100; b += 5) {
                const env = normalizeEnvelope(a, b);
                for (let lo = 0; lo <= 100; lo++) {
                    for (let hi = lo; hi <= 100 && hi - lo < HANDY_MIN_SLIDE_GAP; hi++) {
                        const none = slideSent(lo, hi, a, b, 0);
                        // A zone the engine can really ask for: inside the envelope.
                        const asked = lo >= env.min && hi <= env.max;
                        for (let m = 0; m <= HANDY_MAX_END_MARGIN; m++) {
                            const out = slideSent(lo, hi, a, b, m);
                            checked += 1;
                            if (out.max - out.min !== HANDY_MIN_SLIDE_GAP) fail('not one whole minimum stroke', lo, hi, a, b, m, out);
                            if (out.min < env.min || out.max > env.max) fail('outside the envelope', lo, hi, a, b, m, out);
                            if (out.min < none.min - m || out.max > none.max + m) fail(`more than the margin from ${none.min}-${none.max}`, lo, hi, a, b, m, out);
                            if (asked && m > 0 && (out.min < lo - m || out.max > hi + m)) pastAsked += 1;
                        }
                    }
                }
            }
        }
        assert.deepEqual(failures, []);
        assert.equal(checked, 21 * 21 * (92 * 10 + 45) * (HANDY_MAX_END_MARGIN + 1));
        // The bound the panel does not promise really does not hold: with a
        // margin in effect, an end of a zone inside its envelope lands more
        // than the margin from where the engine had it this often.
        assert.ok(pastAsked > 300000, `only ${pastAsked} strokes landed more than the margin from the zone asked for`);
    });
});

describe('typing into the End-Stop Margin', () => {
    // The page hands every event on the margin field to endMarginFieldEvent.
    function replayMargin(current, events) {
        let margin = current;
        return events.map(([event, raw]) => {
            const next = endMarginFieldEvent(margin, raw, event);
            if (next !== null) margin = next;
            return margin;
        });
    }

    it('never passes through 1 on the way from 5 to 10', () => {
        // The reported sequence: "1" used to put a margin of 1 in effect,
        // and a full-travel stroke went out as 1-99 until the 0 was typed.
        assert.deepEqual(replayMargin(5, [...typing('10'), ['change', '10']]), [5, 10, 10]);
    });

    it('raises the margin the moment the number is finished', () => {
        assert.deepEqual(replayMargin(5, typing('8')), [8]);
        assert.deepEqual(replayMargin(0, typing('5')), [5]);
    });

    it('holds a smaller margin until Enter or leaving the field', () => {
        // Lowering it moves the carriage back toward the end stops: that is
        // a decision, and 0 - the margin off - most of all.
        assert.deepEqual(replayMargin(5, [...typing('2'), ['change', '2']]), [5, 2]);
        assert.deepEqual(replayMargin(5, [...typing('0'), ['blur', '0']]), [5, 0]);
    });

    it('leaves a number the field does not take to the commit, which clamps it as before', () => {
        assert.deepEqual(replayMargin(5, [...typing('15'), ['change', '15']]), [5, 5, 10]);
        assert.equal(endMarginFieldEvent(5, '-3', 'change'), 0);
        assert.equal(endMarginFieldEvent(5, '4.4', 'change'), 4);
        // An emptied field is repainted with the margin in effect.
        assert.equal(endMarginFieldEvent(7, '', 'change'), 7);
        assert.equal(endMarginFieldEvent(7, '', 'blur'), 7);
        assert.equal(endMarginFieldEvent(7, '4.4', 'input'), null);
    });

    it('settles on leaving the field an edit no change event will report', () => {
        // 8 takes effect at once; typing 5 again waits; the field is back on
        // the number it had on focus, so Chromium fires no 'change'.
        assert.deepEqual(replayMargin(5, [...typing('8'), ...typing('5'), ['blur', '5']]), [8, 8, 5]);
        // Nor for Enter, which the page hands over as a commit itself: the
        // margin in effect was 8 while the field read 5 until the wearer left.
        assert.deepEqual(replayMargin(5, [...typing('8'), ...typing('5'), enter('5')]), [8, 8, 5]);
        // Enter on a smaller margin that differs from the focus text, followed
        // by the 'change' Chromium then fires: one commit, made twice.
        assert.deepEqual(replayMargin(5, [...typing('2'), enter('2'), ['change', '2'], ['blur', '2']]), [5, 2, 2, 2]);
        assert.equal(endMarginFieldEvent(5, '5', 'blur'), null, 'nothing to settle');
        assert.equal(endMarginFieldEvent(5, '5', 'input'), null, 'nothing to change');
        assert.equal(endMarginFieldEvent(5, '8', 'keyup'), null, 'an event it does not know');
    });

    it('never lets a keystroke lower the margin or act before the number is finished', () => {
        for (let current = 0; current <= HANDY_MAX_END_MARGIN; current++) {
            for (let n = 0; n <= 199; n++) {
                for (const raw of [String(n), String(n).padStart(2, '0')]) {
                    const next = endMarginFieldEvent(current, raw, 'input');
                    if (next === null) continue;
                    assert.ok(next > current, `margin ${current}: "${raw}" lowered it to ${next}`);
                    assert.ok(next <= HANDY_MAX_END_MARGIN, `margin ${current}: "${raw}" put ${next} in effect`);
                    assert.equal(next, Number(raw));
                    assert.ok(isFinishedNumber(raw, HANDY_MAX_END_MARGIN), `margin ${current}: "${raw}" acted unfinished`);
                }
            }
        }
    });
});

describe('describeSlideAdjustment', () => {
    it('says nothing when the device took the range as sent', () => {
        assert.equal(describeSlideAdjustment({ result: 0 }), null);
        assert.equal(describeSlideAdjustment({}), null);
        assert.equal(describeSlideAdjustment(null), null);
    });
    it('names a rounded range and what we asked for', () => {
        const down = describeSlideAdjustment({ result: 1 }, { min: 5, max: 95 });
        assert.match(down, /rounded down/);
        assert.match(down, /5-95%/);
        assert.match(describeSlideAdjustment({ result: 2 }, { min: 0, max: 10 }), /rounded up/);
        assert.match(describeSlideAdjustment({ result: 1 }), /rounded down/);
    });
});

describe('isHampModeError / describeDeviceStop', () => {
    it('recognises the HAMP error band and nothing else', () => {
        assert.equal(isHampModeError(3000), true);
        assert.equal(isHampModeError(3999), true);
        assert.equal(isHampModeError(2999), false);
        assert.equal(isHampModeError(1001), false);
        assert.equal(isHampModeError(-1), false);
        assert.equal(isHampModeError(null), false);
        assert.equal(isHampModeError('x'), false);
    });
    it('tells the wearer what the device did and what to change', () => {
        const msg = describeDeviceStop('The Handy refused a motion command (HAMP error 3000).');
        assert.match(msg, /^The Handy refused a motion command \(HAMP error 3000\)\./);
        assert.match(msg, /obstruction/i);
        assert.match(msg, /End-stop margin/);
        assert.match(msg, /Travel Envelope/);
        // It never claims a fault code the v2 API cannot give us.
        assert.ok(!/slider_blocked/.test(msg));
        assert.match(describeDeviceStop(), /^The Handy's firmware/);
    });
});

describe('handyTargetSpeed', () => {
    // The driver answers 0 with PUT /hamp/stop and the next moving tick with
    // PUT /hamp/start, so this is where a speed the engine wants moving must
    // not be rounded into a stop by the wearer's speed cap.
    it('follows the role and scales by the cap exactly as before', () => {
        assert.equal(handyTargetSpeed('primary', 50, 20, 100), 50);
        assert.equal(handyTargetSpeed('secondary', 50, 20, 100), 20);
        assert.equal(handyTargetSpeed('primary', 50, 20, 40), 20);
        assert.equal(handyTargetSpeed('secondary', 50, 20, 55), 11);
        // Wherever the old arithmetic already gave a moving speed, the
        // answer is unchanged, float rounding included (90% at a 35% cap is
        // 31.499999999999996, which has always gone out as 31).
        for (let cap = 0; cap <= 100; cap += 1) {
            for (let speed = 0; speed <= 100; speed += 1) {
                const before = Math.round(speed * (cap / 100));
                if (before >= 1) assert.equal(handyTargetSpeed('primary', speed, 0, cap), before, `${speed}% at cap ${cap}%`);
            }
        }
        assert.equal(handyTargetSpeed('primary', 90, 0, 35), 31);
    });

    it('sends a slow speed under a low cap as the slowest crawl, never as a stop', () => {
        assert.equal(HANDY_MIN_VELOCITY, 1);
        // The cases that used to go out as PUT /hamp/stop.
        assert.equal(handyTargetSpeed('primary', 1, 0, 40), HANDY_MIN_VELOCITY);
        assert.equal(handyTargetSpeed('primary', 4, 0, 10), HANDY_MIN_VELOCITY);
        assert.equal(handyTargetSpeed('secondary', 0, 2, 20), HANDY_MIN_VELOCITY);
        for (let cap = 1; cap <= 100; cap += 1) {
            for (let speed = 1; speed <= 100; speed += 1) {
                const primary = handyTargetSpeed('primary', speed, 0, cap);
                const secondary = handyTargetSpeed('secondary', 0, speed, cap);
                assert.ok(primary >= HANDY_MIN_VELOCITY && secondary >= HANDY_MIN_VELOCITY, `${speed}% at cap ${cap}% stopped the Handy`);
                // The floor never lifts the Handy past the cap the wearer set.
                assert.ok(primary <= cap && secondary <= cap, `${speed}% at cap ${cap}% went past the cap`);
            }
        }
    });

    it('is 0 only for a stop, a cap of 0, the role Off, or a value that is not a number', () => {
        assert.equal(handyTargetSpeed('primary', 0, 50, 100), 0);
        assert.equal(handyTargetSpeed('secondary', 50, 0, 100), 0);
        assert.equal(handyTargetSpeed('primary', 50, 50, 0), 0);
        assert.equal(handyTargetSpeed('off', 50, 50, 100), 0);
        assert.equal(handyTargetSpeed(undefined, 50, 50, 100), 0);
        assert.equal(handyTargetSpeed('primary', -5, 50, 100), 0);
        // Doubt ends in a stop.
        assert.equal(handyTargetSpeed('primary', NaN, 50, 100), 0);
        assert.equal(handyTargetSpeed('primary', 50, 50, NaN), 0);
        assert.equal(handyTargetSpeed('primary', 50, 50, 'lots'), 0);
        assert.equal(handyTargetSpeed('primary', Infinity, 50, 100), 0);
        // No stored cap at all is the factory 100%, as it always was.
        assert.equal(handyTargetSpeed('primary', 37, 0, undefined), 37);
        assert.equal(handyTargetSpeed('primary', 37, 0, null), 37);
        assert.equal(handyTargetSpeed('primary', 250, 0, 100), 100);
    });
});

describe('describeStartRefusal', () => {
    it('says the session did not start, and what to do next', () => {
        const offline = describeStartRefusal({ state: 'offline', reason: 'The Handy reports it is no longer connected to Wi-Fi.' });
        assert.match(offline, /^The session was not started: The Handy is offline\./);
        assert.match(offline, /connect it again in The Handy panel/);
        // The device's own reason is already on the banner, one line up.
        assert.ok(!/Wi-Fi/.test(offline), offline);

        const unreachable = describeStartRefusal({ state: 'unreachable', reason: 'Network error (/connected)' });
        assert.match(unreachable, /^The session was not started: EdgeLoop could not reach The Handy API/);
        assert.match(unreachable, /\(Network error \(\/connected\)\)/);
        assert.match(unreachable, /press START again\.$/);

        assert.match(describeStartRefusal({ state: 'stale' }), /changed while it was being checked\. Press START again\.$/);

        // With the link gone START may be waiting for a toy: no "press again".
        const lost = describeStartRefusal({ state: 'lost', reason: 'The Handy connection was lost while it was being checked.' });
        assert.equal(lost, 'The session was not started: The Handy connection was lost while it was being checked.');
    });

    it('names RESUME for a paused session', () => {
        const msg = describeStartRefusal({ state: 'unreachable', reason: 'Request timed out (/connected)' }, true);
        assert.match(msg, /^The session was not resumed: /);
        assert.match(msg, /press RESUME again\.$/);
        assert.match(describeStartRefusal({ state: 'offline' }, true), /^The session was not resumed: The Handy is offline\./);
    });

    it('sends the wearer to the network, not the device, when the API could not be reached', () => {
        // The third miss in a row drops the link, and the check that made it
        // answers offline. The device may be fine: it is the connection
        // that needs checking before The Handy is connected again.
        const api = describeStartRefusal({ state: 'offline', reason: 'The Handy API is unreachable.', cause: 'api' });
        assert.equal(api, 'The session was not started: The Handy API could not be reached, so the connection was dropped. Check the connection, then connect again in The Handy panel.');
        assert.ok(!/Check the device/.test(api), api);
        assert.match(describeStartRefusal({ state: 'offline', cause: 'api' }, true), /^The session was not resumed: The Handy API could not be reached/);
        // The device's own word is still a device to check, and so is an
        // offline answer that does not say why.
        for (const cause of ['device', undefined, 'bogus']) {
            assert.match(describeStartRefusal({ state: 'offline', cause }), /The Handy is offline\. Check the device, then connect it again in The Handy panel\.$/, String(cause));
        }
    });

    it('is a refusal whatever it is handed', () => {
        for (const answer of [null, undefined, {}, 'offline', 42, { state: 'online' }, { state: 'unreachable' }]) {
            const msg = describeStartRefusal(answer);
            assert.match(msg, /^The session was not started: /, String(answer));
            assert.ok(!/undefined|null|\(\)/.test(msg), msg);
        }
    });
});

describe('isDeviceNotConnectedError', () => {
    it('recognises the API saying the device was not connected, by name and flag', () => {
        // The spec's own example.
        assert.equal(isDeviceNotConnectedError({ error: { code: 1001, name: 'DeviceNotConnected', message: 'Device not connected', connected: false } }), true);
        // The enum's spelling of the same name, under the other number.
        assert.equal(isDeviceNotConnectedError({ error: { code: 1002, name: 'DEVICE_NOT_CONNECTED', message: 'Device not connected', connected: false } }), true);
    });

    it('is not read from the code: the spec numbers its two device errors both ways round', () => {
        // The example's DeviceTimeout carries 1002; the enum says 1002 is
        // DEVICE_NOT_CONNECTED. Neither number may pass a timeout - a command
        // the device may have carried out - off as one it never received.
        assert.equal(isDeviceNotConnectedError({ error: { code: 1002, name: 'DeviceTimeout', message: 'Device timeout', connected: true } }), false);
        assert.equal(isDeviceNotConnectedError({ error: { code: 1001, name: 'DeviceTimeout', message: 'Device timeout', connected: false } }), false);
        assert.equal(isDeviceNotConnectedError({ error: { code: 1002, message: 'Device not connected', connected: false } }), false, 'no name, no verdict');
    });

    it('needs the connected flag to agree, and an error object at all', () => {
        assert.equal(isDeviceNotConnectedError({ error: { code: 1001, name: 'DeviceNotConnected', message: 'Device not connected', connected: true } }), false);
        assert.equal(isDeviceNotConnectedError({ error: { code: 1001, name: 'DeviceNotConnected', message: 'Device not connected' } }), false);
        const notIt = [null, undefined, {}, { result: -1 }, { error: 'Device not connected' }, { error: { code: 1000, name: 'Error', message: 'Unspecified error', connected: false } }];
        for (const body of notIt) assert.equal(isDeviceNotConnectedError(body), false, JSON.stringify(body));
    });
});
