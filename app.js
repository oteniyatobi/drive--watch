// ==========================================
// DRIVERWATCH ENTERPRISE - LOGIC KERNEL
// ==========================================

const URL = "./model/";

let model, webcam, maxPredictions;
let isRunning = false;
let emergencyTimer = null;
let countdownInterval = null;
let simulatedCallInterval = null;
let currentSleepSessionStart = null;
let sessionStartTime = null;
let sessionInterval = null;
let totalAlerts = 0;
let totalDrowsySeconds = 0;
let drowsyStartTime = null;
let hasLoggedDrowsyWarningThisSession = false;
let fpsMetrics = { frames: 0, lastTime: Date.now() };
let isAlarmActive = false; // State Guard
let isEmergencyActive = false; // State Guard

// Dashcam State
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;

// IndexedDB Constants
const DB_NAME = 'DriverWatchDB';
const DB_VERSION = 1;
const STORE_NAME = 'videos';
let db = null;

// ==========================================
// SUBSYSTEMS: AUDIO & SYNTHESIS
// ==========================================
// Web Audio API Context for 100% reliability (Henry Danger Style)
let audioCtx = null;
let alarmOscillator = null;
let alarmGain = null;
let isAlarmPlaying = false;
let warningOscillator = null;
let warningGain = null;
let isWarningPlaying = false;

const ringingSound = new Audio("https://upload.wikimedia.org/wikipedia/commons/c/c4/Telephone_ringing.ogg");
ringingSound.loop = true;

const synth = window.speechSynthesis;
let dispatchUtterance = null;
let heartbeatInterval = null; // Manage speech keep-alive
let currentPulseInterval = null;
let currentWarningInterval = null;

// Pre-load voices immediately for hardware readiness
if (synth) {
    synth.getVoices();
    if (synth.onvoiceschanged !== undefined) {
        synth.onvoiceschanged = () => synth.getVoices();
    }
}

function initAudioContext() {
    if (audioCtx && audioCtx.state !== 'closed') return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
        console.error("Audio Context initialization failed:", e);
    }
}

function startHDAudioAlarm() {
    if (isAlarmPlaying) return;
    initAudioContext();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    isAlarmPlaying = true;

    alarmOscillator = audioCtx.createOscillator();
    alarmGain = audioCtx.createGain();
    alarmOscillator.type = 'square';
    alarmOscillator.frequency.setValueAtTime(1400, audioCtx.currentTime);

    alarmGain.gain.setValueAtTime(0, audioCtx.currentTime);
    alarmOscillator.connect(alarmGain);
    alarmGain.connect(audioCtx.destination);
    alarmOscillator.start();

    // Low-overhead pulsing
    let pulseState = false;
    if (currentPulseInterval) clearInterval(currentPulseInterval);
    currentPulseInterval = setInterval(() => {
        if (!audioCtx) return;
        pulseState = !pulseState;
        alarmGain.gain.setTargetAtTime(pulseState ? 0.8 : 0, audioCtx.currentTime, 0.01);
    }, 150);
}

function stopHDAudioAlarm() {
    if (currentPulseInterval) clearInterval(currentPulseInterval);
    if (alarmOscillator) {
        try { alarmOscillator.stop(); } catch (e) { }
        alarmOscillator.disconnect();
    }
    isAlarmPlaying = false;
}

function startHDWarningBeep() {
    if (isWarningPlaying) return;
    initAudioContext();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    isWarningPlaying = true;

    warningOscillator = audioCtx.createOscillator();
    warningGain = audioCtx.createGain();
    warningOscillator.type = 'sine';
    warningOscillator.frequency.setValueAtTime(880, audioCtx.currentTime);

    warningGain.gain.setValueAtTime(0, audioCtx.currentTime);
    warningOscillator.connect(warningGain);
    warningGain.connect(audioCtx.destination);
    warningOscillator.start();

    let beepState = false;
    if (currentWarningInterval) clearInterval(currentWarningInterval);
    currentWarningInterval = setInterval(() => {
        if (!audioCtx) return;
        beepState = !beepState;
        warningGain.gain.setTargetAtTime(beepState ? 0.3 : 0, audioCtx.currentTime, 0.01);
    }, 500);
}

