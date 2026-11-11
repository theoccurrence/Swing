#!/usr/bin/env python3
"""Make sparkle-ig compile against an SDK that already ships the classes it hooks.

sparkle-ig's sources declare the iOS 26 UIKit classes it hooks itself, because the
SDK its own Makefile targets upstream (iPhoneOS16.2) has no such headers:

    src/Features/Interface/LiquidGlass.xm   @interface UIScrollEdgeEffect : NSObject
    src/Features/Interface/OLEDDarkMode.x   @interface UIGlassEffect : UIVisualEffect

This pipeline builds every tweak against the iOS 27 SDK - it needs it for the app
binary - where UIKit declares both, so the tweak's own declarations become

    error: duplicate interface definition for class 'UIScrollEdgeEffect'
    error: duplicate interface definition for class 'UIGlassEffect'
    error: property has a previous declaration

Every other class the tweak declares is private (UIPlaceholderColor, Instagram's
own classes, FLEX), so those are untouched - which is also what a scan of the 8679
SDK headers against all of the tweak's declarations says: these two are the only
clashes.

What the patch does is deliberately small, and differs per class:

  * UIScrollEdgeEffect becomes a category. The tweak adds methods to it and its
    %hook needs their declarations (UIKit has no +hide), and a category keeps
    those declarations on either SDK.
  * UIGlassEffect loses its declaration. UIKit declares the class *and* the same
    tintColor property it needs (only nullable, so redeclaring would clash again),
    so there is nothing left to declare.

There is a third, unrelated blocker: the tweak links Preferences.framework
(`$(TWEAK_NAME)_PRIVATE_FRAMEWORKS = Preferences`), which no SDK that is still
available ships - not even Xcode 27.2's iPhoneOS SDK. `-undefined dynamic_lookup`
leaves those symbols to load time, where Instagram has them.

Nothing else changes: the method declarations the hooks need stay identical, and
they are still installed only behind runtime `objc_getClass(...)` checks, so a
system without these classes never touches them.

The edits are idempotent, and the script refuses to guess: if upstream rewords a
declaration it fails loudly instead of silently patching something else. The
Makefile runs it from `before-all` (which precedes the subproject builds) and
reverts it from `after-all`, so a local build does not leave the submodule dirty.

Usage:
    Tools/patch-sparkle-ig.py             # apply
    Tools/patch-sparkle-ig.py --revert    # undo
    Tools/patch-sparkle-ig.py --check     # only report
"""

import argparse
import sys
from pathlib import Path

TWEAK = Path(__file__).resolve().parents[1] / "Tweaks/sparkle-ig"

PATCHES = [
    {
        "file": "src/Features/Interface/LiquidGlass.xm",
        "why": "UIKit ships UIScrollEdgeEffect from iOS 26 on",
        "original": """// MARK: - UIScrollEdgeEffect declaration
@interface UIScrollEdgeEffect : NSObject
+ (void)hide;
- (BOOL)ig_isHidden;
- (void)ig_setIsHidden:(BOOL)hidden;
@end
""",
        "patched": """// MARK: - UIScrollEdgeEffect declaration
// UIKit ships the class from iOS 26 on, so a plain interface is a duplicate as
// soon as the build SDK knows it - this pipeline builds against the iOS 27 SDK.
// A category keeps the method declarations the %hook below needs; UIKit has no
// +hide, and the hooks are installed only behind a runtime objc_getClass check.
// Patched by Tools/patch-sparkle-ig.py.
@interface UIScrollEdgeEffect (SparkleHooks)
+ (void)hide;
- (BOOL)ig_isHidden;
- (void)ig_setIsHidden:(BOOL)hidden;
@end
""",
    },
    {
        "file": "Makefile",
        "why": "no SDK that is still available ships Preferences.framework",
        "original": "$(TWEAK_NAME)_PRIVATE_FRAMEWORKS = Preferences\n",
        "patched": """# Patched by Tools/patch-sparkle-ig.py: no SDK this pipeline can use ships
# Preferences.framework any more - not even Xcode 27.2's iPhoneOS SDK. Sparkle's
# settings UI subclasses PSListController, which Instagram has at runtime, so the
# symbols are resolved when the tweak loads instead of failing the link.
$(TWEAK_NAME)_LDFLAGS += -Wl,-undefined,dynamic_lookup
""",
    },
    {
        "file": "src/Features/Interface/OLEDDarkMode.x",
        "why": "UIKit ships UIGlassEffect and its tintColor property from iOS 26 on",
        "original": """// iOS 26 Liquid Glass. Not in the SDK this builds against; the hook only needs
// the class name and the tint setter.
@interface UIGlassEffect : UIVisualEffect
@property (nonatomic, copy) UIColor *tintColor;
@end
""",
        "patched": """// iOS 26 Liquid Glass. Not in the SDK the tweak targets upstream, but this
// pipeline builds against the iOS 27 SDK, where UIGlassEffect.h declares the
// class and the same tintColor property - so there is nothing left to declare
// here. The hook below only needs the class name and the tint setter, and it is
// installed only behind a runtime NSClassFromString check.
// Patched by Tools/patch-sparkle-ig.py.
""",
    },
]


def die(message):
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def state(entry):
    text = (TWEAK / entry["file"]).read_text(errors="replace")
    if text.count(entry["patched"]):
        return "patched", text, entry["patched"], entry["original"]
    if text.count(entry["original"]):
        return "original", text, entry["original"], entry["patched"]
    return "unknown", text, None, None


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--revert", action="store_true", help="remove the patches again")
    parser.add_argument("--check", action="store_true", help="only report the current state")
    args = parser.parse_args()

    if not (TWEAK / "src").is_dir():
        die(f"{TWEAK}/src does not exist - is the sparkle-ig submodule checked out?")

    unknown = []
    for entry in PATCHES:
        path = TWEAK / entry["file"]
        if not path.is_file():
            die(f"{path} does not exist")
        current, text, have, want = state(entry)
        if current == "unknown":
            unknown.append(entry)
            continue
        if args.check:
            print(f"  {current:8} {entry['file']}")
            continue
        if args.revert:
            if current == "original":
                print(f"  nothing to revert in {entry['file']}")
                continue
            path.write_text(text.replace(have, want, 1))
            print(f"  reverted {entry['file']}")
        else:
            if current == "patched":
                print(f"  already patched {entry['file']}")
                continue
            path.write_text(text.replace(have, want, 1))
            print(f"  patched {entry['file']} ({entry['why']})")

    if unknown:
        names = ", ".join(e["file"] for e in unknown)
        die(f"these files no longer contain the declaration this patch rewrites: {names}. "
            f"Upstream changed them, so the patch has to be re-checked")


if __name__ == "__main__":
    main()
