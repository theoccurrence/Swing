#!/bin/bash
# Downloads and unpacks one prebuilt tweak payload (.deb) for the AppBuilder
# build. Deliberately generic: the Makefile passes exactly what an app's
# payloads.mk declares, so no payload is known here by name.
#
#   $1 id           payload id, only used for messages
#   $2 url          download URL of the .deb
#   $3 dylib_rel    dylib path inside the unpacked .deb
#   $4 bundle_rel   bundle path inside the unpacked .deb (may contain spaces)
#   $5 bundle_name  path the bundle is staged under, without spaces
#   $6 work         working directory for this payload
set -euo pipefail

id=$1; url=$2; dylib_rel=$3; bundle_rel=$4; bundle_name=$5; work=$6

mkdir -p "$work"
deb="$work/$id.deb"

if [[ ! -f "$deb" ]]; then
  echo "==> Downloading $id"
  curl -fsSL "$url" -o "$deb"
fi

if [[ ! -f "$work/$dylib_rel" ]]; then
  echo "==> Extracting $id"
  tar -xf "$deb" -C "$work"
  tar -xf "$work"/data.tar.* -C "$work"
fi

# theos-jailed reads EMBED_BUNDLES by word splitting, so the bundle has to end up
# at a path without spaces - "Application Support" would be split into two args.
if [[ ! -d "$work/$bundle_name" && -d "$work/$bundle_rel" ]]; then
  mv "$work/$bundle_rel" "$work/$bundle_name"
fi

if [[ ! -f "$work/$dylib_rel" || ! -d "$work/$bundle_name" ]]; then
  echo "error: $id did not yield $dylib_rel and $bundle_name" >&2
  exit 1
fi
echo "==> $id ready"
