import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    FIELD_EVENTS,
    fieldEventOf,
    bindEnvelopeField,
    bindEndMarginField,
    settleFocusedField
} from './handy-fields.js';
import { normalizeEnvelope, envelopeFieldEvent } from './handy-protocol.js';

// A number field as the binder sees one: its text, its listeners, and a
// blur() that is only recorded, because what the browser does on blur() is
// part of what these tests replay.
function fakeField(value, id = 'field') {
    const listeners = {};
    return {
        id,
        value,
        blurred: 0,
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        listensTo() { return Object.keys(listeners).sort(); },
        fire(type, init = {}) { (listeners[type] || []).forEach((fn) => fn({ type, ...init })); },
        blur() { this.blurred += 1; }
    };
}

// The document, as far as the binder asks it anything.
function fakePage(focused = true) {
    return { focused, hasFocus() { return this.focused; } };
}

// A wearer at a bound field, with the browser between them: every gesture
// below fires the DOM events Chromium was measured to fire for it, on a
// focused <input type=number>, with document.hasFocus() as it read at the
// time (scratch probe events-probe.js, headless Chromium 141):
//  - a keystroke: 'input';
//  - Tab, a click elsewhere, the field being hidden, el.blur(): 'change'
//    (only when the text differs from what the field held when the edit
//    began - Blink's value_before_first_user_edit_), then 'blur', with the
//    page focused;
//  - Enter: 'keydown', then the same conditional 'change';
//  - an arrow-key or spin-button step: 'input', then 'change';
//  - the window or tab losing the focus, or an alert(): the same conditional
//    'change', then 'blur', with document.hasFocus() FALSE and the field
//    still the active element; on return, 'focus' on the field again, and no
//    'change' ever again for the text as it stood, since the browser had
//    already reported it.
function wearerAt(field, page) {
    let valueBeforeFirstEdit = null;
    const browserCommit = () => {
        const changed = valueBeforeFirstEdit !== null && valueBeforeFirstEdit !== field.value;
        valueBeforeFirstEdit = null;
        if (changed) field.fire('change');
    };
    return {
        focus() { field.fire('focus'); },
        // Types `text` over a selected number: each key replaces the text so far.
        type(text) {
            for (let i = 1; i <= text.length; i++) {
                if (valueBeforeFirstEdit === null) valueBeforeFirstEdit = field.value;
                field.value = text.slice(0, i);
                field.fire('input');
            }
        },
        // One 'input' holding the whole text: a paste, or a digit replaced in place.
        putText(text) {
            if (valueBeforeFirstEdit === null) valueBeforeFirstEdit = field.value;
            field.value = text;
            field.fire('input');
        },
        leave() { browserCommit(); field.fire('blur'); },
        enter() { field.fire('keydown', { key: 'Enter', isComposing: false }); browserCommit(); },
        step(delta) {
            if (valueBeforeFirstEdit === null) valueBeforeFirstEdit = field.value;
            field.value = String(Number(field.value) + delta);
            field.fire('input');
            browserCommit();
        },
        windowAway() { page.focused = false; browserCommit(); field.fire('blur'); },
        windowBack() { page.focused = true; field.fire('focus'); }
    };
}

// A Travel Envelope field bound as the page binds it, over the envelope
// `current`, recording every pair the binder puts in effect. The field holds
// the bound in effect, as it does when the wearer clicks into it.
function boundEnvelopeField(current, bound) {
    const field = fakeField(String(current[bound]), bound === 'min' ? 'hwMinInput' : 'hwMaxInput');
    const page = fakePage();
    let env = { ...current };
    const puts = [];
    bindEnvelopeField(field, bound, {
        page,
        envelope: () => env,
        put(next, commit) {
            env = next;
            puts.push({ ...next, commit });
            // The page repaints a committed field with the bound it put in effect.
            if (commit) field.value = String(next[bound]);
        }
    });
    const wearer = wearerAt(field, page);
    wearer.focus();
    return { field, page, puts, wearer, envelope: () => env };
}

