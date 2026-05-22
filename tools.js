// ============================================================================
// tools.js
// MEANDERY V2.6
// ============================================================================

import { 
    db, doc, getDoc, setDoc, updateDoc, collection, addDoc, 
    deleteDoc, query, onSnapshot, getDocs, writeBatch, arrayUnion, 
    orderBy, limit, getCountFromServer 
} from './firebase-init.js'; // Imports uitsluitend via firebase-init

import { state } from './state.js';
import { 
    showToast, performApiCall, getLoaderHtml, switchMainView, 
    switchSubView, logSystemError 
} from './utils.js';

// Fallback als CONFIG niet globaal beschikbaar is (wat in modules vaak zo is)
const CONFIG = window.CONFIG || { firebase: { apiKey: "" } };

let userWaterProfiles = [];

// --- SETTINGS MANAGEMENT ---
async function loadUserSettings() {
    try {
        if (!state.userId) return;
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main');
        const snap = await getDoc(docRef);
        
        if (snap.exists()) {
            state.userSettings = snap.data();
            
            if (state.userSettings.currentBrewDay && state.userSettings.currentBrewDay.brewId) {
                state.currentBrewDay = state.userSettings.currentBrewDay;
                
                if (window.tempState) {
                    window.tempState.activeBrewId = state.userSettings.currentBrewDay.brewId;
                }

                if (typeof window.renderBrewDay === 'function') {
                    console.log("🔄 Restoring active brew:", state.currentBrewDay.brewId);
                    window.renderBrewDay(state.currentBrewDay.brewId);
                }
            }

            applySettings();
        }
    } catch (error) {
        window.logSystemError(error, 'Settings: Load', 'ERROR');
        window.showToast("Fout bij het inladen van de gebruikersinstellingen. Gebruikersinstellingen konden niet worden ingeladen.", "error");
    }
}

function applySettings() {
    // Vul de velden in settings-view
    const s = state.userSettings;
    
    if(document.getElementById('apiKeyInput')) document.getElementById('apiKeyInput').value = s.apiKey || '';
    if(document.getElementById('defaultBatchSizeInput')) document.getElementById('defaultBatchSizeInput').value = s.defaultBatchSize || 5;
    if(document.getElementById('defaultCurrencyInput')) {
        document.getElementById('defaultCurrencyInput').value = s.currencySymbol || '€';
    }
    if(document.getElementById('defaultCarbonationInput')) {
        document.getElementById('defaultCarbonationInput').value = s.carbonationMethod || 'bottle';
    }
    if (s.theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
}

async function saveUserSettings() {
    if (!state.userId) return;
    
    try {
        const apiKeyVal = document.getElementById('apiKeyInput').value.trim();
        const batchSizeInput = document.getElementById('defaultBatchSizeInput').value.replace(/,/g, '.');
        const wcfInput = parseFloat(document.getElementById('wcfInput')?.value.replace(/,/g, '.')) || 1.00;

        if (wcfInput < 1.00 || wcfInput > 1.04) {
            showToast("WCF moet tussen 1.00 en 1.04 liggen.", "error");
            return;
        }

        if (!apiKeyVal) {
            showToast("Let op: Zonder API Key zullen AI-functies (recepten, chat) niet werken.", "warning");
        }
        
        const newSettings = {
            apiKey: apiKeyVal,
            defaultBatchSize: parseFloat(batchSizeInput) || 5, 
            currencySymbol: document.getElementById('defaultCurrencyInput').value || '€',
            carbonationMethod: document.getElementById('defaultCarbonationInput').value,
            wcf: wcfInput,
            theme: document.getElementById('theme-toggle-checkbox').checked ? 'dark' : 'light'
        };
        
        await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main'), newSettings, { merge: true });
        
        state.userSettings = { ...state.userSettings, ...newSettings }; 
        applySettings();
        showToast("Settings saved!", "success");
        
        if (window.tempState?.activeBrewId && typeof window.renderFermentationGraph === 'function') {
            window.renderFermentationGraph(window.tempState.activeBrewId);
        }
    } catch (error) {
        // CORRECTION: Omschrijving in het catch-blok aangepast naar een representatieve tekst voor deze module
        window.logSystemError(error, 'Settings: Save', 'ERROR');
        window.showToast("Fout bij het opslaan van de gebruikersinstellingen.", "error");
    }
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
            window.logSystemError(`AI Water Search: Geen resultaten voor ${brandName}`, 'Tools: Water', 'INFO');
        } else {
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
        window.logSystemError(error, 'Tools: findWaterProfileWithAI', 'ERROR');
        showToast("AI search failed. Please try again.", "error");
    } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = 'Find';
    }
}

async function loadUserWaterProfiles() {
    if (!state.userId) return;
    onSnapshot(query(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'waterProfiles')), (snapshot) => {
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
    if (!state.userId) return;
    
    try {
        const id = document.getElementById('water-profile-id').value;
        
        // Helper voor Comma-to-Dot sanitisatie
        const getSanitizedVal = (id) => parseFloat(document.getElementById(id).value.replace(/,/g, '.')) || 0;

        const data = {
            name: document.getElementById('water-profile-name').value.trim(),
            ca: getSanitizedVal('manual_ca'),
            mg: getSanitizedVal('manual_mg'),
            na: getSanitizedVal('manual_na'),
            so4: getSanitizedVal('manual_so4'),
            cl: getSanitizedVal('manual_cl'),
            hco3: getSanitizedVal('manual_hco3'),
        };

        if (!data.name) return showToast("Profile name required.", "error");
        
        const col = collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'waterProfiles');
        if (id) {
            await setDoc(doc(col, id), data);
        } else {
            await addDoc(col, data);
        }
        
        showToast("Water profile saved!", "success");
        document.getElementById('water-profile-form').reset();
        document.getElementById('water-profile-id').value = '';
    } catch (error) {
        window.logSystemError(error, 'WaterProfile: Save', 'ERROR');
        showToast("Error saving water profile.", "error");
    }
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
    if (!state.userId || !confirm("Delete profile?")) return;
    try { await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'waterProfiles', id)); showToast("Deleted.", "success"); }
    catch (e) { showToast("Error deleting.", "error"); }
}

window.showLastPrompt = function() {
    // In tools.js refereren we naar de variabele uit brewing.js indien beschikbaar
    const promptText = window.lastGeneratedPrompt || "No prompt generated yet.";
    window.showPromptModal(promptText);
}

window.hidePromptModal = function() {
    const modal = document.getElementById('prompt-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// --- PROMPT ENGINEER TOOL (SETTINGS) ---

// 1. Variabele om de foto tijdelijk op te slaan
let promptEngineerImageBase64 = null;

// 2. Event Listener Setup (Aanroepen in initApp)
// --- PROMPT ENGINEER SETUP (V4.3 - FIX) ---
function setupPromptEngineer() {
    console.log("🛠️ Setup Prompt Engineer gestart...");

    const upload = document.getElementById('prompt-engineer-upload');
    const btn = document.getElementById('btn-analyze-prompt');

    // Koppel de Upload Listener
    if (upload) {
        const newUpload = upload.cloneNode(true);
        upload.parentNode.replaceChild(newUpload, upload);
        
        newUpload.addEventListener('change', function(e) {
            const file = e.target.files;
            if (file) {
                const reader = new FileReader();
                reader.onload = function(evt) {
                    // CORRECTIE: Extractie van de base64-string via de chat-veilige .at(1) methodiek
                    promptEngineerImageBase64 = evt.target.result.split(',').at(1);
                    const previewContainer = document.getElementById('prompt-engineer-preview');
                    const previewImg = document.getElementById('pe-preview-img');
                    if (previewContainer && previewImg) {
                        previewImg.src = evt.target.result;
                        previewContainer.classList.remove('hidden');
                        document.getElementById('pe-clear-btn')?.classList.remove('hidden');
                    }
                };
                reader.readAsDataURL(file);
            }
        });
        console.log("✅ Upload listener gekoppeld.");
    }

    // Koppel de Generate Knop Listener
    if (btn) {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        
        newBtn.addEventListener('click', () => {
            console.log("🖱️ Knop geklikt! Starten...");
            runPromptEngineer();
        });
        console.log("✅ Generate knop listener gekoppeld.");
    } else {
        console.error("❌ Kan knop 'btn-analyze-prompt' niet vinden in de HTML.");
    }
}

// 3. De Analyse Functie
// --- DE VERNIEUWDE ANALYSE FUNCTIE (V4.6 - STYLE DNA EXTRACTOR) ---
async function runPromptEngineer() {
    console.log("🚀 runPromptEngineer gestart (Style DNA Mode)...");

    const artistInput = document.getElementById('prompt-engineer-artist')?.value.trim();
    const contextInput = document.getElementById('prompt-engineer-context')?.value.trim();
    
    // VALIDATIE
    if (!promptEngineerImageBase64 && !artistInput) {
        showToast("Vul een naam in OF upload een foto.", "error");
        return;
    }

    const btn = document.getElementById('btn-analyze-prompt');
    const originalText = btn.innerHTML;
    btn.innerHTML = "Extracting Style DNA..."; 
    btn.disabled = true;

    const outputDiv = document.getElementById('prompt-engineer-output');
    const outputText = document.getElementById('pe-result-text');

    // API Setup
    let apiKey = state.userSettings.apiKey;
    if (!apiKey && typeof CONFIG !== 'undefined' && CONFIG.firebase) apiKey = CONFIG.firebase.apiKey;
    if (!apiKey) {
        showToast("Geen API Key.", "error");
        btn.innerHTML = originalText;
        btn.disabled = false;
        return;
    }

    // Gebruik het beste model (Pro is hier echt beter in abstractie)
    let model = state.userSettings.aiModel || "gemini-1.5-pro"; 
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // --- DE SYSTEM PROMPT: PUUR STIJL, GEEN INHOUD ---
    let promptTask = `You are an Expert Art Curator and Style Analyzer.

    YOUR GOAL: Isolate the "Visual DNA" of the input style so it can be applied to ANY object later.
    
    INPUT SOURCE:
    ${artistInput ? `- Style/Artist Name: "${artistInput}"` : ''}
    ${promptEngineerImageBase64 ? `- Reference Image (Analyze the visual technique)` : ''}
    ${contextInput ? `- User Nuance: "${contextInput}"` : ''}

    CRITICAL INSTRUCTIONS:
    1. **IGNORE THE SUBJECT:** If the source shows a person, a car, a band, or a building -> IGNORE IT. Do not mention specific objects.
    2. **EXTRACT THE TECHNIQUE:** Describe the *medium* (e.g. screenprint, oil, vector), the *lighting*, the *texture*, the *color palette*, and the *compositional vibe*.
    3. **OUTPUT FORMAT:** A comma-separated string of descriptive keywords and phrases.
    
    BAD EXAMPLE (Don't do this): "A poster of a rock band playing guitars with skeletons."
    GOOD EXAMPLE (Do this): "Grunge aesthetic, distressed screenprint texture, high contrast, limited 3-color palette, surrealist anatomy, bold graphic lines, raw atmosphere."

    OUTPUT: Just the descriptive string.`;

    // --- PAYLOAD ---
    const parts = [{ text: promptTask }];
    
    if (promptEngineerImageBase64) {
        parts.push({ inline_data: { mime_type: "image/jpeg", data: promptEngineerImageBase64 } });
    }

    const requestBody = { contents: [{ parts: parts }] };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error?.message || `API Error: ${response.status}`);
        }

        const data = await response.json();
        
        // CORRECTIE: Extractie van candidates en parts arrays volledig omgebouwd naar de veilige .at(0) methodiek
        if (data.candidates && data.candidates.length > 0) {
            const firstCandidate = data.candidates.at(0);
            if (firstCandidate && firstCandidate.content && firstCandidate.content.parts && firstCandidate.content.parts.length > 0) {
                const result = firstCandidate.content.parts.at(0).text.trim();
                outputDiv.classList.remove('hidden');
                outputText.value = result;
                showToast("Style DNA Extracted!", "success");
            }
        }

    } catch (e) {
        console.error("Prompt Engineer Error:", e);
        showToast("Mislukt: " + e.message, "error");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// 4. Helper om te kopiëren
window.copyEngineerPrompt = function() {
    const text = document.getElementById('pe-result-text');
    if (!text) return;
    text.select();
    navigator.clipboard.writeText(text.value);
    showToast("Copied to clipboard!", "success");
}

// --- IMAGE CLEAR HELPER ---
window.clearPromptEngineerImage = function() {
    promptEngineerImageBase64 = null;
    document.getElementById('prompt-engineer-preview').classList.add('hidden');
    document.getElementById('pe-clear-btn').classList.add('hidden');
    document.getElementById('prompt-engineer-upload').value = ''; // Reset file input
}

async function importData(event, collectionName) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!state.userId) return showToast("Log in to import.", "error");

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (!Array.isArray(data)) throw new Error("Invalid format: Not an array");

            const batchLimit = 500;
            let count = 0;
            
            // We voegen ze één voor één toe (batch write is complexer hier)
            for (const item of data) {
                // Verwijder ID uit de data, laat Firestore een nieuwe maken
                const { id, ...docData } = item;
                // Fix timestamps als het nodig is
                if (docData.createdAt && typeof docData.createdAt === 'string') {
                    docData.createdAt = new Date(docData.createdAt);
                }
                
                await addDoc(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, collectionName), docData);
                count++;
            }
            
            showToast(`Imported ${count} items into ${collectionName}!`, "success");
            
            // Ververs de data
            if (collectionName === 'brews' && window.loadHistory) window.loadHistory();
            if (collectionName === 'inventory' && window.loadInventory) window.loadInventory();

        } catch (err) {
            // SANISATIE: Rauwe console.error geconverteerd naar gecentraliseerd loggen en toast notificatie
            window.logSystemError(err, 'Tools: Data Import', 'ERROR');
            showToast("Import failed: " + err.message, "error");
        }
    };
    reader.readAsText(file);
}

