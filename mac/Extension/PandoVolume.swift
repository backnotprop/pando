// PandoVolume.swift: the volume. Each FSKit operation becomes one wire v3
// request to the mount's daemon (see Wire.swift and the contract,
// docs/pando-fskit-wire-v3.md in the ArtifactFS fork). The volume keeps no
// file system state beyond the FSItem objects FSKit holds and the items'
// extended attributes, which live in memory only.
//
// FSKit delivers operations on one serial queue (Apple DTS, 2026-10-01), so
// no method here blocks: each sends its request and returns, and the reply
// handler runs when the daemon answers, on the client's concurrent queue.
// Requests in flight are capped and each has a deadline (WireClient.swift).
//
// Derived from Oak's OakFSVolume.swift (Apache 2.0, see ../NOTICE). The
// message path is rewritten for wire version 3.

import FSKit
import Foundation
import os

final class PandoVolume: FSVolume, @unchecked Sendable {
    private let client: WireClient
    private let maxRead: Int
    private let maxWrite: Int
    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "pando", category: "volume")
    /// The owning file system, so activation can move the container between
    /// ready and active. Weak: FSKit owns the volume.
    private weak var fileSystem: PandoFileSystem?

    /// FSKit expects the same FSItem object for the same file while it holds
    /// it; this cache gives it that. Entries leave in reclaimItem.
    private let lock = NSLock()
    private var items: [UInt64: PandoItem] = [:]
    private let root: PandoItem

    /// Reclaimed numbers waiting to go to the daemon in one `forget`.
    private var forgets: [UInt64] = []
    private var forgetScheduled = false
    private static let forgetBatch = 128
    private static let forgetDelay: TimeInterval = 0.05

    /// Entries asked for per readdir page.
    private static let pageEntries: UInt32 = 256

    /// Extended attributes, by item number, held in this process only. With
    /// no xattr support macOS writes every xattr (com.apple.provenance on
    /// each new file, Finder's info, quarantine) as an AppleDouble "._" file
    /// through the mount, and git, npm and agents then see those files. They
    /// are lost when the volume unmounts; nothing in a repo needs them.
    private var xattrs: [UInt64: [Data: Data]] = [:]
    private static let maxXattrSize = 1 << 20

    init(client: WireClient, hello: WireReply, volumeName: String, fileSystem: PandoFileSystem) {
        self.client = client
        // The daemon sends 8 MiB for both today; 1 MiB if it ever leaves them out.
        self.maxRead = max(4096, Int(hello.max_read ?? 1 << 20))
        self.maxWrite = max(4096, Int(hello.max_write ?? 1 << 20))
        self.fileSystem = fileSystem
        self.root = PandoItem(ino: kRootIno, kind: .dir, name: FSFileName(string: ""))
        super.init(volumeID: FSVolume.Identifier(uuid: UUID()), volumeName: FSFileName(string: volumeName))
        items[kRootIno] = root
    }

    // MARK: - Helpers

    /// The cached item for an inode, made if new.
    private func item(for a: WireAttr, name: FSFileName) -> PandoItem {
        if a.ino != kRootIno && a.ino < 3 {
            log.error("daemon sent inode \(a.ino) for '\(name.string ?? "?", privacy: .public)'; numbers below 3 are reserved by FSKit")
        }
        let it: PandoItem = lock.withLock {
            if let existing = items[a.ino] { return existing }
            let made = PandoItem(ino: a.ino, kind: a.wireKind, name: name)
            items[a.ino] = made
            return made
        }
        it.kind = a.wireKind
        return it
    }

    /// Queues a reclaimed number for the daemon; sends a batch when it is
    /// full or shortly after the first reclaim.
    private func queueForget(_ ino: UInt64) {
        var batch: [UInt64] = []
        var schedule = false
        lock.withLock {
            forgets.append(ino)
            if forgets.count >= Self.forgetBatch {
                batch = forgets
                forgets = []
            } else if !forgetScheduled {
                forgetScheduled = true
                schedule = true
            }
        }
        if !batch.isEmpty { sendForget(batch) }
        if schedule {
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + Self.forgetDelay) { [weak self] in
                guard let self else { return }
                let batch: [UInt64] = self.lock.withLock {
                    self.forgetScheduled = false
                    let b = self.forgets
                    self.forgets = []
                    return b
                }
                if !batch.isEmpty { self.sendForget(batch) }
            }
        }
    }

    private func sendForget(_ inos: [UInt64]) {
        // The reply is always errno 0 (contract, 4.3); nothing waits on it.
        client.call(.forget(inos: inos), timeout: WireDeadline.metadata) { _ in }
    }

    private func posix(_ code: Int32) -> Error { fs_errorForPOSIXError(code) }

    private func error(_ failure: WireFailure) -> Error { fs_errorForPOSIXError(failure.errno) }
}

