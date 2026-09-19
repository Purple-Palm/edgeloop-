export let handyConnected = false;
let handyIsHampRunning = false;
let handyLastSend = 0;
let handyLastStrokeSend = 0;
let handyLastStrokeSentVal = -1;

export async function connectHandy(key) {
    const res = await fetch('https://www.handyfeeling.com/api/handy/v2/connected', {
        headers: { 'X-Connection-Key': key }
    });
    const data = await res.json();
    if (!data.connected) throw new Error("Handy is offline");

    await fetch('https://www.handyfeeling.com/api/handy/v2/mode', {
        method: 'PUT',
        headers: { 'X-Connection-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 1 })
    });
    await fetch('https://www.handyfeeling.com/api/handy/v2/hamp/stop', {
        method: 'PUT',
        headers: { 'X-Connection-Key': key }
    });

    handyConnected = true;
    handyIsHampRunning = false;
    return await queryHandyBattery(key);
}

export function disconnectHandy(key) {
    if (key && handyConnected) {
        fetch('https://www.handyfeeling.com/api/handy/v2/hamp/stop', {
            method: 'PUT',
            headers: { 'X-Connection-Key': key }
        }).catch(() => {});
    }
    handyConnected = false;
    handyIsHampRunning = false;
}

export function dispatchHandy(key, primarySpeed, strokeMin, strokeMax, force = false) {
    if (!handyConnected || !key) return;
    const now = Date.now();
    if (!force && (now - handyLastSend < 400)) return;
    handyLastSend = now;

    if (primarySpeed === 0) {
        if (handyIsHampRunning || force) {
            fetch('https://www.handyfeeling.com/api/handy/v2/hamp/stop', {
                method: 'PUT',
                headers: { 'X-Connection-Key': key }
            }).catch(() => {});
            handyIsHampRunning = false;
            handyLastStrokeSentVal = -1;
        }
    } else {
        if (!handyIsHampRunning) {
            fetch('https://www.handyfeeling.com/api/handy/v2/hamp/start', {
                method: 'PUT',
                headers: { 'X-Connection-Key': key }
            }).then(() => {
                handyIsHampRunning = true;
                sendHandyVelocity(key, primarySpeed);
            }).catch(() => {});
        } else {
            sendHandyVelocity(key, primarySpeed);
        }

        if (force || strokeMax !== handyLastStrokeSentVal || (now - handyLastStrokeSend > 1000)) {
            handyLastStrokeSentVal = strokeMax;
            handyLastStrokeSend = now;
            fetch('https://www.handyfeeling.com/api/handy/v2/hamp/stroke', {
                method: 'PUT',
                headers: { 'X-Connection-Key': key, 'Content-Type': 'application/json' },
                body: JSON.stringify({ min: strokeMin, max: strokeMax })
            }).catch(() => {});
        }
    }
}

function sendHandyVelocity(key, velocity) {
    fetch('https://www.handyfeeling.com/api/handy/v2/hamp/velocity', {
        method: 'PUT',
        headers: { 'X-Connection-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ velocity })
    }).catch(() => {});
}

export async function queryHandyBattery(key) {
    const endpoints = [
        'https://www.handyfeeling.com/api/handy/v2/status',
        'https://www.handyfeeling.com/api/handy/v2/info',
        'https://www.handyfeeling.com/api/handy/v2/battery'
    ];
    for (const ep of endpoints) {
        try {
            const res = await fetch(ep, { headers: { 'X-Connection-Key': key } });
            if (res.ok) {
                const data = await res.json();
                let raw = data.battery ?? data.battery_level ?? data.batteryLevel ?? data.level ??
                (data.device && (data.device.battery ?? data.device.battery_level));
                if (raw !== undefined && raw !== null) {
                    if (raw <= 1.0 && raw > 0) raw = Math.round(raw * 100);
                    return Math.round(raw);
                }
            }
        } catch(e) {}
    }
    return null;
}
