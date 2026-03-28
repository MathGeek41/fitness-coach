// api/analyze-meal.js — Vercel Serverless Function
// Environment variables required in Vercel dashboard:
//   GEMINI_API_KEY  — required
//   FDC_API         — optional (USDA FoodData Central verification)

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const USDA_KEY   = process.env.FDC_API;

// ── Step 1: Gemini parses Hebrew text + estimates nutrition ──
async function analyzeWithGemini(userText) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not configured');

  const prompt = `אתה מומחה תזונה. המשתמש תיאר ארוחה בעברית.
נתח אותה והחזר אך ורק JSON תקני (ללא markdown, ללא הסבר, רק JSON):
{
  "foods": [
    {
      "name_hebrew": "שם בעברית",
      "name_english": "English name for USDA lookup",
      "quantity_description": "תיאור הכמות",
      "quantity_grams": 120,
      "calories": 150,
      "protein_g": 12,
      "carb_g": 10,
      "fat_g": 5
    }
  ],
  "total_calories": 350,
  "total_protein_g": 28,
  "total_carb_g": 40,
  "total_fat_g": 12,
  "meal_name": "שם קצר לארוחה בעברית",
  "health_score": 8,
  "health_reason": "הסבר קצר בעברית למה הציון הזה"
}

ציון בריאות (health_score):
8-10 = מזון מלא, עשיר בחלבון, מינימום עיבוד
6-7  = סביר, ניתן לשיפור
1-5  = מעובד מאוד / הרבה סוכר / ערך תזונתי נמוך

ארוחה: ${userText}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1200 }
      })
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Gemini error: ' + (err.error?.message || res.status));
  }

  const data = await res.json();
  const raw = data.candidates[0].content.parts[0].text.trim()
    .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(raw);
}

// ── Step 2: USDA FoodData Central verifies each food item ───
async function verifyWithUSDA(foodEnglishName, grams) {
  try {
    const res = await fetch(
      `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(foodEnglishName)}&pageSize=1&api_key=${USDA_KEY}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.foods?.length) return null;

    const nutrients = data.foods[0].foodNutrients || [];
    const find = (name, unit) => nutrients.find(n =>
      n.nutrientName === name && (!unit || n.unitName === unit)
    )?.value ?? null;

    const energyKcal = find('Energy', 'KCAL') ?? find('Energy');
    if (energyKcal === null) return null;

    const factor = grams / 100;
    const round1 = v => v !== null ? Math.round(v * factor * 10) / 10 : null;

    return {
      calories:  Math.round(energyKcal * factor),
      protein_g: round1(find('Protein')),
      carb_g:    round1(find('Carbohydrate, by difference')),
      fat_g:     round1(find('Total lipid (fat)'))
    };
  } catch {
    return null;
  }
}

// ── Merge: average when both sources agree ───────────────────
function mergeSources(geminiFood, usda) {
  if (!usda) return { ...geminiFood, source: 'Gemini' };

  const avg = (a, b) => b !== null ? Math.round((a + b) / 2 * 10) / 10 : a;
  return {
    ...geminiFood,
    calories:  Math.round((geminiFood.calories + usda.calories) / 2),
    protein_g: avg(geminiFood.protein_g, usda.protein_g),
    carb_g:    avg(geminiFood.carb_g,    usda.carb_g),
    fat_g:     avg(geminiFood.fat_g,     usda.fat_g),
    source: 'Gemini + USDA'
  };
}

// ── Main handler (Vercel format) ─────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { text } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ error: 'text is required' });

    // Step 1 — Gemini
    const gemini = await analyzeWithGemini(text.trim());

    // Step 2 — USDA (parallel, only if key exists)
    let foods = gemini.foods;
    let usdaHits = 0;

    if (USDA_KEY) {
      const usdaResults = await Promise.all(
        gemini.foods.map(f => verifyWithUSDA(f.name_english, f.quantity_grams))
      );
      foods = gemini.foods.map((food, i) => {
        const merged = mergeSources(food, usdaResults[i]);
        if (usdaResults[i]) usdaHits++;
        return merged;
      });
    } else {
      foods = gemini.foods.map(f => ({ ...f, source: 'Gemini' }));
    }

    const sum = (key) => Math.round(foods.reduce((s, f) => s + (f[key] || 0), 0) * 10) / 10;
    const confidencePct = !USDA_KEY || usdaHits === 0 ? 70
      : usdaHits === foods.length ? 95
      : Math.round(70 + (usdaHits / foods.length) * 25);

    return res.status(200).json({
      name:           gemini.meal_name || text.slice(0, 40),
      cal:            Math.round(sum('calories')),
      prot:           sum('protein_g'),
      carb:           sum('carb_g'),
      fat:            sum('fat_g'),
      health_score:   gemini.health_score,
      health_reason:  gemini.health_reason,
      confidence_pct: confidencePct,
      usda_verified:  USDA_KEY ? usdaHits + '/' + foods.length : 'N/A',
      foods
    });
  } catch (e) {
    console.error('analyze-meal error:', e);
    return res.status(500).json({ error: e.message || 'Internal server error' });
  }
}