// MARK: - FSVolume.Operations

extension PandoVolume: FSVolume.Operations {
    var supportedVolumeCapabilities: FSVolume.SupportedCapabilities {
        let caps = FSVolume.SupportedCapabilities()
        caps.supportsHardLinks = false
        caps.supportsSymbolicLinks = true
        // Inode numbers do not survive a remount, and the daemon cannot look
        // an item up by its number alone.
        caps.supportsPersistentObjectIDs = false
        caps.supports64BitObjectIDs = true
        caps.supportsFastStatFS = true
        caps.caseFormat = .sensitive
        return caps
    }

    var volumeStatistics: FSStatFSResult {
        // A lazy mount has no real capacity; report a large nominal one so
        // Finder does not refuse to copy files in.
        let r = FSStatFSResult(fileSystemTypeName: "pando")
        r.blockSize = 4096
        r.ioSize = min(maxRead, 1 << 20)
        r.totalBytes = 1 << 42
        r.availableBytes = 1 << 41
        r.freeBytes = 1 << 41
        r.usedBytes = 1 << 41
        return r
    }

    func activate(options: FSTaskOptions, replyHandler: @escaping (FSItem?, Error?) -> Void) {
        // The single volume is live: the container goes from ready to active.
        fileSystem?.containerStatus = .active
        replyHandler(root, nil)
    }

    func deactivate(options: FSDeactivateOptions, replyHandler: @escaping (Error?) -> Void) {
        fileSystem?.containerStatus = .ready
        client.close()
        replyHandler(nil)
    }

    func mount(options: FSTaskOptions, replyHandler: @escaping (Error?) -> Void) {
        replyHandler(nil)
    }

    func unmount(replyHandler: @escaping () -> Void) {
        client.close()
        replyHandler()
    }

    func synchronize(flags: FSSyncFlags, replyHandler: @escaping (Error?) -> Void) {
        // Writes reach the daemon's overlay synchronously; nothing is cached
        // here. (FSKit does not call this on path URL volumes anyway.)
        replyHandler(nil)
    }

    func getAttributes(
        _ desired: FSItem.GetAttributesRequest,
        of item: FSItem,
        replyHandler: @escaping (FSItem.Attributes?, Error?) -> Void
    ) {
        guard let it = item as? PandoItem else { replyHandler(nil, posix(EINVAL)); return }
        client.call(.getattr(ino: it.ino), timeout: WireDeadline.metadata) { [self] result in
            switch result {
            case let .success(r):
                guard let a = r.reply.attr else { replyHandler(nil, posix(EIO)); return }
                it.kind = a.wireKind
                replyHandler(ItemAttributes.from(a), nil)
            case let .failure(f):
                replyHandler(nil, error(f))
            }
        }
    }

    func lookupItem(
        named name: FSFileName,
        inDirectory directory: FSItem,
        replyHandler: @escaping (FSItem?, FSFileName?, Error?) -> Void
    ) {
        guard let dir = directory as? PandoItem, let nameStr = name.string else {
            replyHandler(nil, nil, posix(EINVAL)); return
        }
        client.call(.lookup(parent: dir.ino, name: nameStr), timeout: WireDeadline.metadata) { [self] result in
            switch result {
            case let .success(r):
                guard let a = r.reply.attr else { replyHandler(nil, nil, posix(EIO)); return }
                replyHandler(item(for: a, name: name), name, nil)
            case let .failure(f):
                replyHandler(nil, nil, error(f))
            }
        }
    }

    func reclaimItem(_ item: FSItem, replyHandler: @escaping (Error?) -> Void) {
        // FSKit no longer holds this item. Drop it here and tell the daemon,
        // which can then free a removed file's bytes (unlink while open).
        if let it = item as? PandoItem, it !== root {
            lock.withLock { if items[it.ino] === it { items[it.ino] = nil } }
            queueForget(it.ino)
        }
        replyHandler(nil)
    }

