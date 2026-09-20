import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeChartScale, CHART_SAMPLES } from './chart.js';

describe('computeChartScale', () => {
    it('keeps the classic 50-180 window for ordinary limits', () => {
        assert.deepEqual(computeChartScale(70, 140), { lo: 50, hi: 180 });
    });

    it('extends the top so a Climax HR above 180 stays on the chart', () => {
        const scale = computeChartScale(70, 195);
        assert.ok(scale.hi >= 195 + 5, 'ceiling guide line must sit inside the scale');
        assert.equal(scale.lo, 50);
    });

    it('extends the bottom for a very low resting HR', () => {
        const scale = computeChartScale(40, 140);
        assert.ok(scale.lo < 40);
        assert.equal(scale.hi, 180);
    });

    it('tolerates non-finite limits', () => {
        assert.deepEqual(computeChartScale(NaN, undefined), { lo: 50, hi: 180 });
    });

    it('keeps the 60-sample history window', () => {
        assert.equal(CHART_SAMPLES, 60);
    });
});
