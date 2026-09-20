/**
 * Local TTS prompts and optional microphone arousal monitor.
 *
 * Cues go through a short queue (voice-queue.js) instead of cancelling
 * whatever is being said: back-to-back cues are all heard, duplicates are
 * dropped and at most three wait. Only speakNow() (safety-critical cues)
 * and cancelSpeech() (STOP / Reset / voice turned off) interrupt speech.
 */
import { createCueQueue } from './voice-queue.js';

const queue = createCueQueue({ maxQueued: 3 });
let activeToken = 0;
let fallbackTimer = null;

// Tests replace these hooks to assert that speak() is actually called.
export const speechHooks = {
    getSynth() {
        return typeof window !== 'undefined' ? window.speechSynthesis : null;
    },
    UtteranceCtor() {
        if (typeof SpeechSynthesisUtterance === 'function') return SpeechSynthesisUtterance;
        return typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null;
    }
};

function synth() {
    return speechHooks.getSynth();
}

export function listSpeechVoices() {
    const s = synth();
    if (!s) return [];
    return s.getVoices() || [];
}

function clearFallbackTimer() {
    if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
    }
}

// Speak one utterance and advance the queue when it ends. A token guards
// the callbacks so a cancelled utterance can never pop the NEXT cue, and a
// fallback timer keeps the queue moving on browsers that never fire `end`.
function utter(text, voiceURI) {
    const s = synth();
    const Utterance = speechHooks.UtteranceCtor();
    if (!s || !Utterance) return;
    const token = ++activeToken;
    clearFallbackTimer();
    const utterance = new Utterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 0.92;
    if (voiceURI) {
        const match = listSpeechVoices().find((voice) => voice.voiceURI === voiceURI);
        if (match) utterance.voice = match;
    }
    const done = () => {
        if (token !== activeToken) return;
        clearFallbackTimer();
        const next = queue.next();
        if (next) utter(next, voiceURI);
    };
    utterance.onend = done;
    utterance.onerror = done;
    fallbackTimer = setTimeout(done, 3000 + text.length * 120);
    try {
        s.speak(utterance);
    } catch (e) {
        done();
    }
}

// Enqueue a cue. Nothing already speaking is interrupted.
export function speakPrompt(enabled, text, voiceURI = '') {
    if (!enabled || !text || !synth()) return;
    if (!queue.enqueue(text)) return;
    if (queue.isIdle()) {
        const next = queue.next();
        if (next) utter(next, voiceURI);
    }
}

// Safety-critical cue: drops everything waiting, cuts the current cue and
// speaks `text` immediately.
export function speakNow(text, voiceURI = '') {
    const s = synth();
    if (!text || !s) return;
    activeToken += 1;
    const mine = activeToken;
    clearFallbackTimer();
    queue.jump(text);
    try {
        s.cancel();
    } catch (e) { /* nothing to cancel */ }
    // Chrome drops an utterance queued in the same tick as cancel(); a short
    // delay makes the urgent cue reliable. Skipped if silenced meanwhile.
    setTimeout(() => {
        if (activeToken === mine) utter(text, voiceURI);
    }, 50);
}

// Silence everything: current cue and queue. Used on STOP, Reset and when
// voice guidance is switched off.
export function cancelSpeech() {
    activeToken += 1;
    clearFallbackTimer();
    queue.clear();
    const s = synth();
    if (!s) return;
    try {
        s.cancel();
    } catch (e) { /* nothing to cancel */ }
}

export function setMindgamePrompt(text, visible) {
    const box = document.getElementById('mindgameContainer');
    const el = document.getElementById('mindgamePromptText');
    if (el && text) el.textContent = `"${text}"`;
    if (box) box.classList.toggle('hidden', !visible);
}

