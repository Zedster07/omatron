# A window that shows the model, and only shows it.
#
# The modelling tools run headless: open the .blend, apply, save, exit. That is
# what makes each operation atomic, but it also means the work happens with
# nothing on screen -- and the standing preference in this project is the
# opposite. desktop_run opens a terminal you can watch for exactly this reason.
#
# So: a real Blender, on the agent's workspace, that reloads the file whenever
# it changes on disk. You see the model appear operation by operation.
#
# It is a VIEWER, not an editor, and that is not a limitation to apologise for
# -- it is the only honest arrangement. A GUI holds its own copy of the scene
# in memory; if it saved, it would clobber whatever the agent had written since
# it loaded. Reloading discards local edits, so the window says so.
import bpy
import os
import sys
from bpy.app.handlers import persistent

PATH = sys.argv[sys.argv.index("--") + 1]
POLL = 1.0

_seen = [0.0]


def _mtime():
    try:
        return os.path.getmtime(PATH)
    except OSError:
        return 0.0


def _tick():
    m = _mtime()
    if m and m > _seen[0]:
        _seen[0] = m
        try:
            # revert_mainfile rather than open_mainfile: same effect for a file
            # already open, and it keeps the window's own layout rather than
            # rebuilding it from whatever was saved.
            bpy.ops.wm.revert_mainfile()
        except RuntimeError:
            try:
                bpy.ops.wm.open_mainfile(filepath=PATH)
            except RuntimeError:
                pass
    return POLL


@persistent
def _rearm(_dummy):
    # Loading a file resets Python, which unregisters every timer -- so the
    # watcher would fire exactly once and then sit there looking like it was
    # working. This handler is @persistent so it survives the load and puts the
    # timer back.
    if not bpy.app.timers.is_registered(_tick):
        bpy.app.timers.register(_tick, first_interval=POLL)


def _label():
    """Say what this window is, where someone will read it."""
    try:
        for area in bpy.context.screen.areas:
            if area.type == "VIEW_3D":
                area.spaces[0].overlay.show_text = True
    except Exception:
        pass


_seen[0] = _mtime()
_label()
bpy.app.timers.register(_tick, first_interval=POLL)
if _rearm not in bpy.app.handlers.load_post:
    bpy.app.handlers.load_post.append(_rearm)
print("OMATRON_VIEWER watching " + PATH)
