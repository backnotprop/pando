// Wire v3 harness: the extension's WireClient, the broker's core and a fake
// daemon, in one process, over real XPC (an in-process anonymous listener)
// and a real unix socket. Run with Tests/run.sh. Needs no signing, no
// launchd and no FSKit.
//
// What it checks:
//  1. hello round trip; the frame layout both ways.
//  2. 300 concurrent getattr calls answered out of order land on the right
//     callers (request ids, one persistent connection).
//  3. read and write with raw payloads, byte for byte.
//  4. a daemon errno reaches the caller unchanged.
//  5. readdir and setattr reply fields decode.
//  6. the in-flight cap holds (the daemon never sees more than the cap).
//  7. a request the daemon never answers fails at its deadline, and the
//     client keeps working.
//  8. a bad mount id fails with EINVAL and a missing mount with EIO, in
//     error frames the broker makes itself.
//  9. the daemon dropping the connection fails what is pending, and the
//     next call reconnects.
// 10. the mounts folder path is longer than sun_path allows.

import Darwin
import Foundation
@preconcurrency import XPC

// MARK: - Setup

let longName = String(repeating: "long-folder-name-", count: 5)
let root = NSTemporaryDirectory() + "pando-wire-test-\(getpid())/\(longName)/fskit"
let mountDir = root + "/m1"
try! FileManager.default.createDirectory(atPath: mountDir, withIntermediateDirectories: true)
setenv("PANDO_FSKIT_DIR", root, 1)
precondition((mountDir + "/fskit.sock").utf8.count > 104, "the test path should exceed sun_path")

nonisolated(unsafe) var failures = 0
func check(_ ok: Bool, _ what: String) {
    print(ok ? "ok    \(what)" : "FAIL  \(what)")
    if !ok { failures += 1 }
}

// MARK: - Fake daemon

final class FakeDaemon: @unchecked Sendable {
    private var listenFD: Int32 = -1
    private let lock = NSLock()
    private var conns: [Int32] = []
    private(set) var outstanding = 0
    private(set) var maxOutstanding = 0
    private(set) var accepts = 0
    var forgotten: [UInt64] = []
    private let work = DispatchQueue(label: "daemon.work", attributes: .concurrent)

