// ============================================================================
// brewing.js
// MEANDERY V2.6
// ============================================================================

import { 
    db, auth, collection, addDoc, updateDoc, doc, deleteDoc, 
    getDoc, setDoc, query, onSnapshot, serverTimestamp 
} from './firebase-init.js';

import { state, tempState } from './state.js';
import { 
    showToast, performApiCall, switchMainView, switchSubView, 
    getLoaderHtml, logSystemError 
} from './utils.js';

let currentRecipeMarkdown = "";
let currentPredictedProfile = null;
let lastGeneratedPrompt = "";
let stepTimerInterval = null;
let remainingTime = 0;

function extractTitle(markdown) {
    try {
        const match = markdown.match(/^#\s*(.*)/m);
        return match ? match.at(1).trim() : null;
    } catch (error) {
        window.logSystemError(error, "brewing.js: extractTitle", "ERROR");
        return null;
    }
}

function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0 
        ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` 
        : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
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

4.  **HOP KINETICS & DRY-HOPPING RESTRICTIONS:**
    - **Dry-Hop Time Window:** Cold extraction extraction processes (dry-hopping) in secondary phases MUST be planned strictly within the optimal time window of minimum **72 hours (3 days)** to maximum **120 hours (5 days)**. This is mandatory to maximize terpene solvation and minimize polyphenol/chlorophyll over-extraction.

**OUTPUT FORMAT (STRICT):**
- **Markdown** structure.
- **Ingredients JSON:** \`\`\`json [{"ingredient": "Name", "quantity": 0, "unit": "kg"}] \`\`\` (List ALL ingredients with calculated amounts).
- **Timers:** \`[TIMER:HH:MM:SS]\` for wait steps.
`;
}

