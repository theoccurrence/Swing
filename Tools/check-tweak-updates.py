#!/usr/bin/env python3
"""Report which of the repository's tweaks lag behind their upstream repositories.

Every app under apps/ owns its tweak set: registry.mk lists its tweaks, payloads.mk
the prebuilt .deb payloads, custom.mk the tweaks added through the app. This tool
reads all of them, so one run covers every app - the tweak ids are unique because
they name the submodule folder under Tweaks/.

Three kinds of tweaks are distinguished:

  submodule  a git submodule pinned to a commit - the update is a new gitlink
  payload    a prebuilt .deb downloaded by the build (YTPlus, Gonerino)
  switch     a selectable id the build acts on and nothing is compiled for it
  vendored   code that lives in this repository and has no upstream

Upstream versions are read from raw.githubusercontent.com and git ls-remote, so
the check needs no API token and does not touch the GitHub API rate limit. Used
by .github/workflows/update-tweaks.yml and by the local web UI (``--json``).

Usage:
    Tools/check-tweak-updates.py                  # table for every app
    Tools/check-tweak-updates.py --json           # machine readable
    Tools/check-tweak-updates.py --app youtube --only YTPlus,YTweaks
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

USER_AGENT = "AppBuilder-check-tweak-updates"
NETWORK_TIMEOUT = 8
GIT_TIMEOUT = 25
WORKERS = 8

# The files an app provides. registry.mk defines the app, custom.mk extends it
# with tweaks added through the app, payloads.mk adds prebuilt payloads.
APP_FILES = ("registry.mk", "custom.mk", "payloads.mk")


def die(message):
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def run(cmd, cwd=None, timeout=GIT_TIMEOUT):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)


# ---------------------------------------------------------------------------
# Local repository state
# ---------------------------------------------------------------------------

def parse_makefile(text):
    """Return the variables a set of app makefiles sets.

    The first plain assignment wins, `+=` lines extend it - that is how the tweaks
    added through the app are layered on from custom.mk.
    """
    joined = re.sub(r"\\\r?\n[ \t]*", " ", text)
    variables = {}
    for line in joined.splitlines():
        match = re.match(r"^([A-Za-z0-9_\-]+)\s*(\+?[:?]?=)\s*(.*)$", line)
        if not match:
            continue
        name, operator, value = match.group(1), match.group(2), match.group(3).strip()
        if operator == "+=" and name in variables:
            variables[name] = f"{variables[name]} {value}".strip()
        elif name not in variables:
            variables[name] = value
    return variables


def app_ids(repo):
    return sorted(p.parent.name for p in (repo / "apps").glob("*/registry.mk"))


def app_makefile(repo, app):
    """The app's registry plus the files that extend it, in include order."""
    text = ""
    for name in APP_FILES:
        path = repo / "apps" / app / name
        if path.is_file():
            text += path.read_text(errors="replace") + "\n"
    return text


def app_manifest(repo, app):
    path = repo / "apps" / app / "app.json"
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text())
    except ValueError:
        return {}


def submodule_urls(repo):
    """Return {path: {"url": ..., "branch": ...}} from .gitmodules."""
    out = run(["git", "config", "-f", ".gitmodules", "--get-regexp",
               r"^submodule\..*\.(path|url|branch)$"], cwd=repo)
    if out.returncode != 0:
        return {}
    modules = {}
    for line in out.stdout.splitlines():
        key, _, value = line.partition(" ")
        match = re.match(r"submodule\.(.*)\.(path|url|branch)$", key)
        if not match:
            continue
        name, field = match.groups()
        modules.setdefault(name, {})[field] = value
    return {m["path"]: m for m in modules.values() if "path" in m}


def gitlink(repo, path):
    """The commit a submodule is pinned to (works without the submodule checked out)."""
    fields = run(["git", "ls-tree", "HEAD", "--", path], cwd=repo).stdout.split()
    return fields[2][:8] if len(fields) > 2 and fields[1] == "commit" else None


def control_version(path):
    control = Path(path) / "control"
    if not control.is_file():
        return None
    match = re.search(r"^Version:\s*(.+)$", control.read_text(errors="replace"), re.M)
    return match.group(1).strip() if match else None


# ---------------------------------------------------------------------------
# Upstream state
# ---------------------------------------------------------------------------

class Offline(Exception):
    pass


def fetch_text(url, token=None):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=NETWORK_TIMEOUT) as response:
            return response.read().decode("utf8", "replace")
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None
        raise Offline(f"HTTP {err.code} for {url}") from err
    except Exception as err:  # URLError, timeout, ...
        raise Offline(f"{err} for {url}") from err


def fetch_release(slug, token=None):
    text = fetch_text(f"https://api.github.com/repos/{slug}/releases/latest", token)
    if text is None:
        return None
    try:
        return json.loads(text)
    except ValueError as err:
        raise Offline(f"invalid JSON for {slug}") from err


