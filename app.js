import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, doc, updateDoc, query, deleteDoc, getDoc, setDoc, writeBatch, getDocs, arrayUnion, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// --- CRUCIAAL: Importeer je sleutels ---
import CONFIG from './secrets.js';

// --- App State Variables ---
let db, auth, userId;
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
let packagingCosts = {}; 

async function saveBrewToHistory(recipeText, flavorProfile) {
    if (!auth.currentUser) return;
    try {
        // AANPASSING: We gebruiken nu hardcoded 'meandery-aa05e' en 'brews' 
        // zodat het matcht met de rest van de app (loadHistory).
        const historyRef = collection(db, 'artifacts', 'meandery-aa05e', 'users', auth.currentUser.uid, 'brews');
        
        await addDoc(historyRef, {
            recipeName: extractTitle(recipeText) || "Untitled Brew", // Extra helper om titel te pakken
            recipeMarkdown: recipeText, // We noemen het nu recipeMarkdown voor consistentie
            flavorProfile: flavorProfile || {},
            createdAt: serverTimestamp(), // Belangrijk voor het sorteren
            logData: {}, // Leeg logboek initialiseren
            checklist: {}, // Lege checklist initialiseren
            model: userSettings.aiModel || "gemini-1.5-flash-001"
        });
        showToast("Recipe saved to history!", "success");
    } catch (error) {
        console.error("Save error:", error);
        showToast("Could not save: " + error.message, "error");
    }
}

// Klein hulpfunctie'tje om de titel uit de markdown te vissen (voor de lijstweergave)
function extractTitle(markdown) {
    const match = markdown.match(/^#\s*(.*)/m);
    return match ? match[1].trim() : null;
}
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

let userWaterProfiles = []; 
const BUILT_IN_WATER_PROFILES = { 
    spa: { name: 'Spa Reine', ca: 5, mg: 2, na: 3, so4: 4, cl: 5, hco3: 17 },
    chaudfontaine: { name: 'Chaudfontaine', ca: 65, mg: 18, na: 44, so4: 40, cl: 35, hco3: 305 },
};

// --- Helper Functions (Toast & UI) ---

function showToast(message, type = 'info', duration = 4000) {
    let backgroundColor;
    switch(type) {
        case 'success': backgroundColor = "linear-gradient(to right, #22c55e, #16a34a)"; break;
        case 'error': backgroundColor = "linear-gradient(to right, #ef4444, #dc2626)"; break;
        default: backgroundColor = "linear-gradient(to right, #3b82f6, #2563eb)";
    }
    Toastify({
        text: message.replace(/\n/g, '<br>'),
        duration: duration,
        close: true,
        gravity: "top",
        position: "right",
        stopOnFocus: true,
        escapeMarkup: false,
        style: { 
            background: backgroundColor,
            borderRadius: "4px",
            fontFamily: "'Barlow Semi Condensed', sans-serif",
            boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
            fontWeight: "600",
            textTransform: "uppercase",
            fontSize: "0.85rem",
            letterSpacing: "0.05em",
            padding: "12px 20px"
        }
    }).showToast();
}

// --- UI UTILITY: THE DIAMOND LOADER ---
window.getLoaderHtml = function(message = "Initializing Protocol...") {
    return `
        <div class="flex flex-col items-center justify-center py-8">
            <svg class="honeycomb-loader" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                <polygon class="honeycomb-core" points="50 25, 72 37, 72 63, 50 75, 28 63, 28 37" />
                <path class="honeycomb-path" d="M 50 5 L 90 27 L 90 73 L 50 95 L 10 73 L 10 27 Z" />
            </svg>
            <p id="loader-text" class="text-center text-app-secondary/80 font-header tracking-wide animate-pulse mt-2 text-sm uppercase">${message}</p>
        </div>
    `;
}

// --- UI UTILITY: DYNAMIC THINKING PROCESS ---
window.startThinkingAnimation = function(elementId) {
    const messages = [
        "Analyzing flavor constraints...", "Consulting Scott Labs Handbook...",
        "Calculating Target YAN & Nutrients...", "Cross-referencing Inventory...",
        "Optimizing Honey-to-Water ratio...", "Balancing Acidity and Tannins...",
        "Reviewing Fermentation Protocol...", "Finalizing Recipe..."
    ];
    const element = document.getElementById(elementId);
    if (!element) return null;
    let index = 0;
    element.textContent = messages[0];
    const intervalId = setInterval(() => {
        index = (index + 1) % messages.length;
        element.textContent = messages[index];
    }, 1800); 
    return intervalId; 
}

// --- View Management ---
window.switchMainView = function(viewName) {
    if (window.hideBottlingModal) hideBottlingModal();
    const dashboardMainView = document.getElementById('dashboard-main-view');
    const brewingMainView = document.getElementById('brewing-main-view');
    const managementMainView = document.getElementById('management-main-view');
    const toolsMainView = document.getElementById('tools-main-view');
    const settingsView = document.getElementById('settings-main-view');

    [dashboardMainView, brewingMainView, managementMainView, toolsMainView, settingsView].forEach(v => v.classList.add('hidden'));
    
    const viewToShow = document.getElementById(`${viewName}-main-view`);
    if (viewToShow) {
        viewToShow.classList.remove('hidden');
        if (viewName === 'brewing') populateEquipmentProfilesDropdown();
    }
}

window.switchSubView = function(viewName, parentViewId) {
    const parentView = document.getElementById(parentViewId);
    
    // Verberg alle sub-views in deze sectie
    parentView.querySelectorAll('[id$="-view"]').forEach(v => v.classList.add('hidden'));
    parentView.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));

    // Toon de gekozen view
    const viewId = `${viewName}-view`;
    const tabId = `${viewName}-sub-tab`;
    const viewToShow = document.getElementById(viewId);
    const tabToActivate = document.getElementById(tabId);

    if (viewToShow) viewToShow.classList.remove('hidden');
    if (tabToActivate) tabToActivate.classList.add('active');

    // --- SPECIFIEKE ACTIES PER VIEW ---
    if (viewName === 'brew-day-2') renderBrewDay2();
    if (viewName === 'creator') populateEquipmentProfilesDropdown(); 
    if (viewName === 'social') populateSocialRecipeDropdown();
    if (viewName === 'labels') { 
        populateLabelRecipeDropdown(); 
        updateLabelPreviewDimensions(); 
        // NIEUW: Forceer direct het standaard thema (met logo) bij openen
        if(typeof setLabelTheme === 'function') setLabelTheme('standard');
    }
    
    // --- NIEUW: RESET DE CHAT BIJ OPENEN ---
    if (viewName === 'troubleshoot') {
        if(typeof window.resetTroubleshootChat === 'function') {
            window.resetTroubleshootChat();
        }
    }
}

// --- Initialization & Auth ---

async function signInWithGoogle() {
    const provider = new GoogleAuthProvider();
    try {
        await signInWithPopup(auth, provider);
    } catch (error) {
        console.error("Google Sign-In failed:", error);
        alert("Login Mislukt: " + error.message);
    }
}

// --- Helpers voor UI interacties ---
function handleDescriptionInput() {
    const descriptionInput = document.getElementById('customDescription');
    const optionsContainer = document.getElementById('structured-options-container');
    const warningMessage = document.getElementById('description-priority-warning');
    const hasText = descriptionInput.value.trim() !== '';
    optionsContainer.classList.toggle('opacity-50', hasText);
    optionsContainer.classList.toggle('pointer-events-none', hasText);
    warningMessage.classList.toggle('hidden', !hasText);
    optionsContainer.querySelectorAll('input, select, checkbox').forEach(el => {
        if (el.id !== 'useInventory') el.disabled = hasText;
    });
}

function handleEquipmentTypeChange() {
     const type = document.getElementById('equipProfileType').value;
     document.getElementById('boil-off-rate-container').classList.toggle('hidden', type !== 'Kettle');
}

// --- Danger Modal ---
let dangerAction = null; 
window.showDangerModal = function(action, confirmationText) {
    dangerAction = action;
    document.getElementById('danger-confirm-text').textContent = confirmationText;
    document.getElementById('danger-confirm-input').value = '';
    document.getElementById('danger-modal').classList.remove('hidden');
    checkDangerConfirmation();
}
window.hideDangerModal = function() {
    document.getElementById('danger-modal').classList.add('hidden');
    dangerAction = null;
}
window.checkDangerConfirmation = function() {
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
window.executeDangerAction = function() {
    if (typeof dangerAction === 'function') dangerAction();
    hideDangerModal();
}

// --- DEEL 3: AI CORE & CREATOR LOGIC ---

async function performApiCall(prompt, schema = null) {
    // 1. VEILIGHEID EERST: We kijken in de telefoon-instellingen
    let apiKey = userSettings.apiKey;
    
    // Alleen als fallback kijken we in de (onveilige) code
    if (!apiKey && typeof CONFIG !== 'undefined' && CONFIG.firebase && CONFIG.firebase.apiKey) {
        // Dit is eigenlijk de Firebase key, die werkt vaak NIET voor Gemini, 
        // dus de gebruiker MOET eigenlijk wel iets invullen in Settings.
        console.warn("Gebruik Firebase key als fallback (mogelijk werkt dit niet voor AI)");
        apiKey = CONFIG.firebase.apiKey;
    }

    if (!apiKey) {
        throw new Error("⛔ Geen API Key! Ga naar Settings -> vul 'Google AI Key' in.");
    }

    // 2. Kies het model (Stabiele versie hardcoded als default)
    const model = (userSettings.aiModel && userSettings.aiModel.trim() !== "") 
        ? userSettings.aiModel 
        : "gemini-1.5-flash";

    // 3. Directe lijn naar Google (zonder tussen-server)
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const requestBody = {
        contents: [{ parts: [{ text: prompt }] }]
    };

    if (schema) {
        requestBody.generationConfig = {
            responseMimeType: "application/json",
            responseSchema: schema
        };
    }

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
        // SPECIFIEKE CHECK VOOR LIMIET
        if (response.status === 429) {
            throw new Error("⛔ QUOTA BEREIKT: Je daglimiet voor dit model is op. Ga naar Settings en kies 'Gemini Flash' of wacht even.");
        }
        
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `Google Error: ${response.status}`);
    }

        const data = await response.json();
        if (data.candidates && data.candidates.length > 0) {
            return data.candidates[0].content.parts[0].text;
        } else {
            throw new Error("Google gaf geen antwoord.");
        }

    } catch (error) {
        console.error("AI Fout:", error);
        throw new Error(`AI Fout: ${error.message}`);
    }
}

function getFortKnoxLaws(isNoWater = false, isBraggot = false, isHydromel = false, isHeavy = false, isWild = false) {
    return `
**THE FORT KNOX PROTOCOLS (NON-NEGOTIABLE):**

1.  **GLOBAL SAFETY OVERRIDE:**
    - **Temp:** NEVER recommend a fermentation temp exceeding the yeast manufacturer's limit (e.g. D47 <20°C).
    - **Sanity Check:** If the user requests impossible physics (e.g. 25% ABV without distillation), correct them politely.

2.  **SCIENTIFIC LAWS:**
    - **Buffer:** Traditionals/Cysers MUST have Potassium Carbonate.
    - **Stability:** Ferment DRY -> Stabilize -> Backsweeten.
    - ${isNoWater ? '**NO-WATER RULE:** DO NOT ADD WATER. Liquid must come from fruit juice/maceration only.' : ''}
    - ${isBraggot ? '**BRAGGOT MATH:** Malt provides 30-50% sugar. Reduce honey to prevent overshooting ABV.' : ''}
    - ${isHydromel ? '**HYDROMEL BODY:** Low ABV needs Erythritol/Lactose/Carbonation to avoid tasting watery.' : ''}

3.  **NUTRIENT SECURITY:**
    - If user has *only* DAP/Nutrisal: WARN against adding it after 9% ABV (Ammonia taste).
    - If style is *Wild/Sour*: Reduce nutrient dosage by 50% and front-load.

**OUTPUT FORMAT (STRICT):**
- **Markdown** structure.
- **Ingredients JSON:** \`\`\`json [{"ingredient": "Name", "quantity": 0, "unit": "kg"}] \`\`\` (List ALL ingredients with calculated amounts).
- **Timers:** \`[TIMER:HH:MM:SS]\` for wait steps.
`;
}

function buildPrompt() {
    try {
        // 1. Data Verzamelen
        const batchSize = parseFloat(document.getElementById('batchSize').value) || 5;
        const targetABV = parseFloat(document.getElementById('abv').value) || 12;
        const sweetness = document.getElementById('sweetness').value;
        const styleSelect = document.getElementById('style');
        const style = styleSelect.selectedOptions.length > 0 ? styleSelect.selectedOptions[0].text : 'Traditional Mead';
        const customDescription = document.getElementById('customDescription').value;
        
        // 1.5 Input Analyse
        const inputString = (customDescription + " " + style).toLowerCase();
        const noWaterCheckbox = document.getElementById('isNoWaterCheckbox');
        const isNoWater = (noWaterCheckbox && noWaterCheckbox.checked) || inputString.includes('no-water') || inputString.includes('no water');
        const isBraggot = inputString.includes('braggot');
        
        // Budget Logic
        const useBudget = document.getElementById('useBudget')?.checked;
        let budgetContext = "";
        if (useBudget) {
             const maxBudget = parseFloat(document.getElementById('maxBudget').value);
             if (maxBudget > 0) {
                 budgetContext = `\n- **STRICT BUDGET CONSTRAINT:** The total cost of ingredients MUST be below **€${maxBudget}**. Prioritize cheaper ingredients or smaller batches if necessary.`;
             }
        }

        // 2. Math Injection
        const honeyGramsPerLiter = targetABV * 22; 
        const totalHoneyKg = (honeyGramsPerLiter * batchSize) / 1000;
        const estimatedYAN = Math.round(targetABV * 10); 
        
        let mathContext = `
        **CALCULATED TARGETS:**
        - **Batch:** ${batchSize}L | **Target ABV:** ${targetABV}%
        - **Honey Baseline:** ~${totalHoneyKg.toFixed(2)} kg (Assuming honey provides 100% of alcohol).
        - **SHOPPING LIST RULE:** If target is **SWEET**, add ~15% extra honey to the JSON for backsweetening.
        - **Nitrogen Target:** ~${estimatedYAN} PPM YAN.${budgetContext}
        `;

        if (isNoWater) {
            mathContext += `\n- **PROTOCOL: NO-WATER MELOMEL.** 1. No added water. 2. Need ~1.8kg fruit/Liter. 3. **SUGAR ALERT:** Fruit adds sugar. REDUCE Honey Baseline significantly.`;
        } else if (isBraggot) {
            mathContext += `\n- **PROTOCOL: BRAGGOT.** Malt provides 30-50% sugar. REDUCE Honey Baseline proportionally.`;
        } else {
            mathContext += `\n- **JUICE WARNING:** If replacing water with Fruit Juice, reduce honey to prevent overshooting ABV.`;
        }

        // 3. Inventory Analyse 
            const inventoryToggles = {
            Yeast: document.getElementById('useInventory_Yeast')?.checked || false,
            Nutrient: document.getElementById('useInventory_Nutrients')?.checked || false,
            Honey: document.getElementById('useInventory_Honey')?.checked || false,
            Fruit: document.getElementById('useInventory_Fruits')?.checked || false,
            Spice: document.getElementById('useInventory_Spices')?.checked || false,
            Other: document.getElementById('useInventory_Other')?.checked || false
        };
        
        const relevantCategories = ['Honey', 'Yeast', 'Nutrient', 'Malt Extract', 'Fruit', 'Spice', 'Adjunct', 'Chemical', 'Water'];
        const fullInventoryList = inventory.filter(item => relevantCategories.includes(item.category));
        const inventoryString = fullInventoryList.map(item => `${item.name} (${item.qty} ${item.unit})`).join('; ');
        
        const useAnyInventory = Object.values(inventoryToggles).some(val => val === true);
        const requestedCategories = Object.keys(inventoryToggles).filter(k => inventoryToggles[k]);
        
        let inventoryInstruction = "";
        if (useAnyInventory) {
             inventoryInstruction = `**INVENTORY MODE:** The user wants to use their stock. Prioritize using items from: ${requestedCategories.join(', ')}.`;
        } else {
             inventoryInstruction = `**STOCK AWARENESS:** The user has these items available. Suggest them if they fit the style perfectly.`;
        }

        // Nutriënten logica (Vinoferm detectie)
        // --- 1. Nutriënten Logica (Vinoferm & Hybrid detectie) ---
        const invLower = inventoryString.toLowerCase();
        
        const hasSafeOrganic = invLower.includes('fermaid o') || invLower.includes('ferm o') || invLower.includes('cellvit') || invLower.includes('yeast hulls');
        const hasDAP = invLower.includes('dap') || invLower.includes('diammonium') || invLower.includes('nutrisal');
        const hasHybrid = invLower.includes('nutrivit') || invLower.includes('fermaid k') || invLower.includes('combi') || invLower.includes('ultra') || invLower.includes('tronozym');
        
        let baseNutrientRule = "";
        if (inventoryToggles.Nutrient) { 
             if (!hasSafeOrganic && (hasHybrid || hasDAP)) {
                baseNutrientRule = `1. **Nutrients (HYBRID/INORGANIC):** Detected stock: Inorganic/Hybrid but NO Fermaid O. Use ONLY this stock. **WARNING:** Instruct user to STOP adding nutrients after 9% ABV to avoid off-flavors.`;
            } else if (hasSafeOrganic) {
                baseNutrientRule = `1. **Nutrients (ORGANIC):** Use Fermaid O/Cellvit from stock (TOSNA protocol).`;
            } else {
                baseNutrientRule = `1. **Nutrients:** Prescribe standard TOSNA 2.0 (Fermaid O preference).`;
            }
        } else {
             baseNutrientRule = `1. **Nutrients:** Use standard TOSNA 2.0 guidelines.`;
        }

        // --- 2. Stabilisatie Check (Campden vs Metabisulphite) ---
        // Zorgt dat de AI de taal van de gebruiker spreekt
        let stabiliserRule = "";
        if (invLower.includes('campden')) {
            stabiliserRule = `3. **NAMING CONVENTION:** The user has "Campden" in stock. Always write "**Campden Powder/Tablets**" instead of "Potassium Metabisulphite" in the ingredients list and instructions.`;
        }

        // --- 3. De Final Logic String ---
        const inventoryLogic = `
        ${inventoryInstruction} 
        **FULL STOCK LIST:** [${inventoryString}]. 
        
        **CRITICAL INVENTORY RULES:**
        1. **JSON Block:** MUST contain the **TOTAL** ingredients required (ignore stock here).
        2. **SHOPPING LIST TEXT:** - Compare Required Amount vs Stock Amount.
           - IF (Stock >= Required): **SILENCE**. Do NOT mention this item in the shopping list text. Do NOT write "You have enough".
           - IF (Stock < Required): Write ONLY: "Buy [Amount Needed] of [Item]".
           - IF (Stock == 0): Write "Buy [Full Amount] of [Item]".
        ${stabiliserRule}
        `;

        // 4. Style Router
        const sourKeywords = ['sour', 'wild', 'gueuze', 'lambic', 'brett', 'funky', 'farmhouse', 'lacto', 'pedio', 'geuze'];
        const isQuickSour = inputString.includes('philly') || inputString.includes('kettle');
        const isWildMode = sourKeywords.some(k => inputString.includes(k));

        const belgianKeywords = ['quad', 'tripel', 'dubbel', 'belgian', 'abbey', 'trappist', 'saison', 'blond', 'bruin', 'stout', 'barleywine'];
        const isBelgianMode = belgianKeywords.some(k => inputString.includes(k)) || isBraggot; 

        const heavyKeywords = ['rum', 'bourbon', 'whisky', 'barrel', 'oak', 'bochet', 'dessert', 'pastry', 'sack', 'port', 'sherry', 'amaretto', 'chocolate', 'vanilla', 'coffee', 'maple'];
        const isHydromel = targetABV < 8 || inputString.includes('session') || inputString.includes('hydromel');
        const isHeavyMode = heavyKeywords.some(k => inputString.includes(k)) || targetABV > 15;

        // 5. Protocollen
        let protocolContext = "";
        let specificLaws = "";

        if (isWildMode) {
            protocolContext = `**PROTOCOL: WILD & SOUR.**`;
            let timeRule = isQuickSour 
                ? `**Time:** Philly Sour acts fast. Treat like ale.` 
                : `**Time:** Genuine Wild/Brett needs **6-24 months** aging.`;
            
            let wildNutrientRule = baseNutrientRule;
            if (hasDAP || hasHybrid) {
                wildNutrientRule = `1. **Nutrients (WILD CAUTION):** User has Inorganic nutrients. **REDUCE DOSAGE by 50%** and front-load.`;
            }

            specificLaws = `
            **WILD LAWS:**
            ${wildNutrientRule}
            2.  **Yeast:** Recommend Philly Sour, Lambic Blend, or Brett. Warn about plastic.
            3.  **Acidity:** NO Carbonate buffers.
            4.  ${timeRule}
            5.  **Hops:** Aged Hops for Gueuze.
            `;
        } else if (isBelgianMode) {
            protocolContext = `**PROTOCOL: MONASTIC/COMPLEX.** Focus on Esters/Phenols.`;
            specificLaws = `
            **MONASTIC LAWS:**
            ${baseNutrientRule}
            2.  **Yeast:** Ale Yeasts (M47, BE-256, WLP500).
            3.  **Temp:** Warmer (20-25°C) permitted *IF* yeast strain allows.
            4.  **Ingredients:** Consider Dark Candi Syrup.
            5.  **Carbonation:** Recommend bottle conditioning.
            `;
        } else {
            protocolContext = `**PROTOCOL: STANDARD SCIENTIFIC (BOMM).**`;
            let timeAndAgingRule = "";
            let hydromelRule = "";

            if (isHydromel) {
                timeAndAgingRule = `4. **Efficiency:** Fast turnaround (1 month).`;
                hydromelRule = `5. **Hydromel Body:** Low ABV mead feels watery. Recommend adding **Erythritol, Lactose, or Maltodextrin** for mouthfeel, OR carbonating.`;
            } else if (isHeavyMode || isNoWater) {
                timeAndAgingRule = `4. **Aging:** High Gravity/Fruit load requires **3-6 months bulk aging**.`;
            } else {
                timeAndAgingRule = `4. **Efficiency:** Aim for clean ferment ready in 2-3 months.`;
            }

            specificLaws = `
            **SCIENTIFIC LAWS:**
            ${baseNutrientRule}
            2.  **Yeast:** Reliable strains (71B, EC-1118, D47, US-05).
            3.  **Buffer:** Traditionals MUST have Potassium Carbonate.
            4.  **Stability:** Ferment DRY -> Stabilize -> Backsweeten.
            ${timeAndAgingRule}
            ${hydromelRule}
            `;
        }

        // 6. Water
        let waterContext = "";
        if (isNoWater) {
            waterContext = `**WATER RULE:** DO NOT ADD WATER. Liquid must come from fruit juice/maceration only.`;
        } else if (currentWaterProfile) {
            waterContext = `Use Water: ${currentWaterProfile.name}`;
        } else {
            waterContext = `Recommend Ideal Water Profile.`;
        }

        // 7. Input Verwerking
        let creativeBrief = ""; 
        if (customDescription.trim() !== '') {
             creativeBrief = `User Vision: "${customDescription}". Override stats only if specified. Base: ${batchSize}L, ${targetABV}%.`;
        } else {
             creativeBrief = `Structure: ${style}, Batch: ${batchSize}L, Target: ${targetABV}%, Sweetness: ${sweetness}.`;
             if (style.includes('Melomel')) {
                const fruits = Array.from(document.querySelectorAll('#fruit-section input[type=checkbox]:checked')).map(el => el.labels[0].innerText);
                const otherFruits = document.getElementById('fruitOther').value;
                const fStr = [...fruits, otherFruits].filter(Boolean).join(', ');
                if(fStr) creativeBrief += `\n- Fruits: ${fStr}`;
             }
             if (style.includes('Metheglin')) {
                const spices = Array.from(document.querySelectorAll('#spice-section input[type=checkbox]:checked')).map(el => el.labels[0].innerText);
                const otherSpices = document.getElementById('spiceOther').value;
                const sStr = [...spices, otherSpices].filter(Boolean).join(', ');
                if(sStr) creativeBrief += `\n- Spices: ${sStr}`;
             }
             if (style.includes('Braggot')) {
                 creativeBrief += `\n- Braggot Base: ${document.getElementById('braggotStyle').value}`;
             }
             if (document.getElementById('addOak').checked) creativeBrief += '\n- Requirement: Include Oak Aging.';
             if (document.getElementById('specialIngredients').value) creativeBrief += `\n- Special Ingredients: ${document.getElementById('specialIngredients').value}`;
        }

        // --- STAP 8: FINAL PROMPT ---
        return `You are "MEA(N)DERY", a master mazer. 

${mathContext}
${protocolContext}
${specificLaws}
${inventoryLogic}
${waterContext}

**GLOBAL SAFETY OVERRIDE:**
1. **Temp:** NEVER recommend a fermentation temp exceeding the yeast manufacturer's limit.
2. **Sanity Check:** If the user requests impossible physics, correct them politely.

**OUTPUT FORMAT (ABSOLUTE STRICTNESS):**
- **ROLE:** Act as a headless database. DO NOT speak to the user. DO NOT say "Okay", "Sure", "Here is your recipe".
- **START:** The output MUST start with the character "#" (The Title). nothing else before it.
- **STRUCTURE:**
  1. Title (# Name)
  2. > Inspirational Quote
  3. Vital Stats List (ABV, Size, Style, Sweetness, OG)
  4. Ingredients JSON Block: \`\`\`json [{"ingredient": "Name", "quantity": 0, "unit": "kg"}] \`\`\`
  5. Instructions (Numbered list)
  6. Timers: \`[TIMER:HH:MM:SS]\` inside the steps.
  7. Brewer's Notes (Start section with "## Brewer's Notes")

Request:
---
${creativeBrief}
---`;

    } catch (error) {
        console.error("Error building prompt:", error);
        throw new Error(`Failed to build prompt: ${error.message}`);
    }
}

