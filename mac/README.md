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
| `HostApp/` | Pando.app: carries the extension, explains the one switch, and shows FSKit's answer on whether it is on |
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
| FSKit short name | `pando` (`/sbin/mount -F -t pando <state dir> <mount point>`; the daemon mounts with nobrowse its own way, see "Not a drive") |
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
- Extended attributes live in the extension's memory, per item, and are
  dropped on remove and on unmount. Without them macOS writes every xattr
  (`com.apple.provenance` on each new file, Finder's info) as an AppleDouble
  `._` file through the mount: a `git clone` into a mount got a `._` file
  beside every file, `.git/objects/pack/._pack-*.idx` included, and
  `npm install` 65 among 118 files.
- At debug level the extension logs each call's thread and FSKit's read and
  write sizes:
  `log stream --debug --predicate 'subsystem == "ai.plannotator.pando.extension"'`.

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
   turn on **Pando** in System Settings, General, Login Items & Extensions:
   show the extensions **By Category**, click the info button next to
   **File System Extensions**, turn on Pando, Done. No restart.

## What macOS 26.3 does (measured 2026-10-03)

**The switch.** In the "By App" view the switch for Pando does not stay on:
each click logs `LoginItems: Failed to enabled FSExtension: Error
Domain=NSPOSIXErrorDomain Code=1` (11 tries). From the "By Category" view,
File System Extensions, info button, it works. The failed clicks still set
pluginkit's choice, so `pluginkit -m -i ai.plannotator.pando.extension`
shows `+` while `/sbin/mount` says `Module ai.plannotator.pando.extension is
disabled!`. pluginkit is not FSKit's answer. FSKit keeps its own per-person
list, `~/Library/Group Containers/group.com.apple.fskit.settings/enabledModules.plist`
(Apple DTS, developer forums thread 808594, calls it an implementation
detail). Pando.app asks FSKit itself (`FSClient`, `isEnabled`); the `pando`
command and the daemon read that list and fall back to pluginkit.

**The broker's LaunchAgent.** `pando mac broker` (or the first FSKit
worktree) loads it. About 10 s later macOS shows "Background Items Added":
"“Pando” can run in the background. You can manage background…". No
password.

**Mounting.** No prompt, no password, no notification. From the daemon's
"mounting repo" to the extension's `hello` took about 0.12 s with the
extension already running, about 0.5 s on its first launch.

**Updating Pando.app.**
- A terminal cannot replace it: macOS's App Management protection refuses
  every write into an installed app's bundle ("System Policy: ditto deny(1)
  file-write-create /Applications/Pando.app/Contents/..."), with no prompt.
  Replace it in Finder (drag onto Applications, Replace), or give the
  terminal App Management in System Settings, Privacy & Security.
- Replacing the app unmounts every Pando volume (the daemons log "fskit:
  volume was unmounted" and mount again by themselves later) and **turns the
  switch off**: FSKit rewrites its list without Pando. Turn it on again, By
  Category as above.
- After a Finder replace pluginkit may list nothing for Pando. Register the
  extension again with
  `pluginkit -a /Applications/Pando.app/Contents/Extensions/PandoExtension.appex`.
- Every build on this Mac: unregister and delete the build product right
  after copying it out (`pluginkit -r <build>/Contents/Extensions/PandoExtension.appex`,
  `lsregister -u <build app>`, `rm -rf`), or System Settings shows two Pando
  entries.

**A stale FSKit agent.** After the app is installed or replaced, `fskit_agent`
(the per-person FSKit agent) can keep the old copy's identity. A mount then
fails with `mount: Probing resource: ... (com.apple.extensionKit.errorDomain
error 2.)`, and extensionkitservice logs `Failed to initialize
_EXExtensionIdentity ... Code=5`. Fix: `killall -9 fskit_agent` as yourself
(no sudo; launchd starts it again on demand), or log out and back in. Eject
any other FSKit volume first (an exFAT or FAT drive), because the agent
serves those too. A plain `killall` is not enough: the agent then waits
forever on the failed launch and, while it waits, no FSKit volume mounts.

**Caching.** The kernel caches writes and sends them to the extension later
(100 MiB of `write()` calls return in 0.07 s). `fsync` waits until the daemon
holds every byte, but does not report a write the daemon refused. It caches
attributes and file contents too: a change made behind the kernel stayed
invisible to `stat` and `cat` for 30 to 45 s when the file was checked every
15 s, and for over 90 s when it was checked ten times a second. Directory
listings are not cached. So the daemon writes every server change through
the mount (the fork's write-through); from a HEAD move to FSEvents took about
0.4 s.

**Sizes.** The kernel trusts the size a listing or `stat` reports and cuts
every read at it: a daemon that reported 0 for sizes it did not know made
`cat` print nothing and `cmp` stop at EOF, and the size stayed 0 (measured
2026-10-04). So the daemon never guesses a size. It asks the server
(object-info) for every size when a snapshot is made, keeps asking 1,000 at
a time in the background, and asks for a listed folder's page at once; it
downloads files to learn their sizes only when the server cannot answer.
Numbers: `research/operational/mac-mount-downloads-2026-10-04.md` in the
meta layer.

**Downloads.** A request to Artifacts costs about 0.65 s whatever it
carries (1 blob 0.65 s, 100 blobs 0.67 s, 1,000 blobs 1.7 s). So the daemon
fetches every read that misses at the same moment in one request (up to 500
blobs), and the worktrees of one repository share one blob cache, so a file
downloads once. Git's own automatic repack is off in the daemon's clones: it
swapped packs under running fetches and failed reads. The daemon merges
packs itself with no fetch running. Listing a folder costs about 1 ms through
the mount. Numbers: the same file in the meta layer.

**Not a drive.** A worktree must be a folder, not a drive icon on the
Desktop and in Finder's sidebar. That takes the `nobrowse` mount flag, and
`/sbin/mount -F` drops every `-o` option on macOS 26.3: its last step
(LiveFS's `mountVolume`) gets an empty options string. Apple's own msdos
module loses `nobrowse` and `rdonly` the same way (Apple DTS, developer
forums thread 820931: "it should be" supported). So the daemon does
`/sbin/mount`'s FSKit steps itself, through FSKit's and LiveFS's classes
looked up at run time, and passes `nobrowse` (the fork's
`internal/fskit/nobrowse_darwin.go`). These classes are private: if a macOS
drops them the daemon runs `/sbin/mount`, and the mount works but shows as
a drive. FSEvents, Quick Look and git work the same on a `nobrowse` volume;
`/System/Volumes/Data`, which holds every home folder, is one.
`cli/testbed/mac-sizes.sh` checks it.

## Icon

`node Icon/render.mjs` renders `HostApp/Assets.xcassets` (the app icon at
16 to 1024 px and the window lockup) from `Icon/*.html` with headless
Chrome. The mark is the brand's `01-one-organism/mark.svg` (contour, 64 px
and up) and `mark-small.svg` (solid, 16 and 32 px), in the Night palette.
