import QtQuick
import QtQuick.Shapes
import qs.Commons

// Circular countdown.
//
// Replaces the drain-bar because a ring reads as a gauge at a glance and
// costs less width -- and because a countdown is the one thing on an approval
// prompt that must never be missed. It carries the seconds in the middle so
// the number and the sweep are the same object.
Item {
  id: root

  property real value: 1          // 1 -> full, 0 -> empty
  property color color: Color.accent
  property color trackColor: Util.alpha(Color.foreground, 0.14)
  property real thickness: Math.max(2, Style.space(3))
  property string label: ""
  property string sublabel: ""
  property string fontFamily: Style.font.family
  /** Graduation marks around the dial. 0 disables them. */
  property int ticks: 0

  implicitWidth: Style.space(46)
  implicitHeight: Style.space(46)

  readonly property real _r: Math.min(width, height) / 2 - thickness / 2
  readonly property real _v: Math.max(0, Math.min(1, value))

  // Graduations. A bare arc is a progress bar bent into a circle; the marks
  // are what make it read as a dial being watched.
  Item {
    anchors.fill: parent
    visible: root.ticks > 0
    Repeater {
      model: root.ticks
      Item {
        anchors.fill: parent
        rotation: index * (360 / Math.max(1, root.ticks))
        Rectangle {
          readonly property bool major: index % 5 === 0
          anchors.horizontalCenter: parent.horizontalCenter
          y: root.height / 2 - root._r - Style.space(6)
          width: 1
          height: major ? Style.space(5) : Style.space(2.5)
          color: Util.alpha(root.color, major ? 0.45 : 0.22)
        }
      }
    }
  }

  Shape {
    anchors.fill: parent
    antialiasing: true
    preferredRendererType: Shape.CurveRenderer

    ShapePath {
      strokeColor: root.trackColor
      strokeWidth: root.thickness
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      PathAngleArc {
        centerX: root.width / 2; centerY: root.height / 2
        radiusX: root._r; radiusY: root._r
        startAngle: -90; sweepAngle: 360
      }
    }

    ShapePath {
      strokeColor: root.color
      strokeWidth: root.thickness
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      // Starts at twelve o'clock and unwinds clockwise, which is the
      // direction people read a timer draining.
      PathAngleArc {
        centerX: root.width / 2; centerY: root.height / 2
        radiusX: root._r; radiusY: root._r
        startAngle: -90
        sweepAngle: 360 * root._v
        Behavior on sweepAngle { NumberAnimation { duration: 950; easing.type: Easing.Linear } }
      }
    }
  }

  Column {
    anchors.centerIn: parent
    spacing: 0

    Text {
        // Agent-derived strings reach these. Qt's AutoText renders anything
        // that looks like markup AS markup, so a window title or a URL could
        // colour itself into the background or draw text that reads like a
        // different message. Pinned everywhere rather than per-element: the
        // last round fixed one file and left the same data loose in eleven.
        textFormat: Text.PlainText
      anchors.horizontalCenter: parent.horizontalCenter
      text: root.label
      color: root.color
      font.family: root.fontFamily
      font.pixelSize: root.width > Style.space(70) ? Style.font.heading : Style.font.bodySmall
      font.bold: true
      visible: root.label !== ""
    }

    Text {
        // Agent-derived strings reach these. Qt's AutoText renders anything
        // that looks like markup AS markup, so a window title or a URL could
        // colour itself into the background or draw text that reads like a
        // different message. Pinned everywhere rather than per-element: the
        // last round fixed one file and left the same data loose in eleven.
        textFormat: Text.PlainText
      anchors.horizontalCenter: parent.horizontalCenter
      text: root.sublabel
      color: Util.alpha(root.color, 0.55)
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      font.letterSpacing: 1.2
      font.capitalization: Font.AllUppercase
      visible: root.sublabel !== ""
    }
  }
}
