/**
 * Dead ends: links a page offers that go nowhere, and routes nothing links to.
 * A button to a 404 is worse than a missing button — it looks like the feature
 * exists and is broken.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pages = [];
(function walk(d){ for (const f of readdirSync(d)) {
  const p = join(d,f);
  if (statSync(p).isDirectory()) walk(p);
  else if (f === 'page.tsx' || f === 'route.ts') pages.push(p);
}})('src/app');

// The route each file serves
const routes = new Set(pages.map(p =>
  '/' + p.replace(/^src\/app\//,'').replace(/\/(page|route)\.tsx?$/,'')
        .replace(/\(\w+\)\//g,'').replace(/^$/,'')
).map(r => r === '/' ? '/' : r.replace(/\/$/,'')));

const src = pages.map(p => ({p, s: readFileSync(p,'utf8')}));
const hrefs = new Map();
for (const {p,s} of src) {
  for (const m of s.matchAll(/href=(?:"|\{`)(\/[a-zA-Z0-9\-_/\[\]${}.]*)/g)) {
    let h = m[1].split('?')[0].replace(/\/$/,'') || '/';
    if (h.includes('${')) h = h.replace(/\$\{[^}]+\}/g, '[id]');
    hrefs.set(h, (hrefs.get(h) ?? new Set()).add(p));
  }
}

const norm = r => r.replace(/\[[^\]]+\]/g, '[id]');
const known = new Set([...routes].map(norm));
known.add('/'); known.add('/auth/sign-out');

const broken = [];
for (const [h, from] of hrefs) {
  if (h.startsWith('/api') || h.startsWith('mailto') || h.startsWith('http')) continue;
  if (!known.has(norm(h))) broken.push([h, [...from][0]]);
}

console.log(`${routes.size} routes, ${hrefs.size} distinct internal links\n`);
if (broken.length) {
  console.log('Links pointing at routes that do not exist:');
  for (const [h,f] of broken) console.log(`  ✗ ${h}   (from ${f})`);
} else console.log('  ✓ every internal link resolves to a real route');
process.exit(broken.length ? 1 : 0);
