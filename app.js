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

// ==========================================
// SUBSYSTEMS: AUDIO & SYNTHESIS
// ==========================================
const alarmSound = new Audio("https://upload.wikimedia.org/wikipedia/commons/2/23/Emergency_vehicle_siren.ogg");
alarmSound.loop = true;
const ringingSound = new Audio("https://upload.wikimedia.org/wikipedia/commons/c/c4/Telephone_ringing.ogg");
ringingSound.loop = true;

const synth = window.speechSynthesis;
let dispatchUtterance = null;

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
    startBtn.disabled = true;

    // Unlock Audio Contexts so sounds/simulation play automatically later
    alarmSound.play().then(() => alarmSound.pause()).catch(e => { });
    ringingSound.play().then(() => ringingSound.pause()).catch(e => { });
    if (synth) synth.speak(new SpeechSynthesisUtterance(''));

    if (startupMessage) startupMessage.innerHTML = '<div class="standby-text">Loading Fleet Models...</div>';

    if (synth.getVoices().length === 0) {
        synth.addEventListener('voiceschanged', () => { });
    }

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

        // Build NN Bars
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

        // Update UI state
        stopBtn.disabled = false;
        navSystemTag.innerHTML = `SYSTEM: <span class="status-indicator ACTIVE">ACTIVE</span>`;
        cameraBadge.innerText = 'ONLINE';
        cameraBadge.className = 'panel-badge ONLINE';
        liveIndicator.classList.add('active');

        setStatus('awake', 'DRIVER ALERT', 'Dashcam feed nominal. System actively monitoring.');
        logEvent('Monitoring active. Driver safety protocols engaged.', 't-succ');

    } catch (error) {
        if (startupMessage) {
            startupMessage.style.display = 'flex';
            startupMessage.innerHTML = '<div class="standby-text" style="color:var(--stat-danger)">CAMERA ERROR</div>';
        }
        logEvent('Critical failure: Unable to access cabin camera.', 't-crit');
        startBtn.disabled = false;
    }
}

// ==========================================
// CORE PROCESSING LOOP
// ==========================================
async function loop() {
    if (!isRunning) return;
    webcam.update();

    // FPS Calc
    fpsMetrics.frames++;
    const now = Date.now();
    if (now - fpsMetrics.lastTime >= 1000) {
        footerDataStream.innerText = `FPS: ${fpsMetrics.frames} | RES: ${webcam.canvas.width}x${webcam.canvas.height}`;
        fpsMetrics.frames = 0;
        fpsMetrics.lastTime = now;
    }

    await predict();
    window.requestAnimationFrame(loop);
}

async function predict() {
    const rawPrediction = await model.predict(webcam.canvas);
    const prediction = getSmoothedPredictions(rawPrediction);
    let isAsleep = false;

    for (let i = 0; i < maxPredictions; i++) {
        const val = prediction[i].probability;
        const valueStr = (val * 100).toFixed(1) + "%";

        const bar = document.getElementById(`bar-${i}`);
        const valText = document.getElementById(`val-${i}`);
        const classNameRaw = prediction[i].className.toLowerCase();

        let type = 'neutral';
        if (classNameRaw.includes('awake')) type = 'awake';
        if (classNameRaw.includes('sleepy') || classNameRaw.includes('asleep')) type = 'sleepy';

        bar.className = `nn-fill ${type}`;
        bar.style.width = `${val * 100}%`;
        valText.innerText = valueStr;

        if (type === 'sleepy' && val >= ASLEEP_THRESHOLD) {
            isAsleep = true;
        }
    }

    handleDrowsinessLogic(isAsleep);
}

// ==========================================
// RULE ENGINE
// ==========================================
function handleDrowsinessLogic(isAsleep) {
    if (!alarmOverlay.classList.contains('hidden') || !emergencyOverlay.classList.contains('hidden')) {
        return;
    }

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
        } else {
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
        setStatus('awake', 'DRIVER ALERT', 'Driver parameters stable.');
    }
}

// ==========================================
// UX FEEDBACK
// ==========================================
function setStatus(stateCode, title, detail) {
    cameraContainer.className = `camera-wrapper ${stateCode}`;
    headerStatusDot.className = `status-dot ${stateCode}`;
    mainStatusCard.className = `assessment-container ${stateCode}`;

    bigStatusLabel.innerText = title;
    bigStatusLabel.className = `assessment-value ${stateCode}`;
    bigStatusSub.innerText = detail;
}

// ==========================================
// INCIDENT PROTOCOLS
// ==========================================
function triggerAlarm() {
    logEvent('CRITICAL: Driver unresponsive. Cabin alarm engaged.', 't-crit');

    totalAlerts++;
    statAlerts.innerText = String(totalAlerts).padStart(2, '0');

    alarmOverlay.classList.remove('hidden');
    alarmSound.play().catch(e => console.log(e));

    let countdown = EMERGENCY_CALL_DELAY;
    countdownEl.innerText = String(countdown).padStart(2, '0');

    countdownInterval = setInterval(() => {
        countdown--;
        countdownEl.innerText = String(countdown).padStart(2, '0');
        if (countdown <= 0) {
            clearInterval(countdownInterval);
            triggerEmergency();
        }
    }, 1000);
}

