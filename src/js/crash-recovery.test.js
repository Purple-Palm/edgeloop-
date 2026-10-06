// Crash recovery with a fake storage and a fake lock manager. No DOM. The
// stop itself is handy.js's, tested in handy.test.js; a later suite runs the
// two together against a fake Handy API, and the last one guards the app.js
// call sites that put all of it in the page.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    LIVE_SESSION_PREFIX,
    PENDING_CRASH_STOPS_KEY,
    MAX_MARKER_HANDY_KEYS,
    MAX_PENDING_CRASH_STOPS,
    CRASH_HEADLINE,
    OTHER_PAGE_CRASH_HEADLINE,
    EARLIER_CRASH_HEADLINE,
    INTIFACE_CRASH_ADVICE,
    TCODE_CRASH_ADVICE,
    UNKNOWN_HARDWARE_NOTE,
    DRIVING_LOCK_PREFIX,
    liveSessionLockName,
    drivingLockName,
    liveSessionKey,
    newPageId,
    readLiveSession,
    readLiveSessions,
    createLiveSessionTracker,
    aliveOwners,
    isOwnerAlive,
    openPages,
    readPendingCrashStops,
    readPendingCrashStopPromises,
    addPendingCrashStops,
    clearPendingCrashStop,
    notePendingCrashStopGaveUp,
    planCrashRecovery,
    describeHandyCrashStop,
    describeCrashRecovery,
    drivesHandyNow,
    whenActivated,
    runCrashRecovery,
    createCrashRecovery,
    createCrashRecoveryStorage,
    staleLiveSessions,
    expiredEndedRecords,
    endedRecord,
    ENDED_RECORD_KEEP_MS
} from './crash-recovery.js';
import { createDurableMirror } from './durable-store.js';
import {
    HANDY_TIMINGS,
    stopHandyAfterCrash,
    resetHandyCrashStopsForTests,
    connectHandy,
    disconnectHandy,
    dispatchHandy,
    handyMayBeMoving
} from './hardware/handy.js';
import { HANDY_API_BASE } from './hardware/handy-protocol.js';

// Minimal localStorage stand-in that counts writes, can refuse them, and can
// be listed (length, key(i)) the way every page's marker is found. It starts
// from `initial`, and image() is a copy of what it holds now.
function fakeStorage(initial = []) {
    const map = new Map(initial);
    const store = {
        writes: 0,
        refuse: false,
        image: () => new Map(map),
        get length() { return map.size; },
        key: (i) => Array.from(map.keys())[i] ?? null,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => {
            if (store.refuse) {
                const err = new Error('QuotaExceededError');
                err.name = 'QuotaExceededError';
                throw err;
            }
            store.writes += 1;
            map.set(k, String(v));
        },
        removeItem: (k) => { map.delete(k); }
    };
    return store;
}

// The Web Locks behaviour this module relies on: a lock is held from its
// request until the callback's promise settles, query() lists what is held,
// and a page that dies loses its locks (crash()): the one it holds while it
// owns a marker, and the one it holds while its session drives a Handy.
function fakeLocks() {
    const held = new Map();
    const drop = (name) => {
        const n = (held.get(name) || 0) - 1;
        if (n > 0) held.set(name, n);
        else held.delete(name);
    };
    return {
        request(name, callback) {
            held.set(name, (held.get(name) || 0) + 1);
            return Promise.resolve()
                .then(() => callback({ name, mode: 'exclusive' }))
                .finally(() => { if (held.has(name)) drop(name); });
        },
        async query() {
            return { held: Array.from(held.keys(), (name) => ({ name, mode: 'exclusive' })), pending: [] };
        },
        crash(owner) {
            held.delete(liveSessionLockName(owner));
            for (const name of Array.from(held.keys())) if (name.startsWith(`${DRIVING_LOCK_PREFIX}${owner}:`)) held.delete(name);
        },
        holds(owner) { return held.has(liveSessionLockName(owner)); },
        names() { return Array.from(held.keys()); }
    };
}

// The Handy keys the page `owner` drives right now, as another page reads
// them (openPages), once the lock requests and releases made so far have
// landed.
async function drivenBy(owner, locks) {
    await tick();
    return (await openPages([owner], locks)).driving.get(owner) || [];
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for `cond()` to hold, for up to `ms`: a machine short of CPU can take
// longer than any fixed tick to run a pass.
async function until(cond, ms = 3000) {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await tick(5);
    return cond();
}

const HANDY = { handyKey: 'KEY-ONE-1234', intiface: false, tcode: false };

// A stop that answers at once, recording which keys it was asked for.
function fakeStop(answers = {}) {
    const asked = [];
    const stop = (key, { onUpdate } = {}) => {
        asked.push(key);
        const update = { final: true, detail: '', outcome: 'stopped', ...(answers[key] || {}) };
        if (onUpdate) onUpdate(update);
        return Promise.resolve(update);
    };
    stop.asked = asked;
    return stop;
}

// A stop whose answers the test hands out one at a time with answer(key,
// update), the way a Handy that stays offline keeps a stop going for
// minutes. It is over at the first final update.
function heldStop() {
    const asked = [];
    const waiting = new Map();
    const stop = (key, { onUpdate } = {}) => {
        asked.push(key);
        return new Promise((resolve) => {
            waiting.set(key, (update) => {
                if (onUpdate) onUpdate(update);
                if (!update.final) return;
                waiting.delete(key);
                resolve(update);
            });
        });
    };
    stop.answer = (key, update) => waiting.get(key)(update);
    stop.asked = asked;
    return stop;
}

// A page that started a session with `hardware` and then died.
function crashedPage(hardware = HANDY, owner = 'page-a') {
    const storage = fakeStorage();
    const locks = fakeLocks();
    createLiveSessionTracker({ owner, storage, locks }).note(hardware);
    locks.crash(owner);
    return { storage, locks };
}

// The one marker stored, whoever wrote it; fails when there is more than one.
function onlyMarker(storage) {
    const markers = readLiveSessions(storage);
    assert.ok(markers.length <= 1, `one marker expected, found ${markers.map((m) => m.owner).join(', ')}`);
    return markers[0] || null;
}

// The crash stop's rounds run on unref'd timers, which never keep a
// node:test process alive by themselves: wait on a timer of our own.
async function settle(promise) {
    const keepAlive = setInterval(() => {}, 5);
    try {
        return await promise;
    } finally {
        clearInterval(keepAlive);
    }
}

describe('the live-session marker', () => {
    it('is written before anything else, naming the page, what it drives, and holding its lock', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage, locks });
        assert.equal(tracker.note({ handyKey: 'KEY-ONE-1234', intiface: false, tcode: true }), true);
        const marker = readLiveSession(storage, 'page-a');
        assert.equal(marker.owner, 'page-a');
        assert.equal(marker.key, liveSessionKey('page-a'));
        assert.deepEqual(marker.handyKeys, ['KEY-ONE-1234']);
        assert.equal(marker.intiface, false);
        assert.equal(marker.tcode, true);
        assert.equal(marker.readable, true);
        await tick();
        assert.equal(await isOwnerAlive('page-a', locks), true);
    });

    it('only ever gains hardware in a session: a Handy that dropped off the link stays on it', () => {
        const storage = fakeStorage();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage });
        tracker.note(HANDY);
        // The Handy went offline (it may still be moving) and Intiface came in.
        tracker.note({ handyKey: '', intiface: true, tcode: false });
        tracker.note({ handyKey: '', intiface: false, tcode: false });
        const marker = readLiveSession(storage, 'page-a');
        assert.deepEqual(marker.handyKeys, ['KEY-ONE-1234']);
        assert.equal(marker.intiface, true);
    });

    it('writes only when something changed, so every engine tick can call it', () => {
        const storage = fakeStorage();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage });
        for (let i = 0; i < 200; i++) tracker.note(HANDY);
        assert.equal(storage.writes, 1);
        tracker.note({ ...HANDY, tcode: true });
        assert.equal(storage.writes, 2);
    });

    it('keeps every key a session switched to, the newest few past the cap', () => {
        const storage = fakeStorage();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage });
        const keys = ['KEY-1', 'KEY-2', 'KEY-3', 'KEY-4', 'KEY-5', 'KEY-6'];
        keys.forEach((handyKey) => tracker.note({ handyKey }));
        assert.deepEqual(readLiveSession(storage, 'page-a').handyKeys, keys.slice(-MAX_MARKER_HANDY_KEYS));
    });

    it('never stores something that is not a connection key', () => {
        const storage = fakeStorage();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage });
        tracker.note({ handyKey: 'bad\nkey' });
        tracker.note({ handyKey: '  KEY-TRIMMED  ' });
        assert.deepEqual(readLiveSession(storage, 'page-a').handyKeys, ['KEY-TRIMMED']);
    });

    it('says which Handy the session drives right now, which, unlike the hardware it names, comes and goes - with a lock, never a storage write', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage, locks });
        const read = () => readLiveSession(storage, 'page-a');
        tracker.note({ handyKey: 'KEY-ONE-1234' });
        assert.deepEqual(await drivenBy('page-a', locks), [], 'nothing sent to it yet');
        const writes = storage.writes;
        tracker.note({ handyKey: 'KEY-ONE-1234', driving: true });
        assert.deepEqual(await drivenBy('page-a', locks), ['KEY-ONE-1234']);
        // Paused: the pause's stop was confirmed.
        tracker.note({ handyKey: 'KEY-ONE-1234', driving: false });
        assert.deepEqual(await drivenBy('page-a', locks), []);
        assert.deepEqual(read().handyKeys, ['KEY-ONE-1234'], 'still named: the session drove it');
        tracker.note({ handyKey: 'KEY-ONE-1234', driving: true });
        // The link is gone: nothing is driven through it.
        tracker.note({ handyKey: '', driving: true });
        assert.deepEqual(await drivenBy('page-a', locks), []);
        assert.equal(storage.writes, writes, 'none of that wrote the marker');
        tracker.note({ handyKey: 'KEY-TWO-5678', driving: true });
        assert.deepEqual(await drivenBy('page-a', locks), ['KEY-TWO-5678']);
        assert.deepEqual(read().handyKeys, ['KEY-ONE-1234', 'KEY-TWO-5678']);
        assert.equal(storage.writes, writes + 1, 'a Handy that joins does');
        for (let i = 0; i < 20; i++) tracker.note({ handyKey: 'KEY-TWO-5678', driving: true });
        assert.deepEqual(locks.names().filter((name) => name.startsWith(DRIVING_LOCK_PREFIX)), [drivingLockName('page-a', 'KEY-TWO-5678')], 'asked for once, not on every tick');
        tracker.note({ handyKey: 'KEY-TWO-5678', driving: 'yes' });
        assert.deepEqual(await drivenBy('page-a', locks), [], 'only true is true');
        // A session that ends drives nothing, whatever the last dispatch said.
        tracker.note({ handyKey: 'KEY-TWO-5678', driving: true });
        tracker.clear();
        await tick();
        assert.deepEqual(locks.names().filter((name) => name.startsWith(DRIVING_LOCK_PREFIX)), []);
        assert.deepEqual(readLiveSessions(storage), [], 'and its marker is gone');
    });

    it('clear removes this page\'s marker and lets go of its lock', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage, locks });
        tracker.note(HANDY);
        await tick();
        assert.equal(tracker.clear(), true);
        assert.deepEqual(readLiveSessions(storage), []);
        await tick();
        assert.equal(await isOwnerAlive('page-a', locks), false);
    });

    it('clear never removes a marker another page wrote', () => {
        const storage = fakeStorage();
        createLiveSessionTracker({ owner: 'page-b', storage }).note(HANDY);
        // An idle second tab pressing STOP or Reset.
        assert.equal(createLiveSessionTracker({ owner: 'page-a', storage }).clear(), true);
        assert.equal(onlyMarker(storage).owner, 'page-b');
    });

    it('says when the browser refused the marker, and writes it on the next dispatch', () => {
        const storage = fakeStorage();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage });
        storage.refuse = true;
        assert.equal(tracker.note(HANDY), false);
        assert.equal(readLiveSession(storage, 'page-a'), null);
        storage.refuse = false;
        assert.equal(tracker.note(HANDY), true);
        assert.deepEqual(readLiveSession(storage, 'page-a').handyKeys, ['KEY-ONE-1234']);
    });

    it('the next session starts a marker of its own', () => {
        const storage = fakeStorage();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage });
        tracker.note({ handyKey: 'KEY-OLD', intiface: true });
        tracker.clear();
        tracker.note({ handyKey: 'KEY-NEW' });
        const marker = onlyMarker(storage);
        assert.deepEqual(marker.handyKeys, ['KEY-NEW']);
        assert.equal(marker.intiface, false);
    });

    it('is kept without a lock manager (an http:// page that is not localhost has none)', () => {
        const storage = fakeStorage();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage, locks: undefined });
        assert.equal(tracker.note(HANDY), true);
        assert.equal(onlyMarker(storage).owner, 'page-a');
        assert.equal(tracker.clear(), true);
        assert.deepEqual(readLiveSessions(storage), []);
    });

    it('a lock manager that throws is not asked again on every tick', () => {
        const storage = fakeStorage();
        let asked = 0;
        const locks = { request() { asked += 1; throw new Error('SecurityError'); }, query: async () => ({ held: [] }) };
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage, locks });
        for (let i = 0; i < 10; i++) tracker.note(HANDY);
        assert.equal(asked, 1);
        assert.equal(onlyMarker(storage).owner, 'page-a');
    });

    it('goes back at the next dispatch when a page that took this one for crashed removed it', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage, locks });
        tracker.note(HANDY);
        await tick();
        // A page without a lock manager cannot see that page A is open: it
        // hands A's key over, sends it a stop and removes A's marker.
        await runCrashRecovery({ storage, locks: undefined, savedHandyKey: '', stopHandy: fakeStop(), onReport: () => {} });
        assert.deepEqual(readLiveSessions(storage), []);
        assert.equal(tracker.note(HANDY), true);
        const marker = onlyMarker(storage);
        assert.equal(marker.owner, 'page-a');
        assert.deepEqual(marker.handyKeys, ['KEY-ONE-1234']);
        const writes = storage.writes;
        for (let i = 0; i < 50; i++) tracker.note(HANDY);
        assert.equal(storage.writes, writes, 'written again once, not on every tick');
        // So page A dying now is still recovered by the next page to open.
        locks.crash('page-a');
        const next = fakeStop();
        await runCrashRecovery({ storage, locks, savedHandyKey: '', stopHandy: next, onReport: () => {} });
        assert.deepEqual(next.asked, ['KEY-ONE-1234']);
    });

    it('writes a marker that cannot be read again, whole', () => {
        const storage = fakeStorage();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage });
        tracker.note({ ...HANDY, tcode: true });
        storage.setItem(liveSessionKey('page-a'), '{not json');
        assert.equal(tracker.note(HANDY), true);
        const marker = readLiveSession(storage, 'page-a');
        assert.deepEqual(marker.handyKeys, ['KEY-ONE-1234']);
        assert.equal(marker.tcode, true);
    });

    it('never reads, writes or removes the marker of another page: each session keeps its own', () => {
        // Page B crashed with the Handy; page A, open all along, starts a
        // session with an Intiface toy and stops it cleanly.
        const storage = fakeStorage();
        createLiveSessionTracker({ owner: 'page-b', storage }).note(HANDY);
        const before = readLiveSession(storage, 'page-b').raw;
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage });
        assert.equal(tracker.note({ intiface: true }), true);
        assert.deepEqual(readLiveSessions(storage).map((m) => m.owner).sort(), ['page-a', 'page-b']);
        assert.equal(tracker.note({ intiface: true, handyKey: 'KEY-TWO-5678' }), true);
        assert.equal(tracker.clear(), true);
        assert.equal(onlyMarker(storage).owner, 'page-b');
        assert.equal(readLiveSession(storage, 'page-b').raw, before, 'word for word');
    });

    it('tells whoever asked when a session starts, once per session, with its marker already written', () => {
        const storage = fakeStorage();
        const starts = [];
        const tracker = createLiveSessionTracker({
            owner: 'page-a',
            storage,
            onSessionStart: () => starts.push(readLiveSession(storage, 'page-a'))
        });
        tracker.note(HANDY);
        tracker.note(HANDY);
        tracker.note({ intiface: true });
        assert.equal(starts.length, 1);
        assert.deepEqual(starts[0].handyKeys, ['KEY-ONE-1234']);
        tracker.clear();
        tracker.note({ tcode: true });
        assert.equal(starts.length, 2, 'the next session is a new start');
        // A refused marker is still a session that started.
        const refused = fakeStorage();
        refused.refuse = true;
        let started = 0;
        createLiveSessionTracker({ owner: 'page-c', storage: refused, onSessionStart: () => { started += 1; throw new Error('boom'); } }).note(HANDY);
        assert.equal(started, 1, 'and a callback that throws does not reach the dispatch');
    });

    it('a page with no usable id still gets a marker and a lock of its own', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        const tracker = createLiveSessionTracker({ owner: 'not an id!', storage, locks });
        assert.match(tracker.owner, /^[0-9a-z]+$/);
        tracker.note(HANDY);
        await tick();
        assert.equal(onlyMarker(storage).owner, tracker.owner);
        assert.equal(await isOwnerAlive(tracker.owner, locks), true);
    });
});

describe('readLiveSessions', () => {
    it('nothing stored is no marker', () => {
        assert.deepEqual(readLiveSessions(fakeStorage()), []);
        assert.deepEqual(readLiveSessions(null), []);
        assert.equal(readLiveSession(fakeStorage(), 'page-a'), null);
        assert.equal(readLiveSession(fakeStorage(), null), null);
    });

    it('a marker that cannot be read still says a session was driving something, and whose it was', () => {
        for (const raw of ['{not json', '[1,2]', 'null', '42', '']) {
            const storage = fakeStorage();
            storage.setItem(liveSessionKey('page-a'), raw);
            const [marker] = readLiveSessions(storage);
            assert.equal(marker.readable, false, raw);
            assert.equal(marker.raw, raw);
            assert.equal(marker.owner, 'page-a', 'the owner is in the key');
            assert.deepEqual(marker.handyKeys, []);
        }
    });

    it('keeps only usable keys, once each, and no more than the cap', () => {
        const storage = fakeStorage();
        storage.setItem(liveSessionKey('page-a'), JSON.stringify({
            handy: ['K-1', 'K-1', 5, null, 'bad key', ' K-2 ', 'K-3', 'K-4', 'K-5'],
            intiface: 'yes',
            tcode: true
        }));
        const marker = readLiveSession(storage, 'page-a');
        assert.deepEqual(marker.handyKeys, ['K-1', 'K-2', 'K-3', 'K-4']);
        assert.equal(marker.intiface, false, 'only true is true');
        assert.equal(marker.tcode, true);
    });

    it('finds every page\'s marker and nothing else; a key that names no page has no owner', () => {
        const storage = fakeStorage();
        storage.setItem('edgeloop_live_sessions_backup', '{}');
        storage.setItem('handy_connection_key', 'KEY-ONE-1234');
        storage.setItem(liveSessionKey('page-a'), JSON.stringify({ handy: ['K-A'] }));
        storage.setItem(liveSessionKey('page-b'), JSON.stringify({ intiface: true }));
        storage.setItem(`${LIVE_SESSION_PREFIX}not a page`, JSON.stringify({ tcode: true }));
        const markers = readLiveSessions(storage);
        assert.deepEqual(markers.map((m) => m.owner), ['page-a', 'page-b', null]);
        assert.equal(markers[2].tcode, true);
    });
});

describe('openPages', () => {
    const snapshot = (held, pending = []) => ({ query: async () => ({ held: held.map((name) => ({ name })), pending: pending.map((name) => ({ name })) }) });

    it('reads the Handy a page drives right now only from a lock a page could have taken, and only for a page still open', async () => {
        const locks = snapshot([
            liveSessionLockName('page-a'), drivingLockName('page-a', 'K-1'),
            // A connection key may have a ':' in it.
            liveSessionLockName('page-b'), drivingLockName('page-b', 'K:2'), drivingLockName('page-b', 'K-2'),
            // Page C's own lock is gone: it is not open, whatever it held.
            drivingLockName('page-c', 'K-3'),
            // No key a page could have written.
            liveSessionLockName('page-d'), `${DRIVING_LOCK_PREFIX}page-d: K-4`, `${DRIVING_LOCK_PREFIX}page-d:bad key`, `${DRIVING_LOCK_PREFIX}page-d:`, `${DRIVING_LOCK_PREFIX}page-d`,
            // No page id a page could have.
            liveSessionLockName('page-e'), `${DRIVING_LOCK_PREFIX}not a page:K-5`,
            // Not asked about.
            liveSessionLockName('page-g'), drivingLockName('page-g', 'K-7')
        ], [liveSessionLockName('page-f'), drivingLockName('page-f', 'K-6')]);
        const { alive, driving } = await openPages(['page-a', 'page-b', 'page-c', 'page-d', 'page-e', 'page-f'], locks);
        assert.deepEqual(Array.from(alive).sort(), ['page-a', 'page-b', 'page-d', 'page-e', 'page-f']);
        assert.deepEqual(Object.fromEntries(driving), { 'page-a': ['K-1'], 'page-b': ['K:2', 'K-2'], 'page-f': ['K-6'] }, 'a lock asked for counts: the page is driving it');
    });

    it('never reads it from a marker: a marker that says which Handy it drives is not believed', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        // A dead page drove K-1; page B, open, has a marker that says it
        // drives K-1 too, but holds no lock that says so.
        createLiveSessionTracker({ owner: 'page-a', storage, locks }).note({ handyKey: 'K-1', driving: true });
        locks.crash('page-a');
        locks.request(liveSessionLockName('page-b'), () => new Promise(() => {}));
        storage.setItem(liveSessionKey('page-b'), JSON.stringify({ handy: ['K-1'], driving: 'K-1', intiface: false, tcode: false, gen: 1 }));
        const stop = fakeStop();
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: '', stopHandy: stop, onReport: () => {} });
        assert.deepEqual(stop.asked, ['K-1']);
        assert.deepEqual(result.plan.leftInUse, []);
    });

    it('cannot tell is nothing open and nothing driven', async () => {
        const held = [liveSessionLockName('page-a'), drivingLockName('page-a', 'K-1')];
        for (const locks of [undefined, {}, { query: async () => { throw new Error('boom'); } }, { query: () => new Promise(() => {}) }]) {
            const { alive, driving } = await openPages(['page-a'], locks, 20);
            assert.equal(alive.size + driving.size, 0);
        }
        const { alive, driving } = await openPages([], snapshot(held));
        assert.equal(alive.size + driving.size, 0, 'nothing asked, nothing read');
    });
});

describe('isOwnerAlive', () => {
    it('a page is alive while its lock is held or asked for', async () => {
        const name = liveSessionLockName('page-a');
        assert.equal(await isOwnerAlive('page-a', { query: async () => ({ held: [{ name }], pending: [] }) }), true);
        assert.equal(await isOwnerAlive('page-a', { query: async () => ({ held: [], pending: [{ name }] }) }), true);
        assert.equal(await isOwnerAlive('page-a', { query: async () => ({ held: [{ name: liveSessionLockName('page-b') }], pending: [] }) }), false);
    });

    it('cannot tell is not alive: the marker is then treated as a crash', async () => {
        assert.equal(await isOwnerAlive('page-a', undefined), false);
        assert.equal(await isOwnerAlive('page-a', {}), false);
        assert.equal(await isOwnerAlive('page-a', { query: async () => { throw new Error('boom'); } }), false);
        assert.equal(await isOwnerAlive('page-a', { query() { throw new Error('boom'); } }), false);
        assert.equal(await isOwnerAlive(null, { query: async () => ({ held: [{ name: liveSessionLockName('null') }] }) }), false);
    });

    it('asks once for every page it is given', async () => {
        let queries = 0;
        const locks = {
            query: async () => {
                queries += 1;
                return { held: [{ name: liveSessionLockName('page-a') }], pending: [{ name: liveSessionLockName('page-c') }] };
            }
        };
        const alive = await aliveOwners(['page-a', 'page-b', 'page-c', null], locks);
        assert.deepEqual(Array.from(alive).sort(), ['page-a', 'page-c']);
        assert.equal(queries, 1);
        assert.equal((await aliveOwners([], locks)).size, 0);
        assert.equal(queries, 1, 'no question when there is no page to ask after');
    });

    it('a lock manager that never answers cannot hold the stop back', async () => {
        const silent = { query: () => new Promise(() => {}) };
        const started = Date.now();
        assert.equal(await isOwnerAlive('page-a', silent, 30), false);
        assert.ok(Date.now() - started < 1000);
        const storage = fakeStorage();
        createLiveSessionTracker({ owner: 'page-a', storage }).note(HANDY);
        const stopHandy = fakeStop();
        const result = await runCrashRecovery({ storage, locks: silent, savedHandyKey: 'KEY-ONE-1234', stopHandy, onReport: () => {}, ownerQueryTimeoutMs: 30 });
        assert.equal(result.recovered, true);
        assert.deepEqual(stopHandy.asked, ['KEY-ONE-1234'], 'the stop still goes out');
    });
});

describe('drivesHandyNow', () => {
    it('only a running session whose driver cannot vouch that its Handy is stopped drives it', () => {
        const drives = (fields) => drivesHandyNow({ sessionStatus: 'RUNNING', handyKey: 'KEY-ONE-1234', mayBeMoving: true, ...fields });
        assert.equal(drives({}), true);
        assert.equal(drives({ sessionStatus: 'RAMPDOWN' }), true);
        // A pause sends a stop; an idle page has no session.
        for (const sessionStatus of ['PAUSED', 'IDLE', undefined]) assert.equal(drives({ sessionStatus }), false, String(sessionStatus));
        // Its driver saw a stop confirmed: a stop from another page takes nothing from it.
        assert.equal(drives({ mayBeMoving: false }), false);
        assert.equal(drives({ mayBeMoving: 'yes' }), false, 'only true is true');
        // No link, or not a key.
        assert.equal(drives({ handyKey: '' }), false);
        assert.equal(drives({ handyKey: 'bad key' }), false);
        // A frozen page runs nothing until it is resumed.
        assert.equal(drives({ frozen: true }), false);
        assert.equal(drivesHandyNow(), false);
    });
});

