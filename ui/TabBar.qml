import QtQuick
import qs.Commons
import "."

// Which section you are looking at, and how to get to another one.
//
// The first version was four words in caption-sized uppercase at 38% opacity,
// separated by an underline a pixel and a half tall, with a hit area exactly
// as wide as the text. It read as a subtitle rather than a control: you could
// not tell it was clickable, could not tell which one was active without
// looking closely, and had to aim.
//
// A tab is a button. It gets a button's size, a button's target, and a state
// you can see from across the room.
Item {
  id: root

  property var tabs: []
  property int current: 0
  signal picked(int index)

  implicitHeight: row.implicitHeight

  Row {
    id: row
    anchors.left: parent.left
    anchors.right: parent.right
    spacing: Style.spacing.xs

    Repeater {
      model: root.tabs

      Item {
        // Equal shares of the width, so the targets are large and the row
        // cannot reflow as labels change length.
        width: (root.width - Style.spacing.xs * (root.tabs.length - 1)) / root.tabs.length
        height: label.implicitHeight + Style.spacing.lg * 2

        readonly property bool active: index === root.current

        Rectangle {
          anchors.fill: parent
          radius: Style.cornerRadius
          // Filled when active, faintly lit on hover, invisible otherwise --
          // three states you can distinguish without reading anything.
          color: parent.active ? Util.alpha(Color.accent, 0.16)
            : hover.hovered ? Util.alpha(Color.foreground, 0.07)
            : "transparent"
          border.width: parent.active ? Style.spacing.hairline : 0
          border.color: Util.alpha(Color.accent, 0.45)
          Behavior on color { ColorAnimation { duration: 120 } }
        }

        Text {
            // Agent-derived strings reach these. Qt's AutoText renders anything
            // that looks like markup AS markup, so a window title or a URL could
            // colour itself into the background or draw text that reads like a
            // different message. Pinned everywhere rather than per-element: the
            // last round fixed one file and left the same data loose in eleven.
            textFormat: Text.PlainText
          id: label
          anchors.centerIn: parent
          text: modelData
          // Body size, not caption. This is navigation, and it was competing
          // with the section headings underneath it.
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          font.bold: parent.active
          color: parent.active ? Color.accent
            : hover.hovered ? Color.foreground
            : Util.alpha(Color.foreground, 0.62)
          Behavior on color { ColorAnimation { duration: 120 } }
        }

        HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }

        MouseArea {
          anchors.fill: parent
          onClicked: root.picked(index)
        }
      }
    }
  }
}
