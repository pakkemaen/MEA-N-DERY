import { db } from './firebase-init.js';
import { state } from './state.js'; 
// LET OP: Omdat 'state' dynamisch is, is het beter om overal 'state.userId' etc. te gebruiken.
// Maar omdat je code nu vol zit met 'userId', is het makkelijker om een helper te maken of 'state.' toe te voegen.
import { showToast, performApiCall, switchMainView, switchSubView, getLoaderHtml } from './utils.js';
import { collection, addDoc, query, onSnapshot, doc, updateDoc, deleteDoc, setDoc, getDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let html5QrcodeScanner = null;
let customBottles = []; // Deze ontbrak en wordt gebruikt in bottling

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

// --- INVENTORY ---
async function loadInventory() {
    if (!state.userId) return;
    const invCol = collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'inventory');
    
    onSnapshot(query(invCol), (snapshot) => {
        state.inventory = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        renderInventory();
        // Update stats elders indien functies bestaan
        if (window.updateCostAnalysis) window.updateCostAnalysis();
        if (window.updateNextActionWidget) window.updateNextActionWidget();
        if (window.updateDashboardStats) window.updateDashboardStats();
    });
}

function renderInventory() {
    const listDiv = document.getElementById('inventory-list');
    if (!listDiv) return;

    // Groepeer items
    const grouped = state.inventory.reduce((acc, item) => {
        const cat = item.category || 'Other';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(item);
        return acc;
    }, {});

    const categories = ['Honey', 'Yeast', 'Nutrient', 'Malt Extract', 'Fruit', 'Spice', 'Adjunct', 'Chemical', 'Water'];
    const currency = state.userSettings.currencySymbol || '€';
    let html = '';

    categories.forEach(category => {
        if (grouped[category]) {
            html += `<h3 class="text-lg font-header mt-6 mb-3 uppercase tracking-wider text-app-brand opacity-80 border-b border-app-brand/10 pb-1">${category}</h3>`;
            html += `<div class="grid grid-cols-1 gap-3">`; 
            
            grouped[category].forEach(item => {
                const expDateStr = item.expirationDate ? new Date(item.expirationDate).toLocaleDateString() : 'N/A';
                
                let catClass = 'cat-yeast'; 
                const c = item.category.toLowerCase();
                if(c.includes('honey')) catClass = 'cat-honey';
                if(c.includes('fruit')) catClass = 'cat-fruit';
                

html += `
<div id="item-${item.id}" class="p-4 card rounded-2xl border border-outline-variant shadow-none hover:shadow-elevation-1 transition-all bg-surface-container group relative">
    <div class="flex justify-between items-start">
        <div class="pr-4">
            <div class="font-bold text-xl text-on-surface leading-tight">${item.name}</div>
            <div class="text-xs text-on-surface-variant mt-1">Exp: ${expDateStr}</div>
        </div>
        <div class="text-right">
            <div class="inline-block bg-surface-variant/20 px-2 py-1 rounded-lg border border-outline-variant/30 mb-2">
                <div class="font-mono font-bold text-on-surface text-sm">${item.qty} <span class="text-xs font-normal text-on-surface-variant">${item.unit}</span></div>
            </div>
            <div class="text-xs text-on-surface-variant font-mono mb-3">${currency}${(item.price || 0).toFixed(2)}</div>
        </div>
    </div>
    <div class="flex justify-end gap-4 mt-2 pt-2 border-t border-outline-variant/20">
        <button onclick="window.editInventoryItem('${item.id}')" class="text-xs font-bold text-primary hover:brightness-110 uppercase tracking-wider">Edit</button>
        <button onclick="window.deleteInventoryItem('${item.id}')" class="text-xs font-bold text-error hover:brightness-110 uppercase tracking-wider">Delete</button>
    </div>
</div>`; 
            });
            html += `</div>`;
        }
    });
    
    if (state.inventory.length === 0) listDiv.innerHTML = `<div class="text-center py-12 opacity-50"><p>The Cupboard is Bare</p></div>`;
    else listDiv.innerHTML = html;
}

// --- BOTTLING & CELLAR MANAGEMENT ---

let currentBrewToBottleId = null; 

// --- TOON BOTTLING MODAL (TELEPORT FIX) ---
window.showBottlingModal = function(brewId) {
    console.log("Probeer modal te openen voor:", brewId);

    const modal = document.getElementById('bottling-modal');
    
    if (modal) {
        // STAP 1: DE "TELEPORTATIE" (CRUCIAAL)
        // We verplaatsen de modal naar de <body> tag.
        // Hierdoor heeft hij geen last meer van verborgen tabbladen.
        if (modal.parentNode !== document.body) {
            document.body.appendChild(modal);
        }

        // STAP 2: Zichtbaar maken
        modal.classList.remove('hidden');
        modal.style.display = 'flex'; // Forceer flexbox
        modal.style.zIndex = '9999';  // Bovenop alles
        
    } else {
        alert("CRITICAL ERROR: 'bottling-modal' niet gevonden in HTML!");
        return;
    }

    // STAP 3: Data laden
    try {
        currentBrewToBottleId = brewId;
        customBottles = []; 
        
        if (typeof window.renderCustomBottlesList === 'function') {
            window.renderCustomBottlesList(); 
        }

        const bottlingForm = document.getElementById('bottling-form');
        if (bottlingForm) bottlingForm.reset();
        
        const dateInput = document.getElementById('bottlingDate');
        if (dateInput) {
            const today = new Date();
            const yyyy = today.getFullYear();
            const mm = String(today.getMonth() + 1).padStart(2, '0');
            const dd = String(today.getDate()).padStart(2, '0');
            dateInput.value = `${yyyy}-${mm}-${dd}`;
        }

        // Velden leegmaken voor de zekerheid
        const peakDate = document.getElementById('peakFlavorDate');
        const peakReason = document.getElementById('peakFlavorReason');
        if(peakDate) peakDate.value = "";
        if(peakReason) peakReason.value = "";

    } catch (error) {
        console.error("Fout bij laden data in modal:", error);
    }
}

