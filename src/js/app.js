// Add these variables near top of src/js/app.js
let funscriptPrimary = [];
let funscriptSecondary = [];
let funscriptSessionStart = 0;

// 250ms Live Funscript Sampling Loop (4Hz)
setInterval(() => {
    if (state.sessionStatus === 'RUNNING') {
        const now = Date.now();
        if (funscriptSessionStart === 0) funscriptSessionStart = now;
        const at = now - funscriptSessionStart;
        funscriptPrimary.push({ at, pos: Math.round(state.strokerSpeed) });
        funscriptSecondary.push({ at, pos: Math.round(state.prostateSpeed) });
    }
}, 250);

// Handy Role Switcher & Cap Controls
function initHandyRoleUI() {
    const pBtn = document.getElementById('handyRolePrimaryBtn');
    const sBtn = document.getElementById('handyRoleSecondaryBtn');
    const oBtn = document.getElementById('handyRoleOffBtn');
    const capSlider = document.getElementById('handyCapSlider');
    const capVal = document.getElementById('handyCapVal');

    if (capSlider && capVal) {
        capSlider.value = state.handyMaxCap;
        capVal.textContent = `${state.handyMaxCap}%`;
        capSlider.addEventListener('input', (e) => {
            state.handyMaxCap = parseInt(e.target.value, 10);
            capVal.textContent = `${state.handyMaxCap}%`;
            localStorage.setItem('handy_max_cap', state.handyMaxCap);
            updateEngine();
        });
    }

    const applyRole = (role) => {
        state.handyRole = role;
        localStorage.setItem('handy_role', role);
        const badge = document.getElementById('modalHandyRoleBadge');

        if (pBtn) pBtn.className = role === 'primary' ? "py-1.5 rounded-lg bg-rose-600 text-white font-bold text-xs transition cursor-pointer" : "py-1.5 rounded-lg bg-slate-800 text-slate-400 font-bold text-xs hover:text-white transition cursor-pointer";
        if (sBtn) sBtn.className = role === 'secondary' ? "py-1.5 rounded-lg bg-purple-600 text-white font-bold text-xs transition cursor-pointer" : "py-1.5 rounded-lg bg-slate-800 text-slate-400 font-bold text-xs hover:text-white transition cursor-pointer";
        if (oBtn) oBtn.className = role === 'off' ? "py-1.5 rounded-lg bg-slate-700 text-amber-300 font-bold text-xs transition cursor-pointer" : "py-1.5 rounded-lg bg-slate-800 text-slate-400 font-bold text-xs hover:text-white transition cursor-pointer";

        if (badge) {
            if (role === 'primary') { badge.textContent = "Primary (Tease)"; badge.className = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800"; }
            else if (role === 'secondary') { badge.textContent = "Secondary (Milker)"; badge.className = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-950 text-purple-300 border border-purple-800"; }
            else { badge.textContent = "Disabled (OFF)"; badge.className = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-900 text-amber-400 border border-slate-700"; }
        }
        updateEngine();
    };

    pBtn?.addEventListener('click', () => applyRole('primary'));
    sBtn?.addEventListener('click', () => applyRole('secondary'));
    oBtn?.addEventListener('click', () => applyRole('off'));
    applyRole(state.handyRole);
}

// Update dispatchHardware() to respect Handy Role & Power Cap
function dispatchHardware(primarySpeed, secondarySpeed, strokeMin, strokeMax, force = false) {
    if (isRemoteController) return;
    const key = document.getElementById('modalHandyInput').value.trim();

    let targetHandySpeed = 0;
    if (state.handyRole === 'primary') {
        targetHandySpeed = Math.round(primarySpeed * ((state.handyMaxCap ?? 100) / 100));
    } else if (state.handyRole === 'secondary') {
        targetHandySpeed = Math.round(secondarySpeed * ((state.handyMaxCap ?? 100) / 100));
    } else {
        targetHandySpeed = 0; // OFF
    }

    dispatchHandy(key, targetHandySpeed, strokeMin, strokeMax, force);
    dispatchIntiface(primarySpeed, secondarySpeed);
}

// Session Start/Reset: Flush Funscript Arrays
playPauseBtn.addEventListener('click', () => {
    if (state.sessionStatus === 'IDLE') {
        funscriptPrimary = [];
        funscriptSecondary = [];
        funscriptSessionStart = Date.now();
    }
    // ... rest of playPause handler
});

resetBtn.addEventListener('click', () => {
    funscriptPrimary = [];
    funscriptSecondary = [];
    funscriptSessionStart = 0;
    // ... rest of resetBtn handler
});

// Update saveSessionToHistory to persist the recorded points
function saveSessionToHistory(outcome) {
    const history = JSON.parse(localStorage.getItem('edgeloop_history') || '[]');
    const sessionId = Date.now();
    history.unshift({
        id: sessionId,
        date: new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    duration: state.sessionSeconds,
                    edges: state.edges,
                    pauses: state.pauses,
                    peakHr: state.peakHr,
                    outcome,
                    primaryActions: [...funscriptPrimary],
                    secondaryActions: [...funscriptSecondary]
    });
    if (history.length > 5) history.pop();
    try {
        localStorage.setItem('edgeloop_history', JSON.stringify(history));
    } catch (e) {
        console.warn("Storage quota reached; trimming actions", e);
    }
}

// Global Funscript Downloader Window Hook
window.downloadFunscript = (sessionId, channel) => {
    const history = JSON.parse(localStorage.getItem('edgeloop_history') || '[]');
    const session = history.find(s => s.id === sessionId);
    if (!session) return alert("Session log not found.");

    const actions = channel === 'primary' ? (session.primaryActions || []) : (session.secondaryActions || []);
    if (actions.length === 0) return alert("No motion recorded for this channel during this session.");

    const funscriptPayload = {
        version: "1.0",
        inverted: false,
        range: 100,
        actions: actions
    };

    const blob = new Blob([JSON.stringify(funscriptPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ext = channel === 'primary' ? '.funscript' : '.v0.funscript';
    a.href = url;
    a.download = `edgeloop_${sessionId}${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

// Update renderHistory() to output download buttons
function renderHistory() {
    const history = JSON.parse(localStorage.getItem('edgeloop_history') || '[]');
    const list = document.getElementById('historyList');
    if (!list) return;
    if (history.length === 0) {
        list.innerHTML = `<div class="p-4 bg-slate-950 rounded-xl border border-slate-800 text-slate-500 text-xs text-center italic">No completed sessions recorded yet.</div>`;
        return;
    }
    list.innerHTML = '';
    history.forEach((s, idx) => {
        const mins = Math.floor(s.duration / 60);
        const secs = s.duration % 60;
        const item = document.createElement('div');
        item.className = 'p-2.5 bg-slate-950 rounded-xl border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs';
        item.innerHTML = `
        <div>
        <div class="font-bold text-slate-200">#${idx + 1} — ${s.date}</div>
        <div class="text-[10px] text-slate-400 mt-0.5">⏱ ${mins}m ${secs}s &bull; ⚡ ${s.edges} Edges &bull; 🔥 ${s.peakHr} BPM &bull; <span class="text-purple-300 font-semibold">${s.outcome}</span></div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
        <button onclick="downloadFunscript(${s.id}, 'primary')" class="px-2 py-1 bg-purple-950 hover:bg-purple-800 border border-purple-700 text-purple-200 rounded text-[10px] font-mono transition cursor-pointer flex items-center gap-1" title="Download Primary Stroker Funscript">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
        .funscript
        </button>
        <button onclick="downloadFunscript(${s.id}, 'secondary')" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded text-[10px] font-mono transition cursor-pointer flex items-center gap-1" title="Download Secondary Milker Funscript">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
        .v0.funscript
        </button>
        </div>
        `;
        list.appendChild(item);
    });
}

// Call on startup
initHandyRoleUI();
