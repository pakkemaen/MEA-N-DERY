// ============================================================================
// brewing.js
// MEANDERY V2.6
// ============================================================================

// 1. IMPORTS - Gecentraliseerd via firebase-init.js
import { 
    db, auth, collection, addDoc, updateDoc, doc, deleteDoc, 
    getDoc, setDoc, query, onSnapshot, serverTimestamp 
} from './firebase-init.js';

import { state, tempState } from './state.js';
import { 
    showToast, performApiCall, switchMainView, switchSubView, 
    getLoaderHtml, logSystemError 
} from './utils.js';

// 2. MODULE VARIABLES
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

4.  **HOP KINETICS & DRY-HOPPING RESTRICTIONS:**
    - **Dry-Hop Time Window:** Cold extraction extraction processes (dry-hopping) in secondary phases MUST be planned strictly within the optimal time window of minimum **72 hours (3 days)** to maximum **120 hours (5 days)**. This is mandatory to maximize terpene solvation and minimize polyphenol/chlorophyll over-extraction.

**OUTPUT FORMAT (STRICT):**
- **Markdown** structure.
- **Ingredients JSON:** \`\`\`json [{"ingredient": "Name", "quantity": 0, "unit": "kg"}] \`\`\` (List ALL ingredients with calculated amounts).
- **Timers:** \`[TIMER:HH:MM:SS]\` for wait steps.
`;
}

// --- CORE: De Prompt Bouwer (AANGEPAST: AUTO ABV & DESCRIPTION PRIORITY) ---
function buildPrompt() {
    try {
        const batchSize = parseFloat(String(document.getElementById('batchSize')?.value).replace(',', '.')) || 5;
        
        const customDescription = document.getElementById('customDescription')?.value.trim() || "";
        const hasDescription = customDescription !== "";

        const abvEl = document.getElementById('abv');
        const rawABV = abvEl ? abvEl.value : ''; 
        
        const isAutoABV = (rawABV === '' || rawABV === '0') || hasDescription;
        const targetABV = isAutoABV ? 12 : (parseFloat(String(rawABV).replace(',', '.')) || 12);

        const sweetness = document.getElementById('sweetness')?.value;
        const styleSelect = document.getElementById('style');
        const style = styleSelect.selectedOptions.length > 0 ? styleSelect.selectedOptions.text : 'Traditional Mead';
        
        const inputString = (customDescription + " " + style).toLowerCase();
        const noWaterCheckbox = document.getElementById('isNoWaterCheckbox');
        const isNoWater = (noWaterCheckbox && noWaterCheckbox.checked) || inputString.includes('no-water') || inputString.includes('no water');
        const isBraggot = inputString.includes('braggot');
        
        const beerCloneInput = document.getElementById('beerCloneInput')?.value.trim() || "";
        const hasBeerClone = beerCloneInput !== "";

        const useBudget = document.getElementById('useBudget')?.checked;
        let budgetContext = "";
        if (useBudget) {
             const maxBudget = parseFloat(String(document.getElementById('maxBudget')?.value).replace(',', '.'));
             if (maxBudget > 0) {
                 budgetContext = `\n- **STRICT BUDGET CONSTRAINT:** The total cost of ingredients MUST be below **€${maxBudget}**. Prioritize cheaper ingredients or smaller batches if necessary.`;
             }
        }

        const carbMethod = state.userSettings?.carbonationMethod || 'bottle';
        let carbContext = "";

        if (carbMethod === 'keg') {
            carbContext = `
            **CARBONATION METHOD: KEG (FORCE CARB).**
            - **Stability:** You MAY stabilize (Sorbate/Metabisulphite) and backsweeten freely with fermentable sugars (Honey/Sugar).
            - **Process:** Ferment -> Stabilize -> Backsweeten -> Keg -> Force Carbonate.
            `;
        } else {
            carbContext = `
            **CARBONATION METHOD: BOTTLE CONDITIONING.**
            - **CRITICAL SAFETY:** The user puts this in glass bottles.
            - **Stabilization:** DO NOT stabilize with Sorbate if carbonation is desired (yeast must remain alive).
            - **Sweetness Dilemma:** IF the user wants "Sweet" AND "Carbonated":
              1. You CANNOT add Honey/Sugar for sweetness at bottling (Bottle Bomb risk).
              2. You MUST recommend non-fermentable sweeteners (Erythritol/Lactose) for sweetness.
              3. OR recommend pasteurization (advanced).
            - **Process:** Ferment Dry -> Add Priming Sugar -> Bottle.
            `;
        }

        let mathContext = "";

        if (isAutoABV) {
            mathContext = `
            **CALCULATED TARGETS:**
            - **Batch:** ${batchSize}L
            - **Target ABV:** **OPEN / AI DECISION**.
            - **TASK:** Please determine the optimal ABV for this specific style/description to get the best possible flavor.
            - **HONEY CALCULATION:** You MUST calculate the required honey yourself based on your chosen ABV (Rule of thumb: ~22g honey/L per 1% ABV).
            ${budgetContext}
            `;
        } else {
            const honeyGramsPerLiter = targetABV * 22; 
            const totalHoneyKg = (honeyGramsPerLiter * batchSize) / 1000;
            const estimatedYAN = Math.round(targetABV * 10);
        
            mathContext = `
            **CALCULATED TARGETS:**
            - **Batch:** ${batchSize}L | **Target ABV:** ${targetABV}%
            - **Honey Baseline:** ~${totalHoneyKg.toFixed(2)} kg (Assuming honey provides 100% of alcohol).
            - **SHOPPING LIST RULE:** If target is **SWEET**, add ~15% extra honey to the JSON for backsweetening.
            - **Nitrogen Target:** ~${estimatedYAN} PPM YAN.${budgetContext}
            `;
        }

        // Pakket 3 & Hop Isomerisatie / Biotransformatie wetten
        if (isBraggot || hasBeerClone) {
            let braggotWiskunde = `\n- **PROTOCOL: BRAGGOT MATH (STRICT v2.6 BLUEPRINT):**`;
            if (hasBeerClone) {
                braggotWiskunde += `\n  - Target Beer Profile to Clone: "${beerCloneInput}"`;
            }
            braggotWiskunde += `
            1. Calculate the required Alcohol by Weight (ABW) using: ABW = Target_ABV * 0.794.
            2. Isolate the total density drop (ΔSG) using the inverted Hall Equation: ΔSG = (ABW * (1.775 - OG)) / 76.08.
            3. Determine total sugar requirements in Gravity Points: GP_total = (OG - 1.000) * 1000 * Batch_Size.
            4. Enforce malt grist ratio (X_malt) strictly between 30% and 50% of total sugar contribution: GP_malt = GP_total * X_malt. The remaining 50-70% must be supplied by honey.
            5. Convert point distribution to exact mass weights in kilograms based on standard potentials:
               - Honey Yield Potential: 290 points/kg/L
               - Dry Malt Extract (DME) Yield Potential: 375 points/kg/L
               - Liquid Malt Extract (LME) Yield Potential: 300 points/kg/L
            6. Predict an increased Estimated Final Gravity (FG_est) by applying a 75% apparent attenuation limit solely onto the malt fraction, leaving residual unfermentable dextrins. Perform a backward adjustment on the final required OG to compensate for this density floor and guarantee the requested net ABV target.
            7. **HONEY MUST IBU-RETENTION MATRIX:** Correct the calculated International Bitterness Units (IBU) based on the absence of protein-adsorptive losses in honey components.
               - IF the mixture is a pure honey must (malt fraction is 0), scale the theoretical Tinseth bitterness utility by the mechanistical constant φ_mead = 1.45.
               - IF the mixture is a hybrid braggot, calculate the dynamic adjustment factor using: φ_braggot = 1.0 + 0.45 * (1.0 - (ρ_malt / ρ_total)), where ρ_malt is the specific gravity points contribution from the malt extract, and ρ_total is the total starting gravity points of the must (OG - 1.000). Ensure total calculated bittering additions are adjusted to prevent overwhelming astringency.`;
            
            mathContext += braggotWiskunde;
        } else if (isNoWater) {
            mathContext += `\n- **PROTOCOL: NO-WATER MELOMEL.** 1. No added water. 2. Need ~1.8kg fruit/Liter. 3. **SUGAR ALERT:** Fruit adds sugar. REDUCE Honey Baseline significantly.`;
        } else {
            mathContext += `\n- **JUICE WARNING:** If replacing water with Fruit Juice, reduce honey to prevent overshooting ABV.`;
        }

        // Nitrogen Catabolite Repression (NCR) De-repressie Algoritme Instructie
        let ncrContext = "";
        if (inputString.includes("qa23") || inputString.includes("us-05") || inputString.includes("71b") || inputString.includes("ec-1118") || inputString.includes("d47") || inputString.includes("m05")) {
            ncrContext = `
            - **NCR DE-REPRESSION ARCHITECTURE (IRC7-L Allele Activation):** If the prescribed yeast strain is Lalvin QA23 or SafAle US-05, you MUST compile an advanced nutrient schedule that exploits transcriptional de-repressive enzyme mechanics for up to a 10x higher free volatile thiol release (3MH).
            - **Kinetic Staging:** Structure step-by-step instructions so the initial assimilation framework restricts total Nitrogen (YAN) below 100 mg/L during the early exponential lag phase. Instruct the brewer to delay the main organic nutrient additions until exactly after the first 1/3 sugar depletion zone has passed.`;
        }

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
        const fullInventoryList = currentInventory.filter(item => relevantCategories.includes(item.category));
        const inventoryString = fullInventoryList.map(item => `${item.name} (${item.qty} ${item.unit})`).join('; ');
        
        const useAnyInventory = Object.values(inventoryToggles).some(val => val === true);
        const requestedCategories = Object.keys(inventoryToggles).filter(k => inventoryToggles[k]);
        
        let inventoryInstruction = "";
        if (useAnyInventory) {
             inventoryInstruction = `**INVENTORY MODE:** The user wants to use their stock. Prioritize using items from: ${requestedCategories.join(', ')}.`;
        } else {
             inventoryInstruction = `**STOCK AWARENESS:** The user has these items available. Suggest them if they fit the style perfectly.`;
        }

        const invLower = inventoryString.toLowerCase();
        
        const hasSafeOrganic = invLower.includes('fermaid o') || invLower.includes('ferm o') || invLower.includes('cellvit') || invLower.includes('yeast hulls');
        const hasDAP = invLower.includes('dap') || invLower.includes('diammonium') || invLower.includes('nutrisal');
        const hasHybrid = invLower.includes('nutrivit') || invLower.includes('fermaid k') || invLower.includes('combi') || invLower.includes('ultra') || invLower.includes('tronozym');
        
        let baseNutrientRule = "";
        if (inventoryToggles.Nutrient) { 
             if (!hasSafeOrganic && (hasHybrid || hasDAP)) {
                baseNutrientRule = `1. **Nutrients (INORGANIC):** Detected inorganic stock. **WARNING:** Stop addition after 9% ABV. Use 1.0x YAN scaling.`;
             } else if (hasSafeOrganic) {
                baseNutrientRule = `1. **Nutrients (ORGANIC):** Use Fermaid O (Bio-equivalentie 4.0x). Calculate based on 160ppm equivalent per 1g/L. Follow TOSNA 3.0 (1g/gal pitch rate if <1.100 SG).`;
             } else {
                 baseNutrientRule = `1. **Nutrients:** Prescribe TOSNA 3.0 with organic nutrients (Bio-Eq 4.0 factor).`;
             }
        }

        let stabiliserRule = "";
        if (invLower.includes('campden')) {
            stabiliserRule = `3. **NAMING CONVENTION:** The user has "Campden" in stock. Always write "**Campden Powder/Tablets**" instead of "Potassium Metabisulphite" in the ingredients list and instructions.`;
        }

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

        const sourKeywords = ['sour', 'wild', 'gueuze', 'lambic', 'brett', 'funky', 'farmhouse', 'lacto', 'pedio', 'geuze'];
        const isQuickSour = inputString.includes('philly') || inputString.includes('kettle');
        const isWildMode = sourKeywords.some(k => inputString.includes(k));

        const belgianKeywords = ['quad', 'tripel', 'dubbel', 'belgian', 'abbey', 'trappist', 'saison', 'blond', 'bruin', 'stout', 'barleywine'];
        const isBelgianMode = belgianKeywords.some(k => inputString.includes(k)) || isBraggot; 

        const heavyKeywords = ['rum', 'bourbon', 'whisky', 'barrel', 'oak', 'bochet', 'dessert', 'pastry', 'sack', 'port', 'sherry', 'amaretto', 'chocolate', 'vanilla', 'coffee', 'maple'];
        const isHydromel = targetABV < 8 || inputString.includes('session') || inputString.includes('hydromel');
        const isHeavyMode = heavyKeywords.some(k => inputString.includes(k)) || targetABV > 15;

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

        let waterContext = `
        **WATER INSTRUCTION (NO CHEMISTRY):**
        1. **FORBIDDEN:** Do NOT recommend adding brewing salts (Gypsum, Epsom, etc.). The user uses bottled water.
        2. **TASK:** Describe the *type* of water needed for this specific mead style (e.g., "Soft water to let delicate varietals shine" or "Mineral-rich water for structure").
        3. **REFERENCE:** Mention a suitable **Belgian brand** ONLY as an example (e.g. "Use a soft water like Spa Reine" or "A mineral water like Chaudfontaine").
        `;

        let creativeBrief = ""; 
        if (customDescription.trim() !== '') {
             creativeBrief = `User Vision: "${customDescription}". Override stats only if specified. Base: ${batchSize}L, ${targetABV}%.`;
        } else {
             creativeBrief = `Structure: ${style}, Batch: ${batchSize}L, Target: ${targetABV}%, Sweetness: ${sweetness}.`;
             if (style.includes('Melomel')) {
                const fruits = Array.from(document.querySelectorAll('#fruit-section input[type=checkbox]:checked')).map(el => el.labels.innerText);
                const otherFruits = document.getElementById('fruitOther').value;
                const fStr = [...fruits, otherFruits].filter(Boolean).join(', ');
                if(fStr) creativeBrief += `\n- Fruits: ${fStr}`;
             }
             if (style.includes('Metheglin')) {
                const spices = Array.from(document.querySelectorAll('#spice-section input[type=checkbox]:checked')).map(el => el.labels.innerText);
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

        return `You are "MEA(N)DERY", a master mazer. 

${mathContext}
${carbContext}
${protocolContext}
${specificLaws}
${ncrContext}
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
        window.logSystemError(error, "brewing.js: buildPrompt", "ERROR");
        throw new Error(`Failed to build prompt: ${error.message}`);
    }
}

// --- CORE: Generate Recipe ---
async function generateRecipe() {
    const recipeOutput = document.getElementById('recipe-output');
    if(recipeOutput) recipeOutput.innerHTML = getLoaderHtml("Initializing Brewing Protocol...");
    
    const generateBtn = document.getElementById('generateBtn');
    if(generateBtn) {
        generateBtn.disabled = true;
        generateBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }
    
    currentPredictedProfile = null; 

    const thinkingInterval = (typeof window.startThinkingAnimation === 'function') 
        ? window.startThinkingAnimation("loader-text") 
        : null;

    try {
        const prompt = buildPrompt();
        lastGeneratedPrompt = prompt; 
        
        let rawResponse = await performApiCall(prompt); 
        
        let cleanedResponse = rawResponse.trim();
        if (cleanedResponse.startsWith("```")) {
            const firstNewLine = cleanedResponse.indexOf('\n');
            const lastBackticks = cleanedResponse.lastIndexOf("```");
            
            if (firstNewLine !== -1 && lastBackticks !== -1) {
                cleanedResponse = cleanedResponse.substring(firstNewLine, lastBackticks).trim();
            }
        }
        
        if (thinkingInterval) clearInterval(thinkingInterval);

        currentRecipeMarkdown = cleanedResponse;
        window.currentRecipeMarkdown = cleanedResponse;
        tempState.currentRecipe = currentRecipeMarkdown;

        if(typeof renderRecipeOutput === 'function') {
            await renderRecipeOutput(currentRecipeMarkdown); 
        } else {
            console.warn("renderRecipeOutput nog niet geladen.");
            if(recipeOutput) recipeOutput.innerText = currentRecipeMarkdown; 
        }

    } catch (error) {
        if (thinkingInterval) clearInterval(thinkingInterval);
        // v2.6 Sluitend gecentraliseerd logframework geïntegreerd
        window.logSystemError(error, 'brewing.js: generateRecipe', 'CRITICAL');
        window.showToast("Failed to generate recipe. Check system logs.", "error");
        if(recipeOutput) recipeOutput.innerHTML = `<p class="text-red-500 p-4">Error generating recipe: ${error.message}</p>`;
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
window.loadHistory = loadHistory;

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

    if (!brew.logData) brew.logData = {};
    if (!brew.logData.brewDate) {
        brew.logData.brewDate = new Date().toISOString().split('T');
        try {
            await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { 
                logData: brew.logData 
            });
            showToast("Brew date set to today!", "info");
        } catch (error) { 
            window.logSystemError(error, 'brewing.js -> startActualBrewDay (saveDate)', 'ERROR');
            window.showToast("Failed to write brew date to database.", "error");
        }
    }

    if (brew.checklist && Object.keys(brew.checklist).length > 0) {
        if (confirm("This batch has existing progress. Reset checklist and start over?")) {
            brew.checklist = {};
            try {
                await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { checklist: {} });
            } catch (error) { 
                window.logSystemError(error, 'brewing.js -> startActualBrewDay (resetChecklist)', 'ERROR');
                window.showToast("Failed to reset checklist in database.", "error");
            }
        }
    } else {
        if(!brew.checklist) brew.checklist = {};
    }

    tempState.activeBrewId = brewId;
    
    if (state.userSettings) {
        state.userSettings.currentBrewDay = { brewId: brewId };
        if (window.saveUserSettings) window.saveUserSettings();
        else {
            try {
                await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main'), { 
                    currentBrewDay: { brewId: brewId } 
                }, { merge: true });
            } catch(error) { 
                window.logSystemError(error, 'brewing.js -> startActualBrewDay (saveSettingsFallback)', 'ERROR');
            }
        }
    }
    
    switchSubView('brew-day-1', 'brewing-main-view');
    renderBrewDay(brewId);
};

