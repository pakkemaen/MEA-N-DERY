import { db, storage } from './firebase-init.js';
import { state, tempState } from './state.js';
import { showToast, performApiCall } from './utils.js';
import { parseIngredientsFromMarkdown } from './brewing.js'; 
import { doc, getDoc, setDoc, updateDoc, collection, addDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref, uploadString, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// --- LABEL GENERATOR ENGINE V2.1 (Full Suite) ---
// 1. CONFIGURATIE (Built-in + User)
const builtInLabelFormats = {
    'avery_l7165': { name: 'Avery L7165 (99.1x67.7mm)', width: 99.1, height: 67.7, cols: 2, rows: 4, marginTop: 13, marginLeft: 4.6, gapX: 2.5, gapY: 0 },
    'herma_4453': { name: 'Herma 4453 (105x148mm)', width: 105, height: 148, cols: 2, rows: 2, marginTop: 0, marginLeft: 0, gapX: 0, gapY: 0 },
    'avery_l7163': { name: 'Avery L7163 (99.1x38.1mm)', width: 99.1, height: 38.1, cols: 2, rows: 7, marginTop: 15, marginLeft: 4.6, gapX: 2.5, gapY: 0 }
};
let userLabelFormats = {}; // Wordt gevuld vanuit Firestore

// 2. INITIALISATIE
// --- NIEUWE FUNCTIE: VUL DE FONT DROPDOWNS (ALLEEN SETTINGS) ---
function populateLabelFontsDropdowns() {
    // 1. Definieer de IDs van de 4 dropdowns
    const ids = ['tuneTitleFont', 'tuneStyleFont', 'tuneSpecsFont', 'tuneDescFont'];
    
    // 2. Haal de eigen fonts op (of lege lijst als nog niet geladen)
    const userFonts = (typeof labelAssets !== 'undefined' && labelAssets.fonts) ? labelAssets.fonts : [];

    ids.forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        
        const currentVal = select.value; // Onthoud keuze
        select.innerHTML = ''; // Maak leeg
        
        // Check of er fonts zijn
        if (userFonts.length === 0) {
            const opt = document.createElement('option');
            opt.text = "-- No Fonts in Settings --";
            select.appendChild(opt);
            return;
        }

        // Voeg alleen de fonts uit Settings toe
        userFonts.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.name;
            opt.textContent = f.name;
            opt.style.fontFamily = f.name; // Preview in de lijst
            select.appendChild(opt);
        });
        
        // Herstel de gekozen waarde (als die nog in de lijst staat)
        // Anders pakken we automatisch de eerste uit de lijst
        if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
            select.value = currentVal;
        } else if (select.options.length > 0) {
            select.selectedIndex = 0;
        }
    });
}

// VUL DE ART STYLE DROPDOWN IN LABEL FORGE ---
function populateLabelStylesDropdown() {
    const select = document.getElementById('labelArtStyle');
    if (!select) return;

    // Bewaar huidige keuze
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Use Default Style --</option>';

    // Haal stijlen op uit het geheugen (geladen in loadLabelAssets)
    const styles = (typeof labelAssets !== 'undefined' && labelAssets.styles) ? labelAssets.styles : [];

    styles.forEach(style => {
        const opt = document.createElement('option');
        // We slaan de prompt tekst op in de value, zodat we die direct kunnen gebruiken
        opt.value = style.prompt; 
        opt.textContent = style.name;
        select.appendChild(opt);
    });

    // Herstel keuze indien mogelijk
    if (currentVal) select.value = currentVal;
}

// --- LABEL EDITOR INITIALISATIE (COMPLETE VERSIE) ---
export function initLabelForge() {
    // 1. Vul de dropdowns (Fonts, Papier, Styles)
    populateLabelFontsDropdowns();
    populateLabelPaperDropdown();
    populateLabelStylesDropdown();
    populateLabelRecipeDropdown();
    loadUserLabelFormats(); 

    // 2. Definieer alle inputs die een live re-render moeten triggeren
    const allInputs = [
        'labelTitle', 'labelSubtitle', 'labelAbv', 'labelFg', 'labelVol', 
        'labelDate', 'labelDescription', 'labelDetails', 'labelAllergens',
        'labelShowDetails', 'labelShowYeast', 'labelShowHoney', 'label-persona-select',
        'tuneTitleFont', 'tuneTitleColor', 'tuneTitleSize', 'tuneTitleSize2', 
        'tuneTitleX', 'tuneTitleY', 'tuneTitleRotate', 'tuneTitleBreak',
        'tuneTitleOffset', 'tuneTitleOffsetY', 'tuneStyleFont', 'tuneStyleColor', 
        'tuneStyleSize', 'tuneStyleSize2', 'tuneStyleGap', 'tuneStyleY', 
        'tuneStyleRotate', 'tuneStyleBreak', 'tuneStyleOffset', 'tuneStyleOffsetY',
        'tuneSpecsFont', 'tuneSpecsColor', 'tuneAllergenColor', 'tuneSpecsAlign',
        'tuneSpecsSize', 'tuneSpecsX', 'tuneSpecsY', 'tuneSpecsRotate',
        'tuneSpecsShadow', 'tuneDescFont', 'tuneDescColor', 'tuneDescAlign',
        'tuneDescX', 'tuneDescY', 'tuneDescWidth', 'tuneDescRotate', 'tuneDescSize',
        'tuneArtZoom', 'tuneArtX', 'tuneArtY', 'tuneArtOpacity', 'tuneArtRotate', 
        'tuneArtOverlay', 'tuneLogoColor', 'tuneLogoSize', 'tuneLogoX', 
        'tuneLogoY', 'tuneLogoRotate', 'tuneLogoOpacity', 'logoColorMode',
        'tuneBorderWidth', 'tuneBackgroundColor', 'labelShowGuides', 'labelShowBorder'
    ];

    // 3. Koppel de listeners: Typen of schuiven = direct het resultaat zien
    allInputs.forEach(id => {
        const el = document.getElementById(id);
        if(el) {
            el.addEventListener('input', () => {
                const activeTheme = document.querySelector('.label-theme-btn.active')?.dataset.theme || 'standard';
                setLabelTheme(activeTheme);
                // Update het getalletje naast de slider
                if (el.type === 'range') updateSliderDisplay(id, el.value);
            });
        }
    });

    // Papier & Recept triggers
    document.getElementById('labelPaper')?.addEventListener('change', () => {
        updateLabelPreviewDimensions();
        const activeTheme = document.querySelector('.label-theme-btn.active')?.dataset.theme || 'standard';
        setLabelTheme(activeTheme);
    });

    document.getElementById('labelRecipeSelect')?.addEventListener('change', loadLabelFromBrew);
    
    // Thema knoppen
    document.querySelectorAll('.label-theme-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.label-theme-btn').forEach(b => b.classList.remove('active', 'bg-secondary-container'));
            e.target.classList.add('active', 'bg-secondary-container');
            const brewId = document.getElementById('labelRecipeSelect').value;
            if (brewId) loadLabelFromBrew(brewId, e.target.dataset.theme);
            else setLabelTheme(e.target.dataset.theme);
        });
    });

    document.getElementById('ai-label-art-btn')?.addEventListener('click', generateLabelArt);
    document.getElementById('ai-label-desc-btn')?.addEventListener('click', generateLabelDescription);
    document.getElementById('printLabelsBtn')?.addEventListener('click', printLabelsSheet); 
    document.getElementById('logoUpload')?.addEventListener('change', handleLogoUpload);
}

// Helper om de % en px getallen bij de sliders te updaten
function updateSliderDisplay(id, val) {
    let dispId = id.replace('tune', 'disp')
                   .replace(/([A-Z])/g, '-$1')
                   .toLowerCase();
    
    if (id.endsWith('Size2')) dispId = dispId.replace('size2', 'size-2');

    const disp = document.getElementById(dispId);
    if(disp) {
        // Voorkom 'px' achter kleurencodes (hex start met #)
        if (typeof val === 'string' && val.startsWith('#')) {
            disp.textContent = val.toUpperCase();
            return;
        }

        if(id.includes('Rotate')) disp.textContent = val + '°';
        else if(id.includes('Break')) disp.textContent = (val >= 8) ? "All" : "Word " + val;
        else if(id.includes('Width') && id.includes('Border')) disp.textContent = val + 'mm';
        else if(id.includes('Opacity') || id.includes('Overlay')) disp.textContent = Math.round(val * 100) + '%';
        else if(id.includes('Zoom')) disp.textContent = parseFloat(val).toFixed(2) + 'x';
        else if(id.includes('X') || id.includes('Y') || id.includes('Gap') || id.includes('Offset') || (id.includes('Width') && !id.includes('Border'))) disp.textContent = val + '%';
        else disp.textContent = val + 'px';
    }
}

// 3. DATAMANAGEMENT (Laden & Dropdowns)

// A. Receptenlijst vullen
function populateLabelRecipeDropdown() {
    const select = document.getElementById('labelRecipeSelect');
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="">-- Load from History --</option>';
    
    const sortedBrews = [...state.brews].sort((a, b) => {
    const dateA = a.createdAt ? a.createdAt.toDate() : new Date(0);
    const dateB = b.createdAt ? b.createdAt.toDate() : new Date(0);
    return dateB - dateA;
});

    sortedBrews.forEach(brew => {
        const option = document.createElement('option');
        option.value = brew.id;
        let displayName = brew.recipeName || 'Untitled Brew';
        if (displayName.includes(':')) displayName = displayName.split(':')[0].trim();
        option.textContent = displayName;
        select.appendChild(option);
    });
    select.value = currentValue;
}

// B. Label Formaten Laden (Firestore)
async function loadUserLabelFormats() {
    if (!state.userId) return;
    try {
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'labelFormats');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            userLabelFormats = docSnap.data();
        }
        populateLabelPaperDropdown(); // Refresh de lijst na laden
    } catch (e) {
        console.error("Error loading label formats:", e);
    }
}

