import { redirect } from 'next/navigation';
import { currentTenant, getSession } from '@/lib/session';

/**
 * The apex serves marketing; a tenant host serves the app. Which one this is
 * comes from the host, never from anything the client can set.
 */
export default async function Home() {
  const tenant = await currentTenant();
  if (!tenant) redirect('/welcome');

  const session = await getSession();
  if (!session) redirect('/sign-in');
  redirect('/dashboard');
}
