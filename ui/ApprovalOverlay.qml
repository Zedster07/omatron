import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "."

// The approval prompt.
//
// Built on the shell's polkit surface, so a theme that styles the system
// password dialog styles this too. The instrument look -- corner brackets, a
// countdown ring, a glow behind the accent -- is drawn entirely from theme
// tokens; there is not one colour literal in this file, which is what lets it
// survive a theme swap mid-prompt.
//
// The countdown is a ring rather than a bar because the auto-deny is the one
// thing here that must never be missed: a prompt that expires in silence
// teaches people the mechanism is unreliable.
Item {
  id: root

  property var request: null
  property int queueDepth: 0
  property int timeoutSec: 120
  property int remainingSec: 0

  signal answered(string verdict)

  readonly property bool active: request !== null
  readonly property bool destructive: request && String(request.severity || "") === "destructive"
  // "Always" means "stop asking about this scope". An AI plan is written fresh
  // for one sentence and will never recur verbatim, so the button would only
  // ever be a way to lower the guard on future, different plans.
  readonly property bool oneOff: request && String(request.tool || "").indexOf("AI suggests") === 0
  readonly property string principal: request ? String(request.principal || "agent") : ""

  readonly property color tone: destructive ? Theme.danger : Theme.authAccent
  readonly property color edge: destructive ? Theme.authBorderError : Theme.authBorder

  readonly property real fraction: timeoutSec > 0 ? Math.max(0, Math.min(1, remainingSec / timeoutSec)) : 0
  readonly property bool urgentClock: fraction > 0 && fraction < 0.25

  function answer(verdict) { if (root.active) root.answered(verdict) }

  onActiveChanged: {
    if (active) { root.remainingSec = root.timeoutSec; reveal.restart() }
    else reveal.stop()
  }

  // Drives the staggered entrance. One clock for the whole card keeps the
  // pieces in lockstep instead of each animating on its own schedule.
  property real revealT: 0
  NumberAnimation {
    id: reveal
    target: root; property: "revealT"
    from: 0; to: 1; duration: 460; easing.type: Easing.OutCubic
  }
  function stagger(at, span) {
    return Math.max(0, Math.min(1, (root.revealT - at) / span))
  }

  Timer {
    interval: 1000; repeat: true; running: root.active
    onTriggered: if (root.remainingSec > 0) root.remainingSec--
  }

  PanelWindow {
    id: window
    visible: root.active
    // Full screen, like the text prompt. This is a security decision with the
    // keyboard grabbed: dimming and blurring everything else is how a modal
    // says "answer me before you carry on", and a card-sized blur reads as a
    // smudge rather than as depth.
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omarchy-desktop-agent-approval"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: Theme.authScrim
      opacity: root.revealT
    }

    Item {
      id: cardWrap
      // Measured against the screen, not the parent: the parent is this card's
      // own window now, which would be circular.
      width: Math.min(Style.space(600), parent.width - Style.gapsOut * 2)
      // Room for the footer, and never taller than the screen. body's height is
      // no longer the whole story -- it scrolls now, and the buttons below it
      // are what must always fit.
      height: Math.min(body.implicitHeight + footer.implicitHeight + Style.spacing.panelPadding * 3,
                       parent.height - Style.gapsOut * 2)
      anchors.centerIn: parent
      opacity: root.revealT
      transform: Translate { y: (1 - root.revealT) * Style.space(14) }

      // Bloom behind the card. Subtle: it should register as depth, not as a
      // light source. Tinted with the state colour so a destructive prompt
      // carries its warning even in peripheral vision.
      MultiEffect {
        anchors.fill: plate
        source: plate
        shadowEnabled: true
        shadowColor: Util.alpha(root.tone, root.destructive ? 0.85 : 0.6)
        shadowBlur: 1.0
        shadowScale: 1.04
        shadowVerticalOffset: 0
        shadowHorizontalOffset: 0
        opacity: 0.9
      }

      Rectangle {
        id: plate
        anchors.fill: parent
        radius: Style.cornerRadius
        color: Theme.authBackground
      }

      HudScanlines {
        anchors.fill: parent
        color: Theme.authText
        opacity: root.stagger(0.1, 0.5)
      }

      // A lit edge along the top. Reads as the surface being powered rather
      // than drawn, and gives the eye somewhere to land before the title.
      HudRail {
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.margins: Style.space(1)
        color: root.tone
        thickness: Math.max(2, Style.space(2))
        sweep: root.active
        sweepDuration: root.destructive ? 1500 : 3000
        opacity: root.stagger(0.05, 0.35)
      }

      HudFrame {
        anchors.fill: parent
        color: root.edge
        progress: root.stagger(0.0, 0.55)
      }

      // Everything above the buttons scrolls.
      //
      // `target` is a window title or a command line and `reasons` is a list;
      // neither has a bound. Without a scroll container the card simply grew,
      // and what fell off the end was the row you answer with.
      Flickable {
        id: scrollArea
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: footer.top
        contentHeight: body.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

      Column {
        id: body
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: Style.spacing.panelPadding
        spacing: Style.spacing.xl

        // ---- header: ring, title, principal
        Row {
          width: parent.width
          spacing: Style.spacing.xxl
          opacity: root.stagger(0.15, 0.4)

          HudRing {
            id: dial
            anchors.verticalCenter: parent.verticalCenter
            implicitWidth: Style.space(84)
            implicitHeight: Style.space(84)
            ticks: 40
            value: root.fraction
            color: root.urgentClock ? Theme.danger : root.tone
            label: root.remainingSec > 0 ? String(root.remainingSec) : ""
            sublabel: "sec"
            fontFamily: Style.font.family
          }

          Column {
            anchors.verticalCenter: parent.verticalCenter
            width: parent.width - dial.implicitWidth - Style.spacing.xxl
            spacing: Style.spacing.xs

            HudLabel {
              text: root.principal === "voice" ? "voice request" : "agent request"
              tone: Theme.authText
            }

            Text {
              width: parent.width
              text: root.destructive ? "This cannot be undone" : "Permission needed"
              color: root.destructive ? Theme.authTextError : Theme.authText
              font.family: Style.font.family
              font.pixelSize: Style.font.heading
              font.bold: true
              elide: Text.ElideRight
            }

            Text {
              width: parent.width
              text: root.principal === "voice"
                ? "Asked for by something you said"
                : "Asked for by " + root.principal
              color: Theme.authTextSecondary
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }
        }

        HudRail {
          width: parent.width
          color: root.tone
          sweep: root.active && !root.destructive
          opacity: root.stagger(0.25, 0.35)
        }

        // ---- what is being asked for
        Column {
          width: parent.width
          spacing: Style.spacing.sm
          opacity: root.stagger(0.3, 0.4)

          Text {
            width: parent.width
            // The tool name is ours, but the rule is per-element and an exception invites
            // the next one.
            // Qt defaults Text.textFormat to AutoText, which renders anything that
            // looks like markup AS markup -- so a crafted title could colour an
            // argument into the background, or draw text that reads like a different
            // decision than the one being asked about. This is the card someone
            // approves from; it must show the string, not perform it.
            textFormat: Text.PlainText
            text: root.request ? String(root.request.tool || "") : ""
            color: Theme.authText
            font.family: Style.font.family
            font.pixelSize: Style.font.subtitle
            font.bold: true
            wrapMode: Text.Wrap
          }

          Text {
            width: parent.width
            // This is d.subject: a window class, a window TITLE, a command line. A page
            // sets its own title, so this string is chosen by the thing being judged.
            // Qt defaults Text.textFormat to AutoText, which renders anything that
            // looks like markup AS markup -- so a crafted title could colour an
            // argument into the background, or draw text that reads like a different
            // decision than the one being asked about. This is the card someone
            // approves from; it must show the string, not perform it.
            textFormat: Text.PlainText
            text: root.request ? String(root.request.target || "") : ""
            color: root.tone
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.Wrap
            visible: text !== ""
          }
        }

        // ---- why, as a readout
        Column {
          width: parent.width
          spacing: Style.spacing.xs
          visible: root.request && root.request.reasons && root.request.reasons.length > 0
          opacity: root.stagger(0.4, 0.4)

          HudLabel { text: "why you are being asked"; tone: Theme.authText }

          Repeater {
            model: root.request && root.request.reasons ? root.request.reasons : []
            Row {
              width: body.width
              spacing: Style.spacing.md

              Rectangle {
                width: Style.space(3); height: Style.space(3)
                radius: width / 2
                color: root.tone
                anchors.verticalCenter: parent.verticalCenter
                opacity: 0.7
              }

              Text {
                width: body.width - Style.space(3) - Style.spacing.md
                // The reason lines, which quote the same untrusted subject back.
                // Qt defaults Text.textFormat to AutoText, which renders anything that
                // looks like markup AS markup -- so a crafted title could colour an
                // argument into the background, or draw text that reads like a different
                // decision than the one being asked about. This is the card someone
                // approves from; it must show the string, not perform it.
                textFormat: Text.PlainText
                text: modelData
                color: Theme.authTextSecondary
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                wrapMode: Text.Wrap
              }
            }
          }
        }

        Text {
          width: parent.width
          visible: root.queueDepth > 1
          text: "+" + (root.queueDepth - 1) + " more waiting"
          color: root.tone
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          opacity: root.stagger(0.45, 0.3)
        }

        }
      }

      // ---- actions, pinned
      //
      // Outside the scrolling region on purpose. These used to be the last
      // children of `body`, which is anchored to the top and has no scroll
      // container -- so a long enough `target` or `reasons` list pushed them
      // past the bottom of the card and off the screen. The window holds an
      // exclusive keyboard grab while it is up, so that left someone facing a
      // prompt with no visible way to answer it, and Enter -- the natural
      // reflex for a stuck dialog -- means allow.
      //
      // The card can now be as tall as it likes; the answer is always on it.
      Column {
        id: footer
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: Style.spacing.panelPadding
        spacing: Style.spacing.xl

          // ---- actions
          Row {
            anchors.right: parent.right
            spacing: Style.spacing.controlGap
            opacity: root.stagger(0.5, 0.4)

            Button {
              text: root.urgentClock ? "Deny  " + root.remainingSec + "s" : "Deny  Esc"
              foreground: Theme.danger
              accent: Theme.danger
              bordered: true
              focusable: true
              fontSize: Style.font.bodySmall
              tooltipText: "Refuse this once. Silence does the same thing."
              onClicked: root.answer("deny")
            }

            Button {
              text: "Allow once  ⏎"
              foreground: root.tone
              accent: root.tone
              bordered: true
              focusable: true
              fontSize: Style.font.bodySmall
              onClicked: root.answer("allow")
            }

            // Quietest of the three on purpose: "Always" is what people reach
            // for to make a prompt stop, so it should take the most intent.
            Button {
              text: "Always  A"
              visible: !root.destructive && !root.oneOff
              foreground: Theme.authTextSecondary
              accent: root.tone
              focusable: true
              fontSize: Style.font.bodySmall
              tooltipText: "Allow this scope until the agent's server restarts."
              onClicked: root.answer("always")
            }
          }

          Text {
            width: parent.width
            text: root.destructive
              ? "Destructive actions are never auto-approved, lease or no lease."
              : root.oneOff
                ? "Written for this sentence alone, so there is nothing to always-allow."
                : "\"Always\" lasts until the server restarts. Edit the policy to make it permanent."
            color: Theme.authTextTertiary
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.Wrap
            opacity: root.stagger(0.55, 0.3)
          }
      }
    }

    Item {
      anchors.fill: parent
      focus: window.visible
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape) { root.answer("deny"); event.accepted = true }
        else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) { root.answer("allow"); event.accepted = true }
        else if (event.key === Qt.Key_A && !root.destructive && !root.oneOff) { root.answer("always"); event.accepted = true }
      }
    }
  }
}
