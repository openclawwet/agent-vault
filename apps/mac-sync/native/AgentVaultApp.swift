import Cocoa
import WebKit

private struct VaultSummary: Decodable {
    let mainPendingActions: Int
    let shares: [VaultShare]
    let autoSyncEnabled: Bool?
    let server: VaultServer?
    let devices: [VaultDevice]
    let currentDeviceId: String
    let devicesPresenceVisible: Bool?
    let devicesAdminVisible: Bool
    let flowStats: [VaultFlow]
}

private struct VaultShare: Decodable {
    let label: String
    let pendingActions: Int
    let localFileCount: Int
    let localSize: Int
    let remoteFileCount: Int
    let remoteSize: Int
}

private struct VaultDevice: Decodable {
    let id: String
    let name: String
    let scopes: [VaultScope]?
    let status: String?
    let current: Bool?
    let lastSeenAt: String?
}

private struct VaultServer: Decodable {
    let id: String
    let name: String
    let status: String
    let lastSeenAt: String
}

private struct VaultScope: Decodable {
    let space: String?
    let permissions: [String]?
}

private struct VaultFlow: Decodable {
    let label: String
    let events: Int
    let bytes: Int
}

final class DragHandleView: NSView {
    var onLocalFileDrop: (([URL]) -> Void)?
    var onDragState: ((Bool) -> Void)?

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        registerForDraggedTypes([.fileURL])
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, alphaValue > 0.01, bounds.contains(point) else { return nil }

        let trafficAndAddButtonZone = NSRect(x: 0, y: 0, width: 78, height: bounds.height)
        let topActionZone = NSRect(x: max(0, bounds.width - 246), y: 0, width: 246, height: bounds.height)
        if trafficAndAddButtonZone.contains(point) || topActionZone.contains(point) {
            return nil
        }

        return self
    }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        onDragState?(true)
        return .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        return .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        onDragState?(false)
    }

    override func draggingEnded(_ sender: NSDraggingInfo) {
        onDragState?(false)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        onDragState?(false)
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
              !urls.isEmpty else {
            return false
        }
        onLocalFileDrop?(urls)
        return true
    }
}

final class DropWebView: WKWebView {
    var onLocalFileDrop: (([URL]) -> Void)?
    var onDragState: ((Bool) -> Void)?

    override init(frame: NSRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        registerForDraggedTypes([.fileURL])
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        onDragState?(true)
        return .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        onDragState?(false)
    }

    override func draggingEnded(_ sender: NSDraggingInfo) {
        onDragState?(false)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        onDragState?(false)
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
              !urls.isEmpty else {
            return false
        }
        onLocalFileDrop?(urls)
        return true
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var serverProcess: Process?
    private var statusItem: NSStatusItem?
    private var desktopUrl: URL?
    private var summaryTimer: Timer?
    private var latestSummary: VaultSummary?
    private var outputBuffer = ""
    private var didLoadServer = false
    private var lastLaunchError: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMenu()
        installStatusItem()
        createWindow()
        launchDesktopServer()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopDesktopServer()
        summaryTimer?.invalidate()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        webView?.evaluateJavaScript("window.__agentVaultSetPaused && window.__agentVaultSetPaused(true)", completionHandler: nil)
        sender.orderOut(nil)
        NSApp.setActivationPolicy(.accessory)
        return false
    }

    func windowWillClose(_ notification: Notification) {
        webView?.evaluateJavaScript("window.__agentVaultSetPaused && window.__agentVaultSetPaused(true)", completionHandler: nil)
        window?.orderOut(nil)
        NSApp.setActivationPolicy(.accessory)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMainWindow(nil)
        return true
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

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = statusImage(active: false)
        item.button?.imagePosition = .imageOnly
        item.button?.toolTip = "Agent Vault"
        statusItem = item
        rebuildStatusMenu(statusText: "Starting", summary: nil)
    }

