# Spike: an FSKit mount for Pando, built from Oak's OakFS

Question: can Pando ship a macOS lazy mount the way Oak does, with an FSKit
app extension instead of macFUSE? This spike builds Oak's open-source mount
app and extension (Apache 2.0, see `NOTICE`) under Pando identifiers on the
owner's Mac, to find where the path stops.

Machine: macOS 26.3 (25D2125), Xcode 26.6 (17F113), macOS SDK 26.5,
xcodegen 2.46.0 (installed with Homebrew for this spike).

## What was run

```bash
cd OakFS
xcodegen generate
# 1. compile only, no signing
xcodebuild -project OakFS.xcodeproj -scheme OakMounter -configuration Release \
  -derivedDataPath build-unsigned CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
# 2. the real signing setup (manual, Developer ID Application, named profiles)
xcodebuild -project OakFS.xcodeproj -scheme OakMounter -configuration Release \
  -derivedDataPath build-signed build
```

Logs: `logs/build-unsigned.log`, `logs/build-signed-manual.log`.

## Results

1. **Compile: BUILD SUCCEEDED.** `Pando Mount.app` (universal, x86_64 and
   arm64) with `Contents/Extensions/OakFSExtension.appex`. The extension's
   Info.plist carries `EXExtensionPointIdentifier = com.apple.fskit.fsmodule`,
   `FSShortName = PandoFS`, `FSSupportsPathURLs = true`,
   `FSSupportsBlockResources = false`, minimum macOS 26.0. The Release build
   ran `lsregister` on the product; the spike unregistered it again
   (`lsregister -u`). The extension never appeared in `pluginkit`.
2. **Sign: FAILED, as expected, before any key was used.** With manual
   signing and the owner's "Developer ID Application" identity, xcodebuild
   stops with: `No profile for team '<team>' matching 'Mount Profile' found`
   and the same for `'OakFSExtension'`. The extension's entitlements include
   `com.apple.developer.fskit.fsmodule`, which must come from a provisioning
   profile; there are no provisioning profiles on this Mac.

## What a signed, loadable build needs (the owner's steps)

In the owner's Apple Developer account (Certificates, Identifiers &
Profiles); the "Developer ID Application" certificate already exists in this
Mac's keychain:

1. Register two explicit App IDs: `dev.pando.mount` (the host app) and
   `dev.pando.mount.Extension` (the extension), and enable the **FSKit
   Module** capability on the extension's App ID.
2. Create two **Developer ID** provisioning profiles from the Developer ID
   Application certificate, one per App ID, named `Mount Profile` and
   `OakFSExtension` (the names `project.yml` expects), download and
   double-click them.
3. Rebuild with step 2 above. Then notarize the zipped app with
   `xcrun notarytool submit --wait` (an App Store Connect API key or an
   app-specific password) and `xcrun stapler staple`, so it opens on any Mac.
4. First run on a Mac: copy `Pando Mount.app` to `/Applications`, open it
   once, then System Settings, General, Login Items & Extensions, File System
   Extensions, and turn **PandoFS** on. No reboot. Mount points outside
   `~/Documents`, `~/Desktop`, `~/Downloads` and iCloud Drive avoid a Full
   Disk Access prompt.

This spike stops before all of that: nothing was installed into
`/Applications`, nothing in System Settings was touched, and no account
change was made.

## What is still missing for a working mount

The extension is a thin forwarder. It needs a daemon on the other end of
`dev.pando.mount` (an XPC mach service, then a unix socket) that answers the
OakFS wire operations (`hello`, `lookup`, `getattr`, `readdir`, `read`,
`readlink`, `write`, `create`, `mkdir`, `unlink`, `rmdir`, `rename`,
`truncate`; see `OakFS/Extension/Wire.swift`). The proposal pairs it with a
fork of ArtifactFS's engine (its `Resolver` and `Engine` already expose the
same path operations over a blobless Artifacts clone plus an overlay).
