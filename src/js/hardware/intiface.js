export let intifaceSocket = null;
export let intifaceDevices = new Map();
let intifaceMsgId = 1;

function sendMsg(payload) {
    if (!intifaceSocket || intifaceSocket.readyState !== WebSocket.OPEN) return;
    try {
        intifaceSocket.send(JSON.stringify([payload]));
    } catch (e) {}
}

function featureList(cmd, defaultType) {
    if (!cmd) return [];
    if (Array.isArray(cmd)) return cmd;
    const count = Number(cmd.FeatureCount) || 1;
    return Array.from({ length: count }, (_, i) => ({
        Index: i,
        ActuatorType: cmd.ActuatorType || defaultType
    }));
}

function isScalarType(type) {
    return type === 'Vibrate' || type === 'Oscillate' || type === 'Inflate' || type === 'Constrict';
}

export function connectIntifaceServer(url, { onOpen, onDevicesChanged, onError, onClose }) {
    intifaceSocket = new WebSocket(url);

    intifaceSocket.onopen = () => {
        sendMsg({
            RequestServerInfo: { Id: intifaceMsgId++, ClientName: 'EdgeLoop', MessageVersion: 3 }
        });
        if (onOpen) onOpen();
    };

    intifaceSocket.onmessage = (event) => {
        try {
            const msgs = JSON.parse(event.data);
            msgs.forEach((msg) => {
                if (msg.ServerInfo) {
                    sendMsg({ RequestDeviceList: { Id: intifaceMsgId++ } });
                    sendMsg({ StartScanning: { Id: intifaceMsgId++ } });
                }
                if (msg.DeviceList && msg.DeviceList.Devices) {
                    msg.DeviceList.Devices.forEach((dev) => addDiscoveredDevice(dev));
                    if (onDevicesChanged) onDevicesChanged();
                }
                if (msg.DeviceAdded) {
                    addDiscoveredDevice(msg.DeviceAdded);
                    if (onDevicesChanged) onDevicesChanged();
                }
                if (msg.DeviceRemoved) {
                    intifaceDevices.delete(msg.DeviceRemoved.DeviceIndex);
                    if (onDevicesChanged) onDevicesChanged();
                }
                if (msg.SensorReading && msg.SensorReading.SensorType === 'Battery') {
                    const dev = intifaceDevices.get(msg.SensorReading.DeviceIndex);
                    if (dev && msg.SensorReading.Data && msg.SensorReading.Data.length > 0) {
                        dev.battery = msg.SensorReading.Data[0];
                        if (onDevicesChanged) onDevicesChanged();
                    }
                }
            });
        } catch (e) {}
    };

    intifaceSocket.onerror = () => { if (onError) onError(); };
    intifaceSocket.onclose = () => {
        intifaceDevices.clear();
        if (onClose) onClose();
    };
}

export function disconnectIntiface() {
    if (intifaceSocket) intifaceSocket.close();
}

export function rescanIntiface() {
    sendMsg({ StartScanning: { Id: intifaceMsgId++ } });
}