// --- RENDER: Brew Day 1 (Dashboard / Detail Split) ---
window.renderBrewDay = async function(forceId = null) {
    const brewDayContent = document.getElementById('brew-day-content');
    if (!brewDayContent) return;

    let activeId = forceId || tempState.activeBrewId;
    if (!activeId && state.userSettings?.currentBrewDay?.brewId) {
        activeId = state.userSettings.currentBrewDay.brewId;
    }

    const activeBrews = state.brews.filter(b => b.logData?.brewDate && !b.primaryComplete);

    if (activeId && activeId !== 'none') {
        const brew = state.brews.find(b => b.id === activeId);
        
        // --- CRISIS MANAGEMENT & RECURSIELUS FIX (v2.6 Data Guard) ---
        if (!brew) { 
            // Blokkeer destructieve sanitisatie zolang de onSnapshot datastroom nog niet minimaal één keer succesvol is verwerkt
            if (!tempState.historyLoaded) {
                console.log("Local history cache snapshot sync is in progress. Postponing query validation.");
                brewDayContent.innerHTML = getLoaderHtml("Syncing Fermentation Chamber...");
                return;
            }

            console.warn("Active batch missing from local cache. Sanitizing Source of Truth to prevent infinite loops.");
            tempState.activeBrewId = null; 
            
            if (state.userSettings) {
                state.userSettings.currentBrewDay = { brewId: null };
                
                try {
                    if (typeof window.saveUserSettings === 'function') {
                        await window.saveUserSettings();
                    } else {
                        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main'), {
                            currentBrewDay: { brewId: null }
                        });
                    }
                } catch (error) {
                    window.logSystemError(error, 'brewing.js -> renderBrewDay (Sanitize Fallback)', 'ERROR');
                }
            }
            // Herstart de renderer met een schone lei zonder argumenten
            return window.renderBrewDay(null); 
        }

        tempState.activeBrewId = activeId;
        if(state.userSettings) { 
             state.userSettings.currentBrewDay = { brewId: activeId };
             if(window.saveUserSettings) window.saveUserSettings();
        }

        let primarySteps = brew.brewDaySteps || [];
        if (primarySteps.length === 0 && brew.recipeMarkdown) {
            const extracted = extractStepsFromMarkdown(brew.recipeMarkdown);
            primarySteps = extracted.day1;
            brew.brewDaySteps = extracted.day1; 
            brew.secondarySteps = extracted.day2; 
        }

        const stepsHtml = primarySteps.map((step, index) => {
            const checklist = brew.checklist || {};
            const stepData = checklist["step-" + index];
            const isCompleted = stepData === true || (stepData && stepData.completed);
            const savedAmount = (stepData && stepData.actualAmount) ? stepData.actualAmount : '';
            const amountMatch = (step.title + " " + step.description).match(/(\d+[.,]?\d*)\s*(kg|g|l|ml|oz|lbs)/i);
            
            let inputHtml = '';
            if (amountMatch && !isCompleted) {
                inputHtml = `<div class="mt-2 flex items-center bg-app-primary rounded border border-app-brand/20 w-32">
                    <span class="px-2 text-[9px] font-bold text-app-secondary uppercase border-r border-app-brand/10">Act</span>
                    <input type="number" id="step-input-${index}" class="w-full bg-transparent border-none p-1 text-center font-bold text-sm" placeholder="${amountMatch.at(1)}" value="${amountMatch.at(1)}">
                    <span class="pr-2 text-xs font-bold text-app-brand">${amountMatch.at(2)}</span>
                </div>`;
            } else if (isCompleted && savedAmount) {
                 inputHtml = `<div class="mt-2 inline-flex items-center gap-2 px-2 py-1 rounded bg-green-500/10 border border-green-500/20"><span class="text-[9px] font-bold text-green-700 uppercase">Recorded:</span><span class="font-mono font-bold text-green-800 text-xs">${savedAmount}</span></div>`;
            }

            const timerHtml = step.duration > 0 ? `<div class="timer-display my-2 text-sm font-mono font-bold text-app-brand bg-app-primary inline-block px-2 py-1 rounded border border-app-brand/20" id="timer-${index}">${formatTime(step.duration)}</div>` : '';
            const btnHtml = step.duration > 0 ? `<button onclick="window.startStepTimer('${brew.id}', ${index})" class="text-xs bg-green-600 text-white py-1.5 px-3 rounded shadow hover:bg-green-700 btn font-bold uppercase">Start Timer</button>` : `<button onclick="window.completeStep(${index})" class="text-xs bg-app-tertiary border border-app-brand/30 text-app-brand font-bold py-1.5 px-3 rounded hover:bg-app-brand hover:text-white transition-colors btn uppercase">Check</button>`;

            return `<div id="step-${index}" class="step-item p-4 border-b border-app-brand/10 ${isCompleted ? 'opacity-60 grayscale' : ''}">
                <div class="flex justify-between items-start gap-4">
                    <div class="flex-grow">
                        <p class="font-bold text-sm text-app-header flex items-center gap-2"><span class="w-5 h-5 rounded-full bg-app-tertiary text-[10px] flex items-center justify-center border border-app-brand/20">${index + 1}</span> ${step.title}</p>
                        <div class="pl-7"><p class="text-xs text-app-secondary mt-1 opacity-90">${step.description}</p>${inputHtml}${timerHtml}</div>
                    </div>
                    <div class="pt-1 flex flex-col items-end gap-1" id="controls-${index}">${isCompleted ? `<button onclick="window.undoStep(${index})" class="text-[10px] font-bold text-white bg-green-600 px-2 py-1 rounded shadow-sm hover:bg-red-500 transition-colors" title="Undo / Edit">DONE ↺</button>` : btnHtml}</div>
                </div>
            </div>`;
        }).join('');

        const logHtml = getBrewLogHtml(brew, brew.id);

        brewDayContent.innerHTML = `
            <div class="bg-app-secondary p-4 md:p-6 rounded-lg shadow-lg">
                <div class="flex items-center justify-between mb-4 pb-2 border-b border-app-brand/10">
                    <button onclick="window.closePrimaryDetail()" class="text-xs font-bold text-app-secondary hover:text-app-brand uppercase tracking-wider flex items-center gap-1">&larr; Back to Overview</button>
                    <span class="text-[10px] font-bold uppercase tracking-widest text-app-brand opacity-60">Active Session</span>
                </div>
                <div class="text-center mb-6">
                    <h2 class="text-2xl font-header font-bold text-app-brand mb-1">${brew.recipeName}</h2>
                    <p class="text-[10px] font-bold uppercase tracking-widest text-app-secondary opacity-60">Primary Fermentation Protocol</p>
                </div>
                <div class="bg-app-secondary rounded-xl shadow-sm border border-app-brand/10 overflow-hidden mb-8">${stepsHtml}</div>
                ${logHtml}
                <div class="mt-6 space-y-3 pb-2 border-t border-app-brand/10 pt-4">
                    <button onclick="window.finishPrimaryManual('${brew.id}')" class="w-full bg-green-600 text-white py-3 px-4 rounded-lg hover:bg-green-700 btn font-bold shadow-md uppercase tracking-wider flex items-center justify-center gap-2">Finish Primary & Go to Aging &rarr;</button>
                    <div class="grid grid-cols-2 gap-3">
                        <button onclick="window.updateBrewLog('${brew.id}', 'brew-day-content')" class="bg-app-action text-white py-3 px-4 rounded-lg font-bold uppercase text-xs">Save Logs</button>
                        <button onclick="window.deductActualsFromInventory('${brew.id}')" class="bg-app-tertiary text-app-secondary border border-app-brand/20 py-3 px-4 rounded-lg font-bold uppercase text-xs">Update Stock</button>
                    </div>
                </div>
            </div>`;
        return;
    }

    const listHtml = activeBrews.map(b => {
        const startDate = b.logData?.brewDate || 'Unknown';
        const days = Math.floor((new Date() - new Date(startDate)) / (1000 * 60 * 60 * 24));
        const dayLabel = days >= 0 ? `Day ${days + 1}` : 'Pending';
        return `<div onclick="window.openPrimaryDetail('${b.id}')" class="p-4 card rounded-2xl cursor-pointer bg-surface-container border border-outline-variant hover:border-primary hover:shadow-elevation-1 mb-3 transition-all group relative">
            <div class="flex justify-between items-center">
                <div><h4 class="font-bold text-lg font-header text-on-surface group-hover:text-primary transition-colors leading-tight">${b.recipeName}</h4>
                    <div class="flex items-center gap-3 mt-1.5"><span class="text-[10px] font-bold uppercase bg-surface-variant text-on-surface-variant px-2 py-0.5 rounded-full border border-outline-variant/30">${dayLabel}</span><span class="text-xs text-on-surface-variant opacity-80">Started: ${startDate}</span></div>
                </div>
                <div class="text-primary opacity-0 group-hover:opacity-100 transition-opacity transform translate-x-2 group-hover:translate-x-0"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7M5 5l7 7-7 7"></path></svg></div>
            </div>
        </div>`;
    }).join('');

    if (activeBrews.length === 0) {
        brewDayContent.innerHTML = `<div class="max-w-2xl mx-auto"><div class="flex justify-between items-end mb-6 px-1 border-b border-outline-variant/50 pb-2"><div><h2 class="text-2xl font-header font-bold text-primary uppercase tracking-wider">Fermentation Chamber</h2><p class="text-xs text-on-surface-variant uppercase tracking-wider font-bold opacity-60">Empty</p></div><button onclick="window.promptNewBrewType()" class="text-xs bg-primary text-on-primary px-4 py-2 rounded-full font-bold shadow-elevation-1 hover:brightness-110 transition-all uppercase tracking-wide flex items-center gap-1"><span>+</span> New</button></div><div class="text-center py-12 px-4 opacity-60"><p class="text-sm text-on-surface-variant">No active brews found.<br>Start a new batch above!</p></div></div>`;
    } else {
        brewDayContent.innerHTML = `<div class="max-w-2xl mx-auto"><div class="flex justify-between items-end mb-6 px-1 border-b border-outline-variant/50 pb-2"><div><h2 class="text-2xl font-header font-bold text-primary uppercase tracking-wider">Fermentation Chamber</h2><p class="text-xs text-on-surface-variant uppercase tracking-wider font-bold opacity-60">${activeBrews.length} Active Batches</p></div><button onclick="window.promptNewBrewType()" class="text-xs bg-primary text-on-primary px-4 py-2 rounded-full font-bold shadow-elevation-1 hover:brightness-110 transition-all uppercase tracking-wide flex items-center gap-1"><span>+</span> New</button></div><div class="space-y-3">${listHtml}</div></div>`;
    }
};

