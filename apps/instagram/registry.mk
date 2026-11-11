# Tweak registry of the Instagram app set.
#
# sparkle-ig (https://github.com/efibalogh/sparkle-ig) builds a tweak called
# Sparkle from its repository root; it ships its resources as Sparkle.bundle,
# which Bundles/Sparkle.bundle symlinks into the app.
APP_NAME = Instagram
APP_BUNDLE_ID = com.burbn.instagram
APP_PROCESS_NAME = Instagram

APP_DEFAULT_TWEAKS = sparkle-ig
APP_TWEAK_REGISTRY = sparkle-ig

sparkle-ig_SUBPROJECT = Tweaks/sparkle-ig
sparkle-ig_DYLIB = Sparkle

# sparkle-ig is written for the SDK its own Makefile pins (iPhoneOS16.2): it
# declares the iOS 26 UIKit classes it hooks itself and links Preferences.framework,
# and in the newer SDK the classes clash with UIKit's own declarations while
# Preferences is gone. So it builds with its own SDK, the way its author does -
# no patch to its sources, and nothing about the other tweaks changes.
# Tools/install-own-sdk.sh fetches that SDK; the build workflow runs it.
sparkle-ig_OWN_SDK = 16.2
