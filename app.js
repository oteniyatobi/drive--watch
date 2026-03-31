// ==========================================
// DRIVERWATCH ENTERPRISE - LOGIC KERNEL
// ==========================================

const MODEL_URL = "./model/";

let model, webcam, maxPredictions;
let isModelLoaded = false;
let modelLoadPromise = null; // Singleton promise to prevent race conditions
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
/** Linear acceleration (m/s²) — phones often expose this for real shocks; magnitude of gravity vector stays ~9.8 so old “total G” test failed. */
const LINEAR_IMPACT_MS2 = 11;
/** Sudden change in accelerationIncludingGravity between samples (m/s² delta) — fallback when linear accel is null */
const JERK_IMPACT_MS2 = 18;
let lastGravitySample = null;
/** iOS 13+: set from Start click (same gesture as permission); null = non‑iOS or no API */
let motionPermissionGranted = null;

/** @type {'drowsy' | 'impact'} */
let currentDispatchReason = 'drowsy';

let lastSpeedingWhatsAppAt = 0;
const SPEEDING_WHATSAPP_COOLDOWN_MS = 8 * 60 * 1000;
let lastSpeedingVoiceAt = 0;
const SPEEDING_VOICE_COOLDOWN_MS = 90 * 1000; // 90s between repeated TTS speeding warnings
/** @type {{ lat: number, lng: number, t: number } | null} */
let lastSpeedSample = null;

function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseMaxSpeedKmh(str) {
    if (str == null || str === '') return NaN;
    const s = String(str).trim().toLowerCase();
    const match = s.match(/([\d.]+)/);
    if (!match) return NaN;
    const num = parseFloat(match[1]);
    if (Number.isNaN(num)) return NaN;
    if (s.includes('mph')) return Math.round(num * 1.60934);
    return Math.round(num);
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Avoids throw when /api returns HTML error pages or empty body */
async function readJsonResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return { error: 'Invalid or non-JSON response from server' };
    }
}

/** Human-readable id for support / insurance — stored in Firestore with each recording */
function makeReferenceId(id) {
    const clean = String(id).replace(/[^a-zA-Z0-9]/g, '');
    const tail = clean.slice(-10) || clean || 'UNK';
    return `DW-${tail}`;
}

// IndexedDB Constants
const DB_NAME = 'DriverWatchDB';
const DB_VERSION = 1;
const STORE_NAME = 'videos';
let localDb = null;

/** Real-time Firestore listener for cloud recordings */
let vaultFirestoreUnsub = null;
/** Merged local + cloud rows for search / display */
let vaultEntriesCache = [];

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
let dispatchSpeechPulseInterval = null; // synth.resume() while dispatch overlay is open
let dispatcherVoiceRetryCount = 0;
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
/** Rolling average length — higher = steadier bar readouts, fewer single-frame spikes */
const SMOOTHING_WINDOW = 14;
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

/**
 * Map TM labels (AWAKE / SLEEPY / NEUTRAL) to probabilities for fatigue logic.
 * Odd camera angles often inflate NEUTRAL — we require SLEEPY to win both others by a margin.
 */
function getClassProbabilities(prediction) {
    let awake = 0;
    let sleepy = 0;
    let neutral = 0;
    for (let i = 0; i < prediction.length; i++) {
        const raw = prediction[i].className.toLowerCase();
        const v = prediction[i].probability;
        if (raw.includes('awake')) awake = v;
        else if (raw.includes('sleepy') || raw.includes('asleep')) sleepy = v;
        else if (raw.includes('neutral')) neutral = v;
    }
    return { awake, sleepy, neutral };
}

// --- Fatigue inference gates (no model retrain required; tune here) ---
const SLEEPY_PROB_MIN = 0.69;
const SLEEPY_MARGIN_MIN = 0.11;
/** Consecutive “raw fatigue” frames before escalation timers start (~200ms @ 60fps) */
const FATIGUE_ENTRY_FRAMES = 12;
/** Consecutive non-fatigue frames before clearing (~80ms @ 60fps) — fast recovery when alert */
const FATIGUE_EXIT_FRAMES = 5;

let fatigueTrueStreak = 0;
let fatigueFalseStreak = 0;
let sustainedFatigueDetection = false;

function resetFatigueStreaks() {
    predictionHistory = [];
    fatigueTrueStreak = 0;
    fatigueFalseStreak = 0;
    sustainedFatigueDetection = false;
}

function isRawFatigueFrame(sleepy, awake, neutral) {
    if (sleepy < SLEEPY_PROB_MIN) return false;
    const maxOther = Math.max(awake, neutral);
    if (sleepy <= maxOther) return false;
    if (sleepy - maxOther < SLEEPY_MARGIN_MIN) return false;
    return true;
}

