import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    sanitizeCommand,
    sanitizeTelemetry,
    transportCommand,
    hostTransportAction,
    HISTORY_LENGTH,
    REMOTE_STATUSES,
    PEER_PROTOCOL_VERSION,
    SCRIPT_PHASE_MAX_LENGTH,
    readScriptPhase,
    PARTNER_MODES,
    VERSIONED_COMMANDS,
    readPeerProtocol,
    peerProtocolMatches,
    peerProtocolRelation,
    stampProtocol,
    peerCommandAllowed,
    describePeerVersionMismatch
} from './peer-messages.js';
import { ENGINE_MODES } from './engine.js';

describe('sanitizeCommand', () => {
    it('accepts the transport, orgasm and mode commands the controller UI exposes', () => {
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING' }), { type: 'SESSION_STATE', status: 'RUNNING' });
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_STATE', status: 'PAUSED' }), { type: 'SESSION_STATE', status: 'PAUSED' });
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_STATE', status: 'IDLE' }), { type: 'SESSION_STATE', status: 'IDLE' });
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_RESET' }), { type: 'SESSION_RESET' });
        assert.deepEqual(sanitizeCommand({ type: 'ORGASM_TOGGLE' }), { type: 'ORGASM_TOGGLE' });
        assert.deepEqual(sanitizeCommand({ type: 'MODE_CHANGE', mode: 'milker' }), { type: 'MODE_CHANGE', mode: 'milker' });
        assert.deepEqual(
            sanitizeCommand({ type: 'MODE_CHANGE', mode: 'oracle', enabled: false }),
            { type: 'MODE_CHANGE', mode: 'oracle', enabled: false }
        );
    });

    it('strips every extra field so raw limits or speeds never reach the host', () => {
        const cmd = sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING', maxHr: 999, chosenSeconds: -1, speed: 100 });
        assert.deepEqual(cmd, { type: 'SESSION_STATE', status: 'RUNNING' });
    });

    it('rejects unknown types, unknown statuses, unknown modes and garbage', () => {
        assert.equal(sanitizeCommand({ type: 'SET_LIMITS', maxHr: 200 }), null);
        assert.equal(sanitizeCommand({ type: 'SESSION_STATE', status: 'RAMPDOWN' }), null);
        assert.equal(sanitizeCommand({ type: 'SESSION_STATE' }), null);
        assert.equal(sanitizeCommand({ type: 'MODE_CHANGE', mode: '<script>' }), null);
        // Script mode plays files only the wearer's device has: a partner can
        // never select it, whatever else the message says.
        assert.equal(sanitizeCommand({ type: 'MODE_CHANGE', mode: 'script' }), null);
        assert.equal(sanitizeCommand({ type: 'MODE_CHANGE', mode: 'script', enabled: true, protocol: PEER_PROTOCOL_VERSION }), null);
        assert.equal(sanitizeCommand({ type: 42 }), null);
        assert.equal(sanitizeCommand('SESSION_RESET'), null);
        assert.equal(sanitizeCommand(null), null);
        assert.equal(sanitizeCommand([]), null);
    });

    it('lets a viewer ping but never command', () => {
        assert.deepEqual(sanitizeCommand({ type: 'PING' }, 'viewer'), { type: 'PING' });
        assert.equal(sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING' }, 'viewer'), null);
        assert.equal(sanitizeCommand({ type: 'ORGASM_TOGGLE' }, 'viewer'), null);
        assert.equal(sanitizeCommand({ type: 'SESSION_RESET' }, 'viewer'), null);
    });

    it('carries the host state a transport command was pressed for, and nothing that is not one', () => {
        assert.deepEqual(
            sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING', from: 'PAUSED' }),
            { type: 'SESSION_STATE', status: 'RUNNING', from: 'PAUSED' }
        );
        assert.deepEqual(
            sanitizeCommand({ type: 'SESSION_STATE', status: 'PAUSED', from: 'RAMPDOWN' }),
            { type: 'SESSION_STATE', status: 'PAUSED', from: 'RAMPDOWN' }
        );
        for (const from of ['paused', 'STOPPED', 3, null, {}, '']) {
            assert.deepEqual(sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING', from }), { type: 'SESSION_STATE', status: 'RUNNING' });
        }
        assert.equal(sanitizeCommand({ type: 'SESSION_STATE', from: 'PAUSED' }), null);
    });
});

describe('hostTransportAction', () => {
    const command = (status, from) => sanitizeCommand(from === undefined
        ? { type: 'SESSION_STATE', status }
        : { type: 'SESSION_STATE', status, from });

    it('a RESUME that reaches the host after the session ended starts nothing', () => {
        // Came Early and Finished me pause the session behind their question,
        // so the partner's button reads RESUME while it is open. Pressed then,
        // the command waited behind the host's dialog, OK ended the session,
        // and the RESUME arrived at an idle host - which took it for START and
        // drove the toys a second after the wearer confirmed a climax.
        assert.equal(hostTransportAction(command('RUNNING', 'PAUSED'), 'IDLE'), null);
        // Cancel leaves the session paused: then the partner's RESUME resumes it.
        assert.equal(hostTransportAction(command('RUNNING', 'PAUSED'), 'PAUSED'), 'resume');
    });

    it('a START starts only an idle host, and never resumes a session paused since', () => {
        assert.equal(hostTransportAction(command('RUNNING', 'IDLE'), 'IDLE'), 'start');
        assert.equal(hostTransportAction(command('RUNNING', 'IDLE'), 'PAUSED'), null);
        for (const busy of ['RUNNING', 'RAMPDOWN']) {
            assert.equal(hostTransportAction(command('RUNNING', 'IDLE'), busy), null);
            assert.equal(hostTransportAction(command('RUNNING', 'PAUSED'), busy), null);
        }
        // A RUNNING no controller button sends is never acted on.
        assert.equal(hostTransportAction(command('RUNNING', 'RUNNING'), 'IDLE'), null);
        assert.equal(hostTransportAction(command('RUNNING', 'RAMPDOWN'), 'PAUSED'), null);
    });

    it('PAUSE and STOP act as they always did, whatever the controller showed', () => {
        for (const from of [undefined, 'IDLE', 'RUNNING', 'PAUSED', 'RAMPDOWN']) {
            assert.equal(hostTransportAction(command('PAUSED', from), 'RUNNING'), 'pause');
            assert.equal(hostTransportAction(command('PAUSED', from), 'RAMPDOWN'), 'pause');
            assert.equal(hostTransportAction(command('PAUSED', from), 'PAUSED'), null);
            assert.equal(hostTransportAction(command('PAUSED', from), 'IDLE'), null);
            for (const host of ['IDLE', 'RUNNING', 'PAUSED', 'RAMPDOWN']) {
                assert.equal(hostTransportAction(command('IDLE', from), host), 'stop');
            }
        }
    });

    it('a command from a controller that does not say what it showed is taken as before', () => {
        assert.equal(hostTransportAction(command('RUNNING'), 'IDLE'), 'start');
        assert.equal(hostTransportAction(command('RUNNING'), 'PAUSED'), 'resume');
        assert.equal(hostTransportAction(command('RUNNING'), 'RUNNING'), null);
        assert.equal(hostTransportAction(command('RUNNING'), 'RAMPDOWN'), null);
    });

    it('anything that is not a transport command does nothing', () => {
        assert.equal(hostTransportAction(null, 'IDLE'), null);
        assert.equal(hostTransportAction({ type: 'ORGASM_TOGGLE' }, 'RUNNING'), null);
        assert.equal(hostTransportAction({ type: 'SESSION_STATE', status: 'RAMPDOWN' }, 'RUNNING'), null);
    });
});

describe('sanitizeTelemetry', () => {
    it('returns null for anything that is not telemetry', () => {
        assert.equal(sanitizeTelemetry({ type: 'SESSION_STATE', status: 'RUNNING' }), null);
        assert.equal(sanitizeTelemetry(null), null);
        assert.equal(sanitizeTelemetry('TELEMETRY'), null);
    });

    it('coerces numeric strings and clamps every number', () => {
        const t = sanitizeTelemetry({
            type: 'TELEMETRY',
            hr: '132',
            seconds: -5,
            chosenTargetSeconds: 1e12,
            edges: '3',
            pauses: 2.6,
            strokerSpeed: 250,
            prostateSpeed: -10,
            minHr: 10,
            maxHr: '150'
        });
        assert.equal(t.hr, 132);
        assert.equal(t.seconds, 0);
        assert.equal(t.chosenTargetSeconds, 48 * 3600);
        assert.equal(t.edges, 3);
        assert.equal(t.pauses, 3);
        assert.equal(t.strokerSpeed, 100);
        assert.equal(t.prostateSpeed, 0);
        assert.equal(t.minHr, 30);
        assert.equal(t.maxHr, 150);
    });

    it('carries the pullback mark so a remote chart draws the real one', () => {
        const t = sanitizeTelemetry({ type: 'TELEMETRY', maxHr: 140, edgeTriggerHr: '133' });
        assert.equal(t.edgeTriggerHr, 133);
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', edgeTriggerHr: 999 }).edgeTriggerHr, 250);
        // Absent or unusable: undefined, never a fabricated number.
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY' }).edgeTriggerHr, undefined);
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', edgeTriggerHr: 'abc' }).edgeTriggerHr, undefined);
    });

    it('leaves invalid or missing fields undefined instead of zeroing them', () => {
        const t = sanitizeTelemetry({ type: 'TELEMETRY', hr: 'abc', seconds: NaN, sessionStatus: 'EXPLODED', activeMode: 'ghost', orgasmMode: 'yes', ready: 1 });
        assert.equal(t.hr, undefined);
        assert.equal(t.seconds, undefined);
        assert.equal(t.sessionStatus, undefined);
        assert.equal(t.activeMode, undefined);
        assert.equal(t.orgasmMode, undefined);
        assert.equal(t.ready, undefined);
        assert.equal(t.history, undefined);
        assert.equal(t.hrSignal, undefined);
    });

    it('accepts known statuses, modes and booleans', () => {
        const t = sanitizeTelemetry({
            type: 'TELEMETRY',
            sessionStatus: 'RAMPDOWN',
            activeMode: 'oracle',
            teaseMode: 'shortener',
            gameMode: 'off',
            orgasmMode: true,
            ready: false
        });
        assert.equal(t.sessionStatus, 'RAMPDOWN');
        assert.equal(t.activeMode, 'oracle');
        // A host in Script mode says so: the partner sees the mode it cannot select.
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', activeMode: 'script' }).activeMode, 'script');
        assert.ok(!PARTNER_MODES.includes('script'));
        assert.equal(PARTNER_MODES.length, 9);
        assert.equal(t.teaseMode, 'shortener');
        assert.equal(t.gameMode, 'off');
        assert.equal(t.orgasmMode, true);
        assert.equal(t.ready, false);
    });

    it('cleans the history and keeps only the newest 60 samples', () => {
        const history = Array.from({ length: 80 }, (_, i) => i);
        history.push('bad', null, 999, -4);
        const t = sanitizeTelemetry({ type: 'TELEMETRY', history });
        assert.equal(t.history.length, HISTORY_LENGTH);
        assert.ok(t.history.every((v) => Number.isFinite(v) && v >= 0 && v <= 250));
        assert.equal(t.history[t.history.length - 1], 0);
        assert.equal(t.history[t.history.length - 2], 250);
    });

    it('carries the host\'s Edge Training and pullback settings', () => {
        // A remote page has its own persisted copies of these. Without them
        // on the wire, the Edge Training card a partner reads while pacing
        // the wearer's session quotes the PARTNER's own numbers, right under
        // a mode name and an edge counter that ARE live telemetry.
        const t = sanitizeTelemetry({
            type: 'TELEMETRY', trainHoldSeconds: 45, trainEdges: 9, edgeHoldPercent: 95
        });
        assert.equal(t.trainHoldSeconds, 45);
        assert.equal(t.trainEdges, 9);
        assert.equal(t.edgeHoldPercent, 95);

        // Clamped to the same bounds the host's own inputs use.
        const wild = sanitizeTelemetry({
            type: 'TELEMETRY', trainHoldSeconds: 5000, trainEdges: 0, edgeHoldPercent: 400
        });
        assert.equal(wild.trainHoldSeconds, 90);
        assert.equal(wild.trainEdges, 1);
        assert.equal(wild.edgeHoldPercent, 100);

        // Absent stays absent, so a remote page keeps its previous value
        // rather than snapping to a fabricated 0.
        const bare = sanitizeTelemetry({ type: 'TELEMETRY' });
        assert.equal(bare.trainHoldSeconds, undefined);
        assert.equal(bare.trainEdges, undefined);
        assert.equal(bare.edgeHoldPercent, undefined);
        for (const junk of ['abc', null, true, {}]) {
            const t2 = sanitizeTelemetry({ type: 'TELEMETRY', trainEdges: junk });
            assert.equal(t2.trainEdges, undefined, `${String(junk)} is not a count`);
        }
    });

    it('the host really sends them, and a remote page never shows its own', () => {
        const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const start = src.indexOf('function syncTelemetry');
        assert.ok(start >= 0, 'syncTelemetry not found in app.js');
        const body = src.slice(start, src.length > start + 2000 ? start + 2000 : src.length);
        for (const field of ['trainHoldSeconds:', 'trainEdges:', 'edgeHoldPercent:']) {
            assert.ok(body.includes(field), `telemetry must carry ${field}`);
        }
        // syncParamsUI runs at boot on a remote page too; writing this
        // browser's persisted values (or the HTML defaults) into the Edge
        // Training card is exactly the display artefact this closes.
        const sync = src.indexOf('const trainHold = document.getElementById(\'trainHoldSecondsInput\');');
        assert.ok(sync >= 0, 'the syncParamsUI writes were not found');
        const syncBody = src.slice(sync, sync + 700);
        assert.ok(/isRemotePage \? '' :/.test(syncBody), 'a remote page must not show its own Edge Training numbers');
    });

    it('carries the host\'s Force Orgasm countdown and why it would refuse to switch it on', () => {
        const t = sanitizeTelemetry({ type: 'TELEMETRY', orgasmSecondsLeft: 61, orgasmRefusal: 'landing' });
        assert.equal(t.orgasmSecondsLeft, 61);
        assert.equal(t.orgasmRefusal, 'landing');
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', orgasmRefusal: '' }).orgasmRefusal, '', 'nothing to refuse is a real answer');
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', orgasmRefusal: 'idle' }).orgasmRefusal, 'idle');
        // Never longer than the longest limit the host offers, never negative.
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', orgasmSecondsLeft: 99999 }).orgasmSecondsLeft, 180);
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', orgasmSecondsLeft: -5 }).orgasmSecondsLeft, 0);
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', orgasmSecondsLeft: '45.4' }).orgasmSecondsLeft, 45);
        // Anything else leaves the partner's page as it was.
        for (const junk of ['abc', null, true, {}]) {
            assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', orgasmSecondsLeft: junk }).orgasmSecondsLeft, undefined, String(junk));
        }
        for (const junk of ['LANDING', 'forcing', 0, false, null, {}]) {
            assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', orgasmRefusal: junk }).orgasmRefusal, undefined, String(junk));
        }
        const bare = sanitizeTelemetry({ type: 'TELEMETRY' });
        assert.equal(bare.orgasmSecondsLeft, undefined);
        assert.equal(bare.orgasmRefusal, undefined);
    });

    it('normalises the watchdog block', () => {
        const t = sanitizeTelemetry({ type: 'TELEMETRY', hrSignal: { status: 'weird', noContact: 1, silentMs: '2500' } });
        assert.deepEqual(t.hrSignal, { status: 'ok', noContact: true, silentMs: 2500 });
        const stale = sanitizeTelemetry({ type: 'TELEMETRY', hrSignal: { status: 'stale' } });
        assert.deepEqual(stale.hrSignal, { status: 'stale', noContact: false, silentMs: 0 });
    });
});

describe('the two pages say which version they speak', () => {
    // After a release the wearer's page and the partner's can run different
    // builds for as long as either tab stays open. 1.0.0's MODE_CHANGE
    // selected a mode and 1.1.0's toggles a game, so the same message did
    // opposite things across them: an old controller's click on the running
    // game turned it off on a new host, and a new controller's "game off"
    // restarted the game on an old host. Neither sent a version.

    // What the builds from before versions put on the wire, verbatim.
    const OLD_SELECT = { type: 'MODE_CHANGE', mode: 'oracle' };               // 1.0.0
    const OLD_TOGGLE = { type: 'MODE_CHANGE', mode: 'oracle', enabled: false }; // 1.1.0

    it('reads a version only when it is a whole number', () => {
        assert.equal(readPeerProtocol(PEER_PROTOCOL_VERSION), PEER_PROTOCOL_VERSION);
        assert.equal(readPeerProtocol(7), 7);
        for (const junk of [undefined, null, '', '2', 2.5, 0, -2, NaN, Infinity, 1e9, true, {}, [], [2]]) {
            assert.equal(readPeerProtocol(junk), undefined, `${JSON.stringify(junk)} is not a version`);
        }
    });

    it('goes up with every mode a host can report: a mode added without a new version fails here', () => {
        // The modes each version's host can be in (ENGINE_MODES). A page on
        // an older version cannot read a mode added after it, so a new mode
        // is a new version, with MODE_CHANGE refused across the two.
        const V2 = ['classic', 'milker', 'shortener', 'headplay', 'ultimate', 'ruin', 'oracle', 'survival', 'edgetrain'];
        const MODES_BY_VERSION = { 2: V2, 3: [...V2, 'script'] };
        assert.ok(MODES_BY_VERSION[PEER_PROTOCOL_VERSION], `no mode list for version ${PEER_PROTOCOL_VERSION}`);
        assert.deepEqual([...ENGINE_MODES], MODES_BY_VERSION[PEER_PROTOCOL_VERSION]);
        assert.ok(VERSIONED_COMMANDS.includes('MODE_CHANGE'));
    });

    it('a message without one is from an older page, never a matching or a newer one', () => {
        assert.equal(peerProtocolMatches(undefined), false);
        assert.equal(peerProtocolRelation(undefined), 'older');
        assert.equal(peerProtocolRelation(PEER_PROTOCOL_VERSION), 'same');
        assert.equal(peerProtocolRelation(PEER_PROTOCOL_VERSION - 1), 'older');
        assert.equal(peerProtocolRelation(PEER_PROTOCOL_VERSION + 1), 'newer');
    });

    it('every message this build sends carries its version, and nothing else changes', () => {
        const command = { type: 'MODE_CHANGE', mode: 'survival', enabled: true };
        const stamped = stampProtocol(command);
        assert.deepEqual(stamped, { ...command, protocol: PEER_PROTOCOL_VERSION });
        assert.equal('protocol' in command, false, 'the caller\'s object is not touched');
        // A page from before versions reads the same message it always did:
        // the type and every field it knows are unchanged, and it drops a
        // field it does not know - which is how both old sanitizers work.
        assert.deepEqual(stampProtocol({ type: 'PING' }), { type: 'PING', protocol: PEER_PROTOCOL_VERSION });
    });

    it('the host sees the version a command carries, or sees that it carries none', () => {
        assert.deepEqual(sanitizeCommand(stampProtocol(OLD_TOGGLE)), { ...OLD_TOGGLE, protocol: PEER_PROTOCOL_VERSION });
        assert.deepEqual(sanitizeCommand(OLD_SELECT), OLD_SELECT, 'no version, no protocol field');
        assert.deepEqual(sanitizeCommand({ type: 'PING', protocol: PEER_PROTOCOL_VERSION }, 'viewer'), { type: 'PING', protocol: PEER_PROTOCOL_VERSION });
        assert.deepEqual(sanitizeCommand({ type: 'SESSION_STATE', status: 'IDLE', protocol: '2' }), { type: 'SESSION_STATE', status: 'IDLE' });
        // A version does not smuggle a command past the other checks.
        assert.equal(sanitizeCommand({ type: 'SET_LIMITS', maxHr: 250, protocol: PEER_PROTOCOL_VERSION }), null);
        assert.equal(sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING', protocol: PEER_PROTOCOL_VERSION }, 'viewer'), null);
    });

    it('the remote page sees the version the host speaks, or sees that it says none', () => {
        assert.equal(sanitizeTelemetry(stampProtocol({ type: 'TELEMETRY', hr: 100 })).protocol, PEER_PROTOCOL_VERSION);
        // Exactly what a 1.1.0 host sends.
        const old = sanitizeTelemetry({ type: 'TELEMETRY', hr: 100, activeMode: 'oracle', teaseMode: 'classic', gameMode: 'oracle' });
        assert.equal(old.protocol, undefined);
        assert.equal(old.gameMode, 'oracle', 'an old host is still rendered');
        for (const junk of ['2', {}, -1, 2.5, null]) {
            assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', protocol: junk }).protocol, undefined);
        }
    });

    it('a mode or game change crosses only between pages on the same version', () => {
        assert.deepEqual(VERSIONED_COMMANDS, ['MODE_CHANGE']);
        assert.equal(peerCommandAllowed(sanitizeCommand(stampProtocol(OLD_TOGGLE)), PEER_PROTOCOL_VERSION), true);
        // The host judges a command by the version it carries...
        for (const raw of [OLD_SELECT, OLD_TOGGLE, { ...OLD_TOGGLE, protocol: PEER_PROTOCOL_VERSION + 1 }, { ...OLD_SELECT, protocol: '2' }]) {
            const cmd = sanitizeCommand(raw);
            assert.equal(peerCommandAllowed(cmd, cmd.protocol), false, `${JSON.stringify(raw)} must be refused`);
        }
        // ...and a controller judges the host by its telemetry. Before the
        // first frame it knows nothing, and nothing is not a match.
        assert.equal(peerCommandAllowed(OLD_TOGGLE, undefined), false);
        assert.equal(peerCommandAllowed(OLD_TOGGLE, PEER_PROTOCOL_VERSION - 1), false);
    });

    it('never refuses transport, Reset, Force Orgasm or a ping over a version', () => {
        // They mean the same in every build, and a partner's STOP must land.
        for (const cmd of [
            { type: 'SESSION_STATE', status: 'IDLE' },
            { type: 'SESSION_STATE', status: 'PAUSED' },
            { type: 'SESSION_STATE', status: 'RUNNING' },
            { type: 'SESSION_RESET' },
            { type: 'ORGASM_TOGGLE' },
            { type: 'PING' }
        ]) {
            for (const protocol of [undefined, PEER_PROTOCOL_VERSION - 1, PEER_PROTOCOL_VERSION, PEER_PROTOCOL_VERSION + 1]) {
                assert.equal(peerCommandAllowed(cmd, protocol), true, `${cmd.type}/${cmd.status || ''} from version ${protocol}`);
            }
        }
        assert.equal(peerCommandAllowed(null, PEER_PROTOCOL_VERSION), false);
        assert.equal(peerCommandAllowed({ mode: 'oracle' }, PEER_PROTOCOL_VERSION), false);
    });

    it('has decided on every command this build sends', () => {
        // Every command app.js puts on the wire is either one whose meaning
        // has changed between versions (VERSIONED_COMMANDS, held back across
        // them) or one that means the same in every build and crosses any
        // version; one added without that decision fails here. The host's
        // telemetry and the remote page's ping are stamped in webrtc.js
        // (webrtc.test.js), like every command.
        const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
        const typeOf = (arg) => {
            const literal = /^\{\s*type:\s*'([A-Z_]+)'/.exec(arg);
            if (literal) return literal[1];
            // The transport's command is built in peer-messages.js, for every
            // status the controller can be showing.
            if (/^transportCommand\(/.test(arg)) {
                const built = new Set([...REMOTE_STATUSES, undefined].map((shown) => transportCommand(shown).type));
                return built.size === 1 ? [...built][0] : null;
            }
            const named = new RegExp(`const ${arg} = \\{\\s*type:\\s*'([A-Z_]+)'`).exec(app);
            return named ? named[1] : null;
        };
        const sends = [...app.matchAll(/sendPeerCommand\(((?:[^()]|\([^()]*\))*)\)/g)].map((m) => m[1].trim());
        assert.ok(sends.length >= 5, `only ${sends.length} commands found`);
        const types = sends.map((arg) => {
            const type = typeOf(arg);
            assert.ok(type, `a command whose type cannot be read: sendPeerCommand(${arg})`);
            return type;
        });
        assert.deepEqual([...new Set(types)].sort(), ['MODE_CHANGE', 'ORGASM_TOGGLE', 'SESSION_RESET', 'SESSION_STATE']);
        for (const type of new Set(types)) {
            const cmd = sanitizeCommand({ type, status: 'IDLE', mode: 'classic' });
            assert.ok(cmd, `${type} is not a command the host accepts`);
            if (VERSIONED_COMMANDS.includes(type)) {
                assert.equal(peerCommandAllowed(cmd, PEER_PROTOCOL_VERSION - 1), false, type);
                assert.equal(peerCommandAllowed(cmd, undefined), false, type);
                continue;
            }
            for (const protocol of [undefined, PEER_PROTOCOL_VERSION - 1, PEER_PROTOCOL_VERSION + 1]) {
                assert.equal(peerCommandAllowed(cmd, protocol), true, `${type} from version ${protocol}`);
            }
        }
        // The mode card asks before it shows a change the host would refuse.
        assert.match(app, /if \(isRemoteController && !hostVersionAllows\(command\)\)/);
    });

    it('tells each person which page is out of date and what a reload costs', () => {
        const older = PEER_PROTOCOL_VERSION - 1;
        const newer = PEER_PROTOCOL_VERSION + 1;
        const texts = {};
        for (const role of ['host', 'controller', 'viewer']) {
            for (const [name, protocol] of [['none', undefined], ['older', older], ['newer', newer]]) {
                const text = describePeerVersionMismatch(role, protocol);
                texts[`${role}/${name}`] = text;
                assert.match(text, /version of EdgeLoop/, `${role}/${name} must say it is about the version`);
                assert.match(text, /[Rr]eload/, `${role}/${name} must say what fixes it`);
            }
            // A page that sent no version is older, never newer.
            assert.equal(texts[`${role}/none`], texts[`${role}/older`]);
        }
        // The wearer's page, facing an older controller: the partner reloads.
        assert.match(texts['host/older'], /older version/);
        assert.match(texts['host/older'], /refuses them from it/);
        assert.match(texts['host/older'], /Ask your partner to reload their page/);
        // Facing a newer one, the wearer's own page is the old one, and its
        // reload ends the session and changes the link.
        assert.match(texts['host/newer'], /newer version/);
        assert.match(texts['host/newer'], /Reload this page between sessions/);
        assert.match(texts['host/newer'], /ends the session here/);
        assert.match(texts['host/newer'], /new link/);
        // The partner's page, facing an older host, does not send them, and
        // names the host's page as the one to reload - between sessions.
        assert.match(texts['controller/older'], /this page does not send them/);
        assert.match(texts['controller/older'], /host's page needs a reload/);
        assert.match(texts['controller/older'], /between sessions/);
        assert.match(texts['controller/newer'], /this page does not send them/);
        assert.match(texts['controller/newer'], /Reload this page to match it/);
        // The two pages that can command say what still works; a viewer
        // commands nothing, so it is not told about commands at all.
        for (const key of ['host/older', 'host/newer', 'controller/older', 'controller/newer']) {
            assert.match(texts[key], /START, PAUSE, STOP, Reset and Force Orgasm still work/);
        }
        const viewerTexts = texts['viewer/older'] + texts['viewer/newer'];
        assert.ok(!/mode and game changes/i.test(viewerTexts), viewerTexts);
        assert.ok(!/STOP/.test(viewerTexts), viewerTexts);
    });
});

describe('a controller RESUME never becomes a START', () => {
    it('the controller asks for a resume, a start or a pause from the status it shows, and says which it showed', () => {
        assert.deepEqual(transportCommand('IDLE'), { type: 'SESSION_STATE', status: 'RUNNING', from: 'IDLE' });
        assert.deepEqual(transportCommand('PAUSED'), { type: 'SESSION_STATE', status: 'RUNNING', from: 'PAUSED' });
        assert.deepEqual(transportCommand('RUNNING'), { type: 'SESSION_STATE', status: 'PAUSED', from: 'RUNNING' });
        assert.deepEqual(transportCommand('RAMPDOWN'), { type: 'SESSION_STATE', status: 'PAUSED', from: 'RAMPDOWN' });
        // A status the page cannot read asks for the direction that stops
        // the motors, as it always did, and claims no state it was pressed in.
        for (const unread of [undefined, null, 'STARTING', '']) {
            assert.deepEqual(transportCommand(unread), { type: 'SESSION_STATE', status: 'PAUSED' }, String(unread));
        }
    });

    it('what the controller sends crosses the wire as it was sent, and never from a viewer', () => {
        for (const shown of [...REMOTE_STATUSES, undefined]) {
            const sent = transportCommand(shown);
            assert.deepEqual(sanitizeCommand(sent), sent, String(shown));
            assert.equal(sanitizeCommand(sent, 'viewer'), null, String(shown));
        }
        // What a marker the host cannot read leaves: the bare command.
        for (const junk of ['true', true, 1, {}, [], null, false]) {
            assert.deepEqual(
                sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING', from: junk }),
                { type: 'SESSION_STATE', status: 'RUNNING' },
                `from: ${JSON.stringify(junk)} says nothing`
            );
        }
    });

    it('a host that stopped meanwhile does not start a session on a late resume', () => {
        // The race: the wearer pressed STOP on a paused session while the
        // partner pressed RESUME. The partner's page still showed PAUSED.
        const late = sanitizeCommand(transportCommand('PAUSED'));
        assert.equal(hostTransportAction(late, 'IDLE'), null);
        // A resume that finds the session paused does resume it.
        assert.equal(hostTransportAction(late, 'PAUSED'), 'resume');
        // Already running again (the wearer resumed first): nothing to do.
        assert.equal(hostTransportAction(late, 'RUNNING'), null);
        assert.equal(hostTransportAction(late, 'RAMPDOWN'), null);
    });

    it('a START still starts, a pause only pauses, and IDLE is STOP', () => {
        const start = sanitizeCommand(transportCommand('IDLE'));
        assert.equal(hostTransportAction(start, 'IDLE'), 'start');
        assert.equal(hostTransportAction(start, 'RUNNING'), null);
        // A START that finds the session paused leaves the wearer's pause
        // alone; one from a page that does not say what it showed resumes it,
        // as it always did.
        assert.equal(hostTransportAction(start, 'PAUSED'), null);
        assert.equal(hostTransportAction(sanitizeCommand({ type: 'SESSION_STATE', status: 'RUNNING' }), 'PAUSED'), 'resume');
        const pause = sanitizeCommand(transportCommand('RUNNING'));
        assert.equal(hostTransportAction(pause, 'RUNNING'), 'pause');
        assert.equal(hostTransportAction(pause, 'RAMPDOWN'), 'pause');
        assert.equal(hostTransportAction(pause, 'PAUSED'), null, 'pressing the transport of a paused host would resume it');
        assert.equal(hostTransportAction(pause, 'IDLE'), null, 'pressing the transport of an idle host would start it');
        const stop = sanitizeCommand({ type: 'SESSION_STATE', status: 'IDLE' });
        for (const status of REMOTE_STATUSES) assert.equal(hostTransportAction(stop, status), 'stop');
    });

    it('nothing that is not a transport command reaches the transport', () => {
        const junks = [null, undefined, 'SESSION_STATE', [], { type: 'SESSION_RESET' }, { type: 'SESSION_STATE', status: 'RAMPDOWN' },
            { type: 'MODE_CHANGE', status: 'RUNNING' }];
        for (const junk of junks) {
            assert.equal(hostTransportAction(junk, 'PAUSED'), null, JSON.stringify(junk));
            assert.equal(hostTransportAction(junk, 'IDLE'), null, JSON.stringify(junk));
        }
    });

    it('an idle host is started only by a page that was showing START, and a paused one resumed only by one showing RESUME', () => {
        // Every status the controller can be showing, against an idle host
        // and a paused one.
        for (const shown of [...REMOTE_STATUSES, undefined]) {
            const command = sanitizeCommand(transportCommand(shown));
            const onIdle = hostTransportAction(command, 'IDLE');
            if (shown === 'IDLE') assert.equal(onIdle, 'start', 'a page showing START may start');
            else assert.equal(onIdle, null, `a page showing ${String(shown)} must not start the host`);
            const onPaused = hostTransportAction(command, 'PAUSED');
            if (shown === 'PAUSED') assert.equal(onPaused, 'resume', 'a page showing RESUME may resume');
            else assert.equal(onPaused, null, `a page showing ${String(shown)} must not resume the host`);
        }
    });
});

describe('the Script phase in telemetry', () => {
    it('carries the host\'s status words and nothing else', () => {
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', scriptPhase: 'SKIPPING: EDGE' }).scriptPhase, 'SKIPPING: EDGE');
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', scriptPhase: 'EASING 64%' }).scriptPhase, 'EASING 64%');
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', scriptPhase: 'REJOINING 5 s (VIDEO HELD)' }).scriptPhase, 'REJOINING 5 s (VIDEO HELD)');
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', scriptPhase: '' }).scriptPhase, '');
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', scriptPhase: '<img src=x>' }).scriptPhase, undefined);
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', scriptPhase: 'A'.repeat(SCRIPT_PHASE_MAX_LENGTH + 1) }).scriptPhase, undefined);
        assert.equal(sanitizeTelemetry({ type: 'TELEMETRY', scriptPhase: 42 }).scriptPhase, undefined);
        assert.equal(readScriptPhase('a\nb'), undefined);
    });
});
