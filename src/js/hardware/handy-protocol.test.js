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

describe('applyEndMargin', () => {
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
        }
        assert.deepEqual(applyEndMargin({ min: 5, max: 95 }, 5), { min: 5, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 20, max: 80 }, 5), { min: 20, max: 80 });
    });
    it('only moves the end that is actually against the stop', () => {
        assert.deepEqual(applyEndMargin({ min: 0, max: 90 }, 5), { min: 5, max: 90 });
        assert.deepEqual(applyEndMargin({ min: 10, max: 100 }, 5), { min: 10, max: 95 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 35 }, 5), { min: 5, max: 35 });
        assert.deepEqual(applyEndMargin({ min: 75, max: 100 }, 5), { min: 75, max: 95 });
    });
    it('sends the range untouched at margin 0', () => {
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }, 0), { min: 0, max: 100 });
        assert.deepEqual(applyEndMargin({ min: 0, max: 12 }, 0), { min: 0, max: 12 });
    });
    it('yields rather than take the wearer\'s stroke away', () => {
        // A minimum-width stroke against the bottom stop keeps its width: the
        // margin gives up entirely rather than leave a jammed sleeve.
        assert.deepEqual(applyEndMargin({ min: 0, max: 10 }, 5), { min: 0, max: 10 });
        // A stroke with room to spare gives up only as much as it can.
        assert.deepEqual(applyEndMargin({ min: 0, max: 12 }, 5), { min: 2, max: 12 });
        // Already narrower than the minimum gap (a hand-narrowed envelope):
        // the width it had is the width it keeps.
        assert.deepEqual(applyEndMargin({ min: 96, max: 100 }, 5), { min: 96, max: 100 });
    });
    it('is a subset of its input for every range and margin', () => {
        // The whole safety argument in one property: the input is already
        // inside the user's envelope, so a subset of it cannot leave the
        // envelope, cannot invert, and cannot come back wider.
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
    it('defaults to the shipped margin', () => {
        assert.deepEqual(applyEndMargin({ min: 0, max: 100 }), { min: HANDY_DEFAULT_END_MARGIN, max: 100 - HANDY_DEFAULT_END_MARGIN });
    });
    it('never sends a wider range for a larger margin', () => {
        // What lets a keystroke that RAISES the margin take effect at once:
        // for every range, a larger margin is never wider than a smaller one.
        for (let lo = 0; lo <= 100; lo += 1) {
            for (let hi = lo; hi <= 100; hi += 1) {
                let prev = applyEndMargin({ min: lo, max: hi }, 0);
                for (let m = 1; m <= HANDY_MAX_END_MARGIN; m += 1) {
                    const out = applyEndMargin({ min: lo, max: hi }, m);
                    assert.ok(out.min >= prev.min && out.max <= prev.max, `${lo}-${hi}: margin ${m} sent ${out.min}-${out.max}, wider than ${prev.min}-${prev.max}`);
                    prev = out;
                }
            }
        }
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
