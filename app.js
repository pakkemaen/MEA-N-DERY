import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
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
        const historyRef = collection(db, 'artifacts', 'meandery-aa05e', 'users', auth.currentUser.uid, 'brews');
        
        await addDoc(historyRef, {
            recipeName: extractTitle(recipeText) || "Untitled Brew",
            recipeMarkdown: recipeText, 
            flavorProfile: flavorProfile || {},
            createdAt: serverTimestamp(),
            logData: {},
            checklist: {},
            model: userSettings.aiModel || "gemini-1.5-flash-001"
        });
        showToast("Recipe saved to history!", "success");
    } catch (error) {
        console.error("Save error:", error);
        showToast("Could not save: " + error.message, "error");
    }
}

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
    // Check if Toastify is loaded
    if (typeof Toastify !== 'undefined') {
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
    } else {
        console.log(`[${type.toUpperCase()}] ${message}`);
        alert(message);
    }
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
    const views = ['dashboard', 'brewing', 'management', 'tools', 'settings'];
    views.forEach(v => {
        const el = document.getElementById(`${v}-main-view`);
        if(el) el.classList.add('hidden');
    });
    
    const viewToShow = document.getElementById(`${viewName}-main-view`);
    if (viewToShow) {
        viewToShow.classList.remove('hidden');
        if (viewName === 'brewing') populateEquipmentProfilesDropdown();
    }
}

