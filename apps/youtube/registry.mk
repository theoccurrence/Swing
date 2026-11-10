# Tweak registry of the YouTube app set.
#
# The Makefile pulls this in for `APP=youtube`, so the tweak list is edited here
# and nowhere else. Every id in APP_TWEAK_REGISTRY needs a <id>_SUBPROJECT and a
# <id>_DYLIB below (payload tweaks live in payloads.mk instead).

APP_NAME = YouTube
APP_BUNDLE_ID = com.google.ios.youtube
APP_PROCESS_NAME = YouTube

# Pre-selected set; also the default of the build workflow's enabled_tweaks input.
APP_DEFAULT_TWEAKS = YTPlus YTweaks YTABConfig YTClassicVideoQuality \
	Return-YouTube-Dislikes YTVideoOverlay YouQuality YouSlider YouTubeLegacy \
	YouGroupSettings FLEXing

# Tweaks compiled from a submodule (<id>_SUBPROJECT, <id>_DYLIB).
APP_TWEAK_REGISTRY = DontEatMyContent FLEXing Return-YouTube-Dislikes YTABConfig \
	YouGroupSettings YTIcons YouLoop YouMute YouPiP YouQuality YouSlider \
	YouSpeed YouTimeStamp YTHoldForSpeed YTVideoOverlay YTweaks YouTubeLegacy \
	iSponsorBlock YTUHD YTAmbientLight YTClassicVideoQuality IAmYouTube \
	NoYTPremium

# <id>_SUBPROJECT is the Theos subproject directory, <id>_DYLIB is the dylib it
# produces and that gets injected into the app.
DontEatMyContent_SUBPROJECT = Tweaks/DontEatMyContent
DontEatMyContent_DYLIB = DontEatMyContent
FLEXing_SUBPROJECT = Tweaks/FLEXing/libflex
FLEXing_DYLIB = libFLEX
Return-YouTube-Dislikes_SUBPROJECT = Tweaks/Return-YouTube-Dislikes
Return-YouTube-Dislikes_DYLIB = YouTubeDislikesReturn
YTABConfig_SUBPROJECT = Tweaks/YTABConfig
YTABConfig_DYLIB = YTABConfig
YouGroupSettings_SUBPROJECT = Tweaks/YouGroupSettings
YouGroupSettings_DYLIB = YouGroupSettings
YTIcons_SUBPROJECT = Tweaks/YTIcons
YTIcons_DYLIB = YTIcons
YouLoop_SUBPROJECT = Tweaks/YouLoop
YouLoop_DYLIB = YouLoop
YouMute_SUBPROJECT = Tweaks/YouMute
YouMute_DYLIB = YouMute
YouPiP_SUBPROJECT = Tweaks/YouPiP
YouPiP_DYLIB = YouPiP
YouQuality_SUBPROJECT = Tweaks/YouQuality
YouQuality_DYLIB = YouQuality
YouSlider_SUBPROJECT = Tweaks/YouSlider
YouSlider_DYLIB = YouSlider
YouSpeed_SUBPROJECT = Tweaks/YouSpeed
YouSpeed_DYLIB = YouSpeed
YouTimeStamp_SUBPROJECT = Tweaks/YouTimeStamp
YouTimeStamp_DYLIB = YouTimeStamp
YTHoldForSpeed_SUBPROJECT = Tweaks/YTHoldForSpeed
YTHoldForSpeed_DYLIB = YTHoldForSpeed
YTVideoOverlay_SUBPROJECT = Tweaks/YTVideoOverlay
YTVideoOverlay_DYLIB = YTVideoOverlay
YTweaks_SUBPROJECT = Tweaks/YTweaks
YTweaks_DYLIB = YTweaks
YouTubeLegacy_SUBPROJECT = Tweaks/YouTubeLegacy
YouTubeLegacy_DYLIB = YouTubeLegacy
iSponsorBlock_SUBPROJECT = Tweaks/iSponsorBlock
iSponsorBlock_DYLIB = iSponsorBlock
YTUHD_SUBPROJECT = Tweaks/YTUHD
YTUHD_DYLIB = YTUHD
YTAmbientLight_SUBPROJECT = Tweaks/YTAmbientLight
YTAmbientLight_DYLIB = YTAmbientLight
YTClassicVideoQuality_SUBPROJECT = Tweaks/YTClassicVideoQuality
YTClassicVideoQuality_DYLIB = YTClassicVideoQuality
IAmYouTube_SUBPROJECT = Tweaks/IAmYouTube
IAmYouTube_DYLIB = IAmYouTube
NoYTPremium_SUBPROJECT = Tweaks/NoYTPremium
NoYTPremium_DYLIB = NoYTPremium

# Build dependencies of the tweaks: header sets and link libraries the submodules
# include from Tweaks/. They are not selectable tweaks, but a tweak that moves
# upstream usually has to move them with it - YouSlider 1.4.1 only compiles
# against the newer YouTubeHeader. Alderis and protobuf are deliberately absent:
# the build patches Alderis' xcodebuild flags and protobuf is pinned to the
# snapshot iSponsorBlock expects.
APP_SUPPORT_SUBMODULES = Tweaks/YouTubeHeader Tweaks/PSHeader Tweaks/libundirect Tweaks/RemoteLog

# RemoteLog supplies the logging macros the YouTube tweaks include.
APP_ADDITIONAL_CFLAGS = -I$(THEOS_PROJECT_DIR)/Tweaks/RemoteLog -I$(THEOS_PROJECT_DIR)/Tweaks -Wno-error=\#warnings

# Alderis is a subproject in its own right (YouSlider links its framework), and
# the Open in YouTube Safari extension and share extension ship as .appex bundles.
APP_EXTRA_SUBPROJECTS = Tweaks/Alderis
APP_EMBED_LIBRARIES = $(THEOS_OBJ_DIR)/libcolorpicker.dylib
APP_EMBED_FRAMEWORKS = $(_THEOS_LOCAL_DATA_DIR)/$(THEOS_OBJ_DIR_NAME)/install_Alderis.xcarchive/Products/var/jb/Library/Frameworks/Alderis.framework
APP_EMBED_EXTENSIONS = $(wildcard Extensions/*.appex)

export libcolorpicker_ARCHS = arm64
export libFLEX_ARCHS = arm64
export Alderis_XCODEOPTS = LD_DYLIB_INSTALL_NAME=@rpath/Alderis.framework/Alderis
export Alderis_XCODEFLAGS = DYLIB_INSTALL_NAME_BASE=/Library/Frameworks BUILD_LIBRARY_FOR_DISTRIBUTION=YES ARCHS="$(ARCHS)"
export libcolorpicker_LDFLAGS = -F$(TARGET_PRIVATE_FRAMEWORK_PATH) -install_name @rpath/libcolorpicker.dylib
