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

// What the banner says about the stops in `owed` (key -> the error of its
// last unconfirmed stop, oldest first), or null when none is owed. Two
// devices are counted rather than folded into one "check the device": the
// wearer has to find and check each of them. The error in brackets is the
// newest one.
export function describeOwedStops(owed) {
    const entries = owed instanceof Map ? [...owed.values()] : [];
    if (entries.length === 0) return null;
    const newest = detailOf(entries[entries.length - 1]);
    const lead = entries.length === 1
        ? ONE_OWED
        : entries.length === 2
            ? 'Two Handys did not confirm a stop and may still be moving: check both devices.'
            : `${entries.length} Handys did not confirm a stop and may still be moving: check each device.`;
    return newest ? `${lead} (${newest})` : lead;
}

export function createHandyStopReport() {
    const owed = new Map();
    return {
        // The API did not confirm a stop sent to `key`. The newest error is
        // kept, and the key counts as reported last.
        unconfirmed(key, message) {
            const k = keyOf(key);
            owed.delete(k);
            owed.set(k, detailOf(message));
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
