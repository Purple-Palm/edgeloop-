// Buttplug protocol v3 message helpers (Intiface Central). Pure: builders,
// parsers and classifiers only, so the driver's wire format is unit-tested
// without a socket. Facts checked against the spec at docs.buttplug.io:
//   - every frame is a JSON array of message objects;
//   - client Ids are >= 1, the server uses Id 0 for what it initiates;
//   - MaxPingTime > 0 means the client must Ping at least that often;
//   - DeviceMessages attribute arrays carry NO Index: the index is the
//     array position.

export const BUTTPLUG_MESSAGE_VERSION = 3;
export const CLIENT_NAME = 'EdgeLoop';

export const ERROR_CODES = {
    0: 'unknown',
    1: 'handshake',
    2: 'ping',
    3: 'message',
    4: 'device',
    5: 'unknown'
};

export const SCALAR_TYPES = ['Vibrate', 'Oscillate', 'Inflate', 'Constrict', 'Position'];

export function isScalarActuator(type) {
    return SCALAR_TYPES.includes(type);
}

// A ScalarCmd "Position" actuator takes a position, not a level. Current
// Buttplug lists one beside the LinearCmd of the same feature on T-Code
// strokers (OSR2, SR6, an OSSM on T-Code firmware), Umove and its simulated
// stroker, so a level sent to it moved the stroke: the secondary channel's
// intensity became where the axis jumped to between legs, and the 0 of a
// stop a jump to the end of the travel. EdgeLoop drives that motor through
// its LinearCmd axis alone and sends this one nothing.
export function drivesAsLevel(type) {
    return type !== 'Position';
}

