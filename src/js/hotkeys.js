/**
 * The keyboard layer: which key asks for what, and when a key has to be left
 * to whatever the page or the browser already does with it.
 *
 * Wearers asked for it in so many words - "a hotkey for hitting pause would
 * be nice. takes too long to click the pause", and "Clicking is just too slow
 * for how fast orgasm happens after an edge". Two keys:
 *
 *  - Space pauses a running session, wherever the focus is short of a text
 *    field. It never resumes one and never starts one: RESUME and START are
 *    a click, or Enter on the focused button. Stopping the motors is safe
 *    from any target, so a pause needs to know nothing about how the focus
 *    got where it is. Starting them is not: as long as Space could resume, a
 *    Space the wearer meant for something else resumed a paused session
 *    behind an open dialog, one way after another - on the text of the
 *    Changelog reached with Tab, which Space scrolls, or on a toy's OFF
 *    button the page had just rebuilt away under the focus.
 *  - Escape closes the open modal exactly as its X does, discarding whatever
 *    the X discards.
 *
 * What makes this more than a lookup table is what a key already means
 * before the layer sees it, each measured in Chromium:
 *
 *  - A focused button presses itself on Space, when the key comes back up,
 *    after any Space keydown that was let through: a plain one, one with
 *    Shift, Control, Alt or Meta held, or an auto-repeat - and a repeat can
 *    be the first keydown the button ever sees, when Space went down in a
 *    text field and Tab carried the focus onto the button, or went down
 *    while the window was in the background. It presses itself as whatever
 *    it reads by then: a PAUSE held down while the session is stopped under
 *    it comes up as START. A button the mouse holds down presses itself on a
 *    Space release as well. So the transport button never gets Space from
 *    the browser at all: every Space keydown and keyup aimed at it is
 *    cancelled. A keydown that would have pressed it as PAUSE presses it
 *    once instead, from app.js, on the way down - on 1.1.0 each of those
 *    paused the session, and a click on START or RESUME can leave the
 *    focus on the button - and one that would have pressed START or RESUME
 *    presses nothing. That keeps one Space to one pause, and keeps START
 *    and RESUME out of reach of Space.
 *  - The auto-repeats and the release of a press the layer consumed are
 *    consumed with it, wherever the focus has gone since: a repeat that is
 *    let through arms the focused control, which presses itself on release.
 *  - A text field owns every key: Space and Escape are typing there.
 *  - Behind the age gate nothing happens. Behind the setup wizard Space still
 *    pauses a running session - the Guide button reopens the wizard
 *    mid-session, and stopping the motors is always allowed - but Escape
 *    does nothing there: none of the wizard's own buttons closes the modal
 *    under it.
 *
 * A key acts the moment it goes down, and a hand already on its way to the
 * mouse button cannot stop that fast. The click it was making lands a moment
 * later on whatever the key left under the pointer, and two rules keep that
 * click from undoing the key or going past it:
 *
 *  - Space pauses before a click aimed at PAUSE lands, and the click lands
 *    on RESUME: the motors stop and start again, against both of the
 *    wearer's inputs. So RESUME takes no press until it has been on the
 *    button for REACTION_MS (createResumeHold), whatever put it there -
 *    Space, the first click of a double-click on PAUSE, the partner's PAUSE.
 *  - Escape closes the dialog before a click aimed at its X lands, and the
 *    click lands on what the dialog covered - START or RESUME, a mode card,
 *    the intensity slider. So for REACTION_MS after Escape closes it, app.js
 *    lays a sheet over the page that takes every pointer press, except one on
 *    PAUSE or STOP while the session runs: stopping the motors is always
 *    allowed.
 *
 * Pure: no DOM. app.js reads the page, hands the facts in, and presses the
 * transport button or the modal's X, so a hotkey obeys exactly the locks and
 * checks a click on that button obeys.
 */

// Key (as readKeyEvent spells it) -> the action it asks for. What the action
// does in a given state is its planner's call (PLANNERS), so a new key is one
// line here and one planner there, behind the same guards.
export const HOTKEYS = Object.freeze({
    Space: 'pause',
    Escape: 'closeModal'
});

const LIVE_STATUSES = ['RUNNING', 'RAMPDOWN'];

