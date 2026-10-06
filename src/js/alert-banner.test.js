import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
    BANNER_SEVERITIES,
    BANNER_OWNER_ANY,
    MOTORS_PAUSED,
    bannerRank,
    mergeBannerMessage,
    planBannerUpdate,
    planBannerClear,
    planBannerRevise,
    planBannerPauseEnded,
    canClearBanner,
    hiddenBannerState
} from './alert-banner.js';

const MOTOR_ALERT = 'The Handy did not confirm a stop and may still be moving: check the device. (timeout)';
const MIC_ALERT = 'The microphone stopped (revoked, unplugged or taken by another app).';
// The watchdog's report: its own words, then the clause that the session
// was paused, which is how app.js raises it.
const HR_LOSS = 'Fake Strap HR: no valid heart-rate reading for 9 s (no packets received).';
const HR_ALERT = `${HR_LOSS} ${MOTORS_PAUSED}`;
const HANDY_GONE = 'The Handy disconnected.';
const VERSION_NOTICE = "Your partner's controller runs an older version of EdgeLoop. Mode and game changes can mean different things in different versions, so this page refuses them from it.";
const VOICE_NOTICE = 'The voice could not speak: the browser has no voice installed.';
// Device reports that say the session was paused, as app.js raises them.
const INTIFACE_LOST = 'Intiface Central connection lost: 1 assigned toy unreachable.';
const TCODE_LOST = 'TCode Serial device lost: 2 assigned axes unreachable.';
const LINK_LOST = 'The Handy connection was lost while reconnecting.';
// The report The Handy's driver raises when GET /connected says the device
// is gone, and the line app.js adds when that answer refused a START.
const OFFLINE_REPORT = 'The Handy reports it is no longer connected to Wi-Fi.';
const START_REFUSAL = 'The session was not started: The Handy is offline. Check the device, then connect it again in The Handy panel.';

const show = (state, message, severity, source) => planBannerUpdate(state, { message, severity, source });
// A safety report that tells the wearer the session was paused.
const paused = (state, message, source) => planBannerUpdate(state, { message, severity: 'safety', source, motorsPaused: true });

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
        const safety = show(hiddenBannerState(), MOTOR_ALERT, 'safety', 'handyStop');
        assert.equal(safety.text, MOTOR_ALERT);
        assert.equal(safety.severity, 'safety');

        const after = show(safety, MIC_ALERT, 'advisory', 'mic');
        assert.equal(after.text, `${MOTOR_ALERT} Also: ${MIC_ALERT}`, 'the safety report is read first, the advisory after it');
        assert.equal(after.severity, 'safety', 'the banner keeps the higher rank');
        assert.equal(after.source, 'handyStop', 'and is led by the safety report');
    });

    it('a safety report takes the banner from a standing advisory, and keeps it under itself', () => {
        const advisory = show(hiddenBannerState(), MIC_ALERT, 'advisory', 'mic');
        const safety = show(advisory, MOTOR_ALERT, 'safety', 'handyStop');
        assert.equal(safety.text, `${MOTOR_ALERT} Also: ${MIC_ALERT}`);
        assert.equal(safety.severity, 'safety');
        assert.equal(safety.source, 'handyStop');
    });

    it('a later report of the same rank is read first, and the earlier one stays under it', () => {
        const first = show(hiddenBannerState(), MOTOR_ALERT, 'safety', 'handyStop');
        const second = paused(first, HR_LOSS, 'hrSignal');
        assert.equal(second.text, `${HR_ALERT} Also: ${MOTOR_ALERT}`);
        assert.equal(second.source, 'hrSignal');
        assert.deepEqual(second.notices.map((n) => n.source), ['hrSignal', 'handyStop']);
    });

    it('an unknown or missing severity is treated as an advisory, never as safety', () => {
        const safety = show(hiddenBannerState(), MOTOR_ALERT, 'safety', 'handyStop');
        for (const bogus of [undefined, null, 'critical', 'none', 42]) {
            const out = show(safety, 'anything', bogus, 'x');
            assert.equal(out.severity, 'safety', `"${String(bogus)}" must not outrank a safety report`);
            assert.ok(out.text.startsWith(MOTOR_ALERT));
        }
    });

    it('never repeats the same sentence twice', () => {
        // onmute can be followed by onended with the same wording.
        const safety = show(hiddenBannerState(), MOTOR_ALERT, 'safety', 'handyStop');
        const once = show(safety, MIC_ALERT, 'advisory', 'mic');
        const twice = show(once, MIC_ALERT, 'advisory', 'mic');
        assert.equal(twice.text, once.text);
        assert.equal(twice.notices.length, 2);
    });

    it('merges nothing when one side is empty', () => {
        assert.equal(mergeBannerMessage('', MIC_ALERT), MIC_ALERT);
        assert.equal(mergeBannerMessage(MOTOR_ALERT, ''), MOTOR_ALERT);
        assert.equal(mergeBannerMessage(null, undefined), '');
    });

    it('never mutates the state it is given', () => {
        const both = show(show(hiddenBannerState(), HANDY_GONE, 'safety', 'handyLink'), VERSION_NOTICE, 'advisory', 'peerVersion');
        const snapshot = JSON.stringify(both);
        planBannerClear(both, 'peerVersion');
        planBannerClear(both, 'handyLink');
        planBannerClear(both, BANNER_OWNER_ANY);
        show(both, MIC_ALERT, 'advisory', 'mic');
        show(both, MOTOR_ALERT, 'safety', 'handyLink');
        planBannerRevise(both, { message: 'The Handy went offline.', severity: 'safety', source: 'handyLink' });
        assert.equal(JSON.stringify(both), snapshot);
    });
});

