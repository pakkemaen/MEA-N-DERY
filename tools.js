import { db } from './firebase-init.js';
import { state } from './state.js';
import { showToast, performApiCall, getLoaderHtml, switchMainView, switchSubView } from './utils.js';
import { doc, getDoc, setDoc, updateDoc, collection, addDoc, deleteDoc, query, onSnapshot, getDocs, writeBatch, arrayUnion } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Fallback als CONFIG niet globaal beschikbaar is (wat in modules vaak zo is)
const CONFIG = window.CONFIG || { firebase: { apiKey: "" } };

let userWaterProfiles = [];

// --- SETTINGS MANAGEMENT ---
async function loadUserSettings() {
    if (!state.userId) return;
    const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main');
    const snap = await getDoc(docRef);
    if (snap.exists()) {
        state.userSettings = snap.data();
        applySettings();
    }
}

function applySettings() {
    // Vul de velden in settings-view
    const s = state.userSettings;
    if(document.getElementById('apiKeyInput')) document.getElementById('apiKeyInput').value = s.apiKey || '';
    if(document.getElementById('defaultBatchSizeInput')) document.getElementById('defaultBatchSizeInput').value = s.defaultBatchSize || 5;
    
    if (s.theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
}

async function saveUserSettings() {
    if (!state.userId) return;
    const newSettings = {
        apiKey: document.getElementById('apiKeyInput').value.trim(),
        defaultBatchSize: parseFloat(document.getElementById('defaultBatchSizeInput').value),
        theme: document.getElementById('theme-toggle-checkbox').checked ? 'dark' : 'light'
    };
    
    await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'main'), newSettings, { merge: true });
    state.userSettings = { ...state.userSettings, ...newSettings }; // Update lokaal
    applySettings();
    showToast("Settings saved!", "success");
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
    const id = document.getElementById('water-profile-id').value;
    const data = {
        name: document.getElementById('water-profile-name').value,
        ca: parseFloat(document.getElementById('manual_ca').value)||0, mg: parseFloat(document.getElementById('manual_mg').value)||0,
        na: parseFloat(document.getElementById('manual_na').value)||0, so4: parseFloat(document.getElementById('manual_so4').value)||0,
        cl: parseFloat(document.getElementById('manual_cl').value)||0, hco3: parseFloat(document.getElementById('manual_hco3').value)||0,
    };
    if (!data.name) return showToast("Name required.", "error");
    
    try {
        const col = collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'waterProfiles');
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
    if (!state.userId || !confirm("Delete profile?")) return;
    try { await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'waterProfiles', id)); showToast("Deleted.", "success"); }
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
        // Verwijder oude listeners door te clonen (optioneel, maar veilig)
        const newUpload = upload.cloneNode(true);
        upload.parentNode.replaceChild(newUpload, upload);
        
        newUpload.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = function(evt) {
                    promptEngineerImageBase64 = evt.target.result.split(',')[1];
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
        // Verwijder oude listeners
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
        
        if (data.candidates && data.candidates.length > 0) {
            const result = data.candidates[0].content.parts[0].text.trim();
            outputDiv.classList.remove('hidden');
            outputText.value = result;
            showToast("Style DNA Extracted!", "success");
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
            console.error(err);
            showToast("Import failed: " + err.message, "error");
        }
    };
    reader.readAsText(file);
}

// --- MEAD MEDIC CHAT SYSTEM ---

let chatHistory = []; // Houdt het gesprek bij
let currentChatImageBase64 = null; // Houdt de geselecteerde foto vast

// 1. Initialiseer / Reset
window.resetTroubleshootChat = function() {
    chatHistory = [];
    const chatBox = document.getElementById('chat-history');
    if(chatBox) {
        chatBox.innerHTML = `
        <div class="flex items-start gap-3">
            <div class="w-8 h-8 rounded-full bg-app-brand text-white flex items-center justify-center font-bold text-xs">DOC</div>
            <div class="bg-white dark:bg-gray-800 p-3 rounded-lg rounded-tl-none shadow-sm text-sm text-app-header border border-gray-100 dark:border-gray-700 max-w-[85%]">
                Hi! I'm your Mead Medic. Describe your issue or upload a photo of your brew.
            </div>
        </div>`;
    }
    window.clearChatImage();
}

