import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    BACKUP_FORMAT,
    BACKUP_VERSION,
    LEGACY_VERSION,
    MAX_CONNECTION_KEY_LENGTH,
    MAX_SAVED_DEVICES,
    FILENAME_PLAIN,
    FILENAME_WITH_KEY,
    NOTE_WITH_KEY,
    NOTE_WITHOUT_KEY,
    RESERVED_SETTING_KEYS,
    sanitizeConnectionKey,
    sanitizeHandyRole,
    sanitizeMaxCap,
    sanitizeDeviceMap,
    mergeDeviceMaps,
    pruneReservedKeys,
    buildBackup,
    backupFilename,
    describeBackupExport,
    readBackup,
    describeBackupImport,
    filterSettings,
    sanitizeLearningProfile,
    MAX_LEARNED_OFFSET_BPM
} from './backup.js';
import { advancedSettings, SETTING_KEYS } from './state.js';

const KEY = 'AUDITKEY-9f3c21';

const STORES = {
    settings: {
        minHr: 70, maxHr: 140, handyHwMin: 10, handyHwMax: 90,
        learningProfile: { breakthroughEvents: 2, suggestedMaxHrOffset: 6, lastBreakthroughHr: 132 }
    },
    handyRole: 'secondary',
    handyMaxCap: 65,
    handyConnectionKey: KEY,
    intifaceDevices: {
        'Lovense Nora:1': {
            name: 'Lovense Nora',
            axes: { 'scalar:0': { role: 'secondary', maxCap: 80, invert: false }, 'rotate:0': { role: 'primary', maxCap: 55, invert: true } },
            reverseOnEdge: true,
            alternateSeconds: 12,
            savedAt: 1700000000000
        }
    },
    tcodeDevices: {
        'OSR2 v3.3': {
            axes: { L0: { role: 'primary', maxCap: 90, invert: true }, V0: { role: 'secondary', maxCap: 40, invert: false } },
            savedAt: 1700000000001
        }
    },
    ageVerified: true,
    wizardSeen: true
};

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

describe('the connection key is bounded before it can reach the device API', () => {
    it('accepts a plain key and trims it', () => {
        assert.equal(sanitizeConnectionKey('  12345678 '), '12345678');
    });

    it('refuses anything that is not a string', () => {
        for (const junk of [null, undefined, 42, {}, [], true, { toString: () => 'k' }]) {
            assert.equal(sanitizeConnectionKey(junk), null);
        }
    });

    it('refuses an empty or whitespace-only key rather than saving a blank', () => {
        assert.equal(sanitizeConnectionKey(''), null);
        assert.equal(sanitizeConnectionKey('   '), null);
    });

    it('refuses a key longer than the bound instead of truncating it', () => {
        const long = 'k'.repeat(MAX_CONNECTION_KEY_LENGTH + 1);
        assert.equal(sanitizeConnectionKey(long), null);
        assert.equal(sanitizeConnectionKey('k'.repeat(MAX_CONNECTION_KEY_LENGTH)), 'k'.repeat(MAX_CONNECTION_KEY_LENGTH));
    });

    it('refuses a key carrying a newline: it is sent as an HTTP header', () => {
        assert.equal(sanitizeConnectionKey('abc\r\nX-Injected: 1'), null);
        assert.equal(sanitizeConnectionKey('abc def'), null);
        assert.equal(sanitizeConnectionKey('abc\u0000'), null);
        assert.equal(sanitizeConnectionKey('ключ'), null);
    });
});

describe('the Handy role and speed cap are clamped, never invented', () => {
    it('keeps the three real roles and nothing else', () => {
        assert.equal(sanitizeHandyRole('primary'), 'primary');
        assert.equal(sanitizeHandyRole('secondary'), 'secondary');
        assert.equal(sanitizeHandyRole('off'), 'off');
        for (const junk of ['PRIMARY', 'boss', '', null, 3, {}]) assert.equal(sanitizeHandyRole(junk), null);
    });

    it('clamps a cap into 0-100 whole percent', () => {
        assert.equal(sanitizeMaxCap(65), 65);
        assert.equal(sanitizeMaxCap('65'), 65);
        assert.equal(sanitizeMaxCap(64.6), 65);
        assert.equal(sanitizeMaxCap(1e9), 100);
        assert.equal(sanitizeMaxCap(-40), 0);
    });

    it('reports a missing cap as null so nothing restores a 100% cap by accident', () => {
        for (const junk of [null, undefined, 'fast', NaN, Infinity, {}]) assert.equal(sanitizeMaxCap(junk), null);
        const read = readBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION, settings: { minHr: 70 }, handy: { maxCap: 'fast' } });
        assert.equal(read.handy.maxCap, null);
    });
});