describe('a notice leaves only with its own source', () => {
    const handyDown = show(hiddenBannerState(), HANDY_GONE, 'safety', 'handyLink');

    it('withdrawing takes that source\'s sentence and nothing else', () => {
        const withMic = show(handyDown, MIC_ALERT, 'advisory', 'mic');
        const withBoth = show(withMic, VERSION_NOTICE, 'advisory', 'peerVersion');
        assert.equal(planBannerClear(withBoth, 'peerVersion').text, `${HANDY_GONE} Also: ${MIC_ALERT}`);
        assert.equal(planBannerClear(withBoth, 'mic').text, `${HANDY_GONE} Also: ${VERSION_NOTICE}`);
        const handyBack = planBannerClear(withBoth, 'handyLink');
        assert.equal(handyBack.text, `${VERSION_NOTICE} Also: ${MIC_ALERT}`);
        assert.equal(handyBack.severity, 'advisory', 'the banner drops to the rank of what is left');
        assert.equal(handyBack.source, 'peerVersion', 'the newest notice left leads it');
    });

    it('a source that does not own a sentence can never take the safety report down', () => {
        const both = show(handyDown, VERSION_NOTICE, 'advisory', 'peerVersion');
        for (const owner of ['peerVersion', 'mic', 'hrSignal', 'remote', 'handyStop', 'device', undefined, null, '']) {
            const after = planBannerClear(both, owner);
            assert.equal(after.visible, true, `"${String(owner)}" must not hide the banner`);
            assert.ok(after.text.startsWith(HANDY_GONE), `"${String(owner)}" must not remove the report`);
            assert.equal(after.severity, 'safety');
        }
    });

    it('a source with nothing on the banner changes nothing', () => {
        assert.deepEqual(planBannerClear(handyDown, 'peerVersion'), handyDown);
        assert.deepEqual(planBannerClear(hiddenBannerState(), 'peerVersion'), hiddenBannerState());
    });

    it('the owner withdrawing the last notice hides the banner', () => {
        assert.deepEqual(planBannerClear(handyDown, 'handyLink'), hiddenBannerState());
    });

    it('the wearer\'s Dismiss clears every notice', () => {
        const all = show(show(paused(handyDown, HR_LOSS, 'hrSignal'), MIC_ALERT, 'advisory', 'mic'), MOTOR_ALERT, 'safety', 'handyStop');
        assert.equal(all.notices.length, 4);
        assert.deepEqual(planBannerClear(all, BANNER_OWNER_ANY), hiddenBannerState());
    });

    it('a source reporting again replaces its own sentence rather than doubling it', () => {
        // The refused click says the version notice again; an unconfirmed
        // stop retried while the API still fails is reported again with the
        // newest error.
        const older = show(handyDown, VERSION_NOTICE, 'advisory', 'peerVersion');
        assert.equal(show(older, VERSION_NOTICE, 'advisory', 'peerVersion').text, older.text);
        const newer = show(older, 'Your partner\'s controller runs a newer version of EdgeLoop.', 'advisory', 'peerVersion');
        assert.equal(newer.text, `${HANDY_GONE} Also: Your partner's controller runs a newer version of EdgeLoop.`);
        assert.equal(newer.notices.length, 2);
        const stop1 = show(handyDown, `${MOTOR_ALERT} (503)`, 'safety', 'handyStop');
        const stop2 = show(stop1, `${MOTOR_ALERT} (timeout)`, 'safety', 'handyStop');
        assert.deepEqual(stop2.notices.map((n) => n.text), [`${MOTOR_ALERT} (timeout)`, HANDY_GONE]);
    });

    it('a source\'s lower-priority report never takes down its own higher-priority one', () => {
        const safety = show(hiddenBannerState(), 'Stop not confirmed.', 'safety', 'x');
        const both = show(safety, 'Firmware is old.', 'advisory', 'x');
        assert.equal(both.text, 'Stop not confirmed. Also: Firmware is old.');
        assert.equal(both.severity, 'safety');
        // Whatever a source raised goes when it withdraws.
        assert.deepEqual(planBannerClear(both, 'x'), hiddenBannerState());
        // A report of its own of the same or a higher rank supersedes both.
        const worse = show(both, 'Still moving.', 'safety', 'x');
        assert.equal(worse.text, 'Still moving.');
        assert.equal(worse.notices.length, 1);
    });

    it('a state from before the notice list is one report, owned by its source', () => {
        const legacy = { visible: true, severity: 'safety', source: 'handyStop', text: `${MOTOR_ALERT} Also: ${MIC_ALERT}` };
        const withVersion = show(legacy, VERSION_NOTICE, 'advisory', 'peerVersion');
        assert.equal(withVersion.text, `${MOTOR_ALERT} Also: ${MIC_ALERT} Also: ${VERSION_NOTICE}`);
        // Nobody but its owner and the wearer can take a word of it back.
        assert.equal(planBannerClear(withVersion, 'mic').text, withVersion.text);
        assert.deepEqual(planBannerClear(withVersion, 'handyStop').notices.map((n) => n.source), ['peerVersion']);
        assert.deepEqual(planBannerClear({ visible: false, text: 'stale' }, 'x'), hiddenBannerState());
    });
});

describe('a source rewords what it has standing', () => {
    const TWO = 'Two Handys did not confirm a stop and may still be moving: check both devices. (timeout)';

    it('in place: the new words keep the old ones\' place in the reading order', () => {
        // One of two Handys confirmed its stop while the pulse was lost: the
        // stop report says what is left, and stays read after the newer one.
        const two = show(hiddenBannerState(), TWO, 'safety', 'handyStop');
        const lost = paused(two, HR_LOSS, 'hrSignal');
        const left = planBannerRevise(lost, { message: MOTOR_ALERT, severity: 'safety', source: 'handyStop' });
        assert.equal(left.text, `${HR_ALERT} Also: ${MOTOR_ALERT}`);
        assert.deepEqual(left.notices.map((n) => n.source), ['hrSignal', 'handyStop']);
        assert.equal(left.source, 'hrSignal');
    });

    it('never puts back a report that is not standing: never raised, withdrawn or dismissed', () => {
        const revise = (state) => planBannerRevise(state, { message: MOTOR_ALERT, severity: 'safety', source: 'handyStop' });
        assert.deepEqual(revise(hiddenBannerState()), hiddenBannerState());
        const two = show(show(hiddenBannerState(), HANDY_GONE, 'safety', 'handyLink'), TWO, 'safety', 'handyStop');
        assert.equal(revise(planBannerClear(two, 'handyStop')).text, HANDY_GONE);
        assert.deepEqual(revise(planBannerClear(two, BANNER_OWNER_ANY)), hiddenBannerState());
    });

    it('touches no other source, and only its own notice at that rank', () => {
        const mixed = show(show(show(hiddenBannerState(), 'Stop not confirmed.', 'safety', 'x'), 'Firmware is old.', 'advisory', 'x'), MIC_ALERT, 'advisory', 'mic');
        const safer = planBannerRevise(mixed, { message: 'Still not confirmed.', severity: 'safety', source: 'x' });
        assert.equal(safer.text, `Still not confirmed. Also: ${MIC_ALERT} Also: Firmware is old.`);
        const advised = planBannerRevise(mixed, { message: 'Firmware is very old.', severity: 'advisory', source: 'x' });
        assert.equal(advised.text, `Stop not confirmed. Also: ${MIC_ALERT} Also: Firmware is very old.`);
    });

    it('an empty text changes nothing', () => {
        const two = show(hiddenBannerState(), TWO, 'safety', 'handyStop');
        for (const message of ['', '   ', undefined, null, 42]) {
            assert.deepEqual(planBannerRevise(two, { message, severity: 'safety', source: 'handyStop' }), two);
        }
    });
});

