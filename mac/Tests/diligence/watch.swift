// Test 7 and 8 watcher: reports, in ms since a start mark, when (a) FSEvents
// reports a path under the mount, and (b) kqueue fires on an open file (how
// editors notice a change on disk). Usage: watch <mount> <file> <seconds>
// The start mark is the first line read from stdin (epoch ms), so the
// caller can start the clock right when it moves HEAD.
import CoreServices
import Foundation

let args = CommandLine.arguments
let mount = args[1], file = args[2]
let seconds = Double(args[3]) ?? 60
func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
var start = nowMs()
let out = FileHandle.standardOutput
func say(_ s: String) { out.write((s + "\n").data(using: .utf8)!) }

let cb: FSEventStreamCallback = { _, _, n, paths, flags, _ in
    let ps = unsafeBitCast(paths, to: NSArray.self) as! [String]
    for i in 0..<n {
        say(String(format: "fsevents %.0f ms %@ flags 0x%x", nowMs() - start, ps[i], flags[i]))
    }
}
let stream = FSEventStreamCreate(nil, cb, nil, [mount] as CFArray,
    FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.0,
    FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagUseCFTypes))!
FSEventStreamSetDispatchQueue(stream, DispatchQueue(label: "fsevents"))
FSEventStreamStart(stream)

let fd = open(file, O_EVTONLY)
let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd,
    eventMask: [.write, .extend, .attrib, .delete, .rename, .link, .revoke], queue: DispatchQueue(label: "kq"))
src.setEventHandler { say(String(format: "kqueue %.0f ms on %@ mask 0x%lx", nowMs() - start, file, src.data.rawValue)) }
src.resume()

say("ready")
DispatchQueue.global().async {
    if let line = readLine(), let t = Double(line) { start = t; say("start") }
}
Thread.sleep(forTimeInterval: seconds)