    func enumerateDirectory(
        _ directory: FSItem,
        startingAt cookie: FSDirectoryCookie,
        verifier: FSDirectoryVerifier,
        attributes: FSItem.GetAttributesRequest?,
        packer: FSDirectoryEntryPacker,
        replyHandler: @escaping (FSDirectoryVerifier, Error?) -> Void
    ) {
        guard let dir = directory as? PandoItem else {
            replyHandler(verifier, posix(EINVAL)); return
        }
        // Cookies (positions in [".", "..", children...]) and the verifier
        // belong to the daemon; they pass through (contract, 4.4).
        listPage(dir, cookie: cookie.rawValue, verifier: verifier.rawValue,
                 withAttrs: attributes != nil, packer: packer, packedAny: false,
                 replyHandler: replyHandler)
    }

    /// Packs one page of a listing, then asks for the next while the
    /// daemon has more and FSKit's buffer still has room.
    private func listPage(
        _ dir: PandoItem, cookie: UInt64, verifier: UInt64, withAttrs: Bool,
        packer: FSDirectoryEntryPacker, packedAny: Bool,
        replyHandler: @escaping (FSDirectoryVerifier, Error?) -> Void
    ) {
        let op = WireOp.readdir(ino: dir.ino, cookie: cookie, verifier: verifier,
                                maxEntries: Self.pageEntries, withAttrs: withAttrs)
        client.call(op, timeout: WireDeadline.metadata) { [self] result in
            switch result {
            case let .success(r):
                var packed = packedAny
                var full = false
                var nextCookie = cookie
                for e in r.reply.entries ?? [] {
                    // FSKit: no "." and ".." when attributes were asked for.
                    // The daemon already leaves them out then; plain listings
                    // carry them as the daemon sent them.
                    if withAttrs && (e.name == "." || e.name == "..") { continue }
                    var entryAttrs: FSItem.Attributes?
                    if withAttrs {
                        entryAttrs = e.attr.map { ItemAttributes.from($0, parent: dir.ino) }
                            ?? ItemAttributes.minimal(ino: e.ino, kind: e.wireKind)
                    }
                    let ok = packer.packEntry(
                        name: FSFileName(string: e.name),
                        itemType: e.wireKind.fsItemType,
                        itemID: fsID(e.ino),
                        nextCookie: FSDirectoryCookie(rawValue: e.next_cookie),
                        attributes: entryAttrs)
                    if !ok {
                        if !packed {
                            log.error("FSKit refused the first entry '\(e.name, privacy: .public)' of directory \(dir.ino)")
                            replyHandler(FSDirectoryVerifier(rawValue: verifier), posix(EINVAL)); return
                        }
                        full = true // FSKit asks again from the last packed cookie
                        break
                    }
                    packed = true
                    nextCookie = e.next_cookie
                }
                let current = r.reply.verifier ?? verifier
                if !full && r.reply.eof == false && nextCookie != cookie {
                    listPage(dir, cookie: nextCookie, verifier: current, withAttrs: withAttrs,
                             packer: packer, packedAny: packed, replyHandler: replyHandler)
                } else {
                    replyHandler(FSDirectoryVerifier(rawValue: current), nil)
                }
            case let .failure(f):
                if packedAny {
                    // Earlier pages of this call were packed; return them. The
                    // next call starts from the last cookie and meets the error.
                    replyHandler(FSDirectoryVerifier(rawValue: verifier), nil)
                } else if f.errno == kErrBadCookie {
                    replyHandler(FSDirectoryVerifier(rawValue: verifier), FSError(.invalidDirectoryCookie))
                } else {
                    replyHandler(FSDirectoryVerifier(rawValue: verifier), error(f))
                }
            }
        }
    }

