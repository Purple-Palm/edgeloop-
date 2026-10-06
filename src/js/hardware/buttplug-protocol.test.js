import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    BUTTPLUG_MESSAGE_VERSION,
    buildRequestServerInfo,
    buildPing,
    buildScalarCmd,
    buildLinearCmd,
    buildRotateCmd,
    buildStopAllDevices,
    buildStopDeviceCmd,
    buildSensorReadCmd,
    encodeFrame,
    decodeFrame,
    classifyMessage,
    parseServerInfo,
    pingIntervalMs,
    describeError,
    parseDevice,
    deviceSignature,
    defaultRoleFor,
    isScalarActuator,
    drivesAsLevel,
    oscillateTwins,
    scalarLevel,
    linearWirePosition,
    linearStep,
    rotateDuplicates,
    capSteps,
    capStepPercent,
    capChoices,
    MIN_AXIS_CAP_PERCENT
} from './buttplug-protocol.js';

// How current Buttplug (buttplugio/buttplug, device-config v5) lists these
// devices to a v3 client: message/v3/server_device_message_attributes.rs
// puts every output of a feature but hw_position_with_duration in
// ScalarCmd, that one in LinearCmd, both with the feature's description.
// protocols/ossm.yml: one feature, oscillate 0..100 + hw_position_with_duration 0..100.
const OSSM_RAW = {
    DeviceName: 'Kinky Makers OSSM',
    DeviceIndex: 0,
    DeviceMessageTimingGap: 0,
    DeviceMessages: {
        ScalarCmd: [{ FeatureDescriptor: '', StepCount: 100, ActuatorType: 'Oscillate' }],
        LinearCmd: [{ FeatureDescriptor: '', StepCount: 100, ActuatorType: 'Position' }],
        StopDeviceCmd: {}
    }
};
// protocols/lovense.yml, "Lovense Solace Pro": the same pair on one feature, with a description.
const SOLACE_PRO_RAW = {
    DeviceName: 'Lovense Solace Pro',
    DeviceIndex: 4,
    DeviceMessages: {
        ScalarCmd: [{ FeatureDescriptor: 'Stroker position Based Movement', StepCount: 20, ActuatorType: 'Oscillate' }],
        LinearCmd: [{ FeatureDescriptor: 'Stroker position Based Movement', StepCount: 100, ActuatorType: 'Position' }],
        SensorReadCmd: [{ FeatureDescriptor: 'battery Level', SensorType: 'Battery', SensorRange: [[0, 100]] }],
        StopDeviceCmd: {}
    }
};
// protocols/tcode-v03.yml: hw_position_with_duration AND position on one feature.
const TCODE_V03_RAW = {
    DeviceName: 'TCode v0.3 (Single Linear Axis)',
    DeviceIndex: 2,
    DeviceMessages: {
        ScalarCmd: [{ FeatureDescriptor: '', StepCount: 999, ActuatorType: 'Position' }],
        LinearCmd: [{ FeatureDescriptor: '', StepCount: 999, ActuatorType: 'Position' }],
        StopDeviceCmd: {}
    }
};