describe('planCrashRecovery', () => {
    const marker = (fields) => ({ raw: 'x', owner: 'page-a', handyKeys: [], intiface: false, tcode: false, readable: true, ...fields });

    it('no marker, nothing to do', () => {
        assert.equal(planCrashRecovery({ marker: null, savedHandyKey: 'K-1' }), null);
    });

    it('the usual case: the key saved here is the key the session drove', () => {
        const plan = planCrashRecovery({ marker: marker({ handyKeys: ['K-1'] }), savedHandyKey: 'K-1' });
        assert.deepEqual(plan.handy, [{ key: 'K-1', saved: true, driven: true }]);
        assert.equal(plan.intiface, false);
        assert.equal(plan.tcode, false);
        assert.equal(plan.known, true);
    });

    it('the key the session drove gets the stop even when another one is saved now, and the saved one does too', () => {
        // A failed Connect with a new key saves it while the old link drives on.
        const plan = planCrashRecovery({ marker: marker({ handyKeys: ['K-DRIVEN'] }), savedHandyKey: 'K-TYPED' });
        assert.deepEqual(plan.handy, [
            { key: 'K-DRIVEN', saved: false, driven: true },
            { key: 'K-TYPED', saved: true, driven: false }
        ]);
    });

    it('a session that never drove The Handy still sends the saved key a stop', () => {
        const plan = planCrashRecovery({ marker: marker({ intiface: true }), savedHandyKey: 'K-1' });
        assert.deepEqual(plan.handy, [{ key: 'K-1', saved: true, driven: false }]);
        assert.equal(plan.intiface, true);
        assert.equal(plan.tcode, false);
        assert.equal(planCrashRecovery({ marker: marker({ intiface: true }), savedHandyKey: '' }).handy.length, 0);
    });

    it('a marker that says nothing usable counts the saved key as driven and brings every advice', () => {
        for (const m of [marker({ readable: false }), marker({})]) {
            const plan = planCrashRecovery({ marker: m, savedHandyKey: 'K-1' });
            assert.deepEqual(plan.handy, [{ key: 'K-1', saved: true, driven: true }]);
            assert.equal(plan.intiface, true);
            assert.equal(plan.tcode, true);
            assert.equal(plan.known, false);
        }
    });

    it('a saved key that is not a key is never sent', () => {
        const plan = planCrashRecovery({ marker: marker({ intiface: true }), savedHandyKey: 'bad key' });
        assert.deepEqual(plan.handy, []);
    });

    it('adds the stops earlier sessions still owe, each once, and the saved key only with a marker', () => {
        // No marker: the last session ended cleanly, so the key saved now is left alone.
        const owedOnly = planCrashRecovery({ marker: null, savedHandyKey: 'K-SAVED', pending: ['K-OLD'] });
        assert.equal(owedOnly.lastSession, false);
        assert.deepEqual(owedOnly.handy, []);
        assert.deepEqual(owedOnly.earlier, [{ key: 'K-OLD', saved: false, driven: true }]);
        assert.equal(owedOnly.intiface, false);
        assert.equal(owedOnly.tcode, false);
        // A key the last session drove as well goes out once, with that session.
        const both = planCrashRecovery({ marker: marker({ handyKeys: ['K-1'] }), savedHandyKey: 'K-1', pending: ['K-1', 'K-OLD'] });
        assert.equal(both.lastSession, true);
        assert.deepEqual(both.handy, [{ key: 'K-1', saved: true, driven: true }]);
        assert.deepEqual(both.earlier, [{ key: 'K-OLD', saved: false, driven: true }]);
        assert.equal(planCrashRecovery({ marker: null, savedHandyKey: 'K-1', pending: [] }), null);
    });

    it('a saved key an earlier session still owes a stop is reported with that session', () => {
        const plan = planCrashRecovery({ marker: marker({ intiface: true }), savedHandyKey: 'K-OLD', pending: ['K-OLD'] });
        assert.deepEqual(plan.handy, [], 'not as a key the last session left alone');
        assert.deepEqual(plan.earlier, [{ key: 'K-OLD', saved: true, driven: true }]);
    });
});

describe('describeCrashRecovery', () => {
    const plan = (fields) => ({ lastSession: true, handy: [{ key: 'K-1', saved: true, driven: true }], intiface: false, tcode: false, known: true, earlier: [], ...fields });
    const withUpdate = (update) => describeCrashRecovery(plan(), new Map([['K-1', update]]));

    it('always says the last session did not end cleanly', () => {
        assert.ok(describeCrashRecovery(plan()).startsWith(CRASH_HEADLINE));
        assert.match(CRASH_HEADLINE, /did not end cleanly/);
        assert.equal(describeCrashRecovery(null), '');
    });

    it('says a stop is on its way, and then what it returned', () => {
        assert.match(describeCrashRecovery(plan()), /EdgeLoop is sending The Handy \(key ending K-1\) a stop with the connection key it found saved here\.\.\./);
        const stopped = withUpdate({ outcome: 'stopped', detail: 'result 0', final: true });
        assert.match(stopped, /confirmed it \(result 0\): it was still moving and has stopped/);
        const accepted = withUpdate({ outcome: 'stopped', detail: '', final: true });
        assert.match(accepted, /confirmed the stop\./);
        assert.doesNotMatch(accepted, /still moving/, 'only a result of 0 says it was moving');
        assert.match(withUpdate({ outcome: 'already-stopped', detail: 'result 1', final: true }), /answered that it was already stopped \(result 1\)/);
        assert.match(withUpdate({ outcome: 'not-hamp', detail: 'error 2002, No such method', final: true }), /not in HAMP mode \(error 2002, No such method\)/);
        assert.match(withUpdate({ outcome: 'connected', detail: '', final: true }), /connected again/);
        // This page's own link: nothing was sent from here, and no stop is claimed.
        const linked = withUpdate({ outcome: 'linked', detail: '', final: true });
        const line = 'The Handy (key ending K-1) is connected on this page: EdgeLoop stops it through that connection, unless the session on this page is driving it.';
        assert.equal(linked, `${CRASH_HEADLINE} ${line}`);
    });

    it('a stop that did not get through says so, what to do, and what EdgeLoop does next', () => {
        const offline = withUpdate({ outcome: 'offline', detail: 'Device not connected', final: false });
        assert.match(offline, /offline \(Device not connected\), so the stop could not reach it/);
        assert.match(offline, /If The Handy \(key ending K-1\) is moving, switch it off\./);
        assert.match(offline, /keeps sending the stop for 5 minutes/);
        const gaveUp = withUpdate({ outcome: 'failed', detail: 'HTTP 503', final: true });
        assert.match(gaveUp, /the stop was not confirmed \(HTTP 503\)/);
        assert.match(gaveUp, /switch it off/);
        assert.match(gaveUp, /stopped sending it after 5 minutes and sends it again the next time it opens/);
    });

    it('says which key is which, and which one the session drove', () => {
        const two = plan({ handy: [{ key: 'KEY-AAAA', saved: false, driven: true }, { key: 'KEY-BBBB', saved: true, driven: false }] });
        const text = describeCrashRecovery(two);
        assert.match(text, /The Handy \(key ending AAAA\) a stop with the connection key that session used\.\.\./);
        assert.match(text, /The Handy \(key ending BBBB\) a stop with the connection key it found saved here \(that session was not driving it\)\.\.\./);
    });

    it('names the Handy by its key even when it is the only one, so no answer about it reads as news about another', () => {
        // The report keeps changing for minutes. Meanwhile the wearer can
        // connect a second Handy, whose own warnings say "The Handy" too: a
        // late "has stopped" about the old one must not read as the new one.
        const one = plan({ handy: [{ key: 'KEY-OLD-0001', saved: true, driven: true }] });
        const stopped = describeCrashRecovery(one, new Map([['KEY-OLD-0001', { outcome: 'stopped', detail: 'result 0', final: true }]]));
        assert.match(stopped, /EdgeLoop sent The Handy \(key ending 0001\) a stop with the connection key it found saved here\. The Handy API confirmed it \(result 0\): it was still moving and has stopped\./);
        const offline = describeCrashRecovery(one, new Map([['KEY-OLD-0001', { outcome: 'offline', detail: 'Device not connected', final: false }]]));
        assert.match(offline, /If The Handy \(key ending 0001\) is moving, switch it off\./);
        const connected = describeCrashRecovery(one, new Map([['KEY-OLD-0001', { outcome: 'connected', detail: '', final: true }]]));
        assert.match(connected, /The Handy \(key ending 0001\) has been connected again/);
        // Not "the key saved here": by the time a late answer arrives, the key
        // saved here may be the one the wearer has just connected instead.
        for (const text of [stopped, offline, connected]) {
            assert.doesNotMatch(text, /key saved here/, text);
            assert.doesNotMatch(text, /The Handy (a stop|has|is|did)/, 'no Handy without its key');
        }
    });

    it('promises another try at the next start only for a key that is still owed one', () => {
        const gaveUp = { outcome: 'offline', detail: 'Device not connected', final: true };
        assert.match(describeHandyCrashStop(gaveUp, { driven: true }), /after 5 minutes and sends it again the next time it opens\./);
        const drawer = describeHandyCrashStop(gaveUp, { driven: false });
        assert.match(drawer, /\(that session was not driving it\), but the Handy API answered that the device is offline/);
        assert.match(drawer, /EdgeLoop stopped sending it after 5 minutes\.$/);
        // The banner says what the next page to open will find: a key no
        // longer owed - its one promised try made, or the record refused -
        // is promised nothing.
        const updates = new Map([['K-1', gaveUp]]);
        assert.match(describeCrashRecovery(plan(), updates, { owed: ['K-1'] }), /stopped sending it after 5 minutes and sends it again the next time it opens\.$/);
        assert.match(describeCrashRecovery(plan(), updates, { owed: [] }), /If The Handy \(key ending K-1\) is moving, switch it off\. EdgeLoop stopped sending it after 5 minutes\.$/);
        assert.match(describeCrashRecovery(plan(), updates, { owed: ['K-OTHER'] }), /EdgeLoop stopped sending it after 5 minutes\.$/);
    });

    it('reports a stop an earlier session still owes under a headline of its own', () => {
        const old = { key: 'KEY-OLD-0001', saved: false, driven: true };
        const earlierOnly = describeCrashRecovery(plan({ lastSession: false, handy: [], earlier: [old] }));
        assert.ok(earlierOnly.startsWith(EARLIER_CRASH_HEADLINE), earlierOnly);
        assert.ok(!earlierOnly.includes(CRASH_HEADLINE), 'the last session ended cleanly');
        assert.match(earlierOnly, /EdgeLoop is sending The Handy \(key ending 0001\) a stop with the connection key that session used\.\.\.$/);
        // The last session first, with its advice; then what an earlier one still owes.
        const both = describeCrashRecovery(plan({ intiface: true, earlier: [old] }));
        assert.ok(both.startsWith(CRASH_HEADLINE));
        assert.ok(both.indexOf('key ending K-1') < both.indexOf(INTIFACE_CRASH_ADVICE));
        assert.ok(both.indexOf(INTIFACE_CRASH_ADVICE) < both.indexOf(EARLIER_CRASH_HEADLINE));
        assert.ok(both.indexOf(EARLIER_CRASH_HEADLINE) < both.indexOf('key ending 0001'));
    });

    it('tells the wearer what EdgeLoop could not do for Intiface and T-Code, and what they can do', () => {
        const text = describeCrashRecovery(plan({ handy: [], intiface: true, tcode: true }));
        assert.ok(text.includes(INTIFACE_CRASH_ADVICE));
        assert.ok(text.includes(TCODE_CRASH_ADVICE));
        assert.match(INTIFACE_CRASH_ADVICE, /new connection/);
        assert.match(INTIFACE_CRASH_ADVICE, /press Stop in Intiface Central/);
        assert.match(TCODE_CRASH_ADVICE, /port you pick again/);
        assert.match(TCODE_CRASH_ADVICE, /vibration axis keeps its last level, so it may still be running/);
        assert.match(TCODE_CRASH_ADVICE, /press Connect, which puts every axis at rest/);
        const handyOnly = describeCrashRecovery(plan());
        assert.ok(!handyOnly.includes(INTIFACE_CRASH_ADVICE) && !handyOnly.includes(TCODE_CRASH_ADVICE));
    });

    it('admits when it cannot tell what the session drove', () => {
        assert.ok(describeCrashRecovery(plan({ known: false })).includes(UNKNOWN_HARDWARE_NOTE));
        assert.ok(!describeCrashRecovery(plan()).includes(UNKNOWN_HARDWARE_NOTE));
    });

    it('names the retry window it was given', () => {
        const update = { outcome: 'offline', detail: 'Device not connected', final: false };
        assert.match(describeHandyCrashStop(update, { retryMinutes: 1 }), /for 1 minute\./);
        assert.match(describeHandyCrashStop(update, { retryMinutes: 0.01 }), /for a few minutes\./);
    });
});

describe('runCrashRecovery', () => {
    it('a crashed session: the stop goes out with the key it drove, and the banner says what came back', async () => {
        const { storage, locks } = crashedPage();
        const reports = [];
        const stopHandy = fakeStop({ 'KEY-ONE-1234': { outcome: 'stopped', detail: 'result 0' } });
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-ONE-1234', stopHandy, onReport: (t) => reports.push(t) });
        assert.deepEqual(stopHandy.asked, ['KEY-ONE-1234']);
        assert.equal(reports.length, 2, 'once at once, once with the answer');
        assert.match(reports[0], /did not end cleanly/);
        assert.match(reports[0], /EdgeLoop is sending The Handy \(key ending 1234\) a stop/);
        assert.match(reports[1], /confirmed it \(result 0\)/);
        assert.equal(result.settled, true);
        assert.equal(onlyMarker(storage), null, 'a settled recovery removes the marker');
    });

    it('a page that is still open is not a crash', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        createLiveSessionTracker({ owner: 'page-a', storage, locks }).note(HANDY);
        await tick();
        const reports = [];
        const stopHandy = fakeStop();
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-ONE-1234', stopHandy, onReport: (t) => reports.push(t) });
        assert.equal(result.recovered, false);
        assert.deepEqual(stopHandy.asked, [], "a second tab must not stop the first tab's Handy");
        assert.deepEqual(reports, []);
        assert.equal(onlyMarker(storage).owner, 'page-a', 'and must not take its marker');
    });

    it('a clean STOP leaves nothing to recover', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage, locks });
        tracker.note(HANDY);
        tracker.clear();
        locks.crash('page-a');
        const reports = [];
        const stopHandy = fakeStop();
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-ONE-1234', stopHandy, onReport: (t) => reports.push(t) });
        assert.equal(result.recovered, false);
        assert.deepEqual(stopHandy.asked, []);
        assert.deepEqual(reports, []);
    });

    it('a stop that did not get through is owed to the next page to open, which sends it again', async () => {
        const { storage, locks } = crashedPage();
        const reports = [];
        const offline = fakeStop({ 'KEY-ONE-1234': { outcome: 'offline', detail: 'Device not connected' } });
        const first = await runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: offline, onReport: (t) => reports.push(t) });
        assert.equal(first.settled, false);
        assert.match(reports[reports.length - 1], /stopped sending it after 5 minutes and sends it again the next time it opens\.$/);
        // Handed over to the stops still owed, and the marker removed: a marker
        // says a page died, the record says which stops are still owed.
        assert.equal(onlyMarker(storage), null);
        assert.deepEqual(readPendingCrashStops(storage), ['KEY-ONE-1234']);
        const online = fakeStop({ 'KEY-ONE-1234': { outcome: 'already-stopped', detail: 'result 1' } });
        const nextReports = [];
        const second = await runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: online, onReport: (t) => nextReports.push(t) });
        assert.deepEqual(online.asked, ['KEY-ONE-1234']);
        assert.equal(second.settled, true);
        assert.ok(nextReports[0].startsWith(EARLIER_CRASH_HEADLINE), nextReports[0]);
        assert.match(nextReports[nextReports.length - 1], /answered that it was already stopped \(result 1\)\.$/);
        assert.deepEqual(readPendingCrashStops(storage), []);
    });

    it('never removes the marker of a session started since', async () => {
        const { storage, locks } = crashedPage();
        const stopHandy = async (key, { onUpdate }) => {
            // This page starts a session of its own while the stop is out.
            createLiveSessionTracker({ owner: 'page-b', storage, locks }).note({ handyKey: key });
            const update = { outcome: 'stopped', detail: 'result 0', final: true };
            onUpdate(update);
            return update;
        };
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-ONE-1234', stopHandy, onReport: () => {} });
        assert.equal(result.settled, true);
        assert.equal(onlyMarker(storage).owner, 'page-b');
    });

    it('Intiface and T-Code only: advice, no stop, and nothing left to try again', async () => {
        const { storage, locks } = crashedPage({ intiface: true, tcode: true });
        const reports = [];
        const stopHandy = fakeStop();
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: '', stopHandy, onReport: (t) => reports.push(t) });
        assert.deepEqual(stopHandy.asked, []);
        assert.equal(reports.length, 1);
        assert.ok(reports[0].includes(INTIFACE_CRASH_ADVICE) && reports[0].includes(TCODE_CRASH_ADVICE));
        assert.equal(result.settled, true);
        assert.equal(onlyMarker(storage), null);
    });

    it('the saved key is stopped too, but only a key the session drove is owed another try', async () => {
        const { storage, locks } = crashedPage();
        const reports = [];
        const stopHandy = fakeStop({
            'KEY-ONE-1234': { outcome: 'stopped', detail: 'result 0' },
            'KEY-IN-A-DRAWER': { outcome: 'offline', detail: 'Device not connected' }
        });
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-IN-A-DRAWER', stopHandy, onReport: (t) => reports.push(t) });
        assert.deepEqual(stopHandy.asked.slice().sort(), ['KEY-IN-A-DRAWER', 'KEY-ONE-1234']);
        assert.equal(result.settled, true);
        assert.equal(onlyMarker(storage), null);
        assert.deepEqual(readPendingCrashStops(storage), [], 'a Handy in a drawer cannot bring the report back');
        assert.match(reports[reports.length - 1], /\(that session was not driving it\), but .* EdgeLoop stopped sending it after 5 minutes\.$/);
    });

    it('the marker is handed over before the first stop goes out', async () => {
        const { storage, locks } = crashedPage();
        const seen = [];
        const stopHandy = (key, { onUpdate }) => {
            seen.push({ key, marker: onlyMarker(storage), owed: readPendingCrashStops(storage) });
            const update = { outcome: 'offline', detail: 'Device not connected', final: false };
            onUpdate(update);
            return new Promise(() => {});
        };
        runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-ONE-1234', stopHandy, onReport: () => {} });
        await tick();
        await tick();
        assert.deepEqual(seen, [{ key: 'KEY-ONE-1234', marker: null, owed: ['KEY-ONE-1234'] }]);
    });

    it('a browser that refuses the record keeps the marker until the keys the session drove are settled, and promises nothing', async () => {
        const { storage, locks } = crashedPage();
        storage.refuse = true;
        let finishDrawer = null;
        const stopHandy = (key, { onUpdate }) => {
            if (key === 'KEY-IN-A-DRAWER') {
                onUpdate({ outcome: 'offline', detail: 'Device not connected', final: false });
                return new Promise((resolve) => { finishDrawer = () => resolve({ outcome: 'offline', detail: 'Device not connected', final: true }); });
            }
            const update = { outcome: 'stopped', detail: 'result 0', final: true };
            onUpdate(update);
            return Promise.resolve(update);
        };
        const running = runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-IN-A-DRAWER', stopHandy, onReport: () => {} });
        await tick();
        assert.equal(onlyMarker(storage), null, 'removed while the saved key\'s stop is still retrying');
        finishDrawer();
        const result = await running;
        assert.equal(result.settled, true);
        assert.equal(result.finals.length, 2);

        // Unsettled: the marker stays for the next page, and the banner makes
        // no promise it cannot keep, since a new session would replace it.
        const again = crashedPage();
        again.storage.refuse = true;
        const reports = [];
        const offline = fakeStop({ 'KEY-ONE-1234': { outcome: 'offline', detail: 'Device not connected' } });
        const first = await runCrashRecovery({ storage: again.storage, locks: again.locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: offline, onReport: (t) => reports.push(t) });
        assert.equal(first.settled, false);
        assert.notEqual(onlyMarker(again.storage), null);
        assert.match(reports[reports.length - 1], /switch it off\. EdgeLoop stopped sending it after 5 minutes\.$/);
        again.storage.refuse = false;
        const online = fakeStop({ 'KEY-ONE-1234': { outcome: 'stopped', detail: 'result 0' } });
        const second = await runCrashRecovery({ storage: again.storage, locks: again.locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: online, onReport: () => {} });
        assert.deepEqual(online.asked, ['KEY-ONE-1234']);
        assert.equal(second.settled, true);
        assert.equal(onlyMarker(again.storage), null);
        assert.deepEqual(readPendingCrashStops(again.storage), []);
    });

    it('a stop that throws is reported as a stop that was not confirmed, and is owed another try', async () => {
        const { storage, locks } = crashedPage();
        const reports = [];
        const stopHandy = () => { throw new Error('boom'); };
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-ONE-1234', stopHandy, onReport: (t) => reports.push(t) });
        assert.equal(result.settled, false);
        assert.match(reports[reports.length - 1], /the stop was not confirmed \(boom\)\. .* sends it again the next time it opens\.$/);
        assert.deepEqual(readPendingCrashStops(storage), ['KEY-ONE-1234']);
    });

    it('without a lock manager a marker is treated as a crash', async () => {
        const storage = fakeStorage();
        createLiveSessionTracker({ owner: 'page-a', storage }).note(HANDY);
        const stopHandy = fakeStop();
        const result = await runCrashRecovery({ storage, locks: undefined, savedHandyKey: 'KEY-ONE-1234', stopHandy, onReport: () => {} });
        assert.equal(result.recovered, true);
        assert.deepEqual(stopHandy.asked, ['KEY-ONE-1234']);
    });

    it('reports every change a long stop goes through', async () => {
        const { storage, locks } = crashedPage();
        const reports = [];
        const stopHandy = async (key, { onUpdate }) => {
            onUpdate({ outcome: 'offline', detail: 'Device not connected', final: false });
            const update = { outcome: 'stopped', detail: 'result 0', final: true };
            onUpdate(update);
            return update;
        };
        await runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-ONE-1234', stopHandy, onReport: (t) => reports.push(t) });
        assert.equal(reports.length, 3);
        assert.match(reports[1], /offline/);
        assert.match(reports[2], /has stopped/);
    });
});

