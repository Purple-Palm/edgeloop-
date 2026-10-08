import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHandyStopReport, describeOwedStops, HANDY_DRIVEN_ROLES } from './handy-stop-report.js';
import { planBannerUpdate, planBannerClear, planBannerRevise, hiddenBannerState, BANNER_OWNER_ANY, MOTORS_PAUSED } from '../alert-banner.js';

const A = 'KEY-A-0001';
const B = 'KEY-B-0002';
const C = 'KEY-C-0003';
const ERR_503 = 'Stop not confirmed: HTTP 503 (/hamp/stop)';
const ERR_TIMEOUT = 'Stop not confirmed: Request timed out (/hamp/stop)';
const ONE = (message) => `The Handy did not confirm a stop and may still be moving: check the device. (${message})`;
const HANDY_GONE = 'The Handy disconnected.';
const HANDY_OFFLINE = 'The Handy stopped responding (5 failed commands).';
// The watchdog's report as app.js raises it: its words, then the clause that
// the session was paused.
const HR_LOSS = 'Fake Strap HR: no valid heart-rate reading for 9 s (no packets received).';
const HR_ALERT = `${HR_LOSS} ${MOTORS_PAUSED}`;

describe('the stops a Handy still owes', () => {
    it('owes nothing to begin with', () => {
        const report = createHandyStopReport();
        assert.equal(report.count, 0);
        assert.equal(report.sentence(), null);
        assert.equal(report.owes(A), false);
    });

    it('reports an unconfirmed stop in the words the banner has always used', () => {
        const report = createHandyStopReport();
        report.unconfirmed(A, ERR_503);
        assert.equal(report.owes(A), true);
        assert.equal(report.sentence(), ONE(ERR_503));
    });

    it('is settled by a stop the API confirmed for that key, and by nothing for another key', () => {
        const report = createHandyStopReport();
        report.unconfirmed(A, ERR_503);
        // Another device's stop, a key being verified for instance, says
        // nothing about this one.
        assert.equal(report.confirmed(B), false);
        assert.equal(report.sentence(), ONE(ERR_503));
        assert.equal(report.confirmed(A), true);
        assert.equal(report.sentence(), null);
        // A key that owes nothing changes nothing.
        assert.equal(report.confirmed(A), false);
    });

    it('keeps one entry per key, with its newest error', () => {
        const report = createHandyStopReport();
        report.unconfirmed(A, ERR_503);
        report.unconfirmed(A, ERR_TIMEOUT);
        assert.equal(report.count, 1);
        assert.equal(report.sentence(), ONE(ERR_TIMEOUT));
    });

    it('counts two Handys, and names the one left when the other confirms', () => {
        // One key used to be remembered: the second Handy's report replaced
        // the first's, and the second one's confirmed stop then took the
        // banner down while the first had confirmed nothing.
        const report = createHandyStopReport();
        report.unconfirmed(A, ERR_TIMEOUT);
        report.unconfirmed(B, ERR_503);
        assert.equal(report.sentence(), `Two Handys did not confirm a stop and may still be moving: check both devices. (${ERR_503})`);
        assert.equal(report.confirmed(B), true);
        assert.equal(report.sentence(), ONE(ERR_TIMEOUT), 'the first one still owes its stop');
        assert.equal(report.confirmed(A), true);
        assert.equal(report.sentence(), null);
    });

    it('counts three or more in digits, with the newest error', () => {
        const report = createHandyStopReport();
        report.unconfirmed(A, ERR_503);
        report.unconfirmed(B, ERR_503);
        report.unconfirmed(C, ERR_TIMEOUT);
        assert.equal(report.sentence(), `3 Handys did not confirm a stop and may still be moving: check each device. (${ERR_TIMEOUT})`);
        // Reported again, a key becomes the newest.
        report.unconfirmed(A, 'Stop not confirmed: Network error (/hamp/stop)');
        assert.match(report.sentence(), /\(Stop not confirmed: Network error \(\/hamp\/stop\)\)$/);
    });

    it('settles only the Handy connected now and driven by the live session', () => {
        assert.deepEqual(HANDY_DRIVEN_ROLES, ['primary', 'secondary']);
        for (const role of HANDY_DRIVEN_ROLES) {
            const report = createHandyStopReport();
            report.unconfirmed(A, ERR_503);
            assert.equal(report.sessionDrives({ connected: true, key: A, role }), true, role);
            assert.equal(report.sentence(), null, role);
        }
        const report = createHandyStopReport();
        report.unconfirmed(A, ERR_503);
        // On Off it gets no motion, so the session does not account for it.
        assert.equal(report.sessionDrives({ connected: true, key: A, role: 'off' }), false);
        // Not connected, it is not driven at all.
        assert.equal(report.sessionDrives({ connected: false, key: A, role: 'primary' }), false);
        // Another key is another device.
        assert.equal(report.sessionDrives({ connected: true, key: B, role: 'primary' }), false);
        assert.equal(report.sessionDrives(), false);
        assert.equal(report.sentence(), ONE(ERR_503));
    });

    it('takes a key that is not a string as the empty key, and a missing error as no brackets', () => {
        const report = createHandyStopReport();
        report.unconfirmed(undefined, null);
        assert.equal(report.owes(''), true);
        assert.equal(report.sentence(), 'The Handy did not confirm a stop and may still be moving: check the device.');
        assert.equal(report.confirmed(null), true);
        assert.equal(report.sentence(), null);
        assert.equal(describeOwedStops(undefined), null);
        assert.equal(describeOwedStops(new Map()), null);
    });
});

