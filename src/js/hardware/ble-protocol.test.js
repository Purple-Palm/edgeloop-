import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    BLE_RECONNECT_DELAYS_MS,
    reconnectDelayMs,
    parseHeartRateMeasurement,
    describeBluetoothSupport,
    describeBleError,
    CHOOSER_EMPTY_HELP
} from './ble-protocol.js';

function view(bytes) {
    return new DataView(Uint8Array.from(bytes).buffer);
}

describe('reconnectDelayMs', () => {
    it('follows the 1 s / 2 s / 4 s schedule and then gives up', () => {
        assert.deepEqual([...BLE_RECONNECT_DELAYS_MS], [1000, 2000, 4000]);
        assert.equal(reconnectDelayMs(1), 1000);
        assert.equal(reconnectDelayMs(2), 2000);
        assert.equal(reconnectDelayMs(3), 4000);
        assert.equal(reconnectDelayMs(4), null);
        assert.equal(reconnectDelayMs(0), null);
        assert.equal(reconnectDelayMs('x'), null);
    });
});

describe('parseHeartRateMeasurement', () => {
    it('decodes an 8-bit BPM without contact support', () => {
        const out = parseHeartRateMeasurement(view([0x00, 72]));
        assert.equal(out.bpm, 72);
        assert.equal(out.sensorContact, null);
        assert.equal(out.energyExpended, null);
        assert.deepEqual(out.rrIntervalsMs, []);
    });

    it('decodes a 16-bit little-endian BPM', () => {
        const out = parseHeartRateMeasurement(view([0x01, 0x2C, 0x01]));
        assert.equal(out.bpm, 300);
    });

    it('reads the sensor-contact bits', () => {
        assert.equal(parseHeartRateMeasurement(view([0b110, 80])).sensorContact, true);
        assert.equal(parseHeartRateMeasurement(view([0b100, 0])).sensorContact, false);
        assert.equal(parseHeartRateMeasurement(view([0b010, 80])).sensorContact, null);
    });

    it('reports a 0 BPM packet as a packet, not as garbage', () => {
        const out = parseHeartRateMeasurement(view([0b100, 0]));
        assert.equal(out.bpm, 0);
        assert.equal(out.sensorContact, false);
    });

    it('skips energy expended and collects RR intervals', () => {
        // flags: uint8 BPM, contact detected, energy present, RR present.
        const out = parseHeartRateMeasurement(view([0b11110, 90, 0x10, 0x00, 0x00, 0x04, 0x00, 0x03]));
        assert.equal(out.bpm, 90);
        assert.equal(out.energyExpended, 16);
        // 0x0400 = 1024 units = 1000 ms, 0x0300 = 768 units = 750 ms.
        assert.deepEqual(out.rrIntervalsMs, [1000, 750]);
    });

    it('tolerates a truncated RR tail', () => {
        const out = parseHeartRateMeasurement(view([0b10000, 88, 0x00]));
        assert.equal(out.bpm, 88);
        assert.deepEqual(out.rrIntervalsMs, []);
    });

    it('ignores values too short to carry a BPM', () => {
        assert.equal(parseHeartRateMeasurement(view([])), null);
        assert.equal(parseHeartRateMeasurement(view([0x00])), null);
        assert.equal(parseHeartRateMeasurement(view([0x01, 0x50])), null);
        assert.equal(parseHeartRateMeasurement(null), null);
        assert.equal(parseHeartRateMeasurement({}), null);
    });
});

