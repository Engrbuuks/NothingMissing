-- ============================================================================
-- 03 — THE AUDIT LOG IS APPEND-ONLY
-- Not by convention. Not by application discipline. By the database refusing.
-- ============================================================================
set role authenticated;
select t.heading('Audit log immutability');

select t.as_user('11111111-1111-1111-1111-111111111111');

select t.ok((select count(*) from app.audit_events
             where company_id = 'aaaaaaaa-0000-0000-0000-000000000001') > 0,
            'the seed produced audit rows without anyone asking it to');

select t.raises($$
  update app.audit_events set detail = 'never happened'
   where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
$$, 'an owner cannot edit history');   -- blocked by REVOKE, before the trigger

select t.raises($$
  delete from app.audit_events
   where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
$$, 'an owner cannot delete history');

select t.raises($$
  insert into app.audit_events
    (company_id, actor_label, action, entity, tone)
  values ('aaaaaaaa-0000-0000-0000-000000000001','Somebody Else',
          'did a thing','assets','ok')
$$, 'a client cannot forge an entry naming someone else');

reset role;

-- There are two independent barriers. The REVOKE stops the application role
-- before the statement runs at all. The trigger stops anyone who has the
-- privilege anyway — including the table owner, who RLS alone would not stop.
-- Test the second layer separately, because a future migration that re-grants
-- UPDATE by accident would otherwise go unnoticed.
select t.heading('Audit log immutability — as the table owner');
select t.raises($$
  update app.audit_events set detail = 'tidied up' where id = (
    select min(id) from app.audit_events)
$$, 'not even the table owner can edit history', 'append-only');

select t.raises($$ truncate app.audit_events $$,
                'truncate is blocked too', 'append-only');
