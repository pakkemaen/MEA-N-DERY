// ============================================================================
// label-forge.js
// MEANDERY V2.6
// ============================================================================

import { db, storage } from './firebase-init.js';
import { state, tempState } from './state.js';
import { showToast, performApiCall, logSystemError } from './utils.js';
import { parseIngredientsFromMarkdown } from './brewing.js'; 
import { 
    doc, getDoc, setDoc, updateDoc, collection, addDoc, 
    ref, uploadString, getDownloadURL, deleteObject 
} from './firebase-init.js';

// --- LABEL GENERATOR ENGINE V2.1 (Full Suite) ---
// 1. CONFIGURATIE (Built-in + User)
const builtInLabelFormats = {
    'avery_l7165': { name: 'Avery L7165 (99.1x67.7mm)', width: 99.1, height: 67.7, cols: 2, rows: 4, marginTop: 13, marginLeft: 4.6, gapX: 2.5, gapY: 0 },
    'herma_4453': { name: 'Herma 4453 (105x148mm)', width: 105, height: 148, cols: 2, rows: 2, marginTop: 0, marginLeft: 0, gapX: 0, gapY: 0 },
    'avery_l7163': { name: 'Avery L7163 (99.1x38.1mm)', width: 99.1, height: 38.1, cols: 2, rows: 7, marginTop: 15, marginLeft: 4.6, gapX: 2.5, gapY: 0 }
};

// 2. INITIALISATIE
function populateLabelFontsDropdowns() {
    const ids = ['tuneTitleFont', 'tuneStyleFont', 'tuneSpecsFont', 'tuneDescFont'];
    
    // CENTRALISATIE: Rechtstreekse fallback en initialisatie op de centrale applicatiestate
    if (!state.labelAssets) state.labelAssets = { styles: [], fonts: [] };
    const userFonts = state.labelAssets.fonts || [];

    ids.forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        
        const currentVal = select.value; 
        select.innerHTML = ''; 
        
        if (userFonts.length === 0) {
            const opt = document.createElement('option');
            opt.text = "-- No Fonts in Settings --";
            select.appendChild(opt);
            return;
        }

        userFonts.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.name;
            opt.textContent = f.name;
            opt.style.fontFamily = f.name; 
            select.appendChild(opt);
        });
        
        if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
            select.value = currentVal;
        } else if (select.options.length > 0) {
            select.selectedIndex = 0;
        }
    });
}

function populateLabelStylesDropdown() {
    const select = document.getElementById('labelArtStyle');
    if (!select) return;

    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Use Default Style --</option>';

    // CENTRALISATIE: Lokale variabele gesaneerd naar state.labelAssets.styles
    if (!state.labelAssets) state.labelAssets = { styles: [], fonts: [] };
    const styles = state.labelAssets.styles || [];

    styles.forEach(style => {
        const opt = document.createElement('option');
        opt.value = style.prompt; 
        opt.textContent = style.name;
        select.appendChild(opt);
    });

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
        'tuneDescX', 'tuneDescY', 'tuneDescWidth', 'tuneDescRotate', 'tuneDescSize','tuneDescLineHeight',
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
        else if(id.includes('LineHeight')) disp.textContent = val;
        else if(id.includes('X') || id.includes('Y') || id.includes('Gap') || id.includes('Offset') || (id.includes('Width') && !id.includes('Border'))) disp.textContent = val + '%';
        else disp.textContent = val + 'px';
    }
}

// 3. DATAMANAGEMENT (Laden & Dropdowns)

// A. Receptenlijst vullen
function populateLabelRecipeDropdown() {
    try {
        // --- 1. DOM SELECTOR EXTREME PURIFICATION (camelCase fix) ---
        const dropdown = document.getElementById('labelRecipeSelect');
        if (!dropdown) return;

        // Reset de dropdown naar de initiële stand
        dropdown.innerHTML = '<option value="">-- Selecteer een brouwsel --</option>';

        // Veilig kopiëren van de brouwgeschiedenis via het v2.6 kogelvrije fallback protocol
        const brewsCopy = [...(state.brews || [])];

        // Sorteer de brouwsels op basis van aanmaakdatum (nieuwste eerst)
        brewsCopy.sort((a, b) => {
            const dateA = a.createdAt ? (a.createdAt.seconds || new Date(a.createdAt).getTime()) : 0;
            const dateB = b.createdAt ? (b.createdAt.seconds || new Date(b.createdAt).getTime()) : 0;
            return dateB - dateA;
        });

        // Map de gesorteerde brouwsels naar HTML-opties
        brewsCopy.forEach(brew => {
            if (!brew || !brew.id) return;
            const option = document.createElement('option');
            option.value = brew.id;
            
            const brewName = brew.recipeName || brew.name || 'Naamloos brouwsel';
            
            // --- 2. OBJECT SUB-EIGENSCHAP VARIABELE CORRECTIE ---
            // Herstel van de runtime crash door de niet-gedeclareerde variabele te binden aan het brew-object
            const brewBatch = brew.batchNumber ? ` #${brew.batchNumber}` : '';
            option.textContent = `${brewName}${brewBatch}`;
            
            dropdown.appendChild(option);
        });

    } catch (error) {
        window.logSystemError(error, 'label-forge.js: populateLabelRecipeDropdown Pipeline Failure', 'ERROR');
        window.showToast("Fout bij het laden van de brouwgeschiedenis in de label-keuzelijst.", "error");
    }
}

// B. Label Formaten Laden (Firestore)
async function loadUserLabelFormats() {
    if (!state.userId) return;
    try {
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'labelFormats');
        const docSnap = await getDoc(docRef);
        
        // CENTRALISATIE: Firestore-payload synchroniseren naar de centrale state
        state.userLabelFormats = docSnap.exists() ? (docSnap.data() || {}) : {};
        populateLabelPaperDropdown(); 
    } catch (e) {
        window.logSystemError(e, 'label-forge.js: loadUserLabelFormats', 'ERROR');
        window.showToast("Fout bij het inladen van aangepaste labelformaten.", "error");
    }
}