function stopHDWarningBeep() {
    if (currentWarningInterval) clearInterval(currentWarningInterval);
    if (warningOscillator) {
        try { warningOscillator.stop(); } catch (e) { }
        warningOscillator.disconnect();
    }
    isWarningPlaying = false;
}

// ==========================================
// SUBSYSTEM: PREDICTION STABILIZATION
// ==========================================
const SMOOTHING_WINDOW = 10;
let predictionHistory = [];

function getSmoothedPredictions(rawPrediction) {
    const frame = rawPrediction.map(p => ({
        className: p.className,
        probability: p.probability
    }));
    predictionHistory.push(frame);

    if (predictionHistory.length > SMOOTHING_WINDOW) {
        predictionHistory.shift();
    }

    const smoothed = frame.map((p, i) => {
        const avgProb = predictionHistory.reduce((sum, f) => sum + f[i].probability, 0) / predictionHistory.length;
        return {
            className: p.className,
            probability: avgProb
        };
    });

    return smoothed;
}

// ==========================================
// SYSTEM THRESHOLDS 
// ==========================================
const ASLEEP_THRESHOLD = 0.70;
const SECONDS_TO_TRIGGER_ALARM = 4;
const EMERGENCY_CALL_DELAY = 10;

// ==========================================
// DOM MAPPING 
// ==========================================
// Controls
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const dismissAlarmBtn = document.getElementById('dismiss-alarm');
const cancelEmergencyBtn = document.getElementById('cancel-emergency');

// Navigation
const navSystemTag = document.getElementById('nav-system-tag');
const navClock = document.getElementById('nav-clock');

// Camera & Telemetry
const cameraBadge = document.getElementById('camera-badge');
const cameraContainer = document.getElementById('camera-container');
const startupMessage = document.getElementById('startup-message');
const footerDataStream = document.getElementById('footer-data-stream');
const liveIndicator = document.getElementById('live-indicator');

// Data Modules
const headerStatusDot = document.getElementById('header-status-dot');
const mainStatusCard = document.getElementById('main-status-card');
const bigStatusLabel = document.getElementById('big-status-label');
const bigStatusSub = document.getElementById('big-status-sub');
const activityLog = document.getElementById('activity-log');

// Overlays
const alarmOverlay = document.getElementById('alarm-overlay');
const emergencyOverlay = document.getElementById('emergency-overlay');
const countdownEl = document.getElementById('emergency-countdown');
const emergencyStatusText = document.getElementById('emergency-status-text');
const callTimer = document.getElementById('call-timer');
const transferProgress = document.getElementById('transfer-progress');

// Metrics
const statUptime = document.getElementById('stat-uptime');
const statAlerts = document.getElementById('stat-alerts');
const statDrowsy = document.getElementById('stat-drowsy');
const statScore = document.getElementById('stat-score');

// Init Clock
setInterval(() => {
    navClock.innerText = new Date().toLocaleTimeString('en-US', { hour12: false });
}, 1000);

// Bindings
startBtn.addEventListener('click', init);
stopBtn.addEventListener('click', stopSystem);
dismissAlarmBtn.addEventListener('click', dismissAlarm);
cancelEmergencyBtn.addEventListener('click', cancelEmergency);

// ==========================================
// EVENT LOG KERNEL
// ==========================================
function logEvent(message, type = 't-info') {
    const now = new Date();
    const ts = now.toISOString().split('T')[1].substring(0, 11); // Extract 00:00:00.000

    const entry = document.createElement('div');
    entry.className = `terminal-line ${type}`;
    entry.innerHTML = `<span class="time">[${ts}]</span> ${message}`;

    activityLog.prepend(entry);

    if (activityLog.children.length > 50) {
        activityLog.removeChild(activityLog.lastChild);
    }
}

document.querySelector('.export-btn').addEventListener('click', () => {
    activityLog.innerHTML = '<div class="terminal-line">[SYS] Buffer cleared by operator.</div>';
});

