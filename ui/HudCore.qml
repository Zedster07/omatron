import QtQuick
import QtQuick.Shapes
import qs.Commons

// The thing that listens to you.
//
// Radial, not rectangular, because that is the whole difference between a
// dialog and a machine that is paying attention. Nothing here is a box: it is
// concentric rings, graduations, and arcs turning at different rates around a
// core that reacts to your voice.
//
// Built to be cheap to animate. The rings are drawn ONCE by Shape and then
// spun with `rotation` on their wrapper Items, which is a GPU transform -- an
// animated `sweepAngle` would re-tessellate the path every frame instead, and
// this thing is on screen for the whole time somebody is speaking.
Item {
  id: root

  property color tone: Color.accent
  /** 0..1 audio levels, newest last. Drives the radial bars. */
  property var levels: []
  property bool live: false           // listening: bars and fast spin
  property bool working: false        // transcribing: spin, no bars
  property string glyph: ""
  property string fontFamily: Style.font.family

  implicitWidth: Style.space(150)
  implicitHeight: Style.space(150)

  readonly property real cx: width / 2
  readonly property real cy: height / 2
  readonly property real rOuter: Math.min(width, height) / 2 - Style.space(2)
  readonly property real rTicks: rOuter - Style.space(8)
  readonly property real rWave: rTicks - Style.space(6)
  readonly property real rCore: Math.max(Style.space(20), rOuter * 0.28)
  readonly property real rInnerWave: rCore + Style.space(9)

  // ------------------------------------------------------------- backdrop
  //
  // A soft radial darkening, opaque at the core and gone by the rim. Without
  // it the waveform draws straight over whatever is behind, and on a page of
  // text the two interleave into noise. This is deliberately NOT a full-screen
  // scrim: you are talking about what is on your screen, so covering it up
  // would be perverse -- only the few hundred pixels the HUD occupies dim.
  Shape {
    anchors.fill: parent
    antialiasing: true
    preferredRendererType: Shape.CurveRenderer
    ShapePath {
      strokeColor: "transparent"
      fillGradient: RadialGradient {
        centerX: root.cx; centerY: root.cy; centerRadius: root.rOuter * 1.15
        focalX: root.cx; focalY: root.cy
        GradientStop { position: 0.0; color: Util.alpha(Color.background, 0.45) }
        GradientStop { position: 0.6; color: Util.alpha(Color.background, 0.28) }
        GradientStop { position: 1.0; color: Util.alpha(Color.background, 0.0) }
      }
      PathAngleArc {
        centerX: root.cx; centerY: root.cy
        radiusX: root.rOuter * 1.15; radiusY: root.rOuter * 1.15
        startAngle: 0; sweepAngle: 360
      }
    }
  }

  // ---------------------------------------------------------------- ticks
  //
  // A graduated dial reads as an instrument even when it is not moving. 60
  // marks, every fifth one longer, which is the convention a wristwatch uses
  // and the eye already knows how to parse.
  Item {
    anchors.fill: parent
    Repeater {
      model: 60
      Item {
        anchors.fill: parent
        rotation: index * 6
        Rectangle {
          readonly property bool major: index % 5 === 0
          anchors.horizontalCenter: parent.horizontalCenter
          y: root.cy - root.rTicks
          width: major ? Math.max(1, Style.space(1.5)) : 1
          height: major ? Style.space(7) : Style.space(4)
          radius: width / 2
          color: Util.alpha(root.tone, major ? 0.42 : 0.20)
        }
      }
    }
  }

  // ------------------------------------------------------------ outer ring
  Shape {
    anchors.fill: parent
    antialiasing: true
    preferredRendererType: Shape.CurveRenderer
    ShapePath {
      strokeColor: Util.alpha(root.tone, 0.30)
      strokeWidth: 1
      fillColor: "transparent"
      PathAngleArc {
        centerX: root.cx; centerY: root.cy
        radiusX: root.rOuter; radiusY: root.rOuter
        startAngle: 0; sweepAngle: 360
      }
    }
  }

  // ------------------------------------------------- rotating arc assembly
  //
  // Two broken rings turning opposite ways. Opposition is what stops it
  // reading as a loading spinner: a spinner goes one way and means "wait",
  // counter-rotation means "running".
  Item {
    id: outerArcs
    anchors.fill: parent
    RotationAnimator on rotation {
      running: root.live || root.working
      loops: Animation.Infinite
      from: 0; to: 360
      duration: root.working ? 3200 : 9000
    }
    Shape {
      anchors.fill: parent
      antialiasing: true
      preferredRendererType: Shape.CurveRenderer
      ShapePath {
        strokeColor: root.tone
        strokeWidth: Math.max(1.5, Style.space(2))
        fillColor: "transparent"
        capStyle: ShapePath.RoundCap
        PathAngleArc {
          centerX: root.cx; centerY: root.cy
          radiusX: root.rOuter; radiusY: root.rOuter
          startAngle: -100; sweepAngle: 62
        }
      }
      ShapePath {
        strokeColor: root.tone
        strokeWidth: Math.max(1.5, Style.space(2))
        fillColor: "transparent"
        capStyle: ShapePath.RoundCap
        PathAngleArc {
          centerX: root.cx; centerY: root.cy
          radiusX: root.rOuter; radiusY: root.rOuter
          startAngle: 42; sweepAngle: 34
        }
      }
    }
  }

  Item {
    id: innerArcs
    anchors.fill: parent
    RotationAnimator on rotation {
      running: root.live || root.working
      loops: Animation.Infinite
      from: 360; to: 0
      duration: root.working ? 2100 : 6000
    }
    Shape {
      anchors.fill: parent
      antialiasing: true
      preferredRendererType: Shape.CurveRenderer
      ShapePath {
        strokeColor: Util.alpha(root.tone, 0.65)
        strokeWidth: Math.max(1, Style.space(1.5))
        fillColor: "transparent"
        capStyle: ShapePath.RoundCap
        PathAngleArc {
          centerX: root.cx; centerY: root.cy
          radiusX: root.rCore + Style.space(7); radiusY: root.rCore + Style.space(7)
          startAngle: 140; sweepAngle: 120
        }
      }
      ShapePath {
        strokeColor: Util.alpha(root.tone, 0.65)
        strokeWidth: Math.max(1, Style.space(1.5))
        fillColor: "transparent"
        capStyle: ShapePath.RoundCap
        PathAngleArc {
          centerX: root.cx; centerY: root.cy
          radiusX: root.rCore + Style.space(7); radiusY: root.rCore + Style.space(7)
          startAngle: -40; sweepAngle: 70
        }
      }
    }
  }

  // ------------------------------------------------------ radial waveform
  //
  // Your voice, radiating outward. Newest sample at twelve o'clock and
  // sweeping clockwise, so the ring fills in the direction a clock does.
  Item {
    anchors.fill: parent
    visible: root.live
    Repeater {
      model: 72
      Item {
        anchors.fill: parent
        rotation: index * 5
        readonly property real level: {
          var l = root.levels
          if (!l || l.length === 0) return 0
          var i = l.length - 72 + index
          return i >= 0 && i < l.length ? Math.max(0, Math.min(1, l[i])) : 0
        }
        // Anchored at the core and growing OUTWARD: the bottom edge stays
        // pinned just outside the core while the top travels toward the rim,
        // so loud speech reads as energy leaving the centre rather than as a
        // ring closing in on it.
        Rectangle {
          readonly property real span: root.rWave - root.rInnerWave - Style.space(3)
          anchors.horizontalCenter: parent.horizontalCenter
          width: Math.max(1, Style.space(1.8))
          height: Style.space(3) + parent.level * span
          y: root.cy - root.rInnerWave - height
          radius: width / 2
          color: Util.alpha(root.tone, 0.35 + parent.level * 0.65)
          Behavior on height { NumberAnimation { duration: 90 } }
        }
      }
    }
  }

  // ------------------------------------------------------------------ core
  Rectangle {
    anchors.centerIn: parent
    width: root.rCore * 2
    height: width
    radius: width / 2
    color: Util.alpha(root.tone, 0.10)
    border.width: Math.max(1, Style.space(1.5))
    border.color: Util.alpha(root.tone, 0.55)

    // Breathing, not blinking. A slow scale says "attending"; a blink says
    // "error", and the two must never be confusable here.
    SequentialAnimation on scale {
      running: root.live
      loops: Animation.Infinite
      NumberAnimation { from: 0.94; to: 1.06; duration: 1000; easing.type: Easing.InOutQuad }
      NumberAnimation { from: 1.06; to: 0.94; duration: 1000; easing.type: Easing.InOutQuad }
    }
  }

  Text {
      // Agent-derived strings reach these. Qt's AutoText renders anything
      // that looks like markup AS markup, so a window title or a URL could
      // colour itself into the background or draw text that reads like a
      // different message. Pinned everywhere rather than per-element: the
      // last round fixed one file and left the same data loose in eleven.
      textFormat: Text.PlainText
    anchors.centerIn: parent
    text: root.glyph
    color: root.tone
    font.family: root.fontFamily
    font.pixelSize: Math.max(Style.font.icon, root.rCore * 0.9)
  }
}