function dismissAlarm() {
    logEvent('OVERRIDE: Driver successfully acknowledged alarm.', 't-succ');

    alarmOverlay.classList.add('hidden');
    alarmSound.pause();
    alarmSound.currentTime = 0;

    clearInterval(countdownInterval);
    clearTimeout(emergencyTimer);

    currentSleepSessionStart = null;
    hasLoggedDrowsyWarningThisSession = false;

    if (drowsyStartTime) {
        totalDrowsySeconds += (Date.now() - drowsyStartTime) / 1000;
        drowsyStartTime = null;
    }
}

function triggerEmergency() {
    logEvent('ESCALATION: Fleet Dispatch / 911 Protocol Initiated.', 't-crit');

    alarmOverlay.classList.add('hidden');
    emergencyOverlay.classList.remove('hidden');

    alarmSound.pause();
    alarmSound.currentTime = 0;

    startSimulatedCall();
}

function startSimulatedCall() {
    ringingSound.play().catch(e => console.log(e));

    emergencyStatusText.innerText = "CONTACTING DISPATCH...";
    transferProgress.style.width = "10%";

    emergencyTimer = setTimeout(() => {
        ringingSound.pause();
        ringingSound.currentTime = 0;

        emergencyStatusText.innerText = "CONNECTION ESTABLISHED. TRANSMITTING DATA...";
        transferProgress.style.width = "100%";
        logEvent('Live cell connection established. Transmitting GPS and dashcam feed.', 't-warn');

        let seconds = 0;
        simulatedCallInterval = setInterval(() => {
            seconds++;
            const m = String(Math.floor(seconds / 60)).padStart(2, '0');
            const s = String(seconds % 60).padStart(2, '0');
            callTimer.innerText = `${m}:${s}`;
        }, 1000);

        playDispatcherVoice();

    }, 6000);
}

function playDispatcherVoice() {
    const msg = "Emergency alert from DriverWatch. Driver unresponsive. GPS location transmitting to dispatch. Attempting to establish two way communication. Driver, please pull over immediately.";
    dispatchUtterance = new SpeechSynthesisUtterance(msg);
    dispatchUtterance.rate = 0.95;

    const voices = synth.getVoices();
    const systemVoice = voices.find(v => v.lang.includes('en-US')) || voices[0];
    if (systemVoice) dispatchUtterance.voice = systemVoice;

    synth.speak(dispatchUtterance);
}

function cancelEmergency() {
    logEvent('ABORT: Dispatch sequence terminated by local operator.', 't-info');

    emergencyOverlay.classList.add('hidden');

    alarmSound.pause();
    alarmSound.currentTime = 0;
    ringingSound.pause();
    ringingSound.currentTime = 0;

    if (synth && synth.speaking) synth.cancel();

    clearTimeout(emergencyTimer);
    clearInterval(simulatedCallInterval);

    currentSleepSessionStart = null;
    hasLoggedDrowsyWarningThisSession = false;

    if (drowsyStartTime) {
        totalDrowsySeconds += (Date.now() - drowsyStartTime) / 1000;
        drowsyStartTime = null;
    }
}

// ==========================================
// TELEMETRY UPDATER
// ==========================================
function updateSessionStats() {
    if (!sessionStartTime) return;

    const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    statUptime.innerText = `${mins}:${secs}`;

    let currentDrowsy = totalDrowsySeconds;
    if (drowsyStartTime) {
        currentDrowsy += (Date.now() - drowsyStartTime) / 1000;
    }
    statDrowsy.innerText = Math.round(currentDrowsy) + 's';

    const alertness = elapsed > 0 ? Math.max(0, (100 - (currentDrowsy / elapsed * 100))) : 100;
    statScore.innerText = alertness.toFixed(1) + '%';
    statScore.style.color = alertness >= 80 ? 'var(--stat-active)' :
        alertness >= 50 ? 'var(--stat-warn)' : 'var(--stat-danger)';
}

// ==========================================
// TERMINATION
// ==========================================
function stopSystem() {
    logEvent('System shut down by operator command.', 't-info');

    isRunning = false;
    predictionHistory = [];
    clearInterval(sessionInterval);

    if (webcam) {
        webcam.stop();
        document.getElementById("webcam-wrapper").innerHTML = `
            <div class="standby-screen" id="startup-message">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                </svg>
                <div class="standby-text">SYSTEM OFFLINE</div>
            </div>
        `;
    }

    startBtn.disabled = false;
    stopBtn.disabled = true;

    navSystemTag.innerHTML = `SYSTEM: <span class="status-indicator">STANDBY</span>`;
    cameraBadge.innerText = 'INACTIVE';
    cameraBadge.className = 'panel-badge';
    liveIndicator.classList.remove('active');
    footerDataStream.innerText = `FPS: -- | RES: --`;

    setStatus('neutral', 'NOT DETECTED', 'Awaiting Initialization...');
}
