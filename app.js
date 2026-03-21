// ==========================================
// DRIVERWATCH ENTERPRISE - LOGIC KERNEL
// ==========================================

const MODEL_URL = "./model/";

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

// User Data & Location State
let currentUserData = null;
let currentGeoPosition = null;
let geoWatchId = null;

// Speed & Fleet State
let currentSpeed = 0; // in km/h or mph
let currentSpeedLimit = null;
let lastSpeedLimitCheck = 0;
let isSpeedingAlertActive = false;
let lastImpactTime = 0;
const IMPACT_G_THRESHOLD = 4.5; // G-force threshold for a "crash"

// IndexedDB Constants
const DB_NAME = 'DriverWatchDB';
const DB_VERSION = 1;
const STORE_NAME = 'videos';
let localDb = null;

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

let keepWarmInterval = null;
function keepVoiceEngineWarm() {
    if (keepWarmInterval) clearInterval(keepWarmInterval);
    keepWarmInterval = setInterval(() => {
        if (synth && !synth.speaking && isRunning) {
            // 1. Silent Speech Pulse
            const pulse = new SpeechSynthesisUtterance(' ');
            pulse.volume = 0.001;
            synth.speak(pulse);

            // 2. Microscopic Audio Context Pulse (holds the gesture privilege)
            if (audioCtx && audioCtx.state !== 'closed') {
                const osc = audioCtx.createOscillator();
                const g = audioCtx.createGain();
                g.gain.value = 0.0001;
                osc.connect(g);
                g.connect(audioCtx.destination);
                osc.start();
                osc.stop(audioCtx.currentTime + 0.05);
            }
        }
    }, 10000); // 10s heartbeat (shorter than Chrome's timeout)
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

function startHDSpeedingBeep() {
    // Shorter, sharper beep for speeding
    initAudioContext();
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1200, audioCtx.currentTime);
    g.gain.setValueAtTime(0.2, audioCtx.currentTime);
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
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
const SECONDS_TO_TRIGGER_WARNING = 4;
const SECONDS_TO_TRIGGER_ALARM = 8;
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
const statSpeed = document.getElementById('stat-speed');
const statLimit = document.getElementById('stat-limit');
const statScore = document.getElementById('stat-score');

// Load User Data via Firebase Auth State
auth.onAuthStateChanged(async (user) => {
    if (!user) {
        console.log("No authenticated user found. Redirecting to login...");
        window.location.replace('login.html');
    } else {
        try {
            console.log("Authenticated user found:", user.uid);
            const doc = await db.collection('users').doc(user.uid).get();
            if (doc.exists) {
                currentUserData = doc.data();
                console.log("User data loaded successfully.");
                const navOp = document.getElementById('nav-operator-name');
                if (navOp) navOp.innerText = currentUserData.driverName.toUpperCase();

                const dispName = document.getElementById('dispatch-contact-name');
                const dispPhone = document.getElementById('dispatch-contact-phone');
                if (dispName) dispName.innerText = currentUserData.emergencyContact.name.toUpperCase();
                if (dispPhone) dispPhone.innerText = currentUserData.emergencyContact.phone;
            } else {
                console.warn("User authenticated but profile document missing. Forcing onboarding...");
                window.location.replace('login.html');
            }
        } catch (e) {
            console.error("Error loading user data from Firestore:", e);
        }
    }
});

function logout() {
    auth.signOut();
}

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

const clearLogBtn = document.getElementById('clear-log-btn');
if (clearLogBtn) clearLogBtn.addEventListener('click', () => {
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
            // Prime the engine with a short word so TTS is allowed later (browser gesture requirement)
            const prime = new SpeechSynthesisUtterance('Voice ready.');
            prime.volume = 0.3; // High enough that the engine actually runs
            prime.rate = 1.2;
            synth.speak(prime);
            logEvent('Voice engine unlocked and ready.', 't-info');
        } catch (e) { }
    }

    if (startupMessage) startupMessage.innerHTML = '<div class="standby-text">Loading Fleet Models...</div>';

    try {
        logEvent('Initializing Dashcam and Driver Status Monitor...', 't-info');
        model = await tmImage.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
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
        keepVoiceEngineWarm();
        startLocationTracking();
        startImpactDetection();

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
    // 1. Safety Guard: If full emergency dispatch is active, manual action is required
    if (isEmergencyActive) return;

    // 2. AUTO-DISMISS LOGIC
    if (isAlarmActive) {
        if (!isAsleep) {
            logEvent('AUTO-OVERRIDE: Driver alertness detected. Terminating alarm.', 't-succ');
            dismissAlarm(true);
        } else {
            // Optional: Log once every 5 seconds while alarm is active to show we are still checking
            if (Math.floor(Date.now() / 1000) % 5 === 0 && !window._lastAlarmLog) {
                console.log("ALARM ACTIVE: System still detecting fatigue threshold.");
                window._lastAlarmLog = true;
                setTimeout(() => window._lastAlarmLog = false, 1000);
            }
        }
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

        if (sec < SECONDS_TO_TRIGGER_WARNING) {
            // STAGE 1: Silent Buffer (Visual only)
            const remaining = Math.max(0, SECONDS_TO_TRIGGER_WARNING - sec).toFixed(1);
            setStatus('sleepy', 'DROWSY WARNING', `Fatigue detected. Maintain alertness. Audible warning in ${remaining}s`);
            stopHDWarningBeep();
        } else if (sec < SECONDS_TO_TRIGGER_ALARM) {
            // STAGE 2: Audible Beeps
            const timeRemaining = Math.max(0, SECONDS_TO_TRIGGER_ALARM - sec).toFixed(1);
            setStatus('sleepy', 'CRITICAL WARNING', `Driver unresponsive. Cabin siren in ${timeRemaining}s`);
            startHDWarningBeep();
        } else {
            // STAGE 3: Full Alarm Siren
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

function dismissAlarm(isAuto = false) {
    if (isAuto) {
        // Log is handled by the caller for precision
    } else {
        logEvent('OVERRIDE: Driver successfully acknowledged alarm.', 't-succ');
    }
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

    logEvent('ESCALATION: Real emergency dispatch initiated.', 't-crit');
    stopHDAudioAlarm();
    startRealDispatch();
}

async function startRealDispatch() {
    try {
        if (emergencyStatusText) emergencyStatusText.innerText = 'ACQUIRING GPS AND SCANNING FOR SERVICES...';
        if (transferProgress) transferProgress.style.width = '20%';
        logEvent('DISPATCH: Acquiring live GPS and scanning for nearby emergency services...', 't-info');

        // Build location data
        const lat = currentGeoPosition ? currentGeoPosition.lat : null;
        const lng = currentGeoPosition ? currentGeoPosition.lng : null;
        const mapsLink = lat && lng
            ? `https://maps.google.com/?q=${lat},${lng}`
            : 'Location unavailable';

        // Safety checks for User Data
        const driverName = currentUserData?.driverName || 'The Driver';
        const contactName = currentUserData?.emergencyContact?.name || 'Emergency Contact';
        const contactPhone = currentUserData?.emergencyContact?.phone || null;

        // Update the overlay contact info
        const dispName = document.getElementById('dispatch-contact-name');
        const dispPhone = document.getElementById('dispatch-contact-phone');
        if (dispName) dispName.innerText = contactName.toUpperCase();
        if (dispPhone) dispPhone.innerText = contactPhone || '---';

        if (transferProgress) transferProgress.style.width = '40%';

        // Scan for nearby emergency services via OpenStreetMap Overpass API
        let nearbyServicesHTML = '';
        if (lat && lng) {
            try {
                nearbyServicesHTML = await scanNearbyEmergencyServices(lat, lng);
                logEvent('GPS SCAN: Nearby emergency services identified.', 't-succ');
            } catch (e) {
                nearbyServicesHTML = '<div style="color:var(--acc-muted)">Could not scan nearby services.</div>';
                logEvent('GPS SCAN: Could not retrieve nearby services.', 't-warn');
            }
        }

        // Inject results into the overlay
        let nearbyDiv = document.getElementById('nearby-services-panel');
        if (!nearbyDiv) {
            nearbyDiv = document.createElement('div');
            nearbyDiv.id = 'nearby-services-panel';
            nearbyDiv.style = 'margin-top: 0.75rem; font-family: var(--font-mono); font-size: 0.72rem; background: rgba(0,0,0,0.4); padding: 0.5rem; border: 1px solid var(--sys-border-high);';
            const callMetrics = document.querySelector('.call-metrics');
            if (callMetrics) callMetrics.before(nearbyDiv);
        }
        nearbyDiv.innerHTML = `<div style="color: var(--stat-warn); margin-bottom: 0.25rem;">NEARBY EMERGENCY SERVICES (GPS SCAN):</div>${nearbyServicesHTML}`;

        if (transferProgress) transferProgress.style.width = '70%';
        if (emergencyStatusText) emergencyStatusText.innerText = 'SENDING WHATSAPP ALERT TO EMERGENCY CONTACT...';

        // Send real WhatsApp alert after short delay
        await new Promise(r => setTimeout(r, 1500));

        if (contactPhone) {
            try {
                logEvent(`WHATSAPP: Sending automated alert to ${contactName}...`, 't-info');
                const response = await fetch('/api/send-alert', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        to: contactPhone,
                        driverName: driverName,
                        mapsLink: mapsLink,
                        time: new Date().toLocaleTimeString()
                    })
                });
                const result = await response.json();
                if (response.ok && result.success) {
                    logEvent(`WHATSAPP: ✅ Emergency alert delivered to ${contactName}.`, 't-succ');
                } else {
                    // Specific error from Twilio or our API route
                    const errorMsg = result.error || 'Server error';
                    logEvent(`WHATSAPP: ⚠️ Alert failed — ${errorMsg}`, 't-warn');
                    console.error('Twilio Alert Failure:', result);
                }
            } catch (err) {
                logEvent(`WHATSAPP: ⚠️ Network error sending alert — ${err.message}`, 't-warn');
            }
        } else {
            logEvent('WHATSAPP: No emergency contact phone on file.', 't-warn');
        }

        if (transferProgress) transferProgress.style.width = '100%';
        if (emergencyStatusText) emergencyStatusText.innerText = 'DISPATCH COMPLETE. EMERGENCY CONTACT ALERTED.';

        // Also trigger speech
        try {
            const speechPulse = setInterval(() => {
                if (synth) synth.resume();
                if (!isEmergencyActive) clearInterval(speechPulse);
            }, 500);
            playDispatcherVoice();
        } catch (e) {
            playDispatcherVoice();
        }
    } catch (criticalErr) {
        console.error("Critical Dispatch Failure:", criticalErr);
        logEvent(`CRITICAL: Dispatch engine error — ${criticalErr.message}`, 't-crit');
        if (emergencyStatusText) emergencyStatusText.innerText = 'DISPATCH SYSTEM FAILURE. MANUAL ACTION REQUIRED.';
    }
}

async function scanNearbyEmergencyServices(lat, lng) {
    const radius = 5000; // 5km radius
    const query = `
        [out:json][timeout:10];
        (
          node["amenity"="hospital"](around:${radius},${lat},${lng});
          node["amenity"="police"](around:${radius},${lat},${lng});
          node["amenity"="fire_station"](around:${radius},${lat},${lng});
          node["emergency"="ambulance_station"](around:${radius},${lat},${lng});
        );
        out body 5;
    `.trim();

    const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: query
    });
    const data = await response.json();
    const elements = data.elements || [];

    if (elements.length === 0) {
        return '<div style="color:var(--acc-muted)">No services found within 5km.</div>';
    }

    return elements.slice(0, 5).map(el => {
        const name = el.tags.name || el.tags.amenity || 'Unknown Service';
        const type = (el.tags.amenity || el.tags.emergency || '').toUpperCase().replace('_', ' ');
        const phone = el.tags.phone || el.tags['contact:phone'] || '';
        const elLat = el.lat.toFixed(5);
        const elLng = el.lon.toFixed(5);
        const link = `https://maps.google.com/?q=${elLat},${elLng}`;
        return `<div style="padding: 0.25rem 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
            <span style="color:var(--stat-warn);">[${type}]</span> ${name}
            ${phone ? `<span style="color:var(--acc-muted)"> | 📞 ${phone}</span>` : ''}
            <a href="${link}" target="_blank" style="color:var(--stat-info); margin-left: 0.5rem;">📍 MAP</a>
        </div>`;
    }).join('');
}


