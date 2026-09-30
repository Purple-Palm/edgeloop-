/**
 * What the one alert banner is allowed to show.
 *
 * Every safety report in the app lands in the same `#disconnectBanner`:
 * heart-rate signal loss, a disconnected monitor, an offline Handy, a remote
 * link that died, a page the browser stopped running, and the worst of them,
 * "the Handy did not confirm a stop and may still be moving". Advisories
 * land there too: the microphone, the voice, and the notice that the
 * partner's page runs another version. With no rank, whichever fired LAST
 * won and the earlier text was gone without trace, so a microphone taken by
 * another app a second later could erase the only warning that a machine
 * attached to the wearer might still be running.
 *
 * Three rules:
 *  - a lower-priority notice never overwrites a higher-priority one; it is
 *    read after it, so neither message is lost;
 *  - a notice of the same or a higher priority is read first, and the one it
 *    displaces stays on the banner under it. A displaced notice used to be
 *    dropped, and so it left with whatever displaced it: a report of the
 *    same rank took "the Handy may still be moving" away with it when its
 *    own cause ended, and the version notice took "The microphone stopped"
 *    away when the partner reloaded their old page, while the microphone
 *    was still gone;
 *  - every notice stays owned by the source that raised it, and leaves the
 *    banner only when that source withdraws it or the wearer dismisses the
 *    banner by hand. Only that source's sentence goes. A START refused
 *    because The Handy was offline is read under the offline report that
 *    the same check raised; when only a report's owner could take any of
 *    its text down, that refusal outlived its cause: once the wearer had
 *    connected the device again and pressed START, the motors ran under
 *    "The session was not started: The Handy is offline".
 *
 * A source whose report has changed without ending rewords its own sentence
 * where it stands (planBannerRevise), rather than raising it again.
 *
 * A report that tells the wearer the session was paused ends with "Motors
 * paused for safety." (MOTORS_PAUSED), and that clause is over sooner than
 * the rest of the report: the moment the session is no longer paused, because
 * it runs again (RESUME on the toys that are left, START, the watchdog's
 * auto-resume) or because STOP or Reset ended it (planBannerPauseEnded).
 * An Intiface or T-Code device that was lost, or a Handy lost while
 * reconnecting, is still gone while the session runs on the other toys, so
 * its report stays, without the clause. Left in, the clause told the wearer
 * the motors were paused while the Handy stroked, and a report displaced by
 * the watchdog's came back after the auto-resume still saying it.
 *
 * Since nothing else takes a sentence off the banner, every source withdraws
 * its own the moment what it reports is over (app.js): the pulse that came
 * back, the Handy or the monitor connected again, the stop the API did
 * confirm, a session the page supervises again. Left standing, a report
 * whose cause had ended came back into view as soon as the report read above
 * it was withdrawn: "The Handy disconnected." over a Handy that had been
 * connected again and was being driven, "no valid heart-rate reading ...
 * Motors paused for safety" over a session running on a live pulse.
 *
 * Pure: no DOM. app.js holds the current banner state and does the writes.
 *
 * The state: `notices` is every notice standing on the banner, in the order
 * it is read - the highest rank first and, within a rank, the newest first,
 * the way a later report of the same rank has always led the banner. A
 * notice is its source's own words (`text`) and whether it still ends with
 * MOTORS_PAUSED (`motorsPaused`). `severity` and `source` are the first
 * notice's; `text` is what the banner shows, every notice in that order.
 */

// Lowest to highest. An 'advisory' is worth telling the wearer about but says
// nothing about a motor; 'safety' reports something that can move, or has
// stopped reporting whether it is moving.
export const BANNER_SEVERITIES = ['none', 'advisory', 'safety'];

// The owner token that clears any banner: the wearer's own Dismiss button.
export const BANNER_OWNER_ANY = '*';

// What a report that paused the session says about it, after its own words.
// True only while that session stays paused.
export const MOTORS_PAUSED = 'Motors paused for safety.';

export function bannerRank(severity) {
    const i = BANNER_SEVERITIES.indexOf(severity);
    return i < 0 ? 0 : i;
}

// Keep both sentences rather than choosing between them. A repeat of the same
// text is not appended twice (the mic can fire `onmute` then `onended`).
export function mergeBannerMessage(currentText, incomingText) {
    const cur = typeof currentText === 'string' ? currentText.trim() : '';
    const inc = typeof incomingText === 'string' ? incomingText.trim() : '';
    if (!inc) return cur;
    if (!cur) return inc;
    if (cur.includes(inc)) return cur;
    return `${cur} Also: ${inc}`;
}

function normalizeNotice(notice, fallbackSource = 'device') {
    const n = notice && typeof notice === 'object' ? notice : {};
    return {
        severity: BANNER_SEVERITIES.includes(n.severity) && n.severity !== 'none' ? n.severity : 'advisory',
        source: typeof n.source === 'string' && n.source ? n.source : fallbackSource,
        text: typeof n.text === 'string' ? n.text.trim() : '',
        motorsPaused: n.motorsPaused === true
    };
}

// The sentence a notice reads as on the banner.
function noticeText(n) {
    if (!n.motorsPaused) return n.text;
    return n.text ? `${n.text} ${MOTORS_PAUSED}` : MOTORS_PAUSED;
}

