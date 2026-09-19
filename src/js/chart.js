/**
 * Renders the 60-second sliding telemetry graph
 */
export function drawTelemetryChart(canvas, history, minHr, maxHr) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const chartMin = 50;
    const chartMax = 180;
    const scaleY = (val) => canvas.height - ((val - chartMin) / (chartMax - chartMin)) * canvas.height;

    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);

    // Resting HR floor guide line
    ctx.strokeStyle = '#14b8a6';
    ctx.beginPath();
    ctx.moveTo(0, scaleY(minHr));
    ctx.lineTo(canvas.width, scaleY(minHr));
    ctx.stroke();

    // Climax HR ceiling guide line
    ctx.strokeStyle = '#f43f5e';
    ctx.beginPath();
    ctx.moveTo(0, scaleY(maxHr));
    ctx.lineTo(canvas.width, scaleY(maxHr));
    ctx.stroke();

    ctx.setLineDash([]);

    // Telemetry Curve
    if (history.length < 2) return;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#f43f5e';
    ctx.beginPath();
    const step = canvas.width / 59;
    history.forEach((val, i) => {
        const x = i * step;
        const y = scaleY(val);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
        ctx.stroke();
}
