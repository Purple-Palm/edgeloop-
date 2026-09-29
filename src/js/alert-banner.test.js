import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    BANNER_SEVERITIES,
    BANNER_OWNER_ANY,
    bannerRank,
    mergeBannerMessage,
    planBannerUpdate,
    planBannerHide,
    canClearBanner,
    hiddenBannerState
} from './alert-banner.js';

const MOTOR_ALERT = 'The Handy did not confirm a stop and may still be moving: check the device. (timeout)';
const MIC_ALERT = 'The microphone stopped (revoked, unplugged or taken by another app).';
// The report The Handy's driver raises when GET /connected says the device
// is gone, and the line app.js appends when that answer refused a START.
const OFFLINE_REPORT = 'The Handy reports it is no longer connected to Wi-Fi.';
const START_REFUSAL = 'The session was not started: The Handy is offline. Check the device, then connect it again in The Handy panel.';

describe('alert banner ranking', () => {
    it('ranks nothing below an advisory below a safety report', () => {
        assert.deepEqual(BANNER_SEVERITIES, ['none', 'advisory', 'safety']);
        assert.ok(bannerRank('safety') > bannerRank('advisory'));
        assert.ok(bannerRank('advisory') > bannerRank('none'));
        assert.equal(bannerRank('not-a-severity'), 0);
        assert.equal(bannerRank(undefined), 0);
    });

    it('a microphone advisory never destroys a report that a motor may be moving', () => {
        // The exact sequence from the field: the Handy stops answering, the
        // driver cannot confirm its stop, and a second later the OS hands the
        // microphone to another app. Whichever fired last used to win.
        const safety = planBannerUpdate(hiddenBannerState(), {
            message: MOTOR_ALERT, severity: 'safety', source: 'device'
        });
        assert.equal(safety.text, MOTOR_ALERT);
        assert.equal(safety.severity, 'safety');

        const after = planBannerUpdate(safety, { message: MIC_ALERT, severity: 'advisory', source: 'mic' });
        assert.ok(after.text.includes(MOTOR_ALERT), 'the safety report must survive');
        assert.ok(after.text.includes(MIC_ALERT), 'and the advisory must not be swallowed either');
        assert.equal(after.severity, 'safety', 'the banner keeps the higher rank');
        assert.equal(after.source, 'device', 'and its owner, so only that owner can clear it');
    });

    it('a safety report always replaces a standing advisory', () => {
        const advisory = planBannerUpdate(hiddenBannerState(), {
            message: MIC_ALERT, severity: 'advisory', source: 'mic'
        });
        const safety = planBannerUpdate(advisory, { message: MOTOR_ALERT, severity: 'safety', source: 'device' });
        assert.equal(safety.text, MOTOR_ALERT);
        assert.equal(safety.severity, 'safety');
        assert.equal(safety.source, 'device');
    });

    it('a later safety report replaces an earlier one of the same rank', () => {
        const first = planBannerUpdate(hiddenBannerState(), {
            message: 'Heart rate signal lost. Motors stopped.', severity: 'safety', source: 'hrSignal'
        });
        const second = planBannerUpdate(first, { message: MOTOR_ALERT, severity: 'safety', source: 'device' });
        assert.equal(second.text, MOTOR_ALERT);
        assert.equal(second.source, 'device');
    });

    it('an unknown or missing severity is treated as an advisory, never as safety', () => {
        const safety = planBannerUpdate(hiddenBannerState(), {
            message: MOTOR_ALERT, severity: 'safety', source: 'device'
        });
        for (const bogus of [undefined, null, 'critical', 'none', 42]) {
            const out = planBannerUpdate(safety, { message: 'anything', severity: bogus, source: 'x' });
            assert.equal(out.severity, 'safety', `"${String(bogus)}" must not outrank a safety report`);
            assert.ok(out.text.includes(MOTOR_ALERT));
        }
    });

    it('never repeats the same sentence twice', () => {
        // onmute can be followed by onended with the same wording.
        const safety = planBannerUpdate(hiddenBannerState(), {
            message: MOTOR_ALERT, severity: 'safety', source: 'device'
        });
        const once = planBannerUpdate(safety, { message: MIC_ALERT, severity: 'advisory', source: 'mic' });
        const twice = planBannerUpdate(once, { message: MIC_ALERT, severity: 'advisory', source: 'mic' });
        assert.equal(twice.text, once.text);
    });

    it('merges nothing when one side is empty', () => {
        assert.equal(mergeBannerMessage('', MIC_ALERT), MIC_ALERT);
        assert.equal(mergeBannerMessage(MOTOR_ALERT, ''), MOTOR_ALERT);
        assert.equal(mergeBannerMessage(null, undefined), '');
    });
});

