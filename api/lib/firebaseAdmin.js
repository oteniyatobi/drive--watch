// Lazy init — only loads when /api/recording-* routes run
const admin = require('firebase-admin');

function getFirebaseAdmin() {
    if (!admin.apps.length) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        if (!raw) {
            throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set');
        }
        const cred = JSON.parse(raw);
        admin.initializeApp({
            credential: admin.credential.cert(cred)
        });
    }
    return admin;
}

module.exports = { getFirebaseAdmin };
