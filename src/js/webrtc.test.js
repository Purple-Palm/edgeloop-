// The link layer between the wearer's page and a partner's, driven through
// its real exports with a stand-in for PeerJS. webrtc.js looks the library up
// on window.Peer only when a peer is created, so a fake one is enough to run
// the host and the remote side exactly as a browser would.
//
// What is proven here is the version rule: after a release the two pages can
// be different builds for as long as either tab stays open, and 1.0.0 and
// 1.1.0 sent the same MODE_CHANGE for opposite things. An old controller's
// click on the running game turned it OFF on a 1.1.0 host, and a 1.1.0
// controller's "game off" restarted the game on a 1.0.0 host.
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PEER_PROTOCOL_VERSION, stampProtocol } from './peer-messages.js';

class Emitter {
    constructor() { this.listeners = {}; }
    on(event, fn) { (this.listeners[event] ||= []).push(fn); return this; }
    emit(event, ...args) { for (const fn of this.listeners[event] || []) fn(...args); }
}

// A DataConnection. `sent` is what this side put on the wire, as the other
// side would receive it (a copy, the way PeerJS serialises it).
class FakeConn extends Emitter {
    constructor(metadata) {
        super();
        this.metadata = metadata;
        this.open = false;
        this.sent = [];
    }
    send(message) { this.sent.push(structuredClone(message)); }
    close() {
        if (!this.open) return;
        this.open = false;
        this.emit('close');
    }
    openNow() {
        this.open = true;
        this.emit('open');
    }
}

class FakePeer extends Emitter {
    constructor() {
        super();
        FakePeer.last = this;
        this.id = 'ROOM-1';
        this.destroyed = false;
        this.disconnected = false;
        this.connections = [];
    }
    connect(room, options) {
        const conn = new FakeConn(options && options.metadata);
        conn.room = room;
        this.connections.push(conn);
        return conn;
    }
    reconnect() {}
    destroy() { this.destroyed = true; }
}

globalThis.window = { Peer: FakePeer };

// A fresh copy of the module for every case: its link state is module-wide,
// and a query string is a different module to the loader.
let instance = 0;
async function freshWebrtc() {
    instance += 1;
    return import(`./webrtc.js?case=${instance}`);
}

function recorder() {
    const events = [];
    const record = (name) => (...args) => events.push({ name, args });
    return {
        events,
        of: (name) => events.filter((e) => e.name === name).map((e) => e.args[0]),
        handlers: {
            onPartnerConnected: record('partner'),
            onControllerDisconnected: record('gone'),
            onViewerConnected: record('viewer'),
            onPeerProtocol: record('protocol'),
            onCommandReceived: record('command'),
            onCommandRefused: record('refused'),
            onConnected: record('connected'),
            onTelemetryReceived: record('telemetry'),
            onDisconnected: record('disconnected')
        }
    };
}

// What the builds from before versions send, verbatim.
const OLD_CONTROLLER_METADATA = { app: 'edgeloop', role: 'controller' };
const OLD_SELECT = { type: 'MODE_CHANGE', mode: 'oracle' };                // 1.0.0: pick this mode
const OLD_TOGGLE = { type: 'MODE_CHANGE', mode: 'oracle', enabled: false }; // 1.1.0: game off
const OLD_TELEMETRY = { type: 'TELEMETRY', hr: 104, sessionStatus: 'RUNNING', activeMode: 'oracle', teaseMode: 'classic', gameMode: 'oracle' };

async function hostWithController(metadata) {
    const rtc = await freshWebrtc();
    const log = recorder();
    assert.equal(rtc.initHostPeer(log.handlers), true);
    const conn = new FakeConn(metadata);
    FakePeer.last.emit('connection', conn);
    conn.openNow();
    return { rtc, log, conn };
}

