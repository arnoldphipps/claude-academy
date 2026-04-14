require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

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
app.use((req, res, next) => {
  if (req.path === '/api/webhook/stripe') return next();
  express.json({ limit: '50kb' })(req, res, next);
});

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
    version: '2.8.0'
  });
});

// ========================================
// STREAK TRACKING
// ========================================
async function updateStreak(userId) {
  if (!supabase) return null;
  try {
    const { data: profile } = await supabase.from('profiles')
      .select('current_streak, longest_streak, last_active_date')
      .eq('id', userId).single();
    if (!profile) return null;

    const today = new Date().toISOString().split('T')[0];
    const lastActive = profile.last_active_date;

    // Already checked in today
    if (lastActive === today) return { current_streak: profile.current_streak, longest_streak: profile.longest_streak, today: true };

    // Calculate yesterday's date
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    let newStreak;
    if (lastActive === yesterdayStr) {
      // Consecutive day — increment streak
      newStreak = (profile.current_streak || 0) + 1;
    } else {
      // Streak broken or first time — start at 1
      newStreak = 1;
    }

    const longestStreak = Math.max(newStreak, profile.longest_streak || 0);

    await supabase.from('profiles').update({
      current_streak: newStreak,
      longest_streak: longestStreak,
      last_active_date: today,
      streak_updated_at: new Date().toISOString()
    }).eq('id', userId);

    return { current_streak: newStreak, longest_streak: longestStreak, today: false, new_day: true };
  } catch (err) {
    console.error('Streak update error:', err);
    return null;
  }
}

app.get('/api/streak', authMiddleware, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles')
      .select('current_streak, longest_streak, last_active_date')
      .eq('id', req.user.id).single();

    // Check if streak is still valid (not broken)
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const lastActive = profile?.last_active_date;

    let currentStreak = profile?.current_streak || 0;
    // If last active was before yesterday, streak is broken
    if (lastActive && lastActive !== today && lastActive !== yesterdayStr) {
      currentStreak = 0;
    }

    res.json({
      current_streak: currentStreak,
      longest_streak: profile?.longest_streak || 0,
      last_active_date: lastActive,
      active_today: lastActive === today
    });
  } catch (err) {
    console.error('Streak error:', err);
    res.json({ current_streak: 0, longest_streak: 0 });
  }
});

app.post('/api/streak/checkin', authMiddleware, async (req, res) => {
  const result = await updateStreak(req.user.id);
  res.json(result || { current_streak: 0, longest_streak: 0 });
});

// ========================================
// ACHIEVEMENT BADGES
// ========================================
const BADGE_DEFS = [
  { id: 'first_steps', name: 'First Steps', emoji: '🎯', desc: 'Submit your first graded challenge', check: (ctx) => ctx.totalGrades >= 1 },
  { id: 'sharp_shooter', name: 'Sharp Shooter', emoji: '🎯', desc: 'Score 80+ on any challenge', check: (ctx) => ctx.bestScore >= 80 },
  { id: 'perfect_score', name: 'Perfect Score', emoji: '💯', desc: 'Score 100 on any challenge', check: (ctx) => ctx.bestScore >= 100 },
  { id: 'comeback_kid', name: 'Comeback Kid', emoji: '📈', desc: 'Improve a score by 15+ points', check: (ctx) => ctx.biggestImprovement >= 15 },
  { id: 'on_fire', name: 'On Fire', emoji: '🔥', desc: 'Maintain a 3-day streak', check: (ctx) => ctx.longestStreak >= 3 },
  { id: 'week_warrior', name: 'Week Warrior', emoji: '⚡', desc: 'Maintain a 7-day streak', check: (ctx) => ctx.longestStreak >= 7 },
  { id: 'month_master', name: 'Month Master', emoji: '🏆', desc: 'Maintain a 30-day streak', check: (ctx) => ctx.longestStreak >= 30 },
  { id: 'persistent', name: 'Persistent', emoji: '💪', desc: 'Submit 10 total graded challenges', check: (ctx) => ctx.totalGrades >= 10 },
  { id: 'dedicated', name: 'Dedicated', emoji: '🏅', desc: 'Submit 25 total graded challenges', check: (ctx) => ctx.totalGrades >= 25 },
  { id: 'half_way', name: 'Half Way There', emoji: '🌟', desc: 'Complete 6 lessons', check: (ctx) => ctx.completedLessons >= 6 },
  { id: 'honor_roll', name: 'Honor Roll', emoji: '🎖️', desc: 'Average best score above 85', check: (ctx) => ctx.avgBestScore >= 85 && ctx.lessonsGraded >= 3 },
  { id: 'graduate', name: 'Graduate', emoji: '🎓', desc: 'Complete all 12 lessons', check: (ctx) => ctx.completedLessons >= 12 },
];