describe('each report is on the banner exactly as long as its cause lasts', () => {
    // The flows behind the rules. Each source withdraws its own sentence the
    // moment what it reports is over (app.js); no report ever takes another
    // source's sentence off, so a notice stays exactly as long as its cause.

    it('an unconfirmed stop outlives a signal-loss pause, and leaves when a stop is confirmed', () => {
        // The Handy's stop is still unconfirmed when the pulse is lost, and
        // still when it comes back. A report of the same rank used to take
        // the stop warning off the banner, so the returning pulse blanked it.
        const stop = show(hiddenBannerState(), MOTOR_ALERT, 'safety', 'handyStop');
        const lost = paused(stop, HR_LOSS, 'hrSignal');
        assert.equal(lost.text, `${HR_ALERT} Also: ${MOTOR_ALERT}`);
        const pulseBack = planBannerClear(lost, 'hrSignal');
        assert.equal(pulseBack.text, MOTOR_ALERT, 'nobody has confirmed the stop yet');
        assert.equal(pulseBack.severity, 'safety');
        // The API confirms a stop: the report is over, and nothing is left.
        assert.deepEqual(planBannerClear(pulseBack, 'handyStop'), hiddenBannerState());
    });

    it('a confirmed stop takes its warning down during the pause, and the pause report stays', () => {
        const stop = show(hiddenBannerState(), MOTOR_ALERT, 'safety', 'handyStop');
        const lost = paused(stop, HR_LOSS, 'hrSignal');
        const confirmed = planBannerClear(lost, 'handyStop');
        assert.equal(confirmed.text, HR_ALERT);
        assert.equal(confirmed.source, 'hrSignal');
        assert.deepEqual(planBannerClear(confirmed, 'hrSignal'), hiddenBannerState());
    });

    it('a Handy connected again takes down its disconnect report, and never the stop it still owes', () => {
        const gone = show(hiddenBannerState(), HANDY_GONE, 'safety', 'handyLink');
        const owed = show(gone, MOTOR_ALERT, 'safety', 'handyStop');
        assert.equal(owed.text, `${MOTOR_ALERT} Also: ${HANDY_GONE}`);
        // Connected again with another key: another device, so the stop the
        // first one owes stays reported.
        const other = planBannerClear(owed, 'handyLink');
        assert.equal(other.text, MOTOR_ALERT);
        // A later offline report of the same Handy does not replace it either.
        const offline = show(other, 'The Handy API is unreachable.', 'safety', 'handyLink');
        assert.equal(offline.text, `The Handy API is unreachable. Also: ${MOTOR_ALERT}`);
    });

    it('the pulse and the toy each take down only their own report', () => {
        // The pulse is lost, the Handy is disconnected during the pause, the
        // pulse comes back (no toy to resume on), the Handy is connected
        // again and the wearer resumes: nothing is left to say.
        const lost = paused(hiddenBannerState(), HR_LOSS, 'hrSignal');
        const gone = show(lost, HANDY_GONE, 'safety', 'handyLink');
        assert.equal(gone.text, `${HANDY_GONE} Also: ${HR_ALERT}`);
        const pulseBack = planBannerClear(gone, 'hrSignal');
        assert.equal(pulseBack.text, HANDY_GONE, 'still true: the session cannot resume with no toy');
        assert.deepEqual(planBannerClear(pulseBack, 'handyLink'), hiddenBannerState());
    });

    it('the version notice does not take the microphone report away with it', () => {
        // The microphone is revoked mid-session, a 1.1.0 controller connects,
        // and the partner reloads that page as the notice asks. The
        // microphone is still gone, so the banner must still say so.
        const mic = show(hiddenBannerState(), MIC_ALERT, 'advisory', 'mic');
        const both = show(mic, VERSION_NOTICE, 'advisory', 'peerVersion');
        assert.equal(both.text, `${VERSION_NOTICE} Also: ${MIC_ALERT}`);
        const left = planBannerClear(both, 'peerVersion');
        assert.equal(left.text, MIC_ALERT);
        assert.equal(left.source, 'mic');
        // In the other order the refused click says the notice again: read
        // first, once, and withdrawn the same way.
        const refused = show(show(show(hiddenBannerState(), VERSION_NOTICE, 'advisory', 'peerVersion'), MIC_ALERT, 'advisory', 'mic'), VERSION_NOTICE, 'advisory', 'peerVersion');
        assert.equal(refused.text, `${VERSION_NOTICE} Also: ${MIC_ALERT}`);
        assert.equal(planBannerClear(refused, 'peerVersion').text, MIC_ALERT);
    });

    it('a voice notice stands beside the microphone report and leaves on its own', () => {
        // Written into the microphone's sentence under the microphone's
        // name, it could not leave when the voice spoke again.
        const mic = show(hiddenBannerState(), MIC_ALERT, 'advisory', 'mic');
        const voice = show(mic, VOICE_NOTICE, 'advisory', 'voice');
        assert.equal(voice.text, `${VOICE_NOTICE} Also: ${MIC_ALERT}`);
        assert.equal(planBannerClear(voice, 'voice').text, MIC_ALERT);
        assert.equal(planBannerClear(voice, 'mic').text, VOICE_NOTICE);
    });
});