// C. Papier Dropdown Vullen (Built-in + Custom)
function populateLabelPaperDropdown() {
    const select = document.getElementById('labelPaper');
    if (!select) return;
    
    const currentVal = select.value;
    select.innerHTML = '';
    
    const standardFormats = {
        'avery_l7165': { name: 'Avery L7165 (99.1x67.7mm)' },
        'herma_4453': { name: 'Herma 4453 (105x148mm)' },
        'avery_l7163': { name: 'Avery L7163 (99.1x38.1mm)' }
    };

    const groupBuiltIn = document.createElement('optgroup');
    groupBuiltIn.label = "Standard Formats";
    
    Object.keys(standardFormats).forEach(key => {
        const opt = document.createElement('option');
        opt.value = key; 
        opt.text = standardFormats[key].name;
        groupBuiltIn.appendChild(opt);
    });
    select.appendChild(groupBuiltIn);

    // CENTRALISATIE: Lees custom formaten rechtstreeks uit state.userLabelFormats
    if (!state.userLabelFormats) state.userLabelFormats = {};
    const customKeys = Object.keys(state.userLabelFormats);

    if (customKeys.length > 0) {
        const groupUser = document.createElement('optgroup');
        groupUser.label = "My Custom Formats";
        customKeys.forEach(key => {
            const opt = document.createElement('option');
            opt.value = key; 
            // HERSTEL ACCESSOR: .at(key) vervangen door correcte object-lookup via associatieve array
            opt.text = state.userLabelFormats[key] ? state.userLabelFormats[key].name : 'Unknown Format';
            groupUser.appendChild(opt);
        });
        select.appendChild(groupUser);
    }

    select.onchange = () => {
        const isCustom = state.userLabelFormats.hasOwnProperty(select.value);
        const delBtn = document.getElementById('deleteLabelFormatBtn');
        if(delBtn) delBtn.classList.toggle('hidden', !isCustom);
        if(typeof updateLabelPreviewDimensions === 'function') updateLabelPreviewDimensions();
    };

    if (currentVal && (standardFormats[currentVal] || state.userLabelFormats[currentVal])) {
        select.value = currentVal;
    } else {
        select.value = 'avery_l7165';
    }
    
    if(typeof updateLabelPreviewDimensions === 'function') updateLabelPreviewDimensions();
}

// --- DEZE FUNCTIE PAST DE GROOTTE VAN DE PREVIEW AAN ---
function updateLabelPreviewDimensions() {
    const select = document.getElementById('labelPaper');
    if (!select) return;
    
    const key = select.value;
    if (!state.userLabelFormats) state.userLabelFormats = {};
    const fmt = builtInLabelFormats[key] || state.userLabelFormats[key];
    
    if (fmt) {
        const container = document.getElementById('label-preview-container');
        if (container) {
            container.style.width = fmt.width + 'mm';
            container.style.height = fmt.height + 'mm';
        }
    }
}

// 4. PREVIEW & UI LOGICA

export function updateLabelPreviewText() {
    const activeThemeBtn = document.querySelector('.label-theme-btn.active');
    const theme = activeThemeBtn ? activeThemeBtn.dataset.theme : 'standard';
    setLabelTheme(theme);
}

function updateArtButtons() {
    const actions = document.getElementById('art-actions');
    if (!actions) return;
    // Toon de knoppen 'Save/Clear' alleen als er daadwerkelijk een afbeelding in het geheugen zit
    if (tempState.currentLabelImageSrc && tempState.currentLabelImageSrc.length > 10) {
        actions.classList.remove('hidden');
    } else {
        actions.classList.add('hidden');
    }
}

function loadLabelFromBrew(eOrId, forceTheme = null) {
    const brewId = (typeof eOrId === 'object' && eOrId.target) ? eOrId.target.value : eOrId;
    if (!brewId) return;
    const brew = state.brews.find(b => b.id === brewId);
    if (!brew) return;

    let theme = forceTheme || document.querySelector('.label-theme-btn.active')?.dataset.theme || 'standard';

    const setVal = (id, val) => { const el = document.getElementById(id); if(el) el.value = val; };
    const setText = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
    const setCheck = (id, val) => { const el = document.getElementById(id); if(el) el.checked = val; };
    const restoreSlider = (id, val, fallback) => {
        const el = document.getElementById(id);
        if(el) { el.value = (val !== undefined) ? val : fallback; el.dispatchEvent(new Event('input')); }
    };

    const ings = parseIngredientsFromMarkdown(brew.recipeMarkdown);
    const filteredIngs = ings.filter(i => !/honey|honing|yeast|gist|sulfite|sorbate|lactose/i.test(i.name));
    const generatedDetails = filteredIngs.map(i => i.name).join(' • ');

    let yeastItem = ings.find(i => /yeast|gist/i.test(i.name));
    let generatedYeast = yeastItem ? yeastItem.name.replace(/yeast|gist/gi, '').trim() : 'Unknown';
    let honeyItem = ings.find(i => /honey|honing/i.test(i.name));
    let generatedHoney = honeyItem ? honeyItem.name.replace(/honey/gi, '').trim() : 'Wildflower';

    let s = (brew.labelSettings && brew.labelSettings[theme]) ? brew.labelSettings[theme] : null;

    if (s) {
        setVal('labelTitle', s.title); setVal('labelSubtitle', s.subtitle);
        setVal('labelAbv', s.abv); setVal('labelFg', s.fg); setVal('labelVol', s.vol);
        setVal('labelDate', s.date); setVal('labelDescription', s.desc);
        setVal('labelDetails', s.details || generatedDetails); 
        setVal('labelAllergens', s.allergens || ''); 
        if (s.persona) setVal('label-persona-select', s.persona);
        setCheck('labelShowYeast', s.showYeast); setCheck('labelShowHoney', s.showHoney);
        setCheck('labelShowDetails', s.showDetails);
        
        setText('displayLabelYeast', s.yeastName || generatedYeast);
        setText('displayLabelHoney', s.honeyName || generatedHoney);

        setVal('tuneTitleColor', s.tuneTitleColor); setVal('tuneStyleColor', s.tuneStyleColor);
        restoreSlider('tuneTitleSize', s.tuneTitleSize, 100); 
        restoreSlider('tuneTitleX', s.tuneTitleX, 10);
        restoreSlider('tuneTitleY', s.tuneTitleY, 10);
        restoreSlider('tuneLogoX', s.tuneLogoX, 5); 
        restoreSlider('tuneDescSize', s.tuneDescSize, 10);
        restoreSlider('tuneDescLineHeight', s.tuneDescLineHeight, 1.4);

        if (s.imageSrc) { tempState.currentLabelImageSrc = s.imageSrc; }
    } else {
        // CORRECTIE: Eerst de nul-index isoleren via .at(0), daarna pas .trim() aanroepen om runtime type-errors te elimineren
        const titleFallback = (brew.recipeName || 'Untitled').split(':').at(0).trim();
        setVal('labelTitle', titleFallback);
        setVal('labelAbv', brew.logData?.finalABV?.replace('%','') || brew.logData?.targetABV?.replace('%','') || '');
        setVal('labelFg', brew.logData?.actualFG || brew.logData?.targetFG || '');
        setVal('labelVol', '330'); setVal('labelDate', brew.logData?.brewDate || new Date().toISOString().split('T').at(0));
        
        setText('displayLabelYeast', generatedYeast);
        setText('displayLabelHoney', generatedHoney);

        if (theme === 'standard') {
            setVal('tuneTitleColor', '#8F8C79'); setVal('tuneSpecsColor', '#333333'); setVal('tuneDescColor', '#333333');
            restoreSlider('tuneLogoX', 5); 
        }
    }
    setLabelTheme(theme);
    updateArtButtons();
    
    // UI FLOW OPTIMALISATIE
    window.autoFitLabelText();
}