// ==========================================
// INITIALIZATION SEQUENCE
// ==========================================
async function init() {
    try {
        await initDB();
    } catch (e) {
        console.warn("Media Vault storage unavailable:", e);
        logEvent('Storage subsystem offline. Manual export required.', 't-warn');
    }
    startBtn.disabled = true;

    // Unlock Audio Contexts
    initAudioContext();
    stopHDWarningBeep();
    stopHDAudioAlarm();
    ringingSound.play().then(() => ringingSound.pause()).catch(e => { });

    if (synth) {
        synth.cancel();
        try {
            // Prime the engine with a short word to ensure unlock
            const prime = new SpeechSynthesisUtterance('Ready');
            prime.volume = 0.01; // Tiny but not zero to satisfy some browser checks
            synth.speak(prime);
            logEvent('Voice engine unlocked and ready.', 't-info');
        } catch (e) { }
    }

    if (startupMessage) startupMessage.innerHTML = '<div class="standby-text">Loading Fleet Models...</div>';

    try {
        logEvent('Initializing Dashcam and Driver Status Monitor...', 't-info');
        model = await tmImage.load(URL + "model.json", URL + "metadata.json");
        maxPredictions = model.getTotalClasses();

        webcam = new tmImage.Webcam(400, 300, true);

        if (startupMessage) startupMessage.innerHTML = '<div class="standby-text">Connecting to Camera...</div>';
        await webcam.setup();

        if (startupMessage) startupMessage.style.display = 'none';
        await webcam.play();
        window.requestAnimationFrame(loop);

        document.getElementById("webcam-wrapper").appendChild(webcam.canvas);

        const labelContainer = document.getElementById("label-container");
        labelContainer.innerHTML = '';
        for (let i = 0; i < maxPredictions; i++) {
            const className = model.getClassLabels()[i].toUpperCase();
            labelContainer.innerHTML += `
                <div class="nn-row" id="pred-row-${i}">
                    <div class="nn-label">${className}</div>
                    <div class="nn-track">
                        <div class="nn-fill" id="bar-${i}"></div>
                    </div>
                    <div class="nn-val" id="val-${i}">0%</div>
                </div>
            `;
        }

        predictionHistory = [];
        isRunning = true;
        sessionStartTime = Date.now();
        totalAlerts = 0;
        totalDrowsySeconds = 0;
        fpsMetrics = { frames: 0, lastTime: Date.now() };

        sessionInterval = setInterval(updateSessionStats, 1000);

        stopBtn.disabled = false;
        navSystemTag.innerHTML = `SYSTEM: <span class="status-indicator ACTIVE">ACTIVE</span>`;
        cameraBadge.innerText = 'ONLINE';
        cameraBadge.className = 'panel-badge ONLINE';
        liveIndicator.classList.add('active');

        setStatus('awake', 'DRIVER ALERT', 'Dashcam feed nominal. System actively monitoring.');
        logEvent('Monitoring active. Driver safety protocols engaged.', 't-succ');

        startRecording();
        loadMediaVault();

    } catch (error) {
        if (startupMessage) {
            startupMessage.style.display = 'flex';
            startupMessage.innerHTML = '<div class="standby-text" style="color:var(--stat-danger)">CAMERA ERROR</div>';
        }
        logEvent('Critical failure: Unable to access cabin camera.', 't-crit');
        startBtn.disabled = false;
    }
}

async function loop() {
    if (!isRunning) return;
    try {
        webcam.update();
        fpsMetrics.frames++;
        const now = Date.now();
        if (now - fpsMetrics.lastTime >= 1000) {
            if (footerDataStream) {
                footerDataStream.innerText = `FPS: ${fpsMetrics.frames} | RES: ${webcam.canvas.width}x${webcam.canvas.height}`;
            }
            fpsMetrics.frames = 0;
            fpsMetrics.lastTime = now;
        }
        await predict();
    } catch (e) {
        console.error("Loop Error:", e);
        logEvent(`SYS_EXCEPTION: ${e.message}`, 't-crit');
    }
    window.requestAnimationFrame(loop);
}

async function predict() {
    const rawPrediction = await model.predict(webcam.canvas);
    const prediction = getSmoothedPredictions(rawPrediction);
    let isAsleep = false;

    for (let i = 0; i < maxPredictions; i++) {
        const val = prediction[i].probability;
        const bar = document.getElementById(`bar-${i}`);
        const valText = document.getElementById(`val-${i}`);
        const classNameRaw = prediction[i].className.toLowerCase();

        let type = 'neutral';
        if (classNameRaw.includes('awake')) type = 'awake';
        if (classNameRaw.includes('sleepy') || classNameRaw.includes('asleep')) type = 'sleepy';

        bar.className = `nn-fill ${type}`;
        bar.style.width = `${val * 100}%`;
        valText.innerText = (val * 100).toFixed(1) + "%";

        if (type === 'sleepy' && val >= ASLEEP_THRESHOLD) isAsleep = true;
    }
    handleDrowsinessLogic(isAsleep);
}

