import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    VOICE_CUE_CATALOG,
    DEFAULT_VOICE_CUES,
    MAX_CUE_LENGTH,
    sanitizeCueText,
    mergeVoiceCues,
    interpolateCue,
    resolveVoiceCue,
    isVoiceCueId
} from './voice-cues.js';

describe('voice cue templates', () => {
    it('has a default string for every catalog id', () => {
        assert.ok(VOICE_CUE_CATALOG.length >= 10);
        for (const cue of VOICE_CUE_CATALOG) {
            assert.equal(typeof DEFAULT_VOICE_CUES[cue.id], 'string');
            assert.ok(DEFAULT_VOICE_CUES[cue.id].length > 0);
            assert.equal(isVoiceCueId(cue.id), true);
        }
        assert.equal(isVoiceCueId('not-a-cue'), false);
    });

    it('interpolates known tokens and leaves unknown braces alone', () => {
        assert.equal(
            interpolateCue('Edge at {hr} of {maxHr}. {nope}', { hr: 147, maxHr: 140 }),
            'Edge at 147 of 140. {nope}'
        );
        assert.equal(interpolateCue('Hello {edges}', { edges: 3 }), 'Hello 3');
        assert.equal(interpolateCue('', { hr: 1 }), '');
    });

    it('merges saved edits, clamps length, and falls back to defaults', () => {
        const merged = mergeVoiceCues({
            edge: '  Hold it. {hr}  ',
            sessionStart: 12,
            unknown: 'nope',
            paused: 'x'.repeat(MAX_CUE_LENGTH + 20)
        });
        assert.equal(merged.edge, 'Hold it. {hr}');
        assert.equal(merged.sessionStart, DEFAULT_VOICE_CUES.sessionStart);
        assert.equal(merged.paused.length, MAX_CUE_LENGTH);
        assert.equal(merged.unknown, undefined);
        assert.equal(merged.idle, DEFAULT_VOICE_CUES.idle);
    });

    it('resolves a catalog id or a literal sentence', () => {
        const cues = { edge: 'Back off at {hr}.' };
        assert.equal(resolveVoiceCue(cues, 'edge', { hr: 150 }), 'Back off at 150.');
        assert.equal(resolveVoiceCue(cues, 'Denied.'), 'Denied.');
        assert.equal(resolveVoiceCue(cues, ''), '');
        assert.equal(sanitizeCueText('  two   words  '), 'two words');
    });
});