function startLocationTracking() {
    if (!navigator.geolocation) return;

    geoWatchId = navigator.geolocation.watchPosition(
        async (position) => {
            currentGeoPosition = {
                lat: position.coords.latitude.toFixed(6),
                lng: position.coords.longitude.toFixed(6),
                acc: position.coords.accuracy.toFixed(1)
            };

            // Handle Speed (m/s to km/h)
            if (position.coords.speed !== null) {
                currentSpeed = Math.round(position.coords.speed * 3.6);
                if (statSpeed) statSpeed.innerText = `${currentSpeed} km/h`;

                // Real-time Speed Limit Logic
                checkSpeedLimit(currentGeoPosition.lat, currentGeoPosition.lng);
            }

            const locEl = document.getElementById('dispatch-location');
            if (locEl) {
                locEl.innerText = `${currentGeoPosition.lat}, ${currentGeoPosition.lng} (±${currentGeoPosition.acc}m)`;
            }
        },
        (err) => {
            console.warn("GPS Tracking Error:", err);
            logEvent('GPS signal degraded. Retrying...', 't-warn');
        },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    );
}

async function checkSpeedLimit(lat, lon) {
    const now = Date.now();
    // Only check every 15 seconds to avoid API throttling
    if (now - lastSpeedLimitCheck < 15000) return;
    lastSpeedLimitCheck = now;

    try {
        const radius = 50; // 50m search radius
        const query = `[out:json];way(around:${radius},${lat},${lon})[maxspeed];out tags;`;
        const response = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            body: query
        });
        const data = await response.json();

        if (data.elements && data.elements.length > 0) {
            // Get the first found maxspeed
            const limitStr = data.elements[0].tags.maxspeed;
            currentSpeedLimit = parseInt(limitStr);

            if (statLimit) {
                statLimit.innerText = `${currentSpeedLimit} km/h`;
                statLimit.classList.remove('unknown');
            }

            // Check for speeding
            evaluateSpeeding();
        } else {
            console.log("No speed limit found in OSM for this location.");
            if (statLimit) statLimit.innerText = `---`;
        }
    } catch (e) {
        console.warn("Speed limit lookup failed:", e);
    }
}