describe('a refused START takes back its own line, and only that', () => {
    // The sequence from the field: START asks The Handy whether it is
    // online, the answer is no, the driver raises its offline report, and
    // the refusal is read under it. The wearer connects the device again and
    // presses START; the session runs. When only the banner's owner could
    // take any of its text down, the refusal could not take its own line
    // back, and the motors ran under "The session was not started: The Handy
    // is offline".
    const offline = show(hiddenBannerState(), OFFLINE_REPORT, 'safety', 'handyLink');
    const refused = show(offline, START_REFUSAL, 'advisory', 'handyCheck');

    it('the refusal under the offline report is taken back, and the report stays', () => {
        assert.equal(refused.text, `${OFFLINE_REPORT} Also: ${START_REFUSAL}`);
        const after = planBannerClear(refused, 'handyCheck');
        assert.equal(after.visible, true, 'the offline report is still up');
        assert.equal(after.text, OFFLINE_REPORT, 'and it is all the banner says');
        assert.equal(after.severity, 'safety');
        assert.equal(after.source, 'handyLink', 'still the report\'s own, so only it or the wearer can take it down');
        assert.equal(canClearBanner(after, 'handyCheck'), false);
    });

    it('nothing else can take the refusal back, and nothing but the report\'s own source can take the report', () => {
        for (const owner of ['hrSignal', 'mic', 'remote', 'none', '', undefined, null]) {
            const after = planBannerClear(refused, owner);
            assert.equal(after.visible, true);
            assert.equal(after.text, refused.text, `"${String(owner)}" changed the banner`);
        }
        const offlineOnly = planBannerClear(offline, 'handyCheck');
        assert.equal(offlineOnly.visible, true);
        assert.equal(offlineOnly.text, OFFLINE_REPORT, 'a report with no refusal under it has nothing to take back');
    });

    it('the report and the refusal each leave with their own source, and the wearer\'s Dismiss takes both', () => {
        // A Handy connected again withdraws the offline report, and app.js
        // withdraws the refusal on the same connect (withdrawStartRefusal).
        const handyBack = planBannerClear(refused, 'handyLink');
        assert.equal(handyBack.text, START_REFUSAL);
        assert.equal(handyBack.severity, 'advisory');
        assert.deepEqual(planBannerClear(handyBack, 'handyCheck'), hiddenBannerState());
        assert.deepEqual(planBannerClear(refused, BANNER_OWNER_ANY), hiddenBannerState());
        // A refusal alone on the banner is its own report: its source hides it.
        const alone = show(hiddenBannerState(), START_REFUSAL, 'advisory', 'handyCheck');
        assert.deepEqual(planBannerClear(alone, 'handyCheck'), hiddenBannerState());
    });

    it('takes back only its own sentence: everyone else\'s stay, in reading order', () => {
        const three = show(refused, MIC_ALERT, 'advisory', 'mic');
        assert.equal(three.text, `${OFFLINE_REPORT} Also: ${MIC_ALERT} Also: ${START_REFUSAL}`);
        const noRefusal = planBannerClear(three, 'handyCheck');
        assert.equal(noRefusal.text, `${OFFLINE_REPORT} Also: ${MIC_ALERT}`);
        assert.equal(planBannerClear(noRefusal, 'mic').text, OFFLINE_REPORT);
        // A refusal said again after one was taken back is the newest notice
        // of its rank, and can be taken back in its turn.
        const again = show(noRefusal, START_REFUSAL, 'advisory', 'handyCheck');
        assert.equal(again.text, `${OFFLINE_REPORT} Also: ${START_REFUSAL} Also: ${MIC_ALERT}`);
        assert.equal(planBannerClear(again, 'handyCheck').text, `${OFFLINE_REPORT} Also: ${MIC_ALERT}`);
    });

    it('a refusal said again is shown and kept once, so one withdrawal takes it back', () => {
        let state = refused;
        for (let i = 0; i < 5; i++) state = show(state, START_REFUSAL, 'advisory', 'handyCheck');
        assert.equal(state.text, refused.text);
        assert.equal(state.notices.length, refused.notices.length, 'a repeat does not pile up behind the banner');
        assert.equal(planBannerClear(state, 'handyCheck').text, OFFLINE_REPORT);
        // A notice with nothing to say adds nothing the wearer reads.
        assert.equal(show(state, '   ', 'advisory', 'mic').text, state.text);
    });

    it('a sentence two sources reported stays until both have taken it back', () => {
        // The wearer reads it once; the first source to take it back must not
        // take it away from the other, who still stands by it.
        const both = show(refused, START_REFUSAL, 'advisory', 'mic');
        assert.equal(both.text, refused.text, 'shown once');
        const oneLeft = planBannerClear(both, 'handyCheck');
        assert.equal(oneLeft.text, `${OFFLINE_REPORT} Also: ${START_REFUSAL}`);
        assert.equal(planBannerClear(oneLeft, 'mic').text, OFFLINE_REPORT);
        assert.equal(planBannerClear(planBannerClear(both, 'mic'), 'handyCheck').text, OFFLINE_REPORT);
    });

    it('a later report of the same rank is read first, and the report and the refusal stay under it', () => {
        const later = show(refused, MOTOR_ALERT, 'safety', 'handyStop');
        assert.equal(later.text, `${MOTOR_ALERT} Also: ${OFFLINE_REPORT} Also: ${START_REFUSAL}`);
        assert.equal(planBannerClear(later, 'handyCheck').text, `${MOTOR_ALERT} Also: ${OFFLINE_REPORT}`, 'the refusal is still its own to take back');
    });

    it('a banner whose sentences cannot be told apart is one sentence of its source\'s, and a hidden one stays hidden', () => {
        // Built by hand, with no notice list: nobody but that source and the
        // wearer may take back any of it, so a safety report can never lose
        // a word to a stray withdrawal.
        const byHand = { visible: true, severity: 'safety', source: 'handyLink', text: refused.text };
        assert.equal(planBannerClear(byHand, 'handyCheck').text, refused.text);
        assert.deepEqual(planBannerClear(byHand, 'handyLink'), hiddenBannerState(), 'its source still takes it down');
        assert.deepEqual(planBannerClear(hiddenBannerState(), 'handyCheck'), hiddenBannerState());
    });
});

