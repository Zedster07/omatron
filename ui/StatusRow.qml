import QtQuick
import qs.Commons
import "."

// One "label — value" line. Value is coloured by meaning, never by literal.
Row {
  id: root
  property string label: ""
  property string value: ""
  property bool good: true
  property string fontFamily: Style.font.family

  spacing: Style.spacing.lg

  Text {
      // Agent-derived strings reach these. Qt's AutoText renders anything
      // that looks like markup AS markup, so a window title or a URL could
      // colour itself into the background or draw text that reads like a
      // different message. Pinned everywhere rather than per-element: the
      // last round fixed one file and left the same data loose in eleven.
      textFormat: Text.PlainText
    text: root.label
    color: Util.alpha(Color.foreground, 0.72)
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  Text {
      // Agent-derived strings reach these. Qt's AutoText renders anything
      // that looks like markup AS markup, so a window title or a URL could
      // colour itself into the background or draw text that reads like a
      // different message. Pinned everywhere rather than per-element: the
      // last round fixed one file and left the same data loose in eleven.
      textFormat: Text.PlainText
    text: root.value
    color: root.good ? Color.foreground : Theme.danger
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    font.bold: true
  }
}
