// One sanitizer per Session Setup field, and a test that fails if a field
// has none.
//
// Why this exists: the backup work added an allow-list of field NAMES, which
// answered "is this a name this build wrote?" and nothing else. The values
// were clamped by whichever sync function happened to own them, and six
// fields were owned by nobody. `gammaCurve` was the sharp one: it has no
// control in the app, is read straight into the engine as the exponent on
// the progress term, and was clamped by nothing at all. A one-field imported
// file could set it to 200, and with `pow(progress, 200)` collapsing to zero
// the engine stops backing off as the pulse climbs: measured live, both
// channels went from 48% to 100% at 120 BPM against a typed ceiling of 140,
// mid-session, and the import called it "1 Session Setup value".
//
// So the rule is now the one the documentation always claimed: every value
// that reaches the settings store - typed, restored from storage on boot, or
// imported from a file - passes the same check, and a field with no check is
// a failing test rather than a hole. Cross-field rules (the HR pair, the
// duration window, the stroke envelope) stay where they are defined and run
// after this pass; this file is per-field only.

import { SETTING_DEFAULTS } from './state.js';
import { clampStallGuardSeconds, clampStallPauseSeconds, clampTrainHoldSeconds, clampTrainEdges, resolveForceOrgasmMaxSeconds, MAX_SESSION_MINUTES, DURATION_MODES, ENDGAME_TYPES, MAX_LEARNED_OFFSET_BPM } from './session-rules.js';
import { clampEdgeHoldPercent } from './engine.js';
import { clampStaleSeconds } from './hr-watchdog.js';
import { clampEndMargin } from './hardware/handy-protocol.js';
import { sanitizeVacuglideRole, clampSpeedCap, clampValvePulseMs } from './hardware/vacuglide-protocol.js';
import { clampMicGate, clampMicBoostBpm } from './voice.js';
import { clampEncourageSeconds, mergeVoiceCues } from './voice-cues.js';
import {
    clampReactBpm,
    clampFloor,
    resolveApproach,
    resolveEdgeAction,
    clampRejoinSeconds,
    clampMaxSpeed,
    resolveInvert,
    resolveSmoothing,
    resolveSecondChannel,
    resolveVideoEnd
} from './player/script-governor.js';

// Re-exported so a caller has one place to ask about setting bounds; the
// window itself belongs to the parser that refuses a length outside it.
export { MAX_SESSION_MINUTES };

// Bounds for the learning profile. The offset cap is the one the Came Early
// step itself stops at (session-rules.js), re-exported so a restored profile
// and a pressed button can never disagree about it; the HR is the same
// plausibility window a typed limit gets. A negative offset would RAISE the
// working ceiling above the Climax HR the user typed, which is the one
// direction that must be impossible.
export { MAX_LEARNED_OFFSET_BPM };
export const MAX_LEARNED_EVENTS = 9999;
const MIN_PLAUSIBLE_HR = 30;
const MAX_PLAUSIBLE_HR = 250;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A toggle writes `true` or `false` and nothing else, so anything else
// carries no information. It falls back to the FACTORY value rather than to
// `false`: `false` is the opposite of the factory value for every setting
// that ships on - the stall guard among them, which is the watchdog that
// halts the primary after too long at the edge.
function boolean(name) {
    const factory = SETTING_DEFAULTS[name] === true;
    return (value) => (value === true || value === 'true' ? true
        : value === false || value === 'false' ? false
        : factory);
}

// A whole number inside the bounds of the control that writes it. Out of
// range clamps to the nearer bound; unreadable falls back to the factory
// value, because a bound would be a number the user never chose.
function wholeNumber(name, min, max) {
    return (value) => {
        const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
        if (!Number.isFinite(n)) return SETTING_DEFAULTS[name];
        return Math.max(min, Math.min(max, Math.round(n)));
    };
}

// A field whose value only makes sense next to another one. The entry
// exists so the coverage test can see it; the value is settled by the owner
// named in CROSS_FIELD_OWNERS, which is the only code that sees both halves.
const passToOwner = (value) => value;

function oneOf(name, allowed) {
    return (value) => (allowed.includes(value) ? value : SETTING_DEFAULTS[name]);
}

