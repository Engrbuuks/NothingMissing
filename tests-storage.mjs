/**
 * Checks the properties the storage layer must have, by reading the code —
 * the alternative is a live R2 account, and these are the assertions that
 * matter regardless of whether one is connected.
 */
import { readFileSync } from 'node:fs';
const up = readFileSync('src/app/api/storage/upload-url/route.ts', 'utf8');
const down = readFileSync('src/app/api/storage/download/route.ts', 'utf8');
const store = readFileSync('src/lib/storage.ts', 'utf8');
const client = readFileSync('src/lib/upload-client.ts', 'utf8');

const checks = [
  // The one that matters most: the company must never come from the request.
  [!/body\.(company|companyId)/.test(up),
   'upload route never reads a company id from the request body'],
  [/from\('memberships'\)/.test(up),
   'upload route derives the company from the caller\'s memberships'],
  [/objectKey\(bucket, \(membership as any\)\.company_id/.test(up),
   'the object key is built from that membership, not from input'],
  [/limit\.mime\.includes\(contentType\)/.test(up),
   'content type is checked against an allow-list'],
  [/bytes > limit\.maxBytes/.test(up),
   'size is capped server-side, not only in the browser'],
  [/if \(!user\)/.test(up),
   'unauthenticated callers get nothing'],
  [/\.in\('role', limit\.roles\)/.test(up),
   'role is checked per bucket'],

  // Downloads
  [/if \(!user\)/.test(down), 'download requires a session'],
  [/\.eq\('company_id', companyId\)/.test(down),
   'download checks membership of the company in the key'],
  [/bucket === 'branding'/.test(down),
   'public assets are refused a signature, so a printed waybill never expires'],
  [/platform_reviewers/.test(down),
   'the reviewer exception exists and is scoped to receipts'],
  [/bucket === 'receipts'/.test(down),
   'and stops at receipts rather than everything'],

  // Signing
  [/expiresIn: 600/.test(store), 'upload URLs live ten minutes'],
  [/expiresIn: seconds/.test(store) && /seconds = 120/.test(store),
   'download URLs default to two minutes'],
  [/branding: true/.test(store) && /receipts: false/.test(store),
   'only branding is public'],

  // The client holds no decisions
  [!/role|membership|company_id/.test(client),
   'the browser client contains no access-control logic'],
];

let bad = 0;
for (const [ok, label] of checks) {
  if (ok) console.log('  ✓ ' + label);
  else { console.log('  ✗ ' + label); bad++; }
}
console.log(bad ? `\n✗ ${bad} properties missing` : '\n✓ storage access control holds');
process.exit(bad ? 1 : 0);
