// PandoItem.swift: an FSItem backed by a daemon inode number, and the mapping
// from the wire's attribute record to FSKit's attributes.
//
// Rules from the wire contract (section 4.1) and the diligence (6.7):
// - The daemon numbers the root 2, FSKit's `.rootDirectory`, and every other
//   item 3 or more; the numbers are used as FSKit item ids unchanged. FSKit
//   reserves 0 (invalid), 1 (parent of root) and 2 (root).
// - linkCount is 1 for everything (no hard links), uid and gid are this
//   process's, atime equals mtime, birthTime equals ctime, and allocSize is
//   the size rounded up to 4096.
// - Times convert with integer arithmetic, never through a Double.
//
// Derived from Oak's OakFSItem.swift (Apache 2.0, see ../NOTICE).

import FSKit
import Foundation

final class PandoItem: FSItem, @unchecked Sendable {
    /// The daemon's inode number.
    let ino: UInt64
    private let lock = NSLock()
    private var _kind: WireKind
    private var _name: FSFileName

    init(ino: UInt64, kind: WireKind, name: FSFileName) {
        self.ino = ino
        self._kind = kind
        self._name = name
        super.init()
    }

    /// Remembered from lookup, create and getattr, so a remove needs no
    /// getattr to choose between unlink and rmdir.
    var kind: WireKind {
        get { lock.withLock { _kind } }
        set { lock.withLock { _kind = newValue } }
    }

    var name: FSFileName {
        get { lock.withLock { _name } }
        set { lock.withLock { _name = newValue } }
    }
}

extension WireKind {
    var fsItemType: FSItem.ItemType {
        switch self {
        case .dir: .directory
        case .file: .file
        case .symlink: .symlink
        }
    }
}

/// Converts nanoseconds since 1970 to a timespec without rounding through a
/// floating point value.
func timespecFromNanoseconds(_ ns: Int64) -> timespec {
    var sec = ns / 1_000_000_000
    var nsec = ns % 1_000_000_000
    if nsec < 0 { // floor for times before 1970
        sec -= 1
        nsec += 1_000_000_000
    }
    return timespec(tv_sec: Int(sec), tv_nsec: Int(nsec))
}

func nanoseconds(_ ts: timespec) -> Int64 {
    Int64(ts.tv_sec) * 1_000_000_000 + Int64(ts.tv_nsec)
}

/// The daemon's numbers are FSKit item ids unchanged (the root is 2).
func fsID(_ ino: UInt64) -> FSItem.Identifier {
    FSItem.Identifier(rawValue: ino) ?? .invalid
}

/// Builds FSKit attributes from wire records (contract, 4.1).
enum ItemAttributes {
    /// Fills FSKit attributes from a wire attribute record. `parent` is the
    /// containing directory's number when the caller knows it.
    static func from(_ a: WireAttr, parent: UInt64? = nil) -> FSItem.Attributes {
        let attrs = FSItem.Attributes()
        let kind = a.wireKind
        attrs.type = kind.fsItemType
        attrs.mode = a.mode & 0o7777
        attrs.linkCount = 1
        attrs.uid = getuid()
        attrs.gid = getgid()
        attrs.flags = 0
        attrs.size = a.size
        attrs.allocSize = (a.size + 4095) & ~UInt64(4095)
        attrs.fileID = fsID(a.ino)
        if a.ino == kRootIno {
            attrs.parentID = .parentOfRoot
        } else if let parent {
            attrs.parentID = fsID(parent)
        }
        let mtime = timespecFromNanoseconds(a.mtime_ns)
        let ctime = timespecFromNanoseconds(a.ctime_ns)
        attrs.modifyTime = mtime
        attrs.accessTime = mtime
        attrs.changeTime = ctime
        attrs.birthTime = ctime
        return attrs
    }

    /// Attributes for a listing entry the daemon sent without a record.
    /// Only reached if the daemon breaks the `with_attrs` rule.
    static func minimal(ino: UInt64, kind: WireKind) -> FSItem.Attributes {
        let attrs = FSItem.Attributes()
        attrs.type = kind.fsItemType
        attrs.mode = kind == .dir ? 0o755 : 0o644
        attrs.linkCount = 1
        attrs.uid = getuid()
        attrs.gid = getgid()
        attrs.fileID = fsID(ino)
        return attrs
    }
}
