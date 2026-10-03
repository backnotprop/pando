// Wire.swift: Pando's FSKit wire, version 3, as the extension speaks it.
//
// The contract is owned by the fskit lane, in the ArtifactFS fork:
// docs/pando-fskit-wire-v3.md (matched against commit 7bd0156). Section
// numbers below ("contract, 4.4") refer to it.
//
// Frame, identical on both hops (extension to broker over XPC, broker to
// daemon over the unix socket):
//
//     u32 BE  frame_len   bytes after this field
//     u32 BE  header_len
//     [header_len]        UTF-8 JSON object
//     [rest]              raw payload: file bytes for `read` replies and
//                         `write` requests, empty otherwise
//
// Request header: {"id": u64, "op": "<name>", ...fields}
// Reply header:   {"id": u64, "errno": i32 (0 = ok), ...result}
//
// No FSKit here, so the harness in ../Tests can run it outside the extension.
//
// Derived from Oak's Wire.swift (Apache 2.0, see ../NOTICE); version 3 is a
// new format.

import Foundation

/// The wire version this extension speaks. `hello` must report the same.
let kWireVersion: UInt32 = 3

/// The root directory's number on the wire: FSKit's `.rootDirectory`. Every
/// other item is 3 or more; ".." of the root is 1, `.parentOfRoot`.
let kRootIno: UInt64 = 2

/// readdir's errno for a cookie that no longer matches the listing (a wire
/// code, NFS's NFSERR_BAD_COOKIE; contract, 4.4).
let kErrBadCookie: Int32 = 10003

enum WireKind: UInt8, Sendable {
    case dir = 0
    case file = 1
    case symlink = 2
}

/// One file operation, as a request header. Field names are the JSON keys.
enum WireOp: Sendable {
    case hello(build: String)
    case lookup(parent: UInt64, name: String)
    case getattr(ino: UInt64)
    case readdir(ino: UInt64, cookie: UInt64, verifier: UInt64, maxEntries: UInt32, withAttrs: Bool)
    case read(ino: UInt64, offset: Int64, size: UInt32)
    /// The bytes travel as the frame's payload.
    case write(ino: UInt64, offset: Int64)
    case readlink(ino: UInt64)
    case create(parent: UInt64, name: String, mode: UInt32)
    case mkdir(parent: UInt64, name: String, mode: UInt32)
    case symlink(parent: UInt64, name: String, target: String)
    case unlink(parent: UInt64, name: String)
    case rmdir(parent: UInt64, name: String)
    case rename(parent: UInt64, name: String, newparent: UInt64, newname: String)
    /// Only the fields present are changed. uid and gid are never sent.
    case setattr(ino: UInt64, size: UInt64?, mode: UInt32?, mtimeNs: Int64?, atimeNs: Int64?)
    /// Items FSKit reclaimed, batched. The daemon frees removed items and
    /// only notes the rest; numbers stay with their paths (contract, 4.3).
    case forget(inos: [UInt64])

    var name: String {
        switch self {
        case .hello: "hello"
        case .lookup: "lookup"
        case .getattr: "getattr"
        case .readdir: "readdir"
        case .read: "read"
        case .write: "write"
        case .readlink: "readlink"
        case .create: "create"
        case .mkdir: "mkdir"
        case .symlink: "symlink"
        case .unlink: "unlink"
        case .rmdir: "rmdir"
        case .rename: "rename"
        case .setattr: "setattr"
        case .forget: "forget"
        }
    }
}

/// The request header: `id`, `op`, then the op's own fields.
private struct RequestHeader: Encodable {
    let id: UInt64
    let op: WireOp

    private enum Key: String, CodingKey {
        case id, op, version, build, parent, name, ino, cookie, verifier
        case max_entries, with_attrs, offset, size, mode, target
        case newparent, newname, mtime_ns, atime_ns, inos
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(id, forKey: .id)
        try c.encode(op.name, forKey: .op)
        switch op {
        case let .hello(build):
            try c.encode(kWireVersion, forKey: .version)
            try c.encode(build, forKey: .build)
        case let .lookup(parent, name), let .unlink(parent, name), let .rmdir(parent, name):
            try c.encode(parent, forKey: .parent)
            try c.encode(name, forKey: .name)
        case let .getattr(ino), let .readlink(ino):
            try c.encode(ino, forKey: .ino)
        case let .readdir(ino, cookie, verifier, maxEntries, withAttrs):
            try c.encode(ino, forKey: .ino)
            try c.encode(cookie, forKey: .cookie)
            try c.encode(verifier, forKey: .verifier)
            try c.encode(maxEntries, forKey: .max_entries)
            try c.encode(withAttrs, forKey: .with_attrs)
        case let .read(ino, offset, size):
            try c.encode(ino, forKey: .ino)
            try c.encode(offset, forKey: .offset)
            try c.encode(size, forKey: .size)
        case let .write(ino, offset):
            try c.encode(ino, forKey: .ino)
            try c.encode(offset, forKey: .offset)
        case let .create(parent, name, mode), let .mkdir(parent, name, mode):
            try c.encode(parent, forKey: .parent)
            try c.encode(name, forKey: .name)
            try c.encode(mode, forKey: .mode)
        case let .symlink(parent, name, target):
            try c.encode(parent, forKey: .parent)
            try c.encode(name, forKey: .name)
            try c.encode(target, forKey: .target)
        case let .rename(parent, name, newparent, newname):
            try c.encode(parent, forKey: .parent)
            try c.encode(name, forKey: .name)
            try c.encode(newparent, forKey: .newparent)
            try c.encode(newname, forKey: .newname)
        case let .setattr(ino, size, mode, mtimeNs, atimeNs):
            try c.encode(ino, forKey: .ino)
            try c.encodeIfPresent(size, forKey: .size)
            try c.encodeIfPresent(mode, forKey: .mode)
            try c.encodeIfPresent(mtimeNs, forKey: .mtime_ns)
            try c.encodeIfPresent(atimeNs, forKey: .atime_ns)
        case let .forget(inos):
            try c.encode(inos, forKey: .inos)
        }
    }
}

