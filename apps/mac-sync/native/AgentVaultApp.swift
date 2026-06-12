import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var serverProcess: Process?
    private var outputBuffer = ""
    private var didLoadServer = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMenu()
        createWindow()
        launchDesktopServer()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopDesktopServer()
    }

    func windowWillClose(_ notification: Notification) {
        stopDesktopServer()
    }

    private func installMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "Quit Agent Vault", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)
        NSApp.mainMenu = mainMenu
    }

    private func createWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsAirPlayForMediaPlayback = false

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsMagnification = false
        webView.setValue(false, forKey: "drawsBackground")
        webView.loadHTMLString(loadingHtml("Starting Agent Vault"), baseURL: nil)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1160, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Agent Vault"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(red: 0.075, green: 0.078, blue: 0.09, alpha: 1.0)
        window.minSize = NSSize(width: 920, height: 620)
        window.contentView = webView
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("AgentVaultMainWindow")
        window.makeKeyAndOrderFront(nil)

        self.window = window
        self.webView = webView
    }

    private func syncBinaryPath() -> String? {
        let environment = ProcessInfo.processInfo.environment
        if let explicit = environment["AGENT_VAULT_SYNC_BIN"], FileManager.default.isExecutableFile(atPath: explicit) {
            return explicit
        }

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.agent-vault/bin/agent-vault-sync",
            "\(home)/.agent-vault/client/agent-vault/bin/agent-vault-sync"
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private func launchDesktopServer() {
        guard let syncBinary = syncBinaryPath() else {
            showError("Agent Vault sync client is not installed.")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: syncBinary)
        process.arguments = ["serve-ui", "--port", "0"]

        let output = Pipe()
        let errorOutput = Pipe()
        process.standardOutput = output
        process.standardError = errorOutput

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                self?.handleServerOutput(chunk)
            }
        }

        errorOutput.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                if self?.didLoadServer == false {
                    self?.showError(chunk.trimmingCharacters(in: .whitespacesAndNewlines))
                }
            }
        }

        process.terminationHandler = { [weak self] child in
            DispatchQueue.main.async {
                guard self?.serverProcess === child else { return }
                self?.serverProcess = nil
                if self?.didLoadServer == false {
                    self?.showError("Agent Vault desktop server stopped before the window could load.")
                }
            }
        }

        do {
            try process.run()
            serverProcess = process
        } catch {
            showError("Could not start Agent Vault: \(error.localizedDescription)")
        }
    }

    private func handleServerOutput(_ chunk: String) {
        outputBuffer.append(chunk)
        let marker = "Agent Vault desktop UI: "
        guard let range = outputBuffer.range(of: marker) else { return }
        let remainder = outputBuffer[range.upperBound...]
        guard let urlText = remainder.split(whereSeparator: \.isNewline).first,
              let url = URL(string: String(urlText)) else {
            return
        }

        didLoadServer = true
        webView?.load(URLRequest(url: url))
    }

    private func stopDesktopServer() {
        guard let process = serverProcess else { return }
        serverProcess = nil
        process.terminate()
    }

    private func showError(_ message: String) {
        webView?.loadHTMLString(loadingHtml(message.isEmpty ? "Agent Vault could not start." : message), baseURL: nil)
    }

    private func loadingHtml(_ message: String) -> String {
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        return """
        <!doctype html>
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif; background: #17181d; color: #f3f4f7; }
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: linear-gradient(135deg, #15161a, #1a1b20 58%, #101114); }
              main { width: min(420px, calc(100vw - 72px)); text-align: left; padding: 0; background: transparent; }
              h1 { margin: 0 0 14px; font-size: 30px; line-height: 1.05; letter-spacing: 0; }
              p { margin: 0; color: rgba(243,244,247,.62); line-height: 1.45; overflow-wrap: anywhere; }
            </style>
          </head>
          <body><main><h1>Agent Vault</h1><p>\(escaped)</p></main></body>
        </html>
        """
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
