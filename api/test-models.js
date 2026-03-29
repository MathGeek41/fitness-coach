// Temporary endpoint to test which Gemini models are available
// DELETE after testing: /api/test-models

const models = ['gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash-001'];

module.exports = async function handler(req, res) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const results = [];
  for (const model of models) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'say hi' }] }] })
      }
    );
    results.push({ model, status: r.status, ok: r.ok });
  }

  res.status(200).json(results);
};