async function checkBadges(userId) {
  if (!supabase) return [];
  try {
    const { data: profile } = await supabase.from('profiles').select('badges, current_streak, longest_streak').eq('id', userId).single();
    const { data: grades } = await supabase.from('grades').select('lesson_id, score').eq('user_id', userId);
    const { data: progress } = await supabase.from('progress').select('lesson_id, status, best_score').eq('user_id', userId);

    const existingBadges = profile?.badges || [];
    const existingIds = existingBadges.map(b => b.id);

    // Build context for badge checks
    const completedLessons = (progress || []).filter(p => p.status === 'completed').length;
    const bestByLesson = {};
    const firstByLesson = {};
    (grades || []).forEach(g => {
      if (!firstByLesson[g.lesson_id]) firstByLesson[g.lesson_id] = g.score;
      if (!bestByLesson[g.lesson_id] || g.score > bestByLesson[g.lesson_id]) bestByLesson[g.lesson_id] = g.score;
    });
    const bestScores = Object.values(bestByLesson);
    const improvements = Object.keys(bestByLesson).map(lid => (bestByLesson[lid] || 0) - (firstByLesson[lid] || 0));

    const ctx = {
      totalGrades: (grades || []).length,
      bestScore: bestScores.length > 0 ? Math.max(...bestScores) : 0,
      avgBestScore: bestScores.length > 0 ? Math.round(bestScores.reduce((s, v) => s + v, 0) / bestScores.length) : 0,
      lessonsGraded: bestScores.length,
      completedLessons,
      longestStreak: profile?.longest_streak || 0,
      currentStreak: profile?.current_streak || 0,
      biggestImprovement: improvements.length > 0 ? Math.max(...improvements) : 0,
    };

    // Check for new badges
    const newBadges = [];
    BADGE_DEFS.forEach(def => {
      if (!existingIds.includes(def.id) && def.check(ctx)) {
        const badge = { id: def.id, name: def.name, emoji: def.emoji, desc: def.desc, earned_at: new Date().toISOString() };
        newBadges.push(badge);
      }
    });

    if (newBadges.length > 0) {
      const allBadges = [...existingBadges, ...newBadges];
      await supabase.from('profiles').update({ badges: allBadges }).eq('id', userId);
    }

    return newBadges;
  } catch (err) {
    console.error('Badge check error:', err);
    return [];
  }
}

app.get('/api/badges', authMiddleware, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles').select('badges').eq('id', req.user.id).single();
    res.json({
      earned: profile?.badges || [],
      available: BADGE_DEFS.map(d => ({ id: d.id, name: d.name, emoji: d.emoji, desc: d.desc }))
    });
  } catch (err) {
    res.json({ earned: [], available: [] });
  }
});