async function generateRecipe() {
    const recipeOutput = document.getElementById('recipe-output');
    recipeOutput.innerHTML = getLoaderHtml("Initializing Brewing Protocol...");
    const generateBtn = document.getElementById('generateBtn');
    generateBtn.disabled = true;
    generateBtn.classList.add('opacity-50', 'cursor-not-allowed');
    currentPredictedProfile = null;

    const thinkingInterval = window.startThinkingAnimation("loader-text");

    try {
        const prompt = buildPrompt();
        lastGeneratedPrompt = prompt;
        
        let rawResponse = await performApiCall(prompt); 
        
        let cleanedResponse = rawResponse.trim();
        if (cleanedResponse.startsWith("```markdown")) {
            cleanedResponse = cleanedResponse.substring(11, cleanedResponse.lastIndexOf("```"));
        } else if (cleanedResponse.startsWith("```")) {
            cleanedResponse = cleanedResponse.substring(3, cleanedResponse.lastIndexOf("```"));
        }
        
        if (thinkingInterval) clearInterval(thinkingInterval);

        currentRecipeMarkdown = cleanedResponse.trim();
        await renderRecipeOutput(currentRecipeMarkdown); 

    } catch (error) {
        if (thinkingInterval) clearInterval(thinkingInterval);
        console.error("Error calling Gemini API:", error);
        recipeOutput.innerHTML = `<p class="text-center text-red-600 font-bold">Sorry, your buddy is busy.</p><p class="text-center text-sm text-app-secondary/80">${error.message}</p>`;
    } finally {
        generateBtn.disabled = false;
        generateBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
}

function parseRecipeData(markdown) {
    const data = {};
    if (!markdown) return data; // Veiligheid

    try {
        // Titel zoeken
        const titleMatch = markdown.match(/^#\s*(.*)/m);
        if (titleMatch && titleMatch[1]) { data.recipeName = titleMatch[1].trim(); }

        // Regex helpers
        const createRegex = (key) => new RegExp(`(?:${key}|${key.replace('.', '\\.')})[\\s\\*:]*~?([\\d.,]+)`, 'i');
        
        // OG Zoeken
        const ogRegex = createRegex('Target OG|Original Gravity|Start SG|O\\.G\\.|OG');
        const ogMatch = markdown.match(ogRegex);
        if (ogMatch && ogMatch[1]) { data.targetOG = ogMatch[1]; }

        // FG Zoeken
        const fgRegex = createRegex('Target FG|Final Gravity|Eind SG|F\\.G\\.|FG');
        const fgMatch = markdown.match(fgRegex);
        if (fgMatch && fgMatch[1]) { data.targetFG = fgMatch[1]; }

        // ABV Zoeken
        const abvMatchGlobal = markdown.match(new RegExp(`(?:Target ABV|ABV|Alcoholpercentage)[\\s\\*:]*~?([\\d.,]+)\\s*%?`, 'i'));
        if (abvMatchGlobal && abvMatchGlobal[1]) { data.targetABV = abvMatchGlobal[1]; }

    } catch (e) {
        console.error("Error parsing recipe data:", e);
    }
    return data;
}

// --- HELPER: MAAK VAN RUWE DATA EEN MOOIE TABEL ---
function formatRecipeMarkdown(markdown) {
    if (!markdown) return "";
    let finalMarkdown = markdown;

    // Zoek naar het JSON blok (tussen haakjes [] of ```json ... ```)
    const jsonRegex = /(?:```json\s*([\s\S]*?)\s*```|(\[\s*\{[\s\S]*?\}\s*\]))/;
    const jsonMatch = finalMarkdown.match(jsonRegex); 

    if (jsonMatch && (jsonMatch[1] || jsonMatch[2])) {
        const jsonString = jsonMatch[1] || jsonMatch[2];
        try {
            // Maak JSON veilig (verwijder trailing commas)
            let safeJsonString = jsonString.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'); 
            const ingredientsArray = JSON.parse(safeJsonString);
            
            // Bouw de Markdown Tabel
            let tableMarkdown = '\n| Ingredient | Quantity | Unit |\n|---|---|---|\n';
            ingredientsArray.forEach(item => {
                let displayQty = parseFloat(item.quantity);
                let displayUnit = item.unit;
                
                // Slimme eenheden (g -> kg als > 1000)
                if ((displayUnit || '').toLowerCase() === 'g' && displayQty >= 1000) { 
                    displayQty /= 1000; displayUnit = 'kg'; 
                } 
                else if ((displayUnit || '').toLowerCase() === 'ml' && displayQty >= 1000) { 
                    displayQty /= 1000; displayUnit = 'L'; 
                }
                
                // Rond af als het decimalen zijn
                if (displayQty % 1 !== 0) { displayQty = parseFloat(displayQty.toFixed(2)); }
                
                tableMarkdown += `| ${item.ingredient} | ${displayQty} | ${displayUnit} |\n`;
            });
            
            // Vervang de lelijke code door de mooie tabel
            finalMarkdown = finalMarkdown.replace(jsonRegex, tableMarkdown); 
        } catch (e) {
            console.error("Table format error:", e);
        }
    }
    return finalMarkdown;
}

// --- RENDER RECIPE OUTPUT (VOLLEDIG & GEOPTIMALISEERD) ---
async function renderRecipeOutput(markdown, isTweak = false) {
    const recipeOutput = document.getElementById('recipe-output');
    let finalMarkdown = markdown;
    if (!finalMarkdown.trim().startsWith('# ')) {
        finalMarkdown = `# Untitled Batch\n\n${finalMarkdown}`;
    }
    currentRecipeMarkdown = finalMarkdown;
    currentPredictedProfile = await getPredictedFlavorProfile(markdown); 
    
    let flavorProfileHtml = '<div id="flavor-profile-section" class="mt-8 pt-6 border-t border-app">';
    flavorProfileHtml += '<h3 class="text-2xl font-header font-bold text-center mb-4">Predicted Flavor Profile</h3>';

    if (currentPredictedProfile) {
        flavorProfileHtml += `<div class="card p-4 rounded-lg max-w-sm mx-auto"><canvas id="generated-flavor-wheel"></canvas></div>`;
    } else {
        flavorProfileHtml += `<div class="card p-4 rounded-lg max-w-sm mx-auto text-center"><p class="text-sm mb-4">Could not generate profile.</p><button id="retry-flavor-btn" onclick="window.regenerateFlavorProfile()" class="bg-purple-600 text-white py-2 px-4 rounded btn text-sm">Generate Profile</button><div id="flavor-generation-status" class="mt-2 text-sm"></div></div>`;
    }
    flavorProfileHtml += '</div>';
    
    const jsonRegex = /(?:```json\s*([\s\S]*?)\s*```|(\[\s*\{[\s\S]*?\}\s*\]))/;
    const jsonMatch = finalMarkdown.match(jsonRegex); 
    let tableMarkdown = ''; 

    if (jsonMatch && (jsonMatch[1] || jsonMatch[2])) {
        const jsonString = jsonMatch[1] || jsonMatch[2];
        try {
            let safeJsonString = jsonString.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'); 
            const ingredientsArray = JSON.parse(safeJsonString);
            tableMarkdown = '| Ingredient | Quantity | Unit |\n|---|---|---|\n';
            ingredientsArray.forEach(item => {
                let displayQty = item.quantity;
                let displayUnit = item.unit;
                if ((displayUnit || '').toLowerCase() === 'g' && displayQty >= 1000) { displayQty /= 1000; displayUnit = 'kg'; } 
                else if ((displayUnit || '').toLowerCase() === 'ml' && displayQty >= 1000) { displayQty /= 1000; displayUnit = 'L'; }
                if (displayQty % 1 !== 0) { displayQty = parseFloat(displayQty.toFixed(2)); }
                tableMarkdown += `| ${item.ingredient} | ${displayQty} | ${displayUnit} |\n`;
            });
            finalMarkdown = finalMarkdown.replace(jsonRegex, tableMarkdown); 
        } catch (e) {
            console.error("JSON Parse Error inside Render:", e);
            tableMarkdown = `\n**Error:** Could not display ingredients table.\n`;
            finalMarkdown = finalMarkdown.replace(jsonRegex, tableMarkdown);
        }
    }

    finalMarkdown = finalMarkdown.replace(/\[d:[\d:]+\]/g, '');
    const recipeHtml = marked.parse(finalMarkdown);
    
    const fullHtml = `
            <div class="print-button-container text-right mb-4 flex justify-end flex-wrap gap-2 no-print">
                <button onclick="window.generateRecipe()" class="bg-app-action text-white py-2 px-4 rounded-lg hover:opacity-90 transition-colors btn text-sm flex items-center gap-1"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Retry</button>
                <button onclick="window.showLastPrompt()" class="bg-app-tertiary text-app-header border border-app-brand/30 py-2 px-4 rounded-lg hover:bg-app-secondary transition-colors btn text-sm">Show AI Prompt</button>
                <button onclick="window.print()" class="bg-app-tertiary text-app-header border border-app-brand/30 py-2 px-4 rounded-lg hover:bg-app-secondary transition-colors btn">Print Recipe</button>
            </div>
            
            <div class="recipe-content">${recipeHtml}</div>
        
        <div id="water-recommendation-card" class="mt-4 p-4 border border-app-brand/30 bg-app-tertiary rounded-lg no-print transition-all">
            <div class="flex justify-between items-center">
                <div>
                    <h4 class="font-bold text-app-brand text-sm uppercase flex items-center gap-2">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"></path></svg>
                        Water Chemistry
                    </h4>
                    <p class="text-xs text-app-secondary mt-1">Don't want to mess with salts? Find a bottled water that matches.</p>
                </div>
                <button onclick="window.findCommercialWaterMatch()" class="bg-app-brand text-white py-2 px-3 rounded text-sm hover:opacity-90 btn shadow-sm whitespace-nowrap">Find Matching Brand</button>
            </div>
            <div id="water-brand-results" class="hidden mt-4 pt-4 border-t border-app-brand/20 text-sm text-app-header"></div>
        </div>

        ${flavorProfileHtml}
        
        <div id="tweak-unsaved-section" class="mt-6 pt-6 border-t-2 border-app-brand no-print">
            <h3 class="text-2xl font-header font-bold text-center mb-4">Not quite right? Tweak it.</h3>
            <div class="card p-4 rounded-lg">
                <label for="tweak-unsaved-request" class="block text-sm font-bold mb-2">Describe what you want to change:</label>
                <textarea id="tweak-unsaved-request" rows="3" class="w-full p-2 border rounded-md bg-app-tertiary border-app text-app-header" placeholder="e.g., 'Make this for 20 liters', or 'Replace the apples with pears'"></textarea>
                <button id="tweak-unsaved-btn" class="w-full mt-3 bg-app-brand text-white py-3 px-4 rounded-lg hover:opacity-90 btn">Generate Tweaked Recipe</button>
            </div>
            <div id="tweak-unsaved-output" class="mt-6"></div>
        </div>

        <div class="mt-6 no-print">
            <button id="saveBtn" class="w-full bg-app-action text-white font-bold py-3 px-4 rounded-lg hover:opacity-90 transition-colors btn">Save to Brew History</button>
        </div>
    `;

    recipeOutput.innerHTML = fullHtml;

    if (currentPredictedProfile) renderGeneratedFlavorWheel(currentPredictedProfile);

    document.getElementById('saveBtn').addEventListener('click', () => {
        saveBrewToHistory(currentRecipeMarkdown, currentPredictedProfile);
    });
    document.getElementById('tweak-unsaved-btn').addEventListener('click', tweakUnsavedRecipe);

    if (!isTweak) {
        generateAndInjectCreativeTitle(finalMarkdown);
    }
}

// --- CREATIVE TITLE GENERATOR ---
async function generateAndInjectCreativeTitle(markdown) {
    const titleHeader = document.querySelector('#recipe-output h1');
    if (!titleHeader) return;
    const originalTitle = titleHeader.textContent;
    titleHeader.innerHTML = `${originalTitle} <span class="text-sm font-normal text-app-brand animate-pulse">...branding...</span>`;

    const prompt = `You are a witty, cynical, modern branding expert for a high-end craft meadery. 
    **TASK:** Invent a SINGLE, bold, creative name for this mead.
    **CONTEXT:** ${markdown.substring(0, 1000)}...
    **RULES:** No fantasy clichés. Functional Wit. Short.
    **Format:** Output ONLY the name.`;

    try {
        const newTitle = await performApiCall(prompt);
        const cleanTitle = newTitle.replace(/['"]/g, '').trim();
        titleHeader.textContent = cleanTitle;
        if (currentRecipeMarkdown) {
            currentRecipeMarkdown = currentRecipeMarkdown.replace(/^#\s*(.*)/m, `# ${cleanTitle}`);
        }
    } catch (error) {
        titleHeader.textContent = originalTitle;
    }
}

// --- WATER SOMMELIER LOGIC ---
window.findCommercialWaterMatch = async function() {
    const resultsDiv = document.getElementById('water-brand-results');
    if (!resultsDiv || !currentRecipeMarkdown) return;
    resultsDiv.classList.remove('hidden');
    resultsDiv.innerHTML = getLoaderHtml("Scanning Belgian inventory...");

    const lowerRecipe = currentRecipeMarkdown.toLowerCase();
    const styleHint = lowerRecipe.includes('melomel') || lowerRecipe.includes('fruit') 
        ? "Fruit Mead (Prefers soft/low mineral water)" 
        : "Traditional (Prefers some mineral structure)";

    const prompt = `You are a Water Sommelier for a Mead Brewer in BELGIUM. 
    
    **CONTEXT:** ${styleHint}
    **USER TOOL:** The user uses a **Refractometer (Brix)**. Carbonation bubbles are NOT an issue for measuring.
    
    **TASK:** Recommend 3 real-world bottled water brands found in **BELGIAN SUPERMARKETS**.
    
    **SEARCH SCOPE:** - Do NOT stick to a pre-defined list. Search your knowledge base for widely available Belgian/European brands.
    - **CRITICAL:** Do NOT recommend American brands (Dasani, Poland Spring). Only brands sold in Belgium.

    **GUIDELINES:** 1. **STILL vs SPARKLING:** - Standard recommendation: "Plat/Still" (safest baseline).
       - Exception: If the style benefits from it, you MAY recommend a Sparkling variant.
       - Requirement: If Sparkling is chosen, add note: "Degas sample before measuring final gravity".
    2. **NO SALT ADDITIONS:** The user uses the water "as is". Find the perfect natural profile.
    3. **SOURCE CHECK:** If recommending a brand with multiple sources (like Cristaline or generic supermarket brands), you **MUST** specify which specific source/catchment area on the label is required (e.g. "Source Eleanor").
    
    RECIPE: ${currentRecipeMarkdown}
    
    OUTPUT: JSON Array: [{"brand": "Name", "reason": "Why this specific mineral profile fits", "tweak_instruction": "Specific usage advice"}]`;

    const schema = {
        type: "ARRAY",
        items: {
            type: "OBJECT",
            properties: { "brand": { "type": "STRING" }, "reason": { "type": "STRING" }, "tweak_instruction": { "type": "STRING" } },
            required: ["brand", "reason", "tweak_instruction"]
        }
    };

    try {
        const response = await performApiCall(prompt, schema);
        const brands = JSON.parse(response);
        let html = `<h5 class="font-bold mb-3 text-app-brand text-sm uppercase">Recommended Belgian Waters:</h5><div class="space-y-3">`;
        brands.forEach(b => {
            html += `<div class="p-3 card rounded border border-app-brand/30 shadow-sm flex flex-col gap-2">
                        <div class="flex justify-between items-start">
                            <span class="font-bold text-app-header">${b.brand}</span>
                            <button onclick="window.applyWaterTweak('${b.brand}', '${b.tweak_instruction.replace(/'/g, "\\'")}')" class="text-xs bg-app-tertiary hover:bg-app-secondary text-app-brand border border-app-brand py-1 px-2 rounded transition-colors font-bold uppercase tracking-wider">Select</button>
                        </div>
                        <p class="text-xs text-app-secondary">${b.reason}</p>
                        <p class="text-[10px] text-green-600 font-mono mt-1">✓ ${b.tweak_instruction}</p>
                     </div>`;
        });
        html += `</div>`;
        resultsDiv.innerHTML = html;
    } catch (error) {
        console.error("Water match failed:", error);
        resultsDiv.innerHTML = `<p class="text-red-500 text-sm">Could not find matching brands.</p>`;
    }
}

window.applyWaterTweak = function(brandName, technicalInstruction) {
    const tweakInput = document.getElementById('tweak-unsaved-request');
    document.getElementById('tweak-unsaved-section').scrollIntoView({ behavior: 'smooth', block: 'center' });

    tweakInput.value = `Update recipe for **${brandName}** water profile. \nNote: ${technicalInstruction} \nPlease recalculate nutrients and acidity buffering based on this specific mineral content.`;
    
    tweakInput.classList.add('ring-4', 'ring-blue-500/50', 'transition-all', 'duration-500');
    setTimeout(() => tweakInput.classList.remove('ring-4', 'ring-blue-500/50'), 1500);
    tweakInput.focus();
}

async function tweakUnsavedRecipe() {
    const tweakRequest = document.getElementById('tweak-unsaved-request').value.trim();
    if (!tweakRequest) { showToast("Please enter your tweak request.", "error"); return; }

    const tweakOutput = document.getElementById('tweak-unsaved-output');
    tweakOutput.innerHTML = getLoaderHtml("Analyzing Tweak Request..."); 
    
    const tweakBtn = document.getElementById('tweak-unsaved-btn');
    tweakBtn.disabled = true;

    const thinkingInterval = window.startThinkingAnimation("loader-text");

    let preservedTitle = '', preservedDate = '';
    const currentNameInput = document.querySelector('input[id^="recipeName-new"]');
    const currentDateInput = document.querySelector('input[id^="brewDate-new"]');
    if (currentNameInput) preservedTitle = currentNameInput.value;
    if (currentDateInput) preservedDate = currentDateInput.value;

    const contextLower = (currentRecipeMarkdown + tweakRequest).toLowerCase();
    const isNoWater = contextLower.includes('no-water') || contextLower.includes('no water');
    const isBraggot = contextLower.includes('braggot');
    const isHydromel = contextLower.includes('session') || contextLower.includes('hydromel');
    const isWild = contextLower.includes('wild') || contextLower.includes('sour') || contextLower.includes('brett');

    const laws = getFortKnoxLaws(isNoWater, isBraggot, isHydromel, false, isWild);

    const relevantCategories = ['Honey', 'Yeast', 'Nutrient', 'Malt Extract', 'Fruit', 'Spice', 'Adjunct', 'Chemical', 'Water'];
    const fullInventoryList = inventory.filter(item => relevantCategories.includes(item.category));
    const inventoryString = fullInventoryList.map(item => `${item.name} (${item.qty} ${item.unit})`).join('; ');
    const inventoryContext = `\n**INVENTORY CONTEXT:** The user has the following items in stock: [${inventoryString}]. If the tweak requires adding ingredients, prioritize these items.`;

    const safeMarkdown = currentRecipeMarkdown.replace(/`/g, "'"); 

    const prompt = `You are "MEA(N)DERY", a master mazer with a witty, slightly cynical, modern brand voice. A user wants to tweak a recipe.
    
    **STRICT OUTPUT RULE:**
    - Do NOT output raw JSON.
    - Output a Markdown Recipe.
    - Start immediately with "# [NEW TITLE]".
    
    Original Recipe:
    ---
    ${safeMarkdown}
    ---

    User Tweak Request: "${tweakRequest}"

    **TASK:** Rewrite the FULL recipe to incorporate the tweak.
    
    **BRAND VOICE & CONTINUITY (CRITICAL):**
    1. **Analyze the Original Title:** "${preservedTitle || 'Untitled'}".
    2. **Identify the Vibe:** Is it cynical? A pun? Dark humor? Minimalist?
    3. **Invent a NEW Title:** Create a new name that fits the **new ingredients** but keeps the **original vibe**.
       - *Example:* If original was "Unpaid Overtime" (Work/Stress theme) and user adds mineral water -> New Title: "Liquid Assets" or "Hard Water, Harder Life".
       - *Example:* If original was "Bee's Knees" (Cute/Pun) -> New Title: "Minerally In Love".
    4. **Prohibition:** Do NOT just append "(Chaudfontaine Edition)". Make it unique.
    
    ${laws}
    ${inventoryContext}

    **LOGIC CHECK:**
    - If Batch Size changed -> Recalculate ALL ingredients.
    - If Water changed -> Adjust Nutrients & Buffer (High Bicarbonate water needs LESS Potassium Carbonate).
    `; 

    try {
        const tweakedMarkdown = await performApiCall(prompt);
        if (thinkingInterval) clearInterval(thinkingInterval);

        let processedMarkdown = tweakedMarkdown.trim();
        
        if (processedMarkdown.startsWith("```markdown")) {
             processedMarkdown = processedMarkdown.substring(11, processedMarkdown.lastIndexOf("```")).trim();
        } else if (processedMarkdown.startsWith("```")) {
             processedMarkdown = processedMarkdown.substring(3, processedMarkdown.lastIndexOf("```")).trim();
        }

        const firstTitleIndex = processedMarkdown.indexOf('#');
        if (firstTitleIndex > -1) {
            processedMarkdown = processedMarkdown.substring(firstTitleIndex);
        }

        currentRecipeMarkdown = processedMarkdown;
        
        await renderRecipeOutput(processedMarkdown, true);

        if (preservedTitle) {
            const newNameInput = document.querySelector('input[id^="recipeName-new"]');
            if(newNameInput) newNameInput.value = preservedTitle;
        }
        if (preservedDate) {
            const newDateInput = document.querySelector('input[id^="brewDate-new"]');
            if(newDateInput) newDateInput.value = preservedDate;
        }
        
        recipeOutput.scrollTop = 0;
        tweakBtn.disabled = false;
        tweakOutput.innerHTML = '';

    } catch (error) {
        if (thinkingInterval) clearInterval(thinkingInterval);
        console.error("Error tweaking:", error);
        tweakOutput.innerHTML = `<p class="text-red-500">Error: ${error.message}</p>`;
        tweakBtn.disabled = false;
    }
}

// --- FLAVOR PROFILING ---
async function getPredictedFlavorProfile(markdown) {
    const prompt = `You are a professional mead sommelier. Analyze this recipe and PREDICT its final flavor profile. Assign score 0-5 for: Sweetness, Acidity, Fruity/Floral, Spiciness, Earthy/Woody, Body/Mouthfeel. Output ONLY JSON. Recipe: "${markdown}"`;
    const schema = {
        type: "OBJECT",
        properties: { "sweetness": { "type": "NUMBER" }, "acidity": { "type": "NUMBER" }, "fruity_floral": { "type": "NUMBER" }, "spiciness": { "type": "NUMBER" }, "earthy_woody": { "type": "NUMBER" }, "body_mouthfeel": { "type": "NUMBER" } },
        required: ["sweetness", "acidity", "fruity_floral", "spiciness", "earthy_woody", "body_mouthfeel"]
    };
    try {
        const jsonResponse = await performApiCall(prompt, schema);
        return JSON.parse(jsonResponse);
    } catch (error) {
        console.error("Could not generate flavor profile:", error);
        return null;
    }
}

function renderGeneratedFlavorWheel(flavorData) {
    const ctx = document.getElementById('generated-flavor-wheel');
    if (!ctx) return;
    const labels = ['Sweetness', 'Acidity', 'Fruity/Floral', 'Spiciness', 'Earthy/Woody', 'Body'];
    const data = [flavorData.sweetness, flavorData.acidity, flavorData.fruity_floral, flavorData.spiciness, flavorData.earthy_woody, flavorData.body_mouthfeel];
    const brandColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-color');
    const isDarkMode = document.documentElement.classList.contains('dark');
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDarkMode ? '#e0e0e0' : '#4a3c2c';

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
            plugins: { legend: { display: true, labels: { color: textColor } } },
            scales: {
                r: {
                    angleLines: { color: gridColor },
                    grid: { color: gridColor },
                    pointLabels: { color: textColor, font: { size: 12, family: "'Barlow Semi Condensed', sans-serif" } },
                    ticks: { color: textColor, backdropColor: 'transparent', stepSize: 1 },
                    suggestedMin: 0, suggestedMax: 5
                }
            }
        }
    });
}

window.regenerateFlavorProfile = async function() {
    const button = document.getElementById('retry-flavor-btn');
    const statusDiv = document.getElementById('flavor-generation-status');
    const containerDiv = button.parentElement;
    if (!currentRecipeMarkdown) return;
    button.disabled = true;
    statusDiv.innerHTML = getLoaderHtml("Regenerating...");
    try {
        const profile = await getPredictedFlavorProfile(currentRecipeMarkdown);
        if (profile) {
            currentPredictedProfile = profile;
            containerDiv.innerHTML = `<canvas id="generated-flavor-wheel"></canvas>`;
            renderGeneratedFlavorWheel(profile);
        } else { throw new Error("Invalid profile."); }
    } catch (error) {
         statusDiv.innerHTML = `<p class="text-red-500">Failed: ${error.message}</p>`;
         button.disabled = false;
    }
}

// --- DEEL 4: BREW DAY, HISTORY & LOGGING ---

// --- BREW DAY MANAGAMENT ---

window.startBrewDay = async function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    // Navigeer eerst naar de shopping list om de ingrediënten te controleren
    switchMainView('brewing');
    switchSubView('shopping-list', 'brewing-main-view');
    generateShoppingList(brewId, false);
}

window.startActualBrewDay = async function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    // Datum instellen als die er nog niet is
    if (!brew.logData.brewDate) {
        brew.logData.brewDate = new Date().toISOString().split('T')[0];
        try {
            const brewDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId);
            await updateDoc(brewDocRef, { logData: brew.logData });
            const brewIndex = brews.findIndex(b => b.id === brewId);
            if (brewIndex > -1) brews[brewIndex].logData.brewDate = brew.logData.brewDate;
            showToast("Brew date set to today!", "info");
        } catch (error) {
            console.error("Could not auto-set brew date:", error);
        }
    }

    // Globale pointer instellen
    currentBrewDay = { brewId: brewId };
    saveUserSettings(); 

    // Checklist reset check
    const brewIndex = brews.findIndex(b => b.id === brewId);
    if (brewIndex > -1) {
        if (brews[brewIndex].checklist && Object.keys(brews[brewIndex].checklist).length > 0) {
            if (confirm("You have existing progress. Reset and start over?")) {
                brews[brewIndex].checklist = {};
                try {
                    const brewDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId);
                    await updateDoc(brewDocRef, { checklist: {} });
                } catch (e) { console.error("Could not reset checklist", e); }
            }
        } else {
             brews[brewIndex].checklist = {}; 
        }
    }

    window.switchSubView('brew-day-1', 'brewing-main-view');
    renderBrewDay(brewId);
}

// --- SMART PARSER: Haalt stappen uit oude tekst recepten ---
function extractStepsFromMarkdown(markdown) {
    if (!markdown) return { day1: [], day2: [] };

    const lines = markdown.split('\n');
    const day1 = [];
    const day2 = [];
    
    // Regex zoekt naar regels die beginnen met een cijfer (bv: "1. Mix honey...")
    const stepRegex = /^(\d+)\.\s+(.*)/;

    lines.forEach(line => {
        const match = line.trim().match(stepRegex);
        if (match) {
            const text = match[2];
            const lower = text.toLowerCase();

            // KEYWORDS: Wat hoort bij Fase 2 (Rijping)?
            const isSecondary = lower.includes('rack') || 
                                lower.includes('siphon') || 
                                lower.includes('secondary') || 
                                lower.includes('stabiliz') || 
                                lower.includes('backsweeten') || 
                                lower.includes('bottle') || 
                                lower.includes('bottling') || 
                                lower.includes('aging') || 
                                lower.includes('wait for clear');

            const stepObj = { title: `Step ${match[1]}`, description: text, duration: 0 };

            if (isSecondary) {
                day2.push(stepObj);
            } else {
                day1.push(stepObj);
            }
        }
    });

    // FALLBACK: Als de AI geen genummerde lijst heeft gemaakt, of alles in Day 1 zet
    if (day2.length === 0 && day1.length === 0) {
        return { day1: [], day2: [] }; // Geef leeg terug, zodat de defaults inschakelen
    }

    return { day1, day2 };
}

function renderBrewDay(brewId) {
    if (brewId === 'none') {
        document.getElementById('brew-day-content').innerHTML = `<h2 class="text-3xl font-header font-bold mb-4 text-center">Brew Day 1</h2><p class="text-center text-app-secondary/80">Select a new recipe to start.</p>`;
        return;
    }

    const brew = brews.find(b => b.id === brewId);
    const brewDayContent = document.getElementById('brew-day-content');
    if (!brew) return;

    let primarySteps = brew.brewDaySteps || [];
    
    if (primarySteps.length === 0 && brew.recipeMarkdown) {
        const extracted = extractStepsFromMarkdown(brew.recipeMarkdown);
        primarySteps = extracted.day1;
        if (primarySteps.length === 0) {
             primarySteps = [{ title: "Check Recipe Text", description: "Could not parse steps automatically. Please check the full recipe text below." }];
        }
    }

    // --- STAPPEN RENDERING MET SLIMME DESCRIPTION CHECK ---
    let stepsHtml = primarySteps.map((step, index) => {
        const amountMatch = (step.title + " " + step.description).match(/(\d+[.,]?\d*)\s*(kg|g|l|ml|oz|lbs)/i);
        let inputHtml = '';
        let detectedAmount = '';
        let detectedUnit = '';

        const stepState = currentBrewDay.checklist[`step-${index}`]; 
        const isCompleted = stepState === true || (stepState && stepState.completed);
        const savedAmount = (stepState && stepState.actualAmount) ? stepState.actualAmount : '';

        // Input veld logica
        if (amountMatch && !isCompleted) {
            detectedAmount = amountMatch[1];
            detectedUnit = amountMatch[2].toLowerCase();
            inputHtml = `<div class="mt-1 flex items-center gap-2 bg-app-tertiary/50 p-1 rounded border border-app-brand/10"><label class="text-[10px] font-bold text-app-secondary uppercase">Actual:</label><input type="number" step="0.01" id="step-input-${index}" class="w-20 p-0.5 text-xs border rounded bg-app-secondary border-app text-app-header text-center" placeholder="${detectedAmount}" value="${detectedAmount}"><span class="text-xs font-bold text-app-secondary">${detectedUnit}</span></div>`;
        } else if (isCompleted && savedAmount) {
             inputHtml = `<div class="mt-1 text-[10px] text-green-600 font-mono">✓ Added: ${savedAmount} ${detectedUnit || ''}</div>`;
        }

        const timerHtml = step.duration > 0 ? `<div class="timer-display my-1 text-sm font-mono font-bold text-app-brand" id="timer-${index}">${formatTime(step.duration)}</div>` : '';
        
        const buttonsHtml = step.duration > 0 
            ? `<button data-action="startTimer" data-step="${index}" class="text-xs bg-green-600 text-white py-1 px-3 rounded shadow hover:bg-green-700 btn uppercase tracking-wide">Start Timer</button>` 
            : `<button data-action="completeStep" data-step="${index}" data-unit="${detectedUnit}" class="text-xs bg-app-tertiary border border-app-brand/30 text-app-brand font-bold py-1 px-3 rounded hover:bg-app-brand hover:text-white transition-colors btn uppercase tracking-wide">Check</button>`;

        // --- HIER ZIT DE FIX: Check of de beschrijving nuttig is ---
        // We tonen het ALLEEN als het bestaat, niet leeg is, en niet de standaardzin is.
        let descHtml = '';
        if (step.description && 
            step.description.trim() !== '' && 
            !step.description.toLowerCase().includes('follow the instruction')) {
            
            descHtml = `<p class="text-xs text-app-secondary mt-1 leading-snug">${step.description}</p>`;
        }

        return `
        <div id="step-${index}" class="step-item p-3 border-b border-app-brand/10 last:border-0 ${isCompleted ? 'opacity-60 grayscale' : ''}">
            <div class="flex justify-between items-start gap-3">
                <div class="flex-grow">
                    <p class="step-title font-bold text-sm text-app-header leading-tight">${index + 1}. ${step.title}</p>
                    ${descHtml}
                    ${inputHtml}
                    ${timerHtml}
                </div>
                <div class="flex-shrink-0 pt-1" id="controls-${index}">
                    ${isCompleted ? '<span class="text-xs font-bold text-green-600 border border-green-600 px-2 py-0.5 rounded">DONE</span>' : buttonsHtml}
                </div>
            </div>
        </div>`;
    }).join('');

    const parsedTargets = parseRecipeData(brew.recipeMarkdown);
    const combinedLogData = { ...parsedTargets, ...brew.logData };
    const logHtml = getBrewLogHtml(combinedLogData, brew.id); 

    brewDayContent.innerHTML = `
        <div class="flex justify-between items-end mb-4">
            <h2 class="text-2xl font-header font-bold text-app-brand">${brew.recipeName}</h2>
            <button data-action="resetBrewDay" class="text-[10px] text-red-500 hover:underline">Reset</button>
        </div>
        
        <div class="mb-4 bg-app-tertiary rounded-full h-1.5"><div id="brew-day-progress" class="bg-app-brand h-1.5 rounded-full transition-all duration-500" style="width: 0%;"></div></div>
        
        <div id="brew-day-steps-container" class="bg-app-secondary rounded-lg shadow-sm border border-app-brand/10 divide-y divide-app-brand/10">
            ${stepsHtml}
        </div>
        
        <hr class="my-6 border-app-brand/10">
        ${logHtml}
        <div class="mt-4 no-print space-y-2">
            <button onclick="window.updateBrewLog('${brew.id}', 'brew-day-content')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg hover:opacity-90 btn text-sm font-bold shadow-md">Save Log Changes</button>
            <button onclick="window.deductActualsFromInventory('${brew.id}')" class="w-full bg-app-tertiary text-app-secondary border border-app-brand/20 py-2 px-4 rounded-lg hover:bg-app-secondary btn text-xs">Deduct from Inventory</button>
        </div>
    `;

    initializeBrewDayState(primarySteps);
}

