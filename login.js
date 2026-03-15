// UI Utilities
function toggleView(view) {
    document.getElementById('login-view').style.display = 'none';
    document.getElementById('register-view').style.display = 'none';
    document.getElementById('verify-code-view').style.display = 'none';
    document.getElementById('onboarding-view').style.display = 'none';

    if (view === 'login') {
        document.getElementById('login-view').style.display = 'block';
        document.getElementById('btn-login').classList.add('active');
        document.getElementById('btn-register').classList.remove('active');
    } else if (view === 'register') {
        document.getElementById('register-view').style.display = 'block';
        document.getElementById('btn-login').classList.remove('active');
        document.getElementById('btn-register').classList.add('active');
        initRecaptcha();
    }
}

function toggleEmailReg() {
    const e = document.getElementById('reg-email-group');
    const p = document.getElementById('reg-pass-group');
    if (e.style.display === 'none') {
        e.style.display = 'block';
        p.style.display = 'block';
        document.getElementById('regEmail').setAttribute('required', 'true');
        document.getElementById('regPassword').setAttribute('required', 'true');
        document.getElementById('phone-submit').textContent = 'REGISTER EMAIL & SECURE PHONE';
    } else {
        e.style.display = 'none';
        p.style.display = 'none';
        document.getElementById('regEmail').removeAttribute('required');
        document.getElementById('regPassword').removeAttribute('required');
        document.getElementById('phone-submit').textContent = 'SEND SMS CODE';
    }
}

function togglePasswordVisibility(inputId) {
    const el = document.getElementById(inputId);
    const btn = el.nextElementSibling;
    if (el.type === "password") {
        el.type = "text";
        btn.textContent = "HIDE";
    } else {
        el.type = "password";
        btn.textContent = "SHOW";
    }
}

// Intl-Tel-Input Setups
const phoneInputReg = window.intlTelInput(document.querySelector("#regContactPhone"), {
    utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js",
    preferredCountries: ["us", "gb", "ca", "ng"], separateDialCode: true,
});
const phoneInputOnb = window.intlTelInput(document.querySelector("#onbContactPhone"), {
    utilsScript: "https://cdnjs.cloudflare.com/ajax/libs/intl-tel-input/17.0.8/js/utils.js",
    preferredCountries: ["us", "gb", "ca", "ng"], separateDialCode: true,
});


// State
let confirmationResult = null;
let currentAuthenticatedUser = null;

// Auth State Observer - The Brains of the Operation
auth.onAuthStateChanged(async (user) => {
    if (user) {
        currentAuthenticatedUser = user;
        // Check if user has completed onboarding in Firestore
        try {
            const doc = await db.collection('users').doc(user.uid).get();
            if (doc.exists) {
                // User is fully set up, redirect to dashboard
                window.location.href = 'index.html';
            } else {
                // User is authenticated via Google/Phone but needs to provide Emergency Contact
                document.getElementById('login-view').style.display = 'none';
                document.getElementById('register-view').style.display = 'none';
                document.getElementById('verify-code-view').style.display = 'none';
                document.querySelector('.auth-toggle').style.display = 'none';

                // Pre-fill name if coming from Google
                if (user.displayName) document.getElementById('onbDriverName').value = user.displayName;
                if (user.phoneNumber) phoneInputOnb.setNumber(user.phoneNumber);

                document.getElementById('onboarding-view').style.display = 'block';
            }
        } catch (e) {
            console.error("Error fetching user data", e);
        }
    }
});

// Google Sign-In
document.getElementById('google-signin-btn').addEventListener('click', async () => {
    const provider = new firebase.auth.GoogleAuthProvider();
    const errorDiv = document.getElementById('login-error');
    errorDiv.style.display = 'none';

    try {
        await auth.signInWithPopup(provider);
        // onAuthStateChanged takes over
    } catch (err) {
        errorDiv.textContent = err.message;
        errorDiv.style.display = 'block';
    }
});

// Email/Pass Sign-In
document.getElementById('email-signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const pass = document.getElementById('loginPassword').value;
    const errorDiv = document.getElementById('login-error');
    const btn = document.getElementById('login-submit');

    errorDiv.style.display = 'none';
    btn.disabled = true; btn.textContent = 'AUTHENTICATING...';

    try {
        await auth.signInWithEmailAndPassword(email, pass);
    } catch (err) {
        errorDiv.textContent = err.message;
        errorDiv.style.display = 'block';
        btn.disabled = false; btn.textContent = 'AUTHENTICATE EMAIL';
    }
});

// Phone Auth & Recaptcha
function initRecaptcha() {
    if (!window.recaptchaVerifier) {
        window.recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {
            'size': 'normal',
            'callback': (response) => {
                // reCAPTCHA solved
                document.getElementById('phone-submit').disabled = false;
            },
            'expired-callback': () => {
                document.getElementById('phone-submit').disabled = true;
            }
        });
        window.recaptchaVerifier.render();
    }
}

