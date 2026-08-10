import { redirect } from 'next/navigation';
import { currentTenant, getSession, sb } from '@/lib/session';

/**
 * The apex serves marketing; a tenant host serves the app. Which one this is
 * comes from the host, never from anything the client can set.
 */
export default async function Home() {
  const tenant = await currentTenant();
  // The apex is the marketing site, served by the (marketing) route group.
  if (!tenant) redirect('/home');

  const session = await getSession();
  if (!session) redirect('/sign-in');

  // Somebody who spends their day receiving deliveries should not have to
  // click past a dashboard every morning.
  const { data: pref } = await sb()
    .from('view_preferences').select('landing').eq('company_id', tenant.id).maybeSingle();

  redirect(`/${(pref as any)?.landing ?? 'dashboard'}`);
}