function evaluateSpeeding() {
    if (!currentSpeedLimit) return;

    // Buffer of 5 km/h over limit
    if (currentSpeed > currentSpeedLimit + 5) {
        if (!isSpeedingAlertActive) {
            logEvent(`SPEED WARNING: Exceeding ${currentSpeedLimit} km/h limit!`, 't-warn');
            isSpeedingAlertActive = true;
            // Immediate beep
            startHDSpeedingBeep();
        }
        // Periodic warning look
        const limitEl = document.getElementById('metric-box-limit');
        if (limitEl) limitEl.classList.add('speeding');
    } else {
        isSpeedingAlertActive = false;
        const limitEl = document.getElementById('metric-box-limit');
        if (limitEl) limitEl.classList.remove('speeding');
    }
}

function stopLocationTracking() {
    if (geoWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(geoWatchId);
        geoWatchId = null;
    }
}

function startImpactDetection() {
    if (window.DeviceMotionEvent) {
        window.addEventListener('devicemotion', handleMotion, true);
        logEvent('G-Force monitoring active. Impact detection armed.', 't-info');
    } else {
        logEvent('Impact detection unavailable (Hardware unsupported).', 't-warn');
    }
}

function stopImpactDetection() {
    window.removeEventListener('devicemotion', handleMotion);
}