// C. Papier Dropdown Vullen (Built-in + Custom)
function populateLabelPaperDropdown() {
    const select = document.getElementById('labelPaper');
    if (!select) return;
    
    // Bewaar huidige keuze indien mogelijk
    const currentVal = select.value;
    select.innerHTML = '';
    
    // 1. HARDE DATA (Fallback) - Dit garandeert dat de lijst nooit leeg is
    const standardFormats = {
        'avery_l7165': { name: 'Avery L7165 (99.1x67.7mm)' },
        'herma_4453': { name: 'Herma 4453 (105x148mm)' },
        'avery_l7163': { name: 'Avery L7163 (99.1x38.1mm)' }
    };

    // Voeg Standaard Groep toe
    const groupBuiltIn = document.createElement('optgroup');
    groupBuiltIn.label = "Standard Formats";
    
    Object.keys(standardFormats).forEach(key => {
        const opt = document.createElement('option');
        opt.value = key; 
        opt.text = standardFormats[key].name;
        groupBuiltIn.appendChild(opt);
    });
    select.appendChild(groupBuiltIn);

    // 2. Custom Formaten (uit variabele of database)
    if (typeof userLabelFormats !== 'undefined' && Object.keys(userLabelFormats).length > 0) {
        const groupUser = document.createElement('optgroup');
        groupUser.label = "My Custom Formats";
        Object.keys(userLabelFormats).forEach(key => {
            const opt = document.createElement('option');
            opt.value = key; 
            opt.text = userLabelFormats[key].name;
            groupUser.appendChild(opt);
        });
        select.appendChild(groupUser);
    }

    // Toggle delete knop functionaliteit
    select.onchange = () => {
        const isCustom = typeof userLabelFormats !== 'undefined' && userLabelFormats.hasOwnProperty(select.value);
        const delBtn = document.getElementById('deleteLabelFormatBtn');
        if(delBtn) delBtn.classList.toggle('hidden', !isCustom);
        if(typeof updateLabelPreviewDimensions === 'function') updateLabelPreviewDimensions();
    };

    // Zet de waarde terug (of default)
    if (currentVal && (standardFormats[currentVal] || (typeof userLabelFormats !== 'undefined' && userLabelFormats[currentVal]))) {
        select.value = currentVal;
    } else {
        select.value = 'avery_l7165';
    }
    
    // Trigger de dimensie update direct
    if(typeof updateLabelPreviewDimensions === 'function') updateLabelPreviewDimensions();
}

// --- DEZE FUNCTIE PAST DE GROOTTE VAN DE PREVIEW AAN ---
function updateLabelPreviewDimensions() {
    const select = document.getElementById('labelPaper');
    if (!select) return;
    
    const key = select.value;
    // Zoek het formaat in de standaard lijst OF de eigen lijst
    const fmt = builtInLabelFormats[key] || userLabelFormats[key];
    
    if (fmt) {
        const container = document.getElementById('label-preview-container');
        if (container) {
            // Pas de breedte en hoogte aan (in millimeters)
            container.style.width = fmt.width + 'mm';
            container.style.height = fmt.height + 'mm';
        }
    }
}

// --- AUTO-SCALE PREVIEW ---
window.autoScaleLabelPreview = function() {
    const mainContainer = document.querySelector('#labels-view main'); // De grijze bak
    const labelContainer = document.getElementById('label-preview-container'); // Het witte label

    if (!mainContainer || !labelContainer) return;

    // 1. Reset eerst de transform om de ware grootte te meten
    labelContainer.style.transform = 'scale(1)';

    // 2. Haal afmetingen op
    const availableWidth = mainContainer.clientWidth - 60; // 60px padding marge
    const availableHeight = mainContainer.clientHeight - 60;
    
    const labelWidth = labelContainer.offsetWidth;
    const labelHeight = labelContainer.offsetHeight;

    if (labelWidth === 0 || labelHeight === 0) return;

    // 3. Bereken de schaal (neem de kleinste ratio zodat hij altijd past)
    const scaleX = availableWidth / labelWidth;
    const scaleY = availableHeight / labelHeight;
    const scale = Math.min(scaleX, scaleY);

    // 4. Pas toe (met een maximum van 3x om pixels te voorkomen bij kleine labels)
    // We gebruiken transform, zodat de fysieke mm afmetingen voor print intact blijven
    const finalScale = Math.min(scale, 3.5); 
    
    labelContainer.style.transform = `scale(${finalScale})`;
    
    // Update de tekst linksboven zodat de gebruiker het weet
    const infoText = mainContainer.querySelector('p.absolute');
    if(infoText) infoText.textContent = `Live Preview (Zoom: ${finalScale.toFixed(2)}x)`;
}

// 4. PREVIEW & UI LOGICA

export function updateLabelPreviewText() {
    const activeThemeBtn = document.querySelector('.label-theme-btn.active');
    const theme = activeThemeBtn ? activeThemeBtn.dataset.theme : 'standard';
    setLabelTheme(theme);
}

