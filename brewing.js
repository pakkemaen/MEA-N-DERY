// ============================================================================
// brewing.js
// MEANDERY V2.4 - MODULAR BREWING ENGINE
// ============================================================================

// 1. IMPORTS
// 1. Haal de database instanties uit je lokale bestand
import { db, auth } from './firebase-init.js';

// 2. Haal de Firestore functies rechtstreeks van Google
import { 
    collection, addDoc, updateDoc, doc, deleteDoc, 
    getDoc, setDoc, query, onSnapshot, serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { state, tempState } from './state.js';
import { 
    showToast, performApiCall, switchMainView, switchSubView, 
    getLoaderHtml 
} from './utils.js';

// 2. MODULE VARIABLES
// Deze variabelen zijn alleen zichtbaar binnen dit bestand (geen global scope vervuiling)
let currentRecipeMarkdown = "";
let currentPredictedProfile = null;
let lastGeneratedPrompt = "";
let stepTimerInterval = null;
let remainingTime = 0;

// 3. CORE HELPERS

// Helper: Haal de titel uit een stuk Markdown tekst (alles na de eerste #)
function extractTitle(markdown) {
    const match = markdown.match(/^#\s*(.*)/m);
    return match ? match[1].trim() : null;
}

// Helper: Formatteer seconden naar MM:SS of UU:MM:SS
function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0 
        ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` 
        : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// Helper: De "Wetten van de Mead" voor de AI Prompt
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

// --- CORE: De Prompt Bouwer ---
function buildPrompt() {
    try {
        // 1. Data Verzamelen
        const batchSize = parseFloat(document.getElementById('batchSize')?.value) || 5;
        const targetABV = parseFloat(document.getElementById('abv')?.value) || 12;
        const sweetness = document.getElementById('sweetness')?.value;
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
             const maxBudget = parseFloat(document.getElementById('maxBudget')?.value);
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
        const currentInventory = state.inventory || [];
        const fullInventoryList = state.inventory.filter(item => relevantCategories.includes(item.category));
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
        } else if (window.currentWaterProfile) {  // <--- AANGEPAST
            waterContext = `Use Water: ${window.currentWaterProfile.name}`;
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

// --- CORE: Generate Recipe ---
async function generateRecipe() {
    const recipeOutput = document.getElementById('recipe-output');
    // Gebruik getLoaderHtml uit utils.js
    if(recipeOutput) recipeOutput.innerHTML = getLoaderHtml("Initializing Brewing Protocol...");
    
    const generateBtn = document.getElementById('generateBtn');
    if(generateBtn) {
        generateBtn.disabled = true;
        generateBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }
    
    // Reset module variabelen
    currentPredictedProfile = null; 

    // Start animatie (als beschikbaar in utils.js via window koppeling)
    const thinkingInterval = (typeof window.startThinkingAnimation === 'function') 
        ? window.startThinkingAnimation("loader-text") 
        : null;

    try {
        const prompt = buildPrompt();
        lastGeneratedPrompt = prompt; // Handig voor debuggen via console
        
        // API Call via utils.js
        let rawResponse = await performApiCall(prompt); 
        
        // Markdown opschonen (verwijder ```markdown code blocks)
        let cleanedResponse = rawResponse.trim();
        if (cleanedResponse.startsWith("```")) {
            // Vind de eerste enter (na ```markdown)
            const firstNewLine = cleanedResponse.indexOf('\n');
            // Vind de laatste ```
            const lastBackticks = cleanedResponse.lastIndexOf("```");
            
            if (firstNewLine !== -1 && lastBackticks !== -1) {
                cleanedResponse = cleanedResponse.substring(firstNewLine, lastBackticks).trim();
            }
        }
        
        if (thinkingInterval) clearInterval(thinkingInterval);

        // Opslaan in module scope en tempState voor andere functies
        currentRecipeMarkdown = cleanedResponse;
        window.currentRecipeMarkdown = cleanedResponse;
        tempState.currentRecipe = currentRecipeMarkdown;

        // Renderen (deze functie komt in de volgende stap)
        if(typeof renderRecipeOutput === 'function') {
            await renderRecipeOutput(currentRecipeMarkdown); 
        } else {
            console.warn("renderRecipeOutput nog niet geladen.");
            if(recipeOutput) recipeOutput.innerText = currentRecipeMarkdown; // Fallback tekst
        }

    } catch (error) {
        if (thinkingInterval) clearInterval(thinkingInterval);
        console.error("Error calling Gemini API:", error);
        if(recipeOutput) recipeOutput.innerHTML = getLoaderHtml("Initializing Brewing Protocol...");
    } finally {
        if(generateBtn) {
            generateBtn.disabled = false;
            generateBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }
}

// --- HELPER: Flavor Prediction (AI) ---
async function getPredictedFlavorProfile(markdown) {
    const prompt = `You are a professional mead sommelier. Analyze this recipe and PREDICT its final flavor profile. Assign score 0-5 for: Sweetness, Acidity, Fruity/Floral, Spiciness, Earthy/Woody, Body/Mouthfeel. Output ONLY JSON. Recipe: "${markdown}"`;
    
    // We dwingen een JSON structuur af voor makkelijk parsen
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
        console.error("Could not generate flavor profile:", error);
        return null; // Geen ramp, we tonen gewoon geen grafiek
    }
}

// --- HELPER: Flavor Wheel Render (Chart.js) ---
function renderGeneratedFlavorWheel(flavorData) {
    const ctx = document.getElementById('generated-flavor-wheel');
    if (!ctx) return; // Als canvas niet bestaat, stop.
    
    const labels = ['Sweetness', 'Acidity', 'Fruity/Floral', 'Spiciness', 'Earthy/Woody', 'Body'];
    const data = [
        flavorData.sweetness, flavorData.acidity, flavorData.fruity_floral, 
        flavorData.spiciness, flavorData.earthy_woody, flavorData.body_mouthfeel
    ];
    
    // Kleuren ophalen uit CSS variabelen (zodat het matcht met je thema)
    const brandColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-color').trim() || '#d97706';
    const isDarkMode = document.documentElement.classList.contains('dark');
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDarkMode ? '#e0e0e0' : '#4a3c2c';

    // Oude grafiek opruimen om glitches te voorkomen
    if (window.generatedFlavorChartInstance) {
        window.generatedFlavorChartInstance.destroy();
    }

    // Nieuwe grafiek tekenen
    window.generatedFlavorChartInstance = new Chart(ctx.getContext('2d'), {
        type: 'radar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Predicted Profile',
                data: data,
                backgroundColor: brandColor + '4D', // Hex + Alpha voor transparantie
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
                    ticks: { color: textColor, backdropColor: 'transparent', stepSize: 1, display: false },
                    suggestedMin: 0, suggestedMax: 5
                }
            }
        }
    });
}

// --- HELPER: Creative Title Generator ---
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
        
        // Update de markdown variabele ook, zodat we bij opslaan de nieuwe titel hebben
        if (currentRecipeMarkdown) {
            currentRecipeMarkdown = currentRecipeMarkdown.replace(/^#\s*(.*)/m, `# ${cleanTitle}`);
            // Ook in tempState updaten voor consistentie
            tempState.currentRecipe = currentRecipeMarkdown;
        }
    } catch (error) {
        titleHeader.textContent = originalTitle; // Fallback naar origineel bij fout
    }
}

// --- HELPER: Haal data (OG, FG, ABV) uit de tekst voor logboek ---
function parseRecipeData(markdown) {
    const data = {};
    if (!markdown) return data;

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

// --- HELPER: Maak van ruwe JSON een mooie tabel ---
function formatRecipeMarkdown(markdown) {
    if (!markdown) return "";
    let finalMarkdown = markdown;

    // Zoek naar het JSON blok
    const jsonRegex = /(?:```json\s*([\s\S]*?)\s*```|(\[\s*\{[\s\S]*?\}\s*\]))/;
    const jsonMatch = finalMarkdown.match(jsonRegex); 

    if (jsonMatch && (jsonMatch[1] || jsonMatch[2])) {
        const jsonString = jsonMatch[1] || jsonMatch[2];
        try {
            // Maak JSON veilig
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
                
                // Rond af
                if (displayQty % 1 !== 0) { displayQty = parseFloat(displayQty.toFixed(2)); }
                
                tableMarkdown += `| ${item.ingredient} | ${displayQty} | ${displayUnit} |\n`;
            });
            
            // Vervang de code door de tabel
            finalMarkdown = finalMarkdown.replace(jsonRegex, tableMarkdown); 
        } catch (e) {
            console.error("Table format error:", e);
        }
    }
    return finalMarkdown;
}

// --- MAIN RENDER FUNCTION ---
async function renderRecipeOutput(markdown, isTweak = false) {
    const recipeOutput = document.getElementById('recipe-output');
    if (!recipeOutput) return;

    let finalMarkdown = markdown;
    
    // Zorg dat er altijd een titel is (nodig voor opslaan)
    if (!finalMarkdown.trim().startsWith('# ')) {
        finalMarkdown = `# Untitled Batch\n\n${finalMarkdown}`;
    }
    
    // Update state
    currentRecipeMarkdown = finalMarkdown;
    tempState.currentRecipe = finalMarkdown;

    // 1. Flavor Profile berekenen (Async)
    // We doen dit parallel aan het renderen zodat de tekst er alvast staat
    currentPredictedProfile = await getPredictedFlavorProfile(markdown); 
    
    // HTML voor flavor sectie
    let flavorProfileHtml = '<div id="flavor-profile-section" class="mt-8 pt-6 border-t border-app">';
    flavorProfileHtml += '<h3 class="text-2xl font-header font-bold text-center mb-4">Predicted Flavor Profile</h3>';

    if (currentPredictedProfile) {
        flavorProfileHtml += `<div class="card p-4 rounded-lg max-w-sm mx-auto"><canvas id="generated-flavor-wheel"></canvas></div>`;
    } else {
        flavorProfileHtml += `<div class="card p-4 rounded-lg max-w-sm mx-auto text-center"><p class="text-sm mb-4">Could not generate profile.</p><button id="retry-flavor-btn" onclick="window.regenerateFlavorProfile()" class="bg-purple-600 text-white py-2 px-4 rounded btn text-sm">Generate Profile</button><div id="flavor-generation-status" class="mt-2 text-sm"></div></div>`;
    }
    flavorProfileHtml += '</div>';
    
    // 2. Markdown formatteren (Tabellen netjes maken)
    // We gebruiken de helper functie uit Deel 4
    let processedMarkdown = formatRecipeMarkdown(finalMarkdown);

    // 3. Timers opschonen (verwijder [d:00:00] debug codes indien aanwezig)
    processedMarkdown = processedMarkdown.replace(/\[d:[\d:]+\]/g, ''); 
    
    // 4. Markdown naar HTML converteren
    if (typeof marked === 'undefined') {
        recipeOutput.innerHTML = `<pre>${processedMarkdown}</pre><p class="text-red-500">Error: Marked.js library missing.</p>`;
        return;
    }
    const recipeHtml = marked.parse(processedMarkdown);
    
    // 5. HTML Injecteren
    const fullHtml = `
            <div class="print-button-container text-right mb-4 flex justify-end flex-wrap gap-2 no-print">
                <button onclick="window.generateRecipe()" class="bg-app-action text-white py-2 px-4 rounded-lg hover:opacity-90 transition-colors btn text-sm flex items-center gap-1">
                   Retry
                </button>
                <button onclick="window.print()" class="bg-app-tertiary text-app-header border border-app-brand/30 py-2 px-4 rounded-lg hover:bg-app-secondary transition-colors btn">Print Recipe</button>
            </div>
            
            <div class="recipe-content prose dark:prose-invert max-w-none text-app-header">${recipeHtml}</div>
        
        <div id="water-recommendation-card" class="mt-4 p-4 border border-app-brand/30 bg-app-tertiary rounded-lg no-print transition-all">
            <div class="flex justify-between items-center">
                <div>
                    <h4 class="font-bold text-app-brand text-sm uppercase flex items-center gap-2">Water Chemistry</h4>
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

    // 6. Grafiek tekenen (als we data hebben)
    if (currentPredictedProfile) renderGeneratedFlavorWheel(currentPredictedProfile);

    // 7. Event Listeners koppelen aan de nieuwe knoppen
    const saveBtn = document.getElementById('saveBtn');
    if(saveBtn) {
        saveBtn.addEventListener('click', () => {
            // saveBrewToHistory komt in een later blok, dus we checken of hij bestaat
            if(window.saveBrewToHistory) window.saveBrewToHistory(currentRecipeMarkdown, currentPredictedProfile);
            else { console.error("saveBrewToHistory function missing!"); showToast("Error: Save function missing", "error"); }
        });
    }
    
    const tweakBtn = document.getElementById('tweak-unsaved-btn');
    if(tweakBtn) {
        tweakBtn.addEventListener('click', tweakUnsavedRecipe);
    }

    // 8. Branding genereren (alleen bij verse recepten, niet bij tweaks)
    if (!isTweak) {
        generateAndInjectCreativeTitle(finalMarkdown);
    }
}

// --- SCOPE FIX: USE STATE.INVENTORY ---
async function tweakUnsavedRecipe() {
    const tweakRequest = document.getElementById('tweak-unsaved-request').value.trim();
    if (!tweakRequest) { showToast("Please enter your tweak request.", "error"); return; }

    const tweakOutput = document.getElementById('tweak-unsaved-output');
    tweakOutput.innerHTML = getLoaderHtml("Analyzing Tweak Request..."); 
    
    const tweakBtn = document.getElementById('tweak-unsaved-btn');
    tweakBtn.disabled = true;

    // Start animatie
    const thinkingInterval = (typeof window.startThinkingAnimation === 'function') ? window.startThinkingAnimation("loader-text") : null;

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
    
    // FIX: Gebruik state.inventory, met een veilige fallback
    const currentInventory = state.inventory || [];
    const fullInventoryList = currentInventory.filter(item => relevantCategories.includes(item.category));
    const inventoryString = fullInventoryList.map(item => `${item.name} (${item.qty} ${item.unit})`).join('; ');
    const inventoryContext = `\n**INVENTORY CONTEXT:** The user has the following items in stock: [${inventoryString}]. If the tweak requires adding ingredients, prioritize these items.`;

    const safeMarkdown = currentRecipeMarkdown.replace(/`/g, "'"); 

    const prompt = `You are "MEA(N)DERY", a master mazer. User wants to tweak a recipe.
    
    **STRICT OUTPUT RULE:** Output ONLY the full Markdown Recipe. Start with "# Title".
    
    Original Recipe:
    ---
    ${safeMarkdown}
    ---

    User Tweak Request: "${tweakRequest}"

    **TASK:** Rewrite the FULL recipe to incorporate the tweak.
    
    **BRAND VOICE & CONTINUITY:**
    - Keep the original title "${preservedTitle || 'Untitled'}" unless the ingredients change drastically.
    
    ${laws}
    ${inventoryContext}

    **LOGIC CHECK:** If Batch Size changed -> Recalculate ALL ingredients.
    `; 

    try {
        const tweakedMarkdown = await performApiCall(prompt);
        if (thinkingInterval) clearInterval(thinkingInterval);

        let processedMarkdown = tweakedMarkdown.trim();
        if (processedMarkdown.startsWith("```markdown")) processedMarkdown = processedMarkdown.substring(11, processedMarkdown.lastIndexOf("```")).trim();
        else if (processedMarkdown.startsWith("```")) processedMarkdown = processedMarkdown.substring(3, processedMarkdown.lastIndexOf("```")).trim();

        currentRecipeMarkdown = processedMarkdown;
        await renderRecipeOutput(processedMarkdown, true);

        if (preservedTitle) {
            const newNameInput = document.querySelector('input[id^="recipeName-new"]');
            if(newNameInput) newNameInput.value = preservedTitle;
        }
        
        tweakBtn.disabled = false;
        tweakOutput.innerHTML = '';

    } catch (error) {
        if (thinkingInterval) clearInterval(thinkingInterval);
        console.error("Error tweaking:", error);
        tweakOutput.innerHTML = `<p class="text-red-500">Error: ${error.message}</p>`;
        tweakBtn.disabled = false;
    }
}

