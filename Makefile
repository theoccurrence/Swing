ifndef SDK_VERSION
SDK_VERSION = 26.5
endif

# Minimum iOS version the package and its subprojects are built for.
MIN_IOS_VERSION ?= 15.0

# Xcode 27 no longer accepts deployment targets below iOS 15, and Alderis'
# project file still declares 12.0, so hand our value to its xcodebuild run.
XCODEFLAGS ?= IPHONEOS_DEPLOYMENT_TARGET=$(MIN_IOS_VERSION)
export XCODEFLAGS

export TARGET = iphone:clang:$(SDK_VERSION):$(MIN_IOS_VERSION)
export SDK_PATH = $(THEOS)/sdks/iPhoneOS$(SDK_VERSION).sdk/
export SYSROOT = $(SDK_PATH)
export ARCHS = arm64

# ---------------------------------------------------------------------------
# The app this build targets
# ---------------------------------------------------------------------------
# Every app the pipeline can build lives in apps/<APP>/ and owns its tweak
# registry, its payload versions, its default selection and its build extras, so
# the app sets never bleed into each other:
#
#   APP=youtube     the YouTube set   (apps/youtube)
#   APP=instagram   the Instagram set (apps/instagram)
#
# Three files are the whole interface an app provides; nothing else in this
# Makefile knows a concrete app:
#
#   apps/<APP>/registry.mk  the tweak registry, APP_NAME/APP_BUNDLE_ID, extras
#   apps/<APP>/payloads.mk  optional: prebuilt .deb payloads (YTPlus, Gonerino)
#   apps/<APP>/custom.mk    optional: tweaks added through the app, appended
APP ?= youtube
APP_DIR = apps/$(APP)

