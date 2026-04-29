// ==========================================
// DRIVERWATCH ENTERPRISE - LOGIC KERNEL
// ==========================================

const MODEL_URL = "./model/";

let model, webcam, maxPredictions;

// Theme Management
function toggleTheme() {
    const isLight = document.getElementById('theme-toggle').checked;
    const theme = isLight ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('dw-theme', theme);
    
    // Update map if it exists
    if (typeof updateMapTheme === 'function') {
        updateMapTheme(theme);
    }
    
    logEvent(`SYS: Theme switched to ${theme.toUpperCase()} mode.`, 't-info');
}

function syncThemeUI() {
    const theme = localStorage.getItem('dw-theme') || 'dark';
    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.checked = (theme === 'light');
    document.documentElement.setAttribute('data-theme', theme);
}

// Hook into Profile render
function renderProfile() {
    const user = auth.currentUser;
    if (!user || !currentUserData) return;

    const profName = document.getElementById('prof-name');
    const profEmail = document.getElementById('prof-email');
    const profSex = document.getElementById('prof-sex');
    const profPhone = document.getElementById('prof-phone');
    const profEC = document.getElementById('prof-ec');

    if (profName) profName.innerText = currentUserData.driverName || '---';
    if (profEmail) profEmail.innerText = user.email || '---';
    if (profSex) profSex.innerText = currentUserData.gender || '---';
    if (profPhone) profPhone.innerText = currentUserData.phoneNumber || '---';
    if (profEC) profEC.innerText = currentUserData.emergencyContact?.name 
        ? `${currentUserData.emergencyContact.name} (${currentUserData.emergencyContact.phone})`
        : '---';

    const initials = (currentUserData.driverName || '?').split(' ').map(n => n[0]).join('').toUpperCase();
    const avatar = document.getElementById('profile-avatar-initials');
    const dispName = document.getElementById('profile-display-name');
    if (avatar) avatar.innerText = initials.substring(0, 2);
    if (dispName) dispName.innerText = (currentUserData.driverName || '').toUpperCase();
    
    syncThemeUI(); // Ensure toggle matches saved state
}

let isModelLoaded = false;
let modelLoadPromise = null; // Singleton promise to prevent race conditions
let isRunning = false;
let lastPredictionTime = 0;
const PREDICTION_INTERVAL_MS = 150; // Slower default to save CPU
/** Detect native Capacitor / Android environment for performance tuning */
const _isMobileApp = typeof window !== 'undefined' && window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform();
const _isMobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const IS_MOBILE = _isMobileApp || _isMobileUA;
/** On mobile, throttle the canvas mirror to ~10fps (100ms) to significantly cut GPU load */
const MIRROR_THROTTLE_MS = IS_MOBILE ? 100 : 0;
/** On mobile, predict every 350ms (3/sec) instead of 150ms (7/sec) */
const MOBILE_PREDICTION_MS = IS_MOBILE ? 350 : PREDICTION_INTERVAL_MS;
/** Webcam resolution — use standard ideal for better hardware compatibility, downscale in canvas */
const CAM_W = 400;
const CAM_H = 300;
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
const LINEAR_IMPACT_MS2 = 30; // raised: ~3g, was 11 (too sensitive)
/** Sudden change in accelerationIncludingGravity between samples (m/s² delta) — fallback when linear accel is null */
const JERK_IMPACT_MS2 = 45; // raised: ~4.5g delta, was 18
const IMPACT_CONFIRM_FRAMES = 2;
let impactStreak = 0;
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

/**
 * EWMA smoothing factor (0–1).
 * 0.22 = moderately smooth: recent frames count ~4× more than frames 7 steps back,
 * giving fast response to real state changes while killing single-frame noise.
 */
const EWMA_ALPHA = 0.22;
let ewmaState = null;      // Per-class EWMA state vector
let predictionHistory = []; // Kept for legacy compat (not used for smoothing anymore)