// A field with no control anywhere in the app. Nothing but this file can
// produce a value for it, so a file offering one is offering a value the
// user could never have chosen and never see. The factory value stands
// until a control exists - at which point this entry becomes that control's
// bounds, and settings-schema.test.js fails until it does.
function fixedAtFactory(name) {
    return () => SETTING_DEFAULTS[name];
}

// The learning profile is the one setting that is a structure rather than a
// number. An unreadable one falls back to a zeroed profile, which is the
// state a fresh install is in.
export function sanitizeLearningProfile(raw) {
    if (!isPlainObject(raw)) return { ...SETTING_DEFAULTS.learningProfile };
    const events = Number(raw.breakthroughEvents);
    const offset = Number(raw.suggestedMaxHrOffset);
    const last = Number(raw.lastBreakthroughHr);
    return {
        breakthroughEvents: Number.isFinite(events) ? Math.max(0, Math.min(MAX_LEARNED_EVENTS, Math.round(events))) : 0,
        suggestedMaxHrOffset: Number.isFinite(offset) ? Math.max(0, Math.min(MAX_LEARNED_OFFSET_BPM, Math.round(offset))) : 0,
        lastBreakthroughHr: Number.isFinite(last) && last >= MIN_PLAUSIBLE_HR && last <= MAX_PLAUSIBLE_HR ? Math.round(last) : null
    };
}

// Fields whose value depends on another field, checked after this pass by
// the function named here. They still need an entry - a per-field sanity
// pass first means the cross-field rule never sees a string where it
// expects a number - but the final say is not here.
export const CROSS_FIELD_OWNERS = {
    minHr: 'session-rules.sanitizeSessionLimits',
    maxHr: 'session-rules.sanitizeSessionLimits',
    durationMode: 'session-rules.sanitizeSessionLimits',
    durationFixedMinutes: 'session-rules.sanitizeSessionLimits',
    durationMinMinutes: 'session-rules.sanitizeSessionLimits',
    durationMaxMinutes: 'session-rules.sanitizeSessionLimits',
    endgameType: 'session-rules.sanitizeSessionLimits',
    handyHwMin: 'app.syncHwEnvelopeInputs -> handy-protocol.normalizeEnvelope',
    handyHwMax: 'app.syncHwEnvelopeInputs -> handy-protocol.normalizeEnvelope'
};

