import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "."

// The answer to something that was not a task.
//
// "hello", "what can you do", "thanks" -- talk, and the answer to talk is an
// answer. Until this existed the plugin had nowhere to put one: a spoken
// sentence either matched a command, produced a plan, went to an agent, or came
// back as "nothing matched, so nothing ran", which is a strange reply to
// "hello" and reads as the thing being broken.
//
// It takes keyboard focus, unlike the recap card, because it offers actions and
// an overlay that offers actions you cannot reach is the bug the approval card
// already had. Taking focus means the global F9/F10 binds do not fire while it
// is up, so it handles those keys itself rather than leaving them dead.
Item {
  id: root

  property var reply: null          // { text, said, at }
  // Whether speaking back is even possible. The voice button greys out rather
  // than disappearing: a control that vanishes reads as a bug, one that is
  // visibly unavailable reads as a fact about the machine.
  property bool voiceAvailable: false
  // !! rather than !== null: an unset binding arrives as undefined, and the
  // card showed itself with nothing in it the first time round.
  readonly property bool open: !!reply

  signal dismissed()
  signal followUp()                 // speak the next turn
  signal typed(string text)         // type it instead
  signal save()

  // Reveal, shared with the other surfaces so the plugin moves one way.
  property real revealT: 0
  Behavior on revealT { NumberAnimation { duration: Theme.normal; easing.type: Easing.OutCubic } }
  onOpenChanged: revealT = open ? 1 : 0

  PanelWindow {
    id: window
    visible: root.revealT > 0
    color: "transparent"
    anchors { top: true; left: true; right: true; bottom: true }
    WlrLayershell.namespace: "omarchy-desktop-agent-reply"
    WlrLayershell.layer: WlrLayer.Overlay
    // Exclusive, because Esc / F10 / S are the whole interface. The voice HUD
    // is deliberately focus-free; this is not that -- it is a thing you answer.
    WlrLayershell.keyboardFocus: root.open ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore

    // A scrim, but a light one. This is an answer, not an authorisation: it
    // should read as the desktop pausing to say something rather than as a
    // dialog blocking it.
    Rectangle {
      anchors.fill: parent
      color: Theme.authScrim
      opacity: root.revealT * 0.55
    }

    // Clicking away dismisses. Esc does too, and people reach for both.
    MouseArea {
      anchors.fill: parent
      onClicked: root.dismissed()
    }

    Item {
      id: cardWrap
      // The keys live here because this is an ANCESTOR of the text field.
      // A sibling catcher never sees them: unhandled keys travel up the focused
      // item's parent chain, and the first version put the handler beside the
      // input rather than above it, so Esc did nothing once the field had focus.
      //
      // Enter belongs to the field. Save is Ctrl+S, because a bare S would be
      // swallowed the moment someone typed the word "so".
      Keys.onPressed: function (event) {
        if (event.key === Qt.Key_Escape) {
          root.dismissed();
          event.accepted = true;
        } else if (event.key === Qt.Key_F10) {
          if (root.voiceAvailable)
            root.followUp();
          event.accepted = true;
        } else if (event.key === Qt.Key_S && (event.modifiers & Qt.ControlModifier)) {
          root.save();
          event.accepted = true;
        }
      }

      width: Math.min(Style.space(680), parent.width - Style.gapsOut * 2)
      height: Math.min(body.implicitHeight + Style.spacing.panelPadding * 2 + footer.implicitHeight,
                       parent.height - Style.gapsOut * 2)
      anchors.centerIn: parent
      opacity: root.revealT
      transform: Translate { y: (1 - root.revealT) * Style.space(12) }

      MultiEffect {
        anchors.fill: plate
        source: plate
        shadowEnabled: true
        shadowColor: Util.alpha(Theme.ok, 0.4)
        shadowBlur: 1.0
        shadowVerticalOffset: Style.space(5)
      }

      Rectangle {
        id: plate
        anchors.fill: parent
        radius: Style.cornerRadius
        // Alpha stripped: Color.popups.background carries the theme's own
        // transparency, and text over a see-through plate is what made the
        // panel unreadable.
        color: Qt.rgba(Theme.cardBackground.r, Theme.cardBackground.g, Theme.cardBackground.b, 1)
        border.width: Style.spacing.hairline
        border.color: Util.alpha(Theme.ok, 0.45)
      }

      HudScanlines { anchors.fill: parent; color: Theme.cardText; strength: 0.02 }

      // The answer scrolls; the keys stay reachable. Same lesson as the
      // approval card, applied before it could be reported again.
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
          width: scrollArea.width - Style.spacing.panelPadding * 2
          x: Style.spacing.panelPadding
          y: Style.spacing.panelPadding
          spacing: Style.spacing.xl

          HudLabel {
            text: "answer"
            tone: Theme.ok
            color: Theme.ok
          }

          // What they said, quiet, so the answer has something to hang on.
          Text {
            visible: text !== ""
            width: parent.width
            text: root.reply && root.reply.said ? "you said \"" + root.reply.said + "\"" : ""
            wrapMode: Text.WordWrap
            textFormat: Text.PlainText
            color: Util.alpha(Theme.cardText, 0.45)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.italic: true
          }

          Text {
            width: parent.width
            text: root.reply ? String(root.reply.text || "") : ""
            wrapMode: Text.WordWrap
            // Model output. AutoText would render anything shaped like markup.
            textFormat: Text.PlainText
            color: Theme.cardText
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            lineHeight: 1.35
          }
        }
      }

      Column {
        id: footer
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: Style.spacing.panelPadding
        spacing: Style.spacing.md

        HudRail { width: parent.width; color: Theme.ok }

        // Type the next turn.
        //
        // Voice was the only way to answer, which is wrong for the obvious
        // cases -- a room with other people in it, a name that dictation will
        // not get right, or simply preferring to type. The field takes focus
        // when the card opens, so the natural thing to do is the thing that
        // works.
        Rectangle {
          width: parent.width
          height: Style.spacing.controlHeight + Style.spacing.md * 2
          radius: Style.cornerRadius
          color: Util.alpha(Color.foreground, 0.06)
          border.width: Style.spacing.hairline
          border.color: input.activeFocus ? Util.alpha(Theme.ok, 0.7) : Util.alpha(Color.foreground, 0.18)
          Behavior on border.color { ColorAnimation { duration: Theme.fast } }

          Text {
            id: caret
            anchors.left: parent.left
            anchors.leftMargin: Style.spacing.xl
            anchors.verticalCenter: parent.verticalCenter
            text: "›"
            color: Theme.ok
            font.family: Style.font.family
            font.pixelSize: Style.font.body
          }

          // Raw TextInput for the same reason as the command bar: the kit's
          // TextField paints its own border, and this rectangle is already one.
          TextInput {
            id: input
            anchors.left: caret.right
            anchors.leftMargin: Style.spacing.md
            anchors.right: parent.right
            anchors.rightMargin: Style.spacing.xl
            anchors.verticalCenter: parent.verticalCenter
            color: Theme.cardText
            selectionColor: Util.alpha(Theme.ok, 0.35)
            selectedTextColor: Theme.cardText
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            clip: true
            focus: root.open

            onAccepted: {
              var t = text.trim();
              if (t.length === 0)
                return;
              text = "";
              root.typed(t);
            }

            Text {
              anchors.fill: parent
              visible: input.text === "" && !input.activeFocus
              text: "type a reply, or press F10 to speak"
              verticalAlignment: Text.AlignVCenter
              textFormat: Text.PlainText
              color: Util.alpha(Theme.cardText, 0.35)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }
        }

        Row {
          anchors.right: parent.right
          spacing: Style.spacing.controlGap

          Button {
            text: "Close  Esc"
            foreground: Color.foreground
            bordered: true
            focusable: true
            fontSize: Style.font.bodySmall
            onClicked: root.dismissed()
          }
          Button {
            text: "Save  ^S"
            foreground: Color.foreground
            accent: Theme.ok
            bordered: true
            focusable: true
            fontSize: Style.font.bodySmall
            onClicked: root.save()
          }
          // Greyed rather than hidden when there is no speech path. A missing
          // button is a mystery; a dim one with a tooltip is an answer.
          Button {
            text: "Reply with voice  F10"
            enabled: root.voiceAvailable
            opacity: root.voiceAvailable ? 1 : 0.4
            foreground: root.voiceAvailable ? Theme.ok : Util.alpha(Color.foreground, 0.5)
            accent: Theme.ok
            bordered: true
            focusable: root.voiceAvailable
            fontSize: Style.font.bodySmall
            tooltipText: root.voiceAvailable
              ? "Speak the next turn."
              : "Speech cannot run: either the voice daemon is down, or the transcription mode has no way to work — remote with no API key, or local with no model. Type instead, or check the Voice tab."
            onClicked: if (root.voiceAvailable) root.followUp()
          }
        }
      }
    }

    // The keys. F9/F10 are global binds, and this surface holds an exclusive
    // grab -- so while it is up those binds do not fire and it must answer for
    // them itself, or the machine looks deaf.
  }
}
