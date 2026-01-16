🍯 MEA(N)DERY - Personal Brew Buddy (V2.4)
"De AI is de Architect, de App is de Uitvoerder."

⚠️ NOTE: This is a personal hobby project. This application is custom-built for my specific mead-making workflow and relies on a private Firebase backend. It is not intended for public use, distribution, or support. The source code is hosted here for archival and portfolio purposes only.

MEA(N)DERY V2.4 is a significant evolution of my digital cellar master. Now refactored into a Modular Architecture, it combines strict brewing science with creative AI freedom. It handles everything from selecting the perfect Belgian supermarket water to generating "Ryan Reynolds-style" marketing copy for my batches.

🚀 What's New in V2.4?
Modular Codebase: Moved away from a monolithic app.js to a domain-driven structure (brewing.js, inventory.js, tools.js), improving stability and maintainability.

Smart Recipe Parser V2.4: The app now "reads" the recipe text intelligently. It detects timelines ("Wait 24 hours") and creates timers automatically, even without strict tags.

Target vs. Actuals Logging: Restored the critical distinction between AI-calculated targets (Key Stats) and real-world measurements (Brew Log), essential for accurate ABV calculations and aging advice.

The "No-Chemistry" Water Sommelier: A specialized tool that recommends commercial bottled waters (available in BE/EU) that match a recipe's profile, removing the need for brewing salts/chemistry sets.

✨ Features Overview
🧠 The Brewing Engine
AI Recipe Creator: Generates scientifically accurate recipes using "Fort Knox Protocols"—a strict set of system instructions that prevent the AI from suggesting unsafe practices or impossible physics.

Dynamic TOSNA Scheduling: Automatically calculates nutrient additions (1, 2, or 3 steps) based on the specific ABV of the recipe.

Smart Brew Day: Interactive step-by-step execution. Includes a "Look Ahead" feature that respects custom recipe steps before injecting automated logic.

📦 Inventory & Cellar
Smart Inventory: Tracks Honey, Yeast, and Nutrients with Barcode Scanning (OpenFoodFacts API).

Auto-Deduction: One-click syncing between the Brew Log actuals and the Inventory stock.

The Cellar: Manages aging bottles with an AI Aging Manager. It calculates "Peak Flavor Dates" based on my specific cellar temperature and historical storage conditions.

🛠️ Tool Suite
Label Forge V2: A full design studio.

Style DNA Extractor: Analyzes an uploaded image to extract its artistic style prompt.

AI Art Generation: Uses Imagen 3 to generate high-res artwork.

Auto-Fit Text: Dynamically adjusts font sizes to fit labels perfectly.

Mead Medic: An AI troubleshooter with vision capabilities. I can upload a photo of a pellicle or foam, and the AI diagnoses infection vs. yeast rafts.

Social Studio: Generates captions for Instagram or Untappd, with selectable personas (e.g., "The Viking", "Dry British", "Ryan Reynolds").

🔬 Calculators
Water Chemistry: Analyzes mineral profiles (Ca, Mg, HCO3) without requiring salt additions.

Refractometer Correction: Converts Brix to SG during fermentation.

Blending & Fortification: Calculates new ABV when blending meads or adding spirits.

⚙️ Technical Architecture
This project is built using a modern, serverless, and modular stack:

Frontend: Vanilla JavaScript (ES6 Modules) & HTML5. No build steps, pure browser-native code.

Styling: Tailwind CSS (CDN).

Backend: Google Firebase (Firestore Database, Authentication, Storage).

AI Engine:

Logic: Google Gemini 2.5 Pro & Flash.

Vision: Gemini 2.5 Pro (Multimodal).

Art: Imagen 3.

PWA: Fully installable on iOS and Android with Service Worker support and offline caching.

🔒 Configuration & Security
Deployment: Configured for automated deployment via GitHub Pages.

Credentials: The application loads its configuration from secrets.js (git-ignored).

Security Note: The API keys included in this repository are restricted via Google Cloud Console. They are whitelisted to run only on the official domain of this web app. Cloning this repo without providing your own keys will result in API errors.