function addDiscoveredDevice(dev) {
    const lower = (dev.DeviceName || '').toLowerCase();
    const raw = dev.DeviceMessages || {};
    const scalarList = featureList(raw.ScalarCmd, 'Vibrate');
    const linearList = featureList(raw.LinearCmd, 'Linear');
    const rotateList = featureList(raw.RotateCmd, 'Rotate');
    const sensorList = featureList(raw.SensorReadCmd, 'Battery');

    const axes = [];

    scalarList.forEach((s, idx) => {
        const type = s.ActuatorType || 'Vibrate';
        const looksInternal = lower.includes('prostate') || lower.includes('edge') || lower.includes('lovense edge');
        const defaultRole = (axes.length === 0 && !looksInternal) ? 'primary' : 'secondary';
        axes.push({
            index: s.Index ?? idx,
            type,
            role: defaultRole,
            maxCap: 100,
            linearDir: 1,
            busyUntil: 0,
            lastPos: 0.5
        });
    });

    linearList.forEach((l, idx) => {
        axes.push({
            index: l.Index ?? idx,
            type: 'Linear',
            role: idx === 0 ? 'primary' : 'secondary',
            maxCap: 100,
            linearDir: 1,
            busyUntil: 0,
            lastPos: 0.2
        });
    });

    rotateList.forEach((r, idx) => {
        const rIndex = r.Index ?? idx;
        if (axes.some((a) => a.type === 'Rotate' && a.index === rIndex)) return;
        axes.push({
            index: rIndex,
            type: 'Rotate',
            role: idx === 0 ? 'primary' : 'secondary',
            maxCap: 100,
            linearDir: 1,
            busyUntil: 0,
            lastPos: 0.5
        });
    });

    if (axes.length === 0) {
        axes.push({
            index: 0,
            type: 'Vibrate',
            role: 'primary',
            maxCap: 100,
            linearDir: 1,
            busyUntil: 0,
            lastPos: 0.5
        });
    }

    const hasBattery = sensorList.some((s) => s.SensorType === 'Battery');

    intifaceDevices.set(dev.DeviceIndex, {
        name: dev.DeviceName,
        axes,
        clockwise: true,
        hasBattery,
        battery: null
    });

    if (hasBattery) {
        sendMsg({
            SensorReadCmd: {
                Id: intifaceMsgId++,
                DeviceIndex: dev.DeviceIndex,
                SensorIndex: 0,
                SensorType: 'Battery'
            }
        });
    }
}

export function setAxisRole(devIdx, axisIdx, role) {
    const dev = intifaceDevices.get(devIdx);
    if (dev && dev.axes[axisIdx]) {
        dev.axes[axisIdx].role = role;
    }
}

export function setAxisMaxCap(devIdx, axisIdx, maxCap) {
    const dev = intifaceDevices.get(devIdx);
    if (dev && dev.axes[axisIdx]) {
        dev.axes[axisIdx].maxCap = maxCap;
    }
}

export function testSingleAxis(devIdx, axisIdx) {
    const dev = intifaceDevices.get(devIdx);
    if (!dev || !intifaceSocket || intifaceSocket.readyState !== WebSocket.OPEN) return;
    const axis = dev.axes[axisIdx];
    const testScalar = 0.6 * ((axis.maxCap ?? 100) / 100);

    if (isScalarType(axis.type) || axis.type === 'Position') {
        sendMsg({
            ScalarCmd: {
                Id: intifaceMsgId++,
                DeviceIndex: devIdx,
                Scalars: [{ Index: axis.index, Scalar: testScalar, ActuatorType: axis.type }]
            }
        });
        setTimeout(() => {
            sendMsg({
                ScalarCmd: {
                    Id: intifaceMsgId++,
                    DeviceIndex: devIdx,
                    Scalars: [{ Index: axis.index, Scalar: 0.0, ActuatorType: axis.type }]
                }
            });
        }, 1000);
        return;
    }

    if (axis.type === 'Rotate') {
        sendMsg({
            RotateCmd: {
                Id: intifaceMsgId++,
                DeviceIndex: devIdx,
                Rotations: [{ Index: axis.index, Speed: testScalar, Clockwise: true }]
            }
        });
        setTimeout(() => {
            sendMsg({
                RotateCmd: {
                    Id: intifaceMsgId++,
                    DeviceIndex: devIdx,
                    Rotations: [{ Index: axis.index, Speed: 0, Clockwise: true }]
                }
            });
        }, 1000);
        return;
    }

    if (axis.type === 'Linear') {
        sendMsg({
            LinearCmd: {
                Id: intifaceMsgId++,
                DeviceIndex: devIdx,
                Vectors: [{ Index: axis.index, Duration: 450, Position: 0.75 }]
            }
        });
        setTimeout(() => {
            sendMsg({
                LinearCmd: {
                    Id: intifaceMsgId++,
                    DeviceIndex: devIdx,
                    Vectors: [{ Index: axis.index, Duration: 450, Position: 0.2 }]
                }
            });
        }, 500);
    }
}