describe('device maps survive the round trip and hostile ones are declawed', () => {
    it('keeps the Intiface shape whole', () => {
        const map = sanitizeDeviceMap(STORES.intifaceDevices, { extras: true });
        assert.deepEqual(map['Lovense Nora:1'], {
            axes: {
                'scalar:0': { invert: false, role: 'secondary', maxCap: 80 },
                'rotate:0': { invert: true, role: 'primary', maxCap: 55 }
            },
            name: 'Lovense Nora',
            reverseOnEdge: true,
            alternateSeconds: 12,
            savedAt: 1700000000000
        });
    });

    it('keeps the TCode shape whole', () => {
        const map = sanitizeDeviceMap(STORES.tcodeDevices, { extras: false });
        assert.deepEqual(map['OSR2 v3.3'], {
            axes: { L0: { invert: true, role: 'primary', maxCap: 90 }, V0: { invert: false, role: 'secondary', maxCap: 40 } },
            savedAt: 1700000000001
        });
    });

    it('clamps an axis cap and drops a role the drivers do not know', () => {
        const map = sanitizeDeviceMap({ dev: { axes: { L0: { role: 'boss', maxCap: 400, invert: 'yes' } }, savedAt: 5 } });
        assert.deepEqual(map.dev.axes.L0, { invert: false, maxCap: 100 });
        assert.ok(!('role' in map.dev.axes.L0), 'an unreadable role must fall through to the driver default');
    });

    it('clamps the alternation window and keeps 0 meaning off', () => {
        const map = sanitizeDeviceMap({ d: { axes: {}, alternateSeconds: 900 }, e: { axes: {}, alternateSeconds: 0 }, f: { axes: {}, alternateSeconds: 1 } }, { extras: true });
        assert.equal(map.d.alternateSeconds, 60);
        assert.equal(map.e.alternateSeconds, 0);
        assert.equal(map.f.alternateSeconds, 5);
    });

    it('drops junk entries instead of crashing', () => {
        const map = sanitizeDeviceMap({ a: null, b: 'nope', c: [1, 2], d: { axes: 'no' } });
        assert.deepEqual(Object.keys(map), ['d']);
        assert.deepEqual(map.d.axes, {});
        assert.deepEqual(sanitizeDeviceMap(null), {});
        assert.deepEqual(sanitizeDeviceMap([1, 2, 3]), {});
    });

    it('never pushes a store past the driver cap, keeping the newest', () => {
        const huge = {};
        for (let i = 0; i < MAX_SAVED_DEVICES + 10; i++) huge[`dev${i}`] = { axes: {}, savedAt: 1000 + i };
        const map = sanitizeDeviceMap(huge);
        assert.equal(Object.keys(map).length, MAX_SAVED_DEVICES);
        assert.ok(!('dev0' in map), 'the oldest entries go first');
        assert.ok(`dev${MAX_SAVED_DEVICES + 9}` in map);
    });

    it('merges rather than replaces, so toys the file never knew stay mapped', () => {
        const existing = { keeper: { axes: {}, savedAt: 1 }, shared: { axes: { L0: { role: 'off' } }, savedAt: 1 } };
        const incoming = { shared: { axes: { L0: { role: 'primary' } }, savedAt: 9 }, fresh: { axes: {}, savedAt: 9 } };
        const merged = mergeDeviceMaps(existing, incoming);
        assert.deepEqual(Object.keys(merged).sort(), ['fresh', 'keeper', 'shared']);
        assert.equal(merged.shared.axes.L0.role, 'primary');
    });
});

