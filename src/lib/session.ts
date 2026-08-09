/**
 * Who is signed in, which company they are looking at, and what they may do.
 *
 * One rule this file exists to enforce: **the tenant comes from the host, and
 * membership comes from the database.** Neither is ever read from a cookie, a
 * query string or a header the client could set. A user visiting
 * zenith.nothingmissing.ng when they have no membership at Zenith does not get
 * a filtered view — they get nothing, because the database returns nothing.
 *
 * The permission helpers below mirror app.has_role() and friends. They exist
 * to hide UI a person cannot use, not to enforce anything. Enforcement is RLS.
 * If these ever disagree with the database, the database is right and the
 * user sees an empty screen rather than data they should not have.
 */
import { cookies, headers } from 'next/headers';
import { server } from './supabase';

export type Role = 'owner' | 'admin' | 'manager' | 'requester' | 'auditor';

export type Membership = {
  id: string;
  company_id: string;
  location_id: string | null;
  role: Role;
};

export type Tenant = {
  id: string;
  slug: string;
  name: string;
  brand_hex: string;
  logo_path: string | null;
};

export type Session = {
  userId: string;
  email: string;
  fullName: string | null;
  tenant: Tenant | null;
  memberships: Membership[];
  /** Locations this person may act at. Empty array means every location. */
  scopedLocationIds: string[];
  role: Role | null;
};

/** Enum order matches app.role_type: most privileged first. */
const RANK: Record<Role, number> = {
  owner: 0,
  admin: 1,
  manager: 2,
  requester: 3,
  auditor: 4,
};

export function sb() {
  return server(cookies());
}

/** The tenant for this request, resolved from the host by the database. */
export async function currentTenant(): Promise<Tenant | null> {
  const host = headers().get('x-tenant-host') ?? headers().get('host') ?? '';
  const { data, error } = await sb().rpc('resolve_tenant', { p_host: host });
  if (error || !data || !data.tenant) return null;
  return {
    id: data.tenant,
    slug: data.slug,
    name: data.name,
    brand_hex: data.brand_hex ?? '#5B4BE8',
    logo_path: data.logo_path ?? null,
  };
}

export async function getSession(): Promise<Session | null> {
  const supabase = sb();

  // getUser() revalidates against the auth server. getSession() only reads the
  // cookie, which a client could have tampered with, so it is not safe here.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const tenant = await currentTenant();

  // RLS means this can only ever return memberships the caller actually holds.
  let query = supabase
    .from('memberships')
    .select('id, company_id, location_id, role');
  if (tenant) query = query.eq('company_id', tenant.id);

  const { data: rows } = await query;
  const memberships = (rows ?? []) as Membership[];

  // Standing on a tenant you do not belong to is not an error to handle
  // gracefully — it is a wrong turn, and the caller should redirect.
  if (tenant && memberships.length === 0) {
    return {
      userId: user.id,
      email: user.email ?? '',
      fullName: (user.user_metadata?.full_name as string) ?? null,
      tenant,
      memberships: [],
      scopedLocationIds: [],
      role: null,
    };
  }

  const role =
    memberships.length > 0
      ? memberships.reduce((best, m) => (RANK[m.role] < RANK[best] ? m.role : best), memberships[0].role)
      : null;

  // A membership with a null location means the whole company. If the person
  // holds one of those, location scoping does not apply to them at all.
  const companyWide = memberships.some((m) => m.location_id === null);
  const scopedLocationIds = companyWide
    ? []
    : memberships.map((m) => m.location_id!).filter(Boolean);

  return {
    userId: user.id,
    email: user.email ?? '',
    fullName: (user.user_metadata?.full_name as string) ?? null,
    tenant,
    memberships,
    scopedLocationIds,
    role,
  };
}

/* ---------------------------------------------------------------- helpers --
 * Mirrors of the database functions, for hiding UI only.
 */

export function hasRole(session: Session | null, ...roles: Role[]): boolean {
  if (!session?.role) return false;
  return roles.includes(session.role);
}

/** Seniority satisfies a more junior requirement, as app.role_satisfies does. */
export function roleSatisfies(session: Session | null, needed: Role): boolean {
  if (!session?.role) return false;
  if (session.role === 'auditor' || session.role === 'requester') {
    return session.role === needed;
  }
  return RANK[session.role] <= RANK[needed];
}

/** Purchase cost, suppliers and invoices sit behind exactly this. */
export function canSeeFinancials(session: Session | null): boolean {
  return hasRole(session, 'owner', 'admin', 'auditor');
}

export function canWrite(session: Session | null): boolean {
  return hasRole(session, 'owner', 'admin', 'manager', 'requester');
}

export function canAccessLocation(session: Session | null, locationId: string | null): boolean {
  if (!session) return false;
  if (session.scopedLocationIds.length === 0) return true; // company-wide
  if (locationId === null) return true; // in transit: visible to everyone
  return session.scopedLocationIds.includes(locationId);
}

export const money = (minor: number | null | undefined) =>
  minor === null || minor === undefined
    ? '—'
    : '₦' + Math.round(minor / 100).toLocaleString('en-NG');