/**
 * Exponential Weighted Moving Average — replaces the old flat rolling average.
 * New value = α × current + (1−α) × previous.
 * Outperforms simple average because it reacts faster to genuine state shifts
 * while still suppressing single-frame jitter from lighting and head micro-movement.
 */
function getSmoothedPredictions(rawPrediction) {
    if (ewmaState === null) {
        // Bootstrap: use first frame as initial state
        ewmaState = rawPrediction.map(p => ({ className: p.className, probability: p.probability }));
        return ewmaState.map(p => ({ ...p }));
    }

    ewmaState = rawPrediction.map((p, i) => ({
        className: p.className,
        probability: EWMA_ALPHA * p.probability + (1 - EWMA_ALPHA) * ewmaState[i].probability
    }));

    return ewmaState.map(p => ({ ...p }));
}

/**
 * Normalized Shannon entropy of the raw prediction distribution (0 = certain, 1 = max uncertain).
 * High entropy → model is confused (face not visible, camera blocked, or extreme lighting).
 * We skip those frames instead of letting bad guesses pollute the fatigue state.
 */
function getPredictionEntropy(prediction) {
    const total = prediction.reduce((s, p) => s + p.probability, 0);
    if (total === 0) return 1;
    return -prediction.reduce((s, p) => {
        const prob = p.probability / total;
        return s + (prob > 0 ? prob * Math.log2(prob) : 0);
    }, 0) / Math.log2(prediction.length); // Normalized to [0, 1]
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

// --- Fatigue inference gates (tune here; no model retrain required) ---
const SLEEPY_PROB_MIN    = 0.65;   // Minimum SLEEPY confidence (EWMA is already smoothed so slightly lower is fine)
const SLEEPY_MARGIN_MIN  = 0.10;   // SLEEPY must beat the next-best class by at least this margin
const ENTROPY_THRESHOLD  = 0.80;   // Skip frames where model entropy > 80% (face absent / camera blocked)
/** Consecutive raw-fatigue frames before sustained detection starts (~1.0 s @ 10 fps) */
const FATIGUE_ENTRY_FRAMES = 10;
/** Consecutive non-fatigue frames needed to clear — raised to reduce false dismissals */
const FATIGUE_EXIT_FRAMES  = 9;

// ---- Composite fatigue score (0–10) ----
// Accumulates on sleepy frames proportional to model confidence; drains on awake frames.
// Triggers sustained fatigue sooner when confidence is very high; resists clearing when score is elevated.
const FATIGUE_SCORE_THRESHOLD = 6.0;  // Score required to declare sustained fatigue
const FATIGUE_SCORE_DRAIN     = 0.55; // Base drain per non-fatigue frame
const FATIGUE_SCORE_MAX       = 10;   // Hard cap

let fatigueScore = 0;
let fatigueTrueStreak = 0;
let fatigueFalseStreak = 0;
let sustainedFatigueDetection = false;

function resetFatigueStreaks() {
    predictionHistory = [];
    ewmaState = null;
    fatigueScore = 0;
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

/**
 * Updates the composite fatigue score and sustained-fatigue flag.
 *
 * @param {boolean} isRaw  - Whether this frame passes the raw fatigue gate
 * @param {number}  sleepy - Smoothed SLEEPY probability (0–1)
 * @param {number}  awake  - Smoothed AWAKE probability (0–1)
 */
function updateSustainedFatigue(isRaw, sleepy, awake) {
    if (isRaw) {
        // Accumulate score proportional to how confident SLEEPY is
        fatigueScore = Math.min(FATIGUE_SCORE_MAX, fatigueScore + sleepy);
        fatigueFalseStreak = 0;
        if (!sustainedFatigueDetection) {
            fatigueTrueStreak++;
            // Trigger on either sustained streak OR high accumulated score
            if (fatigueTrueStreak >= FATIGUE_ENTRY_FRAMES || fatigueScore >= FATIGUE_SCORE_THRESHOLD) {
                sustainedFatigueDetection = true;
            }
        }
    } else {
        // Drain score — faster when awake confidence is high
        fatigueScore = Math.max(0, fatigueScore - FATIGUE_SCORE_DRAIN - awake * 0.25);
        fatigueTrueStreak = 0;
        if (sustainedFatigueDetection) {
            fatigueFalseStreak++;
            // Require more exit frames when score is still elevated (driver may still be drowsy)
            const requiredExit = fatigueScore > 2.5 ? FATIGUE_EXIT_FRAMES + 4 : FATIGUE_EXIT_FRAMES;
            if (fatigueFalseStreak >= requiredExit && fatigueScore < 0.8) {
                sustainedFatigueDetection = false;
                fatigueFalseStreak = 0;
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
                
                // Start cloud vault listener immediately (don't wait for IndexedDB)
                attachVaultFirestoreListener();
                initDB().catch(e => console.warn('initDB failed on startup:', e));

                // Trigger model pre-load for faster startup
                preWarmModel();

                // ── HIDE SPLASH GUARD ──
                document.body.classList.add('auth-ready');
                if (window.__clearSplashTimer) window.__clearSplashTimer();
            } else {
                console.warn("User authenticated but profile document missing. Opening setup...");
                window.location.replace('login.html?setup=1');
            }
        } catch (e) {
            console.error("Error loading user data from Firestore:", e);
            // Even on error, we should probably allow the user to see the UI or retry
            document.body.classList.add('auth-ready');
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
    const ts = now.toISOString().split('T')[1].substring(0, 11); 

    if (activityLog) {
        const entry = document.createElement('div');
        entry.className = `terminal-line ${type}`;
        entry.innerHTML = `<span class="time">[${ts}]</span> ${message}`;
        activityLog.prepend(entry);
        if (activityLog.children.length > 50) {
            activityLog.removeChild(activityLog.lastChild);
        }
    }
    
    // Always mirror to console for debugging
    if (type.includes('crit')) console.error(`[${ts}] ${message}`);
    else if (type.includes('warn')) console.warn(`[${ts}] ${message}`);
    else console.log(`[${ts}] ${message}`);
}

const clearLogBtn = document.getElementById('clear-log-btn');
if (clearLogBtn && activityLog) clearLogBtn.addEventListener('click', (e) => {
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
            
            // WARM-UP: Compiling WebGL shaders takes 2-5 seconds on laptops and causes "Page Unresponsive".
            // CRITICAL FIX: The dimensions must exactly match the webcam (400x300) otherwise
            // Tensorflow will re-compile all shaders silently during the first frame, freezing the app!
            try {
                const dummy = document.createElement('canvas');
                dummy.width = CAM_W; dummy.height = CAM_H;
                await model.predict(dummy);
            } catch (e) { }

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

        // 1. Initialize Bare-Metal Video Element
        if (!webcam) {
            webcam = document.createElement('video');
            webcam.width = CAM_W;
            webcam.height = CAM_H;
            webcam.autoplay = true;
            webcam.playsInline = true;
            webcam.muted = true;
            
            // Create the canvas that TM model expects to read from
            webcamCanvas = document.createElement('canvas');
            webcamCanvas.width = CAM_W;
            webcamCanvas.height = CAM_H;
            webcamCtx = webcamCanvas.getContext('2d');
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            const proto = location.protocol;
            if (proto === 'file:') {
                throw Object.assign(new Error('Open this app via a local server (e.g. Live Server) or HTTPS — file:// blocks camera access.'), { name: 'ProtocolError' });
            }
            throw Object.assign(new Error('Camera API unavailable. Use Chrome/Edge over HTTPS.'), { name: 'UnsupportedError' });
        }

        // 2. Request Camera Hardware - Tiered Fallback for Mobile Reliability
        let stream;
        try {
            // Tier 1: Optimized for AI accuracy
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
                audio: false
            });
        } catch (e1) {
            console.warn("Camera Tier 1 failed, trying Tier 2 (Basic HD)...", e1);
            try {
                // Tier 2: Generic HD fallback
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                    audio: false
                });
            } catch (e2) {
                console.warn("Camera Tier 2 failed, trying Tier 3 (Generic)...", e2);
                // Tier 3: Absolute fallback
                stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            }
        }
        webcam.srcObject = stream;
        
        // Wait for video stream to start flowing
        await new Promise((resolve) => {
            webcam.onloadedmetadata = () => {
                webcam.play();
                resolve();
            };
        });

        // 3. Inject canvas into UI
        const wrapper = document.getElementById("webcam-wrapper");
        if (wrapper && !wrapper.contains(webcamCanvas)) {
            wrapper.appendChild(webcamCanvas);
        }

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
                    preWarmModel(), // This returns the existing promise if already loading
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
        window.requestAnimationFrame(loop); // <-- CRITICAL: Start the loop only after isRunning is true!
        
        sessionStartTime = Date.now();
        totalAlerts = 0;
        totalDrowsySeconds = 0;
        fpsMetrics = { frames: 0, lastTime: Date.now() };

        sessionInterval = setInterval(updateSessionStats, 1000);
        predictionIntervalHandle = setInterval(predictLoop, MOBILE_PREDICTION_MS);

        stopBtn.disabled = false;
        if (navSystemTag) {
            navSystemTag.className = 'sys-badge ACTIVE';
            navSystemTag.innerText = 'SYS: ACTIVE';
        }
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
        // Kill active streams on failure
        if (webcam && webcam.srcObject) {
            webcam.srcObject.getTracks().forEach(t => t.stop());
            webcam.srcObject = null;
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
    if (!isRunning) return;
    
    if (!isEmergencyActive) {
        try {
            // Native mirror draw loop
            if (webcam.readyState >= 2) { // HAVE_CURRENT_DATA
                // Throttle mirror draw on mobile to save GPU/CPU
                const now_mirror = Date.now();
                if (MIRROR_THROTTLE_MS === 0 || !window._lastMirrorDraw || (now_mirror - window._lastMirrorDraw >= MIRROR_THROTTLE_MS)) {
                    webcamCtx.save();
                    webcamCtx.scale(-1, 1);
                    webcamCtx.drawImage(webcam, -CAM_W, 0, CAM_W, CAM_H);
                    webcamCtx.restore();
                    window._lastMirrorDraw = now_mirror;
                }
            }
            fpsMetrics.frames++;
            
            const now = Date.now();
            
            // UI/FPS update
            if (now - fpsMetrics.lastTime >= 1000) {
                if (footerDataStream) {
                    footerDataStream.innerText = `FPS: ${fpsMetrics.frames} | RES: ${CAM_W}x${CAM_H}`;
                }
                fpsMetrics.frames = 0;
                fpsMetrics.lastTime = now;
            }
        } catch (e) {
            console.error("Loop Error:", e);
            logEvent(`SYS_EXCEPTION: ${e.message}`, 't-crit');
        }
    }
    
    // Continue loop
    if (isRunning) {
        window.requestAnimationFrame(loop);
    }
}

let predictionIntervalHandle = null;

async function predictLoop() {
    if (!isRunning || isEmergencyActive || !isModelLoaded) return;
    if (window._isPredicting) return; // Prevent overlapping inferences

    window._isPredicting = true;
    try {
        await predict();
    } catch (e) {
        console.error("Predict logic error:", e);
    }
    window._isPredicting = false;
}

async function predict() {
    const rawPrediction = await model.predict(webcamCanvas);

    // --- Entropy gate: skip frames where the model is too uncertain ---
    // (face not visible, camera blocked, extreme lighting, head fully turned away)
    const entropy = getPredictionEntropy(rawPrediction);
    const prediction = getSmoothedPredictions(rawPrediction);
    const { awake, sleepy, neutral } = getClassProbabilities(prediction);

    let isAsleep;
    if (entropy > ENTROPY_THRESHOLD) {
        // Model is confused — hold current state rather than flipping to false.
        // This prevents "camera blocked → driver wakes up" false dismissals.
        isAsleep = sustainedFatigueDetection;
    } else {
        const rawFatigue = isRawFatigueFrame(sleepy, awake, neutral);
        isAsleep = updateSustainedFatigue(rawFatigue, sleepy, awake);
    }

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
        const tags = el.tags || {};
        const rawName = tags.name || tags.amenity || 'Unknown Service';
        const rawType = (tags.amenity || tags.emergency || '').toUpperCase().replace('_', ' ');
        const rawPhone = tags.phone || tags['contact:phone'] || '';
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

            if (statSpeed) {
                const oldSpeed = parseInt(statSpeed.innerText) || 0;
                animateValue('stat-speed', oldSpeed, currentSpeed, 400, ' km/h');
            }

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
    let overThreshold = false;

    if (linear && linear.x != null && linear.y != null && linear.z != null) {
        const mag = Math.sqrt(linear.x * linear.x + linear.y * linear.y + linear.z * linear.z);
        if (mag >= LINEAR_IMPACT_MS2) overThreshold = true;
    }

    const g = event.accelerationIncludingGravity;
    if (!overThreshold && g && g.x != null && lastGravitySample) {
        const dx = g.x - lastGravitySample.x;
        const dy = g.y - lastGravitySample.y;
        const dz = g.z - lastGravitySample.z;
        const delta = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (delta >= JERK_IMPACT_MS2) overThreshold = true;
    }
    if (g && g.x != null) {
        lastGravitySample = { x: g.x, y: g.y, z: g.z };
    }

    // Require IMPACT_CONFIRM_FRAMES consecutive over-threshold samples to confirm a real crash.
    // This eliminates single-spike false positives from tapping, slapping or bumping the phone.
    if (overThreshold) {
        impactStreak++;
    } else {
        impactStreak = 0;
        return;
    }

    if (impactStreak < IMPACT_CONFIRM_FRAMES) return;
    impactStreak = 0; // reset so it can fire again after cooldown

    const now = Date.now();
    if (now - lastImpactTime < 8000) return; // 8-second cooldown between events
    lastImpactTime = now;

    logEvent('CRITICAL: Sustained high-G event detected — possible collision.', 't-crit');
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
            // Aggressive recovery (capped to prevent infinite freezes)
            if (e.error !== 'canceled' && dispatcherVoiceRetryCount < 2) {
                dispatcherVoiceRetryCount++;
                setTimeout(() => { if (isRunning && isEmergencyActive) synth.speak(dispatchUtterance); }, 1000);
            } else if (dispatcherVoiceRetryCount >= 2) {
                logEvent('VOICE: Audio hardware unresponsive. Halting TTS retry.', 't-warn');
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
    if (!webcamCanvas) return;
    const stream = webcamCanvas.captureStream(30);
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

    // 2. Save to Cloud (Cloudinary storage + Firestore metadata)
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
        logEvent(`CLOUD: Uploading ${type} to Cloudinary vault...`, 't-info');
        const idToken = await user.getIdToken();

        // Step 1: Get Cloudinary signed upload parameters from our server
        const presignRes = await fetch('/api/recording-presign', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${idToken}`
            },
            body: JSON.stringify({ id })
        });
        const presign = await readJsonResponse(presignRes);
        if (!presignRes.ok) {
            throw new Error(presign.error || 'Could not get Cloudinary upload credentials.');
        }

        // Step 2: Upload video blob directly from browser to Cloudinary
        const formData = new FormData();
        formData.append('file', blob, `${id}.webm`);
        formData.append('public_id', presign.publicId);
        formData.append('folder', presign.folder);
        formData.append('timestamp', String(presign.timestamp));
        formData.append('api_key', presign.apiKey);
        formData.append('signature', presign.signature);

        const putRes = await fetch(presign.uploadUrl, {
            method: 'POST',
            body: formData,
        });
        const uploadResult = await putRes.json();

        if (!putRes.ok || uploadResult.error) {
            throw new Error(`Cloudinary upload failed: ${uploadResult.error?.message || putRes.status}`);
        }

        const cloudUrl  = uploadResult.secure_url;
        const publicId  = uploadResult.public_id;
        const driverName = currentUserData?.driverName || user.displayName || 'Driver';

        // Step 3: Save metadata + permanent URL to Firestore
        await db.collection('users').doc(user.uid).collection('recordings').doc(id).set({
            id: id,
            referenceId: refId,
            userId: user.uid,
            driverName: driverName,
            url: cloudUrl,
            publicId: publicId,
            storagePath: publicId,
            storageBackend: 'cloudinary',
            type: type,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            readableTime: new Date().toLocaleString()
        });

        logEvent(`CLOUD: ✅ ${type} saved to Cloudinary vault (ref ${refId}).`, 't-succ');
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
                <button type="button" class="btn-play" onclick='playVideo(${JSON.stringify(video.id)}, ${video.isLocal}, ${JSON.stringify(video.url || "")})'>PLAY</button>
                <button type="button" class="btn-copy-ref" title="Copy reference for your records" onclick='copyVaultReference(${JSON.stringify(video.id)}, ${JSON.stringify(video.referenceId || makeReferenceId(video.id))}, ${JSON.stringify(video.type)}, ${JSON.stringify(String(video.timestamp))})'>REF</button>
                <button type="button" class="btn-del" onclick='deleteVideo(${JSON.stringify(video.id)}, ${video.isLocal})'>DEL</button>
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
    // Cloudinary URLs are permanent public URLs — use directly.
    // Fallback: fetch from Firestore if the vault cache is missing the URL.
    if (!url && auth.currentUser) {
        try {
            const doc = await db.collection('users').doc(auth.currentUser.uid).collection('recordings').doc(id).get();
            if (doc.exists) {
                const d = doc.data();
                url = d.url || null;
            }
        } catch (e) {
            console.warn('Vault: could not load playback URL', e);
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
    if (!player || !modal) return;

    // Force MP4 transcoding on-the-fly via Cloudinary for mobile compatibility 
    let playUrl = url;
    if (url.includes('cloudinary.com')) {
        if (url.endsWith('.webm')) {
            playUrl = url.replace(/\.webm$/, '.mp4');
        } else if (!url.endsWith('.mp4')) {
            const parts = url.split('/');
            if (!parts[parts.length - 1].includes('.')) {
                playUrl = url + ".mp4";
            }
        }
    }

    // Clean up previous listeners and source
    const newPlayer = player.cloneNode(true);
    player.parentNode.replaceChild(newPlayer, player);
    
    newPlayer.src = playUrl;
    modal.classList.remove('hidden');
    newPlayer.style.opacity = '0';

    newPlayer.oncanplay = () => {
        newPlayer.style.transition = 'opacity 0.5s ease';
        newPlayer.style.opacity = '1';
        newPlayer.play().catch(e => console.warn('Autoplay blocked:', e));
    };

    newPlayer.onerror = () => {
        console.error('Video load error:', newPlayer.error);
        logEvent('VAULT: Could not load video — file may still be processing.', 't-warn');
    };

    newPlayer.load();
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

            if (data && data.storageBackend === 'cloudinary' && data.publicId) {
                // Delete from Cloudinary via our server-side API (keeps API secret off the client)
                const idToken = await user.getIdToken();
                await fetch('/api/recording-delete-storage', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${idToken}`
                    },
                    body: JSON.stringify({ publicId: data.publicId })
                }).catch(() => {});
            }
            logEvent('CLOUD: Record removed from Cloudinary vault.', 't-info');
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
    const oldScore = parseFloat(statScore.innerText) || 100;
    animateValue('stat-score', oldScore, Math.round(alertness * 10) / 10, 500, '%');
}

