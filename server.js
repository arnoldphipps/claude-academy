require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Supabase setup
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY)
  : null;

// CRITICAL: Trust proxy - required for Railway
app.set('trust proxy', 1);

// Security
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50kb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { error: 'Too many requests. Please wait a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ========================================
// AUTH MIDDLEWARE
// ========================================
async function authMiddleware(req, res, next) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid session.' });
    // Get profile data
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    req.user = { ...user, profile };
    req.token = token;
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(401).json({ error: 'Authentication failed.' });
  }
}

// Optional auth - doesn't block, just attaches user if present
async function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token && supabase) {
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) {
        const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
        req.user = { ...user, profile };
      }
    } catch (e) { /* ignore */ }
  }
  next();
}

// ========================================
// HEALTH CHECK
// ========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    grading: !!ANTHROPIC_API_KEY,
    database: !!supabase,
    version: '2.0.0'
  });
});

// ========================================
// AUTH ENDPOINTS
// ========================================
app.post('/api/auth/register', apiLimiter, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { email, password, name, company } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password, and name are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name, company: company || null } }
    });
    if (error) return res.status(400).json({ error: error.message });
    // Create profile
    if (data.user) {
      await supabase.from('profiles').upsert({
        id: data.user.id,
        email,
        name,
        company: company || null,
        role: 'student',
        xp: 0,
        created_at: new Date().toISOString()
      });
    }
    res.json({
      user: { id: data.user?.id, email, name },
      session: data.session
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/api/auth/login', apiLimiter, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    // Get profile
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', data.user.id).single();
    res.json({
      user: { id: data.user.id, email: data.user.email, ...profile },
      session: data.session
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  res.json({ success: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email, ...req.user.profile } });
});

// ========================================
// PROGRESS TRACKING
// ========================================
app.post('/api/progress', authMiddleware, async (req, res) => {
  const { lesson_id, module_id, status, time_spent_seconds } = req.body;
  if (!lesson_id || !module_id) {
    return res.status(400).json({ error: 'lesson_id and module_id required.' });
  }
  try {
    // Check for existing progress
    const { data: existing } = await supabase
      .from('progress')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('lesson_id', lesson_id)
      .single();

    const now = new Date().toISOString();
    if (existing) {
      // Update existing
      const update = { status: status || existing.status, updated_at: now };
      if (time_spent_seconds) update.time_spent_seconds = (existing.time_spent_seconds || 0) + time_spent_seconds;
      if (status === 'completed' && !existing.completed_at) update.completed_at = now;
      const { data, error } = await supabase.from('progress').update(update).eq('id', existing.id).select().single();
      if (error) throw error;
      res.json(data);
    } else {
      // Create new
      const { data, error } = await supabase.from('progress').insert({
        user_id: req.user.id,
        lesson_id,
        module_id,
        status: status || 'started',
        time_spent_seconds: time_spent_seconds || 0,
        started_at: now,
        completed_at: status === 'completed' ? now : null,
        created_at: now,
        updated_at: now
      }).select().single();
      if (error) throw error;
      res.json(data);
    }
  } catch (err) {
    console.error('Progress error:', err);
    res.status(500).json({ error: 'Failed to save progress.' });
  }
});

app.get('/api/progress', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('progress')
      .select('*')
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Get progress error:', err);
    res.status(500).json({ error: 'Failed to get progress.' });
  }
});

// ========================================
// GRADES
// ========================================
app.post('/api/grades', authMiddleware, async (req, res) => {
  const { lesson_id, module_id, score, rubric_results, feedback, strengths, improvements } = req.body;
  if (!lesson_id || score === undefined) {
    return res.status(400).json({ error: 'lesson_id and score required.' });
  }
  try {
    const { data, error } = await supabase.from('grades').insert({
      user_id: req.user.id,
      lesson_id,
      module_id: module_id || null,
      score,
      rubric_results: rubric_results || [],
      feedback: feedback || '',
      strengths: strengths || [],
      improvements: improvements || [],
      graded_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;

    // Update XP in profile
    const xpEarned = Math.round(score / 10) * 5;
    const { data: profile } = await supabase.from('profiles').select('xp').eq('id', req.user.id).single();
    await supabase.from('profiles').update({ xp: (profile?.xp || 0) + xpEarned }).eq('id', req.user.id);

    // Update progress to completed
    await supabase.from('progress')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('user_id', req.user.id)
      .eq('lesson_id', lesson_id);

    res.json({ ...data, xp_earned: xpEarned });
  } catch (err) {
    console.error('Grade save error:', err);
    res.status(500).json({ error: 'Failed to save grade.' });
  }
});

app.get('/api/grades', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('grades')
      .select('*')
      .eq('user_id', req.user.id)
      .order('graded_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Get grades error:', err);
    res.status(500).json({ error: 'Failed to get grades.' });
  }
});