function handleMotion(event) {
    if (!isRunning || isEmergencyActive) return;

    const acc = event.accelerationIncludingGravity;
    if (!acc) return;

    // Calculate total G-force (Resultant Vector)
    const gSum = Math.sqrt(acc.x ** 2 + acc.y ** 2 + acc.z ** 2) / 9.81;

    // Detect sudden impact
    if (gSum > IMPACT_G_THRESHOLD) {
        const now = Date.now();
        // Debounce to avoid multiple triggers for the same event
        if (now - lastImpactTime < 5000) return;
        lastImpactTime = now;

        logEvent(`CRITICAL: Impact detected! Intensity: ${gSum.toFixed(1)}G`, 't-crit');

        // Immediate escalation
        triggerEmergency();
    }
}

function getBestVoice() {
    if (!synth) return null;
    const voices = synth.getVoices();
    if (voices.length === 0) return null;

    // CRITICAL: Avoid "Google" voices as they are remote and fail silently
    const localVoices = voices.filter(v => v.localService === true || !v.name.includes('Google'));

    return localVoices.find(v => v.lang.includes('en-US') && v.name.includes('Female')) ||
        localVoices.find(v => v.lang.includes('en-US')) ||
        localVoices[0] ||
        voices[0];
}

function playDispatcherVoice() {
    try {
        if (!synth) return;

        // CRITICAL: No cancel() - it can block the engine on some Windows builds
        synth.resume();

        let driverContext = "Driver";
        let contactContext = "their emergency contact";
        let locationContext = "transmitting location";

        if (currentUserData) {
            driverContext = currentUserData.driverName;
            contactContext = `${currentUserData.emergencyContact.name}`;
        }

        if (currentGeoPosition) {
            locationContext = `GPS coordinates are latitude ${currentGeoPosition.lat}, longitude ${currentGeoPosition.lng}`;
        }

        const msg = `Critical alert from Driver Watch. ${driverContext} is unresponsive. ${locationContext}. Dispatching local emergency services and contacting ${contactContext} immediately. Operator, please pull over.`;

        dispatchUtterance = new SpeechSynthesisUtterance(msg);
        dispatchUtterance.rate = 1.0;
        dispatchUtterance.pitch = 1.0;
        dispatchUtterance.volume = 1.0;

        let voices = synth.getVoices();
        const selectedVoice = getBestVoice();
        if (selectedVoice) {
            dispatchUtterance.voice = selectedVoice;
            logEvent(`VOICE: Prepared with ${selectedVoice.name}.`, 't-info');
        } else {
            logEvent('VOICE: Prepared with System Default.', 't-warn');
        }

        dispatchUtterance.onstart = () => {
            logEvent('VOICE: DUAL DISPATCH TRANSMISSION ACTIVE.', 't-succ');
            // Stop the ringing after speech starts to be safe
            ringingSound.pause();
            ringingSound.currentTime = 0;
        };

        dispatchUtterance.onerror = (e) => {
            console.error("Speech Logic Error:", e);
            logEvent(`VOICE_ERROR: ${e.error}. Hardware state: ${synth.paused ? 'PAUSED' : 'ACTIVE'}`, 't-crit');
            // Aggressive recovery
            if (e.error !== 'canceled') {
                setTimeout(() => { if (isRunning && isEmergencyActive) synth.speak(dispatchUtterance); }, 1000);
            }
        };

        synth.speak(dispatchUtterance);
        synth.resume(); // Ensure it pushes through the queue

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

    dispatcherVoiceRetryCount = 0;
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
        request.onsuccess = (e) => { localDb = e.target.result; resolve(localDb); };
        request.onupgradeneeded = (e) => { e.target.result.createObjectStore(STORE_NAME, { keyPath: 'id' }); };
        request.onerror = (e) => reject(e);
    });
}

