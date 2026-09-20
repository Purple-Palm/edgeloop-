import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    voiceBandLevel,
    clampMicGate,
    clampMicBoostBpm,
    micBoostFromLevel,
    MIN_MIC_GATE,
    MAX_MIC_GATE,
    DEFAULT_MIC_GATE,
    MIN_MIC_BOOST_BPM,
    MAX_MIC_BOOST_BPM,
    DEFAULT_MIC_BOOST_BPM,
    sampleMicLevel,
    MIC_VOICE_BAND_LO_HZ,
    MIC_VOICE_BAND_HI_HZ
} from './voice.js';

const SAMPLE_RATE = 44100;
const FFT_SIZE = 1024;
const BIN_COUNT = FFT_SIZE / 2;
const binHz = SAMPLE_RATE / FFT_SIZE;

function emptyBins() {
    return new Uint8Array(BIN_COUNT);
}

function binsWithEnergy(hz, magnitude = 200) {
    const data = emptyBins();
    const bin = Math.round(hz / binHz);
    if (bin >= 0 && bin < data.length) data[bin] = magnitude;
    return data;
}

describe('microphone voice-band gate', () => {
    it('clamps the noise gate', () => {
        assert.equal(MIN_MIC_GATE, 8);
        assert.equal(MAX_MIC_GATE, 90);
        assert.equal(DEFAULT_MIC_GATE, 40);
        assert.equal(clampMicGate(3), MIN_MIC_GATE);
        assert.equal(clampMicGate(200), MAX_MIC_GATE);
        assert.equal(clampMicGate('42'), 42);
        assert.equal(clampMicGate('abc'), DEFAULT_MIC_GATE);
        assert.equal(MIC_VOICE_BAND_LO_HZ, 250);
        assert.equal(MIC_VOICE_BAND_HI_HZ, 4000);
    });

    it('ignores low-frequency motor rumble', () => {
        const rumble = binsWithEnergy(80, 255);
        assert.equal(voiceBandLevel(rumble, SAMPLE_RATE, FFT_SIZE), 0);
    });

    it('hears energy in the voice band', () => {
        const voice = binsWithEnergy(1000, 255);
        const level = voiceBandLevel(voice, SAMPLE_RATE, FFT_SIZE);
        assert.ok(level > 0);
        assert.ok(level <= 100);
    });

    it('ignores hiss above the voice band', () => {
        const hiss = binsWithEnergy(8000, 255);
        assert.equal(voiceBandLevel(hiss, SAMPLE_RATE, FFT_SIZE), 0);
    });

    it('returns 0 for empty or missing data', () => {
        assert.equal(voiceBandLevel([], SAMPLE_RATE, FFT_SIZE), 0);
        assert.equal(voiceBandLevel(null, SAMPLE_RATE, FFT_SIZE), 0);
        assert.equal(sampleMicLevel({}), 0);
        assert.equal(sampleMicLevel({ micAnalyser: null }), 0);
    });
});

describe('microphone loudness boost', () => {
    it('clamps the extra-BPM cap', () => {
        assert.equal(clampMicBoostBpm(-3), MIN_MIC_BOOST_BPM);
        assert.equal(clampMicBoostBpm(99), MAX_MIC_BOOST_BPM);
        assert.equal(clampMicBoostBpm('8'), DEFAULT_MIC_BOOST_BPM);
        assert.equal(clampMicBoostBpm('nope'), DEFAULT_MIC_BOOST_BPM);
        assert.equal(clampMicBoostBpm(0), 0);
    });

    it('is silent at or under the gate and scales up to the cap', () => {
        assert.equal(micBoostFromLevel(40, 40, 8), 0);
        assert.equal(micBoostFromLevel(20, 40, 8), 0);
        assert.equal(micBoostFromLevel(100, 40, 8), 8);
        assert.equal(micBoostFromLevel(70, 40, 8), 4);
        assert.equal(micBoostFromLevel(100, 40, 0), 0);
        assert.ok(micBoostFromLevel(90, 40, 8) > micBoostFromLevel(50, 40, 8));
    });
});