describe('a Travel Envelope field, bound as the page binds it', () => {
    it('listens for the keystroke, the browser\'s commit, leaving, the keyboard and the focus', () => {
        const { field } = boundEnvelopeField({ min: 40, max: 85 }, 'max');
        assert.deepEqual(field.listensTo(), ['blur', 'change', 'focus', 'input', 'keydown']);
        assert.deepEqual([...FIELD_EVENTS].sort(), ['blur', 'change', 'input', 'keydown']);
    });

    it('never collapses the stroke or rewrites the Lower Guard on the way to an Upper Guard', () => {
        // The reported sequence: 40-85, select the Upper Guard, type 8 then 5,
        // then Tab. The first key used to put 0-10 in effect and send it.
        const { puts, wearer, envelope, field } = boundEnvelopeField({ min: 40, max: 85 }, 'max');
        wearer.type('85');
        assert.deepEqual(puts, [], 'no keystroke put anything in effect');
        assert.equal(field.value, '85', 'and the field was left to the wearer');
        wearer.leave();
        assert.deepEqual(puts, [], 'leaving on the number in effect changes nothing');
        assert.deepEqual(envelope(), { min: 40, max: 85 });
    });

    it('lowers the Upper Guard the moment the number is finished, without touching the field', () => {
        const { puts, wearer, field } = boundEnvelopeField({ min: 40, max: 85 }, 'max');
        wearer.type('70');
        assert.deepEqual(puts, [{ min: 40, max: 70, commit: false }]);
        assert.equal(field.value, '70');
        // The wearer's own Tab then commits a number already in effect: the
        // envelope does not move again.
        wearer.leave();
        assert.deepEqual(puts.slice(1), [{ min: 40, max: 70, commit: true }]);
    });

    it('holds a wider number until the wearer commits it', () => {
        const { puts, wearer } = boundEnvelopeField({ min: 40, max: 85 }, 'max');
        wearer.type('95');
        assert.deepEqual(puts, []);
        wearer.leave();
        assert.deepEqual(puts, [{ min: 40, max: 95, commit: true }]);
    });

    it('puts a waiting number in effect on Enter, even when the field is back on its focus text', () => {
        // 80 narrows at once; 85 again widens and waits; the field now holds
        // the text it had on focus, so the browser fires no 'change' for
        // Enter, and only the keydown can commit it.
        const { puts, wearer, envelope } = boundEnvelopeField({ min: 40, max: 85 }, 'max');
        wearer.type('80');
        wearer.type('85');
        assert.deepEqual(puts, [{ min: 40, max: 80, commit: false }]);
        wearer.enter();
        assert.deepEqual(puts.slice(1), [{ min: 40, max: 85, commit: true }]);
        assert.deepEqual(envelope(), { min: 40, max: 85 });
        // When the browser's 'change' does follow Enter, it repeats a commit
        // already made and the envelope does not move again.
        const other = boundEnvelopeField({ min: 40, max: 85 }, 'max');
        other.wearer.type('95');
        other.wearer.enter();
        assert.ok(other.puts.length >= 1);
        assert.ok(other.puts.every((p) => p.min === 40 && p.max === 95 && p.commit), JSON.stringify(other.puts));
    });

    it('commits nothing when the window or tab loses the focus mid-number', () => {
        // Chromium fires 'change' and 'blur' on the focused field when the
        // window or the tab loses the focus (or an alert() takes it), with
        // document.hasFocus() false and the field still the active element.
        // Taken for a commit, "9" on its way to 95 became an Upper Guard of 9:
        // envelope 0-10, the Lower Guard overwritten, PUT /slide 0-10 sent.
        const { puts, wearer, envelope, field } = boundEnvelopeField({ min: 40, max: 85 }, 'max');
        wearer.type('9');
        wearer.windowAway();
        assert.deepEqual(puts, [], 'the window going away put nothing in effect');
        assert.deepEqual(envelope(), { min: 40, max: 85 });
        assert.equal(field.value, '9', 'the half-typed number is still there for the wearer');
        // Back, the wearer finishes the number. 95 widens, so it waits for
        // Enter, and Enter puts it in effect - once from the keydown and, as
        // the text now differs from the "9" the browser saw when the edit
        // resumed, once more from the 'change' the browser fires after it:
        // the same commit, made twice.
        wearer.windowBack();
        wearer.type('95');
        assert.deepEqual(puts, []);
        wearer.enter();
        assert.ok(puts.length >= 1, 'Enter put the number in effect');
        assert.ok(puts.every((p) => p.min === 40 && p.max === 95 && p.commit), JSON.stringify(puts));
        assert.deepEqual(envelope(), { min: 40, max: 95 });
    });

    it('still takes a number typed onto the end after the focus comes back', () => {
        // The text the field held is taken again on 'focus', so the "0" that
        // finishes "70" after a tab switch is known to be typed, and narrows
        // at once, exactly as it would have without the switch.
        const { puts, wearer } = boundEnvelopeField({ min: 40, max: 85 }, 'max');
        wearer.type('7');
        wearer.windowAway();
        wearer.windowBack();
        wearer.type('70');
        assert.deepEqual(puts, [{ min: 40, max: 70, commit: false }]);
    });

    it('commits as leaving always has when the wearer comes back and leaves the field', () => {
        // The browser already reported the "9" once, while the window was
        // away, so it fires no 'change' when the wearer now presses Tab -
        // only 'blur'. Leaving is a commit all the same, and it is normalised
        // exactly as a committed 9 always was: the other bound makes room.
        const { puts, wearer } = boundEnvelopeField({ min: 40, max: 85 }, 'max');
        wearer.type('9');
        wearer.windowAway();
        wearer.windowBack();
        wearer.leave();
        const always = normalizeEnvelope(40, '9', 'max');
        assert.deepEqual(puts, [{ ...always, commit: true }]);
        assert.deepEqual(envelopeFieldEvent({ min: 40, max: 85 }, 'max', '9', 'blur'), always);
    });

    it('settles an edit no change event reports when the wearer leaves', () => {
        // 80 narrows at once; 85 again waits; the field is back on its focus
        // text, so Tab fires 'blur' alone, and 'blur' puts 85 back in effect.
        const { puts, wearer, envelope } = boundEnvelopeField({ min: 40, max: 85 }, 'max');
        wearer.type('80');
        wearer.type('85');
        wearer.leave();
        assert.deepEqual(puts, [{ min: 40, max: 80, commit: false }, { min: 40, max: 85, commit: true }]);
        assert.deepEqual(envelope(), { min: 40, max: 85 });
    });

    it('commits each arrow-key or spin-button step as the browser reports it', () => {
        const { puts, wearer, envelope } = boundEnvelopeField({ min: 40, max: 85 }, 'max');
        wearer.step(+1);
        assert.deepEqual(envelope(), { min: 40, max: 86 }, 'a step up is a widening the browser commits');
        assert.ok(puts.every((p) => p.commit), 'and it arrives as a commit, never as a keystroke');
        wearer.step(-1);
        assert.deepEqual(envelope(), { min: 40, max: 85 });
    });

    it('leaves a digit replaced in the middle, or a pasted number, to the commit', () => {
        // Replacing the 7 of 75 on the way to 68 leaves a finished, narrower
        // 65 in the field for one keystroke; it was not typed onto the end.
        const { puts, wearer } = boundEnvelopeField({ min: 40, max: 75 }, 'max');
        wearer.putText('65');
        wearer.putText('68');
        assert.deepEqual(puts, []);
        wearer.leave();
        assert.deepEqual(puts, [{ min: 40, max: 68, commit: true }]);
    });

    it('applies a Lower Guard under the same rules', () => {
        // Typing 45 over 40 used to pass through 4 and widen the stroke to 4-90.
        const { puts, wearer } = boundEnvelopeField({ min: 40, max: 90 }, 'min');
        wearer.type('45');
        assert.deepEqual(puts, [{ min: 45, max: 90, commit: false }]);
        const away = boundEnvelopeField({ min: 40, max: 90 }, 'min');
        away.wearer.type('4');
        away.wearer.windowAway();
        assert.deepEqual(away.puts, [], 'a tab switch after the 4 puts nothing in effect');
        assert.deepEqual(away.envelope(), { min: 40, max: 90 });
    });

    it('acts on nothing the browser reports that is not one of its events', () => {
        const { puts, field } = boundEnvelopeField({ min: 40, max: 85 }, 'max');
        field.value = '70';
        field.fire('keydown', { key: '0' });
        field.fire('keydown', { key: 'Enter', isComposing: true });
        assert.deepEqual(puts, []);
    });
});