// ========================================
// SUPERVISOR DASHBOARD
// ========================================
app.get('/api/dashboard/team', authMiddleware, async (req, res) => {
  // Check if user is supervisor or admin
  if (!req.user.profile || !['supervisor', 'admin'].includes(req.user.profile.role)) {
    return res.status(403).json({ error: 'Supervisor access required.' });
  }
  try {
    const orgId = req.user.profile.org_id;
    if (!orgId) return res.json({ members: [], stats: {} });

    // Get all org members
    const { data: members } = await supabase
      .from('profiles')
      .select('id, email, name, role, xp, created_at')
      .eq('org_id', orgId);

    if (!members || members.length === 0) return res.json({ members: [], stats: {} });

    const memberIds = members.map(m => m.id);

    // Get all progress for team
    const { data: progress } = await supabase
      .from('progress')
      .select('*')
      .in('user_id', memberIds);

    // Get all grades for team
    const { data: grades } = await supabase
      .from('grades')
      .select('*')
      .in('user_id', memberIds);

    // Build per-member stats
    const memberStats = members.map(member => {
      const memberProgress = (progress || []).filter(p => p.user_id === member.id);
      const memberGrades = (grades || []).filter(g => g.user_id === member.id);
      const completedLessons = memberProgress.filter(p => p.status === 'completed').length;
      const totalTimeSeconds = memberProgress.reduce((sum, p) => sum + (p.time_spent_seconds || 0), 0);
      const avgScore = memberGrades.length > 0
        ? Math.round(memberGrades.reduce((sum, g) => sum + g.score, 0) / memberGrades.length)
        : 0;

      return {
        ...member,
        completed_lessons: completedLessons,
        total_lessons: 12,
        completion_pct: Math.round((completedLessons / 12) * 100),
        total_time_minutes: Math.round(totalTimeSeconds / 60),
        avg_score: avgScore,
        grades_count: memberGrades.length,
        last_active: memberProgress.length > 0
          ? memberProgress.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0].updated_at
          : member.created_at
      };
    });

    // Aggregate team stats
    const teamStats = {
      total_members: members.length,
      avg_completion: Math.round(memberStats.reduce((s, m) => s + m.completion_pct, 0) / members.length),
      avg_score: Math.round(memberStats.reduce((s, m) => s + m.avg_score, 0) / members.length),
      total_time_hours: Math.round(memberStats.reduce((s, m) => s + m.total_time_minutes, 0) / 60),
      fully_completed: memberStats.filter(m => m.completed_lessons === 12).length
    };

    res.json({ members: memberStats, stats: teamStats });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard.' });
  }
});

