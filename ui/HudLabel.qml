import QtQuick
import qs.Commons

// The small uppercase caption that makes a surface read as an instrument
// rather than a form. Letter-spacing is the whole trick; without it the same
// words look like a field label.
Text {
    // Agent-derived strings reach these. Qt's AutoText renders anything
    // that looks like markup AS markup, so a window title or a URL could
    // colour itself into the background or draw text that reads like a
    // different message. Pinned everywhere rather than per-element: the
    // last round fixed one file and left the same data loose in eleven.
    textFormat: Text.PlainText
  property color tone: Color.foreground
  color: Util.alpha(tone, 0.45)
  font.family: Style.font.family
  font.pixelSize: Style.font.caption
  font.bold: true
  font.letterSpacing: 1.6
  font.capitalization: Font.AllUppercase
}