describe('the End-Stop Margin field, bound as the page binds it', () => {
    function boundMarginField(current) {
        const field = fakeField(String(current), 'handyEndMarginInput');
        const page = fakePage();
        let margin = current;
        const puts = [];
        bindEndMarginField(field, {
            page,
            margin: () => margin,
            put(next, commit) {
                margin = next;
                puts.push({ margin: next, commit });
                if (commit) field.value = String(next);
            }
        });
        const wearer = wearerAt(field, page);
        wearer.focus();
        return { field, page, puts, wearer, margin: () => margin };
    }

    it('listens for the keystroke, the browser\'s commit, leaving and the keyboard', () => {
        const { field } = boundMarginField(5);
        assert.deepEqual(field.listensTo(), ['blur', 'change', 'input', 'keydown']);
    });

    it('never passes through 1 on the way from 5 to 10', () => {
        const { puts, wearer } = boundMarginField(5);
        wearer.type('10');
        assert.deepEqual(puts, [{ margin: 10, commit: false }]);
    });

    it('holds a smaller margin until Enter or leaving, and commits nothing on a window switch', () => {
        const { puts, wearer, margin } = boundMarginField(5);
        wearer.type('2');
        assert.deepEqual(puts, []);
        wearer.windowAway();
        assert.deepEqual(puts, [], 'the window going away is not a commit');
        assert.equal(margin(), 5);
        wearer.windowBack();
        wearer.enter();
        assert.deepEqual(puts, [{ margin: 2, commit: true }]);
        // Typing 10 over 5 with a tab switch after the 1: the 1 never lands.
        const away = boundMarginField(5);
        away.wearer.type('1');
        away.wearer.windowAway();
        assert.equal(away.margin(), 5);
        away.wearer.windowBack();
        away.wearer.type('10');
        assert.deepEqual(away.puts, [{ margin: 10, commit: false }]);
    });

    it('puts a waiting margin in effect on Enter when the field is back on its focus text', () => {
        const { puts, wearer, margin } = boundMarginField(5);
        wearer.type('8');
        wearer.type('5');
        assert.deepEqual(puts, [{ margin: 8, commit: false }]);
        wearer.enter();
        assert.equal(margin(), 5);
        assert.deepEqual(puts.slice(1), [{ margin: 5, commit: true }]);
    });

    it('repaints an emptied field with the margin in effect when the wearer leaves', () => {
        const { puts, wearer, field } = boundMarginField(7);
        wearer.putText('');
        assert.deepEqual(puts, []);
        wearer.leave();
        assert.deepEqual(puts, [{ margin: 7, commit: true }]);
        assert.equal(field.value, '7');
    });
});