    func createItem(
        named name: FSFileName,
        type: FSItem.ItemType,
        inDirectory directory: FSItem,
        attributes: FSItem.SetAttributesRequest,
        replyHandler: @escaping (FSItem?, FSFileName?, Error?) -> Void
    ) {
        guard let dir = directory as? PandoItem, let nameStr = name.string else {
            replyHandler(nil, nil, posix(EINVAL)); return
        }
        let mode = attributes.isValid(.mode) ? attributes.mode & 0o7777 : nil
        let op: WireOp
        switch type {
        case .file:
            op = .create(parent: dir.ino, name: nameStr, mode: mode ?? 0o644)
        case .directory:
            op = .mkdir(parent: dir.ino, name: nameStr, mode: mode ?? 0o755)
        default:
            // FIFOs, sockets and devices have no place in a worktree.
            replyHandler(nil, nil, posix(ENOTSUP)); return
        }
        // The daemon must answer EEXIST when the name exists (O_EXCL and
        // mkdir locks depend on it); FSKit has no O_EXCL flag of its own.
        client.call(op, timeout: WireDeadline.metadata) { [self] result in
            switch result {
            case let .success(r):
                guard let a = r.reply.attr else { replyHandler(nil, nil, posix(EIO)); return }
                if mode != nil { attributes.consumedAttributes.insert(.mode) }
                replyHandler(item(for: a, name: name), name, nil)
            case let .failure(f):
                replyHandler(nil, nil, error(f))
            }
        }
    }

    func createSymbolicLink(
        named name: FSFileName,
        inDirectory directory: FSItem,
        attributes: FSItem.SetAttributesRequest,
        linkContents contents: FSFileName,
        replyHandler: @escaping (FSItem?, FSFileName?, Error?) -> Void
    ) {
        guard let dir = directory as? PandoItem, let nameStr = name.string,
              let target = contents.string else {
            replyHandler(nil, nil, posix(EINVAL)); return
        }
        client.call(.symlink(parent: dir.ino, name: nameStr, target: target),
                    timeout: WireDeadline.metadata) { [self] result in
            switch result {
            case let .success(r):
                guard let a = r.reply.attr else { replyHandler(nil, nil, posix(EIO)); return }
                replyHandler(item(for: a, name: name), name, nil)
            case let .failure(f):
                replyHandler(nil, nil, error(f))
            }
        }
    }

    func createLink(
        to item: FSItem,
        named name: FSFileName,
        inDirectory directory: FSItem,
        replyHandler: @escaping (FSFileName?, Error?) -> Void
    ) {
        // No hard links in a worktree mount (supportsHardLinks = false).
        replyHandler(nil, posix(ENOTSUP))
    }

    func removeItem(
        _ item: FSItem,
        named name: FSFileName,
        fromDirectory directory: FSItem,
        replyHandler: @escaping (Error?) -> Void
    ) {
        guard let dir = directory as? PandoItem, let it = item as? PandoItem,
              let nameStr = name.string else {
            replyHandler(posix(EINVAL)); return
        }
        // The item's kind is remembered, so no getattr first. The daemon
        // removes the name now and keeps the bytes until `forget`.
        let op: WireOp = it.kind == .dir
            ? .rmdir(parent: dir.ino, name: nameStr)
            : .unlink(parent: dir.ino, name: nameStr)
        client.call(op, timeout: WireDeadline.metadata) { [self] result in
            switch result {
            case .success:
                // The daemon may give the number to a new file later.
                lock.withLock { xattrs[it.ino] = nil }
                replyHandler(nil)
            case let .failure(f): replyHandler(error(f))
            }
        }
    }

    func renameItem(
        _ item: FSItem,
        inDirectory sourceDirectory: FSItem,
        named sourceName: FSFileName,
        to destinationName: FSFileName,
        inDirectory destinationDirectory: FSItem,
        overItem: FSItem?,
        replyHandler: @escaping (FSFileName?, Error?) -> Void
    ) {
        guard let src = sourceDirectory as? PandoItem, let dst = destinationDirectory as? PandoItem,
              let srcName = sourceName.string, let dstName = destinationName.string else {
            replyHandler(nil, posix(EINVAL)); return
        }
        // The daemon replaces an existing destination atomically; overItem
        // is then reclaimed by FSKit, which sends its forget.
        client.call(.rename(parent: src.ino, name: srcName, newparent: dst.ino, newname: dstName),
                    timeout: WireDeadline.metadata) { [self] result in
            switch result {
            case .success:
                (item as? PandoItem)?.name = destinationName
                if let over = overItem as? PandoItem {
                    lock.withLock { xattrs[over.ino] = nil }
                }
                replyHandler(destinationName, nil)
            case let .failure(f):
                replyHandler(nil, error(f))
            }
        }
    }

