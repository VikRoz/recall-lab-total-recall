import { mkdirSync, writeFileSync } from 'node:fs';
import { runDemo } from './demo.ts';
import { page } from '../src/view.ts';

const demo = JSON.stringify(await runDemo()).replace(/</g, '\\u003c');
const gates = JSON.stringify({ gates: {
  'Tatum Sui read': 'NOT RUN', 'Real model inference': 'NOT RUN', 'Sponsored Mainnet write': 'NOT RUN',
  'Separate-client recall': 'NOT RUN', 'Worker CPU and transport': 'NOT RUN', 'D1 durability': 'NOT RUN',
} });
// Self-contained read-only preview; it works without a server, CDN or network.
const html = page.replace("const response=await fetch('/api/fixture/demo');", `const response={ok:true,json:async()=>(${demo})};`)
  .replace("const readiness=await(await fetch('/api/readiness')).json();", `const readiness=${gates};`);
if (html.includes("fetch('/api/")) throw new Error('Standalone preview still requires HTTP');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/recall-lab-preview.html', html);
console.log('Built dist/recall-lab-preview.html (offline deterministic fixture; no provider calls).');