function updateSustainedFatigue(isRaw) {
    if (isRaw) {
        fatigueFalseStreak = 0;
        if (!sustainedFatigueDetection) {
            fatigueTrueStreak++;
            if (fatigueTrueStreak >= FATIGUE_ENTRY_FRAMES) {
                sustainedFatigueDetection = true;
            }
        }
    } else {
        fatigueTrueStreak = 0;
        if (sustainedFatigueDetection) {
            fatigueFalseStreak++;
            if (fatigueFalseStreak >= FATIGUE_EXIT_FRAMES) {
                sustainedFatigueDetection = false;
            }
        } else {
            fatigueFalseStreak = 0;
        }
    }
    return sustainedFatigueDetection;
}

// ==========================================
// SYSTEM THRESHOLDS 
// ==========================================
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

function detachVaultFirestoreListener() {
    if (vaultFirestoreUnsub) {
        vaultFirestoreUnsub();
        vaultFirestoreUnsub = null;
    }
}

function attachVaultFirestoreListener() {
    detachVaultFirestoreListener();
    const user = auth.currentUser;
    if (!user) return;
    const col = db.collection('users').doc(user.uid).collection('recordings');
    vaultFirestoreUnsub = col.orderBy('timestamp', 'desc').limit(300).onSnapshot(
        (snap) => {
            void loadMediaVault(snap);
        },
        (err) => {
            console.warn('Vault listener (ordered query failed):', err);
            detachVaultFirestoreListener();
            vaultFirestoreUnsub = col.limit(500).onSnapshot((snap) => {
                void loadMediaVault(snap);
            });
        }
    );
}

// Load User Data via Firebase Auth State
auth.onAuthStateChanged(async (user) => {
    if (!user) {
        detachVaultFirestoreListener();
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
                const ec = currentUserData.emergencyContact;
                if (dispName && ec?.name) dispName.innerText = ec.name.toUpperCase();
                if (dispPhone) dispPhone.innerText = ec?.phone || '---';
                attachVaultFirestoreListener();

                // Trigger model pre-load for faster startup
                preWarmModel();
            } else {
                console.warn("User authenticated but profile document missing. Opening setup...");
                window.location.replace('login.html?setup=1');
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
function onStartClick() {
    // iOS Safari: motion permission must be requested during a user gesture — not after async init()
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission()
            .then((state) => {
                motionPermissionGranted = state === 'granted';
            })
            .catch(() => {
                motionPermissionGranted = false;
            })
            .finally(() => init());
    } else {
        motionPermissionGranted = null;
        init();
    }
}

startBtn.addEventListener('click', onStartClick);
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
if (clearLogBtn) clearLogBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    activityLog.innerHTML = '<div class="terminal-line">[SYS] Buffer cleared by operator.</div>';
});

const vaultSearch = document.getElementById('vault-search');
if (vaultSearch) {
    vaultSearch.addEventListener('input', () => renderVaultTable(vaultSearch.value));
}

// ==========================================
// BACKGROUND PRE-LOADING
// ==========================================
async function preWarmModel() {
    if (modelLoadPromise) return modelLoadPromise;

    modelLoadPromise = (async () => {
        try {
            if (isModelLoaded) return;
            logEvent('AI: Downloading neural weights...', 't-info');
            model = await tmImage.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
            isModelLoaded = true;
            maxPredictions = model.getTotalClasses();
            logEvent('AI Core pre-loaded and ready.', 't-info');
        } catch (e) {
            console.warn('Model pre-load failed:', e);
            modelLoadPromise = null; // Allow retry
            throw e;
        }
    })();

    return modelLoadPromise;
}