function stopSystem() {
    isRunning = false;
    
    if (typeof predictionIntervalHandle !== 'undefined' && predictionIntervalHandle) {
        clearInterval(predictionIntervalHandle);
        predictionIntervalHandle = null;
    }
    
    cancelEmergency();

    resetFatigueStreaks();
    stopRecording();
    stopLocationTracking();
    stopImpactDetection();
    lastSpeedSample = null;
    lastGravitySample = null;
    if (typeof sessionInterval !== 'undefined' && sessionInterval) {
        clearInterval(sessionInterval);
    }
    
    if (webcam && webcam.srcObject) {
        webcam.srcObject.getTracks().forEach(track => track.stop());
        webcam.srcObject = null;
    }
    
    if (keepWarmInterval) clearInterval(keepWarmInterval);
    if (liveIndicator) liveIndicator.classList.remove('active');
    if (cameraBadge) {
        cameraBadge.innerText = 'INACTIVE';
        cameraBadge.className = 'cam-badge';
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (navSystemTag) {
        navSystemTag.className = 'sys-badge';
        navSystemTag.innerHTML = `READY`;
    }
    
    setStatus('awake', 'MONITORING OFFLINE', 'Tap start to begin a new session.'); 
    logEvent('Session ended. Monitoring stopped.', 't-info');

    // Remove pulse animation
    document.querySelectorAll('.stat-card').forEach(c => c.classList.remove('active-monitoring'));
}

// ── Tab Switching & Initialization ────────────────────────
function switchTab(name) {
    const panels = document.querySelectorAll('.tab-panel');
    const buttons = document.querySelectorAll('.nav-tab');
    
    panels.forEach(p => p.classList.remove('active'));
    buttons.forEach(b => b.classList.remove('active'));
    
    const panel = document.getElementById('tab-' + name);
    const btn   = document.getElementById('nav-tab-' + name);
    
    if (panel) panel.classList.add('active');
    if (btn) btn.classList.add('active');
    
    if (name === 'map' && typeof onMapTabOpened === 'function') {
        setTimeout(onMapTabOpened, 300); // Increased delay for safer container rendering
    }
    
    if (name === 'profile') {
        renderProfile();
    }
}

// ── Profile Management ────────────────────────────────────
let isProfileEditing = false;
function renderProfile() {
    if (!currentUserData) return;
    
    const fields = {
        'prof-name': currentUserData.driverName || '---',
        'prof-email': currentUserData.email || '---',
        'prof-sex': currentUserData.sex || '---',
        'prof-phone': currentUserData.phone || '---',
        'prof-ec': currentUserData.emergencyContact?.name ? `${currentUserData.emergencyContact.name} (${currentUserData.emergencyContact.phone})` : '---'
    };
    
    for (const [id, val] of Object.entries(fields)) {
        const el = document.getElementById(id);
        if (el) el.innerText = val;
    }
    
    const dispName = document.getElementById('profile-display-name');
    if (dispName) dispName.innerText = (currentUserData.driverName || 'Operator').toUpperCase();
    
    const avatar = document.getElementById('profile-avatar-initials');
    if (avatar) avatar.innerText = (currentUserData.driverName || '?').charAt(0).toUpperCase();
}

async function toggleProfileEdit() {
    const btn = document.getElementById('btn-edit-profile');
    const rows = document.querySelectorAll('.profile-row');
    
    if (!isProfileEditing) {
        // Enter Edit Mode
        isProfileEditing = true;
        btn.innerText = 'SAVE CHANGES';
        btn.classList.add('active');
        
        const fieldMap = { 'prof-name': 'driverName', 'prof-email': 'email', 'prof-sex': 'sex', 'prof-phone': 'phone' };
        
        rows.forEach(row => {
            const valEl = row.querySelector('.profile-value');
            if (valEl && fieldMap[valEl.id]) {
                const key = fieldMap[valEl.id];
                const currentVal = valEl.innerText === '---' ? '' : valEl.innerText;
                
                if (key === 'sex') {
                    const options = ['Male', 'Female', 'Non-Binary', 'Other', 'Private'];
                    let selectHtml = `<select class="profile-editable-input" data-key="${key}">`;
                    options.forEach(opt => {
                        const selected = (currentVal === opt || (opt === 'Private' && currentVal === 'Prefer not to say')) ? 'selected' : '';
                        selectHtml += `<option value="${opt}" ${selected}>${opt === 'Private' ? 'Prefer not to say' : opt}</option>`;
                    });
                    selectHtml += `</select>`;
                    valEl.innerHTML = selectHtml;
                } else {
                    const type = key === 'email' ? 'email' : (key === 'phone' ? 'tel' : 'text');
                    valEl.innerHTML = `<input type="${type}" class="profile-editable-input" value="${currentVal}" data-key="${key}" required>`;
                }
            }
        });
    } else {
        // Save Changes
        const updates = {};
        let isValid = true;
        
        rows.forEach(row => {
            const input = row.querySelector('input, select');
            if (input) {
                const key = input.getAttribute('data-key');
                const val = input.value.trim();
                
                // Simple Validation
                if (!val && input.hasAttribute('required')) {
                    isValid = false;
                    logEvent(`PROFILE: ${key.toUpperCase()} cannot be empty.`, 't-warn');
                }
                if (key === 'email' && val && !val.includes('@')) {
                    isValid = false;
                    logEvent('PROFILE: Invalid email address format.', 't-warn');
                }
                
                updates[key] = val;
            }
        });
        
        if (!isValid) return;

        try {
            await db.collection('users').doc(auth.currentUser.uid).update(updates);
            currentUserData = { ...currentUserData, ...updates };
            logEvent('PROFILE: Information updated successfully.', 't-succ');
            isProfileEditing = false;
            btn.innerText = 'EDIT PROFILE';
            btn.classList.remove('active');
            renderProfile();
        } catch (e) {
            logEvent('PROFILE: Failed to save changes.', 't-warn');
        }
    }
}

// ── Dashboard Animations ──────────────────────────────────
function animateValue(id, start, end, duration, suffix = '') {
    const obj = document.getElementById(id);
    if (!obj) return;
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        const current = Math.floor(progress * (end - start) + start);
        obj.innerHTML = current + suffix;
        if (progress < 1) {
            window.requestAnimationFrame(step);
        }
    };
    window.requestAnimationFrame(step);
}