// name -> (value) => value. Every name in SETTING_KEYS must appear here;
// settings-schema.test.js fails if one does not.
export const SETTING_SANITIZERS = {
    // The HR pair belongs to its owner alone. Clamping each end here first
    // would turn "this pair is nonsense, fall back to the factory 70/140"
    // into "30 and 250 are both in range, keep them" - a Climax HR of 250
    // restored from a file that asked for 9999, instead of the refusal the
    // documentation promises. The owner sees both ends and decides.
    minHr: passToOwner,
    maxHr: passToOwner,
    // The two enums are the owner's own lists, imported rather than copied.
    // A copy of the endgame list here was wrong ('ruin' instead of
    // 'rampdown'), so a wearer who chose Soft Landing had it silently turned
    // into the Orgasm endgame on every boot, Apply and import - and at the
    // target time that arms Force Orgasm instead of landing softly. A list
    // that lives in one place cannot drift from the buttons that write it.
    durationMode: oneOf('durationMode', DURATION_MODES),
    // The lengths go to their owner as written, for the same reason the HR
    // pair does: the owner REFUSES a length outside the window and falls
    // back to the factory one, and clamping -3 to 1 here would hand it a
    // "valid" one-minute session the user never asked for. (That is not
    // hypothetical - the smoke run caught exactly that.)
    durationFixedMinutes: passToOwner,
    durationMinMinutes: passToOwner,
    durationMaxMinutes: passToOwner,
    endgameType: oneOf('endgameType', ENDGAME_TYPES),

    // No control in the app; see fixedAtFactory.
    gammaCurve: fixedAtFactory('gammaCurve'),
    edgeStrokeDepth: fixedAtFactory('edgeStrokeDepth'),

    warmupMinutes: wholeNumber('warmupMinutes', 0, 10),

    // Likewise the travel envelope: normalizeEnvelope clamps both ends to
    // 0-100 AND keeps them a minimum gap apart in the right order, which
    // no per-field clamp can do.
    handyHwMin: passToOwner,
    handyHwMax: passToOwner,
    envelopeMigrated: boolean('envelopeMigrated'),
    handyEndMargin: (value) => clampEndMargin(value),

    // The two VacuGlide values that decide how hard it runs do NOT fall back
    // to the factory value: for them the factory value is the permissive
    // one. A role nobody can type is OFF rather than a live `primary`, and
    // an unreadable cap is the slider's floor rather than 100%, snapped
    // down onto the slider's own grid like the Handy cap. The pulse length
    // is clamped to the range the panel offers.
    vacuglideRole: (value) => sanitizeVacuglideRole(value),
    vacuglideMaxCap: (value) => clampSpeedCap(value),
    vacuglideValvePulseMs: (value) => clampValvePulseMs(value),

    stallGuard: boolean('stallGuard'),
    stallGuardSeconds: (value) => clampStallGuardSeconds(value),
    stallPauseSeconds: (value) => clampStallPauseSeconds(value),
    // One of the options the Guards select offers. A value it never offers
    // is the factory limit, not Off: only an explicit 0 switches the limit
    // off, so a hand-edited or damaged file cannot take the guard away.
    forceOrgasmMaxSeconds: (value) => resolveForceOrgasmMaxSeconds(value),
    ceilingBehaviour: oneOf('ceilingBehaviour', ['stop', 'crawl']),
    edgeHoldPercent: (value) => clampEdgeHoldPercent(value),
    trainHoldSeconds: (value) => clampTrainHoldSeconds(value),
    trainEdges: (value) => clampTrainEdges(value),
    survivalCalibrating: boolean('survivalCalibrating'),

    hrStaleSeconds: (value) => clampStaleSeconds(value),
    hrAutoResume: boolean('hrAutoResume'),

    dualDampening: boolean('dualDampening'),
    dualDampeningBpm: wholeNumber('dualDampeningBpm', 5, 30),
    adaptiveDecay: boolean('adaptiveDecay'),
    decayEdgeCount: wholeNumber('decayEdgeCount', 1, 10),
    decayBpm: wholeNumber('decayBpm', 1, 5),
    decayFloor: wholeNumber('decayFloor', 80, 130),

    voiceEnabled: boolean('voiceEnabled'),
    voiceURI: (value) => (typeof value === 'string' ? value.slice(0, 200) : SETTING_DEFAULTS.voiceURI),
    voiceCues: (value) => mergeVoiceCues(value),
    voiceEncourageSeconds: (value) => clampEncourageSeconds(value),

    micEnabled: boolean('micEnabled'),
    micSensitivityThreshold: (value) => clampMicGate(value),
    micBoostMaxBpm: (value) => clampMicBoostBpm(value),

    // The Script tab: each through the governor's own sanitizer, so the
    // tab, the store, a file and the engine bound a value the same way.
    // Smoothing has one option in this version (Light), so its sanitizer
    // keeps nothing else; the edge action knows Skip strokes and Pause
    // video, and anything else (Crawl among them) is Skip.
    scriptReactBpm: (value) => clampReactBpm(value),
    scriptFloorPercent: (value) => clampFloor(value),
    scriptApproach: (value) => resolveApproach(value),
    scriptEdgeAction: (value) => resolveEdgeAction(value),
    scriptRejoinSeconds: (value) => clampRejoinSeconds(value),
    scriptMaxSpeed: (value) => clampMaxSpeed(value),
    scriptInvert: (value) => resolveInvert(value),
    scriptSmoothing: (value) => resolveSmoothing(value),
    scriptSecondChannel: (value) => resolveSecondChannel(value),
    scriptVideoEnd: (value) => resolveVideoEnd(value),

    learningProfile: sanitizeLearningProfile
};

// Run every sanitizer over a settings object, in place. Returns the names
// whose value the pass changed, which is what an import needs in order to
// say how many of the values in a file it could actually take.
export function applySettingSchema(settings) {
    const corrected = [];
    if (!isPlainObject(settings)) return corrected;
    for (const [name, sanitize] of Object.entries(SETTING_SANITIZERS)) {
        if (!Object.prototype.hasOwnProperty.call(settings, name)) continue;
        const before = settings[name];
        const after = sanitize(before);
        settings[name] = after;
        if (JSON.stringify(after) !== JSON.stringify(before)) corrected.push(name);
    }
    return corrected;
}

// The same pass without mutating: what the app would store for this value.
export function sanitizeSetting(name, value) {
    const sanitize = SETTING_SANITIZERS[name];
    return sanitize ? sanitize(value) : undefined;
}
