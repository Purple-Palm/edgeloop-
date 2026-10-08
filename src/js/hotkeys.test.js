import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    HOTKEYS,
    readKeyEvent,
    classifyKeyTarget,
    isPlainPress,
    planHotkey,
    transportKeyHint,
    createHotkeyLayer,
    REACTION_MS,
    createResumeHold
} from './hotkeys.js';

// Element stand-ins: only what the layer reads.
function el(tagName, { type, contentEditable = false, id = '' } = {}) {
    return { tagName, type, id, isContentEditable: contentEditable };
}

const SPACE = { key: ' ', code: 'Space' };
const ESCAPE = { key: 'Escape', code: 'Escape' };
const STATUSES = ['IDLE', 'RUNNING', 'RAMPDOWN', 'PAUSED'];
const LIVE = ['RUNNING', 'RAMPDOWN'];
// Every status in which Space must not press the transport: there the press
// would be START or RESUME, or something this layer does not know.
const NOT_LIVE = ['IDLE', 'PAUSED', undefined, null, 'STARTING', ''];
const TARGETS = ['other', 'transport', 'text'];
const OVERLAYS = [null, 'wizard', 'ageGate'];
const MODIFIERS = [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }];
// Every Space keydown that is not a plain press. Each of them presses a
// focused button in Chromium when it is let through.
const STRAYS = [...MODIFIERS, { repeat: true }];

const IGNORED = { action: null, consume: false };
const SWALLOWED = { action: null, consume: true };
const PAUSES = { action: 'pause', consume: true };
const CLOSES = { action: 'closeModal', consume: true };

const RESUME_WORDING = 'Space pauses a running session (not while you are typing in a field). It never resumes or starts one: press RESUME, or Tab to it and press Enter.';

// planHotkey context: a live host transport, a running session, nothing
// open, the focus on the page.
function ctx(over = {}) {
    return {
        target: 'other',
        sessionStatus: 'RUNNING',
        transportEnabled: true,
        modalOpen: false,
        overlay: null,
        ...over
    };
}
const press = (e) => readKeyEvent(e);

// Every context the page can hand in.
function* everyContext() {
    for (const sessionStatus of [...STATUSES, undefined, 'STARTING']) {
        for (const target of TARGETS) {
            for (const transportEnabled of [true, false]) {
                for (const modalOpen of [false, true]) {
                    for (const overlay of OVERLAYS) yield { target, sessionStatus, transportEnabled, modalOpen, overlay };
                }
            }
        }
    }
}

describe('the key map', () => {
    it('knows four keys, and what each asks for', () => {
        assert.deepEqual(HOTKEYS, { Space: 'pause', Escape: 'closeModal', '[': 'offsetEarlier', ']': 'offsetLater' });
        assert.ok(Object.isFrozen(HOTKEYS));
    });

    it('reads the space bar as Space, every modifier and a repeat', () => {
        assert.deepEqual(readKeyEvent(SPACE), { key: 'Space', repeat: false, modified: false });
        assert.deepEqual(readKeyEvent(ESCAPE), { key: 'Escape', repeat: false, modified: false });
        for (const mod of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey']) {
            assert.equal(readKeyEvent({ ...SPACE, [mod]: true }).modified, true, mod);
        }
        assert.equal(readKeyEvent({ ...SPACE, repeat: true }).repeat, true);
        assert.equal(readKeyEvent({ key: 'Enter' }).key, 'Enter');
        assert.deepEqual(readKeyEvent(null), { key: '', repeat: false, modified: false });
        assert.deepEqual(readKeyEvent({ key: 32 }), { key: '', repeat: false, modified: false });
    });
});