// Update startSystem to add pulse
const _origStartSystem = startSystem;
startSystem = async function() {
    await _origStartSystem();
    if (isRunning) {
        document.querySelectorAll('.stat-card').forEach(c => c.classList.add('active-monitoring'));
    }
};

async function signOut() {
    try {
        await auth.signOut();
        window.location.replace('login.html');
    } catch (e) {
        console.error('Sign out error:', e);
    }
}

// ── PWA Installation Logic ────────────────────────────────
let deferredPrompt;
const installBtn = document.getElementById('btn-install-pwa');

window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent Chrome 67 and earlier from automatically showing the prompt
    e.preventDefault();
    // Stash the event so it can be triggered later.
    deferredPrompt = e;
    // Show the install button in the Profile tab
    if (installBtn) {
        installBtn.style.display = 'block';
        logEvent('PWA: App is ready for installation.', 't-info');
    }
});

if (installBtn) {
    installBtn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        // Show the native install prompt
        deferredPrompt.prompt();
        // Wait for the user to respond
        const { outcome } = await deferredPrompt.userChoice;
        console.log(`PWA: Install outcome: ${outcome}`);
        // Clear the deferred prompt so it can't be used again
        deferredPrompt = null;
        // Hide the button
        installBtn.style.display = 'none';
    });
}

window.addEventListener('appinstalled', () => {
    console.log('PWA: DriverWatch was installed successfully.');
    if (installBtn) installBtn.style.display = 'none';
    logEvent('PWA: App installed successfully!', 't-succ');
});

