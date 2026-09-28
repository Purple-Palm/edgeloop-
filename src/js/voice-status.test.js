import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    SPEECH_ERROR_CODES,
    SPEECH_CANCEL_CODES,
    SPEECH_UNSUPPORTED,
    CUE_REPEAT_MS,
    describeSpeechFailure,
    resolveSpeechVoice,
    voiceDisplayName,
    describeMissingVoice,
    createSpeechNotices,
    describeVoiceIndicator,
    describeVoiceStatus,
    planCueDelivery
} from './voice-status.js';
import { DEFAULT_VOICE_CUES, resolveVoiceCue } from './voice-cues.js';

const VOICES = [
    { voiceURI: 'Google US English', name: 'Google US English', lang: 'en-US' },
    { voiceURI: 'Microsoft Zira - English (United States)', name: 'Microsoft Zira', lang: 'en-US' }
];

describe('speech errors are told in plain words', () => {
    it('knows every code the Web Speech API defines', () => {
        assert.deepEqual([...SPEECH_ERROR_CODES].sort(), [
            'audio-busy', 'audio-hardware', 'canceled', 'interrupted', 'invalid-argument',
            'language-unavailable', 'network', 'not-allowed', 'synthesis-failed',
            'synthesis-unavailable', 'text-too-long', 'voice-unavailable'
        ]);
    });

    it('a cue the page cancelled itself is not a failure', () => {
        // speakNow() cancels the cue in progress for every urgent cue, and
        // STOP / Reset / switching the voice off cancel everything: reporting
        // those would say the voice broke each time a safety cue jumped ahead.
        for (const code of SPEECH_CANCEL_CODES) {
            assert.equal(describeSpeechFailure(code, { voiceCount: 3 }), null, code);
            assert.equal(describeSpeechFailure(code, { voiceCount: 0 }), null, code);
        }
    });

    it('every other code is a failure with a sentence of its own, never the raw code', () => {
        for (const code of SPEECH_ERROR_CODES) {
            if (SPEECH_CANCEL_CODES.includes(code)) continue;
            const failure = describeSpeechFailure(code, { voiceCount: 2 });
            assert.ok(failure, code);
            assert.equal(failure.code, code);
            assert.ok(failure.message.startsWith('Voice guidance'), `${code}: ${failure.message}`);
            assert.ok(!failure.message.includes(code), `${code} leaks the raw code: ${failure.message}`);
        }
    });

    it('not-allowed asks for the tap the browser is waiting for', () => {
        // Chrome fires not-allowed from speak() when the page has had no user
        // activation yet; one tap anywhere lets the next cue through.
        const failure = describeSpeechFailure('not-allowed', { voiceCount: 3 });
        assert.equal(failure.kind, 'not-allowed');
        assert.match(failure.message, /Tap anywhere on EdgeLoop/);
        // The cause is named, so an empty voice list does not replace it.
        assert.equal(describeSpeechFailure('not-allowed', { voiceCount: 0 }).kind, 'not-allowed');
    });

    it('synthesis-failed with no voice listed means there is no usable voice', () => {
        // Chromium on a system with no speech engine: getVoices() stays empty
        // and every cue ends in synthesis-failed. "Pick another voice" would
        // send the wearer to an empty list.
        const none = describeSpeechFailure('synthesis-failed', { voiceCount: 0 });
        assert.equal(none.kind, 'no-voice');
        assert.match(none.message, /no working text-to-speech voice/);
        assert.doesNotMatch(none.message, /Pick another voice/);

        const some = describeSpeechFailure('synthesis-failed', { voiceCount: 4 });
        assert.equal(some.kind, 'synthesis-failed');
        assert.match(some.message, /Pick another voice/);

        assert.equal(describeSpeechFailure('synthesis-unavailable', { voiceCount: 4 }).kind, 'no-voice');
    });

    it('an error with no code (how Firefox reports every one) is still a failure', () => {
        const withVoices = describeSpeechFailure(undefined, { voiceCount: 3 });
        assert.equal(withVoices.kind, 'failed');
        assert.match(withVoices.message, /gave no reason/);
        assert.equal(describeSpeechFailure(undefined, { voiceCount: 0 }).kind, 'no-voice');
        assert.equal(describeSpeechFailure('', {}).kind, 'failed');
        assert.equal(describeSpeechFailure('some-future-code', { voiceCount: 1 }).kind, 'failed');
    });

    it('a browser without speech synthesis is explained too', () => {
        const failure = describeSpeechFailure(SPEECH_UNSUPPORTED, { voiceCount: 0 });
        assert.equal(failure.kind, SPEECH_UNSUPPORTED);
        assert.match(failure.message, /no text-to-speech support/);
    });
});