async function remoteLinked(role = 'controller') {
    const rtc = await freshWebrtc();
    const log = recorder();
    assert.equal(rtc.initRemotePeer('ROOM-1', role, log.handlers), true);
    FakePeer.last.emit('open', 'ME');
    const conn = FakePeer.last.connections[0];
    conn.openNow();
    return { rtc, log, conn };
}

describe('the host judges every mode command by the version it carries', () => {
    it('knows an old controller for one the moment it connects', async () => {
        const { log } = await hostWithController(OLD_CONTROLLER_METADATA);
        assert.deepEqual(log.of('protocol'), [{ peer: 'controller', protocol: undefined, matches: false }]);
        // The notice follows the connection, not the other way round, so
        // "Controller Connected" never overwrites it.
        const names = log.events.map((e) => e.name);
        assert.ok(names.indexOf('partner') < names.indexOf('protocol'));
    });

    it('refuses an old page\'s mode and game clicks, and still obeys its STOP', async () => {
        const { log, conn } = await hostWithController(OLD_CONTROLLER_METADATA);
        conn.emit('data', OLD_SELECT);
        conn.emit('data', OLD_TOGGLE);
        conn.emit('data', { type: 'MODE_CHANGE', mode: 'classic', enabled: true });
        assert.equal(log.of('command').length, 0, 'a mode click from an old page must not be obeyed');
        assert.deepEqual(log.of('refused').map((cmd) => cmd.mode), ['oracle', 'oracle', 'classic']);
        conn.emit('data', { type: 'SESSION_STATE', status: 'IDLE' });
        conn.emit('data', { type: 'ORGASM_TOGGLE' });
        conn.emit('data', { type: 'SESSION_RESET' });
        conn.emit('data', { type: 'PING' });
        assert.deepEqual(log.of('command').map((cmd) => cmd.type), ['SESSION_STATE', 'ORGASM_TOGGLE', 'SESSION_RESET']);
        assert.equal(log.of('protocol').length, 1, 'the same old page is not reported again on every message');
    });

    it('obeys a controller on this version, `enabled` and all', async () => {
        const { log, conn } = await hostWithController({ ...OLD_CONTROLLER_METADATA, protocol: PEER_PROTOCOL_VERSION });
        assert.deepEqual(log.of('protocol'), [{ peer: 'controller', protocol: PEER_PROTOCOL_VERSION, matches: true }]);
        conn.emit('data', stampProtocol(OLD_TOGGLE));
        assert.deepEqual(log.of('command'), [{ ...OLD_TOGGLE, protocol: PEER_PROTOCOL_VERSION }]);
        assert.equal(log.of('refused').length, 0);
    });

    it('refuses a newer controller as well, and says it is newer', async () => {
        const newer = PEER_PROTOCOL_VERSION + 1;
        const { log, conn } = await hostWithController({ ...OLD_CONTROLLER_METADATA, protocol: newer });
        assert.deepEqual(log.of('protocol'), [{ peer: 'controller', protocol: newer, matches: false }]);
        conn.emit('data', { ...OLD_TOGGLE, protocol: newer });
        assert.equal(log.of('command').length, 0);
        assert.equal(log.of('refused').length, 1);
    });

    it('judges the command, not the link: an unversioned click is refused whatever the link said', async () => {
        const { log, conn } = await hostWithController({ ...OLD_CONTROLLER_METADATA, protocol: PEER_PROTOCOL_VERSION });
        conn.emit('data', OLD_TOGGLE);
        assert.equal(log.of('command').length, 0);
        assert.equal(log.of('refused').length, 1);
        // ...and the report follows what the page last said.
        assert.deepEqual(log.of('protocol').at(-1), { peer: 'controller', protocol: undefined, matches: false });
        conn.emit('data', stampProtocol({ type: 'PING' }));
        assert.deepEqual(log.of('protocol').at(-1), { peer: 'controller', protocol: PEER_PROTOCOL_VERSION, matches: true });
    });

    it('a viewer\'s version is nobody\'s business: it commands nothing', async () => {
        const rtc = await freshWebrtc();
        const log = recorder();
        rtc.initHostPeer(log.handlers);
        const viewer = new FakeConn({ app: 'edgeloop', role: 'viewer' });
        FakePeer.last.emit('connection', viewer);
        viewer.openNow();
        viewer.emit('data', { type: 'PING' });
        viewer.emit('data', OLD_TOGGLE);
        assert.equal(log.of('protocol').length, 0);
        assert.equal(log.of('command').length + log.of('refused').length, 0);
    });

    it('stamps every telemetry frame, for the controller and every viewer', async () => {
        const { rtc, conn } = await hostWithController({ ...OLD_CONTROLLER_METADATA, protocol: PEER_PROTOCOL_VERSION });
        const viewer = new FakeConn({ app: 'edgeloop', role: 'viewer' });
        FakePeer.last.emit('connection', viewer);
        viewer.openNow();
        const frame = { type: 'TELEMETRY', hr: 101, gameMode: 'off' };
        rtc.broadcastPeerTelemetry(frame);
        assert.deepEqual(conn.sent.at(-1), { ...frame, protocol: PEER_PROTOCOL_VERSION });
        assert.deepEqual(viewer.sent.at(-1), { ...frame, protocol: PEER_PROTOCOL_VERSION });
        assert.equal('protocol' in frame, false, 'the caller\'s frame is not touched');
    });

    it('forgets a controller\'s version with the controller, and learns the next one\'s', async () => {
        const { log, conn } = await hostWithController(OLD_CONTROLLER_METADATA);
        conn.close();
        assert.equal(log.of('gone').length, 1);
        const next = new FakeConn({ ...OLD_CONTROLLER_METADATA, protocol: PEER_PROTOCOL_VERSION });
        FakePeer.last.emit('connection', next);
        next.openNow();
        assert.deepEqual(log.of('protocol').at(-1), { peer: 'controller', protocol: PEER_PROTOCOL_VERSION, matches: true });
        next.emit('data', stampProtocol(OLD_SELECT));
        assert.equal(log.of('command').length, 1);
    });

    it('survives junk from any page', async () => {
        const { log, conn } = await hostWithController('not an object');
        for (const junk of [null, undefined, 'MODE_CHANGE', 42, [], { type: 'MODE_CHANGE', mode: 'oracle', protocol: {} }, { protocol: NaN }]) {
            assert.doesNotThrow(() => conn.emit('data', junk));
        }
        assert.equal(log.of('command').length, 0);
        assert.deepEqual(log.of('protocol')[0], { peer: 'controller', protocol: undefined, matches: false });
    });
});