// --- MEAD MEDIC CHAT SYSTEM (MET GESCHIEDENIS) ---

let chatHistory = []; // De actieve berichten
let currentChatImageBase64 = null; 
let currentChatId = null; // Houdt bij of we in een bestaand of nieuw gesprek zitten

// 1. Initialiseer de View (Met History Knop)
window.resetTroubleshootChat = function() {
    chatHistory = [];
    currentChatId = null;
    currentChatImageBase64 = null;
    
    // UI Reset
    const chatBox = document.getElementById('chat-history');
    const header = document.querySelector('#troubleshoot-view h3');
    
    // Voeg History knop toe aan de header als die er nog niet is
    if(header && !document.getElementById('medic-history-btn')) {
        const btnContainer = document.createElement('div');
        btnContainer.innerHTML = `
            <button id="medic-history-btn" onclick="window.toggleMedicHistory()" class="text-xs bg-app-tertiary border border-app-brand/30 px-2 py-1 rounded mr-2 hover:bg-app-secondary">
                📂 History
            </button>`;
        header.insertBefore(btnContainer.firstElementChild, header.firstChild);
        
        // Voeg de lijst-container toe aan de HTML als die er nog niet is
        const view = document.getElementById('troubleshoot-view');
        if (!document.getElementById('medic-history-list')) {
            const listDiv = document.createElement('div');
            listDiv.id = 'medic-history-list';
            listDiv.className = 'hidden absolute top-12 left-4 right-4 bg-app-secondary border border-app-brand/20 shadow-xl rounded-lg z-50 max-h-[60vh] overflow-y-auto p-2';
            view.style.position = 'relative'; // Nodig voor absolute positioning
            view.appendChild(listDiv);
        }
    }

    if(chatBox) {
        chatBox.innerHTML = `
        <div class="flex items-start gap-3">
            <div class="w-8 h-8 rounded-full bg-app-brand text-white flex items-center justify-center font-bold text-xs">DOC</div>
            <div class="bg-white dark:bg-gray-800 p-3 rounded-lg rounded-tl-none shadow-sm text-sm text-app-header border border-gray-100 dark:border-gray-700 max-w-[85%]">
                Hi! I'm your Mead Medic. Start a new diagnosis or upload a photo.
            </div>
        </div>`;
    }
    window.clearChatImage();
}

// 2. Toggle & Laad Geschiedenis Lijst
window.toggleMedicHistory = async function() {
    const listDiv = document.getElementById('medic-history-list');
    if (!listDiv) return;
    
    if (!listDiv.classList.contains('hidden')) {
        listDiv.classList.add('hidden');
        return;
    }

    // Openen en laden
    listDiv.classList.remove('hidden');
    listDiv.innerHTML = getLoaderHtml("Loading records...");

    if (!state.userId) {
        listDiv.innerHTML = `<p class="p-4 text-center text-sm text-red-500">Log in to view history.</p>`;
        return;
    }

    try {
        const q = query(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'medicChats'));
        const snapshot = await getDocs(q); // We gebruiken getDocs voor een eenmalige fetch (sneller dan snapshot listener hier)
        
        if (snapshot.empty) {
            listDiv.innerHTML = `<div class="p-4 text-center text-sm text-app-secondary">No previous diagnoses found.</div><button onclick="document.getElementById('medic-history-list').classList.add('hidden')" class="w-full text-center py-2 text-xs font-bold uppercase border-t border-app-brand/10">Close</button>`;
            return;
        }

        // Sorteren op datum (nieuwste eerst)
        const chats = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        let html = `<div class="flex justify-between items-center p-2 border-b border-app-brand/10 mb-2"><span class="font-bold text-sm">Past Diagnoses</span><button onclick="document.getElementById('medic-history-list').classList.add('hidden')" class="text-lg font-bold">&times;</button></div>`;
        
        html += chats.map(chat => {
            const date = new Date(chat.updatedAt).toLocaleDateString();
            return `
            <div onclick="window.loadMedicChat('${chat.id}')" class="p-3 mb-2 bg-app-tertiary hover:bg-white dark:hover:bg-gray-700 rounded cursor-pointer border border-transparent hover:border-app-brand/30 transition-colors group relative">
                <div class="font-bold text-sm text-app-header truncate pr-6">${chat.title || 'Untitled Issue'}</div>
                <div class="text-xs text-app-secondary flex justify-between mt-1">
                    <span>${date}</span>
                    <span>${chat.messages.length} msgs</span>
                </div>
                <button onclick="event.stopPropagation(); window.deleteMedicChat('${chat.id}')" class="absolute top-2 right-2 text-gray-400 hover:text-red-500 hidden group-hover:block">&times;</button>
            </div>`;
        }).join('');

        listDiv.innerHTML = html;

    } catch (e) {
        console.error(e);
        listDiv.innerHTML = `<p class="p-4 text-red-500">Error loading history.</p>`;
    }
}

// 3. Laad een specifiek gesprek
window.loadMedicChat = async function(chatId) {
    if (!state.userId) return;
    
    // Sluit lijst
    document.getElementById('medic-history-list').classList.add('hidden');
    
    try {
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'medicChats', chatId);
        const docSnap = await getDoc(docRef);
        
        if (!docSnap.exists()) return showToast("Chat not found.", "error");
        
        const data = docSnap.data();
        currentChatId = chatId;
        chatHistory = data.messages || [];
        
        // Render de chat opnieuw
        const chatBox = document.getElementById('chat-history');
        chatBox.innerHTML = ''; // Wis huidige view
        
        chatHistory.forEach(msg => {
            const isUser = msg.role === 'user';
            const align = isUser ? 'justify-end' : 'justify-start';
            const color = isUser ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-800 text-app-header border border-gray-100 dark:border-gray-700';
            const avatar = isUser ? 'src="logo.png"' : ''; 
            const avatarDiv = isUser 
                ? `<img src="logo.png" onerror="this.src='favicon.png'" class="w-8 h-8 rounded-full bg-app-tertiary p-0.5">`
                : `<div class="w-8 h-8 rounded-full bg-app-brand text-white flex items-center justify-center font-bold text-xs flex-shrink-0">DOC</div>`;

            // HTML Opbouwen (let op volgorde avatar/bericht)
            let msgHtml = `
            <div class="flex items-start gap-3 ${align} mb-4">
                ${!isUser ? avatarDiv : ''}
                <div class="${color} p-3 rounded-lg shadow-sm text-sm max-w-[85%] prose prose-sm max-w-none dark:prose-invert">
                    ${isUser && msg.hasImage ? '<div class="mb-2"><span class="text-[10px] uppercase bg-white/20 px-1 rounded">📷 Image attached</span></div>' : ''}
                    ${isUser ? msg.text : marked.parse(msg.text)}
                </div>
                ${isUser ? avatarDiv : ''}
            </div>`;
            
            chatBox.insertAdjacentHTML('beforeend', msgHtml);
        });
        
        chatBox.scrollTop = chatBox.scrollHeight;
        showToast("History loaded.", "success");

    } catch(e) {
        console.error(e);
        showToast("Failed to load chat.", "error");
    }
}

// 4. Verwijder Gesprek
window.deleteMedicChat = async function(chatId) {
    if(!confirm("Delete this history?")) return;
    try {
        await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'medicChats', chatId));
        window.toggleMedicHistory(); // Ververs lijst
        if(currentChatId === chatId) window.resetTroubleshootChat(); // Reset scherm als deze open stond
    } catch(e) { console.error(e); }
}

// 5. Foto Selectie Handling (Ongewijzigd)
window.handleChatImageSelect = function(input) {
    if (input.files && input.files) {
        const reader = new FileReader();
        reader.onload = function(e) {
            // CORRECTIE: Extractie van de base64-string via de chat-veilige .at(1) methodiek
            currentChatImageBase64 = e.target.result.split(',').at(1); 
            document.getElementById('chat-preview-img').src = e.target.result;
            document.getElementById('chat-image-preview').classList.remove('hidden');
        }
        reader.readAsDataURL(input.files);
    }
}

window.clearChatImage = function() {
    currentChatImageBase64 = null;
    document.getElementById('chat-image-input').value = '';
    document.getElementById('chat-image-preview').classList.add('hidden');
}

// 6. Bericht Versturen (MET AUTO-SAVE)
window.sendTroubleshootMessage = async function() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    const chatBox = document.getElementById('chat-history');
    const sendBtn = document.getElementById('chat-send-btn');

    if (!text && !currentChatImageBase64) return;

    // A. Render USER bericht
    let userHtml = `<div class="flex items-start gap-3 justify-end animate-fade-in mb-4">
        <div class="bg-blue-600 text-white p-3 rounded-lg rounded-tr-none shadow-sm text-sm max-w-[85%]">
            ${currentChatImageBase64 ? '<div class="mb-2"><span class="text-[10px] uppercase bg-white/20 px-1 rounded">📷 Image attached</span></div>' : ''}
            ${text}
        </div>
        <img src="logo.png" onerror="this.src='favicon.png'" alt="Me" class="w-8 h-8 rounded-full bg-app-tertiary flex-shrink-0 object-contain border border-app-brand/20 p-0.5">
    </div>`;
    chatBox.insertAdjacentHTML('beforeend', userHtml);
    
    // Voeg toe aan tijdelijke geschiedenis
    chatHistory.push({ role: "user", text: text, hasImage: !!currentChatImageBase64 });

    // UI Updates
    input.value = '';
    const imageToSend = currentChatImageBase64; 
    window.clearChatImage();
    chatBox.scrollTop = chatBox.scrollHeight;
    sendBtn.disabled = true;

    // B. Render AI 'Typing...'
    const loadingId = 'loading-' + Date.now();
    chatBox.insertAdjacentHTML('beforeend', `
        <div id="${loadingId}" class="flex items-start gap-3 animate-pulse mb-4">
            <div class="w-8 h-8 rounded-full bg-app-brand text-white flex items-center justify-center font-bold text-xs">DOC</div>
            <div class="bg-gray-100 dark:bg-gray-700 p-3 rounded-lg rounded-tl-none text-xs text-gray-500">Thinking...</div>
        </div>
    `);
    chatBox.scrollTop = chatBox.scrollHeight;

    // C. API Call
    try {
        const response = await performChatApiCall(chatHistory, imageToSend);
        
        document.getElementById(loadingId).remove();

        const aiHtml = `<div class="flex items-start gap-3 animate-fade-in mb-4">
            <div class="w-8 h-8 rounded-full bg-app-brand text-white flex items-center justify-center font-bold text-xs flex-shrink-0">DOC</div>
            <div class="bg-white dark:bg-gray-800 p-3 rounded-lg rounded-tl-none shadow-sm text-sm text-app-header border border-gray-100 dark:border-gray-700 max-w-[90%] prose prose-sm max-w-none dark:prose-invert">
                ${marked.parse(response)}
            </div>
        </div>`;
        
        chatBox.insertAdjacentHTML('beforeend', aiHtml);
        chatHistory.push({ role: "model", text: response }); 

        // --- D. AUTO-SAVE LOGIC ---
        if (state.userId) {
            const chatData = {
                updatedAt: new Date().toISOString(),
                messages: chatHistory
            };

            // Als dit een nieuw gesprek is, verzin een titel
            if (!currentChatId) {
                // Titel is de eerste 5 woorden van de user input
                const title = chatHistory[0].text.split(' ').slice(0, 6).join(' ') + '...';
                chatData.title = title;
                chatData.createdAt = new Date().toISOString();
                
                const docRef = await addDoc(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'medicChats'), chatData);
                currentChatId = docRef.id;
            } else {
                // Update bestaand gesprek
                await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'medicChats', currentChatId), chatData);
            }
        }

    } catch (error) {
        document.getElementById(loadingId)?.remove();
        chatBox.insertAdjacentHTML('beforeend', `<div class="text-center text-red-500 text-xs my-2">Error: ${error.message}</div>`);
    } finally {
        sendBtn.disabled = false;
        chatBox.scrollTop = chatBox.scrollHeight;
        input.focus(); 
    }
}

