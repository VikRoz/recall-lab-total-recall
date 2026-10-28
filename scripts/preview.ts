import { createServer } from 'node:http';
import { handle } from '../src/http.ts';

const server = createServer(async (req, res) => {
  try {
    const response = await handle(new Request('http://127.0.0.1:4317' + (req.url ?? '/'), { method: req.method }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"code":"PREVIEW_FAILED"}'); }
});
server.on('error', () => { console.error('PREVIEW_LISTEN_FAILED: loopback server unavailable; browser QA was not performed.'); process.exitCode = 2; });
server.listen(4317, '127.0.0.1', () => console.log('Local: http://127.0.0.1:4317'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
