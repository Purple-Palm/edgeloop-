/**
 * PeerJS wrapper for remote control.
 *
 * Roles: the HOST owns the session and accepts ONE controller (transport,
 * orgasm and mode commands) plus any number of read-only VIEWERS. A remote
 * page is either a controller (?partner=) or a viewer (?group_sub=). Every
 * inbound message is validated in peer-messages.js before a callback sees
 * it. Peer and DataConnection errors, closes and silences are all surfaced
 * so nobody is ever shown as "connected" while the link is dead.
 *
 * Nothing here touches window.Peer at import time, so the module loads
 * under node:test; the library is looked up when a peer is created.
 *
 * Every message this side sends carries PEER_PROTOCOL_VERSION, and both
 * sides refuse a mode or game command across pages that do not speak the
 * same version (see peer-messages.js): the host by the version the command
 * carries, a controller by the version the host's telemetry carries. The
 * app is told the other page's version through onPeerProtocol, so both
 * people can be told which page needs a reload.
 */
import {
    sanitizeCommand,
    sanitizeTelemetry,
    stampProtocol,
    readPeerProtocol,
    peerProtocolMatches,
    peerCommandAllowed,
    PEER_PROTOCOL_VERSION
} from './peer-messages.js';

// A remote page pings every PING_MS; the host drops a link that has been
// silent for STALE_PEER_MS (pruneStalePeers is called from its clock).
export const PING_MS = 5000;
export const STALE_PEER_MS = 20000;

let peer = null;
let localRole = null;          // 'host' | 'controller' | 'viewer'
let handlers = {};
let controllerConn = null;     // host: the one live controller
const viewerConns = new Set(); // host: live viewers
const lastSeen = new Map();    // host: DataConnection -> last inbound timestamp
let hostConn = null;           // remote page: the link to the host
let pingTimer = null;
// The version the other page speaks, as it last said: the host's view of
// its controller, and a remote page's view of the host. Undefined while it
// is not known, and for a page from before versions, which never says.
let controllerProtocol;
let hostProtocol;
let hostProtocolKnown = false;

export function peerLibraryAvailable() {
    return typeof window !== 'undefined' && typeof window.Peer === 'function';
}

// Human text for a PeerJS error object (err.type) or a plain Error.
export function describePeerError(err) {
    const type = err && typeof err === 'object' ? err.type : null;
    switch (type) {
        case 'library-missing':
            return 'the PeerJS signalling library could not be loaded (CDN blocked or offline)';
        case 'browser-incompatible':
            return 'this browser does not support WebRTC data channels';
        case 'peer-unavailable':
            return 'the host room was not found; ask the host to reopen Share Control and send a fresh link';
        case 'network':
        case 'socket-error':
        case 'socket-closed':
        case 'server-error':
            return 'the signalling server could not be reached';
        case 'disconnected':
            return 'the signalling connection was lost';
        case 'unavailable-id':
        case 'invalid-id':
        case 'invalid-key':
        case 'ssl-unavailable':
            return 'the signalling server rejected the room';
        case 'webrtc':
            return 'the WebRTC connection failed';
        default: {
            const message = err && err.message ? String(err.message) : '';
            return message || 'unknown signalling error';
        }
    }
}

function call(name, ...args) {
    const fn = handlers[name];
    if (typeof fn === 'function') {
        try {
            fn(...args);
        } catch (e) {
            console.warn(`webrtc handler ${name} failed`, e);
        }
    }
}

function safeClose(conn) {
    try {
        conn.close();
    } catch (e) { /* already gone */ }
}

export function getPeerCounts() {
    return {
        controllers: controllerConn ? 1 : 0,
        viewers: viewerConns.size
    };
}

// Lifecycle shared by host and remote peers.
function wirePeerLifecycle() {
    peer.on('open', (id) => call('onPeerReady', id));
    peer.on('disconnected', () => {
        // Signalling only: existing data channels may survive. Try to get
        // the signalling link back so new remotes can still join.
        call('onSignallingLost');
        if (peer && !peer.destroyed) {
            try {
                peer.reconnect();
            } catch (e) { /* surfaced through the error event */ }
        }
    });
    peer.on('close', () => {
        // The peer was destroyed: every connection is dead with it.
        if (localRole === 'host') {
            for (const conn of [...viewerConns]) dropHostConn(conn, 'closed');
            if (controllerConn) dropHostConn(controllerConn, 'closed');
        } else {
            dropRemoteLink('closed');
        }
        call('onPeerClosed');
    });
    peer.on('error', (err) => {
        call('onPeerError', describePeerError(err), err);
    });
}