describe('describeBluetoothSupport', () => {
    it('names Chrome/Edge and Bluefy on a generic desktop', () => {
        const msg = describeBluetoothSupport('Mozilla/5.0 (Windows NT 10.0) Firefox/120.0');
        assert.match(msg, /Chrome or Edge/);
        assert.match(msg, /Bluefy/);
        assert.doesNotMatch(msg, /chrome:\/\/flags/);
    });

    it('mentions the experimental flag on Linux only', () => {
        const linux = describeBluetoothSupport('Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0');
        assert.match(linux, /chrome:\/\/flags\/#enable-experimental-web-platform-features/);
        const android = describeBluetoothSupport('Mozilla/5.0 (Linux; Android 14; Pixel 8) Firefox/120.0');
        assert.doesNotMatch(android, /chrome:\/\/flags/);
    });

    it('points iOS users at Bluefy', () => {
        const ios = describeBluetoothSupport('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1');
        assert.match(ios, /Bluefy/);
        assert.match(ios, /iOS/);
    });
});

describe('describeBleError', () => {
    it('distinguishes a closed chooser from real failures', () => {
        const cancelled = describeBleError({ name: 'NotFoundError', message: 'User cancelled the requestDevice() chooser.' });
        assert.equal(cancelled.kind, 'cancelled');
        assert.match(cancelled.message, /No sensor selected/);
        const other = describeBleError({ name: 'NetworkError', message: 'GATT Server is disconnected.' });
        assert.equal(other.kind, 'network');
        assert.match(other.message, /GATT Server is disconnected/);
        assert.equal(other.help, undefined);
        const plain = describeBleError(new Error('boom'));
        assert.equal(plain.kind, 'error');
        assert.equal(plain.message, 'boom');
        assert.equal(describeBleError(null).message, 'Bluetooth pairing failed.');
    });

    // Chrome rejects with this one message whether the list was empty or the
    // wearer closed it, and also when the chooser only said that Bluetooth
    // is off or not allowed. Other browsers (Bluefy) word it their own way.
    for (const message of ['User cancelled the requestDevice() chooser.', 'The user cancelled the request.', '']) {
        it(`says why a monitor can be missing from the chooser (${message || 'no message'})`, () => {
            const described = describeBleError({ name: 'NotFoundError', message });
            assert.equal(described.kind, 'cancelled');
            assert.equal(described.message, 'No sensor selected.');
            assert.equal(described.help, CHOOSER_EMPTY_HELP);
            const text = [described.help.title, ...described.help.items].join('\n');
            assert.match(text, /not in the list/);
            // Held by the system or another app: the cause a HeartCast user
            // hit, and the one the chooser gives no hint of.
            assert.match(text, /already connected/);
            assert.match(text, /one app at a time/);
            assert.match(text, /Disconnect or forget it in the Bluetooth settings/);
            assert.match(text, /close the app using it/);
            // A phone standing in for the monitor.
            assert.match(text, /HeartCast/);
            assert.match(text, /broadcasting and open on screen/);
            assert.match(text, /background/);
            // A chooser that only said Bluetooth is off.
            assert.match(text, /Bluetooth is off/);
            // A strap that is not awake yet.
            assert.match(text, /worn/);
        });
    }

    it('keeps the help as plain lines the modal can list', () => {
        assert.ok(Object.isFrozen(CHOOSER_EMPTY_HELP) && Object.isFrozen(CHOOSER_EMPTY_HELP.items));
        assert.equal(typeof CHOOSER_EMPTY_HELP.title, 'string');
        assert.ok(CHOOSER_EMPTY_HELP.items.length >= 4);
        for (const line of CHOOSER_EMPTY_HELP.items) {
            assert.equal(typeof line, 'string');
            assert.ok(line.length > 20 && !line.includes('<'), line);
        }
    });

    // Chrome's own words for the NotFoundErrors that are not a closed
    // chooser (blink bluetooth_error.cc and the GATT lookups). None of them
    // may send the wearer looking through a list they never saw.
    const causes = [
        ['Bluetooth adapter not available.', 'no-adapter', /no Bluetooth adapter/],
        ['Bluetooth Low Energy not available.', 'no-adapter', /Bluetooth Low Energy/],
        ['Web Bluetooth is not supported on this platform. For a list of supported platforms see: https://goo.gl/J6ASzs', 'no-adapter', /Chrome or Edge/],
        ['User denied the browser permission to scan for Bluetooth devices.', 'blocked', /permission to scan/],
        ['User or their enterprise policy has disabled Web Bluetooth.', 'blocked', /blocked for websites/],
        ['Web Bluetooth API globally disabled.', 'blocked', /blocked for websites/],
        ["User selected a device that doesn't exist anymore.", 'network', /disappeared/],
        ['Does not exist.', 'network', /disappeared/],
        ['No Services matching UUID 0000180d-0000-1000-8000-00805f9b34fb found in Device.', 'unsupported', /does not expose the Heart Rate service \(No Services matching UUID 0000180d-0000-1000-8000-00805f9b34fb found in Device\)\.$/],
        ['No Characteristics matching UUID 00002a37-0000-1000-8000-00805f9b34fb found in Service with UUID 0000180d-0000-1000-8000-00805f9b34fb.', 'unsupported', /does not expose the Heart Rate service/],
        ['No Services found in device.', 'unsupported', /does not expose the Heart Rate service/]
    ];
    for (const [message, kind, says] of causes) {
        it(`names the real cause of "${message.slice(0, 48)}"`, () => {
            const described = describeBleError({ name: 'NotFoundError', message });
            assert.equal(described.kind, kind);
            assert.match(described.message, says);
            assert.equal(described.help, undefined, 'no chooser list to explain');
            assert.doesNotMatch(described.message, /No sensor selected|not in the list/);
        });
    }
});
