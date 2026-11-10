# Prebuilt YouTube payloads: YTPlus (formerly YTLite) and Gonerino ship as .deb
# packages, so their paths are constants rather than build outputs. If upstream
# renames the library or the bundle, adjust the *_REL lines - the generic
# extraction in Tools/prepare-payload.sh fails loudly if they change.
#
# The Makefile reads APP_PAYLOAD_TWEAKS and the <id>_* block, downloads the URL,
# unpacks the .deb and injects the named dylib plus its staged bundle.

APP_PAYLOAD_TWEAKS = YTPlus Gonerino

YTPlus_VERSION = 6.0
YTPlus_URL = https://repo.ballermc.com/tubevault/%5BROOTLESS%5Dcom.dvntm.ytlite_$(YTPlus_VERSION)_iphoneos-arm64_patched_SpyG.deb
YTPlus_DYLIB_REL = var/jb/Library/MobileSubstrate/DynamicLibraries/YTLite.dylib
YTPlus_BUNDLE_REL = var/jb/Library/Application Support/YTLite.bundle
YTPlus_BUNDLE_NAME = YTLite.bundle

Gonerino_VERSION = 1.8.10
Gonerino_URL = https://github.com/castdrian/Gonerino/releases/download/v$(Gonerino_VERSION)/dev.adrian.gonerino_$(Gonerino_VERSION)_iphoneos-arm64.deb
Gonerino_DYLIB_REL = var/jb/Library/MobileSubstrate/DynamicLibraries/Gonerino.dylib
Gonerino_BUNDLE_REL = var/jb/Library/Application Support/Gonerino.bundle
Gonerino_BUNDLE_NAME = Gonerino.bundle