describe('a session started in a page that was already open', () => {
    const KA = 'KEY-ONE-1234';
    const KB = 'KEY-TWO-5678';
    const RESULT_0 = { outcome: 'stopped', detail: 'result 0' };
    const last = (reports) => reports[reports.length - 1];

    // Tab A drives the Handy; tab B has been open all along and boots while
    // A runs, so its own boot pass leaves A alone.
    async function tabsAB({ stop = fakeStop({ [KA]: RESULT_0 }), saved = KA, live = '' } = {}) {
        const storage = fakeStorage();
        const locks = fakeLocks();
        const a = createLiveSessionTracker({ owner: 'tab-a', storage, locks });
        a.note({ handyKey: KA });
        await tick();
        const reports = [];
        // The second look after boot is tested on its own; here tab A dies
        // after the boot, and only a session start may recover it.
        const b = createCrashRecovery({
            owner: 'tab-b',
            storage,
            locks,
            savedHandyKey: () => saved,
            liveHandyKey: () => live,
            stopHandy: stop,
            onReport: (t) => reports.push(t),
            bootRecheckMs: null
        });
        const boot = await b.atBoot();
        assert.equal(boot.recovered, false, 'A is open: not a crash');
        assert.deepEqual(stop.asked, []);
        return { storage, locks, a, b, reports, stop };
    }

    // What a pass started by note() has done once it is over: the stop
    // answers at once, so a few turns of the event loop are enough.
    const passOver = () => tick(5);

    it('a session paused while another tab drove a Handy and died recovers that tab when it resumes', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        const stop = fakeStop({ [KB]: RESULT_0 });
        const reports = [];
        const c = createCrashRecovery({ owner: 'tab-c', storage, locks, stopHandy: stop, onReport: (t) => reports.push(t), bootRecheckMs: null });
        await c.atBoot();
        // Tab C starts a session, with nothing to recover, and pauses it.
        c.note({ handyKey: KA, driving: true });
        await passOver();
        c.note({ handyKey: KA, driving: false });
        // Meanwhile tab A drives another Handy, and dies.
        createLiveSessionTracker({ owner: 'tab-a', storage, locks }).note({ handyKey: KB, driving: true });
        locks.crash('tab-a');
        // Resuming goes on with the same session: no session start, no pass.
        c.note({ handyKey: KA, driving: true });
        await passOver();
        assert.deepEqual(stop.asked, [], 'the gap: nothing stops the Handy tab A left moving');
        const resumed = await c.sessionResumed();
        assert.equal(resumed.recovered, true);
        assert.deepEqual(stop.asked, [KB]);
        assert.ok(last(reports).startsWith(OTHER_PAGE_CRASH_HEADLINE));
        assert.equal(readLiveSession(storage, 'tab-a'), null);
        // And a second resume finds nothing more.
        assert.equal((await c.sessionResumed()).recovered, false);
        assert.deepEqual(stop.asked, [KB]);
    });

    it('recovers a page that died since it opened, and its STOP leaves nothing behind', async () => {
        const { storage, locks, b, reports, stop } = await tabsAB();
        locks.crash('tab-a');
        // The wearer carries on in tab B with an Intiface toy.
        assert.equal(b.note({ intiface: true }), true);
        await passOver();
        assert.deepEqual(stop.asked, [KA], "the Handy tab A left moving is sent the stop");
        const text = last(reports);
        assert.ok(text.startsWith(OTHER_PAGE_CRASH_HEADLINE), text);
        assert.match(text, /EdgeLoop sent The Handy \(key ending 1234\) a stop with the connection key it found saved here\. The Handy API confirmed it \(result 0\): it was still moving and has stopped\.$/);
        assert.equal(readLiveSession(storage, 'tab-a'), null, "tab A's marker is recovered");
        assert.deepEqual(readPendingCrashStops(storage), []);
        assert.deepEqual(readLiveSession(storage, 'tab-b').intiface, true, "tab B's own session is on its own marker");
        // B's STOP; then the next page to open finds nothing to do.
        b.clear();
        assert.deepEqual(readLiveSessions(storage), []);
        const next = fakeStop();
        const c = await runCrashRecovery({ storage, locks, savedHandyKey: KA, stopHandy: next, onReport: () => assert.fail('nothing to report') });
        assert.equal(c.recovered, false);
        assert.deepEqual(next.asked, []);
    });

    it('with another Handy of its own: the dead page\'s Handy is stopped and this page\'s own is sent nothing', async () => {
        const { storage, locks, b, reports, stop } = await tabsAB({ saved: KB, live: KB });
        locks.crash('tab-a');
        b.note({ handyKey: KB });
        await passOver();
        assert.deepEqual(stop.asked, [KA]);
        const text = last(reports);
        assert.match(text, /The Handy \(key ending 1234\) a stop with the connection key that session used\./);
        assert.ok(!text.includes('5678'), 'the Handy this page drives is not in the report');
        assert.deepEqual(readLiveSession(storage, 'tab-b').handyKeys, [KB]);
    });

    it('a stop that does not get through is owed to the next page to open, whatever this page does next', async () => {
        const stop = fakeStop({ [KA]: { outcome: 'offline', detail: 'Device not connected' } });
        const { storage, locks, b, reports } = await tabsAB({ stop });
        locks.crash('tab-a');
        b.note({ intiface: true });
        await passOver();
        assert.match(last(reports), /EdgeLoop stopped sending it after 5 minutes and sends it again the next time it opens\.$/);
        b.clear();
        assert.deepEqual(readPendingCrashStops(storage), [KA]);
        const next = fakeStop({ [KA]: RESULT_0 });
        const nextReports = [];
        await runCrashRecovery({ storage, locks, savedHandyKey: KA, stopHandy: next, onReport: (t) => nextReports.push(t) });
        assert.deepEqual(next.asked, [KA], 'the promised stop goes out');
        assert.ok(nextReports[0].startsWith(EARLIER_CRASH_HEADLINE), nextReports[0]);
    });

    it('when this page dies too, the next page reports its session alone', async () => {
        const { storage, locks, b, stop } = await tabsAB();
        locks.crash('tab-a');
        b.note({ intiface: true });
        await passOver();
        assert.deepEqual(stop.asked, [KA]);
        locks.crash('tab-b');
        const next = fakeStop({ [KA]: { outcome: 'already-stopped', detail: 'result 1' } });
        const reports = [];
        await runCrashRecovery({ storage, locks, savedHandyKey: KA, stopHandy: next, onReport: (t) => reports.push(t) });
        const text = last(reports);
        assert.ok(text.startsWith(CRASH_HEADLINE), text);
        // Tab B's session drove only Intiface: the saved key is stopped by
        // the boot rule, as one that session was not driving, and the Handy
        // tab A left moving was stopped by tab B before it died.
        assert.match(text, /\(that session was not driving it\)\. The Handy API answered that it was already stopped \(result 1\)\./);
        assert.ok(text.includes(INTIFACE_CRASH_ADVICE));
        assert.deepEqual(readLiveSessions(storage), []);
    });

    it('a page that is still open is left alone, and both sessions keep a marker of their own', async () => {
        const { storage, locks, b, reports, stop } = await tabsAB();
        // Tab A is still running when B starts a session, driving its own
        // Handy: two at once.
        b.note({ handyKey: KB, driving: true });
        await passOver();
        assert.deepEqual(stop.asked, []);
        assert.deepEqual(reports, []);
        assert.deepEqual(readLiveSessions(storage).map((m) => m.owner).sort(), ['tab-a', 'tab-b']);
        // A dies while B runs: the next page to open stops A's Handy, and
        // leaves B's alone.
        locks.crash('tab-a');
        const next = fakeStop({ [KA]: RESULT_0 });
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: KB, stopHandy: next, onReport: () => {} });
        assert.deepEqual(next.asked, [KA]);
        assert.deepEqual(result.plan.leftInUse, [KB], "B's Handy is B's to stop");
        assert.deepEqual(readLiveSessions(storage).map((m) => m.owner), ['tab-b']);
    });

    it('leaves the stops still owed to the next page to open, even the one this page promised', async () => {
        // An earlier crash's Handy is offline all through this page's boot
        // pass, which promises the next page to open another try.
        const { storage, locks } = crashedPage({ handyKey: 'KEY-OLD-0000' }, 'page-x');
        createLiveSessionTracker({ owner: 'tab-a', storage, locks }).note({ handyKey: KA, driving: true });
        await tick();
        const stop = fakeStop({ 'KEY-OLD-0000': { outcome: 'offline', detail: 'Device not connected' }, [KA]: RESULT_0 });
        const reports = [];
        const b = createCrashRecovery({ owner: 'tab-b', storage, locks, savedHandyKey: () => KA, stopHandy: stop, onReport: (t) => reports.push(t), bootRecheckMs: null });
        await b.atBoot();
        assert.deepEqual(stop.asked, ['KEY-OLD-0000']);
        const promise = readPendingCrashStopPromises(storage).get('KEY-OLD-0000');
        assert.notEqual(promise, '');
        const bootText = last(reports);
        assert.match(bootText, /\(key ending 0000\) is moving, switch it off\. EdgeLoop stopped sending it after 5 minutes and sends it again the next time it opens\./);
        // The key saved here is tab A's, and tab A drives it: it is left alone.
        assert.match(bootText, /The Handy \(key ending 1234\) is being driven by a session running in another EdgeLoop tab or window, so EdgeLoop sent it nothing and left it to that session: pausing or stopping that session stops it\.$/);
        // Tab A dies; a session starts in B.
        locks.crash('tab-a');
        b.note({ intiface: true });
        await passOver();
        assert.deepEqual(stop.asked, ['KEY-OLD-0000', KA], 'the old key is not sent again from here');
        assert.equal(readPendingCrashStopPromises(storage).get('KEY-OLD-0000'), promise, 'nor its promise used up');
        // Both reports stand, the boot pass's first.
        const text = last(reports);
        assert.ok(text.startsWith(`${bootText} ${OTHER_PAGE_CRASH_HEADLINE}`), text);
        // The next page to open is the try this page promised.
        const next = fakeStop({ 'KEY-OLD-0000': RESULT_0 });
        await runCrashRecovery({ storage, locks, savedHandyKey: KA, stopHandy: next, onReport: () => {} });
        assert.deepEqual(next.asked, ['KEY-OLD-0000']);
    });

    it('never recovers a marker twice: what the boot pass took on, a session start leaves to it', async () => {
        // A browser that refuses the stops-still-owed record keeps the marker
        // until the stop is settled; the stop is still going when a session
        // starts in the same page.
        const { storage, locks } = crashedPage({ handyKey: KA }, 'page-x');
        const stop = heldStop();
        const reports = [];
        const b = createCrashRecovery({ owner: 'tab-b', storage, locks, savedHandyKey: () => KA, stopHandy: stop, onReport: (t) => reports.push(t) });
        storage.refuse = true;
        const boot = b.atBoot();
        await tick();
        assert.deepEqual(stop.asked, [KA]);
        assert.notEqual(readLiveSession(storage, 'page-x'), null);
        storage.refuse = false;
        b.note({ intiface: true });
        await passOver();
        assert.deepEqual(stop.asked, [KA], 'one stop, one report');
        assert.equal(reports.filter((t) => t.includes(OTHER_PAGE_CRASH_HEADLINE)).length, 0);
        stop.answer(KA, { ...RESULT_0, final: true });
        assert.equal((await boot).settled, true);
        assert.equal(readLiveSession(storage, 'page-x'), null);
    });

    it('nor when both passes are waiting on the lock manager at once', async () => {
        const { storage } = crashedPage({ handyKey: KA }, 'page-x');
        // A lock manager slow to answer: every query waits for release().
        const waiting = [];
        const slow = {
            request: () => new Promise(() => {}),
            query: () => new Promise((resolve) => { waiting.push(() => resolve({ held: [], pending: [] })); })
        };
        const stop = fakeStop({ [KA]: RESULT_0 });
        const reports = [];
        const b = createCrashRecovery({ owner: 'tab-b', storage, locks: slow, savedHandyKey: () => KA, stopHandy: stop, onReport: (t) => reports.push(t) });
        const boot = b.atBoot();
        b.note({ intiface: true });
        await tick();
        assert.equal(waiting.length, 2, 'both passes are asking');
        waiting.forEach((release) => release());
        await boot;
        await passOver();
        assert.deepEqual(stop.asked, [KA], 'one stop');
        const text = reports[reports.length - 1];
        assert.equal(text.split(CRASH_HEADLINE).length - 1 + text.split(OTHER_PAGE_CRASH_HEADLINE).length - 1, 1, 'one report of it');
    });

    it('a Handy that another page still open is driving is sent nothing, even when the page that died drove it too', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        createLiveSessionTracker({ owner: 'page-dead', storage, locks }).note({ handyKey: KA, intiface: true });
        locks.crash('page-dead');
        createLiveSessionTracker({ owner: 'page-live', storage, locks }).note({ handyKey: KA, driving: true });
        await tick();
        const stop = fakeStop();
        const reports = [];
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: KA, stopHandy: stop, onReport: (t) => reports.push(t) });
        assert.deepEqual(stop.asked, []);
        assert.equal(result.alive, 1);
        const text = last(reports);
        assert.ok(text.startsWith(CRASH_HEADLINE));
        assert.match(text, /The Handy \(key ending 1234\) is being driven by a session running in another EdgeLoop tab or window, so EdgeLoop sent it nothing and left it to that session: pausing or stopping that session stops it\./);
        assert.ok(text.includes(INTIFACE_CRASH_ADVICE));
        assert.deepEqual(readLiveSessions(storage).map((m) => m.owner), ['page-live']);
        assert.deepEqual(readPendingCrashStops(storage), [], 'nothing is owed for it: its own page answers for it');
    });

    // A marker names every Handy its session has driven, not the one it
    // drives now. Tab C drove the Handy, then paused its session or lost its
    // link to it, and left the tab open; tab A drove the Handy after that and
    // died with it moving. Taking every Handy an open page's marker names
    // for one it drives sent that Handy nothing from anywhere.
    for (const [what, since] of [
        ['has only paused', { handyKey: KA, driving: false }],
        ['has lost its link to', { handyKey: '', driving: false }]
    ]) {
        it(`a Handy that a page still open ${what} is stopped when another page that drove it dies`, async () => {
            const storage = fakeStorage();
            const locks = fakeLocks();
            const c = createLiveSessionTracker({ owner: 'tab-c', storage, locks });
            c.note({ handyKey: KA, driving: true });
            c.note(since);
            createLiveSessionTracker({ owner: 'tab-a', storage, locks }).note({ handyKey: KA, driving: true });
            locks.crash('tab-a');
            await tick();
            assert.deepEqual(readLiveSession(storage, 'tab-c').handyKeys, [KA], 'tab C still names it');
            const stop = fakeStop({ [KA]: RESULT_0 });
            const reports = [];
            const result = await runCrashRecovery({ storage, locks, savedHandyKey: KA, stopHandy: stop, onReport: (t) => reports.push(t) });
            assert.deepEqual(stop.asked, [KA]);
            assert.deepEqual(result.plan.leftInUse, []);
            assert.equal(result.settled, true);
            const text = last(reports);
            assert.ok(text.startsWith(CRASH_HEADLINE), text);
            assert.match(text, /EdgeLoop sent The Handy \(key ending 1234\) a stop with the connection key it found saved here\. The Handy API confirmed it \(result 0\): it was still moving and has stopped\.$/);
            assert.ok(!text.includes('another EdgeLoop tab'), 'nothing is left to tab C');
            assert.deepEqual(readLiveSessions(storage).map((m) => m.owner), ['tab-c'], "tab A's marker is recovered, tab C's kept");
            assert.deepEqual(readPendingCrashStops(storage), []);
        });
    }

    it('a stop to it that does not get through is owed to the next page to open, whatever tab C does next', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        const c = createLiveSessionTracker({ owner: 'tab-c', storage, locks });
        c.note({ handyKey: KA, driving: true });
        c.note({ handyKey: KA, driving: false });
        createLiveSessionTracker({ owner: 'tab-a', storage, locks }).note({ handyKey: KA, driving: true });
        locks.crash('tab-a');
        await tick();
        const offline = fakeStop({ [KA]: { outcome: 'offline', detail: 'Device not connected' } });
        const reports = [];
        await runCrashRecovery({ storage, locks, savedHandyKey: KA, stopHandy: offline, onReport: (t) => reports.push(t) });
        assert.deepEqual(offline.asked, [KA]);
        assert.match(last(reports), /EdgeLoop stopped sending it after 5 minutes and sends it again the next time it opens\.$/);
        assert.deepEqual(readPendingCrashStops(storage), [KA]);
        // Tab C is stopped; the next page to open keeps the promise.
        c.clear();
        const next = fakeStop({ [KA]: RESULT_0 });
        const nextReports = [];
        await runCrashRecovery({ storage, locks, savedHandyKey: KA, stopHandy: next, onReport: (t) => nextReports.push(t) });
        assert.deepEqual(next.asked, [KA]);
        assert.ok(nextReports[0].startsWith(EARLIER_CRASH_HEADLINE), nextReports[0]);
        assert.deepEqual(readPendingCrashStops(storage), []);
    });

    it('a session started in a third page stops it too', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        const c = createLiveSessionTracker({ owner: 'tab-c', storage, locks });
        c.note({ handyKey: KA, driving: true });
        c.note({ handyKey: '', driving: false });
        createLiveSessionTracker({ owner: 'tab-a', storage, locks }).note({ handyKey: KA, driving: true });
        await tick();
        const stop = fakeStop({ [KA]: RESULT_0 });
        const reports = [];
        // Tab B booted while A and C were both open; the wearer connects
        // another Handy in B, which saves its key, and starts a session.
        const b = createCrashRecovery({ owner: 'tab-b', storage, locks, savedHandyKey: () => KB, liveHandyKey: () => KB, stopHandy: stop, onReport: (t) => reports.push(t), bootRecheckMs: null });
        assert.equal((await b.atBoot()).recovered, false);
        locks.crash('tab-a');
        b.note({ handyKey: KB, driving: false });
        await passOver();
        assert.deepEqual(stop.asked, [KA]);
        const text = last(reports);
        assert.ok(text.startsWith(OTHER_PAGE_CRASH_HEADLINE), text);
        assert.match(text, /EdgeLoop sent The Handy \(key ending 1234\) a stop with the connection key that session used\. The Handy API confirmed it \(result 0\): it was still moving and has stopped\.$/);
        assert.deepEqual(readLiveSessions(storage).map((m) => m.owner).sort(), ['tab-b', 'tab-c']);
    });

    it('the key saved here is left to a page still open only while that page\'s session drives it', async () => {
        for (const [driving, sent] of [[true, [KA]], [false, [KA, KB]]]) {
            const storage = fakeStorage();
            const locks = fakeLocks();
            createLiveSessionTracker({ owner: 'tab-a', storage, locks }).note({ handyKey: KA, driving: true });
            locks.crash('tab-a');
            // Tab B connected a Handy of its own, which saved its key, and
            // is running its session, or has paused it.
            createLiveSessionTracker({ owner: 'tab-b', storage, locks }).note({ handyKey: KB, driving });
            await tick();
            const stop = fakeStop();
            const reports = [];
            const result = await runCrashRecovery({ storage, locks, savedHandyKey: KB, stopHandy: stop, onReport: (t) => reports.push(t) });
            assert.deepEqual(stop.asked, sent, `tab B driving: ${driving}`);
            assert.deepEqual(result.plan.leftInUse, driving ? [KB] : []);
            if (!driving) {
                assert.match(last(reports), /EdgeLoop sent The Handy \(key ending 5678\) a stop with the connection key it found saved here \(that session was not driving it\)\. The Handy API confirmed the stop\./);
            }
        }
    });

    it('a dead page\'s marker that cannot be read: the saved key is stopped, unless it is this page\'s own Handy', async () => {
        for (const [live, expected] of [['', [KA]], [KA, []]]) {
            const storage = fakeStorage();
            const locks = fakeLocks();
            storage.setItem(liveSessionKey('page-x'), '{not json');
            const stop = fakeStop();
            const reports = [];
            const b = createCrashRecovery({ owner: 'tab-b', storage, locks, savedHandyKey: () => KA, liveHandyKey: () => live, stopHandy: stop, onReport: (t) => reports.push(t) });
            b.note({ handyKey: live });
            await passOver();
            assert.deepEqual(stop.asked, expected, `live key '${live}'`);
            const text = last(reports);
            assert.ok(text.includes(UNKNOWN_HARDWARE_NOTE) && text.includes(INTIFACE_CRASH_ADVICE) && text.includes(TCODE_CRASH_ADVICE));
            assert.deepEqual(readLiveSessions(storage).map((m) => m.owner), ['tab-b']);
        }
    });

    it('a session start in a page with nothing to recover sends and reports nothing, and neither does its next one', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        const stop = fakeStop();
        let queries = 0;
        const counted = { request: locks.request, query: async () => { queries += 1; return locks.query(); } };
        const b = createCrashRecovery({ owner: 'tab-b', storage, locks: counted, savedHandyKey: () => KA, stopHandy: stop, onReport: () => assert.fail('nothing to report') });
        assert.equal((await b.atBoot()).recovered, false);
        b.note({ handyKey: KA });
        await passOver();
        b.clear();
        b.note({ handyKey: KA });
        await passOver();
        assert.deepEqual(stop.asked, []);
        assert.equal(queries, 0, 'no marker of another page: no question to the lock manager');
    });

    it('without a lock manager every other marker looks dead, but this page never takes its own for one', async () => {
        const storage = fakeStorage();
        createLiveSessionTracker({ owner: 'page-x', storage }).note({ handyKey: KA });
        const stop = fakeStop();
        const b = createCrashRecovery({ owner: 'tab-b', storage, locks: undefined, savedHandyKey: () => KB, liveHandyKey: () => KB, stopHandy: stop, onReport: () => {} });
        b.note({ handyKey: KB });
        await passOver();
        assert.deepEqual(stop.asked, [KA]);
        assert.deepEqual(readLiveSessions(storage).map((m) => m.owner), ['tab-b']);
        assert.deepEqual(readLiveSession(storage, 'tab-b').handyKeys, [KB]);
        // Nor at a later boot pass of the same page, should one run.
        await b.atBoot();
        assert.deepEqual(stop.asked, [KA]);
        assert.notEqual(readLiveSession(storage, 'tab-b'), null);
    });

    it('a pass that throws never reaches the dispatch that started it', async () => {
        const storage = fakeStorage();
        createLiveSessionTracker({ owner: 'page-x', storage }).note({ handyKey: KA });
        const b = createCrashRecovery({
            owner: 'tab-b',
            storage,
            locks: undefined,
            savedHandyKey: () => { throw new Error('storage gone'); },
            stopHandy: () => { throw new Error('boom'); },
            onReport: () => { throw new Error('no banner'); }
        });
        assert.equal(b.note({ intiface: true }), true);
        await passOver();
        assert.deepEqual(readPendingCrashStops(storage), [KA], 'the stop that threw is still owed');
    });
});

describe('the crash report on the alert banner', () => {
    // app.js puts every report on the one alert banner under a source of its
    // own ('crashRecovery'): news that a Handy may still be moving is raised
    // (fresh), a stop that settled rewords it, and an empty text withdraws
    // it. What it is about is over once no Handy it names may still be
    // moving and the wearer has carried on from it: a session that starts
    // or resumes here.
    const KA = 'KEY-ONE-1234';
    const OFFLINE = { outcome: 'offline', detail: 'Device not connected' };
    const RESULT_0 = { outcome: 'stopped', detail: 'result 0' };

    async function bootAfterCrash() {
        const { storage, locks } = crashedPage({ handyKey: KA });
        const stop = heldStop();
        const reports = [];
        const page = createCrashRecovery({
            owner: 'page-b',
            storage,
            locks,
            savedHandyKey: () => KA,
            stopHandy: stop,
            onReport: (text, opts) => reports.push({ text, ...opts }),
            bootRecheckMs: null
        });
        const boot = page.atBoot();
        await until(() => stop.asked.length === 1);
        return { storage, locks, stop, reports, page, boot };
    }

    it('is news until every stop in it settles, and a stop that settles only rewords it', async () => {
        const { stop, reports, boot } = await bootAfterCrash();
        assert.equal(reports.length, 1);
        assert.equal(reports[0].fresh, true, 'its first word is a report of its own');
        assert.match(reports[0].text, /is sending The Handy \(key ending 1234\) a stop/);
        stop.answer(KA, { ...OFFLINE, final: false });
        assert.equal(reports[1].fresh, true, 'a stop that did not get through is news');
        assert.match(reports[1].text, /the device is offline/);
        stop.answer(KA, { ...RESULT_0, final: true });
        await boot;
        assert.equal(reports[2].fresh, false, 'a stop that settled rewords it in place');
        assert.match(reports[2].text, /it was still moving and has stopped\.$/);
        assert.equal(reports.length, 3);
    });

    it('a settled report stays until a session starts here, and that start withdraws it', async () => {
        const { stop, reports, boot, page } = await bootAfterCrash();
        stop.answer(KA, { ...RESULT_0, final: true });
        await boot;
        const shown = reports.length;
        // The wearer pairs, connects and reads: nothing withdraws it.
        await tick(5);
        assert.equal(reports.length, shown);
        page.note({ intiface: true });
        await tick(5);
        assert.deepEqual(reports.slice(shown), [{ text: '', fresh: false }], 'the session start ends it');
        // STOP, and the next session finds nothing left to withdraw.
        page.clear();
        page.note({ intiface: true });
        await tick(5);
        assert.equal(reports.length, shown + 1);
    });

    it('a report with a stop still out stays through the session, says when it settles, and the next start ends it', async () => {
        const { stop, reports, boot, page } = await bootAfterCrash();
        stop.answer(KA, { ...OFFLINE, final: false });
        page.note({ intiface: true });
        await tick(5);
        assert.match(reports[reports.length - 1].text, /the device is offline/, 'that Handy may still be moving: it stays');
        stop.answer(KA, { ...RESULT_0, final: true });
        await boot;
        const settled = reports[reports.length - 1];
        assert.equal(settled.fresh, false);
        assert.match(settled.text, /it was still moving and has stopped\.$/, 'and says what became of it');
        assert.equal(await page.sessionResumed().then(() => reports[reports.length - 1].text), '', 'a RESUME ends it');
    });

    it('a stop that gave up keeps it up through every session start, and its answer is news again', async () => {
        const { stop, reports, boot, page } = await bootAfterCrash();
        stop.answer(KA, { ...OFFLINE, final: true });
        await boot;
        const gaveUp = reports[reports.length - 1];
        assert.equal(gaveUp.fresh, true);
        assert.match(gaveUp.text, /stopped sending it after 5 minutes/);
        page.note({ intiface: true });
        await tick(5);
        page.clear();
        await page.sessionResumed();
        assert.equal(reports[reports.length - 1], gaveUp, 'nothing withdrew it');
    });
});