// --- DATA LADEN (V3.1 - STRICT SEPARATION & FEEDBACK) ---
function loadLabelFromBrew(eOrId, forceTheme = null) {
    // Flexibele input: kan een event zijn (dropdown change) of een string (ID)
    const brewId = (typeof eOrId === 'object' && eOrId.target) ? eOrId.target.value : eOrId;
    
    if (!brewId) return;
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) return;

    // 1. BEPAAL THEMA
    let theme = forceTheme;
    if (!theme) {
        const activeBtn = document.querySelector('.label-theme-btn.active');
        theme = activeBtn ? activeBtn.dataset.theme : 'standard';
    }

    // Helpers
    const setVal = (id, val) => { const el = document.getElementById(id); if(el) el.value = val; };
    const setText = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
    const setCheck = (id, val) => { const el = document.getElementById(id); if(el) el.checked = val; };
    const restoreSlider = (id, val, fallback) => {
        const el = document.getElementById(id);
        if(el) {
            // Als de opgeslagen waarde undefined is, gebruik de fallback (reset)
            el.value = (val !== undefined && val !== null) ? val : fallback;
            el.dispatchEvent(new Event('input')); 
        }
    };

    // Basis data genereren
    const ings = parseIngredientsFromMarkdown(brew.recipeMarkdown);
    
    // FILTER HONING, GIST ÉN ALLERGENEN/ADDITIEVEN
    const filteredIngs = ings.filter(i => {
        const n = i.name.toLowerCase();
        
        // 1. Basis ingrediënten die al een eigen kopje hebben
        const isBase = n.includes('honey') || n.includes('honing') || 
                       n.includes('yeast') || n.includes('gist') || 
                       n.includes('safale') || n.includes('lalvin') || n.includes('mangrove');

        // 2. Allergenen & Stabilisatoren (staan vaak al bij 'Allergens' of 'Contains')
        const isAllergen = n.includes('sulfite') || n.includes('sulphite') ||  // Sulfieten
                           n.includes('campden') || n.includes('metabi') ||    // Campden / Metabisulfiet
                           n.includes('sorbate') ||                            // Sorbaat
                           n.includes('lactose');                              // Lactose

        // We behouden het item ALLEEN als het GEEN basis is én GEEN allergeen
        return !isBase && !isAllergen;
    });

    const generatedDetails = filteredIngs.map(i => i.name).join(' • ');

    let yeastItem = ings.find(i => i.name.toLowerCase().includes('yeast') || i.name.toLowerCase().includes('gist'));
    let generatedYeast = yeastItem ? yeastItem.name.replace(/yeast|gist/gi, '').trim() : 'Unknown';
    let honeyItem = ings.find(i => i.name.toLowerCase().includes('honey') || i.name.toLowerCase().includes('honing'));
    let generatedHoney = honeyItem ? honeyItem.name.replace(/honey/gi, '').trim() : 'Wildflower';

    // 2. DATA ZOEKEN (STRICT)
    let s = null;
    let isSavedData = false;
    
    // Check: Bestaat er een specifieke save voor DIT thema?
    if (brew.labelSettings && brew.labelSettings[theme]) {
        s = brew.labelSettings[theme];
        isSavedData = true;
    } 
    
    // 3. TOEPASSEN
    if (isSavedData && s) {
        // --- SCENARIO A: ER IS EEN SAVE (HERSTEL ALLES) ---
        
        // Teksten
        setVal('labelTitle', s.title);
        setVal('labelSubtitle', s.subtitle);
        setVal('labelAbv', s.abv);
        setVal('labelFg', s.fg);
        setVal('labelVol', s.vol);
        setVal('labelDate', s.date);
        setVal('labelDescription', s.desc);
        setVal('labelDetails', s.details || generatedDetails); 
        setVal('labelAllergens', s.allergens || ''); 
        
        if (s.persona) setVal('label-persona-select', s.persona);

        setCheck('labelShowYeast', s.showYeast);
        setCheck('labelShowHoney', s.showHoney);
        setCheck('labelShowDetails', s.showDetails);

        setText('displayLabelYeast', s.yeastName || generatedYeast);
        setText('displayLabelHoney', s.honeyName || generatedHoney);

        // Styling & Sliders
        setVal('tuneTitleColor', s.tuneTitleColor);
        setVal('tuneStyleColor', s.tuneStyleColor);
        
        restoreSlider('tuneTitleSize', s.tuneTitleSize, 100);
        restoreSlider('tuneTitleSize2', s.tuneTitleSize2, 60);
        restoreSlider('tuneTitleX', s.tuneTitleX, 10);
        restoreSlider('tuneTitleY', s.tuneTitleY, 10);
        restoreSlider('tuneTitleRotate', s.tuneTitleRotate, 0);
        restoreSlider('tuneTitleOffset', s.tuneTitleOffset, 0);
        restoreSlider('tuneTitleOffsetY', s.tuneTitleOffsetY, 0);
        restoreSlider('tuneTitleBreak', s.tuneTitleBreak, 8);
        
        restoreSlider('tuneStyleY', s.tuneStyleY, 0);
        restoreSlider('tuneStyleSize', s.tuneStyleSize, 14);
        restoreSlider('tuneStyleSize2', s.tuneStyleSize2, 10);
        restoreSlider('tuneStyleGap', s.tuneStyleGap, 5);
        restoreSlider('tuneStyleRotate', s.tuneStyleRotate, 0);
        restoreSlider('tuneStyleOffset', s.tuneStyleOffset, 0);
        restoreSlider('tuneStyleOffsetY', s.tuneStyleOffsetY, 0)
        restoreSlider('tuneStyleBreak', s.tuneStyleBreak, 8);

        restoreSlider('tuneSpecsSize', s.tuneSpecsSize, 4);
        restoreSlider('tuneSpecsX', s.tuneSpecsX, 50);
        restoreSlider('tuneSpecsY', s.tuneSpecsY, 80);
        setVal('tuneSpecsColor', s.tuneSpecsColor || '#ffffff');
        restoreSlider('tuneSpecsRotate', s.tuneSpecsRotate, 0);

        setCheck('tuneSpecsShadow', (s.tuneSpecsShadow !== undefined) ? s.tuneSpecsShadow : true);

        restoreSlider('tuneDescX', s.tuneDescX, 50);
        restoreSlider('tuneDescY', s.tuneDescY, 70);
        restoreSlider('tuneDescWidth', s.tuneDescWidth, 60);
        restoreSlider('tuneDescRotate', s.tuneDescRotate, 0);
        restoreSlider('tuneDescSize', s.tuneDescSize, 6);
        setVal('tuneDescColor', s.tuneDescColor || '#ffffff');

        restoreSlider('tuneArtZoom', s.tuneArtZoom, 1.0);
        restoreSlider('tuneArtX', s.tuneArtX, 50);
        restoreSlider('tuneArtY', s.tuneArtY, 50);
        restoreSlider('tuneArtRotate', s.tuneArtRotate, 0);
        restoreSlider('tuneArtOpacity', s.tuneArtOpacity, 1.0);
        restoreSlider('tuneArtOverlay', s.tuneArtOverlay, 0.0);
        
        restoreSlider('tuneLogoSize', s.tuneLogoSize, 100);
        restoreSlider('tuneLogoX', s.tuneLogoX, 50);
        restoreSlider('tuneLogoY', s.tuneLogoY, 10);
        restoreSlider('tuneLogoRotate', s.tuneLogoRotate, 0);
        restoreSlider('tuneLogoOpacity', s.tuneLogoOpacity, 1.0);
        setCheck('logoColorMode', s.logoColorMode);
        setVal('tuneLogoColor', s.tuneLogoColor || '#ffffff');

        restoreSlider('tuneBorderWidth', s.tuneBorderWidth, (theme === 'standard' ? 3 : 0));
        setVal('tuneAllergenColor', s.tuneAllergenColor || '#ffffff');
        setVal('tuneBackgroundColor', s.tuneBackgroundColor || '#ffffff');
        
        // Update het tekstlabeltje naast de color picker (optioneel, voor netheid)
        const bgDisp = document.getElementById('disp-background-color');
        if(bgDisp) bgDisp.textContent = s.tuneBackgroundColor || '#ffffff';

        if (s.imageSrc) {
            tempState.currentLabelImageSrc = s.imageSrc;
            const imgDisplay = document.getElementById('label-img-display');
            if(imgDisplay) {
                imgDisplay.src = s.imageSrc;
                imgDisplay.classList.remove('hidden');
            }
        }

        // FEEDBACK: LATEN ZIEN DAT WE GELADEN HEBBEN
        showToast(`📂 ${theme.charAt(0).toUpperCase() + theme.slice(1)} Label Loaded!`, "success");

    } else {
        // --- SCENARIO B: GEEN SAVE (RESET NAAR HARDE DEFAULTS) ---
        // Dit is cruciaal: als we switchen naar een thema dat nog niet is opgeslagen,
        // moeten we de sliders resetten naar de standaardwaarden van DAT thema.
        
        // 1. Reset Basis Teksten (uit Recept)
        setVal('labelTitle', brew.recipeName);
        let style = "Traditional Mead";
        if (brew.recipeMarkdown.toLowerCase().includes('melomel')) style = "Melomel";
        setVal('labelSubtitle', style);
        setVal('labelAbv', brew.logData?.finalABV?.replace('%','') || brew.logData?.targetABV?.replace('%','') || '');
        setVal('labelFg', brew.logData?.actualFG || brew.logData?.targetFG || '');
        setVal('labelVol', '330');
        setVal('labelDate', brew.logData?.brewDate || new Date().toLocaleDateString('nl-NL'));
        
        // 2. Reset Sliders per Thema
        if (theme === 'standard') {
            setVal('tuneTitleColor', '#8F8C79');
            setVal('tuneStyleColor', '#9ca3af');
            setVal('tuneBackgroundColor', '#ffffff');
            
            restoreSlider('tuneLogoSize', 100); restoreSlider('tuneLogoX', 0); restoreSlider('tuneLogoY', 0);
            restoreSlider('tuneTitleSize', 100); restoreSlider('tuneTitleSize2', 60);
            restoreSlider('tuneTitleX', 10); restoreSlider('tuneTitleY', 10);
            restoreSlider('tuneTitleRot', 0); restoreSlider('tuneTitleOffset', 0);
            
            restoreSlider('tuneStyleSize', 14); restoreSlider('tuneStyleSize2', 10);
            restoreSlider('tuneStyleGap', 5); restoreSlider('tuneStyleY', 0);
            restoreSlider('tuneStyleRotate', 0);
            
            restoreSlider('tuneBorderWidth', 3); // Standard heeft border
        } else {
            // Special
            setVal('tuneTitleColor', '#ffffff');
            setVal('tuneStyleColor', '#cccccc');
            setVal('tuneBackgroundColor', '#000000');
            
            restoreSlider('tuneLogoSize', 100); restoreSlider('tuneLogoX', 50); restoreSlider('tuneLogoY', 15);
            restoreSlider('tuneTitleX', 50); restoreSlider('tuneTitleY', 40);
            restoreSlider('tuneStyleGap', 50); restoreSlider('tuneStyleY', 55);
            restoreSlider('tuneBorderWidth', 0);
            
            setCheck('tuneSpecsShadow', true);
        }

        // FEEDBACK: LATEN ZIEN DAT HET DEFAULTS ZIJN
        showToast(`ℹ️ ${theme.charAt(0).toUpperCase() + theme.slice(1)} (Defaults) Loaded`, "info");
    }

    // Forceer render
    if(typeof setLabelTheme === 'function') setLabelTheme(theme);
}

