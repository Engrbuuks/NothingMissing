-- ============================================================================
-- 10 — LOCATION LINKS AND FIELD SUBMISSIONS
-- The threat model: assume the URL is public. Prove the blast radius is small.
-- ============================================================================
set role authenticated;
select t.heading('Issuing a scoped link');

select t.as_user('11111111-1111-1111-1111-111111111111');

insert into app.link_holders (id, company_id, name, role_label, phone, location_id)
values ('80000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001',
        'Musa Adeyinka','Storekeeper','+2348031114455','c0000000-0000-0000-0000-00000000000a')
on conflict do nothing;

select app.issue_location_link(
  'aaaaaaaa-0000-0000-0000-000000000001','c0000000-0000-0000-0000-00000000000a',
  '80000000-0000-0000-0000-00000000000a',
  array['count','fault']::app.link_verb[])::text as lk \gset

select (:'lk')::jsonb ->> 'token' as tok \gset
select (:'lk')::jsonb ->> 'link_id' as lid \gset

select t.eq(length(:'tok'), 48, 'the token is 48 hex characters of randomness');
select t.eq((select count(*)::int from app.location_links
             where token_hash = :'tok'), 0,
            'the raw token is nowhere in the table — only its hash is stored');
-- Qualify the schema explicitly: pgcrypto lives in `extensions` on Supabase
-- and now here too, and a bare digest() would not resolve for a caller whose
-- search_path does not include it. This test failing is theearly warning that a
-- SECURITY DEFINER function somewhere is missing `extensions` from its path.
select t.eq((select count(*)::int from app.location_links
             where token_hash = encode(extensions.digest(:'tok','sha256'),'hex')), 1,
            'and the hash matches, so a database leak yields no working link');

select t.heading('A link can do only what it was granted');

reset role;
set role anon;   -- the field page is unauthenticated by design

select t.eq((app.submit_from_link(:'tok','count','Drum 3 was weeping','Android',
              '[{"sku":"CON-AGO-001","qty":3850}]'::jsonb)::jsonb ->> 'status'),
            'pending',
            'a count submits, and comes back pending — never "done"');

select t.raises(
  format('select app.submit_from_link(%L, %L)', :'tok', 'transfer_request'),
  'the same link cannot request a transfer: that verb was not granted',
  'cannot do that');

select t.raises(
  format('select app.submit_from_link(%L, %L, null, null, null, %L)',
         :'tok','fault','a1000000-0000-0000-0000-00000000000d'),
  'and cannot report a fault on an asset at another site', 'not at this location');

-- The blast radius test. Anon is refused at the privilege level, before RLS
-- is even consulted — a stronger guarantee than "the policy returns no rows",
-- because it holds even if a future migration adds a careless policy.
select t.raises('select count(*) from app.assets',
  'holding a link gives no sight of the asset register', 'permission denied');
select t.raises('select count(*) from app.stock_balances',
  'nor of stock levels — a counter cannot see what to agree with', 'permission denied');
select t.raises('select count(*) from app.asset_financials',
  'nor of any costs', 'permission denied');
select t.raises('select count(*) from app.submissions',
  'nor even of their own submission afterwards', 'permission denied');
select t.raises('select count(*) from app.location_links',
  'and no sight of the link table itself', 'permission denied');

select t.raises(
  format('select app.submit_from_link(%L, %L)', 'deadbeef' || repeat('0',40), 'count'),
  'an invented token is refused', 'no longer valid');

reset role;
set role authenticated;

select t.heading('Reviewing a submission is what changes the register');

select t.as_user('44444444-4444-4444-4444-444444444444');   -- Femi, requester
select t.raises(
  format('select app.review_submission((select id from app.submissions where kind=%L limit 1), true)','count'),
  'a requester cannot review field submissions', 'only a manager');

select t.as_user('11111111-1111-1111-1111-111111111111');
select id as sub from app.submissions where kind = 'count' order by submitted_at desc limit 1 \gset

-- Nothing has moved yet.
select t.eq((select status::text from app.submissions where id = :'sub'::uuid), 'pending',
            'before review the submission is pending');

select t.ok(app.stock_balance('50000000-0000-0000-0000-00000000000a',
              'c0000000-0000-0000-0000-00000000000a') <> 3850,
            'and the register still holds the old figure');

select app.review_submission(:'sub'::uuid, true)::text as rv \gset

select t.eq(app.stock_balance('50000000-0000-0000-0000-00000000000a',
              'c0000000-0000-0000-0000-00000000000a'), 3850::numeric,
            'accepting it writes the counted figure to the register');
select t.eq((select kind::text from app.stock_movements order by id desc limit 1),
            'count_adjust',
            'as a movement, so the correction is attributable');
select t.ok((select reason from app.stock_movements order by id desc limit 1)
            like '%Musa Adeyinka%',
            'carrying the name of a person who has no account');

select t.raises(
  format('select app.review_submission(%L::uuid, true)', :'sub'),
  'a submission cannot be reviewed twice', 'already been reviewed');

select t.heading('The accuracy record builds itself');

select app.holder_accuracy('80000000-0000-0000-0000-00000000000a')::text as acc \gset
select t.eq(((:'acc')::jsonb ->> 'submissions')::int, 1,
            'the holder has one submission on record');
select t.ok(((:'acc')::jsonb ->> 'avg_variance_pct') is not null,
            'with an average variance computed from the review, not typed in');

select t.heading('Revoking works immediately');

select app.revoke_location_link(:'lid'::uuid, 'Phone was lost');
select t.eq((select count(*)::int from app.resolve_link(:'tok')), 0,
            'a revoked token resolves to nothing at all');

reset role;
set role anon;
select t.raises(
  format('select app.submit_from_link(%L, %L)', :'tok', 'count'),
  'and the next submission from a lost phone is refused', 'no longer valid');
reset role;
set role authenticated;

select t.heading('Links respect tenancy');
select t.as_user('99999999-9999-9999-9999-999999999999');
select t.eq((select count(*)::int from app.location_links), 0,
            'another company sees none of the links');
select t.eq((select count(*)::int from app.submissions), 0,
            'nor the submissions');
select t.raises($$
  select app.issue_location_link('aaaaaaaa-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-00000000000a', null, array['count']::app.link_verb[])
$$, 'and cannot mint a link into someone else''s location');

reset role;
