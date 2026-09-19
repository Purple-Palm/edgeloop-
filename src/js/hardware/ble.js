export let bleDeviceRef = null;

export async function connectBleHeartRate({ onHrMeasurement, onBatteryLevel, onDisconnected }) {
    if (!navigator.bluetooth) throw new Error("Web Bluetooth not supported");

    const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['heart_rate'] }],
        optionalServices: ['battery_service']
    });

    bleDeviceRef = device;

    device.addEventListener('gattserverdisconnected', () => {
        bleDeviceRef = null;
        if (onDisconnected) onDisconnected();
    });

        const server = await device.gatt.connect();
        const hrService = await server.getPrimaryService('heart_rate');
        const char = await hrService.getCharacteristic('heart_rate_measurement');
        await char.startNotifications();

        char.addEventListener('characteristicvaluechanged', (event) => {
            const value = event.target.value;
            const flags = value.getUint8(0);
            const hr = (flags & 0x01) ? value.getUint16(1, true) : value.getUint8(1);
            onHrMeasurement(hr);
        });

        try {
            const batService = await server.getPrimaryService('battery_service');
            const batChar = await batService.getCharacteristic('battery_level');
            const batVal = await batChar.readValue();
            if (onBatteryLevel) onBatteryLevel(batVal.getUint8(0));
        } catch (e) {}

        return device;
}

export function disconnectBle() {
    if (bleDeviceRef && bleDeviceRef.gatt && bleDeviceRef.gatt.connected) {
        bleDeviceRef.gatt.disconnect();
    }
}
