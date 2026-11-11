# AppBuilder

Build pipeline that injects a **selectable set of tweaks** into a decrypted iOS
app IPA and produces a SideStore/AltStore-compatible `.ipa`. It is app-agnostic:
the YouTube and Instagram sets in `apps/` are just two entries, and adding a third
app means adding a directory.

This repository ships no tweak sources of its own. It orchestrates third-party
tweaks — compiled from git submodules or downloaded as prebuilt packages — and
injects them into an app IPA with [Theos](https://theos.dev) and
[theos-jailed](https://github.com/qnblackcat/theos-jailed).

## The multi-app model

Every app the pipeline can build lives in `apps/<app>/` and owns everything
specific to that app, so the app sets never bleed into each other:

| Path | Role |
|---|---|
| `apps/<app>/app.json` | Manifest. Records what the app actually is — `id`, `name`, `bundleIds`, `version`, `executable`, `icon`, the `source` `sha256:<hex>` of the inspected IPA URL and `inspectedAt`. Written by the Inspect IPA workflow; the hand-owned `process` and `build` keys (`build.alternateIcons`, `build.safariExtensions`) say how to build it. |
| `apps/<app>/registry.mk` | The tweak registry: `APP_NAME`, `APP_BUNDLE_ID`, `APP_PROCESS_NAME`, `APP_DEFAULT_TWEAKS`, `APP_TWEAK_REGISTRY`, `APP_SWITCH_TWEAKS`, one `<id>_SUBPROJECT` + `<id>_DYLIB` per compiled tweak, `APP_SUPPORT_SUBMODULES`, `APP_ADDITIONAL_CFLAGS`, `APP_EXTRA_SUBPROJECTS`, `APP_EMBED_LIBRARIES`, `APP_EMBED_FRAMEWORKS`, `APP_EMBED_EXTENSIONS`, `APP_EMBED_EXTENSIONS_SWITCH`. |
| `apps/<app>/payloads.mk` | Optional. `APP_PAYLOAD_TWEAKS` plus a mixed-case block per prebuilt payload: `<id>_VERSION`, `<id>_URL`, `<id>_DYLIB_REL`, `<id>_BUNDLE_REL`, `<id>_BUNDLE_NAME` (e.g. `YTPlus_VERSION`, `Gonerino_URL`). |
| `apps/<app>/custom.mk` | Optional. Appended by the Add tweak workflow: `APP_TWEAK_REGISTRY += <id>`, `CUSTOM_TWEAKS += <id>`, `<id>_SUBPROJECT`, `<id>_DYLIB`. |
| `apps/<app>/tweaks.json` | Picker grouping: `{"groups":[{"name":"Essentials","tweaks":["..."]}, ...]}`. Tweaks listed nowhere land in an **Other** group; ids in `CUSTOM_TWEAKS` go into a **Custom** group that only appears once one exists. |
| `apps/<app>/icons/` | Optional alternate app-icon PNGs (only for apps whose manifest sets `build.alternateIcons`). |

`Makefile` takes the app set to build through `APP=<app>`, reads only these files
for that app, and errors on an unknown app. Two sets ship today: `apps/youtube`
(~25 tweaks plus the YTPlus and Gonerino payloads) and `apps/instagram` (one
tweak, `sparkle-ig`).

## How a build works

1. The **Inspect IPA** workflow (`inspect-ipa.yml`) runs first and is what makes a
   build possible at all: it downloads the decrypted IPA into the runner's temp
   directory — never into the checkout — reads `Payload/*.app/Info.plist` and the
   app icon, and merges the name, bundle id, version and icon into
   `apps/<id>/app.json` / `apps/<id>/icon.png`. It commits only that metadata,
   drops the IPA again, and fails rather than commit anything IPA-shaped.
2. **Build and Release AppBuilder** (`buildapp.yml`) downloads the decrypted IPA
   given as `decrypted_ipa_url`, but only after verifying that
   `apps/<app_id>/app.json` records the SHA-256 of that URL. The URL itself is
   masked and never stored — only its hash is — so a build is only possible for
   an IPA that went through inspection for that app set.
3. `Tools/check-inject-budget.py` verifies that the selected tweaks fit into the
   binary's load-command area. It measures the dylibs `make print-inject-dylibs`
   prints, so the check keeps no tweak registry of its own and covers tweaks added
   through the app. Without that check `insert_dylib` stalls for hours instead of
   failing.
4. Theos builds the submodule tweaks and theos-jailed injects every selected dylib
   — plus its settings bundle, embedded libraries and frameworks — into the app.
5. `cyan` injects the Safari extensions the manifest declares (`build.safariExtensions`),
   the IPA is stripped of unresignable extensions and `SC_Info`, alternate app
   icons are registered (if `build.alternateIcons` and `apps/<app>/icons` exist),
   and the result is uploaded as artifact and/or draft release.

## Build inputs

`buildapp.yml` knows no concrete app — the display name, bundle id, alternate
icons and Safari extensions all come from `apps/<app_id>/`.

| Input | Default | Meaning |
|---|---|---|
| `app_id` | `youtube` | App set to build (a directory under `apps/`). |
| `decrypted_ipa_url` | – | Direct URL of the decrypted IPA; must hash to the `source` recorded in `apps/<app_id>/app.json`. |
| `app_name` | `apps/<app_id>/app.json` | Display name of the produced app. |
| `bundle_id` | `apps/<app_id>/app.json` | Bundle ID of the produced app. |
| `ipa_prefix` | `App` | Prefix of the produced IPA file name. |
| `sdk_version` | `27.2` | iOS SDK used for the Theos build (27.x needs the `xcode-27` image). |
| `commit_id` | – | Optional commit to build at. |
| `upload_artifact` | `false` | Upload the IPA as a workflow artifact. |
| `create_release` | `true` | Create a draft release with the IPA. |
| `enabled_tweaks` | app default | Tweaks to inject; empty means `APP_DEFAULT_TWEAKS`, the literal `none` means none. |

## Tweak selection

`apps/<app>/registry.mk` is the single source of truth for that app's tweak
registry. The GitHub workflow, the local web UI in `web/` and the AppBuilder iOS
app all read it from there, so adding a tweak to an app means editing that
registry only. The Makefile maps the app files onto its own vocabulary:

| Variable (in `registry.mk` / `payloads.mk`) | Meaning |
|---|---|
| `APP_TWEAK_REGISTRY` | Tweaks compiled from a submodule (`<id>_SUBPROJECT`, `<id>_DYLIB`). |
| `APP_PAYLOAD_TWEAKS` | Tweaks shipped as prebuilt `.deb` packages that the build downloads and unpacks. |
| `APP_SWITCH_TWEAKS` | Selectable ids that compile and inject nothing: they are switches the build acts on. |
| `APP_DEFAULT_TWEAKS` | Pre-selected set; also the default of the workflow's `enabled_tweaks` input. |
| `ENABLED_TWEAKS` | Space- or comma-separated ids to inject. Overrides `APP_DEFAULT_TWEAKS`. |

A switch tweak is a normal row in the picker that the build reads instead of
compiling it. YouTube's `OpenInYouTube` is the only one: it gates the Open in
YouTube Safari extension, both the `.appex` bundles the Makefile embeds
(`APP_EMBED_EXTENSIONS_SWITCH`) and the ones `buildapp.yml` clones and hands to
`cyan` (`build.safariExtensionSwitch` in `app.json`). It is on by default for
YouTube; deselecting it leaves the extensions out, and another app can never pick
them up because the switch is not one of its tweaks.

### Tweaks that need their own SDK

The pipeline builds every tweak against one SDK (`sdk_version`, 27.2 by default)
because the app binary needs it: the Makefile exports `TARGET`, `SYSROOT` and
`SDK_PATH` so that no subproject falls back to an SDK that is not installed.

A tweak written against an older SDK is the exception. `sparkle-ig` pins
`iPhoneOS16.2` in its own Makefile, declares the iOS 26 UIKit classes it hooks
itself and links `Preferences.framework`; against the newer SDK that is

```
src/Features/Interface/LiquidGlass.xm:170:1: error: duplicate interface definition for class 'UIScrollEdgeEffect'
src/Features/Interface/OLEDDarkMode.x:29:1: error: duplicate interface definition for class 'UIGlassEffect'
ld: framework 'Preferences' not found
```

so the app names the SDK the tweak wants:

```make
# apps/instagram/registry.mk
sparkle-ig_OWN_SDK = 16.2
```

Such a tweak stays out of the aggregate - the aggregate is exactly what forces one
SDK on every subproject - and `Tools/build-own-sdk-tweak.sh` builds it on its own
with those variables dropped, so the `TARGET` its own Makefile pins decides. Its
dylib is then injected the way a payload's is. **The tweak's sources are not
touched**, which is the whole point: `Preferences.framework` and the older UIKit
headers are exactly what its author builds against.

`Tools/install-own-sdk.sh <app>` installs the SDKs an app asks for. The build
workflow runs it before `make` and folds the versions into the SDK cache key, so an
app whose tweaks all share the pipeline's SDK - YouTube - keeps its existing cache
key and builds exactly as before. Locally:

```sh
THEOS=$HOME/theos Tools/install-own-sdk.sh instagram
```

A tweak's resource bundle still comes from `Bundles/<name>.bundle`, which points at
the submodule's own resources. What is *not* run is the tweak's packaging step, so
a bundle that step would post-process stays as its sources ship it - sparkle-ig
augments its bundle with FFmpeg that way, and building without that is the
configuration upstream's own `SPARKLE_NO_FFMPEG=1` selects.

Payload tweaks are listed first, because they carry most of the functionality:

```sh
make package APP=youtube IPA=Payload/YouTube.app ENABLED_TWEAKS="YTPlus Gonerino YouSlider"
```

## Local build

Requires Theos with an iPhoneOS SDK, `make`, `curl`, `unzip`, `ldid`, `dpkg` and a
decrypted IPA unpacked into `Payload/`.

```sh
export THEOS=$HOME/theos
make package THEOS_PACKAGE_SCHEME=rootless IPA=Payload/YouTube.app FINALPACKAGE=1 \
  APP=youtube SDK_VERSION=27.2 ENABLED_TWEAKS="YTPlus Gonerino"
```

`web/server.js` serves a small local front-end (plain node, no `npm install`) that
reads the workflow inputs from `buildapp.yml` and the manifests/registries from
`apps/<app>/`, can dispatch the GitHub workflows, and can emit an equivalent local
build script:

```sh
cd web && npm start   # http://localhost:8787
```

## Tweak updates

`Tools/check-tweak-updates.py` compares every tweak of every app set with its
upstream repository: the pinned commit and the `control` version for submodule
tweaks, the latest GitHub release for payload tweaks such as Gonerino, and nothing
for tweaks that live in this repository. No API token is needed — `control` comes
from `raw.githubusercontent.com` and the refs from `git ls-remote`.

```sh
python3 Tools/check-tweak-updates.py            # every app
python3 Tools/check-tweak-updates.py --app youtube
python3 Tools/check-tweak-updates.py --json     # for tooling
```

`update-tweaks.yml` (dispatchable from the web UI, and from the iOS app the same
way as the build workflow) turns that report into a commit, per app: submodule
tweaks move to the head of the branch `.gitmodules` names, payload versions are
bumped in the app's `payloads.mk`, the bumped tweaks are compiled, and only then is
the result pushed.

Tweaks that move upstream usually drag their build dependencies along, so
`APP_SUPPORT_SUBMODULES` in an app's `registry.mk` lists the shared header sets and
libraries (`Tweaks/YouTubeHeader`, `Tweaks/PSHeader`, `Tweaks/libundirect`,
`Tweaks/RemoteLog`) that travel with any tweak bump — YouSlider 1.4.1 only
compiles against the newer YouTubeHeader. Alderis and protobuf stay pinned by
hand, and `Alderis.framework` is built with patched xcodebuild flags.

| Input | Default | Meaning |
|---|---|---|
| `app` | every app | Only this app set. |
| `only` | – | Tweaks to update; empty means every outdated tweak. |
| `include_payload` | `true` | Also bump payload tweaks (YTPlus, Gonerino). |
| `include_support` | `true` | Move the shared header/library submodules too. |
| `verify` | `true` | Compile the bumped tweaks before pushing. |
| `push` | `true` | Push the result; off only reports what would change. |
| `sdk_version` | `27.2` | iOS SDK used for the verification compile. |

The web UI checks upstream versions when it loads, badges outdated tweaks with the
version they could move to, and offers the matching actions: *Update outdated
tweaks* dispatches the workflow, *Sync repository* pulls the result together with
the submodule commits (`git pull` + `git submodule update --init --recursive`) so
the next build uses the new versions. Syncing refuses to run on a dirty checkout.

## Custom tweaks

Tweaks can be added from a GitHub link instead of editing an app's registry by
hand. `add-tweak.yml` (dispatchable from the app's Tweaks page) checks out the
repository, adds the tweak as a submodule under `Tweaks/<id>`, appends its registry
entry and dylib to `apps/<app>/custom.mk` — the include the Makefile pulls in for
that app — and compiles it together with the app's default set. Only when that gate
passes is the result pushed, so a broken link, a missing header or a wrong dylib
name fails in the workflow instead of in a build.

| Input | Default | Meaning |
|---|---|---|
| `repo` | – | Repository URL of the tweak (github.com). |
| `app` | `youtube` | App set the tweak belongs to (a directory under `apps/`). |
| `id` | repository name | Tweak id and submodule folder. |
| `branch` | repository default | Branch pinned in `.gitmodules`. |
| `subproject` | repository root | Directory carrying the Makefile, e.g. `libflex`. |
| `dylib` | `TWEAK_NAME`/`LIBRARY_NAME` | Dylib to inject. |
| `verify` | `true` | Compile the tweak before pushing. |
| `push` | `true` | Commit and push the new tweak. |

`CUSTOM_TWEAKS` in each app's `custom.mk` records what was added this way;
`Tools/check-tweak-updates.py`, the web UI and the app all read it, so custom
tweaks are version-checked and updated like the curated ones, and the app's tweak
picker shows them in a **Custom** section that only appears once the first one
exists.

### Removing a custom tweak

`remove-tweak.yml` — dispatchable from the app by swiping a row in **Custom** —
does the reverse for one app: it deletes the `apps/<app>/custom.mk` block, the
`.gitmodules` section and the `Tweaks/<id>` gitlink, asserts that all three are
gone, and then pushes. Only ids listed in that app's `CUSTOM_TWEAKS` can be
removed; the curated tweaks are wired up by hand and should not disappear because
of a button. Nothing has to compile, since deleting an entry cannot break the
build — the next build is the gate.

| Input | Default | Meaning |
|---|---|---|
| `app` | `youtube` | App set the tweak belongs to. |
| `id` | – | Tweak id to remove, as listed in that app's `CUSTOM_TWEAKS`. |
| `push` | `true` | Commit and push the removal. |

## The iOS app

`AppBuilder` (a separate Xcode project) is a thin client for the workflows: it
dispatches the build with the inputs above, shows status and logs, and downloads
the resulting IPA into its library, from where it can be handed to SideStore. The
add, remove and update workflows are app-scoped, so the client passes the app set
along with the tweak selection.

## Credits

The tweaks under `Tweaks/` are third-party projects, each under its own license —
see the respective submodule. The build pipeline descends from
[uYouPlus](https://github.com/qnblackcat/uYouPlus) /
[uYouEnhanced](https://github.com/arichornlover/uYouEnhanced) by **qnblackcat** and
**arichornlover**; their credits are kept in `control`.

There is currently no `LICENSE` file in this repository.
