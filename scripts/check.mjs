import { readdirSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

let n = 0;
function walk(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file);
    else if (/\.(ts|mjs)$/.test(file)) {
      const text = readFileSync(file, 'utf8');
      const js = file.endsWith('.ts') ? stripTypeScriptTypes(text, { mode: 'strip' }) : text;
      const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: js, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(file + '\n' + result.stderr);
      n++;
    }
  }
}
for (const dir of ['src', 'scripts', 'test']) walk(dir);
console.log(`Syntax and erasable TypeScript check passed: ${n} files. Full tsc checking requires the dependency gate.`);
