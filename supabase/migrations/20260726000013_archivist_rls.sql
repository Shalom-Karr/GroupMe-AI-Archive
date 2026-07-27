-- GroupMe Archive
-- Copyright (c) 2026 Shalom Karr
-- Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
-- use without permission, and derivatives must remain open under the same terms.
-- See the LICENSE file for full terms.

-- Confine run_readonly (the LLM SQL tool) to one group via real RLS.
-- Runs the untrusted SELECT as a dedicated non-bypassrls role subject to RLS,
-- scoped by transaction-local GUCs app.gid / app.scope.

-- 1. Low-privilege role: NOT superuser, NOT bypassrls, no login.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'archivist_ro') then
    create role archivist_ro nologin noinherit;
  end if;
end $$;

grant archivist_ro to postgres;
grant usage on schema public to archivist_ro;
grant select on public.messages, public.members, public.events,
                public.member_scores, public.group_stats to archivist_ro;

-- 2. Restrict existing anon "public read" policies to the API roles so they do
--    NOT also apply (permissive OR) to archivist_ro. Dashboards unaffected.
drop policy if exists "public read messages"      on public.messages;
drop policy if exists "public read members"       on public.members;
drop policy if exists "public read events"        on public.events;
drop policy if exists "public read member_scores" on public.member_scores;
drop policy if exists "public read group_stats"   on public.group_stats;

create policy "public read messages"      on public.messages      for select to anon, authenticated using (true);
create policy "public read members"       on public.members       for select to anon, authenticated using (true);
create policy "public read events"        on public.events        for select to anon, authenticated using (true);
create policy "public read member_scores" on public.member_scores for select to anon, authenticated using (true);
create policy "public read group_stats"   on public.group_stats   for select to anon, authenticated using (true);

-- 3. Confinement policies for archivist_ro only. Fail-closed: unset GUC -> NULL -> false.
drop policy if exists "archivist scoped messages"      on public.messages;
drop policy if exists "archivist scoped members"       on public.members;
drop policy if exists "archivist scoped events"        on public.events;
drop policy if exists "archivist scoped member_scores" on public.member_scores;
drop policy if exists "archivist scoped group_stats"   on public.group_stats;
create policy "archivist scoped messages" on public.messages for select to archivist_ro
  using (current_setting('app.scope', true) = 'global' or group_id = current_setting('app.gid', true));
create policy "archivist scoped members" on public.members for select to archivist_ro
  using (current_setting('app.scope', true) = 'global' or group_id = current_setting('app.gid', true));
create policy "archivist scoped events" on public.events for select to archivist_ro
  using (current_setting('app.scope', true) = 'global' or group_id = current_setting('app.gid', true));
create policy "archivist scoped member_scores" on public.member_scores for select to archivist_ro
  using (current_setting('app.scope', true) = 'global' or group_id = current_setting('app.gid', true));
create policy "archivist scoped group_stats" on public.group_stats for select to archivist_ro
  using (current_setting('app.scope', true) = 'global' or group_id = current_setting('app.gid', true));

-- 4. Close the SECURITY DEFINER escalation path (these run as postgres/bypassrls).
revoke execute on function public.leaderboard(text, bigint, boolean) from public;
revoke execute on function public.period_stats(text, bigint)         from public;
revoke execute on function public.likes_given(text, bigint)          from public;

-- 5. Harden views so they honor the caller's RLS (anon unaffected: base-table policy is true).
alter view public.groups_view   set (security_invoker = on);
alter view public.member_months set (security_invoker = on);

-- 6. run_readonly OWNED BY archivist_ro (non-bypassrls). As a SECURITY DEFINER function
--    its body runs as archivist_ro -> RLS enforced. (SET ROLE is forbidden inside a
--    definer fn, so ownership is the mechanism.) archivist_ro needs CREATE on the schema
--    only to accept ownership; grant it, transfer, then revoke it back.
drop function if exists public.run_readonly(text);
drop function if exists public.run_readonly(text, text, boolean);

create function public.run_readonly(q text, gid text default null, is_global boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if q ~* '\m(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|vacuum|merge|call|do|set|reset|security)\M' then
    raise exception 'only read-only SELECT queries are allowed';
  end if;
  if q !~* '^\s*(select|with)\M' then
    raise exception 'only read-only SELECT queries are allowed';
  end if;
  perform set_config('app.gid',   coalesce(gid, ''), true);
  perform set_config('app.scope', case when is_global then 'global' else 'group' end, true);
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', q) into result;
  return result;
end;
$$;

grant create on schema public to archivist_ro;
alter function public.run_readonly(text, text, boolean) owner to archivist_ro;
revoke create on schema public from archivist_ro;

revoke all     on function public.run_readonly(text, text, boolean) from public, anon, authenticated;
grant  execute on function public.run_readonly(text, text, boolean) to service_role;
