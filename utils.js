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
    
    // UI Reset
    parentView.querySelectorAll('[id$="-view"]').forEach(v => v.classList.add('hidden'));
    parentView.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));

    const viewToShow = document.getElementById(`${viewName}-view`);
    const tabToActivate = document.getElementById(`${viewName}-sub-tab`);

    if (viewToShow) viewToShow.classList.remove('hidden');
    if (tabToActivate) tabToActivate.classList.add('active');

    // Trigger specifieke logica (veilig via window check)
    if (viewName === 'brew-day-2' && window.renderBrewDay2) window.renderBrewDay2();
    if (viewName === 'social' && window.populateSocialRecipeDropdown) window.populateSocialRecipeDropdown();
    if (viewName === 'creator' && window.populateEquipmentProfilesDropdown) window.populateEquipmentProfilesDropdown();
    if (viewName === 'labels') {
        if(window.populateLabelRecipeDropdown) window.populateLabelRecipeDropdown();
        if(window.updateLabelPreviewDimensions) window.updateLabelPreviewDimensions();
        if(typeof window.setLabelTheme === 'function') window.setLabelTheme('standard');
    }
    if (viewName === 'troubleshoot' && window.resetTroubleshootChat) window.resetTroubleshootChat();
}

// --- UI UTILITIES ---
export function getLoaderHtml(message = "Initializing...") {
    return `<div class="flex flex-col items-center justify-center py-8">
            <div class="honeycomb-loader" style="width:50px;height:50px;margin-bottom:10px;"></div>
            <p class="text-center text-app-secondary/80 font-header tracking-wide animate-pulse mt-2 text-sm uppercase">${message}</p>
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
    // 1. Haal key op uit State
    let apiKey = state.userSettings.apiKey;
    
    // Fallback naar CONFIG (als aanwezig)
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

// --- EXPORTS TO WINDOW (Voor HTML onclick support) ---
window.showToast = showToast;
window.getLoaderHtml = getLoaderHtml;
window.switchMainView = switchMainView;
window.switchSubView = switchSubView;
window.showDangerModal = showDangerModal;
window.hideDangerModal = hideDangerModal;
window.checkDangerConfirmation = checkDangerConfirmation;
window.executeDangerAction = executeDangerAction;

// Start thinking animation toevoegen (die hadden we bovenaan weggehaald)
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