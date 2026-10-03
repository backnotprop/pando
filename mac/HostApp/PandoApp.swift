// PandoApp.swift: the Pando host app.
//
// An FSKit extension cannot ship on its own; it lives inside an app bundle.
// This app carries the Pando file system extension (Contents/Extensions) and
// the broker (Contents/MacOS/pando-broker). Opening it once tells macOS the
// extension exists. Its window explains the one switch a person turns on, in
// System Settings, and shows whether it is on. Mounting is done by the
// `pando` command; this app does not need to stay open.
//
// Derived from Oak's OakMounterApp.swift (Apache 2.0, see ../NOTICE). The
// copy, colours and mark are Pando's.

import SwiftUI

@main
struct PandoApp: App {
    var body: some Scene {
        WindowGroup("Pando") {
            ContentView()
                .frame(width: 480, height: 560)
                .preferredColorScheme(.dark)
        }
        .windowResizability(.contentSize)
    }
}

// MARK: - Theme

/// The Pando brand's Night palette (art-ops brand handoff, section 2).
/// Foxfire is reserved for "a change reached this", so it is not used here.
private enum Theme {
    static let soil = Color(red: 0x0C / 255, green: 0x0F / 255, blue: 0x0C / 255)  // Night Soil, the ground
    static let loam = Color(red: 0x1A / 255, green: 0x1F / 255, blue: 0x18 / 255)  // Loam, surfaces
    static let bark = Color(red: 0xE6 / 255, green: 0xE0 / 255, blue: 0xD1 / 255)  // Moon Bark, type and buttons
    static let ash = Color(red: 0x7E / 255, green: 0x84 / 255, blue: 0x76 / 255)   // Hypha Ash, quiet labels
    static let barkSoft = bark.opacity(0.78)
    static let line = ash.opacity(0.35)

    /// SF Pro Text (the system face) for text, SF Mono for commands.
    static func text(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

// MARK: - Extension status

/// Whether macOS knows about the Pando file system extension, and whether the
/// switch in System Settings is on.
enum ExtensionStatus: Equatable {
    case checking
    case enabled
    case installedNotEnabled
    case notInstalled
    case unknown

    var label: String {
        switch self {
        case .checking: return "Checking"
        case .enabled: return "Pando is on"
        case .installedNotEnabled: return "Pando is installed but turned off"
        case .notInstalled: return "macOS has not registered Pando yet"
        case .unknown: return "Status unavailable"
        }
    }

    var detail: String {
        switch self {
        case .checking: return "Asking macOS about the file system extension."
        case .enabled: return "`pando` can mount worktrees as folders. You can close this window."
        case .installedNotEnabled: return "Turn it on in System Settings to mount worktrees as folders."
        case .notInstalled: return "Keep Pando in your Applications folder, open it once, then check again."
        case .unknown: return "Open System Settings to check the switch."
        }
    }
}

/// Asks `pluginkit` about registered FSKit modules. The host app is not
/// sandboxed, so it can run it; any failure reads as `.unknown`.
enum ExtensionProbe {
    /// The bundle id of the extension this app carries, read from the
    /// embedded .appex so it follows the prefix set in project.yml.
    static var extensionBundleID: String? {
        let dir = Bundle.main.bundleURL.appendingPathComponent("Contents/Extensions")
        let appexes = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil)) ?? []
        return appexes.lazy
            .filter { $0.pathExtension == "appex" }
            .compactMap { Bundle(url: $0)?.bundleIdentifier }
            .first
    }

    static func current() -> ExtensionStatus {
        guard let bundleID = extensionBundleID else { return .unknown }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/pluginkit")
        proc.arguments = ["-m", "-v", "-p", "com.apple.fskit.fsmodule"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do {
            try proc.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            guard let out = String(data: data, encoding: .utf8) else { return .unknown }
            for raw in out.split(separator: "\n") {
                let line = raw.trimmingCharacters(in: .whitespaces)
                // Match the id as a whole word: "<id>(<version>)".
                guard line.contains(bundleID + "(") else { continue }
                // pluginkit puts a status flag first: "+" enabled, "-" disabled.
                return line.hasPrefix("+") ? .enabled : .installedNotEnabled
            }
            return .notInstalled
        } catch {
            return .unknown
        }
    }
}

// MARK: - Window

struct ContentView: View {
    @State private var status: ExtensionStatus

