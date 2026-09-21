# Changelog

All notable changes to EdgeLoop are documented here. Entries are grouped by
the area of the app they touch; forum reports that prompted a change are
credited by username.

## Unreleased

### Games
- **Edge Training** pulls you to the ceiling and treats a timed hold as the
  goal (stall guard is off). Drop before the hold finishes and it does not
  count; after the typed number of successful edges it Force-Orgasm finishes
  you. Hold length (5-90 s, default 15) and edge count (1-20, default 5)
  sit on the game card.
- **Edge Training** and Force Orgasm no longer fight each other. Tapping
  Force Orgasm suspends the training instead of completing it: the edge
  counter stays where it was (it used to jump straight to N/N and report
  every edge as held, even on the first second of the game), and the hold
  clock is frozen rather than advanced. Cancelling Force Orgasm hands the
  game back exactly as it was; cancelling it after the training finished
  returns the game to the climb, the way withdrawing an Oracle climax
  does, instead of leaving the primary at 100% in a state the session
  could never leave.
- Cancelling Force Orgasm after an **Edge Training** run has finished
  starts a fresh set: the counter goes back to 0/N. It used to stay at
  N/N, so the next completed hold (15 s by default) armed Force Orgasm
  again all by itself, seconds after you had deliberately cancelled it,
  and the card read N+1/N. Say no and the whole training has to be earned
  again before it offers to finish you.
- The Oracle no longer rolls climax or denial on the first edge. Mystery
  keeps those endings locked until the minimum and a Fixed length until
  halfway through it; inside the window later holds are more likely to end
  you; the target is the latest it will wait. Endless still has no minimum.
- A **Fixed** duration no longer neuters The Oracle. Fixed handed it a
  window of zero width, so every 15 s hold for the whole session came back
  NOT YET - KEEP CLIMBING and the game never chose anything at all: climax
  and denial now unlock halfway through the fixed length and grow likelier
  the nearer it gets. A Mystery roll that happens to land on its own
  minimum gets the same window instead of the same dead session.
- The Oracle honours **Soft Landing**. When the target time forces an
  ending it now hands the session to the 45 s tease-down you picked.
  Soft Landing matched neither of the two cases the roll knew, so the
  choice fell through to a coin flip that could arm Force Orgasm - motors
  at 100% with the working ceiling climbing - for the wearer who had asked
  for the gentlest ending. Climax and Strict Denial are unchanged.
- **Edge Training** obeys your "At the ceiling" setting. A training hold is
  a hold at the pullback mark, so Full Stop parks the primary at 0% there
  and Crawl keeps its 10%; the hold used to run 14% whichever you picked,
  which is more motion than the Crawl some people avoid on purpose, for
  the full 5-90 s and on every edge of the set. The secondary channel is
  unchanged, and Force Orgasm still overrides both.

### The Handy
- Connect now selects HAMP mode (mode 0). The driver previously selected
  HSSP (mode 1), which the Handy API v2 spec documents as script streaming.
- The stroke range is sent to `PUT /slide`. It was sent to a non-existent
  `/hamp/stroke` endpoint, so Head Play, Glans Protector, the warm-up
  envelope, the travel envelope and Full Length Strokes never reached the
  device (reports by Canoe and Mike650vtwin about aggressive starts).
- Every API reply is checked (HTTP status, error object, result code) and
  failures are shown in the Handy modal and the connection badge.
- STOP is confirmed and retried; a late start can no longer restart the
  motor after a stop, whichever path issued that stop (STOP, Disconnect, an
  offline verdict, or a start that timed out on our side), and the stop
  goes to the key the start was issued with. An offline Handy is detected
  mid-session (five failed dispatch ticks, not five failed requests) and
  the session pauses; the device then keeps receiving stops in the
  background until one is confirmed.
- Connect with a new key (or the same one after an API error) verifies the
  key first and brings the connected device to a confirmed stop before the
  link is switched; if either fails the current connection, and every STOP
  path to it, is left untouched. A stop still in flight for a previous key
  never masks a stop for the current device.
- Disconnect resolves only when its stop is confirmed and says so in the
  modal, the badge and the banner when it is not; an unconfirmed stop on
  any path is reported the same way. Closing or freezing the page sends a
  keepalive stop.
