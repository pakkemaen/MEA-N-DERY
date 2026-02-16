import { state } from './state.js';

// --- TOAST NOTIFICATIONS ---
export function showToast(message, type = 'info', duration = 4000) {
    let backgroundColor;
    switch(type) {
        case 'success': backgroundColor = "linear-gradient(to right, #22c55e, #16a34a)"; break;
        case 'error': backgroundColor = "linear-gradient(to right, #ef4444, #dc2626)"; break;
        default: backgroundColor = "linear-gradient(to right, #3b82f6, #2563eb)";
    }
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
                padding: "12px 20px"
            }
        }).showToast();
    } else {
        console.log(`[TOAST]: ${message}`);
    }
}

// --- NAVIGATION FIXED ---
export function switchMainView(viewName, targetSubView = null) {
    if (window.hideBottlingModal) window.hideBottlingModal();
    
    // 1. Verberg alle hoofd-views
    const views = ['dashboard', 'brewing', 'management', 'tools', 'settings'];
    views.forEach(v => {
        const el = document.getElementById(`${v}-main-view`);
        if (el) el.classList.add('hidden');
    });
    
    // 2. Toon de gekozen hoofd-view
    const viewToShow = document.getElementById(`${viewName}-main-view`);
    if (viewToShow) viewToShow.classList.remove('hidden');
    
    // 3. SLIMME NAVIGATIE
    // Als er een specifieke sub-view is gevraagd (via dashboard knop), ga daarheen.
    // Zo niet (via footer menu), gebruik dan de defaults.
    if (targetSubView) {
        switchSubView(targetSubView, `${viewName}-main-view`);
    } else {
        // Default fallbacks (alleen als er geen doel is opgegeven)
        if (viewName === 'management') switchSubView('inventory', 'management-main-view');
        else if (viewName === 'tools') switchSubView('calculators', 'tools-main-view');
        else if (viewName === 'settings') switchSubView('settings-general', 'settings-main-view');
        else if (viewName === 'brewing') {
            if (window.populateEquipmentProfilesDropdown) window.populateEquipmentProfilesDropdown();
        }
    }
}

export function switchSubView(viewName, parentViewId) {
    const parentView = document.getElementById(parentViewId);
    if (!parentView) return;

    // 1. Reset UI: Verberg alle views die eindigen op '-view' BINNEN deze parent
    // We gebruiken :scope om zeker te weten dat we alleen directe kinderen of diepe kinderen binnen deze sectie pakken
    const children = parentView.querySelectorAll('[id$="-view"]');
    children.forEach(v => v.classList.add('hidden'));

    // Reset Tabs
    parentView.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));

    // 2. Toon nieuwe view en activeer tab
    // Dit gebeurt direct, zodat de gebruiker instant feedback ziet
    const viewToShow = document.getElementById(`${viewName}-view`);
    const tabToActivate = document.getElementById(`${viewName}-sub-tab`);

    if (viewToShow) viewToShow.classList.remove('hidden');
    if (tabToActivate) tabToActivate.classList.add('active');

    // 3. Trigger Renderers (MET VERTRAAGING)
    // We wachten 50ms. Dit geeft de browser precies genoeg tijd om de CSS 'display: block' 
    // te verwerken en het scherm te tekenen, voordat de zware data-functies draaien.
    const renderDelay = 50; 

    // --- BREWING ---
    // Brew Day 1 & 2 laten we direct, omdat die vaak al in het geheugen zitten en snel moeten voelen.
    if (viewName === 'brew-day-1' && window.renderBrewDay) window.renderBrewDay();
    if (viewName === 'brew-day-2' && window.renderBrewDay2) window.renderBrewDay2();
    
    // History en Shopping List kunnen zwaar zijn, dus die vertragen we ook
    if (viewName === 'history' && window.renderHistoryList) {
        setTimeout(() => window.renderHistoryList(), renderDelay);
    }
    if (viewName === 'shopping-list' && window.generateShoppingList) {
        setTimeout(() => {
            const activeBrewId = (typeof window.state !== 'undefined' && window.state.currentBrewDay) ? window.state.currentBrewDay.brewId : null;
            window.generateShoppingList(activeBrewId);
        }, renderDelay);
    }

    // --- MANAGEMENT (De probleemveroorzakers) ---
    if (viewName === 'inventory' && window.renderInventory) {
        setTimeout(() => window.renderInventory(), renderDelay);
    }
    if (viewName === 'cellar' && window.renderCellar) {
        setTimeout(() => window.renderCellar(), renderDelay);
    }
    if (viewName === 'financials' && window.updateCostAnalysis) {
        setTimeout(() => window.updateCostAnalysis(), renderDelay);
    }
    if (viewName === 'equipment' && window.renderEquipmentProfiles) {
        setTimeout(() => window.renderEquipmentProfiles(), renderDelay);
    }
    if (viewName === 'packaging' && window.renderPackagingUI) {
        setTimeout(() => window.renderPackagingUI(), renderDelay);
    }

    // --- TOOLS ---
    if (viewName === 'social') {
        setTimeout(() => {
            if(window.populateSocialRecipeDropdown) window.populateSocialRecipeDropdown();
            if(window.loadSocialStyles) window.loadSocialStyles();
        }, renderDelay);
    }
    if (viewName === 'labels') {
        setTimeout(() => {
            if(window.populateLabelRecipeDropdown) window.populateLabelRecipeDropdown();
            if(window.updateLabelPreviewDimensions) window.updateLabelPreviewDimensions();
            if(typeof window.setLabelTheme === 'function') window.setLabelTheme('standard');
        }, renderDelay);
    }
    if (viewName === 'troubleshoot' && window.resetTroubleshootChat) {
        setTimeout(() => window.resetTroubleshootChat(), renderDelay);
    }
    
    // --- SETTINGS ---
    if (viewName === 'settings-assets' && window.renderLabelAssetsSettings) {
        setTimeout(() => window.renderLabelAssetsSettings(), renderDelay);
    }
}