// 7. De Speciale API functie (Ongewijzigd)
async function performChatApiCall(history, base64Image) {
    let apiKey = state.userSettings.apiKey;
    if (!apiKey && typeof CONFIG !== 'undefined') apiKey = CONFIG.firebase.apiKey;
    if (!apiKey) throw new Error("No API Key");

    let model = "gemini-2.0-flash"; 
    if (state.userSettings.chatModel) model = state.userSettings.chatModel;
    else if (state.userSettings.aiModel) model = state.userSettings.aiModel;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    let promptContext = "You are an expert Mead Troubleshooter. Be concise, helpful, and scientific. Keep answers under 150 words unless asked for detail.\n\nCONVERSATION HISTORY:\n";
    history.forEach(msg => {
        promptContext += `${msg.role === 'user' ? 'USER' : 'AI'}: ${msg.text} ${msg.hasImage ? '[User uploaded an image]' : ''}\n`;
    });
    promptContext += `\nUSER'S NEWEST INPUT: `; 

    const parts = [{ text: promptContext }];
    if (base64Image) {
        parts.push({ inline_data: { mime_type: "image/jpeg", data: base64Image } });
    }

    const requestBody = { contents: [{ parts: parts }] };

    const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        if (response.status === 429) throw new Error("⛔ QUOTA BEREIKT: Je hebt te snel/veel gechat.");
        const errData = await response.json().catch(() => ({}));
        throw new Error(`AI Error (${response.status}): ${errData.error?.message || response.statusText}`);
    }
    const data = await response.json();
    // CORRECTIE: Extractie van de content-tekst via de chat-veilige .at(0) methodiek
    return data.candidates.at(0).content.parts.at(0).text;
}

window.clearChatImage = function() {
    currentChatImageBase64 = null;
    document.getElementById('chat-image-input').value = '';
    document.getElementById('chat-image-preview').classList.add('hidden');
}

window.fetchAvailableModels = async function() {
    const apiKey = document.getElementById('apiKeyInput').value.trim();
    const textSelect = document.getElementById('aiModelInput');
    const chatSelect = document.getElementById('chatModelInput');
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

        // --- 1.5 FORCEER THINKING MODEL (Handmatige injectie) ---
        // Dit ontbrak in je bestand:
        const thinkingModelId = "models/gemini-2.0-flash-thinking-exp-01-21"; 
        
        // Check of hij er al tussen staat, zo niet: voeg toe
        if (!textModels.some(m => m.name === thinkingModelId)) {
            textModels.push({ name: thinkingModelId });
        }
        // Voeg ook de generieke pointer toe (veiliger voor toekomst)
        if (!textModels.some(m => m.name === "models/gemini-2.0-flash-thinking-exp")) {
            textModels.push({ name: "models/gemini-2.0-flash-thinking-exp" });
        }
        // -------------------------------------------------------

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
            opt.text = cleanName.includes('thinking') ? `🧠 ${cleanName}` : cleanName;
            textSelect.appendChild(opt);
        });

        // --- VUL DROPDOWN 2: CHAT ENGINE ---
        chatSelect.innerHTML = '';
        textModels.forEach(model => {
            const cleanName = model.name.replace('models/', '');
            const opt = document.createElement('option');
            opt.value = cleanName;
            opt.text = cleanName.includes('thinking') ? `🧠 ${cleanName}` : cleanName;
            chatSelect.appendChild(opt);
        });

        // Herstel saved values
        if (state.userSettings.aiModel) textSelect.value = state.userSettings.aiModel;
        if (state.userSettings.chatModel) chatSelect.value = state.userSettings.chatModel;

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
        if (state.userSettings.imageModel) imageSelect.value = state.userSettings.imageModel;

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
// --- SOCIAL MEDIA ---

function populateSocialRecipeDropdown() {
    const select = document.getElementById('social-recipe-select');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">-- Choose a Recipe --</option>';
    
    // FIX: Gebruik state.brews
    if (state.brews) {
        state.brews.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.id;
            opt.textContent = b.recipeName;
            select.appendChild(opt);
        });
    }
    select.value = current;
}

// --- SOCIAL MEDIA STUDIO 2.0 LOGIC (MIX & MATCH UPDATE) ---

// 1. Helper: Laad Styles + "No Image" optie
window.loadSocialStyles = async function() {
    if (!state.userId) return;
    const select = document.getElementById('social-art-style');
    if (!select) return;

    try {
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'labelAssets');
        const docSnap = await getDoc(docRef);
        
        // Reset de lijst met de basis opties
        select.innerHTML = `
            <option value="none">🚫 No Image (Text Only)</option>
            <option value="persona">✨ Match Persona Vibe (Auto)</option>
        `;
        
        if (docSnap.exists() && docSnap.data().styles) {
            // Voeg een scheidingslijn toe
            const group = document.createElement('optgroup');
            group.label = "My Custom Art Styles";
            
            docSnap.data().styles.forEach(style => {
                const opt = document.createElement('option');
                opt.value = style.prompt; // De art style prompt (bv. "Pearl Jam Poster style, grunge...")
                opt.textContent = style.name; // De naam (bv. "Pearl Jam")
                group.appendChild(opt);
            });
            select.appendChild(group);
        }
    } catch (e) {
        console.warn("Could not load styles for social:", e);
    }
}

// 2. TEKST GENEREREN (Nu met Style Injectie)
async function runSocialMediaGenerator() {
    // 1. UI INITIALISATIE & CREDIT CHECK
    const actionWrapper = document.getElementById('social-action-wrapper');
    const creditCountSpan = document.getElementById('social-credit-count');
    const container = document.getElementById('social-content-container');
    const imageBtn = document.getElementById('generate-social-image-btn');

    try {
        if (actionWrapper) actionWrapper.classList.remove('hidden');
        
        let credits = state.userSettings?.credits;
        if (credits !== undefined && credits !== null && credits <= 0) {
            showToast("Geen credits meer beschikbaar.", "error");
            return;
        }

        if (creditCountSpan) {
            creditCountSpan.textContent = (credits === undefined || credits === null) ? "∞" : credits;
        }

        // 2. INPUT VALIDATIE
        const brewId = document.getElementById('social-recipe-select').value;
        const persona = document.getElementById('social-persona').value;
        const platform = document.getElementById('social-platform').value;
        const tweak = document.getElementById('social-tweak').value;
        const selectedStyleValue = document.getElementById('social-art-style').value;
        
        if (!brewId && !tweak) { 
            showToast("Selecteer een recept of typ een onderwerp.", "error"); 
            return; 
        }

        // 3. AI GENERATIE VOORBEREIDING
        if (container) container.innerHTML = getLoaderHtml(`Channeling ${persona}...`);
        if (imageBtn) imageBtn.classList.add('hidden');

        let context = "";
        if (brewId) {
            const brew = state.brews.find(b => b.id === brewId);
            if (!brew) {
                showToast("Geselecteerd recept niet gevonden.", "error");
                if (container) container.innerHTML = "";
                return;
            }
            const abv = brew.logData?.finalABV || brew.logData?.targetABV || "approx 12%";
            context = `**PRODUCT:** Mead (Honey Wine). NAME: ${brew.recipeName}. STATS: ABV ${abv}. RECIPE: ${brew.recipeMarkdown ? brew.recipeMarkdown.substring(0, 500) : 'No recipe text'}... USER NOTES: ${tweak}`;
        } else {
            context = `**TOPIC:** ${tweak}`;
        }

        let toneInstruction = "";
        switch (persona) {
            case 'Ryan Reynolds': toneInstruction = `TONE: Ryan Reynolds. Witty, sarcastic, meta-humor, high energy.`; break;
            case 'Dry British': toneInstruction = `TONE: Dry British. Understated, cynical, charming, "splendid".`; break;
            case 'The Sommelier': toneInstruction = `TONE: Sommelier. Elegant, sensory-focused, premium vocabulary.`; break;
            default: toneInstruction = `TONE: Viking. Bold, loud, enthusiastic, glory & feasts.`; break;
        }

        let imageInstruction = (selectedStyleValue === 'none') 
            ? `**IMAGE RULE:** Do NOT generate an image prompt.` 
            : `**IMAGE PROMPT GENERATION:** 1. Generate an AI prompt at the end. 2. Style: "${selectedStyleValue === 'persona' ? persona + ' vibe' : selectedStyleValue}". 3. Format: Start line with "IMG_PROMPT: "`;

        const prompt = `You are a Social Media Manager.\n\n${context}\n${toneInstruction}\nFORMAT: ${platform === 'Untappd' ? 'Short flavor review.' : 'Instagram caption.'}\n\n${imageInstruction}\n\nOutput ONLY text.`;
        
        // 4. API CALL & PARSING
        const rawText = await performApiCall(prompt);
        let finalPost = rawText;
        let imgPrompt = "";

        if (rawText.includes("IMG_PROMPT:")) {
            const parts = rawText.split("IMG_PROMPT:");
            // CORRECTIE: Elementen uit de parts-array geïsoleerd via de stabiele .at() indexatie
            finalPost = parts.at(0).trim(); 
            imgPrompt = parts.at(1).trim(); 
        }

        finalPost = finalPost.replace(/^["']|["']$/g, '').trim();
        
        // 5. CREDIT CONSUMPTION & FIRESTORE UPDATE
        if (state.userId && credits !== undefined && credits !== null) {
            const newCredits = Math.max(0, credits - 1);
            await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main'), {
                credits: newCredits
            });
            state.userSettings.credits = newCredits;
            if (creditCountSpan) creditCountSpan.textContent = newCredits;
        }

        // Renderen
        if (container) {
            container.innerHTML = `<div class="prose prose-sm dark:prose-invert max-w-none">${marked.parse(finalPost)}</div>`;
        }
        
        // 6. AFBEELDING ACTIVATIE
        if (imgPrompt && selectedStyleValue !== 'none' && imageBtn) {
            imageBtn.classList.remove('hidden');
            imageBtn.onclick = () => window.generateSocialImage(imgPrompt);
        }

        showToast("Social Studio geladen", "success");

    } catch (error) {
        window.logSystemError(error, 'SocialMedia: runGenerator', 'ERROR');
        showToast("Fout bij laden Social Studio: " + error.message, "error");
        if (container) container.innerHTML = "";
    }
}

// 3. PLAATJE GENEREREN (Simpel & Direct)
window.generateSocialImage = async function(finalPrompt) {
    const container = document.getElementById('social-image-container');
    const btn = document.getElementById('generate-social-image-btn');
    
    let apiKey = state.userSettings.apiKey;
    if (!apiKey && typeof CONFIG !== 'undefined' && CONFIG.firebase) apiKey = CONFIG.firebase.apiKey;
    if (!apiKey) { showToast("No API Key.", "error"); return; }

    if (container) {
        container.innerHTML = `<div class="loader"></div><p class="text-xs text-center mt-2 text-app-secondary animate-pulse">Painting...</p>`;
    }
    if (btn) btn.classList.add('hidden'); // Verberg knop tijdens genereren

    const model = state.userSettings.imageModel || "imagen-3.0-generate-001";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;

    const requestBody = {
        instances: [{ prompt: finalPrompt }],
        parameters: { sampleCount: 1, aspectRatio: "1:1" }
    };

    try {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
        if (!response.ok) throw new Error("Google Image API Error");
        
        const data = await response.json();
        
        // CORRECTIE: Optionele chaining en array-extractie volledig omgebouwd naar de chat-veilige .at(0) methodiek
        if (data && data.predictions && data.predictions.length > 0 && data.predictions.at(0)?.bytesBase64Encoded) {
            const base64Img = data.predictions.at(0).bytesBase64Encoded;
            if (container) container.innerHTML = `<img src="data:image/png;base64,${base64Img}" class="w-full h-full object-cover rounded-xl shadow-inner animate-fade-in">`;
        } else {
            throw new Error("No image data received.");
        }
    } catch (e) {
        console.error(e);
        if (container) container.innerHTML = `<p class="text-red-500 text-xs p-4">${e.message}</p>`;
        // Toon knop weer als het mislukt, zodat je opnieuw kunt proberen
        if (btn) btn.classList.remove('hidden'); 
    }
};

