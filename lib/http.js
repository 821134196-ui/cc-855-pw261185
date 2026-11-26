import http from 'node:http';
import { errorPayload, statusFor } from './db.js';

/** Read and JSON-parse a request body (max 1 MiB), with a clear error token. */
export function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { token: 'E_BODY_TOO_LARGE', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('body is not valid JSON'), { token: 'E_BAD_JSON', status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

/**
 * Wrap an async handler so every failure becomes a JSON error with a stable
 * token. Domain errors carry `.token`/`.status`; raw SQLite errors are mapped
 * through sqliteToken.
 */
export function jsonHandler(fn) {
  return async (req, res, url, params) => {
    try {
      // `params` comes from matchPath; without forwarding it every ':id'
      // route would receive undefined.
      const body = await fn(req, res, url, params);
      if (!res.headersSent) sendJson(res, 200, body ?? { ok: true });
    } catch (err) {
      if (!res.headersSent) sendJson(res, statusFor(err), errorPayload(err));
    }
  };
}

export function startServer({ port, host, routes, onListen }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const match = routes.find((r) => r.method === method && matchPath(r.path, path));
    if (!match) {
      if (res.headersSent) return;
      sendJson(res, 404, { ok: false, token: 'E_NOT_FOUND', message: `${method} ${path} not found` });
      return;
    }
    const params = matchPath(match.path, path);
    try {
      await match.handler(req, res, url, params);
    } catch (err) {
      if (!res.headersSent) sendJson(res, statusFor(err), errorPayload(err));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      if (onListen) onListen(addr);
      resolve(server);
    });
  });
}

/** Match '/orders/:id' style patterns; returns params object or null. */
export function matchPath(pattern, path) {
  const p = pattern.split('/');
  const s = path.split('/');
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i += 1) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function shutdown(server, code = 0) {
  server.close(() => process.exit(code));
  // Force-exit if connections linger (the ops page polls).
  setTimeout(() => process.exit(code), 1500).unref();
}
