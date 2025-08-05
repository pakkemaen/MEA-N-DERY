import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, doc, updateDoc, query, deleteDoc, getDoc, setDoc, writeBatch, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// IIFE to create a private scope and avoid polluting the global namespace
(function() {
    // --- App State ---
    let db, auth, userId;
    let brews = []; // Local cache of brews
    let inventory = []; // Local cache of inventory
    let equipment = []; // Local cache of equipment
    let userSettings = {}; // Holds settings from Firestore
    let currentBrewDay = { brewId: null, checklist: {} }; // Holds the state for the current brew day
    let currentRecipeMarkdown = ''; // To hold the latest generated recipe markdown
    let currentWaterProfile = null; // To hold the fetched water data
    let costChart = null; // To hold the chart instance

    // --- UI Elements ---
    const dashboardMainView = document.getElementById('dashboard-main-view');
    const brewingMainView = document.getElementById('brewing-main-view');
    const managementMainView = document.getElementById('management-main-view');
    const toolsMainView = document.getElementById('tools-main-view');
    const settingsView = document.getElementById('settings-view');

    // --- Initialization ---
    function initApp() {
        // Your web app's Firebase configuration
        const firebaseConfig = {
          apiKey: "AIzaSyAhOOrwJCYve5XTGS6oXvhCg_l3_LcK00I",
          authDomain: "meandery-aa05e.firebaseapp.com",
          projectId: "meandery-aa05e",
          storageBucket: "meandery-aa05e.appspot.com",
          messagingSenderId: "388311971225",
          appId: "1:388311971225:web:e5b0e81ce18d96b4a88f08",
          measurementId: "G-S5CPLP80XT"
        };

        try {
            const app = initializeApp(firebaseConfig);
            db = getFirestore(app);
            auth = getAuth(app);

            onAuthStateChanged(auth, async (user) => {
                if (user) {
                    userId = user.uid;
                    loadHistory();
                    loadInventory();
                    loadEquipment();
                    loadUserSettings(); 
                    getAlchemistTip();
                } else {
                    try {
                        await signInAnonymously(auth);
                    } catch (error) {
                        console.error("Anonymous authentication failed:", error);
                    }
                }
            });
        } catch (e) {
            console.error("Firebase initialization failed. App will run in offline mode.", e);
        }

        // --- Event Listeners ---
        document.querySelectorAll('.main-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => switchMainView(btn.dataset.view));
        });
        document.querySelectorAll('.back-to-dashboard-btn').forEach(btn => {
            btn.addEventListener('click', () => switchMainView('dashboard'));
        });

        document.querySelectorAll('.sub-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const parentId = e.target.closest('[id$="-main-view"]').id;
                switchSubView(e.target.id.replace('-sub-tab', ''), parentId);
            });
        });
        
        // Quick Actions on Dashboard
        document.getElementById('quick-action-new').addEventListener('click', () => {
            switchMainView('brewing');
            switchSubView('creator', 'brewing-main-view');
        });
        document.getElementById('quick-action-history').addEventListener('click', () => {
            switchMainView('brewing');
            switchSubView('history', 'brewing-main-view');
        });
        document.getElementById('quick-action-inventory').addEventListener('click', () => {
            switchMainView('management');
            switchSubView('inventory', 'management-main-view');
        });

        // Other event listeners will be attached when their respective views are rendered
    }

    // --- View Management ---
    function switchMainView(viewName) {
        [dashboardMainView, brewingMainView, managementMainView, toolsMainView, settingsView].forEach(v => v.classList.add('hidden'));
        
        const viewToShow = document.getElementById(`${viewName}-main-view`);

        if (viewToShow) {
            viewToShow.classList.remove('hidden');
        } else if (viewName === 'settings') {
            settingsView.classList.remove('hidden');
        }
        
        if (viewName === 'dashboard') {
            updateDashboard();
        }
    }

    function switchSubView(viewName, parentViewId) {
        const parentView = document.getElementById(parentViewId);
        parentView.querySelectorAll('[id$="-view"]').forEach(v => v.classList.add('hidden'));
        parentView.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));

        const viewToShow = document.getElementById(`${viewName}-view`);
        const tabToActivate = document.getElementById(`${viewName}-sub-tab`);

        if (viewToShow) viewToShow.classList.remove('hidden');
        if (tabToActivate) tabToActivate.classList.add('active');
    }

    // ... (rest of the script.js code will be here)
})();
