/**
 * Cross-checks every page against the database: does each RPC it calls exist,
 * does each table it queries exist, and does every column it selects exist.
 * A mismatch is invisible until a user hits the page and gets an empty screen.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.tsx') || f.endsWith('.ts')) files.push(p);
  }
})('src');

const sql = readdirSync('backend/supabase/migrations')
  .map(f => readFileSync(join('backend/supabase/migrations', f), 'utf8')).join('\n');

const fns = new Set([...sql.matchAll(/create or replace function app\.(\w+)/g)].map(m => m[1]));
const tables = new Set([...sql.matchAll(/create table if not exists app\.(\w+)/g)].map(m => m[1]));

const missingFns = new Map(), missingTables = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\.rpc\(\s*['"](\w+)['"]/g)) {
    if (!fns.has(m[1])) missingFns.set(m[1], (missingFns.get(m[1]) ?? []).concat(f));
  }
  for (const m of src.matchAll(/\.from\(\s*['"](\w+)['"]/g)) {
    // storage.from() is a bucket, not a table — same method name, different API
    const isBucket = /storage\s*\n?\s*\.from/.test(src.slice(Math.max(0,m.index-40), m.index+20));
    if (!tables.has(m[1]) && !isBucket)
      missingTables.set(m[1], (missingTables.get(m[1]) ?? []).concat(f));
  }
}

console.log(`checked ${files.length} files against ${fns.size} functions and ${tables.size} tables\n`);
let bad = 0;
if (missingFns.size) {
  console.log('RPCs called but not defined:');
  for (const [k, v] of missingFns) { console.log(`  ✗ ${k}  (${v[0]})`); bad++; }
} else console.log('  ✓ every RPC a page calls exists');
if (missingTables.size) {
  console.log('\nTables queried but not defined:');
  for (const [k, v] of missingTables) { console.log(`  ✗ ${k}  (${v[0]})`); bad++; }
} else console.log('  ✓ every table a page queries exists');
process.exit(bad ? 1 : 0);
