# MEANDERY APP - ARCHITECTURE & GUIDELINES (v2.4)
Dit document beschrijft de architectuur, datastructuur en strikte programmeerregels van de Meandery App. Lees dit ALTIJD voordat je code wijzigt of toevoegt om regressie te voorkomen.

## 1. Tech Stack & Core Rules
- **Framework:** Pure Vanilla JavaScript (ES6 Modules). GEEN React, Vue of Angular code toegestaan.
- **Database:** Firebase v10.12.2 (Firestore, Auth, Storage). Alles gaat via gecentraliseerde exports uit `firebase-init.js`.
- **Styling:** Tailwind CSS (via CDN) gecombineerd met custom CSS variabelen in `style.css` (bijv. `--md-sys-color-primary`).
- **DOM Manipulatie:** Directe DOM manipulatie (`getElementById`, `innerHTML`). Geen virtuele DOM.

## 2. Bestandsstructuur & Modules
De app is strikt modulair opgebouwd:

| Module | Verantwoordelijkheid |
| :--- | :--- |
| `app.js` | De hoofd-orchestrator. Regelt Auth-state, start de `safeInit` loaders en bevat globale event listeners. |
| `firebase-init.js` | Centrale hub voor Firebase. Exporteert alle benodigde Firebase functies. Importeer Firebase NOOIT direct via CDN in andere files. |
| `state.js` | **Single Source of Truth**. Bevat `state` (voor persistente data, o.a. `brews`, `inventory`) en `tempState` (voor vluchtige UI statussen zoals `activeBrewId`). |
| `utils.js` | Helper functies: `showToast()`, navigatie (`switchMainView`, `switchSubView`), Gemini API calls en `logSystemError()`. |
| `brewing.js` | Kernlogica voor het brouwen. Receptgeneratie (AI), timers, fermentation logs (grafieken), en de transitie van Primary naar Secondary (aging). |
| `inventory.js` | Voorraadbeheer. Beheert ingrediënten, verpakkingen (packaging), equipment profielen en de `cellar` (gebottelde mede). Inclusief kostprijsberekening. |
| `tools.js` | Rekenmachines (ABV, TOSNA, Blending), Water profielen, User Settings, de 'Mead Medic' chat en de Prompt Engineer tool. |
| `label-forge.js` | Visuele label editor, AI image generation (Imagen), PDF print logica en HTML canvas rendering. |

## 3. Cruciale Architectuur Regels (Anti-Regressie)

### A. Window Object Binding (HTML naar JS)
Omdat ES6 modules hun eigen scope hebben, MOETEN functies die vanuit de HTML via `onclick` of `oninput` worden aangeroepen, gekoppeld worden aan het globale `window` object. 
*Voorbeeld:* `window.mijnFunctie = async function() { ... }` of onderaan het bestand `window.mijnFunctie = mijnFunctie;`.
**Regel:** Breek of verwijder nooit bestaande window-bindings.

### B. State Management & Firestore
- Lees data zoveel mogelijk uit de lokale `state.js`.
- Wijzigingen moeten ALTIJD naar Firestore geschreven worden (via `updateDoc`, `setDoc` of `addDoc`). 
- Bestaande lijsten (zoals `state.brews` of `state.inventory`) worden doorgaans up-to-date gehouden via Firestore `onSnapshot` listeners die in de `load...` functies zitten. Pas lokale state direct aan als onmiddellijke UI-feedback vereist is, maar vertrouw voor de waarheid op Firestore.

### C. Database Structuur (Firestore)
- Root Collectie: `artifacts/meandery-aa05e/users/{userId}/`
- Subcollecties per user: `brews`, `inventory`, `cellar`, `equipmentProfiles`, `waterProfiles`, `systemLogs`, `gallery`, `medicChats`.
- Settings doc: `settings/main` (bevat API keys, voorkeuren), `settings/packaging`, `settings/labelFormats`.

### D. Error Handling & Safe Loading
- Gebruik `window.logSystemError(error, 'Context', 'ERROR')` in elk `catch` block om fouten centraal te loggen (Black Box systeem).
- Toon gebruikersfouten altijd via `window.showToast("Message", "error")`.
- In `app.js` worden modules opgestart via `safeInit('functieNaam')` om te voorkomen dat één falende module de hele app laat crashen.

### E. AI Prompts (Gemini)
De app steunt zwaar op dynamisch opgebouwde AI prompts (bijv. `buildPrompt()` in brewing.js). Bij het aanpassen van deze logica, let op de "Fort Knox Protocollen" en zorg dat de JSON output structuur die de app verwacht 100% intact blijft.

### F. Scientific Standards (Alcohol Calculation)
- **Standard:** All ABV calculations MUST use the **Hall Equation** instead of the linear 131.25 multiplier to ensure accuracy in high-gravity fermentations.
- **Formula:** - ABW = (76.08 * (OG - FG)) / (1.775 - OG)
  - ABV = ABW / 0.794
- **Implementation:** This is enforced in `tools.js` (Calculators, Refractometer) and `brewing.js` (Auto-logs, Blending).