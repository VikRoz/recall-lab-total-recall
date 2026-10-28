import { page } from './view.ts';
import { runDemo } from '../scripts/demo.ts';

export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
  if (request.method !== 'GET') return Response.json({ code: 'METHOD_NOT_ALLOWED' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
  if (url.pathname === '/') return new Response(page, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
  if (url.pathname === '/api/fixture/demo') return Response.json(await runDemo(), { headers });
  if (url.pathname === '/api/readiness') return Response.json({ stage: 0, status: 'BLOCKED', gates: {
    'Tatum Sui read': 'NOT RUN', 'Real model inference': 'NOT RUN', 'Sponsored Mainnet write': 'NOT RUN',
    'Separate-client recall': 'NOT RUN', 'Worker CPU and transport': 'NOT RUN', 'D1 durability': 'NOT RUN',
  } }, { headers });
  return Response.json({ code: 'NOT_FOUND' }, { status: 404, headers });
}
