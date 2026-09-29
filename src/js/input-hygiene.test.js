import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cancelWheelWhileFocused, releaseFocusOnCommit, releaseFocusOnPointerUp } from './input-hygiene.js';

// A document that knows only which element is active and whether the page
// has the focus (`focused`, which is what hasFocus() answers: true unless a
// test takes the window or the tab away), and elements that record their
// listeners and dispatch events to them the way a browser does: in
// registration order, and with preventDefault() ignored for a listener
// registered passive and for an event that is not cancelable. An event is
// cancelable unless the test says otherwise, as the first wheel event of a
// scroll is. `log` records every focus and blur, so a test can see in which
// order things happened. With `changeOnBlur` the element also fires `change`
// when it loses the focus with a value edited since it gained it, as a
// browser does when the wearer leaves a field.
function fakeDocument() {
    const body = { id: 'BODY' };
    return { body, activeElement: body, focused: true, hasFocus() { return this.focused; } };
}

function fakeElement(doc, id, log = [], { changeOnBlur = false } = {}) {
    const listeners = [];
    let valueAtFocus = null;
    const el = {
        id,
        value: '',
        listeners,
        log,
        addEventListener(type, fn, options) {
            listeners.push({ type, fn, options });
        },
        focus() {
            doc.activeElement = el;
            valueAtFocus = el.value;
            log.push(`focus ${id}`);
        },
        blur() {
            // A blur on an element that is not focused moves nothing, as in
            // a browser; the call is still logged so a test can see it.
            const wasFocused = doc.activeElement === el;
            if (wasFocused) doc.activeElement = doc.body;
            log.push(`blur ${id}`);
            if (wasFocused && changeOnBlur && el.value !== valueAtFocus) el.dispatch('change');
        },
        dispatch(type, init = {}) {
            const event = { type, target: el, cancelable: true, defaultPrevented: false, ...init };
            for (const { fn, options } of listeners.filter((l) => l.type === type)) {
                const passive = Boolean(options && typeof options === 'object' && options.passive);
                event.preventDefault = () => {
                    if (!passive && event.cancelable) event.defaultPrevented = true;
                };
                fn(event);
            }
            return event;
        }
    };
    return el;
}

// What Chromium does with a wheel event over a number field once every
// listener has run: unless the event was cancelled, the spin button steps a
// focused field by one, up for a wheel turned away from the wearer, and
// leaves an unfocused one alone. The step goes through the value, so a test
// sees what the wearer would see in the field.
function wheelOverNumberField(doc, input, init) {
    const event = input.dispatch('wheel', init);
    if (!event.defaultPrevented && doc.activeElement === input) {
        input.value = String(Number(input.value) + (init.deltaY < 0 ? 1 : -1));
    }
    return event;
}

function activeId(doc) {
    return doc.activeElement ? doc.activeElement.id : null;
}