describe('the second look after boot', () => {
    const KA = 'KEY-ONE-1234';
    const RESULT_1 = { outcome: 'already-stopped', detail: 'result 1' };

    it('recovers the page this one replaced, which still held its lock when this one booted', async () => {
        // Tab A runs a session; Chrome shows a page it prerendered in A's
        // tab, whose boot pass asks before A is torn down.
        const storage = fakeStorage();
        const locks = fakeLocks();
        createLiveSessionTracker({ owner: 'page-a', storage, locks }).note({ handyKey: KA });
        await tick();
        const stop = fakeStop({ [KA]: RESULT_1 });
        const reports = [];
        const b = createCrashRecovery({ owner: 'page-b', storage, locks, savedHandyKey: () => KA, stopHandy: stop, onReport: (t) => reports.push(t), bootRecheckMs: 40 });
        const boot = await b.atBoot();
        assert.equal(boot.recovered, false);
        assert.deepEqual(stop.asked, []);
        // A is gone a moment later; its unload stop went out unconfirmed.
        locks.crash('page-a');
        assert.ok(await until(() => reports.length === 2), 'the second look reported');
        assert.deepEqual(stop.asked, [KA]);
        const text = reports[reports.length - 1];
        assert.ok(text.startsWith(CRASH_HEADLINE), text);
        assert.match(text, /The Handy API answered that it was already stopped \(result 1\)\.$/);
        assert.deepEqual(readLiveSessions(storage), []);
    });

    it('leaves a page that is still open alone, and sends nothing the boot pass already sent', async () => {
        // An earlier crash is still owed a stop, and tab A is open. The owed
        // Handy stays offline through the boot pass, which promises the next
        // page to open another try.
        const storage = fakeStorage();
        const locks = fakeLocks();
        addPendingCrashStops(['KEY-OLD-0000'], storage);
        createLiveSessionTracker({ owner: 'page-a', storage, locks }).note({ handyKey: KA });
        await tick();
        const stop = fakeStop({ 'KEY-OLD-0000': { outcome: 'offline', detail: 'Device not connected' } });
        let queries = 0;
        const counted = { request: locks.request, query: async () => { queries += 1; return locks.query(); } };
        const b = createCrashRecovery({ owner: 'page-b', storage, locks: counted, savedHandyKey: () => KA, stopHandy: stop, onReport: () => {}, bootRecheckMs: 40 });
        await b.atBoot();
        const promise = readPendingCrashStopPromises(storage).get('KEY-OLD-0000');
        assert.notEqual(promise, '');
        assert.ok(await until(() => queries === 2), 'one question at boot, one at the second look');
        await tick(20);
        assert.deepEqual(stop.asked, ['KEY-OLD-0000'], 'the owed stop once, and nothing for the open tab');
        assert.equal(queries, 2);
        assert.equal(readPendingCrashStopPromises(storage).get('KEY-OLD-0000'), promise, 'the promise to the next page to open stands');
        assert.equal(onlyMarker(storage).owner, 'page-a');
    });

    it('looks again only at the markers whose pages were open at boot', async () => {
        // No lock manager (an http:// page that is not localhost): the boot
        // pass takes tab A's marker for a crash, the safe way to be wrong,
        // and tab A, still running, writes it again at its next dispatch.
        const storage = fakeStorage();
        const a = createLiveSessionTracker({ owner: 'page-a', storage });
        a.note({ handyKey: KA });
        const stop = fakeStop({ [KA]: RESULT_1 });
        const b = createCrashRecovery({ owner: 'page-b', storage, locks: undefined, savedHandyKey: () => KA, stopHandy: stop, onReport: () => {}, bootRecheckMs: 20 });
        await b.atBoot();
        assert.deepEqual(stop.asked, [KA]);
        a.note({ handyKey: KA });
        await tick(80);
        assert.deepEqual(stop.asked, [KA], 'not stopped a second time');
        // With a lock manager, a session another tab starts after the boot is
        // not the second look's business either.
        const storage2 = fakeStorage();
        const locks2 = fakeLocks();
        createLiveSessionTracker({ owner: 'page-c', storage: storage2, locks: locks2 }).note({ intiface: true });
        await tick();
        const stop2 = fakeStop();
        const d = createCrashRecovery({ owner: 'page-d', storage: storage2, locks: locks2, savedHandyKey: () => KA, stopHandy: stop2, onReport: () => {}, bootRecheckMs: 20 });
        await d.atBoot();
        createLiveSessionTracker({ owner: 'page-e', storage: storage2, locks: locks2 }).note({ handyKey: 'KEY-TWO-5678' });
        locks2.crash('page-e');
        await tick(80);
        assert.deepEqual(stop2.asked, [], "page E's marker is left to the next page to open or session to start");
        assert.notEqual(readLiveSession(storage2, 'page-e'), null);
    });

    it('is left out when asked to be', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        createLiveSessionTracker({ owner: 'page-a', storage, locks }).note({ handyKey: KA });
        await tick();
        let queries = 0;
        const counted = { request: locks.request, query: async () => { queries += 1; return locks.query(); } };
        const b = createCrashRecovery({ owner: 'page-b', storage, locks: counted, savedHandyKey: () => KA, stopHandy: fakeStop(), onReport: () => {}, bootRecheckMs: null });
        await b.atBoot();
        await tick(40);
        assert.equal(queries, 1);
    });

    it('does not recover twice what the boot pass took on', async () => {
        const { storage, locks } = crashedPage({ handyKey: KA }, 'page-x');
        const stop = heldStop();
        const b = createCrashRecovery({ owner: 'page-b', storage, locks, savedHandyKey: () => KA, stopHandy: stop, onReport: () => {}, bootRecheckMs: 20 });
        // The record is refused: the marker stays until the stop is settled.
        storage.refuse = true;
        const boot = b.atBoot();
        // Past the second look: the pass it runs finds nothing but a marker
        // this page has taken on, and asks nobody.
        await tick(60);
        assert.deepEqual(stop.asked, [KA], 'one stop');
        storage.refuse = false;
        stop.answer(KA, { outcome: 'stopped', detail: 'result 0', final: true });
        assert.equal((await boot).settled, true);
    });
});

describe('a page Chrome is prerendering', () => {
    // document as a prerendered page sees it: prerendering until activate(),
    // which flips it and fires 'prerenderingchange', as activation does.
    function prerenderedDocument() {
        const doc = new EventTarget();
        doc.prerendering = true;
        doc.activate = () => {
            doc.prerendering = false;
            doc.dispatchEvent(new Event('prerenderingchange'));
        };
        return doc;
    }

    // navigator.locks in that page. The prerendering spec puts
    // [DelayWhilePrerendering] on query() and request(): called before
    // activation, they answer only after it.
    function locksWhilePrerendering(locks, doc) {
        const held = (method) => (...args) => {
            if (!doc.prerendering) return locks[method](...args);
            return new Promise((resolve, reject) => {
                doc.addEventListener('prerenderingchange', () => { locks[method](...args).then(resolve, reject); }, { once: true });
            });
        };
        return { request: held('request'), query: held('query') };
    }

    // Tab A: a session driving the Handy, open.
    async function liveTab() {
        const storage = fakeStorage();
        const locks = fakeLocks();
        createLiveSessionTracker({ owner: 'tab-a', storage, locks }).note(HANDY);
        await tick();
        return { storage, locks };
    }

    it('the hazard: its lock query waits for activation, so a running session looks crashed', async () => {
        // What the recovery did when it ran as soon as the module loaded.
        const { storage, locks } = await liveTab();
        const doc = prerenderedDocument();
        const stopHandy = fakeStop();
        const result = await runCrashRecovery({ storage, locks: locksWhilePrerendering(locks, doc), savedHandyKey: '', stopHandy, onReport: () => {}, ownerQueryTimeoutMs: 20 });
        assert.equal(result.recovered, true);
        assert.deepEqual(stopHandy.asked, ['KEY-ONE-1234'], "tab A's Handy was stopped from a page nobody opened");
        assert.equal(onlyMarker(storage), null, "and tab A's marker was gone");
    });

    it('recovers nothing before activation, and on activation sees that tab A is open', async () => {
        const { storage, locks } = await liveTab();
        const doc = prerenderedDocument();
        const stopHandy = fakeStop();
        const reports = [];
        let running = null;
        const ranNow = whenActivated(doc, () => {
            running = runCrashRecovery({ storage, locks: locksWhilePrerendering(locks, doc), savedHandyKey: 'KEY-ONE-1234', stopHandy, onReport: (t) => reports.push(t), ownerQueryTimeoutMs: 20 });
        });
        assert.equal(ranNow, false);
        await tick(60);
        assert.equal(running, null, 'not started while prerendering');
        assert.deepEqual(stopHandy.asked, []);
        assert.equal(onlyMarker(storage).owner, 'tab-a');
        doc.activate();
        const result = await running;
        assert.equal(result.recovered, false);
        assert.equal(result.alive, 1);
        assert.deepEqual(stopHandy.asked, []);
        assert.deepEqual(reports, [], 'no crash is reported');
        assert.equal(onlyMarker(storage).owner, 'tab-a');
        // Tab A keeps its crash recovery: when it dies, the next page stops its Handy.
        locks.crash('tab-a');
        const next = fakeStop();
        await runCrashRecovery({ storage, locks, savedHandyKey: '', stopHandy: next, onReport: () => {} });
        assert.deepEqual(next.asked, ['KEY-ONE-1234']);
    });

    it('a prerender that is never opened leaves the report of a real crash to the page the wearer opens', async () => {
        const { storage, locks } = crashedPage();
        const doc = prerenderedDocument();
        const hidden = fakeStop();
        whenActivated(doc, () => {
            runCrashRecovery({ storage, locks: locksWhilePrerendering(locks, doc), savedHandyKey: 'KEY-ONE-1234', stopHandy: hidden, onReport: () => assert.fail('a page nobody opened reports nothing') });
        });
        await tick(60);
        assert.deepEqual(hidden.asked, []);
        assert.notEqual(onlyMarker(storage), null);
        assert.deepEqual(readPendingCrashStops(storage), []);
        // The wearer opens EdgeLoop; the prerender is thrown away unseen.
        const stop = fakeStop({ 'KEY-ONE-1234': { outcome: 'stopped', detail: 'result 0' } });
        const reports = [];
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: stop, onReport: (t) => reports.push(t) });
        assert.deepEqual(stop.asked, ['KEY-ONE-1234']);
        assert.equal(result.settled, true);
        assert.ok(reports[0].startsWith(CRASH_HEADLINE));
        assert.match(reports[reports.length - 1], /it was still moving and has stopped\.$/);
    });

    it('a prerender opened after a crash recovers it on activation', async () => {
        const { storage, locks } = crashedPage();
        const doc = prerenderedDocument();
        const stop = fakeStop({ 'KEY-ONE-1234': { outcome: 'stopped', detail: 'result 0' } });
        const reports = [];
        let running = null;
        whenActivated(doc, () => {
            running = runCrashRecovery({ storage, locks: locksWhilePrerendering(locks, doc), savedHandyKey: 'KEY-ONE-1234', stopHandy: stop, onReport: (t) => reports.push(t) });
        });
        await tick(20);
        assert.deepEqual(stop.asked, []);
        doc.activate();
        const result = await running;
        assert.deepEqual(stop.asked, ['KEY-ONE-1234']);
        assert.equal(result.settled, true);
        assert.match(reports[reports.length - 1], /has stopped\.$/);
    });

    it('whenActivated runs at once in a page that is not prerendering, and only once after activation', () => {
        let runs = 0;
        const count = () => { runs += 1; };
        assert.equal(whenActivated({ prerendering: false }, count), true);
        assert.equal(whenActivated({}, count), true, 'a browser without prerendering');
        assert.equal(whenActivated(null, count), true);
        assert.equal(runs, 3);
        const doc = prerenderedDocument();
        runs = 0;
        whenActivated(doc, count);
        doc.dispatchEvent(new Event('prerenderingchange'));
        assert.equal(runs, 0, 'not while document.prerendering still says so');
        doc.activate();
        doc.activate();
        assert.equal(runs, 1);
        // A document that says it is prerendering but cannot tell when it
        // stops is left alone rather than recovered from a hidden page.
        assert.equal(whenActivated({ prerendering: true }, count), false);
        assert.equal(runs, 1);
    });
});

describe('the stops still owed', () => {
    const K = 'KEY-ONE-1234';
    const OFFLINE = { outcome: 'offline', detail: 'Device not connected' };
    const PROMISE = /stopped sending it after 5 minutes and sends it again the next time it opens\.$/;
    const last = (reports) => reports[reports.length - 1];

    it('a session run in between, and stopped cleanly, does not take back the stop the banner promised', async () => {
        const { storage, locks } = crashedPage();
        // The page that opens next: the Handy stays offline all through its window.
        const stop = heldStop();
        const reports = [];
        const page2 = runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stop, onReport: (t) => reports.push(t) });
        await tick();
        stop.answer(K, { ...OFFLINE, final: false });
        // Meanwhile the wearer carries on with an Intiface toy on that page, and presses STOP.
        const session = createLiveSessionTracker({ owner: 'page-b', storage, locks });
        session.note({ intiface: true });
        assert.equal(onlyMarker(storage).owner, 'page-b');
        session.clear();
        assert.equal(onlyMarker(storage), null);
        stop.answer(K, { ...OFFLINE, final: true });
        assert.equal((await page2).settled, false);
        assert.match(last(reports), PROMISE);
        // The next page to open: the Handy is reachable again.
        const next = fakeStop({ [K]: { outcome: 'stopped', detail: 'result 0' } });
        const nextReports = [];
        const page3 = await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: next, onReport: (t) => nextReports.push(t) });
        assert.deepEqual(next.asked, [K], 'the promised stop goes out');
        assert.equal(page3.settled, true);
        assert.ok(nextReports[0].startsWith(EARLIER_CRASH_HEADLINE), nextReports[0]);
        assert.match(last(nextReports), /confirmed it \(result 0\): it was still moving and has stopped\.$/);
        // That settles it.
        const later = fakeStop();
        assert.equal((await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: later })).recovered, false);
        assert.deepEqual(later.asked, []);
    });

    it('nor does a session with another Handy, which is not stopped at the next open', async () => {
        const { storage, locks } = crashedPage();
        const stop = heldStop();
        const page2 = runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stop });
        await tick();
        // Another Handy is connected (and saved) on that page, driven, and stopped cleanly.
        const session = createLiveSessionTracker({ owner: 'page-b', storage, locks });
        session.note({ handyKey: 'KEY-TWO-5678' });
        session.clear();
        stop.answer(K, { ...OFFLINE, final: true });
        await page2;
        const next = fakeStop();
        await runCrashRecovery({ storage, locks, savedHandyKey: 'KEY-TWO-5678', stopHandy: next });
        assert.deepEqual(next.asked, [K], 'the Handy owed a stop, not the one whose session ended cleanly');
    });

    it('the promise is one more try: when that try gives up too, nothing more is owed or promised', async () => {
        const { storage, locks } = crashedPage();
        const reports = [];
        await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: fakeStop({ [K]: OFFLINE }), onReport: (t) => reports.push(t) });
        assert.match(last(reports), PROMISE);
        const again = fakeStop({ [K]: OFFLINE });
        const againReports = [];
        const page3 = await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: again, onReport: (t) => againReports.push(t) });
        assert.deepEqual(again.asked, [K]);
        assert.equal(page3.settled, false);
        assert.ok(againReports[0].startsWith(EARLIER_CRASH_HEADLINE));
        assert.match(last(againReports), /If The Handy \(key ending 1234\) is moving, switch it off\. EdgeLoop stopped sending it after 5 minutes\.$/);
        assert.deepEqual(readPendingCrashStops(storage), []);
        // A Handy switched off comes back up offline: it does not bring the report back at every start.
        const third = fakeStop();
        const page4 = await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: third, onReport: () => assert.fail('no report') });
        assert.equal(page4.recovered, false);
        assert.deepEqual(third.asked, []);
    });

    it('a page opened before the promise was made does not use it up', async () => {
        const { storage, locks } = crashedPage();
        const first = heldStop();
        const page2 = runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: first });
        await tick();
        // A second tab opens while the first is still sending.
        const second = heldStop();
        const secondReports = [];
        const tab = runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: second, onReport: (t) => secondReports.push(t) });
        await tick();
        assert.deepEqual(second.asked, [K]);
        first.answer(K, { ...OFFLINE, final: true });
        await page2;
        second.answer(K, { ...OFFLINE, final: true });
        await tab;
        assert.match(last(secondReports), PROMISE, 'the promise still holds');
        assert.deepEqual(readPendingCrashStops(storage), [K]);
        // The next page to open is the try.
        const next = fakeStop({ [K]: { outcome: 'stopped', detail: 'result 0' } });
        await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: next });
        assert.deepEqual(next.asked, [K]);
    });

    it('no clock decides it: a clock set back between two tabs does not let the earlier one use up a promise', async () => {
        const realNow = Date.now;
        let clock = 1000;
        Date.now = () => clock;
        try {
            const { storage, locks } = crashedPage();
            const stopA = heldStop();
            const reportsA = [];
            const tabA = runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopA, onReport: (t) => reportsA.push(t) });
            await tick();
            // Tab Z opens while A is still sending; then the clock is set back.
            clock = 5000;
            const stopZ = heldStop();
            const reportsZ = [];
            const tabZ = runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopZ, onReport: (t) => reportsZ.push(t) });
            await tick();
            clock = 2000;
            stopA.answer(K, { ...OFFLINE, final: true });
            await tabA;
            assert.match(last(reportsA), PROMISE, 'A promises the next page to open another try');
            // Z opened before that promise, whatever the clock says now.
            clock = 2500;
            stopZ.answer(K, { ...OFFLINE, final: true });
            await tabZ;
            assert.match(last(reportsZ), PROMISE);
            assert.deepEqual(readPendingCrashStops(storage), [K], "A's promise is still owed");
            clock = 100;
            const next = fakeStop({ [K]: { outcome: 'stopped', detail: 'result 0' } });
            await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: next });
            assert.deepEqual(next.asked, [K], 'and kept by the next page to open');
        } finally {
            Date.now = realNow;
        }
    });

    it('a reload before the stop gave up is not the promised try: the reloaded page makes the promise', async () => {
        const { storage, locks } = crashedPage();
        // Never answered: the page is reloaded while its stop is still going.
        runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: heldStop() });
        await tick();
        const reports = [];
        const reloaded = await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: fakeStop({ [K]: OFFLINE }), onReport: (t) => reports.push(t) });
        assert.equal(reloaded.recovered, true);
        assert.match(last(reports), PROMISE);
        const next = fakeStop({ [K]: { outcome: 'already-stopped', detail: 'result 1' } });
        await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: next });
        assert.deepEqual(next.asked, [K]);
        assert.deepEqual(readPendingCrashStops(storage), []);
    });

    it('a page that dies while the stop is still owed loses neither that stop nor its own session', async () => {
        const { storage, locks } = crashedPage();
        const stop = heldStop();
        runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stop });
        await tick();
        stop.answer(K, { ...OFFLINE, final: false });
        // That page starts a session with an Intiface toy, and dies too.
        createLiveSessionTracker({ owner: 'page-b', storage, locks }).note({ intiface: true });
        locks.crash('page-b');
        const reports = [];
        const next = fakeStop({ [K]: { outcome: 'stopped', detail: 'result 0' } });
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: next, onReport: (t) => reports.push(t) });
        assert.deepEqual(next.asked, [K]);
        assert.equal(result.settled, true);
        const text = last(reports);
        assert.ok(text.startsWith(CRASH_HEADLINE), text);
        assert.ok(text.indexOf(INTIFACE_CRASH_ADVICE) > 0);
        assert.ok(text.indexOf(EARLIER_CRASH_HEADLINE) > text.indexOf(INTIFACE_CRASH_ADVICE));
        assert.match(text, /has stopped\.$/);
        assert.equal(onlyMarker(storage), null);
        assert.deepEqual(readPendingCrashStops(storage), []);
    });

    it('a Handy a page still open is driving is not sent a stop, even when one is owed to it', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        addPendingCrashStops([K, 'KEY-TWO-5678'], storage);
        createLiveSessionTracker({ owner: 'page-live', storage, locks }).note({ handyKey: K, driving: true });
        await tick();
        const stop = fakeStop();
        const reports = [];
        const result = await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stop, onReport: (t) => reports.push(t) });
        assert.equal(result.recovered, true);
        assert.deepEqual(stop.asked, ['KEY-TWO-5678']);
        assert.ok(!reports.some((t) => t.includes(CRASH_HEADLINE)), "the open page's session is not a crash");
        assert.equal(onlyMarker(storage).owner, 'page-live');
    });

    it('but one a page still open has paused, or lost its link to, gets the stop it is owed', async () => {
        for (const since of [{ handyKey: K, driving: false }, { handyKey: '', driving: false }]) {
            const storage = fakeStorage();
            const locks = fakeLocks();
            addPendingCrashStops([K], storage);
            const live = createLiveSessionTracker({ owner: 'page-live', storage, locks });
            live.note({ handyKey: K, driving: true });
            live.note(since);
            await tick();
            const stop = fakeStop();
            const reports = [];
            const result = await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stop, onReport: (t) => reports.push(t) });
            assert.equal(result.settled, true);
            assert.deepEqual(stop.asked, [K], JSON.stringify(since));
            assert.ok(reports[0].startsWith(EARLIER_CRASH_HEADLINE), reports[0]);
            assert.deepEqual(readPendingCrashStops(storage), []);
            assert.equal(onlyMarker(storage).owner, 'page-live');
        }
    });

    it('Connect with the key settles what is owed, and a Connect with another key does not', async () => {
        const { storage, locks } = crashedPage();
        await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: fakeStop({ [K]: OFFLINE }) });
        assert.equal(clearPendingCrashStop('KEY-OTHER-0000', storage), true);
        assert.deepEqual(readPendingCrashStops(storage), [K]);
        assert.equal(clearPendingCrashStop(` ${K} `, storage), true);
        assert.deepEqual(readPendingCrashStops(storage), []);
        const next = fakeStop();
        assert.equal((await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: next })).recovered, false);
        assert.deepEqual(next.asked, []);
    });

    it('the first page to give up promises; one opened before the promise renews it; one opened after it is the try', () => {
        const storage = fakeStorage();
        addPendingCrashStops([K], storage);
        // What a page finds on K before it sends anything.
        const opens = () => readPendingCrashStopPromises(storage).get(K);
        const seenByA = opens();
        const seenByB = opens();
        assert.equal(seenByA, '', 'nothing promised yet');
        assert.equal(notePendingCrashStopGaveUp(K, { seen: seenByA, token: 'a' }, storage), true, 'A promises');
        const seenByC = opens();
        assert.equal(seenByC, 'a');
        // B opened before A's promise: it tells the wearer the same, and only
        // a page opened after B's promise is the try now.
        assert.equal(notePendingCrashStopGaveUp(K, { seen: seenByB, token: 'b' }, storage), true);
        assert.equal(notePendingCrashStopGaveUp(K, { seen: seenByC, token: 'c' }, storage), true, 'opened between the two promises');
        assert.deepEqual(readPendingCrashStops(storage), [K]);
        const seenByD = opens();
        assert.equal(notePendingCrashStopGaveUp(K, { seen: seenByD, token: 'd' }, storage), false, 'the try was made');
        assert.deepEqual(readPendingCrashStops(storage), []);
        assert.equal(notePendingCrashStopGaveUp(K, { seen: seenByD, token: 'e' }, storage), false);
        assert.equal(notePendingCrashStopGaveUp('KEY-NEVER-OWED', { seen: '', token: 'f' }, storage), false);
        assert.equal(notePendingCrashStopGaveUp(K, { token: 'g' }, fakeStorage()), false);
    });

    it('a promise is noted under a token no earlier page found, whatever token it is handed', () => {
        const storage = fakeStorage();
        addPendingCrashStops([K], storage);
        notePendingCrashStopGaveUp(K, { seen: '', token: 'same' }, storage);
        // A page that found nothing, handed the token already standing: a
        // page that found 'same' must not count as the try of this promise.
        assert.equal(notePendingCrashStopGaveUp(K, { seen: '', token: 'same' }, storage), true);
        const renewed = readPendingCrashStopPromises(storage).get(K);
        assert.notEqual(renewed, 'same');
        assert.equal(notePendingCrashStopGaveUp(K, { seen: 'same', token: 'x' }, storage), true, 'not the try of the renewed promise');
        assert.deepEqual(readPendingCrashStops(storage), [K]);
        // Without a usable token, one is made up.
        addPendingCrashStops(['KEY-TWO-5678'], storage);
        notePendingCrashStopGaveUp('KEY-TWO-5678', { seen: '', token: 'not a token!' }, storage);
        assert.match(readPendingCrashStopPromises(storage).get('KEY-TWO-5678'), /^[0-9a-z]+$/);
    });

    it('three pages at once: every promise shown is kept by the first page to open after it', async () => {
        const { storage, locks } = crashedPage();
        const stopA = heldStop();
        const pageA = runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopA });
        await tick();
        const stopB = heldStop();
        const reportsB = [];
        const tabB = runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopB, onReport: (t) => reportsB.push(t) });
        await tick();
        stopA.answer(K, { ...OFFLINE, final: true });
        await pageA;
        // Opened after A's promise, while tab B is still sending.
        const stopC = heldStop();
        const reportsC = [];
        const pageC = runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopC, onReport: (t) => reportsC.push(t) });
        await tick();
        stopB.answer(K, { ...OFFLINE, final: true });
        await tabB;
        assert.match(last(reportsB), PROMISE, 'B promises the next open');
        stopC.answer(K, { ...OFFLINE, final: true });
        await pageC;
        // C opened before B's promise, so C is not the open B promised.
        assert.match(last(reportsC), PROMISE);
        const next = fakeStop({ [K]: { outcome: 'stopped', detail: 'result 0' } });
        await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: next });
        assert.deepEqual(next.asked, [K], "B's and C's promise is kept");
    });

    it('a new crash with a key that is still owed starts its promise over', () => {
        const storage = fakeStorage();
        addPendingCrashStops([K], storage);
        assert.equal(notePendingCrashStopGaveUp(K, { seen: '', token: 'first' }, storage), true);
        const seenBeforeCrash = readPendingCrashStopPromises(storage).get(K);
        addPendingCrashStops([K], storage);
        assert.equal(readPendingCrashStopPromises(storage).get(K), '');
        // Opened after the first promise, but the new crash has promised nothing yet.
        assert.equal(notePendingCrashStopGaveUp(K, { seen: seenBeforeCrash, token: 'second' }, storage), true);
        assert.deepEqual(readPendingCrashStops(storage), [K]);
        const seenAfter = readPendingCrashStopPromises(storage).get(K);
        assert.equal(notePendingCrashStopGaveUp(K, { seen: seenAfter, token: 'third' }, storage), false);
    });

    it('a write the browser refuses never drops a stop that is owed, nor lets the banner promise what may not come', () => {
        const storage = fakeStorage();
        storage.refuse = true;
        assert.deepEqual(addPendingCrashStops([K], storage), [], 'not claimed as stored');
        storage.refuse = false;
        addPendingCrashStops([K, 'KEY-TWO-5678'], storage);
        notePendingCrashStopGaveUp(K, { seen: '', token: 'first' }, storage);
        storage.refuse = true;
        assert.equal(clearPendingCrashStop('KEY-TWO-5678', storage), false);
        // Refused renewal: the older promise stands, and a page that found it
        // could keep it and end it, so this page promises nothing.
        assert.equal(notePendingCrashStopGaveUp(K, { seen: '', token: 'second' }, storage), false);
        // Refused drop: still owed, so the next page does send it.
        assert.equal(notePendingCrashStopGaveUp(K, { seen: 'first', token: 'third' }, storage), true);
        assert.deepEqual(readPendingCrashStops(storage), [K, 'KEY-TWO-5678']);
        // Refused first promise: no page can be the try, so it still holds.
        const fresh = fakeStorage();
        addPendingCrashStops([K], fresh);
        fresh.refuse = true;
        assert.equal(notePendingCrashStopGaveUp(K, { seen: '', token: 'only' }, fresh), true);
        assert.deepEqual(readPendingCrashStops(fresh), [K]);
    });

    it('the banner shows only a promise this page could note', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        addPendingCrashStops([K, 'KEY-TWO-5678'], storage);
        const stop = heldStop();
        const reports = [];
        const page = runCrashRecovery({ storage, locks, savedHandyKey: '', stopHandy: stop, onReport: (t) => reports.push(t) });
        await tick();
        assert.deepEqual(stop.asked, [K, 'KEY-TWO-5678']);
        // Another tab, open since before this page, gives up first and
        // promises K's next try.
        notePendingCrashStopGaveUp(K, { seen: '', token: 'othertab' }, storage);
        storage.refuse = true;
        stop.answer(K, { ...OFFLINE, final: true });
        stop.answer('KEY-TWO-5678', { ...OFFLINE, final: true });
        await page;
        assert.deepEqual(readPendingCrashStops(storage), [K, 'KEY-TWO-5678'], 'both still owed');
        const text = last(reports);
        // K: renewing the promise was refused, so a page that found the other
        // tab's promise could end it.
        assert.match(text, /\(key ending 1234\) is moving, switch it off\. EdgeLoop stopped sending it after 5 minutes\. EdgeLoop sent The Handy \(key ending 5678\)/);
        // The other key had no promise yet: none can end it, so this one holds.
        assert.match(text, /\(key ending 5678\) is moving, switch it off\. EdgeLoop stopped sending it after 5 minutes and sends it again the next time it opens\.$/);
    });

    it('reads only what this module writes, once each, and no more than the cap', () => {
        for (const raw of ['{not json', '[1,2]', 'null', '42', '{"handy":"K-1"}', '{"handy":["K-AS-TEXT"]}']) {
            const storage = fakeStorage();
            storage.setItem(PENDING_CRASH_STOPS_KEY, raw);
            assert.deepEqual(readPendingCrashStops(storage), [], raw);
        }
        const storage = fakeStorage();
        storage.setItem(PENDING_CRASH_STOPS_KEY, JSON.stringify({
            handy: [{ key: 'K-1', promised: 5 }, { key: 'K-1' }, { key: 'bad key' }, null, { key: ' K-2 ', promised: 'soon' }]
        }));
        assert.deepEqual(readPendingCrashStops(storage), ['K-1', 'K-2']);
        assert.deepEqual(readPendingCrashStops(null), []);
        const full = fakeStorage();
        const keys = Array.from({ length: MAX_PENDING_CRASH_STOPS + 3 }, (_, i) => `KEY-${i}`);
        for (const key of keys) addPendingCrashStops([key], full);
        assert.deepEqual(readPendingCrashStops(full), keys.slice(-MAX_PENDING_CRASH_STOPS), 'the newest crash is kept');
    });
});

