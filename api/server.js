/**
 * AWFLMETA API SERVER — Enhanced Version
 * Deploy on Render (Node.js 18+)
 *
 * Required environment variables (set in Render dashboard):
 *   GH_TOKEN   — GitHub Personal Access Token with repo write scope
 *   GH_OWNER   — aedtpworldawfl
 *   GH_REPO    — awflmeta
 *   GH_BRANCH  — main (or master)
 *   PORT       — set automatically by Render (defaults to 10000)
 *   NODE_ENV   — production or development
 *
 * Features:
 *   - Multi-category support (ai, apps, artists, bible, biography, business, developer, dictionary, education, legacy, music, news)
 *   - Comprehensive validation and sanitization
 *   - In-memory caching for index files
 *   - Better error handling and logging
 *   - Request rate limiting
 *   - Detailed API responses
 *   - Health checks with diagnostics
 */

'use strict';

const http     = require('http');
const https    = require('https');
const url      = require('url');
const path     = require('path');
const crypto   = require('crypto');

/* ─── ENVIRONMENT ─── */
const GH_TOKEN  = process.env.GH_TOKEN  || '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';
const GH_OWNER  = process.env.GH_OWNER  || 'aedtpworldawfl';
const GH_REPO   = process.env.GH_REPO   || 'awflmeta';
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const PORT      = parseInt(process.env.PORT || '10000', 10);
const NODE_ENV  = process.env.NODE_ENV  || 'production';

/* ─── CONFIGURATION ─── */
const SUPPORTED_CATEGORIES = [
  'ai', 'apps', 'artists', 'bible', 'biography',
  'business', 'developer', 'dictionary', 'education',
  'legacy', 'music', 'news', 'awfl'
];

const ALLOWED_ORIGINS = [
  'https://aedtpworldawfl.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const RATE_LIMIT = {
  maxRequests: 100,
  windowMs: 60000, // 1 minute
};

/* ─── CACHE MANAGEMENT ─── */
const indexCache = new Map();
const rateLimitMap = new Map();

function getCacheKey(category) {
  return `index_${category}`;
}

function invalidateCache(category) {
  indexCache.delete(getCacheKey(category));
}

function invalidateAllCache() {
  indexCache.clear();
}

/* ─── RATE LIMITING ─── */
function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { requests: [], blocked: false };

  // Clean old requests outside window
  record.requests = record.requests.filter(ts => now - ts < RATE_LIMIT.windowMs);

  if (record.requests.length >= RATE_LIMIT.maxRequests) {
    record.blocked = true;
    rateLimitMap.set(ip, record);
    return false;
  }

  record.requests.push(now);
  rateLimitMap.set(ip, record);
  return true;
}

/* ─── VALIDATION ─── */
function isValidSlug(slug) {
  // Allow: word chars, hyphens, dots, parentheses
  return /^[\w\-\.()]+$/.test(slug) && slug.length > 0 && slug.length <= 200;
}

function isValidCategory(category) {
  return SUPPORTED_CATEGORIES.includes(category.toLowerCase());
}

function isValidTitle(title) {
  return typeof title === 'string' && title.trim().length > 0 && title.length <= 500;
}

function sanitizeFilename(filename) {
  return filename
    .replace(/[^\w\-\.]/g, '_')
    .replace(/^\.+/, '') // no leading dots
    .substring(0, 100);
}

function sanitizeSlug(slug) {
  return slug
    .replace(/[^\w\-\.()]/g, '_')
    .replace(/_{2,}/g, '_') // collapse multiple underscores
    .substring(0, 200);
}

/* ─── GITHUB API HELPER ─── */
function ghRequest(method, endpoint, body, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'User-Agent': 'awflmeta-server/2.0',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + GH_TOKEN,
        'X-GitHub-Api-Version': '2022-11-28',
        'Connection': 'keep-alive',
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        } : {}),
      },
      timeout: options.timeout || 30000,
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            const errMsg = json.message || `GitHub API error ${res.statusCode}`;
            reject(new Error(errMsg));
          } else {
            resolve({ status: res.statusCode, data: json });
          }
        } catch (e) {
          reject(new Error(`Failed to parse GitHub response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.abort();
      reject(new Error('GitHub API request timeout'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/* Get existing file SHA */
async function getFileSHA(filePath) {
  try {
    const res = await ghRequest('GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`);
    return res.data.sha || null;
  } catch (e) {
    if (NODE_ENV === 'development') console.log(`[getFileSHA] ${filePath}: ${e.message}`);
    return null; // file doesn't exist
  }
}

