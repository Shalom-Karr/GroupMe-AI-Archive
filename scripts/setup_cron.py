# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""Enable pg_cron + pg_net and schedule the update-groupme sync every 10 minutes."""

from supa_sql import run_sql, env

ref = env("SUPABASE_PROJECT_REF")
sync_key = env("SYNC_KEY")
url = f"https://{ref}.supabase.co/functions/v1/update-groupme?key={sync_key}"

print(run_sql("create extension if not exists pg_cron; create extension if not exists pg_net;"))
print(run_sql("select cron.unschedule(jobid) from cron.job where jobname = 'groupme-sync';"))
print(run_sql(f"""
select cron.schedule(
  'groupme-sync',
  '0 */6 * * *',
  $$ select net.http_post(url := '{url}', body := '{{}}'::jsonb) $$
);"""))
print(run_sql("select jobid, jobname, schedule, active from cron.job;"))