describe('with the real crash stop (handy.js) and a fake Handy API', () => {
    const K = 'NODE-KEY-0001';
    const defaults = { ...HANDY_TIMINGS, stopRetryDelaysMs: HANDY_TIMINGS.stopRetryDelaysMs.slice() };
    const realFetch = globalThis.fetch;
    let api;

    // The v2 API for one device: offline, every call but /connected answers
    // DeviceNotConnected; online, a stop answers result 0 when the device
    // was moving and 1 when it was not.
    function fakeHandyApi() {
        const device = { online: true, moving: false };
        const requests = [];
        const fetch = async (url, init = {}) => {
            const path = String(url).slice(HANDY_API_BASE.length);
            requests.push(`${init.method || 'GET'} ${path} ${init.headers['X-Connection-Key']}`);
            let body = { result: 0 };
            if (path === '/connected') body = { connected: device.online };
            else if (!device.online) body = { error: { code: 1001, name: 'DeviceNotConnected', message: 'Device not connected', connected: false } };
            else if (path === '/hamp/stop') {
                body = { result: device.moving ? 0 : 1 };
                device.moving = false;
            }
            return { ok: true, status: 200, json: async () => body };
        };
        return { device, requests, fetch };
    }

    // A page that drove the Handy in a session and was killed while it moved.
    function crashedWhileDriving() {
        const storage = fakeStorage();
        const locks = fakeLocks();
        createLiveSessionTracker({ owner: 'page-1', storage, locks }).note({ handyKey: K });
        api.device.moving = true;
        locks.crash('page-1');
        return { storage, locks };
    }

    beforeEach(() => {
        api = fakeHandyApi();
        globalThis.fetch = api.fetch;
        // Five minutes of rounds in a few milliseconds; the rules are the same.
        HANDY_TIMINGS.stopRetryDelaysMs = [1, 2, 3];
        HANDY_TIMINGS.offlineStopRetryMs = 10;
        HANDY_TIMINGS.crashStopWindowMs = 60;
    });

    afterEach(async () => {
        resetHandyCrashStopsForTests();
        await disconnectHandy();
        globalThis.fetch = realFetch;
        Object.assign(HANDY_TIMINGS, defaults);
    });

    it('the stop promised after a clean session in between reaches the Handy the next time EdgeLoop opens', async () => {
        const { storage, locks } = crashedWhileDriving();
        api.device.online = false;
        const reports = [];
        const page2 = runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: (t) => reports.push(t) });
        await tick(15);
        // The wearer carries on with an Intiface toy on that page and presses STOP.
        const session = createLiveSessionTracker({ owner: 'page-2', storage, locks });
        session.note({ intiface: true });
        session.clear();
        const second = await settle(page2);
        assert.equal(second.settled, false);
        assert.match(reports[reports.length - 1], /the device is offline \(Device not connected\), so the stop could not reach it\. If The Handy \(key ending 0001\) is moving, switch it off\. EdgeLoop stopped sending it after 5 minutes and sends it again the next time it opens\.$/);
        assert.ok(api.requests.length >= 1 && api.requests.every((r) => r === `PUT /hamp/stop ${K}`), api.requests.join(', '));

        // The Handy is back online, still moving, and EdgeLoop opens again.
        api.device.online = true;
        api.requests.length = 0;
        const nextReports = [];
        const third = await settle(runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: (t) => nextReports.push(t) }));
        assert.deepEqual(api.requests, [`PUT /hamp/stop ${K}`]);
        assert.equal(api.device.moving, false, 'the Handy has stopped');
        assert.equal(third.settled, true);
        assert.ok(nextReports[0].startsWith(EARLIER_CRASH_HEADLINE), nextReports[0]);
        assert.match(nextReports[nextReports.length - 1], /confirmed it \(result 0\): it was still moving and has stopped\.$/);

        api.requests.length = 0;
        const fourth = await settle(runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: () => {} }));
        assert.equal(fourth.recovered, false);
        assert.deepEqual(api.requests, []);
    });

    it('the promised try is the last one: offline again, nothing more is owed or promised', async () => {
        const { storage, locks } = crashedWhileDriving();
        api.device.online = false;
        await settle(runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: () => {} }));
        api.requests.length = 0;
        const reports = [];
        const next = await settle(runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: (t) => reports.push(t) }));
        assert.equal(next.settled, false);
        assert.ok(api.requests.length >= 1, 'the promised stop went out');
        assert.match(reports[reports.length - 1], /If The Handy \(key ending 0001\) is moving, switch it off\. EdgeLoop stopped sending it after 5 minutes\.$/);
        assert.deepEqual(readPendingCrashStops(storage), []);
        api.requests.length = 0;
        const after = await settle(runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: () => {} }));
        assert.equal(after.recovered, false);
        assert.deepEqual(api.requests, []);
    });

    it('Connect with the key after the stop gave up takes back the promise on the same page, and the next page sends nothing', async () => {
        const { storage, locks } = crashedWhileDriving();
        api.device.online = false;
        const reports = [];
        const page2 = await settle(runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: (t) => reports.push(t) }));
        assert.equal(page2.settled, false);
        assert.match(reports[reports.length - 1], /sends it again the next time it opens\.$/);
        // The Handy is back, still moving, and the wearer connects it on that page.
        api.device.online = true;
        await connectHandy(K);
        assert.equal(api.device.moving, false);
        const text = reports[reports.length - 1];
        assert.match(text, /The Handy \(key ending 0001\) has been connected again, and connecting it confirmed that it is stopped\.$/);
        assert.ok(!text.includes('sends it again'), 'no promise of a stop the next page will not send');
        assert.deepEqual(readPendingCrashStops(storage), []);
        api.requests.length = 0;
        const next = await settle(runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: () => assert.fail('nothing to report') }));
        assert.equal(next.recovered, false);
        assert.deepEqual(api.requests, []);
    });

    it('a tab open all along stops the Handy of a tab that crashed when a session starts in it, and nothing is left behind', async () => {
        // Tab B is open while tab A drives the Handy; A is killed; the wearer
        // carries on in B with an Intiface toy, and presses STOP.
        const { storage, locks } = (() => {
            const store = fakeStorage();
            const lockManager = fakeLocks();
            createLiveSessionTracker({ owner: 'tab-a', storage: store, locks: lockManager }).note({ handyKey: K });
            api.device.moving = true;
            return { storage: store, locks: lockManager };
        })();
        await tick();
        const reports = [];
        const b = createCrashRecovery({
            owner: 'tab-b',
            storage,
            locks,
            savedHandyKey: () => K,
            liveHandyKey: () => '',
            stopHandy: stopHandyAfterCrash,
            onReport: (t) => reports.push(t),
            bootRecheckMs: null
        });
        assert.equal((await settle(b.atBoot())).recovered, false);
        assert.deepEqual(api.requests, [], 'tab A is open: its Handy is its own');
        locks.crash('tab-a');
        b.note({ intiface: true });
        for (let i = 0; i < 50 && api.device.moving; i++) await settle(tick(5));
        assert.equal(api.device.moving, false, 'the Handy tab A left moving has stopped');
        assert.deepEqual(api.requests, [`PUT /hamp/stop ${K}`]);
        await settle(tick(5));
        assert.match(reports[reports.length - 1], /^A session in another EdgeLoop tab or window did not end cleanly: .* The Handy API confirmed it \(result 0\): it was still moving and has stopped\.$/);
        b.clear();
        api.requests.length = 0;
        const next = await settle(runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: () => assert.fail('nothing to report') }));
        assert.equal(next.recovered, false);
        assert.deepEqual(api.requests, []);
        assert.deepEqual(readLiveSessions(storage), []);
        assert.deepEqual(readPendingCrashStops(storage), []);
    });

    it('a Handy a tab still open has only paused is stopped when a tab that drove it after that dies', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        // Tab C ran a session with the Handy and paused it, which stopped it.
        const c = createLiveSessionTracker({ owner: 'tab-c', storage, locks });
        c.note({ handyKey: K, driving: true });
        c.note({ handyKey: K, driving: false });
        // Tab A drove it after that, and was killed while it moved.
        createLiveSessionTracker({ owner: 'tab-a', storage, locks }).note({ handyKey: K, driving: true });
        api.device.moving = true;
        locks.crash('tab-a');
        await tick();
        const reports = [];
        const page = await settle(runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: (t) => reports.push(t) }));
        assert.equal(page.settled, true);
        assert.equal(api.device.moving, false, 'the Handy tab A left moving has stopped');
        assert.deepEqual(api.requests, [`PUT /hamp/stop ${K}`]);
        assert.match(reports[reports.length - 1], /The Handy API confirmed it \(result 0\): it was still moving and has stopped\.$/);
        assert.deepEqual(readPendingCrashStops(storage), []);
        // Tab C is stopped; the next page to open has nothing left to do.
        c.clear();
        api.requests.length = 0;
        const next = await settle(runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: () => assert.fail('nothing to report') }));
        assert.equal(next.recovered, false);
        assert.deepEqual(api.requests, []);
    });

    it('a Handy the dead tab drove that is this page\'s own link, and its session does not drive, is stopped through that link', async () => {
        const storage = fakeStorage();
        const locks = fakeLocks();
        // This page connected the Handy (a verified stop); tab A then drove
        // it and was killed while it moved.
        await connectHandy(K);
        createLiveSessionTracker({ owner: 'tab-a', storage, locks }).note({ handyKey: K, driving: true });
        api.device.moving = true;
        locks.crash('tab-a');
        const reports = [];
        const b = createCrashRecovery({ owner: 'tab-b', storage, locks, savedHandyKey: () => K, liveHandyKey: () => K, stopHandy: stopHandyAfterCrash, onReport: (t) => reports.push(t), bootRecheckMs: null });
        api.requests.length = 0;
        // A session starts here with The Handy's role switched off: every
        // dispatch sends it zero.
        b.note({ handyKey: K, driving: false });
        assert.ok(await until(() => reports.length > 0 && /connected on this page/.test(reports[reports.length - 1])));
        assert.deepEqual(api.requests, [], 'nothing sent from the recovery');
        assert.match(reports[reports.length - 1], /^A session in another EdgeLoop tab or window did not end cleanly: .* The Handy \(key ending 0001\) is connected on this page: EdgeLoop stops it through that connection, unless the session on this page is driving it\.$/);
        assert.deepEqual(readPendingCrashStops(storage), []);
        dispatchHandy(0, 0, 100, false, 0, 100);
        assert.ok(await until(() => !api.device.moving), 'the next zero dispatch stopped it');
        assert.deepEqual(api.requests, [`PUT /hamp/stop ${K}`]);
    });

    it('a stop a session start sends to a Handy the boot pass gave up on answers for both reports', async () => {
        // Page X died driving K; this page opened with K offline and gave up,
        // promising the next page to open another stop.
        const storage = fakeStorage();
        const locks = fakeLocks();
        createLiveSessionTracker({ owner: 'page-x', storage, locks }).note({ handyKey: K });
        locks.crash('page-x');
        api.device.online = false;
        const reports = [];
        const b = createCrashRecovery({ owner: 'tab-b', storage, locks, savedHandyKey: () => '', stopHandy: stopHandyAfterCrash, onReport: (t) => reports.push(t) });
        await settle(b.atBoot());
        const bootText = reports[reports.length - 1];
        assert.match(bootText, /EdgeLoop stopped sending it after 5 minutes and sends it again the next time it opens\.$/);
        // Tab A, open all along, drove K in a session of its own and died.
        api.device.online = true;
        createLiveSessionTracker({ owner: 'tab-a', storage, locks }).note({ handyKey: K });
        api.device.moving = true;
        locks.crash('tab-a');
        // A session starts in this page.
        b.note({ intiface: true });
        for (let i = 0; i < 50 && api.device.moving; i++) await settle(tick(5));
        await settle(tick(5));
        assert.equal(api.device.moving, false);
        const text = reports[reports.length - 1];
        assert.ok(!text.includes('sends it again'), `no promise left standing: ${text}`);
        assert.equal(text.split('it was still moving and has stopped.').length - 1, 2, 'both reports carry the answer');
        assert.ok(text.indexOf(OTHER_PAGE_CRASH_HEADLINE) > text.indexOf(CRASH_HEADLINE));
        assert.deepEqual(readPendingCrashStops(storage), []);
        api.requests.length = 0;
        const next = await settle(runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: () => assert.fail('nothing to report') }));
        assert.equal(next.recovered, false);
        assert.deepEqual(api.requests, []);
    });

    it('Connect with the key during the window takes the owed stop over, and the next page sends nothing', async () => {
        // A window that cannot close before Connect, however slow the machine.
        HANDY_TIMINGS.crashStopWindowMs = 60000;
        const { storage, locks } = crashedWhileDriving();
        api.device.online = false;
        const reports = [];
        const page2 = runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: stopHandyAfterCrash, onReport: (t) => reports.push(t) });
        assert.ok(await until(() => api.requests.length >= 1), 'the stop is on the wire');
        const connecting = connectHandy(K);
        api.device.online = true;
        await connecting;
        const second = await settle(page2);
        assert.equal(second.settled, true);
        assert.match(reports[reports.length - 1], /The Handy \(key ending 0001\) has been connected again, and connecting it confirmed that it is stopped\.$/);
        assert.deepEqual(readPendingCrashStops(storage), []);
        const next = fakeStop();
        assert.equal((await runCrashRecovery({ storage, locks, savedHandyKey: K, stopHandy: next })).recovered, false);
        assert.deepEqual(next.asked, []);
    });

    // app.js notes what a live session drives before every dispatch and
    // again after it (dispatchHardware), with whether the session drives The
    // Handy right now (drivesHandyNow). That flips at every start and every
    // stop of the Handy - a beat of the pattern that drops to zero, Full Stop
    // at the ceiling, the stall guard, a pause, a freeze - several times a
    // minute. A marker rewritten at each of them spent Chromium's
    // localStorage commit budget of 60 commits an hour: a Climax HR lowered
    // mid-session, a Came Early and the session log then reached the disk up
    // to a minute late, and a browser killed in that minute lost them.
    it('no dispatch rewrites the marker, in either store: only a session start, a toy that joins and the end do', async () => {
        const local = fakeStorage();
        const durable = fakeDurable();
        const storage = createCrashRecoveryStorage({ local, durable });
        await storage.read();
        const locks = fakeLocks();
        const page = createCrashRecovery({ owner: 'page-a', storage, locks, stopHandy: stopHandyAfterCrash, onReport: () => {}, bootRecheckMs: null });
        await settle(page.atBoot());
        await connectHandy(K);
        let status = 'RUNNING';
        let frozen = false;
        let intiface = false;
        const hardware = () => ({
            handyKey: K,
            driving: drivesHandyNow({ sessionStatus: status, handyKey: K, mayBeMoving: handyMayBeMoving(), frozen }),
            intiface,
            tcode: false
        });
        // What the last note() was told: what the lock must say until the
        // next one.
        let noted = null;
        // dispatchHardware, with the real driver: forced, so that its 400 ms
        // throttle lets every beat through at once.
        const dispatch = async (speed) => {
            page.note(hardware());
            dispatchHandy(speed, 0, 100, true);
            noted = hardware();
            page.note(noted);
            // The driver's answer: a start in flight or landed, or a stop
            // confirmed.
            assert.ok(await settle(until(() => handyMayBeMoving() === speed > 0, 2000)), `speed ${speed}`);
        };
        const writes = () => ({ local: local.writes, durable: durable.writes.length });
        const seen = new Set();
        const lockSaysWhatWasNoted = async (what) => {
            const driven = await drivenBy('page-a', locks);
            assert.deepEqual(driven, noted.driving ? [K] : [], what);
            seen.add(driven.length);
        };
        const before = writes();
        await dispatch(60);
        await settle(storage.settled());
        const marker = { handy: [K], intiface: false, tcode: false, gen: 1 };
        assert.deepEqual(JSON.parse(local.getItem(liveSessionKey('page-a'))), marker);
        assert.deepEqual(JSON.parse(durable.disk.get(liveSessionKey('page-a'))), marker);
        const started = writes();
        assert.deepEqual(started, { local: before.local + 1, durable: before.durable + 1 }, 'the session start writes its marker to each store, once');
        await lockSaysWhatWasNoted('started');
        // Classic beats that start and stop the Handy: the first zero-speed
        // tick stops it, the next one notes that it has stopped.
        for (const speed of [70, 0, 0, 65, 80, 0, 0, 50, 0, 0, 75]) {
            await dispatch(speed);
            await lockSaysWhatWasNoted(`speed ${speed}`);
        }
        // A pause: its forced stop. RESUME runs the pass of a session start.
        status = 'PAUSED';
        await dispatch(0);
        await lockSaysWhatWasNoted('paused');
        status = 'RUNNING';
        await settle(page.sessionResumed());
        await dispatch(60);
        await lockSaysWhatWasNoted('resumed');
        // A freeze: the page notes it drives nothing, and runs nothing until
        // it is resumed.
        frozen = true;
        noted = hardware();
        page.note(noted);
        await lockSaysWhatWasNoted('frozen');
        frozen = false;
        await dispatch(60);
        await lockSaysWhatWasNoted('awake');
        await settle(storage.settled());
        assert.deepEqual(Array.from(seen).sort(), [0, 1], 'the Handy was driven and left, again and again');
        assert.deepEqual(writes(), started, 'and no dispatch wrote anything to either store');
        // A toy that joins is news a later page needs: written once more.
        intiface = true;
        await dispatch(60);
        await dispatch(60);
        await settle(storage.settled());
        assert.deepEqual(writes(), { local: started.local + 1, durable: started.durable + 1 });
        // STOP: status and motors first, then the end, once.
        status = 'IDLE';
        dispatchHandy(0, 0, 100, true);
        page.clear();
        await settle(storage.settled());
        assert.deepEqual(writes(), { local: started.local + 2, durable: started.durable + 2 });
        assert.equal(local.getItem(liveSessionKey('page-a')), durable.disk.get(liveSessionKey('page-a')));
        assert.equal(JSON.parse(local.getItem(liveSessionKey('page-a'))).ended, 2);
        await tick();
        assert.deepEqual(locks.names(), [], 'and it lets go of every lock');
    });
});

// A durable store as crash-recovery.js sees it (durable-store.js makes the
// real one out of IndexedDB): writes and swaps run one at a time and in
// order, the way IndexedDB runs readwrite transactions on one store, at once
// or - in 'manual' mode - when the test says, or fail, or hang. `disk` is
// what has committed, and it is what a browser started after a kill finds;
// a killed store commits nothing more.
function fakeDurable({ disk = new Map(), mode = 'ok' } = {}) {
    const d = { disk, mode, writes: [], swaps: [], waiting: [], dead: false, readMode: 'ok', readDelayMs: 0 };
    let chain = Promise.resolve();
    const queued = [];
    const queue = (apply, failed) => {
        const entry = { started: false, dropped: false };
        queued.push(entry);
        const run = chain.then(() => new Promise((resolve) => {
            entry.started = true;
            if (entry.dropped || d.mode === 'fail') resolve(failed());
            else if (d.mode === 'manual' || d.mode === 'hang') d.waiting.push(() => resolve(d.dead ? failed() : apply()));
            else setTimeout(() => resolve(d.dead ? failed() : apply()), 0);
        }));
        chain = run;
        return run;
    };
    // The page that made every transaction still queued behind the one
    // running goes - reloaded, or its tab closed - and Chromium rolls them
    // back with it: they never reach the disk, and the store runs what comes
    // after them.
    d.dropQueued = () => {
        for (const entry of queued) if (!entry.started) entry.dropped = true;
    };
    d.write = (changes) => {
        const entry = { changes: changes.map(([key, value]) => [key, value]) };
        d.writes.push(entry);
        return queue(() => {
            for (const [key, value] of entry.changes) {
                if (value === null) d.disk.delete(key);
                else d.disk.set(key, value);
            }
            return true;
        }, () => false);
    };
    d.swap = (entries) => {
        const list = entries.map((entry) => entry.slice());
        d.swaps.push(list);
        return queue(() => list.map(([key, expected, next]) => {
            if (d.disk.get(key) !== expected) return false;
            if (next === null) d.disk.delete(key);
            else d.disk.set(key, next);
            return true;
        }), () => list.map(() => false));
    };
    // Commits the oldest write still waiting.
    d.commit = async () => {
        await until(() => d.waiting.length > 0, 500);
        const next = d.waiting.shift();
        if (next) next();
        await tick(1);
    };
    d.readAll = () => {
        if (d.readMode === 'fail') return Promise.resolve(null);
        return tick(d.readDelayMs).then(() => (d.dead ? null : new Map(d.disk)));
    };
    return d;
}

// One browser: localStorage as its pages see it, what of it Chromium has
// written to disk so far, and the durable store. commitLocalStorage() is
// Chromium's localStorage commit timer firing, which it may do at any moment
// of a session: no sooner than 5 s after the first change since the last
// commit, no more than 60 times and 10 MiB an hour, and whenever any other
// origin's timer fires. kill() is the whole browser SIGKILLed, and returns
// the browser started next, which finds only what reached the disk.
// `storage` is a page that has booted - it has read the durable store - and
// page() a page just opened, which sends nothing there before it has read it.
async function startBrowser({ localOnDisk = new Map(), durableOnDisk = new Map(), mode = 'ok', timeoutMs, read = true } = {}) {
    const local = fakeStorage(localOnDisk);
    const durable = fakeDurable({ disk: durableOnDisk, mode });
    const b = {
        local,
        durable,
        locks: fakeLocks(),
        localOnDisk: new Map(localOnDisk),
        // Another page of this browser: the same stores, a storage of its own.
        page: () => createCrashRecoveryStorage({ local, durable, timeoutMs }),
        commitLocalStorage() { b.localOnDisk = local.image(); },
        kill({ read: readNext = true } = {}) {
            durable.dead = true;
            return startBrowser({ localOnDisk: b.localOnDisk, durableOnDisk: new Map(durable.disk), read: readNext });
        }
    };
    b.storage = b.page();
    if (read) await b.storage.read();
    return b;
}

// What the durable store holds under `owner`'s marker key, parsed.
function onDisk(b, owner = 'page-a') {
    const text = b.durable.disk.get(liveSessionKey(owner));
    return text === undefined ? null : JSON.parse(text);
}

