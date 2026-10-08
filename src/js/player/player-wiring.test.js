// What app.js must keep doing with the player, read off its source the way
// the other wiring guards in this repository are: every stop path pauses
// the video, a play from the video's own controls is only ever a press of
// the transport's own button, and nothing about the files is stored.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');

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

    it('the page-away stop includes beat sync', () => {
        assert.match(body('function stopEveryToyOnPageAway('), /handyHsp\?\.stopOnUnload\(\)/);
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

    it('says what stays on the device', () => {
        assert.match(INDEX, /Your video and script stay on this device\. EdgeLoop uploads neither\./);
    });
});