// --- BREW DAY 2 (SMART & INTERACTIVE) ---
window.renderBrewDay2 = async function() {
    const container = document.getElementById('brew-day-2-view');
    if (!container) return;

    if (!currentBrewDay || !currentBrewDay.brewId) {
        container.innerHTML = `<div class="text-center p-8"><p class="text-app-secondary">No active brew selected.</p></div>`;
        return;
    }

    const brew = brews.find(b => b.id === currentBrewDay.brewId);
    if (!brew) return;

    let steps = brew.secondarySteps || [];
    let source = "Custom Recipe Steps";

    if (steps.length === 0 && brew.recipeMarkdown) {
        const extracted = extractStepsFromMarkdown(brew.recipeMarkdown);
        if (extracted.day2.length > 0) { steps = extracted.day2; source = "Extracted from Recipe"; }
    }

    if (steps.length === 0) {
        steps = [
            { title: "Stability Check", desc: "Ensure SG is stable (measure 3 days apart)." },
            { title: "Racking", desc: "Siphon mead to a clean vessel." },
            { title: "Stabilization", desc: "Add K-Meta & K-Sorbate if backsweetening." },
            { title: "Backsweetening", desc: "Add honey/fruit/spices now." },
            { title: "Clarification", desc: "Wait for clearing." },
            { title: "Bottling", desc: "Bottle when crystal clear." }
        ];
        source = "Standard Protocol";
    }

    const checklist = brew.checklist || {};

    // Compactere Lijst voor Day 2
    const stepsHtml = steps.map((step, idx) => {
        const key = `sec-step-${idx}`;
        const isChecked = checklist[key] === true;
        
        return `
        <div class="flex items-start gap-3 p-3 cursor-pointer hover:bg-app-tertiary/30 transition-colors group" onclick="window.toggleSecondaryStep('${brew.id}', '${key}')">
            <div class="pt-0.5">
                <div class="w-5 h-5 rounded border flex items-center justify-center transition-colors ${isChecked ? 'bg-green-600 border-green-600' : 'border-app-brand/40 bg-app-tertiary group-hover:border-app-brand'}">
                    ${isChecked ? '<svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>' : ''}
                </div>
            </div>
            <div>
                <h4 class="font-bold text-sm leading-tight ${isChecked ? 'text-green-600 line-through decoration-2 opacity-70' : 'text-app-header'}">${step.title}</h4>
                <p class="text-xs text-app-secondary mt-0.5 leading-snug ${isChecked ? 'line-through opacity-50' : ''}">${step.desc || step.description}</p>
            </div>
        </div>`;
    }).join('');

    container.innerHTML = `
        <div class="bg-app-secondary p-4 md:p-6 rounded-lg shadow-lg">
            <h2 class="text-2xl font-header font-bold mb-1 text-center text-app-brand">${brew.recipeName}</h2>
            <p class="text-center text-[10px] font-bold uppercase tracking-widest text-app-secondary mb-6 opacity-60">Phase 2: Aging & Packaging</p>
            
            <div class="mb-6 bg-app-primary/30 rounded-lg border border-app-brand/10 divide-y divide-app-brand/5">
                ${stepsHtml}
            </div>

            <div id="brew-day-2-log-container">${getBrewLogHtml(brew.logData, brew.id + '-secondary')}</div>

            <div class="mt-6 space-y-3">
                <button onclick="window.updateBrewLog('${brew.id}', 'brew-day-2-log-container')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg hover:opacity-90 btn font-bold text-sm shadow-md">Save Log Notes</button>
                <button onclick="window.showBottlingModal('${brew.id}')" class="w-full bg-green-600 text-white py-3 px-4 rounded-lg hover:bg-green-700 btn flex items-center justify-center gap-2 font-bold text-sm shadow-md">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"></path></svg>
                    Proceed to Bottling
                </button>
            </div>
        </div>
    `;
}

// --- FUNCTIE: SAVE SECONDARY CHECKLIST ---
window.toggleSecondaryStep = async function(brewId, stepKey) {
    const brewIndex = brews.findIndex(b => b.id === brewId);
    if (brewIndex === -1) return;

    // Initialiseer checklist als die niet bestaat
    if (!brews[brewIndex].checklist) brews[brewIndex].checklist = {};

    // Toggle de status (true -> false, false -> true)
    const currentStatus = brews[brewIndex].checklist[stepKey] === true;
    brews[brewIndex].checklist[stepKey] = !currentStatus;

    // UI Update (Optimistic - direct herrenderen voor snelheid)
    renderBrewDay2();

    // Opslaan in Cloud
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), {
            checklist: brews[brewIndex].checklist
        });
        if(navigator.vibrate) navigator.vibrate(10); // Klein trillertje voor feedback
    } catch (e) {
        console.error("Checklist save failed:", e);
        showToast("Saving failed", "error");
    }
}

// --- STATE & TIMERS ---
let brewDaySteps = [];
let currentStepIndex = 0;
let stepTimerInterval = null;
let remainingTime = 0;

function setupBrewDayEventListeners() {
    const viewContainer = document.getElementById('brewing-main-view');
    if (!viewContainer) return;
    viewContainer.addEventListener('click', function(e) {
        const target = e.target.closest('button[data-action]');
        if (!target) return; 
        const action = target.dataset.action;
        const stepIndex = parseInt(target.dataset.step);
        switch(action) {
            case 'startTimer': startStepTimer(stepIndex); break;
            case 'pauseTimer': pauseStepTimer(stepIndex); break;
            case 'skipTimer': skipTimer(stepIndex); break;
            case 'completeStep': completeStep(stepIndex, true); break;
            case 'resetBrewDay': resetBrewDay(); break;
        }
    });
}

function initializeBrewDayState(steps) {
    brewDaySteps = steps;
    const savedTimer = localStorage.getItem('activeBrewDayTimer');
    if (savedTimer) {
        const { brewId, stepIndex, endTime } = JSON.parse(savedTimer);
        if (brewId === currentBrewDay.brewId) {
            const now = Date.now();
            if (endTime > now) {
                currentStepIndex = stepIndex;
                startStepTimer(stepIndex, Math.round((endTime - now) / 1000));
                return;
            } else {
                localStorage.removeItem('activeBrewDayTimer');
                if(currentBrewDay.checklist) currentBrewDay.checklist[`step-${stepIndex}`] = true;
            }
        }
    }
    const activeBrew = brews.find(b => b.id === currentBrewDay.brewId);
    const checklist = (activeBrew && activeBrew.checklist) ? activeBrew.checklist : {};
    const lastCompleted = Object.keys(checklist).length - 1;
    currentStepIndex = lastCompleted >= 0 ? lastCompleted + 1 : 0;
    updateUI();
}

function startStepTimer(stepIndex, resumeTime = null) {
    if (stepTimerInterval) return;
    const activeBrew = brews.find(b => b.id === currentBrewDay.brewId);
    if (!activeBrew) return;
    const allSteps = [...(activeBrew.brewDaySteps || []), ...(activeBrew.secondarySteps || [])];
    const step = allSteps[stepIndex];
    if (!step) return;

    let timeLeft = resumeTime !== null ? resumeTime : (remainingTime > 0 ? remainingTime : allSteps[stepIndex].duration);
    const endTime = Date.now() + timeLeft * 1000;
    localStorage.setItem('activeBrewDayTimer', JSON.stringify({ brewId: currentBrewDay.brewId, stepIndex: stepIndex, endTime: endTime }));

    const timerDisplay = document.getElementById(`timer-${stepIndex}`);
    const controlsDiv = document.getElementById(`controls-${stepIndex}`);
    controlsDiv.innerHTML = `<button data-action="pauseTimer" data-step="${stepIndex}" class="text-sm bg-yellow-500 text-white py-1 px-3 rounded-lg hover:bg-yellow-600 btn">Pause</button><button data-action="skipTimer" data-step="${stepIndex}" class="text-sm bg-gray-500 text-white py-1 px-3 rounded-lg hover:bg-gray-600 btn">Skip</button>`;
    
    stepTimerInterval = setInterval(() => {
        remainingTime = 0; timeLeft--;
        timerDisplay.textContent = formatTime(timeLeft);
        if (timeLeft <= 0) {
            clearInterval(stepTimerInterval);
            stepTimerInterval = null;
            timerDisplay.textContent = "Done!";
            if(navigator.vibrate) navigator.vibrate([200, 100, 200]);
            localStorage.removeItem('activeBrewDayTimer');
            completeStep(stepIndex, true);
        }
    }, 1000);
}

function pauseStepTimer(stepIndex) {
    clearInterval(stepTimerInterval);
    stepTimerInterval = null;
    const timerDisplay = document.getElementById(`timer-${stepIndex}`);
    localStorage.removeItem('activeBrewDayTimer');
    const timeParts = timerDisplay.textContent.split(':');
    remainingTime = (timeParts.length === 2) ? parseInt(timeParts[0]) * 60 + parseInt(timeParts[1]) : parseInt(timeParts[0]) * 3600 + parseInt(timeParts[1]) * 60 + parseInt(timeParts[2]);
    document.getElementById(`controls-${stepIndex}`).innerHTML = `<button data-action="startTimer" data-step="${stepIndex}" class="text-sm bg-green-600 text-white py-1 px-3 rounded-lg hover:bg-green-700 btn">Resume</button>`;
}

function skipTimer(stepIndex) {
    clearInterval(stepTimerInterval);
    stepTimerInterval = null;
    remainingTime = 0;
    localStorage.removeItem('activeBrewDayTimer');
    completeStep(stepIndex, true);
}

async function resetBrewDay() {
    if (!confirm("Reset progress?")) return;
    const brewId = currentBrewDay.brewId;
    const brewIndex = brews.findIndex(b => b.id === brewId);
    if (brewIndex === -1) return;
    
    brews[brewIndex].checklist = {};
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), { checklist: {} });
        clearInterval(stepTimerInterval); stepTimerInterval = null; remainingTime = 0;
        localStorage.removeItem('activeBrewDayTimer');
        renderBrewDay(brewId);
    } catch (e) { console.error(e); }
}

async function completeStep(stepIndex, isSkipping = false) {
    if (navigator.vibrate) navigator.vibrate(15);
    if (stepTimerInterval) { clearInterval(stepTimerInterval); stepTimerInterval = null; remainingTime = 0; localStorage.removeItem('activeBrewDayTimer'); }

    const brewId = currentBrewDay.brewId;
    const brewIndex = brews.findIndex(b => b.id === brewId);
    if (brewIndex === -1) return;

    if (!brews[brewIndex].checklist) brews[brewIndex].checklist = {};
    
    // Save Actuals if input exists
    const inputEl = document.getElementById(`step-input-${stepIndex}`);
    if (inputEl) {
        const amount = inputEl.value;
        brews[brewIndex].checklist[`step-${stepIndex}`] = { completed: true, actualAmount: amount };
    } else {
        brews[brewIndex].checklist[`step-${stepIndex}`] = true;
    }

    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), { checklist: brews[brewIndex].checklist });
    } catch (e) { console.error(e); return; }

    const stepDiv = document.getElementById(`step-${stepIndex}`);
    if (stepDiv) {
        stepDiv.classList.remove('active'); stepDiv.classList.add('completed');
        const controls = document.getElementById(`controls-${stepIndex}`);
        if(controls) controls.innerHTML = `<span class="text-sm font-bold text-green-600">✓ Completed</span>`;
    }

    const activeBrew = brews[brewIndex];
    const allSteps = [...(activeBrew.brewDaySteps || []), ...(activeBrew.secondarySteps || [])];
    
    // Check if next step needs timer
    if (allSteps[stepIndex] && allSteps[stepIndex].duration > 0 && !isSkipping) {
        startStepTimer(stepIndex); return;
    }

    const nextStepIndex = stepIndex + 1;
    const nextStepDiv = document.getElementById(`step-${nextStepIndex}`);
    if (nextStepDiv) {
        nextStepDiv.classList.add('active');
    } else {
        // End of Phase Logic
        if (stepIndex === (activeBrew.brewDaySteps || []).length - 1) {
            await markPrimaryAsComplete(brewId);
            const container = stepDiv?.closest('[id$="-steps-container"]');
            if (container) container.innerHTML += `<div class="text-center p-6 card rounded-lg mt-6"><h3 class="text-2xl font-header font-bold text-green-600">Primary Complete!</h3><button onclick="window.finalizeBrewDay1()" class="bg-app-action text-white font-bold py-2 px-4 rounded-lg hover:opacity-90 btn mt-4">Go to Brew Day 2</button></div>`;
        }
    }
}

function updateUI() {
    const progress = (currentStepIndex / brewDaySteps.length) * 100;
    const bar = document.getElementById('brew-day-progress');
    if (bar) bar.style.width = `${progress}%`;
    brewDaySteps.forEach((step, index) => {
        const div = document.getElementById(`step-${index}`);
        if (!div) return;
        div.classList.remove('active', 'completed');
        const controls = document.getElementById(`controls-${index}`);
        if (index < currentStepIndex) {
            div.classList.add('completed');
            if(controls) controls.innerHTML = `<span class="text-sm font-bold text-green-600">✓ Completed</span>`;
        } else if (index === currentStepIndex) div.classList.add('active');
    });
}

function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0 ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

async function markPrimaryAsComplete(brewId) {
    if (!userId || !brewId) return;
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), { primaryComplete: true });
        const idx = brews.findIndex(b => b.id === brewId);
        if (idx > -1) brews[idx].primaryComplete = true;
    } catch (e) { console.error(e); }
}

window.finalizeBrewDay1 = async function() {
    if (currentBrewDay.brewId) await window.updateBrewLog(currentBrewDay.brewId, 'brew-day-content');
    renderBrewDay2();
    window.switchSubView('brew-day-2', 'brewing-main-view');
    currentBrewDay = { brewId: null };
    await saveUserSettings(); 
    renderBrewDay('none');
}

// --- HISTORY & DETAIL MANAGEMENT (MET V1->V2 MIGRATIE FIX) ---

// --- VERVANG DE HELE FUNCTIE loadHistory DOOR DIT ---
function loadHistory() {
    if (!userId) return;
    
    // Gebruik de vaste collectie referentie
    const q = query(collection(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews'));
    
    onSnapshot(q, (snapshot) => {
        brews = snapshot.docs.map(doc => {
            let b = { id: doc.id, ...doc.data() };
            
            // --- MIGRATIE FIX (CRUCIAAL VOOR OUDE DATA) ---
            // Als logData nog niet bestaat, maak het aan
            if (!b.logData) b.logData = {};
            
            // Lijst met velden die vroeger "los" stonden en nu in "logData" horen
            const oldFields = ['actualOG', 'actualFG', 'targetOG', 'targetFG', 'targetABV', 'finalABV', 'brewDate', 'agingNotes', 'tastingNotes', 'recipeName'];
            
            oldFields.forEach(field => {
                // Als het veld bestaat in de oude data, maar niet in de nieuwe logData...
                if (b[field] !== undefined && b.logData[field] === undefined) {
                    b.logData[field] = b[field]; // ...kopieer het dan!
                }
            });
            // ---------------------------------------------

            return b;
        });

        // Sorteren: Nieuwste eerst
        brews.sort((a, b) => {
            const dateA = a.createdAt ? a.createdAt.toDate() : new Date(0);
            const dateB = b.createdAt ? b.createdAt.toDate() : new Date(0);
            return dateB - dateA;
        });

        // Update de UI
        renderHistoryList();
        populateSocialRecipeDropdown();
        if(typeof updateCostAnalysis === 'function') updateCostAnalysis();
        if(typeof renderActiveBrewTimeline === 'function') renderActiveBrewTimeline();
        if(typeof updateNextActionWidget === 'function') updateNextActionWidget();
        if(typeof updateDashboardStats === 'function') updateDashboardStats();
    });
}

function renderHistoryList() {
    const term = document.getElementById('history-search-input')?.value.toLowerCase() || '';
    const filtered = brews.filter(b => (b.recipeName || 'Untitled').toLowerCase().includes(term));
    const list = document.getElementById('history-list');
    if (!list) return;
    
    if (brews.length === 0) { list.innerHTML = `<p class="text-center text-app-secondary/80">No brews yet.</p>`; return; }
    if (filtered.length === 0) { list.innerHTML = `<p class="text-center text-app-secondary/80">No matches.</p>`; return; }

    list.innerHTML = filtered.map(b => `<div class="p-4 card rounded-lg cursor-pointer hover:bg-app-primary" onclick="window.showBrewDetail('${b.id}')"><h4 class="font-bold text-lg font-header">${b.recipeName}</h4><p class="text-sm text-app-secondary/80">Saved: ${b.createdAt.toDate().toLocaleDateString()}</p></div>`).join('');
}

window.showBrewDetail = function(brewId) {
    switchMainView('brewing');
    switchSubView('history', 'brewing-main-view');

    const historyDetailContainer = document.getElementById('history-detail-container');
    const historyListContainer = document.getElementById('history-list-container');

    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    // 1. Markdown formatteren (Tabellen maken)
    let processedMarkdown = formatRecipeMarkdown(brew.recipeMarkdown);
    const cleanMarkdown = processedMarkdown.replace(/\[d:[\d:]+\]/g, '').replace(/^#\s.*$/m, '');
    const recipeHtml = marked.parse(cleanMarkdown);

    // 2. DATA EXTRACTIE: Haal OG/FG/ABV uit de tekst
    const parsedTargets = parseRecipeData(brew.recipeMarkdown);
    
    // 3. Samenvoegen: Database data wint, anders gebruiken we de tekst-data
    const combinedLogData = { 
        ...parsedTargets, // Eerst de data uit de tekst
        ...brew.logData   // Dan de data uit de database (overschrijft tekst indien aanwezig)
    };

    // 4. Render het logboek met de gecombineerde data
    const logHtml = getBrewLogHtml(combinedLogData, brew.id);
    
    // --- KOSTEN BEREKENING UPDATE ---
    const currency = userSettings.currencySymbol || '€';
    let costHtml = '';
    
    if (brew.totalCost > 0) {
        // 1. Bepaal het ECHTE volume (Volume na racking > Oorspronkelijke batch size)
        // We kijken of er in logData een 'currentVolume' staat (ons nieuwe veld)
        // Let op: logData kan leeg zijn bij oude batches, dus we bouwen veiligheid in.
        const realVolume = (brew.logData && brew.logData.currentVolume && parseFloat(brew.logData.currentVolume) > 0) 
                           ? parseFloat(brew.logData.currentVolume) 
                           : (brew.batchSize > 0 ? brew.batchSize : 0);

        // 2. Bereken prijs per liter op basis van wat er écht over is
        const perL = realVolume > 0 ? brew.totalCost / realVolume : 0;
        
        // 3. Toon de info (Met een labeltje als het gebaseerd is op Racking Volume)
        const volumeLabel = (brew.logData && brew.logData.currentVolume) ? "Actual Vol" : "Target Vol";
        
        costHtml = `
            <div class="mt-6 p-4 bg-amber-100 rounded-lg dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30">
                <div class="flex justify-between items-end">
                    <div>
                        <h3 class="font-header text-lg text-amber-900 dark:text-amber-200 font-bold uppercase">Financials</h3>
                        <p class="text-xs text-amber-800/70 dark:text-amber-300/70">Based on ${volumeLabel}: ${realVolume}L</p>
                    </div>
                    <div class="text-right">
                         <p class="text-sm text-amber-900 dark:text-amber-100">Total: <strong>${currency}${brew.totalCost.toFixed(2)}</strong></p>
                         <p class="text-xl font-bold text-amber-700 dark:text-amber-400">${currency}${perL.toFixed(2)} <span class="text-xs font-normal">/ L</span></p>
                    </div>
                </div>
            </div>`;
    }

    historyDetailContainer.innerHTML = `
        <button onclick="window.goBackToHistoryList()" class="mb-4 text-app-brand hover:underline no-print">&larr; Back</button>
        <div class="mb-4">
            <div id="title-display-${brew.id}"><h2 class="text-3xl font-header font-bold w-full">${brew.recipeName}</h2><div class="text-right w-full mt-1"><button onclick="window.showTitleEditor('${brew.id}')" class="text-blue-600 text-sm no-print">Edit Title</button></div></div>
            <div id="title-editor-${brew.id}" class="hidden"><input type="text" id="title-input-${brew.id}" value="${brew.recipeName}" class="w-full text-2xl font-bold p-2 border rounded-md"><div class="flex gap-2 mt-2"><button onclick="window.saveNewTitle('${brew.id}')" class="bg-green-600 text-white px-3 py-1 rounded btn">Save</button><button onclick="window.hideTitleEditor('${brew.id}')" class="bg-gray-500 text-white px-3 py-1 rounded btn">Cancel</button></div></div>
        </div>
        
        <div class="print-button-container mb-4 grid grid-cols-2 gap-2 no-print">
            <button onclick="window.resumeBrew('${brew.id}')" class="bg-green-600 text-white py-2 px-4 rounded btn font-bold shadow-md hover:bg-green-700 flex items-center justify-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                Resume Batch
            </button>
            <button onclick="window.cloneBrew('${brew.id}')" class="bg-blue-600 text-white py-2 px-4 rounded btn font-bold shadow-md hover:bg-blue-700 flex items-center justify-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                Brew Again
            </button>
            <button onclick="window.recalculateBatchCost('${brew.id}')" class="bg-purple-700 text-white py-2 px-4 rounded btn text-xs">Recalc Cost</button>
            <button onclick="window.deleteBrew('${brew.id}')" class="bg-red-700 text-white py-2 px-4 rounded btn text-xs">Delete</button>
        </div>

        <div class="recipe-content">${recipeHtml}</div>${costHtml}
        
        <div class="mt-6 card p-4 rounded-lg"><h3 class="font-header text-lg text-center">Fermentation</h3><canvas id="fermChart-${brew.id}"></canvas></div>
        
        ${logHtml}
        
        <div class="mt-4 no-print"><button onclick="window.updateBrewLog('${brew.id}', 'history-detail-container')" class="w-full bg-app-action text-white py-3 px-4 rounded btn">Save Log</button></div>
        
        <div class="mt-6 pt-4 border-t-2 border-app-brand no-print">
            <h3 class="text-2xl font-header font-bold text-center mb-4">Flavor Profile</h3>
            <div class="card p-4 rounded-lg text-center">
                <button onclick="window.generateFlavorWheel('${brew.id}')" class="bg-purple-600 text-white py-2 px-4 rounded btn">Analyze Notes</button>
                <div id="flavor-wheel-container-${brew.id}" class="mt-4" style="max-width: 400px; margin: auto;"></div>
            </div>
        </div>
        
        <div class="mt-6 pt-4 border-t-2 border-app no-print">
             <h3 class="text-2xl font-header font-bold text-center mb-4">Tweak Recipe</h3>
             <div class="card p-4 rounded-lg">
                <textarea id="tweak-request-${brew.id}" rows="3" class="w-full p-2 border rounded-md" placeholder="How to tweak?"></textarea>
                <button onclick="window.freeformTweakRecipe('${brew.id}')" class="w-full mt-3 bg-purple-700 text-white py-3 px-4 rounded btn">Generate Tweak</button>
             </div>
        </div>
        <div id="tweak-output-${brew.id}" class="mt-6"></div>
    `;
    historyListContainer.classList.add('hidden');
    historyDetailContainer.classList.remove('hidden');
    
    // Render grafieken
    renderFermentationGraph(brew.id);
    if (brew.predictedFlavorProfile) {
        const container = document.getElementById(`flavor-wheel-container-${brew.id}`);
        container.style.display = 'block';
        renderFlavorWheel(brew.id, ['Sweetness', 'Acidity', 'Fruity/Floral', 'Spiciness', 'Earthy/Woody', 'Body'], Object.values(brew.predictedFlavorProfile));
    }

    // Dit zorgt dat Actual FG en ABV direct worden ingevuld op basis van de tabel
    setTimeout(() => {
        window.syncLogToFinal(brew.id); 
    }, 50);

}

// --- GRAFIEKEN VOOR HISTORIE ---

window.renderFermentationGraph = function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew || !brew.logData || !brew.logData.fermentationLog) return;

    const ctx = document.getElementById(`fermChart-${brewId}`);
    if (!ctx) return;

    // Filter lege regels eruit en sorteer op datum
    const log = brew.logData.fermentationLog.filter(l => l.date && l.sg);
    log.sort((a, b) => new Date(a.date) - new Date(b.date));

    if (log.length === 0) {
        ctx.parentElement.classList.add('hidden'); // Verberg als er geen data is
        return;
    }

    const labels = log.map(l => l.date);
    const dataSG = log.map(l => parseFloat(l.sg));

    if (window[`fermChartInstance_${brewId}`]) {
        window[`fermChartInstance_${brewId}`].destroy();
    }

    window[`fermChartInstance_${brewId}`] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Specific Gravity (S.G.)',
                data: dataSG,
                borderColor: '#d97706',
                backgroundColor: 'rgba(217, 119, 6, 0.1)',
                borderWidth: 2,
                tension: 0.1,
                fill: true
            }]
        },
        options: {
            responsive: true,
            scales: { y: { beginAtZero: false, title: { display: true, text: 'Gravity' } } }
        }
    });
}

window.renderFlavorWheel = function(brewId, labels, data) {
    const container = document.getElementById(`flavor-wheel-container-${brewId}`);
    if (!container) return;

    container.innerHTML = `<canvas id="flavorChart-${brewId}"></canvas>`;
    const ctx = document.getElementById(`flavorChart-${brewId}`);

    const brandColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-color').trim() || '#d97706';
    const isDarkMode = document.documentElement.classList.contains('dark');
    const textColor = isDarkMode ? '#e0e0e0' : '#4a3c2c';
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)';

    new Chart(ctx, {
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
            scales: {
                r: {
                    angleLines: { color: gridColor },
                    grid: { color: gridColor },
                    pointLabels: { color: textColor, font: { size: 11 } },
                    ticks: { display: false, max: 5 },
                    suggestedMin: 0,
                    suggestedMax: 5
                }
            },
            plugins: { legend: { display: false } }
        }
    });
}

// --- GRAFIEKEN VOOR HISTORIE (ONTBREKENDE FUNCTIES) ---

function renderFermentationGraph(brewId) {
    const brew = brews.find(b => b.id === brewId);
    // Check of er log data is, anders stoppen we
    if (!brew || !brew.logData || !brew.logData.fermentationLog) return;

    const ctx = document.getElementById(`fermChart-${brewId}`);
    if (!ctx) return;

    // Filter lege regels eruit en sorteer op datum
    const log = brew.logData.fermentationLog.filter(l => l.date && l.sg);
    log.sort((a, b) => new Date(a.date) - new Date(b.date));

    if (log.length === 0) {
        // Geen metingen? Verberg de grafiek container
        ctx.parentElement.classList.add('hidden');
        return;
    }

    const labels = log.map(l => l.date);
    const dataSG = log.map(l => parseFloat(l.sg));

    // Vernietig oude grafiek indien aanwezig (voorkomt glitches bij heropenen)
    if (window[`fermChartInstance_${brewId}`]) {
        window[`fermChartInstance_${brewId}`].destroy();
    }

    // Maak nieuwe grafiek
    window[`fermChartInstance_${brewId}`] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Specific Gravity (S.G.)',
                data: dataSG,
                borderColor: '#d97706', // Amber kleur
                backgroundColor: 'rgba(217, 119, 6, 0.1)',
                borderWidth: 2,
                tension: 0.1,
                fill: true
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: false,
                    title: { display: true, text: 'Gravity' }
                }
            }
        }
    });
}

