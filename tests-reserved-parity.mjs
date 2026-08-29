/**
 * The two reserved-slug lists must agree.
 *
 * `src/middleware.ts` holds one in TypeScript and `app.reserved_slugs` holds
 * another in SQL. They are in different languages, edited at different times,
 * and they drift silently — with a failure in each direction:
 *
 *   Missing from the DATABASE  → a customer signs up and claims `billing`, and
 *                                 the router sends their subdomain to our own
 *                                 page instead of their register.
 *   Missing from the MIDDLEWARE → the slug is refused at sign-up but the router
 *                                 does not treat it as ours, so the route it is
 *                                 supposed to protect resolves to nothing.
 *
 * `middleware.ts` and the README both said "tests-reserved-parity.mjs checks
 * it". It did not exist. This is that file, written after adding `a` for the
 * approval links required touching both sides — which is exactly the edit that
 * gets half-done.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let failed = false;
const fail = (m) => { failed = true; console.log(`  ✗ ${m}`); };

// ── the middleware list ──────────────────────────────────────────────────────
const mw = readFileSync('src/middleware.ts', 'utf8');
const block = mw.match(/const RESERVED = new Set\(\[([\s\S]*?)\]\)/);
if (!block) {
  console.log('  ✗ could not find the RESERVED set in src/middleware.ts');
  process.exit(1);
}
const fromMiddleware = new Set(
  [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1].toLowerCase()),
);

// ── the database list ───────────────────────────────────────────────────────
// Every migration, because slugs are added by later ones too — `a` is inserted
// by 0038, not by 0010, and reading only the original file would report it as
// missing from the database when it is not.
const MIG = join('backend', 'supabase', 'migrations');
const sql = readdirSync(MIG)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIG, f), 'utf8'))
  .join('\n');

const fromDatabase = new Set();
for (const stmt of sql.matchAll(
  /insert\s+into\s+app\.reserved_slugs[\s\S]*?values([\s\S]*?);/gi,
)) {
  // Pairs of ('slug','reason') — take the first of each pair.
  for (const pair of stmt[1].matchAll(/\(\s*'([^']+)'\s*,\s*'[^']*'\s*\)/g)) {
    fromDatabase.add(pair[1].toLowerCase());
  }
}

if (fromDatabase.size === 0) {
  fail('no reserved slugs found in the migrations — the parser is wrong, not the data');
}

// ── compare ─────────────────────────────────────────────────────────────────
const missingFromDb = [...fromMiddleware].filter((s) => !fromDatabase.has(s)).sort();
const missingFromMw = [...fromDatabase].filter((s) => !fromMiddleware.has(s)).sort();

console.log(
  `${fromMiddleware.size} reserved in middleware, ${fromDatabase.size} in the database`,
);

if (missingFromDb.length) {
  fail(`in middleware but NOT reserved in the database: ${missingFromDb.join(', ')}`);
  fail('  a customer can claim these at sign-up and break their own routing');
}
if (missingFromMw.length) {
  fail(`reserved in the database but NOT in middleware: ${missingFromMw.join(', ')}`);
  fail('  the router will not treat these as ours');
}

if (!failed) console.log('  ✓ both reserved lists agree');

// ── every routed prefix must be reserved ────────────────────────────────────
// `/l/` and `/a/` are rewritten by the middleware, so their single letters must
// be reserved or a tenant claims the address the rewrite depends on.
for (const m of mw.matchAll(/path\.startsWith\('\/([a-z0-9-]+)\/'\)/g)) {
  const prefix = m[1].toLowerCase();
  if (!fromMiddleware.has(prefix) || !fromDatabase.has(prefix)) {
    fail(`/${prefix}/ is rewritten by the middleware but is not reserved on both sides`);
  }
}

console.log(failed ? '\n✗ the reserved lists have drifted' : '✓ reserved slugs are in parity');
process.exit(failed ? 1 : 0);
