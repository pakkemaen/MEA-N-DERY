// ============================================================================
// state.js
// Single Source of Truth
// ============================================================================

// 1. GLOBAL STATE (Data die gesynct wordt met Firebase of app-breed is)
export const state = {
    // Auth & User
    userId: null,
    userSettings: {
        apiKey: "",           // Google AI Key
        aiModel: "gemini-2.5-flash", 
        currency: "€",
        theme: "light",       // 'light' of 'dark'
        defaultBatchSize: 5   // in Liters
    },

    // Core Data Collections
    brews: [],                // Volledige brouwgeschiedenis
    inventory: [],            // Huidige voorraad
    cellar: [],               // Flessen in de kelder
    packagingCosts: {},
    
    // Profielen & Assets
    equipmentProfiles: [],    // Ketels, flessen, etc.
    waterProfiles: [],        // Waterchemie profielen
    
    // Label Studio Assets
    labelAssets: {
        savedStyles: [],      // Custom AI prompts voor labels
        savedFonts: []        // Google Fonts die de user heeft toegevoegd
    }
};

// 2. TEMPORARY STATE (Vluchtige UI data, niet opslaan in DB)
export const tempState = {
    // Huidige sessie acties
    currentRecipe: null,      // Het recept dat nu in de editor staat
    activeBrewId: null,       // ID van de batch die we nu bekijken
    
    // Tools status
    isScannerActive: false,   // Staat de camera aan?
    lastCalculatedABV: null,  // Resultaat van de calculator
    
    // AI Context
    chatHistory: [],          // Gespreksgeschiedenis van de Mead Medic
    
    // Label Forge tijdelijk
    currentLabelImage: null,  // De afbeelding die net gegenereerd is
    printQueue: []            // Lijst met labels klaar om te printen
};

// Helper: Reset state bij uitloggen
export function resetState() {
    state.userId = null;
    state.userSettings = {};
    state.brews = [];
    state.inventory = [];
    state.cellar = [];
    state.equipmentProfiles = [];
    state.waterProfiles = [];
    state.labelAssets = { savedStyles: [], savedFonts: [] };
    
    console.log("🧹 State volledig gewist.");
}