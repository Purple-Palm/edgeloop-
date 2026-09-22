// The Backup file: what an export carries, and what an import is allowed to
// put back. Pure data shaping - no DOM, no storage - so every rule below runs
// under node:test.
//
// Why this module exists: Export wrote the advancedSettings blob and nothing
// else, while the Handy connection key, the Handy channel role and speed cap,
// the Intiface / TCode device maps and the two "already seen this" flags each
// live in their own localStorage entry. A restore therefore came back without
// the connection key (X333 reported exactly that), without the device maps,
// and - the sharpest edge - with a Handy speed cap silently back at 100%.
//
// Two rules shape everything here:
//
// 1. The connection key is a bearer credential. Whoever holds the string can
//    drive that Handy from anywhere, with no second factor and no way to
//    revoke it from the app. So it goes into the file only when the user asks
//    for it at export time, the file says in plain words which kind it is,
//    and the download is named differently when the key is in it. A file with
//    no key still says so, so an export can never again be SILENTLY
//    incomplete - that was the other half of the report.
// 2. Nothing in a file is trusted. A name this version does not have is
//    dropped rather than merged, in both directions: the old import was a
//    bare Object.assign, so an unknown top-level field landed inside the
//    settings store and rode along in every later export, and a credential
//    that got in that way would outlive the user deleting it from the Handy
//    panel. Every value this module itself restores - the key, the roles,
//    the caps, the device maps, the learning profile - is type-checked and
//    clamped here. The VALUES of the allow-listed Session Setup fields are
//    not clamped here: they go through exactly the sanitizers a typed value
//    goes through (session-rules.sanitizeSessionLimits and the clamps in
//    syncGuardSettings / syncWatchdogSettings, applied by app.js on the same
//    pass), which is the only place those bounds are defined. So an
//    allow-listed name still carries the user's own value into the store and
//    out again - that is what a settings backup is - but it can be neither a
//    name this build never wrote nor a value the app itself would refuse.

// The factory field list, captured at module load in state.js. It is the
// allow-list for both directions: this version writes the names it knows and
// reads back the names it knows, so a file can no more inject a field into
// the settings store than a polluted store can carry one out.
import { SETTING_KEYS } from './state.js';

export const BACKUP_FORMAT = 'edgeloop-backup';

// File format version. 1 is the bare advancedSettings blob older builds
// wrote: it has no marker at all, which is how it is recognised.
export const BACKUP_VERSION = 2;
export const LEGACY_VERSION = 1;

// A Handy connection key is a short token. Bound the length so a hand-edited
// file cannot hand the device API a novel, and refuse anything outside
// printable ASCII: the key is sent as an HTTP header (X-Connection-Key), and
// a newline in a header value is not a key by any reading.
export const MAX_CONNECTION_KEY_LENGTH = 128;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

// Mirrors the caps the two hardware drivers keep on their own stores.
export const MAX_SAVED_DEVICES = 32;
export const MAX_AXES_PER_DEVICE = 64;
export const MAX_DEVICE_KEY_LENGTH = 200;
export const MAX_DEVICE_NAME_LENGTH = 120;

// Bounds for the learning profile carried inside the settings object. The
// offset cap mirrors the one the "I came early" button enforces; the HR pair
// is the same plausibility window a typed limit gets.
export const MAX_LEARNED_OFFSET_BPM = 30;
const MIN_PLAUSIBLE_HR = 30;
const MAX_PLAUSIBLE_HR = 250;

export const AXIS_ROLES = ['primary', 'secondary', 'off'];
export const HANDY_ROLES = ['primary', 'secondary', 'off'];

// Intiface alternation window (intiface.js keeps the same bounds); 0 = off.
export const ALTERNATE_SECONDS_MIN = 5;
export const ALTERNATE_SECONDS_MAX = 60;

export const FILENAME_PLAIN = 'edgeloop_settings.json';
export const FILENAME_WITH_KEY = 'edgeloop_settings_with_key.json';