describe('builders', () => {
    it('produces the v3 handshake', () => {
        assert.deepEqual(buildRequestServerInfo(1), {
            RequestServerInfo: { Id: 1, ClientName: 'EdgeLoop', MessageVersion: BUTTPLUG_MESSAGE_VERSION }
        });
        assert.equal(BUTTPLUG_MESSAGE_VERSION, 3);
        assert.deepEqual(buildPing(7), { Ping: { Id: 7 } });
    });
    it('clamps command values into the spec ranges', () => {
        assert.deepEqual(buildScalarCmd(2, 3, [{ index: 0, scalar: 1.7, actuatorType: 'Vibrate' }]), {
            ScalarCmd: { Id: 2, DeviceIndex: 3, Scalars: [{ Index: 0, Scalar: 1, ActuatorType: 'Vibrate' }] }
        });
        assert.deepEqual(buildLinearCmd(4, 1, [{ index: 0, position: -0.3, durationMs: 180.4 }]), {
            LinearCmd: { Id: 4, DeviceIndex: 1, Vectors: [{ Index: 0, Duration: 180, Position: 0 }] }
        });
        assert.deepEqual(buildRotateCmd(5, 1, [{ index: 0, speed: 0.5, clockwise: false }]), {
            RotateCmd: { Id: 5, DeviceIndex: 1, Rotations: [{ Index: 0, Speed: 0.5, Clockwise: false }] }
        });
        assert.deepEqual(buildStopAllDevices(6), { StopAllDevices: { Id: 6 } });
        assert.deepEqual(buildStopDeviceCmd(7, 2), { StopDeviceCmd: { Id: 7, DeviceIndex: 2 } });
        assert.deepEqual(buildSensorReadCmd(8, 2, 1), {
            SensorReadCmd: { Id: 8, DeviceIndex: 2, SensorIndex: 1, SensorType: 'Battery' }
        });
    });
    it('encodes every frame as a JSON array', () => {
        assert.equal(encodeFrame(buildPing(1)), '[{"Ping":{"Id":1}}]');
        assert.equal(encodeFrame([buildPing(1), buildPing(2)]), '[{"Ping":{"Id":1}},{"Ping":{"Id":2}}]');
    });
});

describe('decodeFrame / classifyMessage', () => {
    it('decodes arrays and tolerates garbage', () => {
        assert.deepEqual(decodeFrame('[{"Ok":{"Id":1}}]'), [{ Ok: { Id: 1 } }]);
        assert.deepEqual(decodeFrame('{"Ok":{"Id":1}}'), [{ Ok: { Id: 1 } }]);
        assert.deepEqual(decodeFrame('not json'), []);
        assert.deepEqual(decodeFrame('[1, null, "x"]'), []);
    });
    it('classifies by the single key and extracts the Id', () => {
        assert.deepEqual(classifyMessage({ Ok: { Id: 12 } }), { type: 'Ok', id: 12, body: { Id: 12 } });
        assert.equal(classifyMessage({ DeviceAdded: { DeviceIndex: 0 } }).id, 0);
        assert.equal(classifyMessage({ A: {}, B: {} }).type, 'unknown');
        assert.equal(classifyMessage(null).type, 'unknown');
    });
});

describe('handshake parsing', () => {
    it('reads ServerInfo', () => {
        assert.deepEqual(parseServerInfo({ Id: 1, ServerName: 'Intiface Central', MessageVersion: 3, MaxPingTime: 1000 }), {
            serverName: 'Intiface Central', messageVersion: 3, maxPingTime: 1000
        });
        assert.deepEqual(parseServerInfo({ Id: 1, MessageVersion: '3', MaxPingTime: 0 }), {
            serverName: 'Intiface', messageVersion: 3, maxPingTime: 0
        });
        assert.equal(parseServerInfo(null), null);
    });
    it('pings at half the server limit, or not at all', () => {
        assert.equal(pingIntervalMs(0), 0);
        assert.equal(pingIntervalMs(-5), 0);
        assert.equal(pingIntervalMs(1000), 500);
        assert.equal(pingIntervalMs(150), 100);
        assert.equal(pingIntervalMs('abc'), 0);
    });
});

describe('error classification', () => {
    it('maps codes to kinds and flags fatal ones', () => {
        assert.deepEqual(describeError({ Id: 3, ErrorMessage: 'bad', ErrorCode: 1 }), {
            code: 1, kind: 'handshake', message: 'bad', fatal: true, unsolicited: false
        });
        assert.equal(describeError({ Id: 0, ErrorMessage: 'ping', ErrorCode: 2 }).unsolicited, true);
        assert.equal(describeError({ Id: 0, ErrorMessage: 'ping', ErrorCode: 2 }).fatal, true);
        assert.equal(describeError({ Id: 9, ErrorMessage: 'dev', ErrorCode: 4 }).kind, 'device');
        assert.equal(describeError({ Id: 9, ErrorMessage: 'dev', ErrorCode: 4 }).fatal, false);
        assert.equal(describeError({ Id: 9, ErrorCode: 3 }).message, 'Intiface error (code 3)');
        assert.equal(describeError({}).kind, 'unknown');
    });
});

