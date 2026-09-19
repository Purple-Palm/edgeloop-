/**
 * Local TTS prompts and optional microphone arousal monitor.
 */

export function listSpeechVoices() {
    if (!window.speechSynthesis) return [];
    return window.speechSynthesis.getVoices() || [];
}

export function speakPrompt(enabled, text, voiceURI = '') {
    if (!enabled || !text || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 0.92;
    if (voiceURI) {
        const match = listSpeechVoices().find((voice) => voice.voiceURI === voiceURI);
        if (match) utterance.voice = match;
    }
    window.speechSynthesis.speak(utterance);
}

export function setMindgamePrompt(text, visible) {
    const box = document.getElementById('mindgameContainer');
    const el = document.getElementById('mindgamePromptText');
    if (el && text) el.textContent = `"${text}"`;
    if (box) box.classList.toggle('hidden', !visible);
}

export async function startMicMonitor(state) {
    stopMicMonitor(state);
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone not supported in this browser');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    state.micStream = stream;
    state.micAudioCtx = audioCtx;
    state.micAnalyser = analyser;
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

export function sampleMicLevel(state) {
    const analyser = state.micAnalyser;
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        const centered = (data[i] - 128) / 128;
        sum += centered * centered;
    }
    return Math.min(100, Math.round(Math.sqrt(sum / data.length) * 140));
}
