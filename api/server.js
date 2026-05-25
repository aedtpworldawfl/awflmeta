/**
 * AWFLMETA API SERVER — Fixed & Hardened
 * Deploy on Render (Node.js 18+)
 *
 * Required environment variables (set in Render dashboard — NEVER hardcode):
 *   GH_TOKEN   — GitHub Personal Access Token with repo write scope
 *   GH_OWNER   — aedtpworldawfl
 *   GH_REPO    — awflmeta
 *   GH_BRANCH  — main
 *   PORT       — set automatically by Render
 *   NODE_ENV   — production
 *
 * FIX LOG:
 *   1. Removed hardcoded GH_TOKEN from source (critical security fix)
 *   2. All categories now share ONE unified index at awfl/index.json
 *      (matches what the frontend fetches from AWFL_INDEX_URL)
 *   3. Upload response now always returns { fileName, url } at top level
 *      (was nested under data.data, breaking the frontend)
 *   4. Rate limit map now auto-cleans to prevent memory leak
 *   5. CORS wildcard option for development; strict in production
 *   6. Health endpoint includes token presence check without leaking value
 *   7. Added /api/awflmeta/delete endpoint
 *   8. Improved error messages with actionable hints
 */

'use strict';

const http   = require('http');
const https  = require('https');
const urlMod = require('url');
const path   = require('path');
const crypto = require('crypto');

/* ─── ENVIRONMENT — never hardcode secrets here ─── */
const GH_TOKEN  = process.env.GH_TOKEN;   // REQUIRED — set in Render dashboard
const GH_OWNER  = process.env.GH_OWNER  || 'aedtpworldawfl';
const GH_REPO   = process.env.GH_REPO   || 'awflmeta';
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const PORT      = parseInt(process.env.PORT || '10000', 10);
const NODE_ENV  = process.env.NODE_ENV  || 'production';

/* ─── UNIFIED INDEX PATH
   The frontend fetches:  awflmeta/awfl/index.json  (AWFL_INDEX_URL)
   The server must write: awfl/index.json
   All categories share this one index — pages carry a "category" field.
─── */
const UNIFIED_INDEX_PATH = 'awfl/index.json';

/* ─── SUPPORTED CATEGORIES ─── */
const SUPPORTED_CATEGORIES = [
  'ai', 'apps', 'artists', 'bible', 'biography',
  'business', 'developer', 'dictionary', 'education',
  'legacy', 'music', 'news', 'awfl'
];

/* ─── CORS ─── */
const ALLOWED_ORIGINS = [
  'https://aedtpworldawfl.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8080',
];

/* ─── RATE LIMITING — with auto-cleanup to prevent memory leak ─── */
const RATE_LIMIT   = { maxRequests: 100, windowMs: 60_000 };
const rateLimitMap = new Map();

// Clean stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateLimitMap) {
    rec.requests = rec.requests.filter(ts => now - ts < RATE_LIMIT.windowMs);
    if (rec.requests.length === 0) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

function checkRateLimit(ip) {
  const now = Date.now();
  const rec = rateLimitMap.get(ip) || { requests: [] };
  rec.requests = rec.requests.filter(ts => now - ts < RATE_LIMIT.windowMs);
  if (rec.requests.length >= RATE_LIMIT.maxRequests) {
    rateLimitMap.set(ip, rec);
    return false;
  }
  rec.requests.push(now);
  rateLimitMap.set(ip, rec);
  return true;
}

/* ─── IN-MEMORY CACHE ─── */
const indexCache = new Map();
const CACHE_TTL  = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const entry = indexCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { indexCache.delete(key); return null; }
  return entry;
}
function setCache(key, data, sha) {
  indexCache.set(key, { data, sha, ts: Date.now() });
}
function invalidateCache() {
  indexCache.clear();
}

