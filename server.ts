import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { attachAdhocRelay } from './server/adhoc-relay.ts';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_RA_BODY = 64 * 1024;
const MAX_RA_RESPONSE = 4 * 1024 * 1024;

function validateRetroAchievementsUrl(rawUrl: unknown, method: string): string {
  if (typeof rawUrl !== 'string' || !rawUrl) {
    throw new Error('Missing URL');
  }
  const parsed = new URL(rawUrl);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    (parsed.port !== '' && parsed.port !== '443') ||
    parsed.hash
  ) {
    throw new Error('Invalid URL');
  }
  const isApi = parsed.hostname === 'retroachievements.org' && parsed.pathname === '/dorequest.php';
  const isImage =
    parsed.hostname === 'media.retroachievements.org' &&
    !parsed.search &&
    /^\/(?:Badge|Images|UserPic)\/[A-Za-z0-9_.-]+\.png$/.test(parsed.pathname);

  if (!isApi && !(isImage && method === 'GET')) {
    throw new Error('Unsupported resource');
  }
  if (isApi && (method !== 'POST' || parsed.search)) {
    throw new Error('API requires POST');
  }
  return `https://${parsed.hostname}${parsed.pathname}`;
}

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');

  // Required COOP/COEP headers for WebAssembly SharedArrayBuffer / pthreads
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', relay_protocol: 1 });
  });

  // Read-only gateway for the public PlayDreamCreate demo archive
  app.get('/api/demos/catalog', async (_req, res) => {
    try {
      const upstream = await fetch('https://playdreamcreate.com/data/demos.json', {
        headers: { 'User-Agent': 'PPSSPP-Web-Demos/1.0' },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      if (!upstream.ok) {
        res.status(502).json({ error: 'Demo archive unavailable; retry later' });
        return;
      }
      const data = await upstream.arrayBuffer();
      if (data.byteLength <= 0 || data.byteLength > 2 * 1024 * 1024) {
        res.status(502).json({ error: 'Invalid demo archive size' });
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(Buffer.from(data));
    } catch {
      res.status(502).json({ error: 'Demo archive unavailable; retry later' });
    }
  });

  app.get('/api/demos/download', async (req, res) => {
    const file = req.query.file;
    if (typeof file !== 'string' || !/^[A-Za-z0-9_-]+\.zip$/.test(file)) {
      res.status(400).json({ error: 'Invalid demo archive request' });
      return;
    }
    try {
      const upstream = await fetch(`https://data.playdreamcreate.com/${file}`, {
        headers: { 'User-Agent': 'PPSSPP-Web-Demos/1.0' },
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
      const contentLength = Number(upstream.headers.get('content-length') || '0');
      if (!upstream.ok || !upstream.body || contentLength <= 0 || contentLength > 512 * 1024 * 1024) {
        res.status(502).json({ error: 'Invalid demo archive size' });
        return;
      }
      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(contentLength));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const nodeStream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
      nodeStream.pipe(res);
    } catch {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Demo archive unavailable; retry later' });
      }
    }
  });

  // RetroAchievements CORS proxy
  app.options('/api/retroachievements', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(204).end();
  });

  app.all(
    '/api/retroachievements',
    express.raw({ type: 'application/x-www-form-urlencoded', limit: MAX_RA_BODY }),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (req.method !== 'GET' && req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
      }

      let targetUrl: string;
      let body: Buffer | undefined;
      try {
        targetUrl = validateRetroAchievementsUrl(req.query.url, req.method);
        if (req.method === 'POST') {
          if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > MAX_RA_BODY) {
            throw new Error('Invalid body');
          }
          body = req.body;
        }
      } catch {
        res.status(400).json({ error: 'Invalid RetroAchievements request' });
        return;
      }

      try {
        const upstream = await fetch(targetUrl, {
          method: req.method,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'PPSSPP-Web/1.0',
          },
          body: body ? new Uint8Array(body) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length > MAX_RA_RESPONSE) {
          res.status(502).json({ error: 'Invalid response' });
          return;
        }
        const mime = targetUrl.includes('/dorequest.php') ? 'application/json' : 'image/png';
        res.status(upstream.status).type(mime).send(buf);
      } catch {
        res.status(502).json({ error: 'RetroAchievements unavailable; retry later' });
      }
    }
  );

  // Server accounts default to disabled unless explicitly configured
  app.use('/api/account', (_req, res) => {
    res.status(404).json({ error: 'Server accounts are disabled' });
  });

  const httpServer = http.createServer(app);
  attachAdhocRelay(httpServer);

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`PPSSPP Web listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