// The banner app.js keeps for these reports (reportOwedHandyStops): a stop
// that was not confirmed raises the sentence, a settled one rewords what is
// left or withdraws it. The other sources stand for the reports raised
// beside it in the same flows.
function bannerFlow() {
    const report = createHandyStopReport();
    let banner = hiddenBannerState();
    const settle = () => {
        const sentence = report.sentence();
        banner = sentence
            ? planBannerRevise(banner, { message: sentence, severity: 'safety', source: 'handyStop' })
            : planBannerClear(banner, 'handyStop');
    };
    return {
        unconfirmed(key, message) {
            report.unconfirmed(key, message);
            banner = planBannerUpdate(banner, { message: report.sentence(), severity: 'safety', source: 'handyStop' });
        },
        confirmed(key) {
            if (report.confirmed(key)) settle();
        },
        sessionDrives(handy) {
            if (report.sessionDrives(handy)) settle();
        },
        raise(message, source, { motorsPaused = false } = {}) {
            banner = planBannerUpdate(banner, { message, severity: 'safety', source, motorsPaused });
        },
        withdraw(source) {
            banner = planBannerClear(banner, source);
        },
        dismiss() {
            banner = planBannerClear(banner, BANNER_OWNER_ANY);
        },
        get text() {
            return banner.visible ? banner.text : '(hidden)';
        }
    };
}

