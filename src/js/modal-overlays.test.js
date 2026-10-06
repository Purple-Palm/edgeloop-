// The age check and the setup wizard are modal. Neither was: Tab walked from
// the age check's two buttons straight into the cockpit behind it - Guide,
// History, the HR inputs, Force Orgasm, every hardware card - and Enter on a
// card opened its modal under the age check; behind the wizard the same. A
// classic script in index.html (id="overlayInertScript") now makes every
// other child of the body inert while either is up, moves the focus into it,
// and puts the focus back when it closes. This suite runs that script, as it
// stands in index.html, against a fake page.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

function overlayScript(html = HTML) {
    const match = /<script id="overlayInertScript">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match, 'index.html has no <script id="overlayInertScript">');
    return match[1];
}

// Just enough DOM for the script: elements with a class list, attributes,
// children and focus, a body, and a MutationObserver whose callbacks run
// when the test flushes them (in a browser: at the next microtask).
function fakePage() {
    const observers = [];
    let pending = false;
    const doc = { activeElement: null };

    class FakeElement {
        constructor(tag, { id = '', classes = [], attrs = {}, focusable = false } = {}) {
            this.tagName = tag.toUpperCase();
            this.id = id;
            this.children = [];
            this.parent = null;
            this.focusable = focusable;
            this.attrs = new Map(Object.entries(attrs));
            const set = new Set(classes);
            const changed = () => { if (observers.some((o) => o.targets.includes(this))) pending = true; };
            this.classList = {
                contains: (c) => set.has(c),
                add: (c) => { if (!set.has(c)) { set.add(c); changed(); } },
                remove: (c) => { if (set.delete(c)) changed(); }
            };
        }
        append(...kids) {
            for (const kid of kids) {
                kid.parent = this;
                this.children.push(kid);
            }
            if (this === doc.body) pending = true;
            return this;
        }
        get isConnected() {
            let el = this;
            while (el.parent) el = el.parent;
            return el === doc.body;
        }
        hasAttribute(name) { return this.attrs.has(name); }
        getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
        toggleAttribute(name, force) {
            if (force) this.attrs.set(name, '');
            else this.attrs.delete(name);
            return force;
        }
        contains(node) {
            for (let el = node; el; el = el.parent) if (el === this) return true;
            return false;
        }
        *descendants() {
            for (const kid of this.children) {
                yield kid;
                yield* kid.descendants();
            }
        }
        querySelector(selector) {
            const role = /^\[role="([^"]+)"\]$/.exec(selector);
            assert.ok(role, `the fake page only answers [role="..."], not ${selector}`);
            for (const el of this.descendants()) if (el.getAttribute('role') === role[1]) return el;
            return null;
        }
        // An element can take the focus when it is focusable, connected, and
        // neither it nor an ancestor is inert or hidden.
        focus() {
            if (!this.focusable || !this.isConnected) return;
            for (let el = this; el; el = el.parent) {
                if (el.hasAttribute('inert') || el.classList.contains('hidden')) return;
            }
            doc.activeElement = this;
        }
        get inert() {
            for (let el = this; el; el = el.parent) if (el.hasAttribute('inert')) return true;
            return false;
        }
    }

    class FakeMutationObserver {
        constructor(callback) {
            this.callback = callback;
            this.targets = [];
            observers.push(this);
        }
        observe(target) { this.targets.push(target); }
    }

    const el = (tag, opts, ...kids) => new FakeElement(tag, opts).append(...kids);
    const body = new FakeElement('body', { focusable: false });
    doc.body = body;
    doc.activeElement = body;

    const guideBtn = el('button', { id: 'guideBtn', focusable: true });
    const stopBtn = el('button', { id: 'sessionStopBtn', focusable: true });
    const page = el('div', { classes: ['max-w-6xl'] }, guideBtn, stopBtn);
    const modal = el('div', { id: 'modalOverlay', classes: ['hidden'] });
    const wizardPanel = el('div', { attrs: { role: 'dialog', tabindex: '-1' }, focusable: true },
        el('button', { id: 'wizardSkipBtn', focusable: true }));
    const wizard = el('div', { id: 'wizardOverlay', classes: ['hidden'] }, wizardPanel);
    const agePanel = el('div', { attrs: { role: 'dialog', tabindex: '-1' }, focusable: true },
        el('button', { id: 'ageConfirmBtn', focusable: true }));
    const age = el('div', { id: 'ageOverlay' }, agePanel);
    const script = el('script');
    body.append(page, modal, wizard, age, script);

    doc.getElementById = (id) => {
        for (const node of body.descendants()) if (node.id === id) return node;
        return null;
    };

    const run = (source = overlayScript()) => {
        pending = false;
        runInNewContext(source, { document: doc, MutationObserver: FakeMutationObserver });
    };
    // Deliver what the observers saw, as the browser does at the next
    // microtask; the script's own attribute writes are not class changes.
    const flush = () => {
        while (pending) {
            pending = false;
            for (const o of observers) o.callback([], o);
        }
    };
    const inertOf = () => body.children.filter((c) => c.tagName !== 'SCRIPT').map((c) => `${c.id || 'page'}:${c.hasAttribute('inert') ? 'inert' : 'live'}`);
    return { doc, body, page, modal, wizard, wizardPanel, age, agePanel, guideBtn, stopBtn, el, run, flush, inertOf, FakeElement };
}

