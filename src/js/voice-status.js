// Pure rules for what the wearer is told about the voice (voice.js owns
// speechSynthesis, app.js the DOM).
//
// A forum user turned Spoken Voice Guidance on, heard Preview, ran a whole
// session in silence and could find no setting that said the voice was off.
// Nothing the browser reported ever reached the screen: every speech error
// was swallowed, a saved voice this browser does not have was dropped
// without a word, and with the voice off the dashboard prompt line was
// hidden as well, so a cue reached nobody in any channel. These rules decide
// what reaches the screen instead, in plain words.

// Every value SpeechSynthesisErrorEvent.error can take (Web Speech API).
export const SPEECH_ERROR_CODES = Object.freeze([
    'canceled',
    'interrupted',
    'audio-busy',
    'audio-hardware',
    'network',
    'synthesis-unavailable',
    'synthesis-failed',
    'language-unavailable',
    'voice-unavailable',
    'text-too-long',
    'invalid-argument',
    'not-allowed'
]);

// What EdgeLoop's own cancel() produces: a cue cut short by STOP, Reset, an
// urgent cue or the voice being switched off. Those are not failures, and
// reporting them would tell the wearer the voice broke every time a safety
// cue jumped the queue.
export const SPEECH_CANCEL_CODES = Object.freeze(['canceled', 'interrupted']);

// Not an error code: speakPrompt()/speakNow() report this when the browser
// has no speechSynthesis at all, so the silence is still explained.
export const SPEECH_UNSUPPORTED = 'unsupported';

const WHERE = 'Session Setup > Audio & Mic';
const NO_VOICE = 'Voice guidance cannot speak: this browser has no working text-to-speech voice, so nothing can be said out loud. Cues still appear on the dashboard.';

// Codes that name their cause, one sentence each, in the words the wearer can
// act on.
const NAMED_CAUSES = {
    'not-allowed': 'Voice guidance is blocked: the browser will not play sound from a page you have not tapped yet. Tap anywhere on EdgeLoop and the next cue will be spoken.',
    'audio-busy': 'Voice guidance could not reach the speakers: another app is holding the audio output. Close it and the next cue will be spoken.',
    'audio-hardware': 'Voice guidance found no speaker or headphones to play on. Connect one and the next cue will be spoken.',
    network: `Voice guidance could not reach the online voice it uses. Check the connection, or pick a voice that works offline in ${WHERE}.`,
    'text-too-long': `Voice guidance skipped a cue that was too long for the voice. Shorten that phrase in ${WHERE}.`,
    'invalid-argument': `Voice guidance could not use this voice at EdgeLoop's speaking speed and pitch. Pick another voice in ${WHERE}.`,
    [SPEECH_UNSUPPORTED]: 'Voice guidance cannot speak: this browser has no text-to-speech support. Cues still appear on the dashboard.'
};

// Codes that only say the voice did not work.
const VOICE_FAULTS = {
    'synthesis-failed': `Voice guidance failed: the browser's speech engine could not speak a cue. Pick another voice in ${WHERE} and press Preview.`,
    'voice-unavailable': `Voice guidance could not use the selected voice. Pick another voice in ${WHERE}.`,
    'language-unavailable': `Voice guidance found no voice for the language of the cue. Pick another voice in ${WHERE}.`
};

// The failure `code` stands for, or null when it is not a failure at all.
//
// Chrome only ever reports four codes - `not-allowed` when a page nobody has
// tapped tries to speak, `synthesis-failed` for anything the platform engine
// gets wrong, and the two cancel codes - and Firefox dispatches its error
// events with no code at all, so an unknown or missing code is a failure too,
// never a reason to stay quiet. `voiceCount` is how many voices the browser
// lists: a failure that names no cause, with no voice to choose from, has
// exactly one explanation (Chrome on a system with no speech engine answers
// every cue with `synthesis-failed` and an empty voice list), and "pick
// another voice" would send the wearer to an empty list.
export function describeSpeechFailure(code, { voiceCount = null } = {}) {
    const known = typeof code === 'string' ? code : '';
    if (SPEECH_CANCEL_CODES.includes(known)) return null;
    if (Object.prototype.hasOwnProperty.call(NAMED_CAUSES, known)) {
        return { kind: known, code: known, message: NAMED_CAUSES[known] };
    }
    if (known === 'synthesis-unavailable' || voiceCount === 0) {
        return { kind: 'no-voice', code: known, message: NO_VOICE };
    }
    if (Object.prototype.hasOwnProperty.call(VOICE_FAULTS, known)) {
        return { kind: known, code: known, message: VOICE_FAULTS[known] };
    }
    return {
        kind: 'failed',
        code: known,
        message: `Voice guidance failed: the browser could not speak a cue and gave no reason. Press Preview in ${WHERE} to test the voice.`
    };
}

