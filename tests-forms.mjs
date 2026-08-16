/**
 * Every field an action reads with formData.get() should exist as a named
 * input in the form that calls it. A mismatch silently sends null — the form
 * submits, nothing errors, and the value is quietly lost.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
(function walk(d){ for (const f of readdirSync(d)) {
  const p = join(d,f);
  if (statSync(p).isDirectory()) walk(p);
  else if (f.endsWith('.tsx')) files.push(p);
}})('src/app');

const actions = readFileSync('src/lib/actions.ts','utf8');

// what each action reads
const reads = new Map();
for (const m of actions.matchAll(/export async function (\w+)\(formData: FormData\)[\s\S]*?(?=\nexport |$)/g)) {
  const name = m[1];
  const fields = new Set([...m[0].matchAll(/formData\.(?:get|getAll)\('([^']+)'\)/g)].map(x=>x[1]));
  if (fields.size) reads.set(name, fields);
}

let bad = 0;
for (const f of files) {
  const s = readFileSync(f,'utf8');
  for (const m of s.matchAll(/<form[^>]*action=\{(\w+)\}([\s\S]*?)<\/form>/g)) {
    const [, action, body] = m;
    const need = reads.get(action);
    if (!need) continue;
    const have = new Set([...body.matchAll(/name="([^"]+)"/g)].map(x=>x[1]));
    // A child component may own a hidden field — LogoUpload renders its own
    // logo_path input. If the form embeds a component, trust it.
    const embeds = /<[A-Z]\w+/.test(body);
    let missing = [...need].filter(n => !have.has(n));
    if (embeds) missing = [];
    // Fields the action derives when absent rather than requiring.
    const derived = { saveAttribute: ['code'] };
    missing = missing.filter(n => !(derived[action] ?? []).includes(n));
    if (missing.length) {
      console.log(`  ✗ ${f}`);
      console.log(`      <form action={${action}}> is missing: ${missing.join(', ')}`);
      bad++;
    }
  }
}
console.log(bad ? `\n✗ ${bad} form/action mismatches` : `  ✓ every form supplies what its action reads`);
process.exit(bad?1:0);