describe('cancelWheelWhileFocused', () => {
    it('registers one wheel listener, and registers it non-passive', () => {
        const doc = fakeDocument();
        const input = fakeElement(doc, 'maxHr');
        cancelWheelWhileFocused(input, { doc });
        const wheel = input.listeners.filter((l) => l.type === 'wheel');
        assert.equal(wheel.length, 1, 'exactly one wheel listener');
        assert.equal(input.listeners.length, 1, 'nothing but the wheel listener');
        // A passive listener's preventDefault() is ignored by the browser, so
        // the flag is the difference between a guard and a comment.
        assert.equal(wheel[0].options.passive, false, 'the wheel listener must be {passive: false}');
    });

    it('cancels the wheel while the field is the active element', () => {
        const doc = fakeDocument();
        const input = fakeElement(doc, 'maxHr');
        input.value = '140';
        cancelWheelWhileFocused(input, { doc });
        input.focus();
        const up = input.dispatch('wheel', { deltaY: -100 });
        assert.equal(up.defaultPrevented, true, 'a notch up over the focused Climax HR must be cancelled');
        const down = input.dispatch('wheel', { deltaY: 100 });
        assert.equal(down.defaultPrevented, true, 'a notch down over the focused Climax HR must be cancelled');
        assert.equal(input.value, '140', 'the guard itself never writes the field');
    });

    it('leaves the wheel alone while the field is not focused, so the page still scrolls', () => {
        const doc = fakeDocument();
        const input = fakeElement(doc, 'maxHr');
        const other = fakeElement(doc, 'minHr');
        cancelWheelWhileFocused(input, { doc });
        assert.equal(input.dispatch('wheel', { deltaY: 100 }).defaultPrevented, false, 'with nothing focused the wheel scrolls');
        other.focus();
        assert.equal(input.dispatch('wheel', { deltaY: 100 }).defaultPrevented, false, 'with another field focused the wheel scrolls');
    });

    it('reads the focus at wheel time, not at registration', () => {
        const doc = fakeDocument();
        const input = fakeElement(doc, 'minHr');
        cancelWheelWhileFocused(input, { doc });
        assert.equal(input.dispatch('wheel', { deltaY: -100 }).defaultPrevented, false);
        input.focus();
        assert.equal(input.dispatch('wheel', { deltaY: -100 }).defaultPrevented, true);
        input.blur();
        assert.equal(input.dispatch('wheel', { deltaY: -100 }).defaultPrevented, false);
    });

    it('neither steals nor drops the focus over a wheel it can cancel', () => {
        const doc = fakeDocument();
        const log = [];
        const input = fakeElement(doc, 'maxHr', log);
        cancelWheelWhileFocused(input, { doc });
        input.focus();
        input.dispatch('wheel', { deltaY: -100 });
        assert.equal(activeId(doc), 'maxHr', 'the wearer is still in the field after a wheel');
        assert.deepEqual(log, ['focus maxHr'], 'a wheel that was cancelled must not blur the field the wearer is typing in');
        input.blur();
        input.dispatch('wheel', { deltaY: -100 });
        input.dispatch('wheel', { deltaY: -100, cancelable: false });
        assert.equal(activeId(doc), 'BODY', 'a wheel over an idle field must not focus it');
    });

    it('a scroll that begins over the focused field never steps it', () => {
        // The first event is cancelable and is cancelled, and Chromium keeps
        // the rest of a cancelled scroll cancelable, so every event is.
        const doc = fakeDocument();
        const input = fakeElement(doc, 'maxHr');
        input.value = '140';
        cancelWheelWhileFocused(input, { doc });
        input.focus();
        for (let i = 0; i < 20; i++) {
            assert.equal(wheelOverNumberField(doc, input, { deltaY: -100 }).defaultPrevented, true, `event ${i + 1} must be cancelled`);
        }
        assert.equal(input.value, '140', 'the ceiling the engine drives toward must not move');
        assert.equal(activeId(doc), 'maxHr', 'the wearer is still in the field');
    });

    it('lets go of the focused field when the wheel cannot be cancelled', () => {
        const doc = fakeDocument();
        const log = [];
        const input = fakeElement(doc, 'maxHr', log);
        input.value = '140';
        cancelWheelWhileFocused(input, { doc });
        input.focus();
        const event = wheelOverNumberField(doc, input, { deltaY: -100, cancelable: false });
        assert.equal(event.defaultPrevented, false, 'a non-cancelable event cannot be cancelled, whatever the listener does');
        assert.equal(input.value, '140', 'the spin button must find the field unfocused and step nothing');
        assert.equal(activeId(doc), 'BODY');
        assert.deepEqual(log, ['focus maxHr', 'blur maxHr']);
    });

    it('a scroll that began over the idle field cannot step it once a click or a Tab focuses it', () => {
        // Chromium keeps the rest of a scroll cancelable only when its first
        // wheel event was cancelled. Over the idle field that one is rightly
        // not cancelled, so the rest of the scroll arrives non-cancelable,
        // still aimed at the field; a click or a Tab from the Resting HR
        // focuses the field in the middle of it.
        for (const focusBy of ['click', 'Tab']) {
            const doc = fakeDocument();
            const log = [];
            const minHr = fakeElement(doc, 'minHr', log);
            const maxHr = fakeElement(doc, 'maxHr', log);
            maxHr.value = '140';
            cancelWheelWhileFocused(minHr, { doc });
            cancelWheelWhileFocused(maxHr, { doc });
            if (focusBy === 'Tab') minHr.focus();
            const first = wheelOverNumberField(doc, maxHr, { deltaY: -100 });
            assert.equal(first.defaultPrevented, false, `${focusBy}: over the idle field the wheel still scrolls the page`);
            maxHr.focus();
            for (let i = 0; i < 20; i++) wheelOverNumberField(doc, maxHr, { deltaY: -100, cancelable: false });
            assert.equal(maxHr.value, '140', `${focusBy}: the rest of the scroll must not raise the ceiling`);
            assert.equal(activeId(doc), 'BODY', `${focusBy}: the field is let go`);
            assert.equal(log.filter((entry) => entry === 'blur maxHr').length, 1, `${focusBy}: let go once, not once per event`);
            assert.equal(log.includes('blur minHr'), false, `${focusBy}: the Resting HR is not touched by a wheel over the Climax HR`);
        }
    });

    it('a wheel it cannot cancel over an idle field leaves the focus where it is', () => {
        const doc = fakeDocument();
        const minHr = fakeElement(doc, 'minHr');
        const maxHr = fakeElement(doc, 'maxHr');
        minHr.value = '70';
        maxHr.value = '140';
        cancelWheelWhileFocused(minHr, { doc });
        cancelWheelWhileFocused(maxHr, { doc });
        minHr.focus();
        for (let i = 0; i < 5; i++) wheelOverNumberField(doc, maxHr, { deltaY: -100, cancelable: false });
        assert.equal(activeId(doc), 'minHr', 'the wearer typing the Resting HR keeps it');
        assert.equal(maxHr.value, '140');
        assert.equal(minHr.value, '70');
    });

    it('a typed value is committed, not stepped, when the wheel lets go of the field', () => {
        // Wired as app.js wires it: the commit guard and the wheel guard on
        // one field. Leaving the field fires `change`, which persists what
        // was typed exactly as Tab would.
        const doc = fakeDocument();
        const input = fakeElement(doc, 'maxHr', [], { changeOnBlur: true });
        input.value = '140';
        const persisted = [];
        releaseFocusOnCommit(input, () => persisted.push(input.value), { doc });
        cancelWheelWhileFocused(input, { doc });
        wheelOverNumberField(doc, input, { deltaY: -100 });
        input.focus();
        input.value = '135';
        for (let i = 0; i < 10; i++) wheelOverNumberField(doc, input, { deltaY: -100, cancelable: false });
        assert.equal(input.value, '135', 'the typed ceiling stands, unstepped');
        assert.deepEqual(persisted, ['135'], 'and it is committed once');
        assert.equal(activeId(doc), 'BODY');
    });

    it('falls back to the global document when none is given', () => {
        const doc = fakeDocument();
        const input = fakeElement(doc, 'maxHr');
        const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
        globalThis.document = doc;
        try {
            cancelWheelWhileFocused(input);
            input.focus();
            assert.equal(input.dispatch('wheel', { deltaY: -100 }).defaultPrevented, true);
            input.blur();
            assert.equal(input.dispatch('wheel', { deltaY: -100 }).defaultPrevented, false);
        } finally {
            if (had) Object.defineProperty(globalThis, 'document', had);
            else delete globalThis.document;
        }
    });

    it('tolerates a missing element', () => {
        assert.doesNotThrow(() => cancelWheelWhileFocused(null, { doc: fakeDocument() }));
        assert.doesNotThrow(() => cancelWheelWhileFocused(undefined, { doc: fakeDocument() }));
    });
});

