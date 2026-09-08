# A Blender that stays open and takes instructions -- the session, not the batch.
#
# The batch path (blender_ops.py run headless) opens a file, applies a list,
# saves and exits. That structure forces everything to be decided up front: you
# cannot look part-way and change your mind, so a batch is a bet placed blind,
# and a wrong one costs the whole build.
#
# This is the other shape, and it is the one the browser tools already have.
# Open once, then act and look, act and look, against the thing that is
# actually there. A person modelling does exactly this; the only difference
# here is that the looking can be a measurement as well as a glance.
#
# IT EXECUTES THE SAME OP TABLE. blender_ops is imported, not reimplemented,
# so the interactive path opens no execution surface the batch path did not
# already have. Nothing here evals a string it was handed either.
import bpy
import json
import os
import queue
import socket
import sys
import threading
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blender_ops as ops                                    # noqa: E402

SOCKET_PATH = sys.argv[sys.argv.index("--") + 1]
BLEND_PATH = sys.argv[sys.argv.index("--") + 2]

_work = queue.Queue()


def _execute(req):
    """Run a batch. On the MAIN THREAD -- bpy is not thread-safe, and calling
    it from the socket thread does not raise, it corrupts."""
    ops.MEASURED.clear()
    ops.CHECKPOINTS.clear()
    done, errors = [], []
    for o in req.get("ops", []):
        fn = ops.OPS.get(o.get("op"))
        if fn is None:
            errors.append(f"unknown operation {o.get('op')!r}; "
                          f"known: {', '.join(sorted(ops.OPS))}")
            break
        try:
            done.append(f"{o['op']} -> {fn(o)}")
        except Exception as e:                               # noqa: BLE001
            errors.append(f"{o.get('op')}: {e}")
            break

    # Saved after every successful batch, so the file on disk always matches
    # what is on screen -- and so a crash costs the last operation, not the
    # session. The batch path's read-only rule applies here too.
    readonly = {"measure", "assert", "look", "render_view", "viewport", "view_angle"}
    if not errors and any(o.get("op") not in readonly for o in req.get("ops", [])):
        try:
            bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)
        except RuntimeError as e:
            errors.append(f"could not save: {e}")

    return {"applied": done, "errors": errors, "scene": ops.scene(),
            "measured": ops.MEASURED, "checkpoints": ops.CHECKPOINTS,
            "render": None}


def _pump():
    """Drain one request per tick, on the main thread."""
    try:
        req, reply = _work.get_nowait()
    except queue.Empty:
        return 0.05
    try:
        reply.put(_execute(req))
    except Exception:                                        # noqa: BLE001
        reply.put({"applied": [], "errors": [traceback.format_exc(limit=3)],
                   "scene": [], "measured": [], "checkpoints": [], "render": None})
    return 0.01


def _client(conn):
    f = conn.makefile("rwb")
    try:
        line = f.readline()
        if not line:
            return
        req = json.loads(line.decode())
        reply = queue.Queue()
        _work.put((req, reply))
        resp = reply.get(timeout=float(req.get("timeout", 300)))
        f.write((json.dumps(resp) + "\n").encode())
        f.flush()
    except Exception:                                        # noqa: BLE001
        try:
            f.write((json.dumps({"applied": [], "errors": [traceback.format_exc(limit=2)],
                                 "scene": [], "measured": [], "checkpoints": [],
                                 "render": None}) + "\n").encode())
            f.flush()
        except OSError:
            pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def _serve():
    # A UNIX socket, not a TCP port.
    #
    # It is reachable only through a path in the filesystem, so it carries the
    # owner's permissions -- 0600, this user and no other. A TCP port on
    # localhost is open to every process on the machine and, if anything ever
    # binds it to the wrong interface, to the network as well. That mistake is
    # exactly what the other Blender MCP server shipped.
    try:
        os.unlink(SOCKET_PATH)
    except OSError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCKET_PATH)
    os.chmod(SOCKET_PATH, 0o600)
    srv.listen(4)
    print(f"OMATRON_LIVE listening on {SOCKET_PATH}")
    while True:
        try:
            conn, _ = srv.accept()
        except OSError:
            break
        threading.Thread(target=_client, args=(conn,), daemon=True).start()


threading.Thread(target=_serve, daemon=True).start()
bpy.app.timers.register(_pump, first_interval=0.1, persistent=True)