window.switchSubView = function(viewName, parentViewId) {
    const parentView = document.getElementById(parentViewId);
    if(!parentView) return;
    
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
    if (viewName === 'labels') { 
        populateLabelRecipeDropdown(); 
        if(typeof updateLabelPreviewDimensions === 'function') updateLabelPreviewDimensions(); 
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
    
    if (optionsContainer) {
        optionsContainer.classList.toggle('opacity-50', hasText);
        optionsContainer.classList.toggle('pointer-events-none', hasText);
        optionsContainer.querySelectorAll('input, select, checkbox').forEach(el => {
            if (el.id !== 'useInventory') el.disabled = hasText;
        });
    }
    if (warningMessage) warningMessage.classList.toggle('hidden', !hasText);
}

function handleEquipmentTypeChange() {
     const type = document.getElementById('equipProfileType').value;
     const container = document.getElementById('boil-off-rate-container');
     if(container) container.classList.toggle('hidden', type !== 'Kettle');
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
    let apiKey = userSettings.apiKey;
    
    if (!apiKey && typeof CONFIG !== 'undefined' && CONFIG.firebase && CONFIG.firebase.apiKey) {
        apiKey = CONFIG.firebase.apiKey;
    }

    if (!apiKey) {
        throw new Error("⛔ Geen API Key! Ga naar Settings -> vul 'Google AI Key' in.");
    }

    const model = (userSettings.aiModel && userSettings.aiModel.trim() !== "") 
        ? userSettings.aiModel 
        : "gemini-1.5-flash";

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
            const errorData = await response.json();
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
    - **Temp:** NEVER recommend a fermentation temp exceeding the yeast manufacturer's limit.
    - **Sanity Check:** If the user requests impossible physics, correct them politely.

2.  **SCIENTIFIC LAWS:**
    - **Buffer:** Traditionals/Cysers MUST have Potassium Carbonate.
    - **Stability:** Ferment DRY -> Stabilize -> Backsweeten.
    - ${isNoWater ? '**NO-WATER RULE:** DO NOT ADD WATER. Liquid must come from fruit juice/maceration only.' : ''}
    - ${isBraggot ? '**BRAGGOT MATH:** Malt provides 30-50% sugar. Reduce honey to prevent overshooting ABV.' : ''}
    - ${isHydromel ? '**HYDROMEL BODY:** Low ABV needs Erythritol/Lactose/Carbonation to avoid tasting watery.' : ''}

3.  **NUTRIENT SECURITY:**
    - If user has *only* DAP/Nutrisal: WARN against adding it after 9% ABV.
    - If style is *Wild/Sour*: Reduce nutrient dosage by 50% and front-load.

**OUTPUT FORMAT (STRICT):**
- **Markdown** structure.
- **Ingredients JSON:** \`\`\`json [{"ingredient": "Name", "quantity": 0, "unit": "kg"}] \`\`\`
- **Timers:** \`[TIMER:HH:MM:SS]\` for wait steps.
`;
}

function buildPrompt() {
    try {
        const batchSize = parseFloat(document.getElementById('batchSize').value) || 5;
        const targetABV = parseFloat(document.getElementById('abv').value) || 12;
        const sweetness = document.getElementById('sweetness').value;
        const styleSelect = document.getElementById('style');
        const style = styleSelect.selectedOptions.length > 0 ? styleSelect.selectedOptions[0].text : 'Traditional Mead';
        const customDescription = document.getElementById('customDescription').value;
        
        const inputString = (customDescription + " " + style).toLowerCase();
        const noWaterCheckbox = document.getElementById('isNoWaterCheckbox');
        const isNoWater = (noWaterCheckbox && noWaterCheckbox.checked) || inputString.includes('no-water') || inputString.includes('no water');
        const isBraggot = inputString.includes('braggot');
        
        const useBudget = document.getElementById('useBudget')?.checked;
        let budgetContext = "";
        if (useBudget) {
             const maxBudget = parseFloat(document.getElementById('maxBudget').value);
             if (maxBudget > 0) {
                 budgetContext = `\n- **STRICT BUDGET CONSTRAINT:** Total cost must be below **€${maxBudget}**.`;
             }
        }

        const honeyGramsPerLiter = targetABV * 22; 
        const totalHoneyKg = (honeyGramsPerLiter * batchSize) / 1000;
        const estimatedYAN = Math.round(targetABV * 10); 
        
        let mathContext = `
**CALCULATED TARGETS:**
- **Batch:** ${batchSize}L | **Target ABV:** ${targetABV}%
- **Honey Baseline:** ~${totalHoneyKg.toFixed(2)} kg.
- **Nitrogen Target:** ~${estimatedYAN} PPM YAN.${budgetContext}
`;
        if (isNoWater) {
            mathContext += `\n- **PROTOCOL: NO-WATER MELOMEL.** 1. No added water. 2. Need ~1.8kg fruit/Liter.`;
        }

        // Inventory Toggle Safe Access
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
             inventoryInstruction = `**INVENTORY MODE:** User wants to use stock. Prioritize: ${requestedCategories.join(', ')}.`;
        }

        const invLower = inventoryString.toLowerCase();
        const hasSafeOrganic = invLower.includes('fermaid o') || invLower.includes('ferm o') || invLower.includes('cellvit');
        const hasDAP = invLower.includes('dap') || invLower.includes('nutrisal');
        
        let baseNutrientRule = "";
        if (inventoryToggles.Nutrient) { 
             if (!hasSafeOrganic && hasDAP) {
                baseNutrientRule = `1. **Nutrients:** Detected Inorganic stock only. Use it but WARN to stop after 9% ABV.`;
            } else if (hasSafeOrganic) {
                baseNutrientRule = `1. **Nutrients:** Use Fermaid O/Cellvit from stock.`;
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
        1. **JSON Block:** MUST contain the **TOTAL** ingredients required.
        2. **SHOPPING LIST TEXT:** Compare Required Amount vs Stock Amount.
        `;

        const sourKeywords = ['sour', 'wild', 'gueuze', 'lambic', 'brett', 'funky', 'farmhouse'];
        const isWildMode = sourKeywords.some(k => inputString.includes(k));
        const heavyKeywords = ['rum', 'barrel', 'bochet', 'dessert', 'pastry'];
        const isHydromel = targetABV < 8 || inputString.includes('session') || inputString.includes('hydromel');
        const isHeavyMode = heavyKeywords.some(k => inputString.includes(k)) || targetABV > 15;

        let protocolContext = "";
        let specificLaws = "";

        if (isWildMode) {
            protocolContext = `**PROTOCOL: WILD & SOUR.**`;
            specificLaws = `**WILD LAWS:**\n${baseNutrientRule}\n2. Yeast: Recommend Philly Sour or Brett.`;
        } else {
            protocolContext = `**PROTOCOL: STANDARD SCIENTIFIC.**`;
            let hydromelRule = "";
            if (isHydromel) hydromelRule = `5. **Hydromel Body:** Low ABV needs body builders (Lactose/Maltodextrin/Carbonation).`;

            specificLaws = `
**SCIENTIFIC LAWS:**
${baseNutrientRule}
2.  **Yeast:** Reliable strains (71B, EC-1118, D47).
3.  **Buffer:** Traditionals MUST have Potassium Carbonate.
4.  **Stability:** Ferment DRY -> Stabilize -> Backsweeten.
${hydromelRule}
`;
        }

        let waterContext = "";
        if (isNoWater) {
            waterContext = `**WATER RULE:** DO NOT ADD WATER.`;
        } else if (currentWaterProfile) {
            waterContext = `Use Water: ${currentWaterProfile.name}`;
        }

        let creativeBrief = ""; 
        if (customDescription.trim() !== '') {
             creativeBrief = `User Vision: "${customDescription}". Override stats only if specified. Base: ${batchSize}L, ${targetABV}%.`;
        } else {
             creativeBrief = `Structure: ${style}, Batch: ${batchSize}L, Target: ${targetABV}%, Sweetness: ${sweetness}.`;
             if (style.includes('Melomel')) {
                const fruits = Array.from(document.querySelectorAll('#fruit-section input[type=checkbox]:checked')).map(el => el.labels[0].innerText);
                const otherFruits = document.getElementById('fruitOther')?.value;
                const fStr = [...fruits, otherFruits].filter(Boolean).join(', ');
                if(fStr) creativeBrief += `\n- Fruits: ${fStr}`;
             }
             if (style.includes('Metheglin')) {
                const spices = Array.from(document.querySelectorAll('#spice-section input[type=checkbox]:checked')).map(el => el.labels[0].innerText);
                const otherSpices = document.getElementById('spiceOther')?.value;
                const sStr = [...spices, otherSpices].filter(Boolean).join(', ');
                if(sStr) creativeBrief += `\n- Spices: ${sStr}`;
             }
             if (document.getElementById('addOak')?.checked) creativeBrief += '\n- Requirement: Include Oak Aging.';
             if (document.getElementById('specialIngredients')?.value) creativeBrief += `\n- Special Ingredients: ${document.getElementById('specialIngredients').value}`;
        }

        return `You are "MEA(N)DERY", a master mazer. 

${mathContext}
${protocolContext}
${specificLaws}
${inventoryLogic}
${waterContext}

**OUTPUT FORMAT (ABSOLUTE STRICTNESS):**
- **START:** The output MUST start with the character "#" (The Title).
- **STRUCTURE:**
  1. Title (# Name)
  2. > Inspirational Quote
  3. Vital Stats List (ABV, Size, Style, Sweetness, OG)
  4. Ingredients JSON Block: \`\`\`json [{"ingredient": "Name", "quantity": 0, "unit": "kg"}] \`\`\`
  5. Instructions (Numbered list)
  6. Timers: \`[TIMER:HH:MM:SS]\` inside the steps.
  7. Brewer's Notes

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
    try {
        const titleMatch = markdown.match(/^#\s*(.*)/m);
        if (titleMatch && titleMatch[1]) { data.recipeName = titleMatch[1].trim(); }

        const createRegex = (key) => new RegExp(`(?:${key}|${key.replace('.', '\\.')})[\\s\\*:]*~?([\\d.,]+)`, 'i');
        const ogMatch = markdown.match(createRegex('Target OG|Original Gravity|Start SG|OG'));
        if (ogMatch && ogMatch[1]) { data.targetOG = ogMatch[1]; }

        const fgMatch = markdown.match(createRegex('Target FG|Final Gravity|FG'));
        if (fgMatch && fgMatch[1]) { data.targetFG = fgMatch[1]; }

        const abvMatchGlobal = markdown.match(new RegExp(`(?:Target ABV|ABV|Alcoholpercentage)[\\s\\*:]*~?([\\d.,]+)\\s*%?`, 'i'));
        if (abvMatchGlobal && abvMatchGlobal[1]) { data.targetABV = abvMatchGlobal[1]; }

    } catch (e) { console.error("Error parsing recipe data:", e); }
    return data;
}

function formatRecipeMarkdown(markdown) {
    if (!markdown) return "";
    let finalMarkdown = markdown;
    const jsonRegex = /(?:```json\s*([\s\S]*?)\s*```|(\[\s*\{[\s\S]*?\}\s*\]))/;
    const jsonMatch = finalMarkdown.match(jsonRegex); 

    if (jsonMatch && (jsonMatch[1] || jsonMatch[2])) {
        const jsonString = jsonMatch[1] || jsonMatch[2];
        try {
            let safeJsonString = jsonString.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'); 
            const ingredientsArray = JSON.parse(safeJsonString);
            
            let tableMarkdown = '\n| Ingredient | Quantity | Unit |\n|---|---|---|\n';
            ingredientsArray.forEach(item => {
                let displayQty = parseFloat(item.quantity);
                let displayUnit = item.unit;
                if ((displayUnit || '').toLowerCase() === 'g' && displayQty >= 1000) { displayQty /= 1000; displayUnit = 'kg'; } 
                else if ((displayUnit || '').toLowerCase() === 'ml' && displayQty >= 1000) { displayQty /= 1000; displayUnit = 'L'; }
                if (displayQty % 1 !== 0) { displayQty = parseFloat(displayQty.toFixed(2)); }
                tableMarkdown += `| ${item.ingredient} | ${displayQty} | ${displayUnit} |\n`;
            });
            finalMarkdown = finalMarkdown.replace(jsonRegex, tableMarkdown); 
        } catch (e) { console.error("Table format error:", e); }
    }
    return finalMarkdown;
}

// --- RENDER RECIPE OUTPUT ---
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
    
    finalMarkdown = formatRecipeMarkdown(finalMarkdown);
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
                    <h4 class="font-bold text-app-brand text-sm uppercase flex items-center gap-2">Water Chemistry</h4>
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

    document.getElementById('saveBtn').addEventListener('click', () => {
        saveBrewToHistory(currentRecipeMarkdown, currentPredictedProfile);
    });
    document.getElementById('tweak-unsaved-btn').addEventListener('click', tweakUnsavedRecipe);

    if (!isTweak) {
        generateAndInjectCreativeTitle(finalMarkdown);
    }
}

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
    CONTEXT: ${styleHint}
    TASK: Recommend 3 real-world bottled water brands found in **BELGIAN SUPERMARKETS**.
    OUTPUT: JSON Array: [{"brand": "Name", "reason": "Why", "tweak_instruction": "Specific usage advice"}]`;

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
                            <span class="font-bold text-app-primary">${b.brand}</span>
                            <button onclick="window.applyWaterTweak('${b.brand}', '${b.tweak_instruction.replace(/'/g, "\\'")}')" class="text-xs bg-app-tertiary hover:bg-app-secondary text-app-brand border border-app-brand py-1 px-2 rounded transition-colors font-bold uppercase tracking-wider">Select</button>
                        </div>
                        <p class="text-xs text-app-secondary">${b.reason}</p>
                     </div>`;
        });
        html += `</div>`;
        resultsDiv.innerHTML = html;
    } catch (error) {
        resultsDiv.innerHTML = `<p class="text-red-500 text-sm">Could not find matching brands.</p>`;
    }
}

window.applyWaterTweak = function(brandName, technicalInstruction) {
    const tweakInput = document.getElementById('tweak-unsaved-request');
    document.getElementById('tweak-unsaved-section').scrollIntoView({ behavior: 'smooth', block: 'center' });
    tweakInput.value = `Update recipe for **${brandName}** water profile. \nNote: ${technicalInstruction} \nPlease recalculate nutrients and acidity buffering based on this specific mineral content.`;
    tweakInput.focus();
}

async function tweakUnsavedRecipe() {
    const tweakRequest = document.getElementById('tweak-unsaved-request').value.trim();
    if (!tweakRequest) { showToast("Please enter your tweak request.", "error"); return; }

    const tweakOutput = document.getElementById('tweak-unsaved-output');
    tweakOutput.innerHTML = getLoaderHtml("Analyzing Tweak Request..."); 
    
    const tweakBtn = document.getElementById('tweak-unsaved-btn');
    tweakBtn.disabled = true;

    try {
        const safeMarkdown = currentRecipeMarkdown.replace(/`/g, "'"); 
        const prompt = `You are "MEA(N)DERY". Rewriting recipe.
        Original: ${safeMarkdown}
        Tweak: "${tweakRequest}"
        RULES: Keep Title/Style. Recalculate Ingredients. Output standard MD format starting with # Title.`; 

        const tweakedMarkdown = await performApiCall(prompt);
        
        let processedMarkdown = tweakedMarkdown.trim();
        if (processedMarkdown.startsWith("```markdown")) processedMarkdown = processedMarkdown.substring(11, processedMarkdown.lastIndexOf("```")).trim();
        
        currentRecipeMarkdown = processedMarkdown;
        await renderRecipeOutput(processedMarkdown, true);
        
        tweakOutput.innerHTML = '';
        tweakBtn.disabled = false;

    } catch (error) {
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
        return null;
    }
}

function renderGeneratedFlavorWheel(flavorData) {
    const ctx = document.getElementById('generated-flavor-wheel');
    if (!ctx) return;
    const labels = ['Sweetness', 'Acidity', 'Fruity/Floral', 'Spiciness', 'Earthy/Woody', 'Body'];
    const data = [flavorData.sweetness, flavorData.acidity, flavorData.fruity_floral, flavorData.spiciness, flavorData.earthy_woody, flavorData.body_mouthfeel];
    const brandColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-color') || '#d97706';
    
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
            scales: {
                r: { suggestedMin: 0, suggestedMax: 5 }
            }
        }
    });
}

