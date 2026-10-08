// Pure session rules shared by the cockpit: the effective heart-rate ceiling
// (typed limit minus every safety offset), HR-limit sanitising, duration
// parsing, the Survival climb and its Finished me, Came Early and the learned
// offset, the stall guard, Ruin & Leak's one-ride clock and Force Orgasm's
// time limit. No DOM and no storage, so all of it runs under node:test.

// What this file reads from the engine: the crawl level, so the cockpit
// banner can tell a crawling motor from a running one with the same number
// the engine sends, which modes are games, where the stall guard has
// nothing of its own to cut, the modes in which a cool-down may run, so
// the counter here and the easing there can never disagree about where it
// applies, and the pullback mark, so a dialog quotes the mark the engine
// will pull back at. Ruin & Leak's timings come from the patterns that draw
// its ride and its lockout.
import { CRAWL_PERCENT, GAME_MODES, COOLDOWN_MODES, resolveCeilingBehaviour, resolveEdgeTriggerHr, clampEdgeHoldPercent } from './engine.js';
import { RUIN_RIDE_SECONDS, RUIN_LOCK_SECONDS } from './patterns.js';
// What counts as a usable pulse, and how long two readings may lie apart and
// still be readings of one pulse, are the watchdog's call, here as everywhere.
import { isValidBpm, clampStaleSeconds } from './hr-watchdog.js';

// The effective ceiling can never be pushed closer than this to the resting
// HR, otherwise the tease band collapses into a permanent cut-off.
export const MIN_CEILING_GAP = 15;

// Force Orgasm raises the working ceiling by 1 BPM per second so the edge
// detector stops firing; the raise is capped so an overdrive left running
// cannot drift the ceiling into nonsense territory.
export const ORGASM_BOOST_CAP = 60;

// Survival Mode only ends after this many consecutive READINGS at or above
// the ceiling, so a single HR-sensor spike cannot end the game. The game
// itself no longer ends on this streak. The counter stays so a held reading
// is still one reading.
export const SURVIVAL_BREACH_TICKS = 3;

// Survival climbs for a long session. The time term takes 30 minutes to add
// SURVIVAL_TIME_SPEED, and each counted edge adds a little speed plus one
// BPM of ceiling. Neither one is allowed to finish the run in the first
// few minutes.
export const SURVIVAL_START_FLOOR = 18;
export const SURVIVAL_SLOW_SPAN_SECONDS = 30 * 60;
export const SURVIVAL_TIME_SPEED = 42;
export const SURVIVAL_EDGE_SPEED = 1.25;
export const SURVIVAL_EDGE_BPM = 1;
export const SURVIVAL_OVERDRIVE_CAP = 40;

// How long pulse may sit at the pullback trigger before the primary is cut.
export const MIN_STALL_GUARD_SECONDS = 3;
export const MAX_STALL_GUARD_SECONDS = 120;
export const DEFAULT_STALL_GUARD_SECONDS = 20;

// How long the primary stays halted after that cut, then crawl resumes
// (still edged) and the hold window starts again.
export const MIN_STALL_PAUSE_SECONDS = 2;
export const MAX_STALL_PAUSE_SECONDS = 60;
export const DEFAULT_STALL_PAUSE_SECONDS = 8;

export const DEFAULT_MIN_HR = 70;
export const DEFAULT_MAX_HR = 140;

function toInt(value) {
    if (value === '' || value === null || value === undefined) return null;
    const n = typeof value === 'number' ? value : parseInt(String(value), 10);
    return Number.isFinite(n) ? Math.round(n) : null;
}

function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

