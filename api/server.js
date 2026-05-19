#!/bin/bash
# AWFLMETA API Server — Deployment Guide for Render
# Author: Emmanuel Deliver Amable
# Organization: AEDTP WORLD

cat << 'EOF'

╔═══════════════════════════════════════════════════════════════════════╗
║                                                                       ║
║         AWFLMETA API SERVER v2.0 — RENDER DEPLOYMENT GUIDE           ║
║                                                                       ║
║              AEDTP WORLD FREE LICENSE (AWFL) v1.0.0                   ║
║                                                                       ║
╚═══════════════════════════════════════════════════════════════════════╝

📦 QUICK START

This guide walks you through deploying the AWFLMETA API Server to Render.com
with automated GitHub integration for content management.

═══════════════════════════════════════════════════════════════════════════

STEP 1: CREATE GITHUB PERSONAL ACCESS TOKEN (PAT)
───────────────────────────────────────────────────

This token allows the API server to read/write content to your GitHub repo.

1. Go to: https://github.com/settings/tokens

2. Click: "Generate new token" → "Generate new token (classic)"

3. Configure:
   └─ Token name:   "awflmeta-api-render"
   └─ Expiration:   90 days (or custom)
   └─ Scopes:       ✓ repo (full control of private repositories)
                    └─ Required for: repo, public_repo

4. Click "Generate token"

⚠️  IMPORTANT: Copy the token immediately — you won't see it again!
    Save it temporarily: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

═══════════════════════════════════════════════════════════════════════════

STEP 2: PREPARE YOUR GITHUB REPOSITORY
───────────────────────────────────────

Ensure your repo structure includes:

awflmeta/
├── api/
│   └── server.js           ← Node.js API server
├── package.json            ← Node dependencies
├── ai/
│   ├── index.json          ← Category index
│   └── *.html              ← Wiki pages
├── apps/
│   ├── index.json
│   └── *.html
├── artists/
│   ├── index.json
│   └── *.html
├── ... (other categories)
├── awfl/
│   ├── index.json
│   └── *.html
├── images/
│   └── *.jpg, *.png        ← Uploaded images
├── README.md
└── .gitignore

The server expects:
- Category directories: ai, apps, artists, bible, biography, business,
  developer, dictionary, education, legacy, music, news, awfl
- Each category has: index.json (array of page metadata)
- Images directory for uploads

═══════════════════════════════════════════════════════════════════════════

STEP 3: SET UP PACKAGE.JSON
────────────────────────────

If not already present, create package.json in repo root:

{
  "name": "awflmeta",
  "version": "2.0.0",
  "description": "AEDTP WORLD WIKI METADATA Engine",
  "main": "api/server.js",
  "scripts": {
    "start": "node api/server.js",
    "dev": "node api/server.js"
  },
  "keywords": ["wiki", "metadata", "aedtp", "awfl"],
  "author": "AEDTP WORLD",
  "license": "AWFL-1.0",
  "engines": {
    "node": ">=18.0.0"
  }
}

No external dependencies required — using Node.js built-ins only!

═══════════════════════════════════════════════════════════════════════════

STEP 4: CREATE RENDER SERVICE
──────────────────────────────

1. Go to: https://dashboard.render.com

2. Sign up or log in

3. Click: "New +" → "Web Service"

4. Connect GitHub:
   └─ Click "Connect account" if not already authenticated
   └─ Select: aedtpworldawfl/awflmeta repository
   └─ Click "Connect"

5. Configure service:

   Field              │ Value
   ──────────────────┼──────────────────────────────────
   Name              │ awflmeta-api
   Environment       │ Node
   Region            │ (closest to you, or N. California)
   Build Command     │ npm install
   Start Command     │ node api/server.js
   Instance Type     │ Free (or Starter Pro for production)

6. Click: "Create Web Service"

   ⏳ Render will start building and deploying automatically.
      This takes 2-5 minutes. You'll see a build log.

═══════════════════════════════════════════════════════════════════════════

STEP 5: ADD ENVIRONMENT VARIABLES
──────────────────────────────────

After creating the service, go to the "Environment" tab and add these:

Variable Name      │ Value
──────────────────┼──────────────────────────────────────────────────
GH_TOKEN          │ ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GH_OWNER          │ aedtpworldawfl
GH_REPO           │ awflmeta
GH_BRANCH         │ main
NODE_ENV          │ production

Detailed explanation:

┌─ GH_TOKEN (Required)
│  └─ Your GitHub Personal Access Token (from Step 1)
│     ⚠️  Keep this SECRET — never share or commit it!
│
├─ GH_OWNER (Required)
│  └─ GitHub username: aedtpworldawfl
│
├─ GH_REPO (Required)
│  └─ Repository name: awflmeta
│
├─ GH_BRANCH (Optional, defaults to 'main')
│  └─ Git branch: main or master
│     └─ Must exist in your repository!
│
└─ NODE_ENV (Optional, defaults to 'production')
   └─ production ← deployment
   └─ development ← local testing with verbose logging

After entering variables, click "Save"

═══════════════════════════════════════════════════════════════════════════

STEP 6: DEPLOY & TEST
─────────────────────

Render will automatically deploy after:
1. You add environment variables
2. Service finishes initial build

Check status:
- ✓ Green indicator = deployed successfully
- 🔴 Red indicator = failed (check build logs)

Your API URL will be:
    https://awflmeta-api.onrender.com

Test it:
1. Visit: https://awflmeta-api.onrender.com/api/health
   └─ Should show a JSON response with server info

2. Or use curl:
   $ curl https://awflmeta-api.onrender.com/api/health

═══════════════════════════════════════════════════════════════════════════

STEP 7: CONFIGURE GITHUB WEBHOOK (OPTIONAL)
────────────────────────────────────────────

