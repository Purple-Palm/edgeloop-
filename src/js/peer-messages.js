// Validation of everything that arrives over the WebRTC data channel, and
// the transport command both ends of it agree on.
//
// Both directions are untrusted: a controller page may only issue the
// transport / orgasm / mode commands its UI exposes (never limits or raw
// speeds), a viewer may only ping, and the host's telemetry is coerced and
// clamped before it touches the remote page's state. Anything else is
// dropped, never partially applied.
//
// The two pages are also not always the same build. A PWA keeps running the
// code it loaded until it is reloaded, so after a release the wearer's page
// and the partner's can be a version apart for as long as either tab stays
// open. Every message therefore says which version of these messages its
// sender speaks, and the commands whose meaning changed between versions are
// refused between pages that do not speak the same one.
import { ENGINE_MODES, TEASE_MODES, GAME_MODES, MIN_EDGE_HOLD_PERCENT, MAX_EDGE_HOLD_PERCENT } from './engine.js';
import {
    MIN_TRAIN_HOLD_SECONDS,
    MAX_TRAIN_HOLD_SECONDS,
    MIN_TRAIN_EDGES,
    MAX_TRAIN_EDGES,
    MAX_FORCE_ORGASM_SECONDS,
    FORCE_ORGASM_REFUSALS
} from './session-rules.js';

// The version of the messages in this file. It goes up whenever a message
// changes what it MEANS, not only when its shape changes, because a page
// that reads the old meaning cannot tell the difference on its own. That is
// exactly what happened to MODE_CHANGE: in 1.0.0 it selected a mode, in
// 1.1.0 a game card toggles, and the two builds kept sending each other the
// same message for opposite things - an old controller's click on the game
// that was running turned it OFF on a 1.1.0 host, and a 1.1.0 controller's
// "game off" restarted the game from zero on a 1.0.0 host. Neither build
// sent a version at all, so a message without one is from before this
// number existed, and counts as older.
//
// Version 3 added Script mode to ENGINE_MODES. A host in it reports an
// activeMode a version 2 page cannot read, and that page's mode cards then
// toggle against a mode it has never heard of, so MODE_CHANGE is refused
// across the two again (VERSIONED_COMMANDS).
export const PEER_PROTOCOL_VERSION = 3;

// Anything past this is not a version but junk in the field.
const MAX_PEER_PROTOCOL = 1000;

// The commands whose meaning has changed between versions, and so the only
// ones two pages on different versions may not exchange. Transport, Reset
// and Force Orgasm have meant the same thing in every build, and a partner's
// STOP must never be refused over a version number. A release that changes
// what another command means bumps the version AND adds the command here:
// the newer page applies this list on both ends of a link - refusing what
// an older controller sends, and not sending to an older host - so an older
// page never has to know what changed after it.
export const VERSIONED_COMMANDS = ['MODE_CHANGE'];

// What a message says about the version its sender speaks: a whole number,
// or undefined when it says nothing usable - which is what every build from
// before PEER_PROTOCOL_VERSION says. A string or a fraction is not a version.
export function readPeerProtocol(value) {
    return Number.isInteger(value) && value >= 1 && value <= MAX_PEER_PROTOCOL ? value : undefined;
}

export function peerProtocolMatches(protocol) {
    return protocol === PEER_PROTOCOL_VERSION;
}

// 'same', 'older' or 'newer', seen from this page. A page that sent no
// version is older: versions started with this one.
export function peerProtocolRelation(protocol) {
    if (peerProtocolMatches(protocol)) return 'same';
    return Number.isInteger(protocol) && protocol > PEER_PROTOCOL_VERSION ? 'newer' : 'older';
}

// Every message this build sends says which version it speaks.
export function stampProtocol(message) {
    return { ...message, protocol: PEER_PROTOCOL_VERSION };
}

// May `cmd` cross between this page and one that speaks `peerProtocol`?
// The host asks it of every command with the version the command itself
// carries; a controller asks it before sending, with the version the host's
// telemetry carries - and before the first frame it knows none, so a mode
// click then waits rather than risk a host that could misread it.
export function peerCommandAllowed(cmd, peerProtocol) {
    if (!isPlainObject(cmd) || typeof cmd.type !== 'string') return false;
    if (!VERSIONED_COMMANDS.includes(cmd.type)) return true;
    return peerProtocolMatches(peerProtocol);
}