def remote_head(url):
    """Return (branch, commit) of a remote's default branch in a single call."""
    out = run(["git", "ls-remote", "--symref", url, "HEAD"])
    if out.returncode != 0:
        raise Offline(out.stderr.strip() or f"could not reach {url}")
    branch, commit = None, None
    for line in out.stdout.splitlines():
        if line.startswith("ref:"):
            branch = line.split()[1].removeprefix("refs/heads/")
        elif line.strip():
            commit = line.split()[0][:8]
    return branch, commit


def remote_branch(url, branch):
    fields = run(["git", "ls-remote", url, branch]).stdout.split()
    return fields[0][:8] if fields else None


def github_slug(url):
    match = re.match(r"https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?(?:/|$)", url or "")
    return f"{match.group(1)}/{match.group(2)}" if match else None


def control_version_text(text):
    if not text:
        return None
    match = re.search(r"^Version:\s*(.+)$", text, re.M)
    return match.group(1).strip() if match else None


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def lookup(makefile, name):
    """A Makefile variable, matched case-insensitively.

    Make variable names are case-sensitive, but the payload ids are written the
    way the tweak is spelled (``Gonerino``) while the variables the update
    workflow bumps are found by id. Matching case-insensitively keeps both the
    Makefile and this tool happy with one spelling of each variable.
    """
    if name in makefile:
        return makefile[name]
    lowered = name.lower()
    for key, value in makefile.items():
        if key.lower() == lowered:
            return value
    return None


def variable_name(makefile, name):
    """The spelling of a variable as the app's makefiles define it."""
    if name in makefile:
        return name
    lowered = name.lower()
    for key in makefile:
        if key.lower() == lowered:
            return key
    return name


def local_entry(repo, tweak_id, makefile, modules, payloads, switches=()):
    subproject = lookup(makefile, f"{tweak_id}_SUBPROJECT")
    path = next((p for p in modules if subproject and (subproject == p or subproject.startswith(p + "/"))),
                subproject or f"Tweaks/{tweak_id}")
    entry = {
        "id": tweak_id,
        "path": path,
        "apps": [],
        "kind": None,
        "url": None,
        "ref": None,
        "version_var": None,
        "local_version": None,
        "upstream_version": None,
        "local_commit": None,
        "upstream_commit": None,
        "outdated": None,
        "note": None,
    }
    if tweak_id in switches:
        # A switch compiles and injects nothing itself - the build acts on it.
        entry["kind"] = "switch"
        entry["outdated"] = False
        entry["note"] = "build switch - nothing to compare"
    elif tweak_id in payloads:
        entry["kind"] = "payload"
        entry["url"] = lookup(makefile, f"{tweak_id}_URL")
        entry["local_version"] = lookup(makefile, f"{tweak_id}_VERSION")
        # The exact spelling the update workflow has to bump in payloads.mk.
        entry["version_var"] = variable_name(makefile, f"{tweak_id}_VERSION")
    elif path in modules:
        entry["kind"] = "submodule"
        entry["url"] = modules[path].get("url")
        entry["ref"] = modules[path].get("branch")
        entry["local_version"] = control_version(repo / path)
        entry["local_commit"] = gitlink(repo, path)
    else:
        entry["kind"] = "vendored"
        entry["local_version"] = control_version(repo / path)
        entry["outdated"] = False
        entry["note"] = "lives in this repository"
    return entry


def support_entry(repo, path, modules):
    """A header/library submodule the tweaks build against (no control file)."""
    module = modules.get(path) or {}
    return {
        "id": path,
        "path": path,
        "apps": [],
        "kind": "support",
        "url": module.get("url"),
        "ref": module.get("branch"),
        "local_version": control_version(repo / path),
        "upstream_version": None,
        "local_commit": gitlink(repo, path),
        "upstream_commit": None,
        "outdated": None,
        "note": None,
    }


def fill_upstream(entry, token, state):
    """Add the upstream version/commit. Runs in a worker, must not raise."""
    try:
        if entry["kind"] == "switch":
            return
        if entry["kind"] in ("submodule", "support"):
            url, branch = entry["url"], entry["ref"]
            if not url:
                entry["note"] = "no .gitmodules entry"
                return
            commit = remote_branch(url, branch) if branch else None
            if branch is None:
                branch, commit = remote_head(url)
            slug = github_slug(url)
            entry["ref"] = branch
            entry["upstream_commit"] = commit
            entry["upstream_version"] = control_version_text(
                fetch_text(f"https://raw.githubusercontent.com/{slug}/{branch}/control", token)) if slug else None
            # A support module has no control file of its own to compare against,
            # so only the pinned commit decides whether it is behind.
            if entry["kind"] == "support":
                entry["outdated"] = bool(entry["local_commit"] and commit and entry["local_commit"] != commit)
            else:
                entry["outdated"] = bool(
                    (entry["local_commit"] and commit and entry["local_commit"] != commit)
                    or (entry["upstream_version"] and entry["local_version"] != entry["upstream_version"]))
        elif entry["kind"] == "payload":
            slug = github_slug(entry["url"])
            if not slug:
                entry["note"] = "outside GitHub - update it manually"
                return
            entry["url"] = f"https://github.com/{slug}"
            release = fetch_release(slug, token)
            if not release:
                entry["note"] = "no GitHub release"
                return
            latest = (release.get("tag_name") or "").lstrip("v")
            entry["upstream_version"] = latest or None
            entry["outdated"] = bool(latest and latest != entry["local_version"])
    except Offline as err:
        state["offline"] = True
        entry["note"] = f"offline ({err})"
    except subprocess.TimeoutExpired:
        state["offline"] = True
        entry["note"] = "offline (git timed out)"