describe('the banner says a Handy may still be moving exactly until it is accounted for', () => {
    it('Reset leaves a stop unconfirmed, then Disconnect has its own stop confirmed', () => {
        const flow = bannerFlow();
        flow.unconfirmed(A, ERR_503);
        assert.equal(flow.text, ONE(ERR_503));
        // Disconnect: the link report goes up at once, and its stop to the
        // same key is confirmed after the driver has dropped that key.
        flow.raise(HANDY_GONE, 'handyLink');
        flow.confirmed(A);
        assert.equal(flow.text, HANDY_GONE);
    });

    it('an offline Handy\'s background stop is confirmed after a Connect failed', () => {
        const flow = bannerFlow();
        flow.raise(HANDY_OFFLINE, 'handyLink');
        flow.unconfirmed(A, ERR_503);
        assert.equal(flow.text, `${ONE(ERR_503)} Also: ${HANDY_OFFLINE}`);
        // The failed Connect reports nothing on the banner (it was offline,
        // not connected); the background stop then goes through.
        flow.confirmed(A);
        assert.equal(flow.text, HANDY_OFFLINE, 'still offline: nothing is connected');
        flow.withdraw('handyLink');
        assert.equal(flow.text, '(hidden)');
    });

    it('a reconnect verifies the new key, then the old device confirms its stop', () => {
        const flow = bannerFlow();
        flow.unconfirmed(A, ERR_503);
        flow.confirmed(B);
        assert.equal(flow.text, ONE(ERR_503), 'the key being verified is another device');
        flow.confirmed(A);
        assert.equal(flow.text, '(hidden)');
        flow.sessionDrives({ connected: true, key: B, role: 'primary' });
        assert.equal(flow.text, '(hidden)');
    });

    it('two Handys owe a stop, and only the one that confirms is taken off', () => {
        const flow = bannerFlow();
        flow.raise(HANDY_GONE, 'handyLink');
        flow.unconfirmed(A, ERR_TIMEOUT);
        // B is connected and the session runs on it: A is still owed.
        flow.withdraw('handyLink');
        flow.sessionDrives({ connected: true, key: B, role: 'primary' });
        assert.equal(flow.text, ONE(ERR_TIMEOUT));
        // A pulse lost and back does not touch it either.
        flow.raise(HR_LOSS, 'hrSignal', { motorsPaused: true });
        flow.withdraw('hrSignal');
        assert.equal(flow.text, ONE(ERR_TIMEOUT));
        flow.unconfirmed(B, ERR_503);
        assert.equal(flow.text, `Two Handys did not confirm a stop and may still be moving: check both devices. (${ERR_503})`);
        flow.confirmed(B);
        assert.equal(flow.text, ONE(ERR_TIMEOUT), 'A never confirmed its stop');
        // A connected again: the stop that verifies it is confirmed.
        flow.confirmed(A);
        assert.equal(flow.text, '(hidden)');
    });

    it('a Handy the session drives again owes no stop, one on Off still does', () => {
        const flow = bannerFlow();
        flow.unconfirmed(A, ERR_503);
        flow.sessionDrives({ connected: true, key: A, role: 'off' });
        assert.equal(flow.text, ONE(ERR_503));
        flow.sessionDrives({ connected: true, key: A, role: 'secondary' });
        assert.equal(flow.text, '(hidden)');
    });

    it('a stop that settles part of a dismissed report does not raise it again; a new failure does', () => {
        const flow = bannerFlow();
        flow.unconfirmed(A, ERR_503);
        flow.unconfirmed(B, ERR_503);
        flow.dismiss();
        flow.confirmed(B);
        assert.equal(flow.text, '(hidden)', 'nothing new happened: the wearer dismissed it');
        flow.unconfirmed(A, ERR_TIMEOUT);
        assert.equal(flow.text, ONE(ERR_TIMEOUT));
    });

    it('the reworded report keeps its place under a newer one', () => {
        const flow = bannerFlow();
        flow.unconfirmed(A, ERR_503);
        flow.unconfirmed(B, ERR_503);
        flow.raise(HR_LOSS, 'hrSignal', { motorsPaused: true });
        flow.confirmed(A);
        assert.equal(flow.text, `${HR_ALERT} Also: ${ONE(ERR_503)}`);
    });
});

describe('a stop owed by a Handy on beat sync (HSP)', () => {
    it('says the device runs out of script, and within how long', () => {
        const report = createHandyStopReport();
        report.unconfirmed(A, 'Stop not confirmed: Request timed out (/hsp/stop)', { runsOutSeconds: 3.4 });
        assert.equal(report.sentence(), 'The Handy did not confirm its stop. It runs out of script within 4 s; check the device. (Stop not confirmed: Request timed out (/hsp/stop))');
        assert.equal(report.confirmed(A), true);
        assert.equal(report.sentence(), null);
    });

    it('a later HAMP report for the same key takes the HAMP words back', () => {
        const report = createHandyStopReport();
        report.unconfirmed(A, 'Stop not confirmed: x', { runsOutSeconds: 2 });
        report.unconfirmed(A, ERR_503);
        assert.equal(report.sentence(), ONE(ERR_503));
    });

    it('counts it with the others and says how soon the one on beat sync runs out', () => {
        const report = createHandyStopReport();
        report.unconfirmed(A, ERR_503);
        report.unconfirmed(B, 'Stop not confirmed: HTTP 502 (/hsp/flush)', { runsOutSeconds: 1.2 });
        assert.equal(report.sentence(), 'Two Handys did not confirm a stop and may still be moving: check both devices. The one on beat sync runs out of script within 2 s. (Stop not confirmed: HTTP 502 (/hsp/flush))');
    });

    it('still reads a map of bare errors, as describeOwedStops always took', () => {
        assert.equal(describeOwedStops(new Map([[A, ERR_503]])), ONE(ERR_503));
    });
});