    init(status: ExtensionStatus = .checking) {
        _status = State(initialValue: status)
    }

    var body: some View {
        ZStack {
            Theme.soil.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 22) {
                header
                statusCard
                switchCard
                Spacer(minLength: 0)
                footer
            }
            .padding(28)
        }
        .onAppear(perform: refresh)
        // Check again when the window comes back to the front, for example
        // after the person turns the switch on in System Settings.
        .onReceive(NotificationCenter.default.publisher(
            for: NSApplication.didBecomeActiveNotification)) { _ in refresh() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image("Lockup")
                .resizable()
                .interpolation(.high)
                .frame(width: 170, height: 42)
                .accessibilityLabel("Pando")
            Text("Mounts Pando worktrees as folders on this Mac.")
                .font(Theme.text(13))
                .foregroundStyle(Theme.barkSoft)
        }
    }

    private var statusCard: some View {
        HStack(alignment: .top, spacing: 14) {
            StatusDot(status: status)
                .padding(.top, 4)
            VStack(alignment: .leading, spacing: 4) {
                Text(status.label)
                    .font(Theme.text(14, .semibold))
                    .foregroundStyle(Theme.bark)
                Text(.init(status.detail))
                    .font(Theme.text(12))
                    .foregroundStyle(Theme.barkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button(action: refresh) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.barkSoft)
            }
            .buttonStyle(.plain)
            .help("Check again")
            .accessibilityLabel("Check again")
        }
        .card()
    }

    private var switchCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("One switch, once per Mac")
                .font(Theme.text(11, .semibold))
                .foregroundStyle(Theme.ash)
                .textCase(.uppercase)
                .kerning(1.2)

            Step(number: 1, text: "Keep **Pando** in your Applications folder.")
            Step(number: 2, text: "Open **Login Items & Extensions**, then **File System Extensions**.")
            Step(number: 3, text: "Turn on **Pando**.")

            Text("That is the only switch. No restart, and no security setting is lowered.")
                .font(Theme.text(12))
                .foregroundStyle(Theme.barkSoft)
                .fixedSize(horizontal: false, vertical: true)

            Button(action: openSettings) {
                Text("Open Login Items & Extensions")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
            .padding(.top, 2)
        }
        .card(padding: 18)
    }

    private var footer: some View {
        HStack(spacing: 6) {
            Text("Built on FSKit. No kernel extension.")
            Spacer()
            Text("v\(appVersion)")
        }
        .font(Theme.text(11))
        .foregroundStyle(Theme.ash)
    }

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
            as? String ?? "0.1.0"
    }

    private func refresh() {
        status = .checking
        DispatchQueue.global(qos: .userInitiated).async {
            let result = ExtensionProbe.current()
            DispatchQueue.main.async {
                withAnimation(.easeOut(duration: 0.2)) { status = result }
            }
        }
    }

    private func openSettings() {
        if let url = URL(string:
            "x-apple.systempreferences:com.apple.LoginItems-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }
}

// MARK: - Pieces

private extension View {
    /// A Loam surface with a quiet hairline.
    func card(padding: CGFloat = 16) -> some View {
        self
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.loam, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Theme.line, lineWidth: 1))
    }
}

/// On reads as a solid dot, "installed but off" as a ring, anything else as a
/// dim dot. The label beside it carries the exact state.
private struct StatusDot: View {
    let status: ExtensionStatus
    var body: some View {
        Group {
            switch status {
            case .enabled:
                Circle().fill(Theme.bark)
            case .installedNotEnabled:
                Circle().strokeBorder(Theme.bark, lineWidth: 1.5)
            case .notInstalled, .unknown, .checking:
                Circle().fill(Theme.ash)
            }
        }
        .frame(width: 10, height: 10)
        .accessibilityHidden(true)
    }
}

private struct Step: View {
    let number: Int
    let text: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(Theme.text(11, .bold))
                .foregroundStyle(Theme.bark)
                .frame(width: 22, height: 22)
                .overlay(Circle().strokeBorder(Theme.line, lineWidth: 1))
            Text(.init(text))
                .font(Theme.text(13))
                .padding(.top, 3)
                .foregroundStyle(Theme.bark)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The brand's primary button: Moon Bark fill, Night Soil label.
private struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.text(13, .semibold))
            .foregroundStyle(Theme.soil)
            .padding(.vertical, 10)
            .background(Theme.bark, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}
