#!/usr/bin/env python3
"""Inspect a decrypted .ipa and record what app it actually is.

The build pipeline is app-agnostic: it needs to know which app set in apps/ a
given IPA belongs to before it can pick tweaks. Nothing but the bundle
identifier can answer that, and the bundle identifier only exists inside the
archive, so this runs right after an IPA URL is added or changed:

  * read Payload/*.app/Info.plist for the bundle id, display name, version and
    executable name,
  * pull the app icon out of the bundle,
  * map the bundle id to an app in apps/ (or create a new one),
  * merge the result into apps/<id>/app.json.

The IPA itself is never written into the repository - it is only read here and
dropped again. Tools/inspect-ipa.py is the whole check, so
.github/workflows/inspect-ipa.yml stays a thin wrapper around it.

`source` records a SHA-256 of the URL the IPA was fetched from. The URL itself
is a secret (it is where the decrypted app comes from) and never lands in the
repository, but the build workflow can recompute the hash and refuse to build
when the URL no longer matches what was inspected - that is what makes a build
only possible after a successful inspection.

Usage:
    Tools/inspect-ipa.py --ipa /tmp/Instagram.ipa --repo . \
        --source-url "https://..." --print
"""

import argparse
import hashlib
import json
import plistlib
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ICON_SUFFIXES = ("@3x.png", "@2x.png", ".png")
APP_ID_RE = re.compile(r"[^a-z0-9]+")


def die(message):
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def slug_for(bundle_id):
    """A stable, filesystem- and Makefile-safe id for an app we have not seen."""
    tail = bundle_id.split(".")[-1] or bundle_id
    slug = APP_ID_RE.sub("-", tail.lower()).strip("-")
    return slug or APP_ID_RE.sub("-", bundle_id.lower()).strip("-") or "app"


def app_info(archive):
    """The Payload/*.app bundle inside the IPA: its name, plist and members."""
    names = archive.namelist()
    apps = sorted({n.split("/")[1] for n in names
                   if n.startswith("Payload/") and n.count("/") >= 2 and n.split("/")[1].endswith(".app")})
    if not apps:
        die("the archive has no Payload/*.app bundle")
    app = apps[0]
    root = f"Payload/{app}/"
    plist_name = root + "Info.plist"
    if plist_name not in names:
        die(f"{plist_name} is missing - not a decrypted .ipa?")
    with archive.open(plist_name) as handle:
        plist = plistlib.load(handle)
    return root, plist, set(names)


def icon_names(plist):
    """Icon file base names, primary icon first."""
    names = []
    for key in ("CFBundleIcons", "CFBundleIcons~ipad"):
        icons = plist.get(key)
        if not isinstance(icons, dict):
            continue
        primary = icons.get("CFBundlePrimaryIcon")
        if isinstance(primary, dict):
            names += [f for f in primary.get("CFBundleIconFiles", []) if isinstance(f, str)]
    names += [f for f in plist.get("CFBundleIconFiles", []) if isinstance(f, str)]
    if isinstance(plist.get("CFBundleIconName"), str):
        names.append(plist["CFBundleIconName"])
    return names


def extract_icon(archive, root, names, plist):
    """The largest icon PNG the bundle carries as a loose file, or None."""
    for base in icon_names(plist):
        for suffix in ICON_SUFFIXES:
            candidate = root + base + suffix
            if candidate in names:
                with archive.open(candidate) as handle:
                    return handle.read()

    # Bundles that only list CFBundleIconName (or nothing at all) still ship
    # their AppIcon PNGs next to the executable; take the largest one.
    candidates = sorted(
        (n for n in names if n.startswith(root) and n.endswith(".png") and "AppIcon" in n),
        key=lambda n: archive.getinfo(n).file_size,
        reverse=True,
    )
    for name in candidates:
        with archive.open(name) as handle:
            return handle.read()
    return None


