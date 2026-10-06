import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    VOICE_CUE_CATALOG,
    DEFAULT_VOICE_CUES,
    MAX_CUE_LENGTH,
    MAX_PHRASES_PER_CUE,
    sanitizeCueText,
    sanitizeCueList,
    mergeVoiceCues,
    interpolateCue,
    cueLineIsComplete,
    sayableCueLines,
    resolveVoiceCue,
    isVoiceCueId,
    pickCueLine,
    parseVoiceCuesText,
    applyImportedCues,
    serializeVoiceCues,
    describeImport,
    voiceImportAlert,
    clampEncourageSeconds,
    DEFAULT_ENCOURAGE_SECONDS
} from './voice-cues.js';

describe('voice cue templates', () => {
    it('has a default list for every catalog id', () => {
        assert.ok(VOICE_CUE_CATALOG.length >= 10);
        for (const cue of VOICE_CUE_CATALOG) {
            assert.ok(Array.isArray(DEFAULT_VOICE_CUES[cue.id]));
            assert.ok(DEFAULT_VOICE_CUES[cue.id].length > 0);
            assert.equal(isVoiceCueId(cue.id), true);
        }
        assert.equal(isVoiceCueId('not-a-cue'), false);
        assert.ok(DEFAULT_VOICE_CUES.encourage.length >= 8);
        assert.ok(DEFAULT_VOICE_CUES.edge.length >= 8);
        assert.ok(DEFAULT_VOICE_CUES.forceOrgasm.length >= 8);
        assert.ok(DEFAULT_VOICE_CUES.cameEarly.length >= 6);
        assert.ok(DEFAULT_VOICE_CUES.forceOrgasmOff.length >= 2);
        // Spoken, and painted on the dashboard, as Force Orgasm's time limit
        // hands the session to the soft landing.
        assert.ok(DEFAULT_VOICE_CUES.forceOrgasmLimit.length >= 2);
        assert.equal(VOICE_CUE_CATALOG.find((c) => c.id === 'forceOrgasmLimit')?.group, 'Climax');
        assert.deepEqual(parseVoiceCuesText('# forceOrgasmLimit\nEase down.\n').cues.forceOrgasmLimit, ['Ease down.']);
        assert.equal(VOICE_CUE_CATALOG.find((c) => c.id === 'encourage')?.group, 'Build-up');
        assert.equal(VOICE_CUE_CATALOG.find((c) => c.id === 'edge')?.group, 'Edge');
        assert.equal(VOICE_CUE_CATALOG.find((c) => c.id === 'forceOrgasm')?.group, 'Climax');
        assert.equal(VOICE_CUE_CATALOG.find((c) => c.id === 'cameEarly')?.group, 'Premature');
        assert.ok(DEFAULT_VOICE_CUES.trainFinish.length >= 2);
        assert.equal(VOICE_CUE_CATALOG.find((c) => c.id === 'trainHold')?.group, 'Training');
    });

    it('keeps the two Came Early banks apart: the ceiling lowered, and held', () => {
        const lowered = VOICE_CUE_CATALOG.find((c) => c.id === 'cameEarly');
        const held = VOICE_CUE_CATALOG.find((c) => c.id === 'cameEarlyHeld');
        assert.equal(held?.group, 'Premature');
        assert.ok(held.lines.length >= 4);
        assert.match(lowered.label, /lowered/);
        assert.match(held.label, /stays where it is/);
        assert.equal(isVoiceCueId('cameEarlyHeld'), true);
        // The held bank is spoken over a ceiling the press left where it was:
        // the Resting HR floor holds it, or the learned offset is at its cap -
        // and at the cap the ceiling can sit far above the floor. So no line,
        // and not the label the editor shows over them, may promise a drop or
        // say the ceiling is as low as it goes; each says it stays.
        const claimsDrop = /tighten|tighter|drop|goes down|lower|meaner/i;
        const claimsFloor = /as low as|no lower|nothing left|lowest|minimum|bottom|floor/i;
        for (const text of [held.label, ...held.lines]) {
            assert.doesNotMatch(text, claimsDrop, text);
            assert.doesNotMatch(text, claimsFloor, text);
        }
        for (const line of held.lines) assert.match(line, /stays|holds|unchanged|the same/i, line);
        // Its lines are picked and filled like any other bank's.
        assert.equal(resolveVoiceCue({}, 'cameEarlyHeld', { hr: 118 }, { random: () => 2.5 / 5 }).text,
            'Accidental release. 118 BPM. Logged. The ceiling stays where it is.');
        assert.deepEqual(mergeVoiceCues({ cameEarly: ['Mine.'] }).cameEarlyHeld, held.lines, 'a saved profile without the bank gets the factory lines');
        assert.deepEqual(mergeVoiceCues({ cameEarlyHeld: [] }).cameEarlyHeld, [], 'and it can be muted like any other');
    });

    it('keeps a Came Early mute saved before the held bank existed', () => {
        // A set saved by 1.1.0: every bank it knew, Came Early emptied.
        const saved = { ...DEFAULT_VOICE_CUES, cameEarly: [] };
        delete saved.cameEarlyHeld;
        const merged = mergeVoiceCues(saved);
        assert.deepEqual(merged.cameEarly, []);
        assert.deepEqual(merged.cameEarlyHeld, [], 'the new bank starts as silent as the one it was split from');
        // Only the mute carries over: lines of the older bank are never
        // copied into the one that must not promise a drop.
        const custom = mergeVoiceCues({ cameEarly: ['Limit down, loser.'] });
        assert.deepEqual(custom.cameEarlyHeld, DEFAULT_VOICE_CUES.cameEarlyHeld);
        // A box emptied as text is a mute too; an unusable value is not one.
        assert.deepEqual(mergeVoiceCues({ cameEarly: '' }).cameEarlyHeld, []);
        assert.deepEqual(mergeVoiceCues({ cameEarly: null }).cameEarlyHeld, DEFAULT_VOICE_CUES.cameEarlyHeld);
        assert.deepEqual(mergeVoiceCues({}).cameEarlyHeld, DEFAULT_VOICE_CUES.cameEarlyHeld, 'Reset defaults speaks both');
        // Once saved with an entry of its own, the held bank is on its own.
        assert.deepEqual(mergeVoiceCues({ cameEarly: [], cameEarlyHeld: ['Logged.'] }).cameEarlyHeld, ['Logged.']);
        assert.deepEqual(mergeVoiceCues({ cameEarly: ['Oops.'], cameEarlyHeld: [] }).cameEarlyHeld, []);
        // And merging again changes nothing.
        assert.deepEqual(mergeVoiceCues(merged), merged);
    });

    it('imports a phrase list written before the held bank existed with its Came Early mute', () => {
        // Export phrases in 1.1.0 wrote every bank it knew - Came Early
        // emptied, and no cameEarlyHeld. Import phrases writes only the banks
        // a file names, so that mute used to leave the held bank on its
        // factory lines: every press the Resting HR floor swallowed was
        // spoken and painted, while the alert said "(1 muted)".
        const listed = { ...DEFAULT_VOICE_CUES, cameEarly: [] };
        delete listed.cameEarlyHeld;
        const parsed = parseVoiceCuesText(JSON.stringify({ voiceCues: listed, voiceEncourageSeconds: 45 }, null, 2));
        assert.equal(parsed.error, null);
        assert.equal(Object.prototype.hasOwnProperty.call(parsed.cues, 'cameEarlyHeld'), false);
        // Into the factory editor, and into one whose held bank has lines of
        // its own: both halves of Came Early fall silent either way.
        for (const editor of [mergeVoiceCues({}), mergeVoiceCues({ cameEarlyHeld: ['Mine, held.'] })]) {
            const after = applyImportedCues(editor, parsed.cues);
            assert.deepEqual(after.cameEarly, []);
            assert.deepEqual(after.cameEarlyHeld, []);
            for (const key of ['cameEarly', 'cameEarlyHeld']) {
                for (const hr of [118, null]) assert.equal(resolveVoiceCue(after, key, { hr, maxHr: 120 }).text, '', `${key} with hr ${hr}`);
            }
        }
        // The same data restored as a whole set (the settings store, a
        // Backup) reads the same way.
        assert.deepEqual(applyImportedCues(mergeVoiceCues({}), parsed.cues), mergeVoiceCues(parsed.cues));
        // The alert counts what was written, the held bank's mute included,
        // so it agrees with the editor, which then shows both banks muted.
        const summary = describeImport(parsed.cues);
        assert.equal(summary.applied.length, VOICE_CUE_CATALOG.length);
        assert.deepEqual(summary.muted, ['cameEarly', 'cameEarlyHeld']);
        assert.deepEqual(summary.skipped, []);
        assert.equal(voiceImportAlert(summary), `Imported and saved ${VOICE_CUE_CATALOG.length} phrase lists (2 muted).`);
    });

    it('carries only the Came Early mute into the held bank, and never over an answer of its own', () => {
        const factory = mergeVoiceCues({});
        const heldMuted = mergeVoiceCues({ cameEarlyHeld: [] });
        // A 1.1.0 list with Came Early lines of its own: those lines promise
        // a drop, so they never reach the held bank, which stays as the
        // editor has it - factory lines, or the wearer's own mute.
        const custom = { cameEarly: ['Lower next time.'] };
        assert.deepEqual(applyImportedCues(factory, custom).cameEarly, ['Lower next time.']);
        assert.deepEqual(applyImportedCues(factory, custom).cameEarlyHeld, DEFAULT_VOICE_CUES.cameEarlyHeld);
        assert.deepEqual(applyImportedCues(heldMuted, custom).cameEarlyHeld, []);
        assert.deepEqual(describeImport(custom), { applied: ['cameEarly'], muted: [], skipped: [] });
        // A list written after the split answers for each bank itself.
        const both = { cameEarly: [], cameEarlyHeld: ['Logged. Ceiling unchanged.'] };
        assert.deepEqual(applyImportedCues(factory, both).cameEarlyHeld, ['Logged. Ceiling unchanged.']);
        assert.deepEqual(describeImport(both), { applied: ['cameEarly', 'cameEarlyHeld'], muted: ['cameEarly'], skipped: [] });
        const heldUnusable = { cameEarly: [], cameEarlyHeld: 7 };
        assert.deepEqual(applyImportedCues(factory, heldUnusable).cameEarlyHeld, DEFAULT_VOICE_CUES.cameEarlyHeld);
        assert.deepEqual(describeImport(heldUnusable), { applied: ['cameEarly'], muted: ['cameEarly'], skipped: ['cameEarlyHeld'] });
        // A box emptied as text is a mute; a value that is not lines of text
        // is no answer at all, so it silences nothing.
        assert.deepEqual(applyImportedCues(factory, { cameEarly: '' }).cameEarlyHeld, []);
        assert.deepEqual(applyImportedCues(factory, { cameEarly: null }).cameEarlyHeld, DEFAULT_VOICE_CUES.cameEarlyHeld);
        assert.deepEqual(describeImport({ cameEarly: null }), { applied: [], muted: [], skipped: ['cameEarly'] });
        // The file's own object is read, never written.
        const file = { cameEarly: [] };
        applyImportedCues(factory, file);
        describeImport(file);
        mergeVoiceCues(file);
        assert.deepEqual(file, { cameEarly: [] });
    });

    it('reads a split bank the same way on every restore path, and counts exactly what it wrote', () => {
        // Every shape a file can give the two Came Early banks, absent included.
        const values = [undefined, null, 7, [], '', ['  '], ['A line.'], 'A line.\nB line.'];
        const current = { cameEarly: ['Existing.'], cameEarlyHeld: ['Existing, held.'] };
        for (const older of values) {
            for (const newer of values) {
                const incoming = {};
                if (older !== undefined) incoming.cameEarly = older;
                if (newer !== undefined) incoming.cameEarlyHeld = newer;
                const label = JSON.stringify({ older, newer });
                const after = applyImportedCues(current, incoming);
                const summary = describeImport(incoming);
                for (const id of ['cameEarly', 'cameEarlyHeld']) {
                    const written = JSON.stringify(after[id]) !== JSON.stringify(current[id]);
                    assert.equal(summary.applied.includes(id), written, `${id} applied, ${label}`);
                    assert.equal(summary.muted.includes(id), after[id].length === 0, `${id} muted, ${label}`);
                }
                // The held bank goes silent through the file and only then:
                // its own mute, or Came Early's when it names no held bank.
                const olderMutes = typeof older === 'string' || Array.isArray(older) ? sanitizeCueList(older, []).length === 0 : false;
                const newerMutes = typeof newer === 'string' || Array.isArray(newer) ? sanitizeCueList(newer, []).length === 0 : false;
                assert.equal(after.cameEarlyHeld.length === 0, newerMutes || (newer === undefined && olderMutes), `held silent, ${label}`);
                // Into the factory editor, Import phrases gives what a Backup
                // restore of the same banks gives.
                assert.deepEqual(applyImportedCues(mergeVoiceCues({}), incoming), mergeVoiceCues(incoming), label);
            }
        }
    });

    it('does not pick a line whose token has no value while another line can be said in full', () => {
        assert.equal(cueLineIsComplete('Accidental release. {hr} BPM.', { hr: null }), false);
        assert.equal(cueLineIsComplete('Accidental release. {hr} BPM.', { hr: undefined }), false);
        assert.equal(cueLineIsComplete('Accidental release. {hr} BPM.', { hr: 0 }), true);
        assert.equal(cueLineIsComplete('Hold {nope}.', {}), true, 'an unknown brace is not a token');
        assert.equal(cueLineIsComplete('Hold it.', {}), true);
        const cues = { cameEarly: ['Accidental release. {hr} BPM. Limits tighter.', 'Came early. Limit tightened.', 'Edge {edges}. {hr}.'] };
        assert.deepEqual(sayableCueLines(cues.cameEarly, { hr: null, edges: 2 }), ['Came early. Limit tightened.']);
        for (let roll = 0; roll < 1; roll += 1 / 32) {
            assert.equal(resolveVoiceCue(cues, 'cameEarly', { hr: null, edges: 2 }, { random: () => roll }).text, 'Came early. Limit tightened.');
        }
        // With a pulse to quote, the whole bank is in play again.
        assert.equal(resolveVoiceCue(cues, 'cameEarly', { hr: 131, edges: 2 }, { random: () => 0.1 }).text, 'Accidental release. 131 BPM. Limits tighter.');
        // A bank with no line that can be said in full still says something,
        // the token dropped, rather than falling silent like a mute.
        assert.deepEqual(sayableCueLines(['{hr} BPM.'], { hr: null }), ['{hr} BPM.']);
        assert.equal(resolveVoiceCue({ edge: ['{hr} BPM.'] }, 'edge', { hr: null }).text, 'BPM.');
        // A literal sentence is not a bank and is filled as written.
        assert.equal(resolveVoiceCue({}, 'Stopped at {hr}.', { hr: null }).text, 'Stopped at .');
    });

    it('interpolates known tokens and leaves unknown braces alone', () => {
        assert.equal(
            interpolateCue('Edge at {hr} of {maxHr}. {nope}', { hr: 147, maxHr: 140 }),
            'Edge at 147 of 140. {nope}'
        );
        assert.equal(interpolateCue('Hello {edges}', { edges: 3 }), 'Hello 3');
        assert.equal(interpolateCue('{done} of {need}, {hold}s', { done: 2, need: 5, hold: 9 }), '2 of 5, 9s');
        assert.equal(interpolateCue('', { hr: 1 }), '');
    });

    it('merges saved edits as lists, including a legacy single string', () => {
        const merged = mergeVoiceCues({
            edge: '  Hold it. {hr}  ',
            sessionStart: 12,
            unknown: 'nope',
            paused: ['first', 'x'.repeat(MAX_CUE_LENGTH + 20), 'first'],
            encourage: ['A', 'B', 'C']
        });
        assert.deepEqual(merged.edge, ['Hold it. {hr}']);
        assert.deepEqual(merged.sessionStart, DEFAULT_VOICE_CUES.sessionStart);
        assert.equal(merged.paused[1].length, MAX_CUE_LENGTH);
        assert.equal(merged.paused.length, 2);
        assert.equal(merged.unknown, undefined);
        assert.deepEqual(merged.encourage, ['A', 'B', 'C']);
        assert.deepEqual(merged.idle, DEFAULT_VOICE_CUES.idle);
    });

    it('caps a huge list and skips blanks', () => {
        const many = Array.from({ length: MAX_PHRASES_PER_CUE + 40 }, (_, i) => `line ${i}`);
        const list = sanitizeCueList(['', '  ', ...many], ['fallback']);
        assert.equal(list.length, MAX_PHRASES_PER_CUE);
        assert.equal(list[0], 'line 0');
    });

    it('picks a line and avoids repeating the last one', () => {
        assert.equal(pickCueLine(['only']), 'only');
        const picks = new Set();
        for (let i = 0; i < 8; i++) {
            picks.add(pickCueLine(['a', 'b'], 'a', () => 0));
        }
        assert.deepEqual([...picks], ['b']);
    });

    it('resolves a catalog id or a literal sentence', () => {
        const cues = { edge: ['Back off at {hr}.'] };
        assert.equal(resolveVoiceCue(cues, 'edge', { hr: 150 }).text, 'Back off at 150.');
        assert.equal(resolveVoiceCue(cues, 'Denied.').text, 'Denied.');
        assert.equal(resolveVoiceCue(cues, '').text, '');
        assert.equal(sanitizeCueText('  two   words  '), 'two words');
    });

    it('parses a JSON phrase file and a full settings backup', () => {
        const file = parseVoiceCuesText(JSON.stringify({ edge: ['One.', 'Two.'], encourage: ['Go.'] }));
        assert.equal(file.error, null);
        assert.deepEqual(file.cues.edge, ['One.', 'Two.']);
        assert.equal(file.cues.paused, undefined);
        const wrapped = parseVoiceCuesText(JSON.stringify({ voiceCues: { paused: ['Hold.'] } }));
        assert.deepEqual(wrapped.cues.paused, ['Hold.']);
        const bad = parseVoiceCuesText('{nope');
        assert.equal(bad.error, 'json');
    });

    it('parses a sectioned text file and bare lines as encouragement', () => {
        const text = parseVoiceCuesText('# edge\nHold it.\nBack off.\n\n# encourage\nYou can do this.\n');
        assert.equal(text.error, null);
        assert.deepEqual(text.cues.edge, ['Hold it.', 'Back off.']);
        assert.deepEqual(text.cues.encourage, ['You can do this.']);
        const bare = parseVoiceCuesText('Keep going.\nStay there.\n');
        assert.deepEqual(bare.cues.encourage, ['Keep going.', 'Stay there.']);
        const climax = parseVoiceCuesText('# forceOrgasm\nCome now.\n\n# cameEarly\nToo soon.\n');
        assert.deepEqual(climax.cues.forceOrgasm, ['Come now.']);
        assert.deepEqual(climax.cues.cameEarly, ['Too soon.']);
    });

    it('imports a partial file without wiping other cues', () => {
        const current = mergeVoiceCues({ edge: ['Keep me.'] });
        const next = applyImportedCues(current, { encourage: ['New pep.'] });
        assert.deepEqual(next.edge, ['Keep me.']);
        assert.deepEqual(next.encourage, ['New pep.']);
        assert.deepEqual(serializeVoiceCues(next).sessionStart, DEFAULT_VOICE_CUES.sessionStart);
    });

    it('resolves section headers whatever their case or spacing', () => {
        // "# Edge" used to fall through as a PHRASE into the Build-up bank, so
        // the header line itself was spoken and the whole file landed in one cue.
        const cased = parseVoiceCuesText('# Edge\nHold it there.\n\n# Force Orgasm\nCome now.\n');
        assert.equal(cased.error, null);
        assert.deepEqual(cased.cues.edge, ['Hold it there.']);
        assert.deepEqual(cased.cues.forceOrgasm, ['Come now.']);
        assert.equal(cased.cues.encourage, undefined);
        const bracket = parseVoiceCuesText('[CameEarly]\nToo soon.\n');
        assert.deepEqual(bracket.cues.cameEarly, ['Too soon.']);
    });

    it('reports a header that names no known cue instead of speaking it', () => {
        const bad = parseVoiceCuesText('# Climax\nCome now.\n');
        assert.equal(bad.error, 'header');
        assert.equal(bad.header, 'Climax');
        assert.deepEqual(bad.cues, {});
        const empty = parseVoiceCuesText('# edge\nHold.\n#\nMore.\n');
        assert.equal(empty.error, 'header');
    });

    it('carries the encouragement interval back out of a phrase file', () => {
        const file = parseVoiceCuesText(JSON.stringify({ voiceCues: { edge: ['One.'] }, voiceEncourageSeconds: 0 }));
        assert.equal(file.error, null);
        assert.equal(file.encourageSeconds, 0);
        const none = parseVoiceCuesText(JSON.stringify({ edge: ['One.'] }));
        assert.equal(none.encourageSeconds, null);
        const text = parseVoiceCuesText('# edge\nOne.\n');
        assert.equal(text.encourageSeconds, null);
    });

    it('mutes a cue that the user emptied, but not one that is absent', () => {
        assert.deepEqual(sanitizeCueList('', ['fallback']), []);
        assert.deepEqual(sanitizeCueList(['   '], ['fallback']), []);
        assert.deepEqual(sanitizeCueList(undefined, ['fallback']), ['fallback']);
        assert.deepEqual(sanitizeCueList(17, ['fallback']), ['fallback']);
        const merged = mergeVoiceCues({ edge: '' });
        assert.deepEqual(merged.edge, []);
        assert.deepEqual(merged.encourage, DEFAULT_VOICE_CUES.encourage);
        // A muted bank stays muted across a save/load round trip and speaks nothing.
        assert.deepEqual(mergeVoiceCues(serializeVoiceCues(merged)).edge, []);
        assert.equal(resolveVoiceCue(merged, 'edge', { hr: 150 }).text, '');
    });

    it('restores a muted bank from the user\'s own backup, byte for byte', () => {
        // "Emptied box = muted" is a real, persisted state and Export phrases
        // writes it out as `"forceOrgasm": []`. An import that skipped empty
        // lists dropped exactly that key, so the mute was the one piece of
        // the configuration a backup could not carry: the 12 factory Climax
        // lines came back and the next Force Orgasm spoke one out loud.
        const muted = mergeVoiceCues({ forceOrgasm: [] });
        assert.deepEqual(muted.forceOrgasm, []);
        const exported = serializeVoiceCues(muted);
        assert.deepEqual(exported.forceOrgasm, []);

        const afterReset = mergeVoiceCues({});
        assert.equal(afterReset.forceOrgasm.length, DEFAULT_VOICE_CUES.forceOrgasm.length);

        const restored = applyImportedCues(afterReset, exported);
        assert.deepEqual(restored.forceOrgasm, [], 'the mute must survive the round trip');
        assert.equal(JSON.stringify(restored), JSON.stringify(muted));
        assert.equal(resolveVoiceCue(restored, 'forceOrgasm', { hr: 150 }).text, '', 'and nothing is spoken');

        // The same file through Import Settings (mergeVoiceCues) already
        // preserved it. Two import buttons must not give two answers.
        assert.deepEqual(mergeVoiceCues(exported).forceOrgasm, []);

        // An unusable value is still not a mute: it keeps what is there.
        const junk = applyImportedCues(afterReset, { forceOrgasm: 42 });
        assert.deepEqual(junk.forceOrgasm, afterReset.forceOrgasm);
    });

    it('reports what the import really wrote, not how many keys the file had', () => {
        const summary = describeImport({ forceOrgasm: [], edge: ['One.'], notACue: ['x'] });
        assert.deepEqual(summary.applied, ['edge', 'forceOrgasm']);
        assert.deepEqual(summary.muted, ['forceOrgasm']);
        assert.deepEqual(summary.skipped, []);
        assert.deepEqual(describeImport(null), { applied: [], muted: [], skipped: [] });
        assert.deepEqual(describeImport('nope'), { applied: [], muted: [], skipped: [] });
    });

    it('never calls a bank muted that the import left alone', () => {
        // A hand-edited JSON with a cue set to null or a number: the import
        // keeps the lines the user already had (correct), so the summary must
        // not send them hunting for a bank that has gone silent. (The real
        // mute here is not Came Early's: emptying that one also silences the
        // bank split off it, which the tests above cover.)
        const current = { edge: ['Mine.'], forceOrgasm: ['Now.'], paused: ['Oh.'] };
        const incoming = { edge: null, forceOrgasm: 7, paused: [] };
        const after = applyImportedCues(current, incoming);
        assert.deepEqual(after.edge, ['Mine.'], 'an unusable value leaves the bank untouched');
        assert.deepEqual(after.forceOrgasm, ['Now.']);
        assert.deepEqual(after.paused, [], 'an empty list is a real mute');

        const summary = describeImport(incoming);
        assert.deepEqual(summary.applied, ['paused'], 'only the bank that was really written');
        assert.deepEqual(summary.muted, ['paused'], 'and only the bank that really went silent');
        assert.deepEqual(summary.skipped, ['edge', 'forceOrgasm'], 'the banks the file could not write');

        const text = voiceImportAlert(summary);
        assert.ok(/1 phrase list \(1 muted\)/.test(text), text);
        assert.ok(/2 phrase lists in the file were not lines of text/.test(text), text);
        assert.equal(/2 muted/.test(text), false, 'a bank that was left alone is not a mute');
    });

    it('says nothing was changed when the file wrote nothing', () => {
        const summary = describeImport({ edge: null });
        assert.deepEqual(summary.applied, []);
        const text = voiceImportAlert(summary);
        assert.ok(/Nothing was imported/.test(text), text);
        assert.equal(/muted/.test(text), false, text);
        // The unsaved wording still reports the same three answers.
        const partial = voiceImportAlert(describeImport({ edge: ['A.'], forceOrgasm: 7 }), { saved: false });
        assert.ok(/Imported 1 phrase list/.test(partial), partial);
        assert.ok(/refused to save/.test(partial), partial);
        assert.ok(/was not lines of text/.test(partial), partial);
        // The same save carries the phrase edits made on screen before the
        // import and the build-up timer the file may have moved, so a refused
        // save must be reported even when the file wrote no bank at all.
        const none = voiceImportAlert(describeImport({ edge: null }), { saved: false });
        assert.ok(/refused to save/.test(none), none);
        assert.equal(/nothing was changed/.test(none), false, none);
    });

    it('does not claim nothing changed when the file moved the build-up timer', () => {
        // {"voiceCues":{"edge":null},"voiceEncourageSeconds":60}: no bank is
        // writable, so nothing is imported - but the same save wrote the new
        // timer, and the wearer must not be told their settings are untouched.
        const summary = describeImport({ edge: null });
        const moved = voiceImportAlert(summary, { saved: true, timerChanged: true });
        assert.ok(/build-up timer/.test(moved), moved);
        assert.equal(/nothing was changed/.test(moved), false, moved);
        const still = voiceImportAlert(summary, { saved: true, timerChanged: false });
        assert.ok(/Nothing was imported and nothing was changed\./.test(still), still);
        // A refused save still outranks the timer note: the report of the
        // failure is the part that must survive.
        const refused = voiceImportAlert(summary, { saved: false, timerChanged: true });
        assert.ok(/refused to save/.test(refused), refused);
    });

    it('the summary asks exactly the question the import answers', () => {
        // The property, over every shape a file can hand a cue: a bank counts
        // as imported if and only if applyImportedCues changed what it would
        // have been, and as muted if and only if it ends up empty.
        const values = [null, 7, {}, true, undefined, [], '', ['A line.'], 'A line.\n\nB line.', ['  ', '']];
        for (const value of values) {
            const current = { edge: ['Existing.'] };
            const incoming = { edge: value };
            const after = applyImportedCues(current, incoming);
            const summary = describeImport(incoming);
            const untouched = after.edge.length === 1 && after.edge[0] === 'Existing.';
            const wrote = typeof value === 'string' || Array.isArray(value);
            assert.equal(
                summary.applied.includes('edge'),
                wrote,
                `applied must match what was written for ${JSON.stringify(value)}`
            );
            assert.equal(
                summary.muted.includes('edge'),
                after.edge.length === 0,
                `muted must match the silence for ${JSON.stringify(value)}`
            );
            if (!wrote) {
                assert.ok(untouched, `an unusable value must keep the bank: ${JSON.stringify(value)}`);
                assert.equal(summary.muted.includes('edge'), false);
            }
        }
    });

    it('refuses text above the first section instead of speaking it as a phrase', () => {
        // Hand-written and hand-edited phrase files routinely start with a
        // title, a date or a note. Filing those under 'encourage' REPLACED
        // the wearer's whole 14-line build-up bank with them, and the app
        // then read the file's letterhead out at them every 45 s.
        const titled = parseVoiceCuesText('My EdgeLoop phrases, exported 2026-09-20\nDo not delete.\n\n# edge\nHold it there.\n');
        assert.equal(titled.error, 'preamble');
        assert.equal(titled.line, 'My EdgeLoop phrases, exported 2026-09-20');
        assert.deepEqual(titled.cues, {}, 'nothing may be imported from a file we cannot place');

        // A Markdown setext rule under the title is not header-shaped either.
        const setext = parseVoiceCuesText('EdgeLoop phrases\n================\n\n# edge\nHold.\n');
        assert.equal(setext.error, 'preamble');
        assert.equal(setext.line, 'EdgeLoop phrases');

        // JSON behind a comment line is still JSON, not one 140-char phrase.
        const commented = parseVoiceCuesText('// my backup\n{"voiceCues":{"edge":["A."]}}');
        assert.equal(commented.error, null);
        assert.deepEqual(commented.cues.edge, ['A.']);
        assert.equal(commented.cues.encourage, undefined);

        // JSON behind a TITLE cannot be read as JSON and must not be filed
        // as one 140-character phrase either.
        const titledJson = parseVoiceCuesText('My backup\n{"voiceCues":{"edge":["A."]}}');
        assert.equal(titledJson.error, 'json');
        assert.deepEqual(titledJson.cues, {});

        // A file with no sections at all keeps the documented shorthand.
        const bare = parseVoiceCuesText('Keep going.\nStay there.\n');
        assert.equal(bare.error, null);
        assert.deepEqual(bare.cues.encourage, ['Keep going.', 'Stay there.']);

        // ...and a comment above that shorthand is still just a comment.
        const commentedBare = parseVoiceCuesText('// my lines\nKeep going.\n');
        assert.equal(commentedBare.error, null);
        assert.deepEqual(commentedBare.cues.encourage, ['Keep going.']);

        // A phrase may BEGIN with a token. `{hr} BPM. Hold, don't finish.` is
        // a factory line and the editor tells the wearer to use exactly these
        // tokens, so refusing the whole headerless file because one phrase
        // opens with `{` would cost them every line in it.
        const tokenLine = parseVoiceCuesText('Keep going.\n{hr} BPM. Hold.\n{minutes} minutes in.\n');
        assert.equal(tokenLine.error, null, 'a token is not the start of a JSON document');
        assert.deepEqual(tokenLine.cues.encourage, ['Keep going.', '{hr} BPM. Hold.', '{minutes} minutes in.']);

        // A pretty-printed export behind a title is still refused: its first
        // line is a bare `{`, which is not a token.
        const titledPretty = parseVoiceCuesText('My backup\n{\n  "voiceCues": { "edge": ["A."] }\n}\n');
        assert.equal(titledPretty.error, 'json');
        assert.deepEqual(titledPretty.cues, {});

        // A well-formed sectioned file is untouched.
        const good = parseVoiceCuesText('# edge\nHold.\n# forceOrgasm\nCome.\n');
        assert.equal(good.error, null);
        assert.deepEqual(good.cues.edge, ['Hold.']);
    });

    it('a phrase file whose FIRST line is a token is still a phrase file', () => {
        // The shape decision was `trimmed.startsWith('{')`, so a headerless
        // bank whose first line happened to open with a token was handed to
        // JSON.parse and refused as broken JSON - `{hr} BPM. Hold, don't
        // finish.` is a factory line and the editor tells the wearer to use
        // exactly those tokens, so it cost them the whole import.
        const first = parseVoiceCuesText("{hr} BPM. Hold, don't finish.\nStay right there.\n");
        assert.equal(first.error, null, 'a leading token is not the start of a JSON document');
        assert.deepEqual(first.cues.encourage, ["{hr} BPM. Hold, don't finish.", 'Stay right there.']);

        // Under a section header too.
        const sectioned = parseVoiceCuesText('{edges} edges.\n# edge\n{hr} BPM. Hold.\n');
        assert.equal(sectioned.error, 'preamble', 'text above the first section is still held back');
        const headed = parseVoiceCuesText('# edge\n{hr} BPM. Hold.\n');
        assert.equal(headed.error, null);
        assert.deepEqual(headed.cues.edge, ['{hr} BPM. Hold.']);

        // Every documented token opens a phrase safely.
        for (const token of ['hr', 'maxHr', 'minHr', 'edges', 'minutes', 'done', 'need', 'hold']) {
            const out = parseVoiceCuesText(`{${token}} and on we go.\n`);
            assert.equal(out.error, null, `a phrase opening with {${token}} must not be read as JSON`);
            assert.deepEqual(out.cues.encourage, [`{${token}} and on we go.`]);
        }

        // A real export is still read as JSON, in both shapes.
        const flat = parseVoiceCuesText('{"voiceCues":{"edge":["A."]}}');
        assert.equal(flat.error, null);
        assert.deepEqual(flat.cues.edge, ['A.']);
        const pretty = parseVoiceCuesText('{\n  "voiceCues": { "edge": ["A."] }\n}\n');
        assert.equal(pretty.error, null);
        assert.deepEqual(pretty.cues.edge, ['A.']);
        // ...and broken JSON is still reported as broken JSON, not filed as a
        // 140-character phrase to read aloud.
        const broken = parseVoiceCuesText('{"voiceCues":{"edge":["A."]');
        assert.equal(broken.error, 'json');
        assert.deepEqual(broken.cues, {});
    });

    it('clamps the encouragement interval', () => {
        assert.equal(clampEncourageSeconds(-3), 0);
        assert.equal(clampEncourageSeconds(999), 180);
        assert.equal(clampEncourageSeconds('45'), 45);
        assert.equal(clampEncourageSeconds('nope'), DEFAULT_ENCOURAGE_SECONDS);
    });
});

