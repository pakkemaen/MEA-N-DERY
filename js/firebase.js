// js/firebase.js

// Importeer de functies
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { 
    getFirestore, collection, addDoc, onSnapshot, doc, updateDoc, 
    query, deleteDoc, getDoc, setDoc, writeBatch, getDocs, arrayUnion 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Je Firebase configuratie (geplakt uit app.js)
const firebaseConfig = {
  apiKey: "AIzaSyAhOOrwJCYve5XTGS6oXvhCg_l3_LcK00I",
  authDomain: "meandery-aa05e.firebaseapp.com",
  projectId: "meandery-aa05e",
  storageBucket: "meandery-aa05e.appspot.com",
  messagingSenderId: "388311971225",
  appId: "1:388311971225:web:e5b0e81ce18d96b4a88f08",
  measurementId: "G-S5CPLP80XT"
};

// Initialiseer Firebase (geplakt uit app.js)
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Exporteer de instanties en functies die de rest van je app nodig heeft
export { 
    db, 
    auth, 
    GoogleAuthProvider, 
    signInWithPopup, 
    onAuthStateChanged, 
    collection, 
    addDoc, 
    onSnapshot, 
    doc, 
    updateDoc, 
    query, 
    deleteDoc, 
    getDoc, 
    setDoc, 
    writeBatch, 
    getDocs, 
    arrayUnion 
};