// The first thing a human sees on opening the file.
export const NOTE_WITH_KEY = 'WARNING: this file contains your Handy connection key. Anyone who has this file can control your Handy from anywhere, without any password. Do not mail it, upload it or post it.';
export const NOTE_WITHOUT_KEY = 'This file does NOT contain your Handy connection key. Tick "Include my Handy connection key" in the Backup tab before exporting if you want it carried over.';
// Telling someone to tick a box they did tick is worse than saying nothing.
// These two are for the export that was asked to carry the key and could
// not, and they match what the panel says at the same instant.
export const NOTE_KEY_NONE_SAVED = 'This file does NOT contain your Handy connection key: you asked for it, but no key is saved in this browser. Enter it in the Handy panel and export again.';
export const NOTE_KEY_UNUSABLE = 'This file does NOT contain your Handy connection key: you asked for it, but what is saved in this browser is not a usable key. Re-enter it in the Handy panel and export again.';

// Top-level field names the file itself uses. They are never settings, so
// they are stripped from the settings object both on the way out and on the
// way in - and from the live settings store too, to clean up after the build
// whose Object.assign merged them in.
// Field names this build has retired. They are dropped in silence rather
// than counted as unrecognised: `customProfiles` was declared in the
// defaults and read by nothing at all, so every backup written before it
// was removed carries it, and telling those users a field "was skipped"
// would be a warning about nothing on the commonest upgrade path there is.
export const RETIRED_SETTING_KEYS = ['customProfiles'];

export const RESERVED_SETTING_KEYS = [
    'format',
    'version',
    'exportedAt',
    'note',
    'settings',
    'handy',
    'devices',
    'flags',
    'handyConnectionKey',
    'handyConnectionKeyIncluded'
];

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function joinList(items) {
    if (items.length <= 1) return items[0] || '';
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ---- field sanitizers ---------------------------------------------------------

// A key or null. Null means "no usable key in this file"; the caller must
// then leave whatever is saved alone rather than write an empty string.
export function sanitizeConnectionKey(value) {
    if (typeof value !== 'string') return null;
    const key = value.trim();
    if (!key || key.length > MAX_CONNECTION_KEY_LENGTH) return null;
    if (!PRINTABLE_ASCII.test(key)) return null;
    return key;
}

export function sanitizeHandyRole(value) {
    return HANDY_ROLES.includes(value) ? value : null;
}

// Every cap in this app - the Handy speed cap and each per-axis cap - is a
// slider of `min=10 max=100 step=5`, so those are the only values the app
// itself can write. A restored cap is snapped onto that grid, DOWNWARDS, so
// the slider, the label, the store and the driver all show the same number
// and a later nudge of the slider cannot silently commit a different one.
// Rounding down means a hand-edited 37 restores as 35 rather than 40: of the
// two representable neighbours, the slower one is the one to pick. Below the
// grid there is nothing to round down to, so 3 becomes the app's own floor
// of 10; a cap that low cannot be typed here in the first place, and "off"
// is a channel role, not a cap.
// Null is never turned into 100: inventing a cap would be inventing the
// permissive one, and a missing cap must leave the saved cap untouched.
export const MIN_CAP_PERCENT = 10;
export const CAP_STEP_PERCENT = 5;

export function sanitizeMaxCap(value) {
    const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n)) return null;
    const bounded = Math.max(MIN_CAP_PERCENT, Math.min(100, n));
    return Math.floor(bounded / CAP_STEP_PERCENT) * CAP_STEP_PERCENT;
}

// An axis entry keeps only what the drivers read back. An unreadable role or
// cap is OMITTED rather than defaulted, so the driver's own default for that
// device applies instead of a value this file never really carried.
function sanitizeAxis(raw) {
    if (!isPlainObject(raw)) return null;
    const axis = { invert: raw.invert === true };
    if (AXIS_ROLES.includes(raw.role)) axis.role = raw.role;
    const cap = sanitizeMaxCap(raw.maxCap);
    if (cap !== null) axis.maxCap = cap;
    return axis;
}

