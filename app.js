import { 
    db, auth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, 
    collection, addDoc, onSnapshot, doc, updateDoc, query, 
    deleteDoc, getDoc, setDoc, writeBatch, getDocs, arrayUnion 
} from './js/firebase.js';   

import { 
    calculateABV, correctHydrometer, calculatePrimingSugar, 
    calculateBlend, calculateBacksweetening, calculateDilution, calculateTOSNA 
} from './js/calculators.js';     

// IIFE to create a private scope and avoid polluting the global namespace
        (function() {
            // --- App State ---
            let userId;
            let lastGeneratedPrompt = '';
            let brews = []; // Local cache of brews
            let inventory = []; // Local cache of inventory
            let equipmentProfiles = []; // Local cache of equipment profiles
            let cellar = [];    // Local cache of bottled batches
            let userSettings = {}; // Holds settings from Firestore
            let currentBrewDay = { brewId: null, checklist: {} }; // Holds the state for the current brew day
            let currentRecipeMarkdown = ''; // To hold the latest generated recipe markdown
            let currentWaterProfile = null; // To hold the fetched water data
            let costChart = null; // To hold the chart instance
            let fermChartInstance = null;
            let html5QrcodeScanner = null;
            let customBottles = []; // Houdt de lijst met custom flessen bij
            let currentPredictedProfile = null;

// Functie om de lijst met custom flessen op het scherm te tekenen
window.renderCustomBottlesList = function() {
    const listDiv = document.getElementById('custom-bottles-list');
    if (!listDiv) return;

    if (customBottles.length === 0) {
        listDiv.innerHTML = '';
        return;
    }

    listDiv.innerHTML = customBottles.map((bottle, index) => `
        <div class="flex justify-between items-center p-2 bg-app-primary rounded-md text-sm">
            <span><strong>${bottle.quantity}x</strong> ${bottle.size}ml (at ${userSettings.currencySymbol || '€'}${bottle.price.toFixed(2)} each)</span>
            <button type="button" onclick="window.removeCustomBottleFromList(${index})" class="text-red-500 hover:text-red-700 font-bold text-lg">&times;</button>
        </div>
    `).join('');
}

// Functie die wordt aangeroepen door de '+ Add' knop
window.addCustomBottleToList = function() {
    const size = parseInt(document.getElementById('customSize').value) || 0;
    const quantity = parseInt(document.getElementById('customQty').value) || 0;
    const price = parseFloat(document.getElementById('customPrice').value) || 0;

    if (size <= 0 || quantity <= 0) {
        showToast("Please enter a valid size and quantity for the custom bottle.", "error");
        return;
    }

    customBottles.push({ size, quantity, price });
    renderCustomBottlesList();

    // Maak de input velden leeg voor de volgende invoer
    document.getElementById('customSize').value = '';
    document.getElementById('customQty').value = '';
    document.getElementById('customPrice').value = '';
    document.getElementById('customSize').focus();
}

// Functie om een fles uit de lijst te verwijderen
window.removeCustomBottleFromList = function(index) {
    customBottles.splice(index, 1);
    renderCustomBottlesList();
}

            let packagingCosts = {}; // Houdt de geladen kosten vast
            const PACKAGING_ITEMS = [
                { id: 'bottle_750', name: '750ml Bottle' },
                { id: 'bottle_500', name: '500ml Bottle' },
                { id: 'bottle_330', name: '330ml Bottle' },
                { id: 'bottle_250', name: '250ml Bottle' },
                { id: 'cork', name: 'Cork' },
                { id: 'crown_cap_26', name: 'Crown Cap 26mm' },
                { id: 'crown_cap_29', name: 'Crown Cap 29mm' },
                { id: 'label', name: 'Label' }
            ]; 
            
            const labelFormats = {
                'herma_4453': { name: 'Herma 4453', width_mm: 99.1, height_mm: 139, cols: 2, rows: 2, top_margin_mm: 10, left_margin_mm: 5.45 },
                'avery_l7165': { name: 'Avery L7165', width_mm: 99.1, height_mm: 67.7, cols: 2, rows: 4, top_margin_mm: 11.1, left_margin_mm: 5.45 },
                'herma_10730': { name: 'Herma 10730', width_mm: 99.1, height_mm: 33.8, cols: 2, rows: 8, top_margin_mm: 10, left_margin_mm: 5.45 },
            };

            let userWaterProfiles = []; // Voor de opgeslagen waterprofielen
            const BUILT_IN_WATER_PROFILES = { // Hernoemd van waterData
                spa: { name: 'Spa Reine', ca: 5, mg: 2, na: 3, so4: 4, cl: 5, hco3: 17 },
                chaudfontaine: { name: 'Chaudfontaine', ca: 65, mg: 18, na: 44, so4: 40, cl: 35, hco3: 305 },
                // ... voeg hier de andere ingebouwde waters toe met een 'name' eigenschap
            };

            // --- Toast Notification Helper ---
            function showToast(message, type = 'info', duration = 4000) {
    let backgroundColor;
    switch(type) {
        case 'success':
            backgroundColor = "linear-gradient(to right, #22c55e, #16a34a)";
            break;
        case 'error':
            backgroundColor = "linear-gradient(to right, #ef4444, #dc2626)";
            break;
        default: // 'info' or any other type
            backgroundColor = "linear-gradient(to right, #3b82f6, #2563eb)";
    }
    Toastify({
        text: message.replace(/\n/g, '<br>'), // Vervang newlines met <br> voor leesbaarheid
        duration: duration, // Gebruik de meegegeven duur
        close: true,
        gravity: "top",
        position: "right",
        stopOnFocus: true,
        escapeMarkup: false, // Sta HTML toe (voor de <br>)
        style: { background: backgroundColor, borderRadius: "8px" }
    }).showToast();
}

            // --- UI Elements ---
            let dashboardMainView, creatorView, brewingView, historyView, inventoryView, 
                planningView, financialsView, socialView, troubleshootView, calculatorsView, 
                waterView, settingsView, brewingMainView, managementMainView, toolsMainView,
                styleSelect, fruitSection, spiceSection, braggotSection, generateBtn, 
                recipeOutput, brewDayContent, historyList, historyDetailContainer, 
                historyListContainer, inventoryForm, inventoryList, fetchWaterProfileBtn, 
                getWaterAdviceBtn, getYeastAdviceBtn, waterSourceSelect, manualWaterProfileDiv,
                troubleshootBtn, apiKeyInput, defaultBatchSizeInput, defaultCurrencyInput, 
                saveSettingsBtn, settingsMessage, themeToggle, exportHistoryBtn, 
                exportInventoryBtn, importHistoryFile, importInventoryFile, 
                clearHistoryBtn, clearInventoryBtn, labelsView, logoUploadInput, labelPreview;

            function handleStyleChange() {
    const style = styleSelect.value.toLowerCase(); // Gebruik toLowerCase() voor zekerheid
    const isMelomel = style.includes('melomel');
    const isMetheglin = style.includes('metheglin');
    const isBraggot = style.includes('braggot');

    fruitSection.classList.toggle('hidden', !isMelomel);
    spiceSection.classList.toggle('hidden', !isMetheglin);
    braggotSection.classList.toggle('hidden', !isBraggot);

    // Reset de vinkjes en velden als de sectie verborgen wordt
    if (!isMelomel) {
        document.querySelectorAll('#fruit-section input:checked').forEach(cb => cb.checked = false);
        const fruitOther = document.getElementById('fruitOther');
        if(fruitOther) fruitOther.value = ''; // Maak ook het 'other' veld leeg
    }
    if (!isMetheglin) {
        document.querySelectorAll('#spice-section input:checked').forEach(cb => cb.checked = false);
        const spiceOther = document.getElementById('spiceOther');
        if(spiceOther) spiceOther.value = ''; // Maak ook het 'other' veld leeg
    }
}

            function handleDescriptionInput() {
                const descriptionInput = document.getElementById('customDescription');
                const optionsContainer = document.getElementById('structured-options-container');
                const warningMessage = document.getElementById('description-priority-warning');
                
                const hasText = descriptionInput.value.trim() !== '';

                // Schakel de container visueel uit of in
                optionsContainer.classList.toggle('opacity-50', hasText);
                optionsContainer.classList.toggle('pointer-events-none', hasText);
                
                // Maak de waarschuwing zichtbaar of onzichtbaar
                warningMessage.classList.toggle('hidden', !hasText);

                // Schakel alle invoervelden in de container daadwerkelijk uit of in
                optionsContainer.querySelectorAll('input, select, checkbox').forEach(el => {
                    // Schakel alles uit, BEHALVE het "useInventory" vinkje
                    if (el.id !== 'useInventory') {
                        el.disabled = hasText;
                    }
                });
            }

            function handleInventoryToggle(e) {
                const useInventory = e.target.checked;
                const helperText = document.getElementById('inventory-helper-text');
                
                // Definieer de velden die we willen uitschakelen
                const fieldsToDisable = [
                    'honeyVariety', 
                    ...document.querySelectorAll('#fruit-section input, #spice-section input')
                ];

                fieldsToDisable.forEach(el => {
                    const element = typeof el === 'string' ? document.getElementById(el) : el;
                    if (element) {
                        element.disabled = useInventory;
                        element.closest('div').classList.toggle('opacity-50', useInventory);
                    }
                });
                
                // Toon of verberg de hulptekst
                helperText.classList.toggle('hidden', !useInventory);
            }

            // --- Functies voor de AI Prompt Modal ---
            window.showLastPrompt = function() {
                const modal = document.getElementById('prompt-modal');
                const content = document.getElementById('prompt-modal-content');
                content.textContent = lastGeneratedPrompt;
                modal.classList.remove('hidden');
            }

            function hidePromptModal() {
                document.getElementById('prompt-modal').classList.add('hidden');
            }

            let dangerAction = null; // Holds the function to execute on confirmation

function showDangerModal(action, confirmationText) {
    dangerAction = action;
    document.getElementById('danger-confirm-text').textContent = confirmationText;
    document.getElementById('danger-confirm-input').value = '';
    document.getElementById('danger-modal').classList.remove('hidden');
    checkDangerConfirmation(); // Initial check
}

function hideDangerModal() {
    document.getElementById('danger-modal').classList.add('hidden');
    dangerAction = null;
}

function checkDangerConfirmation() {
    const input = document.getElementById('danger-confirm-input').value;
    const requiredText = document.getElementById('danger-confirm-text').textContent;
    const confirmBtn = document.getElementById('danger-confirm-btn');

    if (input === requiredText) {
        confirmBtn.disabled = false;
        confirmBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    } else {
        confirmBtn.disabled = true;
        confirmBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }
}

function executeDangerAction() {
    if (typeof dangerAction === 'function') {
        dangerAction();
    }
    hideDangerModal();
}

            async function signInWithGoogle() {
    const provider = new GoogleAuthProvider();
    try {
        await signInWithPopup(auth, provider);
        // De onAuthStateChanged listener zal de rest afhandelen.
    } catch (error) {
        // Log de volledige fout naar de console voor debugging.
        console.error("Google Sign-In failed:", error);

        // Gebruik een simpele alert() als fallback om zeker te weten dat de gebruiker de fout ziet.
        // Dit is handig als de Toastify-bibliotheek niet laadt of een ander probleem heeft.
        alert("Login Mislukt: " + error.message);

        // Probeer de toast-notificatie nog steeds te gebruiken.
        if (typeof showToast === 'function') {
            showToast(`Login failed: ${error.message}`, "error");
        }
    }
}


            function populatePackagingDropdown() {
                const select = document.getElementById('packaging-item-select');
                if (!select) return;

                select.innerHTML = PACKAGING_ITEMS.map(item => 
                   `<option value="${item.id}">${item.name}</option>`
                ).join('');
            }

            window.renderPackagingUI = function() {
                const listContainer = document.getElementById('packaging-list');
                const stockContainer = document.getElementById('packaging-stock-container');
                if (!listContainer || !stockContainer) return;

                // Controleer of er voorraad is
                const hasStock = PACKAGING_ITEMS.some(item => packagingCosts[item.id] && packagingCosts[item.id].qty > 0);

                // Verberg de hele sectie als er geen voorraad is
                stockContainer.classList.toggle('hidden', !hasStock);

                if (hasStock) {
                    // Als er wel voorraad is, bouw dan de lijst op zoals voorheen
                    const currency = userSettings.currencySymbol || '€';
                    listContainer.innerHTML = PACKAGING_ITEMS
                        .filter(item => packagingCosts[item.id] && packagingCosts[item.id].qty > 0)
                        .map(item => {
                            const itemData = packagingCosts[item.id]; // We weten nu zeker dat deze data bestaat
                            const costPerUnit = (itemData.qty > 0 && itemData.price > 0) ? (itemData.price / itemData.qty).toFixed(2) : '0.00';

                            return `
                               <div id="pkg-item-${item.id}" class="p-3 card rounded-md">
                                   <div class="flex justify-between items-center">
                                       <div>
                                           <p class="font-bold">${item.name}</p>
                                           <p class="text-sm text-app-secondary/80">Cost per unit: ${currency}${costPerUnit}</p>
                                       </div>
                                       <div class="flex items-center gap-4">
                                           <span class="font-semibold">${itemData.qty} items - ${currency}${itemData.price.toFixed(2)} total</span>
                                           <div class="flex gap-2">
                                               <button onclick="window.editPackagingItem('${item.id}')" class="text-blue-600 hover:text-blue-800 text-sm">Edit</button>
                                               <button onclick="window.clearPackagingItem('${item.id}')" class="text-red-600 hover:text-red-800 text-sm">Delete</button>
                                           </div>
                                       </div>
                                   </div>
                               </div>
                           `;
                       }).join('');
               } else {
                  listContainer.innerHTML = '';
               }
           }

async function addPackagingStock(e) {
    e.preventDefault();
    if (!userId) return;

    const itemId = document.getElementById('packaging-item-select').value;
    const qtyAdded = parseFloat(document.getElementById('packaging-item-qty').value) || 0;
    const priceAdded = parseFloat(document.getElementById('packaging-item-price').value) || 0;

    if (!itemId || qtyAdded <= 0) {
        showToast("Please fill in a valid material and quantity.", "error");
        return;
    }

    const currentQty = packagingCosts[itemId]?.qty || 0;
    const currentPrice = packagingCosts[itemId]?.price || 0;

    const newQty = currentQty + qtyAdded;
    const newPrice = currentPrice + priceAdded;
    
    packagingCosts[itemId] = { qty: newQty, price: newPrice };
    
    await savePackagingCosts(); 
    
    document.getElementById('packaging-add-form').reset();
}

async function loadPackagingCosts() {
    if (!userId) return;
    const appId = 'meandery-aa05e';
    const settingsDocRef = doc(db, 'artifacts', appId, 'users', userId, 'settings', 'packaging');
    try {
        const docSnap = await getDoc(settingsDocRef);
        if (docSnap.exists()) {
            packagingCosts = docSnap.data();
        } else {
            // Maak een leeg object als er nog geen data is
            packagingCosts = {};
        }
        renderPackagingUI(); // Bouw de UI op met de geladen data
        populatePackagingDropdown();
    } catch (error) {
        console.error("Error loading packaging costs:", error);
    }
}

            // SavePackagingCosts FUNCTIE
async function savePackagingCosts() {
    if (!userId) return;
    const appId = 'meandery-aa05e';
    const settingsDocRef = doc(db, 'artifacts', appId, 'users', userId, 'settings', 'packaging');
    
    try {
        await setDoc(settingsDocRef, packagingCosts);
        showToast('Packaging stock updated successfully!', 'success');
        await loadPackagingCosts();
    } catch (error) {
        console.error("Error saving packaging costs:", error);
        showToast('Failed to save packaging costs.', 'error');
    }
}

// --- NIEUWE FUNCTIES VOOR WATERPROFIELBEHEER ---

// Laadt de profielen van de gebruiker uit Firestore
async function loadUserWaterProfiles() {
    if (!userId) return;
    const appId = 'meandery-aa05e';
    const profilesCol = collection(db, 'artifacts', appId, 'users', userId, 'waterProfiles');
    
    onSnapshot(query(profilesCol), (snapshot) => {
        userWaterProfiles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        populateWaterDropdown();
        renderUserWaterProfilesList();
    });
}

// Vult de dropdown met ingebouwde en eigen profielen
function populateWaterDropdown() {
    const select = document.getElementById('waterSource');
    if (!select) return;
    
    select.innerHTML = `
        <optgroup label="Built-in Profiles">
            ${Object.entries(BUILT_IN_WATER_PROFILES).map(([id, profile]) => `<option value="builtin_${id}">${profile.name}</option>`).join('')}
        </optgroup>
        <optgroup label="My Profiles">
            ${userWaterProfiles.map(profile => `<option value="user_${profile.id}">${profile.name}</option>`).join('')}
        </optgroup>
    `;
}

// Toont de lijst met eigen profielen
function renderUserWaterProfilesList() {
    const listDiv = document.getElementById('user-water-profiles-list');
    if (!listDiv) return;
    if (userWaterProfiles.length === 0) {
        listDiv.innerHTML = `<p class="text-sm text-app-secondary/80 text-center">You have no saved profiles.</p>`;
        return;
    }
    listDiv.innerHTML = userWaterProfiles.map(p => `
        <div class="flex justify-between items-center p-2 card rounded-md text-sm">
            <span>${p.name}</span>
            <div>
                <button onclick="window.editWaterProfile('${p.id}')" class="text-blue-600 hover:text-blue-800">Edit</button>
                <button onclick="window.deleteWaterProfile('${p.id}')" class="text-red-600 hover:text-red-800 ml-2">Delete</button>
            </div>
        </div>
    `).join('');
}

// Slaat een nieuw of bewerkt profiel op
async function saveWaterProfile(e) {
    e.preventDefault();
    if (!userId) return;
    
    const profileId = document.getElementById('water-profile-id').value;
    const profileData = {
        name: document.getElementById('water-profile-name').value,
        ca: parseFloat(document.getElementById('manual_ca').value) || 0,
        mg: parseFloat(document.getElementById('manual_mg').value) || 0,
        na: parseFloat(document.getElementById('manual_na').value) || 0,
        so4: parseFloat(document.getElementById('manual_so4').value) || 0,
        cl: parseFloat(document.getElementById('manual_cl').value) || 0,
        hco3: parseFloat(document.getElementById('manual_hco3').value) || 0,
    };
    if (!profileData.name) {
        showToast("Profile name is required.", "error");
        return;
    }
    
    const appId = 'meandery-aa05e';
    const profilesCol = collection(db, 'artifacts', appId, 'users', userId, 'waterProfiles');
    
    try {
        if (profileId) { // Update
            await setDoc(doc(profilesCol, profileId), profileData);
        } else { // Nieuw
            await addDoc(profilesCol, profileData);
        }
        showToast("Water profile saved!", "success");
        document.getElementById('water-profile-form').reset();
        document.getElementById('water-profile-id').value = '';
    } catch (error) {
        showToast("Error saving profile.", "error");
        console.error(error);
    }
}

// Vult het formulier om een profiel te bewerken
window.editWaterProfile = function(profileId) {
    const profile = userWaterProfiles.find(p => p.id === profileId);
    if (!profile) return;
    document.getElementById('water-profile-id').value = profile.id;
    document.getElementById('water-profile-name').value = profile.name;
    document.getElementById('manual_ca').value = profile.ca;
    document.getElementById('manual_mg').value = profile.mg;
    document.getElementById('manual_na').value = profile.na;
    document.getElementById('manual_so4').value = profile.so4;
    document.getElementById('manual_cl').value = profile.cl;
    document.getElementById('manual_hco3').value = profile.hco3;
    document.getElementById('water-profile-name').focus();
}

// Verwijdert een profiel
window.deleteWaterProfile = async function(profileId) {
    if (!userId || !confirm("Are you sure you want to delete this water profile?")) return;
    try {
        const appId = 'meandery-aa05e';
        await deleteDoc(doc(db, 'artifacts', appId, 'users', userId, 'waterProfiles', profileId));
        showToast("Profile deleted.", "success");
    } catch (error) {
        showToast("Error deleting profile.", "error");
    }
}

// Vind water profielen
async function findWaterProfileWithAI() {
    const searchBtn = document.getElementById('ai-water-search-btn');
    const searchInput = document.getElementById('ai-water-search-name');
    const brandName = searchInput.value;

    if (!brandName.trim()) {
        showToast("Please enter a brand name to search.", "error");
        return;
    }

    searchBtn.disabled = true;
    searchBtn.textContent = '...';

    const prompt = `Find the typical mineral water profile for a brand named "${brandName}". Provide the results for Calcium (ca), Magnesium (mg), Sodium (na), Sulfate (so4), Chloride (cl), and Bicarbonate (hco3) in mg/L. Respond ONLY with a valid JSON object matching the specified schema. If you cannot find the profile, respond with a JSON object where all values are 0.`;
    const schema = {
        type: "OBJECT",
        properties: {
            "ca": { "type": "NUMBER" }, "mg": { "type": "NUMBER" },
            "na": { "type": "NUMBER" }, "so4": { "type": "NUMBER" },
            "cl": { "type": "NUMBER" }, "hco3": { "type": "NUMBER" }
        },
        required: ["ca", "mg", "na", "so4", "cl", "hco3"]
    };

    try {
        const jsonResponse = await performApiCall(prompt, schema);
        const profile = JSON.parse(jsonResponse);

        if (profile.ca === 0 && profile.mg === 0) {
            showToast(`Could not find a profile for "${brandName}".`, 'info');
        } else {
            // Vul het formulier in met de gevonden data
            document.getElementById('water-profile-name').value = brandName;
            document.getElementById('manual_ca').value = profile.ca;
            document.getElementById('manual_mg').value = profile.mg;
            document.getElementById('manual_na').value = profile.na;
            document.getElementById('manual_so4').value = profile.so4;
            document.getElementById('manual_cl').value = profile.cl;
            document.getElementById('manual_hco3').value = profile.hco3;
            showToast(`Profile for "${brandName}" found! Review and save.`, 'success');
        }
    } catch (error) {
        showToast("AI search failed. Please try again.", "error");
        console.error(error);
    } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = 'Find';
    }
}

window.showBrewPrompt = function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew || !brew.prompt) {
        showToast("No prompt was saved for this recipe.", "info");
        return;
    }
    const modal = document.getElementById('prompt-modal');
    const content = document.getElementById('prompt-modal-content');
    content.textContent = brew.prompt;
    modal.classList.remove('hidden');
}

