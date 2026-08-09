-- ============================================================================
-- 09 — REQUESTS AND APPROVAL CHAINS
-- Policies are data. Chains are built by matching. Nobody approves their own.
-- ============================================================================
set role authenticated;
select t.heading('Approval policies are matched, not hardcoded');

select t.as_user('44444444-4444-4444-4444-444444444444');   -- Femi, requester at Lagos

-- Small transfer: one step.
select app.raise_request(
  'aaaaaaaa-0000-0000-0000-000000000001','transfer','Move 3 machines to Abuja',
  null,'c0000000-0000-0000-0000-00000000000a', null, null, null, 3) as r1 \gset

select t.eq((select count(*)::int from app.request_steps where request_id = :'r1'::uuid), 1,
            'a 3-asset transfer matched the one-step policy');
select t.eq((select name from app.approval_policies p
             join app.requests r on r.policy_id = p.id where r.id = :'r1'::uuid),
            'Transfers under 5 assets', 'and it matched by item count');

-- Larger transfer: two steps, from the same table, no code change.
select app.raise_request(
  'aaaaaaaa-0000-0000-0000-000000000001','transfer','Move 8 machines to Abuja',
  null,'c0000000-0000-0000-0000-00000000000a', null, null, null, 8) as r2 \gset

select t.eq((select count(*)::int from app.request_steps where request_id = :'r2'::uuid), 2,
            'an 8-asset transfer matched the two-step policy');
select t.eq((select array_agg(required_role::text order by step_no)::text
             from app.request_steps where request_id = :'r2'::uuid),
            '{manager,admin}', 'and the chain is manager then admin, in order');

-- Amount-based matching for repairs.
select app.raise_request(
  'aaaaaaaa-0000-0000-0000-000000000001','repair','Gearbox overhaul',
  null,'c0000000-0000-0000-0000-00000000000a', null, null, 145000000, 1) as r3 \gset
select t.eq((select array_agg(required_role::text order by step_no)::text
             from app.request_steps where request_id = :'r3'::uuid),
            '{admin,owner}', 'a NGN 1.45m repair needs admin then owner');

select app.raise_request(
  'aaaaaaaa-0000-0000-0000-000000000001','repair','Replace a filter',
  null,'c0000000-0000-0000-0000-00000000000a', null, null, 4500000, 1) as r4 \gset
select t.eq((select array_agg(required_role::text order by step_no)::text
             from app.request_steps where request_id = :'r4'::uuid),
            '{manager}', 'a NGN 45,000 repair needs only a manager');

-- A kind with no policy at all must still get oversight.
select app.raise_request(
  'aaaaaaaa-0000-0000-0000-000000000001','disposal','Scrap an old cabinet',
  null,'c0000000-0000-0000-0000-00000000000a') as r5 \gset
select t.eq((select count(*)::int from app.request_steps where request_id = :'r5'::uuid), 1,
            'a request matching no policy falls through to one approval, not zero');

select t.heading('Deciding');

-- Note: psql variables are not substituted inside a dollar-quoted string, so
-- statements passed to t.raises() are built with format() instead.
select t.raises(
  format('select app.decide_request(%L::uuid, true, %L)', :'r1', 'looks fine to me'),
  'the person who raised it cannot approve it', 'raised yourself');

-- The case that proves the ordering: an owner raises a request and holds
-- every role, so only the self-approval rule can stop them.
select t.as_user('11111111-1111-1111-1111-111111111111');
select app.raise_request(
  'aaaaaaaa-0000-0000-0000-000000000001','transfer','Owner raises their own',
  null,'c0000000-0000-0000-0000-00000000000a', null, null, null, 2) as r6 \gset
select t.raises(
  format('select app.decide_request(%L::uuid, true, %L)', :'r6', 'approving my own'),
  'not even an owner can approve their own request', 'raised yourself');

select t.as_user('22222222-2222-2222-2222-222222222222');   -- Ngozi, manager
select t.eq((app.decide_request(:'r1'::uuid, true, 'Approved')::jsonb ->> 'status'),
            'approved', 'a manager can complete a single-step chain');

-- Ngozi could decide it (the chain called for a manager) but cannot READ it
-- afterwards: the request is scoped to Lagos and she manages Abuja. That is
-- correct — approving is a role question, visibility is a location question.
select t.eq((select count(*)::int from app.requests where id = :'r1'::uuid), 0,
            'the approver cannot see a request outside her location scope');
select t.as_user('11111111-1111-1111-1111-111111111111');
select t.eq((select status::text from app.requests where id = :'r1'::uuid), 'approved',
            'and read as an owner, the request is approved');