// ============================================================================
// MODIFICATIE: window.renderBrewDay2 met Split Batch Protocol UI-integratie
// ============================================================================
window.renderBrewDay2 = async function() {
    const container = document.getElementById('brew-day-2-view');
    if (!container) return;

    try {
        // 1. Data ophalen (Sluit gesplitste ouderbatches uit van de actieve aging lijst)
        const agingBrews = state.brews.filter(b => b.primaryComplete && !b.isBottled && b.status !== 'split');
        const activeId = tempState.activeBrewId;
        const activeBrew = activeId ? state.brews.find(b => b.id === activeId) : null;

        // --- SCENARIO A: DETAIL ---
        if (activeBrew) {
            let steps = activeBrew.secondarySteps || [];
            if (steps.length === 0 && activeBrew.recipeMarkdown) {
                const extracted = extractStepsFromMarkdown(activeBrew.recipeMarkdown);
                steps = extracted.day2;
                activeBrew.secondarySteps = steps; 
            }
            
            const checklist = activeBrew.checklist || {};
            
            const stepsHtml = steps.map((step, idx) => {
                const key = `sec-step-${idx}`;
                const isChecked = checklist[key] === true;
                const btnHtml = isChecked 
                    ? `<span class="text-xs font-bold text-green-600 border border-green-600 px-2 py-0.5 rounded">DONE</span>` 
                    : `<button onclick="window.toggleSecondaryStep('${activeBrew.id}', '${key}')" class="text-xs bg-app-tertiary border border-app-brand/30 text-app-brand font-bold py-1 px-3 rounded hover:bg-app-brand hover:text-white transition-colors btn uppercase">Check</button>`;
                
                return `
                <div class="p-4 border-b border-app-brand/10 flex justify-between items-start gap-4 ${isChecked ? 'opacity-60 grayscale' : ''}">
                    <div class="flex-grow">
                        <p class="font-bold text-sm text-app-header flex items-center gap-2">
                            <span class="w-5 h-5 rounded-full bg-app-tertiary text-[10px] flex items-center justify-center border border-app-brand/20">${idx + 1}</span> ${step.title}
                        </p>
                        <p class="text-xs text-app-secondary mt-1 pl-7 opacity-90">${step.description}</p>
                    </div>
                    <div class="pt-1">${btnHtml}</div>
                </div>`;
            }).join('');

            // --- STABILIZATION GATEKEEPER SECTION ---
            const currentPhStr = (activeBrew.logData?.actualFG_pH || activeBrew.logData?.pH || "").toString().replace(',', '.');
            const abv = parseFloat(activeBrew.logData?.finalABV || activeBrew.logData?.targetABV || 0);
            const fgVal = parseFloat(activeBrew.logData?.actualFG || 1.000); 
            const phVal = parseFloat(currentPhStr);

            // Hall/Delle Calculations
            let delleDisplay = "--";
            let isDelleStable = false;
            let hallError = false;

            if (fgVal >= 1.775) {
                hallError = true;
                delleDisplay = "LIMIT ERR";
            } else {
                const brixVal = (fgVal > 1) ? ((182.9622 * Math.pow(fgVal, 3)) - (777.3009 * Math.pow(fgVal, 2)) + (1264.5170 * fgVal) - 670.1831) : 0;
                const delleValue = (abv * 4.5) + brixVal;
                isDelleStable = delleValue >= 78 || abv >= 15; 
                delleDisplay = `${delleValue.toFixed(1)} / 78.0`;
            }

            const gateHtml = `
            <div id="stabilization-gatekeeper" class="mt-8 p-6 bg-app-tertiary/50 border-2 border-app-brand/20 rounded-xl no-print">
                <div class="mb-6 p-4 bg-red-600 text-white rounded-lg text-xs font-bold shadow-lg border-2 border-red-800 ${abv >= 15 ? 'hidden' : 'animate-pulse'}">
                    WAARSCHUWING: Kaliumsorbaat is een fungistatisch middel (sterilisator), geen fungicide (doder). 
                    Het blokkeert uitsluitend de reproductie. Bestaande actieve gisten in een troebele most blijven suiker vergisten, 
                    wat leidt tot explosieve flesbommen bij back-sweetening. Stabilisatie is enkel toegestaan bij een visueel geklaarde most.
                </div>

                <h3 class="text-xl font-header font-bold text-app-brand mb-4 flex items-center gap-2">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
                    Stabilization Gatekeeper
                </h3>

                <div class="space-y-4 mb-6">
                    <label class="flex items-start gap-3 p-3 bg-app-secondary rounded-lg border border-app-brand/10 cursor-pointer">
                        <input type="checkbox" id="cb-checklist-cleared" class="mt-1 w-5 h-5 text-app-brand rounded focus:ring-app-brand" 
                            ${checklist.checklist_cleared ? 'checked' : ''} onchange="window.updateGateStatus('${activeBrew.id}', 'checklist_cleared')">
                        <span class="text-sm text-app-header font-medium">Ik bevestig dat de mede hydrometrisch stabiel en visueel helder is (biomassa gedecimeerd).</span>
                    </label>

                    <label class="flex items-start gap-3 p-3 bg-app-secondary rounded-lg border border-app-brand/10 cursor-pointer">
                        <input type="checkbox" id="cb-checklist-so2-sync" class="mt-1 w-5 h-5 text-app-brand rounded focus:ring-app-brand" 
                            ${checklist.checklist_so2_sync ? 'checked' : ''} onchange="window.updateGateStatus('${activeBrew.id}', 'checklist_so2_sync')">
                        <span class="text-sm text-app-header font-medium">Ik bevestig de aanwezigheid van actieve vrije SO2 (ter voorkoming van Geranium Taint).</span>
                    </label>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    <div class="p-4 bg-app-primary rounded-lg border border-app-brand/10">
                        <label class="text-[10px] font-bold text-app-secondary uppercase block mb-1">Actuele pH (Drempel: 2.8 - 4.5)</label>
                        <input type="number" id="gate-ph-input" step="0.01" value="${currentPhStr}" 
                            class="w-full bg-app-tertiary border border-app-brand/30 rounded p-2 text-lg font-mono font-bold text-app-brand focus:ring-1 focus:ring-app-brand" 
                            placeholder="3.x" oninput="this.value = this.value.replace(',', '.'); window.renderBrewDay2()">
                    </div>
                    <div class="p-4 bg-app-primary rounded-lg border border-app-brand/10">
                        <label class="text-[10px] font-bold text-app-secondary uppercase block mb-1">Delle-Stabiliteit Index</label>
                        <div class="text-lg font-mono font-bold ${hallError ? 'text-red-600 animate-pulse' : (isDelleStable ? 'text-green-600' : 'text-orange-500')}">
                            ${delleDisplay} ${!hallError ? (isDelleStable ? '✅' : '⚠️') : ''}
                        </div>
                    </div>
                </div>

                ${isDelleStable && !hallError ? `
                    <div class="mb-4 p-3 bg-green-500/10 border border-green-500/30 text-green-700 rounded-lg text-xs font-bold animate-fade-in">
                        Delle-stabiliteit of ABV gevarengrens (>=15%) bereikt. Gistmetabolisme fysiologisch geïnhibeerd door ethanoltoxiciteit. Chemische stabilisatie met kaliumsorbaat is overbodig en marginaal effectief.
                    </div>
                ` : ''}

                ${hallError ? `
                    <div class="mb-4 p-3 bg-red-600/20 border border-red-600 text-red-600 rounded-lg text-xs font-bold">
                        ⚠️ LIMIT ERR: FG overschrijdt de Hall-limiet. Controleer meting.
                    </div>
                ` : ''}
            </div>`;

            const logHtml = (typeof getBrewLogHtml === 'function') ? getBrewLogHtml(activeBrew, activeBrew.id + '-sec') : '';

            // Validation Logic
            const isPhValid = !isNaN(phVal) && phVal >= 2.8 && phVal <= 4.5;
            const isGatePassed = checklist.checklist_cleared && checklist.checklist_so2_sync && isPhValid && !hallError;

            container.innerHTML = `
                <div class="bg-app-secondary p-4 md:p-6 rounded-lg shadow-lg">
                    <div class="flex items-center justify-between mb-4 pb-2 border-b border-app-brand/10">
                        <div class="flex gap-2">
                            <button onclick="window.closeSecondaryDetail()" class="text-xs font-bold text-app-secondary hover:text-app-brand uppercase tracking-wider flex items-center gap-1">
                                &larr; Back
                            </button>
                            <button onclick="window.revertToPrimary('${activeBrew.id}')" class="text-xs font-bold text-red-400 hover:text-red-600 uppercase tracking-wider flex items-center gap-1 ml-2 border-l border-app-brand/10 pl-2">
                                ↺ Undo Finish
                            </button>
                        </div>
                        <span class="text-[10px] font-bold uppercase tracking-widest text-app-brand opacity-60">Secondary Phase</span>
                    </div>

                    <div class="text-center mb-6">
                        <h2 class="text-2xl font-header font-bold text-app-brand mb-1">${activeBrew.recipeName}</h2>
                        <p class="text-[10px] font-bold uppercase tracking-widest text-app-secondary opacity-60">Aging & Stabilization</p>
                        <div class="mt-2 text-xs text-app-secondary font-mono bg-app-primary inline-block px-3 py-1 rounded border border-app-brand/10">
                            Current Batch Volume: <span class="text-app-brand font-bold">${activeBrew.batchSize || 5}L</span>
                        </div>
                    </div>

                    <div class="mb-6 p-4 border border-purple-500/30 bg-purple-500/5 rounded-xl no-print flex justify-between items-center transition-all">
                        <div>
                            <h4 class="font-bold text-purple-700 text-sm uppercase flex items-center gap-2">Split Batch Protocol</h4>
                            <p class="text-xs text-app-secondary mt-1">Split this aging vessel into multiple carboys or experimental fractions.</p>
                        </div>
                        <button onclick="window.showSplitModal('${activeBrew.id}', ${activeBrew.batchSize || 5})" class="bg-purple-600 text-white py-2 px-4 rounded-lg text-xs font-bold hover:bg-purple-700 btn transition-all shadow-sm whitespace-nowrap">Split Batch</button>
                    </div>

                    <div class="bg-app-secondary rounded-xl shadow-sm border border-app-brand/10 overflow-hidden mb-4">
                        ${stepsHtml}
                    </div>

                    ${gateHtml}

                    <div id="brew-day-2-log-container" class="mt-6">${logHtml}</div>

                    <div class="mt-6 space-y-3 pb-2 border-t border-t-app-brand/10 pt-4">
                        <button onclick="window.showBottlingModal('${activeBrew.id}')" 
                            ${!isGatePassed ? 'disabled' : ''} 
                            class="w-full ${isGatePassed ? 'bg-green-600' : 'bg-gray-400 cursor-not-allowed'} text-white py-3 px-4 rounded-lg btn font-bold shadow-md uppercase tracking-wider transition-all">
                            ${isGatePassed ? 'Confirm Stabilization & Back-sweetening / Proceed to Bottling' : 'Check Requirements & pH (2.8-4.5)'}
                        </button>
                        <button onclick="window.updateBrewLog('${activeBrew.id}', 'brew-day-2-log-container')" class="w-full bg-app-action text-white py-3 px-4 rounded-lg btn font-bold uppercase tracking-wider text-xs">Save Log Notes</button>
                    </div>
                </div>`;
            return;
        }

        const listHtml = agingBrews.map(b => {
            const startDate = b.logData?.brewDate || 'Unknown';
            const days = Math.floor((new Date() - new Date(startDate)) / (1000 * 60 * 60 * 24));
            return `
            <div onclick="window.openSecondaryDetail('${b.id}')" 
                 class="p-4 rounded-xl cursor-pointer bg-surface-container border border-outline-variant/60 border-l-4 border-l-purple-500 shadow-sm hover:shadow-md transition-all mb-3 relative group">
                <div class="flex justify-between items-center">
                    <div>
                        <h4 class="font-bold text-lg font-header text-on-surface group-hover:text-purple-600 transition-colors leading-tight">${b.recipeName}</h4>
                        <div class="flex items-center gap-3 mt-2">
                            <span class="text-[10px] font-bold uppercase bg-purple-100 text-purple-700 px-2 py-0.5 rounded border border-purple-200">Aging: Day ${days}</span>
                            <span class="text-xs text-on-surface-variant opacity-80">Vol: ${b.batchSize || 5}L</span>
                            ${b.parentBrewId ? '<span class="text-[9px] font-bold uppercase bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded border border-amber-200">Fractioned</span>' : ''}
                        </div>
                    </div>
                    <div class="text-on-surface-variant/30 group-hover:text-purple-500 group-hover:translate-x-1 transition-all">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                    </div>
                </div>
            </div>`;
        }).join('');

        if (agingBrews.length === 0) {
            container.innerHTML = `<div class="text-center py-12 opacity-60"><p class="text-sm text-on-surface-variant">No active batches in secondary.</p></div>`;
            return;
        }
        
        container.innerHTML = `<div class="max-w-2xl mx-auto"><h2 class="text-2xl font-header font-bold text-app-brand mb-6">Aging Chamber</h2><div class="space-y-3">${listHtml}</div></div>`;

    } catch (error) {
        window.logSystemError(error, 'brewing.js: renderBrewDay2', 'ERROR');
        window.showToast("Fout bij renderen aging-view.", "error");
    }
};

