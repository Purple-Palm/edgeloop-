// What app.js must keep doing with the player, read off its source the way
// the other wiring guards in this repository are: every stop path pauses
// the video, a play from the video's own controls is only ever a press of
// the transport's own button, and nothing about the files is stored.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRIVACY_LINE } from './player-rules.js';

const APP = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
const PLAYER = readFileSync(new URL('./player.js', import.meta.url), 'utf8');

function body(anchor, end = '\n}') {
    const at = APP.indexOf(anchor);
    assert.ok(at >= 0, `${anchor} is gone - rework this guard with it`);
    return APP.slice(at, APP.indexOf(end, at));
}

describe('app.js: the video follows the session', () => {
    it('every forced stop pauses the video', () => {
        const dispatch = body('function dispatchHardware(');
        const admitAt = dispatch.indexOf('tickDispatch.admit(');
        const videoAt = dispatch.indexOf('if (force) pauseVideoWithToys();');
        const returnAt = dispatch.indexOf('if (!release) return;');
        assert.ok(admitAt >= 0 && videoAt >= 0 && videoAt < admitAt && returnAt > admitAt, 'every forced dispatch must pause the video, even one the tick does not send again');
        // PAUSE, STOP and Reset each send that forced stop with the session
        // already out of RUNNING, so the video is paused, not played.
        assert.match(body('function pauseVideoWithToys('), /if \(scriptCoupled\(\) && !sessionDriving\(\)\) player\.pause\(\);/);
        assert.ok(!body('function pauseVideoWithToys(').includes('play('), 'a stop never plays the video');
        assert.match(body('function pauseSession('), /state\.sessionStatus = 'PAUSED';[\s\S]*dispatchHardware\(0, 0, 0, 100, true\);/);
        assert.match(body('function stopSession('), /state\.sessionStatus = 'IDLE';[\s\S]*dispatchHardware\(0, 0, 0, 100, true\);/);
        assert.match(body("resetBtn?.addEventListener('click'", '\n});'), /state\.sessionStatus = 'IDLE';[\s\S]*dispatchHardware\(0, 0, 0, 100, true\);/);
    });

    it('PAUSE, STOP and Reset pause a video playing in the player in any mode, Script mode left mid-session included', () => {
        assert.match(body('function pauseVideoWithSession('), /if \(player && player\.isPlaying\(\)\) player\.pause\(\);/);
        assert.match(body('function pauseSession('), /dispatchHardware\(0, 0, 0, 100, true\);\s*pauseVideoWithSession\(\);/);
        assert.match(body('function stopSession('), /\} finally \{\s*resetSessionCounters\(\);\s*pauseVideoWithSession\(\);/);
        assert.match(body("resetBtn?.addEventListener('click'", '\n});'), /dispatchHardware\(0, 0, 0, 100, true\);\s*pauseVideoWithSession\(\);/);
    });

    it('the video\'s own pause, a long buffering stall and a media error each pause the session', () => {
        // (a) A pause by the video's own controls (a media key, iOS's
        // native fullscreen, a headset's bar) is a session PAUSE.
        assert.match(APP, /\n {12}onPauseRequest: pauseFromVideo,\n/);
        assert.match(body('function pauseFromVideo('), /if \(pauseSession\('Paused\.'\)\) \{/);
        assert.match(PLAYER, /if \(video\.paused && decide\('pause'\) === 'pause-session'\) call\(handlers, 'onPauseRequest'\);/);
        // (b) A buffering stall over 30 s, while the session drives.
        assert.match(body('onStall: (seconds) => {', '\n            },'), /if \(scriptCoupled\(\) && sessionDriving\(\)\) triggerDisconnectAlert\(describeVideoStall\(seconds\), 'video'\);/);
        // (c) A media error under a live session.
        assert.match(body('onMediaError: (message) => {', '\n            },'), /if \(scriptCoupled\(\) && sessionIsLive\(\)\) triggerDisconnectAlert\(`\$\{message\} Every toy was stopped and the session paused\.`, 'video'\);/);
        // The alert is the pause.
        assert.match(body('function triggerDisconnectAlert('), /if \(pauseSession\(null\)\) syncTelemetry\(\);/);
    });

    it('the phase reads what the toys do while the video buffers, not FREE', () => {
        assert.match(body('function scriptPhaseText('), /videoState: scriptFeed \? scriptFeed\.videoState\(\) : '',/);
        assert.match(body('function scriptPhaseText('), /return scriptPhaseLabel\(\{/);
    });

    it('START and RESUME play it only once the session runs', () => {
        const start = body('function startOrResumeSession(');
        assert.ok(start.indexOf('syncVideoToSession()') > start.indexOf("state.sessionStatus = resumingRampdown ? 'RAMPDOWN' : 'RUNNING';"));
        assert.match(start, /if \(state\.activeMode === 'script'\) state\.scriptReleasedAt = state\.sessionSeconds;/);
    });

    it('a play from the video\'s own controls presses the transport\'s own button and nothing else', () => {
        const fn = body('function startFromVideo(');
        assert.match(fn, /playPauseBtn\.click\(\)/);
        assert.ok(!fn.includes('startOrResumeWhenReady'), 'it must go through the button, with its RESUME hold');
        assert.ok(!fn.includes('startOrResumeSession'));
    });

    it('the video is never routed through Web Audio', () => {
        const player = readFileSync(new URL('./player.js', import.meta.url), 'utf8');
        assert.ok(!/createMediaElementSource|AudioContext/.test(player + body('// ---- The player (player/player.js)', '// What a live session is driving right now')));
    });

    it('the stall guard reads the Script edge action in Script mode', () => {
        assert.match(body('function tickSessionGuardsAndGames('), /ceilingBehaviour: effectiveCeilingBehaviour\(\)/);
    });

    it('a Travel Envelope or end margin changed mid-session reaches beat sync at once', () => {
        assert.match(body('function putHwEnvelope('), /syncHandyHspWindow\(\);\s*updateEngine\(\);/);
        assert.match(body('function putHandyEndMargin('), /syncHandyHspWindow\(\);\s*updateEngine\(\);/);
        assert.match(body('function syncHandyHspWindow('), /handyHsp\.setWindow\(handyHspWindow\(\)\)/);
        assert.match(body('function routeTheHandy('), /if \(!force\) syncHandyHspWindow\(\);\s*handyHsp\.dispatch\(/);
        assert.match(body('function startOrResumeWhenReady('), /handyHsp\.prepare\(handyHspWindow\(\)\)/);
    });

    it('a Handy that cannot beat sync plays the rhythm its route line promises', () => {
        assert.match(body('function handyBeatSyncWanted('), /&& handyHsp\.beatSync\(\)\s*&& !handyHsp\.unavailable\(\);/);
        const line = body('function handyRouteLine(');
        assert.ok(line.indexOf('handyHsp.unavailable()') >= 0 && line.indexOf('handyHsp.unavailable()') < line.indexOf("beatSyncCheck.state === 'ok'"));
        assert.match(line, /if \(impossible\) return describeHandyRoute\(\{ route: 'rhythm', reason: impossible\.reason \}\);/);
        assert.match(line, /if \(beatSyncCheck\.state === 'refused'\) return describeBeatSyncCheckFailed\(/);
    });

    it('the speed-limit lines use each toy\'s own limit, the numbers the shaper applies', () => {
        assert.match(body('function renderScriptSummary('), /toys: scriptStrokeToys\(\),/);
        assert.match(body('function renderPlayerControls('), /renderScriptSummary\(\);/);
        const toys = body('function scriptStrokeToys(');
        assert.match(toys, /ceiling: handySpeedCeiling\(handyHsp\.deviceLimits\(\)\), cap: state\.handyMaxCap \?\? 100, span: stroke\.max - stroke\.min/);
        assert.match(toys, /ceiling: DEVICE_CEILINGS\[axis\.holds \? 'ossm' : 'intiface'\], cap: axis\.maxCap \?\? 100/);
        assert.match(toys, /ceiling: DEVICE_CEILINGS\.tcode, cap: axis\.maxCap \?\? 100/);
        assert.match(body('function paintMaxSpeedHint('), /describeMaxSpeedHint\(\{ maxSpeed: value, travelMm: limits\.travelMm, maxSpeedMmS: limits\.maxSpeedMmS \}\)/);
    });

    it('the page-away stop includes beat sync', () => {
        assert.match(body('function stopEveryToyOnPageAway('), /handyHsp\?\.stopOnUnload\(\)/);
    });
});

describe('app.js: the Script-mode rules', () => {
    it('a hidden page with a silent video pauses the session, on the tick and the moment the page hides', () => {
        assert.match(body('function pauseIfHiddenAndSilent('), /hiddenSilentPause\(\{[\s\S]*\}\);\s*if \(!pause\) return false;\s*triggerDisconnectAlert\(describeHiddenSilent\(\), 'video'\);/);
        assert.match(body('function masterClockTick('), /if \(document\.visibilityState === 'hidden'\) pauseIfHiddenAndSilent\(\);/);
        assert.match(APP, /if \(document\.visibilityState === 'hidden'\) \{\s*supervisionClock\.noteHidden\(\);[^}]*pauseIfHiddenAndSilent\(\);\s*return;\s*\}/);
    });

    it('the video\'s end stops a live session ("Video ended")', () => {
        const ended = body('onEnded: () => {', '\n            },');
        assert.match(ended, /if \(sessionIsLive\(\)\) stopSession\('Video ended'\);/);
    });

    it('the files cannot change under a live Script-mode session', () => {
        const can = body('canChangeFiles: () =>', '\n            onScript');
        assert.match(can, /^canChangeFiles: \(\) => \(scriptCoupled\(\) && sessionIsLive\(\)\s*\? 'Press STOP before changing the files/);
    });

    it('Script mode needs a script loaded here, and takes no game card', () => {
        const select = body('function applyModeSelection(');
        assert.match(select, /if \(mode === 'script' && !\(scriptLoaded\(\) && !isRemotePage\)\) return false;/);
        assert.match(select, /if \(GAME_CARD_MODES\.includes\(mode\) && state\.teaseMode === 'script' && enabled !== false\) \{\s*renderGamesForScript\(\);\s*return false;\s*\}/);
        assert.match(select, /if \(mode === 'script' && state\.gameMode\) \{\s*state\.gameMode = null;/);
        // Both refusals come before anything the selection changes.
        const firstWrite = select.search(/state\.\w+ = /);
        assert.ok(select.indexOf("mode === 'script' && !(scriptLoaded()") < firstWrite);
        assert.ok(select.indexOf('renderGamesForScript();') < firstWrite);
    });

    it('START waits for a valid script and a video that can show a frame', () => {
        const waiting = body('function transportWaitingReason(');
        assert.match(waiting, /const scriptReason = currentScriptWaitingReason\(\);\s*if \(scriptReason\) return scriptReason;/);
        assert.ok(waiting.indexOf('if (scriptReason) return scriptReason;') < waiting.lastIndexOf('return null;'));
    });

    it('edge action Pause video holds the video while the edge is up', () => {
        const edge = body('function followEdgeWithVideo(');
        assert.match(edge, /edgeActionPausesVideo\(advancedSettings\.scriptEdgeAction\)/);
        assert.match(edge, /if \(holds\) \{\s*if \(player\.isPlaying\(\)\) player\.holdForEdge\(\);\s*\}/);
    });
});

describe('app.js: nothing about the files is kept', () => {
    it('History keeps the mode, the hash and the length of a script, and no name', () => {
        const save = body('function saveSessionToHistory(');
        assert.match(save, /mode: 'Script', script: \{ hash: loadedScript\.hash \|\| null, lengthMs: loadedScript\.meta\.durationMs \}/);
        assert.ok(!/\.name\b/.test(save));
    });

    it('only the offsets, keyed by hash, are written for a script', () => {
        assert.match(body('function rememberScriptOffset('), /rememberOffset\(storedScriptOffsets\(\), loadedScript\.hash, ms, Date\.now\(\)\)/);
    });

    it('writes nothing to storage but the keys it always has, and the player writes nothing at all', () => {
        // A new key here is a new thing kept on the wearer's disk: check
        // that it holds no file name, title or script content, then add it.
        const KEYS = [
            "'edgeloop_age_verified'", "'edgeloop_wizard_seen'", "'handy_max_cap'", "'handy_role'",
            'SCRIPT_OFFSETS_STORAGE_KEY', 'BEAT_SYNC_STORAGE_KEY', 'HANDY_APP_ID_STORAGE_KEY', 'BEAT_SYNC_CONSENT_KEY',
            "'edgeloop_advanced_settings'", "'handy_connection_key'", 'VACUGLIDE_TOKEN_STORAGE_KEY',
            'INTIFACE_STORAGE_KEY', 'TCODE_STORAGE_KEY'
        ];
        const written = [...APP.matchAll(/\bsafeSet\(\s*([^,]+?)\s*,/g)].map((m) => m[1]);
        assert.ok(written.length > 0);
        for (const key of written) assert.ok(KEYS.includes(key), `app.js writes ${key}`);
        assert.ok(!/\blocalStorage\.setItem\(|\bsessionStorage\.setItem\(/.test(APP));
        assert.ok(!/_picked\(/.test(APP), 'app.js never reads the picked files');
        const player = readFileSync(new URL('./player.js', import.meta.url), 'utf8');
        assert.ok(!/safeSet|localStorage|sessionStorage|indexedDB|durable/i.test(player), 'player.js keeps nothing');
    });
});

describe('index.html: the player', () => {
    it('plays a plain <video> with its native controls off', () => {
        const tag = INDEX.slice(INDEX.indexOf('<video id="playerVideo"'), INDEX.indexOf('</video>'));
        assert.ok(tag.length > 0);
        assert.ok(!/\scontrols[\s>=]/.test(tag), 'native controls would let a click resume it behind the session');
        assert.match(tag, /playsinline/);
    });

    it('the HUD has a PAUSE and a STOP at least 64 px square', () => {
        for (const id of ['hudPauseBtn', 'hudStopBtn']) {
            const at = INDEX.indexOf(`id="${id}"`);
            assert.ok(at >= 0);
            assert.match(INDEX.slice(at, INDEX.indexOf('>', at)), /min-w-\[64px\] min-h-\[64px\]/);
        }
    });

    it('with the player open, the transport is the fixed bottom bar at every width', () => {
        // The bar holds PAUSE and STOP.
        const at = INDEX.indexOf('id="transportBar"');
        assert.ok(at >= 0);
        const bar = INDEX.slice(at, INDEX.indexOf('id="sessionResetBtn"', at));
        assert.ok(bar.includes('id="sessionPlayPauseBtn"') && bar.includes('id="sessionStopBtn"'));
        // Below the two-column width it is fixed anyway; above it, while the
        // player is open.
        assert.match(INDEX.slice(at, INDEX.indexOf('>', at)), /max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0/);
        const media = INDEX.slice(INDEX.indexOf('@media (min-width: 1024px) {'), INDEX.indexOf('</style>'));
        assert.match(media, /html\[data-player-open="on"\] #transportBar \{\s*position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;/);
        assert.match(media, /html\[data-player-open="on"\] body \{ padding-bottom: 6rem; \}/);
        assert.match(body('function setPlayerOpen('), /document\.documentElement\.dataset\.playerOpen = open \? 'on' : 'off';/);
    });

    it('says what stays on the device, and not that the heart rate never leaves it', () => {
        assert.match(INDEX, /Your video and script stay on this device\. EdgeLoop uploads neither\./);
        const at = INDEX.indexOf('<p id="playerPrivacy"');
        const text = INDEX.slice(INDEX.indexOf('>', at) + 1, INDEX.indexOf('</p>', at));
        assert.equal(text, PRIVACY_LINE);
        assert.doesNotMatch(README, /the video, the script and your heart rate stay on this device/);
    });

    it('the new controls are at least 44 px to touch', () => {
        const tag = (id) => {
            const at = INDEX.indexOf(`id="${id}"`);
            assert.ok(at >= 0, id);
            return INDEX.slice(INDEX.lastIndexOf('<', at), INDEX.indexOf('>', at));
        };
        assert.match(tag('playerHeaderBtn'), /min-h-\[44px\] min-w-\[44px\]/);
        // The header buttons beside it are as tall, so the row stays even.
        for (const id of ['guideBtn', 'historyBtn', 'sessionParamsHeaderBtn', 'partnerShareBtn']) {
            assert.match(tag(id), /min-h-\[44px\]/, id);
        }
        assert.match(tag('playerToggleBtn'), /min-h-\[44px\]/);
        assert.match(tag('playerSeek'), /\bh-11\b/);
        assert.match(tag('playerPackSelect'), /min-h-\[44px\]/);
        assert.match(INDEX, /<label for="beatSyncToggle" class="[^"]*min-h-\[44px\]/);
        for (const id of ['playerPlayBtn', 'playerMuteBtn', 'playerOffsetMinus', 'playerOffsetPlus', 'playerTheaterBtn', 'playerFullscreenBtn', 'playerChooseBtn', 'playerClearBtn']) {
            assert.match(tag(id), /min-h-\[2\.75rem\]/, id);
        }
    });

    it('the README says what an iPhone shows: no Fullscreen button, Theater instead', () => {
        assert.match(PLAYER, /if \(els\.fullscreenBtn && !canFullscreen\(\)\) els\.fullscreenBtn\.classList\?\.add\('hidden'\);/);
        assert.doesNotMatch(README, /Fullscreen opens Theater instead/);
        assert.match(README, /On an iPhone, where only the video itself can go fullscreen, there is no Fullscreen button: use Theater, which fills the screen with the same HUD\./);
    });
});