describe('what a key is aimed at', () => {
    const transport = el('BUTTON', { id: 'sessionPlayPauseBtn' });

    it('singles out the transport button by identity', () => {
        assert.equal(classifyKeyTarget(transport, transport), 'transport');
        assert.equal(classifyKeyTarget(el('BUTTON', { id: 'sessionPlayPauseBtn' }), transport), 'other', 'a lookalike is just a button');
    });

    it('a textarea, a contenteditable and every input a keyboard types into is text, an unknown type included', () => {
        // The fields the app really has: #minHr / #maxHr are numbers,
        // #modalHandyInput and the share links are text, the phrase boxes
        // are textareas.
        const typed = ['number', 'text', 'search', 'email', 'url', 'tel', 'password', 'date', 'time', 'datetime-local',
            'month', 'week', 'file', 'color', 'hidden', 'something-new', 'NUMBER', '', undefined];
        for (const type of typed) {
            assert.equal(classifyKeyTarget(el('INPUT', { type }), transport), 'text', String(type));
        }
        assert.equal(classifyKeyTarget(el('TEXTAREA'), transport), 'text');
        assert.equal(classifyKeyTarget(el('DIV', { contentEditable: true }), transport), 'text');
    });

    it('a switch, a slider, a button, a select, a link, the text of a dialog and the page are all other', () => {
        for (const type of ['checkbox', 'radio', 'range', 'RANGE', 'button', 'submit', 'reset', 'image']) {
            assert.equal(classifyKeyTarget(el('INPUT', { type }), transport), 'other', type);
        }
        // SELECT: the Session Setup dropdowns. LABEL: the Import labels. DIV:
        // the Changelog text, which Chromium makes a Tab stop because it
        // scrolls. A: the footer links. SUMMARY, BODY, HTML: the rest.
        for (const tag of ['SELECT', 'BUTTON', 'LABEL', 'DIV', 'A', 'SUMMARY', 'BODY', 'HTML']) {
            assert.equal(classifyKeyTarget(el(tag), transport), 'other', tag);
        }
        for (const nothing of [null, undefined, 'BUTTON', 7]) {
            assert.equal(classifyKeyTarget(nothing, transport), 'other', String(nothing));
        }
    });
});

describe('the guard every press goes through', () => {
    it('only a fresh press with no modifier held is plain', () => {
        assert.equal(isPlainPress(press(SPACE)), true);
        assert.equal(isPlainPress(press(ESCAPE)), true);
        assert.equal(isPlainPress(press({ ...SPACE, repeat: true })), false);
        for (const mod of MODIFIERS) assert.equal(isPlainPress(press({ ...SPACE, ...mod })), false, JSON.stringify(mod));
        assert.equal(isPlainPress(null), true, 'nothing known against it');
    });
});

describe('Space pauses a running session', () => {
    it('from anything but a text field: the page, the transport, any control, the text of a dialog', () => {
        for (const status of LIVE) {
            for (const target of ['other', 'transport']) {
                assert.deepEqual(planHotkey(press(SPACE), ctx({ sessionStatus: status, target })), PAUSES, `${status} ${target}`);
            }
        }
    });

    it('with a dialog open, and behind the setup wizard the Guide button reopens mid-session', () => {
        for (const status of LIVE) {
            for (const target of ['other', 'transport']) {
                for (const overlay of [null, 'wizard']) {
                    assert.deepEqual(planHotkey(press(SPACE), ctx({ sessionStatus: status, target, overlay, modalOpen: true })), PAUSES, `${status} ${target} ${overlay}`);
                }
            }
        }
    });

    it('but not behind the age gate, and never through a transport this page may not press', () => {
        // A viewer's locked transport, or a controller's greyed out with the
        // link to the host lost.
        for (const status of LIVE) {
            for (const mods of [{}, ...STRAYS]) {
                const label = `${status} ${JSON.stringify(mods)}`;
                assert.deepEqual(planHotkey(press({ ...SPACE, ...mods }), ctx({ sessionStatus: status, overlay: 'ageGate' })), IGNORED, label);
                assert.deepEqual(planHotkey(press({ ...SPACE, ...mods }), ctx({ sessionStatus: status, transportEnabled: false })), IGNORED, label);
                assert.deepEqual(planHotkey(press({ ...SPACE, ...mods }), ctx({ sessionStatus: status, target: 'transport', overlay: 'ageGate' })), SWALLOWED, label);
                assert.deepEqual(planHotkey(press({ ...SPACE, ...mods }), ctx({ sessionStatus: status, target: 'transport', transportEnabled: false })), SWALLOWED, label);
            }
        }
    });

    it('and away from the transport a Space with a modifier held, or an auto-repeat, pauses nothing and is left to the page', () => {
        // Shift+Space scrolls the page back up; a switch or a button reached
        // with such a press keeps it, as on 1.1.0.
        for (const status of LIVE) {
            for (const mods of STRAYS) {
                for (const overlay of [null, 'wizard']) {
                    assert.deepEqual(planHotkey(press({ ...SPACE, ...mods }), ctx({ sessionStatus: status, overlay })), IGNORED, `${status} ${JSON.stringify(mods)} ${overlay}`);
                }
            }
        }
    });
});