// --- BREW DAY MANAGAMENT ---

window.startBrewDay = async function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;
    switchMainView('brewing');
    switchSubView('shopping-list', 'brewing-main-view');
    generateShoppingList(brewId, false); // Assuming generateShoppingList exists or handled elsewhere
}

window.startActualBrewDay = async function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    if (!brew.logData.brewDate) {
        brew.logData.brewDate = new Date().toISOString().split('T')[0];
        try {
            await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), { logData: brew.logData });
        } catch (error) { console.error(error); }
    }

    currentBrewDay = { brewId: brewId };
    saveUserSettings(); 

    window.switchSubView('brew-day-1', 'brewing-main-view');
    renderBrewDay(brewId);
}

function extractStepsFromMarkdown(markdown) {
    if (!markdown) return { day1: [], day2: [] };
    const lines = markdown.split('\n');
    const day1 = [];
    const day2 = [];
    const stepRegex = /^(\d+)\.\s+(.*)/;

    lines.forEach(line => {
        const match = line.trim().match(stepRegex);
        if (match) {
            const text = match[2];
            const lower = text.toLowerCase();
            const isSecondary = lower.includes('rack') || lower.includes('bottle') || lower.includes('aging');
            const stepObj = { title: `Step ${match[1]}`, description: text, duration: 0 };
            if (isSecondary) day2.push(stepObj); else day1.push(stepObj);
        }
    });
    
    if (day2.length === 0 && day1.length === 0) return { day1: [], day2: [] };
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
        if (primarySteps.length === 0) primarySteps = [{ title: "Check Recipe", description: "Follow recipe text." }];
    }

    let stepsHtml = primarySteps.map((step, index) => {
        const stepState = currentBrewDay.checklist[`step-${index}`]; 
        const isCompleted = stepState === true || (stepState && stepState.completed);
        
        return `<div id="step-${index}" class="step-item p-4 rounded-r-lg mb-3 ${isCompleted ? 'completed' : ''}"><div><p class="step-title">${index + 1}. ${step.title}</p><p class="text-sm text-app-secondary">${step.description}</p><div class="mt-4 space-x-2" id="controls-${index}">${isCompleted ? '<span class="text-sm font-bold text-green-600">✓ Completed</span>' : `<button data-action="completeStep" data-step="${index}" class="text-sm bg-blue-600 text-white py-1 px-3 rounded-lg hover:bg-blue-700 btn">Mark Complete</button>`}</div></div></div>`;
    }).join('');

    const parsedTargets = parseRecipeData(brew.recipeMarkdown);
    const combinedLogData = { ...brew.logData, ...parsedTargets };
    const logHtml = getBrewLogHtml(combinedLogData, brew.id); 

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