// ============================================================================
// MODIFICATIE: Globale functionaliteit voor het Split Batch Protocol
// ============================================================================
window.showSplitModal = function(brewId, currentVolume) {
    let modal = document.getElementById('split-batch-modal');
    if (!modal) {
        const modalHtml = `
        <div id="split-batch-modal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm hidden animate-fade-in">
            <div class="bg-app-secondary p-6 rounded-xl shadow-2xl border border-app-brand/20 w-full max-w-md relative">
                <button onclick="window.closeSplitModal()" class="absolute top-3 right-4 text-app-secondary hover:text-red-500 font-bold text-xl">&times;</button>
                <h3 class="text-xl font-header font-bold text-purple-600 mb-2">Split Batch Protocol</h3>
                <p class="text-xs text-app-secondary mb-4">Verdeel de moederbatch in autonome sub-vaten voor fractionering of smaak-experimenten.</p>
                
                <input type="hidden" id="split-parent-id">
                <input type="hidden" id="split-max-volume">
                
                <div class="space-y-4">
                    <div class="p-3 bg-app-primary rounded-lg border border-app-brand/10 text-xs">
                        <span class="text-app-secondary uppercase font-bold block mb-1">Beschikbaar Volume</span>
                        <span id="split-volume-display" class="text-base font-mono font-bold text-app-header">0.00 L</span>
                    </div>
                    <div>
                        <label class="text-xs font-bold text-app-secondary uppercase block mb-1">Aantal splitsingen (Carboys)</label>
                        <input type="number" id="split-count-input" min="2" max="10" value="2" class="w-full p-2 border rounded bg-app-tertiary text-app-header text-sm" oninput="window.generateSplitVolumeInputs()">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-app-secondary uppercase block mb-1">Systeem/Trub Verlies factor ($V_{loss}$ in Liters)</label>
                        <input type="text" id="split-loss-input" value="1.0" class="w-full p-2 border rounded bg-app-tertiary font-mono text-sm" oninput="window.generateSplitVolumeInputs()">
                    </div>
                    
                    <div id="split-volumes-container" class="space-y-2 max-h-48 overflow-y-auto p-1 border border-transparent border-t-app-brand/10 pt-3">
                        </div>
                    
                    <div class="p-3 bg-app-primary rounded-lg border border-app-brand/10 text-xs flex justify-between items-center">
                        <span class="text-app-secondary font-medium">Rest-volume balans:</span>
                        <span id="split-balance-display" class="font-mono font-bold text-green-600">0.00 L</span>
                    </div>
                    
                    <button onclick="window.executeSplitFromModal()" class="w-full bg-purple-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-purple-700 transition-all btn uppercase text-sm shadow-md">Definitief splitsen & muteren</button>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        modal = document.getElementById('split-batch-modal');
    }
    
    document.getElementById('split-parent-id').value = brewId;
    document.getElementById('split-max-volume').value = currentVolume;
    document.getElementById('split-volume-display').textContent = `${parseFloat(currentVolume).toFixed(2)} Liter`;
    modal.classList.remove('hidden');
    window.generateSplitVolumeInputs();
};

window.closeSplitModal = function() {
    const modal = document.getElementById('split-batch-modal');
    if (modal) modal.classList.add('hidden');
};

window.generateSplitVolumeInputs = function() {
    const container = document.getElementById('split-volumes-container');
    const parentVol = parseFloat(document.getElementById('split-max-volume').value) || 0;
    const count = parseInt(document.getElementById('split-count-input').value) || 2;
    const loss = parseFloat(String(document.getElementById('split-loss-input').value).replace(',', '.')) || 0;
    
    if (!container) return;
    
    // Bereken automatische gelijke verdeling voor de initiële placeholders
    const netVol = Math.max(0, parentVol - loss);
    const equalShare = (netVol / count).toFixed(2);
    
    let html = '<p class="text-[10px] font-bold text-app-secondary uppercase tracking-wider mb-1">Gespecificeerde Volumes per Child (L)</p>';
    for (let i = 0; i < count; i++) {
        html += `
        <div class="flex items-center gap-2 bg-app-secondary p-1.5 rounded border border-app-brand/5">
            <span class="text-xs font-bold text-app-secondary w-16 uppercase">Child ${i + 1}:</span>
            <input type="text" class="child-volume-field w-full bg-app-tertiary border border-app-brand/20 p-1 text-center font-mono font-bold text-sm rounded focus:ring-1 focus:ring-purple-500" value="${equalShare}" oninput="window.calculateSplitBalance()">
            <span class="text-xs font-bold text-app-brand pr-2">L</span>
        </div>`;
    }
    container.innerHTML = html;
    window.calculateSplitBalance();
};

window.calculateSplitBalance = function() {
    const parentVol = parseFloat(document.getElementById('split-max-volume').value) || 0;
    const loss = parseFloat(String(document.getElementById('split-loss-input').value).replace(',', '.')) || 0;
    const fields = document.querySelectorAll('.child-volume-field');
    const balanceDisplay = document.getElementById('split-balance-display');
    
    let sumChildren = 0;
    fields.forEach(field => {
        sumChildren += parseFloat(String(field.value).replace(',', '.')) || 0;
    });
    
    const balance = parentVol - loss - sumChildren;
    if (balanceDisplay) {
        balanceDisplay.textContent = `${balance.toFixed(2)} L`;
        if (Math.abs(balance) < 0.01) {
            balanceDisplay.className = "font-mono font-bold text-green-600";
        } else {
            balanceDisplay.className = "font-mono font-bold text-red-500 animate-pulse";
        }
    }
    return balance;
};

window.executeSplitFromModal = async function() {
    const parentBrewId = document.getElementById('split-parent-id').value;
    const loss = parseFloat(String(document.getElementById('split-loss-input').value).replace(',', '.')) || 0;
    const fields = document.querySelectorAll('.child-volume-field');
    
    const childVolumes = [];
    fields.forEach(field => {
        childVolumes.push(parseFloat(String(field.value).replace(',', '.')) || 0);
    });
    
    const balance = window.calculateSplitBalance();
    if (Math.abs(balance) > 0.02) {
        window.showToast(`Fout: Balans klopt niet. Rest-volume is ${balance.toFixed(2)}L. Zorg dat de som van Child-volumes en verlies exact gelijk is aan de Moederbatch.`, "error");
        return;
    }
    
    if (confirm("Weet je zeker dat je deze batch wilt splitsen? Dit archiveert de huidige moederbatch en genereert autonome dochter-batches.")) {
        await window.splitBatch(parentBrewId, childVolumes, loss);
    }
};

window.splitBatch = async function(parentBrewId, childVolumes, lossVolume) {
    if (!state.userId || !parentBrewId) return;

    try {
        // 1. Haal de Parent brouwbatch op uit state.brews
        const parentBrew = state.brews.find(b => b.id === parentBrewId);
        if (!parentBrew) throw new Error("Parent brew session missing from local context.");

        // Input Sanitisatie op optioneel verliesvolume
        const sanitizedLoss = parseFloat(String(lossVolume).replace(',', '.')) || 0;

        // Base-init imports for write transactions
        const { db, collection, addDoc, updateDoc, doc, serverTimestamp } = await import('./firebase-init.js');

        // 2. Immutabele Overerving via Deep Cloning van kritieke trends
        const recipeMarkdown = parentBrew.recipeMarkdown || "";
        const originalOG = parentBrew.logData?.actualOG || "";
        const originalFG = parentBrew.logData?.actualFG || "";
        const originalABV = parentBrew.logData?.finalABV || "";
        const fermentationLog = Array.isArray(parentBrew.logData?.fermentationLog) ? [...parentBrew.logData.fermentationLog] : [];
        const brewDaySteps = Array.isArray(parentBrew.brewDaySteps) ? [...parentBrew.brewDaySteps] : [];
        const flavorProfile = parentBrew.flavorProfile ? { ...parentBrew.flavorProfile } : {};
        const model = parentBrew.model || "gemini-1.5-flash";

        // Loop door gedefinieerde child volumes en instancieer deelbatches
        for (let i = 0; i < childVolumes.length; i++) {
            const childVol = parseFloat(String(childVolumes[i]).replace(',', '.')) || 0;
            if (childVol <= 0) continue;

            const childBrewObj = {
                recipeName: `${parentBrew.recipeName || 'Untitled'} - Split [${i + 1}]`,
                recipeMarkdown: recipeMarkdown,
                batchSize: childVol,
                parentBrewId: parentBrewId,
                primaryComplete: true, // Behaalt direct status van primaire gisting
                isBottled: false,
                createdAt: serverTimestamp(),
                model: model,
                flavorProfile: flavorProfile,
                brewDaySteps: brewDaySteps,
                secondarySteps: [], // Secundaire stappen ontkoppelen voor schone start
                checklist: {},       // Checklist resetten naar nul-mutatie
                logData: {
                    actualOG: originalOG,
                    actualFG: originalFG,
                    finalABV: originalABV,
                    brewDate: parentBrew.logData?.brewDate || "",
                    fermentationLog: fermentationLog, // Behoud onbreekbare primaire gistingstrend
                    agingNotes: `Splitsing gefractioneerd uit moederbatch op ${new Date().toLocaleDateString()}. Toegewezen volume: ${childVol}L. Systeemverlies overgedragen: ${sanitizedLoss}L.`,
                    tastingNotes: "",
                    blendingLog: [],
                    actualIngredients: []
                }
            };

            // Schrijf autonoom Child naar Firestore
            await addDoc(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews'), childBrewObj);
        }

        // 3. Status Mutatie op de Parent (Vrijgeven uit actieve Aging Chamber)
        const parentRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', parentBrewId);
        await updateDoc(parentRef, {
            status: 'split',
            'logData.agingNotes': (parentBrew.logData?.agingNotes || "") + `\nBatch succesvol gesplitst in ${childVolumes.length} sub-vaten op ${new Date().toLocaleDateString()}. Totaal verlies: ${sanitizedLoss}L.`
        });

        // Update lokale cache status vlag
        parentBrew.status = 'split';

        // 4. UI-Sync en Sluiten van Modal
        window.closeSplitModal();
        tempState.activeBrewId = null; // Terugkeren naar lijstweergave van de kamer
        window.renderBrewDay2();
        window.showToast(`Batch succesvol gesplitst in ${childVolumes.length} autonome fracties!`, "success");

    } catch (error) {
        window.logSystemError(error, 'brewing.js: splitBatch', 'CRITICAL');
        window.showToast(`Splitsing mislukt: ${error.message}`, "error");
    }
};

// Bind nieuwe handlers aan het window-object om scope-leaks te voorkomen
window.showSplitModal = showSplitModal;
window.closeSplitModal = closeSplitModal;
window.generateSplitVolumeInputs = generateSplitVolumeInputs;
window.calculateSplitBalance = calculateSplitBalance;
window.executeSplitFromModal = executeSplitFromModal;
window.splitBatch = splitBatch;

// Update voltooid. Voor de volgende stap heb ik brewing.js of tools.js nodig.

// --- GATEKEEPER PERSISTENCE HELPER (Consolidated v2.6) ---
window.updateGateStatus = async function(brewId, gateKey) {
    try {
        const brew = state.brews.find(b => b.id === brewId);
        if (!brew) return;
        if (!brew.checklist) brew.checklist = {};

        const checkboxIdMap = {
            'checklist_cleared': 'cb-checklist-cleared',
            'checklist_so2_sync': 'cb-checklist-so2-sync',
            'gate_clarity': 'cb-visual-clarity',
            'gate_gravity': 'cb-gravity-stable'
        };

        const checkbox = document.getElementById(checkboxIdMap[gateKey]);
        if (checkbox) {
            brew.checklist[gateKey] = checkbox.checked;
        }

        // Firestore update via centralized init
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), {
            checklist: brew.checklist
        });

        // UI Refresh
        window.renderBrewDay2();
    } catch (error) {
        window.logSystemError(error, 'brewing.js: updateGateStatus', 'ERROR');
        window.showToast("Kon checklist status niet opslaan.", "error");
    }
};

// --- NIEUWE NAVIGATIE HELPERS ---

window.openPrimaryDetail = function(brewId) {
    // Scroll naar boven
    document.getElementById('brewing-main-view').scrollIntoView({ behavior: 'smooth' });
    // Render met ID
    window.renderBrewDay(brewId);
}

window.closePrimaryDetail = function() {
    // Reset state pointers
    tempState.activeBrewId = null;
    state.userSettings.currentBrewDay = { brewId: null };
    if(window.saveUserSettings) window.saveUserSettings(); // Opslaan dat we niets actief hebben
    
    // Render zonder ID (toont lijst)
    window.renderBrewDay(null);
}

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
    
    // 1. Data Opslaan
    const inputEl = document.getElementById(`step-input-${stepIndex}`);
    const actualAmount = inputEl ? inputEl.value : null;
    
    if (inputEl) {
        inputEl.disabled = true; // Maak het veld onbruikbaar
        inputEl.classList.add('opacity-50', 'cursor-not-allowed', 'bg-gray-100'); // Visuele feedback
    }
    
    brew.checklist[`step-${stepIndex}`] = { 
        completed: true, 
        actualAmount: actualAmount,
        timestamp: new Date().toISOString()
    };

    // 2. UI Update (Direct feedback: maak grijs en toon DONE)
    const stepDiv = document.getElementById(`step-${stepIndex}`);
    if(stepDiv) stepDiv.classList.add('opacity-60', 'grayscale');
    
    const controls = document.getElementById(`controls-${stepIndex}`);
    if(controls) controls.innerHTML = `<span class="text-[10px] font-bold text-white bg-green-600 px-2 py-1 rounded shadow-sm">DONE</span>`;

    // 3. Opslaan in Database via gecentraliseerd logframework
    try { 
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { 
            checklist: brew.checklist
        }); 
    } catch (error) { 
        window.logSystemError(error, 'brewing.js: completeStep', 'ERROR');
        window.showToast("Database-fout bij het opslaan van deze stap.", "error");
    }

    // 4. Auto-start de volgende timer? (Alleen bij korte timers)
    const allSteps = brew.brewDaySteps || [];
    const nextStep = allSteps[stepIndex + 1];
    
    if (nextStep && nextStep.duration > 0 && nextStep.duration < 3600 && !isSkipping) {
        window.startStepTimer(brewId, stepIndex + 1);
    }
};

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
    try {
        const brew = state.brews.find(b => b.id === brewId);
        if (!brew) return;
        if (!brew.checklist) brew.checklist = {};

        // 1. GERANIUM TAINT TRIGGER (v2.6)
        const stepObj = (brew.secondarySteps || [])[parseInt(stepKey.replace('sec-step-', ''))];
        const isSorbateStep = stepKey.includes('sorbate') || (stepObj && (stepObj.title.toLowerCase().includes('sorbat') || stepObj.description.toLowerCase().includes('sorbat')));
        
        if (isSorbateStep && !brew.checklist[stepKey]) {
            const currentPh = parseFloat(brew.logData?.actualFG_pH || brew.logData?.pH || 0);
            if (currentPh > 3.8) {
                window.showToast("⚠️ GEVAAR: pH > 3.8 gedetecteerd. Risico op Geranium Taint bij toevoeging van sorbaat!", "error", 8000);
                window.logSystemError(`Geranium Taint waarschuwing: batch ${brew.recipeName} (pH: ${currentPh})`, 'Mead Medic: Safety', 'WARNING');
            }
        }

        // 2. Toggle status
        brew.checklist[stepKey] = !brew.checklist[stepKey];
        renderBrewDay2();

        // 3. Opslaan
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), {
            checklist: brew.checklist
        });
    } catch (error) {
        window.logSystemError(error, 'brewing.js: toggleSecondaryStep', 'ERROR');
        showToast("Opslaan mislukt.", "error");
    }
};

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
    } catch (error) { 
        window.logSystemError(error, 'brewing.js: finishPrimaryManual', 'ERROR'); 
        window.showToast("Fout bij transitiestatus naar de secundaire fase.", "error"); 
    }
};

// --- MISSING HELPER: MARK PRIMARY AS COMPLETE ---
async function markPrimaryAsComplete(brewId) {
    if (!state.userId || !brewId) return;
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { primaryComplete: true });
        
        const idx = state.brews.findIndex(b => b.id === brewId);
        if (idx > -1) {
            state.brews[idx].primaryComplete = true;
        }
    } catch (error) { 
        window.logSystemError(error, 'brewing.js -> markPrimaryAsComplete', 'CRITICAL');
        window.showToast("Failed to update process transition status in database.", "error");
    }
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

        // Markeer de initialisatie/synchronisatie-status als voltooid binnen de Single Source of Truth
        tempState.historyLoaded = true;

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

        // Automatische UI-wedergeboorte trigger bij koude start/refresh
        const activeId = tempState.activeBrewId || state.userSettings?.currentBrewDay?.brewId;
        if (activeId && activeId !== 'none') {
            const brewCheck = state.brews.find(b => b.id === activeId);
            if (brewCheck) {
                if (brewCheck.primaryComplete) {
                    if (typeof window.renderBrewDay2 === 'function') window.renderBrewDay2();
                } else {
                    if (typeof window.renderBrewDay === 'function') window.renderBrewDay(activeId);
                }
            }
        }
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

window.addLogLine = function(idSuffix) {
    try {
        const container = document.getElementById(`fermentationContainer-${idSuffix}`);
        if (!container) return;

        const today = new Date().toISOString().split('T');
        const newEntry = document.createElement('div');
        newEntry.className = "log-entry bg-surface-container-low p-3 rounded-xl border border-outline-variant/30 mb-3 shadow-sm animate-fade-in relative group";
        
        const labelBase = "text-[10px] font-bold text-on-surface-variant uppercase tracking-wider mb-1 block ml-1";
        const inputBase = "bg-surface-container-highest border border-outline-variant text-sm rounded-lg focus:ring-1 focus:ring-primary !p-2 !h-10 w-full";

        newEntry.innerHTML = `
            <div class="flex justify-between items-end mb-3">
                <div class="flex-grow mr-4">
                    <label class="${labelBase}">Date</label>
                    <input type="date" value="${today}" class="${inputBase} font-medium">
                </div>
                <button onclick="this.closest('.log-entry').remove(); window.syncLogToFinal('${idSuffix}')" class="text-on-surface-variant hover:text-error hover:bg-error-container/20 p-2 rounded-lg transition-colors mb-[1px]" title="Delete Entry">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
            </div>
            <div class="grid grid-cols-2 gap-3 mb-3">
                <div>
                    <label class="${labelBase}">Temp (°C)</label>
                    <input type="number" step="0.5" class="${inputBase} text-center font-mono font-bold text-primary temp-input" placeholder="20" oninput="window.autoCalculateABV(event, '${idSuffix}')" onchange="window.autoCalculateABV(event, '${idSuffix}')">
                </div>
                <div>
                    <label class="${labelBase}">Gravity (SG/Brix)</label>
                    <input type="number" step="0.001" class="${inputBase} text-center font-mono font-bold text-primary sg-input" placeholder="1.xxx" oninput="this.value = this.value.replace(',', '.'); window.autoCalculateABV(event, '${idSuffix}')" onchange="window.autoCalculateABV(event, '${idSuffix}')">
                </div>
            </div>
            <div class="grid grid-cols-1 gap-3">
                <div>
                    <label class="${labelBase}">pH Level</label>
                    <input type="number" step="0.01" class="${inputBase} text-primary font-bold" placeholder="3.x" oninput="this.value = this.value.replace(',', '.'); window.syncLogToFinal('${idSuffix}');" onchange="window.autoCalculateABV(event, '${idSuffix}')">
                </div>
                <input type="text" class="${inputBase} italic text-on-surface-variant" placeholder="Add notes...">
            </div>
        `;
        
        container.appendChild(newEntry);
        newEntry.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
        window.logSystemError(error, 'brewing.js: addLogLine', 'ERROR');
    }
};

window.syncLogToFinal = function(idSuffix) {
    try {
        const container = document.getElementById(`fermentationContainer-${idSuffix}`);
        if (!container) return;

        const cleanId = idSuffix.replace('-sec', '');
        const brew = state.brews.find(b => b.id === cleanId);

        const entries = Array.from(container.querySelectorAll('.log-entry'));
        const fermentationLog = entries.map(div => {
            const inputs = div.querySelectorAll('input');
            if (inputs.length < 5) return null;

            // v2.6 Gecorrigeerde harde indexering op de NodeList inputs (Index 0 voor datum)
            return {
                date: inputs[0].value,
                temp: inputs[1].value.replace(',', '.'),
                sg: inputs[2].value.replace(',', '.'),
                ph: inputs[3].value.replace(',', '.'),
                notes: inputs[4].value
            };
        }).filter(e => e && e.sg);

        if (fermentationLog.length > 0) {
            const lastEntry = fermentationLog[fermentationLog.length - 1];
            const fgField = document.getElementById(`actualFG-${idSuffix}`);
            if (fgField) {
                fgField.value = lastEntry.sg;
                window.autoCalculateABV(null, idSuffix);
            }
        }

        if (brew) {
            if (!brew.logData) brew.logData = {};
            brew.logData.fermentationLog = fermentationLog;
            // v2.6 harde indexering en controle toegevoegd voor string splitsing
            if (brew.logData.brewDate && typeof brew.logData.brewDate === 'string') {
                brew.logData.brewDate = brew.logData.brewDate.split('T')[0];
            }
        }
    } catch (error) {
        window.logSystemError(error, 'brewing.js: syncLogToFinal', 'ERROR');
    }
};

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

    // 2. DATA SPLITSEN
    const targets = parseRecipeData(brew.recipeMarkdown);
    const logData = brew.logData || {};
    
    // 3. FLAVOR PROFILE HTML VOORBEREIDEN (De Fix)
    let flavorHtml = '';
    const hasFlavorData = brew.flavorProfile && (brew.flavorProfile.sweetness !== undefined || brew.flavorProfile.body_mouthfeel !== undefined);

    if (hasFlavorData) {
        // Data aanwezig: Maak ruimte voor canvas
        flavorHtml = `<div id="flavor-wheel-container-${brew.id}" class="h-64 flex items-center justify-center"><canvas id="flavorChart-${brew.id}"></canvas></div>`;
    } else {
        // Geen data: Toon Generate knop MET brewId
        flavorHtml = `
           <div id="flavor-wheel-container-${brew.id}" class="h-64 flex flex-col items-center justify-center text-center p-4">
               <div class="w-12 h-12 bg-surface-variant/30 rounded-full flex items-center justify-center mb-2">
                   <svg class="w-6 h-6 text-on-surface-variant" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"></path></svg>
               </div>
               <p class="text-xs text-on-surface-variant italic mb-3">No flavor profile data available.</p>
               <button onclick="window.regenerateFlavorProfile('${brew.id}')" class="bg-primary text-on-primary font-bold py-2 px-4 rounded-full text-xs shadow-sm hover:shadow-md transition-all">
                   Generate Analysis
               </button>
           </div>`;
    }

    // 4. KEY STATS HTML
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

    // 5. Logboek & Kosten
    let logHtml = getBrewLogHtml(logData, brew.id);
    logHtml += getActualIngredientsHtml(brew);

    const currency = state.userSettings?.currencySymbol || '€';
    let costHtml = '';
    if (brew.totalCost > 0) {
        const realVol = (logData.currentVolume && parseFloat(logData.currentVolume) > 0) ? parseFloat(logData.currentVolume) : (brew.batchSize || 5);
        const perL = realVol > 0 ? brew.totalCost / realVol : 0;
        costHtml = `<div class="mt-4 p-3 bg-amber-50 border border-amber-200 rounded text-amber-900 text-sm flex justify-between items-center shadow-sm"><span><strong>Total Cost:</strong> ${currency}${brew.totalCost.toFixed(2)}</span><span><strong>Cost/L:</strong> ${currency}${perL.toFixed(2)}</span></div>`;
    }

    // 6. BUILD HTML
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

        ${keyStatsHtml} 
        <div class="recipe-content prose dark:prose-invert max-w-none text-app-header bg-app-secondary p-4 rounded-lg shadow-sm border border-app-brand/5 mb-4">
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
                ${flavorHtml}
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

    // 7. RENDER CHARTS
    renderFermentationGraph(brew.id);
    
    // Alleen renderen als er data is, anders staat de knop er al
    if (hasFlavorData) {
        // Timeout om zeker te weten dat canvas in DOM zit
        setTimeout(() => {
            renderFlavorWheel(brew.id, 
                ['Sweetness', 'Acidity', 'Fruity', 'Spicy', 'Earthy', 'Body'], 
                [brew.flavorProfile.sweetness, brew.flavorProfile.acidity, brew.flavorProfile.fruity_floral, brew.flavorProfile.spiciness, brew.flavorProfile.earthy_woody, brew.flavorProfile.body_mouthfeel]
            );
        }, 50);
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
        const section = container.querySelector('.brew-log-section');
        const suffix = section ? section.dataset.id : brewId;
        
        const entryDivs = Array.from(container.querySelectorAll(`#fermentationContainer-${suffix} .log-entry`));
        
        const fermentationLog = entryDivs.map(div => {
            const inputs = div.querySelectorAll('input');
            if(inputs.length < 5) return null; 

            const rawPH = inputs[3].value.replace(',', '.');
            const pH = parseFloat(rawPH);

            // v2.6 Fix: Harde indexering toegepast voor de datumwaarde uit NodeList
            return { 
                date: inputs[0].value, 
                temp: inputs[1].value.replace(',', '.'), 
                sg: inputs[2].value.replace(',', '.'), 
                ph: (!isNaN(pH) && pH > 0) ? rawPH : '',
                notes: inputs[4].value 
            };
        }).filter(x => x && (x.date || x.sg));

        const blendRows = Array.from(container.querySelectorAll(`#blendingTable-${suffix} tbody tr`));
        const blendingLog = blendRows.map(r => {
            const inputs = r.querySelectorAll('input');
            if(inputs.length < 4) return null;
            // v2.6 Fix: Harde indexering toegepast voor de datumwaarde uit NodeList (Blending)
            return { 
                date: inputs[0].value, 
                name: inputs[1].value, 
                vol: inputs[2].value.replace(',', '.'), 
                abv: inputs[3].value.replace(',', '.') 
            };
        }).filter(x => x && (x.name || x.vol));

        const actRows = Array.from(container.querySelectorAll(`#actualsTable-${brewId} tbody tr`));
        const actualIngredients = actRows.map(r => ({ 
            name: r.dataset.name, 
            actualQty: r.querySelector('input').value.replace(',', '.') 
        }));

        const newData = {
            actualOG: container.querySelector(`#actualOG-${suffix}`)?.value.replace(',', '.') || '',
            actualFG: container.querySelector(`#actualFG-${suffix}`)?.value.replace(',', '.') || '',
            finalABV: container.querySelector(`#finalABV-${suffix}`)?.value || '',
            brewDate: container.querySelector(`#brewDate-${suffix}`)?.value || '',
            currentVolume: container.querySelector(`#currentVol-${suffix}`)?.value.replace(',', '.') || '', 
            agingNotes: container.querySelector(`#agingNotes-${suffix}`)?.value || '',
            bottlingNotes: container.querySelector(`#bottlingNotes-${suffix}`)?.value || '',
            tastingNotes: container.querySelector(`#tastingNotes-${suffix}`)?.value || '',
            fermentationLog: fermentationLog,
            blendingLog: blendingLog,
            actualIngredients: actualIngredients
        };

        const brewRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId);
        const snap = await getDoc(brewRef);
        
        if(snap.exists()) {
            const currentData = snap.data().logData || {};
            const merged = { ...currentData, ...newData };
            await updateDoc(brewRef, { logData: merged });
            
            const idx = state.brews.findIndex(b => b.id === brewId);
            if(idx > -1) state.brews[idx].logData = merged;
            
            showToast("Log saved successfully!", "success");
            if (typeof renderFermentationGraph === 'function') renderFermentationGraph(brewId);
        }
    } catch(e) { 
        window.logSystemError(e, 'brewing.js: updateBrewLog', 'ERROR');
        showToast("Save failed", "error"); 
    } finally { 
        if(btn) { btn.disabled = false; btn.innerText = originalText; } 
    }
};

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
    const brew = state.brews.find(b => b.id === brewId); 
    if (!brew) return;
    
    // Check inventory
    if (!state.inventory || state.inventory.length === 0) {
        showToast("Inventory empty.", "error");
        return;
    }

    try {
        const costResult = parseIngredientsAndCalculateCost(brew.recipeMarkdown, state.inventory, brew.batchSize);
        
        if (costResult.warnings.length > 0) {
            const msg = costResult.warnings.slice(0, 3).join('\n') + (costResult.warnings.length > 3 ? '\n...' : '');
            showToast(`Warnings:\n${msg}`, 'info');
        }
        
        if (confirm(`Calculated Cost: €${costResult.cost.toFixed(2)}. Update batch?`)) {
            await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { totalCost: costResult.cost });
            brew.totalCost = costResult.cost; // Lokale update
            
            if(document.getElementById('history-detail-container') && !document.getElementById('history-detail-container').classList.contains('hidden')) {
                window.showBrewDetail(brewId);
            }
            showToast("Cost updated!", "success");
        }
    } catch (error) {
        window.logSystemError(error, 'brewing.js: recalculateBatchCost', 'ERROR');
        window.showToast("Kostprijsberekening kon niet worden opgeslagen.", "error");
    }
};

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

        // 2. CHECK: Was dit de actieve batch? 
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

    } catch (error) { 
        window.logSystemError(error, 'brewing.js: deleteBrew', 'ERROR'); 
        showToast("Fout bij het verwijderen van de brouwbatch.", "error"); 
    }
};

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
    } catch (error) { 
        window.logSystemError(error, 'brewing.js: cloneBrew', 'ERROR'); 
        showToast("Dupliceren van batch mislukt.", "error"); 
    }
};

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
        window.logSystemError(error, 'brewing.js -> saveBrewToHistory', 'ERROR');
        showToast("Could not save recipe to history.", "error");
    }
};