describe('releaseFocusOnCommit', () => {
    it('runs the change handler first, then lets go of the field', () => {
        const doc = fakeDocument();
        const log = [];
        const input = fakeElement(doc, 'maxHr', log);
        releaseFocusOnCommit(input, () => log.push('persisted'), { doc });
        input.focus();
        input.dispatch('change');
        assert.deepEqual(log, ['focus maxHr', 'persisted', 'blur maxHr'], 'the value is persisted before the field is released');
        assert.equal(activeId(doc), 'BODY', 'after Enter the next key goes to the page, not into the Climax HR');
    });

    it('releases the field on every commit, however it was made', () => {
        // Enter, a spinner click and leaving the field all arrive as `change`;
        // each one lets go, the handler runs once per commit.
        const doc = fakeDocument();
        let commits = 0;
        const input = fakeElement(doc, 'minHr');
        releaseFocusOnCommit(input, () => { commits += 1; }, { doc });
        for (let i = 0; i < 3; i++) {
            input.focus();
            input.dispatch('change');
            assert.equal(activeId(doc), 'BODY', `commit ${i + 1} must release the field`);
        }
        assert.equal(commits, 3);
    });

    it('registers nothing but a change listener: keystrokes keep the field', () => {
        const doc = fakeDocument();
        const log = [];
        const input = fakeElement(doc, 'maxHr', log);
        releaseFocusOnCommit(input, () => {}, { doc });
        assert.deepEqual(input.listeners.map((l) => l.type), ['change']);
        input.focus();
        for (const type of ['input', 'keydown', 'keyup', 'focus', 'wheel', 'pointerup']) input.dispatch(type);
        assert.equal(activeId(doc), 'maxHr', 'typing a number must not blur the field on every key');
        assert.deepEqual(log, ['focus maxHr']);
    });

    it('is harmless when the browser has already moved the focus on', () => {
        // Tab out of an edited field fires `change` after the focus has landed
        // on the next control; the blur must not strand it on the body.
        const doc = fakeDocument();
        const input = fakeElement(doc, 'maxHr');
        const next = fakeElement(doc, 'intensitySlider');
        let commits = 0;
        releaseFocusOnCommit(input, () => { commits += 1; }, { doc });
        input.focus();
        next.focus();
        input.dispatch('change');
        assert.equal(commits, 1, 'the handler still runs');
        assert.equal(activeId(doc), 'intensitySlider', 'the control the wearer tabbed to keeps the focus');
    });

    it('a handler that throws still releases the field, and the error still surfaces', () => {
        const doc = fakeDocument();
        const log = [];
        const input = fakeElement(doc, 'maxHr', log);
        releaseFocusOnCommit(input, () => { throw new Error('persist failed'); }, { doc });
        input.focus();
        assert.throws(() => input.dispatch('change'), /persist failed/);
        assert.equal(activeId(doc), 'BODY', 'a failed persist must not leave the focus in the field');
        assert.deepEqual(log, ['focus maxHr', 'blur maxHr']);
    });

    it('a window or tab switch in the middle of a number runs the handler and keeps the field', () => {
        // When the window or the tab loses the focus, Chromium fires `change`
        // on the focused field with document.hasFocus() already false, keeps
        // the field as the active element and gives the focus back to it when
        // the wearer returns. The wearer lowering the Climax HR from 140 types
        // "13", glances at another window, comes back, types the "5" and
        // presses Enter.
        const doc = fakeDocument();
        const log = [];
        const input = fakeElement(doc, 'maxHr', log);
        input.value = '140';
        releaseFocusOnCommit(input, () => log.push(`handler ${input.value}`), { doc });
        input.focus();
        input.value = '13';
        doc.focused = false;
        input.dispatch('change');
        assert.equal(activeId(doc), 'maxHr', 'the field must still be where the focus comes back to');
        assert.deepEqual(log, ['focus maxHr', 'handler 13'], 'the handler runs as it always did, and nothing blurs the field');
        doc.focused = true;
        input.value = '135';
        input.dispatch('change');
        assert.deepEqual(log, ['focus maxHr', 'handler 13', 'handler 135', 'blur maxHr'], 'the Enter after the return commits the finished number and lets go');
        assert.equal(activeId(doc), 'BODY');
    });

    it('asks whether the page has the focus when the change arrives, not at registration', () => {
        const doc = fakeDocument();
        const input = fakeElement(doc, 'minHr');
        doc.focused = false;
        releaseFocusOnCommit(input, () => {}, { doc });
        doc.focused = true;
        input.focus();
        input.dispatch('change');
        assert.equal(activeId(doc), 'BODY', 'registered while the page had no focus, a commit made with it still lets go');
        input.focus();
        doc.focused = false;
        input.dispatch('change');
        assert.equal(activeId(doc), 'minHr', 'a change that arrives without the focus keeps the field');
    });

    it('works with no handler at all', () => {
        const doc = fakeDocument();
        const input = fakeElement(doc, 'minHr');
        releaseFocusOnCommit(input, undefined, { doc });
        input.focus();
        assert.doesNotThrow(() => input.dispatch('change'));
        assert.equal(activeId(doc), 'BODY');
    });

    it('falls back to the global document when none is given', () => {
        // app.js passes none: the page's own document answers hasFocus().
        const doc = fakeDocument();
        const input = fakeElement(doc, 'maxHr');
        const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
        globalThis.document = doc;
        try {
            releaseFocusOnCommit(input, () => {});
            input.focus();
            doc.focused = false;
            input.dispatch('change');
            assert.equal(activeId(doc), 'maxHr');
            doc.focused = true;
            input.dispatch('change');
            assert.equal(activeId(doc), 'BODY');
        } finally {
            if (had) Object.defineProperty(globalThis, 'document', had);
            else delete globalThis.document;
        }
    });

    it('tolerates a missing element', () => {
        assert.doesNotThrow(() => releaseFocusOnCommit(null, () => {}));
        assert.doesNotThrow(() => releaseFocusOnCommit(undefined));
    });
});