// The input types nothing is typed into: switches, a slider and buttons.
// Every other type is a text field, and so is a type this list has never
// heard of - a browser treats an unknown type as text.
const UNTYPED_INPUTS = ['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'image'];

const IGNORE = Object.freeze({ action: null, consume: false });
// Cancelled, and nothing done in its place.
const SWALLOW = Object.freeze({ action: null, consume: true });
const PAUSE = Object.freeze({ action: 'pause', consume: true });
const CLOSE_MODAL = Object.freeze({ action: 'closeModal', consume: true });

function boundAction(key) {
    return Object.prototype.hasOwnProperty.call(HOTKEYS, key) ? HOTKEYS[key] : null;
}

// The facts of a KeyboardEvent the layer decides on, from anything shaped
// like one. The space bar's key is ' ', spelt 'Space' here.
export function readKeyEvent(e) {
    const ev = e && typeof e === 'object' ? e : {};
    const key = typeof ev.key === 'string' ? ev.key : '';
    return {
        key: key === ' ' ? 'Space' : key,
        repeat: ev.repeat === true,
        modified: Boolean(ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey)
    };
}

// What a key event is aimed at, from its target element (or anything shaped
// like one): 'text' where a keyboard types, 'transport' for the session's
// play / pause button, and 'other' for everything else - the page, a switch,
// a slider, a select, any other button, a link, the text of a dialog.
export function classifyKeyTarget(el, transport = null) {
    if (!el || typeof el !== 'object') return 'other';
    if (transport && el === transport) return 'transport';
    if (el.isContentEditable === true) return 'text';
    const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
    if (tag === 'TEXTAREA') return 'text';
    if (tag !== 'INPUT') return 'other';
    const type = typeof el.type === 'string' ? el.type.toLowerCase() : 'text';
    return UNTYPED_INPUTS.includes(type) ? 'other' : 'text';
}

// The guard every press goes through before its action is considered: an
// auto-repeat, and a press with Shift, Control, Alt or Meta held, is never a
// hotkey. The one Space the layer acts on without it is the transport's own
// (see PLANNERS.pause).
export function isPlainPress(press) {
    const p = press && typeof press === 'object' ? press : {};
    return !p.repeat && !p.modified;
}

// Per action: what a press that is not aimed at a text field does. `plain`
// is isPlainPress() of it.
const PLANNERS = {
    pause(c, target, plain) {
        // Behind the age gate the page is not the wearer's to operate yet.
        // Anywhere else, behind the wizard too, a running session may be
        // paused - but only through a transport this page may press: not a
        // viewer's locked one, and not one greyed out with the link to the
        // host lost.
        const pausable = c.overlay !== 'ageGate' && c.transportEnabled && LIVE_STATUSES.includes(c.sessionStatus);
        // On the transport the key is the button's own: any Space keydown it
        // would have pressed itself on is one press of PAUSE, and never one
        // of START or RESUME.
        if (target === 'transport') return pausable ? PAUSE : SWALLOW;
        // Anywhere else only a plain press is a hotkey. The page and its
        // controls keep every other Space, and every Space while nothing
        // runs, as they had it before there were hotkeys.
        return plain && pausable ? PAUSE : IGNORE;
    },
    closeModal(c, target, plain) {
        return plain && c.modalOpen && !c.overlay ? CLOSE_MODAL : IGNORE;
    }
};

// What one press should do.
//   press: readKeyEvent() of the keydown
//   ctx:   { target: classifyKeyTarget() of its target, sessionStatus,
//            transportEnabled: the play / pause button is live on this page,
//            modalOpen, overlay: 'ageGate' or 'wizard' while one is up (the
//            age gate when both are), else null }
// Returns { action, consume }. `action` is null, 'pause' or 'closeModal'.
// `consume` means the caller must cancel the event, so that nothing else -
// above all the focused button's own activation - acts on it.
export function planHotkey(press, ctx = {}) {
    const p = press && typeof press === 'object' ? press : {};
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const action = boundAction(p.key);
    if (!action) return IGNORE;
    const target = c.target || 'other';
    // A text field owns every key: Space and Escape are typing there.
    if (target === 'text') return IGNORE;
    return PLANNERS[action](c, target, isPlainPress(p));
}

// The transport's title and key shortcut while Space pauses the session,
// and only then: START and RESUME carry none (Space never starts or resumes
// a session), and neither does a button that is greyed out or locked.
const TRANSPORT_KEY_HINT = Object.freeze({
    title: 'Space pauses a running session (not while you are typing in a field). It never resumes or starts one: press RESUME, or Tab to it and press Enter.',
    shortcut: 'Space'
});

export function transportKeyHint({ sessionStatus, transportEnabled } = {}) {
    return transportEnabled && LIVE_STATUSES.includes(sessionStatus) ? TRANSPORT_KEY_HINT : null;
}

// How long after a key changed the page under the pointer a press there is
// still taken as aimed at what was there before. A click already on its way
// when the key went down lands well inside it, and a RESUME that waits half
// a second costs nothing, where one taken by accident starts the motors.
export const REACTION_MS = 500;

// RESUME takes no press until it has been on the transport for REACTION_MS.
// app.js reports every render of the transport - the status it shows, or
// null while it is greyed out - and asks held() before a press resumes the
// session. Only RESUME appearing starts the wait: the page re-renders a
// paused transport every second, and none of that makes it wait again. All
// times are from one monotonic clock.
export function createResumeHold() {
    let shows = null;
    let shownAt = -Infinity;
    return {
        rendered(status, now) {
            if (status === 'PAUSED' && shows !== 'PAUSED') shownAt = now;
            shows = status;
        },
        held(now) {
            return now - shownAt < REACTION_MS;
        }
    };
}

// The stateful half: which keys are being held after the layer consumed
// their press.
export function createHotkeyLayer() {
    const held = new Set();
    return {
        // `e`: the keydown (or anything shaped like it). `ctx`: planHotkey's.
        keyDown(e, ctx = {}) {
            const press = readKeyEvent(e);
            if (!boundAction(press.key)) return IGNORE;
            if (press.repeat && held.has(press.key)) return SWALLOW;
            // A fresh press is planned afresh, even if the release of the
            // last one never arrived (the window lost the focus mid-press).
            // A repeat the layer did not see begin is planned too: it is
            // never a hotkey, but aimed at the transport it is the button's
            // own - one pause while it reads PAUSE, swallowed otherwise - and
            // held so that its release is consumed as well.
            held.delete(press.key);
            const plan = planHotkey(press, ctx);
            if (plan.consume) held.add(press.key);
            return plan;
        },

        // `ctx`: { target } as for keyDown. The release of a consumed press
        // is consumed, and so is every Space release on the transport: a
        // Space that went down in a text field and comes up while the mouse
        // holds START down presses it on the way up, and the mouse presses it
        // again on its own release.
        keyUp(e, ctx = {}) {
            const key = readKeyEvent(e).key;
            const wasHeld = held.delete(key);
            const c = ctx && typeof ctx === 'object' ? ctx : {};
            return { consume: wasHeld || (key === 'Space' && c.target === 'transport') };
        }
    };
}
