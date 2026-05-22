## 🍯 MEA(N)DERY — Personal Brew Buddy (V2.6)

> "De AI is de Architect, de App is de Uitvoerder."

⚠️ **NOTE:** This is a personal hobby project. This application is custom-built for my specific mead-making workflow and relies on a private Firebase backend. It is not intended for public use, distribution, or support. The source code is hosted here for archival and portfolio purposes only.

MEA(N)DERY V2.6 is a monumental evolution of my digital cellar master. Fully refactored into a rigorous, domain-driven architecture, the application seamlessly bridges exact oenological science with creative AI freedom. Version 2.6 introduces advanced thermodynamic equation frameworks, predictive chemical monitoring, split-batch automation, and absolute state-centralization to govern every aspect of modern craft mead-making.

---

## 🚀 What's New in V2.6?

### 🔬 Universal Hall Equation Integration

The application has completely eliminated the standard linear $131.25$ multiplier across all computing layers. To safeguard accuracy in high-gravity honey fermentations ($>1.100\text{ SG}$), alcohol levels are now universally governed by the non-linear **Hall Equation**:

$$ABW = \frac{76.08 \times (OG - FG)}{1.775 - OG}$$

$$ABV = \frac{ABW}{0.794}$$

This mathematical standard is rigorously enforced across auto-logs, refractometer modifiers, and the blending suite.

### 🌿 "Clone & Link" Split-Batch Protocol

Real-time parallel zymology is now a native feature. With the **Split-Batch Protocol**, a single massive primary fermentation can be fractioned into multiple autonomous child batches. Each fraction inherits the immutable parental lineage (OG, primary logs, and trends) but receives its own volumetric density balance, independent aging logbook, custom label profiles, and downstream dry-hop or fruit additions.

### 🧪 Ternary Blending Simulator

Upgraded from a simple volumetric average calculator to an advanced zymological simulator. When blending multiple mead profiles or adding spirits, the engine handles complex mass balances to calculate final gravity, volumetric contraction, and logaritmische pH shifts based on total hydrogen proton mixing:

$$pH_{blend} = -\log_{10}\left(\frac{\sum (V_n \times 10^{-pH_n})}{\sum V_n}\right)$$

### 🛡️ Back-Sweetening & Stabilisation Gatekeeper

To mitigate the catastrophic risk of bottle bombs, a strict biochemical poortwachter checkpoint is integrated into the aging chamber. The application enforces a **Klaring & Decimatie** checklist. Users must explicitly confirm hydrometric stability, visual clarity (biomass decimation), and active free $\text{SO}_2$ presence before back-sweetening is unlocked.

### 📊 TOSNA 3.0 & Dynamic Pitch Rates

Fully compliant with the latest oenological standards. The nutrient engine dynamically scales pitch rates down to exactly **1 gram of dry yeast per gallon** for musts below $1.100\text{ SG}$. Furthermore, it tracks the nitrogen footprint of Go-Ferm rehydration and enforces a strict **4.0x bio-equivalence multiplier** for organic stikstof (Fermaid O) calculations:

$$\text{Analytical YAN} \times 4.0 = \text{Physiological YAN Equivalent}$$

---

## ✨ Features Overview

### 🧠 The Brewing Engine

* **AI Recipe Creator & Fort Knox Protocols:** Generates custom recipes wrapped in strict system guardrails. Prevents the suggestion of impossible physics, off-limit fermentation boundaries, or toxic practices.
* **Yeast-Specific Risk Detection:** Built-in safeguards bound to isolated strains. It throws immediate warnings if **Lalvin D47** encounters temperatures above **20°C** (preventing fusel alcohol synthesis) or if **SafAle US-05** suffers stikstof shortages (preventing $\text{H}_2\text{S}$ rotten-egg off-flavors).
* **Hop Kinetics Window:** Restricts secondary cold-extraction (dry-hopping) schedules strictly between **72 and 120 hours** to maximize volatile monoterpene transfer while blocking grass-like polyphenol over-extraction and hop-burn.
* **Smart Brew Day:** Interactive checklist execution with an incremental fallback editor and automatic short-interval timer chains.

### 📦 Inventory & Cellar

