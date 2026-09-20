# Changelog

All notable changes to EdgeLoop are documented here. Entries are grouped by
the area of the app they touch; forum reports that prompted a change are
credited by username.

## Unreleased

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
  the game on one spike; Oracle purgatory no longer counts phantom edges;
  cancelling Force Orgasm after an Oracle climax withdraws the climax and
  the ceiling rule applies again; pausing during Soft Landing resumes it.
- Stall guard stops only the primary channel, as the UI states; it is
  released at once when it is switched off, Full Stop is selected or Force
  Orgasm starts. Two timers: how long you may stay at the pullback mark
  (3-120 s, default 20) before the primary is cut, and how long that halt
  lasts (2-60 s, default 8) before crawl resumes and the hold window
  restarts. The Guards toggle turns the auto-cutoff off entirely.
- Pullback is a percent of typed Climax HR (90-115, default 100): 95%
  pulls back early, 105% holds a little past the typed max. A saved 0-15
  offset from the previous build is migrated to 100-115.
- The endgame (Orgasm / Soft Landing / Denied) fires once per session, so
  Force Orgasm stays a toggle the wearer can cancel after the target time.
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

### Voice, microphone, chart and sharing
- Voice cues are queued instead of cancelling each other; safety cues jump
  the queue; identical back-to-back cues are dropped.
- The microphone monitor starts from a user gesture (a "tap to re-enable"
  button appears when the browser withholds the permission) and its boost
  is clamped to the effective ceiling. Session Setup has a live meter, a
  Test button and a noise-gate slider; the sampler uses the 250-4000 Hz
  voice band so toy motors do not trip it.
- The telemetry chart sizes itself from its box and the device pixel ratio,
  so it is crisp on phones and never wider than the layout, and its scale
  always includes the Climax HR line.
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