describe('Space never resumes and never starts a session', () => {
    it('on the page and every control it is left alone, as before there were hotkeys', () => {
        // The Changelog text reached with Tab scrolls, a STOP reached with
        // Tab stops, a switch flips, the page scrolls: as on 1.1.0.
        for (const status of NOT_LIVE) {
            for (const mods of [{}, ...STRAYS]) {
                for (const overlay of OVERLAYS) {
                    for (const modalOpen of [false, true]) {
                        for (const transportEnabled of [true, false]) {
                            assert.deepEqual(
                                planHotkey(press({ ...SPACE, ...mods }), ctx({ sessionStatus: status, overlay, modalOpen, transportEnabled })),
                                IGNORED,
                                `${String(status)} ${JSON.stringify(mods)} ${overlay} modal:${modalOpen} enabled:${transportEnabled}`
                            );
                        }
                    }
                }
            }
        }
    });

    it('on the transport every Space is swallowed, so the button cannot press itself as START or RESUME', () => {
        for (const status of NOT_LIVE) {
            for (const mods of [{}, ...STRAYS]) {
                for (const overlay of OVERLAYS) {
                    for (const transportEnabled of [true, false]) {
                        assert.deepEqual(
                            planHotkey(press({ ...SPACE, ...mods }), ctx({ sessionStatus: status, target: 'transport', overlay, transportEnabled })),
                            SWALLOWED,
                            `${String(status)} ${JSON.stringify(mods)} ${overlay} enabled:${transportEnabled}`
                        );
                    }
                }
            }
        }
    });

    it('in any context the page can hand in: its only action is a pause, of a running session', () => {
        for (const c of everyContext()) {
            for (const mods of [{}, ...STRAYS]) {
                const plan = planHotkey(press({ ...SPACE, ...mods }), c);
                const label = JSON.stringify({ ...c, ...mods });
                assert.ok(plan.action === null || plan.action === 'pause', label);
                // A plain press from anything but a text field, or any Space
                // on the transport itself.
                const mayPause = LIVE.includes(c.sessionStatus) && c.transportEnabled && c.overlay !== 'ageGate'
                    && (c.target === 'transport' || (c.target !== 'text' && Object.keys(mods).length === 0));
                assert.equal(plan.action === 'pause', mayPause, label);
                if (plan.action) assert.equal(plan.consume, true, label);
                // Whatever the transport is not pressed for, it never gets.
                if (c.target === 'transport') assert.equal(plan.consume, true, label);
            }
        }
    });
});

describe('the transport button itself', () => {
    it('one plain Space while running is one pause, consumed so the button cannot add its own', () => {
        for (const status of LIVE) {
            assert.deepEqual(planHotkey(press(SPACE), ctx({ sessionStatus: status, target: 'transport' })), PAUSES, status);
        }
    });

    it('a Space with a modifier held, or a lone auto-repeat, is still one pause while it reads PAUSE', () => {
        // Each of them pressed the focused PAUSE on 1.1.0, and a click on
        // START or RESUME can leave the focus there. Let through, the button
        // would press itself on release as whatever it has become by then -
        // a PAUSE held down as the partner's STOP lands comes up as START -
        // so it is pressed on the way down instead, and the press consumed.
        for (const status of LIVE) {
            for (const mods of STRAYS) {
                for (const overlay of [null, 'wizard']) {
                    for (const modalOpen of [false, true]) {
                        assert.deepEqual(
                            planHotkey(press({ ...SPACE, ...mods }), ctx({ sessionStatus: status, target: 'transport', overlay, modalOpen })),
                            PAUSES,
                            `${status} ${JSON.stringify(mods)} ${overlay} modal:${modalOpen}`
                        );
                    }
                }
            }
        }
    });

    it('Escape on it is still Escape', () => {
        assert.deepEqual(planHotkey(press(ESCAPE), ctx({ target: 'transport', modalOpen: true })), CLOSES);
        assert.deepEqual(planHotkey(press(ESCAPE), ctx({ target: 'transport', modalOpen: false })), IGNORED);
    });
});

