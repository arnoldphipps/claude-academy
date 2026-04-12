#!/bin/bash
# ═══════════════════════════════════════════════════════════
# CLAUDE ACADEMY — Automated Project Setup & Sync
# ═══════════════════════════════════════════════════════════
# 
# This script does EVERYTHING:
#   1. Creates the full project structure
#   2. Initializes Git with auto-commit
#   3. Sets up GitHub connection
#   4. Installs dependencies
#   5. Creates deployment configs
#   6. Sets up file-watch auto-save
#
# USAGE:
#   chmod +x setup.sh
#   ./setup.sh
#
# ═══════════════════════════════════════════════════════════

set -e
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

echo ""
echo -e "${BLUE}${BOLD}🎓 Claude Academy — Automated Setup${NC}"
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""

# ── Step 1: Create project directory ──
PROJECT_DIR="$HOME/claude-academy"
echo -e "${GREEN}[1/8]${NC} Creating project at ${BOLD}$PROJECT_DIR${NC}"

mkdir -p "$PROJECT_DIR"/{public,scripts,docs}
cd "$PROJECT_DIR"

# ── Step 2: Initialize Git ──
echo -e "${GREEN}[2/8]${NC} Initializing Git repository"

if [ ! -d ".git" ]; then
  git init
  echo "node_modules/" > .gitignore
  echo ".env" >> .gitignore
  echo ".DS_Store" >> .gitignore
  echo "*.log" >> .gitignore
fi

# ── Step 3: Create package.json ──
echo -e "${GREEN}[3/8]${NC} Creating package.json"

