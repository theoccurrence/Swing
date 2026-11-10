# Tweaks added by hand through the app (.github/workflows/add-tweak.yml).
#
# One file per app, so a tweak added for Instagram never shows up in the YouTube
# picker. The workflow only ever appends to this file - one block per tweak:
#
#   APP_TWEAK_REGISTRY += <id>
#   CUSTOM_TWEAKS += <id>
#   <id>_SUBPROJECT = Tweaks/<id>
#   <id>_DYLIB = <dylib>
#
# The Makefile includes it before APP_TWEAK_REGISTRY is validated, so a tweak
# listed here behaves exactly like one wired up by hand.