// --- BREW DAY 2 ---
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
    if (steps.length === 0 && brew.recipeMarkdown) {
        const extracted = extractStepsFromMarkdown(brew.recipeMarkdown);
        if (extracted.day2.length > 0) steps = extracted.day2;
    }
    if (steps.length === 0) steps = [{ title: "Bottling", desc: "Bottle when clear." }];

    const checklist = brew.checklist || {};
    const stepsHtml = steps.map((step, idx) => {
        const key = `sec-step-${idx}`;
        const isChecked = checklist[key] === true;
        return `
        <div class="flex items-start gap-4 p-4 mb-3 card rounded-lg cursor-pointer hover:bg-app-primary transition-colors" onclick="window.toggleSecondaryStep('${brew.id}', '${key}')">
            <div class="pt-1"><div class="w-6 h-6 rounded border-2 flex items-center justify-center transition-colors ${isChecked ? 'bg-green-600 border-green-600' : 'border-gray-400 bg-app-tertiary'}">${isChecked ? '✓' : ''}</div></div>
            <div><h4 class="font-bold text-lg ${isChecked ? 'text-green-600 line-through' : 'text-app-primary'}">${step.title}</h4><p class="text-sm text-app-secondary ${isChecked ? 'line-through opacity-50' : ''}">${step.desc || step.description}</p></div>
        </div>`;
    }).join('');

    container.innerHTML = `
        <div class="bg-app-secondary p-6 md:p-8 rounded-lg shadow-lg">
            <h2 class="text-3xl font-header font-bold mb-2 text-center text-app-brand">${brew.recipeName}</h2>
            <div class="mb-8">${stepsHtml}</div>
            <div id="brew-day-2-log-container">${getBrewLogHtml(brew.logData, brew.id + '-secondary')}</div>
            <div class="mt-6 space-y-3">
                <button onclick="window.updateBrewLog('${brew.id}', 'brew-day-2-log-container')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg hover:opacity-90 btn">Save Log Notes</button>
                <button onclick="window.showBottlingModal('${brew.id}')" class="w-full bg-green-600 text-white py-3 px-4 rounded-lg hover:bg-green-700 btn flex items-center justify-center gap-2">Proceed to Bottling</button>
            </div>
        </div>
    `;
}