function autoScaleLabelPreview() {
    const mainContainer = document.querySelector('#labels-view main'); 
    const labelContainer = document.getElementById('label-preview-container'); 

    if (!mainContainer || !labelContainer) return;

    // Reset schaal voor een zuivere meting
    labelContainer.style.transform = 'scale(1)';

    // Beschikbare ruimte met een marge van 40px
    const availableWidth = mainContainer.clientWidth - 40; 
    const availableHeight = mainContainer.clientHeight - 40;
    
    const labelWidth = labelContainer.offsetWidth;
    const labelHeight = labelContainer.offsetHeight;

    if (labelWidth === 0 || labelHeight === 0) return;

    // Bereken de schaalfactor (neem de kleinste ratio zodat hij altijd past)
    const scaleX = availableWidth / labelWidth;
    const scaleY = availableHeight / labelHeight;
    const scale = Math.min(scaleX, scaleY);

    // Pas de transform toe (maximaal 4x vergroting voor scherpte op grote schermen)
    const finalScale = Math.max(0.5, Math.min(scale, 4)); 
    
    labelContainer.style.transform = `scale(${finalScale})`;
    labelContainer.style.transformOrigin = 'center';

    // Update de info tekst linksboven in de preview bak
    const infoText = mainContainer.querySelector('p.absolute');
    if(infoText) infoText.textContent = `Live Preview (Zoom: ${finalScale.toFixed(2)}x)`;
}