describe('the export file says what it is', () => {
    it('carries every store the audit found missing', () => {
        const file = buildBackup(STORES, { includeKey: false, now: NOW });
        assert.equal(file.format, BACKUP_FORMAT);
        assert.equal(file.version, BACKUP_VERSION);
        assert.equal(file.exportedAt, '2026-01-02T03:04:05.000Z');
        assert.equal(file.settings.maxHr, 140);
        assert.deepEqual(file.handy, { role: 'secondary', maxCap: 65 });
        assert.equal(file.devices.intiface['Lovense Nora:1'].name, 'Lovense Nora');
        assert.ok(file.devices.tcode['OSR2 v3.3']);
        assert.deepEqual(file.flags, { ageVerified: true, wizardSeen: true });
    });

    it('leaves the key out by default and says so in the file', () => {
        const file = buildBackup(STORES, { now: NOW });
        assert.equal(file.handyConnectionKeyIncluded, false);
        assert.equal(file.handyConnectionKey, null);
        assert.equal(file.note, NOTE_WITHOUT_KEY);
        assert.ok(!JSON.stringify(file).includes(KEY), 'the default file must not contain the key anywhere');
        assert.equal(backupFilename(file), FILENAME_PLAIN);
    });

    it('carries the key when it is asked for, and warns in the file and the filename', () => {
        const file = buildBackup(STORES, { includeKey: true, now: NOW });
        assert.equal(file.handyConnectionKeyIncluded, true);
        assert.equal(file.handyConnectionKey, KEY);
        assert.equal(file.note, NOTE_WITH_KEY);
        assert.equal(backupFilename(file), FILENAME_WITH_KEY);
    });

    it('cannot claim a key it does not have', () => {
        const file = buildBackup({ ...STORES, handyConnectionKey: '' }, { includeKey: true, now: NOW });
        assert.equal(file.handyConnectionKeyIncluded, false);
        assert.equal(file.handyConnectionKey, null);
        assert.equal(backupFilename(file), FILENAME_PLAIN);
        const notice = describeBackupExport(file, { requestedKey: true });
        assert.match(notice.message, /No Handy connection key is saved/);
        assert.equal(notice.carriesKey, false);
    });

    it('says a saved key was unusable rather than that none was saved', () => {
        // A key that cannot go in an HTTP header is refused, but the reason
        // the file has no key then is NOT "you never saved one" - that
        // sentence would send the user away with a silently incomplete
        // backup, which is the bug this whole file exists to close.
        const file = buildBackup({ ...STORES, handyConnectionKey: 'has a space' }, { includeKey: true, now: NOW });
        assert.equal(file.handyConnectionKeyIncluded, false);
        const notice = describeBackupExport(file, { requestedKey: true, hasSavedKey: true });
        assert.equal(notice.carriesKey, false);
        assert.equal(notice.tone, 'warn');
        assert.match(notice.message, /not a usable key/);
        assert.match(notice.message, /Re-enter it in the Handy panel/);
        assert.ok(!/No Handy connection key is saved/.test(notice.message));
    });

    it('still says nothing is saved when nothing is saved', () => {
        const file = buildBackup({ ...STORES, handyConnectionKey: '' }, { includeKey: true, now: NOW });
        const notice = describeBackupExport(file, { requestedKey: true, hasSavedKey: false });
        assert.match(notice.message, /No Handy connection key is saved/);
        assert.equal(notice.tone, 'info');
    });

    it('never writes a stray credential that an older import merged into the settings store', () => {
        const poisoned = { ...STORES, settings: { ...STORES.settings, handyConnectionKey: 'PROBE-KEY-123', version: 9 } };
        const file = buildBackup(poisoned, { now: NOW });
        assert.ok(!('handyConnectionKey' in file.settings));
        assert.ok(!('version' in file.settings));
        assert.ok(!JSON.stringify(file).includes('PROBE-KEY-123'));
    });

    it('omits a role or cap it cannot read instead of writing a default', () => {
        const file = buildBackup({ settings: {}, handyRole: 'boss', handyMaxCap: 'fast' }, { now: NOW });
        assert.deepEqual(file.handy, {});
    });

    it('describes the export in words the user can act on', () => {
        const plain = describeBackupExport(buildBackup(STORES, { now: NOW }), { requestedKey: false });
        assert.equal(plain.tone, 'info');
        assert.match(plain.message, /NOT in it/);
        assert.match(plain.message, new RegExp(FILENAME_PLAIN));
        const withKey = describeBackupExport(buildBackup(STORES, { includeKey: true, now: NOW }), { requestedKey: true });
        assert.equal(withKey.tone, 'warn');
        assert.match(withKey.message, /CONTAINS your Handy connection key/);
        assert.match(withKey.message, new RegExp(FILENAME_WITH_KEY));
    });
});