// The notice each person sees when the other page speaks another version.
// `role` is THIS page's: 'host', 'controller' or 'viewer'. Only the page on
// the older version can fix it, by being reloaded; a reload of the host's
// page ends the session running there and opens a new room, so it says so.
export function describePeerVersionMismatch(role, peerProtocol) {
    const newer = peerProtocolRelation(peerProtocol) === 'newer';
    const why = 'Mode and game changes can mean different things in different versions';
    const stillWorks = 'START, PAUSE, STOP, Reset and Force Orgasm still work.';
    const hostReload = 'a reload ends the session running there and opens a new room with a new link';
    if (role === 'host') {
        return newer
            ? `Your partner's controller runs a newer version of EdgeLoop than this page. ${why}, so this page refuses them from it. Reload this page between sessions to match it: a reload ends the session here and opens a new room, so your partner will need the new link. ${stillWorks}`
            : `Your partner's controller runs an older version of EdgeLoop. ${why}, so this page refuses them from it. Ask your partner to reload their page. ${stillWorks}`;
    }
    if (role === 'viewer') {
        return newer
            ? 'The host runs a newer version of EdgeLoop than this page, so some of what it sends may not show here as it should. Reload this page to match it.'
            : `The host runs an older version of EdgeLoop than this page, so some of what it sends may not show here as it should. The host's page needs a reload to match it, between sessions: ${hostReload}.`;
    }
    return newer
        ? `The host runs a newer version of EdgeLoop than this page. ${why}, so this page does not send them. Reload this page to match it. ${stillWorks}`
        : `The host runs an older version of EdgeLoop. ${why}, so this page does not send them. The host's page needs a reload to match this one, between sessions: ${hostReload}. ${stillWorks}`;
}

export const PEER_ROLES = ['controller', 'viewer'];

// The modes a partner may select. Script mode plays the wearer's own video
// and funscript, which exist only on the wearer's device, so a partner can
// see it (telemetry carries it) and PAUSE or STOP it, but never select it.
export const PARTNER_MODES = Object.freeze(ENGINE_MODES.filter((mode) => mode !== 'script'));

// Statuses a controller may ASK for. RAMPDOWN is host-internal.
export const COMMAND_STATUSES = ['IDLE', 'RUNNING', 'PAUSED'];

// Statuses the host may REPORT.
export const REMOTE_STATUSES = ['IDLE', 'RUNNING', 'PAUSED', 'RAMPDOWN'];

const SIGNAL_STATES = ['ok', 'holding', 'stale'];

export const HISTORY_LENGTH = 60;
export const HR_MAX_BPM = 250;
const SECONDS_MAX = 48 * 3600;
const COUNT_MAX = 100000;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Number() coercion plus range clamp; `undefined` when the value is not a
// finite number at all, so a missing field is never turned into 0.
function clampNumber(value, lo, hi, integer = false) {
    if (value === undefined || value === null || value === '' || typeof value === 'boolean') return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    const clamped = Math.max(lo, Math.min(hi, n));
    return integer ? Math.round(clamped) : clamped;
}

function oneOf(value, allowed) {
    return allowed.includes(value) ? value : undefined;
}

// Controller / viewer -> host. Returns the sanitized command or null. The
// sender's version rides along as `protocol` when it sent a usable one and
// is absent otherwise, so the host can judge the command by it.
export function sanitizeCommand(raw, role = 'controller') {
    const command = readCommand(raw, role);
    if (!command) return null;
    const protocol = readPeerProtocol(raw.protocol);
    if (protocol !== undefined) command.protocol = protocol;
    return command;
}