// A clock value as whole seconds, never negative. The clocks below are only
// ever written by this file, but a NaN in one would stop it forever.
function wholeSeconds(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

// Parse the two typed HR limits. A field that does not parse falls back to
// the last known-good value for that field (never to a higher default), and
// is reported in `invalid` so the UI can flag it. Ordering is NOT corrected:
// a max below the min is flagged but kept, because the engine treats that as
// "always at ceiling" and stops the motors, which is the safe outcome.
export function sanitizeHrLimits(rawMin, rawMax, lastGood = {}) {
    const fallbackMin = Number.isFinite(lastGood.minHr) ? lastGood.minHr : DEFAULT_MIN_HR;
    const fallbackMax = Number.isFinite(lastGood.maxHr) ? lastGood.maxHr : DEFAULT_MAX_HR;
    const invalid = [];
    let minHr = toInt(rawMin);
    let maxHr = toInt(rawMax);
    if (minHr === null || minHr < 30 || minHr > 250) {
        invalid.push('min');
        minHr = fallbackMin;
    }
    if (maxHr === null || maxHr < 30 || maxHr > 250) {
        invalid.push('max');
        maxHr = fallbackMax;
    }
    if (maxHr <= minHr) {
        if (!invalid.includes('min')) invalid.push('min');
        if (!invalid.includes('max')) invalid.push('max');
    }
    return { minHr, maxHr, valid: invalid.length === 0, invalid };
}

// Compute the ceiling the engine actually uses. Every offset only ever LOWERS
// the typed ceiling (never below min + MIN_CEILING_GAP, and never above the
// typed value). Two explicit raises sit on top: Force Orgasm, and Survival's
// per-edge overdrive while that game is on.
//
// Each reduction is reported twice: what was REQUESTED (the learned offset,
// the dual-stim setting, the decay the edge count has earned) and what was
// APPLIED once the floor had its say. Only the applied amounts may be shown
// to the wearer. The floor swallows a request whenever the Resting HR sits
// close under the Climax HR: with Climax 120, Resting 105 and one Came Early
// press on file, the engine runs on 120, while a panel and a LEARNED badge
// built from the requested 3 BPM told the wearer 117. That is a lower ceiling
// than the one in force - the one direction this app must never err in,
// because the wearer then believes they are held further from climax than
// they are. The two raises are reported as applied too, after their caps,
// and everything adds up: typedMaxHr - appliedLearned - appliedDual -
// appliedDecay + orgasmBoost + survivalOverdrive is maxHr, exactly.
export function computeEffectiveCeiling({
    minHr,
    maxHr,
    learnedOffset = 0,
    dualStimActive = false,
    dualDampening = false,
    dualDampeningBpm = 15,
    adaptiveDecay = false,
    edges = 0,
    decayEdgeCount = 2,
    decayBpm = 2,
    decayFloor = 105,
    orgasmBoost = 0,
    survivalOverdrive = 0
}) {
    const min = Number.isFinite(minHr) ? minHr : DEFAULT_MIN_HR;
    const typedMax = Number.isFinite(maxHr) ? maxHr : DEFAULT_MAX_HR;
    let max = typedMax;
    // The lowest any offset may drag the ceiling. If the user typed a ceiling
    // that is already closer than the gap, the typed value wins (offsets are
    // simply not applied) rather than the floor raising it above what they typed.
    const floorMax = Math.min(typedMax, min + MIN_CEILING_GAP);

    // Take `amount` off the ceiling, never past the floor, and say how much
    // of it really came off.
    const lower = (amount) => {
        if (!(amount > 0)) return 0;
        const next = Math.max(floorMax, max - amount);
        const applied = max - next;
        max = next;
        return applied;
    };

    const requestedLearned = Number.isFinite(learnedOffset) && learnedOffset > 0 ? learnedOffset : 0;
    const appliedLearned = lower(requestedLearned);

    const requestedDual = (dualStimActive && dualDampening)
        ? (Number.isFinite(dualDampeningBpm) && dualDampeningBpm > 0 ? dualDampeningBpm : 15)
        : 0;
    const appliedDual = lower(requestedDual);

    let requestedDecay = 0;
    let appliedDecay = 0;
    let decayFloored = false;
    if (adaptiveDecay && Number.isFinite(edges) && edges > 0) {
        const every = Number.isFinite(decayEdgeCount) && decayEdgeCount > 0 ? decayEdgeCount : 2;
        const perDrop = Number.isFinite(decayBpm) && decayBpm > 0 ? decayBpm : 2;
        requestedDecay = Math.floor(edges / every) * perDrop;
        if (requestedDecay > 0) {
            const floor = Math.max(floorMax, Number.isFinite(decayFloor) ? decayFloor : 105);
            // The floor may STOP the decay but must never raise the ceiling.
            const decayedMax = Math.min(max, Math.max(floor, max - requestedDecay));
            const next = Math.max(floorMax, decayedMax);
            appliedDecay = max - next;
            decayFloored = appliedDecay < requestedDecay;
            max = next;
        }
    }

    // Belt and braces: no offset path may leave the ceiling above the typed one.
    max = Math.min(max, typedMax);

    const requestedOrgasmBoost = Number.isFinite(orgasmBoost) && orgasmBoost > 0 ? orgasmBoost : 0;
    const boost = Math.min(requestedOrgasmBoost, ORGASM_BOOST_CAP);
    // Survival is the other explicit raise. It is session-only, one BPM per
    // edge counted while that game is on, and it drops the moment the game
    // is off. Offsets above still lower the base it climbs from.
    const requestedSurvivalOverdrive = Number.isFinite(survivalOverdrive) && survivalOverdrive > 0 ? survivalOverdrive : 0;
    const overdrive = Math.min(requestedSurvivalOverdrive, SURVIVAL_OVERDRIVE_CAP);
    max += boost + overdrive;

    return {
        minHr: min,
        maxHr: max,
        typedMaxHr: typedMax,
        // The lowest the offsets may take the ceiling (min + MIN_CEILING_GAP,
        // or the typed ceiling itself when that is closer).
        offsetFloorHr: floorMax,
        requestedLearned,
        appliedLearned,
        requestedDual,
        appliedDual,
        requestedDecay,
        appliedDecay,
        decayFloored,
        // The raises as asked for and, under their own names, as applied
        // after their caps.
        requestedOrgasmBoost,
        orgasmBoost: boost,
        requestedSurvivalOverdrive,
        survivalOverdrive: overdrive
    };
}

// Everything the working ceiling is computed from, as one object: the engine
// hands it to computeEffectiveCeiling, and the Came Early, Wipe Memory and
// Finished me dialogs work their numbers out from the same object, so no
// dialog can quote a ceiling from other inputs than the motors run on.
// Survival switches two of them itself. Adaptive decay lowers the ceiling as
// edges pile up, and Survival is climbing past the typed max on those same
// edges, so decay does not run during the game; and the game's overdrive
// only counts while it is the active mode - it drops the moment the game is
// off. Force Orgasm's boost only counts while Force Orgasm is on.
export function workingCeilingInputs({
    minHr,
    maxHr,
    activeMode,
    settings = {},
    dualStimActive = false,
    edges = 0,
    orgasmMode = false,
    orgasmBoost = 0,
    survivalOverdrive = 0
} = {}) {
    const survival = activeMode === 'survival';
    const s = settings && typeof settings === 'object' ? settings : {};
    return {
        minHr,
        maxHr,
        learnedOffset: s.learningProfile?.suggestedMaxHrOffset || 0,
        dualStimActive: Boolean(dualStimActive),
        dualDampening: Boolean(s.dualDampening),
        dualDampeningBpm: s.dualDampeningBpm,
        adaptiveDecay: survival ? false : Boolean(s.adaptiveDecay),
        edges,
        decayEdgeCount: s.decayEdgeCount,
        decayBpm: s.decayBpm,
        decayFloor: s.decayFloor,
        orgasmBoost: orgasmMode ? orgasmBoost : 0,
        survivalOverdrive: survival ? survivalOverdrive : 0
    };
}

// ---- Came Early and the learned offset --------------------------------------
//
// Each Came Early press adds to the learned offset, which comes off the typed
// Climax HR on every session until the wearer wipes it. Everything the button
// and the Session Setup line say about it is worked out here from
// computeEffectiveCeiling, with the inputs the engine runs on, so no surface
// can quote a ceiling the motors are not obeying.

// The most all the presses together may take off. settings-schema.js clamps a
// stored or imported profile to the same number.
export const MAX_LEARNED_OFFSET_BPM = 30;

// One press adds CAME_EARLY_STEP_BPM. A climax whose pulse peaked more than
// CAME_EARLY_BONUS_MARGIN_BPM under the typed Climax HR adds
// CAME_EARLY_BONUS_BPM on top: the typed number is then far above where this
// wearer really tips over, so one press closes more of the gap.
export const CAME_EARLY_STEP_BPM = 3;
export const CAME_EARLY_BONUS_BPM = 2;
export const CAME_EARLY_BONUS_MARGIN_BPM = 8;

// How far back from the press the climax is looked for.
//
// The press comes after the climax, and by then the pulse is already falling:
// heart rate rises most during the 10-15 s of orgasm and returns rapidly
// towards baseline afterwards (the American Heart Association's scientific
// statement on sexual activity, Levine et al., Circulation 2012). The step
// used to be judged on the pulse at the moment of the press, which reads that
// fall as a climax far under the ceiling - and with no monitor connected it
// read the 70 BPM the app starts with, so the larger step fired on no data at
// all. The PEAK of the last minute is the climax itself for a wearer who
// presses within a minute of it, and this is the button that stops the toys,
// so it is pressed at once. A minute is short against a session, so the
// peak is the climax rather than an edge from several minutes before; if an
// edge inside that minute did run higher, the wearer sat at that pulse without
// tipping over, which says the typed Climax HR is not far off, and the smaller
// step is the right one then.
//
// Every valid reading the pulse source delivers counts, a session running or
// not. A wearer who hits STOP at the point of no return and tips over anyway
// climaxes with nothing running, and the pulse the cockpit showed in that
// minute IS the climax this button is about: counting only the readings up to
// STOP quoted a pre-climax pulse to that wearer as their peak, took the larger
// step on it and recorded it as the event. A press made more than a minute
// after the climax sees only the fall from it, and a pulse falling from the
// climax can only turn the ordinary step into the larger one - the one that
// holds the wearer further from climax - never the reverse; the dialog names
// the peak it judged on. With no valid reading in the window - no monitor, or
// the signal lost for the whole minute - there is nothing to judge by, and
// the ordinary step is taken.
export const CAME_EARLY_PEAK_WINDOW_MS = 60 * 1000;

// A strap sends about one reading a second. The cap only bounds memory for a
// clock that steps backwards, which stops the age trim from dropping anything.
const MAX_RECENT_READINGS = 1000;

// Add one reading to the short record of recent readings, and drop what the
// window can no longer reach, so the record holds about a minute of readings
// however long the monitor has been on. An unusable reading is not recorded.
// Returns the same array.
export function rememberReading(readings, at, bpm, windowMs = CAME_EARLY_PEAK_WINDOW_MS) {
    if (!Array.isArray(readings)) return [];
    if (!Number.isFinite(at) || !isValidBpm(bpm)) return readings;
    readings.push({ at, bpm });
    const cutoff = at - windowMs;
    let stale = 0;
    while (stale < readings.length && !(readings[stale].at >= cutoff)) stale += 1;
    if (stale > 0) readings.splice(0, stale);
    if (readings.length > MAX_RECENT_READINGS) readings.splice(0, readings.length - MAX_RECENT_READINGS);
    return readings;
}

// The highest valid reading in the window that ends at `now`, or null when
// there is none: no monitor, a signal lost for the whole window, or nothing
// but unusable values. A reading stamped after `now` does not count either:
// a clock that stepped backwards is not a pulse.
export function recentPeakHr(readings, now, windowMs = CAME_EARLY_PEAK_WINDOW_MS) {
    if (!Array.isArray(readings) || !Number.isFinite(now)) return null;
    const since = now - windowMs;
    let peak = null;
    for (const reading of readings) {
        if (!reading || !Number.isFinite(reading.at) || reading.at < since || reading.at > now) continue;
        if (!isValidBpm(reading.bpm)) continue;
        if (peak === null || reading.bpm > peak) peak = reading.bpm;
    }
    return peak;
}

// What one Came Early press does to the learned offset. The larger step is
// only ever taken on a measured pulse: `peakHr` has to be a valid reading
// (recentPeakHr gives null when there is none), so a session with no monitor,
// or with no reading in the window, gets the ordinary step - never the bonus.
// A press never lowers the stored offset, so it can never raise the ceiling.
export function cameEarlyStep({ offset, typedMaxHr, peakHr } = {}) {
    const previous = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const peak = isValidBpm(peakHr) ? peakHr : null;
    const bonus = peak !== null && Number.isFinite(typedMaxHr)
        && peak < typedMaxHr - CAME_EARLY_BONUS_MARGIN_BPM;
    const step = CAME_EARLY_STEP_BPM + (bonus ? CAME_EARLY_BONUS_BPM : 0);
    const next = Math.max(previous, Math.min(MAX_LEARNED_OFFSET_BPM, previous + step));
    return { previous, offset: next, step, added: next - previous, bonus, peakHr: peak };
}

// The two working ceilings a learned offset gives, both from
// computeEffectiveCeiling with the inputs the engine runs on (`inputs` is the
// very object handed to it). `learned` is what the offset alone leaves of the
// typed Climax HR on every session - the number the Session Setup line and
// the LEARNED badge describe. `start` is where a session begins with the toys
// connected right now, so dual-stim dampening is in it. Adaptive decay, the
// Force Orgasm boost and Survival's overdrive are left out of both: every
// session starts them at zero, and the press that asks has ended the one that
// was running.
export function learnedOffsetCeilings(inputs = {}, learnedOffset = inputs.learnedOffset) {
    return {
        learned: computeEffectiveCeiling({ minHr: inputs.minHr, maxHr: inputs.maxHr, learnedOffset }),
        start: computeEffectiveCeiling({ ...inputs, learnedOffset, edges: 0, orgasmBoost: 0, survivalOverdrive: 0 })
    };
}

// Why a learned offset did not come off in full.
function describeGapFloor(minHr) {
    return `no offset may take the ceiling closer than ${MIN_CEILING_GAP} BPM to your Resting HR (${minHr})`;
}

// The start-of-session ceiling, said only where dual-stim dampening makes it
// differ from the learned one, so the dialog never contradicts the cockpit.
function describeStartCeiling(before, after) {
    const from = before.start.maxHr;
    const to = after.start.maxHr;
    if (from === before.learned.maxHr && to === after.learned.maxHr) return '';
    return to === from
        ? ` With your toys connected as they are now, dual-stimulation dampening holds a session at ${from} BPM either way.`
        : ` With your toys connected as they are now, dual-stimulation dampening takes it lower still: a session starts at ${to} BPM instead of ${from}.`;
}

// What a Came Early or Finished me dialog says about the toys behind it, the
// `what` ('session' or 'run') being paused or not. `handyAtRest` is false for
// a question asked although the Handy has not confirmed its stop - the
// wearer was told so and pressed again (stopThenAsk) - and that question
// never says the toys are stopped: it says what to do if the Handy is still
// moving.
function describeToysBehindQuestion({ paused, handyAtRest, what }) {
    if (handyAtRest) return paused ? `The toys are stopped and the ${what} is paused.` : 'The toys are stopped.';
    const doubt = 'has not confirmed its stop: if it is still moving, switch it off.';
    return paused ? `The ${what} is paused, but the Handy ${doubt}` : `The Handy ${doubt}`;
}

// The Came Early confirmation. It used to say only that the ceiling would be
// lowered, so a wearer who believed each press took 5 BPM off - or feared
// what else it might do - did not press it. It now states the working ceiling
// before and after, the size of the step and why, and says so when the floor
// or the cap means the press changes nothing: "goes from 120 to 117" over an
// engine that stays on 120 would be the lie the whole ceiling report exists
// to prevent. `before` / `after` are learnedOffsetCeilings for the current and
// the next offset; `step` is cameEarlyStep's answer. `paused` says a session
// is paused behind the question - the press pauses one that is driving the
// toys before it asks anything - and only OK ends it. Cancel then leaves no
// trace: nothing learned, nothing in History, and RESUME carries on. The
// press used to end the session before it asked, so Cancel undid nothing -
// a mis-tap lost the session and still put "Premature Release" in History,
// under a dialog that said "Cancel logs nothing". `handyAtRest` is false when
// the question is asked over a Handy that has not confirmed its stop
// (describeToysBehindQuestion). `peakFromFirstPress`: the press answers one
// the Handy turned away, and the step was judged on the minute before that
// first press, so the dialog names that minute rather than the last one.
export function describeCameEarlyConfirm({ before, after, step, paused = false, handyAtRest = true, peakFromFirstPress = false } = {}) {
    const minute = peakFromFirstPress ? 'the minute before your first press' : 'the last minute';
    const typed = before.learned.typedMaxHr;
    const from = before.learned.maxHr;
    const to = after.learned.maxHr;
    const drop = Math.max(0, from - to);
    let ceiling;
    if (drop > 0) {
        ceiling = `Your working climax ceiling goes from ${from} to ${to} BPM on every session from now on. Your typed Climax HR stays ${typed}.`;
    } else if (from === typed) {
        ceiling = `Your working climax ceiling stays at your typed Climax HR, ${typed} BPM.`;
    } else {
        ceiling = `Your working climax ceiling stays at ${from} BPM (your typed Climax HR is ${typed}).`;
    }
    ceiling += describeStartCeiling(before, after);

    let stepText;
    if (step.added <= 0) {
        stepText = `Your learned offset is already at its ${MAX_LEARNED_OFFSET_BPM} BPM maximum, so this press adds nothing to it; the event is still logged.`;
    } else {
        const larger = CAME_EARLY_STEP_BPM + CAME_EARLY_BONUS_BPM;
        stepText = `This press adds ${step.added} BPM to the learned offset`;
        stepText += step.added < step.step ? `, which takes it to its ${MAX_LEARNED_OFFSET_BPM} BPM maximum.` : '.';
        if (step.peakHr === null) {
            stepText += ` There is no heart-rate reading from ${minute} (no monitor, or the signal was lost), so the larger ${larger} BPM step for a climax well under your Climax HR does not apply.`;
        } else if (step.bonus) {
            stepText += ` That is the larger step: your pulse peaked at only ${step.peakHr} BPM in ${minute}, more than ${CAME_EARLY_BONUS_MARGIN_BPM} BPM under your Climax HR.`;
        } else {
            stepText += ` The larger ${larger} BPM step is for a pulse that peaks more than ${CAME_EARLY_BONUS_MARGIN_BPM} BPM under your Climax HR; yours peaked at ${step.peakHr} BPM in ${minute}.`;
        }
        if (drop < step.added) {
            stepText += drop === 0
                ? ` None of it lowers the ceiling: ${describeGapFloor(before.learned.minHr)}.`
                : ` Only ${drop} BPM of it lowers the ceiling: ${describeGapFloor(before.learned.minHr)}.`;
        }
    }

    // Over toys at rest with no session behind it, there is nothing to say
    // about them; a Handy in doubt is said every time.
    const toys = paused || !handyAtRest ? `${describeToysBehindQuestion({ paused, handyAtRest, what: 'session' })} ` : '';
    const closing = paused
        ? `${toys}OK logs the release and ends the session; Cancel logs nothing and leaves it paused, so RESUME carries on. Wipe Memory in Session Setup (Backup) clears the learned offset.`
        : `${toys}Cancel logs nothing. Wipe Memory in Session Setup (Backup) clears the learned offset.`;
    return ['Log an accidental release?', ceiling, stepText, closing].join('\n\n');
}

// The phrase bank the cockpit speaks and paints once the press is confirmed
// (voice-cues.js), and the values its tokens take. It used to be the one
// 'cameEarly' bank whatever the press did, and its lines promise a tighter
// limit ("Limit tightened", "Ceiling drops next time"): with the Resting HR
// floor or the 30 BPM cap swallowing the press, the wearer heard that over a
// ceiling that had not moved, seconds after a dialog that said it stays where
// it is. So 'cameEarly' is now only for a press that lowers the ceiling the
// next session starts at with the toys connected now - the CEILING the
// cockpit shows once the session has stopped, and the drop the dialog
// promises. Any other press is announced from 'cameEarlyHeld', which says
// only that the event is logged and the ceiling stays where it was - never
// that it is as low as it goes, which at the 30 BPM cap it need not be
// anywhere near: Resting 60 and Climax 160 with the offset capped give a
// ceiling of 130 over a floor of 75, and a second toy or a lower typed
// Climax HR still takes it lower. That includes a press that lowers the
// learned ceiling while dual-stim dampening holds the session at the Resting
// HR floor either way, which the dialog says in as many words: "the next
// session is meaner" would be untrue with these toys, and a limit that did
// move while the wearer is told it held errs towards keeping them further
// from climax, never closer. {hr} is the peak the step was judged on, or
// nothing when there was no reading, and then no line built on it is chosen
// (voice-cues.sayableCueLines); it used to be the cockpit's pulse, which is
// the 70 BPM the app starts with when no monitor is connected. {maxHr} is
// that start-of-session ceiling, with no decay, no Force Orgasm boost and no
// Survival climb: the running session's own, which the press ends, is not
// the next one's.
export function cameEarlyCue({ before, after, step } = {}) {
    const lowered = after.start.maxHr < before.start.maxHr;
    return {
        cue: lowered ? 'cameEarly' : 'cameEarlyHeld',
        vars: { hr: step.peakHr, maxHr: after.start.maxHr }
    };
}

// The Wipe Memory confirmation, from the same two ceilings. "Your typed Climax
// HR will be used with no offset" was not true while dual-stim dampening or
// decay were lowering it, and said nothing about what actually moves.
export function describeWipeLearningConfirm({ before, after } = {}) {
    const from = before.learned.maxHr;
    const to = after.learned.maxHr;
    let text = 'Reset local bio-learning memory?';
    if (!(before.learned.requestedLearned > 0)) {
        text += ` There is no learned offset, so your working climax ceiling stays at ${from} BPM, your typed Climax HR.`;
    } else if (to > from) {
        text += ` Your working climax ceiling goes back up from ${from} to ${to} BPM, your typed Climax HR, on every session from now on.`;
    } else {
        text += ` Your working climax ceiling stays at ${from} BPM: the learned offset is not lowering it right now, because ${describeGapFloor(before.learned.minHr)}.`;
    }
    return text + describeStartCeiling(before, after);
}

// The learning line in Session Setup, from the ceiling the engine ran on. It
// says what the learned offset itself does - it is applied first, so that
// does not depend on the toys or on decay, which the cockpit badges report on
// top of it. It used to be built from the stored offset: "Working climax
// ceiling is 3 BPM below your typed Climax HR" was printed over an engine
// running on the typed number itself whenever the Resting HR sat within 15
// BPM of the lowered ceiling - and "Typed Climax HR is used as-is" over an
// engine applying an offset restored without an event count, or taking
// dual-stim dampening off it.
export function describeLearningStatus({ profile, ceiling } = {}) {
    const events = Number.isFinite(profile?.breakthroughEvents) ? Math.max(0, profile.breakthroughEvents) : 0;
    const lastHr = profile?.lastBreakthroughHr;
    const last = Number.isFinite(lastHr) && lastHr > 0 ? ` Last event at ${lastHr} BPM.` : '';
    const requested = ceiling.requestedLearned;
    const applied = ceiling.appliedLearned;
    const typed = ceiling.typedMaxHr;
    if (!(requested > 0)) {
        return {
            active: false,
            text: events > 0
                ? `${events} premature event(s) recorded, but no learned offset is taken off your typed Climax HR.${last}`
                : 'Zero breakthrough events recorded. No learned offset is taken off your typed Climax HR.'
        };
    }
    if (applied >= requested) {
        return {
            active: true,
            text: `Active: ${events} premature event(s). The learned offset takes ${applied} BPM off your typed Climax HR on every session: ${typed - applied} instead of ${typed} BPM.${last}`
        };
    }
    if (applied > 0) {
        return {
            active: true,
            text: `Active: ${events} premature event(s). Learned offset ${requested} BPM, but it takes only ${applied} BPM off your typed Climax HR, because ${describeGapFloor(ceiling.minHr)}: ${typed - applied} instead of ${typed} BPM.${last}`
        };
    }
    return {
        active: true,
        text: `Learned offset ${requested} BPM from ${events} premature event(s), but it takes nothing off your typed Climax HR of ${typed} BPM, because ${describeGapFloor(ceiling.minHr)}.${last}`
    };
}

// Parse the Session Setup duration fields. Anything that is not a positive
// finite integer, or a window whose min exceeds its max, is reported in
// `invalid` (field names 'fixed', 'min', 'max') and the session falls back to
// endless (targetSeconds 0) so the caller can flag the field instead of
// silently running forever.
function emptyDuration(invalid = []) {
    return {
        targetSeconds: 0,
        minSeconds: 0,
        maxSeconds: 0,
        fixedLength: false,
        valid: invalid.length === 0,
        invalid
    };
}

// A "Fixed" session longer than a day is the Endless mode with extra steps.
// A length outside the window is REFUSED here rather than clamped, so both
// a typed one and a stored one fall back to the factory length - the same
// answer, whichever way the number arrived.
export const MAX_SESSION_MINUTES = 1440;

export function parseSessionDuration({ mode, fixedMinutes, minMinutes, maxMinutes, random = Math.random }) {
    if (mode === 'endless') return emptyDuration();

    const toMinutes = (value) => {
        const n = toInt(value);
        return n !== null && n > 0 && n <= MAX_SESSION_MINUTES ? n : null;
    };

    if (mode === 'fixed') {
        const mins = toMinutes(fixedMinutes);
        if (mins === null) return { ...emptyDuration(['fixed']), valid: false };
        const seconds = mins * 60;
        // `fixedLength` is the ONLY thing that tells a Fixed length from a
        // Mystery window the wearer typed with the same number in both boxes:
        // both hand out min === max === target, and the Oracle treats the two
        // completely differently (see oracleTiming).
        return {
            targetSeconds: seconds,
            minSeconds: seconds,
            maxSeconds: seconds,
            fixedLength: true,
            valid: true,
            invalid: []
        };
    }

    const lo = toMinutes(minMinutes);
    const hi = toMinutes(maxMinutes);
    const invalid = [];
    if (lo === null) invalid.push('min');
    if (hi === null) invalid.push('max');
    if (lo !== null && hi !== null && lo > hi) invalid.push('min', 'max');
    if (invalid.length > 0) return { ...emptyDuration(invalid), valid: false };

    const roll = clamp(Number(random()) || 0, 0, 0.999999);
    const mins = Math.min(hi, Math.floor(roll * (hi - lo + 1)) + lo);
    return {
        targetSeconds: mins * 60,
        minSeconds: lo * 60,
        maxSeconds: hi * 60,
        fixedLength: false,
        valid: true,
        invalid: []
    };
}

// Share of a collapsed duration window (min === target) the Oracle waits
// before climax and denial unlock.
export const ORACLE_MIN_WINDOW_SHARE = 0.5;

// When the Oracle may climax or deny. Endless (all zeros) has no clock, so
// any hold may end the session. Mystery/Fixed keep climax and denial closed
// until minSeconds, then open them through the window; past maxSeconds the
// next hold must end (no more purgatory).
export function oracleTiming({
    sessionSeconds = 0,
    minSeconds = 0,
    maxSeconds = 0,
    targetSeconds = 0,
    fixedLength = false
} = {}) {
    const t = Math.max(0, Number(sessionSeconds) || 0);
    const min = Math.max(0, Number(minSeconds) || 0);
    const max = Math.max(0, Number(maxSeconds) || 0);
    const target = Math.max(0, Number(targetSeconds) || 0);
    const closeAt = target > 0 ? target : max;
    // A FIXED length leaves a window of zero width (min === max === target):
    // every hold to the final second would be purgatory and the Oracle would
    // never choose at all. That session opens the window halfway instead, so
    // the ramp still runs and the length the wearer typed stays the latest
    // the Oracle will wait - which is what the UI promises for Fixed.
    //
    // A Mystery window is NOT collapsed, even when the hidden roll happens to
    // land on its own minimum. The wearer typed that minimum to mean "do not
    // finish me before then", and halving it because of a roll they cannot
    // see would unlock climax and denial at half the time they asked for.
    // Such a session simply has canEnd false until the minimum and mustEnd
    // true at it.
    //
    // A Mystery typed with the same number in both boxes (30-30) hands out
    // exactly the numbers a Fixed length does, so the numbers alone cannot
    // tell them apart: 30-30 was read as Fixed and unlocked climax - which
    // arms Force Orgasm - and denial at 15 minutes, half the minimum that was
    // typed. The caller says which kind it is, and the default is the Mystery
    // rule, because that is the one that waits.
    const fixedWindow = Boolean(fixedLength) && min >= closeAt && min >= max;
    const openAt = closeAt > 0 && fixedWindow
        ? Math.floor(closeAt * ORACLE_MIN_WINDOW_SHARE)
        : min;
    const endless = openAt === 0 && closeAt === 0;
    if (endless) {
        return { canEnd: true, mustEnd: false, openAt: 0, closeAt: 0, progress: 1 };
    }
    const span = Math.max(1, closeAt - openAt);
    const progress = clamp((t - openAt) / span, 0, 1);
    return {
        canEnd: t >= openAt,
        mustEnd: closeAt > 0 && t >= closeAt,
        openAt,
        closeAt,
        progress
    };
}

export function rollOracleFate(timing, { random = Math.random, endgameType = 'orgasm' } = {}) {
    const gate = timing && typeof timing === 'object'
        ? timing
        : { canEnd: true, mustEnd: false, progress: 1 };
    if (!gate.canEnd) return 'PURGATORY';
    const roll = clamp(Number(random()) || 0, 0, 0.999999);
    if (gate.mustEnd) {
        // The forced ending is the one the wearer picked in Endgame Trigger.
        // Soft Landing is a tease-down: it must never fall through to a coin
        // flip that arms Force Orgasm on their behalf.
        if (endgameType === 'denial') return 'DENIAL';
        if (endgameType === 'orgasm') return 'CLIMAX';
        if (endgameType === 'rampdown') return 'RAMPDOWN';
        return roll < 0.5 ? 'CLIMAX' : 'DENIAL';
    }
    // Early in the window most holds continue; near the close, climax and
    // denial take most of the rolls. Equal split between those two.
    const p = clamp(Number(gate.progress) || 0, 0, 1);
    const purgP = 0.72 * (1 - p) + 0.18 * p;
    if (roll < purgP) return 'PURGATORY';
    const mid = purgP + (1 - purgP) / 2;
    return roll < mid ? 'CLIMAX' : 'DENIAL';
}

// Survival breach counter: consecutive readings at or above the ceiling. A
// reading below the ceiling resets the streak. A tick that saw no new
// reading (a watch or relay app holding its last value for 2-5 s) leaves
// the streak as it is: one spike must never be counted several times.
export function countSurvivalBreach(previousTicks, hr, ceiling, newReading = true) {
    if (!Number.isFinite(hr) || !Number.isFinite(ceiling)) return 0;
    if (!newReading) return previousTicks || 0;
    return hr >= ceiling ? (previousTicks || 0) + 1 : 0;
}

export function clampStallGuardSeconds(value, fallback = DEFAULT_STALL_GUARD_SECONDS) {
    const n = toInt(value);
    if (n === null) return fallback;
    return clamp(n, MIN_STALL_GUARD_SECONDS, MAX_STALL_GUARD_SECONDS);
}

export function clampStallPauseSeconds(value, fallback = DEFAULT_STALL_PAUSE_SECONDS) {
    const n = toInt(value);
    if (n === null) return fallback;
    return clamp(n, MIN_STALL_PAUSE_SECONDS, MAX_STALL_PAUSE_SECONDS);
}

// One 1 s tick of the stall guard.
// holdTimeoutSeconds: how long you may stay edged before the primary is cut.
// pauseTimeoutSeconds: how long that halt lasts, then crawl resumes and the
// hold window starts over. Disarm or leaving the edge clears both clocks.
export function tickStallGuard(
    { holdSeconds = 0, pauseSeconds = 0, engaged = false, seconds } = {},
    { armed = false, isEdged = false, holdTimeoutSeconds, pauseTimeoutSeconds, timeoutSeconds } = {}
) {
    const hold = Number.isFinite(holdSeconds) ? holdSeconds : (Number.isFinite(seconds) ? seconds : 0);
    const pause = Number.isFinite(pauseSeconds) ? pauseSeconds : 0;
    if (!armed || !isEdged) {
        return {
            holdSeconds: 0,
            pauseSeconds: 0,
            seconds: 0,
            engaged: false,
            justEngaged: false,
            justReleased: Boolean(engaged),
            justResumed: false
        };
    }
    const holdLimit = clampStallGuardSeconds(holdTimeoutSeconds ?? timeoutSeconds);
    const pauseLimit = clampStallPauseSeconds(pauseTimeoutSeconds);

    if (engaged) {
        const nextPause = pause + 1;
        if (nextPause >= pauseLimit) {
            return {
                holdSeconds: 0,
                pauseSeconds: 0,
                seconds: 0,
                engaged: false,
                justEngaged: false,
                justReleased: false,
                justResumed: true
            };
        }
        return {
            holdSeconds: hold,
            pauseSeconds: nextPause,
            seconds: hold,
            engaged: true,
            justEngaged: false,
            justReleased: false,
            justResumed: false
        };
    }

    const nextHold = hold + 1;
    const engagedNow = nextHold >= holdLimit;
    return {
        holdSeconds: nextHold,
        pauseSeconds: 0,
        seconds: nextHold,
        engaged: engagedNow,
        justEngaged: engagedNow,
        justReleased: false,
        justResumed: false
    };
}

// How many more 1 s ticks the current stall pause lasts before tickStallGuard
// hands the primary back; 0 when the guard is not engaged. A pause that has
// already run past a limit the wearer has just lowered ends on the very next
// tick, so an engaged guard always has at least one second left.
export function stallPauseSecondsLeft({ pauseSeconds = 0, engaged = false } = {}, { pauseTimeoutSeconds } = {}) {
    if (!engaged) return 0;
    return Math.max(1, clampStallPauseSeconds(pauseTimeoutSeconds) - wholeSeconds(pauseSeconds));
}

// ---- Ruin & Leak: one ride per edge ----------------------------------------

// Ruin & Leak keeps stroking through the edge for RUIN_RIDE_SECONDS, then
// stops dead for RUIN_LOCK_SECONDS with the secondary dropped low, so the
// wearer can leak without a full orgasm. That is ONE ride per edge. 1.1.0
// and 1.1.2 start the ride again the moment the lockout runs out, so a pulse
// that simply stays on the mark - which is what a pulse does in the minute
// after a ruined orgasm - gets 12 s at up to 74% (100% at full intensity)
// out of every 30, for as long as it stays there; since 1.1.1 each of those
// rides is a steady 59-74%. Before 1.1.0 the mode sent 0% whenever the
// wearer was edged.
//
// So the ride belongs to the edge. Once this edge has had it (`spent`), the
// primary stays at 0% after the lockout until the edge RELEASES - the pulse
// falls below the release point the engine already uses, which is exactly
// when the engine's own edge flag clears - and only then may a new edge ride.
// It is session state, not mode state: re-selecting Ruin, switching to
// another mode and back, a game toggle or a partner's MODE_CHANGE all used to
// zero it, so one tap during the lockout cancelled the dead stop and started
// a fresh ride. Only a release re-arms the ride (a lockout already running
// still runs out), and only STOP, Reset or a new session clears the clock.
//
// One 1 s tick of a RUNNING session. `active`: Ruin & Leak is the active
// mode (a game only borrows Ruin's stroke, so the ride clock does not run
// under one). `isEdged`: the engine's edge flag this second.
export function tickRuin(
    { rideSeconds = 0, lockSeconds = 0, spent = false } = {},
    { active = false, isEdged = false } = {}
) {
    let ride = Math.min(RUIN_RIDE_SECONDS, wholeSeconds(rideSeconds));
    const lock = Math.min(RUIN_LOCK_SECONDS, wholeSeconds(lockSeconds));
    let used = Boolean(spent);
    // A release re-arms the ride for the NEXT edge. It does not shorten a
    // lockout that is already running: those 18 s of dead stop are the ruin
    // itself, and a pulse that dips during them has not earned the stroker
    // back early.
    if (!isEdged) {
        ride = 0;
        used = false;
    }
    // The lockout runs down in every mode, so a wearer who leaves Ruin for a
    // minute does not come back to 18 s of dead stop they had already served.
    // Whether the primary is still held after it is the `spent` flag's job.
    if (lock > 0) return { rideSeconds: ride, lockSeconds: lock - 1, spent: used };
    if (active && isEdged && !used) {
        ride += 1;
        if (ride >= RUIN_RIDE_SECONDS) return { rideSeconds: 0, lockSeconds: RUIN_LOCK_SECONDS, spent: true };
    }
    return { rideSeconds: ride, lockSeconds: lock, spent: used };
}

// The engine has just raised its edge flag: a new edge's pullback has begun.
// It only ever raises it after a release, and a release is what re-arms the
// ride. The 1 s tick sees most releases itself, but a pulse that drops
// through the release point and crosses the mark again between two ticks
// reads to the tick as one unbroken edge; this is the engine's own word that
// it was two. It is the flag and not the edge count, which waits a reading
// longer (edge-confirm.js): the ride is part of the pullback. A lockout that
// is already running is kept: the new edge rides once it has been served.
export function startRuinEdge({ lockSeconds = 0 } = {}) {
    return { rideSeconds: 0, lockSeconds: Math.min(RUIN_LOCK_SECONDS, wholeSeconds(lockSeconds)), spent: false };
}

// How many more seconds the current ride runs if the pulse stays on the
// mark: 0 unless Ruin & Leak is the active mode, the wearer is edged, no
// lockout is running and this edge has not had its ride yet. The ride clock
// keeps running through a stall pause (the guard can cut a ride short, never
// make it longer), so this is also what decides whether a ride is still
// there to come back when a pause ends.
export function ruinRideSecondsLeft(
    { rideSeconds = 0, lockSeconds = 0, spent = false } = {},
    { active = false, isEdged = false } = {}
) {
    if (!active || !isEdged || spent || wholeSeconds(lockSeconds) > 0) return 0;
    return Math.max(0, RUIN_RIDE_SECONDS - wholeSeconds(rideSeconds));
}

// Whether the stall guard is armed this second. It only arms where it has
// something to cut: Crawl keeps the primary moving on the mark, so it arms
// there; Full Stop already parks the primary at 0%, so it does not; a game
// runs its own clock, and Force Orgasm overrides every guard.
//
// Ruin & Leak is governed by neither ceiling rule, so there the question is
// whether its RIDE is on. The guard used to be keyed to Crawl alone, and Full
// Stop disarmed it on the premise that the primary is parked at 0% - which a
// Ruin ride is not - so with Full Stop nothing could cut a ride at all.
// During the lockout, and the stop that holds after it, the primary is at 0%
// already and the guard stands down. A pause that began during the ride
// still runs its course when the ride ends underneath it, as a pause does in
// any other mode: the banner told the wearer the primary is halted for it,
// and switching to a crawling mode inside it must not bring the crawl back
// early.
export function stallGuardArmed({
    enabled = false,
    ceilingBehaviour,
    orgasmMode = false,
    activeMode,
    ruinRiding = false,
    engaged = false
} = {}) {
    if (!enabled || orgasmMode || GAME_MODES.includes(activeMode)) return false;
    if (activeMode === 'ruin') return Boolean(ruinRiding) || Boolean(engaged);
    return resolveCeilingBehaviour(ceilingBehaviour) === 'crawl';
}

// The cue ids the stall guard speaks on one tick. The factory lines for the
// end of a pause promise a crawl ("Hold window reset. Crawl."), which only a
// crawling mode gives back: in Ruin & Leak the primary goes back to the ride
// or stays in the lockout, so that cue stays silent there. And the "left the
// edge" cue ("Recovered. Resume.") is only spoken when the wearer really left
// it. The guard is also released when it is disarmed with the pulse still on
// the mark - switching from a Ruin ride to a Full Stop mode, Force Orgasm, the
// toggle - and "recovered" there tells someone still on the edge to climb.
export function stallGuardCues(
    { justEngaged = false, justResumed = false, justReleased = false } = {},
    { activeMode, isEdged = false } = {}
) {
    const cues = [];
    if (justEngaged) cues.push('stallHalt');
    if (justResumed && activeMode !== 'ruin') cues.push('stallResume');
    if (justReleased && !isEdged) cues.push('stallRecover');
    return cues;
}

// One 1 s tick of Ruin & Leak's clock and the stall guard together, in the
// order that matters: the Ruin clock first, so the guard is armed by THIS
// second's ride - on the second the ride runs out the primary is already
// back at 0%, and a guard armed by last second's ride would start a pause
// with nothing left to cut - then the guard, then the cues it earned.
export function tickRuinAndStallGuard(
    { ruin = {}, guard = {} } = {},
    {
        activeMode,
        isEdged = false,
        orgasmMode = false,
        stallGuard = false,
        ceilingBehaviour,
        holdTimeoutSeconds,
        pauseTimeoutSeconds
    } = {}
) {
    const active = activeMode === 'ruin';
    const nextRuin = tickRuin(ruin, { active, isEdged });
    const armed = stallGuardArmed({
        enabled: stallGuard,
        ceilingBehaviour,
        orgasmMode,
        activeMode,
        ruinRiding: ruinRideSecondsLeft(nextRuin, { active, isEdged }) > 0,
        engaged: Boolean(guard.engaged)
    });
    const nextGuard = tickStallGuard(guard, { armed, isEdged, holdTimeoutSeconds, pauseTimeoutSeconds });
    return { ruin: nextRuin, guard: nextGuard, cues: stallGuardCues(nextGuard, { activeMode, isEdged }) };
}

export function isSurvivalDefeated(breachTicks) {
    return (breachTicks || 0) >= SURVIVAL_BREACH_TICKS;
}

// Speed floor and how far the working ceiling sits above the typed max.
// `seconds` is time spent IN Survival, not the whole session. `edges` is
// edges counted since Survival was switched on.
export function survivalDrive({ seconds = 0, edges = 0 } = {}) {
    const t = Math.max(0, Number(seconds) || 0);
    const n = Math.max(0, Math.floor(Number(edges) || 0));
    const timeMix = t / SURVIVAL_SLOW_SPAN_SECONDS;
    const floor = clamp(Math.round(
        SURVIVAL_START_FLOOR + timeMix * SURVIVAL_TIME_SPEED + n * SURVIVAL_EDGE_SPEED
    ), 5, 100);
    const overdriveBpm = clamp(n * SURVIVAL_EDGE_BPM, 0, SURVIVAL_OVERDRIVE_CAP);
    return { floor, overdriveBpm };
}

// Which counted edges step Survival's climb. Edges from before it was
// switched on do not (1.1.2): the switch takes every edge counted so far as
// seen, and each second of Survival steps the climb once for each edge
// counted since, and sees those too (app.js). But an edge is counted a
// reading after its pullback began, once the pulse has held at the mark
// (edge-confirm.js) - 1.1.2 counted it on the reading the pullback began on -
// so the edge in progress at the switch may still be owed its count. Its
// pullback began before the switch, so it is an edge from before the switch
// however late its count comes: `owedEdgeSeen` holds that count as seen
// until it is made.
export function survivalEdgesAtSwitch({ edges = 0, isEdged = false, edgePending = false } = {}) {
    return {
        edgesSeen: Math.max(0, Math.floor(Number(edges) || 0)),
        owedEdgeSeen: Boolean(isEdged) && Boolean(edgePending)
    };
}

// Survival's seen edges after one engine call. A count made while the owed
// count is held as seen is that count - the flag has stayed up since the
// switch - and it is seen, not stepped. Made, or never to be made because the
// flag released first, it is owed no longer. A pullback that starts is a new
// edge - the flag went down somewhere in between - so it forgets the owed
// count too, and the new edge's count steps the climb.
export function survivalEdgesAfterEngine(
    { edgesSeen = 0, owedEdgeSeen = false } = {},
    { newEdgeTriggered = false, edgePending = false, pullbackStarted = false } = {}
) {
    const owed = Boolean(owedEdgeSeen) && !pullbackStarted;
    return {
        edgesSeen: Math.max(0, Math.floor(Number(edgesSeen) || 0)) + (owed && newEdgeTriggered ? 1 : 0),
        owedEdgeSeen: owed && !newEdgeTriggered && Boolean(edgePending)
    };
}

// ---- Finished me: the heart rate a Survival run held ------------------------
//
// With Calibration checked on the Survival card, Finished me offers the heart
// rate the run pushed the wearer to as their Climax HR: the number every
// later session pulls back at. 1.1.2 offered the highest reading the session
// had taken at all. One glitch was enough - a strap that read 180 for one
// packet during a 120-150 run had 180 offered and saved - and the session's
// readings included the ones from before Survival was switched on, the ones
// taken while paused, and the simulator's slider.
//
// So the number is the SUSTAINED peak: the highest value the pulse held on
// two consecutive readings, which is the lower of the two. One reading alone
// can never be it, however high it went. Only the readings that belong to the
// run count: taken since Survival was switched on in this session, while the
// session was RUNNING - not paused, not in a Soft Landing - and from the
// heart-rate monitor, never from the simulator, which is a number somebody
// typed rather than one anybody measured. A reading that does not count
// still comes between the two either side of it, so they are not
// consecutive.
//
// Two readings are consecutive only when the second came within the
// signal-loss timeout of the first. A longer gap is the one the watchdog
// calls a lost pulse and stops the motors for: a reading from before it and
// one from after it are not two readings of one pulse. A reading stamped
// before the one it follows - a wall clock set back between them - says
// nothing about how long the pulse stayed there, so it is a gap too.

// The wearer who stops the toys at the point of no return, or whose session
// ends in a Soft Landing, climaxes after the run is over. Finished me still
// reads the run for this long after it stopped: 1.1.2 answered that press
// with "Start Survival first" and the calibration was lost.
export const FINISHED_ME_AFTER_STOP_MS = 60 * 1000;

// No climax heart rate lies outside this window. A run that held a pulse
// above 220 held a sensor fault - a strap reading double on poor contact -
// and a number below 40 is no climax either. Both are refused out loud, never
// saved and never passed over in silence.
export const MIN_CALIBRATION_HR = 40;
export const MAX_CALIBRATION_HR = 220;

function isReading(reading) {
    return Boolean(reading) && Number.isFinite(reading.at) && isValidBpm(reading.bpm);
}

// The value the pulse held on `earlier` and `later`, two readings in the
// order they arrived - the lower of the two - or null when they are not two
// consecutive readings of one pulse. `staleSeconds` is the signal-loss
// timeout, held to the 3-20 s the app allows.
export function heldOnTwoReadings(earlier, later, { staleSeconds } = {}) {
    if (!isReading(earlier) || !isReading(later)) return null;
    const gap = later.at - earlier.at;
    if (!(gap >= 0 && gap <= clampStaleSeconds(staleSeconds) * 1000)) return null;
    return Math.min(earlier.bpm, later.bpm);
}

// The sustained peak of a run of readings in the order they arrived: the
// highest value held on two consecutive ones, or null when no two readings
// are consecutive. An entry that is not a usable reading is skipped, as the
// watchdog skips a 0 BPM "no contact" packet.
export function sustainedPeakHr(readings, { staleSeconds } = {}) {
    if (!Array.isArray(readings)) return null;
    let previous = null;
    let peak = null;
    for (const reading of readings) {
        if (!isReading(reading)) continue;
        const held = heldOnTwoReadings(previous, reading, { staleSeconds });
        if (held !== null && (peak === null || held > peak)) peak = held;
        previous = reading;
    }
    return peak;
}

// Finished me's record of one Survival run, opened when Survival comes on in
// a live session, or by START with Survival selected. It keeps no list: the
// sustained peak so far, the last counted reading (to pair with the next
// one), the highest single reading (so the dialog can say one did not hold),
// how many readings counted, and how many came from the simulator while the
// run was running (so a refusal can say why). `closedAt` is when the session
// stopped; a closed record is read, never written.
export function openCalibrationWindow(at) {
    return {
        openedAt: Number.isFinite(at) ? at : null,
        closedAt: null,
        last: null,
        peakHr: null,
        highestHr: null,
        counted: 0,
        simulated: 0
    };
}

// One valid reading of the pulse source while the record is open. `running`:
// the session was RUNNING when it arrived; `simulator`: it came from the
// simulator's slider. A reading that does not count breaks the pair that
// would have straddled it. Returns a new record; the one passed in is never
// changed.
export function noteCalibrationReading(win, { at, bpm, running = false, simulator = false, staleSeconds } = {}) {
    if (!win || win.closedAt !== null) return win;
    const reading = { at, bpm };
    if (!isReading(reading)) return win;
    if (!running || simulator) {
        return { ...win, last: null, simulated: win.simulated + (running && simulator ? 1 : 0) };
    }
    const held = heldOnTwoReadings(win.last, reading, { staleSeconds });
    return {
        ...win,
        last: reading,
        counted: win.counted + 1,
        highestHr: win.highestHr === null ? bpm : Math.max(win.highestHr, bpm),
        peakHr: held === null ? win.peakHr : (win.peakHr === null ? held : Math.max(win.peakHr, held))
    };
}

// The session stopped at `at`. A clock nobody can read closes it as long ago.
export function closeCalibrationWindow(win, at) {
    if (!win || win.closedAt !== null) return win;
    return { ...win, closedAt: Number.isFinite(at) ? at : -Infinity, last: null };
}

// What Finished me may do with a record at `now`, given the Resting HR:
//   'offer'             - the sustained peak, `peakHr`, may become the Climax HR
//   'no-run'            - no Survival run was read in this session
//   'too-late'          - the run stopped more than FINISHED_ME_AFTER_STOP_MS ago
//   'simulator'         - nothing held, and the run's pulse was the simulator's
//   'no-reading'        - the monitor never gave two consecutive readings
//   'too-high' / 'too-low' - the peak lies outside the plausible window
//   'not-above-resting' - the peak is at or below the Resting HR
// The last matters as much as the glitch. A Climax HR at or below the Resting
// HR is a pair the settings refuse, and a refused pair is stored as the
// factory 70 / 140: a peak of 76 over a Resting HR of 80 was confirmed as 76
// and saved as a Climax HR of 140, a raise nobody was told about. A Resting HR
// that is not a number leaves nothing to compare with, and nothing is saved.
export function judgeFinishedMe({ window: win, now, restingHr } = {}) {
    if (!win) return { verdict: 'no-run' };
    if (win.closedAt !== null && !(now - win.closedAt <= FINISHED_ME_AFTER_STOP_MS)) {
        return { verdict: 'too-late' };
    }
    const peakHr = win.peakHr;
    if (peakHr === null) return { verdict: win.simulated > 0 ? 'simulator' : 'no-reading' };
    if (peakHr > MAX_CALIBRATION_HR) return { verdict: 'too-high', peakHr };
    if (peakHr < MIN_CALIBRATION_HR) return { verdict: 'too-low', peakHr };
    if (!Number.isFinite(restingHr) || peakHr <= restingHr) return { verdict: 'not-above-resting', peakHr };
    return { verdict: 'offer', peakHr, highestHr: win.highestHr };
}

// Where the next session pulls back once `peakHr` is the Climax HR. `next` is
// the ceiling a session starts at with that Climax HR and everything else as
// it is now (learnedOffsetCeilings(...).start): the learned offset is kept -
// it is the wearer's record of climaxing early and nothing here clears it -
// and dual-stim dampening applies with the toys connected now. 1.1.2 said
// "the next session uses 152" while a learned offset of 3 had it pulling back
// at 149.
function describeNextPullback({ peakHr, next, holdPercent }) {
    const learned = next.requestedLearned;
    const appliedLearned = next.appliedLearned;
    const dual = next.appliedDual;
    const working = next.maxHr;
    const mark = resolveEdgeTriggerHr(working, holdPercent, next.minHr);
    const reasons = [];
    if (learned > 0) {
        if (appliedLearned >= learned) reasons.push(`Your learned offset of ${learned} BPM is kept`);
        else if (appliedLearned > 0) reasons.push(`Your learned offset of ${learned} BPM is kept, but only ${appliedLearned} BPM of it applies, because ${describeGapFloor(next.minHr)}`);
        else reasons.push(`Your learned offset of ${learned} BPM is kept, but none of it applies, because ${describeGapFloor(next.minHr)}`);
    }
    if (dual > 0) {
        const more = appliedLearned > 0 ? ' more' : '';
        reasons.push(`${reasons.length > 0 ? 'with' : 'With'} your toys connected as they are now, dual-stimulation dampening takes ${dual} BPM${more} off`);
    }
    const fromPercent = Math.min(working, Math.max(1, Math.round(working * (holdPercent / 100))));
    let where;
    if (mark === working) {
        where = `the next session pulls back at ${mark} BPM${mark !== peakHr ? `, not ${peakHr}` : ''}`;
    } else if (mark === fromPercent) {
        where = `the next session's working ceiling is ${working} BPM, and it pulls back at ${mark} BPM, the ${holdPercent}% you set`;
    } else {
        where = `the next session's working ceiling is ${working} BPM, and it pulls back at ${mark} BPM: ${holdPercent}% of that is ${fromPercent}, lifted to clear your Resting HR (${next.minHr})`;
    }
    const sentence = reasons.length > 0
        ? `${reasons.join(', and ')}, so ${where}.`
        : `${where.charAt(0).toUpperCase()}${where.slice(1)}.`;
    return learned > 0
        ? `${sentence} Wipe Memory in Session Setup (Backup) clears the learned offset.`
        : sentence;
}

// The Finished me confirmation, for a run that held `peakHr`. `highestHr` is
// the run's highest single reading: when it went higher than the peak, the
// dialog says it was not held, so a wearer who saw 180 on the cockpit knows
// why 150 is offered. `typedMaxHr` is the Climax HR now. `paused`: the run
// is paused behind the question, and OK ends it. `handyAtRest` is false when
// it is asked over a Handy that has not confirmed its stop
// (describeToysBehindQuestion).
export function describeFinishedMeConfirm({ peakHr, highestHr, typedMaxHr, next, holdPercent, paused = false, handyAtRest = true } = {}) {
    let held = `${peakHr} BPM is the highest heart rate your monitor held on two readings in a row while this Survival run was running.`;
    if (Number.isFinite(highestHr) && highestHr > peakHr) {
        held += ` One reading went up to ${highestHr} BPM, but no reading next to it did - a sensor glitch can do that - so it is not used.`;
    }
    held += peakHr === typedMaxHr
        ? ` Your Climax HR is ${typedMaxHr} BPM already.`
        : ` Your Climax HR is ${typedMaxHr} BPM now.`;
    const toys = describeToysBehindQuestion({ paused, handyAtRest, what: 'run' });
    return [
        `Set your Climax HR to ${peakHr} BPM?`,
        held,
        describeNextPullback({ peakHr, next, holdPercent }),
        paused
            ? `${toys} OK saves it and ends the run; Cancel keeps your Climax HR at ${typedMaxHr} BPM and leaves the run paused, so RESUME carries on.`
            : `${toys} Cancel keeps your Climax HR at ${typedMaxHr} BPM.`
    ].join('\n\n');
}

// What Finished me says when it saves nothing: `text` for the dialog, and
// `line` for the cockpit's prompt line, spoken with voice guidance on (a
// line is at most 140 characters, as every cue is).
function describeFinishedMeRefusal({ verdict, peakHr }, { typedMaxHr, restingHr }) {
    const stays = `Your Climax HR stays ${typedMaxHr} BPM.`;
    switch (verdict) {
    case 'no-run':
        return {
            text: `Nothing was saved. Start Survival first: once it is running, Finished me stops the toys and offers the heart rate the run held as your Climax HR. ${stays}`,
            line: `Not saved: no Survival run to read. ${stays}`
        };
    case 'too-late':
        return {
            text: `Nothing was saved. The Survival run stopped more than ${FINISHED_ME_AFTER_STOP_MS / 1000} seconds ago, and Finished me reads a run only in the minute after it stops. ${stays}`,
            line: `Not saved: the run stopped over a minute ago. ${stays}`
        };
    case 'simulator':
        return {
            text: `Nothing was saved. The heart rate in this run came from the simulator, and Finished me only saves a heart rate your monitor measured. ${stays}`,
            line: `Not saved: a simulated heart rate is never saved. ${stays}`
        };
    case 'no-reading':
        return {
            text: `Nothing was saved. Your heart-rate monitor never gave two readings in a row while this Survival run was running, so there is no heart rate the run held. ${stays}`,
            line: `Not saved: no heart rate held on two readings in a row. ${stays}`
        };
    case 'too-high':
        return {
            text: `Nothing was saved. The highest heart rate the run held was ${peakHr} BPM, above ${MAX_CALIBRATION_HR}: that is a sensor fault, not a climax. ${stays} Type it in yourself if you know it.`,
            line: `Not saved: ${peakHr} BPM is above ${MAX_CALIBRATION_HR}, a sensor fault. ${stays}`
        };
    case 'too-low':
        return {
            text: `Nothing was saved. The highest heart rate the run held was ${peakHr} BPM, below ${MIN_CALIBRATION_HR}, which is no climax. ${stays}`,
            line: `Not saved: ${peakHr} BPM is below ${MIN_CALIBRATION_HR}. ${stays}`
        };
    default:
        if (!Number.isFinite(restingHr)) {
            return {
                text: `Nothing was saved. The highest heart rate the run held was ${peakHr} BPM, but there is no Resting HR to check it against. ${stays}`,
                line: `Not saved: no Resting HR to check ${peakHr} BPM against. ${stays}`
            };
        }
        return {
            text: `Nothing was saved. The highest heart rate the run held was ${peakHr} BPM, which is not above your Resting HR of ${restingHr} BPM, so it cannot be your Climax HR. ${stays}`,
            line: `Not saved: ${peakHr} BPM is not above your Resting HR of ${restingHr}. ${stays}`
        };
    }
}

// Everything one Finished me press does once the toys are stopped, worked
// out when the question is asked, from the run as it stood at the press and
// the settings as they stand then, so the numbers the wearer agrees to are
// the numbers that are stored. `window` is the record as it stood at the
// press and `now` the moment of the press. `paused`: a run is paused behind
// the question - the press pauses one that is driving the toys - and only
// OK ends it. Cancel and a refusal leave it paused, with nothing in History
// until the wearer ends it: the press used to end the run before it asked,
// so a cancelled or a refused calibration went into History as "Survival
// calibration". `inputs`: workingCeilingInputs as the engine has them (the
// Resting HR and the Climax HR among them). `handyAtRest` is false when the
// question is asked over a Handy that has not confirmed its stop, and every
// dialog then says so instead of "the toys are stopped". Returns what to
// `ask` ('confirm' or 'alert'), its `text`, the prompt `line` to paint and
// speak, the `saveHr` OK stores, the `outcome` History records when OK ends
// the run, and the `cancelLine` for a No.
export function planFinishedMe({ calibrating = false, paused = false, window: win = null, now, inputs = {}, holdPercent, handyAtRest = true } = {}) {
    const typedMaxHr = inputs.maxHr;
    const restingHr = inputs.minHr;
    const stays = `Your Climax HR stays ${typedMaxHr} BPM.`;
    const none = { saveHr: null, outcome: null, cancelLine: null };
    const toys = describeToysBehindQuestion({ paused, handyAtRest, what: 'run' });
    // An alert over toys at rest with no run behind it says nothing about
    // them; a Handy in doubt is said every time.
    const alertToys = paused || !handyAtRest ? `\n\n${toys}` : '';
    if (!calibrating) {
        // Without Calibration the button only ends the run, once the wearer
        // says so. Pressed with no run to end, it says what the check on the
        // card is for.
        if (paused) {
            return {
                ...none,
                ask: 'confirm',
                verdict: 'end-run',
                text: [
                    'End the run?',
                    `Calibration is off on the Survival card, so your Climax HR stays ${typedMaxHr} BPM. Check it before a run if Finished me should save the heart rate the run held.`,
                    `${toys} Cancel leaves it paused, so RESUME carries on.`
                ].join('\n\n'),
                line: `Run ended. Calibration is off, so your Climax HR stays ${typedMaxHr} BPM.`,
                outcome: 'Survival'
            };
        }
        return {
            ...none,
            ask: 'alert',
            verdict: 'not-calibrating',
            text: `Nothing was saved: Calibration is off on the Survival card. Check it before a run if Finished me should save the heart rate the run held as your Climax HR. ${stays}${alertToys}`,
            line: `Not saved: Calibration is off. ${stays}`
        };
    }
    const judged = judgeFinishedMe({ window: win, now, restingHr });
    if (judged.verdict !== 'offer') {
        const refusal = describeFinishedMeRefusal(judged, { typedMaxHr, restingHr });
        let text = refusal.text;
        if (paused && handyAtRest) text += '\n\nThe toys are stopped and the run is paused: RESUME carries on, STOP ends it.';
        else if (paused) text += `${alertToys} RESUME carries on, STOP ends it.`;
        else text += alertToys;
        return {
            ...none,
            ask: 'alert',
            verdict: judged.verdict,
            text,
            line: refusal.line
        };
    }
    const next = learnedOffsetCeilings({ ...inputs, maxHr: judged.peakHr }).start;
    return {
        ask: 'confirm',
        verdict: 'offer',
        text: describeFinishedMeConfirm({
            peakHr: judged.peakHr,
            highestHr: judged.highestHr,
            typedMaxHr,
            next,
            holdPercent: clampEdgeHoldPercent(holdPercent),
            paused,
            handyAtRest
        }),
        line: `Saved. Your Climax HR is ${judged.peakHr} BPM.`,
        cancelLine: `Not saved. ${stays}`,
        saveHr: judged.peakHr,
        outcome: 'Survival calibration'
    };
}

// ---- Came Early and Finished me: the toys stop before the question ---------
//
// Both buttons mean the wearer has come, so both stop every toy first, as
// STOP stops them, and only then ask. The question is a native dialog, and a
// native dialog stops the page it is opened from: no timer fires and no
// promise settles until it is answered. 1.1.2 asked first, so the question
// stood over toys still running on a body that had just climaxed, with no
// watchdog, guard or clock watching them until it was answered. Stopping
// first is not enough on its own either. The Handy's stop is verified - PUT
// /hamp/stop, tried again 250, 500 and 1000 ms later until the API confirms
// it - and those waits are timers. Opened one frame after the stop, the
// question stood over a first PUT that had failed: the retry went out only
// once it was answered, five seconds later in the measured case, while the
// dialog told the wearer the toys were stopped and the Handy kept moving. So
// the question waits, with the page running, while any start or verified
// stop is still on its way to a Handy - the live one, or one whose key
// Disconnect, a reconnect or the offline verdict has just dropped, whose stop
// is retried all the same (handy.js handyRestState) - and then one frame
// more, so the cockpit behind it shows the stopped session and every stop
// the other drivers queue from a promise job has gone out. A session that is
// driving the toys again meanwhile is stopped again first: the page takes no
// START or RESUME while a press runs (app.js startOrResumeWhenReady), and
// this does not rely on that.
//
// A Handy that has not confirmed its stop once nothing is on its way any
// more may still be moving: every attempt failed, or it went offline before
// one was confirmed and is being sent a stop in the background every few
// seconds, which is not waited for (handy.js beginOfflineStop). The press
// asks nothing then. The prompt line tells the wearer, and the next press of
// the button is their answer: that press asks once nothing is on its way,
// and its question says the Handy may still be moving instead of "the toys
// are stopped" (`acknowledged`). Refusing every press until the Handy
// answered would leave no way out: an offline Handy is sent that background
// stop for about seven minutes when every attempt fails at once and half an
// hour when each times out, Disconnect is not offered for it, and a wearer
// who had come could neither log it nor save a Survival run while the
// minute after STOP ran out. The refusal holds the button for REFUSAL_HOLD_MS, so
// the second tap of a double tap is not taken for that answer: the line has
// to have been there to be answered.
//
// A stop asked for a Handy already at rest - one that has confirmed a stop
// since anything that may have moved it - can go unanswered on every attempt:
// a Handy switched off after STOP, say. Such a device is not in doubt (handy.js
// noteStopFailed: that stop is an API error, not "may still be moving"), so
// the press asks. It must not say the Handy confirmed its stop, though, and
// handyRestState cannot tell it: that stop leaves it 'stopped'. So the press
// reads what became of the verified stops while it waited (`stopTally`,
// handy.js handyStopTally), and the question is told when one went
// unanswered and none was confirmed (`unanswered`). One that gave up before
// a stop sent after it was confirmed - the stop that follows a start which
// landed late - leaves the Handy at rest on that confirmation: it has
// confirmed its stop.
//
// A stop the API answers at once is confirmed in a few hundred milliseconds.
// One that is retried can take much longer - four attempts, 26 s when each
// times out, and a Handy whose stops keep failing is sent another on the next
// tick until it is called offline - and all that time the press showed
// nothing but a paused session. After STOP_WAIT_NOTICE_MS of waiting, the
// wearer is told what the press is waiting for (`waiting`), once, and the
// question is told they were (`waited`).
//
// `halt` stops every toy, pausing a session that is driving them; `driving`
// says whether one is; `handyRest` is handyRestState; `stopTally` is
// handyStopTally; `wait` and `nextFrame` are the page's clock.
// `ask({ handyAtRest, waited, unanswered })` runs the question and stores the
// answer, in one go; `handyAtRest` is false when it is asked over a Handy in
// doubt. `refuse` says why nothing was asked. Resolves once one of the two
// has run and, after a refusal, the hold is over.
export const STOP_POLL_MS = 50;
export const STOP_WAIT_NOTICE_MS = 1000;

// A double tap lands a few hundred milliseconds after the first tap (40 to
// 300 ms measured on a phone); a line takes longer than that to read.
export const REFUSAL_HOLD_MS = 1000;

// A page with no Handy driver to ask: nothing confirmed, nothing unanswered.
const NO_STOPS = Object.freeze({ confirmed: 0, unanswered: 0 });

export async function stopThenAsk({ halt, driving, handyRest, stopTally = () => NO_STOPS, wait, nextFrame, ask, refuse, waiting = () => {}, acknowledged = false } = {}) {
    const before = stopTally();
    halt();
    let waitedForHandy = 0;
    let told = false;
    for (;;) {
        const rest = handyRest();
        if (driving() || rest === 'pending') {
            if (rest === 'pending') {
                if (!told && waitedForHandy >= STOP_WAIT_NOTICE_MS) {
                    told = true;
                    waiting();
                }
                waitedForHandy += STOP_POLL_MS;
            }
            await wait(STOP_POLL_MS);
        } else if (rest === 'unconfirmed' && !acknowledged) {
            refuse();
            await wait(REFUSAL_HOLD_MS);
            return undefined;
        } else {
            await nextFrame();
            const settled = handyRest();
            if (!driving() && settled !== 'pending' && (settled !== 'unconfirmed' || acknowledged)) {
                const after = stopTally();
                const unanswered = after.unanswered !== before.unanswered && after.confirmed === before.confirmed;
                return ask({ handyAtRest: settled !== 'unconfirmed', waited: told, unanswered });
            }
        }
        if (driving()) halt();
    }
}

// One question at a time. The plan behind a question is made when it is
// asked, from the learning profile and the Climax HR as they stand, and a
// press that comes while an earlier one is still stopping the toys or asking
// is dropped. With the question deferred past the stop, a second tap - 160-
// 240 ms later on a phone-speed CPU with a full History - reached the
// button, made a second plan from the offset the first had not stored yet,
// and its OK logged a second event that added nothing while its dialog and
// its cue said the limit had dropped again. A tap is judged by when it was
// made, `pressedAt` (the click's timeStamp, on the `now` clock): the browser
// holds back a tap that lands while the page is busy - ending the session
// after OK, writing History - and hands it over afterwards, and a tap made
// before the last question was over belongs to that question, not to a new
// one. `run` resolves true when it ran the press, false when it dropped it.
// `claims(pressedAt)` is that same rule for any other tap: true while a press
// is stopping the toys or asking, and for a tap made before the last one was
// over. The page asks it of START and RESUME (app.js startOrResumeWhenReady):
// a press keeps the toys stopped until its question is answered, and a START
// or RESUME tapped while it waited was still waiting for The Handy's answer
// when the question opened, so it started the toys once the question was
// answered - after Cancel, whose dialog says the session stays paused, and
// after OK in the minute after STOP.
export function createQuestionGate({ now = () => Date.now() } = {}) {
    let busy = false;
    let settledAt = -Infinity;
    const claims = (pressedAt) => busy || (Number.isFinite(pressedAt) ? pressedAt : now()) < settledAt;
    return {
        get busy() {
            return busy;
        },
        claims,
        async run(steps, { pressedAt } = {}) {
            if (claims(pressedAt)) return false;
            busy = true;
            try {
                await stopThenAsk(steps);
                return true;
            } finally {
                busy = false;
                settledAt = now();
            }
        }
    };
}

// The prompt line for a press that asked nothing because the Handy has not
// confirmed its stop (at most 140 characters, as every cue is). It names
// what the wearer can do whatever became of the link - the device's own
// button works when the API does not, and Disconnect is not offered for a
// Handy that went offline - and the press that answers it (stopThenAsk).
export function describeStopNotConfirmed({ finishedMe = false } = {}) {
    return finishedMe
        ? 'Nothing saved yet: the Handy has not confirmed its stop and may still be moving. Switch it off if it is, then press Finished me again.'
        : 'Nothing logged yet: the Handy has not confirmed its stop and may still be moving. Switch it off if it is, then press Came Early again.';
}

// The prompt line for a press still waiting for the Handy to confirm its
// stop (stopThenAsk's `waiting`), as short as a cue.
export function describeWaitingForStop() {
    return 'Waiting for the Handy to confirm its stop before asking.';
}

// The line that says how that wait ended, when the question is asked
// (stopThenAsk passes `waited` and `unanswered`): it replaces the notice -
// nothing else repaints the prompt line when the answer is Cancel, and the
// notice stood on after the question as if the press were still waiting -
// and it is said as well for a stop that went unanswered before the notice
// was due. `handyAtRest` and `unanswered` are the question's own. A Handy at
// rest whose stop went unanswered had confirmed an earlier one and has not
// been started since; "The Handy has confirmed its stop" was said over it,
// after every attempt of the stop the press sent had been refused.
export function describeStopWaitOver({ handyAtRest = true, unanswered = false } = {}) {
    if (!handyAtRest) return 'The Handy has not confirmed its stop: if it is still moving, switch it off.';
    return unanswered
        ? 'The Handy did not confirm the stop, but it had confirmed an earlier one and nothing has started it since.'
        : 'The Handy has confirmed its stop.';
}

// What a press of `kind` - 'cameEarly' or 'finishedMe' - is about, made at
// `now`. `held` is the press the Handy last turned away, if any (stopThenAsk
// refused it). A press of the same kind answers it (`acknowledged`) and is
// about that press, not about now: seeing to a Handy that went offline can
// take minutes, and meanwhile the pulse falls from the climax and the minute
// after STOP runs out. Judged at the second press, Came Early took the larger
// step on that fall and stored it as the event's pulse, and Finished me
// refused a run the first press was in time for. Otherwise a Came Early
// press carries the peak of the minute before `now` in `readings`
// (recentPeakHr), and a Finished me press the calibration `window` as it
// stands, stamped `now` (judgeFinishedMe reads it at that moment). Returns
// { press, acknowledged }; `press` is what to keep if this press is refused.
export function pressAbout({ kind, held = null, now, readings = [], window: win = null } = {}) {
    if (held && held.kind === kind) return { press: held, acknowledged: true };
    const press = kind === 'finishedMe'
        ? { kind, pressedAt: now, win }
        : { kind, peakHr: recentPeakHr(readings, now) };
    return { press, acknowledged: false };
}

// Edge Training: climb to the pullback mark, hold there for holdGoal
// seconds, repeat until edgesGoal successful holds, then finish.
export const MIN_TRAIN_HOLD_SECONDS = 5;
export const MAX_TRAIN_HOLD_SECONDS = 90;
export const DEFAULT_TRAIN_HOLD_SECONDS = 15;
export const MIN_TRAIN_EDGES = 1;
export const MAX_TRAIN_EDGES = 20;
export const DEFAULT_TRAIN_EDGES = 5;

export function clampTrainHoldSeconds(value, fallback = DEFAULT_TRAIN_HOLD_SECONDS) {
    const n = toInt(value);
    if (n === null) return fallback;
    return clamp(n, MIN_TRAIN_HOLD_SECONDS, MAX_TRAIN_HOLD_SECONDS);
}

export function clampTrainEdges(value, fallback = DEFAULT_TRAIN_EDGES) {
    const n = toInt(value);
    if (n === null) return fallback;
    return clamp(n, MIN_TRAIN_EDGES, MAX_TRAIN_EDGES);
}

export function tickEdgeTraining(
    { state: trainState = 'climb', holdSeconds = 0, edgesDone = 0 } = {},
    { isEdged = false, released = false, holdGoal = DEFAULT_TRAIN_HOLD_SECONDS, edgesGoal = DEFAULT_TRAIN_EDGES, orgasmMode = false } = {}
) {
    const holdLimit = clampTrainHoldSeconds(holdGoal);
    const need = clampTrainEdges(edgesGoal);
    const done = Math.max(0, Number.isFinite(edgesDone) ? Math.round(edgesDone) : 0);
    const held = Math.max(0, Number.isFinite(holdSeconds) ? Math.round(holdSeconds) : 0);
    const idle = {
        justHold: false,
        justCounted: false,
        justDropped: false,
        justFinished: false,
        justRecovered: false
    };

    // Force Orgasm SUSPENDS training, it never completes it: the state, the
    // hold clock and the edge counter are handed back exactly as they were,
    // so tapping it can neither report unearned edges nor latch the game.
    if (orgasmMode) {
        return { ...idle, state: trainState, holdSeconds: held, edgesDone: done };
    }

    // Force Orgasm was cancelled after the finish. Mirroring the Oracle's
    // withdrawal (CLIMAX -> APPROACH), the game returns to the climb instead
    // of sitting in a terminal state the session can never leave. That set is
    // over, so the counter starts again from zero: keeping it at the goal
    // would let the very next completed hold re-arm Force Orgasm, seconds
    // after the wearer deliberately cancelled it, and would read N/N (then
    // N+1/N) on the dashboard. A fresh set is the Oracle's minimum-window
    // equivalent: the whole training has to be earned again.
    if (trainState === 'finish') {
        return { ...idle, state: 'climb', holdSeconds: 0, edgesDone: 0 };
    }

    if (trainState === 'hold') {
        if (!isEdged) {
            return { ...idle, state: 'recover', holdSeconds: 0, edgesDone: done, justDropped: true };
        }
        const nextHold = held + 1;
        if (nextHold >= holdLimit) {
            const nextDone = done + 1;
            if (nextDone >= need) {
                return { ...idle, state: 'finish', holdSeconds: 0, edgesDone: nextDone, justCounted: true, justFinished: true };
            }
            return { ...idle, state: 'recover', holdSeconds: 0, edgesDone: nextDone, justCounted: true };
        }
        return { ...idle, state: 'hold', holdSeconds: nextHold, edgesDone: done };
    }

    if (trainState === 'recover') {
        if (released || !isEdged) {
            return { ...idle, state: 'climb', holdSeconds: 0, edgesDone: done, justRecovered: Boolean(isEdged) || released };
        }
        return { ...idle, state: 'recover', holdSeconds: 0, edgesDone: done };
    }

    if (isEdged) {
        return { ...idle, state: 'hold', holdSeconds: 1, edgesDone: done, justHold: true };
    }
    return { ...idle, state: 'climb', holdSeconds: 0, edgesDone: done };
}

// What arriving at the endgame does to a latched Force Orgasm. The latch is
// armed earlier in the session, by the wearer or by an Oracle climax roll,
// and while it is on the motors ramp up and the ceiling climbs. Only the
// Orgasm endgame keeps it, because that ending IS the latch: a Soft Landing
// is a 45 s tease-down and would otherwise keep driving the toys, and Denied
// stops the session (which clears the latch anyway).
export function endgameKeepsOrgasmLatch(endgameType) {
    return endgameType === 'orgasm';
}

// ---- Force Orgasm: how long one run may last ------------------------------

// Nothing used to end Force Orgasm but the wearer. The button, the Climax
// ending, an Oracle climax, the end of Edge Training and a partner's remote
// all switched on an overdrive that ran until somebody tapped it off or
// found STOP, and a wearer who came on it said it "wasn't gonna let me rest":
// he had to find STOP in the middle of his orgasm. So a run now lasts at most
// the time the Guards tab says, counted from the moment it was switched on -
// its ramp is part of the run - and then the session goes into the soft
// landing, both channels eased down to a stop over 45 s from half speed, or
// from what the run was sending if that is slower: a run resumed in its last
// seconds has only just begun to climb again from the stop (engine.js
// landingCap). It is never a cut to 0, and never a step up.
//
// Why 90 s by default. The orgasm itself is short and regular: measured by
// anal pressure probe it is a series of 10 to 15 pelvic contractions that
// starts at about 0.6 s apart, each gap about 0.1 s longer than the one
// before (Bohlen, Held & Sanderson, "The male orgasm: pelvic contractions
// measured by anal probe", Archives of Sexual Behavior 9(6):503-521, 1980),
// which is about 9 to 18 seconds from the first contraction to the last. In
// the same study the second most common pattern carried on after that
// series with irregular contractions, and it was the longest of the three.
// A run spends its first ORGASM_RAMP_SECONDS (28 s) easing up from what the
// toys were doing, so 90 s leaves a full minute at the top: the regular
// series more than three times over, with room for the climb to it from
// wherever the run found the wearer and for that irregular tail. The
// landing after it still strokes for 45 s, from half speed down, so an
// orgasm that comes late is eased out rather than cut off. The longer limits
// are for a wearer who takes longer to get there; Off is the old behaviour,
// for a wearer who wants it back.
export const FORCE_ORGASM_MAX_OPTIONS = [60, 90, 120, 180, 0];
export const DEFAULT_FORCE_ORGASM_MAX_SECONDS = 90;
export const MAX_FORCE_ORGASM_SECONDS = Math.max(...FORCE_ORGASM_MAX_OPTIONS);

// A stored or chosen limit: one of the options, as a number, 0 being Off.
// The options are a list, not a range, so nothing is rounded to the nearest
// one. Anything else - a number no control writes, junk from a hand-edited
// file, a missing value - is the factory limit and never Off: a guard that a
// typo could switch off would not be a guard. The Guards select writes its
// option as a string of digits, so such a string is read as its number;
// true, null, '' and [] are not a 0 anybody chose, whatever Number() says.
export function resolveForceOrgasmMaxSeconds(value) {
    const n = typeof value === 'number' ? value
        : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value)
            : NaN;
    const option = FORCE_ORGASM_MAX_OPTIONS.find((seconds) => seconds === n);
    return option === undefined ? DEFAULT_FORCE_ORGASM_MAX_SECONDS : option;
}

