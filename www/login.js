// Detect if running inside the native Capacitor app (Android / iOS).
const isNativeApp = typeof window !== 'undefined' &&
    window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform();

const VIEWS = ['signin-view', 'signup-view', 'phone-view', 'verify-view', 'onboarding-view'];

// UI Utilities
function showView(view) {
    VIEWS.forEach((id) => {
        document.getElementById(id).hidden = id !== view;
    });
    const tabs = document.getElementById('auth-tabs');
    tabs.hidden = view === 'verify-view' || view === 'onboarding-view';
    document.getElementById('tab-signin').classList.toggle('active', view === 'signin-view' || view === 'phone-view');
    document.getElementById('tab-signup').classList.toggle('active', view === 'signup-view');
    clearMessages();
}

function clearMessages() {
    document.querySelectorAll('.auth-msg').forEach((el) => {
        el.hidden = true;
        el.textContent = '';
    });
}

function showMessage(id, text, kind = 'error') {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = `auth-msg ${kind}`;
    el.hidden = false;
}

function setBusy(btn, busy, label) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.disabled = busy;
    btn.textContent = busy ? label : btn.dataset.label;
}

function togglePasswordVisibility(inputId, btn) {
    const el = document.getElementById(inputId);
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
}

// Intl-Tel-Input Setups
const telOptions = {
    utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js",
    preferredCountries: ["rw", "ke", "ug", "tz", "ng", "gb", "us"],
    separateDialCode: true,
};
const phoneInputAuth = window.intlTelInput(document.querySelector("#authPhone"), telOptions);
const phoneInputOnb = window.intlTelInput(document.querySelector("#onbContactPhone"), telOptions);

// State
let pendingPhone = null;
let currentAuthenticatedUser = null;

function showOnboardingUI(user) {
    currentAuthenticatedUser = user;
    const meta = user.user_metadata || {};
    const name = meta.full_name || meta.name;
    if (name) document.getElementById('onbDriverName').value = name;
    showView('onboarding-view');
}

/** Signed-in users with a profile go straight to the app; new users finish onboarding. */
async function routeSignedInUser(user) {
    currentAuthenticatedUser = user;
    try {
        const profile = await fetchProfile(user.id);
        if (profile) {
            window.location.replace('/');
        } else {
            showOnboardingUI(user);
        }
    } catch (e) {
        console.error('Error fetching user profile', e);
        showMessage('signin-msg', 'Could not load your profile. Check your connection and try again.');
    }
}

// Handles both a returning session and the redirect back from Google OAuth.
sb.auth.onAuthStateChange((event, session) => {
    if (!session) {
        currentAuthenticatedUser = null;
        return;
    }
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
        // Defer: Supabase recommends not awaiting other calls inside this callback.
        setTimeout(() => routeSignedInUser(session.user), 0);
    }
});

// Tabs
document.getElementById('tab-signin').addEventListener('click', () => showView('signin-view'));
document.getElementById('tab-signup').addEventListener('click', () => showView('signup-view'));
document.querySelectorAll('[data-show]').forEach((el) => {
    el.addEventListener('click', () => showView(el.dataset.show));
});

// Google Sign-In
// - Native app (Android/iOS): uses the Capacitor GoogleAuth plugin — opens the native
//   Google account picker already on the device, then exchanges its ID token with Supabase.
// - Web browser: Supabase OAuth redirect; we land back on this page signed in.
document.querySelectorAll('.btn-google').forEach((btn) => btn.addEventListener('click', async () => {
    clearMessages();
    try {
        if (isNativeApp) {
            const GoogleAuth = window.Capacitor.Plugins.GoogleAuth;
            await GoogleAuth.initialize();
            const googleUser = await GoogleAuth.signIn();
            const { error } = await sb.auth.signInWithIdToken({
                provider: 'google',
                token: googleUser.authentication.idToken,
            });
            if (error) throw error;
        } else {
            const { error } = await sb.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo: window.location.origin + window.location.pathname },
            });
            if (error) throw error;
        }
    } catch (err) {
        showMessage('signin-msg', err.message || 'Google sign-in failed. Try email instead.');
    }
}));