cat > package.json << 'EOF'
{
  "name": "claude-academy",
  "version": "1.0.0",
  "description": "Enterprise AI training platform — beginner to Claude expert",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "save": "node scripts/auto-save.js",
    "deploy:railway": "railway up",
    "deploy:render": "echo 'Push to GitHub — Render auto-deploys from main branch'",
    "backup": "node scripts/backup.js",
    "sync": "node scripts/sync-to-github.js",
    "update-state": "node scripts/update-state.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "helmet": "^7.1.0",
    "express-rate-limit": "^7.1.4"
  },
  "devDependencies": {
    "chokidar": "^3.5.3"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
EOF

# ── Step 4: Create auto-save watcher ──
echo -e "${GREEN}[4/8]${NC} Creating auto-save automation scripts"

cat > scripts/auto-save.js << 'SCRIPT'
/**
 * AUTO-SAVE WATCHER
 * 
 * Watches your project files and automatically:
 *   1. Commits changes to Git
 *   2. Pushes to GitHub (if configured)
 *   3. Updates the project state file
 * 
 * Run with: npm run save
 */

const { execSync } = require('child_process');
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = path.resolve(__dirname, '..');
const DEBOUNCE_MS = 5000; // Wait 5 seconds of quiet before saving
let timeout = null;
let changeCount = 0;

console.log('\n🎓 Claude Academy — Auto-Save Active');
console.log('════════════════════════════════════');
console.log('Watching for file changes...\n');

const watcher = chokidar.watch(PROJECT_DIR, {
  ignored: [
    /node_modules/,
    /\.git/,
    /\.env/,
    /\.log$/,
  ],
  persistent: true,
  ignoreInitial: true,
});

function autoSave() {
  try {
    // Stage all changes
    execSync('git add -A', { cwd: PROJECT_DIR, stdio: 'pipe' });

    // Check if there are changes to commit
    const status = execSync('git status --porcelain', { cwd: PROJECT_DIR }).toString().trim();
    if (!status) {
      console.log(`  ⏭  No changes to save`);
      return;
    }

    // Count changes
    const lines = status.split('\n').length;
    const timestamp = new Date().toLocaleString();

    // Commit
    const msg = `auto-save: ${lines} file(s) changed at ${timestamp}`;
    execSync(`git commit -m "${msg}"`, { cwd: PROJECT_DIR, stdio: 'pipe' });
    console.log(`  ✅ Saved: ${msg}`);

    // Push to GitHub if remote exists
    try {
      const remote = execSync('git remote get-url origin', { cwd: PROJECT_DIR, stdio: 'pipe' }).toString().trim();
      if (remote) {
        execSync('git push origin main 2>/dev/null || git push origin master 2>/dev/null', { cwd: PROJECT_DIR, stdio: 'pipe' });
        console.log(`  ☁️  Pushed to GitHub`);
      }
    } catch {
      // No remote configured — that's fine
    }

    // Update project state file
    updateProjectState();

    changeCount = 0;
  } catch (err) {
    console.log(`  ⚠️  Save issue: ${err.message}`);
  }
}

function updateProjectState() {
  const stateFile = path.join(PROJECT_DIR, 'docs', 'PROJECT_STATE.md');
  const files = [];

  function walk(dir, prefix = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (['node_modules', '.git', '.env'].includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else {
        const stat = fs.statSync(fullPath);
        files.push({
          path: relPath,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }
    }
  }

  walk(PROJECT_DIR);

  const state = `# Claude Academy — Project State
# Generated: ${new Date().toISOString()}
# Upload this file to any Claude conversation to restore full context.

## Project Overview
- **Name**: Claude Academy
- **Type**: Enterprise AI Training Platform
- **Stack**: Node.js, Express, Vanilla JS, Anthropic API
- **Status**: Active Development

## File Inventory (${files.length} files)
${files.map(f => `- \`${f.path}\` (${(f.size / 1024).toFixed(1)}KB)`).join('\n')}

## Architecture
- \`server.js\` — Express backend with API proxy endpoints
- \`public/index.html\` — Marketing landing page with ROI calculator
- \`public/academy.html\` — Full training application (12 lessons, AI grading)
- \`scripts/\` — Automation tools (auto-save, backup, sync)
- \`docs/\` — Project state and documentation

## Key Endpoints
- \`GET  /\` — Landing page
- \`GET  /academy\` — Training app
- \`GET  /api/health\` — Server health check
- \`POST /api/grade\` — AI grading endpoint
- \`POST /api/help\` — AI coaching endpoint
- \`POST /api/generate-challenge\` — Dynamic challenge generation

## Current Priorities
1. Deploy to production (Railway/Render)
2. Add Stripe payment integration
3. Add user accounts with progress persistence
4. Build pitch deck for Anthropic partnership
5. Launch on Product Hunt

## Revenue Model
- Free tier: 3 lessons
- Pro: $29/month (all lessons + AI grading + certificates)
- Enterprise: Custom pricing (team management, SSO, analytics)
`;

  fs.writeFileSync(stateFile, state);
}

watcher.on('all', (event, filePath) => {
  changeCount++;
  const rel = path.relative(PROJECT_DIR, filePath);
  console.log(`  📝 ${event}: ${rel}`);

  // Debounce — wait for quiet period before saving
  clearTimeout(timeout);
  timeout = setTimeout(autoSave, DEBOUNCE_MS);
});

// Initial state update
updateProjectState();
console.log('  📋 Project state file updated');
console.log('  💡 Edit any file — auto-save triggers after 5 seconds of quiet\n');
SCRIPT

# ── Step 5: Create backup script ──
cat > scripts/backup.js << 'SCRIPT'
/**
 * BACKUP SCRIPT
 * Creates a timestamped zip of the entire project
 * Run with: npm run backup
 */

const { execSync } = require('child_process');
const path = require('path');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupName = `claude-academy-backup-${timestamp}.zip`;
const backupDir = path.join(process.env.HOME || '.', 'claude-academy-backups');
const projectDir = path.resolve(__dirname, '..');

try {
  execSync(`mkdir -p "${backupDir}"`);
  execSync(
    `cd "${projectDir}" && zip -r "${backupDir}/${backupName}" . -x "node_modules/*" ".git/*"`,
    { stdio: 'inherit' }
  );
  console.log(`\n✅ Backup saved: ${backupDir}/${backupName}\n`);
} catch (err) {
  console.error('Backup failed:', err.message);
}
SCRIPT

# ── Step 6: Create GitHub sync helper ──
cat > scripts/sync-to-github.js << 'SCRIPT'
/**
 * GITHUB SYNC HELPER
 * Sets up GitHub remote and pushes
 * Run with: npm run sync
 */

const { execSync } = require('child_process');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('\n🎓 Claude Academy — GitHub Sync Setup\n');

rl.question('GitHub repository URL (e.g., https://github.com/you/claude-academy.git): ', (url) => {
  if (!url.trim()) {
    console.log('No URL provided. Skipping.');
    rl.close();
    return;
  }

  try {
    // Check if remote already exists
    try {
      execSync('git remote get-url origin', { stdio: 'pipe' });
      execSync(`git remote set-url origin ${url.trim()}`, { stdio: 'inherit' });
      console.log('Updated existing remote.');
    } catch {
      execSync(`git remote add origin ${url.trim()}`, { stdio: 'inherit' });
      console.log('Added remote.');
    }

    // Ensure we have a commit
    try {
      execSync('git log --oneline -1', { stdio: 'pipe' });
    } catch {
      execSync('git add -A && git commit -m "Initial commit — Claude Academy"', { stdio: 'inherit' });
    }

    // Push
    execSync('git branch -M main', { stdio: 'pipe' });
    execSync('git push -u origin main', { stdio: 'inherit' });
    console.log('\n✅ Pushed to GitHub successfully!\n');
    console.log('Auto-save will now push changes automatically.\n');
  } catch (err) {
    console.error('Error:', err.message);
    console.log('\nManual steps:');
    console.log('  1. Create a repo at github.com');
    console.log('  2. Run: git remote add origin <your-url>');
    console.log('  3. Run: git push -u origin main\n');
  }

  rl.close();
});
SCRIPT

# ── Step 7: Create environment template ──
echo -e "${GREEN}[5/8]${NC} Creating configuration files"

cat > .env.example << 'EOF'
# Claude Academy — Environment Variables
# Copy to .env: cp .env.example .env

# Required: Your Anthropic API key
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here

# Optional: Server port (default 3000)
PORT=3000

# Optional: Stripe keys (for payment processing)
# STRIPE_SECRET_KEY=sk_test_...
# STRIPE_PUBLISHABLE_KEY=pk_test_...
# STRIPE_WEBHOOK_SECRET=whsec_...

# Optional: Database (for user accounts)
# DATABASE_URL=postgresql://...
EOF

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo -e "  ${YELLOW}⚠  Created .env — add your ANTHROPIC_API_KEY${NC}"
fi

# ── Step 8: Create Railway deployment config ──
cat > railway.json << 'EOF'
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "node server.js",
    "healthcheckPath": "/api/health",
    "restartPolicyType": "ON_FAILURE"
  }
}
EOF