// 2. Foto Selectie Handling
window.handleChatImageSelect = function(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            currentChatImageBase64 = e.target.result.split(',')[1]; // Alleen de data, niet de prefix
            
            // Toon preview
            document.getElementById('chat-preview-img').src = e.target.result;
            document.getElementById('chat-image-preview').classList.remove('hidden');
        }
        reader.readAsDataURL(input.files[0]);
    }
}

window.clearChatImage = function() {
    currentChatImageBase64 = null;
    document.getElementById('chat-image-input').value = '';
    document.getElementById('chat-image-preview').classList.add('hidden');
}

// 3. Bericht Versturen
window.sendTroubleshootMessage = async function() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    const chatBox = document.getElementById('chat-history');
    const sendBtn = document.getElementById('chat-send-btn');

    if (!text && !currentChatImageBase64) return;

    // A. Render USER bericht
    let userHtml = `<div class="flex items-start gap-3 justify-end animate-fade-in">
        <div class="bg-blue-600 text-white p-3 rounded-lg rounded-tr-none shadow-sm text-sm max-w-[85%]">
            ${currentChatImageBase64 ? '<div class="mb-2"><span class="text-[10px] uppercase bg-white/20 px-1 rounded">📷 Image attached</span></div>' : ''}
            ${text}
        </div>
        
        <img src="logo.png" onerror="this.src='favicon.png'" alt="Me" class="w-8 h-8 rounded-full bg-app-tertiary flex-shrink-0 object-contain border border-app-brand/20 p-0.5">
    </div>`;
    chatBox.insertAdjacentHTML('beforeend', userHtml);
    
    // Voeg toe aan geschiedenis
    chatHistory.push({ role: "user", text: text, hasImage: !!currentChatImageBase64 });

    // UI Updates
    input.value = '';
    const imageToSend = currentChatImageBase64; // Bewaar ref voor API call
    window.clearChatImage();
    chatBox.scrollTop = chatBox.scrollHeight;
    sendBtn.disabled = true;

    // B. Render AI 'Typing...'
    const loadingId = 'loading-' + Date.now();
    chatBox.insertAdjacentHTML('beforeend', `
        <div id="${loadingId}" class="flex items-start gap-3 animate-pulse">
            <div class="w-8 h-8 rounded-full bg-app-brand text-white flex items-center justify-center font-bold text-xs">DOC</div>
            <div class="bg-gray-100 dark:bg-gray-700 p-3 rounded-lg rounded-tl-none text-xs text-gray-500">Thinking...</div>
        </div>
    `);
    chatBox.scrollTop = chatBox.scrollHeight;

    // C. API Call (Speciaal voor Chat + Vision)
    try {
        const response = await performChatApiCall(chatHistory, imageToSend);
        
        // Verwijder loader
        document.getElementById(loadingId).remove();

        // Render AI bericht (met Markdown parsing)
        const aiHtml = `<div class="flex items-start gap-3 animate-fade-in">
            <div class="w-8 h-8 rounded-full bg-app-brand text-white flex items-center justify-center font-bold text-xs flex-shrink-0">AI</div>
            <div class="bg-white dark:bg-gray-800 p-3 rounded-lg rounded-tl-none shadow-sm text-sm text-app-header border border-gray-100 dark:border-gray-700 max-w-[90%] prose prose-sm max-w-none">
                ${marked.parse(response)}
            </div>
        </div>`;
        
        chatBox.insertAdjacentHTML('beforeend', aiHtml);
        chatHistory.push({ role: "model", text: response }); // Voeg AI antwoord toe aan geheugen

    } catch (error) {
        document.getElementById(loadingId).remove();
        chatBox.insertAdjacentHTML('beforeend', `<div class="text-center text-red-500 text-xs my-2">Error: ${error.message}</div>`);
    } finally {
        sendBtn.disabled = false;
        chatBox.scrollTop = chatBox.scrollHeight;
        input.focus(); // Focus terug voor snelle chat
    }
}

