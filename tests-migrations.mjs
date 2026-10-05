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

import { readdirSync, readFileSync } from 'node:fs';
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

// The name after the number, e.g. `fuel_fleet`. A rename changes the number
// and keeps this, which is how a leftover is told apart from a collision.
const stem = (f) => f.replace(/^\d{4}_/, '').replace(/\.sql$/, '');
const read = (f) => { try { return readFileSync(join(DIR, f), 'utf8'); } catch { return null; } };

const duplicates = [...byNumber.entries()].filter(([, fs]) => fs.length > 1);
if (duplicates.length) {
  for (const [n, fs] of duplicates) {
    fail(`${fs.length} migrations numbered ${n}: ${fs.join(', ')}`);

    // Two very different causes need two very different fixes, and telling
    // somebody to "renumber the later one" when the file is a leftover copy
    // sends them to do the wrong thing carefully.
    let explained = false;

    for (const f of fs) {
      // Extracting a zip over a repo adds and overwrites but never deletes, so
      // a renamed migration leaves its old name behind and both apply.
      const twin = files.find((o) => o !== f && stem(o) === stem(f));
      if (twin) {
        const same = read(f) !== null && read(f) === read(twin);
        fail(`  ${f} is a leftover: the same migration now lives at ${twin}` +
             (same ? ' (byte-identical)' : ' (contents differ, check before deleting)'));
        fail(`  → DELETE ${f}. Renumbering it would apply the same migration twice.`);
        explained = true;
      }
    }

    if (!explained) {
      fail(`  applying by hand has no defined order: renumber the later one,`);
      fail(`  or delete it if the two implement the same feature two ways`);
    }
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

// ── the tone argument of app.log() must be cast ────────────────────────────
// A CASE over two string literals is `unknown`, and app.log()'s seventh
// argument is app.audit_tone, so an uncast CASE there resolves to no function
// at all. Postgres does not check a plpgsql body at creation time, so it only
// fails when that line runs: 0041 passed its dry run and broke on commit,
// because the dry run never reaches the log call. Second occurrence, so it
// earns a check.
//
// Only the seventh argument. CASE in the action name or inside format() is
// ordinary text and perfectly fine, and a check that flags those is a check
// that cries wolf until somebody stops reading it.
const TONE_ARG = 6; // zero based

/** Splits on top level commas, ignoring those inside parens or quotes. */
function splitArgs(src) {
  const out = [];
  let cur = '', depth = 0, quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'" && src[i - 1] !== '\\') quoted = !quoted;
    if (!quoted) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  out.push(cur);
  return out.map((a) => a.trim());
}

let toneChecked = 0, toneBad = 0;
for (const f of files) {
  const body = read(f);
  if (!body) continue;
  for (const call of body.matchAll(/perform\s+app\.log\s*\(([\s\S]*?)\);/gi)) {
    const args = splitArgs(call[1]);
    if (args.length <= TONE_ARG) continue; // tone left to its default
    const tone = args[TONE_ARG];
    toneChecked++;
    if (/\bcase\s+when\b/i.test(tone) && !/::\s*app\.audit_tone/i.test(tone)) {
      fail(`${f}: the tone argument of app.log() is an uncast CASE, add ::app.audit_tone`);
      fail(`  ${tone.replace(/\s+/g, ' ').slice(0, 72)}…`);
      toneBad++;
    }
  }
}
if (toneBad === 0) pass(`every app.log() tone argument is typed (${toneChecked} checked)`);

console.log(failed ? '\n✗ migration numbering is ambiguous' : '\n✓ migration numbering is unambiguous');
process.exit(failed ? 1 : 0);
