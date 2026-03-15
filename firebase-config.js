// firebase-config.js
// Your web app's Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyDTMu8C_PzwOeKAtgSvCzyaOFLe-dAwX38",
    authDomain: "driver-watch-62f71.firebaseapp.com",
    projectId: "driver-watch-62f71",
    storageBucket: "driver-watch-62f71.firebasestorage.app",
    messagingSenderId: "157675587246",
    appId: "1:157675587246:web:651e82b3ff8a5ae65b0f3f"
};

// Initialize Firebase using the Compat libraries
firebase.initializeApp(firebaseConfig);

// Initialize Authentication and Firestore
const auth = firebase.auth();
const db = firebase.firestore();