// 4. De Speciale API functie (Ondersteunt Context + Plaatjes)
async function performChatApiCall(history, base64Image) {
    let apiKey = state.userSettings.apiKey;
    if (!apiKey && typeof CONFIG !== 'undefined') apiKey = CONFIG.firebase.apiKey;
    if (!apiKey) throw new Error("No API Key");

    // --- FIX: KOPPELING MET SETTINGS ---
    // 1. Kijk of de gebruiker een specifiek Chat Model heeft gekozen.
    // 2. Zo niet, gebruik het algemene AI model.
    // 3. Als alles faalt, gebruik 'gemini-2.0-flash' (die werkt wel volgens jouw lijst).
    let model = "gemini-2.0-flash"; 
    
    if (state.userSettings.chatModel && state.userSettings.chatModel.trim() !== "") {
        model = state.userSettings.chatModel;
    } else if (state.userSettings.aiModel && state.userSettings.aiModel.trim() !== "") {
        model = state.userSettings.aiModel;
    }

    // Console log zodat je kunt zien wat er gebeurt (F12)
    console.log("Mead Medic is using model:", model);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // Bouw de prompt op basis van de geschiedenis
    let promptContext = "You are an expert Mead Troubleshooter. Be concise, helpful, and scientific. Keep answers under 150 words unless asked for detail.\n\nCONVERSATION HISTORY:\n";
    
    history.forEach(msg => {
        promptContext += `${msg.role === 'user' ? 'USER' : 'AI'}: ${msg.text} ${msg.hasImage ? '[User uploaded an image]' : ''}\n`;
    });
    
    promptContext += `\nUSER'S NEWEST INPUT: `; 

    const parts = [{ text: promptContext }];
    
    // Als er een afbeelding is, voegen we die toe aan de request
    if (base64Image) {
        parts.push({
            inline_data: {
                mime_type: "image/jpeg",
                data: base64Image
            }
        });
    }

    const requestBody = {
        contents: [{ parts: parts }]
    };

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        // SPECIFIEKE CHECK VOOR LIMIET
        if (response.status === 429) {
            throw new Error("⛔ QUOTA BEREIKT: Je hebt te snel/veel gechat voor dit model. Schakel over naar Flash in Settings.");
        }

        const errData = await response.json().catch(() => ({}));
        throw new Error(`AI Error (${response.status}) using model '${model}': ${errData.error?.message || response.statusText}`);
    }
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
}