// One 1 s tick of a Force Orgasm run's clock. app.js asks it on every tick
// BEFORE the engine runs, so on the second the limit runs out the toys are
// sent the landing and not one more second of overdrive. `seconds` is how
// many running seconds the run has had; it starts again from 0 whenever
// Force Orgasm is switched on or off. Only a RUNNING session counts: a pause
// stops the clock. The clock counts whole ticks, so the part of a second
// before a pause goes uncounted, but RESUME starts the ramp again from the
// stop the pause sent (app.js) and the climb back is counted, so a pause can
// only ever shorten the time a run spends at the top, never stretch it.
// `expired`: the limit is up, and the run ends in the soft landing.
export function tickForceOrgasm(
    { seconds = 0 } = {},
    { orgasmMode = false, sessionStatus, maxSeconds } = {}
) {
    if (!orgasmMode) return { seconds: 0, expired: false };
    const ran = wholeSeconds(seconds);
    if (sessionStatus !== 'RUNNING') return { seconds: ran, expired: false };
    const limit = resolveForceOrgasmMaxSeconds(maxSeconds);
    const next = ran + 1;
    return { seconds: next, expired: limit > 0 && next >= limit };
}

// The seconds the Force Orgasm button counts down, or 0 for no countdown:
// Force Orgasm is off, or the limit is Off (then nothing ends the run but
// the wearer, exactly as before the limit existed). A run shows at least one
// second for as long as it lasts: a limit lowered below the time already
// run ends it on the next tick.
export function forceOrgasmSecondsLeft({ orgasmMode = false, seconds = 0, maxSeconds } = {}) {
    const limit = resolveForceOrgasmMaxSeconds(maxSeconds);
    if (!orgasmMode || limit === 0) return 0;
    return Math.max(1, limit - wholeSeconds(seconds));
}

