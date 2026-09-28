// The typed fields of the Handy and TCode panels - the two Travel Envelope
// guards, which both panels show, and The Handy's End-Stop Margin - and how
// what the browser reports about them reaches the rules in handy-protocol.js
// (envelopeFieldEvent, endMarginFieldEvent). Nothing here touches the DOM
// itself: a field is whatever has a `value`, addEventListener and blur(), and
// the page is whatever answers hasFocus(), so every path through this file
// runs under node:test against a fake of each. app.js hands in the real
// elements and the document, and does the writes.

import { envelopeFieldEvent, endMarginFieldEvent } from './handy-protocol.js';

// The DOM events a field is bound to. 'input' is the keystroke; 'change' is
// the browser's own commit (Enter, a spin-button or arrow-key step, leaving a
// field whose number changed); 'blur' is the wearer leaving the field, which
// the browser does not always report as 'change'; 'keydown' carries the Enter
// it does not always report either. A Travel Envelope field also takes its
// text on 'focus' (bindEnvelopeField).
export const FIELD_EVENTS = Object.freeze(['input', 'change', 'blur', 'keydown']);

// The field event - 'input', 'change' or 'blur' - that one DOM event on a
// Handy panel field stands for, or null for an event that means nothing to
// the field. `pageFocused` is document.hasFocus() at the time of the event.
//
// Enter is handed over as the commit it is, because Chromium's own 'change'
// does not always follow it. Blink fires it only when the text differs from
// what the field held when the wearer began editing it (TextControlElement::
// DispatchFormControlChangeEvent, against value_before_first_user_edit_).
// Type 80 over an Upper Guard of 85 - it narrows, so it takes effect at
// once - then 85 again, which widens and waits, and Enter fires nothing:
// the field read 85 over an envelope of 80 until the wearer left it, while
// the panel promises that Enter puts a waiting number in effect. A keydown
// handler runs before that 'change', which Chromium raises while handling
// the keypress, so when one does follow it repeats a commit already made,
// and a commit repeated is the same commit. Enter pressed while an input
// method is composing belongs to the composition, not to the field.
//
// A 'change' or 'blur' that arrives while the page has no focus is not the
// wearer leaving the field. When the window or the tab loses the focus - to
// another window, another tab, an alert() - Chromium fires 'change' and then
// 'blur' on the focused field, although the field stays document.activeElement
// and gets the focus back the moment the wearer returns
// (FocusController::FocusHasChanged, DispatchEventsOnWindowAndFocusedElement).
// Taken for a commit, that put a half-typed "9" in effect as an Upper Guard
// of 9 - the envelope collapsed to 0-10, the Lower Guard was overwritten and
// PUT /slide 0-10 went to the device - for a wearer who had done nothing but
// glance at another window between two digits. During those two events
// document.hasFocus() is false, because FocusController::SetFocused clears
// its focused flag before it dispatches them, and it is true for everything
// the wearer does to leave a field: Tab, a click elsewhere, Enter's own
// 'change', an arrow-key step, and the panel being hidden under the field.
// So the number waits, exactly as it would have had the wearer stayed, and
// is settled by whatever the wearer does next: Enter, leaving the field, or
// the panel being closed.
export function fieldEventOf(domEvent, pageFocused = true) {
    const type = domEvent ? domEvent.type : undefined;
    if (type === 'keydown') return domEvent.key === 'Enter' && !domEvent.isComposing ? 'change' : null;
    if (type === 'input') return 'input';
    if (type !== 'change' && type !== 'blur') return null;
    return pageFocused ? type : null;
}

// Bind one Travel Envelope field. `bound` is 'min' or 'max'; `page` is the
// document, asked whether the page has the focus; `envelope()` is the pair
// in effect; `put(env, commit)` puts a pair in effect and, on a commit,
// repaints the field with it. envelopeFieldEvent decides what each event may
// do - a keystroke only ever narrows, exactly as typed; a commit is normalised
// as it always was - and is handed the text the field held when the event
// arrived, taken when the field gains the focus and again after every event
// on it. A number field keeps its caret to itself, and this is how a
// keystroke typed onto the end is told from a digit replaced in the middle
// (envelopeWhileTyping). The text is taken on 'focus' rather than only on
// the first keystroke because the focus comes back after a window or tab
// switch with whatever the wearer had typed so far still in the field.
export function bindEnvelopeField(field, bound, { page, envelope, put }) {
    let before;
    field.addEventListener('focus', () => { before = field.value; });
    FIELD_EVENTS.forEach((type) => field.addEventListener(type, (domEvent) => {
        const event = fieldEventOf(domEvent, page.hasFocus());
        if (!event) return;
        const env = envelopeFieldEvent(envelope(), bound, field.value, event, { before });
        if (env) put(env, event !== 'input');
        before = field.value;
    }));
}

// Bind the End-Stop Margin field the same way. `margin()` is the margin in
// effect; `put(margin, commit)` puts one in effect and, on a commit, repaints
// the field with it. endMarginFieldEvent decides what each event may do: a
// keystroke can raise the margin once the number is finished, never lower
// it. No text is taken on focus, because the margin's own rule never needs
// it: the field takes 0-10, and every number it accepts either raises the
// margin or waits.
export function bindEndMarginField(field, { page, margin, put }) {
    FIELD_EVENTS.forEach((type) => field.addEventListener(type, (domEvent) => {
        const event = fieldEventOf(domEvent, page.hasFocus());
        if (!event) return;
        const next = endMarginFieldEvent(margin(), field.value, event);
        if (next !== null) put(next, event !== 'input');
    }));
}

// Before a panel is hidden: put back the number in effect into whichever of
// its `fields` is `active` (document.activeElement) and take the focus off it.
// `repaint` writes what is in effect into every field. Returns true when a
// field was settled.
//
// The Handy link or a heart-rate monitor finishing its connection closes the
// modal under a wearer who is typing. Chromium commits a field it hides - it
// fires 'change' and 'blur' on it, with the page focused - so "9" on its way
// to "95" would land as an Upper Guard of 9, the very collapse the keystroke
// rule exists to stop. Firefox and Safari keep the hidden field focused and
// would commit it on whatever the wearer clicked next. Pressing X or the
// backdrop moves the focus out of the field before the modal closes, and that
// commits it the way leaving any field does; a field still focused here holds
// a number the wearer never left, and it is discarded rather than applied.
export function settleFocusedField(fields, active, repaint) {
    if (!active || !fields.includes(active)) return false;
    repaint();
    active.blur();
    return true;
}
