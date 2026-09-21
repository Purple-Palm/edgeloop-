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
    resolveVoiceCue,
    isVoiceCueId,
    pickCueLine,
    parseVoiceCuesText,
    applyImportedCues,
    serializeVoiceCues,
    describeImport,
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
        assert.equal(VOICE_CUE_CATALOG.find((c) => c.id === 'encourage')?.group, 'Build-up');
        assert.equal(VOICE_CUE_CATALOG.find((c) => c.id === 'edge')?.group, 'Edge');
        assert.equal(VOICE_CUE_CATALOG.find((c) => c.id === 'forceOrgasm')?.group, 'Climax');
        assert.equal(VOICE_CUE_CATALOG.find((c) => c.id === 'cameEarly')?.group, 'Premature');
        assert.ok(DEFAULT_VOICE_CUES.trainFinish.length >= 2);
        assert.equal(VOICE_CUE_CATALOG.find((c) => c.id === 'trainHold')?.group, 'Training');
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
        assert.deepEqual(describeImport(null), { applied: [], muted: [] });
        assert.deepEqual(describeImport('nope'), { applied: [], muted: [] });
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

    it('clamps the encouragement interval', () => {
        assert.equal(clampEncourageSeconds(-3), 0);
        assert.equal(clampEncourageSeconds(999), 180);
        assert.equal(clampEncourageSeconds('45'), 45);
        assert.equal(clampEncourageSeconds('nope'), DEFAULT_ENCOURAGE_SECONDS);
    });
});
