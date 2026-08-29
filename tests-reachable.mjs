/**
 * Confirms that a feature is REACHABLE from the page, not merely present in
 * lib/actions.ts. The last two rounds shipped working database functions that
 * no page ever called — which is indistinguishable from not building them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
(function walk(d){ for (const f of readdirSync(d)) {
  const p = join(d,f);
  if (statSync(p).isDirectory()) walk(p);
  else if (f.endsWith('.tsx')) files.push(p);
}})('src/app');
// Import lines are stripped before matching. Importing an action and never
// using it satisfied this check while leaving the feature exactly as
// unreachable as never writing it — which is the failure this exists to catch,
// so counting the import defeated the whole point. Found when a rename action
// was imported into the catalog page and wired to nothing.
const stripImports = (src) =>
  src.replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?/gm, '');

const pages = files.map(f => stripImports(readFileSync(f,'utf8'))).join('\n');
const actions = readFileSync('src/lib/actions.ts','utf8');

// Every exported action should be USED by at least one page.
const exported = [...actions.matchAll(/export (?:async function|const) (\w+)/g)].map(m=>m[1]);
const orphans = exported.filter(name => {
  const used = new RegExp(`\\b${name}\\b`).test(pages);
  return !used;
});

console.log(`${exported.length} server actions defined`);
if (orphans.length) {
  console.log('\nActions no page can reach — the feature does not exist for a user:');
  for (const o of orphans) console.log(`  ✗ ${o}`);
} else {
  console.log('  ✓ every action is reachable from a page');
}
process.exit(orphans.length ? 1 : 0);