window.hideBottlingModal = function() {
    const modal = document.getElementById('bottling-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none'; // Verberg weer netjes
    }
    currentBrewToBottleId = null;
}

// Custom Bottle List Helpers
window.renderCustomBottlesList = function() {
    const listDiv = document.getElementById('custom-bottles-list');
    if (!listDiv) return;
    if (customBottles.length === 0) { listDiv.innerHTML = ''; return; }

    const currency = state.userSettings.currencySymbol || '€';
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

// --- AI ANALYSE VOOR RIJPING (V3.0) ---
window.analyzeAgingPotential = async function() {
    if (!currentBrewToBottleId) return;
    
    const brew = state.brews.find(b => b.id === currentBrewToBottleId);
    if (!brew) return;

    const btn = document.getElementById('analyze-aging-btn');
    const dateInput = document.getElementById('peakFlavorDate');
    const reasonInput = document.getElementById('peakFlavorReason');
    
    const originalText = btn.innerHTML;
    btn.innerHTML = '<div class="loader" style="width:14px; height:14px; border-width:2px;"></div> Analyzing...';
    btn.disabled = true;

    // 1. Data Verzamelen (De Waarheid)
    const today = new Date().toISOString().split('T')[0];
    const created = brew.createdAt ? brew.createdAt.toDate().toISOString().split('T')[0] : 'Unknown';
    const log = brew.logData || {};
    
    const context = `
    **RECIPE NAME:** ${brew.recipeName}
    **BREW DATE:** ${log.brewDate || created}
    **TODAY:** ${today}
    
    **STATS (TARGET vs ACTUAL):**
    - OG: Target ${log.targetOG} vs Actual ${log.actualOG || 'Unknown'}
    - FG: Target ${log.targetFG} vs Actual ${log.actualFG || 'Unknown'}
    - ABV: Target ${log.targetABV} vs Actual ${log.finalABV || 'Unknown'}
    
    **INGREDIENTS:**
    ${brew.recipeMarkdown ? brew.recipeMarkdown.substring(0, 500) : 'See logs'}
    `;

    // 2. De Prompt
    const prompt = `You are an expert Mead Cellarmaster. 
    Analyze this batch data to determine the specific **Peak Flavor Date**.
    
    **LOGIC RULES:**
    1. **High ABV (>14%) or Bochet:** Needs 12-24 months aging.
    2. **Hydromel (<8%):** Peak is soon (3-6 months).
    3. **Missed FG (Too Sweet):** If Actual FG > Target FG significantly, add +3-6 months for sugar/acid integration.
    4. **Spices/Oak:** Needs +3 months to mellow.
    
    **DATA:**
    ${context}
    
    **OUTPUT:** Provide a JSON object with:
    - "date": The specific calculated date (YYYY-MM-DD).
    - "reason": A very short (max 15 words) explanation (e.g. "High residual sugar requires 12 months to balance").
    `;

    const schema = {
        type: "OBJECT",
        properties: {
            "date": { "type": "STRING" },
            "reason": { "type": "STRING" }
        },
        required: ["date", "reason"]
    };

    try {
        const jsonResponse = await performApiCall(prompt, schema);
        const result = JSON.parse(jsonResponse);
        
        // 3. UI Invullen
        dateInput.value = result.date;
        reasonInput.value = result.reason;
        
        // Visuele feedback
        dateInput.classList.add('ring-2', 'ring-purple-500');
        setTimeout(() => dateInput.classList.remove('ring-2', 'ring-purple-500'), 1000);

    } catch (error) {
        console.error("Aging analysis failed:", error);
        showToast("Analysis failed. Please fill manually.", "error");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// --- BOTTLE BATCH (SMARTER CLOSURE LOGIC V2 - FIX POTASSIUM CARBONATE BUG) ---
window.bottleBatch = async function(e) {
    e.preventDefault();
    if (!currentBrewToBottleId) return;

    const submitButton = e.target.querySelector('button[type="submit"]');
    const originalButtonText = submitButton.innerHTML;
    submitButton.disabled = true;
    submitButton.textContent = 'Processing...'; 

    try {
        const originalBrew = state.brews.find(b => b.id === currentBrewToBottleId);
        if (!originalBrew) throw new Error("Could not find the original recipe.");

        // 1. COLLECT BOTTLES
        const bottlesData = [
            { size: 750, quantity: parseInt(document.getElementById('qty750').value) || 0, price: null },
            { size: 500, quantity: parseInt(document.getElementById('qty500').value) || 0, price: null },
            { size: 330, quantity: parseInt(document.getElementById('qty330').value) || 0, price: null },
            { size: 250, quantity: parseInt(document.getElementById('qty250').value) || 0, price: null },
            ...customBottles
        ].filter(b => b.quantity > 0 && b.size > 0);

        if (bottlesData.length === 0) throw new Error("Enter quantity for at least one bottle.");

        // 2. PHYSICS & VOLUME CHECK
        let totalLitersBottled = 0;
        bottlesData.forEach(b => totalLitersBottled += (b.size * b.quantity) / 1000);

        const currentLogVol = (originalBrew.logData && originalBrew.logData.currentVolume && parseFloat(originalBrew.logData.currentVolume) > 0) 
                              ? parseFloat(originalBrew.logData.currentVolume) 
                              : originalBrew.batchSize;

        let volumeUpdatePayload = {}; 
        
        if (totalLitersBottled > currentLogVol) {
            if (confirm(`⚠️ PHYSICS WARNING:\nBottling ${totalLitersBottled.toFixed(2)}L, but logs say ${currentLogVol.toFixed(2)}L available.\n\nAuto-correct log to ${totalLitersBottled.toFixed(2)}L?`)) {
                volumeUpdatePayload = { "logData.currentVolume": totalLitersBottled.toFixed(2) };
            } else {
                throw new Error("Bottling cancelled.");
            }
        }

        // --- 3. SMARTER STOCK CHECK ---
        const closureType = document.getElementById('closureTypeSelect').value;
        const outOfStockItems = [];
        let totalBottles = 0;

        // Check Bottles Stock
        bottlesData.forEach(bottle => {
            totalBottles += bottle.quantity;
            if (bottle.price === null) { 
                const stockId = `bottle_${bottle.size}`;
                const currentStock = state.packagingCosts[stockId]?.qty || 0;
                if (bottle.quantity > currentStock) {
                    outOfStockItems.push(`${bottle.quantity} x ${bottle.size}ml bottle(s)`);
                }
            }
        });

        // Check Closures (New Logic)
        if (closureType === 'auto') {
            const closuresNeeded = { cork: 0, crown_cap_26: 0, crown_cap_29: 0 };
            
            // --- FIX: SLIMMERE DETECTIE ---
            const recipeText = (originalBrew.recipeMarkdown || "").toLowerCase();
            
            // Check op échte bubbel-termen, en negeer chemische stoffen
            const isSparkling = recipeText.includes('sparkling') || 
                                recipeText.includes('pet-nat') || 
                                recipeText.includes('bottle carbonat') || // Specifiek 'bottle carbonation'
                                recipeText.includes('priming sugar') ||
                                recipeText.includes('force carbonat');

            // Debug log om te checken wat hij beslist (zie je in F12 console)
            console.log("Auto-Closure Logic | Sparkling detected?", isSparkling);

            bottlesData.forEach(b => {
                if (b.size >= 750) {
                    // 750ml: Kurk (Stil) of 29mm Dop (Bruisend)
                    if (isSparkling) closuresNeeded.crown_cap_29 += b.quantity;
                    else closuresNeeded.cork += b.quantity;
                } 
                else if (b.size === 500) {
                    // 500ml: Kurk (Stil) of 26mm Dop (Bruisend - standaard biermaat)
                    if (isSparkling) closuresNeeded.crown_cap_26 += b.quantity;
                    else closuresNeeded.cork += b.quantity;
                }
                else {
                    // Klein (330/250): Altijd 26mm Kroonkurk (Bierflesje)
                    closuresNeeded.crown_cap_26 += b.quantity;
                }
            });

            // Verify Stock
            if (closuresNeeded.cork > (state.packagingCosts['cork']?.qty || 0)) outOfStockItems.push(`Not enough Corks (Need ${closuresNeeded.cork})`);
            if (closuresNeeded.crown_cap_26 > (state.packagingCosts['crown_cap_26']?.qty || 0)) outOfStockItems.push(`Not enough 26mm Caps (Need ${closuresNeeded.crown_cap_26})`);
            if (closuresNeeded.crown_cap_29 > (state.packagingCosts['crown_cap_29']?.qty || 0)) outOfStockItems.push(`Not enough 29mm Caps (Need ${closuresNeeded.crown_cap_29})`);
            
        } else {
            // Manual selection overrides everything
            if (totalBottles > (state.packagingCosts[closureType]?.qty || 0)) outOfStockItems.push(`Not enough ${closureType}`);
        }

        // Check Labels
        if (totalBottles > (state.packagingCosts['label']?.qty || 0)) outOfStockItems.push(`Not enough Labels`);

        if (outOfStockItems.length > 0) throw new Error(`Stock missing:\n- ${outOfStockItems.join('\n- ')}`);

        // --- 4. CALCULATE COSTS ---
        const packCosts = (typeof getPackagingCosts === 'function') ? getPackagingCosts() : {};
        let totalPackagingCost = 0;
        
        bottlesData.forEach(b => {
             const bCost = b.price !== null ? b.price : (packCosts[b.size] || 0);
             // Simpele schatting closure kosten voor totaalberekening
             let closureCost = 0;
             if (closureType === 'auto') {
                 // We nemen gemiddelde kosten of specifiek als we exact weten
                 closureCost = packCosts.cork || 0.10; 
             } else {
                 closureCost = packCosts[closureType] || 0;
             }
             totalPackagingCost += b.quantity * (bCost + closureCost + (packCosts.label || 0));
        });
        
        const finalTotalCost = (originalBrew.totalCost || 0) + totalPackagingCost;

        // --- 5. SAVE ---
        if (confirm(`Total Cost (with packaging): €${finalTotalCost.toFixed(2)}. Proceed?`)) {
            
            // Deduct Stock
            const deduct = (id, qty) => {
                if (state.packagingCosts[id]) state.packagingCosts[id].qty = Math.max(0, state.packagingCosts[id].qty - qty);
            };
            
            bottlesData.forEach(b => { if(b.price === null) deduct(`bottle_${b.size}`, b.quantity); });
            
            // Deduct Closures Correctly
            if (closureType === 'auto') {
                // Herbereken de exacte aantallen om af te boeken (kopie van logica boven)
                const isSparkling = (originalBrew.recipeMarkdown || "").toLowerCase().includes('sparkling') || (originalBrew.recipeMarkdown || "").toLowerCase().includes('bottle carbonat');
                
                bottlesData.forEach(b => {
                    if (b.size >= 750) {
                        if (isSparkling) deduct('crown_cap_29', b.quantity);
                        else deduct('cork', b.quantity);
                    } else if (b.size === 500) {
                        if (isSparkling) deduct('crown_cap_26', b.quantity);
                        else deduct('cork', b.quantity);
                    } else {
                        deduct('crown_cap_26', b.quantity);
                    }
                });
            } else {
                deduct(closureType, totalBottles);
            }
            deduct('label', totalBottles);
            
            // Save updates
            await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'packaging'), state.packagingCosts);

            // Create Cellar Entry
            const bottlingDate = new Date(document.getElementById('bottlingDate').value);
            const peakDate = document.getElementById('peakFlavorDate').value || null;
            const peakReason = document.getElementById('peakFlavorReason').value || '';

            const cellarData = {
                userId: state.userId, brewId: currentBrewToBottleId,
                recipeName: originalBrew.recipeName,
                bottlingDate,
                bottles: bottlesData.map(({price, ...rest}) => rest),
                totalBatchCost: finalTotalCost,
                ingredientCost: originalBrew.totalCost || 0,
                peakFlavorDate: peakDate,
                peakFlavorJustification: peakReason
            };

            await addDoc(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'cellar'), cellarData);

            await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', currentBrewToBottleId), {
                isBottled: true,
                peakFlavorDate: peakDate,
                ...volumeUpdatePayload
            });

            if (state.currentBrewDay.brewId === currentBrewToBottleId) {
                state.currentBrewDay = { brewId: null };
                if(window.saveUserSettings) await window.saveUserSettings();
            }

            hideBottlingModal();
            showToast("Batch bottled successfully!", "success");
            
            if(typeof loadHistory === 'function') loadHistory();
            if(typeof loadCellar === 'function') loadCellar();
            if(typeof renderBrewDay === 'function') renderBrewDay('none');
            
            switchMainView('management');
            switchSubView('state.cellar', 'management-main-view');
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

// --- SHOPPING LIST GENERATOR ---
window.generateShoppingList = function(brewId = null, renderToScreen = true) {
    const listDiv = document.getElementById('shopping-list-items');
    if (!listDiv && renderToScreen) return;

    // 1. Bepaal welk recept we gebruiken
    let markdown = "";
    
    // Als we in Creator mode zitten (nog geen ID)
    if (!brewId && window.currentRecipeMarkdown) {
        markdown = window.currentRecipeMarkdown;
    } 
    // Als we een bestaande brew openen
    else if (brewId) {
        const brew = state.brews.find(b => b.id === brewId);
        if (brew) markdown = brew.recipeMarkdown;
    }

    if (!markdown) {
        if (renderToScreen) listDiv.innerHTML = `<div class="text-center py-10 opacity-50"><p>Generate or select a recipe first.</p></div>`;
        return;
    }

    // 2. Haal ingrediënten uit de Markdown (JSON blok)
    const jsonRegex = /(?:```json\s*)?(\[\s*\{[\s\S]*?\}\s*\])(?:\s*```)?/;
    const match = markdown.match(jsonRegex);
    
    if (!match) {
        if (renderToScreen) listDiv.innerHTML = `<div class="text-center py-10 opacity-50"><p>No ingredients data found in recipe.</p></div>`;
        return;
    }

    let ingredients = [];
    try {
        ingredients = JSON.parse(match[1]);
    } catch (e) {
        console.error("JSON Parse error:", e);
        return;
    }

    // 3. Vergelijk met Inventory
    let shoppingHtml = "";
    let everythingInStock = true;

    ingredients.forEach(req => {
        // Zoek item in inventory (hoofdletterongevoelig)
        const invItem = state.inventory.find(i => i.name.toLowerCase().includes(req.ingredient.toLowerCase()) || req.ingredient.toLowerCase().includes(i.name.toLowerCase()));
        
        let needToBuy = true;
        let stockQty = 0;
        let buyQty = parseFloat(req.quantity);
        const unit = req.unit || '';

        if (invItem) {
            stockQty = parseFloat(invItem.qty);
            
            // Simpele eenheid conversie (kg -> g)
            if (unit.toLowerCase() === 'kg' && invItem.unit.toLowerCase() === 'g') {
                buyQty *= 1000; 
            }
            
            // Hebben we genoeg?
            if (stockQty >= buyQty) {
                needToBuy = false;
            } else {
                buyQty = buyQty - stockQty; // Koop alleen het verschil
            }
        }

        // Als we het moeten kopen (of als het niet in voorraad is)
        if (needToBuy) {
            everythingInStock = false;
            // Afronden
            const displayQty = buyQty % 1 === 0 ? buyQty : buyQty.toFixed(2);
            
            shoppingHtml += `
            <div class="p-3 bg-app-secondary border-l-4 border-amber-500 rounded shadow-sm mb-2 flex justify-between items-center">
                <div>
                    <span class="font-bold text-app-header">${req.ingredient}</span>
                    <div class="text-xs text-app-secondary">Need: ${req.quantity} ${unit} ${stockQty > 0 ? `(Have: ${stockQty})` : ''}</div>
                </div>
                <div class="text-right font-mono font-bold text-amber-600">
                    Buy ${displayQty} ${unit}
                </div>
            </div>`;
        } else {
            // We hebben genoeg (optioneel: toon in groen of verberg)
             shoppingHtml += `
            <div class="p-3 bg-app-secondary border-l-4 border-green-500 rounded shadow-sm mb-2 flex justify-between items-center opacity-60 grayscale">
                <div>
                    <span class="font-bold text-app-header line-through">${req.ingredient}</span>
                    <div class="text-xs text-app-secondary">In Stock (${stockQty} ${invItem.unit})</div>
                </div>
                <div class="text-right font-bold text-green-600 text-xs uppercase">
                    Have Enough
                </div>
            </div>`;
        }
    });

    if (everythingInStock) {
        shoppingHtml = `<div class="p-6 bg-green-100 border border-green-300 rounded text-center text-green-800 font-bold mb-4">🎉 You have everything in stock!</div>` + shoppingHtml;
    }

    if (renderToScreen) listDiv.innerHTML = shoppingHtml;

    return everythingInStock;
}

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
    if (!state.userId) return;
    
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

    const itemData = { userId: state.userId, name, qty, unit, price, category, expirationDate };

    try {
        const appId = 'meandery-aa05e';
        const invCol = collection(db, 'artifacts', appId, 'users', state.userId, 'inventory');
        await addDoc(invCol, itemData);
        document.getElementById('inventory-form').reset();
        showToast("Ingredient added to inventory!", "success");
    } catch (error) {
        console.error("Error adding inventory item:", error);
        showToast("Could not add ingredient.", "error");
    }
}

