// api/chat.js — Vercel Serverless Function for AI coach chat via Gemini

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { messages, context } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  const contextLines = context ? `
נתונים עדכניים:
- משקל אחרון: ${context.lastWeight || 'לא הוזן'}
- קלוריות היום: ${context.totalCal || 0} / 1800
- חלבון היום: ${context.totalProt || 0} / 180 גרם
- אימונים השבוע: ${context.weekWorkouts || 0} / 4` : '';

  const systemText = `אתה מאמן כושר ותזונה אישי של אייל, גבר בן 42 שמטרתו להגיע מ-97 ק"ג ו-30% שומן ל-89 ק"ג עד 31/5. יעדים יומיים: 1800 קלוריות, 180 גרם חלבון, 10,000 צעדים, 4 אימונים שבועיים.${contextLines}

ענה תמיד בעברית, היה תומך אך ישיר, מקצועי ומוטיבציוני. שמור על תגובות קצרות וממוקדות. השתמש באמוג'י במידה.`;

  // Convert to Gemini format (role: 'user' | 'model')
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini error ${response.status}: ${JSON.stringify(data)}`);

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) throw new Error('No reply from Gemini');

    return res.status(200).json({ reply });
  } catch (e) {
    console.error('chat error:', e);
    return res.status(500).json({ error: e.message });
  }
};