// (Verwijder window.toggleSocialStyleSelect uit de exports want die bestaat niet meer)

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
        await updateDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId), {
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

// Water Management
function handleWaterSourceChange() {
    try {
        const select = document.getElementById('waterSource');
        if (!select) return;

        const val = select.value;
        if (!val) return;

        const [type, id] = val.split('_');
        let profile;
        
        if (type === 'builtin') {
            profile = BUILT_IN_WATER_PROFILES[id];
        } else if (type === 'user') {
            profile = userWaterProfiles.find(p => p.id === id);
        }

        if (profile) {
            window.currentWaterProfile = profile;
            updateWaterProfileDisplay(profile);
        }
    } catch (error) {
        window.logSystemError(error, 'WaterTools: handleSourceChange', 'ERROR');
        showToast("Fout bij selecteren waterprofiel.", "error");
    }
}

function updateWaterProfileDisplay(profile) {
    ['ca', 'mg', 'na', 'so4', 'cl', 'hco3'].forEach(k => {
        document.getElementById(`val-${k}`).textContent = profile[k];
    });
}

const BUILT_IN_WATER_PROFILES = { 
    spa: { name: 'Spa Reine', ca: 5, mg: 2, na: 3, so4: 4, cl: 5, hco3: 17 },
    chaudfontaine: { name: 'Chaudfontaine', ca: 65, mg: 18, na: 44, so4: 40, cl: 35, hco3: 305 },
};

// --- CALCULATORS ---
window.calculateABV = function() {
    try {
        const ogVal = document.getElementById('og')?.value.replace(/,/g, '.');
        const fgVal = document.getElementById('fg')?.value.replace(/,/g, '.');
        const og = parseFloat(ogVal);
        const fg = parseFloat(fgVal);
        const resultDiv = document.getElementById('abvResult');

        if (isNaN(og) || isNaN(fg)) {
            window.showToast("Voer zowel OG als FG in.", "error");
            return;
        }

        if (og >= 1.775) {
            window.showToast("Hall Limit: OG te hoog (max 1.774).", "error");
            return; // CRITICAL FIX: Stop executie
        }

        const abw = (76.08 * (og - fg)) / (1.775 - og);
        const abv = abw / 0.794;

        if (resultDiv) {
            resultDiv.innerHTML = `<span class="text-2xl font-bold">${abv.toFixed(2)}%</span> <span class="text-[10px] opacity-60">ABV</span>`;
            resultDiv.classList.remove('hidden');
        }
    } catch (error) {
        window.logSystemError(error, 'tools.js: calculateABV', 'ERROR');
        window.showToast("Fout bij het uitvoeren van de berekening. Controleer de invoerwaarden.", "error");
    }
};

window.correctHydrometer = function() {
    try {
        const sgInput = document.getElementById('sgReading')?.value.replace(/,/g, '.') || "";
        const tInput = document.getElementById('tempReading')?.value.replace(/,/g, '.') || "";
        const cInput = document.getElementById('calTemp')?.value.replace(/,/g, '.') || "";
        
        const sg = parseFloat(sgInput);
        const t = parseFloat(tInput);
        const c = parseFloat(cInput);
        const resultDiv = document.getElementById('sgResult');

        if (t > 40) {
            window.showToast("⚠️ Waarschuwing: Temperatuur > 40°C. Gebruik Celsius.", "warning");
        }

        if (isNaN(sg) || isNaN(t) || isNaN(c)) {
            window.showToast("Vul alle velden in.", "error");
            return;
        }

        const correctedSg = sg * (
            (1.00130346 - 0.000134722124 * t + 0.00000204052596 * Math.pow(t, 2) - 0.00000000232820948 * Math.pow(t, 3)) / 
            (1.00130346 - 0.000134722124 * c + 0.00000204052596 * Math.pow(c, 2) - 0.00000000232820948 * Math.pow(c, 3))
        );

        if (resultDiv) {
            resultDiv.textContent = `Corrected: ${correctedSg.toFixed(3)}`;
        }
    } catch (error) {
        window.logSystemError(error, 'Calculator: Hydrometer Correction', 'ERROR');
        window.showToast("Fout bij het uitvoeren van de berekening. Controleer de invoerwaarden.", "error");
    }
};

window.calculatePrimingSugar = function() {
    try {
        const getVal = (id) => parseFloat(document.getElementById(id)?.value.replace(/,/g, '.')) || NaN;
        
        const vol = getVal('carbVol');
        const temp = getVal('carbTemp');
        const size = getVal('carbBatchSize');
        const resultDiv = document.getElementById('sugarResult');

        if (isNaN(vol) || isNaN(temp) || isNaN(size)) { 
            window.showToast("Vul alle velden in voor suikerberekening.", "error");
            return; 
        }

        // Priming Equation v2.6
        const sugarGrams = (vol - (3.0378 - 0.050062 * temp + 0.00026555 * Math.pow(temp, 2))) * 4 * size;
        
        if (resultDiv) {
            resultDiv.textContent = `${Math.max(0, sugarGrams).toFixed(1)} g sugar`;
            resultDiv.classList.remove('hidden');
        }
    } catch (error) {
        window.logSystemError(error, 'tools.js: calculatePrimingSugar', 'ERROR');
        window.showToast("Fout bij het uitvoeren van de berekening. Controleer de invoerwaarden.", "error");
    }
};

window.addBlendingRow = function(idSuffix) {
    try {
        const container = document.getElementById(`blending-rows-${idSuffix}`);
        if (!container) return;

        const rowId = Date.now();
        const tr = document.createElement('tr');
        tr.id = `blend-row-${rowId}`;
        tr.className = "border-b border-app-brand/10 bg-app-primary/5";

        tr.innerHTML = `
            <td class="p-2"><input type="number" step="0.1" placeholder="L" class="w-full bg-transparent text-sm focus:outline-none" oninput="this.value = this.value.replace(',', '.'); window.calculateBlend('${idSuffix}')"></td>
            <td class="p-2"><input type="number" step="0.1" placeholder="%" class="w-full bg-transparent text-sm focus:outline-none" oninput="this.value = this.value.replace(',', '.'); window.calculateBlend('${idSuffix}')"></td>
            <td class="p-2"><input type="number" step="0.001" placeholder="SG" class="w-full bg-transparent text-sm focus:outline-none" oninput="this.value = this.value.replace(',', '.'); window.calculateBlend('${idSuffix}')"></td>
            <td class="p-2"><input type="number" step="0.01" placeholder="pH" class="w-full bg-transparent text-sm focus:outline-none" oninput="this.value = this.value.replace(',', '.'); window.calculateBlend('${idSuffix}')"></td>
            <td class="p-2 text-right"><button onclick="this.closest('tr').remove(); window.calculateBlend('${idSuffix}')" class="text-red-500 hover:text-red-700 text-lg">&times;</button></td>
        `;
        container.appendChild(tr);
    } catch (error) {
        window.logSystemError(error, 'tools.js: addBlendingRow', 'ERROR');
    }
};

// --- BLENDING & SPLIT BATCH REPAIRS (v2.6 STANDARDS) ---

window.calculateBlend = function() {
    try {
        const mode = document.getElementById('blend_mode')?.value || 'manual';
        const resultDiv = document.getElementById('blendResult');
        
        let totalVolume = 0;
        let weightedAbvSum = 0;
        let weightedSgSum = 0;
        let totalHydrogenGrams = 0; 

        if (mode === 'manual') {
            const v1 = parseFloat(String(document.getElementById('blend_v1')?.value || '0').replace(/,/g, '.')) || 0;
            const abv1 = parseFloat(String(document.getElementById('blend_abv1')?.value || '0').replace(/,/g, '.')) || 0;
            const sg1 = parseFloat(String(document.getElementById('blend_sg1')?.value || '1.000').replace(/,/g, '.')) || 1.000;
            const ph1 = parseFloat(String(document.getElementById('blend_ph1')?.value || '3.6').replace(/,/g, '.')) || 3.6;

            const v2 = parseFloat(String(document.getElementById('blend_v2')?.value || '0').replace(/,/g, '.')) || 0;
            const abv2 = parseFloat(String(document.getElementById('blend_abv2')?.value || '0').replace(/,/g, '.')) || 0;
            const sg2 = parseFloat(String(document.getElementById('blend_sg2')?.value || '1.000').replace(/,/g, '.')) || 1.000;
            const ph2 = parseFloat(String(document.getElementById('blend_ph2')?.value || '3.6').replace(/,/g, '.')) || 3.6;

            totalVolume = v1 + v2;
            if (totalVolume > 0) {
                weightedAbvSum = (v1 * abv1) + (v2 * abv2);
                weightedSgSum = (v1 * sg1) + (v2 * sg2);
                totalHydrogenGrams = (v1 * Math.pow(10, -ph1)) + (v2 * Math.pow(10, -ph2));
            }
        } else {
            const tableRows = document.querySelectorAll('#blendTableBody tr');
            
            tableRows.forEach(row => {
                const inputs = row.querySelectorAll('input');
                if (inputs.length >= 4) {
                    // CORRECTIE: NodeList indexering hersteld via de verplichte .item(index) methodiek
                    const v = parseFloat(String(inputs.item(0).value || '0').replace(/,/g, '.')) || 0;
                    const abv = parseFloat(String(inputs.item(1).value || '0').replace(/,/g, '.')) || 0;
                    const sg = parseFloat(String(inputs.item(2).value || '1.000').replace(/,/g, '.')) || 1.000;
                    const ph = parseFloat(String(inputs.item(3).value || '3.6').replace(/,/g, '.')) || 3.6;

                    totalVolume += v;
                    weightedAbvSum += (v * abv);
                    weightedSgSum += (v * sg);
                    totalHydrogenGrams += (v * Math.pow(10, -ph));
                }
            });
        }

        if (totalVolume <= 0) {
            if (resultDiv) resultDiv.innerHTML = `<span class="text-xs text-on-surface-variant">Voer volumes in om de blend te berekenen.</span>`;
            return;
        }

        const finalAbv = weightedAbvSum / totalVolume;
        const finalSg = weightedSgSum / totalVolume;
        
        let finalPh = 3.6;
        if (totalHydrogenGrams > 0) {
            const calculatedPhValue = -Math.log10(totalHydrogenGrams / totalVolume);
            if (isFinite(calculatedPhValue) && !isNaN(calculatedPhValue)) {
                finalPh = calculatedPhValue;
            }
        }

        if (finalSg >= 1.775) {
            window.showToast("Kritieke fout: De berekende SG overschrijdt de Hall-limiet (1.775).", "error");
            if (resultDiv) resultDiv.innerHTML = `<span class="text-error font-bold">LIMIT ERR</span>`;
            return;
        }

        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="p-4 bg-primary-container rounded-xl border border-primary/20 shadow-sm animate-fade-in">
                    <div class="text-[10px] uppercase font-bold tracking-widest text-primary mb-2">Predicted Blend Profile</div>
                    <div class="space-y-1 text-sm text-on-surface">
                        <div class="flex justify-between border-b border-outline-variant/30 pb-1">
                            <span>Total Volume:</span> <span class="font-mono font-bold text-primary">${totalVolume.toFixed(2)} L</span>
                        </div>
                        <div class="flex justify-between text-xs pt-1">
                            <span>Blend ABV:</span> <span class="font-mono font-bold">${finalAbv.toFixed(2)}%</span>
                        </div>
                        <div class="flex justify-between text-xs">
                            <span>Blend Gravity (SG):</span> <span class="font-mono font-bold">${finalSg.toFixed(4)}</span>
                        </div>
                        <div class="flex justify-between text-xs">
                            <span>Blend pH:</span> <span class="font-mono font-bold">${finalPh.toFixed(2)}</span>
                        </div>
                    </div>
                </div>
            `;
            resultDiv.classList.remove('hidden');
        }

    } catch (error) {
        window.logSystemError(error, 'Tools: Blending Engine', 'ERROR');
        window.showToast("Fout bij het berekenen van de blend. Controleer de invoerwaarden.", "error");
    }
};

window.calculateBacksweetening = function() {
    try {
        // 1. Comma-to-Dot protocol (v2.6)
        const volInput = document.getElementById('bs_current_vol')?.value.replace(/,/g, '.') || "";
        const currentSgInput = document.getElementById('bs_current_sg')?.value.replace(/,/g, '.') || "";
        const targetSgInput = document.getElementById('bs_target_sg')?.value.replace(/,/g, '.') || "";

        const vol = parseFloat(volInput);
        const currentSg = parseFloat(currentSgInput);
        const targetSg = parseFloat(targetSgInput);
        const resultDiv = document.getElementById('backsweetenResult');

        if (isNaN(vol) || isNaN(currentSg) || isNaN(targetSg)) { 
            window.showToast("Vul alle waarden in.", "error");
            return; 
        }

        // 2. Hall-veiligheidscheck
        if (currentSg >= 1.775 || targetSg >= 1.775) {
            window.showToast("Fysieke limiet overschreden (1.775).", "error");
            window.logSystemError(`Backsweetening: SG ${currentSg}/${targetSg} >= 1.775`, 'Tools: Backsweeten', 'CRITICAL');
            return;
        }

        // 3. Bates-polynoom: SG naar Brix conversie
        const getBrix = (sg) => (182.9622 * Math.pow(sg, 3)) - (777.3009 * Math.pow(sg, 2)) + (1264.5170 * sg) - 670.1831;
        
        const currentBrix = getBrix(currentSg);
        const targetBrix = getBrix(targetSg);

        // 4. Volledige Bates-v2.6 Honingberekening inclusief TargetSG
        // Formule: DeltaBrix * 0.0125 (suiker-constante) * Vol * TargetSG * 1000 (naar gram)
        const honeyGrams = (targetBrix - currentBrix) * 0.0125 * vol * targetSg * 1000;
        const honeyKg = honeyGrams / 1000;

        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="p-4 bg-app-primary-container rounded-xl border border-app-brand/20 shadow-sm animate-fade-in">
                    <span class="block text-[10px] uppercase opacity-60 font-bold tracking-widest text-app-brand">Required Honey (Bates-v2.6)</span>
                    <span class="text-3xl font-bold text-app-brand font-header">${Math.round(honeyGrams)}g</span>
                    <div class="mt-2 pt-2 border-t border-app-brand/10 flex justify-between text-xs opacity-80">
                        <span>${honeyKg.toFixed(3)} kg</span>
                        <span>Δ Brix: ${(targetBrix - currentBrix).toFixed(1)}°</span>
                    </div>
                </div>
            `;
        }
    } catch (error) {
        window.logSystemError(error, 'Calculator: Backsweetening', 'ERROR');
        window.showToast("Fout bij berekening zoetheid.", "error");
    }
};