describe('releaseFocusOnPointerUp', () => {
    it('lets go of the slider when the pointer is released', () => {
        const doc = fakeDocument();
        const slider = fakeElement(doc, 'intensitySlider');
        releaseFocusOnPointerUp(slider);
        // pointerdown is where the browser focuses a range input.
        slider.dispatch('pointerdown');
        slider.focus();
        slider.dispatch('pointermove');
        slider.dispatch('input');
        assert.equal(activeId(doc), 'intensitySlider', 'during the drag the slider is focused, as the browser leaves it');
        slider.dispatch('pointerup');
        assert.equal(activeId(doc), 'BODY', 'after the drag the arrow keys must not keep moving a motor speed');
    });

    it('registers a pointerup listener and nothing else, so keyboard use keeps the focus', () => {
        const doc = fakeDocument();
        const log = [];
        const slider = fakeElement(doc, 'intensitySlider', log);
        releaseFocusOnPointerUp(slider);
        assert.deepEqual(slider.listeners.map((l) => l.type), ['pointerup']);
        slider.focus();
        for (const type of ['keydown', 'keyup', 'input', 'change', 'pointerdown', 'pointermove', 'pointercancel', 'click', 'mouseup', 'touchend', 'focus']) {
            slider.dispatch(type);
            assert.equal(activeId(doc), 'intensitySlider', `${type} must leave a keyboard user in the slider`);
        }
        assert.deepEqual(log, ['focus intensitySlider'], 'no blur until a pointer is released');
    });

    it('does nothing when the slider is not focused', () => {
        const doc = fakeDocument();
        const other = fakeElement(doc, 'maxHr');
        const slider = fakeElement(doc, 'intensitySlider');
        releaseFocusOnPointerUp(slider);
        other.focus();
        slider.dispatch('pointerup');
        assert.equal(activeId(doc), 'maxHr', 'a release over the slider must not take the focus from another control');
    });

    it('tolerates a missing element', () => {
        assert.doesNotThrow(() => releaseFocusOnPointerUp(null));
        assert.doesNotThrow(() => releaseFocusOnPointerUp(undefined));
    });
});