describe('text fields are always left alone', () => {
    it('for Space and Escape, in every state, behind every overlay, with any modifier or repeat', () => {
        for (const c of everyContext()) {
            if (c.target !== 'text') continue;
            for (const key of [SPACE, ESCAPE]) {
                for (const mods of [{}, ...STRAYS]) {
                    assert.deepEqual(planHotkey(press({ ...key, ...mods }), c), IGNORED, JSON.stringify({ ...c, key: key.key, ...mods }));
                }
            }
        }
    });
});

describe('Escape closes the open modal', () => {
    it('like its X, from any target but a text field, in every session state', () => {
        for (const target of ['other', 'transport']) {
            for (const status of [...STATUSES, undefined]) {
                for (const transportEnabled of [true, false]) {
                    assert.deepEqual(planHotkey(press(ESCAPE), ctx({ modalOpen: true, target, sessionStatus: status, transportEnabled })), CLOSES, `${target} ${String(status)}`);
                }
            }
        }
    });

    it('does nothing with no modal open, and nothing behind the age gate or the wizard', () => {
        assert.deepEqual(planHotkey(press(ESCAPE), ctx({ modalOpen: false })), IGNORED);
        for (const overlay of ['wizard', 'ageGate']) {
            for (const target of TARGETS) {
                for (const modalOpen of [false, true]) {
                    assert.deepEqual(planHotkey(press(ESCAPE), ctx({ modalOpen, overlay, target })), IGNORED, `${overlay} ${target} ${modalOpen}`);
                }
            }
        }
    });

    it('not with a modifier held, and not on an auto-repeat', () => {
        for (const mods of STRAYS) {
            assert.deepEqual(planHotkey(press({ ...ESCAPE, ...mods }), ctx({ modalOpen: true })), IGNORED, JSON.stringify(mods));
        }
    });

    it('and never pauses anything', () => {
        for (const c of everyContext()) {
            assert.notEqual(planHotkey(press(ESCAPE), c).action, 'pause', JSON.stringify(c));
        }
    });
});

describe('a key that is not bound', () => {
    it('is never touched: Enter keeps its own meaning, and RESUME and START with it', () => {
        for (const key of ['Enter', 'Tab', 'ArrowRight', 'k', 'p', 'F1', 'Spacebar', 'toString', 'constructor', '__proto__']) {
            for (const status of STATUSES) {
                for (const target of TARGETS) {
                    assert.deepEqual(planHotkey(press({ key }), ctx({ sessionStatus: status, modalOpen: true, target })), IGNORED, `${key} ${status} ${target}`);
                }
            }
        }
        assert.deepEqual(planHotkey(null, ctx()), IGNORED);
    });

    it('and with no context, nothing is known to be running or open', () => {
        assert.deepEqual(planHotkey(press(SPACE), null), IGNORED);
        assert.deepEqual(planHotkey(press(ESCAPE), undefined), IGNORED);
    });
});

describe('the transport key hint', () => {
    it('is there while Space pauses the session, and only then', () => {
        for (const status of LIVE) {
            assert.deepEqual(transportKeyHint({ sessionStatus: status, transportEnabled: true }), { title: RESUME_WORDING, shortcut: 'Space' }, status);
            assert.equal(transportKeyHint({ sessionStatus: status, transportEnabled: false }), null, `${status} locked`);
        }
        for (const status of NOT_LIVE) {
            assert.equal(transportKeyHint({ sessionStatus: status, transportEnabled: true }), null, `${String(status)}: START and RESUME carry none`);
        }
        assert.equal(transportKeyHint(), null);
    });

    it('agrees with what Space does from the page and on the button', () => {
        for (const status of [...STATUSES, undefined]) {
            for (const transportEnabled of [true, false]) {
                const hint = transportKeyHint({ sessionStatus: status, transportEnabled });
                for (const target of ['other', 'transport']) {
                    const plan = planHotkey(press(SPACE), ctx({ sessionStatus: status, transportEnabled, target }));
                    assert.equal(Boolean(hint), plan.action === 'pause', `${String(status)} ${transportEnabled} ${target}`);
                }
                for (const mods of STRAYS) {
                    const plan = planHotkey(press({ ...SPACE, ...mods }), ctx({ sessionStatus: status, transportEnabled, target: 'transport' }));
                    assert.equal(Boolean(hint), plan.action === 'pause', `${String(status)} ${transportEnabled} ${JSON.stringify(mods)}`);
                }
            }
        }
    });
});

