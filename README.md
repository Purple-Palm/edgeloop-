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

* **Player: your video and your funscript, your pulse as the limiter.** Load a video and its `.funscript` from your own disk in the **Player** and select the **Script** mode: the script sets the shape of every stroke, and your heart rate limits how much of it the toy may play. Near the edge the toy **skips** strokes while the video keeps playing, and rejoins the script on the beat when your pulse comes back down. Nothing is uploaded; see [The player](#the-player-your-video-your-script-your-pulse-as-the-limiter).
* **Adaptive Biofeedback Core:** Your pulse sets how hard each mode may push. Classic Tease, Prostate Milker, Head Play and Ultimate Milker use a convex power curve that keeps speeds active and engaging during mid-arousal, only backing off sharply in the final heart rate window before your climax ceiling; Head Play keeps a full stroke until you are close, then climbs toward the head. The other two modes back off their own way: Glans Protector eases its speed only to about half and shortens the stroke toward the base once you are close, and Ruin & Leak eases to about half and keeps stroking through the edge. Includes a 5 BPM recovery buffer (hysteresis) and a selectable peak behavior (Full Stop or a gentle Crawl).
* **Session Guards:** Signal watchdog, stall guard, dual-stimulation dampening and adaptive ceiling decay. They are described one by one in [Session guards](#session-guards) below.
* **Experience Modes & Games:** Selectable profiles like Classic Tease, Prostate Milker (cross-fader), Glans Protector, and Ultimate Milker, alongside interactive challenges like *The Oracle* (decision gate), *Survival Mode* (a slow climb past your max), and *Edge Training* (hold at the ceiling for a set time, N times, then finish; the hold and the recover after it both obey your *At the ceiling* setting; tapping Force Orgasm yourself suspends the training rather than completing it, and cancelling it after the finish starts a fresh set). With Calibration checked on the Survival card, *Finished me* stops the toys exactly as STOP does and pauses the run, then offers as your Climax HR the highest heart rate your monitor held on two readings in a row while the run was running — never a single reading, a paused stretch or the simulator's slider. OK saves it and ends the run; Cancel leaves the run paused. Like Came Early, it asks only once the Handy is known to be at rest: it has confirmed its stop, or it left the stop unanswered but had confirmed an earlier one and nothing has started it since, which the prompt line then says. If the Handy may still be moving, the prompt line says so, and pressing again asks anyway — about the run the first press was in time for — with that warning in the question. START and RESUME pressed before that press is over do nothing. It still works for a minute after STOP and during a Soft Landing. A number above 220 BPM, or one not above your Resting HR, is refused out loud rather than saved, and a learned offset is kept: the confirmation says where the next session pulls back with it. The Oracle uses your Duration tab: with Mystery (e.g. 30–60 min) it will not climax or deny before the minimum you typed — including on the one roll in N that lands the hidden target on that minimum, and including a Mystery whose two boxes hold the same number — and with a Fixed length (which has no window of its own) not before halfway; after that each 15 s hold can end you, more often as you near the target, and at the target it ends the session the way your Endgame Trigger says (a Soft Landing is teased down, never forced); Endless has no minimum. Every Oracle state you reach while parked on the pullback mark — the hold, purgatory and the climb — obeys your *At the ceiling* setting, so Full Stop really does park the primary there.
* **Session Telemetry & Funscript Export:** A session that runs for 10 seconds or more is logged in **History** when it ends (Reset discards it), with its length, edges, peak heart rate and outcome; up to the last 10 are kept in this browser. Nothing is saved to your machine on its own: each session in History has two download buttons, a `.funscript` for the primary stroker and a `.v0.funscript` for the secondary channel. To replay a session, open the file in a funscript player such as ScriptPlayer or HereSphere, or play it with its video in EdgeLoop's own player. A session in Script mode is marked **Script** in History, which keeps only a hash of the script and its length, never a file name.
* **Remote Partner Control & Viewers:** Peer-to-peer WebRTC room links let one partner anywhere in the world manage the session remotely (transport, Force Orgasm, mode), while any number of read-only viewers watch the live heart-rate telemetry. Every inbound message is validated; a dropped link is shown as disconnected, never as connected. The partner's START / RESUME is acted on only in the state their button showed, so a RESUME that reaches the host after the wearer ended the session never starts a new one, and none is taken while the wearer's Came Early or Finished me is stopping the toys and asking. Host-only settings — the Edge Training hold length and edge count, and the pullback percent — are read from the host's telemetry, never from the remote device's own saved settings, so a partner never paces the session by numbers out of their own browser. The same goes for everything a remote page shows about the session itself: the Resting / Climax pair, the Target Mode and the Endgame Trigger are the wearer's, so a partner page never fills them in from its own storage. Both pages also say which version of the remote-control messages they speak. After a release an open tab keeps running the build it loaded, and 1.0.0 and 1.1.0 read the same mode click in opposite ways, so a mode or game change is refused between pages on different versions, while START, PAUSE, STOP, Reset and Force Orgasm go through whatever the version. Both people are told which page is older and needs a reload; for the wearer's page that means between sessions, because a reload ends the session and opens a new room with a new link. A page from before this check cannot show the notice itself; the updated page does.
* **Keyboard:** Space pauses a running session (not while you are typing in a field). It never resumes or starts one: press RESUME, or Tab to it and press Enter. Escape closes the open dialog, the same as its X: changes you have not applied are discarded. It does nothing while you are typing in a field, and it does not close the Guide or the age check. While either of those is open, Tab stays inside it and nothing behind it can be reached or pressed; Space still pauses a running session behind the Guide. RESUME takes a press only once it has been on the button for half a second, so a click you aimed at PAUSE as the session paused, or a double-click on PAUSE, does not start it again. After Escape closes a dialog, the page ignores clicks for half a second, so a click on its way to the X does not land on START or RESUME; while a session runs, PAUSE and STOP still work. It does the same when the Came Early or Finished me question closes, however you answer it. On a partner's controller page Space pauses the wearer's session the same way and never resumes it; on a view-only page it does nothing. With a script loaded in the Player, **[** and **]** move the script offset 50 ms earlier or later; they start, resume and pause nothing.
* **Broad Protocol Support:** Direct connection to BLE heart rate monitors (standard 0x180D GATT service), The Handy (Wi-Fi HAMP API; API v3 and HSP for beat sync in Script mode), the Autoblow VacuGlide 2 (Wi-Fi API, speed only; experimental - see [below](#autoblow-vacuglide-2-wi-fi---experimental)), T-Code strokers (OSR2, SR6, OSSM) straight over their USB serial port via Web Serial, and Buttplug.io / Intiface Central for vibrators, reciprocating sex machines, and rotational devices.

### Versions

EdgeLoop uses semantic versions. **1.0.0** is the app as it stood when the footer started showing a number, which is the build that had been called 1.0. **1.1.0** is PATTERNS. **1.1.1** fixes sessions that were easing off before the heart-rate max. **1.1.2** is Survival, shipped as a patch so it can be tested. A bug fix bumps the last number. The next feature release bumps the middle number. The footer shows the number and a **Changelog** button that opens [CHANGELOG.md](CHANGELOG.md) in the app. That file is the same list on GitHub. Publishing a [GitHub Release](https://github.com/marshallmims/edgeloop/releases) for a version is what posts it to the Discord changelog channel.

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
2. Set the **Hardware Travel Envelope** (Min 0-90%, Max 10-100%) to the physical range your sleeve allows. Every stroke zone — every mode, every pattern, every game, warm-up and Force Orgasm — is scaled inside these bounds, so the sleeve can never slip out or jam at the base.
3. Under it, the **End-Stop Margin** (0-10% of travel, 5% by default) keeps the carriage off the mechanical ends of the slider. The Handy's firmware stops the slider when it reads as blocked, and a carriage driven hard into its end stop can read exactly like that — forum user X333 hit that lockout on a Handy 2 and had to type guards around 0 and 100% himself. The margin does that for you, starting from the stroke The Handy would be sent without it, which is never shorter than 10% of travel: a mode's shortest stroke is a tenth of your Travel Envelope, so once you narrow the envelope a shorter one is lengthened to 10% first, margin or not — in a 0-40% envelope a 0-4% stroke goes out as 0-10% with no margin. Only a stroke that reaches within the margin of 0% or 100% is moved, so an envelope whose guards already clear the margin is sent untouched by it, and full travel leaves as 5-95%. A stroke that reaches in keeps its length and slides inward, clear of the end — a 10% warm-up stroke at the base leaves as 5-15%, and so does that 0-4% one — and only a stroke longer than the room left is cut down to fit. Nothing is sent outside your Travel Envelope and the margin never makes a stroke longer, but a stroke held against one end reaches up to the margin further toward the other than it does with no margin: Glans Protector's ceiling stroke, the bottom 35% of your range, leaves as 5-40% of travel at the default margin, 10-45% at 10% and 0-35% at 0, with the full 0-100% envelope. The margin gives way only when your Travel Envelope itself is too narrow to lose it and still hold a 10% stroke, and then only as far as it has to: 0-12% leaves as 2-12%, and 0-10% stays on the end, which the modal tells you. Set it to **0** to send the full range, exactly as older builds did; the modal shows what a full-length stroke is really sent as. It applies to The Handy only — a T-Code or Intiface linear axis takes a wider zone as a longer, slower stroke rather than a faster one. Two things the device says back are now read out in the modal instead of being thrown away: the result code `PUT /slide` returns when it rounded your stroke range to limits of its own, and the one HAMP error code API v2 has, which is explained rather than shown as “Unspecified HAMP error”. Both only inform — what decides that a Handy has to be given up on is still the offline detection, unchanged.
4. Pick the role and the **Max Speed Cap**. STOP is confirmed and retried, and an offline Handy is detected mid-session, which pauses the session; the device then keeps receiving stops in the background until one is confirmed, so a Wi-Fi blip cannot leave the motor running. Pressing **Connect Handy** again (a new key, or the same one after an API error) verifies the new key first and brings the connected device to a confirmed stop before the link is switched; if either fails the current connection is left as it was. **Disconnect** reports whether its stop was confirmed, and closing the tab sends a last stop.

In Script mode The Handy can play your own script stroke for stroke over API v3 (beat sync) or follow its rhythm over this same driver; see [The player](#the-player-your-video-your-script-your-pulse-as-the-limiter).

If EdgeLoop dies mid-session - the tab crashes, the browser is force-quit or the phone kills it - nothing sends The Handy a stop, and it keeps the last motion it was given. The next time you open EdgeLoop in the same browser, it sends that Handy a stop with the connection key the session used and the one saved here, keeps sending it for five minutes if it does not get through (and tries once more at the following open), and says on the banner that the last session did not end cleanly and what the stop returned. An EdgeLoop tab that was already open does the same when you start or resume a session in it. Nothing is stopped until a page is opened again, so after a crash open EdgeLoop at once, or switch the Handy off. Intiface and T-Code toys cannot be reached without a new connection; the banner says what each does by itself and what to do.

### Intiface Central (Buttplug.io)

Intiface Central is the bridge for Bluetooth vibrators, rotators, reciprocating machines and (through its serial support) T-Code strokers.

1. Start Intiface Central and **start its server**. Add and connect your toys there first.
2. In the EdgeLoop Intiface modal, keep the URL at `ws://localhost:12345` (plain `ws://`, not `wss://`, for a local server) and press **Connect**. The status walks Offline, Connecting, Handshake and Connected (server name, N devices); an invalid URL, a stopped server or a stalled handshake is reported in the same line.
3. Every actuator is listed with an **axis role** (Primary / Secondary / OFF), a cap and a **Test** button. Stroke maps to Linear axes, twist and roll map to Rotate axes; assign leftover axes Secondary or OFF. Linear axes have an invert switch. On a toy with a fixed number of power steps the cap moves a step at a time and shows the real percentage - a 3-step toy offers 33%, 67% and 100% - so a cap the toy cannot do is never chosen, and the toy is never sent more than the cap shown. A cap saved by an older build between two steps counts as the step under it; one under the toy's first step counts as that step if it was at least half of it (the toy ran there before), otherwise the axis stays off and the modal says so.
4. **Vibration:** every vibrate axis can be **Constant** (the default: the engine's intensity as it is) or **Pulsed**, with a pulse period of 0.8, 1.6 or 2.4 s. A pulsed axis is on for half of each period and at 0 for the other half; the engine's intensity for that axis sets the peak, never above its cap. Constant vibration numbs - forum user Umbra250 found pulsing 0-50% at those periods kept him more sensitive. A pulse train is two commands a period, and STOP, pause, the heart-rate watchdog, leaving the page and a disconnect cut it at once.
5. **Rotation options:** a rotator can **reverse on every edge** and/or **alternate direction every N seconds** (5-60).
6. Press **Save & Apply**. Roles, caps, invert, the vibration setting and the rotation settings are **remembered per toy**, so a reconnect restores your mapping.

Linear axes are driven by a stroke planner that sends exactly one command per stroke leg, which is what makes OSR-class strokers move smoothly instead of in bursts. Every position goes out on the device's own step and inside your Travel Envelope. `StopAllDevices` is sent on STOP, pause, disconnect and when the page closes. A rotator that turns both ways (a Lovense Nora) is listed by Intiface twice, as a Rotate scalar and a Rotate axis; EdgeLoop drives the Rotate axis, which has the direction, and shows the other as not used.

**OSSM over Bluetooth (and the Lovense Solace Pro).** Intiface Central lists one motor twice: a **Position** axis (Linear) and an **Oscillate** axis. They are two modes of the same motor, not two motors - Intiface sends the OSSM to its menu before every change of mode, and the OSSM runs that as an emergency stop - so only one of the two can be on: turning one on turns the other OFF, and the one that is OFF is sent nothing at all. EdgeLoop used to drive both, which flips the machine between modes with an emergency stop each time - the likeliest cause of the OSSM that sat still on Position and slammed the rail and stopped on Oscillate (forum user X333). **Position** is on by default and strokes along the engine's stroke, inside your Travel Envelope. **On STOP, pause, the heart-rate watchdog, leaving the page or OFF the OSSM holds where it is**: Intiface has no stop for an OSSM in this mode (its stop only reaches the Oscillate mode), and the OSSM finishes a move before it takes one the other way, so the only way to stop it is to send it nothing more. EdgeLoop sends each stroke in short pieces of at most 0.2 s, all in the stroke's direction, and a stop simply sends no next piece: the OSSM halts within that fraction of a second and stays there. It does not move to a rest position afterwards - that would be one more move, toward an end of the rail that differs between OSSM firmware versions. The first stroke after connecting or after Oscillate goes out in one piece, because nothing tells EdgeLoop where the OSSM is until then; it is sized for the longest way it could have to go, so it is slow - and **STOP cannot cut that first stroke short**: it runs to its end, which takes at most 2.2 s (at the slowest crawl over the full travel), and then the OSSM holds. EdgeLoop never sends the OSSM the same position twice in a row: its firmware divides by the distance between the two. **Oscillate** gets only a speed, under its cap, and the OSSM then runs its own stroke over its whole rail at full depth, because Intiface sets its depth and stroke to 100% in that mode: nothing EdgeLoop sends can keep it inside a Travel Envelope. So it can only be switched on while your Travel Envelope is 0-100%; with a narrower one the modal says why and keeps it off. On the OSSM the speed knob is a limit by default: after it shows its play screen, turn it up or it will not move. This has been tested against a stand-in for Intiface Central built from Buttplug's and the OSSM's code, not yet on a real OSSM.

**T-Code strokers through Intiface** (OSR2, SR6, an OSSM on T-Code firmware) are listed with a Position *scalar* next to the Linear axis. It is the same motor as a position without a duration, so EdgeLoop shows it as not used and sends it nothing; the Linear axis does the stroking.

### TCode Serial (OSR2 / SR6 / OSSM without Intiface)

The TCode Serial card drives any T-Code v0.3 stroker straight over its USB serial port (115200 8N1), which gives you every axis rather than the single linear axis Intiface exposes.

* **Chrome or Edge on a desktop only** (Windows, macOS, Linux): Web Serial does not exist on phones, in Firefox or in Safari. Browsers without it get a clear message.
* **Close any other app that holds the COM port first:** Intiface Central, MultiFunPlayer, a serial monitor. Then press **Connect** and pick the port in the browser dialog.
* **Linux:** your user must be in the `dialout` group (`sudo usermod -aG dialout $USER`, then log out and back in).
* The device is identified with `D0` / `D1` / `D2`; a firmware that stays silent falls back to the common `L0 / R0 / R1 / R2 / V0` set. Every axis gets a **Primary / Secondary / OFF** role, a cap, a **Test** button and (linear axes) an invert switch. `L0` (stroke) is Primary and `V0` Secondary by default, everything else OFF. Rotation axes swing around centre by the engine speed. Settings are remembered per device name.
* STOP, pause, Reset and every disconnect alert bring all axes to rest on one line; an unplugged device or a failed write pauses the session.

### Autoblow VacuGlide 2 (Wi-Fi) - experimental

> **Experimental.** VacuGlide support has only been tested against Autoblow's API, not on a real device. Keep your first sessions short, with the VacuGlide's own power button within reach, and tell us what happened - good or bad - in the [EdgeLoop thread](https://discuss.eroscripts.com/t/edgeloop-app-autonomous-real-time-cardiac-biofeedback-edging-funscript-generator/336717) on Eroscripts. The modal and the VacuGlide card say the same.

1. Turn on the VacuGlide's online mode (hold its mode button for about 2.5 seconds), put the **device token** Autoblow gave it into the VacuGlide modal and press **Connect VacuGlide**. EdgeLoop finds the device through Autoblow's cloud and brings it to a confirmed stop, motor stopped and both valves closed, before a session can drive it. While the device is online its own speed and mode buttons do not control it; holding the mode button for about 2.5 seconds leaves online mode.
2. **What EdgeLoop drives, and what it cannot.** Only the **speed**: the channel you pick (Primary, Secondary or OFF) under a **Max Speed Cap**, the same role and cap The Handy has. The VacuGlide has no stroke range and no suction setting, so the stroke zone, the Travel Envelope and the other channel do not reach it, and nothing reads back where the receiver sits. Under a low cap a crawl stays a crawl: a positive speed never leaves as 0. EdgeLoop never moves a valve by itself - owners warn that an automatic change can pop the receiver off, and that where that happens depends on the speed and the gear.
3. **The two valve buttons.** **Valve +** (Autoblow's stroke-plus valve) lengthens the stroke and **Valve −** (stroke-minus) shortens it; owners describe it as moving the receiver up or down the shaft. One press opens that valve for a short pulse - 1.0 s by default, 0.3-2.0 s in the modal - and then closes it, and the close is confirmed and retried until it is. A press while a valve is open is ignored, so presses never add up to a long open. Press once, feel it, then decide on the next.
4. STOP, Pause and Disconnect stop the motor **and** close both valves; Autoblow's own stop leaves the valves as they are. The device has no watchdog, so closing the tab sends that stop as well. Autoblow's cloud can apply a command late, after a stop: when a stop goes out with a command still unanswered, or goes out to a device that may be moving and is not answered itself within 2 s, EdgeLoop reads the device every 2 s for as long as that command could still arrive, stops it again at once if it moves, and raises the alarm if it cannot read it.
5. The link is checked every 10 s in a session and every 30 s outside one. A VacuGlide that drops out pauses the session, and one that may still be running is sent the whole stop in the background until one is confirmed, as a lost Handy is. Autoblow allows about 160 requests a minute per device token, and a browser cannot read how many are left, so EdgeLoop counts its own: the speed goes out only when it changes, and at most once a second unless a guard or a landing has just cut it, and a reserve of 20 requests - six whole stops in any 66 s - is kept for stops and valve closes, so Autoblow never refuses one for rate. A stop that has to wait for a slot past that raises the alarm and goes the moment one frees. Below that reserve, 34 more are kept for the reads that watch for a late command, so routine traffic alone cannot use them up. In an extreme minute (valve presses at their limit while a speed changes every second) a few of those reads can still be refused; each one raises the alarm and pauses the session, the safe side.

   If you stop the VacuGlide from Autoblow's app, or from anything else using its token, while EdgeLoop runs a session, EdgeLoop pauses the session as soon as it reads the device stopped, and sends it no speed until you press RESUME. It reads it about every 2 s while the session holds its speed, before a new speed that comes after 2 s without a request, at a valve press, and at the link check. What is left: a new speed EdgeLoop sends less than 2 s after its last request to the device starts the motor again, and EdgeLoop never sees that you stopped it. While the session's speed keeps changing every second or two, that is what happens, within about a second. To stop the VacuGlide during a session, use PAUSE or STOP in EdgeLoop, or switch the VacuGlide off.
6. A tab closed or reloaded while EdgeLoop could not yet vouch for the VacuGlide leaves it to the next EdgeLoop page to open, which checks the device at once, watches it for as long as a late command could still arrive, and stops it if it needs it; connecting that device, in any tab, does the same. An EdgeLoop tab that was already open does not take it over, and the partner viewer and controller pages never touch it. What that leaves: a device left by a closed tab is checked when EdgeLoop is next opened or that device is next connected - until then nothing watches it, and a command Autoblow's cloud applies late in that time runs until then. The tab that drives the VacuGlide answers for it: a tab still watching the device - after Disconnect, or after taking it over - lets go of it as soon as you connect it in another tab.
7. A session that did not end cleanly - the tab crashed, the browser was force-quit or killed by the phone, or the tab was closed or reloaded before STOP - is on the record EdgeLoop keeps of every session while it runs. The next time you open EdgeLoop in the same browser, or start or resume a session in an EdgeLoop tab that was already open, each VacuGlide that session drove is sent its whole stop, once, and again every 5 s for up to five minutes with the alarm up if it does not get through - unless another open tab has that VacuGlide connected, which then answers for it - and the banner says that the last session did not end cleanly and what came back. This stop is not followed by a minute of reads. A crash sends no unload stop and leaves nothing to take over, so after a crash this is the only stop the VacuGlide gets; one that has not got through by the end of those five minutes is tried once more at the following open, as The Handy's is. Nothing is stopped until a page is opened again, so after a crash open EdgeLoop at once, or switch the VacuGlide off.
8. The device token is a bearer credential that Autoblow documents no way to revoke. It is kept in its own entry in this browser and, like the Handy connection key, left out of a backup unless you tick the box beside **Export**.

---

## The player: your video, your script, your pulse as the limiter

The **Player** button in the header opens the player section above the cockpit; closed, it is one line ("Script loaded: 1:20:03, 40,112 actions"). While it is open, START / PAUSE, STOP and Reset sit in a bar along the bottom of the screen at every size, as they always do on a phone, so the video never pushes them out of sight. It plays **your own** video with **your own** `.funscript`. The script sets the shape of every stroke; your heart rate limits how much of it the toy may play.

1. **Load the files.** **Choose files** (or drop them on the panel) and pick a video and its script, named alike: `Movie.mp4` + `Movie.funscript`. On a phone, pick them one after the other. Several stroke scripts for one video (`Movie.Soft.funscript`, `Movie.Hard.funscript`) give a picker; `.vib`, `.surge`, `.sway`, `.twist`, `.roll` and `.pitch` files are listed as not played yet. The video plays from your disk through the page's own `<video>` element, never read into memory and never uploaded. The script is checked before anything is built from it (at most 32 MB and 1,000,000 actions, times within 24 h, positions clamped to 0-100, at least two usable actions) and the panel says what it dropped, how long it is, its fastest segment and how much of it your speed limit will cap. A file that fails is refused with the reason.
2. **Select the Script mode** (the card at the bottom of the Modes grid; it is enabled once a valid script is loaded). Loading files never changes the mode by itself, and in any other mode the video is a plain player that drives nothing. Games run their own speeds and are off while Script is selected.
3. **START** plays the video from where it stands, and needs a valid script and a video that can show a frame, as well as everything START always needs. **PAUSE** always pauses the video, whoever pauses the session (you, Space, a partner, the HUD, a guard, the page going away). **STOP** and **Reset** stop it where it stands. The video's own controls are off; a media key, a headset's browser bar or iOS's native fullscreen can still pause or play it, and a pause from there pauses the session, while a play is only a request to the same START / RESUME gate the button uses. The session stops when the video ends ("Video ended" in History), unless the Script tab says **Loop**. A buffering stall over 30 s, a video the browser cannot decode, or a video that will not start pauses the session and says why.
4. **Offset.** −50 / +50 (or **[** / **]**) moves the strokes earlier or later, up to ±2 s; positive plays them later. It is remembered for that script in this browser, under a hash of its actions, never its name.
5. **Theater** fills the window and **Fullscreen** the whole screen, both with a HUD over the picture: pulse, pullback mark and phase, edges and timer, the allowance bar, and a large **PAUSE** and **STOP**. The readouts hide after 4 s and come back on a tap or a mouse move; PAUSE and STOP only fade and always take a press. Escape leaves either. On an iPhone, where only the video itself can go fullscreen, there is no Fullscreen button: use Theater, which fills the screen with the same HUD.

**How the pulse limits the script (the Script tab in Session Setup).** Where the edge is still comes from your Resting / Climax HR, the pullback percent, dual-stim dampening, decay, the learned offset and the microphone boost, exactly as in every other mode. What the toy may play is the **allowance**:

* **Start reacting** (0-40 BPM below the pullback mark, default 10) and the **Approach reaction**: **Shorten** (default) keeps every stroke on its beat at a smaller amplitude, anchored at the base, down to the **Approach floor** (default 30%) just below the mark; **Slow** lowers the speed limit instead, so fast strokes reach less far; **Shorten & slow** does both; **None** plays the full script until the mark. Nothing is ever time-stretched, so the toy never drifts from the video.
* **At the edge** (the first reading at the mark, as in every mode): **Skip strokes** (default) stops the toy where its stop leaves it while the video and the script clock keep running; **Pause video** also holds the video until the edge releases, while the session and every guard keep running. The edge releases 5 BPM below the mark, as always; the toy then joins the script at the first turning point it can reach at half the speed limit, and the allowance ramps back over the **Rejoin ramp** (0-60 s, default 8). A new pullback during the ramp skips again at once. RESUME after a pause rejoins through the same ramp; a seek does not restart it. The Guards tab's *At the ceiling* does not apply in Script mode, and a script never arms the stall guard.
* **Max speed** (50-600 % of full travel per second, default 300, about 330 mm/s on a 110 mm Handy): a segment faster than this is cut short and keeps its timing. Each toy's speed cap scales it, and it never goes above what the toy can do (The Handy: the top speed it reports; T-Code and OSSM 600 %/s; Intiface linear toys 500 %/s). **Invert script** flips it, on top of the file's own `inverted` flag. Smoothing is Light (it only ever removes points: jitter under 3%, points under 60 ms apart).
* The warm-up (its speed only), Global Intensity, Force Orgasm, the Soft Landing and the endgames act on the allowance as they act on the speed in every other mode. **Second channel**: the limiter at 60% (default), or Off. **When the video ends**: Stop the session (default) or Loop.

**What each toy does in Script mode.** The status in the player says it per toy:

* **Intiface linear axes** and **T-Code `L0`** on the primary channel play the script stroke for stroke, one command per segment, timed from the video on every leg. A skip is their usual stop (the rest move, or an OSSM's hold).
* **Vibrators, rotators, secondary axes and the VacuGlide** cannot play strokes: they follow the limiter as a level, exactly as a primary vibrator follows Classic.
* **The Handy** has two routes, and the status line says which one it is on:
  * **Beat sync (HSP)**, with **Beat sync on The Handy** switched on in the player: a Handy on **firmware 4** is driven over API v3 and HSP. EdgeLoop sends it about 4 s of already-limited stroke points ahead at a time, replaces every point it has not played yet when your pulse changes, and the device plays them on a clock synced to Handy's server. At an edge it is sent a hold; PAUSE, STOP and every guard send a verified `/hsp/stop`. If the page dies, the device runs out of points within those few seconds. The first time you switch it on, EdgeLoop asks: stroke positions and their times, a few seconds ahead, go to Handy's servers (handyfeeling.com) under EdgeLoop's Application ID while it plays. Nothing else is sent: not the video, not the script file, not its name, not your heart rate. It is checked when you switch it on or connect The Handy. Where it is not possible (firmware below 4, the API refusing the ID) the player says so and why, and START plays the rhythm below; a check that fails for a reason that may pass (a slow or broken link) says why, and START checks again and is refused rather than silently falling back.
  * **Rhythm only (HAMP)**, with beat sync off or not possible: the existing v2 driver plays the script's local tempo and depth (its speed and stroke range follow the next 3 s of the script), not each stroke. No account, no consent, any firmware.
  * The Handy takes commands from one place at a time: close ScriptPlayer, Handyverse or anything else that could drive it. Under beat sync, another app taking it over, the device's own button, a blocked slider or heat pauses the session.

**What leaves your machine.** With beat sync off, nothing about the player: the video and the script stay on this device, and your heart rate goes only where it always has, to a partner you link with Share Control. With beat sync on, the next few seconds of stroke positions and times go to Handy's cloud as described above. History keeps a hash of the script and its length; the per-script offset is kept in this browser under that hash. No file name, file handle or script content is ever stored or put in a backup.

**What it cannot do (yet), and what to keep in mind.**

* The player must be the clock: a video playing in another app (HereSphere, DeoVR, a TV) cannot be followed from a web page. Inside a headset's browser the page can play the video but cannot read a heart-rate monitor: run EdgeLoop on a PC, tablet or phone that reads your pulse.
* A page that is **hidden while the video is silent** pauses the session (a hidden page is only kept at full speed while it is heard); keep EdgeLoop in view, or the video audible. A hidden page with sound plays on, under the same supervision as always.
* Beat sync's claims rest on Handy's documentation and a mocked API: that a starving Handy holds still, that `/hsp/stop` halts mid-segment, and the cloud link's real latency from your home are still to be confirmed on a firmware-4 device. Rhythm mode keeps every stop the HAMP driver has; like any HAMP session, a HAMP Handy keeps moving if the page dies until crash recovery stops it at the next open.
* Script density on an OSSM or an OSR over Bluetooth, and Intiface latency, are untested on hardware. Keep first sessions short, with each toy's own stop in reach.
* The playback speed is fixed at 1×. Crawl at the edge, rewind after an edge, the vibration and multi-axis scripts, per-toy latency and a seek-bar heatmap are not in this version.

---

## What is remembered between sessions

Everything you type into Session Setup is saved in this browser and restored on the next load: **Resting HR** and **Climax HR**, the **Target Mode** (Fixed / Mystery / Endless) with its lengths, the **Endgame Trigger**, the warm-up, every guard, the Script tab, the voice phrases and the microphone settings. The player's per-script offset and your Beat sync switch (and the answer to its one-time question) are kept in this browser too, and are not part of a backup; the video and the script are never kept at all. Lowering your ceiling by hand halfway through a session is kept, so a reload does not hand the toys back a limit you had already decided was too high.

Typing into one of those fields updates the running session on the keystroke; the write to storage is batched over a short window rather than done once per key, and is flushed whenever the page could go away (a reload included), so nothing you typed is lost.

**Not** remembered, on purpose: Global Intensity and the selected mode or game card. Those are cockpit "right now" values - a fresh page that restored 150% intensity or Ruin & Leak would be making a motor-affecting decision you did not. The Intiface server URL is not remembered either; that one is an open request rather than a deliberate refusal.

Stored limits are validated on the way out of storage exactly as typed ones are on the way in: a corrupt or hand-edited store cannot restore a Climax HR outside 30-250 BPM, or one at or below your Resting HR. A pair that fails that check falls back to the factory 70 / 140. A pair that passes comes back exactly as you typed it, a narrow Resting/Climax band included - the pullback mark simply sits at the ceiling there, as it always has - so a reload can never hand you limits you did not choose, and never a working ceiling above the Climax HR you typed. All of it rides in the **Backup** export and comes back on import.

### Backup & Restore

Import is a **between-sessions** action: it writes the Handy speed cap, sets the channel role and rewrites the stroke range, and those reach the toys on the tick the file is read, so a restore during a running session is refused with a note to stop the session first. **Export (.json)** on the Backup tab writes one file with everything this browser remembers: every Session Setup value and voice-phrase list, the learned biometric offset, the Handy channel role and speed cap, the VacuGlide channel role, speed cap and valve pulse length, your saved Intiface and T-Code device maps (per-axis role, cap and invert, and each Intiface vibrator's Constant or Pulsed setting) and the age / wizard flags. Import puts all of it back and then tells you in words what it restored, each part by name and with its value - "the Handy speed cap (now 55%)", not just "the speed cap". Both Import buttons are reachable from the keyboard.

Your **Handy connection key and your VacuGlide device token are left out unless you tick the box** beside the button ("Include my device keys"); the one box covers both, and also your own Handy Application ID if you set one in the Handy panel. Each is a bearer credential: whoever holds the string can drive that toy from anywhere, with no password, and the app cannot revoke either (Autoblow documents no way to revoke a token). A backup file, meanwhile, is exactly the sort of thing people mail to themselves, drop in cloud storage or paste into a thread when somebody asks what their settings are. So the file you get without thinking about it is safe to send, and the file with the key in it is one you chose: it downloads as `edgeloop_settings_with_key.json` instead of `edgeloop_settings.json` when either is in it (as `edgeloop_settings_with_app_id.json` when only your Application ID is, which is not secret), the panel tells you which you just wrote - before the download starts, not after - and the file's own second line is the warning. A file without the key says so too, so an export is never silently incomplete; if you tick the box and there is no usable key or token saved here, both the panel and the file say that, rather than telling you to tick a box you already ticked.

An import never connects a toy by itself - press Connect when you want it - and it never breaks a pairing silently: a file with no key or token leaves the ones saved in this browser exactly where they were, and a file carrying a **different** key or token does re-pair this browser, which the import says out loud so you can put your own back if you picked the wrong file. A toy that is connected while you import keeps the axis map it is running; reconnect it to pick up the restored one. Every Session Setup field has one sanitizer, and every value that reaches the settings store goes through it - typed, loaded from storage on boot, or restored from a file - so a hand-edited or hostile file cannot restore an out-of-range ceiling, an inverted envelope, a disabled guard or a 400% axis cap, and a key that is not a plain printable string within a sane length is refused rather than handed to The Handy's API. A field with no sanitizer fails the test suite rather than reaching the engine unchecked. Where a value only makes sense beside another one - the Resting/Climax pair, the session length, the travel envelope - the rule that owns the pair decides, and it refuses a nonsensical pair outright rather than clamping each half into something you never chose. Older backups (a bare settings blob, written before the file had a version marker) still import. A field this version does not have is skipped rather than stored, in both directions - the import says how many it skipped, and the count of restored values it reports is the count it actually stored - and a file that turns out not to be a backup at all says which way it is wrong (not JSON, a JSON list, empty, or nothing in it this version knows) instead of one flat "invalid file". A value the app itself would refuse comes back at the nearest value it accepts - a limit, or the factory setting - and is counted as refused, not as a restore. If the browser refuses to save - a full store, or blocked site data - the import says so first and in those words, instead of reporting a restore that the next reload undoes.

**Session history is never in a backup**, deliberately, and the panel says so. It is a health and sexual-activity record - peak heart rate, outcome, timestamps and a 4 Hz trace of the whole session - it is the bulkiest thing in storage, and a backup that quietly mails that to your own inbox is a worse surprise than the gap it would close. The per-session `.funscript` download already exists for getting a session out of the app.

## Session guards

The **Guards** tab of Session Setup holds every safety rule. They are independent of the selected mode.

* **At the ceiling: Full Stop vs Crawl.** What the strokers do once your pulse crosses the pullback trigger. *Full Stop* parks the primary at 0%; *Crawl* keeps a 10% micro-motion so the edge stays alive. It applies in every mode that teases you down, including every Edge Training and Oracle state reached while on the mark (the training hold and the recover after it alike). Two modes it does not govern: *Survival Mode*, where the speed keeps climbing and each edge raises the mark by 1 BPM, slowly enough that half an hour is still a build, so the strokers never park and the run does not end when you cross your old max. Check Calibration on that card when the run should set your Climax HR; the first-run wizard offers to start there; and *Ruin & Leak*, which keeps stroking through the edge once and then, after about 12 seconds on the mark, cuts the primary dead and drops the secondary low, whichever you picked: for 18 seconds, and after that until the edge releases, so each edge gets one ride. Force Orgasm overrides both.
* **Pullback at % of Climax HR (90-100, default 100).** 100% is the number you typed; 95% pulls back early. It cannot be set above 100%: the typed Climax HR is a hard ceiling, so Crawl / Full Stop and the stall timers always start at it or below it. The percentage is taken from the working ceiling, so dual-stim dampening, decay and the learned offset move the mark down with it; the Guards preview and the cockpit HOLD TO badge always show the same number. The mark is also kept far enough above your Resting HR to leave a release band, so a very narrow Resting/Climax pair simply pulls back at the ceiling. The edge releases 5 BPM below the mark. The cockpit shows a HOLD TO badge and a purple chart line when this is not 100%.
* **Prolonged Edge Auto-Cutoff (Stall Guard).** Optional. Used with Crawl, and during a *Ruin & Leak* ride with either *At the ceiling* setting. Two timers: **Allow on the edge** (3-120 s, default 20) is how long pulse may sit at the pullback mark before the primary is cut. **Pause the primary** (2-60 s, default 8) is how long that halt lasts; then crawl resumes and the allow window starts again. A Ruin ride keeps its own 12 seconds: the guard can cut it short, and it only comes back after the pause if some of those seconds are left. Turn it off to stay on crawl until you recover, Force Orgasm, or STOP. The secondary channel keeps running. The amber banner during the halt names what the mode you are actually in will do when the pause ends, so it never promises a crawl where none is coming back: in *Ruin & Leak* it says whether the ride resumes after the pause or the lockout keeps the primary at 0%.
* **Heart-Rate Signal Watchdog (always on).** A short gap holds the last valid reading instead of dropping to 0, because watches and relay apps often update only every 2-5 s. When no usable pulse has arrived for the **signal-loss timeout** (3-20 s, default 8 s) every motor stops and the session pauses. Readings below 35 BPM are ignored rather than treated as silence, poor electrode contact is flagged, and a dropped Bluetooth link is retried three times (1 s, 2 s, 4 s) before it is reported as lost. START and RESUME (from the cockpit or a remote controller) need a usable reading younger than the timeout, so the transport reads WAITING FOR PULSE instead of driving the toys on a frozen heart rate; engaging the simulator during a watchdog pause keeps the session paused until you press RESUME.
* **Auto-resume when signal returns.** On by default: the session resumes by itself once readings are back. Off: it stays paused until you press RESUME.
* **Dual Stimulation Dampening.** When a secondary (prostate) toy is active alongside a stroker, the climax ceiling is offset down (5-30 BPM, default 15) to balance nerve summation. The cockpit shows a DUAL STIM badge while both toys are live, with the BPM it really takes off: less than the setting, or 0, when the Resting HR + 15 BPM floor holds the ceiling up. The LEARNED and DECAY badges work the same way, so your typed Climax HR less the three badges is the working ceiling before Survival's climb or Force Orgasm raises it.
* **Adaptive Ceiling Decay.** Every X edges (1-10, default 2) the ceiling drops by Y BPM (1-5, default 2) to counteract fatigue over a long session, down to a **floor** (80-130, default 105). The floor can *stop* the decay but can never *raise* the ceiling: if you typed a Climax HR below the floor, your value wins. No offset can push the working ceiling below Resting HR + 15 BPM or above the Climax HR you typed. The DECAY badge shows the amount currently applied.
* **Force Orgasm** is a temporary boost on the working ceiling; STOP and Reset always clear it and the typed Climax HR is never rewritten. It eases the toys up over about half a minute from exactly what they were last sent - a crawl on the mark stays a crawl on the first second, the warm-up's slow short stroke stays slow and short - and never hands a moving toy 0% on the way. While it is on, the edge you are sitting on is frozen: the overdrive lifts the mark with the ceiling, so neither the engine nor a game may read the unchanged pulse as released, and cancelling it can never count an edge you did not have. A pause (yours, the signal watchdog, a stalled or frozen page) stops the toys and keeps it switched on; RESUME ramps it up again from a standstill rather than from where it was. It only switches on during a session, running or paused, and never in a soft landing: a tap outside those, or a partner's, is refused with a line under the button saying why.
* **Force Orgasm runs for at most** 60 s, 90 s (the default), 2 min, 3 min or Off, counted from the moment it is switched on - by your tap, the Climax ending, an Oracle climax, the end of Edge Training or a partner's remote - with its ramp included. When the time is up the session goes into the 45 s soft landing, with a cue on the dashboard (spoken too when the voice is on), and the landing ends the session. The landing eases both channels down to a stop from half speed, or from what the run was sending if that is slower - a run a pause interrupted in its last seconds is still climbing from a standstill when its time runs out - so it is never a cut to 0 and never a step up; a Soft Landing ending that arrives during a run lands the same way. The button counts the run down (m:ss), on a partner's page too, and a pause stops the clock. The default comes from the body: the orgasm itself is a series of 10 to 15 pelvic contractions, the first two about 0.6 s apart and each gap about 0.1 s longer (Bohlen, Held & Sanderson, *Archives of Sexual Behavior* 9:503-521, 1980), roughly 9 to 18 seconds, so 90 s leaves a full minute at the top after the ramp, and the landing still strokes an orgasm that comes late. **Off** keeps it running until you tap it off or press STOP, as before.

The **Audio & Mic** tab has spoken voice guidance (local browser TTS, with a voice picker and Preview). When it is on, each cue is shown on the dashboard **and** spoken. Phrase banks are grouped: **Build-up** encouragement on a timer (default every 45 s, 0 = off), **Edge** when pulse hits the pullback mark, **Climax** when you tap Force Orgasm (or the orgasm endgame arms it; Oracle climax uses its own lines) and when its time limit starts the soft landing, and **Premature** when you tap Came Early (one bank for a press that lowers the ceiling the next session starts at, another for a press the Resting HR floor or the offset cap leaves where it was). Every event can hold many phrases (one per line; a random line is picked each time). Tokens `{hr}`, `{maxHr}`, `{minHr}`, `{edges}`, `{minutes}` fill in live session values; in the two Came Early banks `{hr}` is the peak of the minute before the press and `{maxHr}` the ceiling the next session starts at. **Export phrases** / **Import phrases** save or load a JSON (or a `# edge` / `# encourage` / `# forceOrgasm` / `# cameEarly` text file; section names are matched whatever their case). Anything EdgeLoop cannot place is refused rather than read back at you as a phrase: an unknown section name, and any text above the first section header — a title, a date, a note — which the alert then quotes so you can fix or comment it out with `//`. A file with no headers at all is taken as build-up encouragement. The full Backup export includes the same lists. Empty a box to mute that cue: it then says nothing and paints nothing, and the mute is exported and imported like any other phrase list, so your own backup restores it instead of bringing the factory lines back. **Reset defaults** (it asks first) brings the factory phrases back.

The microphone monitor (optional) is a second arousal datapoint: louder voice/panting above the noise gate adds extra BPM to the heart rate the **engine** runs on, so the tease modes treat you as closer to the edge and slow down sooner. It never goes past the effective Climax HR, and it can only ever ease the toys off, on the primary and the secondary channel alike — everything that rises with arousal, the climb in Edge Training and The Oracle and the rising secondary of the milking modes, is driven by the pulse your monitor measured alone, so a loud room (a TV, a headset, a partner) can never push a toy harder. In *The Oracle* and *Edge Training* every motor term is one of those, so the boost reaches nothing at all there and the cockpit badge stays on **MIC LISTEN** rather than promising a push nothing is making. While the signal watchdog is holding a reading the boost is frozen at its last measured value rather than dropped: it cannot grow on sound while no pulse is arriving, and a single missed packet cannot make the toys jump. It moves the toys and nothing else: the BPM readout, the edge counter, the games (Oracle, Survival, Edge Training), the guards and the saved session peak all judge the pulse your monitor measured, so room noise can never count an edge, finish Edge Training, arm Force Orgasm or end a Survival run. **Louder → closer (max extra BPM)** (0–20, default 8) is how hard that push is; 0 listens without changing the toys. The cockpit shows **MIC +N** while a boost is really reaching the toys, and **MIC LISTEN** when it is suppressed or silent.

---

## Hosting your own copy

EdgeLoop is static files: no build step, no server code, no database. Any static host works.

* **Requirements:** the page must be served over **https** (or from `localhost` / `127.0.0.1` while developing). Web Bluetooth, Web Serial and the service worker all refuse a plain `http://` origin. The Tailwind and PeerJS scripts load from a CDN, so the first visit needs internet access; afterwards the service worker (network-first, cache fallback) lets the cockpit open offline.
* **Locally:** `npm start` (or `python3 -m http.server 8000`) in the repository root, then open `http://localhost:8000`.
* **GitHub Pages:** fork the repository, then *Settings > Pages > Build and deployment > Source: Deploy from a branch*, branch `main`, folder `/ (root)`. The manifest and service worker use relative paths, so the app works under the `https://<you>.github.io/edgeloop/` sub-path.
* **Cloudflare Workers:** the repository ships a `wrangler.jsonc` that serves the root directory as static assets with single-page-application fallback. `npx wrangler deploy` publishes it; connecting the repository to Cloudflare deploys every push to `main` automatically, which is how `edgeloop.app` is hosted.
* **Dev:** [https://dev.edgeloop.app](https://dev.edgeloop.app) is a second Worker (`edgeloop-dev`), not the live site. Push the `dev` branch and the dev workflow deploys it. `main` is untouched. The footer shows DEV there, and the browser treats it as a different site, so heart-rate pairings and saved settings do not carry over. The workflow needs a GitHub Actions secret named `CLOUDFLARE_API_TOKEN`: an API token for the edgeloop.app zone with Workers Scripts Edit, Workers Routes Edit, DNS Edit, and Zone Read. From a machine that has already run `npx wrangler login`, `npm run deploy:dev` does the same deploy. The first successful deploy creates the hostname. Do not add `dev.edgeloop.app` as a custom domain on the production `edgeloop` Worker. That would serve the live build under the dev name.
* Anything else (Netlify, Vercel, nginx, a NAS): upload the repository as-is and make sure `index.html` is the root document.

**Beat sync on your own copy.** The Handy's API v3 needs an Application ID, and the one in `src/js/hardware/handy-hsp-protocol.js` (`HANDY_APP_ID`) belongs to the edgeloop.app fork; Handy documents an Application ID as not secret and meant to be embedded in client code, and requests are attributed to the account that issued it. A copy you host should use its own: request a developer invitation at user.handyfeeling.com, issue an **Application ID** (not an Application Key, which is server-side only), and either change that constant or paste the ID into **Beat sync (advanced)** in the Handy panel. Rhythm mode needs no ID.

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
├── CHANGELOG.md                # Version history, by area, with forum credits. The footer opens this file.
├── LICENSE                     # AGPL-3.0
├── README.md
├── icon.svg                    # App icon (manifest, PWA install)
├── index.html                  # Interface layout, cockpit panels, popup dialogs and the service-worker registration
├── manifest.json               # Web App manifest definitions (icons, standalone display)
├── package.json                # npm test / npm run smoke / npm start; no dependencies
├── sw.js                       # Service worker: network-first with cache fallback for offline use
├── wrangler.jsonc              # Cloudflare Workers static asset deployment configuration
├── tools/
│   ├── smoke.js                # Headless-Chromium smoke test of the real UI (needs Playwright, see Development)
│   └── fixtures/               # A 3 s silent WebM and its .funscript, for the smoke test's player steps
└── src/
    └── js/
        ├── app.js              # Main interface controller: connects on-screen controls to the engine, runs the 1-second clock loop, and manages menus
        ├── state.js            # Central memory store for settings, user preferences, and real-time session state
        ├── engine.js           # Biofeedback calculations: speed curves, recovery thresholds, and safety cutoffs
        ├── engine.test.js      # Node tests for every cockpit mode, stall/crawl, warmup, hysteresis, and Oracle/Survival
        ├── session-rules.js    # Pure session rules: effective ceiling, duration window, Oracle fate vs mystery min, Survival breach, stall timers
        ├── session-rules.test.js
        ├── funscript.js        # Pure funscript builder: turns the 4 Hz speed/zone timeline into .funscript stroke actions and .v0.funscript vibration levels
        ├── funscript.test.js
        ├── storage.js          # Robust localStorage helpers: corrupt-JSON-safe reads, quota-safe writes, oldest-first history trimming
        ├── storage.test.js
        ├── write-coalescer.js  # Pure write batcher: one settings write per window instead of one per keystroke, flushed on demand
        ├── write-coalescer.test.js
        ├── backup.js           # Pure backup file: what an export carries (settings, Handy role/cap, device maps, opt-in connection key), and every clamp an import puts a file through
        ├── backup.test.js
        ├── docs.test.js        # Documentation guard: README and CHANGELOG may not quote a test count that goes stale
        ├── modal-overlays.test.js  # The age check and the setup wizard are modal: runs index.html's overlay script against a fake page
        ├── hr-watchdog.js      # Pure heart-rate signal watchdog: ok / holding / stale verdicts, no-contact flag, one-shot trip and recovery
        ├── hr-watchdog.test.js
        ├── chart.js            # Telemetry graph: draws the 60-second real-time heart rate canvas line, sized from its box and the device pixel ratio
        ├── chart.test.js
        ├── webrtc.js           # Peer-to-peer networking for remote partner control (?partner=) and read-only viewers (?group_sub=)
        ├── webrtc.test.js      # The link layer with a stand-in PeerJS: every message carries the protocol version, and a mode change never crosses between versions
        ├── peer-messages.js    # Pure validation of every message that crosses the WebRTC data channel, in both directions
        ├── peer-messages.test.js
        ├── alert-banner.js     # Ranked alert banner: every notice belongs to the source that raised it and leaves only when that source withdraws it or the wearer dismisses it; an advisory is never read before a safety report, and no report goes on saying the motors are paused once the session runs again or is stopped
        ├── alert-banner.test.js
        ├── voice.js            # Local text-to-speech prompts and optional microphone monitor (voice-band gate)
        ├── voice.test.js
        ├── voice-cues.js       # Editable cue templates and {hr}/{edges} interpolation
        ├── voice-cues.test.js
        ├── voice-speak.test.js
        ├── voice-queue.js      # Pure cue queue: dedupe, bounded backlog, safety cues jump the queue
        ├── voice-queue.test.js
        ├── player/             # The player: your own video and .funscript, your pulse as the limiter (each pure module has its *.test.js)
        │   ├── player.js           # The player section (DOM): files, the <video>, its clock, theater / fullscreen and the HUD, the offset
        │   ├── player-rules.js     # Pure rules: the video's own controls as transport requests, readiness, hidden-and-silent, offsets, panel words
        │   ├── funscript-parse.js  # Pure, bounded .funscript parser and the script's SHA-256 (of its actions, never its text)
        │   ├── script-pairing.js   # Pure pairing of a video with its script by name (packs, .vib and axis files)
        │   ├── script-track.js     # Pure track queries: position at a time, turning points, speeds, stats
        │   ├── media-clock.js      # Pure clock fed by the video: anchors, extrapolation, no time while paused or seeking
        │   ├── script-governor.js  # Pure allowance: approach band, skip at the edge, rejoin ramp, the Script tab's sanitizers
        │   ├── script-shaper.js    # Pure shaper: smoothing, amplitude, envelope, speed limit, skip, rejoin
        │   ├── script-rhythm.js    # Pure HAMP rhythm fallback: the script's tempo and depth for The Handy's v2 driver
        │   └── script-feed.js      # The runtime object every script driver asks
        └── hardware/
            ├── ble.js          # Web Bluetooth driver for standard heart rate monitors: notifications, battery, automatic reconnect
            ├── ble-protocol.js # Pure GATT Heart Rate Measurement parser (BPM, sensor-contact bits, RR intervals), reconnect schedule, browser-support and error messages
            ├── ble-protocol.test.js
            ├── handy.js        # The Handy Wi-Fi API driver (HAMP mode, /slide travel range with the end-stop margin, verified replies, confirmed stop, offline detection)
            ├── handy.test.js
            ├── handy-protocol.js     # Pure Handy API v2 helpers: reply classification, velocity clamp, slide-range normalisation, end-stop margin, slide-result reading, battery parsing
            ├── handy-protocol.test.js
            ├── handy-stop-report.js  # Pure record of which Handys still owe a confirmed stop, by key, and the one banner sentence that says so until each is accounted for
            ├── handy-stop-report.test.js
            ├── intiface.js     # Intiface / Buttplug.io WebSocket driver for multi-motor vibrators, strokers, and rotators; per-toy memory
            ├── intiface.test.js
            ├── buttplug-protocol.js  # Pure Buttplug v3 message builders / parsers (handshake, device attributes, errors), the level / position the server lands on, which actuators are one motor
            ├── buttplug-protocol.test.js
            ├── vibe-pulse.js         # Pure pulsed-vibration schedule for Intiface vibrate axes: the three periods, the square wave, the setting's readers
            ├── vibe-pulse.test.js
            ├── tcode.js        # Direct T-Code driver over Web Serial (OSR2 / SR6 / OSSM): identification, per-axis roles, caps, stop
            ├── tcode.test.js
            ├── tcode-protocol.js     # Pure T-Code v0.3 helpers: axis commands, D0/D1/D2 parsing, default roles, browser-support text
            ├── tcode-protocol.test.js
            ├── stroke-planner.js     # Pure per-axis stroke scheduler: one command per leg, rest move on stop
            ├── stroke-planner.test.js
            ├── script-planner.js     # The script on Intiface linear axes and T-Code L0: one leg per script point, the stroke planner's stop
            ├── handy-hsp.js          # The Handy over API v3 and HSP (beat sync): verify, setup, rolling window, verified stops, SSE, keepalive
            └── handy-hsp-protocol.js # Pure HSP helpers: the Application ID, bodies, reply classification, window planning, request budget
```

---

## Development

There is no build step and no dependency to install. Clone the repository, serve it (`npm start`) and edit; reload the page to see a change.

**Unit tests** (Node 22 or newer, no browser):

```bash
npm test
```

runs every `*.test.js` under `src/js/` with Node's built-in test runner, which prints the exact count on its last lines (`# tests` / `# pass`). No number is quoted here: the suite grows most weeks, and a number in a document nobody re-counts is simply wrong after the next change - `docs.test.js` fails if one creeps back in. The convention: anything with logic worth testing lives in a **pure module** with no DOM, timers or sockets (`engine.js`, `session-rules.js`, `hr-watchdog.js`, `funscript.js`, `storage.js`, `write-coalescer.js`, `backup.js`, `chart.js`, `peer-messages.js`, `voice-queue.js`, the `*-protocol.js` helpers, `stroke-planner.js`, `vibe-pulse.js` and the player's pure modules under `player/`), with a `*.test.js` file next to it. The drivers (`handy.js`, `handy-hsp.js`, `intiface.js`, `tcode.js`, `ble.js`), the player section (`player/player.js`) and the peer link (`webrtc.js`) keep their browser API calls inside functions so they can be imported under Node and tested with fakes. If you add a feature, put its rules in a pure module and test them there; `app.js` should only wire the DOM to those modules.

**Browser smoke test** (needs Chromium through Playwright, which is deliberately not a project dependency):

```bash
npm install --no-save playwright
npx playwright install chromium     # once
npm run smoke                       # same as: node tools/smoke.js
```

`tools/smoke.js` serves the repository on a local port, drives the real UI in headless Chromium (age gate, wizard, every device modal, Session Setup including Apply, Guide / History / Share, a simulated heart-rate sweep, a full session on a mocked Handy API with START / PAUSE / RESUME / STOP / Reset and the API calls asserted, the History entry it leaves with its funscript buttons, the player with the fixture clip and its script in Script mode on a mocked Handy API v3 - START plays the video and sends a play with a flushed add, an edge sends a hold while the video plays on, PAUSE and STOP stop the device and the video - and the remote viewer and controller pages) and exits non-zero on any page error, `console.error`, failed request or broken assertion. Screenshots, `snapshot.json` and `report.json` land in `tools/smoke-out/`. Run it before opening a pull request that touches `index.html` or `app.js`.

**Continuous integration:** `.github/workflows/test.yml` runs `node --check` on every module and then `npm test` on every push to `main` and on every pull request. A syntax check of a single file is `node --check src/js/app.js`.

---

## How to Suggest Changes and Submit Code via GitHub

If you find a bug, want to add a device driver, or want to tweak the math, contributions are welcome through GitHub:

1. **Submit an Issue:** If you don't know how to code, click the **Issues** tab on GitHub and report a bug or request a toy integration.
2. **Submit a Pull Request (PR):** If you are a developer, fork the repository, make your changes on a branch, run `npm test` (and the smoke test if you touched the UI), and click **New Pull Request**.
3. **Review & Automatic Deployment:** Incoming PRs allow us to compare code line-by-line before approving them, and the test workflow runs on every PR. Once merged into the main branch, Cloudflare automatically compiles the update and deploys it live to `edgeloop.app` within ~30 seconds.

**Live Web App:** [https://edgeloop.app](https://edgeloop.app)

**Discord:** [https://discord.gg/ZFrkehxAC](https://discord.gg/ZFrkehxAC) — questions, device reports, and support.

**Private contact:** support@edgeloop.app, for security reports and anything that should not be posted in a public server. Product support goes to Discord.

**GitHub:** [https://github.com/marshallmims/edgeloop](https://github.com/marshallmims/edgeloop)