describe('the age check and the setup wizard are modal (overlayInertScript)', () => {
    it('with the age check up on load, everything behind it is inert and the focus is in it', () => {
        const p = fakePage();
        p.run();
        assert.deepEqual(p.inertOf(), ['page:inert', 'modalOverlay:inert', 'wizardOverlay:inert', 'ageOverlay:live']);
        assert.equal(p.doc.activeElement, p.agePanel);
        p.guideBtn.focus();
        assert.equal(p.doc.activeElement, p.agePanel, 'a control behind the age check took the focus');
    });

    it('once the age check is passed, nothing is inert and the page works as before', () => {
        const p = fakePage();
        p.run();
        p.age.classList.add('hidden');
        p.flush();
        assert.deepEqual(p.inertOf(), ['page:live', 'modalOverlay:live', 'wizardOverlay:live', 'ageOverlay:live']);
        p.stopBtn.focus();
        assert.equal(p.doc.activeElement, p.stopBtn);
    });

    it('an age check already passed (hidden before the script runs) leaves the page alone', () => {
        const p = fakePage();
        p.age.classList.add('hidden');
        p.guideBtn.focus();
        p.run();
        assert.deepEqual(p.inertOf(), ['page:live', 'modalOverlay:live', 'wizardOverlay:live', 'ageOverlay:live']);
        assert.equal(p.doc.activeElement, p.guideBtn, 'the script moved the focus with no overlay up');
    });

    it('the wizard makes the page inert, takes the focus, and gives it back to the Guide button', () => {
        const p = fakePage();
        p.age.classList.add('hidden');
        p.run();
        p.guideBtn.focus();
        p.wizard.classList.remove('hidden');
        p.flush();
        assert.deepEqual(p.inertOf(), ['page:inert', 'modalOverlay:inert', 'wizardOverlay:live', 'ageOverlay:inert']);
        assert.equal(p.doc.activeElement, p.wizardPanel);
        assert.ok(p.stopBtn.inert && p.guideBtn.inert);
        p.wizard.classList.add('hidden');
        p.flush();
        assert.deepEqual(p.inertOf(), ['page:live', 'modalOverlay:live', 'wizardOverlay:live', 'ageOverlay:live']);
        assert.equal(p.doc.activeElement, p.guideBtn);
    });

    it('the first-run wizard right after the age check is modal too', () => {
        const p = fakePage();
        p.run();
        p.age.classList.add('hidden');
        p.flush();
        p.wizard.classList.remove('hidden');
        p.flush();
        assert.deepEqual(p.inertOf(), ['page:inert', 'modalOverlay:inert', 'wizardOverlay:live', 'ageOverlay:inert']);
        assert.equal(p.doc.activeElement, p.wizardPanel);
    });

    it('with both up, the age check is on top and the wizard is inert under it', () => {
        const p = fakePage();
        p.wizard.classList.remove('hidden');
        p.run();
        assert.deepEqual(p.inertOf(), ['page:inert', 'modalOverlay:inert', 'wizardOverlay:inert', 'ageOverlay:live']);
        assert.equal(p.doc.activeElement, p.agePanel);
        p.age.classList.add('hidden');
        p.flush();
        assert.deepEqual(p.inertOf(), ['page:inert', 'modalOverlay:inert', 'wizardOverlay:live', 'ageOverlay:inert']);
        assert.equal(p.doc.activeElement, p.wizardPanel);
    });

    it('whatever is added to the body while an overlay is up is inert, and freed with the rest', () => {
        const p = fakePage();
        p.run();
        const sheet = new p.FakeElement('div', { id: 'late' });
        p.body.append(sheet);
        p.flush();
        assert.ok(sheet.hasAttribute('inert'));
        p.age.classList.add('hidden');
        p.flush();
        assert.ok(!sheet.hasAttribute('inert'));
    });
});

describe('index.html marks both overlays as modal dialogs', () => {
    for (const id of ['ageOverlay', 'wizardOverlay']) {
        it(`#${id} holds a focusable role="dialog" aria-modal="true" panel`, () => {
            const start = HTML.indexOf(`id="${id}"`);
            assert.ok(start > 0, `index.html has no #${id}`);
            const panel = /<div\b[^>]*>/.exec(HTML.slice(HTML.indexOf('>', start) + 1));
            assert.ok(panel, `#${id} has no panel`);
            assert.match(panel[0], /role="dialog"/);
            assert.match(panel[0], /aria-modal="true"/);
            assert.match(panel[0], /tabindex="-1"/);
            assert.match(panel[0], /aria-label(?:ledby)?="[^"]+"/);
        });
    }

    it('the script runs after both overlays exist and before the modules', () => {
        const at = HTML.indexOf('id="overlayInertScript"');
        assert.ok(at > HTML.indexOf('id="ageOverlay"') && at > HTML.indexOf('id="wizardOverlay"'));
        assert.ok(at < HTML.indexOf('src="./src/js/app.js"'));
    });
});