window.fetchAvailableModels = async function() {
    const apiKey = document.getElementById('apiKeyInput').value.trim();
    const textSelect = document.getElementById('aiModelInput');
    const chatSelect = document.getElementById('chatModelInput'); // NIEUW
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
            opt.text = cleanName;
            textSelect.appendChild(opt);
        });

        // --- VUL DROPDOWN 2: CHAT ENGINE (NIEUW) ---
        // We gebruiken dezelfde lijst als voor recepten (want het zijn beide tekstmodellen)
        chatSelect.innerHTML = '';
        textModels.forEach(model => {
            const cleanName = model.name.replace('models/', '');
            const opt = document.createElement('option');
            opt.value = cleanName;
            opt.text = cleanName;
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

// --- SOCIAL MEDIA STUDIO 2.0 LOGIC ---

// 1. De hoofdfunctie om tekst te genereren

async function runSocialMediaGenerator() {
    const brewId = document.getElementById('social-recipe-select').value;
    const persona = document.getElementById('social-persona').value;
    const platform = document.getElementById('social-platform').value;
    const tweak = document.getElementById('social-tweak').value;
    
    if (!brewId && !tweak) { 
        showToast("Select a recipe OR type a topic.", "error"); 
        return; 
    }
    
    const container = document.getElementById('social-content-container');
    const imageBtn = document.getElementById('generate-social-image-btn');

    container.innerHTML = getLoaderHtml(`Channeling ${persona}...`);
    imageBtn.classList.add('hidden');

    // Context ophalen (NU MET MEER DETAILS)
    let context = "";
    if (brewId) {
        const brew = state.brews.find(b => b.id === brewId);
        // Probeer ABV te vinden (Final -> Target -> Unknown)
        const abv = brew.logData?.finalABV || brew.logData?.targetABV || "approx 12%";
        
        context = `
        **PRODUCT:** Mead (Honey Wine).
        **NAME:** ${brew.recipeName}
        **STATS:** ABV: ${abv}.
        **RECIPE DATA:** ${brew.recipeMarkdown.substring(0, 1000)}...
        **USER NOTES:** ${tweak}
        `;
    } else {
        context = `**TOPIC:** ${tweak}`;
    }

    // --- PERSONA DEFINITIES ---
    let toneInstruction = "";
    if (persona === 'Ryan Reynolds') {
        toneInstruction = `**TONE: RYAN REYNOLDS.** High energy, witty, sarcastic, break the fourth wall. Make fun of the effort.`;
    } else if (persona === 'Dry British') {
        toneInstruction = `**TONE: DRY BRITISH.** Understated, deadpan, cynical but charming. Use words like "splendid", "rather nice".`;
    } else if (persona === 'The Sommelier') {
        toneInstruction = `**TONE: THE SOMMELIER.** Elegant, sophisticated, sensory-focused. Use vocabulary like "bouquet", "finish", "notes of", "structure". No slang.`;
    } else {
        toneInstruction = `**TONE:** Bold, loud, enthusiastic like a Viking feast.`;
    }

    // --- PLATFORM DEFINITIES (AANGEPAST VOOR UNTAPPD) ---
    let platformInstruction = "";
    if (platform === 'Untappd') {
        platformInstruction = `
        **FORMAT: UNTAPPD DESCRIPTION (STRICT RULES):**
        1. **NO MARKDOWN:** Do NOT use bold (**), italics (*), or bullet points. Plain text only.
        2. **NO LISTS:** Do NOT list "Style: X" or "ABV: Y". Weave these facts naturally into the sentences (e.g., "This 12% Melomel features...").
        3. **CONTENT:** A single, flowing, seductive paragraph about the flavor profile, mouthfeel, and ingredients.
        4. **LENGTH:** Concise (max 100 words).
        5. **FORBIDDEN:** No hashtags, no emojis, no links.
        `;
    } else {
        // Instagram defaults
        platformInstruction = `
        **FORMAT: INSTAGRAM CAPTION.**
        - Engaging hook.
        - Use line breaks.
        - Use relevant Emojis.
        - End with 10-15 hashtags.
        `;
    }

    const prompt = `You are a Marketing Expert.
    
    ${context}
    
    ${toneInstruction}
    
    ${platformInstruction}
    
    **TASK:** Write the content for ${platform}.
    **EXTRA:** At the very end, provide a separate AI Image Prompt starting with "IMG_PROMPT:".
    `;
    
    try {
        const rawText = await performApiCall(prompt);
        
        let finalPost = rawText;
        let imgPrompt = "";

        if (rawText.includes("IMG_PROMPT:")) {
            const parts = rawText.split("IMG_PROMPT:");
            finalPost = parts[0].trim();
            imgPrompt = parts[1].trim();
        }

        // --- SCHOONMAAK ACTIE ---
        // Verwijder alle markdown sterretjes die de AI toch per ongeluk heeft toegevoegd
        finalPost = finalPost.replace(/\*\*/g, '').replace(/\*/g, '').trim();

        // Als Untappd: verwijder ook eventuele "Title:" prefixes die de AI soms verzint
        if (platform === 'Untappd') {
            finalPost = finalPost.replace(/^Title:\s*/i, '').replace(/^Description:\s*/i, '');
        }

        container.innerText = finalPost; 
        
        if (imgPrompt) {
            imageBtn.classList.remove('hidden');
            imageBtn.onclick = () => generateSocialImage(imgPrompt);
        }

    } catch (e) {
        container.innerHTML = `<p class="text-red-500 text-sm">Error: ${e.message}</p>`;
    }
}

// 2. De functie om een plaatje te maken

async function generateSocialImage(imagePrompt) {
    const container = document.getElementById('social-image-container');
    const btn = document.getElementById('generate-social-image-btn');
    
    // 1. HAAL DE GEKOZEN PERSONA OP
    const personaSelect = document.getElementById('social-persona');
    const selectedPersona = personaSelect ? personaSelect.value : '';

    // 2. KIES DE STIJL PREFIX OP BASIS VAN DE PERSONA
    let stylePrefix = "";

    switch (selectedPersona) {
        case "Ryan Reynolds":
            // Stijl: Scherp, premium, een beetje 'te' perfect, high-contrast, filmisch.
            stylePrefix = "Cinematic premium advertisement photography, sharp focus, high contrast lighting, witty composition, 8k resolution: ";
            break;
        case "Dry British":
            // Stijl: Ingetogen, natuurlijk licht, klassiek, elegant, niet schreeuwerig.
            stylePrefix = "Understated elegant photography, natural diffused lighting, classic composition, richly textured background, subtle and refined: ";
            break;
        case "The Sommelier":
            // Stijl: Luxe, focus op details (macro), wijnkelder sfeer, rijk, diepe kleuren.
            stylePrefix = "Luxurious macro photography, focus on liquid texture and details, ambient cellar lighting, rich bokeh background, high-end feel: ";
            break;
        case "The Viking":
            // Stijl: Ruw, donker hout, vuurlicht, stoer, ambachtelijk, een beetje wild.
            stylePrefix = "Rustic and bold photography, dark wood surfaces, warm firelight, rugged textures, ancient mead hall atmosphere, raw and powerful: ";
            break;
        default:
            // De "Standaard" BrewBuddy stijl (Modern Artisan) als er niets is gekozen.
            stylePrefix = "Artisan craft mead photography, warm natural light, rustic wooden background, highly detailed textures, inviting atmosphere, shallow depth of field: ";
            break;
    }
    
    // We hergebruiken de Google AI Key uit settings
    let apiKey = state.userSettings.apiKey;
    
    // Fallback voor als settings leeg is
    if (!apiKey && typeof CONFIG !== 'undefined' && CONFIG.firebase) {
         apiKey = CONFIG.firebase.apiKey;
    }

    if (!apiKey) {
        showToast("Geen Google API Key gevonden.", "error");
        return;
    }

    if (container) {
        // Laat even zien welke stijl we gebruiken in de loader tekst
        const styleName = selectedPersona || "Default Artisan";
        container.innerHTML = `<div class="loader"></div><p class="text-xs text-center mt-2 text-app-secondary animate-pulse">Painting in "${styleName}" style...</p>`;
    }

    const model = state.userSettings.imageModel || "imagen-3.0-generate-001";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;

    const requestBody = {
        instances: [
            { 
                // HIER COMBINEREN WE DE STIJL MET JOUW ONDERWERP
                prompt: stylePrefix + imagePrompt 
            }
        ],
        parameters: {
            sampleCount: 1,
            aspectRatio: "1:1"
        }
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error?.message || `Google Image Error (${response.status})`);
        }
        
        const data = await response.json();
        
        if (data.predictions && data.predictions.length > 0 && data.predictions[0].bytesBase64Encoded) {
            const base64Img = data.predictions[0].bytesBase64Encoded;
            if (container) {
                container.innerHTML = `<img src="data:image/png;base64,${base64Img}" class="w-full h-full object-cover rounded-xl shadow-inner animate-fade-in">`;
            }
            if (btn) btn.classList.add('hidden');
        } else {
            throw new Error("Geen plaatje ontvangen van Google.");
        }
        
    } catch (e) {
        console.error("Imagen Fout:", e);
        let msg = "Generation Failed";
        if (e.message.includes("403") || e.message.includes("permission")) msg = "API Key/Model toegang geweigerd.";
        
        if (container) {
            container.innerHTML = `<div class="p-4 text-center flex flex-col items-center justify-center h-full"><p class="text-red-500 text-xs font-bold mb-1">${msg}</p><p class="text-[10px] text-gray-400 leading-tight">${e.message}</p></div>`;
        }
        if (btn) btn.classList.remove('hidden');
    }
}

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