describe('parseDevice', () => {
    const osr2 = {
        DeviceIndex: 2,
        DeviceName: 'TCode v0.3 (Single Linear Axis)',
        DeviceMessages: {
            LinearCmd: [{ StepCount: 1000, FeatureDescriptor: 'L0', ActuatorType: 'Position' }],
            StopDeviceCmd: {}
        }
    };
    const lovense = {
        DeviceIndex: 0,
        DeviceName: 'Lovense Edge',
        DeviceDisplayName: 'My Edge',
        DeviceMessageTimingGap: 100,
        DeviceMessages: {
            ScalarCmd: [
                { StepCount: 20, FeatureDescriptor: 'Vibrator 1', ActuatorType: 'Vibrate' },
                { StepCount: 20, FeatureDescriptor: 'Vibrator 2', ActuatorType: 'Vibrate' }
            ],
            SensorReadCmd: [
                { SensorType: 'RSSI', SensorRange: [[-100, 0]], FeatureDescriptor: 'RSSI' },
                { SensorType: 'Battery', SensorRange: [[0, 100]], FeatureDescriptor: 'Battery' }
            ],
            StopDeviceCmd: {}
        }
    };

    it('uses the array position as the index when attributes carry none', () => {
        const parsed = parseDevice(lovense);
        assert.deepEqual(parsed.scalars.map((s) => s.index), [0, 1]);
        assert.equal(parsed.scalars[1].descriptor, 'Vibrator 2');
        assert.equal(parsed.scalars[1].stepCount, 20);
        assert.equal(parsed.displayName, 'My Edge');
        assert.equal(parsed.timingGapMs, 100);
        assert.equal(parsed.canStop, true);
    });
    it('finds the Battery sensor index from the sensor list', () => {
        assert.equal(parseDevice(lovense).batterySensorIndex, 1);
        assert.equal(parseDevice(osr2).batterySensorIndex, null);
    });
    it('exposes an OSR2 as one linear actuator', () => {
        const parsed = parseDevice(osr2);
        assert.equal(parsed.linears.length, 1);
        assert.equal(parsed.linears[0].stepCount, 1000);
        assert.equal(parsed.scalars.length, 0);
    });
    it('tolerates the v2 object form and rejects garbage', () => {
        const parsed = parseDevice({ DeviceIndex: 1, DeviceName: 'Old', DeviceMessages: { VibrateCmd: { FeatureCount: 2 }, ScalarCmd: { FeatureCount: 2, ActuatorType: 'Vibrate' } } });
        assert.deepEqual(parsed.scalars.map((s) => s.index), [0, 1]);
        assert.equal(parseDevice(null), null);
        assert.equal(parseDevice({ DeviceName: 'no index' }), null);
        assert.equal(parseDevice({ DeviceIndex: 3 }).name, 'Device 3');
    });
    it('builds a signature from the name and actuator layout', () => {
        assert.equal(deviceSignature(parseDevice(lovense)), 'Lovense Edge|S:Vibrate,Vibrate|L:|R:');
        assert.equal(deviceSignature(parseDevice(osr2)), 'TCode v0.3 (Single Linear Axis)|S:|L:Position|R:');
    });
    it('defaults roles sensibly', () => {
        const edge = parseDevice(lovense);
        assert.equal(defaultRoleFor(edge, 'scalar', 0), 'secondary');
        const stroker = parseDevice(osr2);
        assert.equal(defaultRoleFor(stroker, 'linear', 0), 'primary');
        assert.equal(defaultRoleFor(stroker, 'linear', 1), 'secondary');
        const vibe = parseDevice({ DeviceIndex: 5, DeviceName: 'Wand', DeviceMessages: { ScalarCmd: [{ ActuatorType: 'Vibrate' }] } });
        assert.equal(defaultRoleFor(vibe, 'scalar', 0), 'primary');
        assert.equal(isScalarActuator('Oscillate'), true);
        assert.equal(isScalarActuator('Rotate'), false);
    });
});