describe('choosing the voice for a cue', () => {
    it('uses the saved voice when the browser lists it', () => {
        const choice = resolveSpeechVoice(VOICES, 'Microsoft Zira - English (United States)');
        assert.equal(choice.status, 'matched');
        assert.equal(choice.voice, VOICES[1]);
    });

    it('falls back to the default voice, never to silence, when the saved one is missing', () => {
        const choice = resolveSpeechVoice(VOICES, 'com.apple.voice.compact.en-US.Samantha');
        assert.equal(choice.status, 'missing');
        assert.equal(choice.voice, null, 'no voice set means the browser default speaks');
    });

    it('an empty list proves nothing yet: Chrome lists no voice until it has loaded them', () => {
        const choice = resolveSpeechVoice([], 'Google US English');
        assert.equal(choice.status, 'pending', 'must not be reported as missing');
        assert.equal(choice.voice, null);
    });

    it('no saved voice is the browser default, and junk input is harmless', () => {
        assert.deepEqual(resolveSpeechVoice(VOICES, ''), { voice: null, status: 'default' });
        assert.deepEqual(resolveSpeechVoice(null, undefined), { voice: null, status: 'default' });
        assert.equal(resolveSpeechVoice([null, undefined, VOICES[0]], 'Google US English').voice, VOICES[0]);
        assert.equal(resolveSpeechVoice('not a list', 'x').status, 'pending');
    });

    it('names a saved voice back in a readable length', () => {
        assert.equal(voiceDisplayName('Google US English'), 'Google US English');
        const long = voiceDisplayName('x'.repeat(200));
        assert.equal(long.length, 80);
        assert.ok(long.endsWith('…'));
        assert.equal(voiceDisplayName(null), '');
        assert.match(describeMissingVoice('Microsoft Zira'), /"Microsoft Zira" is not available in this browser/);
        assert.match(describeMissingVoice('Microsoft Zira'), /default voice/);
    });
});

describe('a notice is told once, not once per cue', () => {
    it('each kind once per session, again after a fresh START', () => {
        const notices = createSpeechNotices();
        assert.equal(notices.take('not-allowed'), true);
        assert.equal(notices.take('not-allowed'), false, 'a voice that fails, fails every cue');
        assert.equal(notices.take('no-voice'), true, 'a different problem is still told');
        notices.newSession();
        assert.equal(notices.take('not-allowed'), true, 'the next session tells it once more');
        assert.equal(notices.take('not-allowed'), false);
    });

    it('a missing saved voice is told once for the page', () => {
        const notices = createSpeechNotices();
        assert.equal(notices.take('voice-missing'), true);
        notices.newSession();
        assert.equal(notices.take('voice-missing'), false, 'the voice does not appear between sessions');
    });

    it('refuses a kind that is not a word', () => {
        const notices = createSpeechNotices();
        assert.equal(notices.take(''), false);
        assert.equal(notices.take(undefined), false);
    });
});

describe('the dashboard label says what the voice is doing', () => {
    it('off, on, or failed', () => {
        assert.deepEqual(describeVoiceIndicator({ enabled: false }), { text: 'Voice off', tone: 'off' });
        assert.deepEqual(describeVoiceIndicator({ enabled: true }), { text: 'Voice on', tone: 'on' });
        assert.deepEqual(describeVoiceIndicator({ enabled: true, failing: true }), { text: 'Voice failed', tone: 'warn' });
        // A failure seen during a preview with the switch off is not a
        // session voice failing: the switch decides what the label says.
        assert.deepEqual(describeVoiceIndicator({ enabled: false, failing: true }), { text: 'Voice off', tone: 'off' });
        assert.deepEqual(describeVoiceIndicator(), { text: 'Voice off', tone: 'off' });
    });
});

