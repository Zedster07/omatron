import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "."

// Typing the same requests you would say.
//
// It is one input and nothing else. Two earlier versions accumulated chrome --
// the kit's TextField nested a bordered box inside the card's bordered box,
// and bracket corners drew a frame around a thing that already had an edge.
// Both were decoration competing with the only element that matters. What is
// left is a single field: a caret, the text, and the state.
//
// It takes keyboard focus, which nothing else in this plugin does. Obviously:
// it is asking you to type. Escape has to be handled on the item that HOLDS
// that focus, or the event is consumed there and never reaches a parent.
//
// Every colour is a Theme token. Nothing here knows it is blue on tokyo-night.
Item {
  id: root

  property bool open: false
  property string phase: "idle"        // idle | working | done | error
  property string result: ""

  signal submitted(string text)
  signal dismissed()

  readonly property color tone: phase === "error" ? Theme.danger
    : phase === "done" ? Theme.ok
    : Theme.caution

  readonly property bool busy: phase === "working"

  // No show()/hide() and no writing to `phase` or `result` from in here.
  //
  // The Service BINDS all three of those (open: root.promptOpen, phase:
  // root.promptPhase, ...). Assigning to a bound property destroys the binding
  // permanently, so the first submission would disconnect this bar from the
  // daemon's state for the rest of the session -- it kept whatever it last
  // wrote itself, which was "working", and never showed done, error or idle
  // again even after being closed and reopened. The bar reports upward through
  // signals and displays what it is given; it owns nothing but its own text.
  onOpenChanged: {
    if (open) Qt.callLater(function() { input.forceActiveFocus() })
    else input.text = ""
  }

  PanelWindow {
    id: window
    visible: root.open
    // Full screen on purpose.
    //
    // Sizing this surface to the card made the blur rule frost only the card
    // and its padding, which reads as a smudged rectangle stuck to the screen
    // rather than as depth. A modal that has taken your keyboard should take
    // the whole view with it: the blur covers everything, so the one sharp
    // thing on screen is the thing you are typing into.
    //
    // This is the opposite call to the voice HUD's working state, and
    // deliberately so -- that one must not cover the screen, because watching
    // the agent work IS watching your screen. Here there is nothing to watch.
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omarchy-desktop-agent-prompt"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    // A light dim on top of the blur. Blur alone washes light desktops out
    // without actually separating the card from them.
    Rectangle {
      anchors.fill: parent
      color: Theme.authScrim
      opacity: root.open ? 1 : 0
      Behavior on opacity { NumberAnimation { duration: Theme.normal; easing.type: Easing.OutCubic } }
    }

    // With a full-screen surface there is an "outside" again, so clicking it
    // closes -- the same gesture every other modal on the desktop has.
    MouseArea { anchors.fill: parent; onClicked: root.dismissed() }

    Item {
      id: stage
      anchors.centerIn: parent
      // Off the screen, not off the parent: the parent is now this card, so
      // measuring against it would be circular.
      width: Math.min(Style.space(720), parent.width - Style.gapsOut * 6)
      height: Math.max(input.implicitHeight, caret.implicitHeight) + Style.spacing.huge * 2

      opacity: root.open ? 1 : 0
      scale: root.open ? 1 : 0.97
      Behavior on opacity { NumberAnimation { duration: Theme.fast; easing.type: Easing.OutCubic } }
      Behavior on scale { NumberAnimation { duration: Theme.normal; easing.type: Easing.OutBack } }

      // Offset downward so it reads as the card sitting ON the desktop rather
      // than an even halo painted around it.
      MultiEffect {
        anchors.fill: plate
        source: plate
        shadowEnabled: true
        shadowColor: Util.alpha(root.tone, root.busy ? 0.34 : 0.18)
        shadowBlur: 1.0
        shadowVerticalOffset: Style.space(6)
        shadowScale: 1.0
        Behavior on shadowColor { ColorAnimation { duration: Theme.normal } }
      }

      // The edge is the border, not a frame drawn on top of one. It carries
      // the state: it brightens while working and takes the danger or ok hue
      // when there is something to report.
      Rectangle {
        id: plate
        anchors.fill: parent
        radius: Style.cornerRadius
        color: Util.alpha(Theme.cardBackground, 0.9)
        border.width: Style.spacing.hairline
        border.color: Util.alpha(root.tone, plate.lit)

        property real lit: root.phase === "idle" ? 0.28 : 0.55
        Behavior on lit { NumberAnimation { duration: Theme.normal } }
        SequentialAnimation on lit {
          running: root.busy
          loops: Animation.Infinite
          NumberAnimation { from: 0.28; to: 0.7; duration: 900; easing.type: Easing.InOutQuad }
          NumberAnimation { from: 0.7; to: 0.28; duration: 900; easing.type: Easing.InOutQuad }
        }
      }

      HudScanlines { anchors.fill: parent; color: Theme.cardText; strength: 0.02 }

      // A caret, not a badge. It marks where typing begins, the way a terminal
      // prompt does, and carries the state in its colour.
      Text {
          // Agent-derived strings reach these. Qt's AutoText renders anything
          // that looks like markup AS markup, so a window title or a URL could
          // colour itself into the background or draw text that reads like a
          // different message. Pinned everywhere rather than per-element: the
          // last round fixed one file and left the same data loose in eleven.
          textFormat: Text.PlainText
        id: caret
        anchors.left: parent.left
        anchors.leftMargin: Style.spacing.huge
        anchors.verticalCenter: parent.verticalCenter
        text: root.phase === "error" ? "✕" : root.phase === "done" ? "✓" : "›"
        color: root.tone
        font.family: Style.font.family
        font.pixelSize: Style.font.display
        font.bold: true
        opacity: root.busy ? 0.5 : 1
        SequentialAnimation on opacity {
          running: root.busy
          loops: Animation.Infinite
          NumberAnimation { from: 0.35; to: 1; duration: 620; easing.type: Easing.InOutQuad }
          NumberAnimation { from: 1; to: 0.35; duration: 620; easing.type: Easing.InOutQuad }
        }
      }

      // The hint sits on the same line, at the far end. On its own line under
      // the field it was a second row of content in something that should read
      // as one row; here it is an edge marking, which is what a hint is.
      Row {
        id: hint
        anchors.right: parent.right
        anchors.rightMargin: Style.spacing.huge
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.spacing.md

        HudLabel {
          anchors.verticalCenter: parent.verticalCenter
          visible: root.phase !== "idle"
          text: root.busy ? "working" : root.phase === "error" ? "failed" : "done"
          tone: Theme.cardText
          color: root.tone
        }

        Text {
            // Agent-derived strings reach these. Qt's AutoText renders anything
            // that looks like markup AS markup, so a window title or a URL could
            // colour itself into the background or draw text that reads like a
            // different message. Pinned everywhere rather than per-element: the
            // last round fixed one file and left the same data loose in eleven.
            textFormat: Text.PlainText
          anchors.verticalCenter: parent.verticalCenter
          visible: root.result !== ""
          width: Math.min(implicitWidth, stage.width * 0.4)
          text: root.result
          color: root.phase === "error" ? Theme.danger : Util.alpha(Theme.cardText, 0.66)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        HudLabel {
          anchors.verticalCenter: parent.verticalCenter
          visible: root.phase === "idle"
          text: "enter run   esc close"
          tone: Theme.cardText
          color: Util.alpha(Theme.cardText, 0.22)
        }
      }

      // Raw TextInput rather than the kit's TextField: that one paints its own
      // border and fill, which is the box inside a box. Here the card IS the
      // input, so there is only ever one edge on screen.
      TextInput {
        id: input
        anchors.left: caret.right
        anchors.leftMargin: Style.spacing.xl
        anchors.right: hint.left
        anchors.rightMargin: Style.spacing.xl
        anchors.verticalCenter: parent.verticalCenter
        verticalAlignment: TextInput.AlignVCenter
        enabled: !root.busy
        color: Theme.cardText
        selectionColor: Util.alpha(root.tone, 0.35)
        selectedTextColor: Theme.cardText
        font.family: Style.font.family
        font.pixelSize: Style.font.display
        clip: true

        onAccepted: {
          var t = text.trim()
          if (t.length === 0) return
          // Emit and nothing else. The Service moves the phase to "working"
          // when it dispatches, and owns every transition after that.
          root.submitted(t)
        }

        // Escape belongs on the item that owns focus. A handler on a parent
        // never sees it.
        Keys.onEscapePressed: function(event) { root.dismissed(); event.accepted = true }
      }

      Text {
          // Agent-derived strings reach these. Qt's AutoText renders anything
          // that looks like markup AS markup, so a window title or a URL could
          // colour itself into the background or draw text that reads like a
          // different message. Pinned everywhere rather than per-element: the
          // last round fixed one file and left the same data loose in eleven.
          textFormat: Text.PlainText
        anchors.fill: input
        verticalAlignment: Text.AlignVCenter
        visible: input.text.length === 0 && !root.busy
        text: "what would you like done?"
        color: Util.alpha(Theme.cardText, 0.3)
        font.family: Style.font.family
        font.pixelSize: Style.font.display
        elide: Text.ElideRight
      }
    }

    Item {
      anchors.fill: parent
      focus: root.open && !input.activeFocus
      Keys.onEscapePressed: function(event) { root.dismissed(); event.accepted = true }
    }
  }
}