- The stroke range is confirmed by `PUT /slide` before `PUT /hamp/start`,
  so the first strokes can never run at a range the device still held from
  a previous session.
- An API error is only cleared by a later success on the same call, not by
  the 10 s connectivity poll or a slide reply, so a velocity call that
  keeps failing stays visible.
- Full Length Strokes respects the hardware travel envelope; envelope inputs
  are validated and the upper bound is no longer locked at 60% (SDuna).

### Intiface Central / Buttplug.io
- Linear axes (OSR2, SR6, OSSM and other strokers exposed by Intiface) are
  driven by a per-axis stroke planner: one `LinearCmd` per stroke leg
  carrying the full leg duration, nothing re-sent while a leg is in flight,
  speed and zone changes applied to the next leg. The 200 ms polling loop
  that re-sent hold commands, and produced the jerky bursts klozzie0
  recorded on his TCode stroker, is gone.
- Connection state is real: the modal label walks Offline, Connecting,
  Handshake, Connected (server name, N devices) or the error text instead of
  staying on "Offline" while connected (klozzie0). A second Connect closes
  and detaches the previous socket; a 5 s handshake timeout and URL
  validation (`ws://` or `wss://` only) replace silent hangs.
- Ping honours the server's `MaxPingTime`; `Error` replies are shown and an
  axis that fails three commands in a row is flagged; `ScanningFinished`
  ends the scanning hint; the battery sensor is read at its real index.
- OFF axes get a single rest move (or zero) and then nothing; switching an
  axis OFF interrupts the stroke in flight instead of letting it finish.
  `StopAllDevices` is sent on STOP, pause, disconnect and page unload.
- The first stroke after a rest or a zone shift is timed for the distance
  it really travels, so resuming from the envelope bottom into a short zone
  is a proportionally longer move, not a snap.
- Roles, caps, linear invert and the rotation settings are remembered per
  toy (Save & Apply now really saves). Rotators can alternate direction
  every N seconds (5-60) in addition to reversing on an edge (SDuna).
- A failed connect no longer pauses a session running on other hardware.

### TCode Serial (OSR2 / SR6 / OSSM)
- New "TCode Serial" device card: OSR2, SR6, OSSM and other T-Code v0.3
  strokers connect straight over their USB serial port (Web Serial, 115200
  8N1) without Intiface Central, which exposes an OSR2 as a single linear
  axis (requested by dapo, NikolaiX and Redbird). The device is identified
  with D0 / D1 / D2; a silent device falls back to the L0 / R0 / R1 / R2 / V0
  set. Every axis has a Primary / Secondary / OFF role, a cap, a Test button
  and (linear axes) an invert switch; settings are remembered per device
  name. L0 is Primary and V0 Secondary by default, everything else OFF.
  A device that does not answer D0 is named after its USB vendor and
  product id (for example "TCode device 1a86:7523") so two silent rigs do
  not share one saved mapping; a mapping saved under the old plain name
  must be assigned once more.
- Linear and rotation axes use the shared stroke planner (one command per
  leg, nothing re-sent mid-leg); rotation axes swing around centre by the
  engine speed, with a swing period set by the speed alone (a small swing is
  a slow swing, not a fast twitch). STOP, pause, Reset and every disconnect
  alert bring all axes to rest on one line; an unplugged device or a failed
  write pauses the session. Browsers without Web Serial get a clear message,
  and desktop Chrome / Edge on a plain `http://` origin is told about the
  secure-origin rule instead.
- Surge and sway (L1 / L2) rest at and swing around the mechanical centre;
  only L0 is mapped onto the stroke envelope, so an SR6 is no longer driven
  into a corner on connect, STOP or when those axes are OFF.
- Disconnect refuses every motion command while the rest line is being
  flushed, so an engine tick landing in that window can no longer put a
  motor command behind the rest line as the last thing the device hears.
- The port is given time to settle after opening (boards that auto-reset on
  DTR print a boot banner first), a swallowed D0 is asked once more, and a
  boot banner is never taken for the device name or version.

### Session engine and lifecycle
- Force Orgasm is a boost on the working ceiling and is always cleared by
  STOP and Reset; the typed Climax HR is never rewritten.
- STOP resets the clock, edge and pause counters after saving history, so
  the next session never inherits them.
- Adaptive Ceiling Decay can no longer raise the ceiling above the typed
  Climax HR through its floor (X333, Umbra250).
