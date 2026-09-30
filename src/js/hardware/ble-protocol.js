// Pure helpers for the Bluetooth GATT Heart Rate Service (0x180D). No
// navigator, no DOM, so everything here runs under node:test. ble.js does
// the I/O.

// Reconnect schedule after an unexpected GATT drop: three attempts with
// exponential backoff before the app is told the sensor is gone.
export const BLE_RECONNECT_DELAYS_MS = Object.freeze([1000, 2000, 4000]);

// Delay before reconnect attempt `attempt` (1-based); null once the schedule
// is exhausted.
export function reconnectDelayMs(attempt, delays = BLE_RECONNECT_DELAYS_MS) {
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > delays.length) return null;
    return delays[attempt - 1];
}

// Decode one Heart Rate Measurement characteristic value (HRS spec 3.1).
//   flags bit 0    : 0 = uint8 BPM, 1 = uint16 little-endian BPM
//   flags bits 1-2 : 0b00 / 0b01 = contact detection not supported
//                    0b10 = supported, contact NOT detected
//                    0b11 = supported, contact detected
//   flags bit 3    : energy expended (uint16) present
//   flags bit 4    : RR intervals (uint16 each, 1/1024 s) present
// Returns null when the value is too short to hold a BPM at all; a truncated
// tail (RR intervals cut off by an MTU limit) is tolerated.
// RR intervals come back in milliseconds WITHOUT rounding, so the 1/1024 s
// resolution the strap measured survives into the beat-to-beat tracker.
// Rounding to whole milliseconds was a presentation choice hiding in a
// decoder: RMSSD is the root mean square of differences of a few tens of ms,
// and an error of up to half a millisecond added to every beat is noise the
// strap never produced.
export function parseHeartRateMeasurement(view) {
    if (!view || typeof view.getUint8 !== 'function' || !Number.isFinite(view.byteLength)) return null;
    if (view.byteLength < 2) return null;
    const flags = view.getUint8(0);
    const wideBpm = (flags & 0x01) === 0x01;
    if (wideBpm && view.byteLength < 3) return null;
    const bpm = wideBpm ? view.getUint16(1, true) : view.getUint8(1);
    let offset = wideBpm ? 3 : 2;

    const contactBits = (flags >> 1) & 0x03;
    // null = the sensor does not report contact; true / false otherwise.
    const sensorContact = contactBits === 0b11 ? true : (contactBits === 0b10 ? false : null);

    let energyExpended = null;
    if (flags & 0x08) {
        if (view.byteLength >= offset + 2) energyExpended = view.getUint16(offset, true);
        offset += 2;
    }

    const rrIntervalsMs = [];
    if (flags & 0x10) {
        while (view.byteLength >= offset + 2) {
            rrIntervalsMs.push(view.getUint16(offset, true) * 1000 / 1024);
            offset += 2;
        }
    }

    return { bpm, sensorContact, energyExpended, rrIntervalsMs };
}

// Human explanation of why Web Bluetooth is unavailable, for the BLE modal.
// `userAgent` is passed in so the message can be unit-tested.
export function describeBluetoothSupport(userAgent = '') {
    const ua = String(userAgent || '');
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isAndroid = /Android/i.test(ua);
    const isLinux = /Linux/i.test(ua) && !isAndroid && !/CrOS/i.test(ua);
    const isFirefox = /Firefox/i.test(ua);
    const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg/i.test(ua);

    let message = 'Web Bluetooth is not available in this browser. Use Chrome or Edge on desktop or Android';
    if (isIOS) {
        message = 'Safari and every iOS browser lack Web Bluetooth. On iPhone or iPad install the Bluefy browser and open EdgeLoop there';
    } else if (isFirefox) {
        message = 'Firefox does not implement Web Bluetooth. Use Chrome or Edge on desktop or Android';
    } else if (isSafari) {
        message = 'Safari does not implement Web Bluetooth. Use Chrome or Edge on desktop or Android';
    }
    if (isLinux) {
        message += '. On Linux, Chrome also needs chrome://flags/#enable-experimental-web-platform-features switched on';
    } else if (!isIOS) {
        message += ' (Bluefy on iOS)';
    }
    return `${message}.`;
}