/* ─── VALIDATION ─── */
function isValidSlug(slug) {
  return typeof slug === 'string' && /^[\w\-\.()]+$/.test(slug) && slug.length > 0 && slug.length <= 200;
}
function isValidCategory(cat) {
  return typeof cat === 'string' && SUPPORTED_CATEGORIES.includes(cat.toLowerCase());
}
function isValidTitle(t) {
  return typeof t === 'string' && t.trim().length > 0 && t.length <= 500;
}
function sanitizeSlug(slug) {
  return String(slug).replace(/[^\w\-\.()]/g, '_').replace(/_{2,}/g, '_').substring(0, 200);
}
function sanitizeFilename(name) {
  return String(name).replace(/[^\w\-\.]/g, '_').replace(/^\.+/, '').substring(0, 100);
}

/* ─── GITHUB API ─── */
function ghRequest(method, endpoint, body, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    if (!GH_TOKEN) return reject(new Error('GH_TOKEN is not set. Configure it in your Render environment variables.'));
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'User-Agent'          : 'awflmeta-server/3.0',
        'Accept'              : 'application/vnd.github+json',
        'Authorization'       : 'Bearer ' + GH_TOKEN,
        'X-GitHub-Api-Version': '2022-11-28',
        'Connection'          : 'keep-alive',
        ...(payload ? {
          'Content-Type'  : 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
      },
      timeout,
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) reject(new Error(json.message || `GitHub ${res.statusCode}`));
          else resolve({ status: res.statusCode, data: json });
        } catch (e) { reject(new Error('GitHub response parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function getFileSHA(filePath) {
  try {
    const r = await ghRequest('GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`);
    return r.data.sha || null;
  } catch { return null; }
}

async function putFile(filePath, contentBase64, message, sha) {
  const body = { message, content: contentBase64, branch: GH_BRANCH };
  if (sha) body.sha = sha;
  return ghRequest('PUT', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`, body);
}

/* ─── UNIFIED INDEX HELPERS ─── */
async function getIndex() {
  const cached = getCached('unified');
  if (cached) return cached;

  try {
    const r = await ghRequest('GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/${UNIFIED_INDEX_PATH}?ref=${GH_BRANCH}`);
    let data = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
    if (!Array.isArray(data)) data = [];
    const entry = { data, sha: r.data.sha };
    setCache('unified', data, r.data.sha);
    return entry;
  } catch (e) {
    if (NODE_ENV === 'development') console.log('[getIndex]', e.message);
    return { data: [], sha: null };
  }
}

async function writeIndex(pages, sha) {
  const b64 = Buffer.from(JSON.stringify(pages, null, 2), 'utf8').toString('base64');
  const r = await putFile(UNIFIED_INDEX_PATH, b64,
    `wiki: update index [awflmeta-api v3.0]`, sha || undefined);
  invalidateCache();
  return r;
}

/* ─── HTTP HELPERS ─── */
function readBody(req, maxSize = 10_485_760) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) { req.pause(); reject(new Error('Request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

function setCORS(res, origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : (NODE_ENV !== 'production' ? '*' : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
}

function jsonResp(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function errResp(res, status, message, details = null) {
  jsonResp(res, status, {
    error: message,
    timestamp: new Date().toISOString(),
    ...(details ? { details } : {}),
  });
}

/* ─── MULTIPART PARSER ─── */
function parseMultipart(buffer, boundary) {
  const sep   = Buffer.from('--' + boundary);
  const parts = [];
  let start   = 0;

  while (start < buffer.length) {
    const sepIdx = buffer.indexOf(sep, start);
    if (sepIdx === -1) break;
    const afterSep = sepIdx + sep.length;
    if (buffer.slice(afterSep, afterSep + 2).equals(Buffer.from('--'))) break;

    const headerStart = afterSep + 2;
    const headerEnd   = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;

    const headerStr = buffer.slice(headerStart, headerEnd).toString('utf8');
    const nextSep   = buffer.indexOf(sep, headerEnd + 4);
    const bodyBuf   = buffer.slice(headerEnd + 4, nextSep === -1 ? buffer.length : nextSep - 2);

    const headers = {};
    headerStr.split('\r\n').forEach(line => {
      const ci = line.indexOf(':');
      if (ci > -1) headers[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
    });

    const disp     = headers['content-disposition'] || '';
    const nameM    = disp.match(/name="([^"]+)"/);
    const fileM    = disp.match(/filename="([^"]+)"/);
    parts.push({
      name       : nameM ? nameM[1] : '',
      filename   : fileM ? fileM[1] : null,
      contentType: headers['content-type'] || 'application/octet-stream',
      data       : bodyBuf,
    });
    start = nextSep === -1 ? buffer.length : nextSep;
  }
  return parts;
}

/* ═══════════════════════════════════════════════
   HANDLERS
═══════════════════════════════════════════════ */

/**
 * POST /api/awflmeta/publish
 * Writes <category>/<slug>.html and updates awfl/index.json
 */
async function handlePublish(req, res) {
  let body;
  try {
    const raw = await readBody(req, 10_485_760);
    body = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return errResp(res, 400, 'Invalid JSON body', { error: e.message });
  }

  const { slug, title, category, wikiHTML, author, description, tags } = body;

  if (!slug || !isValidSlug(slug))
    return errResp(res, 400, 'Invalid slug', { example: 'Buddy_DML' });
  if (!title || !isValidTitle(title))
    return errResp(res, 400, 'Invalid title');
  if (!category || !isValidCategory(category))
    return errResp(res, 400, 'Invalid category', { supported: SUPPORTED_CATEGORIES });
  if (!wikiHTML || typeof wikiHTML !== 'string')
    return errResp(res, 400, 'wikiHTML is required');

  const safeSlug = sanitizeSlug(slug);
  const safeCat  = category.toLowerCase();
  const pagePath = `${safeCat}/${safeSlug}.html`;

  try {
    /* 1. Write the page file */
    const pageSHA = await getFileSHA(pagePath);
    await putFile(pagePath, Buffer.from(wikiHTML, 'utf8').toString('base64'),
      `wiki: publish "${title}" [awflmeta-api v3.0]`, pageSHA);

    /* 2. Update unified index */
    const { data: index, sha: indexSHA } = await getIndex();
    const filtered = index.filter(e => !(e.slug === safeSlug && e.category === safeCat));
    filtered.unshift({
      slug    : safeSlug,
      title   : title.trim(),
      category: safeCat,
      updated : Date.now(),
      author  : (author || 'anonymous').substring(0, 60),
      ...(description ? { description: description.trim().substring(0, 500) } : {}),
      ...(Array.isArray(tags) ? { tags: tags.slice(0, 20) } : {}),
    });
    await writeIndex(filtered, indexSHA);

    const pageUrl = `https://${GH_OWNER}.github.io/${GH_REPO}/${safeCat}/${safeSlug}.html`;
    return jsonResp(res, 201, {
      success : true,
      message : 'Page published successfully',
      url     : pageUrl,      // top-level for easy frontend access
      slug    : safeSlug,
      category: safeCat,
      published: new Date().toISOString(),
    });

  } catch (e) {
    console.error('[handlePublish]', e.message);
    return errResp(res, 502, 'Failed to publish page', { error: e.message });
  }
}

/**
 * DELETE /api/awflmeta/page
 * Removes a page from index.json (does not delete the HTML file to avoid accidental data loss)
 */
async function handleDelete(req, res) {
  let body;
  try {
    const raw = await readBody(req, 8192);
    body = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return errResp(res, 400, 'Invalid JSON body');
  }

  const { slug, category } = body;
  if (!slug || !isValidSlug(slug))
    return errResp(res, 400, 'Invalid slug');
  if (!category || !isValidCategory(category))
    return errResp(res, 400, 'Invalid category');

  const safeSlug = sanitizeSlug(slug);
  const safeCat  = category.toLowerCase();

  try {
    const { data: index, sha } = await getIndex();
    const before  = index.length;
    const filtered = index.filter(e => !(e.slug === safeSlug && e.category === safeCat));
    if (filtered.length === before)
      return errResp(res, 404, 'Page not found in index');
    await writeIndex(filtered, sha);
    return jsonResp(res, 200, { success: true, message: 'Page removed from index' });
  } catch (e) {
    return errResp(res, 502, 'Failed to delete page', { error: e.message });
  }
}

/**
 * POST /api/upload/image
 * Uploads JPEG/PNG to images/; returns { fileName, url } at top level.
 * FIX: frontend was reading data.fileName but it was nested under data.data.fileName
 */
async function handleUpload(req, res) {
  const ct      = req.headers['content-type'] || '';
  const boundM  = ct.match(/boundary=([^\s;]+)/);
  if (!boundM)
    return errResp(res, 400, 'Expected multipart/form-data');

  let rawBody;
  try { rawBody = await readBody(req, 5_242_880); }
  catch (e) { return errResp(res, 413, 'File too large (max 5MB)'); }

  const parts    = parseMultipart(rawBody, boundM[1]);
  const filePart = parts.find(p => p.name === 'image' && p.filename);
  if (!filePart)
    return errResp(res, 400, 'Missing "image" field in multipart form');

  const ctype = filePart.contentType.toLowerCase().split(';')[0].trim();
  if (!/^image\/(jpeg|png)$/.test(ctype))
    return errResp(res, 415, 'Only JPEG and PNG supported', { received: ctype });

  const ext      = ctype.includes('png') ? '.png' : '.jpg';
  const base     = sanitizeFilename(path.basename(filePart.filename, path.extname(filePart.filename)));
  const fileName = `${base}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  const filePath = `images/${fileName}`;

  try {
    await putFile(filePath, filePart.data.toString('base64'),
      `images: upload ${fileName} [awflmeta-api v3.0]`, null);

    const fileUrl = `https://${GH_OWNER}.github.io/${GH_REPO}/images/${fileName}`;
    /* Return fileName and url at the TOP LEVEL — frontend reads data.fileName / data.url */
    return jsonResp(res, 201, {
      success : true,
      fileName,          // <-- top-level, matches frontend: data.fileName
      url     : fileUrl, // <-- top-level, matches frontend: data.url
      size    : filePart.data.length,
      type    : ctype,
      uploaded: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[handleUpload]', e.message);
    return errResp(res, 502, 'Failed to upload image', { error: e.message });
  }
}

/**
 * GET /api/awflmeta/pages?category=CATEGORY
 * Lists pages. Optionally filter by category.
 */
async function handleGetPages(req, res) {
  const q        = urlMod.parse(req.url, true).query;
  const category = q.category ? q.category.toLowerCase() : null;

  if (category && !isValidCategory(category))
    return errResp(res, 400, 'Invalid category', { supported: SUPPORTED_CATEGORIES });

  try {
    const { data: index } = await getIndex();
    const pages = category ? index.filter(p => p.category === category) : index;
    return jsonResp(res, 200, {
      count: pages.length,
      ...(category ? { category } : {}),
      pages,
    });
  } catch (e) {
    return errResp(res, 500, 'Failed to fetch pages', { error: e.message });
  }
}

/**
 * GET /api/awflmeta/page/:category/:slug
 */
async function handleGetPage(req, res, category, slug) {
  if (!isValidCategory(category)) return errResp(res, 400, 'Invalid category');
  if (!isValidSlug(slug)) return errResp(res, 400, 'Invalid slug');

  try {
    const { data: index } = await getIndex();
    const page = index.find(p => p.slug === slug && p.category === category.toLowerCase());
    if (!page) return errResp(res, 404, 'Page not found');
    return jsonResp(res, 200, {
      success: true,
      page,
      url: `https://${GH_OWNER}.github.io/${GH_REPO}/${category}/${slug}.html`,
    });
  } catch (e) {
    return errResp(res, 500, 'Failed to fetch page', { error: e.message });
  }
}

/**
 * GET /api/health
 */
function handleHealth(req, res) {
  return jsonResp(res, 200, {
    ok          : true,
    service     : 'awflmeta-api',
    version     : '3.0.0',
    timestamp   : new Date().toISOString(),
    uptime      : process.uptime(),
    environment : NODE_ENV,
    config      : {
      owner           : GH_OWNER,
      repo            : GH_REPO,
      branch          : GH_BRANCH,
      port            : PORT,
      tokenConfigured : !!GH_TOKEN,   // boolean only — never log/return the token
      unifiedIndex    : UNIFIED_INDEX_PATH,
    },
    categories  : SUPPORTED_CATEGORIES,
    cacheEntries: indexCache.size,
  });
}

/**
 * POST /api/cache/clear
 */
function handleClearCache(req, res) {
  invalidateCache();
  return jsonResp(res, 200, { success: true, message: 'Cache cleared' });
}

/* ─── MAIN SERVER ─── */
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  setCORS(res, origin);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const ip = getIP(req);
  if (!checkRateLimit(ip)) return errResp(res, 429, 'Rate limit exceeded (100 req/min)');

  if (!GH_TOKEN && req.url !== '/api/health') {
    return errResp(res, 503, 'Server misconfigured: GH_TOKEN is not set',
      { hint: 'Add GH_TOKEN in your Render dashboard under Environment Variables' });
  }

  const { pathname } = urlMod.parse(req.url);

  try {
    if (req.method === 'POST') {
      if (pathname === '/api/awflmeta/publish')  return await handlePublish(req, res);
      if (pathname === '/api/upload/image')      return await handleUpload(req, res);
      if (pathname === '/api/cache/clear')       return handleClearCache(req, res);
    }
    if (req.method === 'DELETE') {
      if (pathname === '/api/awflmeta/page')     return await handleDelete(req, res);
    }
    if (req.method === 'GET') {
      if (pathname === '/api/health')            return handleHealth(req, res);
      if (pathname === '/api/awflmeta/pages')    return await handleGetPages(req, res);
      const m = pathname.match(/^\/api\/awflmeta\/page\/([a-z]+)\/(.+)$/);
      if (m)                                     return await handleGetPage(req, res, m[1], m[2]);
    }

    return errResp(res, 404, 'Endpoint not found', {
      method : req.method,
      path   : pathname,
      hint   : 'See /api/health for available endpoints',
    });
  } catch (e) {
    console.error('[unhandled]', e);
    errResp(res, 500, 'Internal server error',
      NODE_ENV === 'development' ? { error: e.message } : {});
  }
});

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  AWFLMETA API v3.0 — Fixed & Hardened        ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log(`📡 Port       : ${PORT}`);
  console.log(`📦 Repo       : ${GH_OWNER}/${GH_REPO} @ ${GH_BRANCH}`);
  console.log(`🌍 Env        : ${NODE_ENV}`);
  console.log(`📂 Categories : ${SUPPORTED_CATEGORIES.join(', ')}`);
  console.log(`📄 Index      : ${UNIFIED_INDEX_PATH}`);
  console.log(`🔑 GH_TOKEN   : ${GH_TOKEN ? '✓ Set' : '✗ MISSING — set in Render dashboard!'}\n`);
  if (!GH_TOKEN) console.error('⛔  GH_TOKEN is not set. Publish and upload will fail.\n');
  console.log(`Endpoints:`);
  console.log(`  POST   /api/awflmeta/publish`);
  console.log(`  DELETE /api/awflmeta/page`);
  console.log(`  POST   /api/upload/image`);
  console.log(`  GET    /api/awflmeta/pages[?category=X]`);
  console.log(`  GET    /api/awflmeta/page/:category/:slug`);
  console.log(`  GET    /api/health`);
  console.log(`  POST   /api/cache/clear\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
process.on('uncaughtException', e => { console.error('Uncaught:', e); process.exit(1); });
process.on('unhandledRejection', (r) => { console.error('Unhandled rejection:', r); process.exit(1); });

module.exports = server;