// --- THEMA-ENGINE (V4.2, De Single Source of Truth voor de Live Preview) ---
function setLabelTheme(theme) {
    const container = document.getElementById('label-content');
    if (!container) return; 

    // --- 1. DATA COLLECTIE ---
    const getVal = (id) => document.getElementById(id)?.value || '';
    const getCheck = (id) => document.getElementById(id)?.checked || false;
    const getText = (id) => document.getElementById(id)?.textContent || '';

    const title = getVal('labelTitle') || 'MEAD NAME';
    const sub = getVal('labelSubtitle') || 'Style Description';
    const abv = getVal('labelAbv'), fg = getVal('labelFg'), vol = getVal('labelVol');
    const desc = getVal('labelDescription'), allergenText = getVal('labelAllergens');
    const bgColor = getVal('tuneBackgroundColor') || '#ffffff';
    const borderWidth = getVal('tuneBorderWidth') || 0;

    // FIX: Standaard donkergrijs (#333333) voor Standard thema op witte achtergrond
    const specsColor = getVal('tuneSpecsColor') || (theme === 'standard' ? '#333333' : '#ffffff');
    const descColor = getVal('tuneDescColor') || (theme === 'standard' ? '#333333' : '#ffffff');

    // Data uit de verborgen spans (Honing & Gist)
    const hVal = getText('displayLabelHoney'), yVal = getText('displayLabelYeast');
    const honeyText = (getCheck('labelShowHoney') && hVal && hVal !== '--') ? hVal : '';
    const yeastText = (getCheck('labelShowYeast') && yVal && yVal !== '--') ? yVal : '';

    const dateVal = getVal('labelDate') ? new Date(getVal('labelDate')).toLocaleDateString('nl-NL') : '--';
    let imgSrc = tempState.currentLabelImageSrc || '';
    const hasImage = imgSrc && imgSrc.length > 10;

    const splitBySlider = (text, breakVal) => {
       const words = (text || "").split(' ').filter(w => w.trim() !== '');
       if (breakVal >= 8 || breakVal >= words.length) return { l1: text, l2: "", isSplit: false };
       return { l1: words.slice(0, breakVal).join(' '), l2: words.slice(breakVal).join(' '), isSplit: true };
    };

    // --- 2. RENDERING ---
    if (theme === 'standard') {
        const tData = splitBySlider(title, parseInt(getVal('tuneTitleBreak')) || 8);
        const specsAlign = getVal('tuneSpecsAlign') || 'center';
        
        container.innerHTML = `
            <div class="absolute inset-0 z-50 pointer-events-none" style="box-shadow: inset 0 0 0 ${borderWidth}mm white;"></div>
            
            <div class="relative h-full w-[30%] bg-gray-50/90 z-20 border-r border-gray-200" style="font-family: '${getVal('tuneSpecsFont')}', sans-serif;">
                <div class="absolute" style="top: ${getVal('tuneDescY')}%; left: ${getVal('tuneDescX')}%; width: ${getVal('tuneDescWidth')}%; transform: translate(-50%, 0) rotate(${getVal('tuneDescRotate')}deg); font-size: ${getVal('tuneDescSize')}px; color: ${descColor}; text-align: ${getVal('tuneDescAlign')}; line-height: ${getVal('tuneDescLineHeight')};">
                    ${desc}
                </div>
                
                <div class="absolute flex flex-col items-${specsAlign}" style="top: ${getVal('tuneSpecsY')}%; left: ${getVal('tuneSpecsX')}%; width: 90%; transform: translate(-50%, -50%) rotate(${getVal('tuneSpecsRotate')}deg); font-size: ${getVal('tuneSpecsSize')}px; color: ${specsColor};">
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

                <div class="absolute z-20" style="top: ${getVal('tuneLogoY')}%; right: ${getVal('tuneLogoX')}%; transform: rotate(${getVal('tuneLogoRotate')}deg); width: ${getVal('tuneLogoSize')}px; opacity: ${getVal('tuneLogoOpacity')};">
                    ${getCheck('logoColorMode') ? `<div style="width:100%; height:100%; background-color:${getVal('tuneLogoColor')}; -webkit-mask:url(logo.png) center/contain no-repeat; mask:url(logo.png) center/contain no-repeat;"></div>` : `<img src="logo.png" class="w-full h-auto">`}
                </div>
            </div>
        `;
    } else {
        const tData = splitBySlider(title, parseInt(getVal('tuneTitleBreak')) || 8);
        container.innerHTML = `
            ${hasImage ? `<img src="${imgSrc}" class="absolute inset-0 w-full h-full object-cover" style="left: ${getVal('tuneArtX')}%; top: ${getVal('tuneArtY')}%; transform: translate(-50%, -50%) scale(${getVal('tuneArtZoom')}); opacity: ${getVal('tuneArtOpacity')};">` : `<div class="absolute inset-0" style="background-color: ${bgColor};"></div>`}
            <div class="absolute inset-0 z-50 pointer-events-none" style="box-shadow: inset 0 0 0 ${borderWidth}mm white;"></div>
            <div class="absolute z-10 w-max" style="top: ${getVal('tuneTitleY')}%; left: ${getVal('tuneTitleX')}%; transform: translate(-50%, -50%) rotate(${getVal('tuneTitleRotate')}deg); text-align: center;">
                <h1 style="font-size: ${getVal('tuneTitleSize')}px; color: ${getVal('tuneTitleColor')}; font-family: '${getVal('tuneTitleFont')}', sans-serif;" class="font-bold uppercase tracking-widest leading-none drop-shadow-lg">${tData.l1}</h1>
            </div>
            <div class="absolute z-10" style="top: ${getVal('tuneDescY')}%; left: ${getVal('tuneDescX')}%; width: ${getVal('tuneDescWidth')}%; transform: translate(-50%, -50%) rotate(${getVal('tuneDescRotate')}deg); text-align: ${getVal('tuneDescAlign')};">
                <p style="font-size: ${getVal('tuneDescSize')}px; line-height: ${getVal('tuneDescLineHeight')}; color: ${descColor}; font-family: '${getVal('tuneDescFont')}', serif;" class="italic leading-tight drop-shadow-md">${desc}</p>
            </div>
            <div class="absolute z-10" style="left: ${getVal('tuneSpecsX')}%; top: ${getVal('tuneSpecsY')}%; transform: translate(-50%, -50%) rotate(${getVal('tuneSpecsRotate')}deg);">
                <div style="font-size: ${getVal('tuneSpecsSize')}px; color: ${specsColor};">
                    <div class="grid grid-cols-2 gap-x-3 mb-1 font-bold font-mono"><span>ABV</span> <span>${abv}%</span> ${fg ? `<span>FG</span> <span>${fg}</span>` : ''} <span>Vol</span> <span>${vol}ml</span></div>
                    ${honeyText || yeastText ? `<div class="mb-1 border-t border-white/20 pt-1 font-sans uppercase text-[0.8em]">${honeyText ? `Honey: ${honeyText}<br>` : ''}${yeastText ? `Yeast: ${yeastText}` : ''}</div>` : ''}
                </div>
            </div>
            <div class="absolute z-20" style="top: ${getVal('tuneLogoY')}%; right: ${getVal('tuneLogoX')}%; width: ${getVal('tuneLogoSize')}px; transform: rotate(${getVal('tuneLogoRotate')}deg);">
                 <img src="logo.png" class="w-full h-auto filter brightness-110 drop-shadow-xl">
            </div>
        `;
    }

    // Trigger scaling na render
    autoScaleLabelPreview();
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
async function saveCustomLabelFormat() {
    try {
        const idInput = document.getElementById('lf-name'); 
        const nameInput = document.getElementById('lf-name');
        const widthInput = document.getElementById('lf-width');
        const heightInput = document.getElementById('lf-height');
        const colsInput = document.getElementById('lf-cols');
        const rowsInput = document.getElementById('lf-rows');
        const marginTopInput = document.getElementById('lf-marginTop');
        const marginLeftInput = document.getElementById('lf-marginLeft');
        const gapXInput = document.getElementById('lf-gapX');
        const gapYInput = document.getElementById('lf-gapY');

        if (!idInput || !widthInput || !heightInput || !colsInput || !rowsInput) {
            window.showToast("Formulerelementen (lf-specifieke IDs) niet gevonden in de DOM.", "error");
            return;
        }

        const formatId = idInput.value.trim().toLowerCase().replace(/\s+/g, '_');
        const formatName = nameInput.value.trim();

        if (!formatId || !formatName) {
            window.showToast("Vul een geldige naam of code in om het formaat te identificeren.", "error");
            return;
        }

        const sanitizeAndParse = (inputEl, isInt = false) => {
            if (!inputEl) return 0;
            const cleanStr = String(inputEl.value).replace(/,/g, '.');
            return isInt ? (parseInt(cleanStr, 10) || 0) : (parseFloat(cleanStr) || 0);
        };

        const width = sanitizeAndParse(widthInput);
        const height = sanitizeAndParse(heightInput);
        const cols = sanitizeAndParse(colsInput, true);
        const rows = sanitizeAndParse(rowsInput, true);
        const marginTop = sanitizeAndParse(marginTopInput);
        const marginLeft = sanitizeAndParse(marginLeftInput);
        const gapX = sanitizeAndParse(gapXInput);
        const gapY = sanitizeAndParse(gapYInput);

        if (width <= 0 || height <= 0 || cols <= 0 || rows <= 0) {
            window.showToast("Afmetingen, kolommen en rijen moeten groter zijn dan 0.", "error");
            return;
        }

        const customFormatData = {
            name: formatName,
            width: width,
            height: height,
            cols: cols,
            rows: rows,
            marginTop: marginTop,
            marginLeft: marginLeft,
            gapX: gapX,
            gapY: gapY
        };

        if (!state.userId) {
            window.showToast("Gebruiker is niet ingelogd. Kan formaat niet opslaan.", "error");
            return;
        }

        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'labelFormats');
        const fieldPath = `${formatId}`;
        
        await updateDoc(docRef, { [fieldPath]: customFormatData })
            .catch(async () => {
                await setDoc(docRef, { [formatId]: customFormatData }, { merge: true });
            });

        // CENTRALISATIE: Rechtstreeks de globale applicatiestate muteren
        if (!state.userLabelFormats) state.userLabelFormats = {};
        state.userLabelFormats[formatId] = customFormatData;
        populateLabelPaperDropdown();

        window.showToast(`Aangepast formaat '${formatName}' succesvol gesynchroniseerd!`, "success");
        document.getElementById('label-format-modal').classList.add('hidden');

    } catch (error) {
        window.logSystemError(error, 'LabelForge: Save Format', 'ERROR');
        window.showToast("Fout bij het opslaan van het aangepaste labelformaat.", "error");
    }
}

// --- VERWIJDEREN CUSTOM FORMAAT (VERBETERD) ---
window.deleteCustomLabelFormat = async function() {
    const select = document.getElementById('labelPaper');
    const id = select ? select.value : '';

    if (!state.userLabelFormats || !state.userLabelFormats[id]) {
        showToast("Cannot delete standard formats.", "error");
        return;
    }

    if (!confirm(`Are you sure you want to delete "${state.userLabelFormats[id].name}"?`)) return;

    const originalName = state.userLabelFormats[id].name;

    try {
        delete state.userLabelFormats[id];
        
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'labelFormats');
        await setDoc(docRef, state.userLabelFormats);

        populateLabelPaperDropdown(); 
        
        if (select) select.value = 'avery_l7165';
        document.getElementById('label-format-modal').classList.add('hidden');
        showToast(`Format "${originalName}" deleted.`, "success");
    } catch (e) {
        window.logSystemError(e, 'label-forge.js: deleteCustomLabelFormat', 'ERROR');
        showToast("Fout bij het verwijderen van het labelformaat uit de database.", "error");
    }
};