window.deleteInventoryItem = async function(itemId) {
    if (!state.userId) return;
    try {
        await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'inventory', itemId));
        showToast("Item deleted.", "success");
    } catch (error) { showToast("Error deleting item.", "error"); }
}

window.editInventoryItem = function(itemId) {
    const item = state.inventory.find(i => i.id === itemId);
    if (!item) return;
    const itemDiv = document.getElementById(`item-${itemId}`);
    const currency = state.userSettings.currencySymbol || '€';
    
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
    if (!state.userId) return;
    const data = {
        name: document.getElementById(`edit-name-${itemId}`).value,
        qty: parseFloat(document.getElementById(`edit-qty-${itemId}`).value),
        price: parseFloat(document.getElementById(`edit-price-${itemId}`).value)
    };
    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'inventory', itemId), data);
        showToast("Item updated!", "success");
        // Snapshot listener update de UI automatisch
    } catch (error) { showToast("Update failed.", "error"); }
}

// --- INVENTORY DEDUCTION LOGIC ---
window.performInventoryDeduction = async function(ingredientsArray) {
    if (!state.userId || !ingredientsArray || ingredientsArray.length === 0) return;
    const batch = writeBatch(db);
    let updates = 0, notFound = [];

    ingredientsArray.forEach(req => {
        const item = state.inventory.find(inv => inv.name.toLowerCase() === req.name.toLowerCase());
        const qty = parseFloat(req.quantity || req.actualQty);
        if (item && !isNaN(qty)) {
            const newQty = item.qty - qty;
            if (newQty >= 0) {
                batch.update(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'inventory', item.id), { qty: newQty });
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

function populatePackagingDropdown() {
    const select = document.getElementById('packaging-item-select');
    if (!select) return;
    select.innerHTML = PACKAGING_ITEMS.map(item => `<option value="${item.id}">${item.name}</option>`).join('');
}

window.renderPackagingUI = function() {
    const listContainer = document.getElementById('packaging-list');
    const stockContainer = document.getElementById('packaging-stock-container');
    if (!listContainer || !stockContainer) return;

    const hasStock = PACKAGING_ITEMS.some(item => state.packagingCosts[item.id] && state.packagingCosts[item.id].qty > 0);
    stockContainer.classList.toggle('hidden', !hasStock);

    if (hasStock) {
        const currency = state.userSettings.currencySymbol || '€';
        listContainer.innerHTML = PACKAGING_ITEMS
            .filter(item => state.packagingCosts[item.id] && state.packagingCosts[item.id].qty > 0)
            .map(item => {
                const itemData = state.packagingCosts[item.id];
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
    if (!state.userId) return;
    const itemId = document.getElementById('packaging-item-select').value;
    const qtyAdded = parseFloat(document.getElementById('packaging-item-qty').value) || 0;
    const priceAdded = parseFloat(document.getElementById('packaging-item-price').value) || 0;

    if (!itemId || qtyAdded <= 0) { showToast("Invalid input.", "error"); return; }

    const currentQty = state.packagingCosts[itemId]?.qty || 0;
    const currentPrice = state.packagingCosts[itemId]?.price || 0;
    state.packagingCosts[itemId] = { qty: currentQty + qtyAdded, price: currentPrice + priceAdded };
    
    await savePackagingCosts(); 
    document.getElementById('packaging-add-form').reset();
}

async function loadPackagingCosts() {
    if (!state.userId) return;
    try {
        const docSnap = await getDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'packaging'));
        state.packagingCosts = docSnap.exists() ? docSnap.data() : {};
        renderPackagingUI();
        populatePackagingDropdown();
    } catch (error) { console.error("Error loading packaging costs:", error); }
}

async function savePackagingCosts() {
    if (!state.userId) return;
    try {
        await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'packaging'), state.packagingCosts);
        showToast('Packaging updated!', 'success');
        await loadPackagingCosts();
    } catch (error) { console.error(error); showToast('Failed to save packaging.', 'error'); }
}

window.editPackagingItem = function(itemId) {
    const item = PACKAGING_ITEMS.find(i => i.id === itemId);
    const itemData = state.packagingCosts[itemId] || {};
    const itemDiv = document.getElementById(`pkg-item-${itemId}`);
    const currency = state.userSettings.currencySymbol || '€';

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
    state.packagingCosts[itemId] = { qty, price };
    savePackagingCosts();
}

window.clearPackagingItem = function(itemId) {
    if (confirm("Clear stock for this item?")) {
       state.packagingCosts[itemId] = { qty: 0, price: 0 };
       savePackagingCosts();
    }
}

function getPackagingCosts() {
    const costs = {};
    PACKAGING_ITEMS.forEach(item => {
        const d = state.packagingCosts[item.id];
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

// --- EQUIPMENT PROFILE MANAGEMENT ---

async function addEquipmentProfile(e) {
    e.preventDefault();
    if (!state.userId) return;
    
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

    const profileData = { userId: state.userId, name, type, quantity, capacityLiters, trubLossLiters, boilOffRateLitersPerHour };

    try {
        const appId = 'meandery-aa05e';
        const equipCol = collection(db, 'artifacts', appId, 'users', state.userId, 'equipmentProfiles');
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
    if (!state.userId) return;
    const appId = 'meandery-aa05e';
    const equipCol = collection(db, 'artifacts', appId, 'users', state.userId, 'equipmentProfiles');
    const q = query(equipCol);

    onSnapshot(q, (snapshot) => {
        state.equipmentProfiles = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
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

    if (state.equipmentProfiles.length === 0) {
        listDiv.innerHTML = `<p class="text-center text-app-secondary/80 py-8">No equipment profiles yet.</p>`;
        return;
    }
    
    listDiv.innerHTML = state.equipmentProfiles.map(p => `
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
    const p = state.equipmentProfiles.find(i => i.id === profileId);
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
    if (!state.userId) return;
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
        const itemDocRef = doc(db, 'artifacts', appId, 'users', state.userId, 'equipmentProfiles', profileId);
        await updateDoc(itemDocRef, updatedData);
        showToast("Profile updated!", "success");
        // De onSnapshot listener regelt de refresh
    } catch (error) { console.error(error); showToast("Update failed.", "error"); }
}

window.deleteEquipmentProfile = async function(profileId) {
    if (!state.userId || !confirm('Delete this profile?')) return;
    try {
        const appId = 'meandery-aa05e';
        await deleteDoc(doc(db, 'artifacts', appId, 'users', state.userId, 'equipmentProfiles', profileId));
        showToast("Deleted.", "success");
    } catch (error) { console.error(error); showToast("Delete failed.", "error"); }
}

function populateEquipmentProfilesDropdown() {
    const select = document.getElementById('equipmentProfileSelect');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">None (Use default values)</option>';
    state.equipmentProfiles.forEach(p => {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = p.name;
        select.appendChild(option);
    });
    select.value = current;
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

// --- CELLAR MANAGEMENT ---

function loadCellar() {
    if (!state.userId) return;
    const cellarCol = collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'cellar');
    onSnapshot(query(cellarCol), (snapshot) => {
        state.cellar = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (typeof renderCellar === 'function') renderCellar();
        if (typeof updateCostAnalysis === 'function') updateCostAnalysis();
        if (typeof updateDashboardStats === 'function') updateDashboardStats();
    });
}

// --- RENDER CELLAR (MET TEMPERATUUR & AGING UPDATE) ---
window.renderCellar = function() {
    const listDiv = document.getElementById('cellar-list');
    if (!listDiv) return;
    
    // 1. Header met Temperatuur Input
    const currentTemp = state.userSettings.cellarTemp || 18; // Default 18 graden
    const headerHtml = `
        <div class="mb-6 p-4 bg-app-tertiary rounded-lg border border-app-brand/20 flex justify-between items-center shadow-sm">
            <div>
                <h3 class="text-sm font-bold text-app-header uppercase tracking-wider">Cellar Conditions</h3>
                <p class="text-xs text-app-secondary">Temperature affects aging speed.</p>
            </div>
            <div class="flex items-center gap-2">
                <input type="number" id="cellar-temp-input" value="${currentTemp}" onchange="window.saveCellarTemp(this.value)" 
                       class="w-16 p-2 text-center font-bold text-app-brand bg-app-primary border rounded-md focus:ring-2 focus:ring-app-brand">
                <span class="text-sm font-bold text-app-header">°C</span>
            </div>
        </div>
    `;

    if (state.cellar.length === 0) { 
        listDiv.innerHTML = headerHtml + '<p class="text-center text-app-secondary/80 mt-8">Your cellar is empty. Time to brew!</p>'; 
        return; 
    }
    
    // 2. De Lijst
    const itemsHtml = state.cellar.map(item => {
        const bottledDate = item.bottlingDate ? new Date(item.bottles ? item.bottlingDate.toDate() : item.bottlingDate).toLocaleDateString() : '?';
        
        // Peak Date Logica
        let peakHtml = '';
        if (item.peakFlavorDate) {
            const today = new Date();
            const peak = new Date(item.peakFlavorDate);
            const isReady = today >= peak;
            const colorClass = isReady ? 'text-green-600 bg-green-100 border-green-200' : 'text-purple-600 bg-purple-100 border-purple-200';
            const statusText = isReady ? 'READY TO DRINK' : `PEAK: ${peak.toLocaleDateString()}`;
            
            peakHtml = `
            <div class="mt-3 p-2 rounded border ${colorClass} text-xs font-bold flex justify-between items-center cursor-pointer hover:opacity-80 transition-opacity" onclick="window.openAgingModal('${item.id}')">
                <span>${statusText}</span>
                <span class="text-[10px] opacity-70">Tap to update</span>
            </div>`;
        } else {
            peakHtml = `
            <button onclick="window.openAgingModal('${item.id}')" class="mt-3 w-full py-2 border border-dashed border-purple-400 text-purple-600 text-xs font-bold rounded hover:bg-purple-50 transition-colors uppercase tracking-wide">
                + Add Aging Advice
            </button>`;
        }

        return `
        <div class="p-4 card rounded-lg mb-4 border-l-4 border-app-brand shadow-sm bg-app-secondary">
            <div class="flex justify-between items-start">
                <div>
                    <h4 class="font-bold text-lg font-header text-app-header leading-tight">${item.recipeName}</h4>
                    <p class="text-xs text-app-secondary mt-1">Bottled: ${bottledDate}</p>
                </div>
                <button onclick="window.deleteCellarItem('${item.id}', '${item.recipeName.replace(/'/g, "\\'")}')" class="text-gray-400 hover:text-red-500 transition-colors">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
            </div>
            
            <div class="mt-3 space-y-1 pl-2 border-l-2 border-app-brand/10">
                ${(item.bottles || []).map(b => `
                    <div class="text-sm flex justify-between items-center">
                        <span class="text-app-header font-mono">${b.quantity} x ${b.size}ml</span>
                        <button onclick="window.consumeBottle('${item.id}', ${b.size})" class="text-[10px] bg-app-action text-white px-2 py-1 rounded shadow hover:opacity-90 font-bold uppercase tracking-wider">Drink</button>
                    </div>`).join('')}
            </div>
            
            ${peakHtml}
        </div>
    `;
    }).join('');

    listDiv.innerHTML = headerHtml + itemsHtml;
}

window.saveCellarTemp = async function(temp) {
    if (!state.userId) return;
    state.userSettings.cellarTemp = temp;
    // Sla op in Firestore (in settings doc)
    const settingsRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main');
    await updateDoc(settingsRef, { cellarTemp: temp });
    showToast(`Cellar temperature set to ${temp}°C`, "success");
}

// --- AGING MANAGER MODAL (MET HISTORIE) ---
window.openAgingModal = function(cellarId) {
    const item = state.cellar.find(c => c.id === cellarId);
    if (!item) return;

    const oldModal = document.getElementById('aging-modal');
    if (oldModal) oldModal.remove();

    const currentReason = item.peakFlavorJustification || "No analysis yet.";
    const currentDate = item.peakFlavorDate || "";
    // Nieuw: We laden de opgeslagen geschiedenis of geven een placeholder
    const currentHistory = item.agingHistory || ""; 

    const html = `
    <div id="aging-modal" class="fixed inset-0 bg-black/80 flex items-center justify-center z-[9999] backdrop-blur-sm p-4">
        <div class="bg-app-secondary w-full max-w-md p-6 rounded-xl shadow-2xl border border-purple-500/30 animate-fade-in max-h-[90vh] overflow-y-auto">
            <div class="flex justify-between items-center mb-4">
                <h3 class="text-xl font-header font-bold text-purple-600">Aging Profile</h3>
                <button onclick="document.getElementById('aging-modal').remove()" class="text-gray-500 hover:text-gray-300 text-2xl">&times;</button>
            </div>
            
            <p class="text-sm font-bold text-app-header mb-1">${item.recipeName}</p>
            <p class="text-xs text-app-secondary mb-4">Current Cellar Temp: <strong>${state.userSettings.cellarTemp || 18}°C</strong></p>

            <div class="space-y-4">
                <div>
                    <label class="block text-xs font-bold uppercase text-app-secondary mb-1">Aging History / Conditions</label>
                    <textarea id="aging-history" rows="2" class="w-full p-2 rounded bg-app-tertiary border border-app-brand/20 text-xs text-app-header placeholder-gray-500" placeholder="e.g. Stored at 20°C for the first 3 months...">${currentHistory}</textarea>
                </div>

                <div>
                    <label class="block text-xs font-bold uppercase text-app-secondary mb-1">Estimated Peak Date</label>
                    <input type="date" id="edit-peak-date" value="${currentDate}" class="w-full p-2 rounded bg-app-primary border border-app-brand/20 text-app-header">
                </div>
                <div>
                    <label class="block text-xs font-bold uppercase text-app-secondary mb-1">AI Reasoning</label>
                    <textarea id="edit-peak-reason" rows="3" class="w-full p-2 rounded bg-app-primary border border-app-brand/20 text-xs text-app-header">${currentReason}</textarea>
                </div>
            </div>

            <div class="mt-6 flex flex-col gap-2">
                <button onclick="window.runAgingAnalysis('${cellarId}')" id="btn-recalc-aging" class="w-full bg-purple-600 text-white font-bold py-3 rounded-lg hover:bg-purple-700 flex items-center justify-center gap-2 transition-colors">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"></path></svg>
                    Recalculate (With History)
                </button>
                <button onclick="window.saveAgingUpdate('${cellarId}')" class="w-full bg-app-tertiary text-app-header font-bold py-3 rounded-lg hover:bg-green-600 hover:text-white transition-colors border border-app-brand/20">
                    Save Changes
                </button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
}

window.runAgingAnalysis = async function(cellarId) {
    const btn = document.getElementById('btn-recalc-aging');
    const originalText = btn.innerHTML;
    btn.innerHTML = 'Thinking...';
    btn.disabled = true;

    const item = state.cellar.find(c => c.id === cellarId);
    const temp = state.userSettings.cellarTemp || 18;
    const history = document.getElementById('aging-history').value; // We lezen jouw input
    const today = new Date().toISOString().split('T')[0];

    const originalBrew = state.brews.find(b => b.id === item.brewId);
    const recipeContext = originalBrew ? originalBrew.recipeMarkdown.substring(0, 500) : "No full recipe data.";

    const prompt = `You are a Mead Cellarmaster. Recalculate the aging potential based on specific conditions.
    
    **BATCH DATA:**
    - Name: ${item.recipeName}
    - Current Date: ${today}
    - Bottled Date: ${item.bottlingDate ? new Date(item.bottles ? item.bottlingDate.toDate() : item.bottlingDate).toLocaleDateString() : 'Unknown'}
    
    **CONDITIONS:**
    1. **CURRENT TEMP:** ${temp}°C (The cellar right now).
    2. **HISTORY / CONTEXT:** "${history}" (User provided history of storage).
    3. **RECIPE:** ${recipeContext}

    **CALCULATION RULES (ARRHENIUS):**
    - You MUST account for the history provided. 
    - Example: If user says "Stored at 25C for 3 months", that counts as ~6-9 months of standard aging. DEDUCT this "accelerated aging" from the remaining time needed.
    - If current temp is high (>20°C), remaining time is shorter but risk of oxidation increases.

    **OUTPUT:** JSON with:
    - "date": (YYYY-MM-DD) The new optimal drinking date.
    - "reason": (Max 20 words) Explain logic: e.g. "Accelerated due to 3 months at 25°C, ready sooner."
    `;

    const schema = {
        type: "OBJECT",
        properties: { "date": { "type": "STRING" }, "reason": { "type": "STRING" } },
        required: ["date", "reason"]
    };

    try {
        const jsonResponse = await performApiCall(prompt, schema);
        const result = JSON.parse(jsonResponse);
        
        document.getElementById('edit-peak-date').value = result.date;
        document.getElementById('edit-peak-reason').value = result.reason;
        
    } catch (error) {
        showToast("Analysis failed: " + error.message, "error");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

window.saveAgingUpdate = async function(cellarId) {
    const date = document.getElementById('edit-peak-date').value;
    const reason = document.getElementById('edit-peak-reason').value;
    const history = document.getElementById('aging-history').value; // Opslaan!

    if (!date) return showToast("Pick a date first.", "error");

    try {
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'cellar', cellarId), {
            peakFlavorDate: date,
            peakFlavorJustification: reason,
            agingHistory: history // Nieuw veld in de database
        });
        
        document.getElementById('aging-modal').remove();
        showToast("Aging profile updated!", "success");
        // Herlaad de kelder om de 'Peak Date' label te updaten
        renderCellar(); 
    } catch (e) {
        console.error(e);
        showToast("Save failed.", "error");
    }
}

window.consumeBottle = async function(cellarId, size) {
    if (!state.userId) return;
    const itemRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'cellar', cellarId);
    const item = state.cellar.find(c => c.id === cellarId);
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
        await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'cellar', id));
    }
}

// --- FINANCIALS & STATS ---

window.updateCostAnalysis = function() {
    const currency = state.userSettings.currencySymbol || '€';
    
    // 1. Bereken Totalen (Ongewijzigd)
    let invValue = state.inventory.reduce((sum, item) => sum + (item.price || 0), 0);
    let activeValue = state.brews.filter(b => !b.isBottled).reduce((sum, b) => sum + (b.totalCost || 0), 0);
    let cellarValue = state.cellar.reduce((sum, c) => sum + (c.totalBatchCost || 0), 0);
    
    // Update Tekst Elementen
    const elInv = document.getElementById('total-inventory-value');
    const elActive = document.getElementById('total-active-value');
    const elCellar = document.getElementById('total-cellar-value');
    const elGrand = document.getElementById('grand-total-value');
    
    if(elInv) elInv.textContent = `${currency}${invValue.toFixed(2)}`;
    if(elActive) elActive.textContent = `${currency}${activeValue.toFixed(2)}`;
    if(elCellar) elCellar.textContent = `${currency}${cellarValue.toFixed(2)}`;
    if(elGrand) elGrand.textContent = `${currency}${(invValue + activeValue + cellarValue).toFixed(2)}`;
    
    // 2. Update de Grafiek met MD3 THEMA KLEUREN
    const ctx = document.getElementById('cost-chart');
    if (ctx && window.Chart) {
        
        const spendByCategory = state.inventory.reduce((acc, item) => {
            const cat = item.category || 'Other';
            acc[cat] = (acc[cat] || 0) + (item.price || 0);
            return acc;
        }, {});

        // We mappen categorieën aan jouw CSS Variabelen voor consistentie
        // Helper: rgb(${window.getThemeColor('--md-sys-color-primary')})
        const cPrimary = `rgb(${window.getThemeColor('--md-sys-color-primary')})`;
        const cSecondary = `rgb(${window.getThemeColor('--md-sys-color-secondary')})`;
        const cTertiary = `rgb(${window.getThemeColor('--md-sys-color-tertiary')})`;
        const cError = `rgb(${window.getThemeColor('--md-sys-color-error')})`;
        const cSurfaceVar = `rgb(${window.getThemeColor('--md-sys-color-surface-variant')})`;

        const categoryColors = {
            'Honey': cPrimary,           // Honey -> Primary (Amber)
            'Yeast': cTertiary,          // Yeast -> Tertiary (Slate)
            'Nutrient': cSecondary,      // Nutrient -> Secondary (Green)
            'Malt Extract': '#7c2d12',   // Custom Brown (blijft mooi)
            'Fruit': cError,             // Fruit -> Error (Red-ish)
            'Spice': '#ea580c',          
            'Adjunct': cSurfaceVar,
            'Chemical': '#2563eb',
            'Water': '#0891b2',
            'Other': cSurfaceVar
        };

        const labels = Object.keys(spendByCategory);
        const data = Object.values(spendByCategory);
        const backgroundColors = labels.map(cat => categoryColors[cat] || cSurfaceVar);

        if (window.costChart) window.costChart.destroy();
        
        window.costChart = new Chart(ctx.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{ 
                    data: data, 
                    backgroundColor: backgroundColors,
                    borderColor: `rgb(${window.getThemeColor('--md-sys-color-surface')})`, // Rand matcht achtergrond
                    borderWidth: 2
                }]
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            usePointStyle: true,
                            padding: 20,
                            color: `rgb(${window.getThemeColor('--md-sys-color-on-surface')})`,
                            font: { family: "'Barlow Semi Condensed', sans-serif" }
                        }
                    }
                }
            }
        });
    }
}