describe('a browser that is killed: the durable copy', () => {
    const NOTHING = { handy: false, intiface: false, tcode: false };

    it('killed before localStorage wrote the marker: the next start finds it on disk, stops the Handy and says so', async () => {
        const first = await startBrowser();
        // A setting changed before START made localStorage commit; the marker
        // written at START would reach its disk only a minute later.
        first.local.setItem('handy_max_cap', '90');
        first.commitLocalStorage();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks });
        tracker.note({ ...HANDY, driving: true });
        assert.deepEqual(tracker.waitingForDisk(), { handy: true, intiface: false, tcode: false }, 'no command before the marker is on disk');
        await first.storage.settled();
        assert.deepEqual(tracker.waitingForDisk(), NOTHING);
        const next = await first.kill();
        assert.deepEqual(readLiveSessions(next.local), [], 'localStorage lost the marker');
        assert.equal(next.local.getItem('handy_max_cap'), '90');
        const stop = fakeStop();
        const reports = [];
        const result = await runCrashRecovery({ storage: next.storage, locks: next.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.equal(result.recovered, true);
        assert.deepEqual(stop.asked, ['KEY-ONE-1234']);
        assert.ok(reports.at(-1).startsWith(CRASH_HEADLINE));
        assert.match(reports.at(-1), /confirmed the stop/);
        await next.storage.settled();
        assert.equal(onDisk(next).ended, 1, 'the disk now records that session as handed over');
        assert.deepEqual(readPendingCrashStops(next.local), [], 'and the stop it asked for is settled');
        // So the next start after that finds nothing to do.
        const later = fakeStop();
        const again = await next.kill();
        assert.equal((await runCrashRecovery({ storage: again.storage, locks: again.locks, savedHandyKey: '', stopHandy: later, onReport: () => {} })).recovered, false);
        assert.deepEqual(later.asked, []);
    });

    it('which it did not, with localStorage alone', async () => {
        // The same session and the same kill, as the page kept it before
        // there was a durable copy.
        const first = await startBrowser();
        first.local.setItem('handy_max_cap', '90');
        first.commitLocalStorage();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: createCrashRecoveryStorage({ local: first.local }), locks: first.locks });
        tracker.note({ ...HANDY, driving: true });
        const next = await first.kill();
        const stop = fakeStop();
        await runCrashRecovery({ storage: createCrashRecoveryStorage({ local: next.local }), locks: next.locks, savedHandyKey: '', stopHandy: stop, onReport: () => {} });
        assert.deepEqual(stop.asked, [], 'the Handy is left stroking');
    });

    it('killed within a minute of a clean STOP: nothing is sent or reported, and localStorage is given the end in the copy\'s place', async () => {
        const first = await startBrowser();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks, now: () => 1000 });
        tracker.note({ ...HANDY, driving: true });
        await first.storage.settled();
        // localStorage wrote the marker to disk mid-session, and then STOP
        // replaced it with the end of the session: only the durable store
        // has written that.
        first.commitLocalStorage();
        tracker.clear();
        await first.storage.settled();
        assert.deepEqual(onDisk(first), { ended: 1, at: 1000 });
        assert.equal(first.local.getItem(liveSessionKey('page-a')), endedRecord(1, 1000), 'localStorage has the end too, not yet on its disk');
        const next = await first.kill();
        assert.equal(readLiveSessions(next.local).length, 1, 'localStorage still has the marker on disk');
        assert.deepEqual(readLiveSessions(next.local, { records: new Map(next.durable.disk), seq: 0 }), [], 'but it is no marker');
        const stop = fakeStop();
        const reports = [];
        const result = await runCrashRecovery({ storage: next.storage, locks: next.locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: stop, onReport: (text) => reports.push(text), now: () => 5000 });
        assert.equal(result.recovered, false);
        assert.deepEqual(stop.asked, []);
        assert.deepEqual(reports, []);
        assert.equal(next.local.getItem(liveSessionKey('page-a')), endedRecord(1, 5000), 'the stale copy is replaced by the end, stamped with the time it was written');
        assert.deepEqual(onDisk(next), { ended: 1, at: 1000 }, 'and the durable store keeps the end it had');
        // So a later page that cannot read the durable store finds nothing either.
        const later = fakeStop();
        await runCrashRecovery({ storage: next.local, locks: next.locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: later, onReport: () => {} });
        assert.deepEqual(later.asked, []);
    });

    it('a stale copy is replaced in localStorage alone, whether the durable store can be written or not, and only while its page is gone', async () => {
        const key = liveSessionKey('page-a');
        const staleCopy = JSON.stringify({ handy: ['KEY-ONE-1234'], intiface: false, tcode: false, gen: 1 });
        const disks = () => ({ localOnDisk: new Map([[key, staleCopy]]), durableOnDisk: new Map([[key, endedRecord(1, 0)]]) });
        for (const mode of ['ok', 'fail']) {
            const b = await startBrowser(disks());
            b.durable.mode = mode;
            const reports = [];
            const stop = fakeStop();
            await runCrashRecovery({ storage: b.storage, locks: b.locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: stop, onReport: (text) => reports.push(text), now: () => 50 });
            await b.storage.settled();
            assert.equal(b.local.getItem(key), endedRecord(1, 50), mode);
            assert.equal(b.durable.disk.get(key), endedRecord(1, 0), `${mode}: the durable store is left as it was`);
            assert.equal(b.durable.writes.length + b.durable.swaps.length, 0, `${mode}: nothing sent to it`);
            assert.deepEqual(stop.asked, [], mode);
            assert.deepEqual(reports, [], `${mode}: and it is no crash`);
        }
        // A page still open is left to itself.
        const c = await startBrowser(disks());
        let release = null;
        c.locks.request(liveSessionLockName('page-a'), () => new Promise((resolve) => { release = resolve; }));
        await runCrashRecovery({ storage: c.storage, locks: c.locks, savedHandyKey: '', stopHandy: fakeStop(), onReport: () => {} });
        assert.equal(c.local.getItem(key), staleCopy);
        if (release) release();
    });

    it('which, with localStorage alone, was reported as a crash', async () => {
        const first = await startBrowser();
        const storage = createCrashRecoveryStorage({ local: first.local });
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage, locks: first.locks });
        tracker.note({ ...HANDY, driving: true });
        first.commitLocalStorage();
        tracker.clear();
        const next = await first.kill();
        const reports = [];
        await runCrashRecovery({ storage: createCrashRecoveryStorage({ local: next.local }), locks: next.locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: fakeStop(), onReport: (text) => reports.push(text) });
        assert.ok(reports.at(-1).startsWith(CRASH_HEADLINE), 'a crash that had not happened');
    });

    it('an IndexedDB that does not answer at START: localStorage wrote the marker to disk, the Handy moved, and the next start stops it', async () => {
        for (const how of ['hang', 'fail']) {
            const first = await startBrowser({ timeoutMs: 30 });
            first.durable.mode = how;
            const tracker = createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks });
            tracker.note(HANDY);
            // Chromium's localStorage commit timer fires with the marker in
            // it, before IndexedDB has given up.
            first.commitLocalStorage();
            if (how === 'hang') assert.equal(tracker.waitingForDisk().handy, true, 'held while IndexedDB may still answer');
            assert.equal(await settle(until(() => !tracker.waitingForDisk().handy, 2000)), true, `${how}: the session goes on`);
            // Its first command reaches the Handy now, and the browser is
            // killed before localStorage commits again.
            const next = await first.kill();
            assert.equal(next.durable.disk.size, 0, `${how}: IndexedDB has no record of the session`);
            assert.equal(readLiveSessions(next.local).length, 1, `${how}: localStorage has the marker on disk, and nothing beside it`);
            const stop = fakeStop();
            const reports = [];
            const result = await runCrashRecovery({ storage: next.storage, locks: next.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
            assert.equal(result.recovered, true, how);
            assert.deepEqual(stop.asked, ['KEY-ONE-1234'], how);
            assert.ok(reports.at(-1).startsWith(CRASH_HEADLINE), how);
            assert.deepEqual(readLiveSessions(next.local), [], `${how}: handed over`);
            await next.storage.settled();
            assert.equal(onDisk(next).ended, 1, `${how}: and its end is on disk`);
        }
    });

    it('nor does the end of an earlier session hide a later one whose durable copy was never written', async () => {
        const first = await startBrowser({ timeoutMs: 30 });
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks });
        // Session 1, stopped cleanly: its end is on disk.
        tracker.note(HANDY);
        await first.storage.settled();
        tracker.clear();
        await first.storage.settled();
        assert.equal(onDisk(first).ended, 1);
        // Session 2 in the same page, with another Handy, while IndexedDB
        // does not answer.
        first.durable.mode = 'hang';
        tracker.note({ handyKey: 'KEY-TWO-5678' });
        first.commitLocalStorage();
        assert.equal(await settle(until(() => !tracker.waitingForDisk().handy, 2000)), true);
        const next = await first.kill();
        assert.equal(readLiveSession(next.local, 'page-a').gen, 2, 'localStorage has session 2 on disk');
        assert.equal(onDisk(next).ended, 1, 'the durable store only the end of session 1');
        const stop = fakeStop();
        const reports = [];
        await runCrashRecovery({ storage: next.storage, locks: next.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.deepEqual(stop.asked, ['KEY-TWO-5678']);
        assert.ok(reports.at(-1).startsWith(CRASH_HEADLINE));
    });

    it('nor the end a page wrote when it took a live page for crashed: that page writes its marker again, under a newer generation', async () => {
        const b = await startBrowser({ timeoutMs: 30 });
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks });
        const TOYS = { ...HANDY, intiface: true, driving: true };
        tracker.note(TOYS);
        await b.storage.settled();
        // A page with no lock manager cannot tell page-a is open: it hands
        // page-a's session over, and writes its end.
        const other = b.page();
        await other.read();
        await runCrashRecovery({ storage: other, locks: null, owner: 'page-b', savedHandyKey: '', stopHandy: fakeStop(), onReport: () => {} });
        await other.settled();
        assert.equal(readLiveSession(b.local, 'page-a'), null);
        assert.equal(onDisk(b).ended, 1);
        // page-a's next dispatch writes its marker again, as a newer
        // generation, and IndexedDB does not answer.
        b.durable.mode = 'hang';
        tracker.note(TOYS);
        assert.equal(readLiveSession(b.local, 'page-a').gen, 2);
        b.commitLocalStorage();
        const next = await b.kill();
        const reports = [];
        await runCrashRecovery({ storage: next.storage, locks: next.locks, savedHandyKey: '', stopHandy: fakeStop(), onReport: (text) => reports.push(text) });
        // The session that was running is reported, with its Intiface toy,
        // which no stop still owed would have brought back.
        assert.ok(reports.at(-1).startsWith(CRASH_HEADLINE));
        assert.ok(reports.at(-1).includes(INTIFACE_CRASH_ADVICE));
    });

    it('a pause or resume is no new generation, and no disk write', async () => {
        const b = await startBrowser();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks });
        tracker.note({ ...HANDY, driving: true });
        await b.storage.settled();
        const writes = b.durable.writes.length;
        for (let i = 0; i < 5; i++) {
            tracker.note({ ...HANDY, driving: false });
            tracker.note({ ...HANDY, driving: true });
        }
        await b.storage.settled();
        assert.equal(readLiveSession(b.local, 'page-a').gen, 1);
        assert.equal(b.durable.writes.length, writes);
        // A toy that joins is.
        tracker.note({ ...HANDY, tcode: true });
        assert.equal(readLiveSession(b.local, 'page-a').gen, 2);
    });

    it('holds back the first command to each toy until the marker on disk names it, and says when that changes', async () => {
        const b = await startBrowser({ mode: 'manual' });
        let told = 0;
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks, onDurable: () => { told += 1; } });
        assert.deepEqual(tracker.waitingForDisk(), NOTHING, 'no session, nothing to wait for');
        tracker.note(HANDY);
        assert.deepEqual(tracker.waitingForDisk(), { handy: true, intiface: false, tcode: false });
        await b.durable.commit();
        assert.deepEqual(tracker.waitingForDisk(), NOTHING);
        assert.equal(told, 1, 'told when the commit landed');
        // A toy that joins mid-session waits; the Handy already named does not.
        tracker.note({ ...HANDY, intiface: true });
        assert.deepEqual(tracker.waitingForDisk(), { handy: false, intiface: true, tcode: false });
        await b.durable.commit();
        assert.deepEqual(tracker.waitingForDisk(), NOTHING);
        // So does another Handy.
        tracker.note({ handyKey: 'KEY-TWO-5678', intiface: true, tcode: true });
        assert.deepEqual(tracker.waitingForDisk(), { handy: true, intiface: false, tcode: true });
        await b.durable.commit();
        assert.deepEqual(tracker.waitingForDisk(), NOTHING);
        // Pausing and resuming changes what the session drives now, which
        // is no disk write, and holds nothing back.
        const writes = b.durable.writes.length;
        tracker.note({ handyKey: 'KEY-TWO-5678', intiface: true, tcode: true, driving: true });
        tracker.note({ handyKey: 'KEY-TWO-5678', intiface: true, tcode: true, driving: false });
        assert.deepEqual(tracker.waitingForDisk(), NOTHING);
        await tick(5);
        assert.equal(b.durable.writes.length, writes);
        // STOP and START at once: the new session waits for its own marker,
        // even with the same Handy - the last one's end is on its way.
        tracker.clear();
        tracker.note(HANDY);
        assert.deepEqual(tracker.waitingForDisk(), { handy: true, intiface: false, tcode: false });
        await b.durable.commit();
        assert.deepEqual(onDisk(b), { ended: 3, at: onDisk(b).at }, 'the end landed first');
        assert.deepEqual(tracker.waitingForDisk(), { handy: true, intiface: false, tcode: false }, 'and the new marker is still on its way');
        await b.durable.commit();
        assert.deepEqual(tracker.waitingForDisk(), NOTHING);
        assert.equal(onDisk(b).gen, 4);
    });

    it('with IndexedDB hung or failing, a toy that joins waits for its own change alone, and a toy the session has commanded is never held again', async () => {
        for (const how of ['hang', 'fail']) {
            const b = await startBrowser({ timeoutMs: 30 });
            b.durable.mode = how;
            let told = 0;
            const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks, onDurable: () => { told += 1; } });
            tracker.note({ ...HANDY, driving: true });
            assert.equal(tracker.waitingForDisk().handy, true, `${how}: the first command waits`);
            assert.equal(await settle(until(() => !tracker.waitingForDisk().handy, 2000)), true, `${how}: no longer than the timeout`);
            // The Handy has had its commands since, and is moving. An
            // Intiface toy joins; the pulse then reaches the ceiling, set to
            // Full Stop: the Handy's stop must go out at once.
            tracker.note({ ...HANDY, driving: true, intiface: true });
            assert.deepEqual(tracker.waitingForDisk(), { handy: false, intiface: true, tcode: false }, `${how}: only the toy that joined waits`);
            const toldBefore = told;
            assert.equal(await settle(until(() => !tracker.waitingForDisk().intiface, 2000)), true, `${how}: no longer than the timeout either`);
            assert.ok(told > toldBefore, `${how}: and whoever held it back is told`);
            // A T-Code device that joins after that holds back neither of them.
            tracker.note({ ...HANDY, driving: false, intiface: true, tcode: true });
            assert.deepEqual(tracker.waitingForDisk(), { handy: false, intiface: false, tcode: true }, how);
            assert.equal(await settle(until(() => !tracker.waitingForDisk().tcode, 2000)), true, how);
            // A new session waits for a marker of its own again.
            tracker.clear();
            tracker.note(HANDY);
            assert.equal(tracker.waitingForDisk().handy, true, `${how}: the next session's first command waits`);
        }
    });

    it('an IndexedDB that cannot be read holds back no command past the read that found it so, however long the timeout', async () => {
        // Found at boot: the first command of a session, and the first to a
        // toy that joins, go out at once.
        const b = await startBrowser({ read: false, timeoutMs: 60000 });
        b.durable.readMode = 'fail';
        const recovery = createCrashRecovery({ owner: 'page-a', storage: b.storage, locks: b.locks, stopHandy: fakeStop(), onReport: () => {}, bootRecheckMs: null });
        await recovery.atBoot();
        recovery.note(HANDY);
        assert.deepEqual(recovery.waitingForDisk(), NOTHING, 'the first command of a session');
        recovery.note({ ...HANDY, intiface: true });
        assert.deepEqual(recovery.waitingForDisk(), NOTHING, 'and the first to a toy that joins');
        // Found by the pass a session start runs: held until that read
        // answers, and no longer.
        const c = await startBrowser({ read: false, timeoutMs: 60000 });
        c.durable.readMode = 'fail';
        let told = 0;
        const other = createCrashRecovery({ owner: 'page-b', storage: c.storage, locks: c.locks, stopHandy: fakeStop(), onReport: () => {}, onDurable: () => { told += 1; }, bootRecheckMs: null });
        other.note(HANDY);
        assert.equal(other.waitingForDisk().handy, true, 'held while the store may still answer');
        assert.equal(await settle(until(() => !other.waitingForDisk().handy, 2000)), true, 'let go when the read fails, not at the timeout a minute away');
        assert.ok(told >= 1, 'and the held dispatch is told');
        // A tab that crashes is still recovered from localStorage.
        c.locks.crash('page-b');
        const stop = fakeStop();
        await runCrashRecovery({ storage: c.local, locks: c.locks, savedHandyKey: '', stopHandy: stop, onReport: () => {} });
        assert.deepEqual(stop.asked, ['KEY-ONE-1234']);
    });

    it('each change waits for its own commit alone: one that failed lets its toys go while a newer one is on its way', async () => {
        const b = await startBrowser({ mode: 'manual' });
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks });
        tracker.note(HANDY);
        await tick(1);
        tracker.note({ ...HANDY, intiface: true });
        assert.deepEqual(tracker.waitingForDisk(), { handy: true, intiface: true, tcode: false });
        // The first change fails; the second is still on its way.
        b.durable.dead = true;
        await b.durable.commit();
        b.durable.dead = false;
        assert.deepEqual(tracker.waitingForDisk(), { handy: false, intiface: true, tcode: false });
        await b.durable.commit();
        assert.deepEqual(tracker.waitingForDisk(), NOTHING);
        assert.deepEqual(onDisk(b), { handy: ['KEY-ONE-1234'], intiface: true, tcode: false, gen: 2 });
    });

    it('the page\'s crash recovery holds a toy back through its own marker, and says when the commit lands', async () => {
        const b = await startBrowser({ mode: 'manual' });
        let told = 0;
        const recovery = createCrashRecovery({
            owner: 'page-a',
            storage: b.storage,
            locks: b.locks,
            savedHandyKey: () => '',
            stopHandy: fakeStop(),
            onReport: () => {},
            onDurable: () => { told += 1; },
            bootRecheckMs: null
        });
        assert.deepEqual(recovery.waitingForDisk(), NOTHING);
        recovery.note(HANDY);
        assert.deepEqual(recovery.waitingForDisk(), { handy: true, intiface: false, tcode: false });
        await b.durable.commit();
        assert.deepEqual(recovery.waitingForDisk(), NOTHING);
        assert.ok(told >= 1);
        recovery.clear();
        await b.durable.commit();
        assert.equal(onDisk(b).ended, 1);
    });

    it('sends the marker to disk the moment it is noted, and its end the moment STOP clears it', async () => {
        const b = await startBrowser({ mode: 'manual' });
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks, now: () => 1234 });
        tracker.note(HANDY);
        assert.equal(b.durable.writes.length, 1, 'on its way before the dispatch that noted it goes on');
        tracker.clear();
        assert.equal(b.durable.writes.length, 2);
        assert.deepEqual(b.durable.writes[1].changes, [[liveSessionKey('page-a'), endedRecord(1, 1234)]]);
        assert.equal(endedRecord(1, 1234), '{"ended":1,"at":1234}');
    });

    it('never writes which Handy a session drives right now, to either store', async () => {
        const b = await startBrowser();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks });
        tracker.note({ ...HANDY, driving: true });
        await b.storage.settled();
        const marker = { handy: ['KEY-ONE-1234'], intiface: false, tcode: false, gen: 1 };
        assert.deepEqual(JSON.parse(b.local.getItem(liveSessionKey('page-a'))), marker, 'localStorage holds the marker alone');
        assert.deepEqual(onDisk(b), marker, 'and so does the durable store');
        const writes = { local: b.local.writes, durable: b.durable.writes.length };
        tracker.note({ ...HANDY, driving: false });
        tracker.note({ ...HANDY, driving: true });
        await b.storage.settled();
        assert.deepEqual({ local: b.local.writes, durable: b.durable.writes.length }, writes);
        assert.deepEqual(await drivenBy('page-a', b.locks), ['KEY-ONE-1234'], 'the lock says it');
    });

    it('an IndexedDB that fails holds nothing back, and a crashed tab is still recovered from localStorage', async () => {
        const b = await startBrowser({ mode: 'fail' });
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks });
        tracker.note(HANDY);
        await b.storage.settled();
        assert.deepEqual(tracker.waitingForDisk(), NOTHING);
        // The tab crashes; another tab of the same browser reads a durable
        // store that works again, and has no record of the session.
        b.locks.crash('page-a');
        b.durable.mode = 'ok';
        const stop = fakeStop();
        await runCrashRecovery({ storage: b.page(), locks: b.locks, savedHandyKey: '', stopHandy: stop, onReport: () => {} });
        assert.deepEqual(stop.asked, ['KEY-ONE-1234']);
    });

    it('nor does one that hangs, for longer than the timeout', async () => {
        const b = await startBrowser({ mode: 'hang', timeoutMs: 40 });
        let told = 0;
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks, onDurable: () => { told += 1; } });
        const start = Date.now();
        tracker.note(HANDY);
        assert.equal(tracker.waitingForDisk().handy, true);
        await settle(b.storage.settled());
        assert.ok(Date.now() - start < 1000);
        assert.deepEqual(tracker.waitingForDisk(), NOTHING);
        assert.equal(told, 1);
        assert.deepEqual(Array.from(b.local.image().keys()), [liveSessionKey('page-a')], 'nothing written beside the marker');
    });

    it('hands a stop over and replaces the marker with its end in one transaction: a browser killed while that stop goes out loses neither', async () => {
        const first = await startBrowser();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks });
        tracker.note(HANDY);
        await first.storage.settled();
        const second = await first.kill();
        // The next start hands the stop over; the Handy is offline, so it is
        // still being sent when this browser is killed too.
        const held = heldStop();
        const pass = runCrashRecovery({ storage: second.storage, locks: second.locks, savedHandyKey: '', stopHandy: held, onReport: () => {} });
        await until(() => held.asked.length === 1);
        await second.storage.settled();
        const handover = second.durable.writes.find((w) => w.changes.some(([key]) => key === PENDING_CRASH_STOPS_KEY));
        assert.deepEqual(handover.changes.map(([key, value]) => [key, JSON.parse(value)]), [
            [PENDING_CRASH_STOPS_KEY, { handy: [{ key: 'KEY-ONE-1234', promised: '' }], version: 1 }],
            [liveSessionKey('page-a'), { ended: 1, at: JSON.parse(handover.changes[1][1]).at }]
        ], 'one transaction');
        const third = await second.kill();
        held.answer('KEY-ONE-1234', { outcome: 'offline', detail: 'Device not connected', final: true });
        await pass;
        const stop = fakeStop();
        const reports = [];
        await runCrashRecovery({ storage: third.storage, locks: third.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.deepEqual(stop.asked, ['KEY-ONE-1234']);
        assert.ok(reports.at(-1).startsWith(EARLIER_CRASH_HEADLINE));
    });

    it('a stop the Handy API confirmed before the kill is not owed again, though localStorage had not written that', async () => {
        const first = await startBrowser();
        createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks }).note(HANDY);
        await first.storage.settled();
        const second = await first.kill();
        const held = heldStop();
        const pass = runCrashRecovery({ storage: second.storage, locks: second.locks, savedHandyKey: '', stopHandy: held, onReport: () => {} });
        await until(() => held.asked.length === 1);
        // localStorage writes the stop still owed to disk, and then the Handy
        // API confirms it.
        second.commitLocalStorage();
        held.answer('KEY-ONE-1234', { outcome: 'stopped', detail: 'result 0', final: true });
        await pass;
        await second.storage.settled();
        assert.deepEqual(readPendingCrashStops(fakeStorage(second.localOnDisk)), ['KEY-ONE-1234'], 'localStorage has it owed on disk');
        const third = await second.kill();
        const stop = fakeStop();
        const reports = [];
        const result = await runCrashRecovery({ storage: third.storage, locks: third.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.equal(result.recovered, false);
        assert.deepEqual(stop.asked, []);
        assert.deepEqual(reports, []);
        assert.deepEqual(readPendingCrashStops(third.local), []);
    });

    it('a stop the Handy API confirmed whose durable copy failed is not owed again either: localStorage has the newer version', async () => {
        const first = await startBrowser();
        createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks }).note(HANDY);
        await first.storage.settled();
        const second = await first.kill();
        const held = heldStop();
        const pass = runCrashRecovery({ storage: second.storage, locks: second.locks, savedHandyKey: '', stopHandy: held, onReport: () => {} });
        await until(() => held.asked.length === 1);
        await second.storage.settled();
        // IndexedDB stops answering; the Handy API confirms the stop, and
        // localStorage writes that to disk.
        second.durable.mode = 'hang';
        held.answer('KEY-ONE-1234', { outcome: 'stopped', detail: 'result 0', final: true });
        await pass;
        second.commitLocalStorage();
        const third = await second.kill();
        assert.deepEqual(JSON.parse(third.durable.disk.get(PENDING_CRASH_STOPS_KEY)).handy.map((e) => e.key), ['KEY-ONE-1234'], 'the durable store still has it owed');
        const stop = fakeStop();
        const reports = [];
        await runCrashRecovery({ storage: third.storage, locks: third.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.deepEqual(stop.asked, [], 'no stop the Handy API had confirmed is reported as owed');
        assert.deepEqual(reports, []);
        assert.deepEqual(readPendingCrashStops(third.local), []);
    });

    it('a stop owed that only localStorage has - its durable copy failed - is still sent', async () => {
        const b = await startBrowser({ mode: 'fail' });
        addPendingCrashStops(['KEY-ONE-1234'], b.storage);
        await b.storage.settled();
        b.durable.mode = 'ok';
        const stop = fakeStop();
        await runCrashRecovery({ storage: b.page(), locks: b.locks, savedHandyKey: '', stopHandy: stop, onReport: () => {} });
        assert.deepEqual(stop.asked, ['KEY-ONE-1234']);
    });

    it('stops still owed: the newer version is believed from either store, and two copies of one version are merged', async () => {
        const owed = (keys, version) => JSON.stringify({ handy: keys.map((key) => ({ key, promised: '' })), version });
        const cases = [
            { name: 'localStorage behind', local: owed(['KEY-ONE-1234'], 1), durable: owed(['KEY-ONE-1234', 'KEY-TWO-5678'], 2), sent: ['KEY-ONE-1234', 'KEY-TWO-5678'] },
            { name: 'localStorage behind a settle', local: owed(['KEY-ONE-1234'], 1), durable: owed([], 2), sent: [] },
            { name: 'IndexedDB behind a settle', local: owed([], 2), durable: owed(['KEY-ONE-1234'], 1), sent: [] },
            { name: 'IndexedDB behind a hand-over', local: owed(['KEY-ONE-1234', 'KEY-TWO-5678'], 2), durable: owed(['KEY-ONE-1234'], 1), sent: ['KEY-ONE-1234', 'KEY-TWO-5678'] },
            { name: 'IndexedDB without the record', local: owed(['KEY-ONE-1234'], 1), durable: null, sent: ['KEY-ONE-1234'] },
            { name: 'localStorage without the record', local: null, durable: owed(['KEY-ONE-1234'], 1), sent: ['KEY-ONE-1234'] },
            { name: 'two pages wrote one version', local: owed(['KEY-ONE-1234'], 3), durable: owed(['KEY-TWO-5678'], 3), sent: ['KEY-ONE-1234', 'KEY-TWO-5678'] }
        ];
        for (const c of cases) {
            const b = await startBrowser({
                localOnDisk: new Map(c.local === null ? [] : [[PENDING_CRASH_STOPS_KEY, c.local]]),
                durableOnDisk: new Map(c.durable === null ? [] : [[PENDING_CRASH_STOPS_KEY, c.durable]]),
                read: false
            });
            const stop = fakeStop();
            const reports = [];
            await runCrashRecovery({ storage: b.storage, locks: b.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
            assert.deepEqual(stop.asked.slice().sort(), c.sent, c.name);
            assert.equal(reports.length > 0, c.sent.length > 0, `${c.name}: reported only what is owed`);
            await b.storage.settled();
            const local = JSON.parse(b.local.getItem(PENDING_CRASH_STOPS_KEY));
            const durable = JSON.parse(b.durable.disk.get(PENDING_CRASH_STOPS_KEY) || 'null');
            assert.ok(durable === null || durable.version <= local.version, `${c.name}: localStorage is up to date`);
            if (c.name === 'two pages wrote one version') {
                assert.equal(local.version, 6, 'merged under a newer version, then settled key by key');
                assert.deepEqual(durable, local, 'written to both');
            }
        }
    });

    it('a Handy that joined after localStorage last wrote the marker to disk is stopped too', async () => {
        const first = await startBrowser();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks });
        tracker.note(HANDY);
        await first.storage.settled();
        first.commitLocalStorage();
        // A second Handy connected mid-session: on disk in the durable store only.
        tracker.note({ handyKey: 'KEY-TWO-5678', intiface: true });
        await first.storage.settled();
        const next = await first.kill();
        assert.deepEqual(readLiveSession(next.local, 'page-a').handyKeys, ['KEY-ONE-1234'], 'localStorage wrote the older marker');
        const stop = fakeStop();
        const reports = [];
        await runCrashRecovery({ storage: next.storage, locks: next.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.deepEqual(stop.asked.sort(), ['KEY-ONE-1234', 'KEY-TWO-5678']);
        assert.ok(reports.at(-1).includes(INTIFACE_CRASH_ADVICE));
    });

    it('a toy that joined whose durable copy was never written is stopped too: the newer generation is believed', async () => {
        // A tab that had named a second Handy in localStorage died before
        // that reached the disk (its commands to it were held back).
        const b = await startBrowser({ mode: 'manual' });
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks });
        tracker.note(HANDY);
        await b.durable.commit();
        tracker.note({ handyKey: 'KEY-TWO-5678', tcode: true });
        b.locks.crash('page-a');
        b.durable.dead = true;
        const other = await startBrowser({ localOnDisk: b.local.image(), durableOnDisk: new Map(b.durable.disk) });
        const stop = fakeStop();
        const reports = [];
        await runCrashRecovery({ storage: other.storage, locks: other.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.deepEqual(stop.asked.sort(), ['KEY-ONE-1234', 'KEY-TWO-5678']);
        assert.ok(reports.at(-1).includes(TCODE_CRASH_ADVICE));
    });

    it('an older copy of the marker is not reported with the session: a Handy of an earlier, stopped session gets no stop', async () => {
        const first = await startBrowser();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks });
        tracker.note(HANDY);
        await first.storage.settled();
        first.commitLocalStorage();
        tracker.clear();
        tracker.note({ handyKey: 'KEY-TWO-5678' });
        await first.storage.settled();
        const next = await first.kill();
        assert.equal(readLiveSession(next.local, 'page-a').gen, 1, 'localStorage wrote session 1');
        const stop = fakeStop();
        await runCrashRecovery({ storage: next.storage, locks: next.locks, savedHandyKey: '', stopHandy: stop, onReport: () => {} });
        assert.deepEqual(stop.asked, ['KEY-TWO-5678'], 'session 2 drove only the second Handy');
    });

    it('a copy that names no generation, or cannot be read, is never taken for ended', () => {
        const key = liveSessionKey('page-a');
        const end = new Map([[key, endedRecord(9, 0)]]);
        const cases = [
            [JSON.stringify({ handy: ['KEY-ONE-1234'], intiface: false, tcode: false }), 1],
            ['{not json', 1],
            [JSON.stringify({ handy: ['KEY-ONE-1234'], intiface: false, tcode: false, gen: 9 }), 0],
            [JSON.stringify({ handy: ['KEY-ONE-1234'], intiface: false, tcode: false, gen: 10 }), 1]
        ];
        for (const [text, count] of cases) {
            const local = fakeStorage([[key, text]]);
            assert.equal(readLiveSessions(local, { records: end, seq: 0 }).length, count, text);
            assert.equal(staleLiveSessions(local, { records: end, seq: 0 }).length, 1 - count, text);
        }
        // An end that names no generation is no end.
        const local = fakeStorage([[key, cases[2][0]]]);
        assert.equal(readLiveSessions(local, { records: new Map([[key, '{"ended":"x"}']]), seq: 0 }).length, 1);
    });

    it('a page keeps its lock until the end of its marker is on disk', async () => {
        const b = await startBrowser({ mode: 'manual' });
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks });
        tracker.note(HANDY);
        await b.durable.commit();
        // Another tab's copy of localStorage, a moment behind this one's.
        const behind = fakeStorage(b.local.image());
        tracker.clear();
        await tick(5);
        assert.equal(b.locks.holds('page-a'), true, 'the durable store still has the marker');
        // That tab's pass meanwhile finds the marker in both stores, and
        // leaves it to a page that is still open.
        const stop = fakeStop();
        const reports = [];
        const result = await runCrashRecovery({ storage: createCrashRecoveryStorage({ local: behind, durable: b.durable }), locks: b.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.equal(result.alive, 1, 'it found the marker, and its page open');
        // A tab whose copy is up to date finds the end in localStorage.
        const current = await runCrashRecovery({ storage: b.page(), locks: b.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.equal(current.recovered, false);
        assert.deepEqual(stop.asked, []);
        assert.deepEqual(reports, []);
        await b.durable.commit();
        await tick(5);
        assert.equal(b.locks.holds('page-a'), false, 'let go once the end is on disk');
        // A session started again before the end landed keeps the lock.
        tracker.note(HANDY);
        await b.durable.commit();
        tracker.clear();
        tracker.note(HANDY);
        await b.durable.commit();
        await b.durable.commit();
        await tick(5);
        assert.equal(b.locks.holds('page-a'), true);
    });

    it('a page still open whose marker only the durable store has (localStorage full) is left alone, and recovered once it dies', async () => {
        const b = await startBrowser();
        b.local.refuse = true;
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks });
        assert.equal(tracker.note(HANDY), false, 'localStorage refused it');
        await b.storage.settled();
        await tick();
        assert.equal(onDisk(b).gen, 1);
        const first = fakeStop();
        await runCrashRecovery({ storage: b.page(), locks: b.locks, savedHandyKey: '', stopHandy: first, onReport: () => {} });
        assert.deepEqual(first.asked, []);
        b.locks.crash('page-a');
        const second = fakeStop();
        await runCrashRecovery({ storage: b.page(), locks: b.locks, savedHandyKey: '', stopHandy: second, onReport: () => {} });
        assert.deepEqual(second.asked, ['KEY-ONE-1234']);
    });

    it('STOP or Reset in a page with no session writes nothing to disk, and an end that failed is written again', async () => {
        const b = await startBrowser();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks });
        assert.equal(tracker.clear(), true);
        await b.storage.settled();
        assert.equal(b.durable.writes.length, 0);
        tracker.note(HANDY);
        await b.storage.settled();
        b.durable.mode = 'fail';
        tracker.clear();
        await b.storage.settled();
        assert.equal(onDisk(b).gen, 1, 'the end failed: the marker is still on disk');
        b.durable.mode = 'ok';
        tracker.clear();
        await b.storage.settled();
        assert.equal(onDisk(b).ended, 1, 'and was written again');
        const writes = b.durable.writes.length;
        tracker.clear();
        await b.storage.settled();
        assert.equal(b.durable.writes.length, writes, 'once it is on disk, nothing more');
    });

    it('the ends of sessions are kept while a copy of their marker may come back, and swept after that', async () => {
        const DAY = 24 * 60 * 60 * 1000;
        let clock = 10 * DAY;
        const now = () => clock;
        const b = await startBrowser();
        const stopped = (owner) => {
            const tracker = createLiveSessionTracker({ owner, storage: b.storage, locks: b.locks, now });
            tracker.note(HANDY);
            tracker.clear();
            return tracker;
        };
        const boot = (owner) => createCrashRecovery({ owner, storage: b.page(), locks: b.locks, stopHandy: fakeStop(), onReport: () => {}, bootRecheckMs: null, now }).atBoot();
        const [A, B, C] = ['page-a', 'page-b', 'page-c'].map(liveSessionKey);
        // page-a and page-b stopped long ago; page-b's end never reached
        // localStorage's disk before a kill, so its marker is back there.
        stopped('page-a');
        const staleCopy = JSON.stringify({ handy: ['KEY-ONE-1234'], intiface: false, tcode: false, gen: 1 });
        stopped('page-b');
        await b.storage.settled();
        assert.equal(b.local.getItem(A), endedRecord(1, clock), 'the end is kept in localStorage too');
        b.local.setItem(B, staleCopy);
        clock += ENDED_RECORD_KEEP_MS - DAY;
        // page-c stopped a day ago.
        stopped('page-c');
        await b.storage.settled();
        clock += DAY;
        const pass = await boot('page-z');
        await b.storage.settled();
        assert.equal(pass.recovered, false);
        assert.equal(b.durable.disk.has(A), false, 'swept from the durable store: both its ends kept their week');
        assert.equal(b.local.getItem(A), null, 'and from localStorage');
        assert.equal(b.local.getItem(B), endedRecord(1, clock), 'the stale copy is replaced by an end stamped now');
        assert.equal(b.durable.disk.get(B), endedRecord(1, clock - ENDED_RECORD_KEEP_MS), 'and the durable end is kept with it');
        assert.equal(onDisk(b, 'page-c').ended, 1, 'too recent');
        assert.equal(b.local.getItem(C), endedRecord(1, clock - DAY));
        // A week after the stale copy went, and not before: until then
        // localStorage's disk may still have it.
        clock += ENDED_RECORD_KEEP_MS - DAY;
        await boot('page-x');
        assert.ok(b.durable.disk.has(B) && b.local.getItem(B) !== null, 'kept');
        clock += DAY;
        await boot('page-w');
        await b.storage.settled();
        assert.equal(b.durable.disk.has(B), false);
        assert.equal(b.local.getItem(B), null);
        assert.equal(b.durable.disk.has(C), false, 'page-c\'s week is over too');
        // A clock set back leaves every end in place.
        stopped('page-d');
        await b.storage.settled();
        clock = 0;
        await boot('page-y');
        assert.equal(onDisk(b, 'page-d').ended, 1);
        assert.deepEqual(expiredEndedRecords(b.local, { records: new Map(b.durable.disk), seq: 0 }, clock), []);
        // A session a swept page starts meanwhile is never swept with it:
        // only the ends that were read go. Its marker reaches localStorage
        // after the sweep read it, and the durable store after the sweep's
        // own transaction.
        const pageE = stopped('page-e');
        await b.storage.settled();
        b.durable.mode = 'manual';
        const sweeping = runCrashRecovery({ storage: b.page(), locks: b.locks, sweep: true, now: () => 100 * ENDED_RECORD_KEEP_MS, stopHandy: fakeStop(), onReport: () => {} });
        await until(() => b.durable.waiting.length > 0);
        pageE.note(HANDY);
        await b.durable.commit();
        await b.durable.commit();
        await sweeping;
        assert.equal(readLiveSession(b.local, 'page-e').gen, 2, 'localStorage keeps the marker written after the read');
        assert.equal(onDisk(b, 'page-e').gen, 2, 'and so does the durable store');
        // Nor is anything but an end ever swept.
        const junk = new Map([[liveSessionKey('page-f'), '{not json']]);
        assert.deepEqual(expiredEndedRecords(fakeStorage(junk), { records: new Map(), seq: 0 }, 100 * ENDED_RECORD_KEEP_MS), []);
        assert.deepEqual(expiredEndedRecords(fakeStorage([[liveSessionKey('page-f'), endedRecord(1, 0)]]), null, 100 * ENDED_RECORD_KEEP_MS), [], 'nor without a durable snapshot');
    });

    it('the pass a late read brings sends a stop still owed only when the boot pass is not sending it already', async () => {
        const owed = JSON.stringify({ handy: [{ key: 'KEY-OLD-0001', promised: '' }], version: 1 });
        const next = await startBrowser({
            localOnDisk: new Map([[PENDING_CRASH_STOPS_KEY, owed]]),
            durableOnDisk: new Map([
                [PENDING_CRASH_STOPS_KEY, owed],
                [liveSessionKey('page-a'), JSON.stringify({ handy: ['KEY-NEW-0002'], intiface: false, tcode: false, gen: 1 })]
            ]),
            read: false
        });
        next.durable.readDelayMs = 60;
        const held = heldStop();
        const reports = [];
        const recovery = createCrashRecovery({
            owner: 'page-b',
            storage: next.storage,
            locks: next.locks,
            savedHandyKey: () => '',
            stopHandy: held,
            onReport: (text) => reports.push(text),
            readTimeoutMs: 10,
            bootRecheckMs: null
        });
        const boot = recovery.atBoot();
        assert.equal(await settle(until(() => held.asked.length === 2, 3000)), true);
        await settle(tick(30));
        assert.deepEqual(held.asked.slice().sort(), ['KEY-NEW-0002', 'KEY-OLD-0001'], 'each once');
        const last = reports.at(-1);
        assert.equal(last.split('key ending 0001').length - 1, 1, 'and reported once');
        assert.ok(last.includes(CRASH_HEADLINE), 'the session only the durable store knew of');
        held.answer('KEY-OLD-0001', { outcome: 'stopped', detail: 'result 0', final: true });
        held.answer('KEY-NEW-0002', { outcome: 'stopped', detail: 'result 0', final: true });
        await settle(boot);
    });

    it('a stop owed that only the durable store kept survives a Connect made before the page has read it', async () => {
        // The last browser was killed after a stop had been handed over, and
        // before localStorage wrote it: only the durable store has it.
        const owed = JSON.stringify({ handy: [{ key: 'KEY-OWED-0001', promised: '' }, { key: 'KEY-CONN-0002', promised: '' }], version: 4 });
        const next = await startBrowser({ durableOnDisk: new Map([[PENDING_CRASH_STOPS_KEY, owed]]), read: false });
        const page = next.storage;
        // The wearer connects a Handy before this page's first read answers:
        // its stop is settled, from localStorage's copy, which has no stops.
        clearPendingCrashStop('KEY-CONN-0002', page);
        addPendingCrashStops(['KEY-CONN-0002'], page);
        clearPendingCrashStop('KEY-CONN-0002', page);
        await page.settled();
        assert.equal(next.durable.disk.get(PENDING_CRASH_STOPS_KEY), owed, 'nothing sent before the read');
        const stop = fakeStop();
        await runCrashRecovery({ storage: page, locks: next.locks, savedHandyKey: '', stopHandy: stop, onReport: () => {} });
        // The stop only the disk had is sent; the one Connect settled
        // meanwhile comes back with it, and is only sent a stop again.
        assert.deepEqual(stop.asked.slice().sort(), ['KEY-CONN-0002', 'KEY-OWED-0001']);
    });

    it('which, written before the read, it would not have', async () => {
        const owed = JSON.stringify({ handy: [{ key: 'KEY-OWED-0001', promised: '' }], version: 1 });
        const next = await startBrowser({ durableOnDisk: new Map([[PENDING_CRASH_STOPS_KEY, owed]]), read: false });
        // A mirror that writes before it has read.
        const page = createDurableMirror({ local: next.local, durable: next.durable });
        addPendingCrashStops(['KEY-CONN-0002'], page);
        clearPendingCrashStop('KEY-CONN-0002', page);
        await page.settled();
        const stop = fakeStop();
        await runCrashRecovery({ storage: page, locks: next.locks, savedHandyKey: '', stopHandy: stop, onReport: () => {} });
        assert.deepEqual(stop.asked, [], 'the stop owed to a Handy that may be moving is gone');
    });

    it('a first read that times out holds this page\'s changes, and the late answer merges them with what only the durable store knew', async () => {
        const first = await startBrowser();
        // A dead page whose marker both stores have, and a stop owed that
        // only the durable store kept.
        createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks }).note(HANDY);
        await first.storage.settled();
        first.commitLocalStorage();
        first.durable.disk.set(PENDING_CRASH_STOPS_KEY, JSON.stringify({ handy: [{ key: 'KEY-OWED-0001', promised: '' }], version: 3 }));
        const second = await first.kill({ read: false });
        second.durable.readDelayMs = 80;
        const page = second.storage;
        const writesBefore = second.durable.writes.length;
        const stop = heldStop();
        const pass = runCrashRecovery({ storage: page, locks: second.locks, savedHandyKey: '', stopHandy: stop, onReport: () => {}, readTimeoutMs: 10 });
        assert.equal(await settle(until(() => stop.asked.length === 1, 3000)), true, 'localStorage alone still recovers the dead page');
        assert.deepEqual(stop.asked, ['KEY-ONE-1234']);
        assert.equal(second.durable.writes.length, writesBefore, 'nothing written to a store this page has not read');
        // The late answer: what this page wrote meanwhile goes out, merged
        // with the stop only the durable store kept.
        assert.equal(await settle(until(() => second.durable.writes.length > writesBefore, 3000)), true);
        await settle(page.settled());
        const merged = JSON.parse(second.durable.disk.get(PENDING_CRASH_STOPS_KEY));
        assert.deepEqual(merged.handy.map((entry) => entry.key).sort(), ['KEY-ONE-1234', 'KEY-OWED-0001']);
        assert.equal(onDisk(second).ended, 1, 'and the dead page\'s end with it');
        stop.answer('KEY-ONE-1234', { outcome: 'offline', detail: 'Device not connected', final: true });
        await settle(pass);
        const third = await second.kill();
        const next = fakeStop();
        await runCrashRecovery({ storage: third.storage, locks: third.locks, savedHandyKey: '', stopHandy: next, onReport: () => {} });
        assert.deepEqual(next.asked.slice().sort(), ['KEY-ONE-1234', 'KEY-OWED-0001'], 'both still owed at the next start');
    });

    it('an IndexedDB that cannot be read leaves localStorage to go by, and one that answers late gets a pass of its own', async () => {
        const first = await startBrowser();
        createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks }).note(HANDY);
        await first.storage.settled();
        const next = await first.kill();
        next.durable.readDelayMs = 80;
        const stop = fakeStop();
        const recovery = createCrashRecovery({
            owner: 'page-b',
            storage: next.page(),
            locks: next.locks,
            savedHandyKey: () => '',
            stopHandy: stop,
            onReport: () => {},
            readTimeoutMs: 10,
            bootRecheckMs: null
        });
        const boot = await settle(recovery.atBoot());
        assert.equal(boot.recovered, false, 'localStorage alone has nothing');
        assert.equal(await settle(until(() => stop.asked.length === 1, 3000)), true, 'the late read found it');
        assert.deepEqual(stop.asked, ['KEY-ONE-1234']);
        next.durable.readMode = 'fail';
        assert.deepEqual(staleLiveSessions(next.local, null), [], 'no snapshot, nothing is stale');
    });
});

