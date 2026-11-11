#!/bin/bash
# Installs the SDKs the tweaks of one app ask for with `<id>_OWN_SDK`.
#
# Those tweaks pin their own TARGET (and therefore their own SDK), and this
# pipeline only downloads the one SDK it builds the app binary with. This fetches
# the others from the same source the workflow uses.
#
#   Tools/install-own-sdk.sh <app>            install what the app needs
#   Tools/install-own-sdk.sh --list <app>     print the versions, one per line
#
# Reads both registry.mk and custom.mk, so a tweak added through the app that
# carries its own _OWN_SDK is covered too.
set -euo pipefail

list=0
if [[ "${1:-}" == "--list" ]]; then list=1; shift; fi
app=${1:-youtube}

theos=${THEOS:-$HOME/theos}
files=("apps/$app/registry.mk" "apps/$app/custom.mk")
versions=$(grep -hoE '^[A-Za-z0-9._-]+_OWN_SDK[[:space:]]*[:?]?=[[:space:]]*[0-9][0-9.]*' "${files[@]}" 2>/dev/null \
  | sed -E 's/.*=[[:space:]]*//' | sort -u)

if [[ $list == 1 ]]; then
  printf '%s\n' $versions
  exit 0
fi

if [[ -z "$versions" ]]; then
  echo "no tweak of '$app' asks for its own SDK"
  exit 0
fi

for version in $versions; do
  if [[ -d "$theos/sdks/iPhoneOS$version.sdk" ]]; then
    echo "iPhoneOS$version.sdk is already installed"
    continue
  fi
  echo "==> Downloading iPhoneOS$version.sdk"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  git clone --quiet -n --depth=1 --filter=tree:0 https://github.com/xybp888/iOS-SDKs.git "$work/sdks"
  (
    cd "$work/sdks"
    git sparse-checkout set --no-cone "iPhoneOS$version.sdk"
    git checkout --quiet
  )
  if [[ ! -d "$work/sdks/iPhoneOS$version.sdk" ]]; then
    echo "error: xybp888/iOS-SDKs has no iPhoneOS$version.sdk" >&2
    exit 1
  fi
  mkdir -p "$theos/sdks"
  mv "$work/sdks/iPhoneOS$version.sdk" "$theos/sdks/"
  echo "==> Installed $theos/sdks/iPhoneOS$version.sdk"
done
