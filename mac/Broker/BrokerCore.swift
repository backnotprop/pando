// pando-broker: relays the sandboxed FSKit extension's messages to the
// right mount's daemon socket.
//
// The App Sandbox stops the extension from opening a unix socket, so it sends
// each wire frame over XPC to this helper's mach service instead. launchd
// starts the helper on demand through a per-user LaunchAgent, which the
// `pando` command writes (see README.md, "The broker").
//
// The contract is the fskit lane's docs/pando-fskit-wire-v3.md (ArtifactFS
// fork), sections 1 and 2.
//
// XPC request:  { "mount": <mount id>, "frame": <one wire v3 frame> }
// XPC reply:    { "frame": <the daemon's reply frame> }. When the broker
//               cannot deliver (bad mount id, no daemon, connection lost) it
//               answers with its own frame, {"id", "errno", "message"}:
//               errno 22 for a bad mount id, 5 for everything else.
//               { "error": 22, "message": ... } only for a frame too
//               malformed to carry an id.
// Ping:         { "ping": true } -> { "pong": true, "version": ..., "state": ... }
//
// The socket is derived, never taken from the extension:
//     $HOME/.pando/fskit/<mount id>/fskit.sock
// where a mount id is 1 to 48 of [A-Za-z0-9._-], starting with a letter or
// digit. (PANDO_FSKIT_DIR replaces $HOME/.pando/fskit for tests; the
// LaunchAgent does not set it.) The broker
// opens the mount folder without following symlinks, connects relative to it
// (a per-thread working directory, so long home paths fit), and checks that
// the daemon on the other end runs as the same user (getpeereid).
//
// Each extension connection gets one persistent unix connection per mount.
// Frames are written as received; the daemon may answer out of order, and a
// reader thread routes each reply to its waiting XPC message by the "id" in
// the reply's JSON header. Nothing blocks the XPC handler, and there is no
// connect per request.
//
// Wire v3 frame: u32 BE frame_len | u32 BE header_len | JSON header | payload.
//
// The entry point is main.swift; ../Tests links this file without it.

import Darwin
import Foundation
@preconcurrency import XPC
import os

// MARK: - Configuration

let serviceName = Bundle.main.object(forInfoDictionaryKey: "PandoBrokerMachService") as? String
    ?? "ai.plannotator.pando.broker"
let brokerVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
let log = Logger(subsystem: serviceName, category: "broker")

/// Contract limits: frame_len at most 16 MiB, header_len at most 4 MiB.
/// A reply over them closes the connection (contract, section 2).
let maxFrame = 16 * 1024 * 1024
let maxHeader = 4 * 1024 * 1024

/// The folder holding one state dir per mount.
let mountsDir: String = {
    if let env = ProcessInfo.processInfo.environment["PANDO_FSKIT_DIR"], !env.isEmpty {
        return env
    }
    return FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".pando/fskit").path
}()

let socketName = "fskit.sock"

func isValidMountID(_ id: String) -> Bool {
    let bytes = Array(id.utf8)
    guard (1...48).contains(bytes.count) else { return false }
    func alnum(_ c: UInt8) -> Bool {
        (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)
    }
    guard alnum(bytes[0]) else { return false }
    return bytes.allSatisfy { alnum($0) || $0 == 0x2D || $0 == 0x2E || $0 == 0x5F }
}

// MARK: - Socket helpers

/// pthread_fchdir_np sets the calling thread's working directory (macOS
/// 10.12 and later; exported by libc but not in the public headers). The
/// broker uses it to connect to "fskit.sock" relative to the mount folder it
/// opened, so the full path never has to fit sun_path's 104 bytes and the
/// folder cannot be swapped for a symlink between the check and the connect.
private typealias FChdir = @convention(c) (Int32) -> Int32
private let threadFchdir: FChdir? = {
    let rtldDefault = UnsafeMutableRawPointer(bitPattern: -2) // RTLD_DEFAULT
    return dlsym(rtldDefault, "pthread_fchdir_np").map { unsafeBitCast($0, to: FChdir.self) }
}()

/// Carries an XPC object into a dispatch block; XPC objects are thread safe.
struct Carried: @unchecked Sendable { let object: xpc_object_t }

struct BrokerError: Error {
    let code: Int32
    let message: String
}