// A page that goes - reloaded, or its tab closed - while the browser stays.
// localStorage keeps every change the page made, since the browser process
// holds it; a transaction the page made that had not started, queued behind
// another page's, is rolled back with it (dropQueued).
describe('a page that goes before its last transaction ran', () => {
    // Another page holds a transaction on the store, so everything this
    // page sends from now on waits behind it.
    async function busy(b) {
        b.durable.mode = 'manual';
        b.durable.write([['another page', 'reading']]);
        await until(() => b.durable.waiting.length > 0);
    }
    // The other page's transaction is over, and the store runs what is left.
    async function free(b) {
        b.durable.mode = 'ok';
        await b.durable.commit();
    }

    it('a clean STOP, then a reload or a closed tab: nothing is sent or reported, and the durable store is given the end', async () => {
        const b = await startBrowser();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks, now: () => 1000 });
        tracker.note({ ...HANDY, driving: true });
        await b.storage.settled();
        // localStorage wrote the marker to its disk mid-session.
        b.commitLocalStorage();
        await busy(b);
        tracker.clear();
        b.durable.dropQueued();
        b.locks.crash('page-a');
        await free(b);
        assert.deepEqual(onDisk(b), { handy: ['KEY-ONE-1234'], intiface: false, tcode: false, gen: 1 }, 'the end never reached the disk');
        assert.equal(b.local.getItem(liveSessionKey('page-a')), endedRecord(1, 1000), 'localStorage has it');
        const stop = fakeStop();
        const reports = [];
        const next = b.page();
        const result = await runCrashRecovery({ storage: next, locks: b.locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.equal(result.recovered, false);
        assert.deepEqual(stop.asked, []);
        assert.deepEqual(reports, []);
        await next.settled();
        assert.deepEqual(onDisk(b), { ended: 1, at: 1000 }, 'the end localStorage has is written to the durable store');
        // So a browser killed now, before localStorage has written that end
        // to its disk, leaves the next open nothing to report either.
        const later = await b.kill();
        assert.equal(readLiveSession(later.local, 'page-a').gen, 1, 'localStorage\'s disk still has the marker');
        const again = fakeStop();
        const laterReports = [];
        await runCrashRecovery({ storage: later.storage, locks: later.locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: again, onReport: (text) => laterReports.push(text) });
        assert.deepEqual(again.asked, []);
        assert.deepEqual(laterReports, []);
    });

    it('which, with STOP written to localStorage as a removal, was reported as a crash', async () => {
        const b = await startBrowser();
        const page = b.page();
        await page.read();
        // localStorage as it was kept before: the marker removed at STOP.
        const retire = page.retire;
        page.retire = (key, value) => {
            retire(key, value);
            page.replaceLocal(key, null);
        };
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: page, locks: b.locks });
        tracker.note({ ...HANDY, driving: true });
        await page.settled();
        await busy(b);
        tracker.clear();
        b.durable.dropQueued();
        b.locks.crash('page-a');
        await free(b);
        const reports = [];
        await runCrashRecovery({ storage: b.page(), locks: b.locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: fakeStop(), onReport: (text) => reports.push(text) });
        assert.ok(reports.at(-1).startsWith(CRASH_HEADLINE), 'a crash that had not happened');
    });

    it('while the page is still open, its own transaction lands and nothing is written for it', async () => {
        const b = await startBrowser();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks, now: () => 1000 });
        tracker.note({ ...HANDY, driving: true });
        await b.storage.settled();
        await busy(b);
        tracker.clear();
        const stop = fakeStop();
        const reports = [];
        const next = b.page();
        const result = await runCrashRecovery({ storage: next, locks: b.locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.equal(result.recovered, false);
        await free(b);
        await b.storage.settled();
        await next.settled();
        assert.deepEqual(stop.asked, []);
        assert.deepEqual(reports, []);
        assert.deepEqual(next.state(liveSessionKey('page-a')), null, 'the other page wrote nothing under page-a\'s key');
        assert.equal(b.durable.swaps.length, 0, 'nor asked the durable store to');
        assert.deepEqual(onDisk(b), { ended: 1, at: 1000 });
    });

    it('a marker that cannot be read is replaced by an end no older than any its page has had', async () => {
        const key = liveSessionKey('page-a');
        const b = await startBrowser({ localOnDisk: new Map([[key, '{not json']]), durableOnDisk: new Map([[key, endedRecord(5, 0)]]) });
        const stop = fakeStop();
        const reports = [];
        await runCrashRecovery({ storage: b.storage, locks: b.locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: stop, onReport: (text) => reports.push(text), now: () => 70 });
        assert.deepEqual(stop.asked, ['KEY-ONE-1234'], 'what that session drove cannot be read: the saved key is stopped');
        assert.ok(reports.at(-1).includes(UNKNOWN_HARDWARE_NOTE));
        await b.storage.settled();
        assert.equal(b.local.getItem(key), endedRecord(5, 70));
        assert.equal(b.durable.disk.get(key), endedRecord(5, 70), 'an end at generation 0 would let a copy of generation 1 to 5 back as a crash');
    });

    it('whatever the session drove, and whether it was paused when it ended', async () => {
        for (const hardware of [HANDY, { ...HANDY, driving: true }, { handyKey: '', intiface: true, tcode: true }]) {
            const b = await startBrowser();
            const tracker = createLiveSessionTracker({ owner: 'page-a', storage: b.storage, locks: b.locks });
            tracker.note(hardware);
            tracker.note({ ...hardware, driving: false });
            await b.storage.settled();
            await busy(b);
            tracker.clear();
            b.durable.dropQueued();
            b.locks.crash('page-a');
            await free(b);
            const reports = [];
            const stop = fakeStop();
            await runCrashRecovery({ storage: b.page(), locks: b.locks, savedHandyKey: 'KEY-ONE-1234', stopHandy: stop, onReport: (text) => reports.push(text) });
            assert.deepEqual(stop.asked, [], JSON.stringify(hardware));
            assert.deepEqual(reports, [], JSON.stringify(hardware));
        }
    });

    it('a marker the durable store has over the end of an earlier session in localStorage is still a crash', async () => {
        // Session 1 stopped; session 2 started, and the browser was killed
        // before localStorage wrote its marker to disk.
        const first = await startBrowser();
        const tracker = createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks });
        tracker.note(HANDY);
        await first.storage.settled();
        tracker.clear();
        await first.storage.settled();
        first.commitLocalStorage();
        tracker.note({ handyKey: 'KEY-TWO-5678' });
        await first.storage.settled();
        const next = await first.kill();
        assert.deepEqual(JSON.parse(next.local.getItem(liveSessionKey('page-a'))).ended, 1, 'localStorage has session 1\'s end on disk');
        assert.equal(onDisk(next).gen, 2, 'the durable store has session 2');
        const stop = fakeStop();
        const reports = [];
        await runCrashRecovery({ storage: next.storage, locks: next.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.deepEqual(stop.asked, ['KEY-TWO-5678']);
        assert.ok(reports.at(-1).startsWith(CRASH_HEADLINE));
        await next.storage.settled();
        assert.deepEqual(JSON.parse(next.local.getItem(liveSessionKey('page-a'))).ended, 2, 'handed over: its end is in both stores');
        assert.equal(onDisk(next).ended, 2);
    });

    it('a page that hands a dead page\'s session over and goes before that is written: the next page reports no new crash, and sends the stop still owed', async () => {
        const first = await startBrowser();
        createLiveSessionTracker({ owner: 'page-a', storage: first.storage, locks: first.locks }).note(HANDY);
        await first.storage.settled();
        const b = await first.kill();
        await busy(b);
        const held = heldStop();
        const handing = runCrashRecovery({ storage: b.storage, locks: b.locks, savedHandyKey: '', stopHandy: held, onReport: () => {} });
        await until(() => held.asked.length === 1);
        // Page B goes while its stop is still out, before the store ran
        // its hand-over.
        b.durable.dropQueued();
        await free(b);
        assert.equal(onDisk(b).gen, 1, 'the hand-over never reached the disk');
        const stop = fakeStop();
        const reports = [];
        await runCrashRecovery({ storage: b.page(), locks: b.locks, savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
        assert.deepEqual(stop.asked, ['KEY-ONE-1234'], 'the stop still owed is sent');
        assert.ok(reports.at(-1).startsWith(EARLIER_CRASH_HEADLINE), 'as a stop an earlier session still owes');
        assert.ok(!reports.at(-1).includes(CRASH_HEADLINE), 'not as a crash of its own');
        held.answer('KEY-ONE-1234', { outcome: 'stopped', detail: 'result 0', final: true });
        await settle(handing);
    });
});

