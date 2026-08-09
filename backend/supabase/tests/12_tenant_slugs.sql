-- ============================================================================
-- 12 — SUBDOMAIN ROUTING
-- zenith.nothingmissing.ng, and everything that must not become a subdomain.
-- ============================================================================
set role authenticated;
select t.heading('Generating a company address');

select t.as_user('11111111-1111-1111-1111-111111111111');

select t.eq(app.slugify('Zenith Facilities Ltd'), 'zenith-facilities',
            'the company-form suffix is dropped');
-- Only a trailing company-form suffix is stripped, so "Nigeria" survives here
-- because "Enterprises" follows it. One pass, not a recursive strip: chaining
-- them would eat real words out of names like "Lagos Ventures Nigeria Ltd".
select t.eq(app.slugify('R & B Nigeria Enterprises'), 'r-b-nigeria',
            'punctuation collapses and only the last company-form word is dropped');
select t.eq(app.slugify('  Bright  Star   PLC  '), 'bright-star',
            'whitespace collapses too');

select t.eq(((app.slug_available('zenith-facilities'))::jsonb ->> 'available')::boolean, false,
            'the seeded company already holds its address');
select t.eq(((app.slug_available('brand-new-firm'))::jsonb ->> 'available')::boolean, true,
            'an unused address is available');
select t.eq(((app.slug_available('brand-new-firm'))::jsonb ->> 'url'),
            'https://brand-new-firm.nothingmissing.ng',
            'and it tells you the URL you would get');

select t.heading('What cannot become a subdomain');

select t.eq(((app.slug_available('app'))::jsonb ->> 'reason'), 'That address is reserved.',
            'app is reserved — it would shadow our own routes');
select t.eq(((app.slug_available('l'))::jsonb ->> 'available')::boolean, false,
            'l is reserved — field links live at /l/');
select t.eq(((app.slug_available('support'))::jsonb ->> 'available')::boolean, false,
            'support is reserved — it could be used to impersonate us to staff');
select t.eq(((app.slug_available('nothingmissing'))::jsonb ->> 'available')::boolean, false,
            'and so could our own name');
select t.eq(((app.slug_available('ab'))::jsonb ->> 'available')::boolean, false,
            'two characters is too short to be unambiguous');
-- "Zenith-Facilities" normalises to the same address the company already
-- holds, so it reads as taken. DNS does not distinguish case and neither do
-- we — otherwise two companies could claim what is in practice one URL.
select t.eq(((app.slug_available('Zenith-Facilities'))::jsonb ->> 'available')::boolean, false,
            'case does not create a second address — DNS does not distinguish them');
select t.eq(((app.slug_available('ZENITH-FACILITIES'))::jsonb ->> 'reason'),
            'That address is taken.', 'however it is typed');
select t.eq(((app.slug_available('bad--slug'))::jsonb ->> 'available')::boolean, false,
            'a double hyphen is refused: xn-- is how punycode starts');
select t.eq(((app.slug_available('-leading'))::jsonb ->> 'available')::boolean, false,
            'and it must start with a letter');
select t.eq(((app.slug_available('has space'))::jsonb ->> 'available')::boolean, false,
            'spaces are not addresses');

-- Taken and reserved read differently to us, but a stranger learns nothing
-- about who our customers are from either.
select t.eq(((app.slug_available('zenith-facilities'))::jsonb ->> 'reason'),
            'That address is taken.',
            'a taken address does not reveal which company holds it');

select t.heading('Claiming is one-time');

select app.create_company('Bright Star Logistics Ltd','RC 5551212','9 Marina, Lagos')::text as nc \gset
select t.eq(((:'nc')::jsonb ->> 'slug'), 'bright-star-logistics',
            'a new company gets an address derived from its name');
select t.eq(((:'nc')::jsonb ->> 'url'), 'https://bright-star-logistics.nothingmissing.ng',
            'and knows its own URL immediately');
select t.eq((select count(*)::int from app.locations
             where company_id = ((:'nc')::jsonb ->> 'company_id')::uuid and kind = 'virtual'), 1,
            'along with its virtual warehouse, in the same transaction');

select t.raises(
  format('select app.claim_slug(%L::uuid, %L)', ((:'nc')::jsonb ->> 'company_id'), 'something-else'),
  'an address cannot be changed once claimed', 'already lives at');