describe('once the pause is over, no report says the motors are paused', () => {
    // "Motors paused for safety." is true while the session stays paused, and
    // over the moment it runs again (RESUME on the toys that are left, START,
    // the watchdog's auto-resume) or STOP or Reset ends it. The rest of a
    // device's report is still true while that device is gone, so the report
    // stays, where it stands.
    const says = (banner) => banner.text.includes(MOTORS_PAUSED);

    it('the clause goes and the report stays, in its own words and at its rank', () => {
        const lost = paused(hiddenBannerState(), INTIFACE_LOST, 'intiface');
        assert.equal(lost.text, `${INTIFACE_LOST} ${MOTORS_PAUSED}`);
        const runs = planBannerPauseEnded(lost);
        assert.equal(runs.visible, true, 'the Intiface toy is still unreachable');
        assert.equal(runs.text, INTIFACE_LOST);
        assert.equal(runs.severity, 'safety');
        assert.equal(runs.source, 'intiface');
        // Still that source's to withdraw: connected again, it is over.
        assert.deepEqual(planBannerClear(runs, 'intiface'), hiddenBannerState());
    });

    for (const [source, words] of [['intiface', INTIFACE_LOST], ['tcode', TCODE_LOST], ['handyLink', LINK_LOST]]) {
        it(`${source}: resumed on the toy that is left, then a signal loss and the auto-resume`, () => {
            // The device is lost and the session paused; the wearer resumes
            // on the other toy; the strap goes quiet and the watchdog pauses;
            // the pulse comes back and the session resumes by itself. The
            // clause used to stand over the running session after RESUME,
            // and to come back into view after the auto-resume.
            const lost = paused(hiddenBannerState(), words, source);
            const resumed = planBannerPauseEnded(lost);
            assert.equal(resumed.text, words);
            const watchdog = paused(resumed, HR_LOSS, 'hrSignal');
            assert.equal(watchdog.text, `${HR_ALERT} Also: ${words}`, 'the new pause says so, once, and the device report is read under it');
            const pulseBack = planBannerClear(watchdog, 'hrSignal');
            assert.equal(pulseBack.text, words);
            const autoResumed = planBannerPauseEnded(pulseBack);
            assert.equal(autoResumed.text, words);
            assert.ok(!says(resumed) && !says(autoResumed), 'never while the motors run');
        });
    }

    it('STOP ends the pause too, and not what the reports say about their devices', () => {
        // The watchdog paused the session and Intiface was lost during that
        // pause; the wearer presses STOP. Nothing reads a pulse and the toy
        // is still unreachable, but no session is paused any more.
        const lost = paused(paused(hiddenBannerState(), HR_LOSS, 'hrSignal'), INTIFACE_LOST, 'intiface');
        const stopped = planBannerPauseEnded(lost);
        assert.equal(stopped.text, `${INTIFACE_LOST} Also: ${HR_LOSS}`);
        assert.equal(stopped.severity, 'safety');
        // The pulse returns: its report goes, the toy's stays.
        assert.equal(planBannerClear(stopped, 'hrSignal').text, INTIFACE_LOST);
    });

    it('a start that is refused leaves the session paused, and the clause with it', () => {
        // Intiface is the only toy. The watchdog pauses, the Intiface link
        // drops during that pause, and the pulse comes back: the auto-resume
        // is refused, since there is no toy. The session is still paused, and
        // the report still says so.
        const watchdog = paused(hiddenBannerState(), HR_LOSS, 'hrSignal');
        const lost = paused(watchdog, INTIFACE_LOST, 'intiface');
        assert.equal(lost.text, `${INTIFACE_LOST} ${MOTORS_PAUSED} Also: ${HR_ALERT}`);
        const refused = planBannerClear(lost, 'hrSignal');
        assert.equal(refused.text, `${INTIFACE_LOST} ${MOTORS_PAUSED}`);
        // Connected again and resumed: nothing is left to say.
        assert.deepEqual(planBannerPauseEnded(planBannerClear(refused, 'intiface')), hiddenBannerState());
    });

    it('a pause reported after the session ran says so again, and only its own report does', () => {
        const resumed = planBannerPauseEnded(paused(hiddenBannerState(), TCODE_LOST, 'tcode'));
        const again = paused(resumed, INTIFACE_LOST, 'intiface');
        assert.equal(again.text, `${INTIFACE_LOST} ${MOTORS_PAUSED} Also: ${TCODE_LOST}`);
        // The same source reporting again is a new report: it says so again.
        const tcodeAgain = paused(again, TCODE_LOST, 'tcode');
        assert.equal(tcodeAgain.text, `${TCODE_LOST} ${MOTORS_PAUSED} Also: ${INTIFACE_LOST} ${MOTORS_PAUSED}`);
        assert.equal(planBannerPauseEnded(tcodeAgain).text, `${TCODE_LOST} Also: ${INTIFACE_LOST}`);
    });

    it('every notice keeps its place, and an advisory is still read last', () => {
        // The Handy owes a stop (no clause: it may still be moving, whatever
        // the session does), T-Code and Intiface were lost, the microphone
        // stopped.
        const all = show(paused(paused(show(hiddenBannerState(), MOTOR_ALERT, 'safety', 'handyStop'), TCODE_LOST, 'tcode'), INTIFACE_LOST, 'intiface'), MIC_ALERT, 'advisory', 'mic');
        assert.deepEqual(all.notices.map((n) => n.source), ['intiface', 'tcode', 'handyStop', 'mic']);
        const runs = planBannerPauseEnded(all);
        assert.deepEqual(runs.notices.map((n) => n.source), ['intiface', 'tcode', 'handyStop', 'mic']);
        assert.deepEqual(runs.notices.map((n) => n.severity), ['safety', 'safety', 'safety', 'advisory']);
        assert.equal(runs.text, `${INTIFACE_LOST} Also: ${TCODE_LOST} Also: ${MOTOR_ALERT} Also: ${MIC_ALERT}`);
        assert.equal(runs.source, 'intiface');
        // A pause that is over is over: nothing more changes.
        assert.deepEqual(planBannerPauseEnded(runs), runs);
    });

    it('a rewording keeps whether the report says the motors are paused', () => {
        const stood = paused(show(hiddenBannerState(), MIC_ALERT, 'advisory', 'mic'), 'Two toys lost.', 'x');
        const reworded = planBannerRevise(stood, { message: 'One toy lost.', severity: 'safety', source: 'x' });
        assert.equal(reworded.text, `One toy lost. ${MOTORS_PAUSED} Also: ${MIC_ALERT}`, 'still paused: the rewording does not end it');
        const runs = planBannerPauseEnded(stood);
        const rewordedAfter = planBannerRevise(runs, { message: 'One toy lost.', severity: 'safety', source: 'x' });
        assert.equal(rewordedAfter.text, `One toy lost. Also: ${MIC_ALERT}`, 'the session runs: the rewording does not bring it back');
        // Asking a rewording for the clause is not how a pause is reported.
        const asked = planBannerRevise(runs, { message: 'One toy lost.', severity: 'safety', source: 'x', motorsPaused: true });
        assert.equal(asked.text, rewordedAfter.text);
    });

    it('a notice that said nothing but the clause leaves with it', () => {
        const bare = paused(show(hiddenBannerState(), MIC_ALERT, 'advisory', 'mic'), '', 'x');
        assert.equal(bare.text, `${MOTORS_PAUSED} Also: ${MIC_ALERT}`);
        const runs = planBannerPauseEnded(bare);
        assert.equal(runs.text, MIC_ALERT);
        assert.deepEqual(runs.notices.map((n) => n.source), ['mic']);
        assert.deepEqual(planBannerPauseEnded(paused(hiddenBannerState(), '', 'x')), hiddenBannerState());
    });

    it('nothing standing, nothing to take back: hidden, dismissed, a state from before the list', () => {
        assert.deepEqual(planBannerPauseEnded(hiddenBannerState()), hiddenBannerState());
        assert.deepEqual(planBannerPauseEnded(undefined), hiddenBannerState());
        const dismissed = planBannerClear(paused(hiddenBannerState(), INTIFACE_LOST, 'intiface'), BANNER_OWNER_ANY);
        assert.deepEqual(planBannerPauseEnded(dismissed), hiddenBannerState());
        const legacy = { visible: true, severity: 'safety', source: 'handyStop', text: MOTOR_ALERT };
        assert.equal(planBannerPauseEnded(legacy).text, MOTOR_ALERT);
        assert.equal(planBannerPauseEnded(legacy).source, 'handyStop');
    });

    it('never mutates the state it is given', () => {
        const all = show(paused(paused(hiddenBannerState(), TCODE_LOST, 'tcode'), INTIFACE_LOST, 'intiface'), MIC_ALERT, 'advisory', 'mic');
        const snapshot = JSON.stringify(all);
        planBannerPauseEnded(all);
        planBannerRevise(all, { message: 'One toy lost.', severity: 'safety', source: 'intiface' });
        assert.equal(JSON.stringify(all), snapshot);
    });
});

describe('alert banner clearing', () => {
    const safety = show(hiddenBannerState(), MOTOR_ALERT, 'safety', 'handyStop');

    it('canClearBanner says who leads the banner', () => {
        assert.equal(canClearBanner(safety, 'hrSignal'), false);
        assert.equal(canClearBanner(safety, 'mic'), false);
        assert.equal(canClearBanner(safety, 'handyStop'), true);
        const merged = show(safety, MIC_ALERT, 'advisory', 'mic');
        assert.equal(canClearBanner(merged, 'mic'), false, 'the safety report still leads');
        assert.equal(canClearBanner(merged, 'handyStop'), true);
    });

    it('the wearer can always dismiss it by hand', () => {
        assert.equal(canClearBanner(safety, BANNER_OWNER_ANY), true);
        assert.equal(canClearBanner(hiddenBannerState(), 'anything'), true);
    });

    it('hiddenBannerState is really hidden', () => {
        assert.deepEqual(hiddenBannerState(), { visible: false, severity: 'none', source: 'none', text: '', notices: [] });
    });
});