function renderFlavorWheel(brewId, labels, data) {
    const container = document.getElementById(`flavor-wheel-container-${brewId}`);
    if (!container) return;

    // Maak canvas vers aan
    container.innerHTML = `<canvas id="flavorChart-${brewId}"></canvas>`;
    const ctx = document.getElementById(`flavorChart-${brewId}`);

    // Bepaal kleuren op basis van Dark/Light mode
    const brandColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-color').trim() || '#d97706';
    const isDarkMode = document.documentElement.classList.contains('dark');
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDarkMode ? '#e0e0e0' : '#4a3c2c';

    new Chart(ctx, {
        type: 'radar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Flavor Profile',
                data: data,
                backgroundColor: brandColor + '4D', // 30% opacity hex
                borderColor: brandColor,
                borderWidth: 2,
                pointBackgroundColor: brandColor
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            scales: {
                r: {
                    angleLines: { color: gridColor },
                    grid: { color: gridColor },
                    pointLabels: { color: textColor, font: { size: 11, family: "'Barlow Semi Condensed', sans-serif" } },
                    ticks: { display: false, max: 5 },
                    suggestedMin: 0,
                    suggestedMax: 5
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

// --- HERVAT OUDE BROUWSSELS ---
window.resumeBrew = async function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    // 1. Zet de globale pointer
    currentBrewDay = { brewId: brewId };
    
    // 2. Sla op in database zodat de app het onthoudt bij herladen
    await saveUserSettings(); 

    // 3. Bepaal waar we heen moeten (Day 1 of Day 2?)
    switchMainView('brewing');
    
    if (brew.primaryComplete || brew.logData?.primaryComplete) {
        // Als Primary al klaar was, ga direct naar Day 2 (Aging)
        switchSubView('brew-day-2', 'brewing-main-view');
        renderBrewDay2();
        showToast(`Resumed aging for "${brew.recipeName}"`, "success");
    } else {
        // Anders terug naar Day 1
        switchSubView('brew-day-1', 'brewing-main-view');
        renderBrewDay(brewId);
        showToast(`Resumed brewing "${brew.recipeName}"`, "success");
    }
}

// --- FUNCTIE: RECEPT KOPIËREN VOOR NIEUWE BATCH ---
window.cloneBrew = async function(brewId) {
    const original = brews.find(b => b.id === brewId);
    if (!original) return;

    if (!confirm(`Start a fresh new batch based on "${original.recipeName}"?`)) return;

    try {
        // Maak een kopie, maar WIST de logboeken en datums
        const newBrew = {
            recipeName: `${original.recipeName} (Batch 2)`, // Of (Clone)
            recipeMarkdown: original.recipeMarkdown,
            flavorProfile: original.flavorProfile || {},
            createdAt: serverTimestamp(),
            model: original.model || userSettings.aiModel,
            
            // SCHONE LEI:
            logData: {},         // Geen oude metingen
            checklist: {},       // Geen afgevinkte stappen
            brewDaySteps: original.brewDaySteps || [], // Stappenplan behouden we wel!
            secondarySteps: original.secondarySteps || [],
            totalCost: 0,        // Kosten opnieuw berekenen (prijzen kunnen veranderd zijn)
            isBottled: false,
            primaryComplete: false
        };

        const docRef = await addDoc(collection(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews'), newBrew);
        
        showToast("Recipe cloned! Starting new brew day...", "success");
        
        // Ga direct naar de nieuwe batch
        window.startActualBrewDay(docRef.id);

    } catch (e) {
        console.error(e);
        showToast("Error cloning recipe.", "error");
    }
}

window.goBackToHistoryList = function() {
    const detailContainer = document.getElementById('history-detail-container');
    detailContainer.innerHTML = ''; // Fix double ID issue
    detailContainer.classList.add('hidden');
    document.getElementById('history-list-container').classList.remove('hidden');
}

// --- LOGGING & DATA FUNCTIONS ---

function getLogDataFromDOM(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return {};
    const logSection = container.querySelector('.brew-log-section');
    if (!logSection) return {};
    const suffix = `-${logSection.dataset.id}`;
    
    const actuals = Array.from(container.querySelectorAll(`#actualsTable${suffix} tbody tr`)).map(row => ({
        name: row.dataset.name,
        plannedQty: row.dataset.plannedqty,
        plannedUnit: row.dataset.plannedunit,
        actualQty: row.querySelector('.actual-qty-input').value,
        actualUnit: row.dataset.plannedunit
    }));

    return {
        recipeName: container.querySelector(`#recipeName${suffix}`)?.value || '',
        brewDate: container.querySelector(`#brewDate${suffix}`)?.value || '',
        targetOG: container.querySelector(`#targetOG${suffix}`)?.value || '',
        actualOG: container.querySelector(`#actualOG${suffix}`)?.value || '',
        targetFG: container.querySelector(`#targetFG${suffix}`)?.value || '',
        actualFG: container.querySelector(`#actualFG${suffix}`)?.value || '',
        targetABV: (container.querySelector(`#targetABV${suffix}`)?.value || '').replace('%', ''),
        finalABV: container.querySelector(`#finalABV${suffix}`)?.value || '',
        currentVolume: container.querySelector(`#currentVol${suffix}`)?.value || '',
        actualIngredients: actuals,
        fermentationLog: Array.from(container.querySelectorAll(`#fermentationTable${suffix} tbody tr`)).map(row => ({
            date: row.cells[0].querySelector('input').value,
            temp: row.cells[1].querySelector('input').value,
            sg: row.cells[2].querySelector('input').value,
            notes: row.cells[3].querySelector('input').value,
        })),
        blendingLog: Array.from(container.querySelectorAll(`#blendingTable${suffix} tbody tr`)).map(row => ({
            date: row.cells[0].querySelector('input').value,
            name: row.cells[1].querySelector('input').value,
            vol: row.cells[2].querySelector('input').value,
            abv: row.cells[3].querySelector('input').value,
        })),
        agingNotes: container.querySelector(`#agingNotes${suffix}`)?.value || '',
        bottlingNotes: container.querySelector(`#bottlingNotes${suffix}`)?.value || '',
        tastingNotes: container.querySelector(`#tastingNotes${suffix}`)?.value || '',
    };
}

function getBrewLogHtml(logData, idSuffix = 'new', parsedTargets = {}) {
    const data = logData || {};
    const useTargetOG = parsedTargets.targetOG || data.targetOG || '';
    const useTargetFG = parsedTargets.targetFG || data.targetFG || '';
    const useTargetABV = parsedTargets.targetABV || data.targetABV || '';
    const fermLog = data.fermentationLog || Array.from({ length: 3 }, () => ({}));
    
    // 1. Haal de Blending data op
    const blendingLog = data.blendingLog || [];

    const copyOgToLogScript = `const ogInput = document.getElementById('actualOG-${idSuffix}'); const firstSgInput = document.querySelector('#fermentationTable-${idSuffix} tbody tr:first-child td:nth-child(3) input'); if (ogInput && firstSgInput) { firstSgInput.value = ogInput.value; }`;

    // 2. De HTML voor de Blending tabel (AANGEPAST: Uniforme Stijl)
    const blendingHtml = `
    <div class="log-item mt-6 border-t-2 border-app-brand/10 pt-4">
        <div class="flex justify-between items-end mb-4">
            <div>
                <label class="font-bold text-app-header flex items-center gap-2 mb-1">
                    <svg class="w-4 h-4 text-app-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"></path></svg>
                    Fortification / Blending
                </label>
                <div class="flex items-center gap-2 text-xs">
                    <span class="text-app-secondary">Vol after racking (L):</span>
                    <input type="number" id="currentVol-${idSuffix}" step="0.01" value="${data.currentVolume || ''}" placeholder="e.g. 4.6" 
                           class="w-16 p-1 text-center border rounded bg-app-tertiary border-app-brand/20 text-app-header font-bold focus:ring-1 focus:ring-app-brand" 
                           oninput="window.recalcTotalABV('${idSuffix}')">
                </div>
            </div>
            <button onclick="window.addBlendingRow('${idSuffix}')" class="text-xs bg-app-tertiary text-app-brand border border-app-brand/20 px-3 py-1.5 rounded hover:bg-app-secondary font-bold uppercase transition-colors shadow-sm h-8 flex items-center">
                + Add Liquid
            </button>
        </div>
        
        <div class="overflow-x-auto log-container">
            <table class="fermentation-table w-full" id="blendingTable-${idSuffix}">
                <thead>
                    <tr>
                        <th style="width:130px;">Date</th>
                        <th>Liquid Name</th>
                        <th style="width:80px;">Vol (L)</th>
                        <th style="width:80px;">ABV %</th>
                        <th style="width:40px;"></th>
                    </tr>
                </thead>
                <tbody>
                    ${blendingLog.map((row, idx) => `
                    <tr data-index="${idx}">
                        <td><input type="date" value="${row.date}" class="w-full"></td>
                        <td><input type="text" value="${row.name}" class="w-full" placeholder="e.g. Moonshine"></td>
                        <td><input type="number" step="0.01" value="${row.vol}" class="w-full text-center" oninput="window.recalcTotalABV('${idSuffix}')"></td>
                        <td><input type="number" step="0.1" value="${row.abv}" class="w-full text-center" oninput="window.recalcTotalABV('${idSuffix}')"></td>
                        <td class="text-center">
                            <button onclick="this.closest('tr').remove(); window.recalcTotalABV('${idSuffix}')" class="text-red-500 hover:text-red-700 font-bold text-lg leading-none">&times;</button>
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>
    
    <div class="overflow-x-auto log-container">
        <table class="fermentation-table w-full" id="blendingTable-${idSuffix}">
            </table>
    </div>
    
    <div class="mt-3 mb-6 flex justify-end">
        <div id="blending-summary-${idSuffix}" class="text-right bg-app-tertiary/50 p-3 rounded-lg border border-app-brand/10 shadow-sm min-w-[220px]">
            <p class="text-[10px] text-app-secondary uppercase tracking-wider mb-1">Summary</p>
            <p class="text-xs text-app-header italic">Set 'Vol after racking' to calc.</p>
        </div>
    </div>
</div>
`;
    </div>
    `;

    return `
        <div class="brew-log-section" data-id="${idSuffix}">
            <h3>Brewmaster's Log</h3>
            <div class="log-grid">
                <div class="log-item"><label>Recipe Name:</label><input type="text" id="recipeName-${idSuffix}" value="${data.recipeName || ''}"></div>
                <div class="log-item"><label>Brew Date:</label><input type="date" id="brewDate-${idSuffix}" value="${data.brewDate || ''}"></div>
            </div>
            <div class="log-grid">
                <div class="log-item"><label>Target OG:</label><input type="text" id="targetOG-${idSuffix}" value="${useTargetOG}" readonly class="bg-app-primary"></div>
                <div class="log-item"><label>Actual OG:</label><input type="text" id="actualOG-${idSuffix}" value="${data.actualOG || ''}" oninput="${copyOgToLogScript}; window.autoCalculateABV('${idSuffix}')"></div>
                <div class="log-item"><label>Target FG:</label><input type="text" id="targetFG-${idSuffix}" value="${useTargetFG}" readonly class="bg-app-primary"></div>
                <div class="log-item"><label>Actual FG:</label><input type="text" id="actualFG-${idSuffix}" value="${data.actualFG || ''}" oninput="window.autoCalculateABV('${idSuffix}')"></div>
                <div class="log-item"><label>Target ABV:</label><input type="text" id="targetABV-${idSuffix}" value="${useTargetABV}%" readonly class="bg-app-primary"></div>
                <div class="log-item"><label>Final ABV:</label><input type="text" id="finalABV-${idSuffix}" value="${data.finalABV || ''}"></div>
            </div>
            <div class="log-item">
                <label>Fermentation Log</label>
                <div class="overflow-x-auto log-container">
                     <table class="fermentation-table table-fixed w-full" id="fermentationTable-${idSuffix}" style="min-width: 500px;">
                        <thead><tr><th style="width: 120px;">Date</th><th style="width: 80px;">Temp (°C)</th><th style="width: 90px;">S.G.</th><th>Notes</th></tr></thead>
                        <tbody>${fermLog.map(row => `<tr>
                                <td><input type="date" value="${row.date || ''}" class="w-full"></td>
                                <td><input type="number" step="0.5" value="${row.temp || '18'}" class="w-full text-center"></td>
                                <td><input type="number" step="0.001" value="${row.sg || ''}" class="w-full text-center" oninput="window.syncLogToFinal('${idSuffix}')"></td>
                                <td><input type="text" value="${row.notes || ''}" class="w-full"></td>
                            </tr>`).join('')}</tbody>
                    </table>
                    
                    <div class="text-right mt-2">
                        <button onclick="window.addLogLine('${idSuffix}')" class="text-xs bg-app-tertiary text-app-brand border border-app-brand/20 px-3 py-1.5 rounded hover:bg-app-secondary font-bold uppercase transition-colors shadow-sm inline-flex items-center">
                            + Add Measurement
                        </button>
                    </div>
                </div>
            </div>
            
            ${blendingHtml}

            <div class="log-item"><label>Aging Notes:</label><textarea id="agingNotes-${idSuffix}" rows="4">${data.agingNotes || ''}</textarea></div>
            <div class="log-item"><label>Bottling Notes:</label><textarea id="bottlingNotes-${idSuffix}" rows="3">${data.bottlingNotes || ''}</textarea></div>
            <div class="log-item"><label>Tasting Notes:</label><textarea id="tastingNotes-${idSuffix}" rows="6">${data.tastingNotes || ''}</textarea></div>
        </div>
    `;
}

function getActualIngredientsHtml(brew) {
    const idSuffix = brew.id;
    const planned = parseIngredientsFromMarkdown(brew.recipeMarkdown);
    const actuals = brew.logData?.actualIngredients || [];
    if (planned.length === 0) return '';

    const rows = planned.map(p => {
        const saved = actuals.find(a => a.name === p.name);
        const val = saved ? saved.actualQty : p.quantity;
        return `<tr data-name="${p.name}" data-plannedqty="${p.quantity}" data-plannedunit="${p.unit}"><td class="py-2 px-3">${p.name}</td><td class="py-2 px-3 text-app-secondary">${p.quantity} ${p.unit}</td><td class="py-2 px-3"><input type="number" step="0.01" class="actual-qty-input w-24 p-1 border rounded bg-app-primary border-app text-app-header" value="${val}"></td><td class="py-2 px-3">${p.unit}</td></tr>`;
    }).join('');

    return `<div class="log-item"><label>Actual Ingredients Log</label><table class="fermentation-table w-full" id="actualsTable-${idSuffix}"><thead><tr><th>Ingredient</th><th>Planned</th><th>Actual</th><th>Unit</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// --- VEILIGE VERSIE: VOORKOMT DATAVERLIES ---
window.updateBrewLog = async function(brewId, containerId) {
    if (!userId || !brewId) return;
    
    // UI Feedback (Knop veranderen)
    const container = document.getElementById(containerId);
    const btn = container ? container.querySelector('button[onclick*="updateBrewLog"]') : null;
    const originalText = btn ? btn.innerText : 'Save';
    if(btn) { btn.disabled = true; btn.innerText = "Securing Data..."; }

    try {
        // 1. Haal de nieuwe waarden van het scherm
        const formValues = getLogDataFromDOM(containerId);

        // 2. DATABASE CHECK: Haal eerst de allerlaatste versie uit de cloud
        // Dit is de "Safety Lock": we kijken wat er al is voordat we schrijven.
        const brewRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId);
        const docSnap = await getDoc(brewRef);
        
        if (!docSnap.exists()) throw new Error("Batch not found in DB");
        
        const currentDBData = docSnap.data();
        const currentLogData = currentDBData.logData || {};

        // 3. INTELLIGENT MERGEN (Deep Merge)
        // We nemen de oude data als basis (currentLogData)
        // En plakken de nieuwe input (formValues) eroverheen.
        // Hierdoor blijven velden die per ongeluk niet op het scherm stonden, TOCH bewaard.
        
        // Speciale check voor de Fermentatie Log (Lijsten zijn gevoelig voor overschrijven)
        let safeFermentationLog = formValues.fermentationLog;
        
        // Als de nieuwe lijst leeg lijkt (bv. render fout), maar de database heeft wel data...
        // ...dan behouden we de data uit de database!
        const isNewLogEmpty = !formValues.fermentationLog || formValues.fermentationLog.every(r => !r.date && !r.sg);
        if (isNewLogEmpty && currentLogData.fermentationLog && currentLogData.fermentationLog.length > 0) {
            console.warn("⚠️ Empty log detected from UI. Preserving DB data.");
            safeFermentationLog = currentLogData.fermentationLog;
        }

        const finalLogData = {
            ...currentLogData,  // 1. Basis = Wat we al hadden
            ...formValues,      // 2. Update = Wat we nu invullen
            fermentationLog: safeFermentationLog // 3. Veilige lijst
        };

        // 4. Update ook de lokale cache direct (zodat de grafieken updaten zonder refresh)
        const brewIndex = brews.findIndex(b => b.id === brewId);
        if (brewIndex > -1) brews[brewIndex].logData = finalLogData;

        // 5. Schrijven naar Cloud
        await updateDoc(brewRef, { logData: finalLogData });

        // Succes melding
        showToast('Log safely secured!', 'success');
        if(btn) { 
            btn.innerText = "Saved!"; 
            btn.classList.add('bg-green-600'); 
            setTimeout(() => { 
                btn.disabled = false; 
                btn.innerText = originalText; 
                btn.classList.remove('bg-green-600'); 
            }, 2000); 
        }

    } catch(e) {
        console.error("Save Error:", e);
        showToast('Save failed. Old data protected.', 'error'); // Geruststellende error
        if(btn) { btn.disabled = false; btn.innerText = originalText; }
    }
}

window.addLogLine = function(idSuffix) {
    const tbody = document.querySelector(`#fermentationTable-${idSuffix} tbody`);
    if (!tbody) return;
    const newRow = document.createElement('tr');
    newRow.innerHTML = `
        <td><input type="date" class="w-full" ondblclick="this.value = new Date().toISOString().split('T')[0]"></td>
        <td><input type="number" step="0.5" class="w-full text-center"></td>
        <td><input type="number" step="0.001" class="w-full text-center" oninput="window.syncLogToFinal('${idSuffix}')"></td>
        <td><input type="text" class="w-full"></td>
    `;
    tbody.appendChild(newRow);
}

// --- BLENDING AUTOMATION LOGIC ---

window.addBlendingRow = function(idSuffix) {
    const tbody = document.querySelector(`#blendingTable-${idSuffix} tbody`);
    const today = new Date().toISOString().split('T')[0];
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="date" value="${today}" class="w-full"></td>
        <td><input type="text" class="w-full" placeholder="Name"></td>
        <td><input type="number" step="0.01" class="w-full text-center" oninput="window.recalcTotalABV('${idSuffix}')"></td>
        <td><input type="number" step="0.1" class="w-full text-center" oninput="window.recalcTotalABV('${idSuffix}')"></td>
        <td class="text-center"><button onclick="this.closest('tr').remove(); window.recalcTotalABV('${idSuffix}')" class="text-red-500 font-bold">&times;</button></td>
    `;
    tbody.appendChild(tr);
};

window.recalcTotalABV = function(idSuffix) {
    // 1. Haal basis gegevens
    const targetABVField = document.getElementById(`targetABV-${idSuffix}`);
    const finalABVField = document.getElementById(`finalABV-${idSuffix}`);
    
    // NIEUW: Haal het "Volume na racking" op
    const currentVolInput = document.getElementById(`currentVol-${idSuffix}`);
    
    // Probeer batch size te vinden als fallback
    let fallbackVol = 5.0;
    if(brews && currentBrewDay.brewId) {
         const b = brews.find(x => x.id === currentBrewDay.brewId);
         if(b) fallbackVol = b.batchSize || 5;
    }

    // Gebruik de input, of anders de fallback
    let startVolume = parseFloat(currentVolInput.value);
    if (isNaN(startVolume) || startVolume <= 0) {
        startVolume = fallbackVol;
    }

    // Haal de "Base ABV" op (wat de gist heeft gemaakt)
    let baseABV = parseFloat(finalABVField.value) || parseFloat(targetABVField.value) || 0;
    
    // Check of we SG-based ABV moeten gebruiken
    const ogVal = parseFloat(document.getElementById(`actualOG-${idSuffix}`).value.replace(',', '.'));
    const fgVal = parseFloat(document.getElementById(`actualFG-${idSuffix}`).value.replace(',', '.'));
    if (!isNaN(ogVal) && !isNaN(fgVal)) {
        baseABV = (ogVal - fgVal) * 131.25;
    }

    // --- DE REKENSOM ---
    // Hoeveel pure alcohol zit er in de startvloeistof?
    let totalAlcVolume = startVolume * (baseABV / 100);
    let totalLiquidVolume = startVolume;

    // 2. Loop door de blending tabel en voeg toe
    const rows = document.querySelectorAll(`#blendingTable-${idSuffix} tbody tr`);
    rows.forEach(row => {
        const inputs = row.querySelectorAll('input');
        const vol = parseFloat(inputs[2].value) || 0;
        const abv = parseFloat(inputs[3].value) || 0;
        
        if (vol > 0) {
            totalLiquidVolume += vol;
            totalAlcVolume += (vol * (abv / 100));
        }
    });

    // 3. Bereken Totaal
    const newABV = (totalAlcVolume / totalLiquidVolume) * 100;
    
    // 4. Update UI
    // We updaten Final ABV alleen als er daadwerkelijk blending rows zijn OF als het volume is aangepast
    finalABVField.value = newABV.toFixed(2) + '%';
    
    const summary = document.getElementById(`blending-summary-${idSuffix}`);
    if(summary) {
        // NIEUWE OPMAAK: Strak uitgelijnd met Flexbox
        summary.innerHTML = `
            <div class="flex justify-between gap-4 text-xs text-app-secondary mb-1">
                <span>Base (${startVolume.toFixed(2)}L):</span>
                <span>${baseABV.toFixed(2)}%</span>
            </div>
            <div class="flex justify-between gap-4 text-sm font-bold text-app-brand border-t border-app-brand/20 pt-2 mt-1">
                <span>New Total (${totalLiquidVolume.toFixed(2)}L):</span>
                <span>${newABV.toFixed(2)}% ABV</span>
            </div>
        `;
    }
};

// --- VERBETERDE ABV CALCULATOR (Live Update) ---
window.autoCalculateABV = function(idSuffix) {
    // 1. Haal de velden op
    const ogInput = document.getElementById(`actualOG-${idSuffix}`);
    const fgInput = document.getElementById(`actualFG-${idSuffix}`);
    const abvInput = document.getElementById(`finalABV-${idSuffix}`);

    if (!ogInput || !fgInput || !abvInput) return;

    // 2. Waardes ophalen & Komma's fixen (Europa gebruikt , en JS wil .)
    const ogText = ogInput.value.replace(',', '.');
    const fgText = fgInput.value.replace(',', '.');

    const og = parseFloat(ogText);
    const fg = parseFloat(fgText);

    // 3. Berekenen
    if (!isNaN(og) && !isNaN(fg) && og > 0 && fg > 0) {
        // De standaard formule: (OG - FG) * 131.25
        const abv = (og - fg) * 131.25;
        
        // Afronden op 1 decimaal en % teken toevoegen
        // We zorgen dat het niet negatief kan zijn (als OG nog niet ingevuld is)
        abvInput.value = abv >= 0 ? abv.toFixed(1) + '%' : '0.0%';
    } else {
        // Als de velden leeg of ongeldig zijn, maak ABV leeg
        abvInput.value = '';
    }
};

// --- AUTO SYNC: Tabel naar Hoofdveld ---
window.syncLogToFinal = function(idSuffix) {
    // 1. Zoek alle rijen in de tabel
    const rows = document.querySelectorAll(`#fermentationTable-${idSuffix} tbody tr`);
    let lastKnownSG = '';

    // 2. Loop erdoorheen en onthoud de laatste waarde die niet leeg is
    rows.forEach(row => {
        // De SG input zit in de 3e kolom (index 2)
        const sgInput = row.cells[2].querySelector('input');
        if (sgInput && sgInput.value.trim() !== '') {
            lastKnownSG = sgInput.value;
        }
    });

    // 3. Update het "Actual FG" veld bovenaan
    if (lastKnownSG) {
        const fgField = document.getElementById(`actualFG-${idSuffix}`);
        if (fgField) {
            fgField.value = lastKnownSG;
            // Trigger direct de ABV berekening zodat het percentage ook update
            window.autoCalculateABV(idSuffix); 
        }
    }
};

function parseIngredientsFromMarkdown(markdown) {
    const ingredients = [];
    const jsonRegex = /(?:```json\s*)?(\[\s*\{[\s\S]*?\}\s*\])(?:\s*```)?/;
    const jsonMatch = markdown.match(jsonRegex);

    if (jsonMatch && jsonMatch[1]) {
        try {
            let safeJson = jsonMatch[1].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            const arr = JSON.parse(safeJson);
            return arr.map(i => ({ name: (i.ingredient||'').trim(), quantity: parseFloat(i.quantity)||0, unit: (i.unit||'').trim() }));
        } catch (e) { console.error(e); }
    }
    // Fallback voor oude tabellen... (ingekort voor overzicht, maar functioneel gelijk aan V3.5)
    return ingredients;
}

window.recalculateBatchCost = async function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;
    const costResult = parseIngredientsAndCalculateCost(brew.recipeMarkdown, inventory, brew.batchSize);
    if (costResult.warnings.length > 0) showToast(`Warnings:\n${costResult.warnings.join('\n')}`, 'error');
    
    if (confirm(`New cost: €${costResult.cost.toFixed(2)}. Update?`)) {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), { totalCost: costResult.cost });
        showToast("Cost updated!", "success");
    }
}

// --- DEEL 8: MANAGEMENT ENGINE (INVENTORY, CELLAR, FINANCIALS) ---

// --- INVENTORY MANAGEMENT ---

function loadInventory() {
    if (!userId) return;
    const appId = 'meandery-aa05e';
    const invCol = collection(db, 'artifacts', appId, 'users', userId, 'inventory');
    
    // We gebruiken onSnapshot voor realtime updates
    onSnapshot(query(invCol), (snapshot) => {
        inventory = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderInventory();
        // Update ook meteen de financiën als de voorraad verandert
        if (typeof updateCostAnalysis === 'function') updateCostAnalysis();
        if (typeof updateNextActionWidget === 'function') updateNextActionWidget();
        if (typeof updateDashboardStats === 'function') updateDashboardStats();
    }, (error) => {
        console.error("Error loading inventory:", error);
    });
}

window.renderInventory = function() {
    const listDiv = document.getElementById('inventory-list');
    if (!listDiv) return;

    // Groepeer items op categorie
    const grouped = inventory.reduce((acc, item) => {
        const cat = item.category || 'Other';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(item);
        return acc;
    }, {});

    const categories = ['Honey', 'Yeast', 'Nutrient', 'Malt Extract', 'Fruit', 'Spice', 'Adjunct', 'Chemical', 'Water'];
    const currency = userSettings.currencySymbol || '€';
    let html = '';

    categories.forEach(category => {
        if (grouped[category]) {
            html += `<h3 class="text-lg font-header mt-6 mb-3 uppercase tracking-wider text-app-brand opacity-80 border-b border-app-brand/10 pb-1">${category}</h3>`;
            html += `<div class="grid grid-cols-1 gap-3">`; 
            
            grouped[category].forEach(item => {
                const expDateStr = item.expirationDate ? new Date(item.expirationDate).toLocaleDateString() : 'N/A';
                let dateClass = 'text-app-secondary/60';
                if (item.expirationDate) {
                    const days = (new Date(item.expirationDate) - new Date()) / (1000 * 60 * 60 * 24);
                    if (days < 0) dateClass = 'text-red-500 font-bold';
                    else if (days <= 30) dateClass = 'text-amber-500 font-semibold';
                }

                let catClass = 'cat-yeast'; 
                const c = item.category.toLowerCase();
                if(c.includes('honey')) catClass = 'cat-honey';
                if(c.includes('fruit')) catClass = 'cat-fruit';
                if(c.includes('spice')) catClass = 'cat-spice';
                if(c.includes('nutrient')) catClass = 'cat-nutrient';
                if(c.includes('chemical') || c.includes('clean')) catClass = 'cat-chemical';

                html += `
                <div id="item-${item.id}" class="p-4 card rounded-xl border-l-4 ${catClass.replace('cat-', 'border-')} shadow-sm hover:shadow-md transition-all bg-app-secondary group relative">
                    <div class="flex justify-between items-start">
                        <div class="pr-4">
                            <div class="font-bold text-xl text-app-header leading-tight">${item.name}</div>
                            <div class="text-xs ${dateClass} mt-1 flex items-center gap-1">
                                Exp: ${expDateStr}
                            </div>
                        </div>
                        <div class="text-right">
                            <div class="inline-block bg-app-tertiary px-2 py-1 rounded-lg border border-app-brand/10 mb-2">
                                <div class="font-mono font-bold text-app-header text-sm">${item.qty} <span class="text-xs font-normal text-app-secondary">${item.unit}</span></div>
                            </div>
                            <div class="text-xs text-app-secondary font-mono mb-3">
                                ${currency}${(item.price || 0).toFixed(2)}
                            </div>
                        </div>
                    </div>
                    <div class="flex justify-end gap-4 mt-2 pt-2 border-t border-app-brand/5">
                        <button onclick="window.editInventoryItem('${item.id}')" class="text-xs font-bold text-app-secondary hover:text-blue-600 uppercase tracking-wider">Edit</button>
                        <button onclick="window.deleteInventoryItem('${item.id}')" class="text-xs font-bold text-app-secondary hover:text-red-600 uppercase tracking-wider">Delete</button>
                    </div>
                </div>`; 
            });
            html += `</div>`;
        }
    });
    
    if (inventory.length === 0) listDiv.innerHTML = `<div class="text-center py-12 opacity-50"><p>The Cupboard is Bare</p></div>`;
    else listDiv.innerHTML = html;
}

window.editInventoryItem = function(itemId) {
    const item = inventory.find(i => i.id === itemId);
    if(!item) return;
    
    document.getElementById('itemName').value = item.name;
    document.getElementById('itemQty').value = item.qty;
    document.getElementById('itemUnit').value = item.unit;
    document.getElementById('itemPrice').value = item.price;
    document.getElementById('itemCategory').value = item.category;
    document.getElementById('itemExpirationDate').value = item.expirationDate || '';
    
    // Verander de knop tijdelijk in een update knop (simpele implementatie: verwijder oude en voeg nieuwe toe)
    // Voor nu: verwijder het item zodat de gebruiker het opnieuw toevoegt als edit.
    if(confirm("Edit mode: This item will be removed so you can re-save it. Proceed?")) {
        window.deleteInventoryItem(itemId);
    }
}

window.deleteInventoryItem = async function(itemId) {
    if (!userId) return;
    try {
        await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'inventory', itemId));
        showToast("Item removed.", "success");
    } catch(e) { console.error(e); showToast("Error deleting item.", "error"); }
}

// --- CELLAR MANAGEMENT ---

function loadCellar() {
    if (!userId) return;
    const cellarCol = collection(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'cellar');
    onSnapshot(query(cellarCol), (snapshot) => {
        cellar = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (typeof renderCellar === 'function') renderCellar();
        if (typeof updateCostAnalysis === 'function') updateCostAnalysis();
        if (typeof updateDashboardStats === 'function') updateDashboardStats();
    });
}

window.renderCellar = function() {
    const listDiv = document.getElementById('cellar-list');
    if (!listDiv) return;
    if (cellar.length === 0) { listDiv.innerHTML = '<p class="text-center text-app-secondary/80">Empty cellar.</p>'; return; }
    
    listDiv.innerHTML = cellar.map(item => `
        <div class="p-4 card rounded-lg mb-2">
            <h4 class="font-bold text-lg font-header">${item.recipeName}</h4>
            <p class="text-sm text-app-secondary">Bottled: ${item.bottlingDate ? new Date(item.bottles ? item.bottlingDate.toDate() : item.bottlingDate).toLocaleDateString() : '?'}</p>
            <div class="mt-2 space-y-1">
                ${(item.bottles || []).map(b => `<div class="text-sm flex justify-between"><span>${b.quantity} x ${b.size}ml</span><button onclick="window.consumeBottle('${item.id}', ${b.size})" class="text-xs bg-app-action text-white px-2 rounded">Drink</button></div>`).join('')}
            </div>
            <button onclick="window.deleteCellarItem('${item.id}', '${item.recipeName.replace(/'/g, "\\'")}')" class="text-red-500 text-xs mt-2 underline">Remove Batch</button>
        </div>
    `).join('');
}

window.consumeBottle = async function(cellarId, size) {
    if (!userId) return;
    const itemRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'cellar', cellarId);
    const item = cellar.find(c => c.id === cellarId);
    if (!item) return;
    
    const updatedBottles = item.bottles.map(b => {
        if (b.size === size && b.quantity > 0) return { ...b, quantity: b.quantity - 1 };
        return b;
    }).filter(b => b.quantity > 0);
    
    if (updatedBottles.length === 0) {
        if(confirm("Last bottle consumed! Remove batch from cellar?")) {
            await deleteDoc(itemRef);
        } else {
            await updateDoc(itemRef, { bottles: [] }); // Houdt lege entry
        }
    } else {
        await updateDoc(itemRef, { bottles: updatedBottles });
    }
    showToast("Cheers! 🥂", "success");
}

window.deleteCellarItem = async function(id, name) {
    if(confirm(`Delete ${name} from cellar?`)) {
        await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'cellar', id));
    }
}

// --- FINANCIALS & STATS ---

window.updateCostAnalysis = function() {
    const currency = userSettings.currencySymbol || '€';
    
    // 1. Bereken Totalen
    let invValue = inventory.reduce((sum, item) => sum + (item.price || 0), 0);
    let activeValue = brews.filter(b => !b.isBottled).reduce((sum, b) => sum + (b.totalCost || 0), 0);
    let cellarValue = cellar.reduce((sum, c) => sum + (c.totalBatchCost || 0), 0);
    
    // Update Tekst Elementen
    const elInv = document.getElementById('total-inventory-value');
    const elActive = document.getElementById('total-active-value');
    const elCellar = document.getElementById('total-cellar-value');
    const elGrand = document.getElementById('grand-total-value');
    
    if(elInv) elInv.textContent = `${currency}${invValue.toFixed(2)}`;
    if(elActive) elActive.textContent = `${currency}${activeValue.toFixed(2)}`;
    if(elCellar) elCellar.textContent = `${currency}${cellarValue.toFixed(2)}`;
    if(elGrand) elGrand.textContent = `${currency}${(invValue + activeValue + cellarValue).toFixed(2)}`;
    
    // 2. Update de Grafiek met VASTE Kleuren
    const ctx = document.getElementById('cost-chart');
    if (ctx && window.Chart) {
        
        // Data groeperen
        const spendByCategory = inventory.reduce((acc, item) => {
            const cat = item.category || 'Other';
            acc[cat] = (acc[cat] || 0) + (item.price || 0);
            return acc;
        }, {});

        // Definieer vaste kleuren per categorie (zodat Fruit altijd rood is, etc.)
        const categoryColors = {
            'Honey': '#f59e0b',        // Goud/Amber
            'Yeast': '#a16207',        // Donkergeel/Bruin
            'Nutrient': '#65a30d',     // Frisgroen
            'Malt Extract': '#7c2d12', // Donkerbruin (Mout)
            'Fruit': '#dc2626',        // Rood
            'Spice': '#ea580c',        // Oranje
            'Adjunct': '#57534e',      // Grijs
            'Chemical': '#2563eb',     // Blauw
            'Water': '#0891b2',        // Cyaan
            'Other': '#8F8C79'         // Je Brand Color
        };

        const labels = Object.keys(spendByCategory);
        const data = Object.values(spendByCategory);
        
        // Wijs de kleuren toe op basis van de labelnaam
        const backgroundColors = labels.map(cat => categoryColors[cat] || '#8F8C79');

        if (window.costChart) window.costChart.destroy();
        
        window.costChart = new Chart(ctx.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{ 
                    data: data, 
                    backgroundColor: backgroundColors,
                    borderWidth: 0 // Geen witte randjes voor een strakker effect
                }]
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            usePointStyle: true, // Bolletjes i.p.v. vierkantjes
                            padding: 20
                        }
                    }
                }
            }
        });
    }
}