/* Create or update a file */
async function putFile(filePath, contentBase64, message, sha) {
  const body = {
    message,
    content: contentBase64,
    branch: GH_BRANCH,
    ...(sha ? { sha } : {}),
  };
  const res = await ghRequest('PUT', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`, body);
  return res.data;
}

/* Get and parse index.json for a category */
async function getIndexFile(category) {
  const cacheKey = getCacheKey(category);
  if (indexCache.has(cacheKey)) {
    return indexCache.get(cacheKey);
  }

  try {
    const filePath = `${category}/index.json`;
    const res = await ghRequest('GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`);
    let index = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
    if (!Array.isArray(index)) index = [];

    // Cache for 5 minutes
    const cached = { data: index, sha: res.data.sha, cached: Date.now() };
    indexCache.set(cacheKey, cached);
    return cached;
  } catch (e) {
    console.error(`[getIndexFile] ${category}:`, e.message);
    return { data: [], sha: null, cached: Date.now() };
  }
}

/* ─── REQUEST HELPERS ─── */
function readBody(req, maxSize = 5242880) { // 5MB default
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) {
        req.pause();
        reject(new Error('Request body too large'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function setCORS(res, origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function err(res, status, message, details = null) {
  json(res, status, {
    error: message,
    timestamp: new Date().toISOString(),
    ...(details ? { details } : {})
  });
}

/* ─── MULTIPART PARSER (optimized) ─── */
function parseMultipart(buffer, boundary) {
  const sep = Buffer.from('--' + boundary);
  const end = Buffer.from('--' + boundary + '--');
  const parts = [];
  let start = 0;

  while (start < buffer.length) {
    const sepIdx = buffer.indexOf(sep, start);
    if (sepIdx === -1) break;
    const afterSep = sepIdx + sep.length;

    // Check for end boundary
    if (buffer.slice(afterSep, afterSep + 2).equals(Buffer.from('--'))) break;

    const headerStart = afterSep + 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;

    const headerStr = buffer.slice(headerStart, headerEnd).toString('utf8', 0, Math.min(2000, headerEnd - headerStart));

    // Find next boundary
    const nextSep = buffer.indexOf(sep, headerEnd + 4);
    const bodyEnd = nextSep === -1 ? buffer.length : nextSep - 2;
    const bodyBuffer = buffer.slice(headerEnd + 4, bodyEnd);

    // Parse headers
    const headers = {};
    headerStr.split('\r\n').forEach(line => {
      const ci = line.indexOf(':');
      if (ci > -1) {
        const k = line.slice(0, ci).trim().toLowerCase();
        const v = line.slice(ci + 1).trim();
        headers[k] = v;
      }
    });

    // Extract name and filename from content-disposition
    const disp = headers['content-disposition'] || '';
    const nameM = disp.match(/name="([^"]+)"/);
    const fileM = disp.match(/filename="([^"]+)"/);

    parts.push({
      name: nameM ? nameM[1] : '',
      filename: fileM ? fileM[1] : null,
      contentType: headers['content-type'] || 'application/octet-stream',
      data: bodyBuffer,
    });

    start = nextSep === -1 ? buffer.length : nextSep;
  }

  return parts;
}

/* ─── ROUTE HANDLERS ─── */

/**
 * POST /api/awflmeta/publish
 *
 * Creates or updates a wiki page in any supported category.
 *
 * Body (JSON):
 *   slug         string   (required) — page identifier
 *   title        string   (required) — page title
 *   category     string   (required) — ai|apps|artists|bible|biography|business|developer|dictionary|education|legacy|music|news|awfl
 *   wikiHTML     string   (required) — full HTML content
 *   htmlContent  string   (optional) — inner content
 *   infoboxData  object   (optional) — structured metadata
 *   author       string   (optional) — author name
 *   description  string   (optional) — short description
 *   tags         array    (optional) — content tags
 */
async function handlePublish(req, res) {
  const clientIP = getClientIP(req);
  if (!checkRateLimit(clientIP)) {
    return err(res, 429, 'Rate limit exceeded. Max 100 requests per minute.');
  }

  if (!GH_TOKEN) {
    return err(res, 500, 'Server not configured', { issue: 'GH_TOKEN is missing' });
  }

  let body;
  try {
    const raw = await readBody(req, 10485760); // 10MB for wiki content
    body = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return err(res, 400, 'Invalid or malformed JSON body', { error: e.message });
  }

  const { slug, title, category, wikiHTML, author, description, tags, infoboxData } = body;

  // Validation
  if (!slug || !isValidSlug(slug)) {
    return err(res, 400, 'Invalid slug format', { example: 'Buddy_DML or Artist_Name_2024' });
  }
  if (!title || !isValidTitle(title)) {
    return err(res, 400, 'Invalid title (required, max 500 chars)');
  }
  if (!category || !isValidCategory(category)) {
    return err(res, 400, 'Invalid category', { supported: SUPPORTED_CATEGORIES });
  }
  if (!wikiHTML || typeof wikiHTML !== 'string') {
    return err(res, 400, 'wikiHTML is required and must be a string');
  }

  const safeSlug = sanitizeSlug(slug);
  const safeCategory = category.toLowerCase();
  const pagePath = `${safeCategory}/${safeSlug}.html`;
  const indexPath = `${safeCategory}/index.json`;

  try {
    /* 1. Write the page HTML */
    const pageSHA = await getFileSHA(pagePath);
    const pageB64 = Buffer.from(wikiHTML, 'utf8').toString('base64');

    await putFile(
      pagePath,
      pageB64,
      `wiki: publish "${title}" to ${safeCategory} [awflmeta-api v2.0]`,
      pageSHA,
    );

    /* 2. Update index.json */
    const indexData = await getIndexFile(safeCategory);
    let index = indexData.data || [];

    // Remove old entry, prepend new one
    index = index.filter(e => e.slug !== safeSlug);
    const newEntry = {
      slug: safeSlug,
      title: title.trim(),
      category: safeCategory,
      updated: Date.now(),
      author: author || 'anonymous',
      ...(description ? { description: description.trim().substring(0, 500) } : {}),
      ...(Array.isArray(tags) ? { tags: tags.slice(0, 20) } : {}),
    };
    index.unshift(newEntry);

    const indexB64 = Buffer.from(JSON.stringify(index, null, 2), 'utf8').toString('base64');
    await putFile(
      indexPath,
      indexB64,
      `wiki: update ${safeCategory} index for "${title}" [awflmeta-api v2.0]`,
      indexData.sha || undefined,
    );

    // Invalidate cache
    invalidateCache(safeCategory);

    const pageUrl = `https://${GH_OWNER}.github.io/${GH_REPO}/${safeCategory}/${safeSlug}.html`;
    return json(res, 201, {
      success: true,
      message: 'Page published successfully',
      data: {
        slug: safeSlug,
        category: safeCategory,
        url: pageUrl,
        published: new Date().toISOString(),
      }
    });

  } catch (e) {
    console.error('[handlePublish]', e);
    return err(res, 502, 'Failed to publish page', { error: e.message });
  }
}

/**
 * POST /api/upload/image
 *
 * Upload an image to the images/ directory.
 * Only JPEG and PNG files accepted.
 * Max file size: 5MB
 */
async function handleUpload(req, res) {
  const clientIP = getClientIP(req);
  if (!checkRateLimit(clientIP)) {
    return err(res, 429, 'Rate limit exceeded');
  }

  if (!GH_TOKEN) {
    return err(res, 500, 'Server not configured', { issue: 'GH_TOKEN is missing' });
  }

  const ct = req.headers['content-type'] || '';
  const boundaryM = ct.match(/boundary=([^\s;]+)/);
  if (!boundaryM) {
    return err(res, 400, 'Expected multipart/form-data with boundary');
  }

  let rawBody;
  try {
    rawBody = await readBody(req, 5242880); // 5MB
  } catch (e) {
    return err(res, 413, 'File too large (max 5MB)', { error: e.message });
  }

  const parts = parseMultipart(rawBody, boundaryM[1]);
  const filePart = parts.find(p => p.name === 'image' && p.filename);

  if (!filePart) {
    return err(res, 400, 'Missing "image" field in multipart form');
  }

  const contentType = filePart.contentType.toLowerCase();
  if (!/^image\/(jpeg|png)$/.test(contentType)) {
    return err(res, 415, 'Only JPEG and PNG images are supported', { received: contentType });
  }

  const ext = contentType.includes('png') ? '.png' : '.jpg';
  const base = sanitizeFilename(path.basename(filePart.filename, path.extname(filePart.filename)));
  const timestamp = Date.now();
  const hash = crypto.randomBytes(4).toString('hex');
  const fileName = `${base}_${timestamp}_${hash}${ext}`;
  const filePath = `images/${fileName}`;

  try {
    const b64 = filePart.data.toString('base64');
    await putFile(filePath, b64, `images: upload ${fileName} [awflmeta-api v2.0]`, null);

    const fileUrl = `https://${GH_OWNER}.github.io/${GH_REPO}/images/${fileName}`;
    return json(res, 201, {
      success: true,
      message: 'Image uploaded successfully',
      data: {
        fileName,
        url: fileUrl,
        size: filePart.data.length,
        type: contentType,
        uploaded: new Date().toISOString(),
      }
    });
  } catch (e) {
    console.error('[handleUpload]', e);
    return err(res, 502, 'Failed to upload image', { error: e.message });
  }
}

/**
 * GET /api/awflmeta/pages?category=CATEGORY
 *
 * List all pages in a category.
 * If no category specified, returns all supported categories.
 */
async function handleGetPages(req, res) {
  const queryObj = url.parse(req.url, true).query;
  const category = queryObj.category ? queryObj.category.toLowerCase() : null;

  if (!category) {
    // Return list of all supported categories
    return json(res, 200, {
      categories: SUPPORTED_CATEGORIES,
      description: 'Available AWFLMETA categories'
    });
  }

  if (!isValidCategory(category)) {
    return err(res, 400, 'Invalid category', { supported: SUPPORTED_CATEGORIES });
  }

  try {
    const indexData = await getIndexFile(category);
    return json(res, 200, {
      category,
      count: indexData.data.length,
      pages: indexData.data,
      cached: indexData.cached
    });
  } catch (e) {
    console.error('[handleGetPages]', e);
    return err(res, 500, 'Failed to fetch pages', { error: e.message });
  }
}

/**
 * GET /api/awflmeta/page/:category/:slug
 *
 * Get a single page (raw metadata, not HTML).
 */
async function handleGetPage(req, res, category, slug) {
  if (!isValidCategory(category)) {
    return err(res, 400, 'Invalid category', { supported: SUPPORTED_CATEGORIES });
  }

  if (!isValidSlug(slug)) {
    return err(res, 400, 'Invalid slug format');
  }

  try {
    const indexData = await getIndexFile(category.toLowerCase());
    const page = indexData.data.find(p => p.slug === slug);

    if (!page) {
      return err(res, 404, 'Page not found', { category, slug });
    }

    return json(res, 200, {
      success: true,
      page,
      url: `https://${GH_OWNER}.github.io/${GH_REPO}/${category}/${slug}.html`
    });
  } catch (e) {
    console.error('[handleGetPage]', e);
    return err(res, 500, 'Failed to fetch page', { error: e.message });
  }
}

/**
 * GET /api/health
 *
 * Health check endpoint with diagnostics.
 */
function handleHealth(req, res) {
  const healthCheck = {
    ok: true,
    service: 'awflmeta-api',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: NODE_ENV,
    config: {
      owner: GH_OWNER,
      repo: GH_REPO,
      branch: GH_BRANCH,
      port: PORT,
      tokenConfigured: !!GH_TOKEN,
    },
    categories: SUPPORTED_CATEGORIES,
    cacheSize: indexCache.size,
    rateLimitEntries: rateLimitMap.size,
  };

  json(res, 200, healthCheck);
}

/**
 * GET /api/stats
 *
 * Server statistics and metrics.
 */
async function handleStats(req, res) {
  try {
    const stats = {
      server: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        env: NODE_ENV,
      },
      cache: {
        entries: indexCache.size,
        keys: Array.from(indexCache.keys()),
      },
      rateLimit: {
        activeEntries: rateLimitMap.size,
      },
      api: {
        version: '2.0.0',
        categories: SUPPORTED_CATEGORIES.length,
        supportedCats: SUPPORTED_CATEGORIES,
      },
    };

    json(res, 200, stats);
  } catch (e) {
    err(res, 500, 'Failed to get stats', { error: e.message });
  }
}

/**
 * POST /api/cache/clear
 *
 * Clear the index cache (admin endpoint).
 * Can target a specific category or clear all.
 */
async function handleClearCache(req, res) {
  const queryObj = url.parse(req.url, true).query;
  const category = queryObj.category;

  try {
    if (category) {
      if (!isValidCategory(category)) {
        return err(res, 400, 'Invalid category', { supported: SUPPORTED_CATEGORIES });
      }
      invalidateCache(category.toLowerCase());
      return json(res, 200, {
        success: true,
        message: `Cache cleared for category: ${category}`,
        cleared: [category.toLowerCase()]
      });
    } else {
      invalidateAllCache();
      return json(res, 200, {
        success: true,
        message: 'All cache cleared',
        clearedAll: true
      });
    }
  } catch (e) {
    return err(res, 500, 'Failed to clear cache', { error: e.message });
  }
}

/* ─── MAIN SERVER ─── */
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  setCORS(res, origin);

  /* Preflight CORS */
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url);
  const pathname = parsedUrl.pathname;

  try {
    /* ─── POST Routes ─── */
    if (req.method === 'POST') {
      if (pathname === '/api/awflmeta/publish')    return await handlePublish(req, res);
      if (pathname === '/api/upload/image')        return await handleUpload(req, res);
      if (pathname === '/api/cache/clear')         return await handleClearCache(req, res);
    }

    /* ─── GET Routes ─── */
    if (req.method === 'GET') {
      if (pathname === '/api/health')              return handleHealth(req, res);
      if (pathname === '/api/stats')               return handleStats(req, res);
      if (pathname === '/api/awflmeta/pages')      return await handleGetPages(req, res);

      // GET /api/awflmeta/page/:category/:slug
      const pageMatch = pathname.match(/^\/api\/awflmeta\/page\/([a-z]+)\/(.+)$/);
      if (pageMatch) {
        return await handleGetPage(req, res, pageMatch[1], pageMatch[2]);
      }
    }

    /* ─── 404 ─── */
    return err(res, 404, 'Endpoint not found', {
      method: req.method,
      path: pathname,
      hint: 'See /api/health for available endpoints'
    });

  } catch (e) {
    console.error('[unhandled error]', e);
    err(res, 500, 'Internal server error', NODE_ENV === 'development' ? { error: e.message } : {});
  }
});

