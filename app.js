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
// Using Web Speech API for a robotic but clear "dispatch" voice
const synth = window.speechSynthesis;
let dispatchUtterance = null;

// ==========================================
// PREDICTION SMOOTHING
// Averages the last N frames to reduce noise
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

// Thresholds
const ASLEEP_THRESHOLD = 0.70;
const SECONDS_TO_TRIGGER_ALARM = 15;
const EMERGENCY_CALL_DELAY = 10;

// UI Elements
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
// INIT
// ==========================================
async function init() {
    startBtn.disabled = true;
    if (startupMessage) startupMessage.innerHTML = '<p>Loading AI Model...</p>';

    // Pre-load voices for the dispatch simulation
    if (synth.getVoices().length === 0) {
        synth.addEventListener('voiceschanged', () => { });
    }

    const modelURL = URL + "model.json";
    const metadataURL = URL + "metadata.json";

    try {
        model = await tmImage.load(modelURL, metadataURL);
        maxPredictions = model.getTotalClasses();

        const flip = true;
        webcam = new tmImage.Webcam(400, 300, flip);

        if (startupMessage) startupMessage.innerHTML = '<p>Requesting Camera Access...</p>';
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

        stopBtn.disabled = false;
        liveIndicator.classList.add('active');
        navStatusText.innerText = 'System Active';
        setStatus('awake', '👁️', 'AWAKE', 'Monitoring', 'Driver is alert and focused');

    } catch (error) {
        if (startupMessage) {
            startupMessage.style.display = 'flex';
            startupMessage.innerHTML = '<p style="color: var(--accent-red);">Error loading model. Check console for details.</p>';
        }
        console.error("Initialization error:", error);
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

        currentSleepSessionStart = null;
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

    mainStatusCard.className = 'card status-card ' + state;
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
    totalAlerts++;
    statAlerts.innerText = totalAlerts;

    alarmOverlay.classList.remove('hidden');

    // Play the loud alarm clock sound
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
    alarmOverlay.classList.add('hidden');
    alarmSound.pause();
    alarmSound.currentTime = 0;

    clearInterval(countdownInterval);
    clearTimeout(emergencyTimer);
    currentSleepSessionStart = null;

    if (drowsyStartTime) {
        totalDrowsySeconds += (Date.now() - drowsyStartTime) / 1000;
        drowsyStartTime = null;
    }
}

function triggerEmergency() {
    // Hide the initial alarm, show the emergency call screen
    alarmOverlay.classList.add('hidden');
    emergencyOverlay.classList.remove('hidden');

    // Stop the alarm clock, start the phone ringing
    alarmSound.pause();
    alarmSound.currentTime = 0;

    startSimulatedCall();
}

function startSimulatedCall() {
    // 1. Start ringing sound
    ringingSound.play().catch(e => console.log("Audio blocked:", e));

    emergencyStatusText.innerText = "Driver unresponsive — Calling dispatch...";
    callTimer.innerText = "Calling...";
    callingDots.style.display = "flex";

    // 2. Wait 6 seconds (ringing), then "Answer" the call
    emergencyTimer = setTimeout(() => {
        // Stop ringing
        ringingSound.pause();
        ringingSound.currentTime = 0;

        // Update UI to show call connected
        emergencyStatusText.innerText = "Call connected. Transmitting GPS coordinates...";
        callingDots.style.display = "none";

        // Start call duration timer
        let seconds = 0;
        simulatedCallInterval = setInterval(() => {
            seconds++;
            const m = String(Math.floor(seconds / 60)).padStart(2, '0');
            const s = String(seconds % 60).padStart(2, '0');
            callTimer.innerText = `${m}:${s}`;
        }, 1000);

        // 3. Play simulated dispatcher voice reading coordinates/alert
        playDispatcherVoice();

    }, 6000);
}

function playDispatcherVoice() {
    // Uses the browser's built-in text-to-speech to sound like an automated dispatch system
    const message = "Emergency Alert. Driver Watch system reports an unresponsive driver. GPS location verified. Trying to establish contact with driver. Hello? Can you hear me?";

    dispatchUtterance = new SpeechSynthesisUtterance(message);
    dispatchUtterance.rate = 0.95;
    dispatchUtterance.pitch = 1.0;

    // Try to find an English (US or UK) voice
    const voices = synth.getVoices();
    const systemVoice = voices.find(v => v.lang.includes('en-US')) || voices[0];
    if (systemVoice) {
        dispatchUtterance.voice = systemVoice;
    }

    synth.speak(dispatchUtterance);
}

function cancelEmergency() {
    // Clean up everything related to the emergency state
    emergencyOverlay.classList.add('hidden');

    alarmSound.pause();
    alarmSound.currentTime = 0;

    ringingSound.pause();
    ringingSound.currentTime = 0;

    if (synth && synth.speaking) {
        synth.cancel(); // Stop talking
    }

    clearTimeout(emergencyTimer);
    clearInterval(simulatedCallInterval);

    currentSleepSessionStart = null;

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
    isRunning = false;
    predictionHistory = [];
    clearInterval(sessionInterval);

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