// ==========================================
// INITIALIZATION SEQUENCE
// ==========================================
async function init() {
    startBtn.disabled = true;

    // Unlock Audio Contexts
    initAudioContext();
    stopHDWarningBeep();
    stopHDAudioAlarm();
    ringingSound.play().then(() => ringingSound.pause()).catch(e => { });

    if (synth) {
        synth.cancel();
        try {
            // Prime the engine with a near-silent utterance so TTS is allowed later (browser gesture requirement)
            const prime = new SpeechSynthesisUtterance(' ');
            prime.volume = 0.001; // Inaudible — just unlocks the audio context
            prime.rate = 1.2;
            synth.speak(prime);
            logEvent('Voice engine unlocked and ready.', 't-info');
        } catch (e) { }
    }

    if (startupMessage) startupMessage.innerHTML = '<div class="standby-text">Waking up camera hardware...</div>';

    try {
        logEvent('Initializing hardware subsystems...', 't-info');

        // Pre-flight checks
        if (typeof tmImage === 'undefined') {
            throw Object.assign(new Error('AI library failed to load. Check your internet connection and reload.'), { name: 'ScriptLoadError' });
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            const proto = location.protocol;
            if (proto === 'file:') {
                throw Object.assign(new Error('Open this app via a local server (e.g. Live Server) or HTTPS — file:// blocks camera access.'), { name: 'ProtocolError' });
            }
            throw Object.assign(new Error('Camera API unavailable. Use Chrome/Edge over HTTPS.'), { name: 'UnsupportedError' });
        }

        // 1. Initialize Webcam (Async - Start this first!)
        if (!webcam) {
            // width, height, flip
            webcam = new tmImage.Webcam(400, 300, true);
        }

        // 2. Setup camera (requests permission)
        await webcam.setup({ facingMode: 'user' });

        // Force mobile video behavior (crucial for iOS/Android Chrome)
        if (webcam.webcam) {
            webcam.webcam.setAttribute('playsinline', true);
            webcam.webcam.setAttribute('muted', true);
            webcam.webcam.muted = true;
        }

        // Play and show canvas immediately while still in the user-gesture window
        // (iOS/Android expire the gesture context after ~1s — model loading takes longer)
        await webcam.play();
        const wrapper = document.getElementById("webcam-wrapper");
        if (wrapper && !wrapper.contains(webcam.canvas)) {
            wrapper.appendChild(webcam.canvas);
        }
        window.requestAnimationFrame(loop);

        // Load model and init DB in parallel (camera is already live)
        if (!isModelLoaded) {
            if (startupMessage) {
                startupMessage.innerHTML = '<div class="standby-text">Loading AI brain...</div>';
                startupMessage.style.display = 'flex';
            }

            // Create a 20s timeout promise
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('AI model took too long to load (Timeout).')), 20000)
            );

            try {
                await Promise.race([
                    Promise.all([
                        initDB().catch(e => { console.warn(e); return null; }),
                        preWarmModel() // This returns the existing promise if already loading
                    ]),
                    timeoutPromise
                ]);
            } catch (e) {
                throw e; 
            }
        }

        // Final verification with a tiny grace period for state sync
        if (!isModelLoaded) {
            await new Promise(r => setTimeout(r, 600)); // Final wait
        }

        if (!isModelLoaded) {
            throw new Error('AI model not ready. Check your connection.');
        }

        if (startupMessage) startupMessage.style.display = 'none';

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

        resetFatigueStreaks();
        isRunning = true;
        sessionStartTime = Date.now();
        totalAlerts = 0;
        totalDrowsySeconds = 0;
        fpsMetrics = { frames: 0, lastTime: Date.now() };

        sessionInterval = setInterval(updateSessionStats, 1000);

        stopBtn.disabled = false;
        navSystemTag.innerHTML = `SYS: <span class="status-indicator ACTIVE">ACTIVE</span>`;
        cameraBadge.innerText = 'ONLINE';
        cameraBadge.className = 'cam-badge ONLINE';
        liveIndicator.classList.add('active');

        setStatus('awake', 'DRIVER ALERT', 'Dashcam feed nominal. System actively monitoring.');
        logEvent('Monitoring active. Driver safety protocols engaged.', 't-succ');

        startRecording();
        loadMediaVault();
        keepVoiceEngineWarm();
        startLocationTracking();
        startImpactDetection();

    } catch (error) {
        isModelLoaded = false;
        isRunning = false;
        // Reset webcam so a retry creates a fresh instance
        if (webcam) {
            try { webcam.stop(); } catch (e) { /* ignore */ }
            webcam = null;
        }
        console.error("Critical Startup Error:", error);

        let hint = '';
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            hint = 'Camera permission was denied. Click the camera icon in your browser address bar and allow access, then reload.';
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
            hint = 'No camera detected. Make sure a camera is connected and not in use by another app.';
        } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
            hint = 'Camera is in use by another app. Close other apps using the camera and reload.';
        } else if (error.name === 'ScriptLoadError' || error.name === 'ProtocolError' || error.name === 'UnsupportedError') {
            hint = error.message;
        } else if (error.name === 'Error' && error.message.includes('model')) {
            hint = 'AI model failed to load. Check your internet connection and reload.';
        }

        if (startupMessage) {
            startupMessage.style.display = 'flex';
            startupMessage.innerHTML = `
                <div class="standby-text" style="color:var(--danger); font-weight:bold;">CAMERA ERROR</div>
                <div style="font-size:0.6rem; color:var(--text-muted); margin-top:8px; text-transform:uppercase;">${error.name || 'Error'}: ${error.message || 'Access Denied'}</div>
                ${hint ? `<div style="font-size:0.55rem; color:var(--text-muted); margin-top:6px; text-transform:none; line-height:1.4;">${hint}</div>` : ''}
                <button onclick="location.reload()" class="btn-sm" style="margin-top:12px; border-color:var(--danger); color:var(--danger);">RETRY SYSTEM</button>
            `;
        }
        logEvent(`FATAL: ${error.name || 'Camera error'} — ${error.message || 'Check permissions'}`, 't-crit');
        startBtn.disabled = false;
    }
}

async function loop() {
    if (!isRunning || isEmergencyActive) return;
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
        if (isModelLoaded) {
            await predict();
        }
    } catch (e) {
        console.error("Loop Error:", e);
        logEvent(`SYS_EXCEPTION: ${e.message}`, 't-crit');
    }
    window.requestAnimationFrame(loop);
}

