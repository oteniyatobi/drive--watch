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

    logEvent('ESCALATION: Real emergency dispatch initiated.', 't-crit');
    stopHDAudioAlarm();
    startRealDispatch();
}

async function startRealDispatch() {
    if (emergencyStatusText) emergencyStatusText.innerText = 'ACQUIRING GPS AND SCANNING FOR SERVICES...';
    if (transferProgress) transferProgress.style.width = '20%';
    logEvent('DISPATCH: Acquiring live GPS and scanning for nearby emergency services...', 't-info');

    // Build location data
    const lat = currentGeoPosition ? currentGeoPosition.lat : null;
    const lng = currentGeoPosition ? currentGeoPosition.lng : null;
    const mapsLink = lat && lng
        ? `https://maps.google.com/?q=${lat},${lng}`
        : 'Location unavailable';

    const driverName = currentUserData ? currentUserData.driverName : 'The Driver';
    const contactName = currentUserData ? currentUserData.emergencyContact.name : 'Emergency Contact';
    const contactPhone = currentUserData ? currentUserData.emergencyContact.phone : null;

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
        (position) => {
            currentGeoPosition = {
                lat: position.coords.latitude.toFixed(6),
                lng: position.coords.longitude.toFixed(6),
                acc: position.coords.accuracy.toFixed(1)
            };
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

function stopLocationTracking() {
    if (geoWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(geoWatchId);
        geoWatchId = null;
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
    if (!localDb) return;
    const transaction = localDb.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put({ id: id, blob: blob, type: type, timestamp: new Date().toLocaleString() });
    loadMediaVault();
}

async function loadMediaVault() {
    const vaultContainer = document.getElementById('vault-list');
    if (!vaultContainer || !localDb) return;
    vaultContainer.innerHTML = '';
    const transaction = localDb.transaction([STORE_NAME], 'readonly');
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
    if (!localDb) {
        logEvent('Database not initialized. Cannot play video.', 't-warn');
        return;
    }

    const transaction = localDb.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = (event) => {
        const video = event.target.result;
        if (!video) {
            logEvent('Video not found in vault.', 't-warn');
            return;
        }

        const player = document.getElementById('vault-player');
        const modal = document.getElementById('vault-modal');

        if (!player || !modal) {
            logEvent('Video player elements not found.', 't-crit');
            return;
        }

        // Clean up previous video URL to prevent memory leaks
        if (player.src && player.src.startsWith('blob:')) {
            window.URL.revokeObjectURL(player.src);
        }

        // Reset player to ensure fresh load
        player.pause();
        player.src = '';
        player.load();

        // Create new object URL for the video blob
        const videoUrl = window.URL.createObjectURL(video.blob);
        player.src = videoUrl;
        modal.classList.remove('hidden');

        // Handle video loading
        player.oncanplay = () => {
            player.play().catch(e => {
                console.error("Playback failed:", e);
                logEvent("Playback Error: " + e.message, "t-crit");
            });
        };

        player.onerror = (e) => {
            logEvent("Playback Error: File format mismatch or corrupted video.", "t-crit");
            console.error("Video Error:", player.error);
            window.URL.revokeObjectURL(videoUrl);
        };

        // Clean up URL when video ends or modal closes
        player.onended = () => {
            window.URL.revokeObjectURL(videoUrl);
        };
    };

    request.onerror = (event) => {
        logEvent('Failed to retrieve video from database.', 't-crit');
        console.error('Database error:', event);
    };
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

function deleteVideo(id) {
    if (confirm('Delete?')) {
        const transaction = localDb.transaction([STORE_NAME], 'readwrite');
        localDb.transaction([STORE_NAME], 'readwrite').objectStore(STORE_NAME).delete(id).onsuccess = loadMediaVault;
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
