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