window.updateDashboardStats = function() {
    // Simpele tellers voor het dashboard
    const primaryCount = state.brews.filter(b => b.logData?.brewDate && !b.primaryComplete).length;
    const agingCount = state.brews.filter(b => b.primaryComplete && !b.isBottled).length;
    const cellarCount = state.cellar.reduce((sum, c) => sum + (c.bottles || []).reduce((s, b) => s + b.quantity, 0), 0);
    
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

// --- EXPORTS ---
window.loadInventory = loadInventory;
window.renderInventory = renderInventory;
window.addInventoryItem = addInventoryItem;
window.editInventoryItem = editInventoryItem;
window.deleteInventoryItem = deleteInventoryItem;
window.loadEquipmentProfiles = loadEquipmentProfiles;
window.addEquipmentProfile = addEquipmentProfile;
window.deleteEquipmentProfile = deleteEquipmentProfile;
window.loadCellar = loadCellar;
window.consumeBottle = consumeBottle;
window.loadPackagingCosts = loadPackagingCosts;
window.addPackagingStock = addPackagingStock;
window.showBottlingModal = showBottlingModal;
window.hideBottlingModal = hideBottlingModal;
window.bottleBatch = bottleBatch;
window.addCustomBottleToList = addCustomBottleToList;
window.removeCustomBottleFromList = removeCustomBottleFromList;
window.renderCustomBottlesList = renderCustomBottlesList;
window.startScanner = startScanner;