window.toggleSecondaryStep = async function(brewId, stepKey) {
    const brewIndex = brews.findIndex(b => b.id === brewId);
    if (brewIndex === -1) return;
    if (!brews[brewIndex].checklist) brews[brewIndex].checklist = {};
    brews[brewIndex].checklist[stepKey] = !brews[brewIndex].checklist[stepKey];
    renderBrewDay2();
    try { await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), { checklist: brews[brewIndex].checklist }); } 
    catch (e) { console.error(e); }
}

// --- STATE & TIMERS ---
let brewDaySteps = [];
let currentStepIndex = 0;

function setupBrewDayEventListeners() {
    const viewContainer = document.getElementById('brewing-main-view');
    if (!viewContainer) return;
    viewContainer.addEventListener('click', function(e) {
        const target = e.target.closest('button[data-action]');
        if (!target) return; 
        const action = target.dataset.action;
        const stepIndex = parseInt(target.dataset.step);
        if (action === 'completeStep') completeStep(stepIndex);
        if (action === 'resetBrewDay') resetBrewDay();
    });
}

function initializeBrewDayState(steps) {
    brewDaySteps = steps;
    const activeBrew = brews.find(b => b.id === currentBrewDay.brewId);
    const checklist = (activeBrew && activeBrew.checklist) ? activeBrew.checklist : {};
    const lastCompleted = Object.keys(checklist).length - 1;
    currentStepIndex = lastCompleted >= 0 ? lastCompleted + 1 : 0;
    updateUI();
}

async function resetBrewDay() {
    if (!confirm("Reset progress?")) return;
    const brewId = currentBrewDay.brewId;
    const brewIndex = brews.findIndex(b => b.id === brewId);
    if (brewIndex === -1) return;
    brews[brewIndex].checklist = {};
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), { checklist: {} });
        renderBrewDay(brewId);
    } catch (e) { console.error(e); }
}

async function completeStep(stepIndex) {
    const brewId = currentBrewDay.brewId;
    const brewIndex = brews.findIndex(b => b.id === brewId);
    if (brewIndex === -1) return;
    if (!brews[brewIndex].checklist) brews[brewIndex].checklist = {};
    brews[brewIndex].checklist[`step-${stepIndex}`] = true;

    try { await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), { checklist: brews[brewIndex].checklist }); } 
    catch (e) { console.error(e); return; }

    document.getElementById(`step-${stepIndex}`).classList.add('completed');
    document.getElementById(`controls-${stepIndex}`).innerHTML = `<span class="text-sm font-bold text-green-600">✓ Completed</span>`;
    
    currentStepIndex = stepIndex + 1;
    updateUI();
    
    if (stepIndex === (brews[brewIndex].brewDaySteps || []).length - 1) {
        await markPrimaryAsComplete(brewId);
        window.finalizeBrewDay1();
    }
}

