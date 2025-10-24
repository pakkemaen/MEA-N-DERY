           // js/calculators.js

export function calculateABV() {
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

export function correctHydrometer() {
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

export function calculatePrimingSugar() {
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

export function calculateBlend() {
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

export function calculateBacksweetening() {
    const vol = parseFloat(document.getElementById('bs_current_vol').value);
    const currentSg = parseFloat(document.getElementById('bs_current_sg').value);
    const targetSg = parseFloat(document.getElementById('bs_target_sg').value);
    const resultDiv = document.getElementById('backsweetenResult');

    if (isNaN(vol) || isNaN(currentSg) || isNaN(targetSg) || targetSg <= currentSg) {
        resultDiv.textContent = 'Invalid Input';
        return;
    }

    // Honing voegt ongeveer 35 zwaartekrachtpunten per pond per gallon toe.
    // 1 pond = 453.6g; 1 gallon = 3.785L.
    // Dit komt neer op ongeveer 120g/L voor 35 punten, of 3.4g/L per punt (0.001 SG).
    const pointsToAdd = (targetSg - currentSg) * 1000;
    const honeyGrams = pointsToAdd * 3.4 * vol;
    const honeyKg = honeyGrams / 1000;

    resultDiv.textContent = `Add ${honeyGrams.toFixed(0)}g (${honeyKg.toFixed(2)}kg) honey`;
}

export function calculateDilution() {
    const startVol = parseFloat(document.getElementById('dil_start_vol').value);
    const startSg = parseFloat(document.getElementById('dil_start_sg').value);
    const targetSg = parseFloat(document.getElementById('dil_target_sg').value);
    const resultDiv = document.getElementById('dilutionResult');

    if (isNaN(startVol) || isNaN(startSg) || isNaN(targetSg) || startSg <= targetSg) {
        resultDiv.textContent = 'Invalid Input';
        return;
    }
    
    // (V1 * G1) = (V2 * G2) => V_add = V1 * (G1 - G2) / (G2 - 1)
    const startPoints = startSg * 1000 - 1000;
    const targetPoints = targetSg * 1000 - 1000;
    const waterToAdd = startVol * (startPoints / targetPoints - 1);
    
    resultDiv.textContent = `Add ${waterToAdd.toFixed(2)}L water`;
}

export function calculateTOSNA() {
    const og = parseFloat(document.getElementById('tosna_og').value);
    const vol = parseFloat(document.getElementById('tosna_vol').value);
    const yeastNeed = document.getElementById('tosna_yeast').value;
    const resultDiv = document.getElementById('tosnaResult');

    if (isNaN(og) || isNaN(vol)) {
        resultDiv.innerHTML = `<p class="text-red-500">Invalid Input</p>`;
        return;
    }

    // YAN (mg/L or ppm) = (2.7 * Brix) - 13.5  ; Brix = SG_points / 4
    const brix = (og * 1000 - 1000) / 4;
    let targetYAN;
    if (yeastNeed === 'low') targetYAN = 20 * brix;
    else if (yeastNeed === 'medium') targetYAN = 25 * brix;
    else targetYAN = 35 * brix;
    
    // Fermaid-O is ~40mg YAN/gram.
    const totalFermaidO = (targetYAN / 40) * vol;
    const addition = totalFermaidO / 4;

    resultDiv.innerHTML = `
        <h4 class="font-bold text-lg">TOSNA 2.0 Schedule</h4>
        <p><strong>Total Fermaid-O needed:</strong> ${totalFermaidO.toFixed(2)} grams.</p>
        <ul class="list-disc pl-5 mt-2">
            <li><strong>24 Hours:</strong> Add ${addition.toFixed(2)}g Fermaid-O</li>
            <li><strong>48 Hours:</strong> Add ${addition.toFixed(2)}g Fermaid-O</li>
            <li><strong>72 Hours:</strong> Add ${addition.toFixed(2)}g Fermaid-O</li>
            <li><strong>1/3 Sugar Break (or Day 7):</strong> Add ${addition.toFixed(2)}g Fermaid-O</li>
        </ul>
    `;
}

            
