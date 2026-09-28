import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { speakPrompt, speakNow, cancelSpeech, speechHooks, setSpeechObserver, listSpeechVoices } from './voice.js';

describe('spoken cues call speechSynthesis', () => {
    let spoken;
    let orig;

    beforeEach(() => {
        spoken = [];
        orig = { getSynth: speechHooks.getSynth, UtteranceCtor: speechHooks.UtteranceCtor };
        class FakeUtterance {
            constructor(text) {
                this.text = text;
            }
        }
        const synth = {
            speak(utterance) {
                spoken.push(utterance.text);
                if (typeof utterance.onend === 'function') queueMicrotask(() => utterance.onend());
            },
            cancel() {},
            getVoices() { return []; }
        };
        speechHooks.getSynth = () => synth;
        speechHooks.UtteranceCtor = () => FakeUtterance;
    });

    afterEach(() => {
        cancelSpeech();
        speechHooks.getSynth = orig.getSynth;
        speechHooks.UtteranceCtor = orig.UtteranceCtor;
    });

    it('speakPrompt speaks the cue when enabled', () => {
        speakPrompt(true, 'Session started. Breathe.');
        assert.deepEqual(spoken, ['Session started. Breathe.']);
    });

    it('speakPrompt stays silent when disabled or empty', () => {
        speakPrompt(false, 'Nope.');
        speakPrompt(true, '');
        assert.deepEqual(spoken, []);
    });

    it('speakNow jumps the queue and still speaks', async () => {
        speakPrompt(true, 'one');
        speakNow('Heart rate signal lost. Motors stopped.');
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.ok(spoken.includes('Heart rate signal lost. Motors stopped.'));
    });
});