describe('a remote page says its version and sends a mode change only to a host on it', () => {
    // The ping interval is faked, so a failing case cannot leave a real
    // timer running that holds the whole test run open.
    beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }));
    afterEach(() => mock.timers.reset());

    it('says its version as it connects and on every ping', async () => {
        const { rtc, conn } = await remoteLinked();
        assert.deepEqual(conn.metadata, { app: 'edgeloop', role: 'controller', protocol: PEER_PROTOCOL_VERSION });
        mock.timers.tick(rtc.PING_MS);
        assert.deepEqual(conn.sent.at(-1), { type: 'PING', protocol: PEER_PROTOCOL_VERSION });
        conn.close();
    });

    it('before the host has said anything, a mode change waits and a STOP does not', async () => {
        const { rtc, log, conn } = await remoteLinked();
        assert.equal(rtc.hostVersionAllows(OLD_TOGGLE), false);
        assert.equal(rtc.sendPeerCommand(OLD_TOGGLE), false);
        assert.equal(rtc.sendPeerCommand({ type: 'SESSION_STATE', status: 'IDLE' }), true);
        assert.deepEqual(conn.sent, [{ type: 'SESSION_STATE', status: 'IDLE', protocol: PEER_PROTOCOL_VERSION }]);
        assert.equal(log.of('protocol').length, 0, 'nothing is known, so nothing is reported');
        conn.close();
    });

    it('never sends "game off" to a host too old to say its version', async () => {
        const { rtc, log, conn } = await remoteLinked();
        conn.emit('data', OLD_TELEMETRY);
        assert.deepEqual(log.of('protocol'), [{ peer: 'host', protocol: undefined, matches: false }]);
        // The page still shows what the old host reports.
        assert.equal(log.of('telemetry').length, 1);
        assert.equal(log.of('telemetry')[0].gameMode, 'oracle');
        assert.equal(rtc.hostVersionAllows(OLD_TOGGLE), false);
        assert.equal(rtc.sendPeerCommand(OLD_TOGGLE), false);
        assert.equal(rtc.sendPeerCommand({ type: 'MODE_CHANGE', mode: 'milker', enabled: true }), false);
        assert.equal(conn.sent.filter((m) => m.type === 'MODE_CHANGE').length, 0, 'an old host restarts the game on this');
        // Transport, Reset and Force Orgasm still go.
        for (const cmd of [{ type: 'SESSION_STATE', status: 'PAUSED' }, { type: 'SESSION_RESET' }, { type: 'ORGASM_TOGGLE' }]) {
            assert.equal(rtc.sendPeerCommand(cmd), true, cmd.type);
        }
        assert.deepEqual(conn.sent.map((m) => m.type), ['SESSION_STATE', 'SESSION_RESET', 'ORGASM_TOGGLE']);
        // One report per change, not one per frame.
        conn.emit('data', OLD_TELEMETRY);
        assert.equal(log.of('protocol').length, 1);
        conn.close();
    });

    it('sends mode and game changes, stamped, to a host on this version', async () => {
        const { rtc, log, conn } = await remoteLinked();
        conn.emit('data', stampProtocol(OLD_TELEMETRY));
        assert.deepEqual(log.of('protocol'), [{ peer: 'host', protocol: PEER_PROTOCOL_VERSION, matches: true }]);
        assert.equal(rtc.hostVersionAllows(OLD_TOGGLE), true);
        assert.equal(rtc.sendPeerCommand(OLD_TOGGLE), true);
        assert.deepEqual(conn.sent.at(-1), { ...OLD_TOGGLE, protocol: PEER_PROTOCOL_VERSION });
        conn.close();
    });

    it('holds back from a newer host too, and reports it as newer', async () => {
        const newer = PEER_PROTOCOL_VERSION + 1;
        const { rtc, log, conn } = await remoteLinked();
        conn.emit('data', { ...OLD_TELEMETRY, protocol: newer });
        assert.deepEqual(log.of('protocol'), [{ peer: 'host', protocol: newer, matches: false }]);
        assert.equal(rtc.sendPeerCommand(OLD_TOGGLE), false);
        conn.close();
    });

    it('a viewer learns the host\'s version too, and still sends nothing', async () => {
        const { rtc, log, conn } = await remoteLinked('viewer');
        assert.equal(conn.metadata.role, 'viewer');
        assert.equal(conn.metadata.protocol, PEER_PROTOCOL_VERSION);
        conn.emit('data', OLD_TELEMETRY);
        assert.deepEqual(log.of('protocol'), [{ peer: 'host', protocol: undefined, matches: false }]);
        assert.equal(rtc.sendPeerCommand({ type: 'SESSION_STATE', status: 'IDLE' }), false);
        conn.close();
    });

    it('survives junk from the host', async () => {
        const { log, conn } = await remoteLinked();
        for (const junk of [null, 'TELEMETRY', 7, [], { type: 'TELEMETRY', protocol: { v: 2 } }, { type: 'NOT_TELEMETRY', protocol: PEER_PROTOCOL_VERSION }]) {
            assert.doesNotThrow(() => conn.emit('data', junk));
        }
        assert.deepEqual(log.of('protocol'), [{ peer: 'host', protocol: undefined, matches: false }]);
        conn.close();
    });
});
