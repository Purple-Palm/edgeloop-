export let intifaceSocket = null;
export let intifaceDevices = new Map();
let intifaceMsgId = 1;

export function connectIntifaceServer(url, { onOpen, onDevicesChanged, onError, onClose }) {
    intifaceSocket = new WebSocket(url);

    intifaceSocket.onopen = () => {
        intifaceSocket.send(JSON.stringify([{
            RequestServerInfo: { Id: intifaceMsgId++, ClientName: "EdgeLoop", MessageVersion: 3 }
        }]));
        if (onOpen) onOpen();
    };

        intifaceSocket.onmessage = (event) => {
            try {
                const msgs = JSON.parse(event.data);
                msgs.forEach(msg => {
                    if (msg.ServerInfo) {
                        intifaceSocket.send(JSON.stringify([{ RequestDeviceList: { Id: intifaceMsgId++ } }]));
                        intifaceSocket.send(JSON.stringify([{ StartScanning: { Id: intifaceMsgId++ } }]));
                    }
                    if (msg.DeviceList && msg.DeviceList.Devices) {
                        msg.DeviceList.Devices.forEach(dev => addDiscoveredDevice(dev));
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
                    if (msg.SensorReading && msg.SensorReading.SensorType === "Battery") {
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
    if (intifaceSocket && intifaceSocket.readyState === WebSocket.OPEN) {
        intifaceSocket.send(JSON.stringify([{ StartScanning: { Id: intifaceMsgId++ } }]));
    }
}

function addDiscoveredDevice(dev) {
    const lower = dev.DeviceName.toLowerCase();
    const raw = dev.DeviceMessages || {};
    const scalarList = raw.ScalarCmd || [];
    const linearList = raw.LinearCmd || [];
    const rotateList = raw.RotateCmd || [];
    const sensorList = raw.SensorReadCmd || [];

    const axes = [];

    scalarList.forEach((s, idx) => {
        const type = s.ActuatorType || "Vibrate";
        const defaultRole = (axes.length === 0 && !lower.includes('prostate') && !lower.includes('edge')) ? 'primary' : 'secondary';
        axes.push({
            index: s.Index ?? idx,
            type: type,
            role: defaultRole,
            maxCap: 100 // Umbra250 max power cap
        });
    });

    linearList.forEach((l, idx) => {
        axes.push({
            index: l.Index ?? idx,
            type: "Linear",
            role: "primary",
            maxCap: 100
        });
    });

    if (raw.RotateCmd) {
        const rCount = rotateList.length || 1;
        for (let r = 0; r < rCount; r++) {
            if (!axes.some(a => a.type === "Rotate" && a.index === r)) {
                axes.push({
                    index: r,
                    type: "Rotate",
                    role: "primary",
                    maxCap: 100
                });
            }
        }
    }

    if (axes.length === 0) {
        axes.push({ index: 0, type: "Vibrate", role: "primary", maxCap: 100 });
    }

    const hasBattery = sensorList.some(s => s.SensorType === "Battery");

    intifaceDevices.set(dev.DeviceIndex, {
        name: dev.DeviceName,
        axes: axes,
        clockwise: true,
        hasBattery: hasBattery,
        battery: null,
        linearPos: -1,
        lastLinearTick: 0
    });

    if (hasBattery && intifaceSocket && intifaceSocket.readyState === WebSocket.OPEN) {
        intifaceSocket.send(JSON.stringify([{
            SensorReadCmd: { Id: intifaceMsgId++, DeviceIndex: dev.DeviceIndex, SensorIndex: 0, SensorType: "Battery" }
        }]));
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

    const testScalar = 0.6 * (axis.maxCap / 100);

    if (axis.type === "Vibrate" || axis.type === "Oscillate") {
        intifaceSocket.send(JSON.stringify([{
            ScalarCmd: { Id: intifaceMsgId++, DeviceIndex: devIdx, Scalars: [{ Index: axis.index, Scalar: testScalar, ActuatorType: axis.type }] }
        }]));
        setTimeout(() => {
            if (intifaceSocket && intifaceSocket.readyState === WebSocket.OPEN) {
                intifaceSocket.send(JSON.stringify([{
                    ScalarCmd: { Id: intifaceMsgId++, DeviceIndex: devIdx, Scalars: [{ Index: axis.index, Scalar: 0.0, ActuatorType: axis.type }] }
                }]));
            }
        }, 1000);
    }
}

export function dispatchIntiface(primarySpeed, secondarySpeed) {
    if (!intifaceSocket || intifaceSocket.readyState !== WebSocket.OPEN || intifaceDevices.size === 0) return;

    intifaceDevices.forEach((dev, devIdx) => {
        const scalars = [];
        const rotations = [];

        dev.axes.forEach(axis => {
            if (axis.role === 'off') {
                if (axis.type === "Vibrate" || axis.type === "Oscillate") {
                    scalars.push({ Index: axis.index, Scalar: 0.0, ActuatorType: axis.type });
                }
                return;
            }

            const targetPercent = (axis.role === 'primary') ? primarySpeed : secondarySpeed;
            const cappedPercent = targetPercent * ((axis.maxCap ?? 100) / 100);
            const scalarVal = cappedPercent / 100;

            if (axis.type === "Vibrate" || axis.type === "Oscillate") {
                scalars.push({
                    Index: axis.index,
                    Scalar: scalarVal,
                    ActuatorType: axis.type
                });
            } else if (axis.type === "Rotate") {
                rotations.push({
                    Index: axis.index,
                    Speed: scalarVal,
                    Clockwise: dev.clockwise ?? true
                });
            }
        });

        if (scalars.length > 0) {
            try {
                intifaceSocket.send(JSON.stringify([{
                    ScalarCmd: { Id: intifaceMsgId++, DeviceIndex: devIdx, Scalars: scalars }
                }]));
            } catch (e) {}
        }

        if (rotations.length > 0) {
            try {
                intifaceSocket.send(JSON.stringify([{
                    RotateCmd: { Id: intifaceMsgId++, DeviceIndex: devIdx, Rotations: rotations }
                }]));
            } catch (e) {}
        }
    });
}
