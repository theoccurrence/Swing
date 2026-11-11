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

# sparkle-ig hooks UIScrollEdgeEffect, a class UIKit only ships from iOS 26 on,
# while the package targets iOS 15. The hooks are installed only behind a runtime
# objc_getClass check, but the compiler still warns that the type is newer than
# the deployment target - and Theos builds with -Werror. Demote that one warning
# instead of failing, the way the YouTube set demotes the libc++ one.
APP_ADDITIONAL_CFLAGS = -Wno-error=unguarded-availability-new