describe('the phrase importer accepts the file the Backup tab writes', () => {
    it('finds the phrase lists inside a full settings backup', () => {
        // The refusal message offers "a settings backup" by name. The new
        // backup nests everything under `settings`, so the importer that
        // suggests it has to be able to read it.
        const backup = {
            note: 'This file does NOT contain your Handy connection key.',
            format: 'edgeloop-backup',
            version: 2,
            settings: { minHr: 62, voiceCues: { edge: ['Hold it.'] }, voiceEncourageSeconds: 50 },
            handy: {},
            devices: { intiface: {}, tcode: {} },
            flags: { ageVerified: false, wizardSeen: false }
        };
        const parsed = parseVoiceCuesText(JSON.stringify(backup));
        assert.equal(parsed.error, null);
        assert.deepEqual(parsed.cues.edge, ['Hold it.']);
    });

    it('still reads the phrase-only export and the legacy settings blob', () => {
        const own = parseVoiceCuesText(JSON.stringify({ voiceCues: { edge: ['A.'] }, voiceEncourageSeconds: 40 }));
        assert.equal(own.error, null);
        assert.deepEqual(own.cues.edge, ['A.']);
        const legacy = parseVoiceCuesText(JSON.stringify({ minHr: 62, voiceCues: { edge: ['B.'] } }));
        assert.equal(legacy.error, null);
        assert.deepEqual(legacy.cues.edge, ['B.']);
    });

    it('does not mistake a settings block with no phrases for a phrase file', () => {
        const none = parseVoiceCuesText(JSON.stringify({ format: 'edgeloop-backup', version: 2, settings: { minHr: 62 } }));
        assert.equal(none.error, 'json');
    });
});