function applyWaterTweak(brandName, technicalInstruction) {
    const tweakInput = document.getElementById('tweak-unsaved-request');
    const section = document.getElementById('tweak-unsaved-section');
    if(section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });

    if(tweakInput) {
        tweakInput.value = `Update recipe for **${brandName}** water profile. \nNote: ${technicalInstruction} \nPlease recalculate nutrients and acidity buffering based on this specific mineral content.`;
        tweakInput.focus();
    }
}

// --- UI EVENT HANDLERS ---

function handleDescriptionInput() {
    // Deze functie zorgt dat de gedetailleerde opties grijs worden als je zelf typt
    const descriptionInput = document.getElementById('customDescription');
    const optionsContainer = document.querySelector('details[open] > div'); // Fallback selector
    // Of gebruik ID als je die in HTML hebt toegevoegd, bijv: 'structured-options-container'
    
    const warningMessage = document.getElementById('description-priority-warning');
    
    if(!descriptionInput) return;
    
    const hasText = descriptionInput.value.trim() !== '';
    
    // We zoeken de containers met inputs (in de details elementen)
    const detailsContainers = document.querySelectorAll('details .p-3');
    
    detailsContainers.forEach(container => {
        // Alleen inputs disablen die niet met inventory te maken hebben
        if(!container.innerHTML.includes('inventory-toggle')) {
            container.classList.toggle('opacity-50', hasText);
            container.classList.toggle('pointer-events-none', hasText);
            
            container.querySelectorAll('input, select').forEach(el => {
                if(el.id !== 'customDescription') el.disabled = hasText;
            });
        }
    });

    if(warningMessage) warningMessage.classList.toggle('hidden', !hasText);
}

function handleEquipmentTypeChange() {
     const type = document.getElementById('equipProfileType')?.value;
     const boilCont = document.getElementById('boil-off-rate-container');
     if(boilCont) boilCont.classList.toggle('hidden', type !== 'Kettle');
}

function handleStyleChange() {
    const styleSelect = document.getElementById('style');
    if(!styleSelect) return;
    const style = styleSelect.value.toLowerCase();
    
    document.getElementById('fruit-section')?.classList.toggle('hidden', !style.includes('melomel'));
    document.getElementById('spice-section')?.classList.toggle('hidden', !style.includes('metheglin'));
    document.getElementById('braggot-section')?.classList.toggle('hidden', !style.includes('braggot'));
}

// --- TUSSENTIJDSE EXPORTS ---
// We koppelen deze nu alvast aan window, zodat de HTML in Creator mode werkt
window.generateRecipe = generateRecipe;
window.applyWaterTweak = applyWaterTweak;
window.handleDescriptionInput = handleDescriptionInput;
window.handleStyleChange = handleStyleChange;
window.handleEquipmentTypeChange = handleEquipmentTypeChange;
window.regenerateFlavorProfile = async function() {
    // Retry knop wrapper
    if (currentRecipeMarkdown && typeof renderRecipeOutput === 'function') {
        const btn = document.getElementById('retry-flavor-btn');
        if(btn) btn.innerText = "Retrying...";
        await renderRecipeOutput(currentRecipeMarkdown);
    }
};

// ============================================================================
// brewing.js - BLOCK 3: BREW DAY ENGINE (PARSING & RENDER)
// ============================================================================

// --- SMART PARSER V2.4: Clean Titles & Auto-Timers ---
function extractStepsFromMarkdown(markdown) {
    if (!markdown) return { day1: [], day2: [] };

    const lines = markdown.split('\n');
    const day1 = [];
    const day2 = [];
    
    let isParsingInstructions = false;

    // Regexen
    const instructionHeaderRegex = /^(?:#+|__|\*\*)\s*(?:Instructions|Steps|Method|Procedure|Bereiding)(?:__|\*\*|:)?/i;
    const anyHeaderRegex = /^(?:#+|__|\*\*)\s*([a-zA-Z].*)/; 
    const prefixRegex = /^(?:Step\s+)?(\d+)[\.\)\s]\s*|^\s*[-*•]\s+/i;
    const blackList = ['abv:', 'batch size:', 'style:', 'sweetness:', 'og:', 'fg:', 'buy ', 'target '];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let cleanLine = line.trim();
        
        if (!cleanLine) continue;

        // Sectie detectie
        if (cleanLine.match(instructionHeaderRegex)) { isParsingInstructions = true; continue; }
        if (isParsingInstructions && cleanLine.match(anyHeaderRegex)) {
            if (cleanLine.startsWith('#')) break; 
            if (cleanLine.match(/(Note|Tip|Profile|Summary|Data)/i)) break;
        }
        if (!isParsingInstructions) continue;
        if (blackList.some(badWord => cleanLine.toLowerCase().includes(badWord))) continue;

        // 1. Verwijder nummers en bullets
        cleanLine = cleanLine.replace(prefixRegex, '');
        cleanLine = cleanLine.replace(/^\*\*|\*\*$/g, '').trim();

        if (cleanLine) {
            const lower = cleanLine.toLowerCase();
            
            // --- TITEL vs OMSCHRIJVING ---
            let title = "Action"; 
            let description = cleanLine;

            const colonSplit = cleanLine.match(/^([^:]+):\s*(.*)/);
            const boldSplit = cleanLine.match(/^\*\*([^*]+)\*\*\s*(.*)/);

            if (boldSplit) {
                title = boldSplit[1].replace(':', '').trim(); 
                description = boldSplit[2] || boldSplit[1]; 
            } else if (colonSplit && colonSplit[1].length < 50) {
                title = colonSplit[1].trim();
                description = colonSplit[2].trim();
            } else {
                const words = cleanLine.split(' ');
                if (words.length > 5) title = words.slice(0, 4).join(' ') + '...';
                else { title = cleanLine; description = ""; }
            }

            // --- TIMER LOGICA (De "Slimme Lezer") ---
            let duration = 0;
            
            // 1. Probeer de officiële AI Tag (flexibeler gemaakt)
            const timerMatch = description.match(/\[TIMER:\s*(\d+):(\d+):(\d+)\]/);
            
            if (timerMatch) {
                duration = (parseInt(timerMatch[1])*3600) + (parseInt(timerMatch[2])*60) + parseInt(timerMatch[3]);
                description = description.replace(timerMatch[0], '').trim();
                title = title.replace(/\[TIMER:.*?\]/, '').trim();
            } 
            // 2. FALLBACK: Zoek naar tekstuele aanwijzingen (Zoals in jouw voorbeeld!)
            else {
                const titleDesc = (title + " " + description).toLowerCase();
                
                // Check "24 Hours", "48 Hours" (Veelvoorkomend bij TOSNA)
                if (titleDesc.includes('24 hours') || titleDesc.includes('24 uur')) duration = 86400;
                else if (titleDesc.includes('48 hours') || titleDesc.includes('48 uur')) duration = 86400; 
                else if (titleDesc.includes('72 hours') || titleDesc.includes('72 uur')) duration = 86400;
                else if (titleDesc.includes('7 days') || titleDesc.includes('1 week')) duration = 604800;
                
                // Check minuten (bv "Wait 5 minutes")
                const minMatch = titleDesc.match(/wait\s+(\d+)\s*min/);
                if (minMatch) duration = parseInt(minMatch[1]) * 60;
            }

            const stepObj = { title, description, duration };

            // Fase bepalen
            const isSecondary = (
                lower.includes('rack into') || lower.includes('siphon') || 
                (lower.includes('secondary') && !lower.includes('primary')) || 
                lower.includes('stabiliz') || lower.includes('backsweeten') || 
                (lower.includes('bottle') && !lower.includes('clean')) || lower.includes('bottling') || 
                (lower.includes('aging') && !lower.includes('yeast')) || lower.includes('wait for clear')
            );

            isSecondary ? day2.push(stepObj) : day1.push(stepObj);
        }
    }
    
    // Correctie voor als alles in Day 2 belandt
    if (day1.length === 0 && day2.length > 0) {
        const splitIndex = day2.findIndex(s => s.description.toLowerCase().includes('rack'));
        if (splitIndex > 0) day1.push(...day2.splice(0, splitIndex));
        else { day1.push(...day2); day2.length = 0; }
    }

    return { day1, day2 };
}

// --- SMART START: CHECK STOCK FIRST ---
window.startBrewDay = async function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) return;

    // 1. Check de voorraad (zonder het scherm te tekenen, vandaar 'false')
    let isStockComplete = false;
    
    // We checken of de inventory module geladen is
    if (window.generateShoppingList) {
        isStockComplete = window.generateShoppingList(brewId, false);
    } else {
        // Als inventory niet bestaat, gaan we voor de zekerheid door
        isStockComplete = true; 
    }

    // 2. De Beslissing
    if (isStockComplete) {
        // A. Alles is er? -> Direct Brouwen! 🍺
        console.log("Stock complete. Skipping shopping list.");
        window.startActualBrewDay(brewId);
        showToast("Inventory complete! Starting Brew Day.", "success");
    } else {
        // B. Iets mist? -> Naar de Shopping List 🛒
        console.log("Items missing. Redirecting to shopping list.");
        switchMainView('brewing');
        switchSubView('shopping-list', 'brewing-main-view');
        
        // Nu renderen we de lijst wél, zodat je ziet wat je moet kopen
        if (window.generateShoppingList) {
            window.generateShoppingList(brewId, true);
        }
        showToast("Some items are missing. Check list.", "warning");
    }
}

