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

// --- NAVIGATION ---
export function switchMainView(viewName) {
    if (window.hideBottlingModal) window.hideBottlingModal();
    
    // Verberg alle views
    const views = ['dashboard', 'brewing', 'management', 'tools', 'settings'];
    views.forEach(v => document.getElementById(`${v}-main-view`)?.classList.add('hidden'));
    
    // Toon gekozen view
    const viewToShow = document.getElementById(`${viewName}-main-view`);
    if (viewToShow) viewToShow.classList.remove('hidden');
    
    // Specifieke inits
    if (viewName === 'brewing' && window.populateEquipmentProfilesDropdown) window.populateEquipmentProfilesDropdown();
}

export function switchSubView(viewName, parentViewId) {
    const parentView = document.getElementById(parentViewId);
    if(!parentView) return;
    
    // 1. Reset alle tabs en views binnen deze sectie
    parentView.querySelectorAll('[id$="-view"]').forEach(v => v.classList.add('hidden'));
    parentView.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));

    // 2. Zoek de nieuwe view en tab
    const viewToShow = document.getElementById(`${viewName}-view`);
    const tabToActivate = document.getElementById(`${viewName}-sub-tab`);

    // 3. Activeer ze
    if (viewToShow) viewToShow.classList.remove('hidden');
    if (tabToActivate) tabToActivate.classList.add('active');

    // 4. TRIGGER LOGICA (Dit zorgt dat de data geladen wordt!)
    if (viewName === 'brew-day-2' && window.renderBrewDay2) window.renderBrewDay2();
    
    if (viewName === 'cellar' && window.renderCellar) window.renderCellar();
    if (viewName === 'financials' && window.updateCostAnalysis) window.updateCostAnalysis();

    if (viewName === 'social') {
        // Let op: hier stond een typfoutje 'populates', dat is nu weggehaald
        if(window.populateSocialRecipeDropdown) window.populateSocialRecipeDropdown();
        if(window.loadSocialStyles) window.loadSocialStyles();
    }
    
    if (viewName === 'creator' && window.populateEquipmentProfilesDropdown) window.populateEquipmentProfilesDropdown();
    
    if (viewName === 'labels') {
        if(window.populateLabelRecipeDropdown) window.populateLabelRecipeDropdown();
        if(window.updateLabelPreviewDimensions) window.updateLabelPreviewDimensions();
        if(typeof window.setLabelTheme === 'function') window.setLabelTheme('standard');
    }
    
    if (viewName === 'troubleshoot' && window.resetTroubleshootChat) window.resetTroubleshootChat();
    
    if (viewName === 'shopping-list') {
        if (typeof window.generateShoppingList === 'function') {
            const activeBrewId = (typeof tempState !== 'undefined') ? tempState.activeBrewId : null;
            window.generateShoppingList(activeBrewId);
        }
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

// --- DANGER MODAL (Bevestiging) ---
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

// --- DASHBOARD WIDGET LOGIC (BEHOUDEN) ---
export function updateDashboardInsights() {
    const list = document.getElementById('next-action-list');
    const widget = document.getElementById('next-action-widget');
    if (!list || !widget || !state.inventory || !state.brews) return;

    list.innerHTML = ''; 
    let alertsCount = 0;
    const today = new Date();

    state.inventory.forEach(item => {
        if (item.expirationDate) {
            const expDate = new Date(item.expirationDate);
            const diffTime = expDate - today;
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (diffDays <= 30 && diffDays >= 0) {
                const li = document.createElement('li');
                li.innerHTML = `<span class="text-amber-600 font-bold text-xs uppercase">⚠️ Expiry Warning</span><br> <span class="font-semibold">${item.name}</span> expires in ${diffDays} days.`;
                li.className = "mb-2 pb-2 border-b border-gray-100 dark:border-gray-700 last:border-0";
                list.appendChild(li);
                alertsCount++;
            } else if (diffDays < 0) {
                const li = document.createElement('li');
                li.innerHTML = `<span class="text-red-600 font-bold text-xs uppercase">⛔ Expired</span><br> <span class="font-semibold">${item.name}</span> is ${Math.abs(diffDays)} days over date!`;
                li.className = "mb-2 pb-2 border-b border-gray-100 dark:border-gray-700 last:border-0";
                list.appendChild(li);
                alertsCount++;
            }
        }
    });

    state.brews.forEach(brew => {
        if (brew.archived || brew.bottledDate) return;
        const hasStarted = brew.logData && brew.logData.brewDate;
        if (!hasStarted) return; 

        const startDate = new Date(brew.logData.brewDate);
        const ageDays = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));
        const archiveBtn = `<button onclick="window.archiveBrew('${brew.id}', '${brew.recipeName}')" class="float-right ml-2 text-blue-400 hover:text-blue-600 font-bold px-1" title="Archive">📦</button>`;
        const deleteBtn = `<button onclick="window.deleteGhostBrew('${brew.id}', '${brew.recipeName}')" class="float-right ml-1 text-gray-300 hover:text-red-500 font-bold px-1" title="Delete">✕</button>`;

        if (ageDays >= 3 && ageDays <= 5) {
            const li = document.createElement('li');
            li.innerHTML = `<span class="text-green-600 font-bold text-xs uppercase">💊 Nutrient Check</span><br> <b>${brew.recipeName}</b> (Day ${ageDays}).`;
            li.className = "mb-2 pb-2 border-b border-gray-100 dark:border-gray-700 last:border-0";
            list.appendChild(li);
            alertsCount++;
        }
        if (ageDays >= 14 && ageDays <= 20) {
            const li = document.createElement('li');
            li.innerHTML = `<span class="text-blue-600 font-bold text-xs uppercase">🍺 Racking Check</span><br> <b>${brew.recipeName}</b> (Day ${ageDays}).`;
            li.className = "mb-2 pb-2 border-b border-gray-100 dark:border-gray-700 last:border-0";
            list.appendChild(li);
            alertsCount++;
        }
        if (ageDays > 60) {
            const li = document.createElement('li');
            li.innerHTML = `${deleteBtn} ${archiveBtn} <span class="text-gray-400 font-bold text-xs uppercase">👻 Ghost / Stalled</span><br> <b>${brew.recipeName}</b> started ${ageDays} days ago. Still active?`;
            li.className = "mb-2 pb-2 border-b border-gray-100 dark:border-gray-700 last:border-0";
            list.appendChild(li);
            alertsCount++;
        }
    });

    if (alertsCount > 0) widget.classList.remove('hidden'); else widget.classList.add('hidden');
}

// --- GLOBAL HELPER: CSS THEME COLORS (VOOR CHART.JS) ---
function getThemeColor(variableName) {
    if (typeof window === 'undefined' || !document) return '#000000';
    return getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
}

// --- THINKING ANIMATION (BEHOUDEN) ---
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

// --- EXPORTS TO WINDOW (BELANGRIJK VOOR HTML ONCLICK) ---
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