function sanitizeDevice(raw, { extras }) {
    if (!isPlainObject(raw)) return null;
    const axes = {};
    if (isPlainObject(raw.axes)) {
        for (const key of Object.keys(raw.axes).slice(0, MAX_AXES_PER_DEVICE)) {
            if (key.length > MAX_DEVICE_KEY_LENGTH) continue;
            const axis = sanitizeAxis(raw.axes[key]);
            if (axis) axes[key] = axis;
        }
    }
    const device = { axes };
    if (extras) {
        if (typeof raw.name === 'string' && raw.name.trim()) {
            device.name = raw.name.trim().slice(0, MAX_DEVICE_NAME_LENGTH);
        }
        device.reverseOnEdge = raw.reverseOnEdge !== false;
        const alternate = Number(raw.alternateSeconds);
        device.alternateSeconds = Number.isFinite(alternate) && alternate > 0
            ? Math.max(ALTERNATE_SECONDS_MIN, Math.min(ALTERNATE_SECONDS_MAX, Math.round(alternate)))
            : 0;
    }
    const savedAt = Number(raw.savedAt);
    device.savedAt = Number.isFinite(savedAt) && savedAt > 0 ? Math.round(savedAt) : 0;
    return device;
}

// Keep the newest MAX_SAVED_DEVICES entries, exactly as the drivers do when
// their own store grows, so an import can never push a store past the cap.
// `protect` are the keys the file just restored: they go last in the queue
// to be dropped, because an import that announces "1 device map restored"
// and then trims that very map back out is a lie in two directions at once.
// savedAt is read defensively - the existing store comes straight out of
// localStorage and can hold anything, and a throw here would surface as
// "this backup could not be applied" after the settings were already in.
function trimToNewest(map, limit = MAX_SAVED_DEVICES, protect = new Set()) {
    const keys = Object.keys(map);
    if (keys.length <= limit) return map;
    const age = (key) => Number(map[key] && map[key].savedAt) || 0;
    keys.sort((a, b) => {
        const pa = protect.has(a) ? 1 : 0;
        const pb = protect.has(b) ? 1 : 0;
        if (pa !== pb) return pa - pb;
        return age(a) - age(b);
    });
    const trimmed = { ...map };
    keys.slice(0, keys.length - limit).forEach((key) => { delete trimmed[key]; });
    return trimmed;
}

// `extras` = the Intiface shape (device name, reverseOnEdge, alternateSeconds);
// the TCode store keys devices by name and carries axes only.
export function sanitizeDeviceMap(raw, { extras = false } = {}) {
    if (!isPlainObject(raw)) return {};
    const out = {};
    for (const key of Object.keys(raw)) {
        if (!key || key.length > MAX_DEVICE_KEY_LENGTH) continue;
        const device = sanitizeDevice(raw[key], { extras });
        if (device) out[key] = device;
    }
    return trimToNewest(out);
}

// Restoring a device map must not wipe the maps for toys the file never knew
// about: the file wins per device, everything else is kept.
export function mergeDeviceMaps(existing, incoming) {
    const base = isPlainObject(existing) ? { ...existing } : {};
    const add = isPlainObject(incoming) ? incoming : {};
    for (const key of Object.keys(add)) base[key] = add[key];
    return trimToNewest(base, MAX_SAVED_DEVICES, new Set(Object.keys(add)));
}

// How many maps a merge had to drop to stay under the cap. The import says
// so out loud rather than letting a toy quietly lose its axis map.
export function countDroppedOnMerge(existing, incoming) {
    const base = isPlainObject(existing) ? Object.keys(existing) : [];
    const add = isPlainObject(incoming) ? Object.keys(incoming) : [];
    const union = new Set([...base, ...add]).size;
    return Math.max(0, union - Object.keys(mergeDeviceMaps(existing, incoming)).length);
}

// Delete the file's own field names from a live settings object. Returns the
// names removed, so a caller can log or test that the cleanup happened.
export function pruneReservedKeys(settings) {
    if (!isPlainObject(settings)) return [];
    const removed = [];
    for (const name of RESERVED_SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(settings, name)) {
            delete settings[name];
            removed.push(name);
        }
    }
    return removed;
}

