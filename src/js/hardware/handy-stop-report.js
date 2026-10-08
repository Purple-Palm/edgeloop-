// Which Handys still owe a confirmed stop, and the one sentence the alert
// banner says about them. Pure: handy.js names the key of every stop the API
// did or did not confirm, app.js passes that on together with what the
// session does, and shows or withdraws the sentence this module gives.
//
// "The Handy did not confirm a stop and may still be moving" is about one
// device, the one the stop was sent to. It ends when that device is
// accounted for again, and nothing else ends it:
//  - a stop the API confirmed for that key, whoever sent it: a pause retried
//    until it went through, the job that keeps stopping an offline Handy,
//    Disconnect, a reconnect stopping the old device, or the stop that
//    verifies the key when it is connected again. The driver reports it
//    only once its own record of what that device's motor is owed is at
//    rest (handy.js noteStopConfirmed), so a stop that left before a start
//    to the device came back ends neither: that start may have reached the
//    device after it. Nor does a stop confirmed while a start to the device
//    is still on its way, which may reach it after that stop: the driver
//    reports that stop once the start has come back having moved nothing,
//    and otherwise the stop sent after the start is the one that counts;
//  - a live session that drives that very Handy again: START or RESUME with
//    it connected as primary or secondary, or given one of those roles while
//    the session runs. It is meant to move from there, and the session
//    answers for it: every stop the session asks of it is verified and
//    reported afresh when it is not confirmed, and a Handy that stops
//    answering is found offline within five ticks and chased with stops
//    again.
// A signal that names no key cannot settle it. The driver's "the failing
// call went through" (onError null) is given only when the path that failed
// last is the one that answers, for whichever key: settled by it, a stop
// confirmed after Disconnect had cleared the key, one confirmed while a
// reconnect was verifying another key, and the background stop of an
// offline Handy after a Connect had failed on /connected all left "may still
// be moving" standing over a device the API had just confirmed at rest. And
// every device is its own entry: with one key remembered, a second Handy's
// unconfirmed stop replaced the first one's, and the second one's
// confirmation then took the banner down while the first had never
// confirmed anything.

// A Handy driven over HSP (beat sync) only ever holds a few seconds of
// script, so a stop it did not confirm is bounded: the report says within
// how long it runs out (handy-hsp.js gives the seconds left in its buffer
// when the stop was given up on).

import { describeHspOwedStop } from './handy-hsp-protocol.js';

// The roles in which the session drives the Handy. On Off it gets no motion,
// so a session running does not account for it.
export const HANDY_DRIVEN_ROLES = Object.freeze(['primary', 'secondary']);

// The sentence for one device is the one the banner has always shown.
const ONE_OWED = 'The Handy did not confirm a stop and may still be moving: check the device.';

function keyOf(key) {
    return typeof key === 'string' ? key : '';
}

function detailOf(message) {
    return typeof message === 'string' ? message.trim() : '';
}

// One entry as kept: { detail, runsOutSeconds } (runsOutSeconds null for a
// HAMP stop), or the bare error string an older caller hands over.
function entryOf(value) {
    if (value && typeof value === 'object') {
        const n = Number(value.runsOutSeconds);
        return { detail: detailOf(value.detail), runsOutSeconds: value.runsOutSeconds === null || value.runsOutSeconds === undefined || !Number.isFinite(n) ? null : n };
    }
    return { detail: detailOf(value), runsOutSeconds: null };
}

// What the banner says about the stops in `owed` (key -> the error of its
// last unconfirmed stop, oldest first), or null when none is owed. Two
// devices are counted rather than folded into one "check the device": the
// wearer has to find and check each of them. The error in brackets is the
// newest one. A Handy on beat sync is told by how soon its buffer runs out.
export function describeOwedStops(owed) {
    const entries = owed instanceof Map ? [...owed.values()].map(entryOf) : [];
    if (entries.length === 0) return null;
    const newest = entries[entries.length - 1].detail;
    const hsp = entries.filter((e) => e.runsOutSeconds !== null);
    let lead;
    if (entries.length === 1) {
        lead = hsp.length === 1 ? describeHspOwedStop(hsp[0].runsOutSeconds) : ONE_OWED;
    } else {
        lead = entries.length === 2
            ? 'Two Handys did not confirm a stop and may still be moving: check both devices.'
            : `${entries.length} Handys did not confirm a stop and may still be moving: check each device.`;
        if (hsp.length > 0) {
            const longest = Math.max(...hsp.map((e) => e.runsOutSeconds));
            lead += ` ${hsp.length === 1 ? 'The one on beat sync runs' : 'Those on beat sync run'} out of script within ${Math.max(0, Math.ceil(longest))} s.`;
        }
    }
    return newest ? `${lead} (${newest})` : lead;
}

export function createHandyStopReport() {
    const owed = new Map();
    return {
        // The API did not confirm a stop sent to `key`. The newest error is
        // kept, and the key counts as reported last. `runsOutSeconds`: the
        // stop was an HSP stop, and the device's buffer runs out within
        // that many seconds.
        unconfirmed(key, message, { runsOutSeconds = null } = {}) {
            const k = keyOf(key);
            owed.delete(k);
            owed.set(k, { detail: detailOf(message), runsOutSeconds });
        },
        // The API confirmed a stop sent to `key`. True when that settled a
        // stop the key owed; a key that owed none changes nothing.
        confirmed(key) {
            return owed.delete(keyOf(key));
        },
        // A live session drives the Handy connected now when its role gives
        // it a channel, and then it owes no stop; any other key is another
        // device and still does. Asked at START or RESUME, and when the
        // wearer changes the role while the session runs. True when that
        // settled one.
        sessionDrives({ connected = false, key = '', role = '' } = {}) {
            if (!connected || !HANDY_DRIVEN_ROLES.includes(role)) return false;
            return owed.delete(keyOf(key));
        },
        owes(key) {
            return owed.has(keyOf(key));
        },
        get count() {
            return owed.size;
        },
        // The banner sentence, or null when no Handy owes a stop.
        sentence() {
            return describeOwedStops(owed);
        }
    };
}
