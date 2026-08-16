/**
 * Every redirect an action makes carries a query param. If the destination
 * page does not read that param, the message is silently swallowed — the user
 * acts, something happens, and the screen says nothing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pages = new Map();
(function walk(d){ for (const f of readdirSync(d)) {
  const p = join(d,f);
  if (statSync(p).isDirectory()) walk(p);
  else if (f === 'page.tsx') {
    const route = '/' + p.replace(/^src\/app\//,'').replace(/\/page\.tsx$/,'')
                        .replace(/\(\w+\)\//g,'');
    pages.set(route.replace(/\/$/,'') || '/', readFileSync(p,'utf8'));
  }
}})('src/app');

const actions = readFileSync('src/lib/actions.ts','utf8');
const misses = [];

for (const m of actions.matchAll(/redirect\(\s*[`'"]([^`'"]*?)\?([a-z_]+)=/g)) {
  let [, path, param] = m;
  path = path.replace(/\$\{[^}]*\}/g, '[id]').replace(/\/$/,'') || '/';
  // find the page, allowing dynamic segments
  let src = pages.get(path);
  if (!src) {
    for (const [route, s] of pages) {
      if (route.replace(/\[[^\]]+\]/g,'[id]') === path) { src = s; break; }
    }
  }
  if (!src) { misses.push([path, param, 'no such page']); continue; }
  if (!new RegExp(`searchParams[.\\[]['"]?${param}`).test(src)) {
    misses.push([path, param, 'page never reads it']);
  }
}

const seen = new Set();
const unique = misses.filter(([p,q]) => { const k=p+'?'+q; if(seen.has(k)) return false; seen.add(k); return true; });

console.log(`checked redirects against ${pages.size} pages\n`);
if (unique.length) {
  console.log('Messages the user will never see:');
  for (const [p,q,why] of unique) console.log(`  ✗ ${p}?${q}=…  — ${why}`);
} else console.log('  ✓ every redirect message is displayed');
process.exit(unique.length ? 1 : 0);