// Export team data as CSV
app.get('/api/dashboard/export', authMiddleware, async (req, res) => {
  if (!req.user.profile || !['supervisor', 'admin'].includes(req.user.profile.role)) {
    return res.status(403).json({ error: 'Supervisor access required.' });
  }
  try {
    const orgId = req.user.profile.org_id;
    if (!orgId) return res.status(404).json({ error: 'No organization found.' });

    const { data: members } = await supabase.from('profiles').select('*').eq('org_id', orgId);
    const memberIds = (members || []).map(m => m.id);
    const { data: progress } = await supabase.from('progress').select('*').in('user_id', memberIds);
    const { data: grades } = await supabase.from('grades').select('*').in('user_id', memberIds);

    // Build CSV
    let csv = 'Name,Email,Lessons Completed,Avg Score,Total Time (min),XP,Last Active\n';
    (members || []).forEach(member => {
      const mp = (progress || []).filter(p => p.user_id === member.id);
      const mg = (grades || []).filter(g => g.user_id === member.id);
      const completed = mp.filter(p => p.status === 'completed').length;
      const avgScore = mg.length > 0 ? Math.round(mg.reduce((s, g) => s + g.score, 0) / mg.length) : 0;
      const totalMin = Math.round(mp.reduce((s, p) => s + (p.time_spent_seconds || 0), 0) / 60);
      const lastActive = mp.length > 0 ? mp.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0].updated_at : '';
      csv += `"${member.name}","${member.email}",${completed},${avgScore},${totalMin},${member.xp || 0},"${lastActive}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=team-progress.csv');
    res.send(csv);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed.' });
  }
});

// Invite team member
app.post('/api/dashboard/invite', authMiddleware, async (req, res) => {
  if (!req.user.profile || !['supervisor', 'admin'].includes(req.user.profile.role)) {
    return res.status(403).json({ error: 'Supervisor access required.' });
  }
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  try {
    // Check if user already exists
    const { data: existing } = await supabase.from('profiles').select('id').eq('email', email).single();
    if (existing) {
      // Add to org
      await supabase.from('profiles').update({ org_id: req.user.profile.org_id }).eq('id', existing.id);
      res.json({ message: 'User added to your team.' });
    } else {
      // Create invite record
      await supabase.from('invites').insert({
        email,
        org_id: req.user.profile.org_id,
        invited_by: req.user.id,
        created_at: new Date().toISOString()
      });
      res.json({ message: 'Invitation sent. They will be added when they register.' });
    }
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to invite.' });
  }
});

// ========================================
// EMAIL CAPTURE (no auth required)
// ========================================
app.post('/api/email-capture', apiLimiter, async (req, res) => {
  const { email, name, source } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  if (!supabase) {
    console.log('Email captured (no DB):', email, name);
    return res.json({ success: true });
  }
  try {
    await supabase.from('email_captures').upsert(
      { email, name: name || null, source: source || 'landing', captured_at: new Date().toISOString() },
      { onConflict: 'email' }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Email capture error:', err);
    res.json({ success: true }); // Don't fail the UX
  }
});

// ========================================
// AI GRADING (existing - updated)
// ========================================
app.post('/api/grade', apiLimiter, optionalAuth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI grading is not configured on this server.' });
  }
  const { challenge_task, challenge_weak, rubric, student_work, lesson_id, module_id } = req.body;
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
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('Anthropic API error:', response.status, JSON.stringify(err));
      return res.status(502).json({ error: 'Grading service temporarily unavailable.' });
    }
    const data = await response.json();
    const text = data.content?.map(c => c.text || '').join('') || '';
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());

    // Auto-save grade if user is logged in
    if (req.user && supabase && lesson_id) {
      const xpEarned = Math.round(result.score / 10) * 5;
      await supabase.from('grades').insert({
        user_id: req.user.id,
        lesson_id,
        module_id: module_id || null,
        score: result.score,
        rubric_results: result.rubric_results,
        feedback: result.overall_feedback,
        strengths: result.strengths,
        improvements: result.improvements,
        graded_at: new Date().toISOString()
      });
      // Update XP
      const { data: profile } = await supabase.from('profiles').select('xp').eq('id', req.user.id).single();
      await supabase.from('profiles').update({ xp: (profile?.xp || 0) + xpEarned }).eq('id', req.user.id);
      // Update progress
      await supabase.from('progress')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('user_id', req.user.id)
        .eq('lesson_id', lesson_id);
      result.xp_earned = xpEarned;
    }

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

// ========================================
// ROUTES
// ========================================
app.get('/academy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'academy.html'));
});
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
app.listen(PORT, () => {
  console.log(`\n🎓 Prompt AI Academy running at http://localhost:${PORT}`);
  console.log(`   AI Grading: ${ANTHROPIC_API_KEY ? '✅ Active' : '❌ No API key'}`);
  console.log(`   Database:   ${supabase ? '✅ Supabase connected' : '❌ No database — set SUPABASE_URL + SUPABASE_ANON_KEY'}\n`);
});