function handleDrowsinessLogic(isAsleep) {
    if (!alarmOverlay.classList.contains('hidden') || !emergencyOverlay.classList.contains('hidden')) return;

    if (isAsleep) {
        if (!currentSleepSessionStart) currentSleepSessionStart = Date.now();
        if (!drowsyStartTime) drowsyStartTime = Date.now();
        const sec = (Date.now() - currentSleepSessionStart) / 1000;

        if (sec > 1 && !hasLoggedDrowsyWarningThisSession) {
            logEvent('WARNING: Driver fatigue visually detected.', 't-warn');
            hasLoggedDrowsyWarningThisSession = true;
        }

        if (sec < SECONDS_TO_TRIGGER_ALARM) {
            const timeRemaining = Math.max(0, SECONDS_TO_TRIGGER_ALARM - sec).toFixed(1);
            setStatus('sleepy', 'DROWSY WARNING', `Driver unresponsive. Cabin alarm in ${timeRemaining}s`);
            startHDWarningBeep();
        } else {
            stopHDWarningBeep();
            triggerAlarm();
        }
    } else {
        if (drowsyStartTime) {
            totalDrowsySeconds += (Date.now() - drowsyStartTime) / 1000;
            drowsyStartTime = null;
        }
        if (hasLoggedDrowsyWarningThisSession && currentSleepSessionStart) {
            logEvent('Driver alertness restored to nominal levels.', 't-info');
        }
        currentSleepSessionStart = null;
        hasLoggedDrowsyWarningThisSession = false;
        stopHDWarningBeep();
        setStatus('awake', 'DRIVER ALERT', 'Driver parameters stable.');
    }
}

function setStatus(stateCode, title, detail) {
    if (cameraContainer) cameraContainer.className = `camera-wrapper ${stateCode}`;
    if (headerStatusDot) headerStatusDot.className = `status-dot ${stateCode}`;
    if (mainStatusCard) mainStatusCard.className = `assessment-container ${stateCode}`;
    if (bigStatusLabel) {
        bigStatusLabel.innerText = title;
        bigStatusLabel.className = `assessment-value ${stateCode}`;
    }
    if (bigStatusSub) bigStatusSub.innerText = detail;
}

function triggerAlarm() {
    if (isAlarmActive) return;
    isAlarmActive = true;

    if (alarmOverlay) alarmOverlay.classList.remove('hidden');
    setStatus('sleepy', 'CRITICAL ALARM', 'Driver unresponsive. Emergency protocols active.');

    logEvent('CRITICAL: Driver unresponsive. Alarm engaged. Incident Recorded.', 't-crit');
    try { markIncident(); } catch (e) { }

    totalAlerts++;
    if (statAlerts) statAlerts.innerText = String(totalAlerts).padStart(2, '0');

    startHDAudioAlarm();

    let countdown = EMERGENCY_CALL_DELAY;
    if (countdownEl) countdownEl.innerText = String(countdown).padStart(2, '0');

    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        countdown--;
        if (countdownEl) countdownEl.innerText = String(countdown).padStart(2, '0');
        if (countdown <= 0) {
            clearInterval(countdownInterval);
            triggerEmergency();
        }
    }, 1000);
}

function dismissAlarm() {
    logEvent('OVERRIDE: Driver successfully acknowledged alarm.', 't-succ');
    if (alarmOverlay) alarmOverlay.classList.add('hidden');
    stopHDAudioAlarm();

    if (countdownInterval) clearInterval(countdownInterval);
    if (emergencyTimer) clearTimeout(emergencyTimer);
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    isAlarmActive = false;
    isEmergencyActive = false;

    // CRITICAL: Reset drowsiness state to prevent looping
    currentSleepSessionStart = null;
    hasLoggedDrowsyWarningThisSession = false;
    if (drowsyStartTime) {
        totalDrowsySeconds += (Date.now() - drowsyStartTime) / 1000;
        drowsyStartTime = null;
    }
}