function buildPrompt() {
    try {
        const batchSizeEl = document.getElementById('batchSize') || document.getElementById('batch-size');
        const batchSize = parseFloat(String(batchSizeEl ? batchSizeEl.value : '5').replace(/,/g, '.')) || 5;
        const customDescriptionEl = document.getElementById('customDescription') || document.getElementById('recipe-name-input');
        const customDescription = customDescriptionEl ? String(customDescriptionEl.value).trim() : '';
        const abvEl = document.getElementById('abv') || document.getElementById('target-abv');
        const rawABV = abvEl ? String(abvEl.value).trim() : '';     
        const hasDescription = customDescription !== "";
        const isAutoABV = (rawABV === '' || rawABV === '0') || hasDescription;
        const targetABV = isAutoABV ? 12 : (parseFloat(String(rawABV).replace(/,/g, '.')) || 12);
        const sweetnessEl = document.getElementById('sweetness') || document.getElementById('target-sweetness');
        const sweetness = sweetnessEl ? String(sweetnessEl.value).trim() : '';
        const styleSelect = document.getElementById('style');

        let style = 'Traditional Mead';
        if (styleSelect && styleSelect.selectedOptions && styleSelect.selectedOptions.length > 0) {
            const firstSelectedOption = styleSelect.selectedOptions.item(0);
            if (firstSelectedOption) {
                style = firstSelectedOption.text;
            }
        }
        
        const inputString = (customDescription + " " + style).toLowerCase();
        const noWaterCheckbox = document.getElementById('isNoWaterCheckbox');
        const isNoWater = (noWaterCheckbox && noWaterCheckbox.checked) || inputString.includes('no-water') || inputString.includes('no water');
        const isBraggot = inputString.includes('braggot');        
        const beerCloneInputEl = document.getElementById('beerCloneInput') || document.getElementById('beer-clone');
        const beerCloneInput = beerCloneInputEl ? String(beerCloneInputEl.value).trim() : '';
        const hasBeerClone = beerCloneInput !== "";

        const useBudget = document.getElementById('useBudget')?.checked;
        let budgetContext = "";
        if (useBudget) {
             const maxBudgetEl = document.getElementById('maxBudget') || document.getElementById('budget-limit');
             const maxBudget = maxBudgetEl ? (parseFloat(String(maxBudgetEl.value).replace(/,/g, '.')) || 0) : 0;
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

        if (isBraggot || hasBeerClone) {
            const checkOG = 1.000 + (targetABV * 0.0075); 
            if (checkOG >= 1.775) {
                window.showToast("Kritieke fout: De vereiste startdensiteit overschrijdt de Hall-limiet (OG >= 1.775). Pas uw ABV target aan.", "error");
                window.logSystemError("Hall Equation pre-check failure: OG estimate would equal or exceed thermodynamic constant 1.775.", "brewing.js: buildPrompt", "WARNING");
                return "";
            }

            let braggotWiskunde = `\n- **PROTOCOL: BRAGGOT MATH (STRICT v2.6 BLUEPRINT):**`;
            if (hasBeerClone) {
                braggotWiskunde += `\n  - Target Beer Profile to Clone: "${beerCloneInput}"`;
            }
            braggotWiskunde += `
            1. Calculate the required Alcohol by Weight (ABW) using: ABW = Target_ABV * 0.794.
            2. Isolate the total density drop (ΔSG) using the inverted Hall Equation: ΔSG = (ABW * (1.775 - OG)) / 76.08. (PRE-CHECK VALIDATED: OG is strictly below 1.775).
            3. Determine total sugar requirements in Gravity Points: GP_total = (OG - 1.000) * 1000 * Batch_Size.
            4. Enforce malt grist ratio (X_malt) strictly between 30% and 50% of total sugar contribution: GP_malt = GP_total * X_malt. The remaining 50-70% must be supplied by honey.
            5. Convert point distribution to exact mass weights in kilograms based on standard potentials:
               - Honey Yield Potential: 290 points/kg/L
               - Dry Malt Extract (DME) Yield Potential: 375 points/kg/L
               - Liquid Malt Extract (LME) Yield Potential: 300 points/kg/L
            6. Predict an increased Estimated Final Gravity (FG_est) by applying a 75% apparent attenuation limit solely onto the malt fraction, leaving residual unfermentable dextrins. Perform a backward adjustment on the final required OG to compensate for this density floor and guarantee the requested net ABV target.
            7. **HONEY MUST IBU-RETENTION MATRIX:** Correct the calculated International Bittering Units (IBU) based on the absence of protein-adsorptive losses in honey components.
               - IF the mixture is a pure honey must (malt fraction is 0), scale the theoretical Tinseth bitterness utility by the mechanistical constant φ_mead = 1.45.
               - IF the mixture is a hybrid braggot, calculate the dynamic adjustment factor using: φ_braggot = 1.0 + 0.45 * (1.0 - (ρ_malt / ρ_total)), where ρ_malt is the specific gravity points contribution from the malt extract, and ρ_total is the total starting gravity points of the must (OG - 1.000). Ensure total calculated bittering additions are adjusted to prevent overwhelming astringency.`;
            
            mathContext += braggotWiskunde;
        } else if (isNoWater) {
            mathContext += `\n- **PROTOCOL: NO-WATER MELOMEL.** 1. No added water. 2. Need ~1.8kg fruit/Liter. 3. **SUGAR ALERT:** Fruit adds sugar. REDUCE Honey Baseline significantly.`;
        } else {
            mathContext += `\n- **JUICE WARNING:** If replacing water with Fruit Juice, reduce honey to prevent overshooting ABV.`;
        }

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
        const stabiliserRule = invLower.includes('campden') 
            ? `3. **NAMING CONVENTION:** The user has "Campden" in stock. Always write "**Campden Powder/Tablets**" instead of "Potassium Metabisulphite" in the ingredients list and instructions.` 
            : "";

        const inventoryLogic = `
        ${inventoryInstruction} 
        **FULL STOCK LIST:** [${inventoryString}]. 
         
        **CRITICAL INVENTORY RULES:**
        1. **JSON Block:** MUST contain the **TOTAL** ingredients required (ignore stock here).
        2. **SHOPPING LIST TEXT:** - Compare Required Amount vs Stock Amount.
           - IF (Stock >= Required): **SILENCE**. Do NOT output a line or bullet for this item in the shopping list text.
           - IF (Stock < Required): Output EXACTLY one line per item: "- Buy [Amount Needed] of [Item]".
           - IF (Stock == 0): Output EXACTLY one line per item: "- Buy [Full Amount] of [Item]".
           - NEVER output empty bullet points ("- ") or lines containing only "Buy" without an item.
        ${stabiliserRule}
        `;

        const userNutrientSelectionEl = document.getElementById('recipeNutrientSelect') || document.getElementById('nutrientSchedule');
        const userNutrientSelection = userNutrientSelectionEl ? String(userNutrientSelectionEl.value).trim() : 'fermaid_o';
        
        const nutrientDatabase = {
            'fermaid_o': { name: 'Fermaid O', rawYan: 40.0, rAnorg: 0.0, rOrg: 1.0, muOrg: 4.0 },
            'fermaid_k': { name: 'Fermaid K', rawYan: 100.0, rAnorg: 0.6, rOrg: 0.4, muOrg: 1.0 },
            'nutrisal': { name: 'Vinoferm Nutrisal', rawYan: 210.0, rAnorg: 1.0, rOrg: 0.0, muOrg: 1.0 },
            'cellvit': { name: 'Vinoferm Cellvit', rawYan: 25.0, rAnorg: 0.0, rOrg: 1.0, muOrg: 2.0 },
            'nutrimix': { name: 'Vinoferm Nutrimix', rawYan: 117.5, rAnorg: 0.5, rOrg: 0.5, muOrg: 2.0 },
            'wyeast_wine': { name: 'Wyeast Wine Nutrient', rawYan: 24.0, rAnorg: 0.0, rOrg: 1.0, muOrg: 4.0 },
            'bby': { name: 'Boiled Bread Yeast', rawYan: 14.7, rAnorg: 0.0, rOrg: 1.0, muOrg: 2.0 }
        };

        const activeNutrient = nutrientDatabase.hasOwnProperty(userNutrientSelection) 
            ? nutrientDatabase[userNutrientSelection] 
            : nutrientDatabase.fermaid_o;

        let baseNutrientRule = ``;
        if (activeNutrient.rAnorg > 0) {
            baseNutrientRule = `
            - **STRICT NUTRIENT PROTOCOL (ANORGANIC/HYBRID):** The user has selected **${activeNutrient.name}**. 
            - **PERMEASE INACTIVATION LAW:** Because this nutrient contains anorganic fractions (DAP/ammonium salts), you MUST structure the staggered additions (SNA) so that ALL nutritional additions strictly cease and cut off before the fermentation reaches 9% ABV or crosses the 1/3 sugar break (33.33% attenuation). 
            - **FORBIDDEN:** Do NOT plan or recommend any additions of ${activeNutrient.name} during the secondary phase or inside Fase II, to prevent toxic residual ammonium and ethyl carbamate formatting.`;
        } else if (userNutrientSelection === 'bby') {
            baseNutrientRule = `
            - **STRICT NUTRIENT PROTOCOL (BOILED BREAD YEAST):** The user has selected **Boiled Bread Yeast (BBY)** as their organic alternative. 
            - **STOICHIOMETRIC CONVERSION:** Calculate the required dosage of BBY using the hard conversion multiplier of 5.44x compared to standard Fermaid O rules, accounting for the lower absolute 14.7 mg N/g YAN profile and 2.0x biological efficiency factor.
            - **REHYDRATION LIPID MATRIX:** Include precise instructions for a BBY-assisted rehydration protocol (boiling 1.25g BBY per 1g of active yeast for 10 minutes at 100°C) to serve as a lipid and sterol cell-membrane protector.`;
        } else {
            baseNutrientRule = `
            - **STRICT NUTRIENT PROTOCOL (ORGANIC):** The user has selected **${activeNutrient.name}**.
            - **TOSNA 3.0 EQUIVALENCE:** Prescribe a 4-step staggered schedule using a 4.0x biological efficiency factor (160ppm equivalent per 1g/L). Structure additions at 24h, 48h, 72h, and the 1/3 sugar break zone.`;
        }

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

            specificLaws = `
            **WILD LAWS:**
            ${baseNutrientRule}
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
                const fruitCheckboxes = document.querySelectorAll('#fruit-section input[type=checkbox]:checked');
                const fruits = [];
                for (let f = 0; f < fruitCheckboxes.length; f++) {
                    const cb = fruitCheckboxes.item(f);
                    if (cb && cb.labels && cb.labels.length > 0) {
                        fruits.push(cb.labels.item(0).innerText);
                    }
                }
                const fruitOtherEl = document.getElementById('fruitOther');
                const otherFruits = fruitOtherEl ? fruitOtherEl.value : '';
                const fStr = [...fruits, otherFruits].filter(Boolean).join(', ');
                if(fStr) creativeBrief += `\n- Fruits: ${fStr}`;
             }
             if (style.includes('Metheglin')) {
                const spiceCheckboxes = document.querySelectorAll('#spice-section input[type=checkbox]:checked');
                const spices = [];
                for (let s = 0; s < spiceCheckboxes.length; s++) {
                    const cb = spiceCheckboxes.item(s);
                    if (cb && cb.labels && cb.labels.length > 0) {
                        spices.push(cb.labels.item(0).innerText);
                    }
                }
                const spiceOtherEl = document.getElementById('spiceOther');
                const otherSpices = spiceOtherEl ? spiceOtherEl.value : '';
                const sStr = [...spices, otherSpices].filter(Boolean).join(', ');
                if(sStr) creativeBrief += `\n- Spices: ${sStr}`;
             }
             const braggotStyleEl = document.getElementById('braggotStyle');
             if (style.includes('Braggot') && braggotStyleEl) {
                 creativeBrief += `\n- Braggot Base: ${braggotStyleEl.value}`;
             }
             const addOakEl = document.getElementById('addOak');
             if (addOakEl && addOakEl.checked) creativeBrief += '\n- Requirement: Include Oak Aging.';
             
             const specialIngredientsEl = document.getElementById('specialIngredients');
             if (specialIngredientsEl && specialIngredientsEl.value) {
                 creativeBrief += `\n- Special Ingredients: ${specialIngredientsEl.value}`;
             }
        }

        return `You are "MEA(N)DERY", a master mazer. \n\n${mathContext}\n${carbContext}\n${protocolContext}\n${specificLaws}\n${ncrContext}\n${inventoryLogic}\n${waterContext}\n\n**GLOBAL SAFETY OVERRIDE:**\n1. **Temp:** NEVER recommend a fermentation temp exceeding the yeast manufacturer's limit.\n2. **Sanity Check:** If the user requests impossible physics, correct them politely.\n\n**OUTPUT FORMAT (ABSOLUTE STRICTNESS):**\n- **ROLE:** Act as a headless database. DO NOT speak to the user. DO NOT say "Okay", "Sure", "Here is your recipe".\n- **START:** The output MUST start with the character "#" (The Title). nothing else before it.\n- **LATEX PROHIBITION:** DO NOT use LaTeX formatting (e.g. $18^{\\circ}C$, $10\\%$, $1/4$) for simple units, numbers, or prose. Use standard text (18°C, 10%, 1/4).\n- **STRUCTURE:**\n  1. Title (# Name)\n  2. Inspirational Quote (Do NOT prefix with '>')\n  3. Vital Stats List (ABV, Size, Style, Sweetness, OG)\n  4. Ingredients JSON Block: \`\`\`json\n[{"ingredient": "Name", "quantity": 0, "unit": "kg"}]\n\`\`\`\n  5. Instructions MUST be formatted as a Markdown numbered list with EACH step on a NEW LINE (1. Step one\n2. Step two). Never collapse steps into a single paragraph.\n  6. Timers: \`[TIMER:HH:MM:SS]\` inside the steps.\n  7. Brewer's Notes (Start section with "## Brewer's Notes")\n\nRequest:\n---\n${creativeBrief}\n---`;

    } catch (error) {
        window.logSystemError(error, 'brewing.js: buildPrompt Processing Chain', 'ERROR');
        throw new Error(`Failed to build prompt: ${error.message}`);
    }
}

async function generateRecipe() {
    try {
        const container = document.getElementById('recipe-output');
        if (container) {
            container.innerHTML = getLoaderHtml("Master Mazer is formulating your recipe...");
        }

        const promptText = buildPrompt();
        if (!promptText) {
            if (container) {
                container.innerHTML = '';
            }
            return;
        }

        lastGeneratedPrompt = promptText;

        const response = await performApiCall(promptText);
        if (!response) {
            throw new Error("Missing response from API.");
        }

        currentRecipeMarkdown = response;

        await renderRecipeOutput(response, false);

        window.showToast("Recept succesvol gegenereerd conform v2.6 model!", "success");

    } catch (error) {
        window.logSystemError(error, "brewing.js -> generateRecipe", "ERROR");
        window.showToast("Fout bij het compileren of genereren van het recept.", "error");
        
        const container = document.getElementById('recipe-output');
        if (container) {
            container.innerHTML = `
                <div class="p-4 bg-error-container/20 border border-error/30 rounded-xl text-xs text-error font-medium max-w-none text-center">
                    ⚠️ <strong>Generetiefout:</strong> ${error.message}<br>
                    <span class="opacity-70">Controleer de parameters of uw netwerkverbinding.</span>
                </div>
            `;
        }
    }
}

async function getPredictedFlavorProfile(markdown) {
    const prompt = `You are a professional mead sommelier. Analyze this recipe and PREDICT its final flavor profile. Assign score 0-5 for: Sweetness, Acidity, Fruity/Floral, Spiciness, Earthy/Woody, Body/Mouthfeel. Output ONLY JSON. Recipe: "${markdown}"`;
    
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
        window.logSystemError(error, "brewing.js: getPredictedFlavorProfile Anomaly", "ERROR");
        return null;
    }
}

function renderGeneratedFlavorWheel(flavorData) {
    const ctx = document.getElementById('generated-flavor-wheel');
    if (!ctx) return;
    
    const labels = ['Sweetness', 'Acidity', 'Fruity/Floral', 'Spiciness', 'Earthy/Woody', 'Body'];
    const data = [
        flavorData.sweetness, flavorData.acidity, flavorData.fruity_floral, 
        flavorData.spiciness, flavorData.earthy_woody, flavorData.body_mouthfeel
    ];
    
    const brandColor = getComputedStyle(document.documentElement).getPropertyValue('--brand-color').trim() || '#d97706';
    const isDarkMode = document.documentElement.classList.contains('dark');
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDarkMode ? '#e0e0e0' : '#4a3c2c';

    if (window.generatedFlavorChartInstance) {
        window.generatedFlavorChartInstance.destroy();
    }

    window.generatedFlavorChartInstance = new Chart(ctx.getContext('2d'), {
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
                    ticks: { color: textColor, backdropColor: 'transparent', stepSize: 1, display: false },
                    suggestedMin: 0, suggestedMax: 5
                }
            }
        }
    });
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
            tempState.currentRecipe = currentRecipeMarkdown;
        }
    } catch (error) {
        window.logSystemError(error, "brewing.js: generateAndInjectCreativeTitle", "ERROR");
        titleHeader.textContent = originalTitle;
    }
}

function parseRecipeData(markdown) {
    const data = {};
    if (!markdown) return data;

    try {
        const titleMatch = markdown.match(/^#\s*(.*)/m);
        const title = titleMatch ? titleMatch.at(1).trim() : "Untitled Recipe";
        const createRegex = (key) => new RegExp(`(?:${key}|${key.replace('.', '\\.')})[\\s\\*:]*~?([\\d.,]+)`, 'i');

        const ogRegex = createRegex('Target OG|Original Gravity|Start SG|O\\.G\\.|OG');
        const ogMatch = markdown.match(ogRegex);
        if (ogMatch && ogMatch.at(1)) { data.targetOG = ogMatch.at(1); }

        const fgRegex = createRegex('Target FG|Final Gravity|Eind SG|F\\.G\\.|FG');
        const fgMatch = markdown.match(fgRegex);
        if (fgMatch && fgMatch.at(1)) { data.targetFG = fgMatch.at(1); }

        const abvMatchGlobal = markdown.match(new RegExp(`(?:Target ABV|ABV|Alcoholpercentage)[\\s\\*:]*~?([\\d.,]+)\\s*%?`, 'i'));
        if (abvMatchGlobal && abvMatchGlobal.at(1)) { data.targetABV = abvMatchGlobal.at(1); }

    } catch (error) {
        window.logSystemError(error, 'Recipe Parser: Vital Stats Extraction Analysis', 'ERROR');
        window.showToast("Fout bij het deconstrueren van de recept-metagegevens.", "error");
    }
    return data;
}

function formatRecipeMarkdown(markdown) {
    try {
        if (!markdown) return "<p class='opacity-50 italic'>Geen receptuur data beschikbaar.</p>";

        let cleanedMarkdown = markdown;

        const jsonRegex = /(?:```json\s*)?(\[\s*\{[\s\S]*?\}\s*\])(?:\s*```)?/i;
        const jsonMatch = cleanedMarkdown.match(jsonRegex);

        if (jsonMatch && jsonMatch.at(1)) {
            try {
                const safeJson = jsonMatch.at(1).replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
                const ingredients = JSON.parse(safeJson);
                
                if (Array.isArray(ingredients) && ingredients.length > 0) {
                    let ingredientsHtml = '<div class="overflow-x-auto my-4 rounded-xl border border-app-brand/10 bg-surface/50"><table class="w-full text-left border-collapse text-xs"><thead class="bg-app-primary/10 font-bold text-app-brand border-b border-app-brand/10 text-[10px] uppercase tracking-wider"><tr><th class="p-3 font-semibold">Ingredient</th><th class="p-3 font-semibold">Quantity</th><th class="p-3 font-semibold">Unit</th></tr></thead><tbody>';
                    
                    for (let j = 0; j < ingredients.length; j++) {
                        const item = ingredients.at(j);
                        const ingName = item.ingredient || item.name || '';
                        const ingQty = item.quantity !== undefined ? item.quantity : '';
                        const ingUnit = item.unit || '';
                        ingredientsHtml += `<tr class="border-b border-app-brand/5 hover:bg-app-primary/5 transition-colors"><td class="p-3 font-medium text-on-surface-variant">${ingName}</td><td class="p-3 font-mono font-bold text-app-brand">${ingQty}</td><td class="p-3 text-on-surface-variant">${ingUnit}</td></tr>`;
                    }
                    ingredientsHtml += '</tbody></table></div>';
                    cleanedMarkdown = cleanedMarkdown.replace(jsonRegex, ingredientsHtml);
                } else {
                    cleanedMarkdown = cleanedMarkdown.replace(jsonRegex, '');
                }
            } catch (jsonError) {
                window.logSystemError(jsonError, 'formatRecipeMarkdown JSON extraction', 'WARNING');
                cleanedMarkdown = cleanedMarkdown.replace(jsonRegex, '');
            }
        }

        cleanedMarkdown = cleanedMarkdown.replace(/^>\s*/gm, '');
        cleanedMarkdown = cleanedMarkdown.replace(/\[TIMER:\d+:\d+:\d+\]/gi, '');

        cleanedMarkdown = cleanedMarkdown.replace(/\$\s*(\d+(?:[.,]\d+)?)\s*\\\circ\s*C\s*\$/gi, '$1°C');
        cleanedMarkdown = cleanedMarkdown.replace(/(\d+(?:[.,]\d+)?)\s*\\\circ\s*C/gi, '$1°C');
        cleanedMarkdown = cleanedMarkdown.replace(/\$\s*(\d+(?:[.,]\d+)?)\s*%\s*\$/gi, '$1%');
        cleanedMarkdown = cleanedMarkdown.replace(/\$\s*(\d+\/\d+)\s*\$/g, '$1');

        cleanedMarkdown = cleanedMarkdown.replace(/(SHOPPING LIST.*?:?)\s*(?:Buy|Koop)/gi, '$1\n\n- Buy');
        cleanedMarkdown = cleanedMarkdown.replace(/([^\n])\s*(-\s*(?:Buy|Koop))/gi, '$1\n\n$2');
        cleanedMarkdown = cleanedMarkdown.replace(/([^\n])\s*(\d+\.)/g, '$1\n\n$2');

        let html = cleanedMarkdown
            .replace(/^#\s+(.*)$/gm, '<h1 class="text-xl font-black font-header text-app-header tracking-tight border-b border-app-brand/10 pb-2 mb-4 mt-2">$1</h1>')
            .replace(/^##\s+(.*)$/gm, '<h2 class="text-md font-bold text-app-brand font-header mt-4 mb-2">$1</h2>')
            .replace(/^###\s+(.*)$/gm, '<h3 class="text-sm font-bold text-on-surface-variant font-sans mt-3 mb-1">$1</h3>');

        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*\*/g, '');

        const shoppingListMatch = html.match(/(SHOPPING LIST[\s\S]*?)(?=\n<h[1-3]|\n\n[A-Z]|$)/i);
        if (shoppingListMatch && shoppingListMatch.at(0)) {
            const rawSection = shoppingListMatch.at(0);
            const items = rawSection.split('\n').filter(line => {
                const trimmed = line.trim();
                if (!trimmed.startsWith('-')) return false;
                const content = trimmed.replace(/^-\s*/, '').trim().toLowerCase();
                return content !== '' && content !== 'buy' && content !== 'buy at least' && content !== 'koop';
            });

            if (items.length > 0) {
                const headerLine = rawSection.split('\n').at(0);
                let listHtml = `${headerLine}\n<ul class="list-disc pl-5 my-2 space-y-1">`;
                for (let k = 0; k < items.length; k++) {
                    const cleanItem = items.at(k).replace(/^-\s*/, '').trim();
                    listHtml += `<li class="text-xs text-on-surface-variant">${cleanItem}</li>`;
                }
                listHtml += '</ul>';
                html = html.replace(rawSection, listHtml);
            } else {
                const headerLine = rawSection.split('\n').at(0);
                html = html.replace(rawSection, headerLine);
            }
        }

        const lines = html.split('\n');
        let inTable = false;
        let tableHtml = "";

        for (let i = 0; i < lines.length; i++) {
            const line = lines.at(i).trim();
            if (line.startsWith('|')) {
                if (!inTable) {
                    inTable = true;
                    tableHtml = '<div class="overflow-x-auto my-4 rounded-xl border border-app-brand/10 bg-surface/50"><table class="w-full text-left border-collapse text-xs">';
                }
                
                const cells = line.split('|').map(c => c.trim()).filter(c => c);
                if (line.includes('---')) continue;

                const isHeader = !line.includes('---') && !html.includes('border-b') && i === lines.findIndex(l => l.trim().startsWith('|'));
                
                tableHtml += `<tr class="${isHeader ? 'bg-app-primary/10 font-bold text-app-brand border-b border-app-brand/10 text-[10px] uppercase tracking-wider' : 'border-b border-app-brand/5 hover:bg-app-primary/5 transition-colors'}">`;
                cells.forEach(cell => {
                    tableHtml += isHeader ? `<th class="p-3 font-semibold">${cell}</th>` : `<td class="p-3 text-on-surface-variant font-medium">${cell}</td>`;
                });
                tableHtml += '</tr>';
            } else {
                if (inTable) {
                    inTable = false;
                    tableHtml += '</table></div>';
                    lines.splice(i - 1, 0, tableHtml);
                    tableHtml = "";
                }
            }
        }
        if (inTable) {
            tableHtml += '</table></div>';
            lines.push(tableHtml);
        }

        html = lines.filter(l => !l.trim().startsWith('|')).join('\n');
        return html;

    } catch (error) {
        window.logSystemError(error, 'Recipe Table Markdown Serialization Analysis', 'ERROR');
        return `<pre class="p-4 bg-error/10 text-error rounded-xl text-xs font-mono whitespace-pre-wrap">${markdown}</pre>`;
    }
}

async function renderRecipeOutput(markdown, isTweak = false) {
    const recipeOutput = document.getElementById('recipe-output');
    if (!recipeOutput) return;

    let finalMarkdown = markdown;
    
    if (!finalMarkdown.trim().startsWith('# ')) {
        finalMarkdown = `# Untitled Batch\n\n${finalMarkdown}`;
    }
    
    currentRecipeMarkdown = finalMarkdown;
    window.currentRecipeMarkdown = finalMarkdown;
    tempState.currentRecipe = finalMarkdown;

    let flavorProfileHtml = `
    <div id="flavor-profile-section" class="mt-8 pt-6 border-t border-outline-variant/30">
        <h3 class="text-2xl font-header font-bold text-center mb-4 text-on-surface">Organoleptic Analysis</h3>
        <div id="flavor-wheel-container-wrapper" class="card p-6 rounded-2xl max-w-sm mx-auto text-center bg-surface-container-low border border-outline-variant/50">
            <div class="w-12 h-12 bg-primary/10 text-primary rounded-full flex items-center justify-center mx-auto mb-3">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"></path></svg>
            </div>
            <p class="text-xs text-on-surface-variant mb-4 leading-relaxed">Predict the sensory equilibrium, mouthfeel, sweetness, and complexity matrix of this recipe configuration.</p>
            <button id="btn-generate-flavor-wheel" onclick="window.triggerOnDemandFlavorAnalysis()" class="bg-primary text-on-primary font-bold py-2.5 px-5 rounded-full text-xs uppercase tracking-widest hover:brightness-110 active:scale-95 transition-all shadow-sm no-print">
                Generate Flavor Wheel
            </button>
            <div id="flavor-generation-status" class="mt-2 text-xs font-mono text-primary hidden no-print"></div>
        </div>
    </div>`;

    const titleSectionHtml = `
    <div id="creative-branding-section" class="mt-4 mb-6 p-4 border border-outline-variant/50 bg-surface-container-low rounded-2xl no-print flex justify-between items-center border border-outline-variant/50">
        <div>
            <h4 class="font-bold text-primary text-sm uppercase flex items-center gap-2">Creative Branding</h4>
            <p class="text-xs text-on-surface-variant mt-1">Refactor the default title into a unique commercial craft name line.</p>
        </div>
        <button id="btn-generate-creative-title" onclick="window.triggerOnDemandBrandingAnalysis()" class="bg-primary text-on-primary py-2.5 px-4 rounded-full text-xs font-bold uppercase tracking-widest hover:opacity-90 btn shadow-sm whitespace-nowrap">
            Generate Name
        </button>
    </div>`;
    
    let processedMarkdown = formatRecipeMarkdown(finalMarkdown);
    processedMarkdown = processedMarkdown.replace(/\[d:[\d:]+\]/g, ''); 
    
    if (typeof marked === 'undefined') {
        recipeOutput.innerHTML = `<pre>${processedMarkdown}</pre><p class="text-red-500">Error: Marked.js library missing.</p>`;
        return;
    }
    const recipeHtml = marked.parse(processedMarkdown);
    
    const fullHtml = `
        <div class="print-button-container text-right mb-4 flex justify-end flex-wrap gap-2 no-print">
            <button onclick="window.generateRecipe()" class="bg-primary text-on-primary py-2 px-4 rounded-xl hover:opacity-90 transition-colors btn text-sm flex items-center gap-1 font-bold uppercase tracking-wider">
               Retry
            </button>
            <button onclick="window.printRecipe()" class="bg-surface-container border border-outline-variant text-on-surface py-2 px-4 rounded-xl hover:bg-surface-container-high transition-colors btn text-sm font-bold uppercase tracking-wider">Print Recipe</button>
        </div>

        <div class="recipe-content prose dark:prose-invert max-w-none text-on-surface">${recipeHtml}</div>

        ${titleSectionHtml}
    
        <div id="water-recommendation-card" class="mt-4 p-4 border border-outline-variant/50 bg-surface-container-low rounded-2xl no-print transition-all">
            <div class="flex justify-between items-center">
                <div>
                    <h4 class="font-bold text-primary text-sm uppercase flex items-center gap-2">Water Chemistry</h4>
                    <p class="text-xs text-on-surface-variant mt-1">Don't want to mess with salts? Find a bottled water that matches.</p>
                </div>
                <button onclick="window.findCommercialWaterMatch()" class="bg-primary text-on-primary py-2.5 px-4 rounded-full text-xs font-bold uppercase tracking-widest hover:opacity-90 btn shadow-sm whitespace-nowrap">Find Matching Brand</button>
            </div>
            <div id="water-brand-results" class="hidden mt-4 pt-4 border-t border-outline-variant/30 text-sm text-on-surface"></div>
        </div>

        ${flavorProfileHtml}
        
        <div id="tweak-unsaved-section" class="mt-6 pt-6 border-t border-outline-variant/30 no-print">
            <h3 class="text-2xl font-header font-bold text-center mb-4 text-on-surface">Not quite right? Tweak it.</h3>
            <div class="card p-4 rounded-2xl bg-surface-container-low border border-outline-variant/50">
                <label for="tweak-unsaved-request" class="block text-xs font-bold mb-2 uppercase text-on-surface-variant tracking-wider ml-1">Describe what you want to change:</label>
                <textarea id="tweak-unsaved-request" rows="3" class="w-full p-3 border rounded-xl bg-surface border-outline-variant text-sm text-on-surface focus:ring-1 focus:ring-primary" placeholder="e.g., 'Make this for 20 liters', or 'Replace the apples with pears'"></textarea>
                <button id="tweak-unsaved-btn" class="w-full mt-3 bg-primary text-on-primary font-bold py-3 px-4 rounded-full text-xs uppercase tracking-widest hover:opacity-90 btn">Generate Tweaked Recipe</button>
            </div>
            <div id="tweak-unsaved-output" class="mt-6"></div>
        </div>

        <div class="mt-6 no-print">
            <button id="saveBtn" class="w-full bg-primary text-on-primary font-bold py-3.5 px-4 rounded-full hover:opacity-90 transition-colors btn text-sm uppercase tracking-widest shadow-elevation-1">Save to Brew History</button>
        </div>
    `;

    recipeOutput.innerHTML = fullHtml;

    const saveBtn = document.getElementById('saveBtn');
    if(saveBtn) {
        saveBtn.addEventListener('click', () => {
            if (window.saveBrewToHistory) {
                window.saveBrewToHistory(currentRecipeMarkdown, currentPredictedProfile);
            } else {
                const missingFuncError = new Error("The reference target saveBrewToHistory function is missing from memory window scope.");
                window.logSystemError(missingFuncError, 'Recipe Pipeline: History Preservation Interface', 'ERROR');
                window.showToast("Preservation linkage failure: Save functionality is currently unlinked.", "error");
            }
        });
    }
    
    const tweakBtn = document.getElementById('tweak-unsaved-btn');
    if(tweakBtn) {
        tweakBtn.addEventListener('click', tweakUnsavedRecipe);
    }
}

window.printRecipe = function() {
    let styleElement = null;
    let h1Element = null;
    let originalHeadingText = "";
    let originalDocTitle = "";

    try {
        const h1NodeList = document.querySelectorAll('#recipe-output h1');
        if (h1NodeList && h1NodeList.length > 0) {
            h1Element = h1NodeList.item(0);
        }

        if (h1Element) {
            originalHeadingText = h1Element.textContent;
            if (!originalHeadingText.startsWith("MEA(N)DERY - ")) {
                h1Element.textContent = "MEA(N)DERY - " + originalHeadingText;
            }
        }

        const recipeTitle = extractTitle(currentRecipeMarkdown) || "Recipe";
        originalDocTitle = document.title;
        document.title = "MEA(N)DERY - " + recipeTitle;

        const flavorCanvas = document.getElementById('generated-flavor-wheel');
        const hasFlavorChart = flavorCanvas && flavorCanvas.width > 0 && flavorCanvas.height > 0 && currentPredictedProfile !== null;

        styleElement = document.createElement('style');
        styleElement.id = 'recipe-print-style';
        styleElement.textContent = `
            @media print {
                @page {
                    size: A4;
                    margin: 10mm 12mm 10mm 12mm;
                }
                body * {
                    visibility: hidden !important;
                }
                #recipe-output, #recipe-output * {
                    visibility: visible !important;
                }
                #recipe-output {
                    position: absolute !important;
                    left: 0 !important;
                    top: 0 !important;
                    width: 100% !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    font-size: 10pt !important;
                    line-height: 1.3 !important;
                }
                #recipe-output ol {
                    display: block !important;
                    list-style-type: decimal !important;
                    margin: 0.5em 0 0.5em 1.5em !important;
                    padding-left: 1em !important;
                }
                #recipe-output ul {
                    display: block !important;
                    list-style-type: disc !important;
                    margin: 0.5em 0 0.5em 1.5em !important;
                    padding-left: 1em !important;
                }
                #recipe-output li {
                    display: list-item !important;
                    margin-bottom: 0.25em !important;
                }
                #generated-flavor-wheel, canvas {
                    max-height: 190px !important;
                    width: auto !important;
                    margin: 0 auto !important;
                }
                .card, table, tr, img, canvas, div.overflow-x-auto, li {
                    page-break-inside: avoid !important;
                }
                h1, h2, h3 {
                    page-break-after: avoid !important;
                }
                .no-print, .no-print * {
                    display: none !important;
                    visibility: hidden !important;
                }
                ${!hasFlavorChart ? '#flavor-profile-section { display: none !important; visibility: hidden !important; }' : ''}
            }
        `;
        document.head.appendChild(styleElement);

        window.print();

    } catch (error) {
        window.logSystemError(error, "brewing.js: printRecipe", "ERROR");
    } finally {
        if (h1Element && originalHeadingText) {
            h1Element.textContent = originalHeadingText;
        }
        if (originalDocTitle) {
            document.title = originalDocTitle;
        }
        if (styleElement && styleElement.parentNode) {
            styleElement.parentNode.removeChild(styleElement);
        }
    }
};

window.triggerOnDemandBrandingAnalysis = async function() {
    const btn = document.getElementById('btn-generate-creative-title');
    if (!currentRecipeMarkdown) return;
    
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Branding...";
    }

    try {
        const userApiKey = state.userSettings?.apiKey || "";
        if (userApiKey) {
            await generateAndInjectCreativeTitle(currentRecipeMarkdown);
            window.showToast("Creative batch branding sequence complete.", "success");
            if (btn) {
                btn.disabled = false;
                btn.innerText = "Regenerate Name";
            }
            const titleInput = document.getElementById('recipe-title-input');
            if (titleInput) {
                titleInput.value = extractTitle(currentRecipeMarkdown) || titleInput.value;
            }
        } else {
            window.showToast("Authentication missing: Provide an API Key configuration.", "error");
            if (btn) {
                btn.disabled = false;
                btn.innerText = "Regenerate Name";
            }
        }
    } catch (error) {
        window.logSystemError(error, 'On-Demand Branding Execution Anomaly', 'ERROR');
        window.showToast("Branding generation rate limit constraint mapped.", "error");
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Regenerate Name";
        }
    }
};