window.calculateDilution = function() {
    try {
        const getVal = (id) => parseFloat(document.getElementById(id)?.value.replace(/,/g, '.')) || NaN;

        const startVol = getVal('dil_start_vol');
        const startSg = getVal('dil_start_sg');
        const targetSg = getVal('dil_target_sg');
        const resultDiv = document.getElementById('dilutionResult');

        if (isNaN(startVol) || isNaN(startSg) || isNaN(targetSg)) { 
            window.showToast("Voer geldige SG en Volume waarden in.", "error");
            return; 
        }

        if (startSg <= targetSg) {
            window.showToast("Start SG moet hoger zijn dan Target SG.", "error");
            return;
        }

        const startPoints = (startSg * 1000) - 1000;
        const targetPoints = (targetSg * 1000) - 1000;
        
        if (targetPoints <= 0) return;

        const waterToAdd = startVol * (startPoints / targetPoints - 1);
        if (resultDiv) {
            resultDiv.textContent = `Add ${waterToAdd.toFixed(2)}L water`;
        }
    } catch (error) {
        window.logSystemError(error, 'tools.js: calculateDilution', 'ERROR');
    }
};

// --- PROACTIEVE BUFFER CALCULATOR (v2.6)  ---
window.calculateBuffer = function() {
    try {
        // 1. Inputs ophalen & Comma-to-Dot sanitisatie
        const volInput = document.getElementById('buffer_vol')?.value.replace(/,/g, '.') || "";
        const taCurrentInput = document.getElementById('buffer_ta_current')?.value.replace(/,/g, '.') || "";
        const taTargetInput = document.getElementById('buffer_ta_target')?.value.replace(/,/g, '.') || "";
        const currentPhInput = document.getElementById('buffer_ph_current')?.value.replace(/,/g, '.') || "";

        const vol = parseFloat(volInput);
        const taCurrent = parseFloat(taCurrentInput);
        const taTarget = parseFloat(taTargetInput);
        const currentPh = parseFloat(currentPhInput);
        const resultDiv = document.getElementById('bufferResult');

        if (isNaN(vol) || vol <= 0) {
            window.showToast("Voer een geldig volume in.", "error");
            return;
        }

        let htmlContent = "";

        // 2. MODUS DETECTIE: Proactief vs Correctief
        if (isNaN(taCurrent) || isNaN(taTarget)) {
            // --- PROACTIEVE MODUS (v2.6 Standaard) ---
            const proactiveGrams = 0.4 * vol;
            const dosePerLiter = proactiveGrams / vol;
            
            // Berekening Kalium-verhoging (v2.6 Cosmetische Update)
            const potassiumPpm = dosePerLiter * 523.07;
            
            // Kalium-check: minimaal 0.26 g/L K2CO3 voor ~300ppm
            let potassiumNote = dosePerLiter < 0.26 
                ? `<p class="mt-2 text-[9px] text-amber-600 font-bold uppercase">⚠️ Opmerking: Kaliumgehalte mogelijk onder 300 ppm drempel.</p>` 
                : `<p class="mt-2 text-[9px] text-green-600 font-bold uppercase">✓ Kalium verhoging: +${Math.round(potassiumPpm)} ppm K⁺</p>`;
            
            htmlContent = `
                <div class="p-4 bg-app-tertiary rounded-xl border border-app-brand/20 shadow-sm animate-fade-in">
                    <span class="block text-[10px] uppercase opacity-60 font-bold tracking-widest text-app-brand">Proactieve Buffer (K₂CO₃)</span>
                    <span class="text-3xl font-bold text-app-brand font-header">${proactiveGrams.toFixed(2)}g</span>
                    <p class="mt-2 text-[10px] opacity-80 uppercase leading-tight">Voorkomt pH-crash < 3.2 in honingmost.</p>
                    ${potassiumNote}
                </div>`;
        } else {
            // --- CORRECTIEVE MODUS (Delta TA) ---
            const deltaTA = Math.max(0, taCurrent - taTarget);
            const k2co3Grams = vol * deltaTA * 0.6; 
            const khco3Grams = vol * deltaTA * 0.9;
            
            const k2co3DosePerLiter = k2co3Grams / vol;
            const khco3DosePerLiter = khco3Grams / vol;

            // Berekening Kalium-verhoging (v2.6 Cosmetische Update)
            const ppmK2CO3 = k2co3DosePerLiter * 523.07;
            const ppmKHCO3 = khco3DosePerLiter * 361.20;

            // Veiligheidscheck: pH-Gevaar & Botulisme
            let warningHtml = "";
            if (currentPh > 4.2 && deltaTA > 0) {
                warningHtml = `
                    <div class="mt-3 p-2 bg-red-500/10 border border-red-500/30 rounded text-[10px] text-red-600 font-bold uppercase animate-pulse">
                        ⚠️ GEVAAR: pH > 4.2 gedetecteerd. Verdere reductie kan pH > 4.6 pushen. 
                        Risico op botulisme bij pH > 4.6 indien niet gecorrigeerd!
                    </div>`;
            }

            let potassiumNote = k2co3DosePerLiter < 0.26 
                ? `<p class="mt-2 text-[9px] text-amber-600 font-bold uppercase">⚠️ Opmerking: Kaliumgehalte (K₂CO₃) mogelijk onder 300 ppm drempel.</p>` 
                : `<p class="mt-2 text-[9px] text-green-600 font-bold uppercase">✓ Est. K⁺: +${Math.round(ppmK2CO3)} ppm (Carbonaat) / +${Math.round(ppmKHCO3)} ppm (Bicarbonaat)</p>`;

            htmlContent = `
                <div class="p-4 bg-app-primary-container rounded-xl border border-app-brand/20 shadow-sm animate-fade-in">
                    <span class="block text-[10px] uppercase opacity-60 font-bold tracking-widest text-app-brand">Correctieve Zuurreductie (ΔTA: ${deltaTA.toFixed(1)}g/L)</span>
                    <div class="grid grid-cols-2 gap-4 mt-2">
                        <div>
                            <span class="block text-[9px] font-bold opacity-70">K₂CO₃ (Carbonaat)</span>
                            <span class="text-xl font-bold text-app-brand">${k2co3Grams.toFixed(2)}g</span>
                        </div>
                        <div>
                            <span class="block text-[9px] font-bold opacity-70">KHCO₃ (Bicarbonaat)</span>
                            <span class="text-xl font-bold text-app-brand">${khco3Grams.toFixed(2)}g</span>
                        </div>
                    </div>
                    <p class="mt-3 text-[9px] italic opacity-70">Bicarbonaat (KHCO₃) zorgt voor minder agressieve schuimvorming.</p>
                    ${potassiumNote}
                    ${warningHtml}
                </div>`;
        }

        if (resultDiv) {
            resultDiv.innerHTML = htmlContent;
        }

    } catch (error) {
        window.logSystemError(error, 'tools.js: calculateBuffer', 'ERROR');
        window.showToast("Fout bij buffer-berekening.", "error");
    }
};

