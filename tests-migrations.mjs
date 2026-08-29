// Migration numbering.
//
// Two files sharing a number apply in whatever order the shell happens to glob
// them, and a person applying them by hand in the Supabase SQL editor has no
// order to follow at all. This has now shipped twice — 0019 (bank_transfer and
// manual_payments, which implemented one feature two ways) and 0028
// (sanity_constraints and fuel_fleet). The second time is the one that says a
// check is owed rather than another apology.
//
// Gaps are reported but do not fail: a number retired deliberately is a
// reasonable thing, whereas two files answering to one number never is.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'backend', 'supabase', 'migrations');

let failed = false;
const fail = (m) => { failed = true; console.log(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);

const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

if (files.length === 0) {
  fail(`no migrations found in ${DIR}`);
  process.exit(1);
}

// ── every filename is NNNN_name.sql ──────────────────────────────────────────
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const malformed = files.filter((f) => !NAME.test(f));
if (malformed.length) {
  for (const f of malformed) fail(`${f} is not NNNN_lower_snake_case.sql`);
} else {
  pass(`all ${files.length} migrations are named NNNN_name.sql`);
}

// ── no two files share a number ──────────────────────────────────────────────
const byNumber = new Map();
for (const f of files) {
  const m = f.match(NAME);
  if (!m) continue;
  const n = m[1];
  if (!byNumber.has(n)) byNumber.set(n, []);
  byNumber.get(n).push(f);
}

const duplicates = [...byNumber.entries()].filter(([, fs]) => fs.length > 1);
if (duplicates.length) {
  for (const [n, fs] of duplicates) {
    fail(`${fs.length} migrations numbered ${n}: ${fs.join(', ')}`);
    fail(`  applying by hand has no defined order — renumber the later one`);
  }
} else {
  pass('no two migrations share a number');
}

// ── the sorted order is the numeric order ────────────────────────────────────
// Alphabetical sort and numeric sort agree only while the numbers are the same
// width. They are today; a five-digit migration would silently break it.
const numeric = [...files].sort(
  (a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)) || a.localeCompare(b),
);
if (numeric.join('|') !== files.join('|')) {
  fail('glob order and numeric order disagree — apply order is not what it reads as');
} else {
  pass('glob order matches numeric order');
}

// ── gaps: reported, not fatal ────────────────────────────────────────────────
const numbers = [...byNumber.keys()].map(Number).sort((a, b) => a - b);
const gaps = [];
for (let n = numbers[0]; n < numbers[numbers.length - 1]; n++) {
  if (!numbers.includes(n)) gaps.push(String(n).padStart(4, '0'));
}
console.log(
  gaps.length
    ? `\n  note: unused numbers ${gaps.join(', ')} — fine if retired deliberately`
    : `\n  ${numbers.length} migrations, ${String(numbers[0]).padStart(4, '0')} to ` +
      `${String(numbers[numbers.length - 1]).padStart(4, '0')}, no gaps`,
);

console.log(failed ? '\n✗ migration numbering is ambiguous' : '\n✓ migration numbering is unambiguous');
process.exit(failed ? 1 : 0);