# Render deployment config
cat > render.yaml << 'EOF'
services:
  - type: web
    name: claude-academy
    env: node
    plan: free
    buildCommand: npm install
    startCommand: node server.js
    healthCheckPath: /api/health
    envVars:
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: NODE_ENV
        value: production
EOF

# ── Step 9: Create the project state document ──
echo -e "${GREEN}[6/8]${NC} Creating project state document"

cat > docs/PROJECT_STATE.md << 'EOF'
# Claude Academy — Project State
# Upload this file to any new Claude conversation for instant context.

## Project Overview
- **Name**: Claude Academy
- **Type**: Enterprise AI Training Platform  
- **Stack**: Node.js, Express, Vanilla JS, Anthropic API
- **Revenue**: Free / Pro $29mo / Enterprise custom
- **Status**: MVP Ready — Needs deployment

## What's Built
- ✅ Landing page with ROI calculator and pricing
- ✅ Full 12-lesson training app with 4 modules
- ✅ Live AI grading via Anthropic API
- ✅ Smart hints / coaching system
- ✅ Infinite AI-generated bonus challenges
- ✅ XP progression system (Beginner → Master)
- ✅ Admin analytics dashboard (demo)
- ✅ Completion certificate
- ✅ Express backend with rate limiting
- ✅ Auto-save and GitHub sync automation

## What's Next
- [ ] Deploy to Railway/Render (live URL)
- [ ] Stripe integration (accept payments)
- [ ] User accounts + database (save progress)
- [ ] PDF certificate generation
- [ ] Anthropic partnership pitch deck
- [ ] Product Hunt launch
- [ ] Enterprise SSO
- [ ] LMS integration (SCORM)

## How to Give Claude Context
Upload this file + any changed source files to a Claude Project 
called "Claude Academy Development" with these instructions:

"You are the lead architect of Claude Academy. Build production-ready 
code. Reference uploaded files as the current codebase. Maintain 
the existing architecture and design language."
EOF

# ── Step 10: Create quick-reference card ──
cat > docs/QUICK_COMMANDS.md << 'EOF'
# Claude Academy — Quick Commands

## Daily Development
```bash
npm run dev          # Start dev server (auto-restart on changes)
npm run save         # Start auto-save watcher (Git + GitHub)
npm start            # Start production server
```

## Saving & Backup
```bash
npm run save         # Watch files → auto-commit → auto-push
npm run backup       # Create timestamped zip backup
npm run sync         # Set up / push to GitHub
```

## Deployment
```bash
npm run deploy:railway    # Deploy to Railway
git push origin main      # Triggers Render auto-deploy
```

## Working with Claude
1. Open your "Claude Academy Development" Project
2. Upload any changed files
3. Describe what you want to build next
4. Download the files Claude gives you
5. Save to your project folder → auto-save handles the rest

## Adding Your API Key
```bash
cp .env.example .env
# Edit .env and add: ANTHROPIC_API_KEY=sk-ant-api03-...
```
EOF

# ── Step 11: Install dependencies ──
echo -e "${GREEN}[7/8]${NC} Installing dependencies"

if command -v npm &> /dev/null; then
  npm install 2>/dev/null && echo -e "  ✅ Dependencies installed" || echo -e "  ${YELLOW}⚠  Run 'npm install' manually${NC}"
else
  echo -e "  ${YELLOW}⚠  Node.js not found. Install from https://nodejs.org${NC}"
fi

# ── Step 12: Initial Git commit ──
echo -e "${GREEN}[8/8]${NC} Creating initial commit"

git add -A 2>/dev/null
git commit -m "🎓 Claude Academy — Initial setup with auto-save automation" 2>/dev/null || true

# ── Done ──
echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✅ Claude Academy is ready!${NC}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Project location:${NC} $PROJECT_DIR"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo -e "  1. Add your API key:  ${BLUE}nano .env${NC}"
echo -e "  2. Start the server:  ${BLUE}npm run dev${NC}"
echo -e "  3. Start auto-save:   ${BLUE}npm run save${NC}  (in a second terminal)"
echo -e "  4. Open in browser:   ${BLUE}http://localhost:3000${NC}"
echo ""
echo -e "  ${BOLD}Connect to GitHub:${NC}"
echo -e "  ${BLUE}npm run sync${NC}"
echo ""
echo -e "  ${BOLD}Create a backup:${NC}"
echo -e "  ${BLUE}npm run backup${NC}"
echo ""
echo -e "  ${BOLD}For Claude conversations:${NC}"
echo -e "  Upload ${BLUE}docs/PROJECT_STATE.md${NC} to any new chat for instant context."
echo ""