function readCommand(raw, role) {
    if (!isPlainObject(raw) || typeof raw.type !== 'string') return null;
    if (raw.type === 'PING') return { type: 'PING' };
    if (role !== 'controller') return null;
    switch (raw.type) {
        case 'SESSION_STATE': {
            const status = oneOf(raw.status, COMMAND_STATUSES);
            if (!status) return null;
            const command = { type: 'SESSION_STATE', status };
            // Present only when the sender said so: the host state its button
            // was showing when it was pressed (transportCommand,
            // hostTransportAction).
            const from = oneOf(raw.from, REMOTE_STATUSES);
            if (from) command.from = from;
            return command;
        }
        case 'SESSION_RESET':
            return { type: 'SESSION_RESET' };
        case 'ORGASM_TOGGLE':
            return { type: 'ORGASM_TOGGLE' };
        case 'MODE_CHANGE': {
            const mode = oneOf(raw.mode, PARTNER_MODES);
            if (!mode) return null;
            const command = { type: 'MODE_CHANGE', mode };
            // Present only when the sender said so. A game click carries
            // whether that game should be on, so the host does not toggle twice.
            if (typeof raw.enabled === 'boolean') command.enabled = raw.enabled;
            return command;
        }
        default:
            return null;
    }
}

// The command a controller's play / pause button sends, for the host status
// that page is showing: RUNNING over START or RESUME, PAUSED over PAUSE, and
// `from`, the status the button showed, so the host takes it only for the
// state it was pressed in (hostTransportAction). A status the page cannot
// read asks for the direction that stops the motors, as it always did, and
// claims no state it was pressed for.
export function transportCommand(shownStatus) {
    const status = shownStatus === 'IDLE' || shownStatus === 'PAUSED' ? 'RUNNING' : 'PAUSED';
    const command = { type: 'SESSION_STATE', status };
    if (REMOTE_STATUSES.includes(shownStatus)) command.from = shownStatus;
    return command;
}

// What the host does with a controller's SESSION_STATE command, given the
// state it is in now: 'start', 'resume', 'pause', 'stop' or null (nothing).
// The controller has one transport button, and it sends RUNNING both as
// START, over a host it shows IDLE, and as RESUME, over one it shows PAUSED.
// The host used to take any RUNNING as "start or resume, whichever fits", and
// a command can reach it after the state it was pressed for has gone. The
// status a controller shows is the host's as of its last report, so the
// wearer's STOP and the partner's RESUME can cross on the way. And a native
// dialog on the host holds back every message until it is answered: Came
// Early and Finished me pause the session behind their question, so the
// partner's button reads RESUME for as long as it is open; pressed then, the
// RESUME waited behind the dialog, the wearer's OK ended the session, and the
// RESUME arrived at an idle host as a START - a brand-new session driving the
// toys a second after the wearer had confirmed a climax. So a controller now
// sends `from`, the host state its button showed (transportCommand), and
// RUNNING acts only on the state it was pressed for: a RESUME never starts a
// session the wearer has ended since, and a START never resumes one the
// wearer has paused since. A command without `from` - a controller page from
// before it was sent - is taken as it always was. PAUSED and IDLE only ever
// stop the toys, and are taken as they always were.
export function hostTransportAction(command, hostStatus) {
    if (!command || command.type !== 'SESSION_STATE') return null;
    const active = hostStatus === 'RUNNING' || hostStatus === 'RAMPDOWN';
    switch (command.status) {
        case 'IDLE':
            return 'stop';
        case 'PAUSED':
            return active ? 'pause' : null;
        case 'RUNNING': {
            if (hostStatus !== 'IDLE' && hostStatus !== 'PAUSED') return null;
            if (command.from !== undefined && command.from !== hostStatus) return null;
            return hostStatus === 'IDLE' ? 'start' : 'resume';
        }
        default:
            return null;
    }
}

// Script mode's phase as the host's status line reads it ("FREE", "EASING
// 64%", "SKIPPING: EDGE", "REJOINING 5 s (VIDEO HELD)"), or '' outside
// Script mode. Short plain words only: a partner's page prints it.
export const SCRIPT_PHASE_MAX_LENGTH = 48;
export function readScriptPhase(value) {
    if (typeof value !== 'string' || value.length > SCRIPT_PHASE_MAX_LENGTH) return undefined;
    return /^[A-Za-z0-9 :%().-]*$/.test(value) ? value : undefined;
}