// --- TOSNA 3.0 CALCULATOR (v2.6 COMPLIANT) ---
window.calculateTOSNA = function() {
    try {
        const getVal = (id) => {
            const el = document.getElementById(id);
            return el ? parseFloat(el.value.replace(/,/g, '.')) : NaN;
        };
        
        const og = getVal('tosna_og');
        const vol = getVal('tosna_vol');
        const yeastKey = document.getElementById('tosna_yeast')?.value || 'medium';
        const resultDiv = document.getElementById('tosnaResult');

        if (isNaN(og) || isNaN(vol) || og < 1.000 || vol <= 0) {
            window.showToast("Voer een geldige OG (1.xxx) en Volume in.", "error");
            return;
        }

        const brixInit = (182.9622 * Math.pow(og, 3)) - (777.3009 * Math.pow(og, 2)) + (1264.5170 * og) - 670.1831;
        const factors = { 'low': 0.75, 'medium': 0.90, 'high': 1.25 };
        const fGist = factors[yeastKey] || 0.90;

        const yanNeed = 10 * brixInit * og * fGist;
        const totalFermaidO = (yanNeed / 160) * vol;

        // TOSNA 3.0 Pitch Rate Logic
        const pitchRateAdvice = og < 1.100 
            ? "💡 Pitch Rate: Use exactly 1g yeast per gallon (TOSNA 3.0)."
            : "💡 Pitch Rate: Standard dosage (2g/gal) recommended.";

        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="p-4 bg-primary/5 border-l-4 border-primary rounded-r-xl animate-fade-in">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-[10px] uppercase font-bold opacity-60 tracking-widest">TOSNA 3.0 Analysis</span>
                        <span class="bg-primary text-on-primary text-[8px] px-2 py-0.5 rounded-full font-bold">F_gist: ${fGist}</span>
                    </div>
                    <div class="grid grid-cols-2 gap-4 mb-3">
                        <div><p class="text-[9px] opacity-60 uppercase">YAN Target</p><p class="font-bold font-header text-lg">${Math.round(yanNeed)} ppm</p></div>
                        <div><p class="text-[9px] opacity-60 uppercase">Total Fermaid O</p><p class="font-bold font-header text-lg text-primary">${totalFermaidO.toFixed(2)}g</p></div>
                    </div>
                    <div class="pt-2 border-t border-primary/10 space-y-1">
                        <p class="text-[10px] font-medium italic text-on-surface/70">Dosing Schedule (4 steps):</p>
                        <p class="font-mono text-xs font-bold text-primary border-b border-primary/5 pb-1">${(totalFermaidO / 4).toFixed(2)}g at 24h, 48h, 72h, & 1/3 Sugar Break.</p>
                        <p class="text-[10px] font-bold text-secondary-onContainer pt-1">${pitchRateAdvice}</p>
                    </div>
                </div>
            `;
            resultDiv.classList.remove('hidden');
        }
    } catch (error) {
        window.logSystemError(error, 'tools.js: calculateTOSNA', 'ERROR');
        window.showToast("Fout bij TOSNA berekening.", "error");
    }
};

window.calculateTargetApparentBrix = function() {
    try {
        const getVal = (id) => parseFloat(document.getElementById(id)?.value.replace(/,/g, '.')) || NaN;
        const og = getVal('target_brix_og');
        const targetSg = getVal('target_brix_sg');
        
        // Priority: Input field > userSettings > Default 1.04
        const inputWcf = getVal('refract_wcf');
        const WCF = !isNaN(inputWcf) ? inputWcf : (state.userSettings?.wcf || 1.04);
        
        const resultDiv = document.getElementById('targetBrixResult');

        if (isNaN(og) || isNaN(targetSg)) {
            window.showToast("Voer OG en Target SG in.", "error");
            return;
        }

        const brixInit = (182.9622 * Math.pow(og, 3)) - (777.3009 * Math.pow(og, 2)) + (1264.5170 * og) - 670.1831;
        const wri_i = brixInit / WCF;
        const wri_f = (targetSg - 1.0 + 0.002349 * wri_i) / 0.006276;
        const displayBrix = wri_f * WCF;

        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="p-4 bg-primary-container rounded-xl border border-primary/20 shadow-sm">
                    <span class="block text-[10px] uppercase opacity-60 font-bold">Target Apparent Brix</span>
                    <span class="text-3xl font-bold text-primary">${displayBrix.toFixed(1)}°Bx</span>
                </div>`;
            resultDiv.classList.remove('hidden');
        }
    } catch (error) {
        window.logSystemError(error, 'tools.js: calculateTargetApparentBrix', 'ERROR');
        window.showToast("Fout bij het uitvoeren van de berekening. Controleer de invoerwaarden.", "error");
    }
};

window.calculateStabilization = function() {
    try {
        const getVal = (id) => parseFloat(document.getElementById(id)?.value.replace(/,/g, '.')) || NaN;
        const abv = getVal('stab_abv');
        const fg = getVal('stab_fg');
        const ph = getVal('stab_ph');
        const vol = getVal('stab_vol');
        const resultDiv = document.getElementById('stabilizationResult');

        if (isNaN(abv) || isNaN(fg) || isNaN(ph) || isNaN(vol)) {
            window.showToast("Vul alle waarden in.", "error");
            return;
        }

        // Hall-safety pre-check (App_Context v2.6)
        if (fg >= 1.775) {
            window.showToast("Hall Limit: FG te hoog.", "error");
            return;
        }

        const residualBrix = (182.9622 * Math.pow(fg, 3)) - (777.3009 * Math.pow(fg, 2)) + (1264.5170 * fg) - 670.1831;
        const delleUnits = (4.5 * abv) + residualBrix;
        
        // STRIKTE DELLE-LIMIET & PHYSIOLOGISCHE WETMATIGHEID v2.6 VERIFICATIE
        const isStable = delleUnits >= 78.0 || abv >= 15.0;

        // Piecewise Sorbate Scale (Auditor Model)
        let sorbateMgL = 200;
        if (abv < 10) sorbateMgL = 200;
        else if (abv >= 10 && abv < 11) sorbateMgL = 200 - (abv - 10) * 35;
        else if (abv >= 11 && abv < 12) sorbateMgL = 165 - (abv - 11) * 30;
        else if (abv >= 12 && abv < 13) sorbateMgL = 135 - (abv - 12) * 35;
        else if (abv >= 13 && abv < 14) sorbateMgL = 100 - (abv - 13) * 35;
        else if (abv >= 14 && abv < 15) sorbateMgL = 65 - (abv - 14) * 15;
        else sorbateMgL = 50;

        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="p-4 rounded-2xl border ${isStable ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'} animate-fade-in">
                    <p class="text-center font-bold text-sm mb-3">${isStable ? '✅ MOLECULAR STABLE' : '⚠️ STABILIZATION REQUIRED'}</p>
                    <div class="grid grid-cols-2 gap-4 text-center mb-3">
                        <div><p class="text-[9px] uppercase opacity-60">Delle Units</p><p class="text-xl font-bold">${delleUnits.toFixed(1)}</p></div>
                        <div><p class="text-[9px] uppercase opacity-60">Residual Brix</p><p class="text-xl font-bold">${residualBrix.toFixed(1)}°</p></div>
                    </div>
                    <div class="pt-2 border-t border-black/5">
                        <div class="flex justify-between text-sm"><span>K-Sorbate:</span><span class="font-bold">${((sorbateMgL * vol) / 1000).toFixed(2)}g</span></div>
                        <p class="text-[8px] italic mt-1 opacity-70">*Target: ${Math.round(sorbateMgL)} ppm (Auditor Piecewise Model).</p>
                    </div>
                </div>`;
            resultDiv.classList.remove('hidden');
        }
    } catch (error) {
        window.logSystemError(error, 'tools.js: calculateStabilization', 'ERROR');
        window.showToast("Fout bij het uitvoeren van de berekening. Controleer de invoerwaarden.", "error");
    }
};

window.calculateRefractometerCorrection = function() {
    try {
        const getVal = (id, fallback) => {
            const val = document.getElementById(id)?.value.replace(/,/g, '.');
            return val ? parseFloat(val) : fallback;
        };

        const ri_i = getVal('refract_ob', NaN);
        const ri_f = getVal('refract_cb', NaN);
        const wcf = getVal('refract_wcf', 1.04);
        const resultDiv = document.getElementById('refractResult');

        if (isNaN(ri_i) || isNaN(ri_f)) {
            window.showToast("Vul beide Brix-waarden in.", "error");
            return;
        }

        const wri_i = ri_i / wcf;
        const wri_f = ri_f / wcf;
        const finalFG = 1.0 - (0.002349 * wri_i) + (0.006276 * wri_f);

        // ABV via Hall Equation
        const finalOG = (ri_i > 1.2) ? 
            (0.0000000578503 * Math.pow(ri_i, 3)) + (0.0000127414 * Math.pow(ri_i, 2)) + (0.00384577 * ri_i) + 1.0000 : ri_i;

        if (finalOG >= 1.775) {
             window.showToast("Hall Limit Error: OG te hoog.", "error");
             return; // CRITICAL FIX: Stop executie
        }

        let abv = 0;
        if (finalOG > finalFG) {
            const abw = (76.08 * (finalOG - finalFG)) / (1.775 - finalOG);
            abv = abw / 0.794;
        }

        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="grid grid-cols-2 gap-4 p-2">
                    <div><p class="text-[10px] uppercase opacity-60">True FG</p><p class="font-bold">${finalFG.toFixed(3)}</p></div>
                    <div><p class="text-[10px] uppercase opacity-60">Est. ABV</p><p class="font-bold">${abv.toFixed(2)}%</p></div>
                </div>
            `;
            resultDiv.classList.remove('hidden');
        }
    } catch (error) {
        window.logSystemError(error, 'tools.js: calculateRefractometerCorrection', 'ERROR');
        window.showToast("Fout bij het uitvoeren van de berekening. Controleer de invoerwaarden.", "error");
    }
};

// Helpers om vanuit een recept naar een calculator te springen
window.linkToBacksweetenCalc = function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew || !brew.logData) return;
    switchMainView('tools');
    switchSubView('calculators', 'tools-main-view');
    document.getElementById('bs_current_vol').value = brew.batchSize || '';
    document.getElementById('bs_current_sg').value = brew.logData.actualFG || brew.logData.targetFG || '';
    document.getElementById('bs_current_vol').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

window.linkToDilutionCalc = function(brewId) {
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew || !brew.logData) return;
    switchMainView('tools');
    switchSubView('calculators', 'tools-main-view');
    document.getElementById('dil_start_vol').value = brew.batchSize || '';
    document.getElementById('dil_start_sg').value = brew.logData.actualOG || brew.logData.targetOG || '';
    document.getElementById('dil_start_vol').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function exportHistory() {
    const data = state.brews.map(b => ({...b, createdAt: b.createdAt.toDate().toISOString()}));
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'meandery_history.json';
    a.click();
}