// --- THEMA-ENGINE (V4.2, De Single Source of Truth voor de Live Preview) ---
export function setLabelTheme(theme) {
    const container = document.getElementById('label-content');
    if (!container) return; 

    // --- 1. DATA COLLECTIE ---
    const getVal = (id) => document.getElementById(id)?.value || '';
    const getCheck = (id) => document.getElementById(id)?.checked || false;
    const getText = (id) => document.getElementById(id)?.textContent || '';

    const title = getVal('labelTitle') || 'MEAD NAME';
    const sub = getVal('labelSubtitle') || 'Style Description';
    const abv = getVal('labelAbv'), fg = getVal('labelFg'), vol = getVal('labelVol');
    const desc = getVal('labelDescription'), details = getVal('labelDetails');
    const allergenText = getVal('labelAllergens');
    const bgColor = getVal('tuneBackgroundColor') || '#ffffff';
    const borderWidth = getVal('tuneBorderWidth') || 0;

    // Fix voor kleuren: donkergrijs op wit (Standard) of wit op donker (Special)
    const specsColor = getVal('tuneSpecsColor') || (theme === 'standard' ? '#333333' : '#ffffff');
    const descColor = getVal('tuneDescColor') || (theme === 'standard' ? '#333333' : '#ffffff');

    // Dynamische Data (Honing & Gist)
    const hVal = getText('displayLabelHoney'), yVal = getText('displayLabelYeast');
    const honeyText = (getCheck('labelShowHoney') && hVal && hVal !== '--') ? hVal : '';
    const yeastText = (getCheck('labelShowYeast') && yVal && yVal !== '--') ? yVal : '';

    const rawDate = getVal('labelDate');
    let dateVal = rawDate;
    if (rawDate && !isNaN(new Date(rawDate).getTime())) dateVal = new Date(rawDate).toLocaleDateString('nl-NL');

    let imgSrc = tempState.currentLabelImageSrc || '';
    const hasImage = imgSrc && imgSrc.length > 10;

    const splitBySlider = (text, breakVal) => {
       if (!text) return { l1: "", l2: "", isSplit: false };
       const words = text.split(' ').filter(w => w.trim() !== '');
       if (breakVal >= 8 || breakVal >= words.length) return { l1: text, l2: "", isSplit: false };
       return { l1: words.slice(0, breakVal).join(' '), l2: words.slice(breakVal).join(' '), isSplit: true };
    };

    // --- 2. RENDERING ---
    if (theme === 'standard') {
        const tData = splitBySlider(title, parseInt(getVal('tuneTitleBreak')) || 8);
        const specsAlign = getVal('tuneSpecsAlign') || 'center';

        container.innerHTML = `
            <div class="absolute inset-0 pointer-events-none z-50" style="box-shadow: inset 0 0 0 ${borderWidth}mm white;"></div>
            <div class="relative h-full w-[30%] bg-gray-50/90 z-20 border-r border-gray-200" style="font-family: '${getVal('tuneSpecsFont')}', sans-serif;">
                <div class="absolute" style="top: ${getVal('tuneDescY')}%; left: ${getVal('tuneDescX')}%; width: ${getVal('tuneDescWidth')}%; transform: translate(-50%, 0) rotate(${getVal('tuneDescRotate')}deg); font-size: ${getVal('tuneDescSize')}px; color: ${descColor}; text-align: ${getVal('tuneDescAlign')}; line-height: 1.4;">
                    ${desc}
                </div>
                <div class="absolute flex flex-col items-${specsAlign === 'left' ? 'start' : (specsAlign === 'right' ? 'end' : 'center')}" style="top: ${getVal('tuneSpecsY')}%; left: ${getVal('tuneSpecsX')}%; width: 90%; transform: translate(-50%, -50%) rotate(${getVal('tuneSpecsRotate')}deg); font-size: ${getVal('tuneSpecsSize')}px; color: ${specsColor};">
                    <div class="w-full mb-2 border-b border-gray-300 pb-1 text-${specsAlign}">
                        ${honeyText ? `<div><span class="opacity-50 uppercase text-[0.8em]">Honey:</span> <b>${honeyText}</b></div>` : ''}
                        ${yeastText ? `<div><span class="opacity-50 uppercase text-[0.8em]">Yeast:</span> <b>${yeastText}</b></div>` : ''}
                        ${allergenText ? `<div class="font-bold uppercase pt-1" style="color: ${getVal('tuneAllergenColor')}">${allergenText}</div>` : ''}
                    </div>
                    <div class="grid grid-cols-2 gap-x-3 font-bold uppercase tracking-wider">
                        <div class="opacity-50">ABV</div> <div>${abv}%</div>
                        ${fg ? `<div class="opacity-50">FG</div> <div>${fg}</div>` : ''}
                        <div class="opacity-50">Vol</div> <div>${vol}ml</div>
                        <div class="opacity-50">Date</div> <div>${dateVal}</div>
                    </div>
                </div>
            </div>
            <div class="h-full w-[70%] relative overflow-hidden" style="background-color: ${bgColor};">
                ${hasImage ? `<img src="${imgSrc}" style="position: absolute; left: ${getVal('tuneArtX')}%; top: ${getVal('tuneArtY')}%; transform: translate(-50%, -50%) rotate(${getVal('tuneArtRotate')}deg) scale(${getVal('tuneArtZoom')}); opacity: ${getVal('tuneArtOpacity')}; min-width: 100%; min-height: 100%; object-fit: cover;">` : ''}
                <div class="absolute z-10 flex flex-row items-end" style="left: ${getVal('tuneTitleX')}%; bottom: ${getVal('tuneTitleY')}%; transform-origin: bottom left;">
                    <h1 class="font-bold uppercase leading-[0.9] whitespace-nowrap" style="writing-mode: vertical-rl; transform: rotate(${180 + parseInt(getVal('tuneTitleRotate'))}deg); font-family: '${getVal('tuneTitleFont')}', sans-serif; font-size: ${getVal('tuneTitleSize')}px; color: ${getVal('tuneTitleColor')};">
                        ${tData.l1}${tData.isSplit ? `<div class="absolute" style="top: 0; left: 0; transform: translate(${getVal('tuneTitleOffset')}%, ${getVal('tuneTitleOffsetY')}%) rotate(0deg); font-size: ${getVal('tuneTitleSize2')}px;">${tData.l2}</div>` : ''}
                    </h1>
                </div>
                <div class="absolute z-20" style="top: ${getVal('tuneLogoY')}px; right: ${getVal('tuneLogoX')}px; transform: rotate(${getVal('tuneLogoRotate')}deg); width: ${getVal('tuneLogoSize')}px; opacity: ${getVal('tuneLogoOpacity')};">
                    ${getCheck('logoColorMode') ? `<div style="width:100%; height:100%; background-color:${getVal('tuneLogoColor')}; -webkit-mask:url(logo.png) center/contain no-repeat; mask:url(logo.png) center/contain no-repeat;"></div>` : `<img src="logo.png" class="w-full h-auto">`}
                </div>
            </div>
        `;
    } 
    else if (theme === 'special') {
        const tData = splitBySlider(title, parseInt(getVal('tuneTitleBreak')) || 8);
        container.innerHTML = `
            ${hasImage ? `<img src="${imgSrc}" class="absolute inset-0 w-full h-full object-cover" style="left: ${getVal('tuneArtX')}%; top: ${getVal('tuneArtY')}%; transform: translate(-50%, -50%) scale(${getVal('tuneArtZoom')}); opacity: ${getVal('tuneArtOpacity')};">` : `<div class="absolute inset-0" style="background-color: ${bgColor};"></div>`}
            <div class="absolute inset-0 pointer-events-none z-50" style="box-shadow: inset 0 0 0 ${borderWidth}mm white;"></div>
            <div class="absolute z-10 w-max" style="top: ${getVal('tuneTitleY')}%; left: ${getVal('tuneTitleX')}%; transform: translate(-50%, -50%) rotate(${getVal('tuneTitleRotate')}deg); text-align: center;">
                <h1 style="font-size: ${getVal('tuneTitleSize')}px; color: ${getVal('tuneTitleColor')}; font-family: '${getVal('tuneTitleFont')}', sans-serif;" class="font-bold uppercase tracking-widest leading-none drop-shadow-lg">${tData.l1}</h1>
            </div>
            <div class="absolute z-10" style="top: ${getVal('tuneDescY')}%; left: ${getVal('tuneDescX')}%; width: ${getVal('tuneDescWidth')}%; transform: translate(-50%, -50%) rotate(${getVal('tuneDescRotate')}deg); text-align: ${getVal('tuneDescAlign')};">
                <p style="font-size: ${getVal('tuneDescSize')}px; color: ${descColor}; font-family: '${getVal('tuneDescFont')}', serif;" class="italic leading-tight drop-shadow-md">${desc}</p>
            </div>
            <div class="absolute z-10" style="left: ${getVal('tuneSpecsX')}%; top: ${getVal('tuneSpecsY')}%; transform: translate(-50%, -50%) rotate(${getVal('tuneSpecsRotate')}deg); text-align: ${getVal('tuneSpecsAlign')};">
                <div style="font-size: ${getVal('tuneSpecsSize')}px; color: ${specsColor}; line-height: 1.4; text-shadow: ${getCheck('tuneSpecsShadow') ? '0 1px 2px rgba(0,0,0,0.8)' : 'none'};">
                    <div class="grid grid-cols-2 gap-x-3 mb-1 font-bold font-mono"><span>ABV</span> <span>${abv}%</span> ${fg ? `<span>FG</span> <span>${fg}</span>` : ''} <span>Vol</span> <span>${vol}ml</span></div>
                    ${honeyText || yeastText ? `<div class="mb-1 border-t border-white/20 pt-1 font-sans uppercase text-[0.8em]">${honeyText ? `Honey: ${honeyText}<br>` : ''}${yeastText ? `Yeast: ${yeastText}` : ''}</div>` : ''}
                    ${allergenText ? `<div class="mt-1 font-bold uppercase" style="color: ${getVal('tuneAllergenColor')}">${allergenText}</div>` : ''}
                </div>
            </div>
            <div class="absolute z-20" style="top: ${getVal('tuneLogoY')}%; right: ${getVal('tuneLogoX')}px; width: ${getVal('tuneLogoSize')}px; transform: rotate(${getVal('tuneLogoRotate')}deg); opacity: ${getVal('tuneLogoOpacity')};">
                 ${getCheck('logoColorMode') ? `<div style="width:100%; height:100%; background-color:${getVal('tuneLogoColor')}; -webkit-mask:url(logo.png) center/contain no-repeat; mask:url(logo.png) center/contain no-repeat;"></div>` : `<img src="logo.png" class="w-full h-full object-contain filter brightness-110 drop-shadow-xl">`}
            </div>
        `;
    }
    setTimeout(() => { if (window.autoFitLabelText) window.autoFitLabelText(); }, 50);
}

// 5. LABEL MANAGER (ADD / DELETE / AUTO-DETECT)

// Open Modal
window.openLabelFormatModal = function() {
    document.getElementById('label-format-form').reset();
    document.getElementById('label-format-modal').classList.remove('hidden');
}

// AI Auto-Detect
async function autoDetectLabelFormat() {
    const code = document.getElementById('lf-lookup-code').value.trim();
    const btn = document.getElementById('lf-lookup-btn');
    
    if (!code) { showToast("Enter a brand/code first.", "error"); return; }

    const originalText = btn.innerText;
    btn.innerText = "Searching...";
    btn.disabled = true;

    const prompt = `You are a Label Database Expert. 
    Find the technical specifications for label sheet: "${code}" (A4 sheet).
    Return a JSON object with these EXACT keys (values in mm number):
    - width (width of one sticker)
    - height (height of one sticker)
    - cols (number of stickers horizontally)
    - rows (number of stickers vertically)
    - marginTop (distance from top edge of A4 to first sticker)
    - marginLeft (distance from left edge of A4 to first sticker)
    - gapX (horizontal space between stickers)
    - gapY (vertical space between stickers)
    
    Return ONLY valid JSON.`;

    const schema = {
        type: "OBJECT",
        properties: {
            "width": { "type": "NUMBER" }, "height": { "type": "NUMBER" },
            "cols": { "type": "NUMBER" }, "rows": { "type": "NUMBER" },
            "marginTop": { "type": "NUMBER" }, "marginLeft": { "type": "NUMBER" },
            "gapX": { "type": "NUMBER" }, "gapY": { "type": "NUMBER" }
        },
        required: ["width", "height", "cols", "rows"]
    };

    try {
        const jsonResponse = await performApiCall(prompt, schema);
        const data = JSON.parse(jsonResponse);

        document.getElementById('lf-name').value = code;
        document.getElementById('lf-width').value = data.width;
        document.getElementById('lf-height').value = data.height;
        document.getElementById('lf-cols').value = data.cols;
        document.getElementById('lf-rows').value = data.rows;
        document.getElementById('lf-marginTop').value = data.marginTop || 0;
        document.getElementById('lf-marginLeft').value = data.marginLeft || 0;
        document.getElementById('lf-gapX').value = data.gapX || 0;
        document.getElementById('lf-gapY').value = data.gapY || 0;

        showToast("Specs found! Verify & Save.", "success");
    } catch (error) {
        console.error("AI Lookup Error:", error);
        showToast("Could not find specs automatically.", "error");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

// Opslaan Nieuw Formaat
window.saveCustomLabelFormat = async function(e) {
    e.preventDefault();
    if (!state.userId) return;
    
    const name = document.getElementById('lf-name').value;
    const id = 'custom_' + Date.now();

    const newFormat = {
        name: name,
        width: parseFloat(document.getElementById('lf-width').value),
        height: parseFloat(document.getElementById('lf-height').value),
        cols: parseInt(document.getElementById('lf-cols').value),
        rows: parseInt(document.getElementById('lf-rows').value),
        marginTop: parseFloat(document.getElementById('lf-marginTop').value) || 0,
        marginLeft: parseFloat(document.getElementById('lf-marginLeft').value) || 0,
        gapX: parseFloat(document.getElementById('lf-gapX').value) || 0,
        gapY: parseFloat(document.getElementById('lf-gapY').value) || 0,
    };

    userLabelFormats[id] = newFormat;

    try {
        await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'labelFormats'), userLabelFormats);
        populateLabelPaperDropdown();
        document.getElementById('labelPaper').value = id;
        updateLabelPreviewDimensions();
        document.getElementById('label-format-modal').classList.add('hidden');
        showToast("Format saved!", "success");
    } catch (e) { showToast("Save error.", "error"); }
}

