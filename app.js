// ============================================================================
// app.js - 
// MEANDERY V2.6
// ============================================================================

// 1. MODULE IMPORTS (MOETEN BOVENAAN STAAN)
// Dit garandeert dat alle window.functies geladen zijn voordat we ze aanroepen.
import './utils.js';
import './brewing.js';
import './inventory.js';
import './label-forge.js';
import './tools.js';

// 2. CORE IMPORTS
import { auth, onAuthStateChanged, signInWithPopup, googleProvider, db, doc, deleteDoc, updateDoc } from './firebase-init.js';
import { state } from './state.js';
import { showToast } from './utils.js';

// --- AUTO-LOGGER (Vangt onverwachte crashes) ---
window.addEventListener('error', (event) => {
    window.logSystemError(event.error, 'Uncaught Crash', 'FATAL');
});

window.addEventListener('unhandledrejection', (event) => {
    window.logSystemError(event.reason, 'Unhandled Promise (Network/Async)', 'ERROR');
});

// 3. SAFE LOADER HELPER
// Deze functie voorkomt dat de app crasht als één module nog niet klaar is.
const safeInit = (functionName) => {
    if (typeof window[functionName] === 'function') {
        try {
            window[functionName]();
            console.log(`✅ Module loaded: ${functionName}`);
        } catch (err) {
            // HIER GEBRUIKEN WE NU DE LOGGER:
            window.logSystemError(err, `Init Module: ${functionName}`);
            showToast(`Error loading module: ${functionName}`, 'error');
        }
    } else {
        console.warn(`⚠️ Module function missing: ${functionName}`);
    }
};

// 4. AUTH & INITIALISATIE
const loginView = document.getElementById('login-view');
const appContainer = document.querySelector('.container.mx-auto'); 

onAuthStateChanged(auth, async (user) => {
    if (user) {
        console.log("🔓 User logged in:", user.uid);
        state.userId = user.uid;
        
        // UI Wisselen
        if (loginView) loginView.classList.add('hidden');
        if (appContainer) appContainer.classList.remove('hidden');

        // Start Data Loaders via de Safe Loader
        safeInit('loadUserSettings');      // Eerst settings (valuta, API keys)
        safeInit('loadHistory');           // Dan data
        safeInit('loadInventory');
        safeInit('loadCellar');
        safeInit('loadPackagingCosts');
        safeInit('loadEquipmentProfiles');
        safeInit('loadLabelAssets');
        safeInit('loadUserWaterProfiles');
        safeInit('initLabelForge');
    
        // START DE DASHBOARD UPDATER (Gesynchroniseerd naar v2.6 updateDashboardStats)
        setTimeout(() => safeInit('updateDashboardStats'), 1500);

    } else {
        console.log("🔒 No user.");
        state.userId = null;
        if (loginView) loginView.classList.remove('hidden');
        if (appContainer) appContainer.classList.add('hidden');
    }
});