function triggerEmergency() {
    if (isEmergencyActive) return;
    isEmergencyActive = true;

    if (alarmOverlay) alarmOverlay.classList.add('hidden');
    if (emergencyOverlay) emergencyOverlay.classList.remove('hidden');
    setStatus('sleepy', 'DISPATCH CALLED', 'Fleet emergency protocols in progress.');

    logEvent('ESCALATION: Fleet Dispatch / 911 Protocol Initiated.', 't-crit');
    stopHDAudioAlarm();
    startSimulatedCall();
}

function startSimulatedCall() {
    logEvent('DIALING: Connecting to emergency dispatch relay...', 't-info');
    ringingSound.play().catch(e => { });

    if (emergencyStatusText) emergencyStatusText.innerText = "CONTACTING DISPATCH...";
    if (transferProgress) transferProgress.style.width = "10%";

    emergencyTimer = setTimeout(() => {
        try {
            ringingSound.pause();
            ringingSound.currentTime = 0;

            if (emergencyStatusText) emergencyStatusText.innerText = "CONNECTION ESTABLISHED. TRANSMITTING FEED...";
            if (transferProgress) transferProgress.style.width = "100%";
            logEvent('Live connection established. Transmitting GPS and Feed.', 't-warn');

            // 4. Silent Audio Anchor: Re-assert audio context activity right before speech
            if (audioCtx) {
                const anchor = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                gain.gain.value = 0.0001; // Effectively silent
                anchor.connect(gain);
                gain.connect(audioCtx.destination);
                anchor.start();
                anchor.stop(audioCtx.currentTime + 0.1);
            }

            playDispatcherVoice();
        } catch (e) {
            playDispatcherVoice();
        }
    }, 3000);
}

function getBestVoice() {
    if (!synth) return null;
    const voices = synth.getVoices();
    if (voices.length === 0) return null;
    return voices.find(v => v.lang.includes('en-US') && (v.name.includes('Female') || v.name.includes('Google'))) ||
        voices.find(v => v.lang.includes('en-US')) ||
        voices[0];
}

function playDispatcherVoice() {
    try {
        if (!synth) return;

        // 1. Reset and Wake Engine
        synth.cancel();
        synth.resume();

        const msg = "Emergency alert from Driver Watch. Driver unresponsive. GPS location transmitting to dispatch. Attempting to establish two way communication. Driver, please pull over immediately.";
        dispatchUtterance = new SpeechSynthesisUtterance(msg);
        dispatchUtterance.rate = 0.95;
        dispatchUtterance.pitch = 1.0;
        dispatchUtterance.volume = 1.0;

        // 2. Hardware Wait (Chrome Quirk)
        let voices = synth.getVoices();
        if (voices.length === 0) {
            setTimeout(playDispatcherVoice, 100);
            return;
        }

        const selectedVoice = getBestVoice();
        if (selectedVoice) dispatchUtterance.voice = selectedVoice;

        // 3. Execution Sandwich (Force-Resume after speak)
        dispatchUtterance.onstart = () => {
            logEvent(`VOICE: Transmission active (${selectedVoice ? selectedVoice.name : 'System'}).`, 't-succ');
        };

        dispatchUtterance.onerror = (e) => {
            console.error("Speech Logic Error:", e);
            if (e.error !== 'interrupted') {
                setTimeout(() => synth.speak(dispatchUtterance), 1000);
            }
        };

        synth.speak(dispatchUtterance);
        synth.resume(); // CRITICAL: unstick engine

        // Heartbeat Keep-Alive
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (synth.speaking) {
                synth.pause();
                synth.resume();
            } else {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
        }, 8000);

    } catch (e) {
        console.error("Voice Logic Crash:", e);
    }
}