describe('settleFocusedField', () => {
    it('repaints and then blurs a panel field that still has the focus', () => {
        const fields = [fakeField('9', 'hwMaxInput'), fakeField('40', 'hwMinInput'), fakeField('5', 'handyEndMarginInput')];
        const order = [];
        fields[0].blur = () => order.push('blur');
        const settled = settleFocusedField(fields, fields[0], () => order.push('repaint'));
        assert.equal(settled, true);
        assert.deepEqual(order, ['repaint', 'blur'], 'the number in effect is painted back before the focus leaves');
    });

    it('leaves anything else alone', () => {
        const fields = [fakeField('9', 'hwMaxInput')];
        let repainted = 0;
        for (const active of [null, undefined, fakeField('x', 'modalHandyInput'), { id: 'body' }]) {
            assert.equal(settleFocusedField(fields, active, () => { repainted += 1; }), false);
        }
        assert.equal(repainted, 0);
        assert.equal(fields[0].blurred, 0);
    });
});

describe('fieldEventOf', () => {
    it('hands Enter over as the commit it is', () => {
        // Chromium raises no 'change' for Enter when the field is back on the
        // text it had on focus, so the page commits on the keydown itself.
        assert.equal(fieldEventOf({ type: 'keydown', key: 'Enter', isComposing: false }), 'change');
        // The numpad's Enter reports the same key.
        assert.equal(fieldEventOf({ type: 'keydown', key: 'Enter', code: 'NumpadEnter' }), 'change');
        assert.equal(fieldEventOf({ type: 'keydown', key: 'Enter' }), 'change');
    });
    it('lets every other key, and a composing Enter, pass', () => {
        for (const key of ['8', '5', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'a', ' ', 'Process', 'Shift']) {
            assert.equal(fieldEventOf({ type: 'keydown', key }), null, key);
        }
        // Enter inside an input method's composition finishes the composition,
        // not the number.
        assert.equal(fieldEventOf({ type: 'keydown', key: 'Enter', isComposing: true }), null);
        assert.equal(fieldEventOf({ type: 'keyup', key: 'Enter' }), null);
        assert.equal(fieldEventOf({ type: 'keypress', key: 'Enter' }), null);
    });
    it('passes the three field events through and nothing else', () => {
        assert.equal(fieldEventOf({ type: 'input' }), 'input');
        assert.equal(fieldEventOf({ type: 'change' }), 'change');
        assert.equal(fieldEventOf({ type: 'blur' }), 'blur');
        for (const type of ['focus', 'focusout', 'click', 'wheel', 'paste', 'beforeinput', '', undefined]) {
            assert.equal(fieldEventOf({ type }), null, String(type));
        }
        assert.equal(fieldEventOf(null), null);
        assert.equal(fieldEventOf(undefined), null);
    });
    it('takes a change or blur that arrives while the page has no focus for the window going away', () => {
        // Not the wearer leaving the field: it is still the active element,
        // and gets the focus back when they return.
        assert.equal(fieldEventOf({ type: 'change' }, false), null);
        assert.equal(fieldEventOf({ type: 'blur' }, false), null);
        assert.equal(fieldEventOf({ type: 'change' }, true), 'change');
        assert.equal(fieldEventOf({ type: 'blur' }, true), 'blur');
        // A keystroke that somehow arrives is still a keystroke: it can only
        // ever narrow, exactly as typed.
        assert.equal(fieldEventOf({ type: 'input' }, false), 'input');
    });
});