// 6. AI CONTENT & ART GENERATORS

function handleLogoUpload(event) {
    try {
        if (!event || !event.target || !event.target.files) return;
        
        // CHAT PARSING BUG PREVENTIE: .item(0) in plaats van vierkante haken voor FileList objecten
        const file = event.target.files.item(0);
        if (file) {
            const reader = new FileReader();
            reader.onload = function(e) {
                if (!e || !e.target) return;
                
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

                if (typeof window.updateArtButtons === 'function') {
                    window.updateArtButtons();
                }
            };
            reader.readAsDataURL(file);
        }
    } catch (error) {
        window.logSystemError(error, 'label-forge.js: handleLogoUpload', 'ERROR');
        window.showToast("Fout bij het uploaden van het logo.", "error");
    }
}

// --- GENERATE LABEL ART (V5.1 - SAFE QUALITY BOOST) ---
async function generateLabelArt() {
    try {
        const promptInput = document.getElementById('label_art_prompt');
        if (!promptInput || !promptInput.value.trim()) {
            window.showToast("Voer eerst een omschrijving of prompt in voor de AI.", "error");
            return;
        }

        const prompt = promptInput.value.trim();
        const generateBtn = document.getElementById('btn_generate_label_art');
        if (generateBtn) generateBtn.disabled = true;

        window.showToast("AI genereert labelkunst, een moment geduld...", "info");

        // HERSTEL API HANDSHAKE: Rechtstreekse fetch-operatie naar Google predict-URL conform tools.js
        let apiKey = state.userSettings?.apiKey;
        if (!apiKey && typeof window.CONFIG !== 'undefined' && window.CONFIG.firebase) {
            apiKey = window.CONFIG.firebase.apiKey;
        }
        if (!apiKey) {
            throw new Error("Geen geldige API Key gevonden in de systeeminstellingen.");
        }

        const model = state.userSettings?.imageModel || "imagen-3.0-generate-001";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;

        const requestBody = {
            instances: [{ prompt: prompt }],
            parameters: { sampleCount: 1, aspectRatio: "1:1" }
        };

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error?.message || `Google Image API Status Error: ${response.status}`);
        }

        const data = await response.json();
        
        // CHAT PARSING SAFE GUARD: .at(0) gebruikt voor extractie van de predictions array
        if (data && data.predictions && data.predictions.length > 0) {
            const firstPrediction = data.predictions.at(0);
            if (firstPrediction && firstPrediction.bytesBase64Encoded) {
                const base64Data = firstPrediction.bytesBase64Encoded;
                const imgDataUrl = `data:image/png;base64,${base64Data}`;
                
                tempState.currentLabelImageSrc = imgDataUrl;
                
                const imgDisplay = document.getElementById('label-img-display');
                if (imgDisplay) {
                    imgDisplay.src = imgDataUrl;
                    imgDisplay.classList.remove('hidden');
                }
                const placeholder = document.getElementById('label-img-placeholder');
                if (placeholder) placeholder.classList.add('hidden');
                
                const activeThemeBtn = document.querySelector('.label-theme-btn.active');
                const theme = activeThemeBtn ? activeThemeBtn.dataset.theme : 'standard';
                setLabelTheme(theme);
                
                window.updateArtButtons();
                window.showToast("Labelkunst succesvol gegenereerd!", "success");
            } else {
                throw new Error("Eigenschap 'bytesBase64Encoded' ontbreekt in de eerste prediction.");
            }
        } else {
            throw new Error("Geen afbeeldingsdata ontvangen van de Google Image API.");
        }

    } catch (error) {
        window.logSystemError(error, 'LabelForge: Generate Art', 'ERROR');
        window.showToast("Fout tijdens het genereren van de labelkunst.", "error");
    } finally {
        const generateBtn = document.getElementById('btn_generate_label_art');
        if (generateBtn) generateBtn.disabled = false;
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
    } catch (error) {
        // CENTRALISATIE: Hersteld naar formeel logframework met toast notificatie
        window.logSystemError(error, 'LabelForge: Save Art To Cloud', 'ERROR');
        window.showToast("Upload naar de Cloud-Galerij mislukt: " + error.message, "error");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
};

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

    try {
        const q = query(collection(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'gallery'));
        
        // Gecentraliseerde realtime listener met v2.6 safe-guards
        onSnapshot(q, (snapshot) => {
            if (snapshot.empty) {
                grid.innerHTML = `<div class="col-span-full text-center py-10 text-app-secondary opacity-60 flex flex-col items-center gap-2"><span class="text-4xl">📂</span><p>Gallery is empty.<br>Save your creations to see them here.</p></div>`;
                return;
            }

            // Sorteer op nieuwste eerst via deterministische datumberekening
            const arts = snapshot.docs.map(doc => ({id: doc.id, ...doc.data()}))
                                      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            grid.innerHTML = arts.map(art => `
                <div class="relative group aspect-square rounded-2xl overflow-hidden border border-outline-variant bg-surface-container cursor-pointer shadow-sm hover:shadow-elevation-2 transition-all hover:scale-[1.02]">
                    <img src="${art.imageSrc}" class="w-full h-full object-cover transition-opacity duration-300" onclick="window.selectFromGallery('${art.imageSrc}')">
                    
                    <div class="absolute bottom-0 left-0 right-0 bg-surface-container/90 backdrop-blur-sm p-2 border-t border-outline-variant flex justify-between items-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <span class="text-[10px] font-bold text-on-surface truncate pr-2">${art.name}</span>
                        <button onclick="window.deleteFromGallery('${art.id}', '${art.storagePath || ''}')" class="text-error hover:text-red-700 font-bold px-2">&times;</button>
                    </div>
                </div>
            `).join('');
        }, (error) => {
            // Sanisatie van de inner onSnapshot-fouten
            window.logSystemError(error, 'LabelForge: Gallery onSnapshot', 'ERROR');
            window.showToast("Fout bij het live bijwerken van de galerij.", "error");
        });
    } catch (error) {
        window.logSystemError(error, 'LabelForge: Gallery Loader', 'ERROR');
        window.showToast("Fout bij het inladen van de galerij.", "error");
    }
};

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
        if (storagePath) {
            const fileRef = ref(storage, storagePath);
            await deleteObject(fileRef).catch(err => {
                window.logSystemError(err, 'label-forge.js: deleteFromGallery [Storage]', 'WARN');
            });
        }

        await deleteDoc(doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'gallery', docId));
        showToast("Artwork deleted.", "success");
    } catch(e) {
        // Saniteer Catch-blokken naar gecentraliseerd framework
        window.logSystemError(e, 'label-forge.js: deleteFromGallery', 'ERROR');
        showToast("Delete failed: " + e.message, "error");
    }
}