// ---------------------------------------------------------------- host

// A controller or viewer link is gone. Fires the matching disconnect
// callback only for a link that had actually opened.
function dropHostConn(conn, reason, err = null) {
    const wasController = conn === controllerConn;
    const wasViewer = viewerConns.has(conn);
    lastSeen.delete(conn);
    if (wasController) {
        controllerConn = null;
        controllerProtocol = undefined;
    }
    viewerConns.delete(conn);
    safeClose(conn);
    if (!wasController && !wasViewer) return;
    if (wasController) call('onControllerDisconnected', reason, err);
    if (wasViewer) call('onViewerDisconnected', reason, err);
    call('onCountsChanged', getPeerCounts());
}

// Tell the app which version the live controller speaks, once per change.
function noteControllerProtocol(protocol, force = false) {
    if (!force && protocol === controllerProtocol) return;
    controllerProtocol = protocol;
    call('onPeerProtocol', { peer: 'controller', protocol, matches: peerProtocolMatches(protocol) });
}

function acceptHostConnection(conn) {
    const role = conn.metadata && conn.metadata.role === 'viewer' ? 'viewer' : 'controller';
    conn.on('open', () => {
        lastSeen.set(conn, Date.now());
        if (role === 'controller') {
            // A new controller replaces the old one; the old link is closed
            // quietly (it is not a "disconnect", the seat is simply taken).
            const previous = controllerConn;
            controllerConn = conn;
            if (previous && previous !== conn) {
                lastSeen.delete(previous);
                safeClose(previous);
            }
            call('onPartnerConnected');
            // A controller says which version it speaks as it connects, and
            // one from before versions says nothing - which is the answer,
            // so the wearer is told at once rather than at the first ping.
            const metadata = conn.metadata && typeof conn.metadata === 'object' ? conn.metadata : {};
            noteControllerProtocol(readPeerProtocol(metadata.protocol), true);
        } else {
            viewerConns.add(conn);
            call('onViewerConnected');
        }
        call('onCountsChanged', getPeerCounts());
    });
    conn.on('data', (raw) => {
        lastSeen.set(conn, Date.now());
        const cmd = sanitizeCommand(raw, role);
        if (!cmd) return;
        if (conn === controllerConn) noteControllerProtocol(cmd.protocol);
        if (cmd.type === 'PING') return;
        // Judged by the version the command itself carries. A mode or game
        // change from a page on another version can mean something else
        // there than it does here, so it is refused rather than obeyed; the
        // app says so and re-sends the host's real mode, which puts the
        // partner's cards back where the session really is.
        if (!peerCommandAllowed(cmd, cmd.protocol)) {
            call('onCommandRefused', cmd);
            return;
        }
        call('onCommandReceived', cmd);
    });
    conn.on('close', () => dropHostConn(conn, 'closed'));
    conn.on('error', (err) => dropHostConn(conn, 'error', err));
    conn.on('iceStateChanged', (iceState) => {
        if (iceState === 'failed' || iceState === 'closed') dropHostConn(conn, 'ice');
    });
}

// Returns false when the signalling library is missing (onPeerError is
// called with a message the Share modal can show).
export function initHostPeer(h) {
    handlers = h || {};
    if (!peerLibraryAvailable()) {
        call('onPeerError', describePeerError({ type: 'library-missing' }), { type: 'library-missing' });
        return false;
    }
    if (peer && !peer.destroyed) {
        // Modal reopened: nothing to create, just repeat the room id.
        if (peer.id && !peer.disconnected) call('onPeerReady', peer.id);
        return true;
    }
    localRole = 'host';
    controllerConn = null;
    controllerProtocol = undefined;
    viewerConns.clear();
    lastSeen.clear();
    peer = new window.Peer();
    wirePeerLifecycle();
    peer.on('connection', acceptHostConnection);
    return true;
}