/// Connects to $HOME/.pando/fskit/<id>/fskit.sock and checks the peer's uid.
func connectToMount(_ id: String) throws -> Int32 {
    guard isValidMountID(id) else {
        throw BrokerError(code: EINVAL, message: "invalid mount id")
    }
    let base = open(mountsDir, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard base >= 0 else {
        throw BrokerError(code: errno, message: "cannot open \(mountsDir)")
    }
    defer { close(base) }
    let dir = openat(base, id, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard dir >= 0 else {
        throw BrokerError(code: errno, message: "no mount folder for \(id)")
    }
    defer { close(dir) }

    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw BrokerError(code: errno, message: "socket() failed") }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    var one: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))

    // Connect to "fskit.sock" relative to the mount folder, on this thread
    // only; fall back to the full path where that call is missing.
    let relative = threadFchdir.map { $0(dir) == 0 } ?? false
    defer { if relative { _ = threadFchdir?(-1) } } // back to the process directory
    let target = relative ? socketName : mountsDir + "/" + id + "/" + socketName
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let nameBytes = Array(target.utf8)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path)
    guard nameBytes.count < capacity else {
        close(fd)
        throw BrokerError(code: ENAMETOOLONG, message: "socket path too long for \(id)")
    }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        for (i, b) in nameBytes.enumerated() { raw[i] = b }
        raw[nameBytes.count] = 0
    }
    let len = socklen_t(MemoryLayout<sockaddr_un>.offset(of: \sockaddr_un.sun_path)! + nameBytes.count + 1)
    addr.sun_len = UInt8(len)
    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, len) }
    }
    guard rc == 0 else {
        let code = errno
        close(fd)
        throw BrokerError(code: code, message: "cannot connect to the daemon for \(id)")
    }

    var uid: uid_t = 0
    var gid: gid_t = 0
    guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else {
        close(fd)
        throw BrokerError(code: EPERM, message: "daemon socket for \(id) belongs to another user")
    }
    return fd
}

func readFull(_ fd: Int32, _ buf: UnsafeMutableRawBufferPointer) -> Bool {
    var done = 0
    while done < buf.count {
        let n = read(fd, buf.baseAddress! + done, buf.count - done)
        if n > 0 { done += n; continue }
        if n < 0 && errno == EINTR { continue }
        return false
    }
    return true
}

func writeFull(_ fd: Int32, _ ptr: UnsafeRawPointer, _ count: Int) -> Bool {
    var done = 0
    while done < count {
        let n = write(fd, ptr + done, count - done)
        if n > 0 { done += n; continue }
        if n < 0 && errno == EINTR { continue }
        return false
    }
    return true
}

func be32(_ p: UnsafeRawPointer) -> Int {
    Int(UInt32(bigEndian: p.loadUnaligned(as: UInt32.self)))
}

private struct HeaderID: Decodable { let id: UInt64 }

/// Reads the request id from a whole frame (with its 4-byte length prefix).
/// Returns nil if the frame is malformed.
func frameID(_ frame: UnsafeRawBufferPointer) -> UInt64? {
    guard frame.count >= 8, let base = frame.baseAddress else { return nil }
    guard be32(base) == frame.count - 4 else { return nil }
    let headerLen = be32(base + 4)
    guard headerLen > 0, headerLen <= maxHeader, 8 + headerLen <= frame.count else { return nil }
    let header = Data(bytesNoCopy: UnsafeMutableRawPointer(mutating: base + 8),
                      count: headerLen, deallocator: .none)
    return (try? JSONDecoder().decode(HeaderID.self, from: header))?.id
}

// MARK: - Replies

/// Answers with a reply frame of the broker's own: {"id", "errno", "message"}.
func replyErrno(to request: xpc_object_t, id: UInt64, _ code: Int32, _ message: String) {
    let header: [String: Any] = ["id": NSNumber(value: id), "errno": NSNumber(value: code), "message": message]
    guard let json = try? JSONSerialization.data(withJSONObject: header) else { return }
    var frame = Data()
    withUnsafeBytes(of: UInt32(4 + json.count).bigEndian) { frame.append(contentsOf: $0) }
    withUnsafeBytes(of: UInt32(json.count).bigEndian) { frame.append(contentsOf: $0) }
    frame.append(json)
    frame.withUnsafeBytes { replyFrame(to: request, $0) }
}

/// For a frame too malformed to carry an id.
func replyError(to request: xpc_object_t, _ code: Int32, _ message: String) {
    guard let reply = xpc_dictionary_create_reply(request),
          let peer = xpc_dictionary_get_remote_connection(request) else { return }
    xpc_dictionary_set_int64(reply, "error", Int64(code))
    xpc_dictionary_set_string(reply, "message", message)
    xpc_connection_send_message(peer, reply)
}

