#!/bin/bash
# Builds one tweak with the SDK its own Makefile pins, instead of the SDK this
# pipeline forces on every other subproject.
#
# Why this exists: the Makefile exports TARGET/SYSROOT/SDK_PATH so that all
# subprojects build against one SDK (the one the app binary needs). A tweak that
# pins its own TARGET - sparkle-ig does, iPhoneOS16.2 - would still be compiled
# against the exported SYSROOT, and then the classes it declares itself clash with
# the ones the newer SDK's headers ship (UIScrollEdgeEffect, UIGlassEffect) and
# Preferences.framework is gone. Building it on its own with those variables
# dropped lets its Makefile decide, which is what its author tests against.
#
#   $1 subproject directory
#   $2 the dylib the root Makefile is going to inject
#   $3 the SDK version the tweak asks for
set -euo pipefail

sub=$1; dylib=$2; sdk=$3

if [[ -z "${THEOS:-}" || ! -d "$THEOS/sdks/iPhoneOS$sdk.sdk" ]]; then
  echo "error: $sub asks for iPhoneOS$sdk.sdk, which is not installed in ${THEOS:-<THEOS not set>}/sdks" >&2
  echo "error: run Tools/install-own-sdk.sh with the app id to fetch it" >&2
  exit 1
fi

echo "==> Building $sub with its own SDK (iPhoneOS$sdk)"
env -u TARGET -u SYSROOT -u SDK_PATH -u THEOS_BUILD_DIR -u ARCHS \
  make -C "$sub" --no-keep-going all THEOS_PACKAGE_SCHEME=rootless

# The subproject inherits THEOS_OBJ_DIR, so its dylib lands where the root
# Makefile expects it. Refuse to continue if it did not, rather than inject a
# stale or missing library.
if [[ ! -f "$dylib" ]]; then
  found=$(find "$sub" -name "$(basename "$dylib")" -print -quit 2>/dev/null || true)
  echo "error: $sub produced no $(basename "$dylib") at $dylib (found: ${found:-nowhere})" >&2
  exit 1
fi
echo "==> $(basename "$dylib") ready"