// Keep only the field names this version actually has. `allowed` defaults to
// the factory list; tests pass their own. Returns the kept object and the
// names dropped, because an import that silently ate two fields is the same
// kind of quiet as the export that silently left the key out.
export function filterSettings(raw, allowed = SETTING_KEYS) {
    const keep = allowed instanceof Set ? allowed : new Set(allowed || []);
    const settings = {};
    const unknown = [];
    const retired = [];
    if (!isPlainObject(raw)) return { settings, unknown, retired };
    for (const [name, value] of Object.entries(raw)) {
        if (RESERVED_SETTING_KEYS.includes(name)) continue;
        if (RETIRED_SETTING_KEYS.includes(name)) { retired.push(name); continue; }
        if (!keep.has(name)) { unknown.push(name); continue; }
        settings[name] = value;
    }
    return { settings, unknown, retired };
}

// The learning profile is the one setting the engine reads as a structure
// rather than a number, and the only one an import shows back to the user in
// words. Clamp it to the same bounds the "I came early" button can produce
// (offset 0-30 BPM, never negative - a negative one would RAISE the working
// ceiling), or return null so the profile already in this browser is kept.
export function sanitizeLearningProfile(raw) {
    if (!isPlainObject(raw)) return null;
    const events = Number(raw.breakthroughEvents);
    const offset = Number(raw.suggestedMaxHrOffset);
    const last = Number(raw.lastBreakthroughHr);
    return {
        breakthroughEvents: Number.isFinite(events) ? Math.max(0, Math.min(9999, Math.round(events))) : 0,
        suggestedMaxHrOffset: Number.isFinite(offset) ? Math.max(0, Math.min(MAX_LEARNED_OFFSET_BPM, Math.round(offset))) : 0,
        lastBreakthroughHr: Number.isFinite(last) && last >= MIN_PLAUSIBLE_HR && last <= MAX_PLAUSIBLE_HR ? Math.round(last) : null
    };
}

// ---- writing ------------------------------------------------------------------

// Build the file. `stores` is what the app read out of its localStorage
// entries; `includeKey` is the checkbox under the Export button.
export function buildBackup(stores = {}, options = {}) {
    const includeKey = options.includeKey === true;
    const key = sanitizeConnectionKey(stores.handyConnectionKey);
    const carriesKey = includeKey && key !== null;
    // Write the fields this version has and nothing else. That covers the
    // file's own field names (a build that merged a stray handyConnectionKey
    // into the settings store would otherwise export that copy of the
    // credential for ever) and anything else an older import let in.
    const { settings } = filterSettings(stores.settings, options.allowedSettingKeys || SETTING_KEYS);

    const handy = {};
    const role = sanitizeHandyRole(stores.handyRole);
    if (role) handy.role = role;
    const maxCap = sanitizeMaxCap(stores.handyMaxCap);
    if (maxCap !== null) handy.maxCap = maxCap;

    const now = Number.isFinite(options.now) ? options.now : Date.now();
    // The note is the first thing in the file, so opening it in any editor
    // answers "is my key in this?" on line 2 without scrolling or knowing
    // the format. The reader does not care about key order.
    return {
        note: backupNote(carriesKey, includeKey, stores.handyConnectionKey),
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date(now).toISOString(),
        handyConnectionKeyIncluded: carriesKey,
        handyConnectionKey: carriesKey ? key : null,
        settings,
        handy,
        devices: {
            intiface: sanitizeDeviceMap(stores.intifaceDevices, { extras: true }),
            tcode: sanitizeDeviceMap(stores.tcodeDevices, { extras: false })
        },
        flags: {
            ageVerified: stores.ageVerified === true,
            wizardSeen: stores.wizardSeen === true
        }
    };
}