// --- UI UTILITIES ---
export function getLoaderHtml(text = "Loading...") {
    return `
    <div class="flex flex-col items-center justify-center py-8">
        <svg class="honeycomb-loader" viewBox="0 0 60 65" xmlns="http://www.w3.org/2000/svg">
            <path class="honeycomb-path" d="M30,5 L55,18.75 L55,46.25 L30,60 L5,46.25 L5,18.75 Z" />
            <circle class="honeycomb-core" cx="30" cy="32.5" r="6" />
        </svg>
        <p class="text-app-brand font-bold animate-pulse mt-2 text-sm uppercase tracking-wider">${text}</p>
    </div>`;
}

// --- DANGER MODAL ---
let dangerAction = null; 

export function showDangerModal(action, confirmationText) {
    dangerAction = action;
    const modal = document.getElementById('danger-modal');
    if(modal) {
        document.getElementById('danger-confirm-text').textContent = confirmationText;
        document.getElementById('danger-confirm-input').value = '';
        modal.classList.remove('hidden');
        checkDangerConfirmation();
    } else {
        if(confirm(`TYPE "${confirmationText}" TO CONFIRM.`)) action();
    }
}

export function hideDangerModal() {
    document.getElementById('danger-modal')?.classList.add('hidden');
    dangerAction = null;
}