// The countdown as the button shows it (m:ss), or '' when there is none.
export function describeForceOrgasmCountdown(secondsLeft) {
    const s = wholeSeconds(secondsLeft);
    if (s <= 0) return '';
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// A soft landing is under way: RAMPDOWN, or a pause that resumes into one.
export function inSoftLanding({ sessionStatus, resumeStatus = null } = {}) {
    return sessionStatus === 'RAMPDOWN' || (sessionStatus === 'PAUSED' && resumeStatus === 'RAMPDOWN');
}

// Why switching Force Orgasm ON must be refused right now: 'landing',
// 'idle', or '' when it may go on. Switching it OFF is never refused. A tap,
// a partner's ORGASM_TOGGLE and the Climax ending all reach app.js as a
// click on the button and are asked here; an Oracle climax and the end of
// Edge Training switch it on from inside a running tick, where nothing is
// refused.
//
// A landing - the Soft Landing ending, the landing the time limit starts, any
// RAMPDOWN - is how the session ends, and nothing starts the overdrive inside
// it. The engine only forces a RUNNING session, so a tap there used to latch
// Force Orgasm while nothing was forced: the button read Forcing... for the
// rest of the landing and the dashboard said "Take it. Come." over toys that
// were winding down. And the limit switches Force Orgasm off by itself while
// the button is a toggle: a wearer reaching for it to stop the overdrive as
// the countdown runs out - the moment the limit exists for - would switch it
// back ON if the tap landed just after the limit did, and a partner's tap
// lands later still (their page learns of the landing from the next frame of
// telemetry, and their command then crosses the network). Refused, such a
// tap can never re-arm the overdrive.
//
// With no session running the engine forces nothing either, and START
// switches a latched Force Orgasm off before the first tick, so a tap there
// only ever made the button read Forcing... over toys that were not moving.
export const FORCE_ORGASM_REFUSALS = ['', 'landing', 'idle'];

export function forceOrgasmRefusal({ sessionStatus, resumeStatus = null } = {}) {
    if (inSoftLanding({ sessionStatus, resumeStatus })) return 'landing';
    if (sessionStatus !== 'RUNNING' && sessionStatus !== 'PAUSED') return 'idle';
    return '';
}

// The line the cockpit shows under the button when a switch-on is refused.
export function describeForceOrgasmRefusal(reason) {
    if (reason === 'landing') return 'SOFT LANDING: FORCE ORGASM STAYS OFF UNTIL THE SESSION ENDS';
    if (reason === 'idle') return 'FORCE ORGASM NEEDS A RUNNING SESSION: PRESS START FIRST';
    return '';
}

// What the Force Orgasm button says, from the state the session is really in.
// It reads Forcing... only while a running session is being forced. A pause
// holds a latched run as it is: Armed, with its countdown standing still, and
// RESUME ramps it up again from the stop. In a landing it reads as off, and a
// tap there is refused. `landing` is inSoftLanding() on the wearer's page; a
// partner's page is told it by the host, which alone knows what a pause will
// resume into. `look` picks the button's colours.
export function describeForceOrgasmButton({ orgasmMode = false, sessionStatus, landing = false, secondsLeft = 0 } = {}) {
    const countdown = describeForceOrgasmCountdown(secondsLeft);
    if (orgasmMode && sessionStatus === 'RUNNING') {
        return { kicker: 'Overdrive', label: 'Forcing...', countdown, look: 'forcing' };
    }
    if (landing) return { kicker: 'Soft landing', label: 'Force Orgasm', countdown: '', look: 'barred' };
    if (orgasmMode && sessionStatus === 'PAUSED') {
        return { kicker: 'Overdrive', label: 'Armed', countdown, look: 'armed' };
    }
    return { kicker: 'Overdrive', label: 'Force Orgasm', countdown: '', look: 'ready' };
}

// The highest reading a crawl can give: Global Intensity scales every motor
// term by 0.5x to 1.5x, so the 10% micro-motion reaches the toys as 5-15%.
// Nothing above this is a crawl, so nothing above it may be called one.
const MAX_CRAWL_READING = Math.round(CRAWL_PERCENT * 1.5);

// One channel of the cockpit's cutoff banner, named by what the engine really
// sent it on this tick rather than by what the mode is supposed to do.
function describeCutoffChannel(label, percent) {
    if (!Number.isFinite(percent)) return `${label} UNKNOWN`;
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    if (pct === 0) return label === 'PRIMARY' ? 'PRIMARY CUT' : 'SECONDARY STOPPED';
    if (pct <= MAX_CRAWL_READING) return `${label} CRAWLING (${pct}%)`;
    return label === 'PRIMARY' ? `PRIMARY RUNNING (${pct}%)` : `SECONDARY MILKING (${pct}%)`;
}

// The cockpit's cutoff banner, as pure text: the caller paints what comes
// back and hides the banner on ''. It used to be one fixed sentence - PRIMARY
// CUT, SECONDARY MILKING ACTIVE - shown whenever the pulse sat on the mark,
// whatever the engine was doing. In Classic Tease with Full Stop both motors
// are parked at 0% and the wearer was told an idle vibrator was milking them,
// so they went looking for a broken toy or a wrong role; in Survival the
// primary is still climbing while the banner called it cut. Worse, the edge
// flag deliberately survives a pause, so a watchdog pause on a lost signal
// left the banner asserting an active secondary with every motor stopped.
// It now reports the two numbers the engine produced on this tick, and says
// nothing at all unless the session is RUNNING.
export function describeCutoffNotice({
    sessionStatus,
    isEdged = false,
    orgasmMode = false,
    stallGuardEngaged = false,
    primaryPercent,
    secondaryPercent
} = {}) {
    if (sessionStatus !== 'RUNNING') return '';
    // Force Orgasm is not a cutoff, and the stall guard raises its own
    // banner for the halt it is running.
    if (!isEdged || orgasmMode || stallGuardEngaged) return '';
    const primary = describeCutoffChannel('PRIMARY', primaryPercent);
    const secondary = describeCutoffChannel('SECONDARY', secondaryPercent);
    return `CLIMAX LIMIT REACHED: ${primary} \u2014 ${secondary}`;
}

// The cockpit's game banner, as pure text: the caller paints what comes back
// and hides the banner on ''. It is only ever a report of the state the
// session is really in - a banner that says the Oracle is still deciding, or
// that the training is still climbing, while the session is teasing down to
// a stop is worse than no banner at all.
export function describeGameNotice({
    activeMode,
    sessionStatus,
    oracleState = 'IDLE',
    oracleTimer = 0,
    trainState = 'climb',
    trainHoldSeconds = 0,
    trainEdgesDone = 0,
    trainHoldGoal,
    trainEdgesGoal,
    survivalSpeedFloor = 0,
    survivalOverdrive = 0,
    survivalCalibrating = false,
    sessionSeconds = 0,
    minSeconds = 0,
    maxSeconds = 0,
    targetSeconds = 0,
    fixedLength = false
} = {}) {
    const isGame = activeMode === 'oracle' || activeMode === 'survival' || activeMode === 'edgetrain';
    const live = sessionStatus === 'RUNNING' || sessionStatus === 'RAMPDOWN';
    if (!isGame || !live) return '';

    // A Soft Landing ends the game whichever way it was reached: the Oracle's
    // own roll sets oracleState to RAMPDOWN, but the session timer can hand
    // ANY game to the same tease-down and leaves the game state exactly where
    // it stood. Nothing is still deciding and nothing is still climbing for
    // those 45 s, so the banner says what is really happening instead.
    if (sessionStatus === 'RAMPDOWN') {
        return activeMode === 'oracle' ? 'THE ORACLE: SOFT LANDING' : 'SOFT LANDING: TEASING DOWN';
    }

    if (activeMode === 'oracle') {
        if (oracleState === 'HOLD') return `THE ORACLE: HOLDING ${oracleTimer}s — FATE PENDING`;
        if (oracleState === 'CLIMAX') return 'THE ORACLE: CLIMAX';
        if (oracleState === 'DENIAL') return 'THE ORACLE: DENIAL';
        if (oracleState === 'RAMPDOWN') return 'THE ORACLE: SOFT LANDING';
        if (oracleState === 'PURGATORY') {
            const timing = oracleTiming({ sessionSeconds, minSeconds, maxSeconds, targetSeconds, fixedLength });
            return timing.canEnd ? 'THE ORACLE: PURGATORY' : 'THE ORACLE: NOT YET — KEEP CLIMBING';
        }
        return 'THE ORACLE: APPROACHING THE CEILING';
    }

    if (activeMode === 'survival') {
        const floor = Math.round(Number.isFinite(survivalSpeedFloor) ? survivalSpeedFloor : 0);
        const over = Math.max(0, Math.round(Number.isFinite(survivalOverdrive) ? survivalOverdrive : 0));
        const mark = survivalCalibrating ? 'CALIBRATING — ' : '';
        return `SURVIVAL: ${mark}FLOOR ${floor}% — +${over} BPM`;
    }

    const need = clampTrainEdges(trainEdgesGoal);
    const done = Math.max(0, Number.isFinite(trainEdgesDone) ? Math.round(trainEdgesDone) : 0);
    if (trainState === 'hold') {
        const holdGoal = clampTrainHoldSeconds(trainHoldGoal);
        const held = Math.max(0, Number.isFinite(trainHoldSeconds) ? Math.round(trainHoldSeconds) : 0);
        return `EDGE TRAINING: HOLD ${Math.max(0, holdGoal - held)}s — ${done}/${need} EDGES`;
    }
    if (trainState === 'recover') return `EDGE TRAINING: RECOVER — ${done}/${need} EDGES`;
    if (trainState === 'finish') return 'EDGE TRAINING: COMPLETE — COME';
    return `EDGE TRAINING: CLIMB — ${done}/${need} EDGES`;
}

// The cockpit's stall-pause banner, as pure text. The banner used to be one
// fixed sentence in index.html - CRAWL RESUMES AFTER THE PAUSE - painted
// whatever mode was running. In Ruin & Leak the primary is parked at 0% by
// the mode's own lockout once its ride is over, so the wearer held at the
// pullback mark on the defaults was promised a crawl in 8 seconds that the
// mode can never give: the premise of Ruin & Leak is cutting penile input
// cold. The same sentence is wrong wherever the primary is not coming back to
// a crawl, so the banner now names what the ACTIVE mode and the "At the
// ceiling" setting will really do when the pause ends.
//
// `rideSecondsLeft` / `pauseSecondsLeft` (ruinRideSecondsLeft and
// stallPauseSecondsLeft) matter in Ruin & Leak only.
export function describeStallPauseNotice({ mode, ceilingBehaviour, rideSecondsLeft = 0, pauseSecondsLeft = 0 } = {}) {
    const halted = 'STALL PAUSE: PRIMARY HALTED';
    // Ruin & Leak is governed by neither ceiling rule. The guard is armed
    // during its ride, and the ride's clock runs on through the pause, so the
    // ride only comes back if it still has time left when the pause ends; on
    // the tick they both run out the ride ends first. Otherwise the lockout,
    // and the stop that holds after it until the edge releases, keeps the
    // primary at 0%. This banner used to say the lockout held it at 0% in
    // every case - over a ride that came back as the pause ended, and over a
    // lockout that was about to run out into a fresh ride.
    if (mode === 'ruin') {
        return rideSecondsLeft > pauseSecondsLeft
            ? `${halted} — RUIN RIDE RESUMES AFTER THE PAUSE`
            : `${halted} — RUIN LOCKOUT HOLDS IT AT 0%`;
    }
    // Survival never parks on the mark: its speed climbs on its own clock,
    // and the "At the ceiling" setting does not govern it either - so this
    // is asked BEFORE the Full Stop rule, which would otherwise promise a
    // 0% that Survival is not going to give.
    if (mode === 'survival') return `${halted} — SPEED RESUMES AFTER THE PAUSE`;
    if (resolveCeilingBehaviour(ceilingBehaviour) !== 'crawl') return `${halted} — FULL STOP HOLDS IT AT 0%`;
    return `${halted} — CRAWL RESUMES AFTER THE PAUSE`;
}

// ---- Cool-down after edges -------------------------------------------------

// The Guards choices: how long the cool-down after an edge lasts (0 is Off)
// and after every how-manieth edge it starts. The engine restarts the session
// warm-up curve over that length; the rules below only decide WHEN.
export const COOLDOWN_MINUTES_OPTIONS = [0, 1, 2, 3, 5];
export const COOLDOWN_EVERY_OPTIONS = [1, 2, 3];
export const DEFAULT_COOLDOWN_MINUTES = 0;
export const DEFAULT_COOLDOWN_EVERY_EDGES = 2;

// The two things that count as an edge for the cool-down: the pulse leaving
// the pullback mark, and the wearer resuming after an edge pause.
export const COOLDOWN_EVENTS = ['release', 'edgeResume'];

// The cool-down's length in seconds, or null when it is Off or the stored
// value is not one the wearer could have chosen. A length nobody picked must
// not hold the toys slow, so junk reads as Off here and in cooldownSecondsFor.
function cooldownLength(minutes) {
    return COOLDOWN_MINUTES_OPTIONS.includes(minutes) && minutes > 0 ? minutes * 60 : null;
}

// May an edge start a cool-down right now? Only in a running tease mode the
// engine eases (COOLDOWN_MODES), never during Force Orgasm - the wearer asked
// for full speed - and never in a soft landing or a pause, where the toys are
// already teasing down or stopped and a cool-down clock would run unseen.
// Nor in Script mode: there the Script tab's rejoin ramp is the cool-down,
// seconds long and started by the edge itself (engine.js), and this
// minutes-long one would only be a second clock nothing reads.
export function cooldownEligible({ activeMode, orgasmMode = false, sessionStatus } = {}) {
    return sessionStatus === 'RUNNING' && !orgasmMode && activeMode !== 'script' && COOLDOWN_MODES.includes(activeMode);
}

// One event of the cool-down counter, called on every edge release, on every
// resume from an edge pause and once a second with no event, to expire it.
// `prev` is { count, startedAt }: the edges counted this session and the
// session second the running cool-down began, or null. A counted edge that
// lands on the chosen rhythm starts a cool-down at this second, restarting
// one already running: the pulse was just at the mark again, so the easing
// begins again from its slowest point. The count is kept whatever the
// length setting says, so the rhythm the wearer chose is measured from the
// first edge of the session and not from the moment a cool-down first ran.
export function tickCooldown(
    prev,
    { event = null, countsAsEdge = true, sessionSeconds, minutes, every, eligible = false } = {}
) {
    const count0 = prev && Number.isFinite(prev.count) ? Math.max(0, Math.round(prev.count)) : 0;
    const t = Number.isFinite(sessionSeconds) ? sessionSeconds : null;
    const length = cooldownLength(minutes);
    let startedAt = prev && Number.isFinite(prev.startedAt) ? prev.startedAt : null;

    // Expire: the cool-down has run its length, or nothing can say where it
    // stands (Off, a stored start after the present, no clock). A cool-down
    // with an end nobody can compute is dropped rather than left to hold the
    // toys slow, and one stamped in the future is dropped rather than kept
    // to spring on the wearer minutes later.
    if (startedAt !== null && (length === null || t === null || t < startedAt || t - startedAt >= length)) {
        startedAt = null;
    }

    let count = count0;
    let justStarted = false;
    if (COOLDOWN_EVENTS.includes(event) && countsAsEdge && eligible) {
        count += 1;
        const rhythm = COOLDOWN_EVERY_OPTIONS.includes(every) ? every : DEFAULT_COOLDOWN_EVERY_EDGES;
        if (count % rhythm === 0 && length !== null && t !== null) {
            startedAt = t;
            justStarted = true;
        }
    }
    return { count, startedAt, justStarted };
}

// How far into the running cool-down this second is: the number the engine
// takes as `cooldownSeconds`. null means no cool-down is in force, which the
// engine reads as "the factors are 1". It is null, and never a guess, when
// there is no start, when the length is Off or junk, when the start lies
// after the present, and once the length has run out - so the engine is
// never handed a second that warmupShape would read as its slowest point.
export function cooldownSecondsFor({ startedAt, sessionSeconds, minutes } = {}) {
    const length = cooldownLength(minutes);
    if (length === null || !Number.isFinite(startedAt) || !Number.isFinite(sessionSeconds)) return null;
    const elapsed = sessionSeconds - startedAt;
    if (elapsed < 0 || elapsed >= length) return null;
    return elapsed;
}

// The cockpit badge, as pure text: the time the cool-down has left, in the
// warm-up badge's own m:ss form, or '' when none is running so the caller
// hides it. It never reads 0:00 - the second the length runs out the
// cool-down is over and the badge is gone.
export function describeCooldownBadge({ startedAt, sessionSeconds, minutes } = {}) {
    const elapsed = cooldownSecondsFor({ startedAt, sessionSeconds, minutes });
    if (elapsed === null) return '';
    const left = Math.ceil(minutes * 60 - elapsed);
    return `COOL-DOWN ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

// ---- Persisted Session Setup values ---------------------------------------

// Resting / Climax HR, the duration window and the Endgame Trigger are typed
// into plain inputs and are remembered between sessions like every other
// setting. A STORED value is never trusted more than a typed one: it goes
// back through the same validators (sanitizeHrLimits, parseSessionDuration)
// on the way in AND on the way out, so a corrupt or hand-edited store can
// only ever restore limits the wearer could have typed themselves.
export const DURATION_MODES = ['fixed', 'range', 'endless'];
export const ENDGAME_TYPES = ['orgasm', 'rampdown', 'denial'];
export const DEFAULT_DURATION_MODE = 'range';
export const DEFAULT_FIXED_MINUTES = 30;
export const DEFAULT_RANGE_MIN_MINUTES = 25;
export const DEFAULT_RANGE_MAX_MINUTES = 45;
export const DEFAULT_ENDGAME_TYPE = 'orgasm';

// The typed HR pair, clamped for storage by exactly the validator the typed
// fields already go through: a stored pair is never treated more harshly, or
// more leniently, than one the wearer types, so what comes back after a
// reload is the pair they left. A pair sanitizeHrLimits refuses (either field
// outside 30-250, or a ceiling at or below the resting rate) falls back to
// the factory pair rather than being repaired into something nobody chose.
// A narrow but legal pair is restored as typed and NOT widened: the release
// band is the engine's business (resolveEdgeTriggerHr simply pulls back at
// the ceiling when the band is too tight) and MIN_CEILING_GAP is enforced
// where it belongs, inside computeEffectiveCeiling, which only ever lowers
// the working ceiling. Moving the Resting HR here would quietly change a
// setting the wearer typed - and widening the tease band raises the rising
// secondary channel (`20 + progress * 80`) at every heart rate.
export function sanitizeStoredHrLimits(rawMin, rawMax) {
    const limits = sanitizeHrLimits(rawMin, rawMax, { minHr: DEFAULT_MIN_HR, maxHr: DEFAULT_MAX_HR });
    if (!limits.valid) return { minHr: DEFAULT_MIN_HR, maxHr: DEFAULT_MAX_HR };
    return { minHr: limits.minHr, maxHr: limits.maxHr };
}

// The duration window, validated by the same parser the Session Setup fields
// go through at START. A length that parser refuses falls back to the factory
// one for that field; an unknown mode falls back to Mystery.
export function sanitizeStoredDuration({
    durationMode,
    durationFixedMinutes,
    durationMinMinutes,
    durationMaxMinutes
} = {}) {
    const fixedOk = parseSessionDuration({ mode: 'fixed', fixedMinutes: durationFixedMinutes }).valid;
    const rangeOk = parseSessionDuration({
        mode: 'range',
        minMinutes: durationMinMinutes,
        maxMinutes: durationMaxMinutes,
        random: () => 0
    }).valid;
    return {
        durationMode: DURATION_MODES.includes(durationMode) ? durationMode : DEFAULT_DURATION_MODE,
        durationFixedMinutes: fixedOk ? toInt(durationFixedMinutes) : DEFAULT_FIXED_MINUTES,
        durationMinMinutes: rangeOk ? toInt(durationMinMinutes) : DEFAULT_RANGE_MIN_MINUTES,
        durationMaxMinutes: rangeOk ? toInt(durationMaxMinutes) : DEFAULT_RANGE_MAX_MINUTES
    };
}

export function sanitizeStoredEndgame(value) {
    return ENDGAME_TYPES.includes(value) ? value : DEFAULT_ENDGAME_TYPE;
}

// One entry point for the whole set, used on load, on every write and on
// import, so the stored form and the typed form can never drift apart. It is
// idempotent: sanitizing an already sanitized set returns it unchanged.
export function sanitizeSessionLimits(stored = {}) {
    return {
        ...sanitizeStoredHrLimits(stored.minHr, stored.maxHr),
        ...sanitizeStoredDuration(stored),
        endgameType: sanitizeStoredEndgame(stored.endgameType)
    };
}
