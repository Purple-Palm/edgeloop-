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

    it('clamps the encouragement interval', () => {
        assert.equal(clampEncourageSeconds(-3), 0);
        assert.equal(clampEncourageSeconds(999), 180);
        assert.equal(clampEncourageSeconds('45'), 45);
        assert.equal(clampEncourageSeconds('nope'), DEFAULT_ENCOURAGE_SECONDS);
    });
});