describe('one motor listed twice: what current Intiface Central shows a v3 client', () => {
    it('pairs the OSSM\'s Oscillate with its Position axis, and the Solace Pro\'s', () => {
        assert.deepEqual(oscillateTwins(parseDevice(OSSM_RAW)), [{ scalar: 0, linear: 0 }]);
        assert.deepEqual(oscillateTwins(parseDevice(SOLACE_PRO_RAW)), [{ scalar: 0, linear: 0 }]);
    });

    it('pairs nothing where the lists do not line up and no description is shared', () => {
        const machine = parseDevice({
            DeviceName: 'Two-motor rig',
            DeviceIndex: 5,
            DeviceMessages: {
                ScalarCmd: [{ FeatureDescriptor: 'Thrust', ActuatorType: 'Oscillate' }, { FeatureDescriptor: 'Vibe', ActuatorType: 'Vibrate' }],
                LinearCmd: [{ FeatureDescriptor: 'Rail A', ActuatorType: 'Position' }, { FeatureDescriptor: 'Rail B', ActuatorType: 'Position' }]
            }
        });
        assert.deepEqual(oscillateTwins(machine), []);
        assert.deepEqual(oscillateTwins(parseDevice(TCODE_V03_RAW)), [], 'a Position scalar is not an Oscillate twin');
        assert.deepEqual(oscillateTwins(null), []);
    });

    it('defaults the Oscillate twin OFF and the Position axis Primary', () => {
        const ossm = parseDevice(OSSM_RAW);
        assert.equal(defaultRoleFor(ossm, 'scalar', 0), 'off');
        assert.equal(defaultRoleFor(ossm, 'linear', 0), 'primary');
    });

    it('never drives a ScalarCmd Position: it is a position, not a level', () => {
        assert.equal(drivesAsLevel('Position'), false);
        for (const type of ['Vibrate', 'Oscillate', 'Rotate', 'Constrict', 'Inflate']) assert.equal(drivesAsLevel(type), true);
        const osr = parseDevice(TCODE_V03_RAW);
        assert.equal(defaultRoleFor(osr, 'scalar', 0), 'off');
        assert.equal(defaultRoleFor(osr, 'linear', 0), 'primary');
    });
});

// Buttplug turns a ScalarCmd level into a step with ceil(StepCount * level)
// and a LinearCmd position with trunc(StepCount * position)
// (server_device_feature.rs). These do the same in f64, as the server does.
const serverStep = (level, n) => (level < 0.000001 ? 0 : Math.ceil(n * level));
const serverPosition = (position, n) => Math.trunc(n * position);