// --- START ACTUAL BREW DAY ---
window.startActualBrewDay = async function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) return;

    // 1. Datum instellen (als die nog niet bestaat)
    if (!brew.logData) brew.logData = {};
    if (!brew.logData.brewDate) {
        brew.logData.brewDate = new Date().toISOString().split('T')[0];
        try {
            await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { 
                logData: brew.logData 
            });
            showToast("Brew date set to today!", "info");
        } catch (error) { console.error("Date save failed", error); }
    }

    // 2. CHECKLIST CONFLICT LOGICA (Uit oude file)
    // Als er al vinkjes staan, vraag om reset
    if (brew.checklist && Object.keys(brew.checklist).length > 0) {
        if (confirm("This batch has existing progress. Reset checklist and start over?")) {
            brew.checklist = {};
            try {
                await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { checklist: {} });
            } catch (e) { console.error("Reset failed", e); }
        }
    } else {
        // Zorg dat checklist object bestaat
        if(!brew.checklist) brew.checklist = {};
    }

    // 3. State update & Persistentie (HERSTELD)
    tempState.activeBrewId = brewId;
    
    // Sla op in database settings (zodat je op mobiel verder kunt waar je op desktop was)
    if (state.userSettings) {
        state.userSettings.currentBrewDay = { brewId: brewId };
        // We roepen de save functie aan als die bestaat (in utils of app.js)
        if (window.saveUserSettings) window.saveUserSettings();
        else {
            // Fallback save als functie niet bestaat
            try {
                await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main'), { 
                    currentBrewDay: { brewId: brewId } 
                }, { merge: true });
            } catch(e) { console.warn("Settings save failed", e); }
        }
    }
    
    // 4. UI Switch
    switchSubView('brew-day-1', 'brewing-main-view');
    renderBrewDay(brewId);
}

// --- RENDER: Brew Day 1 (Classic Logic) ---
window.renderBrewDay = function(brewId) {
    const brewDayContent = document.getElementById('brew-day-content');
    if (!brewDayContent) return;

    if (brewId === 'none' || !brewId) {
        brewDayContent.innerHTML = `<div class="text-center mt-10"><h2 class="text-3xl font-header font-bold mb-4">Brew Day</h2><p class="text-app-secondary">Select a recipe to start.</p></div>`;
        return;
    }

    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) return;

    // Stappen ophalen
    let primarySteps = brew.brewDaySteps || [];
    if (primarySteps.length === 0 && brew.recipeMarkdown) {
        const extracted = extractStepsFromMarkdown(brew.recipeMarkdown);
        primarySteps = extracted.day1;
        brew.brewDaySteps = extracted.day1; 
        brew.secondarySteps = extracted.day2; 
    }

    // HTML Genereren
    const stepsHtml = primarySteps.map((step, index) => {
        const checklist = brew.checklist || {};
        const stepData = checklist[`step-${index}`];
        const isCompleted = stepData === true || (stepData && stepData.completed);
        const savedAmount = (stepData && stepData.actualAmount) ? stepData.actualAmount : '';

        // Input detectie
        const amountMatch = (step.title + " " + step.description).match(/(\d+[.,]?\d*)\s*(kg|g|l|ml|oz|lbs)/i);
        let inputHtml = '';
        
        if (amountMatch && !isCompleted) {
            inputHtml = `<div class="mt-2 flex items-center bg-app-primary rounded border border-app-brand/20 w-32">
                <span class="px-2 text-[9px] font-bold text-app-secondary uppercase border-r border-app-brand/10">Act</span>
                <input type="number" id="step-input-${index}" class="w-full bg-transparent border-none p-1 text-center font-bold text-sm" placeholder="${amountMatch[1]}" value="${amountMatch[1]}">
                <span class="pr-2 text-xs font-bold text-app-brand">${amountMatch[2]}</span>
            </div>`;
        } else if (isCompleted && savedAmount) {
             inputHtml = `<div class="mt-2 text-xs font-bold text-green-700">Recorded: ${savedAmount}</div>`;
        }

        // Timer Display
        const timerHtml = step.duration > 0 
            ? `<div class="timer-display my-2 text-sm font-mono font-bold text-app-brand bg-app-primary inline-block px-2 py-1 rounded border border-app-brand/20" id="timer-${index}">${formatTime(step.duration)}</div>` 
            : '';
        
        // Knoppen
        const btnHtml = step.duration > 0 
            ? `<button onclick="window.startStepTimer('${brew.id}', ${index})" class="text-xs bg-green-600 text-white py-1.5 px-3 rounded shadow hover:bg-green-700 btn font-bold uppercase">Start Timer</button>` 
            : `<button onclick="window.completeStep(${index})" class="text-xs bg-app-tertiary border border-app-brand/30 text-app-brand font-bold py-1.5 px-3 rounded hover:bg-app-brand hover:text-white transition-colors btn uppercase">Check</button>`;

        return `
        <div id="step-${index}" class="step-item p-4 border-b border-app-brand/10 ${isCompleted ? 'opacity-60 grayscale' : ''}">
            <div class="flex justify-between items-start gap-4">
                <div class="flex-grow">
                    <p class="font-bold text-sm text-app-header flex items-center gap-2">
                        <span class="w-5 h-5 rounded-full bg-app-tertiary text-[10px] flex items-center justify-center border border-app-brand/20">${index + 1}</span> 
                        ${step.title}
                    </p>
                    <div class="pl-7">
                        <p class="text-xs text-app-secondary mt-1 opacity-90">${step.description}</p>
                        ${inputHtml}
                        ${timerHtml}
                    </div>
                </div>
                <div class="pt-1" id="controls-${index}">
                    ${isCompleted ? '<span class="text-[10px] font-bold text-white bg-green-600 px-2 py-1 rounded shadow-sm">DONE</span>' : btnHtml}
                </div>
            </div>
        </div>`;
    }).join('');

    const logHtml = (typeof getBrewLogHtml === 'function') ? getBrewLogHtml(brew.logData, brew.id) : '';

    brewDayContent.innerHTML = `
        <div class="bg-app-secondary p-4 rounded-lg shadow-lg">
            <div class="text-center mb-6"><h2 class="text-2xl font-header font-bold text-app-brand">${brew.recipeName}</h2></div>
            <div class="bg-app-secondary rounded-xl shadow-sm border border-app-brand/10 overflow-hidden mb-8">${stepsHtml}</div>
            ${logHtml}
            <div class="mt-6 space-y-3 border-t border-app-brand/10 pt-4">
                <button onclick="window.finishPrimaryManual('${brew.id}')" class="w-full bg-green-600 text-white py-3 px-4 rounded-lg font-bold uppercase">Finish Primary</button>
                <button onclick="window.updateBrewLog('${brew.id}', 'brew-day-content')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg font-bold uppercase">Save Logs</button>
            </div>
        </div>`;
}

// --- RENDER: Brew Day 2 (Aging/Secondary) ---
window.renderBrewDay2 = async function() {
    const container = document.getElementById('brew-day-2-view');
    if (!container) return;

    // 1. Zoek alle batches die in Fase 2 zitten (Primary klaar, niet gebotteld)
    const agingBrews = state.brews.filter(b => b.primaryComplete && !b.isBottled);
    
    // 2. Bepaal welke we moeten laten zien (Lijst of Detail?)
    const activeId = tempState.activeBrewId;
    const activeBrew = activeId ? agingBrews.find(b => b.id === activeId) : null;

    // --- SCENARIO A: LIJST WEERGAVE (Geen actieve selectie) ---
    if (!activeBrew) {
        if (agingBrews.length === 0) {
            container.innerHTML = `<div class="text-center p-8 bg-app-secondary rounded-lg"><h3 class="text-xl font-bold text-app-brand">The Cellar is Quiet</h3><p class="text-app-secondary">No batches in aging.</p></div>`;
            return;
        }
        
        const listHtml = agingBrews.map(b => {
            const startDate = b.logData?.brewDate || 'Unknown Date';
            return `<div onclick="window.openSecondaryDetail('${b.id}')" class="p-4 card rounded-lg cursor-pointer hover:bg-app-primary border-l-4 border-purple-500 shadow-sm transition-all mb-3"><h4 class="font-bold text-lg">${b.recipeName}</h4><p class="text-xs text-app-secondary">Started: ${startDate}</p></div>`;
        }).join('');
        
        container.innerHTML = `<div class="bg-app-secondary p-4 rounded-lg shadow-lg"><h2 class="text-2xl font-bold mb-6 text-center">Secondary / Aging</h2><div class="space-y-2">${listHtml}</div></div>`;
        return;
    }

    // --- SCENARIO B: DETAIL WEERGAVE (Specifieke batch) ---
    // Stappen ophalen (uit geheugen of parsen)
    let steps = activeBrew.secondarySteps || [];
    if (steps.length === 0 && activeBrew.recipeMarkdown) {
        steps = extractStepsFromMarkdown(activeBrew.recipeMarkdown).day2;
        // Cache opslaan
        activeBrew.secondarySteps = steps; 
    }
    // Fallback als er geen stappen zijn gevonden
    if (steps.length === 0) steps = [{ title: "Racking", description: "Transfer to secondary vessel." }, { title: "Bottling", description: "Package when clear." }];

    const checklist = activeBrew.checklist || {};
    
    const stepsHtml = steps.map((step, idx) => {
        const key = `sec-step-${idx}`;
        const isChecked = checklist[key] === true;
        
        const btnHtml = isChecked 
            ? `<span class="text-xs font-bold text-green-600 border border-green-600 px-2 py-0.5 rounded">DONE</span>` 
            : `<button onclick="window.toggleSecondaryStep('${activeBrew.id}', '${key}')" class="text-xs bg-app-tertiary border border-app-brand/30 text-app-brand font-bold py-1 px-3 rounded hover:bg-app-brand hover:text-white transition-colors btn uppercase">Check</button>`;
        
        return `<div class="p-3 border-b border-app-brand/10 flex justify-between items-start gap-3 ${isChecked ? 'opacity-60' : ''}"><div class="flex-grow"><p class="font-bold text-sm">${idx + 1}. ${step.title}</p><p class="text-xs text-app-secondary">${step.description}</p></div><div class="pt-1">${btnHtml}</div></div>`;
    }).join('');

    // Logs laden (Deel 9 functie)
    const logHtml = (typeof getBrewLogHtml === 'function') ? getBrewLogHtml(activeBrew.logData, activeBrew.id + '-sec') : '';

    container.innerHTML = `
        <div class="bg-app-secondary p-4 rounded-lg shadow-lg">
            <div class="flex items-center justify-between mb-4 pb-2 border-b border-app-brand/10"><button onclick="window.closeSecondaryDetail()" class="text-xs font-bold text-app-secondary uppercase hover:text-app-brand">&larr; Back to List</button><span class="text-[10px] font-bold uppercase text-app-brand opacity-60">Phase 2</span></div>
            <h2 class="text-2xl font-bold mb-6 text-center text-app-brand">${activeBrew.recipeName}</h2>
            <div class="mb-6 bg-app-secondary rounded-lg shadow-sm border border-app-brand/10">${stepsHtml}</div>
            <div id="brew-day-2-log-container">${logHtml}</div>
            <div class="mt-6 space-y-3"><button onclick="window.updateBrewLog('${activeBrew.id}', 'brew-day-2-log-container')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg hover:opacity-90 btn font-bold text-sm">Save Log</button><button onclick="window.showBottlingModal('${activeBrew.id}')" class="w-full bg-green-600 text-white py-3 px-4 rounded-lg hover:bg-green-700 btn font-bold text-sm">Proceed to Bottling</button></div>
        </div>`;
}

// --- LOGIC: Navigation Helpers ---
window.openSecondaryDetail = (brewId) => { 
    tempState.activeBrewId = brewId; 
    renderBrewDay2(); 
    // Scroll naar boven zodat de gebruiker ziet dat er iets gebeurd is
    document.getElementById('brewing-main-view').scrollIntoView({ behavior: 'smooth' }); 
};

window.closeSecondaryDetail = () => { 
    tempState.activeBrewId = null; 
    renderBrewDay2(); 
};

// --- LOGIC: Timers & Checklist (Primary) ---