This auto-redeploys your API when you push to the repository.

1. In Render dashboard, go to your service
2. Settings tab → find "GitHub Webhook"
3. Copy webhook URL
4. Go to: https://github.com/aedtpworldawfl/awflmeta/settings/hooks
5. Click "Add webhook"
6. Paste URL from Render
7. Choose "Push" events
8. Click "Add webhook"

Now every git push triggers automatic redeployment! ✓

═══════════════════════════════════════════════════════════════════════════

API ENDPOINTS (After Deployment)
─────────────────────────────────

GET /api/health
  └─ Health check & diagnostics

GET /api/stats
  └─ Server statistics

POST /api/awflmeta/publish
  └─ Create/update wiki page
     Body: { slug, title, category, wikiHTML, author, description, tags }

POST /api/upload/image
  └─ Upload image (JPEG/PNG, max 5MB)
     Format: multipart/form-data with 'image' field

GET /api/awflmeta/pages
  └─ List pages (optionally filter by ?category=CATEGORY)

GET /api/awflmeta/page/:category/:slug
  └─ Get single page metadata

POST /api/cache/clear
  └─ Clear index cache (?category=CATEGORY optional)

Examples:

  # Health check
  curl https://awflmeta-api.onrender.com/api/health

  # List music pages
  curl "https://awflmeta-api.onrender.com/api/awflmeta/pages?category=music"

  # Publish new page
  curl -X POST https://awflmeta-api.onrender.com/api/awflmeta/publish \
    -H "Content-Type: application/json" \
    -d '{
      "slug": "My_New_Page",
      "title": "My New Page",
      "category": "music",
      "wikiHTML": "<h1>Title</h1><p>Content...</p>",
      "author": "Your Name"
    }'

═══════════════════════════════════════════════════════════════════════════

MONITORING & LOGS
─────────────────

View logs in Render dashboard:
1. Select your service: awflmeta-api
2. Click "Logs" tab
3. See real-time server output

Common log messages:

✓ "[awflmeta] API server running on port 10000"
  └─ Server started successfully

✓ "[awflmeta] Repo: aedtpworldawfl/awflmeta @ main"
  └─ GitHub connection configured

✓ "[awflmeta] GitHub Token: ✓ Configured"
  └─ Auth token is valid

⚠️  "[awflmeta] WARNING: GH_TOKEN is not set"
  └─ Token not configured in environment variables

❌ "Cannot read property 'content' of undefined"
  └─ GitHub API error (check GH_OWNER, GH_REPO, GH_BRANCH)

═══════════════════════════════════════════════════════════════════════════

TROUBLESHOOTING
───────────────

Problem: Service won't start
┌─ Check package.json exists in repo root
├─ Verify start command: "node api/server.js"
└─ Review build logs in Render dashboard

Problem: "GH_TOKEN is missing" error
┌─ Add GH_TOKEN to environment variables in Render
├─ Ensure token has 'repo' scope
└─ Redeploy service after adding variable

Problem: "Bad credentials" from GitHub
┌─ Token may be expired or revoked
├─ Generate new token at https://github.com/settings/tokens
└─ Update GH_TOKEN and redeploy

Problem: "Cannot find module" error
┌─ Ensure package.json exists
├─ Run: npm install (locally)
└─ Commit package-lock.json to repo

Problem: Slow response times
┌─ Check memory usage: /api/stats
├─ Clear cache: POST /api/cache/clear
└─ Consider upgrading instance type

Problem: 404 Not Found on endpoints
┌─ Verify API URL: https://awflmeta-api.onrender.com
├─ Check endpoint path: /api/awflmeta/publish
└─ See API documentation for correct routes

═══════════════════════════════════════════════════════════════════════════

PERFORMANCE OPTIMIZATION
────────────────────────

Production settings:

# In Render Environment variables:
NODE_ENV=production

# In server.js (already configured):
- In-memory caching: 5-minute TTL on index files
- Rate limiting: 100 requests/minute per IP
- Connection pooling: Kept-alive HTTPS to GitHub
- Request timeout: 30 seconds

To increase rate limit:
1. Edit server.js line ~50:
   const RATE_LIMIT = { maxRequests: 1000, windowMs: 60000 }

2. Commit and push to trigger redeployment

═══════════════════════════════════════════════════════════════════════════

SECURITY BEST PRACTICES
───────────────────────

✓ Never commit GH_TOKEN to version control
✓ Rotate token every 90 days
✓ Use GitHub webhook for auto-deploy (skip manual commits)
✓ Monitor /api/stats for abuse
✓ Keep Render service instance updated
✓ Review server logs regularly for errors

═══════════════════════════════════════════════════════════════════════════

SUPPORT & RESOURCES
───────────────────

Documentation:
  ├─ API Docs: See API_DOCUMENTATION.md
  ├─ Server Code: api/server.js
  └─ GitHub: https://github.com/aedtpworldawfl/awflmeta

Support:
  ├─ Email: aedtpworld@gmail.com
  ├─ Creator: Emmanuel Deliver Amable
  └─ License: AEDTP WORLD FREE LICENSE (AWFL) v1.0.0

═══════════════════════════════════════════════════════════════════════════

✅ YOU'RE DONE!

Your AWFLMETA API Server is now live and ready to:
  • Publish wiki content to 13 categories
  • Upload and serve images
  • Manage metadata indexes
  • Scale automatically with Render

Start publishing by POSTing to: /api/awflmeta/publish

Questions? Contact: aedtpworld@gmail.com

═══════════════════════════════════════════════════════════════════════════

Version: 2.0.0
Last Updated: May 19, 2026
Platform: Render (render.com)
Node.js: 18+ recommended

EOF