describe('the layer: held keys', () => {
    const layer = () => createHotkeyLayer();
    const running = ctx();
    const paused = ctx({ sessionStatus: 'PAUSED' });
    const idle = ctx({ sessionStatus: 'IDLE' });

    it('one held Space is one pause: its repeats and its release are consumed too, wherever the focus goes', () => {
        const hk = layer();
        assert.deepEqual(hk.keyDown(SPACE, running), PAUSES);
        // The session is paused by now, and the focus may have moved on:
        // let through, a repeat arms whatever has the focus.
        assert.deepEqual(hk.keyDown({ ...SPACE, repeat: true }, paused), SWALLOWED);
        assert.deepEqual(hk.keyDown({ ...SPACE, repeat: true }, { ...paused, target: 'transport' }), SWALLOWED);
        assert.deepEqual(hk.keyDown({ ...SPACE, repeat: true }, { ...paused, target: 'text' }), SWALLOWED);
        assert.equal(hk.keyUp(SPACE, { target: 'other' }).consume, true);
        assert.equal(hk.keyUp(SPACE, { target: 'other' }).consume, false, 'released once');
    });

    it('a Space the layer left alone keeps its repeats and its release', () => {
        const hk = layer();
        assert.deepEqual(hk.keyDown(SPACE, paused), IGNORED);
        assert.deepEqual(hk.keyDown({ ...SPACE, repeat: true }, paused), IGNORED);
        assert.equal(hk.keyUp(SPACE, { target: 'other' }).consume, false);
    });

    it('but a repeat of it that reaches the transport is swallowed, with its release', () => {
        // Space went down in a text field (a character) and Tab carried the
        // focus onto START while it was held.
        const hk = layer();
        assert.deepEqual(hk.keyDown(SPACE, { ...idle, target: 'text' }), IGNORED);
        assert.deepEqual(hk.keyDown({ ...SPACE, repeat: true }, { ...idle, target: 'transport' }), SWALLOWED);
        assert.deepEqual(hk.keyDown({ ...SPACE, repeat: true }, { ...idle, target: 'transport' }), SWALLOWED);
        assert.equal(hk.keyUp(SPACE, { target: 'transport' }).consume, true);
    });

    it('a lone auto-repeat on a focused START or RESUME - Space already held as the window came up - is swallowed with its release', () => {
        for (const c of [idle, paused]) {
            const hk = layer();
            assert.deepEqual(hk.keyDown({ ...SPACE, repeat: true }, { ...c, target: 'transport' }), SWALLOWED, c.sessionStatus);
            // Held from here on, wherever the focus goes before the release.
            assert.equal(hk.keyUp(SPACE, { target: 'other' }).consume, true, c.sessionStatus);
        }
    });

    it('on a focused PAUSE the same lone auto-repeat is one pause, and the rest of that press is consumed', () => {
        // Also the repeat of a Space that went down in a text field, carried
        // onto PAUSE by Tab.
        const hk = layer();
        assert.deepEqual(hk.keyDown(SPACE, { ...running, target: 'text' }), IGNORED);
        assert.deepEqual(hk.keyDown({ ...SPACE, repeat: true }, { ...running, target: 'transport' }), PAUSES);
        // Paused by now: the button reads RESUME.
        assert.deepEqual(hk.keyDown({ ...SPACE, repeat: true }, { ...paused, target: 'transport' }), SWALLOWED);
        assert.deepEqual(hk.keyDown({ ...SPACE, repeat: true }, { ...paused, target: 'other' }), SWALLOWED);
        assert.equal(hk.keyUp(SPACE, { target: 'other' }).consume, true);
    });

    it('a modified Space held on PAUSE pauses on the way down, and cannot come up as START when the session is stopped under it', () => {
        // Let through, the button is armed as PAUSE; a partner's STOP or the
        // end of the rampdown turns it into START while the key is down, and
        // the release would press that. Instead the press paused at once,
        // and its repeats and its release, wherever the focus is by then,
        // press nothing.
        for (const mod of MODIFIERS) {
            const hk = layer();
            assert.deepEqual(hk.keyDown({ ...SPACE, ...mod }, { ...running, target: 'transport' }), PAUSES, JSON.stringify(mod));
            assert.deepEqual(hk.keyDown({ ...SPACE, ...mod, repeat: true }, { ...idle, target: 'transport' }), SWALLOWED, JSON.stringify(mod));
            assert.equal(hk.keyUp({ ...SPACE, ...mod }, { target: 'other' }).consume, true, JSON.stringify(mod));
            assert.equal(hk.keyUp({ ...SPACE, ...mod }, { target: 'other' }).consume, false, 'released once');
        }
    });

    it('every Space release on the transport is consumed, whatever pressed it', () => {
        // A Space that went down in a text field comes up while the mouse
        // holds START down: let through, it presses START, and the mouse
        // presses it again on its own release.
        const hk = layer();
        assert.equal(hk.keyUp(SPACE, { target: 'transport' }).consume, true);
        assert.equal(hk.keyUp({ ...SPACE, shiftKey: true }, { target: 'transport' }).consume, true);
        assert.equal(hk.keyUp(SPACE, { target: 'other' }).consume, false);
        assert.equal(hk.keyUp(SPACE, { target: 'text' }).consume, false);
        assert.equal(hk.keyUp(ESCAPE, { target: 'transport' }).consume, false);
        assert.equal(hk.keyUp(SPACE).consume, false);
    });

    it('a release that never arrived does not leak into the next press', () => {
        // The window lost the focus mid-press, and the keyup went elsewhere.
        const hk = layer();
        assert.deepEqual(hk.keyDown(SPACE, running), PAUSES);
        assert.deepEqual(hk.keyDown(SPACE, paused), IGNORED, 'a fresh press is planned afresh');
        assert.equal(hk.keyUp(SPACE, { target: 'other' }).consume, false);
    });

    it('two presses are two pauses, when the session was resumed between them', () => {
        const hk = layer();
        assert.deepEqual(hk.keyDown(SPACE, running), PAUSES);
        assert.equal(hk.keyUp(SPACE, { target: 'other' }).consume, true);
        assert.deepEqual(hk.keyDown(SPACE, running), PAUSES);
        assert.equal(hk.keyUp(SPACE, { target: 'other' }).consume, true);
    });

    it('one held Escape is one close', () => {
        const hk = layer();
        const open = ctx({ modalOpen: true });
        assert.deepEqual(hk.keyDown(ESCAPE, open), CLOSES);
        assert.deepEqual(hk.keyDown({ ...ESCAPE, repeat: true }, ctx({ modalOpen: false })), SWALLOWED);
        assert.equal(hk.keyUp(ESCAPE, { target: 'other' }).consume, true);
    });

    it('keys it does not bind pass straight through', () => {
        const hk = layer();
        for (const key of ['Enter', 'Tab', 'a']) {
            assert.deepEqual(hk.keyDown({ key }, { ...paused, target: 'transport' }), IGNORED, key);
            assert.equal(hk.keyUp({ key }, { target: 'transport' }).consume, false, key);
        }
    });
});