window.startStepTimer = function(brewId, stepIndex, resumeTime = null) {
    console.log(`⏱️ Starting Timer: Brew ${brewId}, Step ${stepIndex}`);

    // 1. Stop lopende timers
    if (stepTimerInterval) {
        clearInterval(stepTimerInterval);
        stepTimerInterval = null;
    }
    
    // 2. Zoek het recept in het geheugen
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) {
        console.error("Timer Error: Brew not found in state.");
        alert("Error: Could not find active batch data. Please refresh the page.");
        return;
    }
    
    // 3. Haal de stappen op (Day 1)
    // We moeten zeker weten dat brewDaySteps gevuld is
    let allSteps = brew.brewDaySteps;
    if (!allSteps || allSteps.length === 0) {
        // Fallback: probeer ze opnieuw te parsen als ze ontbreken
        console.warn("Timer Warning: Steps missing, reparsing...");
        const extracted = extractStepsFromMarkdown(brew.recipeMarkdown);
        allSteps = extracted.day1;
        brew.brewDaySteps = allSteps; // Cache herstellen
    }

    const step = allSteps[stepIndex];
    if (!step) {
        console.error("Timer Error: Step not found at index", stepIndex);
        return;
    }

    // 4. UI Elementen zoeken
    const timerDisplay = document.getElementById(`timer-${stepIndex}`);
    const controlsDiv = document.getElementById(`controls-${stepIndex}`);

    if (!timerDisplay) {
        console.error(`Timer Error: Display element 'timer-${stepIndex}' not found.`);
        return;
    }

    // 5. Starttijd bepalen
    let timeLeft = resumeTime !== null ? resumeTime : step.duration;
    
    // Direct updaten zodat je niet 1 seconde hoeft te wachten
    timerDisplay.textContent = formatTime(timeLeft);
    timerDisplay.classList.add('text-green-600', 'scale-110'); // Visuele feedback

    // 6. Knoppen veranderen naar Pause
    if (controlsDiv) {
        controlsDiv.innerHTML = `
            <button onclick="window.pauseStepTimer('${brewId}', ${stepIndex})" class="text-xs bg-yellow-500 text-white py-1.5 px-3 rounded font-bold uppercase mr-1 hover:bg-yellow-600">Pause</button>
            <button onclick="window.skipTimer('${brewId}', ${stepIndex})" class="text-xs bg-gray-500 text-white py-1.5 px-3 rounded font-bold uppercase hover:bg-gray-600">Skip</button>
        `;
    }

    // 7. De Interval Loop
    stepTimerInterval = setInterval(() => {
        timeLeft--;
        
        if (timerDisplay) timerDisplay.textContent = formatTime(timeLeft);
        
        // Opslaan in LocalStorage voor als de pagina ververst wordt (Mini-feature)
        const timerState = { brewId, stepIndex, endTime: Date.now() + (timeLeft * 1000) };
        localStorage.setItem('activeBrewDayTimer', JSON.stringify(timerState));

        if (timeLeft <= 0) {
            clearInterval(stepTimerInterval);
            stepTimerInterval = null;
            localStorage.removeItem('activeBrewDayTimer');
            
            if (timerDisplay) {
                timerDisplay.textContent = "Done!";
                timerDisplay.classList.remove('text-green-600', 'scale-110');
            }
            
            // Geluidje / Trillen
            if(navigator.vibrate) navigator.vibrate([200, 100, 200]); 
            
            window.completeStep(stepIndex, true); 
        }
    }, 1000);
}

window.pauseStepTimer = function(brewId, stepIndex) {
    if (stepTimerInterval) { clearInterval(stepTimerInterval); stepTimerInterval = null; }
    // Zet UI terug naar 'Resume'
    const controlsDiv = document.getElementById(`controls-${stepIndex}`);
    if (controlsDiv) controlsDiv.innerHTML = `<button onclick="window.startStepTimer('${brewId}', ${stepIndex})" class="text-xs bg-green-600 text-white py-1.5 px-3 rounded font-bold uppercase">Resume</button>`;
}

window.skipTimer = function(brewId, stepIndex) {
    if (stepTimerInterval) { clearInterval(stepTimerInterval); stepTimerInterval = null; }
    window.completeStep(stepIndex, true);
}

window.completeStep = async function(stepIndex, isSkipping = false) {
    const brewId = tempState.activeBrewId;
    if (!brewId) return;
    const brew = state.brews.find(b => b.id === brewId);
    if(!brew) return;
    
    if (!brew.checklist) brew.checklist = {};
    
    // 1. Data Opslaan (Input values & Check status)
    const inputEl = document.getElementById(`step-input-${stepIndex}`);
    const actualAmount = inputEl ? inputEl.value : null;
    
    brew.checklist[`step-${stepIndex}`] = { 
        completed: true, 
        actualAmount: actualAmount,
        timestamp: new Date().toISOString() // Handig voor logboek later
    };

    // 2. UI Update (Direct feedback: maak grijs en toon DONE)
    const stepDiv = document.getElementById(`step-${stepIndex}`);
    if(stepDiv) stepDiv.classList.add('opacity-60', 'grayscale');
    
    const controls = document.getElementById(`controls-${stepIndex}`);
    if(controls) controls.innerHTML = `<span class="text-[10px] font-bold text-white bg-green-600 px-2 py-1 rounded shadow-sm">DONE</span>`;

    // 3. Opslaan in Database
    try { 
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { 
            checklist: brew.checklist
        }); 
    } catch (e) { console.error(e); }

    // 4. Auto-start de volgende timer? (Alleen bij korte timers)
    const allSteps = brew.brewDaySteps || [];
    const nextStep = allSteps[stepIndex + 1];
    
    // Als de volgende stap een timer heeft die KORTER is dan een uur (3600 sec), start hem dan automatisch.
    // Bij 24 uur (86400 sec) wachten we liever tot de gebruiker zelf klikt.
    if (nextStep && nextStep.duration > 0 && nextStep.duration < 3600 && !isSkipping) {
        window.startStepTimer(brewId, stepIndex + 1);
    }
}

// --- MISSING FUNCTION: FINALIZE DAY 1 ---
window.finalizeBrewDay1 = async function() {
    // 1. Sla de logs op
    if (tempState.activeBrewId) {
        await window.updateBrewLog(tempState.activeBrewId, 'brew-day-content');
    }
    
    // 2. Navigeer naar Dag 2
    renderBrewDay2();
    switchSubView('brew-day-2', 'brewing-main-view');
    
    // 3. Reset pointers
    tempState.activeBrewId = null;
    
    // 4. Update persistentie
    if (state.userSettings) {
        state.userSettings.currentBrewDay = { brewId: null };
        if (window.saveUserSettings) window.saveUserSettings();
    }
    
    // 5. Reset Dag 1 UI
    renderBrewDay('none');
}

// --- SCOPE FIX: USE STATE.BREWS & STATE.USERID ---
window.toggleSecondaryStep = async function(brewId, stepKey) {
    const brewIndex = state.brews.findIndex(b => b.id === brewId); // Was: brews.findIndex
    if (brewIndex === -1) return;

    // Initialiseer checklist als die niet bestaat
    if (!state.brews[brewIndex].checklist) state.brews[brewIndex].checklist = {};

    // Toggle de status
    const currentStatus = state.brews[brewIndex].checklist[stepKey] === true;
    state.brews[brewIndex].checklist[stepKey] = !currentStatus;

    // UI Update
    renderBrewDay2();

    // Opslaan in Cloud
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { // Was: userId
            checklist: state.brews[brewIndex].checklist
        });
        if(navigator.vibrate) navigator.vibrate(10);
    } catch (e) {
        console.error("Checklist save failed:", e);
        showToast("Saving failed", "error");
    }
}

// --- LOGIC: Reset & Finish ---
window.resetBrewDay = async function() {
    if (!confirm("Reset all progress for this day?")) return;
    const brewId = tempState.activeBrewId;
    const brew = state.brews.find(b => b.id === brewId);
    if(brew) {
        brew.checklist = {};
        if (stepTimerInterval) clearInterval(stepTimerInterval);
        
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { checklist: {} });
        renderBrewDay(brewId); // Scherm verversen
    }
}

window.finishPrimaryManual = async function(brewId) {
    if (!confirm("Confirm: Primary Fermentation complete? Moving to Aging.")) return;
    try {
        // DB Update
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { primaryComplete: true });
        
        // Local Update
        const brew = state.brews.find(b => b.id === brewId);
        if(brew) brew.primaryComplete = true;
        
        showToast("Moved to Secondary!", "success");
        
        // Switch Views
        switchSubView('brew-day-2', 'brewing-main-view');
        tempState.activeBrewId = null; // Zorg dat lijst toont, niet direct detail
        renderBrewDay2();
        renderBrewDay('none'); // Clear day 1
    } catch (e) { console.error(e); showToast("Error updating status", "error"); }
}

// --- MISSING HELPER: MARK PRIMARY AS COMPLETE ---
async function markPrimaryAsComplete(brewId) {
    if (!state.userId || !brewId) return;
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { primaryComplete: true });
        
        const idx = state.brews.findIndex(b => b.id === brewId);
        if (idx > -1) {
            state.brews[idx].primaryComplete = true;
        }
    } catch (e) { console.error("Error marking primary complete:", e); }
}

// ============================================================================
// brewing.js - BLOCK 4: HISTORY & LOGGING (SPLIT PART A)
// ============================================================================