function cancelEmergency() {
    logEvent('ABORT: Dispatch sequence terminated by operator.', 't-info');
    if (alarmOverlay) alarmOverlay.classList.add('hidden');
    if (emergencyOverlay) emergencyOverlay.classList.add('hidden');
    stopHDAudioAlarm();
    ringingSound.pause();
    ringingSound.currentTime = 0;

    if (synth) synth.cancel();
    if (emergencyTimer) clearTimeout(emergencyTimer);
    if (simulatedCallInterval) clearInterval(simulatedCallInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    isAlarmActive = false;
    isEmergencyActive = false;

    // Reset drowsiness state
    currentSleepSessionStart = null;
    hasLoggedDrowsyWarningThisSession = false;
    if (drowsyStartTime) {
        totalDrowsySeconds += (Date.now() - drowsyStartTime) / 1000;
        drowsyStartTime = null;
    }
}

function startRecording() {
    if (!webcam.canvas) return;
    const stream = webcam.canvas.captureStream(30);
    recordedChunks = [];
    try {
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    } catch (e) {
        mediaRecorder = new MediaRecorder(stream);
    }
    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordedChunks.push(event.data);
    };
    mediaRecorder.onstop = saveFullSession;
    mediaRecorder.start(1000);
    isRecording = true;
    document.getElementById('recording-dot').classList.add('active');
}

function stopRecording() {
    if (mediaRecorder && isRecording) {
        mediaRecorder.stop();
        isRecording = false;
        document.getElementById('recording-dot').classList.remove('active');
    }
}

function markIncident() {
    if (recordedChunks.length > 0) {
        const timestamp = new Date().getTime();
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        saveVideoToDB(`incident_${timestamp}`, blob, 'INCIDENT');
    }
}

function saveFullSession() {
    const timestamp = new Date().getTime();
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    saveVideoToDB(`session_${timestamp}`, blob, 'FULL SESSION');
}

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onsuccess = (e) => { db = e.target.result; resolve(db); };
        request.onupgradeneeded = (e) => { e.target.result.createObjectStore(STORE_NAME, { keyPath: 'id' }); };
        request.onerror = (e) => reject(e);
    });
}

function saveVideoToDB(id, blob, type) {
    if (!db) return;
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put({ id: id, blob: blob, type: type, timestamp: new Date().toLocaleString() });
    loadMediaVault();
}

async function loadMediaVault() {
    const vaultContainer = document.getElementById('vault-list');
    if (!vaultContainer || !db) return;
    vaultContainer.innerHTML = '';
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    store.getAll().onsuccess = (event) => {
        const videos = event.target.result;
        if (videos.length === 0) {
            vaultContainer.innerHTML = '<div class="empty-data">NO RECORDS</div>';
            return;
        }
        videos.forEach(video => {
            const item = document.createElement('div');
            item.className = 'vault-item';
            item.innerHTML = `
                <div class="vault-info">
                    <span class="vault-type">${video.type}</span>
                    <span class="vault-time">${video.timestamp}</span>
                </div>
                <div class="vault-actions">
                    <button class="btn-play" onclick="playVideo('${video.id}')">PLAY</button>
                    <button class="btn-del" onclick="deleteVideo('${video.id}')">DEL</button>
                </div>
            `;
            vaultContainer.appendChild(item);
        });
    };
}

function playVideo(id) {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    store.get(id).onsuccess = (event) => {
        const video = event.target.result;
        if (!video) return;
        const player = document.getElementById('vault-player');
        const modal = document.getElementById('vault-modal');
        player.src = URL.createObjectURL(video.blob);
        modal.classList.remove('hidden');
        player.play();
    };
}

function closeVaultPlayer() {
    document.getElementById('vault-player').pause();
    document.getElementById('vault-modal').classList.add('hidden');
}

function deleteVideo(id) {
    if (confirm('Delete?')) {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        db.transaction([STORE_NAME], 'readwrite').objectStore(STORE_NAME).delete(id).onsuccess = loadMediaVault;
    }
}

function updateSessionStats() {
    if (!sessionStartTime) return;
    const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
    statUptime.innerText = String(Math.floor(elapsed / 60)).padStart(2, '0') + ":" + String(elapsed % 60).padStart(2, '0');
    let currentDrowsy = totalDrowsySeconds;
    if (drowsyStartTime) currentDrowsy += (Date.now() - drowsyStartTime) / 1000;
    statDrowsy.innerText = Math.round(currentDrowsy) + 's';
    const alertness = elapsed > 0 ? Math.max(0, (100 - (currentDrowsy / elapsed * 100))) : 100;
    statScore.innerText = alertness.toFixed(1) + '%';
}

function stopSystem() {
    isRunning = false;
    stopRecording();
    clearInterval(sessionInterval);
    if (webcam) webcam.stop();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    navSystemTag.innerHTML = `SYSTEM: <span class="status-indicator">STANDBY</span>`;
}