window.updateDashboardStats = function() {
    // Simpele tellers voor het dashboard
    const primaryCount = brews.filter(b => b.logData?.brewDate && !b.primaryComplete).length;
    const agingCount = brews.filter(b => b.primaryComplete && !b.isBottled).length;
    const cellarCount = cellar.reduce((sum, c) => sum + (c.bottles || []).reduce((s, b) => s + b.quantity, 0), 0);
    
    const elPrim = document.getElementById('stat-primary-batches');
    const elAge = document.getElementById('stat-aging-batches');
    const elBot = document.getElementById('stat-bottles');
    
    if(elPrim) elPrim.textContent = primaryCount;
    if(elAge) elAge.textContent = agingCount;
    if(elBot) elBot.textContent = cellarCount;
    
    // Voor "Value" hergebruiken we de totaalberekening uit updateCostAnalysis of doen het hier simpel
    // (Laten we het simpel houden en op updateCostAnalysis vertrouwen voor de 'stat-spent' update als we die koppelen, of hier apart doen)
    const elSpent = document.getElementById('stat-spent');
    if(elSpent && document.getElementById('grand-total-value')) {
        elSpent.textContent = document.getElementById('grand-total-value').textContent;
    }
}

// --- DASHBOARD TIMELINE WIDGET ---

// --- FIX VOOR TIMELINE KAART (LEESBAARHEID) ---
window.renderActiveBrewTimeline = function() {
    const card = document.getElementById('current-brew-card');
    if (!card) return;

    // 1. Zoek de meest relevante actieve batch
    const activeBrew = brews.find(b => b.logData && b.logData.brewDate && b.logData.brewDate !== '' && !b.isBottled);

    if (!activeBrew) {
        card.classList.add('hidden');
        return;
    }

    // 2. Bereken de "Bio-Time"
    const now = new Date();
    const brewDate = new Date(activeBrew.logData.brewDate);
    const daysElapsed = Math.floor((now - brewDate) / (1000 * 60 * 60 * 24));
    
    // 3. Bepaal het "Metabolisme"
    const targetABV = parseFloat(activeBrew.logData.targetABV) || 12;
    let paceModifier = 1; 
    if (targetABV < 8) paceModifier = 0.5; 
    if (targetABV > 14) paceModifier = 1.5;

    // 4. Bepaal de Fase & Tip
    let phaseName = "";
    let smartTip = "";
    let progressPercent = 0;
    
    if (daysElapsed <= (3 * paceModifier)) {
        phaseName = "Lag / Biomass Growth";
        smartTip = "Yeast is multiplying. Oxygen is good now. Degas gently.";
        progressPercent = 15;
    } else if (daysElapsed <= (14 * paceModifier)) {
        phaseName = "Vigorous Fermentation";
        smartTip = "Sugar is converting to alcohol. Keep temperature stable.";
        progressPercent = 40;
    } else if (daysElapsed <= (30 * paceModifier)) {
        phaseName = "Cleanup Phase";
        smartTip = "Yeast is cleaning up off-flavors. Do not disturb.";
        progressPercent = 70;
    } else {
        phaseName = "Bulk Aging / Clearing";
        smartTip = "Waiting for clarity. Patience is the main ingredient.";
        progressPercent = 90;
    }

    if (activeBrew.primaryComplete) {
        phaseName = "Secondary / Maturation";
        smartTip = "Aging for complexity. Ensure airlock is tight.";
        progressPercent = Math.max(progressPercent, 60); 
    }

    // 5. Render de Timeline
    const stages = [
        { name: 'Lag', active: daysElapsed >= 0 },
        { name: 'Active', active: daysElapsed > (3 * paceModifier) },
        { name: 'Cleanup', active: daysElapsed > (14 * paceModifier) },
        { name: 'Aging', active: daysElapsed > (30 * paceModifier) || activeBrew.primaryComplete }
    ];

    const activeIndex = stages.findLastIndex(s => s.active);

    let timelineItemsHtml = stages.map((stage, index) => {
        const isPulse = index === activeIndex ? 'living-node' : '';
        const isActive = stage.active ? 'background: var(--brand-color); border-color: var(--brand-color);' : '';
        const labelClass = stage.active ? 'text-app-brand font-bold' : 'text-gray-400'; // Duidelijkere labels
        
        return `
            <div class="timeline-item ${stage.active ? 'active' : ''}">
                <div class="timeline-node ${isPulse}" style="${isActive}"></div>
                <div class="timeline-label text-[10px] uppercase tracking-wide ${labelClass}">${stage.name}</div>
            </div>
        `;
    }).join('');

    card.innerHTML = `
        <div class="flex justify-between items-start mb-4">
            <div class="pr-4">
                <div class="flex items-center gap-2">
                    <span class="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                    <h3 class="text-xl font-header font-bold text-app-brand leading-tight uppercase">${activeBrew.recipeName}</h3>
                </div>
                <p class="text-app-header font-bold text-sm mt-1">Day ${daysElapsed}: ${phaseName}</p>
                <p class="text-gray-500 dark:text-gray-400 text-xs italic mt-1">"${smartTip}"</p>
            </div>
            <button onclick="window.showBrewDetail('${activeBrew.id}')" class="flex-shrink-0 bg-transparent border border-app-brand text-app-brand hover:bg-app-brand hover:text-white text-xs font-bold uppercase px-3 py-2 rounded transition-colors">
                View
            </button>
        </div>
        
        <div class="timeline-container mt-2 mb-2">
            <div class="timeline-connector">
                <div class="timeline-progress" style="width: ${progressPercent}%;"></div>
            </div>
            ${timelineItemsHtml}
        </div>
    `;

    card.classList.remove('hidden');
}

// --- FIX VOOR INSIGHT WIDGET (LEESBAARHEID) ---
window.updateNextActionWidget = function() {
    const list = document.getElementById('next-action-list');
    const widget = document.getElementById('next-action-widget');
    if(!list || !widget) return;
    
    let actions = [];
    
    // Check inventory expiry
    const now = new Date();
    inventory.forEach(i => {
        if(i.expirationDate) {
            const days = (new Date(i.expirationDate) - now) / (1000*60*60*24);
            if(days < 30) actions.push(`Use <strong class="text-app-brand">${i.name}</strong> soon (Expires in ${Math.ceil(days)} days)`);
        }
    });
    
    // Check active fermentation
    brews.forEach(b => {
        if(b.logData?.brewDate && !b.primaryComplete) {
            const days = (now - new Date(b.logData.brewDate)) / (1000*60*60*24);
            if(days > 14) actions.push(`Check gravity of <strong class="text-app-brand">${b.recipeName}</strong> (Day ${Math.floor(days)})`);
        }
    });

    if(actions.length > 0) {
        list.innerHTML = actions.slice(0, 3).map(a => `<li>${a}</li>`).join('');
        // Zorg dat de lijst zichtbaar is (text-app-header i.p.v. text-app-header)
        list.className = "list-disc pl-5 space-y-2 text-app-header text-sm leading-relaxed";
        widget.classList.remove('hidden');
    } else {
        widget.classList.add('hidden');
    }
}

// --- USER SETTINGS MANAGEMENT ---

async function loadUserSettings() {
    if (!userId) return;
    const appId = 'meandery-aa05e';
    const settingsDocRef = doc(db, 'artifacts', appId, 'users', userId, 'settings', 'main');
    
    try {
        const docSnap = await getDoc(settingsDocRef);
        if (docSnap.exists()) {
            userSettings = docSnap.data();
            
            // Herstel de actieve brouwdag pointer als die bestaat
            if (userSettings.currentBrewDay && userSettings.currentBrewDay.brewId) {
                currentBrewDay = userSettings.currentBrewDay;
                // Render de brouwdag als we op dat tabblad zitten
                if (!document.getElementById('brewing-main-view').classList.contains('hidden')) {
                     renderBrewDay(currentBrewDay.brewId);
                }
            }
        } else {
            // Standaardwaarden als er nog geen instellingen zijn
            userSettings = { apiKey: '', imageApiKey: '', defaultBatchSize: 5, currencySymbol: '€', theme: 'light' };
        }
        applySettings();
    } catch (error) {
        console.error("Error loading user settings:", error);
    }
}

function applySettings() {
    // Vul de input velden met de geladen data
    const apiKeyField = document.getElementById('apiKeyInput');
    if (apiKeyField) apiKeyField.value = userSettings.apiKey || '';

   const aiModelField = document.getElementById('aiModelInput');
    if (aiModelField && userSettings.aiModel) {
        // Check of het model al in de dropdown staat. Zo niet, voeg hem toe (voor offline gebruik).
        let exists = Array.from(aiModelField.options).some(o => o.value === userSettings.aiModel);
        if (!exists) {
            const opt = document.createElement('option');
            opt.value = userSettings.aiModel;
            opt.text = userSettings.aiModel + " (Saved)";
            aiModelField.add(opt, 0); // Voeg toe bovenaan
        }
        aiModelField.value = userSettings.aiModel;
    }

    const chatModelField = document.getElementById('chatModelInput');
    if (chatModelField && userSettings.chatModel) {
        let exists = Array.from(chatModelField.options).some(o => o.value === userSettings.chatModel);
        if (!exists) {
            const opt = document.createElement('option');
            opt.value = userSettings.chatModel;
            opt.text = userSettings.chatModel + " (Saved)";
            chatModelField.add(opt, 0);
        }
        chatModelField.value = userSettings.chatModel;
    }

    const imgModelField = document.getElementById('imageModelInput');
    if (imgModelField && userSettings.imageModel) {
        // Check of hij erin staat, zo niet, voeg toe (zodat saved value werkt zonder scan)
        let exists = Array.from(imgModelField.options).some(o => o.value === userSettings.imageModel);
        if (!exists) {
            const opt = document.createElement('option');
            opt.value = userSettings.imageModel;
            opt.text = userSettings.imageModel + " (Saved)";
            imgModelField.add(opt, 0);
        }
        imgModelField.value = userSettings.imageModel;
    }
        
    const batchInput = document.getElementById('defaultBatchSizeInput');
    if (batchInput) batchInput.value = userSettings.defaultBatchSize || 5;

    const currencyInput = document.getElementById('defaultCurrencyInput');
    if (currencyInput) currencyInput.value = userSettings.currencySymbol || '€';

    const themeToggle = document.getElementById('theme-toggle-checkbox');
    if (themeToggle) themeToggle.checked = (userSettings.theme === 'dark');
    
    // Update labels in de UI waar valuta staat
    const priceLabel = document.querySelector('label[for="itemPrice"]');
    if(priceLabel) priceLabel.textContent = `Price (${userSettings.currencySymbol || '€'})`;
    
    // Pas het thema direct toe
    applyTheme(userSettings.theme);
}

async function saveUserSettings() {
    if (!userId) return;
    const appId = 'meandery-aa05e';
    const settingsDocRef = doc(db, 'artifacts', appId, 'users', userId, 'settings', 'main');
    
    const newSettings = {
        apiKey: document.getElementById('apiKeyInput').value.trim(),
        aiModel: document.getElementById('aiModelInput').value,
        chatModel: document.getElementById('chatModelInput').value,
        imageModel: document.getElementById('imageModelInput').value,
        defaultBatchSize: parseFloat(document.getElementById('defaultBatchSizeInput').value) || 5,
        currencySymbol: document.getElementById('defaultCurrencyInput').value.trim() || '€',
        theme: document.getElementById('theme-toggle-checkbox').checked ? 'dark' : 'light',
        // We slaan alleen de pointer op, niet de hele checklist data (die zit in de brew zelf)
        currentBrewDay: { brewId: currentBrewDay.brewId }
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

function applyTheme(theme) {
    if (theme === 'dark') {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
}

// --- DEEL 5: TOOLS, CALCULATORS & UTILITIES ---

// --- UTILITY: KOSTENBEREKENING (CRASH PROOF) ---
function parseIngredientsAndCalculateCost(markdown, inventory, batchSize) {
    let totalCost = 0;
    const warnings = []; 
    const requiredIngredients = parseIngredientsFromMarkdown(markdown); // Functie uit Deel 4

    if (requiredIngredients.length === 0) {
        console.warn("Cost calculation: No ingredients found by the parser.");
        return { cost: 0, warnings: [] }; 
    }

    const convertToBaseUnit = (quantity, unit) => {
        const u = (unit || '').toLowerCase().trim();
        if (u === 'kg') return { quantity: quantity * 1000, unit: 'g' };
        if (u === 'l' || u === 'liter' || u === 'liters') return { quantity: quantity * 1000, unit: 'ml' };
        
        // Slimme packet detectie
        if (u === 'packet' || u === 'packets' || u === 'sachet' || u === 'pkg' || u === 'pack') {
            return { quantity: quantity, unit: 'packets' }; 
        }
        if (u === 'item' || u === 'items' || u === 'st' || u === 'piece' || u === 'pieces') {
             return { quantity: quantity, unit: 'items' };
        }
        return { quantity, unit: u };
    };

    requiredIngredients.forEach(req => {
        const inventoryItem = inventory.find(item => item.name.toLowerCase() === req.name.toLowerCase());
        
        if (inventoryItem && typeof inventoryItem.price === 'number' && inventoryItem.qty > 0) {
            const requiredAmountInBase = convertToBaseUnit(req.quantity, req.unit);
            const inventoryAmountInBase = convertToBaseUnit(inventoryItem.qty, inventoryItem.unit);
            
            let match = false;
            let costPerBaseUnit = 0;

            if (requiredAmountInBase.unit === inventoryAmountInBase.unit) {
                match = true;
                costPerBaseUnit = inventoryItem.price / inventoryAmountInBase.quantity;
            }
            else if (requiredAmountInBase.unit === 'g' && inventoryAmountInBase.unit === 'packets') {
                match = true;
                // FIX: Gebruik 'return' in forEach, 'continue' werkt niet!
                if (requiredAmountInBase.quantity <= 15) {
                     totalCost += (inventoryItem.price / inventoryItem.qty) * 1; 
                     return; 
                }
            }
            
            if (match) {
                 if (!isNaN(costPerBaseUnit)) {
                    totalCost += requiredAmountInBase.quantity * costPerBaseUnit;
                }
            } else {
                 const warningMsg = `'${req.name}': Mismatch (Recipe: ${requiredAmountInBase.unit}, Stock: ${inventoryAmountInBase.unit})`;
                 warnings.push(warningMsg);
            }
        } else if (!inventoryItem || inventoryItem.price === 0) {
             warnings.push(`'${req.name}': Not found in inventory or no price.`);
        }
    });

    return { cost: totalCost, warnings: warnings }; 
}

window.printEmptyLog = function() {
    const logHtml = getBrewLogHtml(null, 'empty');
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`<html><head><title>Empty Brew Log</title><link rel="stylesheet" href="style.css"></head><body><div class="container mx-auto p-4">${logHtml}</div></body></html>`);
    printWindow.document.close();
    printWindow.print();
}

// --- CALCULATORS ---

function calculateABV() {
    const og = parseFloat(document.getElementById('og').value);
    const fg = parseFloat(document.getElementById('fg').value);
    const resultDiv = document.getElementById('abvResult');
    if (og && fg && og > fg) {
        const abv = (og - fg) * 131.25;
        resultDiv.textContent = `ABV: ${abv.toFixed(2)}%`;
    } else {
        resultDiv.textContent = 'Invalid Input';
    }
}

function correctHydrometer() {
    const sg = parseFloat(document.getElementById('sgReading').value);
    const t = parseFloat(document.getElementById('tempReading').value);
    const c = parseFloat(document.getElementById('calTemp').value);
    const resultDiv = document.getElementById('sgResult');

    if (isNaN(sg) || isNaN(t) || isNaN(c)) {
        resultDiv.textContent = 'Invalid Input';
        return;
    }
    const correctedSg = sg * ((1.00130346 - 0.000134722124 * t + 0.00000204052596 * t**2 - 0.00000000232820948 * t**3) / (1.00130346 - 0.000134722124 * c + 0.00000204052596 * c**2 - 0.00000000232820948 * c**3));
    resultDiv.textContent = `Corrected: ${correctedSg.toFixed(3)}`;
}

function calculatePrimingSugar() {
    const vol = parseFloat(document.getElementById('carbVol').value);
    const temp = parseFloat(document.getElementById('carbTemp').value);
    const size = parseFloat(document.getElementById('carbBatchSize').value);
    const resultDiv = document.getElementById('sugarResult');

    if (isNaN(vol) || isNaN(temp) || isNaN(size)) { resultDiv.textContent = 'Invalid Input'; return; }
    const sugarGrams = (vol - (3.0378 - 0.050062 * temp + 0.00026555 * temp**2)) * 4 * size;
    resultDiv.textContent = `${sugarGrams.toFixed(1)} g sugar`;
}

function calculateBlend() {
    const vol1 = parseFloat(document.getElementById('vol1').value);
    const abv1 = parseFloat(document.getElementById('abv1').value);
    const vol2 = parseFloat(document.getElementById('vol2').value);
    const abv2 = parseFloat(document.getElementById('abv2').value);
    const resultDiv = document.getElementById('blendResult');

    if (isNaN(vol1) || isNaN(abv1) || isNaN(vol2) || isNaN(abv2)) { 
        resultDiv.textContent = 'Invalid Input'; 
        return; 
    }

    const totalAlcohol = (vol1 * abv1) + (vol2 * abv2);
    const totalVolume = vol1 + vol2;
    
    if (totalVolume <= 0) {
        resultDiv.textContent = 'Volume Error';
        return;
    }

    const finalABV = totalAlcohol / totalVolume;
    resultDiv.textContent = `New: ${totalVolume.toFixed(2)}L @ ${finalABV.toFixed(2)}% ABV`;
}

function calculateBacksweetening() {
    const vol = parseFloat(document.getElementById('bs_current_vol').value);
    const currentSg = parseFloat(document.getElementById('bs_current_sg').value);
    const targetSg = parseFloat(document.getElementById('bs_target_sg').value);
    const resultDiv = document.getElementById('backsweetenResult');

    if (isNaN(vol) || isNaN(currentSg) || isNaN(targetSg) || targetSg <= currentSg) { resultDiv.textContent = 'Invalid Input'; return; }
    // 3.4g honing per liter verhoogt SG met 0.001
    const pointsToAdd = (targetSg - currentSg) * 1000;
    const honeyGrams = pointsToAdd * 3.4 * vol;
    resultDiv.textContent = `Add ${honeyGrams.toFixed(0)}g (${(honeyGrams/1000).toFixed(2)}kg) honey`;
}

function calculateDilution() {
    const startVol = parseFloat(document.getElementById('dil_start_vol').value);
    const startSg = parseFloat(document.getElementById('dil_start_sg').value);
    const targetSg = parseFloat(document.getElementById('dil_target_sg').value);
    const resultDiv = document.getElementById('dilutionResult');

    if (isNaN(startVol) || isNaN(startSg) || isNaN(targetSg) || startSg <= targetSg) { resultDiv.textContent = 'Invalid Input'; return; }
    const startPoints = startSg * 1000 - 1000;
    const targetPoints = targetSg * 1000 - 1000;
    const waterToAdd = startVol * (startPoints / targetPoints - 1);
    resultDiv.textContent = `Add ${waterToAdd.toFixed(2)}L water`;
}

function calculateTOSNA() {
    const og = parseFloat(document.getElementById('tosna_og').value);
    const vol = parseFloat(document.getElementById('tosna_vol').value);
    const yeastNeed = document.getElementById('tosna_yeast').value;
    const resultDiv = document.getElementById('tosnaResult');

    if (isNaN(og) || isNaN(vol)) { resultDiv.innerHTML = `<p class="text-red-500">Invalid Input</p>`; return; }

    const brix = (og * 1000 - 1000) / 4;
    let targetYAN = (yeastNeed === 'low') ? 20 * brix : (yeastNeed === 'medium' ? 25 * brix : 35 * brix);
    
    // Fermaid-O is ~40mg YAN/gram.
    const totalFermaidO = (targetYAN / 40) * vol;
    const addition = totalFermaidO / 4;

    resultDiv.innerHTML = `
        <h4 class="font-bold text-lg">TOSNA 2.0 Schedule</h4>
        <p><strong>Total Fermaid-O:</strong> ${totalFermaidO.toFixed(2)}g</p>
        <ul class="list-disc pl-5 mt-2 text-sm">
            <li><strong>24h / 48h / 72h:</strong> Add ${addition.toFixed(2)}g each time.</li>
            <li><strong>1/3 Break (Day 7):</strong> Add final ${addition.toFixed(2)}g.</li>
        </ul>
    `;
}

// --- REFRACTOMETER CORRECTIE (Brix -> SG) ---
function calculateRefractometerCorrection() {
    const ob = parseFloat(document.getElementById('refract_ob').value); // Original Brix
    const cb = parseFloat(document.getElementById('refract_cb').value); // Current Brix
    const resultDiv = document.getElementById('refractResult');

    if (isNaN(ob) || isNaN(cb)) {
        showToast("Please enter both Brix values.", "error");
        return;
    }

    // Wort Correction Factor (standaard is vaak 1.04, maar voor honing/fruit is 1.0 vaak prima, we gebruiken 1.0 voor de eenvoud of de Sean Terrill formule die geen WCF nodig heeft)
    // We gebruiken hier de Petr Novotny formule (standaard in veel homebrew apps):
    
    // Stap 1: Bereken SG
    const sg = 1.001843 
             - 0.002318474 * ob 
             - 0.000007775 * (ob * ob) 
             - 0.0340054 * cb 
             + 0.00564 * (cb * cb) 
             + 0.000283 * (ob * cb);

    // Stap 2: Bereken ABV (Standaard formule op basis van SG)
    // We moeten eerst de Original Gravity weten vanuit de Original Brix
    const originalSG = 1 + (ob / (258.6 - ((ob / 258.2) * 227.1)));
    const abv = (originalSG - sg) * 131.25;

    resultDiv.innerHTML = `
        <div class="grid grid-cols-2 gap-4">
            <div>
                <p class="text-xs text-app-secondary uppercase">True Gravity</p>
                <p class="text-2xl font-bold text-purple-700 dark:text-purple-300">${sg.toFixed(3)}</p>
            </div>
            <div>
                <p class="text-xs text-app-secondary uppercase">Current ABV</p>
                <p class="text-2xl font-bold text-purple-700 dark:text-purple-300">${abv.toFixed(1)}%</p>
            </div>
        </div>
    `;
    resultDiv.classList.remove('hidden');
}

// Helpers om vanuit een recept naar een calculator te springen
window.linkToBacksweetenCalc = function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew || !brew.logData) return;
    switchMainView('tools');
    switchSubView('calculators', 'tools-main-view');
    document.getElementById('bs_current_vol').value = brew.batchSize || '';
    document.getElementById('bs_current_sg').value = brew.logData.actualFG || brew.logData.targetFG || '';
    document.getElementById('bs_current_vol').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

window.linkToDilutionCalc = function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew || !brew.logData) return;
    switchMainView('tools');
    switchSubView('calculators', 'tools-main-view');
    document.getElementById('dil_start_vol').value = brew.batchSize || '';
    document.getElementById('dil_start_sg').value = brew.logData.actualOG || brew.logData.targetOG || '';
    document.getElementById('dil_start_vol').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// --- YEAST & WATER ADVICE ---

async function getYeastAdvice() {
    const og = document.getElementById('starterOG').value;
    const yeastDate = document.getElementById('yeastDate').value;
    const yeastType = document.getElementById('yeastType').value;
    const adviceOutput = document.getElementById('yeast-advice-output');

    if (!og || !yeastDate) { adviceOutput.innerHTML = `<p class="text-red-500">Missing input.</p>`; return; }
    adviceOutput.innerHTML = getLoaderHtml("Analyzing yeast viability...");

    const prompt = `Yeast Expert: User brewing mead SG ${og}. Yeast: ${yeastType}, date ${yeastDate}. Today: ${new Date().toISOString().split('T')[0]}. Is a starter needed? Provide steps for 5L batch. Format: Markdown.`;

    try {
        const text = await performApiCall(prompt);
        adviceOutput.innerHTML = marked.parse(text);
    } catch (error) {
        adviceOutput.innerHTML = `<p class="text-red-500">Error: ${error.message}</p>`;
    }
}

// Water Management
function handleWaterSourceChange() {
    const select = document.getElementById('waterSource');
    const [type, id] = select.value.split('_');
    let profile;
    if (type === 'builtin') profile = BUILT_IN_WATER_PROFILES[id];
    else if (type === 'user') profile = userWaterProfiles.find(p => p.id === id);
    if (profile) {
        currentWaterProfile = profile;
        updateWaterProfileDisplay(profile);
    }
}

function updateWaterProfileDisplay(profile) {
    ['ca', 'mg', 'na', 'so4', 'cl', 'hco3'].forEach(k => {
        document.getElementById(`val-${k}`).textContent = profile[k];
    });
}

// --- AANGEPASTE VERSIE: ALLEEN ADVIES, GEEN CHEMIE ---
async function getWaterAdvice() {
    if (!currentWaterProfile) {
        document.getElementById('water-advice-output').innerHTML = `<p class="text-red-500">Select a water profile first.</p>`;
        return;
    }
    const output = document.getElementById('water-advice-output');
    output.innerHTML = getLoaderHtml("Tasting water profile...");
    
    const target = document.getElementById('meadTargetProfile').selectedOptions[0].text;
    const batch = document.getElementById('batchSize').value || 5;
    const profileStr = `Ca:${currentWaterProfile.ca}, Mg:${currentWaterProfile.mg}, Na:${currentWaterProfile.na}, SO4:${currentWaterProfile.so4}, Cl:${currentWaterProfile.cl}, HCO3:${currentWaterProfile.hco3}`;
    
    // PROMPT AANGEPAST: VERBIED ZOUT TOEVOEGINGEN
    const prompt = `Brew Chemist: User has water profile (${profileStr}). Goal: ${batch}L ${target} mead. 
    
    **USER CONSTRAINT:** The user does NOT perform water chemistry adjustments (No salts/acids added).
    
    **TASK:** 1. Analyze if this water is suitable "as is".
    2. Give a simple verdict: "Excellent", "Good", "Okay", or "Risky".
    3. Explain mainly based on Chlorine (off-flavors) and Calcium (yeast health).
    4. DO NOT recommend adding Gypsum, Epsom, or acids. Just say if it will work.
    
    Format: Markdown. Keep it brief.`;

    try {
        const text = await performApiCall(prompt);
        output.innerHTML = marked.parse(text);
    } catch (error) {
        output.innerHTML = `<p class="text-red-500">Error: ${error.message}</p>`;
    }
}

// --- MEAD MEDIC CHAT SYSTEM ---

let chatHistory = []; // Houdt het gesprek bij
let currentChatImageBase64 = null; // Houdt de geselecteerde foto vast

// 1. Initialiseer / Reset
window.resetTroubleshootChat = function() {
    chatHistory = [];
    const chatBox = document.getElementById('chat-history');
    if(chatBox) {
        chatBox.innerHTML = `
        <div class="flex items-start gap-3">
            <div class="w-8 h-8 rounded-full bg-app-brand text-white flex items-center justify-center font-bold text-xs">DOC</div>
            <div class="bg-white dark:bg-gray-800 p-3 rounded-lg rounded-tl-none shadow-sm text-sm text-app-header border border-gray-100 dark:border-gray-700 max-w-[85%]">
                Hi! I'm your Mead Medic. Describe your issue or upload a photo of your brew.
            </div>
        </div>`;
    }
    window.clearChatImage();
}

// 2. Foto Selectie Handling
window.handleChatImageSelect = function(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            currentChatImageBase64 = e.target.result.split(',')[1]; // Alleen de data, niet de prefix
            
            // Toon preview
            document.getElementById('chat-preview-img').src = e.target.result;
            document.getElementById('chat-image-preview').classList.remove('hidden');
        }
        reader.readAsDataURL(input.files[0]);
    }
}

window.clearChatImage = function() {
    currentChatImageBase64 = null;
    document.getElementById('chat-image-input').value = '';
    document.getElementById('chat-image-preview').classList.add('hidden');
}

// 3. Bericht Versturen
window.sendTroubleshootMessage = async function() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    const chatBox = document.getElementById('chat-history');
    const sendBtn = document.getElementById('chat-send-btn');

    if (!text && !currentChatImageBase64) return;

    // A. Render USER bericht
    let userHtml = `<div class="flex items-start gap-3 justify-end animate-fade-in">
        <div class="bg-blue-600 text-white p-3 rounded-lg rounded-tr-none shadow-sm text-sm max-w-[85%]">
            ${currentChatImageBase64 ? '<div class="mb-2"><span class="text-[10px] uppercase bg-white/20 px-1 rounded">📷 Image attached</span></div>' : ''}
            ${text}
        </div>
        
        <img src="logo.png" onerror="this.src='favicon.png'" alt="Me" class="w-8 h-8 rounded-full bg-app-tertiary flex-shrink-0 object-contain border border-app-brand/20 p-0.5">
    </div>`;
    chatBox.insertAdjacentHTML('beforeend', userHtml);
    
    // Voeg toe aan geschiedenis
    chatHistory.push({ role: "user", text: text, hasImage: !!currentChatImageBase64 });

    // UI Updates
    input.value = '';
    const imageToSend = currentChatImageBase64; // Bewaar ref voor API call
    window.clearChatImage();
    chatBox.scrollTop = chatBox.scrollHeight;
    sendBtn.disabled = true;

    // B. Render AI 'Typing...'
    const loadingId = 'loading-' + Date.now();
    chatBox.insertAdjacentHTML('beforeend', `
        <div id="${loadingId}" class="flex items-start gap-3 animate-pulse">
            <div class="w-8 h-8 rounded-full bg-app-brand text-white flex items-center justify-center font-bold text-xs">DOC</div>
            <div class="bg-gray-100 dark:bg-gray-700 p-3 rounded-lg rounded-tl-none text-xs text-gray-500">Thinking...</div>
        </div>
    `);
    chatBox.scrollTop = chatBox.scrollHeight;

    // C. API Call (Speciaal voor Chat + Vision)
    try {
        const response = await performChatApiCall(chatHistory, imageToSend);
        
        // Verwijder loader
        document.getElementById(loadingId).remove();

        // Render AI bericht (met Markdown parsing)
        const aiHtml = `<div class="flex items-start gap-3 animate-fade-in">
            <div class="w-8 h-8 rounded-full bg-app-brand text-white flex items-center justify-center font-bold text-xs flex-shrink-0">AI</div>
            <div class="bg-white dark:bg-gray-800 p-3 rounded-lg rounded-tl-none shadow-sm text-sm text-app-header border border-gray-100 dark:border-gray-700 max-w-[90%] prose prose-sm max-w-none">
                ${marked.parse(response)}
            </div>
        </div>`;
        
        chatBox.insertAdjacentHTML('beforeend', aiHtml);
        chatHistory.push({ role: "model", text: response }); // Voeg AI antwoord toe aan geheugen

    } catch (error) {
        document.getElementById(loadingId).remove();
        chatBox.insertAdjacentHTML('beforeend', `<div class="text-center text-red-500 text-xs my-2">Error: ${error.message}</div>`);
    } finally {
        sendBtn.disabled = false;
        chatBox.scrollTop = chatBox.scrollHeight;
        input.focus(); // Focus terug voor snelle chat
    }
}