document.addEventListener('DOMContentLoaded', () => {
    console.log("🚀 Meandery V2.6 Modular System Active");

    // Initialiseer universele sleep- en muiswiel-interactie op alle sub-navigatiebalken
    if (window.initScrollableTabs) window.initScrollableTabs();

    // --- GLOBAL AUTH FUNCTION (Nodig voor de HTML onclick) ---
    window.signInWithGoogle = async function() {
        console.log("🔐 Starting Google Sign-In...");
        try {
            const result = await signInWithPopup(auth, googleProvider);
            console.log("✅ Login Success:", result.user.uid);
        } catch (error) {
            // Gesaneerd naar centraal Black Box Framework
            window.logSystemError(error, 'Auth: Google Sign-In', 'ERROR');
            showToast("Login failed: " + error.message, "error");
        }
    };

    // --- NAVIGATIE ---
    document.querySelectorAll('.main-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchMainView(btn.dataset.view));
    });
    document.querySelectorAll('.back-to-dashboard-btn').forEach(btn => {
        btn.addEventListener('click', () => switchMainView('dashboard'));
    });

    document.querySelectorAll('.sub-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            try {
                const parentId = e.target.closest('[id$="-main-view"]').id;
                const viewName = e.target.id.replace('-sub-tab', '');
                
                switchSubView(viewName, parentId);

                if (viewName === 'brew-day-1') {
                    const activeId = state.currentBrewDay?.brewId || (state.userSettings?.currentBrewDay?.brewId);
                    if (window.renderBrewDay) {
                        window.renderBrewDay(activeId || 'none');
                    }
                }
                
                if (viewName === 'brew-day-2' && window.renderBrewDay2) {
                    window.renderBrewDay2();
                }

                if (viewName === 'settings-data' && window.updateLogCount) {
                    window.updateLogCount();
                }
            } catch (error) {
                if (window.logSystemError) {
                    window.logSystemError(error, "Sub-Tab Navigation Lifecycle Verification", "ERROR");
                }
                if (window.showToast) {
                    window.showToast("Navigation lifecycle exception caught", "error");
                }
            }
        });
    });

    // --- BROUWEN ---
    document.getElementById('generateBtn')?.addEventListener('click', () => window.generateRecipe());
    document.getElementById('customDescription')?.addEventListener('input', () => window.handleDescriptionInput());
    document.getElementById('style')?.addEventListener('change', () => window.handleStyleChange());

    // --- ARCHIVE BREW (Move to History, remove from Active) ---
    window.archiveBrew = async function(brewId, brewName) {
        if(!confirm(`📦 ARCHIVE: "${brewName}"?\n\nThis will mark the batch as 'Completed'.\nIt will disappear from your Dashboard and Active lists,\nbut remains safe in your History.`)) return;

        try {
            await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), {
                archived: true,
                primaryComplete: true,
                isBottled: true
            });
            
            const brew = state.brews.find(b => b.id === brewId);
            if(brew) {
                brew.archived = true;
                brew.primaryComplete = true;
                brew.isBottled = true;
            }
            
            if (window.updateDashboardStats) window.updateDashboardStats();
            if (window.renderBrewDay) window.renderBrewDay();
            if (window.renderBrewDay2) window.renderBrewDay2();
            
            showToast(`📦 "${brewName}" archived to History.`, "success");
        } catch (e) {
            window.logSystemError(e, 'Archive Brew Failure', 'ERROR');
            showToast("Error archiving: " + e.message, "error");
        }
    };

    // --- GHOST BREW REMOVER ---
    window.deleteGhostBrew = async function(brewId, brewName) {
        if(!confirm(`⚠️ FORCE DELETE: "${brewName}"?\n\nThis will permanently remove this ghost brew from the database. This cannot be undone.`)) return;

        try {
            await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId));
            state.brews = state.brews.filter(b => b.id !== brewId);
            if (window.updateDashboardStats) window.updateDashboardStats();
            
            showToast(`👻 Ghost brew "${brewName}" busted!`, "success");
        } catch (e) {
            window.logSystemError(e, 'Delete Ghost Brew Failure', 'ERROR');
            showToast("Error deleting ghost brew: " + e.message, "error");
        }
    };
    
    // --- VOORRAAD ---
    document.getElementById('inventory-form')?.addEventListener('submit', (e) => window.addInventoryItem(e));
    document.getElementById('packaging-add-form')?.addEventListener('submit', (e) => window.addPackagingStock(e));
    document.getElementById('scan-barcode-btn')?.addEventListener('click', () => window.startScanner());
    document.getElementById('close-scanner-btn')?.addEventListener('click', () => window.stopScanner());
    document.getElementById('equipment-profile-form')?.addEventListener('submit', (e) => window.addEquipmentProfile(e));

    // --- KELDER ---
    document.getElementById('bottling-form')?.addEventListener('submit', (e) => window.bottleBatch(e));

    // --- INSTELLINGEN ---
    document.getElementById('saveSettingsBtn')?.addEventListener('click', () => window.saveUserSettings());
    document.getElementById('fetchModelsBtn')?.addEventListener('click', () => window.fetchAvailableModels());
    // Theme Toggle Listener
    document.getElementById('theme-toggle-checkbox')?.addEventListener('change', (e) => {
        try {
            const isDark = e.target.checked;
            
            if (!state.userSettings) {
                state.userSettings = {};
            }
            state.userSettings.theme = isDark ? 'dark' : 'light';
            
            if(isDark) {
                document.documentElement.classList.add('dark');
            } else {
                document.documentElement.classList.remove('dark');
            }
        } catch (error) {
            window.logSystemError?.(error, "Theme State Synchronization Lifecycle", "ERROR");
            window.showToast?.("Error synchronizing theme state", "error");
        }
    });
    
    // --- WATER TOOLS ---
    document.getElementById('water-profile-form')?.addEventListener('submit', (e) => window.saveWaterProfile(e));
    document.getElementById('ai-water-search-btn')?.addEventListener('click', () => window.findWaterProfileWithAI());
    document.getElementById('waterSource')?.addEventListener('change', () => {
        if (window.handleWaterSourceChange) window.handleWaterSourceChange();
    });

    // --- IMPORT / EXPORT ---
    document.getElementById('exportHistoryBtn')?.addEventListener('click', () => window.exportHistory());
    document.getElementById('exportInventoryBtn')?.addEventListener('click', () => window.exportInventory());
    document.getElementById('clearHistoryBtn')?.addEventListener('click', () => window.clearHistory());
    document.getElementById('clearInventoryBtn')?.addEventListener('click', () => window.clearInventory());
    
    const impHist = document.getElementById('importHistoryFile');
    if(impHist) impHist.addEventListener('change', (e) => window.importData(e, 'brews'));
    
    const impInv = document.getElementById('importInventoryFile');
    if(impInv) impInv.addEventListener('change', (e) => window.importData(e, 'inventory'));

    // --- ZOEKEN ---
    document.getElementById('history-search-input')?.addEventListener('input', () => {
        if(window.renderHistoryList) window.renderHistoryList();
    });

    // --- LABELS ---
    document.getElementById('addStyleBtn')?.addEventListener('click', () => window.addLabelStyle());
    document.getElementById('addFontBtn')?.addEventListener('click', () => window.addLabelFont());
    
    // --- MODALS ---
    const promptModal = document.getElementById('prompt-modal');
    if(promptModal) {
        promptModal.addEventListener('click', (e) => {
            if (e.target.id === 'prompt-modal') window.hidePromptModal();
        });
        document.getElementById('close-prompt-modal-btn')?.addEventListener('click', () => window.hidePromptModal());
    }

    const dangerCancel = document.getElementById('danger-cancel-btn');
    if(dangerCancel) dangerCancel.addEventListener('click', () => window.hideDangerModal());
    
    const dangerConfirm = document.getElementById('danger-confirm-btn');
    if(dangerConfirm) dangerConfirm.addEventListener('click', () => window.executeDangerAction());
    
    const dangerInput = document.getElementById('danger-confirm-input');
    if(dangerInput) dangerInput.addEventListener('input', () => window.checkDangerConfirmation());

    // --- EXTRA TOOLS ---
    document.getElementById('getYeastAdviceBtn')?.addEventListener('click', () => window.getYeastAdvice());
    
    // Chat / Troubleshoot System
    document.getElementById('chat-send-btn')?.addEventListener('click', () => window.sendTroubleshootMessage());
    document.getElementById('chat-image-input')?.addEventListener('change', (e) => window.handleChatImageSelect(e.target));
    
    // Social Media
    document.getElementById('generate-social-from-recipe-btn')?.addEventListener('click', () => window.runSocialMediaGenerator());

    // --- CALCULATORS V2.6 ---
    document.getElementById('calcAbvBtn')?.addEventListener('click', () => window.calculateABV());
    document.getElementById('correctSgBtn')?.addEventListener('click', () => window.correctHydrometer());
    document.getElementById('calcTosnaBtn')?.addEventListener('click', () => window.calculateTOSNA());
    document.getElementById('calcDilutionBtn')?.addEventListener('click', () => window.calculateDilution());
    document.getElementById('calcBacksweetenBtn')?.addEventListener('click', () => window.calculateBacksweetening());
    document.getElementById('calcBlendBtn')?.addEventListener('click', () => window.calculateBlend());

    // --- CALCULATORS V2.6 EVENT-MATRIX ---
    document.getElementById('calcStabilizationBtn')?.addEventListener('click', () => window.calculateStabilization?.());
    document.getElementById('calcBraggotBtn')?.addEventListener('click', () => window.calculateBraggot?.());
    document.getElementById('calcSplitBatchBtn')?.addEventListener('click', () => window.calculateSplitBatch?.());
    document.getElementById('calcTastingAssessmentBtn')?.addEventListener('click', () => window.calculateTastingAssessment?.());
    document.getElementById('calcWaterMatchingBtn')?.addEventListener('click', () => window.calculateWaterMatching?.());
    document.getElementById('calcBufferBtn')?.addEventListener('click', () => window.calculateBuffer?.());

   // Click-actie gesynchroniseerd naar de correct geëxporteerde v2.6 functie
   document.getElementById('calcTargetBrixBtn')?.addEventListener('click', () => window.calculateTargetApparentBrix?.());

    // Setup Timers & Listeners from Modules
    if(window.setupBrewDayEventListeners) window.setupBrewDayEventListeners();
    if(window.setupPromptEngineer) window.setupPromptEngineer();
});