* **Smart Inventory & Barcode Scan:** Automated asset management tracking honey types, nutrient stocks, and packaging units via the OpenFoodFacts API.
* **Exact Cost-per-Bottle Analysis:** Combines precise ex-vessel ingredient actuals (`performInventoryDeduction`) with structural packaging expenses (bottle sizing, cork metrics, label allocations) to output real-time batches financial metrics.
* **AI Aging Matrix & Cellar Sync:** Leverages an algorithmic matrix using current cellar conditions (`state.userSettings.cellarTemp`), residual sugar loads, and historical storage logs to predict the exact oenological peak phase of cellared inventory.

### 🛠️ Tool Suite

* **Label Forge V2 Studio:** A fully integrated vector and canvas layout studio tied directly to the global state.
* *Style DNA Extractor:* Uses multimodal inputs to isolate artistic techniques (medium, color palettes, shading) into clean graphic prompts.
* *Art Generation:* Connects directly via Vertex AI to Imagen 3 to output crisp high-res label artwork.
* *Auto-Fit & Font Protectors:* Handles text-bounds monitoring to prevent overflows against structural borders or logos.


* **Mead Medic & Vision Diagnostics:** Multimodal troubleshooting companion capable of identifying surface pellicles, mold growth, or innocent yeast rafts from uploaded carboy photos.
* **Social Studio 2.0:** Formulates marketing and caption copy optimized for Instagram or Untappd, leveraging specialized selectable personas like *The Viking*, *The Sommelier*, or *Ryan Reynolds*.

---

## 🔬 Reken-Engines

| Calculator | Core Mathematical / Chemical Foundation | Target Output |
| --- | --- | --- |
| **ABV Engine** | Non-linear Hall Differential Equations | Absolute true alcohol percentage by weight/volume |
| **TOSNA 3.0** | $10 \times \text{Brix}_{init} \times \text{SG}_{init} \times F_{gist}$ | 4-stage organic Fermaid O schedule (ppm YAN) |
| **Buffer Matrix** | Carbonate-Bicarbonate electrochemical system | Proactive $\text{K}_2\text{CO}_3$ dosing ($0.4\text{ g/L}$) to block early pH crashes ($<3.2$) |
| **Refractometer** | Cubic Terrill & Linear Novotny Regressions | Density corrections compensating for ethanol refraction |
| **Stabilisation** | Piecewise Sorbate Scale & Henderson-Hasselbalch | Precise targets for Kaliumsorbaat and molecular $\text{SO}_2$: <br>

<br> <br>$$Vrije\ \text{SO}_2 = 0.8 \times \left(1 + 10^{(pH - 1.81)}\right)$$

 |
| **Braggot Core** | Stoichiometric Malt Sugar Transition ($X_{malt}$) | Honey-to-malt grist weights restricted between **30% and 50%** of total $GP_{total}$ |

---

## ⚙️ Technical Architecture

The application operates entirely serverless, running on a browse-native, performant layout stack:

* **Frontend Framework:** Pure Vanilla JavaScript (ES6 Modules) and HTML5. No compiling, no bundlers—100% native environment execution.
* **Interface Guard:** Strict implementation of browser-safe object accessors. Completely eliminates NodeList array-collapse bugs through native `.at(index)` and `.item(index)` methods.
* **Styling & Layout:** Tailwind CSS (CDN-delivered architecture) integrated with semantic Material Design 3 theme tokens.
* **Backend Cloud Infrastructure:** Google Firebase Hub (Firestore Cloud Database, Firebase Auth, Firebase Cloud Storage).
* **AI Engine & Models:**
* *Logic & Diagnostics:* Google Gemini 2.0 Flash & Gemini 1.5 Pro (Multimodal Core).
* *Deep reasoning:* Gemini 2.0 Flash-Thinking Exploratory Suite.
* *Artistic Layouts:* Imagen 3 Graphic Architecture.


* **Progressive Web App (PWA):** Fully standalone, installable mobile wrapper across iOS and Android systems utilizing Service Worker caching logic.

---

## 🔒 Configuration & Security

* **Deployment Workflow:** Continuous automated integration and static delivery through GitHub Pages.
* **Credential Vault:** Sensitive tokens and infrastructure parameters are loaded through a local, `git-ignored` environment file (`secrets.js`).
* **Security Constraints:** Deep API keys embedded in the repository framework are structurally locked via the Google Cloud Console. Access is whitelisted exclusively for the web app's official root domain; cloning without establishing personalized private access variables will trigger security handshake dropouts.
