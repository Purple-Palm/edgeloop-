// START and RESUME, when something has to answer first.
//
// The Handy is driven through a cloud API, so the only way to know that the
// device is still there is to ask (GET /connected), and the answer takes a
// round trip. Without the question, a Handy switched off between sessions
// was driven for several seconds by START or RESUME before enough failed
// commands paused the session again. This is the bookkeeping around that
// wait; the question itself and everything the page shows belong to app.js.
// No DOM, no fetch and no timers, so all of it runs under node:test. Three
// rules:
//   * one question at a time: a second START while the first is being
//     answered does nothing, so one press can never become two sessions;
//   * STOP or Reset while the question is out cancels it: an answer that
//     arrives after the wearer changed their mind starts nothing;
//   * nothing to ask, no wait: the start happens inside the same call, as it
//     did before there was anything to ask.

export function createStartGate() {
    let pending = null;

    return {
        // True while a question is out. START / RESUME stay disabled meanwhile.
        isPending() {
            return pending !== null;
        },

        // Drop the question that is out, if any; its answer will start
        // nothing. Returns whether there was one.
        cancel() {
            if (pending === null) return false;
            pending.cancelled = true;
            pending = null;
            return true;
        },

        // `ask` resolves { ok: true } when the session may start and anything
        // else when it may not; null when there is nothing to ask. `start`
        // starts the session and returns whether it did. `refuse` receives
        // the answer that said no ({ ok: false, error } when asking threw).
        // Resolves whether the session was started.
        async run({ ask = null, start, refuse = () => {} } = {}) {
            if (typeof start !== 'function') throw new TypeError('run needs a start function');
            if (pending !== null) return false;
            if (typeof ask !== 'function') return Boolean(start());
            const question = { cancelled: false };
            pending = question;
            let answer;
            try {
                answer = await ask();
            } catch (error) {
                answer = { ok: false, error };
            } finally {
                if (pending === question) pending = null;
            }
            if (question.cancelled) return false;
            if (!answer || answer.ok !== true) {
                refuse(answer);
                return false;
            }
            return Boolean(start());
        }
    };
}