function refreshCurrentChecklistView() {
    // Controleer welke view momenteel zichtbaar is
    const brewDay1View = document.getElementById('brew-day-1-view');
    const brewDay2View = document.getElementById('brew-day-2-view');

    if (brewDay1View && !brewDay1View.classList.contains('hidden')) {
        // We zijn op Brew Day 1, update de UI met de progressiebalk
        currentStepIndex = Object.keys(currentBrewDay.checklist).length;
        updateUI();
    } else if (brewDay2View && !brewDay2View.classList.contains('hidden')) {
        // We zijn op Brew Day 2, herlaad de volledige detailweergave
        window.showBrewDay2Detail(currentBrewDay.brewId);
    }
}

            // --- Initialization ---
            function initApp() {

            // --- Assign UI Elements now that the DOM is loaded ---
            dashboardMainView = document.getElementById('dashboard-main-view');
            creatorView = document.getElementById('creator-view');
            brewingView = document.getElementById('brewing-view');
            historyView = document.getElementById('history-view');
            inventoryView = document.getElementById('inventory-view');
            planningView = document.getElementById('planning-view');
            financialsView = document.getElementById('financials-view');
            socialView = document.getElementById('social-view');
            troubleshootView = document.getElementById('troubleshoot-view');
            calculatorsView = document.getElementById('calculators-view');
            waterView = document.getElementById('water-view');
            settingsView = document.getElementById('settings-main-view');
            brewingMainView = document.getElementById('brewing-main-view');
            managementMainView = document.getElementById('management-main-view');
            toolsMainView = document.getElementById('tools-main-view');
            styleSelect = document.getElementById('style');
            fruitSection = document.getElementById('fruit-section');
            spiceSection = document.getElementById('spice-section');
            braggotSection = document.getElementById('braggot-section');
            generateBtn = document.getElementById('generateBtn');
            recipeOutput = document.getElementById('recipe-output');
            brewDayContent = document.getElementById('brew-day-content');
            historyList = document.getElementById('history-list');
            historyDetailContainer = document.getElementById('history-detail-container');
            historyListContainer = document.getElementById('history-list-container');
            inventoryForm = document.getElementById('inventory-form');
            inventoryList = document.getElementById('inventory-list');
            getWaterAdviceBtn = document.getElementById('getWaterAdviceBtn');
            getYeastAdviceBtn = document.getElementById('getYeastAdviceBtn');
            waterSourceSelect = document.getElementById('waterSource');
            manualWaterProfileDiv = document.getElementById('manualWaterProfile');
            troubleshootBtn = document.getElementById('troubleshoot-btn');
            apiKeyInput = document.getElementById('apiKeyInput');
            defaultBatchSizeInput = document.getElementById('defaultBatchSizeInput');
            defaultCurrencyInput = document.getElementById('defaultCurrencyInput');
            saveSettingsBtn = document.getElementById('saveSettingsBtn');
            settingsMessage = document.getElementById('settingsMessage');
            themeToggle = document.getElementById('theme-toggle-checkbox');
            exportHistoryBtn = document.getElementById('exportHistoryBtn');
            exportInventoryBtn = document.getElementById('exportInventoryBtn');
            importHistoryFile = document.getElementById('importHistoryFile');
            importInventoryFile = document.getElementById('importInventoryFile');
            clearHistoryBtn = document.getElementById('clearHistoryBtn');
            clearInventoryBtn = document.getElementById('clearInventoryBtn');
            labelsView = document.getElementById('labels-view');
            logoUploadInput = document.getElementById('logoUpload');
            labelPreview = document.getElementById('label-preview');

                document.getElementById('google-login-btn').addEventListener('click', signInWithGoogle);

                onAuthStateChanged(auth, async (user) => {
    const loginView = document.getElementById('login-view');
    // AANGEPAST: We verwijzen naar de container van de hele app, niet alleen het dashboard.
    // Dit zorgt ervoor dat de header en andere elementen ook correct getoond/verborgen worden.
    const appContainer = document.querySelector('.container.mx-auto'); 

    if (user && !user.isAnonymous) {
        // Gebruiker is succesvol ingelogd met Google
        userId = user.uid;

        // 1. VERBERG HET LOGIN-SCHERM ONMIDDELLIJK en toon de app
        loginView.classList.add('hidden');
        if (appContainer) appContainer.classList.remove('hidden'); // Toon de app

        // 2. LAAD VERVOLGENS VEILIG DE DATA
        // Een try...catch blok vangt fouten op zonder de hele app te laten crashen.
        // Promise.all() laadt alles tegelijk voor betere prestaties.
        try {
            await Promise.all([
                loadHistory(),
                loadInventory(),
                loadEquipmentProfiles(),
                loadCellar(),
                loadUserSettings(),
                loadPackagingCosts(),
                loadUserWaterProfiles()
            ]);
        } catch (error) {
            console.error("Fout bij het laden van de gebruikersdata:", error);
            // Toon een duidelijke foutmelding aan de gebruiker
            showToast("Kon niet alle gegevens laden. Probeer de pagina te vernieuwen.", "error", 6000);
        }

    } else {
        // Geen gebruiker of anonieme gebruiker -> toon login-scherm
        loginView.classList.remove('hidden');
        if (appContainer) appContainer.classList.add('hidden'); // Verberg de app

        // Log eventuele anonieme of onbekende gebruikers uit
        if (user && user.isAnonymous) {
            auth.signOut();
        }
    }
});
    
    // --- Event Listeners ---
    document.getElementById('packaging-add-form').addEventListener('submit', addPackagingStock);
    document.getElementById('danger-cancel-btn').addEventListener('click', hideDangerModal);
    document.getElementById('danger-confirm-btn').addEventListener('click', executeDangerAction);
    document.getElementById('danger-confirm-input').addEventListener('input', checkDangerConfirmation);
    document.getElementById('customDescription').addEventListener('input', handleDescriptionInput);
    document.getElementById('close-prompt-modal-btn').addEventListener('click', hidePromptModal);
    document.getElementById('water-profile-form').addEventListener('submit', saveWaterProfile);
    document.getElementById('waterSource').addEventListener('change', handleWaterSourceChange);
    document.getElementById('ai-water-search-btn').addEventListener('click', findWaterProfileWithAI);
    document.getElementById('prompt-modal').addEventListener('click', function(e) {
        if (e.target.id === 'prompt-modal') {
            hidePromptModal();
        }
    });
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
    document.getElementById('honeyVariety').addEventListener('change', (e) => {
    document.getElementById('honeyVarietyOther').classList.toggle('hidden', e.target.value !== 'other');
    });

    setupBrewDayEventListeners();
    styleSelect.addEventListener('change', handleStyleChange);
    generateBtn.addEventListener('click', generateRecipe);
    inventoryForm.addEventListener('submit', addInventoryItem);
    document.getElementById('equipment-profile-form').addEventListener('submit', addEquipmentProfile);
    document.getElementById('equipProfileType').addEventListener('change', handleEquipmentTypeChange);
    document.getElementById('bottling-form').addEventListener('submit', bottleBatch);
    document.getElementById('scan-barcode-btn').addEventListener('click', startScanner);
    document.getElementById('close-scanner-btn').addEventListener('click', stopScanner);
    document.getElementById('useInventory').addEventListener('change', (e) => {
                document.getElementById('budget-section').classList.toggle('hidden', !e.target.checked);
                handleInventoryToggle(e);
            });
    document.getElementById('useBudget').addEventListener('change', (e) => {
        document.getElementById('budget-input-container').classList.toggle('hidden', !e.target.checked);
    });

    // Calculator buttons
    document.getElementById('calcAbvBtn').addEventListener('click', calculateABV);
    document.getElementById('correctSgBtn').addEventListener('click', correctHydrometer);
    document.getElementById('calcSugarBtn').addEventListener('click', calculatePrimingSugar);
    document.getElementById('calcBlendBtn').addEventListener('click', calculateBlend);
    document.getElementById('calcBacksweetenBtn').addEventListener('click', calculateBacksweetening);
    document.getElementById('calcDilutionBtn').addEventListener('click', calculateDilution);
    document.getElementById('calcTosnaBtn').addEventListener('click', calculateTOSNA);
    getYeastAdviceBtn.addEventListener('click', getYeastAdvice);

    // Manual social post button
    document.getElementById('generate-manual-social-btn').addEventListener('click', runManualSocialMediaGenerator);
    document.getElementById('generate-social-from-recipe-btn').addEventListener('click', runSocialMediaGenerator);
    
    // Water tab buttons
    waterSourceSelect.addEventListener('change', handleWaterSourceChange);
    getWaterAdviceBtn.addEventListener('click', getWaterAdvice);

    // Settings
    saveSettingsBtn.addEventListener('click', saveUserSettings);
    themeToggle.addEventListener('change', (e) => applyTheme(e.target.checked ? 'dark' : 'light'));
    exportHistoryBtn.addEventListener('click', exportHistory);
    exportInventoryBtn.addEventListener('click', exportInventory);
    importHistoryFile.addEventListener('change', importHistory);
    importInventoryFile.addEventListener('change', importInventory);
    clearHistoryBtn.addEventListener('click', clearHistory);
    clearInventoryBtn.addEventListener('click', clearInventory);
    
    // Troubleshoot
    troubleshootBtn.addEventListener('click', getTroubleshootingAdvice);
    
            // Label Generator Listeners
            document.getElementById('logoUpload').addEventListener('change', handleLogoUpload);
            document.getElementById('removeLogoBtn').addEventListener('click', removeLogo);
            document.getElementById('labelRecipeSelect').addEventListener('change', handleLabelRecipeSelect);
            document.querySelectorAll('.label-style-btn').forEach(btn => btn.addEventListener('click', () => switchLabelStyle(btn.dataset.style)));
            document.getElementById('generate-print-btn').addEventListener('click', generatePrintPage);
            document.querySelectorAll('.orientation-btn').forEach(btn => {
                btn.addEventListener('click', () => setLabelOrientation(btn.dataset.orientation));
            });
            
            ['labelStyle', 'labelAbv', 'labelVol', 'labelDate'].forEach(id => {
                const element = document.getElementById(id);
                if (element) {
                    element.addEventListener('keyup', updateLabelPreview);
                }
            });

            const formatSelect = document.getElementById('labelFormatSelect');
            if (formatSelect) {
                formatSelect.addEventListener('change', (e) => {
                    document.getElementById('custom-format-inputs').classList.toggle('hidden', e.target.value !== 'custom');
                    updatePreviewAspectRatio(); // Update aspect ratio bij wijziging
                });
            }

            // Listeners voor custom formaat inputs
            ['customWidth', 'customHeight', 'customCols', 'customRows', 'customMarginTop', 'customMarginLeft'].forEach(id => {
                const input = document.getElementById(id);
                if(input) {
                    input.addEventListener('input', updatePreviewAspectRatio);
                }
            });

    handleStyleChange();
    }

            // --- View Management ---
            function switchMainView(viewName) {
                if (window.hideBottlingModal) hideBottlingModal();
                
                [dashboardMainView, brewingMainView, managementMainView, toolsMainView, settingsView].forEach(v => v.classList.add('hidden'));
                
                const viewToShow = document.getElementById(`${viewName}-main-view`);

                if (viewToShow) {
                    viewToShow.classList.remove('hidden');

                    if (viewName === 'brewing') {
                        populateEquipmentProfilesDropdown();
                    }
                }
            }

            window.switchSubView = function(viewName, parentViewId) {
    const parentView = document.getElementById(parentViewId);
    parentView.querySelectorAll('[id$="-view"]').forEach(v => v.classList.add('hidden'));
    parentView.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));

    const viewId = `${viewName}-view`;
    const tabId = `${viewName}-sub-tab`;

    const viewToShow = document.getElementById(viewId);
    const tabToActivate = document.getElementById(tabId);

    if (viewToShow) viewToShow.classList.remove('hidden');
    // --- ADDED CODE ---
    // If we are showing the history view, attach the search listener
    if (viewName === 'history') {
        const historySearchInput = document.getElementById('history-search-input');
        if (historySearchInput && !historySearchInput.hasAttribute('data-listener-added')) { // Check if listener already added
            historySearchInput.addEventListener('input', renderHistoryList);
            historySearchInput.setAttribute('data-listener-added', 'true'); // Mark as added
        }
    }
    // --- END ADDED CODE ---
    if (tabToActivate) tabToActivate.classList.add('active');

    if (viewName === 'brew-day-2') {
        renderBrewDay2();
    }

    if (viewName === 'creator') {
        populateEquipmentProfilesDropdown();
    } 
    if (viewName === 'social') {
        populateSocialRecipeDropdown();
    }
    if (viewName === 'labels') {
        populateLabelRecipeDropdown();
        updatePreviewAspectRatio();
    }
}

            // --- Settings Management (Firebase) ---
            async function loadUserSettings() {
    if (!userId) return;
    const appId = 'meandery-aa05e';
    const settingsDocRef = doc(db, 'artifacts', appId, 'users', userId, 'settings', 'main');
    
    try {
        const docSnap = await getDoc(settingsDocRef);
        if (docSnap.exists()) {
            userSettings = docSnap.data();
            currentBrewDay = userSettings.currentBrewDay || { brewId: null, checklist: {} };
            if(currentBrewDay.brewId) {
               renderBrewDay(currentBrewDay.brewId);
            }
        } else {
            // Voeg de nieuwe imageApiKey toe aan de standaardinstellingen
            userSettings = { apiKey: '', imageApiKey: '', defaultBatchSize: 5, currencySymbol: '€', theme: 'light' };
        }
        applySettings();
    } catch (error) {
        console.error("Error loading user settings:", error);
    }
}
            
            function applySettings() {
    apiKeyInput.value = userSettings.apiKey || '';
    document.getElementById('imageApiKeyInput').value = userSettings.imageApiKey || '';
    
    // Set the placeholder for the main batch size input, don't pre-fill it.
    const batchSizeInput = document.getElementById('batchSize');
    if (batchSizeInput) {
        batchSizeInput.placeholder = userSettings.defaultBatchSize || 5;
    }

    defaultBatchSizeInput.value = userSettings.defaultBatchSize || 5;
    defaultCurrencyInput.value = userSettings.currencySymbol || '€';
    themeToggle.checked = (userSettings.theme === 'dark');
                
                const priceLabel = document.querySelector('label[for="itemPrice"]');
                if(priceLabel) {
                    priceLabel.textContent = `Price (${userSettings.currencySymbol || '€'})`;
                }
                
                applyTheme(userSettings.theme);
            }

            async function saveUserSettings() {
    if (!userId) return;
    const appId = 'meandery-aa05e';
    const settingsDocRef = doc(db, 'artifacts', appId, 'users', userId, 'settings', 'main');
    
    // Voeg de nieuwe imageApiKey toe aan de op te slagen data
    const newSettings = {
        apiKey: document.getElementById('apiKeyInput').value.trim(),
        imageApiKey: document.getElementById('imageApiKeyInput').value.trim(), // NIEUW
        defaultBatchSize: parseFloat(defaultBatchSizeInput.value) || 5,
        currencySymbol: defaultCurrencyInput.value.trim() || '€',
        theme: themeToggle.checked ? 'dark' : 'light',
        currentBrewDay: currentBrewDay
    };
    try {
        await setDoc(settingsDocRef, newSettings, { merge: true });
        userSettings = newSettings;
        applySettings();
        showToast('Settings saved successfully!', 'success');
    } catch (error) {
        console.error("Error saving settings:", error);
        showToast('Failed to save settings.', 'error');
    }
}

// Slaat enkel de voortgang van de checklist op, zonder de verkeerde toast-melding.
async function saveChecklistState() {
    if (!userId) return;
    const appId = 'meandery-aa05e';
    const settingsDocRef = doc(db, 'artifacts', appId, 'users', userId, 'settings', 'main');
    try {
        // Update enkel het currentBrewDay veld, en laat de rest van de settings met rust.
        await updateDoc(settingsDocRef, { currentBrewDay: currentBrewDay });
    } catch (error) {
        console.error("Error saving checklist state:", error);
        showToast('Failed to save progress.', 'error');
    }
}

            function applyTheme(theme) {
                if (theme === 'dark') {
                    document.documentElement.classList.add('dark');
                } else {
                    document.documentElement.classList.remove('dark');
                }
            }

            // --- Data Management Functions ---
            function exportData(data, filename) {
                const dataToExport = data.map(item => {
                    const newItem = {...item};
                    // Convert Firestore Timestamps to a serializable format
                    if (newItem.createdAt && typeof newItem.createdAt.toDate === 'function') {
                        newItem.createdAt = newItem.createdAt.toDate().toISOString();
                    }
                    return newItem;
                });
                const jsonStr = JSON.stringify(dataToExport, null, 2);
                const blob = new Blob([jsonStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }

            function exportHistory() {
                exportData(brews, 'meandery_history_export.json');
            }

            function exportInventory() {
                exportData(inventory, 'meandery_inventory_export.json');
            }

            function importData(event, collectionName) {
                const file = event.target.files[0];
                if (!file) return;
                
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const data = JSON.parse(e.target.result);
                        if (!Array.isArray(data)) throw new Error("Invalid JSON format. Expected an array.");

                        if (!confirm(`This will OVERWRITE your current ${collectionName}. This cannot be undone. Are you sure?`)) return;

                        showToast(`Importing ${collectionName}...`);
                        const appId = 'meandery-aa05e';
                        const collectionRef = collection(db, 'artifacts', appId, 'users', userId, collectionName);
                        
                        await clearCollection(collectionName, false);

                        const batch = writeBatch(db);
                        data.forEach(item => {
                            const { id, ...itemData } = item;
                            if (itemData.createdAt && typeof itemData.createdAt === 'string') {
                                itemData.createdAt = new Date(itemData.createdAt);
                            }
                            const newDocRef = doc(collectionRef);
                            batch.set(newDocRef, itemData);
                        });
                        await batch.commit();
                        showToast(`${collectionName} imported successfully!`, 'success');
                    } catch (error) {
                        console.error(`Error importing ${collectionName}:`, error);
                        showToast(`Error: ${error.message}`, 'error');
                    } finally {
                        event.target.value = '';
                    }
                };
                reader.readAsText(file);
            }

            function importHistory(e) {
                importData(e, 'brews');
            }

            function importInventory(e) {
                importData(e, 'inventory');
            }

            async function clearCollection(collectionName, confirmFirst = true) {
    if (confirmFirst && !confirm(`DANGER: This will permanently delete all your ${collectionName}. This cannot be undone. Are you sure?`)) {
        return false;
                }
                if (!userId) return false;
                const appId = 'meandery-aa05e';
                const collectionRef = collection(db, 'artifacts', appId, 'users', userId, collectionName);
                const snapshot = await getDocs(collectionRef);
                if (snapshot.empty) return true; // Nothing to delete
                const batch = writeBatch(db);
                snapshot.docs.forEach(doc => {
                    batch.delete(doc.ref);
                });
                await batch.commit();
                return true;
            }

            async function clearHistory() {
    const action = async () => {
        if (await clearCollection('brews', false)) { // 'false' to skip the old confirm
            showToast('Brew history cleared.', 'success');
        }
    };
    showDangerModal(action, "DELETE HISTORY");
}

