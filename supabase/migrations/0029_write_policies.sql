-- ============================================================================
-- 0029_write_policies.sql
-- Three tables the application writes to that had no policy for it.
--
-- A write to a table with row-level security enabled and no matching policy
-- does not error — it silently affects zero rows. That is the worst kind of
-- failure: the code looks correct, nothing appears in a log, and the data is
-- simply never saved.
--
-- Found by querying pg_policies against the tables the app writes to directly,
-- rather than by grepping the migrations. An earlier text-based version of the
-- check reported four working tables as broken, because many policies here are
-- generated in a loop and no regex will see them.
--
-- NOTIFICATIONS is the consequential one. notify.ts marks a message sent or
-- failed after calling the provider. Without an update policy every
-- notification stayed 'queued' forever — so the Notifications page would show
-- a growing pile of apparently undelivered messages that had in fact been
-- delivered, and any retry logic built on that status would resend them.
-- ============================================================================

-- ---------------------------------------------------------- notifications --
-- Delivery status is written by the application after the provider answers.
-- Restricted to the two fields that describe delivery: nobody edits the body
-- of a message that has already gone out, because the record of what was sent
-- is the point of keeping it.
drop policy if exists notifications_update on app.notifications;
create policy notifications_update on app.notifications
  for update
  using      ( app.is_member(company_id) )
  with check ( app.is_member(company_id) );

create or replace function app.notifications_delivery_only()
returns trigger
language plpgsql as $$
begin
  -- Everything except the delivery fields must be unchanged. A notification is
  -- a record of what was sent; if the body could be edited afterwards it would
  -- stop being evidence of anything.
  if to_jsonb(new) - 'status' - 'sent_at' - 'delivered_at' - 'error'
                   - 'attempts' - 'provider' - 'provider_id'
   is distinct from
     to_jsonb(old) - 'status' - 'sent_at' - 'delivered_at' - 'error'
                   - 'attempts' - 'provider' - 'provider_id'
  then
    raise exception 'only delivery status can be updated on a notification'
      using errcode = '42501',
            hint = 'The message itself is a record of what was sent.';
  end if;
  return new;
end $$;

drop trigger if exists notifications_delivery_guard on app.notifications;
create trigger notifications_delivery_guard
  before update on app.notifications
  for each row execute function app.notifications_delivery_only();

-- ------------------------------------------------------------ attachments --
-- A caption can be corrected; the file it points at cannot be repointed.
-- Otherwise somebody could swap the photograph behind a fault report while
-- leaving the report's history intact.
drop policy if exists attachments_update on app.attachments;
create policy attachments_update on app.attachments
  for update
  using      ( app.can_write(company_id) )
  with check ( app.can_write(company_id) );

create or replace function app.attachments_caption_only()
returns trigger
language plpgsql as $$
begin
  if new.storage_path is distinct from old.storage_path
     or new.bytes is distinct from old.bytes
     or new.mime_type is distinct from old.mime_type
     or new.asset_id is distinct from old.asset_id
     or new.transfer_id is distinct from old.transfer_id
     or new.submission_id is distinct from old.submission_id
  then
    raise exception 'an attachment cannot be repointed at a different file'
      using errcode = '42501',
            hint = 'Delete it and upload again if the wrong file went up.';
  end if;
  return new;
end $$;

drop trigger if exists attachments_caption_guard on app.attachments;
create trigger attachments_caption_guard
  before update on app.attachments
  for each row execute function app.attachments_caption_only();

-- -------------------------------------------------------------- companies --
-- create_company() and signup_company() are SECURITY DEFINER and bypass this,
-- which is why nothing was visibly broken. But the check is right to flag it:
-- an insert policy that does not exist is a policy nobody decided on, and the
-- next person to write `from('companies').insert(...)` in a page would get a
-- silent no-op rather than a clear refusal.
--
-- Refusing explicitly says the rule out loud: companies are created through
-- sign-up or provisioning, never by inserting a row.
drop policy if exists companies_insert on app.companies;
create policy companies_insert on app.companies
  for insert with check ( false );

comment on policy companies_insert on app.companies is
  'Always false, deliberately. Companies are created by signup_company() or '
  'provision_company(), which set up the owner membership and virtual '
  'warehouse in the same transaction. A bare insert would leave a company '
  'nobody belongs to.';