// Which of the four notes belongs in the file. It answers the same question
// the panel answers, from the same three facts, so the two can never
// disagree - they did: a file exported WITH the box ticked but no usable key
// still told the user to tick the box.
export function backupNote(carriesKey, requestedKey, savedKey) {
    if (carriesKey) return NOTE_WITH_KEY;
    if (requestedKey !== true) return NOTE_WITHOUT_KEY;
    const raw = typeof savedKey === 'string' ? savedKey.trim() : '';
    return raw ? NOTE_KEY_UNUSABLE : NOTE_KEY_NONE_SAVED;
}

// The filename carries the warning into the mail client.
export function backupFilename(file) {
    return file && file.handyConnectionKeyIncluded === true ? FILENAME_WITH_KEY : FILENAME_PLAIN;
}

// What the panel says the moment the file is written, so the answer to "is my
// key in this?" is on screen before the file goes anywhere.
export function describeBackupExport(file, context = {}) {
    const carriesKey = Boolean(file && file.handyConnectionKeyIncluded === true);
    const filename = backupFilename(file);
    if (carriesKey) {
        return {
            filename,
            carriesKey: true,
            tone: 'warn',
            message: `Exported ${filename}. This file CONTAINS your Handy connection key: anyone who has the file can control your Handy. Keep it off shared drives and out of forum posts.`
        };
    }
    if (context.requestedKey === true) {
        // "Nothing was saved" and "what is saved is not a usable key" are
        // different answers, and only the second one asks the user to do
        // something. Saying the first when the second is true would be the
        // silently incomplete export all over again.
        return {
            filename,
            carriesKey: false,
            tone: context.hasSavedKey === true ? 'warn' : 'info',
            message: context.hasSavedKey === true
                ? `Exported ${filename}. The Handy connection key saved in this browser is not a usable key (it must be plain printable text, at most ${MAX_CONNECTION_KEY_LENGTH} characters), so nothing was put in the file. Re-enter it in the Handy panel and export again.`
                : `Exported ${filename}. No Handy connection key is saved in this browser, so none was included.`
        };
    }
    return {
        filename,
        carriesKey: false,
        tone: 'info',
        message: `Exported ${filename}. Your Handy connection key is NOT in it; tick the box above before exporting if you want it carried over.`
    };
}

// ---- reading ------------------------------------------------------------------