async function exportInventory() {
    const blob = new Blob([JSON.stringify(state.inventory, null, 2)], {type: 'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'meandery_inventory.json';
    a.click();
}

async function clearCollection(collectionName) {
    if (!state.userId) return false;
    const appId = 'meandery-aa05e';
    const collectionRef = collection(db, 'artifacts', appId, 'users', state.userId, collectionName);
    
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

// --- WATER SOMMELIER LOGIC (BELGIAN EDITION) ---
async function findCommercialWaterMatch() {
    const resultsDiv = document.getElementById('water-brand-results');
    const recipeContext = window.currentRecipeMarkdown || "";

    if (!resultsDiv) return;
    if (!recipeContext) {
        resultsDiv.classList.remove('hidden');
        resultsDiv.innerHTML = `<p class="text-amber-500 text-sm p-2">Please generate a recipe first so I can recommend matching water.</p>`;
        return;
    }

    resultsDiv.classList.remove('hidden');
    resultsDiv.innerHTML = getLoaderHtml("Scanning Belgian inventory...");

    try {
        const lowerRecipe = recipeContext.toLowerCase();
        const styleHint = lowerRecipe.includes('melomel') || lowerRecipe.includes('fruit') 
            ? "Fruit Mead (Prefers soft/low mineral water to let fruit shine)" 
            : "Traditional (Prefers some mineral structure for mouthfeel)";

        const prompt = `You are a Water Sommelier for a Mead Brewer in BELGIUM. 
        CONTEXT: ${styleHint}
        TASK: Recommend 3 real-world bottled water brands found in BELGIAN SUPERMARKETS.
        CRITICAL: Do NOT recommend American brands. Only brands sold in Belgium/EU.
        OUTPUT: JSON Array: [{"brand": "Name", "reason": "Why this specific mineral profile fits", "tweak_instruction": "Specific usage advice"}]`;

        const schema = {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: { 
                    "brand": { "type": "STRING" }, 
                    "reason": { "type": "STRING" }, 
                    "tweak_instruction": { "type": "STRING" } 
                },
                required: ["brand", "reason", "tweak_instruction"]
            }
        };

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
        window.logSystemError(error, 'tools.js: findCommercialWaterMatch', 'ERROR');
        resultsDiv.innerHTML = `<p class="text-red-500 text-sm">Could not find matching brands. Error: ${error.message}</p>`;
    }
}

window.exportSystemLogs = async function() {
    if (!state.userId) return;
    
    showToast("Fetching logs...", "info");
    
    try {
        const logsRef = collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'systemLogs');
        const q = query(logsRef, orderBy("timestamp", "desc"), limit(100)); // Laatste 100 fouten
        const snapshot = await getDocs(q);
        
        const logs = snapshot.docs.map(doc => doc.data());
        
        if (logs.length === 0) {
            showToast("No errors found! Great job.", "success");
            return;
        }

        // Download als JSON
        const blob = new Blob([JSON.stringify(logs, null, 2)], {type: 'application/json'});
        const a = document.createElement('a'); 
        a.href = URL.createObjectURL(blob); 
        // CORRECTIE: Datum-extrapolatie herleid via de chat-veilige .at(0) methode na de split-operatie
        const dateStamp = new Date().toISOString().split('T').at(0);
        a.download = `debug_logs_${dateStamp}.json`;
        a.click();
        
        showToast("Logs downloaded.", "success");
    } catch (e) {
        console.error(e);
        showToast("Failed to fetch logs.", "error");
    }
}

// --- LOG COUNTER (BADGE) ---
window.updateLogCount = async function() {
    const badge = document.getElementById('log-count-badge');
    if (!badge || !state.userId) return;

    try {
        const coll = collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'systemLogs');
        const snapshot = await getCountFromServer(coll);
        const count = snapshot.data().count;

        if (count > 0) {
            badge.innerText = count > 99 ? '99+' : count;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    } catch (e) {
        console.warn("Log count check failed:", e);
    }
}

// --- BRAGGOT EXTRACT & SPLIT BATCH CALCULATORS (v2.6 STANDARDS) ---

window.calculateBraggot = function() {
    try {
        // 1. DOM Elementen ophalen
        const honeyWeightInput = document.getElementById('braggot_honey_weight')?.value || "";
        const maltWeightInput = document.getElementById('braggot_malt_weight')?.value || "";
        const targetVolInput = document.getElementById('braggot_target_volume')?.value || "";
        const extractType = document.getElementById('braggot_extract_type')?.value || "DME";
        const resultDiv = document.getElementById('braggotResult');

        // 2. Comma-to-Dot Sanitisatie protocol (v2.6)
        const honeyWeight = parseFloat(honeyWeightInput.replace(/,/g, '.')) || 0;
        const maltWeight = parseFloat(maltWeightInput.replace(/,/g, '.')) || 0;
        const targetVolume = parseFloat(targetVolInput.replace(/,/g, '.')) || 0;

        if (targetVolume <= 0) {
            window.showToast("Voer een geldig doelvolume in groter dan 0 L.", "error");
            return;
        }

        // 3. Suikerbijdrage (Gravity Points) berekenen op basis van v2.6 constanten
        const gpHoney = honeyWeight * 290;
        
        let maltConstant = 375; // Default DME
        if (extractType === "LME") {
            maltConstant = 290;
        } else if (extractType === "Candy") {
            maltConstant = 300;
        } else if (extractType === "DME") {
            maltConstant = 375;
        }
        const gpMalt = maltWeight * maltConstant;
        
        const totalGP = gpHoney + gpMalt;

        // 4. Handhaaf Braggot-Grenzen: Valideer of het molaandeel X_malt tussen 30% en 50% ligt
        if (totalGP > 0) {
            const xMalt = gpMalt / totalGP;
            if (xMalt < 0.30 || xMalt > 0.50) {
                window.showToast(`Zymologische waarschuwing: Het molaandeel van de moutstorting (${(xMalt * 100).toFixed(1)}%) valt buiten de braggot-restricties (strikte grens: 30% - 50%).`, "error");
                if (resultDiv) resultDiv.innerHTML = `<span class="text-error font-bold">BRAG_BOUNDS_ERR</span>`;
                return;
            }
        }

        const calculatedPoints = totalGP / targetVolume;
        const ogTheoretisch = 1.000 + (calculatedPoints / 1000);

        // 5. Strikte Hall-precheck tegen crashes en corrupte data (OG mag niet >= 1.775 zijn)
        if (ogTheoretisch >= 1.775) {
            window.showToast("Kritieke fout: De theoretische OG overschrijdt de Hall-limiet (1.775).", "error");
            if (resultDiv) resultDiv.innerHTML = `<span class="text-error font-bold">LIMIT ERR</span>`;
            return;
        }

        // 6. Procentuele verhoudingen berekenen op basis van reële totalGP suikerbijdrage matrix
        let percentHoney = 0;
        let percentMalt = 0;
        if (totalGP > 0) {
            percentHoney = (gpHoney / totalGP) * 100;
            percentMalt = (gpMalt / totalGP) * 100;
        }

        // 7. Real-time UI-update via MD3-conforme structuur
        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="p-4 bg-primary-container rounded-xl border border-primary/20 shadow-sm animate-fade-in">
                    <div class="text-[10px] uppercase font-bold tracking-widest text-primary mb-2">Predicted Braggot Profile (v2.6)</div>
                    <div class="space-y-1 text-sm text-on-surface">
                        <div class="flex justify-between border-b border-outline-variant/30 pb-1">
                            <span>Predicted OG:</span> <span class="font-mono font-bold text-primary">${ogTheoretisch.toFixed(3)}</span>
                        </div>
                        <div class="flex justify-between text-xs pt-1">
                            <span>Sugar from Honey:</span> <span class="font-mono font-bold">${percentHoney.toFixed(1)}%</span>
                        </div>
                        <div class="flex justify-between text-xs">
                            <span>Sugar from Malt (${extractType}):</span> <span class="font-mono font-bold">${percentMalt.toFixed(1)}%</span>
                        </div>
                    </div>
                </div>
            `;
            resultDiv.classList.remove('hidden');
        }

    } catch (error) {
        window.logSystemError(error, 'tools.js: calculateBraggot', 'ERROR');
        window.showToast("Fout bij het berekenen van de Braggot-extracten.", "error");
    }
};

window.calculateSplitBatch = function() {
    try {
        // 1. DOM Elementen ophalen
        const vSubInput = document.getElementById('split_v_sub')?.value || "";
        const sgInitInput = document.getElementById('split_sg_init')?.value || "";
        const vAddInput = document.getElementById('split_v_add')?.value || "";
        const sgAddInput = document.getElementById('split_sg_add')?.value || "";
        const resultDiv = document.getElementById('splitBatchResult');

        // 2. Comma-to-Dot Sanitisatie protocol
        const vSub = parseFloat(vSubInput.replace(/,/g, '.')) || 0;
        const sgInit = parseFloat(sgInitInput.replace(/,/g, '.')) || 1.000;
        const vAdd = parseFloat(vAddInput.replace(/,/g, '.')) || 0;
        const sgAdd = parseFloat(sgAddInput.replace(/,/g, '.')) || 1.000;

        // 3. Volumebepaling & Default-waarde afhandeling bij nulwaarden
        const totalVolume = vSub + vAdd;
        let sgNieuw = sgInit;

        if (totalVolume > 0) {
            // Reguliere massa- en volumebalans berekenen
            sgNieuw = ((vSub * sgInit) + (vAdd * sgAdd)) / totalVolume;
        }

        // 4. Consistentie van de UI: Altijd renderen van de profielkaart conform MD3
        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="p-4 bg-secondary-container rounded-xl border border-secondary/20 shadow-sm animate-fade-in">
                    <div class="text-[10px] uppercase font-bold tracking-widest text-secondary mb-2">Adjusted Split Profile</div>
                    <div class="space-y-1 text-sm text-on-surface">
                        <div class="flex justify-between border-b border-outline-variant/30 pb-1">
                            <span>New Gravity:</span> <span class="font-mono font-bold text-secondary">${sgNieuw.toFixed(4)}</span>
                        </div>
                        <div class="flex justify-between text-xs pt-1">
                            <span>Total Volume:</span> <span class="font-mono font-bold">${totalVolume.toFixed(2)} L</span>
                        </div>
                    </div>
                </div>
            `;
            resultDiv.classList.remove('hidden');
        }

    } catch (error) {
        window.logSystemError(error, 'tools.js: calculateSplitBatch', 'ERROR');
        window.showToast("Fout bij het berekenen van de split-batch dichtheid.", "error");
    }
};

// ============================================================================
// --- SOMMELIER TASTING ASSESSMENT & RATINGS PROTOCOL (v2.6) ---
// ============================================================================

window.calculateTastingAssessment = async function(brewId, sensoryScores, activeOffFlavors) {
    try {
        // 1. INPUT-SANITISATIE & MATHEMATISCHE PRE-CHECK (Comma-to-Dot Protocol)
        if (!brewId) {
            window.showToast("Fout: Geen actief brouwsel geselecteerd.", "error");
            return;
        }

        const brew = state.brews.find(b => b.id === brewId);
        if (!brew) {
            window.showToast("Fout: Brouwsel niet gevonden in database.", "error");
            return;
        }

        // Analytische parameters ophalen en saniteren
        const fgRaw = String(document.getElementById('tasting_fg')?.value || brew.logData?.actualFG || brew.logData?.targetFG || '1.000');
        const taRaw = String(document.getElementById('tasting_ta')?.value || '6.0');
        const phRaw = String(document.getElementById('tasting_ph')?.value || '3.6');

        const finalGravity = parseFloat(fgRaw.replace(/,/g, '.')) || 1.000;
        const titratableAcidity = parseFloat(taRaw.replace(/,/g, '.')) || 0;
        const measuredPh = parseFloat(phRaw.replace(/,/g, '.')) || 3.6;

        // Harde Veiligheidsgrens: Voorkom division-by-zero
        if (titratableAcidity <= 0) {
            window.showToast("Kritieke fout: Titreerbare zuurgraad (TA) moet groter zijn dan 0 g/L.", "error");
            window.logSystemError(new Error("Tasting Assessment division-by-zero pre-check failed: TA <= 0"), 'Tools: Tasting Assessment', 'CRITICAL');
            return;
        }

        // Pre-check op Hall Equation limiet om algoritmische crashes te voorkomen
        if (finalGravity >= 1.775) {
            window.showToast("Fysieke limiet overschreden: FG is groter of gelijk aan de Hall-limiet (1.775).", "error");
            return;
        }

        // 2. DICHTHEID- & HARMONIE-CALCULATIES
        // Bates-polynoom: Soortelijke massa (SG) naar Finale Brix (Brix_f)
        const brixFinal = (182.9622 * Math.pow(finalGravity, 3)) - (777.3009 * Math.pow(finalGravity, 2)) + (1264.5170 * finalGravity) - 670.1831;
        
        // Actuele restsuikerconcentratie (C_s in g/L)
        const sugarConcentration = 10 * brixFinal * finalGravity;

        // Astringentie-matrix factor op basis van tanninSlider (T_score)
        const tScore = parseFloat(sensoryScores?.tanninSlider) || 1.0;
        const astringencyFactor = 1.0 + (0.25 * (tScore - 1.0));

        // Mede-Harmonie Index (M_HI)
        const meadHarmonyIndex = (sugarConcentration * measuredPh) / (titratableAcidity * astringencyFactor);

        // 3. ALGORITMISCHE FEEDBACK-MATRIX
        let oenologicalFeedback = "";
        if (meadHarmonyIndex < 25) {
            oenologicalFeedback = "🚨 **Profiel: Te Droog / Acide.** De mede vertoont een analytische onbalans met dominante zuren of excessieve tannines vergeleken met de restsuikers. Advies: Overweeg back-sweetening (zoeten) via de Bates-v2.6 calculator of voeg een milde carbonaatbuffer toe.";
        } else if (meadHarmonyIndex >= 25 && meadHarmonyIndex <= 65) {
            oenologicalFeedback = "✨ **Profiel: Uitstekende Mede-Harmonie.** Smaakcomponenten zijn organoleptisch in perfect evenwicht. De verhouding tussen restsuikers, zuren en astringentie weerspiegelt een superieure zymologische structuur.";
        } else {
            // meadHarmonyIndex > 65
            oenologicalFeedback = "🍯 **Profiel: Excessief Zoet / Flauw.** De suikerconcentratie overheerst het smaakprofiel door een gebrek aan ondersteunende zuren. Advies: Kwalitatief finetunen door voorzichtige additie van wijnsteenzuur of appelzuur om de frisheid te herstellen.";
        }

        // 4. OFF-FLAVOR KINETISCHE CHECKS
        let offFlavorNotes = [];

        // Kinetische Check A: Reductie & Stikstoftekort
        if (activeOffFlavors?.reduction && brew.logData?.yanDelta > 0) {
            const extraFermaidO = brew.logData.yanDelta / 40;
            offFlavorNotes.push(`• **Reductie gedetecteerd:** Aanwezigheid van zwavelaroma's correleert met een stikstoftekort van ${Math.round(brew.logData.yanDelta)} ppm YAN tijdens de vergisting. Voeg proactief ${extraFermaidO.toFixed(2)} g/L Fermaid O toe bij een volgende iteratie.`);
        }

        // Kinetische Check B: Foezelalcoholen bij Lalvin D47 thermische stress
        const yeastStrain = brew.yeastStrain || "";
        const maxTemp = parseFloat(brew.logData?.maxFermentationTemp) || 0;
        if (activeOffFlavors?.fusels && yeastStrain.includes("D47") && maxTemp > 20) {
            const deltaTStress = maxTemp - 20;
            offFlavorNotes.push(`• **Thermische Stress (Lalvin D47):** Foezelalcoholen gesynthetiseerd door temperatuuroverschrijding tijdens de logaritmische groeifase. Giststam onderging een thermische stressfactor van +${deltaTStress.toFixed(1)}°C boven de kritieke 20°C grens.`);
        }

        // Kinetische Check C: Binaris Risico op Geranium Taint (Kritieke Veiligheidscheck)
        if (activeOffFlavors?.geranium) {
            const hasSorbaat = brew.stabilizationData?.sorbateAdded || false;
            const freeSO2 = parseFloat(brew.stabilizationData?.measuredFreeSO2) || 0;
            const mSO2 = freeSO2 / (1 + Math.pow(10, (measuredPh - 1.81)));

            if (measuredPh > 3.8 && hasSorbaat && mSO2 < 0.8) {
                offFlavorNotes.push(`⚠️ **KRITIEK GERANIUM RISICO:** Extreme biochemische kwetsbaarheid gedetecteerd! pH is groter dan 3.8 met actieve kaliumsorbaat-aanwezigheid, terwijl de Vrije SO₂ suboptimaal is (M_SO₂ < 0.8 ppm). Melkzuurbacteriën kunnen sorbinezuur reduceren tot sorbinol, wat leidt tot onomkeerbare ethylsorbaat-degradatie ("Geranium Taint").`);
            }
        }

        const combinedNotesString = offFlavorNotes.length > 0 
            ? offFlavorNotes.join("\n") 
            : "• Geen directe kinetische off-flavor afwijkingen geconstateerd op basis van brouwdata.";

        // 5. RATING-BEREKENING (Sterrenscore met Off-Flavor Aftrek)
        const aroma = parseFloat(sensoryScores?.aromaSlider) || 3.0;
        const flavor = parseFloat(sensoryScores?.flavorSlider) || 3.0;
        const mouthfeel = parseFloat(sensoryScores?.mouthfeelSlider) || 3.0;
        
        const unweightedAverage = (aroma + flavor + mouthfeel) / 3.0;
        const activeOffFlavorCount = Object.values(activeOffFlavors || {}).filter(Boolean).length;
        
        // Vaste aftrek van 1.00 ster per actieve afwijking, hard begrensd tussen 0.25 en 5.00
        let calculatedStars = unweightedAverage - (1.00 * activeOffFlavorCount);
        calculatedStars = Math.max(0.25, Math.min(5.00, calculatedStars));

        // 6. DATABASE SYNC & STATE-AFHANDELING
        if (!state.userId) {
            window.showToast("Waarschuwing: Beoordeling lokaal berekend. Log in om op te slaan.", "warning");
            renderTastingResultsUI(sugarConcentration, meadHarmonyIndex, calculatedStars, oenologicalFeedback, combinedNotesString);
            return;
        }

        const tastingPayload = {
            tastingAssessment: {
                sugarConcentrationGramsPerLiter: parseFloat(sugarConcentration.toFixed(2)),
                meadHarmonyIndex: parseFloat(meadHarmonyIndex.toFixed(1)),
                calculatedStars: parseFloat(calculatedStars.toFixed(2)),
                oenologicalFeedback: oenologicalFeedback,
                kineticOffFlavorNotes: combinedNotesString,
                updatedAt: new Date().toISOString()
            }
        };

        const brewDocRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId);
        
        // Schrijf direct weg naar Firestore (Single Source of Truth)
        await updateDoc(brewDocRef, tastingPayload);

        // Update lokale state cache na succesvolle Firestore bevestiging
        const localBrewIndex = state.brews.findIndex(b => b.id === brewId);
        if (localBrewIndex !== -1) {
            state.brews[localBrewIndex].tastingAssessment = tastingPayload.tastingAssessment;
        }

        // Render de resultaten live in de UI
        renderTastingResultsUI(sugarConcentration, meadHarmonyIndex, calculatedStars, oenologicalFeedback, combinedNotesString);
        window.showToast("Sommelier-beoordeling succesvol gesynchroniseerd!", "success");

    } catch (error) {
        window.logSystemError(error, 'tools.js: calculateTastingAssessment', 'ERROR');
        window.showToast("Fout bij het genereren van de sommelier-beoordeling.", "error");
    }
};