// ========================================
// COMPLETION CERTIFICATES
// ========================================
app.get('/api/certificate/:moduleId', authMiddleware, async (req, res) => {
  const { moduleId } = req.params;
  try {
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', req.user.id).single();
    const { data: progress } = await supabase.from('progress').select('*').eq('user_id', req.user.id);
    const { data: grades } = await supabase.from('grades').select('*').eq('user_id', req.user.id);

    // Module definitions
    const modules = {
      'foundations': { name: 'Module 1: Foundations', lessons: ['m1-intro','m1-anatomy','m1-iteration'], fullName: 'Prompt Engineering Foundations' },
      'power-tools': { name: 'Module 2: Power Tools', lessons: ['m2-report','m2-research','m2-automate'], fullName: 'Power Tools & Real Projects' },
      'connected': { name: 'Module 3: Connected Ecosystem', lessons: ['m3-inbox','m3-sprint','m3-browser'], fullName: 'Connected Ecosystem & Integrations' },
      'expert': { name: 'Module 4: Expert Techniques', lessons: ['m4-chain','m4-app','m4-os'], fullName: 'Expert Techniques & AI Mastery' },
      'all': { name: 'Claude Mastery', lessons: null, fullName: 'Claude Mastery — Complete Course' }
    };

    const mod = modules[moduleId];
    if (!mod) return res.status(404).json({ error: 'Module not found.' });

    // Check completion
    const completedLessons = (progress || []).filter(p => p.status === 'completed').map(p => p.lesson_id);
    const requiredLessons = mod.lessons || Object.values(modules).filter(m => m.lessons).flatMap(m => m.lessons);
    const allDone = requiredLessons.every(l => completedLessons.includes(l));

    if (!allDone) {
      return res.json({ earned: false, completed: completedLessons.length, required: requiredLessons.length });
    }

    // Calculate scores for completed lessons
    const bestByLesson = {};
    (grades || []).forEach(g => {
      if (!bestByLesson[g.lesson_id] || g.score > bestByLesson[g.lesson_id]) bestByLesson[g.lesson_id] = g.score;
    });
    const relevantScores = requiredLessons.map(l => bestByLesson[l] || 0).filter(s => s > 0);
    const avgScore = relevantScores.length > 0 ? Math.round(relevantScores.reduce((s,v) => s+v, 0) / relevantScores.length) : 0;

    // Generate certificate ID
    const certId = Buffer.from(`${req.user.id}-${moduleId}-${Date.now()}`).toString('base64url').substring(0, 16);

    res.json({
      earned: true,
      certificate: {
        id: certId,
        studentName: profile?.name || 'Student',
        moduleName: mod.fullName,
        avgScore,
        lessonsCompleted: requiredLessons.length,
        completedAt: new Date().toISOString(),
        shareUrl: `https://www.promptaiacademy.com/certificate?id=${certId}&name=${encodeURIComponent(profile?.name || 'Student')}&module=${encodeURIComponent(mod.fullName)}&score=${avgScore}&date=${new Date().toISOString().split('T')[0]}`
      }
    });
  } catch (err) {
    console.error('Certificate error:', err);
    res.status(500).json({ error: 'Failed to generate certificate.' });
  }
});



// ========================================
// PUBLIC STATS (no auth required)
// ========================================
app.get('/api/stats', async (req, res) => {
  if (!supabase) return res.json({ users: 0, assessments: 0, grades: 0 });
  try {
    const { count: users } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
    const { count: assessments } = await supabase.from('email_captures').select('*', { count: 'exact', head: true }).eq('source', 'assessment');
    const { count: grades } = await supabase.from('grades').select('*', { count: 'exact', head: true });
    res.json({ users: users || 0, assessments: assessments || 0, grades: grades || 0 });
  } catch (err) {
    res.json({ users: 0, assessments: 0, grades: 0 });
  }
});