    func setAttributes(
        _ request: FSItem.SetAttributesRequest,
        on item: FSItem,
        replyHandler: @escaping (FSItem.Attributes?, Error?) -> Void
    ) {
        guard let it = item as? PandoItem else { replyHandler(nil, posix(EINVAL)); return }
        // Size, mode and times go to the daemon. uid, gid and flags are not
        // consumed; FSKit's upper layers handle what a volume leaves alone.
        let size = request.isValid(.size) ? request.size : nil
        let mode = request.isValid(.mode) ? request.mode & 0o7777 : nil
        let mtime = request.isValid(.modifyTime) ? nanoseconds(request.modifyTime) : nil
        let atime = request.isValid(.accessTime) ? nanoseconds(request.accessTime) : nil
        guard size != nil || mode != nil || mtime != nil || atime != nil else {
            // Nothing this volume sets: answer with the current attributes.
            getAttributes(FSItem.GetAttributesRequest(), of: item, replyHandler: replyHandler)
            return
        }
        let timeout = size != nil ? WireDeadline.data : WireDeadline.metadata
        client.call(.setattr(ino: it.ino, size: size, mode: mode, mtimeNs: mtime, atimeNs: atime),
                    timeout: timeout) { [self] result in
            switch result {
            case let .success(r):
                guard let a = r.reply.attr else { replyHandler(nil, posix(EIO)); return }
                // Report what the daemon applied (atime never is: mounts are
                // noatime). With no list, assume everything sent was applied.
                var consumed: FSItem.Attribute = []
                let applied = r.reply.consumed
                func took(_ key: String, _ sent: Bool) -> Bool { sent && (applied?.contains(key) ?? true) }
                if took("size", size != nil) { consumed.insert(.size) }
                if took("mode", mode != nil) { consumed.insert(.mode) }
                if took("mtime", mtime != nil) { consumed.insert(.modifyTime) }
                if took("atime", atime != nil) { consumed.insert(.accessTime) }
                request.consumedAttributes = consumed
                replyHandler(ItemAttributes.from(a), nil)
            case let .failure(f):
                replyHandler(nil, error(f))
            }
        }
    }

    func readSymbolicLink(
        _ item: FSItem,
        replyHandler: @escaping (FSFileName?, Error?) -> Void
    ) {
        guard let it = item as? PandoItem else { replyHandler(nil, posix(EINVAL)); return }
        client.call(.readlink(ino: it.ino), timeout: WireDeadline.metadata) { [self] result in
            switch result {
            case let .success(r):
                guard let target = r.reply.target else { replyHandler(nil, posix(EIO)); return }
                replyHandler(FSFileName(string: target), nil)
            case let .failure(f):
                replyHandler(nil, error(f))
            }
        }
    }
}

// MARK: - FSVolume.ReadWriteOperations

extension PandoVolume: FSVolume.ReadWriteOperations {
    func read(
        from item: FSItem,
        at offset: off_t,
        length: Int,
        into buffer: FSMutableFileDataBuffer,
        replyHandler: @escaping (Int, Error?) -> Void
    ) {
        guard let it = item as? PandoItem else { replyHandler(0, posix(EINVAL)); return }
        let want = min(length, buffer.length)
        readChunk(it.ino, offset: Int64(offset), filled: 0, want: want, buffer: buffer, replyHandler: replyHandler)
    }

    /// Reads in pieces of at most max_read bytes until `want` bytes arrived
    /// or a short reply marks the end of the file.
    private func readChunk(_ ino: UInt64, offset: Int64, filled: Int, want: Int,
                           buffer: FSMutableFileDataBuffer,
                           replyHandler: @escaping (Int, Error?) -> Void) {
        let size = min(want - filled, maxRead)
        guard size > 0 else { replyHandler(filled, nil); return }
        client.call(.read(ino: ino, offset: offset + Int64(filled), size: UInt32(size)),
                    timeout: WireDeadline.data) { [self] result in
            switch result {
            case let .success(r):
                let n = min(r.payload.count, size)
                buffer.withUnsafeMutableBytes { dst in
                    r.payload.withUnsafeBytes { src in
                        (dst.baseAddress! + filled).copyMemory(from: src.baseAddress!, byteCount: n)
                    }
                }
                if n < size {
                    replyHandler(filled + n, nil) // end of file
                } else {
                    readChunk(ino, offset: offset, filled: filled + n, want: want,
                              buffer: buffer, replyHandler: replyHandler)
                }
            case let .failure(f):
                // Bytes already read still count; report the error only if none.
                if filled > 0 { replyHandler(filled, nil) } else { replyHandler(0, error(f)) }
            }
        }
    }