    private func createWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsAirPlayForMediaPlayback = false
        configuration.userContentController.add(self, name: "agentVault")

        let webView = DropWebView(frame: .zero, configuration: configuration)
        webView.allowsMagnification = false
        webView.setValue(false, forKey: "drawsBackground")
        webView.onLocalFileDrop = { [weak self] urls in
            self?.handleDroppedUrls(urls)
        }
        webView.onDragState = { [weak self] active in
            self?.setNativeDropActive(active)
        }
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
        window.isOpaque = false
        window.backgroundColor = NSColor.clear
        window.minSize = NSSize(width: 920, height: 620)
        window.hasShadow = true

        let materialView = NSVisualEffectView(frame: window.contentView?.bounds ?? .zero)
        materialView.material = .hudWindow
        materialView.blendingMode = .behindWindow
        materialView.state = .active
        materialView.autoresizingMask = [.width, .height]
        materialView.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false

        let dragHandle = DragHandleView()
        dragHandle.translatesAutoresizingMaskIntoConstraints = false
        dragHandle.wantsLayer = true
        dragHandle.layer?.backgroundColor = NSColor.clear.cgColor
        dragHandle.onLocalFileDrop = { [weak self] urls in
            self?.handleDroppedUrls(urls)
        }
        dragHandle.onDragState = { [weak self] active in
            self?.setNativeDropActive(active)
        }
        materialView.addSubview(dragHandle)

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: materialView.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: materialView.trailingAnchor),
            webView.topAnchor.constraint(equalTo: materialView.topAnchor),
            webView.bottomAnchor.constraint(equalTo: materialView.bottomAnchor),
            dragHandle.leadingAnchor.constraint(equalTo: materialView.leadingAnchor),
            dragHandle.trailingAnchor.constraint(equalTo: materialView.trailingAnchor),
            dragHandle.topAnchor.constraint(equalTo: materialView.topAnchor),
            dragHandle.heightAnchor.constraint(equalToConstant: 64)
        ])

        window.contentView = materialView
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("AgentVaultMainWindow")
        window.makeKeyAndOrderFront(nil)

        self.window = window
        self.webView = webView
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "agentVault",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            return
        }

        if action == "chooseFolder" {
            chooseSharedFolder()
        }
    }

    private func chooseSharedFolder() {
        let panel = NSOpenPanel()
        panel.title = "Choose Folder"
        panel.message = "Choose a folder to share with Agent Vault."
        panel.prompt = "Share"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true

        panel.begin { [weak self] result in
            guard let self else { return }
            if result == .OK, let url = panel.url {
                self.webView?.evaluateJavaScript("window.__agentVaultNativeFolderChosen && window.__agentVaultNativeFolderChosen(\(self.jsString(url.path)))", completionHandler: nil)
            } else {
                self.webView?.evaluateJavaScript("window.__agentVaultNativeFolderCancelled && window.__agentVaultNativeFolderCancelled()", completionHandler: nil)
            }
        }
    }

    private func syncBinaryPath() -> String? {
        let environment = ProcessInfo.processInfo.environment
        if let explicit = environment["AGENT_VAULT_SYNC_BIN"], FileManager.default.isExecutableFile(atPath: explicit) {
            return explicit
        }

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            Bundle.main.path(forResource: "agent-vault-sync", ofType: nil, inDirectory: "bin"),
            "\(home)/.agent-vault/bin/agent-vault-sync",
            "\(home)/.agent-vault/client/agent-vault/bin/agent-vault-sync"
        ].compactMap { $0 }
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
                let message = chunk.trimmingCharacters(in: .whitespacesAndNewlines)
                if !message.isEmpty {
                    self?.lastLaunchError = message
                }
                if self?.didLoadServer == false {
                    self?.showError(message)
                }
            }
        }

        process.terminationHandler = { [weak self] child in
            DispatchQueue.main.async {
                guard self?.serverProcess === child else { return }
                self?.serverProcess = nil
                if self?.didLoadServer == false {
                    let fallback = "Agent Vault desktop server stopped before the window could load."
                    self?.showError(self?.lastLaunchError ?? fallback)
                }
            }
        }

        do {
            try process.run()
            serverProcess = process
            lastLaunchError = nil
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
        desktopUrl = url
        statusItem?.button?.image = statusImage(active: true)
        rebuildStatusMenu(statusText: "Connected", summary: latestSummary)
        startSummaryPolling()
        webView?.load(URLRequest(url: url))
    }

    private func stopDesktopServer() {
        guard let process = serverProcess else { return }
        serverProcess = nil
        process.terminate()
    }

    private func showError(_ message: String) {
        statusItem?.button?.image = statusImage(active: false)
        rebuildStatusMenu(statusText: "Offline", summary: latestSummary)
        webView?.loadHTMLString(loadingHtml(message.isEmpty ? "Agent Vault could not start." : message), baseURL: nil)
    }

    private func startSummaryPolling() {
        summaryTimer?.invalidate()
        pollSummary()
        summaryTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            self?.pollSummary()
        }
    }

    private func pollSummary() {
        guard let summaryUrl = desktopUrl?.deletingLastPathComponent().appendingPathComponent("api/summary"),
              var components = URLComponents(url: summaryUrl, resolvingAgainstBaseURL: false) else { return }
        components.queryItems = [URLQueryItem(name: "light", value: "1")]
        guard let url = components.url else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard error == nil, let data else {
                    self?.rebuildStatusMenu(statusText: "Offline", summary: self?.latestSummary)
                    return
                }
                do {
                    let summary = try JSONDecoder().decode(VaultSummary.self, from: data)
                    self?.latestSummary = summary
                    self?.statusItem?.button?.image = self?.statusImage(active: true)
                    self?.rebuildStatusMenu(statusText: "Connected", summary: summary)
                } catch {
                    self?.rebuildStatusMenu(statusText: "Connected", summary: self?.latestSummary)
                }
            }
        }.resume()
    }

    private func rebuildStatusMenu(statusText: String, summary: VaultSummary?) {
        let menu = NSMenu()
        let title = NSMenuItem(title: "Agent Vault", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)

        let status = NSMenuItem(title: statusText, action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)

        if let summary {
            let pending = summary.mainPendingActions + summary.shares.reduce(0) { $0 + $1.pendingActions }
            let sourceText = summary.shares.count == 1 ? "1 source" : "\(summary.shares.count) sources"
            let pendingText = pending == 1 ? "1 pending" : "\(pending) pending"
            let overview = NSMenuItem(title: "\(sourceText), \(pendingText)", action: nil, keyEquivalent: "")
            overview.isEnabled = false
            menu.addItem(overview)

            menu.addItem(.separator())
            if let server = summary.server {
                let serverItem = NSMenuItem(title: "\(server.name) - \(server.status)", action: nil, keyEquivalent: "")
                serverItem.isEnabled = false
                menu.addItem(serverItem)
            }

            let devicesTitle = NSMenuItem(title: summary.devicesPresenceVisible == true ? "Devices" : "Current Device", action: nil, keyEquivalent: "")
            devicesTitle.isEnabled = false
            menu.addItem(devicesTitle)

            for device in summary.devices.prefix(5) {
                let current = (device.current == true || device.id == summary.currentDeviceId) ? " current" : ""
                let spaces = device.scopes?.count ?? 0
                let status = device.status ?? "offline"
                let item = NSMenuItem(title: "\(device.name)\(current) - \(status), \(spaces) spaces", action: nil, keyEquivalent: "")
                item.isEnabled = false
                menu.addItem(item)
            }

            if !summary.flowStats.isEmpty {
                menu.addItem(.separator())
                for stat in summary.flowStats.prefix(3) {
                    let item = NSMenuItem(title: "\(stat.label): \(stat.events) events, \(formatBytes(stat.bytes))", action: nil, keyEquivalent: "")
                    item.isEnabled = false
                    menu.addItem(item)
                }
            }
        }

        menu.addItem(.separator())
        let openWindow = NSMenuItem(title: "Open Window", action: #selector(showMainWindow(_:)), keyEquivalent: "")
        openWindow.target = self
        menu.addItem(openWindow)

        let sync = NSMenuItem(title: "Sync Now", action: #selector(syncNow(_:)), keyEquivalent: "")
        sync.target = self
        menu.addItem(sync)

        let autoSyncTitle = summary?.autoSyncEnabled == false ? "Turn Auto-Sync On" : "Turn Auto-Sync Off"
        let autoSync = NSMenuItem(title: autoSyncTitle, action: #selector(toggleAutoSync(_:)), keyEquivalent: "")
        autoSync.target = self
        menu.addItem(autoSync)

        let saveEdits = NSMenuItem(title: "Save Edits", action: #selector(saveEdits(_:)), keyEquivalent: "")
        saveEdits.target = self
        menu.addItem(saveEdits)

        let refresh = NSMenuItem(title: "Refresh Status", action: #selector(refreshStatus(_:)), keyEquivalent: "")
        refresh.target = self
        menu.addItem(refresh)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Agent Vault", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem?.menu = menu
    }

    @objc private func showMainWindow(_ sender: Any?) {
        if window == nil {
            createWindow()
        }
        NSApp.setActivationPolicy(.regular)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let url = desktopUrl {
            webView?.load(URLRequest(url: url))
        }
        webView?.evaluateJavaScript("window.__agentVaultSetPaused && window.__agentVaultSetPaused(false)", completionHandler: nil)
    }

    @objc private func refreshStatus(_ sender: Any?) {
        pollSummary()
    }

    @objc private func syncNow(_ sender: Any?) {
        guard let url = desktopUrl?.deletingLastPathComponent().appendingPathComponent("api/sync") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async {
                self?.pollSummary()
            }
        }.resume()
    }

    @objc private func toggleAutoSync(_ sender: Any?) {
        guard let url = desktopUrl?.deletingLastPathComponent().appendingPathComponent("api/preferences") else { return }
        let next = !(latestSummary?.autoSyncEnabled ?? true)
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload = "{\"autoSyncEnabled\":\(next ? "true" : "false")}"
        let message = next ? "Auto-sync on" : "Auto-sync off"
        request.httpBody = payload.data(using: .utf8)
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async {
                self?.pollSummary()
                self?.webView?.evaluateJavaScript("window.__agentVaultNativeRefresh && window.__agentVaultNativeRefresh('\(message)')", completionHandler: nil)
            }
        }.resume()
    }

    @objc private func saveEdits(_ sender: Any?) {
        guard let url = desktopUrl?.deletingLastPathComponent().appendingPathComponent("api/writeback-edits") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = "{}".data(using: .utf8)
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async {
                self?.pollSummary()
                self?.webView?.evaluateJavaScript("window.__agentVaultNativeRefresh && window.__agentVaultNativeRefresh('Edits saved')", completionHandler: nil)
            }
        }.resume()
    }

    private func setNativeDropActive(_ active: Bool) {
        let state = active ? "true" : "false"
        webView?.evaluateJavaScript("window.__agentVaultNativeDropState && window.__agentVaultNativeDropState(\(state))", completionHandler: nil)
    }

    private func jsString(_ value: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: value, options: [])
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }

    private func handleDroppedUrls(_ urls: [URL]) {
        let paths = urls.map { $0.path }.filter { !$0.isEmpty }
        guard !paths.isEmpty else { return }

        webView?.evaluateJavaScript("window.__agentVaultNativeDropStarted && window.__agentVaultNativeDropStarted(\(paths.count))", completionHandler: nil)
        webView?.evaluateJavaScript("window.__agentVaultCurrentDropTarget ? window.__agentVaultCurrentDropTarget() : null") { [weak self] result, _ in
            self?.postDroppedPaths(paths, target: result as? [String: Any])
        }
    }

    private func postDroppedPaths(_ paths: [String], target: [String: Any]?) {
        guard let baseUrl = desktopUrl?.deletingLastPathComponent().appendingPathComponent("api/ingest-paths") else { return }
        var payload: [String: Any] = ["paths": paths]
        if let target {
            payload["target"] = target
        }

        var request = URLRequest(url: baseUrl)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload, options: [])

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                if let error {
                    self?.webView?.evaluateJavaScript("window.__agentVaultNativeDropFailed && window.__agentVaultNativeDropFailed(\(self?.jsString(error.localizedDescription) ?? "\"Drop failed\""))", completionHandler: nil)
                    return
                }
                let http = response as? HTTPURLResponse
                guard (200...299).contains(http?.statusCode ?? 0) else {
                    var message = "Drop failed"
                    if let data,
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let error = json["error"] as? [String: Any],
                       let errorMessage = error["message"] as? String {
                        message = errorMessage
                    }
                    self?.webView?.evaluateJavaScript("window.__agentVaultNativeDropFailed && window.__agentVaultNativeDropFailed(\(self?.jsString(message) ?? "\"Drop failed\""))", completionHandler: nil)
                    return
                }
                self?.pollSummary()
                if let data, let text = String(data: data, encoding: .utf8) {
                    self?.webView?.evaluateJavaScript("window.__agentVaultNativeDropComplete && window.__agentVaultNativeDropComplete(\(text))", completionHandler: nil)
                } else {
                    self?.webView?.evaluateJavaScript("window.__agentVaultNativeDropComplete && window.__agentVaultNativeDropComplete(null)", completionHandler: nil)
                }
            }
        }.resume()
    }

    private func formatBytes(_ bytes: Int) -> String {
        if bytes <= 0 { return "0 B" }
        let units = ["B", "KB", "MB", "GB", "TB"]
        var value = Double(bytes)
        var index = 0
        while value >= 1024 && index < units.count - 1 {
            value /= 1024
            index += 1
        }
        let decimals = value >= 10 || index == 0 ? 0 : 1
        return String(format: "%.\(decimals)f %@", value, units[index])
    }

    private func statusImage(active: Bool) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size)
        image.lockFocus()

        let color = active
            ? NSColor(calibratedRed: 0.92, green: 0.88, blue: 0.80, alpha: 0.96)
            : NSColor(calibratedRed: 0.92, green: 0.88, blue: 0.80, alpha: 0.46)
        color.setStroke()
        color.withAlphaComponent(active ? 0.18 : 0.08).setFill()

        let body = NSBezierPath(roundedRect: NSRect(x: 3.5, y: 5, width: 11, height: 8.5), xRadius: 2.2, yRadius: 2.2)
        body.lineWidth = 1.4
        body.fill()
        body.stroke()

        let tab = NSBezierPath()
        tab.move(to: NSPoint(x: 4.8, y: 13.1))
        tab.line(to: NSPoint(x: 7.2, y: 15.1))
        tab.line(to: NSPoint(x: 10.1, y: 13.1))
        tab.lineWidth = 1.4
        tab.stroke()

        if active {
            color.setFill()
            NSBezierPath(ovalIn: NSRect(x: 12.1, y: 4.0, width: 3.2, height: 3.2)).fill()
        }

        image.unlockFocus()
        image.isTemplate = false
        return image
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
              :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; background: #111110; color: #eee7db; }
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111110; }
              main { width: min(390px, calc(100vw - 72px)); text-align: left; padding: 0; background: transparent; }
              h1 { margin: 0 0 11px; font-size: 20px; line-height: 1.1; font-weight: 560; letter-spacing: 0; }
              p { margin: 0; color: rgba(238,231,219,.52); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
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