    init(dir: String) {
        // bind() needs a path under 104 bytes; bind relative to the folder.
        let cwd = FileManager.default.currentDirectoryPath
        precondition(chdir(dir) == 0)
        listenFD = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let name = Array("fskit.sock".utf8)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in name.enumerated() { raw[i] = b }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.offset(of: \sockaddr_un.sun_path)! + name.count + 1)
        addr.sun_len = UInt8(len)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listenFD, $0, len) }
        }
        precondition(rc == 0, "bind failed: \(errno)")
        precondition(listen(listenFD, 16) == 0)
        precondition(chdir(cwd) == 0)
        Thread { [self] in acceptLoop() }.start()
    }

    func resetCounters() { lock.withLock { maxOutstanding = 0 } }

    /// Closes every accepted connection, as a daemon restart would.
    func dropConnections() {
        let all = lock.withLock { () -> [Int32] in let c = conns; conns.removeAll(); return c }
        for fd in all { shutdown(fd, SHUT_RDWR) }
    }

    private func acceptLoop() {
        while true {
            let fd = accept(listenFD, nil, nil)
            if fd < 0 { if errno == EINTR { continue }; return }
            var one: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            lock.withLock { conns.append(fd); accepts += 1 }
            let writeLock = NSLock()
            Thread { [self] in serve(fd, writeLock) }.start()
        }
    }

    private func serve(_ fd: Int32, _ writeLock: NSLock) {
        while true {
            var prefix = [UInt8](repeating: 0, count: 4)
            guard prefix.withUnsafeMutableBytes({ readFull(fd, $0) }) else { break }
            let frameLen = prefix.withUnsafeBytes { be32($0.baseAddress!) }
            var body = Data(count: frameLen)
            guard body.withUnsafeMutableBytes({ readFull(fd, $0) }) else { break }
            let headerLen = body.withUnsafeBytes { be32($0.baseAddress!) }
            let header = try! JSONSerialization.jsonObject(with: body.subdata(in: 4..<(4 + headerLen))) as! [String: Any]
            let payload = body.subdata(in: (4 + headerLen)..<body.count)
            let id = (header["id"] as! NSNumber).uint64Value
            let op = header["op"] as! String
            let ino = (header["ino"] as? NSNumber)?.uint64Value ?? 0
            if op == "getattr" && ino == 999 { continue } // never answered
            lock.withLock { outstanding += 1; maxOutstanding = max(maxOutstanding, outstanding) }
            work.async { [self] in
                let (reply, data) = answer(id: id, op: op, header: header, payload: payload)
                lock.withLock { outstanding -= 1 }
                let h = try! JSONSerialization.data(withJSONObject: reply)
                var frame = Data()
                withUnsafeBytes(of: UInt32(4 + h.count + data.count).bigEndian) { frame.append(contentsOf: $0) }
                withUnsafeBytes(of: UInt32(h.count).bigEndian) { frame.append(contentsOf: $0) }
                frame.append(h)
                frame.append(data)
                writeLock.withLock { _ = frame.withUnsafeBytes { writeFull(fd, $0.baseAddress!, $0.count) } }
            }
        }
        close(fd)
    }

    private func attr(_ ino: UInt64, kind: Int = 1, size: UInt64 = 10) -> [String: Any] {
        ["ino": ino, "kind": kind, "mode": 0o644, "size": size,
         "mtime_ns": 1_700_000_000_123_456_789 as Int64, "ctime_ns": 1_700_000_001_000_000_000 as Int64]
    }

    private func answer(id: UInt64, op: String, header: [String: Any], payload: Data) -> ([String: Any], Data) {
        let ino = (header["ino"] as? NSNumber)?.uint64Value ?? 0
        switch op {
        case "hello":
            return (["id": id, "errno": 0, "version": 3, "build": "fake",
                     "max_read": 65536, "max_write": 65536], Data())
        case "getattr":
            usleep(UInt32.random(in: 0...3000)) // answer out of order
            return (["id": id, "errno": 0, "attr": attr(ino)], Data())
        case "lookup":
            if header["name"] as? String == "missing" { return (["id": id, "errno": ENOENT], Data()) }
            return (["id": id, "errno": 0, "attr": attr(42)], Data())
        case "read":
            let offset = (header["offset"] as! NSNumber).intValue
            let size = (header["size"] as! NSNumber).intValue
            let count = max(0, min(size, 100_000 - offset)) // the file is 100,000 bytes
            let bytes = Data((0..<count).map { UInt8((offset + $0) % 251) })
            return (["id": id, "errno": 0], bytes)
        case "write":
            let sum = payload.reduce(0) { $0 &+ Int($1) }
            let offset = (header["offset"] as! NSNumber).uint64Value
            return (["id": id, "errno": 0, "written": payload.count,
                     "size": offset + UInt64(payload.count), "target": String(sum)], Data())
        case "readdir":
            // Contract 4.4: positions in [".", "..", children...]; with
            // attributes the dots are skipped and every entry has attr.
            let withAttrs = header["with_attrs"] as? Bool ?? false
            let cookie = (header["cookie"] as! NSNumber).intValue
            let verifier = (header["verifier"] as! NSNumber).uint64Value
            if cookie > 0 && verifier != 7 { return (["id": id, "errno": 10003], Data()) }
            let all: [(String, UInt64, Int)] = [(".", 2, 0), ("..", 1, 0), ("a.txt", 12, 1), ("b", 13, 0)]
            var entries: [[String: Any]] = []
            for pos in (withAttrs ? max(cookie, 2) : cookie)..<all.count {
                let (name, ino, kind) = all[pos]
                var e: [String: Any] = ["name": name, "ino": ino, "kind": kind, "next_cookie": pos + 1]
                if withAttrs { e["attr"] = attr(ino, kind: kind) }
                entries.append(e)
            }
            return (["id": id, "errno": 0, "entries": entries, "verifier": 7, "eof": true], Data())
        case "forget":
            let inos = (header["inos"] as? [NSNumber])?.map(\.uint64Value) ?? []
            lock.withLock { forgotten += inos }
            return (["id": id, "errno": 0], Data())
        case "setattr":
            let consumed = ["size", "mode", "mtime_ns", "atime_ns"].filter { header[$0] != nil }
                .map { $0.replacingOccurrences(of: "_ns", with: "") }
            return (["id": id, "errno": 0, "attr": attr(ino), "consumed": consumed], Data())
        default:
            return (["id": id, "errno": ENOSYS], Data())
        }
    }
}