// --- CHARTS & EXTRAS ---

window.runAgingAnalysis = async function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) return;

    try {
        // v2.6 Fix: ISO Indexing toegevoegd aan TODAY en BOTTLED
        const prompt = `Analyze aging potential:
        Batch: ${brew.recipeName}
        ABV: ${brew.logData?.finalABV || 'unknown'}
        Current SG: ${brew.logData?.actualFG || 'unknown'}
        TODAY: ${new Date().toISOString().split('T')[0]}
        BOTTLED: ${brew.logData?.bottlingDate ? brew.logData.bottlingDate.split('T')[0] : 'Not yet'}
        
        Provide a JSON object with: "peak_months" (number), "flavor_evolution" (string), "stability_risk" (string).`;

        const schema = {
            type: "OBJECT",
            properties: {
                "peak_months": { "type": "NUMBER" },
                "flavor_evolution": { "type": "STRING" },
                "stability_risk": { "type": "STRING" }
            },
            required: ["peak_months", "flavor_evolution", "stability_risk"]
        };

        const response = await performApiCall(prompt, schema);
        return JSON.parse(response);
    } catch (error) {
        window.logSystemError(error, 'brewing.js: runAgingAnalysis', 'ERROR');
        return null;
    }
};

function renderFermentationGraph(brewId) {
    try {
        const brew = state.brews.find(b => b.id === brewId);
        if (!brew || !brew.logData || !brew.logData.fermentationLog) return;
        
        const ctx = document.getElementById(`fermChart-${brewId}`);
        if (!ctx) return;
        
        const rawData = brew.logData.fermentationLog
            .filter(r => r.date && r.sg)
            .sort((a,b) => new Date(a.date) - new Date(b.date));
            
        if(rawData.length === 0) { ctx.parentElement.classList.add('hidden'); return; }

        const WCF = parseFloat(String(state.userSettings?.wcf || 1.04).replace(/,/g, '.'));
        const ogInput = parseFloat(String(brew.logData.actualOG || 1.000).replace(/,/g, '.'));
        
        // v2.6 Fix: Bates-Brix altijd delen door WCF voor WRI_i
        let WRI_i = 0;
        if (ogInput >= 1.2) {
            WRI_i = ogInput / WCF; 
        } else {
            const brixEquivalent = ((182.9622 * Math.pow(ogInput, 3)) - (777.3009 * Math.pow(ogInput, 2)) + (1264.5170 * ogInput) - 670.1831);
            WRI_i = brixEquivalent / WCF;
        }

        const processedData = rawData.map(d => {
            let val = parseFloat(String(d.sg).replace(/,/g, '.'));
            
            if (val > 1.2) {
                const WRI_f = val / WCF;
                val = 1.0 - (0.002349 * WRI_i) + (0.006276 * WRI_f);
            }
            return { date: d.date, sg: val };
        });

        if(window[`chart_${brewId}`]) window[`chart_${brewId}`].destroy();

        const cPrimary = `rgb(${window.getThemeColor('--md-sys-color-primary')})`;
        const cOnSurface = `rgb(${window.getThemeColor('--md-sys-color-on-surface')})`;
        const cGrid = `rgb(${window.getThemeColor('--md-sys-color-outline-variant')})`;

        window[`chart_${brewId}`] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: processedData.map(d => d.date),
                datasets: [{ 
                    label: 'True Gravity (Novotny-Bates)', 
                    data: processedData.map(d => d.sg), 
                    borderColor: cPrimary, 
                    backgroundColor: cPrimary + '33',
                    tension: 0.3,
                    fill: true,
                    pointRadius: 4
                }]
            },
            options: {
                responsive: true,
                scales: {
                    x: { grid: { color: cGrid }, ticks: { color: cOnSurface } },
                    y: { 
                        grid: { color: cGrid }, 
                        ticks: { color: cOnSurface },
                        suggestedMin: 0.990 
                    }
                },
                plugins: { legend: { display: false } }
            }
        });
    } catch (error) {
        window.logSystemError(error, 'Graph: renderFermentation', 'ERROR');
    }
}

