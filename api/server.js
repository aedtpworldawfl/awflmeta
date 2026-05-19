/**
 * AWFLMETA API SERVER
 * Deploy on Render (Node.js 18+)
 *
 * Required environment variables (set in Render dashboard):
 *   GH_TOKEN   — GitHub Personal Access Token with repo write scope
 *   GH_OWNER   — aedtpworldawfl
 *   GH_REPO    — awflmeta
 *   GH_BRANCH  — main   (or master)
 *   PORT       — set automatically by Render (defaults to 10000)
 *
 * This file lives in your repo at api/server.js but is run by Render,
 * NOT served as a static file — Render executes it with Node.
 */

'use strict';

const http     = require('http');
const https    = require('https');
const url      = require('url');
const path     = require('path');

/* ─── ENV ─── */
const GH_TOKEN  = process.env.GH_TOKEN  || '';
const GH_OWNER  = process.env.GH_OWNER  || 'aedtpworldawfl';
const GH_REPO   = process.env.GH_REPO   || 'awflmeta';
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const PORT      = parseInt(process.env.PORT || '10000', 10);

/* Origins allowed to call this API */
const ALLOWED_ORIGINS = [
  'https://aedtpworldawfl.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

/* ─── GITHUB API HELPER ─── */
function ghRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'User-Agent': 'awflmeta-server/1.0',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + GH_TOKEN,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) reject(new Error(json.message || 'GitHub error ' + res.statusCode));
          else resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* Get existing file SHA (needed to update a file) */
async function getFileSHA(filePath) {
  try {
    const res = await ghRequest('GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}?ref=${GH_BRANCH}`);
    return res.sha || null;
  } catch {
    return null; // file doesn't exist yet
  }
}

/* Create or update a file in the repo */
async function putFile(filePath, contentBase64, message, sha) {
  const body = {
    message,
    content: contentBase64,
    branch: GH_BRANCH,
    ...(sha ? { sha } : {}),
  };
  return ghRequest('PUT', `/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`, body);
}

/* ─── REQUEST HELPERS ─── */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function setCORS(res, origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function err(res, status, message) {
  json(res, status, { error: message });
}

/* ─── MULTIPART PARSER (for image upload) ─── */
function parseMultipart(buffer, boundary) {
  const sep = Buffer.from('--' + boundary);
  const end = Buffer.from('--' + boundary + '--');
  const parts = [];
  let start = 0;

  while (start < buffer.length) {
    const sepIdx = buffer.indexOf(sep, start);
    if (sepIdx === -1) break;
    const afterSep = sepIdx + sep.length;
    if (buffer.slice(afterSep, afterSep + 2).equals(Buffer.from('--'))) break; // end boundary

    // skip CRLF after boundary
    const headerStart = afterSep + 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;
    const headerStr = buffer.slice(headerStart, headerEnd).toString();

    // find next boundary
    const nextSep = buffer.indexOf(sep, headerEnd + 4);
    const bodyEnd = nextSep === -1 ? buffer.length : nextSep - 2; // subtract CRLF
    const body = buffer.slice(headerEnd + 4, bodyEnd);

    // parse headers
    const headers = {};
    headerStr.split('\r\n').forEach(line => {
      const ci = line.indexOf(':');
      if (ci > -1) {
        const k = line.slice(0, ci).trim().toLowerCase();
        const v = line.slice(ci + 1).trim();
        headers[k] = v;
      }
    });

    // extract name and filename from content-disposition
    const disp = headers['content-disposition'] || '';
    const nameM = disp.match(/name="([^"]+)"/);
    const fileM = disp.match(/filename="([^"]+)"/);
    parts.push({
      name: nameM ? nameM[1] : '',
      filename: fileM ? fileM[1] : null,
      contentType: headers['content-type'] || 'application/octet-stream',
      data: body,
    });
    start = nextSep === -1 ? buffer.length : nextSep;
  }
  return parts;
}

/* ─── ROUTE HANDLERS ─── */

/**
 * POST /api/awflmeta/publish
 *
 * Body (JSON):
 *   slug         string   e.g. "Buddy_DML"
 *   title        string
 *   category     string   e.g. "music"
 *   htmlContent  string   inner HTML of the wiki-content div
 *   wikiHTML     string   full standalone page HTML
 *   infoboxData  object|null
 *   author       string
 *
 * Actions:
 *   1. Write  awfl/<slug>.html
 *   2. Update awfl/index.json  (adds/updates entry)
 */