// --- VERWIJDEREN CUSTOM FORMAAT (VERBETERD) ---
window.deleteCustomLabelFormat = async function() {
    // 1. Haal de ID op van het geselecteerde formaat uit de sidebar
    const select = document.getElementById('labelPaper');
    const id = select ? select.value : '';

    // 2. Controleer of het een custom formaat is (standaard formaten mogen niet weg)
    if (!userLabelFormats[id]) {
        showToast("Cannot delete standard formats.", "error");
        return;
    }

    // 3. Bevestiging vragen
    if (!confirm(`Are you sure you want to delete "${userLabelFormats[id].name}"?`)) return;

    const originalName = userLabelFormats[id].name;

    try {
        // 4. Verwijder lokaal uit het object
        delete userLabelFormats[id];
        
        // 5. Update de volledige collectie in Firestore
        // We overschrijven het 'labelFormats' document met de nieuwe lijst (zonder de verwijderde ID)
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'labelFormats');
        await setDoc(docRef, userLabelFormats);

        // 6. UI herstellen
        populateLabelPaperDropdown(); // Ververs de dropdown lijst
        
        // Zet de selectie terug op de standaard Avery
        if (select) select.value = 'avery_l7165';
        
        // Verberg de modal
        document.getElementById('label-format-modal').classList.add('hidden');
        
        showToast(`Format "${originalName}" deleted.`, "success");
    } catch (e) {
        console.error("Delete Format Error:", e);
        showToast("Could not delete format from database.", "error");
    }
}

// 6. AI CONTENT & ART GENERATORS

function handleLogoUpload(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            // SLA OP IN HET GEHEUGEN (VEILIG)
            tempState.currentLabelImageSrc = e.target.result;
            
            // Update het scherm direct
            const imgDisplay = document.getElementById('label-img-display');
            if (imgDisplay) {
                imgDisplay.src = e.target.result;
                imgDisplay.classList.remove('hidden');
            }
            const placeholder = document.getElementById('label-img-placeholder');
            if(placeholder) placeholder.classList.add('hidden');
            
            // Ververs het thema meteen
            const activeThemeBtn = document.querySelector('.label-theme-btn.active');
            const theme = activeThemeBtn ? activeThemeBtn.dataset.theme : 'standard';
            setLabelTheme(theme);

            window.updateArtButtons();
        }
        reader.readAsDataURL(file);
    }
}

// --- GENERATE LABEL ART (V5.1 - SAFE QUALITY BOOST) ---
async function generateLabelArt() {
    const title = document.getElementById('labelTitle').value;
    const style = document.getElementById('labelSubtitle').value;
    const activeBtn = document.querySelector('.label-theme-btn.active');
    const theme = activeBtn ? activeBtn.dataset.theme : 'standard';
    
    if (!title) return showToast("Enter a title first.", "error");

    const btn = document.getElementById('ai-label-art-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = "🎨 Painting HD..."; 
    btn.disabled = true;

    // 1. STIJL BEPALEN
    let visualStyle = "";
    
    // Check dropdown (Jouw custom stijlen)
    const selectedStylePrompt = document.getElementById('labelArtStyle')?.value;

    if (selectedStylePrompt && selectedStylePrompt.trim() !== "") {
        // GEBRUIKER KEUZE (Bv. Pearl Jam)
        // We voegen hier alleen VEILIGE kwaliteitstermen toe
        visualStyle = selectedStylePrompt + ", 8k resolution, highly detailed, sharp focus, professional artwork.";
    } else {
        // FALLBACKS (Hier mogen we wel sturen op 'clean' of 'oil')
        if (theme === 'special') {
            visualStyle = "Dark, mystical, premium texture, gold accents, high contrast, oil painting style, 8k resolution, sharp details.";
        } else {
            visualStyle = "Clean, modern vector art, vibrant colors, white background, minimalist, sharp lines, high definition, flat design.";
        }
    }

    // 2. ASPECT RATIO (SLIMME FORMATEN)
    let aspectRatio = "1:1"; 
    const paperSelect = document.getElementById('labelPaper');
    if (paperSelect) {
        const key = paperSelect.value;
        const fmt = builtInLabelFormats[key] || userLabelFormats[key];
        
        if (fmt) {
            const ratio = fmt.width / fmt.height;
            if (ratio > 1.6) aspectRatio = "16:9";      
            else if (ratio > 1.1) aspectRatio = "4:3";  
            else if (ratio < 0.6) aspectRatio = "9:16"; 
            else if (ratio < 0.9) aspectRatio = "3:4";  
            else aspectRatio = "1:1";                   
            
            console.log(`📏 Auto-Ratio: ${fmt.width}x${fmt.height} -> ${aspectRatio}`);
        }
    }

    // 3. DE PROMPT
    let artPrompt = `
    Create a high-quality artistic background illustration.
    
    VISUAL SUBJECT: A creative visual interpretation of the concept: "${title}" (${style}).
    ART STYLE: ${visualStyle}
    
    CRITICAL NEGATIVE CONSTRAINTS (STRICT):
    1. NO TEXT. NO WORDS. NO LETTERS. NO TYPOGRAPHY.
    2. Do NOT write the name "${title}" anywhere.
    3. Do NOT make a "product label" layout with borders. Create the artwork itself.
    4. No blurry elements, no artifacts, no pixelation.
    `;

    try {
        let apiKey = state.userSettings.imageApiKey || state.userSettings.apiKey;
        if (!apiKey && typeof CONFIG !== 'undefined') apiKey = CONFIG.firebase.apiKey;
        if (!apiKey) throw new Error("No API Key found.");

        const model = state.userSettings.imageModel || "imagen-3.0-generate-001";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                instances: [{ prompt: artPrompt }], 
                parameters: { 
                    sampleCount: 1, 
                    aspectRatio: aspectRatio 
                } 
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error?.message || "AI Error");
        }
        
        const data = await response.json();
        
        if (data.predictions && data.predictions[0].bytesBase64Encoded) {
            const base64Img = data.predictions[0].bytesBase64Encoded;
            const finalSrc = `data:image/png;base64,${base64Img}`;
            
            tempState.currentLabelImageSrc = finalSrc;

            const imgDisplay = document.getElementById('label-img-display');
            if (imgDisplay) {
                imgDisplay.src = finalSrc;
                imgDisplay.classList.remove('hidden');
            }
            document.getElementById('label-img-placeholder')?.classList.add('hidden');

            setLabelTheme(theme);
            window.updateArtButtons();
            
            showToast(`Artwork created (${aspectRatio})!`, "success");
        }
    } catch (error) {
        console.error(error);
        showToast("Generation failed: " + error.message, "error");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

window.clearLabelArt = function() {
    tempState.currentLabelImageSrc = '';
    document.getElementById('label-img-display').classList.add('hidden');
    document.getElementById('label-img-placeholder')?.classList.remove('hidden');
    
    // Reset thema (zodat het plaatje verdwijnt uit de preview)
    const activeBtn = document.querySelector('.label-theme-btn.active');
    setLabelTheme(activeBtn ? activeBtn.dataset.theme : 'standard');
    
    window.updateArtButtons();
}

// --- CLOUD GALLERY SYSTEM (V2.0 - FIREBASE STORAGE) ---

// 1. Opslaan (Nu geschikt voor Hoge Resolutie!)
window.saveArtToCloud = async function() {
    if (!tempState.currentLabelImageSrc) return;
    if (!state.userId) return showToast("Log in to use Cloud Gallery.", "error");

    const btn = document.querySelector('button[onclick="window.saveArtToCloud()"]');
    const originalText = btn.innerHTML;
    btn.innerHTML = "Uploading HD..."; // Feedback dat we groot bestand doen
    btn.disabled = true;

    try {
        const title = document.getElementById('labelTitle')?.value || "Untitled";
        // We maken een unieke bestandsnaam: users/USER_ID/gallery/TIMESTAMP_TITEL.png
        const timestamp = Date.now();
        const safeTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const filePath = `users/${state.userId}/gallery/${timestamp}_${safeTitle}.png`;
        
        // A. Upload het bestand naar Storage (Harde Schijf)
        const storageRef = ref(storage, filePath);
        // currentLabelImageSrc is een base64 string, dus we gebruiken uploadString
        await uploadString(storageRef, tempState.currentLabelImageSrc, 'data_url');
        
        // B. Haal de publieke download URL op
        const downloadUrl = await getDownloadURL(storageRef);

        // C. Sla de REFERENTIE op in de Database (Database blijft nu snel & klein)
        await addDoc(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'gallery'), {
            imageSrc: downloadUrl,    // We slaan nu de link op, niet de data zelf
            storagePath: filePath,    // Pad bewaren om later te kunnen verwijderen
            name: title,
            createdAt: new Date().toISOString()
        });

        showToast("HD Artwork saved to Cloud!", "success");
    } catch (e) {
        console.error(e);
        showToast("Upload failed: " + e.message, "error");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// --- DOWNLOAD ARTWORK NAAR APPARAAT ---
window.downloadLabelArt = function() {
    // 1. Check of er een plaatje is
    if (!tempState.currentLabelImageSrc) {
        showToast("No artwork to download.", "error");
        return;
    }

    // 2. Maak een tijdelijke download link
    const link = document.createElement('a');
    link.href = tempState.currentLabelImageSrc;
    
    // 3. Bepaal bestandsnaam (gebruik titel of timestamp)
    const title = document.getElementById('labelTitle')?.value || "mead_art";
    const safeTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    link.download = `${safeTitle}_${Date.now()}.png`;

    // 4. Klik de link automatisch
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast("Download started!", "success");
}

// 2. Open Galerij & Laad Plaatjes
window.openArtGallery = function() {
    if (!state.userId) return showToast("Log in first.", "error");
    
    const modal = document.getElementById('gallery-modal');
    const grid = document.getElementById('gallery-grid');
    modal.classList.remove('hidden');
    grid.innerHTML = '<div class="col-span-full flex justify-center py-10"><div class="loader"></div></div>';

    // Haal data op
    const q = query(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'gallery'));
    
    // Realtime listener (zodat delete direct zichtbaar is)
    onSnapshot(q, (snapshot) => {
        if (snapshot.empty) {
            grid.innerHTML = `<div class="col-span-full text-center py-10 text-app-secondary opacity-60 flex flex-col items-center gap-2"><span class="text-4xl">📂</span><p>Gallery is empty.<br>Save your creations to see them here.</p></div>`;
            return;
        }

        // Sorteer op nieuwste eerst
        const arts = snapshot.docs.map(doc => ({id: doc.id, ...doc.data()}))
                                  .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

        grid.innerHTML = arts.map(art => `
            <div class="relative group aspect-square rounded-2xl overflow-hidden border border-outline-variant bg-surface-container cursor-pointer shadow-sm hover:shadow-elevation-2 transition-all hover:scale-[1.02]">
                <img src="${art.imageSrc}" class="w-full h-full object-cover transition-opacity duration-300" onclick="window.selectFromGallery('${art.imageSrc}')">
                
                <div class="absolute bottom-0 left-0 right-0 bg-surface-container/90 backdrop-blur-sm p-2 border-t border-outline-variant flex justify-between items-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <span class="text-[10px] font-bold text-on-surface truncate pr-2">${art.name}</span>
                    <button onclick="window.deleteFromGallery('${art.id}', '${art.storagePath || ''}')" class="text-error hover:text-red-700 font-bold px-2">&times;</button>
                </div>
            </div>
        `).join('');
    });
}

// 3. Kies Plaatje (Inladen in Editor)
window.selectFromGallery = function(src) {
    tempState.currentLabelImageSrc = src;
    
    // Update UI
    const imgDisplay = document.getElementById('label-img-display');
    if (imgDisplay) {
        imgDisplay.src = src;
        imgDisplay.classList.remove('hidden');
    }
    document.getElementById('label-img-placeholder')?.classList.add('hidden');
    
    // Sluit modal
    document.getElementById('gallery-modal').classList.add('hidden');
    
    // Refresh label & knoppen
    const activeBtn = document.querySelector('.label-theme-btn.active');
    const theme = activeBtn ? activeBtn.dataset.theme : 'standard';
    setLabelTheme(theme);
    window.updateArtButtons();
    
    showToast("Artwork loaded from Cloud!", "success");
}

// 4. Verwijder uit Cloud (Database + Storage File)
window.deleteFromGallery = async function(docId, storagePath) {
    if(!confirm("Permanently delete this artwork?")) return;
    try {
        // A. Verwijder eerst het bestand uit Storage (als het pad bekend is)
        if (storagePath) {
            const fileRef = ref(storage, storagePath);
            await deleteObject(fileRef).catch(err => console.log("File not found in storage, deleting doc only."));
        }

        // B. Verwijder daarna het document uit de database
        await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'gallery', docId));
        
        showToast("Artwork deleted.", "success");
    } catch(e) {
        console.error(e);
        showToast("Delete failed: " + e.message, "error");
    }
}