- Survival mode needs three consecutive breach readings, counted per new
  reading rather than per second, so a watch pushing every 5 s cannot end
  the game on one spike; Oracle purgatory no longer counts phantom edges
  (it judged the release against the ceiling instead of the pullback mark,
  so with a pullback under 100% it counted one invented edge per cycle and
  Adaptive Ceiling Decay quietly dragged the ceiling down with it);
  cancelling Force Orgasm after an Oracle climax withdraws the climax and
  the ceiling rule applies again; pausing during Soft Landing resumes it.
- Stall guard stops only the primary channel, as the UI states; it is
  released at once when it is switched off, Full Stop is selected or Force
  Orgasm starts. Two timers: how long you may stay at the pullback mark
  (3-120 s, default 20) before the primary is cut, and how long that halt
  lasts (2-60 s, default 8) before crawl resumes and the hold window
  restarts. The Guards toggle turns the auto-cutoff off entirely.
- Pullback is a percent of typed Climax HR (90-100, default 100): 95%
  pulls back early. The range no longer goes above 100%. Values over 100
  put the pullback mark, and with it Crawl / Full Stop and the stall
  timers, above the Climax HR you typed: at 115% the strokers were still
  running at 41-61% as the pulse crossed your ceiling and nothing armed in
  that band. Your typed Climax HR is a hard ceiling, so the pullback can
  only ever sit at it or below it; a saved value above 100 (or the 0-15
  offset migrated from an older build) now behaves as 100.
- The pullback mark is also kept above your Resting HR, far enough to
  leave its 5 BPM release band. With a narrow pair such as Resting 70 /
  Climax 75, 90% used to land at 68 BPM: the session latched edged on the
  first reading and could never release. Such a pair now simply pulls back
  at the ceiling.
- The endgame (Orgasm / Soft Landing / Denied) fires once per session, so
  Force Orgasm stays a toggle the wearer can cancel after the target time.
  It is now deferred only while an orgasm is actually in progress: an Edge
  Training run that had finished used to suppress the endgame for the rest
  of the session, so a timed session never ended by itself.
- The Session Setup pullback preview quotes the number the session really
  uses. It took the percentage from the typed Climax HR while the engine,
  the HOLD TO badge and the guards take it from the working ceiling, so
  with a secondary toy connected (dual-stim dampening is on by default)
  the panel promised "Pullback at 147 BPM" for a session that pulled back
  at 131. When the working ceiling differs from the number you typed the
  preview now says so.
- Importing the same settings file twice works (the file input is cleared
  after each import).
- Stroke zones keep a minimum width; Head Play during warm-up can no longer
  collapse the stroke.
- Glans Protector now does what its card promises: full-length strokes at
  rest contracting toward base micro-strokes (0-35%) at the ceiling.
- Full Stop vs Crawl (10%) at the ceiling is an explicit setting on the
  Guards tab instead of an implicit mode behaviour; Force Orgasm overrides
  both.
- Funscript export produces real stroke actions from the recorded speed and
  zone instead of writing the speed percentage as a position.
- Storage is corruption-safe and trims the oldest history on quota errors;
  every remaining `localStorage` access in the app goes through the same
  helpers.

### Heart-rate monitor and watchdog
- Short signal gaps hold the last valid reading instead of pausing; the
  signal-loss timeout is configurable (3-20 s, default 8 s) and the session
  can resume automatically when readings return (tsuriley, X333).
- START and RESUME need a usable reading younger than the timeout (and a
  toy), from the cockpit and from a remote controller alike: the transport
  shows WAITING FOR PULSE / WAITING FOR HR SENSOR instead, and the watchdog
  clocks are no longer reset on resume, so a resume can never drive the
  toys on a frozen heart rate. Engaging the simulator during a watchdog
  pause keeps the session paused until RESUME is pressed, and the HR card
  keeps showing the simulator when the Bluetooth modal or a cancelled scan
  reports that Web Bluetooth is unavailable.
- Readings below 35 BPM no longer count as silence; sensor-contact bits
  are parsed and poor contact is shown.
- A dropped Bluetooth link is retried three times before it is reported.
- Clear guidance when Web Bluetooth is unavailable, including the Chrome
  flag needed on Linux (Jalex).

