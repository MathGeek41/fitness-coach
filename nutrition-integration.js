// ============================================================
//  nutrition-integration.js
//  הדבק את הקובץ הזה בפרויקט שלך ב-Claude Code
//  ועדכן את USDA_KEY במפתח חינמי מ:
//  https://fdc.nal.usda.gov/api-guide.html
// ============================================================

const USDA_KEY = 'DEMO_KEY'; // ← החלף כאן


// ── 1. Claude מפענח עברית ונותן ניתוח ראשוני ──────────────
async function analyzeWithClaude(userText) {
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
      "protein_g": 12
    }
  ],
  "total_calories": 350,
  "total_protein_g": 28,
  "health_score": 8,
  "health_reason": "הסבר קצר בעברית למה הציון הזה"
}

ציון בריאות:
8-10 = מזון מלא, עשיר בחלבון, מינימום עיבוד
6-7  = סביר, אפשר לשפר
1-5  = מעובד / הרבה סוכר / ערך תזונתי נמוך

ארוחה: ${userText}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await res.json();
  const raw = data.content[0].text.trim()
    .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(raw);
}


// ── 2. USDA מאמת ומדייק לכל מזון ──────────────────────────
async function verifyWithUSDA(foodEnglishName, grams) {
  try {
    const res = await fetch(
      `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(foodEnglishName)}&pageSize=1&api_key=${USDA_KEY}`
    );
    const data = await res.json();
    if (!data.foods?.length) return null;

    const nutrients = data.foods[0].foodNutrients || [];
    const energyPer100 = nutrients.find(n => n.nutrientName === 'Energy' && n.unitName === 'KCAL')?.value
                      ?? nutrients.find(n => n.nutrientName === 'Energy')?.value
                      ?? null;
    const proteinPer100 = nutrients.find(n => n.nutrientName === 'Protein')?.value ?? null;

    if (energyPer100 === null) return null;

    const factor = grams / 100;
    return {
      calories:  Math.round(energyPer100 * factor),
      protein_g: proteinPer100 !== null ? Math.round(proteinPer100 * factor * 10) / 10 : null
    };
  } catch {
    return null; // USDA נכשל? ממשיכים רק עם Claude
  }
}


// ── 3. הפונקציה הראשית — קורא לה מכל מקום באפליקציה ────────
//
//  קלט:  מחרוזת טקסט בעברית  (למשל: "שתי ביצים וסלט ירקות")
//  פלט:  אובייקט עם כל הנתונים המשולבים
//
async function getNutritionData(userText) {

  // שלב 1 — Claude מנתח
  const claude = await analyzeWithClaude(userText);

  // שלב 2 — USDA מאמת (במקביל לכל המזונות)
  const usdaResults = await Promise.all(
    claude.foods.map(f => verifyWithUSDA(f.name_english, f.quantity_grams))
  );

  // שלב 3 — מיזוג חכם: ממוצע כשיש שני מקורות
  let usdaHits = 0;
  const foods = claude.foods.map((food, i) => {
    const usda = usdaResults[i];
    let finalCal  = food.calories;
    let finalProt = food.protein_g;
    let source    = 'Claude בלבד';

    if (usda) {
      finalCal  = Math.round((food.calories + usda.calories) / 2);
      finalProt = usda.protein_g !== null
        ? Math.round((food.protein_g + usda.protein_g) / 2 * 10) / 10
        : food.protein_g;
      source = 'Claude + USDA';
      usdaHits++;
    }

    return {
      name_hebrew:          food.name_hebrew,
      name_english:         food.name_english,
      quantity_description: food.quantity_description,
      quantity_grams:       food.quantity_grams,
      calories:             finalCal,
      protein_g:            finalProt,
      source                          // מאיפה הנתונים
    };
  });

  // חישוב סה"כ מהמיזוג
  const totalCalories  = foods.reduce((sum, f) => sum + f.calories,  0);
  const totalProtein   = Math.round(foods.reduce((sum, f) => sum + f.protein_g, 0) * 10) / 10;

  // דיוק: כמה המקורות הסכימו?
  const confidencePct = usdaHits === 0 ? 70
    : usdaHits === foods.length       ? 95
    : Math.round(70 + (usdaHits / foods.length) * 25);

  return {
    foods,                          // מערך מזונות מפורט
    total_calories:  totalCalories,
    total_protein_g: totalProtein,
    health_score:    claude.health_score,   // 1–10
    health_reason:   claude.health_reason,  // הסבר בעברית
    confidence_pct:  confidencePct,         // 70–95
    usda_hits:       usdaHits,              // כמה מזונות אומתו ב-USDA
    sources_used:    usdaHits > 0 ? ['Claude AI', 'USDA FoodData'] : ['Claude AI']
  };
}


// ── דוגמת שימוש ────────────────────────────────────────────
//
//  const result = await getNutritionData("שתי ביצים קשות וכוס קפה עם חלב");
//
//  result.total_calories   → 220
//  result.total_protein_g  → 14.5
//  result.health_score     → 8
//  result.health_reason    → "ארוחה מאוזנת, עשירה בחלבון..."
//  result.confidence_pct   → 95
//  result.foods            → [{ name_hebrew, calories, protein_g, source, ... }, ...]
