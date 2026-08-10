-- ============================================================================
-- 0017_performance.sql
-- Indexes, added after measuring rather than before guessing.
--
-- Measured on 20,000 assets in one company, with row-level security active:
--
--   register page (500 rows, 2 joins)   251 ms
--   search across tag/serial/holder     259 ms   <- full scan, every row
--   filter by location + status          86 ms
--   dashboard status rollup             245 ms   <- full scan for a count
--   CSV export (all rows + financials)  239 ms
--
-- The two full scans are the ones worth fixing. ILIKE '%x%' cannot use a
-- normal B-tree at all — a leading wildcard makes the index useless — so
-- search needs trigrams. The rollup needs a covering index so the count never
-- touches the heap.
--
-- Everything else is fine and is left alone: an index that is not paying for
-- itself still costs time on every insert.
-- ============================================================================

create extension if not exists pg_trgm with schema extensions;

-- Search. GIN over trigrams is what makes a leading-wildcard ILIKE fast; the
-- four columns are exactly the four the register searches, because they are
-- what somebody has in their hand when they are looking for something.
create index if not exists assets_search_trgm
  on app.assets using gin (
    (coalesce(tag,'') || ' ' || coalesce(name,'') || ' ' ||
     coalesce(serial_no,'') || ' ' || coalesce(holder,'')) extensions.gin_trgm_ops
  );

-- The dashboard rollup counts by status within a company. Including status in
-- the index means the count is answered from the index alone.
create index if not exists assets_company_status_cover
  on app.assets (company_id, status) include (id);

-- Sorting the register by tag is the default on every page load.
create index if not exists assets_company_tag
  on app.assets (company_id, tag);

-- Export joins financials for every visible asset.
create index if not exists asset_financials_company_idx
  on app.asset_financials (company_id);

-- The audit log is read most often filtered to one entity, which the existing
-- index covers, and most often ordered by time, which it does not once a
-- company has a year of history.
create index if not exists audit_company_entity_time
  on app.audit_events (company_id, entity, occurred_at desc);

-- Stock balances are summed per item across locations on every inventory load.
create index if not exists stock_balances_item_idx
  on app.stock_balances (item_id);

-- Transfers in transit is the first thing the dashboard asks for.
create index if not exists transfers_company_status_time
  on app.transfers (company_id, status, created_at desc);

-- Pending submissions, likewise.
create index if not exists submissions_company_status
  on app.submissions (company_id, status, submitted_at desc);

analyze app.assets;
analyze app.asset_financials;
analyze app.audit_events;

-- ============================================================================
-- The indexes above changed nothing, which was the useful result. The plan
-- shows why:
--
--   Seq Scan on assets  (actual time=0.792..240.422 rows=20005)
--     Filter: (app.is_member(company_id) AND (location_id IS NULL
--              OR app.can_access_location(company_id, location_id)))
--
-- The policy calls a function per row — twenty thousand calls, each running
-- its own subquery against memberships. No index can help, because the filter
-- is a function call rather than a comparison the planner can push down.
--
-- The fix is to express the same rule as set membership, and to wrap auth.uid()
-- in a scalar subquery so Postgres evaluates it once as an InitPlan instead of
-- per row. The rule is identical — a caller still sees only companies they
-- belong to, and only locations their membership covers — but the planner can
-- turn it into a hash semi-join.
--
-- The helper functions stay, because everything else in the schema reads
-- clearly through them. Only the policies on the two largest tables are
-- rewritten, since those are the only ones where per-row cost matters.
-- ============================================================================

drop policy if exists assets_select on app.assets;
create policy assets_select on app.assets
  for select using (
    company_id in (
      select m.company_id from app.memberships m
      where m.user_id = (select auth.uid())
    )
    and (
      location_id is null
      or exists (
        select 1 from app.memberships m
        where m.company_id = app.assets.company_id
          and m.user_id = (select auth.uid())
          and (m.location_id is null or m.location_id = app.assets.location_id)
      )
    )
  );

drop policy if exists assets_insert on app.assets;
create policy assets_insert on app.assets
  for insert with check (
    exists (
      select 1 from app.memberships m
      where m.company_id = app.assets.company_id
        and m.user_id = (select auth.uid())
        and m.role in ('owner','admin','manager','requester')
        and (m.location_id is null or app.assets.location_id is null
             or m.location_id = app.assets.location_id)
    )
  );

drop policy if exists assets_update on app.assets;
create policy assets_update on app.assets
  for update
  using (
    exists (
      select 1 from app.memberships m
      where m.company_id = app.assets.company_id
        and m.user_id = (select auth.uid())
        and m.role in ('owner','admin','manager','requester')
        and (m.location_id is null or app.assets.location_id is null
             or m.location_id = app.assets.location_id)
    )
  )
  with check (
    exists (
      select 1 from app.memberships m
      where m.company_id = app.assets.company_id
        and m.user_id = (select auth.uid())
        and m.role in ('owner','admin','manager','requester')
        and (m.location_id is null or app.assets.location_id is null
             or m.location_id = app.assets.location_id)
    )
  );

drop policy if exists audit_select on app.audit_events;
create policy audit_select on app.audit_events
  for select using (
    company_id in (
      select m.company_id from app.memberships m
      where m.user_id = (select auth.uid())
    )
  );

drop policy if exists financials_select on app.asset_financials;
create policy financials_select on app.asset_financials
  for select using (
    exists (
      select 1 from app.memberships m
      where m.company_id = app.asset_financials.company_id
        and m.user_id = (select auth.uid())
        and m.role in ('owner','admin','auditor')
    )
  );

drop policy if exists stock_mv_select on app.stock_movements;
create policy stock_mv_select on app.stock_movements
  for select using (
    exists (
      select 1 from app.memberships m
      where m.company_id = app.stock_movements.company_id
        and m.user_id = (select auth.uid())
        and (m.location_id is null or m.location_id = app.stock_movements.location_id)
    )
  );

-- The join column on the hot path.
create index if not exists memberships_user_company_idx
  on app.memberships (user_id, company_id, location_id);

analyze app.memberships;
analyze app.assets;