function updateUI() {
    const progress = (currentStepIndex / brewDaySteps.length) * 100;
    const bar = document.getElementById('brew-day-progress');
    if (bar) bar.style.width = `${progress}%`;
}

async function markPrimaryAsComplete(brewId) {
    if (!userId || !brewId) return;
    try { await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), { primaryComplete: true }); } 
    catch (e) { console.error(e); }
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
        brews = snapshot.docs.map(doc => {
            let b = { id: doc.id, ...doc.data() };
            if (!b.logData) b.logData = {};
            ['actualOG', 'actualFG', 'targetOG', 'targetFG', 'targetABV', 'finalABV', 'brewDate'].forEach(field => {
                if (b[field] !== undefined && b.logData[field] === undefined) b.logData[field] = b[field];
            });
            return b;
        });
        brews.sort((a, b) => (b.createdAt?.toDate() || 0) - (a.createdAt?.toDate() || 0));
        renderHistoryList();
        populateSocialRecipeDropdown();
        if(typeof renderActiveBrewTimeline === 'function') renderActiveBrewTimeline();
    });
}

function renderHistoryList() {
    const term = document.getElementById('history-search-input')?.value.toLowerCase() || '';
    const filtered = brews.filter(b => (b.recipeName || 'Untitled').toLowerCase().includes(term));
    const list = document.getElementById('history-list');
    if (!list) return;
    
    if (filtered.length === 0) { list.innerHTML = `<p class="text-center text-app-secondary/80">No brews.</p>`; return; }

    list.innerHTML = filtered.map(b => `<div class="p-4 card rounded-lg cursor-pointer hover:bg-app-primary" onclick="window.showBrewDetail('${b.id}')"><h4 class="font-bold text-lg font-header">${b.recipeName}</h4><p class="text-sm text-app-secondary/80">Saved: ${b.createdAt?.toDate().toLocaleDateString() || '?'}</p></div>`).join('');
}

window.showBrewDetail = function(brewId) {
    switchMainView('brewing');
    switchSubView('history', 'brewing-main-view');

    const historyDetailContainer = document.getElementById('history-detail-container');
    const historyListContainer = document.getElementById('history-list-container');
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;

    let processedMarkdown = formatRecipeMarkdown(brew.recipeMarkdown);
    const cleanMarkdown = processedMarkdown.replace(/\[d:[\d:]+\]/g, '').replace(/^#\s.*$/m, '');
    const recipeHtml = marked.parse(cleanMarkdown);
    const logHtml = getBrewLogHtml(brew.logData, brew.id);

    historyDetailContainer.innerHTML = `
        <button onclick="window.goBackToHistoryList()" class="mb-4 text-app-brand hover:underline no-print">&larr; Back</button>
        <h2 class="text-3xl font-header font-bold mb-2">${brew.recipeName}</h2>
        <div class="print-button-container mb-4 grid grid-cols-2 gap-2 no-print">
            <button onclick="window.resumeBrew('${brew.id}')" class="bg-green-600 text-white py-2 px-4 rounded btn">Resume</button>
            <button onclick="window.deleteBrew('${brew.id}')" class="bg-red-700 text-white py-2 px-4 rounded btn">Delete</button>
        </div>
        <div class="recipe-content">${recipeHtml}</div>
        ${logHtml}
        <div class="mt-4 no-print"><button onclick="window.updateBrewLog('${brew.id}', 'history-detail-container')" class="w-full bg-app-action text-white py-3 px-4 rounded btn">Save Log</button></div>
    `;
    historyListContainer.classList.add('hidden');
    historyDetailContainer.classList.remove('hidden');
}

window.resumeBrew = async function(brewId) {
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;
    currentBrewDay = { brewId: brewId };
    await saveUserSettings(); 
    switchMainView('brewing');
    if (brew.primaryComplete) {
        switchSubView('brew-day-2', 'brewing-main-view');
        renderBrewDay2();
    } else {
        switchSubView('brew-day-1', 'brewing-main-view');
        renderBrewDay(brewId);
    }
}

window.deleteBrew = async function(brewId) {
    if (!confirm("Delete this brew?")) return;
    try { await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId)); window.goBackToHistoryList(); }
    catch(e) { console.error(e); }
}