describe('the round trip the report was about', () => {
    it('brings the key back when it was included', () => {
        const file = buildBackup(STORES, { includeKey: true, now: NOW });
        const read = readBackup(JSON.parse(JSON.stringify(file)));
        assert.equal(read.ok, true);
        assert.equal(read.keyPresent, true);
        assert.equal(read.handyConnectionKey, KEY);
        assert.equal(read.version, BACKUP_VERSION);
        assert.equal(read.legacy, false);
    });

    it('brings every other store back byte for byte', () => {
        const file = buildBackup(STORES, { now: NOW });
        const read = readBackup(JSON.parse(JSON.stringify(file)));
        assert.deepEqual(read.settings, STORES.settings);
        assert.deepEqual(read.handy, { role: 'secondary', maxCap: 65 });
        assert.deepEqual(read.devices.intiface, file.devices.intiface);
        assert.deepEqual(read.devices.tcode, file.devices.tcode);
        assert.deepEqual(read.flags, { ageVerified: true, wizardSeen: true });
    });

    it('reports a key-less file as key-less rather than as an empty key', () => {
        const read = readBackup(buildBackup(STORES, { now: NOW }));
        assert.equal(read.keyPresent, false);
        assert.equal(read.handyConnectionKey, null);
        assert.equal(read.keyRejected, false);
        assert.equal(read.keyDeclaredAbsent, true, 'a modern file states that it left the key out');
    });
});

describe('an older file still imports', () => {
    it('reads a bare advancedSettings blob as settings', () => {
        const legacy = { minHr: 66, maxHr: 96, voiceCues: { edge: ['hold'] } };
        const read = readBackup(legacy);
        assert.equal(read.ok, true);
        assert.equal(read.legacy, true);
        assert.equal(read.version, LEGACY_VERSION);
        assert.deepEqual(read.settings, legacy);
        assert.equal(read.keyPresent, false);
        assert.equal(read.keyDeclaredAbsent, false, 'an old file has no opinion about the key');
        assert.deepEqual(read.handy, { role: null, maxCap: null });
        assert.deepEqual(read.devices, { intiface: {}, tcode: {} });
    });

    it('reads a key an older build had merged into the blob, and never leaves it in the settings', () => {
        const read = readBackup({ minHr: 70, handyConnectionKey: 'PROBE-KEY-123' });
        assert.equal(read.keyPresent, true);
        assert.equal(read.handyConnectionKey, 'PROBE-KEY-123');
        assert.ok(!('handyConnectionKey' in read.settings), 'the credential must never be merged into the settings store');
    });

    it('reads a file from a newer EdgeLoop and says what it skipped', () => {
        const read = readBackup({
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION + 1,
            settings: { minHr: 70 },
            somethingNew: { nested: true }
        });
        assert.equal(read.ok, true);
        assert.equal(read.futureVersion, true);
        assert.deepEqual(read.settings, { minHr: 70 });
        assert.match(describeBackupImport(read, {}), /newer EdgeLoop/);
    });
});

describe('a hand-edited or hostile file cannot do harm', () => {
    it('refuses anything that is not an object', () => {
        for (const junk of [null, 42, 'settings', [1, 2, 3], true]) {
            assert.equal(readBackup(junk).ok, false);
        }
    });

    it('refuses a file with nothing of ours in it', () => {
        const read = readBackup({});
        assert.equal(read.ok, false);
        assert.match(read.error, /no EdgeLoop settings/);
        assert.equal(readBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION, settings: {} }).ok, false);
    });

    it('never lets a file field masquerade as a setting', () => {
        const read = readBackup({
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            settings: Object.fromEntries(RESERVED_SETTING_KEYS.map((name) => [name, 'sneaky'])),
            handyConnectionKey: KEY
        });
        // Every field in `settings` was a reserved name, so nothing is left
        // to merge - but the key at the top level is still read.
        assert.deepEqual(read.settings, {});
        assert.equal(read.handyConnectionKey, KEY);
    });

    it('flags a key-shaped field that is not a usable key instead of passing it on', () => {
        for (const junk of [12345678, { key: 'x' }, ['k'], 'has space', 'x'.repeat(500)]) {
            const read = readBackup({ minHr: 70, handyConnectionKey: junk });
            assert.equal(read.keyPresent, false, `junk key accepted: ${JSON.stringify(junk)}`);
            assert.equal(read.keyRejected, true);
            assert.equal(read.handyConnectionKey, null);
        }
    });

    it('cannot invert a travel envelope or raise a ceiling on its own', () => {
        // Nothing here re-shapes the numbers: settings values pass through
        // untouched and app.js clamps them with the same sanitizers a typed
        // value goes through. What this module guarantees is that no value
        // it OWNS can come back unsafe.
        const read = readBackup({
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            settings: { handyHwMin: 900, handyHwMax: -4, maxHr: 9999 },
            handy: { maxCap: 900 },
            devices: { intiface: { d: { axes: { 'scalar:0': { maxCap: 900 } } } } }
        });
        assert.equal(read.handy.maxCap, 100);
        assert.equal(read.devices.intiface.d.axes['scalar:0'].maxCap, 100);
        assert.deepEqual(read.settings, { handyHwMin: 900, handyHwMax: -4, maxHr: 9999 });
    });

    it('drops the file fields from a live settings store that an old import polluted', () => {
        const live = { minHr: 70, handyConnectionKey: 'PROBE-KEY-123', note: 'x' };
        const removed = pruneReservedKeys(live);
        assert.deepEqual(live, { minHr: 70 });
        assert.deepEqual(removed.sort(), ['handyConnectionKey', 'note']);
        assert.deepEqual(pruneReservedKeys(null), []);
    });
});