function resetRecaptcha() {
    if (window.recaptchaVerifier) {
        window.recaptchaVerifier.clear();
        window.recaptchaVerifier = null;
        initRecaptcha();
    }
}

document.getElementById('phone-auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!phoneInputReg.isValidNumber()) {
        const errorDiv = document.getElementById('phone-error');
        errorDiv.textContent = 'Please enter a valid Professional Phone Number.';
        errorDiv.style.display = 'block';
        return;
    }

    const phoneNumber = phoneInputReg.getNumber();
    const errorDiv = document.getElementById('phone-error');
    const btn = document.getElementById('phone-submit');

    // Email registration combo logic
    const isEmailReg = document.getElementById('reg-email-group').style.display === 'block';

    errorDiv.style.display = 'none';
    btn.disabled = true; btn.textContent = 'SECURING DEVICE...';

    try {
        if (isEmailReg) {
            const email = document.getElementById('regEmail').value;
            const pass = document.getElementById('regPassword').value;
            // Create user first, then let auth state listener catch it and push to onboarding
            await auth.createUserWithEmailAndPassword(email, pass);
        } else {
            // Standard Phone Auth
            const appVerifier = window.recaptchaVerifier;
            confirmationResult = await auth.signInWithPhoneNumber(phoneNumber, appVerifier);

            // Show Verify View
            document.getElementById('register-view').style.display = 'none';
            document.getElementById('verify-code-view').style.display = 'block';
        }
    } catch (err) {
        errorDiv.textContent = err.message;
        errorDiv.style.display = 'block';
        btn.disabled = false; btn.textContent = isEmailReg ? 'REGISTER EMAIL & SECURE PHONE' : 'SEND SMS CODE';
        if (!isEmailReg) resetRecaptcha();
    }
});

// Verify SMS Code
document.getElementById('verify-code-view').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = document.getElementById('verificationCode').value;
    const errorDiv = document.getElementById('verify-error');
    const btn = document.getElementById('verify-submit');

    errorDiv.style.display = 'none';
    btn.disabled = true; btn.textContent = 'VERIFYING...';

    try {
        await confirmationResult.confirm(code);
        // onAuthStateChanged takes over to handle missing profile check
    } catch (err) {
        errorDiv.textContent = 'Invalid verification code. Please try again.';
        errorDiv.style.display = 'block';
        btn.disabled = false; btn.textContent = 'VERIFY DEVICE';
    }
});

// Onboarding Submission (When new Auth user needs to fill out Firestore Profile)
document.getElementById('onboarding-view').addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!phoneInputOnb.isValidNumber()) {
        const errorDiv = document.getElementById('onb-error');
        errorDiv.textContent = 'Please enter a valid Professional Phone Number.';
        errorDiv.style.display = 'block';
        return;
    }

    if (!currentAuthenticatedUser) return; // Guard 

    const driverName = document.getElementById('onbDriverName').value;
    const contactName = document.getElementById('onbContactName').value;
    const contactPhone = phoneInputOnb.getNumber();

    const errorDiv = document.getElementById('onb-error');
    const btn = document.getElementById('onb-submit');
    const locationConsent = document.getElementById('onbLocationConsent').checked;

    errorDiv.style.display = 'none';
    btn.disabled = true; btn.textContent = 'REQUESTING LOCATION...';

    if (!navigator.geolocation) {
        errorDiv.textContent = 'Geolocation is not supported by your browser.';
        errorDiv.style.display = 'block';
        btn.disabled = false; btn.textContent = 'FINALIZE PROVISIONING';
        return;
    }

    navigator.geolocation.getCurrentPosition(
        async (position) => {
            btn.textContent = 'PROVISIONING ACCOUNT...';
            try {
                // Insert to Firestore
                await db.collection('users').doc(currentAuthenticatedUser.uid).set({
                    driverName: driverName,
                    emergencyContact: {
                        name: contactName,
                        phone: contactPhone
                    },
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });

                // Success - redirect manually
                window.location.href = 'index.html';

            } catch (err) {
                errorDiv.textContent = err.message;
                errorDiv.style.display = 'block';
                btn.disabled = false; btn.textContent = 'FINALIZE PROVISIONING';
            }
        },
        (error) => {
            let errorMessage = 'Error obtaining location. ';
            if (error.code === error.PERMISSION_DENIED) errorMessage += 'Location access required.';
            errorDiv.textContent = errorMessage;
            errorDiv.style.display = 'block';
            btn.disabled = false; btn.textContent = 'FINALIZE PROVISIONING';
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
});