window.goBackToHistoryList = function() {
    document.getElementById('history-detail-container').classList.add('hidden');
    document.getElementById('history-list-container').classList.remove('hidden');
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
        targetABV: (container.querySelector(`#targetABV${suffix}`)?.value || '').replace('%', ''),
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

function getBrewLogHtml(logData, idSuffix = 'new') {
    const data = logData || {};
    const fermLog = data.fermentationLog || Array.from({ length: 3 }, () => ({}));
    
    return `
        <div class="brew-log-section" data-id="${idSuffix}">
            <h3>Brewmaster's Log</h3>
            <div class="log-grid">
                <div class="log-item"><label>Recipe Name:</label><input type="text" id="recipeName-${idSuffix}" value="${data.recipeName || ''}"></div>
                <div class="log-item"><label>Brew Date:</label><input type="date" id="brewDate-${idSuffix}" value="${data.brewDate || ''}"></div>
            </div>
            <div class="log-grid">
                <div class="log-item"><label>Target OG:</label><input type="text" id="targetOG-${idSuffix}" value="${data.targetOG || ''}" readonly class="bg-app-primary"></div>
                <div class="log-item"><label>Actual OG:</label><input type="text" id="actualOG-${idSuffix}" value="${data.actualOG || ''}" oninput="window.autoCalculateABV('${idSuffix}')"></div>
                <div class="log-item"><label>Target FG:</label><input type="text" id="targetFG-${idSuffix}" value="${data.targetFG || ''}" readonly class="bg-app-primary"></div>
                <div class="log-item"><label>Actual FG:</label><input type="text" id="actualFG-${idSuffix}" value="${data.actualFG || ''}" oninput="window.autoCalculateABV('${idSuffix}')"></div>
                <div class="log-item"><label>Target ABV:</label><input type="text" id="targetABV-${idSuffix}" value="${data.targetABV || ''}%" readonly class="bg-app-primary"></div>
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

window.updateBrewLog = async function(brewId, containerId) {
    if (!userId || !brewId) return;
    const logData = getLogDataFromDOM(containerId);
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'brews', brewId), { logData: logData });
        showToast('Log updated!', 'success');
    } catch(e) { console.error(e); showToast('Failed to save.', 'error'); }
}

window.addLogLine = function(idSuffix) {
    const tbody = document.querySelector(`#fermentationTable-${idSuffix} tbody`);
    if (!tbody) return;
    const newRow = document.createElement('tr');
    newRow.innerHTML = `<td><input type="date" class="w-full"></td><td><input type="number" step="0.5" class="w-full text-center"></td><td><input type="number" step="0.001" class="w-full text-center"></td><td><input type="text" class="w-full"></td>`;
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

// --- INVENTORY MANAGEMENT ---

function loadInventory() {
    if (!userId) return;
    const invCol = collection(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'inventory');
    onSnapshot(query(invCol), (snapshot) => {
        inventory = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderInventory();
    });
}

window.renderInventory = function() {
    const listDiv = document.getElementById('inventory-list');
    if (!listDiv) return;

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
                            <div class="font-bold text-xl text-app-primary leading-tight">${item.name}</div>
                            <div class="text-xs ${dateClass} mt-1 flex items-center gap-1">Exp: ${expDateStr}</div>
                        </div>
                        <div class="text-right">
                            <div class="inline-block bg-app-tertiary px-2 py-1 rounded-lg border border-app-brand/10 mb-2">
                                <div class="font-mono font-bold text-app-primary text-sm">${item.qty} <span class="text-xs font-normal text-app-secondary">${item.unit}</span></div>
                            </div>
                            <div class="text-xs text-app-secondary font-mono mb-3">${currency}${(item.price || 0).toFixed(2)}</div>
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
    if(confirm("Delete old item to re-add?")) window.deleteInventoryItem(itemId);
}

window.deleteInventoryItem = async function(itemId) {
    if (!userId) return;
    try { await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'inventory', itemId)); showToast("Deleted.", "success"); }
    catch (error) { showToast("Error deleting.", "error"); }
}

async function addInventoryItem(e) {
    e.preventDefault();
    if (!userId) return;
    const itemData = {
        name: document.getElementById('itemName').value,
        qty: parseFloat(document.getElementById('itemQty').value),
        unit: document.getElementById('itemUnit').value,
        price: parseFloat(document.getElementById('itemPrice').value),
        category: document.getElementById('itemCategory').value,
        expirationDate: document.getElementById('itemExpirationDate').value || null
    };
    if (!itemData.name) return;
    try { await addDoc(collection(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'inventory'), itemData); showToast("Added!", "success"); } 
    catch (error) { showToast("Error adding.", "error"); }
}

window.deductActualsFromInventory = function(brewId) {
    if (!confirm("This feature requires 'Actuals' logging first. Proceed?")) return;
    showToast("Inventory deduction not fully implemented in this safe mode.", "info");
}

// --- LABEL GENERATOR ---
function initLabelForge() {
    populateLabelRecipeDropdown();
    document.getElementById('labelRecipeSelect')?.addEventListener('change', loadLabelFromBrew);
    document.querySelectorAll('.label-theme-btn').forEach(btn => {
        btn.addEventListener('click', (e) => setLabelTheme(e.target.dataset.theme));
    });
    ['labelTitle', 'labelSubtitle', 'labelAbv', 'labelVol'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', updateLabelPreviewText);
    });
}

function populateLabelRecipeDropdown() {
    const select = document.getElementById('labelRecipeSelect');
    if (!select) return;
    select.innerHTML = '<option value="">-- Load from History --</option>';
    brews.forEach(brew => {
        const option = document.createElement('option');
        option.value = brew.id;
        option.textContent = brew.recipeName;
        select.appendChild(option);
    });
}