// Bind de sync functie aan het window object voor de 'Opslaan' knop in de UI
window.syncLogToFinal = syncLogToFinal;

function getBrewLogHtml(brew, idSuffix = null) {
    try {
        const suffix = idSuffix || brew.id;
        const logData = brew.logData || {};
        const fermentationLog = logData.fermentationLog || [];
        
        const entriesHtml = fermentationLog.map((entry) => {
            const labelBase = "text-[10px] font-bold text-on-surface-variant uppercase tracking-wider mb-1 block ml-1";
            const inputBase = "bg-surface-container-highest border border-outline-variant text-sm rounded-lg focus:ring-1 focus:ring-primary !p-2 !h-10 w-full";
            
            return `
                <div class="log-entry bg-surface-container-low p-3 rounded-xl border border-outline-variant/30 mb-3 shadow-sm relative group">
                    <div class="flex justify-between items-end mb-3">
                        <div class="flex-grow mr-4">
                            <label class="${labelBase}">Date</label>
                            <input type="date" value="${entry.date || ''}" class="${inputBase} font-medium">
                        </div>
                        <button onclick="this.closest('.log-entry').remove(); window.syncLogToFinal('${suffix}')" class="text-on-surface-variant hover:text-error hover:bg-error-container/20 p-2 rounded-lg transition-colors mb-[1px]" title="Delete Entry">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                        </button>
                    </div>
                    <div class="grid grid-cols-2 gap-3 mb-3">
                        <div>
                            <label class="${labelBase}">Temp (°C)</label>
                            <input type="number" step="0.5" class="${inputBase} text-center font-mono font-bold text-primary temp-input" value="${entry.temp || ''}" placeholder="20" oninput="window.autoCalculateABV(event, '${suffix}')" onchange="window.autoCalculateABV(event, '${suffix}')">
                        </div>
                        <div>
                            <label class="${labelBase}">Gravity (SG/Brix)</label>
                            <input type="number" step="0.001" class="${inputBase} text-center font-mono font-bold text-primary sg-input" value="${entry.sg || ''}" placeholder="1.xxx" oninput="this.value = this.value.replace(',', '.'); window.autoCalculateABV(event, '${suffix}')" onchange="window.autoCalculateABV(event, '${suffix}')">
                        </div>
                    </div>
                    <div class="grid grid-cols-1 gap-3">
                        <div>
                            <label class="${labelBase}">pH Level</label>
                            <input type="number" step="0.01" class="${inputBase} text-primary font-bold" value="${entry.ph || ''}" placeholder="3.x" oninput="this.value = this.value.replace(',', '.'); window.syncLogToFinal('${suffix}')" onchange="window.autoCalculateABV(event, '${suffix}')">
                        </div>
                        <input type="text" class="${inputBase} italic text-on-surface-variant" value="${entry.notes || ''}" placeholder="Add notes...">
                    </div>
                </div>`;
        }).join('');

        return `
            <div class="brew-log-section mt-6 border-t border-app-brand/10 pt-4" data-id="${suffix}">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-lg font-header font-bold text-app-brand uppercase tracking-wider">Fermentation Logbook</h3>
                    <div class="flex gap-2">
                        <input type="number" step="0.001" id="actualOG-${suffix}" class="w-20 p-1 text-xs border rounded bg-app-tertiary text-center font-mono" placeholder="OG" value="${logData.actualOG || ''}" oninput="this.value = this.value.replace(',', '.'); window.autoCalculateABV(event, '${suffix}')" onchange="window.autoCalculateABV(event, '${suffix}')">
                        <input type="number" step="0.001" id="actualFG-${suffix}" class="w-20 p-1 text-xs border rounded bg-app-tertiary text-center font-mono" placeholder="FG" value="${logData.actualFG || ''}" oninput="this.value = this.value.replace(',', '.'); window.autoCalculateABV(event, '${suffix}')" onchange="window.autoCalculateABV(event, '${suffix}')">
                        <input type="text" id="finalABV-${suffix}" class="w-16 p-1 text-xs border rounded bg-app-primary text-center font-bold" placeholder="ABV%" value="${logData.finalABV || ''}" readonly>
                    </div>
                </div>
                <div id="fermentationContainer-${suffix}" class="space-y-2">${entriesHtml}</div>
                <button onclick="window.addLogLine('${suffix}')" class="w-full mt-4 bg-app-tertiary border border-app-brand/30 text-app-brand py-3 rounded-xl font-bold text-sm hover:bg-app-brand hover:text-white transition-all shadow-sm uppercase tracking-widest">+ Add Measurement</button>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
                    <div class="card p-3 bg-app-tertiary/30 border-app">
                        <label class="text-[10px] font-bold text-app-secondary uppercase block mb-1">Aging & Racking Notes</label>
                        <textarea id="agingNotes-${suffix}" rows="3" class="w-full p-2 text-xs bg-transparent border-none focus:ring-0" placeholder="Describe clarity...">${logData.agingNotes || ''}</textarea>
                    </div>
                    <div class="card p-3 bg-app-tertiary/30 border-app">
                        <label class="text-[10px] font-bold text-app-secondary uppercase block mb-1">Final Tasting Notes</label>
                        <textarea id="tastingNotes-${suffix}" rows="3" class="w-full p-2 text-xs bg-transparent border-none focus:ring-0" placeholder="Flavor, aroma...">${logData.tastingNotes || ''}</textarea>
                    </div>
                </div>
            </div>`;
    } catch (error) {
        window.logSystemError(error, 'brewing.js: getBrewLogHtml', 'ERROR');
        return `<p class="text-red-500">Error loading log interface.</p>`;
    }
}