/* ─── STARTUP ─── */
server.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
  console.log(`║  AWFLMETA API Server v2.0 — Enhanced Edition              ║`);
  console.log(`╚═══════════════════════════════════════════════════════════╝\n`);
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`📦 Repository: ${GH_OWNER}/${GH_REPO} @ ${GH_BRANCH}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
  console.log(`📂 Categories: ${SUPPORTED_CATEGORIES.join(', ')}`);
  console.log(`🔑 GitHub Token: ${GH_TOKEN ? '✓ Configured' : '✗ MISSING'}`);
  console.log(`\n🔗 Available endpoints:`);
  console.log(`   POST   /api/awflmeta/publish        — Create/update wiki page`);
  console.log(`   POST   /api/upload/image            — Upload image (JPEG/PNG)`);
  console.log(`   GET    /api/awflmeta/pages          — List pages by category`);
  console.log(`   GET    /api/awflmeta/page/:cat/:slug — Get single page`);
  console.log(`   GET    /api/health                  — Health check with diagnostics`);
  console.log(`   GET    /api/stats                   — Server statistics`);
  console.log(`   POST   /api/cache/clear             — Clear index cache`);
  console.log(`\n⚠️  Note: GH_TOKEN is ${GH_TOKEN ? 'configured' : 'NOT configured'} — publish/upload will fail without it!\n`);
});

/* ─── GRACEFUL SHUTDOWN ─── */
process.on('SIGTERM', () => {
  console.log('\n[SIGTERM] Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n[SIGINT] Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

module.exports = server;