// AI Label Schrijver (CRASH PROOF & MET PERSONA)
async function generateLabelDescription() {
    // Veilige getters (voorkomt crash als element niet bestaat)
    const getVal = (id) => document.getElementById(id)?.value || '';
    
    const title = getVal('labelTitle');
    const style = getVal('labelSubtitle');
    const ingredients = getVal('labelDetails'); // Dit veroorzaakte de crash
    const persona = getVal('label-persona-select');
    
    if (!title) return showToast("Enter a title first.", "error");
    
    const btn = document.getElementById('ai-label-desc-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = "Thinking...";
    btn.disabled = true;
    
    // --- PERSONA DEFINITIES ---
    let toneInstruction = "";
    
    switch (persona) {
        case 'Ryan Reynolds':
            toneInstruction = `**TONE: RYAN REYNOLDS.** High energy, witty, sarcastic, meta-humor. Break the fourth wall. Make fun of the brewing effort but praise the result.`;
            break;
        case 'The Sommelier':
            toneInstruction = `**TONE: THE SOMMELIER.** Elegant, sophisticated, sensory-focused. Use words like "bouquet", "finish", "notes of", "structure". No slang. Premium feel.`;
            break;
        case 'Dry British':
            toneInstruction = `**TONE: DRY BRITISH.** Understated, deadpan, cynical but charming. Use words like "splendid", "rather nice", "not half bad".`;
            break;
        case 'The Viking':
            toneInstruction = `**TONE: THE VIKING.** Bold, loud, archaic, enthusiastic. Talk about feasts, gods, glory, and blood (metaphorically).`;
            break;
        default: // Witty / Default
            toneInstruction = `**TONE: MODERN CRAFT.** Punchy, witty, slightly cynical/dark humor (e.g. "Liquid decay"). Modern branding style. Short sentences.`;
            break;
    }

    // De Prompt
    const prompt = `Write a short "back-of-bottle" description (max 30 words) for a Mead called "${title}".
    
    **CONTEXT:**
    - Style: ${style}
    - Key Ingredients: ${ingredients}
    
    ${toneInstruction}
    
    **CONSTRAINT:** Max 25 words. Make it fit on a small label.
    Output ONLY the text. No quotes.`;
    
    try {
        const text = await performApiCall(prompt);
        
        // Update het tekstvak (veilig)
        const descField = document.getElementById('labelDescription');
        if(descField) {
            descField.value = text.replace(/^["']|["']$/g, '').trim();
            // Trigger update voor preview
            updateLabelPreviewText();
        }
        
    } catch (e) {
        console.error(e);
        showToast("AI Writer failed.", "error");
    } finally {
        if(btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }
}

// 7. PRINT ENGINE (Dynamic Grid)
function printLabelsSheet() {
    const key = document.getElementById('labelPaper').value;
    const fmt = builtInLabelFormats[key] || userLabelFormats[key];
    if(!fmt) return;

    const labelContent = document.getElementById('label-content').outerHTML;
    const totalLabels = fmt.cols * fmt.rows;
    
    const gridCSS = `
        display: grid;
        grid-template-columns: repeat(${fmt.cols}, ${fmt.width}mm);
        grid-template-rows: repeat(${fmt.rows}, ${fmt.height}mm);
        column-gap: ${fmt.gapX}mm;
        row-gap: ${fmt.gapY}mm;
        padding-top: ${fmt.marginTop}mm;
        padding-left: ${fmt.marginLeft}mm;
        width: 210mm;
        height: 297mm;
        box-sizing: border-box;
    `;

    const win = window.open('', '_blank');
    win.document.write(`
        <html><head><title>Print Labels</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@400;700&display=swap');
            @import url('https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&display=swap');
            
            body { margin: 0; background: white; }
            .sheet { ${gridCSS} }
            .label-cell { width: ${fmt.width}mm; height: ${fmt.height}mm; overflow: hidden; border: 1px dashed #eee; }
            @media print { 
                @page { size: A4; margin: 0; }
                body { -webkit-print-color-adjust: exact; }
                .label-cell { border: none; }
            }
        </style>
        </head><body>
        <div class="sheet">
            ${Array(totalLabels).fill(`<div class="label-cell">${labelContent}</div>`).join('')}
        </div>
        <script>
            const src = window.opener.document.getElementById('label-img-display').src;
            const isHidden = window.opener.document.getElementById('label-img-display').classList.contains('hidden');
            
            document.querySelectorAll('.label-cell').forEach(c => {
               const img = c.querySelector('img'); 
               const sp = c.querySelector('span');
               if(src && !isHidden) { 
                   img.src = src; 
                   img.classList.remove('hidden'); 
                   if(sp) sp.style.display='none'; 
               }
            });
            setTimeout(()=>window.print(), 800);
        </script>
        </body></html>
    `);
    win.document.close();
}

// --- LABEL OPSLAAN FUNCTIE (V3.4 - SELF HEALING FIX) ---
window.saveLabelToBrew = async function() {
    const select = document.getElementById('labelRecipeSelect');
    const brewId = select?.value; 
    
    if (!brewId) return showToast("Select a recipe first.", "error");
    if (!state.userId) return;

    // 1. UI Feedback
    const btn = document.querySelector('button[onclick="window.saveLabelToBrew()"]');
    const originalText = btn ? btn.innerHTML : 'Save';
    if(btn) { btn.innerHTML = "Saving..."; btn.disabled = true; }

    try {
        // --- STAP A: DATA VERZAMELEN ---
        // Helpers
        const getVal = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
        const getCheck = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
        const getText = (id) => { const el = document.getElementById(id); return el ? el.textContent : ''; };

        // Huidig thema
        const activeBtn = document.querySelector('.label-theme-btn.active');
        const currentTheme = activeBtn ? activeBtn.dataset.theme : 'standard';

        // Afbeelding Uploaden (indien nodig)
        let finalImageSrc = tempState.currentLabelImageSrc || '';
        if (finalImageSrc.startsWith('data:image')) {
            btn.innerHTML = "Uploading Art..."; 
            const storagePath = `users/${state.userId}/labels/art_${Date.now()}.png`;
            const storageRef = ref(storage, storagePath);
            await uploadString(storageRef, finalImageSrc, 'data_url');
            finalImageSrc = await getDownloadURL(storageRef);
            tempState.currentLabelImageSrc = finalImageSrc; // Update cache
        }

        btn.innerHTML = "Saving Data...";

        // Verzamel alle instellingen
        const rawSettings = {
            title: getVal('labelTitle'), subtitle: getVal('labelSubtitle'),
            abv: getVal('labelAbv'), fg: getVal('labelFg'), vol: getVal('labelVol'),
            date: getVal('labelDate'), desc: getVal('labelDescription'),
            details: getVal('labelDetails'), persona: getVal('label-persona-select'),
            allergens: getVal('labelAllergens'),
            
            showYeast: getCheck('labelShowYeast'), showHoney: getCheck('labelShowHoney'),
            showDetails: getCheck('labelShowDetails'),
            yeastName: getText('displayLabelYeast'), honeyName: getText('displayLabelHoney'),

            // Sliders (Alles in één keer)
            tuneTitleSize: getVal('tuneTitleSize'), tuneTitleSize2: getVal('tuneTitleSize2'),
            tuneTitleX: getVal('tuneTitleX'), tuneTitleY: getVal('tuneTitleY'),
            tuneTitleColor: getVal('tuneTitleColor'), tuneTitleRotate: getVal('tuneTitleRotate'),
            tuneTitleOffset: getVal('tuneTitleOffset'), tuneTitleOffsetY: getVal('tuneTitleOffsetY'),
            tuneTitleBreak: getVal('tuneTitleBreak'),
            
            tuneStyleY: getVal('tuneStyleY'), tuneStyleSize: getVal('tuneStyleSize'),
            tuneStyleSize2: getVal('tuneStyleSize2'), tuneStyleGap: getVal('tuneStyleGap'),
            tuneStyleOffsetY: getVal('tuneStyleOffsetY'), tuneStyleColor: getVal('tuneStyleColor'),
            tuneStyleRotate: getVal('tuneStyleRotate'), tuneStyleOffset: getVal('tuneStyleOffset'),
            tuneStyleBreak: getVal('tuneStyleBreak'),
            
            tuneSpecsSize: getVal('tuneSpecsSize'), tuneSpecsX: getVal('tuneSpecsX'),
            tuneSpecsY: getVal('tuneSpecsY'), tuneSpecsColor: getVal('tuneSpecsColor'),
            tuneSpecsRotate: getVal('tuneSpecsRotate'), tuneSpecsAlign: getVal('tuneSpecsAlign'),

            tuneDescX: getVal('tuneDescX'), tuneDescY: getVal('tuneDescY'),
            tuneDescWidth: getVal('tuneDescWidth'), tuneDescRotate: getVal('tuneDescRotate'),
            tuneDescSize: getVal('tuneDescSize'), tuneDescColor: getVal('tuneDescColor'),
            tuneDescAlign: getVal('tuneDescAlign'),
            
            tuneArtZoom: getVal('tuneArtZoom'), tuneArtX: getVal('tuneArtX'),
            tuneArtY: getVal('tuneArtY'), tuneArtOpacity: getVal('tuneArtOpacity'),
            tuneArtRotate: getVal('tuneArtRotate'), tuneArtOverlay: getVal('tuneArtOverlay'),
            
            tuneLogoSize: getVal('tuneLogoSize'), tuneLogoX: getVal('tuneLogoX'),
            tuneLogoY: getVal('tuneLogoY'), tuneLogoRotate: getVal('tuneLogoRotate'),
            tuneLogoOpacity: getVal('tuneLogoOpacity'), logoColorMode: getCheck('logoColorMode'),
            tuneLogoColor: getVal('tuneLogoColor'),

            tuneBorderWidth: getVal('tuneBorderWidth'), tuneAllergenColor: getVal('tuneAllergenColor'),
            tuneBackgroundColor: getVal('tuneBackgroundColor'),
            
            imageSrc: finalImageSrc 
        };

        // Maak schoon (verwijder undefined/empty keys die problemen geven)
        const specificSettings = JSON.parse(JSON.stringify(rawSettings));

        // --- STAP B: DATABASE REPARATIE & OPSLAAN ---
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId);
        
        // 1. Haal eerst het document op om de structuur te controleren
        const docSnap = await getDoc(docRef);
        let currentData = docSnap.exists() ? docSnap.data() : {};
        
        // 2. Check of labelSettings bestaat en of het een Array is (FOUT)
        if (currentData.labelSettings && Array.isArray(currentData.labelSettings)) {
            console.warn("⚠️ Corrupt Data Detected: labelSettings is an Array. Converting to Object...");
            // Reset het veld naar een leeg object
            await updateDoc(docRef, { labelSettings: {} });
        }

        // 3. Nu veilig opslaan met Dot Notation (dit voorkomt dat we de hele map overschrijven)
        // We gebruiken updateDoc als de doc bestaat, anders setDoc
        const fieldPath = `labelSettings.${currentTheme}`;
        
        if (docSnap.exists()) {
            await updateDoc(docRef, { [fieldPath]: specificSettings });
        } else {
            // Fallback voor als het document niet bestaat (zou niet moeten kunnen hier)
            await setDoc(docRef, { labelSettings: { [currentTheme]: specificSettings } }, { merge: true });
        }

        // Update lokale cache
        const brewIndex = state.brews.findIndex(b => b.id === brewId);
        if(brewIndex > -1) {
            if (!state.brews[brewIndex].labelSettings || Array.isArray(state.brews[brewIndex].labelSettings)) {
                state.brews[brewIndex].labelSettings = {};
            }
            state.brews[brewIndex].labelSettings[currentTheme] = specificSettings;
        }

        showToast(`${currentTheme.toUpperCase()} label saved!`, "success");

    } catch (e) {
        console.error("Save Error Detail:", e);
        showToast("Save failed: " + e.message, "error");
    } finally {
        if(btn) { btn.innerHTML = originalText; btn.disabled = false; }
    }
}

// --- FUNCTIE: TEKST AUTOMATISCH PASSEND MAKEN (VERBETERD V4.0) ---
window.autoFitLabelText = function() {
    const titleEl = document.getElementById('prev-title');
    const groupEl = document.getElementById('text-group'); 
    // Dynamische selector voor de rechter container van het label
    const container = document.querySelector('#label-content > div:last-child'); 
    const logoEl = document.getElementById('label-logo-img');
    
    if (!titleEl || !groupEl || !container) return;

    // Haal de door de gebruiker gekozen basisgrootte op uit de slider
    const sizeSlider = document.getElementById('tuneTitleSize');
    const startFontSize = sizeSlider ? parseInt(sizeSlider.value) : 100;
    const safeZone = 5; // Marge in pixels rondom de randen en het logo

    // 1. Reset naar de basisgrootte
    let fontSize = startFontSize; 
    titleEl.style.fontSize = fontSize + 'px';

    // 2. Hulpfunctie om botsingen of overloop te detecteren
    const checkIssues = () => {
        const gRect = groupEl.getBoundingClientRect(); 
        const cRect = container.getBoundingClientRect();
        
        // Check of de tekst de randen van het label raakt
        const overflows = (gRect.right > cRect.right - safeZone) || 
                          (gRect.bottom > cRect.bottom - safeZone) ||
                          (gRect.left < cRect.left + safeZone) ||
                          (gRect.top < cRect.top + safeZone);

        // Check of de tekst het logo raakt
        let hitsLogo = false;
        if (logoEl && logoEl.offsetParent !== null) { // Alleen als logo zichtbaar is
            const lRect = logoEl.getBoundingClientRect();
            hitsLogo = !(gRect.right < (lRect.left - safeZone) || 
                         gRect.left > (lRect.right + safeZone) || 
                         gRect.bottom < (lRect.top - safeZone) || 
                         gRect.top > (lRect.bottom + safeZone));
        }
        
        return overflows || hitsLogo;
    };

    // 3. Verklein de font-size stap voor stap tot het past (minimaal 8px)
    while (checkIssues() && fontSize > 8) {
        fontSize -= 2; 
        titleEl.style.fontSize = fontSize + 'px';
    }
    
    // Log voor debug (optioneel): console.log(`Auto-fit: ${startFontSize}px -> ${fontSize}px`);
};

// --- DEEL X: LABEL ASSETS MANAGER (STYLES & FONTS) ---

let labelAssets = {
    styles: [],
    fonts: []
};

// --- NIEUWE FUNCTIE: VOEG ART STYLE TOE ---
async function addLabelStyle() {
    const nameInput = document.getElementById('newStyleName');
    const promptInput = document.getElementById('newStylePrompt');
    const btn = document.getElementById('addStyleBtn');

    const name = nameInput.value.trim();
    const prompt = promptInput.value.trim();

    if (!name || !prompt) {
        showToast("Vul eerst een Naam én een Prompt in.", "error");
        return;
    }

    // UI Feedback
    const originalText = btn.innerText;
    btn.innerText = "...";
    btn.disabled = true;

    try {
        // 1. Voeg toe aan de lokale lijst
        if (!labelAssets.styles) labelAssets.styles = [];
        
        labelAssets.styles.push({
            id: 'style_' + Date.now(),
            name: name,
            prompt: prompt
        });

        // 2. Sla op in Firebase
        await saveLabelAssets();

        // 3. Update de UI (Lijst in Settings & Dropdown in Label Forge)
        renderLabelAssetsSettings();
        if(typeof populateLabelStylesDropdown === 'function') {
            populateLabelStylesDropdown();
        }

        // 4. Reset inputs
        nameInput.value = '';
        promptInput.value = '';
        
        showToast(`Stijl "${name}" toegevoegd!`, "success");

    } catch (e) {
        console.error(e);
        showToast("Fout bij toevoegen.", "error");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

// 1. DATA LADEN (VEILIGE VERSIE)
async function loadLabelAssets() {
    if (!state.userId) return;
    try {
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'labelAssets');
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            labelAssets = docSnap.data();
        } else {
            // Initieer met defaults als het leeg is
            labelAssets = {
                styles: [
                    { id: 'def1', name: 'Modern Vector', prompt: 'clean vector art, flat design, minimalist, vibrant colors, white background' },
                    { id: 'def2', name: 'Dark Mystical', prompt: 'dark fantasy style, oil painting, dramatic lighting, intricate details, gold accents' }
                ],
                fonts: [
                    { id: 'f1', name: 'Barlow Semi Condensed' },
                    { id: 'f2', name: 'Playfair Display' }
                ]
            };
            await setDoc(docRef, labelAssets);
        }
        
        // Zorg dat de arrays bestaan voordat we renderen (voorkomt crashes)
        if (!labelAssets.styles) labelAssets.styles = [];
        if (!labelAssets.fonts) labelAssets.fonts = [];

        renderLabelAssetsSettings();
        loadGoogleFontsInHeader();
        populateLabelFontsDropdowns()
        
    } catch (e) {
        console.error("Error loading label assets:", e);
    }
}

// 2. GOOGLE FONTS INLADEN (Dynamisch & Robuust)
function loadGoogleFontsInHeader() {
    if (!labelAssets.fonts) return;

    labelAssets.fonts.forEach(font => {
        // Zorg dat de naam correct is voor Google URL (Spaties -> +)
        const fontQuery = font.name.trim().replace(/\s+/g, '+'); 
        const id = `font-link-${font.name.replace(/\s+/g, '-')}`; // ID voor de <link> tag
        
        if (!document.getElementById(id)) {
            const link = document.createElement('link');
            link.id = id;
            link.rel = 'stylesheet';
            // We laden gewicht 400 (Regular) en 700 (Bold)
            link.href = `https://fonts.googleapis.com/css2?family=${fontQuery}:wght@400;700&display=swap`;
            document.head.appendChild(link);
        }
    });
}

// 3. UI RENDEREN (In Settings Scherm)
function renderLabelAssetsSettings() {
    const stylesList = document.getElementById('settings-styles-list');
    const fontsList = document.getElementById('settings-fonts-list');
    
    // A. RENDER STYLES (Art Prompts)
    if (stylesList) {
        stylesList.innerHTML = labelAssets.styles.map((s, idx) => `
            <div class="flex justify-between items-center p-3 mb-2 bg-surface-container rounded-xl border border-outline-variant hover:border-primary group transition-all">
                <div class="flex items-center gap-3">
                    <span class="w-8 h-8 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center font-bold text-xs">🎨</span>
                    <div>
                        <p class="font-bold text-sm text-on-surface">${s.name}</p>
                        <p class="text-xs text-on-surface-variant truncate w-48 opacity-70">${s.prompt}</p>
                    </div>
                </div>
                <button onclick="window.deleteLabelAsset('styles', ${idx})" class="w-8 h-8 rounded-full flex items-center justify-center text-error hover:bg-error-container transition-colors">&times;</button>
            </div>
        `).join('');
    }

    // B. RENDER FONTS (Typography)
    if (fontsList) {
        fontsList.innerHTML = labelAssets.fonts.map((f, idx) => `
            <div class="flex justify-between items-center p-3 mb-2 bg-surface-container rounded-xl border border-outline-variant hover:border-primary group transition-all">
                <div class="flex items-center gap-3">
                    <span class="w-8 h-8 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center font-bold text-xs">Ab</span>
                    <p class="text-lg text-on-surface" style="font-family: '${f.name}', sans-serif;">
                        ${f.name}
                    </p>
                </div>
                <button onclick="window.deleteLabelAsset('fonts', ${idx})" class="w-8 h-8 rounded-full flex items-center justify-center text-error hover:bg-error-container transition-colors">&times;</button>
            </div>
        `).join('');
    }
}

// --- VALIDATOR: CHECK GOOGLE FONTS (STRICT GET) ---
async function isValidGoogleFont(fontName) {
    if (!fontName) return false;
    
    // Google API url formatteert spaties als plustekens
    const formattedName = fontName.trim().replace(/\s+/g, '+');
    const url = `https://fonts.googleapis.com/css2?family=${formattedName}&display=swap`;

    try {
        // We gebruiken GET in plaats van HEAD voor maximale betrouwbaarheid
        const response = await fetch(url, { method: 'GET' });
        return response.ok; // Geeft true (200) of false (400)
    } catch (e) {
        console.warn("Font check failed (network error)", e);
        return false;
    }
}

// 4. TOEVOEGEN (MET STRICTE VALIDATIE & AUTO-CORRECT)
window.addLabelFont = async function() {
    const input = document.getElementById('newFontName');
    const rawName = input.value.trim();
    const btn = document.getElementById('addFontBtn');
    
    if (!rawName) return showToast("Enter a font name first.", "error");
    
    const originalText = btn.innerText;
    btn.innerText = "Checking...";
    btn.disabled = true;

    try {
        let finalName = null;
        let autoCorrected = false;

        // POGING 1: Check de exacte invoer (bv. "Playfair Display")
        const isExactValid = await isValidGoogleFont(rawName);

        if (isExactValid) {
            finalName = rawName;
        } else {
            // POGING 2: Probeer Auto-Correctie (CamelCase -> Spaties)
            // bv. "OpenSans" -> "Open Sans"
            const fixedName = rawName.replace(/([a-z])([A-Z])/g, '$1 $2');
            
            console.log(`Exact match failed for '${rawName}'. Trying '${fixedName}'...`);
            
            const isFixedValid = await isValidGoogleFont(fixedName);
            
            if (isFixedValid) {
                finalName = fixedName;
                autoCorrected = true;
            }
        }

        // CONCLUSIE: Hebben we een geldige naam gevonden?
        if (!finalName) {
            throw new Error(`Font "${rawName}" not found on Google Fonts. Check spelling.`);
        }

        // Dubbele check of hij al in de lijst staat
        if (labelAssets.fonts.some(f => f.name.toLowerCase() === finalName.toLowerCase())) {
            throw new Error("This font is already in your list.");
        }

        // OPSLAAN (Alleen als we hier komen is het veilig)
        labelAssets.fonts.push({ id: Date.now().toString(), name: finalName });
        await saveLabelAssets();
        
        // UI Updates
        loadGoogleFontsInHeader(); 
        populateLabelFontsDropdowns(); 
        input.value = '';
        
        if (autoCorrected) {
            showToast(`Auto-corrected to "${finalName}" and saved!`, "success");
        } else {
            showToast(`"${finalName}" added successfully!`, "success");
        }

    } catch (error) {
        showToast(error.message, "error");
        input.classList.add('border-red-500', 'ring-1', 'ring-red-500');
        setTimeout(() => input.classList.remove('border-red-500', 'ring-1', 'ring-red-500'), 2000);
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

window.deleteLabelAsset = async function(type, index) {
    if(!confirm("Verwijderen?")) return;
    labelAssets[type].splice(index, 1);
    await saveLabelAssets();
}

async function saveLabelAssets() {
    if (!state.userId) return;
    try {
        await setDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'labelAssets'), labelAssets);
        renderLabelAssetsSettings();
        showToast("Assets opgeslagen!", "success");
    } catch (e) {
        console.error(e);
        showToast("Fout bij opslaan.", "error");
    }
}

window.resetLabelLayout = function() {
    if(!confirm("Reset all sliders to default?")) return;
    
    const brewId = document.getElementById('labelRecipeSelect').value;
    const activeTheme = document.querySelector('.label-theme-btn.active')?.dataset.theme || 'standard';
    
    // Roep de bestaande load functie aan ZONDER opgeslagen data te forceren, 
    // dit triggert de 'Scenario B' (Reset naar harde defaults) in je code.
    if(brewId) {
        // We omzeilen de opgeslagen settings even door een nep-object te sturen zonder settings
        const brew = state.brews.find(b => b.id === brewId);
        const tempBrew = {...brew, labelSettings: null}; 
        
        // Sla de originele settings niet over in de state, maar laad ze gewoon niet in de UI
        window.loadLabelFromBrew(brewId, activeTheme); 
        showToast("Layout reset to theme defaults", "info");
    }
}


// =============================================================
// STAP 4.5: EXPORTS NAAR WINDOW (CRUCIAAL VOOR HTML KNOPPEN)
// =============================================================

// 1. Hoofdfuncties
window.initLabelForge = initLabelForge;
window.setLabelTheme = setLabelTheme;
window.loadLabelFromBrew = loadLabelFromBrew; 

// 2. AI Generatoren
window.generateLabelArt = generateLabelArt;
window.generateLabelDescription = generateLabelDescription;

// 3. Opslaan & Printen
window.saveLabelToBrew = saveLabelToBrew;
window.printLabelsSheet = printLabelsSheet;

// 4. Cloud Gallery (Afbeeldingen)
window.openArtGallery = openArtGallery;
window.saveArtToCloud = saveArtToCloud;
window.downloadLabelArt = downloadLabelArt;
window.clearLabelArt = clearLabelArt;
window.selectFromGallery = selectFromGallery;
window.deleteFromGallery = deleteFromGallery;

// 5. Label Formaten Manager
window.openLabelFormatModal = openLabelFormatModal;
window.saveCustomLabelFormat = saveCustomLabelFormat;
window.deleteCustomLabelFormat = deleteCustomLabelFormat;
window.autoDetectLabelFormat = autoDetectLabelFormat;

// 6. Helpers
window.populateLabelRecipeDropdown = populateLabelRecipeDropdown;
window.updateLabelPreviewDimensions = updateLabelPreviewDimensions;
window.autoFitLabelText = autoFitLabelText;
window.updateArtButtons = updateArtButtons;

// 7. Asset Managers (Correcte export van de lokale functies)
window.addLabelStyle = addLabelStyle;
window.addLabelFont = addLabelFont;
window.deleteLabelAsset = deleteLabelAsset;
window.loadLabelAssets = loadLabelAssets;