function loadLabelFromBrew(e) {
    const brewId = e.target.value;
    const brew = brews.find(b => b.id === brewId);
    if (!brew) return;
    document.getElementById('labelTitle').value = brew.recipeName;
    document.getElementById('labelAbv').value = brew.logData?.finalABV?.replace('%','') || '12';
    updateLabelPreviewText();
}

function updateLabelPreviewText() {
    document.getElementById('prev-title').textContent = document.getElementById('labelTitle').value || 'Name';
    document.getElementById('prev-abv').textContent = document.getElementById('labelAbv').value;
}

function setLabelTheme(theme) {
    const container = document.getElementById('label-content');
    const title = document.getElementById('labelTitle').value || 'TITEL';
    const sub = document.getElementById('labelSubtitle').value || 'STYLE';
    const abv = document.getElementById('labelAbv').value || '0';
    
    if (theme === 'signature') {
        container.className = `relative w-full h-full overflow-hidden bg-white text-[#8F8C79] font-sans p-6`;
        container.innerHTML = `
            <div class="label-overlay flex justify-between h-full">
                <div class="vertical-text-group h-full flex justify-center" style="writing-mode: vertical-rl; transform: rotate(180deg);">
                    <h1 id="prev-title" class="text-6xl font-bold uppercase">${title}</h1>
                    <h2 id="prev-subtitle" class="text-sm font-bold uppercase tracking-widest">${sub}</h2>
                </div>
                <div class="flex flex-col justify-between items-end h-full py-2">
                    <div class="meandery-circle" style="width:80px;height:80px;border:2px solid currentColor;border-radius:50%;display:flex;align-items:center;justify-content:center;"><span>MEA(N)DERY</span></div>
                    <div class="text-right"><p class="text-2xl font-bold">${abv}% ABV</p></div>
                </div>
            </div>`;
    } else {
        container.innerHTML = `<div class="p-4">Select a theme</div>`;
    }
}

function updateLabelPreviewDimensions() {
    // Placeholder for dimension logic
}

// --- CALCULATORS ---
function calculateABV() {
    const og = parseFloat(document.getElementById('og').value);
    const fg = parseFloat(document.getElementById('fg').value);
    if (og && fg) document.getElementById('abvResult').textContent = `ABV: ${((og - fg) * 131.25).toFixed(2)}%`;
}

// --- APP START ---
function initApp() {
    try {
        const app = initializeApp(CONFIG.firebase);
        db = getFirestore(app);
        auth = getAuth(app);

        document.getElementById('google-login-btn').addEventListener('click', signInWithGoogle);

        onAuthStateChanged(auth, async (user) => {
            if (user) {
                userId = user.uid;
                document.getElementById('login-view').classList.add('hidden');
                document.querySelector('.container').classList.remove('hidden');
                loadHistory(); loadInventory(); loadEquipmentProfiles();
                loadUserSettings();
            } else {
                document.getElementById('login-view').classList.remove('hidden');
                document.querySelector('.container').classList.add('hidden');
            }
        });
    } catch (e) { console.error("Firebase init failed:", e); }

    // Global Listeners
    document.getElementById('generateBtn')?.addEventListener('click', generateRecipe);
    document.getElementById('inventory-form')?.addEventListener('submit', addInventoryItem);
    
    // Tools
    document.getElementById('calcAbvBtn')?.addEventListener('click', calculateABV);

    // Nav
    document.querySelectorAll('.main-nav-btn').forEach(btn => btn.addEventListener('click', () => switchMainView(btn.dataset.view)));
    document.querySelectorAll('.back-to-dashboard-btn').forEach(btn => btn.addEventListener('click', () => switchMainView('dashboard')));
    document.querySelectorAll('.sub-tab').forEach(tab => tab.addEventListener('click', (e) => switchSubView(e.target.id.replace('-sub-tab', ''), e.target.closest('[id$="-main-view"]').id)));

    initLabelForge();
    setupBrewDayEventListeners();
}

async function loadUserSettings() {
    if (!userId) return;
    try {
        const docSnap = await getDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'settings', 'main'));
        if (docSnap.exists()) userSettings = docSnap.data();
    } catch (e) { console.error(e); }
}

async function loadEquipmentProfiles() {
    if (!userId) return;
    onSnapshot(query(collection(db, 'artifacts', 'meandery-aa05e', 'users', userId, 'equipmentProfiles')), (snapshot) => {
        equipmentProfiles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    });
}

function populateEquipmentProfilesDropdown() { /* Placeholder */ }
function loadCellar() { /* Placeholder for cellar logic if needed later */ }
function loadPackagingCosts() { /* Placeholder */ }
function loadUserWaterProfiles() { /* Placeholder */ }
function populateSocialRecipeDropdown() { /* Placeholder */ }
function renderActiveBrewTimeline() { /* Placeholder */ }

document.addEventListener('DOMContentLoaded', () => {
    console.log("🍀 MEA(N)DERY V2.0 Clean Loaded.");
    initApp();
});