describe('any sequence of reports and withdrawals', () => {
    it('leaves exactly the sentences nobody has taken back, in reading order', () => {
        // A reference model that knows only the rules: a source's report
        // replaces its own sentences of the same or a lower rank and nothing
        // else, a rewording changes the words of that source's sentence at
        // that rank where it stands and adds nothing, a withdrawal takes all
        // of that source's sentences, the wearer's Dismiss takes everything,
        // a session that runs again takes "Motors paused for safety." off
        // every sentence and nothing else, and the banner reads the highest
        // rank first and the newest first within a rank.
        const SOURCES = [
            ['hrSignal', 'safety'], ['hrMonitor', 'safety'], ['handyLink', 'safety'], ['handyStop', 'safety'],
            ['supervision', 'safety'], ['remote', 'safety'],
            ['mic', 'advisory'], ['peerVersion', 'advisory'], ['voice', 'advisory']
        ];
        let seed = 0x5eed;
        const rand = (n) => {
            // mulberry32: the same sequence on every run.
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
        };
        const view = (list) => list.map((n) => `${n.severity}|${n.source}|${n.text}|${n.motorsPaused}`);
        const reads = (n) => (n.motorsPaused ? `${n.text} ${MOTORS_PAUSED}` : n.text);
        let steps = 0;
        for (let run = 0; run < 200; run += 1) {
            let banner = hiddenBannerState();
            let model = [];
            let seq = 0;
            for (let step = 0; step < 30; step += 1) {
                const roll = rand(14);
                const [source, usual] = SOURCES[rand(SOURCES.length)];
                // Now and then a source reports, or rewords, at the other rank.
                const severity = rand(6) === 0 ? (usual === 'safety' ? 'advisory' : 'safety') : usual;
                const text = `[${source} ${severity} ${rand(3)}]`;
                // Some reports say the session was paused; a rewording that
                // asks for the clause must not get it.
                const motorsPaused = rand(2) === 0;
                if (roll < 6) {
                    banner = planBannerUpdate(banner, { message: text, severity, source, motorsPaused });
                    model = model.filter((n) => n.source !== source || bannerRank(n.severity) > bannerRank(severity));
                    model.push({ source, severity, text, motorsPaused, seq: ++seq });
                } else if (roll < 8) {
                    banner = planBannerRevise(banner, { message: text, severity, source, motorsPaused });
                    model = model.map((n) => (n.source === source && n.severity === severity ? { ...n, text } : n));
                } else if (roll < 11) {
                    banner = planBannerClear(banner, source);
                    model = model.filter((n) => n.source !== source);
                } else if (roll < 13) {
                    banner = planBannerPauseEnded(banner);
                    model = model.map((n) => ({ ...n, motorsPaused: false }));
                    assert.ok(!banner.text.includes(MOTORS_PAUSED), `run ${run}, step ${step}: the session runs`);
                } else {
                    banner = planBannerClear(banner, BANNER_OWNER_ANY);
                    model = [];
                }
                const expected = [...model].sort((a, b) => (bannerRank(b.severity) - bannerRank(a.severity)) || (b.seq - a.seq));
                const where = `run ${run}, step ${step}`;
                assert.equal(banner.visible, expected.length > 0, where);
                assert.deepEqual(view(banner.notices), view(expected), where);
                assert.equal(banner.text, expected.map(reads).join(' Also: '), where);
                // No safety report is ever read after an advisory.
                const ranks = banner.notices.map((n) => bannerRank(n.severity));
                assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a), where);
                if (expected.length > 0) {
                    assert.equal(banner.severity, expected[0].severity, where);
                    assert.equal(banner.source, expected[0].source, where);
                }
                steps += 1;
            }
        }
        assert.equal(steps, 6000);
    });
});

// The body of the top-level function or handler that starts at `head`, up to
// the line that closes it, FAILING when `head` is missing: a slice from
// indexOf -1 is the empty string, and a missing call passes against it.
function functionBody(src, head, close = '\n}') {
    const start = src.indexOf(head);
    assert.ok(start >= 0, `not found in app.js: ${head}`);
    const end = src.indexOf(close, start + head.length);
    assert.ok(end > start, `no end after: ${head}`);
    return src.slice(start, end);
}

// The argument text of every call to `name(` in `src`: parentheses are
// matched outside strings, template literals and comments, so a message
// with "(...)" in it is read whole.
function callArguments(src, name) {
    const skipQuoted = (i, quote) => {
        for (let j = i + 1; j < src.length; j += 1) {
            if (src[j] === '\\') { j += 1; continue; }
            if (src[j] === quote) return j;
        }
        return src.length;
    };
    let skipTemplate = null;
    const skipBalanced = (i, open, close) => {
        let depth = 1;
        for (let j = i; j < src.length; j += 1) {
            const c = src[j];
            if (c === '\'' || c === '"') { j = skipQuoted(j, c); continue; }
            if (c === '`') { j = skipTemplate(j); continue; }
            if (c === '/' && src[j + 1] === '/') { j = src.indexOf('\n', j); continue; }
            if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j) + 1; continue; }
            if (c === open) depth += 1;
            else if (c === close && --depth === 0) return j;
        }
        return src.length;
    };
    skipTemplate = (i) => {
        for (let j = i + 1; j < src.length; j += 1) {
            if (src[j] === '\\') { j += 1; continue; }
            if (src[j] === '`') return j;
            if (src[j] === '$' && src[j + 1] === '{') j = skipBalanced(j + 2, '{', '}');
        }
        return src.length;
    };
    const out = [];
    const call = new RegExp(`(?<![\\w.$])${name}\\(`, 'g');
    let m;
    while ((m = call.exec(src))) {
        // Not the declaration itself.
        if (/function\s+$/.test(src.slice(Math.max(0, m.index - 16), m.index))) continue;
        const start = m.index + m[0].length;
        out.push(src.slice(start, skipBalanced(start, '(', ')')).trim());
    }
    return out;
}

