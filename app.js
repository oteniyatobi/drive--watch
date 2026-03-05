// ==========================================
// DRIVER WATCH - AI DROWSINESS DETECTION
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

// Track state to prevent spamming the activity log
let hasLoggedDrowsyWarningThisSession = false;

// ==========================================
// AUDIO FILES
// ==========================================
// 1. Loud alarm for the driver
const alarmSound = new Audio("https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg");
alarmSound.loop = true;

// 2. Phone ringing sound (simulating calling dispatch)
const ringingSound = new Audio("https://actions.google.com/sounds/v1/communications/ringback_tone.ogg");
ringingSound.loop = true;

// 3. Dispatch operator voice (simulated)
const synth = window.speechSynthesis;
let dispatchUtterance = null;

// ==========================================
// PREDICTION SMOOTHING
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
// THRESHOLDS 
// ==========================================
const ASLEEP_THRESHOLD = 0.70;
const SECONDS_TO_TRIGGER_ALARM = 15;
const EMERGENCY_CALL_DELAY = 10;

// ==========================================
// UI ELEMENTS
// ==========================================
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusBadge = document.getElementById('status-badge');
const badgeIcon = document.getElementById('badge-icon');
const badgeText = document.getElementById('badge-text');
const alarmOverlay = document.getElementById('alarm-overlay');
const emergencyOverlay = document.getElementById('emergency-overlay');
const dismissAlarmBtn = document.getElementById('dismiss-alarm');
const cancelEmergencyBtn = document.getElementById('cancel-emergency');
const startupMessage = document.getElementById('startup-message');
const statusChip = document.getElementById('status-chip');
const chipText = document.getElementById('chip-text');
const liveIndicator = document.getElementById('live-indicator');
const navStatusText = document.getElementById('nav-status-text');
const bigStatusIcon = document.getElementById('big-status-icon');
const bigStatusLabel = document.getElementById('big-status-label');
const bigStatusSub = document.getElementById('big-status-sub');
const mainStatusCard = document.getElementById('main-status-card');
const cameraContainer = document.getElementById('camera-container');
const countdownEl = document.getElementById('emergency-countdown');
const activityLog = document.getElementById('activity-log');
const scanLine = document.getElementById('scan-line');

// Emergency Overlay Specific Elements
const emergencyStatusText = document.getElementById('emergency-status-text');
const callTimer = document.getElementById('call-timer');
const callingDots = document.getElementById('calling-dots');

// Stats
const statUptime = document.getElementById('stat-uptime');
const statAlerts = document.getElementById('stat-alerts');
const statDrowsy = document.getElementById('stat-drowsy');
const statScore = document.getElementById('stat-score');

// Event Listeners
startBtn.addEventListener('click', init);
stopBtn.addEventListener('click', stopSystem);
dismissAlarmBtn.addEventListener('click', dismissAlarm);
cancelEmergencyBtn.addEventListener('click', cancelEmergency);

// ==========================================
// ACTIVITY LOGGING
// ==========================================
function logEvent(message, type = 'info') {
    // Remove the "empty" log message if it exists
    const emptyMsg = activityLog.querySelector('.log-empty');
    if (emptyMsg) {
        emptyMsg.remove();
    }

    const now = new Date();
    const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `
        <div class="log-time">${timeString}</div>
        <div class="log-dot ${type}"></div>
        <div class="log-message">${message}</div>
    `;

    activityLog.prepend(entry);

    // Keep max 50 entries
    if (activityLog.children.length > 50) {
        activityLog.removeChild(activityLog.lastChild);
    }
}

