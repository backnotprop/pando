// WireClient.swift: the sandboxed extension's channel to the mount's daemon.
//
// The App Sandbox stops the extension from opening the daemon's unix socket,
// so every frame goes over XPC to the broker (Contents/MacOS/pando-broker),
// which launchd starts on demand and which relays it to
// <mounts dir>/<mount id>/fskit.sock. Each XPC message is
// { "mount": <mount id>, "frame": <frame> }; the reply is { "frame": ... }
// or { "error": <errno>, "message": ... } when the broker cannot deliver.
//
// Rules from the wire contract (section 7) and the diligence (section 6.6):
// - Never block inside an FSKit callback. `call` returns at once; the
//   completion runs later on a concurrent queue.
// - Every request carries an id; replies may come back in any order.
// - At most `maxInFlight` requests are outstanding. More wait in a queue,
//   without blocking the caller.
// - Every request has a deadline. When it passes, the request fails with EIO
//   and a late reply is dropped.
//
// No FSKit here, so the harness in ../Tests can run it with the broker.
//
// Derived from Oak's DaemonClient.swift (Apache 2.0, see ../NOTICE); the
// transport is rewritten for wire version 3.

import Foundation
@preconcurrency import XPC
import os

/// Why a call failed: the daemon's errno, or EIO for transport failures and
/// expired deadlines.
struct WireFailure: Error, Sendable {
    let errno: Int32
    let message: String
}

/// Deadlines (contract, section 7: 120 s for read, 30 s otherwise).
enum WireDeadline {
    /// Reads wait for a blob to download. Writes and truncates get the same
    /// allowance here, since the daemon may download a file before changing it.
    static let data: TimeInterval = 120
    static let metadata: TimeInterval = 30
    static let hello: TimeInterval = 10
}

final class WireClient: @unchecked Sendable {
    typealias Completion = (Result<WireResponse, WireFailure>) -> Void

