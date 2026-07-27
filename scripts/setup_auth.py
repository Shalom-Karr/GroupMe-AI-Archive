# GroupMe Archive
# Copyright (c) 2026 Shalom Karr
# Source-available under AGPL-3.0 WITH the Commons Clause: no commercial or paid
# use without permission, and derivatives must remain open under the same terms.
# See the LICENSE file for full terms.

"""Create the admin auth user for the gated admin page.

Usage: python setup_auth.py <email> [password]
Generates a password if not given; prints it once.
"""

import secrets
import string
import sys

import requests

from supa_sql import env


def service_key():
    ref = env("SUPABASE_PROJECT_REF")
    r = requests.get(f"https://api.supabase.com/v1/projects/{ref}/api-keys",
                     headers={"Authorization": f"Bearer {env('SUPABASE_TOKEN')}"}, timeout=30)
    r.raise_for_status()
    for k in r.json():
        if k.get("name") == "service_role":
            return k["api_key"]
    sys.exit("service_role key not found")


def main():
    email = sys.argv[1] if len(sys.argv) > 1 else sys.exit("usage: setup_auth.py <email> [password]")
    password = sys.argv[2] if len(sys.argv) > 2 else "".join(
        secrets.choice(string.ascii_letters + string.digits) for _ in range(16))
    sk = service_key()
    url = env("SUPABASE_URL")
    r = requests.post(f"{url}/auth/v1/admin/users",
                      headers={"apikey": sk, "Authorization": f"Bearer {sk}", "Content-Type": "application/json"},
                      json={"email": email, "password": password, "email_confirm": True}, timeout=30)
    if r.status_code == 422 and "already" in r.text.lower():
        print(f"User {email} already exists - updating password.")
        users = requests.get(f"{url}/auth/v1/admin/users",
                             headers={"apikey": sk, "Authorization": f"Bearer {sk}"}, timeout=30).json()
        uid = next(u["id"] for u in users.get("users", []) if u["email"].lower() == email.lower())
        r = requests.put(f"{url}/auth/v1/admin/users/{uid}",
                         headers={"apikey": sk, "Authorization": f"Bearer {sk}", "Content-Type": "application/json"},
                         json={"password": password}, timeout=30)
    r.raise_for_status()
    print(f"Admin login ready:\n  email:    {email}\n  password: {password}")


if __name__ == "__main__":
    main()
