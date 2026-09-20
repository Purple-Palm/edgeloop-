// Named voice / dashboard cue templates. Each event holds a list of phrases
// (one per line in the editor). Tokens `{hr}`, `{maxHr}`, `{minHr}`,
// `{edges}` and `{minutes}` are filled from the live session when a cue fires.

export const MAX_CUE_LENGTH = 140;
export const MAX_PHRASES_PER_CUE = 120;

export const VOICE_CUE_VARS = ['hr', 'maxHr', 'minHr', 'edges', 'minutes'];

export const MIN_ENCOURAGE_SECONDS = 0;
export const MAX_ENCOURAGE_SECONDS = 180;
export const DEFAULT_ENCOURAGE_SECONDS = 45;

export const VOICE_CUE_CATALOG = [
    { id: 'idle', label: 'Resting prompt', lines: ['Calm and steady. Breathe.'] },
    { id: 'preview', label: 'Voice preview', lines: ['EdgeLoop voice preview. Stay right on the edge.'] },
    { id: 'sessionStart', label: 'Session start', lines: ['Session started. Breathe.'] },
    { id: 'paused', label: 'Paused', lines: ['Paused.'] },
    { id: 'sessionStop', label: 'Session stop', lines: ['Session stopped.'] },
    { id: 'edge', label: 'Edge detected', lines: ['Edge. Back off. {hr} BPM.'] },
    { id: 'stallHalt', label: 'Stall pause starts', lines: ['Stall guard. Primary halted. Recover.'] },
    { id: 'stallResume', label: 'Stall pause ends', lines: ['Hold window reset. Crawl.'] },
    { id: 'stallRecover', label: 'Left the edge', lines: ['Recovered. Resume.'] },
    { id: 'warmupDone', label: 'Warm-up complete', lines: ['Warm up complete.'] },
    { id: 'oracleWatching', label: 'Oracle approach', lines: ['The Oracle is watching. Climb.'] },
    { id: 'oracleHold', label: 'Oracle hold', lines: ['Hold. Fifteen seconds.'] },
    { id: 'oracleClimax', label: 'Oracle climax', lines: ['The Oracle chooses climax.'] },
    { id: 'oraclePurgatory', label: 'Oracle purgatory', lines: ['The Oracle chooses purgatory.'] },
    { id: 'oracleWithdrawn', label: 'Oracle climax cancelled', lines: ['Climax withdrawn. Climb again.'] },
    { id: 'oracleReset', label: 'Oracle purgatory reset', lines: ['Purgatory resets. Climb again.'] },
    { id: 'survivalBreach', label: 'Survival over the limit', lines: ['Over the limit. Drop it.'] },
    { id: 'signalLost', label: 'Heart-rate signal lost', lines: ['Heart rate signal lost. Motors stopped.'] },
    { id: 'signalRestored', label: 'Heart-rate restored', lines: ['Signal restored. Resuming.'] },
    {
        id: 'encourage',
        label: 'Encouragement (during the session)',
        lines: [
            'Stay right on the edge.',
            'Breathe. You can hold this.',
            'Not yet. Keep it there.'
        ]
    }
];

export const DEFAULT_VOICE_CUES = Object.fromEntries(
    VOICE_CUE_CATALOG.map((cue) => [cue.id, [...cue.lines]])
);

const KNOWN_IDS = new Set(VOICE_CUE_CATALOG.map((cue) => cue.id));
const CATALOG_BY_ID = Object.fromEntries(VOICE_CUE_CATALOG.map((cue) => [cue.id, cue]));

export function isVoiceCueId(key) {
    return KNOWN_IDS.has(key);
}