### Remote control
- PeerJS error, close and disconnected events are handled on both sides: a
  dropped link is shown as disconnected, never as connected; a replaced
  controller is closed; a missing PeerJS script is reported instead of
  failing silently.
- Every inbound message is validated and clamped (`peer-messages.js`). A
  controller may only send transport, Force Orgasm and mode commands, never
  limits or raw speeds; a viewer may only ping; host telemetry is coerced
  before it touches the remote page.
- The remote-controller page only renders telemetry and sends transport
  commands to the host; its host-only controls (Came Early, intensity, Full
  Length Strokes, the hardware cards, Share Control, Session Setup) are
  locked rather than left looking clickable, and the first-run wizard no
  longer opens on remote pages. The group link (`?group_sub=`) opens a
  read-only viewer page with every control locked.
- The two **Edge Training** numbers (hold length and edge count) are
  host-only and are locked on the controller and the viewer page. They sit
  inside the mode card, and a disabled card does not stop a browser from
  typing into them: the partner could set 90 s and 20 edges, see them stick
  on their own screen and in that device's own saved settings, while the
  wearer's host went on running its own 15 s and 5.
- Telemetry carries the pullback mark, so a remote chart draws the host's
  real purple line. It was drawn at a hardcoded 140 BPM: a host edging at
  a Climax HR of 92 showed the partner a pullback line 48 BPM above the
  ceiling line, and a host that really did pull back early showed none.

### Voice, microphone, chart and sharing
- Voice cues are queued instead of cancelling each other; safety cues jump
  the queue; identical back-to-back cues are dropped.
- The microphone monitor starts from a user gesture (a "tap to re-enable"
  button appears when the browser withholds the permission) and its boost
  is clamped to the effective ceiling. Session Setup has a live meter, a
  Test button, a noise-gate slider, and a **louder → closer** cap (0-20
  extra BPM, default 8, 0 = listen only). Louder voice/panting above the
  gate raises the working heart rate so the loop treats you as nearer the
  edge; the cockpit shows MIC +N while it is boosting. The sampler uses
  the 250-4000 Hz voice band so toy motors do not trip it.
- The microphone boost now moves the toys and nothing else. It used to be
  added into the heart rate every guard, game and counter judged, so a
  loud room could count edges, complete Edge Training and arm Force
  Orgasm by itself (with a real pulse of 132, a typed Climax of 150 and a
  20 BPM cap, room noise finished the training and took the working
  ceiling to 210), end a Survival run, and be stored as the session peak.
  The BPM readout, the edge counter, the Oracle, Survival, Edge Training,
  the stall guard and the saved record all read the pulse your monitor
  measured; only the speed curve sees the boost. It is also no longer
  added while the signal watchdog is holding a reading, so the engine
  cannot climb on sound during a dropout.
- The microphone is now captured with the browser's own audio processing
  asked OFF (noise suppression and automatic gain control; echo
  cancellation stays on). Both are on by default in Chrome and Firefox,
  and gain control alone moves gain at about 6 dB per second, which wipes
  out a 20 dB build-up in roughly three seconds - the feature was
  measuring exactly what the browser was deleting, and noise suppression
  is tuned to keep speech and throw breathing away. The request is a
  preference, never a demand, so a browser that cannot honour it still
  gives you a microphone. When it refuses (or will not say, as Safari
  does), the Audio & Mic panel says so: your noise gate then means
  something different, because it is calibrated against a processed
  signal.
- The microphone no longer hears the app's own voice. Every spoken cue
  lands in the same 250-4000 Hz band the meter listens to, and on
  speakers the echo canceller has no reference for it, so each cue read
  as +6 to +8 BPM of arousal. While EdgeLoop is speaking, and for a short
  moment afterwards, the last measured level is held instead. A held level
  keeps its boost for ten seconds at most: on a browser that leaves its
  "still speaking" flag stuck the microphone drops to zero rather than
  driving the toys from a room nobody is listening to any more.
- The noise gate and the extra-BPM cap the running session uses are the
  ones you pressed **Apply** on. Dragging either slider and dismissing
  Session Setup without applying used to change the live session; it now
  only previews on the meter.
- The microphone boost is cleared by STOP, Reset, PAUSE, switching the
  monitor off and the monitor dying. It used to survive all of them, so a
  boost measured before a stop was still being added to the speed curve
  afterwards.