// Must be called from inside a user gesture (a click): the AudioContext is
// created and resumed BEFORE the permission prompt awaits, because a context
// created after the gesture has ended starts suspended on most browsers.
export async function startMicMonitor(state) {
    stopMicMonitor(state);
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone not supported in this browser');
    }
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) {
        throw new Error('Web Audio not supported in this browser');
    }
    const audioCtx = new AudioCtor();
    try {
        if (audioCtx.state !== 'running') await audioCtx.resume();
    } catch (e) { /* resume is best effort; getUserMedia may still unlock it */ }
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
        audioCtx.close().catch(() => {});
        throw e;
    }
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);
    state.micStream = stream;
    state.micAudioCtx = audioCtx;
    state.micAnalyser = analyser;
    if (audioCtx.state !== 'running') {
        try {
            await audioCtx.resume();
        } catch (e) { /* the level sampler simply reads silence until it runs */ }
    }
}

export function stopMicMonitor(state) {
    if (state.micAnimId) {
        cancelAnimationFrame(state.micAnimId);
        state.micAnimId = null;
    }
    if (state.micStream) {
        state.micStream.getTracks().forEach((track) => track.stop());
        state.micStream = null;
    }
    if (state.micAudioCtx) {
        state.micAudioCtx.close().catch(() => {});
        state.micAudioCtx = null;
    }
    state.micAnalyser = null;
}

// Voice-band gate: ignore rumble from strokers / vibrators (mostly <250 Hz)
// and keep panting, speech and other user noise (roughly 250-4000 Hz).
export const MIC_VOICE_BAND_LO_HZ = 250;
export const MIC_VOICE_BAND_HI_HZ = 4000;
export const MIN_MIC_GATE = 8;
export const MAX_MIC_GATE = 90;
export const DEFAULT_MIC_GATE = 40;

// Extra BPM added to the working heart rate when the wearer is louder
// than the gate. 0 = listen only (meter and badge, no loop effect).
export const MIN_MIC_BOOST_BPM = 0;
export const MAX_MIC_BOOST_BPM = 20;
export const DEFAULT_MIC_BOOST_BPM = 8;

export function clampMicGate(value, fallback = DEFAULT_MIC_GATE) {
    const n = typeof value === 'number' ? Math.round(value) : parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(MIN_MIC_GATE, Math.min(MAX_MIC_GATE, n));
}

export function clampMicBoostBpm(value, fallback = DEFAULT_MIC_BOOST_BPM) {
    const n = typeof value === 'number' ? Math.round(value) : parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(MIN_MIC_BOOST_BPM, Math.min(MAX_MIC_BOOST_BPM, n));
}

// Map voice-band level (0-100) onto 0..maxBpm. Silence or anything at/under
// the gate is 0; full-band loudness (100) is the cap. Louder = closer to the
// edge. The engine still cannot pass the effective climax ceiling.
export function micBoostFromLevel(level, gate, maxBpm) {
    const cap = clampMicBoostBpm(maxBpm, 0);
    if (cap <= 0) return 0;
    const g = clampMicGate(gate);
    const lv = typeof level === 'number' && Number.isFinite(level) ? level : parseInt(String(level), 10);
    if (!Number.isFinite(lv) || lv <= g) return 0;
    const span = Math.max(1, 100 - g);
    const t = Math.min(1, (lv - g) / span);
    return Math.round(t * cap);
}

// Pure: average magnitude of analyser frequency bins inside the voice band,
// scaled 0-100. Low-frequency motor noise is dropped on purpose.
export function voiceBandLevel(freqBytes, sampleRate, fftSize) {
    if (!freqBytes || !freqBytes.length) return 0;
    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100;
    const size = Number.isFinite(fftSize) && fftSize > 0 ? fftSize : (freqBytes.length * 2);
    const binHz = rate / size;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < freqBytes.length; i++) {
        const hz = i * binHz;
        if (hz < MIC_VOICE_BAND_LO_HZ || hz > MIC_VOICE_BAND_HI_HZ) continue;
        const mag = freqBytes[i];
        if (!Number.isFinite(mag)) continue;
        sum += mag;
        n += 1;
    }
    if (!n) return 0;
    return Math.min(100, Math.round((sum / n) / 2.55));
}

export function sampleMicLevel(state) {
    const analyser = state.micAnalyser;
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const sampleRate = state.micAudioCtx?.sampleRate || 44100;
    return voiceBandLevel(data, sampleRate, analyser.fftSize);
}