const BUILT_IN_WATER_PROFILES = { 
    spa: { name: 'Spa Reine', ca: 5, mg: 2, na: 3, so4: 4, cl: 5, hco3: 17 },
    chaudfontaine: { name: 'Chaudfontaine', ca: 65, mg: 18, na: 44, so4: 40, cl: 35, hco3: 305 },
};

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
    const abv1 = parseFloat(document.getElementById('abv1').value);
    const vol2 = parseFloat(document.getElementById('vol2').value);
    const abv2 = parseFloat(document.getElementById('abv2').value);
    const resultDiv = document.getElementById('blendResult');

    if (isNaN(vol1) || isNaN(abv1) || isNaN(vol2) || isNaN(abv2)) { 
        resultDiv.textContent = 'Invalid Input'; 
        return; 
    }

    const totalAlcohol = (vol1 * abv1) + (vol2 * abv2);
    const totalVolume = vol1 + vol2;
    
    if (totalVolume <= 0) {
        resultDiv.textContent = 'Volume Error';
        return;
    }

    const finalABV = totalAlcohol / totalVolume;
    resultDiv.textContent = `New: ${totalVolume.toFixed(2)}L @ ${finalABV.toFixed(2)}% ABV`;
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

// --- REFRACTOMETER CORRECTIE (Brix -> SG) ---
function calculateRefractometerCorrection() {
    const ob = parseFloat(document.getElementById('refract_ob').value); // Original Brix
    const cb = parseFloat(document.getElementById('refract_cb').value); // Current Brix
    const resultDiv = document.getElementById('refractResult');

    if (isNaN(ob) || isNaN(cb)) {
        showToast("Please enter both Brix values.", "error");
        return;
    }

    // Wort Correction Factor (standaard is vaak 1.04, maar voor honing/fruit is 1.0 vaak prima, we gebruiken 1.0 voor de eenvoud of de Sean Terrill formule die geen WCF nodig heeft)
    // We gebruiken hier de Petr Novotny formule (standaard in veel homebrew apps):
    
    // Stap 1: Bereken SG
    const sg = 1.001843 
             - 0.002318474 * ob 
             - 0.000007775 * (ob * ob) 
             - 0.0340054 * cb 
             + 0.00564 * (cb * cb) 
             + 0.000283 * (ob * cb);

    // Stap 2: Bereken ABV (Standaard formule op basis van SG)
    // We moeten eerst de Original Gravity weten vanuit de Original Brix
    const originalSG = 1 + (ob / (258.6 - ((ob / 258.2) * 227.1)));
    const abv = (originalSG - sg) * 131.25;

    resultDiv.innerHTML = `
        <div class="grid grid-cols-2 gap-4">
            <div>
                <p class="text-xs text-app-secondary uppercase">True Gravity</p>
                <p class="text-2xl font-bold text-purple-700 dark:text-purple-300">${sg.toFixed(3)}</p>
            </div>
            <div>
                <p class="text-xs text-app-secondary uppercase">Current ABV</p>
                <p class="text-2xl font-bold text-purple-700 dark:text-purple-300">${abv.toFixed(1)}%</p>
            </div>
        </div>
    `;
    resultDiv.classList.remove('hidden');
}

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

// --- EXPORTS ---
window.importData = importData;
window.saveWaterProfile = saveWaterProfile;
window.findWaterProfileWithAI = findWaterProfileWithAI;
window.exportHistory = exportHistory;
window.exportInventory = exportInventory;
window.loadUserSettings = loadUserSettings;
window.saveUserSettings = saveUserSettings;
window.calculateABV = calculateABV;
window.calculateTOSNA = calculateTOSNA;
window.runSocialMediaGenerator = runSocialMediaGenerator;
window.handleWaterSourceChange = handleWaterSourceChange;
window.calculateRefractometerCorrection = calculateRefractometerCorrection;
window.calculatePrimingSugar = calculatePrimingSugar;
window.calculateBlend = calculateBlend;
window.calculateBacksweetening = calculateBacksweetening;
window.calculateDilution = calculateDilution;
window.correctHydrometer = correctHydrometer;
window.populateSocialRecipeDropdown = populateSocialRecipeDropdown; // Ook deze moet beschikbaar zijn
window.linkToBacksweetenCalc = linkToBacksweetenCalc;
window.linkToDilutionCalc = linkToDilutionCalc;
window.loadUserWaterProfiles = loadUserWaterProfiles;