// Host clock hook: drop every link that has sent nothing (not even a ping)
// for STALE_PEER_MS. Returns how many were dropped.
export function pruneStalePeers(now = Date.now()) {
    if (localRole !== 'host') return 0;
    let dropped = 0;
    for (const [conn, seen] of [...lastSeen.entries()]) {
        if (now - seen > STALE_PEER_MS) {
            dropHostConn(conn, 'timeout');
            dropped += 1;
        }
    }
    return dropped;
}

// Host -> every remote. A send that throws marks that link dead.
export function broadcastPeerTelemetry(payload) {
    if (localRole !== 'host') return;
    const message = stampProtocol(payload);
    const targets = controllerConn ? [controllerConn, ...viewerConns] : [...viewerConns];
    for (const conn of targets) {
        if (!conn.open) continue;
        try {
            conn.send(message);
        } catch (e) {
            dropHostConn(conn, 'error', e);
        }
    }
}

// -------------------------------------------------------------- remote

function stopPing() {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
    }
}

function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
        if (hostConn && hostConn.open) {
            try {
                hostConn.send(stampProtocol({ type: 'PING' }));
            } catch (e) {
                dropRemoteLink('error', e);
            }
        }
    }, PING_MS);
}

// Tell the app which version the host speaks: on its first telemetry frame,
// and again only if that ever changes.
function noteHostProtocol(protocol) {
    if (hostProtocolKnown && protocol === hostProtocol) return;
    hostProtocolKnown = true;
    hostProtocol = protocol;
    call('onPeerProtocol', { peer: 'host', protocol, matches: peerProtocolMatches(protocol) });
}

function dropRemoteLink(reason, err = null) {
    stopPing();
    const conn = hostConn;
    if (!conn) return;
    hostConn = null;
    safeClose(conn);
    call('onDisconnected', reason, err);
}

// role: 'controller' | 'viewer'. Returns false when the signalling library
// is missing (onPeerError is called with the message to show).
export function initRemotePeer(room, role, h) {
    handlers = h || {};
    if (!peerLibraryAvailable()) {
        call('onPeerError', describePeerError({ type: 'library-missing' }), { type: 'library-missing' });
        return false;
    }
    localRole = role === 'viewer' ? 'viewer' : 'controller';
    hostProtocol = undefined;
    hostProtocolKnown = false;
    peer = new window.Peer();
    wirePeerLifecycle();
    peer.on('open', () => {
        if (hostConn) return;
        const conn = peer.connect(room, {
            reliable: true,
            metadata: { app: 'edgeloop', role: localRole, protocol: PEER_PROTOCOL_VERSION }
        });
        hostConn = conn;
        conn.on('open', () => {
            startPing();
            call('onConnected');
        });
        conn.on('data', (raw) => {
            const telemetry = sanitizeTelemetry(raw);
            if (!telemetry) return;
            noteHostProtocol(telemetry.protocol);
            call('onTelemetryReceived', telemetry);
        });
        conn.on('close', () => dropRemoteLink('closed'));
        conn.on('error', (err) => dropRemoteLink('error', err));
        conn.on('iceStateChanged', (iceState) => {
            if (iceState === 'failed' || iceState === 'closed') dropRemoteLink('ice');
        });
    });
    return true;
}

// Controller -> host. A viewer (or the host itself) never sends commands,
// and a mode or game change is never sent to a host that has not shown it
// speaks this version: a host on another one can read it as something else
// - a 1.0.0 host restarted the very game a 1.1.0 "game off" meant to stop.
export function sendPeerCommand(cmd) {
    if (localRole !== 'controller' || !hostConn || !hostConn.open) return false;
    if (!hostVersionAllows(cmd)) return false;
    try {
        hostConn.send(stampProtocol(cmd));
        return true;
    } catch (e) {
        dropRemoteLink('error', e);
        return false;
    }
}

// Remote page: does what this page knows of the host's version let `cmd`
// go to it? Nothing is known before the host's first telemetry frame, and
// until then a mode change waits. The app asks before it shows a mode click
// as made, since the host's next frame would only take it back.
export function hostVersionAllows(cmd) {
    return peerCommandAllowed(cmd, hostProtocolKnown ? hostProtocol : undefined);
}

export function isPeerLinkOpen() {
    if (localRole === 'host') return Boolean(controllerConn) || viewerConns.size > 0;
    return Boolean(hostConn && hostConn.open);
}