// Every disk a killed browser can leave behind, and what the next start does
// with each. localStorage reaches the disk as it stood at its last commit
// before the kill, and a commit can land after any change - any origin's
// timer fires one for every origin - so every state localStorage passed
// through can be what the next start finds. IndexedDB has on disk every
// transaction reported committed, and perhaps some of those still on their
// way, in order: never one that hung or failed, nor any made after a hung
// one. For every moment of a session at which the browser could be killed,
// and every pair of disks it could leave, the next start must
//   * stop every Handy a command reached in the session that was running,
//     whenever either disk holds a marker of that session naming it - and
//     with an IndexedDB that answers, the durable disk always does;
//   * report nothing and send nothing when that session had ended cleanly
//     and the durable disk holds its end.
// The markers of one page's sessions are named by generation, so "a marker
// of that session naming it" is one of the generation at which the Handy
// joined, or a later one.
function recordingStorage(initial = []) {
    const map = new Map(initial);
    const store = {
        history: [new Map(map)],
        get length() { return map.size; },
        key: (i) => Array.from(map.keys())[i] ?? null,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => {
            map.set(k, String(v));
            store.history.push(new Map(map));
        },
        removeItem: (k) => {
            if (map.delete(k)) store.history.push(new Map(map));
        }
    };
    return store;
}

// A durable store that logs every transaction and what became of it:
// 'queued' until it commits, 'committed', 'failed' or 'hung'. image() is
// what its disk holds with the transactions whose statuses are given
// committed, plus the next `extra` of those still queued.
function loggingDurable(initial = []) {
    const d = { log: [], mode: 'ok', initial: new Map(initial) };
    let chain = Promise.resolve();
    const apply = (entry, disk) => {
        if (entry.kind === 'write') {
            for (const [key, value] of entry.changes) {
                if (value === null) disk.delete(key);
                else disk.set(key, value);
            }
            return true;
        }
        return entry.entries.map(([key, expected, next]) => {
            if (disk.get(key) !== expected) return false;
            if (next === null) disk.delete(key);
            else disk.set(key, next);
            return true;
        });
    };
    d.image = (statuses = d.log.map((entry) => entry.status), extra = 0) => {
        const disk = new Map(d.initial);
        let left = extra;
        for (let i = 0; i < statuses.length; i++) {
            if (statuses[i] === 'committed') apply(d.log[i], disk);
            else if (statuses[i] === 'queued' && left > 0) {
                apply(d.log[i], disk);
                left -= 1;
            } else if (statuses[i] !== 'failed') break;
        }
        return disk;
    };
    const enqueue = (entry, failed) => {
        entry.status = 'queued';
        d.log.push(entry);
        const run = chain.then(() => new Promise((resolve) => {
            if (d.mode === 'fail') {
                entry.status = 'failed';
                resolve(failed());
            } else if (d.mode === 'hang') {
                entry.status = 'hung';
            } else {
                setTimeout(() => {
                    const result = apply(entry, d.image(d.log.map((e) => e.status)));
                    entry.status = 'committed';
                    resolve(result);
                }, 0);
            }
        }));
        chain = run;
        return run;
    };
    d.write = (changes) => enqueue({ kind: 'write', changes: changes.map(([key, value]) => [key, value]) }, () => false);
    d.swap = (entries) => enqueue({ kind: 'swap', entries: entries.map((entry) => entry.slice()) }, () => entries.map(() => false));
    d.readAll = () => tick(0).then(() => d.image());
    return d;
}

// How many transactions still queued could also be on disk at a kill.
function queuedAfterCommitted(statuses) {
    let n = 0;
    let past = false;
    for (const status of statuses) {
        if (status === 'committed' && !past) continue;
        if (status === 'failed') continue;
        if (status !== 'queued') break;
        past = true;
        n += 1;
    }
    return n;
}

// Starts a browser on a pair of disks and runs the boot pass. Cached: many
// kill points leave the same disks.
function nextStartOn() {
    const seen = new Map();
    return async (localImage, durableImage) => {
        const id = JSON.stringify([Array.from(localImage), Array.from(durableImage)]);
        if (seen.has(id)) return seen.get(id);
        const storage = createCrashRecoveryStorage({ local: fakeStorage(localImage), durable: fakeDurable({ disk: new Map(durableImage) }) });
        const stop = fakeStop();
        const reports = [];
        await runCrashRecovery({ storage, locks: fakeLocks(), savedHandyKey: '', stopHandy: stop, onReport: (text) => reports.push(text) });
        const result = { asked: stop.asked.slice(), reports };
        seen.set(id, result);
        return result;
    };
}

// A marker of generation `gen` or later naming `handy`, in `image`.
function namesOnDisk(image, key, handy, gen) {
    const text = image.get(key);
    if (typeof text !== 'string') return false;
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.handy) && parsed.handy.includes(handy) && Number.isInteger(parsed.gen) && parsed.gen >= gen;
}

// One page running sessions the way app.js does: every dispatch notes what
// is connected, then sends the Handy a command unless it is held back.
async function killedAnywhere(name, script, { timeoutMs = 15 } = {}) {
    const KEY = liveSessionKey('page-a');
    const local = recordingStorage();
    const durable = loggingDurable();
    const storage = createCrashRecoveryStorage({ local, durable, timeoutMs });
    await storage.read();
    const tracker = createLiveSessionTracker({ owner: 'page-a', storage, locks: fakeLocks() });
    const points = new Map();
    // The Handy connected now: a session that switches keys keeps every
    // Handy it drove in its marker, and has sent the earlier ones theirs.
    let current = '';
    let joined = new Map();
    let reached = new Map();
    let ended = null;
    // Set once a command went out without its marker on disk: IndexedDB did
    // not commit within the timeout. Until then IndexedDB answers.
    let degraded = false;
    const mark = () => {
        const point = { ls: local.history.length, statuses: durable.log.map((e) => e.status), reached: Array.from(reached), ended, degraded };
        points.set(JSON.stringify(point), point);
    };
    const dispatch = () => {
        if (!current) return;
        tracker.note({ handyKey: current, driving: true });
        if (!joined.has(current)) joined.set(current, readLiveSession(local, 'page-a').gen);
        if (!tracker.waitingForDisk().handy && !reached.has(current)) {
            reached.set(current, joined.get(current));
            if (!namesOnDisk(durable.image(), KEY, current, joined.get(current))) degraded = true;
        }
        mark();
    };
    // At least `ms` of engine ticks, and at least `ticks` of them however
    // slow the machine is.
    const run = async (ms, ticks = 5) => {
        const end = Date.now() + ms;
        let n = 0;
        do {
            dispatch();
            await tick(2);
            mark();
            n += 1;
        } while (Date.now() < end || n < ticks);
    };
    // Engine ticks until the Handy connected now has had its first command.
    const reach = async () => {
        for (let i = 0; i < 500 && current && !reached.has(current); i++) {
            dispatch();
            await tick(2);
            mark();
        }
        assert.ok(reached.has(current), `${name}: ${current} never had a command`);
    };
    await script({
        durable,
        run,
        reach,
        start: async (handyKey) => {
            ended = null;
            joined = new Map();
            reached = new Map();
            current = handyKey;
            dispatch();
            await tick(0);
            mark();
        },
        join: async (handyKey) => {
            current = handyKey;
            dispatch();
            await tick(0);
            mark();
        },
        stop: async () => {
            const gen = readLiveSession(local, 'page-a').gen;
            tracker.clear();
            current = '';
            reached = new Map();
            ended = gen;
            mark();
            await tick(0);
            mark();
        }
    });
    await settle(tick(30));
    mark();
    const nextStart = nextStartOn();
    let checked = 0;
    // The pages checked gone after a clean STOP.
    let gone = 0;
    // The Handys checked on a disk IndexedDB wrote in time.
    const healthyChecked = new Set();
    for (const point of points.values()) {
        const healthy = !point.degraded && point.statuses.every((status) => status === 'committed' || status === 'queued');
        const extras = queuedAfterCommitted(point.statuses);
        for (let i = 0; i < point.ls; i++) {
            const localImage = local.history[i];
            for (let extra = 0; extra <= extras; extra++) {
                const durableImage = durable.image(point.statuses, extra);
                const result = await nextStart(localImage, durableImage);
                const where = `${name}: kill with localStorage at write ${i} and IndexedDB at ${JSON.stringify(Array.from(durableImage))}`;
                for (const [handy, gen] of point.reached) {
                    if (healthy) assert.ok(namesOnDisk(durableImage, KEY, handy, gen), `${where}: a command reached ${handy} before IndexedDB named it`);
                    if (namesOnDisk(localImage, KEY, handy, gen) || namesOnDisk(durableImage, KEY, handy, gen)) {
                        assert.ok(result.asked.includes(handy), `${where}: ${handy} is left moving`);
                        assert.ok(result.reports.at(-1).startsWith(CRASH_HEADLINE), `${where}: not reported`);
                    }
                }
                if (point.ended !== null && [localImage, durableImage].some((image) => endsOnDisk(image, KEY, point.ended))) {
                    assert.deepEqual(result.asked, [], `${where}: a stop after a clean STOP`);
                    assert.deepEqual(result.reports, [], `${where}: a crash reported after a clean STOP`);
                }
                checked += 1;
                if (healthy) for (const [handy] of point.reached) healthyChecked.add(handy);
            }
        }
        // The page goes - reloaded, or its tab closed - and the browser
        // stays: localStorage is as the page left it, and the durable store
        // has what committed, since Chromium rolls back every transaction of
        // a page that goes before it has committed. A session that was live
        // is a crash, whatever the durable store had written; one that had
        // ended cleanly is none, whatever it had not.
        const localImage = local.history[point.ls - 1];
        const durableImage = durable.image(point.statuses, 0);
        const result = await nextStart(localImage, durableImage);
        const where = `${name}: page gone with localStorage at write ${point.ls - 1} and IndexedDB at ${JSON.stringify(Array.from(durableImage))}`;
        if (point.ended === null) {
            for (const [handy] of point.reached) {
                assert.ok(result.asked.includes(handy), `${where}: ${handy} is left moving`);
                assert.ok(result.reports.at(-1).startsWith(CRASH_HEADLINE), `${where}: not reported`);
            }
        } else {
            assert.deepEqual(result.asked, [], `${where}: a stop after a clean STOP`);
            assert.deepEqual(result.reports, [], `${where}: a crash reported after a clean STOP`);
            gone += 1;
        }
    }
    return { checked, healthy: healthyChecked, gone };
}

// Whether `image` holds the end of the page's session at generation `gen` or
// a newer one.
function endsOnDisk(image, key, gen) {
    const text = image.get(key);
    if (typeof text !== 'string') return false;
    const parsed = JSON.parse(text);
    return Number.isInteger(parsed.ended) && parsed.ended >= gen;
}

describe('a browser killed at any moment of a session', () => {
    it('with an IndexedDB that answers: two sessions, a Handy that joins, both stopped', async () => {
        const { checked, healthy, gone } = await killedAnywhere('working', async (page) => {
            await page.start('KEY-ONE-1234');
            await page.reach();
            await page.run(12);
            await page.join('KEY-TWO-5678');
            await page.reach();
            await page.run(12);
            await page.stop();
            await page.run(6);
            await page.start('KEY-THR-9999');
            await page.reach();
            await page.run(12);
            await page.stop();
        }, { timeoutMs: 5000 });
        assert.ok(checked > 20, `${checked} disks checked`);
        assert.deepEqual(Array.from(healthy).sort(), ['KEY-ONE-1234', 'KEY-THR-9999', 'KEY-TWO-5678'], 'every Handy checked against IndexedDB written in time');
        assert.ok(gone > 0, 'and pages gone after a clean STOP');
    });

    it('with an IndexedDB that does not answer from START, or fails', async () => {
        for (const mode of ['hang', 'fail']) {
            await killedAnywhere(mode, async (page) => {
                page.durable.mode = mode;
                await page.start('KEY-ONE-1234');
                await page.reach();
                await page.run(10);
                await page.stop();
            });
        }
    });

    it('with an IndexedDB that stops answering when a Handy joins, or at STOP', async () => {
        await killedAnywhere('hang at a join', async (page) => {
            await page.start('KEY-ONE-1234');
            await page.reach();
            await page.run(12);
            page.durable.mode = 'hang';
            await page.join('KEY-TWO-5678');
            await page.reach();
            await page.run(10);
            await page.stop();
        });
        // The end of the session never reaches the durable store: a page
        // that goes now takes that transaction with it.
        const { gone } = await killedAnywhere('hang at STOP', async (page) => {
            await page.start('KEY-ONE-1234');
            await page.reach();
            await page.run(12);
            page.durable.mode = 'hang';
            await page.stop();
            await page.run(10);
        });
        assert.ok(gone > 0);
    });

    it('with a second session whose durable copy is never written, after one stopped cleanly', async () => {
        await killedAnywhere('second session', async (page) => {
            await page.start('KEY-ONE-1234');
            await page.reach();
            await page.run(12);
            await page.stop();
            await page.run(6);
            page.durable.mode = 'hang';
            await page.start('KEY-TWO-5678');
            await page.reach();
            await page.run(10);
            await page.stop();
        });
    });

    it('while a page hands a dead page\'s session over and its stop goes out, until the Handy API confirms it', async () => {
        for (const mode of ['ok', 'hang']) {
            const P = liveSessionKey('page-p');
            const marker = JSON.stringify({ handy: ['KEY-DEAD-0001'], intiface: false, tcode: false, gen: 1 });
            const local = recordingStorage([[P, marker]]);
            const durable = loggingDurable([[P, marker]]);
            const storage = createCrashRecoveryStorage({ local, durable, timeoutMs: 15 });
            const snapshot = await storage.read();
            durable.mode = mode;
            const points = [];
            let confirmed = false;
            const mark = () => points.push({ ls: local.history.length, statuses: durable.log.map((e) => e.status), confirmed });
            const held = heldStop();
            const pass = runCrashRecovery({ storage, locks: fakeLocks(), snapshot, savedHandyKey: '', stopHandy: held, onReport: () => {} });
            mark();
            await until(() => held.asked.length === 1);
            mark();
            await settle(tick(30));
            mark();
            held.answer('KEY-DEAD-0001', { outcome: 'stopped', detail: 'result 0', final: true });
            confirmed = true;
            mark();
            await pass;
            await settle(tick(30));
            mark();
            const nextStart = nextStartOn();
            for (const point of points) {
                for (let i = 0; i < point.ls; i++) {
                    for (let extra = 0; extra <= queuedAfterCommitted(point.statuses); extra++) {
                        const durableImage = durable.image(point.statuses, extra);
                        const result = await nextStart(local.history[i], durableImage);
                        const where = `${mode}: localStorage at write ${i}, IndexedDB ${JSON.stringify(Array.from(durableImage))}`;
                        if (!point.confirmed) assert.deepEqual(result.asked, ['KEY-DEAD-0001'], `${where}: the stop owed is lost`);
                        const owed = durableImage.has(PENDING_CRASH_STOPS_KEY) ? JSON.parse(durableImage.get(PENDING_CRASH_STOPS_KEY)) : null;
                        if (point.confirmed && owed && owed.handy.length === 0) {
                            assert.deepEqual(result.asked, [], `${where}: a stop the Handy API confirmed is sent again`);
                            assert.deepEqual(result.reports, [], `${where}: and reported`);
                        }
                    }
                }
            }
        }
    });
});

describe('newPageId', () => {
    it('is different for every page, and survives a missing or broken crypto', () => {
        const ids = new Set(Array.from({ length: 200 }, () => newPageId()));
        assert.equal(ids.size, 200);
        assert.ok(newPageId(undefined).length > 8);
        assert.ok(newPageId({ getRandomValues() { throw new Error('no entropy'); } }).length > 8);
    });
});

describe('app.js puts the crash recovery in the page', () => {
    // app.js is the DOM wiring and does not load under node. Everything it
    // calls is tested above - createCrashRecovery's passes at boot and at a
    // session start among it; these guard the call sites themselves, each of
    // which the page was driven through in headless Chromium. Without any one
    // of them the suite above stays green while the page loses the recovery:
    // no stop after a crash, a false report after a clean STOP, a remote page
    // stopping the host's Handy, or a prerendered page stopping a session
    // running in another tab.
    const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
    const functionBody = (signature) => {
        const start = src.indexOf(signature);
        assert.ok(start >= 0, `${signature} not found in app.js`);
        return src.slice(start, src.indexOf('\n}\n', start));
    };

    it('one recovery per host page, none on a remote page, and the boot pass only once the page has been opened', () => {
        assert.equal((src.match(/createCrashRecovery\(/g) || []).length, 1, 'one per page');
        assert.equal((src.match(/runCrashRecovery|createLiveSessionTracker/g) || []).length, 0, 'nothing around it');
        const made = src.indexOf('const crashRecovery = isRemotePage ? null : createCrashRecovery({');
        assert.ok(made >= 0, 'made on host pages only');
        const args = src.slice(made, src.indexOf('});', made));
        // Read when a pass runs: a prerendered page may be opened with
        // another key saved, and a session starts with a Handy of its own.
        assert.match(args, /savedHandyKey: \(\) => safeGet\('handy_connection_key', ''\) \|\| ''/);
        assert.match(args, /liveHandyKey: \(\) => \(handyConnected \? getHandyKey\(\) : ''\)/);
        assert.match(args, /stopHandy: stopHandyAfterCrash/);
        assert.match(args, /locks: navigator\.locks/);
        assert.match(args, /onReport: showCrashReport/);
        // The records go to IndexedDB as well, and a commit that lands sends
        // what it held back.
        assert.match(args, /storage: crashStorage,/);
        assert.match(args, /onDurable: \(\) => \{ resumeHeldDispatch\(\); \}/);
        const store = src.indexOf('const crashStorage = isRemotePage ? null : createCrashRecoveryStorage({');
        assert.ok(store >= 0 && store < made, 'the storage is made first, on host pages only');
        assert.match(src.slice(store, made), /durable: openDurableStore\(\{ indexedDB: browserStore\('indexedDB'\) \}\)/);
        assert.equal((src.match(/\.atBoot\(\)/g) || []).length, 1, 'one boot pass');
        assert.match(src, /if \(crashRecovery\) whenActivated\(document, \(\) => \{ crashRecovery\.atBoot\(\); \}\);/);
    });

    it('notes what a live session drives before any command of it reaches a toy', () => {
        const dispatch = functionBody('function dispatchHardware(');
        const noted = dispatch.indexOf('noteLiveHardware();');
        assert.ok(noted >= 0, 'dispatchHardware notes the live hardware');
        for (const send of ['dispatchHandy(', 'dispatchIntiface(', 'dispatchTCode(']) {
            const at = dispatch.indexOf(send);
            assert.ok(at > noted, `${send} is called after the marker is noted`);
        }
        // A toy that joins mid-session can be moved by a role change or a
        // Test press before the next engine tick.
        const joins = src.match(/onDevicesChanged: \(\) => \{\s*noteLiveHardware\(\);/g) || [];
        assert.equal(joins.length, 2, 'Intiface and T-Code both note a toy that joins');
        const note = functionBody('function noteLiveHardware(');
        assert.match(note, /if \(!crashRecovery \|\| state\.sessionStatus === 'IDLE'\) return;/);
        assert.match(note, /crashRecovery\.note\(\{/);
    });

    it('tells other pages whether this session drives its Handy right now: after every dispatch, and when the page is frozen', () => {
        const note = functionBody('function noteLiveHardware(');
        assert.match(note, /driving: drivesHandyNow\(\{ sessionStatus: state\.sessionStatus, handyKey, mayBeMoving: handyMayBeMoving\(\), frozen: pageFrozen \}\)/);
        const dispatch = functionBody('function dispatchHardware(');
        const again = dispatch.lastIndexOf('noteLiveHardware();');
        for (const send of ['dispatchHandy(', 'dispatchIntiface(', 'dispatchTCode(']) {
            assert.ok(dispatch.indexOf(send) < again, `the marker is noted again after ${send}`);
        }
        // The page lifecycle stops every toy, The Handy first, and pauses a
        // running session (handlePageAway); only then is the page frozen.
        const frozen = src.indexOf("document.addEventListener('freeze', () => {");
        assert.ok(frozen >= 0, 'the freeze handler not found');
        const handler = src.slice(frozen, src.indexOf('});', frozen));
        const order = ["handlePageAway('freeze');", 'pageFrozen = true;', 'noteLiveHardware();'].map((line) => handler.indexOf(line));
        assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), 'stop, then frozen, then noted');
        assert.match(functionBody('function handlePageAway('), /^function handlePageAway\(kind\) \{\s*stopEveryToyOnPageAway\(\);/);
        assert.match(functionBody('function stopEveryToyOnPageAway('), /\{\s*\/\/[^\n]*\n\s*try \{ stopHandyOnUnload\(\); \} catch \(e\) \{\}/);
        const resumed = src.indexOf("document.addEventListener('resume', () => {");
        assert.ok(resumed >= 0, 'the resume handler not found');
        assert.match(src.slice(resumed, src.indexOf('});', resumed)), /^document\.addEventListener\('resume', \(\) => \{\s*pageFrozen = false;/);
    });

    it('runs the pass of a session start when a paused session resumes, and only then', () => {
        const start = functionBody('function startOrResumeSession(');
        const resume = start.indexOf('crashRecovery?.sessionResumed();');
        assert.ok(resume >= 0, 'startOrResumeSession runs the pass');
        assert.ok(resume > start.indexOf('} else {'), 'in the branch that resumes a paused session');
        assert.ok(resume > start.indexOf('if (transportWaitingReason())'), 'once the session is sure to resume');
        assert.equal((src.match(/sessionResumed\(\)/g) || []).length, 1);
    });

    it('removes the marker on STOP, every other ending and Reset', () => {
        assert.match(functionBody('function stopSession('), /crashRecovery\?\.clear\(\);/);
        const reset = src.indexOf("resetBtn?.addEventListener('click', () => {");
        assert.ok(reset >= 0, 'the Reset handler not found');
        assert.match(src.slice(reset, src.indexOf('\n});', reset)), /crashRecovery\?\.clear\(\);/);
    });

    it('settles what is owed to a Handy once Connect has confirmed a stop for it', () => {
        const connected = src.indexOf('await connectHandy(key);');
        assert.ok(connected >= 0, 'the Connect handler not found');
        assert.match(src.slice(connected, src.indexOf('} catch', connected)), /clearPendingCrashStop\(key, crashStorage\)/);
    });

    it('holds a toy back until the marker on disk names it, never a stop, and sends it what the engine asks for once it does', () => {
        const dispatch = functionBody('function dispatchHardware(');
        const held = dispatch.indexOf('const held = force || !crashRecovery ? NOTHING_HELD : crashRecovery.waitingForDisk();');
        assert.ok(held > dispatch.indexOf('noteLiveHardware();'), 'asked once the marker is noted');
        for (const [kind, send] of [['handy', 'dispatchHandy('], ['intiface', 'dispatchIntiface('], ['tcode', 'dispatchTCode(']]) {
            const at = dispatch.indexOf(`if (!held.${kind}) ${send}`);
            assert.ok(at > held, `${send} only for a toy the disk names`);
        }
        assert.match(dispatch, /heldDispatch = held\.handy \|\| held\.intiface \|\| held\.tcode;/);
        const resume = functionBody('function resumeHeldDispatch(');
        assert.match(resume, /if \(!heldDispatch\) return;/);
        assert.match(resume, /if \(state\.sessionStatus !== 'RUNNING' && state\.sessionStatus !== 'RAMPDOWN'\) return;/);
        assert.match(resume, /updateEngine\(\);/);
    });
});
