/**
 * Streaming upload gateway for the Traffic VPS.
 *
 * It terminates the user's long-lived upload connection at the edge and
 * streams the multipart body to the primary API over TLS without buffering a
 * second full copy. The primary remains the source of truth and starts the
 * durable processing job after the upload completes.
 */
const https = require('node:https');
const http = require('node:http');

const PORT = Number(process.env.UPLOAD_GATEWAY_PORT || 3011);
const PRIMARY_IP = String(process.env.PRIMARY_PROXY_IP || '').trim();
const PRIMARY_HOST = String(process.env.PRIMARY_PROXY_HOST || 'api.nightbox.in').trim();
const MAX_TIMEOUT_MS = Math.max(60_000, Number(process.env.UPLOAD_GATEWAY_TIMEOUT_MS || 1_800_000));

if (!PRIMARY_IP) throw new Error('PRIMARY_PROXY_IP is required for the upload gateway');

function proxyAllowed(pathname) {
  return pathname === '/upload-file' || pathname === '/upload-from-url';
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', role: 'upload-gateway' }));
  if (!proxyAllowed(new URL(req.url, 'http://upload-gateway').pathname)) return res.writeHead(404).end('Not found');

  const forwardedFor = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
  const headers = { ...req.headers, host: PRIMARY_HOST, 'x-forwarded-for': forwardedFor, 'x-forwarded-proto': 'https' };
  delete headers.connection;
  const upstream = https.request({
    hostname: PRIMARY_IP,
    port: 443,
    servername: PRIMARY_HOST,
    method: req.method,
    path: req.url,
    headers,
    timeout: MAX_TIMEOUT_MS,
  }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Primary upload request timed out')));
  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upload gateway could not reach the primary server' }));
    console.error('[Upload gateway]', error.message);
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});

server.listen(PORT, '127.0.0.1', () => console.log(`[NightBox upload gateway] listening on 127.0.0.1:${PORT} → ${PRIMARY_HOST}`));
