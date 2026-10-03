// PandoFileSystem.swift: the FSKit module entry point.
//
// An FSUnaryFileSystem presents one resource as one volume. A Pando mount's
// resource is a path URL (macOS 26): the mount's state folder, which the
// daemon passes to `/sbin/mount -F -t pando <state folder> <mount point>`.
// mount(8) drops unknown `-o key=value` options before they reach FSKit, so
// everything comes from that folder:
//
// - the mount id is the folder's last path component; the broker derives the
//   daemon's socket from it (<mounts dir>/<mount id>/fskit.sock);
// - the volume name shown in Finder is the folder's `volname` file, if any.
//
// Loading sends `hello` and refuses the mount (EPROTONOSUPPORT) if the daemon
// does not speak wire version 3.
//
// Derived from Oak's OakFSUnaryFileSystem.swift (Apache 2.0, see ../NOTICE).

import ExtensionFoundation
import FSKit
import Foundation
import os

/// `@main` for the FSKit app extension (macOS 15.4 and later).
@main
struct PandoModule: UnaryFileSystemExtension {
    var fileSystem = PandoFileSystem()
}

final class PandoFileSystem: FSUnaryFileSystem, FSUnaryFileSystemOperations, @unchecked Sendable {
    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "pando", category: "module")

    private var buildString: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return "Pando.app \(version) (\(build))"
    }

    func probeResource(
        resource: FSResource,
        replyHandler: @escaping (FSProbeResult?, Error?) -> Void
    ) {
        // A path URL resource is always usable; the daemon decides what is
        // behind it.
        replyHandler(.usable(name: "Pando", containerID: FSContainerIdentifier(uuid: UUID())), nil)
    }

    func loadResource(
        resource: FSResource,
        options: FSTaskOptions,
        replyHandler: @escaping (FSVolume?, Error?) -> Void
    ) {
        guard let pathResource = resource as? FSPathURLResource else {
            log.error("loadResource: the resource is not a path URL")
            replyHandler(nil, fs_errorForPOSIXError(EINVAL))
            return
        }
        // The state folder is outside the sandbox; FSKit hands it over as a
        // security-scoped URL. Released in unloadResource.
        let stateDir = pathResource.url
        _ = stateDir.startAccessingSecurityScopedResource()

        let mountID = stateDir.lastPathComponent
        let volname = (try? String(contentsOf: stateDir.appendingPathComponent("volname"), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let volumeName = (volname?.isEmpty == false) ? volname! : "Pando"
        log.info("loadResource: mount \(mountID, privacy: .public), volume '\(volumeName, privacy: .public)'")

        let client = WireClient(mountID: mountID)
        client.call(.hello(build: buildString), timeout: WireDeadline.hello) { [self] result in
            switch result {
            case let .success(r) where r.reply.version == kWireVersion:
                log.info("loadResource: daemon \(r.reply.build ?? "?", privacy: .public) speaks wire v\(kWireVersion)")
                let volume = PandoVolume(client: client, hello: r.reply, volumeName: volumeName, fileSystem: self)
                // FSKit checks the container right after loadResource: it must
                // be ready (not active) here; activation makes it active.
                containerStatus = .ready
                replyHandler(volume, nil)
            case let .success(r):
                log.error("loadResource: wire version mismatch: the extension speaks v\(kWireVersion), daemon \(r.reply.build ?? "?", privacy: .public) speaks v\(r.reply.version ?? 0). Update Pando.app and the pando command together.")
                client.close()
                stateDir.stopAccessingSecurityScopedResource()
                replyHandler(nil, fs_errorForPOSIXError(EPROTONOSUPPORT))
            case let .failure(f):
                // A daemon too old for hello answers with an error (ENOSYS);
                // that is a version mismatch too.
                let code = f.errno == ENOSYS ? EPROTONOSUPPORT : EIO
                log.error("loadResource: hello failed: \(f.message, privacy: .public)")
                client.close()
                stateDir.stopAccessingSecurityScopedResource()
                replyHandler(nil, fs_errorForPOSIXError(code))
            }
        }
    }

    func unloadResource(
        resource: FSResource,
        options: FSTaskOptions,
        replyHandler: @escaping (Error?) -> Void
    ) {
        if let pathResource = resource as? FSPathURLResource {
            pathResource.url.stopAccessingSecurityScopedResource()
        }
        containerStatus = .notReady(status: fs_errorForPOSIXError(EAGAIN))
        replyHandler(nil)
    }
}