async function predict() {
    const rawPrediction = await model.predict(webcam.canvas);
    const prediction = getSmoothedPredictions(rawPrediction);
    const { awake, sleepy, neutral } = getClassProbabilities(prediction);
    const rawFatigue = isRawFatigueFrame(sleepy, awake, neutral);
    const isAsleep = updateSustainedFatigue(rawFatigue);

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
    if (isEmergencyActive && stateCode !== 'sleepy') return;

    if (cameraContainer) cameraContainer.className = `camera-hero ${stateCode}`;
    if (headerStatusDot) headerStatusDot.className = `status-dot ${stateCode}`;
    if (mainStatusCard) mainStatusCard.className = `status-card ${stateCode}`;
    if (bigStatusLabel) {
        bigStatusLabel.innerText = title;
        bigStatusLabel.className = `status-title ${stateCode}`;
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

function triggerEmergency(isImpact = false) {
    if (isEmergencyActive) return;
    isEmergencyActive = true;
    currentDispatchReason = isImpact ? 'impact' : 'drowsy';

    if (alarmOverlay) alarmOverlay.classList.add('hidden');
    if (emergencyOverlay) emergencyOverlay.classList.remove('hidden');

    const topic = document.getElementById('emergency-topic');
    if (isImpact) {
        if (topic) topic.innerText = 'IMPACT DISPATCH PROTOCOL';
        setStatus('impact', 'IMPACT DETECTED', 'Critical high-G event. Fleet response in progress.');
    } else {
        if (topic) topic.innerText = 'DISPATCH PROTOCOL INITIATED';
        setStatus('sleepy', 'DISPATCH CALLED', 'Fleet emergency protocols in progress.');
    }

    logEvent(isImpact ? 'CRITICAL: High-G event detected. Auto-dispatch active.' : 'ESCALATION: Real emergency dispatch initiated.', 't-crit');
    stopHDAudioAlarm();

    // If impact, upload anonymized location to community hotspots
    if (isImpact && currentGeoPosition) {
        if (typeof uploadCommunityImpact === 'function') {
            uploadCommunityImpact(currentGeoPosition.lat, currentGeoPosition.lng);
        }
    }

    // Start the call timer ticking
    let callSeconds = 0;
    if (callTimer) callTimer.innerText = '00:00';
    if (simulatedCallInterval) clearInterval(simulatedCallInterval);
    simulatedCallInterval = setInterval(() => {
        callSeconds++;
        const mm = String(Math.floor(callSeconds / 60)).padStart(2, '0');
        const ss = String(callSeconds % 60).padStart(2, '0');
        if (callTimer) callTimer.innerText = `${mm}:${ss}`;
    }, 1000);

    // TTS as soon as the dispatch overlay is visible (not after async WhatsApp / GPS scan)
    initAudioContext();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    try {
        if (synth) synth.resume();
        playDispatcherVoice();
    } catch (e) {
        try { playDispatcherVoice(); } catch (e2) { }
    }
    if (dispatchSpeechPulseInterval) clearInterval(dispatchSpeechPulseInterval);
    dispatchSpeechPulseInterval = setInterval(() => {
        if (synth) synth.resume();
        if (!isEmergencyActive) {
            clearInterval(dispatchSpeechPulseInterval);
            dispatchSpeechPulseInterval = null;
        }
    }, 500);

    startRealDispatch(isImpact);
}

async function startRealDispatch(isImpact = false) {
    try {
        const statusMsg = isImpact ? 'CRITICAL IMPACT DETECTED. AUTO-REPORTING TO FLEET COMMAND...' : 'ACQUIRING GPS AND SCANNING FOR SERVICES...';
        if (emergencyStatusText) emergencyStatusText.innerText = statusMsg;
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
                logEvent(`WHATSAPP: Sending ${isImpact ? 'impact' : 'drowsy'} alert to ${contactName}...`, 't-info');
                const payload = {
                    to: contactPhone,
                    driverName: driverName,
                    mapsLink: mapsLink,
                    time: new Date().toLocaleString(),
                    alertType: isImpact ? 'impact' : 'drowsy',
                    isImpact: !!isImpact,
                    speedKmh: currentSpeed,
                    speedLimitKmh: currentSpeedLimit
                };

                const response = await fetch('/api/send-alert', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await readJsonResponse(response);
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

    const withCoords = elements.filter((el) => el.lat != null && el.lon != null);
    if (withCoords.length === 0) {
        return '<div style="color:var(--acc-muted)">No services found within 5km.</div>';
    }

    return withCoords.slice(0, 5).map((el) => {
        const rawName = el.tags.name || el.tags.amenity || 'Unknown Service';
        const rawType = (el.tags.amenity || el.tags.emergency || '').toUpperCase().replace('_', ' ');
        const rawPhone = el.tags.phone || el.tags['contact:phone'] || '';
        const name = escapeHtml(rawName);
        const type = escapeHtml(rawType);
        const phone = escapeHtml(rawPhone);
        const elLat = el.lat.toFixed(5);
        const elLng = el.lon.toFixed(5);
        const link = `https://maps.google.com/?q=${elLat},${elLng}`;
        return `<div style="padding: 0.25rem 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
            <span style="color:var(--stat-warn);">[${type}]</span> ${name}
            ${rawPhone ? `<span style="color:var(--acc-muted)"> | 📞 ${phone}</span>` : ''}
            <a href="${link}" target="_blank" rel="noopener noreferrer" style="color:var(--stat-info); margin-left: 0.5rem;">📍 MAP</a>
        </div>`;
    }).join('');
}


function startLocationTracking() {
    if (!navigator.geolocation) return;

    lastSpeedSample = null;
    geoWatchId = navigator.geolocation.watchPosition(
        async (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            const now = Date.now();
            currentGeoPosition = {
                lat: lat.toFixed(6),
                lng: lng.toFixed(6),
                acc: position.coords.accuracy.toFixed(1)
            };

            const rawSpeed = position.coords.speed;
            if (rawSpeed !== null && rawSpeed !== undefined && rawSpeed >= 0) {
                currentSpeed = Math.round(rawSpeed * 3.6);
            } else if (lastSpeedSample) {
                const dt = (now - lastSpeedSample.t) / 1000;
                if (dt > 0.4 && dt < 90) {
                    const distKm = haversineKm(lastSpeedSample.lat, lastSpeedSample.lng, lat, lng);
                    // Only use haversine speed if movement is > 3m (avoids GPS jitter at standstill)
                    if (distKm > 0.003) {
                        const kmh = (distKm / dt) * 3600;
                        if (kmh >= 0 && kmh < 300) currentSpeed = Math.round(kmh);
                    }
                }
            }
            lastSpeedSample = { lat, lng, t: now };

            // Route Advisor: update map position
            if (typeof onGpsUpdateForMap === 'function') {
                onGpsUpdateForMap(lat, lng);
            }

            if (statSpeed) statSpeed.innerText = `${currentSpeed} km/h`;

            await checkSpeedLimit(currentGeoPosition.lat, currentGeoPosition.lng);

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
            const limitStr = data.elements[0].tags.maxspeed;
            currentSpeedLimit = parseMaxSpeedKmh(limitStr);
            if (!Number.isFinite(currentSpeedLimit)) {
                currentSpeedLimit = null;
            }

            if (statLimit) {
                statLimit.innerText = currentSpeedLimit != null ? `${currentSpeedLimit} km/h` : '---';
                statLimit.classList.remove('unknown');
            }

            evaluateSpeeding();
        } else {
            currentSpeedLimit = null;
            console.log("No speed limit found in OSM for this location.");
            if (statLimit) statLimit.innerText = `---`;
        }
    } catch (e) {
        console.warn("Speed limit lookup failed:", e);
    }
}

async function notifySpeedingContactOnce() {
    const now = Date.now();
    if (now - lastSpeedingWhatsAppAt < SPEEDING_WHATSAPP_COOLDOWN_MS) return;
    const phone = currentUserData?.emergencyContact?.phone;
    if (!phone) {
        logEvent('SPEED ALERT: No emergency contact phone — WhatsApp not sent.', 't-warn');
        return;
    }
    lastSpeedingWhatsAppAt = now;
    const driverName = currentUserData?.driverName || 'The driver';
    const mapsLink = currentGeoPosition
        ? `https://maps.google.com/?q=${currentGeoPosition.lat},${currentGeoPosition.lng}`
        : 'Location unavailable';
    try {
        logEvent('WHATSAPP: Sending speeding advisory to emergency contact...', 't-info');
        const response = await fetch('/api/send-alert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to: phone,
                driverName,
                mapsLink,
                time: new Date().toLocaleString(),
                alertType: 'speeding',
                isImpact: false,
                speedKmh: currentSpeed,
                speedLimitKmh: currentSpeedLimit
            })
        });
        const result = await readJsonResponse(response);
        if (response.ok && result.success) {
            logEvent('WHATSAPP: Speeding advisory sent.', 't-succ');
        } else {
            logEvent(`WHATSAPP: Speeding advisory failed — ${result.error || 'error'}`, 't-warn');
        }
    } catch (err) {
        logEvent(`WHATSAPP: Speeding advisory network error — ${err.message}`, 't-warn');
    }
}

function evaluateSpeeding() {
    if (currentSpeedLimit == null || !Number.isFinite(currentSpeedLimit)) return;

    // Buffer of 5 km/h over limit
    if (currentSpeed > currentSpeedLimit + 5) {
        if (!isSpeedingAlertActive) {
            logEvent(`SPEED WARNING: Exceeding ${currentSpeedLimit} km/h limit!`, 't-warn');
            isSpeedingAlertActive = true;
            startHDSpeedingBeep();
            triggerSpeedingAlarm();
            void notifySpeedingContactOnce().catch(() => {});
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

function triggerSpeedingAlarm() {
    const now = Date.now();
    // 90-second cooldown between TTS speeding warnings to prevent repeated announcements
    if (now - lastSpeedingVoiceAt < SPEEDING_VOICE_COOLDOWN_MS) return;
    lastSpeedingVoiceAt = now;

    try {
        if (!synth) return;
        synth.resume(); // Ensure engine is awake

        const limitLabel = currentSpeedLimit ? `${currentSpeedLimit} kilometres per hour` : 'this area';
        const spd = currentSpeed ? `${currentSpeed} kilometres per hour` : 'an elevated speed';
        const msg = `Speed alert. You are travelling at about ${spd}. The posted limit here is ${limitLabel}. Slow down now. Your emergency contact may be notified if this continues.`;

        const speedingUtterance = new SpeechSynthesisUtterance(msg);
        speedingUtterance.rate = 1.0;

        const selectedVoice = getBestVoice();
        if (selectedVoice) {
            speedingUtterance.voice = selectedVoice;
        }

        synth.speak(speedingUtterance);
    } catch (e) {
        console.error("Speeding Voice Alarm error:", e);
    }
}

function stopLocationTracking() {
    if (geoWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(geoWatchId);
        geoWatchId = null;
    }
}

function startImpactDetection() {
    if (!window.DeviceMotionEvent) {
        logEvent('Impact detection unavailable (Hardware unsupported).', 't-warn');
        return;
    }

    // iOS: permission was requested in onStartClick (user gesture); here we only attach the listener
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
        if (motionPermissionGranted === true) {
            window.addEventListener('devicemotion', handleMotion, true);
            logEvent('G-Force monitoring active (iOS). Impact detection armed.', 't-info');
        } else {
            logEvent('WARN: iOS motion permission denied. Impact detection disabled.', 't-warn');
        }
    } else {
        window.addEventListener('devicemotion', handleMotion, true);
        logEvent('G-Force monitoring active. Impact detection armed.', 't-info');
    }
}

function stopImpactDetection() {
    window.removeEventListener('devicemotion', handleMotion, true);
}

function handleMotion(event) {
    if (!isRunning || isEmergencyActive) return;

    const linear = event.acceleration;
    let suddenShock = false;

    if (linear && linear.x != null && linear.y != null && linear.z != null) {
        const mag = Math.sqrt(linear.x * linear.x + linear.y * linear.y + linear.z * linear.z);
        if (mag >= LINEAR_IMPACT_MS2) suddenShock = true;
    }

    const g = event.accelerationIncludingGravity;
    if (!suddenShock && g && g.x != null && lastGravitySample) {
        const dx = g.x - lastGravitySample.x;
        const dy = g.y - lastGravitySample.y;
        const dz = g.z - lastGravitySample.z;
        const delta = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (delta >= JERK_IMPACT_MS2) suddenShock = true;
    }
    if (g && g.x != null) {
        lastGravitySample = { x: g.x, y: g.y, z: g.z };
    }

    if (!suddenShock) return;

    const now = Date.now();
    if (now - lastImpactTime < 5000) return;
    lastImpactTime = now;

    logEvent('CRITICAL: Sharp motion / possible collision detected (accelerometer).', 't-crit');
    triggerEmergency(true);
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

        const driverContext = currentUserData?.driverName || 'The driver';
        const contactContext = currentUserData?.emergencyContact?.name || 'the emergency contact';
        const locationContext = currentGeoPosition
            ? `Last known GPS latitude ${currentGeoPosition.lat}, longitude ${currentGeoPosition.lng}`
            : 'Location is still being acquired';
        const timeContext = new Date().toLocaleString();

        let msg;
        if (currentDispatchReason === 'impact') {
            msg = `Driver Watch collision alert. Possible crash or severe impact involving ${driverContext}. ${locationContext} at ${timeContext}. A WhatsApp alert with a map link is being sent to ${contactContext}. If you can hear this, check on the driver and contact emergency services.`;
        } else {
            msg = `Driver Watch medical style alert. ${driverContext} appears unresponsive or severely drowsy behind the wheel. ${locationContext} at ${timeContext}. A message is being sent to ${contactContext} with location details. Pull over safely if this is you.`;
        }

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
    if (dispatchSpeechPulseInterval) {
        clearInterval(dispatchSpeechPulseInterval);
        dispatchSpeechPulseInterval = null;
    }
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
    const referenceId = makeReferenceId(id);
    // 1. Save Locally (IndexedDB)
    if (localDb) {
        const transaction = localDb.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        store.put({
            id: id,
            blob: blob,
            type: type,
            timestamp: new Date().toLocaleString(),
            referenceId: referenceId
        });
    }

    // 2. Save to Cloud (Supabase Storage + Firestore metadata)
    saveVideoToCloud(id, blob, type, referenceId);

    loadMediaVault();
}

async function saveVideoToCloud(id, blob, type, referenceId) {
    const user = auth.currentUser;
    if (!user) {
        logEvent('CLOUD: Auth user missing — upload skipped.', 't-warn');
        return;
    }

    const refId = referenceId || makeReferenceId(id);
    if (!blob || typeof blob.size !== 'number' || blob.size <= 0) {
        logEvent('CLOUD: Empty video blob — upload skipped.', 't-warn');
        return;
    }
    try {
        logEvent(`CLOUD: Uploading ${type} to secure vault (Supabase)...`, 't-info');
        const idToken = await user.getIdToken();
        const presignRes = await fetch('/api/recording-presign', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${idToken}`
            },
            body: JSON.stringify({ id, contentType: blob.type || 'video/webm' })
        });
        const presign = await readJsonResponse(presignRes);
        if (!presignRes.ok) {
            throw new Error(presign.error || 'Could not get upload URL — check Vercel env (Supabase + Firebase Admin).');
        }

        const putRes = await fetch(presign.signedUrl, {
            method: 'PUT',
            body: blob,
            headers: {
                'Content-Type': blob.type || 'video/webm'
            }
        });
        if (!putRes.ok) {
            const t = await putRes.text().catch(() => '');
            throw new Error(`Upload failed (${putRes.status}) ${t.slice(0, 160)}`);
        }

        const storagePath = presign.path;
        const driverName = currentUserData?.driverName || user.displayName || 'Driver';

        await db.collection('users').doc(user.uid).collection('recordings').doc(id).set({
            id: id,
            referenceId: refId,
            userId: user.uid,
            driverName: driverName,
            url: '',
            storagePath: storagePath,
            storageBackend: 'supabase',
            type: type,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            readableTime: new Date().toLocaleString()
        });

        logEvent(`CLOUD: ✅ ${type} saved to your vault (ref ${refId}).`, 't-succ');
        loadMediaVault();
    } catch (e) {
        console.error('Cloud Upload Failed:', e);
        const msg = e && e.message ? e.message : (e ? String(e) : 'Unknown error');
        logEvent(`CLOUD: ⚠️ Sync failed — ${msg}`, 't-warn');
    }
}

function vaultSortMillis(v) {
    if (v._sortKey != null) return v._sortKey;
    const t = v.timestamp;
    if (t && typeof t.toMillis === 'function') return t.toMillis();
    if (t && typeof t.seconds === 'number') return t.seconds * 1000 + ((t.nanoseconds || 0) / 1e6);
    const n = new Date(v.readableTime || v.timestamp || 0).getTime();
    return Number.isNaN(n) ? 0 : n;
}

function getVaultSearchQuery() {
    const el = document.getElementById('vault-search');
    return el ? el.value.trim() : '';
}

function renderVaultTable(filterText) {
    const vaultContainer = document.getElementById('vault-list');
    if (!vaultContainer) return;
    const q = (filterText || '').toLowerCase();
    const rows = q
        ? vaultEntriesCache.filter((v) => {
            const ref = (v.referenceId || '').toLowerCase();
            const idStr = (v.id || '').toLowerCase();
            const typ = (v.type || '').toLowerCase();
            const tim = String(v.timestamp || '').toLowerCase();
            const driver = (v.driverName || '').toLowerCase();
            return ref.includes(q) || idStr.includes(q) || typ.includes(q) || tim.includes(q) || driver.includes(q);
        })
        : vaultEntriesCache;

    const sorted = [...rows].sort((a, b) => vaultSortMillis(b) - vaultSortMillis(a));

    if (sorted.length === 0) {
        vaultContainer.innerHTML = vaultEntriesCache.length === 0
            ? '<div class="empty-data">NO RECORDS FOUND</div>'
            : '<div class="empty-data">NO MATCHES — TRY ANOTHER SEARCH</div>';
        return;
    }

    vaultContainer.innerHTML = '';
    sorted.forEach((video) => {
        const item = document.createElement('div');
        item.className = 'vault-item';
        const sourceIcon = video.isLocal ? '💾' : '☁️';
        const typeLabel = escapeHtml(video.type);
        const timeLabel = escapeHtml(String(video.timestamp));
        const refId = escapeHtml(video.referenceId || makeReferenceId(video.id));
        item.innerHTML = `
            <div class="vault-info">
                <span class="vault-type">${sourceIcon} ${typeLabel}</span>
                <span class="vault-time">${timeLabel}</span>
                <span class="vault-ref">REF ${refId}</span>
            </div>
            <div class="vault-actions">
                <button type="button" class="btn-play" onclick="void playVideo(${JSON.stringify(video.id)}, ${video.isLocal}, ${JSON.stringify(video.url || '')})">PLAY</button>
                <button type="button" class="btn-copy-ref" title="Copy reference for your records" onclick="copyVaultReference(${JSON.stringify(video.id)}, ${JSON.stringify(video.referenceId || makeReferenceId(video.id))}, ${JSON.stringify(video.type)}, ${JSON.stringify(String(video.timestamp))})">REF</button>
                <button type="button" class="btn-del" onclick="deleteVideo(${JSON.stringify(video.id)}, ${video.isLocal})">DEL</button>
            </div>
        `;
        vaultContainer.appendChild(item);
    });
}

function copyVaultReference(videoId, referenceId, typeLabel, timeLabel) {
    const ref = referenceId || videoId;
    const text =
        `DriverWatch — video reference\n` +
        `Ref: ${ref}\n` +
        `Recording ID: ${videoId}\n` +
        `Type: ${typeLabel}\n` +
        `Time: ${timeLabel}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            logEvent('Reference copied — use for insurance or fleet records.', 't-succ');
        }).catch(() => {
            logEvent('Could not copy — select and copy manually.', 't-warn');
        });
    } else {
        logEvent('Clipboard unavailable in this browser.', 't-warn');
    }
}

async function loadMediaVault(optionalSnapshot) {
    const vaultContainer = document.getElementById('vault-list');
    if (!vaultContainer) return;
    vaultContainer.innerHTML = '<div class="empty-data">Syncing with fleet vault...</div>';

    const user = auth.currentUser;
    let allVideos = [];

    if (localDb) {
        const localVideos = await new Promise((resolve) => {
            const transaction = localDb.transaction([STORE_NAME], 'readonly');
            transaction.objectStore(STORE_NAME).getAll().onsuccess = (e) => resolve(e.target.result);
        });
        allVideos = localVideos.map((v) => ({
            ...v,
            isLocal: true,
            referenceId: v.referenceId || makeReferenceId(v.id),
            _sortKey: new Date(v.timestamp).getTime() || 0
        }));
    }

    if (user) {
        const col = db.collection('users').doc(user.uid).collection('recordings');
        let snapshot = optionalSnapshot || null;
        if (!snapshot) {
            try {
                snapshot = await col.orderBy('timestamp', 'desc').limit(300).get();
            } catch (e1) {
                console.warn('Vault ordered query failed, trying broad fetch:', e1);
                try {
                    snapshot = await col.limit(500).get();
                    logEvent('VAULT: Loaded recordings (fallback query). If some are missing, check Firestore index.', 't-warn');
                } catch (e2) {
                    console.warn('Could not fetch cloud vault:', e2);
                    logEvent('VAULT: Could not load cloud recordings. Check login and network.', 't-warn');
                    snapshot = null;
                }
            }
        }

        if (snapshot) {
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                if (allVideos.find((v) => v.id === data.id)) return;
                const refId = data.referenceId || makeReferenceId(data.id);
                const sk = (data.timestamp?.toMillis?.() ?? (data.timestamp?.seconds ? data.timestamp.seconds * 1000 : null) ?? new Date(data.readableTime || 0).getTime()) || 0;
                const label = data.readableTime || (data.timestamp && data.timestamp.toDate ? data.timestamp.toDate().toLocaleString() : null) || '—';
                allVideos.push({ ...data, referenceId: refId, isLocal: false, timestamp: label, _sortKey: sk });
            });
        }
    }

    vaultEntriesCache = allVideos;
    renderVaultTable(getVaultSearchQuery());
}