function renderFlavorWheel(brewId, labels, data) {
    const container = document.getElementById(`flavor-wheel-container-${brewId}`);
    if (!container) return;

    container.innerHTML = `<canvas id="flavorChart-${brewId}"></canvas>`;
    const ctx = document.getElementById(`flavorChart-${brewId}`);

    // MD3 Kleuren
    const cPrimary = `rgb(${window.getThemeColor('--md-sys-color-primary')})`;
    const cOnSurface = `rgb(${window.getThemeColor('--md-sys-color-on-surface')})`;
    const cOutline = `rgb(${window.getThemeColor('--md-sys-color-outline-variant')})`; // Grid lijnen

    // Transparante fill (Primary kleur met 0.2 opacity)
    // Omdat getThemeColor "R G B" teruggeeft (zonder commas in sommige browsers of met), 
    // is het veiliger om de CSS variabele direct in rgba te gebruiken als je tailwind config dat toestaat, 
    // of hier een kleine hack te doen:
    const cFill = cPrimary.replace('rgb', 'rgba').replace(')', ', 0.2)');

    new Chart(ctx, {
        type: 'radar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Flavor Profile',
                data: data,
                backgroundColor: cFill,
                borderColor: cPrimary,
                borderWidth: 2,
                pointBackgroundColor: cPrimary,
                pointBorderColor: '#fff',
            }]
        },
        options: {
            responsive: true,
            scales: {
                r: {
                    angleLines: { color: cOutline },
                    grid: { color: cOutline },
                    pointLabels: { color: cOnSurface, font: { size: 12, family: "'Barlow Semi Condensed'" } },
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

window.autoCalculateABV = function(event, idSuffix) {
    try {
        const cleanId = idSuffix.replace('-sec', ''); 
        const logEntryRow = event ? event.target.closest('.log-entry') : null;
        
        const ogRaw = document.getElementById(`actualOG-${idSuffix}`)?.value || "";
        const fgRaw = document.getElementById(`actualFG-${idSuffix}`)?.value || "";
        
        const ogInput = parseFloat(ogRaw.replace(',', '.'));
        const fgInput = parseFloat(fgRaw.replace(',', '.'));
        const abvField = document.getElementById(`finalABV-${idSuffix}`);

        if (!isNaN(ogInput) && !isNaN(fgInput) && abvField) {
            const WCF = parseFloat(String(state.userSettings?.wcf || 1.00).replace(',', '.'));
            let T_act = 20;
            if (logEntryRow) {
                const tempInp = logEntryRow.querySelector('.temp-input');
                if (tempInp && tempInp.value) T_act = parseFloat(tempInp.value.replace(',', '.'));
            }
            const T_cal = 20;

            const CF = (T) => 1.00130346 - 0.000134722124 * T + 0.00000204052596 * Math.pow(T, 2) - 0.00000000232820948 * Math.pow(T, 3);
            const correctedOG = ogInput * (CF(T_act) / CF(T_cal));
            const correctedFG = fgInput * (CF(T_act) / CF(T_cal));

            if (correctedOG >= 1.775) {
                window.showToast("Kritieke fout: OG overschrijdt Hall-limiet (1.775).", "error");
                abvField.value = "LIMIT ERR";
                return;
            }

            let finalOG = correctedOG;
            let finalFG = correctedFG;

            // Mixed-tool support (SG vs Brix)
            if (ogInput > 1.2 || fgInput > 1.2) {
                const getRI = (val) => val > 1.2 ? (val / WCF) : (((182.9622 * Math.pow(val, 3)) - (777.3009 * Math.pow(val, 2)) + (1264.5170 * val) - 670.1831) / WCF);
                
                const RI_i = getRI(correctedOG);
                const RI_f = getRI(correctedFG);
                
                finalOG = (0.0000000578503 * Math.pow(RI_i, 3)) + (0.0000127414 * Math.pow(RI_i, 2)) + (0.00384577 * RI_i) + 1.0000;
                finalFG = 1.0 - (0.002349 * RI_i) + (0.006276 * RI_f);
                
                // Herhaalde Hall-limiet check na Brix-naar-SG transformatie conform v2.6 mandaat
                if (finalOG >= 1.775) {
                    window.showToast("Kritieke fout: Getransmuteerde OG overschrijdt Hall-limiet (1.775).", "error");
                    abvField.value = "LIMIT ERR";
                    return;
                }
            }
            
            if (finalOG > finalFG) {
                const abw = (76.08 * (finalOG - finalFG)) / (1.775 - finalOG);
                const abv = abw / 0.794; 
                abvField.value = abv.toFixed(2) + "%";
            } else {
                abvField.value = "0.00%";
            }
        }

        if (logEntryRow) {
            const currentEntry = {
                date: logEntryRow.querySelector('input[type="date"]')?.value,
                temp: logEntryRow.querySelector('.temp-input')?.value,
                ph: logEntryRow.querySelector('input[placeholder="3.x"]')?.value
            };
            
            const safetyWarnings = window.evaluateBatchSafety(cleanId, currentEntry);
            
            if (event && event.type === 'change' && safetyWarnings.length > 0) {
                safetyWarnings.forEach(msg => window.showToast(msg, "warning"));
            }
            
            let indicator = logEntryRow.querySelector('.safety-indicator');
            if (!indicator) {
                indicator = document.createElement('div');
                indicator.className = "safety-indicator absolute -left-1 top-0 bottom-0 w-6 rounded-l-xl flex items-center justify-center text-[10px]";
                logEntryRow.appendChild(indicator);
            }

            if (safetyWarnings.length > 0) {
                indicator.classList.add('bg-red-500');
                indicator.innerHTML = '<span class="text-white font-bold" title="' + safetyWarnings.join('\n') + '">⚠️</span>';
            } else {
                indicator.classList.remove('bg-red-500');
                indicator.innerHTML = '';
            }
        }

        window.syncLogToFinal(idSuffix);
    } catch (error) {
        window.logSystemError(error, 'brewing.js: autoCalculateABV', 'ERROR');
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

// --- BLENDING TOOL ---
window.addBlendingRow = function(idSuffix) {
    try {
        const tbody = document.querySelector(`#blendingTable-${idSuffix} tbody`);
        if(!tbody) return;
        const today = new Date().toISOString().split('T');
        const tr = document.createElement('tr');
        // V2.6 Fix: Directe komma-naar-punt vervanging op input niveau
        tr.innerHTML = `
            <td><input type="date" value="${today}" class="w-full bg-transparent"></td>
            <td><input type="text" class="w-full bg-transparent" placeholder="Spirit Name"></td>
            <td><input type="number" step="0.01" class="w-full bg-transparent text-center" oninput="this.value = this.value.replace(',', '.'); window.recalcTotalABV('${idSuffix}')"></td>
            <td><input type="number" step="0.1" class="w-full bg-transparent text-center" oninput="this.value = this.value.replace(',', '.'); window.recalcTotalABV('${idSuffix}')"></td>
            <td class="text-center"><button onclick="this.closest('tr').remove(); window.recalcTotalABV('${idSuffix}')" class="text-red-500 font-bold">&times;</button></td>
        `;
        tbody.appendChild(tr);
    } catch (error) {
        window.logSystemError(error, 'brewing.js: addBlendingRow', 'ERROR');
    }
};

// --- SCOPE FIX: USE STATE.BREWS ---
window.recalcTotalABV = function(idSuffix) {
    try {
        const finalABVField = document.getElementById(`finalABV-${idSuffix}`);
        const currentVolInput = document.getElementById(`currentVol-${idSuffix}`);
        
        let fallbackVol = 5.0;
        let baseABV = 0;

        const activeId = tempState.activeBrewId || (state.userSettings?.currentBrewDay?.brewId);
        const activeBrew = state.brews ? state.brews.find(x => x.id === activeId) : null;

        if (activeBrew) {
            fallbackVol = activeBrew.batchSize || 5;
            baseABV = parseFloat(activeBrew.logData?.targetABV || 0);
        }

        // Comma-to-Dot protocol
        let startVolume = parseFloat(String(currentVolInput?.value || fallbackVol).replace(/,/g, '.')) || fallbackVol;
        
        // Hall Equation Integratie (v2.6) met Strikte Pre-check
        const ogInputStr = document.getElementById(`actualOG-${idSuffix}`)?.value.replace(/,/g, '.') || "";
        const fgInputStr = document.getElementById(`actualFG-${idSuffix}`)?.value.replace(/,/g, '.') || "";
        const ogVal = parseFloat(ogInputStr);
        const fgVal = parseFloat(fgInputStr);
        
        if (!isNaN(ogVal) && !isNaN(fgVal)) {
            // STRIKTE EIS: Voorkom deling door nul of fysiek onmogelijke densiteit
            if (ogVal >= 1.775) {
                if (finalABVField) {
                    finalABVField.value = "LIMIT ERR";
                    finalABVField.classList.add('text-error');
                }
                window.logSystemError(`Hall Limit Error in Blending: OG ${ogVal}`, 'ABV Calc', 'WARNING');
                return; 
            }

            if (ogVal > fgVal) {
                // Hall Equation: ABW = (76.08 * (OG - FG)) / (1.775 - OG)
                const abw = (76.08 * (ogVal - fgVal)) / (1.775 - ogVal);
                baseABV = abw / 0.794;
            }
        }

        let totalAlcVolume = startVolume * (baseABV / 100);
        let totalLiquidVolume = startVolume;

        const rows = document.querySelectorAll(`#blendingTable-${idSuffix} tbody tr`);
        rows.forEach(row => {
            const inputs = row.querySelectorAll('input');
            const vol = parseFloat(String(inputs[2]?.value || "0").replace(/,/g, '.')) || 0;
            const abv = parseFloat(String(inputs[3]?.value || "0").replace(/,/g, '.')) || 0;
            
            if (vol > 0) {
                totalLiquidVolume += vol;
                totalAlcVolume += (vol * (abv / 100));
            }
        });

        const newABV = totalLiquidVolume > 0 ? (totalAlcVolume / totalLiquidVolume) * 100 : baseABV;
        if (finalABVField) {
            finalABVField.value = newABV.toFixed(2) + '%';
            finalABVField.classList.remove('text-error');
        }
        
    } catch (error) {
        window.logSystemError(error, 'brewing.js: recalcTotalABV', 'ERROR');
    }
};

// --- INVENTORY SYNC ---
window.deductActualsFromInventory = async function(brewId) {
    if (!confirm("Deduct calculated ingredients from your Inventory Stock?")) return;
    
    try {
        if (window.performInventoryDeduction) {
            const logData = getLogDataFromDOM('brew-day-content'); 
            
            if (!logData.actualIngredients || logData.actualIngredients.length === 0) {
                showToast("No actuals recorded. Save log first.", "warning");
                return;
            }
            
            await window.performInventoryDeduction(logData.actualIngredients);
        } else {
            showToast("Inventory module not loaded.", "error");
        }
    } catch (error) {
        window.logSystemError(error, 'Inventory: Deduct', 'ERROR');
        showToast("Deduction failed. Check system logs.", "error");
    }
}

// --- PROMPT VIEWER ---
window.showLastPrompt = function() {
    if(!lastGeneratedPrompt) {
        showToast("No prompt in memory.", "info");
        return;
    }
    window.showPromptModal(lastGeneratedPrompt);
}

// --- CLEAR HISTORY ---
window.clearHistory = async function() {
    if (!state.userId) return;
    if (!confirm("DELETE ALL HISTORY? This cannot be undone.")) return;
    
    try {
        const { writeBatch, collection, getDocs, query, doc } = await import('./firebase-init.js');
        const q = query(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews'));
        const snapshot = await getDocs(q);
        
        if (snapshot.empty) {
            showToast("History already empty.", "info");
            return;
        }

        const batch = writeBatch(db);
        snapshot.docs.forEach((d) => {
            batch.delete(d.ref);
        });

        await batch.commit();
        
        // Reset pointers en UI
        tempState.activeBrewId = null;
        if (state.userSettings) state.userSettings.currentBrewDay = { brewId: null };
        
        showToast(`History cleared (${snapshot.size} items).`, "success");
        window.renderBrewDay('none');
    } catch (error) {
        window.logSystemError(error, 'History: ClearAll', 'ERROR');
        showToast("Clear failed.", "error");
    }
}

// --- RESTORE TIMER ON LOAD ---
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

// --- TWEAK SAVED RECIPE ---
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

// --- SHOW SAVED PROMPT ---
// Onderscheid: showLastPrompt toont geheugen, deze toont Database prompt
window.showBrewPrompt = function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    const text = brew?.prompt || "No prompt saved for this batch (created in older version).";
    window.showPromptModal(text);
}

window.undoStep = async function(stepIndex) {
    const brewId = tempState.activeBrewId;
    if (!brewId) return;
    
    // 1. Zoek de batch
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew || !brew.checklist) return;

    if (!confirm("Wil je deze stap heropenen om te wijzigen?")) return;

    // 2. Verwijder de entry uit de checklist (zowel lokaal als DB)
    delete brew.checklist[`step-${stepIndex}`];

    try {
        // Update Firestore: We sturen het hele checklist object opnieuw op (zonder deze stap)
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { 
            checklist: brew.checklist
        });
        
        // 3. UI Update: Herlaad het scherm
        // Omdat de data nu weg is uit de checklist, zal renderBrewDay
        // het inputveld weer gewoon wit en typbaar maken!
        renderBrewDay(brewId);
        
    } catch (e) {
        console.error("Undo failed:", e);
        showToast("Kon stap niet herstellen.", "error");
    }
}

// --- KEUZE MODAL VOOR NIEUWE BATCH ---
window.promptNewBrewType = function() {
    // Check of de modal al bestaat, zo niet, maak hem
    let modal = document.getElementById('new-brew-modal');
    
    if (!modal) {
        const modalHtml = `
        <div id="new-brew-modal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm hidden animate-fade-in">
            <div class="bg-app-secondary p-6 rounded-xl shadow-2xl border border-app-brand/20 w-full max-w-sm relative">
                <button onclick="document.getElementById('new-brew-modal').classList.add('hidden')" class="absolute top-3 right-4 text-app-secondary hover:text-red-500 font-bold text-xl">&times;</button>
                
                <h3 class="text-xl font-header font-bold text-center mb-6 text-app-brand">Start New Batch</h3>
                
                <div class="space-y-3">
                    <button onclick="window.switchSubView('creator', 'brewing-main-view'); document.getElementById('new-brew-modal').classList.add('hidden');" 
                        class="w-full p-4 rounded-lg border border-app-brand/20 bg-app-tertiary hover:bg-app-primary hover:border-app-brand transition-all group text-left flex items-center gap-4">
                        <div class="bg-app-brand text-white w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg">✨</div>
                        <div>
                            <div class="font-bold text-app-header">AI Creator</div>
                            <div class="text-xs text-app-secondary">Generate a fresh recipe</div>
                        </div>
                    </button>

                    <button onclick="window.switchSubView('history', 'brewing-main-view'); document.getElementById('new-brew-modal').classList.add('hidden');" 
                        class="w-full p-4 rounded-lg border border-app-brand/20 bg-app-tertiary hover:bg-app-primary hover:border-app-brand transition-all group text-left flex items-center gap-4">
                        <div class="bg-blue-600 text-white w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg">📂</div>
                        <div>
                            <div class="font-bold text-app-header">From History</div>
                            <div class="text-xs text-app-secondary">Clone/Brew existing recipe</div>
                        </div>
                    </button>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        modal = document.getElementById('new-brew-modal');
    }
    
    // Toon de modal
    modal.classList.remove('hidden');
}

window.revertToPrimary = async function(brewId) {
    if (!confirm("⚠️ Foutje gemaakt? Dit stuurt de batch terug naar Brew Day 1 (Primary).")) return;

    try {
        // 1. Zet de status vlag terug
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { 
            primaryComplete: false 
        });

        // 2. Update lokale data
        const brew = state.brews.find(b => b.id === brewId);
        if(brew) brew.primaryComplete = false;

        // 3. Reset pointers en UI
        tempState.activeBrewId = null; // Ga terug naar lijstweergave
        showToast("Batch moved back to Primary!", "success");
        
        // 4. Verversen
        renderBrewDay2(); // Ververs Day 2 (hij verdwijnt hier)
        
        // Optioneel: Switch meteen terug naar Day 1 tab
        switchSubView('brew-day-1', 'brewing-main-view');
        renderBrewDay(brewId); // Open hem in Day 1

    } catch (e) {
        console.error(e);
        showToast("Revert failed", "error");
    }
}

// --- ROBUST REGENERATOR ---
window.regenerateFlavorProfile = async function(brewId) {
    if (!brewId) return showToast("Error: No brew ID found.", "error");
    
    const container = document.getElementById(`flavor-wheel-container-${brewId}`);
    if (container) {
        container.innerHTML = getLoaderHtml("AI Sommelier is tasting...");
    }

    const brew = state.brews.find(b => b.id === brewId);
    if (!brew || !brew.recipeMarkdown) {
        if(container) container.innerHTML = `<p class="text-error text-sm">No recipe text found to analyze.</p>`;
        return;
    }

    const prompt = `You are a professional mead sommelier. Analyze this recipe and PREDICT its final flavor profile. 
    Assign a score from 0 to 5 for: Sweetness, Acidity, Fruity/Floral, Spiciness, Earthy/Woody, Body/Mouthfeel. 
    
    RECIPE:
    ${brew.recipeMarkdown.substring(0, 2000)}
    
    Output ONLY JSON.`;
    
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
        const profileData = JSON.parse(jsonResponse);

        // 5. OPSLAAN IN DATABASE (v2.6: Gebruik centrale firebase-init imports)
        const brewRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId);
        await updateDoc(brewRef, {
            flavorProfile: profileData
        });

        brew.flavorProfile = profileData;

        if (container) {
            container.innerHTML = `<canvas id="flavorChart-${brewId}"></canvas>`;
            
            setTimeout(() => {
                renderFlavorWheel(brewId, 
                    ['Sweetness', 'Acidity', 'Fruity', 'Spicy', 'Earthy', 'Body'], 
                    [profileData.sweetness, profileData.acidity, profileData.fruity_floral, profileData.spiciness, profileData.earthy_woody, profileData.body_mouthfeel]
                );
            }, 50);
        }
        
        showToast("Analysis saved permanently!", "success");

    } catch (error) {
        window.logSystemError(error, 'brewing.js: regenerateFlavorProfile', 'ERROR');
        if(container) container.innerHTML = `<p class="text-error text-sm">Analysis failed. Try again.</p><button onclick="window.regenerateFlavorProfile('${brewId}')" class="btn bg-primary text-white mt-2">Retry</button>`;
    }
};

// --- NEW SAFETY LOGIC: Yeast-Specific Risk Detection (v2.6) ---
window.evaluateBatchSafety = function(brewId, currentLogEntry) {
    try {
        const brew = state.brews.find(b => b.id === brewId);
        if (!brew) return [];

        const warnings = [];
        const logData = brew.logData || {};
        const recipeText = (brew.recipeMarkdown || "").toLowerCase();
        const batchSize = parseFloat(brew.batchSize) || 5;

        let yeastStrain = "unknown";
        if (recipeText.includes("d47")) yeastStrain = "d47";
        else if (recipeText.includes("us-05")) yeastStrain = "us-05";
        else if (recipeText.includes("71b")) yeastStrain = "71b";
        else if (recipeText.includes("ec-1118")) yeastStrain = "ec-1118";
        else if (recipeText.includes("m05")) yeastStrain = "m05";
        else if (recipeText.includes("qa23")) yeastStrain = "qa23";

        const currentTemp = parseFloat(String(currentLogEntry.temp).replace(',', '.'));
        if (yeastStrain === "d47" && currentTemp > 20) {
            warnings.push("Lalvin D47 boven 20°C: Risico op foezelalcoholen.");
        }

        if (yeastStrain === "us-05") {
            const actuals = logData.actualIngredients || [];
            let yanActual = 0;
            actuals.forEach(ing => {
                const qty = parseFloat(String(ing.actualQty).replace(',', '.'));
                if (ing.name.toLowerCase().includes("fermaid o")) yanActual += (qty / batchSize) * 160;
                if (ing.name.toLowerCase().includes("dap")) yanActual += (qty / batchSize) * 210;
            });
            const og = parseFloat(String(logData.actualOG || 1.000).replace(',', '.'));
            const brix = ((182.9622 * Math.pow(og, 3)) - (777.3009 * Math.pow(og, 2)) + (1264.5170 * og) - 670.1831);
            const yanTarget = 10 * brix * og * 1.25; 
            if (yanActual < yanTarget && yanActual > 0) {
                warnings.push("SafAle US-05 stikstoftekort: Risico op H2S (rotte eieren).");
            }
        }

        const ogVal = parseFloat(String(logData.actualOG || 1.000).replace(',', '.'));
        if (!isNaN(ogVal) && ogVal < 1.775) {
            const fgDry = 1.000;
            const abwPot = (76.08 * (ogVal - fgDry)) / (1.775 - ogVal);
            const abvPot = abwPot / 0.794;
            if (yeastStrain === "71b" && abvPot > 14) warnings.push("ABV overschrijdt 14% limiet van 71B.");
            if ((yeastStrain === "ec-1118" || yeastStrain === "m05") && abvPot > 18) {
                warnings.push(`ABV overschrijdt 18% limiet van ${yeastStrain.toUpperCase()}.`);
            }
        }

        // pH-Monitor verfijning (Date dependency)
        const currentPh = parseFloat(String(currentLogEntry.ph).replace(',', '.'));
        if (currentPh < 3.2 && currentPh > 0) {
            const brewDateRaw = logData.brewDate ? new Date(logData.brewDate) : null;
            if (brewDateRaw) {
                const currentLogDate = currentLogEntry.date ? new Date(currentLogEntry.date) : new Date();
                const diffDays = (currentLogDate.getTime() - brewDateRaw.getTime()) / (1000 * 3600 * 24);
                if (diffDays <= 3) warnings.push("PH-CRASH (Eerste 72u): Voeg 0.4 g/L K2CO3 toe.");
            } else {
                warnings.push("KRITIEKE LAGE pH: Voeg 0.4 g/L K2CO3 toe.");
            }
        }

        // --- GRASACHTIGE OFF-FLAVOR & HOP-BURN SAFEGUARD ---
        // Inspecteer dry-hop contacttijd via lognotities of ingevoerde data
        const notesStr = (currentLogEntry.notes || "").toLowerCase();
        const agingNotesStr = (logData.agingNotes || "").toLowerCase();
        const collectiveNotes = notesStr + " " + agingNotesStr;
        
        let detectedContactHours = 0;
        const hourMatch = collectiveNotes.match(/(\d+)\s*(hour|uur|hrs)/);
        const dayMatch = collectiveNotes.match(/(\d+)\s*(day|dag|dagen|days)/);
        
        if (dayMatch) {
            detectedContactHours = parseInt(dayMatch[1]) * 24;
        } else if (hourMatch) {
            detectedContactHours = parseInt(hourMatch[1]);
        }
        
        if (detectedContactHours >= 168 || collectiveNotes.includes("dryhop 7 dagen") || collectiveNotes.includes("dryhop 8 dagen") || collectiveNotes.includes("dry-hop 7 days") || collectiveNotes.includes("dry-hop 8 days")) {
            const overExtractionWarning = "Kritieke overextractie van polyphenolen en chlorofyl gedetecteerd (Grasachtige off-flavor / Hop-burn risico).";
            warnings.push(overExtractionWarning);
            window.logSystemError(`Hop Over-Extraction Event on Batch ${brew.recipeName || 'Unknown'}: ${detectedContactHours} hours calculated.`, 'Zymology: Hop Safeguard', 'WARNING');
        }

        return warnings;
    } catch (error) {
        window.logSystemError(error, "evaluateBatchSafety", "ERROR");
        return [];
    }
};