// What the browser does with a cue is reported, never swallowed. A forum user
// heard Preview and then sat through a silent session with nothing on screen
// saying why: every error simply moved the queue on.
describe('what the browser does with a cue reaches the app', () => {
    let events;
    let orig;

    class FakeUtterance {
        constructor(text) {
            this.text = text;
            this.voice = null;
        }
    }

    // A speech engine the test drives by hand: it records every utterance
    // and fires nothing unless told to (onSpeak), like a real engine that
    // answers later.
    function useEngine({ voices = [], onSpeak = null } = {}) {
        const engine = {
            voices,
            spoken: [],
            cancels: 0,
            speak(utterance) {
                engine.spoken.push(utterance);
                if (onSpeak) onSpeak(utterance, engine);
            },
            cancel() { engine.cancels += 1; },
            getVoices() { return engine.voices; }
        };
        speechHooks.getSynth = () => engine;
        speechHooks.UtteranceCtor = () => FakeUtterance;
        return engine;
    }

    const failures = () => events.filter((e) => e.type === 'failed');
    const texts = (engine) => engine.spoken.map((u) => u.text);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    beforeEach(() => {
        events = [];
        orig = { getSynth: speechHooks.getSynth, UtteranceCtor: speechHooks.UtteranceCtor };
        setSpeechObserver((event) => events.push(event));
    });

    afterEach(() => {
        cancelSpeech();
        setSpeechObserver(null);
        speechHooks.getSynth = orig.getSynth;
        speechHooks.UtteranceCtor = orig.UtteranceCtor;
    });

    it('a refused cue is reported in words, and the queue still moves on', () => {
        const engine = useEngine({ voices: [{ voiceURI: 'a' }] });
        speakPrompt(true, 'one');
        speakPrompt(true, 'two');
        speakPrompt(true, 'three');
        assert.deepEqual(texts(engine), ['one'], 'one cue at a time');
        engine.spoken[0].onerror({ error: 'synthesis-failed' });
        assert.deepEqual(texts(engine), ['one', 'two'], 'the failure must not stall the cues behind it');
        assert.equal(failures().length, 1);
        assert.equal(failures()[0].kind, 'synthesis-failed');
        assert.match(failures()[0].message, /speech engine could not speak/);
    });

    it("Chrome's not-allowed arrives inside speak() and every queued cue still gets its turn", () => {
        // Blink fires the not-allowed error synchronously from speak() when
        // the page has had no user activation yet.
        const engine = useEngine({
            voices: [{ voiceURI: 'a' }],
            onSpeak: (u) => u.onerror({ error: 'not-allowed' })
        });
        speakPrompt(true, 'one');
        speakPrompt(true, 'two');
        assert.deepEqual(texts(engine), ['one', 'two']);
        assert.deepEqual(failures().map((f) => f.kind), ['not-allowed', 'not-allowed']);
        assert.match(failures()[0].message, /Tap anywhere on EdgeLoop/);
    });

    it('a cue this page cut short is not a failure, and neither is a late error from it', async () => {
        const engine = useEngine({ voices: [{ voiceURI: 'a' }] });
        speakPrompt(true, 'Stay right on the edge.');
        const cut = engine.spoken[0];
        speakNow('Heart rate signal lost. Motors stopped.');
        cut.onerror({ error: 'interrupted' });
        cut.onerror({ error: 'synthesis-failed' });
        await wait(80);
        assert.equal(engine.cancels, 1);
        assert.deepEqual(texts(engine), ['Stay right on the edge.', 'Heart rate signal lost. Motors stopped.']);
        assert.deepEqual(failures(), [], 'cancelling a cue must never read as a broken voice');
        engine.spoken[1].onstart();
        assert.deepEqual(events, [{ type: 'started' }]);
    });

    it('STOP silences a cue without reporting it', () => {
        const engine = useEngine({ voices: [{ voiceURI: 'a' }] });
        speakPrompt(true, 'Edge. Back off.');
        cancelSpeech();
        engine.spoken[0].onerror({ error: 'canceled' });
        engine.spoken[0].onerror({ error: 'audio-busy' });
        assert.deepEqual(failures(), []);
    });

    it('reports when a cue is really being spoken', () => {
        const engine = useEngine({ voices: [{ voiceURI: 'a' }] });
        speakPrompt(true, 'Session started. Breathe.');
        engine.spoken[0].onstart();
        assert.deepEqual(events, [{ type: 'started' }]);
    });

    it('a failure with no voice listed is reported as no usable voice', () => {
        const engine = useEngine({ voices: [] });
        speakPrompt(true, 'Session started. Breathe.');
        engine.spoken[0].onerror({ error: 'synthesis-failed' });
        assert.equal(failures()[0].kind, 'no-voice');
    });

    it('a saved voice this browser does not list speaks in the default voice and is reported', () => {
        const zira = { voiceURI: 'Microsoft Zira', name: 'Zira', lang: 'en-US' };
        const david = { voiceURI: 'Microsoft David', name: 'David', lang: 'en-US' };
        const engine = useEngine({ voices: [zira, david] });
        speakPrompt(true, 'one', 'com.apple.voice.compact.en-US.Samantha');
        assert.equal(engine.spoken.length, 1, 'a missing voice is never a reason to say nothing');
        assert.equal(engine.spoken[0].voice, null, 'no voice set: the browser default speaks');
        assert.deepEqual(events, [{ type: 'voice-missing', voiceURI: 'com.apple.voice.compact.en-US.Samantha' }]);

        engine.spoken[0].onend();
        events.length = 0;
        speakPrompt(true, 'two', 'Microsoft David');
        assert.equal(engine.spoken[1].voice, david, 'a listed voice is used');
        assert.deepEqual(events, []);
    });

    it('voices that have not loaded yet are not called missing, and are used once they load', () => {
        // Chrome answers getVoices() with an empty list until it has loaded
        // them, then fires voiceschanged.
        const david = { voiceURI: 'Microsoft David', name: 'David', lang: 'en-US' };
        const engine = useEngine({ voices: [] });
        speakPrompt(true, 'one', 'Microsoft David');
        assert.equal(engine.spoken[0].voice, null);
        assert.deepEqual(events, [], 'an empty list proves nothing about the saved voice');

        engine.spoken[0].onend();
        engine.voices = [david];
        speakPrompt(true, 'two', 'Microsoft David');
        assert.equal(engine.spoken[1].voice, david);
        assert.deepEqual(events, []);
    });

    it('a browser with no speech synthesis says so instead of staying silent', () => {
        speechHooks.getSynth = () => null;
        speakPrompt(false, 'Voice off: nothing to report.');
        assert.deepEqual(events, [], 'a cue the switch did not ask for is not a failure');
        speakPrompt(true, 'Session started. Breathe.');
        speakNow('EdgeLoop voice preview.');
        assert.deepEqual(failures().map((f) => f.kind), ['unsupported', 'unsupported']);
        assert.match(failures()[0].message, /no text-to-speech support/);
    });

    it('a missing utterance constructor empties the queue instead of wedging it', () => {
        const engine = useEngine({ voices: [{ voiceURI: 'a' }] });
        speechHooks.UtteranceCtor = () => null;
        speakPrompt(true, 'one');
        assert.equal(failures()[0].kind, 'unsupported');
        speechHooks.UtteranceCtor = () => FakeUtterance;
        speakPrompt(true, 'two');
        assert.deepEqual(texts(engine), ['two'], 'the stuck cue used to block every later one');
    });

    it('speak() throwing is reported and the next cue is still spoken', () => {
        const engine = useEngine({ voices: [{ voiceURI: 'a' }] });
        engine.speak = (u) => {
            if (u.text === 'bad') throw new TypeError('not an utterance');
            engine.spoken.push(u);
        };
        speakPrompt(true, 'bad');
        speakPrompt(true, 'good');
        assert.equal(failures().length, 1);
        assert.deepEqual(texts(engine), ['good']);
    });

    it('an engine whose voice list throws still speaks, in the default voice', () => {
        const engine = useEngine({ voices: [{ voiceURI: 'a' }] });
        engine.getVoices = () => { throw new Error('engine not ready'); };
        assert.deepEqual(listSpeechVoices(), []);
        speakPrompt(true, 'one', 'Microsoft David');
        speakPrompt(true, 'two', 'Microsoft David');
        assert.deepEqual(texts(engine), ['one'], 'the cue is spoken, not lost');
        assert.equal(engine.spoken[0].voice, null);
        engine.spoken[0].onerror({ error: 'synthesis-failed' });
        assert.deepEqual(texts(engine), ['one', 'two'], 'and the queue behind it moves on');
        assert.equal(failures()[0].kind, 'no-voice', 'an unreadable list offers no voice to pick');
    });

    it('an observer that throws cannot stall the cues', () => {
        const engine = useEngine({ voices: [{ voiceURI: 'a' }] });
        setSpeechObserver(() => { throw new Error('observer bug'); });
        speakPrompt(true, 'one');
        speakPrompt(true, 'two');
        assert.doesNotThrow(() => engine.spoken[0].onerror({ error: 'synthesis-failed' }));
        assert.deepEqual(texts(engine), ['one', 'two']);
    });
});
