// Named voice / dashboard cue templates. The cockpit looks them up by id
// so the Audio tab can edit the wording without touching app.js. Tokens
// `{hr}`, `{maxHr}`, `{minHr}`, `{edges}` and `{minutes}` are filled from
// the live session when the cue fires.

export const MAX_CUE_LENGTH = 140;

export const VOICE_CUE_VARS = ['hr', 'maxHr', 'minHr', 'edges', 'minutes'];

export const VOICE_CUE_CATALOG = [
    { id: 'idle', label: 'Resting prompt', text: 'Calm and steady. Breathe.' },
    { id: 'preview', label: 'Voice preview', text: 'EdgeLoop voice preview. Stay right on the edge.' },
    { id: 'sessionStart', label: 'Session start', text: 'Session started. Breathe.' },
    { id: 'paused', label: 'Paused', text: 'Paused.' },
    { id: 'sessionStop', label: 'Session stop', text: 'Session stopped.' },
    { id: 'edge', label: 'Edge detected', text: 'Edge. Back off. {hr} BPM.' },
    { id: 'stallHalt', label: 'Stall pause starts', text: 'Stall guard. Primary halted. Recover.' },
    { id: 'stallResume', label: 'Stall pause ends', text: 'Hold window reset. Crawl.' },
    { id: 'stallRecover', label: 'Left the edge', text: 'Recovered. Resume.' },
    { id: 'warmupDone', label: 'Warm-up complete', text: 'Warm up complete.' },
    { id: 'oracleWatching', label: 'Oracle approach', text: 'The Oracle is watching. Climb.' },
    { id: 'oracleHold', label: 'Oracle hold', text: 'Hold. Fifteen seconds.' },
    { id: 'oracleClimax', label: 'Oracle climax', text: 'The Oracle chooses climax.' },
    { id: 'oraclePurgatory', label: 'Oracle purgatory', text: 'The Oracle chooses purgatory.' },
    { id: 'oracleWithdrawn', label: 'Oracle climax cancelled', text: 'Climax withdrawn. Climb again.' },
    { id: 'oracleReset', label: 'Oracle purgatory reset', text: 'Purgatory resets. Climb again.' },
    { id: 'survivalBreach', label: 'Survival over the limit', text: 'Over the limit. Drop it.' },
    { id: 'signalLost', label: 'Heart-rate signal lost', text: 'Heart rate signal lost. Motors stopped.' },
    { id: 'signalRestored', label: 'Heart-rate restored', text: 'Signal restored. Resuming.' }
];

export const DEFAULT_VOICE_CUES = Object.fromEntries(
    VOICE_CUE_CATALOG.map((cue) => [cue.id, cue.text])
);

const KNOWN_IDS = new Set(VOICE_CUE_CATALOG.map((cue) => cue.id));

export function sanitizeCueText(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (!trimmed) return fallback;
    return trimmed.length > MAX_CUE_LENGTH ? trimmed.slice(0, MAX_CUE_LENGTH) : trimmed;
}

export function mergeVoiceCues(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const cue of VOICE_CUE_CATALOG) {
        out[cue.id] = sanitizeCueText(src[cue.id], cue.text);
    }
    return out;
}

export function interpolateCue(template, vars = {}) {
    if (typeof template !== 'string' || !template) return '';
    return template.replace(/\{([a-zA-Z]+)\}/g, (full, name) => {
        if (!VOICE_CUE_VARS.includes(name)) return full;
        const value = vars[name];
        if (value === undefined || value === null || value === '') return '';
        return String(value);
    }).replace(/\s+/g, ' ').trim();
}

// `key` is a catalog id, or a literal sentence (history outcomes, one-offs).
export function resolveVoiceCue(cues, key, vars = {}) {
    if (typeof key !== 'string' || !key) return '';
    const merged = mergeVoiceCues(cues);
    const template = KNOWN_IDS.has(key) ? merged[key] : sanitizeCueText(key, '');
    return interpolateCue(template, vars);
}

export function isVoiceCueId(key) {
    return KNOWN_IDS.has(key);
}