describe('scalarLevel: the step the server lands on, never above the cap', () => {
    it('lands on the step it means for every step count and every level', () => {
        for (const n of [3, 5, 6, 7, 9, 10, 12, 15, 19, 20, 25, 50, 99, 100, 255]) {
            for (let k = 0; k <= n; k++) {
                const level = scalarLevel(k / n, n);
                assert.equal(serverStep(level, n), k, `step ${k} of ${n} sent as ${level}`);
            }
        }
    });

    it('never lets the server round a capped level above the cap', () => {
        for (const n of [3, 6, 7, 10, 12, 20, 100]) {
            for (let cap = 10; cap <= 100; cap += 5) {
                for (let speed = 0; speed <= 100; speed += 1) {
                    const level = scalarLevel((speed / 100) * (cap / 100), n, cap / 100);
                    assert.ok(serverStep(level, n) / n <= cap / 100 + 1e-12, `n=${n} cap=${cap} speed=${speed}: server step ${serverStep(level, n)}`);
                }
            }
        }
    });

    it('fixes the two ways the old 3-decimal level went over', () => {
        // 2/3 on a 3-step toy went out as 0.667: ceil(2.001) = 3, full power under a 65% cap.
        assert.equal(serverStep(Math.round((2 / 3) * 1000) / 1000, 3), 3);
        assert.equal(serverStep(scalarLevel(0.65, 3, 0.65), 3), 1);
        // 0.07 x 100 = 7.000000000000001: 7% went out as 8%.
        assert.equal(serverStep(0.07, 100), 8);
        assert.equal(serverStep(scalarLevel(0.07, 100), 100), 7);
    });

    it('keeps 1/1000 without a step count, still under the cap', () => {
        assert.equal(scalarLevel(0.4567, null), 0.457);
        assert.equal(scalarLevel(0.9, null, 0.35), 0.35);
        assert.equal(scalarLevel(-1, 20), 0);
        assert.equal(serverStep(scalarLevel(2, 20), 20), 20);
    });

    it('sends the middle of the step, so an error in the float\'s last bits cannot change it', () => {
        for (const n of [3, 7, 20, 100, 255]) {
            for (let k = 1; k <= n; k++) {
                const level = scalarLevel(k / n, n);
                assert.equal(level, (k - 0.5) / n);
                for (const off of [-1e-12, 1e-12]) assert.equal(serverStep(level + off, n), k, `${k}/${n} off by ${off}`);
                assert.ok([k - 1, k].includes(Math.round(n * level)), 'a rounding server lands on it or one under it');
                assert.ok(Math.trunc(n * level) <= k, 'a truncating one lands under it, never over');
            }
        }
    });
});

describe('linearWirePosition: the step the server lands on, inside the envelope', () => {
    it('lands inside the envelope where the plain float fell one step outside it', () => {
        // A 29% lower guard: 0.29 x 100 = 28.999999999999996, sent as 28.
        assert.equal(serverPosition(0.29, 100), 28);
        assert.equal(serverPosition(linearWirePosition(0.29, 100, { min: 0.29, max: 0.71 }), 100), 29);
    });

    it('never leaves the bounds, at any step count, for any position', () => {
        for (const n of [100, 999, 1000, 632]) {
            for (let lo = 0; lo <= 60; lo += 7) {
                const bounds = { min: lo / 100, max: (lo + 33) / 100 };
                for (let i = 0; i <= 200; i++) {
                    const p = i / 200;
                    const step = serverPosition(linearWirePosition(p, n, bounds), n);
                    assert.ok(step >= Math.ceil(bounds.min * n - 1e-9) && step <= Math.floor(bounds.max * n + 1e-9), `n=${n} bounds=${lo}..${lo + 33} p=${p}: step ${step}`);
                }
            }
        }
    });

    it('is the step the position is nearest to, sent as the middle of it', () => {
        assert.equal(serverPosition(linearWirePosition(0.8, 1000), 1000), 800);
        assert.equal(serverPosition(linearWirePosition(0.2 + 0.8 - 0.8, 1000), 1000), 200);
        assert.equal(serverPosition(linearWirePosition(0.574, 100), 100), 57);
        assert.equal(linearWirePosition(0.57, 100), 0.575);
        assert.equal(linearWirePosition(1, 100), 1);
        assert.equal(serverPosition(linearWirePosition(0, 100), 100), 0);
        assert.equal(linearWirePosition(0.1234, null), 0.123, 'without a step count: 3 decimals, as before');
        for (let k = 0; k < 100; k++) {
            const wire = linearWirePosition(k / 100, 100);
            for (const off of [-1e-12, 1e-12]) assert.equal(serverPosition(wire + off, 100), k, `step ${k} off by ${off}`);
            assert.equal(linearStep(k / 100, 100), k);
        }
        assert.equal(linearWirePosition(1, 100), 1, 'the top step is 1, which JSON carries exactly');
    });

    it('is what buildLinearCmd sends when the axis\'s step count and bounds come with it', () => {
        const cmd = buildLinearCmd(9, 0, [{ index: 0, position: 0.29, durationMs: 400, stepCount: 100, bounds: { min: 0.29, max: 1 } }]);
        assert.equal(serverPosition(cmd.LinearCmd.Vectors[0].Position, 100), 29);
    });
});

