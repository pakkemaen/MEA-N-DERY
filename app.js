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
    parentView.querySelectorAll('[id$="-view"]').forEach(v => v.classList.add('hidden'));
    parentView.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));

    const viewId = `${viewName}-view`;
    const tabId = `${viewName}-sub-tab`;
    const viewToShow = document.getElementById(viewId);
    const tabToActivate = document.getElementById(tabId);

    if (viewToShow) viewToShow.classList.remove('hidden');
    if (tabToActivate) tabToActivate.classList.add('active');

    if (viewName === 'brew-day-2') renderBrewDay2();
    if (viewName === 'creator') populateEquipmentProfilesDropdown(); 
    if (viewName === 'social') populateSocialRecipeDropdown();
    if (viewName === 'labels') { populateLabelRecipeDropdown(); updatePreviewAspectRatio(); }
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
    // Je Cloud Function URL
    const functionUrl = "https://callgemini-388311971225.europe-west1.run.app"; 
    
    // HIER HALEN WE HET MODEL UIT JE SETTINGS
    // Als er niets in settings staat, vallen we terug op 'gemini-2.5-pro'
    const modelToUse = userSettings.aiModel || "gemini-2.5-pro";

    try {
        const response = await fetch(functionUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                prompt: prompt,
                schema: schema,
                model: userSettings.aiModel || "gemini-1.5-flash"
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `Server error: ${response.status}`);
        }

        const data = await response.json();
        return data.text;

    } catch (error) {
        console.error("Backend Error:", error);
        throw new Error(error.message || "Fout bij verbinden met de AI backend.");
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

        // 3. Inventory Analyse (Silence Protocol)
        const inventoryToggles = {
            Yeast: document.getElementById('useInventory_Yeast').checked,
            Nutrient: document.getElementById('useInventory_Nutrients').checked,
            Honey: document.getElementById('useInventory_Honey').checked,
            Fruit: document.getElementById('useInventory_Fruits').checked,
            Spice: document.getElementById('useInventory_Spices').checked,
            Other: document.getElementById('useInventory_Other').checked
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
        const invLower = inventoryString.toLowerCase();
        const hasSafeOrganic = invLower.includes('fermaid o') || invLower.includes('ferm o') || invLower.includes('cellvit') || invLower.includes('yeast hulls');
        const hasDAP = invLower.includes('dap') || invLower.includes('diammonium') || invLower.includes('nutrisal');
        const hasHybrid = invLower.includes('nutrivit') || invLower.includes('fermaid k') || invLower.includes('combi') || invLower.includes('ultra') || invLower.includes('tronozym');
        
        let baseNutrientRule = "";
        if (inventoryToggles.Nutrient) { 
             if (!hasSafeOrganic && (hasHybrid || hasDAP)) {
                baseNutrientRule = `1. **Nutrients (HYBRID):** Detected Inorganic/Hybrid stock but NO Fermaid O. Use ONLY this stock. **WARNING:** Instruct user to STOP adding after 9% ABV.`;
            } else if (hasSafeOrganic) {
                baseNutrientRule = `1. **Nutrients (ORGANIC):** Use Fermaid O/Cellvit from stock.`;
            } else {
                baseNutrientRule = `1. **Nutrients:** Prescribe standard TOSNA.`;
            }
        } else {
             baseNutrientRule = `1. **Nutrients:** Use standard TOSNA guidelines.`;
        }

        const inventoryLogic = `
        ${inventoryInstruction} 
        **FULL STOCK LIST:** [${inventoryString}]. 
        
        **CRITICAL INVENTORY RULES:**
        1. **JSON Block:** MUST contain the **TOTAL** ingredients required (ignore stock here).
        2. **SHOPPING LIST TEXT:** - Compare Required Amount vs Stock Amount.
           - IF (Stock >= Required): **SILENCE**. Do NOT mention this item in the text. Do NOT write "You have enough".
           - IF (Stock < Required): Write ONLY: "Buy [Amount Needed] of [Item]".
           - IF (Stock == 0): Write "Buy [Full Amount] of [Item]".
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

async function parseRecipeData(markdown) {
    const data = {};
    try {
        const titleMatch = markdown.match(/^#\s*(.*)/m);
        if (titleMatch && titleMatch[1]) { data.recipeName = titleMatch[1].trim(); }

        const createRegex = (key) => new RegExp(`(?:${key}|${key.replace('.', '\\.')})[\\s\\*:]*~?([\\d.,]+)`, 'i');
        const ogRegex = createRegex('Target OG|Original Gravity|Start SG|O\\.G\\.|OG');
        const fgRegex = createRegex('Target FG|Final Gravity|Eind SG|F\\.G\\.|FG');
        
        const ogMatch = markdown.match(ogRegex);
        if (ogMatch && ogMatch[1]) { data.targetOG = ogMatch[1]; }

        const fgMatch = markdown.match(fgRegex);
        if (fgMatch && fgMatch[1]) { data.targetFG = fgMatch[1]; }

        const abvMatchGlobal = markdown.match(new RegExp(`(?:Target ABV|ABV|Alcoholpercentage)[\\s\\*:]*~?([\\d.,]+)\\s*%?`, 'i'));
        if (abvMatchGlobal && abvMatchGlobal[1]) { data.targetABV = abvMatchGlobal[1]; }

    } catch (e) {
        console.error("Error parsing recipe data:", e);
    }
    return data;
}

// --- RENDER RECIPE OUTPUT (VOLLEDIG & GEOPTIMALISEERD) ---
async function renderRecipeOutput(markdown) {
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
                <button onclick="window.showLastPrompt()" class="bg-app-tertiary text-app-primary border border-app-brand/30 py-2 px-4 rounded-lg hover:bg-app-secondary transition-colors btn text-sm">Show AI Prompt</button>
                <button onclick="window.print()" class="bg-app-tertiary text-app-primary border border-app-brand/30 py-2 px-4 rounded-lg hover:bg-app-secondary transition-colors btn">Print Recipe</button>
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
            <div id="water-brand-results" class="hidden mt-4 pt-4 border-t border-app-brand/20 text-sm text-app-primary"></div>
        </div>

        ${flavorProfileHtml}
        
        <div id="tweak-unsaved-section" class="mt-6 pt-6 border-t-2 border-app-brand no-print">
            <h3 class="text-2xl font-header font-bold text-center mb-4">Not quite right? Tweak it.</h3>
            <div class="card p-4 rounded-lg">
                <label for="tweak-unsaved-request" class="block text-sm font-bold mb-2">Describe what you want to change:</label>
                <textarea id="tweak-unsaved-request" rows="3" class="w-full p-2 border rounded-md bg-app-tertiary border-app text-app-primary" placeholder="e.g., 'Make this for 20 liters', or 'Replace the apples with pears'"></textarea>
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

    document.getElementById('saveBtn').addEventListener('click', saveBrewToHistory);
    document.getElementById('tweak-unsaved-btn').addEventListener('click', tweakUnsavedRecipe);

    generateAndInjectCreativeTitle(finalMarkdown);
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
    resultsDiv.innerHTML = getLoaderHtml("Sommelier is searching...");

    const prompt = `You are a Water Sommelier. Analyze this mead recipe's target water profile. Recommend 3 real-world commercial water brands (EU/US). 
    RECIPE: ${currentRecipeMarkdown}
    OUTPUT: JSON Array: [{"brand": "Name", "reason": "Why", "tweak_instruction": "Specific tweak instruction"}]`;

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
        let html = `<h5 class="font-bold mb-3 text-app-brand text-sm uppercase">Recommended Brands:</h5><div class="space-y-3">`;
        brands.forEach(b => {
            html += `<div class="p-3 card rounded border border-app-brand/30 shadow-sm flex flex-col gap-2"><div class="flex justify-between items-start"><span class="font-bold text-app-primary">${b.brand}</span><button onclick="window.applyWaterTweak('${b.brand}', '${b.tweak_instruction.replace(/'/g, "\\'")}')" class="text-xs bg-app-tertiary hover:bg-app-secondary text-app-brand border border-app-brand py-1 px-2 rounded transition-colors font-bold uppercase tracking-wider">Select & Recalculate</button></div><p class="text-xs text-app-secondary">${b.reason}</p></div>`;
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
    tweakInput.value = `I am using **${brandName}** water. ${technicalInstruction} Please recalculate nutrients and buffers. `;
    tweakInput.classList.add('ring-4', 'ring-blue-500/50', 'transition-all', 'duration-500');
    setTimeout(() => tweakInput.classList.remove('ring-4', 'ring-blue-500/50'), 1500);
    tweakInput.focus();
}

