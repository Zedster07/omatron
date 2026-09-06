// Desktop Agent control panel — status readout and the plugin's config UI.
//
// State is read off the service object the shell injects; settings come from
// `desktop-agent-config`, which owns ~/.config/desktop-agent/settings.json.
// The panel never parses or writes that file itself: one writer, and it is a
// tool that can be run and tested from a terminal.
//
// The remote API key is the exception to "the panel edits everything". It is
// written straight through to voxtype's config at 0600 and never read back --
// the panel only ever learns whether one is set. A settings screen that can
// redisplay a secret is a secret that ends up in a screenshot.

import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "ui"

Panel {
    id: root
    moduleName: "io.github.zedster07.desktop-agent"
    ipcTarget: "io.github.zedster07.desktop-agent.panel"
    manageIpc: false

    property var anchorItem: null
    property var hostWidget: null
    property var service: null
    readonly property var barIdentity: hostWidget || root

    readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family

    // ---- live state, from the service object when there is one and over the
    //      plugin's own IPC when there is not.
    //
    // There usually is not. The shell injects `service` only into panels IT
    // loads (shell.qml: `if ("service" in item) item.service = ...`), and this
    // panel is loaded by our own BarWidget as a flyout, which injects `bar`,
    // `settings`, `anchorItem` and `hostWidget` -- and no service. So the panel
    // people actually click had service === null, every reading showed its
    // fallback (VOICE offline while the daemon was up, "policy active" while
    // full access was running) and every button was a silent no-op behind
    // `if (root.service)`. A guard that hides a missing dependency instead of
    // reporting it turns a wiring bug into a UI that simply does nothing.
    //
    // The IPC surface is the same one the service exposes to everyone else, so
    // this is not a second implementation -- just a different way of reaching
    // the same functions.
    property var ipcState: ({})
    readonly property bool viaIpc: service === null

    readonly property bool policyEnabled: service ? service.policyEnabled : (ipcState.enabled !== undefined ? ipcState.enabled : true)
    readonly property bool policyReadable: service ? service.policyReadable : (ipcState.policyReadable !== undefined ? ipcState.policyReadable : true)
    readonly property int pendingCount: service ? service.pendingCount : (ipcState.pendingCount || 0)
    readonly property bool yoloActive: service ? service.yoloActive : (ipcState.yolo === true)
    readonly property string yoloClock: {
        if (service)
            return service.yoloClock;
        var s = Number(ipcState.yoloRemaining || 0);
        if (s <= 0)
            return "0:00";
        return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
    }
    readonly property bool voiceAvailable: service ? service.voiceAvailable : (ipcState.voice === true)
    readonly property string voicePhase: service ? service.voiceState : String(ipcState.voiceState || "idle")
    readonly property bool listening: voicePhase === "listening"

    // ---- the IPC bridge, used only when no service was injected
    readonly property var ipcBase: ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call", "io.github.zedster07.desktop-agent"]

    function ipcCall(fn, arg) {
        var cmd = root.ipcBase.concat([fn]);
        if (arg !== undefined && arg !== null)
            cmd.push(String(arg));
        ipcActionProc.command = cmd;
        ipcActionProc.running = true;
    }

    function pollState() {
        if (!root.viaIpc)
            return;
        ipcStateProc.command = root.ipcBase.concat(["status"]);
        ipcStateProc.running = true;
    }

    Process {
        id: ipcStateProc
        stdout: SplitParser {
            onRead: function (line) {
                try {
                    root.ipcState = JSON.parse(String(line));
                } catch (e) {}
            }
        }
    }
    Process {
        id: ipcActionProc
        onExited: root.pollState()
    }

    // Does the POLICY allow a lease at all?
    //
    // The panel could grant one regardless, count down "full access · 50:00
    // left", and every action would still stop for approval, because the server
    // checks policy.yolo.enabled before honouring the file the panel writes.
    // Offering a switch that the thing it controls has been told to ignore is
    // worse than not offering it.
    // ---- scheduled jobs
    //
    // Listed here because the CLI cannot be the only way to see them. A schedule
    // is a thing that acts on your machine while you are not looking, and one
    // you can only find by remembering a command is one you will not find.
    property var jobs: []
    Process {
        id: jobsProc
        command: ["desktop-agent", "jobs-json"]
        stdout: SplitParser {
            onRead: function (line) {
                try {
                    root.jobs = JSON.parse(String(line));
                } catch (e) {}
            }
        }
    }
    Process {
        id: jobCancelProc
        onExited: jobsProc.running = true
    }

    // The policy's own two switches, read from the file rather than assumed.
    //
    // The panel used to show its kill-switch FLAG and call that "policy
    // active" while the policy's master setting said otherwise -- so a fresh
    // install, whose shipped default is off, read "armed" with every gated
    // action refusing. Two off switches, only one of them visible from here.
    property bool yoloAllowed: true
    property bool policyMaster: true

    // Models the selected provider can actually reach.
    //
    // Re-asked whenever the provider changes, because the answer is different
    // per machine and per provider -- ollama lists what you pulled, opencode
    // fans out over every API key it has. A fixed list would be wrong for both.
    property var models: []
    property string modelsFor: ""
    Process {
        id: modelsProc
        stdout: SplitParser {
            onRead: function (line) {
                var t = String(line).trim();
                if (t !== "")
                    root.models = root.models.concat([t]);
            }
        }
    }
    function loadModels(provider) {
        if (root.modelsFor === provider && root.models.length)
            return;
        root.modelsFor = provider;
        root.models = [];
        modelsProc.running = false;
        modelsProc.command = ["desktop-agent-config", "models", provider];
        modelsProc.running = true;
    }
    // Per provider, so switching away and back restores the choice instead of
    // silently handing gemini a model named "sonnet".
    function modelFor(provider) {
        var v = root.s("ai.model." + provider, "");
        if (v === "" && provider === "claude")
            v = root.s("ai.claudeModel", "");   // what this setting used to be called
        return v === "" ? "default" : v;
    }

    // The capability table. Read as JSON in one go rather than a process per
    // row: twelve capabilities is twelve subprocesses on every panel open.
    property var caps: ({})
    Process {
        id: capsProc
        command: ["desktop-agent-config", "policy-caps"]
        stdout: SplitParser {
            onRead: function (line) {
                try {
                    root.caps = JSON.parse(String(line));
                } catch (e) {}
            }
        }
    }
    function setCap(name, value) {
        root.queueWrite(["desktop-agent-config", "policy-set-cap", name, value]);
    }

    Process {
        id: policyMasterProc
        command: ["desktop-agent-config", "policy-enabled"]
        stdout: SplitParser {
            onRead: function (line) {
                root.policyMaster = String(line).trim() === "true";
            }
        }
    }

    // One writer, fed by a queue.
    //
    // NOT a Process per call site, and not a shared Process each setter writes
    // into directly: a Quickshell Process runs one command at a time, and
    // assigning `command` while it is still running drops that call with no
    // error anywhere. Two quick clicks in the capability table would have lost
    // the second one -- a settings UI where a click sometimes does nothing.
    property var writeQueue: []

    // Why the last write failed, empty when it did not.
    //
    // A failed write used to be silent. The control snapped back to the file's
    // value on the re-read, so nothing on screen was false -- but a switch that
    // flicks back with no explanation reads as a broken panel, and the actual
    // reasons (an unparseable policy, a lock held by something else) are ones
    // the person can act on once told.
    property string writeError: ""

    Process {
        id: policyWriter
        // The setters print their reason on stdout and exit non-zero, so the
        // last line is the message worth showing.
        stdout: SplitParser {
            onRead: function (line) {
                root.lastWriteLine = String(line).trim();
            }
        }
        stderr: SplitParser {
            onRead: function (line) {
                root.lastWriteLine = String(line).trim();
            }
        }
        onExited: function (exitCode) {
            if (exitCode !== 0)
                root.writeError = root.lastWriteLine !== "" ? root.lastWriteLine : "the setting could not be written (exit " + exitCode + ")";
            root.lastWriteLine = "";

            root.pumpWrites();
            // Re-read only once the burst has drained, and re-read rather than
            // assume: a setter can refuse (unreadable policy, a hand-edit
            // mid-flight), and a control that moves anyway is lying about the
            // file it claims to show.
            if (root.writeQueue.length === 0 && !policyWriter.running) {
                policyMasterProc.running = true;
                yoloAllowedProc.running = true;
                capsProc.running = true;
        root.loadModels(root.s("ai.provider", "auto"));
            }
        }
    }
    property string lastWriteLine: ""

    function queueWrite(argv) {
        root.writeError = "";
        var q = root.writeQueue.slice();
        q.push(argv);
        root.writeQueue = q;
        root.pumpWrites();
    }

    function pumpWrites() {
        if (policyWriter.running || root.writeQueue.length === 0)
            return;
        var q = root.writeQueue.slice();
        var next = q.shift();
        root.writeQueue = q;
        policyWriter.command = next;
        policyWriter.running = true;
    }

    // Writing the policy from the panel is only safe because the agent cannot
    // reach the panel: clicks onto our own surfaces are refused by geometry,
    // and desktop-agent-config is refused by name from a spoken request.
    // Before both of those, this switch had to live in a file the agent had no
    // reason to touch -- protection by inconvenience, paid for by every user.
    function setPolicyFlag(which, on) {
        root.queueWrite(["desktop-agent-config", which === "yolo" ? "policy-set-yolo" : "policy-set-enabled", on ? "true" : "false"]);
    }

    Process {
        id: yoloAllowedProc
        command: ["desktop-agent-config", "policy-yolo"]
        stdout: SplitParser {
            onRead: function (line) {
                root.yoloAllowed = String(line).trim() === "true";
            }
        }
    }

    // While the panel is open the clock has to move, or "full access · 14:59"
    // sits frozen and reads as broken.
    Timer {
        running: root.viaIpc && root.opened
        interval: 1000
        repeat: true
        onTriggered: root.pollState()
    }

    // ---- settings, loaded from desktop-agent-config
    property var cfg: ({})
    property bool cfgLoaded: false
    property string busy: ""

    function s(path, fallback) {
        var node = root.cfg;
        var parts = path.split(".");
        for (var i = 0; i < parts.length; i++) {
            if (!node || typeof node !== "object")
                return fallback;
            node = node[parts[i]];
        }
        return node === undefined || node === null ? fallback : node;
    }

    function setCfg(key, value) {
        root.busy = key;
        // Voice settings push themselves into voxtype straight away. Requiring a
        // separate Apply meant the panel could show "remote / key set" while
        // voxtype was still transcribing locally -- configured-looking and inert,
        // which is worse than an obvious failure.
        root.applyAfterSet = key.indexOf("voice.") === 0;
        setProc.command = ["desktop-agent-config", "set", key, String(value)];
        setProc.running = true;
    }

    property bool applyAfterSet: false

    // ---- local-install gate
    //
    // Choosing "local" does not switch anything by itself. It asks first, with
    // the real number, and only downloads on an explicit yes. The default is
    // remote precisely so nobody pays ~900 MB they did not ask for.
    property var pendingLocal: null       // { venvMb, modelMb, model }
    property string installLine: ""
    property bool installing: false

    function askForLocal(model) {
        costProc.command = ["desktop-agent-config", "local-cost", model];
        costProc.running = true;
    }
    function confirmLocal() {
        if (!pendingLocal)
            return;
        root.installing = true;
        root.installLine = "starting…";
        installProc.command = ["desktop-agent-config", "install-local", String(pendingLocal.model)];
        installProc.running = true;
    }
    function cancelLocal() {
        root.pendingLocal = null;
        root.installLine = "";
    }

    function applyStt() {
        root.busy = "stt";
        applyProc.running = true;
    }

    readonly property color tone: !policyEnabled || !policyReadable ? Theme.danger : yoloActive ? Theme.caution : Theme.ok

    readonly property string glyph: (!policyEnabled || !policyMaster) ? "󰜺" : listening ? "󰍬" : yoloActive ? "󰸋" : "󰂽"

    // Reports the state that actually governs, not the one this panel happens
    // to own. There are two off switches -- the policy's master setting and
    // this panel's kill-switch flag -- and showing only the flag meant a fresh
    // install read "policy active" while every gated action refused.
    readonly property string statusLine: !policyReadable ? "policy unreadable — everything refuses"
      : !policyMaster ? "desktop control off — everything refuses"
      : !policyEnabled ? "kill switch on — every gated action refuses"
      : yoloActive ? (yoloAllowed ? "full access · " + yoloClock + " left" : "full access granted but ignored by policy")
      : listening ? "listening" : "policy active"

    property var settings: ({})
    property int tab: {
        var want = settings && settings.openSection ? String(settings.openSection) : "status";
        var i = ["status", "voice", "ai", "policy"].indexOf(want);
        return i >= 0 ? i : 0;
    }

    function refresh() {
        if (service) {
            service.probe();
            service.readYolo();
        } else
            root.pollState();
        yoloAllowedProc.running = true;
        policyMasterProc.running = true;
        capsProc.running = true;
        jobsProc.running = true;
        if (!cfgProc.running)
            cfgProc.running = true;
    }
    function toggleKillswitch() {
        if (service)
            service.toggleKillswitch();
    }

    function open() {
        setCenterHoverRevealSuppressed(false);
        root.controller.show();
        refresh();
    }
    function openFromHotkey() {
        root.controller.show();
        refresh();
        Qt.callLater(function () {
            if (root.opened)
                setCenterHoverRevealSuppressed(true);
        });
    }
    function close() {
        setCenterHoverRevealSuppressed(false);
        root.controller.hide();
    }
    function toggle() {
        if (root.opened)
            root.close();
        else
            root.openFromHotkey();
    }

    function switchPanel(direction) {
        if (root.bar && typeof root.bar.switchPanelFrom === "function")
            return root.bar.switchPanelFrom(root.barIdentity, direction);
        return false;
    }
    function setCenterHoverRevealSuppressed(value) {
        if (root.bar && "centerHoverRevealSuppressed" in root.bar)
            root.bar.centerHoverRevealSuppressed = value;
    }

    Process {
        id: cfgProc
        command: ["desktop-agent-config", "all"]
        stdout: SplitParser {
            onRead: function (line) {
                try {
                    root.cfg = JSON.parse(String(line));
                    root.cfgLoaded = true;
                } catch (e) {
                    console.warn("desktop-agent: bad settings json: " + e);
                }
            }
        }
    }
    Process {
        id: setProc
        onExited: {
            cfgProc.running = true;
            if (root.applyAfterSet) {
                root.applyAfterSet = false;
                root.applyStt();
            } else
                root.busy = "";
        }
    }
    Process {
        id: applyProc
        command: ["desktop-agent-config", "apply-stt"]
        onExited: {
            root.busy = "";
            cfgProc.running = true;
        }
    }
    Process {
        id: secretProc
        onExited: {
            cfgProc.running = true;
            root.applyStt();
        }
    }
    Process {
        id: openProc
    }

    // Opening a file needs no service -- it is a process, and the panel already
    // runs those. Routing it through the service was the reason "open policy"
    // and "open audit log" died with everything else.
    readonly property string policyFile: (Quickshell.env("HOME") || "~") + "/.config/desktop-agent/policy.jsonc"
    readonly property string auditFile: (Quickshell.env("HOME") || "~") + "/.local/share/desktop-agent/desktop.log"

    function openPath(launcher, path) {
        if (openProc.running)
            return;
        openProc.command = [launcher, path];
        openProc.running = true;
    }
    function openAudit() {
        if (openProc.running)
            return;
        openProc.command = ["omarchy-launch-tui", "--app-id=org.omarchy.desktop-agent-log", "bash", "-c", "touch '" + root.auditFile + "'; tail -n 200 -f '" + root.auditFile + "'"];
        openProc.running = true;
    }

    Process {
        id: costProc
        stdout: SplitParser {
            onRead: function (line) {
                try {
                    var c = JSON.parse(String(line));
                    // Nothing to download means nothing to ask about.
                    if (c.venvMb + c.modelMb === 0)
                        root.setCfg("voice.sttMode", "local");
                    else
                        root.pendingLocal = c;
                } catch (e) {
                    console.warn("desktop-agent: bad cost json");
                }
            }
        }
    }

    Process {
        id: installProc
        stdout: SplitParser {
            onRead: function (line) {
                root.installLine = String(line).trim();
            }
        }
        onExited: function (code) {
            root.installing = false;
            if (root.installLine.indexOf("failed") === 0)
                // leave the reason on screen
                return;
            root.pendingLocal = null;
            root.installLine = "";
            cfgProc.running = true;
        }
    }

    Component.onCompleted: refresh()

    IpcHandler {
        target: root.ipcTarget
        function open(): void {
            root.openFromHotkey();
        }
        function close(): void {
            root.close();
        }
        function show(): void {
            root.openFromHotkey();
        }
        function hide(): void {
            root.close();
        }
        function toggle(): void {
            root.toggle();
        }

        // Open straight to a section. Handy for a keybinding that goes to the
        // voice settings, and it makes the config UI testable without a mouse.
        function section(name: string): void {
            var i = ["status", "voice", "ai", "policy"].indexOf(String(name));
            if (i >= 0)
                root.tab = i;
            root.openFromHotkey();
        }
    }

    KeyboardPanel {
        id: panel
        anchorItem: root.anchorItem
        owner: root.barIdentity
        bar: root.bar
        open: root.opened
        centerOnBar: true
        focusTarget: keyCatcher
        contentWidth: panel.fittedContentWidth(Style.space(460))
        contentHeight: panel.fittedContentHeight(main.implicitHeight)

        PanelKeyCatcher {
            id: keyCatcher
            anchors.fill: parent
            onCloseRequested: root.close()
            onReturnRequested: root.refresh()
            onTabRequested: function (direction) {
                root.switchPanel(direction);
            }

            // Inside the key catcher, which anchors.fill its parent and so has a
            // real size. As a sibling it was a child of the content holder, whose
            // size comes from its children -- so it painted a region, but not the
            // whole card, and the gaps between blocks kept showing the desktop.
            Rectangle {
                anchors.fill: parent
                    radius: Style.cornerRadius
                // Alpha stripped. Color.popups.background is composed WITH an alpha
                // channel, so painting with it inherits whatever transparency the theme
                // gave popups -- and a backdrop that is 90% opaque still lets a bright
                // terminal ghost through. Same hue, no transparency.
                color: Qt.rgba(Theme.cardBackground.r, Theme.cardBackground.g, Theme.cardBackground.b, 1)
            }
            Rectangle {
                anchors.fill: parent
                    radius: Style.cornerRadius
                color: "transparent"
                border.width: Style.spacing.hairline
                border.color: Util.alpha(root.tone, 0.25)
            }

            Flickable {
                id: scroll
                anchors.fill: parent
                contentWidth: width
                contentHeight: main.implicitHeight
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                interactive: contentHeight > height

                Column {
                    id: main
                    width: scroll.width
                    spacing: Style.spacing.xxl

                    // ================================================ status block
                    Item {
                        width: parent.width
                        height: hero.implicitHeight + Style.spacing.xxl * 2

                        MultiEffect {
                            anchors.fill: heroPlate
                            source: heroPlate
                            shadowEnabled: true
                            shadowColor: Util.alpha(root.tone, 0.35)
                            shadowBlur: 0.9
                            shadowScale: 1.02
                        }
                        Rectangle {
                            id: heroPlate
                            anchors.fill: parent
                            radius: Style.cornerRadius
                            color: Util.alpha(root.tone, 0.06)
                        }
                        HudScanlines {
                            anchors.fill: parent
                            color: Color.foreground
                            strength: 0.02
                        }
                        HudFrame {
                            anchors.fill: parent
                            color: root.tone
                            hairlineOpacity: 0.16
                        }

                        Row {
                            id: hero
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.margins: Style.spacing.xxl
                            spacing: Style.spacing.xxl

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: root.glyph
                                color: root.tone
                                font.family: root.fontFamily
                                font.pixelSize: Style.font.displayLarge
                            }

                            Column {
                                anchors.verticalCenter: parent.verticalCenter
                                width: parent.width - Style.space(40) - Style.spacing.xxl
                                spacing: Style.spacing.xs

                                HudLabel {
                                    text: "desktop agent"
                                    tone: Color.foreground
                                }
                                Text {
                                    width: parent.width
                                    text: root.statusLine
                                    color: root.tone
                                    font.family: root.fontFamily
                                    font.pixelSize: Style.font.subtitle
                                    font.bold: true
                                    elide: Text.ElideRight
                                }
                            }
                        }
                    }

                    TabBar {
                        width: parent.width
                        tabs: ["status", "voice", "ai", "policy"]
                        current: root.tab
                        onPicked: function (i) {
                            root.tab = i;
                        }
                    }

                    // ==================================================== STATUS
                    Column {
                        width: parent.width
                        spacing: Style.spacing.xxl
                        visible: root.tab === 0

                        Row {
                            width: parent.width
                            spacing: Style.spacing.controlGap

                            Repeater {
                                model: [
                                    {
                                        k: "voice",
                                        v: root.voiceAvailable ? "ready" : "offline",
                                        ok: root.voiceAvailable
                                    },
                                    {
                                        k: "waiting",
                                        v: String(root.pendingCount),
                                        ok: root.pendingCount === 0
                                    },
                                    {
                                        k: "policy",
                                        v: (root.policyEnabled && root.policyMaster) ? "armed" : "off",
                                        ok: root.policyEnabled && root.policyMaster
                                    },
                                ]
                                Item {
                                    width: (main.width - Style.spacing.controlGap * 2) / 3
                                    height: cell.implicitHeight + Style.spacing.xl * 2
                                    Rectangle {
                                        anchors.fill: parent
                                        radius: Style.cornerRadius
                                        color: Util.alpha(Color.foreground, 0.04)
                                        border.width: 1
                                        border.color: Util.alpha(modelData.ok ? Color.foreground : Theme.danger, 0.16)
                                    }
                                    Column {
                                        id: cell
                                        anchors.centerIn: parent
                                        spacing: Style.spacing.xxs
                                        HudLabel {
                                            text: modelData.k
                                            tone: Color.foreground
                                            anchors.horizontalCenter: parent.horizontalCenter
                                        }
                                        Text {
                                            anchors.horizontalCenter: parent.horizontalCenter
                                            text: modelData.v
                                            color: modelData.ok ? Color.foreground : Theme.danger
                                            font.family: root.fontFamily
                                            font.pixelSize: Style.font.body
                                            font.bold: true
                                        }
                                    }
                                }
                            }
                        }

                        HudRail {
                            width: parent.width
                            color: root.tone
                            sweep: root.listening
                        }

                        Column {
                            width: parent.width
                            spacing: Style.spacing.md

                            HudLabel {
                                text: !root.yoloActive ? "full access" : root.yoloAllowed ? "full access · " + root.yoloClock + " left" : "full access · not honoured"
                                tone: root.yoloActive ? Theme.caution : Color.foreground
                                color: root.yoloActive ? Theme.caution : Util.alpha(Color.foreground, 0.45)
                            }
                            Text {
                                width: parent.width
                                wrapMode: Text.WordWrap
                                text: !root.yoloActive ? "Skip approvals for a while. Never overrides a denial, and never auto-runs rm, dd, chmod, kill, systemctl or a package manager." : root.yoloAllowed ? "Approvals are being granted without asking. Destructive commands and anything denied still stop." : "A lease is running, but nothing is acting on it."
                                color: Util.alpha(Color.foreground, 0.62)
                                font.family: root.fontFamily
                                font.pixelSize: Style.font.caption
                            }
                            Row {
                                visible: !root.yoloActive && root.policyEnabled && root.policyMaster && root.yoloAllowed
                                spacing: Style.spacing.controlGap
                                Repeater {
                                    model: [15, 30, 60]
                                    Button {
                                        text: modelData + " min"
                                        foreground: Theme.caution
                                        accent: Theme.caution
                                        bordered: true
                                        focusable: true
                                        fontSize: Style.font.bodySmall
                                        onClicked: root.service ? root.service.grantYolo(modelData) : root.ipcCall("yolo", modelData)
                                    }
                                }
                            }
                            // Shown whether or not a lease is running, and the running case
                            // is the one that matters: a countdown saying "full access ·
                            // 57:02 left" while every action still stops for approval is the
                            // most misleading thing this panel can display.
                            Text {
                                visible: !root.yoloAllowed && root.policyEnabled && root.policyMaster
                                width: parent.width
                                wrapMode: Text.WordWrap
                                text: root.yoloActive ? "This lease is NOT being honoured — full access is switched off, so every action still asks. Turn on \"Allow full access\" in the Policy tab." : "Switched off. Turn on \"Allow full access\" in the Policy tab to allow it — until then a grant would count down and change nothing."
                                color: Util.alpha(Theme.caution, 0.85)
                                font.family: root.fontFamily
                                font.pixelSize: Style.font.caption
                            }

                            Button {
                                visible: root.yoloActive
                                text: "End full access now"
                                foreground: Theme.ok
                                accent: Theme.ok
                                bordered: true
                                focusable: true
                                fontSize: Style.font.bodySmall
                                onClicked: root.service ? root.service.endYolo() : root.ipcCall("yoloOff")
                            }
                        }

                        // ---- scheduled jobs
                        Column {
                            width: parent.width
                            spacing: Style.spacing.md

                            HudLabel {
                                text: root.jobs.length ? "scheduled · " + root.jobs.length : "scheduled"
                                tone: Color.foreground
                                color: Util.alpha(Color.foreground, 0.45)
                            }

                            Text {
                                visible: root.jobs.length === 0
                                width: parent.width
                                wrapMode: Text.WordWrap
                                text: "Nothing scheduled. Ask for a reminder — \"remind me at 6 to take the bins out\" — or a repeating task."
                                color: Util.alpha(Color.foreground, 0.62)
                                font.family: root.fontFamily
                                font.pixelSize: Style.font.caption
                            }

                            Repeater {
                                model: root.jobs
                                Column {
                                    width: parent.width
                                    spacing: Style.spacing.xxs

                                    // Anchored rather than laid out by arithmetic: the button
                                    // sits on the right edge and the description takes whatever
                                    // is left, so a long reminder elides instead of pushing the
                                    // control off the panel.
                                    Item {
                                        width: parent.width
                                        height: Math.max(jobCancel.implicitHeight, jobKind.implicitHeight)

                                        HudLabel {
                                            id: jobKind
                                            anchors.left: parent.left
                                            anchors.verticalCenter: parent.verticalCenter
                                            // A task can act on the machine; a reminder only speaks.
                                            text: modelData.kind === "task" ? "task" : "reminder"
                                            tone: modelData.kind === "task" ? Theme.caution : Color.foreground
                                            color: modelData.kind === "task" ? Theme.caution : Util.alpha(Color.foreground, 0.45)
                                        }
                                        Text {
                                            anchors.left: jobKind.right
                                            anchors.leftMargin: Style.spacing.md
                                            anchors.right: jobCancel.left
                                            anchors.rightMargin: Style.spacing.md
                                            anchors.verticalCenter: parent.verticalCenter
                                            text: modelData.text
                                            elide: Text.ElideRight
                                            color: Util.alpha(Color.foreground, 0.85)
                                            font.family: root.fontFamily
                                            font.pixelSize: Style.font.caption
                                        }
                                        Button {
                                            id: jobCancel
                                            anchors.right: parent.right
                                            anchors.verticalCenter: parent.verticalCenter
                                            text: "cancel"
                                            bordered: true
                                            focusable: true
                                            foreground: Theme.danger
                                            accent: Theme.danger
                                            fontSize: Style.font.caption
                                            onClicked: {
                                                jobCancelProc.command = ["desktop-agent", "job-cancel", modelData.id];
                                                jobCancelProc.running = true;
                                            }
                                        }
                                    }

                                    Text {
                                        width: parent.width
                                        text: (modelData.recurrent ? "repeats " : "once ") + modelData.when + (modelData.capabilities && modelData.capabilities.length ? "  ·  may " + modelData.capabilities.join(", ") : "")
                                        color: Util.alpha(Color.foreground, 0.5)
                                        font.family: root.fontFamily
                                        font.pixelSize: Style.font.caption
                                    }
                                }
                            }
                        }
                    }

                    // ===================================================== VOICE
                    Column {
                        width: parent.width
                        spacing: Style.spacing.xxl
                        visible: root.tab === 1

                        SettingRow {
                            width: parent.width
                            label: "speech engine"
                            fontFamily: root.fontFamily
                            help: root.s("voice.sttMode", "remote") === "remote" ? "Audio is sent to the endpoint below. Faster and markedly more accurate than anything local on modest hardware — and it leaves the machine." : "Runs entirely on this machine. Nothing leaves it."
                            Dropdown {
                                width: parent.width
                                showLabel: false
                                options: ["remote", "local"]
                                value: root.s("voice.sttMode", "remote")
                                onChanged: function (v) {
                                    if (v === "local")
                                        root.askForLocal(root.s("voice.localModel", "small.en"));
                                    else
                                        root.setCfg("voice.sttMode", v);
                                }
                            }
                        }

                        // ---- download consent
                        Item {
                            width: parent.width
                            visible: root.pendingLocal !== null
                            height: consent.implicitHeight + Style.spacing.xxl * 2

                            Rectangle {
                                anchors.fill: parent
                                radius: Style.cornerRadius
                                color: Util.alpha(Theme.caution, 0.07)
                            }
                            HudFrame {
                                anchors.fill: parent
                                color: Theme.caution
                                armRatio: 0.05
                            }

                            Column {
                                id: consent
                                anchors.left: parent.left
                                anchors.right: parent.right
                                anchors.verticalCenter: parent.verticalCenter
                                anchors.margins: Style.spacing.xxl
                                spacing: Style.spacing.md

                                HudLabel {
                                    text: "local transcription needs a download"
                                    tone: Theme.caution
                                    color: Theme.caution
                                }

                                Text {
                                    width: parent.width
                                    wrapMode: Text.WordWrap
                                    color: Util.alpha(Color.foreground, 0.8)
                                    font.family: root.fontFamily
                                    font.pixelSize: Style.font.bodySmall
                                    text: {
                                        if (!root.pendingLocal)
                                            return "";
                                        var v = root.pendingLocal.venvMb, m = root.pendingLocal.modelMb;
                                        var bits = [];
                                        if (v > 0)
                                            bits.push("speech packages " + v + " MB");
                                        if (m > 0)
                                            bits.push("model " + root.pendingLocal.model + " " + m + " MB");
                                        return bits.join("  ·  ") + "   —   " + (v + m) + " MB total, kept on this machine.";
                                    }
                                }

                                Text {
                                    width: parent.width
                                    wrapMode: Text.WordWrap
                                    visible: root.installLine !== ""
                                    text: root.installLine
                                    color: root.installLine.indexOf("failed") === 0 ? Theme.danger : Theme.ok
                                    font.family: root.fontFamily
                                    font.pixelSize: Style.font.caption
                                }

                                Row {
                                    spacing: Style.spacing.controlGap
                                    visible: !root.installing

                                    Button {
                                        text: "Download and switch"
                                        foreground: Theme.caution
                                        accent: Theme.caution
                                        bordered: true
                                        focusable: true
                                        fontSize: Style.font.bodySmall
                                        onClicked: root.confirmLocal()
                                    }
                                    Button {
                                        text: "Stay on remote"
                                        foreground: Color.foreground
                                        focusable: true
                                        fontSize: Style.font.bodySmall
                                        onClicked: root.cancelLocal()
                                    }
                                }
                            }
                        }

                        SettingRow {
                            width: parent.width
                            visible: root.s("voice.sttMode", "remote") === "local"
                            label: "local model"
                            fontFamily: root.fontFamily
                            help: "Measured on this class of machine: base.en ~1.0s, small.en ~2.0s per utterance. Bigger is more accurate and slower; medium and above are only sensible with a GPU."
                            Dropdown {
                                width: parent.width
                                showLabel: false
                                options: ["tiny.en", "base.en", "small.en", "distil-small.en", "medium.en", "large-v3-turbo"]
                                value: root.s("voice.localModel", "small.en")
                                onChanged: function (v) {
                                    root.setCfg("voice.localModel", v);
                                }
                            }
                        }

                        SettingRow {
                            width: parent.width
                            visible: root.s("voice.sttMode", "remote") === "remote"
                            label: "remote model"
                            fontFamily: root.fontFamily
                            help: "whisper-large-v3-turbo on Groq. Nothing to download, and markedly more accurate than a local model on modest hardware."
                            Dropdown {
                                width: parent.width
                                showLabel: false
                                options: ["whisper-large-v3-turbo", "whisper-large-v3"]
                                value: root.s("voice.remoteModel", "whisper-large-v3-turbo")
                                onChanged: function (v) {
                                    root.setCfg("voice.remoteModel", v);
                                }
                            }
                        }

                        SettingRow {
                            width: parent.width
                            visible: root.s("voice.sttMode", "remote") === "remote"
                            label: root.s("voice.hasRemoteKey", false) ? "api key — set" : "api key — not set"
                            fontFamily: root.fontFamily
                            help: "Stored at ~/.config/desktop-agent/stt.key, mode 0600 from the moment it is created, and never shown again. Free key at console.groq.com."
                            Row {
                                width: parent.width
                                spacing: Style.spacing.controlGap

                                TextField {
                                    id: keyField
                                    width: parent.width - saveKey.width - clearKey.width - Style.spacing.controlGap * 2
                                    password: true
                                    placeholderText: root.s("voice.hasRemoteKey", false) ? "replace key…" : "gsk_…"
                                    font.family: root.fontFamily
                                    font.pixelSize: Style.font.bodySmall
                                    onAccepted: if (text.length > 0) {
                                        root.busy = "key";
                                        secretProc.command = ["desktop-agent-config", "set-secret", text];
                                        secretProc.running = true;
                                        text = "";
                                    }
                                }
                                Button {
                                    id: saveKey
                                    text: "Save"
                                    foreground: Theme.ok
                                    accent: Theme.ok
                                    bordered: true
                                    focusable: true
                                    fontSize: Style.font.bodySmall
                                    onClicked: if (keyField.text.length > 0) {
                                        root.busy = "key";
                                        secretProc.command = ["desktop-agent-config", "set-secret", keyField.text];
                                        secretProc.running = true;
                                        keyField.text = "";
                                    }
                                }
                                Button {
                                    id: clearKey
                                    text: "Clear"
                                    visible: root.s("voice.hasRemoteKey", false)
                                    foreground: Theme.danger
                                    accent: Theme.danger
                                    focusable: true
                                    fontSize: Style.font.bodySmall
                                    onClicked: {
                                        root.busy = "key";
                                        secretProc.command = ["desktop-agent-config", "clear-secret"];
                                        secretProc.running = true;
                                    }
                                }
                            }
                        }

                        Toggle {
                            width: parent.width
                            label: "Vocabulary bias"
                            description: "Prime the decoder with the command words. Turns \"hope chrome\" back into \"open chrome\"."
                            checked: root.s("voice.biasPrompt", true)
                            fontFamily: root.fontFamily
                            onClicked: root.setCfg("voice.biasPrompt", !checked)
                        }

                        HudRail {
                            width: parent.width
                            color: Color.foreground
                        }

                        Row {
                            width: parent.width
                            spacing: Style.spacing.controlGap

                            Button {
                                text: root.busy === "stt" ? "Applying…" : "Re-apply"
                                foreground: Theme.ok
                                accent: Theme.ok
                                bordered: true
                                focusable: true
                                fontSize: Style.font.bodySmall
                                enabled: root.busy === ""
                                onClicked: root.applyStt()
                            }
                            Button {
                                text: "Mic test"
                                foreground: Color.foreground
                                bordered: true
                                focusable: true
                                fontSize: Style.font.bodySmall
                                onClicked: {
                                    openProc.command = ["omarchy-launch-tui", "--app-id=org.omarchy.desktop-agent-mic", "bash", "-c", "desktop-agent-mictest; echo; read -n1 -r -p 'enter to close'"];
                                    openProc.running = true;
                                    root.close();
                                }
                            }
                        }
                    }

                    // ======================================================== AI
                    Column {
                        width: parent.width
                        spacing: Style.spacing.xxl
                        visible: root.tab === 2

                        // The four assistance tiers were one dropdown, and the
                        // three lesser ones only ever described what the plugin
                        // does with less of itself switched on. Nobody picks
                        // "route" on purpose -- they pick it once, forget, and
                        // then wonder why a request that needs the screen came
                        // back as "I cannot do that".
                        Text {
                            width: parent.width
                            wrapMode: Text.WordWrap
                            text: "Registered phrases answer instantly. Anything else goes to an AI that either picks a ready-made command or writes one for your approval — and if it needs to see and click the screen, an agent takes it, under your policy."
                            color: Util.alpha(Color.foreground, 0.62)
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                        }

                        SettingRow {
                            width: parent.width
                            label: "provider"
                            fontFamily: root.fontFamily
                            help: "auto selects an installed CLI agent (Claude, Gemini, Codex, or OpenCode) and falls back to a local Ollama model for planning."
                            Dropdown {
                                width: parent.width
                                showLabel: false
                                options: ["auto", "claude", "opencode", "codex", "gemini", "ollama"]
                                value: root.s("ai.provider", "auto")
                                onChanged: function (v) {
                                    root.setCfg("ai.provider", v);
                                    root.loadModels(v);
                                }
                            }
                        }

                        // Follows the provider, because "claude model" was a
                        // lie on every setting except one: it stayed visible
                        // and stayed claude's list while the provider said
                        // gemini. The options are asked of the provider now --
                        // ollama reports what you have pulled, opencode fans
                        // out over every API key you gave it.
                        SettingRow {
                            width: parent.width
                            visible: root.s("ai.provider", "auto") !== "auto"
                            label: "model"
                            fontFamily: root.fontFamily
                            help: root.s("ai.provider", "auto") === "claude" ? "Measured on this workload: sonnet is about 8% faster than opus and 2.5x cheaper per token, with identical answers on every test case. This call is small — a catalogue in, a line of JSON out — which is not the shape that needs the most capable model." : "\"default\" leaves the choice to the CLI, which is usually right. Kept per provider, so switching back restores what you picked."
                            Dropdown {
                                width: parent.width
                                showLabel: false
                                options: root.models.length ? root.models : ["default"]
                                value: root.modelFor(root.s("ai.provider", "auto"))
                                onChanged: function (v) {
                                    root.setCfg("ai.model." + root.s("ai.provider", "auto"), v === "default" ? "" : v);
                                }
                            }
                        }

                        SettingRow {
                            width: parent.width
                            label: "confirm spoken commands"
                            fontFamily: root.fontFamily
                            help: "Anything an AI decided always asks, whatever this says."
                            Dropdown {
                                width: parent.width
                                showLabel: false
                                options: ["never", "destructive-only", "always"]
                                value: root.s("command.confirm", "destructive-only")
                                onChanged: function (v) {
                                    root.setCfg("command.confirm", v);
                                }
                            }
                        }

                        SettingRow {
                            width: parent.width
                            label: "agent workspace"
                            fontFamily: root.fontFamily
                            help: "Anything the agent opens lands here, placed silently so it never steals your focus. Set 0 to let it open wherever it likes. This is placement, not permission — what it may touch is the policy's business."
                            NumberField {
                                from: 0
                                to: 10
                                stepSize: 1
                                value: root.s("agent.workspace", 10)
                                fontFamily: root.fontFamily
                                onModified: function (v) {
                                    root.setCfg("agent.workspace", v);
                                }
                            }
                        }

                        Toggle {
                            width: parent.width
                            label: "Let other plugins register commands"
                            description: "Each plugin is approved once before its voice commands go live."
                            checked: root.s("command.thirdParty", true)
                            fontFamily: root.fontFamily
                            onClicked: root.setCfg("command.thirdParty", !checked)
                        }
                    }

                    // ==================================================== POLICY
                    Column {
                        width: parent.width
                        spacing: Style.spacing.xxl
                        visible: root.tab === 3

                        // Sits above the controls, not beside the one that failed:
                        // a burst can fail on any of fifteen of them, and the
                        // person needs the reason more than the row number.
                        Rectangle {
                            visible: root.writeError !== ""
                            width: parent.width
                            height: writeErrText.implicitHeight + Style.spacing.xl * 2
                            radius: Style.cornerRadius
                            color: Util.alpha(Theme.danger, 0.12)
                            border.width: 1
                            border.color: Util.alpha(Theme.danger, 0.5)

                            Text {
                                id: writeErrText
                                anchors.left: parent.left
                                anchors.right: parent.right
                                anchors.margins: Style.spacing.xl
                                anchors.verticalCenter: parent.verticalCenter
                                wrapMode: Text.WordWrap
                                text: "Not saved — " + root.writeError
                                color: Theme.danger
                                font.family: root.fontFamily
                                font.pixelSize: Style.font.caption
                            }
                        }

                        // The two switches that used to live only in policy.jsonc.
                        //
                        // They are here now because the reason they were not is
                        // gone: the agent cannot click our own surfaces (refused
                        // by geometry) and cannot run desktop-agent-config from a
                        // spoken request (refused by name). A setting that can
                        // only be changed by hand-editing a commented JSON file
                        // is not protected, it is just hidden -- and the shipped
                        // default was off, so a fresh install refused everything
                        // with no visible way to say yes.
                        Toggle {
                            width: parent.width
                            label: "Desktop control"
                            description: root.policyMaster ? "Gated actions run, subject to the rules below." : "Off. Every gated action refuses, whatever else is set here."
                            checked: root.policyMaster
                            accent: Theme.ok
                            fontFamily: root.fontFamily
                            onClicked: root.setPolicyFlag("master", !root.policyMaster)
                        }

                        Toggle {
                            width: parent.width
                            label: "Allow full access"
                            description: root.yoloAllowed ? "Timed leases from the Status tab are honoured. Denials and destructive commands still stop." : "Off. A lease would count down and change nothing."
                            checked: root.yoloAllowed
                            accent: Theme.caution
                            fontFamily: root.fontFamily
                            onClicked: root.setPolicyFlag("yolo", !root.yoloAllowed)
                        }

                        HudRail {
                            width: parent.width
                            color: Color.foreground
                        }

                        SettingRow {
                            width: parent.width
                            label: "maximum unattended lease"
                            fontFamily: root.fontFamily
                            help: "Hard ceiling, re-checked on every action. A longer lease is truncated, not honoured."
                            NumberField {
                                from: 5
                                to: 240
                                stepSize: 5
                                value: root.s("policy.leaseMaxMinutes", 60)
                                fontFamily: root.fontFamily
                                onModified: function (v) {
                                    root.setCfg("policy.leaseMaxMinutes", v);
                                }
                            }
                        }

                        Toggle {
                            width: parent.width
                            label: "End-of-run recap"
                            description: "After the agent goes quiet, list what it did. Never takes focus."
                            checked: root.s("policy.recap", true)
                            fontFamily: root.fontFamily
                            onClicked: root.setCfg("policy.recap", !checked)
                        }

                        HudRail {
                            width: parent.width
                            color: Color.foreground
                        }

                        // ---- capabilities
                        //
                        // Twelve allow/ask/deny rules that used to be reachable
                        // only by editing a commented JSON file. Ordered by what
                        // the rule lets the agent do, not alphabetically: the four
                        // that only look at the screen sit above the ones that
                        // change it, so the consequential half of the list is not
                        // scattered through the harmless half.
                        Column {
                            width: parent.width
                            spacing: Style.spacing.md

                            HudLabel {
                                text: "what it may do"
                                tone: Color.foreground
                            }

                            Text {
                                width: parent.width
                                wrapMode: Text.WordWrap
                                text: "Checked before anything else, ignoring what the target is. \"Ask\" raises the approval overlay; a full-access lease turns those into silent yes for as long as it runs."
                                color: Util.alpha(Color.foreground, 0.62)
                                font.family: root.fontFamily
                                font.pixelSize: Style.font.caption
                            }

                            Repeater {
                                model: [
                                    {
                                        k: "observe",
                                        d: "List windows, workspaces and the cursor"
                                    },
                                    {
                                        k: "screenshot",
                                        d: "Capture the screen"
                                    },
                                    {
                                        k: "workspace",
                                        d: "Switch and rename workspaces"
                                    },
                                    {
                                        k: "focus",
                                        d: "Move focus between windows"
                                    },
                                    {
                                        k: "manage",
                                        d: "Move, resize, fullscreen, close and kill windows"
                                    },
                                    {
                                        k: "launch",
                                        d: "Start an application"
                                    },
                                    {
                                        k: "type",
                                        d: "Enter text"
                                    },
                                    {
                                        k: "key",
                                        d: "Press keys and shortcuts"
                                    },
                                    {
                                        k: "mouse",
                                        d: "Move the cursor, click, scroll and drag"
                                    },
                                    {
                                        k: "run",
                                        d: "Run a command — each one checked again by name"
                                    },
                                    {
                                        k: "write",
                                        d: "Create and edit files — each path checked again"
                                    },
                                    {
                                        k: "browser",
                                        d: "Its own browser: empty profile, none of your logins"
                                    },
                                    {
                                        k: "secret",
                                        d: "Type a password or code — asks once; full access covers it, a schedule never does"
                                    },
                                ]

                                Item {
                                    id: capRow
                                    // Held on the row, because the inner Repeater's
                                    // own modelData is "allow"/"ask"/"deny" and
                                    // shadows the capability out here.
                                    readonly property string capKey: modelData.k
                                    readonly property string capNow: root.caps[capKey] !== undefined ? String(root.caps[capKey]) : ""

                                    width: parent.width
                                    // The row is as tall as whichever side is taller.
                                    // Binding it to the text alone clipped the buttons
                                    // on the one-line descriptions.
                                    height: Math.max(capText.implicitHeight, capChoice.height) + Style.spacing.sm

                                    Column {
                                        id: capText
                                        anchors.left: parent.left
                                        anchors.right: capChoice.left
                                        anchors.rightMargin: Style.spacing.md
                                        anchors.verticalCenter: parent.verticalCenter
                                        spacing: Style.spacing.xxs

                                        Text {
                                            text: modelData.k
                                            color: Color.foreground
                                            font.family: root.fontFamily
                                            font.pixelSize: Style.font.body
                                            font.bold: true
                                        }
                                        Text {
                                            width: parent.width
                                            text: modelData.d
                                            wrapMode: Text.WordWrap
                                            color: Util.alpha(Color.foreground, 0.55)
                                            font.family: root.fontFamily
                                            font.pixelSize: Style.font.caption
                                        }
                                    }

                                    Row {
                                        id: capChoice
                                        anchors.right: parent.right
                                        anchors.verticalCenter: parent.verticalCenter
                                        spacing: Style.spacing.xxs

                                        Repeater {
                                            model: ["allow", "ask", "deny"]
                                            Button {
                                                readonly property color hue: modelData === "deny" ? Theme.danger : modelData === "ask" ? Theme.caution : Theme.ok
                                                text: modelData
                                                fontSize: Style.font.caption
                                                bordered: true
                                                focusable: true
                                                // Filled when it is the live answer, outlined
                                                // otherwise: three identical outlined buttons
                                                // give no clue which one is in effect.
                                                selected: capRow.capNow === modelData
                                                foreground: hue
                                                accent: hue
                                                onClicked: root.setCap(capRow.capKey, modelData)
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        HudRail {
                            width: parent.width
                            color: Color.foreground
                        }

                        Row {
                            width: parent.width
                            spacing: Style.spacing.controlGap
                            Button {
                                text: "Edit policy"
                                foreground: Color.foreground
                                bordered: true
                                focusable: true
                                fontSize: Style.font.bodySmall
                                onClicked: {
                                    root.openPath("omarchy-launch-editor", root.policyFile);
                                    root.close();
                                }
                            }
                            Button {
                                text: "Audit log"
                                foreground: Color.foreground
                                bordered: true
                                focusable: true
                                fontSize: Style.font.bodySmall
                                onClicked: {
                                    root.openAudit();
                                    root.close();
                                }
                            }
                        }

                        Button {
                            width: parent.width
                            text: root.policyEnabled ? "Disable — emergency kill switch" : "Re-enable policy"
                            foreground: root.policyEnabled ? Theme.danger : Theme.ok
                            accent: root.policyEnabled ? Theme.danger : Theme.ok
                            bordered: true
                            focusable: true
                            fontSize: Style.font.bodySmall
                            onClicked: root.toggleKillswitch()
                        }
                    }
                }
            }
        }
    }
}