// --- HISTORY: Load Data from Firebase ---
async function loadHistory() {
    if (!state.userId) return;
    
    // Real-time listener op de 'brews' collectie
    const q = query(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews'));
    
    onSnapshot(q, (snapshot) => {
        state.brews = snapshot.docs.map(doc => {
            let b = { id: doc.id, ...doc.data() };
            
            // --- MIGRATIE FIX (V1 -> V2) ---
            // Zorgt dat oude recepten (zonder logData object) niet crashen
            if (!b.logData) b.logData = {};
            
            // Velden die vroeger los stonden, kopieren we naar logData
            const oldFields = ['actualOG', 'actualFG', 'targetOG', 'targetFG', 'targetABV', 'finalABV', 'brewDate', 'agingNotes', 'tastingNotes', 'recipeName'];
            oldFields.forEach(field => {
                if (b[field] !== undefined && b.logData[field] === undefined) {
                    b.logData[field] = b[field];
                }
            });
            return b;
        });

        // Sorteer: Nieuwste bovenaan
        state.brews.sort((a, b) => {
            const dateA = a.createdAt ? a.createdAt.toDate() : new Date(0);
            const dateB = b.createdAt ? b.createdAt.toDate() : new Date(0);
            return dateB - dateA;
        });

        // Update de UI
        renderHistoryList();

        if(window.populateSocialRecipeDropdown) window.populateSocialRecipeDropdown();
        if(window.updateDashboardStats) window.updateDashboardStats();
        if(typeof updateCostAnalysis === 'function') updateCostAnalysis(); // Oude functionaliteit
        if(typeof renderActiveBrewTimeline === 'function') renderActiveBrewTimeline(); // Oude functionaliteit
    });
}

// --- RENDER: History List Sidebar ---
function renderHistoryList() {
    const list = document.getElementById('history-list');
    if (!list) return;

    const term = document.getElementById('history-search-input')?.value.toLowerCase() || '';
    const filtered = state.brews.filter(b => (b.recipeName || 'Untitled').toLowerCase().includes(term));
    
    if (state.brews.length === 0) { list.innerHTML = `<p class="text-center text-app-secondary/80 text-sm italic">No brews yet. Start creating!</p>`; return; }
    if (filtered.length === 0) { list.innerHTML = `<p class="text-center text-app-secondary/80 text-sm">No matches found.</p>`; return; }

    list.innerHTML = filtered.map(b => {
        const dateStr = b.createdAt ? b.createdAt.toDate().toLocaleDateString() : 'Saving...';
        return `
        <div class="p-4 card rounded-lg cursor-pointer hover:bg-app-primary border border-transparent hover:border-app-brand/10 transition-colors" onclick="window.showBrewDetail('${b.id}')">
            <h4 class="font-bold text-lg font-header text-app-header truncate">${b.recipeName}</h4>
            <div class="flex justify-between items-center mt-1">
                <p class="text-xs text-app-secondary">${dateStr}</p>
                ${b.primaryComplete ? '<span class="text-[10px] bg-green-100 text-green-800 px-1.5 py-0.5 rounded font-bold uppercase">Aging</span>' : ''}
            </div>
        </div>`;
    }).join('');
}

// ============================================================================
// brewing.js - BLOCK 4: HISTORY & LOGGING (SPLIT PART B: LOGBOOK HELPERS)
// ============================================================================

// --- PARSER: Haal ingrediënten uit Markdown (JSON, Tabel of Lijst) ---
export function parseIngredientsFromMarkdown(markdown) {
    let ingredients = [];
    if (!markdown) return ingredients;

    // 1. POGING 1: JSON BLOK (De standaard)
    const jsonRegex = /(?:```json\s*)?(\[\s*\{[\s\S]*?\}\s*\])(?:\s*```)?/;
    const jsonMatch = markdown.match(jsonRegex);

    if (jsonMatch && jsonMatch[1]) {
        try {
            let safeJson = jsonMatch[1].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            const arr = JSON.parse(safeJson);
            return arr.map(i => ({ 
                name: (i.ingredient||'').trim(), 
                quantity: parseFloat(i.quantity)||0, 
                unit: (i.unit||'').trim() 
            }));
        } catch (e) { 
            console.warn("JSON parse mislukt, we proberen de tabel...", e); 
        }
    }

    // 2. POGING 2: MARKDOWN TABEL (Fallback)
    const lines = markdown.split('\n');
    let insideTable = false;

    for (let line of lines) {
        if (line.includes('|---')) { insideTable = true; continue; }
        
        if (insideTable && line.trim().startsWith('|')) {
            const cols = line.split('|').map(c => c.trim()).filter(c => c);
            if (cols.length >= 2) {
                if (cols[0].toLowerCase().includes('ingredient')) continue;
                ingredients.push({
                    name: cols[0], 
                    quantity: parseFloat(cols[1]) || 0, 
                    unit: cols[2] || ''
                });
            }
        } else if (insideTable && line.trim() === '') {
            insideTable = false;
        }
    }

    // 3. POGING 3: SIMPELE LIJST (Laatste redmiddel)
    if (ingredients.length === 0) {
        const listRegex = /^[-*]\s+(\d+[.,]?\d*)\s*([a-zA-Z]+)\s+(.*)$/gm;
        let match;
        while ((match = listRegex.exec(markdown)) !== null) {
            ingredients.push({
                quantity: parseFloat(match[1]),
                unit: match[2],
                name: match[3]
            });
        }
    }

    return ingredients;
}

// --- HTML GENERATOR: Actual Ingredients Table ---
// Dit is de functie die eerder ontbrak!
function getActualIngredientsHtml(brew) {
    if (!brew || !brew.recipeMarkdown) return '';

    const planned = parseIngredientsFromMarkdown(brew.recipeMarkdown);
    const actuals = brew.logData?.actualIngredients || [];
    
    if (planned.length === 0) return '';

    const rows = planned.map(p => {
        // Zoek of we al een opgeslagen waarde hebben
        const saved = actuals.find(a => a.name === p.name);
        const val = saved ? saved.actualQty : p.quantity;
        
        return `
        <tr data-name="${p.name}" data-plannedqty="${p.quantity}" data-plannedunit="${p.unit}">
            <td class="py-2 px-3 font-medium text-app-header text-xs border-b border-app-brand/5">${p.name}</td>
            <td class="py-2 px-3 text-app-secondary text-xs border-b border-app-brand/5">${p.quantity} ${p.unit}</td>
            <td class="py-2 px-3 border-b border-app-brand/5">
                <input type="number" step="0.01" class="actual-qty-input w-20 p-1 border rounded bg-app-primary border-app-brand/20 text-app-header text-right font-mono text-xs focus:ring-1 focus:ring-app-brand" value="${val}">
            </td>
            <td class="py-2 px-3 text-xs text-app-secondary border-b border-app-brand/5">${p.unit}</td>
        </tr>`;
    }).join('');

    return `
    <div class="log-item mt-6 border-t border-app-brand/10 pt-4">
        <label class="text-xs font-bold text-app-secondary uppercase mb-2 block">Actual Ingredients Used</label>
        <div class="overflow-x-auto rounded border border-app-brand/20 bg-app-tertiary/30">
            <table class="w-full text-left" id="actualsTable-${brew.id}">
                <thead class="bg-app-tertiary text-[10px] uppercase text-app-secondary font-bold">
                    <tr>
                        <th class="p-2 pl-3">Ingredient</th>
                        <th class="p-2">Planned</th>
                        <th class="p-2">Actual</th>
                        <th class="p-2">Unit</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-app-brand/5">
                    ${rows}
                </tbody>
            </table>
        </div>
    </div>`;
}

// --- RESTORED V2.3 LOGBOOK: ACTUALS ONLY ---
function getBrewLogHtml(logData, idSuffix) {
    const data = logData || {};
    const fermLog = data.fermentationLog || [];
    const blendingLog = data.blendingLog || []; 

    // Fermentatie Rijen
    const fermRows = fermLog.map(row => `<tr>
        <td><input type="date" value="${row.date || ''}" class="w-full bg-transparent border-none focus:ring-0 text-xs"></td>
        <td><input type="number" step="0.5" value="${row.temp || ''}" class="w-full bg-transparent border-none focus:ring-0 text-center text-xs" placeholder="20"></td>
        <td><input type="number" step="0.001" value="${row.sg || ''}" class="w-full bg-transparent border-none focus:ring-0 text-center text-xs font-mono" placeholder="1.xxx" oninput="window.syncLogToFinal('${idSuffix}')"></td>
        <td><input type="text" value="${row.notes || ''}" class="w-full bg-transparent border-none focus:ring-0 text-xs" placeholder="..."></td>
    </tr>`).join('');

    // Blending Rijen
    const blendingRows = blendingLog.map((row, idx) => `
        <tr>
            <td><input type="date" value="${row.date || ''}" class="w-full bg-transparent border-none text-xs"></td>
            <td><input type="text" value="${row.name || ''}" class="w-full bg-transparent border-none text-xs" placeholder="Spirit Name"></td>
            <td><input type="number" step="0.01" value="${row.vol || ''}" class="w-full bg-transparent border-none text-center text-xs" oninput="window.recalcTotalABV('${idSuffix}')"></td>
            <td><input type="number" step="0.1" value="${row.abv || ''}" class="w-full bg-transparent border-none text-center text-xs" oninput="window.recalcTotalABV('${idSuffix}')"></td>
            <td class="text-center"><button onclick="this.closest('tr').remove(); window.recalcTotalABV('${idSuffix}')" class="text-red-500 font-bold hover:text-red-700">&times;</button></td>
        </tr>`).join('');

    return `
    <div class="brew-log-section mt-6 bg-app-secondary p-4 rounded-lg border border-app-brand/10 shadow-sm" data-id="${idSuffix}">
        <h3 class="font-header text-lg font-bold mb-4 text-app-brand uppercase tracking-wider flex items-center gap-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
            Brew Log (Actuals)
        </h3>
        
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 p-4 bg-app-tertiary/30 rounded-lg border border-app-brand/5">
            <div>
                <label class="text-[10px] font-bold text-app-secondary uppercase tracking-wider">OG (Start)</label>
                <input type="number" step="0.001" id="actualOG-${idSuffix}" value="${data.actualOG || ''}" class="w-full mt-1 p-2 border rounded bg-app-primary font-mono font-bold text-app-header focus:ring-1 focus:ring-app-brand" placeholder="1.xxx" oninput="window.autoCalculateABV('${idSuffix}')">
            </div>
            <div>
                <label class="text-[10px] font-bold text-app-secondary uppercase tracking-wider">FG (Current/End)</label>
                <input type="number" step="0.001" id="actualFG-${idSuffix}" value="${data.actualFG || ''}" class="w-full mt-1 p-2 border rounded bg-app-primary font-mono font-bold text-app-header focus:ring-1 focus:ring-app-brand" placeholder="1.xxx" oninput="window.autoCalculateABV('${idSuffix}')">
            </div>
            <div>
                <label class="text-[10px] font-bold text-app-secondary uppercase tracking-wider">Real ABV</label>
                <input type="text" id="finalABV-${idSuffix}" value="${data.finalABV || ''}" class="w-full mt-1 p-2 border rounded bg-app-primary font-bold text-app-brand" placeholder="0.0%">
            </div>
            <div>
                <label class="text-[10px] font-bold text-app-secondary uppercase tracking-wider">Brew Date</label>
                <input type="date" id="brewDate-${idSuffix}" value="${data.brewDate || ''}" class="w-full mt-1 p-2 border rounded bg-app-primary text-sm">
            </div>
        </div>

        <div class="mb-6">
            <label class="text-xs font-bold text-app-secondary uppercase mb-2 block">Fermentation History</label>
            <div class="overflow-x-auto rounded border border-app-brand/20 bg-app-primary">
                <table class="w-full text-left text-sm" id="fermentationTable-${idSuffix}">
                    <thead class="bg-app-tertiary text-[10px] uppercase text-app-secondary font-bold">
                        <tr><th class="p-2 w-32">Date</th><th class="p-2 w-20 text-center">Temp</th><th class="p-2 w-24 text-center">Gravity</th><th class="p-2">Notes</th></tr>
                    </thead>
                    <tbody class="divide-y divide-app-brand/5">
                        ${fermRows}
                        <tr class="bg-app-tertiary/10">
                            <td><input type="date" class="w-full bg-transparent border-none focus:ring-0 text-xs"></td>
                            <td><input type="number" step="0.5" class="w-full bg-transparent border-none focus:ring-0 text-center text-xs" placeholder="-"></td>
                            <td><input type="number" step="0.001" class="w-full bg-transparent border-none focus:ring-0 text-center text-xs font-mono" placeholder="1.xxx" oninput="window.syncLogToFinal('${idSuffix}')"></td>
                            <td><input type="text" class="w-full bg-transparent border-none focus:ring-0 text-xs" placeholder="Add measurement..."></td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <button onclick="window.addLogLine('${idSuffix}')" class="mt-2 text-[10px] font-bold text-app-brand hover:underline flex items-center gap-1 uppercase tracking-wider"><span>+</span> Add Row</button>
        </div>

        <div class="space-y-4 pt-4 border-t border-app-brand/10">
            <div><label class="text-xs font-bold text-app-secondary uppercase">Process Notes</label><textarea id="agingNotes-${idSuffix}" rows="2" class="w-full mt-1 p-2 border rounded bg-app-primary text-xs focus:ring-app-brand placeholder-gray-400" placeholder="Racking, stabilization, oak additions...">${data.agingNotes || ''}</textarea></div>
            <div><label class="text-xs font-bold text-app-secondary uppercase">Tasting Notes</label><textarea id="tastingNotes-${idSuffix}" rows="2" class="w-full mt-1 p-2 border rounded bg-app-primary text-xs focus:ring-app-brand placeholder-gray-400" placeholder="Aroma, mouthfeel, sweetness, faults...">${data.tastingNotes || ''}</textarea></div>
        </div>
    </div>`;
}

// --- RENDER: Detail View (RESTORED TARGET VS ACTUAL) ---
window.showBrewDetail = function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) return;

    switchMainView('brewing');
    switchSubView('history', 'brewing-main-view');

    // 1. Markdown Format
    let processedMarkdown = brew.recipeMarkdown || "";
    processedMarkdown = formatRecipeMarkdown(processedMarkdown);
    const cleanMarkdown = processedMarkdown.replace(/\[d:[\d:]+\]/g, '').replace(/^#\s.*$/m, '');
    const recipeHtml = marked.parse(cleanMarkdown);

    // 2. DATA SPLITSEN (CRUCIAAL)
    // A. Targets: Wat de AI berekende (uit Markdown)
    const targets = parseRecipeData(brew.recipeMarkdown);
    
    // B. Actuals: Wat jij gemeten hebt (uit Database)
    // Als Actuals leeg zijn, nemen we NIET de Targets over (behalve OG misschien als startpunt)
    const logData = brew.logData || {};
    
    // 3. KEY STATS HTML (TARGETS)
    const keyStatsHtml = `
    <div class="mb-6 p-4 bg-white dark:bg-gray-800 rounded-lg border border-app-brand/20 shadow-sm">
        <h3 class="font-header text-lg font-bold mb-3 text-app-brand uppercase tracking-wider">Key Stats (Target)</h3>
        <div class="grid grid-cols-4 gap-4 text-center">
            <div><span class="block text-[10px] text-app-secondary uppercase font-bold">OG</span><span class="text-xl font-mono font-bold text-app-header">${targets.targetOG || '--'}</span></div>
            <div><span class="block text-[10px] text-app-secondary uppercase font-bold">FG</span><span class="text-xl font-mono font-bold text-app-header">${targets.targetFG || '--'}</span></div>
            <div><span class="block text-[10px] text-app-secondary uppercase font-bold">ABV</span><span class="text-xl font-mono font-bold text-app-header">${targets.targetABV ? targets.targetABV.replace('%','') + '%' : '--'}</span></div>
            <div><span class="block text-[10px] text-app-secondary uppercase font-bold">Batch</span><span class="text-xl font-mono font-bold text-app-header">${brew.batchSize || 5}L</span></div>
        </div>
    </div>`;

    // 4. Logboek Genereren (Actuals)
    let logHtml = getBrewLogHtml(logData, brew.id);
    logHtml += getActualIngredientsHtml(brew); // De ingrediënten tabel

    // 5. Kosten Info
    const currency = state.userSettings?.currencySymbol || '€';
    let costHtml = '';
    if (brew.totalCost > 0) {
        const realVol = (logData.currentVolume && parseFloat(logData.currentVolume) > 0) ? parseFloat(logData.currentVolume) : (brew.batchSize || 5);
        const perL = realVol > 0 ? brew.totalCost / realVol : 0;
        costHtml = `<div class="mt-4 p-3 bg-amber-50 border border-amber-200 rounded text-amber-900 text-sm flex justify-between items-center shadow-sm"><span><strong>Total Cost:</strong> ${currency}${brew.totalCost.toFixed(2)}</span><span><strong>Cost/L:</strong> ${currency}${perL.toFixed(2)}</span></div>`;
    }

    const container = document.getElementById('history-detail-container');
    const listContainer = document.getElementById('history-list-container');
    
    container.innerHTML = `
        <button onclick="window.goBackToHistoryList()" class="mb-4 text-app-brand hover:underline font-bold text-sm no-print flex items-center gap-1">&larr; Back to List</button>
        
        <div class="mb-6 border-b border-app-brand/10 pb-4">
            <div id="title-display-${brew.id}" class="flex justify-between items-start">
                <h2 class="text-3xl font-header font-bold text-app-header">${brew.recipeName}</h2>
                <button onclick="window.showTitleEditor('${brew.id}')" class="text-app-brand hover:text-app-action text-sm no-print">Edit Title</button>
            </div>
            <div id="title-editor-${brew.id}" class="hidden mt-2">
                <input type="text" id="title-input-${brew.id}" value="${brew.recipeName}" class="w-full text-xl font-bold p-2 border rounded mb-2 bg-app-tertiary text-app-header">
                <div class="flex gap-2">
                    <button onclick="window.saveNewTitle('${brew.id}')" class="bg-green-600 text-white px-3 py-1 rounded text-sm font-bold">Save</button>
                    <button onclick="window.hideTitleEditor('${brew.id}')" class="bg-gray-500 text-white px-3 py-1 rounded text-sm font-bold">Cancel</button>
                </div>
            </div>
        </div>

        <div class="print-button-container mb-6 grid grid-cols-2 md:grid-cols-4 gap-2 no-print">
            <button onclick="window.resumeBrew('${brew.id}')" class="bg-green-600 text-white py-2 px-3 rounded btn font-bold shadow-sm hover:bg-green-700 text-xs uppercase tracking-wider">Start / Resume</button>
            <button onclick="window.cloneBrew('${brew.id}')" class="bg-blue-600 text-white py-2 px-3 rounded btn font-bold shadow-sm hover:bg-blue-700 text-xs uppercase tracking-wider">Brew Again</button>
            <button onclick="window.recalculateBatchCost('${brew.id}')" class="bg-purple-600 text-white py-2 px-3 rounded btn font-bold shadow-sm hover:bg-purple-700 text-xs uppercase tracking-wider">Recalc Cost</button>
            <button onclick="window.deleteBrew('${brew.id}')" class="bg-red-600 text-white py-2 px-3 rounded btn font-bold shadow-sm hover:bg-red-700 text-xs uppercase tracking-wider">Delete</button>
        </div>

        ${keyStatsHtml} <div class="recipe-content prose dark:prose-invert max-w-none text-app-header bg-app-secondary p-4 rounded-lg shadow-sm border border-app-brand/5 mb-4">
            ${recipeHtml}
        </div>
        ${costHtml}
        
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8 mt-6">
            <div class="bg-white dark:bg-gray-800 p-2 rounded-lg border border-app-brand/10 shadow-sm">
                <h4 class="text-xs font-bold text-center uppercase text-app-secondary mb-2">Fermentation Curve</h4>
                <canvas id="fermChart-${brew.id}" style="max-height: 250px;"></canvas>
            </div>
            <div class="bg-white dark:bg-gray-800 p-2 rounded-lg border border-app-brand/10 shadow-sm">
                <h4 class="text-xs font-bold text-center uppercase text-app-secondary mb-2">Flavor Profile</h4>
                <div id="flavor-wheel-container-${brew.id}" class="h-full flex items-center justify-center"></div>
            </div>
        </div>

        ${logHtml}
        
        <div class="mt-4 no-print pb-8 space-y-4">
            <button onclick="window.updateBrewLog('${brew.id}', 'history-detail-container')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg btn font-bold shadow-md uppercase tracking-wider">Save Log Changes</button>
            
            <div class="pt-4 border-t border-app-brand/10">
                 <h3 class="text-lg font-header font-bold mb-2">Tweak This Recipe</h3>
                 <div class="card p-4 rounded-lg bg-app-primary">
                    <textarea id="tweak-request-${brew.id}" rows="2" class="w-full p-2 border rounded-md bg-app-tertiary text-sm" placeholder="e.g. Make it sweeter, add cherries..."></textarea>
                    <button onclick="window.freeformTweakRecipe('${brew.id}')" class="w-full mt-2 bg-purple-600 text-white py-2 px-4 rounded btn text-sm font-bold">Generate Tweak</button>
                    <div id="tweak-output-${brew.id}" class="mt-4"></div>
                 </div>
            </div>

            <div class="text-center pt-4">
                <button onclick="window.showBrewPrompt('${brew.id}')" class="text-xs text-app-secondary hover:text-app-brand underline">View Original AI Prompt</button>
            </div>
        </div>
    `;

    listContainer.classList.add('hidden');
    container.classList.remove('hidden');

    // Render Charts
    renderFermentationGraph(brew.id);
    if (brew.flavorProfile && Object.keys(brew.flavorProfile).length > 0) {
        renderFlavorWheel(brew.id, ['Sweetness', 'Acidity', 'Fruity', 'Spicy', 'Earthy', 'Body'], [brew.flavorProfile.sweetness, brew.flavorProfile.acidity, brew.flavorProfile.fruity_floral, brew.flavorProfile.spiciness, brew.flavorProfile.earthy_woody, brew.flavorProfile.body_mouthfeel]);
    } else {
       document.getElementById(`flavor-wheel-container-${brew.id}`).innerHTML = `
           <div class="text-center">
               <p class="text-xs text-app-secondary italic mb-2">No profile data.</p>
               <button onclick="window.regenerateFlavorProfile()" class="text-xs bg-purple-600 text-white px-3 py-1 rounded">Generate Analysis</button>
               <div id="flavor-generation-status"></div>
           </div>`;
    }
    
    setTimeout(() => { if(window.syncLogToFinal) window.syncLogToFinal(brew.id); }, 100);
}