func replyFrame(to request: xpc_object_t, _ frame: UnsafeRawBufferPointer) {
    guard let reply = xpc_dictionary_create_reply(request),
          let peer = xpc_dictionary_get_remote_connection(request) else { return }
    xpc_dictionary_set_data(reply, "frame", frame.baseAddress!, frame.count)
    xpc_connection_send_message(peer, reply)
}

// MARK: - One persistent connection to one mount's daemon

final class MountLink: @unchecked Sendable {
    let mount: String
    private let fd: Int32
    private let lock = NSLock()
    private var pending: [UInt64: xpc_object_t] = [:]
    private var closed = false
    private let writes: DispatchQueue
    private let onClose: @Sendable (MountLink) -> Void

    init(mount: String, fd: Int32, onClose: @escaping @Sendable (MountLink) -> Void) {
        self.mount = mount
        self.fd = fd
        self.onClose = onClose
        self.writes = DispatchQueue(label: "\(serviceName).write.\(mount)")
        let reader = Thread { [self] in self.readLoop() }
        reader.name = "\(serviceName).read.\(mount)"
        reader.start()
    }

    var isClosed: Bool { lock.withLock { closed } }

    /// Queues one request frame. Never blocks the caller.
    func send(_ request: xpc_object_t, id: UInt64) {
        let accepted: Bool = lock.withLock {
            if closed || pending[id] != nil { return false }
            pending[id] = request
            return true
        }
        guard accepted else {
            replyErrno(to: request, id: id, isClosed ? EIO : EINVAL,
                       isClosed ? "daemon connection closed" : "duplicate request id \(id)")
            return
        }
        let carried = Carried(object: request)
        writes.async { [self] in
            var length = 0
            guard let bytes = xpc_dictionary_get_data(carried.object, "frame", &length),
                  writeFull(fd, bytes, length) else {
                shutdown("write to the daemon failed")
                return
            }
        }
    }

    /// Closes the connection; the reader fails every waiting request.
    func shutdown(_ why: String) {
        let first: Bool = lock.withLock {
            if closed { return false }
            closed = true
            return true
        }
        if first {
            log.info("mount \(self.mount, privacy: .public): closing (\(why, privacy: .public))")
            Darwin.shutdown(fd, SHUT_RDWR)
        }
    }

    private func readLoop() {
        var prefix = [UInt8](repeating: 0, count: 4)
        while true {
            let ok = prefix.withUnsafeMutableBytes { readFull(fd, $0) }
            guard ok else { break }
            let frameLen = prefix.withUnsafeBytes { be32($0.baseAddress!) }
            guard frameLen >= 4, frameLen <= maxFrame else {
                log.error("mount \(self.mount, privacy: .public): bad reply frame length \(frameLen)")
                break
            }
            var frame = Data(count: 4 + frameLen)
            let complete = frame.withUnsafeMutableBytes { buf -> Bool in
                buf.copyBytes(from: prefix)
                return readFull(fd, UnsafeMutableRawBufferPointer(rebasing: buf[4...]))
            }
            guard complete else { break }
            let routed = frame.withUnsafeBytes { buf -> Bool in
                guard let id = frameID(buf) else { return false }
                let request = lock.withLock { pending.removeValue(forKey: id) }
                if let request { replyFrame(to: request, buf) }
                return true
            }
            guard routed else {
                // Contract, section 2: a header that is not a JSON object
                // with an id closes the connection.
                log.error("mount \(self.mount, privacy: .public): reply header without a readable id")
                break
            }
        }
        // The daemon went away or broke the framing: every request still
        // waiting gets errno 5 (EIO).
        let waiting: [(UInt64, xpc_object_t)] = lock.withLock {
            closed = true
            let all = pending.map { ($0.key, $0.value) }
            pending.removeAll()
            return all
        }
        for (id, request) in waiting { replyErrno(to: request, id: id, EIO, "daemon connection closed") }
        close(fd)
        onClose(self)
    }
}

// MARK: - One extension connection

final class Peer: @unchecked Sendable {
    private let connection: xpc_connection_t
    private let lock = NSLock()
    private var links: [String: MountLink] = [:]

    init(_ connection: xpc_connection_t) {
        self.connection = connection
    }