// ==========================================
// INIT
// ==========================================
async function init() {
    startBtn.disabled = true;
    if (startupMessage) startupMessage.innerHTML = '<p>Loading AI Model weights...</p>';

    if (synth.getVoices().length === 0) {
        synth.addEventListener('voiceschanged', () => { });
    }

    const modelURL = URL + "model.json";
    const metadataURL = URL + "metadata.json";

    try {
        logEvent('System booting up. Downloading neural network tensors...', 'info');
        model = await tmImage.load(modelURL, metadataURL);
        maxPredictions = model.getTotalClasses();

        const flip = true;
        webcam = new tmImage.Webcam(400, 300, flip);

        if (startupMessage) startupMessage.innerHTML = '<p>Establishing Camera Connection...</p>';
        await webcam.setup();

        if (startupMessage) startupMessage.style.display = 'none';
        await webcam.play();
        window.requestAnimationFrame(loop);

        document.getElementById("webcam-wrapper").appendChild(webcam.canvas);

        const labelContainer = document.getElementById("label-container");
        labelContainer.innerHTML = '';
        for (let i = 0; i < maxPredictions; i++) {
            const className = model.getClassLabels()[i];
            const cssClass = getClassCSS(className);
            labelContainer.innerHTML += `
                <div class="prediction-row" id="pred-row-${i}">
                    <div class="prediction-name">${className}</div>
                    <div class="prediction-track">
                        <div class="prediction-fill ${cssClass}" id="bar-${i}"></div>
                    </div>
                    <div class="prediction-percent" id="val-${i}">0%</div>
                </div>
            `;
        }

        predictionHistory = [];
        isRunning = true;
        sessionStartTime = Date.now();
        totalAlerts = 0;
        totalDrowsySeconds = 0;
        sessionInterval = setInterval(updateSessionStats, 1000);

        // Turn on AI visual effects
        scanLine.classList.remove('hidden');

        stopBtn.disabled = false;
        liveIndicator.classList.add('active');
        navStatusText.innerText = 'System Active';
        setStatus('awake', '👁️', 'AWAKE', 'Monitoring', 'Driver is alert and focused');
        logEvent('System initialization complete. Active monitoring commenced.', 'success');

    } catch (error) {
        if (startupMessage) {
            startupMessage.style.display = 'flex';
            startupMessage.innerHTML = '<p style="color: var(--accent-red);">Hardware error. Check camera permissions.</p>';
        }
        console.error("Initialization error:", error);
        logEvent('Error initializing AI model or camera.', 'danger');
        startBtn.disabled = false;
    }
}

// ==========================================
// MAIN LOOP
// ==========================================
async function loop() {
    if (!isRunning) return;
    webcam.update();
    await predict();
    window.requestAnimationFrame(loop);
}

async function predict() {
    const rawPrediction = await model.predict(webcam.canvas);
    const prediction = getSmoothedPredictions(rawPrediction);
    let isAsleep = false;

    for (let i = 0; i < maxPredictions; i++) {
        const value = (prediction[i].probability * 100).toFixed(0);
        const bar = document.getElementById(`bar-${i}`);
        const valText = document.getElementById(`val-${i}`);
        const className = prediction[i].className.toLowerCase();

        bar.style.width = value + "%";
        valText.innerText = value + "%";

        if (className.includes("sleepy") || className.includes("asleep")) {
            if (prediction[i].probability >= ASLEEP_THRESHOLD) {
                isAsleep = true;
            }
        }
    }

    handleDrowsinessLogic(isAsleep);
}

// ==========================================
// DROWSINESS LOGIC
// ==========================================
function handleDrowsinessLogic(isAsleep) {
    if (!alarmOverlay.classList.contains('hidden') || !emergencyOverlay.classList.contains('hidden')) {
        return;
    }

    if (isAsleep) {
        if (!currentSleepSessionStart) {
            currentSleepSessionStart = Date.now();
        }

        if (!drowsyStartTime) drowsyStartTime = Date.now();

        const continuousSleepSeconds = (Date.now() - currentSleepSessionStart) / 1000;

        // Log the first instance of drowsiness in a single block
        if (continuousSleepSeconds > 1 && !hasLoggedDrowsyWarningThisSession) {
            logEvent('Warning: Driver fatigue indicator detected. Initiating critical timer sequence.', 'warning');
            hasLoggedDrowsyWarningThisSession = true;
        }

        if (continuousSleepSeconds < SECONDS_TO_TRIGGER_ALARM) {
            const timeRemaining = Math.ceil(SECONDS_TO_TRIGGER_ALARM - continuousSleepSeconds);
            setStatus('sleepy', '😑', 'DROWSY', 'Danger!', `Unresponsive for ${Math.floor(continuousSleepSeconds)}s. Alarm in ${timeRemaining}s...`);
        } else {
            triggerAlarm();
        }
    } else {
        if (drowsyStartTime) {
            totalDrowsySeconds += (Date.now() - drowsyStartTime) / 1000;
            drowsyStartTime = null;
        }

        if (hasLoggedDrowsyWarningThisSession && currentSleepSessionStart) {
            logEvent('Driver consciousness re-established.', 'info');
        }

        currentSleepSessionStart = null;
        hasLoggedDrowsyWarningThisSession = false;
        setStatus('awake', '👁️', 'AWAKE', 'Monitoring', 'Driver is alert and focused');
    }
}

// ==========================================
// STATUS UI HELPER
// ==========================================
function setStatus(state, icon, badge, chipLabel, description) {
    cameraContainer.className = 'camera-container ' + state;

    badgeIcon.innerText = icon;
    badgeText.innerText = badge;

    statusChip.className = 'status-chip ' + state;
    chipText.innerText = chipLabel;

    mainStatusCard.className = 'card status-card animate-fade-in ' + state;
    bigStatusIcon.innerText = icon;
    bigStatusLabel.innerText = badge;
    bigStatusLabel.style.color = state === 'awake' ? 'var(--accent-green)' :
        state === 'sleepy' ? 'var(--accent-red)' :
            'var(--accent-amber)';
    bigStatusSub.innerText = description;
}

