let peer = null;
let peerConn = null;

export function initHostPeer({ onPartnerConnected, onCommandReceived, onPeerReady }) {
    if (peer) return;
    peer = new Peer();
    peer.on('open', (id) => {
        if (onPeerReady) onPeerReady(id);
    });
        peer.on('connection', (conn) => {
            peerConn = conn;
            if (onPartnerConnected) onPartnerConnected();
            conn.on('data', (data) => {
                if (onCommandReceived) onCommandReceived(data);
            });
        });
}

export function initControllerPeer(partnerRoom, { onConnected, onTelemetryReceived }) {
    peer = new Peer();
    peer.on('open', () => {
        peerConn = peer.connect(partnerRoom);
        peerConn.on('open', () => {
            if (onConnected) onConnected();
        });
            peerConn.on('data', (data) => {
                if (onTelemetryReceived) onTelemetryReceived(data);
            });
    });
}

export function broadcastPeerTelemetry(payload) {
    if (peerConn && peerConn.open) {
        peerConn.send(payload);
    }
}

export function sendPeerCommand(cmd) {
    if (peerConn && peerConn.open) {
        peerConn.send(cmd);
    }
}