describe('alert banner clearing', () => {
    const safety = planBannerUpdate(hiddenBannerState(), {
        message: MOTOR_ALERT, severity: 'safety', source: 'device'
    });

    it('is owned: a returning heart rate cannot clear a device report', () => {
        assert.equal(canClearBanner(safety, 'hrSignal'), false);
        assert.equal(canClearBanner(safety, 'remote'), false);
        assert.equal(canClearBanner(safety, 'mic'), false);
        assert.equal(canClearBanner(safety, 'device'), true);
    });

    it('a signal-loss banner is cleared by the pulse coming back, and only by it', () => {
        const hr = planBannerUpdate(hiddenBannerState(), {
            message: 'Heart rate signal lost. Motors stopped.', severity: 'safety', source: 'hrSignal'
        });
        assert.equal(canClearBanner(hr, 'hrSignal'), true);
        assert.equal(canClearBanner(hr, 'device'), false);
    });

    it('a microphone advisory appended to a safety report is not cleared by the microphone', () => {
        const merged = planBannerUpdate(safety, { message: MIC_ALERT, severity: 'advisory', source: 'mic' });
        assert.equal(canClearBanner(merged, 'mic'), false, 'the safety report still owns the banner');
        assert.equal(canClearBanner(merged, 'device'), true);
    });

    it('the wearer can always dismiss it by hand', () => {
        assert.equal(canClearBanner(safety, BANNER_OWNER_ANY), true);
        assert.equal(canClearBanner(hiddenBannerState(), 'anything'), true);
    });

    it('hiddenBannerState is really hidden', () => {
        assert.deepEqual(hiddenBannerState(), { visible: false, severity: 'none', source: 'none', text: '', lines: [] });
    });
});

describe('alert banner: taking back an appended sentence', () => {
    // The sequence from the field: START asks The Handy whether it is
    // online, the answer is no, the driver raises its offline report, and
    // the refusal is appended under it. The wearer connects the device again
    // and presses START; the session runs. The refusal's owner could not
    // hide a banner the offline report owned, so the motors ran under "The
    // session was not started: The Handy is offline".
    const offline = planBannerUpdate(hiddenBannerState(), {
        message: OFFLINE_REPORT, severity: 'safety', source: 'device'
    });
    const refused = planBannerUpdate(offline, {
        message: START_REFUSAL, severity: 'advisory', source: 'handyCheck'
    });

    it('the refusal under the offline report is taken back, and the report stays', () => {
        assert.equal(refused.text, `${OFFLINE_REPORT} Also: ${START_REFUSAL}`);
        const after = planBannerHide(refused, 'handyCheck');
        assert.equal(after.visible, true, 'the offline report is still up');
        assert.equal(after.text, OFFLINE_REPORT, 'and it is all the banner says');
        assert.equal(after.severity, 'safety');
        assert.equal(after.source, 'device', 'still owned by the report, so only it or the wearer can hide it');
        assert.equal(canClearBanner(after, 'handyCheck'), false);
    });

    it('nothing else can take the refusal back, and nobody but its owner can take back the report', () => {
        for (const owner of ['hrSignal', 'mic', 'remote', 'none', '', undefined, null]) {
            const after = planBannerHide(refused, owner);
            assert.equal(after.visible, true);
            assert.equal(after.text, refused.text, `"${String(owner)}" changed the banner`);
        }
        const offlineOnly = planBannerHide(offline, 'handyCheck');
        assert.equal(offlineOnly.visible, true);
        assert.equal(offlineOnly.text, OFFLINE_REPORT, 'a report nobody appended to has nothing to take back');
    });

    it('the banner\'s owner, and the wearer, still hide all of it', () => {
        assert.equal(planBannerHide(refused, 'device').visible, false);
        assert.equal(planBannerHide(refused, BANNER_OWNER_ANY).visible, false);
        // A refusal alone on the banner is its own report: its owner hides it.
        const alone = planBannerUpdate(hiddenBannerState(), {
            message: START_REFUSAL, severity: 'advisory', source: 'handyCheck'
        });
        assert.equal(planBannerHide(alone, 'handyCheck').visible, false);
    });

    it('takes back only its own sentence: everyone else\'s stay, in the order they came', () => {
        const three = planBannerUpdate(
            planBannerUpdate(offline, { message: START_REFUSAL, severity: 'advisory', source: 'handyCheck' }),
            { message: MIC_ALERT, severity: 'advisory', source: 'mic' }
        );
        assert.equal(three.text, `${OFFLINE_REPORT} Also: ${START_REFUSAL} Also: ${MIC_ALERT}`);
        const noRefusal = planBannerHide(three, 'handyCheck');
        assert.equal(noRefusal.text, `${OFFLINE_REPORT} Also: ${MIC_ALERT}`);
        assert.equal(planBannerHide(noRefusal, 'mic').text, OFFLINE_REPORT);
        // And a sentence appended after one was taken back still lands after
        // what is left, and can be taken back in its turn.
        const again = planBannerUpdate(noRefusal, { message: START_REFUSAL, severity: 'advisory', source: 'handyCheck' });
        assert.equal(again.text, `${OFFLINE_REPORT} Also: ${MIC_ALERT} Also: ${START_REFUSAL}`);
        assert.equal(planBannerHide(again, 'handyCheck').text, `${OFFLINE_REPORT} Also: ${MIC_ALERT}`);
    });

    it('an owner that repeats a sentence is shown and recorded once, so one withdrawal takes it back', () => {
        let state = refused;
        for (let i = 0; i < 5; i++) {
            state = planBannerUpdate(state, { message: START_REFUSAL, severity: 'advisory', source: 'handyCheck' });
        }
        assert.equal(state.text, refused.text);
        assert.equal(state.lines.length, refused.lines.length, 'a repeat does not pile up behind the banner');
        assert.equal(planBannerHide(state, 'handyCheck').text, OFFLINE_REPORT);
        // Nor does a notice with nothing to say.
        const empty = planBannerUpdate(state, { message: '   ', severity: 'advisory', source: 'mic' });
        assert.equal(empty.text, state.text);
        assert.equal(empty.lines.length, state.lines.length);
    });

    it('a sentence two owners reported stays until both have taken it back', () => {
        // The wearer reads it once; the first owner to take it back must not
        // take it away from the other, who still stands by it.
        const both = planBannerUpdate(refused, { message: START_REFUSAL, severity: 'advisory', source: 'mic' });
        assert.equal(both.text, refused.text, 'shown once');
        const oneLeft = planBannerHide(both, 'handyCheck');
        assert.equal(oneLeft.text, `${OFFLINE_REPORT} Also: ${START_REFUSAL}`);
        assert.equal(planBannerHide(oneLeft, 'mic').text, OFFLINE_REPORT);
        assert.equal(planBannerHide(planBannerHide(both, 'mic'), 'handyCheck').text, OFFLINE_REPORT);
    });

    it('a later report of the same rank replaces the banner, appended sentences with it', () => {
        const replaced = planBannerUpdate(refused, { message: MOTOR_ALERT, severity: 'safety', source: 'device' });
        assert.equal(replaced.text, MOTOR_ALERT);
        assert.deepEqual(replaced.lines, [{ source: 'device', text: MOTOR_ALERT }], 'nothing of the old banner is kept behind the new one');
        assert.equal(planBannerHide(replaced, 'handyCheck').text, MOTOR_ALERT, 'the refusal went with the old report');
    });

    it('a banner whose sentences cannot be told apart is one sentence of its owner\'s', () => {
        // Built by hand, or lines that no longer add up to the text: nobody
        // but the owner and the wearer may take back any of it, so a safety
        // report can never lose a word to a stray withdrawal.
        const byHand = { visible: true, severity: 'safety', source: 'device', text: refused.text };
        assert.equal(planBannerHide(byHand, 'handyCheck').text, refused.text);
        const tampered = { ...refused, lines: [{ source: 'device', text: OFFLINE_REPORT }, { source: 'handyCheck', text: 'something else' }] };
        assert.equal(planBannerHide(tampered, 'handyCheck').text, refused.text);
        const ownerless = { ...refused, lines: [{ source: 'handyCheck', text: OFFLINE_REPORT }, { source: 'handyCheck', text: START_REFUSAL }] };
        assert.equal(planBannerHide(ownerless, 'handyCheck').text, refused.text, 'the first sentence must be the owner\'s');
        assert.equal(planBannerHide(byHand, 'device').visible, false, 'its owner still hides it');
    });

    it('taking back from a hidden banner leaves it hidden', () => {
        assert.deepEqual(planBannerHide(hiddenBannerState(), 'handyCheck'), hiddenBannerState());
    });
});