window.goBackToHistoryList = function() {
    document.getElementById('history-detail-container').classList.add('hidden');
    document.getElementById('history-list-container').classList.remove('hidden');
}

// ============================================================================
// brewing.js - BLOCK 4: STORAGE, MANAGEMENT & CHARTS (PART D)
// ============================================================================

// --- HELPER: Scrape log data voor inventory & updates ---
function getLogDataFromDOM(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return {};
    
    // Probeer suffix te vinden (bv. brewId)
    const section = container.querySelector('.brew-log-section');
    const suffix = section ? section.dataset.id : '';

    // Actual Ingredients Scrapen
    // Let op: We zoeken in de tabel die we in getActualIngredientsHtml hebben gemaakt
    // De ID van die tabel is 'actualsTable-' + brewId. 
    // Als containerId 'brew-day-content' is, moeten we de tabel zoeken die erin zit.
    const actualsTable = container.querySelector('table[id^="actualsTable-"]');
    let actualIngredients = [];
    
    if (actualsTable) {
        const rows = Array.from(actualsTable.querySelectorAll('tbody tr'));
        actualIngredients = rows.map(r => ({
            name: r.dataset.name,
            actualQty: r.querySelector('input').value
        }));
    }

    return {
        actualIngredients: actualIngredients
        // Je kunt hier meer velden toevoegen indien nodig voor andere functies
    };
}

window.updateBrewLog = async function(brewId, containerId) {
    if (!state.userId || !brewId) return;
    
    const btn = document.querySelector(`#${containerId} button[onclick*="updateBrewLog"]`);
    const originalText = btn ? btn.innerText : "Save";
    if(btn) { btn.disabled = true; btn.innerText = "Saving..."; }

    try {
        const container = document.getElementById(containerId);
        const suffix = container.querySelector('.brew-log-section').dataset.id;
        
        // 1. Fermentation Log Scrapen
        const rows = Array.from(container.querySelectorAll(`#fermentationTable-${suffix} tbody tr`));
        const fermentationLog = rows.map(r => {
            const inputs = r.querySelectorAll('input');
            if(inputs.length < 4) return null; 
            return { date: inputs[0].value, temp: inputs[1].value, sg: inputs[2].value, notes: inputs[3].value };
        }).filter(x => x && (x.date || x.sg));

        // 2. Blending Log Scrapen (DIT ONTBRAK IN DE NIEUWE FILE)
        const blendRows = Array.from(container.querySelectorAll(`#blendingTable-${suffix} tbody tr`));
        const blendingLog = blendRows.map(r => {
            const inputs = r.querySelectorAll('input');
            if(inputs.length < 4) return null;
            return { date: inputs[0].value, name: inputs[1].value, vol: inputs[2].value, abv: inputs[3].value };
        }).filter(x => x && (x.name || x.vol));

        // 3. Actual Ingredients Scrapen
        const actRows = Array.from(container.querySelectorAll(`#actualsTable-${brewId} tbody tr`));
        const actualIngredients = actRows.map(r => ({ name: r.dataset.name, actualQty: r.querySelector('input').value }));

        // 4. Alles verzamelen in één object
        const newData = {
            actualOG: container.querySelector(`#actualOG-${suffix}`)?.value || '',
            actualFG: container.querySelector(`#actualFG-${suffix}`)?.value || '',
            finalABV: container.querySelector(`#finalABV-${suffix}`)?.value || '',
            brewDate: container.querySelector(`#brewDate-${suffix}`)?.value || '',
            // Nieuw veld:
            currentVolume: container.querySelector(`#currentVol-${suffix}`)?.value || '', 
            agingNotes: container.querySelector(`#agingNotes-${suffix}`)?.value || '',
            bottlingNotes: container.querySelector(`#bottlingNotes-${suffix}`)?.value || '',
            tastingNotes: container.querySelector(`#tastingNotes-${suffix}`)?.value || '',
            fermentationLog: fermentationLog,
            blendingLog: blendingLog, // Toevoegen aan save object
            actualIngredients: actualIngredients
        };

        // 5. Database Update (Safety Lock: Eerst lezen, dan mergen)
        const brewRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId);
        const snap = await getDoc(brewRef);
        
        if(snap.exists()) {
            const currentData = snap.data().logData || {};
            const merged = { ...currentData, ...newData };
            
            await updateDoc(brewRef, { logData: merged });
            
            // Update lokale state direct
            const idx = state.brews.findIndex(b => b.id === brewId);
            if(idx > -1) state.brews[idx].logData = merged;
            
            showToast("Log saved successfully!", "success");
            // Ververs grafiek direct
            if (typeof renderFermentationGraph === 'function') renderFermentationGraph(brewId);
        }
    } catch(e) { 
        console.error(e); 
        showToast("Save failed", "error"); 
    } finally { 
        if(btn) { btn.disabled = false; btn.innerText = originalText; } 
    }
}

// --- HELPER: Nieuwe rij toevoegen aan logboek ---
window.addLogLine = function(idSuffix) {
    const tbody = document.querySelector(`#fermentationTable-${idSuffix} tbody`);
    if(tbody) {
        const row = document.createElement('tr');
        row.innerHTML = `<td><input type="date" class="w-full bg-transparent border-none focus:ring-0 text-sm"></td><td><input type="number" step="0.5" class="w-full bg-transparent border-none focus:ring-0 text-center text-sm" placeholder="-"></td><td><input type="number" step="0.001" class="w-full bg-transparent border-none focus:ring-0 text-center text-sm font-mono" placeholder="1.xxx" oninput="window.syncLogToFinal('${idSuffix}')"></td><td><input type="text" class="w-full bg-transparent border-none focus:ring-0 text-sm" placeholder="..."></td>`;
        tbody.appendChild(row);
    }
}

