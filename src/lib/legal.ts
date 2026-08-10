/**
 * Document versions.
 *
 * Kept here rather than exported from the pages, because Next.js only permits
 * a known set of exports from a route file — and because consent records
 * reference these, so they belong somewhere both the page and the recording
 * code can read.
 *
 * Bump the version when the meaning changes, not for a typo. Someone who
 * accepted 2026-08-01 accepted a specific set of promises, and a new version
 * means asking them again.
 */
export const TERMS_VERSION = '2026-08-01';
export const PRIVACY_VERSION = '2026-08-01';