describe('the import says what it did', () => {
    const full = readBackup(buildBackup(STORES, { includeKey: true, now: NOW }));

    it('names everything it restored', () => {
        const text = describeBackupImport(full, { hadExistingKey: false });
        assert.match(text, /5 Session Setup values/);
        assert.match(text, /the Handy channel role and speed cap/);
        assert.match(text, /1 Intiface device map/);
        assert.match(text, /1 T-Code device map/);
    });

    it('says the key came back, and that nothing was connected', () => {
        const text = describeBackupImport(full, { hadExistingKey: false });
        assert.match(text, /connection key was restored/);
        assert.match(text, /never connects a toy by itself/);
    });

    it('says a key-less file kept the key already saved here', () => {
        const read = readBackup(buildBackup(STORES, { now: NOW }));
        assert.match(describeBackupImport(read, { hadExistingKey: true }), /no Handy connection key, so the one saved in this browser was kept/);
    });

    it('tells a user with no key at all where to get one - the wasted-restore sentence', () => {
        const read = readBackup(buildBackup(STORES, { now: NOW }));
        assert.match(describeBackupImport(read, { hadExistingKey: false }), /Enter yours in the Handy panel/);
    });

    it('says when a key-shaped field was refused', () => {
        const read = readBackup({ minHr: 70, handyConnectionKey: 'has space' });
        assert.match(describeBackupImport(read, { hadExistingKey: true }), /not a usable key/);
    });

    it('always answers the history question', () => {
        assert.match(describeBackupImport(full, {}), /Session history is never carried in a backup/);
    });

    it('says an older file was read as an older file', () => {
        assert.match(describeBackupImport(readBackup({ minHr: 70 }), {}), /no version marker/);
    });

    it('refuses to describe a failed read as a success, and says which way it failed', () => {
        const named = describeBackupImport({ ok: false, error: 'the file is not a JSON object' }, {});
        assert.match(named, /not an EdgeLoop backup/);
        assert.match(named, /the file is not a JSON object/);
        assert.match(named, /Backup tab/);
        // A result with no reason still gets a sentence a user can act on.
        assert.match(describeBackupImport(null, {}), /not an EdgeLoop backup/);
        assert.ok(!/undefined/.test(describeBackupImport(null, {})));
    });

    it('gives a different reason for each way a file can be wrong', () => {
        const reason = (value) => describeBackupImport(readBackup(value), {});
        const list = reason([1, 2, 3]);
        const bare = reason('hello');
        const empty = reason({});
        const junk = reason({ someOtherApp: true, alsoNotMine: 1 });
        assert.match(list, /JSON list/);
        assert.match(bare, /not a JSON object/);
        assert.match(empty, /no EdgeLoop settings at all/);
        assert.match(junk, /2 unrecognised fields/);
        assert.equal(new Set([list, bare, empty, junk]).size, 4);
    });
});