describe('RESUME takes no press the moment it appears', () => {
    // app.js reports each render of the transport: the status it shows, or
    // null while it is greyed out.
    const pausedAt = (t) => {
        const hold = createResumeHold();
        hold.rendered('RUNNING', 0);
        hold.rendered('PAUSED', t);
        return hold;
    };

    it('for half a second after it replaced PAUSE, and not a moment longer', () => {
        assert.equal(REACTION_MS, 500);
        // Space paused at 1000 ms; the click the wearer aimed at PAUSE in the
        // same breath lands 80 or 250 ms later, on RESUME.
        const hold = pausedAt(1000);
        for (const late of [0, 80, 250, REACTION_MS - 1]) assert.equal(hold.held(1000 + late), true, String(late));
        for (const late of [REACTION_MS, 700, 60_000]) assert.equal(hold.held(1000 + late), false, String(late));
    });

    it('holds nothing before RESUME has ever been shown', () => {
        const hold = createResumeHold();
        assert.equal(hold.held(0), false);
        assert.equal(hold.held(123_456), false);
        hold.rendered(null, 0);
        hold.rendered('IDLE', 10);
        hold.rendered('RUNNING', 20);
        assert.equal(hold.held(30), false);
    });

    it('the page re-rendering the paused transport every second does not make it wait again', () => {
        const hold = pausedAt(1000);
        for (const t of [1950, 2950, 3950]) {
            hold.rendered('PAUSED', t);
            assert.equal(hold.held(t + 10), false, String(t));
        }
    });

    it('every RESUME that appears afresh waits again', () => {
        // A second pause after a resume.
        const hold = pausedAt(0);
        hold.rendered('RUNNING', 2000);
        hold.rendered('PAUSED', 3000);
        assert.equal(hold.held(3100), true, 'second pause');
        assert.equal(hold.held(3500), false);
        // RESUME back after the transport was greyed out, waiting for the toy
        // or the pulse: a click aimed at the grey button lands on RESUME.
        hold.rendered(null, 5000);
        assert.equal(hold.held(5100), false, 'nothing to press while it waits');
        hold.rendered('PAUSED', 7000);
        assert.equal(hold.held(7100), true, 'back from waiting');
        assert.equal(hold.held(7500), false);
        // Straight from START: a partner's page copies the host's status from
        // each report, and a start and a pause between two reports read as
        // IDLE, then PAUSED.
        const remote = createResumeHold();
        remote.rendered('IDLE', 0);
        remote.rendered('PAUSED', 100);
        assert.equal(remote.held(200), true, 'from START');
    });
});