window.triggerOnDemandBrandingAnalysis = window.triggerOnDemandBrandingAnalysis;

window.updateRecipeTitleFromInput = function(newTitle) {
    try {
        const cleanTitle = newTitle.trim();
        if (!cleanTitle || !currentRecipeMarkdown) return;

        currentRecipeMarkdown = currentRecipeMarkdown.replace(/^#\s*(.*)/m, `# ${cleanTitle}`);
        window.currentRecipeMarkdown = currentRecipeMarkdown;
        tempState.currentRecipe = currentRecipeMarkdown;

        const h1Element = document.querySelector('#recipe-output h1');
        if (h1Element) {
            h1Element.textContent = cleanTitle;
        }
    } catch (error) {
        window.logSystemError(error, 'brewing.js: updateRecipeTitleFromInput', 'ERROR');
    }
};

window.triggerOnDemandFlavorAnalysis = async function() {
    const wrapper = document.getElementById('flavor-wheel-container-wrapper');
    const statusDiv = document.getElementById('flavor-generation-status');
    const btn = document.getElementById('btn-generate-flavor-wheel');

    if (!currentRecipeMarkdown) return;
    
    if (btn) btn.disabled = true;
    if (statusDiv) {
        statusDiv.innerText = "Analyzing Sensory DNA...";
        statusDiv.classList.remove('hidden');
    }

    try {
        const userApiKey = state.userSettings?.apiKey || "";
        const userModel = state.userSettings?.aiModel || "gemini-2.0-flash";

        const prompt = `You are a professional mead sommelier. Analyze this recipe and PREDICT its final flavor profile. Assign score 0-5 for: Sweetness, Acidity, Fruity/Floral, Spiciness, Earthy/Woody, Body/Mouthfeel. Output ONLY JSON. Recipe: "${currentRecipeMarkdown}"`;
        
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

        const jsonResponse = await performApiCall(prompt, schema, userApiKey, userModel);
        currentPredictedProfile = JSON.parse(jsonResponse);

        if (wrapper) {
            wrapper.innerHTML = `<canvas id="generated-flavor-wheel" style="max-height: 280px;"></canvas>`;
            renderGeneratedFlavorWheel(currentPredictedProfile);
            window.showToast("Organoleptic profiling complete.", "success");
        }
    } catch (error) {
        window.logSystemError(error, 'On-Demand Sensory Execution Anomaly', 'ERROR');
        window.showToast("Sensory evaluation rate limit constraint mapped.", "error");
        if (btn) btn.disabled = false;
        if (statusDiv) statusDiv.classList.add('hidden');
    }
};

window.triggerOnDemandFlavorAnalysis = window.triggerOnDemandFlavorAnalysis;

async function tweakUnsavedRecipe() {
    const tweakRequest = document.getElementById('tweak-unsaved-request').value.trim();
    if (!tweakRequest) { showToast("Please enter your tweak request.", "error"); return; }

    const tweakOutput = document.getElementById('tweak-unsaved-output');
    tweakOutput.innerHTML = getLoaderHtml("Analyzing Tweak Request..."); 
    
    const tweakBtn = document.getElementById('tweak-unsaved-btn');
    tweakBtn.disabled = true;

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
        
        tweakOutput.innerHTML = '';

    } catch (error) {
        if (thinkingInterval) clearInterval(thinkingInterval);
        window.logSystemError(error, "brewing.js: tweakUnsavedRecipe", "CRITICAL");
        window.showToast("Failed to compile or parse the new recipe structure.", "error");
        
        const recipeOutput = document.getElementById('recipe-output');
        if (recipeOutput) {
            recipeOutput.innerHTML = `
                <div class="p-4 bg-error-container/20 border border-error/30 rounded-xl text-xs text-error font-medium max-w-none text-center">
                    ⚠️ <strong>Tweak Modification Failure:</strong> ${error.message}<br>
                    <span class="opacity-70">Please check your network connectivity, API key alignment, or try again after a cooling period.</span>
                </div>
            `;
        }
    } finally {
        if (tweakBtn) {
            tweakBtn.disabled = false;
        }
        const generateBtn = document.getElementById('generateBtn');
        if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
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

function handleDescriptionInput() {
    const descriptionInput = document.getElementById('customDescription');
    const optionsContainer = document.querySelector('details[open] > div');
    
    const warningMessage = document.getElementById('description-priority-warning');
    
    if(!descriptionInput) return;
    
    const hasText = descriptionInput.value.trim() !== '';

    const structuredContainer = document.getElementById('structured-options-container');
    if (!structuredContainer) return;
    
    const detailsContainers = structuredContainer.querySelectorAll('.structured-option-group');
    
    detailsContainers.forEach(container => {
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

window.generateRecipe = generateRecipe;
window.applyWaterTweak = applyWaterTweak;
window.handleDescriptionInput = handleDescriptionInput;
window.handleStyleChange = handleStyleChange;
window.handleEquipmentTypeChange = handleEquipmentTypeChange;
window.loadHistory = loadHistory;

window.regenerateFlavorProfile = async function() {
    if (currentRecipeMarkdown && typeof renderRecipeOutput === 'function') {
        const btn = document.getElementById('retry-flavor-btn');
        if(btn) btn.innerText = "Retrying...";
        await renderRecipeOutput(currentRecipeMarkdown);
    }
};

function extractStepsFromMarkdown(markdown) {
    if (!markdown) return { day1: [], day2: [] };

    const lines = markdown.split('\n');
    const day1 = [];
    const day2 = [];
    
    let isParsingInstructions = false;

    const instructionHeaderRegex = /^(?:#+|__|\*\*)\s*(?:Instructions|Steps|Method|Procedure|Bereiding)(?:__|\*\*|:)?/i;
    const anyHeaderRegex = /^(?:#+|__|\*\*)\s*([a-zA-Z].*)/; 
    const prefixRegex = /^(?:Step\s+)?(\d+)[\.\)\s]\s*|^\s*[-*•]\s+/i;
    const blackList = ['abv:', 'batch size:', 'style:', 'sweetness:', 'og:', 'fg:', 'buy ', 'target '];

    for (let i = 0; i < lines.length; i++) {
        const line = lines.at(i);
        let cleanLine = line ? line.trim() : '';
        
        if (!cleanLine) continue;

        if (cleanLine.match(instructionHeaderRegex)) { isParsingInstructions = true; continue; }
        if (isParsingInstructions && cleanLine.match(anyHeaderRegex)) {
            if (cleanLine.startsWith('#')) break; 
            if (cleanLine.match(/(Note|Tip|Profile|Summary|Data)/i)) break;
        }
        if (!isParsingInstructions) continue;
        if (blackList.some(badWord => cleanLine.toLowerCase().includes(badWord))) continue;

        cleanLine = cleanLine.replace(prefixRegex, '');
        cleanLine = cleanLine.replace(/^\*\*|\*\*$/g, '').trim();

        if (cleanLine) {
            const lower = cleanLine.toLowerCase();
            
            let title = "Action"; 
            let description = cleanLine;

            const colonSplit = cleanLine.match(/^([^:]+):\s*(.*)/);
            const boldSplit = cleanLine.match(/^\*\*([^*]+)\*\*\s*(.*)/);

            if (boldSplit) {
                title = boldSplit.at(1).replace(':', '').trim(); 
                description = boldSplit.at(2) || boldSplit.at(1); 
            } else if (colonSplit && colonSplit.at(1).length < 50) {
                title = colonSplit.at(1).trim();
                description = colonSplit.at(2).trim();
            } else {
                const words = cleanLine.split(' ');
                if (words.length > 5) title = words.slice(0, 4).join(' ') + '...';
                else { title = cleanLine; description = ""; }
            }

            let duration = 0;
            
            const timerMatch = description.match(/\[TIMER:\s*(\d+):(\d+):(\d+)\]/);
            
            if (timerMatch) {
                duration = (parseInt(timerMatch.at(1)) * 3600) + (parseInt(timerMatch.at(2)) * 60) + parseInt(timerMatch.at(3));
                description = description.replace(timerMatch.at(0), '').trim();
                title = title.replace(/\[TIMER:.*?\]/, '').trim();
            } 

            else {
                const titleDesc = (title + " " + description).toLowerCase();
                
                if (titleDesc.includes('24 hours') || titleDesc.includes('24 uur')) duration = 86400;
                else if (titleDesc.includes('48 hours') || titleDesc.includes('48 uur')) duration = 86400; 
                else if (titleDesc.includes('72 hours') || titleDesc.includes('72 uur')) duration = 86400;
                else if (titleDesc.includes('7 days') || titleDesc.includes('1 week')) duration = 604800;
                
                const minMatch = titleDesc.match(/(\d+)\s*(min|minuten|minutes)/i);
                if (minMatch) {
                    duration = parseInt(minMatch.at(1)) * 60;
                }
            }

            const stepObj = { title, description, duration };

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
    
    if (day1.length === 0 && day2.length > 0) {
        const splitIndex = day2.findIndex(s => s.description.toLowerCase().includes('rack'));
        if (splitIndex > 0) day1.push(...day2.splice(0, splitIndex));
        else { day1.push(...day2); day2.length = 0; }
    }

    return { day1, day2 };
}

window.startBrewDay = async function(brewId) {
    try {
        if (!brewId) {
            window.showToast("Fout: Geen brouw-ID gespecificeerd.", "error");
            return;
        }

        const brew = state.brews.find(b => b.id === brewId);
        if (!brew) {
            window.showToast("Fout: Batchsessie niet gevonden.", "error");
            return;
        }

        let vTarget, ogTarget, brixTarget, mHoning, mNutrient;
        try {
            const targetVolumeRaw = String(brew.batchSize || "5").replace(',', '.');
            vTarget = parseFloat(targetVolumeRaw) || 5;

            const parsedStats = parseRecipeData(brew.recipeMarkdown);
            const ogTargetRaw = String(parsedStats.targetOG || "1.000").replace(',', '.');
            ogTarget = parseFloat(ogTargetRaw) || 1.000;

            if (ogTarget >= 1.775) {
                window.showToast("Fysische limietoverschrijding: OG target buiten bereik.", "error");
                return;
            }

            brixTarget = (182.9622 * Math.pow(ogTarget, 3)) - (777.3009 * Math.pow(ogTarget, 2)) + (1264.5170 * ogTarget) - 670.1831;

            const mTotalMust = vTarget * ogTarget;
            const mSuiker = mTotalMust * (brixTarget / 100);
            mHoning = mSuiker / 0.82; 

            const recipeText = (brew.recipeMarkdown || "").toLowerCase();
            let fGist = 1.0; 
            if (recipeText.includes("71b") || recipeText.includes("ec-1118") || recipeText.includes("d47") || recipeText.includes("qa23")) {
                fGist = 0.75; 
            }

            const yanTarget = 10 * brixTarget * ogTarget * fGist;
            const mNTotal = yanTarget * vTarget;

            const nutrientDatabase = {
                'fermaid_o': { rawYan: 40.0, muNutrient: 4.0 },
                'fermaid_k': { rawYan: 100.0, muNutrient: 1.0 },
                'nutrisal': { rawYan: 210.0, muNutrient: 1.0 },
                'cellvit': { rawYan: 25.0, muNutrient: 2.0 },
                'nutrimix': { rawYan: 117.5, muNutrient: 2.0 },
                'wyeast_wine': { rawYan: 129.2, muNutrient: 2.0 },
                'wyeast_beer': { rawYan: 103.6, muNutrient: 2.0 },
                'engevita': { rawYan: 25.0, muNutrient: 1.5 },
                'bby': { rawYan: 14.7, muNutrient: 2.0 }
            };

            const userNutrientSelection = document.getElementById('recipeNutrientSelect')?.value || 'fermaid_o';
            const activeNutrient = nutrientDatabase.hasOwnProperty(userNutrientSelection) 
                ? nutrientDatabase[userNutrientSelection] 
                : nutrientDatabase.fermaid_o;

            mNutrient = mNTotal / (activeNutrient.rawYan * activeNutrient.muNutrient);

        } catch (parsingError) {
            window.logSystemError(parsingError, 'brewing.js: startBrewDay Material Balance Verification', 'CRITICAL');
            window.showToast("Materiaalevaluatie mislukt wegens corrupte of incomplete receptuur-metadata.", "error");
            return;
        }

        const currentInventory = state.inventory || [];
        
        const honeyStockItem = currentInventory.find(i => i.category === 'Honey');
        const honeyStockQty = honeyStockItem ? parseFloat(String(honeyStockItem.qty).replace(',', '.')) || 0 : 0;

        const userNutrientSelection = document.getElementById('recipeNutrientSelect')?.value || 'fermaid_o';
        const nutrientStockItem = currentInventory.find(i => i.name.toLowerCase().includes(userNutrientSelection.replace('_', ' ')));
        const nutrientStockQty = nutrientStockItem ? parseFloat(String(nutrientStockItem.qty).replace(',', '.')) || 0 : 0;

        if (honeyStockQty < mHoning || nutrientStockQty < mNutrient) {
            window.showToast("Brouwdag geblokkeerd: Toereikende stoichiometrische grondstoffen ontbreken in de voorraad.", "error");
            
            switchMainView('brewing');
            switchSubView('shopping-list', 'brewing-main-view');
            
            if (window.generateShoppingList) {
                window.generateShoppingList(brewId, true);
            }
            return;
        }

        window.startActualBrewDay(brewId);
        window.showToast("Voorraad gecontroleerd en sluitend. Brouwdag sessie geïnitieerd.", "success");

    } catch (error) {
        window.logSystemError(error, 'brewing.js: window.startBrewDay Algorithmic Orchestration Root', 'ERROR');
        window.showToast("Systeemfout tijdens materiaalbalans-evaluatie.", "error");
    }
};

window.startActualBrewDay = async function() {
    try {
        const brewIdInput = document.getElementById('brew_recipeId');
        const brewId = brewIdInput ? brewIdInput.value : null;

        if (!brewId) {
            window.showToast("Geen geldig brouw-ID gedetecteerd voor deze actie.", "error");
            return;
        }

        if (!state.userSettings) state.userSettings = {};
        state.userSettings.currentBrewDay = { brewId: brewId };

        if (state.userId) {
            const settingsDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main');
            await updateDoc(settingsDocRef, {
                currentBrewDay: { brewId: brewId }
            });
        }

        window.renderBrewDay(brewId);

    } catch (error) {
        window.logSystemError(error, 'brewing.js: window.startActualBrewDay', 'ERROR');
        window.showToast("Kan de brouwdag-sessie niet initiëren.", "error");
    }
};

window.renderBrewDay = async function(activeId) {
    try {
        const resolvedId = activeId || tempState.activeBrewId || (state.userSettings && state.userSettings.currentBrewDay ? state.userSettings.currentBrewDay.brewId : null);

        if (!resolvedId || resolvedId === 'none') {
            const container = document.getElementById('brew-day-dynamic-container');
            if (container) {
                container.innerHTML = `
                    <div class="flex flex-col items-center justify-center py-16 px-4 text-center max-w-sm mx-auto">
                        <div class="w-16 h-16 rounded-full bg-surface-variant flex items-center justify-center text-on-surface-variant mb-4 animate-pulse">
                            🍺
                        </div>
                        <h3 class="text-xl font-header font-bold text-on-surface mb-2">No Active Brew Day</h3>
                        <p class="text-xs text-on-surface-variant leading-relaxed">
                            There is currently no brew active in your production pipeline. Head over to the Recipe Creator or select a batch from your history to kick off your brew day.
                        </p>
                    </div>
                `;
            }
            const headline = document.getElementById('active-brew-headline');
            if (headline) headline.textContent = "Production Pipeline - Inactive";
            return; 
        }

        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', resolvedId);
        const brewSnapshot = await getDoc(docRef);
        
        if (!brewSnapshot.exists()) {
            window.showToast("Database mismatch: Active batch profile missing. Auto-cleaning pipeline.", "warning");
            
            if (state.userSettings) {
                state.userSettings.currentBrewDay = { brewId: null };
            }
            
            if (state.userId) {
                const settingsDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main');
                await updateDoc(settingsDocRef, {
                    currentBrewDay: { brewId: null }
                });
            }
            
            const container = document.getElementById('brew-day-dynamic-container');
            if (container) {
                container.innerHTML = `
                    <div class="flex flex-col items-center justify-center py-16 px-4 text-center max-w-sm mx-auto">
                        <div class="w-16 h-16 rounded-full bg-surface-variant flex items-center justify-center text-on-surface-variant mb-4 animate-pulse">
                            🍺
                        </div>
                        <h3 class="text-xl font-header font-bold text-on-surface mb-2">No Active Brew Day</h3>
                        <p class="text-xs text-on-surface-variant leading-relaxed">
                            There is currently no brew active in your production pipeline. Head over to the Recipe Creator or select a batch from your history to kick off your brew day.
                        </p>
                    </div>
                `;
            }
            const headline = document.getElementById('active-brew-headline');
            if (headline) headline.textContent = "Production Pipeline - Inactive";
            return; 
        }

        const brew = {
            id: brewSnapshot.id,
            ...brewSnapshot.data()
        };

        const brewDayView = document.getElementById('brewDayView');
        const brewingView = document.getElementById('brewingView');
        
        if (brewingView) brewingView.classList.add('hidden');
        if (brewDayView) {
            brewDayView.classList.remove('hidden');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        if (!state.userSettings) state.userSettings = {};
        if (!state.userSettings.currentBrewDay) state.userSettings.currentBrewDay = {};
        state.userSettings.currentBrewDay.brewId = resolvedId;

        if (state.userId) {
            const settingsDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main');
            await updateDoc(settingsDocRef, {
                currentBrewDay: { brewId: resolvedId }
            });
        }

        const stepsContainer = document.getElementById('brewDayStepsContainer');
        if (stepsContainer) {
            if (!brew.steps || brew.steps.length === 0) {
                if (brew.recipeMarkdown) {
                    const extracted = extractStepsFromMarkdown(brew.recipeMarkdown);
                    if (extracted && extracted.day1) {
                        brew.steps = extracted.day1.map(s => ({ name: s.title, description: s.description, duration: s.duration, completed: false }));
                    }
                }
            }

            if (!brew.steps || brew.steps.length === 0) {
                stepsContainer.innerHTML = `
                    <div class="p-8 text-center text-on-surface-variant text-sm italic">
                        Geen specifieke brouwstappen gedefinieerd in dit receptprofiel.
                    </div>`;
                return;
            }

            let stepsHtml = "";
            brew.steps.forEach((step, idx) => {
                const isChecked = step.completed ? "checked disabled" : "";
                const opacityClass = step.completed ? "opacity-40 bg-app-primary/5" : "border-app-brand";
                
                stepsHtml += `
                    <div class="step-card p-4 rounded-xl border ${opacityClass} bg-surface transition-all duration-300 flex items-start gap-4 mb-3">
                        <div class="pt-0.5">
                            <input type="checkbox" id="step_check_${idx}" class="step-checkbox checkbox-custom" ${isChecked} onclick="window.completeStep(${idx})">
                        </div>
                        <div class="flex-1 space-y-1">
                            <p class="font-bold text-sm text-on-surface">${step.name || 'Onbenoemde actie'}</p>
                            ${step.duration ? `<p class="text-[11px] text-app-brand font-mono">Tijdsduur: ${formatTime(step.duration)}</p>` : ''}
                            ${step.description ? `<p class="text-xs opacity-70 leading-relaxed text-on-surface-variant">${step.description}</p>` : ''}
                        </div>
                        ${step.duration && !step.completed ? `
                            <div>
                                <button id="timer_btn_${idx}" class="btn-md3 btn-tonal text-xs py-1 px-3" onclick="window.startStepTimer(${step.duration})">
                                    Start Timer
                                </button>
                            </div>` : ''}
                    </div>`;
            });
            stepsContainer.innerHTML = stepsHtml;
        }

        const headline = document.getElementById('brewDayHeadline');
        if (headline) headline.textContent = `Brouwdag: ${brew.recipeName || 'Active Batch'}`;

        const logContainer = document.getElementById('brew-day-log-container');
        if (logContainer) {
            logContainer.innerHTML = getBrewLogHtml(brew, resolvedId);
            setTimeout(() => { if (window.syncLogToFinal) window.syncLogToFinal(resolvedId); }, 50);
        }

    } catch (error) {
        window.logSystemError(error, 'brewing.js: window.renderBrewDay', 'ERROR');
        window.showToast("Fout bij het laden van de actieve brouwdag-matrix.", "error");
    }
};

window.renderBrewDay2 = async function() {
    const container = document.getElementById('brew-day-2-view');
    if (!container) return;

    try {
        const agingBrews = state.brews.filter(b => b.primaryComplete && !b.isBottled && b.status !== 'split');
        const activeId = tempState.activeBrewId;
        const activeBrew = activeId ? state.brews.find(b => b.id === activeId) : null;

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
                    ? `<span class="px-3 py-1 rounded-full text-xs font-bold text-green-600 bg-green-500/10 border border-green-500/20 uppercase tracking-wide">DONE</span>` 
                    : `<button onclick="window.toggleSecondaryStep('${activeBrew.id}', '${key}')" class="h-11 px-5 rounded-full bg-surface-container-high border border-outline text-primary font-bold hover:bg-primary/10 active:scale-95 transition-all text-xs uppercase tracking-wide flex items-center justify-center">Check</button>`;
                
                return `
                <div class="p-4 border-b border-outline-variant/30 flex justify-between items-start gap-4 ${isChecked ? 'opacity-60 grayscale' : ''}">
                    <div class="flex-grow">
                        <p class="font-bold text-sm text-on-surface flex items-center gap-2">
                            <span class="w-6 h-6 rounded-full bg-surface-container-highest text-[10px] font-bold text-on-surface-variant flex items-center justify-center border border-outline-variant">${idx + 1}</span> ${step.title}
                        </p>
                        <p class="text-xs text-slate-600 dark:text-on-surface-variant mt-1.5 leading-relaxed pl-8">${step.description}</p>
                    </div>
                    <div class="pt-1">${btnHtml}</div>
                </div>`;
            }).join('');

            const currentPhStr = (activeBrew.logData?.actualFG_pH || activeBrew.logData?.pH || "").toString().replace(',', '.');
            const abv = parseFloat(activeBrew.logData?.finalABV || activeBrew.logData?.targetABV || 0);
            const fgVal = parseFloat(activeBrew.logData?.actualFG || 1.000); 
            const phVal = parseFloat(currentPhStr);

            let delleDisplay = "--";
            let isDelleStable = false;
            let hallError = false;

            if (fgVal >= 1.775) {
                hallError = true;
                delleDisplay = "LIMIT ERR";
            } else {
                const brixVal = (182.9622 * Math.pow(fgVal, 3)) - (777.3009 * Math.pow(fgVal, 2)) + (1264.5170 * fgVal) - 670.1831;
                const delleValue = (abv * 4.5) + Math.max(0, brixVal);
                isDelleStable = delleValue >= 78 || abv >= 15; 
                delleDisplay = `${delleValue.toFixed(1)} / 78.0`;
            }

            const gateHtml = `
            <div id="stabilization-gatekeeper" class="mt-8 p-6 bg-app-tertiary/50 border-2 border-app-brand/20 rounded-xl no-print">
                <div class="mb-6 p-4 bg-red-600 text-white rounded-lg text-xs font-bold shadow-lg border-2 border-red-800 ${abv >= 15 ? 'hidden' : 'animate-pulse'}">
                    WARNING: Potassium Sorbate is a fungistatic agent (stabilizer), not a fungicide (yeast killer). 
                    It strictly inhibits cell reproduction. Existing active yeast cells in a cloudy must will continue to ferment sugar, 
                    directly resulting in catastrophic bottle bombs during back-sweetening. Stabilization is exclusively permitted on a visually and hydrometrically cleared must.
                </div>

                <h3 class="text-xl font-header font-bold text-app-brand mb-4 flex items-center gap-2">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
                    Stabilization Gatekeeper
                </h3>

                <div class="space-y-4 mb-6">
                    <label class="flex items-start gap-3 p-3 bg-app-secondary rounded-lg border border-app-brand/10 cursor-pointer">
                        <input type="checkbox" id="cb-checklist-cleared" class="mt-1 w-5 h-5 text-app-brand rounded focus:ring-app-brand" 
                            ${checklist.checklist_cleared ? 'checked' : ''} onchange="window.updateGateStatus('${activeBrew.id}', 'checklist_cleared')">
                        <span class="text-sm text-app-header font-medium">I confirm that the mead is hydrometrically stable and visually clear (biomass decimated).</span>
                    </label>

                    <label class="flex items-start gap-3 p-3 bg-app-secondary rounded-lg border border-app-brand/10 cursor-pointer">
                        <input type="checkbox" id="cb-checklist-so2-sync" class="mt-1 w-5 h-5 text-app-brand rounded focus:ring-app-brand" 
                            ${checklist.checklist_so2_sync ? 'checked' : ''} onchange="window.updateGateStatus('${activeBrew.id}', 'checklist_so2_sync')">
                        <span class="text-sm text-app-header font-medium">I confirm the presence of active free SO2 (preventative matrix against Geranium Taint).</span>
                    </label>
                </div>

               <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    <div class="p-4 bg-app-primary rounded-lg border border-app-brand/10">
                        <label class="text-[10px] font-bold text-app-secondary uppercase block mb-1">Actual pH (Threshold: 2.8 - 3.8)</label>
                        <input type="number" id="gate-ph-input" step="0.01" value="${currentPhStr}" 
                            class="w-full bg-app-tertiary border border-app-brand/30 rounded p-2 text-lg font-mono font-bold text-app-brand focus:ring-1 focus:ring-app-brand" 
                            placeholder="3.x" oninput="this.value = this.value.replace(',', '.'); window.renderBrewDay2()">
                    </div>
                    <div class="p-4 bg-app-primary rounded-lg border border-app-brand/10">
                        <label class="text-[10px] font-bold text-app-secondary uppercase block mb-1">Delle Stability Index</label>
                        <div class="text-lg font-mono font-bold ${hallError ? 'text-red-600 animate-pulse' : (isDelleStable ? 'text-green-600' : 'text-orange-500')}">
                            ${delleDisplay} ${!hallError ? (isDelleStable ? '✅' : '⚠️') : ''}
                        </div>
                    </div>
                </div>

                ${isDelleStable && !hallError ? `
                    <div class="mb-4 p-3 bg-green-500/10 border border-green-500/30 text-green-700 rounded-lg text-xs font-bold animate-fade-in">
                        Delle stability threshold or defensive ABV barrier (>=15%) reached. Yeast metabolism is physiologically inhibited by cumulative ethanol toxicity. Exogenous stabilization via potassium sorbate is redundant and marginally effective.
                    </div>
                ` : ''}

                ${hallError ? `
                    <div class="mb-4 p-3 bg-red-600/20 border border-red-600 text-red-600 rounded-lg text-xs font-bold">
                        ⚠️ LIMIT ERR: Final Gravity exceeds structural system boundaries. Verify hydrometric measurements.
                    </div>
                ` : ''}
            </div>`;

            const logHtml = (typeof getBrewLogHtml === 'function') ? getBrewLogHtml(activeBrew, activeBrew.id + '-sec') : '';

            const isPhValid = !isNaN(phVal) && phVal >= 2.8 && phVal <= 3.8;
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
                        <span class="px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">Secondary Phase</span>
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
                            ${isGatePassed ? 'Confirm Stabilization & Back-sweetening / Proceed to Bottling' : 'Check Requirements & pH (2.8-3.8)'}
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
        window.showToast("Failed to render maturation chamber view.", "error");
    }
};

window.showSplitModal = function(brewId, currentVolume) {
    let modal = document.getElementById('split-batch-modal');
    if (!modal) {
        const modalHtml = `
        <div id="split-batch-modal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm hidden animate-fade-in">
            <div class="bg-app-secondary p-6 rounded-xl shadow-2xl border border-app-brand/20 w-full max-w-md relative">
                <button onclick="window.closeSplitModal()" class="absolute top-3 right-4 text-app-secondary hover:text-red-500 font-bold text-xl">&times;</button>
                <h3 class="text-xl font-header font-bold text-purple-600 mb-2">Split Batch Protocol</h3>
                <p class="text-xs text-app-secondary mb-4">Partition the parent batch into autonomous child vessels for sensory fractionation or testing lines.</p>
                
                <input type="hidden" id="split-parent-id">
                <input type="hidden" id="split-max-volume">
                
                <div class="space-y-4">
                    <div class="p-3 bg-app-primary rounded-lg border border-app-brand/10 text-xs">
                        <span class="text-app-secondary uppercase font-bold block mb-1">Available Volume</span>
                        <span id="split-volume-display" class="text-base font-mono font-bold text-app-header">0.00 L</span>
                    </div>
                    <div>
                        <label class="text-xs font-bold text-app-secondary uppercase block mb-1">Split Count (Carboys)</label>
                        <input type="number" id="split-count-input" min="2" max="10" value="2" class="w-full p-2 border rounded bg-app-tertiary text-app-header text-sm" oninput="window.generateSplitVolumeInputs()">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-app-secondary uppercase block mb-1">System / Trub Loss Factor ($V_{loss}$ in Liters)</label>
                        <input type="text" id="split-loss-input" value="1.0" class="w-full p-2 border rounded bg-app-tertiary font-mono text-sm" oninput="window.generateSplitVolumeInputs()">
                    </div>
                    
                    <div id="split-volumes-container" class="space-y-2 max-h-48 overflow-y-auto p-1 border border-transparent border-t-app-brand/10 pt-3">
                        </div>
                    
                    <div class="p-3 bg-app-primary rounded-lg border border-app-brand/10 text-xs flex justify-between items-center">
                        <span class="text-app-secondary font-medium">Residual Volume Balance:</span>
                        <span id="split-balance-display" class="font-mono font-bold text-green-600">0.00 L</span>
                    </div>
                    
                    <button onclick="window.executeSplitFromModal()" class="w-full bg-purple-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-purple-700 transition-all btn uppercase text-sm shadow-md">Confirm Split & Mutate</button>
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
    
    const netVol = Math.max(0, parentVol - loss);
    const equalShare = (netVol / count).toFixed(2);
    
    let html = '<p class="text-[10px] font-bold text-app-secondary uppercase tracking-wider mb-1">Specified Volumes per Child Vessel (L)</p>';
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
        window.showToast(`Error: Volume breakdown balance failure. Remaining target is ${balance.toFixed(2)}L. Balance total child targets with trub allocations.`, "error");
        return;
    }
    
    if (confirm("Confirm splitting operation? This locks and archives the parent data series, instantiating isolated records for child vessels.")) {
        await window.splitBatch(parentBrewId, childVolumes, loss);
    }
};

window.splitBatch = async function(parentBrewId, childVolumes, lossVolume) {
    if (!state.userId || !parentBrewId) return;

    try {
        const parentBrew = state.brews.find(b => b.id === parentBrewId);
        if (!parentBrew) throw new Error("Parent brew session missing from local context.");

        const sanitizedLoss = parseFloat(String(lossVolume).replace(',', '.')) || 0;
        const { db, collection, addDoc, updateDoc, doc, serverTimestamp } = await import('./firebase-init.js');

        const recipeMarkdown = parentBrew.recipeMarkdown || "";
        const originalOG = parentBrew.logData?.actualOG || "";
        const originalFG = parentBrew.logData?.actualFG || "";
        const originalABV = parentBrew.logData?.finalABV || "";
        const fermentationLog = Array.isArray(parentBrew.logData?.fermentationLog) ? [...parentBrew.logData.fermentationLog] : [];
        const brewDaySteps = Array.isArray(parentBrew.brewDaySteps) ? [...parentBrew.brewDaySteps] : [];
        const flavorProfile = parentBrew.flavorProfile ? { ...parentBrew.flavorProfile } : {};
        const model = parentBrew.model || "gemini-1.5-flash";

        for (let i = 0; i < childVolumes.length; i++) {
            const childVol = parseFloat(String(childVolumes.at(i)).replace(',', '.')) || 0;
            if (childVol <= 0) continue;

            const childBrewObj = {
                recipeName: `${parentBrew.recipeName || 'Untitled'} - Split [${i + 1}]`,
                recipeMarkdown: recipeMarkdown,
                batchSize: childVol,
                parentBrewId: parentBrewId,
                primaryComplete: true, 
                isBottled: false,
                createdAt: serverTimestamp(),
                model: model,
                flavorProfile: flavorProfile,
                brewDaySteps: brewDaySteps,
                secondarySteps: [], 
                checklist: {},       
                logData: {
                    actualOG: originalOG,
                    actualFG: originalFG,
                    finalABV: originalABV,
                    brewDate: parentBrew.logData?.brewDate || "",
                    fermentationLog: fermentationLog, 
                    agingNotes: `Fractionated under split operations on ${new Date().toLocaleDateString()}. Target allocation volume: ${childVol}L. System trub loss footprint tracking: ${sanitizedLoss}L.`,
                    tastingNotes: "",
                    blendingLog: [],
                    actualIngredients: []
                }
            };

            await addDoc(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews'), childBrewObj);
        }

        const parentRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', parentBrewId);
        await updateDoc(parentRef, {
            status: 'split',
            'logData.agingNotes': (parentBrew.logData?.agingNotes || "") + `\nBatch session broken into ${childVolumes.length} destination vessels on ${new Date().toLocaleDateString()}. Measured volume loss footprint: ${sanitizedLoss}L.`
        });

        parentBrew.status = 'split';

        window.closeSplitModal();
        tempState.activeBrewId = null;
        window.renderBrewDay2();
        window.showToast("Batch successfully partitioned into autonomous fractions!", "success");

    } catch (error) {
        window.logSystemError(error, 'brewing.js: splitBatch', 'CRITICAL');
        window.showToast("Split batch operation failed: " + error.message, "error");
    }
};

window.showSplitModal = showSplitModal;
window.closeSplitModal = closeSplitModal;
window.generateSplitVolumeInputs = generateSplitVolumeInputs;
window.calculateSplitBalance = calculateSplitBalance;
window.executeSplitFromModal = executeSplitFromModal;
window.splitBatch = splitBatch;

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

        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), {
            checklist: brew.checklist
        });

        window.renderBrewDay2();
    } catch (error) {
        window.logSystemError(error, 'brewing.js: updateGateStatus', 'ERROR');
        window.showToast("Failed to commit checklist parameters to cloud storage.", "error");
    }
};

window.openPrimaryDetail = function(brewId) {
    document.getElementById('brewing-main-view').scrollIntoView({ behavior: 'smooth' });
    window.renderBrewDay(brewId);
}

window.closePrimaryDetail = async function() {
    try {
        const detailView = document.getElementById('brewDetailView');
        const listView = document.getElementById('brewListView');
        
        if (detailView) detailView.classList.add('hidden');
        if (listView) listView.classList.remove('hidden');

        if (state.userSettings) {
            if (!state.userSettings.currentBrewDay) state.userSettings.currentBrewDay = {};
            state.userSettings.currentBrewDay.brewId = null;
        }

        if (state.userId) {
            const settingsDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main');
            await updateDoc(settingsDocRef, {
                currentBrewDay: { brewId: null }
            });
        }

    } catch (error) {
        window.logSystemError(error, 'brewing.js: window.closePrimaryDetail', 'ERROR');
        window.showToast("Fout bij het sluiten van de detailweergave.", "error");
    }
};

window.openSecondaryDetail = (brewId) => { 
    tempState.activeBrewId = brewId; 
    renderBrewDay2(); 
    document.getElementById('brewing-main-view').scrollIntoView({ behavior: 'smooth' }); 
};

window.closeSecondaryDetail = () => { 
    tempState.activeBrewId = null; 
    renderBrewDay2(); 
};

window.startStepTimer = function(durationSeconds) {
    try {
        if (stepTimerInterval) {
            clearInterval(stepTimerInterval);
        }

        remainingTime = parseInt(durationSeconds);
        const timerDisplay = document.getElementById('stepTimerDisplay');
        const startBtn = document.getElementById('startTimerBtn');
        
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.classList.add('opacity-50', 'pointer-events-none');
        }

        if (timerDisplay) {
            timerDisplay.textContent = formatTime(remainingTime);
            timerDisplay.classList.remove('text-outline', 'animate-pulse');
            timerDisplay.classList.add('text-app-brand', 'font-black');
        }

        localStorage.setItem('activeStepTimer', JSON.stringify({
            endTime: Date.now() + (remainingTime * 1000),
            duration: durationSeconds,
            recipeName: document.getElementById('brew_recipeName')?.value || "Active Batch"
        }));

        stepTimerInterval = setInterval(() => {
            try {
                const activeDisplay = document.getElementById('stepTimerDisplay');
                const activeView = document.getElementById('brewingView');
                
                if (!activeDisplay || !activeView || activeView.classList.contains('hidden')) {
                    clearInterval(stepTimerInterval);
                    stepTimerInterval = null;
                    localStorage.removeItem('activeStepTimer');
                    return;
                }

                if (remainingTime <= 0) {
                    clearInterval(stepTimerInterval);
                    stepTimerInterval = null;
                    localStorage.removeItem('activeStepTimer');
                    
                    activeDisplay.textContent = "00:00 -- STAP VOLTOOID";
                    activeDisplay.classList.remove('text-app-brand');
                    activeDisplay.classList.add('text-red-500', 'animate-pulse');
                    
                    window.showToast("Brouwstap timer verstreken. Activeer handmatig de volgende controle.", "success");
                    
                    if (startBtn) {
                        startBtn.disabled = false;
                        startBtn.classList.remove('opacity-50', 'pointer-events-none');
                    }
                    return;
                }

                remainingTime--;
                activeDisplay.textContent = formatTime(remainingTime);
                
                localStorage.setItem('activeStepTimer', JSON.stringify({
                    endTime: Date.now() + (remainingTime * 1000),
                    duration: remainingTime,
                    recipeName: document.getElementById('brew_recipeName')?.value || "Active Batch"
                }));

            } catch (innerError) {
                if (stepTimerInterval) {
                    clearInterval(stepTimerInterval);
                    stepTimerInterval = null;
                }
                localStorage.removeItem('activeStepTimer');
                window.logSystemError(innerError, 'brewing.js: startStepTimer setInterval callback', 'ERROR');
                window.showToast("Runtime-fout in de actieve brouw-timer gedetecteerd.", "error");
            }
        }, 1000);

    } catch (error) {
        window.logSystemError(error, 'brewing.js: startStepTimer initializing', 'ERROR');
        window.showToast("Kan de brouwstap-timer niet initialiseren.", "error");
    }
};

window.pauseStepTimer = function(brewId, stepIndex) {
    if (stepTimerInterval) { clearInterval(stepTimerInterval); stepTimerInterval = null; }
    const controlsDiv = document.getElementById(`controls-${stepIndex}`);
    if (controlsDiv) controlsDiv.innerHTML = `<button onclick="window.startStepTimer('${brewId}', ${stepIndex})" class="text-xs bg-green-600 text-white py-1.5 px-3 rounded font-bold uppercase">Resume</button>`;
}

window.skipTimer = function(brewId, stepIndex) {
    if (stepTimerInterval) { clearInterval(stepTimerInterval); stepTimerInterval = null; }
    window.completeStep(stepIndex, true);
}

window.completeStep = function(stepIndex) {
    try {
        if (stepTimerInterval) {
            clearInterval(stepTimerInterval);
            stepTimerInterval = null;
        }
        localStorage.removeItem('activeStepTimer');

        const checkboxes = document.querySelectorAll('.step-checkbox');
        const targetCheckbox = checkboxes.item(stepIndex);
        if (targetCheckbox) {
            targetCheckbox.checked = true;
            targetCheckbox.disabled = true;
        }

        const stepCards = document.querySelectorAll('.step-card');
        const currentCard = stepCards.item(stepIndex);
        if (currentCard) {
            currentCard.classList.add('opacity-40', 'bg-app-primary/5');
            currentCard.classList.remove('border-app-brand');
        }

        window.showToast("Brouwstap succesvol gevalideerd en gemarkeerd als voltooid.", "success");

    } catch (error) {
        window.logSystemError(error, 'brewing.js: completeStep', 'ERROR');
        window.showToast("Fout bij het registreren van de voltooide brouwstap.", "error");
    }
};

window.finalizeBrewDay1 = async function() {
    if (tempState.activeBrewId) {
        await window.updateBrewLog(tempState.activeBrewId, 'brew-day-content');
    }
    
    renderBrewDay2();
    switchSubView('brew-day-2', 'brewing-main-view');
    
    tempState.activeBrewId = null;
    
    if (state.userSettings) {
        state.userSettings.currentBrewDay = { brewId: null };
        if (window.saveUserSettings) window.saveUserSettings();
    }
    
    renderBrewDay('none');
}

window.toggleSecondaryStep = async function(brewId, stepKey) {
    try {
        const brew = state.brews.find(b => b.id === brewId);
        if (!brew) return;
        if (!brew.checklist) brew.checklist = {};

        const stepObj = (brew.secondarySteps || []).at(parseInt(stepKey.replace('sec-step-', '')));
        const isSorbateStep = stepKey.includes('sorbate') || (stepObj && (stepObj.title.toLowerCase().includes('sorbat') || stepObj.description.toLowerCase().includes('sorbat')));
        
        if (isSorbateStep && !brew.checklist[stepKey]) {
            const currentPh = parseFloat(brew.logData?.actualFG_pH || brew.logData?.pH || 0);
            if (currentPh > 3.8) {
                window.showToast("⚠️ DANGER: pH > 3.8 detected. High risk of Geranium Taint spoilage if potassium sorbate is added without verified free SO2 equilibrium!", "error", 8000);
                window.logSystemError(`Geranium Taint warning description: batch ${brew.recipeName} (pH: ${currentPh})`, 'Mead Medic: Safety Check', 'WARNING');
            }
        }

        brew.checklist[stepKey] = !brew.checklist[stepKey];

        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), {
            checklist: brew.checklist
        });

        renderBrewDay2();
    } catch (error) {
        window.logSystemError(error, 'brewing.js: toggleSecondaryStep', 'ERROR');
        showToast("Clouddatabase commit execution failure.", "error");
    }
};

window.resetBrewDay = async function() {
    if (!confirm("Reset all progress for this day?")) return;
    const brewId = tempState.activeBrewId;
    const brew = state.brews.find(b => b.id === brewId);
    if(brew) {
        brew.checklist = {};
        if (stepTimerInterval) clearInterval(stepTimerInterval);
        
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { checklist: {} });
        renderBrewDay(brewId);
    }
}

window.finishPrimaryManual = async function(brewId) {
    if (!confirm("Confirm operation: Primary fermentation phase complete? Relocating vessel to secondary maturation.")) return;
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { primaryComplete: true });
        const brew = state.brews.find(b => b.id === brewId);
        if(brew) brew.primaryComplete = true;
        
        showToast("Moved to Secondary!", "success");
        switchSubView('brew-day-2', 'brewing-main-view');
        tempState.activeBrewId = null;
        renderBrewDay2();
        renderBrewDay('none');
    } catch (error) { 
        window.logSystemError(error, 'Primary Process Transition Stage', 'ERROR'); 
        window.showToast("Transition sequence anomaly: Unable to commit stage changes to database.", "error"); 
    }
};

async function markPrimaryAsComplete(brewId) {
    if (!state.userId || !brewId) return;
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { primaryComplete: true });
        
        const idx = state.brews.findIndex(b => b.id === brewId);
        if (idx > -1) {
            state.brews.at(idx).primaryComplete = true;
        }
    } catch (error) { 
        window.logSystemError(error, 'brewing.js -> markPrimaryAsComplete', 'CRITICAL');
        window.showToast("Failed to update process transition status in database.", "error");
    }
}

async function loadHistory() {
    if (!state.userId) return;
    
    const q = query(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews'));
    
    onSnapshot(q, (snapshot) => {
        state.brews = snapshot.docs.map(doc => {
            let b = { id: doc.id, ...doc.data() };
            
            if (!b.logData) b.logData = {};
            
            const oldFields = ['actualOG', 'actualFG', 'targetOG', 'targetFG', 'targetABV', 'finalABV', 'brewDate', 'agingNotes', 'tastingNotes', 'recipeName'];
            oldFields.forEach(field => {
                if (b[field] !== undefined && b.logData[field] === undefined) {
                    b.logData[field] = b[field];
                }
            });
            return b;
        });

        tempState.historyLoaded = true;

        state.brews.sort((a, b) => {
            const dateA = a.createdAt ? a.createdAt.toDate() : new Date(0);
            const dateB = b.createdAt ? b.createdAt.toDate() : new Date(0);
            return dateB - dateA;
        });

        renderHistoryList();

        if (typeof window.populateSocialRecipeDropdown === 'function') window.populateSocialRecipeDropdown();
        if (typeof window.populateLabelRecipeDropdown === 'function') window.populateLabelRecipeDropdown();
        if (typeof window.updateDashboardStats === 'function') window.updateDashboardStats();
        if (typeof updateCostAnalysis === 'function') updateCostAnalysis();
        if (typeof renderActiveBrewTimeline === 'function') renderActiveBrewTimeline();

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

export function parseIngredientsFromMarkdown(markdown) {
    let ingredients = [];
    if (!markdown) return ingredients;

    const jsonRegex = /(?:```json\s*)?(\[\s*\{[\s\S]*?\}\s*\])(?:\s*```)?/;
    const jsonMatch = markdown.match(jsonRegex);

    if (jsonMatch && jsonMatch.at(1)) {
        try {
            let safeJson = jsonMatch.at(1).replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            const arr = JSON.parse(safeJson);
            return arr.map(i => ({ 
                name: (i.ingredient || '').trim(), 
                quantity: parseFloat(i.quantity) || 0, 
                unit: (i.unit || '').trim() 
            }));
        } catch (e) { 
            window.logSystemError(e, 'Recipe Parser: JSON Structural Extraction', 'WARNING');
        }
    }

    const lines = markdown.split('\n');
    let insideTable = false;

    for (let i = 0; i < lines.length; i++) {
        try {
            let line = lines.at(i);
            if (line.includes('|---')) { insideTable = true; continue; }
            
            if (insideTable && line.trim().startsWith('|')) {
                const cols = line.split('|').map(c => c.trim()).filter(c => c);
                if (cols.length >= 2) {
                    if (cols.at(0).toLowerCase().includes('ingredient')) continue;
                    ingredients.push({
                        name: cols.at(0), 
                        quantity: parseFloat(cols.at(1)) || 0, 
                        unit: cols.at(2) || ''
                    });
                }
            } else if (insideTable && line.trim() === '') {
                insideTable = false;
            }
        } catch (tableError) {
            window.logSystemError(tableError, 'Recipe Table Markdown Serialization Analysis', 'ERROR');
        }
    }

    if (ingredients.length === 0) {
        const listRegex = /^[-*]\s+(\d+[.,]?\d*)\s*([a-zA-Z]+)\s+(.*)$/gm;
        let match;
        while ((match = listRegex.exec(markdown)) !== null) {
            ingredients.push({
                quantity: parseFloat(match.at(1)),
                unit: match.at(2),
                name: match.at(3)
            });
        }
    }

    return ingredients;
}

function getActualIngredientsHtml(brew) {
    if (!brew || !brew.recipeMarkdown) return '';

    const planned = parseIngredientsFromMarkdown(brew.recipeMarkdown);
    const actuals = brew.logData?.actualIngredients || [];
    
    if (planned.length === 0) return '';

    const rows = planned.map(p => {
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

            return {
                date: inputs.item(0).value,
                temp: inputs.item(1).value.replace(',', '.'),
                sg: inputs.item(2).value.replace(',', '.'),
                ph: inputs.item(3).value.replace(',', '.'),
                notes: inputs.item(4).value
            };
        }).filter(e => e && e.sg);

        if (fermentationLog.length > 0) {
            const lastEntry = fermentationLog.at(fermentationLog.length - 1);
            const fgField = document.getElementById(`actualFG-${idSuffix}`);
            const abvField = document.getElementById(`finalABV-${idSuffix}`);
            
            if (fgField) {
                fgField.value = lastEntry.sg;
                
                const hasLimitError = abvField && abvField.value === "LIMIT ERR";
                if (!tempState.isCalculatingABV && !hasLimitError) {
                    window.autoCalculateABV(null, idSuffix);
                }
            }
        }

        if (brew) {
            if (!brew.logData) brew.logData = {};
            brew.logData.fermentationLog = fermentationLog;
            if (brew.logData.brewDate && typeof brew.logData.brewDate === 'string') {
                brew.logData.brewDate = brew.logData.brewDate.split('T').at(0);
            }
        }
    } catch (error) {
        window.logSystemError(error, 'brewing.js: syncLogToFinal', 'ERROR');
    }
};

window.showBrewDetail = function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) return;

    switchMainView('brewing');
    switchSubView('history', 'brewing-main-view');

    let processedMarkdown = brew.recipeMarkdown || "";
    processedMarkdown = formatRecipeMarkdown(processedMarkdown);
    const cleanMarkdown = processedMarkdown.replace(/\[d:[\d:]+\]/g, '').replace(/^#\s.*$/m, '');
    const recipeHtml = marked.parse(cleanMarkdown);

    const targets = parseRecipeData(brew.recipeMarkdown);
    const logData = brew.logData || {};
    
    let flavorHtml = '';
    const hasFlavorData = brew.flavorProfile && (brew.flavorProfile.sweetness !== undefined || brew.flavorProfile.body_mouthfeel !== undefined);

    if (hasFlavorData) {
        flavorHtml = `<div id="flavor-wheel-container-${brew.id}" class="h-64 flex items-center justify-center"><canvas id="flavorChart-${brew.id}"></canvas></div>`;
    } else {
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

    let logHtml = getBrewLogHtml(logData, brew.id);
    logHtml += getActualIngredientsHtml(brew);

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

    renderFermentationGraph(brew.id);
    
    if (hasFlavorData) {
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

function getLogDataFromDOM(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return {};
    
    const section = container.querySelector('.brew-log-section');
    const suffix = section ? section.dataset.id : '';

    const actualsTable = container.querySelector('table[id^="actualsTable-"]');
    let actualIngredients = [];
    
    if (actualsTable) {
        const rows = Array.from(actualsTable.querySelectorAll('tbody tr'));
        actualIngredients = rows.map(r => {
            const inputElement = r.querySelector('input');
            const sanitizedValue = inputElement ? inputElement.value.replace(',', '.') : '0';
            return {
                name: r.dataset.name,
                actualQty: sanitizedValue
            };
        });
    }

    return {
        actualIngredients: actualIngredients
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

            const rawPH = inputs.item(3).value.replace(',', '.');
            const pH = parseFloat(rawPH);

            return { 
                date: inputs.item(0).value, 
                temp: inputs.item(1).value.replace(',', '.'), 
                sg: inputs.item(2).value.replace(',', '.'), 
                ph: (!isNaN(pH) && pH > 0) ? rawPH : '',
                notes: inputs.item(4).value 
            };
        }).filter(x => x && (x.date || x.sg));

        const blendRows = Array.from(container.querySelectorAll(`#blendingTable-${suffix} tbody tr`));
        const blendingLog = blendRows.map(r => {
            const inputs = r.querySelectorAll('input');
            if(inputs.length < 4) return null;
            return { 
                date: inputs.item(0).value, 
                name: inputs.item(1).value, 
                vol: inputs.item(2).value.replace(',', '.'), 
                abv: inputs.item(3).value.replace(',', '.') 
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
            if(idx > -1) state.brews.at(idx).logData = merged;
            
            showToast("Log saved successfully!", "success");
            if (typeof renderFermentationGraph === 'function') renderFermentationGraph(brewId);
        }
    } catch(e) { 
        window.logSystemError(e, 'Fermentation Logging Operations', 'ERROR');
        showToast("Log persistence transaction aborted.", "error"); 
    } finally { 
        if(btn) { btn.disabled = false; btn.innerText = originalText; } 
    }
};

function parseIngredientsAndCalculateCost(markdown, inventoryList, batchSize) {
    let totalCost = 0;
    const warnings = []; 
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

window.recalculateBatchCost = async function(brewId) {
    const brew = state.brews.find(b => b.id === brewId); 
    if (!brew) return;
    
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
            brew.totalCost = costResult.cost;
            
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

window.showTitleEditor = (id) => { document.getElementById(`title-display-${id}`).classList.add('hidden'); document.getElementById(`title-editor-${id}`).classList.remove('hidden'); };
window.hideTitleEditor = (id) => { document.getElementById(`title-display-${id}`).classList.remove('hidden'); document.getElementById(`title-editor-${id}`).classList.add('hidden'); };

window.saveNewTitle = async (id) => {
    const val = document.getElementById(`title-input-${id}`).value;
    if(val) { 
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', id), { 
            recipeName: val,
            "logData.recipeName": val
        }); 
        window.hideTitleEditor(id); 
        const b = state.brews.find(x => x.id === id); if(b) b.recipeName = val;
        const titleHeader = document.querySelector(`#title-display-${id} h2`);
        if(titleHeader) titleHeader.textContent = val;
        renderHistoryList();
    }
};

window.deleteBrew = async function(brewId) {
    if (!state.userId) return;
    if (!confirm("Are you sure? This cannot be undone.")) return;

    try {
        await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId));

        if (tempState.activeBrewId === brewId) {
            console.log("Active batch deleted. Resetting UI.");
            
            if (typeof stepTimerInterval !== 'undefined' && stepTimerInterval) {
                clearInterval(stepTimerInterval);
            }
            localStorage.removeItem('activeBrewDayTimer');
            
            tempState.activeBrewId = null;
            if(state.userSettings) {
                state.userSettings.currentBrewDay = { brewId: null };
                if (window.saveUserSettings) window.saveUserSettings();
            }

            if (typeof renderBrewDay === 'function') renderBrewDay('none');
        }

        showToast("Brew deleted.", "success");
        window.goBackToHistoryList();

    } catch (error) { 
        window.logSystemError(error, 'brewing.js: deleteBrew', 'ERROR'); 
        showToast("Fout bij het verwijderen van de brouwbatch.", "error"); 
    }
};

async function cloneTopUntappdBeer() {
    console.log("📸 AI Vision Network Gateway: Initializing Gemini Vision Pipeline with Zymological Math...");
    
    if (typeof window.showLoader === 'function') {
        window.showLoader(true);
    }

    try {
        const apiKey = state.userSettings?.apiKey || (typeof CONFIG !== 'undefined' ? CONFIG.firebase?.apiKey : null);
        if (!apiKey) {
            if (window.showToast) {
                window.showToast("Fout: Geen geldige Google Gemini API-key gevonden in instellingen.", "error");
            }
            if (typeof window.showLoader === 'function') window.showLoader(false);
            return;
        }

        const activeModel = state.userSettings?.aiModel || state.userSettings?.chatModel || "gemini-2.0-flash";

        const base64Image = state.tempState?.untappdScreenshotBase64;
        if (!base64Image) {
            if (window.showToast) {
                window.showToast("Fout: Geen Untappd screenshot data gevonden in het actieve brouwgeheugen.", "error");
            }
            if (typeof window.showLoader === 'function') window.showLoader(false);
            return;
        }

        const gatewayUrl = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${apiKey}`;

        const structuredSystemPrompt = "Extract data from this Untappd beer screenshot. Return ONLY a valid, minified JSON object containing: { \"beer_name\": \"string\", \"style\": \"string\", \"abv\": number, \"ibu\": number, \"flavor_profile\": [\"strings\"] }. Do not include any markdown backticks, markdown code blocks, explanatory text or trailing characters. Ensure proper data types.";

        const payload = {
            contents: [
                {
                    parts: [
                        {
                            text: structuredSystemPrompt
                        },
                        {
                            inline_data: {
                                mime_type: "image/jpeg",
                                data: base64Image
                            }
                        }
                    ]
                }
            ]
        };

        const response = await fetch(gatewayUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Gemini Vision Gateway HTTP Error! Status: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        if (!data.candidates || data.candidates.length === 0) {
            throw new Error("Geen candidates geretourneerd door de Gemini AI Vision-engine.");
        }

        const candidateZero = data.candidates.at(0);
        if (!candidateZero || !candidateZero.content || !candidateZero.content.parts) {
            throw new Error("Malformed payload structure binnen candidate(0).");
        }

        const partZero = candidateZero.content.parts.at(0);
        if (!partZero || !partZero.text) {
            throw new Error("Tekstuele response part ontbreekt in het AI Vision resultaat.");
        }

        let cleanJsonText = partZero.text.trim();
        
        if (cleanJsonText.startsWith("```json")) {
            cleanJsonText = cleanJsonText.replace("```json", "");
            if (cleanJsonText.endsWith("```")) {
                cleanJsonText = cleanJsonText.substring(0, cleanJsonText.length - 3);
            }
        } else if (cleanJsonText.startsWith("```")) {
            cleanJsonText = cleanJsonText.replace("```", "");
            if (cleanJsonText.endsWith("```")) {
                cleanJsonText = cleanJsonText.substring(0, cleanJsonText.length - 3);
            }
        }
        cleanJsonText = cleanJsonText.trim();

        const parsedBeerData = JSON.parse(cleanJsonText);
        const beerName = parsedBeerData.beer_name || "Unknown Untappd Beer";
        const beerStyle = parsedBeerData.style || "Traditional Mead";
        const rawAbvStr = String(parsedBeerData.abv || "0.0").replace(/,/g, '.');
        const beerAbv = parseFloat(rawAbvStr) || 0.0;
        const beerIbu = parseInt(parsedBeerData.ibu) || 0;
        const beerFlavorProfile = parsedBeerData.flavor_profile || [];
        const abw = beerAbv * 0.794;
        const ogTheoretisch = ((1.775 * abw) + 57.06) / (57.06 + abw);

        if (ogTheoretisch >= 1.775) {
            if (window.logSystemError) {
                window.logSystemError(`Kritieke overschrijding Hall Equation Input: ogTheoretisch ${ogTheoretisch} overgrijpt de absolute limiet van 1.775.`, "Zymology: Hall Equation Interlock", "FATAL");
            }
            if (window.showToast) {
                window.showToast("Brouw-safeguard: Berekende startdichtheid schendt de fysieke limiet van de Hall-vergelijking. Executie afgebroken.", "error");
            }
            if (typeof window.showLoader === 'function') window.showLoader(false);
            return;
        }

        const batchSizeElement = document.getElementById('batchSize');
        const batchSize = batchSizeElement ? (parseFloat(batchSizeElement.value) || 5.0) : 5.0;
        const gpTotal = (ogTheoretisch - 1.000) * 1000 * batchSize;
        const xMalt = 0.40;
        const gpMalt = gpTotal * xMalt;
        const gpHoney = gpTotal - gpMalt;
        const honeyKg = gpHoney / 290; 
        const maltKg = gpMalt / 375;
        const fgEst = ogTheoretisch - ((ogTheoretisch - 1.000) * 0.75);
        const phiBraggot = 1.0 + (0.45 * (1.0 - xMalt));
        const correctedIbu = beerIbu / phiBraggot;

        let nutrientInstruction = "";
        if (ogTheoretisch <= 1.045) {
            nutrientInstruction = "\n\n⚠️ NUTRIENT PHASE-BLOCK BLOCKADE: Dit recept betreft een lichte sessiemede of braggot. Het is wettelijk verplicht om anorganische stikstofbronnen (DAP) na de 1/3 suikerbreuk of bij het overschrijden van de 9% ABV toxiciteitsgrens wiskundig op nul te zetten om reststikstof-offflavors te voorkomen.";
        }

        if (!state.tempState) state.tempState = {};
        state.tempState.clonedUntappdBeer = {
            beer_name: beerName,
            style: beerStyle,
            abv: beerAbv,
            ibu: beerIbu,
            flavor_profile: beerFlavorProfile,
            abw: abw,
            ogTheoretisch: ogTheoretisch,
            fgEst: fgEst,
            gpTotal: gpTotal,
            honeyKg: honeyKg,
            maltKg: maltKg,
            phiBraggot: phiBraggot,
            correctedIbu: correctedIbu
        };

        const targetStyleInput = document.getElementById('style');
        const targetAbvInput = document.getElementById('abv');
        const customDescriptionInput = document.getElementById('customDescription');

        if (targetStyleInput) {
            targetStyleInput.value = beerStyle;
            if (typeof window.handleStyleChange === 'function') {
                window.handleStyleChange();
            }
        }

        if (targetAbvInput) {
            targetAbvInput.value = beerAbv.toFixed(2);
        }

        if (customDescriptionInput) {
            customDescriptionInput.value = `Cloned via Untappd Screenshot Vision Netwerk-Gateway. Original Beer: ${beerName}. Smaakprofiel: ${beerFlavorProfile.join(', ')}. Wiskundige herleiding: berekende OG ${ogTheoretisch.toFixed(3)}, geschatte FG ${fgEst.toFixed(3)}. Vereist: ${honeyKg.toFixed(2)}kg honing en ${maltKg.toFixed(2)}kg DME.${nutrientInstruction}`;
            if (typeof window.handleDescriptionInput === 'function') {
                window.handleDescriptionInput();
            }
        }

        if (window.showToast) {
            window.showToast(`Zymologische wiskunde sluitend! OG: ${ogTheoretisch.toFixed(3)}. Starten van receptgeneratie...`, "success");
        }

        if (typeof window.generateRecipe === 'function') {
            await window.generateRecipe();
        } else {
            throw new Error("window.generateRecipe is niet beschikbaar in de globale scope.");
        }

    } catch (error) {
        if (window.logSystemError) {
            window.logSystemError(error, "brewing.js: async function cloneTopUntappdBeer (Fase 14.3)", "FATAL");
        }
        if (window.showToast) {
            window.showToast(`Zymologische Wiskunde Gateway Crash: ${error.message}`, "error");
        }
    } finally {
        if (typeof window.showLoader === 'function') {
            window.showLoader(false);
        }
    }
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
        window.logSystemError(error, 'brewing.js -> saveBrewToHistory', 'ERROR');
        showToast("Could not save recipe to history.", "error");
    }
};

window.runAgingAnalysis = async function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) return;

    try {
        const todayStamp = new Date().toISOString().split('T').at(0);
        const bottledStamp = brew.logData?.bottlingDate ? brew.logData.bottlingDate.split('T').at(0) : 'Not yet';

        const prompt = `Analyze aging potential:
        Batch: ${brew.recipeName}
        ABV: ${brew.logData?.finalABV || 'unknown'}
        Current SG: ${brew.logData?.actualFG || 'unknown'}
        TODAY: ${todayStamp}
        BOTTLED: ${bottledStamp}
        
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
        window.showToast("Het initialiseren van de fermentatie-grafiek is gestagneerd.", "error");
    }
}

window.syncLogToFinal = syncLogToFinal;

function getBrewLogHtml(brew, idSuffix = null) {
    try {
        const suffix = idSuffix || brew.id;
        const logData = brew.logData || {};
        const fermentationLog = logData.fermentationLog || [];
        const labelBase = "text-[11px] font-semibold text-on-surface-variant/80 uppercase tracking-wider mb-1.5 block ml-1";
        const inputBase = "bg-surface-container-highest border border-outline-variant text-sm rounded-xl focus:ring-2 focus:ring-primary focus:border-transparent transition-all !p-3 !h-11 w-full text-on-surface font-medium";
        const entriesHtml = fermentationLog.map((entry) => {
            return `
                <div class="log-entry bg-surface-container-low p-5 rounded-2xl shadow-sm border border-outline-variant/10 mb-4 shadow-sm relative animate-fade-in">
                    <div class="flex justify-between items-center mb-4">
                        <span class="text-xs font-bold text-primary bg-primary-container text-on-primary-container px-2.5 py-1 rounded-full border border-primary/10 font-mono">Measurement Logs</span>
                        <button onclick="this.closest('.log-entry').remove(); window.syncLogToFinal('${suffix}')" 
                                class="text-on-surface-variant hover:text-error hover:bg-error-container/20 p-2.5 rounded-xl transition-all duration-200 min-w-[44px] min-h-[44px] flex items-center justify-center cursor-pointer" 
                                title="Delete Entry">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                            </svg>
                        </button>
                    </div>
                    
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                        <div class="flex flex-col">
                            <label class="${labelBase}">Date</label>
                            <input type="date" value="${entry.date || ''}" class="${inputBase}">
                        </div>
                        <div class="flex flex-col">
                            <label class="${labelBase}">Temp (°C)</label>
                            <input type="number" step="0.5" class="${inputBase} text-center font-mono font-bold text-primary temp-input" value="${entry.temp || ''}" placeholder="20" oninput="window.autoCalculateABV(event, '${suffix}')" onchange="window.autoCalculateABV(event, '${suffix}')">
                        </div>
                        <div class="flex flex-col">
                            <label class="${labelBase}">Gravity (SG/Brix)</label>
                            <input type="number" step="0.001" class="${inputBase} text-center font-mono font-bold text-primary sg-input" value="${entry.sg || ''}" placeholder="1.xxx" oninput="this.value = this.value.replace(',', '.'); window.autoCalculateABV(event, '${suffix}')" onchange="window.autoCalculateABV(event, '${suffix}')">
                        </div>
                    </div>
                    
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div class="flex flex-col md:col-span-1">
                            <label class="${labelBase}">pH Level</label>
                            <input type="number" step="0.01" class="${inputBase} text-primary font-bold" value="${entry.ph || ''}" placeholder="3.x" oninput="this.value = this.value.replace(',', '.'); window.syncLogToFinal('${suffix}')" onchange="window.autoCalculateABV(event, '${suffix}')">
                        </div>
                        <div class="flex flex-col md:col-span-2">
                            <label class="${labelBase}">Measurement Notes</label>
                            <input type="text" class="${inputBase} italic text-on-surface-variant" value="${entry.notes || ''}" placeholder="Describe bubbles, clarification, aromas...">
                        </div>
                    </div>
                </div>`;
        }).join('');

        return `
            <div class="brew-log-section mt-8 pt-6 border-t border-outline-variant/30 text-on-surface" data-id="${suffix}">
                <div class="flex flex-col md:flex-row justify-between items-center gap-4 mb-6">
                    <h3 class="text-xl font-header font-bold text-primary uppercase tracking-wider">Fermentation Logbook</h3>
                    
                    <div class="flex flex-row items-center gap-2 bg-surface-container-low p-2 rounded-2xl border border-outline-variant/40 shadow-sm w-full md:w-auto justify-center">
                        <div class="flex flex-col items-center px-3 border-r border-outline-variant/50">
                            <label for="actualOG-${suffix}" class="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider mb-0.5">Original OG</label>
                            <input type="number" step="0.001" id="actualOG-${suffix}" class="w-20 p-1 bg-surface border border-outline-variant rounded-lg text-center font-mono text-xs font-bold text-on-surface focus:ring-2 focus:ring-primary focus:border-transparent" placeholder="OG" value="${logData.actualOG || ''}" oninput="this.value = this.value.replace(',', '.'); window.autoCalculateABV(event, '${suffix}')" onchange="window.autoCalculateABV(event, '${suffix}')">
                        </div>
                        <div class="flex flex-col items-center px-3 border-r border-outline-variant/50">
                            <label for="actualFG-${suffix}" class="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider mb-0.5">Current FG</label>
                            <input type="number" step="0.001" id="actualFG-${suffix}" class="w-20 p-1 bg-surface border border-outline-variant rounded-lg text-center font-mono text-xs font-bold text-on-surface focus:ring-2 focus:ring-primary focus:border-transparent" placeholder="FG" value="${logData.actualFG || ''}" oninput="this.value = this.value.replace(',', '.'); window.autoCalculateABV(event, '${suffix}')" onchange="window.autoCalculateABV(event, '${suffix}')">
                        </div>
                        <div class="flex flex-col items-center px-3">
                            <label for="finalABV-${suffix}" class="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider mb-0.5">Alcohol ABV</label>
                            <input type="text" id="finalABV-${suffix}" class="w-16 p-1 bg-primary-container text-on-primary-container rounded-lg text-center font-mono text-xs font-bold border border-primary/10" placeholder="ABV%" value="${logData.finalABV || ''}" readonly>
                        </div>
                    </div>
                </div>
                
                <div id="fermentationContainer-${suffix}" class="space-y-3">${entriesHtml}</div>
                
                <button onclick="window.addLogLine('${suffix}')" class="w-full mt-4 bg-surface-container border border-outline hover:border-primary hover:bg-surface-container-high text-on-surface py-3.5 rounded-2xl font-bold text-sm transition-all duration-200 shadow-sm uppercase tracking-widest min-h-[48px] flex items-center justify-center gap-2">
                    <svg class="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4v16m8-8H4"></path>
                    </svg>
                    Add Measurement Entry
                </button>
                
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
                    <div class="card p-4 bg-surface-container-low border border-outline-variant/40 rounded-2xl shadow-sm">
                        <label for="agingNotes-${suffix}" class="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider block mb-1.5 ml-1">Aging & Racking Notes</label>
                        <textarea id="agingNotes-${suffix}" rows="3" class="w-full p-2 text-xs bg-transparent border border-outline-variant/30 rounded-xl focus:ring-2 focus:ring-primary focus:border-transparent text-on-surface" placeholder="Describe clarity, racking events, oak additions...">${logData.agingNotes || ''}</textarea>
                    </div>
                    <div class="card p-4 bg-surface-container-low border border-outline-variant/40 rounded-2xl shadow-sm">
                        <label for="tastingNotes-${suffix}" class="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider block mb-1.5 ml-1">Final Tasting Notes</label>
                        <textarea id="tastingNotes-${suffix}" rows="3" class="w-full p-2 text-xs bg-transparent border border-outline-variant/30 rounded-xl focus:ring-2 focus:ring-primary focus:border-transparent text-on-surface" placeholder="Flavor evolution, perceived sweetness, tannin structure, mouthfeel, fruit/hop integration...">${logData.tastingNotes || ''}</textarea>
                    </div>
                </div>
            </div>`;
    } catch (error) {
        window.logSystemError(error, 'brewing.js: getBrewLogHtml', 'ERROR');
        return `<div class="p-4 bg-error-container/20 border border-error/30 rounded-xl text-xs text-error font-medium text-center">⚠️ Error building the interactive log interface.</div>`;
    }
}

function renderFlavorWheel(brewId, labels, data) {
    const container = document.getElementById(`flavor-wheel-container-${brewId}`);
    if (!container) return;

    container.innerHTML = `<canvas id="flavorChart-${brewId}"></canvas>`;
    const ctx = document.getElementById(`flavorChart-${brewId}`);
    const cPrimary = `rgb(${window.getThemeColor('--md-sys-color-primary')})`;
    const cOnSurface = `rgb(${window.getThemeColor('--md-sys-color-on-surface')})`;
    const cOutline = `rgb(${window.getThemeColor('--md-sys-color-outline-variant')})`;
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
        tempState.isCalculatingABV = true;

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

            let finalOG = correctedOG;
            let finalFG = correctedFG;

            if (ogInput > 1.2 || fgInput > 1.2) {
                const getRI = (val) => val > 1.2 ? (val / WCF) : (((182.9622 * Math.pow(val, 3)) - (777.3009 * Math.pow(val, 2)) + (1264.5170 * val) - 670.1831) / WCF);
                
                const RI_i = getRI(correctedOG);
                const RI_f = getRI(correctedFG);
                
                finalOG = (0.0000000578503 * Math.pow(RI_i, 3)) + (0.0000127414 * Math.pow(RI_i, 2)) + (0.00384577 * RI_i) + 1.0000;
                finalFG = 1.0 - (0.002349 * RI_i) + (0.006276 * RI_f);
            }

            if (finalOG >= 1.775 || finalOG <= 1.000) {
                window.showToast("Critical system conflict: Transmuted Original Gravity value breaches the density thresholds.", "error");
                abvField.value = "LIMIT ERR";
                if (event) {
                    window.syncLogToFinal(idSuffix);
                }
                tempState.isCalculatingABV = false;
                return;
            }

            if (finalFG > finalOG) {
                window.showToast("Critical system conflict: Negative attenuation detected. Data alignment is inconsistent.", "error");
                abvField.value = "LIMIT ERR";
                if (event) {
                    window.syncLogToFinal(idSuffix);
                }
                tempState.isCalculatingABV = false;
                return;
            }

            if (finalFG < 0.794) {
                window.showToast("Critical system conflict: Final Gravity falls below physical limits of ethanol.", "error");
                abvField.value = "LIMIT ERR";
                if (event) {
                    window.syncLogToFinal(idSuffix);
                }
                tempState.isCalculatingABV = false;
                return;
            }
            
            const abw = (76.08 * (finalOG - finalFG)) / (1.775 - finalOG);
            const abv = abw / 0.794; 
            abvField.value = abv.toFixed(2) + "%";
        } else {
            if (abvField) {
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

        tempState.isCalculatingABV = false;
        
        if (event) {
            window.syncLogToFinal(idSuffix);
        }
    } catch (error) {
        tempState.isCalculatingABV = false;
        window.logSystemError(error, 'Automated Fermentation Metrics Extrapolation', 'ERROR');
    }
};

async function getWaterAdvice() {
    const profileSelect = document.getElementById('meadTargetProfile');
    const targetProfile = profileSelect && profileSelect.selectedOptions && profileSelect.selectedOptions.length > 0
        ? profileSelect.selectedOptions.item(0).text
        : "Balanced Mead";
    const batchSize = document.getElementById('batchSize')?.value || 5;
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
    const ogInput = document.getElementById('starterOG');
    const dateInput = document.getElementById('yeastDate');
    const typeInput = document.getElementById('yeastType');
    const adviceOutput = document.getElementById('yeast-advice-output');

    if (!adviceOutput) {
        console.warn("Yeast advice output container missing.");
        return;
    }

    if (!ogInput || !dateInput) {
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

window.addBlendingRow = function(idSuffix) {
    try {
        const tbody = document.querySelector(`#blendingTable-${idSuffix} tbody`);
        if(!tbody) return;
        const today = new Date().toISOString().split('T');
        const tr = document.createElement('tr');

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

        let startVolume = parseFloat(String(currentVolInput?.value || fallbackVol).replace(/,/g, '.')) || fallbackVol;
        
        const ogInputStr = document.getElementById(`actualOG-${idSuffix}`)?.value.replace(/,/g, '.') || "";
        const fgInputStr = document.getElementById(`actualFG-${idSuffix}`)?.value.replace(/,/g, '.') || "";
        const ogVal = parseFloat(ogInputStr);
        const fgVal = parseFloat(fgInputStr);
        
        if (!isNaN(ogVal) && !isNaN(fgVal)) {
            if (ogVal >= 1.775) {
                if (finalABVField) {
                    finalABVField.value = "LIMIT ERR";
                    finalABVField.classList.add('text-error');
                }
                window.logSystemError(`Hall Limit Error in Blending: OG ${ogVal}`, 'ABV Calc', 'WARNING');
                return; 
            }

            if (ogVal > fgVal) {
                const abw = (76.08 * (ogVal - fgVal)) / (1.775 - ogVal);
                baseABV = abw / 0.794;
            }
        }

        let totalAlcVolume = startVolume * (baseABV / 100);
        let totalLiquidVolume = startVolume;

        const rows = document.querySelectorAll(`#blendingTable-${idSuffix} tbody tr`);
        rows.forEach(row => {
            const inputs = row.querySelectorAll('input');
            const vol = parseFloat(String(inputs.item(2)?.value || "0").replace(/,/g, '.')) || 0;
            const abv = parseFloat(String(inputs.item(3)?.value || "0").replace(/,/g, '.')) || 0;
            
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
        window.logSystemError(error, 'brewing.js: window.recalcTotalABV Anomaly', 'ERROR');
        window.showToast("De blending volumetrische ABV extrapolatie is mislukt.", "error");
    }
};

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

window.showLastPrompt = function() {
    if(!lastGeneratedPrompt) {
        showToast("No prompt in memory.", "info");
        return;
    }
    window.showPromptModal(lastGeneratedPrompt);
}

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
        
        tempState.activeBrewId = null;
        if (state.userSettings) state.userSettings.currentBrewDay = { brewId: null };
        
        showToast(`History cleared (${snapshot.size} items).`, "success");
        window.renderBrewDay('none');
    } catch (error) {
        window.logSystemError(error, 'History: ClearAll', 'ERROR');
        showToast("Clear failed.", "error");
    }
}

function initializeBrewDayState(brewId, steps) {
    const savedTimer = localStorage.getItem('activeBrewDayTimer');
    if (savedTimer) {
        const { brewId: savedId, stepIndex, endTime } = JSON.parse(savedTimer);
        
        if (savedId === brewId) {
            const now = Date.now();
            if (endTime > now) {
                const remaining = Math.round((endTime - now) / 1000);
                window.startStepTimer(brewId, stepIndex, remaining);
            } else {
                localStorage.removeItem('activeBrewDayTimer');
            }
        }
    }
}

window.freeformTweakRecipe = async function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) return;

    const requestInput = document.getElementById(`tweak-request-${brewId}`);
    const outputDiv = document.getElementById(`tweak-output-${brewId}`);
    const request = requestInput.value.trim();

    if (!request) { showToast("Please describe your tweak.", "error"); return; }

    outputDiv.innerHTML = getLoaderHtml("Master Mazer is rewriting...");
    
    const prompt = `You are a Mead Expert. Refactor this existing recipe based on user feedback.
    
    ORIGINAL RECIPE:
    ${brew.recipeMarkdown}
    
    USER TWEAK REQUEST:
    "${request}"
    
    OUTPUT:
    Full Markdown recipe. Start with # Title. Re-calculate everything.`;

    try {
        const result = await performApiCall(prompt);
        outputDiv.innerHTML = `<div class="p-4 bg-app-tertiary rounded border border-app-brand/20 prose dark:prose-invert text-sm max-w-none">${marked.parse(result)}</div>
        <button onclick="window.saveBrewToHistory(\`${result.replace(/`/g, '\\`')}\`, null)" class="mt-2 bg-green-600 text-white py-2 px-4 rounded btn text-xs font-bold w-full">Save as New Batch</button>`;
    } catch (error) {
        outputDiv.innerHTML = `<p class="text-red-500 text-sm">Error: ${error.message}</p>`;
    }
}

