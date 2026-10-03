# Pando.app

The Mac app that carries Pando's FSKit file system extension. With it, a
Pando worktree mounts as an ordinary folder: the whole tree is listed at
once, and a file's bytes are fetched the first time something opens it. No
macFUSE, no kernel extension, no restart.

Derived from Oak's open-source FSKit extension (Apache 2.0); see `NOTICE`.

## What is here

| Path | What it is |
| --- | --- |
| `project.yml` | XcodeGen spec for the app, the extension and the broker |
| `HostApp/` | Pando.app: carries the extension and explains the one switch |
| `Extension/` | the FSKit extension (sandboxed); forwards each file operation to the daemon |
| `Icon/` | the app icon and window lockup, rendered from the Pando mark |

## Build, unsigned

Needs macOS 26, Xcode 26 and `xcodegen` (`brew install xcodegen`).

```bash
cd mac
xcodegen generate
xcodebuild -project Pando.xcodeproj -scheme Pando -configuration Release \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
# a Release build registers the product with LaunchServices; undo that:
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -u "$PWD/build/Build/Products/Release/Pando.app"
```

An unsigned build compiles everything but cannot load: the extension's
entitlement only takes effect from a provisioning profile.

## Icon

`node Icon/render.mjs` renders `HostApp/Assets.xcassets` (the app icon at
16 to 1024 px and the window lockup) from `Icon/*.html` with headless
Chrome. The mark is the brand's `01-one-organism/mark.svg` (contour, 64 px
and up) and `mark-small.svg` (solid, 16 and 32 px), in the Night palette.
