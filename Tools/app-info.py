#!/usr/bin/env python3
"""Read one field out of an app's apps/<id>/app.json.

The workflows and the local web UI treat apps/<id>/app.json as the single
manifest of an app: what it is called, its bundle id, its icon, and the build
extras it needs (alternate icons, Safari extensions). This is the tiny reader
they share, so no workflow has to hand-parse JSON.

    Tools/app-info.py --app youtube --field name
    Tools/app-info.py --app youtube --field build.safariExtensions
"""

import argparse
import json
import sys
from pathlib import Path


def die(message):
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=".", help="repository root (default: .)")
    parser.add_argument("--app", required=True, help="app id, i.e. the directory under apps/")
    parser.add_argument("--field", default="", help="dotted path to a field; empty prints the whole manifest")
    parser.add_argument("--default", default="", help="printed when the field is missing")
    args = parser.parse_args()

    manifest = Path(args.repo).resolve() / "apps" / args.app / "app.json"
    if not manifest.is_file():
        die(f"{manifest} does not exist")
    try:
        value = json.loads(manifest.read_text())
    except ValueError as err:
        die(f"{manifest} is not valid JSON: {err}")

    if args.field:
        for part in args.field.split("."):
            if isinstance(value, dict) and part in value:
                value = value[part]
            elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
                value = value[int(part)]
            else:
                print(args.default)
                return

    if isinstance(value, (dict, list)):
        print(json.dumps(value))
    elif isinstance(value, bool):
        print("true" if value else "false")
    elif value is None:
        print(args.default)
    else:
        print(value)


if __name__ == "__main__":
    main()
