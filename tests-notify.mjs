/**
 * Which promised notification events actually send.
 *
 * Twelve events had a preference row and a settings toggle from the start, and
 * notify() was never called for any of them — so a company could switch a
 * notification on, see it listed, and never receive one. The toggle described
 * something that did not happen.
 *
 * This is a warning rather than a failure: not every event needs wiring on day
 * one. It fails only if the two most important are missing, because those are
 * the ones the product is sold on.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const src = [];
(function walk(d){ for (const f of readdirSync(d)) {
  const p = join(d,f);
  if (statSync(p).isDirectory()) walk(p);
  else if (/\.tsx?$/.test(f)) src.push(readFileSync(p,'utf8'));
}})('src');
const app = src.join('\n');

const sql = readdirSync('backend/supabase/migrations')
  .map(f=>readFileSync(join('backend/supabase/migrations',f),'utf8')).join('\n');

const block = sql.match(/insert into app\.notification_prefs[\s\S]*?;/);
const promised = block
  ? [...new Set([...block[0].matchAll(/'([a-z]+\.[a-z]+)'/g)].map(m=>m[1]))]
  : [];

const wired = [...new Set([...app.matchAll(/event:\s*'([a-z]+\.[a-z]+)'/g)].map(m=>m[1]))];
const missing = promised.filter(e => !wired.includes(e));

console.log(`${promised.length} events promised, ${wired.length} wired`);
if (wired.length) console.log(`  wired: ${wired.join(', ')}`);
if (missing.length) console.log(`  not yet sending: ${missing.join(', ')}`);

// These two are what the product is sold on. A company that never hears about
// a dispatch or a discrepancy is not getting the thing it paid for.
const critical = ['transfer.dispatched', 'discrepancy.opened'];
const gone = critical.filter(e => !wired.includes(e));
if (gone.length) {
  console.log(`\n✗ critical events not sending: ${gone.join(', ')}`);
  process.exit(1);
}
console.log('\n  ✓ the events the product is sold on do send');