-- Two companies with the same trading name must not collide.
select app.create_company('Bright Star Logistics Ltd')::text as nc2 \gset
select t.eq(((:'nc2')::jsonb ->> 'slug'), 'bright-star-logistics-2',
            'a second company of the same name gets a suffixed address, not an error');

select t.raises($$
  select app.create_company('Apparently Fine Ltd', null, null, 'admin')
$$, 'and a reserved address cannot be claimed at sign-up', 'reserved');

select t.heading('Resolving a host to a tenant');

select t.eq((app.resolve_tenant('zenith-facilities.nothingmissing.ng')::jsonb ->> 'name'),
            'Zenith Facilities Ltd',
            'a subdomain resolves to its company');
select t.eq((app.resolve_tenant('ZENITH-FACILITIES.NothingMissing.NG')::jsonb ->> 'name'),
            'Zenith Facilities Ltd',
            'case-insensitively');
select t.eq((app.resolve_tenant('zenith-facilities.nothingmissing.ng:3000')::jsonb ->> 'name'),
            'Zenith Facilities Ltd',
            'and with a port attached, so local development works');

select t.eq((app.resolve_tenant('nothingmissing.ng')::jsonb ->> 'reason'), 'apex_or_unknown_host',
            'the apex is not a tenant — it is the marketing site and sign-in');
select t.eq((app.resolve_tenant('www.nothingmissing.ng')::jsonb ->> 'reason'), 'reserved',
            'www is not a tenant either');
select t.eq((app.resolve_tenant('nobody.nothingmissing.ng')::jsonb ->> 'reason'), 'not_found',
            'an unknown subdomain resolves to nothing');
select t.eq((app.resolve_tenant('evil.example.com')::jsonb ->> 'reason'), 'apex_or_unknown_host',
            'and a host that is not ours resolves to nothing at all');

select t.heading('Resolution is safe to run unauthenticated');

reset role;
set role anon;

select t.eq((app.resolve_tenant('zenith-facilities.nothingmissing.ng')::jsonb ->> 'name'),
            'Zenith Facilities Ltd',
            'anon can resolve a tenant, because the login page must be branded');
select t.eq((app.resolve_tenant('zenith-facilities.nothingmissing.ng')::jsonb ->> 'brand_hex'),
            '#0F7B6C', 'and gets the brand colour for that page');
select t.ok((app.resolve_tenant('zenith-facilities.nothingmissing.ng')::jsonb ? 'name'),
            'name and branding are returned');
select t.ok(not (app.resolve_tenant('zenith-facilities.nothingmissing.ng')::jsonb ? 'address'),
            'but nothing else about the company');

-- The important part: resolving a tenant grants no access to it.
select t.raises('select count(*) from app.assets',
  'resolving a tenant gives anon no sight of its assets', 'permission denied');
select t.raises('select count(*) from app.companies',
  'nor of the company table itself', 'permission denied');
select t.raises('select count(*) from app.memberships',
  'nor of who works there', 'permission denied');

select t.eq((select count(*)::int from app.reserved_slugs where slug = 'app'), 1,
            'anon can read reserved words, so a sign-up form can warn before an account exists');

reset role;
set role authenticated;

select t.heading('Custom domains, later');

select t.as_user('11111111-1111-1111-1111-111111111111');
select app.request_custom_domain('aaaaaaaa-0000-0000-0000-000000000001',
                                 'assets.zenithfacilities.ng')::text as cd \gset
select t.ok(((:'cd')::jsonb ->> 'txt_record') like 'nm-verify=%',
            'requesting a custom domain issues a verification token');
select t.eq((app.resolve_tenant('assets.zenithfacilities.ng')::jsonb ->> 'reason'),
            'apex_or_unknown_host',
            'and it does not resolve until DNS control has been proven');

select t.raises($$
  select app.request_custom_domain('aaaaaaaa-0000-0000-0000-000000000001','zenith.nothingmissing.ng')
$$, 'our own domain cannot be claimed as a custom one', 'company address instead');

select t.as_user('22222222-2222-2222-2222-222222222222');
select t.raises($$
  select app.claim_slug('aaaaaaaa-0000-0000-0000-000000000001','hijack')
$$, 'a manager cannot change the company address', 'only an owner');

reset role;