- A microphone that is revoked, unplugged or taken by another app is
  reported in the banner instead of being read as silence: the boost goes
  to zero, the badge goes dark and the "tap to re-enable microphone"
  control comes back. It used to keep the badge lit with the last boost
  latched.
- The **MIC LISTEN** badge no longer sticks on the cockpit forever after
  using **Test microphone** with the monitor switched off, and the live
  meter no longer re-runs the engine from its animation frame: the boost
  is read once a second with the rest of the session tick, so sound alone
  can never move the toys between heart-rate readings.
- The **MIC +N** badge shows the boost that is actually reaching the toys,
  and goes back to MIC LISTEN whenever none is (the watchdog is holding a
  reading, or your pulse is already at the ceiling). The big BPM number no
  longer moves with the boost, so the badge is the only place you see it
  and it has to be honest.
- Spoken Voice Guidance shows the current cue on the dashboard and speaks
  it. Each event is a list of phrases (one per line, randomly rotated).
  Phrase files can be imported/exported on the Audio tab and are included
  in the full settings backup. Banks are grouped: build-up encouragement
  on a timer, hitting the edge, Force Orgasm / make you come, and Came
  Early / premature ejaculation. Tapping Force Orgasm (or the orgasm
  endgame) speaks the climax bank; Came Early speaks the premature bank
  as the session stops. Oracle climax keeps its own lines so two cues do
  not stack.
- Phrase-file sections are read whatever their case or spacing: `# Edge`,
  `[Force Orgasm]` and `# forceorgasm` all land in the bank you meant. A
  header that capitalised the way English capitalises headings used to be
  filed as a phrase, so the whole file became one giant Build-up bank and
  the header lines themselves were spoken back at you. A section that
  names no cue EdgeLoop knows is now refused with a message naming it,
  and nothing is imported.
- The phrase boxes only reach the running session through **Apply**.
  Tapping **Speak**, **Preview** or **Export phrases** used to commit
  whatever was typed, so trying a line out and then dismissing Session
  Setup with the X left the edit live and saved it at the next change.
- **Import phrases** now tells you what happened: how many lists were
  imported, a file that could not be read, and a browser that refused to
  save them. It also reads the encouragement interval back out of a
  phrase file, so `0 = off` survives an export/import round trip.
- Backup **Export (.json)** carries the phrase edits that are on screen,
  the way the panel says it does. Editing phrases and exporting a backup
  in the same visit (no Apply in between) used to write the old lists.
- **Reset defaults** asks before wiping all 28 banks, and saves the
  result. It used to restore the factory lines in memory only, so the
  next unrelated save could bring the custom phrases back, or take them
  away long after you pressed it.
- Clearing a phrase box now mutes that cue (the label reads *muted*)
  instead of quietly restoring the factory lines. A cue a file does not
  mention still falls back to the factory lines.
- The telemetry chart sizes itself from its box and the device pixel ratio,
  so it is crisp on phones and never wider than the layout, and its scale
  always includes the Climax HR line.
- The purple pullback line is drawn whenever the mark is not the ceiling,
  which is what the Guards tab and the HOLD TO badge promise. It was only
  drawn for a mark ABOVE the typed Climax HR, so with the pullback capped
  at 100% it had stopped appearing at all: a 95% pullback showed the badge
  and no line.
- Copy-link buttons fall back to a hidden field and `execCommand('copy')`
  when the Clipboard API is unavailable (plain `http://` hosting) and never
  throw.

### Project
- `npm test` runs the unit tests (about 330 at the time of writing) and a GitHub
  Actions workflow runs them, plus `node --check` on every module, on every
  push to `main` and on every pull request.
- `npm run smoke` (`tools/smoke.js`) drives the real app in headless
  Chromium through every modal and page, runs a full session on a mocked
  Handy API (START / PAUSE / RESUME / STOP / Reset, with the API calls
  asserted) and checks the History entry it leaves, and reports console
  errors, failed requests and broken assertions as JSON.
- The service worker is now network-first with a cache fallback, so a
  deployed update is picked up on the next load while the cockpit still
  opens offline, and it is actually registered on secure origins (https or
  localhost).
- Manifest and service-worker paths are relative so the app also works
  when hosted under a sub-path such as GitHub Pages.