// 4. De Speciale API functie (Ondersteunt Context + Plaatjes)
async function performChatApiCall(history, base64Image) {
    let apiKey = userSettings.apiKey;
    if (!apiKey && typeof CONFIG !== 'undefined') apiKey = CONFIG.firebase.apiKey;
    if (!apiKey) throw new Error("No API Key");

    // --- FIX: KOPPELING MET SETTINGS ---
    // 1. Kijk of de gebruiker een specifiek Chat Model heeft gekozen.
    // 2. Zo niet, gebruik het algemene AI model.
    // 3. Als alles faalt, gebruik 'gemini-2.0-flash' (die werkt wel volgens jouw lijst).
    let model = "gemini-2.0-flash"; 
    
    if (userSettings.chatModel && userSettings.chatModel.trim() !== "") {
        model = userSettings.chatModel;
    } else if (userSettings.aiModel && userSettings.aiModel.trim() !== "") {
        model = userSettings.aiModel;
    }

    // Console log zodat je kunt zien wat er gebeurt (F12)
    console.log("Mead Medic is using model:", model);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // Bouw de prompt op basis van de geschiedenis
    let promptContext = "You are an expert Mead Troubleshooter. Be concise, helpful, and scientific. Keep answers under 150 words unless asked for detail.\n\nCONVERSATION HISTORY:\n";
    
    history.forEach(msg => {
        promptContext += `${msg.role === 'user' ? 'USER' : 'AI'}: ${msg.text} ${msg.hasImage ? '[User uploaded an image]' : ''}\n`;
    });
    
    promptContext += `\nUSER'S NEWEST INPUT: `; 

    const parts = [{ text: promptContext }];
    
    // Als er een afbeelding is, voegen we die toe aan de request
    if (base64Image) {
        parts.push({
            inline_data: {
                mime_type: "image/jpeg",
                data: base64Image
            }
        });
    }

    const requestBody = {
        contents: [{ parts: parts }]
    };

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        // SPECIFIEKE CHECK VOOR LIMIET
        if (response.status === 429) {
            throw new Error("⛔ QUOTA BEREIKT: Je hebt te snel/veel gechat voor dit model. Schakel over naar Flash in Settings.");
        }

        const errData = await response.json().catch(() => ({}));
        throw new Error(`AI Error (${response.status}) using model '${model}': ${errData.error?.message || response.statusText}`);
    }
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
}

window.fetchAvailableModels = async function() {
    const apiKey = document.getElementById('apiKeyInput').value.trim();
    const textSelect = document.getElementById('aiModelInput');
    const chatSelect = document.getElementById('chatModelInput'); // NIEUW
    const imageSelect = document.getElementById('imageModelInput');
    const btn = document.getElementById('fetchModelsBtn');

    if (!apiKey) { showToast("Vul eerst je Google API Key in.", "error"); return; }

    const originalBtnText = btn.innerText;
    btn.innerText = "Scanning...";
    btn.disabled = true;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (!response.ok) throw new Error("API Error");
        
        const data = await response.json();
        
        // 1. FILTER VOOR TEKST (Gemini)
        const textModels = data.models.filter(m => 
            m.supportedGenerationMethods.includes("generateContent") &&
            m.name.toLowerCase().includes("gemini")
        );
        textModels.sort((a, b) => b.name.localeCompare(a.name));

        // 2. FILTER VOOR BEELD (Imagen)
        const imageModels = data.models.filter(m => 
            m.name.toLowerCase().includes("imagen") || 
            (m.name.toLowerCase().includes("image") && !m.name.toLowerCase().includes("embedding"))
        );
        imageModels.sort((a, b) => b.name.localeCompare(a.name));

        // --- VUL DROPDOWN 1: RECIPE ENGINE ---
        textSelect.innerHTML = '';
        textModels.forEach(model => {
            const cleanName = model.name.replace('models/', '');
            const opt = document.createElement('option');
            opt.value = cleanName;
            opt.text = cleanName;
            textSelect.appendChild(opt);
        });

        // --- VUL DROPDOWN 2: CHAT ENGINE (NIEUW) ---
        // We gebruiken dezelfde lijst als voor recepten (want het zijn beide tekstmodellen)
        chatSelect.innerHTML = '';
        textModels.forEach(model => {
            const cleanName = model.name.replace('models/', '');
            const opt = document.createElement('option');
            opt.value = cleanName;
            opt.text = cleanName;
            chatSelect.appendChild(opt);
        });

        // Herstel saved values
        if (userSettings.aiModel) textSelect.value = userSettings.aiModel;
        if (userSettings.chatModel) chatSelect.value = userSettings.chatModel; // NIEUW

        // --- VUL DROPDOWN 3: IMAGE ENGINE ---
        imageSelect.innerHTML = '';
        if (imageModels.length === 0) {
            const fallback = document.createElement('option');
            fallback.value = "imagen-3.0-generate-001";
            fallback.text = "imagen-3.0-generate-001 (Default)";
            imageSelect.appendChild(fallback);
        } else {
            imageModels.forEach(model => {
                const cleanName = model.name.replace('models/', '');
                const opt = document.createElement('option');
                opt.value = cleanName;
                opt.text = cleanName;
                imageSelect.appendChild(opt);
            });
        }
        if (userSettings.imageModel) imageSelect.value = userSettings.imageModel;

        showToast(`Scan compleet! Models updated.`, "success");

    } catch (error) {
        console.error(error);
        showToast("Scan mislukt. " + error.message, "error");
    } finally {
        btn.innerText = originalBtnText;
        btn.disabled = false;
    }
}

// --- DEEL 6: LABELS, SOCIAL & DATA MANAGEMENT ---

// --- LABEL GENERATOR ENGINE V2.1 (Full Suite) ---

// 1. CONFIGURATIE (Built-in + User)
const builtInLabelFormats = {
    'avery_l7165': { name: 'Avery L7165 (99.1x67.7mm)', width: 99.1, height: 67.7, cols: 2, rows: 4, marginTop: 13, marginLeft: 4.6, gapX: 2.5, gapY: 0 },
    'herma_4453': { name: 'Herma 4453 (105x148mm)', width: 105, height: 148, cols: 2, rows: 2, marginTop: 0, marginLeft: 0, gapX: 0, gapY: 0 },
    'avery_l7163': { name: 'Avery L7163 (99.1x38.1mm)', width: 99.1, height: 38.1, cols: 2, rows: 7, marginTop: 15, marginLeft: 4.6, gapX: 2.5, gapY: 0 }
};
let userLabelFormats = {}; // Wordt gevuld vanuit Firestore

// 2. INITIALISATIE
function initLabelForge() {
    // Data laden
    populateLabelRecipeDropdown();
    loadUserLabelFormats(); 

    // Live Preview Listeners (Tekst)
    ['labelTitle', 'labelSubtitle', 'labelAbv', 'labelFg', 'labelVol', 'labelDate', 'labelDescription', 'labelDetails'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', updateLabelPreviewText);
    });
    document.getElementById('labelWarning')?.addEventListener('change', updateLabelPreviewText);
    document.getElementById('labelShowDetails')?.addEventListener('change', () => {
        const activeTheme = document.querySelector('.label-theme-btn.active')?.dataset.theme || 'standard';
        setLabelTheme(activeTheme);
    });
    
    // Recept laden
    document.getElementById('labelRecipeSelect')?.addEventListener('change', loadLabelFromBrew);
    
    // Thema Knoppen
    document.querySelectorAll('.label-theme-btn').forEach(btn => {
        btn.addEventListener('click', (e) => setLabelTheme(e.target.dataset.theme));
    });

    // AI Knoppen
    document.getElementById('ai-label-art-btn')?.addEventListener('click', generateLabelArt);
    document.getElementById('ai-label-desc-btn')?.addEventListener('click', generateLabelDescription);
    
    // Label Manager Listeners
    document.getElementById('labelPaper')?.addEventListener('change', updateLabelPreviewDimensions); // Als formaat wijzigt
    document.getElementById('printLabelsBtn')?.addEventListener('click', printLabelsSheet); // Print
    
    // Custom Label Modal Listeners
    document.getElementById('lf-lookup-btn')?.addEventListener('click', autoDetectLabelFormat);
    document.getElementById('label-format-form')?.addEventListener('submit', saveCustomLabelFormat);
    
    // Logo Upload
    document.getElementById('logoUpload')?.addEventListener('change', handleLogoUpload);
}

// 3. DATAMANAGEMENT (Laden & Dropdowns)

// A. Receptenlijst vullen
function populateLabelRecipeDropdown() {
    const select = document.getElementById('labelRecipeSelect');
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="">-- Load from History --</option>';
    
    const sortedBrews = [...brews].sort((a, b) => {
        const dateA = a.createdAt ? a.createdAt.toDate() : new Date(0);
        const dateB = b.createdAt ? b.createdAt.toDate() : new Date(0);
        return dateB - dateA;
    });

    sortedBrews.forEach(brew => {
        const option = document.createElement('option');
        option.value = brew.id;
        let displayName = brew.recipeName || 'Untitled Brew';
        if (displayName.includes(':')) displayName = displayName.split(':')[0].trim();
        option.textContent = displayName;
        select.appendChild(option);
    });
    select.value = currentValue;
}

// B. Label Formaten Laden (Firestore)
async function loadUserLabelFormats() {
    if (!userId) return;
    try {
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'settings', 'labelFormats');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            userLabelFormats = docSnap.data();
        }
        populateLabelPaperDropdown(); // Refresh de lijst na laden
    } catch (e) {
        console.error("Error loading label formats:", e);
    }
}

// C. Papier Dropdown Vullen (Built-in + Custom)
function populateLabelPaperDropdown() {
    const select = document.getElementById('labelPaper');
    if (!select) return;
    select.innerHTML = '';
    
    // 1. Standaard Formaten
    const groupBuiltIn = document.createElement('optgroup');
    groupBuiltIn.label = "Standard Formats";
    Object.keys(builtInLabelFormats).forEach(key => {
        const opt = document.createElement('option');
        opt.value = key; opt.text = builtInLabelFormats[key].name;
        groupBuiltIn.appendChild(opt);
    });
    select.appendChild(groupBuiltIn);

    // 2. Eigen Formaten
    if (Object.keys(userLabelFormats).length > 0) {
        const groupUser = document.createElement('optgroup');
        groupUser.label = "My Custom Formats";
        Object.keys(userLabelFormats).forEach(key => {
            const opt = document.createElement('option');
            opt.value = key; opt.text = userLabelFormats[key].name;
            groupUser.appendChild(opt);
        });
        select.appendChild(groupUser);
    }

    // Toggle delete knopje
    select.addEventListener('change', () => {
        const isCustom = userLabelFormats.hasOwnProperty(select.value);
        document.getElementById('deleteLabelFormatBtn').classList.toggle('hidden', !isCustom);
        updateLabelPreviewDimensions();
    });

    // Default selectie
    if(!select.value) select.value = 'avery_l7165';
    updateLabelPreviewDimensions();
}

// --- DEZE FUNCTIE PAST DE GROOTTE VAN DE PREVIEW AAN ---
function updateLabelPreviewDimensions() {
    const select = document.getElementById('labelPaper');
    if (!select) return;
    
    const key = select.value;
    // Zoek het formaat in de standaard lijst OF de eigen lijst
    const fmt = builtInLabelFormats[key] || userLabelFormats[key];
    
    if (fmt) {
        const container = document.getElementById('label-preview-container');
        if (container) {
            // Pas de breedte en hoogte aan (in millimeters)
            container.style.width = fmt.width + 'mm';
            container.style.height = fmt.height + 'mm';
        }
    }
}

// 4. PREVIEW & UI LOGICA

// --- UNIEKE VERSIE VAN DE UPDATE FUNCTIE ---
function updateLabelPreviewText() {
    // Helper: Schrijf alleen als het element ook echt bestaat in de HTML
    const safeSet = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    // 1. Haal waardes op (met fallbacks zodat het nooit leeg is)
    const title = document.getElementById('labelTitle')?.value || 'MEAD NAME';
    const sub = document.getElementById('labelSubtitle')?.value || 'Style';
    const abv = document.getElementById('labelAbv')?.value || '0';
    const vol = document.getElementById('labelVol')?.value || '750';
    const dateVal = document.getElementById('labelDate')?.value || '';
    const desc = document.getElementById('labelDescription')?.value || '';
    const details = document.getElementById('labelDetails')?.value || '';
    
    // 2. Schrijf ze naar het label (Veilig)
    safeSet('prev-title', title);
    safeSet('prev-subtitle', sub);
    safeSet('prev-abv', abv);
    safeSet('prev-vol', vol);
    safeSet('prev-date', dateVal);
    safeSet('prev-desc', desc);
    safeSet('prev-details', details);

    // 3. Toggles (Warning & Details) controleren
    const warnCheck = document.getElementById('labelWarning');
    const warnPreview = document.getElementById('prev-warning');
    if (warnCheck && warnPreview) {
        warnPreview.style.display = warnCheck.checked ? 'block' : 'none';
    }
    
    const detailCheck = document.getElementById('labelShowDetails');
    const detailPreview = document.getElementById('prev-details');
    if (detailCheck && detailPreview) {
        detailPreview.style.display = detailCheck.checked ? 'block' : 'none';
    }

    // --- NIEUW: ROEP DE AUTO-FIT AAN AAN HET EINDE ---
    if (typeof window.autoFitLabelText === 'function') {
        // Kleine vertraging zodat de DOM zeker geupdate is
        setTimeout(window.autoFitLabelText, 10);
    }
}

// Data uit recept laden
// Data uit recept laden
function loadLabelFromBrew(e) {
    const brewId = e.target.value;
    if (!brewId) return;
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    document.getElementById('labelTitle').value = brew.recipeName;
    
    let style = "Traditional Mead";
    if (brew.recipeMarkdown.toLowerCase().includes('melomel')) style = "Melomel (Fruit Mead)";
    if (brew.recipeMarkdown.toLowerCase().includes('bochet')) style = "Bochet (Caramelized)";
    document.getElementById('labelSubtitle').value = style;

    // ABV, FG, Vol, Date laden...
    document.getElementById('labelAbv').value = brew.logData?.finalABV?.replace('%','') || brew.logData?.targetABV?.replace('%','') || '12';
    document.getElementById('labelFg').value = brew.logData?.actualFG || brew.logData?.targetFG || '';
    document.getElementById('labelVol').value = '330'; 
    document.getElementById('labelDate').value = brew.logData?.brewDate || new Date().toLocaleDateString();

    // --- NIEUW: INGREDIËNTEN ANALYSE VOOR CHECKBOXES ---
    const ings = parseIngredientsFromMarkdown(brew.recipeMarkdown);
    
    // Zoek Gist (Naam bevat 'Yeast' of Categorie is Yeast)
    const yeastItem = ings.find(i => i.name.toLowerCase().includes('yeast') || i.name.toLowerCase().includes('gist'));
    const yeastName = yeastItem ? yeastItem.name.replace(/yeast/gi, '').trim() : 'Unknown';
    document.getElementById('displayLabelYeast').textContent = yeastName;

    // Zoek Honing
    const honeyItem = ings.find(i => i.name.toLowerCase().includes('honey') || i.name.toLowerCase().includes('honing'));
    const honeyName = honeyItem ? honeyItem.name.replace(/honey/gi, '').trim() : 'Wildflower';
    document.getElementById('displayLabelHoney').textContent = honeyName;

    // Zet de algemene details tekst (voor het "Full Ingredients" vinkje)
    const fullList = ings.map(i => i.name).join(' • ');
    document.getElementById('labelDetails').value = fullList;

    // Auto-detect sulfiet uit recept tekst
    const needsWarning = brew.recipeMarkdown.toLowerCase().includes('sulfite') || brew.recipeMarkdown.toLowerCase().includes('meta') || brew.recipeMarkdown.toLowerCase().includes('campden');
    document.getElementById('labelShowSulfites').checked = needsWarning;

    updateLabelPreviewText();
}

// --- LABEL THEMA FUNCTIE ---
function setLabelTheme(theme) {
    const container = document.getElementById('label-content');
    if (!container) return; // Stop als we niet op de label pagina zijn

    // 1. DATA OPHALEN
    const title = document.getElementById('labelTitle').value || 'MEAD NAME';
    const sub = document.getElementById('labelSubtitle').value || 'Style Description';
    const abv = document.getElementById('labelAbv').value || '12';
    const fg = document.getElementById('labelFg')?.value || '';
    const vol = document.getElementById('labelVol').value || '750';
    const desc = document.getElementById('labelDescription').value || '';
    const details = document.getElementById('labelDetails').value || '';
    const dateVal = document.getElementById('labelDate')?.value || new Date().toLocaleDateString();
    
    // Checkboxes
    const showWarning = document.getElementById('labelWarning')?.checked;
    const showDetails = document.getElementById('labelShowDetails')?.checked; 

    // 2. AFBEELDING CHECK
    let imgSrc = window.currentLabelImageSrc || '';
    const imgElement = document.getElementById('label-img-display');
    if (!imgSrc && imgElement && !imgElement.classList.contains('hidden') && imgElement.src !== window.location.href) {
        imgSrc = imgElement.src;
    }
    const hasImage = imgSrc && imgSrc.length > 10;

    // 3. KNOPPEN STATUS UPDATEN
    document.querySelectorAll('.label-theme-btn').forEach(b => {
        b.classList.remove('active', 'border-app-brand', 'text-app-brand', 'ring-2', 'ring-offset-1');
        if(b.dataset.theme === theme) b.classList.add('active', 'border-app-brand', 'text-app-brand', 'ring-2', 'ring-offset-1');
    });

    // =================================================================
    // THEMA 1: STANDAARD (Layout Fixed: Titel | Stijl | Logo)
    // =================================================================
    if (theme === 'standard') {
        container.className = `relative w-full h-full bg-white overflow-hidden flex font-sans`;
        container.style = ""; 

        // Logo
        let logoHtml = '';
        if (hasImage) {
            logoHtml = `<img src="${imgSrc}" class="w-20 h-20 object-cover rounded-full border-4 border-white shadow-sm">`;
        } else {
            logoHtml = `<img src="logo.png" onerror="this.src='favicon.png'" class="w-20 h-20 object-contain opacity-90">`;
        }

        let peakDateVal = "2026-01-01"; 
        try { const d = new Date(); d.setMonth(d.getMonth() + 6); peakDateVal = d.toLocaleDateString(); } catch(e) {}

        // Extra info string opbouwen
        let extraInfoHtml = '';
        const showYeast = document.getElementById('labelShowYeast')?.checked;
        const showHoney = document.getElementById('labelShowHoney')?.checked;
        const showDetails = document.getElementById('labelShowDetails')?.checked;
        const showSulfites = document.getElementById('labelShowSulfites')?.checked;

        let infoParts = [];
        if (showYeast) infoParts.push(`Yeast: ${document.getElementById('displayLabelYeast').textContent}`);
        if (showHoney) infoParts.push(`Honey: ${document.getElementById('displayLabelHoney').textContent}`);
        if (showDetails) infoParts.push(details);
        const infoString = infoParts.join(' • ');

        container.innerHTML = `
            <div class="h-full w-[35%] bg-gray-50/80 border-r border-dashed border-gray-300 py-3 px-3 flex flex-col justify-between text-right z-20 relative">
                <div class="flex flex-col gap-2 overflow-hidden">
                    <p id="prev-desc" class="text-[7px] leading-relaxed text-gray-500 italic font-serif text-justify">
                        ${desc || "A handcrafted honey wine."}
                    </p>
                    ${infoString ? `<p class="text-[6px] font-bold uppercase tracking-wider text-gray-400 leading-tight border-t border-gray-200 pt-1">${infoString}</p>` : ''}
                </div>
                <div class="text-[#8F8C79] mt-auto">
                    <div class="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[7px] font-bold uppercase tracking-wider border-t-2 border-gray-200 pt-2 mb-1">
                        <div class="text-gray-400">ABV</div> <div class="text-black text-right"><span id="prev-abv">${abv}</span>%</div>
                        <div class="text-gray-400">FG</div> <div class="text-black text-right"><span id="prev-fg">${fg || '-'}</span></div>
                        <div class="text-gray-400">Vol</div> <div class="text-black text-right"><span id="prev-vol">${vol}</span>ml</div>
                        <div class="text-gray-400">Bottled</div> <div class="text-black text-right"><span id="prev-date">${dateVal}</span></div>
                        <div class="text-app-brand">Peak</div> <div class="text-app-brand text-right">${peakDateVal}</div>
                    </div>
                    <p style="display: ${showSulfites ? 'block' : 'none'}" class="text-[5px] uppercase opacity-50 leading-tight mt-1">
                        Contains Sulfites
                    </p>
                </div>
            </div>

            <div class="h-full w-[65%] flex flex-row relative p-2 pl-2">
                
                <div id="title-container" class="h-full w-[75%] flex flex-col justify-end items-center overflow-hidden border-r border-transparent">
                    <div class="h-full w-full flex flex-col-reverse items-center justify-start">
                        <h1 id="prev-title" class="font-header font-bold uppercase tracking-widest text-[#8F8C79] text-center leading-[0.95] break-words whitespace-normal" style="writing-mode: vertical-rl; transform: rotate(180deg); display: block;">
                            ${title}
                        </h1>
                    </div>
                </div>
                
                <div class="h-full w-[12%] flex flex-col justify-end items-center pb-1">
                     <p id="prev-subtitle" class="text-[9px] font-bold uppercase tracking-[0.3em] text-gray-400 whitespace-nowrap" style="writing-mode: vertical-rl; transform: rotate(180deg);">
                        ${sub}
                    </p>
                </div>

                <div class="absolute top-4 right-4 z-10">
                    ${logoHtml}
                </div>
            </div>
        `;
        
        // Trigger de auto-fit functie
        setTimeout(window.autoFitLabelText, 50);
        setTimeout(window.autoFitLabelText, 300);
    }

    // =================================================================
    // THEMA 2: SPECIAL (Foto Achtergrond, Wit Logo)
    // =================================================================
    else if (theme === 'special') {
        container.className = `relative w-full h-full overflow-hidden bg-black font-sans`;
        container.style = ""; 

        let bgHtml = '';
        if (hasImage) {
            bgHtml = `<div class="absolute inset-0 z-0"><img src="${imgSrc}" class="w-full h-full object-cover"><div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/40"></div></div>`;
        } else {
            bgHtml = `<div class="absolute inset-0 z-0 bg-gradient-to-br from-gray-900 via-slate-800 to-black"></div>`;
        }

        const logoHtml = `<img src="logo.png" onerror="this.src='favicon.png'" class="w-full h-full object-contain p-2 filter invert drop-shadow-md">`;

        container.innerHTML = `
            ${bgHtml}
            <div class="relative z-10 w-full h-full flex p-6 text-white">
                <div class="h-full flex flex-row-reverse items-end justify-end gap-3 flex-grow">
                    <h1 id="prev-title" style="writing-mode: vertical-rl; transform: rotate(180deg); text-orientation: mixed;" class="text-6xl font-header font-bold uppercase tracking-widest leading-none drop-shadow-lg whitespace-nowrap max-h-full overflow-hidden text-ellipsis">
                        ${title}
                    </h1>
                    <p id="prev-subtitle" style="writing-mode: vertical-rl; transform: rotate(180deg);" class="text-xs font-bold uppercase tracking-[0.4em] opacity-90 whitespace-nowrap max-h-[80%] border-l-2 border-white/50 pl-2">
                        ${sub}
                    </p>
                </div>
                <div class="flex flex-col justify-between items-end pl-4 h-full">
                    <div class="w-36 h-36 rounded-full border-2 border-white flex items-center justify-center backdrop-blur-sm bg-white/10 shadow-lg">
                        ${logoHtml}
                    </div>
                    <div class="text-right drop-shadow-md">
                        <p id="prev-details" style="display: ${showDetails ? 'block' : 'none'}" class="text-[8px] font-mono uppercase mb-2 text-gray-200 max-w-[150px] ml-auto leading-tight">
                            ${details}
                        </p>
                        ${fg ? `<p class="text-xl font-header font-normal leading-none mb-1 opacity-80">FG ${fg}</p>` : ''}
                        <p class="text-4xl font-header font-bold leading-none mb-3">${abv}% <span class="text-lg font-normal">ABV</span></p>
                        <div class="text-[10px] font-mono uppercase tracking-widest opacity-70">
                            <p>${vol}ML • ${dateVal}</p>
                        </div>
                        <p id="prev-warning" style="display: ${showWarning ? 'block' : 'none'}" class="text-[6px] uppercase mt-2 opacity-50 max-w-[80px] ml-auto">
                            Contains Sulfites
                        </p>
                    </div>
                </div>
            </div>
        `;
    }
}

// 5. LABEL MANAGER (ADD / DELETE / AUTO-DETECT)

// Open Modal
window.openLabelFormatModal = function() {
    document.getElementById('label-format-form').reset();
    document.getElementById('label-format-modal').classList.remove('hidden');
}

// AI Auto-Detect
async function autoDetectLabelFormat() {
    const code = document.getElementById('lf-lookup-code').value.trim();
    const btn = document.getElementById('lf-lookup-btn');
    
    if (!code) { showToast("Enter a brand/code first.", "error"); return; }

    const originalText = btn.innerText;
    btn.innerText = "Searching...";
    btn.disabled = true;

    const prompt = `You are a Label Database Expert. 
    Find the technical specifications for label sheet: "${code}" (A4 sheet).
    Return a JSON object with these EXACT keys (values in mm number):
    - width (width of one sticker)
    - height (height of one sticker)
    - cols (number of stickers horizontally)
    - rows (number of stickers vertically)
    - marginTop (distance from top edge of A4 to first sticker)
    - marginLeft (distance from left edge of A4 to first sticker)
    - gapX (horizontal space between stickers)
    - gapY (vertical space between stickers)
    
    Return ONLY valid JSON.`;

    const schema = {
        type: "OBJECT",
        properties: {
            "width": { "type": "NUMBER" }, "height": { "type": "NUMBER" },
            "cols": { "type": "NUMBER" }, "rows": { "type": "NUMBER" },
            "marginTop": { "type": "NUMBER" }, "marginLeft": { "type": "NUMBER" },
            "gapX": { "type": "NUMBER" }, "gapY": { "type": "NUMBER" }
        },
        required: ["width", "height", "cols", "rows"]
    };

    try {
        const jsonResponse = await performApiCall(prompt, schema);
        const data = JSON.parse(jsonResponse);

        document.getElementById('lf-name').value = code;
        document.getElementById('lf-width').value = data.width;
        document.getElementById('lf-height').value = data.height;
        document.getElementById('lf-cols').value = data.cols;
        document.getElementById('lf-rows').value = data.rows;
        document.getElementById('lf-marginTop').value = data.marginTop || 0;
        document.getElementById('lf-marginLeft').value = data.marginLeft || 0;
        document.getElementById('lf-gapX').value = data.gapX || 0;
        document.getElementById('lf-gapY').value = data.gapY || 0;

        showToast("Specs found! Verify & Save.", "success");
    } catch (error) {
        console.error("AI Lookup Error:", error);
        showToast("Could not find specs automatically.", "error");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

// Opslaan Nieuw Formaat
window.saveCustomLabelFormat = async function(e) {
    e.preventDefault();
    if (!userId) return;
    
    const name = document.getElementById('lf-name').value;
    const id = 'custom_' + Date.now();

    const newFormat = {
        name: name,
        width: parseFloat(document.getElementById('lf-width').value),
        height: parseFloat(document.getElementById('lf-height').value),
        cols: parseInt(document.getElementById('lf-cols').value),
        rows: parseInt(document.getElementById('lf-rows').value),
        marginTop: parseFloat(document.getElementById('lf-marginTop').value) || 0,
        marginLeft: parseFloat(document.getElementById('lf-marginLeft').value) || 0,
        gapX: parseFloat(document.getElementById('lf-gapX').value) || 0,
        gapY: parseFloat(document.getElementById('lf-gapY').value) || 0,
    };

    userLabelFormats[id] = newFormat;

    try {
        await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'settings', 'labelFormats'), userLabelFormats);
        populateLabelPaperDropdown();
        document.getElementById('labelPaper').value = id;
        updateLabelPreviewDimensions();
        document.getElementById('label-format-modal').classList.add('hidden');
        showToast("Format saved!", "success");
    } catch (e) { showToast("Save error.", "error"); }
}

// Verwijderen Formaat
window.deleteCustomLabelFormat = async function() {
    const id = document.getElementById('labelPaper').value;
    if (!userLabelFormats[id] || !confirm(`Delete "${userLabelFormats[id].name}"?`)) return;

    delete userLabelFormats[id];
    
    try {
        await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'settings', 'labelFormats'), userLabelFormats);
        populateLabelPaperDropdown();
        showToast("Deleted.", "success");
    } catch (e) { console.error(e); }
}

// 6. AI CONTENT & ART GENERATORS

function handleLogoUpload(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            // SLA OP IN HET GEHEUGEN (VEILIG)
            window.currentLabelImageSrc = e.target.result;
            
            // Update het scherm direct
            const imgDisplay = document.getElementById('label-img-display');
            if (imgDisplay) {
                imgDisplay.src = e.target.result;
                imgDisplay.classList.remove('hidden');
            }
            const placeholder = document.getElementById('label-img-placeholder');
            if(placeholder) placeholder.classList.add('hidden');
            
            // Ververs het thema meteen
            const activeThemeBtn = document.querySelector('.label-theme-btn.active');
            const theme = activeThemeBtn ? activeThemeBtn.dataset.theme : 'standard';
            setLabelTheme(theme);
        }
        reader.readAsDataURL(file);
    }
}

