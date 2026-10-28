// Reproducible static website, including the explicitly approved article. No providers.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, Fault } from '../src/domain.ts';
import { buildPublicDemo } from './build-public-demo.ts';
import { escapeHtml } from '../src/public-demo-view.ts';
import { englishPublicDemoHtml } from '../src/public-demo-english.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export const REPOSITORY_URL = 'https://github.com/VikRoz/recall-lab-total-recall';
export const SITE_URL = 'https://recall-lab-evidence-20261028.mightytoast34.chatgpt.site';

export function articleHtml(markdown: string) {
  const lines = markdown.trim().split('\n'); const blocks: string[] = []; let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) { blocks.push(`<p>${escapeHtml(paragraph.join(' '))}</p>`); paragraph = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { flush(); continue; }
    if (line.startsWith('# ')) { flush(); blocks.push(`<h1>${escapeHtml(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('## ')) { flush(); blocks.push(`<h2>${escapeHtml(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('|')) {
      flush(); const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().slice(1, -1).split('|').map(x => x.trim());
        if (!cells.every(x => /^:?-+:?$/.test(x))) rows.push(cells);
        i++;
      }
      i--;
      blocks.push(`<div class="table-scroll"><table><thead><tr>${rows[0].map(x => `<th scope="col">${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(row => `<tr>${row.map(x => `<td>${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  const css = `:root{color:#20372c;background:#f7f7f0;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0}header,main,footer{max-width:850px;margin:auto;padding:28px 28px}header{display:flex;flex-wrap:wrap;gap:15px;justify-content:space-between;border-bottom:1px solid #d8dfd3}a{color:#315e43;text-underline-offset:3px}header a{font-weight:650}main{font-size:17px;line-height:1.85}h1{font-size:clamp(30px,5vw,45px);line-height:1.15;letter-spacing:-1.3px;margin:24px 0 35px}h2{font-size:25px;line-height:1.3;margin:42px 0 18px}p{margin:18px 0}.badge{font-size:10px;letter-spacing:.7px;border:1px solid #e2d5ad;border-radius:4px;background:#f3ead0;padding:7px;color:#775e29}.table-scroll{overflow-x:auto;max-width:100%;margin:28px 0}table{border-collapse:collapse;font-size:12px;min-width:650px;width:100%}th,td{border-bottom:1px solid #d9e1d3;padding:13px 10px;text-align:left;vertical-align:top}th{color:#4e6646;font-weight:650}footer{font-size:13px;line-height:1.8;border-top:1px solid #d8dfd3;margin-top:30px}footer nav{display:flex;flex-wrap:wrap;gap:18px}a:focus-visible{outline:3px solid #bb8b39;outline-offset:4px}@media(max-width:500px){header,main,footer{padding:22px 20px}main{font-size:16px;line-height:1.8}}`;
  const styleHash = createHash('sha256').update(css).digest('base64');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-${styleHash}'; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>Recall Lab and verified memory for Sui data agents</title><style>${css}</style></head><body><header><a href="./">Recall Lab</a><span class="badge">SAVED EVIDENCE / REPLAY</span></header><main>${blocks.join('\n')}</main><footer><nav><a href="./#comparison">Open the demo</a><a href="${REPOSITORY_URL}" rel="noreferrer">Source code on GitHub</a><a href="./demo-data.json">Public evidence JSON</a></nav><p>Independent prototype. AI assistance was used for implementation, testing and documentation. The app performs no provider calls when viewed.</p></footer></body></html>`;
}

export async function buildPublishedSite(output: string) {
  const data = await buildPublicDemo(output);
  const html = englishPublicDemoHtml(data, readFileSync(join(root, 'public-demo/style.css'), 'utf8'), readFileSync(join(root, 'public-demo/client.js'), 'utf8'));
  assert(html.includes('href="./blog.html"'), 'PUBLISHED_SITE_ARTICLE_LINK_MISSING');
  writeFileSync(join(output, 'index.html'), html);
  writeFileSync(join(output, 'blog.html'), articleHtml(readFileSync(join(root, 'public-demo/BLOG.en.md'), 'utf8')));
  const verification = JSON.parse(readFileSync(join(output, 'verification.json'), 'utf8'));
  verification.status = 'STATIC_SITE_WITH_ARTICLE_PREPARED'; verification.publication = 'NOT_ATTESTED_BY_OFFLINE_CHECK';
  verification.article = './blog.html'; writeFileSync(join(output, 'verification.json'), JSON.stringify(verification, null, 2));
  const verifier = readFileSync(join(output, 'verify.mjs'), 'utf8').replace("verification.publication, 'NOT_PUBLISHED'", "verification.publication, 'NOT_ATTESTED_BY_OFFLINE_CHECK'").replace("publication: 'NOT_PUBLISHED'", "publication: 'NOT_ATTESTED_BY_OFFLINE_CHECK'");
  writeFileSync(join(output, 'verify.mjs'), verifier);
  writeFileSync(join(output, 'README.md'), readFileSync(join(root, 'public-demo/PUBLISHED-README.en.md'), 'utf8'));
  writeFileSync(join(output, 'RUNBOOK.md'), readFileSync(join(root, 'public-demo/PUBLISHED-RUNBOOK.en.md'), 'utf8'));
  const names = ['index.html', 'blog.html', 'demo-data.json', 'model-report.json', 'verification.json', 'README.md', 'RUNBOOK.md', 'verify.mjs'];
  writeFileSync(join(output, 'CHECKSUMS.json'), JSON.stringify(Object.fromEntries(names.map(n => [n, sha(readFileSync(join(output, n)))])), null, 2));
  return data;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--output'), 'PUBLISHED_SITE_ARGUMENTS');
    const output = process.argv.length === 4 ? resolve(process.argv[3]) : join(root, 'dist/published-site-v1');
    await buildPublishedSite(output);
    console.log(JSON.stringify({ status: 'STATIC_SITE_WITH_ARTICLE_PREPARED', output, providerCalls: 0, additionalSpendUSD: 0, published: false }));
  } catch (e) { console.log(JSON.stringify({ status: 'PUBLISHED_SITE_BUILD_FAILED', code: e instanceof Fault ? e.code : 'BUILD_FAILED' })); process.exitCode = 2; }
}