describe('app.js routes every banner write through the ranking', () => {
    const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

    it('nothing writes #disconnectMsg or shows or hides the banner behind renderAlertBanner()', () => {
        // One banner carries heart-rate loss, a dropped monitor, an offline
        // Handy, a dead remote link, "the Handy may still be moving" and the
        // microphone advisory. A direct write is how one of them silently
        // replaced another. renderAlertBanner() only draws the state that
        // showAlertBanner() and hideAlertBanner() planned.
        const writes = src.match(/getElementById\('disconnectMsg'\)/g) || [];
        assert.equal(writes.length, 1, 'only renderAlertBanner() may write the banner text');
        const unhides = src.match(/disconnectBanner'\)[\s\S]{0,40}?classList\.remove\('hidden'\)/g) || [];
        assert.ok(unhides.length <= 1, 'only renderAlertBanner() may reveal the banner');
        const hides = src.match(/disconnectBanner'\)\??\.classList\.add\('hidden'\)/g) || [];
        assert.equal(hides.length, 1, 'only renderAlertBanner() may hide the banner');
    });

    it('the microphone reports at advisory level and the safety paths at safety level', () => {
        const mic = src.indexOf('function handleMicLost');
        assert.ok(mic >= 0, 'handleMicLost not found');
        const micBody = src.slice(mic, src.indexOf('\nfunction startMicMeterLoop'));
        assert.ok(/severity: 'advisory'/.test(micBody), 'a lost microphone is an advisory, not a safety report');

        const alert = src.indexOf('function triggerDisconnectAlert');
        assert.ok(alert >= 0, 'triggerDisconnectAlert not found');
        const alertBody = src.slice(alert, alert + 400);
        assert.ok(/severity: 'safety'/.test(alertBody), 'every disconnect alert is a safety report');
    });
});