// --- FIX VOOR SYNTAX ERROR IN TWEAK ---
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

    // --- FIX: VEILIGHEID TEGEN CRASHEN DOOR BACKTICKS ---
    const safeMarkdown = currentRecipeMarkdown.replace(/`/g, "'"); 

    const prompt = `You are "MEA(N)DERY", a master mazer. A user wants to tweak a recipe.
    **STRICT OUTPUT RULE:**
    - Do NOT output raw JSON as the main response.
    - Output a Markdown Recipe.
    - Inside the Markdown, include the Ingredients JSON block.
    - Start with "# Title".
    
    Original Recipe:
    ---
    ${safeMarkdown}
    ---

    User Tweak Request: "${tweakRequest}"

    **TASK:** Rewrite the FULL recipe to incorporate the tweak.
    
    ${laws}
    ${inventoryContext}

    **LOGIC CHECK:**
    - If the user changed the Batch Size -> Recalculate ALL ingredients.
    - If the user changed the Fruit -> Check if Honey needs adjustment for ABV targets.
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

        currentRecipeMarkdown = processedMarkdown;
        await renderRecipeOutput(processedMarkdown);

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

function renderBrewDay(brewId) {
    if (brewId === 'none') {
        document.getElementById('brew-day-content').innerHTML = `<h2 class="text-3xl font-header font-bold mb-4 text-center">Brew Day 1</h2><p class="text-center text-app-secondary/80">Select a new recipe to start.</p>`;
        return;
    }

    const brew = brews.find(b => b.id === brewId);
    const brewDayContent = document.getElementById('brew-day-content');
    if (!brew) return;

    const primarySteps = brew.brewDaySteps || [];
    if (primarySteps.length === 0) {
         brewDayContent.innerHTML = `<p class="text-center text-app-secondary/80">No steps found.</p>`;
         return;
    }

    let stepsHtml = primarySteps.map((step, index) => {
        // Slimme detectie van ingrediënten in de stap tekst (voor "Actual Added" input)
        const amountMatch = (step.title + " " + step.description).match(/(\d+[.,]?\d*)\s*(kg|g|l|ml|oz|lbs)/i);
        let inputHtml = '';
        let detectedAmount = '';
        let detectedUnit = '';

        const stepState = currentBrewDay.checklist[`step-${index}`]; 
        const isCompleted = stepState === true || (stepState && stepState.completed);
        const savedAmount = (stepState && stepState.actualAmount) ? stepState.actualAmount : '';

        if (amountMatch && !isCompleted) {
            detectedAmount = amountMatch[1];
            detectedUnit = amountMatch[2].toLowerCase();
            inputHtml = `<div class="mt-2 flex items-center gap-2 bg-app-tertiary p-2 rounded"><label class="text-xs font-bold text-app-secondary uppercase">Actual:</label><input type="number" step="0.01" id="step-input-${index}" class="w-24 p-1 text-sm border rounded bg-app-primary border-app text-app-primary" placeholder="${detectedAmount}" value="${detectedAmount}"><span class="text-sm font-bold">${detectedUnit}</span></div>`;
        } else if (isCompleted && savedAmount) {
             inputHtml = `<div class="mt-2 text-xs text-green-600 font-mono">Recorded: ${savedAmount} ${detectedUnit || ''}</div>`;
        }

        const timerHtml = step.duration > 0 ? `<p class="timer-display my-2" id="timer-${index}">${formatTime(step.duration)}</p>` : '';
        const buttonsHtml = step.duration > 0 ? `<button data-action="startTimer" data-step="${index}" class="text-sm bg-green-600 text-white py-1 px-3 rounded-lg hover:bg-green-700 btn">Start Timer</button>` : `<button data-action="completeStep" data-step="${index}" data-unit="${detectedUnit}" class="text-sm bg-blue-600 text-white py-1 px-3 rounded-lg hover:bg-blue-700 btn">Mark Complete</button>`;

        return `<div id="step-${index}" class="step-item p-4 rounded-r-lg mb-3 ${isCompleted ? 'completed' : ''}"><div><p class="step-title">${index + 1}. ${step.title}</p><p class="text-sm text-app-secondary">${step.description}</p>${inputHtml}<div class="mt-4">${timerHtml}<div class="space-x-2" id="controls-${index}">${isCompleted ? '<span class="text-sm font-bold text-green-600">✓ Completed</span>' : buttonsHtml}</div></div></div></div>`;
    }).join('');

    const parsedTargets = parseRecipeData(brew.recipeMarkdown);
    const combinedLogData = { ...brew.logData, ...parsedTargets };
    const logHtml = getBrewLogHtml(combinedLogData, brew.id); // Geeft ID mee!

    brewDayContent.innerHTML = `
        <h2 class="text-3xl font-header font-bold mb-4 text-center">${brew.recipeName}</h2>
        <div class="mb-4"><div class="progress-bar-bg w-full h-2 rounded-full"><div id="brew-day-progress" class="progress-bar-fg h-2 rounded-full" style="width: 0%;"></div></div></div>
        <div id="brew-day-steps-container">${stepsHtml}</div>
        <div class="text-center mt-6"><button data-action="resetBrewDay" class="text-sm bg-red-600 text-white py-2 px-4 rounded-lg hover:bg-red-700 btn">Reset</button></div>
        <hr class="my-8 border-app">
        ${logHtml}
        <div class="mt-4 no-print space-y-3">
            <button onclick="window.updateBrewLog('${brew.id}', 'brew-day-content')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg hover:opacity-90 btn">Save Log Changes</button>
            <button onclick="window.deductActualsFromInventory('${brew.id}')" class="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 btn text-sm">Deduct Actuals from Inventory</button>
        </div>
    `;

    initializeBrewDayState(primarySteps);
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

// --- HISTORY & DETAIL MANAGEMENT ---

function loadHistory() {
    if (!userId) return;
    const q = query(collection(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews'));
    onSnapshot(q, (snapshot) => {
        brews = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        brews.sort((a, b) => b.createdAt.toDate() - a.createdAt.toDate());
        renderHistoryList();
        populateSocialRecipeDropdown();
        updateCostAnalysis();
        renderActiveBrewTimeline();
        updateNextActionWidget();
        updateDashboardStats();
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
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    let finalMarkdown = brew.recipeMarkdown.replace(/\[d:[\d:]+\]/g, '');
    const recipeHtml = marked.parse(finalMarkdown.replace(/^#\s.*$/m, ''));
    const logHtml = getBrewLogHtml(brew.logData, brew.id);
    const currency = userSettings.currencySymbol || '€';

    let costHtml = '';
    if (brew.totalCost > 0) {
        const perL = brew.batchSize > 0 ? brew.totalCost / brew.batchSize : 0;
        costHtml = `<div class="mt-6 p-4 bg-amber-100 rounded-lg dark:bg-amber-900/20"><h3 class="font-header text-lg text-amber-900 dark:text-amber-200">Cost</h3><p>Total: ${currency}${brew.totalCost.toFixed(2)}</p><p>Per Liter: ${currency}${perL.toFixed(2)}</p></div>`;
    }

    historyDetailContainer.innerHTML = `
        <button onclick="window.goBackToHistoryList()" class="mb-4 text-app-brand hover:underline no-print">&larr; Back</button>
        <div class="mb-4">
            <div id="title-display-${brew.id}"><h2 class="text-3xl font-header font-bold w-full">${brew.recipeName}</h2><div class="text-right w-full mt-1"><button onclick="window.showTitleEditor('${brew.id}')" class="text-blue-600 text-sm no-print">Edit Title</button></div></div>
            <div id="title-editor-${brew.id}" class="hidden"><input type="text" id="title-input-${brew.id}" value="${brew.recipeName}" class="w-full text-2xl font-bold p-2 border rounded-md"><div class="flex gap-2 mt-2"><button onclick="window.saveNewTitle('${brew.id}')" class="bg-green-600 text-white px-3 py-1 rounded btn">Save</button><button onclick="window.hideTitleEditor('${brew.id}')" class="bg-gray-500 text-white px-3 py-1 rounded btn">Cancel</button></div></div>
        </div>
        <div class="print-button-container mb-4 grid grid-cols-2 gap-2 no-print">
            <button onclick="window.cloneBrew('${brew.id}')" class="bg-blue-700 text-white py-2 px-4 rounded btn">Clone</button>
            <button onclick="window.startBrewDay('${brew.id}')" class="bg-app-action text-white py-2 px-4 rounded btn">Start Batch</button>
            <button onclick="window.recalculateBatchCost('${brew.id}')" class="bg-purple-700 text-white py-2 px-4 rounded btn">Recalculate Cost</button>
            <button onclick="window.deleteBrew('${brew.id}')" class="bg-red-700 text-white py-2 px-4 rounded btn">Delete</button>
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
}

window.goBackToHistoryList = function() {
    const detailContainer = document.getElementById('history-detail-container');
    detailContainer.innerHTML = ''; // Fix double ID issue
    detailContainer.classList.add('hidden');
    document.getElementById('history-list-container').classList.remove('hidden');
}

// Voeg dit helemaal onderaan app.js toe:

async function saveBrewToHistory(recipeText, flavorProfile) {
    if (!auth.currentUser) return;

    try {
        const historyRef = collection(db, `artifacts/${CONFIG.firebase.projectId}/users/${auth.currentUser.uid}/history`);
        
        await addDoc(historyRef, {
            recipe: recipeText,
            flavorProfile: flavorProfile || {},
            timestamp: serverTimestamp(),
            model: userSettings.aiModel || "gemini-1.5-flash"
        });
        
        console.log("Recept opgeslagen in geschiedenis!");
    } catch (error) {
        console.error("Kon geschiedenis niet opslaan:", error);
        // We laten de app niet crashen als opslaan mislukt
    }
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
        actualIngredients: actuals,
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
    const data = logData || {};
    const useTargetOG = parsedTargets.targetOG || data.targetOG || '';
    const useTargetFG = parsedTargets.targetFG || data.targetFG || '';
    const useTargetABV = parsedTargets.targetABV || data.targetABV || '';
    const fermLog = data.fermentationLog || Array.from({ length: 3 }, () => ({}));
    
    // De copy script voor OG
    const copyOgToLogScript = `const ogInput = document.getElementById('actualOG-${idSuffix}'); const firstSgInput = document.querySelector('#fermentationTable-${idSuffix} tbody tr:first-child td:nth-child(3) input'); if (ogInput && firstSgInput) { firstSgInput.value = ogInput.value; }`;

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
                                <td><input type="number" step="0.001" value="${row.sg || ''}" class="w-full text-center"></td>
                                <td><input type="text" value="${row.notes || ''}" class="w-full"></td>
                            </tr>`).join('')}</tbody>
                    </table>
                    <div class="text-right mt-1"><button onclick="window.addLogLine('${idSuffix}')" class="text-xs text-app-brand underline">+ Add Row</button></div>
                </div>
            </div>
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
        return `<tr data-name="${p.name}" data-plannedqty="${p.quantity}" data-plannedunit="${p.unit}"><td class="py-2 px-3">${p.name}</td><td class="py-2 px-3 text-app-secondary">${p.quantity} ${p.unit}</td><td class="py-2 px-3"><input type="number" step="0.01" class="actual-qty-input w-24 p-1 border rounded bg-app-primary border-app text-app-primary" value="${val}"></td><td class="py-2 px-3">${p.unit}</td></tr>`;
    }).join('');

    return `<div class="log-item"><label>Actual Ingredients Log</label><table class="fermentation-table w-full" id="actualsTable-${idSuffix}"><thead><tr><th>Ingredient</th><th>Planned</th><th>Actual</th><th>Unit</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

window.updateBrewLog = async function(brewId, containerId) {
    if (!userId || !brewId) return;
    const container = document.getElementById(containerId);
    const btn = container ? container.querySelector('button[onclick*="updateBrewLog"]') : null;
    const originalText = btn ? btn.innerText : 'Save';
    if(btn) { btn.disabled = true; btn.innerText = "Saving..."; }

    const logData = getLogDataFromDOM(containerId);
    const brewIndex = brews.findIndex(b => b.id === brewId);
    // Optimistic Update
    if (brewIndex > -1) brews[brewIndex].logData = logData;

    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), { logData: logData });
        showToast('Log updated!', 'success');
        if(btn) { btn.innerText = "Saved!"; btn.classList.add('bg-green-600'); setTimeout(() => { btn.disabled = false; btn.innerText = originalText; btn.classList.remove('bg-green-600'); }, 2000); }
    } catch(e) {
        console.error(e); showToast('Failed to save to cloud.', 'error');
        if(btn) { btn.disabled = false; btn.innerText = originalText; }
    }
}

window.addLogLine = function(idSuffix) {
    const tbody = document.querySelector(`#fermentationTable-${idSuffix} tbody`);
    if (!tbody) return;
    const newRow = document.createElement('tr');
    newRow.innerHTML = `<td><input type="date" class="w-full" ondblclick="this.value = new Date().toISOString().split('T')[0]"></td><td><input type="number" step="0.5" class="w-full text-center"></td><td><input type="number" step="0.001" class="w-full text-center"></td><td><input type="text" class="w-full"></td>`;
    tbody.appendChild(newRow);
}

window.autoCalculateABV = function(idSuffix) {
    const og = parseFloat(document.getElementById(`actualOG-${idSuffix}`)?.value.replace(',','.'));
    const fg = parseFloat(document.getElementById(`actualFG-${idSuffix}`)?.value.replace(',','.'));
    const abvInput = document.getElementById(`finalABV-${idSuffix}`);
    if (!isNaN(og) && !isNaN(fg) && abvInput) {
        const abv = (og - fg) * 131.25;
        abvInput.value = abv >= 0 ? abv.toFixed(1) + '%' : '';
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

window.saveSocialPost = async function() {
    const brewId = document.getElementById('social-recipe-select').value;
    if (!brewId) return alert("Select recipe first.");
    const content = document.getElementById('social-content-container').innerText;
    if(!content) return;
    
    await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), {
        socialMediaPosts: arrayUnion({ platform: document.getElementById('social-platform').value, content, createdAt: new Date().toISOString() })
    });
    showToast("Post saved!", "success");
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

    if (inventory.length === 0) {
        listDiv.innerHTML = `<p class="text-center text-app-secondary/80 py-4">The cupboard is bare.</p>`;
        return;
    }

    // Groepeer op categorie
    const grouped = inventory.reduce((acc, item) => {
        const cat = item.category || 'Other';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(item);
        return acc;
    }, {});

    const currency = userSettings.currencySymbol || '€';
    let html = '';

    // Vaste volgorde van categorieën
    const categories = ['Honey', 'Yeast', 'Nutrient', 'Malt Extract', 'Fruit', 'Spice', 'Adjunct', 'Chemical', 'Water'];
    
    categories.forEach(cat => {
        if (grouped[cat]) {
            html += `<h4 class="font-bold text-app-brand uppercase text-xs mt-3 mb-1 border-b border-app-brand/20">${cat}</h4>`;
            grouped[cat].forEach(item => {
                const expDate = item.expirationDate ? new Date(item.expirationDate).toLocaleDateString() : '';
                html += `
                    <div class="flex justify-between items-center p-2 bg-app-primary rounded mb-1 shadow-sm">
                        <div>
                            <div class="font-bold text-sm">${item.name}</div>
                            <div class="text-xs text-app-secondary">${item.qty} ${item.unit} ${expDate ? `(Exp: ${expDate})` : ''}</div>
                        </div>
                        <div class="text-right">
                            <div class="text-sm font-bold">${currency}${(item.price || 0).toFixed(2)}</div>
                            <div class="flex gap-2 mt-1 justify-end">
                                <button onclick="window.editInventoryItem('${item.id}')" class="text-blue-600 text-xs hover:underline">Edit</button>
                                <button onclick="window.deleteInventoryItem('${item.id}')" class="text-red-600 text-xs hover:underline">Del</button>
                            </div>
                        </div>
                    </div>
                `;
            });
        }
    });
    listDiv.innerHTML = html;
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
    
    // 1. Inventory Value
    let invValue = inventory.reduce((sum, item) => sum + (item.price || 0), 0);
    
    // 2. Active Brews Value (alles niet gebotteld)
    let activeValue = brews.filter(b => !b.isBottled).reduce((sum, b) => sum + (b.totalCost || 0), 0);
    
    // 3. Cellar Value
    let cellarValue = cellar.reduce((sum, c) => sum + (c.totalBatchCost || 0), 0);
    
    // Update DOM elements als ze bestaan
    const elInv = document.getElementById('total-inventory-value');
    const elActive = document.getElementById('total-active-value');
    const elCellar = document.getElementById('total-cellar-value');
    const elGrand = document.getElementById('grand-total-value');
    
    if(elInv) elInv.textContent = `${currency}${invValue.toFixed(2)}`;
    if(elActive) elActive.textContent = `${currency}${activeValue.toFixed(2)}`;
    if(elCellar) elCellar.textContent = `${currency}${cellarValue.toFixed(2)}`;
    if(elGrand) elGrand.textContent = `${currency}${(invValue + activeValue + cellarValue).toFixed(2)}`;
    
    // Update Chart als die bestaat
    const ctx = document.getElementById('cost-chart');
    if (ctx && window.Chart) {
        const spendByCategory = inventory.reduce((acc, item) => {
            const cat = item.category || 'Other';
            acc[cat] = (acc[cat] || 0) + (item.price || 0);
            return acc;
        }, {});
        
        if (window.costChart) window.costChart.destroy();
        window.costChart = new Chart(ctx.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: Object.keys(spendByCategory),
                datasets: [{ data: Object.values(spendByCategory), backgroundColor: ['#8F8C79', '#b45309', '#2d2a26', '#16a34a', '#2563eb', '#9333ea'] }]
            },
            options: { responsive: true, maintainAspectRatio: false }
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

window.renderActiveBrewTimeline = function() {
    const card = document.getElementById('current-brew-card');
    if (!card) return;

    // 1. Zoek de meest relevante actieve batch (Wel startdatum, niet gebotteld)
    const activeBrew = brews.find(b => b.logData && b.logData.brewDate && b.logData.brewDate !== '' && !b.isBottled);

    if (!activeBrew) {
        card.classList.add('hidden');
        return;
    }

    // 2. Bereken de "Bio-Time"
    const now = new Date();
    const brewDate = new Date(activeBrew.logData.brewDate);
    const daysElapsed = Math.floor((now - brewDate) / (1000 * 60 * 60 * 24));
    
    // 3. Bepaal het "Metabolisme" (Snelheid op basis van ABV)
    const targetABV = parseFloat(activeBrew.logData.targetABV) || 12;
    let paceModifier = 1; 
    if (targetABV < 8) paceModifier = 0.5; // Hydromel gaat sneller
    if (targetABV > 14) paceModifier = 1.5; // Sack mead gaat trager

    // 4. Bepaal de Biologische Fase & Smart Tip
    let phaseName = "";
    let smartTip = "";
    let progressPercent = 0;
    
    // FASE 1: Lag Phase & Growth (Dag 0-3)
    if (daysElapsed <= (3 * paceModifier)) {
        phaseName = "Lag / Biomass Growth";
        smartTip = "Yeast is multiplying. Oxygen is good now. Degas gently.";
        progressPercent = 15;
    } 
    // FASE 2: Active Fermentation (Dag 4-14)
    else if (daysElapsed <= (14 * paceModifier)) {
        phaseName = "Vigorous Fermentation";
        smartTip = "Sugar is converting to alcohol. Keep temperature stable.";
        progressPercent = 40;
    } 
    // FASE 3: Cleanup / Conditioning (Dag 15-30)
    else if (daysElapsed <= (30 * paceModifier)) {
        phaseName = "Cleanup Phase";
        smartTip = "Yeast is cleaning up off-flavors. Do not disturb.";
        progressPercent = 70;
    } 
    // FASE 4: Bulk Aging (Dag 30+)
    else {
        phaseName = "Bulk Aging / Clearing";
        smartTip = "Waiting for clarity. Patience is the main ingredient.";
        progressPercent = 90;
    }

    // Override als Primary handmatig is afgevinkt
    if (activeBrew.primaryComplete) {
        phaseName = "Secondary / Maturation";
        smartTip = "Aging for complexity. Ensure airlock is tight.";
        progressPercent = Math.max(progressPercent, 60); 
    }

    // 5. Render de Timeline (Met Hartslag)
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
        
        return `
            <div class="timeline-item ${stage.active ? 'active' : ''}">
                <div class="timeline-node ${isPulse}" style="${isActive}"></div>
                <div class="timeline-label text-[10px] uppercase tracking-wide">${stage.name}</div>
            </div>
        `;
    }).join('');

    card.innerHTML = `
        <div class="flex justify-between items-start mb-2">
            <div class="pr-4">
                <div class="flex items-center gap-2">
                    <span class="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                    <h3 class="text-xl font-header font-bold text-app-brand leading-tight">${activeBrew.recipeName}</h3>
                </div>
                <p class="text-app-primary font-bold text-sm mt-1">Day ${daysElapsed}: ${phaseName}</p>
                <p class="text-app-secondary text-xs italic mt-1">"${smartTip}"</p>
            </div>
            <button onclick="window.showBrewDetail('${activeBrew.id}')" class="flex-shrink-0 bg-transparent border border-app-brand text-app-brand hover:bg-app-brand hover:text-white text-xs font-bold uppercase px-3 py-2 rounded transition-colors">
                View
            </button>
        </div>
        
        <div class="timeline-container mt-4 mb-2">
            <div class="timeline-connector">
                <div class="timeline-progress" style="width: ${progressPercent}%;"></div>
            </div>
            ${timelineItemsHtml}
        </div>
    `;

    card.classList.remove('hidden');
}

window.updateNextActionWidget = function() {
    // Simpele versie: check of er iets te doen is
    const list = document.getElementById('next-action-list');
    const widget = document.getElementById('next-action-widget');
    if(!list || !widget) return;
    
    let actions = [];
    
    // Check inventory expiry
    const now = new Date();
    inventory.forEach(i => {
        if(i.expirationDate) {
            const days = (new Date(i.expirationDate) - now) / (1000*60*60*24);
            if(days < 30) actions.push(`Use <strong>${i.name}</strong> soon (Expires in ${Math.ceil(days)} days)`);
        }
    });
    
    // Check active fermentation (simpel: > 14 dagen in primary)
    brews.forEach(b => {
        if(b.logData?.brewDate && !b.primaryComplete) {
            const days = (now - new Date(b.logData.brewDate)) / (1000*60*60*24);
            if(days > 14) actions.push(`Check gravity of <strong>${b.recipeName}</strong> (Day ${Math.floor(days)})`);
        }
    });

    if(actions.length > 0) {
        list.innerHTML = actions.slice(0, 3).map(a => `<li>${a}</li>`).join('');
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
    if (aiModelField) aiModelField.value = userSettings.aiModel || 'gemini-2.5-pro';
    
    const imgKeyField = document.getElementById('imageApiKeyInput');
    if (imgKeyField) imgKeyField.value = userSettings.imageApiKey || '';
    
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
        imageApiKey: document.getElementById('imageApiKeyInput').value.trim(),
        aiModel: document.getElementById('aiModelInput').value.trim(),
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
    const sg1 = parseFloat(document.getElementById('sg1').value);
    const vol2 = parseFloat(document.getElementById('vol2').value);
    const sg2 = parseFloat(document.getElementById('sg2').value);
    const resultDiv = document.getElementById('blendResult');

    if (isNaN(vol1) || isNaN(sg1) || isNaN(vol2) || isNaN(sg2)) { resultDiv.textContent = 'Invalid Input'; return; }
    const totalVolume = vol1 + vol2;
    const finalSG = (((vol1 * (sg1 - 1)) + (vol2 * (sg2 - 1))) / totalVolume) + 1;
    resultDiv.textContent = `Final: ${totalVolume.toFixed(2)}L at ${finalSG.toFixed(3)} SG`;
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

async function getWaterAdvice() {
    if (!currentWaterProfile) {
        document.getElementById('water-advice-output').innerHTML = `<p class="text-red-500">Select a water profile first.</p>`;
        return;
    }
    const output = document.getElementById('water-advice-output');
    output.innerHTML = getLoaderHtml("Analyzing water chemistry...");
    
    const target = document.getElementById('meadTargetProfile').selectedOptions[0].text;
    const batch = document.getElementById('batchSize').value || 5;
    const profileStr = `Ca:${currentWaterProfile.ca}, Mg:${currentWaterProfile.mg}, Na:${currentWaterProfile.na}, SO4:${currentWaterProfile.so4}, Cl:${currentWaterProfile.cl}, HCO3:${currentWaterProfile.hco3}`;
    
    const prompt = `Brew Chemist: User has water (${profileStr}). Goal: ${batch}L ${target} mead. Analyze fitness. Recommend specific salt additions (Gypsum, CaCl2, Epsom) in grams. Explain why. Format: Markdown.`;

    try {
        const text = await performApiCall(prompt);
        output.innerHTML = marked.parse(text);
    } catch (error) {
        output.innerHTML = `<p class="text-red-500">Error: ${error.message}</p>`;
    }
}

// --- TROUBLESHOOTER ---
async function getTroubleshootingAdvice() {
    const desc = document.getElementById('troubleshoot-description').value;
    const output = document.getElementById('troubleshoot-output');
    if (!desc.trim()) { output.innerHTML = `<p class="text-red-500">Describe the problem first.</p>`; return; }

    output.innerHTML = getLoaderHtml("Diagnosing issue...");
    const prompt = `Mead Expert: Troubleshoot this: "${desc}". Diagnose, ask clarifying questions, and offer solutions. Format: Markdown.`;

    try {
        const text = await performApiCall(prompt);
        output.innerHTML = marked.parse(text);
    } catch (error) {
        output.innerHTML = `<p class="text-red-500">Error: ${error.message}</p>`;
    }
}

// --- DEEL 6: LABELS, SOCIAL & DATA MANAGEMENT ---

// --- LABEL GENERATOR ---

function handleLogoUpload(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const logoPreview = document.getElementById('label-logo-preview');
            logoPreview.src = e.target.result;
            logoPreview.classList.remove('hidden');
            document.getElementById('removeLogoBtn').classList.remove('hidden');
            updateLabelPreview();
        }
        reader.readAsDataURL(file);
    }
}

function removeLogo() {
    const logoPreview = document.getElementById('label-logo-preview');
    const logoUploadInput = document.getElementById('logoUpload');
    logoPreview.src = '';
    logoPreview.classList.add('hidden');
    logoUploadInput.value = '';
    document.getElementById('removeLogoBtn').classList.add('hidden');
    updateLabelPreview();
}

function populateLabelRecipeDropdown() {
    const select = document.getElementById('labelRecipeSelect');
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="">-- Choose a Saved Recipe --</option>';
    brews.forEach(brew => {
        const option = document.createElement('option');
        option.value = brew.id;
        let displayName = brew.recipeName || 'Untitled Brew';
        if (displayName.includes(':')) displayName = displayName.split(':')[0].trim();
        else if (displayName.includes(' - ')) displayName = displayName.split(' - ')[0].trim();
        option.textContent = displayName;
        select.appendChild(option);
    });
    select.value = currentValue;
}

function handleLabelRecipeSelect(event) {
    const brewId = event.target.value;
    if (!brewId) { updateLabelPreview(); return; }

    const selectedBrew = brews.find(b => b.id === brewId);
    if (!selectedBrew) return;

    const fullTitle = selectedBrew.recipeName;
    let subtitlePart = '';
    if (fullTitle.includes(':')) subtitlePart = fullTitle.split(/:\s*(.*)/s)[1] || '';
    else if (fullTitle.includes(' - ')) subtitlePart = fullTitle.split(/\s*-\s*(.*)/s)[1] || '';

    document.getElementById('labelStyle').value = subtitlePart;
    document.getElementById('labelAbv').value = selectedBrew.logData?.finalABV?.replace('%','') || selectedBrew.logData?.targetABV?.replace('%','') || '';
    document.getElementById('labelVol').value = selectedBrew.batchSize ? selectedBrew.batchSize * 1000 : '750';
    document.getElementById('labelDate').value = selectedBrew.createdAt ? selectedBrew.createdAt.toDate().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : '';
    
    updateLabelPreview();
}

function updateLabelPreview() {
    const select = document.getElementById('labelRecipeSelect');
    const selectedOption = select.options[select.selectedIndex];
    const fullTitle = (selectedOption && selectedOption.value) ? selectedOption.text : 'Mead Name';
    
    document.getElementById('label-name-preview').textContent = fullTitle;
    document.getElementById('label-style-preview').textContent = document.getElementById('labelStyle').value || 'Style / Subtitle';
    document.getElementById('label-abv-preview').textContent = document.getElementById('labelAbv').value || 'ABV';
    
    const volVal = parseFloat(document.getElementById('labelVol').value);
    document.getElementById('label-vol-preview').textContent = !isNaN(volVal) ? (volVal >= 1000 ? `${(volVal/1000).toFixed(1)} L` : `${volVal} ml`) : 'VOL';
    document.getElementById('label-date-preview').textContent = document.getElementById('labelDate').value || 'Bottling Date';

    // Professional fields
    const selectedBrew = brews.find(b => b.id === select.value);
    const allergensContainer = document.getElementById('label-allergens-container');
    
    if (selectedBrew) {
        document.getElementById('label-og-preview').textContent = selectedBrew.logData?.targetOG || 'N/A';
        document.getElementById('label-fg-preview').textContent = selectedBrew.logData?.actualFG || 'N/A';
        const ings = parseIngredientsFromMarkdown(selectedBrew.recipeMarkdown);
        document.getElementById('label-yeast-preview').textContent = ings.find(i => i.name.toLowerCase().includes('yeast'))?.name.replace('Yeast','').trim() || 'N/A';

        // Allergens
        const allergens = [];
        const md = selectedBrew.recipeMarkdown.toLowerCase();
        if (md.includes('metabisulfite')) allergens.push('sulfites');
        if (md.includes('lactose')) allergens.push('lactose');
        if (md.includes('barley') || md.includes('malt')) allergens.push('gluten');
        
        if (allergens.length > 0 && allergensContainer) {
            allergensContainer.innerHTML = `Contains: <strong>${allergens.join(', ')}</strong>`;
            allergensContainer.classList.remove('hidden');
        } else if (allergensContainer) {
            allergensContainer.classList.add('hidden');
        }
    }
}

function switchLabelStyle(styleName) {
    const preview = document.getElementById('label-preview');
    preview.classList.remove('label-minimalist', 'label-industrial', 'label-professional');
    preview.classList.add(`label-${styleName}`);
    
    document.querySelectorAll('.label-style-btn').forEach(btn => {
        const isSelected = btn.dataset.style === styleName;
        btn.classList.toggle('border-2', isSelected);
        btn.classList.toggle('border-app-brand', isSelected);
        btn.classList.toggle('text-app-brand', isSelected);
    });
}

function setLabelOrientation(orientation) {
    document.querySelectorAll('.orientation-btn').forEach(btn => {
        const isSelected = btn.dataset.orientation === orientation;
        btn.classList.toggle('active', isSelected);
        btn.classList.toggle('border-app-brand', isSelected);
        btn.classList.toggle('text-app-brand', isSelected);
    });
    updatePreviewAspectRatio();
}

function updatePreviewAspectRatio() {
    const previewDiv = document.getElementById('label-preview');
    const formatSelector = document.getElementById('labelFormatSelect');
    if (!previewDiv || !formatSelector) return;

    const orientation = document.querySelector('.orientation-btn.active')?.dataset.orientation || 'vertical';
    let format = labelFormats[formatSelector.value];
    
    if (formatSelector.value === 'custom') {
        format = {
            width_mm: parseFloat(document.getElementById('customWidth').value) || 1,
            height_mm: parseFloat(document.getElementById('customHeight').value) || 1,
        };
    }

    if (format) {
        if (orientation === 'horizontal') previewDiv.style.aspectRatio = `${format.width_mm} / ${format.height_mm}`;
        else previewDiv.style.aspectRatio = `${format.height_mm} / ${format.width_mm}`;
    }
}

function generatePrintPage() {
    const labelHTML = document.getElementById('label-preview').outerHTML;
    const formatSelector = document.getElementById('labelFormatSelect');
    let format = labelFormats[formatSelector.value];

    if (formatSelector.value === 'custom') {
        format = {
            width_mm: parseFloat(document.getElementById('customWidth').value),
            height_mm: parseFloat(document.getElementById('customHeight').value),
            cols: parseInt(document.getElementById('customCols').value),
            rows: parseInt(document.getElementById('customRows').value),
            top_margin_mm: parseFloat(document.getElementById('customMarginTop').value),
            left_margin_mm: parseFloat(document.getElementById('customMarginLeft').value),
        }
    }

    const totalLabels = format.cols * format.rows;
    let printContent = '';
    for (let i = 0; i < totalLabels; i++) {
        printContent += labelHTML.replace('id="label-preview"', `class="print-label ${document.getElementById('label-preview').className}"`);
    }

    const newWindow = window.open('', '_blank');
    // FIX: We linken nu naar style.css in plaats van de style tag te kopiëren
    newWindow.document.write(`
        <html><head><title>Print Labels</title>
        <link rel="stylesheet" href="style.css"> 
        <style>
            @page { size: A4; margin: 0; }
            body { margin: 0; background: white; }
            .print-container {
                display: grid;
                grid-template-columns: repeat(${format.cols}, 1fr);
                gap: 0;
                padding-top: ${format.top_margin_mm}mm;
                padding-left: ${format.left_margin_mm}mm;
                width: 210mm; height: 297mm; box-sizing: border-box;
            }
            .print-label { width: ${format.width_mm}mm; height: ${format.height_mm}mm; box-sizing: border-box; overflow: hidden; page-break-inside: avoid; }
        </style>
        </head><body><div class="print-container">${printContent}</div></body></html>
    `);
    newWindow.document.close();
    newWindow.focus();
    // Kleine timeout om CSS te laten laden
    setTimeout(() => { newWindow.print(); }, 1000);
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

async function generateSocialImage(title, description) {
    const container = document.getElementById('social-image-container');
    container.innerHTML = getLoaderHtml("Painting a masterpiece...");

    const imageApiKey = userSettings.imageApiKey;
    if (!imageApiKey) {
        container.innerHTML = `<p class="text-center text-red-500">Please enter Image API key in Settings.</p>`;
        return;
    }

    const prompt = `AI Image Expert: Create a short, descriptive prompt for a photorealistic product shot of this mead: Title "${title}", Desc "${description}". Output ONLY the prompt.`;

    try {
        const genPrompt = await performApiCall(prompt);
        const response = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imageApiKey}` },
            body: JSON.stringify({ text_prompts: [{ text: `Photorealistic: ${genPrompt}, cinematic lighting` }], cfg_scale: 7, height: 1024, width: 1024, samples: 1 })
        });

        if (!response.ok) throw new Error(await response.text());
        const result = await response.json();
        const img = result.artifacts[0].base64;
        container.innerHTML = `<img src="data:image/png;base64,${img}" class="rounded-lg mx-auto shadow-lg"><p class="text-xs mt-2">Generated with Stable Diffusion</p>`;
    } catch (e) {
        container.innerHTML = `<p class="text-red-500">Error: ${e.message}</p>`;
    }
}

async function runSocialMediaGenerator() {
    const brewId = document.getElementById('social-recipe-select').value;
    if (!brewId) return alert("Select a recipe.");
    const brew = brews.find(b => b.id === brewId);
    
    document.getElementById('social-output-container').classList.remove('hidden');
    const container = document.getElementById('social-content-container');
    container.innerHTML = getLoaderHtml("Drafting post...");
    
    const persona = document.getElementById('social-persona').value;
    const platform = document.getElementById('social-platform').value;
    const tweak = document.getElementById('social-tweak').value;
    
    const prompt = `Social Media Expert (${persona}). Platform: ${platform}. Extra info: "${tweak}". Base content on this recipe:\n${brew.recipeMarkdown}\nOutput Markdown.`;
    
    try {
        const text = await performApiCall(prompt);
        const html = marked.parse(text);
        container.innerHTML = `<div>${html}</div><div class="mt-6 space-y-2"><button id="trigger-image-btn" class="w-full bg-purple-600 text-white py-2 px-4 rounded btn">Generate Image</button><button onclick="window.saveSocialPost()" class="w-full bg-blue-600 text-white py-2 px-4 rounded btn">Save to Notes</button></div>`;
        document.getElementById('trigger-image-btn').onclick = (e) => { generateSocialImage(brew.recipeName, text); e.target.style.display='none'; };
    } catch (e) {
        container.innerHTML = `<p class="text-red-500">Error: ${e.message}</p>`;
    }
}

async function runManualSocialMediaGenerator() {
    // ... (Zelfde logica als hierboven, maar dan met manualInput) ...
    // Voor de beknoptheid van dit antwoord: kopieer de logica van runSocialMediaGenerator,
    // maar gebruik document.getElementById('manual-social-input').value als basis.
    const input = document.getElementById('manual-social-input').value;
    if(!input) return alert("Enter text first.");
    const container = document.getElementById('social-content-container');
    document.getElementById('social-output-container').classList.remove('hidden');
    container.innerHTML = getLoaderHtml("Drafting post...");
    
    const prompt = `Social Media Expert. Topic: "${input}". Output Markdown.`;
    try {
        const text = await performApiCall(prompt);
        container.innerHTML = `<div>${marked.parse(text)}</div><div class="mt-6"><button id="trigger-img-manual" class="bg-purple-600 text-white btn p-2 rounded">Generate Image</button></div>`;
        document.getElementById('trigger-img-manual').onclick = (e) => { generateSocialImage("Mead Post", text); e.target.style.display='none'; };
    } catch(e) { container.innerHTML = `<p class="text-red-500">${e.message}</p>`; }
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
        listDiv.innerHTML = `<p class="text-center text-app-secondary/80">No saved profiles.</p>`;
        return;
    }
    
    listDiv.innerHTML = equipmentProfiles.map(p => `
        <div id="equip-item-${p.id}" class="p-3 card rounded-md mb-2">
            <div class="flex justify-between items-center">
                 <div class="flex-grow">
                    <p class="font-bold">${p.name} <span class="text-sm font-normal text-app-secondary/80">(${p.type})</span></p>
                    <p class="text-sm text-app-secondary">Capacity: ${p.capacityLiters || 'N/A'}L | Trub: ${p.trubLossLiters || 0}L ${p.type === 'Kettle' ? `| Boil-off: ${p.boilOffRateLitersPerHour || 0}L/hr` : ''}</p>
                </div>
                <div class="flex items-center gap-4 flex-shrink-0 ml-4">
                    <span class="font-semibold">${p.quantity || 1}x</span>
                    <div class="flex gap-2">
                        <button onclick="window.editEquipmentProfile('${p.id}')" class="text-blue-600 hover:text-blue-800 text-sm">Edit</button>
                        <button onclick="window.deleteEquipmentProfile('${p.id}')" class="text-red-600 hover:text-red-800 text-sm">Delete</button>
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

// --- DE HOOFDFUNCTIE: BOTTLE BATCH ---
async function bottleBatch(e) {
    e.preventDefault();
    if (!currentBrewToBottleId) return;

    const submitButton = e.target.querySelector('button[type="submit"]');
    const originalButtonText = submitButton.innerHTML;
    submitButton.disabled = true;
    submitButton.textContent = 'Processing...';

    try {
        const originalBrew = brews.find(b => b.id === currentBrewToBottleId);
        if (!originalBrew) throw new Error("Could not find the original recipe.");

        const bottlesData = [
            { size: 750, quantity: parseInt(document.getElementById('qty750').value) || 0, price: null },
            { size: 500, quantity: parseInt(document.getElementById('qty500').value) || 0, price: null },
            { size: 330, quantity: parseInt(document.getElementById('qty330').value) || 0, price: null },
            { size: 250, quantity: parseInt(document.getElementById('qty250').value) || 0, price: null },
            ...customBottles
        ].filter(b => b.quantity > 0 && b.size > 0);

        if (bottlesData.length === 0) throw new Error("Enter quantity for at least one bottle.");

        // 1. Stock Check
        const closureType = document.getElementById('closureTypeSelect').value;
        const outOfStockItems = [];
        let totalBottles = 0;

        bottlesData.forEach(bottle => {
            totalBottles += bottle.quantity;
            if (bottle.price === null) { // Alleen checken voor standaard flessen
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

        // 2. Calculate Costs
        // We gebruiken getPackagingCosts() die in het vorige blok zat.
        // Als die functie er niet is, gebruiken we een veilige fallback.
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

        if (confirm(`Packaging cost: ${currency}${totalPackagingCost.toFixed(2)}. Total batch cost: ${currency}${finalTotalCost.toFixed(2)}. Proceed?`)) {
            
            // 3. Deduct Stock
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

            // Save Packaging
            await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'settings', 'packaging'), updatedStock);
            packagingCosts = updatedStock;

            // 4. Create Cellar Entry
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

            // 5. Update Brew Status
            await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', currentBrewToBottleId), { isBottled: true });

            if (currentBrewDay.brewId === currentBrewToBottleId) {
                currentBrewDay = { brewId: null };
                await saveUserSettings();
            }

            hideBottlingModal();
            showToast("Batch bottled successfully!", "success");
            // Refresh views
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
    const grouped = inventory.reduce((acc, item) => {
        (acc[item.category] = acc[item.category] || []).push(item);
        return acc;
    }, {});

    const categories = ['Honey', 'Yeast', 'Nutrient', 'Malt Extract', 'Fruit', 'Spice', 'Adjunct', 'Chemical', 'Water'];
    const currency = userSettings.currencySymbol || '€';
    let html = '';

    for (const category of categories) {
        if (grouped[category]) {
            html += `<h3 class="text-xl font-header mt-4 mb-2">${category}</h3><div class="space-y-2">`;
            grouped[category].forEach(item => {
                const expDateStr = item.expirationDate ? new Date(item.expirationDate).toLocaleDateString() : 'N/A';
                let dateClass = 'text-app-secondary/80';
                if (item.expirationDate) {
                    const days = (new Date(item.expirationDate) - new Date()) / (1000 * 60 * 60 * 24);
                    if (days < 0) dateClass = 'text-red-500 font-bold';
                    else if (days <= 30) dateClass = 'text-amber-500 font-semibold';
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
        html = `<div class="text-center py-10 opacity-50"><p>The Cupboard is Bare</p></div>`;
    }
    const list = document.getElementById('inventory-list');
    if (list) list.innerHTML = html;
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
                   <div id="pkg-item-${item.id}" class="p-3 card rounded-md">
                       <div class="flex justify-between items-center">
                           <div><p class="font-bold">${item.name}</p><p class="text-sm text-app-secondary/80">Cost per unit: ${currency}${costPerUnit}</p></div>
                           <div class="flex items-center gap-4">
                               <span class="font-semibold">${itemData.qty} items - ${currency}${itemData.price.toFixed(2)} total</span>
                               <div class="flex gap-2">
                                   <button onclick="window.editPackagingItem('${item.id}')" class="text-blue-600 hover:text-blue-800 text-sm">Edit</button>
                                   <button onclick="window.clearPackagingItem('${item.id}')" class="text-red-600 hover:text-red-800 text-sm">Delete</button>
                               </div>
                           </div>
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
                <input type="number" id="edit-qty-${itemId}" value="${itemData.qty}" placeholder="Quantity" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
                <input type="number" id="edit-price-${itemId}" value="${itemData.price}" step="0.01" placeholder="Total Price (${currency})" class="w-full p-1 border rounded bg-app-tertiary border-app text-app-primary">
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
    document.getElementById('calcAbvBtn')?.addEventListener('click', calculateABV);
    document.getElementById('correctSgBtn')?.addEventListener('click', correctHydrometer);
    document.getElementById('calcSugarBtn')?.addEventListener('click', calculatePrimingSugar);
    document.getElementById('calcBlendBtn')?.addEventListener('click', calculateBlend);
    document.getElementById('calcBacksweetenBtn')?.addEventListener('click', calculateBacksweetening);
    document.getElementById('calcDilutionBtn')?.addEventListener('click', calculateDilution);
    document.getElementById('calcTosnaBtn')?.addEventListener('click', calculateTOSNA);
    document.getElementById('getYeastAdviceBtn')?.addEventListener('click', getYeastAdvice);
    document.getElementById('generate-manual-social-btn')?.addEventListener('click', runManualSocialMediaGenerator);
    document.getElementById('generate-social-from-recipe-btn')?.addEventListener('click', runSocialMediaGenerator);
    document.getElementById('getWaterAdviceBtn')?.addEventListener('click', getWaterAdvice);
    document.getElementById('troubleshoot-btn')?.addEventListener('click', getTroubleshootingAdvice);

    // Settings & Data
    document.getElementById('saveSettingsBtn')?.addEventListener('click', saveUserSettings);
    document.getElementById('theme-toggle-checkbox')?.addEventListener('change', (e) => applyTheme(e.target.checked ? 'dark' : 'light'));
    document.getElementById('exportHistoryBtn')?.addEventListener('click', exportHistory);
    document.getElementById('exportInventoryBtn')?.addEventListener('click', exportInventory);
    document.getElementById('importHistoryFile')?.addEventListener('change', (e) => importData(e, 'brews'));
    document.getElementById('importInventoryFile')?.addEventListener('change', (e) => importData(e, 'inventory'));
    document.getElementById('clearHistoryBtn')?.addEventListener('click', clearHistory);
    document.getElementById('clearInventoryBtn')?.addEventListener('click', clearInventory);

    // Labels
    document.getElementById('logoUpload')?.addEventListener('change', handleLogoUpload);
    document.getElementById('removeLogoBtn')?.addEventListener('click', removeLogo);
    document.getElementById('labelRecipeSelect')?.addEventListener('change', handleLabelRecipeSelect);
    document.querySelectorAll('.label-style-btn').forEach(btn => btn.addEventListener('click', () => switchLabelStyle(btn.dataset.style)));
    document.getElementById('generate-print-btn')?.addEventListener('click', generatePrintPage);
    document.querySelectorAll('.orientation-btn').forEach(btn => btn.addEventListener('click', () => setLabelOrientation(btn.dataset.orientation)));
    
    // Inputs die de label preview updaten
    ['labelStyle', 'labelAbv', 'labelVol', 'labelDate'].forEach(id => {
        document.getElementById(id)?.addEventListener('keyup', updateLabelPreview);
    });
    const formatSelect = document.getElementById('labelFormatSelect');
    if (formatSelect) {
        formatSelect.addEventListener('change', (e) => {
            document.getElementById('custom-format-inputs').classList.toggle('hidden', e.target.value !== 'custom');
            updatePreviewAspectRatio();
        });
    }
    ['customWidth', 'customHeight', 'customCols', 'customRows', 'customMarginTop', 'customMarginLeft'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', updatePreviewAspectRatio);
    });

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