def load_apps(repo):
    apps = {}
    for path in sorted((repo / "apps").glob("*/app.json")):
        try:
            data = json.loads(path.read_text())
        except ValueError:
            continue
        data.setdefault("id", path.parent.name)
        apps[path.parent.name] = data
    return apps


def resolve_app_id(apps, bundle_id, override):
    for app_id, data in apps.items():
        if bundle_id in (data.get("bundleIds") or []):
            return app_id
    if override:
        return override
    return slug_for(bundle_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ipa", required=True, help="the downloaded .ipa to inspect")
    parser.add_argument("--repo", default=".", help="repository root (default: .)")
    parser.add_argument("--app-id", default="", help="force this app id instead of matching the bundle id")
    parser.add_argument("--source-url", default="", help="URL the IPA came from; only its hash is stored")
    parser.add_argument("--write", action="store_true", help="write apps/<id>/app.json and icon.png")
    parser.add_argument("--print", dest="print_result", action="store_true", help="print the result as JSON")
    args = parser.parse_args()

    ipa = Path(args.ipa)
    if not ipa.is_file():
        die(f"{ipa} does not exist")
    repo = Path(args.repo).resolve()

    with zipfile.ZipFile(ipa) as archive:
        root, plist, names = app_info(archive)
        bundle_id = plist.get("CFBundleIdentifier")
        if not bundle_id:
            die("Info.plist has no CFBundleIdentifier")
        icon = extract_icon(archive, root, names, plist)

    name = (plist.get("CFBundleDisplayName") or plist.get("CFBundleName")
            or bundle_id.split(".")[-1])
    version = plist.get("CFBundleShortVersionString") or plist.get("CFBundleVersion") or ""
    executable = plist.get("CFBundleExecutable") or ""

    apps = load_apps(repo)
    app_id = resolve_app_id(apps, bundle_id, args.app_id.strip())
    entry = apps.get(app_id, {"id": app_id})

    entry["id"] = app_id
    entry["name"] = name
    entry["bundleIds"] = sorted(set((entry.get("bundleIds") or []) + [bundle_id]))
    entry["version"] = version
    entry["executable"] = executable
    entry["inspectedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if args.source_url:
        entry["source"] = "sha256:" + hashlib.sha256(args.source_url.encode()).hexdigest()
    if icon:
        entry["icon"] = "icon.png"
    else:
        entry.pop("icon", None)

    result = {
        "appId": app_id,
        "bundleId": bundle_id,
        "name": name,
        "version": version,
        "executable": executable,
        "icon": bool(icon),
        "appDir": f"apps/{app_id}",
        "created": app_id not in apps,
    }

    if args.write:
        app_dir = repo / "apps" / app_id
        app_dir.mkdir(parents=True, exist_ok=True)
        if icon:
            (app_dir / "icon.png").write_bytes(icon)
        manifest = app_dir / "app.json"
        # Re-inspecting an IPA the repository has already recorded must not become a
        # commit: keeping the previous timestamp when nothing else changed makes the
        # write a no-op, so the workflow takes its "no metadata change" path instead
        # of pushing. When the app was last verified is a question about *this*
        # device anyway, and the app answers it itself (see BuildStore.verifiedAt),
        # so nothing user-visible is lost here.
        previous = None
        if manifest.is_file():
            try:
                previous = json.loads(manifest.read_text())
            except ValueError:
                previous = None
        if previous and previous.get("inspectedAt"):
            without_stamp = lambda data: {k: v for k, v in data.items() if k != "inspectedAt"}
            if without_stamp(previous) == without_stamp(entry):
                entry["inspectedAt"] = previous["inspectedAt"]
        manifest.write_text(json.dumps(entry, indent=2) + "\n")
        result["appDir"] = str(app_dir.relative_to(repo))

    if args.print_result:
        print(json.dumps(result, indent=2))
    else:
        for key, value in result.items():
            print(f"{key}: {value}")


if __name__ == "__main__":
    main()