// The notices standing on the banner `current` describes; none when it is
// hidden, whatever else it carries.
function standingNotices(current) {
    const c = current && typeof current === 'object' ? current : {};
    if (!c.visible) return [];
    // A state from before the list carried one merged text: that text is the
    // standing report, owned by whoever the state says.
    if (!Array.isArray(c.notices)) return [normalizeNotice({ severity: c.severity, source: c.source, text: c.text }, 'none')];
    return c.notices.map((n) => normalizeNotice(n));
}

// The state that a list of notices renders to. The planners already keep the
// reading order; the sort (stable, so the newest stays first within a rank)
// only makes sure that no list, however it was built, can put an advisory in
// front of a safety report.
function bannerFromNotices(notices) {
    if (notices.length === 0) return hiddenBannerState();
    const ordered = [...notices].sort((a, b) => bannerRank(b.severity) - bannerRank(a.severity));
    return {
        visible: true,
        severity: ordered[0].severity,
        source: ordered[0].source,
        text: ordered.map(noticeText).reduce(mergeBannerMessage, ''),
        notices: ordered
    };
}

// The banner state after `incoming` is reported over `current`.
// `incoming.motorsPaused` is true for a report that tells the wearer the
// session was paused: MOTORS_PAUSED is read after its words until the pause
// ends (planBannerPauseEnded).
export function planBannerUpdate(current, incoming = {}) {
    const standing = standingNotices(current);
    const inc = incoming && typeof incoming === 'object' ? incoming : {};
    const notice = normalizeNotice({ severity: inc.severity, source: inc.source, text: inc.message, motorsPaused: inc.motorsPaused });
    const rank = bannerRank(notice.severity);
    // A source's new report replaces its own earlier sentence rather than
    // doubling it (the refused click says the version notice again, an
    // unconfirmed stop retried is reported again), except a sentence of its
    // own that outranks it: a lower priority never takes down a higher one,
    // not even the same source's. Every other source's notice stays.
    const kept = standing.filter((n) => n.source !== notice.source || bannerRank(n.severity) > rank);
    // Read first among its rank, behind anything of a higher rank.
    const at = kept.findIndex((n) => bannerRank(n.severity) <= rank);
    if (at < 0) return bannerFromNotices([...kept, notice]);
    return bannerFromNotices([...kept.slice(0, at), notice, ...kept.slice(at)]);
}

// The banner state after `incoming.source` rewords the notice it has standing
// at `incoming.severity`: the new words take the old ones' place in the
// reading order. Rewording is not a new report, so a source with nothing
// standing at that rank - never raised, withdrawn, or dismissed by the
// wearer - stays off the banner, and an empty text changes nothing. A report
// whose cause has partly ended (one of two Handys confirmed its stop) says
// what is left, and neither jumps back in front of a newer report nor
// reappears after the wearer dismissed it. Only the words change: whether
// the notice still says the motors are paused is the session's to end
// (planBannerPauseEnded), so a rewording neither drops MOTORS_PAUSED from a
// paused session's report nor puts it back once the pause is over.
export function planBannerRevise(current, incoming = {}) {
    const standing = standingNotices(current);
    const inc = incoming && typeof incoming === 'object' ? incoming : {};
    const notice = normalizeNotice({ severity: inc.severity, source: inc.source, text: inc.message });
    if (!notice.text) return bannerFromNotices(standing);
    return bannerFromNotices(standing.map((n) => (
        n.source === notice.source && n.severity === notice.severity ? { ...notice, motorsPaused: n.motorsPaused } : n
    )));
}

// The banner state once the session is no longer paused - it runs again, or
// it was stopped: no notice goes on saying the motors are paused, and each
// keeps its own words and its place in the reading order, since what they
// report (a device that is gone, a pulse that is not read, a stop that was
// never confirmed) did not end with the pause. A notice that said nothing
// else leaves with the clause.
export function planBannerPauseEnded(current) {
    return bannerFromNotices(standingNotices(current)
        .filter((n) => n.text || !n.motorsPaused)
        .map((n) => ({ ...n, motorsPaused: false })));
}

// The banner state after `owner` withdraws what it raised. The wearer's
// Dismiss (BANNER_OWNER_ANY) clears everything. Any other source takes out
// its own sentences and nothing else, whether or not it leads the banner:
// what stood under a withdrawn report moves up and keeps the banner, since
// the Handy may still be moving when the pulse comes back. A source with
// nothing on the banner changes nothing.
export function planBannerClear(current, owner) {
    if (owner === BANNER_OWNER_ANY) return hiddenBannerState();
    return bannerFromNotices(standingNotices(current).filter((n) => n.source !== owner));
}

// Does `owner` hold the report the banner leads with - the one whose rank it
// shows? Withdrawing it hides the banner only when nothing else stands under
// it; planBannerClear says what is left.
export function canClearBanner(current, owner) {
    if (owner === BANNER_OWNER_ANY) return true;
    const banner = bannerFromNotices(standingNotices(current));
    return !banner.visible || banner.source === owner;
}

export function hiddenBannerState() {
    return { visible: false, severity: 'none', source: 'none', text: '', notices: [] };
}
