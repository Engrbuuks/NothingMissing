/**
 * Reading a pasted spreadsheet.
 *
 * Not in actions.ts, because that file carries 'use server' and every export
 * from a server-actions module must be an async function. These are pure
 * helpers used by both the action and the preview page.
 *
 * The generosity here is deliberate. A spreadsheet is a human artefact:
 * headers are capitalised differently, columns are called "S/N" or
 * "Serial No.", people paste from Excel with tabs rather than commas, and
 * there is always a trailing blank line. Being strict about any of that is the
 * difference between a customer onboarding and a customer giving up.
 */

const HEADER_ALIASES: Record<string, string[]> = {
  tag: ['tag', 'asset tag', 'asset no', 'asset number', 'code', 'id', 'asset id'],
  name: ['name', 'asset', 'description', 'item', 'asset name', 'particulars'],
  serial: ['serial', 'serial no', 'serial number', 's/n', 'sn', 'serialno'],
  category: ['category', 'class', 'group', 'asset class'],
  type: ['type', 'sub category', 'subcategory', 'sub-category', 'kind'],
  brand: ['brand', 'make', 'manufacturer'],
  model: ['model', 'model no', 'model number', 'model name'],
  holder: ['holder', 'assigned to', 'user', 'custodian', 'assignee', 'department', 'room'],
  acquired: ['acquired', 'acquired on', 'purchase date', 'date purchased', 'date'],
  cost: ['cost', 'purchase cost', 'value', 'amount', 'price'],
};

export function canonicalHeader(raw: string): string | null {
  // Trim AFTER collapsing punctuation: "Serial No." becomes "serial no " and
  // then "serial no", which is the alias. Trimming first leaves the space.
  const h = raw.toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(h)) return key;
  }
  return null;
}

/** Splits a line, respecting quoted fields — descriptions contain commas. */
export function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if ((c === ',' || c === '\t') && !quoted) {
      out.push(cur); cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseSheet(raw: string): {
  rows: Record<string, string>[];
  headers: string[];
  unknown: string[];
} {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], headers: [], unknown: [] };

  const rawHeaders = splitLine(lines[0]);
  const mapped = rawHeaders.map(canonicalHeader);
  const unknown = rawHeaders.filter((h, i) => h && !mapped[i]);

  const rows = lines
    .slice(1)
    .map((line) => {
      const cells = splitLine(line);
      const row: Record<string, string> = {};
      mapped.forEach((key, i) => {
        if (key && cells[i]) row[key] = cells[i];
      });
      return row;
    })
    .filter((r) => Object.keys(r).length > 0);

  return { rows, headers: mapped.filter(Boolean) as string[], unknown };
}
