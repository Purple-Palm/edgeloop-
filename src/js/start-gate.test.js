// START / RESUME around The Handy's online check (start-gate.js). This
// sequencing is what keeps one press to one session, and STOP meaning STOP,
// while the API is answering. The page wiring on top of it (the button
// label, the banner, which answer counts as a yes) lives in app.js and is
// proved in the browser; the last three suites only check, against app.js's
// text, that the page cancels a waiting question where it has to, that it
// starts nothing while Came Early or Finished me stops the toys and asks,
// and that a start takes back the banner lines it outdates before its own
// cue.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStartGate } from './start-gate.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function counter() {
    const c = { starts: 0, refused: [] };
    c.start = () => { c.starts += 1; return true; };
    c.refuse = (verdict) => { c.refused.push(verdict); };
    return c;
}

describe('start gate', () => {
    it('starts only once the answer says yes', async () => {
        const gate = createStartGate();
        const answer = deferred();
        const c = counter();
        const run = gate.run({ ask: () => answer.promise, start: c.start, refuse: c.refuse });
        assert.equal(gate.isPending(), true, 'START is held while the question is out');
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(c.starts, 0, 'nothing starts before the answer');
        answer.resolve({ ok: true });
        assert.equal(await run, true);
        assert.equal(c.starts, 1);
        assert.equal(c.refused.length, 0);
        assert.equal(gate.isPending(), false);
    });

    it('a no starts nothing and is handed to refuse, once', async () => {
        const gate = createStartGate();
        const c = counter();
        const verdict = { ok: false, answer: { state: 'offline' } };
        assert.equal(await gate.run({ ask: async () => verdict, start: c.start, refuse: c.refuse }), false);
        assert.equal(c.starts, 0);
        assert.deepEqual(c.refused, [verdict]);
        assert.equal(gate.isPending(), false, 'START is free again after a refusal');
    });

    it('anything short of an explicit ok is a no, a question that throws included', async () => {
        const asks = [
            async () => undefined,
            async () => ({}),
            async () => ({ ok: 'yes' }),
            async () => ({ ok: 1 }),
            async () => { throw new Error('fetch blew up'); }
        ];
        for (const ask of asks) {
            const gate = createStartGate();
            const c = counter();
            assert.equal(await gate.run({ ask, start: c.start, refuse: c.refuse }), false);
            assert.equal(c.starts, 0, `started on ${ask}`);
            assert.equal(c.refused.length, 1);
            assert.equal(gate.isPending(), false);
        }
    });

    it('one question at a time: a second START while the first is out does nothing', async () => {
        const gate = createStartGate();
        const answer = deferred();
        const c = counter();
        let asks = 0;
        const ask = () => { asks += 1; return answer.promise; };
        const first = gate.run({ ask, start: c.start, refuse: c.refuse });
        const second = gate.run({ ask, start: c.start, refuse: c.refuse });
        assert.equal(await second, false);
        answer.resolve({ ok: true });
        assert.equal(await first, true);
        assert.equal(asks, 1, 'the device is asked once');
        assert.equal(c.starts, 1, 'one press, one session');
        assert.equal(c.refused.length, 0, 'the ignored press is not a refusal');
    });

    it('STOP while the question is out means no session, whatever the answer', async () => {
        const gate = createStartGate();
        const answer = deferred();
        const c = counter();
        const run = gate.run({ ask: () => answer.promise, start: c.start, refuse: c.refuse });
        assert.equal(gate.cancel(), true);
        assert.equal(gate.isPending(), false, 'START is free again at once');
        answer.resolve({ ok: true });
        assert.equal(await run, false);
        assert.equal(c.starts, 0);
        assert.equal(c.refused.length, 0, 'a cancelled question is not reported as a refusal either');
        assert.equal(gate.cancel(), false, 'nothing is left to cancel');
    });

    it('the answer to a cancelled question cannot start or clear the next one', async () => {
        const gate = createStartGate();
        const oldAnswer = deferred();
        const newAnswer = deferred();
        const c = counter();
        const oldRun = gate.run({ ask: () => oldAnswer.promise, start: c.start, refuse: c.refuse });
        gate.cancel();
        const newRun = gate.run({ ask: () => newAnswer.promise, start: c.start, refuse: c.refuse });
        oldAnswer.resolve({ ok: true });
        assert.equal(await oldRun, false);
        assert.equal(c.starts, 0);
        assert.equal(gate.isPending(), true, 'the new question is still out');
        newAnswer.resolve({ ok: true });
        assert.equal(await newRun, true);
        assert.equal(c.starts, 1);
    });

    it('with nothing to ask, the start happens inside the same call', () => {
        const gate = createStartGate();
        const c = counter();
        const run = gate.run({ ask: null, start: c.start, refuse: c.refuse });
        assert.equal(c.starts, 1, 'no wait between the press and the start when there is no Handy to ask');
        assert.equal(gate.isPending(), false);
        return run.then((started) => assert.equal(started, true));
    });

    it('resolves false when the start itself declines, after a yes', async () => {
        // The readiness gate is checked again once the answer lands: the
        // pulse or a toy can have gone while the question was out.
        const gate = createStartGate();
        assert.equal(await gate.run({ ask: async () => ({ ok: true }), start: () => false }), false);
        assert.equal(gate.isPending(), false);
    });
});

