# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""End-to-end auth test with a throwaway user. Creates it, tests, deletes it."""
import requests
from supa_sql import env, run_sql

URL = env("SUPABASE_URL")
ANON = env("SUPABASE_ANON_KEY")
REF = env("SUPABASE_PROJECT_REF")
TOK = env("SUPABASE_TOKEN")

# service_role key
sk = None
for k in requests.get(f"https://api.supabase.com/v1/projects/{REF}/api-keys",
                      headers={"Authorization": f"Bearer {TOK}"}, timeout=30).json():
    if k.get("name") == "service_role":
        sk = k["api_key"]

EMAIL = "throwaway-test@example.com"
PW = "TestPass123456"

# clean any prior
users = requests.get(f"{URL}/auth/v1/admin/users", headers={"apikey": sk, "Authorization": f"Bearer {sk}"}, timeout=30).json()
for u in users.get("users", []):
    if u["email"].lower() == EMAIL:
        requests.delete(f"{URL}/auth/v1/admin/users/{u['id']}", headers={"apikey": sk, "Authorization": f"Bearer {sk}"}, timeout=30)

# create confirmed user
requests.post(f"{URL}/auth/v1/admin/users", headers={"apikey": sk, "Authorization": f"Bearer {sk}", "Content-Type": "application/json"},
              json={"email": EMAIL, "password": PW, "email_confirm": True}, timeout=30)
login = requests.post(f"{URL}/auth/v1/token?grant_type=password", headers={"apikey": ANON, "Content-Type": "application/json"},
                      json={"email": EMAIL, "password": PW}, timeout=30).json()
jwt = login.get("access_token")
print("login:", "OK" if jwt else login)
H = {"apikey": ANON, "Authorization": f"Bearer {jwt}"}

# 1. authenticated REST read works
r = requests.get(f"{URL}/rest/v1/groups_view?select=group_id", headers=H, timeout=30)
print("authed groups_view ->", r.status_code, "rows:", len(r.json()) if r.status_code == 200 else r.text[:80])

# 2. whoami: not admin yet
r = requests.get(f"{URL}/functions/v1/add-group?whoami=1", headers=H, timeout=30)
print("whoami (non-admin) ->", r.status_code, r.text[:120])

# 3. authed admin endpoint should 403 (not admin)
r = requests.get(f"{URL}/functions/v1/add-group?admins=1", headers=H, timeout=30)
print("admins endpoint (non-admin) ->", r.status_code, "(want 403)")

# 4. add test user to admins table, re-check
run_sql(f"insert into admins (email) values ('{EMAIL}') on conflict do nothing;")
r = requests.get(f"{URL}/functions/v1/add-group?whoami=1", headers=H, timeout=30)
print("whoami (now admin) ->", r.status_code, r.text[:120])
r = requests.get(f"{URL}/functions/v1/add-group?admins=1", headers=H, timeout=30)
print("admins endpoint (now admin) ->", r.status_code, "(want 200)")

# cleanup
run_sql(f"delete from admins where email='{EMAIL}';")
users = requests.get(f"{URL}/auth/v1/admin/users", headers={"apikey": sk, "Authorization": f"Bearer {sk}"}, timeout=30).json()
for u in users.get("users", []):
    if u["email"].lower() == EMAIL:
        requests.delete(f"{URL}/auth/v1/admin/users/{u['id']}", headers={"apikey": sk, "Authorization": f"Bearer {sk}"}, timeout=30)
print("cleaned up throwaway user")