ifeq ($(wildcard $(APP_DIR)/registry.mk),)
$(error Unknown app '$(APP)': $(APP_DIR)/registry.mk is missing. Known apps: $(notdir $(wildcard apps/*)))
endif
include $(APP_DIR)/registry.mk
-include $(APP_DIR)/payloads.mk
-include $(APP_DIR)/custom.mk

APP_NAME ?= $(APP)
APP_BUNDLE_ID ?= $(APP)
APP_PROCESS_NAME ?= $(APP_NAME)

# The root target has no sources of its own: it exists only to carry the
# injection, because theos-jailed injects everything listed in
# $(TWEAK_NAME)_INJECT_DYLIBS into the app. Its own dylib is therefore never
# injected - see the DYLIB export below.
TWEAK_NAME ?= AppBuilder
DISPLAY_NAME ?= $(APP_NAME)
BUNDLE_ID ?= $(APP_BUNDLE_ID)

ifndef APP_VERSION
APP_VERSION = 1.0
endif
PACKAGE_NAME = $(TWEAK_NAME)
PACKAGE_VERSION = $(APP)-$(APP_VERSION)

# ---------------------------------------------------------------------------
# Tweak selection
# ---------------------------------------------------------------------------
# APP_TWEAK_REGISTRY (from registry.mk, extended by custom.mk) is the app's tweak
# list, APP_PAYLOAD_TWEAKS the prebuilt payloads. ENABLED_TWEAKS selects which of
# them are compiled and injected:
#
#   make package ENABLED_TWEAKS="YTPlus YouSlider"
TWEAK_REGISTRY = $(APP_TWEAK_REGISTRY)
PAYLOAD_TWEAKS = $(APP_PAYLOAD_TWEAKS)
# SWITCH_TWEAKS are selectable like any other tweak but compile and inject
# nothing themselves: they are switches the build acts on. YouTube's
# OpenInYouTube, for example, is what makes the build inject the Open in YouTube
# Safari extension - deselecting it leaves the extension out. Because they carry
# no <id>_SUBPROJECT/<id>_DYLIB they must be kept out of the subproject and dylib
# lists, and they have to be in the validation list so ENABLED_TWEAKS accepts
# them.
SWITCH_TWEAKS = $(APP_SWITCH_TWEAKS)
DEFAULT_TWEAKS = $(APP_DEFAULT_TWEAKS)
SUPPORT_SUBMODULES = $(APP_SUPPORT_SUBMODULES)
ENABLED_TWEAKS ?= $(DEFAULT_TWEAKS)

COMPILED_TWEAKS = $(filter-out $(PAYLOAD_TWEAKS) $(SWITCH_TWEAKS),$(ENABLED_TWEAKS))
UNKNOWN_TWEAKS = $(filter-out $(TWEAK_REGISTRY) $(PAYLOAD_TWEAKS) $(SWITCH_TWEAKS),$(ENABLED_TWEAKS))
ifneq ($(UNKNOWN_TWEAKS),)
$(error Unknown tweak(s) in ENABLED_TWEAKS: $(UNKNOWN_TWEAKS). Valid ids: $(TWEAK_REGISTRY) $(PAYLOAD_TWEAKS) $(SWITCH_TWEAKS))
endif

ENABLED_TWEAK_SUBPROJECTS = $(foreach t,$(COMPILED_TWEAKS),$($(t)_SUBPROJECT))
ENABLED_TWEAK_DYLIBS = $(foreach t,$(COMPILED_TWEAKS),$(THEOS_OBJ_DIR)/$($(t)_DYLIB).dylib)

export ADDITIONAL_CFLAGS = $(APP_ADDITIONAL_CFLAGS)

ifneq ($(JAILBROKEN),1)
export DEBUGFLAG = -ggdb -Wno-unused-command-line-argument -L$(THEOS_OBJ_DIR) -F$(_THEOS_LOCAL_DATA_DIR)/$(THEOS_OBJ_DIR_NAME)/install/Library/Frameworks
MODULES = jailed
endif

# ---------------------------------------------------------------------------
# Prebuilt payloads (.deb)
# ---------------------------------------------------------------------------
# A payload tweak ships as a prebuilt .deb that the build downloads, unpacks and
# injects. apps/<APP>/payloads.mk declares one block per payload:
#
#   <id>_VERSION      pinned version (bumped by update-tweaks.yml)
#   <id>_URL          download URL, may interpolate $(<id>_VERSION)
#   <id>_DYLIB_REL    dylib path inside the unpacked .deb
#   <id>_BUNDLE_REL   bundle path inside the unpacked .deb (may contain spaces)
#   <id>_BUNDLE_NAME  path the bundle is staged under, without spaces -
#                     theos-jailed word-splits EMBED_BUNDLES, so a backslash-
#                     escaped "Application Support" would not survive.
PAYLOAD_DIR = Tweaks/payloads
ENABLED_PAYLOADS = $(filter $(PAYLOAD_TWEAKS),$(ENABLED_TWEAKS))
PAYLOAD_DYLIBS = $(foreach p,$(ENABLED_PAYLOADS),$(PAYLOAD_DIR)/$(p)/$($(p)_DYLIB_REL))
PAYLOAD_BUNDLES = $(foreach p,$(ENABLED_PAYLOADS),$(PAYLOAD_DIR)/$(p)/$($(p)_BUNDLE_NAME))

# YouSlider's settings UI links Alderis (EXTRA_FRAMEWORKS) and libcolorpicker
# (LIBRARIES); both have to be in the app bundle. A tweak set that needs extra
# libraries/frameworks/extensions names them in its registry.mk.
$(TWEAK_NAME)_INJECT_DYLIBS = $(ENABLED_TWEAK_DYLIBS) $(PAYLOAD_DYLIBS)
$(TWEAK_NAME)_EMBED_LIBRARIES = $(APP_EMBED_LIBRARIES)
$(TWEAK_NAME)_EMBED_FRAMEWORKS = $(APP_EMBED_FRAMEWORKS)
$(TWEAK_NAME)_EMBED_BUNDLES = $(wildcard Bundles/*.bundle) $(APP_EMBED_BUNDLES) $(PAYLOAD_BUNDLES)
# An app can gate its build extras on a switch tweak: when it names one in
# APP_EMBED_EXTENSIONS_SWITCH the extensions are only embedded while that id is
# enabled. An app without such a switch keeps them unconditional.
ifeq ($(APP_EMBED_EXTENSIONS_SWITCH),)
APP_EXTENSIONS_SELECTED = 1
else
APP_EXTENSIONS_SELECTED = $(filter $(APP_EMBED_EXTENSIONS_SWITCH),$(ENABLED_TWEAKS))
endif
$(TWEAK_NAME)_EMBED_EXTENSIONS = $(if $(APP_EXTENSIONS_SELECTED),$(APP_EMBED_EXTENSIONS),)

INSTALL_TARGET_PROCESSES = $(APP_PROCESS_NAME)
REMOVE_EXTENSIONS = 1
CODESIGN_IPA = 0
FINALPACKAGE = 1

# Drops the root dylib from theos-jailed's inject list. Upstream builds that list
# as inject_files=("$DYLIB" $INJECT_DYLIBS), so an empty value would become an
# empty argument - and rsync before 3.2.3 reads an empty source arg as "." and
# copies the whole build directory into the app (a ~700 MB IPA). The workflow
# unquotes the variable in the installed ipa.sh and fails the build if it cannot,
# so an empty DYLIB contributes no entry at all.
export DYLIB :=

# Name the packed IPA after the payload it mostly carries. IPA_PREFIX is a build
# input so the workflow (and the app driving it) can rename the file.
IPA_PREFIX ?= App
export OUTPUT_NAME := $(IPA_PREFIX)_$(PACKAGE_VERSION).ipa

include $(THEOS)/makefiles/common.mk

ifneq ($(JAILBROKEN),1)
SUBPROJECTS += $(APP_EXTRA_SUBPROJECTS) $(ENABLED_TWEAK_SUBPROJECTS)
include $(THEOS_MAKE_PATH)/aggregate.mk
endif

include $(THEOS_MAKE_PATH)/tweak.mk

.PHONY: internal-clean before-all
internal-clean::
	@rm -rf $(PAYLOAD_DIR)

# Prints the resolved tweak selection, one per line: the input after the app's
# defaults were applied. The build workflow reads it to know which switch tweaks
# are on without repeating the Makefile's default logic.
.PHONY: print-enabled-tweaks
print-enabled-tweaks:
	@printf '%s\n' $(ENABLED_TWEAKS)

# Prints the dylibs theos-jailed injects, one per line - the authoritative list
# of what has to fit into the binary's load-command area. Tools/check-inject-budget.py
# reads it instead of rebuilding the selection from the registry, so the check
# needs no tweak names of its own: a tweak added through apps/<APP>/custom.mk is
# covered as soon as the Makefile knows it.
.PHONY: print-inject-dylibs
print-inject-dylibs:
	@printf '%s\n' $(sort $(notdir $($(TWEAK_NAME)_INJECT_DYLIBS)))

# Some tweaks predate the SDK this pipeline builds with, and one of them cannot
# compile against it at all (sparkle-ig redeclares a class UIKit only ships from
# iOS 26 on). Tools/patch-sparkle-ig.py adjusts that - and only that - before the
# subprojects are compiled, and reverts it afterwards so a local build does not
# leave the submodule dirty. The script is idempotent and fails loudly when
# upstream moves the code it rewrites.
ifneq ($(filter sparkle-ig,$(ENABLED_TWEAKS)),)
before-all::
	@python3 Tools/patch-sparkle-ig.py
after-all::
	@python3 Tools/patch-sparkle-ig.py --revert
endif

# Downloads and unpacks every enabled payload through one generic helper, so the
# Makefile knows no payload by name. Tools/prepare-payload.sh fails loudly if the
# .deb does not contain the dylib and bundle the app's payloads.mk names.
ifneq ($(JAILBROKEN),1)
ifneq ($(ENABLED_PAYLOADS),)
before-all::
	@$(foreach p,$(ENABLED_PAYLOADS),$(PRINT_FORMAT_BLUE) "Preparing payload $(p)"; \
		Tools/prepare-payload.sh "$(p)" "$($(p)_URL)" "$($(p)_DYLIB_REL)" "$($(p)_BUNDLE_REL)" "$($(p)_BUNDLE_NAME)" "$(PAYLOAD_DIR)/$(p)" || exit 1;)
endif
endif
