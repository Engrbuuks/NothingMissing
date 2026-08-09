-- ============================================================================
-- 0011_link_url_fix.sql
--
-- The URL that issue_location_link() returned put the token in a fragment:
--
--     /l/<slug>#<token>
--
-- A fragment is never sent to the server. Browsers strip everything after the
-- hash before making the request, so the field page received the slug and no
-- token at all, and every link resolved to nothing — reported to the user as
-- "this link is no longer valid".
--
-- The fragment was not a careless choice: keeping a secret out of the path
-- keeps it out of server logs, proxy logs and Referer headers. But it only
-- works when the token is read by client-side JavaScript, and this page is
-- rendered on the server so the token has to reach it.
--
-- So the token goes in the path. What makes that acceptable here is that the
-- token is not a session: it grants no read access to anything, and everything
-- it can do lands as a pending row a manager reviews. A leaked link means
-- somebody submitted a wrong count, not that somebody moved your generators.
-- It also expires, carries a submission ceiling, and revokes instantly.
-- ============================================================================

create or replace function app.issue_location_link(
  p_company   uuid,
  p_location  uuid,
  p_holder    uuid,
  p_verbs     app.link_verb[],
  p_expires   date default (current_date + 90),
  p_max_month int default 50
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_token text;
  v_slug  text;
  v_id    uuid;
  v_name  text;
begin
  if not app.has_role(p_company, 'owner','admin') then
    raise exception 'only an owner or admin can issue a location link'
      using errcode = '42501';
  end if;
  if not exists (select 1 from app.locations
                 where id = p_location and company_id = p_company
                   and archived_at is null) then
    raise exception 'no such live location in this company'
      using errcode = 'foreign_key_violation';
  end if;
  if p_expires <= current_date then
    raise exception 'a link must expire in the future' using errcode = 'check_violation';
  end if;

  select name into v_name from app.link_holders where id = p_holder;

  v_token := encode(gen_random_bytes(24), 'hex');
  v_slug  := lower(regexp_replace(coalesce(v_name, 'link'), '[^a-zA-Z0-9]+', '-', 'g'))
             || '-' || substr(md5(gen_random_uuid()::text), 1, 6);

  insert into app.location_links
    (company_id, location_id, holder_id, slug, token_hash, verbs,
     expires_on, max_per_month, created_by)
  values
    (p_company, p_location, p_holder, v_slug,
     encode(digest(v_token, 'sha256'), 'hex'), p_verbs,
     p_expires, p_max_month, auth.uid())
  returning id into v_id;

  perform app.log(p_company, 'issued a location link', 'location_links',
    v_id::text, v_slug,
    format('%s at %s, verbs: %s, expires %s', coalesce(v_name, 'unnamed'),
      (select name from app.locations where id = p_location),
      array_to_string(p_verbs::text[], ', '), p_expires),
    'warn', p_location);

  return jsonb_build_object(
    'link_id', v_id,
    'slug',    v_slug,
    'token',   v_token,               -- shown once, never again
    'url',     format('/l/%s', v_token));
end $$;

comment on function app.issue_location_link is
  'Issues a scoped link. The token is returned once and only its hash is stored. It sits in the path, not a fragment, because the field page is server-rendered.';