async function clearInventory() {
    const action = async () => {
        if (await clearCollection('inventory', false)) { // 'false' to skip the old confirm
            showToast('Inventory cleared.', 'success');
        }
    };
    showDangerModal(action, "DELETE INVENTORY");
}

            // --- Core AI Functions ---
            async function performApiCall(prompt, schema = null) {
    const apiKey = userSettings.apiKey;
    if (!apiKey) {
        throw new Error("Please enter your Google AI API key in the Settings page first.");
    }
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    
    let chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
    const payload = { contents: chatHistory };

    if (schema) {
        payload.generationConfig = {
            responseMimeType: "application/json",
            responseSchema: schema
        };
    }

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorBody = await response.json();
        const errorMessage = errorBody?.error?.message || `API request failed with status ${response.status}`;
        throw new Error(errorMessage);
    }
    
    const result = await response.json();

    if (result.candidates && result.candidates[0].content && result.candidates[0].content.parts) {
        return result.candidates[0].content.parts[0].text;
    } else {
        throw new Error("Invalid response structure from API.");
    }
}

            function parseRecipeData(markdown) {
    console.log("--- Entering parseRecipeData ---"); // ENTRY LOG
    const data = {};
    try {
        const titleMatch = markdown.match(/^#\s*(.*)/m);
        if (titleMatch && titleMatch[1]) { data.recipeName = titleMatch[1].trim(); }
        console.log("parseRecipeData - Found Title:", data.recipeName);

        const ogMatch = markdown.match(/(?:Target OG|Original Gravity|Start SG|O\.G\.|OG)\s*:\s*~?\s*([\d.,]+)/i);
        if (ogMatch && ogMatch[1]) { data.targetOG = ogMatch[1]; }
        console.log("parseRecipeData - Found OG:", data.targetOG, "Match:", ogMatch);

        const fgMatch = markdown.match(/(?:Target FG|Final Gravity|Eind SG|F\.G\.|FG)\s*:\s*~?\s*([\d.,]+)/i);
        if (fgMatch && fgMatch[1]) { data.targetFG = fgMatch[1]; }
        console.log("parseRecipeData - Found FG:", data.targetFG, "Match:", fgMatch);

        const abvMatch = markdown.match(/(?:Target ABV|ABV|Alcoholpercentage)\s*:\s*~?\s*([\d.,]+)\s*%/i);
        if (abvMatch && abvMatch[1]) { data.targetABV = abvMatch[1]; }
        console.log("parseRecipeData - Found ABV:", data.targetABV, "Match:", abvMatch);

    } catch (e) {
        console.error("!!! Error during parseRecipeData regex matching:", e); // CATCH BLOCK
    }
    console.log("--- Exiting parseRecipeData ---"); // EXIT LOG
    return data;
}

async function generateRecipe() {
    recipeOutput.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">Your buddy is thinking ... relax while your custom recipe is being crafted.</p>';
    generateBtn.disabled = true;
    generateBtn.classList.add('opacity-50', 'cursor-not-allowed');
    currentPredictedProfile = null;

    try {
        const prompt = buildPrompt();
        lastGeneratedPrompt = prompt;
        currentRecipeMarkdown = await performApiCall(prompt);
        
        currentPredictedProfile = await getPredictedFlavorProfile(currentRecipeMarkdown); 
        
        let flavorProfileHtml = `
            <div id="flavor-profile-section" class="mt-8 pt-6 border-t border-app">
                <h3 class="text-2xl font-header font-bold text-center mb-4">Predicted Flavor Profile</h3>
        `;

        if (currentPredictedProfile) {
            // Gelukt: toon de canvas
            flavorProfileHtml += `
                <div class="card p-4 rounded-lg max-w-sm mx-auto">
                    <canvas id="generated-flavor-wheel"></canvas>
                </div>
            `;
        } else {
            // Mislukt: toon de knop
             flavorProfileHtml += `
                <div class="card p-4 rounded-lg max-w-sm mx-auto text-center">
                    <p class="text-app-secondary/80 text-sm mb-4">Could not generate profile initially. Try again?</p>
                    <button id="retry-flavor-btn" onclick="window.regenerateFlavorProfile()" class="bg-purple-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-purple-700 btn">
                        Generate Profile
                    </button>
                    <div id="flavor-generation-status" class="mt-2 text-sm"></div> 
                </div>
            `;
        }
        flavorProfileHtml += `</div>`; // Sluit de section div
        
        let finalMarkdown = currentRecipeMarkdown;
        const jsonRegex = /(?:```json\s*([\s\S]*?)\s*```|(\[\s*\{[\s\S]*?\}\s*\]))/;
        const jsonMatch = currentRecipeMarkdown.match(jsonRegex);
        let tableMarkdown = ''; // Initialize tableMarkdown

        if (jsonMatch && (jsonMatch[1] || jsonMatch[2])) {
            const jsonString = jsonMatch[1] || jsonMatch[2];
            try {
                // *** TRY TO PARSE ***
                const ingredientsArray = JSON.parse(jsonString);
                tableMarkdown = '| Ingredient | Quantity | Unit |\n';
                tableMarkdown += '|---|---|---|\n';
                ingredientsArray.forEach(item => {
                    let displayQty = item.quantity;
                    let displayUnit = item.unit;

                    // Unit conversion logic...
                    if ((displayUnit || '').toLowerCase() === 'g' && displayQty >= 1000) {
                        displayQty /= 1000; displayUnit = 'kg';
                    } else if ((displayUnit || '').toLowerCase() === 'ml' && displayQty >= 1000) {
                        displayQty /= 1000; displayUnit = 'L';
                    }
                    if (displayQty % 1 !== 0) { displayQty = parseFloat(displayQty.toFixed(2)); }

                    tableMarkdown += `| ${item.ingredient} | ${displayQty} | ${displayUnit} |\n`;
                });
                // Replace the JSON block with the generated table
                finalMarkdown = currentRecipeMarkdown.replace(jsonRegex, tableMarkdown);

            } catch (e) {
                // *** CATCH PARSING ERRORS ***
                console.error("Failed to parse ingredients JSON from AI response:", e);
                // Create an error message instead of a table
                tableMarkdown = `\n**Error:** Could not display ingredients. The AI provided invalid data.\n`;
                // Replace the JSON block with the error message
                finalMarkdown = currentRecipeMarkdown.replace(jsonRegex, tableMarkdown);
            }
        } else {
            console.warn("Could not find ingredients JSON block in AI response.");
            // Optional: You could add a message here too if the JSON block is completely missing
        }

        finalMarkdown = finalMarkdown.replace(/\[d:[\d:]+\]/g, '');
        const recipeHtml = marked.parse(finalMarkdown);
        
        const fullHtml = `
            <div class="print-button-container text-right mb-4 flex justify-end flex-wrap gap-2 no-print">
                <button onclick="window.showLastPrompt()" class="bg-indigo-600 text-white py-2 px-4 rounded-lg hover:bg-indigo-700 transition-colors btn text-sm">
                    Show AI Prompt
                </button>
                <button onclick="window.print()" class="bg-stone-600 text-white py-2 px-4 rounded-lg hover:bg-stone-700 transition-colors btn">
                    Print Recipe
                </button>
            </div>
            <div class="recipe-content">${recipeHtml}</div>
            ${flavorProfileHtml}
            <div class="mt-6 no-print">
                <button id="saveBtn" class="w-full bg-green-700 text-white font-bold py-3 px-4 rounded-lg hover:bg-green-800 transition-colors btn">
                    Save to Brew History
                </button>
            </div>
        `;
        recipeOutput.innerHTML = fullHtml;

        if (currentPredictedProfile) {
            renderGeneratedFlavorWheel(currentPredictedProfile);
        }

        document.getElementById('saveBtn').addEventListener('click', saveBrewToHistory);

    } catch (error) {
        console.error("Error calling Gemini API:", error);
        recipeOutput.innerHTML = `<p class="text-center text-red-600 font-bold">Sorry, your buddy is busy. Please try again.</p><p class="text-center text-sm text-app-secondary/80">${error.message}</p>`;
    } finally {
        generateBtn.disabled = false;
        generateBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
}          

function buildPrompt() {
    try {
        const batchSize = document.getElementById('batchSize').value || '5';
        const yeastInInventory = inventory.filter(i => i.category === 'Yeast').map(i => i.name).join(', ') || 'None available';
        const nutrientsInInventory = inventory.filter(i => i.category === 'Nutrient').map(i => i.name).join(', ') || 'None available';
        
        const availableFermenters = equipmentProfiles
            .filter(p => p.type === 'Fermenter' && p.capacityLiters)
            .map(p => `${p.name} (${p.capacityLiters}L total capacity, ${p.trubLossLiters || 0}L loss)`)
            .join('; ');

        let basePrompt = `You are an award-winning mead maker and logistics expert named "MEA(N)DERY". Your primary goal is to create a practical, world-class, feasible recipe that fits the user's equipment.

**WORLD-CLASS RECIPE PHILOSOPHY:**
1.  **Time-Based Design:** If the user's request includes a timeline (e.g., "ready by Spring 2026"), this becomes a **primary design goal**. You MUST actively choose ingredients and techniques (yeast strain, fining agents, tannin levels) that allow the mead to mature and be ready by that date. You MUST explain these choices in the "Cellaring Note".
2.  **Balance & Synergy:** In the "## Description", you MUST explain the intended balance and the synergy between at least two key ingredients.
3.  **Process & Clarity:** The "## Instructions" MUST include best practices for achieving a clear final product and specify ideal fermentation temperature ranges.
4.  **Brewer's Notes - Rationale (MANDATORY FORMATTING):** The "## Brewer's Notes" section MUST contain the specified bolded sub-topics below.
    - **Crucial Formatting:**
        - Each topic MUST start on a **completely new paragraph**. You MUST insert a **full blank line** before starting the next topic's paragraph.
        - The bolded title AND its explanation text MUST appear on the **exact same line**, separated by a colon and a space.
        - Do NOT use any list formatting (like dashes or bullets).
    - **Required Topics:**
        - **Honey Choice:** Justify the specific honey variety selected.
        - **Yeast Choice:** Justify the specific yeast strain selected, comparing it to the ideal if different.
        - **Nutrient Schedule:** Justify the chosen nutrient schedule, comparing it to the ideal if different.
        - **Cellaring Note:** Provide a cellaring guideline that is consistent with the Time-Based Design goal if one was provided.
        - **Food Pairing:** Suggest at least two food pairings.
    **Example of CORRECT format:**

    **Honey Choice:** Wildflower was chosen for its balanced profile...

    **Yeast Choice:** Lalvin 71B was selected because it enhances fruity esters...

    **Nutrient Schedule:** A staggered nutrient addition using Fermaid K...

    **Cellaring Note:** This mead should peak within 1-2 years...

    **Food Pairing:** Pairs well with aged cheddar or spicy dishes...

**CRUCIAL EQUIPMENT & VOLUME LOGIC (MUST FOLLOW IN ORDER):**
1.  **Determine Target Size (Hierarchy of Goals):**
    -   **Priority 1 (User Specified Volume):** If the user's free-text description explicitly mentions a target volume (e.g., "make a 10 liter mead"), you MUST use that as your goal.
    -   **Priority 2 (User Specified Ingredients):** If the description provides constraints on key ingredients (e.g., "use max 2kg honey", "use 3kg plums") but NOT a volume, your goal is to determine the **OPTIMAL BATCH SIZE** to create a world-class recipe with those ingredients.
    -   **Priority 3 (Default):** If neither of the above applies, use the default target of **${batchSize} liters**.
2.  **Design Initial Recipe & Calculate Volume:** Based on the determined target size, design the recipe and calculate the **Total Required Fermenter Volume** (liquids + solids displacement).
3.  **Feasibility Check & Selection:** Check if the recipe fits in the available fermenters: [${availableFermenters}]. If it fits, select the best one (prioritizing wide-mouth for fruit).
4.  **Fallback (Scale Down):** If the initial design does not fit in any available fermenter, you MUST **SCALE DOWN THE ENTIRE RECIPE** until it fits in the largest available fermenter with adequate headspace.
5.  **Communicate:** In the "Brewer's Notes", "Key Stats", and "Selected Fermenter" sections, you MUST clearly state the final batch size and the chosen fermenter, and explain if/why you scaled the recipe down.

**CRUCIAL TITLE RULE: You are a branding expert, not just a writer.**
Your primary task is to invent a captivating name that stands out. Follow this exact thought process:
1.  **Analyze the Recipe:** Look at the core ingredients, style, and potential flavor profile.
2.  **Choose a Creative Style:** Select ONE of the following three styles for the name:
    -   **Style A (Clever & Witty):** A smart pun or wordplay related to the ingredients or mead making.
    -   **Style B (Modern & Evocative):** A short, powerful, and elegant name, often combining two concepts (e.g., ingredients, textures, colors). This style is simple and confident.
    -   **Style C (The Craft & Technique):** The name is a direct reference to a crucial technique or process detail in the recipe. It's a confident name that highlights the craftsmanship (e.g., caramelization level, a specific yeast action, aging method).
3.  **Invent a Name:** Create a unique name that perfectly fits the chosen style.
4.  **HARD CONSTRAINTS:**
    -   The title **MUST NOT** be a simple list of ingredients (e.g., "Plum & Almond Mead").
    -   The title **MUST NOT** use generic, "hippie" or cheesy words like 'Delight', 'Kiss', 'Symphony', 'Embrace', 'Nectar', or 'Elixir'.
5.  **Examples of EXCELLENT Titles (by Style):**
    -   **Style A (Witty):** '# Berry Manilow: A Mixed Berry Melomel'
    -   **Style B (Modern):** '# Oak & Ember: A Dark Caramel Bochet'
    -   **Style C (The Craft):** '# The Third Scorch: A Dark Caramel Bochet'

**FORMAT:** The title MUST be the very first line, formatted as a Markdown H1 heading (e.g., '# Invented Name: A Brief Description'). Do NOT use square brackets [].

Your response MUST be structured with the following headings in this exact order:
## Description
## Key Stats
## Fermenter
## Ingredients
## Instructions
## Brewer's Notes
## Recommended Water

**ADVANCED LOGIC & SUBSTITUTION RULES (YOU MUST FOLLOW THESE):**
1.  **Recipe Inspiration:** The "## Description" section MUST begin with a single sentence explaining the recipe's inspiration. This sentence MUST be a standalone paragraph. You MUST insert a full blank line after it before the main description begins. Do NOT use italics.
2.  **Yeast Logic:** Determine the ideal yeast for a world-class version of this recipe. Then, check the user's inventory: [${yeastInInventory}]. You MUST use a suitable yeast from the inventory. In "## Brewer's Notes", under **"Ingredient Rationale:"**, you MUST state if the chosen inventory yeast was the ideal choice. If not, you MUST specify which yeast you would have preferred and why.
3.  **Nutrient Logic:** First, as an expert, determine the **best nutrient schedule**. You MUST use nutrients from inventory: [${nutrientsInInventory}]. In "## Brewer's Notes", explain if the schedule is optimal. 
4.  **Water Choice:** In "## Recommended Water", recommend a specific Belgian bottled water and explain your choice.
5.  **Key Stats Section:** This sections is MANDATORY. 
    - "## Key Stats" must contain the OG, FG, ABV, and Final Batch Size.
    **Example of CORRECT format:**

    OG: 1.110

    FG: 1.030

    ABV: 10.5%

    Final Batch Size: 5 Liters
6.  **Fermenter:** Must contain ONLY the name of the chosen fermenter. This sections is MANDATORY.
7.  **Brewer's Notes Structure:** The "## Brewer's Notes" section MUST use bolded titles on the same line as the text, followed by a colon (e.g., "**Ingredient Rationale:** ..."). This is mandatory for correct formatting.

Now, generate the recipe based on the following user request:
---`;
        
        let creativeBrief = ''; 
        const inventoryString = inventory.map(item => `${item.name}: ${item.qty} ${item.unit}`).join('; ');
        
        const customDescription = document.getElementById('customDescription').value;
        const useInventory = document.getElementById('useInventory').checked;

        if (customDescription.trim() !== '') {
            creativeBrief += `The user's request is a free-text description: "${customDescription}". Prioritize using ingredients from their inventory if suitable: [${inventoryString}].`;
        } else if (useInventory) {
            const currency = userSettings.currencySymbol || '€';
            const useBudget = document.getElementById('useBudget').checked;
            const maxBudget = document.getElementById('maxBudget').value;
            const richInventoryString = inventory.map(item => {
                let costPerUnit = 0; let baseUnit = item.unit; if (item.qty > 0 && item.price > 0) { costPerUnit = item.price / item.qty; } if (item.unit === 'kg') { costPerUnit /= 1000; baseUnit = 'g'; } else if (item.unit === 'L') { costPerUnit /= 1000; baseUnit = 'ml'; }
                return `${item.name}: ${item.qty} ${item.unit} available (Cost: ${costPerUnit.toFixed(2)} ${currency}/${baseUnit})`;
            }).join('; ');
            
            creativeBrief += `The user wants a recipe created from their inventory: [${richInventoryString}]. Use these parameters as guidelines:\n- Target ABV: Approximately ${document.getElementById('abv').value || '12'}%\n- Final Sweetness: ${document.getElementById('sweetness').selectedOptions[0].text}\n- Style Inspiration: ${document.getElementById('style').selectedOptions[0].text}`;
            
            if (useBudget && maxBudget) {
                creativeBrief += `\n\nCRUCIAL CONSTRAINT: The total cost of the ingredients for this recipe MUST NOT EXCEED ${maxBudget} ${currency}. You must use the provided ingredient costs to calculate this and stay within budget. In the Brewer's Notes, state the calculated total cost.`;
            }
        } else {
            const style = document.getElementById('style').selectedOptions[0].text;
            let honeyValue = document.getElementById('honeyVariety').options[document.getElementById('honeyVariety').selectedIndex].text;
            const honeySelectValue = document.getElementById('honeyVariety').value;
            if (honeySelectValue === 'other') { const otherHoney = document.getElementById('honeyVarietyOther').value; if(otherHoney) honeyValue = otherHoney; }

            creativeBrief += `The user wants a recipe from scratch with these options:\n- Target ABV: Approximately ${document.getElementById('abv').value || '12'}%\n- Final Sweetness: ${document.getElementById('sweetness').selectedOptions[0].text}\n- Style Inspiration: ${style}\n- Primary Honey: ${honeyValue}`;
            if (style.includes('Melomel')) {
                const fruits = Array.from(document.querySelectorAll('#fruit-section input[type=checkbox]:checked')).map(el => el.labels[0].innerText);
                const otherFruits = document.getElementById('fruitOther').value.split(',').map(f => f.trim()).filter(f => f);
                creativeBrief += `\n- Featured Fruits: ${[...fruits, ...otherFruits].join(', ') || 'Suggest a classic combination.'}`;
            } else if (style.includes('Metheglin')) {
                const spices = Array.from(document.querySelectorAll('#spice-section input[type=checkbox]:checked')).map(el => el.labels[0].innerText);
                const otherSpices = document.getElementById('spiceOther').value.split(',').map(s => s.trim()).filter(s => s);
                creativeBrief += `\n- Featured Spices: ${[...spices, ...otherSpices].join(', ') || 'Suggest a classic blend.'}`;
            }
            if (style.toLowerCase().includes('bochet')) {
                creativeBrief += `\n- Bochet Method: You MUST recommend the best method for caramelizing the honey and provide detailed, safe instructions.`;
            }
            if (style.includes('Braggot')) {
                creativeBrief += `\n- Braggot Base: Based on a ${document.getElementById('braggotStyle').value} style. Provide an extract-based recipe.`;
            }
            if (document.getElementById('addOak').checked) {
                creativeBrief += '\n- Oak Aging: The recipe must include a step for aging with oak.';
            }
            const specialIngredients = document.getElementById('specialIngredients').value;
            if (specialIngredients && specialIngredients.trim() !== '') {
                creativeBrief += `\n- Special Ingredients: The recipe must creatively incorporate: ${specialIngredients}.`;
            }
        }
        
        const formattingRules = `
---
**FINAL AND MOST IMPORTANT INSTRUCTIONS - YOUR ENTIRE RESPONSE MUST CONFORM TO THESE RULES:**
Your response must be a single, valid Markdown document.

1.  **INGREDIENTS MUST BE A JSON CODE BLOCK:**
    - **VALIDATION:** Before outputting, you MUST internally validate that the JSON is syntactically correct (correct commas, quotes, brackets). Invalid JSON will break the app.
    - **UNIQUENESS RULE:** Each ingredient must be unique. If added at multiple stages, you MUST sum the total quantity and list the ingredient only ONCE.
    - **YEAST UNIT:** Yeast quantity MUST always be specified in **grams (g)**, even if it corresponds to a standard sachet size. Do NOT use "sachet" or "packet" as a unit for yeast.
    - **Example Format:** \`\`\`json[{"ingredient": "Honey", "quantity": 1.5, "unit": "kg"}]\`\`\`
2.  **STRUCTURED INSTRUCTIONS:** The "## Instructions" section MUST have "### Primary Fermentation" and "### Secondary & Aging" subheadings.
3.  **UNIVERSAL TIMER RULE (MANDATORY):**
    You MUST end *any* instruction list item that requires a specific wait time *after* it is completed with a generic timer tag in the format \`[TIMER:HH:MM:SS]\`. // <-- Escape backticks here
    - **CRUCIAL Meaning:** The time specified (HH:MM:SS) MUST represent the required waiting duration **AFTER** completing the current step **BEFORE** the next *timed* action (like the next nutrient addition) should occur. Place the tag on the step that *initiates* the waiting period.
    - **Nutrient Schedule Exception:** Do **NOT** add a \`[TIMER:...] \` tag to the **final** timed nutrient addition in a schedule. // <-- Escape backticks here
    - For immediate steps ('at pitch' nutrients *without* a subsequent timed addition, general mixing, etc.), do NOT add a tag.
    - **Example 1 (Yeast):** "...Rehydrate yeast and wait 15 minutes. \`[TIMER:00:15:00]\`" // <-- Escape backticks here
    - **Example 2 (Nutrient Schedule Start):** "Add 2g Nutrisal at pitch. \`[TIMER:24:00:00]\`" // <-- Escape backticks here // Starts 24h wait for next nutrient step
    - **Example 3 (Nutrient Schedule Middle):** "At 24 hours after pitching, add 1g VitaFerm. \`[TIMER:24:00:00]\`" // <-- Escape backticks here // Starts 24h wait for 48h step
    - **Example 4 (Nutrient Schedule End):** "At 48 hours after pitching, add 1g Nutrisal." // NO TIMER TAG - This is the last timed addition.
    This tag is the ONLY reliable way the app creates a timer.`;

        return basePrompt + creativeBrief + formattingRules;

    } catch (error) {
        console.error("Error building prompt:", error);
        throw new Error(`Failed to build the prompt. (Details: ${error.message})`);
    }
}

window.freeformTweakRecipe = async function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;
    
    const tweakRequest = document.getElementById(`tweak-request-${brew.id}`).value;
    if (!tweakRequest.trim()) {
        alert("Please enter your tweak request in the text box.");
        return;
    }
    
    const tweakOutput = document.getElementById(`tweak-output-${brew.id}`);
    tweakOutput.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">Your buddy is tweaking your recipe...</p>';

    const prompt = `You are an expert mead maker. A user wants to tweak the following original recipe based on their request.

Original Recipe Markdown:
---
${brew.recipeMarkdown}
---

User's Tweak Request: "${tweakRequest}"

Generate the complete, new, and improved recipe that incorporates the user's request. Ensure the output is fully formatted in Markdown, including a new creative title in 'Name: Subtitle' format, and a complete ingredient table.`;

    try {
        const tweakedMarkdown = await performApiCall(prompt);
        tweakOutput.innerHTML = `<div class="mt-4 p-4 border-t-2 border-purple-700">${marked.parse(tweakedMarkdown)}</div>`;
    } catch (error) {
        console.error("Error tweaking recipe:", error);
        tweakOutput.innerHTML = `<p class="text-center text-red-500">Could not get a tweaked recipe: ${error.message}</p>`;
    }
}

            function loadHistory() {
                if (!userId) return;
                const appId = 'meandery-aa05e';
                const brewsCol = collection(db, 'artifacts', appId, 'users', userId, 'brews');
                const q = query(brewsCol);

                onSnapshot(q, (snapshot) => {
                    brews = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                    brews.sort((a, b) => b.createdAt.toDate() - a.createdAt.toDate()); // Sort newest first
                    renderHistoryList();
                    populateSocialRecipeDropdown();
                    updateCostAnalysis();
                    renderActiveBrewTimeline();
                    updateNextActionWidget();
                }, (error) => {
                    console.error("Error loading history: ", error);
                    historyList.innerHTML = `<p class="text-red-500">Could not load brew history.</p>`;
                });
            }

function renderHistoryList() {
    const searchTerm = document.getElementById('history-search-input').value.toLowerCase();
    
    // Toon alle opgeslagen recepten, en filter enkel op basis van de zoekterm
    const filteredBrews = brews.filter(brew => 
         (brew.recipeName || 'Untitled Brew').toLowerCase().includes(searchTerm)
    );

    if (brews.length === 0) { // Controleer de ongefilterde lijst voor de "leeg" melding
        historyList.innerHTML = `<p class="text-center text-app-secondary/80">You have no brews in your history yet. Go to the Creator to make one!</p>`;
        return;
    }
    
    if (filteredBrews.length === 0) {
        historyList.innerHTML = `<p class="text-center text-app-secondary/80">No recipes found matching your search.</p>`;
        return;
    }

    historyList.innerHTML = filteredBrews.map(brew => `
        <div class="p-4 card rounded-lg cursor-pointer hover:bg-app-primary" onclick="window.showBrewDetail('${brew.id}')">
            <h4 class="font-bold text-lg font-header">${brew.recipeName || 'Untitled Brew'}</h4>
            <p class="text-sm text-app-secondary/80">Saved on: ${brew.createdAt.toDate().toLocaleDateString()}</p>
        </div>
    `).join('');
}

window.showBrewDetail = function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    let finalMarkdown = brew.recipeMarkdown;
    const jsonRegex = /```json\s*([\s\S]*?)\s*```/;
    const jsonMatch = brew.recipeMarkdown.match(jsonRegex);

    if (jsonMatch && jsonMatch[1]) {
        try {
            const ingredientsArray = JSON.parse(jsonMatch[1]);
            let tableMarkdown = '| Ingredient | Quantity | Unit |\n';
            tableMarkdown += '|---|---|---|\n';
            ingredientsArray.forEach(item => {
  
                let displayQty = item.quantity;
                let displayUnit = item.unit;
                const ing = item.ingredient || 'N/A';

                if ((displayUnit || '').toLowerCase() === 'g' && displayQty >= 1000) {
                    displayQty /= 1000;
                    displayUnit = 'kg';
                } else if ((displayUnit || '').toLowerCase() === 'ml' && displayQty >= 1000) {
                    displayQty /= 1000;
                    displayUnit = 'L';
                }

                if (displayQty % 1 !== 0) {
                   displayQty = parseFloat(displayQty.toFixed(2));
                }

                tableMarkdown += `| ${ing} | ${displayQty || 0} | ${displayUnit || 'N/A'} |\n`;
            });
            finalMarkdown = brew.recipeMarkdown.replace(jsonRegex, tableMarkdown);
        } catch (e) {
            console.error("Failed to parse ingredients JSON from saved recipe:", e);
        }
    }

    finalMarkdown = finalMarkdown.replace(/\[d:[\d:]+\]/g, '');

    const recipeHtmlWithoutTitle = marked.parse(finalMarkdown.replace(/^#\s.*$/m, ''));
    const logHtml = getBrewLogHtml(brew.logData, brew.id);
    const currency = userSettings.currencySymbol || '€';

    let costHtml = '';
    if (brew.totalCost !== undefined && brew.totalCost > 0) {
        const costPerLiter = brew.batchSize > 0 ? brew.totalCost / brew.batchSize : 0;
        costHtml = `
            <div class="mt-6 p-4 bg-amber-100 rounded-lg dark:bg-amber-900/20">
                <h3 class="font-header text-lg text-amber-900 dark:text-amber-200">Batch Cost Analysis</h3>
                <p class="text-amber-800 dark:text-amber-200"><strong>Total Ingredient Cost:</strong> ${currency}${brew.totalCost.toFixed(2)}</p>
                <p class="text-amber-800 dark:text-amber-200"><strong>Cost Per Liter:</strong> ${currency}${costPerLiter.toFixed(2)}</p>
            </div>
        `;
    }

    const flavorWheelTitle = brew.predictedFlavorProfile ? 'Predicted Flavor Profile' : 'Flavor Profile Analysis';
    const flavorWheelDescription = brew.predictedFlavorProfile
        ? 'This is the AI-predicted flavor profile based on the recipe.'
        : 'Enter your tasting notes in the log above, save them, and then click the button below to generate a flavor profile.';

    historyDetailContainer.innerHTML = `
        <button onclick="window.goBackToHistoryList()" class="mb-4 text-app-brand hover:underline no-print">&larr; Back to History</button>

        <div class="mb-4">
            <div id="title-display-${brew.id}">
                <h2 class="text-3xl font-header font-bold w-full">${brew.recipeName}</h2>
                <div class="text-right w-full mt-1">
                     <button onclick="window.showTitleEditor('${brew.id}')" class="text-blue-600 hover:text-blue-800 text-sm font-semibold no-print">Edit Title</button>
                </div>
            </div>
            <div id="title-editor-${brew.id}" class="hidden">
                <input type="text" id="title-input-${brew.id}" value="${brew.recipeName}" class="w-full text-2xl font-bold p-2 border rounded-md bg-app-tertiary border-app text-app-primary">
                <div class="flex gap-2 mt-2">
                    <button onclick="window.saveNewTitle('${brew.id}')" class="bg-green-600 text-white px-3 py-1 rounded text-sm btn">Save</button>
                    <button onclick="window.hideTitleEditor('${brew.id}')" class="bg-gray-500 text-white px-3 py-1 rounded text-sm btn">Cancel</button>
                </div>
            </div>
        </div>
        <div class="print-button-container mb-4 grid grid-cols-2 gap-2 no-print">
            <button onclick="window.cloneBrew('${brew.id}')" class="bg-blue-700 text-white py-2 px-4 rounded-lg hover:bg-blue-800 transition-colors btn flex items-center justify-center"> Clone Recipe </button>
            <button onclick="window.startBrewDay('${brew.id}')" class="bg-app-action text-white py-2 px-4 rounded-lg hover:opacity-90 transition-colors btn">Start New Batch</button>
            <button onclick="window.recalculateBatchCost('${brew.id}')" class="bg-purple-700 text-white py-2 px-4 rounded-lg hover:bg-purple-800 transition-colors btn">Recalculate Cost</button>
            <button onclick="window.deleteBrew('${brew.id}')" class="bg-red-700 text-white py-2 px-4 rounded-lg hover:bg-red-800 transition-colors btn flex items-center justify-center"> Delete Recipe </button>
        </div>

        <div class="recipe-content">${recipeHtmlWithoutTitle}</div>
        ${costHtml}
        <div class="mt-6 card p-4 rounded-lg"><h3 class="font-header text-lg text-center">Fermentation Progress</h3><canvas id="fermChart-${brew.id}"></canvas></div>
        ${logHtml}

        <div class="mt-4 no-print">
            <button onclick="window.updateBrewLog('${brew.id}')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg hover:opacity-90 btn">Save Log Changes</button>
        </div>

        <div class="mt-6 pt-4 border-t-2 border-app-brand no-print">
            <h3 class="text-2xl font-header font-bold text-center mb-4">${flavorWheelTitle}</h3>
            <div class="card p-4 rounded-lg text-center">
                <p class="text-app-secondary mb-4">${flavorWheelDescription}</p>
                <button onclick="window.generateFlavorWheel('${brew.id}')" class="bg-purple-600 ... btn"> Analyze My Tasting Notes </button>
                <div id="flavor-wheel-container-${brew.id}" class="mt-4" style="max-width: 400px; margin: auto;"></div>
            </div>
        </div>

        <div class="mt-6 pt-4 border-t-2 border-app no-print">
             <h3 class="text-2xl font-header font-bold text-center mb-4">Tweak Recipe with AI</h3>
             <div class="card p-4 rounded-lg">
                <label for="tweak-request-${brew.id}" class="block text-sm font-bold mb-2">Describe what you want to change:</label>
                <textarea id="tweak-request-${brew.id}" rows="3" class="w-full p-2 border rounded-md bg-app-tertiary border-app text-app-primary" placeholder="e.g., 'Make this recipe for 20 liters', or 'Replace the apples with pears and add cinnamon'"></textarea>
                <button onclick="window.freeformTweakRecipe('${brew.id}')" class="w-full mt-3 bg-purple-700 text-white py-3 px-4 rounded-lg hover:bg-purple-800 btn">Generate Tweaked Recipe</button>
             </div>
        </div>

        <div id="tweak-output-${brew.id}" class="mt-6"></div>
    `;
    historyListContainer.classList.add('hidden');
    historyDetailContainer.classList.remove('hidden');
    renderFermentationGraph(brew.id);

    if (brew.predictedFlavorProfile) {
        const container = document.getElementById(`flavor-wheel-container-${brewId}`);
        container.style.display = 'block';
        const labels = ['Sweetness', 'Acidity', 'Fruity/Floral', 'Spiciness', 'Earthy/Woody', 'Body'];
        const data = [
            brew.predictedFlavorProfile.sweetness,
            brew.predictedFlavorProfile.acidity,
            brew.predictedFlavorProfile.fruity_floral,
            brew.predictedFlavorProfile.spiciness,
            brew.predictedFlavorProfile.earthy_woody,
            brew.predictedFlavorProfile.body_mouthfeel
        ];
        renderFlavorWheel(brewId, labels, data);
    }
}

window.recalculateBatchCost = async function(brewId) {
    if (!userId) return;
    const brew = brews.find(b => b.id === brewId);
    if (!brew) {
        showToast("Could not find brew to recalculate.", "error");
        return;
    }

    // Roep de globale, correcte parseerfunctie aan
    const newTotalCost = parseIngredientsAndCalculateCost(brew.recipeMarkdown, inventory, brew.batchSize);
    const oldTotalCost = brew.totalCost || 0;

    if (confirm(`The new calculated total ingredient cost is ${userSettings.currencySymbol || '€'}${newTotalCost.toFixed(2)} (was ${oldTotalCost.toFixed(2)}). Do you want to update?`)) {
        try {
            const brewDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId);
            await updateDoc(brewDocRef, { totalCost: newTotalCost });

            // Update ook de cellar entry als die bestaat
            const cellarEntry = cellar.find(c => c.brewId === brewId);
            if (cellarEntry) {
                const cellarDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'cellar', cellarEntry.id);
                // De 'totalBatchCost' in de kelder is de som van ingrediënten en verpakking. 
                // We kunnen hier enkel de 'ingredientCost' veilig updaten.
                await updateDoc(cellarDocRef, { ingredientCost: newTotalCost });
            }

            showToast("Batch cost updated successfully!", "success");
            // De onSnapshot-listener zal de UI automatisch verversen, inclusief de detailweergave
            goBackToHistoryList();
        } catch (error) {
            console.error("Error recalculating cost:", error);
            showToast("Failed to update cost.", "error");
        }
    }
}

            window.editPackagingItem = function(itemId) {
                const item = PACKAGING_ITEMS.find(i => i.id === itemId);
                const itemData = packagingCosts[itemId] || {};
                const itemDiv = document.getElementById(`pkg-item-${itemId}`);

                const qtyValue = itemData.qty > 0 ? itemData.qty : '';
                const priceValue = itemData.price > 0 ? itemData.price : '';

                itemDiv.innerHTML = `
                    <div class="w-full space-y-2 p-2 bg-app-primary rounded">
                        <p class="font-bold">${item.name}</p>
                        <div class="grid grid-cols-2 gap-2">
                            <input type="number" id="edit-qty-${itemId}" value="${qtyValue}" placeholder="Quantity" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
                            <input type="number" id="edit-price-${itemId}" value="${priceValue}" step="0.01" placeholder="Total Price (${userSettings.currencySymbol || '€'})" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
                        </div>
                        <div class="flex gap-2">
                            <button onclick="window.updatePackagingItem('${itemId}')" class="w-full bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 text-sm btn">Save</button>
                            <button onclick="renderPackagingUI()" class="w-full bg-gray-500 text-white px-3 py-1 rounded hover:bg-gray-600 text-sm btn">Cancel</button>
                       </div>
                   </div>
                `;
            }

            window.updatePackagingItem = function(itemId) {
                const qty = parseFloat(document.getElementById(`edit-qty-${itemId}`).value) || 0;
                const price = parseFloat(document.getElementById(`edit-price-${itemId}`).value) || 0;

                packagingCosts[itemId] = { qty, price };
                savePackagingCosts(); // Sla de volledige set van kosten op
            }

            window.clearPackagingItem = function(itemId) {
                if (confirm("Are you sure you want to delete the data for this item? This will set quantity and price to 0.")) {
                   packagingCosts[itemId] = { qty: 0, price: 0 };
                   savePackagingCosts();
                }
            }

window.cloneBrew = async function(brewId) {
    const originalBrew = brews.find(b => b.id === brewId);
    if (!originalBrew) {
        showToast("Could not find the original recipe to clone.", "error");
        return;
    }
    // Maak een diepe kopie van de log data en reset de waarden
    const newLogData = JSON.parse(JSON.stringify(originalBrew.logData || {}));
    newLogData.brewDate = ''; 
    newLogData.actualOG = ''; 
    newLogData.actualFG = ''; 
    newLogData.finalABV = '';
    newLogData.fermentationLog = Array.from({ length: 8 }, () => ({ date: '', temp: '', sg: '', notes: '' }));
    newLogData.agingNotes = ''; 
    newLogData.bottlingNotes = ''; 
    newLogData.tastingNotes = '';

    const newBrewData = {
        userId: userId,
        recipeName: `Clone of ${originalBrew.recipeName}`,
        recipeMarkdown: originalBrew.recipeMarkdown,
        logData: newLogData,
        createdAt: new Date(),
        batchSize: originalBrew.batchSize,
        totalCost: originalBrew.totalCost,
        isBottled: false,
        primaryComplete: false, // Belangrijk: reset deze status
        predictedFlavorProfile: originalBrew.predictedFlavorProfile || null,
        
        brewDaySteps: originalBrew.brewDaySteps || [],     // Kopieer de primaire stappen
        secondarySteps: originalBrew.secondarySteps || []  // Kopieer de secundaire stappen
    };

    try {
        const appId = 'meandery-aa05e';
        const brewsCol = collection(db, 'artifacts', appId, 'users', userId, 'brews');
        await addDoc(brewsCol, newBrewData);
        showToast(`'${newBrewData.recipeName}' has been created! You can now start a new batch from it.`, 'success');
        goBackToHistoryList(); // Ga terug naar de lijst zodat de gebruiker de nieuwe kloon kan zien
    } catch (error) {
        console.error("Error cloning brew:", error);
        showToast("An error occurred while cloning the recipe.", "error");
    }
}

            window.goBackToHistoryList = function() {
                historyDetailContainer.classList.add('hidden');
                historyListContainer.classList.remove('hidden');
            }
            
            window.updateBrewLog = async function(brewId) {
                 if (!userId || !brewId) return;
                 const logData = getLogDataFromDOM(`history-detail-container`);
                 try {
                    const appId = 'meandery-aa05e';
                    const brewDocRef = doc(db, 'artifacts', appId, 'users', userId, 'brews', brewId);
                    await updateDoc(brewDocRef, { logData: logData });
                    showToast('Log updated successfully!', 'success');
        
                    // Ververs de detailweergave om de grafiek te tonen
                    showBrewDetail(brewId);

                 } catch(error) {
                    console.error("Error updating log:", error);
                    showToast('Failed to update log.', 'error');
                 }
            }

            window.saveSocialPost = async function() {
                const saveBtn = document.getElementById('save-social-post-btn');
                if (!saveBtn || saveBtn.disabled) return;
                
                const brewId = document.getElementById('social-recipe-select').value;
                if (!brewId) {
                    showToast("You must select a recipe to save the post to.", "error");
                    return;
                }

                const contentDiv = document.getElementById('social-content-container').querySelector('div');
                const platform = document.getElementById('social-platform').options[document.getElementById('social-platform').selectedIndex].text;
                const persona = document.getElementById('social-persona').options[document.getElementById('social-persona').selectedIndex].text;

                if (!contentDiv || !contentDiv.innerText.trim()) {
                    showToast("No content to save.", "error");
                    return;
                }

                const newPost = {
                    platform: platform,
                    persona: persona,
                    content: contentDiv.innerText,
                    createdAt: new Date().toISOString()
                };

                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving...';

                try {
                    const brewDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId);
                    await updateDoc(brewDocRef, {
                        socialMediaPosts: arrayUnion(newPost)
                    });
                    showToast("Post saved to recipe notes!", "success");
                    saveBtn.textContent = 'Saved!';
                } catch (error) {
                    console.error("Error saving social post:", error);
                    showToast("Could not save post.", "error");
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save Post to Recipe Notes';
                }
            } 

window.generateFlavorWheel = async function(brewId) {
    const container = document.getElementById(`flavor-wheel-container-${brewId}`);
    const tastingNotes = document.getElementById(`tastingNotes-${brewId}`).value;

    if (!tastingNotes.trim()) {
        alert("Please enter some tasting notes before analyzing the flavor.");
        return;
    }

    container.style.display = 'block';
    container.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">Analyzing flavor profile...</p>';

    const prompt = `You are a professional mead sommelier. Analyze the following tasting notes and assign a score from 0 to 5 for each of the following categories: Sweetness, Acidity, Fruity/Floral, Spiciness, Earthy/Woody, and Body/Mouthfeel. Provide your output ONLY in a valid JSON format according to the specified schema. Tasting notes: "${tastingNotes}"`;

    const schema = {
        type: "OBJECT",
        properties: {
            "sweetness": { "type": "NUMBER" },
            "acidity": { "type": "NUMBER" },
            "fruity_floral": { "type": "NUMBER" },
            "spiciness": { "type": "NUMBER" },
            "earthy_woody": { "type": "NUMBER" },
            "body_mouthfeel": { "type": "NUMBER" }
        },
        required: ["sweetness", "acidity", "fruity_floral", "spiciness", "earthy_woody", "body_mouthfeel"]
    };

    try {
        const jsonResponse = await performApiCall(prompt, schema);
        const flavorData = JSON.parse(jsonResponse);
        
        const labels = ['Sweetness', 'Acidity', 'Fruity/Floral', 'Spiciness', 'Earthy/Woody', 'Body'];
        const data = [
            flavorData.sweetness,
            flavorData.acidity,
            flavorData.fruity_floral,
            flavorData.spiciness,
            flavorData.earthy_woody,
            flavorData.body_mouthfeel
        ];
        
        renderFlavorWheel(brewId, labels, data);

    } catch (error) {
        console.error("Error generating flavor wheel:", error);
        container.innerHTML = `<p class="text-center text-red-500">Could not analyze flavor profile: ${error.message}</p>`;
    }
}

function renderFlavorWheel(brewId, labels, data) {
    const container = document.getElementById(`flavor-wheel-container-${brewId}`);
    container.innerHTML = `<canvas id="flavorWheelChart-${brewId}"></canvas>`;
    const ctx = document.getElementById(`flavorWheelChart-${brewId}`).getContext('2d');

    if (window.flavorChartInstances && window.flavorChartInstances[brewId]) {
        window.flavorChartInstances[brewId].destroy();
    }
    if (!window.flavorChartInstances) {
        window.flavorChartInstances = {};
    }
    
    const brandColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-color');
    
    // Bepaal de kleuren expliciet op basis van het thema voor perfect contrast.
    const isDarkMode = document.documentElement.classList.contains('dark');
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDarkMode ? '#e0e0e0' : '#4a3c2c'; // Gebruik de expliciete kleurcodes

    window.flavorChartInstances[brewId] = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Flavor Profile',
                data: data,
                backgroundColor: brandColor + '4D',
                borderColor: brandColor,
                borderWidth: 2,
                pointBackgroundColor: brandColor
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { 
                    display: true, // Maak de legende zichtbaar
                    labels: { color: textColor } // Gebruik de correcte tekstkleur
                }
            },
            scales: {
                r: {
                    angleLines: { color: gridColor },
                    grid: { color: gridColor },
                    pointLabels: {
                        color: textColor, // Gebruik de correcte tekstkleur
                        font: { size: 12, family: "'Barlow Semi Condensed', sans-serif" }
                    },
                    ticks: {
                        color: textColor, // Gebruik de correcte tekstkleur
                        backdropColor: 'transparent',
                        stepSize: 1
                    },
                    suggestedMin: 0,
                    suggestedMax: 5
                }
            }
        }
    });
}

