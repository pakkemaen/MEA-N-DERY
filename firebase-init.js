// ============================================================================
// firebase-init.js
// Central Connection Hub - V2.6
// ============================================================================

// 1. Imports van Firebase CDN (Versie 10.12.2)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import { 
    getAuth, 
    GoogleAuthProvider, 
    signInWithPopup, 
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { 
    getFirestore, 
    collection, 
    doc, 
    getDoc, 
    getDocs, 
    addDoc, 
    setDoc,
    updateDoc, 
    deleteDoc, 
    query, 
    where, 
    orderBy, 
    limit,
    Timestamp,
    arrayUnion,
    serverTimestamp,
    onSnapshot,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { 
    getStorage, 
    ref, 
    uploadBytes, 
    getDownloadURL,
    deleteObject,
    uploadString
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// 2. Import Config (Zorg dat secrets.js bestaat en firebaseConfig exporteert!)
import { firebaseConfig } from './secrets.js';

// 3. Initialisatie
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const googleProvider = new GoogleAuthProvider();

// Optioneel: Offline persistence aanzetten (goed voor mobiel gebruik in kelder)
// import { enableIndexedDbPersistence } from ... (kan later toegevoegd worden)

// 4. Exports
export { 
    // Instanties
    app, 
    auth, 
    db, 
    storage, 
    googleProvider, 

    // Auth Functies
    signInWithPopup, 
    onAuthStateChanged,
    signOut,

    // Firestore Functies
    collection, 
    doc, 
    getDoc, 
    getDocs, 
    addDoc, 
    setDoc,
    updateDoc, 
    deleteDoc, 
    query, 
    where, 
    orderBy, 
    limit,
    Timestamp,
    arrayUnion,
    serverTimestamp,
    onSnapshot,
    writeBatch,

    // Storage Functies
    ref, 
    uploadBytes, 
    getDownloadURL,
    deleteObject,
    uploadString
};