async function handlePublish(req, res) {
  if (!GH_TOKEN) return err(res, 500, 'Server not configured (GH_TOKEN missing).');

  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString());
  } catch {
    return err(res, 400, 'Invalid JSON body.');
  }

  const { slug, title, category, wikiHTML, infoboxData, author } = body;
  if (!slug || !title || !wikiHTML) return err(res, 400, 'slug, title and wikiHTML are required.');

  /* Sanitise slug — allow word chars, hyphens, dots */
  const safeSlug = slug.replace(/[^\w\-\.]/g, '');
  if (!safeSlug) return err(res, 400, 'Invalid slug.');

  const pagePath  = `awfl/${safeSlug}.html`;
  const indexPath = 'awfl/index.json';

  try {
    /* 1. Write the page HTML */
    const pageSHA = await getFileSHA(pagePath);
    const pageB64 = Buffer.from(wikiHTML, 'utf8').toString('base64');
    await putFile(
      pagePath,
      pageB64,
      `wiki: publish "${title}" [awflmeta]`,
      pageSHA,
    );

    /* 2. Update index.json */
    let index = [];
    const indexSHA = await getFileSHA(indexPath);
    if (indexSHA) {
      try {
        const raw = await ghRequest('GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/${indexPath}?ref=${GH_BRANCH}`);
        index = JSON.parse(Buffer.from(raw.content, 'base64').toString('utf8'));
        if (!Array.isArray(index)) index = [];
      } catch { index = []; }
    }

    /* Remove existing entry for this slug, then prepend updated one */
    index = index.filter(e => e.slug !== safeSlug);
    index.unshift({
      slug     : safeSlug,
      title    : title.trim(),
      category : (category || 'awfl').trim(),
      updated  : Date.now(),
      author   : author || 'unknown',
    });

    const indexB64 = Buffer.from(JSON.stringify(index, null, 2), 'utf8').toString('base64');
    await putFile(
      indexPath,
      indexB64,
      `wiki: update index for "${title}" [awflmeta]`,
      indexSHA || undefined,
    );

    const pageUrl = `https://${GH_OWNER}.github.io/${GH_REPO}/awfl/${safeSlug}.html`;
    return json(res, 200, { ok: true, slug: safeSlug, url: pageUrl });

  } catch (e) {
    console.error('[publish]', e.message);
    return err(res, 502, 'GitHub write failed: ' + e.message);
  }
}

/**
 * POST /api/upload/image
 *
 * Multipart form-data with field "image" (JPEG or PNG).
 * Writes the file to images/<filename> in the repo.
 * Returns { fileName, url }
 */
async function handleUpload(req, res) {
  if (!GH_TOKEN) return err(res, 500, 'Server not configured (GH_TOKEN missing).');

  const ct = req.headers['content-type'] || '';
  const boundaryM = ct.match(/boundary=([^\s;]+)/);
  if (!boundaryM) return err(res, 400, 'Expected multipart/form-data.');

  const rawBody = await readBody(req);
  const parts = parseMultipart(rawBody, boundaryM[1]);
  const filePart = parts.find(p => p.name === 'image' && p.filename);
  if (!filePart) return err(res, 400, 'No image field found.');

  if (!/^image\/(jpeg|png)$/.test(filePart.contentType))
    return err(res, 400, 'Only JPEG and PNG images are accepted.');

  /* Sanitise filename */
  const ext  = filePart.contentType === 'image/png' ? '.png' : '.jpg';
  const base = path.basename(filePart.filename, path.extname(filePart.filename))
    .replace(/[^\w\-]/g, '_').substring(0, 80);
  const fileName = base + '_' + Date.now() + ext;
  const filePath = `images/${fileName}`;

  try {
    const b64 = filePart.data.toString('base64');
    await putFile(filePath, b64, `images: upload ${fileName} [awflmeta]`, null);

    const fileUrl = `https://${GH_OWNER}.github.io/${GH_REPO}/images/${fileName}`;
    return json(res, 200, { ok: true, fileName, url: fileUrl });
  } catch (e) {
    console.error('[upload]', e.message);
    return err(res, 502, 'GitHub write failed: ' + e.message);
  }
}

/**
 * GET /api/awflmeta/pages
 * Proxies awfl/index.json from the repo (avoids CORS / caching issues).
 */
async function handleGetPages(req, res) {
  try {
    const raw = await ghRequest('GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/awfl/index.json?ref=${GH_BRANCH}`);
    const arr = JSON.parse(Buffer.from(raw.content, 'base64').toString('utf8'));
    return json(res, 200, arr);
  } catch (e) {
    return json(res, 200, []); // return empty rather than error
  }
}

/**
 * GET /api/health
 */
function handleHealth(req, res) {
  json(res, 200, { ok: true, service: 'awflmeta-api', ts: Date.now() });
}

/* ─── MAIN SERVER ─── */
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  setCORS(res, origin);

  /* Preflight */
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const { pathname } = url.parse(req.url);

  /* Route table */
  if (req.method === 'POST' && pathname === '/api/awflmeta/publish') return handlePublish(req, res);
  if (req.method === 'POST' && pathname === '/api/upload/image')     return handleUpload(req, res);
  if (req.method === 'GET'  && pathname === '/api/awflmeta/pages')   return handleGetPages(req, res);
  if (req.method === 'GET'  && pathname === '/api/health')           return handleHealth(req, res);

  return err(res, 404, 'Not found.');
});

server.listen(PORT, () => {
  console.log(`[awflmeta] API server running on port ${PORT}`);
  console.log(`[awflmeta] Repo: ${GH_OWNER}/${GH_REPO} @ ${GH_BRANCH}`);
  if (!GH_TOKEN) console.warn('[awflmeta] WARNING: GH_TOKEN is not set — publish & upload will fail!');
});