window.showBrewPrompt = function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    const text = brew?.prompt || "No prompt saved for this batch (created in older version).";
    window.showPromptModal(text);
}

window.undoStep = async function(stepIndex) {
    const brewId = tempState.activeBrewId;
    if (!brewId) return;
    
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew || !brew.checklist) return;

    if (!confirm("Do you want to reopen this step for modification?")) return;

    delete brew.checklist[`step-${stepIndex}`];

    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { 
            checklist: brew.checklist
        });
        
        renderBrewDay(brewId);
        
    } catch (e) {
        window.logSystemError(e, 'brewing.js: undoStep', 'ERROR');
        window.showToast("Failed to restore step parameters.", "error");
    }
};

window.promptNewBrewType = function() {
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
    
    modal.classList.remove('hidden');
}

window.revertToPrimary = async function(brewId) {
    if (!confirm("⚠️ Reverse operations? This sequence moves the target vessel execution back to Brew Day 1 (Primary phase).")) return;

    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), { 
            primaryComplete: false 
        });

        const brew = state.brews.find(b => b.id === brewId);
        if(brew) brew.primaryComplete = false;

        tempState.activeBrewId = null; 
        showToast("Batch moved back to Primary tracking!", "success");

        renderBrewDay2(); 
        
        switchSubView('brew-day-1', 'brewing-main-view');
        renderBrewDay(brewId); 

    } catch (error) {
        window.logSystemError(error, "brewing.js: revertToPrimary", "ERROR");
        showToast("Revert transition operations failed.", "error");
    }
}

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
        window.logSystemError(error, 'Flavor Profile Regeneration Matrix', 'ERROR');
        if(container) container.innerHTML = `<p class="text-error text-sm">Organoleptic analysis failed. Recalibration required.</p><button onclick="window.regenerateFlavorProfile('${brewId}')" class="btn bg-primary text-white mt-2">Retry</button>`;
    }
};

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
        if (!isNaN(currentTemp) && yeastStrain === "d47" && currentTemp > 20) {
            warnings.push("Lalvin D47 above 20°C: Risk of fusel alcohols formation.");
        }

        if (yeastStrain === "us-05") {
            const actuals = logData.actualIngredients || [];
            let yanActual = 0;
            actuals.forEach(ing => {
                const qty = parseFloat(String(ing.actualQty).replace(',', '.'));
                if (!isNaN(qty)) {
                    if (ing.name.toLowerCase().includes("fermaid o")) yanActual += (qty / batchSize) * 160;
                    if (ing.name.toLowerCase().includes("dap")) yanActual += (qty / batchSize) * 210;
                }
            });
            const og = parseFloat(String(logData.actualOG || 1.000).replace(',', '.'));
            if (!isNaN(og) && !isNaN(batchSize) && batchSize > 0) {
                const brix = ((182.9622 * Math.pow(og, 3)) - (777.3009 * Math.pow(og, 2)) + (1264.5170 * og) - 670.1831);
                const yanTarget = 10 * brix * og * 1.25; 
                if (yanActual < yanTarget && yanActual > 0) {
                    warnings.push("SafAle US-05 nitrogen deficiency: Risk of H2S (rotten sulfur) off-flavors.");
                }
            }
        }

        const ogVal = parseFloat(String(logData.actualOG || 1.000).replace(',', '.'));
        if (!isNaN(ogVal) && ogVal < 1.775 && ogVal > 1.000) {
            const fgDry = 1.000;
            const abwPot = (76.08 * (ogVal - fgDry)) / (1.775 - ogVal);
            const abvPot = abwPot / 0.794;
            if (!isNaN(abvPot)) {
                if (yeastStrain === "71b" && abvPot > 14) warnings.push("ABV exceeds the 14% tolerance limit of Lalvin 71B.");
                if ((yeastStrain === "ec-1118" || yeastStrain === "m05") && abvPot > 18) {
                    warnings.push(`ABV exceeds the 18% tolerance limit of ${yeastStrain.toUpperCase()}.`);
                }
            }
        }

        const currentPh = parseFloat(String(currentLogEntry.ph).replace(',', '.'));
        if (!isNaN(currentPh) && currentPh < 3.2 && currentPh > 0) {
            const brewDateRaw = logData.brewDate ? new Date(logData.brewDate) : null;
            if (brewDateRaw && !isNaN(brewDateRaw.getTime())) {
                const currentLogDate = currentLogEntry.date ? new Date(currentLogEntry.date) : new Date();
                const diffDays = (currentLogDate.getTime() - brewDateRaw.getTime()) / (1000 * 3600 * 24);
                if (!isNaN(diffDays) && diffDays <= 3) warnings.push("PH-CRASH (First 72h): Add 0.4 g/L K2CO3 buffer matrix.");
            } else {
                warnings.push("CRITICAL LOW pH: Add 0.4 g/L K2CO3 buffer matrix.");
            }
        }

        const notesStr = (currentLogEntry.notes || "").toLowerCase();
        const agingNotesStr = (logData.agingNotes || "").toLowerCase();
        const collectiveNotes = notesStr + " " + agingNotesStr;
        
        let detectedContactHours = 0;
        const hourMatch = collectiveNotes.match(/(\d+)\s*(hour|uur|hrs)/);
        const dayMatch = collectiveNotes.match(/(\d+)\s*(day|dag|dagen|days)/);
        
        if (dayMatch) {
            detectedContactHours = parseInt(dayMatch.at(1)) * 24;
        } else if (hourMatch) {
            detectedContactHours = parseInt(hourMatch.at(1));
        }
        
        if (!isNaN(detectedContactHours) && (detectedContactHours >= 168 || collectiveNotes.includes("dryhop 7 dagen") || collectiveNotes.includes("dryhop 8 dagen") || collectiveNotes.includes("dry-hop 7 days") || collectiveNotes.includes("dry-hop 8 days"))) {
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

window.startBrewDay = startBrewDay;
window.startActualBrewDay = startActualBrewDay;
window.renderBrewDay = renderBrewDay;
window.closePrimaryDetail = closePrimaryDetail;
window.cloneTopUntappdBeer = cloneTopUntappdBeer;
window.buildPrompt = buildPrompt;