// AI Label Schrijver (CRASH PROOF & MET PERSONA)
async function generateLabelDescription() {
    const getVal = (id) => document.getElementById(id)?.value || '';
    
    const title = getVal('labelTitle');
    const style = getVal('labelSubtitle');
    const ingredients = getVal('labelDetails');
    const persona = getVal('label-persona-select');
    
    if (!title) return showToast("Enter a title first.", "error");
    
    const btn = document.getElementById('ai-label-desc-btn');
    let originalText = "";
    if (btn) {
        originalText = btn.innerHTML;
        btn.innerHTML = "Thinking...";
        btn.disabled = true;
    }
    
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
        default:
            toneInstruction = `**TONE: MODERN CRAFT.** Punchy, witty, slightly cynical/dark humor (e.g. "Liquid decay"). Modern branding style. Short sentences.`;
            break;
    }

    const prompt = `Write a short "back-of-bottle" description (max 30 words) for a Mead called "${title}".
    
    **CONTEXT:**
    - Style: ${style}
    - Key Ingredients: ${ingredients}
    
    ${toneInstruction}
    
    **CONSTRAINT:** Max 25 words. Make it fit on a small label.
    Output ONLY the text. No quotes.`;
    
    try {
        const text = await performApiCall(prompt);
        
        const descField = document.getElementById('labelDescription');
        if (descField) {
            // CHAT PARSING SAFE GUARD: Veilige parsing en string-opschoning via .at(0)
            const cleanText = text.replace(/^["']|["']$/g, '').split('\n').at(0).trim();
            descField.value = cleanText;
            updateLabelPreviewText();
        }
    } catch (error) {
        window.logSystemError(error, 'LabelForge: AI Description Generator', 'ERROR');
        window.showToast("AI Schrijver mislukt. Probeer het opnieuw.", "error");
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }
}

// 7. PRINT ENGINE (Dynamic Grid)
function printLabelsSheet() {
    const key = document.getElementById('labelPaper').value;
    if (!state.userLabelFormats) state.userLabelFormats = {};
    const fmt = builtInLabelFormats[key] || state.userLabelFormats[key];
    if(!fmt) return showToast("Select a valid paper format.", "error");

    const labelContent = document.getElementById('label-content').innerHTML;
    const totalLabels = fmt.cols * fmt.rows;
    const imageSrc = tempState.currentLabelImageSrc || '';
    
    const titleFont = document.getElementById('tuneTitleFont')?.value || 'Barlow Semi Condensed';
    const fontQuery = titleFont.trim().replace(/\s+/g, '+');
    const googleFontLink = `<link href="https://fonts.googleapis.com/css2?family=${fontQuery}:wght@400;700&display=swap" rel="stylesheet">`;

    const win = window.open('', '_blank');
    if (!win) return showToast("Pop-up blocked! Please allow pop-ups to print.", "error");

    win.document.write(`
        <html><head><title>Meandery Print Engine</title>
        <script src="https://cdn.tailwindcss.com"></script>
        ${googleFontLink}
        <style>
            @page { size: A4; margin: 0; }
            body { margin: 0; padding: 0; width: 210mm; height: 297mm; background: white; -webkit-print-color-adjust: exact; }
            .sheet { 
                display: grid;
                grid-template-columns: repeat(${fmt.cols}, ${fmt.width}mm);
                grid-template-rows: repeat(${fmt.rows}, ${fmt.height}mm);
                column-gap: ${fmt.gapX}mm;
                row-gap: ${fmt.gapY}mm;
                padding-top: ${fmt.marginTop}mm;
                padding-left: ${fmt.marginLeft}mm;
                box-sizing: border-box;
            }
            .label-cell { 
                width: ${fmt.width}mm; 
                height: ${fmt.height}mm; 
                position: relative;
                overflow: hidden; 
                border: 0.1mm dashed #eee; 
            }
            @media print { .label-cell { border: none; } }
            .label-cell #label-content { width: 100% !important; height: 100% !important; position: absolute !important; transform: none !important; }
        </style>
        </head><body>
        <div class="sheet">
            ${Array(totalLabels).fill(`<div class="label-cell"><div id="label-content">${labelContent}</div></div>`).join('')}
        </div>
        <script>
            window.onload = () => {
                const src = "${imageSrc}";
                if(src) {
                    document.querySelectorAll('.label-cell img').forEach(img => {
                        img.setAttribute('crossorigin', 'anonymous');
                        img.src = src;
                        img.classList.remove('hidden');
                    });
                }
                setTimeout(() => { window.print(); }, 1500);
            };
        </script>
        </body></html>
    `);
    win.document.close();
}

// --- LABEL OPSLAAN FUNCTIE (V3.5 - FULL INTEGRITY & LOGGING) ---
window.saveLabelToBrew = async function() {
    const select = document.getElementById('labelRecipeSelect');
    const brewId = select?.value; 
    
    if (!brewId) return showToast("Select a recipe first.", "error");
    if (!state.userId) return showToast("User not authenticated.", "error");

    const btn = document.querySelector('button[onclick="window.saveLabelToBrew()"]');
    const originalText = btn ? btn.innerHTML : 'Save';
    if (btn) { btn.innerHTML = "Saving..."; btn.disabled = true; }

    try {
        const getVal = (id) => { 
            const el = document.getElementById(id); 
            if (!el) return '';
            if (el.type === 'number' || el.type === 'range') {
                return el.value.toString().replace(',', '.');
            }
            return el.value;
        };
        const getCheck = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
        const getText = (id) => { const el = document.getElementById(id); return el ? el.textContent : ''; };

        const activeBtn = document.querySelector('.label-theme-btn.active');
        const currentTheme = activeBtn ? activeBtn.dataset.theme : 'standard';

        let finalImageSrc = tempState.currentLabelImageSrc || '';
        if (finalImageSrc.startsWith('data:image')) {
            if (btn) btn.innerHTML = "Uploading Art..."; 
            const storagePath = `users/${state.userId}/labels/art_${Date.now()}.png`;
            const storageRef = ref(storage, storagePath);
            await uploadString(storageRef, finalImageSrc, 'data_url');
            finalImageSrc = await getDownloadURL(storageRef);
            tempState.currentLabelImageSrc = finalImageSrc;
        }

        if (btn) btn.innerHTML = "Saving Data...";

        const rawSettings = {
            title: getVal('labelTitle'),
            subtitle: getVal('labelSubtitle'),
            abv: getVal('labelAbv'),
            fg: getVal('labelFg'),
            vol: getVal('labelVol'),
            date: getVal('labelDate'),
            desc: getVal('labelDescription'),
            details: getVal('labelDetails'),
            persona: getVal('label-persona-select'),
            allergens: getVal('labelAllergens'),
            
            showYeast: getCheck('labelShowYeast'),
            showHoney: getCheck('labelShowHoney'),
            showDetails: getCheck('labelShowDetails'),
            yeastName: getText('displayLabelYeast'),
            honeyName: getText('displayLabelHoney'),

            tuneTitleSize: getVal('tuneTitleSize'),
            tuneTitleSize2: getVal('tuneTitleSize2'),
            tuneTitleX: getVal('tuneTitleX'),
            tuneTitleY: getVal('tuneTitleY'),
            tuneTitleColor: getVal('tuneTitleColor'),
            tuneTitleRotate: getVal('tuneTitleRotate'),
            tuneTitleOffset: getVal('tuneTitleOffset'),
            tuneTitleOffsetY: getVal('tuneTitleOffsetY'),
            tuneTitleBreak: getVal('tuneTitleBreak'),
            tuneTitleFont: getVal('tuneTitleFont'),
            
            tuneStyleY: getVal('tuneStyleY'),
            tuneStyleSize: getVal('tuneStyleSize'),
            tuneStyleSize2: getVal('tuneStyleSize2'),
            tuneStyleGap: getVal('tuneStyleGap'),
            tuneStyleOffsetY: getVal('tuneStyleOffsetY'),
            tuneStyleColor: getVal('tuneStyleColor'),
            tuneStyleRotate: getVal('tuneStyleRotate'),
            tuneStyleOffset: getVal('tuneStyleOffset'),
            tuneStyleBreak: getVal('tuneStyleBreak'),
            tuneStyleFont: getVal('tuneStyleFont'),
            
            tuneSpecsSize: getVal('tuneSpecsSize'),
            tuneSpecsX: getVal('tuneSpecsX'),
            tuneSpecsY: getVal('tuneSpecsY'),
            tuneSpecsColor: getVal('tuneSpecsColor'),
            tuneSpecsRotate: getVal('tuneSpecsRotate'),
            tuneSpecsAlign: getVal('tuneSpecsAlign'),
            tuneSpecsFont: getVal('tuneSpecsFont'),
            tuneAllergenColor: getVal('tuneAllergenColor'),

            tuneDescX: getVal('tuneDescX'),
            tuneDescY: getVal('tuneDescY'),
            tuneDescWidth: getVal('tuneDescWidth'),
            tuneDescRotate: getVal('tuneDescRotate'),
            tuneDescSize: getVal('tuneDescSize'),
            tuneDescColor: getVal('tuneDescColor'),
            tuneDescAlign: getVal('tuneDescAlign'),
            tuneDescLineHeight: getVal('tuneDescLineHeight'),
            tuneDescFont: getVal('tuneDescFont'),
            
            tuneArtZoom: getVal('tuneArtZoom'),
            tuneArtX: getVal('tuneArtX'),
            tuneArtY: getVal('tuneArtY'),
            tuneArtOpacity: getVal('tuneArtOpacity'),
            tuneArtRotate: getVal('tuneArtRotate'),
            tuneArtOverlay: getVal('tuneArtOverlay'),
            
            tuneLogoSize: getVal('tuneLogoSize'),
            tuneLogoX: getVal('tuneLogoX'),
            tuneLogoY: getVal('tuneLogoY'),
            tuneLogoRotate: getVal('tuneLogoRotate'),
            tuneLogoOpacity: getVal('tuneLogoOpacity'),
            logoColorMode: getCheck('logoColorMode'),
            tuneLogoColor: getVal('tuneLogoColor'),

            tuneBorderWidth: getVal('tuneBorderWidth'),
            tuneBackgroundColor: getVal('tuneBackgroundColor'),
            labelShowGuides: getCheck('labelShowGuides'),
            labelShowBorder: getCheck('labelShowBorder'),
            
            imageSrc: finalImageSrc 
        };

        const specificSettings = JSON.parse(JSON.stringify(rawSettings));
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'brews', brewId);
        
        const docSnap = await getDoc(docRef);
        let currentData = docSnap.exists() ? docSnap.data() : {};
        
        if (currentData.labelSettings && Array.isArray(currentData.labelSettings)) {
            window.logSystemError('Corrupt Data Detected: labelSettings is an Array. Converting...', 'LabelForge: Self Healing', 'WARN');
            await updateDoc(docRef, { labelSettings: {} });
        }

        const fieldPath = `labelSettings.${currentTheme}`;
        
        if (docSnap.exists()) {
            await updateDoc(docRef, { [fieldPath]: specificSettings });
        } else {
            await setDoc(docRef, { labelSettings: { [currentTheme]: specificSettings } }, { merge: true });
        }

        // CHAT PARSING SAFE GUARD: Veilige array-mutatie via .findIndex en state-centralisatie
        const brewIndex = state.brews.findIndex(b => b.id === brewId);
        if (brewIndex > -1) {
            const targetBrew = state.brews.at(brewIndex);
            if (!targetBrew.labelSettings || Array.isArray(targetBrew.labelSettings)) {
                targetBrew.labelSettings = {};
            }
            targetBrew.labelSettings[currentTheme] = specificSettings;
        }

        showToast(`${currentTheme.toUpperCase()} label saved successfully!`, "success");
    } catch (error) {
        window.logSystemError(error, 'LabelForge: Save Label To Brew', 'ERROR');
        showToast("Opslaan van het etiket is mislukt: " + error.message, "error");
    } finally {
        if (btn) { btn.innerHTML = originalText; btn.disabled = false; }
    }
};

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

