import QtQuick
import qs.Commons
import "."

// One labelled control in the config panel.
//
// The label sits above the control rather than beside it: the panel is ~430px
// wide, and a side-by-side label eats half of that before the control starts.
// The help line is optional and deliberately quiet -- a form where every field
// shouts is a form nobody reads.
Column {
  id: root
  property string label: ""
  property string help: ""
  property string fontFamily: Style.font.family
  default property alias content: holder.data

  spacing: Style.spacing.xs

  HudLabel { text: root.label; tone: Color.foreground }

  Item {
    id: holder
    width: root.width
    implicitHeight: childrenRect.height
    height: implicitHeight
  }

  Text {
      // Agent-derived strings reach these. Qt's AutoText renders anything
      // that looks like markup AS markup, so a window title or a URL could
      // colour itself into the background or draw text that reads like a
      // different message. Pinned everywhere rather than per-element: the
      // last round fixed one file and left the same data loose in eleven.
      textFormat: Text.PlainText
    visible: root.help !== ""
    width: root.width
    text: root.help
    wrapMode: Text.WordWrap
    color: Util.alpha(Color.foreground, 0.45)
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }
}