describe('the note under Preview', () => {
    const problem = describeSpeechFailure('synthesis-failed', { voiceCount: 0 });

    it('says nothing when there is nothing to say', () => {
        assert.equal(describeVoiceStatus({ enabled: true, voices: VOICES, voiceURI: 'Google US English' }), null);
        assert.equal(describeVoiceStatus(), null);
    });

    it('explains a failure first', () => {
        const status = describeVoiceStatus({ enabled: true, problem, voices: [] });
        assert.equal(status.tone, 'warn');
        assert.equal(status.text, problem.message);
    });

    it('names a saved voice this browser does not have, only once the list is known', () => {
        const missing = describeVoiceStatus({ enabled: true, voiceURI: 'Karen', voices: VOICES });
        assert.equal(missing.tone, 'warn');
        assert.match(missing.text, /"Karen" is not available/);
        assert.equal(
            describeVoiceStatus({ enabled: true, voiceURI: 'Karen', voices: [] }),
            null,
            'an empty list may still be loading: no false claim'
        );
        const both = describeVoiceStatus({ enabled: true, problem, voiceURI: 'Karen', voices: VOICES });
        assert.ok(both.text.startsWith(problem.message));
        assert.match(both.text, /"Karen" is not available/);
    });

    it('a preview heard with the voice off says the session will be silent', () => {
        // The forum report: switch flipped, Preview heard, the panel closed
        // with the X, and a silent session.
        const off = describeVoiceStatus({ enabled: false, previewedWhileOff: true });
        assert.equal(off.tone, 'info');
        assert.match(off.text, /only a preview/);
        assert.match(off.text, /Spoken Voice Guidance is off/);
        assert.equal(describeVoiceStatus({ enabled: true, previewedWhileOff: true }), null);
    });
});

describe('every cue reaches the dashboard, whether or not the voice is on', () => {
    it('with the voice off a cue is painted and not spoken', () => {
        assert.deepEqual(planCueDelivery({ text: 'Edge. Back off.', voiceEnabled: false, now: 1000 }), { paint: true, speak: 'none' });
    });

    it('with the voice on it is painted and spoken; an urgent cue cuts the queue', () => {
        assert.deepEqual(planCueDelivery({ text: 'Edge. Back off.', voiceEnabled: true, now: 1000 }), { paint: true, speak: 'queue' });
        assert.deepEqual(planCueDelivery({ text: 'Session stopped.', urgent: true, voiceEnabled: true, now: 1000 }), { paint: true, speak: 'now' });
    });

    it('the safety cues reach the screen with the voice off', () => {
        for (const key of ['signalLost', 'stallHalt', 'stallResume', 'signalRestored']) {
            const { text } = resolveVoiceCue(DEFAULT_VOICE_CUES, key, {});
            assert.ok(text, key);
            const plan = planCueDelivery({ text, urgent: key === 'signalLost', voiceEnabled: false, now: 5000 });
            assert.equal(plan.paint, true, `${key} must be painted with the voice off`);
            assert.equal(plan.speak, 'none');
        }
    });

    it('a muted phrase bank says nothing and paints nothing, voice on or off', () => {
        for (const voiceEnabled of [true, false]) {
            assert.deepEqual(planCueDelivery({ text: '', voiceEnabled, urgent: true, now: 1 }), { paint: false, speak: 'none' });
        }
    });

    it('a remote page shows and says nothing of its own', () => {
        assert.deepEqual(planCueDelivery({ text: 'Edge.', voiceEnabled: true, remote: true, now: 1 }), { paint: false, speak: 'none' });
    });

    it('an identical cue is held back for a while unless it is urgent', () => {
        const base = { text: 'Stay right on the edge.', voiceEnabled: true, lastText: 'Stay right on the edge.', lastAt: 10_000 };
        assert.equal(planCueDelivery({ ...base, now: 10_000 + CUE_REPEAT_MS - 1 }).paint, false);
        assert.equal(planCueDelivery({ ...base, now: 10_000 + CUE_REPEAT_MS }).paint, true);
        assert.equal(planCueDelivery({ ...base, urgent: true, now: 10_001 }).speak, 'now', 'a safety cue is never swallowed as a repeat');
        assert.equal(planCueDelivery({ ...base, text: 'Breathe.', now: 10_001 }).paint, true, 'a different line is not a repeat');
        // A system clock set back must not mute a line for the length of the jump.
        assert.equal(planCueDelivery({ ...base, now: 10_000 - 3_600_000 }).paint, true);
        assert.equal(CUE_REPEAT_MS, 7000);
    });
});