// The one thing this module cannot prove about itself: that the page binds
// its fields through it, and settles them before it hides the panel. app.js
// needs a DOM, so this reads it as text, the way the other app.js guards in
// this suite do. The behaviour is proven above, through the exported
// functions and a fake field; this only checks that the page attaches them,
// so a page wired some other way fails here rather than in a wearer's hands.
describe('the page binds its fields through this module', () => {
    const APP = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
    function bodyOf(name) {
        const at = APP.indexOf(`function ${name}`);
        assert.ok(at >= 0, `${name} is gone - rename this guard with it`);
        return APP.slice(at, APP.indexOf('\n}', at));
    }

    it('imports the binder and the settle', () => {
        assert.match(APP, /import \{[^}]*\bbindEnvelopeField\b[^}]*\} from '\.\/hardware\/handy-fields\.js'/);
        assert.match(APP, /import \{[^}]*\bbindEndMarginField\b[^}]*\} from '\.\/hardware\/handy-fields\.js'/);
        assert.match(APP, /import \{[^}]*\bsettleFocusedField\b[^}]*\} from '\.\/hardware\/handy-fields\.js'/);
    });

    it('binds every envelope input and the margin input, and asks the document about the focus', () => {
        const body = bodyOf('initHandyRoleUI');
        assert.match(body, /hwEnvelopeInputs\(bound\)\.forEach\(\(el\) => \{\s*bindEnvelopeField\(el, bound, \{\s*page: document,/,
            'each envelope input must be bound through bindEnvelopeField with the document as its page');
        assert.match(body, /bindEndMarginField\(marginInput, \{\s*page: document,/,
            'the margin input must be bound through bindEndMarginField with the document as its page');
        assert.ok(!/(?:marginInput|el)\.addEventListener\(/.test(body),
            'the page must not listen to these fields on its own beside the binder');
    });

    it('settles a focused field before the modal is hidden', () => {
        const close = bodyOf('closeModal');
        const settleAt = close.indexOf('settleHandyPanelInputs()');
        const hideAt = close.indexOf("overlay?.classList.add('hidden')");
        assert.ok(settleAt >= 0 && hideAt > settleAt, 'closeModal must settle the panel fields before it hides the overlay');
        assert.match(bodyOf('settleHandyPanelInputs'), /settleFocusedField\(handyPanelFields\(\), document\.activeElement, syncHwEnvelopeInputs\)/,
            'and the settle must be the one this module defines, over every panel field, repainting from the settings');
        assert.match(bodyOf('handyPanelFields'), /hwEnvelopeInputs\('min'\)[\s\S]*hwEnvelopeInputs\('max'\)[\s\S]*handyEndMarginInput/,
            'the panel fields are the four envelope inputs and the margin');
    });
});
