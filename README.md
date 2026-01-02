# 🍯 MEA(N)DERY - Personal Brew Buddy (V2.1)

![Status](https://img.shields.io/badge/status-personal_project-orange) ![Tech](https://img.shields.io/badge/powered%20by-Gemini%20AI-purple)

> **⚠️ NOTE:** This is a **personal hobby project**. This application is custom-built for my specific mead-making workflow and relies on a private Firebase backend. It is **not** intended for public use, distribution, or support. The source code is hosted here for archival and portfolio purposes only.

**MEA(N)DERY** is a sophisticated, AI-powered Progressive Web App (PWA) designed to master the art of mead making. From generating scientifically accurate recipes to managing my cellar climate and designing labels, Meandery acts as my digital cellar master.

![Dashboard Screenshot](https://via.placeholder.com/800x400?text=App+Dashboard+Preview)
*(Add a screenshot of your dashboard here)*

## ✨ Features Overview

### 🧠 The Brewing Engine
* **AI Recipe Creator:** Generates full recipes (Ingredients, Steps, Target SG) based on my prompt (e.g., "Spiced Cherry Melomel"). Includes "Fort Knox Protocols" for safety.
* **Smart Brew Day:** Interactive checklists for Primary and Secondary fermentation with built-in timers.
* **Auto-Calculations:** Automatically calculates ABV, sugar breaks, and nutrient schedules (TOSNA 2.0).

### 📦 Inventory & Management
* **Smart Inventory:** Tracks my honey, yeast, and nutrients. Includes a **Barcode Scanner** to quickly add items.
* **The Cellar:** Manages my aging bottles. Includes an **AI Aging Manager** that calculates the "Peak Flavor Date" based on my specific cellar temperature.
* **Financials:** Real-time tracking of asset value (Stock + Active Batches + Cellar).

### 🛠️ Tool Suite
* **Label Forge:** Design printable bottle labels. Generates **AI Artwork** and descriptions based on the brew's history.
* **Mead Medic:** An AI troubleshooter. I can upload a photo of my fermenter to get a scientific diagnosis.
* **Social Studio:** Generates captions for my brewing logs or Untappd check-ins.

## ⚙️ Technical Architecture

This project is built using a modern serverless stack:

* **Frontend:** Vanilla JavaScript (ES6 Modules) & HTML5.
* **Styling:** Tailwind CSS.
* **Backend:** Google Firebase (Firestore Database, Authentication).
* **AI Engine:** Google Gemini Pro & Flash (Text Logic), Imagen 3 (Image Generation).
* **PWA:** Fully installable on iOS and Android with Service Worker support.

## 🔒 Configuration & Security

This repository is configured for automated deployment via GitHub Pages.

* **Credentials:** The application loads its configuration from `secrets.js`.
* **Security Note:** The API keys included in this repository are **restricted** via Google Cloud Console. They are whitelisted to run *only* on the official domain of this web app.
    * Cloning this repo or running it locally without providing your own keys will result in API errors.
    * This setup allows the PWA to function on my personal devices while preventing unauthorized usage of my quotas.

## 📸 Gallery

| Recipe Creator | Label Forge | Mead Medic |
|:---:|:---:|:---:|
| ![Creator](https://via.placeholder.com/250x400?text=Creator) | ![Label](https://via.placeholder.com/250x400?text=Labels) | ![Medic](https://via.placeholder.com/250x400?text=Medic) |

---
*© 2025 - Private Project. Code provided As-Is.*