// Host -> controller / viewer. Returns an object holding only the fields
// that were present AND valid (absent fields stay undefined so the remote
// page keeps its previous value), or null when it is not telemetry at all.
export function sanitizeTelemetry(raw) {
    if (!isPlainObject(raw) || raw.type !== 'TELEMETRY') return null;
    const out = { type: 'TELEMETRY' };

    // The version the host speaks; undefined from a host too old to say.
    out.protocol = readPeerProtocol(raw.protocol);
    out.hr = clampNumber(raw.hr, 0, HR_MAX_BPM, true);
    out.seconds = clampNumber(raw.seconds, 0, SECONDS_MAX, true);
    out.chosenTargetSeconds = clampNumber(raw.chosenTargetSeconds, 0, SECONDS_MAX, true);
    out.sessionStatus = oneOf(raw.sessionStatus, REMOTE_STATUSES);
    out.edges = clampNumber(raw.edges, 0, COUNT_MAX, true);
    out.pauses = clampNumber(raw.pauses, 0, COUNT_MAX, true);
    out.strokerSpeed = clampNumber(raw.strokerSpeed, 0, 100);
    out.prostateSpeed = clampNumber(raw.prostateSpeed, 0, 100);
    out.minHr = clampNumber(raw.minHr, 30, HR_MAX_BPM, true);
    out.maxHr = clampNumber(raw.maxHr, 30, HR_MAX_BPM, true);
    // The pullback mark, so a remote chart draws the host's line
    // instead of one of its own.
    out.edgeTriggerHr = clampNumber(raw.edgeTriggerHr, 30, HR_MAX_BPM, true);
    out.activeMode = oneOf(raw.activeMode, ENGINE_MODES);
    out.teaseMode = oneOf(raw.teaseMode, TEASE_MODES);
    out.gameMode = raw.gameMode === 'off' ? 'off' : oneOf(raw.gameMode, GAME_MODES);
    // The host's own game settings. A remote page has its own persisted
    // copies of these, and showing those would quote the PARTNER's numbers
    // back at them while they pace the wearer's session by them.
    out.trainHoldSeconds = clampNumber(raw.trainHoldSeconds, MIN_TRAIN_HOLD_SECONDS, MAX_TRAIN_HOLD_SECONDS, true);
    out.trainEdges = clampNumber(raw.trainEdges, MIN_TRAIN_EDGES, MAX_TRAIN_EDGES, true);
    out.edgeHoldPercent = clampNumber(raw.edgeHoldPercent, MIN_EDGE_HOLD_PERCENT, MAX_EDGE_HOLD_PERCENT, true);
    out.orgasmMode = typeof raw.orgasmMode === 'boolean' ? raw.orgasmMode : undefined;
    // The countdown on the host's Force Orgasm button (0 = none), never
    // longer than the longest limit the host offers, and why the host would
    // refuse to switch it on, so a partner's button reads what the wearer's
    // does and a partner's tap in a landing is answered on their own screen.
    out.orgasmSecondsLeft = clampNumber(raw.orgasmSecondsLeft, 0, MAX_FORCE_ORGASM_SECONDS, true);
    out.orgasmRefusal = oneOf(raw.orgasmRefusal, FORCE_ORGASM_REFUSALS);
    out.ready = typeof raw.ready === 'boolean' ? raw.ready : undefined;
    // What the script is doing, so a partner sees the skip at an edge.
    out.scriptPhase = readScriptPhase(raw.scriptPhase);

    if (Array.isArray(raw.history)) {
        const cleaned = [];
        for (const sample of raw.history) {
            const bpm = clampNumber(sample, 0, HR_MAX_BPM, true);
            if (bpm !== undefined) cleaned.push(bpm);
        }
        out.history = cleaned.slice(-HISTORY_LENGTH);
    }

    if (isPlainObject(raw.hrSignal)) {
        out.hrSignal = {
            status: oneOf(raw.hrSignal.status, SIGNAL_STATES) || 'ok',
            noContact: Boolean(raw.hrSignal.noContact),
            silentMs: clampNumber(raw.hrSignal.silentMs, 0, SECONDS_MAX * 1000, true) ?? 0
        };
    }

    return out;
}