// MARK: - Broker side: an in-process listener running the broker's Peer

let listener = xpc_connection_create(nil, DispatchQueue(label: "test.listener"))
xpc_connection_set_event_handler(listener) { peer in
    if xpc_get_type(peer) == XPC_TYPE_CONNECTION { Peer(peer).start() }
}
xpc_connection_activate(listener)
nonisolated(unsafe) let endpoint = xpc_endpoint_create(listener)
func client(_ mount: String, maxInFlight: Int = 64) -> WireClient {
    WireClient(mountID: mount, maxInFlight: maxInFlight) { xpc_connection_create_from_endpoint(endpoint) }
}

func callSync(_ c: WireClient, _ op: WireOp, payload: Data? = nil,
              timeout: TimeInterval = 5) -> Result<WireResponse, WireFailure> {
    let done = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var result: Result<WireResponse, WireFailure>?
    c.call(op, payload: payload, timeout: timeout) { result = $0; done.signal() }
    done.wait()
    return result!
}

/// The tests run outside the main actor, as FSKit's callbacks do, so their
/// closures may run on the client's queues.
nonisolated func runTests() {
    let daemon = FakeDaemon(dir: mountDir)
    let c = client("m1")

    // 1. hello
    if case let .success(r) = callSync(c, .hello(build: "test")) {
        check(r.reply.version == 3 && r.reply.max_read == 65536 && r.reply.build == "fake", "hello: version 3, build, limits")
    } else { check(false, "hello") }

    // 2. concurrent, out of order
    do {
        let group = DispatchGroup()
        let lock = NSLock()
        nonisolated(unsafe) var right = 0
        for i in 0..<300 {
            group.enter()
            c.call(.getattr(ino: UInt64(1000 + i)), timeout: 10) { result in
                if case let .success(r) = result, r.reply.attr?.ino == UInt64(1000 + i) { lock.withLock { right += 1 } }
                group.leave()
            }
        }
        group.wait()
        check(right == 300, "300 concurrent getattr calls, answered out of order, each reached its caller (\(right))")
        check(daemon.accepts == 1, "one persistent daemon connection (\(daemon.accepts) accepted)")
    }

    // 3. read and write payloads
    if case let .success(r) = callSync(c, .read(ino: 5, offset: 1000, size: 65536)) {
        let expected = Data((0..<65536).map { UInt8((1000 + $0) % 251) })
        check(r.payload == expected, "read: 64 KiB raw payload, byte for byte")
    } else { check(false, "read") }
    if case let .success(r) = callSync(c, .read(ino: 5, offset: 99_990, size: 100)) {
        check(r.payload.count == 10, "read: a short reply marks end of file (\(r.payload.count) bytes)")
    } else { check(false, "short read") }
    do {
        let data = Data((0..<50_000).map { UInt8($0 % 256) })
        let sum = data.reduce(0) { $0 &+ Int($1) }
        if case let .success(r) = callSync(c, .write(ino: 5, offset: 10), payload: data) {
            check(r.reply.written == 50_000 && r.reply.size == 50_010 && r.reply.target == String(sum),
                  "write: 50,000-byte raw payload arrived intact")
        } else { check(false, "write") }
    }

    // 4. errno passes through
    if case let .failure(f) = callSync(c, .lookup(parent: 1, name: "missing")) {
        check(f.errno == ENOENT, "lookup of a missing name fails with ENOENT")
    } else { check(false, "lookup missing") }
    if case let .success(r) = callSync(c, .lookup(parent: 1, name: "here")) {
        check(r.reply.attr?.ino == 42 && r.reply.attr?.mtime_ns == 1_700_000_000_123_456_789, "lookup: attr record decodes")
    } else { check(false, "lookup") }

    // 5. readdir, setattr, forget
    if case let .success(r) = callSync(c, .readdir(ino: 2, cookie: 0, verifier: 0, maxEntries: 256, withAttrs: true)) {
        check(r.reply.entries?.count == 2 && r.reply.entries?[0].attr?.ino == 12
              && r.reply.entries?[0].next_cookie == 3 && r.reply.verifier == 7 && r.reply.eof == true,
              "readdir with attributes: entries, next_cookie, verifier and eof decode")
    } else { check(false, "readdir") }
    if case let .success(r) = callSync(c, .readdir(ino: 2, cookie: 0, verifier: 0, maxEntries: 256, withAttrs: false)) {
        check(r.reply.entries?.map(\.name) == [".", "..", "a.txt", "b"] && r.reply.entries?[1].ino == 1,
              "plain readdir: \".\" and \"..\" come first, the root's \"..\" is 1")
    } else { check(false, "plain readdir") }
    if case let .failure(f) = callSync(c, .readdir(ino: 2, cookie: 3, verifier: 99, maxEntries: 256, withAttrs: false)) {
        check(f.errno == kErrBadCookie, "a stale cookie comes back as errno 10003")
    } else { check(false, "bad cookie") }
    if case .success = callSync(c, .forget(inos: [12, 13, 40])) {
        check(daemon.forgotten == [12, 13, 40], "forget carries a batch of inos")
    } else { check(false, "forget") }
    if case let .success(r) = callSync(c, .setattr(ino: 9, size: nil, mode: 0o755, mtimeNs: 5, atimeNs: nil)) {
        check(r.reply.consumed == ["mode", "mtime"], "setattr: only the fields sent are applied (\(r.reply.consumed ?? []))")
    } else { check(false, "setattr") }

    // 6. the in-flight cap
    do {
        let capped = client("m1", maxInFlight: 4)
        daemon.resetCounters()
        let group = DispatchGroup()
        for i in 0..<100 {
            group.enter()
            capped.call(.getattr(ino: UInt64(i + 3)), timeout: 10) { _ in group.leave() }
        }
        group.wait()
        check(daemon.maxOutstanding <= 4, "cap of 4 in flight held (daemon saw at most \(daemon.maxOutstanding))")
    }

    // 7. deadline
    do {
        let start = Date()
        if case let .failure(f) = callSync(c, .getattr(ino: 999), timeout: 0.5) {
            let waited = Date().timeIntervalSince(start)
            check(f.errno == EIO && waited < 2, "a request with no answer fails with EIO at its deadline (\(String(format: "%.2f", waited)) s)")
        } else { check(false, "deadline") }
        if case .success = callSync(c, .getattr(ino: 7)) {
            check(true, "the client keeps working after a deadline")
        } else { check(false, "after deadline") }
    }

    // 8. broker refuses bad mounts
    if case let .failure(f) = callSync(client("../m1"), .getattr(ino: 3)) {
        check(f.errno == EINVAL && f.message.contains("invalid mount id"), "a mount id with a path in it is refused (\(f.message))")
    } else { check(false, "bad mount id") }
    if case let .failure(f) = callSync(client(String(repeating: "a", count: 49)), .getattr(ino: 3)) {
        check(f.errno == EINVAL, "a 49-character mount id is refused (contract: 1 to 48)")
    } else { check(false, "long mount id") }
    if case let .failure(f) = callSync(client("nope"), .getattr(ino: 3)) {
        check(f.errno == EIO && f.message.contains("no mount folder"), "a missing mount fails with EIO (\(f.message))")
    } else { check(false, "missing mount") }

    // 9. daemon restart
    do {
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var pendingResult: Result<WireResponse, WireFailure>?
        c.call(.getattr(ino: 999), timeout: 10) { pendingResult = $0; done.signal() }
        usleep(200_000)
        daemon.dropConnections()
        done.wait()
        if case let .failure(f) = pendingResult {
            check(f.errno == EIO && f.message.contains("daemon connection closed"), "a dropped daemon connection fails pending calls (\(f.message))")
        } else { check(false, "drop") }
        if case let .success(r) = callSync(c, .getattr(ino: 77)) {
            check(r.reply.attr?.ino == 77 && daemon.accepts >= 2, "the next call reconnects (\(daemon.accepts) connections so far)")
        } else { check(false, "reconnect") }
    }

    // 10 is covered by every call above: the socket path is \((mountDir + "/fskit.sock").utf8.count) bytes.
    check(true, "socket path of \((mountDir + "/fskit.sock").utf8.count) bytes reached by connecting relative to the mount folder")
}

runTests()

try? FileManager.default.removeItem(atPath: NSTemporaryDirectory() + "pando-wire-test-\(getpid())")
print(failures == 0 ? "PASS" : "FAILED: \(failures)")
exit(failures == 0 ? 0 : 1)