async function addLabelStyle() {
    const nameInput = document.getElementById('newStyleName');
    const promptInput = document.getElementById('newStylePrompt');
    const btn = document.getElementById('addStyleBtn');

    if (!nameInput || !promptInput || !btn) return;

    const name = nameInput.value.trim();
    const prompt = promptInput.value.trim();

    if (!name || !prompt) {
        window.showToast("Vul eerst een Naam én een Prompt in.", "error");
        return;
    }

    const originalText = btn.innerText;
    btn.innerText = "...";
    btn.disabled = true;

    try {
        // CENTRALISATIE: Rechtstreeks pushen naar de gecentraliseerde state.labelAssets array
        if (!state.labelAssets) state.labelAssets = { styles: [], fonts: [] };
        if (!state.labelAssets.styles) state.labelAssets.styles = [];
        
        state.labelAssets.styles.push({
            id: 'style_' + Date.now(),
            name: name,
            prompt: prompt
        });

        await saveLabelAssets();

        if (typeof renderLabelAssetsSettings === 'function') {
            renderLabelAssetsSettings();
        }
        if (typeof populateLabelStylesDropdown === 'function') {
            populateLabelStylesDropdown();
        }

        nameInput.value = '';
        promptInput.value = '';
        window.showToast(`Stijl "${name}" toegevoegd!`, "success");

    } catch (error) {
        // ERROR HANDLING RESTORATION: Foutmelding correct gesaniteerd en doorgegeven met formele context-omschrijving
        window.logSystemError(error, 'label-forge.js: addLabelStyle', 'ERROR');
        window.showToast("Fout bij het toevoegen van de art style.", "error");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

// 1. DATA LADEN 
async function loadLabelAssets() {
    try {
        if (!state.userId) return;
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'labelAssets');
        const snap = await getDoc(docRef);
        
        if (!state.labelAssets) state.labelAssets = { styles: [], fonts: [] };
        if (snap.exists()) {
            const data = snap.data();
            
            // CENTRALISATIE & PERSISTENTIE: Volledige data-synchronisatie met de centrale applicatiestate
            state.labelAssets.styles = data.styles || [];
            state.labelAssets.fonts = data.fonts || [];
            
            if (data.customLogoSrc) {
                tempState.customLogoSrc = data.customLogoSrc;
                const logoPreview = document.getElementById('logo-preview-img');
                if (logoPreview) {
                    logoPreview.src = data.customLogoSrc;
                    logoPreview.classList.remove('hidden');
                }
            }
        }
    } catch (error) {
        // SANISATIE: Rauwe console.error omgebouwd naar gecentraliseerd loggen en toast notificatie
        window.logSystemError(error, 'LabelForge: Load Assets', 'ERROR');
        window.showToast("Fout bij het inladen van de label-assets.", "error");
    }
}

// 2. GOOGLE FONTS INLADEN (Dynamisch & Robuust)
function loadGoogleFontsInHeader() {
    if (!state.labelAssets || !state.labelAssets.fonts) return;

    state.labelAssets.fonts.forEach(font => {
        const fontQuery = font.name.trim().replace(/\s+/g, '+'); 
        const id = `font-link-${font.name.replace(/\s+/g, '-')}`; 
        
        if (!document.getElementById(id)) {
            const link = document.createElement('link');
            link.id = id;
            link.rel = 'stylesheet';
            link.href = `https://fonts.googleapis.com/css2?family=${fontQuery}:wght@400;700&display=swap`;
            document.head.appendChild(link);
        }
    });
}

// 3. UI RENDEREN (In Settings Scherm)
function renderLabelAssetsSettings() {
    const stylesList = document.getElementById('settings-styles-list');
    const fontsList = document.getElementById('settings-fonts-list');
    
    if (!state.labelAssets) state.labelAssets = { styles: [], fonts: [] };
    const currentStyles = state.labelAssets.styles || [];
    const currentFonts = state.labelAssets.fonts || [];
    
    if (stylesList) {
        stylesList.innerHTML = currentStyles.map((s, idx) => `
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

    if (fontsList) {
        fontsList.innerHTML = currentFonts.map((f, idx) => `
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

        const isExactValid = await isValidGoogleFont(rawName);

        if (isExactValid) {
            finalName = rawName;
        } else {
            const fixedName = rawName.replace(/([a-z])([A-Z])/g, '$1 $2');
            window.logSystemError(`Exact match failed for '${rawName}'. Trying '${fixedName}'...`, 'LabelForge: Font Autocorrect', 'INFO');
            
            const isFixedValid = await isValidGoogleFont(fixedName);
            if (isFixedValid) {
                finalName = fixedName;
                autoCorrected = true;
            }
        }

        if (!finalName) {
            throw new Error(`Font "${rawName}" not found on Google Fonts. Check spelling.`);
        }

        // CENTRALISATIE: Duplicatencontrole rechtstreeks uitvoeren op state.labelAssets.fonts
        if (!state.labelAssets) state.labelAssets = { styles: [], fonts: [] };
        if (!state.labelAssets.fonts) state.labelAssets.fonts = [];
        
        if (state.labelAssets.fonts.some(f => f.name.toLowerCase() === finalName.toLowerCase())) {
            throw new Error("This font is already in your list.");
        }

        state.labelAssets.fonts.push({ id: Date.now().toString(), name: finalName });
        await saveLabelAssets();
        
        loadGoogleFontsInHeader(); 
        populateLabelFontsDropdowns(); 
        input.value = '';
        
        if (autoCorrected) {
            showToast(`Auto-corrected to "${finalName}" and saved!`, "success");
        } else {
            showToast(`"${finalName}" added successfully!`, "success");
        }

    } catch (error) {
        window.logSystemError(error, 'LabelForge: Add Font Asset', 'ERROR');
        window.showToast("Fout bij het toevoegen van het Google Font: " + error.message, "error");
        input.classList.add('border-red-500', 'ring-1', 'ring-red-500');
        setTimeout(() => input.classList.remove('border-red-500', 'ring-1', 'ring-red-500'), 2000);
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
};

window.deleteLabelAsset = async function(type, index) {
    if(!confirm("Verwijderen?")) return;
    if (state.labelAssets && state.labelAssets[type]) {
        state.labelAssets[type].splice(index, 1);
        await saveLabelAssets();
    }
};

async function saveLabelAssets(logoSrc = null) {
    try {
        if (!state.userId) return;
        const docRef = doc(db, 'artifacts', 'meandery-aa05e', 'users', state.userId, 'settings', 'labelAssets');
        
        if (!state.labelAssets) state.labelAssets = { styles: [], fonts: [] };
        const payload = {
            styles: state.labelAssets.styles || [],
            fonts: state.labelAssets.fonts || []
        };
        
        if (logoSrc) {
            payload.customLogoSrc = logoSrc;
            tempState.customLogoSrc = logoSrc;
        } else if (tempState.customLogoSrc) {
            payload.customLogoSrc = tempState.customLogoSrc;
        }
        
        await setDoc(docRef, payload, { merge: true });
        window.showToast("Label assets succesvol gesynchroniseerd med de database.", "success");
    } catch (error) {
        // SANISATIE: Rauwe console.error omgebouwd naar gecentraliseerd loggen en toast notificatie
        window.logSystemError(error, 'LabelForge: Save Assets', 'ERROR');
        window.showToast("Fout bij het opslaan van de label-assets.", "error");
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

// 6. Helpers en Asset Managers (Gezuiverde unieke toewijzingen)
window.populateLabelRecipeDropdown = populateLabelRecipeDropdown;
window.updateLabelPreviewDimensions = updateLabelPreviewDimensions;
window.autoFitLabelText = autoFitLabelText;
window.updateArtButtons = updateArtButtons;
window.addLabelStyle = addLabelStyle;
window.addLabelFont = addLabelFont;
window.deleteLabelAsset = deleteLabelAsset;
window.resetLabelLayout = resetLabelLayout;