// --- COST CALCULATION (De herstelde logica) ---
function parseIngredientsAndCalculateCost(markdown, inventoryList, batchSize) {
    let totalCost = 0;
    const warnings = []; 
    // Gebruik de parser uit Deel 9B
    const requiredIngredients = parseIngredientsFromMarkdown(markdown); 

    if (requiredIngredients.length === 0) return { cost: 0, warnings: ["No ingredients found."] };

    const convertToBaseUnit = (quantity, unit) => {
        const u = (unit || '').toLowerCase().trim();
        if (u === 'kg') return { quantity: quantity * 1000, unit: 'g' };
        if (u === 'l' || u === 'liter') return { quantity: quantity * 1000, unit: 'ml' };
        if (['packet', 'packets', 'pkg'].includes(u)) return { quantity: quantity, unit: 'packets' }; 
        return { quantity: quantity, unit: u };
    };

    requiredIngredients.forEach(req => {
        const inventoryItem = inventoryList.find(item => 
            item.name.toLowerCase().includes(req.name.toLowerCase()) || 
            req.name.toLowerCase().includes(item.name.toLowerCase())
        );
        
        if (inventoryItem && typeof inventoryItem.price === 'number') {
            const stockQty = inventoryItem.qty > 0 ? inventoryItem.qty : 1;
            const reqBase = convertToBaseUnit(req.quantity, req.unit);
            const stockBase = convertToBaseUnit(stockQty, inventoryItem.unit);
            
            let costPerUnit = 0;
            let match = false;

            if (reqBase.unit === stockBase.unit) {
                match = true;
                costPerUnit = inventoryItem.price / stockBase.quantity;
            } else if (reqBase.unit === 'g' && stockBase.unit === 'packets') {
                match = true;
                if (reqBase.quantity <= 15) { totalCost += (inventoryItem.price / stockQty); return; }
            }
            
            if (match && !isNaN(costPerUnit)) {
                totalCost += reqBase.quantity * costPerUnit;
            }
        }
    });
    return { cost: totalCost, warnings: warnings }; 
}

// --- SCOPE FIX: USE STATE.BREWS & STATE.USERID & STATE.INVENTORY ---
window.recalculateBatchCost = async function(brewId) {
    const brew = state.brews.find(b => b.id === brewId); // Was: brews.find
    if (!brew) return;
    
    // Check inventory
    if (!state.inventory || state.inventory.length === 0) {
        showToast("Inventory empty.", "error");
        return;
    }

    const costResult = parseIngredientsAndCalculateCost(brew.recipeMarkdown, state.inventory, brew.batchSize);
    
    if (costResult.warnings.length > 0) {
        // Toon max 3 warnings in toast om overflow te voorkomen
        const msg = costResult.warnings.slice(0, 3).join('\n') + (costResult.warnings.length > 3 ? '\n...' : '');
        showToast(`Warnings:\n${msg}`, 'info');
    }
    
    if (confirm(`Calculated Cost: €${costResult.cost.toFixed(2)}. Update batch?`)) {
        try {
            await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { totalCost: costResult.cost });
            brew.totalCost = costResult.cost; // Lokale update
            
            // Als we in detail view zitten, ververs die dan
            if(document.getElementById('history-detail-container') && !document.getElementById('history-detail-container').classList.contains('hidden')) {
                window.showBrewDetail(brewId);
            }
            showToast("Cost updated!", "success");
        } catch(e) { console.error(e); }
    }
}

// --- TITLE MANAGEMENT ---
window.showTitleEditor = (id) => { document.getElementById(`title-display-${id}`).classList.add('hidden'); document.getElementById(`title-editor-${id}`).classList.remove('hidden'); };
window.hideTitleEditor = (id) => { document.getElementById(`title-display-${id}`).classList.remove('hidden'); document.getElementById(`title-editor-${id}`).classList.add('hidden'); };

window.saveNewTitle = async (id) => {
    const val = document.getElementById(`title-input-${id}`).value;
    if(val) { 
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', id), { 
            recipeName: val,
            "logData.recipeName": val // Consistentie
        }); 
        window.hideTitleEditor(id); 
        // Lokale update
        const b = state.brews.find(x => x.id === id); if(b) b.recipeName = val;
        // UI verversen
        const titleHeader = document.querySelector(`#title-display-${id} h2`);
        if(titleHeader) titleHeader.textContent = val;
        renderHistoryList();
    }
};

// --- CORE ACTIONS: Delete, Clone, Resume, Save New ---

// --- UPDATED: DELETE BREW (MET SAFETY CLEANUP) ---
window.deleteBrew = async function(brewId) {
    if (!state.userId) return;
    if (!confirm("Are you sure? This cannot be undone.")) return;

    try {
        // 1. Verwijder uit Database
        await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId));

        // 2. CHECK: Was dit de actieve batch? (HERSTELD)
        if (tempState.activeBrewId === brewId) {
            console.log("Active batch deleted. Resetting UI.");
            
            // Stop timers
            if (typeof stepTimerInterval !== 'undefined' && stepTimerInterval) {
                clearInterval(stepTimerInterval);
            }
            localStorage.removeItem('activeBrewDayTimer');
            
            // Reset pointer
            tempState.activeBrewId = null;
            if(state.userSettings) {
                state.userSettings.currentBrewDay = { brewId: null };
                if (window.saveUserSettings) window.saveUserSettings();
            }

            // Reset UI
            if (typeof renderBrewDay === 'function') renderBrewDay('none');
        }

        showToast("Brew deleted.", "success");
        window.goBackToHistoryList();

    } catch(e) { console.error(e); showToast("Delete failed", "error"); }
}

window.cloneBrew = async function(brewId) {
    const original = state.brews.find(b => b.id === brewId);
    if (!original) return;
    if (!confirm(`Start a new batch based on "${original.recipeName}"?`)) return;

    try {
        const newBrew = {
            ...original,
            recipeName: `${original.recipeName} (Copy)`,
            createdAt: serverTimestamp(),
            logData: {}, // Reset log
            checklist: {}, // Reset checklist
            primaryComplete: false,
            isBottled: false
        };
        delete newBrew.id; // Nieuw ID genereren

        const docRef = await addDoc(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews'), newBrew);
        showToast("Batch cloned! Loading...", "success");
        
        // Direct openen in brouwdag modus
        window.startActualBrewDay(docRef.id);
    } catch(e) { console.error(e); showToast("Clone failed", "error"); }
}

window.resumeBrew = function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) return;
    
    tempState.activeBrewId = brewId;
    switchMainView('brewing');
    
    if (brew.primaryComplete) {
        switchSubView('brew-day-2', 'brewing-main-view');
        renderBrewDay2();
    } else {
        switchSubView('brew-day-1', 'brewing-main-view');
        renderBrewDay(brewId);
    }
}

window.saveBrewToHistory = async function(recipeText, flavorProfile) {
    if (!state.userId) return;
    try {
        await addDoc(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews'), {
            recipeName: extractTitle(recipeText) || "Untitled Brew", 
            recipeMarkdown: recipeText, 
            flavorProfile: flavorProfile || {},
            createdAt: serverTimestamp(), 
            logData: {}, 
            checklist: {},
            model: state.userSettings.aiModel || "gemini-1.5-flash"
        });
        showToast("Recipe saved to history!", "success");
    } catch (error) {
        console.error("Save error:", error);
        showToast("Could not save.", "error");
    }
}

// --- CHARTS & EXTRAS ---

function renderFermentationGraph(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew || !brew.logData || !brew.logData.fermentationLog) return;
    
    const ctx = document.getElementById(`fermChart-${brewId}`);
    if (!ctx) return;
    
    const data = brew.logData.fermentationLog
        .filter(r => r.date && r.sg)
        .sort((a,b) => new Date(a.date) - new Date(b.date));
        
    if(data.length === 0) { ctx.parentElement.classList.add('hidden'); return; }

    if(window[`chart_${brewId}`]) window[`chart_${brewId}`].destroy();

    window[`chart_${brewId}`] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => d.date),
            datasets: [{ label: 'Gravity', data: data.map(d => d.sg), borderColor: '#d97706', tension: 0.1 }]
        }
    });
}

function renderFlavorWheel(brewId, labels, data) {
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
                    suggestedMin: 0, suggestedMax: 5
                }
            },
            plugins: { legend: { display: false } }
        }
    });
}

window.printEmptyLog = function() {
    const logHtml = getBrewLogHtml({}, 'print-version');
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`<html><head><title>Log</title></head><body>${logHtml}<script>window.print()</script></body></html>`);
    printWindow.document.close();
}

window.autoCalculateABV = function(idSuffix) {
    const og = parseFloat(document.getElementById(`actualOG-${idSuffix}`)?.value);
    const fg = parseFloat(document.getElementById(`actualFG-${idSuffix}`)?.value);
    const abvField = document.getElementById(`finalABV-${idSuffix}`);
    if(!isNaN(og) && !isNaN(fg) && abvField) {
        abvField.value = ((og - fg) * 131.25).toFixed(1) + "%";
    }
};

window.syncLogToFinal = function(idSuffix) {
    const inputs = document.querySelectorAll(`#fermentationTable-${idSuffix} tbody tr td:nth-child(3) input`);
    let lastVal = "";
    inputs.forEach(inp => { if(inp.value) lastVal = inp.value; });
    const finalFg = document.getElementById(`actualFG-${idSuffix}`);
    if(finalFg && lastVal) {
        finalFg.value = lastVal;
        window.autoCalculateABV(idSuffix);
    }
};

// ============================================================================
// brewing.js - BLOCK 5: EXTRA TOOLS & FINAL EXPORTS
// ============================================================================

// --- EXTRA AI TOOLS (Water & Gist Advies) ---

async function getWaterAdvice() {
    // Check of er een waterprofiel actief is (via state) of UI selectie
    const targetProfile = document.getElementById('meadTargetProfile')?.selectedOptions[0]?.text || "Balanced Mead";
    const batchSize = document.getElementById('batchSize')?.value || 5;
    
    // We checken de HUIDIGE waarden in de UI (ingevuld door user of ingeladen profiel)
    const ca = document.getElementById('val-ca')?.textContent || "0";
    const mg = document.getElementById('val-mg')?.textContent || "0";
    const na = document.getElementById('val-na')?.textContent || "0";
    const so4 = document.getElementById('val-so4')?.textContent || "0";
    const cl = document.getElementById('val-cl')?.textContent || "0";
    const hco3 = document.getElementById('val-hco3')?.textContent || "0";

    if (ca === '--' || ca === '0') {
        document.getElementById('water-advice-output').innerHTML = `<p class="text-red-500 text-sm">Please select a Water Source on the left first.</p>`;
        return;
    }

    const output = document.getElementById('water-advice-output');
    output.innerHTML = getLoaderHtml("The Water Sommelier is tasting...");
    
    const profileStr = `Ca:${ca}, Mg:${mg}, Na:${na}, SO4:${so4}, Cl:${cl}, HCO3:${hco3}`;
    
    const prompt = `Brew Chemist: User has water profile (${profileStr}). Goal: ${batchSize}L ${targetProfile}. 
    
    **USER CONSTRAINT:** The user does NOT perform water chemistry adjustments (No salts/acids added).
    
    **TASK:** 1. Analyze if this water is suitable "as is" for a Mead.
    2. Give a simple verdict: "Excellent", "Good", "Okay", or "Risky".
    3. Explain mainly based on Chlorine (off-flavors) and Calcium (yeast health).
    4. DO NOT recommend adding Gypsum, Epsom, or acids. Just say if it will work nicely.
    
    Format: Markdown. Keep it brief.`;

    try {
        const text = await performApiCall(prompt);
        output.innerHTML = marked.parse(text);
    } catch (error) {
        output.innerHTML = `<p class="text-red-500">Error: ${error.message}</p>`;
    }
}

