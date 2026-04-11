# 🎓 Claude Academy

**The interactive training platform that turns beginners into Claude power users.**

12 lessons, 4 modules, real-world projects, live AI grading, infinite AI-generated bonus challenges.

![Claude Academy](https://img.shields.io/badge/Claude-Academy-blue) ![Node](https://img.shields.io/badge/node-%3E%3D18-green) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## What It Does

- **Live AI Grading** — Students submit prompt engineering exercises and get scored by Claude with detailed rubric breakdowns, strengths, and improvement suggestions
- **Smart Hints** — Stuck students get targeted nudges that guide without giving away answers
- **Infinite Challenges** — AI-generated bonus challenges keep training fresh with new scenarios every time
- **Real Projects** — Build competitive analyses, automated workflows, sprint plans, and full web apps
- **XP & Progression** — Track growth from 🌱 Beginner to 👑 Master

## Quick Start

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd claude-academy
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and add your Anthropic API key:
```
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
```

Get a key at: https://console.anthropic.com/settings/keys

### 3. Run

```bash
npm start
```

Visit **http://localhost:3000** — that's it!

- Landing page: `http://localhost:3000`
- Academy app: `http://localhost:3000/academy`

---

## Deploy to Production

### Option A: Railway (Easiest)

1. Push code to GitHub
2. Go to [railway.app](https://railway.app)
3. New Project → Deploy from GitHub
4. Add environment variable: `ANTHROPIC_API_KEY`
5. Done — Railway gives you a public URL

### Option B: Render

1. Push to GitHub
2. Go to [render.com](https://render.com)
3. New Web Service → connect your repo
4. Build command: `npm install`
5. Start command: `node server.js`
6. Add `ANTHROPIC_API_KEY` in environment settings

### Option C: Fly.io

```bash
fly launch
fly secrets set ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
fly deploy
```

### Option D: VPS (DigitalOcean, AWS, etc.)

```bash
# On your server
git clone <repo> && cd claude-academy
npm install
cp .env.example .env  # edit with your key
npm start  # or use PM2: pm2 start server.js
```

Use nginx as a reverse proxy for HTTPS.

---

## Project Structure

```
claude-academy/
├── server.js           # Express backend with API proxy
├── package.json
├── .env.example        # Environment template
├── .gitignore
└── public/
    ├── index.html      # Landing page
    └── academy.html    # Training application
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Server status + grading availability |
| `/api/grade` | POST | Grade a student submission |
| `/api/help` | POST | Get a hint for a challenge |
| `/api/generate-challenge` | POST | Generate a new AI challenge |

All AI endpoints are rate-limited to 60 requests per 15 minutes per IP.

---

## Cost Estimate

Each grading call uses Claude Sonnet (~500 input tokens, ~300 output tokens).

- **Per grading**: ~$0.003
- **Per student completing all 12 lessons**: ~$0.05
- **1,000 students**: ~$50 in API costs

This is extremely cost-efficient for an AI-powered training platform.

---

## Roadmap Ideas

- [ ] User accounts & progress persistence (database)
- [ ] Leaderboard across students
- [ ] Certificate of completion (PDF generation)
- [ ] Team/enterprise admin dashboard
- [ ] More modules: Claude Code, API development, MCP servers
- [ ] Community challenges (students create challenges for each other)

---

## License

MIT — use it, modify it, deploy it.