// The page side (app.js, index.html): which dialogs there are, and what
// reaches the transport. The layer above decides; these pin what it is
// handed and what is pressed for it.
describe('the page', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    const bodyFrom = (anchor, end = '\n}') => {
        const at = app.indexOf(anchor);
        assert.ok(at >= 0, `${anchor} is gone - rework this guard with it`);
        return app.slice(at, app.indexOf(end, at));
    };

    it('has three overlays: the one modal, the setup wizard and the age gate', () => {
        // The keydown listener reads these three (modalOpen, overlay). A
        // dialog of its own beside them would get neither Escape nor the
        // press sheet.
        const overlays = [...html.matchAll(/<div id="([A-Za-z]+)" class="fixed inset-0 /g)].map((m) => m[1]).sort();
        assert.deepEqual(overlays, ['ageOverlay', 'modalOverlay', 'wizardOverlay']);
        assert.match(bodyFrom("document.addEventListener('keydown'", '\n}, true);'),
            /modalOpen: overlayUp\(overlay\),[\s\S]*overlay: overlayUp\(ageOverlay\) \? 'ageGate' : \(overlayUp\(wizardOverlay\) \? 'wizard' : null\)/);
    });

    it('every dialog is a body of that modal, closed by its one X, which names its key', () => {
        const modal = html.slice(html.indexOf('<div id="modalOverlay"'), html.indexOf('<div id="wizardOverlay"'));
        const bodies = [...html.matchAll(/id="modalBody([A-Za-z]+)"/g)].map((m) => m[1]).sort();
        assert.deepEqual(bodies, ['Ble', 'Changelog', 'Handy', 'History', 'HrGuide', 'Intiface', 'Legal', 'Params', 'Partner', 'TCode', 'Vacuglide']);
        for (const body of bodies) assert.ok(modal.includes(`id="modalBody${body}"`), `${body} is outside the modal`);
        // Each one is opened by openModal, and nothing else is.
        const opened = [...new Set([...app.matchAll(/openModal\('([A-Za-z]+)'\)/g)].map((m) => m[1]))].sort();
        assert.deepEqual(opened, bodies);
        assert.equal(html.match(/id="modalCloseBtn"/g).length, 1);
        assert.match(html, /<button id="modalCloseBtn" aria-label="Close" title="Close \(Esc\)" aria-keyshortcuts="Escape"/);
    });

    it('Escape presses that X and raises the press sheet; Space presses the transport only while it reads PAUSE', () => {
        const keydown = bodyFrom("document.addEventListener('keydown'", '\n}, true);');
        assert.match(keydown, /plan\.action === 'closeModal'\) \{\s*document\.getElementById\('modalCloseBtn'\)\?\.click\(\);\s*raisePressSheet\(\);/);
        assert.match(keydown, /if \(state\.sessionStatus === 'RUNNING' \|\| state\.sessionStatus === 'RAMPDOWN'\) playPauseBtn\?\.click\(\);/);
        const sheet = bodyFrom('function raisePressSheet(');
        assert.match(sheet, /setTimeout\(\(\) => \{ pressSheet\.style\.display = 'none'; \}, REACTION_MS\)/);
    });

    it('the RESUME hold is asked only of a press on RESUME, and nothing that stops the toys or resumes them by itself goes through it', () => {
        const click = bodyFrom("playPauseBtn?.addEventListener('click'", '\n});');
        assert.match(click, /if \(state\.sessionStatus === 'PAUSED' && resumeHold\.held\(tappedAt\)\) return;/);
        assert.equal(app.match(/resumeHold\.held\(/g).length, 1, 'the hold is asked nowhere else');
        // Every render of the transport is reported, the greyed-out one as null.
        assert.match(bodyFrom('function renderTransport('), /resumeHold\.rendered\(status, performance\.now\(\)\);/);
        assert.match(bodyFrom('function renderTransportWaiting('), /resumeHold\.rendered\(null, performance\.now\(\)\);/);
        // STOP is its own button; the pause Came Early and Finished me make
        // for their question, and the resume when the pulse returns, never
        // press the transport.
        assert.ok(!bodyFrom("stopBtn?.addEventListener('click'", '\n});').includes('resumeHold'));
        assert.ok(!bodyFrom('function haltForTheQuestion(').includes('playPauseBtn'));
        const autoResume = bodyFrom('function resumeAfterSignalReturn(');
        assert.match(autoResume, /startOrResumeWhenReady\(\)/);
        assert.ok(!autoResume.includes('playPauseBtn'));
    });
});

describe('[ and ] move the script offset, and nothing else', () => {
    const KEY = (key, extra = {}) => ({ key, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...extra });
    const base = { target: 'other', sessionStatus: 'RUNNING', transportEnabled: true, modalOpen: false, overlay: null, offsetAvailable: true };

    it('nudges earlier and later while a script is loaded, in any session state', () => {
        for (const sessionStatus of ['IDLE', 'RUNNING', 'PAUSED', 'RAMPDOWN']) {
            assert.deepEqual(planHotkey(readKeyEvent(KEY('[')), { ...base, sessionStatus }), { action: 'offsetEarlier', consume: true });
            assert.deepEqual(planHotkey(readKeyEvent(KEY(']')), { ...base, sessionStatus }), { action: 'offsetLater', consume: true });
        }
    });

    it('does nothing without a script, in a text field, under a modal or an overlay, or with a modifier', () => {
        const none = { action: null, consume: false };
        assert.deepEqual(planHotkey(readKeyEvent(KEY('[')), { ...base, offsetAvailable: false }), none);
        assert.deepEqual(planHotkey(readKeyEvent(KEY('[')), { ...base, target: 'text' }), none);
        assert.deepEqual(planHotkey(readKeyEvent(KEY(']')), { ...base, modalOpen: true }), none);
        assert.deepEqual(planHotkey(readKeyEvent(KEY(']')), { ...base, overlay: 'ageGate' }), none);
        assert.deepEqual(planHotkey(readKeyEvent(KEY(']')), { ...base, overlay: 'wizard' }), none);
        assert.deepEqual(planHotkey(readKeyEvent(KEY('[', { ctrlKey: true })), base), none);
        assert.deepEqual(planHotkey(readKeyEvent(KEY('[', { repeat: true })), base), none);
    });

    it('never pauses, starts or resumes anything', () => {
        for (const key of ['[', ']']) {
            for (const sessionStatus of ['IDLE', 'RUNNING', 'PAUSED']) {
                const plan = planHotkey(readKeyEvent(KEY(key)), { ...base, sessionStatus });
                assert.notEqual(plan.action, 'pause');
            }
        }
    });

    it('Space still only pauses', () => {
        assert.deepEqual(planHotkey(readKeyEvent(KEY(' ')), { ...base, sessionStatus: 'PAUSED' }), { action: null, consume: false });
        assert.deepEqual(planHotkey(readKeyEvent(KEY(' ')), { ...base, sessionStatus: 'RUNNING' }), { action: 'pause', consume: true });
    });
});