// Read a parsed file of either shape. Returns everything the app should put
// back, already clamped, plus enough about what was in the file for the
// import to describe itself honestly.
export function readBackup(parsed, options = {}) {
    if (!isPlainObject(parsed)) {
        return {
            ok: false,
            error: Array.isArray(parsed)
                ? 'the file holds a JSON list, and a backup is a JSON object'
                : 'the file is not a JSON object'
        };
    }

    // A versioned file is one that SAYS so. Everything else is read as the
    // bare advancedSettings blob older builds wrote, which stays importable.
    // The marker alone decides: a file whose settings block is missing or
    // corrupt is still that file, and demoting it to the legacy path would
    // drop its role, caps, device maps and flags without a word - while
    // telling the user it "has no version marker", which it plainly has.
    const versionNumber = Number(parsed.version);
    // Two things have to be true. The file has to SAY it is a backup, and
    // it has to have the shape of one. Either test alone gets a real file
    // wrong: on the declaration alone, a legacy blob that picked up a
    // stray `format` field from the old Object.assign import (exactly the
    // pollution this change exists to stop) is read as an envelope and its
    // settings vanish; on the settings block alone, a declared backup whose
    // settings block is damaged is demoted to legacy and silently loses its
    // role, caps, device maps and flags.
    const declaresItself = parsed.format === BACKUP_FORMAT || Number.isFinite(versionNumber);
    const hasEnvelopeBody = ['settings', 'handy', 'devices', 'flags'].some((name) => parsed[name] !== undefined)
        || parsed.handyConnectionKeyIncluded !== undefined;
    const enveloped = declaresItself && hasEnvelopeBody;
    const version = enveloped && Number.isFinite(versionNumber) ? Math.round(versionNumber) : (enveloped ? BACKUP_VERSION : LEGACY_VERSION);
    // Declared as a backup, but the settings block is not readable.
    const settingsUnreadable = enveloped && parsed.settings !== undefined && !isPlainObject(parsed.settings);

    const rawSettings = enveloped ? (isPlainObject(parsed.settings) ? parsed.settings : {}) : parsed;
    const { settings, unknown: unknownSettingKeys, retired: retiredSettingKeys } = filterSettings(
        rawSettings,
        options.allowedSettingKeys || SETTING_KEYS
    );
    // The profile is a structure, so it is clamped here rather than by the
    // numeric sanitizers the rest of the settings pass through on the way in.
    // An unreadable one is dropped, which leaves this browser's own profile
    // in place - the same rule the connection key follows.
    // Fields this module corrected itself. The caller counts what survived
    // by comparing the store against `settings`, and a field corrected here
    // would compare equal and read as a clean restore.
    const clampedSettingKeys = [];
    if (Object.prototype.hasOwnProperty.call(settings, 'learningProfile')) {
        const before = JSON.stringify(settings.learningProfile);
        const profile = sanitizeLearningProfile(settings.learningProfile);
        if (profile) {
            settings.learningProfile = profile;
            if (JSON.stringify(profile) !== before) clampedSettingKeys.push('learningProfile');
        } else {
            delete settings.learningProfile;
        }
    }

    // The key is read from the top level in BOTH shapes. In a legacy file it
    // can only be there because an older import merged it into the settings
    // store and the next export carried it out again - it is still that
    // user's own key, and the import says out loud that it found one.
    const rawKey = parsed.handyConnectionKey;
    const handyConnectionKey = sanitizeConnectionKey(rawKey);
    // An empty or blank string is how a file says "no key", the same as a
    // null or a missing field; only something that is there and unusable
    // counts as rejected.
    const keyBlank = rawKey === undefined || rawKey === null
        || (typeof rawKey === 'string' && rawKey.trim() === '');
    const keyRejected = !keyBlank && handyConnectionKey === null;

    const handySource = enveloped && isPlainObject(parsed.handy) ? parsed.handy : {};
    const handy = {
        role: sanitizeHandyRole(handySource.role),
        maxCap: sanitizeMaxCap(handySource.maxCap)
    };

    const deviceSource = enveloped && isPlainObject(parsed.devices) ? parsed.devices : {};
    const devices = {
        intiface: sanitizeDeviceMap(deviceSource.intiface, { extras: true }),
        tcode: sanitizeDeviceMap(deviceSource.tcode, { extras: false })
    };

    const flagSource = enveloped && isPlainObject(parsed.flags) ? parsed.flags : {};
    const flags = {
        ageVerified: flagSource.ageVerified === true,
        wizardSeen: flagSource.wizardSeen === true
    };

    const carriesSomething = Object.keys(settings).length > 0
        || settingsUnreadable
        || handy.role !== null
        || handy.maxCap !== null
        || Object.keys(devices.intiface).length > 0
        || Object.keys(devices.tcode).length > 0
        || flags.ageVerified
        || flags.wizardSeen
        || handyConnectionKey !== null;
    if (!carriesSomething) {
        return {
            ok: false,
            error: unknownSettingKeys.length
                ? `nothing in it is an EdgeLoop setting this version knows (it carries ${unknownSettingKeys.length} unrecognised field${unknownSettingKeys.length === 1 ? '' : 's'})`
                : 'it carries no EdgeLoop settings at all'
        };
    }

    return {
        ok: true,
        version,
        legacy: !enveloped,
        futureVersion: version > BACKUP_VERSION,
        settings,
        clampedSettingKeys,
        unknownSettingKeys,
        retiredSettingKeys,
        settingsUnreadable,
        handy,
        devices,
        flags,
        handyConnectionKey,
        keyPresent: handyConnectionKey !== null,
        keyRejected,
        // The file explicitly said it left the key out (as opposed to being
        // too old to have an opinion).
        keyDeclaredAbsent: enveloped && parsed.handyConnectionKeyIncluded === false
    };
}

