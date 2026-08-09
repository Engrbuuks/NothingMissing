-- Assertion helpers. Every test either prints a PASS line or aborts the run.
create schema if not exists t;

create or replace function t.ok(p_cond boolean, p_what text) returns void
language plpgsql as $$
begin
  if p_cond then raise notice '  PASS  %', p_what;
  else raise exception 'FAIL: %', p_what; end if;
end $$;

create or replace function t.eq(p_a anyelement, p_b anyelement, p_what text) returns void
language plpgsql as $$
begin
  if p_a is not distinct from p_b then raise notice '  PASS  % (= %)', p_what, p_a;
  else raise exception 'FAIL: % — expected %, got %', p_what, p_b, p_a; end if;
end $$;

-- Asserts that a statement raises, optionally matching part of the message.
create or replace function t.raises(p_sql text, p_what text, p_match text default null)
returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm;
    if p_match is not null and position(lower(p_match) in lower(v_msg)) = 0 then
      raise exception 'FAIL: % — raised, but message was "%" (wanted "%")',
        p_what, v_msg, p_match;
    end if;
    raise notice '  PASS  % (blocked: %)', p_what, left(v_msg, 60);
    return;
  end;
  raise exception 'FAIL: % — statement was allowed but should have been blocked', p_what;
end $$;

create or replace function t.as_user(p_user uuid) returns void
language plpgsql as $$
begin
  -- session-scoped, NOT transaction-scoped: psql runs each statement in its
  -- own transaction, so a local setting would vanish before the next line and
  -- every policy would silently evaluate with a null actor.
  perform set_config('request.jwt.claim.sub', p_user::text, false);
end $$;

create or replace function t.heading(p_text text) returns void
language plpgsql as $$
begin raise notice ''; raise notice '── %', p_text; end $$;

grant usage on schema t to authenticated, anon, public;
grant execute on all functions in schema t to authenticated, anon, public;
alter default privileges in schema t grant execute on functions to authenticated, anon, public;

-- Guard against the exact bug that made this suite pass for the wrong reason:
-- if the actor does not survive from one statement to the next, every policy
-- evaluates with a null uid and every isolation test trivially "passes".
create or replace function t.assert_actor_persists(p_user uuid) returns void
language plpgsql as $$
begin
  if auth.uid() is null then
    raise exception 'FAIL: the test actor did not survive the statement boundary — isolation tests would pass vacuously';
  end if;
  if auth.uid() <> p_user then
    raise exception 'FAIL: expected to be acting as %, but auth.uid() is %', p_user, auth.uid();
  end if;
  raise notice '  PASS  acting as % and the session kept it', p_user;
end $$;

-- RLS hides rows rather than rejecting statements, so an UPDATE or DELETE
-- aimed at another tenant's row succeeds and affects nothing. That is the
-- correct behaviour, and the thing worth asserting is that nothing changed —
-- not that an error was raised. Only WITH CHECK violations raise.
create or replace function t.affects(p_sql text, p_expected int, p_what text)
returns void language plpgsql as $$
declare v_n int;
begin
  execute p_sql;
  get diagnostics v_n = row_count;
  if v_n = p_expected then
    raise notice '  PASS  % (% row(s) affected)', p_what, v_n;
  else
    raise exception 'FAIL: % — expected % row(s) affected, got %', p_what, p_expected, v_n;
  end if;
end $$;

grant execute on all functions in schema t to authenticated, anon, public;


-- Ages a waiting approval step so escalation can be tested without waiting
-- three days. Test-only: it lives in schema t, never in app.
create or replace function t.age_step(p_request uuid, p_step int, p_by interval)
returns void language plpgsql security definer set search_path = app, extensions, public, t, pg_temp as $$
begin
  update app.request_steps set waiting_since = now() - p_by
   where request_id = p_request and step_no = p_step;
end $$;

grant execute on all functions in schema t to authenticated, anon, public;
