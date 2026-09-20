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
  motor after a stop. An offline Handy is detected mid-session and the
  session pauses.
- Full Length Strokes respects the hardware travel envelope; envelope inputs
  are validated and the upper bound is no longer locked at 60% (SDuna).

### Session engine and lifecycle
- Force Orgasm is a boost on the working ceiling and is always cleared by
  STOP and Reset; the typed Climax HR is never rewritten.
- STOP resets the clock, edge and pause counters after saving history, so
  the next session never inherits them.
- Adaptive Ceiling Decay can no longer raise the ceiling above the typed
  Climax HR through its floor (X333, Umbra250).
- Survival mode needs three consecutive breach readings; Oracle purgatory
  no longer counts phantom edges; pausing during Soft Landing resumes it.
- Stall guard stops only the primary channel, as the UI states.
- Stroke zones keep a minimum width; Head Play during warm-up can no longer
  collapse the stroke.
- Funscript export produces real stroke actions from the recorded speed and
  zone instead of writing the speed percentage as a position.
- Storage is corruption-safe and trims the oldest history on quota errors.

### Heart-rate monitor and watchdog
- Short signal gaps hold the last valid reading instead of pausing; the
  signal-loss timeout is configurable (3-20 s, default 8 s) and the session
  can resume automatically when readings return (tsuriley, X333).
- Readings below 35 BPM no longer count as silence; sensor-contact bits
  are parsed and poor contact is shown.
- A dropped Bluetooth link is retried three times before it is reported.
- Clear guidance when Web Bluetooth is unavailable, including the Chrome
  flag needed on Linux (Jalex).
- The remote-controller page only renders telemetry and sends transport
  commands to the host.

### Project
- `npm test` runs the unit tests (169 at the time of writing) and a GitHub
  Actions workflow runs them on every push and pull request.
- Manifest and service-worker paths are relative so the app also works
  when hosted under a sub-path such as GitHub Pages.
