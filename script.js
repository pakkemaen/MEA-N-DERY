import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, addDoc, onSnapshot, doc, updateDoc, query, deleteDoc, getDoc, setDoc, writeBatch, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// IIFE to create a private scope and avoid polluting the global namespace
(function() {
    // --- App State ---
    let db, auth, userId;
    let brews = []; // Local cache of brews
    let inventory = []; // Local cache of inventory
    let userSettings = {}; // Holds settings from Firestore
    let currentBrewDay = { brewId: null, checklist: {} }; // Holds the state for the current brew day
    let currentRecipeMarkdown = ''; // To hold the latest generated recipe markdown
    let currentWaterProfile = null; // To hold the fetched water data
    let costChart = null; // To hold the chart instance

    // --- UI Elements ---
    const dashboardMainView = document.getElementById('dashboard-main-view');
    const creatorView = document.getElementById('creator-view');
    const brewingView = document.getElementById('brewing-view');
    const historyView = document.getElementById('history-view');
    const inventoryView = document.getElementById('inventory-view');
    const planningView = document.getElementById('planning-view');
    const financialsView = document.getElementById('financials-view');
    const socialView = document.getElementById('social-view');
    const troubleshootView = document.getElementById('troubleshoot-view');
    const calculatorsView = document.getElementById('calculators-view');
    const waterView = document.getElementById('water-view');
    const settingsView = document.getElementById('settings-view');
    
    const brewingMainView = document.getElementById('brewing-main-view');
    const managementMainView = document.getElementById('management-main-view');
    const toolsMainView = document.getElementById('tools-main-view');

    const styleSelect = document.getElementById('style');
    const fruitSection = document.getElementById('fruit-section');
    const spiceSection = document.getElementById('spice-section');
    const braggotSection = document.getElementById('braggot-section');
    const generateBtn = document.getElementById('generateBtn');
    const recipeOutput = document.getElementById('recipe-output');
    const brewDayContent = document.getElementById('brew-day-content');
    const historyList = document.getElementById('history-list');
    const historyDetailContainer = document.getElementById('history-detail-container');
    const historyListContainer = document.getElementById('history-list-container');
    const inventoryForm = document.getElementById('inventory-form');
    const inventoryList = document.getElementById('inventory-list');
    const fetchWaterProfileBtn = document.getElementById('fetchWaterProfileBtn');
    const getWaterAdviceBtn = document.getElementById('getWaterAdviceBtn');
    const getYeastAdviceBtn = document.getElementById('getYeastAdviceBtn');
    const waterSourceSelect = document.getElementById('waterSource');
    const manualWaterProfileDiv = document.getElementById('manualWaterProfile');
    const troubleshootBtn = document.getElementById('troubleshoot-btn');

    
    // Settings UI
    const apiKeyInput = document.getElementById('apiKeyInput');
    const defaultBatchSizeInput = document.getElementById('defaultBatchSizeInput');
    const defaultCurrencyInput = document.getElementById('defaultCurrencyInput');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const settingsMessage = document.getElementById('settingsMessage');
    const themeToggle = document.getElementById('theme-toggle-checkbox');
    const exportHistoryBtn = document.getElementById('exportHistoryBtn');
    const exportInventoryBtn = document.getElementById('exportInventoryBtn');
    const importHistoryFile = document.getElementById('importHistoryFile');
    const importInventoryFile = document.getElementById('importInventoryFile');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    const clearInventoryBtn = document.getElementById('clearInventoryBtn');

    // Financials UI
    const calculateOverheadBtn = document.getElementById('calculateOverheadBtn');
    
    // --- Initialization ---
    function initApp() {
        // Your web app's Firebase configuration
        const firebaseConfig = {
          apiKey: "AIzaSyAhOOrwJCYve5XTGS6oXvhCg_l3_LcK00I",
          authDomain: "meandery-aa05e.firebaseapp.com",
          projectId: "meandery-aa05e",
          storageBucket: "meandery-aa05e.appspot.com",
          messagingSenderId: "388311971225",
          appId: "1:388311971225:web:e5b0e81ce18d96b4a88f08",
          measurementId: "G-S5CPLP80XT"
        };

        try {
            const app = initializeApp(firebaseConfig);
            db = getFirestore(app);
            auth = getAuth(app);

            onAuthStateChanged(auth, async (user) => {
                if (user) {
                    userId = user.uid;
                    loadHistory();
                    loadInventory();
                    loadUserSettings(); // Load settings from Firestore
                } else {
                    try {
                        await signInAnonymously(auth);
                    } catch (error) {
                        console.error("Anonymous authentication failed:", error);
                        recipeOutput.innerHTML = `<p class="text-red-500">Could not connect to the database. History & Inventory will not be available.</p>`;
                    }
                }
            });
        } catch (e) {
            console.error("Firebase initialization failed. App will run in offline mode.", e);
            recipeOutput.innerHTML = `<p class="text-orange-600 font-bold">Running in offline mode. History and Inventory are disabled.</p>`;
        }


        // --- Event Listeners ---
        document.querySelectorAll('.main-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => switchMainView(btn.dataset.view));
        });
        document.querySelectorAll('.back-to-dashboard-btn').forEach(btn => {
            btn.addEventListener('click', () => switchMainView('dashboard'));
        });

        document.querySelectorAll('.sub-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const parentId = e.target.closest('[id$="-main-view"]').id;
                switchSubView(e.target.id.replace('-sub-tab', ''), parentId);
            });
        });

        styleSelect.addEventListener('change', handleStyleChange);
        generateBtn.addEventListener('click', generateRecipe);
        inventoryForm.addEventListener('submit', addInventoryItem);
        
        // Calculator buttons
        document.getElementById('calcAbvBtn').addEventListener('click', calculateABV);
        document.getElementById('correctSgBtn').addEventListener('click', correctHydrometer);
        document.getElementById('calcSugarBtn').addEventListener('click', calculatePrimingSugar);
        document.getElementById('calcBlendBtn').addEventListener('click', calculateBlend);
        getYeastAdviceBtn.addEventListener('click', getYeastAdvice);
        
        // Water tab buttons
        fetchWaterProfileBtn.addEventListener('click', fetchWaterProfile);
        waterSourceSelect.addEventListener('change', handleWaterSourceChange);
        getWaterAdviceBtn.addEventListener('click', getWaterAdvice);

        // Settings
        saveSettingsBtn.addEventListener('click', saveUserSettings);
        themeToggle.addEventListener('change', (e) => applyTheme(e.target.checked ? 'dark' : 'light'));
        exportHistoryBtn.addEventListener('click', exportHistory);
        exportInventoryBtn.addEventListener('click', exportInventory);
        importHistoryFile.addEventListener('change', importHistory);
        importInventoryFile.addEventListener('change', importInventory);
        clearHistoryBtn.addEventListener('click', clearHistory);
        clearInventoryBtn.addEventListener('click', clearInventory);

        // Financials
        calculateOverheadBtn.addEventListener('click', calculateOverhead);
        
        // Troubleshoot
        troubleshootBtn.addEventListener('click', getTroubleshootingAdvice);

        handleStyleChange();
    }

    // --- View Management ---
    function switchMainView(viewName) {
        // Hide all main views
        [dashboardMainView, brewingMainView, managementMainView, toolsMainView, settingsView].forEach(v => v.classList.add('hidden'));
        
        const viewToShow = document.getElementById(`${viewName}-main-view`);

        if (viewToShow) {
            viewToShow.classList.remove('hidden');
        } else if (viewName === 'settings') {
            settingsView.classList.remove('hidden');
        }
    }

    function switchSubView(viewName, parentViewId) {
        const parentView = document.getElementById(parentViewId);
        // Hide all sub-views within this parent
        parentView.querySelectorAll('[id$="-view"]').forEach(v => v.classList.add('hidden'));
        // Deactivate all sub-tabs within this parent
        parentView.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));

        const viewToShow = document.getElementById(`${viewName}-view`);
        const tabToActivate = document.getElementById(`${viewName}-sub-tab`);

        if (viewToShow) viewToShow.classList.remove('hidden');
        if (tabToActivate) tabToActivate.classList.add('active');
    }


    function handleStyleChange() {
        const selectedStyle = styleSelect.value;
        fruitSection.classList.toggle('hidden', selectedStyle !== 'melomel');
        spiceSection.classList.toggle('hidden', selectedStyle !== 'metheglin');
        braggotSection.classList.toggle('hidden', selectedStyle !== 'braggot');
    }

    // --- Settings Management (Firebase) ---
    async function loadUserSettings() {
        if (!userId) return;
        const appId = 'meandery-aa05e';
        const settingsDocRef = doc(db, 'artifacts', appId, 'users', userId, 'settings', 'main');
        
        try {
            const docSnap = await getDoc(settingsDocRef);
            if (docSnap.exists()) {
                userSettings = docSnap.data();
                currentBrewDay = userSettings.currentBrewDay || { brewId: null, checklist: {} };
                if(currentBrewDay.brewId) {
                   renderBrewDay(currentBrewDay.brewId);
                }
            } else {
                // Apply default settings if none exist
                userSettings = { apiKey: 'AIzaSyCWfyqZ_Qzk2m4rvGEw0wBwu4C8RyvL-yY', defaultBatchSize: 5, currencySymbol: '€', theme: 'light' };
            }
            applySettings();
        } catch (error) {
            console.error("Error loading user settings:", error);
        }
    }
    
    function applySettings() {
        // Apply settings to the UI
        apiKeyInput.value = userSettings.apiKey || '';
        document.getElementById('batchSize').value = userSettings.defaultBatchSize || 5;
        defaultBatchSizeInput.value = userSettings.defaultBatchSize || 5;
        defaultCurrencyInput.value = userSettings.currencySymbol || '€';
        themeToggle.checked = (userSettings.theme === 'dark');
        
        const priceLabel = document.querySelector('label[for="itemPrice"]');
        if(priceLabel) {
            priceLabel.textContent = `Price (${userSettings.currencySymbol || '€'})`;
        }
        
        applyTheme(userSettings.theme);
        renderInventory(); // Re-render inventory to update currency symbol
    }

    async function saveUserSettings() {
        if (!userId) return;
        const appId = 'meandery-aa05e';
        const settingsDocRef = doc(db, 'artifacts', appId, 'users', userId, 'settings', 'main');

        const newSettings = {
            apiKey: apiKeyInput.value.trim(),
            defaultBatchSize: parseFloat(defaultBatchSizeInput.value) || 5,
            currencySymbol: defaultCurrencyInput.value.trim() || '€',
            theme: themeToggle.checked ? 'dark' : 'light',
            currentBrewDay: currentBrewDay // Persist brew day state
        };

        try {
            await setDoc(settingsDocRef, newSettings, { merge: true });
            userSettings = newSettings; // Update local state
            applySettings(); // Re-apply settings to UI
            settingsMessage.textContent = 'Settings saved successfully!';
            settingsMessage.style.color = 'var(--success-color)';
            setTimeout(() => { settingsMessage.textContent = ''; }, 3000);
        } catch (error) {
            console.error("Error saving settings:", error);
            settingsMessage.textContent = 'Failed to save settings.';
            settingsMessage.style.color = 'var(--danger-color)';
            setTimeout(() => { settingsMessage.textContent = ''; }, 3000);
        }
    }

    function applyTheme(theme) {
        if (theme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }

    // --- Data Management Functions ---
    function exportData(data, filename) {
        const dataToExport = data.map(item => {
            const newItem = {...item};
            // Convert Firestore Timestamps to a serializable format
            if (newItem.createdAt && typeof newItem.createdAt.toDate === 'function') {
                newItem.createdAt = newItem.createdAt.toDate().toISOString();
            }
            return newItem;
        });
        const jsonStr = JSON.stringify(dataToExport, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function exportHistory() {
        exportData(brews, 'meandery_history_export.json');
    }

    function exportInventory() {
        exportData(inventory, 'meandery_inventory_export.json');
    }

    function importData(event, collectionName) {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (!Array.isArray(data)) throw new Error("Invalid JSON format. Expected an array.");

                if (!confirm(`This will OVERWRITE your current ${collectionName}. This cannot be undone. Are you sure?`)) return;

                settingsMessage.textContent = `Importing ${collectionName}...`;
                settingsMessage.style.color = 'var(--info-color)';
                const appId = 'meandery-aa05e';
                const collectionRef = collection(db, 'artifacts', appId, 'users', userId, collectionName);
                
                // Clear existing data first
                await clearCollection(collectionName, false); // false to suppress confirmation

                // Batch write new data
                const batch = writeBatch(db);
                data.forEach(item => {
                    const { id, ...itemData } = item; // remove id if it exists from export
                    // Convert ISO string date back to Firestore Timestamp object
                    if (itemData.createdAt && typeof itemData.createdAt === 'string') {
                        itemData.createdAt = new Date(itemData.createdAt);
                    }
                    const newDocRef = doc(collectionRef);
                    batch.set(newDocRef, itemData);
                });
                await batch.commit();
                settingsMessage.textContent = `${collectionName} imported successfully!`;
                settingsMessage.style.color = 'var(--success-color)';
            } catch (error) {
                console.error(`Error importing ${collectionName}:`, error);
                settingsMessage.textContent = `Error: ${error.message}`;
                settingsMessage.style.color = 'var(--danger-color)';
            } finally {
                setTimeout(() => { settingsMessage.textContent = ''; }, 5000);
                event.target.value = ''; // Reset file input
            }
        };
        reader.readAsText(file);
    }

    function importHistory(e) {
        importData(e, 'brews');
    }

    function importInventory(e) {
        importData(e, 'inventory');
    }

    async function clearCollection(collectionName, confirmFirst = true) {
        if (confirmFirst && !confirm(`DANGER: This will permanently delete all your ${collectionName}. This cannot be undone. Are you sure?`)) {
            return false;
        }
        if (!userId) return false;
        const appId = 'meandery-aa05e';
        const collectionRef = collection(db, 'artifacts', appId, 'users', userId, collectionName);
        const snapshot = await getDocs(collectionRef);
        if (snapshot.empty) return true; // Nothing to delete
        const batch = writeBatch(db);
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();
        return true;
    }

    async function clearHistory() {
        if (await clearCollection('brews')) {
            settingsMessage.textContent = 'Brew history cleared.';
            settingsMessage.style.color = 'var(--success-color)';
            setTimeout(() => { settingsMessage.textContent = ''; }, 3000);
        }
    }
    
    async function clearInventory() {
        if (await clearCollection('inventory')) {
            settingsMessage.textContent = 'Inventory cleared.';
            settingsMessage.style.color = 'var(--success-color)';
            setTimeout(() => { settingsMessage.textContent = ''; }, 3000);
        }
    }


    // --- Core AI Functions ---
    async function performApiCall(prompt) {
        const defaultApiKey = 'AIzaSyCWfyqZ_Qzk2m4rvGEw0wBwu4C8RyvL-yY';
        const apiKey = userSettings.apiKey || defaultApiKey;
        
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
        let chatHistory = [{ role: "user", parts: [{ text: prompt }] }];
        const payload = { contents: chatHistory };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.json();
            const errorMessage = errorBody?.error?.message || `API request failed with status ${response.status}`;
            throw new Error(errorMessage);
        }
        
        const result = await response.json();

        if (result.candidates && result.candidates[0].content && result.candidates[0].content.parts) {
            return result.candidates[0].content.parts[0].text;
        } else {
            throw new Error("Invalid response structure from API.");
        }
    }

    async function generateRecipe() {
        recipeOutput.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">Consulting the Alchemist... your custom recipe is being crafted.</p>';
        generateBtn.disabled = true;
        generateBtn.classList.add('opacity-50', 'cursor-not-allowed');

        try {
            const prompt = buildPrompt();
            currentRecipeMarkdown = await performApiCall(prompt);
            const recipeHtml = marked.parse(currentRecipeMarkdown);
            
            const fullHtml = `
                <div class="print-button-container text-right mb-4 flex justify-end gap-2 no-print">
                    <button onclick="window.printEmptyLog()" class="bg-stone-500 text-white py-2 px-4 rounded-lg hover:bg-stone-600 transition-colors btn">
                        Print Empty Log
                    </button>
                    <button onclick="window.print()" class="bg-stone-600 text-white py-2 px-4 rounded-lg hover:bg-stone-700 transition-colors btn">
                        Print Recipe & Log
                    </button>
                </div>
                <div class="recipe-content">${recipeHtml}</div>
                <div class="mt-6 no-print">
                    <button id="saveBtn" class="w-full bg-green-700 text-white font-bold py-3 px-4 rounded-lg hover:bg-green-800 transition-colors btn">
                        Save to Brew History
                    </button>
                </div>
                ${getBrewLogHtml(null)}
            `;
            recipeOutput.innerHTML = fullHtml;
            document.getElementById('saveBtn').addEventListener('click', saveBrewToHistory);
        } catch (error) {
            console.error("Error calling Gemini API:", error);
            recipeOutput.innerHTML = `<p class="text-center text-red-600 font-bold">Sorry, the Alchemist is busy. Please try again.</p><p class="text-center text-sm text-app-secondary/80">${error.message}</p>`;
        } finally {
            generateBtn.disabled = false;
            generateBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }

    function buildPrompt() {
        const customDescription = document.getElementById('customDescription').value;
        const batchSize = document.getElementById('batchSize').value;
        const useInventory = document.getElementById('useInventory').checked;
        const nutrientProtocol = document.getElementById('nutrientProtocol').selectedOptions[0].text;
        let prompt;
        const personaAndConstraints = `You are an expert mead maker named "The MEA(N)DERY Alchemist". All ingredients you recommend (especially yeast strains, honey types, and special adjuncts) must be readily available in Belgium or through common European homebrew suppliers.`;

        if (customDescription.trim() !== '') {
            prompt = `${personaAndConstraints} A user wants to create a unique mead from scratch. Their primary instruction is a text description. You MUST prioritize this description to generate the recipe. Any other form fields should be IGNORED, except for the Batch Size. The user's description is: "${customDescription}" The recipe must be for a ${batchSize}-liter batch. Based ONLY on the user's description and the batch size, create a detailed, world-class mead recipe. Infer the style, ABV, sweetness, honey type, and other ingredients from their text. If they don't specify something like ABV, make an expert recommendation that fits their description.`;
        } else if (useInventory) {
            const inventoryString = inventory.map(item => `${item.name}: ${item.qty} ${item.unit}`).join(', ');
            prompt = `${personaAndConstraints} A user wants you to create a recipe using ingredients they already have in stock. Their inventory is: [${inventoryString}]. 
            
            Use the following parameters as a creative brief:
            - Batch Size: ${batchSize} liters
            - Target ABV: Approximately ${document.getElementById('abv').value}%
            - Desired Final Sweetness: ${document.getElementById('sweetness').selectedOptions[0].text}
            - Overall Style Inspiration: ${document.getElementById('style').selectedOptions[0].text}

            Your primary goal is to create the best possible recipe that uses the available ingredients. If the inventory is insufficient to make a good recipe matching the style, state that clearly in the Brewer's Notes and list the essential ingredients the user needs to buy.`;
        
        } else {
            const targetAbv = document.getElementById('abv').value;
            const sweetness = document.getElementById('sweetness').selectedOptions[0].text;
            const style = document.getElementById('style').selectedOptions[0].text;
            const honeyVariety = document.getElementById('honeyVariety').value;
            const addOak = document.getElementById('addOak').checked;
            const specialIngredients = document.getElementById('specialIngredients').value;

            prompt = `${personaAndConstraints} Create a detailed, world-class mead recipe from scratch based on the following structured options:
            - Batch Size: ${batchSize} liters
            - Target ABV: Approximately ${targetAbv}%
            - Desired Final Sweetness: ${sweetness}
            - Overall Style Inspiration: ${style}
            - Primary Honey: ${honeyVariety} honey`;

            if (style.includes('Melomel')) {
                const fruits = Array.from(document.querySelectorAll('#fruit-section input:checked')).map(el => el.labels[0].innerText);
                prompt += `\n- Featured Fruits: ${fruits.length > 0 ? fruits.join(', ') : 'Please suggest a classic fruit combination.'}`;
            } else if (style.includes('Metheglin')) {
                const spices = Array.from(document.querySelectorAll('#spice-section input:checked')).map(el => el.labels[0].innerText);
                prompt += `\n- Featured Spices: ${spices.length > 0 ? spices.join(', ') : 'Please suggest a classic spice blend.'}`;
            } else if (style.includes('Braggot')) {
                const braggotStyle = document.getElementById('braggotStyle').selectedOptions[0].text;
                prompt += `\n- Braggot Base: Based on a ${braggotStyle} style. Provide an extract-based recipe.`;
            }
            if (addOak) {
                prompt += '\n- Oak Aging: The recipe must include a step for aging with oak.';
            }
            if (specialIngredients && specialIngredients.trim() !== '') {
                prompt += `\n- Special Ingredients: The recipe must creatively incorporate: ${specialIngredients}.`;
            }
        }
        prompt += `\n\nFor the final output, generate a full recipe. It must be suitable for an experienced homebrewer. It must use the "${nutrientProtocol}" nutrient schedule. Provide specific ingredient quantities scaled for the batch size. Detail a no-heat method for must preparation. Include recommendations for a specific yeast strain. Give advice on aging. For the 'Ingredients' section, you MUST format it as a Markdown table with columns: | Ingredient | Quantity | Unit |. This is essential. If applicable, provide carbonation targets and priming sugar amounts. Format the rest of the response in Markdown with a creative title and clear headings for 'Description', 'Ingredients', 'Instructions', and 'Brewer's Notes'.`;
        return prompt;
    }
    
    // --- Firestore & History Functions ---
    async function saveBrewToHistory() {
        if (!userId || !currentRecipeMarkdown) {
            console.error("Cannot save. No user identified or no recipe generated.");
            return;
        }
        const saveButton = document.getElementById('saveBtn');
        saveButton.textContent = 'Saving...';
        saveButton.disabled = true;

        const logData = getLogDataFromDOM('recipe-output');
        const batchSize = parseFloat(document.getElementById('batchSize').value) || 5;

        const brewData = {
            userId: userId,
            recipeName: logData.recipeName || "Untitled Brew",
            recipeMarkdown: currentRecipeMarkdown,
            logData: logData,
            createdAt: new Date(),
            batchSize: batchSize,
            totalCost: parseIngredientsAndCalculateCost(currentRecipeMarkdown, inventory, batchSize)
        };

        try {
            const appId = 'meandery-aa05e';
            const brewsCol = collection(db, 'artifacts', appId, 'users', userId, 'brews');
            const docRef = await addDoc(brewsCol, brewData);
            
            // Add a button to start brew day right after saving
            const startBrewDayBtn = document.createElement('button');
            startBrewDayBtn.textContent = 'Start Brew Day';
            startBrewDayBtn.className = 'w-full mt-4 bg-green-600 text-white font-bold py-3 px-4 rounded-lg hover:bg-green-700 transition-colors btn';
            startBrewDayBtn.onclick = () => startBrewDay(docRef.id);
            saveButton.parentElement.appendChild(startBrewDayBtn);

            saveButton.textContent = 'Saved!';
            saveButton.classList.replace('bg-green-700', 'bg-gray-500');
        } catch (error) {
            console.error("Error saving brew:", error);
            saveButton.textContent = 'Save to Brew History';
            saveButton.disabled = false;
        }
    }

    function loadHistory() {
        if (!userId) return;
        const appId = 'meandery-aa05e';
        const brewsCol = collection(db, 'artifacts', appId, 'users', userId, 'brews');
        const q = query(brewsCol);

        onSnapshot(q, (snapshot) => {
            brews = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            brews.sort((a, b) => b.createdAt.toDate() - a.createdAt.toDate()); // Sort newest first
            renderHistoryList();
            updateCostAnalysis();
        }, (error) => {
            console.error("Error loading history: ", error);
            historyList.innerHTML = `<p class="text-red-500">Could not load brew history.</p>`;
        });
    }

    function renderHistoryList() {
        if (brews.length === 0) {
            historyList.innerHTML = `<p class="text-center text-app-secondary/80">You haven't saved any brews yet. Go create one!</p>`;
            return;
        }
        historyList.innerHTML = brews.map(brew => `
            <div class="p-4 card rounded-lg cursor-pointer hover:bg-app-primary" onclick="window.showBrewDetail('${brew.id}')">
                <h4 class="font-bold text-lg font-header">${brew.recipeName || 'Untitled Brew'}</h4>
                <p class="text-sm text-app-secondary/80">Saved on: ${brew.createdAt.toDate().toLocaleDateString()}</p>
            </div>
        `).join('');
    }

    window.showBrewDetail = function(brewId) {
        const brew = brews.find(b => b.id === brewId);
        if (!brew) return;

        const recipeHtml = marked.parse(brew.recipeMarkdown);
        const logHtml = getBrewLogHtml(brew.logData, brew.id);
        const currency = userSettings.currencySymbol || '€';
        
        let costHtml = '';
        if (brew.totalCost !== undefined && brew.totalCost > 0) {
            const bottles = brew.batchSize / 0.75; // Assuming 750ml bottles
            const costPerBottle = brew.totalCost / bottles;
            costHtml = `
                <div class="mt-6 p-4 bg-amber-50 rounded-lg dark:bg-opacity-10">
                    <h3 class="font-header text-lg text-stone-800 dark:text-amber-200">Batch Cost Analysis</h3>
                    <p class="text-stone-800 dark:text-amber-200"><strong>Total Batch Cost:</strong> ${currency}${brew.totalCost.toFixed(2)}</p>
                    <p class="text-stone-800 dark:text-amber-200"><strong>Cost Per 750ml Bottle:</strong> ${currency}${costPerBottle.toFixed(2)}</p>
                </div>
            `;
        }


        historyDetailContainer.innerHTML = `
            <button onclick="window.goBackToHistoryList()" class="mb-4 text-app-brand hover:underline no-print">&larr; Back to History</button>
            <div class="print-button-container text-right mb-4 flex justify-end gap-2 no-print">
                <button onclick="window.startBrewDay('${brew.id}')" class="bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 transition-colors btn">Start Brew Day</button>
                <button onclick="window.generateShoppingList('${brew.id}')" class="bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors btn">Generate Shopping List</button>
                <button onclick="window.generateSocialContent('${brew.id}')" class="bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700 transition-colors btn">Generate Social Post</button>
            </div>
            <div class="recipe-content">${recipeHtml}</div>
            ${costHtml}
            ${logHtml}
            <div id="log-update-message-${brew.id}" class="text-center text-blue-700 font-semibold mt-4 h-6"></div>
            <div class="mt-2 flex flex-col md:flex-row gap-4 no-print">
                <button onclick="window.updateBrewLog('${brew.id}')" class="flex-1 bg-blue-700 text-white font-bold py-3 px-4 rounded-lg hover:bg-blue-800 transition-colors btn">
                    Save Log Changes
                </button>
                <button onclick="window.tweakRecipe('${brew.id}')" class="flex-1 bg-purple-700 text-white font-bold py-3 px-4 rounded-lg hover:bg-purple-800 transition-colors btn">
                    Tweak Recipe with AI
                </button>
                <button id="scale-recipe-btn-${brew.id}" onclick="window.toggleScaleUI('${brew.id}')" class="flex-1 bg-teal-700 text-white font-bold py-3 px-4 rounded-lg hover:bg-teal-800 transition-colors btn">
                    Scale Recipe
                </button>
            </div>
            <div id="scale-ui-${brew.id}" class="hidden mt-4 p-4 border-t-2 border-teal-700 no-print">
                <label for="new-batch-size-${brew.id}" class="block font-bold">New Batch Size (Liters):</label>
                <input type="number" id="new-batch-size-${brew.id}" class="w-full p-2 border rounded mt-2 text-app-primary bg-app-tertiary border-app" placeholder="e.g., 20">
                <button onclick="window.scaleRecipe('${brew.id}')" class="w-full mt-2 bg-teal-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-teal-700 btn">Generate Scaled Recipe</button>
            </div>
            <div id="tweak-output-${brew.id}" class="mt-6"></div>
        `;
        historyListContainer.classList.add('hidden');
        historyDetailContainer.classList.remove('hidden');
    }
    
    window.toggleScaleUI = function(brewId) {
        const scaleUI = document.getElementById(`scale-ui-${brew.id}`);
        scaleUI.classList.toggle('hidden');
    }
    
    window.scaleRecipe = async function(brewId) {
        const brew = brews.find(b => b.id === brewId);
        const newSize = document.getElementById(`new-batch-size-${brew.id}`).value;
        if (!brew || !newSize || isNaN(parseFloat(newSize))) {
            console.error("Invalid new batch size.");
            return;
        }

        const tweakOutput = document.getElementById(`tweak-output-${brew.id}`);
        tweakOutput.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">The Alchemist is scaling your recipe...</p>';

        const prompt = `You are an expert mead maker. Take the following mead recipe and scale it to a new batch size of ${newSize} liters. Adjust all ingredient quantities proportionally. Keep the instructions and brewer's notes the same, but update any references to volume. Format the response in Markdown, making sure the ingredients list is a Markdown table with columns: | Ingredient | Quantity | Unit |. Here is the original recipe:\n\n---\n${brew.recipeMarkdown}`;
        
        try {
            const scaledMarkdown = await performApiCall(prompt);
            tweakOutput.innerHTML = `<div class="mt-4 p-4 border-t-2 border-teal-700">${marked.parse(scaledMarkdown)}</div>`;
        } catch (error) {
            console.error("Error scaling recipe:", error);
            tweakOutput.innerHTML = `<p class="text-center text-red-500">Could not scale the recipe: ${error.message}</p>`;
        }
    }


    window.goBackToHistoryList = function() {
        historyDetailContainer.classList.add('hidden');
        historyListContainer.classList.remove('hidden');
    }
    
    window.updateBrewLog = async function(brewId) {
         if (!userId || !brewId) return;
         const logData = getLogDataFromDOM(`history-detail-container`);
         const messageDiv = document.getElementById(`log-update-message-${brew.id}`);
         try {
            const appId = 'meandery-aa05e';
            const brewDocRef = doc(db, 'artifacts', appId, 'users', userId, 'brews', brewId);
            await updateDoc(brewDocRef, { logData: logData });
            messageDiv.textContent = 'Log updated successfully!';
         } catch(error) {
            console.error("Error updating log:", error);
            messageDiv.textContent = 'Failed to update log.';
            messageDiv.classList.replace('text-blue-700', 'text-red-700');
         } finally {
            setTimeout(() => { 
                messageDiv.textContent = ''; 
                messageDiv.classList.replace('text-red-700', 'text-blue-700');
            }, 3000);
         }
    }
    
    window.tweakRecipe = async function(brewId) {
        const brew = brews.find(b => b.id === brewId);
        if (!brew) return;
        
        const tweakOutput = document.getElementById(`tweak-output-${brew.id}`);
        tweakOutput.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">The Alchemist is rethinking your recipe...</p>';

        const tastingNotes = document.getElementById(`tastingNotes-${brew.id}`).value;
        if (!tastingNotes.trim()) {
            tweakOutput.innerHTML = `<p class="text-center text-red-500">Please enter some tasting notes before tweaking!</p>`;
            return;
        }

        const prompt = `You are an expert mead maker. A user has brewed the following mead recipe:\n\n---\n${brew.recipeMarkdown}\n---\n\nThey have provided these tasting notes on the finished product: "${tastingNotes}".\n\nBased on their notes, provide specific suggestions for improvement and generate a new, revised recipe that addresses their feedback. Format the response in Markdown.`;

        try {
            const tweakedMarkdown = await performApiCall(prompt);
            tweakOutput.innerHTML = `<div class="mt-4 p-4 border-t-2 border-amber-700">${marked.parse(tweakedMarkdown)}</div>`;
        } catch (error) {
            console.error("Error tweaking recipe:", error);
            tweakOutput.innerHTML = `<p class="text-center text-red-500">Could not get a tweaked recipe: ${error.message}</p>`;
        }
    }
    
    // --- Inventory Functions ---
    async function addInventoryItem(e) {
        e.preventDefault();
        if (!userId) {
            console.error("You must be logged in to manage inventory.");
            return;
        }

        const name = document.getElementById('itemName').value;
        const qty = parseFloat(document.getElementById('itemQty').value);
        const unit = document.getElementById('itemUnit').value;
        const price = parseFloat(document.getElementById('itemPrice').value);
        const category = document.getElementById('itemCategory').value;

        if (!name || isNaN(qty) || isNaN(price)) {
            console.error("Please fill out all fields correctly.");
            return;
        }

        const itemData = { userId, name, qty, unit, price, category };
        
        try {
            const appId = 'meandery-aa05e';
            const invCol = collection(db, 'artifacts', appId, 'users', userId, 'inventory');
            await addDoc(invCol, itemData);
            inventoryForm.reset();
        } catch (error) {
            console.error("Error adding inventory item:", error);
        }
    }

    function loadInventory() {
        if (!userId) return;
        const appId = 'meandery-aa05e';
        const invCol = collection(db, 'artifacts', appId, 'users', userId, 'inventory');
        const q = query(invCol);

        onSnapshot(q, (snapshot) => {
            inventory = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            renderInventory();
            updateCostAnalysis();
        }, (error) => {
            console.error("Error loading inventory: ", error);
            inventoryList.innerHTML = `<p class="text-red-500">Could not load inventory.</p>`;
        });
    }

    function renderInventory() {
        const grouped = inventory.reduce((acc, item) => {
            (acc[item.category] = acc[item.category] || []).push(item);
            return acc;
        }, {});

        const categories = ['Honey', 'Yeast', 'Nutrient', 'Malt Extract', 'Fruit', 'Spice', 'Adjunct', 'Chemical'];
        const currency = userSettings.currencySymbol || '€';
        let html = '';

        for (const category of categories) {
            if (grouped[category]) {
                html += `<h3 class="text-xl font-header mt-4 mb-2">${category}</h3>`;
                html += `<div class="space-y-2">`;
                grouped[category].forEach(item => {
                    html += `<div id="item-${item.id}" class="flex justify-between items-center p-2 card rounded-md">
                        <span>${item.name}</span>
                        <div class="flex items-center gap-4">
                            <span class="font-semibold">${item.qty} ${item.unit} - ${currency}${(item.price || 0).toFixed(2)}</span>
                            <div class="flex gap-2">
                                <button onclick="window.editInventoryItem('${item.id}')" class="text-blue-600 hover:text-blue-800 text-sm">Edit</button>
                                <button onclick="window.deleteInventoryItem('${item.id}')" class="text-red-600 hover:text-red-800 text-sm">Delete</button>
                            </div>
                        </div>
                    </div>`;
                });
                html += `</div>`;
            }
        }
        
        if (inventory.length === 0) {
            html = `<p class="text-center text-app-secondary/80">Your inventory is empty. Add your first ingredient!</p>`;
        }

        inventoryList.innerHTML = html;
    }

    window.deleteInventoryItem = async function(itemId) {
        if (!userId) return;
        try {
            const appId = 'meandery-aa05e';
            const itemDocRef = doc(db, 'artifacts', appId, 'users', userId, 'inventory', itemId);
            await deleteDoc(itemDocRef);
        } catch (error) {
            console.error("Error deleting item:", error);
        }
    }

    window.editInventoryItem = function(itemId) {
        const item = inventory.find(i => i.id === itemId);
        if (!item) return;

        const itemDiv = document.getElementById(`item-${itemId}`);
        itemDiv.innerHTML = `
            <input type="text" id="edit-name-${itemId}" value="${item.name}" class="flex-grow p-1 border rounded bg-app-tertiary border-app text-app-primary">
            <div class="flex items-center gap-2">
                <input type="number" id="edit-qty-${itemId}" value="${item.qty}" class="w-20 p-1 border rounded bg-app-tertiary border-app text-app-primary">
                <input type="text" id="edit-unit-${itemId}" value="${item.unit}" class="w-20 p-1 border rounded bg-app-tertiary border-app text-app-primary">
                <input type="number" id="edit-price-${itemId}" value="${(item.price || 0).toFixed(2)}" class="w-20 p-1 border rounded bg-app-tertiary border-app text-app-primary" step="0.01">
                <button onclick="window.updateInventoryItem('${itemId}')" class="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 text-sm">Save</button>
                <button onclick="renderInventory()" class="bg-gray-500 text-white px-3 py-1 rounded hover:bg-gray-600 text-sm">Cancel</button>
            </div>
        `;
    }

    window.updateInventoryItem = async function(itemId) {
        if (!userId) return;
        const newName = document.getElementById(`edit-name-${itemId}`).value;
        const newQty = parseFloat(document.getElementById(`edit-qty-${itemId}`).value);
        const newUnit = document.getElementById(`edit-unit-${itemId}`).value;
        const newPrice = parseFloat(document.getElementById(`edit-price-${itemId}`).value);

        if (!newName || isNaN(newQty) || isNaN(newPrice)) {
            console.error("Please provide a valid name, quantity, and price.");
            return;
        }

        try {
            const appId = 'meandery-aa05e';
            const itemDocRef = doc(db, 'artifacts', appId, 'users', userId, 'inventory', itemId);
            await updateDoc(itemDocRef, { name: newName, qty: newQty, unit: newUnit, price: newPrice });
        } catch (error) {
            console.error("Error updating item:", error);
        }
    }

    // --- Calculator Functions ---
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
        
        // Formula for hydrometer correction
        const correctedSg = sg * ((1.00130346 - 0.000134722124 * t + 0.00000204052596 * t**2 - 0.00000000232820948 * t**3) / (1.00130346 - 0.000134722124 * c + 0.00000204052596 * c**2 - 0.00000000232820948 * c**3));
        resultDiv.textContent = `Corrected: ${correctedSg.toFixed(3)}`;
    }

    function calculatePrimingSugar() {
        const vol = parseFloat(document.getElementById('carbVol').value);
        const temp = parseFloat(document.getElementById('carbTemp').value);
        const size = parseFloat(document.getElementById('carbBatchSize').value);
        const resultDiv = document.getElementById('sugarResult');

        if (isNaN(vol) || isNaN(temp) || isNaN(size)) {
            resultDiv.textContent = 'Invalid Input';
            return;
        }
        
        // Formula for priming sugar (sucrose)
        const sugarGrams = (vol - (3.0378 - 0.050062 * temp + 0.00026555 * temp**2)) * 4 * size;
        resultDiv.textContent = `${sugarGrams.toFixed(1)} g sugar`;
    }
    
    function calculateBlend() {
        const vol1 = parseFloat(document.getElementById('vol1').value);
        const sg1 = parseFloat(document.getElementById('sg1').value);
        const vol2 = parseFloat(document.getElementById('vol2').value);
        const sg2 = parseFloat(document.getElementById('sg2').value);
        const resultDiv = document.getElementById('blendResult');

        if (isNaN(vol1) || isNaN(sg1) || isNaN(vol2) || isNaN(sg2)) {
            resultDiv.textContent = 'Invalid Input';
            return;
        }

        const totalVolume = vol1 + vol2;
        const finalSG = (((vol1 * (sg1 - 1)) + (vol2 * (sg2 - 1))) / totalVolume) + 1;
        
        resultDiv.textContent = `Final: ${totalVolume.toFixed(2)}L at ${finalSG.toFixed(3)} SG`;
    }

    async function getYeastAdvice() {
        const og = document.getElementById('starterOG').value;
        const yeastDate = document.getElementById('yeastDate').value;
        const yeastType = document.getElementById('yeastType').value;
        const adviceOutput = document.getElementById('yeast-advice-output');

        if (!og || !yeastDate) {
            adviceOutput.innerHTML = `<p class="text-red-500">Please enter both Starting Gravity and Yeast Date.</p>`;
            return;
        }
        adviceOutput.innerHTML = '<div class="loader"></div>';

        const prompt = `You are a yeast expert. A homebrewer is making a mead with a starting gravity of ${og}. Their ${yeastType} yeast packet has a production date of ${yeastDate}. Today's date is ${new Date().toISOString().split('T')[0]}. Based on this, tell them if a yeast starter is necessary. If it is, provide a simple, step-by-step guide for making an appropriate starter for a 5-liter batch. Format the response in Markdown.`;

        try {
            const adviceMarkdown = await performApiCall(prompt);
            adviceOutput.innerHTML = marked.parse(adviceMarkdown);
        } catch (error) {
            console.error("Error getting yeast advice:", error);
            adviceOutput.innerHTML = `<p class="text-center text-red-500">Could not get yeast advice: ${error.message}</p>`;
        }
    }

    // --- Water Chemistry Functions ---
    const waterData = {
        spa: { ca: 5, mg: 2, na: 3, so4: 4, cl: 5, hco3: 17 },
        chaudfontaine: { ca: 65, mg: 18, na: 44, so4: 40, cl: 35, hco3: 305 },
        valvert: { ca: 68, mg: 2, na: 2, so4: 18, cl: 4, hco3: 204 },
        bru: { ca: 23.3, mg: 22.2, na: 8, so4: 5, cl: 4, hco3: 209 },
        villers: { ca: 106.1, mg: 11.1, na: 8, so4: 48.8, cl: 19.9, hco3: 340.4 }
    };

    function handleWaterSourceChange() {
        const isManual = waterSourceSelect.value === 'manual';
        manualWaterProfileDiv.classList.toggle('hidden', !isManual);
        fetchWaterProfileBtn.textContent = isManual ? 'Apply Manual Profile' : 'Fetch Profile';
    }

    function fetchWaterProfile() {
        const source = waterSourceSelect.value;
        if (source === 'manual') {
            currentWaterProfile = {
                ca: parseFloat(document.getElementById('manual_ca').value) || 0,
                mg: parseFloat(document.getElementById('manual_mg').value) || 0,
                na: parseFloat(document.getElementById('manual_na').value) || 0,
                so4: parseFloat(document.getElementById('manual_so4').value) || 0,
                cl: parseFloat(document.getElementById('manual_cl').value) || 0,
                hco3: parseFloat(document.getElementById('manual_hco3').value) || 0,
            };
        } else {
            currentWaterProfile = waterData[source];
        }
        
        document.getElementById('val-ca').textContent = currentWaterProfile.ca;
        document.getElementById('val-mg').textContent = currentWaterProfile.mg;
        document.getElementById('val-na').textContent = currentWaterProfile.na;
        document.getElementById('val-so4').textContent = currentWaterProfile.so4;
        document.getElementById('val-cl').textContent = currentWaterProfile.cl;
        document.getElementById('val-hco3').textContent = currentWaterProfile.hco3;
    }

    async function getWaterAdvice() {
        if (!currentWaterProfile) {
            document.getElementById('water-advice-output').innerHTML = `<p class="text-center text-red-500">Please fetch or apply a water profile first.</p>`;
            return;
        }
        
        const adviceOutput = document.getElementById('water-advice-output');
        adviceOutput.innerHTML = '<div class="loader"></div><p class="text-center text-app-secondary/80">Analyzing water profile...</p>';
        
        const targetProfile = document.getElementById('meadTargetProfile').selectedOptions[0].text;
        const batchSize = document.getElementById('batchSize').value;

        const prompt = `You are an expert brew chemist. A user has the following starting water profile in mg/L (ppm): Calcium: ${currentWaterProfile.ca}, Magnesium: ${currentWaterProfile.mg}, Sodium: ${currentWaterProfile.na}, Sulfate: ${currentWaterProfile.so4}, Chloride: ${currentWaterProfile.cl}, Bicarbonate: ${currentWaterProfile.hco3}. 
        
        They want to adjust this water for a ${batchSize}-liter batch of mead with a target character of "${targetProfile}". 
        
        Provide specific, actionable advice. Recommend additions of brewing salts (Gypsum, Calcium Chloride, Epsom Salt) in grams. Explain WHY you are recommending these changes (e.g., "add gypsum to accentuate dryness"). Format the response in simple Markdown.`;

        try {
            const adviceMarkdown = await performApiCall(prompt);
            adviceOutput.innerHTML = marked.parse(adviceMarkdown);
        } catch (error) {
            console.error("Error getting water advice:", error);
            adviceOutput.innerHTML = `<p class="text-center text-red-500">Could not get water advice: ${error.message}</p>`;
        }
    }


    // --- Utility Functions ---
    function parseIngredientsAndCalculateCost(markdown, inventory, batchSize) {
        let totalCost = 0;
        const tableRegex = /\| Ingredient.*?\|\n\|[-|: ]+\|[-|: ]+\|[-|: ]+\|\n([\s\S]*?)\n\n/gm;
        const tableMatch = tableRegex.exec(markdown);

        if (!tableMatch || !tableMatch[1]) {
            console.warn("Could not find or parse ingredients table in the recipe.");
            return 0;
        }

        const rows = tableMatch[1].split('\n').filter(row => row.trim() !== '');

        rows.forEach(row => {
            const columns = row.split('|').map(c => c.trim()).filter(c => c);
            if (columns.length !== 3) return;

            const [name, quantityStr, unit] = columns;
            const quantity = parseFloat(quantityStr);
            if (isNaN(quantity)) return;
            
            // Find best match in inventory (case-insensitive)
            const inventoryItem = inventory.find(item => item.name.toLowerCase() === name.toLowerCase());
            
            if (inventoryItem) {
                let costPerUnit = inventoryItem.price / inventoryItem.qty;
                // Basic unit conversion
                if (inventoryItem.unit === 'kg' && unit.toLowerCase() === 'g') {
                    costPerUnit /= 1000;
                } else if (inventoryItem.unit === 'g' && unit.toLowerCase() === 'kg') {
                    costPerUnit *= 1000;
                } // Can add more conversions here
                
                totalCost += quantity * costPerUnit;
            }
        });

        return totalCost;
    }

    window.printEmptyLog = function() {
        const logHtml = getBrewLogHtml(null, 'empty');
        const printWindow = window.open('', '_blank');
        printWindow.document.write(`<html><head><title>Empty Brew Log</title><style>${document.querySelector('style').innerHTML}</style></head><body><div class="container mx-auto p-4">${logHtml}</div></body></html>`);
        printWindow.document.close();
        printWindow.print();
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
            targetABV: container.querySelector(`#targetABV${suffix}`)?.value || '',
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
        const fermLog = data.fermentationLog || Array(8).fill({});
        return `
            <div class="brew-log-section" data-id="${idSuffix}">
                <h3>Brewmaster's Log</h3>
                <div class="log-grid">
                    <div class="log-item"><label for="recipeName-${idSuffix}">Recipe Name:</label><input type="text" id="recipeName-${idSuffix}" value="${data.recipeName || ''}"></div>
                    <div class="log-item"><label for="brewDate-${idSuffix}">Brew Date:</label><input type="date" id="brewDate-${idSuffix}" value="${data.brewDate || ''}"></div>
                </div>
                <div class="log-grid">
                     <div class="log-item"><label for="targetOG-${idSuffix}">Target OG:</label><input type="text" id="targetOG-${idSuffix}" value="${data.targetOG || ''}"></div>
                     <div class="log-item"><label for="actualOG-${idSuffix}">Actual OG:</label><input type="text" id="actualOG-${idSuffix}" value="${data.actualOG || ''}"></div>
                     <div class="log-item"><label for="targetFG-${idSuffix}">Target FG:</label><input type="text" id="targetFG-${idSuffix}" value="${data.targetFG || ''}"></div>
                    <div class="log-item"><label for="actualFG-${idSuffix}">Actual FG:</label><input type="text" id="actualFG-${idSuffix}" value="${data.actualFG || ''}"></div>
                     <div class="log-item"><label for="targetABV-${idSuffix}">Target ABV:</label><input type="text" id="targetABV-${idSuffix}" value="${data.targetABV || ''}"></div>
                    <div class="log-item"><label for="finalABV-${idSuffix}">Final ABV:</label><input type="text" id="finalABV-${idSuffix}" value="${data.finalABV || ''}"></div>
                </div>
                <div class="log-item">
                    <label>Fermentation Log</label>
                    <table class="fermentation-table" id="fermentationTable-${idSuffix}">
                        <thead><tr><th>Date</th><th>Temp (°C)</th><th>S.G.</th><th>Notes</th></tr></thead>
                        <tbody>${fermLog.map(row => `<tr><td><input type="text" value="${row.date || ''}"></td><td><input type="text" value="${row.temp || ''}"></td><td><input type="text" value="${row.sg || ''}"></td><td><input type="text" value="${row.notes || ''}"></td></tr>`).join('')}</tbody>
                    </table>
                </div>
                <div class="log-item"><label for="agingNotes-${idSuffix}">Aging & Conditioning Notes:</label><textarea id="agingNotes-${idSuffix}" rows="4" placeholder="Secondary additions, clearing, bulk aging time, etc.">${data.agingNotes || ''}</textarea></div>
                <div class="log-item"><label for="bottlingNotes-${idSuffix}">Bottling / Kegging Notes:</label><textarea id="bottlingNotes-${idSuffix}" rows="3" placeholder="Bottling date, final volume, carbonation method, etc.">${data.bottlingNotes || ''}</textarea></div>
                <div class="log-item"><label for="tastingNotes-${idSuffix}">Final Tasting Notes:</label><textarea id="tastingNotes-${idSuffix}" rows="6" placeholder="Aroma, appearance, flavor, mouthfeel, overall impression...">${data.tastingNotes || ''}</textarea></div>
            </div>
        `;
    }
    
    // --- Brew Day Assistant Functions ---
    window.startBrewDay = function(brewId) {
        currentBrewDay = { brewId: brewId, checklist: {} };
        saveUserSettings(); // Save the current brew day
        renderBrewDay(brewId);
        switchView('brewing');
    }

    function renderBrewDay(brewId) {
        const brew = brews.find(b => b.id === brewId);
        if (!brew) {
            brewDayContent.innerHTML = `<p class="text-center text-red-500">Could not find the selected brew. Please start a new one.</p>`;
            return;
        }

        const recipeHtml = marked.parse(brew.recipeMarkdown);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = recipeHtml;

        let checklistHtml = `<h2 class="text-3xl font-header font-bold mb-4 text-center">${brew.recipeName || 'Brew Day'}</h2>`;
        
        // Ingredients Checklist
        const ingredientsHeader = tempDiv.querySelector('h3, h2'); // Find first header
        if (ingredientsHeader && ingredientsHeader.textContent.toLowerCase().includes('ingredients')) {
            checklistHtml += `<h3 class="text-2xl font-header mt-6 mb-3">Ingredients</h3>`;
            const ingredientsTable = ingredientsHeader.nextElementSibling;
            if (ingredientsTable && ingredientsTable.tagName === 'TABLE') {
                const rows = ingredientsTable.querySelectorAll('tbody tr');
                rows.forEach((row, index) => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length === 3) {
                        const text = `${cells[0].textContent.trim()} - ${cells[1].textContent.trim()} ${cells[2].textContent.trim()}`;
                        const id = `ing-${index}`;
                        const isChecked = currentBrewDay.checklist[id] ? 'checked' : '';
                        checklistHtml += `<div class="flex items-center my-2"><input type="checkbox" id="${id}" data-task="${id}" ${isChecked} onchange="window.updateChecklist(this)"><label for="${id}" class="ml-3">${text}</label></div>`;
                    }
                });
            }
        }

        // Instructions Checklist
        const instructionsHeader = Array.from(tempDiv.querySelectorAll('h3, h2')).find(h => h.textContent.toLowerCase().includes('instructions'));
        if (instructionsHeader) {
            checklistHtml += `<h3 class="text-2xl font-header mt-6 mb-3">Instructions</h3>`;
            const instructionsList = instructionsHeader.nextElementSibling;
            if (instructionsList && (instructionsList.tagName === 'OL' || instructionsList.tagName === 'UL')) {
                const items = instructionsList.querySelectorAll('li');
                items.forEach((item, index) => {
                    const text = item.innerHTML;
                    const id = `inst-${index}`;
                    const isChecked = currentBrewDay.checklist[id] ? 'checked' : '';
                    checklistHtml += `<div class="flex items-start my-2"><input type="checkbox" id="${id}" data-task="${id}" class="mt-1" ${isChecked} onchange="window.updateChecklist(this)"><label for="${id}" class="ml-3">${text}</label></div>`;
                });
            }
        }

        // Quick Log Section
        checklistHtml += `
            <div class="mt-8 pt-6 border-t-2 border-app">
                <h3 class="text-2xl font-header mb-4 text-center">Quick Log</h3>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <input type="number" id="quickLogSG" placeholder="S.G. (e.g., 1.050)" class="p-2 border rounded-md bg-app-tertiary border-app text-app-primary">
                    <input type="number" id="quickLogTemp" placeholder="Temp (°C)" class="p-2 border rounded-md bg-app-tertiary border-app text-app-primary">
                    <input type="text" id="quickLogNotes" placeholder="Quick Note" class="p-2 border rounded-md bg-app-tertiary border-app text-app-primary md:col-span-2">
                </div>
                <button id="saveQuickLogBtn" class="w-full mt-4 bg-blue-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-blue-700 btn">Save Log Entry</button>
                <div id="quickLogMessage" class="text-center h-6 mt-2"></div>
            </div>
        `;

        brewDayContent.innerHTML = checklistHtml;
        document.getElementById('saveQuickLogBtn').onclick = () => saveQuickLog(brewId);
    }

    window.updateChecklist = function(checkbox) {
        const taskId = checkbox.dataset.task;
        currentBrewDay.checklist[taskId] = checkbox.checked;
        saveUserSettings(); // Persist the checklist state
    }

    async function saveQuickLog(brewId) {
        const sg = document.getElementById('quickLogSG').value;
        const temp = document.getElementById('quickLogTemp').value;
        const notes = document.getElementById('quickLogNotes').value;
        const messageDiv = document.getElementById('quickLogMessage');

        if (!sg && !temp && !notes.trim()) {
            messageDiv.textContent = 'Please enter at least one value.';
            messageDiv.style.color = 'var(--danger-color)';
            return;
        }

        const brew = brews.find(b => b.id === brewId);
        if (!brew) return;

        const newLogEntry = {
            date: new Date().toLocaleDateString(),
            sg: sg || '',
            temp: temp || '',
            notes: notes.trim() || ''
        };

        const updatedLog = brew.logData.fermentationLog || [];
        // Add to the first empty row or append
        const firstEmptyIndex = updatedLog.findIndex(e => !e.date && !e.sg && !e.temp && !e.notes);
        if(firstEmptyIndex !== -1) {
            updatedLog[firstEmptyIndex] = newLogEntry;
        } else {
            updatedLog.push(newLogEntry);
        }

        try {
            const appId = 'meandery-aa05e';
            const brewDocRef = doc(db, 'artifacts', appId, 'users', userId, 'brews', brewId);
            await updateDoc(brewDocRef, { 'logData.fermentationLog': updatedLog });
            
            messageDiv.textContent = 'Log entry saved!';
            messageDiv.style.color = 'var(--success-color)';
            document.getElementById('quickLogSG').value = '';
            document.getElementById('quickLogTemp').value = '';
            document.getElementById('quickLogNotes').value = '';

        } catch (error) {
            console.error("Error saving quick log:", error);
            messageDiv.textContent = 'Failed to save.';
            messageDiv.style.color = 'var(--danger-color)';
        } finally {
             setTimeout(() => { messageDiv.textContent = ''; }, 3000);
        }
    }
    
    // --- Analysis Functions ---
    window.generateShoppingList = function(brewId) {
        const brew = brews.find(b => b.id === brewId);
        if (!brew) return;

        const required = parseIngredientsFromMarkdown(brew.recipeMarkdown);
        const shoppingList = [];

        required.forEach(req => {
            const invItem = inventory.find(inv => inv.name.toLowerCase() === req.name.toLowerCase());
            const needed = req.quantity;

            if (!invItem || invItem.qty < needed) {
                const toBuy = invItem ? needed - invItem.qty : needed;
                shoppingList.push({ name: req.name, quantity: toBuy, unit: req.unit });
            }
        });
        
        let html = `<h4 class="text-xl font-header mb-2">${brew.recipeName} - Shopping List</h4>`;
        if (shoppingList.length > 0) {
            html += `<ul class="list-disc pl-5">`;
            shoppingList.forEach(item => {
                html += `<li>${item.name}: ${item.quantity.toFixed(2)} ${item.unit}</li>`;
            });
            html += `</ul>`;
        } else {
            html += `<p style="color: var(--success-color)">You have all the ingredients you need!</p>`;
        }

        document.getElementById('shopping-list-content').innerHTML = html;
        switchView('planning');
    }

    function parseIngredientsFromMarkdown(markdown) {
        const ingredients = [];
        const tableRegex = /\| Ingredient.*?\|\n\|[-|: ]+\|[-|: ]+\|[-|: ]+\|\n([\s\S]*?)\n\n/gm;
        const tableMatch = tableRegex.exec(markdown);

        if (!tableMatch || !tableMatch[1]) return ingredients;

        const rows = tableMatch[1].split('\n').filter(row => row.trim() !== '');
        rows.forEach(row => {
            const columns = row.split('|').map(c => c.trim()).filter(c => c);
            if (columns.length === 3) {
                ingredients.push({
                    name: columns[0],
                    quantity: parseFloat(columns[1]),
                    unit: columns[2]
                });
            }
        });
        return ingredients;
    }

    function updateCostAnalysis() {
        const currency = userSettings.currencySymbol || '€';
        const totalSpend = inventory.reduce((acc, item) => acc + (item.price || 0), 0);
        const avgCost = brews.length > 0 ? brews.reduce((acc, brew) => acc + (brew.totalCost || 0), 0) / brews.length : 0;

        document.getElementById('total-spend').textContent = `${currency}${totalSpend.toFixed(2)}`;
        document.getElementById('avg-cost').textContent = `${currency}${avgCost.toFixed(2)}`;

        const spendByCategory = inventory.reduce((acc, item) => {
            acc[item.category] = (acc[item.category] || 0) + (item.price || 0);
            return acc;
        }, {});

        const ctx = document.getElementById('cost-chart').getContext('2d');
        const chartData = {
            labels: Object.keys(spendByCategory),
            datasets: [{
                label: 'Spend by Category',
                data: Object.values(spendByCategory),
                backgroundColor: [
                    '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#C9CBCF', '#7BC225'
                ],
            }]
        };

        if (costChart) {
            costChart.destroy();
        }
        costChart = new Chart(ctx, {
            type: 'doughnut',
            data: chartData,
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            color: getComputedStyle(document.documentElement).getPropertyValue('--text-primary')
                        }
                    }
                }
            }
        });
    }

    function calculateOverhead() {
        const electricityCost = parseFloat(document.getElementById('electricityCost').value) || 0;
        const waterCost = parseFloat(document.getElementById('waterCost').value) || 0;
        const sanitizerCost = parseFloat(document.getElementById('sanitizerCost').value) || 0;
        const resultDiv = document.getElementById('overheadResult');
        const currency = userSettings.currencySymbol || '€';

        // Simple assumptions for calculation
        const hoursBrewing = 4; // Assume 4 hours of active work
        const kwhPerHour = 1.5; // Assume 1.5 kWh per hour for heating/pumps
        const waterUsedM3 = 0.025; // Assume 25 liters (0.025 m³) of water used for a small batch

        const totalElectricity = electricityCost * kwhPerHour * hoursBrewing;
        const totalWater = waterCost * waterUsedM3;
        const totalOverhead = totalElectricity + totalWater + sanitizerCost;

        resultDiv.textContent = `Est. Overhead: ${currency}${totalOverhead.toFixed(2)}`;
    }

    // --- Troubleshooter Functions ---
    async function getTroubleshootingAdvice() {
        const description = document.getElementById('troubleshoot-description').value;
        const outputDiv = document.getElementById('troubleshoot-output');

        if (!description.trim()) {
            outputDiv.innerHTML = `<p class="text-red-500">Please describe your problem first.</p>`;
            return;
        }

        outputDiv.innerHTML = '<div class="loader"></div>';
        
        const prompt = `You are an expert mead maker and troubleshooter. A user is having a problem with their mead. Their description of the problem is: "${description}". Provide a step-by-step guide to help them diagnose the issue. Ask clarifying questions they should answer for themselves, suggest potential causes, and offer clear, actionable solutions. Format the response in Markdown.`;

        try {
            const adviceMarkdown = await performApiCall(prompt);
            outputDiv.innerHTML = marked.parse(adviceMarkdown);
        } catch (error) {
            console.error("Error getting troubleshooting advice:", error);
            outputDiv.innerHTML = `<p class="text-center text-red-500">Could not get advice: ${error.message}</p>`;
        }
    }

    // --- Start the App ---
    initApp();

})(); // End of IIFE