async function getPredictedFlavorProfile(markdown) {
    console.log("Generating predicted flavor profile...");
    const prompt = `You are a professional mead sommelier. Analyze the following mead recipe and PREDICT its final flavor profile. Assign a score from 0 to 5 for each of the following categories: Sweetness, Acidity, Fruity/Floral, Spiciness, Earthy/Woody, and Body/Mouthfeel. Provide your output ONLY in a valid JSON format according to the specified schema. Recipe: "${markdown}"`;

    const schema = {
        type: "OBJECT",
        properties: {
            "sweetness": { "type": "NUMBER" },
            "acidity": { "type": "NUMBER" },
            "fruity_floral": { "type": "NUMBER" },
            "spiciness": { "type": "NUMBER" },
            "earthy_woody": { "type": "NUMBER" },
            "body_mouthfeel": { "type": "NUMBER" }
        },
        required: ["sweetness", "acidity", "fruity_floral", "spiciness", "earthy_woody", "body_mouthfeel"]
    };

    try {
        const jsonResponse = await performApiCall(prompt, schema);
        return JSON.parse(jsonResponse);
    } catch (error) {
        console.error("Could not generate predicted flavor profile:", error);
        return null; // Geef null terug bij een fout
    }
}

function renderGeneratedFlavorWheel(flavorData) {
    const ctx = document.getElementById('generated-flavor-wheel');
    if (!ctx) return;

    const labels = ['Sweetness', 'Acidity', 'Fruity/Floral', 'Spiciness', 'Earthy/Woody', 'Body'];
    const data = [
        flavorData.sweetness,
        flavorData.acidity,
        flavorData.fruity_floral,
        flavorData.spiciness,
        flavorData.earthy_woody,
        flavorData.body_mouthfeel
    ];

    const brandColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-color');

    // Bepaal de kleuren expliciet op basis van het thema voor perfect contrast.
    const isDarkMode = document.documentElement.classList.contains('dark');
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDarkMode ? '#e0e0e0' : '#4a3c2c'; // Gebruik de expliciete kleurcodes

    new Chart(ctx.getContext('2d'), {
        type: 'radar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Predicted Profile',
                data: data,
                backgroundColor: brandColor + '4D',
                borderColor: brandColor,
                borderWidth: 2,
                pointBackgroundColor: brandColor
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { 
                    display: true, // Maak de legende zichtbaar
                    labels: { color: textColor } // Gebruik de correcte tekstkleur
                }
            },
            scales: {
                r: {
                    angleLines: { color: gridColor },
                    grid: { color: gridColor },
                    pointLabels: {
                        color: textColor, // Gebruik de correcte tekstkleur
                        font: { size: 12, family: "'Barlow Semi Condensed', sans-serif" }
                    },
                    ticks: {
                        color: textColor, // Gebruik de correcte tekstkleur
                        backdropColor: 'transparent',
                        stepSize: 1
                    },
                    suggestedMin: 0,
                    suggestedMax: 5
                }
            }
        }
    });
}

window.regenerateFlavorProfile = async function() {
            const button = document.getElementById('retry-flavor-btn');
            const statusDiv = document.getElementById('flavor-generation-status');
            const sectionDiv = document.getElementById('flavor-profile-section'); // De div rond de knop/canvas
            const containerDiv = button.parentElement; // De div waar de knop in zit

            if (!currentRecipeMarkdown) {
                statusDiv.innerHTML = `<p class="text-red-500">No recipe data available.</p>`;
                return;
            }

            button.disabled = true;
            statusDiv.innerHTML = '<div class="loader mx-auto" style="width:20px; height:20px; border-width:2px;"></div><p>Generating...</p>';

            try {
                const profile = await getPredictedFlavorProfile(currentRecipeMarkdown);
                if (profile) {
                    currentPredictedProfile = profile; // Sla het succesvolle profiel op
                    // Vervang de knop-container door de canvas container
                    containerDiv.innerHTML = `<canvas id="generated-flavor-wheel"></canvas>`;
                    renderGeneratedFlavorWheel(profile); // Teken de grafiek
                } else {
                     throw new Error("AI did not return a valid profile.");
                }
            } catch (error) {
                 console.error("Error regenerating flavor profile:", error);
                 statusDiv.innerHTML = `<p class="text-red-500">Failed: ${error.message}</p>`;
                 button.disabled = false; // Laat de gebruiker opnieuw proberen
            }
        }

            window.quickTweakRecipe = async function(brewId, tweakType) {
                const brew = brews.find(b => b.id === brewId);
                if (!brew) return;

                const tweakOutput = document.getElementById(`tweak-output-${brew.id}`);
                tweakOutput.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">Applying quick tweak...</p>';

                let tweakInstruction = '';
                switch (tweakType) {
                    case 'make_dryer':
                        tweakInstruction = "make the final mead dryer by adjusting the honey quantity or yeast choice to achieve a lower final gravity.";
                        break;
                    case 'increase_abv':
                        tweakInstruction = "increase the final ABV by approximately 2%. You must adjust the initial honey quantity to provide more fermentable sugar.";
                        break;
                    case 'add_oak':
                        tweakInstruction = "add a step for aging with a light touch of oak cubes or chips. Specify the type, amount, and contact time.";
                        break;
                    default:
                        tweakOutput.innerHTML = `<p class="text-center text-red-500">Unknown tweak type.</p>`;
                        return;
                }

                const prompt = `You are an expert mead maker. Take the following mead recipe and apply this specific modification: ${tweakInstruction}. You must generate the complete, updated recipe, including a regenerated ingredient table and instructions. Explain your changes briefly in the 'Brewer's Notes'. Here is the original recipe:\n\n---\n${brew.recipeMarkdown}`;

                try {
                    const tweakedMarkdown = await performApiCall(prompt);
                    tweakOutput.innerHTML = `<div class="mt-4 p-4 card rounded-lg">${marked.parse(tweakedMarkdown)}</div>`;
                } catch (error) {
                    console.error("Error during quick tweak:", error);
                    tweakOutput.innerHTML = `<p class="text-center text-red-500">Could not perform tweak: ${error.message}</p>`;
                }
            }

            window.swapIngredient = async function(brewId) {
                const brew = brews.find(b => b.id === brewId);
                if (!brew) return;

                const swapInput = document.getElementById(`ingredient-swap-input-${brew.id}`);
                const swapRequest = swapInput.value;
                if (!swapRequest.trim()) {
                    alert("Please describe the ingredient swap you want to make.");
                    return;
                }

                const tweakOutput = document.getElementById(`tweak-output-${brew.id}`);
                tweakOutput.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">Calculating ingredient swap...</p>';

                const prompt = `You are an expert mead maker. Take the following mead recipe. A user wants to make an ingredient substitution. Their request is: "${swapRequest}". 
                
                Please analyze this request. Adjust ingredient quantities if necessary (e.g., accounting for different sugar content in a new honey type). Modify the instructions where needed. In the 'Brewer's Notes', you MUST explain the likely impact of this swap on the final flavor profile. 
                
                Generate the complete, updated recipe with the swap integrated. Here is the original recipe:\n\n---\n${brew.recipeMarkdown}`;
                
                try {
                    const swappedMarkdown = await performApiCall(prompt);
                    tweakOutput.innerHTML = `<div class="mt-4 p-4 card rounded-lg">${marked.parse(swappedMarkdown)}</div>`;
                    swapInput.value = ''; // Clear input after successful swap
                } catch (error) {
                    console.error("Error swapping ingredient:", error);
                    tweakOutput.innerHTML = `<p class="text-center text-red-500">Could not perform swap: ${error.message}</p>`;
                }
            }
            
            // --- Inventory Functions ---
            async function addInventoryItem(e) {
                e.preventDefault();
                if (!userId) return;
                const name = document.getElementById('itemName').value;
                const qty = parseFloat(document.getElementById('itemQty').value);
                const unit = document.getElementById('itemUnit').value;
                const price = parseFloat(document.getElementById('itemPrice').value);
                const category = document.getElementById('itemCategory').value;
                const expirationDate = document.getElementById('itemExpirationDate').value || null;
                if (!name || isNaN(qty) || isNaN(price)) return;
                const itemData = { userId, name, qty, unit, price, category, expirationDate };
                try {
                    const appId = 'meandery-aa05e';
                    const invCol = collection(db, 'artifacts', appId, 'users', userId, 'inventory');
                    await addDoc(invCol, itemData);
                    inventoryForm.reset();
                    showToast("Ingredient added to inventory!", "success");
                } catch (error) {
                    console.error("Error adding inventory item:", error);
                    showToast("Could not add ingredient.", "error");
                }
            }

            function loadInventory() {
    if (!userId) return;
    const appId = 'meandery-aa05e';
    const invCol = collection(db, 'artifacts', appId, 'users', userId, 'inventory');
    const q = query(invCol);

    onSnapshot(q, (snapshot) => {
        inventory = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderInventory();
        updateCostAnalysis();
        updateNextActionWidget(); // Update dashboard with potential expiry warnings
    }, (error) => {
        console.error("Error loading inventory: ", error);
        inventoryList.innerHTML = `<p class="text-red-500">Could not load inventory.</p>`;
    });
}