// STOP, Reset and the page going away (pagehide, freeze) each mean no
// session, whatever The Handy answers, so each drops a question still out.
// The page going away is the one a readiness check cannot stand in for: a
// frozen page is resumed with its answer still to land, and the answer
// would start the toys after a stretch nobody watched - the watchdog's
// auto-resume among them, which no longer reads as a watchdog pause while
// it waits. Came Early and Finished me drop it too: they stop the toys and
// keep them stopped until the wearer has answered, and an answer landing
// meanwhile would start the session while the press waits for the stop,
// or after the question - after Cancel, which leaves the session paused.
// app.js needs a DOM, so it is read as text, the way the other app.js
// guards in this suite are.
const APP = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function bodyFrom(anchor, end = '\n}') {
    const at = APP.indexOf(anchor);
    assert.ok(at >= 0, `${anchor} is gone - rename this guard with it`);
    return APP.slice(at, APP.indexOf(end, at));
}

describe('the page drops a waiting START on STOP, Reset, the page going away and a Came Early press', () => {
    it('STOP cancels it before the session is set down', () => {
        const body = bodyFrom('function stopSession(');
        const cancelAt = body.indexOf('startGate.cancel()');
        assert.ok(cancelAt >= 0, 'stopSession must cancel the start gate');
        assert.ok(cancelAt < body.indexOf("state.sessionStatus = 'IDLE'"), 'and before anything below it can throw');
    });

    it('Reset cancels it', () => {
        const body = bodyFrom("resetBtn?.addEventListener('click'", '\n});');
        assert.ok(body.includes('startGate.cancel()'), 'the Reset handler must cancel the start gate');
    });

    it('the page going away cancels it, whatever the session was doing', () => {
        const body = bodyFrom('function handlePageAway(');
        const cancelAt = body.indexOf('startGate.cancel()');
        assert.ok(cancelAt >= 0, 'handlePageAway must cancel the start gate');
        // A session waiting for its answer is neither running nor paused by
        // the watchdog, so no return but the remote page's (which has no
        // gate to cancel) may come before the cancel.
        const before = body.slice(0, cancelAt).replace(/\/\/.*$/gm, '');
        assert.match(before, /if \(isRemotePage\) return;/);
        assert.deepEqual(before.match(/\breturn\b[^;]*;/g), ['return;'], 'only the remote page may return before the cancel');
    });

    it('Came Early and Finished me cancel it as they stop the toys for their question', () => {
        const body = bodyFrom('function haltForTheQuestion(');
        const cancelAt = body.indexOf('startGate.cancel()');
        assert.ok(cancelAt >= 0, 'haltForTheQuestion must cancel the start gate');
        assert.ok(cancelAt < body.indexOf('pauseSession('), 'before the pause it makes');
    });
});

// Came Early and Finished me keep the toys stopped until the wearer has
// answered. A START or RESUME tapped while the press waited for the stop went
// to The Handy for its answer, was still waiting for it when the question
// opened, and started the toys once the question was answered: after Cancel,
// which leaves the session paused, and after OK in the minute after STOP. So
// startOrResumeWhenReady asks the press before anything else, with the tap's
// own time, by the rule the press judges a second press by
// (session-rules.createQuestionGate claims).
describe('a START or RESUME made while Came Early or Finished me runs starts nothing', () => {
    it('startOrResumeWhenReady asks the press first', () => {
        const body = bodyFrom('function startOrResumeWhenReady(').replace(/\/\/.*$/gm, '');
        assert.match(body, /^function startOrResumeWhenReady\(tappedAt\) \{\s*if \(pressQuestion\.claims\(tappedAt\)\) return Promise\.resolve\(false\);/);
    });

    it('the button hands it the time of the tap', () => {
        const body = bodyFrom("playPauseBtn?.addEventListener('click'", '\n});');
        assert.match(body, /startOrResumeWhenReady\(Number\.isFinite\(event\?\.timeStamp\) && event\.timeStamp > 0 \? event\.timeStamp : performance\.now\(\)\)/);
    });
});

// A session that runs outdates two lines on the banner: the one a refused
// START or RESUME left, and the watchdog's signal-loss report. The start
// takes both back before its own cue: the cue can put a voice notice on the
// banner - a saved voice this browser does not have, a voice that cannot
// speak here - and its latch (once a session, once a page for a missing
// voice) keeps it from being told again. Every notice is its own source's
// now (alert-banner.js), so neither take-back can take that one along; when
// it was appended under the watchdog's report or folded into the refusal's
// line, the two lines taken back after the cue took it with them in the
// same tick, before it was ever shown.
describe('a START takes back the lines it outdates before its own cue', () => {
    it('only once nothing can decline, and before any cue', () => {
        const body = bodyFrom('function startOrResumeSession(').replace(/\/\/.*$/gm, '');
        const lastDecline = body.lastIndexOf('return false;');
        const cueAt = body.indexOf('cueVoice(');
        assert.ok(lastDecline >= 0 && cueAt >= 0, 'startOrResumeSession has changed shape - rework this guard with it');
        for (const takeBack of ['withdrawStartRefusal();', "hideAlertBanner('hrSignal');"]) {
            const at = body.indexOf(takeBack);
            assert.ok(at > lastDecline, `${takeBack} must come once the start can no longer decline`);
            assert.ok(at < cueAt, `${takeBack} must come before the start's cue can put a voice notice on the banner`);
        }
    });
});