// Shown under the status line after the chooser closed with nothing picked.
// Chrome's chooser lists a monitor that advertises the Heart Rate service
// while it scans, and one the browser's own Bluetooth adapter already reports
// as connected. It does not ask the system for devices that other apps hold
// (see the TODO on PopulateConnectedDevices in content/browser/bluetooth/
// bluetooth_device_chooser_controller.cc), and a monitor that is connected
// somewhere usually stops advertising. Bluetooth switched off, or kept from
// the browser by the system, opens the same chooser with a note instead of a
// list, and closing it rejects exactly like a cancel. A user whose HeartCast
// broadcast was already connected elsewhere got "No sensor selected" and no
// way to know why.
export const CHOOSER_EMPTY_HELP = Object.freeze({
    title: 'Monitor not in the list? The usual reasons:',
    items: Object.freeze([
        'It is already connected to something else. A monitor usually serves one app at a time and stops advertising while it is connected, so the chooser cannot list it. Disconnect or forget it in the Bluetooth settings of the computer or phone holding it, or close the app using it, then scan again.',
        'A phone app standing in for the monitor, such as HeartCast or Echo, has to be broadcasting and open on screen while you pair: on iOS a broadcasting app that goes to the background stops advertising in a way the browser can find.',
        'Bluetooth is off, or the browser has no permission to use it. The chooser then says what is missing and links to the setting; fix it there, then scan again.',
        'The monitor is not broadcasting yet: a chest strap wakes when it is worn with damp electrodes, and a watch needs its heart-rate broadcast switched on.'
    ])
});

// NotFoundError is not only a closed chooser. Chrome words each of its other
// causes itself (third_party/blink/renderer/modules/bluetooth/
// bluetooth_error.cc), in English whatever the browser's language, and for
// these no chooser was shown, or the monitor was picked and then lost.
// Telling someone to look for their monitor in a list they never saw sends
// them after the wrong fault.
const NOT_FOUND_CAUSES = [
    {
        match: /adapter not available/i,
        kind: 'no-adapter',
        message: 'The browser found no Bluetooth adapter. Check that this computer or phone has Bluetooth and that it is switched on, then try again.'
    },
    {
        match: /low energy not available/i,
        kind: 'no-adapter',
        message: 'This Bluetooth adapter cannot do Bluetooth Low Energy, which heart-rate monitors use.'
    },
    {
        match: /not supported on this platform/i,
        kind: 'no-adapter',
        message: 'This browser cannot pair Bluetooth devices here. Use Chrome or Edge on a computer or an Android phone (Bluefy on iOS).'
    },
    {
        match: /permission to scan/i,
        kind: 'blocked',
        message: 'The browser was refused permission to scan for Bluetooth devices. Allow it in the system settings for the browser app (Nearby devices, or Location on older Android), then try again.'
    },
    {
        match: /disabled Web Bluetooth|Web Bluetooth API globally disabled/i,
        kind: 'blocked',
        message: 'Bluetooth devices are blocked for websites in this browser, by its site settings or by an administrator. Allow them, then try again.'
    },
    {
        match: /doesn't exist anymore|^Does not exist/i,
        kind: 'network',
        message: 'The monitor you picked disappeared before the browser could connect. Keep it close and awake, then scan again.'
    }
];

// Map a requestDevice / connect failure to a short, honest status line.
// `help` ({ title, items }) comes only with a closed chooser.
export function describeBleError(error) {
    const name = error && error.name ? String(error.name) : '';
    const message = error && error.message ? String(error.message) : '';
    if (name === 'NotFoundError') {
        // The monitor was picked and connected, and has no heart-rate
        // service to subscribe to: the same answer as NotSupportedError.
        if (/^No (Services|Characteristics|Descriptors)\b/i.test(message)) {
            return { kind: 'unsupported', message: `The selected device does not expose the Heart Rate service (${message.replace(/\.$/, '')}).` };
        }
        const cause = NOT_FOUND_CAUSES.find((c) => c.match.test(message));
        if (cause) return { kind: cause.kind, message: cause.message };
        return { kind: 'cancelled', message: 'No sensor selected.', help: CHOOSER_EMPTY_HELP };
    }
    if (name === 'SecurityError') {
        return { kind: 'security', message: 'Web Bluetooth is blocked here: the page must be served over https:// (or localhost) and Bluetooth must be allowed for this site.' };
    }
    if (name === 'NetworkError') {
        return { kind: 'network', message: `Could not connect to the sensor (${message || 'GATT connection failed'}). Move closer, make sure no other app holds the connection, then try again.` };
    }
    if (name === 'NotSupportedError') {
        return { kind: 'unsupported', message: `The selected device does not expose the Heart Rate service (${message || 'GATT operation not supported'}).` };
    }
    return { kind: 'error', message: message || 'Bluetooth pairing failed.' };
}