// The behaviour above is proven on fakes; this pins that app.js really puts
// it on the three controls the rules are about, and on nothing that would
// undo them. The listeners themselves live in input-hygiene.js.
describe('app.js wires the guards to #minHr, #maxHr and #intensitySlider', () => {
    const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    const between = (startAnchor, endAnchor) => {
        const start = src.indexOf(startAnchor);
        assert.ok(start >= 0, `anchor not found in app.js: ${startAnchor}`);
        const end = src.indexOf(endAnchor, start + startAnchor.length);
        assert.ok(end > start, `end anchor not found after "${startAnchor}": ${endAnchor}`);
        return src.slice(start, end);
    };

    it('imports the three guards from input-hygiene.js', () => {
        assert.match(src, /import \{[^}]*\bcancelWheelWhileFocused\b[^}]*\} from '\.\/input-hygiene\.js';/);
        assert.match(src, /import \{[^}]*\breleaseFocusOnCommit\b[^}]*\} from '\.\/input-hygiene\.js';/);
        assert.match(src, /import \{[^}]*\breleaseFocusOnPointerUp\b[^}]*\} from '\.\/input-hygiene\.js';/);
    });

    it('the typed limits commit through releaseFocusOnCommit and refuse the wheel while focused', () => {
        const block = between('// Typed HR limits take effect immediately', '\n});');
        assert.match(block, /\['minHr', 'maxHr'\]\.forEach/);
        assert.match(block, /releaseFocusOnCommit\(input, \(\) => edited\(true\)\);/, 'the existing change handler runs inside the commit guard');
        assert.match(block, /cancelWheelWhileFocused\(input\);/);
        assert.doesNotMatch(block, /addEventListener\('change'/, 'the change handler must not be registered a second time');
        assert.equal((block.match(/edited\(true\)/g) || []).length, 1, 'one commit runs the handler once');
        assert.match(block, /addEventListener\('input', \(\) => edited\(false\)\);/, 'every keystroke still persists without blurring');
    });

    it('the intensity slider releases the focus on pointerup and on nothing else', () => {
        const block = between("const intensitySlider = document.getElementById('intensitySlider');", '// The hardware travel envelope');
        assert.match(block, /releaseFocusOnPointerUp\(intensitySlider\);/);
        assert.doesNotMatch(block, /intensitySlider[^\n]*\.blur\(\)/, 'no other blur on the slider: keyboard use is untouched');
        assert.doesNotMatch(src, /intensitySlider\??\.addEventListener\('key/, 'no key listener on the slider');
    });
});
