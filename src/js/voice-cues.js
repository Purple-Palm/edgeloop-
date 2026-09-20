// Named voice / dashboard cue templates. Each event holds a list of phrases
// (one per line in the editor). Tokens `{hr}`, `{maxHr}`, `{minHr}`,
// `{edges}` and `{minutes}` are filled from the live session when a cue fires.

export const MAX_CUE_LENGTH = 140;
export const MAX_PHRASES_PER_CUE = 120;

export const VOICE_CUE_VARS = ['hr', 'maxHr', 'minHr', 'edges', 'minutes', 'done', 'need', 'hold'];

export const MIN_ENCOURAGE_SECONDS = 0;
export const MAX_ENCOURAGE_SECONDS = 180;
export const DEFAULT_ENCOURAGE_SECONDS = 45;

export const VOICE_CUE_CATALOG = [
    {
        id: 'encourage',
        group: 'Build-up',
        label: 'Build-up encouragement',
        lines: [
            'Stay right on the edge.',
            'Breathe. You can hold this.',
            'Not yet. Keep it there.',
            'Good. Keep building.',
            'Slow and mean. Don\'t rush.',
            'You\'re doing well. Stay hungry.',
            'Climb. Don\'t finish.',
            'That\'s it. Let it stack.',
            'Still denied. Keep going.',
            '{minutes} minutes in. Hold.',
            'Edge {edges} so far. Keep it.',
            'Warm and tight. Don\'t spill.',
            'Take the pleasure. Not the finish.',
            'Steady. You are not done yet.'
        ]
    },
    {
        id: 'warmupDone',
        group: 'Build-up',
        label: 'Warm-up complete',
        lines: [
            'Warm up complete.',
            'Warm-up over. Now we climb.',
            'The easy part is done. Hold.'
        ]
    },
    {
        id: 'edge',
        group: 'Edge',
        label: 'Hit the edge',
        lines: [
            'Edge. Back off. {hr} BPM.',
            'That\'s the edge. Don\'t go over.',
            'Hold it. {hr} of {maxHr}.',
            'Back off now. Edge {edges}.',
            'Right there. Stay on it.',
            'Pulse at the line. Don\'t come.',
            'Too close. Ease off.',
            'That\'s it. Ride the edge.',
            '{hr} BPM. Hold, don\'t finish.',
            'Stop climbing. Stay edged.',
            'You\'re there. Breathe through it.',
            'On the brink. Not yet.'
        ]
    },
    { id: 'stallHalt', group: 'Edge', label: 'Stall pause starts', lines: ['Stall guard. Primary halted. Recover.', 'Too long on the edge. Halt. Recover.'] },
    { id: 'stallResume', group: 'Edge', label: 'Stall pause ends', lines: ['Hold window reset. Crawl.', 'Crawl again. Don\'t dump it.'] },
    { id: 'stallRecover', group: 'Edge', label: 'Left the edge', lines: ['Recovered. Resume.', 'Off the edge. Climb again.'] },
    {
        id: 'forceOrgasm',
        group: 'Climax',
        label: 'Force orgasm / make you come',
        lines: [
            'Force orgasm. You don\'t get to hold back.',
            'Come. Now.',
            'That\'s it. Finish.',
            'No more holding. Come for it.',
            'Over the edge. Let go.',
            'Forced. You come now.',
            'Ceiling is gone. Come.',
            '{hr} BPM. Don\'t stop until you finish.',
            'Take it. Come.',
            'This is the one. Come.',
            'You are allowed to come. Do it.',
            'No denial. Finish.'
        ]
    },
    {
        id: 'forceOrgasmOff',
        group: 'Climax',
        label: 'Force orgasm cancelled',
        lines: [
            'Force orgasm cancelled. Back to the edge.',
            'Denied again. Climb.',
            'Climax withdrawn. Hold.',
            'Not this time. Stay edged.'
        ]
    },
    { id: 'oracleWatching', group: 'Climax', label: 'Oracle approach', lines: ['The Oracle is watching. Climb.'] },
    { id: 'oracleHold', group: 'Climax', label: 'Oracle hold', lines: ['Hold. Fifteen seconds.'] },
    {
        id: 'oracleClimax',
        group: 'Climax',
        label: 'Oracle chooses climax',
        lines: [
            'The Oracle chooses climax.',
            'The Oracle says come.',
            'Oracle: you finish now.'
        ]
    },
    { id: 'oraclePurgatory', group: 'Climax', label: 'Oracle purgatory', lines: ['The Oracle chooses purgatory.'] },
    { id: 'oracleNotYet', group: 'Climax', label: 'Oracle too early to end', lines: ['Not yet. Keep climbing.', 'Too soon. The Oracle is still watching.'] },
    { id: 'oracleWithdrawn', group: 'Climax', label: 'Oracle climax cancelled', lines: ['Climax withdrawn. Climb again.'] },
    { id: 'oracleReset', group: 'Climax', label: 'Oracle purgatory reset', lines: ['Purgatory resets. Climb again.'] },
    {
        id: 'trainHold',
        group: 'Training',
        label: 'Edge training: hold',
        lines: [
            'Hold it. {hold} seconds.',
            'Stay on the edge. Hold.',
            'Don\'t come. Hold it there.'
        ]
    },
    {
        id: 'trainHeld',
        group: 'Training',
        label: 'Edge training: edge counted',
        lines: [
            'Edge held. {done} of {need}.',
            'Good. Recover, then climb. {done} of {need}.',
            'That one counts. {done} down, keep going.'
        ]
    },
    {
        id: 'trainDrop',
        group: 'Training',
        label: 'Edge training: dropped early',
        lines: [
            'Dropped. That one does not count.',
            'Too soon. Climb and hold again.',
            'Off the edge. Try a longer hold.'
        ]
    },
    {
        id: 'trainFinish',
        group: 'Training',
        label: 'Edge training: complete',
        lines: [
            'Training complete. Come.',
            '{need} edges. You can finish.',
            'You held them. Come now.'
        ]
    },
    {
        id: 'cameEarly',
        group: 'Premature',
        label: 'Came early / premature ejaculation',
        lines: [
            'Came early. Limit tightened.',
            'Premature. Ceiling drops next time.',
            'You came too soon. Learning that.',
            'Accidental release. {hr} BPM. Limits tighter.',
            'Too soon. We\'ll keep you lower.',
            'Breakthrough logged. Hold better next time.',
            'You spilled. Working climax HR goes down.',
            'Premature ejaculation. The next session is meaner.'
        ]
    },
    { id: 'idle', group: 'Session', label: 'Resting prompt', lines: ['Calm and steady. Breathe.'] },
    { id: 'preview', group: 'Session', label: 'Voice preview', lines: ['EdgeLoop voice preview. Stay right on the edge.'] },
    { id: 'sessionStart', group: 'Session', label: 'Session start', lines: ['Session started. Breathe.'] },
    { id: 'paused', group: 'Session', label: 'Paused', lines: ['Paused.'] },
    { id: 'sessionStop', group: 'Session', label: 'Session stop', lines: ['Session stopped.'] },
    { id: 'survivalBreach', group: 'Guards', label: 'Survival over the limit', lines: ['Over the limit. Drop it.'] },
    { id: 'signalLost', group: 'Guards', label: 'Heart-rate signal lost', lines: ['Heart rate signal lost. Motors stopped.'] },
    { id: 'signalRestored', group: 'Guards', label: 'Heart-rate restored', lines: ['Signal restored. Resuming.'] }
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