async function getYeastAdvice() {
    // Inputs uit de Tools sectie (zorg dat deze IDs bestaan in index.html onder tools-view)
    // Als ze niet bestaan, gebruiken we defaults om crashes te voorkomen
    const ogInput = document.getElementById('starterOG'); // Eventuele input in tools
    const dateInput = document.getElementById('yeastDate');
    const typeInput = document.getElementById('yeastType');
    const adviceOutput = document.getElementById('yeast-advice-output'); // Output div

    // Omdat deze functie in de originele file stond, maar de HTML misschien in 'tools' zit:
    // We checken of de elementen bestaan. Zo niet, geven we een melding.
    if (!adviceOutput) {
        console.warn("Yeast advice output container missing.");
        return;
    }

    if (!ogInput || !dateInput) {
        // Fallback als de inputs nog niet in de HTML staan (toekomstige feature?)
        adviceOutput.innerHTML = `<p class="text-app-secondary text-sm">Yeast calculator inputs not found.</p>`; 
        return;
    }

    const og = ogInput.value;
    const yeastDate = dateInput.value;
    const yeastType = typeInput.value;

    if (!og || !yeastDate) { 
        adviceOutput.innerHTML = `<p class="text-red-500 text-sm">Please enter OG and Yeast Date.</p>`; 
        return; 
    }
    
    adviceOutput.innerHTML = getLoaderHtml("Analyzing yeast viability...");

    const prompt = `Yeast Expert: User brewing mead SG ${og}. Yeast: ${yeastType}, production date ${yeastDate}. Today: ${new Date().toISOString().split('T')[0]}. 
    Is a starter needed? Provide steps for a 5L batch. 
    Format: Markdown.`;

    try {
        const text = await performApiCall(prompt);
        adviceOutput.innerHTML = marked.parse(text);
    } catch (error) {
        adviceOutput.innerHTML = `<p class="text-red-500">Error: ${error.message}</p>`;
    }
}

// --- LEGACY BRIDGE ---
// app.js roept dit aan bij opstarten. Wij gebruiken nu inline onclicks, 
// maar we laten deze lege functie staan om errors in app.js te voorkomen.
function setupBrewDayEventListeners() {
    console.log("Brew Day listeners handled via inline logic.");
}

// --- MISSING FEATURE 1: BLENDING TOOL ---
window.addBlendingRow = function(idSuffix) {
    const tbody = document.querySelector(`#blendingTable-${idSuffix} tbody`);
    if(!tbody) return;
    const today = new Date().toISOString().split('T')[0];
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td><input type="date" value="${today}" class="w-full bg-transparent"></td>
        <td><input type="text" class="w-full bg-transparent" placeholder="Spirit Name"></td>
        <td><input type="number" step="0.01" class="w-full bg-transparent text-center" oninput="window.recalcTotalABV('${idSuffix}')"></td>
        <td><input type="number" step="0.1" class="w-full bg-transparent text-center" oninput="window.recalcTotalABV('${idSuffix}')"></td>
        <td class="text-center"><button onclick="this.closest('tr').remove(); window.recalcTotalABV('${idSuffix}')" class="text-red-500 font-bold">&times;</button></td>
    `;
    tbody.appendChild(tr);
};

// --- SCOPE FIX: USE STATE.BREWS ---
window.recalcTotalABV = function(idSuffix) {
    // 1. Haal basis gegevens
    const targetABVField = document.getElementById(`targetABV-${idSuffix}`);
    const finalABVField = document.getElementById(`finalABV-${idSuffix}`);
    const currentVolInput = document.getElementById(`currentVol-${idSuffix}`);
    
    // Probeer batch size te vinden als fallback
    let fallbackVol = 5.0;
    // FIX: Gebruik state.brews i.p.v. brews
    const activeId = tempState.activeBrewId || (state.userSettings?.currentBrewDay?.brewId);

    if(state.brews && activeId) {
         const b = state.brews.find(x => x.id === activeId);
         if(b) fallbackVol = b.batchSize || 5;
    } else if (state.brews && tempState.activeBrewId) {
         // Fallback voor als we in history view zitten
         const b = state.brews.find(x => x.id === tempState.activeBrewId);
         if(b) fallbackVol = b.batchSize || 5;
    }

    // Gebruik de input, of anders de fallback
    let startVolume = parseFloat(currentVolInput.value);
    if (isNaN(startVolume) || startVolume <= 0) {
        startVolume = fallbackVol;
    }

    let baseABV = parseFloat(finalABVField.value) || parseFloat(targetABVField.value) || 0;
    
    // Check of we SG-based ABV moeten gebruiken
    const ogVal = parseFloat(document.getElementById(`actualOG-${idSuffix}`).value.replace(',', '.'));
    const fgVal = parseFloat(document.getElementById(`actualFG-${idSuffix}`).value.replace(',', '.'));
    if (!isNaN(ogVal) && !isNaN(fgVal)) {
        baseABV = (ogVal - fgVal) * 131.25;
    }

    // --- DE REKENSOM ---
    let totalAlcVolume = startVolume * (baseABV / 100);
    let totalLiquidVolume = startVolume;

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

    const newABV = totalLiquidVolume > 0 ? (totalAlcVolume / totalLiquidVolume) * 100 : 0;
    
    finalABVField.value = newABV.toFixed(2) + '%';
    
    const summary = document.getElementById(`blending-summary-${idSuffix}`);
    if(summary) {
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

// --- MISSING FEATURE 2: INVENTORY SYNC ---
window.deductActualsFromInventory = async function(brewId) {
    if (!confirm("Deduct calculated ingredients from your Inventory Stock?")) return;
    
    // We roepen een functie aan die in inventory.js moet bestaan.
    // Omdat inventory.js als module geladen wordt, moet die functie aan window hangen.
    if (window.performInventoryDeduction) {
    // Haal de actuele data op (functie bestaat lokaal in new-brewing.js)
    const logData = getLogDataFromDOM('brew-day-content'); 
    
    if (!logData.actualIngredients || logData.actualIngredients.length === 0) {
        showToast("No actuals recorded. Save log first.", "warning");
        return;
    }
    
    await window.performInventoryDeduction(logData.actualIngredients);
} else {
    showToast("Inventory module not loaded.", "error");
}
}

// --- MISSING FEATURE 3: PROMPT VIEWER ---
window.showLastPrompt = function() {
    // We tonen de laatst gegenereerde prompt uit het geheugen
    if(!lastGeneratedPrompt) {
        showToast("No prompt in memory.", "info");
        return;
    }
    // We gebruiken de algemene prompt modal uit index.html
    const modal = document.getElementById('prompt-modal');
    const content = document.getElementById('prompt-modal-content'); // Zorg dat dit ID in je HTML modal staat!
    if(modal) {
        if(content) content.textContent = lastGeneratedPrompt;
        modal.classList.remove('hidden');
    } else {
        alert(lastGeneratedPrompt); // Fallback
    }
}

// --- MISSING FEATURE 4: CLEAR HISTORY ---
window.clearHistory = async function() {
    if(!confirm("DELETE ALL HISTORY? This cannot be undone.")) return;
    if(!state.userId) return;
    
    // Dit is een zware operatie, we loopen door de lokale state om reads te besparen
    const batch = []; // Firestore batches supporten max 500
    // Simpele implementatie: één voor één verwijderen (veiliger voor kleine apps)
    try {
        const q = query(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews'));
        // We moeten onSnapshot even uitzetten of negeren, maar dat is lastig.
        // We sturen gewoon delete requests.
        state.brews.forEach(async (b) => {
             await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', b.id));
        });
        showToast("History clearing...", "info");
    } catch(e) {
        console.error(e);
        showToast("Error clearing history", "error");
    }
}

// --- MISSING FEATURE: RESTORE TIMER ON LOAD ---
function initializeBrewDayState(brewId, steps) {
    // Check localstorage
    const savedTimer = localStorage.getItem('activeBrewDayTimer');
    if (savedTimer) {
        const { brewId: savedId, stepIndex, endTime } = JSON.parse(savedTimer);
        
        // Alleen herstellen als we op de juiste pagina zitten
        if (savedId === brewId) {
            const now = Date.now();
            if (endTime > now) {
                // Timer loopt nog: hervatten!
                const remaining = Math.round((endTime - now) / 1000);
                window.startStepTimer(brewId, stepIndex, remaining);
            } else {
                // Timer is afgelopen terwijl we weg waren
                localStorage.removeItem('activeBrewDayTimer');
                // Optioneel: markeer als klaar of toon melding
            }
        }
    }
}

// --- MISSING TOOL 1: TWEAK SAVED RECIPE ---
window.freeformTweakRecipe = async function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) return;

    const requestInput = document.getElementById(`tweak-request-${brewId}`);
    const outputDiv = document.getElementById(`tweak-output-${brewId}`);
    const request = requestInput.value.trim();

    if (!request) { showToast("Please describe your tweak.", "error"); return; }

    outputDiv.innerHTML = getLoaderHtml("Master Mazer is rewriting...");
    
    // Prompt bouwen op basis van bestaand recept
    const prompt = `You are a Mead Expert. Refactor this existing recipe based on user feedback.
    
    ORIGINAL RECIPE:
    ${brew.recipeMarkdown}
    
    USER TWEAK REQUEST:
    "${request}"
    
    OUTPUT:
    Full Markdown recipe. Start with # Title. Re-calculate everything.`;

    try {
        const result = await performApiCall(prompt);
        // We tonen het resultaat in de div, gebruiker kan het kopiëren
        outputDiv.innerHTML = `<div class="p-4 bg-app-tertiary rounded border border-app-brand/20 prose dark:prose-invert text-sm max-w-none">${marked.parse(result)}</div>
        <button onclick="window.saveBrewToHistory(\`${result.replace(/`/g, '\\`')}\`, null)" class="mt-2 bg-green-600 text-white py-2 px-4 rounded btn text-xs font-bold w-full">Save as New Batch</button>`;
    } catch (error) {
        outputDiv.innerHTML = `<p class="text-red-500 text-sm">Error: ${error.message}</p>`;
    }
}

// --- MISSING TOOL 2: SHOW SAVED PROMPT ---
// Onderscheid: showLastPrompt toont geheugen, deze toont Database prompt
window.showBrewPrompt = function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    // Sommige oudere recepten hebben misschien geen opgeslagen prompt, toon dan info
    const text = brew?.prompt || "No prompt saved for this batch (created in older version).";
    
    // We gebruiken de algemene modal als die er is, anders alert
    const modal = document.getElementById('prompt-modal');
    const content = document.getElementById('prompt-modal-content');
    if (modal && content) {
        content.textContent = text;
        modal.classList.remove('hidden');
    } else {
        alert(text);
    }
}

// ============================================================================
// FINAL EXPORTS (COMPLETE & VERIFIED)
// ============================================================================

// Core & UI
window.generateRecipe = generateRecipe;
window.loadHistory = loadHistory;
window.renderHistoryList = renderHistoryList;
window.handleDescriptionInput = handleDescriptionInput;
window.handleStyleChange = handleStyleChange;
window.handleEquipmentTypeChange = handleEquipmentTypeChange;

// AI Tools
window.applyWaterTweak = applyWaterTweak;
window.regenerateFlavorProfile = regenerateFlavorProfile;
window.getWaterAdvice = getWaterAdvice;
window.getYeastAdvice = getYeastAdvice;
window.showLastPrompt = showLastPrompt;

// Brew Day Engine
window.startActualBrewDay = startActualBrewDay;
window.renderBrewDay = renderBrewDay;
window.renderBrewDay2 = renderBrewDay2;
window.resetBrewDay = resetBrewDay;
window.finishPrimaryManual = finishPrimaryManual;
window.startStepTimer = startStepTimer;
window.pauseStepTimer = pauseStepTimer;
window.skipTimer = skipTimer;
window.completeStep = completeStep;
window.toggleSecondaryStep = toggleSecondaryStep;
window.openSecondaryDetail = openSecondaryDetail;
window.closeSecondaryDetail = closeSecondaryDetail;
window.deductActualsFromInventory = deductActualsFromInventory;
window.freeformTweakRecipe = freeformTweakRecipe;
window.showBrewPrompt = showBrewPrompt;
window.startBrewDay = startBrewDay;

// Logging & Details
window.showBrewDetail = showBrewDetail;
window.goBackToHistoryList = goBackToHistoryList;
window.saveBrewToHistory = saveBrewToHistory;
window.updateBrewLog = updateBrewLog;
window.addLogLine = addLogLine;
window.recalculateBatchCost = recalculateBatchCost;
window.printEmptyLog = printEmptyLog;

// Blending (Hersteld)
window.addBlendingRow = addBlendingRow;
window.recalcTotalABV = recalcTotalABV;

// Management
window.deleteBrew = deleteBrew;
window.clearHistory = clearHistory; // Hersteld
window.cloneBrew = cloneBrew;
window.resumeBrew = resumeBrew;
window.saveNewTitle = saveNewTitle;
window.showTitleEditor = showTitleEditor;
window.hideTitleEditor = hideTitleEditor;

// Charts & Logic
window.renderFermentationGraph = renderFermentationGraph;
window.renderFlavorWheel = renderFlavorWheel;
window.autoCalculateABV = autoCalculateABV;
window.syncLogToFinal = syncLogToFinal;
window.setupBrewDayEventListeners = setupBrewDayEventListeners;