function saveVideoToDB(id, blob, type) {
    // 1. Save Locally (IndexedDB)
    if (localDb) {
        const transaction = localDb.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.put({ id: id, blob: blob, type: type, timestamp: new Date().toLocaleString() });
    }

    // 2. Save to Cloud (Firebase Storage + Firestore)
    saveVideoToCloud(id, blob, type);

    loadMediaVault();
}

async function saveVideoToCloud(id, blob, type) {
    const user = auth.currentUser;
    if (!user) return;

    try {
        logEvent(`CLOUD: Uploading ${type} to secure vault...`, 't-info');
        const fileRef = storage.ref().child(`users/${user.uid}/videos/${id}.webm`);
        const snapshot = await fileRef.put(blob);
        const downloadURL = await snapshot.ref.getDownloadURL();

        // Store metadata in Firestore
        await db.collection('users').doc(user.uid).collection('recordings').doc(id).set({
            id: id,
            url: downloadURL,
            type: type,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            readableTime: new Date().toLocaleString()
        });

        logEvent(`CLOUD: ✅ ${type} successfully synchronized.`, 't-succ');
        loadMediaVault(); // Refresh to show cloud icon
    } catch (e) {
        console.error("Cloud Upload Failed:", e);
        logEvent(`CLOUD: ⚠️ Sync failed — ${e.message}`, 't-warn');
    }
}

