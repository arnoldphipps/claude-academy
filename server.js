require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Security - CSP disabled for now to allow inline onclick handlers
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10kb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please wait a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', grading: !!ANTHROPIC_API_KEY });
});

// Grade endpoint
app.post('/api/grade', apiLimiter, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI grading is not configured on this server.' });
  }
  const { challenge_task, challenge_weak, rubric, student_work } = req.body;
  if (!challenge_task || !rubric || !student_work) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (student_work.length > 5000) {
    return res.status(400).json({ error: 'Submission too long.' });
  }
  const systemPrompt = `You are Professor Claude, an expert AI tutor grading a prompt engineering exercise. Be warm but rigorous. Respond ONLY with JSON (no markdown fences):\n{"score":<0-100>,"rubric_results":[true/false per rubric item],"overall_feedback":"2-3 sentences","strengths":["..."],"improvements":["..."],"passing":<true if score>=70>}`;
  const userMsg = `CHALLENGE:\n${challenge_task}\n\n${challenge_weak ? 'TRANSFORM: "' + challenge_weak + '"\n\n' : ''}RUBRIC:\n${rubric.map((r, i) => (i + 1) + '. ' + r).join('\n')}\n\nSUBMISSION:\n---\n${student_work}\n---`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: systemPrompt, messages: [{ role: 'user', content: userMsg }] }),
    });
    if (!response.ok) return res.status(502).json({ error: 'Grading service temporarily unavailable.' });
    const data = await response.json();
    const text = data.content?.map(c => c.text || '').join('') || '';
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json(result);
  } catch (err) {
    console.error('Grade error:', err);
    res.status(500).json({ error: 'Failed to grade. Please try again.' });
  }
});

// Help endpoint
app.post('/api/help', apiLimiter, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI help is not configured.' });
  }
  const { challenge_task, challenge_weak, rubric, student_work } = req.body;
  if (!challenge_task || !rubric) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  const systemPrompt = `You are Professor Claude. Give 2-3 specific hints — NOT the answer. Under 120 words. Encouraging and specific.`;
  const userMsg = `CHALLENGE:\n${challenge_task}\n\n${challenge_weak ? 'Transform: "' + challenge_weak + '"\n\n' : ''}RUBRIC: ${rubric.join(', ')}\n\nSTUDENT WORK:\n---\n${student_work || '(empty)'}\n---`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 512, system: systemPrompt, messages: [{ role: 'user', content: userMsg }] }),
    });
    if (!response.ok) return res.status(502).json({ error: 'Help service temporarily unavailable.' });
    const data = await response.json();
    const text = data.content?.map(c => c.text || '').join('') || '';
    res.json({ help: text });
  } catch (err) {
    console.error('Help error:', err);
    res.status(500).json({ error: 'Failed to get help.' });
  }
});

// Generate challenge endpoint
app.post('/api/generate-challenge', apiLimiter, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Challenge generation not configured.' });
  }
  const { module_id, difficulty, topics_covered } = req.body;
  const systemPrompt = `You are Professor Claude designing a new challenge. Create a fresh prompt engineering challenge. Respond ONLY with JSON (no fences):\n{"task":"<description>","weak_prompt":"<or null>","hints":["..."],"rubric":["..."],"difficulty":"<level>","scenario":"<context>"}`;
  const userMsg = `Module: ${module_id}\nDifficulty: ${difficulty}\nCovered: ${topics_covered || 'none'}`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: systemPrompt, messages: [{ role: 'user', content: userMsg }] }),
    });
    if (!response.ok) return res.status(502).json({ error: 'Challenge generation unavailable.' });
    const data = await response.json();
    const text = data.content?.map(c => c.text || '').join('') || '';
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json(result);
  } catch (err) {
    console.error('Challenge error:', err);
    res.status(500).json({ error: 'Failed to generate challenge.' });
  }
});

// Routes
app.get('/academy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'academy.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
app.listen(PORT, () => {
  console.log(`\n🎓 Claude Academy running at http://localhost:${PORT}`);
  console.log(`   AI Grading: ${ANTHROPIC_API_KEY ? '✅ Active' : '❌ No API key — set ANTHROPIC_API_KEY in .env'}\n`);
});