    func start() {
        xpc_connection_set_target_queue(connection, DispatchQueue(label: "\(serviceName).peer"))
        xpc_connection_set_event_handler(connection) { [self] event in
            if xpc_get_type(event) == XPC_TYPE_DICTIONARY {
                handle(event)
            } else {
                // Invalidated or interrupted: the extension is gone.
                let all = lock.withLock { () -> [MountLink] in
                    let all = Array(links.values)
                    links.removeAll()
                    return all
                }
                for link in all { link.shutdown("extension disconnected") }
            }
        }
        xpc_connection_activate(connection)
    }

    private func handle(_ message: xpc_object_t) {
        if xpc_dictionary_get_bool(message, "ping") {
            guard let reply = xpc_dictionary_create_reply(message) else { return }
            xpc_dictionary_set_bool(reply, "pong", true)
            xpc_dictionary_set_string(reply, "version", brokerVersion)
            xpc_dictionary_set_string(reply, "state", mountsDir)
            xpc_connection_send_message(connection, reply)
            return
        }
        var length = 0
        guard let bytes = xpc_dictionary_get_data(message, "frame", &length),
              length - 4 <= maxFrame,
              let id = frameID(UnsafeRawBufferPointer(start: bytes, count: length)) else {
            replyError(to: message, EINVAL, "malformed frame")
            return
        }
        guard let cMount = xpc_dictionary_get_string(message, "mount") else {
            replyErrno(to: message, id: id, EINVAL, "message has no mount id")
            return
        }
        let mount = String(cString: cMount)
        do {
            try link(for: mount).send(message, id: id)
        } catch let error as BrokerError {
            // A bad mount id is EINVAL; a mount the broker cannot reach is EIO.
            replyErrno(to: message, id: id, error.code == EINVAL ? EINVAL : EIO, error.message)
        } catch {
            replyErrno(to: message, id: id, EIO, "\(error)")
        }
    }

    /// The live connection for a mount, connecting on first use or after the
    /// daemon restarted. Connecting a local unix socket does not wait on the
    /// daemon, so this is safe on the XPC queue.
    private func link(for mount: String) throws -> MountLink {
        if let existing = lock.withLock({ links[mount] }), !existing.isClosed {
            return existing
        }
        let fd = try connectToMount(mount)
        let link = MountLink(mount: mount, fd: fd) { [weak self] closed in
            guard let self else { return }
            self.lock.withLock {
                if self.links[closed.mount] === closed { self.links[closed.mount] = nil }
            }
        }
        lock.withLock { links[mount] = link }
        log.info("mount \(mount, privacy: .public): connected")
        return link
    }
}

// MARK: - Entry points

func runService() -> Never {
    signal(SIGPIPE, SIG_IGN)
    let listener = xpc_connection_create_mach_service(
        serviceName, DispatchQueue(label: "\(serviceName).listener"),
        UInt64(XPC_CONNECTION_MACH_SERVICE_LISTENER))
    xpc_connection_set_event_handler(listener) { event in
        if xpc_get_type(event) == XPC_TYPE_CONNECTION {
            Peer(event).start()
        } else {
            log.error("listener event: \(String(describing: event), privacy: .public)")
        }
    }
    xpc_connection_activate(listener)
    log.info("pando-broker \(brokerVersion, privacy: .public) serving \(serviceName, privacy: .public), mount state in \(mountsDir, privacy: .public)")
    dispatchMain()
}

/// Asks the running service for a pong. Exits 0 if launchd vends the
/// service and it answers within five seconds.
func runPing() -> Never {
    let connection = xpc_connection_create_mach_service(serviceName, nil, 0)
    xpc_connection_set_event_handler(connection) { _ in }
    xpc_connection_activate(connection)
    let message = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_bool(message, "ping", true)
    let done = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var answer: xpc_object_t?
    xpc_connection_send_message_with_reply(connection, message, nil) { reply in
        answer = reply
        done.signal()
    }
    guard done.wait(timeout: .now() + 5) == .success else {
        print("\(serviceName): no answer within 5 s")
        exit(1)
    }
    guard let answer, xpc_get_type(answer) == XPC_TYPE_DICTIONARY,
          xpc_dictionary_get_bool(answer, "pong") else {
        print("\(serviceName): not reachable (is the LaunchAgent loaded?)")
        exit(1)
    }
    let version = xpc_dictionary_get_string(answer, "version").map { String(cString: $0) } ?? "?"
    let state = xpc_dictionary_get_string(answer, "state").map { String(cString: $0) } ?? "?"
    print("\(serviceName): pong, broker \(version), mount state in \(state)")
    exit(0)
}