async function playVideo(id, isLocal, cloudUrl) {
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
        return;
    }

    let url = cloudUrl;
    if (!url && auth.currentUser) {
        try {
            const doc = await db.collection('users').doc(auth.currentUser.uid).collection('recordings').doc(id).get();
            if (doc.exists) {
                const d = doc.data();
                if (d.storageBackend === 'supabase' && d.storagePath) {
                    const idToken = await auth.currentUser.getIdToken();
                    const r = await fetch('/api/recording-play-url', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${idToken}`
                        },
                        body: JSON.stringify({ path: d.storagePath })
                    });
                    const j = await readJsonResponse(r);
                    if (r.ok && j.signedUrl) {
                        url = j.signedUrl;
                    }
                } else if (d.url) {
                    url = d.url;
                }
            }
        } catch (e) {
            console.warn('Vault: could not load download URL', e);
        }
    }
    if (url) {
        startPlayback(url);
    } else {
        logEvent('VAULT: Playback URL unavailable. Try REFRESH or check your connection.', 't-warn');
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

    const user = auth.currentUser;

    const finish = () => loadMediaVault();

    const deleteCloud = async () => {
        if (!user) return;
        try {
            const docRef = db.collection('users').doc(user.uid).collection('recordings').doc(id);
            const snap = await docRef.get();
            const data = snap.exists ? snap.data() : null;
            await docRef.delete();

            if (data && data.storageBackend === 'supabase' && data.storagePath) {
                const idToken = await user.getIdToken();
                await fetch('/api/recording-delete-storage', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${idToken}`
                    },
                    body: JSON.stringify({ path: data.storagePath })
                }).catch(() => {});
            } else {
                await storage.ref().child(`users/${user.uid}/videos/${id}.webm`).delete().catch(() => {});
            }
            logEvent('CLOUD: Record removed from fleet vault.', 't-info');
        } catch (e) {
            console.warn('Cloud vault delete:', e);
        }
    };

    const afterLocalRemoved = () => {
        if (user) {
            void deleteCloud().finally(finish);
        } else {
            finish();
        }
    };

    if (isLocal && localDb) {
        const tx = localDb.transaction([STORE_NAME], 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = afterLocalRemoved;
        tx.onerror = () => finish();
    } else if (user) {
        void deleteCloud().finally(finish);
    } else {
        finish();
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
    isModelLoaded = false;
    resetFatigueStreaks();
    stopRecording();
    stopLocationTracking();
    stopImpactDetection();
    lastSpeedSample = null;
    lastGravitySample = null;
    clearInterval(sessionInterval);
    if (webcam) webcam.stop();
    if (keepWarmInterval) clearInterval(keepWarmInterval);
    if (liveIndicator) liveIndicator.classList.remove('active');
    if (cameraBadge) {
        cameraBadge.innerText = 'INACTIVE';
        cameraBadge.className = 'cam-badge';
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    navSystemTag.innerHTML = `SYS: <span class="status-indicator">STANDBY</span>`;
}