// ==========================================
// ALARM & EMERGENCY
// ==========================================
function triggerAlarm() {
    logEvent('CRITICAL: Target awake threshold failed. Primary auditory alarm triggered.', 'danger');

    totalAlerts++;
    statAlerts.innerText = totalAlerts;

    alarmOverlay.classList.remove('hidden');
    alarmSound.play().catch(e => console.log("Audio blocked:", e));

    let countdown = EMERGENCY_CALL_DELAY;
    countdownEl.innerText = countdown;

    countdownInterval = setInterval(() => {
        countdown--;
        countdownEl.innerText = countdown;
        if (countdown <= 0) {
            clearInterval(countdownInterval);
            triggerEmergency();
        }
    }, 1000);
}

function dismissAlarm() {
    logEvent('Operator intervention: Protocol aborted. Driver awake.', 'success');

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
    logEvent('EMERGENCY PROTOCOL ENGAGED. Initiating connection to Central Dispatch.', 'danger');

    alarmOverlay.classList.add('hidden');
    emergencyOverlay.classList.remove('hidden');

    alarmSound.pause();
    alarmSound.currentTime = 0;

    startSimulatedCall();
}

function startSimulatedCall() {
    ringingSound.play().catch(e => console.log("Audio blocked:", e));

    emergencyStatusText.innerText = "Driver unresponsive — Calling dispatch...";
    callTimer.innerText = "Calling...";
    callingDots.style.display = "flex";

    emergencyTimer = setTimeout(() => {
        ringingSound.pause();
        ringingSound.currentTime = 0;

        emergencyStatusText.innerText = "Call connected. Transmitting GPS coordinates...";
        callingDots.style.display = "none";

        logEvent('Call successfully patched to Central Dispatch queue.', 'info');

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
    const message = "Emergency Alert. Driver Watch system reports an unresponsive driver. GPS location verified. Trying to establish contact with driver. Hello? Can you hear me?";

    dispatchUtterance = new SpeechSynthesisUtterance(message);
    dispatchUtterance.rate = 0.95;
    dispatchUtterance.pitch = 1.0;

    const voices = synth.getVoices();
    const systemVoice = voices.find(v => v.lang.includes('en-US')) || voices[0];
    if (systemVoice) {
        dispatchUtterance.voice = systemVoice;
    }

    synth.speak(dispatchUtterance);
}

function cancelEmergency() {
    logEvent('Emergency protocol overriden by operator (False Alarm).', 'success');

    emergencyOverlay.classList.add('hidden');

    alarmSound.pause();
    alarmSound.currentTime = 0;

    ringingSound.pause();
    ringingSound.currentTime = 0;

    if (synth && synth.speaking) {
        synth.cancel();
    }

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
// SESSION STATS
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

    const alertness = elapsed > 0 ? Math.max(0, Math.round(100 - (currentDrowsy / elapsed * 100))) : 100;
    statScore.innerText = alertness + '%';
    statScore.style.color = alertness >= 80 ? 'var(--accent-green)' :
        alertness >= 50 ? 'var(--accent-amber)' :
            'var(--accent-red)';
}

// ==========================================
// STOP SYSTEM
// ==========================================
function stopSystem() {
    logEvent('System shut down by operator order.', 'info');

    isRunning = false;
    predictionHistory = [];
    clearInterval(sessionInterval);

    // Turn off AI visual effects
    scanLine.classList.add('hidden');

    if (webcam) {
        webcam.stop();
        const wrapper = document.getElementById("webcam-wrapper");
        wrapper.innerHTML = `
            <div class="webcam-placeholder" id="startup-message">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                    <circle cx="12" cy="13" r="4"/>
                </svg>
                <p>System stopped. Click <strong>Start System</strong> to resume.</p>
            </div>
        `;
    }

    startBtn.disabled = false;
    stopBtn.disabled = true;
    liveIndicator.classList.remove('active');
    navStatusText.innerText = 'System Offline';
    cameraContainer.className = 'camera-container';

    badgeIcon.innerText = '⏸️';
    badgeText.innerText = 'OFFLINE';

    statusChip.className = 'status-chip';
    chipText.innerText = 'Stopped';

    mainStatusCard.className = 'card status-card';
    bigStatusIcon.innerText = '⏸️';
    bigStatusLabel.innerText = 'Offline';
    bigStatusLabel.style.color = 'var(--text-secondary)';
    bigStatusSub.innerText = 'System is not active';
}

function getClassCSS(className) {
    const lower = className.toLowerCase();
    if (lower.includes('awake')) return 'awake';
    if (lower.includes('sleepy') || lower.includes('asleep')) return 'sleepy';
    if (lower.includes('neutral')) return 'neutral';
    return 'other';
}
