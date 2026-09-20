# EdgeLoop v1.0: Autonomous Biofeedback Edging System

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

## What the App Does Today (v1.0)

EdgeLoop runs 100% locally in your web browser with zero accounts, zero subscriptions, and zero cloud tracking:

* **Adaptive Biofeedback Core:** Uses a convex power curve that keeps speeds active and engaging during mid-arousal, only backing off sharply in the final heart rate window before your climax ceiling. Includes a 5 BPM recovery buffer (hysteresis) and customizable peak behavior (Full Stop or a gentle Crawl Mode).
* **Session Guards:**
  * *Dual Stimulation Dampening:* Automatically offsets your climax ceiling down (default: -15 BPM) when internal/prostate toys are active alongside a stroker to balance out nerve summation.
  * *Adaptive Ceiling Decay:* Automatically steps down your climax ceiling as edges accumulate over long sessions to counteract physical fatigue.
  * *Stall Guard & Safety Watchdog:* Halts motor outputs if your heart rate signal is lost or stays clamped at peak levels for too long during Crawl Mode. The signal watchdog holds the last valid reading through short gaps (watches and relay apps often update only every 2-5 s), pauses the session after a configurable signal-loss timeout (3-20 s, default 8), flags poor electrode contact, and can resume automatically once readings return. A dropped Bluetooth link is retried three times (1 s, 2 s, 4 s) before it is reported as lost.
* **Experience Modes & Games:** Selectable profiles like Classic Tease, Prostate Milker (cross-fader), Glans Protector, and Ultimate Milker, alongside interactive challenges like *The Oracle* (decision gate) and *Survival Mode*.
* **Session Telemetry & Funscript Export:** Automatically logs session metrics and exports dual-channel `.funscript` (primary stroker) and `.v0.funscript` (secondary vibrator) files directly to your machine for replay in external players like ScriptPlayer or HereSphere.
* **Remote Partner Control & Viewers:** Peer-to-peer WebRTC room links let one partner anywhere in the world manage the session remotely (transport, Force Orgasm, mode), while any number of read-only viewers watch the live heart-rate telemetry. Every inbound message is validated; a dropped link is shown as disconnected, never as connected.
* **Broad Protocol Support:** Direct connection to BLE heart rate monitors (standard 0x180D GATT service), The Handy (Wi-Fi HAMP API), T-Code strokers (OSR2, SR6, OSSM) straight over their USB serial port via Web Serial (Chrome or Edge on a desktop, no Intiface needed), and Buttplug.io / Intiface Central for vibrators, reciprocating sex machines, and rotational devices.

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
├── index.html                  # Interface layout, cockpit panels, and popup dialogs
├── wrangler.jsonc              # Cloudflare Workers static asset deployment configuration
├── sw.js                       # Service worker for offline caching and PWA installation
├── manifest.json               # Web App manifest definitions (icons, standalone display)
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
        ├── chart.js            # Telemetry graph: draws the 60-second real-time heart rate canvas line
        ├── webrtc.js           # Peer-to-peer networking for remote partner control
        ├── voice.js            # Local text-to-speech prompts and optional microphone monitor
        └── hardware/
            ├── ble.js          # Web Bluetooth driver for standard heart rate monitors: notifications, battery, automatic reconnect
            ├── ble-protocol.js # Pure GATT Heart Rate Measurement parser (BPM, sensor-contact bits, RR intervals), reconnect schedule, browser-support and error messages
            ├── ble-protocol.test.js
            ├── handy.js        # The Handy Wi-Fi API driver (speed commands and travel boundaries)
            ├── intiface.js     # Intiface / Buttplug.io WebSocket driver for multi-motor vibrators, strokers, and rotators
            ├── buttplug-protocol.js  # Pure Buttplug v3 message builders / parsers (handshake, device attributes, errors)
            ├── tcode.js        # Direct T-Code driver over Web Serial (OSR2 / SR6 / OSSM): identification, per-axis roles, caps, stop
            ├── tcode-protocol.js     # Pure T-Code v0.3 helpers: axis commands, D0/D1/D2 parsing, default roles, browser-support text
            └── stroke-planner.js     # Pure per-axis stroke scheduler: one command per leg, rest move on stop
```

---

## How to Suggest Changes and Submit Code via GitHub

If you find a bug, want to add a device driver, or want to tweak the math, contributions are welcome through GitHub:

1. **Submit an Issue:** If you don't know how to code, click the **Issues** tab on GitHub and report a bug or request a toy integration.
2. **Submit a Pull Request (PR):** If you are a developer, fork the repository, make your changes on a branch, and click **New Pull Request**.
3. **Review & Automatic Deployment:** Incoming PRs allow us to compare code line-by-line before approving them. Once merged into the main branch, Cloudflare automatically compiles the update and deploys it live to `edgeloop.app` within ~30 seconds.

Engine mode tests (no browser required):

```bash
node --test src/js/engine.test.js
```

**Live Web App:** [https://edgeloop.app](https://edgeloop.app)

**Feedback & Support:** support@edgeloop.app

**GitHub:** [https://github.com/marshallmims/edgeloop](https://github.com/marshallmims/edgeloop)