describe('a rotator listed twice is driven once', () => {
    // protocols/lovense.yml, "Lovense Nora": vibrate 0..20 and rotate -20..20.
    // A rotate output turning both ways reaches a v3 client in ScalarCmd AND RotateCmd.
    const NORA_RAW = {
        DeviceName: 'Lovense Nora',
        DeviceIndex: 3,
        DeviceMessages: {
            ScalarCmd: [{ FeatureDescriptor: '', StepCount: 20, ActuatorType: 'Vibrate' }, { FeatureDescriptor: '', StepCount: 20, ActuatorType: 'Rotate' }],
            RotateCmd: [{ FeatureDescriptor: '', StepCount: 20 }],
            StopDeviceCmd: {}
        }
    };

    it('finds the ScalarCmd Rotate that RotateCmd lists again, and defaults it OFF', () => {
        const nora = parseDevice(NORA_RAW);
        assert.deepEqual(rotateDuplicates(nora), [1]);
        assert.equal(defaultRoleFor(nora, 'scalar', 1), 'off');
        assert.equal(defaultRoleFor(nora, 'rotate', 0), 'primary');
    });

    it('leaves a one-way rotator that only ScalarCmd lists alone', () => {
        const oneWay = parseDevice({ DeviceName: 'Spinner', DeviceIndex: 1, DeviceMessages: { ScalarCmd: [{ StepCount: 10, ActuatorType: 'Rotate' }] } });
        assert.deepEqual(rotateDuplicates(oneWay), []);
    });
});

describe('a Max Power Cap on a stepped toy is one of its steps', () => {
    it('offers every step from 10% (or the first step, when that is above it) to full power', () => {
        assert.equal(MIN_AXIS_CAP_PERCENT, 10);
        assert.deepEqual(capChoices(3).map((c) => c.steps), [1, 2, 3]);
        assert.deepEqual(capChoices(1), [{ steps: 1, percent: 100 }]);
        assert.deepEqual(capChoices(20).map((c) => c.percent), [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]);
        assert.equal(capChoices(12)[0].steps, 2, '1/12 is under 10%: the first choice is 2/12');
        assert.equal(capChoices(100).length, 91);
        assert.deepEqual(capChoices(null), []);
    });

    it('reads every choice back as its own step', () => {
        for (const n of [1, 2, 3, 7, 12, 20, 50, 100, 255, 1000]) {
            for (const { steps, percent } of capChoices(n)) assert.equal(capSteps(percent, n), steps, `${steps}/${n} stored as ${percent}`);
            assert.equal(capStepPercent(n, n), 100);
        }
    });

    it('never stops a toy that ran: a saved cap under the first step but at least half of it is that step', () => {
        // The Libo Shark (3 steps) at the default-looking 30%, Hismith's 1-step vibrator at 90%:
        // under the strict cap both were sent 0 for ever.
        assert.equal(capSteps(30, 3), 1);
        assert.equal(capSteps(90, 1), 1);
        assert.equal(capSteps(50, 1), 1);
        // Under half the first step the toy did not run before either: it stays off.
        assert.equal(capSteps(10, 3), 0);
        assert.equal(capSteps(40, 1), 0);
        // Between two steps: the step under it.
        assert.equal(capSteps(38, 20), 7);
        assert.equal(capSteps(65, 3), 1);
        assert.equal(capSteps(100, 3), 3);
        assert.equal(capSteps(55, null), null);
    });

    it('lets no choice on any step count leave a toy that cannot run at full speed', () => {
        for (let n = 1; n <= 30; n++) {
            for (const { percent } of capChoices(n)) assert.ok(capSteps(percent, n) >= 1, `n=${n} cap ${percent}`);
        }
    });
});