async function generateLabelArt() {
    const title = document.getElementById('labelTitle').value;
    const style = document.getElementById('labelSubtitle').value;
    const activeBtn = document.querySelector('.label-theme-btn.active');
    const theme = activeBtn ? activeBtn.dataset.theme : 'standard';
    
    if (!title) return showToast("Enter a title first.", "error");

    const btn = document.getElementById('ai-label-art-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = "🎨 Painting...";
    btn.disabled = true;

    // Prompt logica (hetzelfde als voorheen, maar even ingekort voor de veiligheid)
    let artPrompt = `Label design for mead called "${title}". Subject: ${style}. High quality.`;
    if (theme === 'special') artPrompt += " Dark, premium, gold accents, mystical, minimal.";
    else artPrompt += " Clean, modern vector art, white background, bold typography.";

    try {
        // ... (API Keys logica blijft hetzelfde, we focussen op het resultaat) ...
        let apiKey = userSettings.imageApiKey || userSettings.apiKey;
        if (!apiKey) throw new Error("No API Key found.");

        // Hier gebruiken we de nieuwe Imagen 4.0 logica (of oudere fallback)
        const model = userSettings.imageModel || "imagen-3.0-generate-001";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instances: [{ prompt: artPrompt }], parameters: { sampleCount: 1, aspectRatio: "1:1" } })
        });

        if (!response.ok) throw new Error("AI Error");
        const data = await response.json();
        
        if (data.predictions && data.predictions[0].bytesBase64Encoded) {
            const base64Img = data.predictions[0].bytesBase64Encoded;
            const finalSrc = `data:image/png;base64,${base64Img}`;
            
            // SLA OP IN GEHEUGEN
            window.currentLabelImageSrc = finalSrc;

            // Update scherm
            const imgDisplay = document.getElementById('label-img-display');
            if (imgDisplay) {
                imgDisplay.src = finalSrc;
                imgDisplay.classList.remove('hidden');
            }
            const placeholder = document.getElementById('label-img-placeholder');
            if(placeholder) placeholder.classList.add('hidden');

            // Forceer refresh van het label
            setLabelTheme(theme);
        }
    } catch (error) {
        console.error(error);
        showToast("Art generation failed: " + error.message, "error");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function generateLabelDescription() {
    const title = document.getElementById('labelTitle').value;
    const style = document.getElementById('labelSubtitle').value;
    
    if (!title) return showToast("Enter a title first.", "error");
    
    const btn = document.getElementById('ai-label-desc-btn');
    btn.textContent = "Writing...";
    
    const prompt = `Write a short, poetic "back-of-bottle" description (max 25 words) for a Mead called "${title}". Style: ${style}. Make it sound enticing and handcrafted.`;
    
    try {
        const text = await performApiCall(prompt);
        document.getElementById('labelDescription').value = text.replace(/"/g, '').trim();
        updateLabelPreviewText();
    } catch (e) {
        showToast("AI Writer failed.", "error");
    } finally {
        btn.textContent = "✨ Write for me";
    }
}

// 7. PRINT ENGINE (Dynamic Grid)
function printLabelsSheet() {
    const key = document.getElementById('labelPaper').value;
    const fmt = builtInLabelFormats[key] || userLabelFormats[key];
    if(!fmt) return;

    const labelContent = document.getElementById('label-content').outerHTML;
    const totalLabels = fmt.cols * fmt.rows;
    
    const gridCSS = `
        display: grid;
        grid-template-columns: repeat(${fmt.cols}, ${fmt.width}mm);
        grid-template-rows: repeat(${fmt.rows}, ${fmt.height}mm);
        column-gap: ${fmt.gapX}mm;
        row-gap: ${fmt.gapY}mm;
        padding-top: ${fmt.marginTop}mm;
        padding-left: ${fmt.marginLeft}mm;
        width: 210mm;
        height: 297mm;
        box-sizing: border-box;
    `;

    const win = window.open('', '_blank');
    win.document.write(`
        <html><head><title>Print Labels</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@400;700&display=swap');
            @import url('https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&display=swap');
            
            body { margin: 0; background: white; }
            .sheet { ${gridCSS} }
            .label-cell { width: ${fmt.width}mm; height: ${fmt.height}mm; overflow: hidden; border: 1px dashed #eee; }
            @media print { 
                @page { size: A4; margin: 0; }
                body { -webkit-print-color-adjust: exact; }
                .label-cell { border: none; }
            }
        </style>
        </head><body>
        <div class="sheet">
            ${Array(totalLabels).fill(`<div class="label-cell">${labelContent}</div>`).join('')}
        </div>
        <script>
            const src = window.opener.document.getElementById('label-img-display').src;
            const isHidden = window.opener.document.getElementById('label-img-display').classList.contains('hidden');
            
            document.querySelectorAll('.label-cell').forEach(c => {
               const img = c.querySelector('img'); 
               const sp = c.querySelector('span');
               if(src && !isHidden) { 
                   img.src = src; 
                   img.classList.remove('hidden'); 
                   if(sp) sp.style.display='none'; 
               }
            });
            setTimeout(()=>window.print(), 800);
        </script>
        </body></html>
    `);
    win.document.close();
}

// --- SOCIAL MEDIA ---

function populateSocialRecipeDropdown() {
    const select = document.getElementById('social-recipe-select');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">-- Choose a Recipe --</option>';
    brews.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = b.recipeName;
        select.appendChild(opt);
    });
    select.value = current;
}

// --- SOCIAL MEDIA STUDIO 2.0 LOGIC ---

// 1. De hoofdfunctie om tekst te genereren
// --- SOCIAL MEDIA STUDIO: RYAN REYNOLDS & UNTAPPD UPDATE ---

// --- SOCIAL MEDIA STUDIO: SOMMELIER & UNTAPPD FIX ---

async function runSocialMediaGenerator() {
    const brewId = document.getElementById('social-recipe-select').value;
    const persona = document.getElementById('social-persona').value;
    const platform = document.getElementById('social-platform').value;
    const tweak = document.getElementById('social-tweak').value;
    
    if (!brewId && !tweak) { 
        showToast("Select a recipe OR type a topic.", "error"); 
        return; 
    }
    
    const container = document.getElementById('social-content-container');
    const imageBtn = document.getElementById('generate-social-image-btn');

    container.innerHTML = getLoaderHtml(`Channeling ${persona}...`);
    imageBtn.classList.add('hidden');

    // Context ophalen (NU MET MEER DETAILS)
    let context = "";
    if (brewId) {
        const brew = brews.find(b => b.id === brewId);
        // Probeer ABV te vinden (Final -> Target -> Unknown)
        const abv = brew.logData?.finalABV || brew.logData?.targetABV || "approx 12%";
        
        context = `
        **PRODUCT:** Mead (Honey Wine).
        **NAME:** ${brew.recipeName}
        **STATS:** ABV: ${abv}.
        **RECIPE DATA:** ${brew.recipeMarkdown.substring(0, 1000)}...
        **USER NOTES:** ${tweak}
        `;
    } else {
        context = `**TOPIC:** ${tweak}`;
    }

    // --- PERSONA DEFINITIES ---
    let toneInstruction = "";
    if (persona === 'Ryan Reynolds') {
        toneInstruction = `**TONE: RYAN REYNOLDS.** High energy, witty, sarcastic, break the fourth wall. Make fun of the effort.`;
    } else if (persona === 'Dry British') {
        toneInstruction = `**TONE: DRY BRITISH.** Understated, deadpan, cynical but charming. Use words like "splendid", "rather nice".`;
    } else if (persona === 'The Sommelier') {
        toneInstruction = `**TONE: THE SOMMELIER.** Elegant, sophisticated, sensory-focused. Use vocabulary like "bouquet", "finish", "notes of", "structure". No slang.`;
    } else {
        toneInstruction = `**TONE:** Bold, loud, enthusiastic like a Viking feast.`;
    }

    // --- PLATFORM DEFINITIES (AANGEPAST VOOR UNTAPPD) ---
    let platformInstruction = "";
    if (platform === 'Untappd') {
        platformInstruction = `
        **FORMAT: UNTAPPD DESCRIPTION (STRICT RULES):**
        1. **NO MARKDOWN:** Do NOT use bold (**), italics (*), or bullet points. Plain text only.
        2. **NO LISTS:** Do NOT list "Style: X" or "ABV: Y". Weave these facts naturally into the sentences (e.g., "This 12% Melomel features...").
        3. **CONTENT:** A single, flowing, seductive paragraph about the flavor profile, mouthfeel, and ingredients.
        4. **LENGTH:** Concise (max 100 words).
        5. **FORBIDDEN:** No hashtags, no emojis, no links.
        `;
    } else {
        // Instagram defaults
        platformInstruction = `
        **FORMAT: INSTAGRAM CAPTION.**
        - Engaging hook.
        - Use line breaks.
        - Use relevant Emojis.
        - End with 10-15 hashtags.
        `;
    }

    const prompt = `You are a Marketing Expert.
    
    ${context}
    
    ${toneInstruction}
    
    ${platformInstruction}
    
    **TASK:** Write the content for ${platform}.
    **EXTRA:** At the very end, provide a separate AI Image Prompt starting with "IMG_PROMPT:".
    `;
    
    try {
        const rawText = await performApiCall(prompt);
        
        let finalPost = rawText;
        let imgPrompt = "";

        if (rawText.includes("IMG_PROMPT:")) {
            const parts = rawText.split("IMG_PROMPT:");
            finalPost = parts[0].trim();
            imgPrompt = parts[1].trim();
        }

        // --- SCHOONMAAK ACTIE ---
        // Verwijder alle markdown sterretjes die de AI toch per ongeluk heeft toegevoegd
        finalPost = finalPost.replace(/\*\*/g, '').replace(/\*/g, '').trim();

        // Als Untappd: verwijder ook eventuele "Title:" prefixes die de AI soms verzint
        if (platform === 'Untappd') {
            finalPost = finalPost.replace(/^Title:\s*/i, '').replace(/^Description:\s*/i, '');
        }

        container.innerText = finalPost; 
        
        if (imgPrompt) {
            imageBtn.classList.remove('hidden');
            imageBtn.onclick = () => generateSocialImage(imgPrompt);
        }

    } catch (e) {
        container.innerHTML = `<p class="text-red-500 text-sm">Error: ${e.message}</p>`;
    }
}

// 2. De functie om een plaatje te maken

async function generateSocialImage(imagePrompt) {
    const container = document.getElementById('social-image-container');
    const btn = document.getElementById('generate-social-image-btn');
    
    // 1. HAAL DE GEKOZEN PERSONA OP
    const personaSelect = document.getElementById('social-persona');
    const selectedPersona = personaSelect ? personaSelect.value : '';

    // 2. KIES DE STIJL PREFIX OP BASIS VAN DE PERSONA
    let stylePrefix = "";

    switch (selectedPersona) {
        case "Ryan Reynolds":
            // Stijl: Scherp, premium, een beetje 'te' perfect, high-contrast, filmisch.
            stylePrefix = "Cinematic premium advertisement photography, sharp focus, high contrast lighting, witty composition, 8k resolution: ";
            break;
        case "Dry British":
            // Stijl: Ingetogen, natuurlijk licht, klassiek, elegant, niet schreeuwerig.
            stylePrefix = "Understated elegant photography, natural diffused lighting, classic composition, richly textured background, subtle and refined: ";
            break;
        case "The Sommelier":
            // Stijl: Luxe, focus op details (macro), wijnkelder sfeer, rijk, diepe kleuren.
            stylePrefix = "Luxurious macro photography, focus on liquid texture and details, ambient cellar lighting, rich bokeh background, high-end feel: ";
            break;
        case "The Viking":
            // Stijl: Ruw, donker hout, vuurlicht, stoer, ambachtelijk, een beetje wild.
            stylePrefix = "Rustic and bold photography, dark wood surfaces, warm firelight, rugged textures, ancient mead hall atmosphere, raw and powerful: ";
            break;
        default:
            // De "Standaard" BrewBuddy stijl (Modern Artisan) als er niets is gekozen.
            stylePrefix = "Artisan craft mead photography, warm natural light, rustic wooden background, highly detailed textures, inviting atmosphere, shallow depth of field: ";
            break;
    }
    
    // We hergebruiken de Google AI Key uit settings
    let apiKey = userSettings.apiKey;
    
    // Fallback voor als settings leeg is
    if (!apiKey && typeof CONFIG !== 'undefined' && CONFIG.firebase) {
         apiKey = CONFIG.firebase.apiKey;
    }

    if (!apiKey) {
        showToast("Geen Google API Key gevonden.", "error");
        return;
    }

    if (container) {
        // Laat even zien welke stijl we gebruiken in de loader tekst
        const styleName = selectedPersona || "Default Artisan";
        container.innerHTML = `<div class="loader"></div><p class="text-xs text-center mt-2 text-app-secondary animate-pulse">Painting in "${styleName}" style...</p>`;
    }

    const model = userSettings.imageModel || "imagen-3.0-generate-001";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;

    const requestBody = {
        instances: [
            { 
                // HIER COMBINEREN WE DE STIJL MET JOUW ONDERWERP
                prompt: stylePrefix + imagePrompt 
            }
        ],
        parameters: {
            sampleCount: 1,
            aspectRatio: "1:1"
        }
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error?.message || `Google Image Error (${response.status})`);
        }
        
        const data = await response.json();
        
        if (data.predictions && data.predictions.length > 0 && data.predictions[0].bytesBase64Encoded) {
            const base64Img = data.predictions[0].bytesBase64Encoded;
            if (container) {
                container.innerHTML = `<img src="data:image/png;base64,${base64Img}" class="w-full h-full object-cover rounded-xl shadow-inner animate-fade-in">`;
            }
            if (btn) btn.classList.add('hidden');
        } else {
            throw new Error("Geen plaatje ontvangen van Google.");
        }
        
    } catch (e) {
        console.error("Imagen Fout:", e);
        let msg = "Generation Failed";
        if (e.message.includes("403") || e.message.includes("permission")) msg = "API Key/Model toegang geweigerd.";
        
        if (container) {
            container.innerHTML = `<div class="p-4 text-center flex flex-col items-center justify-center h-full"><p class="text-red-500 text-xs font-bold mb-1">${msg}</p><p class="text-[10px] text-gray-400 leading-tight">${e.message}</p></div>`;
        }
        if (btn) btn.classList.remove('hidden');
    }
}

// 3. Functie om tekst te kopiëren
window.copySocialPost = function() {
    const text = document.getElementById('social-content-container').innerText;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        showToast("Caption copied to clipboard!", "success");
    });
}

// 4. Functie om op te slaan in de log van het recept
window.saveSocialPost = async function() {
    const brewId = document.getElementById('social-recipe-select').value;
    const content = document.getElementById('social-content-container').innerText;
    const platform = document.getElementById('social-platform').value;

    if (!brewId || !content || content.includes("Your generated caption")) {
        showToast("Nothing to save yet.", "error"); 
        return; 
    }
    
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), {
            socialMediaPosts: arrayUnion({ 
                platform: platform, 
                content: content, 
                createdAt: new Date().toISOString() 
            })
        });
        showToast("Post saved to recipe history!", "success");
    } catch(e) {
        console.error(e);
        showToast("Save failed.", "error");
    }
}

// --- DATA & SETTINGS ---

async function saveSettings() { /* Wordt al afgehandeld door saveUserSettings */ }

async function exportHistory() {
    const data = brews.map(b => ({...b, createdAt: b.createdAt.toDate().toISOString()}));
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'meandery_history.json';
    a.click();
}

async function exportInventory() {
    const blob = new Blob([JSON.stringify(inventory, null, 2)], {type: 'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'meandery_inventory.json';
    a.click();
}

// --- DATA CLEARING FUNCTIONS ---

async function clearCollection(collectionName) {
    if (!userId) return false;
    const appId = 'meandery-aa05e';
    const collectionRef = collection(db, 'artifacts', appId, 'users', userId, collectionName);
    
    try {
        const snapshot = await getDocs(collectionRef);
        if (snapshot.empty) return true;

        const batch = writeBatch(db);
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();
        return true;
    } catch(e) {
        console.error("Clear error:", e);
        return false;
    }
}

window.clearHistory = async function() {
    const action = async () => {
        if (await clearCollection('brews')) {
            showToast('Brew history cleared.', 'success');
            if(typeof loadHistory === 'function') loadHistory();
        } else {
            showToast('Failed to clear history.', 'error');
        }
    };
    // Gebruik de gevaar-modal voor bevestiging
    if (typeof showDangerModal === 'function') {
        showDangerModal(action, "DELETE HISTORY");
    } else if (confirm("Are you sure you want to delete ALL history?")) {
        action();
    }
}

window.clearInventory = async function() {
    const action = async () => {
        if (await clearCollection('inventory')) {
            showToast('Inventory cleared.', 'success');
            if(typeof loadInventory === 'function') loadInventory();
        } else {
            showToast('Failed to clear inventory.', 'error');
        }
    };
    
    if (typeof showDangerModal === 'function') {
        showDangerModal(action, "DELETE INVENTORY");
    } else if (confirm("Are you sure you want to delete ALL inventory?")) {
        action();
    }
}

// --- DEEL 7: PACKAGING, WATER & HELPERS ---

// --- HELPER FUNCTIONS ---
function handleStyleChange() {
    const styleSelect = document.getElementById('style');
    if(!styleSelect) return;
    const style = styleSelect.value.toLowerCase();
    const fruitSection = document.getElementById('fruit-section');
    const spiceSection = document.getElementById('spice-section');
    const braggotSection = document.getElementById('braggot-section');

    fruitSection.classList.toggle('hidden', !style.includes('melomel'));
    spiceSection.classList.toggle('hidden', !style.includes('metheglin'));
    braggotSection.classList.toggle('hidden', !style.includes('braggot'));

    if (!style.includes('melomel')) document.querySelectorAll('#fruit-section input:checked').forEach(cb => cb.checked = false);
    if (!style.includes('metheglin')) document.querySelectorAll('#spice-section input:checked').forEach(cb => cb.checked = false);
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

// --- EQUIPMENT PROFILE MANAGEMENT ---

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
        // Zorg dat de UI update (bijv. boil-off veld verbergen)
        if(window.handleEquipmentTypeChange) window.handleEquipmentTypeChange(); 
        
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
        const list = document.getElementById('equipment-profiles-list');
        if(list) list.innerHTML = `<p class="text-red-500">Could not load equipment profiles.</p>`;
    });
}

