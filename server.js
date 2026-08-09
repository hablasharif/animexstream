// ═══════════════════════════════════════════════════════════
//  AnimeStreamX — production server
//  Serves the app as a Node "Web Service" on Render (not a
//  Static Site), so it gets: gzip, security headers, a health
//  check for Render's health probes, graceful shutdown on
//  SIGTERM/SIGINT (Render sends this on every deploy/restart),
//  and process-level crash guards so one bad request can't take
//  the whole service down.
// ═══════════════════════════════════════════════════════════
'use strict';

const path = require('path');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Render (and most PaaS) sit behind a reverse proxy — trust the first
// hop so req.ip / req.secure and rate-limiters (if added later) behave.
app.set('trust proxy', 1);

// Security headers. CSP is left off by default: the page relies on
// inline <script>/<style> and a long list of third-party APIs/CDNs
// (AniList, Jikan, cdnjs, Google Fonts, various stream hosts), so a
// default-deny CSP would break it immediately. Tighten this later with
// an explicit allow-list once the external hosts are finalized.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(compression());

// Basic structured request logging — cheap, dependency-free, and
// enough to debug issues from Render's log stream.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Health check — used by Render's health checks / uptime monitors.
// Deliberately synchronous and dependency-free so it stays accurate
// even if something downstream (a third-party API) is degraded.
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Static assets: fingerprint-friendly caching for anything under
// /public except index.html itself, which should always revalidate
// so deploys take effect immediately instead of being cached stale.
app.use(express.static(PUBLIC_DIR, {
  index: false,
  maxAge: '1d',
  etag: true,
  setHeaders: (res, filePath) => {
    if (path.basename(filePath) === 'index.html') {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// Single-page app: every other GET falls back to index.html so the
// client-side view router (view-home / view-player) always has a page
// to boot from, even on a hard refresh or a deep link.
app.get('*', (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next(err);
  });
});

// Centralized error handler — never leak stack traces to clients,
// always log server-side so problems are visible in Render's logs.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Unhandled request error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`AnimeStreamX listening on port ${PORT}`);
});

// ── Robustness: don't let one bad promise or stray exception kill a
//    live service. Log loudly, keep serving traffic. ──
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// ── Graceful shutdown: Render sends SIGTERM on every deploy and scale
//    event. Stop accepting new connections, let in-flight ones finish,
//    then exit — avoids dropped requests during rollouts. ──
function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully…`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
  // Safety net: force-exit if connections don't close in time.
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