describe('only fields this version has cross the file boundary', () => {
    it('SETTING_KEYS is the factory list, not whatever the live store grew', () => {
        // Captured at module load, so a later merge cannot widen it.
        assert.ok(SETTING_KEYS.length >= 30);
        assert.ok(SETTING_KEYS.includes('minHr') && SETTING_KEYS.includes('learningProfile'));
        assert.ok(Object.isFrozen(SETTING_KEYS));
        for (const name of RESERVED_SETTING_KEYS) {
            assert.ok(!SETTING_KEYS.includes(name), `${name} is a file field, never a setting`);
        }
        // Every default is exportable and importable; the list IS the defaults.
        assert.deepEqual([...SETTING_KEYS].sort(), Object.keys(advancedSettings).sort());
    });

    it('drops an unknown field on the way in and reports it', () => {
        const read = readBackup({
            format: 'edgeloop-backup',
            version: 2,
            settings: { minHr: 70, maxHr: 140, bogusUnknownField: 1, sneakyKey: 'STOLEN-KEY-9999' }
        });
        assert.equal(read.ok, true);
        assert.deepEqual(Object.keys(read.settings).sort(), ['maxHr', 'minHr']);
        assert.deepEqual(read.unknownSettingKeys.sort(), ['bogusUnknownField', 'sneakyKey']);
        const text = describeBackupImport(read, {});
        // The count it announces is the count it actually stored.
        assert.match(text, /2 Session Setup values/);
        assert.match(text, /2 fields in the file are not a setting this version has/);
        assert.ok(!text.includes('STOLEN-KEY-9999'));
    });

    it('drops an unknown field on the way out, so a polluted store cannot leak one', () => {
        // Exactly the shape an older build's Object.assign left behind.
        const polluted = { minHr: 70, handyConnectionKey: 'LEAKED-1234', strayFromOldBuild: 'x' };
        const file = buildBackup({ settings: polluted }, { now: NOW });
        assert.deepEqual(Object.keys(file.settings), ['minHr']);
        assert.equal(JSON.stringify(file).includes('LEAKED-1234'), false);
        assert.equal(JSON.stringify(file).includes('strayFromOldBuild'), false);
    });

    it('a legacy blob is filtered the same way as an enveloped one', () => {
        const read = readBackup({ minHr: 70, maxHr: 150, whatIsThis: true });
        assert.equal(read.legacy, true);
        assert.deepEqual(read.unknownSettingKeys, ['whatIsThis']);
        assert.equal('whatIsThis' in read.settings, false);
    });

    it('a file of nothing but unknown fields is refused rather than imported as empty', () => {
        const read = readBackup({ nothingWeKnow: 1 });
        assert.equal(read.ok, false);
        assert.match(read.error, /unrecognised field/);
    });

    it('filterSettings takes an explicit list too', () => {
        const { settings, unknown } = filterSettings({ a: 1, b: 2 }, ['a']);
        assert.deepEqual(settings, { a: 1 });
        assert.deepEqual(unknown, ['b']);
        assert.deepEqual(filterSettings(null).settings, {});
        assert.deepEqual(filterSettings('nope').unknown, []);
    });
});

describe('the learning profile is clamped like every other restored value', () => {
    it('keeps a plausible profile as it is', () => {
        assert.deepEqual(
            sanitizeLearningProfile({ breakthroughEvents: 3, suggestedMaxHrOffset: 9, lastBreakthroughHr: 141 }),
            { breakthroughEvents: 3, suggestedMaxHrOffset: 9, lastBreakthroughHr: 141 }
        );
    });

    it('refuses an offset that would RAISE the working ceiling', () => {
        // A negative offset is subtracted from the typed Climax HR, so a
        // hand-edited -60 would hand the toys a ceiling 60 BPM above the one
        // the user typed. It clamps to 0, not to the number in the file.
        assert.equal(sanitizeLearningProfile({ suggestedMaxHrOffset: -60 }).suggestedMaxHrOffset, 0);
        assert.equal(sanitizeLearningProfile({ suggestedMaxHrOffset: 999 }).suggestedMaxHrOffset, MAX_LEARNED_OFFSET_BPM);
        assert.equal(sanitizeLearningProfile({ suggestedMaxHrOffset: 'lots' }).suggestedMaxHrOffset, 0);
    });

    it('nulls an implausible last-event HR and floors the event count', () => {
        assert.equal(sanitizeLearningProfile({ lastBreakthroughHr: 9000 }).lastBreakthroughHr, null);
        assert.equal(sanitizeLearningProfile({ lastBreakthroughHr: 0 }).lastBreakthroughHr, null);
        assert.equal(sanitizeLearningProfile({ lastBreakthroughHr: '132' }).lastBreakthroughHr, 132);
        assert.equal(sanitizeLearningProfile({ breakthroughEvents: -4 }).breakthroughEvents, 0);
        assert.equal(sanitizeLearningProfile({ breakthroughEvents: 1e9 }).breakthroughEvents, 9999);
    });

    it('drops an unreadable profile so the one in this browser survives', () => {
        assert.equal(sanitizeLearningProfile('yes'), null);
        assert.equal(sanitizeLearningProfile([1]), null);
        const read = readBackup({ minHr: 70, learningProfile: 'yes' });
        assert.equal('learningProfile' in read.settings, false);
    });

    it('clamps the profile that arrives inside a file', () => {
        const read = readBackup({ minHr: 70, learningProfile: { breakthroughEvents: 2, suggestedMaxHrOffset: -60, lastBreakthroughHr: 4000 } });
        assert.deepEqual(read.settings.learningProfile, { breakthroughEvents: 2, suggestedMaxHrOffset: 0, lastBreakthroughHr: null });
    });
});