export function clampEncourageSeconds(value, fallback = DEFAULT_ENCOURAGE_SECONDS) {
    const n = typeof value === 'number' ? Math.round(value) : parseInt(String(value), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(MIN_ENCOURAGE_SECONDS, Math.min(MAX_ENCOURAGE_SECONDS, n));
}

export function sanitizeCueText(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (!trimmed) return fallback;
    return trimmed.length > MAX_CUE_LENGTH ? trimmed.slice(0, MAX_CUE_LENGTH) : trimmed;
}

function linesFrom(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(/\r?\n/);
    return [];
}

export function sanitizeCueList(value, fallbackLines = [], maxLines = MAX_PHRASES_PER_CUE) {
    const fallback = linesFrom(fallbackLines).map((line) => sanitizeCueText(line, '')).filter(Boolean);
    const unique = [];
    const seen = new Set();
    for (const raw of linesFrom(value)) {
        const line = sanitizeCueText(raw, '');
        if (!line || seen.has(line)) continue;
        seen.add(line);
        unique.push(line);
        if (unique.length >= maxLines) break;
    }
    return unique.length > 0 ? unique : fallback;
}

export function mergeVoiceCues(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const cue of VOICE_CUE_CATALOG) {
        out[cue.id] = sanitizeCueList(src[cue.id], cue.lines);
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

export function pickCueLine(lines, lastText = '', random = Math.random) {
    const list = Array.isArray(lines) ? lines.filter((line) => typeof line === 'string' && line) : [];
    if (list.length === 0) return '';
    if (list.length === 1) return list[0];
    const roll = Number(random());
    const idxBase = Number.isFinite(roll) ? Math.abs(roll) % 1 : 0;
    const pool = lastText ? list.filter((line) => line !== lastText) : list;
    const choices = pool.length > 0 ? pool : list;
    return choices[Math.min(choices.length - 1, Math.floor(idxBase * choices.length))];
}

// `key` is a catalog id, or a literal sentence (history outcomes, one-offs).
export function resolveVoiceCue(cues, key, vars = {}, { lastTemplate = '', random = Math.random } = {}) {
    if (typeof key !== 'string' || !key) return { text: '', template: '' };
    if (!KNOWN_IDS.has(key)) {
        const template = sanitizeCueText(key, '');
        return { text: interpolateCue(template, vars), template };
    }
    const merged = mergeVoiceCues(cues);
    const template = pickCueLine(merged[key], lastTemplate, random);
    return { text: interpolateCue(template, vars), template };
}

export function serializeVoiceCues(cues) {
    return mergeVoiceCues(cues);
}

function extractCueMap(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.voiceCues && typeof parsed.voiceCues === 'object' && !Array.isArray(parsed.voiceCues)) {
        return parsed.voiceCues;
    }
    const keys = Object.keys(parsed);
    if (keys.some((key) => KNOWN_IDS.has(key))) return parsed;
    return null;
}

export function applyImportedCues(current, incoming) {
    const base = mergeVoiceCues(current);
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return base;
    for (const cue of VOICE_CUE_CATALOG) {
        if (!Object.prototype.hasOwnProperty.call(incoming, cue.id)) continue;
        const list = sanitizeCueList(incoming[cue.id], []);
        if (list.length > 0) base[cue.id] = list;
    }
    return base;
}

function presentCueMap(src) {
    const incoming = {};
    if (!src || typeof src !== 'object' || Array.isArray(src)) return incoming;
    for (const cue of VOICE_CUE_CATALOG) {
        if (!Object.prototype.hasOwnProperty.call(src, cue.id)) continue;
        incoming[cue.id] = src[cue.id];
    }
    return incoming;
}

export function parseVoiceCuesText(raw) {
    const text = typeof raw === 'string' ? raw.replace(/^\uFEFF/, '') : '';
    if (!text.trim()) return { cues: {}, error: 'empty' };

    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            const map = extractCueMap(parsed);
            if (!map) return { cues: {}, error: 'json' };
            const incoming = presentCueMap(map);
            if (Object.keys(incoming).length === 0) return { cues: {}, error: 'json' };
            return { cues: incoming, error: null };
        } catch (e) {
            return { cues: {}, error: 'json' };
        }
    }

    const buckets = {};
    let current = 'encourage';
    let sawHeader = false;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//')) continue;
        const header = line.match(/^(?:#|\[)\s*([a-zA-Z]+)\s*\]?$/);
        if (header && KNOWN_IDS.has(header[1])) {
            current = header[1];
            sawHeader = true;
            continue;
        }
        if (!KNOWN_IDS.has(current)) continue;
        if (!buckets[current]) buckets[current] = [];
        buckets[current].push(line);
    }
    const hasAny = Object.values(buckets).some((list) => list.length > 0);
    if (!hasAny) return { cues: {}, error: sawHeader ? 'empty' : 'format' };
    return { cues: buckets, error: null };
}

export function voiceCuesToText(cues) {
    const merged = mergeVoiceCues(cues);
    const parts = [];
    for (const cue of VOICE_CUE_CATALOG) {
        parts.push(`# ${cue.id}`);
        parts.push(...merged[cue.id]);
        parts.push('');
    }
    return parts.join('\n').trim() + '\n';
}

export function catalogLabel(id) {
    return CATALOG_BY_ID[id]?.label || id;
}