export function checkDangerConfirmation() {
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

export function executeDangerAction() {
    if (typeof dangerAction === 'function') dangerAction();
    hideDangerModal();
}

// --- AI CORE ---
export async function performApiCall(prompt, schema = null) {
    let apiKey = state.userSettings.apiKey;
    const CONFIG = window.CONFIG || {};
    if (!apiKey && CONFIG.firebase && CONFIG.firebase.apiKey) {
        apiKey = CONFIG.firebase.apiKey;
    }

    if (!apiKey) throw new Error("⛔ Geen API Key! Ga naar Settings.");

    const model = (state.userSettings.aiModel && state.userSettings.aiModel.trim() !== "") 
        ? state.userSettings.aiModel : "gemini-1.5-flash";

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const requestBody = { contents: [{ parts: [{ text: prompt }] }] };

    if (schema) {
        requestBody.generationConfig = { responseMimeType: "application/json", responseSchema: schema };
    }

    const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        if (response.status === 429) throw new Error("⛔ QUOTA BEREIKT. Je daglimiet is op of je gaat te snel.");
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `AI Error: ${response.status}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// --- DASHBOARD WIDGET ---
export function updateDashboardInsights() {
    const list = document.getElementById('next-action-list');
    const widget = document.getElementById('next-action-widget');
    if (!list || !widget || !state.inventory || !state.brews) return;

    list.innerHTML = ''; 
    let alertsCount = 0;
    const today = new Date();

    // SVG ICONEN (Geen Emojis meer)
    const iconExpired = `<svg class="w-5 h-5 text-error" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`;
    const iconWarning = `<svg class="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>`;
    const iconCheck = `<svg class="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`;
    const iconGhost = `<svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>`;

    // Helper voor stijlvolle kaarten
    const createAlert = (icon, title, desc, bgClass = "bg-surface-container") => {
        const li = document.createElement('li');
        li.className = "mb-2 last:mb-0";
        li.innerHTML = `
            <div class="flex items-start gap-3 p-3 rounded-xl border border-outline-variant/30 ${bgClass}">
                <div class="mt-0.5 flex-shrink-0">${icon}</div>
                <div class="flex-grow">
                    <p class="text-xs font-bold uppercase tracking-wider opacity-80 mb-0.5">${title}</p>
                    <p class="text-sm font-medium leading-snug">${desc}</p>
                </div>
            </div>`;
        return li;
    };

    // INVENTORY CHECKS
    state.inventory.forEach(item => {
        if (item.expirationDate) {
            const expDate = new Date(item.expirationDate);
            const diffTime = expDate - today;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays <= 30 && diffDays >= 0) {
                list.appendChild(createAlert(
                    iconWarning, 
                    "Expiry Warning", 
                    `<b>${item.name}</b> expires in ${diffDays} days.`,
                    "bg-amber-50 dark:bg-amber-900/20"
                ));
                alertsCount++;
            } else if (diffDays < 0) {
                list.appendChild(createAlert(
                    iconExpired, 
                    "Expired Item", 
                    `<b>${item.name}</b> is ${Math.abs(diffDays)} days over date.`,
                    "bg-error-container/30"
                ));
                alertsCount++;
            }
        }
    });

    // BREWING CHECKS
    state.brews.forEach(brew => {
        if (brew.archived || brew.bottledDate) return;
        const hasStarted = brew.logData && brew.logData.brewDate;
        if (!hasStarted) return; 

        const startDate = new Date(brew.logData.brewDate);
        const ageDays = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));
        
        // Knoppen HTML (zonder functionaliteit wijziging, alleen styling)
        const archiveBtn = `<button onclick="window.archiveBrew('${brew.id}', '${brew.recipeName}')" class="text-blue-500 font-bold hover:underline ml-2">Archive</button>`;
        const deleteBtn = `<button onclick="window.deleteGhostBrew('${brew.id}', '${brew.recipeName}')" class="text-red-500 font-bold hover:underline ml-2">Delete</button>`;

        if (ageDays >= 3 && ageDays <= 5) {
            list.appendChild(createAlert(iconCheck, "Nutrient Schedule", `Add nutrients to <b>${brew.recipeName}</b> (Day ${ageDays}).`, "bg-green-50 dark:bg-green-900/20"));
            alertsCount++;
        }
        if (ageDays >= 14 && ageDays <= 20) {
            list.appendChild(createAlert(iconCheck, "Racking Window", `Check <b>${brew.recipeName}</b> for racking (Day ${ageDays}).`, "bg-blue-50 dark:bg-blue-900/20"));
            alertsCount++;
        }
        if (ageDays > 60) {
            list.appendChild(createAlert(
                iconGhost, 
                "Ghost Batch Detected", 
                `<b>${brew.recipeName}</b> active for ${ageDays} days. Update status? <div class="mt-1 flex justify-end text-[10px] uppercase tracking-wider">${archiveBtn} ${deleteBtn}</div>`,
                "bg-surface-variant/30"
            ));
            alertsCount++;
        }
    });

    if (alertsCount > 0) widget.classList.remove('hidden'); else widget.classList.add('hidden');
}

// --- BLACK BOX LOGGING SYSTEM ---
export async function logSystemError(error, context = 'General', severity = 'ERROR') {
    // 1. Altijd ook in de console tonen voor development
    console.error(`[${context}]`, error);

    // 2. Als we geen user ID hebben, kunnen we niet opslaan in zijn mapje
    if (!state.userId) return;

    try {
        const logEntry = {
            timestamp: new Date().toISOString(),
            version: "v2.4", // Pas dit aan als je updatet
            severity: severity, // 'ERROR', 'WARN', 'INFO'
            context: context,
            message: error.message || error.toString(),
            stack: error.stack || 'No stack trace',
            userAgent: navigator.userAgent // Handig om te weten of het iPhone of Android was
        };

        // We slaan dit op in een APARTE collectie 'systemLogs' zodat het je recepten niet vervuilt
        const { addDoc, collection } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        
        await addDoc(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'systemLogs'), logEntry);
        
    } catch (loggingError) {
        console.warn("Kon fout niet naar database sturen:", loggingError);
    }
}

// --- GLOBAL HELPER: CSS THEME COLORS ---
function getThemeColor(variableName) {
    if (typeof window === 'undefined' || !document) return '#000000';
    return getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
}

// --- THINKING ANIMATION ---
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
    return setInterval(() => {
        index = (index + 1) % messages.length;
        element.textContent = messages[index];
    }, 1800); 
}

// --- EXPORTS TO WINDOW ---
window.showToast = showToast;
window.getLoaderHtml = getLoaderHtml;
window.switchMainView = switchMainView;
window.switchSubView = switchSubView;
window.showDangerModal = showDangerModal;
window.hideDangerModal = hideDangerModal;
window.checkDangerConfirmation = checkDangerConfirmation;
window.executeDangerAction = executeDangerAction;
window.updateDashboardInsights = updateDashboardInsights;
window.getThemeColor = getThemeColor;
window.logSystemError = logSystemError;