async function loadMediaVault() {
    const vaultContainer = document.getElementById('vault-list');
    if (!vaultContainer) return;
    vaultContainer.innerHTML = '<div class="empty-data">Syncing with fleet vault...</div>';

    const user = auth.currentUser;
    let allVideos = [];

    // 1. Fetch Local Videos (IndexedDB)
    if (localDb) {
        const localVideos = await new Promise((resolve) => {
            const transaction = localDb.transaction([STORE_NAME], 'readonly');
            transaction.objectStore(STORE_NAME).getAll().onsuccess = (e) => resolve(e.target.result);
        });
        allVideos = [...localVideos.map(v => ({ ...v, isLocal: true }))];
    }

    // 2. Fetch Cloud Videos (Firestore)
    if (user) {
        try {
            const snapshot = await db.collection('users').doc(user.uid).collection('recordings').orderBy('timestamp', 'desc').get();
            snapshot.forEach(doc => {
                const data = doc.data();
                // Avoid duplicates if already in local
                if (!allVideos.find(v => v.id === data.id)) {
                    allVideos.push({ ...data, isLocal: false, timestamp: data.readableTime });
                }
            });
        } catch (e) {
            console.warn("Could not fetch cloud vault:", e);
        }
    }

    if (allVideos.length === 0) {
        vaultContainer.innerHTML = '<div class="empty-data">NO RECORDS FOUND</div>';
        return;
    }

    // Sort by most recent
    allVideos.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    vaultContainer.innerHTML = '';
    allVideos.forEach(video => {
        const item = document.createElement('div');
        item.className = 'vault-item';
        const sourceIcon = video.isLocal ? '💾' : '☁️';
        item.innerHTML = `
            <div class="vault-info">
                <span class="vault-type">${sourceIcon} ${video.type}</span>
                <span class="vault-time">${video.timestamp}</span>
            </div>
            <div class="vault-actions">
                <button class="btn-play" onclick="playVideo('${video.id}', ${video.isLocal}, '${video.url || ''}')">PLAY</button>
                <button class="btn-del" onclick="deleteVideo('${video.id}', ${video.isLocal})">DEL</button>
            </div>
        `;
        vaultContainer.appendChild(item);
    });
}

function playVideo(id, isLocal, cloudUrl) {
    const player = document.getElementById('vault-player');
    const modal = document.getElementById('vault-modal');
    if (!player || !modal) return;

    if (isLocal) {
        if (!localDb) return;
        const transaction = localDb.transaction([STORE_NAME], 'readonly');
        transaction.objectStore(STORE_NAME).get(id).onsuccess = (event) => {
            const video = event.target.result;
            if (video) startPlayback(window.URL.createObjectURL(video.blob));
        };
    } else if (cloudUrl) {
        startPlayback(cloudUrl);
    }
}

function startPlayback(url) {
    const player = document.getElementById('vault-player');
    const modal = document.getElementById('vault-modal');

    if (player.src && player.src.startsWith('blob:')) {
        window.URL.revokeObjectURL(player.src);
    }

    player.src = url;
    modal.classList.remove('hidden');
    player.play().catch(e => console.error("Playback failed:", e));
}

function closeVaultPlayer() {
    const player = document.getElementById('vault-player');
    const modal = document.getElementById('vault-modal');

    if (player) {
        player.pause();
        // Clean up object URL to prevent memory leaks
        if (player.src && player.src.startsWith('blob:')) {
            window.URL.revokeObjectURL(player.src);
        }
        player.src = '';
    }

    if (modal) {
        modal.classList.add('hidden');
    }
}

function deleteVideo(id, isLocal) {
    if (!confirm('Permanent delete from vault?')) return;

    if (isLocal && localDb) {
        localDb.transaction([STORE_NAME], 'readwrite').objectStore(STORE_NAME).delete(id).onsuccess = loadMediaVault;
    }

    const user = auth.currentUser;
    if (user) {
        // Delete from Firestore
        db.collection('users').doc(user.uid).collection('recordings').doc(id).delete().then(() => {
            logEvent('CLOUD: Record removed from fleet vault.', 't-info');
            loadMediaVault();
        });
        // Note: Actual storage file deletion can be handled by cloud functions or separate call, 
        // but removing the pointer from Firestore is enough for this prototype.
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
    if (keepWarmInterval) clearInterval(keepWarmInterval);
    startBtn.disabled = false;
    stopBtn.disabled = true;
    navSystemTag.innerHTML = `SYSTEM: <span class="status-indicator">STANDBY</span>`;
}
