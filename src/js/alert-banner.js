/**
 * What the one alert banner is allowed to show.
 *
 * Every safety report in the app lands in the same `#disconnectBanner`:
 * heart-rate signal loss, a disconnected monitor, an offline Handy, a remote
 * link that died, and the worst of them, "the Handy did not confirm a stop
 * and may still be moving". Microphone advisories land there too. With no
 * rank, whichever fired LAST won and the earlier text was gone without trace,
 * so a microphone taken by another app a second later could erase the only
 * warning that a machine attached to the wearer might still be running.
 *
 * Three rules:
 *  - a lower-priority notice never overwrites a higher-priority one; it is
 *    appended, so neither message is lost;
 *  - a banner is only hidden again by whoever raised it, or by the wearer
 *    dismissing it by hand;
 *  - a notice appended to someone else's report can be taken back by
 *    whoever appended it, and only that sentence goes: the report it was
 *    appended to stays. A START refused because The Handy was offline
 *    appends its refusal to the offline report that the same check raised.
 *    Without this rule the sentence became part of that report's text for
 *    good, since only the report's owner could hide the banner: once the
 *    wearer had connected the device again and pressed START, the motors
 *    ran under "The session was not started: The Handy is offline".
 *
 * Pure: no DOM. app.js holds the current banner state and does the writes.
 *
 * A banner state is { visible, severity, source, text, lines }. `source`
 * owns the banner; `lines` holds every sentence on it with the owner that
 * put it there, the standing report first; `text` is what the wearer reads:
 * the lines joined by mergeBannerMessage.
 */

// Lowest to highest. An 'advisory' is worth telling the wearer about but says
// nothing about a motor; 'safety' reports something that can move, or has
// stopped reporting whether it is moving.
export const BANNER_SEVERITIES = ['none', 'advisory', 'safety'];

// The owner token that clears any banner: the wearer's own Dismiss button.
export const BANNER_OWNER_ANY = '*';

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

// What the banner reads for `lines`: each sentence merged onto the ones
// before it, exactly as they were merged when they arrived.
function joinLines(lines) {
    return lines.reduce((text, line) => mergeBannerMessage(text, line.text), '');
}

function isLine(line) {
    return Boolean(line) && typeof line === 'object'
        && typeof line.source === 'string' && line.source !== ''
        && typeof line.text === 'string';
}

// Who put which sentence on the banner. The list is only trusted while it
// starts with the owner's own report and still adds up to the text the
// wearer reads. Anything else, such as a state built by hand, counts as one
// sentence that belongs to the banner's owner, so nobody but that owner and
// the wearer can take back a word of it.
function normalizeLines(lines, source, text) {
    if (Array.isArray(lines) && lines.length > 0 && lines.every(isLine)
        && lines[0].source === source && joinLines(lines) === text) {
        return lines.map((line) => ({ source: line.source, text: line.text }));
    }
    return text ? [{ source, text }] : [];
}

function normalizeCurrent(current) {
    const c = current && typeof current === 'object' ? current : {};
    const source = typeof c.source === 'string' && c.source ? c.source : 'none';
    const text = typeof c.text === 'string' ? c.text : '';
    return {
        visible: Boolean(c.visible),
        severity: BANNER_SEVERITIES.includes(c.severity) ? c.severity : 'none',
        source,
        text,
        lines: normalizeLines(c.lines, source, text)
    };
}

// The banner state after `incoming` is reported over `current`.
export function planBannerUpdate(current, incoming = {}) {
    const cur = normalizeCurrent(current);
    const inc = incoming && typeof incoming === 'object' ? incoming : {};
    const severity = BANNER_SEVERITIES.includes(inc.severity) && inc.severity !== 'none'
        ? inc.severity
        : 'advisory';
    const source = typeof inc.source === 'string' && inc.source ? inc.source : 'device';
    const text = typeof inc.message === 'string' ? inc.message.trim() : '';
    if (!cur.visible || bannerRank(severity) >= bannerRank(cur.severity)) {
        return { visible: true, severity, source, text, lines: [{ source, text }] };
    }
    // Outranked: the standing report keeps the banner, its severity and its
    // owner, and the new sentence is added to it under its own owner, who
    // can take it back later (see planBannerHide). The wearer reads each
    // sentence once, but a sentence that two owners reported is kept for
    // each of them, so the first one to take it back does not take it from
    // the other. An owner that repeats itself is not recorded twice.
    const known = cur.lines.some((line) => line.source === source && line.text === text);
    return {
        visible: true,
        severity: cur.severity,
        source: cur.source,
        text: mergeBannerMessage(cur.text, text),
        lines: text && !known ? [...cur.lines, { source, text }] : cur.lines
    };
}

// May `owner` hide what the banner is showing right now?
export function canClearBanner(current, owner) {
    if (owner === BANNER_OWNER_ANY) return true;
    const cur = normalizeCurrent(current);
    if (!cur.visible) return true;
    return cur.source === owner;
}

// The banner state after `owner` takes back what it put there. The banner's
// owner, or the wearer (BANNER_OWNER_ANY), hides all of it, as before.
// Anyone else takes back only the sentences they appended: the report those
// were appended to, and every other owner's sentences, stay as they were.
export function planBannerHide(current, owner) {
    if (canClearBanner(current, owner)) return hiddenBannerState();
    const cur = normalizeCurrent(current);
    const kept = cur.lines.filter((line) => line.source !== owner);
    if (kept.length === cur.lines.length) return cur;
    return { ...cur, text: joinLines(kept), lines: kept };
}

export function hiddenBannerState() {
    return { visible: false, severity: 'none', source: 'none', text: '', lines: [] };
}