def collect(repo, only=None, token=None, apps_filter=None):
    modules = submodule_urls(repo)
    apps = [a for a in app_ids(repo) if not apps_filter or a in apps_filter]
    if not apps:
        return {
            "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "offline": False, "apps": [], "tweaks": [], "outdated": [],
            "support": [], "outdated_support": [],
        }

    tweaks = {}
    support = {}
    summaries = []
    for app in apps:
        makefile = parse_makefile(app_makefile(repo, app))
        manifest = app_manifest(repo, app)
        registry = (makefile.get("APP_TWEAK_REGISTRY") or "").split()
        payloads = set((makefile.get("APP_PAYLOAD_TWEAKS") or "").split())
        switches = set((makefile.get("APP_SWITCH_TWEAKS") or "").split())
        summaries.append({
            "id": app,
            "name": manifest.get("name") or app,
            "bundle_ids": manifest.get("bundleIds") or [],
            "defaults": (makefile.get("APP_DEFAULT_TWEAKS") or "").split(),
            "custom": (makefile.get("CUSTOM_TWEAKS") or "").split(),
        })
        for tweak_id in registry + sorted(payloads) + sorted(switches):
            if only and tweak_id not in only:
                continue
            entry = tweaks.get(tweak_id) or local_entry(repo, tweak_id, makefile, modules, payloads, switches)
            entry.setdefault("apps", [])
            if app not in entry["apps"]:
                entry["apps"].append(app)
            tweaks[tweak_id] = entry
        for path in (makefile.get("APP_SUPPORT_SUBMODULES") or "").split():
            if path not in modules:
                continue
            entry = support.get(path) or support_entry(repo, path, modules)
            entry.setdefault("apps", [])
            if app not in entry["apps"]:
                entry["apps"].append(app)
            support[path] = entry

    tweak_list = sorted(tweaks.values(), key=lambda t: t["id"])
    support_list = sorted(support.values(), key=lambda s: s["path"])

    state = {"offline": False}
    everything = tweak_list + support_list
    with ThreadPoolExecutor(max_workers=min(WORKERS, max(len(everything), 1))) as pool:
        list(pool.map(lambda entry: fill_upstream(entry, token, state), everything))

    return {
        "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "offline": state["offline"],
        "apps": summaries,
        "tweaks": tweak_list,
        "outdated": [t["id"] for t in tweak_list if t["outdated"]],
        "support": support_list,
        "outdated_support": [s["path"] for s in support_list if s["outdated"]],
    }


def print_report(report):
    by_app = {}
    for tweak in report["tweaks"]:
        by_app.setdefault(tweak["apps"][0] if tweak["apps"] else "-", []).append(tweak)
    for app in report.get("apps", []):
        print(f"\n{app['id']} ({app['name']})")
        for tweak in by_app.get(app["id"], []):
            if tweak["outdated"]:
                status = "OUTDATED"
                detail = f"{tweak['local_version']} -> {tweak['upstream_version']}"
            elif tweak["outdated"] is False:
                status, detail = "ok", str(tweak["local_version"] or "-")
            else:
                status, detail = "unknown", tweak["note"] or "-"
            location = tweak["url"] or tweak["note"] or ""
            if tweak["ref"]:
                location = f"{location} @ {tweak['ref']}"
            print(f"  {status:9} {tweak['id']:24} {detail:22} {location}")
    for entry in report.get("support", []):
        if entry["outdated"]:
            print(f"\n  OUTDATED  {entry['id']:24} {'shared module':22} "
                  f"{entry['local_commit']} -> {entry['upstream_commit']}")
    if report["offline"]:
        print("\nnetwork unreachable - upstream versions could not be checked")
        return
    parts = []
    if report["outdated"]:
        parts.append(f"{len(report['outdated'])} outdated: {' '.join(report['outdated'])}")
    if report.get("outdated_support"):
        parts.append(f"shared modules behind: {' '.join(report['outdated_support'])}")
    print("\n" + " · ".join(parts) if parts else "\nall tweaks up to date")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[1]),
                        help="repository root (default: the parent of this script's directory)")
    parser.add_argument("--app", default="", help="only this app (a directory under apps/)")
    parser.add_argument("--only", default="", help="comma/space separated tweak ids to check")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    parser.add_argument("--token", default=os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN"),
                        help="GitHub token, only used to raise the API rate limit (default: $GITHUB_TOKEN)")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    if not (repo / "apps").is_dir():
        die(f"{repo} does not look like the repository root (no apps/ directory)")

    only = {id_ for id_ in re.split(r"[\s,]+", args.only) if id_}
    apps_filter = {args.app} if args.app else None
    report = collect(repo, only=only, token=args.token, apps_filter=apps_filter)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report)


if __name__ == "__main__":
    main()
