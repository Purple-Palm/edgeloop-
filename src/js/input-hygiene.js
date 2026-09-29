// Focus and wheel hygiene for the controls that set a heart-rate limit or a
// motor speed. Each rule here stops a slip that was measured in the page:
//
//  * Chromium steps a focused <input type="number"> by one for every wheel
//    event it receives while the pointer rests over it (Blink's spin button
//    answers the wheel only while its field IsFocused(), and a smooth scroll
//    is many events), and the field's own input handler then persists each
//    step. A wearer who typed the Climax HR and scrolled the page from where
//    the pointer stopped raised the ceiling a beat at a time without seeing
//    it. Firefox turned the same stepping off by default in 130 (bug 1741469;
//    the reporter put accidental changes at about a hundred to one against
//    wanted ones). Here the wheel is cancelled only while the field is the
//    active element, so over an idle field it still scrolls the page; and a
//    wheel event that can no longer be cancelled, the rest of a scroll that
//    began over the idle field, lets go of the field instead.
//
//  * A committed value (Enter, a spinner click, or leaving the field) lets go
//    of the field. A number field that keeps the focus is where every key
//    pressed next lands: the arrow keys step the ceiling, and 'e', '+' and
//    '-' are legal number characters, so a key meant for the page is typed
//    into the Climax HR instead. The 'change' that a window or tab switch
//    fires while the page has no focus is not a commit, and the field is
//    kept for the wearer to come back to.
//
//  * A pointer drag leaves the intensity slider holding the keyboard focus,
//    so the arrow, Home, End and Page keys pressed afterwards keep moving a
//    motor speed long after the hand has left the mouse. The pointer release
//    lets go of the focus. A wearer who tabbed to the slider and steps it
//    with the arrow keys keeps the focus, because that focus was asked for.
//
// The element and the document are passed in, so all of it runs under
// node:test with fakes; app.js calls these on the real controls. A missing
// element is tolerated the way the `?.` listeners in app.js tolerate one.

// Cancel the wheel over `input` while it is the active element. The listener
// is registered non-passive because a passive listener's preventDefault() is
// ignored, and Chromium already treats wheel listeners on the window, the
// document and the body as passive unless told otherwise.
//
// When the cancel does not take, the field is let go instead. Chromium keeps
// the rest of a scroll cancelable only when its first wheel event was
// cancelled; when that one was not, because the field was idle as the scroll
// began over it, every later event of the same scroll arrives non-cancelable
// and still aimed at the field. A click or a Tab that focused the field during
// that scroll handed the rest of it to the spin button, which steps a focused
// field whatever preventDefault() says: measured in the page, one scroll took
// a Climax HR of 140 to between 218 and 268, and the engine's ceiling followed
// it as far as 250, the highest the sanitiser accepts. The spin button
// answers the wheel only while its field is focused, so a field that has been
// let go has nothing to step, and leaving it commits a typed value exactly as
// Tab does. Without this listener the wheel would still reach the field: an
// extension's wheel listener routes it there, and from Chromium 151 a focused
// number field asks for the wheel itself.
export function cancelWheelWhileFocused(input, { doc = globalThis.document } = {}) {
    if (!input) return;
    input.addEventListener('wheel', (event) => {
        if (doc.activeElement !== input) return;
        event.preventDefault();
        if (!event.defaultPrevented) input.blur();
    }, { passive: false });
}

// Run the field's own change handler, then release the focus. The handler
// runs first so a committed value is persisted before anything else happens,
// and it runs inside try/finally so a handler that throws cannot strand the
// focus in the field: the error still surfaces, the field is still let go.
// When the change came from leaving the field the browser has already moved
// the focus on, and the blur is a no-op.
//
// A 'change' that arrives while the page has no focus is not the wearer
// committing anything, and the field is not let go. When the window or the
// tab loses the focus, Chromium fires 'change' and then 'blur' on the focused
// field with document.hasFocus() already false, and keeps the field as
// document.activeElement so that the focus goes back to it when the wearer
// returns (hardware/handy-fields.js reads the same two events the same way).
// A blur from the page at that moment clears the focused element instead, and
// the wearer came back to no field at all: lowering the Climax HR from 140,
// the "13" typed before a glance at another window stayed in the field,
// refused, the "5" and the Enter typed after it went to the page, and the
// engine kept driving toward 140. The handler still runs on that 'change', as
// it always did; the release waits for a commit made with the page focused.
export function releaseFocusOnCommit(input, onCommit, { doc = globalThis.document } = {}) {
    if (!input) return;
    input.addEventListener('change', () => {
        const pageFocused = doc.hasFocus();
        try {
            if (typeof onCommit === 'function') onCommit();
        } finally {
            if (pageFocused) input.blur();
        }
    });
}

// Release the slider when the pointer is released, and only then: pointerup
// is the end of a mouse or touch drag, never of keyboard use.
export function releaseFocusOnPointerUp(slider) {
    if (!slider) return;
    slider.addEventListener('pointerup', () => slider.blur());
}