// The parts an import restores, each with the words the message uses for
// it. The caller reports a refused write by NAME from this list rather
// than by prose, so the two lists can never disagree: a part whose write
// the browser refused is named as lost and is not also named as restored.
export const RESTORE_PARTS = {
    settings: 'your Session Setup values',
    key: 'your Handy connection key',
    role: 'the Handy channel role',
    cap: 'the Handy speed cap',
    intiface: 'your Intiface device maps',
    tcode: 'your T-Code device maps',
    flags: 'the age / wizard flags'
};

// What the import tells the user it did. It names every part it restored and
// always answers the key question, because "did my key come back?" was the
// question the silent export left the reporter to answer by hand.
export function describeBackupImport(result, context = {}) {
    if (!result || result.ok !== true) {
        // Say which way it is wrong. "Invalid configuration file." was the
        // same sentence for a photo, a half-written file and a backup from a
        // newer build, and only one of those is worth a second attempt.
        const reason = result && typeof result.error === 'string' ? result.error : '';
        return reason
            ? `This is not an EdgeLoop backup: ${reason}. Pick the .json the Backup tab writes with Export.`
            : 'This is not an EdgeLoop backup. Pick the .json the Backup tab writes with Export.';
    }
    // Parts the browser refused to save. They are named as lost, once,
    // and never also named as restored.
    const refused = new Set((Array.isArray(context.unsaved) ? context.unsaved : []).filter((id) => RESTORE_PARTS[id]));
    const restored = [];
    // What the file offered, and what was still there after the app's own
    // clamps had their say. `stored` is supplied by the caller, which is the
    // only place that can know: a pair like minHr 5 / maxHr 9999 is refused
    // by sanitizeSessionLimits and comes back at the factory numbers, and
    // announcing "2 values imported" over two defaults is the same kind of
    // quiet the silent export was.
    const offered = Object.keys(result.settings).length;
    const settingsCount = Number.isFinite(context.settingsStored) ? Math.min(context.settingsStored, offered) : offered;
    if (settingsCount && !refused.has('settings')) restored.push(`${settingsCount} Session Setup value${settingsCount === 1 ? '' : 's'}`);
    const roleIn = Boolean(result.handy.role) && !refused.has('role');
    const capIn = result.handy.maxCap !== null && !refused.has('cap');
    if (roleIn && capIn) restored.push('the Handy channel role and speed cap');
    else if (roleIn) restored.push('the Handy channel role');
    else if (capIn) restored.push('the Handy speed cap');
    const intiface = refused.has('intiface') ? 0 : Object.keys(result.devices.intiface).length;
    if (intiface) restored.push(`${intiface} Intiface device map${intiface === 1 ? '' : 's'}`);
    const tcode = refused.has('tcode') ? 0 : Object.keys(result.devices.tcode).length;
    if (tcode) restored.push(`${tcode} T-Code device map${tcode === 1 ? '' : 's'}`);
    // The flags are restored too, so they are named too. "Settings imported"
    // over a file that only carried a flag was a sentence about nothing.
    if ((result.flags.ageVerified || result.flags.wizardSeen) && !refused.has('flags')) restored.push('the age / wizard flags');

    const lines = [];
    // A refused write comes first: it changes what every line below means.
    // safeSet and persistSettings both report whether the browser took the
    // write, and a full or blocked store is a live condition in this app -
    // session history is what fills it. Saying "restored" over a store that
    // refused the write would promise a restore that a reload undoes.
    const unsaved = [...refused].map((id) => RESTORE_PARTS[id]);
    if (unsaved.length) {
        lines.push(`THIS BROWSER REFUSED TO SAVE ${joinList(unsaved)}. It is in use right now, but a reload will lose it - the store is full or unavailable (private mode, or blocked site data). Free some space, or delete old sessions from History, and import again.`);
    }

    if (restored.length) lines.push(`Settings imported: ${joinList(restored)}.`);
    else lines.push('Nothing in this file changed a setting here.');
    // Said whenever Session Setup is untouched, even if something else came
    // back: "Settings imported: the age / wizard flags" is true but leaves
    // the obvious question - what happened to my settings? - unanswered.
    if (!settingsCount && !offered && restored.length && !refused.has('settings')) {
        lines.push('This file carried no Session Setup values, so nothing in Session Setup changed.');
    }

    const adjusted = refused.has('settings') ? 0 : offered - settingsCount;
    if (adjusted > 0) {
        // Not "came back at their safe default": what the app does with a
        // value it will not take depends on the value. 9999 seconds of
        // stall guard comes back at the 120-second maximum, not at the
        // 20-second factory setting, and telling someone it reverted to the
        // default would send them looking for a number that is not there.
        lines.push(`${adjusted} value${adjusted === 1 ? '' : 's'} in the file ${adjusted === 1 ? 'was' : 'were'} outside what this app accepts, so ${adjusted === 1 ? 'it' : 'they'} came back at the nearest value it does - a limit, or the factory setting. It is the same check a value typed into the panel gets; open Session Setup to see where ${adjusted === 1 ? 'it' : 'they'} landed.`);
    }

    if (result.keyPresent && refused.has('key')) {
        // The refusal line above already named it; do not also say it was
        // restored, and say what it means for the pairing.
        lines.push('The Handy connection key in this file is in use right now but was not saved, so this browser goes back to the key it had (or to none) when you reload.');
    } else if (result.keyPresent && context.keyReplaced === true) {
        // Restoring an older or a borrowed backup re-pairs this browser with
        // a different Handy. That is what the file asked for, but it is not
        // something to discover later by wondering why Connect fails.
        lines.push('The Handy connection key saved in this browser was REPLACED by the one in this file - they are different keys. If you did not mean to re-pair this browser, enter your own key again in the Handy panel. Nothing is connected either way.');
    } else if (result.keyPresent) {
        lines.push('Your Handy connection key was restored. Open the Handy panel and press Connect when you want to use it - an import never connects a toy by itself.');
    } else if (result.keyRejected) {
        lines.push(context.hadExistingKey
            ? 'What this file carried in place of a Handy connection key is not a usable key, so it was ignored and the one saved here was kept.'
            : 'What this file carried in place of a Handy connection key is not a usable key, so it was ignored. Enter yours in the Handy panel.');
    } else if (result.keyDeclaredAbsent) {
        // The file says in its own words that it was exported without one.
        lines.push(context.hadExistingKey
            ? 'This file was exported without a Handy connection key, so the one saved in this browser was kept.'
            : 'This file was exported without a Handy connection key. Enter yours in the Handy panel, or export again with the box ticked on the machine that has it.');
    } else if (context.hadExistingKey) {
        lines.push('This file contained no Handy connection key, so the one saved in this browser was kept.');
    } else {
        lines.push('This file contained no Handy connection key. Enter yours in the Handy panel.');
    }

    if (result.settingsUnreadable) {
        lines.push('The Session Setup block in this file is damaged and could not be read; everything else in it was restored.');
    }

    const skipped = Array.isArray(result.unknownSettingKeys) ? result.unknownSettingKeys.length : 0;
    if (skipped) {
        lines.push(`${skipped} field${skipped === 1 ? '' : 's'} in the file ${skipped === 1 ? 'is' : 'are'} not a setting this version has, so ${skipped === 1 ? 'it was' : 'they were'} skipped rather than stored.`);
    }

    if (intiface || tcode) {
        lines.push('A toy that is connected right now keeps the axis map it is already running; reconnect it to pick up the restored one.');
    }
    const dropped = Number(context.droppedDeviceMaps) || 0;
    if (dropped > 0) {
        lines.push(`${dropped} of the device maps already saved here had to be dropped to stay within the ${MAX_SAVED_DEVICES}-device limit; the oldest went first, and the ones from this file were kept.`);
    }
    if (result.legacy) {
        lines.push('This file has no version marker, so it was read as an older, settings-only backup.');
    }
    if (result.futureVersion) {
        lines.push(`This file was written by a newer EdgeLoop (format version ${result.version}); anything this version does not know was skipped.`);
    }
    lines.push('Session history is never carried in a backup and was left as it is.');
    return lines.join('\n\n');
}