/**
 * Helper-functie om de geavanceerde analytische metrics te renderen conform MD3-standaarden.
 */
function renderTastingResultsUI(sugar, harmony, stars, feedback, notes) {
    const outputDiv = document.getElementById('tasting-assessment-output');
    if (!outputDiv) return;

    outputDiv.innerHTML = `
        <div class="p-5 bg-surface-variant/40 dark:bg-gray-800/60 rounded-2xl border border-app-brand/20 shadow-md animate-fade-in space-y-4">
            <div class="flex justify-between items-center border-b border-app-brand/10 pb-2">
                <span class="text-xs uppercase font-bold tracking-widest text-app-brand">Sommelier Proefnotities</span>
                <span class="text-xl font-black text-amber-500 font-header">${stars.toFixed(2)} ⭐</span>
            </div>
            
            <div class="grid grid-cols-2 gap-4 text-sm">
                <div class="p-3 card rounded-xl bg-app-primary/5">
                    <span class="block text-[10px] uppercase opacity-60 font-bold">Restsuikers (C_s)</span>
                    <span class="text-lg font-mono font-bold text-app-header">${sugar.toFixed(1)} g/L</span>
                </div>
                <div class="p-3 card rounded-xl bg-app-primary/5">
                    <span class="block text-[10px] uppercase opacity-60 font-bold">Mede-Harmonie Index</span>
                    <span class="text-lg font-mono font-bold text-app-brand">${harmony.toFixed(1)}</span>
                </div>
            </div>

            <div class="text-xs text-app-header space-y-2">
                <p class="leading-relaxed font-medium bg-white/50 dark:bg-black/20 p-3 rounded-lg border border-app-brand/5">${feedback}</p>
                <div class="pt-2">
                    <span class="block text-[9px] uppercase font-bold opacity-60 tracking-wider mb-1">Kinetische Analyse & Off-Flavors:</span>
                    <div class="font-sans text-[11px] text-on-surface-variant opacity-90 whitespace-pre-line leading-relaxed bg-red-500/5 p-3 rounded-lg border border-red-500/10">${notes}</div>
                </div>
            </div>
        </div>
    `;
    outputDiv.classList.remove('hidden');
}

window.calculateWaterMatching = function() {
    try {
        // Aangepaste hulpfunctie dwingt een numerieke 0 af bij mislukte parsing of lege strings
        const getSanitizedVal = (id) => {
            const el = document.getElementById(id);
            if (!el) return 0;
            const parsed = parseFloat(el.value.replace(/,/g, '.'));
            return (isNaN(parsed)) ? 0 : parsed;
        };

        const vWater = getSanitizedVal('match_water_vol');
        
        // Bron-ionen (Source)
        const sourceCa = getSanitizedVal('match_source_ca');
        const sourceMg = getSanitizedVal('match_source_mg');
        const sourceSo4 = getSanitizedVal('match_source_so4');
        const sourceCl = getSanitizedVal('match_source_cl');

        // Doel-ionen (Target)
        const targetCa = getSanitizedVal('match_target_ca');
        const targetMg = getSanitizedVal('match_target_mg');
        const targetSo4 = getSanitizedVal('match_target_so4');
        const targetCl = getSanitizedVal('match_target_cl');

        const resultDiv = document.getElementById('waterMatchingResult');

        if (vWater <= 0) {
            window.showToast("Voer een geldig watervolume in groter dan 0 L.", "error");
            return;
        }

        const deltaCa = Math.max(0, targetCa - sourceCa);
        const deltaMg = Math.max(0, targetMg - sourceMg);
        const deltaSo4 = Math.max(0, targetSo4 - sourceSo4);
        const deltaCl = Math.max(0, targetCl - sourceCl);

        // Epsomzout op basis van Magnesiumbehoefte
        const mEpsomPerLiter = deltaMg / 98.6;

        // Resterend Sulfaat na Epsom-toevoeging
        let deltaSo4Rem = deltaSo4 - (mEpsomPerLiter * 389.7);
        if (deltaSo4Rem < 0) deltaSo4Rem = 0;

        // Gips op basis van resterende Sulfaatbehoefte
        const mGypsumPerLiter = deltaSo4Rem / 557.9;

        // Calciumchloride op basis van Chloridebehoefte
        const mCaCl2PerLiter = deltaCl / 482.3;

        // Volumemodulatie (Totale massa in grammen)
        const totalEpsom = mEpsomPerLiter * vWater;
        const totalGypsum = mGypsumPerLiter * vWater;
        const totalCaCl2 = mCaCl2PerLiter * vWater;

        const caAddedPpm = (mGypsumPerLiter * 232.8) + (mCaCl2PerLiter * 272.6);

        let ratioOutput = "";
        if (targetCl === 0) {
            ratioOutput = "Pure Bitter / Strak (Cl = 0)";
        } else {
            const ratio = targetSo4 / targetCl;
            ratioOutput = ratio.toFixed(2);
        }

        if (resultDiv) {
            resultDiv.innerHTML = `
                <div class="p-4 bg-primary-container rounded-xl border border-primary/20 shadow-sm animate-fade-in space-y-3">
                    <div class="text-[10px] uppercase font-bold tracking-widest text-primary mb-1">Required Mineral Additions</div>
                    
                    <div class="grid grid-cols-3 gap-2 text-center">
                        <div class="p-2 card rounded-lg bg-app-primary/5">
                            <span class="block text-[9px] uppercase font-bold opacity-70">Gips (CaSO₄)</span>
                            <span class="text-base font-mono font-bold text-app-header">${totalGypsum.toFixed(2)}g</span>
                        </div>
                        <div class="p-2 card rounded-lg bg-app-primary/5">
                            <span class="block text-[9px] uppercase font-bold opacity-70">CaCl₂</span>
                            <span class="text-base font-mono font-bold text-app-header">${totalCaCl2.toFixed(2)}g</span>
                        </div>
                        <div class="p-2 card rounded-lg bg-app-primary/5">
                            <span class="block text-[9px] uppercase font-bold opacity-70">Epsom (MgSO₄)</span>
                            <span class="text-base font-mono font-bold text-app-header">${totalEpsom.toFixed(2)}g</span>
                        </div>
                    </div>

                    <div class="pt-2 border-t border-outline-variant/30 text-xs space-y-1 text-on-surface">
                        <div class="flex justify-between">
                            <span>Est. Calcium Balance Increase:</span>
                            <span class="font-mono font-bold text-green-600">+${caAddedPpm.toFixed(1)} ppm</span>
                        </div>
                        <div class="flex justify-between">
                            <span>Target SO₄ / Cl Ratio:</span>
                            <span class="font-mono font-bold text-primary">${ratioOutput}</span>
                        </div>
                    </div>
                </div>
            `;
            resultDiv.classList.remove('hidden');
        }

    } catch (error) {
        window.logSystemError(error, 'Tools: Water Matching', 'ERROR');
        window.showToast("Fout bij het berekenen van het waterprofiel.", "error");
    }
};

// --- HARDE WINDOW OBJECT BINDING (MODULE SCOPE ISOLATIE SANITISATIE) ---
window.loadUserSettings = loadUserSettings;
window.applySettings = applySettings;
window.saveUserSettings = saveUserSettings;
window.findWaterProfileWithAI = findWaterProfileWithAI;
window.loadUserWaterProfiles = loadUserWaterProfiles;
window.populateWaterDropdown = populateWaterDropdown;
window.renderUserWaterProfilesList = renderUserWaterProfilesList;
window.saveWaterProfile = saveWaterProfile;
window.setupPromptEngineer = setupPromptEngineer;
window.runPromptEngineer = runPromptEngineer;
window.handleWaterSourceChange = handleWaterSourceChange;
window.findCommercialWaterMatch = findCommercialWaterMatch;
window.runSocialMediaGenerator = runSocialMediaGenerator;
window.calculateABV = calculateABV;
window.correctHydrometer = correctHydrometer;
window.calculatePrimingSugar = calculatePrimingSugar;
window.calculateBlend = calculateBlend;
window.calculateBacksweetening = calculateBacksweetening;
window.calculateDilution = calculateDilution;
window.calculateBuffer = calculateBuffer;
window.calculateTOSNA = calculateTOSNA;
window.calculateTargetApparentBrix = calculateTargetApparentBrix;
window.calculateStabilization = calculateStabilization;
window.calculateRefractometerCorrection = calculateRefractometerCorrection;
window.calculateBraggot = calculateBraggot;
window.calculateSplitBatch = calculateSplitBatch;
window.calculateTastingAssessment = calculateTastingAssessment;
window.calculateWaterMatching = calculateWaterMatching;