/// The attribute record: `{ino, kind, mode, size, mtime_ns, ctime_ns}`.
struct WireAttr: Decodable, Sendable {
    let ino: UInt64
    let kind: UInt8
    /// Permission bits, 0o7777.
    let mode: UInt32
    let size: UInt64
    let mtime_ns: Int64
    let ctime_ns: Int64

    var wireKind: WireKind { WireKind(rawValue: kind) ?? .file }
}

/// One `readdir` entry. `attr` is present when the request had `with_attrs`
/// (then "." and ".." never appear); `next_cookie` is its position + 1.
struct WireDirEntry: Decodable, Sendable {
    let name: String
    let ino: UInt64
    let kind: UInt8
    let next_cookie: UInt64
    let attr: WireAttr?

    var wireKind: WireKind { WireKind(rawValue: kind) ?? .file }
}

/// A reply header. `id` and `errno` are always present; the rest depends on
/// the op, so every other field is optional.
struct WireReply: Decodable, Sendable {
    let id: UInt64
    let errno: Int32
    /// Set by the broker on the frames it makes itself (no daemon, bad mount
    /// id); unknown fields are ignored, so the daemon is unaffected.
    let message: String?
    // hello
    let version: UInt32?
    let build: String?
    let max_read: UInt32?
    let max_write: UInt32?
    // lookup, getattr, create, mkdir, symlink, setattr
    let attr: WireAttr?
    // readdir
    let entries: [WireDirEntry]?
    let verifier: UInt64?
    let eof: Bool?
    // readlink
    let target: String?
    // write: bytes written and the file's size after the write
    let written: UInt32?
    let size: UInt64?
    // setattr: which of "size", "mode", "mtime", "atime" were applied
    let consumed: [String]?
}

/// A decoded reply: the header and the raw payload.
struct WireResponse: Sendable {
    let reply: WireReply
    let payload: Data
}

enum WireFrameError: Error {
    case malformed(String)
}

/// Encodes one request frame.
func encodeFrame(id: UInt64, op: WireOp, payload: Data?) throws -> Data {
    let header = try JSONEncoder().encode(RequestHeader(id: id, op: op))
    let payloadCount = payload?.count ?? 0
    let frameLen = 4 + header.count + payloadCount
    guard frameLen <= Int(UInt32.max) else { throw WireFrameError.malformed("frame too large") }
    var frame = Data(capacity: 4 + frameLen)
    withUnsafeBytes(of: UInt32(frameLen).bigEndian) { frame.append(contentsOf: $0) }
    withUnsafeBytes(of: UInt32(header.count).bigEndian) { frame.append(contentsOf: $0) }
    frame.append(header)
    if let payload { frame.append(payload) }
    return frame
}

/// Decodes one reply frame (with its 4-byte length prefix).
func decodeFrame(_ frame: Data) throws -> WireResponse {
    guard frame.count >= 8 else { throw WireFrameError.malformed("short frame") }
    let frameLen = frame.withUnsafeBytes { Int(UInt32(bigEndian: $0.loadUnaligned(as: UInt32.self))) }
    let headerLen = frame.withUnsafeBytes {
        Int(UInt32(bigEndian: $0.loadUnaligned(fromByteOffset: 4, as: UInt32.self)))
    }
    guard frameLen == frame.count - 4, 8 + headerLen <= frame.count else {
        throw WireFrameError.malformed("lengths do not match the frame")
    }
    let start = frame.startIndex
    let header = frame.subdata(in: (start + 8)..<(start + 8 + headerLen))
    let reply = try JSONDecoder().decode(WireReply.self, from: header)
    let payload = frame.subdata(in: (start + 8 + headerLen)..<frame.endIndex)
    return WireResponse(reply: reply, payload: payload)
}
