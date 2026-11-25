#!/usr/bin/env python3
"""Backend CLI for managing invite-only Red Dead Editor accounts."""

from __future__ import annotations

import argparse
import sys

import storage


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Manage Red Dead Editor user accounts.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="Provision a new username")
    p_add.add_argument("username", help="Username to create (2-64 chars: a-z, 0-9, _, ., -)")

    sub.add_parser("list", help="List provisioned accounts")

    p_rm = sub.add_parser("remove", help="Delete an account and all of its cloud data")
    p_rm.add_argument("username", help="Username to remove")

    p_rev = sub.add_parser("revoke-sessions", help="Revoke all active sessions for a username")
    p_rev.add_argument("username", help="Username whose sessions should be revoked")

    args = parser.parse_args(argv)
    # Initialize schema without re-seeding removed accounts during admin actions
    storage.init_db(bootstrap_users=())

    if args.command == "add":
        try:
            user = storage.create_user(args.username)
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1
        print(f"Provisioned user '{user['username']}' (id={user['id']}).")
        return 0

    if args.command == "list":
        users = storage.list_users()
        if not users:
            print("No users provisioned.")
            return 0
        print(f"{'ID':>3}  {'USERNAME':<20} {'ENTRIES':>7}  {'SESSIONS':>8}  {'LAST LOGIN':<25}  {'UPDATED'}")
        for u in users:
            print(
                f"{u['id']:>3}  {u['username']:<20} {u['entry_count']:>7}  {u['active_sessions']:>8}  "
                f"{(u['last_login_at'] or '-'):<25}  {u['updated_at'] or '-'}"
            )
        return 0

    if args.command == "remove":
        try:
            removed = storage.delete_user(args.username)
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1
        if not removed:
            print(f"User '{args.username}' not found.", file=sys.stderr)
            return 1
        print(f"Removed user '{args.username.strip().lower()}'.")
        return 0

    if args.command == "revoke-sessions":
        try:
            count = storage.revoke_user_sessions(args.username)
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1
        print(f"Revoked {count} session(s) for '{args.username.strip().lower()}'.")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
