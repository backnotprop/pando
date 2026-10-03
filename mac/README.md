# Pando.app

The Mac app that carries Pando's FSKit file system extension. With it, a
Pando worktree mounts as an ordinary folder: the whole tree is listed at
once, and a file's bytes are fetched the first time something opens it. No
macFUSE, no kernel extension, no restart. Needs macOS 26 or later.

Derived from Oak's open-source FSKit extension (Apache 2.0); see `NOTICE`.

## What is here

| Path | What it is |
| --- | --- |
| `project.yml` | XcodeGen spec for the app, the extension and the broker |
| `HostApp/` | Pando.app: carries the extension and explains the one switch |
| `Extension/` | the FSKit extension (sandboxed): turns each file operation into a wire v3 request |
| `Broker/` | `pando-broker`: relays the extension's requests to the mount's daemon socket |
| `Tests/` | the wire harness: the extension's client and the broker against a fake daemon |
| `Icon/` | the app icon and window lockup, rendered from the Pando mark |

## How it fits

```
Finder, git, an agent
  |  file calls
macOS FSKit
  |
Pando extension (Contents/Extensions/PandoExtension.appex, sandboxed)
  |  XPC: { mount, frame }   mach service ai.plannotator.pando.broker
pando-broker (Contents/MacOS/pando-broker, started by launchd on demand)
  |  unix socket, one persistent connection per mount
the mount's daemon (ArtifactFS fork, internal/fskit)
```

The wire is version 3, owned by the fskit lane:
`docs/pando-fskit-wire-v3.md` in the ArtifactFS fork.

## Names