    let mountID: String
    private let maxInFlight: Int
    private let makeConnection: () -> xpc_connection_t
    private let queue = DispatchQueue(label: "wire.client", attributes: .concurrent)
    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "pando", category: "wire")

    private let lock = NSLock()
    private var connection: xpc_connection_t?
    private var nextID: UInt64 = 1
    private var inFlight = 0
    private var waiting: [Request] = []
    private var waitingHead = 0
    private var closed = false

    /// The broker's mach service, from the extension's Info.plist
    /// (PandoBrokerMachService, set from PANDO_BUNDLE_PREFIX in project.yml).
    static var brokerService: String {
        Bundle.main.object(forInfoDictionaryKey: "PandoBrokerMachService") as? String
            ?? "ai.plannotator.pando.broker"
    }

    /// - Parameters:
    ///   - mountID: the mount's id; the broker derives the socket from it.
    ///   - maxInFlight: outstanding requests allowed before new ones queue.
    ///   - makeConnection: opens the XPC connection to the broker. The
    ///     default looks up the broker's mach service; tests pass an
    ///     in-process endpoint.
    init(mountID: String, maxInFlight: Int = 64,
         makeConnection: (() -> xpc_connection_t)? = nil) {
        self.mountID = mountID
        self.maxInFlight = max(1, maxInFlight)
        self.makeConnection = makeConnection ?? {
            xpc_connection_create_mach_service(WireClient.brokerService, nil, 0)
        }
    }

    deinit { close() }

    /// Sends one request. Returns at once; `completion` runs exactly once, on
    /// a concurrent queue. A non-zero errno in the reply arrives as a failure.
    func call(_ op: WireOp, payload: Data? = nil, timeout: TimeInterval,
              completion: @escaping Completion) {
        // Debug level: kept only while someone streams with --debug. Shows
        // which thread FSKit delivered the operation on (diligence 8.2, test 1).
        log.debug("call \(op.name, privacy: .public) on thread \(pthread_mach_thread_np(pthread_self()))")
        let request: Request? = lock.withLock {
            if closed { return nil }
            let r = Request(id: nextID, op: op, payload: payload, timeout: timeout, completion: completion)
            nextID &+= 1
            if inFlight < maxInFlight {
                inFlight += 1
                r.started = true
            } else {
                waiting.append(r)
            }
            return r
        }
        guard let request else {
            completion(.failure(WireFailure(errno: EIO, message: "client closed")))
            return
        }
        if request.started { start(request) }
    }

    /// Cancels the connection. Outstanding and queued calls fail with EIO.
    func close() {
        let (conn, queued): (xpc_connection_t?, [Request]) = lock.withLock {
            if closed { return (nil, []) }
            closed = true
            let c = connection
            connection = nil
            let q = Array(waiting[waitingHead...])
            waiting.removeAll()
            waitingHead = 0
            return (c, q)
        }
        if let conn { xpc_connection_cancel(conn) }
        for r in queued { finish(r, .failure(WireFailure(errno: EIO, message: "client closed")), counted: false) }
    }

    // MARK: - Internals

    private final class Request: @unchecked Sendable {
        let id: UInt64
        let op: WireOp
        var payload: Data?
        let timeout: TimeInterval
        let completion: Completion
        var started = false
        var done = false

        init(id: UInt64, op: WireOp, payload: Data?, timeout: TimeInterval, completion: @escaping Completion) {
            self.id = id
            self.op = op
            self.payload = payload
            self.timeout = timeout
            self.completion = completion
        }
    }

    private func currentConnection() -> xpc_connection_t? {
        lock.withLock {
            if closed { return nil }
            if let c = connection { return c }
            let c = makeConnection()
            xpc_connection_set_target_queue(c, queue)
            xpc_connection_set_event_handler(c) { [weak self] event in
                guard let self else { return }
                // Interrupted: the broker exited; launchd starts it again on
                // the next message, and pending replies already failed.
                // Invalid: the service is gone; make a new connection next time.
                if xpc_get_type(event) == XPC_TYPE_ERROR {
                    let description = String(describing: event)
                    self.log.error("broker connection: \(description, privacy: .public)")
                    if event === XPC_ERROR_CONNECTION_INVALID {
                        self.lock.withLock { if self.connection === c { self.connection = nil } }
                    }
                }
            }
            xpc_connection_activate(c)
            connection = c
            return c
        }
    }

    private func start(_ r: Request) {
        let frame: Data
        do {
            frame = try encodeFrame(id: r.id, op: r.op, payload: r.payload)
        } catch {
            finish(r, .failure(WireFailure(errno: EINVAL, message: "cannot encode \(r.op.name)")))
            return
        }
        r.payload = nil // the frame holds the bytes now; do not keep two copies
        guard let conn = currentConnection() else {
            finish(r, .failure(WireFailure(errno: EIO, message: "client closed")))
            return
        }
        let message = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_string(message, "mount", mountID)
        frame.withUnsafeBytes { raw in
            xpc_dictionary_set_data(message, "frame", raw.baseAddress!, raw.count)
        }
        queue.asyncAfter(deadline: .now() + r.timeout) { [weak self] in
            self?.finish(r, .failure(WireFailure(
                errno: EIO, message: "\(r.op.name) \(r.id) passed its \(Int(r.timeout)) s deadline")))
        }
        xpc_connection_send_message_with_reply(conn, message, queue) { [weak self] reply in
            guard let self else { return }
            self.finish(r, self.decode(reply, for: r))
        }
    }

    private func decode(_ reply: xpc_object_t, for r: Request) -> Result<WireResponse, WireFailure> {
        guard xpc_get_type(reply) == XPC_TYPE_DICTIONARY else {
            return .failure(WireFailure(errno: EIO, message: "broker unavailable: \(String(describing: reply))"))
        }
        if let cMessage = xpc_dictionary_get_string(reply, "message") {
            let code = xpc_dictionary_get_int64(reply, "error")
            return .failure(WireFailure(errno: EIO, message: "broker error \(code): \(String(cString: cMessage))"))
        }
        var length = 0
        guard let bytes = xpc_dictionary_get_data(reply, "frame", &length) else {
            return .failure(WireFailure(errno: EIO, message: "broker reply had no frame"))
        }
        do {
            let response = try decodeFrame(Data(bytes: bytes, count: length))
            guard response.reply.id == r.id else {
                return .failure(WireFailure(errno: EIO, message: "reply id \(response.reply.id) for request \(r.id)"))
            }
            if response.reply.errno != 0 {
                let detail = response.reply.message.map { ": \($0)" } ?? ""
                return .failure(WireFailure(errno: response.reply.errno,
                                            message: "\(r.op.name): errno \(response.reply.errno)\(detail)"))
            }
            return .success(response)
        } catch {
            return .failure(WireFailure(errno: EIO, message: "bad reply frame: \(error)"))
        }
    }

    /// Completes a request once (reply or deadline, whichever comes first)
    /// and starts the next queued one.
    private func finish(_ r: Request, _ result: Result<WireResponse, WireFailure>, counted: Bool = true) {
        let (first, next): (Bool, Request?) = lock.withLock {
            if r.done { return (false, nil) }
            r.done = true
            guard counted else { return (true, nil) }
            if waitingHead < waiting.count {
                let n = waiting[waitingHead]
                waitingHead += 1
                if waitingHead > 256 && waitingHead * 2 > waiting.count {
                    waiting.removeFirst(waitingHead)
                    waitingHead = 0
                }
                n.started = true
                return (true, n) // the slot passes straight to the next request
            }
            inFlight -= 1
            return (true, nil)
        }
        guard first else { return } // the deadline or the reply already won
        if case let .failure(failure) = result, failure.errno == EIO {
            log.error("\(failure.message, privacy: .public)")
        }
        r.completion(result)
        if let next { start(next) }
    }
}