window.renderEquipmentProfiles = function() {
    const listDiv = document.getElementById('equipment-profiles-list');
    if (!listDiv) return;

    if (equipmentProfiles.length === 0) {
        listDiv.innerHTML = `<p class="text-center text-app-secondary/80 py-8">No equipment profiles yet.</p>`;
        return;
    }
    
    listDiv.innerHTML = equipmentProfiles.map(p => `
        <div id="equip-item-${p.id}" class="p-4 card rounded-xl border-l-4 border-app-brand shadow-sm hover:shadow-md transition-all bg-app-secondary mb-3 group relative">
            <div class="flex justify-between items-start">
                 
                 <div class="pr-4">
                    <div class="font-bold text-xl text-app-header leading-tight">${p.name}</div>
                    <div class="text-xs text-app-secondary mt-1 flex flex-col gap-0.5">
                        <span class="font-bold uppercase tracking-wider text-app-brand mb-1">${p.type}</span>
                        <span>Capacity: ${p.capacityLiters || '-'}L</span>
                        <span>Loss: ${p.trubLossLiters || 0}L ${p.type === 'Kettle' ? `• Boil-off: ${p.boilOffRateLitersPerHour || 0}L/hr` : ''}</span>
                    </div>
                </div>

                <div class="text-right">
                    <div class="inline-block bg-app-tertiary px-2 py-1 rounded-lg border border-app-brand/10 mb-2">
                        <div class="font-mono font-bold text-app-header text-sm">${p.quantity || 1} <span class="text-xs font-normal text-app-secondary">units</span></div>
                    </div>
                </div>
            </div>

            <div class="flex justify-end gap-4 mt-2 pt-2 border-t border-app-brand/5">
                <button onclick="window.editEquipmentProfile('${p.id}')" class="text-xs font-bold text-app-secondary hover:text-app-brand uppercase tracking-wider flex items-center gap-1 transition-colors">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg> 
                    Edit
                </button>
                <button onclick="window.deleteEquipmentProfile('${p.id}')" class="text-xs font-bold text-app-secondary hover:text-red-600 uppercase tracking-wider flex items-center gap-1 transition-colors">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg> 
                    Delete
                </button>
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
                <input type="text" id="edit-equip-name-${p.id}" value="${p.name}" class="w-full p-1 border rounded bg-app-tertiary">
                <input type="number" id="edit-equip-quantity-${p.id}" value="${p.quantity || 1}" min="1" class="w-full p-1 border rounded bg-app-tertiary">
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                <input type="number" id="edit-equip-cap-${p.id}" value="${p.capacityLiters || ''}" placeholder="Cap (L)" class="w-full p-1 border rounded bg-app-tertiary">
                <input type="number" id="edit-equip-trub-${p.id}" value="${p.trubLossLiters || '0'}" placeholder="Trub (L)" class="w-full p-1 border rounded bg-app-tertiary">
                <input type="number" id="edit-equip-boiloff-${p.id}" value="${p.boilOffRateLitersPerHour || '0'}" placeholder="Boil (L/hr)" class="w-full p-1 border rounded bg-app-tertiary ${p.type !== 'Kettle' ? 'hidden' : ''}">
                <div class="flex gap-2 col-span-2 md:col-span-1">
                    <button onclick="window.updateEquipmentProfile('${p.id}', '${p.type}')" class="w-full bg-green-600 text-white px-3 py-1 rounded btn">Save</button>
                    <button onclick="renderEquipmentProfiles()" class="w-full bg-gray-500 text-white px-3 py-1 rounded btn">Cancel</button>
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

    if (!updatedData.name) { showToast("Name required.", "error"); return; }

    try {
        const appId = 'meandery-aa05e';
        const itemDocRef = doc(db, 'artifacts', appId, 'users', userId, 'equipmentProfiles', profileId);
        await updateDoc(itemDocRef, updatedData);
        showToast("Profile updated!", "success");
        // De onSnapshot listener regelt de refresh
    } catch (error) { console.error(error); showToast("Update failed.", "error"); }
}

window.deleteEquipmentProfile = async function(profileId) {
    if (!userId || !confirm('Delete this profile?')) return;
    try {
        const appId = 'meandery-aa05e';
        await deleteDoc(doc(db, 'artifacts', appId, 'users', userId, 'equipmentProfiles', profileId));
        showToast("Deleted.", "success");
    } catch (error) { console.error(error); showToast("Delete failed.", "error"); }
}

function populateEquipmentProfilesDropdown() {
    const select = document.getElementById('equipmentProfileSelect');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">None (Use default values)</option>';
    equipmentProfiles.forEach(p => {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = p.name;
        select.appendChild(option);
    });
    select.value = current;
}

// --- BOTTLING & CELLAR MANAGEMENT ---

let currentBrewToBottleId = null; 

window.showBottlingModal = function(brewId) {
    customBottles = []; // Reset de lijst
    renderCustomBottlesList(); // Maak de UI leeg
    currentBrewToBottleId = brewId;
    const bottlingForm = document.getElementById('bottling-form');
    if(bottlingForm) bottlingForm.reset();
    
    const dateInput = document.getElementById('bottlingDate');
    if(dateInput) dateInput.valueAsDate = new Date();
    
    document.getElementById('bottling-modal').classList.remove('hidden');
}

window.hideBottlingModal = function() {
    document.getElementById('bottling-modal').classList.add('hidden');
    currentBrewToBottleId = null;
}

// Custom Bottle List Helpers
window.renderCustomBottlesList = function() {
    const listDiv = document.getElementById('custom-bottles-list');
    if (!listDiv) return;
    if (customBottles.length === 0) { listDiv.innerHTML = ''; return; }

    const currency = userSettings.currencySymbol || '€';
    listDiv.innerHTML = customBottles.map((bottle, index) => `
        <div class="flex justify-between items-center p-2 bg-app-primary rounded-md text-sm mb-1">
            <span><strong>${bottle.quantity}x</strong> ${bottle.size}ml (at ${currency}${bottle.price.toFixed(2)} each)</span>
            <button type="button" onclick="window.removeCustomBottleFromList(${index})" class="text-red-500 hover:text-red-700 font-bold text-lg">&times;</button>
        </div>
    `).join('');
}

window.addCustomBottleToList = function() {
    const size = parseInt(document.getElementById('customSize').value) || 0;
    const quantity = parseInt(document.getElementById('customQty').value) || 0;
    const price = parseFloat(document.getElementById('customPrice').value) || 0;

    if (size <= 0 || quantity <= 0) {
        showToast("Invalid size or quantity.", "error");
        return;
    }
    customBottles.push({ size, quantity, price });
    renderCustomBottlesList();
    
    // Reset inputs
    document.getElementById('customSize').value = '';
    document.getElementById('customQty').value = '';
    document.getElementById('customPrice').value = '';
    document.getElementById('customSize').focus();
}

window.removeCustomBottleFromList = function(index) {
    customBottles.splice(index, 1);
    renderCustomBottlesList();
}

// --- BOTTLE BATCH (MET SLIMME PHYSICS & AUTO-CORRECT) ---
window.bottleBatch = async function(e) {
    e.preventDefault();
    if (!currentBrewToBottleId) return;

    const submitButton = e.target.querySelector('button[type="submit"]');
    const originalButtonText = submitButton.innerHTML;
    submitButton.disabled = true;
    submitButton.textContent = 'Checking Physics...'; 

    try {
        const originalBrew = brews.find(b => b.id === currentBrewToBottleId);
        if (!originalBrew) throw new Error("Could not find the original recipe.");

        // 1. VERZAMEL DE FLESSEN
        const bottlesData = [
            { size: 750, quantity: parseInt(document.getElementById('qty750').value) || 0, price: null },
            { size: 500, quantity: parseInt(document.getElementById('qty500').value) || 0, price: null },
            { size: 330, quantity: parseInt(document.getElementById('qty330').value) || 0, price: null },
            { size: 250, quantity: parseInt(document.getElementById('qty250').value) || 0, price: null },
            ...customBottles
        ].filter(b => b.quantity > 0 && b.size > 0);

        if (bottlesData.length === 0) throw new Error("Enter quantity for at least one bottle.");

        // --- STAP 2: PHYSICS CHECK & AUTO-CORRECT LOGIC (V3.0) ---
        let totalLitersBottled = 0;
        bottlesData.forEach(b => totalLitersBottled += (b.size * b.quantity) / 1000);

        // Haal huidige volume op
        const currentLogVol = (originalBrew.logData && originalBrew.logData.currentVolume && parseFloat(originalBrew.logData.currentVolume) > 0) 
                              ? parseFloat(originalBrew.logData.currentVolume) 
                              : originalBrew.batchSize;

        let volumeUpdatePayload = {}; 
        const diff = (totalLitersBottled - currentLogVol).toFixed(2);

        // SCENARIO 1: MEER GEBOTTELD DAN AANWEZIG (Onmogelijk -> Altijd vragen)
        if (totalLitersBottled > currentLogVol) {
            
            if (confirm(`⚠️ PHYSICS WARNING:\n\nYou are bottling ${totalLitersBottled.toFixed(2)}L, but logs say ${currentLogVol.toFixed(2)}L available (Diff: +${diff}L).\n\nClick OK to auto-correct the log to ${totalLitersBottled.toFixed(2)}L and proceed.\nClick Cancel to check your inputs.`)) {
                volumeUpdatePayload = { "logData.currentVolume": totalLitersBottled.toFixed(2) };
            } else {
                throw new Error("Bottling cancelled by user.");
            }

        // SCENARIO 2: MINDER GEBOTTELD (Verlies? Of meetfout?)
        // We vragen het alleen als het verschil groter is dan 0.5 Liter (kleine verliezen zijn normaal)
        } else if ((currentLogVol - totalLitersBottled) > 0.5) {
            
            const loss = (currentLogVol - totalLitersBottled).toFixed(2);
            
            // De vraag: Is het verlies (OK) of een correctie (Cancel -> Update Log)?
            // We gebruiken hier een trucje met confirm:
            // OK = "Het is verlies (Spill/Trub)" -> Logboek NIET aanpassen (want je had echt 5L)
            // Cancel = "Pas logboek aan (Meetfout)" -> Logboek WEL aanpassen
            
            // Omdat confirm() maar 2 smaken heeft, maken we een custom flow met prompt of een slimme confirm tekst.
            // Laten we het simpel houden: We vragen of we het logboek moeten corrigeren.
            
            if (confirm(`📉 SIGNIFICANT LOSS DETECTED:\n\nYou are bottling ${totalLitersBottled.toFixed(2)}L, leaving ${loss}L behind.\n\nIs this normal loss (trub/spill)?\n\n[OK] = Yes, record as Loss. Keep log at ${currentLogVol.toFixed(2)}L.\n[Cancel] = No, I measured wrong. Update log to ${totalLitersBottled.toFixed(2)}L.`)) {
                // OK geklikt: Doe niets (Het is verlies, dus logboek blijft 5L)
                console.log("User confirmed loss. No log update.");
            } else {
                // Cancel geklikt: Gebruiker wil het logboek corrigeren
                if(confirm(`Confirm: Update logbook volume from ${currentLogVol.toFixed(2)}L to ${totalLitersBottled.toFixed(2)}L?`)) {
                     volumeUpdatePayload = { "logData.currentVolume": totalLitersBottled.toFixed(2) };
                }
            }
        }
        // ----------------------------------------------------

        // --- STAP 3: STOCK CHECK (Verpakking) ---
        const closureType = document.getElementById('closureTypeSelect').value;
        const outOfStockItems = [];
        let totalBottles = 0;

        bottlesData.forEach(bottle => {
            totalBottles += bottle.quantity;
            if (bottle.price === null) { // Alleen checken voor standaard items
                const stockId = `bottle_${bottle.size}`;
                const currentStock = packagingCosts[stockId]?.qty || 0;
                if (bottle.quantity > currentStock) {
                    outOfStockItems.push(`${bottle.quantity} x ${bottle.size}ml bottle(s) (only ${currentStock} in stock)`);
                }
            }
        });

        if (closureType === 'auto') {
            const closuresNeeded = { cork: 0, crown_cap_26: 0, crown_cap_29: 0 };
            bottlesData.forEach(b => {
                if (b.size >= 750) closuresNeeded.cork += b.quantity;
                else if (b.size >= 500) closuresNeeded.crown_cap_29 += b.quantity;
                else closuresNeeded.crown_cap_26 += b.quantity;
            });
            if (closuresNeeded.cork > (packagingCosts['cork']?.qty || 0)) outOfStockItems.push(`Not enough corks`);
            if (closuresNeeded.crown_cap_26 > (packagingCosts['crown_cap_26']?.qty || 0)) outOfStockItems.push(`Not enough 26mm caps`);
            if (closuresNeeded.crown_cap_29 > (packagingCosts['crown_cap_29']?.qty || 0)) outOfStockItems.push(`Not enough 29mm caps`);
        } else {
            if (totalBottles > (packagingCosts[closureType]?.qty || 0)) outOfStockItems.push(`Not enough ${closureType}`);
        }

        if (totalBottles > (packagingCosts['label']?.qty || 0)) outOfStockItems.push(`Not enough labels`);

        if (outOfStockItems.length > 0) throw new Error(`Stock missing:\n- ${outOfStockItems.join('\n- ')}`);

        // --- STAP 4: KOSTEN BEREKENEN ---
        // Helper functie inline of extern gebruiken
        const packCosts = (typeof getPackagingCosts === 'function') ? getPackagingCosts() : {};
        let totalPackagingCost = 0;

        bottlesData.forEach(bottle => {
            const bottleCost = bottle.price !== null ? bottle.price : (packCosts[bottle.size.toString()] || 0);
            let closureCost = 0;
            if (closureType === 'auto') {
                if (bottle.size >= 750) closureCost = packCosts.cork || 0;
                else if (bottle.size >= 500) closureCost = packCosts.crown_cap_29 || 0;
                else closureCost = packCosts.crown_cap_26 || 0;
            } else closureCost = packCosts[closureType] || 0;
            
            const labelCost = packCosts.label || 0;
            totalPackagingCost += bottle.quantity * (bottleCost + closureCost + labelCost);
        });

        const finalTotalCost = (originalBrew.totalCost || 0) + totalPackagingCost;
        const currency = userSettings.currencySymbol || '€';

        // Finale Bevestiging
        if (confirm(`Packaging cost: ${currency}${totalPackagingCost.toFixed(2)}. Total batch cost: ${currency}${finalTotalCost.toFixed(2)}. Proceed?`)) {
            
            // --- STAP 5: VOORRAAD AFBOEKEN ---
            const updatedStock = JSON.parse(JSON.stringify(packagingCosts));
            const deduct = (id, qty) => {
                if (updatedStock[id]) {
                    const cpu = updatedStock[id].price / updatedStock[id].qty;
                    updatedStock[id].qty = Math.max(0, updatedStock[id].qty - qty);
                    updatedStock[id].price = Math.max(0, updatedStock[id].price - (cpu * qty));
                }
            };

            bottlesData.forEach(b => { if(b.price === null) deduct(`bottle_${b.size}`, b.quantity); });
            if (closureType === 'auto') {
                bottlesData.forEach(b => {
                    if (b.size >= 750) deduct('cork', b.quantity);
                    else if (b.size >= 500) deduct('crown_cap_29', b.quantity);
                    else deduct('crown_cap_26', b.quantity);
                });
            } else deduct(closureType, totalBottles);
            deduct('label', totalBottles);

            // Opslaan verpakking
            await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'settings', 'packaging'), updatedStock);
            packagingCosts = updatedStock;

            // --- STAP 6: NAAR DE KELDER (CELLAR) ---
            const bottlingDate = new Date(document.getElementById('bottlingDate').value);
            const cellarData = {
                userId, brewId: currentBrewToBottleId,
                recipeName: originalBrew.recipeName,
                bottlingDate,
                bottles: bottlesData.map(({price, ...rest}) => rest),
                totalBatchCost: finalTotalCost,
                ingredientCost: originalBrew.totalCost || 0,
                peakFlavorDate: null, peakFlavorJustification: 'Generated by Mazer 2.0'
            };

            await addDoc(collection(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'cellar'), cellarData);

            // --- STAP 7: STATUS UPDATE (MET AUTO-CORRECT VOLUME) ---
            const brewUpdateData = { 
                isBottled: true,
                ...volumeUpdatePayload // <--- Hier wordt de log correctie toegepast indien nodig!
            };
            
            await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', currentBrewToBottleId), brewUpdateData);

            // Reset UI
            if (currentBrewDay.brewId === currentBrewToBottleId) {
                currentBrewDay = { brewId: null };
                await saveUserSettings();
            }

            hideBottlingModal();
            showToast("Batch bottled successfully!", "success");
            
            // Refresh alle schermen
            if(typeof loadHistory === 'function') loadHistory();
            if(typeof loadCellar === 'function') loadCellar();
            if(typeof renderBrewDay === 'function') renderBrewDay('none');
            
            switchMainView('management');
            switchSubView('cellar', 'management-main-view');
        }
    } catch (error) {
        console.error(error);
        showToast(error.message, "error");
    } finally {
        submitButton.disabled = false;
        submitButton.innerHTML = originalButtonText;
    }
}

// --- INVENTORY MANAGEMENT FUNCTIONS ---

// --- BARCODE SCANNER FUNCTIONS ---

function startScanner() {
    const container = document.getElementById('barcode-scanner-container');
    if (container) container.classList.remove('hidden');

    // We gebruiken de globale variabele die bovenaan app.js is gedeclareerd
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
            const container = document.getElementById('barcode-scanner-container');
            if (container) container.classList.add('hidden');
            html5QrcodeScanner.clear();
        }).catch(err => console.error("Error stopping scanner:", err));
    } else {
         const container = document.getElementById('barcode-scanner-container');
         if (container) container.classList.add('hidden');
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
        
        if (!response.ok) throw new Error("API Connection failed.");

        const data = await response.json();

        if (data.status === 1 && data.product && data.product.product_name) {
            itemNameInput.value = data.product.product_name;
            showToast(`Found: ${data.product.product_name}`, "success");
        } else {
            showToast("Product not found in database.", "error");
        }
   } catch (error) {
       console.error("Barcode lookup failed:", error);
       showToast("Could not look up barcode info.", "error");
   } finally {
       itemNameInput.placeholder = originalPlaceholder;
   }
}

async function addInventoryItem(e) {
    e.preventDefault();
    if (!userId) return;
    
    const name = document.getElementById('itemName').value;
    const qty = parseFloat(document.getElementById('itemQty').value);
    const unit = document.getElementById('itemUnit').value;
    const price = parseFloat(document.getElementById('itemPrice').value);
    const category = document.getElementById('itemCategory').value;
    const expirationDate = document.getElementById('itemExpirationDate').value || null;

    if (!name || isNaN(qty) || isNaN(price)) {
        showToast("Please fill in valid name, quantity and price.", "error");
        return;
    }

    const itemData = { userId, name, qty, unit, price, category, expirationDate };

    try {
        const appId = 'meandery-aa05e';
        const invCol = collection(db, 'artifacts', appId, 'users', userId, 'inventory');
        await addDoc(invCol, itemData);
        document.getElementById('inventory-form').reset();
        showToast("Ingredient added to inventory!", "success");
    } catch (error) {
        console.error("Error adding inventory item:", error);
        showToast("Could not add ingredient.", "error");
    }
}

window.renderInventory = function() {
    const listDiv = document.getElementById('inventory-list');
    if (!listDiv) return;

    // Groepeer items op categorie
    const grouped = inventory.reduce((acc, item) => {
        const cat = item.category || 'Other';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(item);
        return acc;
    }, {});

    const categories = ['Honey', 'Yeast', 'Nutrient', 'Malt Extract', 'Fruit', 'Spice', 'Adjunct', 'Chemical', 'Water'];
    const currency = userSettings.currencySymbol || '€';
    let html = '';

    categories.forEach(category => {
        if (grouped[category]) {
            html += `<h3 class="text-lg font-header mt-6 mb-3 uppercase tracking-wider text-app-brand opacity-80 border-b border-app-brand/10 pb-1">${category}</h3>`;
            html += `<div class="grid grid-cols-1 gap-3">`; 
            
            grouped[category].forEach(item => {
                const expDateStr = item.expirationDate ? new Date(item.expirationDate).toLocaleDateString() : 'N/A';
                let dateClass = 'text-app-secondary/60';
                if (item.expirationDate) {
                    const days = (new Date(item.expirationDate) - new Date()) / (1000 * 60 * 60 * 24);
                    if (days < 0) dateClass = 'text-red-500 font-bold';
                    else if (days <= 30) dateClass = 'text-amber-500 font-semibold';
                }

                let catClass = 'cat-yeast'; 
                const c = item.category.toLowerCase();
                if(c.includes('honey')) catClass = 'cat-honey';
                if(c.includes('fruit')) catClass = 'cat-fruit';
                if(c.includes('spice')) catClass = 'cat-spice';
                if(c.includes('nutrient')) catClass = 'cat-nutrient';
                if(c.includes('chemical') || c.includes('clean')) catClass = 'cat-chemical';

                html += `
                <div id="item-${item.id}" class="p-4 card rounded-xl border-l-4 ${catClass.replace('cat-', 'border-')} shadow-sm hover:shadow-md transition-all bg-app-secondary group relative">
                    <div class="flex justify-between items-start">
                        
                        <div class="pr-4">
                            <div class="font-bold text-xl text-app-header leading-tight">${item.name}</div>
                            <div class="text-xs ${dateClass} mt-1 flex items-center gap-1">
                                <svg class="w-3 h-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                Exp: ${expDateStr}
                            </div>
                        </div>

                        <div class="text-right">
                            <div class="inline-block bg-app-tertiary px-2 py-1 rounded-lg border border-app-brand/10 mb-2">
                                <div class="font-mono font-bold text-app-header text-sm">${item.qty} <span class="text-xs font-normal text-app-secondary">${item.unit}</span></div>
                            </div>
                            <div class="text-xs text-app-secondary font-mono mb-3">
                                ${currency}${(item.price || 0).toFixed(2)}
                            </div>
                        </div>
                    </div>

                    <div class="flex justify-end gap-4 mt-2 pt-2 border-t border-app-brand/5">
                        <button onclick="window.editInventoryItem('${item.id}')" class="text-xs font-bold text-app-secondary hover:text-blue-600 uppercase tracking-wider flex items-center gap-1 transition-colors">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg> Edit
                        </button>
                        <button onclick="window.deleteInventoryItem('${item.id}')" class="text-xs font-bold text-app-secondary hover:text-red-600 uppercase tracking-wider flex items-center gap-1 transition-colors">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg> Delete
                        </button>
                    </div>
                </div>`; 
            });
            html += `</div>`;
        }
    });
    
    if (inventory.length === 0) listDiv.innerHTML = `<div class="text-center py-12 opacity-50"><p>The Cupboard is Bare</p></div>`;
    else listDiv.innerHTML = html;
}

window.deleteInventoryItem = async function(itemId) {
    if (!userId) return;
    try {
        await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'inventory', itemId));
        showToast("Item deleted.", "success");
    } catch (error) { showToast("Error deleting item.", "error"); }
}

window.editInventoryItem = function(itemId) {
    const item = inventory.find(i => i.id === itemId);
    if (!item) return;
    const itemDiv = document.getElementById(`item-${itemId}`);
    const currency = userSettings.currencySymbol || '€';
    
    itemDiv.innerHTML = `
        <div class="w-full space-y-2 p-2 bg-app-primary rounded">
            <input type="text" id="edit-name-${itemId}" value="${item.name}" class="w-full p-1 border rounded bg-app-tertiary">
            <div class="grid grid-cols-2 gap-2">
                <input type="number" id="edit-qty-${itemId}" value="${item.qty}" step="0.01" class="w-full p-1 border rounded bg-app-tertiary">
                <input type="number" id="edit-price-${itemId}" value="${item.price}" step="0.01" class="w-full p-1 border rounded bg-app-tertiary">
            </div>
            <div class="flex gap-2">
                <button onclick="window.updateInventoryItem('${itemId}')" class="w-full bg-green-600 text-white px-3 py-1 rounded btn">Save</button>
                <button onclick="renderInventory()" class="w-full bg-gray-500 text-white px-3 py-1 rounded btn">Cancel</button>
            </div>
        </div>`;
}

window.updateInventoryItem = async function(itemId) {
    if (!userId) return;
    const data = {
        name: document.getElementById(`edit-name-${itemId}`).value,
        qty: parseFloat(document.getElementById(`edit-qty-${itemId}`).value),
        price: parseFloat(document.getElementById(`edit-price-${itemId}`).value)
    };
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'inventory', itemId), data);
        showToast("Item updated!", "success");
        // Snapshot listener update de UI automatisch
    } catch (error) { showToast("Update failed.", "error"); }
}

// --- INVENTORY DEDUCTION LOGIC ---
window.performInventoryDeduction = async function(ingredientsArray) {
    if (!userId || !ingredientsArray || ingredientsArray.length === 0) return;
    const batch = writeBatch(db);
    let updates = 0, notFound = [];

    ingredientsArray.forEach(req => {
        const item = inventory.find(inv => inv.name.toLowerCase() === req.name.toLowerCase());
        const qty = parseFloat(req.quantity || req.actualQty);
        if (item && !isNaN(qty)) {
            const newQty = item.qty - qty;
            if (newQty >= 0) {
                batch.update(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'inventory', item.id), { qty: newQty });
                updates++;
            } else notFound.push(`${req.name} (low stock)`);
        } else notFound.push(`${req.name} (not found)`);
    });

    if (updates > 0) {
        await batch.commit();
        showToast(`${updates} items deducted.`, 'success');
    }
    if (notFound.length > 0) showToast(`Issues: ${notFound.join(', ')}`, 'info');
}

window.deductActualsFromInventory = function(brewId) {
    const logData = getLogDataFromDOM('brew-day-content');
    if (!logData.actualIngredients || logData.actualIngredients.length === 0) return showToast("Save log first.", "error");
    if (confirm("Deduct these amounts from inventory?")) {
        window.performInventoryDeduction(logData.actualIngredients);
    }
}

function populatePackagingDropdown() {
    const select = document.getElementById('packaging-item-select');
    if (!select) return;
    select.innerHTML = PACKAGING_ITEMS.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
}

window.renderPackagingUI = function() {
    const listContainer = document.getElementById('packaging-list');
    const stockContainer = document.getElementById('packaging-stock-container');
    if (!listContainer || !stockContainer) return;

    const hasStock = PACKAGING_ITEMS.some(item => packagingCosts[item.id] && packagingCosts[item.id].qty > 0);
    stockContainer.classList.toggle('hidden', !hasStock);

    if (hasStock) {
        const currency = userSettings.currencySymbol || '€';
        listContainer.innerHTML = PACKAGING_ITEMS
            .filter(item => packagingCosts[item.id] && packagingCosts[item.id].qty > 0)
            .map(item => {
                const itemData = packagingCosts[item.id];
                const costPerUnit = (itemData.qty > 0 && itemData.price > 0) ? (itemData.price / itemData.qty).toFixed(2) : '0.00';
                
                return `
                   <div id="pkg-item-${item.id}" class="p-4 card rounded-xl border-l-4 border-app-brand shadow-sm hover:shadow-md transition-all bg-app-secondary mb-3 group relative">
                       <div class="flex justify-between items-start">
                           
                           <div class="pr-4">
                               <div class="font-bold text-xl text-app-header leading-tight">${item.name}</div>
                               <div class="text-xs text-app-secondary mt-1">
                                   Cost/Unit: <strong>${currency}${costPerUnit}</strong>
                               </div>
                           </div>

                           <div class="text-right">
                               <div class="inline-block bg-app-tertiary px-2 py-1 rounded-lg border border-app-brand/10 mb-2">
                                   <div class="font-mono font-bold text-app-header text-sm">${itemData.qty} <span class="text-xs font-normal text-app-secondary">st</span></div>
                               </div>
                               <div class="text-xs text-app-secondary font-mono mb-3">
                                   Total: ${currency}${itemData.price.toFixed(2)}
                               </div>
                           </div>
                       </div>

                       <div class="flex justify-end gap-4 mt-2 pt-2 border-t border-app-brand/5">
                           <button onclick="window.editPackagingItem('${item.id}')" class="text-xs font-bold text-app-secondary hover:text-app-brand uppercase tracking-wider flex items-center gap-1 transition-colors">
                               <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                               Edit
                           </button>
                           <button onclick="window.clearPackagingItem('${item.id}')" class="text-xs font-bold text-app-secondary hover:text-red-600 uppercase tracking-wider flex items-center gap-1 transition-colors">
                               <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                               Delete
                           </button>
                       </div>
                   </div>`;
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

    if (!itemId || qtyAdded <= 0) { showToast("Invalid input.", "error"); return; }

    const currentQty = packagingCosts[itemId]?.qty || 0;
    const currentPrice = packagingCosts[itemId]?.price || 0;
    packagingCosts[itemId] = { qty: currentQty + qtyAdded, price: currentPrice + priceAdded };
    
    await savePackagingCosts(); 
    document.getElementById('packaging-add-form').reset();
}

async function loadPackagingCosts() {
    if (!userId) return;
    try {
        const docSnap = await getDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'settings', 'packaging'));
        packagingCosts = docSnap.exists() ? docSnap.data() : {};
        renderPackagingUI();
        populatePackagingDropdown();
    } catch (error) { console.error("Error loading packaging costs:", error); }
}

async function savePackagingCosts() {
    if (!userId) return;
    try {
        await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'settings', 'packaging'), packagingCosts);
        showToast('Packaging updated!', 'success');
        await loadPackagingCosts();
    } catch (error) { console.error(error); showToast('Failed to save packaging.', 'error'); }
}

window.editPackagingItem = function(itemId) {
    const item = PACKAGING_ITEMS.find(i => i.id === itemId);
    const itemData = packagingCosts[itemId] || {};
    const itemDiv = document.getElementById(`pkg-item-${itemId}`);
    const currency = userSettings.currencySymbol || '€';

    itemDiv.innerHTML = `
        <div class="w-full space-y-2 p-2 bg-app-primary rounded">
            <p class="font-bold">${item.name}</p>
            <div class="grid grid-cols-2 gap-2">
                <input type="number" id="edit-qty-${itemId}" value="${itemData.qty}" placeholder="Quantity" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-header">
                <input type="number" id="edit-price-${itemId}" value="${itemData.price}" step="0.01" placeholder="Total Price (${currency})" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-header">
            </div>
            <div class="flex gap-2">
                <button onclick="window.updatePackagingItem('${itemId}')" class="w-full bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 text-sm btn">Save</button>
                <button onclick="renderPackagingUI()" class="w-full bg-gray-500 text-white px-3 py-1 rounded hover:bg-gray-600 text-sm btn">Cancel</button>
           </div>
       </div>`;
}

window.updatePackagingItem = function(itemId) {
    const qty = parseFloat(document.getElementById(`edit-qty-${itemId}`).value) || 0;
    const price = parseFloat(document.getElementById(`edit-price-${itemId}`).value) || 0;
    packagingCosts[itemId] = { qty, price };
    savePackagingCosts();
}

window.clearPackagingItem = function(itemId) {
    if (confirm("Clear stock for this item?")) {
       packagingCosts[itemId] = { qty: 0, price: 0 };
       savePackagingCosts();
    }
}

function getPackagingCosts() {
    const costs = {};
    PACKAGING_ITEMS.forEach(item => {
        const d = packagingCosts[item.id];
        let cpu = (d && d.qty > 0) ? d.price / d.qty : 0;
        if (item.id === 'bottle_750') costs['750'] = cpu;
        if (item.id === 'bottle_500') costs['500'] = cpu;
        if (item.id === 'bottle_330') costs['330'] = cpu;
        if (item.id === 'bottle_250') costs['250'] = cpu;
        if (item.id === 'cork') costs['cork'] = cpu;
        if (item.id === 'crown_cap_26') costs['crown_cap_26'] = cpu;
        if (item.id === 'crown_cap_29') costs['crown_cap_29'] = cpu;
        if (item.id === 'label') costs['label'] = cpu;
    });
    return costs;
}

// --- WATER PROFILE MANAGEMENT ---

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

async function loadUserWaterProfiles() {
    if (!userId) return;
    onSnapshot(query(collection(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'waterProfiles')), (snapshot) => {
        userWaterProfiles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        populateWaterDropdown();
        renderUserWaterProfilesList();
    });
}

function populateWaterDropdown() {
    const select = document.getElementById('waterSource');
    if (!select) return;
    select.innerHTML = `
        <optgroup label="Built-in Profiles">${Object.entries(BUILT_IN_WATER_PROFILES).map(([id, p]) => `<option value="builtin_${id}">${p.name}</option>`).join('')}</optgroup>
        <optgroup label="My Profiles">${userWaterProfiles.map(p => `<option value="user_${p.id}">${p.name}</option>`).join('')}</optgroup>
    `;
}

function renderUserWaterProfilesList() {
    const listDiv = document.getElementById('user-water-profiles-list');
    if (!listDiv) return;
    if (userWaterProfiles.length === 0) { listDiv.innerHTML = `<p class="text-sm text-app-secondary/80 text-center">No saved profiles.</p>`; return; }
    listDiv.innerHTML = userWaterProfiles.map(p => `
        <div class="flex justify-between items-center p-2 card rounded-md text-sm">
            <span>${p.name}</span>
            <div><button onclick="window.editWaterProfile('${p.id}')" class="text-blue-600 hover:text-blue-800">Edit</button><button onclick="window.deleteWaterProfile('${p.id}')" class="text-red-600 hover:text-red-800 ml-2">Delete</button></div>
        </div>`).join('');
}

async function saveWaterProfile(e) {
    e.preventDefault();
    if (!userId) return;
    const id = document.getElementById('water-profile-id').value;
    const data = {
        name: document.getElementById('water-profile-name').value,
        ca: parseFloat(document.getElementById('manual_ca').value)||0, mg: parseFloat(document.getElementById('manual_mg').value)||0,
        na: parseFloat(document.getElementById('manual_na').value)||0, so4: parseFloat(document.getElementById('manual_so4').value)||0,
        cl: parseFloat(document.getElementById('manual_cl').value)||0, hco3: parseFloat(document.getElementById('manual_hco3').value)||0,
    };
    if (!data.name) return showToast("Name required.", "error");
    
    try {
        const col = collection(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'waterProfiles');
        if (id) await setDoc(doc(col, id), data); else await addDoc(col, data);
        showToast("Profile saved!", "success");
        document.getElementById('water-profile-form').reset();
        document.getElementById('water-profile-id').value = '';
    } catch (e) { console.error(e); showToast("Error saving.", "error"); }
}

window.editWaterProfile = function(id) {
    const p = userWaterProfiles.find(p => p.id === id);
    if (!p) return;
    document.getElementById('water-profile-id').value = p.id;
    document.getElementById('water-profile-name').value = p.name;
    document.getElementById('manual_ca').value = p.ca; document.getElementById('manual_mg').value = p.mg;
    document.getElementById('manual_na').value = p.na; document.getElementById('manual_so4').value = p.so4;
    document.getElementById('manual_cl').value = p.cl; document.getElementById('manual_hco3').value = p.hco3;
}

window.deleteWaterProfile = async function(id) {
    if (!userId || !confirm("Delete profile?")) return;
    try { await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'waterProfiles', id)); showToast("Deleted.", "success"); }
    catch (e) { showToast("Error deleting.", "error"); }
}

window.showLastPrompt = function() {
    const modal = document.getElementById('prompt-modal');
    const content = document.getElementById('prompt-modal-content');
    if (modal && content) {
        content.textContent = lastGeneratedPrompt || "No prompt generated yet.";
        modal.classList.remove('hidden');
    }
}

window.hidePromptModal = function() {
    const modal = document.getElementById('prompt-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// --- FUNCTIE: TEKST AUTOMATISCH PASSEND MAKEN ---
window.autoFitLabelText = function() {
    const titleEl = document.getElementById('prev-title');
    const container = document.getElementById('title-container');
    
    if (!titleEl || !container) return;

    // Reset naar een grote startwaarde
    let fontSize = 55; 
    titleEl.style.fontSize = fontSize + 'px';
    titleEl.style.lineHeight = '0.9'; // Iets strakker voor verticale tekst
    
    // Als de container niet zichtbaar is (tabblad dicht), stop
    if (container.offsetWidth === 0 || container.offsetHeight === 0) return;

    const maxWidth = container.offsetWidth;
    const maxHeight = container.offsetHeight;

    // Zolang de tekst groter is dan de container...
    // We gebruiken scrollWidth/Height omdat bij vertical-rl de dimensies draaien
    while (
        (titleEl.scrollWidth > maxWidth || titleEl.scrollHeight > maxHeight) 
        && fontSize > 14 // STOP NOOIT ONDER 14px!
    ) {
        fontSize--; 
        titleEl.style.fontSize = fontSize + 'px';
    }
    
    // Als de lus klaar is, staat de grootte goed.
    // Voor de zekerheid: als hij toch op 14px is geëindigd en het past nog steeds niet 100%,
    // dan is dat jammer, maar de tekst is tenminste zichtbaar.
}

function initApp() {
    // UI Elements Assignments
    const styleSelect = document.getElementById('style');
    const fruitSection = document.getElementById('fruit-section');
    const spiceSection = document.getElementById('spice-section');
    const braggotSection = document.getElementById('braggot-section');
    const inventoryForm = document.getElementById('inventory-form');
    
    // Firebase Init with CONFIG from secrets.js
    try {
        const app = initializeApp(CONFIG.firebase);
        db = getFirestore(app);
        auth = getAuth(app);

        document.getElementById('google-login-btn').addEventListener('click', signInWithGoogle);

        onAuthStateChanged(auth, async (user) => {
            const loginView = document.getElementById('login-view');
            const appContainer = document.querySelector('.container.mx-auto'); 

            if (user && !user.isAnonymous) {
                userId = user.uid;
                loginView.classList.add('hidden');
                if (appContainer) appContainer.classList.remove('hidden'); 

                try {
                    await Promise.all([
                        loadHistory(), loadInventory(), loadEquipmentProfiles(),
                        loadCellar(), loadUserSettings(), loadPackagingCosts(), loadUserWaterProfiles()
                    ]);
                } catch (error) {
                    console.error("Fout bij laden data:", error);
                    showToast("Kon niet alle gegevens laden.", "error");
                }
            } else {
                loginView.classList.remove('hidden');
                if (appContainer) appContainer.classList.add('hidden'); 
                if (user && user.isAnonymous) auth.signOut();
            }
        });
    } catch (e) {
        console.error("Firebase init failed:", e);
    }

    // --- GLOBAL EVENT LISTENERS ---
    document.getElementById('history-search-input')?.addEventListener('input', renderHistoryList);
    document.getElementById('packaging-add-form')?.addEventListener('submit', addPackagingStock);
    document.getElementById('danger-cancel-btn')?.addEventListener('click', hideDangerModal);
    document.getElementById('danger-confirm-btn')?.addEventListener('click', executeDangerAction);
    document.getElementById('danger-confirm-input')?.addEventListener('input', checkDangerConfirmation);
    document.getElementById('customDescription')?.addEventListener('input', handleDescriptionInput);
    document.getElementById('close-prompt-modal-btn')?.addEventListener('click', hidePromptModal);
    document.getElementById('water-profile-form')?.addEventListener('submit', saveWaterProfile);
    document.getElementById('waterSource')?.addEventListener('change', handleWaterSourceChange);
    document.getElementById('ai-water-search-btn')?.addEventListener('click', findWaterProfileWithAI);
    document.getElementById('honeyVariety')?.addEventListener('change', (e) => {
        document.getElementById('honeyVarietyOther').classList.toggle('hidden', e.target.value !== 'other');
    });
    
    // Style Change Handler
    styleSelect?.addEventListener('change', () => {
        const style = styleSelect.value.toLowerCase();
        fruitSection.classList.toggle('hidden', !style.includes('melomel'));
        spiceSection.classList.toggle('hidden', !style.includes('metheglin'));
        braggotSection.classList.toggle('hidden', !style.includes('braggot'));
        if (!style.includes('melomel')) document.querySelectorAll('#fruit-section input:checked').forEach(cb => cb.checked = false);
        if (!style.includes('metheglin')) document.querySelectorAll('#spice-section input:checked').forEach(cb => cb.checked = false);
    });

    document.getElementById('generateBtn')?.addEventListener('click', generateRecipe);
    inventoryForm?.addEventListener('submit', addInventoryItem);
    document.getElementById('equipment-profile-form')?.addEventListener('submit', addEquipmentProfile);
    document.getElementById('equipProfileType')?.addEventListener('change', handleEquipmentTypeChange);
    document.getElementById('bottling-form')?.addEventListener('submit', bottleBatch);
    document.getElementById('scan-barcode-btn')?.addEventListener('click', startScanner);
    document.getElementById('close-scanner-btn')?.addEventListener('click', stopScanner);
    
    // Inventory Toggles
    document.querySelectorAll('.inventory-toggle').forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            const anyChecked = Array.from(document.querySelectorAll('.inventory-toggle')).some(cb => cb.checked);
            document.getElementById('budget-section').classList.toggle('hidden', !anyChecked);
        });
    });
    document.getElementById('useBudget')?.addEventListener('change', (e) => {
        document.getElementById('budget-input-container').classList.toggle('hidden', !e.target.checked);
    });

    // Calculators & Tools
    document.getElementById('calcRefractBtn')?.addEventListener('click', calculateRefractometerCorrection);
    document.getElementById('calcAbvBtn')?.addEventListener('click', calculateABV);
    document.getElementById('correctSgBtn')?.addEventListener('click', correctHydrometer);
    document.getElementById('calcSugarBtn')?.addEventListener('click', calculatePrimingSugar);
    document.getElementById('calcBlendBtn')?.addEventListener('click', calculateBlend);
    document.getElementById('calcBacksweetenBtn')?.addEventListener('click', calculateBacksweetening);
    document.getElementById('calcDilutionBtn')?.addEventListener('click', calculateDilution);
    document.getElementById('calcTosnaBtn')?.addEventListener('click', calculateTOSNA);
    document.getElementById('getYeastAdviceBtn')?.addEventListener('click', getYeastAdvice);
    document.getElementById('generate-social-from-recipe-btn')?.addEventListener('click', runSocialMediaGenerator);
    document.getElementById('getWaterAdviceBtn')?.addEventListener('click', getWaterAdvice);
    document.getElementById('troubleshoot-btn')?.addEventListener('click', getTroubleshootingAdvice);

    // Settings & Data
    document.getElementById('saveSettingsBtn')?.addEventListener('click', saveUserSettings);
    document.getElementById('fetchModelsBtn')?.addEventListener('click', window.fetchAvailableModels);
    document.getElementById('theme-toggle-checkbox')?.addEventListener('change', (e) => applyTheme(e.target.checked ? 'dark' : 'light'));
    document.getElementById('exportHistoryBtn')?.addEventListener('click', exportHistory);
    document.getElementById('exportInventoryBtn')?.addEventListener('click', exportInventory);
    document.getElementById('importHistoryFile')?.addEventListener('change', (e) => importData(e, 'brews'));
    document.getElementById('importInventoryFile')?.addEventListener('change', (e) => importData(e, 'inventory'));
    document.getElementById('clearHistoryBtn')?.addEventListener('click', clearHistory);
    document.getElementById('clearInventoryBtn')?.addEventListener('click', clearInventory);

    // Labels (V2.0)
    initLabelForge();

    // Main Navigation
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

    // Prompt Modal close
    document.getElementById('prompt-modal')?.addEventListener('click', function(e) {
        if (e.target.id === 'prompt-modal') hidePromptModal();
    });

    // Start
    setupBrewDayEventListeners();
    // (Optioneel: handleStyleChange aanroep hier)
}

// --- APP START ---
// Dit is het enige startpunt van de applicatie
document.addEventListener('DOMContentLoaded', () => {
    console.log("🍀 MEA(N)DERY V2.0 Quadrifoglio Loaded.");
    initApp();
});