window.renderInventory = function() {
    const grouped = inventory.reduce((acc, item) => {
        (acc[item.category] = acc[item.category] || []).push(item);
        return acc;
    }, {});

    const categories = ['Honey', 'Yeast', 'Nutrient', 'Malt Extract', 'Fruit', 'Spice', 'Adjunct', 'Chemical', 'Water'];
    const currency = userSettings.currencySymbol || '€';
    let html = '';

    for (const category of categories) {
        if (grouped[category]) {
            html += `<h3 class="text-xl font-header mt-4 mb-2">${category}</h3>`;
            html += `<div class="space-y-2">`;
            grouped[category].forEach(item => {
                const expDateStr = item.expirationDate ? new Date(item.expirationDate).toLocaleDateString() : 'N/A';
                let dateClass = 'text-app-secondary/80';
                if (item.expirationDate) {
                    const expDate = new Date(item.expirationDate);
                    const now = new Date();
                    now.setHours(0,0,0,0);
                    const daysUntilExp = (expDate - now) / (1000 * 60 * 60 * 24);
                    if (daysUntilExp < 0) {
                        dateClass = 'text-red-500 font-bold';
                    } else if (daysUntilExp <= 30) {
                        dateClass = 'text-amber-500 font-semibold';
                    }
                }

                html += `<div id="item-${item.id}" class="p-3 card rounded-md">
                    <div class="flex justify-between items-center">
                        <span>${item.name}</span>
                        <div class="flex items-center gap-4">
                            <span class="font-semibold">${item.qty} ${item.unit} - ${currency}${(item.price || 0).toFixed(2)}</span>
                            <div class="flex gap-2">
                                <button onclick="window.editInventoryItem('${item.id}')" class="text-blue-600 hover:text-blue-800 text-sm">Edit</button>
                                <button onclick="window.deleteInventoryItem('${item.id}')" class="text-red-600 hover:text-red-800 text-sm">Delete</button>
                            </div>
                        </div>
                    </div>
                    <p class="text-xs ${dateClass}">Exp: ${expDateStr}</p>
                </div>`;
            });
            html += `</div>`;
        }
    }
    
    if (inventory.length === 0) {
        html = `<p class="text-center text-app-secondary/80">Your inventory is empty. Add your first ingredient!</p>`;
    }

    inventoryList.innerHTML = html;
}

            window.deleteInventoryItem = async function(itemId) {
                if (!userId) return;
                try {
                    const appId = 'meandery-aa05e';
                    const itemDocRef = doc(db, 'artifacts', appId, 'users', userId, 'inventory', itemId);
                    await deleteDoc(itemDocRef);
                    showToast("Item deleted.", "success");
                } catch (error) {
                    console.error("Error deleting item:", error);
                    showToast("Could not delete item.", "error");
                }
            }

            window.editInventoryItem = function(itemId) {
                const item = inventory.find(i => i.id === itemId);
                if (!item) return;

                const itemDiv = document.getElementById(`item-${itemId}`);
                const currency = userSettings.currencySymbol || '€';
                
                // Bouw de opties voor de 'unit' dropdown
                const unitOptions = ['kg', 'g', 'L', 'ml', 'packets', 'items'];
                const unitSelectHtml = unitOptions.map(unit => 
                    `<option value="${unit}" ${item.unit === unit ? 'selected' : ''}>${unit}</option>`
                ).join('');

                itemDiv.innerHTML = `
                    <div class="w-full space-y-2 p-2 bg-app-primary rounded">
                        <input type="text" id="edit-name-${itemId}" value="${item.name}" placeholder="Name" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
                        <div>
                            <select id="edit-category-${itemId}" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
                                ${['Honey', 'Yeast', 'Nutrient', 'Malt Extract', 'Fruit', 'Spice', 'Adjunct', 'Chemical', 'Water'].map(cat => `<option value="${cat}" ${item.category === cat ? 'selected' : ''}>${cat}</option>`).join('')}
                            </select>
                        </div>
                        <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                            <input type="number" id="edit-qty-${itemId}" value="${item.qty}" step="0.01" placeholder="Quantity" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
                            <select id="edit-unit-${itemId}" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">${unitSelectHtml}</select>
                            <input type="number" id="edit-price-${itemId}" value="${item.price}" step="0.01" placeholder="Price (${userSettings.currencySymbol || '€'})" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
                        </div>
                        <div>
                             <label for="edit-date-${itemId}" class="text-xs text-app-secondary">Exp. Date</label>
                             <input type="date" id="edit-date-${itemId}" value="${item.expirationDate || ''}" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
                        </div>
                        <div class="flex gap-2">
                            <button onclick="window.updateInventoryItem('${itemId}')" class="w-full bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 text-sm btn">Save</button>
                            <button onclick="renderInventory()" class="w-full bg-gray-500 text-white px-3 py-1 rounded hover:bg-gray-600 text-sm btn">Cancel</button>
                        </div>
                    </div>
                `;
            }

            window.updateInventoryItem = async function(itemId) {
                if (!userId) return;
                const updatedData = {
                    name: document.getElementById(`edit-name-${itemId}`).value,
                    qty: parseFloat(document.getElementById(`edit-qty-${itemId}`).value),
                    unit: document.getElementById(`edit-unit-${itemId}`).value,
                    price: parseFloat(document.getElementById(`edit-price-${itemId}`).value),
                    expirationDate: document.getElementById(`edit-date-${itemId}`).value || null,
                    category: document.getElementById(`edit-category-${itemId}`).value
                };
                if (!updatedData.name || isNaN(updatedData.qty) || isNaN(updatedData.price)) {
                    showToast("Invalid input. Please check all fields.", "error");
                    return;
                }
                try {
                    const appId = 'meandery-aa05e';
                    const itemDocRef = doc(db, 'artifacts', appId, 'users', userId, 'inventory', itemId);
                    await updateDoc(itemDocRef, updatedData);
                    showToast("Item updated!", "success");
                    renderInventory(); // Belangrijk: vernieuw de lijst na het opslaan
                } catch (error) {
                    console.error("Error updating item:", error);
                    showToast("Could not update item.", "error");
                }
            }


            // --- Automatische Inventaris Update Functies ---
            function promptToUpdateInventory(markdown) {
                if (confirm("Recipe saved! Do you want to automatically deduct the used ingredients from your inventory?")) {
                    updateInventoryFromRecipe(markdown);
                }
            }

            async function updateInventoryFromRecipe(markdown) {
                const requiredIngredients = parseIngredientsFromMarkdown(markdown);
                if (requiredIngredients.length === 0) return;

                const batch = writeBatch(db);
                let updatesMade = 0;
                let notFound = [];

                requiredIngredients.forEach(req => {
                    const invItem = inventory.find(inv => inv.name.toLowerCase() === req.name.toLowerCase());
                    if (invItem) {
                        const newQty = invItem.qty - req.quantity;
                        if (newQty >= 0) {
                            const itemDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'inventory', invItem.id);
                            batch.update(itemDocRef, { qty: newQty });
                            updatesMade++;
                        } else {
                            notFound.push(`${req.name} (not enough stock)`);
                        }
                    } else {
                        notFound.push(req.name);
                    }
                });

                if (updatesMade > 0) {
                    try {
                        await batch.commit();
                        let message = `${updatesMade} ingredient(s) updated in your inventory.`;
                        if (notFound.length > 0) {
                            message += ` Not found or insufficient stock: ${notFound.join(', ')}.`;
                        }
                        showToast(message, 'success');
                    } catch (error) {
                        console.error("Error updating inventory from recipe:", error);
                        showToast("An error occurred while updating the inventory.", 'error');
                    }
                } else if (notFound.length > 0) {
                    showToast(`No matching ingredients found in inventory to update.`, 'error');
                }
            }

            // --- Equipment Profile Functions ---
            async function addEquipmentProfile(e) {
                e.preventDefault();
                if (!userId) return;
                const name = document.getElementById('equipProfileName').value;
                const type = document.getElementById('equipProfileType').value;
                const quantity = parseInt(document.getElementById('equipProfileQuantity').value) || 1;
                const capacityLiters = parseFloat(document.getElementById('equipCapacityLiters').value) || null;
                const trubLossLiters = parseFloat(document.getElementById('trubLossLiters').value) || 0;
                const boilOffRateLitersPerHour = (type === 'Kettle') ? parseFloat(document.getElementById('boilOffRateLitersPerHour').value) || 0 : 0;
                if (!name) {
                    showToast("Profile Name is required.", "error");
                    return;
                }
                const profileData = { userId, name, type, quantity, capacityLiters, trubLossLiters, boilOffRateLitersPerHour };
                try {
                    const appId = 'meandery-aa05e';
                    const equipCol = collection(db, 'artifacts', appId, 'users', userId, 'equipmentProfiles');
                    await addDoc(equipCol, profileData);
                    document.getElementById('equipment-profile-form').reset();
                    document.getElementById('equipProfileQuantity').value = 1;
                    handleEquipmentTypeChange();
                    showToast("Equipment profile added!", "success");
                } catch (error) {
                    console.error("Error adding equipment profile:", error);
                    showToast("Could not add profile.", "error");
                }
            }

            function loadEquipmentProfiles() {
                if (!userId) return;
                const appId = 'meandery-aa05e';
                const equipCol = collection(db, 'artifacts', appId, 'users', userId, 'equipmentProfiles');
                const q = query(equipCol);

                onSnapshot(q, (snapshot) => {
                    equipmentProfiles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                    renderEquipmentProfiles();
                    populateEquipmentProfilesDropdown();
                }, (error) => {
                    console.error("Error loading equipment profiles: ", error);
                    document.getElementById('equipment-profiles-list').innerHTML = `<p class="text-red-500">Could not load equipment profiles.</p>`;
                });
            }

            window.renderEquipmentProfiles = function() {
                const listDiv = document.getElementById('equipment-profiles-list');
                if (equipmentProfiles.length === 0) {
                    listDiv.innerHTML = `<p class="text-center text-app-secondary/80">You have no saved equipment profiles. Add one to get started!</p>`;
                    return;
                }
                
                listDiv.innerHTML = equipmentProfiles.map(p => `
                    <div id="equip-item-${p.id}" class="p-3 card rounded-md mb-2">
                        <div class="flex justify-between items-center">
                             <div class="flex-grow">
                                <p class="font-bold">${p.name} <span class="text-sm font-normal text-app-secondary/80">(${p.type})</span></p>
                                <p class="text-sm text-app-secondary">Capacity: ${p.capacityLiters || 'N/A'}L | Trub Loss: ${p.trubLossLiters || 0}L ${p.type === 'Kettle' ? `| Boil-off: ${p.boilOffRateLitersPerHour || 0}L/hr` : ''}</p>
                            </div>
                            <div class="flex items-center gap-4 flex-shrink-0 ml-4">
                                <span class="font-semibold">${p.quantity || 1}x in stock</span>
                                <div class="flex gap-2">
                                    <button onclick="window.editEquipmentProfile('${p.id}')" class="text-blue-600 hover:text-blue-800 text-sm font-semibold">Edit</button>
                                    <button onclick="window.deleteEquipmentProfile('${p.id}')" class="text-red-600 hover:text-red-800 text-sm font-semibold">Delete</button>
                                </div>
                            </div>
                        </div>
                    </div>
                `).join('');
            }
            
           window.editEquipmentProfile = function(profileId) {
                const p = equipmentProfiles.find(i => i.id === profileId);
                if (!p) return;

                const itemDiv = document.getElementById(`equip-item-${profileId}`);
                itemDiv.innerHTML = `
                    <div class="w-full space-y-2 p-2 bg-app-primary rounded">
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <input type="text" id="edit-equip-name-${p.id}" value="${p.name}" placeholder="Name" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
                            <input type="number" id="edit-equip-quantity-${p.id}" value="${p.quantity || 1}" min="1" placeholder="Aantal" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
                        </div>
                        <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                            <input type="number" id="edit-equip-cap-${p.id}" value="${p.capacityLiters || ''}" placeholder="Capacity (L)" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
                            <input type="number" id="edit-equip-trub-${p.id}" value="${p.trubLossLiters || '0'}" placeholder="Trub Loss (L)" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
                            <input type="number" id="edit-equip-boiloff-${p.id}" value="${p.boilOffRateLitersPerHour || '0'}" placeholder="Boil-off (L/hr)" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary ${p.type !== 'Kettle' ? 'hidden' : ''}">
                            <div class="flex gap-2 col-span-2 md:col-span-1">
                                <button onclick="window.updateEquipmentProfile('${p.id}', '${p.type}')" class="w-full bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 text-sm btn">Save</button>
                                <button onclick="renderEquipmentProfiles()" class="w-full bg-gray-500 text-white px-3 py-1 rounded hover:bg-gray-600 text-sm btn">Cancel</button>
                            </div>
                        </div>
                    </div>
                `;
            }

            window.updateEquipmentProfile = async function(profileId, type) {
                if (!userId) return;
                const updatedData = {
                    name: document.getElementById(`edit-equip-name-${profileId}`).value,
                    quantity: parseInt(document.getElementById(`edit-equip-quantity-${profileId}`).value) || 1,
                    capacityLiters: parseFloat(document.getElementById(`edit-equip-cap-${profileId}`).value) || null,
                    trubLossLiters: parseFloat(document.getElementById(`edit-equip-trub-${profileId}`).value) || 0,
                    boilOffRateLitersPerHour: (type === 'Kettle') ? parseFloat(document.getElementById(`edit-equip-boiloff-${profileId}`).value) || 0 : 0
                };

                if (!updatedData.name) {
                    showToast("Profile name cannot be empty.", "error");
                    return;
                }

                try {
                    const appId = 'meandery-aa05e';
                    const itemDocRef = doc(db, 'artifacts', appId, 'users', userId, 'equipmentProfiles', profileId);
                    await updateDoc(itemDocRef, updatedData);
                    showToast("Equipment profile updated!", "success");
                    renderEquipmentProfiles(); // Belangrijk: vernieuw de lijst
                } catch (error) {
                    console.error("Error updating equipment profile:", error);
                    showToast("Could not update profile.", "error");
                }
            }

            window.deleteEquipmentProfile = async function(profileId) {
                if (!userId) return;
                if (!confirm('Are you sure you want to delete this equipment profile?')) return;
                try {
                    const appId = 'meandery-aa05e';
                    const itemDocRef = doc(db, 'artifacts', appId, 'users', userId, 'equipmentProfiles', profileId);
                    await deleteDoc(itemDocRef);
                } catch (error) {
                    console.error("Error deleting equipment profile:", error);
                }
            }
            
            function handleEquipmentTypeChange() {
                 const type = document.getElementById('equipProfileType').value;
                 document.getElementById('boil-off-rate-container').classList.toggle('hidden', type !== 'Kettle');
            }

            function populateEquipmentProfilesDropdown() {
                const select = document.getElementById('equipmentProfileSelect');
                if (!select) return;
                
                const currentValue = select.value;
                select.innerHTML = '<option value="">None (Use default values)</option>'; // Reset
                
                equipmentProfiles.forEach(p => {
                    const option = document.createElement('option');
                    option.value = p.id;
                    option.textContent = p.name;
                    select.appendChild(option);
                });
                select.value = currentValue; // Probeer de selectie te behouden
            }

            // --- Cellar Functions ---

            function loadCellar() {
                if (!userId) return;
                const appId = 'meandery-aa05e';
                const cellarCol = collection(db, 'artifacts', appId, 'users', userId, 'cellar');
                const q = query(cellarCol);

                onSnapshot(q, (snapshot) => {
                    cellar = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                    // Sorteer op botteldatum, nieuwste eerst
                    if (cellar.length > 0 && cellar[0].bottlingDate) {
                        cellar.sort((a, b) => b.bottlingDate.toDate() - a.bottlingDate.toDate());
                    }
                    renderCellar();
                    updateNextActionWidget();
                }, (error) => {
                    console.error("Error loading cellar: ", error);
                    document.getElementById('cellar-list').innerHTML = `<p class="text-red-500">Could not load cellar.</p>`;
                });
            }

            function renderCellar() {
    const listDiv = document.getElementById('cellar-list');
    const currency = userSettings.currencySymbol || '€';

    if (cellar.length === 0) {
        listDiv.innerHTML = `<p class="text-center text-app-secondary/80">Your cellar is empty. Bottle a batch from your history to add it here!</p>`;
        return;
    }
    
    const packagingCostsPerUnit = getPackagingCosts();

    listDiv.innerHTML = cellar.map(item => {
        const originalBrew = brews.find(b => b.id === item.brewId);
        const escapedRecipeName = item.recipeName.replace(/'/g, "\\'");
        const originalBatchSize = originalBrew ? originalBrew.batchSize : 1; // Fallback
        const ingredientCostPerLiter = originalBatchSize > 0 ? (item.ingredientCost || 0) / originalBatchSize : 0;

        const bottlingDateStr = item.bottlingDate ? item.bottlingDate.toDate().toLocaleDateString() : 'No date';

        const bottleDetailsHtml = (item.bottles && Array.isArray(item.bottles)) ? item.bottles.map(b => {
            const meadCostInBottle = ingredientCostPerLiter * (b.size / 1000);
            
            let closureCost = 0;
            if (b.size >= 750) { closureCost = packagingCostsPerUnit.cork || 0; } 
            else if (b.size >= 500) { closureCost = packagingCostsPerUnit.crown_cap_29 || 0; } 
            else { closureCost = packagingCostsPerUnit.crown_cap_26 || 0; }
            
            const bottleCost = packagingCostsPerUnit[b.size.toString()] || 0;
            const labelCost = packagingCostsPerUnit.label || 0;
            const finalCostPerBottle = meadCostInBottle + bottleCost + closureCost + labelCost;
            const costText = finalCostPerBottle > 0 ? `<span class="font-bold">${currency}${finalCostPerBottle.toFixed(2)}/st</span>` : '';

            return `
            <div class="flex items-center justify-between text-sm py-1">
                <span>${b.quantity} x ${b.size}ml</span>
                <div class="flex items-center gap-4">
                    ${costText}
                    <button onclick="window.consumeBottle('${item.id}', ${b.size})" class="text-xs bg-app-action text-white px-2 py-1 rounded hover:opacity-80 btn">-1 Bottle</button>
                </div>
            </div>`;
        }).join('') : `<p class="text-sm">Bottle data not available.</p>`;
        
        const totalBottlesInBatch = item.bottles.reduce((acc, b) => acc + b.quantity, 0);

        const adviceHtml = item.peakFlavorDate ? `
            <div class="mt-3 pt-3 border-t border-app">
                <p class="text-sm font-bold text-app-primary">Aging Advice:</p>
                <p class="text-sm text-app-secondary/90">
                    <span class="font-semibold">Peak Flavor around: ${item.peakFlavorDate}.</span> ${item.peakFlavorJustification || ''}
                </p>
            </div> ` : '';

        return `
        <div class="p-4 card rounded-lg">
            <div class="flex justify-between items-start">
                <div>
                    <h4 class="font-bold text-lg font-header">${item.recipeName}</h4>
                    <p class="text-sm text-app-secondary">Bottled on: ${bottlingDateStr}</p>
                </div>
                <div class="text-right flex-shrink-0 ml-4">
                    <p class="text-2xl font-bold text-app-brand">${totalBottlesInBatch} <span class="text-base font-normal">total</span></p>
                </div>
            </div>
            <div class="mt-3 space-y-2">${bottleDetailsHtml}</div>
            ${adviceHtml}
            <div class="text-right mt-3 border-t border-app pt-2 flex justify-end items-center gap-4">
                 <button onclick="window.setTastingReminder('${item.id}')" class="text-blue-600 hover:text-blue-800 text-xs font-semibold">Set Reminder</button>
                 <button onclick="window.deleteCellarItem('${item.id}', '${escapedRecipeName}')" class="text-red-600 hover:text-red-800 text-xs font-semibold">Delete Batch</button>
            </div>
        </div>
        `;
    }).join('');
}

            // --- Kalender Herinnering Functies ---
            window.setTastingReminder = function(cellarItemId) {
                const item = cellar.find(c => c.id === cellarItemId);
                if (!item) return;

                const months = prompt(`Set a tasting reminder for "${item.recipeName}".\n\nIn how many months from today?`, "6");
                if (months === null || isNaN(parseInt(months)) || parseInt(months) <= 0) {
                    return; // Gebruiker annuleert of geeft ongeldige invoer
                }

                const reminderDate = new Date();
                reminderDate.setMonth(reminderDate.getMonth() + parseInt(months));
                
                generateAndDownloadIcs(item, reminderDate);
            }

            function generateAndDownloadIcs(item, date) {
                // Formatteer de datum naar UTC (vereist voor .ics bestanden)
                const toICSFormat = (d) => {
                    return d.getUTCFullYear() + 
                           ('0' + (d.getUTCMonth() + 1)).slice(-2) + 
                           ('0' + d.getUTCDate()).slice(-2) + 'T' +
                           ('0' + d.getUTCHours()).slice(-2) +
                           ('0' + d.getUTCMinutes()).slice(-2) +
                           ('0' + d.getUTCSeconds()).slice(-2) + 'Z';
                }

                const eventStart = toICSFormat(date);
                const eventStamp = toICSFormat(new Date());

                // Bouw de inhoud van het .ics bestand
                const icsContent = [
                    'BEGIN:VCALENDAR',
                    'VERSION:2.0',
                    'BEGIN:VEVENT',
                    `UID:${Date.now()}@meandery.app`,
                    `DTSTAMP:${eventStamp}`,
                    `DTSTART;VALUE=DATE:${eventStart.substring(0,8)}`, // We maken er een "hele dag" evenement van
                    `SUMMARY:Tasting Reminder: ${item.recipeName}`,
                    'DESCRIPTION:Time to taste your aged mead from the MEA(N)DERY app! Notes: How is the aroma, clarity, and flavor? Has it mellowed out?',
                    'END:VEVENT',
                    'END:VCALENDAR'
                ].join('\n');

                // Maak en download het bestand
                const blob = new Blob([icsContent], { type: 'text/calendar' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `Tasting_Reminder_${item.recipeName.replace(/\s/g, '_')}.ics`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }

            // --- Barcode Scanner Functies ---
            function startScanner() {
                document.getElementById('barcode-scanner-container').classList.remove('hidden');

                html5QrcodeScanner = new Html5Qrcode("barcode-reader");
                const config = { fps: 10, qrbox: { width: 250, height: 150 } };

                html5QrcodeScanner.start({ facingMode: "environment" }, config, onScanSuccess)
                     .catch(err => {
                         console.error("Unable to start scanning.", err);
                         alert("Could not start camera. Please grant camera permissions.");
                     });
            }

            function stopScanner() {
                if (html5QrcodeScanner && html5QrcodeScanner.isScanning) {
                    html5QrcodeScanner.stop().then(() => {
                        document.getElementById('barcode-scanner-container').classList.add('hidden');
                    }).catch(err => console.error("Error stopping scanner:", err));
                } else {
                     document.getElementById('barcode-scanner-container').classList.add('hidden');
                }
            }

            function onScanSuccess(decodedText, decodedResult) {
                // Stop de scanner onmiddellijk na een succesvolle scan
                stopScanner();

                // Vraag de productinformatie op
                fetchProductInfo(decodedText);
            }

            async function fetchProductInfo(barcode) {
                const itemNameInput = document.getElementById('itemName');
                const originalPlaceholder = itemNameInput.placeholder;
                itemNameInput.value = '';
                itemNameInput.placeholder = 'Looking up barcode...';

                try {
                    const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`);
                    if (!response.ok) throw new Error("Product not found in the database.");

                    const data = await response.json();

                    if (data.status === 1 && data.product && data.product.product_name) {
                        itemNameInput.value = data.product.product_name;
                    } else {
                        throw new Error("Product not found in the database.");
                    }
               } catch (error) {
                   console.error("Barcode lookup failed:", error);
                   alert(error.message);
               } finally {
                   itemNameInput.placeholder = originalPlaceholder;
               }
            }

            window.consumeBottle = async function(cellarItemId, bottleSize) {
                if (!userId) return;

                const cellarItemRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'cellar', cellarItemId);
                
                try {
                    // Haal het huidige document op
                    const docSnap = await getDoc(cellarItemRef);
                    if (!docSnap.exists()) {
                        console.error("Cellar item not found!");
                        return;
                    }

                    const itemData = docSnap.data();
                    const bottles = itemData.bottles;

                    // Vind de juiste flesmaat en verminder de hoeveelheid
                    const bottleIndex = bottles.findIndex(b => b.size == bottleSize);
                    if (bottleIndex > -1 && bottles[bottleIndex].quantity > 0) {
                        bottles[bottleIndex].quantity -= 1;

                        // Optioneel: verwijder de flesmaat als de hoeveelheid 0 is
                        const updatedBottles = bottles.filter(b => b.quantity > 0);
                        
                        // Update het document in Firestore
                        await updateDoc(cellarItemRef, { bottles: updatedBottles });
                    } else {
                        alert("Bottle size not found or quantity is already 0.");
                    }
                } catch (error) {
                    console.error("Error consuming bottle: ", error);
                }
            }

            window.deleteCellarItem = async function(itemId, recipeName) {
                if (!userId) return;
                if (!confirm(`Are you sure you want to delete the entire batch of '${recipeName}' from your cellar? This cannot be undone.`)) return;
                try {
                    const appId = 'meandery-aa05e';
                    const itemDocRef = doc(db, 'artifacts', appId, 'users', userId, 'cellar', itemId);
                    await deleteDoc(itemDocRef);
                } catch (error) {
                    console.error("Error deleting cellar item:", error);
                }
            }


            // --- Functies voor het bottel-proces ---

            let currentBrewToBottleId = null; 

            window.showBottlingModal = function(brewId) {
                customBottles = []; // Reset de lijst
                renderCustomBottlesList(); // Maak de UI leeg
                currentBrewToBottleId = brewId;
                const bottlingForm = document.getElementById('bottling-form');
                bottlingForm.reset();
                document.getElementById('bottlingDate').valueAsDate = new Date();
                document.getElementById('bottling-modal').classList.remove('hidden');
            }

            window.hideBottlingModal = function() {
                document.getElementById('bottling-modal').classList.add('hidden');
                currentBrewToBottleId = null;
            }

async function bottleBatch(e) {
    e.preventDefault();
    if (!currentBrewToBottleId) return;

    const submitButton = e.target.querySelector('button[type="submit"]');
    const originalButtonText = submitButton.innerHTML;
    submitButton.disabled = true;
    submitButton.innerHTML = '<div class="loader" style="height:20px; width:20px; border-width: 2px; margin: 0 auto;"></div>';

    try {
        const originalBrew = brews.find(b => b.id === currentBrewToBottleId);
        if (!originalBrew) throw new Error("Could not find the original recipe to bottle.");

        const bottlesData = [
            { size: 750, quantity: parseInt(document.getElementById('qty750').value) || 0, price: null },
            { size: 500, quantity: parseInt(document.getElementById('qty500').value) || 0, price: null },
            { size: 330, quantity: parseInt(document.getElementById('qty330').value) || 0, price: null },
            { size: 250, quantity: parseInt(document.getElementById('qty250').value) || 0, price: null },
            ...customBottles
        ].filter(b => b.quantity > 0 && b.size > 0);

        if (bottlesData.length === 0) throw new Error("Please enter a quantity for at least one bottle size.");

        const closureType = document.getElementById('closureTypeSelect').value;
        const outOfStockItems = [];
        let totalBottles = 0;

        bottlesData.forEach(bottle => {
            totalBottles += bottle.quantity;
            if (bottle.price === null) {
                const stockId = `bottle_${bottle.size}`;
                const currentStock = packagingCosts[stockId]?.qty || 0;
                if (bottle.quantity > currentStock) {
                    outOfStockItems.push(`${bottle.quantity} x ${bottle.size}ml bottle(s) (only ${currentStock} in stock)`);
                }
            }
        })

        if (closureType === 'auto') {
            const closuresNeeded = { cork: 0, crown_cap_26: 0, crown_cap_29: 0 };
            bottlesData.forEach(b => {
                if (b.size >= 750) closuresNeeded.cork += b.quantity;
                else if (b.size >= 500) closuresNeeded.crown_cap_29 += b.quantity;
                else closuresNeeded.crown_cap_26 += b.quantity;
            });
            if (closuresNeeded.cork > (packagingCosts['cork']?.qty || 0)) outOfStockItems.push(`Not enough corks (needed: ${closuresNeeded.cork})`);
            if (closuresNeeded.crown_cap_26 > (packagingCosts['crown_cap_26']?.qty || 0)) outOfStockItems.push(`Not enough 26mm caps (needed: ${closuresNeeded.crown_cap_26})`);
            if (closuresNeeded.crown_cap_29 > (packagingCosts['crown_cap_29']?.qty || 0)) outOfStockItems.push(`Not enough 29mm caps (needed: ${closuresNeeded.crown_cap_29})`);
        } else {
            const needed = totalBottles;
            const inStock = packagingCosts[closureType]?.qty || 0;
            if (needed > inStock) {
                outOfStockItems.push(`${needed} x ${closureType.replace(/_/g, ' ')} (only ${inStock} in stock)`);
            }
        }

        const currentLabelStock = packagingCosts['label']?.qty || 0;
        if (totalBottles > currentLabelStock) outOfStockItems.push(`${totalBottles} label(s) (only ${currentLabelStock} in stock)`);

        if (outOfStockItems.length > 0) {
            throw new Error(`Not enough stock. Missing:\n- ${outOfStockItems.join('\n- ')}`);
        }

        const packagingCostsPerUnit = getPackagingCosts();
        let totalPackagingCost = 0;

        bottlesData.forEach(bottle => {
            const bottleCost = bottle.price !== null ? bottle.price : (packagingCostsPerUnit[bottle.size.toString()] || 0);
            let closureCost = 0;

            if (closureType === 'auto') {
                if (bottle.size >= 750) { closureCost = packagingCostsPerUnit.cork || 0; }
                else if (bottle.size >= 500) { closureCost = packagingCostsPerUnit.crown_cap_29 || 0; }
                else { closureCost = packagingCostsPerUnit.crown_cap_26 || 0; }
            } else {
                closureCost = packagingCostsPerUnit[closureType] || 0;
            }

            const labelCost = packagingCostsPerUnit.label || 0;
            totalPackagingCost += bottle.quantity * (bottleCost + closureCost + labelCost);
        });

        const ingredientCost = originalBrew.totalCost || 0;
        if (ingredientCost === 0) {
           showToast("Warning: The ingredient cost for this batch is €0.00. The total cost may be inaccurate. You can try recalculating it from the History view.", "error", 8000);
        }
        let finalTotalCost = ingredientCost + totalPackagingCost;

        if (confirm(`The calculated packaging cost is ${userSettings.currencySymbol || '€'}${totalPackagingCost.toFixed(2)}. The new total batch cost will be ${userSettings.currencySymbol || '€'}${finalTotalCost.toFixed(2)}. Do you want to continue?`)) {
            const updatedPackagingStock = JSON.parse(JSON.stringify(packagingCosts));

            const deductFromStock = (stock, itemId, quantity) => {
                if (stock[itemId] && stock[itemId].qty > 0) {
                    const costPerUnit = stock[itemId].price / stock[itemId].qty;
                    const costToDeduct = costPerUnit * quantity;
                    
                    stock[itemId].qty -= quantity;
                    stock[itemId].price -= costToDeduct;

                    if (stock[itemId].qty <= 0) {
                        stock[itemId].qty = 0;
                        stock[itemId].price = 0;
                    }
                }
            };

            bottlesData.forEach(bottle => {
                if(bottle.price === null) {
                    deductFromStock(updatedPackagingStock, `bottle_${bottle.size}`, bottle.quantity);
                }
            });

            if (closureType === 'auto') {
                 bottlesData.forEach(bottle => {
                    let closureId;
                    if (bottle.size >= 750) { closureId = 'cork'; }
                    else if (bottle.size >= 500) { closureId = 'crown_cap_29'; }
                    else { closureId = 'crown_cap_26'; }
                    deductFromStock(updatedPackagingStock, closureId, bottle.quantity);
                 });
            } else {
                deductFromStock(updatedPackagingStock, closureType, totalBottles);
            }
            deductFromStock(updatedPackagingStock, 'label', totalBottles);

            const appId = 'meandery-aa05e';
            const settingsDocRef = doc(db, 'artifacts', appId, 'users', userId, 'settings', 'packaging');
            await setDoc(settingsDocRef, updatedPackagingStock);
            packagingCosts = updatedPackagingStock;

            const bottlingDate = new Date(document.getElementById('bottlingDate').value);
            const cellarData = {
                userId: userId,
                brewId: currentBrewToBottleId,
                recipeName: originalBrew.recipeName,
                bottlingDate: bottlingDate,
                bottles: bottlesData.map(({price, ...rest}) => rest),
                totalBatchCost: finalTotalCost,
                ingredientCost: originalBrew.totalCost || 0,
                peakFlavorDate: null,
                peakFlavorJustification: 'Advice could not be generated.'
            };

            try {
                const logSummary = `
                    - Target OG: ${originalBrew.logData.targetOG}, Actual OG: ${originalBrew.logData.actualOG}
                    - Target FG: ${originalBrew.logData.targetFG}, Actual FG: ${originalBrew.logData.actualFG}
                    - Final ABV: ${originalBrew.logData.finalABV}
                    - Fermentation notes: ${JSON.stringify(originalBrew.logData.fermentationLog)}
                `;

                const agingPrompt = `You are an expert mead maker and keldermeester. Analyze the journey of the following mead from recipe to bottling and provide a definitive cellaring note. Pay close attention to any deviations between the target and actual values.

                Original Recipe:
                ---
                ${originalBrew.recipeMarkdown}
                ---

                Brewmaster's Log Summary:
                ---
                ${logSummary}
                ---

                The mead was bottled on: ${bottlingDate.toISOString().split('T')[0]}.

                Based on all this data, provide a single, expert "Cellaring Note:" explaining the aging potential and a recommended peak drinking window. Your entire response should be just the note itself, starting with "This mead...".`;

                const definitiveAdvice = await performApiCall(agingPrompt);
                cellarData.peakFlavorJustification = definitiveAdvice.trim();

            } catch (aiError) {
                console.error("Definitive aging advice failed, but bottling will continue:", aiError);
            }

            const cellarCol = collection(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'cellar');
            await addDoc(cellarCol, cellarData);

            const brewDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', currentBrewToBottleId);
            await updateDoc(brewDocRef, { isBottled: true });

            const brewIndex = brews.findIndex(b => b.id === currentBrewToBottleId);
            if (brewIndex > -1) {
                brews[brewIndex].isBottled = true;
            }

            if (currentBrewDay.brewId === currentBrewToBottleId) {
                currentBrewDay = { brewId: null, checklist: {} };
                await saveUserSettings();
            }

            renderBrewDay2();
            renderHistoryList();
            renderBrewDay('none');

            hideBottlingModal();
            showToast("Batch bottled and added to cellar!", "success");
            switchMainView('management');
            switchSubView('cellar', 'management-main-view');
        } else {
             throw new Error("Bottling cancelled by user.");
        }
    } catch (error) {
        console.error("Error during bottling process: ", error);
        showToast(error.message, "error");
    } finally {
        submitButton.disabled = false;
        submitButton.innerHTML = originalButtonText;
    }
}

            window.linkToBacksweetenCalc = function(brewId) {
                const brew = brews.find(b => b.id === brewId);
                if (!brew || !brew.logData) return;

                // Navigeer naar de calculators tab
                switchMainView('tools');
                switchSubView('calculators', 'tools-main-view');

                // Vul de waarden in
                document.getElementById('bs_current_vol').value = brew.batchSize || '';
                document.getElementById('bs_current_sg').value = brew.logData.actualFG || brew.logData.targetFG || '';
                
                // Scroll naar de calculator
                document.getElementById('bs_current_vol').scrollIntoView({ behavior: 'smooth', block: 'center' });
            }

            window.linkToDilutionCalc = function(brewId) {
                const brew = brews.find(b => b.id === brewId);
                if (!brew || !brew.logData) return;

                // Navigeer naar de calculators tab
                switchMainView('tools');
                switchSubView('calculators', 'tools-main-view');
                
                // Vul de waarden in
                document.getElementById('dil_start_vol').value = brew.batchSize || '';
                document.getElementById('dil_start_sg').value = brew.logData.actualOG || brew.logData.targetOG || '';
                
                // Scroll naar de calculator
                document.getElementById('dil_start_vol').scrollIntoView({ behavior: 'smooth', block: 'center' });
            }

            async function getYeastAdvice() {
                const og = document.getElementById('starterOG').value;
                const yeastDate = document.getElementById('yeastDate').value;
                const yeastType = document.getElementById('yeastType').value;
                const adviceOutput = document.getElementById('yeast-advice-output');

                if (!og || !yeastDate) {
                    adviceOutput.innerHTML = `<p class="text-red-500">Please enter both Starting Gravity and Yeast Date.</p>`;
                    return;
                }
                adviceOutput.innerHTML = '<div class="loader"></div>';

                const prompt = `You are a yeast expert. A homebrewer is making a mead with a starting gravity of ${og}. Their ${yeastType} yeast packet has a production date of ${yeastDate}. Today's date is ${new Date().toISOString().split('T')[0]}. Based on this, tell them if a yeast starter is necessary. If it is, provide a simple, step-by-step guide for making an appropriate starter for a 5-liter batch. Format the response in Markdown.`;

                try {
                    const adviceMarkdown = await performApiCall(prompt);
                    adviceOutput.innerHTML = marked.parse(adviceMarkdown);
                } catch (error) {
                    console.error("Error getting yeast advice:", error);
                    adviceOutput.innerHTML = `<p class="text-center text-red-500">Could not get yeast advice: ${error.message}</p>`;
                }
            }

            // --- Water Chemistry Functions ---
            const waterData = {
                spa: { ca: 5, mg: 2, na: 3, so4: 4, cl: 5, hco3: 17 },
                chaudfontaine: { ca: 65, mg: 18, na: 44, so4: 40, cl: 35, hco3: 305 },
                valvert: { ca: 68, mg: 2, na: 2, so4: 18, cl: 4, hco3: 204 },
                bru: { ca: 23.3, mg: 22.2, na: 8, so4: 5, cl: 4, hco3: 209 },
                villers: { ca: 106.1, mg: 11.1, na: 8, so4: 48.8, cl: 19.9, hco3: 340.4 }
            };

            function handleWaterSourceChange() {
                const select = document.getElementById('waterSource');
                const selectedValue = select.value;
                const [type, id] = selectedValue.split('_');

                let profile;
                if (type === 'builtin') {
                   profile = BUILT_IN_WATER_PROFILES[id];
                } else if (type === 'user') {
                   profile = userWaterProfiles.find(p => p.id === id);
                }  

                if (profile) {
                   currentWaterProfile = profile;
                   updateWaterProfileDisplay(profile);
                }
            }

            // VOEG DEZE KLEINE HELPER-FUNCTIE TOE
            function updateWaterProfileDisplay(profile) {
                document.getElementById('val-ca').textContent = profile.ca;
                document.getElementById('val-mg').textContent = profile.mg;
                document.getElementById('val-na').textContent = profile.na;
                document.getElementById('val-so4').textContent = profile.so4;
                document.getElementById('val-cl').textContent = profile.cl;
                document.getElementById('val-hco3').textContent = profile.hco3;
            }

            async function getWaterAdvice() {
                if (!currentWaterProfile) {
                    document.getElementById('water-advice-output').innerHTML = `<p class="text-center text-red-500">Please fetch or apply a water profile first.</p>`;
                    return;
                }
                
                const adviceOutput = document.getElementById('water-advice-output');
                adviceOutput.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">Analyzing water profile...</p>';
                
                const targetProfile = document.getElementById('meadTargetProfile').selectedOptions[0].text;
                const batchSize = document.getElementById('batchSize').value;
                const waterSourceType = document.getElementById('waterSource').value;

                // --- AANGEPAST: De prompt is nu dynamisch ---
                let prompt;
                const waterProfileString = `Calcium: ${currentWaterProfile.ca}, Magnesium: ${currentWaterProfile.mg}, Sodium: ${currentWaterProfile.na}, Sulfate: ${currentWaterProfile.so4}, Chloride: ${currentWaterProfile.cl}, Bicarbonate: ${currentWaterProfile.hco3}`;

                if (waterSourceType === 'tap') {
                    prompt = `You are an expert brew chemist. A user has provided their tap water profile in mg/L: ${waterProfileString}. They want to adjust this water for a ${batchSize}-liter batch of mead with a target character of "${targetProfile}". 
                    
                    Provide specific, actionable advice. Recommend additions of brewing salts (Gypsum, Calcium Chloride, Epsom Salt, Baking Soda) in grams to achieve the target profile. Start by explaining the goal (e.g., "For a rich and full-bodied mead, we want to increase Calcium and Chloride..."). Then, list the specific salt additions required. Format the response in simple Markdown.`;
                } else {
                    prompt = `You are an expert brew chemist. A user is starting with water that has the following profile in mg/L: ${waterProfileString}. They want to brew a ${batchSize}-liter batch of mead with a target character of "${targetProfile}". 
                    
                    First, analyze the provided water profile. Is it suitable as-is for the target mead style? If so, state that. If not, recommend specific additions of brewing salts (Gypsum, Calcium Chloride, Epsom Salt) in grams to improve it. Explain WHY you are recommending these changes (e.g., "add gypsum to accentuate dryness"). Format the response in simple Markdown.`;
                }


                try {
                    const adviceMarkdown = await performApiCall(prompt);
                    adviceOutput.innerHTML = marked.parse(adviceMarkdown);
                } catch (error) {
                    console.error("Error getting water advice:", error);
                    adviceOutput.innerHTML = `<p class="text-center text-red-500">Could not get water advice: ${error.message}</p>`;
                }
            }

            // --- Utility Functions ---
function parseIngredientsAndCalculateCost(markdown, inventory, batchSize) {
    let totalCost = 0;
    const requiredIngredients = parseIngredientsFromMarkdown(markdown);

    if (requiredIngredients.length === 0) {
        console.warn("Cost calculation: No ingredients found by the parser.");
        return 0;
    }

    // Helper functie om alles naar een basis-eenheid (g of ml) om te rekenen
    const convertToBaseUnit = (quantity, unit) => {
        const u = (unit || '').toLowerCase();
        if (u === 'kg') return { quantity: quantity * 1000, unit: 'g' };
        if (u === 'l') return { quantity: quantity * 1000, unit: 'ml' };
        return { quantity, unit: u };
    };

    requiredIngredients.forEach(req => {
        const inventoryItem = inventory.find(item => item.name.toLowerCase() === req.name.toLowerCase());
        
        if (inventoryItem && typeof inventoryItem.price === 'number' && inventoryItem.qty > 0) {
            // Stap 1: Converteer de benodigde hoeveelheid naar de basis-eenheid.
            const requiredAmountInBase = convertToBaseUnit(req.quantity, req.unit);

            // Stap 2: Bereken de prijs per basis-eenheid uit de inventaris.
            const inventoryAmountInBase = convertToBaseUnit(inventoryItem.qty, inventoryItem.unit);
            
            // Controleer of de eenheden overeenkomen na conversie (bv. g met g, ml met ml)
            if (requiredAmountInBase.unit === inventoryAmountInBase.unit) {
                const costPerBaseUnit = inventoryItem.price / inventoryAmountInBase.quantity;

                // Stap 3: Vermenigvuldig de benodigde hoeveelheid (in basis-eenheid) met de prijs per basis-eenheid.
                if (!isNaN(costPerBaseUnit)) {
                    totalCost += requiredAmountInBase.quantity * costPerBaseUnit;
                }
            } else {
                 console.warn(`Cannot calculate cost for '${req.name}'. Incompatible units: recipe wants '${requiredAmountInBase.unit}', inventory has '${inventoryAmountInBase.unit}'.`);
            }
        }
    });

    return totalCost;
}

            window.printEmptyLog = function() {
                const logHtml = getBrewLogHtml(null, 'empty');
                const printWindow = window.open('', '_blank');
                printWindow.document.write(`<html><head><title>Empty Brew Log</title><style>${document.querySelector('style').innerHTML}</style></head><body><div class="container mx-auto p-4">${logHtml}</div></body></html>`);
                printWindow.document.close();
                printWindow.print();
            }

            function getLogDataFromDOM(containerId) {
                const container = document.getElementById(containerId);
                if (!container) return {};
                const logSection = container.querySelector('.brew-log-section');
                if (!logSection) return {};
                const suffix = `-${logSection.dataset.id}`;
                return {
                    recipeName: container.querySelector(`#recipeName${suffix}`)?.value || '',
                    brewDate: container.querySelector(`#brewDate${suffix}`)?.value || '',
                    targetOG: container.querySelector(`#targetOG${suffix}`)?.value || '',
                    actualOG: container.querySelector(`#actualOG${suffix}`)?.value || '',
                    targetFG: container.querySelector(`#targetFG${suffix}`)?.value || '',
                    actualFG: container.querySelector(`#actualFG${suffix}`)?.value || '',
                    targetABV: container.querySelector(`#targetABV${suffix}`)?.value || '',
                    finalABV: container.querySelector(`#finalABV${suffix}`)?.value || '',
                    fermentationLog: Array.from(container.querySelectorAll(`#fermentationTable${suffix} tbody tr`)).map(row => ({
                        date: row.cells[0].querySelector('input').value,
                        temp: row.cells[1].querySelector('input').value,
                        sg: row.cells[2].querySelector('input').value,
                        notes: row.cells[3].querySelector('input').value,
                    })),
                    agingNotes: container.querySelector(`#agingNotes${suffix}`)?.value || '',
                    bottlingNotes: container.querySelector(`#bottlingNotes${suffix}`)?.value || '',
                    tastingNotes: container.querySelector(`#tastingNotes${suffix}`)?.value || '',
                };
            }

function getBrewLogHtml(logData, idSuffix = 'new', parsedTargets = {}) {
    console.log("--- Entering getBrewLogHtml ---"); // ENTRY LOG
    const data = logData || {};

    // Prioritize newly parsed targets directly
    const useTargetOG = parsedTargets.targetOG || data.targetOG || '';
    const useTargetFG = parsedTargets.targetFG || data.targetFG || '';
    const useTargetABV = parsedTargets.targetABV || data.targetABV || ''; // Will be just the number

    console.log(`DEBUG: Final values for log -> OG: ${useTargetOG}, FG: ${useTargetFG}, ABV: ${useTargetABV}`); // DEBUG

    const fermLog = data.fermentationLog || Array.from({ length: 8 }, () => ({}));
    const escapedRecipeName = (data.recipeName || '').replace(/"/g, '&quot;');
    const copyOgToLogScript = `const ogInput = document.getElementById('actualOG-${idSuffix}'); const firstSgInput = document.querySelector('#fermentationTable-${idSuffix} tbody tr:first-child td:nth-child(3) input'); if (ogInput && firstSgInput) { firstSgInput.value = ogInput.value; }`;

    // Ensure the correct variables ARE used in the 'value' attributes below
    return `
        <div class="brew-log-section" data-id="${idSuffix}">
            <h3>Brewmaster's Log</h3>
            <div class="log-grid">
                <div class="log-item"><label for="recipeName-${idSuffix}">Recipe Name:</label><input type="text" id="recipeName-${idSuffix}" value="${escapedRecipeName}"></div>
                <div class="log-item"><label for="brewDate-${idSuffix}">Brew Date:</label><input type="date" id="brewDate-${idSuffix}" value="${data.brewDate || ''}"></div>
            </div>
            <div class="log-grid">
                 <div class="log-item"><label for="targetOG-${idSuffix}">Target OG:</label><input type="text" id="targetOG-${idSuffix}" value="${useTargetOG}" readonly class="bg-app-primary"></div>
                 <div class="log-item">
                    <label for="actualOG-${idSuffix}">Actual OG:</label>
                    <input type="text" id="actualOG-${idSuffix}" value="${data.actualOG || ''}" oninput="${copyOgToLogScript}">
                 </div>
                 <div class="log-item"><label for="targetFG-${idSuffix}">Target FG:</label><input type="text" id="targetFG-${idSuffix}" value="${useTargetFG}" readonly class="bg-app-primary"></div>
                <div class="log-item"><label for="actualFG-${idSuffix}">Actual FG:</label><input type="text" id="actualFG-${idSuffix}" value="${data.actualFG || ''}"></div>
                 <div class="log-item"><label for="targetABV-${idSuffix}">Target ABV:</label><input type="text" id="targetABV-${idSuffix}" value="${useTargetABV}%" readonly class="bg-app-primary"></div>
                <div class="log-item"><label for="finalABV-${idSuffix}">Final ABV:</label><input type="text" id="finalABV-${idSuffix}" value="${data.finalABV || ''}"></div>
            </div>
            <div class="log-item">
                <label>Fermentation Log</label>
                <div class="overflow-x-auto">
                     <table class="fermentation-table table-fixed w-full" id="fermentationTable-${idSuffix}" style="min-width: 500px;">
                        <thead><tr><th style="width: 120px;">Date</th><th style="width: 80px;">Temp (°C)</th><th style="width: 90px;">S.G.</th><th>Notes</th></tr></thead>
                        <tbody>${fermLog.map(row => `<tr>
                                <td><input type="date" value="${row.date || ''}" class="w-full"></td>
                                <td><input type="number" step="0.5" placeholder="18.5" value="${row.temp || '18'}" class="w-full text-center"></td>
                                <td><input type="number" step="0.001" placeholder="1.050" value="${row.sg || ''}" class="w-full text-center"></td>
                                <td><input type="text" value="${row.notes || ''}" class="w-full"></td>
                            </tr>`).join('')}</tbody>
                    </table>
                </div>
            </div>
            <div class="log-item"><label for="agingNotes-${idSuffix}">Aging & Conditioning Notes:</label><textarea id="agingNotes-${idSuffix}" rows="4" placeholder="...">${data.agingNotes || ''}</textarea></div>
            <div class="log-item"><label for="bottlingNotes-${idSuffix}">Bottling / Kegging Notes:</label><textarea id="bottlingNotes-${idSuffix}" rows="3" placeholder="...">${data.bottlingNotes || ''}</textarea></div>
            <div class="log-item"><label for="tastingNotes-${idSuffix}">Final Tasting Notes:</label><textarea id="tastingNotes-${idSuffix}" rows="6" placeholder="...">${data.tastingNotes || ''}</textarea></div>
        </div>
    `;
}
            // --- Functie voor de Actieve Batch Tijdlijn ---
function renderActiveBrewTimeline() {
    const card = document.getElementById('current-brew-card');
    if (!card) return;

    // Zoek de meest recente actieve (niet-gebottelde) brouwsel
    const activeBrew = brews.find(b => b.logData && b.logData.brewDate && b.logData.brewDate !== '' && !b.isBottled);

    if (!activeBrew) {
        card.classList.add('hidden');
        return;
    }

    const now = new Date();
    const brewDate = new Date(activeBrew.logData.brewDate);
    const daysFermenting = (now - brewDate) / (1000 * 60 * 60 * 24);

    // Bepaal de stadia en de voortgang
    const stages = [
        { name: 'Brew Day', day: 0 },
        { name: 'Primary End', day: 21 }, // Gemiddeld einde van primaire gisting
        { name: 'Aging', day: 60 }, // Een ijkpunt voor rijpen
        { name: 'Bottling Ready', day: 90 } // Indicatie dat het klaar zou kunnen zijn
    ];
    
    let statusText = `Day ${Math.round(daysFermenting)}: `;
    if (daysFermenting < stages[1].day) {
        statusText += "Primary Fermentation";
    } else if (daysFermenting < stages[2].day) {
        statusText += "Secondary / Clearing";
    } else {
        statusText += "Aging";
    }

    // Bereken de voortgang in procenten voor de progress bar
    const totalDuration = stages[stages.length - 1].day;
    const progressPercentage = Math.min(100, (daysFermenting / totalDuration) * 100);

    let timelineItemsHtml = '';
    stages.forEach((stage) => {
        const isActive = daysFermenting >= stage.day;
        timelineItemsHtml += `
            <div class="timeline-item ${isActive ? 'active' : ''}">
                <div class="timeline-node"></div>
                <div class="timeline-label">${stage.name}</div>
            </div>
        `;
    });

    card.innerHTML = `
        <h3 class="text-xl font-header font-bold mb-1">${activeBrew.recipeName}</h3>
        <p class="text-app-secondary mb-4">${statusText}</p>
        <div class="timeline-container">
            <div class="timeline-connector">
                <div class="timeline-progress" style="width: ${progressPercentage}%;"></div>
            </div>
            ${timelineItemsHtml}
        </div>
    `;

    card.classList.remove('hidden');
}

            function updateNextActionWidget() {
    const widget = document.getElementById('next-action-widget');
    const list = document.getElementById('next-action-list');
    if (!widget || !list) return;

    const widgetTitle = widget.querySelector('h3');
    if (widgetTitle) widgetTitle.textContent = "What's next?";

    list.innerHTML = '';
    const suggestions = [];
    const now = new Date();
    now.setHours(0,0,0,0);
    const twentyFourHoursAgo = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

    // Suggestion 1: Recently saved recipe
    if (brews.length > 0) {
        const newestBrew = brews[0];
        if (newestBrew.createdAt.toDate() > twentyFourHoursAgo && !newestBrew.isBottled) {
             suggestions.push(`
                <li>
                    You recently saved the recipe '<strong>${newestBrew.recipeName}</strong>'.
                    <button onclick="window.generateShoppingList('${newestBrew.id}')" class="text-blue-600 hover:underline font-semibold ml-2">Create shopping list</button> or
                    <button onclick="window.startBrewDay('${newestBrew.id}')" class="text-green-600 hover:underline font-semibold ml-1">Start brew day!</button>
                </li>
             `);
        }
    }

    // Suggestion 2: Mead fermenting for a while
    const fermentingBrews = brews.filter(b => b.logData && b.logData.brewDate && !b.isBottled && b.logData.brewDate !== '');
    if (fermentingBrews.length > 0) {
        fermentingBrews.forEach(brew => {
            const brewDate = new Date(brew.logData.brewDate);
            if (!isNaN(brewDate.getTime())) {
                const daysFermenting = (now - brewDate) / (1000 * 60 * 60 * 24);
                if (daysFermenting > 18 && !brew.logData.actualFG) {
                    suggestions.push(`
                        <li>
                            '<strong>${brew.recipeName}</strong>' has been fermenting for ${Math.round(daysFermenting)} days. Time for an SG reading?
                            <button onclick="window.showBrewDetail('${brew.id}')" class="text-blue-600 hover:underline font-semibold ml-2">View Log</button>
                        </li>
                    `);
                }
            }
        });
    }
    
    // Suggestion 3: Batch in cellar nearing peak
    if (cellar.length > 0) {
        cellar.forEach(item => {
            if(item.peakFlavorDate) {
                const peakDate = new Date(item.peakFlavorDate);
                 if (!isNaN(peakDate.getTime())) {
                    const daysUntilPeak = (peakDate - now) / (1000 * 60 * 60 * 24);
                    if(daysUntilPeak <= 14 && daysUntilPeak > -30) {
                         suggestions.push(`
                            <li>
                                The '<strong>${item.recipeName}</strong>' in your cellar is nearing its peak! Maybe it's time for a tasting?
                            </li>
                        `);
                    }
                }
            }
        });
    }

    // Suggestion 4: Expiring inventory
    if (inventory.length > 0) {
        inventory.forEach(item => {
            if (item.expirationDate) {
                const expDate = new Date(item.expirationDate);
                const daysUntilExp = (expDate - now) / (1000 * 60 * 60 * 24);
                if (daysUntilExp >= 0 && daysUntilExp <= 30) {
                    suggestions.push(`
                        <li>
                            <span class="text-amber-600 dark:text-amber-400">Warning:</span> Your <strong>${item.name}</strong> is expiring in ${Math.round(daysUntilExp)} days!
                        </li>
                    `);
                }
            }
        });
    }

    if (suggestions.length > 0) {
        list.innerHTML = suggestions.slice(0, 3).join('');
        widget.classList.remove('hidden');
    } else {
        widget.classList.add('hidden');
    }
}
            
            // --- Brew Day Assistant Functions ---
            window.startBrewDay = async function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    // Navigeer eerst naar de shopping list om de ingrediënten te controleren
    switchMainView('brewing');
    switchSubView('shopping-list', 'brewing-main-view');
    generateShoppingList(brewId, false);
}

function renderBrewDay(brewId) {
    // Behandel het geval waar er geen actieve brouwdag is
    if (brewId === 'none') {
        document.getElementById('brew-day-content').innerHTML = `<h2 class="text-3xl font-header font-bold mb-4 text-center">Brew Day 1 - Primary Fermentation</h2><p class="text-center text-app-secondary/80">Select a new recipe from your History to start a new brew day.</p>`;
        return;
    }

    // Zoek het brouwsel op basis van ID
    const brew = brews.find(b => b.id === brewId);
    const brewDayContent = document.getElementById('brew-day-content');
    if (!brew) {
        brewDayContent.innerHTML = `<p class="text-center text-red-500">Could not find the selected brew. Please start a new one.</p>`;
        return;
    }

    // Haal de primaire stappen op (of een lege array)
    const primarySteps = brew.brewDaySteps || [];
    if (primarySteps.length === 0) {
         brewDayContent.innerHTML = `<h2 class="text-3xl font-header font-bold mb-4 text-center">${brew.recipeName || 'Brew Day'}</h2><p class="text-center text-app-secondary/80">Could not find Primary Fermentation steps for this recipe.</p>`;
         return;
    }

    // Genereer de HTML voor elke stap in de checklist
    let stepsHtml = primarySteps.map((step, index) => {
        const isCompleted = currentBrewDay.checklist[`step-${index}`] || false;
        const timerHtml = step.duration > 0 ? `<p class="timer-display my-2" id="timer-${index}">${formatTime(step.duration)}</p>` : '';
        const buttonsHtml = step.duration > 0 ? `
            <button data-action="startTimer" data-step="${index}" class="text-sm bg-green-600 text-white py-1 px-3 rounded-lg hover:bg-green-700 btn">Start Timer</button>
        ` : `
            <button data-action="completeStep" data-step="${index}" class="text-sm bg-blue-600 text-white py-1 px-3 rounded-lg hover:bg-blue-700 btn">Mark as Complete</button>
        `;

        return `
            <div id="step-${index}" class="step-item p-4 rounded-r-lg mb-3 ${isCompleted ? 'completed' : ''}">
                <div>
                    <p class="step-title">${index + 1}. ${step.title}</p>
                    <p class="text-sm text-app-secondary">${step.description}</p>
                    <div class="mt-4">
                        ${timerHtml}
                        <div class="space-x-2" id="controls-${index}">
                            ${isCompleted ? '<span class="text-sm font-bold text-green-600">✓ Completed</span>' : buttonsHtml}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // --- Genereer Log HTML ZONDER target values ---
    const parsedRecipeTargets = parseRecipeData(brew.recipeMarkdown); // Gebruik een aparte naam
    console.log("renderBrewDay - Parsed Targets before passing to getBrewLogHtml:", parsedRecipeTargets); // DEBUG
    // Geef de geparste targets door aan getBrewLogHtml
    const logHtml = getBrewLogHtml(brew.logData, brew.id, parsedRecipeTargets);

    // --- Zet de volledige HTML in de pagina ---
    brewDayContent.innerHTML = `
        <h2 class="text-3xl font-header font-bold mb-4 text-center">${brew.recipeName || 'Brew Day'}</h2>
        <div class="mb-4">
            <div class="progress-bar-bg w-full h-2 rounded-full">
                <div id="brew-day-progress" class="progress-bar-fg h-2 rounded-full" style="width: 0%;"></div>
            </div>
        </div>
        <div id="brew-day-steps-container">
            ${stepsHtml}
        </div>
        <div class="text-center mt-6">
            <button data-action="resetBrewDay" class="text-sm bg-red-600 text-white py-2 px-4 rounded-lg hover:bg-red-700 btn">Reset and Start Over</button>
        </div>
        <hr class="my-8 border-app">
        ${logHtml} {/* Log HTML wordt hier ingevoegd */}
        <div class="mt-4 no-print">
            <button onclick="window.updateBrewLog('${brew.id}')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg hover:opacity-90 btn">Save Log Changes</button>
        </div>
    `;

    // Initialiseer de status van de checklist (welke stap actief is, etc.)
    initializeBrewDayState(primarySteps);
}

function renderBrewDay2() {
    const view = document.getElementById('brew-day-2-view');
    if (!view) return;

    // Vind alle brouwsels die gestart zijn maar nog niet gebotteld
    const secondaryBrews = brews.filter(b => b.primaryComplete && !b.isBottled);

    if (secondaryBrews.length === 0) {
        view.innerHTML = `
            <div class="bg-app-secondary p-6 md:p-8 rounded-lg shadow-lg">
                <h2 class="text-3xl font-header font-bold mb-4 text-center">Secondary / Aging</h2>
                <p class="text-center text-app-secondary/80">You have no batches currently in the secondary or aging phase.</p>
            </div>
        `;
        return;
    }

    const listHtml = secondaryBrews.map(brew => {
        const brewDate = new Date(brew.logData.brewDate);
        const daysInFermentation = Math.floor((new Date() - brewDate) / (1000 * 60 * 60 * 24));
        return `
            <div class="p-4 card rounded-lg cursor-pointer hover:bg-app-primary" onclick="window.showBrewDay2Detail('${brew.id}')">
                <h4 class="font-bold text-lg font-header">${brew.recipeName || 'Untitled Brew'}</h4>
                <p class="text-sm text-app-secondary/80">Started on: ${brewDate.toLocaleDateString()} (${daysInFermentation} days ago)</p>
            </div>
        `;
    }).join('');

    view.innerHTML = `
        <div class="bg-app-secondary p-6 md:p-8 rounded-lg shadow-lg">
            <h2 class="text-3xl font-header font-bold mb-6 text-center">Secondary / Aging</h2>
            <div id="brew-day-2-list" class="space-y-4">
                ${listHtml}
            </div>
        </div>
    `;
}

window.showBrewDay2Detail = function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    currentBrewDay = userSettings.currentBrewDay?.brewId === brewId ? userSettings.currentBrewDay : { brewId: brewId, checklist: {} };

    const view = document.getElementById('brew-day-2-view');
    const secondarySteps = brew.secondarySteps || [];
    const stepOffset = (brew.brewDaySteps || []).length; // Start telling vanaf het einde van de primaire stappen

    let secondaryStepsHtml = '<p class="text-center text-app-secondary/80">No specific secondary steps found for this recipe. Ready to bottle?</p>';
    if (secondarySteps.length > 0) {
        secondaryStepsHtml = secondarySteps.map((step, index) => {
            const originalIndex = stepOffset + index;
            const isCompleted = currentBrewDay.checklist[`step-${originalIndex}`] || false;

            const timerHtml = step.duration > 0 ? `<p class="timer-display my-2" id="timer-${originalIndex}">${formatTime(step.duration)}</p>` : '';
            const buttonsHtml = step.duration > 0 ? `
                <button data-action="startTimer" data-step="${originalIndex}" class="text-sm bg-green-600 text-white py-1 px-3 rounded-lg hover:bg-green-700 btn">Start Timer</button>
            ` : `
                <button data-action="completeStep" data-step="${originalIndex}" class="text-sm bg-blue-600 text-white py-1 px-3 rounded-lg hover:bg-blue-700 btn">Mark as Complete</button>
            `;

            return `
                <div id="step-${originalIndex}" class="step-item p-4 rounded-r-lg mb-3 ${isCompleted ? 'completed' : ''}">
                    <div>
                        <p class="step-title">${originalIndex + 1}. ${step.title}</p>
                        <p class="text-sm text-app-secondary">${step.description}</p>
                        <div class="mt-4">
                            ${timerHtml}
                            <div class="space-x-2" id="controls-${originalIndex}">
                                ${isCompleted ? '<span class="text-sm font-bold text-green-600">✓ Completed</span>' : buttonsHtml}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    const logHtml = getBrewLogHtml(brew.logData, brew.id);

    view.innerHTML = `
        <div class="bg-app-secondary p-6 md:p-8 rounded-lg shadow-lg">
            <button onclick="renderBrewDay2()" class="mb-4 text-app-brand hover:underline no-print">&larr; Back to Secondary List</button>
            <h2 class="text-3xl font-header font-bold mb-4 text-center">${brew.recipeName}</h2>
            <div class="mb-6">
                <h3 class="text-xl font-header mb-2">Remaining Steps</h3>
                <div id="brew-day-steps-container">${secondaryStepsHtml}</div>
            </div>
            <div class="text-center my-6">
                <button onclick="window.showBottlingModal('${brew.id}')" class="bg-app-action text-white font-bold py-3 px-4 rounded-lg hover:opacity-90 btn">
                    Bottle This Batch
                </button>
            </div>
            <hr class="my-8 border-app">
            ${logHtml}
            <div class="mt-4 no-print">
                <button onclick="window.updateBrewLog('${brew.id}')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg hover:opacity-90 btn">Save Log Changes</button>    
            </div>
        </div>
    `;
}

            window.deleteBrew = async function(brewId) {
                if (!userId) return;
                const brewToDelete = brews.find(b => b.id === brewId);
                if (!brewToDelete) return;
                if (!confirm(`Are you sure you want to permanently delete the recipe "${brewToDelete.recipeName}"? This action cannot be undone.`)) return;

                try {
                    const appId = 'meandery-aa05e';
                    const brewDocRef = doc(db, 'artifacts', appId, 'users', userId, 'brews', brewId);
                    await deleteDoc(brewDocRef);
                    showToast(`Recipe "${brewToDelete.recipeName}" has been deleted.`, 'success');
                    goBackToHistoryList();
                } catch (error) {
                    console.error("Error deleting brew:", error);
                    showToast("An error occurred while deleting the recipe.", 'error');
                }
            }

            // --- State Management voor de Brouwdag Timer ---
            let brewDaySteps = [];
            let currentStepIndex = 0;
            let stepTimerInterval = null;
            let remainingTime = 0;

            // --- Gecentraliseerde Event Listener voor de Brouwdag ---
            function setupBrewDayEventListeners() {
    // AANGEPAST: Luister nu naar de hele 'brewing-main-view' in plaats van enkel 'brew-day-content'
    const viewContainer = document.getElementById('brewing-main-view');
    if (!viewContainer) return;

    viewContainer.addEventListener('click', function(e) {
        const target = e.target.closest('button[data-action]');
        if (!target) return; 

        const action = target.dataset.action;
        const stepIndex = parseInt(target.dataset.step);

        switch(action) {
            case 'startTimer':
                startStepTimer(stepIndex);
                break;
            case 'pauseTimer':
                pauseStepTimer(stepIndex);
                break;
            case 'skipTimer':
                skipTimer(stepIndex);
                break;
            case 'completeStep':
                completeStep(stepIndex, true); // Pass 'true' to indicate a skip
                break;
            case 'resetBrewDay':
                resetBrewDay();
                break;
        }
    });
}

            function parseStepsForBrewDay(markdown) {
                const steps = { primary: [], secondary: [] };
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = marked.parse(markdown);

                const primaryHeader = Array.from(tempDiv.querySelectorAll('h3')).find(h => h.textContent.toLowerCase().includes('primary fermentation'));
                const secondaryHeader = Array.from(tempDiv.querySelectorAll('h3')).find(h => h.textContent.toLowerCase().includes('secondary & aging'));

                // 'parseStepText' is de nieuwe, slimme functie die we in Stap 2 hebben gemaakt.
                
                const processSection = (header, stepArray) => {
                    if (header) {
                        let element = header.nextElementSibling;
                        while (element && element.tagName !== 'H2' && element.tagName !== 'H3') {
                            if (element.tagName === 'OL' || element.tagName === 'UL') {
                                Array.from(element.children).forEach(li => {
                                    if (li.tagName === 'LI') {
                                        const text = li.textContent.trim();
                                        // Geen complexe logica meer.
                                        // De nieuwe parseStepText doet al het werk.
                                        stepArray.push(parseStepText(text));
                                    }
                                });
                            }
                            element = element.nextElementSibling;
                        }
                    }
                };

                processSection(primaryHeader, steps.primary);
                processSection(secondaryHeader, steps.secondary);

                return steps;
            }

            const parseStepText = (text) => {
                let duration = 0;
                let title = text;
                let description = 'Follow the instruction.';

                // Zoek naar de ENIGE betrouwbare tag: [TIMER:HH:MM:SS]
                const timerMatch = text.match(/\[TIMER:(\d{2}):(\d{2}):(\d{2})\]/);

                if (timerMatch) {
                    // Converteer de tag naar seconden
                    const hours = parseInt(timerMatch[1], 10);
                    const minutes = parseInt(timerMatch[2], 10);
                    const seconds = parseInt(timerMatch[3], 10);
                    duration = (hours * 3600) + (minutes * 60) + seconds;
                    
                    // Verwijder de tag uit de zichtbare tekst
                    title = text.replace(timerMatch[0], '').trim();
                }
                
                // Verwijder alle oude, mogelijk storende tags voor de zekerheid
                title = title.replace(/\[d:[\d:]+\]/g, '').trim();

                return { title: title, description: description, duration: duration };
            };


window.saveBrewToHistory = async function() {
    if (!userId || !currentRecipeMarkdown) {
        showToast("Cannot save. No user identified or no recipe generated.", "error");
        return;
    }
    const saveButton = document.getElementById('saveBtn');
    saveButton.textContent = 'Saving...';
    saveButton.disabled = true;

    const totalBatchCost = parseIngredientsAndCalculateCost(currentRecipeMarkdown, inventory, parseFloat(document.getElementById('batchSize').value) || 5);
    const brewDayStepsObject = parseStepsForBrewDay(currentRecipeMarkdown);
    
    const initialLogData = parseRecipeData(currentRecipeMarkdown);
    initialLogData.fermentationLog = Array.from({ length: 8 }, () => ({}));
    
    const batchSize = parseFloat(document.getElementById('batchSize').value) || 5;
    const brewData = {
        userId: userId,
        recipeName: initialLogData.recipeName || "Untitled Brew",
        recipeMarkdown: currentRecipeMarkdown,
        prompt: lastGeneratedPrompt,
        logData: initialLogData,
        createdAt: new Date(),
        batchSize: batchSize,
        totalCost: totalBatchCost,
        isBottled: false,
        primaryComplete: false,
        predictedFlavorProfile: currentPredictedProfile,
        brewDaySteps: brewDayStepsObject.primary,
        secondarySteps: brewDayStepsObject.secondary
    };

    try {
        const appId = 'meandery-aa05e';
        const brewsCol = collection(db, 'artifacts', appId, 'users', userId, 'brews');
        const docRef = await addDoc(brewsCol, brewData);
        
        const buttonContainer = saveButton.parentElement;
        
        // Verberg de "Save" knop na succes
        saveButton.style.display = 'none';

        // Voeg de "Start Brew Day" knop toe
        buttonContainer.innerHTML += `
            <button onclick="window.startBrewDay('${docRef.id}')" class="w-full bg-green-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-green-700 transition-colors btn">
                Start Brew Day
            </button>
        `;

        showToast("Recipe saved to History!", "success");
        promptToUpdateInventory(currentRecipeMarkdown);

    } catch (error) {
        console.error("Error saving brew:", error);
        showToast("Error saving recipe.", "error");
        saveButton.textContent = 'Save to Brew History';
        saveButton.disabled = false;
    }
}

function renderBrewDay(brewId) {
    if (brewId === 'none') {
        document.getElementById('brew-day-content').innerHTML = `<h2 class="text-3xl font-header font-bold mb-4 text-center">Brew Day 1 - Primary Fermentation</h2><p class="text-center text-app-secondary/80">Select a new recipe from your History to start a new brew day.</p>`;
        return;
    }

    const brew = brews.find(b => b.id === brewId);
    const brewDayContent = document.getElementById('brew-day-content');
    if (!brew) {
        brewDayContent.innerHTML = `<p class="text-center text-red-500">Could not find the selected brew. Please start a new one.</p>`;
        return;
    }

    const primarySteps = brew.brewDaySteps || [];
    if (primarySteps.length === 0) {
         brewDayContent.innerHTML = `<h2 class="text-3xl font-header font-bold mb-4 text-center">${brew.recipeName || 'Brew Day'}</h2><p class="text-center text-app-secondary/80">Could not find Primary Fermentation steps for this recipe.</p>`;
         return;
    }

    let stepsHtml = primarySteps.map((step, index) => {
        const isCompleted = currentBrewDay.checklist[`step-${index}`] || false;
        const timerHtml = step.duration > 0 ? `<p class="timer-display my-2" id="timer-${index}">${formatTime(step.duration)}</p>` : '';
        const buttonsHtml = step.duration > 0 ? `
            <button data-action="startTimer" data-step="${index}" class="text-sm bg-green-600 text-white py-1 px-3 rounded-lg hover:bg-green-700 btn">Start Timer</button>
        ` : `
            <button data-action="completeStep" data-step="${index}" class="text-sm bg-blue-600 text-white py-1 px-3 rounded-lg hover:bg-blue-700 btn">Mark as Complete</button>
        `;

        return `
            <div id="step-${index}" class="step-item p-4 rounded-r-lg mb-3 ${isCompleted ? 'completed' : ''}">
                <div>
                    <p class="step-title">${index + 1}. ${step.title}</p>
                    <p class="text-sm text-app-secondary">${step.description}</p>
                    <div class="mt-4">
                        ${timerHtml}
                        <div class="space-x-2" id="controls-${index}">
                            ${isCompleted ? '<span class="text-sm font-bold text-green-600">✓ Completed</span>' : buttonsHtml}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    const parsedTargets = parseRecipeData(brew.recipeMarkdown);
    const combinedLogData = { ...brew.logData, ...parsedTargets };
    const logHtml = getBrewLogHtml(combinedLogData, brew.id);

    brewDayContent.innerHTML = `
        <h2 class="text-3xl font-header font-bold mb-4 text-center">${brew.recipeName || 'Brew Day'}</h2>
        <div class="mb-4">
            <div class="progress-bar-bg w-full h-2 rounded-full">
                <div id="brew-day-progress" class="progress-bar-fg h-2 rounded-full" style="width: 0%;"></div>
            </div>
        </div>
        <div id="brew-day-steps-container">
            ${stepsHtml}
        </div>
        <div class="text-center mt-6">
            <button data-action="resetBrewDay" class="text-sm bg-red-600 text-white py-2 px-4 rounded-lg hover:bg-red-700 btn">Reset and Start Over</button>
        </div>
        <hr class="my-8 border-app">
        ${logHtml}
        <div class="mt-4 no-print">
            <button onclick="window.updateBrewLog('${brew.id}')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg hover:opacity-90 btn">Save Log Changes</button>    
        </div>
    `;

    initializeBrewDayState(primarySteps);
}

// VERVANG DE VOLLEDIGE OUDE showBrewDay2Detail FUNCTIE
window.showBrewDay2Detail = function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    currentBrewDay = userSettings.currentBrewDay?.brewId === brewId ? userSettings.currentBrewDay : { brewId: brewId, checklist: {} };

    const view = document.getElementById('brew-day-2-view');
    const secondarySteps = brew.secondarySteps || [];
    const stepOffset = (brew.brewDaySteps || []).length;

    let secondaryStepsHtml = '<p class="text-center text-app-secondary/80">No specific secondary steps found for this recipe. Ready to bottle?</p>';
    if (secondarySteps.length > 0) {
        secondaryStepsHtml = secondarySteps.map((step, index) => {
            const originalIndex = stepOffset + index;
            const isCompleted = currentBrewDay.checklist[`step-${originalIndex}`] || false;

            const timerHtml = step.duration > 0 ? `<p class="timer-display my-2" id="timer-${originalIndex}">${formatTime(step.duration)}</p>` : '';
            const buttonsHtml = step.duration > 0 ? `
                <button data-action="startTimer" data-step="${originalIndex}" class="text-sm bg-green-600 text-white py-1 px-3 rounded-lg hover:bg-green-700 btn">Start Timer</button>
            ` : `
                <button data-action="completeStep" data-step="${originalIndex}" class="text-sm bg-blue-600 text-white py-1 px-3 rounded-lg hover:bg-blue-700 btn">Mark as Complete</button>
            `;

            return `
                <div id="step-${originalIndex}" class="step-item p-4 rounded-r-lg mb-3 ${isCompleted ? 'completed' : ''}">
                    <div>
                        <p class="step-title">${originalIndex + 1}. ${step.title}</p>
                        <p class="text-sm text-app-secondary">${step.description}</p>
                        <div class="mt-4">
                            ${timerHtml}
                            <div class="space-x-2" id="controls-${originalIndex}">
                                ${isCompleted ? '<span class="text-sm font-bold text-green-600">✓ Completed</span>' : buttonsHtml}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    const logHtml = getBrewLogHtml(brew.logData, brew.id);

    view.innerHTML = `
        <div class="bg-app-secondary p-6 md:p-8 rounded-lg shadow-lg">
            <button onclick="renderBrewDay2()" class="mb-4 text-app-brand hover:underline no-print">&larr; Back to Secondary List</button>
            <h2 class="text-3xl font-header font-bold mb-4 text-center">${brew.recipeName}</h2>
            <div class="mb-6">
                <h3 class="text-xl font-header mb-2">Remaining Steps</h3>
                <div id="brew-day-steps-container">${secondaryStepsHtml}</div>
            </div>
            <div class="text-center my-6">
                <button onclick="window.showBottlingModal('${brew.id}')" class="bg-app-action text-white font-bold py-3 px-4 rounded-lg hover:opacity-90 btn">
                    Bottle This Batch
                </button>
            </div>
            <hr class="my-8 border-app">
            ${logHtml}
            <div class="mt-4 no-print">
                <button onclick="window.updateBrewLog('${brew.id}')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg hover:opacity-90 btn">Save Log Changes</button>    
            </div>
        </div>
    `;
}

            function generateBrewDaySteps(brew) {
                // AANGEPAST: De functie leest nu de betrouwbare, opgeslagen array
                if (!brew.brewDaySteps || brew.brewDaySteps.length === 0) {
                    console.warn("No pre-parsed brew day steps found for this brew.");
                    return [];
                }
                
                // We voegen de standaard voorbereidingsstappen toe aan de geparste lijst
                const prepSteps = [
                    { title: "Prepare Brewing Water", description: "Adjust your water based on the recipe's recommendation.", duration: 600 },
                    { title: "Gather & Weigh Ingredients", description: "Prepare all necessary ingredients.", duration: 0 }
                ];

                const recipeSteps = brew.brewDaySteps.map(step => ({ ...step })); // Kopieer de stappen

                // Post-processing voor relatieve timers (bijv. voor nutrienten)
                let lastNutrientTimeInSeconds = 0;
                recipeSteps.forEach(step => {
                    if (step.title.match(/\d+\s*Hours:/i) && step.duration > 0) {
                        const absoluteDuration = step.duration;
                        step.duration = absoluteDuration - lastNutrientTimeInSeconds;
                        lastNutrientTimeInSeconds = absoluteDuration;
                    }
                });

                return [...prepSteps, ...recipeSteps];
            }

            function initializeBrewDayState(steps) {
                brewDaySteps = steps;
                
                // --- Controleer op een opgeslagen timer ---
                const savedTimer = localStorage.getItem('activeBrewDayTimer');
                if (savedTimer) {
                    const { brewId, stepIndex, endTime } = JSON.parse(savedTimer);
                    
                    // Herstel de timer enkel als het voor de HUIDIGE brouwdag is
                    if (brewId === currentBrewDay.brewId) {
                        const now = Date.now();
                        if (endTime > now) {
                            // Er is een actieve timer, herstart deze
                            currentStepIndex = stepIndex;
                            const remainingSeconds = Math.round((endTime - now) / 1000);
                            startStepTimer(stepIndex, remainingSeconds);
                            updateUI(); // Zorg dat de UI de actieve timer toont
                            return; // Stop de functie hier om de standaard UI-update over te slaan
                        } else {
                            // Timer is verlopen terwijl de app gesloten was
                            localStorage.removeItem('activeBrewDayTimer');
                            currentBrewDay.checklist[`step-${stepIndex}`] = true;
                        }
                    }
                }
                
                const lastCompleted = Object.keys(currentBrewDay.checklist).length - 1;
                currentStepIndex = lastCompleted >= 0 ? lastCompleted + 1 : 0;
                updateUI();
            }

            function startStepTimer(stepIndex, resumeTime = null) {
                if (stepTimerInterval) return; // Start geen nieuwe timer als er al een loopt

                // Zoek de actieve brew op
    const activeBrew = brews.find(b => b.id === currentBrewDay.brewId);
    if (!activeBrew) {
        console.error("Could not find active brew to start timer.");
        return;
    }

    // Combineer alle stappen om de juiste te vinden
    const allSteps = [...(activeBrew.brewDaySteps || []), ...(activeBrew.secondarySteps || [])];
    const step = allSteps[stepIndex];

    if (!step) {
        console.error(`Could not find step data for index ${stepIndex}.`);
        return;
    }

                let timeLeft = resumeTime !== null ? resumeTime : (remainingTime > 0 ? remainingTime : allSteps[stepIndex].duration);
                
                // --- Sla de eindtijd van de timer op ---
                const endTime = Date.now() + timeLeft * 1000;
                const timerState = { brewId: currentBrewDay.brewId, stepIndex: stepIndex, endTime: endTime };
                localStorage.setItem('activeBrewDayTimer', JSON.stringify(timerState));

                const timerDisplay = document.getElementById(`timer-${stepIndex}`);
                const controlsDiv = document.getElementById(`controls-${stepIndex}`);
                
                controlsDiv.innerHTML = `
                    <button data-action="pauseTimer" data-step="${stepIndex}" class="text-sm bg-yellow-500 text-white py-1 px-3 rounded-lg hover:bg-yellow-600 btn">Pause</button>
                    <button data-action="skipTimer" data-step="${stepIndex}" class="text-sm bg-gray-500 text-white py-1 px-3 rounded-lg hover:bg-gray-600 btn">Skip Timer</button>
                `;
                
                stepTimerInterval = setInterval(() => {
                    remainingTime = 0; // Clear the global remaining time
                    timeLeft--;
                    timerDisplay.textContent = formatTime(timeLeft);

                    if (timeLeft <= 0) {
                        clearInterval(stepTimerInterval);
                        stepTimerInterval = null;
                        timerDisplay.textContent = "Done!";
                        new Audio("data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjQwLjEwMQAAAAAAAAAAAAAA//tAnxAAAAAAAAAAAAAAAAAAAAAAAABSUxNfAAAAAAAAAAAAAAAAAAAAAAAASU5GTwMAAAAUAAABowAAAA8AAAB1bml0eS1tZWRpYQAAAAAAAAAAAAAAAAAAAAAAAFQNCj/9oACQAAAAAABn//6w4j/wAANwAD//5L/xO//6s4j/9r/9E4//lVn//V///6/8j/9E5///8R/wD/1P/0j//8//lVn/Vn//6/8j/9E5///8AAAAAQU1QRTGk9f/7QJ8QaSqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq==").play();
                        localStorage.removeItem('activeBrewDayTimer'); // Timer is voltooid
                        completeStep(stepIndex, true);
                    }
                }, 1000);
            }

            function pauseStepTimer(stepIndex) {
                clearInterval(stepTimerInterval);
                stepTimerInterval = null;
                
                // --- Sla de resterende tijd op en verwijder de eindtijd ---
                const timerDisplay = document.getElementById(`timer-${stepIndex}`);
                localStorage.removeItem('activeBrewDayTimer');
                const timeParts = timerDisplay.textContent.split(':');
                if (timeParts.length === 2) {
                    remainingTime = parseInt(timeParts[0]) * 60 + parseInt(timeParts[1]);
                } else if (timeParts.length === 3) {
                    remainingTime = parseInt(timeParts[0]) * 3600 + parseInt(timeParts[1]) * 60 + parseInt(timeParts[2]);
                }

                const controlsDiv = document.getElementById(`controls-${stepIndex}`);
                controlsDiv.innerHTML = `<button data-action="startTimer" data-step="${stepIndex}" class="text-sm bg-green-600 text-white py-1 px-3 rounded-lg hover:bg-green-700 btn">Resume</button>`;
            }


function skipTimer(stepIndex) {
    // Clear the timer interval and reset state (no change)
    clearInterval(stepTimerInterval);
    stepTimerInterval = null;
    remainingTime = 0;
    localStorage.removeItem('activeBrewDayTimer');

    // --- Update UI for the SKIPPED step ---
    const stepDiv = document.getElementById(`step-${stepIndex}`);
    if (stepDiv) {
        stepDiv.classList.remove('active'); // Remove active state
        stepDiv.classList.add('completed');   // Add completed state

        const controlsDiv = document.getElementById(`controls-${stepIndex}`);
        if (controlsDiv) {
            // Replace buttons with "Completed" text
            controlsDiv.innerHTML = `<span class="text-sm font-bold text-green-600">✓ Completed</span>`;
        }
        // Update timer display if it exists, though it might already be cleared
        const timerDisplay = document.getElementById(`timer-${stepIndex}`);
        if (timerDisplay) {
             timerDisplay.textContent = "Skipped"; // Or "Completed"
        }
    }

    // Now call completeStep to handle saving state and activating the next step (no change)
    completeStep(stepIndex, true);
}

            function resetBrewDay() {
                if (confirm("Are you sure you want to reset your progress for this brew day?")) {
                    currentBrewDay.checklist = {};
                    saveChecklistState();
                    
                    // --- Verwijder een eventuele actieve timer ---
                    clearInterval(stepTimerInterval);
                    stepTimerInterval = null;
                    remainingTime = 0;
                    localStorage.removeItem('activeBrewDayTimer');

                    renderBrewDay(currentBrewDay.brewId);
                }
            }

async function completeStep(stepIndex, isSkipping = false) {
    // --- Timer Cleanup (No Change) ---
    if (stepTimerInterval) {
        clearInterval(stepTimerInterval);
        stepTimerInterval = null;
        remainingTime = 0;
        localStorage.removeItem('activeBrewDayTimer');
    }

    // --- Mark Step Complete & Save (No Change) ---
    currentBrewDay.checklist[`step-${stepIndex}`] = true;
    await saveChecklistState();

    // --- Update UI for CURRENT Step (No Change) ---
    const stepDiv = document.getElementById(`step-${stepIndex}`);
    if (stepDiv) {
        stepDiv.classList.remove('active');
        stepDiv.classList.add('completed');
        const controlsDiv = document.getElementById(`controls-${stepIndex}`);
        if (controlsDiv) {
            controlsDiv.innerHTML = `<span class="text-sm font-bold text-green-600">✓ Completed</span>`;
        }
    }

    // --- START OF NEW LOGIC ---

    // 1. Find the active brew data
    const activeBrew = brews.find(b => b.id === currentBrewDay.brewId);
    if (!activeBrew) return;

    // 2. Get data for the step JUST completed
    const allSteps = [...(activeBrew.brewDaySteps || []), ...(activeBrew.secondarySteps || [])];
    const completedStepData = allSteps[stepIndex];

    // 3. Check if the COMPLETED step itself has a timer duration
    if (completedStepData && completedStepData.duration > 0 && !isSkipping) {
        // YES, this step initiates a wait. Start its timer immediately.
        // We pass the index of the completed step itself to startStepTimer now.
        startStepTimer(stepIndex);
        // We don't activate the next step yet; it becomes active when the timer finishes.
        return; // Stop further processing for this step completion
    }

    // 4. If the completed step DID NOT have a timer, activate the NEXT step (if it exists)
    const nextStepIndex = stepIndex + 1;
    const nextStepData = allSteps[nextStepIndex];
    const nextStepDiv = document.getElementById(`step-${nextStepIndex}`);

    if (nextStepData && nextStepDiv) {
        // Activate the next step normally
        nextStepDiv.classList.add('active');
    } else {
        // No next step exists, this was the last step of the phase.
        // Handle end-of-phase logic (e.g., mark primary complete)
        const brew = brews.find(b => b.id === currentBrewDay.brewId);
        const primaryStepCount = (brew.brewDaySteps || []).length;

        if (stepIndex === primaryStepCount - 1) { // Check if it was the last *primary* step
             await markPrimaryAsComplete(currentBrewDay.brewId);

             const allStepsContainer = stepDiv?.closest('[id$="-steps-container"]'); // Use optional chaining
             if (allStepsContainer) {
                 allStepsContainer.innerHTML += `
                    <div class="text-center p-6 card rounded-lg mt-6">
                        <h3 class="text-2xl font-header font-bold text-green-600">Phase 1 Complete!</h3>
                        <p class="my-2">Great! The primary fermentation steps are done.</p>
                        <p class="text-app-secondary mb-4">The next steps for this batch can now be found on the 'Brew Day 2' tab.</p>
                        <button onclick="window.finalizeBrewDay1()" class="bg-app-action text-white font-bold py-2 px-4 rounded-lg hover:opacity-90 btn">
                            Go to Brew Day 2
                        </button>
                    </div>
                `;
             }
        }
        // Add similar logic here if needed for the end of secondary steps
    }
    // --- END OF NEW LOGIC ---
}

function updateUI() {
    const progress = (currentStepIndex / brewDaySteps.length) * 100;
    const progressBar = document.getElementById('brew-day-progress');
    if (progressBar) {
        progressBar.style.width = `${progress}%`;
    }

    brewDaySteps.forEach((step, index) => {
        const stepDiv = document.getElementById(`step-${index}`);
        if (!stepDiv) return;

        const controlsDiv = document.getElementById(`controls-${index}`);
        stepDiv.classList.remove('active', 'completed');

        if (index < currentStepIndex) {
            stepDiv.classList.add('completed');
            if (controlsDiv) {
                controlsDiv.innerHTML = `<span class="text-sm font-bold text-green-600">✓ Completed</span>`;
            }
        } else if (index === currentStepIndex) {
            stepDiv.classList.add('active');
        }
    });
}

async function markPrimaryAsComplete(brewId) {
    if (!userId || !brewId) return;
    try {
        const brewDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId);
        await updateDoc(brewDocRef, { primaryComplete: true });
        
        // Update ook de lokale data onmiddellijk
        const brewIndex = brews.findIndex(b => b.id === brewId);
        if (brewIndex > -1) {
            brews[brewIndex].primaryComplete = true;
        }
    } catch (error) {
        console.error("Could not mark primary as complete:", error);
    }
}

window.finalizeBrewDay1 = async function() {
    // Stap 1: Bouw de inhoud van de (nog verborgen) Brew Day 2 weergave opnieuw op.
    renderBrewDay2();

    // Stap 2: Schakel nu pas over naar de weergave om deze zichtbaar te maken.
    window.switchSubView('brew-day-2', 'brewing-main-view');

    // Stap 3: Reset de Brew Day 1 status
    currentBrewDay = { brewId: null, checklist: {} };
    await saveUserSettings(); // Sla de lege status op in de database

    // Stap 4: Maak de Brew Day 1 view visueel leeg voor de volgende batch
    renderBrewDay('none');
}

            function formatTime(seconds) {
                if (isNaN(seconds) || seconds < 0) return "00:00";
                const h = Math.floor(seconds / 3600);
                const m = Math.floor((seconds % 3600) / 60);
                const s = seconds % 60;
                if (h > 0) {
                    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                }
                return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            }
   
            // --- Analysis Functions ---
// --- VERVANG JE VOLLEDIGE generateShoppingList FUNCTIE MET DEZE ---
window.generateShoppingList = function(brewId, navigate = false) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    const listState = brew.shoppingListState || {};

    const convertToBaseUnit = (quantity, unit) => {
        const u = unit.toLowerCase();
        if (u === 'kg') return { quantity: quantity * 1000, unit: 'g' };
        if (u === 'l') return { quantity: quantity * 1000, unit: 'ml' };
        return { quantity, unit: u };
    };

    const requiredIngredients = parseIngredientsFromMarkdown(brew.recipeMarkdown);
    const shoppingList = [];

    requiredIngredients.forEach(req => {
        const invItem = inventory.find(inv => inv.name.toLowerCase() === req.name.toLowerCase());
        const requiredAmount = convertToBaseUnit(req.quantity, req.unit);
        let stockAmount = { quantity: 0, unit: requiredAmount.unit };

        if (invItem) {
            stockAmount = convertToBaseUnit(invItem.qty, invItem.unit);
            if (stockAmount.unit !== requiredAmount.unit) {
                console.warn(`Unit mismatch for ${req.name}`);
            }
        }

        if (!invItem || stockAmount.quantity < requiredAmount.quantity) {
            let toBuy = requiredAmount.quantity - stockAmount.quantity;
            let unitToDisplay = req.unit;
            if (req.unit.toLowerCase() === 'g' && toBuy >= 1000) { 
                toBuy /= 1000;
                unitToDisplay = 'kg';
            } else if (req.unit.toLowerCase() === 'ml' && toBuy >= 1000) { 
                toBuy /= 1000;
                unitToDisplay = 'L';
            }
            shoppingList.push({ name: req.name, quantity: toBuy, unit: unitToDisplay });
        }
    });

    const contentDiv = document.getElementById('shopping-list-content');
    let html = `<h4 class="text-xl font-header mb-4">${brew.recipeName} - Shopping List</h4>`;
    
    if (shoppingList.length > 0) {
            html += `<div id="shopping-list-items" class="space-y-2">`;
            html += shoppingList.map((item, index) => {
                const displayQty = Number.isInteger(item.quantity) ? item.quantity : item.quantity.toFixed(2);
                const isChecked = listState[item.name] || false;
                const escapedItemName = item.name.replace(/'/g, "\\'");

                return `
                    <div class="flex items-center">
                        <input type="checkbox" id="shop-item-${index}" 
                               onchange="window.updateShoppingListItemStatus('${brew.id}', '${escapedItemName}', this.checked)" 
                               class="h-5 w-5 rounded border-gray-300 text-app-brand focus:ring-app-brand flex-shrink-0"
                               ${isChecked ? 'checked' : ''}>
                        <label for="shop-item-${index}" class="ml-3 text-app-primary">${item.name}: ${displayQty} ${item.unit}</label>
                    </div>
                `;
            }).join('');
            html += `</div>`;
            
            html += `
                <div class="mt-6 pt-4 border-t border-app">
                    <button id="add-to-inventory-btn" onclick="window.addMissingItemsToInventory('${brew.id}')" class="w-full bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 btn text-sm">
                        Add Missing Items to Inventory (as 0 qty)
                    </button>
                </div>
            `;

            html += `<div id="start-brew-day-container" class="mt-6 text-center hidden">
                    <p class="text-green-600 dark:text-green-400 font-semibold mb-2">All items acquired!</p>
                    <button onclick="window.startActualBrewDay('${brew.id}')" class="w-full bg-green-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-green-700 btn">Let's Start Brewing!</button>
                 </div>`;
    } else {
            html += `<p class="text-green-600 dark:text-green-400 font-semibold mb-4">You have all the ingredients you need!</p>`;
            html += `<button onclick="window.startActualBrewDay('${brew.id}')" class="w-full bg-green-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-green-700 btn">Let's Start Brewing!</button>`;
    }

    contentDiv.innerHTML = html;
    
    if (navigate) {
        switchMainView('brewing');
        switchSubView('shopping-list', 'brewing-main-view');
    }
    
    checkShoppingList(brewId);
}

            window.updateShoppingListItemStatus = async function(brewId, ingredientName, isChecked) {
                if (!userId) return;
                const brew = brews.find(b => b.id === brewId);
                if (!brew) return;

                // Initialiseer de shoppingListState als deze nog niet bestaat
                if (!brew.shoppingListState) {
                    brew.shoppingListState = {};
                }
                // Update de status voor het specifieke ingrediënt
                brew.shoppingListState[ingredientName] = isChecked;

                try {
                    // Sla de bijgewerkte staat op in Firestore
                    const brewDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId);
                    await updateDoc(brewDocRef, {
                        shoppingListState: brew.shoppingListState
                    });
                    
                    // Roep de bestaande functie aan om te controleren of de "Start Brew Day" knop getoond moet worden
                    checkShoppingList(brewId);

                } catch (error) {
                    console.error("Error updating shopping list state:", error);
                    showToast("Could not save shopping list status.", "error");
                }
            }

            window.addMissingItemsToInventory = async function(brewId) {
                const brew = brews.find(b => b.id === brewId);
                if (!brew || !userId) return;

                const addButton = document.getElementById('add-to-inventory-btn');
                addButton.disabled = true;
                addButton.textContent = 'Adding...';

                const requiredIngredients = parseIngredientsFromMarkdown(brew.recipeMarkdown);
                const missingItems = [];

                requiredIngredients.forEach(req => {
                    const invItem = inventory.find(inv => inv.name.toLowerCase() === req.name.toLowerCase());
                    // Voeg enkel toe als het item VOLLEDIG ontbreekt in de inventaris
                    if (!invItem) {
                        missingItems.push({ name: req.name, unit: req.unit });
                    }
                });

                if (missingItems.length === 0) {
                    showToast("All items already exist in your inventory.", "info");
                    addButton.textContent = 'No New Items to Add';
                    return;
                }

                const batch = writeBatch(db);
                const appId = 'meandery-aa05e';
                const invCol = collection(db, 'artifacts', appId, 'users', userId, 'inventory');

                missingItems.forEach(item => {
                    const newItemRef = doc(invCol);
                    // Probeer een categorie af te leiden, anders gebruik 'Adjunct'
                    let category = 'Adjunct';
                    const nameLower = item.name.toLowerCase();
                    if (nameLower.includes('honey')) category = 'Honey';
                    else if (nameLower.includes('yeast')) category = 'Yeast';
                    else if (nameLower.includes('malt')) category = 'Malt Extract';
                    else if (nameLower.includes('fermaid') || nameLower.includes('go-ferm')) category = 'Nutrient';
                    
                    const newItemData = {
                        userId: userId,
                        name: item.name,
                        qty: 0,
                        unit: item.unit.toLowerCase(),
                        price: 0,
                        category: category,
                        expirationDate: null
                    };
                    batch.set(newItemRef, newItemData);
                });

                try {
                    await batch.commit();
                    showToast(`${missingItems.length} missing item(s) added to inventory. You can now update their quantity and price.`, 'success');
                    addButton.textContent = 'Added to Inventory!';
                    generateShoppingList(brewId, false); 
                } catch (error) {
                    console.error("Error adding missing items to inventory:", error);
                    showToast("Could not add items to inventory.", "error");
                    addButton.disabled = false;
                    addButton.textContent = 'Add Missing Items to Inventory (as 0 qty)';
                }
            } 

window.checkShoppingList = function(brewId) {
    const checkboxes = document.querySelectorAll('#shopping-list-items input[type="checkbox"]');
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);

    const container = document.getElementById('start-brew-day-container');
    if (container) { // Voer de code enkel uit als de container bestaat
        container.classList.toggle('hidden', !allChecked);
    }
}

window.startActualBrewDay = async function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    // --- NIEUWE LOGICA: Zet de datum hier ---
    if (!brew.logData.brewDate) {
        brew.logData.brewDate = new Date().toISOString().split('T')[0];
        try {
            const brewDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId);
            await updateDoc(brewDocRef, { logData: brew.logData });
            // Forceer een update van de lokale data, zodat de Brew Day 2 lijst direct correct is.
            const brewIndex = brews.findIndex(b => b.id === brewId);
            if (brewIndex > -1) {
                brews[brewIndex].logData.brewDate = brew.logData.brewDate;
            }
            showToast("Brew date set to today!", "info");
        } catch (error) {
            console.error("Could not auto-set brew date:", error);
        }
    }

    window.switchSubView('brew-day-1', 'brewing-main-view');
    currentBrewDay = { brewId: brewId, checklist: {} };
    saveUserSettings();
    renderBrewDay(brewId);
}

            // --- Social Media Functies ---

            window.generateSocialContent = async function(brewId) {
                const socialView = document.getElementById('social-view');
                socialView.dataset.brewId = brewId; // Sla de brewId op voor later gebruik

                switchMainView('tools');
                switchSubView('social', 'tools-main-view');

                runSocialMediaGenerator(); 
            }

            async function runSocialMediaGenerator() {
                const selectedBrewId = document.getElementById('social-recipe-select').value;
                if (!selectedBrewId) {
                    alert("Please select a recipe from the dropdown list first.");
                    return;
                }
                const brew = brews.find(b => b.id === selectedBrewId);
                if (!brew) {
                    alert("Could not find the selected recipe data.");
                    return;
                }
                document.getElementById('social-output-container').classList.remove('hidden');
                const socialContainer = document.getElementById('social-content-container');
                const imageContainer = document.getElementById('social-image-container');
                socialContainer.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">Your buddy is writing a post for you...</p>';
                imageContainer.innerHTML = '';
                const persona = document.getElementById('social-persona').value;
                const platform = document.getElementById('social-platform').value;
                const tweak = document.getElementById('social-tweak').value;
                const negativeConstraint = " CRUCIAL: Do not wrap your response in a markdown code block using triple backticks (```).";
                let personaPrompt = "You are an homebrewer sharing your passion.";
                if (persona === 'pro_brewery') personaPrompt = "You are a social media expert for a professional craft brewery.";
                else if (persona === 'sommelier') personaPrompt = "You are a knowledgeable mead sommelier, focusing on tasting notes and pairings.";
                let platformPrompt = "Generate a short, engaging Instagram post. Use relevant emojis and hashtags." + negativeConstraint;
                if (platform === 'untappd_checkin') platformPrompt = "Generate a descriptive PERSONAL check-in description for Untappd. Write from a first-person perspective (e.g., 'I get notes of...'). Focus on aroma, appearance, taste, and mouthfeel. Do not use hashtags." + negativeConstraint;
                else if (platform === 'untappd_description') platformPrompt = "Generate an official, commercial description for a new mead to be added to Untappd. The description should be objective, informative, and appealing, detailing the style, key ingredients, and expected flavor profile. This is NOT a personal check-in. Do not use hashtags." + negativeConstraint;
                let tweakPrompt = tweak.trim() !== '' ? `An additional instruction from the user is: "${tweak}". You must follow this instruction.` : "";
                const finalPrompt = `${personaPrompt} ${platformPrompt} ${tweakPrompt} Base the content on the following mead recipe:\n\n---\n${brew.recipeMarkdown}\n---\nFormat the entire response in Markdown.`;
                try {
                    const socialMarkdown = await performApiCall(finalPrompt);
                    let processedMarkdown = socialMarkdown.trim();
                    if (processedMarkdown.startsWith("```markdown")) processedMarkdown = processedMarkdown.substring(10, processedMarkdown.lastIndexOf("```")).trim();
                    else if (processedMarkdown.startsWith("```")) processedMarkdown = processedMarkdown.substring(3, processedMarkdown.lastIndexOf("```")).trim();
                    const socialHtml = marked.parse(processedMarkdown);
                    
                    // AANGEPAST: Voeg de save knop toe
                    // PLAK DEZE NIEUWE CODE
socialContainer.innerHTML = `
    <div>${socialHtml}</div>
    <div class="mt-6 space-y-2">
        <button id="trigger-image-generation-btn" class="w-full bg-purple-700 text-white font-bold py-2 px-4 rounded-lg hover:bg-purple-800 btn">
            Generate Image (Uses Credits)
        </button>
        <button id="save-social-post-btn" onclick="window.saveSocialPost()" class="w-full bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 btn text-sm">
            Save Post to Recipe Notes
        </button>
    </div>
`;

document.getElementById('trigger-image-generation-btn').addEventListener('click', function(e) {
    generateSocialImage(brew.recipeName, processedMarkdown);
    e.target.style.display = 'none'; // Verberg de knop na het klikken
});
                } catch (error) {
                    console.error("Error generating social content:", error);
                    socialContainer.innerHTML = `<p class="text-center text-red-500">Could not generate social post: ${error.message}</p>`;
                }
            }

            async function runManualSocialMediaGenerator() {
                const socialContainer = document.getElementById('social-content-container');
                const imageContainer = document.getElementById('social-image-container');
                const manualInput = document.getElementById('manual-social-input').value;
                if (!manualInput.trim()) {
                    alert("Voer eerst een onderwerp in om een post te genereren.");
                    return;
                }
                document.getElementById('social-output-container').classList.remove('hidden');
                socialContainer.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">Je buddy schrijft een nieuw bericht voor je...</p>';
                imageContainer.innerHTML = '';
                const persona = document.getElementById('social-persona').value;
                const platform = document.getElementById('social-platform').value;
                const tweak = document.getElementById('social-tweak').value;
                const negativeConstraint = " CRUCIAL: Do not wrap your response in a markdown code block using triple backticks (```).";
                let personaPrompt = "You are an enthusiastic homebrewer sharing your passion.";
                if (persona === 'pro_brewery') personaPrompt = "You are a social media expert for a professional craft brewery.";
                else if (persona === 'sommelier') personaPrompt = "You are a knowledgeable mead sommelier, focusing on tasting notes and pairings.";
                let platformPrompt = "Generate a short, engaging Instagram post. Use relevant emojis and hashtags." + negativeConstraint;
                if (platform === 'untappd_checkin') platformPrompt = "Generate a descriptive PERSONAL check-in description for Untappd. Write from a first-person perspective. Focus on aroma, appearance, taste, and mouthfeel. Do not use hashtags." + negativeConstraint;
                else if (platform === 'untappd_description') platformPrompt = "Generate an official, commercial description for a new mead to be added to Untappd. The description should be objective and informative. This is NOT a personal check-in. Do not use hashtags." + negativeConstraint;
                let tweakPrompt = tweak.trim() !== '' ? `An additional instruction from the user is: "${tweak}". You must follow this instruction.` : "";
                const finalPrompt = `${personaPrompt} ${platformPrompt} ${tweakPrompt} Base the content on the following topic or description provided by the user:\n\n---\n${manualInput}\n---\nFormat the entire response in Markdown.`;
                try {
                    const socialMarkdown = await performApiCall(finalPrompt);
                    let processedMarkdown = socialMarkdown.trim();
                    if (processedMarkdown.startsWith("```markdown")) processedMarkdown = processedMarkdown.substring(10, processedMarkdown.lastIndexOf("```")).trim();
                    else if (processedMarkdown.startsWith("```")) processedMarkdown = processedMarkdown.substring(3, processedMarkdown.lastIndexOf("```")).trim();
                    const socialHtml = marked.parse(processedMarkdown);

                    // AANGEPAST: Voeg de save knop toe
                    // PLAK DEZE NIEUWE CODE
socialContainer.innerHTML = `
    <div>${socialHtml}</div>
    <div class="mt-6 space-y-2">
        <button id="trigger-image-generation-btn" class="w-full bg-purple-700 text-white font-bold py-2 px-4 rounded-lg hover:bg-purple-800 btn">
            Generate Image (Uses Credits)
        </button>
        <button id="save-social-post-btn" onclick="window.saveSocialPost()" class="w-full bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 btn text-sm">
            Save Post to Recipe Notes
        </button>
    </div>
`;

document.getElementById('trigger-image-generation-btn').addEventListener('click', function(e) {
    generateSocialImage(manualInput, processedMarkdown);
    e.target.style.display = 'none'; // Verberg de knop na het klikken
});
                } catch (error) {
                    console.error("Error generating manual social content:", error);
                    socialContainer.innerHTML = `<p class="text-center text-red-500">Kon geen social media post genereren: ${error.message}</p>`;
                }
            }

function populateSocialRecipeDropdown() {
    const select = document.getElementById('social-recipe-select');
    if (!select) return;

    // Bewaar de huidige selectie
    const currentValue = select.value;
    
    select.innerHTML = '<option value="">-- Choose a Recipe --</option>'; // Reset
    
    brews.forEach(brew => {
        const option = document.createElement('option');
        option.value = brew.id;
        option.textContent = brew.recipeName;
        select.appendChild(option);
    });

    // Herstel de selectie indien mogelijk
    select.value = currentValue;
}

            async function generateSocialImage(title, description) {
    const imageContainer = document.getElementById('social-image-container');
    imageContainer.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">Your buddy is painting a masterpiece...</p>';

    const imageApiKey = userSettings.imageApiKey;
    if (!imageApiKey) {
        imageContainer.innerHTML = `<p class="text-center text-red-500">Please enter your Image Generation API key in the Settings page first.</p>`;
        return;
    }

    const imagePrompt = `You are an AI image generation expert. Create a short, descriptive, powerful prompt for an image generator based on the following mead. The prompt should be in English. The final image should be a high-quality, photorealistic shot of the mead in a bottle or glass, styled for a professional product advertisement.
    
    Mead Title: "${title}"
    Description: "${description}"

    Generate ONLY the image prompt itself, focusing on visual elements.`;

    try {
        const generatedImagePrompt = await performApiCall(imagePrompt);
        
        const engineId = 'stable-diffusion-xl-1024-v1-0';
        const apiHost = 'https://api.stability.ai';
        const apiUrl = `${apiHost}/v1/generation/${engineId}/text-to-image`;
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${imageApiKey}`
            },
            body: JSON.stringify({
                text_prompts: [
                    {
                        "text": `A photorealistic image of: ${generatedImagePrompt}, cinematic lighting, high detail, commercial photography`
                    }
                ],
                cfg_scale: 7,
                height: 1024,
                width: 1024,
                steps: 30,
                samples: 1,
            }),
        });

        if (!response.ok) {
            throw new Error(`Stability AI request failed with status ${response.status}: ${await response.text()}`);
        }

        const result = await response.json();

        if (result.artifacts && result.artifacts[0] && result.artifacts[0].base64) {
            const imageData = result.artifacts[0].base64;
            const imageSrc = `data:image/png;base64,${imageData}`;

            imageContainer.innerHTML = `
                <img src="${imageSrc}" alt="AI-generated image for ${title}" class="rounded-lg mx-auto shadow-lg">
                <p class="text-xs text-app-secondary/80 mt-2"><strong>Image Prompt:</strong> ${generatedImagePrompt}</p>
                <p class="text-xs text-app-secondary/60 mt-1">Generated with Stable Diffusion</p>
            `;
        } else {
            throw new Error("Invalid image data in Stability AI response.");
        }

    } catch (error) {
        console.error("Error generating social image:", error);
        imageContainer.innerHTML = `<p class="text-center text-red-500">Could not generate image: ${error.message}</p>`;
    }
}

// --- VERVANG JE VOLLEDIGE parseIngredientsFromMarkdown FUNCTIE MET DEZE ---
function parseIngredientsFromMarkdown(markdown) {
    const ingredients = [];

    // Poging 1: Zoek naar een JSON-blok (de nieuwe, robuuste methode)
    const jsonRegex = /```json\s*([\s\S]*?)\s*```/;
    const jsonMatch = markdown.match(jsonRegex);

    if (jsonMatch && jsonMatch[1]) {
        try {
            const ingredientsArray = JSON.parse(jsonMatch[1]);
            return ingredientsArray.map(item => ({
                name: (item.ingredient || '').trim(),
                quantity: parseFloat(item.quantity) || 0,
                unit: (item.unit || '').trim()
            }));
        } catch (e) {
            console.error("Failed to parse JSON block, falling back to table parser.", e);
        }
    }

    // Poging 2: Fallback naar de oude tabel-parser
    const tableContentRegex = /\|-+\|.*\n([\s\S]*?)(?:\n\n|##|$)/;
    const match = markdown.match(tableContentRegex);

    if (!match || !match[1]) {
        console.warn("Definitive parser could not find ingredient table content.");
        return ingredients; // Geef lege lijst terug als beide methodes falen
    }

    const rows = match[1].trim().split('\n').filter(row => row.trim().startsWith('|'));
    rows.forEach(row => {
        const columns = row.split('|').map(c => c.trim()).slice(1, 4);
        if (columns.length === 3) {
            const [name, quantityStr, unit] = columns;
            const quantity = parseFloat(quantityStr);
            if (name && !isNaN(quantity)) {
                ingredients.push({ name: name.trim(), quantity: quantity, unit: (unit || '').trim() });
            }
        }
    });

    return ingredients;
}

            // getPackagingCosts FUNCTIE
            function getPackagingCosts() {
                const calculatedCosts = {};
    
                PACKAGING_ITEMS.forEach(item => {
                    const itemData = packagingCosts[item.id];
                    let costPerUnit = 0;
                    if (itemData && itemData.qty > 0 && itemData.price > 0) {
                        costPerUnit = itemData.price / itemData.qty;
                    }
        
                    // Specifieke mapping voor de bottel-logica
                    if (item.id === 'bottle_750') calculatedCosts['750'] = costPerUnit;
                    if (item.id === 'bottle_500') calculatedCosts['500'] = costPerUnit;
                    if (item.id === 'bottle_450') calculatedCosts['450'] = costPerUnit; // <-- NIEUW
                    if (item.id === 'bottle_330') calculatedCosts['330'] = costPerUnit;
                    if (item.id === 'bottle_250') calculatedCosts['250'] = costPerUnit;
                    if (item.id === 'cork') calculatedCosts['cork'] = costPerUnit;
                    if (item.id === 'crown_cap_26') calculatedCosts['crown_cap_26'] = costPerUnit; // <-- AANGEPAST
                    if (item.id === 'crown_cap_29') calculatedCosts['crown_cap_29'] = costPerUnit; // <-- NIEUW
                    if (item.id === 'label') calculatedCosts['label'] = costPerUnit;
                });
 
                return calculatedCosts;
            }

            function updateCostAnalysis() {
    const currency = userSettings.currencySymbol || '€';
    // Berekening inventariswaarde blijft hetzelfde
    const totalSpend = inventory.reduce((acc, item) => acc + (item.price || 0), 0);
    document.getElementById('total-spend').textContent = `${currency}${totalSpend.toFixed(2)}`;

    // NIEUW: Bereken de totale kelderwaarde
    const packagingCostsPerUnit = getPackagingCosts();

const totalCellarValue = cellar.reduce((totalValue, cellarItem) => {
    const originalBrew = brews.find(b => b.id === cellarItem.brewId);
    if (!originalBrew) return totalValue; // Sla over als het originele brouwsel niet is gevonden

    const ingredientCostPerLiter = (cellarItem.ingredientCost || 0) / (originalBrew.batchSize || 1);

    const valueOfThisCellarItem = cellarItem.bottles.reduce((itemValue, bottle) => {
        if (bottle.quantity <= 0) return itemValue; // Sla flessen over die niet meer op voorraad zijn

        const meadCostInBottle = ingredientCostPerLiter * (bottle.size / 1000);

        const bottleCost = packagingCostsPerUnit[bottle.size.toString()] || 0;
        let closureCost = 0;
        if (bottle.size >= 750) { closureCost = packagingCostsPerUnit.cork || 0; }
        else if (bottle.size >= 500) { closureCost = packagingCostsPerUnit.crown_cap_29 || 0; }
        else { closureCost = packagingCostsPerUnit.crown_cap_26 || 0; }
        const labelCost = packagingCostsPerUnit.label || 0;

        const singleBottleTotalCost = meadCostInBottle + bottleCost + closureCost + labelCost;

        return itemValue + (singleBottleTotalCost * bottle.quantity);
    }, 0);

    return totalValue + valueOfThisCellarItem;
}, 0);

document.getElementById('total-cellar-value').textContent = `${currency}${totalCellarValue.toFixed(2)}`;
    document.getElementById('total-cellar-value').textContent = `${currency}${totalCellarValue.toFixed(2)}`;

    // De rest van de functie (grafiek) blijft hetzelfde
    const spendByCategory = inventory.reduce((acc, item) => {
        acc[item.category] = (acc[item.category] || 0) + (item.price || 0);
        return acc;
    }, {});
    const ctx = document.getElementById('cost-chart').getContext('2d');
    const chartData = {
        labels: Object.keys(spendByCategory),
        datasets: [{
            label: 'Spend by Category',
            data: Object.values(spendByCategory),
            backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#C9CBCF', '#7BC225'],
        }]
    };
    if (costChart) { costChart.destroy(); }
    costChart = new Chart(ctx, { type: 'doughnut', data: chartData, options: { /* ... */ } });
}

            function renderFermentationGraph(brewId) {
                const brew = brews.find(b => b.id === brewId);
                // Zorg ervoor dat er logdata is met geldige waarden
                if (!brew || !brew.logData || !brew.logData.fermentationLog) return;

                const logData = brew.logData.fermentationLog
                    .filter(entry => entry.date && entry.sg) // Filter op entries die een datum en SG hebben
                    .sort((a, b) => new Date(a.date) - new Date(b.date)); // Sorteer op datum

                if (logData.length < 2) return; // We hebben minstens 2 punten nodig voor een lijn

                const labels = logData.map(entry => new Date(entry.date).toLocaleDateString());
                const sgData = logData.map(entry => parseFloat(entry.sg));

                const canvasId = `fermChart-${brewId}`;
                const ctx = document.getElementById(canvasId);
                if (!ctx) return; // Stop als de canvas niet gevonden kan worden

                // Verwijder een eventuele oude grafiek voordat we een nieuwe tekenen
                if (window.fermChartInstances && window.fermChartInstances[canvasId]) {
                window.fermChartInstances[canvasId].destroy();
                }
                if (!window.fermChartInstances) {
                window.fermChartInstances = {};
           }

                const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-primary');
                const borderColor = getComputedStyle(document.documentElement).getPropertyValue('--border-color');
                const brandColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-color');

                window.fermChartInstances[canvasId] = new Chart(ctx.getContext('2d'), {
                    type: 'line',
                    data: {
                        labels: labels,
                        datasets: [{
                        label: 'Specific Gravity (SG)',
                        data: sgData,
                        borderColor: brandColor,
                        backgroundColor: brandColor + '33', // Transparante vulling
                        tension: 0.1,
                        fill: true,
                    }]
                 },
                 options: {
                     responsive: true,
                     plugins: {
                         title: { display: false },
                         legend: { display: false }
                     },
                     scales: {
                         x: {
                             ticks: { color: textColor },
                             grid: { color: borderColor }
                         },
                         y: {
                            title: {
                                display: true,
                                text: 'Specific Gravity',
                                color: textColor
                     },
                     ticks: { 
                         color: textColor,
                         // Formatteer de y-as labels (bv. 1.050)
                         callback: function(value) { return value.toFixed(3); }
                     },
                     grid: { color: borderColor }
                 }
             }
         }
     });
 }

            // --- Troubleshooter Functions ---
            async function getTroubleshootingAdvice() {
                const description = document.getElementById('troubleshoot-description').value;
                const outputDiv = document.getElementById('troubleshoot-output');

                if (!description.trim()) {
                    outputDiv.innerHTML = `<p class="text-red-500">Please describe your problem first.</p>`;
                    return;
                }

                outputDiv.innerHTML = '<div class="loader"></div>';
                
                const prompt = `You are an expert mead maker and troubleshooter. A user is having a problem with their mead. Their description of the problem is: "${description}". Provide a step-by-step guide to help them diagnose the issue. Ask clarifying questions they should answer for themselves, suggest potential causes, and offer clear, actionable solutions. Format the response in Markdown.`;

                try {
                    const adviceMarkdown = await performApiCall(prompt);
                    outputDiv.innerHTML = marked.parse(adviceMarkdown);
                } catch (error) {
                    console.error("Error getting troubleshooting advice:", error);
                    outputDiv.innerHTML = `<p class="text-center text-red-500">Could not get advice: ${error.message}</p>`;
                }
            }

            // --- Label Generator Functies ---
            function handleLogoUpload(event) {
                const file = event.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = function(e) {
                        const logoPreview = document.getElementById('label-logo-preview');
                        logoPreview.src = e.target.result;
                        logoPreview.classList.remove('hidden');
                        
                        // Maak de 'verwijder' knop zichtbaar
                        document.getElementById('removeLogoBtn').classList.remove('hidden');

                        updateLabelPreview();
                    }
                    reader.readAsDataURL(file);
                }
            }

            function removeLogo() {
                const logoPreview = document.getElementById('label-logo-preview');
                const logoUploadInput = document.getElementById('logoUpload');
                const removeBtn = document.getElementById('removeLogoBtn');

                // Verberg de preview en reset de bron
                logoPreview.src = '';
                logoPreview.classList.add('hidden');

                // Reset de waarde van het file input veld
                logoUploadInput.value = '';

                // Verberg de 'verwijder' knop weer
                removeBtn.classList.add('hidden');
                
                updateLabelPreview();
            }  

            function updateLabelPreview() {
                const select = document.getElementById('labelRecipeSelect');
                const selectedBrew = brews.find(b => b.id === select.value);
                const fullTitle = (select.options[select.selectedIndex] && select.value) ? select.options[select.selectedIndex].text : 'Mead Name';

                let namePart = fullTitle;
                if (fullTitle.includes(':')) { namePart = fullTitle.split(':')[0]; } 
                else if (fullTitle.includes(' - ')) { namePart = fullTitle.split(' - ')[0]; }
                
                document.getElementById('label-name-preview').textContent = namePart;
                document.getElementById('label-style-preview').textContent = document.getElementById('labelStyle').value || 'Style / Subtitle';
                
                const date = document.getElementById('labelDate').value || 'Bottling Date';
                const abv = document.getElementById('labelAbv').value || 'ABV';
                const volValue = parseFloat(document.getElementById('labelVol').value);
                const vol = !isNaN(volValue) ? (volValue >= 1000 ? `${(volValue / 1000).toFixed(1)} L` : `${volValue} ml`) : 'VOL';

                document.getElementById('label-date-preview').textContent = date;
                document.getElementById('label-abv-preview').textContent = abv;
                document.getElementById('label-vol-preview').textContent = vol;

                const allergensContainer = document.getElementById('label-allergens-container');
                const ogContainer = document.getElementById('label-og-preview');
                const fgContainer = document.getElementById('label-fg-preview');
                const yeastContainer = document.getElementById('label-yeast-preview');

                if (selectedBrew) {
                    ogContainer.textContent = selectedBrew.logData?.targetOG || 'N/A';
                    fgContainer.textContent = selectedBrew.logData?.actualFG || selectedBrew.logData?.targetFG || 'N/A';
                    const ingredients = parseIngredientsFromMarkdown(selectedBrew.recipeMarkdown);
                    yeastContainer.textContent = ingredients.find(i => i.name.toLowerCase().includes('yeast'))?.name.replace('Yeast','').trim() || 'N/A';

                    const allergens = [];
                    const markdown = selectedBrew.recipeMarkdown.toLowerCase();
                    if (markdown.includes('metabisulfite')) allergens.push('sulfites');
                    if (markdown.includes('lactose')) allergens.push('lactose');
                    if (markdown.includes('barley') || markdown.includes('malt')) allergens.push('gluten');

                    if (allergens.length > 0) {
                        allergensContainer.innerHTML = `Contains: <strong>${allergens.join(', ')}</strong>`;
                        allergensContainer.classList.remove('hidden');
                    } else {
                        allergensContainer.classList.add('hidden');
                    }
                } else {
                    if (allergensContainer) allergensContainer.classList.add('hidden');
                }
            }

            function switchLabelStyle(styleName) {
                const labelPreview = document.getElementById('label-preview');
                
                // Wissel de stijl-class op de preview zelf
                labelPreview.classList.remove('label-minimalist', 'label-industrial', 'label-professional');
                labelPreview.classList.add(`label-${styleName}`);

                // Werk de actieve status van de knoppen bij
                document.querySelectorAll('.label-style-btn').forEach(btn => {
                    const isSelected = btn.dataset.style === styleName;
                    
                    // Verwijder eerst alle mogelijke status-classes
                    btn.classList.remove('border-2', 'border-app-brand', 'text-app-brand', 'border', 'border-app');
                    
                    if (isSelected) {
                        // Voeg de 'actieve' classes toe aan de geselecteerde knop
                        btn.classList.add('border-2', 'border-app-brand', 'text-app-brand');
                    } else {
                        // Voeg de standaard 'inactieve' classes toe aan de andere knoppen
                        btn.classList.add('border', 'border-app');
                    }
                });
            }

            function setLabelOrientation(orientation) {
                // Update de actieve status van de knoppen
                document.querySelectorAll('.orientation-btn').forEach(btn => {
                    const isSelected = btn.dataset.orientation === orientation;
                    btn.classList.toggle('active', isSelected);
                    btn.classList.toggle('border-2', isSelected);
                    btn.classList.toggle('border-app-brand', isSelected);
                    btn.classList.toggle('text-app-brand', isSelected);
                    btn.classList.toggle('border', !isSelected);
                    btn.classList.toggle('border-app', !isSelected);
                });
                // Roep de functie aan die de preview bijwerkt
                updatePreviewAspectRatio();
            }

            function updatePreviewAspectRatio() {
                const previewDiv = document.getElementById('label-preview');
                const formatSelector = document.getElementById('labelFormatSelect');
                if (!previewDiv || !formatSelector) return;

                // Bepaal de actieve oriëntatie
                const orientation = document.querySelector('.orientation-btn.active')?.dataset.orientation || 'vertical';

                let format;
                if (formatSelector.value === 'custom') {
                    format = {
                        width_mm: parseFloat(document.getElementById('customWidth').value) || 1,
                        height_mm: parseFloat(document.getElementById('customHeight').value) || 1,
                    };
                } else {
                    format = labelFormats[formatSelector.value];
                }

                if (format && format.width_mm && format.height_mm) {
                    if (orientation === 'horizontal') {
                        // Gebruik de normale verhouding voor een liggende (horizontale) weergave
                        previewDiv.style.aspectRatio = `${format.width_mm} / ${format.height_mm}`;
                    } else {
                        // Wissel de breedte en hoogte voor een staande (verticale) weergave
                        previewDiv.style.aspectRatio = `${format.height_mm} / ${format.width_mm}`;
                    }
                }
            }

            function generatePrintPage() {
                const labelHTML = document.getElementById('label-preview').outerHTML;
                const formatSelector = document.getElementById('labelFormatSelect');
                let format;

                if (formatSelector.value === 'custom') {
                    format = {
                        width_mm: parseFloat(document.getElementById('customWidth').value),
                        height_mm: parseFloat(document.getElementById('customHeight').value),
                        cols: parseInt(document.getElementById('customCols').value),
                        rows: parseInt(document.getElementById('customRows').value),
                        top_margin_mm: parseFloat(document.getElementById('customMarginTop').value),
                        left_margin_mm: parseFloat(document.getElementById('customMarginLeft').value),
                    }
                } else {
                    format = labelFormats[formatSelector.value];
                }

                const totalLabels = format.cols * format.rows;
                let printContent = '';
                for (let i = 0; i < totalLabels; i++) {
                    printContent += labelHTML.replace('id="label-preview"', `class="print-label ${labelPreview.className}"`);
                }

                const newWindow = window.open('', '_blank');
                newWindow.document.write(`
                    <html>
                        <head>
                            <title>Print Labels - ${format.name || 'Custom'}</title>
                            <style>
                                @page { size: A4; margin: 0; }
                                body { margin: 0; }
                                .print-container {
                                    display: grid;
                                    grid-template-columns: repeat(${format.cols}, 1fr);
                                    gap: 0;
                                    padding-top: ${format.top_margin_mm}mm;
                                    padding-left: ${format.left_margin_mm}mm;
                                    width: 210mm;
                                    height: 297mm;
                                    box-sizing: border-box;
                                }
                                .print-label {
                                    width: ${format.width_mm}mm;
                                    height: ${format.height_mm}mm;
                                    box-sizing: border-box;
                                    overflow: hidden;
                                }
                                ${document.querySelector('style').innerHTML}
                            </style>
                        </head>
                        <body>
                            <div class="print-container">${printContent}</div>
                        </body>
                    </html>
                `);
                newWindow.document.close();
                newWindow.focus();
                setTimeout(() => { newWindow.print(); }, 500);
            }


function populateLabelRecipeDropdown() {
    const select = document.getElementById('labelRecipeSelect');
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="">-- Choose a Saved Recipe --</option>';
    brews.forEach(brew => {
        const option = document.createElement('option');
        option.value = brew.id;

        // Splits de titel en gebruik alleen het deel vóór de dubbele punt of het streepje.
        let displayName = brew.recipeName || 'Untitled Brew';
        if (displayName.includes(':')) {
            displayName = displayName.split(':')[0].trim();
        } else if (displayName.includes(' - ')) {
            displayName = displayName.split(' - ')[0].trim();
        }
        option.textContent = displayName;
        
        select.appendChild(option);
    });
    select.value = currentValue;
}

            // --- VERVANG JE VOLLEDIGE handleLabelRecipeSelect FUNCTIE MET DEZE ---
function handleLabelRecipeSelect(event) {
    const brewId = event.target.value;
    const styleInput = document.getElementById('labelStyle');
    const abvInput = document.getElementById('labelAbv');
    const volInput = document.getElementById('labelVol');
    const dateInput = document.getElementById('labelDate');
    
    if (!brewId) {
        // Maak velden leeg als de gebruiker "-- Choose --" selecteert
        if(styleInput) styleInput.value = '';
        if(abvInput) abvInput.value = '';
        if(volInput) volInput.value = '';
        if(dateInput) dateInput.value = '';
        updateLabelPreview();
        return;
    }

    const selectedBrew = brews.find(b => b.id === brewId);
    if (!selectedBrew) return;

    // Haal de volledige titel uit de originele data, niet uit de dropdown.
    const fullTitle = selectedBrew.recipeName;
    let subtitlePart = '';

    if (fullTitle.includes(':')) {
        const parts = fullTitle.split(/:\s*(.*)/s);
        subtitlePart = parts[1] || '';
    } else if (fullTitle.includes(' - ')) {
        const parts = fullTitle.split(/\s*-\s*(.*)/s);
        subtitlePart = parts[1] || '';
    }

    // Vul de input-velden in
    if(styleInput) styleInput.value = subtitlePart;
    if(abvInput) abvInput.value = selectedBrew.logData?.finalABV?.replace('%','') || selectedBrew.logData?.targetABV?.replace('%','') || '';
    if(volInput) volInput.value = selectedBrew.batchSize ? selectedBrew.batchSize * 1000 : '750';
    if(dateInput) dateInput.value = selectedBrew.createdAt ? selectedBrew.createdAt.toDate().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : '';
    
    // Update de visuele preview
    updateLabelPreview();
}

            function updateLabelPreview() {
                // Haal alle elementen op
                const namePreview = document.getElementById('label-name-preview');
                const stylePreview = document.getElementById('label-style-preview');
                const abvPreview = document.getElementById('label-abv-preview');
                const volPreview = document.getElementById('label-vol-preview');
                const datePreview = document.getElementById('label-date-preview');
                const ogPreview = document.getElementById('label-og-preview');
                const fgPreview = document.getElementById('label-fg-preview');
                const allergensContainer = document.getElementById('label-allergens-container');
                const select = document.getElementById('labelRecipeSelect');
                const styleInput = document.getElementById('labelStyle');
                
                // --- Update naam en ondertitel ---
                const selectedOption = select.options[select.selectedIndex];
                const fullTitle = (selectedOption && selectedOption.value) ? selectedOption.text : 'Mead Name';
                let namePart = fullTitle;

                if (fullTitle.includes(':')) {
                    namePart = fullTitle.split(':')[0];
                } else if (fullTitle.includes(' - ')) {
                    namePart = fullTitle.split(' - ')[0];
                }
                
                if(namePreview) namePreview.textContent = namePart;
                if(stylePreview) stylePreview.textContent = styleInput.value || 'Style / Subtitle';
                
                // --- Update overige details ---
                if(abvPreview) abvPreview.textContent = document.getElementById('labelAbv').value || 'ABV';
                if(volPreview) {
                    const volInput = document.getElementById('labelVol');
                    const volValue = parseFloat(volInput.value);
                    if (!isNaN(volValue)) {
                        volPreview.textContent = volValue >= 1000 ? `${(volValue / 1000).toFixed(1)} L` : `${volValue} ml`;
                    } else {
                        volPreview.textContent = 'VOL';
                    }
                }
                if(datePreview) datePreview.textContent = document.getElementById('labelDate').value || 'Bottling Date';

                // --- Update Professional velden en Allergenen ---
                const selectedBrew = brews.find(b => b.id === select.value);
                if (selectedBrew) {
                    if(ogPreview) ogPreview.textContent = selectedBrew.logData?.targetOG || 'N/A';
                    if(fgPreview) fgPreview.textContent = selectedBrew.logData?.actualFG || selectedBrew.logData?.targetFG || 'N/A';
                    
                    // --- Allergenen logica ---
                    const allergens = [];
                    const markdown = selectedBrew.recipeMarkdown.toLowerCase();
                    if (markdown.includes('metabisulfite')) allergens.push('sulfites');
                    if (markdown.includes('lactose') || markdown.includes('milk sugar')) allergens.push('lactose');
                    if (markdown.includes('barley') || markdown.includes('wheat') || markdown.includes('malt')) allergens.push('gluten');

                    if (allergens.length > 0 && allergensContainer) {
                        allergensContainer.innerHTML = `Contains: <strong>${allergens.join(', ')}</strong>`;
                        allergensContainer.classList.remove('hidden');
                    } else if (allergensContainer) {
                        allergensContainer.innerHTML = '';
                        allergensContainer.classList.add('hidden');
                    }
                } else {
                    if(ogPreview) ogPreview.textContent = 'OG';
                    if(fgPreview) fgPreview.textContent = 'FG';
                    if(allergensContainer) allergensContainer.classList.add('hidden');
                }
            }

// Toont het invoerveld en verbergt de titel
window.showTitleEditor = function(brewId) {
    document.getElementById(`title-display-${brewId}`).classList.add('hidden');
    document.getElementById(`title-editor-${brewId}`).classList.remove('hidden');
    document.getElementById(`title-input-${brewId}`).focus();
}

// Verbergt het invoerveld en toont de titel weer
window.hideTitleEditor = function(brewId) {
    document.getElementById(`title-display-${brewId}`).classList.remove('hidden');
    document.getElementById(`title-editor-${brewId}`).classList.add('hidden');
}

// Slaat de nieuwe titel op in Firestore
window.saveNewTitle = async function(brewId) {
    if (!userId) return;
    const newTitle = document.getElementById(`title-input-${brewId}`).value.trim();
    if (!newTitle) {
        showToast("Title cannot be empty.", "error");
        return;
    }

    try {
        const appId = 'meandery-aa05e';
        const brewDocRef = doc(db, 'artifacts', appId, 'users', userId, 'brews', brewId);
        await updateDoc(brewDocRef, { recipeName: newTitle });

        // Update de lokale data en UI onmiddellijk voor een snelle respons
        const brew = brews.find(b => b.id === brewId);
        if (brew) brew.recipeName = newTitle;
        
        document.querySelector(`#title-display-${brewId} h2`).textContent = newTitle;
        hideTitleEditor(brewId);
        renderHistoryList(); // Ververs de lijstweergave
        showToast("Recipe title updated!", "success");

    } catch (error) {
        console.error("Error updating title:", error);
        showToast("Could not update title.", "error");
    }
}            
            // --- Start the App ---
            // Wacht tot de volledige HTML-pagina is geladen voordat het script wordt uitgevoerd.
            document.addEventListener('DOMContentLoaded', (event) => {
                initApp();
            });

        })(); // End of IIFE