-- Two-step chain: a manager alone is not enough.
select t.as_user('22222222-2222-2222-2222-222222222222');   -- back to Ngozi
select t.eq((app.decide_request(:'r2'::uuid, true, 'Step one')::jsonb ->> 'status'),
            'pending', 'approving step one leaves the request pending');
select t.as_user('11111111-1111-1111-1111-111111111111');
select t.eq((select current_step from app.requests where id = :'r2'::uuid), 2,
            'and it advances to step two');
select t.as_user('22222222-2222-2222-2222-222222222222');
select t.raises(
  format('select app.decide_request(%L::uuid, true, %L)', :'r2', 'again'),
  'a manager cannot also sign the admin step', 'neither hold nor cover');

-- Seniority satisfies a more junior step, so an owner can sign an admin step.
select t.as_user('11111111-1111-1111-1111-111111111111');   -- Adeola, owner
select t.ok(app.role_satisfies('aaaaaaaa-0000-0000-0000-000000000001','admin'),
            'an owner satisfies a step calling for an admin');
select t.ok(not app.role_satisfies('aaaaaaaa-0000-0000-0000-000000000001','owner')
            = false, 'and one calling for an owner');
select t.eq((app.decide_request(:'r2'::uuid, true, 'Step two')::jsonb ->> 'status'),
            'approved', 'so the owner completes the chain');

-- But seniority never works downward, and never covers non-approving roles.
select t.as_user('22222222-2222-2222-2222-222222222222');
select t.ok(not app.role_satisfies('aaaaaaaa-0000-0000-0000-000000000001','admin'),
            'a manager does not satisfy an admin step');
select t.as_user('33333333-3333-3333-3333-333333333333');
select t.ok(not app.role_satisfies('aaaaaaaa-0000-0000-0000-000000000001','manager'),
            'an auditor satisfies nothing, however senior the company thinks they are');

select t.heading('Delegation and escalation');

-- Grace is an auditor and holds no approving role.
select t.as_user('33333333-3333-3333-3333-333333333333');
select t.raises(
  format('select app.decide_request(%L::uuid, true, %L)', :'r4', 'sure'),
  'an auditor cannot approve anything');

-- Cover Ngozi with Grace for today.
select t.as_user('11111111-1111-1111-1111-111111111111');
insert into app.delegations (company_id, from_user, to_user, starts_on, ends_on, reason)
values ('aaaaaaaa-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',
        current_date - 1, current_date + 7, 'Annual leave');

select t.as_user('33333333-3333-3333-3333-333333333333');
select t.ok(app.holds_or_covers('aaaaaaaa-0000-0000-0000-000000000001','manager'),
            'while covering, the auditor counts as a manager for approvals');
select t.eq((app.decide_request(:'r4'::uuid, true, 'Approved while covering')::jsonb ->> 'status'),
            'approved', 'and can decide the step');
select t.eq((select on_behalf_of from app.request_steps
             where request_id = :'r4'::uuid and step_no = 1),
            '22222222-2222-2222-2222-222222222222'::uuid,
            'the record says whose behalf it was done on');

-- Escalation moves a stalled step on rather than approving it.
-- Direct writes to request_steps are revoked, which is the point, so the test
-- ages the step through a helper rather than reaching into the table.
select t.as_user('11111111-1111-1111-1111-111111111111');
select t.raises(
  format('update app.request_steps set waiting_since = now() where request_id = %L', :'r3'),
  'even an owner cannot edit an approval step directly', 'permission denied');
select t.age_step(:'r3'::uuid, 1, interval '96 hours');

select t.eq(app.escalate_stale_requests('aaaaaaaa-0000-0000-0000-000000000001'), 1,
            'one stalled step was escalated');
select t.eq((select status::text from app.request_steps
             where request_id = :'r3'::uuid and step_no = 1), 'skipped',
            'the stalled step is marked skipped, not approved');
select t.eq((select status::text from app.requests where id = :'r3'::uuid), 'pending',
            'and the request is still pending — a timeout never approves anything');
select t.eq((select current_step from app.requests where id = :'r3'::uuid), 2,
            'it moved to the next human in the chain');
select t.ok(exists (select 1 from app.audit_events
                    where action = 'escalated a request'),
            'and the skip is in the audit log, findable by an auditor');

select t.heading('Requests respect tenancy');
select t.as_user('99999999-9999-9999-9999-999999999999');
select t.eq((select count(*)::int from app.requests), 0,
            'another company sees none of these requests');
select t.eq((select count(*)::int from app.approval_policies), 0,
            'nor the policies behind them');
select t.raises(
  format('select app.decide_request(%L::uuid, true, %L)', :'r5', 'approving your stuff'),
  'and cannot decide them');

reset role;
