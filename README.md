# EdgeLoop: Autonomous Biofeedback Edging System

EdgeLoop is an open-source, client-side biofeedback edging engine that links Bluetooth heart rate monitors to teledildonic hardware, automatically modulating stimulation in real time to keep you balanced right on the edge.

---

## Why I Built EdgeLoop

I built EdgeLoop because I constantly found long videos I wanted to experience with my Handy, but most of them had no funscripts—and the hand-coded scripts that did exist rarely worked for my body. Everyone’s physical sensitivity, threshold, and anatomy are different. With static scripts tailored to someone else, I constantly ran into two extremes: either the script moved too fast and I couldn't last through the video, or it moved too slow and couldn't even keep me erect.

Trying to manually adjust speed sliders while kicking back in my recliner watching a screen on my TV or inside a VR headset completely shatters the immersion. I wanted something that would drive my toys without needing hand-coded scripts, while still introducing an element of surprise. Having the toy react unpredictably to my real-time heart rate turned out to be just as exciting as a hand-crafted script. Because an automated biofeedback loop never gets tired and never stops paying attention, it became the only reliable way I could last as long as I wanted.

Most importantly, **this isn't just for people using The Handy.** I wanted EdgeLoop to work with and for everyone—supporting all toys across all anatomies and sexes.

I also see a ton of different ways people can use this app beyond solo play. If you have a partner online or in real life, you can dial in the session settings for your subject's specific body and toys. That frees up the partner to split their attention—carrying on a conversation, teasing, or handling other play—while EdgeLoop autonomously manages the physical edging threshold in the background.

---

## Special Thanks & Credits

A massive shoutout and credit goes to **@zflippz** on the Handy Discord / Control server. Testing his early implementation of heart-rate biofeedback gave me the inspiration and confidence to dive in and take this concept in my own direction. EdgeLoop truly would not have happened without his initial work and encouragement.

---

## What the App Does Today

EdgeLoop runs 100% locally in your web browser with zero accounts, zero subscriptions, and zero cloud tracking:

* **Adaptive Biofeedback Core:** Uses a convex power curve that keeps speeds active and engaging during mid-arousal, only backing off sharply in the final heart rate window before your climax ceiling. Includes a 5 BPM recovery buffer (hysteresis) and a selectable peak behavior (Full Stop or a gentle Crawl).
* **Session Guards:** Signal watchdog, stall guard, dual-stimulation dampening and adaptive ceiling decay. They are described one by one in [Session guards](#session-guards) below.
* **Experience Modes & Games:** Selectable profiles like Classic Tease, Prostate Milker (cross-fader), Glans Protector, and Ultimate Milker, alongside interactive challenges like *The Oracle* (decision gate) and *Survival Mode*.
* **Session Telemetry & Funscript Export:** Automatically logs session metrics and exports dual-channel `.funscript` (primary stroker) and `.v0.funscript` (secondary vibrator) files directly to your machine for replay in external players like ScriptPlayer or HereSphere.
* **Remote Partner Control & Viewers:** Peer-to-peer WebRTC room links let one partner anywhere in the world manage the session remotely (transport, Force Orgasm, mode), while any number of read-only viewers watch the live heart-rate telemetry. Every inbound message is validated; a dropped link is shown as disconnected, never as connected.
* **Broad Protocol Support:** Direct connection to BLE heart rate monitors (standard 0x180D GATT service), The Handy (Wi-Fi HAMP API), T-Code strokers (OSR2, SR6, OSSM) straight over their USB serial port via Web Serial, and Buttplug.io / Intiface Central for vibrators, reciprocating sex machines, and rotational devices.

### What changed since v1.0

Everything that landed after the v1.0 write-up, from the Handy protocol fix to the direct T-Code driver, the smooth Intiface strokes and the heart-rate watchdog, is listed in [CHANGELOG.md](CHANGELOG.md), grouped by area and credited to the forum reports that prompted each change.

---

## Hardware Reality & My Personal Daily Setup

There are far more toys, heart rate monitors, and device combinations than any single person could possibly own or test.

For transparency, **my personal daily-driver setup** is:

* **Viewing Environment & Media:** Kicking back in my recliner in the living room, watching videos directly on my TV or immersed in my VR headset.
* **Host Device:** Google Pixel Tablet set up in horizontal/landscape mode next to me, running EdgeLoop in Chrome and Intiface Central directly on the tablet to manage Bluetooth toys.
* **Primary Stroker:** The Handy connected over Wi-Fi.
* **Heart Rate Monitor:** Google Pixel Watch 2 broadcasting live heart rate over Bluetooth.
* **Development Environment:** EdgeLoop was coded and tested on Google Chrome across both Fedora 44 KDE Linux and Windows.

Because I don't own every commercial toy, chest strap, or operating system variant (macOS, iOS, Android, Linux, Windows), I can't guarantee out-of-the-box behavior for every edge case alone. As an open-source community, we can test and expand device coverage together. Future game and app integrations are on the long-term roadmap, but right now the focus is keeping the core engine dialed in, stable, and ready to grow.

---

## Heart-rate sources

EdgeLoop reads any device that advertises the standard Bluetooth **Heart Rate** service (GATT 0x180D). The table collects what people on the forum have reported so far; add your own findings through an issue or PR.

| Device | How it reaches EdgeLoop | Notes |
| --- | --- | --- |
| Google Pixel Watch / Pixel Watch 2 | Broadcasts heart rate over BLE natively | The author's setup. Turn on heart-rate broadcasting on the watch, then pair it from the EdgeLoop BLE modal. |
| Samsung Galaxy Watch | No native broadcast. The Wear OS app **Heart for Bluetooth** (recommended by forum user AtagoWTS) re-broadcasts the pulse as a standard HR service | One user got it working with EdgeLoop on a phone but not on a desktop; try the phone first. |
| Apple Watch | **HeartCast** or **Echo** can broadcast the pulse | iOS forbids a BLE central (the Bluefy browser) on the *same* iPhone from seeing a peripheral advertised by another app on that iPhone. Run EdgeLoop on a second device (PC, Mac or tablet), or pair a chest strap directly to Bluefy instead. |
| Chest straps: Polar H10, Coospo H6M, Cycplus H2 Pro, Garmin HRM, Wahoo TICKR | Standard BLE Heart Rate broadcast, pair straight from the BLE modal | The most reliable option. Polar H10 has the best cadence; the Cycplus H2 Pro costs around 30 USD. Wet the electrodes before a session. |
| Budget watches paired through the GloryFit / Da Fit apps | Not possible | These watches do not expose the standard Heart Rate service and cannot work with EdgeLoop (or any other BLE HR app). |
| No monitor yet | The **Manual Simulator** slider in the BLE modal | Lets you explore the engine and every mode without hardware. |

Browser requirements for the Bluetooth link:

* **Chrome, Edge or another Chromium browser** on Windows, macOS, Android or Linux. Firefox and Safari have no Web Bluetooth.
* **Linux:** enable `chrome://flags/#enable-experimental-web-platform-features` and use a native (non-Flatpak) browser install; Flatpak builds do not see the Bluetooth adapter.
* **iOS / iPadOS:** use the **Bluefy** browser; Safari cannot pair. Remember the same-iPhone limitation above.
* The page must be served over **https or localhost**; Web Bluetooth is refused on plain `http://`.

Watches and relay apps often update only every 2-5 seconds, so leave the signal-loss timeout (see [Session guards](#session-guards)) at 8 s or more for them. Chest straps update every second.

A note on limits: prostate-heavy sessions reach the edge at far lower heart rates than penile stroking, often in the 80s-90s. For those, set a tighter profile such as **Resting 65 / Climax 92-95** instead of the defaults.

---

## Connecting toys

Every toy has its own card on the cockpit; tap the card to open its modal. A toy needs a **role** (Primary, Secondary or OFF) before the session can start: Primary follows the stroke curve and the stroke zone, Secondary follows the vibration channel, OFF is ignored. Any number of toys can share a role.

### The Handy (Wi-Fi)

1. Put your **Connection Key** from handyfeeling.com into the Handy modal and press **Connect Handy**. The driver talks to the official API v2 in **HAMP** mode and checks every reply, so a wrong key, a sleeping Handy or an API error is shown in the modal status line and on the connection badge instead of failing silently.
2. Set the **Hardware Travel Envelope** (Min 0-90%, Max 10-100%) to the physical range your sleeve allows. Every stroke zone, including Head Play, Glans Protector, warm-up and Full Length Strokes, is scaled inside these bounds, so the sleeve can never slip out or jam at the base.
3. Pick the role and the **Max Speed Cap**. STOP is confirmed and retried, and an offline Handy is detected mid-session, which pauses the session; the device then keeps receiving stops in the background until one is confirmed, so a Wi-Fi blip cannot leave the motor running. Pressing **Connect Handy** again (a new key, or the same one after an API error) verifies the new key first and brings the connected device to a confirmed stop before the link is switched; if either fails the current connection is left as it was. **Disconnect** reports whether its stop was confirmed, and closing the tab sends a last stop.

### Intiface Central (Buttplug.io)

Intiface Central is the bridge for Bluetooth vibrators, rotators, reciprocating machines and (through its serial support) T-Code strokers.

1. Start Intiface Central and **start its server**. Add and connect your toys there first.
2. In the EdgeLoop Intiface modal, keep the URL at `ws://localhost:12345` (plain `ws://`, not `wss://`, for a local server) and press **Connect**. The status walks Offline, Connecting, Handshake and Connected (server name, N devices); an invalid URL, a stopped server or a stalled handshake is reported in the same line.
3. Every actuator is listed with an **axis role** (Primary / Secondary / OFF), a cap and a **Test** button. Stroke maps to Linear axes, twist and roll map to Rotate axes; assign leftover axes Secondary or OFF. Linear axes have an invert switch.
4. **Rotation options:** a rotator can **reverse on every edge** and/or **alternate direction every N seconds** (5-60).
5. Press **Save & Apply**. Roles, caps, invert and the rotation settings are **remembered per toy**, so a reconnect restores your mapping.

Linear axes are driven by a stroke planner that sends exactly one command per stroke leg, which is what makes OSR-class strokers move smoothly instead of in bursts. `StopAllDevices` is sent on STOP, pause, disconnect and when the page closes.

### TCode Serial (OSR2 / SR6 / OSSM without Intiface)

The TCode Serial card drives any T-Code v0.3 stroker straight over its USB serial port (115200 8N1), which gives you every axis rather than the single linear axis Intiface exposes.

* **Chrome or Edge on a desktop only** (Windows, macOS, Linux): Web Serial does not exist on phones, in Firefox or in Safari. Browsers without it get a clear message.
* **Close any other app that holds the COM port first:** Intiface Central, MultiFunPlayer, a serial monitor. Then press **Connect** and pick the port in the browser dialog.
* **Linux:** your user must be in the `dialout` group (`sudo usermod -aG dialout $USER`, then log out and back in).
* The device is identified with `D0` / `D1` / `D2`; a firmware that stays silent falls back to the common `L0 / R0 / R1 / R2 / V0` set. Every axis gets a **Primary / Secondary / OFF** role, a cap, a **Test** button and (linear axes) an invert switch. `L0` (stroke) is Primary and `V0` Secondary by default, everything else OFF. Rotation axes swing around centre by the engine speed. Settings are remembered per device name.
* STOP, pause, Reset and every disconnect alert bring all axes to rest on one line; an unplugged device or a failed write pauses the session.

---

## Session guards

The **Guards** tab of Session Setup holds every safety rule. They are independent of the selected mode.

* **At the ceiling: Full Stop vs Crawl.** What the strokers do while your pulse sits at the climax ceiling. *Full Stop* parks the primary at 0%; *Crawl* keeps a 10% micro-motion so the edge stays alive. Force Orgasm overrides both.
* **Prolonged Edge Auto-Cutoff (Stall Guard).** With Crawl selected, cuts the primary stroker from Crawl to 0% when your pulse stays parked at the ceiling for longer than the timeout (3-25 s, default 8). The secondary channel keeps running.
* **Heart-Rate Signal Watchdog (always on).** A short gap holds the last valid reading instead of dropping to 0, because watches and relay apps often update only every 2-5 s. When no usable pulse has arrived for the **signal-loss timeout** (3-20 s, default 8 s) every motor stops and the session pauses. Readings below 35 BPM are ignored rather than treated as silence, poor electrode contact is flagged, and a dropped Bluetooth link is retried three times (1 s, 2 s, 4 s) before it is reported as lost. START and RESUME (from the cockpit or a remote controller) need a usable reading younger than the timeout, so the transport reads WAITING FOR PULSE instead of driving the toys on a frozen heart rate; engaging the simulator during a watchdog pause keeps the session paused until you press RESUME.
* **Auto-resume when signal returns.** On by default: the session resumes by itself once readings are back. Off: it stays paused until you press RESUME.
* **Dual Stimulation Dampening.** When a secondary (prostate) toy is active alongside a stroker, the climax ceiling is offset down (5-30 BPM, default 15) to balance nerve summation. The cockpit shows a DUAL STIM badge while it applies.
* **Adaptive Ceiling Decay.** Every X edges (1-10, default 2) the ceiling drops by Y BPM (1-5, default 2) to counteract fatigue over a long session, down to a **floor** (80-130, default 105). The floor can *stop* the decay but can never *raise* the ceiling: if you typed a Climax HR below the floor, your value wins. No offset can push the working ceiling below Resting HR + 15 BPM or above the Climax HR you typed. The DECAY badge shows the amount currently applied.
* **Force Orgasm** is a temporary boost on the working ceiling; STOP and Reset always clear it and the typed Climax HR is never rewritten.

---

## Hosting your own copy

EdgeLoop is static files: no build step, no server code, no database. Any static host works.

* **Requirements:** the page must be served over **https** (or from `localhost` / `127.0.0.1` while developing). Web Bluetooth, Web Serial and the service worker all refuse a plain `http://` origin. The Tailwind and PeerJS scripts load from a CDN, so the first visit needs internet access; afterwards the service worker (network-first, cache fallback) lets the cockpit open offline.
* **Locally:** `npm start` (or `python3 -m http.server 8000`) in the repository root, then open `http://localhost:8000`.
* **GitHub Pages:** fork the repository, then *Settings > Pages > Build and deployment > Source: Deploy from a branch*, branch `main`, folder `/ (root)`. The manifest and service worker use relative paths, so the app works under the `https://<you>.github.io/edgeloop/` sub-path.
* **Cloudflare Workers:** the repository ships a `wrangler.jsonc` that serves the root directory as static assets with single-page-application fallback. `npx wrangler deploy` publishes it; connecting the repository to Cloudflare deploys every push to `main` automatically, which is how `edgeloop.app` is hosted.
* Anything else (Netlify, Vercel, nginx, a NAS): upload the repository as-is and make sure `index.html` is the root document.

Remember that the AGPL-3.0 (below) requires a modified copy that you host to publish its source under the same license.

---

## Open Source, Licensing, and How Forks Work

EdgeLoop is fully open source under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

**GitHub Repository:** [https://github.com/marshallmims/edgeloop](https://github.com/marshallmims/edgeloop)

**What the AGPL-3.0 license means for forks and credit:**

* **You are encouraged to build:** Anyone is welcome to fork the project, experiment, add new toy drivers, or build custom integrations.
* **Credit must be preserved:** Any forks or derivative works must retain the original copyright notice and credit the work that went into EdgeLoop.
* **Copyleft (No Privatization):** The AGPL-3.0 license prevents anyone from taking this code, modifying it, and turning it into a closed-source, proprietary, or paid product. Even if someone modifies EdgeLoop and hosts it on their own website, they are legally required to make their modified source code public under the same open license. Your contributions will always remain free and open.

---

## Project File Structure

The project uses modular, native JavaScript files without mandatory complex bundlers:

```text
edgeloop/
├── .github/
│   └── workflows/
│       └── test.yml            # GitHub Actions: node --check every module, then npm test on every push to main and every PR
├── CHANGELOG.md                # What changed since v1.0, by area, with forum credits
├── LICENSE                     # AGPL-3.0
├── README.md
├── icon.svg                    # App icon (manifest, PWA install)
├── index.html                  # Interface layout, cockpit panels, popup dialogs and the service-worker registration
├── manifest.json               # Web App manifest definitions (icons, standalone display)
├── package.json                # npm test / npm run smoke / npm start; no dependencies
├── sw.js                       # Service worker: network-first with cache fallback for offline use
├── wrangler.jsonc              # Cloudflare Workers static asset deployment configuration
├── tools/
│   └── smoke.js                # Headless-Chromium smoke test of the real UI (needs Playwright, see Development)
└── src/
    └── js/
        ├── app.js              # Main interface controller: connects on-screen controls to the engine, runs the 1-second clock loop, and manages menus
        ├── state.js            # Central memory store for settings, user preferences, and real-time session state
        ├── engine.js           # Biofeedback calculations: speed curves, recovery thresholds, and safety cutoffs
        ├── engine.test.js      # Node tests for every cockpit mode, stall/crawl, warmup, hysteresis, and Oracle/Survival
        ├── session-rules.js    # Pure session rules: effective ceiling (offsets, decay floor, overdrive boost), HR-limit and duration validation, Survival breach counter
        ├── session-rules.test.js
        ├── funscript.js        # Pure funscript builder: turns the 4 Hz speed/zone timeline into .funscript stroke actions and .v0.funscript vibration levels
        ├── funscript.test.js
        ├── storage.js          # Robust localStorage helpers: corrupt-JSON-safe reads, quota-safe writes, oldest-first history trimming
        ├── storage.test.js
        ├── hr-watchdog.js      # Pure heart-rate signal watchdog: ok / holding / stale verdicts, no-contact flag, one-shot trip and recovery
        ├── hr-watchdog.test.js
        ├── chart.js            # Telemetry graph: draws the 60-second real-time heart rate canvas line, sized from its box and the device pixel ratio
        ├── chart.test.js
        ├── webrtc.js           # Peer-to-peer networking for remote partner control (?partner=) and read-only viewers (?group_sub=)
        ├── peer-messages.js    # Pure validation of every message that crosses the WebRTC data channel, in both directions
        ├── peer-messages.test.js
        ├── voice.js            # Local text-to-speech prompts and optional microphone monitor
        ├── voice-queue.js      # Pure cue queue: dedupe, bounded backlog, safety cues jump the queue
        ├── voice-queue.test.js
        └── hardware/
            ├── ble.js          # Web Bluetooth driver for standard heart rate monitors: notifications, battery, automatic reconnect
            ├── ble-protocol.js # Pure GATT Heart Rate Measurement parser (BPM, sensor-contact bits, RR intervals), reconnect schedule, browser-support and error messages
            ├── ble-protocol.test.js
            ├── handy.js        # The Handy Wi-Fi API driver (HAMP mode, /slide travel range, verified replies, confirmed stop, offline detection)
            ├── handy.test.js
            ├── handy-protocol.js     # Pure Handy API v2 helpers: reply classification, velocity clamp, slide-range normalisation, battery parsing
            ├── handy-protocol.test.js
            ├── intiface.js     # Intiface / Buttplug.io WebSocket driver for multi-motor vibrators, strokers, and rotators; per-toy memory
            ├── intiface.test.js
            ├── buttplug-protocol.js  # Pure Buttplug v3 message builders / parsers (handshake, device attributes, errors)
            ├── buttplug-protocol.test.js
            ├── tcode.js        # Direct T-Code driver over Web Serial (OSR2 / SR6 / OSSM): identification, per-axis roles, caps, stop
            ├── tcode.test.js
            ├── tcode-protocol.js     # Pure T-Code v0.3 helpers: axis commands, D0/D1/D2 parsing, default roles, browser-support text
            ├── tcode-protocol.test.js
            ├── stroke-planner.js     # Pure per-axis stroke scheduler: one command per leg, rest move on stop
            └── stroke-planner.test.js
```

---

## Development

There is no build step and no dependency to install. Clone the repository, serve it (`npm start`) and edit; reload the page to see a change.

**Unit tests** (Node 22 or newer, no browser):

```bash
npm test
```

runs every `*.test.js` under `src/js/` with Node's built-in test runner (about 290 tests at the time of writing). The convention: anything with logic worth testing lives in a **pure module** with no DOM, timers or sockets (`engine.js`, `session-rules.js`, `hr-watchdog.js`, `funscript.js`, `storage.js`, `chart.js`, `peer-messages.js`, `voice-queue.js`, the `*-protocol.js` helpers and `stroke-planner.js`), with a `*.test.js` file next to it. The drivers (`handy.js`, `intiface.js`, `tcode.js`, `ble.js`) keep their browser API calls inside functions so they can be imported under Node and tested with fakes. If you add a feature, put its rules in a pure module and test them there; `app.js` should only wire the DOM to those modules.

**Browser smoke test** (needs Chromium through Playwright, which is deliberately not a project dependency):

```bash
npm install --no-save playwright
npx playwright install chromium     # once
npm run smoke                       # same as: node tools/smoke.js
```

`tools/smoke.js` serves the repository on a local port, drives the real UI in headless Chromium (age gate, wizard, every device modal, Session Setup including Apply, Guide / History / Share, a simulated heart-rate sweep, a full session on a mocked Handy API with START / PAUSE / RESUME / STOP / Reset and the API calls asserted, the History entry it leaves with its funscript buttons, the remote viewer and controller pages) and exits non-zero on any page error, `console.error`, failed request or broken assertion. Screenshots, `snapshot.json` and `report.json` land in `tools/smoke-out/`. Run it before opening a pull request that touches `index.html` or `app.js`.

**Continuous integration:** `.github/workflows/test.yml` runs `node --check` on every module and then `npm test` on every push to `main` and on every pull request. A syntax check of a single file is `node --check src/js/app.js`.

---

## How to Suggest Changes and Submit Code via GitHub

If you find a bug, want to add a device driver, or want to tweak the math, contributions are welcome through GitHub:

1. **Submit an Issue:** If you don't know how to code, click the **Issues** tab on GitHub and report a bug or request a toy integration.
2. **Submit a Pull Request (PR):** If you are a developer, fork the repository, make your changes on a branch, run `npm test` (and the smoke test if you touched the UI), and click **New Pull Request**.
3. **Review & Automatic Deployment:** Incoming PRs allow us to compare code line-by-line before approving them, and the test workflow runs on every PR. Once merged into the main branch, Cloudflare automatically compiles the update and deploys it live to `edgeloop.app` within ~30 seconds.

**Live Web App:** [https://edgeloop.app](https://edgeloop.app)

**Feedback & Support:** support@edgeloop.app

**GitHub:** [https://github.com/marshallmims/edgeloop](https://github.com/marshallmims/edgeloop)
