import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import QtQuick.Effects
import "."

// What the agent just did, after it has stopped doing it.
//
// Deliberately unlike the approval overlay in every way that matters: no
// scrim, no keyboard grab, no modality, no focus. The run is already over, so
// this is a report -- and a report that steals your focus is a bug.
Item {
  id: root

  // { actions, approvals, problems, seconds, lines: [{text, tone}] }
  property var recap: null

  signal openLog()
  signal dismissed()
  signal hovered(bool hovering)

  readonly property bool active: recap !== null
  readonly property bool troubled: recap && recap.problems > 0

  PanelWindow {
    visible: root.active
    anchors { top: true; right: true }
    // exclusionMode is Ignore because a toast must not reserve screen space,
    // so clearing the bar is a manual offset rather than something the
    // compositor works out.
    margins {
      top: Style.bar.sizeHorizontal + Style.gapsOut * 2
      right: Style.gapsOut * 2
    }
    implicitWidth: Style.space(430)
    implicitHeight: card.implicitHeight
    color: "transparent"
    WlrLayershell.namespace: "omarchy-desktop-agent-recap"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore

    Item {
      id: card
      width: parent.width
      implicitHeight: col.implicitHeight + Style.spacing.popupPadding * 2

      opacity: root.active ? 1 : 0
      Behavior on opacity { NumberAnimation { duration: Theme.normal; easing.type: Easing.OutCubic } }

      MultiEffect {
        anchors.fill: plate
        source: plate
        shadowEnabled: true
        shadowColor: Util.alpha(root.troubled ? Theme.danger : Theme.ok, 0.35)
        shadowBlur: 0.9
        shadowScale: 1.02
      }

      Rectangle {
        id: plate
        anchors.fill: parent
        radius: Style.cornerRadius
        color: Theme.cardBackground
      }

      HudScanlines { anchors.fill: parent; color: Theme.cardText }
      HudFrame {
        anchors.fill: parent
        color: root.troubled ? Theme.danger : Theme.ok
      }

      // Hovering means you are still reading it, so the dismiss countdown
      // pauses rather than yanking the card out from under your eyes.
      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        acceptedButtons: Qt.NoButton
        onEntered: root.hovered(true)
        onExited: root.hovered(false)
      }

      Column {
        id: col
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: Style.spacing.popupPadding
        spacing: Style.spacing.lg

        Row {
          width: parent.width
          spacing: Style.spacing.xl

          Text {
              // Agent-derived strings reach these. Qt's AutoText renders anything
              // that looks like markup AS markup, so a window title or a URL could
              // colour itself into the background or draw text that reads like a
              // different message. Pinned everywhere rather than per-element: the
              // last round fixed one file and left the same data loose in eleven.
              textFormat: Text.PlainText
            anchors.verticalCenter: parent.verticalCenter
            text: root.troubled ? "󰀪" : "󰄬"
            color: root.troubled ? Theme.danger : Theme.ok
            font.family: Style.font.family
            font.pixelSize: Style.font.iconLarge
          }

          Column {
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.spacing.xxs

            HudLabel { text: "run complete"; tone: Theme.cardText }

            Text {
                // Agent-derived strings reach these. Qt's AutoText renders anything
                // that looks like markup AS markup, so a window title or a URL could
                // colour itself into the background or draw text that reads like a
                // different message. Pinned everywhere rather than per-element: the
                // last round fixed one file and left the same data loose in eleven.
                textFormat: Text.PlainText
              text: "Desktop Agent finished"
              color: Theme.cardText
              font.family: Style.font.family
              font.pixelSize: Style.font.body
              font.bold: true
            }

            Text {
                // Agent-derived strings reach these. Qt's AutoText renders anything
                // that looks like markup AS markup, so a window title or a URL could
                // colour itself into the background or draw text that reads like a
                // different message. Pinned everywhere rather than per-element: the
                // last round fixed one file and left the same data loose in eleven.
                textFormat: Text.PlainText
              text: {
                if (!root.recap) return ""
                var bits = [root.recap.actions + (root.recap.actions === 1 ? " action" : " actions"),
                            root.recap.seconds + "s"]
                if (root.recap.approvals > 0) bits.push(root.recap.approvals + " approved by you")
                if (root.recap.problems > 0) bits.push(root.recap.problems + " refused or failed")
                return bits.join("  ·  ")
              }
              color: Theme.cardTextSecondary
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }
        }

        HudRail { width: parent.width; color: root.troubled ? Theme.danger : Theme.ok }

        Column {
          width: parent.width
          spacing: Style.spacing.xs

          Repeater {
            model: root.recap ? root.recap.lines : []
            Text {
                // Agent-derived strings reach these. Qt's AutoText renders anything
                // that looks like markup AS markup, so a window title or a URL could
                // colour itself into the background or draw text that reads like a
                // different message. Pinned everywhere rather than per-element: the
                // last round fixed one file and left the same data loose in eleven.
                textFormat: Text.PlainText
              width: col.width
              text: (modelData.tone === "bad" ? "✕  " : modelData.tone === "warn" ? "!  " : "·  ") + modelData.text
              color: modelData.tone === "bad" ? Theme.danger
                : modelData.tone === "warn" ? Theme.caution
                : Theme.cardTextSecondary
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              wrapMode: Text.Wrap
            }
          }
        }

        Row {
          anchors.right: parent.right
          spacing: Style.spacing.controlGap

          Button {
            text: "Full log"
            foreground: Theme.cardText
            accent: Theme.ok
            bordered: true
            fontSize: Style.font.caption
            onClicked: root.openLog()
          }

          Button {
            text: "Dismiss"
            foreground: Theme.cardTextSecondary
            accent: Theme.ok
            fontSize: Style.font.caption
            onClicked: root.dismissed()
          }
        }
      }
    }
  }
}