    func write(
        contents data: Data,
        to item: FSItem,
        at offset: off_t,
        replyHandler: @escaping (Int, Error?) -> Void
    ) {
        guard let it = item as? PandoItem else { replyHandler(0, posix(EINVAL)); return }
        writeChunk(it.ino, data: data, offset: Int64(offset), done: 0, replyHandler: replyHandler)
    }

    /// Writes in pieces of at most max_write bytes, in order.
    private func writeChunk(_ ino: UInt64, data: Data, offset: Int64, done: Int,
                            replyHandler: @escaping (Int, Error?) -> Void) {
        let size = min(data.count - done, maxWrite)
        guard size > 0 else { replyHandler(done, nil); return }
        let start = data.startIndex + done
        let piece = data.subdata(in: start..<(start + size))
        client.call(.write(ino: ino, offset: offset + Int64(done)), payload: piece,
                    timeout: WireDeadline.data) { [self] result in
            switch result {
            case let .success(r):
                let n = Int(r.reply.written ?? 0)
                if n < size || done + n >= data.count {
                    replyHandler(done + n, nil)
                } else {
                    writeChunk(ino, data: data, offset: offset, done: done + n, replyHandler: replyHandler)
                }
            case let .failure(f):
                if done > 0 { replyHandler(done, nil) } else { replyHandler(0, error(f)) }
            }
        }
    }
}

// MARK: - FSVolume.PathConfOperations

extension PandoVolume: FSVolume.PathConfOperations {
    var maximumLinkCount: Int { 1 }
    var maximumNameLength: Int { 255 }
    /// chown is not supported, so ownership changes are restricted.
    var restrictsOwnershipChanges: Bool { true }
    /// Long names fail with ENAMETOOLONG rather than being cut.
    var truncatesLongNames: Bool { false }
    var maximumFileSize: UInt64 { UInt64(Int64.max) }
    var maximumXattrSize: Int { Self.maxXattrSize }
}

// MARK: - FSVolume.XattrOperations

/// Full xattr support, from memory (see `xattrs`): FSKit sends every name
/// here, so the kernel never falls back to "._" files on the volume.
extension PandoVolume: FSVolume.XattrOperations {
    func getXattr(named name: FSFileName, of item: FSItem,
                  replyHandler: @escaping (Data?, Error?) -> Void) {
        guard let it = item as? PandoItem else { replyHandler(nil, posix(EINVAL)); return }
        if let value = lock.withLock({ xattrs[it.ino]?[name.data] }) {
            replyHandler(value, nil)
        } else {
            replyHandler(nil, posix(ENOATTR))
        }
    }

    func setXattr(named name: FSFileName, to value: Data?, on item: FSItem,
                  policy: FSVolume.SetXattrPolicy, replyHandler: @escaping (Error?) -> Void) {
        guard let it = item as? PandoItem else { replyHandler(posix(EINVAL)); return }
        if policy != .delete, (value?.count ?? 0) > Self.maxXattrSize {
            replyHandler(posix(E2BIG)); return
        }
        let code: Int32 = lock.withLock {
            let exists = xattrs[it.ino]?[name.data] != nil
            switch policy {
            case .delete:
                guard exists else { return ENOATTR }
                xattrs[it.ino]?[name.data] = nil
                if xattrs[it.ino]?.isEmpty == true { xattrs[it.ino] = nil }
                return 0
            case .mustCreate where exists:
                return EEXIST
            case .mustReplace where !exists:
                return ENOATTR
            default:
                guard let value else { return EINVAL }
                xattrs[it.ino, default: [:]][name.data] = value
                return 0
            }
        }
        replyHandler(code == 0 ? nil : posix(code))
    }

    func listXattrs(of item: FSItem, replyHandler: @escaping ([FSFileName]?, Error?) -> Void) {
        guard let it = item as? PandoItem else { replyHandler(nil, posix(EINVAL)); return }
        let names = lock.withLock { xattrs[it.ino].map { Array($0.keys) } ?? [] }
        replyHandler(names.map { FSFileName(data: $0) }, nil)
    }
}