// Email/Pass Sign-In
document.getElementById('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('signin-submit');
    clearMessages();
    setBusy(btn, true, 'Signing in…');

    const { error } = await sb.auth.signInWithPassword({
        email: document.getElementById('signinEmail').value.trim(),
        password: document.getElementById('signinPassword').value,
    });
    if (error) {
        showMessage('signin-msg', error.message);
        setBusy(btn, false);
    }
    // Success is handled by onAuthStateChange.
});

// Email/Pass Registration
document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('signup-submit');
    clearMessages();
    setBusy(btn, true, 'Creating account…');

    const { data, error } = await sb.auth.signUp({
        email: document.getElementById('signupEmail').value.trim(),
        password: document.getElementById('signupPassword').value,
        options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    setBusy(btn, false);
    if (error) {
        showMessage('signup-msg', error.message);
        return;
    }
    if (!data.session) {
        // "Confirm email" is on in Supabase → user must click the link first.
        showMessage('signup-msg', 'Check your inbox and click the confirmation link to finish creating your account.', 'success');
    }
    // With a session, onAuthStateChange moves the user to onboarding.
});

// Phone OTP — Supabase sends the SMS via the provider configured in Auth → Providers → Phone.
document.getElementById('phone-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessages();

    if (!phoneInputAuth.isValidNumber()) {
        showMessage('phone-msg', 'Enter a valid phone number.');
        return;
    }

    const btn = document.getElementById('phone-submit');
    setBusy(btn, true, 'Sending code…');
    pendingPhone = phoneInputAuth.getNumber();

    const { error } = await sb.auth.signInWithOtp({ phone: pendingPhone });
    setBusy(btn, false);
    if (error) {
        showMessage('phone-msg', error.message);
        return;
    }
    document.getElementById('verify-target').textContent = pendingPhone;
    showView('verify-view');
    document.getElementById('verificationCode').focus();
});

// Verify SMS Code
document.getElementById('verify-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('verify-submit');
    clearMessages();
    setBusy(btn, true, 'Verifying…');

    const { error } = await sb.auth.verifyOtp({
        phone: pendingPhone,
        token: document.getElementById('verificationCode').value.trim(),
        type: 'sms',
    });
    if (error) {
        showMessage('verify-msg', 'That code is invalid or expired. Try again.');
        setBusy(btn, false);
    }
    // Success is handled by onAuthStateChange.
});

// Onboarding Submission (new auth user needs a profiles row)
document.getElementById('onboarding-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessages();

    if (!phoneInputOnb.isValidNumber()) {
        showMessage('onb-msg', 'Enter a valid phone number for your emergency contact.');
        return;
    }
    if (!currentAuthenticatedUser) return; // Guard

    const btn = document.getElementById('onb-submit');
    const user = currentAuthenticatedUser;
    const profile = {
        driverName: document.getElementById('onbDriverName').value.trim(),
        sex: document.getElementById('onbSex').value,
        email: user.email || '',
        phone: user.phone ? `+${user.phone.replace(/^\+/, '')}` : '',
        emergencyContact: {
            name: document.getElementById('onbContactName').value.trim(),
            phone: phoneInputOnb.getNumber(),
        },
        locationConsentGranted: document.getElementById('onbLocationConsent').checked,
    };

    if (!navigator.geolocation) {
        showMessage('onb-msg', 'Location is not supported in this browser.');
        return;
    }

    setBusy(btn, true, 'Requesting location…');
    navigator.geolocation.getCurrentPosition(
        async () => {
            btn.textContent = 'Saving profile…';
            const { error } = await sb.from('profiles').upsert({ id: user.id, ...profileToRow(profile) });
            if (error) {
                showMessage('onb-msg', error.message);
                setBusy(btn, false);
                return;
            }
            window.location.href = '/';
        },
        (error) => {
            showMessage('onb-msg', error.code === error.PERMISSION_DENIED
                ? 'Location access is required so emergency alerts can include your position.'
                : 'Could not get your location. Try again.');
            setBusy(btn, false);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
});

// Sign out from onboarding (e.g. wrong account)
document.getElementById('onb-signout').addEventListener('click', async () => {
    await sb.auth.signOut();
    showView('signin-view');
});

showView('signin-view');