| Thing | Value |
| --- | --- |
| App | `Pando.app` (product "Pando") |
| Name in System Settings | **Pando** (the extension's `CFBundleDisplayName`) |
| FSKit short name | `pando` (`/sbin/mount -F -t pando -o nobrowse <state dir> <mount point>`) |
| Host app bundle id | `ai.plannotator.pando` |
| Extension bundle id | `ai.plannotator.pando.extension` |
| Broker bundle id and mach service | `ai.plannotator.pando.broker` |
| Mount state dir | `$HOME/.pando/fskit/<mount id>/` (socket `fskit.sock`, Finder name `volname`) |

All three ids derive from one setting, `PANDO_BUNDLE_PREFIX` in
`project.yml`. The owner has not confirmed the prefix yet; change it there
only, and the entitlement, the extension's `PandoBrokerMachService` key and
the broker follow. The LaunchAgent below must use the same name.

## Build, unsigned

Needs Xcode 26 and `xcodegen` (`brew install xcodegen`).

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

## Tests

```bash
mac/Tests/run.sh
```

Compiles `Extension/Wire.swift`, `Extension/WireClient.swift` and
`Broker/BrokerCore.swift` with a fake daemon and runs them in one process
over real XPC (an in-process listener) and a real unix socket: concurrency
and out-of-order replies, raw read and write payloads, errno pass-through,
readdir fields and the bad-cookie code, batched forget, the in-flight cap,
deadlines, bad and missing mounts, a daemon restart, and a socket path longer
than `sun_path`. No signing, launchd or FSKit needed. The FSKit side
(`PandoVolume.swift`) is first exercised in the signed run.

## The broker

`pando-broker` vends the mach service `ai.plannotator.pando.broker`. For
each XPC message `{ "mount": <id>, "frame": <frame> }` it checks the id
(`[A-Za-z0-9][A-Za-z0-9._-]{0,47}`), connects to
`$HOME/.pando/fskit/<id>/fskit.sock` (never a path from the extension),
checks the daemon runs as the same user, and forwards the frame. It keeps
one persistent connection per extension and mount, writes frames as they
come, and routes each reply by the `id` in its header, so many requests run
at once. When it cannot deliver, it answers with its own frame,
`{"id", "errno", "message"}`: 22 for a bad mount id, 5 for a missing or lost
daemon.

```bash
Pando.app/Contents/MacOS/pando-broker --ping      # exit 0 if launchd vends the service
Pando.app/Contents/MacOS/pando-broker --version
```

### The LaunchAgent (written by the `pando` command)

launchd starts the broker the first time the extension looks up its mach
service. The `pando` command writes this file to
`~/Library/LaunchAgents/ai.plannotator.pando.broker.plist`, with the real
path of the installed app in `ProgramArguments`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.plannotator.pando.broker</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/Pando.app/Contents/MacOS/pando-broker</string>
    </array>
    <key>MachServices</key>
    <dict>
        <key>ai.plannotator.pando.broker</key>
        <true/>
    </dict>
    <key>AssociatedBundleIdentifiers</key>
    <array>
        <string>ai.plannotator.pando</string>
    </array>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
```

- No `RunAtLoad` and no `KeepAlive`: launchd starts it on demand.
- `AssociatedBundleIdentifiers` shows it under Pando in Login Items.
- `ProcessType Interactive`: the broker is on the file I/O path, so it must
  not be throttled as a background job.

Loading it, as the person (never with `sudo`: root has no `gui/0` domain):

```bash
launchctl bootout gui/$(id -u)/ai.plannotator.pando.broker 2>/dev/null   # only if the file changed
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.plannotator.pando.broker.plist
/Applications/Pando.app/Contents/MacOS/pando-broker --ping
```

`bootstrap` fails with error 5 when the same agent
is up; that is fine. Rewrite and reload only when the app path changes.

## The extension's wire v3 client

`Extension/WireClient.swift` and `Extension/PandoVolume.swift` follow the
contract's section 7:

- No FSKit callback blocks. Each sends with
  `xpc_connection_send_message_with_reply` on a concurrent queue and
  returns; the reply handler calls FSKit's.
- Every request has an id; at most 64 are in flight (more wait in a queue,
  without blocking); deadlines are 120 s for read, write and truncate, 30 s
  otherwise, and an expired request answers EIO.
- Frames carry a JSON header and a raw payload for reads and writes; reads
  and writes split at the daemon's `max_read` and `max_write` and stop at the
  first short read.
- The root is ino 2 (`.rootDirectory`); other numbers are item ids
  unchanged; `supportsPersistentObjectIDs = false`.
- Attributes: `linkCount` 1, `uid` and `gid` of the extension, `birthTime`
  and `changeTime` from ctime, `accessTime` from mtime, `allocSize` rounded to
  4096, integer time conversion; `maximumFileSize` is implemented;
  `consumedAttributes` comes from the `setattr` reply.
- `readdir` passes FSKit's cookie and verifier through, keeps paging while
  the buffer has room, and maps errno 10003 to
  `FSError(.invalidDirectoryCookie)`.
- Each item remembers its kind, so a remove sends `unlink` or `rmdir` with
  no `getattr` first.
- `createSymbolicLink` sends `symlink`; `setAttributes` sends `setattr`
  (size, mode, times); `reclaimItem` batches `forget`.

## Signing: the owner's Apple steps

The signing settings are ready in `project.yml`: manual style, the
"Developer ID Application" identity, team `TX8NWU7D68`, hardened runtime,
`--timestamp`, no `get-task-allow`. Only the profiles are missing. In the
Apple Developer account (Certificates, Identifiers & Profiles):

1. Confirm the prefix `ai.plannotator.pando`, or change
   `PANDO_BUNDLE_PREFIX` and the names below with it.
2. Identifiers: register two explicit App IDs, `ai.plannotator.pando`
   (description "Pando") and `ai.plannotator.pando.extension` ("Pando
   Extension"). On the extension's App ID, enable **FSKit Module**. The
   broker needs no App ID.
3. Profiles: create two **Developer ID** provisioning profiles with the
   existing "Developer ID Application" certificate, one per App ID, named
   exactly **Pando Developer ID** (for `ai.plannotator.pando`) and **Pando
   Extension Developer ID** (for `ai.plannotator.pando.extension`). Download
   both and double-click them.
4. Build signed: the unsigned command above without
   `CODE_SIGNING_ALLOWED=NO`.
5. Notarize, with a credential the owner stores once
   (`xcrun notarytool store-credentials`, an app-specific password or an App
   Store Connect API key):

   ```bash
   ditto -c -k --keepParent build/Build/Products/Release/Pando.app Pando.zip
   xcrun notarytool submit Pando.zip --keychain-profile <profile> --wait
   xcrun stapler staple build/Build/Products/Release/Pando.app
   ```

6. First run on a Mac: put Pando.app in `/Applications`, open it once, and
   turn on **Pando** in System Settings, General, Login Items & Extensions,
   File System Extensions. No restart.

Not known until the first signed run: whether macOS asks for a password at
the switch, whether it shows a "Background Items Added" notice for the
broker, and whether a rebuilt app keeps the switch on.

## Icon

`node Icon/render.mjs` renders `HostApp/Assets.xcassets` (the app icon at
16 to 1024 px and the window lockup) from `Icon/*.html` with headless
Chrome. The mark is the brand's `01-one-organism/mark.svg` (contour, 64 px
and up) and `mark-small.svg` (solid, 16 and 32 px), in the Night palette.