function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function stepsOf(stepCount) {
    const n = Math.round(Number(stepCount));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// The next double up or down from x (x > 0), for the two encoders below.
function nudge(x, up) {
    const f = new Float64Array([x]);
    const bits = new BigInt64Array(f.buffer);
    bits[0] += up ? 1n : -1n;
    return f[0];
}

// The ScalarCmd / RotateCmd level for `value` (0..1) on an actuator with
// `stepCount` steps, never above `cap` (0..1): the nearest step at or under
// the cap, as a float the server turns back into that very step. Buttplug
// multiplies by StepCount and rounds UP (server_device_feature.rs,
// calculate_scaled_float), so a float a hair above a step is the next step:
// 0.07 x 100 is 7.000000000000001 and went out as 8, and the 3-decimal
// rounding used before did it for every step count 1000 is not a multiple
// of - 2/3 sent as 0.667 is ceil(2.001) = 3, full power on a 3-step toy
// under a 65% cap. Without a step count the level is rounded to 1/1000,
// still never above the cap.
export function scalarLevel(value, stepCount, cap = 1) {
    const v = clamp01(value);
    const top = clamp01(cap);
    const n = stepsOf(stepCount);
    if (!n) return Math.min(Math.round(v * 1000), Math.floor(top * 1000 + 1e-9)) / 1000;
    const step = Math.min(Math.round(v * n), Math.floor(top * n + 1e-9));
    if (step <= 0) return 0;
    if (step >= n) return 1;
    let level = step / n;
    for (let i = 0; i < 8 && Math.ceil(level * n) > step; i++) level = nudge(level, false);
    return level;
}

// The LinearCmd Position for `position` (0..1) on an axis with `stepCount`
// steps: the nearest step inside `bounds` (the travel envelope, 0..1), as a
// float the server turns back into that very step. Buttplug multiplies by
// StepCount and TRUNCATES for hw_position_with_duration
// (server_device_feature.rs): 0.29 x 100 is 28.999999999999996, so a 29%
// lower guard went out as 28% - on an OSSM, whose 0 is full extension, 1%
// deeper than the wearer allowed. Without a step count: 1/1000, as before.
export function linearWirePosition(position, stepCount, bounds = { min: 0, max: 1 }) {
    const p = clamp01(position);
    const n = stepsOf(stepCount);
    if (!n) return Math.round(p * 1000) / 1000;
    const lo = Math.ceil(clamp01(bounds && bounds.min) * n - 1e-9);
    const hi = Math.floor(clamp01(bounds && bounds.max !== undefined ? bounds.max : 1) * n + 1e-9);
    let step = Math.round(p * n);
    if (lo <= hi) step = Math.max(lo, Math.min(hi, step));
    if (step <= 0) return 0;
    if (step >= n) return 1;
    let wire = step / n;
    for (let i = 0; i < 8 && wire * n < step; i++) wire = nudge(wire, true);
    return wire;
}

// ---- builders -------------------------------------------------------------

export function buildRequestServerInfo(id, clientName = CLIENT_NAME) {
    return { RequestServerInfo: { Id: id, ClientName: clientName, MessageVersion: BUTTPLUG_MESSAGE_VERSION } };
}

export function buildPing(id) {
    return { Ping: { Id: id } };
}

export function buildRequestDeviceList(id) {
    return { RequestDeviceList: { Id: id } };
}

export function buildStartScanning(id) {
    return { StartScanning: { Id: id } };
}

export function buildStopScanning(id) {
    return { StopScanning: { Id: id } };
}

export function buildStopAllDevices(id) {
    return { StopAllDevices: { Id: id } };
}

export function buildStopDeviceCmd(id, deviceIndex) {
    return { StopDeviceCmd: { Id: id, DeviceIndex: deviceIndex } };
}

export function buildScalarCmd(id, deviceIndex, scalars) {
    return {
        ScalarCmd: {
            Id: id,
            DeviceIndex: deviceIndex,
            Scalars: scalars.map((s) => ({ Index: s.index, Scalar: clamp01(s.scalar), ActuatorType: s.actuatorType }))
        }
    };
}

export function buildLinearCmd(id, deviceIndex, vectors) {
    return {
        LinearCmd: {
            Id: id,
            DeviceIndex: deviceIndex,
            Vectors: vectors.map((v) => ({
                Index: v.index,
                Duration: Math.max(0, Math.round(Number(v.durationMs) || 0)),
                // On the axis's own step grid inside its bounds when its
                // StepCount is known (linearWirePosition); otherwise 3
                // decimals, which keeps 1 - 0.8 from becoming
                // 0.19999999999999996.
                Position: linearWirePosition(v.position, v.stepCount, v.bounds)
            }))
        }
    };
}

export function buildRotateCmd(id, deviceIndex, rotations) {
    return {
        RotateCmd: {
            Id: id,
            DeviceIndex: deviceIndex,
            Rotations: rotations.map((r) => ({ Index: r.index, Speed: clamp01(r.speed), Clockwise: r.clockwise !== false }))
        }
    };
}

export function buildSensorReadCmd(id, deviceIndex, sensorIndex, sensorType = 'Battery') {
    return { SensorReadCmd: { Id: id, DeviceIndex: deviceIndex, SensorIndex: sensorIndex, SensorType: sensorType } };
}

// Wire encoding of one or more messages: always a JSON array.
export function encodeFrame(messages) {
    return JSON.stringify(Array.isArray(messages) ? messages : [messages]);
}

// ---- parsers --------------------------------------------------------------

// Decode one frame into an array of message objects. Corrupt JSON, a bare
// object instead of an array, or non-object entries yield [] / are skipped.
export function decodeFrame(data) {
    let parsed;
    try {
        parsed = typeof data === 'string' ? JSON.parse(data) : data;
    } catch (e) {
        return [];
    }
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') parsed = [parsed];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m) => m && typeof m === 'object' && !Array.isArray(m));
}

// { type, id, body } for one message object; type 'unknown' when the object
// is not a single-key Buttplug message.
export function classifyMessage(msg) {
    if (!msg || typeof msg !== 'object') return { type: 'unknown', id: 0, body: null };
    const keys = Object.keys(msg);
    if (keys.length !== 1) return { type: 'unknown', id: 0, body: null };
    const type = keys[0];
    const body = msg[type] && typeof msg[type] === 'object' ? msg[type] : {};
    const id = Number.isInteger(body.Id) ? body.Id : 0;
    return { type, id, body };
}

export function parseServerInfo(body) {
    if (!body || typeof body !== 'object') return null;
    const version = Number(body.MessageVersion);
    const maxPing = Number(body.MaxPingTime);
    return {
        serverName: typeof body.ServerName === 'string' && body.ServerName ? body.ServerName : 'Intiface',
        messageVersion: Number.isFinite(version) ? version : 0,
        maxPingTime: Number.isFinite(maxPing) && maxPing > 0 ? maxPing : 0
    };
}

// Ping cadence for a given MaxPingTime: half the server's limit, never
// below 100 ms; 0 means the server does not require pings.
export function pingIntervalMs(maxPingTime) {
    const max = Number(maxPingTime);
    if (!Number.isFinite(max) || max <= 0) return 0;
    return Math.max(100, Math.floor(max / 2));
}

export function describeError(body) {
    const code = Number(body && body.ErrorCode);
    const kind = ERROR_CODES[code] || 'unknown';
    const message = body && typeof body.ErrorMessage === 'string' && body.ErrorMessage
        ? body.ErrorMessage
        : `Intiface error (code ${Number.isFinite(code) ? code : '?'})`;
    return {
        code: Number.isFinite(code) ? code : 0,
        kind,
        message,
        // A handshake failure or a ping timeout ends the connection on the
        // server side; the client should close and report, not retry blindly.
        fatal: kind === 'handshake' || kind === 'ping',
        unsolicited: !(body && Number.isInteger(body.Id) && body.Id > 0)
    };
}

// One attribute list of a v3 DeviceMessages entry. The v3 spec uses arrays
// without Index (position = index); the v2-era object form {FeatureCount,
// ActuatorType} is still tolerated.
function attributeList(cmd, defaultType, typeKey) {
    if (!cmd) return [];
    if (Array.isArray(cmd)) {
        return cmd.map((attr, i) => ({
            index: Number.isInteger(attr && attr.Index) ? attr.Index : i,
            actuatorType: (attr && attr[typeKey]) || defaultType,
            stepCount: Number.isFinite(Number(attr && attr.StepCount)) ? Number(attr.StepCount) : null,
            descriptor: (attr && attr.FeatureDescriptor) || '',
            sensorRange: (attr && attr.SensorRange) || null
        }));
    }
    if (typeof cmd === 'object') {
        const count = Math.max(1, Number(cmd.FeatureCount) || 1);
        return Array.from({ length: count }, (_, i) => ({
            index: i,
            actuatorType: cmd[typeKey] || defaultType,
            stepCount: null,
            descriptor: '',
            sensorRange: null
        }));
    }
    return [];
}

// Normalise a DeviceList / DeviceAdded device entry.
export function parseDevice(dev) {
    if (!dev || typeof dev !== 'object') return null;
    const deviceIndex = Number(dev.DeviceIndex);
    if (!Number.isInteger(deviceIndex)) return null;
    const messages = dev.DeviceMessages && typeof dev.DeviceMessages === 'object' ? dev.DeviceMessages : {};
    const scalars = attributeList(messages.ScalarCmd, 'Vibrate', 'ActuatorType');
    const linears = attributeList(messages.LinearCmd, 'Position', 'ActuatorType');
    const rotations = attributeList(messages.RotateCmd, 'Rotate', 'ActuatorType');
    const sensors = attributeList(messages.SensorReadCmd, 'Battery', 'SensorType')
        .map((s) => ({ index: s.index, sensorType: s.actuatorType, descriptor: s.descriptor, sensorRange: s.sensorRange }));
    const battery = sensors.find((s) => s.sensorType === 'Battery');
    const name = typeof dev.DeviceName === 'string' && dev.DeviceName ? dev.DeviceName : `Device ${deviceIndex}`;
    return {
        deviceIndex,
        name,
        displayName: typeof dev.DeviceDisplayName === 'string' && dev.DeviceDisplayName ? dev.DeviceDisplayName : name,
        timingGapMs: Number(dev.DeviceMessageTimingGap) > 0 ? Number(dev.DeviceMessageTimingGap) : 0,
        scalars,
        linears,
        rotations,
        sensors,
        batterySensorIndex: battery ? battery.index : null,
        canStop: Boolean(messages.StopDeviceCmd)
    };
}

// Stable key for persisting a device's mapping: the name plus the actuator
// layout, so a re-enumerated device (new DeviceIndex) still finds its roles
// while a differently-configured device with the same name does not.
export function deviceSignature(parsed) {
    if (!parsed) return '';
    const sig = (list) => list.map((a) => a.actuatorType).join(',');
    return `${parsed.name}|S:${sig(parsed.scalars)}|L:${sig(parsed.linears)}|R:${sig(parsed.rotations)}`;
}

// Default role for each actuator on a freshly discovered device: the first
// stroke-capable axis is primary, the rest secondary; an internal toy
// (prostate massager / Lovense Edge) defaults to secondary everywhere. A
// scalar EdgeLoop does not drive (drivesAsLevel) is OFF, and so is the
// Oscillate twin of a linear axis (oscillateTwins): the linear axis is the
// one that keeps the stroke inside the travel envelope.
export function defaultRoleFor(parsed, kind, position) {
    if (kind === 'scalar' && parsed && Array.isArray(parsed.scalars)) {
        const attr = parsed.scalars[position];
        if (attr && !drivesAsLevel(attr.actuatorType)) return 'off';
        if (oscillateTwins(parsed).some((t) => t.scalar === position)) return 'off';
    }
    const lower = (parsed && parsed.name ? parsed.name : '').toLowerCase();
    const looksInternal = lower.includes('prostate') || lower.includes('edge') || lower.includes('hush');
    if (looksInternal) return 'secondary';
    if (kind === 'linear') return position === 0 ? 'primary' : 'secondary';
    if (kind === 'rotate') return (position === 0 && parsed.linears.length === 0) ? 'primary' : 'secondary';
    return (position === 0 && parsed.linears.length === 0 && parsed.rotations.length === 0) ? 'primary' : 'secondary';
}

// Which Oscillate scalar and which linear axis of a device are one motor.
// Buttplug describes a device by features, and a feature with both an
// `oscillate` and a `hw_position_with_duration` output - the OSSM ("Kinky
// Makers OSSM", device-config/protocols/ossm.yml) and the Lovense Solace
// Pro - reaches a v3 client twice: once in ScalarCmd (Oscillate), once in
// LinearCmd, each list in feature order and both entries carrying the
// feature's description as FeatureDescriptor
// (message/v3/server_device_message_attributes.rs). Nothing else links them.
// They are two modes of one motor, not two motors: on the OSSM, Buttplug
// answers every command for the mode the machine is not in with "go:menu"
// first (protocol_impl/ossm.rs), and the OSSM firmware runs its emergency
// stop on that from either mode (src/ossm/state/machine.h) - driven both at
// once, the machine flipped and stopped on nearly every command. Paired by
// order when the two lists are as long and their descriptors agree, else by
// a non-empty descriptor only the two share. Returns [{ scalar, linear }] as
// positions in parsed.scalars / parsed.linears.
export function oscillateTwins(parsed) {
    if (!parsed || !Array.isArray(parsed.scalars) || !Array.isArray(parsed.linears)) return [];
    const osc = parsed.scalars.map((a, pos) => ({ a, pos })).filter(({ a }) => a.actuatorType === 'Oscillate');
    const lin = parsed.linears.map((a, pos) => ({ a, pos }));
    if (osc.length === 0 || lin.length === 0) return [];
    if (osc.length === lin.length && osc.every((o, i) => o.a.descriptor === lin[i].a.descriptor)) {
        return osc.map((o, i) => ({ scalar: o.pos, linear: lin[i].pos }));
    }
    const pairs = [];
    osc.forEach((o) => {
        const d = o.a.descriptor;
        if (!d) return;
        const sameLin = lin.filter((l) => l.a.descriptor === d);
        const sameOsc = osc.filter((x) => x.a.descriptor === d);
        if (sameLin.length === 1 && sameOsc.length === 1) pairs.push({ scalar: o.pos, linear: sameLin[0].pos });
    });
    return pairs;
}