describe('app.js routes every banner write through the ranking', () => {
    const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

    it('nothing touches #disconnectBanner or #disconnectMsg outside renderAlertBanner()', () => {
        // One banner carries every report. A direct write is how one of them
        // silently replaced another, and a direct hide is how a report was
        // taken down by something that did not raise it.
        const start = src.indexOf('function renderAlertBanner');
        assert.ok(start >= 0, 'renderAlertBanner not found');
        const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
        assert.equal((src.match(/getElementById\('disconnectMsg'\)/g) || []).length, 1, 'only renderAlertBanner() may write the banner text');
        assert.ok(body.includes("getElementById('disconnectMsg')"));
        assert.equal((src.match(/getElementById\('disconnectBanner'\)/g) || []).length, 1, 'only renderAlertBanner() may show or hide the banner');
        assert.ok(body.includes("getElementById('disconnectBanner')"));
        // And every writer goes through a planner, never straight to the DOM.
        const showBody = functionBody(src, 'function showAlertBanner');
        const hideBody = functionBody(src, 'function hideAlertBanner');
        const reviseBody = functionBody(src, 'function reviseAlertBanner');
        assert.ok(/planBannerUpdate\(/.test(showBody) && /renderAlertBanner\(\)/.test(showBody));
        assert.ok(/planBannerClear\(/.test(hideBody) && /renderAlertBanner\(\)/.test(hideBody));
        assert.ok(!/canClearBanner|hiddenBannerState\(\)/.test(hideBody), 'hideAlertBanner() withdraws by owner rather than hiding outright');
        assert.ok(/planBannerRevise\(/.test(reviseBody) && /renderAlertBanner\(\)/.test(reviseBody));
        assert.ok(!/planBannerUpdate\(/.test(reviseBody), 'a rewording must never raise a report again');
        const runsBody = functionBody(src, 'function retractMotorsPaused');
        assert.ok(/planBannerPauseEnded\(/.test(runsBody) && /renderAlertBanner\(\)/.test(runsBody));
        assert.ok(!/planBannerUpdate\(|planBannerClear\(/.test(runsBody), 'a session that runs raises nothing and withdraws nothing');
    });

    it('the microphone reports at advisory level and the safety paths at safety level', () => {
        const mic = src.indexOf('function handleMicLost');
        assert.ok(mic >= 0, 'handleMicLost not found');
        const micBody = src.slice(mic, src.indexOf('\nfunction startMicMeterLoop'));
        assert.ok(/severity: 'advisory'/.test(micBody), 'a lost microphone is an advisory, not a safety report');
        const alert = src.indexOf('function triggerDisconnectAlert');
        assert.ok(alert >= 0, 'triggerDisconnectAlert not found');
        assert.ok(/severity: 'safety'/.test(src.slice(alert, alert + 400)), 'every disconnect alert is a safety report');
    });

    it('every report names the source it belongs to, and every source takes its report back', () => {
        // A structural guard beside the behaviour above: the finding it keeps
        // out is a source that raises reports and never withdraws them. Every
        // device report once shared the default 'device' source, which
        // nothing withdrew, so "The Handy disconnected." stood over a Handy
        // connected again and driven, and "may still be moving" over one that
        // had confirmed its stop. A report with no source of its own falls
        // back to that shared default, where its sentence would replace
        // another device's.
        const sources = new Map();
        const note = (source, where) => sources.set(source, where);
        // The source is the last argument, or the one before the options.
        const lastLiteral = (args) => {
            const m = /,\s*'([\w-]+)'(?:,\s*\{[^{}]*\})?$/.exec(args);
            return m ? m[1] : null;
        };
        const reports = callArguments(src, 'triggerDisconnectAlert');
        assert.ok(reports.length >= 10, `only ${reports.length} safety reports found`);
        for (const args of reports) {
            const source = lastLiteral(args);
            assert.ok(source, `a safety report without a source of its own: triggerDisconnectAlert(${args.slice(0, 80)}...)`);
            assert.notEqual(source, 'device', 'the shared default source is withdrawn by nothing');
            note(source, args);
        }
        const voice = callArguments(src, 'announceVoiceNotice');
        assert.ok(voice.length >= 2);
        for (const args of voice) {
            const source = lastLiteral(args);
            assert.ok(source, `a voice notice without a source: ${args}`);
            note(source, args);
        }
        // showAlertBanner takes a literal source, except inside the two
        // helpers above, which pass on the one they were given.
        const forwarders = ['function triggerDisconnectAlert', 'function announceVoiceNotice'];
        const bodyOf = (head) => src.slice(src.indexOf(head), src.indexOf('\n}', src.indexOf(head)));
        const forwarded = forwarders.map(bodyOf).flatMap((body) => callArguments(body, 'showAlertBanner'));
        assert.equal(forwarded.length, 2);
        for (const args of callArguments(src, 'showAlertBanner')) {
            if (forwarded.includes(args)) {
                assert.match(args, /\{ severity: '(safety|advisory)', source(, motorsPaused(: [^{}]+)?)? \}$/);
                continue;
            }
            const m = /source: '([\w-]+)'/.exec(args);
            assert.ok(m, `a report without a source of its own: showAlertBanner(${args.slice(0, 80)}...)`);
            note(m[1], args);
        }
        for (const expected of ['hrSignal', 'hrMonitor', 'handyLink', 'handyStop', 'vacuglideLink', 'vacuglideStop', 'intiface', 'tcode', 'supervision', 'remote', 'mic', 'peerVersion', 'voice', 'voice-choice', 'crashRecovery']) {
            assert.ok(sources.has(expected), `no report found for ${expected}`);
        }
        for (const [source, where] of sources) {
            assert.ok(src.includes(`hideAlertBanner('${source}')`), `the '${source}' report is never withdrawn: ${where.slice(0, 80)}`);
        }
    });

    it('each safety report is withdrawn by the event that ends its cause', () => {
        // Structural, beside what the rules above prove: the page wiring
        // itself runs only in a browser, where these sequences were shown in
        // the real page. Every one of these withdrawals was once missing or
        // unreachable, and the stale report came back into view as soon as
        // whatever was read above it went: "no valid heart-rate reading ...
        // Motors paused for safety" over a session running on a live pulse,
        // "press RESUME" after RESUME, a lost monitor over one paired again.
        const within = (head, close) => functionBody(src, head, close);
        const reading = within('function recordHrReading');
        const invalid = reading.indexOf('return false');
        assert.ok(invalid >= 0, 'recordHrReading no longer turns away a packet that is not a valid reading');
        assert.ok(reading.indexOf("hideAlertBanner('hrSignal')") > invalid, 'a valid reading, and only a valid one, ends the signal-loss report');

        const runs = within('function startOrResumeSession');
        const refused = runs.lastIndexOf('return false;');
        for (const call of ["hideAlertBanner('hrSignal')", "hideAlertBanner('supervision')", 'retractMotorsPaused()', 'settleDrivenHandyStop()']) {
            assert.ok(runs.indexOf(call) > refused, `a session that runs must reach ${call}, and one refused must not`);
        }
        assert.ok(within('function stopSession').includes("hideAlertBanner('supervision')"), 'STOP leaves no paused session to resume');
        assert.ok(within("resetBtn?.addEventListener('click'", '\n});').includes("hideAlertBanner('supervision')"), 'nor does Reset');
        assert.ok(within('function stopSession').includes('retractMotorsPaused()'), 'STOP leaves no session for a report to call paused');
        assert.ok(within("resetBtn?.addEventListener('click'", '\n});').includes('retractMotorsPaused()'), 'nor does Reset');

        const paired = within("document.getElementById('modalBleScanBtn')?.addEventListener('click'", '} catch (e) {');
        assert.ok(paired.includes("hideAlertBanner('hrMonitor')"), 'a monitor paired again ends the report that the last one was lost');
        assert.ok(within("document.getElementById('modalEngageSimBtn')?.addEventListener('click'", '\n});').includes("hideAlertBanner('hrMonitor')"), 'and so does the simulator');
        assert.ok(within("document.getElementById('modalHandyConnectBtn')?.addEventListener('click'", '} catch (e) {').includes("hideAlertBanner('handyLink')"), 'a Handy connected again ends the lost-link report');

        // The Handy's unconfirmed stop, by the key the driver names.
        const handlers = within('setHandyHandlers({', '\n});');
        const unconfirmed = functionBody(handlers, 'onStopUnconfirmed: (message, key) =>', '\n    },');
        assert.ok(unconfirmed.includes('handyStopReport.unconfirmed(key, message)') && unconfirmed.includes('reportOwedHandyStops({ fresh: true })'));
        const confirmed = functionBody(handlers, 'onStopConfirmed: (key) =>', '\n    }');
        assert.ok(confirmed.includes('if (handyStopReport.confirmed(key)) reportOwedHandyStops()'));
        const owed = within('function reportOwedHandyStops');
        assert.ok(owed.includes("hideAlertBanner('handyStop')") && owed.includes("triggerDisconnectAlert(sentence, 'handyStop')") && owed.includes("reviseAlertBanner(sentence, { severity: 'safety', source: 'handyStop' })"));
        assert.ok(within('function settleDrivenHandyStop').includes('handyStopReport.sessionDrives({ connected: handyConnected, key: getHandyKey(), role: state.handyRole })'));
        // A role given while the session runs drives the Handy from there.
        assert.match(within('const applyRole = (role) =>', '\n    };'), /if \(state\.sessionStatus === 'RUNNING' \|\| state\.sessionStatus === 'RAMPDOWN'\) settleDrivenHandyStop\(\);/);

        // The VacuGlide's lost link ends once a VacuGlide is connected again;
        // its unconfirmed stop, by the token the driver names, once a whole
        // stop of that device is confirmed - and no other device's.
        assert.ok(within("document.getElementById('modalVacuglideConnectBtn')?.addEventListener('click'", '} catch (e) {').includes("hideAlertBanner('vacuglideLink')"), 'a VacuGlide connected again ends the lost-link report');
        const vgHandlers = within('setVacuglideHandlers({', '\n});');
        const vgUnconfirmed = functionBody(vgHandlers, 'onStopUnconfirmed: (message, token) =>', '\n    },');
        assert.ok(vgUnconfirmed.includes('vacuglideStopsOwed.set(key,') && vgUnconfirmed.includes('reportOwedVacuglideStops({ fresh: true })'));
        const vgConfirmed = functionBody(vgHandlers, 'onStopConfirmed: (token) =>', '\n    }');
        assert.ok(vgConfirmed.includes("if (vacuglideStopsOwed.delete(typeof token === 'string' ? token : '')) reportOwedVacuglideStops()"));
        const vgOwed = within('function reportOwedVacuglideStops');
        assert.ok(vgOwed.includes("hideAlertBanner('vacuglideStop')") && vgOwed.includes("triggerDisconnectAlert(sentence, 'vacuglideStop')") && vgOwed.includes("reviseAlertBanner(sentence, { severity: 'safety', source: 'vacuglideStop' })"));

        // The report of a session that did not end cleanly: the recovery
        // hands over an empty text once its cause is over - no Handy it names
        // may still be moving and a session has started or resumed since
        // (crash-recovery.js, carryOn) - and that withdraws it. A stop that
        // settled rewords it; news that a Handy may still be moving raises it.
        // It is about the toys a dead page left, and pauses nothing here.
        const crash = within('function showCrashReport');
        const withdrawn = crash.indexOf("hideAlertBanner('crashRecovery')");
        assert.ok(withdrawn >= 0 && withdrawn < crash.indexOf('showAlertBanner('), 'an empty report withdraws it');
        assert.ok(crash.includes("if (fresh) showAlertBanner(text, { severity: 'safety', source: 'crashRecovery' });"));
        assert.ok(crash.includes("else reviseAlertBanner(text, { severity: 'safety', source: 'crashRecovery' });"));
        assert.ok(!crash.includes('triggerDisconnectAlert(') && !crash.includes('pauseSession('), 'it pauses nothing');
        assert.ok(src.includes('onReport: showCrashReport,'), 'the recovery reports through it');
    });

    it('the line a refused START leaves is withdrawn by every event that ends it', () => {
        // The refusal ('handyCheck') is about one press: it is over when a
        // START or RESUME runs, when a later refusal says why in its place,
        // when The Handy is connected again, and at STOP and Reset.
        const within = (head, close) => functionBody(src, head, close);
        assert.ok(within('function withdrawStartRefusal').includes("hideAlertBanner('handyCheck')"));
        const runs = within('function startOrResumeSession');
        assert.ok(runs.indexOf('withdrawStartRefusal()') > runs.lastIndexOf('return false;'), 'a session that runs, and only one that runs');
        const refuse = within('function startOrResumeWhenReady').split('refuse:')[1] || '';
        assert.ok(refuse.includes('withdrawStartRefusal()') && refuse.indexOf('withdrawStartRefusal()') < refuse.indexOf('showAlertBanner('), 'a later refusal takes the place of the last one');
        assert.ok(within('function stopSession').includes('withdrawStartRefusal()'), 'STOP');
        assert.ok(within("resetBtn?.addEventListener('click'", '\n});').includes('withdrawStartRefusal()'), 'Reset');
        assert.ok(within("document.getElementById('modalHandyConnectBtn')?.addEventListener('click'", '} catch (e) {').includes('withdrawStartRefusal()'), 'a Handy connected again');
    });

    it('a report says the motors are paused only in a way the end of the pause can take back', () => {
        // Structural, beside the rules above and the page runs that showed
        // them: a clause written into a report's own words is out of reach
        // of planBannerPauseEnded, and it said "Motors paused for safety."
        // over an Intiface or T-Code device lost, or a Handy lost while
        // reconnecting, while the session ran on the toys that were left,
        // and over an idle page after STOP.
        // Drivers name what happened in text that reaches the banner too, so
        // every module is read, except this one, which owns the clause.
        const modules = ['.', './hardware'].flatMap((dir) => readdirSync(new URL(`${dir}/`, import.meta.url))
            .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js') && name !== 'alert-banner.js')
            .map((name) => `${dir}/${name}`));
        assert.ok(modules.includes('./app.js') && modules.includes('./hardware/intiface.js'));
        for (const file of modules) {
            const code = readFileSync(new URL(file, import.meta.url), 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
            assert.ok(!/paused for safety/i.test(code), `${file}: a message carries the clause itself; report it with { motorsPaused: true } instead`);
        }
        // A report that finds no session says nothing about a pause.
        assert.ok(functionBody(src, 'function triggerDisconnectAlert').includes("motorsPaused: motorsPaused && state.sessionStatus !== 'IDLE'"));
        // Every report that said it still does, while the session is paused.
        const reports = callArguments(src, 'triggerDisconnectAlert');
        const says = (source) => reports.filter((args) => args.includes(`'${source}', { motorsPaused: `));
        for (const source of ['hrSignal', 'hrMonitor', 'intiface', 'tcode']) {
            const all = reports.filter((args) => args.includes(`'${source}'`));
            assert.ok(all.length > 0 && all.every((args) => args.endsWith(`'${source}', { motorsPaused: true }`)), `every '${source}' report says the session was paused`);
        }
        assert.ok(says('handyLink').some((args) => args.startsWith("'The Handy connection was lost while reconnecting.'") && args.endsWith('{ motorsPaused: true }')));
        // A VacuGlide that went offline paused the session: the driver's
        // reason says what happened, and the banner says the pause.
        assert.ok(says('vacuglideLink').some((args) => args.startsWith("reason || 'The VacuGlide went offline.'") && args.endsWith('{ motorsPaused: true }')));
    });
});