// The voice an utterance should carry. `status` is:
//   'default'  no voice was chosen: the browser's default voice speaks;
//   'matched'  the chosen voice is in the list and is used;
//   'missing'  the browser lists voices and the chosen one is not among them,
//              so the default voice speaks instead - never silence;
//   'pending'  the browser lists no voices yet. Chrome returns an empty list
//              until it has loaded them and then fires `voiceschanged`, so an
//              empty list proves nothing about the chosen voice: the default
//              voice speaks this cue and nobody is told a voice is missing.
export function resolveSpeechVoice(voices, voiceURI) {
    const list = Array.isArray(voices) ? voices : [];
    const wanted = typeof voiceURI === 'string' ? voiceURI : '';
    if (!wanted) return { voice: null, status: 'default' };
    const match = list.find((voice) => voice && voice.voiceURI === wanted) || null;
    if (match) return { voice: match, status: 'matched' };
    return { voice: null, status: list.length > 0 ? 'missing' : 'pending' };
}

const MAX_VOICE_NAME = 80;

// How a saved voice is named back to the wearer. A voiceURI can arrive from a
// backup made on another device, so it is shortened rather than trusted to be
// a short name.
export function voiceDisplayName(voiceURI) {
    const name = typeof voiceURI === 'string' ? voiceURI.replace(/\s+/g, ' ').trim() : '';
    if (name.length <= MAX_VOICE_NAME) return name;
    return `${name.slice(0, MAX_VOICE_NAME - 1)}…`;
}

export function describeMissingVoice(voiceURI) {
    return `Your saved voice "${voiceDisplayName(voiceURI)}" is not available in this browser, so voice guidance speaks with the browser's default voice. Pick a voice in ${WHERE} to replace it.`;
}

// Which notices have already been shown. A failing voice fails on every cue,
// and one sentence per cue would bury the banner, so each kind is shown once
// per session; `newSession()` (a fresh START) lets each be shown once more.
// A kind listed in `perPage` is told once for the whole page: a saved voice
// the browser does not have will not appear between two sessions.
export function createSpeechNotices({ perPage = ['voice-missing'] } = {}) {
    const pageKinds = new Set(Array.isArray(perPage) ? perPage : []);
    const toldThisSession = new Set();
    const toldThisPage = new Set();
    return {
        // True exactly once per kind (per session, or per page for
        // `perPage` kinds): the caller shows the notice when it gets true.
        take(kind) {
            if (typeof kind !== 'string' || !kind) return false;
            const told = pageKinds.has(kind) ? toldThisPage : toldThisSession;
            if (told.has(kind)) return false;
            told.add(kind);
            return true;
        },
        newSession() {
            toldThisSession.clear();
        }
    };
}

// The label beside the dashboard prompt line. It used to read "Voice Active"
// whatever was happening, including while every cue failed.
export function describeVoiceIndicator({ enabled = false, failing = false } = {}) {
    if (!enabled) return { text: 'Voice off', tone: 'off' };
    if (failing) return { text: 'Voice failed', tone: 'warn' };
    return { text: 'Voice on', tone: 'on' };
}

// The note under the voice picker in Session Setup, or null when there is
// nothing to say. A failure comes first: it is why nothing was heard.
export function describeVoiceStatus({
    enabled = false,
    problem = null,
    voiceURI = '',
    voices = [],
    previewedWhileOff = false
} = {}) {
    const lines = [];
    let tone = 'info';
    if (problem && typeof problem.message === 'string' && problem.message) {
        lines.push(problem.message);
        tone = 'warn';
    }
    if (resolveSpeechVoice(voices, voiceURI).status === 'missing') {
        lines.push(describeMissingVoice(voiceURI));
        tone = 'warn';
    }
    // Exactly the path of the forum report: Preview speaks whatever the
    // switch says, so hearing it proved nothing about the session.
    if (lines.length === 0 && previewedWhileOff && !enabled) {
        lines.push('That was only a preview. Spoken Voice Guidance is off, so a session will not speak until you switch it on above.');
    }
    if (lines.length === 0) return null;
    return { text: lines.join(' '), tone };
}

// How long an identical, non-urgent cue is held back after it was delivered.
export const CUE_REPEAT_MS = 7000;

// What one cue does. The dashboard prompt line shows every cue whether or not
// the voice is on: it is the one channel every wearer has, and a safety cue
// (signal lost, a stall pause) has to reach a wearer with no speakers, a
// browser that cannot speak, or the voice switched off. The voice adds the
// spoken copy; an urgent cue cuts the queue. Returns
// { paint, speak: 'none' | 'queue' | 'now' }.
//
// An empty `text` is a muted phrase bank - the wearer emptied it - and does
// nothing at all, leaving whatever line is already on the dashboard. A remote
// page runs no engine and has nothing of the wearer's to show or say.
export function planCueDelivery({
    text = '',
    urgent = false,
    voiceEnabled = false,
    remote = false,
    lastText = '',
    lastAt = 0,
    now = 0,
    repeatMs = CUE_REPEAT_MS
} = {}) {
    const quiet = { paint: false, speak: 'none' };
    if (remote || typeof text !== 'string' || !text) return quiet;
    const since = Number(now) - Number(lastAt);
    if (!urgent && text === lastText && Number.isFinite(since) && since >= 0 && since < repeatMs) return quiet;
    if (!voiceEnabled) return { paint: true, speak: 'none' };
    return { paint: true, speak: urgent ? 'now' : 'queue' };
}
