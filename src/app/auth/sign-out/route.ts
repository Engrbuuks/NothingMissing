import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { server } from '@/lib/supabase';

export async function POST(request: Request) {
  await server(cookies()).auth.signOut();
  return NextResponse.redirect(new URL('/sign-in', request.url), { status: 303 });
}