// ========================================
// WEEKLY LEADERBOARD
// ========================================
app.get('/api/leaderboard', async (req, res) => {
  if (!supabase) return res.json({ leaderboard: [], period: 'weekly' });
  try {
    // Get all profiles with XP
    const { data: profiles } = await supabase.from('profiles')
      .select('id, name, xp, company, current_streak, badges')
      .order('xp', { ascending: false })
      .limit(20);

    // Get grades from last 7 days for weekly activity
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const { data: recentGrades } = await supabase.from('grades')
      .select('user_id, score, graded_at')
      .gte('graded_at', weekAgo.toISOString());

    // Calculate weekly stats per user
    const weeklyStats = {};
    (recentGrades || []).forEach(g => {
      if (!weeklyStats[g.user_id]) weeklyStats[g.user_id] = { submissions: 0, totalScore: 0, bestScore: 0 };
      weeklyStats[g.user_id].submissions++;
      weeklyStats[g.user_id].totalScore += g.score;
      if (g.score > weeklyStats[g.user_id].bestScore) weeklyStats[g.user_id].bestScore = g.score;
    });

    const leaderboard = (profiles || []).map((p, i) => ({
      rank: i + 1,
      name: p.name || 'Anonymous',
      xp: p.xp || 0,
      company: p.company || '',
      streak: p.current_streak || 0,
      badges: (p.badges || []).length,
      weeklySubmissions: weeklyStats[p.id]?.submissions || 0,
      weeklyAvg: weeklyStats[p.id]?.submissions > 0
        ? Math.round(weeklyStats[p.id].totalScore / weeklyStats[p.id].submissions)
        : 0,
      weeklyBest: weeklyStats[p.id]?.bestScore || 0
    }));

    res.json({ leaderboard, period: 'weekly', generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.json({ leaderboard: [], period: 'weekly' });
  }
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

app.post('/api/auth/reset-password', apiLimiter, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Service unavailable.' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://www.promptaiacademy.com/login'
    });
    // Always return success to prevent email enumeration
    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('Password reset error:', err);
    res.json({ message: 'If that email exists, a reset link has been sent.' });
  }
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
// DRAFTS (save student work across sessions)
// ========================================
app.post('/api/drafts', authMiddleware, async (req, res) => {
  const { lesson_id, module_id, answer } = req.body;
  if (!lesson_id) return res.status(400).json({ error: 'lesson_id required.' });
  try {
    const now = new Date().toISOString();
    // Upsert into progress table with last_answer
    const { data: existing } = await supabase
      .from('progress')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('lesson_id', lesson_id)
      .single();

    if (existing) {
      await supabase.from('progress')
        .update({ last_answer: answer || '', updated_at: now })
        .eq('id', existing.id);
    } else {
      await supabase.from('progress').insert({
        user_id: req.user.id,
        lesson_id,
        module_id: module_id || '',
        status: 'in_progress',
        last_answer: answer || '',
        time_spent_seconds: 0,
        started_at: now,
        created_at: now,
        updated_at: now
      });
    }
    res.json({ saved: true });
  } catch (err) {
    console.error('Draft save error:', err);
    res.json({ saved: false });
  }
});

app.get('/api/drafts', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('progress')
      .select('lesson_id, last_answer, status, best_score')
      .eq('user_id', req.user.id);
    if (error) throw error;
    // Return as a map: { lesson_id: { answer, status, best_score } }
    const drafts = {};
    (data || []).forEach(d => {
      drafts[d.lesson_id] = {
        answer: d.last_answer || '',
        status: d.status,
        best_score: d.best_score || 0
      };
    });
    res.json(drafts);
  } catch (err) {
    console.error('Draft load error:', err);
    res.json({});
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

    // Ensure progress record exists and update best score
    const now = new Date().toISOString();
    const { data: existing } = await supabase.from('progress')
      .select('id, best_score, status')
      .eq('user_id', req.user.id)
      .eq('lesson_id', lesson_id)
      .single();

    if (existing) {
      const update = { updated_at: now };
      if (score > (existing.best_score || 0)) update.best_score = score;
      if (existing.status === 'started') update.status = 'in_progress';
      await supabase.from('progress').update(update).eq('id', existing.id);
    } else {
      await supabase.from('progress').insert({
        user_id: req.user.id,
        lesson_id,
        module_id: module_id || '',
        status: 'in_progress',
        best_score: score,
        time_spent_seconds: 0,
        started_at: now,
        created_at: now,
        updated_at: now
      });
    }

    res.json({ ...data });
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
// STUDENT PERSONAL DASHBOARD
// ========================================
app.get('/api/dashboard/student', authMiddleware, async (req, res) => {
  try {
    // Get profile
    const { data: profile } = await supabase.from('profiles')
      .select('*').eq('id', req.user.id).single();

    // Get all progress
    const { data: progress } = await supabase.from('progress')
      .select('*').eq('user_id', req.user.id).order('updated_at', { ascending: false });

    // Get all grades (every attempt)
    const { data: grades } = await supabase.from('grades')
      .select('*').eq('user_id', req.user.id).order('graded_at', { ascending: true });

    // Compute per-lesson stats
    const lessonStats = {};
    (grades || []).forEach(g => {
      if (!lessonStats[g.lesson_id]) {
        lessonStats[g.lesson_id] = {
          lesson_id: g.lesson_id,
          module_id: g.module_id,
          first_score: g.score,
          best_score: g.score,
          latest_score: g.score,
          attempts: 0,
          first_feedback: g.feedback,
          best_feedback: g.feedback,
          first_strengths: g.strengths,
          best_strengths: g.strengths,
          first_improvements: g.improvements,
          best_improvements: g.improvements,
          first_graded_at: g.graded_at,
          latest_graded_at: g.graded_at,
          scores: []
        };
      }
      const ls = lessonStats[g.lesson_id];
      ls.attempts++;
      ls.latest_score = g.score;
      ls.latest_graded_at = g.graded_at;
      ls.scores.push({ score: g.score, date: g.graded_at });
      if (g.score > ls.best_score) {
        ls.best_score = g.score;
        ls.best_feedback = g.feedback;
        ls.best_strengths = g.strengths;
        ls.best_improvements = g.improvements;
      }
    });

    // Compute progress stats
    const completedLessons = (progress || []).filter(p => p.status === 'completed').length;
    const inProgressLessons = (progress || []).filter(p => p.status === 'in_progress').length;
    const totalTimeSeconds = (progress || []).reduce((sum, p) => sum + (p.time_spent_seconds || 0), 0);

    // Best scores for average calculation
    const bestScores = Object.values(lessonStats).map(ls => ls.best_score);
    const avgBestScore = bestScores.length > 0
      ? Math.round(bestScores.reduce((s, v) => s + v, 0) / bestScores.length)
      : 0;

    // Score improvement (first attempt avg vs best avg)
    const firstScores = Object.values(lessonStats).map(ls => ls.first_score);
    const avgFirstScore = firstScores.length > 0
      ? Math.round(firstScores.reduce((s, v) => s + v, 0) / firstScores.length)
      : 0;

    // Total attempts
    const totalAttempts = (grades || []).length;

    res.json({
      profile: {
        name: profile?.name || 'Student',
        email: profile?.email || '',
        role: profile?.role || 'student',
        xp: profile?.xp || 0,
        company: profile?.company || '',
        created_at: profile?.created_at
      },
      stats: {
        completed_lessons: completedLessons,
        in_progress_lessons: inProgressLessons,
        total_lessons: 12,
        completion_pct: Math.round((completedLessons / 12) * 100),
        avg_best_score: avgBestScore,
        avg_first_score: avgFirstScore,
        improvement: avgBestScore - avgFirstScore,
        total_attempts: totalAttempts,
        lessons_graded: bestScores.length,
        total_time_minutes: Math.round(totalTimeSeconds / 60)
      },
      lessons: lessonStats,
      progress: progress || [],
      grades: grades || []
    });
  } catch (err) {
    console.error('Student dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard.' });
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
      const inProgressLessons = memberProgress.filter(p => p.status === 'in_progress').length;
      const totalTimeSeconds = memberProgress.reduce((sum, p) => sum + (p.time_spent_seconds || 0), 0);
      
      // Use BEST score per lesson, not average of all attempts
      const bestByLesson = {};
      memberGrades.forEach(g => {
        if (!bestByLesson[g.lesson_id] || g.score > bestByLesson[g.lesson_id]) {
          bestByLesson[g.lesson_id] = g.score;
        }
      });
      const bestScores = Object.values(bestByLesson);
      const avgScore = bestScores.length > 0
        ? Math.round(bestScores.reduce((sum, s) => sum + s, 0) / bestScores.length)
        : 0;

      return {
        ...member,
        completed_lessons: completedLessons,
        in_progress_lessons: inProgressLessons,
        total_lessons: 12,
        completion_pct: Math.round((completedLessons / 12) * 100),
        total_time_minutes: Math.round(totalTimeSeconds / 60),
        avg_score: avgScore,
        lessons_graded: bestScores.length,
        total_attempts: memberGrades.length,
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
  const systemPrompt = `You are Professor Claude, an expert AI tutor grading a prompt engineering exercise. Be warm but rigorous. Respond ONLY with JSON (no markdown fences):\n{"score":<0-100>,"rubric_results":[true/false per rubric item],"overall_feedback":"2-3 sentences","strengths":["..."],"improvements":["..."],"passing":<true if score>=70>,"communication_tip":"One sentence connecting this AI communication skill to a real-world professional communication scenario — show the student how this skill applies to emails, meetings, presentations, or leadership."}`;
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
      // Update daily streak
      const streakResult = await updateStreak(req.user.id);
      if (streakResult) result.streak = streakResult;
      // Check for new badges
      const newBadges = await checkBadges(req.user.id);
      if (newBadges.length > 0) result.new_badges = newBadges;
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
// STRIPE PAYMENTS
// ========================================
const STRIPE_PRICES = {
  pro: { name: 'Pro Monthly', price: 2900, interval: 'month' },
  team: { name: 'Team Monthly (per seat)', price: 1900, interval: 'month' }
};

app.post('/api/checkout', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });
  const { plan } = req.body;
  const priceInfo = STRIPE_PRICES[plan];
  if (!priceInfo) return res.status(400).json({ error: 'Invalid plan.' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: req.user.email,
      metadata: { user_id: req.user.id, plan },
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: priceInfo.name, description: 'Prompt AI Academy - ' + priceInfo.name },
          unit_amount: priceInfo.price,
          recurring: { interval: priceInfo.interval }
        },
        quantity: 1
      }],
      success_url: 'https://www.promptaiacademy.com/academy?payment=success',
      cancel_url: 'https://www.promptaiacademy.com/academy?payment=cancelled',
      allow_promotion_codes: true
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).send();
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  try {
    let event;
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.user_id;
      const plan = session.metadata?.plan || 'pro';
      
      if (userId && supabase) {
        await supabase.from('profiles').update({
          plan: plan,
          stripe_customer_id: session.customer,
          subscription_status: 'active',
          subscription_updated_at: new Date().toISOString()
        }).eq('id', userId);
        console.log('Subscription activated for user:', userId, 'plan:', plan);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      if (supabase) {
        await supabase.from('profiles').update({
          plan: 'free',
          subscription_status: 'cancelled',
          subscription_updated_at: new Date().toISOString()
        }).eq('stripe_customer_id', subscription.customer);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).send('Webhook error');
  }
});

app.get('/api/subscription', authMiddleware, async (req, res) => {
  try {
    const { data: profile } = await supabase.from('profiles')
      .select('plan, subscription_status, stripe_customer_id')
      .eq('id', req.user.id).single();
    res.json({
      plan: profile?.plan || 'free',
      status: profile?.subscription_status || 'none',
      hasAccess: ['pro', 'team', 'admin'].includes(profile?.plan) || profile?.role === 'admin'
    });
  } catch (err) {
    res.json({ plan: 'free', status: 'none', hasAccess: false });
  }
});


// ADMIN: Manual plan upgrade (temporary - remove after webhook setup)
app.post('/api/admin/upgrade', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { email, plan, admin_key } = req.body;
  // Simple admin key check
  if (admin_key !== 'pai-admin-2026') return res.status(403).json({ error: 'Unauthorized' });
  try {
    const { data: profiles } = await supabase.from('profiles').select('id, email').eq('email', email);
    if (!profiles || profiles.length === 0) return res.status(404).json({ error: 'User not found' });
    const { data, error } = await supabase.from('profiles').update({
      plan: plan || 'pro',
      subscription_status: 'active',
      subscription_updated_at: new Date().toISOString()
    }).eq('email', email);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, message: `${email} upgraded to ${plan || 'pro'}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// ROUTES
// ========================================
app.get('/academy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'academy.html'));
});
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.get('/assessment', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'assessment.html'));
});
app.get('/certificate', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'certificate.html'));
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