function strokeDurationMs(speedPercent, travel) {
    const speed = Math.max(0, Math.min(100, speedPercent));
    const span = Math.max(0.08, travel);
    const minMs = 180;
    const maxMs = 2200;
    const duration = minMs + ((100 - speed) / 100) * (maxMs - minMs);
    return Math.round(duration * span);
}

export function dispatchIntiface(primarySpeed, secondarySpeed, strokeMin = 0, strokeMax = 100) {
    if (!intifaceSocket || intifaceSocket.readyState !== WebSocket.OPEN || intifaceDevices.size === 0) return;
    const now = Date.now();
    const minPos = Math.max(0, Math.min(1, strokeMin / 100));
    const maxPos = Math.max(minPos, Math.min(1, strokeMax / 100));

    intifaceDevices.forEach((dev, devIdx) => {
        const scalars = [];
        const rotations = [];
        const linears = [];

        dev.axes.forEach((axis) => {
            if (axis.role === 'off') {
                if (isScalarType(axis.type) || axis.type === 'Position') {
                    scalars.push({ Index: axis.index, Scalar: 0.0, ActuatorType: axis.type });
                } else if (axis.type === 'Rotate') {
                    rotations.push({ Index: axis.index, Speed: 0, Clockwise: dev.clockwise ?? true });
                } else if (axis.type === 'Linear') {
                    linears.push({
                        Index: axis.index,
                        Duration: 120,
                        Position: axis.lastPos ?? minPos
                    });
                    axis.busyUntil = 0;
                }
                return;
            }

            const targetPercent = (axis.role === 'primary') ? primarySpeed : secondarySpeed;
            const cappedPercent = targetPercent * ((axis.maxCap ?? 100) / 100);
            const scalarVal = Math.max(0, Math.min(1, cappedPercent / 100));

            if (isScalarType(axis.type) || axis.type === 'Position') {
                scalars.push({
                    Index: axis.index,
                    Scalar: scalarVal,
                    ActuatorType: axis.type
                });
            } else if (axis.type === 'Rotate') {
                rotations.push({
                    Index: axis.index,
                    Speed: scalarVal,
                    Clockwise: dev.clockwise ?? true
                });
            } else if (axis.type === 'Linear') {
                if (axis.role === 'off' || cappedPercent <= 0) {
                    linears.push({
                        Index: axis.index,
                        Duration: 120,
                        Position: axis.lastPos ?? minPos
                    });
                    axis.busyUntil = 0;
                } else if (now < (axis.busyUntil || 0)) {
                    linears.push({
                        Index: axis.index,
                        Duration: Math.max(80, (axis.busyUntil || now) - now),
                        Position: axis.lastPos ?? minPos
                    });
                } else {
                    const travel = Math.max(0.08, maxPos - minPos);
                    const goingHigh = (axis.linearDir || 1) > 0;
                    const position = goingHigh ? maxPos : minPos;
                    const duration = Math.max(120, strokeDurationMs(cappedPercent, travel));
                    axis.linearDir = goingHigh ? -1 : 1;
                    axis.lastPos = position;
                    axis.busyUntil = now + duration;
                    linears.push({ Index: axis.index, Duration: duration, Position: position });
                }
            }
        });

        if (scalars.length > 0) {
            sendMsg({ ScalarCmd: { Id: intifaceMsgId++, DeviceIndex: devIdx, Scalars: scalars } });
        }
        if (rotations.length > 0) {
            sendMsg({ RotateCmd: { Id: intifaceMsgId++, DeviceIndex: devIdx, Rotations: rotations } });
        }
        if (linears.length > 0) {
            sendMsg({ LinearCmd: { Id: intifaceMsgId++, DeviceIndex: devIdx, Vectors: linears } });
        }
    });
}
