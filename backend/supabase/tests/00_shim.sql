-- Local stand-in for Supabase's auth schema so the same migrations and the
-- same tests run identically here and on Supabase. Not part of the migrations.
create schema if not exists auth;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth to public;