describe('the documented backup is the backup that is written', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const section = readme.slice(readme.indexOf('### Backup & Restore'));

    it('names every store the file actually carries', () => {
        const file = buildBackup(STORES, { now: NOW });
        // Each of these is a real top-level part of the file, so the section
        // that lists what a backup holds has to mention it.
        assert.ok(Object.keys(file.devices).length === 2 && file.handy && file.flags);
        for (const phrase of [/Session Setup value/i, /Handy channel role and speed cap/i, /Intiface and T-Code device maps/i, /age \/ wizard flags/i, /connection key/i, /history is never in a backup/i]) {
            assert.match(section, phrase);
        }
    });

    it('promises nothing the settings object does not have', () => {
        // README.md used to say a backup carried "your custom profiles".
        // advancedSettings had a customProfiles field that no screen, no
        // engine path and no driver ever read or wrote, so the sentence
        // described a feature that did not exist; the field is gone and the
        // sentence with it. A document that is wrong about something
        // checkable is not trusted about anything else.
        assert.ok(!/custom profile/i.test(section), 'the Backup section names a feature this build does not have');
        assert.ok(!SETTING_KEYS.includes('customProfiles'), 'customProfiles is dead state; do not bring it back without a screen that uses it');
    });
});

describe('app.js routes the backup through this module', () => {
    const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

    it('builds and reads the file here rather than inline', () => {
        assert.ok(/from '\.\/backup\.js'/.test(src), 'app.js must import backup.js');
        assert.ok(/buildBackup\(/.test(src));
        assert.ok(/readBackup\(/.test(src));
        assert.ok(/describeBackupImport\(/.test(src));
    });

    it('strips the file fields before merging a parsed file into the settings store', () => {
        const merge = src.indexOf('Object.assign(advancedSettings, result.settings)');
        const prune = src.indexOf('pruneReservedKeys(advancedSettings)');
        assert.ok(prune >= 0, 'app.js must prune the reserved names from the live store');
        assert.ok(merge >= 0 && prune < merge, 'the prune has to happen BEFORE the merge');
    });

    it('repaints the learning line after an import applies a restored profile', () => {
        const apply = src.indexOf('applyImportedBackup(result);');
        const paint = src.indexOf('renderLearningStatus();', apply);
        const alerted = src.indexOf('alert(describeBackupImport(result, { hadExistingKey }))');
        assert.ok(apply >= 0 && paint > apply && paint < alerted,
            'the panel has to be repainted before the import reports what it did');
    });

    it('tells a non-JSON file apart from an invalid backup', () => {
        assert.ok(/That file is not JSON/.test(src), 'a wrong-file pick gets its own message');
        assert.ok(!/alert\("Invalid configuration file\."\)/.test(src), 'the one-size-fits-all message is gone');
    });

    it('never writes an empty connection key over a saved one', () => {
        const write = /safeSet\('handy_connection_key'/g;
        const writes = src.match(write) || [];
        assert.equal(writes.length, 2, 'the key is written by the Connect button and by a restore, nowhere else');
        assert.ok(/if \(result\.keyPresent\)/.test(src), 'the restore writes the key only when the file carried one');
    });
});
